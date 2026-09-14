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

// --- Step-encoded files -----------------------------------------------------
//
// Coordinates became steps from the previous point (commandFile.ts) while this
// function still added the offset to every line, as it could when every line was
// a position. Each point was then displaced by a further offset and the drawing
// sheared: a stroke meant for (110,60)-(120,60)-(120,70) came out as
// (20,15)-(40,20)-(50,35). Placement defaults to centring, so this was not an
// edge case - it was every plot.

/** Decodes the way src/runner.cpp does, so these assert what the machine draws. */
function firmwareDecode(lines: string[]): { x: number, y: number }[] {
    const relative = lines[0] === "v2";
    const points: { x: number, y: number }[] = [];
    let x = 0, y = 0;
    for (const line of lines) {
        if (!line || "vpdhtnc".includes(line[0])) continue;
        const separator = line.indexOf(" ");
        if (separator <= 0) continue;
        const a = parseFloat(line.slice(0, separator));
        const b = parseFloat(line.slice(separator + 1));
        if (relative) { x += a / 10; y += b / 10; } else { x = a; y = b; }
        points.push({ x: +x.toFixed(4), y: +y.toFixed(4) });
    }
    return points;
}

test("offsetCommands: a step-encoded drawing is translated, not sheared", () => {
    const { encodeCommandFile } = require("../src/commandFile") as typeof import("../src/commandFile");
    const encoded = encodeCommandFile([
        "d100.0", "h50", "p1", { x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, "p0",
    ]);

    const placed = offsetCommands(encoded, { x: 100, y: 50 });

    assert.deepEqual(firmwareDecode(placed), [
        { x: 110, y: 60 }, { x: 120, y: 60 }, { x: 120, y: 70 },
    ]);
});

test("offsetCommands: only the first point moves, so the shape is unchanged", () => {
    const { encodeCommandFile } = require("../src/commandFile") as typeof import("../src/commandFile");
    const encoded = encodeCommandFile([
        "d100.0", "p1", { x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 25 }, "p0",
    ]);

    const before = firmwareDecode(encoded);
    const after = firmwareDecode(offsetCommands(encoded, { x: 30, y: 70 }));

    const span = (pts: { x: number, y: number }[]) => ({
        w: Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x)),
        h: Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y)),
    });
    assert.deepEqual(span(after), span(before));
    // Every point moved by the same amount - that is what translation means.
    after.forEach((point, index) => {
        assert.equal(+(point.x - before[index].x).toFixed(4), 30);
        assert.equal(+(point.y - before[index].y).toFixed(4), 70);
    });
});

test("offsetCommands: a step-encoded file stays integer-only after placement", () => {
    const { encodeCommandFile } = require("../src/commandFile") as typeof import("../src/commandFile");
    const encoded = encodeCommandFile(["d1.0", "p1", { x: 1, y: 1 }, { x: 2, y: 2 }, "p0"]);

    // A fractional offset must not put a decimal point into a format that has
    // none, or the firmware and this code round it differently.
    for (const line of offsetCommands(encoded, { x: 12.34, y: 56.78 })) {
        if (line.includes(" ") && /^-?\d/.test(line)) {
            assert.match(line, /^-?\d+ -?\d+$/, `expected integer steps, got "${line}"`);
        }
    }
});

test("offsetCommands: a v1 file is still offset on every line", () => {
    // No version marker, so every line is a position and all of them move.
    const v1 = ["d100.0", "p1", "10.0 10.0", "20.0 10.0", "p0"];
    assert.deepEqual(offsetCommands(v1, { x: 5, y: 5 }), [
        "d100.0", "p1", "15.0 15.0", "25.0 15.0", "p0",
    ]);
});
