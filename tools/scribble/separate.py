"""Split a colour image into one ink-coverage map per pen.

Each pen gets its own scribble, drawn in its own colour, and the coverage maps
are what tell each pass where to put ink. Getting them right is the whole job:
tinting a greyscale scribble orange does not make a two-colour drawing, it
makes an orange greyscale scribble.

Ink is subtractive, so the arithmetic happens in density rather than in
reflectance. A pen laying down colour P on white paper multiplies what comes
back off the page, and multiplication becomes addition under a logarithm:

    density(C) = -log(C)          per RGB channel
    density(pixel) ~= sum over pens of coverage_i * density(pen_i)

Solving that for non-negative coverages is a three-equation non-negative least
squares per pixel. Non-negative matters - an unconstrained fit will happily
ask for a negative amount of green to make something oranger, which no pen can
do. Colours are quantised first so the solve runs a few thousand times instead
of half a million.

Needs scipy, like tsp.py.
"""
import numpy as np
from scipy.optimize import nnls

EPS = 1.0 / 255.0


def auto_pens(rgb, n=2, sat_floor=0.12, iters=24, seed=None, target_lum=0.30):
    """Pick n pen colours by k-means over the image's chromatic pixels.

    Near-neutral pixels are excluded: paper, shadow and sky pull the means
    towards grey, and a grey pen tells you nothing a darker one would not.
    """
    rng = np.random.default_rng(seed)
    flat = rgb.reshape(-1, 3)
    sat = flat.max(axis=1) - flat.min(axis=1)
    pool = flat[sat > sat_floor]
    if len(pool) < n * 32:
        pool = flat
    if len(pool) > 60000:
        pool = pool[rng.choice(len(pool), 60000, replace=False)]

    # Cluster chromaticity, not colour. On raw RGB the means separate by
    # brightness, so a ginger cat and a green hedge - which differ in hue and
    # barely at all in tone - both come back as the same olive.
    chroma = pool / np.clip(pool.sum(axis=1, keepdims=True), EPS, None)
    centres = chroma[rng.choice(len(chroma), n, replace=False)].copy()
    owner = np.zeros(len(chroma), dtype=np.int64)
    for _ in range(iters):
        dist = ((chroma[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2)
        owner = np.argmin(dist, axis=1)
        for i in range(n):
            m = owner == i
            if m.any():
                centres[i] = chroma[m].mean(axis=0)
            else:
                centres[i] = chroma[rng.integers(len(chroma))]

    # A pen is a physical ink: saturated, and *darker* than the average colour
    # it has to reproduce. Take each cluster's hue, drive the saturation up,
    # then scale it down to a pen-like luminance. Skipping that second step
    # gives pastel pens that need impossible coverage to reach the image's
    # mid-tones, and one pen ends up carrying the whole drawing.
    out = []
    for i in range(n):
        m = owner == i
        c = centres[i] if not m.any() else pool[m].mean(axis=0)
        c = c / max(float(c.max()), EPS)
        lo = float(c.min())
        c = np.clip((c - lo * 0.8) / max(1.0 - lo * 0.8, EPS), 0.0, 1.0)
        lum = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
        c = c * (target_lum / max(lum, EPS))
        out.append(np.clip(c, 0.02, 0.97))
    return np.array(out)


def white_balance(rgb, pct=98.0, gain=1.0):
    """Scale each channel so the image's brightest tones become bare paper.

    Without this, a slightly grey or slightly warm paper in the photograph has
    a non-zero density, and the solve dutifully spends ink reproducing it -
    the colour version of the white-point problem that turns a greyscale
    scribble into a grey field.
    """
    ref = np.percentile(rgb.reshape(-1, 3), pct, axis=0)
    ref = np.clip(ref, 0.25, None) / max(gain, EPS)
    return np.clip(rgb / ref[None, None, :], 0.0, 1.0)


def separate(rgb, pens, bits=5, max_coverage=1.0):
    """Per-pen coverage maps in [0, max_coverage], same HxW as the image."""
    pens = np.clip(np.asarray(pens, dtype=np.float64), EPS, 1.0 - EPS)
    dens_pen = -np.log(pens).T                      # 3 x n_pens

    h, w, _ = rgb.shape
    q = np.clip(rgb, EPS, 1.0)
    step = 1 << (8 - bits)
    key = (np.clip(q * 255, 0, 255).astype(np.int32) // step)
    flat_key = (key[..., 0] << (2 * bits)) | (key[..., 1] << bits) | key[..., 2]
    uniq, inverse = np.unique(flat_key.ravel(), return_inverse=True)

    # representative colour for each quantised bucket, at the bucket centre
    mask = (1 << bits) - 1
    r = (uniq >> (2 * bits)) & mask
    g = (uniq >> bits) & mask
    b = uniq & mask
    rep = (np.stack([r, g, b], axis=1) * step + step / 2) / 255.0
    rep = np.clip(rep, EPS, 1.0)

    dens = -np.log(rep)                             # n_uniq x 3
    sol = np.empty((len(uniq), len(pens)))
    for i, d in enumerate(dens):
        sol[i] = nnls(dens_pen, d)[0]

    sol = np.clip(sol, 0.0, max_coverage)
    return [sol[inverse, i].reshape(h, w) for i in range(len(pens))]


def load_rgb(path, width=800):
    from PIL import Image
    im = Image.open(path).convert("RGB")
    hh = round(im.height * width / im.width)
    im = im.resize((width, hh), Image.LANCZOS)
    return np.asarray(im, dtype=np.float64) / 255.0


def parse_pens(spec):
    """'#c06030,#4a7a3a' -> Nx3 array in [0,1]."""
    out = []
    for tok in spec.split(","):
        t = tok.strip().lstrip("#")
        if len(t) != 6:
            raise ValueError(f"pen colour must be 6 hex digits, got {tok!r}")
        out.append([int(t[i:i + 2], 16) / 255.0 for i in (0, 2, 4)])
    return np.array(out)


def to_hex(pen):
    return "#" + "".join(f"{int(round(c * 255)):02x}" for c in pen)
