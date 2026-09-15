// Cutting the pen lifts out of a scribble.
//
// The greedy walk produces thousands of short chains, because it keeps
// stranding itself in paper it has already paid off. Each chain is a pen lift,
// and a lift costs about four seconds of machine time - a pen-down, a pen-up,
// and the travel between - regardless of how long the strokes either side of it
// are. So the chain count, not the ink, sets the plot time: a horse drawn in
// 1,149 chains spends over an hour lifting.
//
// Two passes, in this order, and they are not the same kind of change:
//
//   order()  reorders and reverses chains so the pen finishes each one near the
//            start of the next. Does not alter the drawing at all - the same
//            strokes in a different sequence - so it is free.
//
//   join()   merges consecutive chains whose ends are now close enough that
//            drawing the gap is cheaper than lifting over it. This DOES alter
//            the drawing: it adds ink the image never asked for, which is why
//            the threshold belongs near a nib width or two and not higher.
import { Point } from './greedy';

function distance(a: Point, b: Point): number {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Greedy nearest-neighbour tour of the chains, reversing one where that is the
 * closer end.
 *
 * O(n^2) over chains, which is fine at the few thousand a walk produces and is
 * the same shape as the optimiser the renderer already runs over infill.
 */
export function orderChains(chains: Point[][]): Point[][] {
    if (chains.length < 3) return chains.slice();

    const used = new Array<boolean>(chains.length).fill(false);
    const ordered: Point[][] = [chains[0]];
    used[0] = true;
    let at = chains[0][chains[0].length - 1];

    for (let placed = 1; placed < chains.length; placed++) {
        let bestIndex = -1;
        let bestDistance = Infinity;
        let bestReversed = false;

        for (let i = 0; i < chains.length; i++) {
            if (used[i]) continue;
            const chain = chains[i];
            const toStart = distance(at, chain[0]);
            if (toStart < bestDistance) {
                bestDistance = toStart;
                bestIndex = i;
                bestReversed = false;
            }
            const toEnd = distance(at, chain[chain.length - 1]);
            if (toEnd < bestDistance) {
                bestDistance = toEnd;
                bestIndex = i;
                bestReversed = true;
            }
        }

        const chain = bestReversed ? chains[bestIndex].slice().reverse() : chains[bestIndex];
        used[bestIndex] = true;
        ordered.push(chain);
        at = chain[chain.length - 1];
    }

    return ordered;
}

/**
 * Merges consecutive chains separated by no more than `maxGapMm`.
 *
 * Run this after orderChains, never before: on the order the walk produced
 * them, consecutive chains are wherever the walk happened to restart, and
 * almost none of them are adjacent.
 */
export function joinChains(chains: Point[][], maxGapMm: number): Point[][] {
    if (!(maxGapMm > 0) || chains.length === 0) return chains.slice();

    const joined: Point[][] = [chains[0].slice()];
    for (let i = 1; i < chains.length; i++) {
        const previous = joined[joined.length - 1];
        const gap = distance(previous[previous.length - 1], chains[i][0]);
        if (gap <= maxGapMm) {
            previous.push(...chains[i]);
        } else {
            joined.push(chains[i].slice());
        }
    }
    return joined;
}

export type StitchSummary = {
    chains: number;
    drawnMm: number;
    travelMm: number;
};

/** What a set of chains costs: ink drawn, and pen-up travel between them. */
export function measureChains(chains: Point[][]): StitchSummary {
    let drawn = 0;
    let travel = 0;
    let previousEnd: Point | undefined;

    for (const chain of chains) {
        for (let i = 1; i < chain.length; i++) {
            drawn += distance(chain[i - 1], chain[i]);
        }
        if (previousEnd) travel += distance(previousEnd, chain[0]);
        previousEnd = chain[chain.length - 1];
    }

    return { chains: chains.length, drawnMm: drawn, travelMm: travel };
}

/** order(), then join() when a gap budget is given. */
export function stitch(chains: Point[][], maxGapMm = 0): Point[][] {
    const ordered = orderChains(chains);
    return maxGapMm > 0 ? joinChains(ordered, maxGapMm) : ordered;
}
