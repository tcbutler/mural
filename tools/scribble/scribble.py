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

from common import (auto_levels, levels, load_gray, render, to_svg,
                    tone_report)
from contour import contour_scribble
from field import blur as blur_field
from cycloid import cycloid_scribble
from greedy import greedy_scribble
from stitch import tidy, travel
from synth import chart
from tsp import tsp_art, break_long


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

    gray = chart() if args.chart else load_gray(args.image, args.width)
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
    d = np.clip((1.0 - gray) ** args.gamma, 0.0, 1.0)
    h, w = d.shape

    if args.algo == "cycloid":
        pl = cycloid_scribble(d, row_step=args.row, pen=args.pen, seed=args.seed,
                              lift=not args.no_lift)
        blur = args.row
    elif args.algo == "contour":
        k = args.field_smooth
        pl = contour_scribble(d, gray=gray, d_sep=args.row, pen=args.pen,
                              seed=args.seed, lift=not args.no_lift,
                              sigma_grad=1.6 * k, sigma_tensor=6.0 * k)
        blur = args.row
    elif args.algo == "tsp":
        closed, pts = tsp_art(d, n_points=args.points, seed=args.seed)
        pl = break_long(closed[0], args.break_edges)
        print(f"  {len(pts)} stipple points")
        blur = 9.0
    else:
        pl = greedy_scribble(d, n_strokes=args.strokes, pen=args.pen, seed=args.seed)
        blur = 9.0

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
