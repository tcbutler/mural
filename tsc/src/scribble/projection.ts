// What a scribble will cost, before it runs.
//
// segmentModel.ts does this job for the traced path: turn the settings a user
// picks into the counts the two estimators need. This is the same job for the
// mark-making modes, which need entirely different counts, because a scribble
// is not a trace with a fill on it. There are no shapes. There is one long
// line, or a few hundred, carrying tens of thousands of points - which is the
// shape of work the traced-path model is blindest to, since every one of its
// coefficients is per path.
//
// Everything here is fitted against real runs of the real algorithms - see
// tsc/bench/runBenchmarks.ts's benchScribble and the per-constant notes below
// for the measurements and their spread.
//
// Deliberately free of paper.js and of ImageData, like the rest of scribble/:
// it reads a handful of numbers about the image and returns a handful of
// numbers about the drawing.
import { DEFAULT_INK_CEILING, DEFAULT_PIXELS_PER_MM, demandMapSize } from './demand';
import { DEFAULT_POINTS } from './tsp';
import { MarkMode } from './markModes';

export type ScribbleProjectionInputs = {
    mode: MarkMode;
    /** Source raster size, which caps the working map. */
    sourceWidthPx: number;
    sourceHeightPx: number;
    /** Physical plot width, mm. The map's own height follows the image. */
    drawWidthMm: number;
    /** Nib width, mm - how much paper a unit of stroke covers. */
    penWidthMm: number;
    /**
     * Mean darkness of the PREPARED image, 0..1
     * (imageCharacteristics.ts's meanDarkness). What decides whether the ink
     * gamma fires at all, and how far it compresses when it does.
     */
    meanDarkness: number;
    /**
     * Mean ink LENGTH the prepared image asks for, per unit area
     * (imageCharacteristics.ts's meanInkDemand). The single most important
     * input here: it is what the greedy walk is paying off, and reading it off
     * the image rather than inferring it from meanDarkness is the difference
     * between a stroke count good to 1.4x and one good to 4x. Ink landing on
     * ink covers no new paper, so this is a convex function of darkness and
     * its mean is nowhere near inkLengthFor(mean darkness) - see demand.ts.
     */
    meanInkDemand: number;
    /**
     * Fraction of the frame bright enough to read as bare paper
     * (imageCharacteristics.ts's whiteHeadroom). Its complement is what the
     * tour has to cover.
     */
    whiteHeadroom: number;
    /** Working resolution, map pixels per mm - demand.ts's own default. */
    pixelsPerMm?: number;
    inkCeiling?: number;
};

export type ScribbleProjection = {
    mode: MarkMode;
    mapWidth: number;
    mapHeight: number;
    mapPixels: number;
    /** Millimetres of paper per map pixel - what every per-stroke cost scales by. */
    mmPerPixel: number;
    /** Area the drawing actually covers, mm^2 (the map's, not the requested box's). */
    drawAreaMm2: number;
    /** Whether the ink gamma will run - demand.ts's solveInkGamma, 28 passes over the map. */
    gammaSolved: boolean;
    /** Mean ink length per map pixel after the gamma, which is what gets paid off. */
    meanInkLength: number;
    /**
     * Share of the frame carrying any ink demand at all, taken as the
     * complement of whiteHeadroom. The tour's length and the relaxation's cost
     * both scale with it.
     */
    inkedFraction: number;
    /** Strokes the greedy walk draws, or points the tour visits. */
    strokeCount: number;
    /** Points in the finished chains - the count the renderer's cost tracks. */
    pointCount: number;
    /** Pieces the algorithm emits, before stitching. */
    rawChainCount: number;
    /** Pen-down brackets in the finished drawing. */
    chainCount: number;
    /** Ink and pen-up travel, mm. */
    drawnMm: number;
    travelMm: number;
};

// --- the greedy walk ------------------------------------------------------

// Mean length of a stroke the walk actually draws, mm.
//
// Shorter than the 13.5mm midpoint of its own 5-22mm candidate range because
// candidates are clamped to the image: a stroke aimed off the edge gets cut
// short and drawn anyway. MEASURED across 12 runs (two images, a cartoon and a
// ramp, at 300/600/900mm): 8.5-11.2mm, and it drifts up with plot size as the
// map coarsens.
export const GREEDY_MEAN_STROKE_MM = 10;

