/**
 * Processing-time-estimator calibration harness.
 *
 * WHY THIS EXISTS: tsc/src/processingEstimator.ts's cost coefficients (the
 * `*_US_PER_*` constants) were originally written from reasoning, not
 * measurement, and were off by roughly two orders of magnitude on top of a
 * separately-broken device-calibration constant (see deviceCalibration.ts's
 * REFERENCE_BENCHMARK_MS comment for that half of the story). This script
 * times the REAL pipeline (src/toCommands.ts and the stage functions it
 * calls) across a spread of real inputs, so those constants can be re-fit
 * against actual measurements instead of intuition.
 *
 * HOW TO RUN:
 *   cd tsc
 *   npm install                      # NOT --ignore-scripts - needs the
 *                                     # native `canvas` addon so paper.js
 *                                     # loads for real (see
 *                                     # test/pipeline.test.ts's header for
 *                                     # why --ignore-scripts breaks this).
 *   npx tsc -p tsconfig.test.json
 *   node dist-test/bench/runBenchmarks.js
 *
 * Or: npm run bench (see package.json).
 *
 * Optional env vars:
 *   MURAL_BENCH_OUT=/path/to/results.json   write the full raw measurement
 *                                            table as JSON (for feeding into
 *                                            a separate fitting pass) in
 *                                            addition to the console summary.
 *   MURAL_BENCH_IMAGES_DIR=/path/to/dir     override where SVG_Logo.svg /
 *                                            Bluey_Hero.png /
 *                                            Brown-Horse-Clipart-GraphicsFairy.jpg
 *                                            are read from. Defaults to
 *                                            ~/Downloads, where they lived
 *                                            when this harness was built.
 *
 * WHAT IT MEASURES (stage names match processingEstimator.ts's breakdown):
 *   - vectorize: src/vectorizer.ts's vectorizeImageData (1-bit),
 *     vectorizeImageDataGrayscale (N nested luminance levels), and
 *     vectorizeImageDataColor (k-means + N independent masks), across a
 *     spread of pixel counts, level counts, and color counts.
 *   - flattenKnockout: src/flattener.ts's flattenPaths (intra-layer) at a
 *     spread of shape counts, and flattenPathsAcrossLayers (cross-layer,
 *     multi-color knockout) via full multi-color renders with
 *     colorOverprint on vs. off.
 *   - infill: src/infill.ts's generateInfills, once per registered fill
 *     strategy (src/fillStrategies/registry.ts) x a spread of densities.
 *   - optimize: src/optimizer.ts's optimizePaths (greedy nearest-neighbour +
 *     bounded 2-opt), same matrix as infill (it consumes infill's output).
 *   - renderSimplifyDedupe: src/renderer.ts's renderPathsToCommands +
 *     src/trimmer.ts's trimCommands + src/deduplicator.ts's dedupeCommands +
 *     src/measurer.ts's measureDistance, PLUS src/simplifier.ts's RDP pass
 *     (which actually runs earlier in the real pipeline, on the freshly
 *     traced paths before infill - see the note in that stage's section
 *     below for why it's still bucketed here).
 *
 * It also runs several full end-to-end renderSvgJsonToCommands calls (the
 * real production entry point, unmodified) to sanity-check the *sum* of the
 * refitted coefficients against real wall-clock time, independent of
 * per-stage attribution errors.
 */
import * as fs from 'fs';
import * as path from 'path';
// MUST be imported before any src/ module - it sets process.env.server = '1'
// at its own top, which paperLoader.ts's loadPaper() needs to see before any
// module (e.g. fillStrategies/registry.ts below, which calls loadPaper() at
// import time) first calls it. See pipelineHarness.ts's own header comment.
import {
    buildRenderRequest,
    loadRasterImageDataAsync,
    readSvgFile,
    runSingleColorStages,
    svgStringToSvgJson,
    timeFullRender,
    timeHueGrouping,
    timeMs,
    timeRdpSimplify,
    timeVectorizeColor,
    timeVectorizeGrayscale,
    timeVectorizeSingle,
    tracePathsForRequest,
} from './pipelineHarness';
import { analyzeImageCharacteristics } from '../src/imageCharacteristics';
import { DEFAULT_NIB_WIDTH_MM } from '../src/huePalette';
import { mulberry32 } from '../src/fillStrategies/seededRandom';
import { DEFAULT_INK_CEILING, inkDemand } from '../src/scribble/demand';
import { greedyScribble } from '../src/scribble/greedy';
import { tspScribble } from '../src/scribble/tsp';
import { measureChains, stitch } from '../src/scribble/stitch';
import { scribbleToSvg } from '../src/scribble/toSvg';
import { MarkMode } from '../src/scribble';
import { InfillDensity } from '../src/types';
import { FillStrategyName } from '../src/fillStrategyNames';
import { fillStrategies } from '../src/fillStrategies/registry';

