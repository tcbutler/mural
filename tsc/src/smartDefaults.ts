// Smart defaults: given a source image's cheaply-computed characteristics
// (imageCharacteristics.ts), recommends sensible render settings so most
// images "just work" without the user needing to understand fill
// strategies, hatch density, or despeckle thresholds.
//
// Every recommendation carries a short, human-readable `rationale` string
// alongside its `value` - the UI branch is expected to surface these
// directly (e.g. as a tooltip/subtitle next to each defaulted control), not
// just apply the bare values silently.
import { InfillDensity } from './types';
import { FillStrategyName } from './fillStrategyNames';
import { BACKGROUND_LUMINANCE_THRESHOLD } from './grayscale';
import { ImageCharacteristics } from './imageCharacteristics';
import { MarkMode } from './scribble/markModes';

export type Recommendation<T> = {
    value: T;
    rationale: string;
};

export type SmartDefaults = {
    // What to draw from, before anything about how to draw it. A photograph
    // can fail on these two no matter which fill style it gets.
    whitePoint: Recommendation<number>;
    warmth: Recommendation<number>;

    colorCount: Recommendation<number>;
    fillStrategy: Recommendation<FillStrategyName>;
    infillDensity: Recommendation<InfillDensity>;
    // Smallest mark worth drawing, across, in mm - see recommendDespeckleMm.
    despeckleMm: Recommendation<number>;
    hueGrouping: Recommendation<boolean>;
    // Which way to draw the picture at all - see recommendMarkMode for why
    // this one is advice rather than a default the UI applies for you.
    markMode: Recommendation<MarkMode | 'trace'>;
};

function recommend<T>(value: T, rationale: string): Recommendation<T> {
    return { value, rationale };
}

// --- whitePoint -----------------------------------------------------
//
// The luminance to treat as bare paper. 1 leaves the image alone.
//
// A photograph of a real page has no true white anywhere in it: metered for
// the room, the paper comes back a mid grey, and anything mapping tone to ink
// then spends the whole plot inking a background that should have been blank.
// A photo of a pen drawing on canvas measured its brightest real tone at 0.87.
//
// The trigger reuses grayscale.ts's own BACKGROUND_LUMINANCE_THRESHOLD rather
// than inventing a second number: that constant is already the app's answer to
// "how bright is background", so an image whose brightest tone never reaches it
// has, by the app's own definition, no background at all. When the image does
// have paper the recommendation stands down entirely - stretching a product
// shot already on a white sweep only clips detail that was fine, and a
// predictable no-op beats an adaptive adjustment nobody asked for.
function recommendWhitePoint(characteristics: ImageCharacteristics): Recommendation<number> {
    const paper = characteristics.paperLuminance;
    if (paper >= BACKGROUND_LUMINANCE_THRESHOLD / 255) {
        return recommend(1, `The brightest tones here already read as bare paper (${Math.round(paper * 100)}% brightness), so the image is left as it is.`);
    }
    return recommend(
        paper,
        `Nothing in this image is bright enough to read as paper - the lightest real tone is ${Math.round(paper * 100)}% brightness, typical of a photograph of a page. Treating that as white keeps the background blank instead of filling it with ink.`,
    );
}

// --- warmth -----------------------------------------------------------
//
// How much red-minus-blue to subtract from luminance before anything else
// looks at it. 0 leaves the image alone.
//
// A subject and its background can share a luminance and look nothing alike.
// Measured on a photo of a ginger cat against a green hedge: the cat read 0.42
// and the hedge 0.40, so a faithful grey conversion turns the cat into a *hole*
// in a dark surround. Their red-minus-blue differed by more than twice. This is
// the move a black-and-white photographer makes with a coloured lens filter,
// and no choice of fill style substitutes for it - the information is not in
// the channel any more.
//
// Strength picked by blind comparison rather than argument: the same photo
// rendered at 0, 0.3 and 0.6, and 0.6 was preferred. At 0 the cat measured
// lighter than the hedge behind it; at 0.6 it is firmly darker.
export const RECOMMENDED_WARMTH = 0.6;

// Gated on the image genuinely having colour. A near-neutral photo still
// splits into two hue groups, but they are built from a handful of stray
// pixels: one grey motor on a white sweep reported hue groups 0.45 apart off
// 4% of the frame, which would have put a strong colour filter on a
// black-and-white subject.
const WARMTH_MIN_CHROMA = 0.10;
const WARMTH_MIN_CHROMATIC_FRACTION = 0.10;
const WARMTH_MIN_HUE_SEPARATION = 0.045;

