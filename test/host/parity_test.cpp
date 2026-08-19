// Host-side (g++) accuracy + parity harness for the belt-length kinematics solver.
//
// This exercises the pure math in src/kinematics.cpp -- no Arduino/ESP32 dependencies
// are involved, so it can be built and run directly with g++ on a dev machine:
//
//   g++ -std=c++17 -O2 -I../../src ../../src/kinematics.cpp parity_test.cpp -o parity_test
//   ./parity_test
//
// It grades two solvers -- the root-finder used by the firmware
// (Kinematics::computeBeltLengths) and the original 0.2-degree grid search
// (Kinematics::computeBeltLengthsGridSearch, preserved in kinematics.cpp for exactly
// this purpose) -- against a high-precision reference solve of the same equations,
// over a grid of pen positions for topDistance values of 1000/2000/3000mm.
//
// All three solvers are warm-started (see Movement::gamma_last_position), so the harness
// walks a boustrophedon (snake) path over the drawable area and evaluates every 1mm along
// it -- matching src/tasks/interpolatingmovementtask.h's INCREMENT, i.e. the actual step
// size at which the firmware calls Movement::getBeltLengths() during a real drawing. A
// coarser synthetic grid with large jumps between sample points is not representative --
// it forces the warm-started solvers to chase a large inclination change in one call,
// which is not how either is used in practice.
//
// --- Why the reference, and not a straight old-vs-new comparison ---
//
// This harness originally gated on "max belt-length difference between old and new must
// be < 0.05mm" and had never passed: old-vs-new tops out at 0.0698mm. That requirement
// was not achievable, because it treated the legacy grid search as ground truth when the
// grid search is the less accurate of the two solvers.
//
// solveTorqueEquilibriumGridSearch scans gamma in fixed 0.2-degree steps and returns the
// first sample where |T_delta| stops decreasing, so its answer is quantised to that grid
// and lands up to a step away from the true root (measured worst case: 0.109 degrees).
// The tangent point orbits the pen at radius sqrt((d_t/2)^2 + d_p^2) = 38.28mm, so a
// gamma error of e radians moves the belt endpoint by up to 38.28*e mm. At 0.109 degrees
// that is 0.073mm -- which is the 0.0698mm "disagreement" the old assertion was measuring.
// It was the legacy solver's own quantisation error, not an error in the root-finder.
//
// Measured against the reference below, over all 208803 sample points:
//
//   root-finder  max 0.000406mm  (mean 0.0000286mm), max gamma error 0.00097 degrees
//   grid search  max 0.069722mm  (mean 0.0227mm),    max gamma error 0.109 degrees
//
// The scale that makes those numbers meaningful is one motor microstep of belt travel:
// circumference / stepsPerRotation = 12.69*pi / 1600 = 0.0249mm (see movement.h). Solver
// error below that is not observable by the machine at all. So the root-finder's worst
// case is 1/61 of a microstep, while the grid search's worst case is 2.8 microsteps --
// real, commandable positional error. The refactor improved accuracy by ~170x.
//
// So the gates here are:
//
//   1. PRIMARY -- root-finder vs reference must be < 0.005mm, i.e. the solver may never
//      contribute as much as a fifth of a microstep. That is the requirement that
//      actually protects positional accuracy, it is ~12x above the observed worst case,
//      and it is 10x tighter than the 0.05mm (2 microsteps) it replaces. It bites: a
//      mutation replacing the secant step with plain bisection pushes the error to
//      0.00508mm and fails this gate.
//   2. PARITY -- root-finder vs grid search must be < 0.08mm. This is a behavioural
//      sanity bound proving the refactor did not change the model, not an accuracy claim.
//      It is set just above the legacy solver's quantisation floor: the principled worst
//      case is a full 0.2-degree step, 38.28 * 0.2 * pi/180 = 0.134mm; observed is
//      0.0698mm. Tightening this below ~0.07mm would be asserting something false about
//      the grid search, not something true about the root-finder.
//
// Scope: the reference shares kinematics.cpp's primitives (getBeltAngles, getBeltForces,
// computeTorqueDelta) -- those *are* the model. It differs only in how it locates the root
// and to what precision. This harness therefore validates solver convergence, not the
// correctness of the model itself; see KinematicModel.md for the latter.

