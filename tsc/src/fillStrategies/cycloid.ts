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
// Straight hatch lines get clipped by intersection (hatchClip.ts). That does
// not suit a wiggly stroke - it would slice every loop it crosses - so this
// follows gradientHatch's approach instead and tests the pen position itself,
// breaking the stroke wherever it leaves the shape. Loops near an edge come
// out as arcs, which is what a hand does anyway, and no ink lands outside the
// region, which matters because a multi-colour render relies on layers not
// bleeding into each other.
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

const JITTER_MM = 0.15;

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

        for (let y = bounds.top + spacingMm / 2; y < bounds.bottom; y += spacingMm) {
            const points = traceCycloidRow(bounds.left, bounds.right, y, {
                spacingMm,
                penWidthMm: nibWidthMm,
                coverage,
                jitterMm: JITTER_MM,
                random,
            });

            // Split into runs of consecutive points that are inside the shape.
            // Anything shorter than the usual minimum is a stub the pen would
            // spend a lift on for almost no ink, so it goes the same way a
            // too-short hatch segment does.
            let run: paper.Point[] = [];
            const flush = () => {
                if (run.length > 1) {
                    const candidate = new paper.Path({ segments: run });
                    if (candidate.length > minInfillLength) {
                        out.push(candidate);
                    } else {
                        candidate.remove();
                    }
                }
                run = [];
            };

            for (const p of points) {
                const point = new paper.Point(p.x, p.y);
                if (point.isInside(ctx.boundsPath.bounds) && path.contains(point)) {
                    run.push(point);
                } else {
                    flush();
                }
            }
            flush();
        }

        return out;
    },
};
