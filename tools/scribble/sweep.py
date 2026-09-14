"""Score every algorithm on every image, so defaults can be fitted not guessed.

    python3 sweep.py corpus/*.jpg -o sweep.json
    python3 sweep.py --report sweep.json

Preprocessing is held fixed at whatever defaults.preprocess decides, so the
only variable is the algorithm and its spacing. That separation matters: a bad
white point makes every algorithm look equally terrible, and averaging that in
would teach the rules nothing.
"""
import argparse
import json
import sys
import time

import numpy as np

from common import render, load_gray
from contour import contour_scribble
from cycloid import cycloid_scribble
from defaults import preprocess
from features import describe
from greedy import greedy_scribble
from score import evaluate
from separate import load_rgb
from stitch import tidy, travel
from tsp import break_long, tsp_art

PEN_PX = 1.4

CONFIGS = [
    ("cycloid/7", dict(algo="cycloid", row=7.0)),
    ("cycloid/9", dict(algo="cycloid", row=9.0)),
    ("cycloid/12", dict(algo="cycloid", row=12.0)),
    ("contour/7", dict(algo="contour", row=7.0, smooth=1.0)),
    ("contour/9", dict(algo="contour", row=9.0, smooth=1.0)),
    ("contour/9-smooth", dict(algo="contour", row=9.0, smooth=3.0)),
    ("greedy", dict(algo="greedy", join=8.0)),
    ("tsp/20k", dict(algo="tsp", points=20000, brk=30.0)),
]


def run_config(d, luma, cfg, seed=5):
    algo = cfg["algo"]
    if algo == "cycloid":
        pl = cycloid_scribble(d, row_step=cfg["row"], pen=PEN_PX, seed=seed)
        blur_px = cfg["row"]
    elif algo == "contour":
        k = cfg["smooth"]
        pl = contour_scribble(d, gray=luma, d_sep=cfg["row"], pen=PEN_PX, seed=seed,
                              sigma_grad=1.6 * k, sigma_tensor=6.0 * k)
        blur_px = cfg["row"]
    elif algo == "tsp":
        closed, _ = tsp_art(d, n_points=cfg["points"], seed=seed)
        pl = break_long(closed[0], cfg["brk"])
        blur_px = 9.0
    else:
        pl = greedy_scribble(d, pen=PEN_PX, seed=seed)
        blur_px = 9.0
    pl = tidy(pl, max_gap=cfg.get("join", 0.0))
    return pl, blur_px


def sweep(paths, width=600, out=None):
    rows = []
    for path in paths:
        t0 = time.time()
        rgb = load_rgb(path, width)
        feats = describe(rgb)
        d, luma, why = preprocess(rgb, feats)
        h, w = d.shape
        entry = {"image": path, "features": feats,
                 "preprocess": {k: (v[0] if not isinstance(v[0], tuple) else list(v[0]))
                                for k, v in why.items()},
                 "results": {}}
        for name, cfg in CONFIGS:
            try:
                pl, blur_px = run_config(d, luma, cfg)
                img = render(pl, (w, h), pen_px=PEN_PX)
                drawn, _ = travel(pl)
                s = evaluate(img, d, blur_px, drawn, max(0, len(pl) - 1), w)
                s["strokes"] = len(pl)
                entry["results"][name] = s
            except Exception as exc:                     # noqa: BLE001
                entry["results"][name] = {"error": f"{type(exc).__name__}: {exc}"}
        best = max((k for k in entry["results"] if "composite" in entry["results"][k]),
                   key=lambda k: entry["results"][k]["composite"], default=None)
        entry["best"] = best
        rows.append(entry)
        print(f"{path}: best={best} ({time.time()-t0:.0f}s)", flush=True)
    if out:
        json.dump(rows, open(out, "w"), indent=1)
    return rows


def report(rows):
    from collections import Counter
    wins = Counter(r["best"] for r in rows)
    print("\nwins by config")
    for k, n in wins.most_common():
        print(f"  {k:16} {n}")

    names = [n for n, _ in CONFIGS]
    print("\nmean scores across the corpus")
    print(f"  {'config':16} {'composite':>10} {'legible':>8} {'tone':>7} {'mins':>6}")
    for n in names:
        vals = [r["results"][n] for r in rows if "composite" in r["results"].get(n, {})]
        if not vals:
            continue
        m = lambda k: np.mean([v[k] for v in vals])
        print(f"  {n:16} {m('composite'):10.3f} {m('legibility'):8.3f} "
              f"{m('tone_rms'):7.3f} {m('minutes'):6.1f}")

    print("\nper-image winners")
    for r in rows:
        f = r["features"]
        print(f"  {r['image'].split('/')[-1]:28} {r['best']:16} "
              f"coh {f['coherence']:.2f}  edge {f['edge_fraction']:.2f}  "
              f"tex {f['texture_energy']:.2f}  dof {f['dof_range']:.2f}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", nargs="*")
    ap.add_argument("-o", "--out", default="sweep.json")
    ap.add_argument("--width", type=int, default=600)
    ap.add_argument("--report", help="read an existing sweep.json and summarise it")
    args = ap.parse_args(argv)

    if args.report:
        report(json.load(open(args.report)))
        return 0
    if not args.images:
        ap.error("give some images, or --report a previous sweep")
    rows = sweep(args.images, args.width, args.out)
    report(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
