// Pure (paper.js-free) loop-scribble geometry for cycloid.ts: walks a row
// across a shape while tracing a small circle, so the pen lays a continuous
// chain of loops rather than a straight hatch line. Kept dependency-free
// (plain numbers and injected callbacks, no paper.Point/paper.Path) so it can
// be unit tested without paper.js's native `canvas` probe - same reasoning as
// streamline.ts, which gradientHatch.ts uses the same way.
//
// The look is biro shading: someone filling a region by scribbling without
// lifting the pen. What makes it read as shading rather than as texture is
// that the loops crowd together where the fill wants to be dark and stretch
// out where it wants to be light.
//
// The advance rate is derived rather than tuned, in two steps.
//
// First, how much ink a target tone demands. Ink landing on ink covers no new
// paper, so reading coverage as length*pen/area saturates around half tone and
// then lies - every shade above a mid grey comes out the same. The Poisson form
//
//     coverage = 1 - exp(-length * pen / area)
//
// does not, and inverting it gives the length the tone actually demands.
//
// Second, how much ink an advance rate lays. The obvious answer - one loop is
// 2*pi*r of ink - is only true when the loop is standing still. The centre is
// travelling while the pen goes round, so the curve is a trochoid and its
// length per turn runs from 2*pi*r when the loops are packed tight up to the
// advance itself when they are stretched into a wave. Assuming the circle
// costs the pen about a third more ink than asked for at the light end, and
// flattens the two lightest tones into the same one.
//
// So the length per turn is measured numerically and the advance solved for by
// bisection. It is monotone - the faster the centre moves, the less ink per
// unit of paper - so a dozen iterations pin it, and the density then comes out
// right by construction. That leaves loop radius and jitter as purely cosmetic
// knobs, which is the point: they change the handwriting, not the tone.

export type CycloidPoint = { x: number; y: number };

export type CycloidOptions = {
    // Row spacing, in the same units as everything else here (mm at render
    // time). Also sets the loop scale.
    spacingMm: number;
    // Nib width. Together with spacing this fixes how much ink a loop lays.
    penWidthMm: number;
    // Ink coverage this row is aiming for, 0..1.
    coverage: number;
    // Loop radius as a fraction of row spacing. Larger loops read as looser
    // scribble; they do not change the density, which the advance rate
    // absorbs.
    radiusFraction?: number;
    // Radians of loop per emitted point. Smaller is smoother and costs more
    // points.
    stepRadians?: number;
    // Peak random displacement per point, in mm. Zero draws a mechanically
    // perfect scribble, which is a contradiction in terms.
    jitterMm?: number;
    // Seeded, so a re-render of the same request reproduces the same scribble
    // (see seededRandom.ts for why that matters).
    random?: () => number;
};

// Coverage this close to solid is treated as solid: -ln(1 - c) runs away at
// the top end, and a loop fill cannot reach true black anyway - it overdraws
// its own ink faster than it covers new paper.
const MAX_MODELLED_COVERAGE = 0.985;

// Never advance less than this fraction of the row spacing per loop. Without
// a floor a near-black target asks for an advance of almost nothing, and the
// walk emits thousands of points coiled on one spot for ink the paper cannot
// hold anyway.
const MIN_ADVANCE_FRACTION = 0.05;

// Nor more than this. Past it the loops are so stretched that the row reads as
// a wavy line rather than as scribble, and a straight hatch would be honester.
//
// It also barely matters, because a row has a lightest tone it cannot go below
// whatever the advance: stretch the loops far enough and the pen is drawing one
// line of ink `pen` wide every `spacing` apart, which is pen/spacing coverage
// and no lighter. That is not a limitation of loops - it is what a row of ink
// costs, and every hatch style here shares it. The way to a lighter tone is a
// wider spacing, which is exactly what the density ladder varies.
const MAX_ADVANCE_FACTOR = 6;

const DEFAULT_RADIUS_FRACTION = 0.8;
const DEFAULT_STEP_RADIANS = 0.32;

// Samples per turn for the arc-length integral below. The integrand is smooth
// and periodic, so a coarse sum converges fast; 48 is well past the point
// where more changes the answer in any digit that matters here.
const ARC_LENGTH_SAMPLES = 48;

