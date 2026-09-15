// Despeckle, in millimetres on the paper rather than pixels in the source.
//
// Potrace's own parameter (`turdsize`, vectorizer.ts's traceBitmap) is an AREA
// IN SOURCE PIXELS: a traced region smaller than that is dropped. That is the
// right unit for the tracer and the wrong one for the person setting it,
// because a source pixel has no fixed size on the paper. The same despeckle
// setting means different things for the same picture depending only on how
// large the image file happens to be:
//
//     a 600px raster on a 400mm plot     one pixel is 0.67mm
//     a 2400px raster on a 400mm plot    one pixel is 0.17mm
//
// So a threshold of 20 pixels of area is a 3mm speck on the first and a 0.7mm
// speck on the second - a sixteen-fold difference in what survives, from a
// control the user did not touch. Measured on a four-level trace of a
// photograph at 2400px, a despeckle of 20 still left 264 specks under a
// millimetre across, which is why the setting looked broken: it was being read
// as "drop almost nothing".
//
// This module takes the size the user actually cares about - how small a mark
// may be before it is not worth drawing, measured across, in millimetres - and
// converts it for the tracer.
import { DEFAULT_DRAW_WIDTH_MM } from './costEstimator';

// Specks are not square, so their area is some fraction of the square of their
// width. A circle is pi/4, a diagonal sliver much less. Three quarters sits
// near the round end of that range, which errs toward keeping a mark rather
// than dropping it.
const AREA_PER_SPAN_SQUARED = 0.75;

/**
 * Potrace's pixel-area threshold for a given physical speck size.
 *
 * `despeckleMm` is measured ACROSS the speck, so it can be compared directly
 * with a nib width or read off a ruler. Returns 0 (keep everything) for a
 * request that cannot be converted - no size, no raster - rather than guessing.
 */
export function despecklePixels(
    despeckleMm: number,
    rasterWidthPx: number,
    drawWidthMm: number = DEFAULT_DRAW_WIDTH_MM,
): number {
    if (!(despeckleMm > 0) || !(rasterWidthPx > 0) || !(drawWidthMm > 0)) {
        return 0;
    }

    const mmPerPixel = drawWidthMm / rasterWidthPx;
    const spanInPixels = despeckleMm / mmPerPixel;
    return Math.max(0, Math.round(AREA_PER_SPAN_SQUARED * spanInPixels * spanInPixels));
}

/**
 * The physical size a pixel-area threshold corresponds to - the inverse of the
 * above, for reading an old setting back in the units it should have been in.
 */
export function despeckleMmForPixels(
    turdSizePixels: number,
    rasterWidthPx: number,
    drawWidthMm: number = DEFAULT_DRAW_WIDTH_MM,
): number {
    if (!(turdSizePixels > 0) || !(rasterWidthPx > 0) || !(drawWidthMm > 0)) {
        return 0;
    }

    const mmPerPixel = drawWidthMm / rasterWidthPx;
    return Math.sqrt(turdSizePixels / AREA_PER_SPAN_SQUARED) * mmPerPixel;
}
