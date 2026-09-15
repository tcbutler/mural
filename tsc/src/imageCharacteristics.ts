// Cheap, paper.js-free statistics over a source ImageData, used by
// smartDefaults.ts to distinguish "flat/vector-ish art" (a handful of
// solid regions, sharp boundaries - e.g. a logo, a cartoon, clip art) from
// "continuous-tone/photographic" content (smoothly varying tone and color
// everywhere, few if any truly flat regions), and to feed
// processingEstimator.ts's `complexity` input.
//
// Deliberately independent of vectorizer.ts/paper.js (same reasoning as
// imageGradient.ts - see that file's header): this only ever touches raw
// ImageData and plain numbers/typed arrays, so it runs anywhere, including
// in this repo's Node test environment without a compiled `canvas` addon.
export type ImageCharacteristics = {
    widthPx: number;
    heightPx: number;
    // Fraction of pixels that are non-transparent.
    opaqueFraction: number;
    // 0..1. Higher means color content is concentrated in a small number of
    // dominant colors (few, saturated buckets hold most pixels) - the
    // signature of flat/vector-ish art, which by construction has a small
    // number of distinct fill colors. Lower means color is spread broadly
    // across many buckets - continuous tone/photographic content.
    colorConcentration: number;
    // Rough count of "dominant" colors - histogram buckets each holding at
    // least DOMINANT_BUCKET_MIN_SHARE of opaque pixels. A reasonable proxy
    // for "how many pens would a human pick for this image".
    estimatedDistinctColors: number;
    // Fraction of sampled cells with ~zero local luminance gradient - large
    // uniform regions. High for flat art (broad solid fills), low for
    // photos (continuous tone rarely sits perfectly flat).
    flatFraction: number;
    // Fraction of sampled cells with a strong local luminance gradient -
    // hard edges. Both flat art (crisp boundaries) and photos (real edges)
    // have some of this, so this alone doesn't separate them - see
    // midToneFraction below, which is the more telling signal.
    edgeFraction: number;
    // Fraction of sampled cells that are neither flat nor a hard edge -
    // i.e. genuinely gradual shading. This is the strongest single signal
    // for continuous-tone content: flat art has almost none of it (a
    // region is either a solid fill or a boundary between two solid
    // fills), photos are dominated by it (soft shading, gradients,
    // texture).
    midToneFraction: number;
    // 0 (flat/vector-ish) .. 1 (continuous-tone/photographic) - the single
    // blended score smartDefaults.ts branches its recommendations on. See
    // computeContinuousToneScore's own comment for the exact formula/why.
    continuousToneScore: number;
    classification: 'flat' | 'continuous-tone';

    // --- what the image offers a tone-driven render -------------------
    //
    // The fields above describe how to draw. These describe what there is to
    // draw from, which is a different question and the one a photograph
    // fails on. A phone photo of a page has no true white in it anywhere:
    // the paper meters as a mid grey, and anything that maps tone to ink
    // then inks the whole background.

    // Fraction of the frame already bright enough to leave as bare paper.
    // Near zero means a white point has to be chosen or the render comes
    // back as a grey rectangle.
    whiteHeadroom: number;
    // Mean ink coverage the image would ask for if tone mapped straight to
    // density. Drives how expensive a dense hatch actually is: at the same
    // density setting a dark photograph costs several times what a light one
    // does, which nothing in the recommendations used to notice.
    meanDarkness: number;
    // Mean ink LENGTH the image asks for, per unit area - the same tone read
    // through the coverage law rather than straight (scribble/demand.ts's
    // inkLengthFor). Ink landing on ink covers no new paper, so a region
    // wanting 90% coverage needs far more than 0.9 units of line through it,
    // and that transform is convex: this is nowhere near inkLengthFor of
    // meanDarkness, and the difference is a factor of two on a picture whose
    // darkness sits in a few strong areas. It is what the mark-making modes
    // are paying off, so it is what their cost projection is built on
    // (scribble/projection.ts).
    meanInkDemand: number;
    // Luminance of the image's brightest real tone (98th percentile, so a
    // handful of blown highlights cannot speak for the whole frame). This
    // is what the paper is *actually* reading as.
    paperLuminance: number;
    // Mean saturation over opaque pixels. The gate on everything below: a
    // near-neutral image still splits into two hue groups, but they are made
    // of a handful of stray pixels and mean nothing.
    chroma: number;
    // Share of the frame carrying real colour (saturation above a floor).
    chromaticFraction: number;
    // Between the image's two dominant hue groups: how far apart they are in
    // luminance, and how far apart in hue. A subject that differs in hue but
    // not in tone is the case greyscale cannot represent - convert it
    // faithfully and the subject comes out as a hole in its background.
    tonalSeparation: number;
    hueSeparation: number;
};

