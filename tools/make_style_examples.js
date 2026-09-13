#!/usr/bin/env node
/**
 * Renders an image through each fill style and writes a PNG of the result, for
 * the gallery in README.md.
 *
 * Runs the real pipeline - the same vectorize and render the web UI calls - and
 * then draws the resulting command file the way the machine would: pen up, pen
 * down, move. So what you see is the strokes the plotter will actually make, not
 * an artist's impression of them.
 *
 * Needs the compiled TypeScript (tsc/dist-test, produced by `npm run pretest`)
 * and the native `canvas` addon, which the project's usual
 * `npm install --ignore-scripts` skips. Both are checked for below.
 *
 *   node tools/make_style_examples.js
 *   node tools/make_style_examples.js --only gradientHatch --image images/foo.png
 *   node tools/make_style_examples.js --mode grayscale --levels 4 --image images/foo.jpg
 *   node tools/make_style_examples.js --mode color --colors 5 --image images/foo.png
 *   node tools/make_style_examples.js --mode color --colors 6 --hue-grouping --image images/foo.png
 */

const fs = require('fs');
const path = require('path');

process.env.server = '1';

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'tsc', 'dist-test', 'src');
const OUT_DIR = path.join(ROOT, 'images', 'style-examples');

function requireBuilt(name) {
    const file = path.join(DIST, name + '.js');
    if (!fs.existsSync(file)) {
        console.error(`Missing ${path.relative(ROOT, file)}.\nBuild it first:  cd tsc && npm run pretest`);
        process.exit(1);
    }
    return require(file);
}

let canvasModule;
try {
    canvasModule = require(path.join(ROOT, 'tsc', 'node_modules', 'canvas'));
} catch (err) {
    console.error('The native `canvas` addon is not built, so images cannot be decoded.\n' +
                  'Install it with:  cd tsc && npm install canvas');
    process.exit(1);
}

const paper = require(path.join(ROOT, 'tsc', 'node_modules', 'paper'));
const { vectorizeImageData, vectorizeGrayscale, vectorizeImageDataColor, withGradientField } = requireBuilt('vectorizer');
const { renderSvgJsonToCommands } = requireBuilt('toCommands');
const { applyHueGrouping } = requireBuilt('huePalette');
const { FILL_STRATEGY_NAMES } = requireBuilt('fillStrategyNames');

// Plot geometry for the examples. Arbitrary but fixed, so the styles are
// comparable to each other and the stroke counts mean something.
const PLOT_WIDTH_MM = 400;
const INFILL_DENSITY = 3;
const TURD_SIZE = 2;
const TOP_DISTANCE_MM = 1000;
// Long edge the source is rasterised to before tracing - matches the web UI's
// rasterLongEdgePx, so these examples trace at the resolution a real upload does.
const RASTER_LONG_EDGE_PX = 2400;
// Pixels per mm when drawing the finished command file out to a PNG.
const OUTPUT_SCALE = 2.2;

