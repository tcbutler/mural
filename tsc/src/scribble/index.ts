// The scribble modes, as one entry point.
//
// Everything a caller needs to go from a raster to an SVG the renderer will
// draw: pick the algorithm, walk the picture, stitch the result so the pen is
// not lifting all day, and emit it tagged as strokes rather than as regions.
import { mulberry32 } from '../fillStrategies/seededRandom';
import { DemandMap, inkDemand } from './demand';
import { greedyScribble, Point } from './greedy';
import { measureChains, stitch } from './stitch';
import { scribbleToSvg } from './toSvg';
import { tspScribble } from './tsp';

export type MarkMode = 'greedy' | 'tsp';

export const MARK_MODES: MarkMode[] = ['greedy', 'tsp'];

export function isMarkMode(value: unknown): value is MarkMode {
    return typeof value === 'string' && (MARK_MODES as string[]).includes(value);
}

export type ScribbleOptions = {
    mode: MarkMode;
    /** Physical plot width in mm - every length in these algorithms is real. */
    drawWidthMm: number;
    /** Nib width in mm, which is how much paper a unit of stroke covers. */
    penWidthMm: number;
    /**
     * Seed for the walk.
     *
     * These algorithms are random by construction, and a preview that does not
     * predict the plot is not a preview - so the seed is an input rather than
     * a call to Math.random. Re-rendering the same image with the same seed
     * gives the same drawing; changing it gives a different, equally valid one.
     */
    seed?: number;
    /**
     * Gap the stitcher may bridge rather than lift over, in mm.
     *
     * The single biggest lever on plot time for the greedy walk: on a 400mm
     * horse it takes 1,149 pen lifts down to 116, about seventy minutes, for
     * under three metres of extra ink.
     */
    joinGapMm?: number;
};

// Chosen with the plot in mind rather than the picture: at a nib width or two
// the bridge the stitcher draws is shorter than the pen is wide, so it reads
// as part of the scribble rather than as a line someone added.
const DEFAULT_JOIN_GAP_MM = 8;

const DEFAULT_SEED = 0x5C81_B71E;

export type ScribbleResult = {
    chains: Point[][];
    map: DemandMap;
    /** Ink drawn and pen-up travel, both mm - what the mode is about to cost. */
    drawnMm: number;
    travelMm: number;
};

/** Runs a scribble mode over a raster, returning chains in millimetres. */
export function scribble(imageData: ImageData, options: ScribbleOptions): ScribbleResult {
    const random = mulberry32(options.seed ?? DEFAULT_SEED);
    const map = inkDemand(imageData, { drawWidthMm: options.drawWidthMm });

    const raw = options.mode === 'tsp'
        ? tspScribble(map, { random })
        : greedyScribble(map, { penWidthMm: options.penWidthMm, random });

    // The tour is already one continuous line, so joining its few pieces would
    // only redraw the transits it just cut. The walk is the one that needs it.
    const joinGapMm = options.mode === 'tsp' ? 0 : (options.joinGapMm ?? DEFAULT_JOIN_GAP_MM);
    const chains = stitch(raw, joinGapMm);
    const measured = measureChains(chains);

    return { chains, map, drawnMm: measured.drawnMm, travelMm: measured.travelMm };
}

/** Runs a scribble mode and returns it as an SVG the renderer can take. */
export function scribbleToSvgString(imageData: ImageData, options: ScribbleOptions): string {
    const { chains } = scribble(imageData, options);
    return scribbleToSvg(chains, {
        rasterWidth: imageData.width,
        rasterHeight: imageData.height,
        drawWidthMm: options.drawWidthMm,
    });
}