// How much line the walk draws for each unit of ink the image asks for.
//
// Above 1 because the walk is not a perfect payer: it pays into a 10mm band
// whose edges fall off the map near the borders, it lets overdrawn pixels go
// negative rather than clamping them, and it charges one extra sample's worth
// of ink per stroke (greedy.ts's pay).
//
// It is not a constant, and the way it varies is the point: MEASURED at
// 0.95-2.27 across the 12 greedy runs, falling steadily as the plot gets
// bigger - including between two runs of the same image at the same map
// resolution, so it is the plot size doing it and not the map's. The mechanism
// is that a stroke is a fixed physical length: on a small plot a 10mm stroke
// crosses a good part of the picture and is bound to lay ink where none was
// asked for, and on a large one it stays inside a single tonal region. So what
// the waste actually tracks is the stroke's length against the picture's span,
// and the two constants below are that relationship: waste =
// GREEDY_INK_WASTE x (stroke / span)^GREEDY_INK_WASTE_EXPONENT.
//
// Fitted across all 12 runs, the exponent chosen from {0, 1/4, 1/3, 1/2} as
// the one leaving the least spread in the coefficient (1.9x, against 2.6x for
// a flat coefficient with no size term at all). What is left of that spread is
// one image wanting ~1.6x more line than the other three at every size - a
// difference in how its darkness is distributed that nothing available before
// the render describes.
export const GREEDY_INK_WASTE = 4.4;
export const GREEDY_INK_WASTE_EXPONENT = 1 / 3;

// Pieces the walk emits, per stroke drawn. Each one is a place the walk ran
// out of debt, lifted, and restarted somewhere darker. MEASURED 0.12-0.25,
// falling as the drawing gets denser.
export const GREEDY_RAW_CHAINS_PER_STROKE = 0.18;

// Chains left after stitch.ts has joined everything within its gap, per stroke
// drawn - i.e. the real pen lifts. MEASURED 0.016-0.038 across the same runs.
// Held against strokes rather than against raw chains because that is the
// tighter relationship of the two (2.4x spread against 4x).
export const GREEDY_CHAINS_PER_STROKE = 0.025;

// Pen-up travel between two consecutive chains, mm. MEASURED 18-24mm across
// all 12 runs, and - unexpectedly - independent of plot size: the stitcher
// joins anything closer than its gap, so what is left over is always a hop of
// about the same size.
export const GREEDY_TRAVEL_MM_PER_CHAIN = 20;

// --- the TSP tour ---------------------------------------------------------

// The tour visits every stipple point once, so its length is about
// sqrt(points x inked area) - the classic result for a tour through points
// spread evenly over a region. MEASURED 0.87-1.10 across 12 runs with the
// inked area taken as (1 - whiteHeadroom) of the frame, which is as close as
// a projection gets to the real thing.
export const TSP_TOUR_LENGTH_COEFFICIENT = 1.0;

// Pieces the tour is cut into, where an edge would otherwise rule a line
// across the paper (tsp.ts's breakLongEdges). MEASURED 13-49, with no useful
// dependence on size or image - it is a property of how many separate dark
// regions the picture has, which nothing available pre-render describes.
export const TSP_CHAIN_COUNT = 25;

// Pen-up travel per cut, as a share of the plot width. Unlike the greedy
// walk's, this one does scale with the plot: the cuts are the transits between
// dark regions, and those get longer as the paper does. MEASURED 0.07-0.13.
export const TSP_TRAVEL_SHARE_OF_WIDTH_PER_CHAIN = 0.1;

/**
 * The mean ink length a prepared image's demand map will carry.
 *
 * inkDemand runs a gamma over the map to bring its mean coverage down to the
 * ink ceiling, and the ceiling is a budget rather than a target, so a light
 * image is left alone (demand.ts). Scaling the image's own mean ink length by
 * how far that gamma has to compress it lands within 19% of the real map's
 * mean on every fixture measured - which is far closer than any model built
 * from mean darkness alone gets, the transform being convex.
 */
