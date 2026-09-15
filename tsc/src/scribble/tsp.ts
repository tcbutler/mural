// TSP art: stipple the image, then join every dot with one tour.
//
// Two stages, both standard.
//
//   stipple()  weighted Voronoi relaxation. Scatter points, then repeatedly
//              move each to the darkness-weighted centroid of the pixels it
//              owns. Points drift into the dark areas and spread evenly within
//              them. Secord 2002, and the front half of Bosch & Herman 2004.
//
//   tour()     Hilbert-curve order for a starting tour, then 2-opt restricted
//              to each city's nearest neighbours. Not an optimal tour and it
//              does not need to be: a few percent above optimal is
//              indistinguishable by eye.
//
// The result is one unbroken line that never crosses itself, which is the whole
// appeal and also the limitation. No overdraw means no dense blacks, so tone
// comes entirely from how closely the line packs - and it means the drawing
// needs about two and a half times less line than the greedy walk for the same
// coverage, which is why it wins on plot time by a wide margin.
//
// The prototype used scipy's k-d tree for both the Voronoi assignment and the
// neighbour lists. Here a uniform grid does both jobs: the points are spread
// roughly evenly by construction, which is the case a grid handles best and a
// tree's advantage is smallest.
import { DemandMap } from './demand';
import { Point } from './greedy';
import { Random } from '../fillStrategies/seededRandom';

export type TspOptions = {
    /** How many stipple points to place. More points means finer tone. */
    points?: number;
    /** Lloyd relaxation passes. The points stop moving usefully after a dozen. */
    relaxationPasses?: number;
    /** Neighbours each city considers swapping with during 2-opt. */
    neighbours?: number;
    /** Hard cap on 2-opt passes; it stops early when no swap helps. */
    tourPasses?: number;
    /**
     * Cut the tour wherever an edge is longer than this many times the
     * distance between neighbouring stipple points.
     *
     * A tour still has to get from one dark region to another, and on paper
     * those transits read as straight lines ruled across the white. A plotter
     * can lift instead: cutting the worst edges costs a pen lift each and
     * removes a ruled line each.
     *
     * Relative to the point spacing rather than a fixed length, because that
     * is what makes an edge long: the same 20mm edge is unremarkable in a
     * sparse drawing and a ruled line across a dense one. Measured on the
     * horse at 6000 points - spacing 2.9mm - the tour has 18 edges over three
     * times that and only 4 over ten times, so a fixed 30mm cut three of the
     * transits and left fourteen drawn.
     */
    maxEdgeSpacings?: number;
    random: Random;
};

const DEFAULT_POINTS = 6000;
const DEFAULT_RELAXATION_PASSES = 12;
const DEFAULT_NEIGHBOURS = 10;
// Converged long before this on every image tried - the horse's tour stops
// improving after ten - but the pass is cheap and the cap is what guarantees
// it terminates.
const DEFAULT_TOUR_PASSES = 60;
const DEFAULT_MAX_EDGE_SPACINGS = 4;

// Pixels below this demand are bare paper and own no stipple point.
const INK_THRESHOLD = 1e-3;

/** Uniform grid over a point set, for nearest-neighbour queries. */
class PointGrid {
    private readonly cellSize: number;
    private readonly cols: number;
    private readonly rows: number;
    private readonly cells: number[][];

    constructor(private readonly xs: Float64Array, private readonly ys: Float64Array, width: number, height: number) {
        const count = Math.max(1, xs.length);
        // About one point per cell: the fewest cells to scan per query without
        // making each one crowded.
        this.cellSize = Math.max(1, Math.sqrt((width * height) / count));
        this.cols = Math.max(1, Math.ceil(width / this.cellSize));
        this.rows = Math.max(1, Math.ceil(height / this.cellSize));
        this.cells = new Array(this.cols * this.rows);
        for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];

