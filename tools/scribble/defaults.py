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
        # Softening makes the render work, but say the quiet part: a source
        # whose tone is already dithered is a reproduction of someone else's
        # mark-making, and redrawing it is a copy of a copy. The blur recovers
        # a usable image, not a good original.
        why["blur"] = (src_blur, f"fine-scale energy is {feats['texture_energy']:.2f} of "
                                 f"coarse, so the source's tone is already made of "
                                 f"marks - softening it first. Expect second-generation "
                                 f"results; an original photograph will beat this")
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
# Fitted against sweep.py, and for continuous-tone images the honest result is
# that the algorithm barely matters. The median gap between the best config
# and the second best is 0.030 of composite score. The best single fixed
# choice, the greedy walk, still costs 0.048 on average and loses by more than
# 0.05 on 10 images out of 23 - so it is the best default, not a free lunch.
# A decision tree over image features would be fitting the noise underneath
# those margins.
#
# What does change the answer is how much the plot time is worth. Scored on
# legibility alone the greedy walk wins 19 of 23; on tone alone the widest
# cycloid wins 10; on cost alone the TSP tour wins 19, because a tour that
# never crosses itself lays every unit of line on fresh paper and needs about
# 2.5x less of it for the same coverage. The ranking flips between a cost
# weight of 0.2 and 0.3.
#
# Blind human rankings then settled the loop families' fate. Across 5 sheets
# and 80 pairwise preferences, the greedy walk and the TSP tour took every
# single one of the top-two slots - 5 each, and not one cycloid or contour
# render among them. Re-scoring the whole sweep under the fitted weights drops
# the loop fills out entirely: 25 images split 13 TSP, 12 greedy. They stay
# reachable under --prefer texture because their look is the point, but they
# are no longer recommended for a picture.
#
# So the recommendation is one question, not a classifier.

def suggest(feats, prefer="picture"):
    """Recommend an algorithm. `prefer` is 'picture', 'speed', or 'texture'.

    Returns (config, rationale). A config of None means these fills are the
    wrong tool and the caller should say so rather than pick a least-bad one.
    """
    # Flat art first, because for this class the answer is "not this". A
    # bimodal histogram with no mid-tones has nothing for a density fill to
    # modulate: the image is regions of solid ink and regions of bare paper,
    # which is what a hatch is for. Measured on a solid black page, the loop
    # fills drew 5.3x and the greedy walk 3.9x the line a plain hatch at nib
    # spacing needs for the same coverage, because they overdraw - 250 minutes
    # against 48. The TSP tour does it in 23 minutes and simply fails to make
    # it black, at 0.59 tone error.
    if feats["mid_tone_fraction"] < 0.05 and feats["contrast"] < 0.05:
        if feats["black_depth"] > 0.15:
            return None, (
                f"{feats['black_depth']*100:.0f}% of this image is solid ink with "
                f"no mid-tones, so there is no density to modulate. A scribble "
                f"fill would draw 4-5x the line a cross-hatch needs for the same "
                f"coverage; use the renderer's hatch strategies instead")
        # Small isolated solids on bare paper - cheap either way, and the
        # scribble at least gives the edges some life.
        return {"algo": "greedy", "join": 8.0}, (
            f"flat art, but only {feats['black_depth']*100:.0f}% of it is inked, so "
            f"the cost of overdrawing is small and the scribble reads as "
            f"hand-drawn where a hatch would read as printed")

    if prefer == "speed":
        return {"algo": "tsp", "points": 20000, "break_edges": 30.0}, (
            "a non-crossing tour needs about 2.5x less line for the same "
            "coverage, so it plots in roughly a third of the time; it wins on "
            "cost on 19 of 23 test images, and a human ranked it first on two "
            "sheets out of five even without being told the cost")

    if prefer == "texture":
        # An explicit style choice, and now known to be one: in blind ranking
        # neither loop family reached a human's top two on any sheet. Ask for
        # them because you want the look, not because they score well. Which
        # of the two is still a genuine feature call: the contour version only
        # has something to follow if the image has coherent structure.
        if feats["coherence"] > 0.60 and feats["texture_energy"] < 0.55:
            return {"algo": "contour", "row": 9.0, "field_smooth": 1.0}, (
                f"structure coherence is {feats['coherence']:.2f}, so there is "
                f"real form for the loops to follow")
        smooth = 3.0 if feats["texture_energy"] > 0.55 else 1.0
        return {"algo": "cycloid", "row": 9.0, "field_smooth": smooth}, (
            f"coherence is only {feats['coherence']:.2f}, so a contour guide "
            f"would be following noise; rows are the safer loop")

    return {"algo": "greedy", "join": 8.0}, (
        "best legibility on 19 of 23 test images, and it took a top-two slot on "
        "every blind sheet a human ranked; the cost is plot time, about 3x the "
        "TSP tour")


def colour_advice(feats, max_pens=3):
    """Would this image be better in colour? (n_pens or None, rationale).

    Kept separate from `suggest` because it is a different axis and a
    different cost: pens mean physical ink you own and a swap you stand there
    for. The gates are measured, not guessed - a near-neutral image still
    produces two chromaticity clusters out of a handful of stray pixels, which
    is why chromatic_fraction has to carry a real share of the frame before
    hue_separation means anything.

    On the test images this fires for a cartoon hero shot (chroma 0.13, 25% of
    the frame chromatic, hue separation 0.17), a ginger cat on green, and a
    coil of coloured wire; it stays quiet for a brown horse on white, whose
    single hue makes one pen no better than grey.
    """
    if (feats["chroma"] > 0.10 and feats["chromatic_fraction"] > 0.20
            and feats["hue_separation"] > 0.12):
        n = 3 if feats["chroma"] > 0.15 else 2
        return min(n, max_pens), (
            f"{feats['chromatic_fraction']*100:.0f}% of the frame carries colour and the "
            f"hue groups are {feats['hue_separation']:.2f} apart, so the content is in "
            f"the hue as much as the tone; {n} pens separate it where grey flattens it")
    if feats["chroma"] > 0.10:
        return None, (
            f"colourful but essentially one hue (separation {feats['hue_separation']:.2f}), "
            f"so a second pen would draw the same shapes in a different colour")
    return None, "too little colour for pens to add anything"
