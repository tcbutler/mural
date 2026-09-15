import { loadPaper } from './paperLoader';
import { InfillDensity, InfilledPath, PathDensityData } from './types';
import { applyWhiteKnockout } from './flattener';
import { FillContext, GradientFieldLookup } from './fillStrategies/types';
import { defaultFillStrategyName, fillStrategies } from './fillStrategies/registry';
import { deserializeGradientField, sampleGradientField, SerializedGradientField } from './imageGradient';
import { DEFAULT_NIB_WIDTH_MM } from './huePalette';

const paper = loadPaper();

// Gradient field wiring (see vectorizer.ts's withGradientField and
// gradientHatch.ts): generatePaths() (generator.ts) only ever propagates
// the density/outline/colorIndex/spacingMm tags down onto individual
// paths, so a gradientField tag on the imported SVG's root item never
// reaches the flat `paths` array this module receives.
//
// It used to be recovered by walking the live paper.js project tree, on the
// assumption that the tagged root stayed mounted for the whole render. It does
// not: by the time generateInfills() runs, the project holds one untagged Path
// and the tagged Group is gone. So gradientHatch never received a field for any
// image and silently delegated to crossHatch45 every time - producing output
// byte-identical to the fixed-angle fill, which is exactly what "gradient hatch
// does nothing" looked like from outside.
//
// The field is now passed in from toCommands.ts, which captures it off the
// imported item before any of that restructuring happens. The project walk is
// kept as a fallback for callers that do not supply one.
type GradientFieldTag = { gradientField?: SerializedGradientField };

// Only Group/Layer nodes are visited (a Path/CompoundPath never carries
// this tag - see withGradientField, which only ever tags the root <svg>
// element), and depth is capped, so this stays cheap regardless of how
// many thousands of traced leaf paths a raster produced.
const GRADIENT_TAG_SEARCH_MAX_DEPTH = 6;

function findGradientFieldTag(project: paper.Project): SerializedGradientField | undefined {
    const visit = (item: paper.Item, depth: number): SerializedGradientField | undefined => {
        const data = item.data as GradientFieldTag | undefined;
        if (data && data.gradientField) {
            return data.gradientField;
        }
        if (depth >= GRADIENT_TAG_SEARCH_MAX_DEPTH || !(item instanceof paper.Group)) {
            return undefined;
        }
        for (const child of item.children) {
            const found = visit(child, depth + 1);
            if (found) return found;
        }
        return undefined;
    };

    for (const layer of project.layers) {
        const found = visit(layer, 0);
        if (found) return found;
    }
    return undefined;
}

// Builds the FillContext-facing lookup once per generateInfills() call
// (not once per path - the search above and the field deserialization both
// happen at most once here), or returns undefined when this render's
// source SVG carries no gradient field at all (vector-origin/path-tracing
// input, which never calls vectorize() in the first place).
function makeGradientFieldLookup(tag: SerializedGradientField): GradientFieldLookup {
    const field = deserializeGradientField(tag);
    return {
        sampleAt(point: paper.Point, viewSize: paper.Size) {
            if (viewSize.width <= 0 || viewSize.height <= 0) return undefined;
            return sampleGradientField(field, point.x / viewSize.width, point.y / viewSize.height);
        },
    };
}

function buildGradientFieldLookup(project: paper.Project): GradientFieldLookup | undefined {
    const tag = findGradientFieldTag(project);
    if (!tag) return undefined;
    return makeGradientFieldLookup(tag);
}

// The gradientField tag as it sits on the imported item, for toCommands.ts to
// capture before the render restructures the tree out from under it.
export function readGradientFieldTag(item: paper.Item): SerializedGradientField | undefined {
    const data = item.data as GradientFieldTag | undefined;
    return data && data.gradientField ? data.gradientField : undefined;
}

