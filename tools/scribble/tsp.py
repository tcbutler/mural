"""TSP art: stipple the image, then join every dot with one closed tour.

Two stages, both standard:

  stipple()   weighted Voronoi relaxation - scatter points, then repeatedly
              move each to the darkness-weighted centroid of the pixels it
              owns. Points drift into dark areas and spread evenly within
              them. Secord 2002, and the front half of Bosch & Herman 2004.

  tour()      Hilbert-curve order for a starting tour, then 2-opt restricted
              to each city's k nearest neighbours. Not an optimal tour and it
              does not need to be; a few percent above optimal is
              indistinguishable by eye.

The result is one unbroken line that never crosses itself, which is the whole
appeal and also the limitation: no overdraw means no dense blacks, so tone
comes entirely from how closely the line packs.

Needs scipy for the k-d tree, unlike the rest of this directory.
"""
import numpy as np
from scipy.spatial import cKDTree


def stipple(d_target, n_points=6000, iters=12, seed=None, gamma=1.0):
    """Points whose density follows d_target, spread by Lloyd relaxation."""
    rng = np.random.default_rng(seed)
    h, w = d_target.shape
    weight = np.clip(d_target, 0.0, 1.0) ** gamma

    # rejection-sample a starting set so relaxation begins somewhere sensible
    pts = []
    while len(pts) < n_points:
        n = (n_points - len(pts)) * 3
        xs = rng.uniform(0, w, n)
        ys = rng.uniform(0, h, n)
        keep = rng.uniform(0, 1, n) < weight[ys.astype(int), xs.astype(int)]
        pts.extend(zip(xs[keep], ys[keep]))
    p = np.array(pts[:n_points])

    # pixels with any ink demand at all, and their weights
    yy, xx = np.nonzero(weight > 1e-3)
    wv = weight[yy, xx]
    px = xx + 0.5
    py = yy + 0.5

    for _ in range(iters):
        _, owner = cKDTree(p).query(np.stack([px, py], axis=1), workers=-1)
        mass = np.bincount(owner, weights=wv, minlength=len(p))
        cx = np.bincount(owner, weights=wv * px, minlength=len(p))
        cy = np.bincount(owner, weights=wv * py, minlength=len(p))
        live = mass > 1e-9
        p[live] = np.stack([cx[live] / mass[live], cy[live] / mass[live]], axis=1)
        # a point that owns nothing is stranded in white paper; respawn it
        if (~live).any():
            idx = np.nonzero(~live)[0]
            pick = rng.integers(0, len(px), len(idx))
            p[idx] = np.stack([px[pick], py[pick]], axis=1)
    return p


def _hilbert_d(x, y, order=16):
    """Hilbert index of integer coordinates, vectorised."""
    rx = np.zeros_like(x)
    ry = np.zeros_like(x)
    d = np.zeros_like(x)
    x = x.copy()
    y = y.copy()
    s = 1 << (order - 1)
    while s > 0:
        rx = ((x & s) > 0).astype(np.int64)
        ry = ((y & s) > 0).astype(np.int64)
        d += s * s * ((3 * rx) ^ ry)
        # rotate the quadrant
        swap = ry == 0
        flip = swap & (rx == 1)
        x[flip] = s - 1 - x[flip]
        y[flip] = s - 1 - y[flip]
        tx = x[swap].copy()
        x[swap] = y[swap]
        y[swap] = tx
        s >>= 1
    return d


def tour(points, k=10, passes=60, order=16):
    """Hilbert-ordered start, improved by neighbour-list 2-opt."""
    n = len(points)
    if n < 4:
        return np.arange(n)

    lo = points.min(axis=0)
    span = max(float((points.max(axis=0) - lo).max()), 1e-9)
    scale = ((1 << order) - 1) / span
    gx = ((points[:, 0] - lo[0]) * scale).astype(np.int64)
    gy = ((points[:, 1] - lo[1]) * scale).astype(np.int64)
    route = np.argsort(_hilbert_d(gx, gy, order))

    nbr = cKDTree(points).query(points, k=min(k + 1, n), workers=-1)[1][:, 1:]
    pos = np.empty(n, dtype=np.int64)

    for _ in range(passes):
        pos[route] = np.arange(n)
        # For city a at tour position i with neighbour b at position j,
        # reversing route[i+1..j] swaps edges (a,a_next),(b,b_next) for
        # (a,b),(a_next,b_next). Evaluate every candidate at once.
        i = pos                                   # position of each city
        j = pos[nbr]                              # positions of its neighbours
        a = points
        an = points[route[(i + 1) % n]]
        b = points[nbr]
        bn = points[route[(j + 1) % n]]
        d = lambda u, v: np.hypot(u[..., 0] - v[..., 0], u[..., 1] - v[..., 1])
        gain = (d(a[:, None], an[:, None]) + d(b, bn)
                - d(a[:, None], b) - d(an[:, None], bn))

        cand = np.nonzero(gain > 1e-9)
        if len(cand[0]) == 0:
            break
        g = gain[cand]
        take = np.argsort(-g)
        lo_i = np.minimum(i[cand[0]], j[cand])
        hi_i = np.maximum(i[cand[0]], j[cand])

        # apply the best non-overlapping reversals this pass
        touched = np.zeros(n, dtype=bool)
        applied = 0
        for t in take:
            s, e = lo_i[t], hi_i[t]
            if e - s < 1 or e - s > n - 2:
                continue
            if touched[s:e + 2].any():
                continue
            touched[s:e + 2] = True
            route[s + 1:e + 1] = route[s + 1:e + 1][::-1]
            applied += 1
        if applied == 0:
            break
    return route


def tsp_art(d_target, n_points=6000, iters=12, k=10, passes=60, seed=None,
            gamma=1.0):
    """One closed polyline through darkness-weighted stipple points."""
    p = stipple(d_target, n_points=n_points, iters=iters, seed=seed, gamma=gamma)
    r = tour(p, k=k, passes=passes)
    closed = np.concatenate([p[r], p[r[:1]]], axis=0)
    return [closed], p


def break_long(closed, max_edge):
    """Split the tour wherever an edge is longer than max_edge.

    An optimal tour still has to get from one dark region to another, and on
    paper those transits read as straight lines ruled across the white. A
    plotter can just lift instead: cutting the N worst edges costs N pen lifts
    and removes N ruled lines. Set max_edge to a few line spacings.
    """
    if max_edge <= 0 or len(closed) < 3:
        return [closed]
    seg = np.hypot(*np.diff(closed, axis=0).T)
    cuts = np.nonzero(seg > max_edge)[0]
    if len(cuts) == 0:
        return [closed]
    out = []
    start = 0
    for c in cuts:
        if c + 1 - start >= 2:
            out.append(closed[start:c + 1])
        start = c + 1
    if len(closed) - start >= 2:
        out.append(closed[start:])
    return out
