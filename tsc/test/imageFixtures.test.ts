/**
 * Regression tests against the two real images that broke the tracer, kept in
 * images/test_images/ rather than reconstructed here. Both failures were found
 * on these exact files, and both were invisible to synthetic fixtures:
 *
 *   Bluey_Hero.png   RGBA, a quarter of it semi-transparent. The ink test read
 *                    the stored colour and only checked a pixel was not FULLY
 *                    transparent, so the soft translucent backdrop traced as
 *                    solid ink and the whole image came out hatched.
 *
 *   Brown-Horse-...  JPEG. Lossy compression leaves the white background at
 *                    250-254 varying per 8x8 block, so an exact-equality-with-
 *                    white ink test traced the compressor's block grid.
 *
 * Decoding needs the native `canvas` addon, which the project's install
 * instructions (`npm install --ignore-scripts`) deliberately skip - so these
 * self-skip the same way multicolor.test.ts and vectorizerFringe.test.ts do,
 * and run in CI, where npm install builds it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

process.env.server = "1";

function tryLoadCanvas(): any | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require("canvas");
    } catch {
        return undefined;
    }
}

const canvasModule = tryLoadCanvas();

// Resolved by walking up rather than hardcoding a depth, so this keeps working
// whether the test runs from dist-test/ or anywhere else.
function fixtureDir(): string {
    let dir = __dirname;
    for (let up = 0; up < 6; up++) {
        const candidate = path.join(dir, "images", "test_images");
        if (fs.existsSync(candidate)) return candidate;
        dir = path.dirname(dir);
    }
    throw new Error("could not locate images/test_images");
}

const BLUEY = "Bluey_Hero.png";
const HORSE = "Brown-Horse-Clipart-GraphicsFairy.jpg";

async function loadImageData(filename: string): Promise<ImageData> {
    const image = await canvasModule.loadImage(path.join(fixtureDir(), filename));
    const canvas = canvasModule.createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height) as unknown as ImageData;
}

/** Ink fraction over a sub-rectangle, given as fractions of width/height. */
function inkFraction(bitmap: (1 | 0)[], width: number, height: number,
                     x0: number, y0: number, x1: number, y1: number): number {
    let ink = 0, total = 0;
    for (let y = Math.floor(y0 * height); y < Math.floor(y1 * height); y++) {
        for (let x = Math.floor(x0 * width); x < Math.floor(x1 * width); x++) {
            total++;
            if (bitmap[y * width + x] === 1) ink++;
        }
    }
    return total === 0 ? 0 : ink / total;
}

/** What the ink test used to be: stored colour, gated only on "not fully transparent". */
function legacyInkCount(image: ImageData, threshold: number): number {
    let ink = 0;
    for (let i = 0; i < image.width * image.height; i++) {
        const o = i * 4;
        const luminance = 0.299 * image.data[o] + 0.587 * image.data[o + 1] + 0.114 * image.data[o + 2];
        if (image.data[o + 3] > 0 && luminance <= threshold) ink++;
    }
    return ink;
}

