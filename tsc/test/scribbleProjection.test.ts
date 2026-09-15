import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectScribble, projectedMeanInkLength } from "../src/scribble/projection";
import { DEFAULT_INK_CEILING, demandMapSize, inkDemand, inkLengthFor } from "../src/scribble/demand";
import { analyzeImageCharacteristics } from "../src/imageCharacteristics";
import { estimateProcessingSeconds } from "../src/processingEstimator";
import { estimateAndRecommend } from "../src/costEstimator";

function makeImageData(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const [r, g, b, a] = fill(x, y);
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = a;
        }
    }
    return { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
}

// A grey field, so darkness is a single number the test can reason about.
function makeGrey(level: number, size = 120): ImageData {
    return makeImageData(size, size, () => [level, level, level, 255]);
}

const BASE = {
    sourceWidthPx: 400,
    sourceHeightPx: 400,
    drawWidthMm: 600,
    penWidthMm: 1.2,
    meanDarkness: 0.2,
    meanInkDemand: 0.3,
    whiteHeadroom: 0.5,
};

test("projectScribble: the working map it projects is the one inkDemand will build", () => {
    const raster = makeGrey(128, 200);
    for (const drawWidthMm of [200, 600, 1800]) {
        const real = inkDemand(raster, { drawWidthMm });
        const projected = projectScribble({ ...BASE, mode: "greedy", drawWidthMm, sourceWidthPx: raster.width, sourceHeightPx: raster.height });

        assert.equal(projected.mapWidth, real.width, `width at ${drawWidthMm}mm`);
        assert.equal(projected.mapHeight, real.height, `height at ${drawWidthMm}mm`);
        assert.ok(Math.abs(projected.mmPerPixel - real.mmPerPixel) < 1e-9);
    }
});

test("demandMapSize: never asks for more pixels than the source has", () => {
    // A 3m plot at 1.5px/mm would want 4500 map pixels across; the source has
    // 300, and inventing the rest would be inventing detail.
    const { width } = demandMapSize(300, 200, 3000);
    assert.equal(width, 300);
});

test("projectScribble: a darker image is projected to need more line", () => {
    const light = projectScribble({ ...BASE, mode: "greedy", meanDarkness: 0.05, meanInkDemand: 0.08 });
    const dark = projectScribble({ ...BASE, mode: "greedy", meanDarkness: 0.18, meanInkDemand: 0.35 });

    assert.ok(dark.drawnMm > light.drawnMm * 2, `${dark.drawnMm} vs ${light.drawnMm}`);
    assert.ok(dark.strokeCount > light.strokeCount);
    assert.ok(dark.pointCount > light.pointCount);
});

test("projectScribble: a wider nib needs less line for the same picture", () => {
    const fine = projectScribble({ ...BASE, mode: "greedy", penWidthMm: 0.5 });
    const broad = projectScribble({ ...BASE, mode: "greedy", penWidthMm: 2 });

    assert.ok(fine.drawnMm > broad.drawnMm * 2);
});

test("projectScribble: the tour's length grows as the square root of the area, the walk's linearly", () => {
    const small = { ...BASE, drawWidthMm: 300 };
    const large = { ...BASE, drawWidthMm: 1200 };

    const walk = projectScribble({ ...large, mode: "greedy" }).drawnMm / projectScribble({ ...small, mode: "greedy" }).drawnMm;
    const tour = projectScribble({ ...large, mode: "tsp" }).drawnMm / projectScribble({ ...small, mode: "tsp" }).drawnMm;

    // 16x the area. The walk covers all of it (its own waste term takes a
    // little off); the tour visits a fixed number of points spread over it.
    assert.ok(walk > 8 && walk < 16, `walk grew ${walk}x`);
    assert.ok(Math.abs(tour - 4) < 0.1, `tour grew ${tour}x`);
});

test("projectScribble: the tour is far cheaper to plot than the walk, which is why it exists", () => {
    const walk = projectScribble({ ...BASE, mode: "greedy" });
    const tour = projectScribble({ ...BASE, mode: "tsp" });

    assert.ok(tour.drawnMm < walk.drawnMm / 2);
    assert.ok(tour.chainCount < walk.chainCount);
});

test("projectedMeanInkLength: the ink ceiling only ever takes tone away, never adds it", () => {
    // Light enough to be left alone (demand.ts's ceiling is a budget, not a
    // target), so the image's own ink demand comes through untouched.
    assert.equal(projectedMeanInkLength(0.25, 0.1, DEFAULT_INK_CEILING), 0.25);
    // Darker than the budget, so the gamma compresses it.
    assert.ok(projectedMeanInkLength(0.8, 0.5, DEFAULT_INK_CEILING) < 0.8);
});

test("projectedMeanInkLength: lands near the real map's mean on a real image", () => {
    // The whole projection rests on this: what the walk pays off is the map's
    // mean ink length, and this predicts it from two numbers measured on the
    // raster instead of building the map.
    const raster = makeImageData(160, 160, (x, y) => {
        // A corner-to-corner ramp - tone spread across the whole frame, which
        // is the case a mean-darkness-only model gets most wrong.
        const value = Math.round(255 * ((x / 159) + (y / 159)) / 2);
        return [value, value, value, 255];
    });
    const characteristics = analyzeImageCharacteristics(raster);
    const map = inkDemand(raster, { drawWidthMm: 400 });

    let real = 0;
    for (let i = 0; i < map.demand.length; i++) real += inkLengthFor(map.demand[i]);
    real /= map.demand.length;

    const projected = projectedMeanInkLength(characteristics.meanInkDemand, characteristics.meanDarkness, DEFAULT_INK_CEILING);
    assert.ok(projected / real > 0.8 && projected / real < 1.25, `projected ${projected} against ${real}`);
});