#include "kinematics.h"
#include <cstdio>
#include <cmath>
#include <vector>
#include <algorithm>

namespace {

constexpr double kPi = 3.14159265358979323846;

// Mirrors the compile-time defaults in movement.h.
constexpr double d_t = 76.027;
constexpr double d_p = 4.4866;
constexpr double d_m = 10.0 + d_p;
constexpr double mass_bot = 0.55;
constexpr double g_constant = 9.81;
constexpr double belt_elongation_coefficient = 5e-5;
constexpr double midPulleyToWall = 41.0;

// Mirrors Movement::setTopDistance's coordinate-system setup.
constexpr double safeYFraction = 0.2;
constexpr double safeXFraction = 0.2;

constexpr double gamma_delta_termination_new = 0.01 * kPi / 180.0;
constexpr double gamma_delta_termination_old = 0.25 * kPi / 180.0;
constexpr int solver_max_iterations = 20;

// See the header comment for the derivation of both of these.
constexpr double kAccuracyTolerance = 0.005; // [mm] root-finder vs reference (~1/5 microstep).
constexpr double kParityTolerance = 0.08;    // [mm] root-finder vs legacy grid search.

// Matches INCREMENT in src/tasks/interpolatingmovementtask.h: the firmware calls
// getBeltLengths() roughly every 1mm of travel while interpolating a move.
constexpr double kStepMM = 1.0;
constexpr double kRowSpacingMM = 25.0; // vertical spacing between boustrophedon rows.

// High-precision reference solve. Same model as kinematics.cpp, but the inner root find
// is a bisection run to machine precision and the outer angle/force coupling is iterated
// (under damping, which keeps the fixed point stable) to 1e-13 rad rather than to a
// firmware-grade termination tolerance. The equilibrium is a unique fixed point, so this
// is independent of gamma_init -- checkReferenceIsWarmStartIndependent() below asserts it.
Kinematics::BeltLengthsResult referenceSolve(double frameX, double frameY, double topDistance,
                                             double gamma_init, const Kinematics::PhysicsParams &p) {
    double gamma = gamma_init;
    double phi_L = 0.0, phi_R = 0.0, F_L = 0.0, F_R = 0.0;

    for (int outer = 0; outer < 4000; outer++) {
        Kinematics::getBeltAngles(frameX, frameY, gamma, topDistance, p.d_t, p.d_p, phi_L, phi_R);
        Kinematics::getBeltForces(phi_L, phi_R, p, F_L, F_R);

        double lo = -80.0 * kPi / 180.0, hi = 80.0 * kPi / 180.0;
        double f_lo = Kinematics::computeTorqueDelta(phi_L, phi_R, F_L, F_R, lo, p);
        double f_hi = Kinematics::computeTorqueDelta(phi_L, phi_R, F_L, F_R, hi, p);

        double root;
        if (f_lo * f_hi > 0) {
            root = gamma; // No sign change in range; leave gamma where it is.
        } else {
            for (int i = 0; i < 200 && (hi - lo) > 1e-15; i++) {
                const double mid = 0.5 * (lo + hi);
                const double f_mid = Kinematics::computeTorqueDelta(phi_L, phi_R, F_L, F_R, mid, p);
                if (f_lo * f_mid <= 0) { hi = mid; f_hi = f_mid; }
                else                   { lo = mid; f_lo = f_mid; }
            }
            root = 0.5 * (lo + hi);
        }

        const double next = gamma + 0.5 * (root - gamma);
        const bool converged = fabs(next - gamma) < 1e-13;
        gamma = next;
        if (converged) break;
    }

    double leftX, leftY, rightX, rightY;
    Kinematics::getLeftTangentPoint(frameX, frameY, gamma, p.d_t, p.d_p, leftX, leftY);
    Kinematics::getRightTangentPoint(frameX, frameY, gamma, p.d_t, p.d_p, rightX, rightY);
    Kinematics::getBeltAngles(frameX, frameY, gamma, topDistance, p.d_t, p.d_p, phi_L, phi_R);
    Kinematics::getBeltForces(phi_L, phi_R, p, F_L, F_R);

    const double leftLegFlat = sqrt(leftX * leftX + leftY * leftY);
    const double rightLegFlat = sqrt((topDistance - rightX) * (topDistance - rightX) + rightY * rightY);

    Kinematics::BeltLengthsResult result;
    result.leftLeg = Kinematics::getDilationCorrectedBeltLength(
        sqrt(leftLegFlat * leftLegFlat + p.midPulleyToWall * p.midPulleyToWall),
        F_L, p.belt_elongation_coefficient);
    result.rightLeg = Kinematics::getDilationCorrectedBeltLength(
        sqrt(rightLegFlat * rightLegFlat + p.midPulleyToWall * p.midPulleyToWall),
        F_R, p.belt_elongation_coefficient);
    result.gamma = gamma;
    return result;
}

struct GridResult {
    double maxErrNew = 0.0;    // root-finder vs reference
    double maxErrOld = 0.0;    // grid search vs reference
    double maxParity = 0.0;    // root-finder vs grid search
    double maxGammaErrNew = 0.0; // [deg]
    double maxGammaErrOld = 0.0; // [deg]
    double sumErrNew = 0.0;
    double sumErrOld = 0.0;
    double worstNewX = 0.0, worstNewY = 0.0, worstNewTop = 0.0;
    double worstParityX = 0.0, worstParityY = 0.0, worstParityTop = 0.0;
    long pointCount = 0;
    long overAccuracyTolerance = 0;
};

struct Point {
    double x, y;
};

Kinematics::PhysicsParams makeParams() {
    Kinematics::PhysicsParams params;
    params.d_t = d_t;
    params.d_p = d_p;
    params.d_m = d_m;
    params.mass_bot = mass_bot;
    params.g_constant = g_constant;
    params.belt_elongation_coefficient = belt_elongation_coefficient;
    params.midPulleyToWall = midPulleyToWall;
    return params;
}

void evaluatePoint(double x, double y, double topDistance, double minSafeXOffset, double minSafeY,
                    const Kinematics::PhysicsParams &params,
                    double &gamma_state_new, double &gamma_state_old, GridResult &accum) {
    const double frameX = x + minSafeXOffset;
    const double frameY = y + minSafeY;

    const Kinematics::BeltLengthsResult resultNew = Kinematics::computeBeltLengths(
        frameX, frameY, topDistance, gamma_state_new, params,
        gamma_delta_termination_new, solver_max_iterations);

    const Kinematics::BeltLengthsResult resultOld = Kinematics::computeBeltLengthsGridSearch(
        frameX, frameY, topDistance, gamma_state_old, params,
        gamma_delta_termination_old, solver_max_iterations);

    const Kinematics::BeltLengthsResult resultRef =
        referenceSolve(frameX, frameY, topDistance, gamma_state_new, params);

    gamma_state_new = resultNew.gamma;
    gamma_state_old = resultOld.gamma;

    const double errNew = fmax(fabs(resultNew.leftLeg - resultRef.leftLeg),
                               fabs(resultNew.rightLeg - resultRef.rightLeg));
    const double errOld = fmax(fabs(resultOld.leftLeg - resultRef.leftLeg),
                               fabs(resultOld.rightLeg - resultRef.rightLeg));
    const double parity = fmax(fabs(resultNew.leftLeg - resultOld.leftLeg),
                               fabs(resultNew.rightLeg - resultOld.rightLeg));

    accum.pointCount++;
    accum.sumErrNew += errNew;
    accum.sumErrOld += errOld;
    if (errNew >= kAccuracyTolerance) accum.overAccuracyTolerance++;

    if (errNew > accum.maxErrNew) {
        accum.maxErrNew = errNew;
        accum.worstNewX = x;
        accum.worstNewY = y;
        accum.worstNewTop = topDistance;
    }
    if (errOld > accum.maxErrOld) accum.maxErrOld = errOld;
    if (parity > accum.maxParity) {
        accum.maxParity = parity;
        accum.worstParityX = x;
        accum.worstParityY = y;
        accum.worstParityTop = topDistance;
    }

    const double radToDeg = 180.0 / kPi;
    accum.maxGammaErrNew = fmax(accum.maxGammaErrNew, fabs(resultNew.gamma - resultRef.gamma) * radToDeg);
    accum.maxGammaErrOld = fmax(accum.maxGammaErrOld, fabs(resultOld.gamma - resultRef.gamma) * radToDeg);
}

// Walks from `from` to `to` in ~kStepMM increments (mirroring getNextIncrement() in
// interpolatingmovementtask.cpp), evaluating all three solvers at every step.
void walkSegment(Point from, Point to, double topDistance, double minSafeXOffset, double minSafeY,
                  const Kinematics::PhysicsParams &params,
                  double &gamma_state_new, double &gamma_state_old, GridResult &accum) {
    const double dx = to.x - from.x;
    const double dy = to.y - from.y;
    const double distance = sqrt(dx * dx + dy * dy);
    const int steps = std::max(1, (int)ceil(distance / kStepMM));

    for (int i = 1; i <= steps; i++) {
        const double t = (double)i / steps;
        evaluatePoint(from.x + t * dx, from.y + t * dy, topDistance, minSafeXOffset, minSafeY,
                      params, gamma_state_new, gamma_state_old, accum);
    }
}

GridResult runGridForTopDistance(double topDistance, GridResult accum) {
    const Kinematics::PhysicsParams params = makeParams();

    const double minSafeY = safeYFraction * topDistance;
    const double minSafeXOffset = safeXFraction * topDistance;
    const double width = topDistance - 2 * minSafeXOffset;
    const double height = topDistance * 0.6; // representative drawable height, well within safe bounds.

    // Warm-started state, carried across the whole walk just like Movement::gamma_last_position
    // is carried across successive getBeltLengths() calls during a real drawing.
    double gamma_state_new = 0.0;
    double gamma_state_old = 0.0;

    Point current = {0.0, 0.0};
    evaluatePoint(current.x, current.y, topDistance, minSafeXOffset, minSafeY, params, gamma_state_new, gamma_state_old, accum);

    int rowIndex = 0;
    for (double y = 0.0; y <= height; y += kRowSpacingMM) {
        const double targetX = (rowIndex % 2 == 0) ? width : 0.0;
        Point rowEnd = {targetX, y};
        walkSegment(current, rowEnd, topDistance, minSafeXOffset, minSafeY, params, gamma_state_new, gamma_state_old, accum);
        current = rowEnd;

        const double nextY = std::min(y + kRowSpacingMM, height);
        if (nextY > y) {
            Point rowStep = {current.x, nextY};
            walkSegment(current, rowStep, topDistance, minSafeXOffset, minSafeY, params, gamma_state_new, gamma_state_old, accum);
            current = rowStep;
        }
        rowIndex++;
    }

    return accum;
}

// The reference is only usable as ground truth if it lands on the same equilibrium
// regardless of where it starts. Spot-check that over a sparse sample of the domain.
bool checkReferenceIsWarmStartIndependent() {
    const Kinematics::PhysicsParams params = makeParams();
    const double starts[] = {-0.3, 0.0, 0.02, 0.3};
    double maxSpread = 0.0;

    for (double topDistance : {1000.0, 2000.0, 3000.0}) {
        const double minSafeY = safeYFraction * topDistance;
        const double minSafeXOffset = safeXFraction * topDistance;
        const double width = topDistance - 2 * minSafeXOffset;
        const double height = topDistance * 0.6;

        for (int ix = 0; ix <= 10; ix++) {
            for (int iy = 0; iy <= 10; iy++) {
                const double frameX = minSafeXOffset + width * ix / 10.0;
                const double frameY = minSafeY + height * iy / 10.0;

                const Kinematics::BeltLengthsResult base = referenceSolve(frameX, frameY, topDistance, starts[0], params);
                for (double start : starts) {
                    const Kinematics::BeltLengthsResult other = referenceSolve(frameX, frameY, topDistance, start, params);
                    maxSpread = fmax(maxSpread, fmax(fabs(other.leftLeg - base.leftLeg),
                                                     fabs(other.rightLeg - base.rightLeg)));
                }
            }
        }
    }

    printf("Reference self-check: max spread across gamma_init in {-0.3, 0, 0.02, 0.3} rad = %.3e mm\n", maxSpread);
    if (maxSpread >= 1e-9) {
        printf("FAIL: reference solve is not warm-start independent; it cannot be used as ground truth.\n");
        return false;
    }
    return true;
}

} // namespace