function recommendWarmth(characteristics: ImageCharacteristics): Recommendation<number> {
    const { chroma, chromaticFraction, tonalSeparation, hueSeparation } = characteristics;

    if (chroma <= WARMTH_MIN_CHROMA || chromaticFraction <= WARMTH_MIN_CHROMATIC_FRACTION) {
        return recommend(0, 'There is too little colour here for a colour filter to act on, so the image converts to grey as it is.');
    }
    if (hueSeparation <= WARMTH_MIN_HUE_SEPARATION) {
        return recommend(0, 'The colours here are all much the same hue, so grey loses nothing a filter could recover.');
    }
    // Only worth filtering when hue is carrying separation that tone is not.
    if (tonalSeparation >= 0.08 + 0.5 * hueSeparation) {
        return recommend(0, 'Tone already separates the subject from its background, so no colour filter is needed.');
    }

    return recommend(
        RECOMMENDED_WARMTH,
        `The two main colours here differ by only ${tonalSeparation.toFixed(2)} in brightness but ${hueSeparation.toFixed(2)} in hue, so a plain grey conversion would flatten them together. Darkening the warmer one keeps the subject readable.`,
    );
}

// --- colorCount -----------------------------------------------------
//
// Flat/vector-ish art: its own estimatedDistinctColors is a direct, honest
// count of how many pens a human would actually reach for - just clamp it
// into a sane pen-budget range. Continuous-tone/photographic content has no
// natural "true" color count (it's a gradient, not discrete regions), so a
// fixed richer range that scales with how continuous-tone the image reads
// gives k-means enough pens to approximate shading via hue-grouped
// hatching (huePalette.ts) without asking for more physical pens than a
// typical user owns.
const MIN_RECOMMENDED_COLORS = 2;
const MAX_RECOMMENDED_COLORS_FLAT = 6;
const MAX_RECOMMENDED_COLORS_PHOTO = 8;

function recommendColorCount(characteristics: ImageCharacteristics): Recommendation<number> {
    if (characteristics.classification === 'flat') {
        const value = Math.min(MAX_RECOMMENDED_COLORS_FLAT, Math.max(MIN_RECOMMENDED_COLORS, characteristics.estimatedDistinctColors));
        return recommend(
            value,
            `This looks like flat/vector-style art with about ${characteristics.estimatedDistinctColors} dominant color(s), so ${value} pen(s) should cover it without wasted colors.`,
        );
    }

    // Continuous-tone: scale from MIN up to MAX_..._PHOTO as
    // continuousToneScore rises from the classification threshold to 1, so
    // a borderline image gets a modest bump and a clearly photographic one
    // gets the full range for smoother tonal gradation.
    const value = Math.round(
        MIN_RECOMMENDED_COLORS + (MAX_RECOMMENDED_COLORS_PHOTO - MIN_RECOMMENDED_COLORS) * characteristics.continuousToneScore,
    );
    return recommend(
        value,
        `This looks like continuous-tone/photographic content, so ${value} pens gives k-means room to approximate the shading rather than flattening it to a couple of hard colors.`,
    );
}

// --- fillStrategy -----------------------------------------------------
//
// Flat art wants a clean, predictable, cheap fill - crossHatch45 is the
// well-tested default and reads well on solid regions. Continuous-tone
// content benefits from gradientHatch's engraving-style directional
// hatching (fillStrategies/gradientHatch.ts), which follows the image's
// own local tonal gradient instead of a fixed angle - but only once the
// image is confidently continuous-tone; a borderline image gets the safer,
// cheaper crossHatch45 rather than paying gradientHatch's much higher
// processing cost for a marginal visual gain (see processingEstimator.ts's
// per-strategy cost table).
const GRADIENT_HATCH_RECOMMENDATION_THRESHOLD = 0.55;

function recommendFillStrategy(characteristics: ImageCharacteristics): Recommendation<FillStrategyName> {
    if (characteristics.continuousToneScore >= GRADIENT_HATCH_RECOMMENDATION_THRESHOLD) {
        return recommend(
            'gradientHatch',
            'This looks strongly continuous-tone/photographic, so directional hatching that follows the image\'s own shading (gradientHatch) will read more naturally than a fixed-angle grid - though it costs more processing time.',
        );
    }

    return recommend(
        'crossHatch45',
        'This looks flat/vector-ish (or only mildly continuous-tone), so the standard cross-hatch fill is the cheapest choice that will look clean.',
    );
}

