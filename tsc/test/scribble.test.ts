/**
 * The whole-image scribble algorithms (src/scribble/).
 *
 * These are arithmetic over a grid, with no paper.js in them, so unlike the
 * fill-strategy tests they need no native canvas binding and never skip.
 *
 * What is worth asserting about a non-deterministic drawing algorithm is not
 * the drawing - another seed gives a different and equally valid one - but the
 * properties that make it a drawing at all: ink lands where the picture is
 * dark, it stays inside the frame, the same seed repeats, and the stitching
 * does not change what is drawn.
 */
import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { inkDemand, inkLengthFor, solveInkGamma } from "../src/scribble/demand";
import { greedyScribble, Point } from "../src/scribble/greedy";
import { breakLongEdges, hilbertIndex, stipple, tspScribble } from "../src/scribble/tsp";
import { joinChains, measureChains, orderChains, stitch } from "../src/scribble/stitch";
import { mulberry32 } from "../src/fillStrategies/seededRandom";

const DRAW_WIDTH_MM = 200;
const PEN_MM = 1.2;

/** An image with a dark disc on the left half and bare paper on the right. */
function halfDarkImage(width = 200, height = 200): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const dark = x < width / 2;
            const value = dark ? 30 : 250;
            data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
        }
    }
    return { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
}

function blankImage(width = 100, height = 100): ImageData {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    return { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
}

function inkOnEachSide(chains: Point[][], boundaryMm: number): { left: number; right: number } {
    let left = 0;
    let right = 0;
    for (const chain of chains) {
        for (let i = 1; i < chain.length; i++) {
            const length = Math.hypot(chain[i].x - chain[i - 1].x, chain[i].y - chain[i - 1].y);
            const midpoint = (chain[i].x + chain[i - 1].x) / 2;
            if (midpoint < boundaryMm) left += length; else right += length;
        }
    }
    return { left, right };
}

function bounds(chains: Point[][]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const chain of chains) {
        for (const p of chain) {
            minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
        }
    }
    return { minX, minY, maxX, maxY };
}

// --- demand ---------------------------------------------------------------

test("demand: dark reads as ink wanted, white as bare paper", () => {
    const map = inkDemand(halfDarkImage(), { drawWidthMm: DRAW_WIDTH_MM });

    const sample = (x: number, y: number) => map.demand[y * map.width + x];
    assert.ok(sample(map.width >> 2, map.height >> 1) > 0.5, "the dark half should want ink");
    assert.ok(sample((map.width * 3) >> 2, map.height >> 1) < 0.1, "the white half should want almost none");
});

test("demand: the map is sized by the paper, not by the image file", () => {
    // The same picture at two resolutions has to produce the same working map,
    // or the drawing depends on how large the file happened to be. Both of
    // these are larger than the working resolution the paper asks for, which
    // is the case that matters - a photo import is thousands of pixels wide.
    const large = inkDemand(halfDarkImage(800, 800), { drawWidthMm: DRAW_WIDTH_MM });
    const larger = inkDemand(halfDarkImage(2400, 2400), { drawWidthMm: DRAW_WIDTH_MM });

    assert.equal(large.width, larger.width);
    assert.ok(Math.abs(large.mmPerPixel - larger.mmPerPixel) < 1e-9);
});

test("demand: a source coarser than the paper asks for is not upsampled", () => {
    // The floor the rule above stops at: asking for more pixels than the image
    // has would invent detail rather than read it.
    const coarse = inkDemand(halfDarkImage(120, 120), { drawWidthMm: DRAW_WIDTH_MM });
    assert.equal(coarse.width, 120);
});

test("demand: a heavy image is lightened toward the ink ceiling", () => {
    const image = halfDarkImage(800, 800);
    const asIs = inkDemand(image, { drawWidthMm: DRAW_WIDTH_MM, inkCeiling: 1 });
    const budgeted = inkDemand(image, { drawWidthMm: DRAW_WIDTH_MM, inkCeiling: 0.2 });

    const meanOf = (values: Float32Array) => {
        let total = 0;
        for (const value of values) total += value;
        return total / values.length;
    };

    assert.ok(meanOf(budgeted.demand) < meanOf(asIs.demand) * 0.75,
        `the ceiling should take a real bite: ${meanOf(asIs.demand).toFixed(3)} -> ${meanOf(budgeted.demand).toFixed(3)}`);
});

