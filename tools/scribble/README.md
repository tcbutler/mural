# Scribble shading

Prototypes for fills where the pen path's *density* carries the tone, rather
than a hatch grid's *spacing*. The look is the loose, loopy shading you get
when someone shades with a biro and keeps the pen down.

Nothing here is wired into the renderer. These are standalone Python scripts
for judging whether the output is worth building as a real fill strategy, and
for measuring whether the tone actually comes out right.

```
pip install numpy pillow            # scipy as well, for --algo tsp

python3 scribble.py photo.jpg -o out.svg --preview out.png
python3 scribble.py photo.jpg --algo contour              # follows the form
python3 scribble.py photo.jpg --algo greedy --join 8
python3 scribble.py photo.jpg --algo tsp --points 20000 --break-edges 30
python3 scribble.py --chart                       # ramp + sphere, with metrics
```

## The four algorithms

**`cycloid.py` — tone-modulated loops.** One pen path snakes across the image
in rows. Riding on it is a circle the pen keeps tracing; the rate at which the
circle's centre advances is set by the darkness underneath. Slow advance means
loops pile on top of each other and the area goes dark; fast advance stretches
them into a lazy wave. A simplification of [Chiu et al.
2015](https://onlinelibrary.wiley.com/doi/10.1111/cgf.12761), *Tone- and
Feature-Aware Circular Scribble Art*.

The advance rate is derived, not tuned. Over one loop the pen lays about
`2*pi*r` of ink of width `pen` into a patch `advance` wide by `row_step` tall.
Ink that lands on ink is wasted, so the linear model saturates around 50% grey;
the Poisson coverage law `coverage = 1 - exp(-length * pen / area)` does not.
Invert it for the length the tone demands and solve for advance:

```
demand  = -ln(1 - darkness)
advance = 2*pi*r*pen / (demand * row_step)
```

Tone is then right by construction, and the knobs that remain — loop radius,
tilt, jitter, guide-path wobble — only change how it looks.

**`contour.py` + `field.py` — the same loop, following the form.** Identical
loop maths, but the guide path runs along the image's own structure instead of
along scanlines, so the loops lean with the subject the way hand-drawn scribble
does. `field.py` builds the orientation field from a structure tensor — the
tensor is what gets smoothed, not the vectors, which would cancel across an
edge — and places evenly-spaced streamlines through it (Jobard & Lefebvre
1997). Measured tone is unchanged from the row version, which is the payoff for
deriving the advance rate rather than tuning it: the guide path can be swapped
without disturbing the greys.

**`greedy.py` — residual-darkness walk.** No geometry model at all. Keep a
buffer of the ink the image still owes. From wherever the pen is, throw out a
few dozen random candidate segments, score each by the mean residual along it,
draw the best, subtract the ink you just laid, repeat. Dark areas stay
attractive until they have been paid off, so density tracks tone. This is the
family behind Vrellis-style string art and DrawingBotV3's sketch path finders.

**`tsp.py` — stipple and tour.** Weighted Voronoi relaxation scatters points at
a density matching the image (Secord 2002), then one closed tour visits all of
them (Bosch & Herman 2004). The tour starts in Hilbert-curve order and is
improved by 2-opt restricted to each city's ten nearest neighbours — about 9%
shorter than the Hilbert start, converging in well under a second for 20k
points. Optimal it is not, and for art it does not need to be.

The first three are non-deterministic; `--seed` makes a run repeatable.

## Measuring tone, not eyeballing it

`common.tone_report` blurs the rendered strokes at the scale of the line
spacing and compares that against the blurred target, bucketed by tone. This is
the check that matters: a scribble can look great and still crush every midtone.
`synth.py` provides an 8-step ramp, a gradient and a shaded sphere to test
against.

Measured on one test photo at 760px wide, 1.4px nib:

| Algorithm | Pen lifts | Ink | Tone RMS | Darkest reached |
|---|---|---|---|---|
| cycloid | 94 | 126k | 0.041 | 0.89 |
| contour | 299 | 124k | 0.045 | 0.93 |
| greedy | 2,566 | 97k | 0.051 | 0.85 |
| greedy `--join 8` | 317 | 105k | 0.056 | 0.87 |
| tsp, 20k points | 4 | 58k | 0.084 | 0.54 |

## Pen lifts

A lift costs about two seconds whatever the strokes either side of it are
doing, so on a plot this long the chain count matters more than the ink. The
greedy walk strands itself constantly and produced ~2,600 chains. Measured on
the same photo:

| Change | Lifts | Ink | Tone RMS |
|---|---|---|---|
| baseline | 2,660 | 98.2k | 0.051 |
| lighter target (gamma 2.0) | 2,227 | 69.7k | 0.070 |
| longer strokes (10-45px) | 1,452 | 103.2k | 0.057 |
| `stitch.order` | 2,660 | 98.2k | 0.051 |
| `stitch.order` + join 8px | **307** | 105.4k | 0.058 |

Turning the density down is the weak lever: a third less ink bought a sixth
fewer lifts, and cost more in tone than it saved in time. Ordering the strokes
nearest-neighbour cut pen-up *travel* 50-fold (646k px to 13k) while changing
nothing at all on the paper, so it runs by default for every algorithm.
Joining strokes whose ends are already within a few nib widths is what removes
the lifts, at about 7% more ink. Both live in `stitch.py`, behind `--join`.

TSP art has the opposite problem. Its single tour needs almost no lifts, but it
has to get from one dark region to another somehow, and those transits come out
as straight lines ruled across the white paper. `--break-edges` cuts the worst
of them, trading one pen lift for each ruled line removed.

## Known limits

- All of these work on a raster, in image space. The renderer's fill strategies
  work on clipped vector paths in mm, so none of them drops in as-is.
- `cycloid` and `contour` cannot reach true black at a given line spacing: the
  loops overdraw their own ink faster than they cover new paper. Tighter
  spacing fixes it, at the cost of plot time.
- `tsp` cannot get dark at all. A non-self-intersecting tour has no overdraw,
  so coverage is capped by how closely the line can pack — 20k points on the
  test photo topped out at 54% grey, and even 32k only reached 66%. More points
  is the only lever, and cost scales with it.
- `greedy` costs seconds per image in Python and would need rethinking to run
  in the browser at interactive speed.
- `contour` is feature-aware in the sense that it follows the form. It does not
  do the other half of Chiu et al., which varies loop *structure* near edges to
  keep them crisp.
