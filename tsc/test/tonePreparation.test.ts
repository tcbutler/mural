import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { needsPreparation, prepareTone, preparationFor } from "../src/tonePreparation";
import { pixelLuminance } from "../src/grayscale";

function makeImageData(pixels: [number, number, number, number][]): ImageData {
    const data = new Uint8ClampedArray(pixels.length * 4);
    pixels.forEach(([r, g, b, a], i) => {
        data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
    });
    return { data, width: pixels.length, height: 1, colorSpace: "srgb" } as unknown as ImageData;
}

function lumAt(img: ImageData, i: number): number {
    const d = img.data;
    return pixelLuminance(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
}

test("needsPreparation: both settings at their no-op values means no copy", () => {
    assert.equal(needsPreparation({}), false);
    assert.equal(needsPreparation({ whitePoint: 1, warmth: 0 }), false);
    assert.equal(needsPreparation({ whitePoint: 0.87 }), true);
    assert.equal(needsPreparation({ warmth: 0.6 }), true);
});

test("prepareTone leaves the source untouched", () => {
    const src = makeImageData([[120, 60, 30, 255]]);
    const before = Array.from(src.data);
    prepareTone(src, { whitePoint: 0.8, warmth: 0.6 });
    assert.deepEqual(Array.from(src.data), before);
});

test("a white point lifts the image's own paper to actual white", () => {
    // A photographed page: its paper reads 87% rather than white, and the ink
    // on it is darker still.
    const photo = makeImageData([[222, 222, 222, 255], [90, 90, 90, 255]]);
    const out = prepareTone(photo, { whitePoint: 222 / 255 });

    assert.equal(lumAt(out, 0), 255, 'the page itself should end up as bare paper');
    assert.ok(lumAt(out, 1) > 90, 'the ink lifts with it, keeping their relationship');
    assert.ok(lumAt(out, 1) < 255, 'but the ink is still ink');
});

test("warmth darkens a warm subject relative to a cool background of the same brightness", () => {
    // The case a plain grey conversion cannot represent: a ginger subject and
    // a green background that happen to share a luminance.
    const ginger: [number, number, number, number] = [160, 100, 40, 255];
    const green: [number, number, number, number] = [90, 125, 70, 255];
    const src = makeImageData([ginger, green]);

    const plain = prepareTone(src, { warmth: 0 });
    const filtered = prepareTone(src, { warmth: 0.6 });

    const plainGap = lumAt(plain, 0) - lumAt(plain, 1);
    assert.ok(Math.abs(plainGap) < 10,
        `unfiltered these are nearly the same grey (gap ${plainGap.toFixed(1)}), which is the problem`);

    const filteredGap = lumAt(filtered, 0) - lumAt(filtered, 1);
    assert.ok(filteredGap < -25,
        `the filter should push the warm one clearly darker, got ${filteredGap.toFixed(1)}`);
});

test("warmth converts to neutral grey rather than leaving a colour behind", () => {
    const out = prepareTone(makeImageData([[160, 100, 40, 255]]), { warmth: 0.6 });
    const d = out.data;
    assert.equal(d[0], d[1]);
    assert.equal(d[1], d[2]);
});

test("a white point scales every channel alike, so hues do not shift", () => {
    const out = prepareTone(makeImageData([[200, 100, 50, 255]]), { whitePoint: 0.8 });
    const d = out.data;
    // Ratios preserved: the colour gets brighter, not different.
    assert.ok(Math.abs(d[0] / d[1] - 2) < 0.05);
    assert.ok(Math.abs(d[1] / d[2] - 2) < 0.05);
});

test("transparent pixels stay paper, whatever colour they store", () => {
    const out = prepareTone(makeImageData([[0, 0, 0, 0]]), { whitePoint: 0.8, warmth: 0.6 });
    assert.equal(out.data[3], 0, 'still transparent');
    assert.equal(out.data[0], 255, 'and reading as paper, not as the black it stores');
});

test("partial alpha is composited before anything else looks at it", () => {
    // Black at alpha 20 is a pale grey on the page, not near-black.
    const out = prepareTone(makeImageData([[0, 0, 0, 20]]), {});
    assert.ok(lumAt(out, 0) > 200,
        `a soft shadow should stay pale, got ${lumAt(out, 0).toFixed(1)}`);
});

test("preparationFor: warmth is dropped on the colour path, which has the hue already", () => {
    const grey = preparationFor({ warmth: 0.6, whitePoint: 0.9 });
    assert.equal(grey.warmth, 0.6, 'a tonal render needs the filter');

    const colour = preparationFor({ warmth: 0.6, whitePoint: 0.9, colorCount: 4 });
    assert.equal(colour.warmth, 0, 'a colour separation separates by hue, so the filter would only flatten it');
    assert.equal(colour.whitePoint, 0.9, 'the white point still applies - paper is paper either way');
});

test("preparationFor: a single-colour request is a tonal render, not a colour one", () => {
    assert.equal(preparationFor({ warmth: 0.6, colorCount: 1 }).warmth, 0.6);
});