const IMAGES_DIR = process.env.MURAL_BENCH_IMAGES_DIR || path.join(require('os').homedir(), 'Downloads');
// Two of the three fixtures now live in the repository (images/test_images),
// so a checkout can run most of this harness without anyone having to put
// files in ~/Downloads first. An explicit MURAL_BENCH_IMAGES_DIR still wins,
// and SVG_Logo.svg is still a fixture you have to supply.
// Relative to dist-test/bench/, which is where this file actually runs from
// (see the HOW TO RUN header) - not to bench/.
const REPO_IMAGES_DIR = path.resolve(__dirname, '../../../images/test_images');
function fixturePath(filename: string): string {
    const configured = path.join(IMAGES_DIR, filename);
    if (process.env.MURAL_BENCH_IMAGES_DIR || fs.existsSync(configured)) return configured;
    const inRepo = path.join(REPO_IMAGES_DIR, filename);
    return fs.existsSync(inRepo) ? inRepo : configured;
}
const SVG_LOGO_PATH = fixturePath('SVG_Logo.svg');
const BLUEY_PATH = fixturePath('Bluey_Hero.png');
const HORSE_PATH = fixturePath('Brown-Horse-Clipart-GraphicsFairy.jpg');

const STRATEGY_NAMES = Object.keys(fillStrategies) as FillStrategyName[];