int main() {
    if (!checkReferenceIsWarmStartIndependent()) {
        return 1;
    }

    const std::vector<double> topDistances = {1000.0, 2000.0, 3000.0};

    GridResult accum;
    for (double topDistance : topDistances) {
        accum = runGridForTopDistance(topDistance, accum);
    }

    printf("\nParity test: %ld points (boustrophedon path at %.0fmm step, %.0fmm row spacing) across topDistance in {1000,2000,3000}mm\n",
           accum.pointCount, kStepMM, kRowSpacingMM);
    printf("  ACCURACY  root-finder vs reference: max %.6f mm, mean %.6f mm, max |dgamma| %.6f deg\n",
           accum.maxErrNew, accum.sumErrNew / accum.pointCount, accum.maxGammaErrNew);
    printf("            worst point: topDistance=%.0fmm x=%.2f y=%.2f, points >= %.3fmm: %ld / %ld\n",
           accum.worstNewTop, accum.worstNewX, accum.worstNewY, kAccuracyTolerance,
           accum.overAccuracyTolerance, accum.pointCount);
    printf("  BASELINE  grid search vs reference: max %.6f mm, mean %.6f mm, max |dgamma| %.6f deg\n",
           accum.maxErrOld, accum.sumErrOld / accum.pointCount, accum.maxGammaErrOld);
    printf("  PARITY    root-finder vs grid search: max %.6f mm, worst point: topDistance=%.0fmm x=%.2f y=%.2f\n",
           accum.maxParity, accum.worstParityTop, accum.worstParityX, accum.worstParityY);

    bool ok = true;

    if (accum.maxErrNew < kAccuracyTolerance) {
        printf("PASS: root-finder accuracy %.6f mm < %.3f mm tolerance\n", accum.maxErrNew, kAccuracyTolerance);
    } else {
        printf("FAIL: root-finder accuracy %.6f mm >= %.3f mm tolerance\n", accum.maxErrNew, kAccuracyTolerance);
        ok = false;
    }

    if (accum.maxParity < kParityTolerance) {
        printf("PASS: root-finder vs grid search %.6f mm < %.2f mm parity bound\n", accum.maxParity, kParityTolerance);
    } else {
        printf("FAIL: root-finder vs grid search %.6f mm >= %.2f mm parity bound\n", accum.maxParity, kParityTolerance);
        ok = false;
    }

    // The parity bound is only meaningful while the grid search remains the less accurate
    // solver. If that ever inverts, the bound above is measuring the wrong thing.
    if (accum.maxErrOld <= accum.maxErrNew) {
        printf("FAIL: grid search is no longer the less accurate solver (%.6f mm vs %.6f mm); revisit the parity bound.\n",
               accum.maxErrOld, accum.maxErrNew);
        ok = false;
    }

    return ok ? 0 : 1;
}