import { compositedLuminance } from './grayscale';
import { inkLengthFor } from './scribble/demand';

// Quantization levels per RGB channel for the color-concentration
// histogram. 5 levels/channel (125 buckets) is coarse enough that
// anti-aliasing/JPEG noise around a flat region's edges still lands in the
// same bucket as the region's dominant color, fine enough to tell visually
// distinct colors apart.
const HISTOGRAM_LEVELS_PER_CHANNEL = 5;

// A histogram bucket counts as "dominant" once it holds at least this
// fraction of all opaque pixels - small enough that a legitimate minor
// palette color (e.g. a small logo accent) still counts, large enough that
// anti-aliasing-fringe noise scattered across many near-empty buckets
// doesn't inflate estimatedDistinctColors.
const DOMINANT_BUCKET_MIN_SHARE = 0.02;

// Targets roughly this many sample cells along the longer image axis for
// the flat/edge/midtone gradient scan - same order of magnitude as
// imageGradient.ts's own TARGET_SAMPLES_ALONG_LONG_AXIS, since this needs
// the same "coarse but representative" resolution, not per-pixel precision.
const TARGET_GRADIENT_SAMPLES_ALONG_LONG_AXIS = 100;

// Thresholds on a normalized-luminance ([0,1]) local gradient magnitude
// (the larger of the horizontal/vertical neighbor difference - a cheap
// stand-in for a full Sobel pass, adequate at this sampling coarseness).
// Calibrated so a smooth 0..255 ramp over a few hundred pixels (typical
// photographic tonal gradation) lands in the "midtone" band, while a sharp
// black/white boundary (typical vector-art edge) lands in "edge".
const FLAT_GRADIENT_THRESHOLD = 0.015;
const EDGE_GRADIENT_THRESHOLD = 0.12;

function buildLuminanceBuffer(imageData: ImageData): { luminance: Float32Array; opaqueFraction: number } {
    const { width, height, data } = imageData;
    const luminance = new Float32Array(width * height);
    let opaqueCount = 0;

    for (let i = 0, p = 0; i < luminance.length; i++, p += 4) {
        const a = data[p + 3];
        if (a === 0) {
            luminance[i] = 1; // transparent reads as paper-white, matching vectorizer.ts's convention
            continue;
        }
        opaqueCount++;
        // Composited over white, the same way grayscale.ts judges a pixel for
        // tracing. Reading the stored RGB instead makes a soft drop shadow -
        // black at alpha 20 - analyse as near-black when the tracer will draw
        // it as 8% grey, so the analyser and the renderer disagree about the
        // same image. Measured on the cartoon test image, where 28% of pixels
        // carry partial alpha: midToneFraction 0.215 uncomposited against
        // 0.083 composited, and continuousToneScore 0.201 against 0.094.
        luminance[i] = compositedLuminance(data[p], data[p + 1], data[p + 2], a) / 255;
    }

    return { luminance, opaqueFraction: width * height > 0 ? opaqueCount / (width * height) : 0 };
}