type Row = Record<string, string | number | boolean>;
const allRows: Row[] = [];
function record(section: string, row: Row) {
    allRows.push({ section, ...row });
    const parts = Object.entries(row).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`);
    console.log(`[${section}] ${parts.join(' ')}`);
}

async function section(title: string) {
    console.log(`\n=== ${title} ===`);
}

// --- 1. Vectorize stage: grayscale (pure per-level trace cost, no k-means) --

async function benchVectorizeGrayscale() {
    await section('vectorize: grayscale (per-pixel-per-level trace cost)');
    const full = await loadRasterImageDataAsync(HORSE_PATH);
    const half = await loadRasterImageDataAsync(HORSE_PATH, Math.round(Math.max(full.width, full.height) / 2));
    for (const imageData of [half, full]) {
        for (const levels of [1, 2, 3, 4]) {
            const { ms, pixels } = timeVectorizeGrayscale(imageData, levels);
            record('vectorize-grayscale', { widthPx: imageData.width, heightPx: imageData.height, pixels, levels, ms });
        }
    }
}

// --- 2. Vectorize stage: color/k-means (per-pixel-per-color trace + 10 x k-means pass) --

async function benchVectorizeColor() {
    await section('vectorize: color (k-means + per-color trace)');
    const full = await loadRasterImageDataAsync(BLUEY_PATH);
    const half = await loadRasterImageDataAsync(BLUEY_PATH, Math.round(Math.max(full.width, full.height) / 2));
    for (const imageData of [half, full]) {
        // colorCount=1 baseline (single-mask trace, no k-means) so the color
        // runs can be decomposed into trace-only vs. k-means-only cost.
        const singleT = timeVectorizeSingle(imageData);
        record('vectorize-color', { widthPx: imageData.width, heightPx: imageData.height, pixels: singleT.pixels, colorCount: 1, ms: singleT.ms });
        for (const colorCount of [2, 3, 4, 6]) {
            const { ms, pixels } = timeVectorizeColor(imageData, colorCount);
            record('vectorize-color', { widthPx: imageData.width, heightPx: imageData.height, pixels, colorCount, ms });
        }
    }
}

// --- 3. Hue grouping: pure per-color math -----------------------------------

async function benchHueGrouping() {
    await section('hue grouping (per-color fixed cost)');
    for (const colorCount of [2, 3, 6, 10, 16]) {
        // Median of 5 - this stage is fast enough (sub-ms) that a single
        // sample is noisy.
        const samples = Array.from({ length: 5 }, () => timeHueGrouping(colorCount)).sort((a, b) => a - b);
        const ms = samples[Math.floor(samples.length / 2)];
        record('hue-grouping', { colorCount, ms });
    }
}

// --- 4. Flatten (intra-layer knockout): O(shapeCount^2) ---------------------

async function benchFlatten() {
    await section('flatten (intra-layer knockout, O(shapeCount^2))');
    const svgString = readSvgFile(SVG_LOGO_PATH);
    const { svgJson, svgWidth, svgHeight } = svgStringToSvgJson(svgString);
    // A large widthMm keeps shapes well-separated in mm space (irrelevant to
    // flattenPaths's cost, which is purely pairwise boolean-subtract count,
    // but keeps the geometry realistic).
    const request = buildRenderRequest(svgJson, svgWidth, svgHeight, 900, { infillDensity: 0 });
    for (const fraction of [0.15, 0.3, 0.5, 0.75, 1.0]) {
        const { paths } = tracePathsForRequest(request);
        timeRdpSimplify(paths); // matches the real pipeline's ordering; not separately measured here
        const shapeCount = Math.max(2, Math.round(paths.length * fraction));
        const subset = paths.slice(0, shapeCount);
        const flattenMs = timeMs(() => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { flattenPaths } = require('../src/flattener');
            flattenPaths(subset, () => {});
        }).ms;
        record('flatten', { shapeCount: subset.length, ms: flattenMs });
    }
}

// --- 5. Cross-layer knockout: full multi-color renders, overprint on vs off -

async function benchKnockout() {
    await section('cross-layer knockout (multi-color, colorOverprint on vs off)');
    const imageData = await loadRasterImageDataAsync(BLUEY_PATH, 500);
    for (const colorCount of [2, 3, 4]) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { vectorizeImageDataColor } = require('../src/vectorizer');
        const { svg, palette } = vectorizeImageDataColor(imageData, 2, colorCount);
        const svgJson = svgToJsonViaImport(svg);
        const requestBase = buildRenderRequest(svgJson, imageData.width, imageData.height, 300, {
            infillDensity: 2,
            flattenPaths: false,
        });

        const withKnockout = await timeFullRender({ ...requestBase, colorOverprint: false });
        const withoutKnockout = await timeFullRender({ ...requestBase, colorOverprint: true });
        record('knockout', {
            colorCount: palette.length,
            withKnockoutMs: withKnockout.ms,
            withoutKnockoutMs: withoutKnockout.ms,
            deltaMs: withKnockout.ms - withoutKnockout.ms,
        });
    }
}

function svgToJsonViaImport(svgString: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const paper = require('paper');
    const probeSize = new paper.Size(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    paper.setup(probeSize);
    const svg = paper.project.importSVG(svgString, { expandShapes: true, applyMatrix: true });
    const json = svg.exportJSON() as string;
    paper.project.remove();
    return json;
}

// --- 6. Infill + optimize + render/simplify/dedupe: per fill strategy x density --

async function benchFillStrategiesMatrix() {
    await section('infill + optimize + render/simplify/dedupe (per strategy x density)');

    const svgLogoString = readSvgFile(SVG_LOGO_PATH);
    const { svgJson: logoJson, svgWidth: logoW, svgHeight: logoH } = svgStringToSvgJson(svgLogoString);

    const horseData = await loadRasterImageDataAsync(HORSE_PATH, 600);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { vectorizeImageData } = require('../src/vectorizer');
    const horseSvg = vectorizeImageData(horseData, 2);
    const horseJson = svgToJsonViaImport(horseSvg);

    const geometries: { name: string; svgJson: string; svgWidth: number; svgHeight: number; widthMm: number }[] = [
        { name: 'svgLogo-300mm', svgJson: logoJson, svgWidth: logoW, svgHeight: logoH, widthMm: 300 },
        { name: 'svgLogo-900mm', svgJson: logoJson, svgWidth: logoW, svgHeight: logoH, widthMm: 900 },
        { name: 'horse-300mm', svgJson: horseJson, svgWidth: horseData.width, svgHeight: horseData.height, widthMm: 300 },
    ];

    const densities: InfillDensity[] = [1, 3, 5];

    for (const geom of geometries) {
        for (const strategy of STRATEGY_NAMES) {
            for (const density of densities) {
                const request = buildRenderRequest(geom.svgJson, geom.svgWidth, geom.svgHeight, geom.widthMm, {
                    infillDensity: density,
                    fillMethod: strategy,
                });
                const { paths, generatePathsMs } = tracePathsForRequest(request);
                const rdpMs = timeRdpSimplify(paths);
                const result = runSingleColorStages(paths, density, strategy, false, request.width, request.height);
                record('fillmatrix', {
                    geometry: geom.name,
                    strategy,
                    density,
                    shapeCount: result.shapeCount,
                    commandCount: result.commandCount,
                    infillSegmentCount: result.infillSegmentCount,
                    totalDrawSegments: result.totalDrawSegments,
                    distanceMm: result.distanceMm,
                    generatePathsMs,
                    rdpMs,
                    infillMs: result.stages.infill,
                    optimizeMs: result.stages.optimize,
                    renderMs: result.stages.render,
                    dedupeMs: result.stages.dedupe,
                    measureMs: result.stages.measure,
                });
            }
        }
    }
}

// --- 6b. Color-separation matrix: literal-color-grouped SVG, few-huge-shapes --
//
// Added while diagnosing the under-read bug (task brief 2026-08-18): a
// colorSeparation render (src/toCommands.ts's groupPathsByLiteralColor
// branch) traces to very FEW color groups, each an individually large,
// multi-hole compound-path-ish shape set - the opposite regime from
// benchFillStrategiesMatrix's single-shape-per-geometry runs above. This
// matrix measures real per-shape-group vertex count (a proxy for Potrace
// sub-loop/hole complexity) alongside real infill/optimize/render timings,
// so the estimator's per-shape split-factor constants (segmentModel.ts's
// hatch "1.3" concavity factor, spiral's SPIRAL_CONCAVITY_SPLIT_FACTOR) can
// be refit against real shape-complexity data instead of the constant they
// currently are.
async function benchColorSeparationMatrix() {
    await section('color separation (literal-color groups, few large shapes)');

    const svgLogoString = readSvgFile(SVG_LOGO_PATH);
    const { svgJson, svgWidth, svgHeight } = svgStringToSvgJson(svgLogoString);

    const densities: InfillDensity[] = [1, 3, 5];
    const widths = [300, 900];

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const paper = require('paper');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { generatePaths, groupPathsByLiteralColor, collectExistingColorGroups } = require('../src/generator');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { simplifyPaths } = require('../src/simplifier');

    for (const widthMm of widths) {
        for (const strategy of STRATEGY_NAMES) {
            for (const density of densities) {
                const request = buildRenderRequest(svgJson, svgWidth, svgHeight, widthMm, {
                    infillDensity: density,
                    fillMethod: strategy,
                    colorSeparation: true,
                });

                paper.setup({ width: request.width, height: request.height });
                const svg = paper.project.importJSON(request.svgJson);
                const ratio = request.width / request.svgWidth;
                svg.scale(ratio, { x: 0, y: 0 });
                svg.applyMatrix = true;

                const paths = generatePaths(svg);
                paths.forEach((p: paper.PathItem) => p.flatten(0.5));
                simplifyPaths(paths, 0.1);
                let colorGroups = collectExistingColorGroups(paths);
                if (!colorGroups) colorGroups = groupPathsByLiteralColor(paths);

                for (const g of colorGroups) {
                    const vertexCount = g.paths.reduce((sum: number, p: any) =>
                        sum + (p.children ? p.children.reduce((s: number, ch: any) => s + ch.segments.length, 0) : p.segments.length), 0);
                    const r = runSingleColorStages(g.paths, density, strategy, false, request.width, request.height);
                    record('colorseparation', {
                        widthMm,
                        strategy,
                        density,
                        colorIndex: g.colorIndex,
                        shapeCount: r.shapeCount,
                        vertexCount,
                        infillSegmentCount: r.infillSegmentCount,
                        totalDrawSegments: r.totalDrawSegments,
                        infillMs: r.stages.infill,
                        optimizeMs: r.stages.optimize,
                        renderMs: r.stages.render,
                        dedupeMs: r.stages.dedupe,
                        measureMs: r.stages.measure,
                    });
                }
                paper.project.remove();
            }
        }
    }
}

// --- 7. End-to-end validation: full renderSvgJsonToCommands, real inputs ----

// A corner-to-corner luminance ramp, as a stand-in for continuous-tone
// content: no flat regions, no hard edges, every pixel asking for some ink.
function syntheticRamp(width: number, height: number): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const t = (x / (width - 1) + y / (height - 1)) / 2;
            const value = Math.round(255 * t);
            const p = (y * width + x) * 4;
            data[p] = value;
            data[p + 1] = value;
            data[p + 2] = value;
            data[p + 3] = 255;
        }
    }
    return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

// --- 8. Scribble modes: demand map + algorithm + stitch + downstream render --
//
// The whole-image mark-making modes (src/scribble/) replace the trace, the
// flatten and the infill with an entirely different shape of work, so
// processingEstimator.ts costs them with their own stage rather than by
// pretending they are a hatch. What that stage needs from here:
//
//   - the demand map's own two costs, which scale differently: the box
//     average reads every SOURCE pixel, the gamma solve raises every MAP
//     pixel to a power 28 times over, and the solve only runs at all when the
//     image is darker than the ink ceiling (demand.ts's solveInkGamma).
//   - the greedy walk's per-stroke cost, which is NOT constant: scoring is a
//     fixed 24x20 samples a stroke, but paying the ink in scales with how
//     many map pixels a stroke covers, i.e. with 1/mmPerPixel^2.
//   - the TSP tour's cost, dominated by Lloyd relaxation over every inked map
//     pixel, once per pass.
//   - the stitcher, which is O(chains^2).
//   - what the renderer then does with the result, which is the part the
//     pre-render estimate used to miss entirely: a scribble is a handful of
//     paths carrying tens of thousands of POINTS, and the per-path
//     coefficients the traced path is costed with are blind to that.
async function benchScribble() {
    await section('scribble modes (demand map + algorithm + stitch + render)');

    const cases: { name: string; file?: string; maxDim?: number; synthetic?: () => ImageData }[] = [
        { name: 'horse-400', file: HORSE_PATH, maxDim: 400 },
        { name: 'horse-900', file: HORSE_PATH, maxDim: 900 },
        { name: 'bluey-600', file: BLUEY_PATH, maxDim: 600 },
        // Both fixtures above are flat-ish art whose darkness sits in a few
        // concentrated regions. A scribble's cost is driven by how the
        // darkness is SPREAD, not just by its mean, so the fit also needs a
        // case where every pixel carries some: a smooth corner-to-corner ramp
        // at the same mean darkness has its ink demand spread over the whole
        // frame instead.
        { name: 'ramp-600', synthetic: () => syntheticRamp(600, 600) },
    ];

    for (const { name, file, maxDim, synthetic } of cases) {
        const raster = synthetic ? synthetic() : await loadRasterImageDataAsync(file!, maxDim);
        const characteristics = analyzeImageCharacteristics(raster);

        for (const drawWidthMm of [300, 600, 900]) {
            const demand = timeMs(() => inkDemand(raster, { drawWidthMm }));
            const map = demand.result;
            const mapPixels = map.width * map.height;

            let inked = 0;
            for (let i = 0; i < map.demand.length; i++) {
                if (map.demand[i] > 1e-3) inked++;
            }

            for (const mode of ['greedy', 'tsp'] as MarkMode[]) {
                const random = mulberry32(0x5C81_B71E);
                const algorithm = timeMs(() => (mode === 'tsp'
                    ? tspScribble(map, { random })
                    : greedyScribble(map, { penWidthMm: DEFAULT_NIB_WIDTH_MM, random })));
                const raw = algorithm.result;
                let points = 0;
                for (const chain of raw) points += chain.length;

                const stitched = timeMs(() => stitch(raw, mode === 'tsp' ? 0 : 8));
                const measured = measureChains(stitched.result);

                // What the renderer is then handed, timed through the real
                // production entry point rather than a stand-in.
                const svgString = scribbleToSvg(stitched.result, {
                    rasterWidth: raster.width,
                    rasterHeight: raster.height,
                    drawWidthMm,
                });
                const svgJson = svgToJsonViaImport(svgString);
                const request = buildRenderRequest(svgJson, raster.width, raster.height, drawWidthMm, {
                    // density 0 is what the scribble SVG carries: outline
                    // only, no infill generated (toSvg.ts's header).
                    infillDensity: 0 as InfillDensity,
                });
                const rendered = await timeFullRender(request);

                record('scribble', {
                    case: `${name}-${mode}-${drawWidthMm}mm`,
                    mode,
                    drawWidthMm,
                    sourcePixels: raster.width * raster.height,
                    mapPixels,
                    mmPerPixel: map.mmPerPixel,
                    inkedFraction: inked / Math.max(1, mapPixels),
                    meanDarkness: characteristics.meanDarkness,
                    whiteHeadroom: characteristics.whiteHeadroom,
                    gammaSolved: characteristics.meanDarkness > DEFAULT_INK_CEILING,
                    demandMs: demand.ms,
                    algorithmMs: algorithm.ms,
                    stitchMs: stitched.ms,
                    renderMs: rendered.ms,
                    points,
                    rawChains: raw.length,
                    chains: stitched.result.length,
                    drawnMm: measured.drawnMm,
                    travelMm: measured.travelMm,
                });
            }
        }
    }
}

async function benchEndToEnd() {
    await section('end-to-end (full renderSvgJsonToCommands, real inputs)');

    const svgLogoString = readSvgFile(SVG_LOGO_PATH);
    const { svgJson: logoJson, svgWidth: logoW, svgHeight: logoH } = svgStringToSvgJson(svgLogoString);

    // Single-color SVG at 300mm, density 3 - matches the exact scenario the
    // task brief measured by hand (0.20s) as a sanity check on this harness
    // itself.
    {
        const request = buildRenderRequest(logoJson, logoW, logoH, 300, { infillDensity: 3 });
        const { ms } = await timeFullRender(request);
        record('end-to-end', { case: 'svgLogo-single-300mm-d3', ms });
    }

    // Multi-color SVG at 300mm, density 3 - matches the task brief's 0.27s
    // multi-colour figure.
    {
        const request = buildRenderRequest(logoJson, logoW, logoH, 300, { infillDensity: 3, colorSeparation: true });
        const { ms } = await timeFullRender(request);
        record('end-to-end', { case: 'svgLogo-multi-300mm-d3', ms });
    }

    // A mural-sized single-color render.
    {
        const request = buildRenderRequest(logoJson, logoW, logoH, 900, { infillDensity: 4 });
        const { ms } = await timeFullRender(request);
        record('end-to-end', { case: 'svgLogo-single-900mm-d4', ms });
    }

    // Raster, flat-colour cartoon, multi-color, moderate size.
    {
        const imageData = await loadRasterImageDataAsync(BLUEY_PATH, 500);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { vectorizeImageDataColor } = require('../src/vectorizer');
        const vecStart = timeMs(() => vectorizeImageDataColor(imageData, 2, 4));
        const svgJson = svgToJsonViaImport(vecStart.result.svg);
        const request = buildRenderRequest(svgJson, imageData.width, imageData.height, 600, {
            infillDensity: 3,
            colorSeparation: true,
        });
        const { ms } = await timeFullRender(request);
        record('end-to-end', { case: 'bluey-multi-600mm-d3', vectorizeMs: vecStart.ms, renderMs: ms, totalMs: vecStart.ms + ms });
    }

    // Dense colorSeparation cases from the task brief (2026-08-18 M5 Pro
    // measurements): density 3/crossHatch45 (actual 0.59s) and density
    // 5/spiral (actual 1.81s, 147,901 commands) - the two cases the
    // estimator must land within ~2x of.
    {
        const request = buildRenderRequest(logoJson, logoW, logoH, 900, {
            infillDensity: 3, fillMethod: 'crossHatch45', colorSeparation: true,
        });
        const { ms } = await timeFullRender(request);
        record('end-to-end', { case: 'svgLogo-colorSep-900mm-d3-crossHatch45', ms });
    }
    {
        const request = buildRenderRequest(logoJson, logoW, logoH, 900, {
            infillDensity: 5, fillMethod: 'spiral', colorSeparation: true,
        });
        const { ms } = await timeFullRender(request);
        record('end-to-end', { case: 'svgLogo-colorSep-900mm-d5-spiral', ms });
    }

    // Raster, continuous-tone photo, single-color, moderate size.
    {
        const imageData = await loadRasterImageDataAsync(HORSE_PATH, 500);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { vectorizeImageData } = require('../src/vectorizer');
        const vecStart = timeMs(() => vectorizeImageData(imageData, 2));
        const svgJson = svgToJsonViaImport(vecStart.result);
        const request = buildRenderRequest(svgJson, imageData.width, imageData.height, 600, { infillDensity: 5, fillMethod: 'spiral' });
        const { ms } = await timeFullRender(request);
        record('end-to-end', { case: 'horse-single-600mm-d5-spiral', vectorizeMs: vecStart.ms, renderMs: ms, totalMs: vecStart.ms + ms });
    }
}

// Which sections each fixture is needed by, so running one section doesn't
// demand files the others want.
const SECTIONS: { name: string; run: () => Promise<void>; fixtures: string[] }[] = [
    { name: 'vectorizeGrayscale', run: benchVectorizeGrayscale, fixtures: [HORSE_PATH] },
    { name: 'vectorizeColor', run: benchVectorizeColor, fixtures: [BLUEY_PATH] },
    { name: 'hueGrouping', run: benchHueGrouping, fixtures: [] },
    { name: 'flatten', run: benchFlatten, fixtures: [SVG_LOGO_PATH] },
    { name: 'knockout', run: benchKnockout, fixtures: [SVG_LOGO_PATH] },
    { name: 'fillStrategies', run: benchFillStrategiesMatrix, fixtures: [SVG_LOGO_PATH, HORSE_PATH] },
    { name: 'colorSeparation', run: benchColorSeparationMatrix, fixtures: [SVG_LOGO_PATH, BLUEY_PATH] },
    { name: 'endToEnd', run: benchEndToEnd, fixtures: [SVG_LOGO_PATH, BLUEY_PATH, HORSE_PATH] },
    { name: 'scribble', run: benchScribble, fixtures: [HORSE_PATH, BLUEY_PATH] },
];

async function main() {
    console.log(`Reading fixtures from ${IMAGES_DIR}`);

    // MURAL_BENCH_ONLY=scribble,endToEnd runs just those sections - the full
    // matrix takes long enough that re-fitting one stage's coefficients
    // shouldn't mean re-running all of it.
    const only = (process.env.MURAL_BENCH_ONLY || '').split(',').map(s => s.trim()).filter(Boolean);
    const selected = only.length > 0
        ? SECTIONS.filter(s => only.includes(s.name))
        : SECTIONS;
    if (selected.length === 0) {
        console.error(`No such section(s): ${only.join(', ')}. Known: ${SECTIONS.map(s => s.name).join(', ')}`);
        process.exit(1);
    }

    for (const fixture of new Set(selected.flatMap(s => s.fixtures))) {
        if (!fs.existsSync(fixture)) {
            console.error(`Missing fixture: ${fixture}. Set MURAL_BENCH_IMAGES_DIR to override.`);
            process.exit(1);
        }
    }

    for (const { run } of selected) {
        await run();
    }

    const outPath = process.env.MURAL_BENCH_OUT;
    if (outPath) {
        fs.writeFileSync(outPath, JSON.stringify(allRows, null, 2));
        console.log(`\nWrote ${allRows.length} rows to ${outPath}`);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
