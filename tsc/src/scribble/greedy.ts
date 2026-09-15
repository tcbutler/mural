// The greedy residual-darkness walk.
//
// No geometry model at all. Hold a buffer of the ink the image still owes.
// From wherever the pen is, throw out a handful of candidate segments, score
// each by the mean debt along it, draw the best one, subtract the ink that
// stroke actually lays, and repeat. Dark areas stay attractive until they have
// been paid off, so the density of the scribble ends up tracking the tone
// without anything ever computing a tone.
//
// This is the family behind Vrellis-style string art and DrawingBotV3's sketch
// path finders. It is non-deterministic by construction - another seed gives a
// different but equally valid drawing - so the seed is an input, because a
// preview that does not predict the plot is not a preview.
//
// Across blind human ranking of the prototypes (tools/scribble/, five sheets
// and eighty pairwise preferences) this and the TSP tour took every top-two
// slot between them. It wins on legibility: the walk puts line where the
// picture is, and nowhere else.
//
// Everything below is in DEMAND-MAP PIXELS internally and millimetres at the
// edges, because the constants were tuned on a map of one pixel per
// millimetre and a plot has no business depending on how large the image file
// was.
import { DemandMap, inkLengthFor } from './demand';
import { Random } from '../fillStrategies/seededRandom';

export type Point = { x: number; y: number };

export type GreedyOptions = {
    /** Nib width, mm. Sets how much paper a unit of stroke actually covers. */
    penWidthMm: number;
    /** Ceiling on how many strokes to draw before stopping. */
    maxStrokes?: number;
    /** Shortest and longest candidate segment, mm. */
    minSegmentMm?: number;
    maxSegmentMm?: number;
    /** Candidate segments considered per step. */
    candidates?: number;
    /** Largest turn from the current heading, radians. */
    maxTurnRadians?: number;
    /** Samples taken along each candidate when scoring it. */
    samplesPerCandidate?: number;
    random: Random;
};

// Defaults, in the units the prototypes were tuned in (tools/scribble/greedy.py
// worked at one pixel per millimetre, so its pixel constants are these
// millimetres).
const DEFAULT_MAX_STROKES = 45000;
const DEFAULT_MIN_SEGMENT_MM = 5;
const DEFAULT_MAX_SEGMENT_MM = 22;
const DEFAULT_CANDIDATES = 24;
const DEFAULT_MAX_TURN_RADIANS = 2.4;
const DEFAULT_SAMPLES = 20;

// Ink is paid into a BAND, not onto a line.
//
// A pixel asking for 0.3 coverage is asking for a line to pass near it three
// times in ten, not for one line straight through it. Charging the centreline
// a full unit pays off a light region after a single stroke, and the walk keeps
// coming back to it - the bug that made the first version of this draw twice
// the ink it should have. Spreading the same total across a band makes the
// units right: a stroke contributes `pen` of covered area per unit length,
// wherever that area lands.
const PAY_RADIUS_MM = 5;

// Restart search runs over a coarse copy of the residual. Scanning the full
// buffer every time the walk strands itself in paid-off paper dominated the
// runtime; at this cell size it is cheap and still precise enough to aim a
// restart.
const RESTART_CELL_MM = 8;

// Restart targets are collected in batches. Late in a drawing the walk strands
// itself constantly, and rebuilding the coarse map for every single restart is
// most of the cost of finishing.
const RESTART_BATCH = 512;

// Below this share of the median debt, a candidate is not worth drawing.
//
// Relative to what the image is actually asking for, not a fixed floor: a
// fixed one silently becomes "skip most of the picture" on a lightly inked
// image, which reads as the algorithm failing when it is really the threshold
// being in the wrong units.
const GIVE_UP_SHARE_OF_MEDIAN = 0.25;

function medianOf(values: Float32Array, aboveZero = 1e-3): number {
    const live: number[] = [];
    for (let i = 0; i < values.length; i++) {
        if (values[i] > aboveZero) live.push(values[i]);
    }
    if (live.length === 0) return 0;
    live.sort((a, b) => a - b);
    return live[Math.floor(live.length / 2)];
}

/**
 * Walks the image, returning polylines in MILLIMETRES.
 *
 * Each polyline is one continuous stroke: the pen goes down at its first point
 * and lifts after its last. Chains come out in the order they were drawn -
 * stitch.ts is what makes that order cheap to plot.
 */
