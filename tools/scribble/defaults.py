"""Smart defaults: pick preprocessing and an algorithm from the image itself.

Split in two on purpose.

`preprocess` decides what the ink demand map should be - levels, warmth, blur,
depth of field. Those are not aesthetic choices, they are the difference
between a drawing and a grey rectangle, and every one of them here exists
because something in this directory failed without it.

`suggest` then picks the algorithm and its spacing. That part is a genuine
judgement call, so its rules were fitted against a scored sweep (sweep.py)
rather than asserted.

Every decision carries a short rationale, matching the shape of
tsc/src/smartDefaults.ts, because a default the user cannot interrogate is
just a magic number with better manners.
"""
import numpy as np

from features import describe

# A pen drawing wants a good deal of bare paper. This is the fraction of the
# page the ink demand should average out to; everything about levels follows
# from hitting it, which also pins plot time within a predictable band.
INK_TARGET = 0.22


def _solve_gamma(base, target, lo=0.35, hi=4.0, iters=28):
    """Gamma that brings mean(base ** gamma) to `target`. Monotone, so bisect."""
    if base.mean() <= 1e-6:
        return 1.0
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if (base ** mid).mean() > target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def preprocess(rgb, feats=None, ink_target=INK_TARGET):
    """Return (demand, luma, decisions). `demand` is ink coverage in [0,1]."""
    from common import levels
    from field import blur, focus_map

    if feats is None:
        feats = describe(rgb)
    luma = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    why = {}

    # --- warmth -------------------------------------------------------
    # A subject that differs in hue but not in tone vanishes in greyscale.
    # No algorithm recovers it, because the information is not in the channel.
    warm = 0.0
    if feats["tonal_separation"] < 0.08 and feats["hue_separation"] > 0.045:
        warm = 0.6
        why["warm"] = (warm, f"the two colour groups differ by only "
                             f"{feats['tonal_separation']:.2f} in tone but "
                             f"{feats['hue_separation']:.3f} in hue, so grey alone "
                             f"would lose the subject")
        luma = np.clip(luma - warm * (rgb[..., 0] - rgb[..., 2]), 0.0, 1.0)
    else:
        why["warm"] = (0.0, "tone already separates the subject")

    # --- source texture -----------------------------------------------
    # Anything already dithered - a halftone, an engraving, another scribble -
    # beats against the loop fills and clumps them.
    src_blur = 0.0
    if feats["texture_energy"] > 0.62:
        src_blur = 3.0
        why["blur"] = (src_blur, f"fine-scale energy is {feats['texture_energy']:.2f} of "
                                 f"coarse, so the source carries its own dither")
        luma = np.clip(blur(luma, src_blur), 0.0, 1.0)
    else:
        why["blur"] = (0.0, "source is continuous tone, nothing to soften")

    # --- levels -------------------------------------------------------
    black = float(np.percentile(luma, 2))
    white = float(np.percentile(luma, 75))
    why["levels"] = ((black, white),
                     f"paper reads at {feats['paper_luma']:.2f} and only "
                     f"{feats['white_headroom']*100:.0f}% of the frame is near white, "
                     f"so the top quarter is mapped to bare paper")
    g = levels(luma, black, white)

    # --- gamma --------------------------------------------------------
    base = np.clip(1.0 - g, 0.0, 1.0)
    gamma = _solve_gamma(base, ink_target)
    why["gamma"] = (gamma, f"solved so mean ink demand lands on {ink_target:.2f}, "
                           f"which is what pins plot time")
    demand = np.clip(base ** gamma, 0.0, 1.0)

    # --- depth of field -----------------------------------------------
    focus = 0.0
    if feats["dof_range"] > 0.34:
        focus = 0.8
        why["focus"] = (focus, f"sharpness varies by {feats['dof_range']:.2f} across the "
                               f"frame, so the lens already picked the subject")
        fm = focus_map(luma)
        demand = np.clip(demand * ((1.0 - focus) + focus * fm), 0.0, 1.0)
        # Masking removes ink, so re-solve gamma to keep the budget honest.
        gamma2 = _solve_gamma(np.clip(demand ** (1.0 / gamma), 0, 1), ink_target)
        demand = np.clip(np.clip(demand ** (1.0 / gamma), 0, 1) ** gamma2, 0.0, 1.0)
        why["gamma"] = (gamma2, why["gamma"][1] + " (re-solved after the focus mask)")
    else:
        why["focus"] = (0.0, "the frame is uniformly sharp, no depth of field to use")

    return demand, luma, why
