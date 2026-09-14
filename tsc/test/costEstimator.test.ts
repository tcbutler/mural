import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
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

function makeFlatVectorImage(): ImageData {
    const width = 150, height = 150;
    return makeImageData(width, height, (x) => (x < width / 2 ? [20, 20, 20, 255] : [240, 240, 240, 255]));
}

test("estimateAndRecommend: returns a complete result with plausible, self-consistent numbers", () => {
    const result = estimateAndRecommend(makeFlatVectorImage(), { deviceFactor: 1 });

    assert.ok(result.characteristics);
    assert.ok(result.recommendations);
    assert.ok(result.processing.totalSeconds >= 0);
    assert.ok(result.plotting.totalSeconds >= 0);
    assert.equal(result.deviceCalibration.factor, 1);
});

test("estimateAndRecommend: explicit option overrides win over the smart recommendation", () => {
    const withRecommendation = estimateAndRecommend(makeFlatVectorImage(), { deviceFactor: 1 });
    const overridden = estimateAndRecommend(makeFlatVectorImage(), { deviceFactor: 1, fillStrategy: "contour", infillDensity: 7 });

    assert.notEqual(withRecommendation.processing.totalSeconds, overridden.processing.totalSeconds);
});

test("estimateAndRecommend: a denser override costs more plotting and processing time than the default", () => {
    const sparse = estimateAndRecommend(makeFlatVectorImage(), { deviceFactor: 1, infillDensity: 1 });
    const dense = estimateAndRecommend(makeFlatVectorImage(), { deviceFactor: 1, infillDensity: 7 });

    assert.ok(dense.processing.totalSeconds > sparse.processing.totalSeconds);
    assert.ok(dense.plotting.drawSeconds >= sparse.plotting.drawSeconds);
});

test("estimateAndRecommend: more requested colors increases the projected pen-swap pause", () => {
    const oneColor = estimateAndRecommend(makeFlatVectorImage(), { deviceFactor: 1, colorCount: 1 });
    const fiveColors = estimateAndRecommend(makeFlatVectorImage(), { deviceFactor: 1, colorCount: 5 });

    assert.equal(oneColor.plotting.penSwapCount, 0);
    assert.equal(fiveColors.plotting.penSwapCount, 4);
    assert.ok(fiveColors.plotting.estimatedPenSwapPauseSeconds > oneColor.plotting.estimatedPenSwapPauseSeconds);
});

test("estimateAndRecommend: a larger physical draw size increases projected draw and travel distance", () => {
    const small = estimateAndRecommend(makeFlatVectorImage(), { deviceFactor: 1, drawWidthMm: 100, drawHeightMm: 100 });
    const large = estimateAndRecommend(makeFlatVectorImage(), { deviceFactor: 1, drawWidthMm: 2000, drawHeightMm: 2000 });

    assert.ok(large.plotting.drawDistanceMm > small.plotting.drawDistanceMm);
});

// --- tone preparation (tonePreparation.ts) ------------------------------
//
// The estimates describe the render that is about to happen, and that render
// traces the PREPARED image - so the numbers have to come from a reading of
// the prepared image, while the recommendations stay a statement about the
// photograph as handed in.
//
// Both fixtures below are 600px and tuned to their own size: characteristics.
// ts samples the luminance gradient every max(width, height)/100 pixels, so
// the same pattern at a different scale lands in a different bucket and the
// difference these tests measure disappears.

// A photographed page: paper that never reaches white, carrying the faint
// texture a camera picks up, around a darker subject. The texture sits just
// under the flat-gradient threshold as photographed and crosses it once the
// white point stretches the image - which is the whole point, since a
// stretched image reads as MORE detailed, not less.
function makePhotographedPage(): ImageData {
    const size = 600;
    return makeImageData(size, size, (x, y) => {
        if (x >= 200 && x < 400 && y >= 200 && y < 400) return [70, 70, 70, 255];
        const v = Math.round(130 + 0.5 * (x % 40));
        return [v, v, v, 255];
    });
}

// Warm to cool and back at a constant luminance: converted to grey it is a
// blank field, and the colour filter is what puts a gradient in it. The
// ginger-cat-on-a-hedge case, reduced to something measurable.
function makeConstantLuminanceHueRamp(): ImageData {
    const size = 600;
    const luminance = 140;
    return makeImageData(size, size, (x) => {
        const t = (x % 60) / 60;
        const r = 60 + t * 140;
        const b = 200 - t * 140;
        // Rec.601, matching grayscale.ts's pixelLuminance - a different set of
        // coefficients here would leave a real gradient behind and the grey
        // reading would stop being blank.
        const g = (luminance - 0.299 * r - 0.114 * b) / 0.587;
        return [Math.round(r), Math.round(g), Math.round(b), 255];
    });
}

test("estimateAndRecommend: the estimates are built on the prepared image, not the one handed in", () => {
    const page = makePhotographedPage();

    const prepared = estimateAndRecommend(page, { deviceFactor: 1 });
    const unprepared = estimateAndRecommend(page, { deviceFactor: 1, whitePoint: 1, warmth: 0 });

    assert.ok(prepared.recommendations.whitePoint.value < 1,
        "fixture sanity: this image should ask for a white point in the first place");
    assert.ok(prepared.processing.estimatedShapeCount > unprepared.processing.estimatedShapeCount * 1.5,
        `the white point stretches the image's contrast, so the render has more to trace: ${unprepared.processing.estimatedShapeCount} vs ${prepared.processing.estimatedShapeCount}`);
    assert.ok(prepared.processing.totalSeconds > unprepared.processing.totalSeconds,
        "and that costs more processing time, which is what the estimate is for");
});

test("estimateAndRecommend: the recommendations still describe the image as handed in", () => {
    // Asking "is anything here bright enough to read as paper" of an image
    // whose white point has already been set would answer itself.
    const page = makePhotographedPage();

    const prepared = estimateAndRecommend(page, { deviceFactor: 1 });
    const unprepared = estimateAndRecommend(page, { deviceFactor: 1, whitePoint: 1, warmth: 0 });

    assert.equal(prepared.characteristics.paperLuminance, unprepared.characteristics.paperLuminance);
    assert.equal(prepared.recommendations.whitePoint.value, unprepared.recommendations.whitePoint.value);
    assert.ok(prepared.characteristics.paperLuminance < 0.92,
        "the reported characteristics are of the photograph, not of the lifted copy");
});

test("estimateAndRecommend: the colour filter reaches the estimate, and is dropped where the render drops it", () => {
    const ramp = makeConstantLuminanceHueRamp();

    const grey = estimateAndRecommend(ramp, { deviceFactor: 1, colorCount: 1, whitePoint: 1, warmth: 0 });
    const filtered = estimateAndRecommend(ramp, { deviceFactor: 1, colorCount: 1, whitePoint: 1, warmth: 0.6 });
    assert.ok(filtered.processing.estimatedShapeCount > grey.processing.estimatedShapeCount * 2,
        `the filter turns a blank grey field into a ramp with detail in it: ${grey.processing.estimatedShapeCount} vs ${filtered.processing.estimatedShapeCount}`);

    // Same option, colour path: preparationFor drops it, so the estimate must
    // not move either - or it would be costing a render that never happens.
    const colourFiltered = estimateAndRecommend(ramp, { deviceFactor: 1, colorCount: 3, whitePoint: 1, warmth: 0.6 });
    const colourPlain = estimateAndRecommend(ramp, { deviceFactor: 1, colorCount: 3, whitePoint: 1, warmth: 0 });
    assert.equal(colourFiltered.processing.totalSeconds, colourPlain.processing.totalSeconds);
});
