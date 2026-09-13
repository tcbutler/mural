"""Cheap descriptors of an image, for choosing settings without a human.

Everything here is computed on a downsampled copy and costs well under a
second. Names deliberately echo tsc/src/imageCharacteristics.ts where they
mean the same thing, so anything that earns its place can be ported without a
translation step.

The descriptors exist to answer the questions this directory has already been
burned by, in order:

  Is there any bare paper?          white_headroom
  Is the subject separable by tone? tonal_separation
  Is it separable by hue instead?   hue_separation
  Is the source already dithered?   texture_energy
  Does it have form to follow?      coherence
  Is there depth of field to use?   dof_range
"""
import numpy as np

from field import blur, focus_map, orientation_field


def _chromaticity(rgb):
    s = np.clip(rgb.sum(axis=-1, keepdims=True), 1e-6, None)
    return rgb / s


ANALYSIS_WIDTH = 400


def describe(rgb, luma=None):
    """Return a dict of descriptors for an HxWx3 image in [0,1].

    Always measured at a fixed analysis width, never at whatever size the
    render happens to use. Several of these descriptors are sensitive to
    resolution - the chromatic clustering subsamples, the texture ratio is a
    comparison of two fixed blur radii - so the same photo at 600px and 900px
    was producing different preprocessing decisions. A default that changes
    when you change the output size is not a default.
    """
    if min(rgb.shape[:2]) < 3:
        raise ValueError(
            f"image is {rgb.shape[1]}x{rgb.shape[0]}; nothing here can shade "
            f"something with no area. Geometry and calibration files (a single "
            f"rule, a hairline) are not shading tests.")
    if rgb.shape[1] != ANALYSIS_WIDTH:
        from PIL import Image
        h2 = max(3, round(rgb.shape[0] * ANALYSIS_WIDTH / rgb.shape[1]))
        im = Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))
        rgb = np.asarray(im.resize((ANALYSIS_WIDTH, h2), Image.LANCZOS),
                         dtype=np.float64) / 255.0
        luma = None
    if luma is None:
        luma = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    h, w = luma.shape
    f = {}

    # --- tone ---------------------------------------------------------
    p = np.percentile(luma, [2, 10, 50, 90, 98])
    f["median_luma"] = float(p[2])
    f["contrast"] = float(p[3] - p[1])
    # How much of the frame is already bare paper? Near zero means every
    # density-driven algorithm will ink the whole background unless a white
    # point is set, which is the single most common way these renders fail.
    f["white_headroom"] = float((luma > 0.90).mean())
    f["black_depth"] = float((luma < 0.10).mean())
    f["paper_luma"] = float(p[4])

    # --- structure ----------------------------------------------------
    g = blur(luma, 1.2)
    gy, gx = np.gradient(g)
    mag = np.hypot(gx, gy)
    hi = float(np.percentile(mag, 98)) + 1e-9
    n = mag / hi
    f["flat_fraction"] = float((n < 0.08).mean())
    f["edge_fraction"] = float((n > 0.5).mean())
    f["mid_tone_fraction"] = float(((n >= 0.08) & (n <= 0.5)).mean())

    _, _, coh = orientation_field(luma, 1.6, 6.0)
    # Weighted by gradient, because coherence in an empty sky is meaningless.
    wgt = n / max(float(n.sum()), 1e-9)
    f["coherence"] = float((coh * wgt).sum())

    # --- texture scale ------------------------------------------------
    # Energy that survives at the scale of a scribble loop. High means the
    # source carries its own dither or fine texture, which beats against the
    # loop fills and clumps them into rosettes.
    fine = np.abs(luma - blur(luma, 1.5))
    coarse = np.abs(luma - blur(luma, 6.0))
    f["texture_energy"] = float(fine.mean() / max(coarse.mean(), 1e-9))

    # --- depth of field -----------------------------------------------
    fm = focus_map(luma)
    q = np.percentile(fm, [15, 85])
    f["dof_range"] = float(q[1] - q[0])

    # --- colour -------------------------------------------------------
    sat = rgb.max(axis=-1) - rgb.min(axis=-1)
    f["chroma"] = float(sat.mean())

    # Split the chromatic pixels in two by hue, then ask how the two groups
    # differ. A subject that differs in hue but not in tone is the case that
    # defeats greyscale entirely - it needs --warm or --pens, and no choice
    # of algorithm rescues it.
    flat_rgb = rgb.reshape(-1, 3)
    pool = flat_rgb[sat.reshape(-1) > 0.12]
    if len(pool) > 512:
        rng = np.random.default_rng(0)
        if len(pool) > 40000:
            pool = pool[rng.choice(len(pool), 40000, replace=False)]
        ch = _chromaticity(pool)
        c = ch[rng.choice(len(ch), 2, replace=False)].copy()
        owner = np.zeros(len(ch), dtype=np.int64)
        for _ in range(16):
            owner = np.argmin(((ch[:, None, :] - c[None, :, :]) ** 2).sum(axis=2), axis=1)
            for i in (0, 1):
                if (owner == i).any():
                    c[i] = ch[owner == i].mean(axis=0)
        groups = [pool[owner == i] for i in (0, 1)]
        if all(len(gp) > 64 for gp in groups):
            lums = [float((0.299 * gp[:, 0] + 0.587 * gp[:, 1]
                           + 0.114 * gp[:, 2]).mean()) for gp in groups]
            f["tonal_separation"] = abs(lums[0] - lums[1])
            f["hue_separation"] = float(np.hypot(*(c[0] - c[1])[:2]))
            f["chromatic_fraction"] = float(len(pool) / len(flat_rgb))
        else:
            f["tonal_separation"] = f["hue_separation"] = 0.0
            f["chromatic_fraction"] = 0.0
    else:
        f["tonal_separation"] = f["hue_separation"] = 0.0
        f["chromatic_fraction"] = 0.0

    f["aspect"] = float(w / h)
    return f


ORDER = ["median_luma", "contrast", "white_headroom", "black_depth", "paper_luma",
         "flat_fraction", "edge_fraction", "mid_tone_fraction", "coherence",
         "texture_energy", "dof_range", "chroma", "tonal_separation",
         "hue_separation", "chromatic_fraction"]


def as_row(f):
    return [f[k] for k in ORDER]
