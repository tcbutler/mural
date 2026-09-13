"""Orientation field and evenly-spaced streamlines.

The row-based scribble lies in horizontal bands regardless of what is
underneath, which is why its dark areas read as banding where hand-drawn
scribble reads as fur. Fixing that means running the guide path along the
image's own structure instead of along scanlines, so this module builds two
things:

  orientation_field()  the local direction of "along the form", i.e.
                       perpendicular to the luminance gradient, resolved with
                       a structure tensor so it stays coherent across an edge.

  streamlines()        a set of curves following that field, spaced roughly
                       d_sep apart, covering the image. Jobard & Lefebvre's
                       evenly-spaced streamline placement (1997), which is the
                       standard way to get even coverage without clumping.

Only numpy is needed - the Gaussian smoothing is a small separable kernel
rather than a scipy dependency.
"""
import numpy as np


def _gauss1d(sigma):
    r = max(1, int(3.0 * sigma))
    x = np.arange(-r, r + 1, dtype=np.float64)
    k = np.exp(-0.5 * (x / sigma) ** 2)
    return k / k.sum()


def blur(a, sigma):
    """Separable Gaussian blur with edge clamping."""
    if sigma <= 0:
        return a.copy()
    k = _gauss1d(sigma)
    r = len(k) // 2
    p = np.pad(a, ((0, 0), (r, r)), mode="edge")
    out = np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 1, p)
    p = np.pad(out, ((r, r), (0, 0)), mode="edge")
    return np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), 0, p)


def orientation_field(gray, sigma_grad=1.6, sigma_tensor=6.0):
    """Return (tx, ty, coherence), all HxW.

    (tx, ty) is a unit vector along the image structure - the direction you
    would stroke to follow the form. It is an *orientation*, not a direction:
    the sign is arbitrary and callers must keep it consistent themselves.

    Smoothing happens on the structure tensor rather than on the vectors,
    because averaging vectors across an edge cancels them to nothing whereas
    averaging the tensor does not.
    """
    g = blur(gray, sigma_grad)
    gy, gx = np.gradient(g)

    jxx = blur(gx * gx, sigma_tensor)
    jyy = blur(gy * gy, sigma_tensor)
    jxy = blur(gx * gy, sigma_tensor)

    # eigen-decomposition of the 2x2 symmetric tensor, closed form
    diff = jxx - jyy
    root = np.sqrt(diff * diff + 4.0 * jxy * jxy)
    lam1 = 0.5 * (jxx + jyy + root)          # across the structure
    lam2 = 0.5 * (jxx + jyy - root)          # along it

    # minor eigenvector = along the structure = perpendicular to the gradient
    tx = 2.0 * jxy
    ty = jyy - jxx + root
    n = np.hypot(tx, ty)
    flat = n < 1e-12
    tx = np.where(flat, 1.0, tx / np.where(flat, 1.0, n))
    ty = np.where(flat, 0.0, ty / np.where(flat, 1.0, n))

    total = lam1 + lam2
    coh = np.where(total > 1e-12, (lam1 - lam2) / np.where(total > 1e-12, total, 1.0), 0.0)
    return tx, ty, np.clip(coh, 0.0, 1.0)


