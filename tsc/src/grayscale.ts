// Pure luminance-quantization helpers for the vectorizer's grayscale/tonal
// mode. Deliberately free of any `paper` dependency (unlike the rest of this
// package, which loads `paper` at module scope via paperLoader.ts) so this
// logic can run - and be unit tested - without a DOM/canvas environment.

// Level 1 is the lightest/most inclusive threshold; level `levels` is the
// darkest/least inclusive. Because the returned threshold decreases
// monotonically as `level` increases, buildGrayscaleBitmap's output for
// level N is always a subset of level (N - 1)'s output, i.e. traced regions
// nest inside one another.
export function computeGrayscaleThreshold(level: number, levels: number): number {
    return 255 * (levels - level + 1) / (levels + 1);
}

// Pixels at least this bright are background rather than ink.
//
// This test used to be exact equality against pure white. That is harmless for
// an SVG rasterised in the browser - only anti-aliased edge pixels land
// near-white, so an edge gains a pixel and nobody notices. It is destructive for
// a lossy photo: a JPEG's white background sits at 250-254 and varies per 8x8
// DCT block, so every one of those pixels was ink and the traced contour
// followed the compressor's block grid instead of the artwork. Measured on one
// stamp image saved both ways - 0% of the PNG was near-white-but-not-white
// against 21.6% of the JPEG, and the JPEG traced to 3309 pen lifts where the
// PNG needed 901.
//
// Fixed at 92% of full brightness rather than derived from the image. An
// adaptive threshold (Otsu and friends) suits a photograph but can promote a
// pale drawing's mid-tones to ink with nothing in the UI having changed, and a
// predictable cut-off is worth more here than an optimal one.
export const BACKGROUND_LUMINANCE_THRESHOLD = 0.92 * 255;

export function pixelLuminance(r: number, g: number, b: number): number {
    return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Luminance of a pixel as it would appear on the paper: composited over white.
 *
 * The machine draws on white paper, so that is what anything not fully opaque is
 * seen against. Judging the stored RGB directly - which is what this did, gated
 * only on `a > 0` - reads a soft drop shadow stored as black at alpha 20 as
 * solid black rather than as the 8% grey it actually looks like, and traces it
 * as ink. On a cartoon PNG with a transparent background and a soft shadow, that
 * turned two thirds of the image into something to draw.
 *
 * Fully transparent pixels come out at exactly 255, so they remain background
 * without needing a special case.
 */
export function compositedLuminance(r: number, g: number, b: number, a: number): number {
    const opacity = a / 255;
    return pixelLuminance(r, g, b) * opacity + 255 * (1 - opacity);
}

export function isPixelAtOrDarkerThanThreshold(r: number, g: number, b: number, a: number, threshold: number): boolean {
    return compositedLuminance(r, g, b, a) <= threshold;
}

// Builds the 1-bit bitmap for a single grayscale level: pixels at or darker
// than `threshold` (and not fully transparent) trace to 1, everything else
// (including pure white and transparent background) traces to 0.
export function buildGrayscaleBitmap(imageData: ImageData, threshold: number): (1|0)[] {
    const data: (1|0)[] = [];
    const pixelCount = imageData.width * imageData.height;
    for (let i = 0; i < pixelCount; i++) {
        const address = i * 4;
        const r = imageData.data[address];
        const g = imageData.data[address + 1];
        const b = imageData.data[address + 2];
        const a = imageData.data[address + 3];
        data.push(isPixelAtOrDarkerThanThreshold(r, g, b, a, threshold) ? 1 : 0);
    }
    return data;
}
