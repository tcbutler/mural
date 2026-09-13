"""Contour-following loop scribble - the feature-aware half of Chiu et al.

Same loop-riding idea as cycloid.py and the same derived advance rate, but the
guide path follows the image's own structure instead of scanlines. The loops
then lie along the form of the subject the way hand-drawn scribble does,
rather than in horizontal bands across it.

The tone maths is unchanged, which is the point of deriving it rather than
tuning it: swapping the guide path does not disturb the greys.
"""
import numpy as np

from common import sample
from field import orientation_field, streamlines


def _resample(pts, step=1.0):
    """Arc-length resample a polyline, returning points and unit tangents."""
    d = np.diff(pts, axis=0)
    seg = np.hypot(d[:, 0], d[:, 1])
    keep = seg > 1e-9
    if not keep.any():
        return None, None, 0.0
    pts = np.vstack([pts[:-1][keep], pts[-1]])
    d = np.diff(pts, axis=0)
    seg = np.hypot(d[:, 0], d[:, 1])
    s = np.concatenate([[0.0], np.cumsum(seg)])
    total = float(s[-1])
    if total < step * 2:
        return None, None, 0.0
    u = np.arange(0.0, total, step)
    x = np.interp(u, s, pts[:, 0])
    y = np.interp(u, s, pts[:, 1])
    tx = np.gradient(x)
    ty = np.gradient(y)
    n = np.hypot(tx, ty)
    n[n < 1e-9] = 1.0
    return np.stack([x, y], axis=1), np.stack([tx / n, ty / n], axis=1), total


def contour_scribble(d_target, gray=None, d_sep=9.0, pen=1.4, r_lo=0.60,
                     r_hi=0.95, d_floor=0.04, seed=None, jitter=0.35,
                     squash=1.0, lift=True, dtheta=0.32, max_ink=0.985,
                     sigma_grad=1.6, sigma_tensor=6.0, coh_floor=0.12):
    """d_target: HxW wanted ink coverage. gray: source luminance for the
    orientation field (defaults to 1 - d_target). Returns polylines."""
    rng = np.random.default_rng(seed)
    h, w = d_target.shape
    if gray is None:
        gray = 1.0 - d_target

    tx, ty, coh = orientation_field(gray, sigma_grad, sigma_tensor)
    guides = streamlines(tx, ty, coh, d_sep=d_sep, coh_floor=coh_floor,
                         seed=None if seed is None else seed + 1)

    r_min, r_max = r_lo * d_sep, r_hi * d_sep
    polylines = []

    for g in guides:
        pts, tans, total = _resample(g, step=1.0)
        if pts is None:
            continue
        cur = []
        s = 0.0
        theta = rng.uniform(0, 2 * np.pi)
        while s < total - 1.0:
            i = int(s)
            cx, cy = pts[i]
            d = sample(d_target, cx, cy)
            if lift and d < d_floor:
                if len(cur) > 1:
                    polylines.append(np.array(cur))
                cur = []
                s += d_sep
                continue

            r = r_min + (r_max - r_min) * (1.0 - d) ** 0.7
            r *= 1.0 + 0.18 * rng.standard_normal()
            # see cycloid.py: Poisson coverage inverted for the ink this tone
            # demands, floored so that pure white cannot divide by -0.0
            demand = max(-np.log(max(1.0 - max_ink * d, 1e-3)), 1e-3)
            adv = 2.0 * np.pi * r * pen / demand / d_sep
            adv = float(np.clip(adv, 0.05 * d_sep, 6.0 * d_sep))

            theta += dtheta
            s += adv * dtheta / (2.0 * np.pi)
            # draw the loop in the guide's own frame, so it leans with the form
            ux, uy = r * np.cos(theta), r * np.sin(theta) * squash
            t = tans[min(i, len(tans) - 1)]
            px = cx + ux * t[0] - uy * t[1]
            py = cy + ux * t[1] + uy * t[0]
            if jitter:
                px += jitter * rng.standard_normal()
                py += jitter * rng.standard_normal()
            cur.append((px, py))

        if len(cur) > 1:
            polylines.append(np.array(cur))
    return polylines