// --- infillDensity ------------------------------------------------------
//
// Flat art with a small number of solid colors reads fine at a moderate
// density (level 3) - there's no fine tonal gradation to preserve, so
// there's little benefit to a denser hatch. Continuous-tone content needs
// denser hatching (finer spacing) to have enough tonal resolution for
// shading to read smoothly, scaling up with how strongly continuous-tone
// the image is.
// How dark an image has to be before the density recommendation backs off a
// step. Ink, and therefore plot time, scales with how much of the frame wants
// filling as well as with how tightly it is filled - so the same density
// setting costs a dark photograph several times what it costs a light one,
// and the recommendation used to be blind to that. Measured across the test
// images: a light product shot sits near 0.14, a cartoon near 0.16, a bright
// painting near 0.25, while a dim photograph and a photographed page both land
// above 0.43.
const DARK_IMAGE_MEAN_DARKNESS = 0.35;

function recommendInfillDensity(characteristics: ImageCharacteristics): Recommendation<InfillDensity> {
    if (characteristics.classification === 'flat') {
        return recommend(3, 'A moderate hatch density suits flat art\'s solid fills without adding unnecessary plotting time.');
    }

    const base: InfillDensity = characteristics.continuousToneScore >= GRADIENT_HATCH_RECOMMENDATION_THRESHOLD ? 5 : 4;
    if (characteristics.meanDarkness > DARK_IMAGE_MEAN_DARKNESS) {
        const value = Math.max(3, base - 1) as InfillDensity;
        return recommend(
            value,
            `This is a dark image - about ${Math.round(characteristics.meanDarkness * 100)}% of it wants ink - so a step back from the usual density keeps the plot to a sensible length. Push it back up if you would rather spend the time.`,
        );
    }
    return recommend(
        base,
        'A denser hatch gives continuous-tone content enough tonal steps to render shading smoothly.',
    );
}

// --- despeckle ------------------------------------------------------------
//
// The smallest mark worth drawing, measured across, in millimetres on the
// paper (despeckle.ts converts it for the tracer). Flat art has clean,
// deliberate edges, so a small threshold is safe and a large one would eat
// real detail. A photograph traces a great deal of true noise - grain, sensor
// speckle, JPEG artefacts - as tiny spurious regions, and each one costs a
// pen-down, a pen-up and the travel to reach it.
//
// Measured on a four-level trace of the horse fixture at 400mm wide, the
// ladder is worth knowing before reading the numbers below: 0.5mm leaves 853
// outlines, 1.5mm leaves 365, 2mm leaves 202, 3mm leaves 92 - and the ink
// barely moves across that whole range (29.4m to 26.4m), because what is being
// dropped is specks. 1.5mm is the knee: half the pen lifts for three percent
// of the ink.
//
// The same figures at a 1200px raster come out within a few percent of the
// 2400px ones, which is the point of the unit. Set in pixels they differed by
// a factor of sixteen.
const FLAT_ART_DESPECKLE_MM = 0.5;
const PHOTO_DESPECKLE_BASE_MM = 0.8;
const PHOTO_DESPECKLE_PER_EDGE_MM = 3.5;
const PHOTO_DESPECKLE_CEILING_MM = 2.5;

function recommendDespeckleMm(characteristics: ImageCharacteristics): Recommendation<number> {
    if (characteristics.classification === 'flat') {
        return recommend(FLAT_ART_DESPECKLE_MM, `Flat art has clean, deliberate edges, so dropping marks under ${FLAT_ART_DESPECKLE_MM}mm clears stray noise without losing anything that was drawn on purpose.`);
    }

    const value = Math.min(
        PHOTO_DESPECKLE_CEILING_MM,
        PHOTO_DESPECKLE_BASE_MM + characteristics.edgeFraction * PHOTO_DESPECKLE_PER_EDGE_MM,
    );
    const rounded = Math.round(value * 10) / 10;
    return recommend(
        rounded,
        `Photographs trace their grain and compression noise as thousands of specks, and each one costs a pen-down and a pen-up for a dot. Dropping anything under ${rounded}mm across removes most of them and almost none of the ink.`,
    );
}