function arg(name, fallback) {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

async function loadRaster(imagePath) {
    const image = await canvasModule.loadImage(imagePath);
    const scale = Math.min(1, RASTER_LONG_EDGE_PX / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const surface = canvasModule.createCanvas(width, height);
    const context = surface.getContext('2d');
    // Deliberately NOT flattened onto white first. The web UI rasterises onto a
    // transparent canvas, so the pipeline receives real alpha and does its own
    // compositing (grayscale.ts, and vectorizer.ts for the colour path). Filling
    // white here would hand it fully opaque pixels and hide the difference that
    // compositing makes - the gallery would show a worse result than the machine
    // actually produces.
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
}

function toSvgJson(svgString) {
    paper.setup(new paper.Size(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    const imported = paper.project.importSVG(svgString, { expandShapes: true, applyMatrix: true });
    const json = imported.exportJSON();
    paper.project.remove();
    return json;
}

/**
 * Draws a command file the way the machine executes it.
 *
 * `c<n>` lines are pen swaps: the machine stops and waits for a different pen,
 * so the drawing is rendered in that pen's colour from there on. Without this a
 * multi-colour plot would come out looking like a single-pen one, which is
 * exactly the thing the picture is meant to show.
 */
function commandsToPng(commands, widthMm, heightMm, palette) {
    const surface = canvasModule.createCanvas(Math.round(widthMm * OUTPUT_SCALE), Math.round(heightMm * OUTPUT_SCALE));
    const ctx = surface.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, surface.width, surface.height);
    ctx.lineWidth = 1.1;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const inkFor = index => {
        const entry = palette && palette[index - 1];
        return (entry && (entry.color || entry.hex || entry)) || '#1c1c20';
    };
    ctx.strokeStyle = inkFor(1);

    let penDown = false;
    let current = null;
    let strokes = 0;
    let penDownDistanceMm = 0;

    ctx.beginPath();
    for (const line of commands) {
        if (typeof line !== 'string' || line.length === 0) continue;
        if (line[0] === 'p') {
            const nowDown = line[1] === '1';
            if (nowDown && !penDown && current) {
                ctx.moveTo(current.x * OUTPUT_SCALE, current.y * OUTPUT_SCALE);
                strokes++;
            }
            penDown = nowDown;
            continue;
        }
        if (line[0] === 'c') {
            // Pen swap: flush what is drawn so far in the old ink, then switch.
            ctx.stroke();
            ctx.beginPath();
            if (current) ctx.moveTo(current.x * OUTPUT_SCALE, current.y * OUTPUT_SCALE);
            ctx.strokeStyle = inkFor(parseInt(line.slice(1), 10) || 1);
            continue;
        }
        // d/h/t/n headers carry no coordinates.
        if ('dhtn'.includes(line[0])) continue;

        const space = line.indexOf(' ');
        if (space <= 0) continue;
        const x = parseFloat(line.slice(0, space));
        const y = parseFloat(line.slice(space + 1));
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

        if (penDown && current) {
            ctx.lineTo(x * OUTPUT_SCALE, y * OUTPUT_SCALE);
            penDownDistanceMm += Math.hypot(x - current.x, y - current.y);
        } else {
            ctx.moveTo(x * OUTPUT_SCALE, y * OUTPUT_SCALE);
        }
        current = { x, y };
    }
    ctx.stroke();

    return { png: surface.toBuffer('image/png'), strokes, penDownDistanceMm };
}

async function main() {
    const imagePath = path.resolve(ROOT, arg('image', path.join('images', 'style-examples', 'source.png')));
    const only = arg('only', null);
    const suffix = arg('suffix', '');
    const styles = only ? [only] : FILL_STRATEGY_NAMES;

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const raster = await loadRaster(imagePath);
    const heightMm = Math.round((PLOT_WIDTH_MM * raster.height) / raster.width);
    console.log(`${path.relative(ROOT, imagePath)}  ->  ${raster.width}x${raster.height}px, plotted at ${PLOT_WIDTH_MM}x${heightMm}mm\n`);

    const mode = arg('mode', 'single');
    const levels = parseInt(arg('levels', '3'), 10);
    const colorCount = parseInt(arg('colors', '4'), 10);

    let tracedSvg;
    let palette;
    if (mode === 'grayscale') {
        // Nested tonal bands, each given its own infill density - the tracer's
        // answer to shading with one pen.
        tracedSvg = vectorizeGrayscale(raster, TURD_SIZE, levels);
        console.log(`  grayscale: ${levels} tonal levels`);
    } else if (mode === 'color') {
        // One mask per detected colour, each becoming a pen the machine stops
        // and asks for.
        const separated = vectorizeImageDataColor(raster, TURD_SIZE, colorCount);
        if (process.argv.includes('--hue-grouping')) {
            // Collapse similar hues onto one pen and render the lighter shades as
            // sparser hatching (huePalette.ts). Two blues become one blue pen at
            // two densities - fewer pens to own, fewer swaps to stand around for.
            const grouped = applyHueGrouping(separated);
            tracedSvg = grouped.svg;
            palette = grouped.palette;
            console.log(`  colour: ${colorCount} detected -> ${palette.length} pens after hue grouping - ${palette.map(p => p.color || p).join(', ')}`);
        } else {
            tracedSvg = separated.svg;
            palette = separated.palette;
            console.log(`  colour: ${palette.length} pens - ${palette.map(p => p.color || p).join(', ')}`);
        }
    } else {
        tracedSvg = vectorizeImageData(raster, TURD_SIZE);
    }

    const traced = withGradientField(tracedSvg, raster);
    const svgJson = toSvgJson(traced);

    const rows = [];
    for (const fillMethod of styles) {
        const request = {
            type: 'renderSvg',
            svgJson,
            width: PLOT_WIDTH_MM,
            height: heightMm,
            svgWidth: raster.width,
            svgHeight: raster.height,
            homeX: PLOT_WIDTH_MM / 2,
            homeY: heightMm / 2,
            infillDensity: INFILL_DENSITY,
            flattenPaths: false,
            topDistance: TOP_DISTANCE_MM,
            // Rendered at the origin so the PNG is the artwork, not the artwork
            // adrift in the machine's drawable area.
            placement: 'topLeft',
            fillMethod,
        };

        const started = Date.now();
        const result = await renderSvgJsonToCommands(request, () => {});
        const { png, strokes, penDownDistanceMm } = commandsToPng(result.commands, PLOT_WIDTH_MM, heightMm, palette);

        const outPath = path.join(OUT_DIR, `${fillMethod}${suffix}.png`);
        fs.writeFileSync(outPath, png);

        rows.push({ fillMethod, strokes, metres: penDownDistanceMm / 1000, seconds: (Date.now() - started) / 1000 });
        console.log(`  ${fillMethod.padEnd(22)} ${String(strokes).padStart(6)} strokes  ${(penDownDistanceMm / 1000).toFixed(1).padStart(6)}m of ink  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    }

    console.log('\nMarkdown for the README:\n');
    console.log('| Style | Strokes | Ink |');
    console.log('|---|---|---|');
    for (const row of rows) {
        console.log(`| ${row.fillMethod} | ${row.strokes.toLocaleString()} | ${row.metres.toFixed(1)}m |`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
