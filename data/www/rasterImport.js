// Photo (JPEG/PNG/WebP) input.
//
// The tracer has always been a raster tracer: vectorizer.ts takes ImageData and
// nothing else - potrace for the 1-bit mask, k-means for colour separation,
// nested luminance levels for grayscale. An uploaded SVG only ever reaches it by
// being rasterised first (svgControl.getCurrentSvgImageData). So a photo does
// not need a new pipeline; it needs one fewer step, because its pixels are
// already pixels and a vector intermediate could only lose detail.
//
// Rather than carry a second kind of source through pan/zoom, target size,
// preview and estimation - each of which reads the SVG DOM - a raster file is
// wrapped in a minimal SVG document holding the bitmap as its single <image>.
// normalizeSvg() finds width/height on the root exactly as it would on a real
// drawing, so every downstream stage is untouched.

import { rasterLongEdgePx } from './svgControl.js';

const RASTER_EXTENSIONS = /\.(jpe?g|png|webp)$/i;
const RASTER_MIME = /^image\/(jpeg|png|webp)$/i;

// JPEG artefacts become traced contours, so re-encoding is kept high quality -
// and only happens at all when the image has to be downscaled.
const JPEG_QUALITY = 0.92;

export function isRasterFile(file) {
    return RASTER_MIME.test(file.type || '') || RASTER_EXTENSIONS.test(file.name || '');
}

/**
 * Wraps a raster file as an SVG document sized in its own pixels.
 *
 * Bounded to rasterLongEdgePx - the size the tracer will sample at anyway - so a
 * 12MP phone photo neither carries detail that gets thrown away downstream nor
 * becomes a data URI large enough to matter. The bitmap is base64'd into the
 * wrapper, and the wrapper is base64'd again when it is rasterised, so the
 * source bytes are worth keeping small.
 */
export async function rasterFileToSvgString(file) {
    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch (err) {
        throw new Error(`Could not read ${file.name || 'that image'} - it may be corrupt or an unsupported format`);
    }

    const { width, height } = bitmap;
    if (!(width > 0) || !(height > 0)) {
        throw new Error('Image has no pixels');
    }

    // Never upscale: enlarging a small image invents detail the tracer would
    // then faithfully reproduce as contours.
    const scale = Math.min(1, rasterLongEdgePx / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const href = scale === 1 && RASTER_MIME.test(file.type || '')
        // Already small enough and a format the browser will re-decode as-is:
        // embed the original bytes rather than round-tripping through an encoder.
        ? await blobToDataURL(file)
        : await blobToDataURL(await downscale(bitmap, targetWidth, targetHeight, file.type));

    bitmap.close?.();

    // No preserveAspectRatio needed: the <image> box is the image's own size.
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `version="1.1" width="${targetWidth}" height="${targetHeight}" ` +
        `viewBox="0 0 ${targetWidth} ${targetHeight}">` +
        `<image width="${targetWidth}" height="${targetHeight}" xlink:href="${href}"/>` +
        `</svg>`;
}

async function downscale(bitmap, width, height, sourceType) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, width, height);

    // PNG unless the source was JPEG. Re-encoding a transparent PNG as JPEG
    // would flatten its transparency to black, and potrace reads transparent as
    // background and black as ink - so the background would become solid ink.
    const type = /^image\/jpeg$/i.test(sourceType || '') ? 'image/jpeg' : 'image/png';
    return await canvas.convertToBlob({ type, quality: JPEG_QUALITY });
}

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read image data'));
        reader.readAsDataURL(blob);
    });
}
