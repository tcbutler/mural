#!/usr/bin/env python3
"""Turn an image into a tone-matched scribble, as SVG for the plotter.

    python3 scribble.py photo.jpg -o out.svg --row 9 --pen 1.4
    python3 scribble.py photo.jpg --algo contour --seed 4
    python3 scribble.py photo.jpg --algo greedy --join 8
    python3 scribble.py photo.jpg --algo tsp --points 20000 --break-edges 30
    python3 scribble.py --chart            # synthetic tone chart, with metrics

Four algorithms:

  cycloid  a pen path snaking across the image in rows, tracing a loop whose
           advance rate is set by local darkness. Loopy and dense.
  contour  the same loop, but the guide path follows the image's own structure
           instead of scanlines, so the loops lean with the form.
  greedy   a random walk that repeatedly picks the darkest nearby segment and
           subtracts the ink it lays. Sketchy, edge-seeking, lift-heavy.
  tsp      stipple to the image's density, then one tour through every dot.
           Almost no pen lifts, and no way to get dark.

The first three are non-deterministic; --seed makes a run repeatable.

Output units are millimetres of paper, so --pen is a real nib width and --row
a real line spacing. Check the tone report before committing a long plot.
"""
import argparse
import sys
import numpy as np

from common import (auto_levels, levels, load_gray, render, render_layers,
                    to_svg, to_svg_layers, tone_report)
from contour import contour_scribble
from defaults import preprocess, suggest
from features import describe
from field import blur as blur_field, focus_map
from cycloid import cycloid_scribble
from greedy import greedy_scribble
from score import evaluate
from stitch import tidy, travel
from separate import (auto_pens, load_rgb, parse_pens, separate, to_hex,
                      white_balance)
from synth import chart
from tsp import tsp_art, break_long


def run_auto(args):
    """Describe the image, preprocess it, pick an algorithm, and say why."""
    if args.chart or not args.image:
        raise SystemExit("--auto needs a source image")
    rgb = load_rgb(args.image, args.width)
    feats = describe(rgb)
    d, luma, why = preprocess(rgb, feats)
    h, w = d.shape

    print(f"{args.image}  ({w}x{h})")
    for key in ("warm", "blur", "levels", "gamma", "focus"):
        val, reason = why[key]
        shown = (f"{val[0]:.2f}-{val[1]:.2f}" if isinstance(val, tuple)
                 else f"{val:.2f}")
        print(f"  {key:7} {shown:>11}   {reason}")
    cfg, reason = suggest(feats, args.prefer)
    print(f"  {'algo':7} {cfg['algo']:>11}   {reason}")
    print(f"  ink demand {d.mean():.3f} of the page")

    for k, v in cfg.items():
        if k == "algo":
            args.algo = v
        elif k == "break_edges":
            args.break_edges = v
        elif hasattr(args, k):
            setattr(args, k, v)

    pl = build(d, args, gray=luma)
    if not args.no_order:
        pl = tidy(pl, max_gap=getattr(args, "join", 0.0))
    to_svg(pl, (w, h), pen_mm=args.pen, path=args.out)
    if args.preview:
        render(pl, (w, h), pen_px=args.pen).save(args.preview)
    drawn, up = travel(pl)
    blur_px = args.row if cfg["algo"] in ("cycloid", "contour") else 9.0
    ev = evaluate(render(pl, (w, h), pen_px=args.pen), d, blur_px, drawn,
                  max(0, len(pl) - 1), w)
    print(f"{args.out}: {len(pl)} strokes, {max(0, len(pl)-1)} pen lifts, "
          f"{drawn/1000:.1f}k px drawn")
    print(f"  scored: legibility {ev['legibility']:.3f}, tone RMS "
          f"{ev['tone_rms']:.3f}, about {ev['minutes']:.0f} min to plot")
    return 0


def focus_mask(gray, weight):
    """Ink multiplier from the source's depth of field, 1.0 when disabled.

    At weight w the out-of-focus parts keep (1 - w) of their ink and the sharp
    parts keep all of it, so w is "how much of the background to throw away".
    """
    if weight <= 0:
        return 1.0
    return (1.0 - weight) + weight * focus_map(gray)


