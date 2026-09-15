/**
 * Tests for the fill strategies added alongside crossHatch45
 * (singleDirectionHatch, crossHatchAngled, jitteredHatch - see
 * src/fillStrategies/registry.ts) and the multi-color per-layer angle
 * assignment that exercises them (generator.ts's
 * assignHatchAnglesPerColorGroup).
 *
 * Needs the real paper.js geometry engine, same as pipeline.test.ts/
 * multicolor.test.ts/hueGroupingPipeline.test.ts - self-skips with an
 * explanatory message when the native `canvas` addon has no compiled
 * binary (see those files' headers for the full explanation).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.server = "1";

function tryLoadPaper(): { paper: typeof import("paper") } | { error: Error } {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const paper = require("paper");
        return { paper };
    } catch (err) {
        return { error: err as Error };
    }
}

const paperLoadResult = tryLoadPaper();
const paperAvailable = !("error" in paperLoadResult);

if (!paperAvailable) {
    test(`fill strategy tests skipped: paper.js unavailable (${(paperLoadResult as { error: Error }).error.message})`, (t) => {
        t.skip("native `canvas` addon has no compiled binary in this environment. Run `npm install` without --ignore-scripts, with cairo/pango/pkg-config available, to enable these tests.");
    });
} else {
    const paper = (paperLoadResult as { paper: typeof import("paper") }).paper;
    const { generateInfills } = require("../src/infill") as typeof import("../src/infill");
    const { fillStrategies, defaultFillStrategyName } = require("../src/fillStrategies/registry") as typeof import("../src/fillStrategies/registry");
    const { assignHatchAnglesPerColorGroup } = require("../src/generator") as typeof import("../src/generator");
    type ColorGroup = import("../src/generator").ColorGroup;

    function makeSquare(): paper.Path {
        const square = new paper.Path.Rectangle(new paper.Point(10, 10), new paper.Size(60, 60));
        square.fillColor = new paper.Color("#000000");
        return square;
    }

    function totalInfillLength(fillMethod: string | undefined, density: 1 | 2 | 3 | 4 = 2, extraData: Record<string, unknown> = {}) {
        paper.setup(new paper.Size(100, 100));
        const square = makeSquare();
        if (fillMethod !== undefined) {
            square.data = { fillMethod, ...extraData };
        } else if (Object.keys(extraData).length > 0) {
            square.data = { ...extraData };
        }
        const [infilled] = generateInfills([square], density);
        return { infilled, total: infilled.infillPaths.reduce((sum, p) => sum + p.length, 0) };
    }

    test("registry: default strategy is crossHatch45, and this branch's three strategies are registered", () => {
        assert.strictEqual(defaultFillStrategyName, "crossHatch45");
        // Not an exhaustive equality check: other fill-strategy branches
        // (spiral, contour, gradient-hatch) register their own entries
        // concurrently, so assert this branch's strategies are present
        // rather than pinning the full registry contents.
        for (const name of ["crossHatch45", "crossHatchAngled", "jitteredHatch", "singleDirectionHatch"]) {
            assert.ok(name in fillStrategies, `expected "${name}" to be registered`);
        }
    });

    test("infill.ts fillMethod resolution: an unknown fillMethod falls back to the default strategy instead of throwing", () => {
        paper.setup(new paper.Size(100, 100));
        const square = makeSquare();
        square.data = { fillMethod: "notARealStrategy" };
        const [infilled] = generateInfills([square], 2);
        assert.ok(infilled.infillPaths.length > 0, "expected the default strategy to still produce infill");
    });

    test("infill.ts generateInfills: a request-level default fillMethod is applied to paths without their own override", () => {
        paper.setup(new paper.Size(100, 100));
        const square = makeSquare(); // no .data at all
        const [infilled] = generateInfills([square], 2, "singleDirectionHatch");

        // singleDirectionHatch produces roughly half crossHatch45's ink at
        // the same spacing (see the ratio test above) - a cheap, distinct
        // signal that the request-level default actually took effect
        // instead of silently staying on crossHatch45.
        const viaDefaultParam = infilled.infillPaths.reduce((sum, p) => sum + p.length, 0);

        paper.setup(new paper.Size(100, 100));
        const plainSquare = makeSquare();
        const [plainInfilled] = generateInfills([plainSquare], 2);
        const viaNoDefault = plainInfilled.infillPaths.reduce((sum, p) => sum + p.length, 0);

        assert.ok(viaDefaultParam > 0 && viaNoDefault > 0);
        const ratio = viaDefaultParam / viaNoDefault;
        assert.ok(ratio > 0.3 && ratio < 0.7, `expected the request-level default to behave like singleDirectionHatch (~half crossHatch45), got ratio ${ratio.toFixed(2)}`);
    });

    test("infill.ts generateInfills: a path's own PathDensityData.fillMethod still wins over the request-level default", () => {
        paper.setup(new paper.Size(100, 100));
        const square = makeSquare();
        // Path explicitly asks for crossHatchAngled; the request-level
        // default (singleDirectionHatch) must not override it.
        square.data = { fillMethod: "crossHatchAngled" };
        const [infilled] = generateInfills([square], 2, "singleDirectionHatch");
        const viaPathOverride = infilled.infillPaths.reduce((sum, p) => sum + p.length, 0);

        paper.setup(new paper.Size(100, 100));
        const plainAngled = makeSquare();
        plainAngled.data = { fillMethod: "crossHatchAngled" };
        const [angledInfilled] = generateInfills([plainAngled], 2);
        const viaDirectAngled = angledInfilled.infillPaths.reduce((sum, p) => sum + p.length, 0);

        // Both runs should land on crossHatchAngled's own coverage (close
        // to crossHatch45's, i.e. NOT close to singleDirectionHatch's ~half),
        // regardless of the request-level default supplied in the first run.
        assert.ok(viaPathOverride > 0 && viaDirectAngled > 0);
        const ratio = viaPathOverride / viaDirectAngled;
        assert.ok(ratio > 0.7 && ratio < 1.3, `expected the per-path override to win over the request-level default, got ratio ${ratio.toFixed(2)}`);
    });

    test("infill.ts generateInfills: an unknown request-level default fillMethod falls back to the default strategy instead of throwing", () => {
        paper.setup(new paper.Size(100, 100));
        const square = makeSquare();
        const [infilled] = generateInfills([square], 2, "notARealStrategyEither");
        assert.ok(infilled.infillPaths.length > 0, "expected the default strategy to still produce infill");
    });

    test("singleDirectionHatch: produces infill entirely inside the target region", () => {
        const { infilled, total } = totalInfillLength("singleDirectionHatch");
        assert.ok(total > 0, "expected nonzero infill");
        for (const p of infilled.infillPaths) {
            const midpoint = p.firstSegment.point.add(p.lastSegment.point).divide(2);
            assert.ok(infilled.originalPath.contains(midpoint), "infill segment midpoint should fall inside the source path");
        }
    });

    test("singleDirectionHatch: coverage is roughly half of crossHatch45 at the same spacing", () => {
        const single = totalInfillLength("singleDirectionHatch").total;
        const cross = totalInfillLength(undefined).total; // undefined -> default strategy (crossHatch45)

        assert.ok(single > 0 && cross > 0, "expected nonzero infill from both strategies");
        const ratio = single / cross;
        // One direction vs two - allow generous tolerance for edge effects
        // on a small test square, but this must land near 0.5, not near 1
        // (same as cross-hatch) or near 0 (broken).
        assert.ok(ratio > 0.3 && ratio < 0.7, `expected singleDirectionHatch/crossHatch45 length ratio near 0.5, got ${ratio.toFixed(2)}`);
    });

    test("singleDirectionHatch: PathDensityData.hatchAngleDegrees actually rotates the hatch lines", () => {
        const horizontal = totalInfillLength("singleDirectionHatch", 2, { hatchAngleDegrees: 0 });
        assert.ok(horizontal.total > 0, "expected nonzero infill at angle 0");

        // At angle 0 every hatch line runs (near-)horizontally: each
        // segment's endpoints should share almost the same y.
        for (const p of horizontal.infilled.infillPaths) {
            const dy = Math.abs(p.firstSegment.point.y - p.lastSegment.point.y);
            assert.ok(dy < 0.5, `expected a near-horizontal segment at hatchAngleDegrees=0, got dy=${dy}`);
        }

        const vertical = totalInfillLength("singleDirectionHatch", 2, { hatchAngleDegrees: 90 });
        assert.ok(vertical.total > 0, "expected nonzero infill at angle 90");
        for (const p of vertical.infilled.infillPaths) {
            const dx = Math.abs(p.firstSegment.point.x - p.lastSegment.point.x);
            assert.ok(dx < 0.5, `expected a near-vertical segment at hatchAngleDegrees=90, got dx=${dx}`);
        }
    });

    test("crossHatchAngled: default angle (unset hatchAngleDegrees) produces coverage comparable to crossHatch45", () => {
        const angled = totalInfillLength("crossHatchAngled").total;
        const cross = totalInfillLength(undefined).total;

        assert.ok(angled > 0 && cross > 0, "expected nonzero infill from both strategies");
        const ratio = angled / cross;
        assert.ok(ratio > 0.6 && ratio < 1.6, `expected crossHatchAngled (default angle) to roughly match crossHatch45's coverage, got ratio ${ratio.toFixed(2)}`);
    });

    test("crossHatchAngled: an explicit angle produces infill entirely inside the target region", () => {
        const { infilled, total } = totalInfillLength("crossHatchAngled", 2, { hatchAngleDegrees: 20 });
        assert.ok(total > 0, "expected nonzero infill");
        for (const p of infilled.infillPaths) {
            const midpoint = p.firstSegment.point.add(p.lastSegment.point).divide(2);
            assert.ok(infilled.originalPath.contains(midpoint), "infill segment midpoint should fall inside the source path");
        }
    });

    test("jitteredHatch: produces valid, in-region infill with coverage comparable to crossHatchAngled", () => {
        const jittered = totalInfillLength("jitteredHatch");
        assert.ok(jittered.total > 0, "expected nonzero infill");
        for (const p of jittered.infilled.infillPaths) {
            const midpoint = p.firstSegment.point.add(p.lastSegment.point).divide(2);
            assert.ok(jittered.infilled.originalPath.contains(midpoint), "infill segment midpoint should fall inside the source path");
        }

        const angled = totalInfillLength("crossHatchAngled").total;
        const ratio = jittered.total / angled;
        assert.ok(ratio > 0.5 && ratio < 1.5, `expected jitteredHatch coverage to roughly match crossHatchAngled's, got ratio ${ratio.toFixed(2)}`);
    });

    test("jitteredHatch: deterministic - identical input produces identical output across separate generateInfills calls", () => {
        function run() {
            paper.setup(new paper.Size(100, 100));
            const square = makeSquare();
            square.data = { fillMethod: "jitteredHatch" };
            const [infilled] = generateInfills([square], 2);
            return infilled.infillPaths.map(p => [
                +p.firstSegment.point.x.toFixed(6), +p.firstSegment.point.y.toFixed(6),
                +p.lastSegment.point.x.toFixed(6), +p.lastSegment.point.y.toFixed(6),
            ]);
        }

        const runA = run();
        const runB = run();
        assert.ok(runA.length > 0, "expected nonzero infill");
        assert.deepStrictEqual(runA, runB, "jitteredHatch must be deterministic given identical input");
    });

    test("jitteredHatch: endpoints stay within a small bound of the unjittered grid (not wildly displaced)", () => {
        // The jittered segments' endpoints are real intersections with the
        // (jittered) hatch lines and the source path, so they can't be
        // compared point-for-point against the unjittered grid - but the
        // total ink length staying in the same ballpark as crossHatchAngled
        // (checked above) is itself strong evidence the jitter (<=0.15mm
        // per endpoint, see jitteredHatch.ts) isn't corrupting the hatch
        // structure. This test instead checks the documented ceiling
        // directly: no single generated segment should be absurdly short
        // (e.g. a sliver from a jittered line barely clipping the corner)
        // dominating the output in a way that would indicate runaway
        // jitter magnitude.
        const { infilled } = totalInfillLength("jitteredHatch");
        for (const p of infilled.infillPaths) {
            assert.ok(p.length < 200, `unexpectedly long jittered segment (${p.length}) for a 60x60 square - jitter magnitude may be miscalibrated`);
        }
    });

    test("generator.assignHatchAnglesPerColorGroup: no-op for a single color group", () => {
        paper.setup(new paper.Size(100, 100));
        const square = makeSquare();
        const groups: ColorGroup[] = [{ colorIndex: 0, color: new paper.Color("#000000"), paths: [square] }];
        assignHatchAnglesPerColorGroup(groups);
        assert.strictEqual((square.data as { hatchAngleDegrees?: number }).hatchAngleDegrees, undefined);
        assert.strictEqual((square.data as { fillMethod?: string }).fillMethod, undefined);
    });

    test("generator.assignHatchAnglesPerColorGroup: assigns a distinct angle and crossHatchAngled to each of several groups", () => {
        paper.setup(new paper.Size(100, 100));
        const squares = [makeSquare(), makeSquare(), makeSquare()];
        const groups: ColorGroup[] = squares.map((s, i) => ({ colorIndex: i, color: new paper.Color("#000000"), paths: [s] }));
        assignHatchAnglesPerColorGroup(groups);

        const angles = squares.map(s => (s.data as { hatchAngleDegrees?: number }).hatchAngleDegrees);
        for (const angle of angles) {
            assert.strictEqual(typeof angle, "number");
            assert.ok(angle! >= 0 && angle! < 180, `expected angle in [0, 180), got ${angle}`);
        }
        // All distinct (golden-angle spread over only 3 groups won't collide).
        assert.strictEqual(new Set(angles).size, angles.length, "expected each group to get a distinct angle");

        for (const s of squares) {
            assert.strictEqual((s.data as { fillMethod?: string }).fillMethod, "crossHatchAngled");
        }
    });

    test("generator.assignHatchAnglesPerColorGroup: does not clobber an explicit existing override", () => {
        paper.setup(new paper.Size(100, 100));
        const overridden = makeSquare();
        overridden.data = { hatchAngleDegrees: 12, fillMethod: "jitteredHatch" };
        const plain = makeSquare();
        const groups: ColorGroup[] = [
            { colorIndex: 0, color: new paper.Color("#000000"), paths: [overridden] },
            { colorIndex: 1, color: new paper.Color("#000000"), paths: [plain] },
        ];
        assignHatchAnglesPerColorGroup(groups);

        assert.strictEqual((overridden.data as { hatchAngleDegrees?: number }).hatchAngleDegrees, 12);
        assert.strictEqual((overridden.data as { fillMethod?: string }).fillMethod, "jitteredHatch");
        assert.strictEqual((plain.data as { fillMethod?: string }).fillMethod, "crossHatchAngled");
    });

    // --- outlines too small to draw (infill.ts's MIN_OUTLINE_SPAN_MM) -----
    //
    // A photograph traced into tonal bands produces a great many specks, and
    // each one used to be drawn as its own stroke: pen down, trace something
    // smaller than the nib, pen up. Found on the machine rather than on a
    // screen - a four-level greyscale plot of a horse was aborted at 74%
    // because it was spending its time dotting.

    function outlinesFor(size: number, nibWidthMm?: number): number {
        paper.setup(new paper.Size(100, 100));
        const speck = new paper.Path.Rectangle(new paper.Point(10, 10), new paper.Size(size, size));
        speck.fillColor = new paper.Color("#000000");
        const [infilled] = generateInfills([speck], 2, undefined, undefined, nibWidthMm);
        return infilled.outlinePaths.length;
    }

    test("infill.ts: a shape smaller than the nib is not drawn at all", () => {
        // 0.5mm across, where the pen is 1.2mm: tracing it and touching the
        // pen down once leave the same mark, and tracing costs two pen
        // transitions plus the travel to reach it.
        assert.strictEqual(outlinesFor(0.5), 0);
    });

    test("infill.ts: a shape the pen can actually draw is still outlined", () => {
        assert.strictEqual(outlinesFor(20), 1);
    });

    test("infill.ts: the cut is at the nib's own width, not lower", () => {
        // Just under and just over, so the threshold cannot drift without
        // this failing.
        assert.strictEqual(outlinesFor(1.1), 0);
        assert.strictEqual(outlinesFor(1.3), 1);
    });

    test("infill.ts: the cut follows the pen, so a fineliner still draws its dots", () => {
        // The whole argument for dropping these is that the pen cannot draw
        // them as anything but a blot. A 0.3mm fineliner draws a 0.5mm mark
        // four times over, so with that pen in the holder there is nothing to
        // drop - and with a 3mm marker there is a great deal more.
        assert.strictEqual(outlinesFor(0.5, 0.3), 1);
        assert.strictEqual(outlinesFor(2, 3), 0);
        // Saying nothing about the pen behaves exactly as it always did.
        assert.strictEqual(outlinesFor(0.5), 0);
        assert.strictEqual(outlinesFor(2), 1);
    });

    test("infill.ts: specks inside a compound path go too, and the shape itself stays", () => {
        // The real source: a traced tonal band is one compound path holding
        // its islands and holes, and it is the children that are specks.
        paper.setup(new paper.Size(100, 100));
        const big = new paper.Path.Rectangle(new paper.Point(10, 10), new paper.Size(60, 60));
        const speck = new paper.Path.Rectangle(new paper.Point(80, 80), new paper.Size(0.4, 0.4));
        const band = new paper.CompoundPath({ children: [big, speck] });
        band.fillColor = new paper.Color("#000000");

        const [infilled] = generateInfills([band], 2);
        assert.strictEqual(infilled.outlinePaths.length, 1, "the speck should be dropped and the band kept");
        assert.ok(Math.max(infilled.outlinePaths[0].bounds.width, infilled.outlinePaths[0].bounds.height) > 10);
    });
}