function computeColorConcentration(imageData: ImageData): { colorConcentration: number; estimatedDistinctColors: number } {
    const { data, width, height } = imageData;
    const bucketsPerAxis = HISTOGRAM_LEVELS_PER_CHANNEL;
    const counts = new Map<number, number>();
    let opaqueCount = 0;

    for (let i = 0, p = 0; i < width * height; i++, p += 4) {
        const a = data[p + 3];
        if (a === 0) continue;
        opaqueCount++;

        const r = Math.min(bucketsPerAxis - 1, Math.floor((data[p] / 256) * bucketsPerAxis));
        const g = Math.min(bucketsPerAxis - 1, Math.floor((data[p + 1] / 256) * bucketsPerAxis));
        const b = Math.min(bucketsPerAxis - 1, Math.floor((data[p + 2] / 256) * bucketsPerAxis));
        const bucket = (r * bucketsPerAxis + g) * bucketsPerAxis + b;

        counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }

    if (opaqueCount === 0) {
        return { colorConcentration: 1, estimatedDistinctColors: 0 };
    }

    const sortedCounts = Array.from(counts.values()).sort((a, b) => b - a);

    // Concentration: share of opaque pixels held by the top 8 buckets (an
    // arbitrary but generous ceiling on "a handful of dominant colors" -
    // flat art with, say, 3-6 fill colors is fully captured by this, while
    // a photo's broad spread across dozens/hundreds of buckets is not).
    const TOP_BUCKET_COUNT = 8;
    const topShare = sortedCounts.slice(0, TOP_BUCKET_COUNT).reduce((sum, c) => sum + c, 0) / opaqueCount;

    const estimatedDistinctColors = sortedCounts.filter(c => c / opaqueCount >= DOMINANT_BUCKET_MIN_SHARE).length;

    return { colorConcentration: topShare, estimatedDistinctColors: Math.max(1, estimatedDistinctColors) };
}

function computeGradientFractions(
    luminance: Float32Array,
    width: number,
    height: number,
): { flatFraction: number; edgeFraction: number; midToneFraction: number } {
    if (width < 2 || height < 2) {
        return { flatFraction: 1, edgeFraction: 0, midToneFraction: 0 };
    }

    const spacing = Math.max(1, Math.round(Math.max(width, height) / TARGET_GRADIENT_SAMPLES_ALONG_LONG_AXIS));

    let flat = 0, edge = 0, mid = 0, total = 0;

    for (let y = 0; y + spacing < height; y += spacing) {
        for (let x = 0; x + spacing < width; x += spacing) {
            const here = luminance[y * width + x];
            const right = luminance[y * width + (x + spacing)];
            const down = luminance[(y + spacing) * width + x];
            const magnitude = Math.max(Math.abs(right - here), Math.abs(down - here));

            total++;
            if (magnitude < FLAT_GRADIENT_THRESHOLD) {
                flat++;
            } else if (magnitude > EDGE_GRADIENT_THRESHOLD) {
                edge++;
            } else {
                mid++;
            }
        }
    }

    if (total === 0) {
        return { flatFraction: 1, edgeFraction: 0, midToneFraction: 0 };
    }

    return { flatFraction: flat / total, edgeFraction: edge / total, midToneFraction: mid / total };
}

// Blends midToneFraction (gradual shading - the strongest single tell for
// continuous tone, see midToneFraction's own doc comment) with
// (1 - colorConcentration) (spread-out color use). Weighted evenly: the two
// signals are complementary (one purely spatial/gradient-based, one purely
// color-histogram-based) and neither alone is fully reliable - e.g. a
// grayscale photo has near-zero color spread (it's all one hue) but very
// high midToneFraction, while a richly-colored but still flat vector
// illustration could have many distinct flat colors but essentially zero
// midtone. Combining both catches either case.
function computeContinuousToneScore(midToneFraction: number, colorConcentration: number): number {
    return 0.5 * midToneFraction + 0.5 * (1 - colorConcentration);
}

