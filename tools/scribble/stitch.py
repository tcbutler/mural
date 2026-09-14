"""Cut pen lifts by reordering and joining strokes.

The greedy walk produces thousands of short chains because it keeps stranding
itself in paper it has already paid off. Each chain is a pen lift, and a lift
costs about two seconds of machine time regardless of how long the stroke
either side of it is, so the chain count - not the ink - sets the plot time.

Two passes, in order:

  order()  greedy nearest-neighbour over chain endpoints, either end allowed,
           so the pen finishes each chain next to the start of the following
           one. Does not change the drawing at all; it only shortens the
           pen-up travel and sets up the second pass.

  join()   merge consecutive chains whose ends are now close enough that
           drawing the gap costs less than lifting over it. This does change
           the drawing: it adds ink the image did not ask for, which is why
           the threshold wants to stay near a nib width or two.
"""
import numpy as np


def order(polylines):
    """Greedy nearest-neighbour tour of the chains, reversing where it helps."""
    if len(polylines) < 3:
        return list(polylines)
    starts = np.array([pl[0] for pl in polylines])
    ends = np.array([pl[-1] for pl in polylines])
    n = len(polylines)
    used = np.zeros(n, dtype=bool)

    out = [polylines[0]]
    used[0] = True
    p = ends[0]
    for _ in range(n - 1):
        ds = np.where(used, np.inf, ((starts - p) ** 2).sum(axis=1))
        de = np.where(used, np.inf, ((ends - p) ** 2).sum(axis=1))
        i_s, i_e = int(np.argmin(ds)), int(np.argmin(de))
        if de[i_e] < ds[i_s]:
            out.append(polylines[i_e][::-1])
            p = starts[i_e]
            used[i_e] = True
        else:
            out.append(polylines[i_s])
            p = ends[i_s]
            used[i_s] = True
    return out


def join(polylines, max_gap):
    """Merge consecutive chains separated by no more than max_gap."""
    if not polylines:
        return []
    out = [polylines[0]]
    for pl in polylines[1:]:
        gap = float(np.hypot(*(pl[0] - out[-1][-1])))
        if gap <= max_gap:
            out[-1] = np.concatenate([out[-1], pl], axis=0)
        else:
            out.append(pl)
    return out


def tidy(polylines, max_gap=0.0):
    """order(), then join() if a gap budget is given."""
    out = order(polylines)
    return join(out, max_gap) if max_gap > 0 else out


def travel(polylines):
    """(drawn length, pen-up length) - what the reorder is actually buying."""
    drawn = up = 0.0
    prev = None
    for pl in polylines:
        if len(pl) > 1:
            drawn += float(np.hypot(*np.diff(pl, axis=0).T).sum())
        if prev is not None:
            up += float(np.hypot(*(pl[0] - prev)))
        prev = pl[-1]
    return drawn, up
