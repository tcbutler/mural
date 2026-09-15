import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { despeckleMmForPixels, despecklePixels } from "../src/despeckle";

// The bug the unit exists to kill: the same pixel threshold means wildly
// different things on the same drawing, depending only on how large the source
// file is. Both of these are a 400mm plot of the same picture.
const FINE = { rasterWidthPx: 2400, drawWidthMm: 400 };   // 0.167mm per pixel
const COARSE = { rasterWidthPx: 600, drawWidthMm: 400 };  // 0.667mm per pixel

test("the same millimetre setting survives a change of source resolution", () => {
    // Not equal in pixels - they cannot be, the pixels are different sizes -
    // but the physical size they stand for has to come back the same.
    const fine = despecklePixels(1.5, FINE.rasterWidthPx, FINE.drawWidthMm);
    const coarse = despecklePixels(1.5, COARSE.rasterWidthPx, COARSE.drawWidthMm);

    assert.ok(fine > coarse * 10, `a finer raster needs far more pixels for the same speck: ${coarse} vs ${fine}`);
    for (const [px, source] of [[fine, FINE], [coarse, COARSE]] as const) {
        const backInMm = despeckleMmForPixels(px, source.rasterWidthPx, source.drawWidthMm);
        assert.ok(Math.abs(backInMm - 1.5) < 0.05, `round trip gave ${backInMm.toFixed(2)}mm`);
    }
});

test("a fixed pixel threshold is what used to slide, and this says by how much", () => {
    // 20 pixels of area, the old default's neighbourhood, read back as a size.
    const onFine = despeckleMmForPixels(20, FINE.rasterWidthPx, FINE.drawWidthMm);
    const onCoarse = despeckleMmForPixels(20, COARSE.rasterWidthPx, COARSE.drawWidthMm);

    assert.ok(onCoarse > onFine * 3.5,
        `the same setting meant ${onFine.toFixed(2)}mm on one image and ${onCoarse.toFixed(2)}mm on the other`);
});

test("a bigger speck costs more pixels, and the growth is quadratic", () => {
    const small = despecklePixels(1, FINE.rasterWidthPx, FINE.drawWidthMm);
    const double = despecklePixels(2, FINE.rasterWidthPx, FINE.drawWidthMm);

    assert.ok(Math.abs(double / small - 4) < 0.1, `doubling the width should quadruple the area, got ${(double/small).toFixed(2)}x`);
});

test("nothing to convert with means keep everything, rather than a guess", () => {
    assert.equal(despecklePixels(0, 2400, 400), 0);
    assert.equal(despecklePixels(1.5, 0, 400), 0);
    assert.equal(despecklePixels(1.5, 2400, 0), 0);
    assert.equal(despeckleMmForPixels(0, 2400, 400), 0);
});

test("without a plot size it falls back to the estimator's default rather than refusing", () => {
    // The standalone callers - the bench, the gallery tool - do not know the
    // physical size, and a despeckle of zero there would be a silent change of
    // behaviour rather than a sensible default.
    assert.ok(despecklePixels(1.5, 2400) > 0);
});