// Spacing (mm) between adjacent cross-hatch lines at each density level.
// 1-4 are the original levels and MUST keep these exact values - existing
// snapshots/tests depend on byte-identical output at those densities.
//
// 5-7 are the extended ladder added for hue-grouped shading (huePalette.ts):
// a single pen can render several shades of its hue by hatching the same
// ink at different spacings and letting paper show through the sparser
// ones, so the ladder needs enough range to plausibly span "barely tinted"
// to "essentially solid" for one pen's darkest color.
//
// Ink laid per unit area scales roughly as 1/spacing (see buildInfillLines:
// halving the spacing roughly doubles the number of hatch lines crossing a
// given region), so level 7 (2.5mm) uses about 20/2.5 = 8x the ink length
// of level 1 (20mm) for the same area.
//
// Approximate cross-hatch coverage (~2 * nibWidth / spacing, nibWidth ~=
// 1.2mm - two hatch directions, each nib-width wide, per spacing period):
//   1 (20mm)  -> ~12%    5 (5mm)   -> ~48%
//   2 (15mm)  -> ~16%    6 (3.5mm) -> ~69%
//   3 (10mm)  -> ~24%    7 (2.5mm) -> ~96% (near solid)
//   4 (7mm)   -> ~34%
const infillDensityToSpacingMap = new Map<Exclude<InfillDensity, 0>, number>([
    [1, 20],
    [2, 15],
    [3, 10],
    [4, 7],
    [5, 5],
    [6, 3.5],
    [7, 2.5],
]);

// `defaultFillMethod` is the request-level fallback (RenderSVGRequest.fillMethod,
// types.ts) applied to any path that doesn't carry its own
// PathDensityData.fillMethod override - per-path selection still wins.
// Omitted (the pre-existing call shape, used by every caller before this
// parameter existed) falls back to defaultFillStrategyName exactly as
// before, so this is purely additive.
export function generateInfills(
    pathsToInfill: paper.PathItem[],
    infillDensity: InfillDensity,
    defaultFillMethod?: string,
    gradientFieldOverride?: SerializedGradientField,
    // The pen actually in the holder, mm - what decides the smallest mark
    // worth lifting for (see minOutlineSpanMm). Omitted falls back to the
    // app's default nib, which is what every caller got before it existed.
    nibWidthMm?: number,
): InfilledPath[] {
    const view = paper.project.view;
    const boundsPath = new paper.Path.Rectangle(view.bounds);

    // Shared across every path filled in this call. Strategies may use
    // `cache` to memoize expensive per-spacing precomputation (e.g. a line
    // grid) across paths; it's fresh per generateInfills() call, matching
    // the original code's per-call `linesBySpacing` map.
    const gradientField = gradientFieldOverride
        ? makeGradientFieldLookup(gradientFieldOverride)
        : buildGradientFieldLookup(paper.project);
    const ctx: FillContext = {view, boundsPath, cache: new Map(), gradientField};
    const minSpanMm = minOutlineSpanMm(nibWidthMm);

    // White-as-knockout (see flattener.ts's applyWhiteKnockout): a pure
    // white fill with no stroke of its own is dropped entirely (matching
    // the pre-existing "nothing to draw" treatment below for any leftover
    // white fill), but first subtracts its geometry from whatever paint
    // order puts beneath it, so a white shape drawn over a colored one
    // leaves unmarked paper instead of that color's infill hatching showing
    // straight through it.
    const knockedOutPaths = applyWhiteKnockout(pathsToInfill);

    const infilledPaths = knockedOutPaths.map(path => {
        const pathData = path.data as PathDensityData | undefined;
        const density = pathData?.density !== undefined ? pathData.density : infillDensity;
        const includeOutline = pathData?.outline !== undefined ? pathData.outline : true;
        // Tone-derived hue-grouped shading (huePalette.ts) carries a
        // continuous spacingMm instead of snapping to one of the 7 `density`
        // ladder steps; when present it takes priority over `density` so
        // that finer tonal control isn't lost to quantization. Paths
        // without it (the overwhelming majority - everything that isn't
        // hue-grouped shading) fall through to the density-derived spacing
        // exactly as before.
        const spacingMm = pathData?.spacingMm !== undefined
            ? pathData.spacingMm
            : (density === 0 ? 0 : infillDensityToSpacingMap.get(density)!);
        const minInfillLength = spacingMm === 0 ? 1000 : Math.floor(spacingMm);

        if (!(path instanceof paper.Path) && !(path instanceof paper.CompoundPath)) {
            throw new Error("Path item is neither a Path or CompoundPath");
        }

        const outlinePaths: paper.Path[] = [];

        if (includeOutline) {
            if (path instanceof paper.Path) {
                if (path.firstSegment && path.lastSegment && isWorthDrawing(path, minSpanMm)) {
                    outlinePaths.push(path);
                }

            } else {
                const unwoundPaths = unwrapCompoundPath(path)
                    .filter(p => p.firstSegment && p.lastSegment && isWorthDrawing(p, minSpanMm));
                outlinePaths.push(...unwoundPaths);
            }
        }

        let infillPaths: paper.Path[] = [];

        if (!path.fillColor || path.fillColor.toCSS(true) !== '#ffffff') {
            // `fillMethod` is an optional per-path strategy selector; unset
            // paths fall back to the request-level default (defaultFillMethod,
            // e.g. from RenderSVGRequest.fillMethod), and unset both fall
            // back to crossHatch45 - exactly as before this parameter
            // existed.
            const strategyName = pathData?.fillMethod !== undefined
                ? pathData.fillMethod
                : (defaultFillMethod !== undefined ? defaultFillMethod : defaultFillStrategyName);
            const strategy = fillStrategies[strategyName] !== undefined ? fillStrategies[strategyName] : fillStrategies[defaultFillStrategyName];
            infillPaths = strategy.generateFill(path, {spacingMm, minInfillLength}, ctx);
        }

        const infilledPath: InfilledPath = {
            originalPath: path,
            infillPaths,
            outlinePaths,
        };

        return infilledPath;
    });

    return infilledPaths;
}

