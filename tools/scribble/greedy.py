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
                    k=24, turn=2.4, seed=None, give_up=None, samples=20):
    rng = np.random.default_rng(seed)
    h, w = d_target.shape
    # The residual is held in units of *ink still owed*, not of coverage.
    # Ink landing on ink covers no new paper, so a region asking for 90%
    # coverage needs far more than 0.9 units of line through it; the Poisson
    # law that cycloid.py uses for its advance rate inverts the same way here.
    # Without it the walk under-inks every dark region.
    residual = -np.log(np.clip(1.0 - 0.985 * d_target, 1e-3, 1.0))
    if give_up is None:
        # Relative to what this image is actually asking for. A fixed floor
        # silently becomes "skip most of the picture" on a lightly-inked
        # image, which reads as the algorithm failing when it is really the
        # threshold being in the wrong units.
        ink = residual[residual > 1e-3]
        give_up = 0.25 * float(np.median(ink)) if ink.size else 0.06
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

    # Ink is paid into a band, not onto a line. A pixel asking for 0.3
    # coverage is asking for a line to pass near it three times in ten, not
    # for one line straight through it - so charging the centreline a full
    # 1.0 pays off a light region after a single stroke and the walk keeps
    # coming back. Spreading the same total across a band of PAY_R either
    # side makes the units right: a stroke contributes `pen` units of covered
    # area per unit length, wherever that area lands.
    PAY_R = 5
    offs = np.arange(-PAY_R, PAY_R + 1, dtype=np.float64)
    per_off = pen / len(offs)

    def pay(a, b):
        """Subtract the covered area the stroke a->b contributes locally."""
        seg = b - a
        length = float(np.hypot(*seg))
        n = max(2, int(length) + 1)
        t = np.linspace(0.0, 1.0, n)[:, None]
        pts = a[None, :] + seg[None, :] * t
        nrm = np.array([-seg[1], seg[0]]) / (length + 1e-9)
        q = pts[None, :, :] + nrm[None, None, :] * offs[:, None, None]
        xs = np.clip(q[..., 0], 0, w - 1).astype(np.int32).ravel()
        ys = np.clip(q[..., 1], 0, h - 1).astype(np.int32).ravel()
        np.subtract.at(residual, (ys, xs), per_off)

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
