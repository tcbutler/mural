#!/usr/bin/env python3
"""Builds the synthetic test image used by the README's style gallery.

Deliberately not a photograph: each element is here to exercise one part of the
pipeline, so a change in behaviour shows up as a change in the picture.

  smooth gradient disc  something for gradientHatch to actually follow
  flat colour shapes    clean edges, for contour and spiral
  vertical colour ramp  a second gradient at a different angle
  thin diagonal lines   fine detail, for despeckle and single-direction hatch
  knocked-out wordmark  white text out of a shadowed band

The wordmark is knocked out rather than drawn on top on purpose: dark text over a
coloured shape is one ink region to a 1-bit tracer and disappears into the fill.
The soft drop shadow under the band is a translucency test - it must read as the
grey it looks like, not the black it stores.

  python3 tools/make_style_source.py
"""

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import os

W, H = 1400, 800
OUT = os.path.join(os.path.dirname(__file__), '..', 'images', 'style-examples', 'source.png')
FONT = '/System/Library/Fonts/Supplemental/Arial Black.ttf'


def ramp(c0, c1, horizontal=True):
    g = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(g)
    n = W if horizontal else H
    for i in range(n):
        t = i / max(1, n - 1)
        col = tuple(round(c0[k] + (c1[k] - c0[k]) * t) for k in range(3))
        d.line([(i, 0), (i, H)] if horizontal else [(0, i), (W, i)], fill=col)
    return g


def masked(base, gradient, shape):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    mask = Image.new('L', (W, H), 0)
    shape(ImageDraw.Draw(mask))
    layer.paste(gradient.convert('RGBA'), (0, 0), mask)
    return Image.alpha_composite(base, layer)


im = Image.new('RGBA', (W, H), (255, 255, 255, 255))
im = masked(im, ramp((46, 92, 173), (186, 220, 255)), lambda d: d.ellipse([70, 60, 470, 460], fill=255))

d = ImageDraw.Draw(im)
d.rounded_rectangle([1010, 70, 1330, 250], radius=24, fill=(232, 86, 62, 255))
d.ellipse([560, 90, 760, 290], fill=(246, 196, 62, 255))

im = masked(im, ramp((28, 138, 106), (226, 247, 238), horizontal=False),
            lambda d: d.rectangle([800, 60, 980, 300], fill=255))

d = ImageDraw.Draw(im)
for i in range(16):
    x = 90 + i * 40
    d.line([(x, 760), (x + 24, 660)], fill=(70, 70, 70, 255), width=5)

band = [60, 500, 1340, 640]
shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle(
    [band[0] + 14, band[1] + 18, band[2] + 14, band[3] + 18], radius=18, fill=(0, 0, 0, 120))
im = Image.alpha_composite(im, shadow.filter(ImageFilter.GaussianBlur(16)))
im = masked(im, ramp((22, 26, 46), (70, 84, 128)),
            lambda d: d.rounded_rectangle(band, radius=18, fill=255))

font = ImageFont.truetype(FONT, 104)
d = ImageDraw.Draw(im)
text = "MURAL2.0"
bb = d.textbbox((0, 0), text, font=font)
d.text(((W - (bb[2] - bb[0])) // 2 - bb[0],
        band[1] + (band[3] - band[1] - (bb[3] - bb[1])) // 2 - bb[1]),
       text, font=font, fill=(255, 255, 255, 255))

# Saved without palette quantisation: this is pipeline INPUT, and reducing it to
# a small palette changes what the colour separator sees.
im.convert('RGB').save(os.path.normpath(OUT), optimize=True)
print('wrote', os.path.normpath(OUT), im.size)
