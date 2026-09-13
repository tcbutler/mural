# Scribble shading

Prototypes for a scribble fill: a pen path whose *density* carries the tone,
rather than a hatch grid whose *spacing* does. The look is the loose, loopy
shading you get when someone shades with a biro and keeps the pen down.

Nothing here is wired into the renderer yet. These are standalone Python
scripts for judging whether the output is worth building as fill strategy #8,
and for measuring whether the tone actually comes out right.

```
pip install numpy pillow
python3 scribble.py photo.jpg -o out.svg --preview out.png
python3 scribble.py photo.jpg --algo contour     # follows the form
python3 scribble.py photo.jpg --algo greedy --join 8
python3 scribble.py --chart                      # ramp + sphere, with metrics
```

## The two algorithms

**`cycloid.py` — tone-modulated loops.** One pen path snakes across the image
in rows. Riding on it is a circle the pen keeps tracing; the rate at which the
circle's centre advances is set by the darkness underneath. Slow advance means
loops pile on top of each other and the area goes dark; fast advance stretches
them into a lazy wave. A simplification of Chiu et al. 2015, *Tone- and
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
does. `field.py` builds the orientation field from a structure tensor and
places evenly-spaced streamlines through it ([Jobard & Lefebvre
1997](https://www.researchgate.net/publication/2325033)). Measured tone is
unchanged from the row version, which is the payoff for deriving the advance
rate rather than tuning it.

**`greedy.py` — residual-darkness walk.** No geometry model at all. Keep a
buffer of the ink the image still owes. From wherever the pen is, throw out a
few dozen random candidate segments, score each by the mean residual along it,
draw the best, subtract the ink you just laid, repeat. Dark areas stay
attractive until they have been paid off, so density tracks tone. This is the
family behind Vrellis-style string art and DrawingBotV3's sketch path finders.

All three are non-deterministic; `--seed` makes a run repeatable.

## Pen lifts

A lift costs about two seconds whatever the strokes either side of it are
doing, so on a plot this long the chain count matters more than the ink. The
greedy walk strands itself constantly and produced ~2,600 chains on a test
photo. Measured on that image:

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
nothing on the paper. Joining strokes whose ends are already within a few nib
widths is what actually removes lifts, at about 7% more ink. Both live in
`stitch.py`, behind `--join`.

## Measuring tone, not eyeballing it

`common.tone_report` blurs the rendered strokes at the scale of the line
spacing and compares that against the blurred target, bucketed by tone. This is
the check that matters: a scribble can look great and still crush every midtone.
`synth.py` provides an 8-step ramp, a gradient and a shaded sphere to test
against.

## Known limits

- Both work on a raster, in image space. The renderer's fill strategies work on
  clipped vector paths in mm, so neither drops in as-is.
- `cycloid` cannot reach true black at a given row spacing: the loops overdraw
  their own ink faster than they cover new paper. Tighter rows fix it, at the
  cost of plot time.
- `greedy` costs seconds to tens of seconds per image in Python and would need
  rethinking to run in the browser at interactive speed.
- Neither is feature-aware. Chiu et al. steer the loops along image edges,
  which is what makes their output follow the form of the subject instead of
  lying in rows across it.
