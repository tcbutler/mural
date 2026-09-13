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

## Smart defaults

```
python3 scribble.py photo.jpg --auto -o out.svg
python3 scribble.py photo.jpg --auto --prefer speed
python3 sweep.py corpus/*.jpg -o sweep.json      # re-fit against your own images
```

`--auto` reads the image, decides the preprocessing, picks an algorithm, and
prints why for each decision. `features.py` provides the descriptors, measured
at a fixed analysis width - several of them are resolution-sensitive, and a
default that changes when you change the output size is not a default.

**For photographs, the algorithm barely matters.** The median gap between the
best config and the second best is 0.030 of composite score. The best single
fixed choice - the greedy walk - still costs 0.048 on average and loses by
more than 0.05 on 10 images out of 23, so it is the best default rather than a
free lunch. A decision tree over image features would be fitting the noise
under those margins, so there isn't one.

What does change the answer is what you are optimising:

| objective | winner |
|---|---|
| legibility alone | greedy, 19 of 23 |
| tone alone | cycloid/12 10, greedy 8 |
| plot time alone | tsp, 19 of 23 |

**For flat art, the answer is "not these fills".** An image with no mid-tones
is regions of solid ink and regions of bare paper, and there is no density to
modulate. Measured on a solid black page: the loop fills drew 5.3x, and the
greedy walk 3.9x, the line a plain hatch at nib spacing needs for the same
coverage - 250 minutes against 48, because they overdraw. The TSP tour manages
23 minutes by simply failing to make it black, at 0.59 tone error. `suggest`
returns no config for that case and says to use the renderer's hatch
strategies. Small isolated solids on bare paper are the exception: little
enough ink that the overdraw does not matter.

TSP's cheapness is real rather than an artefact of under-inking - every config
lands within 15% of its ink budget. A tour that never crosses itself lays every
unit of line on fresh paper, so it needs about 2.5x less of it for the same
coverage. The ranking flips between a cost weight of 0.2 and 0.3, which is why
`--prefer` is one question rather than a classifier.

The preprocessing is where the real decisions are, and each one below exists
because something here failed without it.

## Levels, before anything else

A photograph of a real page has no true white in it. The paper meters as a mid
grey, so a density-driven algorithm dutifully inks the entire background and
you get a grey field instead of a drawing. On a photo of a canvas the paper
ground sat at 0.61 luminance; `--white 0.62` was the difference between mush
and a legible image. `--auto-levels` will not save you here, because the 98th
percentile is still well above the paper.

`--warm` is for a third case, and it is the one that decides whether a photo
works at all. A subject and its background can share a luminance while looking
nothing alike in colour. Measured on a photo of a ginger cat against a green
hedge: cat 0.42, hedge 0.40. Converted faithfully to grey, the cat comes out as
a *hole* in a dark surround. Their red-minus-blue differs by more than twice
(0.31 against 0.13), so `--warm 0.6` subtracts some of that and the cat becomes
the dark shape it ought to be. This is the same move a black-and-white
photographer makes by screwing a coloured filter onto the lens, and no amount
of algorithm choice substitutes for it.

`--blur` matters for a second class of source: anything whose tone is already
dithered - a halftone, a hatched engraving, another scribble drawing. The
loop-based fills have a characteristic cell size, and when the source's own
texture is near that size the two beat against each other and the output
clumps into rosettes. Softening the source first removes the beat. The greedy
walk is immune, having no cell size to beat against.

## Depth of field

`--focus` uses the photograph's own focus to separate subject from background,
holding ink back where the source is blurred. It is a compositional control
rather than a fidelity one - a hand would suppress a busy background, and no
purely local tone rule does that on its own.

Sharpness is measured as the energy left after subtracting a small blur, then
spread with a local *maximum* rather than an average. That distinction matters:
a smooth patch inside a sharp subject - the flank of a cat, a plain wall -
carries no fine detail of its own, so averaging marks it out of focus and
knocks the middle out of your subject. A maximum lets the nearest sharp edge
vouch for it. Measure it on the raw luminance, before levels or blur, or the
thing being measured is already gone.

`--focus 0.85` thinned the far hedge on the test photo to an airy suggestion
while the cat and the near flowers kept their weight, and took ~8% off the pen
lifts as a side effect.

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

## Colour

`--pens` gives each pen its own pass, composed into one SVG with a group per
colour. Tinting a greyscale scribble does not make a two-colour drawing, so the
work is in the separation: `separate.py` converts to density (`-log` of
reflectance, where a pen's effect becomes additive) and solves a non-negative
least squares per colour for how much of each pen a pixel wants. Non-negative
matters - an unconstrained fit cheerfully asks for a negative amount of green
to make something oranger. Colours are quantised first, so the solve runs a few
thousand times rather than half a million, and it costs about a tenth of a
second.

```
python3 scribble.py photo.jpg --pens 2 --algo greedy --join 8
python3 scribble.py photo.jpg --pens '#b4541a,#2f5d2a' --algo greedy --join 8
```

Two things were needed to make auto-picked pens usable, and both are worth
knowing if you pick your own:

- **Cluster hue, not colour.** K-means on raw RGB separates by brightness, so a
  ginger cat and a green hedge - which differ in hue and hardly at all in tone
  - both came back the same olive. Clustering chromaticity fixes it.
- **Pens are darker than the image.** The first version drove each cluster to
  full saturation and got bright pastel pens, which need impossible coverage to
  reach a mid-tone, so one pen ended up carrying the whole drawing. Scaling
  each pen down to a pen-like luminance fixed it.

Layers draw light pen first, so where two colours meet it is the darker nib
crossing the lighter ink - the direction you cannot see. Same convention as the
renderer's colour layers. `--paper` sets how much of the image counts as bare
paper, which is the colour version of the white-point problem above.

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
- `contour` also needs a source whose structure is smooth at the scale of the
  line spacing. On a busy one the orientation field picks up the noise instead
  of the shape; `--blur` and `--field-smooth` are the controls for that.