export function projectedMeanInkLength(meanInkDemand: number, meanDarkness: number, inkCeiling: number): number {
    if (!(meanDarkness > 0)) return 0;
    return Math.max(0, meanInkDemand) * Math.min(1, inkCeiling / meanDarkness);
}

/** What the chosen mode is about to draw, and at what count. */
export function projectScribble(inputs: ScribbleProjectionInputs): ScribbleProjection {
    const inkCeiling = inputs.inkCeiling ?? DEFAULT_INK_CEILING;
    const pixelsPerMm = inputs.pixelsPerMm ?? DEFAULT_PIXELS_PER_MM;

    const { width: mapWidth, height: mapHeight } = demandMapSize(
        inputs.sourceWidthPx,
        inputs.sourceHeightPx,
        inputs.drawWidthMm,
        pixelsPerMm,
    );
    const mapPixels = mapWidth * mapHeight;
    const mmPerPixel = mapWidth > 0 ? Math.max(0, inputs.drawWidthMm) / mapWidth : 0;
    // The map's own area, not the requested box's: the drawing is the image,
    // scaled to the plot width, at the image's own aspect ratio.
    const drawAreaMm2 = mapPixels * mmPerPixel * mmPerPixel;

    const meanInkLength = projectedMeanInkLength(inputs.meanInkDemand, inputs.meanDarkness, inkCeiling);
    const gammaSolved = inputs.meanDarkness > inkCeiling;

    const inkedFraction = Math.max(0, Math.min(1, 1 - inputs.whiteHeadroom));

    if (inputs.mode === 'tsp') {
        const inkedAreaMm2 = drawAreaMm2 * inkedFraction;
        const points = DEFAULT_POINTS;
        const drawnMm = TSP_TOUR_LENGTH_COEFFICIENT * Math.sqrt(points * inkedAreaMm2);

        return {
            mode: inputs.mode,
            mapWidth, mapHeight, mapPixels, mmPerPixel, drawAreaMm2, gammaSolved, meanInkLength, inkedFraction,
            strokeCount: points,
            // The tour is one line through every point; cutting it into pieces
            // neither adds nor removes any.
            pointCount: points,
            rawChainCount: TSP_CHAIN_COUNT,
            chainCount: TSP_CHAIN_COUNT,
            drawnMm,
            travelMm: TSP_CHAIN_COUNT * TSP_TRAVEL_SHARE_OF_WIDTH_PER_CHAIN * Math.max(0, inputs.drawWidthMm),
        };
    }

    // Ink owed, as a length: the image asks for meanInkLength per unit area,
    // and a stroke covers its own length times the nib's width. Then what the
    // walk really spends to pay that off - see GREEDY_INK_WASTE.
    const penWidthMm = Math.max(0.1, inputs.penWidthMm);
    const spanMm = Math.sqrt(Math.max(1, drawAreaMm2));
    const waste = GREEDY_INK_WASTE * Math.pow(GREEDY_MEAN_STROKE_MM / spanMm, GREEDY_INK_WASTE_EXPONENT);
    const drawnMm = waste * drawAreaMm2 * meanInkLength / penWidthMm;
    const strokeCount = drawnMm / GREEDY_MEAN_STROKE_MM;
    const chainCount = Math.max(1, Math.round(strokeCount * GREEDY_CHAINS_PER_STROKE));

    return {
        mode: inputs.mode,
        mapWidth, mapHeight, mapPixels, mmPerPixel, drawAreaMm2, gammaSolved, meanInkLength, inkedFraction,
        strokeCount,
        // One point per stroke, plus the point the pen goes down on at the
        // start of each chain.
        pointCount: Math.round(strokeCount) + chainCount,
        rawChainCount: Math.max(1, Math.round(strokeCount * GREEDY_RAW_CHAINS_PER_STROKE)),
        chainCount,
        drawnMm,
        travelMm: chainCount * GREEDY_TRAVEL_MM_PER_CHAIN,
    };
}
