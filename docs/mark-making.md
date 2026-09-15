# Mark-making

How Mural 2.0 puts ink on paper: eight fill styles, tonal shading from one pen,
and multi-colour separation with pen swaps.

Every picture here is drawn from the real command file the machine would
execute, by `tools/make_style_examples.js`, so the strokes are the strokes the
pen makes. Regenerate them with:

```bash
node tools/make_style_examples.js                      # every style, test image
node tools/make_style_examples.js --mode grayscale --levels 4 --image path/to.jpg
node tools/make_style_examples.js --mode color --colors 6 --hue-grouping --image path/to.png
```

The test image comes from `tools/make_style_source.py`, and is built to exercise
the pipeline rather than to look nice: a smooth gradient for gradient hatch to
follow, flat colour for contour and spiral, a second ramp at another angle, thin
line work, and a wordmark knocked out of a shadowed band.

---

## Before the marks: what the image even is

Every control below decides how to draw the image. Two decide what the image
is, and they sit above the rest in the preview because a photograph can defeat
the whole pipeline no matter which fill style it gets. Both rest at a no-op and
both are recommended per image, with the reason shown underneath.

**Paper brightness** is the brightness that counts as bare paper. A photograph
of a page has no true white in it: metered for the room, the paper comes back a
mid grey, and the tracer then inks the entire background. On a photo of a pen
drawing on canvas, the brightest real tone measured 87% — at the lightest of
three tonal levels, that was 89% of the frame going to ink, against 69% once
the white point was set to what the paper actually measures.

**Colour filter** darkens warm colours against cool ones before the image is
reduced to tone, the way a coloured lens filter does for black-and-white film.
A subject and its background can share a brightness and look nothing alike: on
a photo of a ginger cat against a green hedge, the cat read 0.42 and the hedge
0.40, so a faithful grey conversion turned the cat into a hole in a dark
surround. Their red-minus-blue differed by more than twice. No fill style
recovers that — the information has already left the channel. The strength
(0.6) was picked by blind comparison of the same photo at 0, 0.3 and 0.6.

It is dropped on the multi-colour path, and the control goes with it: that path
separates *by* hue and still has the colour, so the filter would only flatten
what is about to be drawn.

---

## The eight fill styles

The original cross-hatch plus seven new ones, all on the same image at 400 × 229 mm
and infill density 3, so the numbers are comparable.

<img src="../images/style-examples/source.png" width="480" alt="Source image: a gradient disc, flat colour shapes, a vertical colour ramp, thin diagonal line work, and MURAL2.0 knocked out of a dark band with a soft drop shadow">

| | | |
|---|---|---|
| <img src="../images/style-examples/crossHatch45.png" width="230"><br>**Cross-hatch** (default)<br><sub>Even 45° grid · 174 strokes · 10.9 m</sub> | <img src="../images/style-examples/singleDirectionHatch.png" width="230"><br>**Single-direction**<br><sub>One diagonal, ~⅔ the ink · 90 strokes · 7.1 m</sub> | <img src="../images/style-examples/crossHatchAngled.png" width="230"><br>**Angled cross-hatch**<br><sub>Any angle; colour layers each get their own · 169 strokes · 10.8 m</sub> |
| <img src="../images/style-examples/jitteredHatch.png" width="230"><br>**Jittered**<br><sub>Hand-drawn wobble · 170 strokes · 10.8 m</sub> | <img src="../images/style-examples/spiral.png" width="230"><br>**Spiral**<br><sub>One continuous stroke per region · 91 strokes · 7.1 m</sub> | <img src="../images/style-examples/contour.png" width="230"><br>**Contour**<br><sub>Rings following the shape's own outline · 33 strokes · 5.9 m</sub> |
| <img src="../images/style-examples/gradientHatch.png" width="230"><br>**Gradient hatch**<br><sub>Follows the image's shading · 79 strokes · 5.6 m</sub> | <img src="../images/style-examples/cycloid.png" width="230"><br>**Loop scribble**<br><sub>Biro shading; loops crowd for tone · 127 strokes · 11.0 m</sub> | |

Note how thin gradient hatch looks here: it only marks where the image actually
has shading to follow, and most of this test image is flat colour. Give it
something with tone and it behaves completely differently.

**Loop scribble** fills a shape with rows of continuous looping strokes, the
way someone shades with a biro without lifting the pen. The loops crowd
together for a darker tone and stretch out for a lighter one, and the advance
rate that controls that is solved rather than tuned: ink landing on ink covers
no new paper, so the naive reading saturates around half tone and flattens
everything above a mid grey into the same shade.

It is matched to the default cross-hatch's ink rather than to the lighter
styles, which is deliberate. Matched to a single-direction hatch the loops
stretch out into a plain wavy line — correct tone, no scribble. Matched to
cross-hatch they are real loops, and swapping to it changes the handwriting
rather than the density. The match is exact by construction, at every
density: a row of loops lays the same length of ink as the two hatch passes
it stands in for.

What it does cost is waypoints. The command file stores every point along a
stroke, and a curve needs far more of them than a straight line — about two
and a half times as many for the same ink. On an A2 sheet with six pens at
the densest infill that is a 394KB command file against cross-hatch's 172KB,
where the machine has around 600KB of filesystem free. It fits, with less
room to spare than any other style.

Give it one flat region and it draws a texture. Give it tone and it draws
shading, which is the point of it:

| | |
|---|---|
| <img src="../images/style-examples/crossHatch45-gray4.png" width="330"><br><sub>Cross-hatch, 4 levels · 1,345 strokes · 28.7 m</sub> | <img src="../images/style-examples/cycloid-gray4.png" width="330"><br><sub>Loop scribble, 4 levels · 1,329 strokes · 29.5 m</sub> |

### The right style for the subject

**Gradient hatch** wants continuous tone. On a shaded painting it stops being a
fill and starts being an engraving — the strokes follow the muscle rather than
crossing it, for *less* ink than the flat grid:

| | |
|---|---|
| <img src="../images/style-examples/crossHatch45-horse.png" width="330"><br><sub>Cross-hatch · 146 strokes · 11.2 m</sub> | <img src="../images/style-examples/gradientHatch-horse.png" width="330"><br><sub>Gradient hatch · 199 strokes · 7.5 m</sub> |

**Contour and spiral** want flat, clean-edged shapes, where following the outline
means something:

| | |
|---|---|
| <img src="../images/style-examples/contour-bluey.png" width="330"><br><sub>Contour · 56 strokes · 9.4 m</sub> | <img src="../images/style-examples/spiral-bluey.png" width="330"><br><sub>Spiral · 141 strokes · 11.3 m</sub> |

### Tone and colour

**Grayscale (tonal)** traces nested luminance bands and hatches each at its own
density, so one pen renders shading. More levels means more separation and more
time:

| | | |
|---|---|---|
| <img src="../images/style-examples/crossHatch45-mono.png" width="230"><br><sub>Single colour · 146 strokes · 11.2 m</sub> | <img src="../images/style-examples/crossHatch45-gray3.png" width="230"><br><sub>3 levels · 1,201 strokes · 27.5 m</sub> | <img src="../images/style-examples/crossHatch45-gray4.png" width="230"><br><sub>4 levels · 1,345 strokes · 28.7 m</sub> |

A photograph traced this way throws off thousands of specks, and a speck
smaller than the nib is not a shape the pen can draw — trace it or touch the
pen down once and the mark is the same dot of ink. Tracing one costs a
pen-down, a pen-up and the travel to reach it, so anything narrower than the
pen is left out (`infill.ts`). On a four-level horse at the 2400px the app
rasterises to, that is around 1,500 strokes and some hundred minutes of
plotting, at the price of slightly lighter mid-tones. Despeckle does not
substitute for it: `turdSize` is an area in source pixels, so what it means on
paper changes with the size of the raster.

**Multi-colour** separates the image into one mask per pen and stops for a swap
between them. It suits flat artwork, which is what k-means quantisation is good
at.

Every extra pen is a pen you have to own and a swap you have to stand around
for, so **hue grouping** is usually the setting you want: similar hues collapse
onto one pen, and the lighter shades of that hue are drawn as sparser hatching
instead of as separate inks. Two blues become one blue pen at two densities.

| | |
|---|---|
| <img src="../images/style-examples/crossHatch45-color-bluey.png" width="330"><br><sub>**5 pens, no grouping** · 727 strokes · 33.3 m</sub> | <img src="../images/style-examples/crossHatch45-hue-bluey.png" width="330"><br><sub>**6 colours detected → 3 pens** · 1,977 strokes · 45.2 m</sub> |

Three pens carry it: one blue, one orange, one near-black. The tonal separation
that five pens spent ink on is done with hatch density instead — which is why
the grouped version reads more strongly despite using fewer inks. It costs more
ink and time, because rendering a tint as hatching means actually drawing it
rather than swapping to a paler pen.

A caveat worth knowing before you try it on the wrong thing. The wordmark image
looks like it should be perfect for five pens — five obvious hues — and it very
nearly is:

<img src="../images/style-examples/crossHatch45-color-word.png" width="420" alt="The wordmark test image separated into five pens">

<sub>5 pens · 117 strokes · 6.9 m. Blue, yellow, red and navy all separate; the green ramp does not.</sub>

The green loses out to something that isn't a colour at all: the soft drop
shadow. 17% of that image's non-paper pixels are near-neutral grey and 84% of
those are the shadow, which is a large enough mass of tone to claim a pen on
merit. Asking for *more* pens makes it worse rather than better — at six, the
extra pens go to a second and third shade of grey and both the blue disc and the
green ramp drop out.

The same thing shows up in the Bluey renders as a faint ragged oval around the
family, which isn't obvious in the source: it's a soft blue halo that ramps from
invisible up to about 23% opacity. Compositing over white removes 99% of it, but
the denser inner part reaches a colour distance of 0.08 from paper — three times
further than a legitimately pale cream ink at 0.0255 — so no "too pale to draw"
rule can remove it without removing real content too. Anything with tone in it
gets drawn, because a pen has no way to draw 5% of a colour. Hue grouping handles
it more gracefully than flat separation does, rendering it as sparse hatching
rather than an outline.

So: flat art with distinct hues separates cleanly. Art with large soft shadows or
broad pale washes spends pens on tone, and hue grouping (above) is the better
tool for it.

Regenerate any of these with:

```bash
node tools/make_style_examples.js                      # every style, test image
node tools/make_style_examples.js --mode grayscale --levels 4 --image path/to.jpg
node tools/make_style_examples.js --mode color --colors 5 --image path/to.png
node tools/make_style_examples.js --mode color --colors 6 --hue-grouping --image path/to.png
```

The density ladder now reaches 2.5mm spacing (was 7mm), which is what makes true mid-tones possible rather than only light tints.