/**
 * Drawn length of one full turn of the trochoid the pen actually traces.
 *
 * With the centre advancing `advance` per turn and the pen held `radius` off
 * it, the pen's velocity is the sum of the two motions, and the length is the
 * integral of its magnitude. No closed form, but it is a one-dimensional
 * integral over a smooth periodic function, so a plain sum does the job.
 */
export function trochoidLengthPerTurn(advance: number, radius: number): number {
    const drift = advance / (2 * Math.PI);
    let total = 0;
    const step = (2 * Math.PI) / ARC_LENGTH_SAMPLES;
    for (let i = 0; i < ARC_LENGTH_SAMPLES; i++) {
        const theta = i * step;
        const vx = drift - radius * Math.sin(theta);
        const vy = radius * Math.cos(theta);
        total += Math.hypot(vx, vy) * step;
    }
    return total;
}

/**
 * How far the loop's centre should travel per full turn to land `coverage`.
 *
 * Exported for its own sake: this is the whole tonal model, and it is worth
 * being able to check it directly rather than only through the geometry it
 * produces.
 */
export function lightestCoverage(penWidthMm: number, spacingMm: number): number {
    // One line of ink per row, stretched straight. See MAX_ADVANCE_FACTOR.
    return spacingMm > 0 ? Math.min(1, penWidthMm / spacingMm) : 1;
}

export function advancePerLoop(coverage: number, radius: number, penWidthMm: number, spacingMm: number): number {
    const clamped = Math.min(MAX_MODELLED_COVERAGE, Math.max(0, coverage));
    // Ink length per unit area that this tone demands.
    const demand = Math.max(1e-6, -Math.log(1 - clamped)) / penWidthMm;

    // Ink length per unit area that a given advance delivers. Monotonically
    // decreasing in `advance`: the faster the centre travels, the more paper
    // each turn has to cover.
    const supply = (advance: number) => trochoidLengthPerTurn(advance, radius) / (advance * spacingMm);

    let lo = MIN_ADVANCE_FRACTION * spacingMm;
    let hi = MAX_ADVANCE_FACTOR * spacingMm;
    if (supply(lo) <= demand) return lo;   // even packed tight it cannot go darker
    if (supply(hi) >= demand) return hi;   // even stretched right out it is too dark

    for (let i = 0; i < 24; i++) {
        const mid = 0.5 * (lo + hi);
        if (supply(mid) > demand) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

/**
 * Traces one row of loops from x0 to x1 along `y`.
 *
 * Returns a single polyline. Clipping to the actual shape is the caller's job
 * - this module knows nothing about shapes, only about how to scribble along
 * a line.
 */
export function traceCycloidRow(x0: number, x1: number, y: number, options: CycloidOptions): CycloidPoint[] {
    const {
        spacingMm,
        penWidthMm,
        coverage,
        radiusFraction = DEFAULT_RADIUS_FRACTION,
        stepRadians = DEFAULT_STEP_RADIANS,
        jitterMm = 0,
        random = () => 0.5,
    } = options;

    if (!(spacingMm > 0) || !(x1 > x0) || coverage <= 0) return [];

    const radius = radiusFraction * spacingMm;
    const advance = advancePerLoop(coverage, radius, penWidthMm, spacingMm);
    const centreStep = (advance * stepRadians) / (2 * Math.PI);

    const points: CycloidPoint[] = [];
    let centreX = x0;
    let theta = random() * Math.PI * 2;

    // A hard cap rather than trust in the arithmetic: a caller passing a
    // degenerate spacing should get a short row, not a hung render.
    const maxPoints = Math.ceil(((x1 - x0) / Math.max(centreStep, 1e-6)) + 8);

    while (centreX <= x1 && points.length < maxPoints) {
        theta += stepRadians;
        centreX += centreStep;
        const jx = jitterMm ? (random() * 2 - 1) * jitterMm : 0;
        const jy = jitterMm ? (random() * 2 - 1) * jitterMm : 0;
        points.push({
            x: centreX + radius * Math.cos(theta) + jx,
            y: y + radius * Math.sin(theta) + jy,
        });
    }

    return points;
}

/** Total drawn length of a traced row - what the ink and time cost scale with. */
export function cycloidLength(points: CycloidPoint[]): number {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
        total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    }
    return total;
}
