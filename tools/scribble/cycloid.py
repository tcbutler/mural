"""Tone-modulated loop scribble (simplified Chiu et al. 2015).

One continuous pen path snakes across the image in rows. Riding on it is a
circle the pen keeps tracing; how fast that circle's centre advances is set by
how dark the image is underneath. Slow advance = loops pile up = dark. Fast
advance = loops stretch out = light.

The advance rate is not eyeballed. Over one loop the pen lays ~2*pi*r of ink of
width `pen` into a patch `advance` wide by `row_step` tall. Overlapping ink is
wasted ink, which a linear model ignores and then saturates around 50% grey, so
use the Poisson/Beer-Lambert coverage law instead:

    coverage = 1 - exp(-length * pen / area)

Invert it for the length the tone demands, and solve for advance. Tone is then
correct by construction and the remaining knobs are purely about looks.
"""
import numpy as np
from common import sample


def cycloid_scribble(d_target, row_step=9.0, pen=1.4, r_lo=0.60, r_hi=0.95,
                     d_floor=0.04, seed=None, jitter=0.35, wobble=0.5,
                     squash=1.0, lift=True, dtheta=0.32, max_ink=0.985,
                     tilt=0.9):
    """d_target: HxW wanted ink coverage in [0,1]. Returns a list of polylines."""
    rng = np.random.default_rng(seed)
    h, w = d_target.shape
    r_min, r_max = r_lo * row_step, r_hi * row_step
    lam = row_step * rng.uniform(2.5, 4.5)      # guide-path wobble wavelength

    polylines, cur = [], []
    y = row_step * 0.5
    direction = 1
    while y < h:
        cx = 0.0 if direction > 0 else float(w)
        theta = rng.uniform(0, 2 * np.pi)
        phase = rng.uniform(0, 2 * np.pi)
        phi = rng.uniform(0, np.pi)          # loop tilt, random-walks as we go
        guard = 0
        while -1.0 <= cx <= w + 1.0 and guard < 400000:
            guard += 1
            cy = y + wobble * row_step * np.sin(cx / lam + phase)
            d = sample(d_target, cx, cy)
            if lift and d < d_floor:
                if len(cur) > 1:
                    polylines.append(np.array(cur))
                cur = []
                cx += direction * row_step        # skip blank paper quickly
                continue

            r = r_min + (r_max - r_min) * (1.0 - d) ** 0.7
            r *= 1.0 + 0.18 * rng.standard_normal()
            # Floor the demand: at d == 0 this is -log(1) == -0.0, and
            # dividing by negative zero gives -inf, which the clamp below
            # turns into the *tightest* advance rather than the loosest -
            # white paper comes out solid black.
            demand = max(-np.log(max(1.0 - max_ink * d, 1e-3)), 1e-3)
            adv = 2.0 * np.pi * r * pen / demand / row_step
            adv = float(np.clip(adv, 0.05 * row_step, 6.0 * row_step))

            theta += dtheta
            phi += tilt * dtheta * 0.15 * rng.standard_normal()
            cx += direction * adv * dtheta / (2.0 * np.pi)
            # ellipse tilted by phi: overdrawn loops in dark areas then cross
            # each other instead of stacking into a solid bar
            ux, uy = r * np.cos(theta), r * np.sin(theta) * squash
            px = cx + ux * np.cos(phi) - uy * np.sin(phi)
            py = cy + ux * np.sin(phi) + uy * np.cos(phi)
            if jitter:
                px += jitter * rng.standard_normal()
                py += jitter * rng.standard_normal()
            cur.append((px, py))

        if len(cur) > 1:
            polylines.append(np.array(cur))
            cur = []
        y += row_step
        direction *= -1
    if len(cur) > 1:
        polylines.append(np.array(cur))
    if not lift and polylines:
        # The rows already alternate direction, so each one ends where the
        # next begins: concatenating them gives the single unbroken line the
        # flag promises rather than one stroke per row.
        return [np.concatenate(polylines, axis=0)]
    return polylines