export function greedyScribble(map: DemandMap, options: GreedyOptions): Point[][] {
    const { width, height, demand, mmPerPixel } = map;
    const random = options.random;

    const maxStrokes = options.maxStrokes ?? DEFAULT_MAX_STROKES;
    const candidates = options.candidates ?? DEFAULT_CANDIDATES;
    const maxTurn = options.maxTurnRadians ?? DEFAULT_MAX_TURN_RADIANS;
    const samples = options.samplesPerCandidate ?? DEFAULT_SAMPLES;

    const toPixels = (mm: number) => mm / mmPerPixel;
    const penPx = Math.max(0.5, toPixels(options.penWidthMm));
    const minSegment = Math.max(1, toPixels(options.minSegmentMm ?? DEFAULT_MIN_SEGMENT_MM));
    const maxSegment = Math.max(minSegment + 1, toPixels(options.maxSegmentMm ?? DEFAULT_MAX_SEGMENT_MM));
    const payRadius = Math.max(1, Math.round(toPixels(PAY_RADIUS_MM)));
    const cell = Math.max(2, Math.round(toPixels(RESTART_CELL_MM)));

    // The residual is held in units of INK STILL OWED, not of coverage - see
    // demand.ts's inkLengthFor for why those are different numbers.
    const residual = new Float32Array(width * height);
    for (let i = 0; i < demand.length; i++) {
        residual[i] = inkLengthFor(demand[i]);
    }

    const giveUp = GIVE_UP_SHARE_OF_MEDIAN * medianOf(residual);
    if (!(giveUp > 0)) {
        return [];
    }

    const bandOffsets = 2 * payRadius + 1;
    const perOffset = penPx / bandOffsets;

    function pay(ax: number, ay: number, bx: number, by: number): void {
        const dx = bx - ax;
        const dy = by - ay;
        const length = Math.hypot(dx, dy);
        if (!(length > 0)) return;
        const steps = Math.max(2, Math.round(length) + 1);
        // Unit normal: the band is laid across the stroke, not along it.
        const nx = -dy / length;
        const ny = dx / length;

        for (let s = 0; s < steps; s++) {
            const t = s / (steps - 1);
            const px = ax + dx * t;
            const py = ay + dy * t;
            for (let o = -payRadius; o <= payRadius; o++) {
                const qx = Math.round(px + nx * o);
                const qy = Math.round(py + ny * o);
                if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
                // Deliberately not clamped at zero: clipping the whole buffer
                // every stroke was most of the runtime, and letting overdrawn
                // pixels go negative just makes them a little more repellent.
                residual[qy * width + qx] -= perOffset;
            }
        }
    }

    // --- restart targets ------------------------------------------------
    const coarseWidth = Math.ceil(width / cell);
    const coarseHeight = Math.ceil(height / cell);
    const pending: number[] = [];

    function refillRestarts(): boolean {
        const coarse = new Float32Array(coarseWidth * coarseHeight);
        for (let y = 0; y < height; y++) {
            const cy = (y / cell) | 0;
            for (let x = 0; x < width; x++) {
                const index = cy * coarseWidth + ((x / cell) | 0);
                const value = residual[y * width + x];
                if (value > coarse[index]) coarse[index] = value;
            }
        }

        const owing: number[] = [];
        for (let i = 0; i < coarse.length; i++) {
            if (coarse[i] > giveUp) owing.push(i);
        }
        if (owing.length === 0) return false;

        owing.sort((a, b) => coarse[a] - coarse[b]);
        pending.push(...owing.slice(-RESTART_BATCH));
        return true;
    }

    // --- the walk -------------------------------------------------------
    const polylines: Point[][] = [];
    let current: Point[] = [];

    let brightest = 0;
    for (let i = 1; i < residual.length; i++) {
        if (residual[i] > residual[brightest]) brightest = i;
    }
    let px = brightest % width;
    let py = (brightest / width) | 0;
    let heading = random() * 2 * Math.PI;

    const flush = () => {
        if (current.length > 1) polylines.push(current);
        current = [];
    };

    for (let stroke = 0; stroke < maxStrokes; stroke++) {
        let bestScore = -Infinity;
        let bestX = px;
        let bestY = py;

        for (let c = 0; c < candidates; c++) {
            const angle = heading + (random() * 2 - 1) * maxTurn;
            const length = minSegment + random() * (maxSegment - minSegment);
            const ex = Math.min(width - 1, Math.max(0, px + Math.cos(angle) * length));
            const ey = Math.min(height - 1, Math.max(0, py + Math.sin(angle) * length));

            let total = 0;
            for (let s = 0; s < samples; s++) {
                const t = s / (samples - 1);
                const sx = (px + (ex - px) * t) | 0;
                const sy = (py + (ey - py) * t) | 0;
                total += residual[sy * width + sx];
            }
            const score = total / samples;
            if (score > bestScore) {
                bestScore = score;
                bestX = ex;
                bestY = ey;
            }
        }

        if (bestScore < giveUp) {
            // Stranded in paid-off paper: lift, and restart in the darkest
            // cell that still owes ink.
            flush();
            if (pending.length === 0 && !refillRestarts()) break;

            const target = pending.pop()!;
            const cx = (target % coarseWidth) * cell;
            const cy = ((target / coarseWidth) | 0) * cell;
            // The coarse grid is padded up to whole cells, so its last row and
            // column overhang the image; clamp back inside it.
            px = Math.min(width - 1, cx + random() * cell);
            py = Math.min(height - 1, cy + random() * cell);
            heading = random() * 2 * Math.PI;
            continue;
        }

        if (current.length === 0) {
            current.push({ x: px * mmPerPixel, y: py * mmPerPixel });
        }
        current.push({ x: bestX * mmPerPixel, y: bestY * mmPerPixel });
        pay(px, py, bestX, bestY);

        heading = Math.atan2(bestY - py, bestX - px);
        px = bestX;
        py = bestY;
    }

    flush();
    return polylines;
}