// Score below this is classified 'flat'; at/above is 'continuous-tone'.
// 0.35 sits comfortably below a smoothly-graded photo's typical score
// (usually 0.5+, since both signal components lean toward continuous-tone
// for real photographic content) and comfortably above a solid-fill
// vector/cartoon image's (usually well under 0.2, since both components
// lean toward flat) - see smartDefaults.test.ts's synthetic fixtures for
// the numbers this was checked against.
export const CONTINUOUS_TONE_CLASSIFICATION_THRESHOLD = 0.35;

// Bright enough to leave as bare paper. Deliberately a shade below
// grayscale.ts's BACKGROUND_LUMINANCE_THRESHOLD (0.92): that one decides
// what the tracer treats as background and wants to be conservative, this
// one only measures how much headroom the image has, and an image whose
// "white" sits at 0.91 has headroom in every sense that matters here.
const PAPER_LUMINANCE_THRESHOLD = 0.90;

// A pixel counts as carrying colour above this saturation (max channel minus
// min). Below it, hue is mostly sensor noise and JPEG chroma subsampling.
const CHROMATIC_SATURATION_FLOOR = 0.12;

// Bins per axis for the chromaticity histogram the two dominant hue groups
// are found in. Deterministic by construction - k-means with a random start
// would give the same image different defaults on different runs, which is
// the one thing a default must never do.
const CHROMATICITY_BINS = 16;

// Two hue groups have to be at least this far apart in chromaticity to count
// as separate. Below it they are the same colour described twice, and their
// luminance difference says nothing about subject versus background.
const MIN_CHROMATICITY_SEPARATION = 0.06;

function computePaperStatistics(luminance: Float32Array): {
    whiteHeadroom: number; paperLuminance: number; meanDarkness: number; meanInkDemand: number;
} {
    if (luminance.length === 0) return { whiteHeadroom: 0, paperLuminance: 0, meanDarkness: 0, meanInkDemand: 0 };

    // A 256-bin histogram rather than a sort: exact enough for a percentile
    // at this scale and linear in the pixel count.
    const bins = new Uint32Array(256);
    let bright = 0;
    let darknessSum = 0;
    let inkSum = 0;
    for (let i = 0; i < luminance.length; i++) {
        const v = luminance[i];
        bins[Math.min(255, Math.max(0, Math.round(v * 255)))]++;
        if (v > PAPER_LUMINANCE_THRESHOLD) bright++;
        darknessSum += 1 - v;
        inkSum += inkLengthFor(1 - v);
    }

    const target = luminance.length * 0.98;
    let seen = 0;
    let paperBin = 255;
    for (let b = 0; b < 256; b++) {
        seen += bins[b];
        if (seen >= target) { paperBin = b; break; }
    }

    return {
        whiteHeadroom: bright / luminance.length,
        paperLuminance: paperBin / 255,
        meanDarkness: darknessSum / luminance.length,
        meanInkDemand: inkSum / luminance.length,
    };
}