def build(d, args, gray=None, quiet=False):
    """Run the selected algorithm over one ink-demand map.

    `gray` is the source luminance, used only for the orientation field. In
    colour mode it is the whole image's luminance rather than the pen's own
    coverage, because the form of the subject does not change per pen.
    """
    if gray is None:
        gray = 1.0 - d
    if args.algo == "cycloid":
        return cycloid_scribble(d, row_step=args.row, pen=args.pen,
                                seed=args.seed, lift=not args.no_lift)
    if args.algo == "contour":
        k = args.field_smooth
        return contour_scribble(d, gray=gray, d_sep=args.row, pen=args.pen,
                                seed=args.seed, lift=not args.no_lift,
                                sigma_grad=1.6 * k, sigma_tensor=6.0 * k)
    if args.algo == "tsp":
        closed, pts = tsp_art(d, n_points=args.points, seed=args.seed)
        if not quiet:
            print(f"  {len(pts)} stipple points")
        return break_long(closed[0], args.break_edges)
    return greedy_scribble(d, n_strokes=args.strokes, pen=args.pen,
                           seed=args.seed)


def run_colour(args):
    """One scribble pass per pen, composed into a single layered SVG."""
    if args.chart or not args.image:
        raise SystemExit("--pens needs a source image")
    rgb = load_rgb(args.image, args.width)
    lum_src = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    mask = focus_mask(lum_src, args.focus)
    rgb = white_balance(rgb, gain=args.paper)
    if args.blur > 0:
        rgb = np.stack([np.clip(blur_field(rgb[..., c], args.blur), 0, 1)
                        for c in range(3)], axis=-1)

    try:
        pens = auto_pens(rgb, int(args.pens), seed=args.seed)
    except ValueError:
        pens = parse_pens(args.pens)
    covers = separate(rgb, pens)

    # Light pens first, so where two colours meet it is the darker nib that
    # crosses the lighter ink - the direction you cannot see. Same convention
    # as the renderer's colour layers.
    lum = [0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2] for p in pens]
    idx = sorted(range(len(pens)), key=lambda i: -lum[i])

    h, w = covers[0].shape
    layers = []
    for rank, i in enumerate(idx):
        d = np.clip(covers[i] ** args.gamma * mask, 0.0, 1.0)
        if args.seed is not None:
            args.seed += rank          # so layers do not draw identical paths
        pl = build(d, args, gray=lum_src, quiet=rank > 0)
        if not args.no_order:
            pl = tidy(pl, max_gap=args.join)
        drawn, up = travel(pl)
        print(f"  {to_hex(pens[i])}: {len(pl)} strokes, {max(0, len(pl)-1)} lifts, "
              f"{drawn/1000:.1f}k px drawn, mean demand {d.mean():.3f}")
        layers.append((pens[i], pl))

    to_svg_layers(layers, (w, h), pen_mm=args.pen, path=args.out)
    if args.preview:
        render_layers(layers, (w, h), pen_px=args.pen).save(args.preview)
    total = sum(max(0, len(pl) - 1) for _, pl in layers) + len(layers) - 1
    print(f"{args.out}: {len(layers)} pens, {total} pen lifts including swaps")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image", nargs="?", help="source image (omit with --chart)")
    ap.add_argument("--chart", action="store_true", help="use the synthetic tone chart")
    ap.add_argument("--algo", choices=("cycloid", "contour", "greedy", "tsp"), default="cycloid")
    ap.add_argument("-o", "--out", default="scribble.svg")
    ap.add_argument("--width", type=int, default=760, help="working raster width in px")
    ap.add_argument("--row", type=float, default=9.0, help="cycloid/contour: line spacing (px)")
    ap.add_argument("--pen", type=float, default=1.4, help="nib width (px at working size)")
    ap.add_argument("--strokes", type=int, default=40000, help="greedy: stroke budget")
    ap.add_argument("--points", type=int, default=20000, help="tsp: stipple point count")
    ap.add_argument("--break-edges", type=float, default=0.0, metavar="PX",
                    help="tsp: cut tour edges longer than this, so long transits "
                         "become pen lifts instead of ruled lines")
    ap.add_argument("--gamma", type=float, default=1.0, help="<1 lifts midtones")
    ap.add_argument("--white", type=float, default=None, metavar="L",
                    help="luminance (0-1) treated as bare paper; essential for "
                         "photos, whose paper is never actually white")
    ap.add_argument("--black", type=float, default=None, metavar="L",
                    help="luminance (0-1) treated as solid ink")
    ap.add_argument("--pens", metavar="N|HEX,HEX",
                    help="draw in colour: either a pen count to pick "
                         "automatically, or explicit colours like "
                         "'#b4541a,#2f5d2a'. Each pen gets its own pass")
    ap.add_argument("--paper", type=float, default=1.0, metavar="G",
                    help="with --pens: paper gain. Below 1 treats more of the "
                         "image as bare paper and spends less ink")
    ap.add_argument("--auto", action="store_true",
                    help="read the image and choose preprocessing and an "
                         "algorithm from it, printing why for each decision")
    ap.add_argument("--prefer", choices=("picture", "speed", "texture"),
                    default="picture",
                    help="with --auto: what to optimise. 'picture' is the best "
                         "drawing, 'speed' the shortest plot, 'texture' the "
                         "loop-scribble look")
    ap.add_argument("--focus", type=float, default=0.0, metavar="W",
                    help="hold back ink where the photo is out of focus, 0-1. "
                         "Uses the source's own depth of field to separate "
                         "subject from background")
    ap.add_argument("--warm", type=float, default=0.0, metavar="W",
                    help="darken warm colours by W x (red - blue). A colour "
                         "filter, for subjects that share a luminance with "
                         "their background but not a hue")
    ap.add_argument("--blur", type=float, default=0.0, metavar="SIGMA",
                    help="soften the source first. Needed when the source is "
                         "itself a drawing or a halftone, whose tone already "
                         "has structure at the scale of the strokes")
    ap.add_argument("--field-smooth", type=float, default=1.0, metavar="K",
                    help="contour: how far to smooth the orientation field. "
                         "Raise it for busy sources, whose fine detail "
                         "otherwise swamps the shape underneath")
    ap.add_argument("--auto-levels", action="store_true",
                    help="take the black and white points from the image's own "
                         "2nd and 98th luminance percentiles")
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--no-lift", action="store_true",
                    help="cycloid: never lift the pen (one unbroken line, ink on white)")
    ap.add_argument("--preview", help="also write a raster preview PNG here")
    ap.add_argument("--join", type=float, default=0.0, metavar="PX",
                    help="merge strokes whose ends are within this gap, to cut "
                         "pen lifts (adds a little unasked-for ink)")
    ap.add_argument("--no-order", action="store_true",
                    help="skip nearest-neighbour stroke ordering (it is free "
                         "and changes nothing on the paper, so rarely wanted)")
    args = ap.parse_args(argv)

    if not args.chart and not args.image:
        ap.error("give an image path or --chart")

    if args.auto:
        return run_auto(args)

    if args.pens:
        return run_colour(args)

    gray = chart() if args.chart else load_gray(args.image, args.width, args.warm)
    # Measured before levels and blur, which would destroy what it measures.
    mask = focus_mask(gray, args.focus)
    black, white = args.black, args.white
    if args.auto_levels:
        a, b = auto_levels(gray)
        black = a if black is None else black
        white = b if white is None else white
    if black is not None or white is not None:
        black = 0.0 if black is None else black
        white = 1.0 if white is None else white
        print(f"  levels: black {black:.3f}, white {white:.3f}")
        gray = levels(gray, black, white)
    if args.blur > 0:
        gray = np.clip(blur_field(gray, args.blur), 0.0, 1.0)
    d = np.clip((1.0 - gray) ** args.gamma * mask, 0.0, 1.0)
    h, w = d.shape

    pl = build(d, args, gray=gray)
    blur = args.row if args.algo in ("cycloid", "contour") else 9.0

    raw_lifts = max(0, len(pl) - 1)
    if not args.no_order:
        pl = tidy(pl, max_gap=args.join)

    to_svg(pl, (w, h), pen_mm=args.pen, path=args.out)
    img = render(pl, (w, h), pen_px=args.pen)
    if args.preview:
        img.save(args.preview)

    drawn, up = travel(pl)
    lifts = max(0, len(pl) - 1)
    note = "" if lifts == raw_lifts else f" (from {raw_lifts})"
    print(f"{args.out}: {len(pl)} strokes, {lifts} pen lifts{note}, "
          f"{drawn/1000:.1f}k px drawn, {up/1000:.1f}k px pen-up")
    print(tone_report(img, d, blur_px=blur))
    return 0


if __name__ == "__main__":
    sys.exit(main())
