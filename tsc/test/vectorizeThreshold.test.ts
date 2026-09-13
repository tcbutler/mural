/**
 * Tests for the background threshold in src/vectorizer.ts's single-colour
 * (1-bit) path.
 *
 * The bug: the ink test was exact equality against pure white, so anything that
 * was not precisely #FFFFFF traced as ink. Harmless for an SVG rasterised in the
 * browser, where only anti-aliased edge pixels land near-white. Destructive for
 * a lossy photo: a JPEG's white background sits at 250-254 and varies per 8x8
 * DCT block, so the whole background became ink and the traced contour followed
 * the compressor's block grid. Same stamp artwork, PNG vs JPEG: 901 pen lifts
 * against 3309.
 */
import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_LUMINANCE_THRESHOLD, buildGrayscaleBitmap } from "../src/grayscale";

function makeImageData(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            const [r, g, b, a] = fill(x, y);
            data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
        }
    }
    return { data, width, height, colorSpace: "srgb" } as unknown as ImageData;
}

// The same classification vectorizeImageData performs, without running potrace.
function inkPixels(image: ImageData): number {
    return buildGrayscaleBitmap(image, BACKGROUND_LUMINANCE_THRESHOLD)
        .reduce((total: number, bit) => total + bit, 0);
}

test("a JPEG-style near-white background is background, not ink", () => {
    // 250-254 per 8x8 block, which is what lossy compression leaves behind.
    const image = makeImageData(64, 64, (x, y) => {
        const blockNoise = ((Math.floor(x / 8) + Math.floor(y / 8)) % 5);
        return [250 + blockNoise, 250 + blockNoise, 250 + blockNoise, 255];
    });
    assert.equal(inkPixels(image), 0);
});

test("pure white is still background", () => {
    const image = makeImageData(16, 16, () => [255, 255, 255, 255]);
    assert.equal(inkPixels(image), 0);
});

test("fully transparent pixels are still background whatever their colour", () => {
    const image = makeImageData(16, 16, () => [0, 0, 0, 0]);
    assert.equal(inkPixels(image), 0);
});

test("real ink is still ink, including pale tones well inside the threshold", () => {
    // The stamp's red, and a light grey a drawing might legitimately use.
    for (const colour of [[206, 32, 39], [0, 0, 0], [200, 200, 200]] as const) {
        const image = makeImageData(16, 16, () => [colour[0], colour[1], colour[2], 255]);
        assert.equal(inkPixels(image), 256, `expected ${colour.join(",")} to trace as ink`);
    }
});

test("the threshold sits at 92% brightness, and classification turns over there", () => {
    assert.equal(BACKGROUND_LUMINANCE_THRESHOLD, 0.92 * 255);

    const grey = (v: number) => makeImageData(4, 4, () => [v, v, v, 255]);
    // 234 is at/below the 234.6 threshold, 235 is above it.
    assert.equal(inkPixels(grey(234)), 16);
    assert.equal(inkPixels(grey(235)), 0);
});

test("an anti-aliased edge against white keeps its shape", () => {
    // Left half solid black, one blended column, right half white - the SVG
    // rasterisation case the exact-white test used to handle acceptably. The
    // blend column is mid-grey, so it must still read as ink.
    const image = makeImageData(9, 4, (x) => {
        if (x < 4) return [0, 0, 0, 255];
        if (x === 4) return [128, 128, 128, 255];
        return [255, 255, 255, 255];
    });
    assert.equal(inkPixels(image), 4 * 5);
});

// --- Transparency -----------------------------------------------------------
//
// Reported as "the tracer is doing a bad job of this image now", on a cartoon
// PNG with a transparent background and a soft drop shadow: the whole
// background came out hatched. The ink test was `a > 0 && luminance(r,g,b)`,
// which judges the stored colour rather than the colour on the paper, so a
// shadow stored as black at alpha 20 read as solid black.

test("a fully transparent pixel is background whatever colour is stored under it", () => {
    for (const colour of [[0, 0, 0], [255, 255, 255], [122, 176, 224]] as const) {
        const image = makeImageData(8, 8, () => [colour[0], colour[1], colour[2], 0]);
        assert.equal(inkPixels(image), 0, `expected transparent ${colour.join(",")} to be background`);
    }
});

test("a soft shadow reads as the grey it looks like, not as the black it stores", () => {
    // Black at 8% opacity over white paper is a very light grey: it should not
    // be drawn. Before compositing this was luminance 0 - maximum ink.
    const image = makeImageData(8, 8, () => [0, 0, 0, 20]);
    assert.equal(inkPixels(image), 0);
});

test("a half-opaque black still reads as ink", () => {
    // 50% black over white is mid-grey, well below the threshold, and should
    // still be drawn - compositing must not simply discard everything with alpha.
    const image = makeImageData(8, 8, () => [0, 0, 0, 128]);
    assert.equal(inkPixels(image), 64);
});

test("opaque pixels are unaffected by compositing", () => {
    const opaqueDark = makeImageData(8, 8, () => [40, 40, 40, 255]);
    const opaqueWhite = makeImageData(8, 8, () => [255, 255, 255, 255]);
    assert.equal(inkPixels(opaqueDark), 64);
    assert.equal(inkPixels(opaqueWhite), 0);
});