if (!canvasModule) {
    test("image fixtures (skipped: native canvas addon not built)", () => {
        assert.ok(true);
    });
} else {
    const { buildGrayscaleBitmap, BACKGROUND_LUMINANCE_THRESHOLD } =
        require("../src/grayscale") as typeof import("../src/grayscale");

    test("fixture guard: Bluey is the RGBA image these tests assume", async () => {
        const image = await loadImageData(BLUEY);
        let transparent = 0, semi = 0;
        for (let i = 0; i < image.width * image.height; i++) {
            const a = image.data[i * 4 + 3];
            if (a === 0) transparent++;
            else if (a < 255) semi++;
        }
        const total = image.width * image.height;
        // If someone swaps the file for something opaque, these tests stop
        // testing anything - so say so here rather than passing vacuously.
        assert.ok(semi / total > 0.15,
            `expected a substantially semi-transparent image, got ${(100 * semi / total).toFixed(1)}%`);
        assert.ok(transparent / total > 0.15,
            `expected a substantially transparent background, got ${(100 * transparent / total).toFixed(1)}%`);
    });

    test("Bluey: the translucent background is not drawn", async () => {
        const image = await loadImageData(BLUEY);
        const bitmap = buildGrayscaleBitmap(image, BACKGROUND_LUMINANCE_THRESHOLD);

        // The characters sit in the middle; all four corners are backdrop.
        for (const [x0, y0, x1, y1, corner] of [
            [0, 0, 0.12, 0.12, "top-left"],
            [0.88, 0, 1, 0.12, "top-right"],
            [0, 0.88, 0.12, 1, "bottom-left"],
            [0.88, 0.88, 1, 1, "bottom-right"],
        ] as const) {
            const ink = inkFraction(bitmap, image.width, image.height, x0, y0, x1, y1);
            assert.equal(ink, 0, `expected no ink in the ${corner} corner, got ${(100 * ink).toFixed(1)}%`);
        }

        // And it must not have thrown the artwork away with the backdrop.
        const middle = inkFraction(bitmap, image.width, image.height, 0.35, 0.35, 0.65, 0.65);
        assert.ok(middle > 0.2, `expected the characters to be drawn, got ${(100 * middle).toFixed(1)}% ink`);
    });

    test("Bluey: compositing over white removes most of what the old rule drew", async () => {
        const image = await loadImageData(BLUEY);
        const now = buildGrayscaleBitmap(image, BACKGROUND_LUMINANCE_THRESHOLD)
            .reduce((total: number, bit) => total + bit, 0);
        const before = legacyInkCount(image, BACKGROUND_LUMINANCE_THRESHOLD);

        assert.ok(now < before * 0.7,
            `expected the translucent backdrop to drop out: ${before} pixels of ink before, ${now} after`);
    });

    // Measured: only 1.8% of this image is near-white-but-not-white, against
    // 21.6% for the JPEG stamp in vectorizeThreshold.test.ts. Lossy compression
    // held flat white together well here, so the halo is confined to the
    // silhouette edge. That makes the horse a weak fixture for the
    // JPEG-background bug (the synthetic stamp covers that properly) and a good
    // one for the opaque continuous-tone case below.
    test("fixture guard: the horse is an opaque JPEG on a white background", async () => {
        const image = await loadImageData(HORSE);
        let pureWhite = 0, nearWhite = 0;
        for (let i = 0; i < image.width * image.height; i++) {
            const o = i * 4;
            const [r, g, b] = [image.data[o], image.data[o + 1], image.data[o + 2]];
            if (r === 255 && g === 255 && b === 255) pureWhite++;
            else if (r > 245 && g > 245 && b > 245) nearWhite++;
        }
        const total = image.width * image.height;
        assert.ok(nearWhite / total > 0.01,
            `expected some lossy near-white pixels, got ${(100 * nearWhite / total).toFixed(1)}%`);
        assert.ok(pureWhite / total > 0.1, "expected a mostly white background");
    });

    test("the horse's JPEG background is not traced as ink", async () => {
        const image = await loadImageData(HORSE);
        const bitmap = buildGrayscaleBitmap(image, BACKGROUND_LUMINANCE_THRESHOLD);

        // Corners are background in this image; the horse does not reach them.
        for (const [x0, y0, x1, y1, corner] of [
            [0, 0, 0.1, 0.1, "top-left"],
            [0.9, 0.85, 1, 1, "bottom-right"],
        ] as const) {
            const ink = inkFraction(bitmap, image.width, image.height, x0, y0, x1, y1);
            assert.equal(ink, 0, `expected no ink in the ${corner} corner, got ${(100 * ink).toFixed(1)}%`);
        }

        const body = inkFraction(bitmap, image.width, image.height, 0.25, 0.35, 0.5, 0.55);
        assert.ok(body > 0.9, `expected the horse's body to be solid ink, got ${(100 * body).toFixed(1)}%`);
    });

    test("the horse carries a gradient field worth following", async () => {
        const image = await loadImageData(HORSE);
        const { computeGradientField, chooseSampleSpacingPx } =
            require("../src/imageGradient") as typeof import("../src/imageGradient");

        const field = computeGradientField(image, chooseSampleSpacingPx(image.width, image.height));
        const magnitudes: number[] = Array.from(field.magnitudes);
        assert.ok(magnitudes.length > 0, "expected a populated gradient field");

        // gradientHatch's FLAT_MAGNITUDE_THRESHOLD. Duplicated rather than
        // imported because that module pulls in paper.js; if it is ever retuned,
        // this number is the reason a shaded photo still engages the strategy.
        const FLAT_MAGNITUDE_THRESHOLD = 0.08;
        const usable = magnitudes.filter(m => m >= FLAT_MAGNITUDE_THRESHOLD).length;
        assert.ok(usable / magnitudes.length > 0.05,
            `expected shading the gradient strategy can follow, got ${(100 * usable / magnitudes.length).toFixed(1)}% of cells`);
    });
}