function computeColorSeparation(imageData: ImageData, luminance: Float32Array): {
    chroma: number; chromaticFraction: number; tonalSeparation: number; hueSeparation: number;
} {
    const { data, width, height } = imageData;
    const total = width * height;
    const none = { chroma: 0, chromaticFraction: 0, tonalSeparation: 0, hueSeparation: 0 };
    if (total === 0) return none;

    // Chromaticity - colour with brightness divided out - so the two groups
    // separate by hue rather than by how light they happen to be. On raw RGB
    // the means separate by brightness instead, which puts a ginger subject
    // and a green background in the same bin.
    const bins = new Float64Array(CHROMATICITY_BINS * CHROMATICITY_BINS);
    const sumLum = new Float64Array(CHROMATICITY_BINS * CHROMATICITY_BINS);
    let saturationSum = 0;
    let opaque = 0;
    let chromatic = 0;

    for (let i = 0, p = 0; i < total; i++, p += 4) {
        const a = data[p + 3];
        if (a === 0) continue;
        opaque++;

        // Composited, for the same reason the luminance buffer is: a colour
        // at low alpha is a pale version of itself on the paper.
        const f = a / 255;
        const r = data[p] * f + 255 * (1 - f);
        const g = data[p + 1] * f + 255 * (1 - f);
        const b = data[p + 2] * f + 255 * (1 - f);

        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = (max - min) / 255;
        saturationSum += saturation;
        if (saturation <= CHROMATIC_SATURATION_FLOOR) continue;
        chromatic++;

        const sum = r + g + b;
        if (sum <= 0) continue;
        const cx = Math.min(CHROMATICITY_BINS - 1, Math.floor((r / sum) * CHROMATICITY_BINS));
        const cy = Math.min(CHROMATICITY_BINS - 1, Math.floor((g / sum) * CHROMATICITY_BINS));
        const bin = cy * CHROMATICITY_BINS + cx;
        bins[bin]++;
        sumLum[bin] += luminance[i];
    }

    if (opaque === 0) return none;
    const chroma = saturationSum / opaque;
    const chromaticFraction = chromatic / total;

    // Heaviest bin, then the heaviest bin far enough away from it to be a
    // different colour rather than the same one smeared across neighbours.
    let first = -1;
    for (let b = 0; b < bins.length; b++) if (first < 0 || bins[b] > bins[first]) first = b;
    if (first < 0 || bins[first] === 0) return { chroma, chromaticFraction, tonalSeparation: 0, hueSeparation: 0 };

    const binCentre = (bin: number) => ({
        x: ((bin % CHROMATICITY_BINS) + 0.5) / CHROMATICITY_BINS,
        y: (Math.floor(bin / CHROMATICITY_BINS) + 0.5) / CHROMATICITY_BINS,
    });
    const a1 = binCentre(first);

    let second = -1;
    for (let b = 0; b < bins.length; b++) {
        if (bins[b] === 0) continue;
        const c = binCentre(b);
        if (Math.hypot(c.x - a1.x, c.y - a1.y) < MIN_CHROMATICITY_SEPARATION) continue;
        if (second < 0 || bins[b] > bins[second]) second = b;
    }
    if (second < 0) return { chroma, chromaticFraction, tonalSeparation: 0, hueSeparation: 0 };

    const a2 = binCentre(second);
    const lum1 = sumLum[first] / bins[first];
    const lum2 = sumLum[second] / bins[second];

    return {
        chroma,
        chromaticFraction,
        tonalSeparation: Math.abs(lum1 - lum2),
        hueSeparation: Math.hypot(a1.x - a2.x, a1.y - a2.y),
    };
}

export function analyzeImageCharacteristics(imageData: ImageData): ImageCharacteristics {
    const { width, height } = imageData;
    const { luminance, opaqueFraction } = buildLuminanceBuffer(imageData);
    const { colorConcentration, estimatedDistinctColors } = computeColorConcentration(imageData);
    const { flatFraction, edgeFraction, midToneFraction } = computeGradientFractions(luminance, width, height);
    const { whiteHeadroom, paperLuminance, meanDarkness, meanInkDemand } = computePaperStatistics(luminance);
    const colour = computeColorSeparation(imageData, luminance);

    const continuousToneScore = computeContinuousToneScore(midToneFraction, colorConcentration);
    const classification = continuousToneScore >= CONTINUOUS_TONE_CLASSIFICATION_THRESHOLD ? 'continuous-tone' : 'flat';

    return {
        widthPx: width,
        heightPx: height,
        opaqueFraction,
        colorConcentration,
        estimatedDistinctColors,
        flatFraction,
        edgeFraction,
        midToneFraction,
        continuousToneScore,
        classification,
        whiteHeadroom,
        meanDarkness,
        meanInkDemand,
        paperLuminance,
        chroma: colour.chroma,
        chromaticFraction: colour.chromaticFraction,
        tonalSeparation: colour.tonalSeparation,
        hueSeparation: colour.hueSeparation,
    };
}