test("estimateProcessingSeconds: a mark-making render costs nothing for stages it never runs", () => {
    const scribble = projectScribble({ ...BASE, mode: "greedy" });
    const estimate = estimateProcessingSeconds({
        sourceWidthPx: 400,
        sourceHeightPx: 400,
        colorCount: 1,
        fillStrategy: "crossHatch45",
        infillDensity: 5,
        complexity: 0.5,
        deviceFactor: 1,
        drawWidthMm: 600,
        drawHeightMm: 600,
        scribble,
    });

    // Nothing is traced, nothing overlaps, and the chains carry density 0 -
    // so these three stages are not skipped optimistically, they genuinely do
    // not happen (see toSvg.ts).
    assert.equal(estimate.breakdown.vectorizeSeconds, 0);
    assert.equal(estimate.breakdown.flattenKnockoutSeconds, 0);
    assert.equal(estimate.breakdown.infillSeconds, 0);
    assert.ok(estimate.breakdown.scribbleSeconds > 0);
    assert.ok(estimate.breakdown.renderSimplifyDedupeSeconds > 0);
    assert.equal(estimate.estimatedShapeCount, scribble.chainCount);
});

test("estimateProcessingSeconds: the fill strategy and density do not move a scribble's estimate", () => {
    const scribble = projectScribble({ ...BASE, mode: "greedy" });
    const common = {
        sourceWidthPx: 400, sourceHeightPx: 400, colorCount: 1, complexity: 0.5,
        deviceFactor: 1, drawWidthMm: 600, drawHeightMm: 600, scribble,
    };

    const cheap = estimateProcessingSeconds({ ...common, fillStrategy: "crossHatch45", infillDensity: 1 });
    const expensive = estimateProcessingSeconds({ ...common, fillStrategy: "gradientHatch", infillDensity: 7 });

    assert.equal(cheap.totalSeconds, expensive.totalSeconds);
});

test("estimateProcessingSeconds: the ink gamma is charged for only when the image is dark enough to need it", () => {
    const common = {
        sourceWidthPx: 800, sourceHeightPx: 800, colorCount: 1, complexity: 0.5,
        fillStrategy: "crossHatch45" as const, infillDensity: 3 as const,
        deviceFactor: 1, drawWidthMm: 600, drawHeightMm: 600,
    };
    // Same projected drawing either way - only the flag differs - so any
    // difference in the estimate is the gamma solve and nothing else.
    const projection = { ...BASE, mode: "tsp" as const, sourceWidthPx: 800, sourceHeightPx: 800 };
    const light = estimateProcessingSeconds({ ...common, scribble: projectScribble({ ...projection, meanDarkness: 0.1 }) });
    const dark = estimateProcessingSeconds({ ...common, scribble: projectScribble({ ...projection, meanDarkness: DEFAULT_INK_CEILING + 0.05 }) });

    assert.ok(dark.breakdown.scribbleSeconds > light.breakdown.scribbleSeconds);
});

test("estimateAndRecommend: a mark mode is estimated as itself, not as a trace and an infill", () => {
    const raster = makeImageData(160, 160, (x, y) => {
        const dark = ((x >> 4) + (y >> 4)) % 2 === 0;
        return dark ? [40, 40, 40, 255] : [250, 250, 250, 255];
    });

    const traced = estimateAndRecommend(raster, { deviceFactor: 1, drawWidthMm: 600, drawHeightMm: 600 });
    const scribbled = estimateAndRecommend(raster, { deviceFactor: 1, drawWidthMm: 600, drawHeightMm: 600, markMode: "greedy" });

    assert.equal(traced.scribble, undefined);
    assert.ok(scribbled.scribble);
    assert.equal(scribbled.scribble!.mode, "greedy");
    assert.notEqual(traced.processing.totalSeconds, scribbled.processing.totalSeconds);
    // The plotting estimate comes from the projected drawing rather than from
    // a shape count that has nothing to do with it.
    assert.equal(scribbled.plotting.drawDistanceMm, scribbled.scribble!.drawnMm);
    assert.equal(scribbled.plotting.travelDistanceMm, scribbled.scribble!.travelMm);
    assert.equal(scribbled.plotting.penTransitionCount, scribbled.scribble!.chainCount * 2);
    assert.equal(scribbled.plotting.penSwapCount, 0);
});

test("estimateAndRecommend: the two mark modes differ in plot time the way the algorithms do", () => {
    const raster = makeImageData(160, 160, (x, y) => {
        const value = Math.round(255 * (1 - (y / 159) * 0.7));
        return [value, value, value, 255];
    });

    const walk = estimateAndRecommend(raster, { deviceFactor: 1, drawWidthMm: 600, drawHeightMm: 600, markMode: "greedy" });
    const tour = estimateAndRecommend(raster, { deviceFactor: 1, drawWidthMm: 600, drawHeightMm: 600, markMode: "tsp" });

    // The tour draws one unbroken line and never overdraws, so it needs
    // markedly less ink and far fewer pen lifts than the walk.
    assert.ok(tour.plotting.totalSeconds < walk.plotting.totalSeconds);
    assert.ok(tour.plotting.penTransitionCount < walk.plotting.penTransitionCount);
});
