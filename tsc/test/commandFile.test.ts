import "./testSetup";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
    COMMAND_FILE_VERSION_LINE,
    COORDINATE_UNITS_PER_MM,
    decodeCommandFile,
    encodeCommandFile,
} from "../src/commandFile";
import type { Command } from "../src/types";

const HALF_A_UNIT_MM = 0.5 / COORDINATE_UNITS_PER_MM;

function coordinates(commands: Command[]): { x: number; y: number }[] {
    return commands.filter((c): c is { x: number; y: number } => typeof c !== "string");
}

test("a file says which format it is, on its first line", () => {
    // Firmware that predates relative coordinates requires a distance header
    // here and refuses anything else - which is the point. Reading a step as a
    // position would draw quietly and wrongly.
    const lines = encodeCommandFile(["d10", "h100", "p0", { x: 5, y: 5 }, "p1"]);
    assert.equal(lines[0], COMMAND_FILE_VERSION_LINE);
    assert.equal(lines[1], "d10");
});

test("points are written as a step from the point before, in tenths of a millimetre", () => {
    const lines = encodeCommandFile(["p0", { x: 12.3, y: 45.6 }, "p1", { x: 13.5, y: 45.2 }]);

    assert.deepEqual(lines, [COMMAND_FILE_VERSION_LINE, "p0", "123 456", "p1", "12 -4"]);
});

test("a round trip returns the same drawing, to within half a unit", () => {
    const commands: Command[] = ["d0", "h100", "p0"];
    for (let i = 0; i < 500; i++) {
        commands.push({ x: 10 + i * 0.37, y: 20 + Math.sin(i / 7) * 15 });
    }
    commands.push("p1");

    const decoded = decodeCommandFile(encodeCommandFile(commands));

    const before = coordinates(commands);
    const after = coordinates(decoded);
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
        assert.ok(Math.abs(after[i].x - before[i].x) <= HALF_A_UNIT_MM + 1e-9,
            `point ${i} moved in x: ${before[i].x} -> ${after[i].x}`);
        assert.ok(Math.abs(after[i].y - before[i].y) <= HALF_A_UNIT_MM + 1e-9,
            `point ${i} moved in y: ${before[i].y} -> ${after[i].y}`);
    }
});

test("the error does not accumulate down a long file", () => {
    // The failure this rules out: writing each step from the TRUE previous
    // position rather than the rounded one. Every step then carries its own
    // rounding error and they add up, so a long stroke ends somewhere else
    // entirely. Steps of 0.04mm are chosen to round to zero or one unit
    // alternately, which is where such a drift would show.
    const commands: Command[] = ["p0"];
    for (let i = 0; i < 2000; i++) {
        commands.push({ x: i * 0.04, y: 0 });
    }

    const decoded = coordinates(decodeCommandFile(encodeCommandFile(commands)));
    const last = decoded[decoded.length - 1];
    assert.ok(Math.abs(last.x - 1999 * 0.04) <= HALF_A_UNIT_MM + 1e-9,
        `the end of the stroke drifted to ${last.x}, expected ${(1999 * 0.04).toFixed(2)}`);
});

test("a point that rounds onto the one before it is dropped", () => {
    // It would cost the machine a stop for no movement.
    const lines = encodeCommandFile(["p1", { x: 10, y: 10 }, { x: 10.02, y: 9.98 }, { x: 11, y: 10 }]);

    assert.deepEqual(lines, [COMMAND_FILE_VERSION_LINE, "p1", "100 100", "10 0"]);
});

test("a repeat across a pen command is kept", () => {
    // A stroke that starts where the last one ended is not the same thing as a
    // move to nowhere: drop it and the pen goes down in the wrong place.
    const lines = encodeCommandFile([{ x: 10, y: 10 }, "p1", { x: 10, y: 10 }, { x: 11, y: 10 }]);

    assert.deepEqual(lines, [COMMAND_FILE_VERSION_LINE, "100 100", "p1", "0 0", "10 0"]);
});

test("everything that is not a coordinate passes through untouched", () => {
    const lines = encodeCommandFile(["d123.4", "h200", "t1000", "n1 Ocean", "c2", "p0", "p1"]);

    assert.deepEqual(lines, [COMMAND_FILE_VERSION_LINE, "d123.4", "h200", "t1000", "n1 Ocean", "c2", "p0", "p1"]);
});

test("a file from before the version line is still read as absolute millimetres", () => {
    // Downloaded command files outlive the format that wrote them: the UI
    // takes one back to re-upload, and has to size it against the drawable
    // width either way.
    const decoded = decodeCommandFile(["d10", "h100", "p0", "12.5 40", "p1", "13.5 40"]);

    assert.deepEqual(coordinates(decoded), [{ x: 12.5, y: 40 }, { x: 13.5, y: 40 }]);
});

test("a drawing in the far corner of a big sheet still encodes small", () => {
    // The whole point: a step is a small number wherever on the paper it is
    // taken, where a position gets longer the further out it sits.
    const far = encodeCommandFile(["p1", { x: 1234.5, y: 2345.6 }, { x: 1235.7, y: 2345.2 }]);

    assert.equal(far[far.length - 1], "12 -4");
});