        for (let i = 0; i < xs.length; i++) {
            this.cells[this.indexFor(xs[i], ys[i])].push(i);
        }
    }

    private indexFor(x: number, y: number): number {
        const col = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
        const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
        return row * this.cols + col;
    }

    /** Index of the nearest point, searching outward in rings until one is found. */
    nearest(x: number, y: number): number {
        const col = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
        const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));

        let best = -1;
        let bestDistance = Infinity;

        for (let ring = 0; ring < Math.max(this.cols, this.rows); ring++) {
            for (let r = row - ring; r <= row + ring; r++) {
                if (r < 0 || r >= this.rows) continue;
                for (let c = col - ring; c <= col + ring; c++) {
                    if (c < 0 || c >= this.cols) continue;
                    // Only the new ring's cells, not the ones already scanned.
                    if (ring > 0 && Math.abs(r - row) !== ring && Math.abs(c - col) !== ring) continue;
                    for (const i of this.cells[r * this.cols + c]) {
                        const dx = this.xs[i] - x;
                        const dy = this.ys[i] - y;
                        const d = dx * dx + dy * dy;
                        if (d < bestDistance) {
                            bestDistance = d;
                            best = i;
                        }
                    }
                }
            }
            // One more ring after the first hit: a point in a diagonal
            // neighbour can be closer than one found in this ring.
            if (best >= 0 && bestDistance <= (ring * this.cellSize) ** 2) break;
        }

        return best;
    }

    /** Indices of the `k` nearest points to point `self`, excluding itself. */
    nearestK(self: number, k: number): number[] {
        const x = this.xs[self];
        const y = this.ys[self];
        const found: { index: number; distance: number }[] = [];

        for (let ring = 0; ring < Math.max(this.cols, this.rows); ring++) {
            const col = Math.min(this.cols - 1, Math.max(0, Math.floor(x / this.cellSize)));
            const row = Math.min(this.rows - 1, Math.max(0, Math.floor(y / this.cellSize)));
            for (let r = row - ring; r <= row + ring; r++) {
                if (r < 0 || r >= this.rows) continue;
                for (let c = col - ring; c <= col + ring; c++) {
                    if (c < 0 || c >= this.cols) continue;
                    if (ring > 0 && Math.abs(r - row) !== ring && Math.abs(c - col) !== ring) continue;
                    for (const i of this.cells[r * this.cols + c]) {
                        if (i === self) continue;
                        const dx = this.xs[i] - x;
                        const dy = this.ys[i] - y;
                        found.push({ index: i, distance: dx * dx + dy * dy });
                    }
                }
            }
            if (found.length >= k * 2) break;
        }

        found.sort((a, b) => a.distance - b.distance);
        return found.slice(0, k).map(f => f.index);
    }
}

/**
 * Points whose density follows the demand map, spread by Lloyd relaxation.
 *
 * Returns coordinates in demand-map pixels.
 */
