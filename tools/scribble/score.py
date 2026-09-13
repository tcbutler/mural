"""Scoring a rendered scribble, so settings can be searched rather than guessed.

Three things are worth measuring and they pull in different directions, so
they are kept separate and only combined at the end, where the weights are
visible and arguable:

  tone        does the ink density match the image's greys? (tone_report)
  legibility  can you still tell what it is? Correlation at a coarse scale,
              plus correlation of edge structure at a middle scale - a render
              can nail the greys and still turn a face into porridge.
  cost        plot time on the machine, dominated by pen lifts.

None of this is taste. It is a proxy that ranks obvious failures below obvious
successes, which is enough to choose defaults; it will not tell you which of
two good renders is the nicer drawing.
"""
import numpy as np
from PIL import Image, ImageFilter

# Plot assumptions, so cost comes out in minutes rather than pixels.
PLOT_WIDTH_MM = 400.0          # roughly A3 landscape
DRAW_SPEED_MM_S = 30.0
PEN_LIFT_S = 2.0


def _coverage(img):
    return 1.0 - np.asarray(img, dtype=np.float64) / 255.0


def _corr(a, b):
    a = a.ravel() - a.mean()
    b = b.ravel() - b.mean()
    d = float(np.sqrt((a * a).sum() * (b * b).sum()))
    return float((a * b).sum() / d) if d > 1e-12 else 0.0


def legibility(rendered, target_d, coarse=10.0, mid=3.0):
    """0..1. Coarse tonal agreement and mid-scale edge agreement, averaged."""
    got = _coverage(rendered.filter(ImageFilter.GaussianBlur(coarse)))
    want = np.asarray(Image.fromarray((np.clip(target_d, 0, 1) * 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(coarse)), dtype=np.float64) / 255.0
    tonal = _corr(got, want)

    def edges(x):
        gy, gx = np.gradient(x)
        return np.hypot(gx, gy)

    got_m = _coverage(rendered.filter(ImageFilter.GaussianBlur(mid)))
    want_m = np.asarray(Image.fromarray((np.clip(target_d, 0, 1) * 255).astype(np.uint8))
                        .filter(ImageFilter.GaussianBlur(mid)), dtype=np.float64) / 255.0
    structural = _corr(edges(got_m), edges(want_m))

    return float(np.clip(0.5 * (tonal + structural), 0.0, 1.0))


def tone_rms(rendered, target_d, blur_px):
    got = _coverage(rendered.filter(ImageFilter.GaussianBlur(blur_px)))
    want = np.asarray(Image.fromarray((np.clip(target_d, 0, 1) * 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(blur_px)), dtype=np.float64) / 255.0
    return float(np.sqrt(((got - want) ** 2).mean()))


def plot_minutes(drawn_px, lifts, width_px):
    mm_per_px = PLOT_WIDTH_MM / max(width_px, 1)
    seconds = drawn_px * mm_per_px / DRAW_SPEED_MM_S + lifts * PEN_LIFT_S
    return seconds / 60.0


def evaluate(rendered, target_d, blur_px, drawn_px, lifts, width_px,
             weights=(0.45, 0.35, 0.20)):
    """Component scores plus a weighted composite, all 0..1 except rms/minutes."""
    rms = tone_rms(rendered, target_d, blur_px)
    leg = legibility(rendered, target_d)
    mins = plot_minutes(drawn_px, lifts, width_px)

    # Both curves are chosen so that "clearly fine" sits near 1 and "clearly
    # bad" near 0 across the range these prototypes actually produce: tone
    # error runs about 0.03 to 0.17, plots about 10 to 120 minutes.
    tone_s = float(np.exp(-rms / 0.08))
    cost_s = float(np.exp(-mins / 45.0))
    wl, wt, wc = weights
    return {
        "tone_rms": rms,
        "legibility": leg,
        "minutes": mins,
        "tone_score": tone_s,
        "cost_score": cost_s,
        "composite": wl * leg + wt * tone_s + wc * cost_s,
    }
