import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { recommendDefaults } from "../src/smartDefaults";
import { ImageCharacteristics } from "../src/imageCharacteristics";

function makeCharacteristics(overrides: Partial<ImageCharacteristics>): ImageCharacteristics {
    return {
        widthPx: 500,
        heightPx: 500,
        opaqueFraction: 1,
        colorConcentration: 0.9,
        estimatedDistinctColors: 3,
        flatFraction: 0.8,
        edgeFraction: 0.15,
        midToneFraction: 0.05,
        continuousToneScore: 0.1,
        classification: "flat",
        // Defaults describe a clean source with bare paper and no colour
        // worth separating, so a fixture only has to state the ones it is
        // actually about.
        whiteHeadroom: 0.4,
        meanDarkness: 0.15,
        paperLuminance: 1,
        chroma: 0.02,
        chromaticFraction: 0,
        tonalSeparation: 0,
        hueSeparation: 0,
        ...overrides,
    };
}

test("recommendDefaults: a flat/vector-ish image gets crossHatch45, no hue grouping, and a small despeckle", () => {
    const flat = makeCharacteristics({});
    const defaults = recommendDefaults(flat);

    assert.equal(defaults.fillStrategy.value, "crossHatch45");
    assert.equal(defaults.hueGrouping.value, false);
    // Millimetres across on the paper, not pixels of source area - deliberate
    // edges are worth keeping, so the threshold stays under the nib.
    assert.ok(defaults.despeckleMm.value <= 1);
    assert.ok(defaults.colorCount.value >= 2 && defaults.colorCount.value <= 6);
});

test("recommendDefaults: a photograph gets a despeckle big enough to matter, and a bounded one", () => {
    // The old pixel-area recommendation came out sub-millimetre at any
    // realistic photo resolution, which is why it never removed the specks it
    // was there for.
    const photo = makeCharacteristics({
        colorConcentration: 0.2,
        flatFraction: 0.1,
        edgeFraction: 0.35,
        classification: "continuous-tone",
    });
    const defaults = recommendDefaults(photo);

    assert.ok(defaults.despeckleMm.value >= 1.2, `expected at least a nib width, got ${defaults.despeckleMm.value}mm`);
    assert.ok(defaults.despeckleMm.value <= 2.5, `expected a ceiling, got ${defaults.despeckleMm.value}mm`);
});

test("recommendDefaults: a strongly continuous-tone image gets gradientHatch, hue grouping, and a denser infill", () => {
    const photo = makeCharacteristics({
        colorConcentration: 0.2,
        estimatedDistinctColors: 40,
        flatFraction: 0.05,
        edgeFraction: 0.2,
        midToneFraction: 0.75,
        continuousToneScore: 0.75,
        classification: "continuous-tone",
    });
    const defaults = recommendDefaults(photo);

    assert.equal(defaults.fillStrategy.value, "gradientHatch");
    assert.equal(defaults.hueGrouping.value, true);
    assert.ok(defaults.infillDensity.value >= 4);
    assert.ok(defaults.colorCount.value >= 2);
});

test("recommendDefaults: every recommendation carries a non-empty human-readable rationale", () => {
    const defaults = recommendDefaults(makeCharacteristics({}));
    for (const rec of Object.values(defaults)) {
        assert.ok(typeof rec.rationale === "string" && rec.rationale.length > 10, `expected a real rationale, got: ${JSON.stringify(rec)}`);
    }
});

test("recommendDefaults: a borderline continuous-tone image below the gradientHatch threshold still gets the cheaper crossHatch45", () => {
    const borderline = makeCharacteristics({
        colorConcentration: 0.5,
        flatFraction: 0.3,
        midToneFraction: 0.3,
        continuousToneScore: 0.4,
        classification: "continuous-tone",
    });
    const defaults = recommendDefaults(borderline);
    assert.equal(defaults.fillStrategy.value, "crossHatch45");
});

test("recommendDefaults: flat colorCount tracks estimatedDistinctColors within the recommended pen-budget range", () => {
    const twoColor = recommendDefaults(makeCharacteristics({ estimatedDistinctColors: 2 }));
    const fiveColor = recommendDefaults(makeCharacteristics({ estimatedDistinctColors: 5 }));
    assert.ok(fiveColor.colorCount.value >= twoColor.colorCount.value);
});

test("recommendWhitePoint: stands down when the image already has bare paper", () => {
    const d = recommendDefaults(makeCharacteristics({ paperLuminance: 1 }));
    assert.equal(d.whitePoint.value, 1);
    assert.match(d.whitePoint.rationale, /already read as bare paper/);
});

test("recommendWhitePoint: a photographed page has no white to leave alone", () => {
    // The brightest real tone in a photo of a page on a desk, measured.
    const d = recommendDefaults(makeCharacteristics({ paperLuminance: 0.867 }));
    assert.equal(d.whitePoint.value, 0.867);
    assert.match(d.whitePoint.rationale, /Nothing in this image is bright enough/);
});

test("recommendWarmth: fires when hue separates the subject and tone does not", () => {
    // A ginger subject against green: nearly the same brightness, plainly
    // different colours.
    const d = recommendDefaults(makeCharacteristics({
        chroma: 0.19, chromaticFraction: 0.66, tonalSeparation: 0.04, hueSeparation: 0.14,
    }));
    assert.equal(d.warmth.value, 0.6);
});

test("recommendWarmth: stands down when tone already separates the subject", () => {
    const d = recommendDefaults(makeCharacteristics({
        chroma: 0.19, chromaticFraction: 0.66, tonalSeparation: 0.30, hueSeparation: 0.14,
    }));
    assert.equal(d.warmth.value, 0);
    assert.match(d.warmth.rationale, /Tone already separates/);
});

test("recommendWarmth: a near-neutral image is never colour filtered", () => {
    // A grey motor on a white sweep still produces two hue groups, built from
    // a few stray pixels and far apart by luck. The chroma gate is what stops
    // that putting a strong filter on a black-and-white subject.
    const d = recommendDefaults(makeCharacteristics({
        chroma: 0.03, chromaticFraction: 0.04, tonalSeparation: 0.02, hueSeparation: 0.45,
    }));
    assert.equal(d.warmth.value, 0);
    assert.match(d.warmth.rationale, /too little colour/);
});

test("recommendInfillDensity: backs off a step on a dark continuous-tone image", () => {
    const light = recommendDefaults(makeCharacteristics({
        classification: "continuous-tone", continuousToneScore: 0.7, meanDarkness: 0.15,
    }));
    const dark = recommendDefaults(makeCharacteristics({
        classification: "continuous-tone", continuousToneScore: 0.7, meanDarkness: 0.45,
    }));
    assert.equal(light.infillDensity.value, 5);
    assert.equal(dark.infillDensity.value, 4, 'a dark image at the same setting costs far more ink');
    assert.match(dark.infillDensity.rationale, /dark image/);
});
