// What the image is asking for, in ink.
//
// The fill strategies are handed a traced region and asked to fill it. The
// scribble algorithms are handed the picture itself and asked to draw it, so
// the first thing they need is a map of how much ink each part of the paper
// wants. That map is what this module makes.
//
// Deliberately paper.js-free, like the rest of scribble/: the algorithms are
// arithmetic over a grid, and keeping them free of the geometry engine means
// they can be unit tested without the native canvas binding.
import { pixelLuminance } from '../grayscale';

export type DemandMap = {
    width: number;
    height: number;
    /** Ink coverage wanted at each pixel, 0 (bare paper) to 1 (solid). */
    demand: Float32Array;
    /** Millimetres on the paper per demand-map pixel. */
    mmPerPixel: number;
};

// Working resolution, in map pixels per millimetre of paper.
//
// Physical rather than a pixel count, for the same reason despeckle is: the
// algorithms choose where to put strokes several millimetres long, and what
// they can act on is set by the paper, not by how large the image file happens
// to be. A source raster can be 2400px and none of that detail survives a pen
// 1.2mm wide.
//
// The prototypes these algorithms come from (tools/scribble/) worked at one
// pixel per millimetre and every constant in them was tuned there, so this
// sits just above that: fine enough that a stroke's endpoints land where they
// were chosen, coarse enough that the residual buffer stays small.
export const DEFAULT_PIXELS_PER_MM = 1.5;

// However large the plot, the working map stops growing. A 2m mural at 1.5
// px/mm would be 3000px across and 9 megapixels of residual buffer, for a
// drawing whose strokes are still centimetres long.
export const MAX_WORKING_LONG_EDGE_PX = 1600;

// A pen drawing wants a good deal of bare paper left showing.
//
// This is a CEILING on the average ink demand, not a target. Treating it as a
// target darkened every light image up to the budget: twenty minutes of extra
// plotting to make a picture heavier than it was asked to be. An image that
// naturally wants less ink is left alone.
export const DEFAULT_INK_CEILING = 0.22;

/**
 * The working map's dimensions for a given source and plot size.
 *
 * Its own function because the pre-render estimate has to know the map the
 * render is going to build (scribble/projection.ts) - every cost in these
 * algorithms is per map pixel - and a second copy of this arithmetic would be
 * a second thing to keep in step.
 */
export function demandMapSize(
    sourceWidthPx: number,
    sourceHeightPx: number,
    drawWidthMm: number,
    pixelsPerMm = DEFAULT_PIXELS_PER_MM,
): { width: number; height: number } {
    // Wanted width from the paper, then capped, then never upsampled: asking
    // for more pixels than the source has would invent detail rather than read
    // it.
    const aspect = Math.max(0, sourceHeightPx) / Math.max(1, sourceWidthPx);
    const cap = Math.min(MAX_WORKING_LONG_EDGE_PX, MAX_WORKING_LONG_EDGE_PX / Math.max(1, aspect));
    const wantedWidth = Math.min(Math.max(0, drawWidthMm) * pixelsPerMm, cap);
    const width = Math.max(1, Math.round(Math.min(wantedWidth, Math.max(1, sourceWidthPx))));
    return { width, height: Math.max(1, Math.round(width * aspect)) };
}

export type DemandOptions = {
    /** Physical width of the plot, in mm - what makes stroke lengths mean anything. */
    drawWidthMm: number;
    /** Working resolution, in map pixels per mm of paper. */
    pixelsPerMm?: number;
    /** Ceiling on the average ink demand. */
    inkCeiling?: number;
};

// Bisection steps the gamma solve takes. Exported because the pre-render
// estimate has to charge for them - at a full pass over the map each, they are
// most of what building a demand map costs (processingEstimator.ts).
export const GAMMA_SOLVE_ITERATIONS = 28;