// --- hueGrouping ----------------------------------------------------------
//
// Hue-grouping (huePalette.ts) collapses several detected shades of one hue
// onto a single physical pen, drawn at different hatch densities. That's
// exactly what continuous-tone content needs (many close, related shades)
// and actively unhelpful for flat art, where each detected color is
// usually already meant to be visually distinct (collapsing them would
// merge colors the source image deliberately kept separate).
function recommendHueGrouping(characteristics: ImageCharacteristics): Recommendation<boolean> {
    if (characteristics.classification === 'flat') {
        return recommend(false, 'Flat art\'s colors are usually deliberately distinct, so grouping by hue would merge colors that should stay separate.');
    }

    return recommend(true, 'Continuous-tone content often has many close shades of the same hue - grouping them onto shared pens keeps the physical pen count reasonable while preserving shading.');
}

// --- markMode -------------------------------------------------------------
//
// Whether this picture wants the trace-and-fill pipeline or one of the
// whole-image mark-making modes (scribble/).
//
// Ported from the fitted rules in tools/scribble/defaults.py's suggest(),
// which came out of a scored sweep over 23 test images plus 80 blind pairwise
// human preferences across 5 sheets. What that work establishes, and what it
// does not, decides the shape of this recommendation:
//
//   - It establishes that among the whole-image algorithms, the greedy walk
//     wins on legibility (19 of 23 images, and a top-two slot on every blind
//     sheet) and the TSP tour wins on cost (19 of 23), needing about 2.5x less
//     line because a non-crossing tour never lays ink on ink.
//   - It establishes that flat art with solid blacks is the wrong job for any
//     of them: measured on a solid black page, the scribble drew 3.9x the line
//     a plain hatch needs for the same coverage - 250 minutes against 48.
//   - It does NOT establish that a scribble beats this app's own hatch on a
//     photograph. The sweep compared the scribble algorithms against each
//     other; gradientHatch was never in it.
//
// So this is the one recommendation the UI shows without applying: switching a
// photograph to a scribble changes what the drawing IS and roughly triples the
// plot time, and nothing measured says it is the better picture. Telling
// someone what the modes are for is useful; choosing for them, on this
// evidence, would not be.

// A flat image with essentially no mid-tones - solid regions and bare paper,
// which is what a hatch is for and what a density fill has nothing to
// modulate.
const FLAT_ENOUGH_MID_TONE_FRACTION = 0.05;
// How much of a flat image has to be inked before the overdraw actually costs
// something. Below this the solids are small and isolated, and either way of
// drawing them is cheap.
const SOLID_INK_SHARE = 0.15;

function recommendMarkMode(characteristics: ImageCharacteristics): Recommendation<MarkMode | 'trace'> {
    if (characteristics.classification === 'flat' && characteristics.midToneFraction < FLAT_ENOUGH_MID_TONE_FRACTION) {
        if (characteristics.meanDarkness > SOLID_INK_SHARE) {
            return recommend('trace', `About ${Math.round(characteristics.meanDarkness * 100)}% of this is solid ink with almost no mid-tones, so there is no density for a scribble to modulate - it would draw around four times the line a cross-hatch needs for the same coverage. Trace and fill it.`);
        }
        return recommend('trace', 'This is flat art with small isolated solids, which the hatch fills draw cleanly and cheaply. A scribble is available if you want the marks to read as hand-drawn rather than printed.');
    }

    if (characteristics.continuousToneScore >= GRADIENT_HATCH_RECOMMENDATION_THRESHOLD) {
        return recommend('greedy', 'Continuous tone, which is what the mark-making modes are for. The scribble walk reads best of them - it took a top-two slot on every sheet a human ranked blind - at about three times the plot time of the single line. Both are under Mark making; the hatch fills are still a fine answer here.');
    }

    return recommend('trace', 'Only mildly continuous-tone, so the hatch fills have enough to work with. The mark-making modes are there if you want the look; they suit a photograph more than this.');
}

export function recommendDefaults(characteristics: ImageCharacteristics): SmartDefaults {
    return {
        whitePoint: recommendWhitePoint(characteristics),
        warmth: recommendWarmth(characteristics),
        colorCount: recommendColorCount(characteristics),
        fillStrategy: recommendFillStrategy(characteristics),
        infillDensity: recommendInfillDensity(characteristics),
        despeckleMm: recommendDespeckleMm(characteristics),
        hueGrouping: recommendHueGrouping(characteristics),
        markMode: recommendMarkMode(characteristics),
    };
}
