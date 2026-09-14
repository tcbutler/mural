/**
 * Geometric sanity tests for the loop-scribble fill strategy
 * (src/fillStrategies/cycloid.ts).
 *
 * The tonal model is tested separately and thoroughly in cycloidPath.test.ts,
 * which is paper.js-free. What is left for here is everything the adapter is
 * responsible for: walking rows across a real shape, keeping only what lands
 * inside it, and breaking the stroke where it leaves.
 *
 * Self-skips when paper.js cannot be loaded, mirroring spiralFill.test.ts -
 * see that file's header for the full story.
 */
import { test, before } from "node:test";
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

if ("error" in paperLoadResult) {
    test("cycloid fill (skipped: paper.js native canvas binding unavailable)", () => {
        assert.ok(true);
    });
} else {
    const paper = paperLoadResult.paper;

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { cycloid, coverageForSpacing } = require("../src/fillStrategies/cycloid") as typeof import("../src/fillStrategies/cycloid");
    type FillContextType = import("../src/fillStrategies/types").FillContext;

    before(() => {
        paper.setup(new paper.Size(1000, 1000));
    });

    function makeContext(): FillContextType {
        const view = paper.project.view;
        return { view, boundsPath: new paper.Path.Rectangle(view.bounds), cache: new Map() };
    }

    function square(size = 200, at = 100): paper.Path {
        return new paper.Path.Rectangle(new paper.Rectangle(at, at, size, size));
    }

    function totalLength(paths: paper.Path[]): number {
        return paths.reduce((sum, p) => sum + p.length, 0);
    }

    // Clipping cuts each row exactly where it crosses the shape, so the
    // stroke's endpoints sit ON the boundary rather than inside it -
    // contains() answers false for those, and to within paper's boolean
    // precision they can land a hair the wrong side of it. So "inside" here
    // means inside or on the edge, and the slack is small enough that ink
    // genuinely drawn outside the region still fails.
    const EDGE_TOLERANCE_MM = 0.05;

    function distanceToEdge(shape: paper.PathItem, point: paper.Point): number {
        return (shape as paper.Path).getNearestPoint(point).getDistance(point);
    }

    function isInsideOrOnEdge(shape: paper.PathItem, point: paper.Point): boolean {
        return shape.contains(point) || distanceToEdge(shape, point) <= EDGE_TOLERANCE_MM;
    }

    test("fills a shape with strokes that all land inside it", () => {
        const shape = square();
        const paths = cycloid.generateFill(shape, { spacingMm: 12, minInfillLength: 2 }, makeContext());

        assert.ok(paths.length > 0, "a 200mm square at 12mm spacing should get filled");

        for (const p of paths) {
            for (const segment of p.segments) {
                assert.ok(isInsideOrOnEdge(shape, segment.point),
                    `every point should be inside the shape, found ${segment.point}`);
            }
        }
    });

    test("a tighter spacing lays more ink", () => {
        const shape = square();
        const loose = cycloid.generateFill(shape, { spacingMm: 20, minInfillLength: 2 }, makeContext());
        const tight = cycloid.generateFill(shape, { spacingMm: 8, minInfillLength: 2 }, makeContext());

        assert.ok(totalLength(tight) > totalLength(loose) * 1.5,
            `tighter rows should cost materially more ink: ${totalLength(loose).toFixed(0)} vs ${totalLength(tight).toFixed(0)}`);
    });

    test("no infill at all when the density says none", () => {
        assert.deepEqual(cycloid.generateFill(square(), { spacingMm: 0, minInfillLength: 2 }, makeContext()), []);
    });

    test("a hole in the shape is left unfilled, and breaks the stroke around it", () => {
        // The property the point-in-shape test buys over clipping straight
        // lines: a compound path's hole has to stay bare, and the rows
        // crossing it have to come out as separate strokes rather than one
        // stroke drawn straight through.
        const outer = new paper.Path.Rectangle(new paper.Rectangle(100, 100, 300, 300));
        const hole = new paper.Path.Circle(new paper.Point(250, 250), 80);
        // Wound opposite, or paper reads it as a second filled region rather
        // than a hole - contains() then answers true inside it and the fill is
        // right to draw there. Caught by this test asserting otherwise.
        hole.clockwise = !outer.clockwise;
        const donut = new paper.CompoundPath({ children: [outer, hole] });
        assert.ok(!donut.contains(new paper.Point(250, 250)), "fixture sanity: the hole must be a hole");

        const paths = cycloid.generateFill(donut, { spacingMm: 12, minInfillLength: 2 }, makeContext());
        assert.ok(paths.length > 0);

        for (const p of paths) {
            for (const segment of p.segments) {
                assert.ok(!hole.contains(segment.point) || distanceToEdge(hole, segment.point) <= EDGE_TOLERANCE_MM,
                    `the hole should stay bare, found ink at ${segment.point}`);
            }
        }
    });

    test("the same request redraws the same scribble", () => {
        const a = cycloid.generateFill(square(), { spacingMm: 12, minInfillLength: 2 }, makeContext());
        const b = cycloid.generateFill(square(), { spacingMm: 12, minInfillLength: 2 }, makeContext());

        assert.equal(a.length, b.length);
        assert.ok(Math.abs(totalLength(a) - totalLength(b)) < 1e-6,
            "a re-render of an identical request must not wander, or the preview stops predicting the plot");
    });

    test("the rows really do loop rather than running straight across", () => {
        // The distinguishing property: a stroke that loops travels much
        // further than the straight-line distance between its endpoints. A
        // wavy line would be only slightly longer; a hatch line exactly equal.
        const shape = square(300, 100);
        const paths = cycloid.generateFill(shape, { spacingMm: 12, minInfillLength: 2 }, makeContext());
        const longest = paths.reduce((best, p) => (p.length > best.length ? p : best), paths[0]);

        const span = longest.firstSegment.point.getDistance(longest.lastSegment.point);
        assert.ok(longest.length > span * 1.8,
            `a looping stroke should be far longer than its span: length ${longest.length.toFixed(0)} vs span ${span.toFixed(0)}`);
    });

    test("coverage is matched to the default cross-hatch, not to a single pass", () => {
        // Two passes of a 1.2mm nib per 12mm of spacing.
        assert.ok(Math.abs(coverageForSpacing(12, 1.2) - 0.2) < 1e-9);
        // And it cannot ask for more ink than there is paper.
        assert.ok(coverageForSpacing(1, 1.2) <= 0.95);
    });
}