export function stipple(map: DemandMap, count: number, passes: number, random: Random): { xs: Float64Array; ys: Float64Array } {
    const { width, height, demand } = map;

    // Pixels with any ink demand at all, and their weights - the only ones a
    // point can be pulled toward.
    const inkedIndices: number[] = [];
    for (let i = 0; i < demand.length; i++) {
        if (demand[i] > INK_THRESHOLD) inkedIndices.push(i);
    }
    if (inkedIndices.length === 0) {
        return { xs: new Float64Array(0), ys: new Float64Array(0) };
    }

    // Rejection-sample a starting set, so relaxation begins somewhere sensible
    // rather than spending its passes dragging points out of the white.
    const xs = new Float64Array(count);
    const ys = new Float64Array(count);
    let placed = 0;
    let attempts = 0;
    const attemptLimit = count * 200;
    while (placed < count && attempts < attemptLimit) {
        attempts++;
        const x = random() * width;
        const y = random() * height;
        const value = demand[Math.min(demand.length - 1, ((y | 0) * width + (x | 0)))];
        if (random() < value) {
            xs[placed] = x;
            ys[placed] = y;
            placed++;
        }
    }
    // A very light image can run out of attempts; fall back to seeding from
    // the inked pixels themselves rather than returning a short set.
    while (placed < count) {
        const pick = inkedIndices[Math.floor(random() * inkedIndices.length)];
        xs[placed] = (pick % width) + 0.5;
        ys[placed] = ((pick / width) | 0) + 0.5;
        placed++;
    }

    const massTotal = new Float64Array(count);
    const massX = new Float64Array(count);
    const massY = new Float64Array(count);

    for (let pass = 0; pass < passes; pass++) {
        massTotal.fill(0);
        massX.fill(0);
        massY.fill(0);

        const grid = new PointGrid(xs, ys, width, height);
        for (const index of inkedIndices) {
            const px = (index % width) + 0.5;
            const py = ((index / width) | 0) + 0.5;
            const owner = grid.nearest(px, py);
            if (owner < 0) continue;
            const weight = demand[index];
            massTotal[owner] += weight;
            massX[owner] += weight * px;
            massY[owner] += weight * py;
        }

        for (let i = 0; i < count; i++) {
            if (massTotal[i] > 1e-9) {
                xs[i] = massX[i] / massTotal[i];
                ys[i] = massY[i] / massTotal[i];
            } else {
                // Stranded in bare paper: respawn it where there is ink to own.
                const pick = inkedIndices[Math.floor(random() * inkedIndices.length)];
                xs[i] = (pick % width) + 0.5;
                ys[i] = ((pick / width) | 0) + 0.5;
            }
        }
    }

    return { xs, ys };
}

/** Hilbert index of integer coordinates, for an order-`order` curve. */
export function hilbertIndex(x: number, y: number, order = 16): number {
    let rx = 0;
    let ry = 0;
    let d = 0;
    let cx = x;
    let cy = y;

    for (let s = 1 << (order - 1); s > 0; s >>= 1) {
        rx = (cx & s) > 0 ? 1 : 0;
        ry = (cy & s) > 0 ? 1 : 0;
        d += s * s * ((3 * rx) ^ ry);
        // Rotate the quadrant.
        if (ry === 0) {
            if (rx === 1) {
                cx = s - 1 - cx;
                cy = s - 1 - cy;
            }
            const swap = cx;
            cx = cy;
            cy = swap;
        }
    }
    return d;
}

/**
 * A tour through the points: Hilbert-ordered to start, improved by 2-opt
 * restricted to each city's nearest neighbours.
 *
 * Returns the visiting order as indices.
 */
export function tour(xs: Float64Array, ys: Float64Array, options: { neighbours: number; passes: number; width: number; height: number }): Int32Array {
    const n = xs.length;
    const route = new Int32Array(n);
    if (n < 4) {
        for (let i = 0; i < n; i++) route[i] = i;
        return route;
    }

    // --- Hilbert start ---------------------------------------------------
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        if (xs[i] < minX) minX = xs[i];
        if (xs[i] > maxX) maxX = xs[i];
        if (ys[i] < minY) minY = ys[i];
        if (ys[i] > maxY) maxY = ys[i];
    }
    const order = 16;
    const span = Math.max(maxX - minX, maxY - minY, 1e-9);
    const scale = ((1 << order) - 1) / span;

    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        keys[i] = hilbertIndex(Math.round((xs[i] - minX) * scale), Math.round((ys[i] - minY) * scale), order);
    }
    const byKey = Array.from({ length: n }, (_, i) => i).sort((a, b) => keys[a] - keys[b]);
    for (let i = 0; i < n; i++) route[i] = byKey[i];

    // --- neighbour-list 2-opt --------------------------------------------
    const grid = new PointGrid(xs, ys, options.width, options.height);
    const neighbours: number[][] = new Array(n);
    for (let i = 0; i < n; i++) neighbours[i] = grid.nearestK(i, options.neighbours);

    const position = new Int32Array(n);
    const distance = (a: number, b: number) => Math.hypot(xs[a] - xs[b], ys[a] - ys[b]);

    for (let pass = 0; pass < options.passes; pass++) {
        for (let i = 0; i < n; i++) position[route[i]] = i;

        let improved = false;
        for (let i = 0; i < n - 1; i++) {
            const a = route[i];
            const aNext = route[i + 1];
            for (const b of neighbours[a]) {
                const j = position[b];
                if (j <= i + 1 || j >= n - 1) continue;
                const bNext = route[j + 1];
                // Reversing route[i+1..j] swaps edges (a,aNext),(b,bNext) for
                // (a,b),(aNext,bNext).
                const gain = distance(a, aNext) + distance(b, bNext) - distance(a, b) - distance(aNext, bNext);
                if (gain > 1e-9) {
                    for (let lo = i + 1, hi = j; lo < hi; lo++, hi--) {
                        const swap = route[lo];
                        route[lo] = route[hi];
                        route[hi] = swap;
                    }
                    for (let k = i + 1; k <= j; k++) position[route[k]] = k;
                    improved = true;
                    break;
                }
            }
        }
        if (!improved) break;
    }

    return route;
}

