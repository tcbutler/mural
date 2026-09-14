import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeImageCharacteristics } from "../src/imageCharacteristics";

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

// A handful of solid rectangular blocks of distinct, saturated colors -
// the archetypal "flat/vector-style art" fixture (a few dominant colors,
// large uniform regions, sharp boundaries between them).
function makeFlatVectorImage(): ImageData {
    const width = 200, height = 200;
    const colors: [number, number, number][] = [
        [230, 30, 30],
        [30, 200, 60],
        [40, 60, 230],
        [250, 220, 20],
    ];
    return makeImageData(width, height, (x, y) => {
        const col = Math.floor((x / width) * 2);
        const row = Math.floor((y / height) * 2);
        const [r, g, b] = colors[row * 2 + col];
        return [r, g, b, 255];
    });
}

// A smooth radial luminance/hue gradient with a touch of per-pixel noise -
// the archetypal "continuous-tone/photographic" fixture: tone varies
// gradually everywhere, no large flat regions, no small set of dominant
// colors.
function makeContinuousToneImage(): ImageData {
    const width = 200, height = 200;
    let seed = 42;
    const noise = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed % 21) - 10;
    };
    return makeImageData(width, height, (x, y) => {
        const dx = x - width / 2;
        const dy = y - height / 2;
        const dist = Math.sqrt(dx * dx + dy * dy) / (width / 2);
        const base = Math.max(0, Math.min(255, Math.round(255 * (1 - dist))));
        const r = Math.max(0, Math.min(255, base + noise()));
        const g = Math.max(0, Math.min(255, Math.round(base * 0.8) + noise()));
        const b = Math.max(0, Math.min(255, Math.round(base * 0.6) + noise()));
        return [r, g, b, 255];
    });
}

test("analyzeImageCharacteristics: classifies an obviously-flat synthetic image as 'flat'", () => {
    const characteristics = analyzeImageCharacteristics(makeFlatVectorImage());
    assert.equal(characteristics.classification, "flat");
    assert.ok(characteristics.flatFraction > 0.7, `expected mostly-flat sampled cells, got flatFraction=${characteristics.flatFraction}`);
    assert.ok(characteristics.colorConcentration > 0.8, `expected high color concentration, got ${characteristics.colorConcentration}`);
    assert.ok(characteristics.estimatedDistinctColors <= 6);
});

test("analyzeImageCharacteristics: classifies an obviously-continuous-tone synthetic image as 'continuous-tone'", () => {
    const characteristics = analyzeImageCharacteristics(makeContinuousToneImage());
    assert.equal(characteristics.classification, "continuous-tone");
    assert.ok(characteristics.midToneFraction > 0.4, `expected a lot of gradual shading, got midToneFraction=${characteristics.midToneFraction}`);
});

test("analyzeImageCharacteristics: the two fixtures land on opposite sides of the classification threshold with a clear margin", () => {
    const flat = analyzeImageCharacteristics(makeFlatVectorImage());
    const photo = analyzeImageCharacteristics(makeContinuousToneImage());
    assert.ok(photo.continuousToneScore - flat.continuousToneScore > 0.3, `expected a clear separation, got flat=${flat.continuousToneScore} photo=${photo.continuousToneScore}`);
});

test("analyzeImageCharacteristics: fully transparent image doesn't throw and reads as flat", () => {
    const blank = makeImageData(50, 50, () => [0, 0, 0, 0]);
    const characteristics = analyzeImageCharacteristics(blank);
    assert.equal(characteristics.opaqueFraction, 0);
    assert.equal(characteristics.classification, "flat");
});

// A soft drop shadow: black stored at a low alpha over bare paper. On the
// page it is a pale grey, and grayscale.ts judges it that way when deciding
// what to trace. The analyser used to read the stored RGB instead, so it saw
// near-black where the renderer saw 8% grey - the same image, described two
// different ways depending on which module you asked.
function makeSoftShadowImage(): ImageData {
    const width = 200, height = 200;
    return makeImageData(width, height, (x, y) => {
        if (x < width / 2) return [255, 255, 255, 255];   // bare paper
        return [0, 0, 0, 20];                              // shadow: 8% grey on paper
    });
}

test("analyzeImageCharacteristics judges a pixel as it lands on the paper", () => {
    const c = analyzeImageCharacteristics(makeSoftShadowImage());

    // Composited, the shadow is a pale grey against white: a mild edge down
    // the middle and flat either side of it. Read as stored black-on-white it
    // would be a maximum-contrast boundary instead.
    assert.ok(c.flatFraction > 0.9,
        `a pale shadow beside bare paper should read as almost entirely flat, got ${c.flatFraction}`);
    assert.equal(c.edgeFraction, 0,
        'an 8% grey step is not a hard edge once composited over the paper');
});

test("a fully transparent pixel still reads as paper, not as its stored colour", () => {
    // Stored black but invisible: the machine draws nothing there.
    const c = analyzeImageCharacteristics(makeImageData(100, 100, () => [0, 0, 0, 0]));
    assert.equal(c.opaqueFraction, 0);
    assert.equal(c.edgeFraction, 0, 'blank paper has no edges');
});
