// Prepares the source raster before anything quantizes or traces it.
//
// Every other stage of this pipeline decides HOW to draw the image. This one
// decides what the image even is, and it exists because a photograph can
// defeat the rest of the pipeline outright no matter which fill style it gets.
//
// Deliberately paper.js-free (same reasoning as grayscale.ts) so it can run
// and be unit tested without a DOM/canvas environment.

import { compositedLuminance } from './grayscale';

export type TonePreparation = {
    // Luminance (0..1) to treat as bare paper; 1 leaves the image alone.
    whitePoint?: number;
    // How much red-minus-blue to subtract from luminance; 0 leaves it alone.
    // Only meaningful on a path that is about to reduce the image to grey.
    warmth?: number;
};

/**
 * The preparation a given vectorize request actually calls for.
 *
 * The only subtlety is warmth on the colour path. Warmth is a workaround for
 * information greyscale conversion throws away: when a subject differs from
 * its background in hue but not in brightness, reducing to tone loses it. A
 * colour separation never reduces to tone - it separates BY hue - so the
 * filter has nothing to recover there and would only flatten the very
 * distinction the separation is about to draw. It is dropped rather than
 * honoured, and this lives here rather than inline at the call site so the
 * rule can be tested instead of assumed.
 */
export function preparationFor(request: {
    whitePoint?: number;
    warmth?: number;
    colorCount?: number;
}): TonePreparation {
    const separatesByColour = (request.colorCount ?? 0) >= 2;
    return {
        whitePoint: request.whitePoint,
        warmth: separatesByColour ? 0 : request.warmth,
    };
}

// Below this the white point is doing nothing worth the copy.
const MIN_MEANINGFUL_WHITE_POINT = 0.999;

export function needsPreparation(options: TonePreparation): boolean {
    const white = options.whitePoint ?? 1;
    const warmth = options.warmth ?? 0;
    return white < MIN_MEANINGFUL_WHITE_POINT || warmth > 0;
}

/**
 * Returns a new ImageData with the white point and warmth applied. The input
 * is never modified - callers hold on to the original raster for the gradient
 * field and for re-estimates.
 *
 * Order matters and matches the reasoning behind each step: the colour filter
 * runs first, because it is deciding which tones the subject and background
 * will end up having, and the white point runs second on the result, because
 * it is deciding where those tones sit relative to the paper.
 */
export function prepareTone(imageData: ImageData, options: TonePreparation): ImageData {
    const white = Math.min(1, Math.max(0.01, options.whitePoint ?? 1));
    const warmth = Math.max(0, options.warmth ?? 0);
    const { width, height, data } = imageData;
    const out = new Uint8ClampedArray(data.length);

    for (let p = 0; p < data.length; p += 4) {
        const a = data[p + 3];
        if (a === 0) {
            // Transparent is paper, and stays paper - matching the convention
            // in vectorizer.ts and imageCharacteristics.ts.
            out[p] = 255; out[p + 1] = 255; out[p + 2] = 255; out[p + 3] = 0;
            continue;
        }

        // Composited over white first, because that is what the pixel will
        // look like on the page, and the decisions below are about the page.
        const f = a / 255;
        let r = data[p] * f + 255 * (1 - f);
        let g = data[p + 1] * f + 255 * (1 - f);
        let b = data[p + 2] * f + 255 * (1 - f);

        if (warmth > 0) {
            // A colour filter, the move a black-and-white photographer makes
            // with a coloured lens filter. The output is deliberately neutral
            // grey: this path is converting to tone anyway, and writing the
            // filtered luminance into all three channels makes the conversion
            // explicit rather than leaving a colour behind for some later
            // stage to interpret differently.
            const lum = compositedLuminance(r, g, b, 255) - warmth * (r - b);
            r = g = b = Math.min(255, Math.max(0, lum));
        }

        if (white < 1) {
            // Scale rather than clip, and scale every channel by the same
            // factor, so lifting the paper to white does not shift the hue of
            // everything underneath it.
            const scale = 1 / white;
            r *= scale; g *= scale; b *= scale;
        }

        out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255;
    }

    return { data: out, width, height, colorSpace: 'srgb' } as unknown as ImageData;
}