/**
 * Gamma that brings the mean of `values ** gamma` down to `target`.
 *
 * Bounded at both ends on purpose, and the bounds are what make this a budget
 * rather than a rule. Below 1 the gamma would DARKEN an image already lighter
 * than the budget, spending plot time to make the picture worse. Above 4 it
 * would crush every mid-tone out of a genuinely dark picture in order to hit a
 * number: a half-black page cannot reach a 0.2 ceiling by gamma alone, and the
 * right answer there is a darker drawing, not a flat one.
 */
export function solveInkGamma(values: Float32Array, target: number, iterations = GAMMA_SOLVE_ITERATIONS): number {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[i];
    const mean = sum / Math.max(1, values.length);
    if (mean <= 1e-6 || mean <= target) {
        return 1;
    }

    let lo = 1;
    let hi = 4;
    for (let i = 0; i < iterations; i++) {
        const mid = 0.5 * (lo + hi);
        let raised = 0;
        for (let j = 0; j < values.length; j++) raised += Math.pow(values[j], mid);
        if (raised / values.length > target) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

/**
 * Ink demand for an image, at a working resolution the algorithms can afford.
 *
 * The raster is expected to have been through tonePreparation.ts already - the
 * white point and the colour filter decide what the tones ARE, and this module
 * only reads them.
 */
export function inkDemand(imageData: ImageData, options: DemandOptions): DemandMap {
    const pixelsPerMm = options.pixelsPerMm ?? DEFAULT_PIXELS_PER_MM;
    const inkCeiling = options.inkCeiling ?? DEFAULT_INK_CEILING;

    const { width, height } = demandMapSize(imageData.width, imageData.height, options.drawWidthMm, pixelsPerMm);

    const demand = new Float32Array(width * height);
    const source = imageData.data;

    // Box-average each output pixel over the source pixels it covers, rather
    // than sampling one of them. A photograph's grain is exactly the signal
    // that point sampling turns into noise, and noise in the demand map becomes
    // strokes in the drawing.
    const xStep = imageData.width / width;
    const yStep = imageData.height / height;

    for (let y = 0; y < height; y++) {
        const y0 = Math.floor(y * yStep);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * yStep));
        for (let x = 0; x < width; x++) {
            const x0 = Math.floor(x * xStep);
            const x1 = Math.max(x0 + 1, Math.floor((x + 1) * xStep));

            let total = 0;
            let count = 0;
            for (let sy = y0; sy < y1 && sy < imageData.height; sy++) {
                for (let sx = x0; sx < x1 && sx < imageData.width; sx++) {
                    const p = (sy * imageData.width + sx) * 4;
                    const alpha = source[p + 3];
                    // Transparent is paper, and paper asks for nothing - the
                    // same convention vectorizer.ts and grayscale.ts use.
                    if (alpha === 0) {
                        count++;
                        continue;
                    }
                    const opacity = alpha / 255;
                    const r = source[p] * opacity + 255 * (1 - opacity);
                    const g = source[p + 1] * opacity + 255 * (1 - opacity);
                    const b = source[p + 2] * opacity + 255 * (1 - opacity);
                    total += 1 - pixelLuminance(r, g, b) / 255;
                    count++;
                }
            }
            demand[y * width + x] = count > 0 ? total / count : 0;
        }
    }

    const gamma = solveInkGamma(demand, inkCeiling);
    if (gamma > 1) {
        for (let i = 0; i < demand.length; i++) {
            demand[i] = Math.pow(demand[i], gamma);
        }
    }

    return { width, height, demand, mmPerPixel: options.drawWidthMm / width };
}

/**
 * Ink LENGTH each pixel is owed, per unit area, for a wanted coverage.
 *
 * Ink landing on ink covers no new paper, so a region asking for 90% coverage
 * needs far more than 0.9 units of line through it. The Poisson law
 * cycloidPath.ts derives its advance rate from inverts the same way here:
 * coverage = 1 - exp(-length), so length = -ln(1 - coverage).
 *
 * Without this the walk under-inks every dark region - it pays off a black
 * area as though a single pass over it were enough, and moves on.
 */
export function inkLengthFor(coverage: number, ceiling = 0.985): number {
    const clamped = Math.min(ceiling, Math.max(0, coverage));
    return -Math.log(Math.max(1e-6, 1 - clamped));
}