class _Occupancy:
    """Grid of accepted sample points, for 'is anything within r of here?'."""

    def __init__(self, h, w, cell):
        self.cell = cell
        self.nx = int(w // cell) + 2
        self.ny = int(h // cell) + 2
        self.bins = [[] for _ in range(self.nx * self.ny)]

    def _idx(self, x, y):
        return int(y / self.cell) * self.nx + int(x / self.cell)

    def add(self, x, y):
        self.bins[self._idx(x, y)].append((x, y))

    def too_close(self, x, y, r):
        cx, cy = int(x / self.cell), int(y / self.cell)
        r2 = r * r
        for jy in range(max(0, cy - 1), min(self.ny, cy + 2)):
            row = jy * self.nx
            for jx in range(max(0, cx - 1), min(self.nx, cx + 2)):
                for (px, py) in self.bins[row + jx]:
                    if (px - x) ** 2 + (py - y) ** 2 < r2:
                        return True
        return False


def streamlines(tx, ty, coh, d_sep=9.0, d_test_frac=0.55, step=1.0,
                max_len=4000, min_len=12.0, fallback=0.0, coh_floor=0.12,
                seed=None):
    """Curves following the orientation field, spaced about d_sep apart.

    Where the field has no opinion (coherence below coh_floor, e.g. a flat
    expanse of sky) the direction is blended towards `fallback`, so those
    regions get sane parallel strokes instead of a random walk.
    """
    rng = np.random.default_rng(seed)
    h, w = tx.shape
    d_test = d_test_frac * d_sep
    occ = _Occupancy(h, w, d_sep)
    fx, fy = np.cos(fallback), np.sin(fallback)

    def field_at(x, y):
        xi = int(np.clip(x, 0, w - 1))
        yi = int(np.clip(y, 0, h - 1))
        c = coh[yi, xi]
        vx, vy = tx[yi, xi], ty[yi, xi]
        if c < coh_floor:
            # lerp towards the fallback direction, resolving the orientation
            # ambiguity towards it first so the blend cannot cancel out
            if vx * fx + vy * fy < 0:
                vx, vy = -vx, -vy
            k = c / coh_floor
            vx, vy = k * vx + (1 - k) * fx, k * vy + (1 - k) * fy
        n = np.hypot(vx, vy)
        return (vx / n, vy / n) if n > 1e-9 else (fx, fy)

    def integrate(x0, y0, sign):
        """RK2 march from a seed until the curve crowds an existing one."""
        pts = []
        x, y = x0, y0
        px, py = field_at(x, y)
        px, py = px * sign, py * sign
        for _ in range(max_len):
            if not (0 <= x < w and 0 <= y < h):
                break
            if pts and occ.too_close(x, y, d_test):
                break
            pts.append((x, y))
            # half step, re-sample, full step (RK2)
            hx, hy = field_at(x + px * step * 0.5, y + py * step * 0.5)
            if hx * px + hy * py < 0:          # keep the orientation coherent
                hx, hy = -hx, -hy
            x += hx * step
            y += hy * step
            px, py = hx, hy
        return pts

    lines = []
    queue = [(rng.uniform(0, w), rng.uniform(0, h))]
    guard = 0
    while queue and guard < 200000:
        guard += 1
        sx, sy = queue.pop(0)
        if not (0 <= sx < w and 0 <= sy < h) or occ.too_close(sx, sy, d_sep * 0.9):
            continue
        fwd = integrate(sx, sy, +1)
        back = integrate(sx, sy, -1)
        pts = back[::-1][:-1] + fwd if fwd and back else (fwd or back)
        if len(pts) * step < min_len:
            continue
        for (x, y) in pts[::2]:
            occ.add(x, y)
        lines.append(np.array(pts))

        # seed the next generation d_sep to either side of this curve
        for i in range(0, len(pts), max(1, int(d_sep / step))):
            x, y = pts[i]
            j = min(i + 1, len(pts) - 1)
            dx, dy = pts[j][0] - x, pts[j][1] - y
            n = np.hypot(dx, dy)
            if n < 1e-9:
                continue
            nx_, ny_ = -dy / n, dx / n
            queue.append((x + nx_ * d_sep, y + ny_ * d_sep))
            queue.append((x - nx_ * d_sep, y - ny_ * d_sep))

        if not queue:
            # field may have left pockets unvisited; probe for them
            for _ in range(200):
                cx, cy = rng.uniform(0, w), rng.uniform(0, h)
                if not occ.too_close(cx, cy, d_sep * 0.9):
                    queue.append((cx, cy))
                    break
    return lines
