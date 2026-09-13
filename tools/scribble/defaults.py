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

# A pen drawing wants a good deal of bare paper. This is a *ceiling* on the
# fraction of the page the ink demand may average out to, not a target: an
# image that naturally wants less ink should be left alone. Treating it as a
# target darkened every light image up to the budget and cost 20 minutes of
# plot time apiece for a picture nobody asked to be heavier.
INK_CEILING = 0.22


def _solve_gamma(base, target, lo=1.0, hi=4.0, iters=28):
    """Gamma bringing mean(base ** gamma) down to `target`, never up.

    The lower bound is 1.0 on purpose: gamma below 1 would darken an image
    that is already lighter than the budget, which spends plot time to make a
    picture worse.
    """
    if base.mean() <= 1e-6 or base.mean() <= target:
        return 1.0
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if (base ** mid).mean() > target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def preprocess(rgb, feats=None, ink_ceiling=INK_CEILING):
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
    # Gated on the image actually having colour in it. A near-neutral photo
    # still produces two chromaticity clusters, but they are made of a handful
    # of stray pixels: one product shot had 4% chromatic pixels and reported a
    # hue separation of 0.41, which would have applied a strong colour filter
    # to a grey motor on white paper.
    if (feats["chroma"] > 0.10 and feats["chromatic_fraction"] > 0.10
            and feats["tonal_separation"] < 0.08 + 0.5 * feats["hue_separation"]
            and feats["hue_separation"] > 0.045):
        warm = 0.6
        why["warm"] = (warm, f"the two colour groups differ by only "
                             f"{feats['tonal_separation']:.2f} in tone but "
                             f"{feats['hue_separation']:.3f} in hue, so grey alone "
                             f"would lose the subject")
        luma = np.clip(luma - warm * (rgb[..., 0] - rgb[..., 2]), 0.0, 1.0)
    else:
        why["warm"] = (0.0, "tone already separates the subject, or there is too "
                            "little colour for a filter to act on")

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
    # Only intervene when the image has no bare paper of its own. A product
    # shot on a white sweep already does, and stretching it further just
    # clips detail that was fine.
    if feats["white_headroom"] < 0.05:
        black = float(np.percentile(luma, 2))
        white = float(np.percentile(luma, 75))
        why["levels"] = ((black, white),
                         f"only {feats['white_headroom']*100:.0f}% of the frame is near "
                         f"white and paper reads at {feats['paper_luma']:.2f}, so the top "
                         f"quarter is mapped to bare paper")
    else:
        black, white = 0.0, 1.0
        why["levels"] = ((0.0, 1.0),
                         f"{feats['white_headroom']*100:.0f}% of the frame is already bare "
                         f"paper, so the levels are left alone")
    g = levels(luma, black, white)

    # --- gamma --------------------------------------------------------
    base = np.clip(1.0 - g, 0.0, 1.0)
    gamma = _solve_gamma(base, ink_ceiling)
    why["gamma"] = (gamma, f"mean ink demand held at or under {ink_ceiling:.2f}"
                           + (", already lighter than that" if gamma <= 1.0001 else
                              f", lightened by gamma {gamma:.2f}"))
    demand = np.clip(base ** gamma, 0.0, 1.0)

    # --- depth of field -----------------------------------------------
    focus = 0.0
    if feats["dof_range"] > 0.34:
        focus = 0.8
        why["focus"] = (focus, f"sharpness varies by {feats['dof_range']:.2f} across the "
                               f"frame, so the lens already picked the subject")
        fm = focus_map(luma)
        before = float(demand.mean())
        demand = np.clip(demand * ((1.0 - focus) + focus * fm), 0.0, 1.0)
        # The mask is meant to move ink onto the subject, not to spend less of
        # it. Left alone it does both, and on an already-light image that is a
        # second lightening on top of the gamma - the drawing fades rather
        # than gaining a subject. Restore the budget so the ink the background
        # gave up is spent on what the lens was pointed at.
        after = float(demand.mean())
        if after > 1e-6:
            demand = np.clip(demand * (before / after), 0.0, 1.0)
    else:
        why["focus"] = (0.0, "the frame is uniformly sharp, no depth of field to use")

    return demand, luma, why


# --- algorithm ---------------------------------------------------------
#
# Fitted against sweep.py over the corpus, and the honest result is that the
# algorithm barely matters. The median gap between the best config and the
# second best was 0.028 of composite score; always choosing the greedy walk
# costs 0.018 on average and loses by more than 0.05 on 3 images out of 23.
# A decision tree over image features would be fitting that noise.
#
# What does change the answer is how much the plot time is worth. Scored on
# legibility alone the greedy walk wins 21 of 23; on cost alone the TSP tour
# wins 22 of 23, because a tour that never crosses itself lays every unit of
# line on fresh paper and needs about 2.5x less of it for the same coverage.
# The ranking flips between a cost weight of 0.2 and 0.3.
#
# So the recommendation is one question, not a classifier.

def suggest(feats, prefer="picture"):
    """Recommend an algorithm. `prefer` is 'picture', 'speed', or 'texture'."""
    if prefer == "speed":
        return {"algo": "tsp", "points": 20000, "break_edges": 30.0}, (
            "a non-crossing tour needs about 2.5x less line for the same "
            "coverage, so it plots in roughly a third of the time; it wins on "
            "cost on 22 of 23 test images, at some loss of legibility")

    if prefer == "texture":
        # A style choice, not a fitted one - neither loop family beat the
        # greedy walk on the corpus by a margin worth trusting. Which of the
        # two is a genuine feature call, though: the contour version only has
        # something to follow if the image has coherent structure.
        if feats["coherence"] > 0.60 and feats["texture_energy"] < 0.55:
            return {"algo": "contour", "row": 9.0, "field_smooth": 1.0}, (
                f"structure coherence is {feats['coherence']:.2f}, so there is "
                f"real form for the loops to follow")
        smooth = 3.0 if feats["texture_energy"] > 0.55 else 1.0
        return {"algo": "cycloid", "row": 9.0, "field_smooth": smooth}, (
            f"coherence is only {feats['coherence']:.2f}, so a contour guide "
            f"would be following noise; rows are the safer loop")

    return {"algo": "greedy", "join": 8.0}, (
        "best legibility on 21 of 23 test images, and the tone error is the "
        "lowest of any config since the ink accounting was fixed; the cost is "
        "plot time, about 3x the TSP tour")