test("demand: the ceiling cannot darken a light image, and cannot flatten a dark one", () => {
    // Two bounds on the gamma, both deliberate. Below 1 it would spend plot
    // time making a light picture heavier than it was asked to be; above 4 it
    // would crush every mid-tone out of a dark one to hit a budget. A half-
    // black page cannot reach a 0.2 ceiling without that, so it stops.
    const light = new Float32Array([0.05, 0.05, 0.05]);
    assert.equal(solveInkGamma(light, 0.2), 1);

    const halfBlack = new Float32Array([0.9, 0.9, 0.02, 0.02]);
    assert.ok(solveInkGamma(halfBlack, 0.2) <= 4);
});

test("demand: the ink a tone needs is the Poisson length, not the coverage", () => {
    // Ink landing on ink covers no new paper: 90% coverage needs well over 0.9
    // of line, and the gap widens as the tone darkens.
    assert.ok(Math.abs(inkLengthFor(0.1) - 0.105) < 0.01);
    assert.ok(inkLengthFor(0.9) > 2.2);
    assert.ok(inkLengthFor(0.5) / 0.5 < inkLengthFor(0.9) / 0.9, "the correction should grow with the tone");
});

// --- greedy ---------------------------------------------------------------

test("greedy: ink goes where the picture is dark", () => {
    const map = inkDemand(halfDarkImage(), { drawWidthMm: DRAW_WIDTH_MM });
    const chains = greedyScribble(map, { penWidthMm: PEN_MM, random: mulberry32(1) });

    assert.ok(chains.length > 0, "expected the walk to draw something");
    const { left, right } = inkOnEachSide(chains, DRAW_WIDTH_MM / 2);
    assert.ok(left > right * 10, `ink should follow the tone: ${left.toFixed(0)}mm left, ${right.toFixed(0)}mm right`);
});

test("greedy: nothing is drawn outside the paper", () => {
    const map = inkDemand(halfDarkImage(), { drawWidthMm: DRAW_WIDTH_MM });
    const chains = greedyScribble(map, { penWidthMm: PEN_MM, random: mulberry32(2) });
    const box = bounds(chains);

    assert.ok(box.minX >= -1e-6 && box.minY >= -1e-6, `started outside the page at ${box.minX}, ${box.minY}`);
    assert.ok(box.maxX <= DRAW_WIDTH_MM + 1e-6, `ran off the right edge to ${box.maxX}`);
    assert.ok(box.maxY <= DRAW_WIDTH_MM * (map.height / map.width) + 1e-6);
});

test("greedy: the same seed redraws the same picture, a different one does not", () => {
    const map = inkDemand(halfDarkImage(), { drawWidthMm: DRAW_WIDTH_MM });
    const first = greedyScribble(map, { penWidthMm: PEN_MM, random: mulberry32(5) });
    const same = greedyScribble(map, { penWidthMm: PEN_MM, random: mulberry32(5) });
    const other = greedyScribble(map, { penWidthMm: PEN_MM, random: mulberry32(6) });

    assert.deepEqual(same, first, "a preview that does not predict the plot is not a preview");
    assert.notDeepEqual(other, first, "another seed should give another equally valid drawing");
});

test("greedy: a blank page is left blank", () => {
    const map = inkDemand(blankImage(), { drawWidthMm: DRAW_WIDTH_MM });
    assert.deepEqual(greedyScribble(map, { penWidthMm: PEN_MM, random: mulberry32(3) }), []);
});

test("greedy: a darker picture is given more ink", () => {
    const measure = (value: number) => {
        const width = 200, height = 200;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < data.length; i += 4) {
            data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
        }
        const image = { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
        // No ink ceiling, or both of these are flattened onto it.
        const map = inkDemand(image, { drawWidthMm: DRAW_WIDTH_MM, inkCeiling: 1 });
        return measureChains(greedyScribble(map, { penWidthMm: PEN_MM, random: mulberry32(4) })).drawnMm;
    };

    const light = measure(200);
    const dark = measure(60);
    assert.ok(dark > light * 1.5, `a darker page should take more ink: ${light.toFixed(0)}mm vs ${dark.toFixed(0)}mm`);
});

// --- tsp ------------------------------------------------------------------

test("tsp: stipple points crowd into the dark", () => {
    const map = inkDemand(halfDarkImage(), { drawWidthMm: DRAW_WIDTH_MM });
    const { xs } = stipple(map, 500, 8, mulberry32(9));

    let left = 0;
    for (let i = 0; i < xs.length; i++) {
        if (xs[i] < map.width / 2) left++;
    }
    assert.ok(left > xs.length * 0.9, `expected the points in the dark half, ${left} of ${xs.length} were`);
});

