"""Greedy residual-darkness walk - the other simple family.

No geometry model at all. Hold a 'residual darkness' buffer: the ink the image
still owes. From wherever the pen is, throw out K random candidate segments,
score each by the mean residual along it, draw the best one, subtract the ink
that stroke actually lays down, and repeat. Dark areas stay attractive until
they have been paid off, so density ends up tracking tone.

This is the family behind Vrellis-style string art and DrawingBotV3's sketch
path finders. Non-deterministic by construction: another seed gives a different
but equally valid drawing.
"""
import numpy as np


def greedy_scribble(d_target, n_strokes=45000, pen=1.4, seg_lo=5.0, seg_hi=22.0,
                    k=24, turn=2.4, seed=None, give_up=0.06, samples=20):
    rng = np.random.default_rng(seed)
    h, w = d_target.shape
    residual = d_target.copy()
    side = 0.5 * (pen - 1.0)        # ink spilling either side of the centreline
    ts = np.linspace(0.0, 1.0, samples)[None, :]

    # Hot-spot search runs over a coarse copy of the residual. Scanning the
    # full buffer every time the walk strands itself in paid-off paper
    # dominated the runtime; at 1/8 scale it is cheap and precise enough to
    # aim a restart.
    CELL = 8
    ch, cw = (h + CELL - 1) // CELL, (w + CELL - 1) // CELL

    def coarse():
        pad = np.zeros((ch * CELL, cw * CELL))
        pad[:h, :w] = residual
        return pad.reshape(ch, CELL, cw, CELL).max(axis=(1, 3))

    def pay(a, b):
        """Subtract the ink the stroke a->b actually puts on the paper.

        A pixel the nib crosses is paid in full; the nib's extra width pays its
        neighbours pro rata. Skip this and the walk keeps finding the same dark
        pixels attractive and hammers them to black."""
        seg = b - a
        length = float(np.hypot(*seg))
        n = max(2, int(length) + 1)
        t = np.linspace(0.0, 1.0, n)[:, None]
        pts = a[None, :] + seg[None, :] * t
        nrm = np.array([-seg[1], seg[0]]) / (length + 1e-9)
        for off, amt in ((0.0, 1.0), (1.0, side), (-1.0, side)):
            if amt <= 0.0:
                continue
            q = pts + nrm[None, :] * off
            xs = np.clip(q[:, 0], 0, w - 1).astype(np.int32)
            ys = np.clip(q[:, 1], 0, h - 1).astype(np.int32)
            np.subtract.at(residual, (ys, xs), amt)

    # Restart targets, darkest first. Rebuilding this is the one expensive
    # operation in the loop, so spend it once per batch of restarts rather
    # than once per restart - late in a drawing the walk strands itself
    # constantly and a rebuild each time dominates everything else.
    pending = []

    def refill():
        c = coarse()
        cells = np.argwhere(c > give_up)
        if cells.size == 0:
            return False
        order = np.argsort(c[cells[:, 0], cells[:, 1]])
        pending.extend(cells[order][-512:].tolist())
        return True

    polylines, cur = [], []
    iy, ix = np.unravel_index(int(np.argmax(residual)), residual.shape)
    p = np.array([float(ix), float(iy)])
    heading = rng.uniform(0, 2 * np.pi)

    for _ in range(n_strokes):
        ang = heading + rng.uniform(-turn, turn, k)
        ln = rng.uniform(seg_lo, seg_hi, k)
        ends = p[None, :] + np.stack([np.cos(ang), np.sin(ang)], axis=1) * ln[:, None]
        np.clip(ends[:, 0], 0, w - 1, out=ends[:, 0])
        np.clip(ends[:, 1], 0, h - 1, out=ends[:, 1])

        xs = (p[0] + (ends[:, 0:1] - p[0]) * ts).astype(np.int32)
        ys = (p[1] + (ends[:, 1:2] - p[1]) * ts).astype(np.int32)
        score = residual[ys, xs].mean(axis=1)
        best = int(np.argmax(score))

        if score[best] < give_up:
            # Stranded in paid-off paper: lift, restart in the darkest cell
            # that still owes ink.
            if len(cur) > 1:
                polylines.append(np.array(cur))
            cur = []
            if not pending and not refill():
                break
            cy, cx = pending.pop()
            # The coarse grid is padded up to a whole number of cells, so the
            # last row and column overhang the image; clamp back inside it.
            p = np.array([min(cx * CELL + rng.uniform(0, CELL), w - 1.0),
                          min(cy * CELL + rng.uniform(0, CELL), h - 1.0)])
            heading = rng.uniform(0, 2 * np.pi)
            continue

        end = ends[best]
        if not cur:
            cur = [tuple(p)]
        cur.append((float(end[0]), float(end[1])))
        pay(p, end)
        # Deliberately not clamping the buffer here: clipping all ~600k pixels
        # once per stroke was most of the runtime, and letting overdrawn
        # pixels go negative just makes them a little more repellent.
        heading = float(np.arctan2(end[1] - p[1], end[0] - p[0]))
        p = end

    if len(cur) > 1:
        polylines.append(np.array(cur))
    return polylines
