// Loop scribble: fills a shape with rows of continuous looping strokes, the
// way someone shades with a biro without lifting the pen. The geometry lives
// in cycloidPath.ts (paper.js-free, and tested there); this file is the thin
// adapter that walks rows across a paper shape and keeps the parts that land
// inside it.
//
// --- how much ink a row asks for ---------------------------------------
//
// The density ladder hands every strategy a spacingMm and expects the tone to
// follow from it. A region arrives already quantized to one tone (the tracer
// separates luminance into bands before any of this runs), so unlike the
// standalone prototype this fill has no tonal variation of its own to follow -
// every row in a region asks for the same coverage.
//
// Which coverage matters, because it decides whether this looks like anything.
// Matched to a single-direction hatch - one line of ink per row - the advance
// rate pins to its ceiling and the loops stretch out into a plain wavy line:
// correct tone, no scribble. Matched to the default cross-hatch, which lays
// two passes per spacing, the advance lands mid-range and the loops are real
// loops. So cross-hatch is the peer, which is also the honest comparison for
// the density slider: pick this style instead of the default and you get about
// the same amount of ink, arranged differently.
//
// --- staying inside the shape ------------------------------------------
//
// The hatch styles clip by intersecting a straight line with the shape and
// keeping the interior runs (hatchClip.ts). That machinery assumes a segment
// crosses the boundary at most a handful of times, which a looping stroke
// breaks immediately, so this hands the whole traced row to paper's boolean
// intersect instead: the row comes back cut exactly where it leaves the
// shape, holes included. Loops near an edge come out as arcs, which is what a
// hand does anyway, and no ink lands outside the region, which matters
// because a multi-colour render relies on layers not bleeding into each
// other.
//
// The first version tested the pen position point by point, the way
// gradientHatch does, and that is what makes this fill expensive: a row is
// sampled every millimetre or so, and a contains() call against a traced
// photographic shape costs tens of microseconds. Measured on a 900mm
// density-5 render of the horse fixture - 251k sampled points against one
// traced shape - point testing spent 6.6s where the boolean clip spends
// 1.2s for the same 130m of ink. It is also more accurate: a point test can
// only cut the stroke at a sample it already took, so every edge is ragged
// to within one sample.
import { DEFAULT_NIB_WIDTH_MM } from '../huePalette';
import { loadPaper } from '../paperLoader';
import { mulberry32, Random } from './seededRandom';
import { traceCycloidRow } from './cycloidPath';
import { FillContext, FillParams, FillStrategy } from './types';

const paper = loadPaper();

// Cross-hatch lays two passes of ink per spacing, and that is the style this
// one is offered as an alternative to. See the header.
const PASSES_PER_SPACING = 2;

// Ink cannot exceed the paper.
const MAX_COVERAGE = 0.95;

// Seeded for the same reason jitteredHatch is: re-running an identical request
// has to redraw an identical scribble, or the preview stops predicting the
// plot. Drawn from sequentially across every row of every path in one call, so
// rows do not all share a starting phase.
const CYCLOID_SEED = 0x5C81_B71E;

// Hand wobble, as a fraction of the row spacing rather than an absolute
// distance. Fixed at a fraction of a millimetre it vanishes: at the default
// density the rows are 10mm apart, so 0.15mm is 1.5% of the scale the eye is
// reading and the fill comes out looking knitted rather than drawn. Scaling it
// keeps the same amount of wobble at every density.
const JITTER_FRACTION_OF_SPACING = 0.09;

export function coverageForSpacing(spacingMm: number, nibWidthMm: number): number {
    if (!(spacingMm > 0)) return 0;
    return Math.min(MAX_COVERAGE, (PASSES_PER_SPACING * nibWidthMm) / spacingMm);
}

export const cycloid: FillStrategy = {
    name: 'cycloid',

    generateFill(path: paper.PathItem, params: FillParams, ctx: FillContext): paper.Path[] {
        const { spacingMm, minInfillLength } = params;
        if (spacingMm === 0) return [];

        const bounds = path.bounds;
        if (!(bounds.width > 0) || !(bounds.height > 0)) return [];

        // The request carries a nibWidthMm, but generateInfills does not
        // receive it and no strategy currently needs it, so this uses the
        // default rather than widening that signature for code that cannot be
        // executed in a default checkout. Threading the real value through is
        // a follow-up: it would shift the tone slightly for anyone drawing
        // with an unusually fine or broad nib.
        const nibWidthMm = DEFAULT_NIB_WIDTH_MM;
        const coverage = coverageForSpacing(spacingMm, nibWidthMm);
        if (coverage <= 0) return [];

        const rngKey = 'cycloid:rng';
        let random = ctx.cache.get(rngKey) as Random | undefined;
        if (!random) {
            random = mulberry32(CYCLOID_SEED);
            ctx.cache.set(rngKey, random);
        }

        const out: paper.Path[] = [];

        // Rows are traced across the shape's own bounds, narrowed to the view:
        // a row reaching outside the drawable area is ink the plotter cannot
        // lay, and the old point test discarded it the same way.
        const region = bounds.intersect(ctx.boundsPath.bounds);
        if (!(region.width > 0) || !(region.height > 0)) return out;

        for (let y = region.top + spacingMm / 2; y < region.bottom; y += spacingMm) {
            const points = traceCycloidRow(region.left, region.right, y, {
                spacingMm,
                penWidthMm: nibWidthMm,
                coverage,
                jitterMm: JITTER_FRACTION_OF_SPACING * spacingMm,
                random,
            });
            if (points.length < 2) continue;

            const row = new paper.Path({
                segments: points.map(p => new paper.Point(p.x, p.y)),
                insert: false,
            });

            // trace: false keeps the result as the open pieces of this row
            // rather than trying to resolve it into filled regions - the
            // subject is a stroke, not an area.
            const clipped = row.intersect(path, { trace: false, insert: false }) as paper.PathItem;
            row.remove();

            const pieces: paper.Path[] = (clipped instanceof paper.CompoundPath)
                ? (clipped.children.slice() as paper.Path[])
                : [clipped as paper.Path];

            for (const piece of pieces) {
                // Anything shorter than the usual minimum is a stub the pen
                // would spend a lift on for almost no ink, so it goes the same
                // way a too-short hatch segment does.
                if (piece.segments.length > 1 && piece.length > minInfillLength) {
                    // Detaches it from the compound wrapper and puts it where
                    // every other strategy's infill lives.
                    paper.project.activeLayer.addChild(piece);
                    out.push(piece);
                } else {
                    piece.remove();
                }
            }
            clipped.remove();
        }

        return out;
    },
};