/**
 * Splits a tour wherever an edge is longer than `maxEdge`.
 *
 * The long edges are the transits between dark regions; drawn, they are ruled
 * lines across the white paper.
 */
export function breakLongEdges(path: Point[], maxEdge: number): Point[][] {
    if (!(maxEdge > 0) || path.length < 3) return [path];

    const pieces: Point[][] = [];
    let start = 0;
    for (let i = 1; i < path.length; i++) {
        if (Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y) > maxEdge) {
            if (i - start >= 2) pieces.push(path.slice(start, i));
            start = i;
        }
    }
    if (path.length - start >= 2) pieces.push(path.slice(start));
    return pieces.length > 0 ? pieces : [path];
}

/**
 * Typical distance between neighbouring points, by sampling.
 *
 * Sampled rather than exhaustive: this only sets where the tour is cut, and a
 * few hundred points describe the spacing of a few thousand perfectly well.
 */
export function meanNeighbourSpacing(xs: Float64Array, ys: Float64Array, width: number, height: number, samples = 250): number {
    if (xs.length < 2) return 0;

    const grid = new PointGrid(xs, ys, width, height);
    const step = Math.max(1, Math.floor(xs.length / samples));
    let total = 0;
    let counted = 0;
    for (let i = 0; i < xs.length; i += step) {
        const nearest = grid.nearestK(i, 1);
        if (nearest.length === 0) continue;
        total += Math.hypot(xs[i] - xs[nearest[0]], ys[i] - ys[nearest[0]]);
        counted++;
    }
    return counted > 0 ? total / counted : 0;
}

/**
 * One tour through darkness-weighted stipple points, in MILLIMETRES, broken
 * wherever it would otherwise rule a line across the paper.
 */
export function tspScribble(map: DemandMap, options: TspOptions): Point[][] {
    const count = options.points ?? DEFAULT_POINTS;
    const passes = options.relaxationPasses ?? DEFAULT_RELAXATION_PASSES;
    const neighbours = options.neighbours ?? DEFAULT_NEIGHBOURS;
    const tourPasses = options.tourPasses ?? DEFAULT_TOUR_PASSES;
    const maxEdgeSpacings = options.maxEdgeSpacings ?? DEFAULT_MAX_EDGE_SPACINGS;

    const { xs, ys } = stipple(map, count, passes, options.random);
    if (xs.length === 0) return [];

    const route = tour(xs, ys, { neighbours, passes: tourPasses, width: map.width, height: map.height });

    const path: Point[] = [];
    for (let i = 0; i < route.length; i++) {
        path.push({ x: xs[route[i]] * map.mmPerPixel, y: ys[route[i]] * map.mmPerPixel });
    }

    const spacingMm = meanNeighbourSpacing(xs, ys, map.width, map.height) * map.mmPerPixel;
    return breakLongEdges(path, maxEdgeSpacings * spacingMm);
}
