import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { advancePerLoop, cycloidLength, lightestCoverage, traceCycloidRow } from "../src/fillStrategies/cycloidPath";
import { mulberry32 } from "../src/fillStrategies/seededRandom";

const PEN = 1.2;
const SPACING = 5;

// Ink coverage a traced row actually lays over the patch it covers: drawn
// length times nib width, against the row's own area. This is what the tonal
// model is claiming to control, so it is what the tests measure.
function measuredCoverage(points: ReturnType<typeof traceCycloidRow>, width: number, spacing: number): number {
    return (cycloidLength(points) * PEN) / (width * spacing);
}

test("a darker target crowds the loops together", () => {
    const light = traceCycloidRow(0, 100, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: 0.15 });
    const dark = traceCycloidRow(0, 100, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: 0.6 });

    assert.ok(cycloidLength(dark) > cycloidLength(light) * 2,
        `a 4x darker target should lay far more ink: ${cycloidLength(light).toFixed(0)} vs ${cycloidLength(dark).toFixed(0)}`);
});

test("coverage tracks the target rather than saturating in the mid-tones", () => {
    // The failure the Poisson inversion exists to prevent: a linear model
    // reads correctly up to about half coverage and then flattens off, so
    // every tone above a mid grey comes out the same.
    //
    // Targets start above the row's own floor - see the next test - because
    // below that they are all asking for something a single row cannot do.
    const targets = [0.3, 0.4, 0.5, 0.65, 0.8];
    const measured = targets.map(c =>
        measuredCoverage(traceCycloidRow(0, 200, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: c }), 200, SPACING));

    for (let i = 1; i < measured.length; i++) {
        assert.ok(measured[i] > measured[i - 1] * 1.1,
            `coverage should keep climbing with the target, got ${measured.map(m => m.toFixed(2)).join(' ')}`);
    }
});

test("a row cannot be drawn lighter than a single line of ink", () => {
    // Stretch the loops as far as they go and the pen is drawing one line
    // `pen` wide every `spacing` apart. That floor is what a row of ink costs,
    // not something about loops, and the way past it is a wider spacing.
    const floor = lightestCoverage(PEN, SPACING);
    const asked = 0.05;
    const got = measuredCoverage(
        traceCycloidRow(0, 200, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: asked }), 200, SPACING);

    assert.ok(got > asked * 2, 'a row simply cannot be that light');
    assert.ok(got < floor * 1.5,
        `but it should sit near the floor of ${floor.toFixed(2)}, got ${got.toFixed(2)}`);

    // Doubling the spacing halves what a row costs, which is the real control.
    const wider = measuredCoverage(
        traceCycloidRow(0, 200, 0, { spacingMm: SPACING * 2, penWidthMm: PEN, coverage: asked }), 200, SPACING * 2);
    assert.ok(wider < got * 0.75,
        `wider rows are how you get lighter: ${got.toFixed(2)} -> ${wider.toFixed(2)}`);
});

test("the loop radius changes the look without changing the density", () => {
    const tight = traceCycloidRow(0, 200, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: 0.3, radiusFraction: 0.5 });
    const loose = traceCycloidRow(0, 200, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: 0.3, radiusFraction: 1.0 });

    const a = measuredCoverage(tight, 200, SPACING);
    const b = measuredCoverage(loose, 200, SPACING);
    assert.ok(Math.abs(a - b) / a < 0.15,
        `radius is cosmetic, so coverage should barely move: ${a.toFixed(3)} vs ${b.toFixed(3)}`);
});

test("advancePerLoop is clamped at both ends", () => {
    // Near-black asks for an advance of almost nothing; the floor stops the
    // walk coiling on one spot for ink the paper cannot hold.
    const black = advancePerLoop(1, 4, PEN, SPACING);
    assert.ok(black >= 0.05 * SPACING - 1e-9, `got ${black}`);

    // Near-white asks for an enormous one; past the ceiling the row reads as a
    // wavy line rather than as scribble.
    const white = advancePerLoop(0.0001, 4, PEN, SPACING);
    assert.ok(white <= 6 * SPACING + 1e-9, `got ${white}`);
});

test("degenerate inputs produce an empty row rather than a hang", () => {
    assert.deepEqual(traceCycloidRow(0, 100, 0, { spacingMm: 0, penWidthMm: PEN, coverage: 0.3 }), []);
    assert.deepEqual(traceCycloidRow(100, 0, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: 0.3 }), []);
    assert.deepEqual(traceCycloidRow(0, 100, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: 0 }), []);
});

test("the row stays within its own band and spans its range", () => {
    const radiusFraction = 0.8;
    const points = traceCycloidRow(0, 100, 50, {
        spacingMm: SPACING, penWidthMm: PEN, coverage: 0.3, radiusFraction,
    });
    const reach = radiusFraction * SPACING;

    for (const p of points) {
        assert.ok(Math.abs(p.y - 50) <= reach + 1e-6,
            `a loop should stay within its own row band, got y=${p.y}`);
    }
    const lastX = points[points.length - 1].x;
    assert.ok(lastX > 90, `the row should reach the end of its range, stopped at ${lastX}`);
});

test("the same seed redraws the same scribble", () => {
    const opts = () => ({
        spacingMm: SPACING, penWidthMm: PEN, coverage: 0.3, jitterMm: 0.2,
        random: mulberry32(99),
    });
    assert.deepEqual(traceCycloidRow(0, 60, 0, opts()), traceCycloidRow(0, 60, 0, opts()));
});

test("jitter perturbs the scribble without moving its density", () => {
    const clean = traceCycloidRow(0, 200, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: 0.3, random: mulberry32(7) });
    const rough = traceCycloidRow(0, 200, 0, { spacingMm: SPACING, penWidthMm: PEN, coverage: 0.3, jitterMm: 0.25, random: mulberry32(7) });

    assert.notDeepEqual(clean, rough);
    const a = measuredCoverage(clean, 200, SPACING);
    const b = measuredCoverage(rough, 200, SPACING);
    assert.ok(Math.abs(a - b) / a < 0.2, `jitter is texture, not tone: ${a.toFixed(3)} vs ${b.toFixed(3)}`);
});
