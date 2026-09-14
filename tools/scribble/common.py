"""Shared helpers: image loading, rendering strokes to a raster, tone metrics."""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def load_gray(path, width=800, warm=0.0):
    """Load as luminance, optionally darkening warm colours.

    `warm` is a colour filter, the same move a black-and-white photographer
    makes when a subject and its background happen to share a luminance. A
    ginger cat against a green hedge is exactly that case: measured on one
    photo the cat read 0.42 and the hedge 0.40, so a faithful grey conversion
    turns the cat into a hole. Their red-minus-blue differs by more than
    twice, so subtracting some of it separates them.
    """
    from separate import _flatten
    im = _flatten(Image.open(path))
    h = round(im.height * width / im.width)
    im = im.resize((width, h), Image.LANCZOS)
    a = np.asarray(im, dtype=np.float64) / 255.0
    g = 0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]
    if warm:
        g = g - warm * (a[..., 0] - a[..., 2])
    return np.clip(g, 0.0, 1.0)


def levels(gray, black=0.0, white=1.0):
    """Remap luminance so `white` and anything above it becomes paper.

    Any photograph of a real page has no true white in it - the paper reads as
    a mid grey once the camera has metered for the room. Feed that straight to
    a density-driven algorithm and it dutifully inks the whole background, so
    a white point is not a nicety here, it is the difference between a drawing
    and a grey field.
    """
    if white <= black:
        return np.clip(gray, 0.0, 1.0)
    return np.clip((gray - black) / (white - black), 0.0, 1.0)


def auto_levels(gray, lo_pct=2.0, hi_pct=98.0):
    """Black and white points from the image's own luminance percentiles."""
    return float(np.percentile(gray, lo_pct)), float(np.percentile(gray, hi_pct))


def sample(field, x, y):
    h, w = field.shape
    xi = int(np.clip(x, 0, w - 1))
    yi = int(np.clip(y, 0, h - 1))
    return field[yi, xi]


def render(polylines, size, pen_px=1.4, ss=3):
    """Rasterise polylines (list of Nx2 arrays) as black ink on white."""
    w, h = size
    img = Image.new("L", (w * ss, h * ss), 255)
    d = ImageDraw.Draw(img)
    lw = max(1, int(round(pen_px * ss)))
    for pl in polylines:
        if len(pl) < 2:
            continue
        d.line([(float(x) * ss, float(y) * ss) for x, y in pl], fill=0, width=lw, joint="curve")
    return img.resize((w, h), Image.LANCZOS)


def to_svg(polylines, size, pen_mm=1.0, px_per_mm=None, path=None):
    w, h = size
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
             f'<rect width="{w}" height="{h}" fill="#fff"/>',
             f'<g fill="none" stroke="#1a2f8a" stroke-width="{pen_mm}" stroke-linecap="round" stroke-linejoin="round">']
    for pl in polylines:
        if len(pl) < 2:
            continue
        pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in pl)
        parts.append(f'<polyline points="{pts}"/>')
    parts += ["</g>", "</svg>"]
    svg = "\n".join(parts)
    if path:
        open(path, "w").write(svg)
    return svg


def render_layers(layers, size, pen_px=1.4, ss=3):
    """Rasterise coloured layers onto white, subtractively.

    Each layer is (rgb, polylines). Strokes multiply what is already on the
    page rather than painting over it, because that is what a second pen
    actually does to paper.
    """
    w, h = size
    canvas = np.ones((h, w, 3), dtype=np.float64)
    for rgb, polylines in layers:
        img = Image.new("L", (w * ss, h * ss), 255)
        d = ImageDraw.Draw(img)
        lw = max(1, int(round(pen_px * ss)))
        for pl in polylines:
            if len(pl) < 2:
                continue
            d.line([(float(x) * ss, float(y) * ss) for x, y in pl], fill=0,
                   width=lw, joint="curve")
        cov = 1.0 - np.asarray(img.resize((w, h), Image.LANCZOS),
                               dtype=np.float64) / 255.0
        ink = np.array(rgb, dtype=np.float64)[None, None, :]
        canvas *= (1.0 - cov[..., None]) + cov[..., None] * ink
    return Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8))


def to_svg_layers(layers, size, pen_mm=1.0, path=None):
    """One SVG, one group per pen, in drawing order."""
    w, h = size
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
             f'<rect width="{w}" height="{h}" fill="#fff"/>']
    for rgb, polylines in layers:
        col = "#" + "".join(f"{int(round(c * 255)):02x}" for c in rgb)
        parts.append(f'<g fill="none" stroke="{col}" stroke-width="{pen_mm}" '
                     f'stroke-linecap="round" stroke-linejoin="round">')
        for pl in polylines:
            if len(pl) < 2:
                continue
            pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in pl)
            parts.append(f'<polyline points="{pts}"/>')
        parts.append("</g>")
    parts.append("</svg>")
    svg = "\n".join(parts)
    if path:
        open(path, "w").write(svg)
    return svg


def tone_report(rendered_img, target_d, blur_px):
    """How close did the ink density get to the requested tone, per tone bucket?"""
    got = 1.0 - np.asarray(rendered_img.filter(ImageFilter.GaussianBlur(blur_px)), dtype=np.float64) / 255.0
    want = np.asarray(Image.fromarray((target_d * 255).astype(np.uint8)).filter(
        ImageFilter.GaussianBlur(blur_px)), dtype=np.float64) / 255.0
    lines = []
    edges = np.linspace(0, 1, 11)
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (want >= lo) & (want < hi)
        if m.sum() < 200:
            continue
        lines.append(f"  want {lo:.1f}-{hi:.1f}  got {got[m].mean():.3f}  (n={m.sum():,})")
    rms = float(np.sqrt(((got - want) ** 2).mean()))
    return "\n".join(lines) + f"\n  overall RMS tone error: {rms:.4f}"


def stroke_length(polylines):
    return sum(float(np.abs(np.diff(pl, axis=0)).sum()) for pl in polylines if len(pl) > 1)


def pen_travel(polylines):
    """Total drawn length (mm-agnostic px) and number of pen lifts."""
    total = 0.0
    for pl in polylines:
        if len(pl) < 2:
            continue
        total += float(np.sqrt(((np.diff(pl, axis=0)) ** 2).sum(axis=1)).sum())
    return total, max(0, len(polylines) - 1)