test("tsp: the drawing is essentially one line", () => {
    const map = inkDemand(halfDarkImage(), { drawWidthMm: DRAW_WIDTH_MM });
    const chains = tspScribble(map, { points: 1500, random: mulberry32(10) });

    assert.ok(chains.length > 0);
    // Cut only where it would otherwise rule a line across the paper, so the
    // count stays a handful rather than a per-region thing.
    assert.ok(chains.length < 40, `expected a tour, got ${chains.length} pieces`);
    const longest = chains.reduce((best, c) => (c.length > best.length ? c : best), chains[0]);
    assert.ok(longest.length > 500, "most of the points should be on one continuous stroke");
});

test("tsp: a tour lays far less line than the walk for the same picture", () => {
    // The reason it exists: no overdraw, so every unit of line lands on fresh
    // paper. Measured at about 2.5x on the prototypes.
    const map = inkDemand(halfDarkImage(), { drawWidthMm: DRAW_WIDTH_MM });
    const walk = measureChains(greedyScribble(map, { penWidthMm: PEN_MM, random: mulberry32(12) }));
    const tour = measureChains(tspScribble(map, { points: 3000, random: mulberry32(12) }));

    assert.ok(tour.drawnMm < walk.drawnMm, `tour ${(tour.drawnMm/1000).toFixed(1)}m vs walk ${(walk.drawnMm/1000).toFixed(1)}m`);
});

test("tsp: the Hilbert index keeps neighbours together", () => {
    // What the starting order is for: points close on the curve are close on
    // the page, so 2-opt starts from something already sane.
    const near = Math.abs(hilbertIndex(10, 10) - hilbertIndex(11, 10));
    const far = Math.abs(hilbertIndex(10, 10) - hilbertIndex(5000, 5000));
    assert.ok(near < far / 100, `neighbouring cells should be near on the curve: ${near} vs ${far}`);
});

test("tsp: breaking long edges cuts exactly the transits", () => {
    const path: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 60, y: 0 }, { x: 61, y: 0 }];
    const pieces = breakLongEdges(path, 10);

    assert.equal(pieces.length, 2);
    assert.equal(pieces[0].length, 3);
    assert.equal(pieces[1].length, 2);
});

// --- stitch ---------------------------------------------------------------

test("stitch: ordering cuts the travel without touching the drawing", () => {
    const chains: Point[][] = [
        [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        [{ x: 100, y: 0 }, { x: 110, y: 0 }],
        [{ x: 11, y: 0 }, { x: 20, y: 0 }],
    ];

    const before = measureChains(chains);
    const after = measureChains(orderChains(chains));

    assert.ok(Math.abs(after.drawnMm - before.drawnMm) < 1e-9, "ordering must not change the ink");
    assert.equal(after.chains, before.chains, "nor the number of strokes");
    assert.ok(after.travelMm < before.travelMm, `expected less travel: ${before.travelMm} -> ${after.travelMm}`);
});

test("stitch: joining trades a little ink for a lot of pen lifts", () => {
    const chains: Point[][] = [];
    for (let i = 0; i < 20; i++) {
        chains.push([{ x: i * 12, y: 0 }, { x: i * 12 + 10, y: 0 }]);
    }

    const joined = joinChains(chains, 3);
    const before = measureChains(chains);
    const after = measureChains(joined);

    assert.equal(after.chains, 1, "gaps of 2mm should all close at a 3mm budget");
    assert.ok(after.drawnMm > before.drawnMm, "and that costs the ink of the bridges");
    assert.ok(after.drawnMm < before.drawnMm * 1.3, "but not much of it");
});

test("stitch: a gap wider than the budget stays a pen lift", () => {
    const chains: Point[][] = [
        [{ x: 0, y: 0 }, { x: 10, y: 0 }],
        [{ x: 30, y: 0 }, { x: 40, y: 0 }],
    ];
    assert.equal(joinChains(chains, 5).length, 2);
    assert.equal(joinChains(chains, 25).length, 1);
});

test("stitch: on a real walk, ordering is free and joining is cheap", () => {
    const map = inkDemand(halfDarkImage(), { drawWidthMm: DRAW_WIDTH_MM });
    const chains = greedyScribble(map, { penWidthMm: PEN_MM, random: mulberry32(13) });

    const walked = measureChains(chains);
    const ordered = measureChains(stitch(chains, 0));
    const joined = measureChains(stitch(chains, 8));

    assert.ok(ordered.travelMm < walked.travelMm / 5, `travel ${(walked.travelMm/1000).toFixed(1)}m -> ${(ordered.travelMm/1000).toFixed(1)}m`);
    assert.ok(joined.chains < walked.chains / 2, `chains ${walked.chains} -> ${joined.chains}`);
    assert.ok(joined.drawnMm < walked.drawnMm * 1.15, "the bridges should cost a few percent, not a fifth");
});
