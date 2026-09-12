import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { computePlacementOffset, offsetCommands } from "../src/placement";

// The machine Tom is running: 830mm pin distance -> 498mm drawable width, home
// at the middle of that width and 350mm down.
const machine = { safeWidth: 498, homeX: 249, homeY: 350 };

test("computePlacementOffset: centres a smaller drawing on the home position", () => {
    const offset = computePlacementOffset({
        ...machine, width: 210, height: 210, placement: "centre",
    });
    // 249 - 105 = 144 across, 350 - 105 = 245 down.
    assert.equal(offset.x, 144);
    assert.equal(offset.y, 245);
});

test("computePlacementOffset: topLeft reproduces the original origin placement", () => {
    const offset = computePlacementOffset({
        ...machine, width: 210, height: 210, placement: "topLeft",
    });
    assert.deepEqual(offset, { x: 0, y: 0 });
});

test("computePlacementOffset: a drawing filling the drawable width is unmoved", () => {
    const offset = computePlacementOffset({
        ...machine, width: 498, height: 300, placement: "centre",
    });
    assert.equal(offset.x, 0);
});

test("computePlacementOffset: never pushes past the right edge", () => {
    // Home well right of centre would otherwise place the drawing out of reach;
    // beginLinearTravel rejects x beyond the drawable width.
    const offset = computePlacementOffset({
        safeWidth: 498, homeX: 480, homeY: 350, width: 210, height: 210, placement: "centre",
    });
    assert.equal(offset.x, 498 - 210);
});

test("computePlacementOffset: never produces a negative offset", () => {
    const offset = computePlacementOffset({
        safeWidth: 498, homeX: 20, homeY: 40, width: 210, height: 210, placement: "centre",
    });
    assert.equal(offset.x, 0);
    assert.equal(offset.y, 0);
});

test("computePlacementOffset: a drawing wider than the drawable area stays at the origin", () => {
    const offset = computePlacementOffset({
        ...machine, width: 600, height: 300, placement: "centre",
    });
    assert.equal(offset.x, 0);
});

test("offsetCommands: moves coordinates and leaves headers and pen commands alone", () => {
    const commands = ["d1234.5", "h210", "t830", "n1 black", "p0", "10.0 20.0", "p1", "30.5 40.5", "c2"];
    const result = offsetCommands(commands, { x: 100, y: 200 });
    assert.deepEqual(result, [
        "d1234.5", "h210", "t830", "n1 black", "p0", "110.0 220.0", "p1", "130.5 240.5", "c2",
    ]);
});

test("offsetCommands: a zero offset returns the commands untouched", () => {
    const commands = ["d1.0", "p0", "10.0 20.0"];
    assert.equal(offsetCommands(commands, { x: 0, y: 0 }), commands);
});

test("offsetCommands: translation does not change path length", () => {
    // The `d` header is a total distance, so it must survive a move unchanged -
    // the firmware reads it to size its progress estimate.
    const commands = ["d500.0", "p1", "0.0 0.0", "100.0 0.0"];
    const moved = offsetCommands(commands, { x: 144, y: 245 });
    assert.equal(moved[0], "d500.0");

    const span = (cmds: string[]) => {
        const pts = cmds.filter(c => /^[-\d]/.test(c)).map(c => c.split(" ").map(Number));
        return Math.hypot(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    };
    assert.equal(span(moved), span(commands));
});