// Smallest outline worth lifting the pen for, as a fraction of the nib's own
// width.
//
// A traced region smaller than the pen cannot be drawn as anything but a blot:
// whether the machine traces its outline or simply touches down once, the mark
// on the paper is a single dot of ink the width of the nib. Tracing it costs a
// pen-down and a pen-up (about two seconds each) plus the travel to reach it,
// for a mark that is indistinguishable either way.
//
// That is invisible on flat artwork, which traces to a handful of large shapes.
// It is not invisible on a photograph: a four-level greyscale trace of the
// horse fixture at a 2400px raster produces 3,192 outlines, of which 2,106 are
// under a millimetre across. At four seconds of pen transitions each, that is
// over two hours of the plot spent dotting - which is what it looked like on
// the machine, and why this exists.
//
// Set at one nib width rather than lower because that is the size at which the
// question stops being about geometry: below it there is no mark to lose.
// Above it, a small stroke is still a stroke and is left alone.
//
// Which nib, though, is the caller's to say: this is a statement about the pen
// in the holder, not a constant. A 0.3mm fineliner draws the dot on an "i" four
// times over, and a threshold that assumed a 1.2mm marker would throw it away.
// DEFAULT_NIB_WIDTH_MM is the fallback for a request that says nothing, which
// is the same nib the rest of the app assumes when it is not told.
function minOutlineSpanMm(nibWidthMm?: number): number {
    return nibWidthMm && nibWidthMm > 0 ? nibWidthMm : DEFAULT_NIB_WIDTH_MM;
}

/**
 * Drops outlines too small to draw as anything but a dot.
 *
 * Measured across the bounding box rather than by path length, because it is
 * the mark's size on the paper that decides this: a long wandering path inside
 * a half-millimetre box still lands as one blot.
 */
function isWorthDrawing(path: paper.Path, minSpanMm: number): boolean {
    return Math.max(path.bounds.width, path.bounds.height) >= minSpanMm;
}

function unwrapCompoundPath(path: paper.CompoundPath) {
    const paths: paper.Path[] = [];
    for (const child of path.children) {
        if (child instanceof paper.Path) {
            paths.push(child);
        } else if (child instanceof paper.CompoundPath) {
            paths.push(...unwrapCompoundPath(child));
        }
    }

    return paths;
}
