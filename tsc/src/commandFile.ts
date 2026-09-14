// How a command list becomes the text the machine reads.
//
// The file is the one artefact with a hard size limit: it lives in the same
// 832K LittleFS partition as the UI, which leaves about 600K for a drawing,
// and a plot that does not fit is refused at upload - after the render, after
// the wait, with nothing to do about it but draw something smaller. So the
// encoding is worth a byte or two.
//
// Coordinates used to be written as absolute millimetres at whatever precision
// JavaScript's number-to-string gave them ("123.45678901234567 456.789"). They
// are now written as a step from the previous point, in tenths of a millimetre:
//
//     p0
//     1234 5678      <- the first point in a file, stepped from 0,0
//     p1
//     12 -4          <- and every point after it, stepped from the last
//
// Two things make that much smaller. A step is a small number where a position
// is a large one, and a tenth of a millimetre needs no decimal point. Measured
// across four fill styles on the same drawing, files come out 41-52% smaller,
// the curve-heavy styles gaining most because they have the most points to pay
// for: contour 195K to 94K, spiral 163K to 85K, loop scribble 133K to 77K,
// cross-hatch 73K to 43K.
//
// Precision: a tenth of a millimetre is a twelfth of the width of the pen, and
// an eighth of the 1mm steps the firmware interpolates a move into. Each step
// is measured from the ROUNDED position already written rather than from the
// true one, so the error stays under half a unit and never accumulates, however
// long the file.
//
// Versioning: a v2 file says so on its first line, before the headers the older
// format starts with. Firmware that predates this reads that line, finds it is
// not the distance header it requires, and refuses the file - which is the
// point. A relative coordinate read as an absolute one would be silently
// obeyed, and the machine would draw a few millimetres of nonsense in the
// corner of the page.
import { Command, CoordinateCommand } from './types';

// Line that marks the format, and the only thing that distinguishes a v2 file
// from a v1 one at a glance.
export const COMMAND_FILE_VERSION_LINE = 'v2';

// Coordinate units per millimetre.
export const COORDINATE_UNITS_PER_MM = 10;

function isCoordinate(command: Command): command is CoordinateCommand {
    return typeof command !== 'string';
}

/**
 * Encodes a command list as the lines of a v2 command file, version line
 * included.
 *
 * A point that rounds onto the one before it is dropped rather than written as
 * a step of nothing: it would cost the machine a stop for no movement. Only
 * when the two are genuinely consecutive, though - a repeat with a pen command
 * between them is a stroke that starts where the last one ended, and that has
 * to stay.
 */
export function encodeCommandFile(commands: Command[]): string[] {
    const lines: string[] = [COMMAND_FILE_VERSION_LINE];

    let x = 0;
    let y = 0;
    let lastWasCoordinate = false;

    for (const command of commands) {
        if (!isCoordinate(command)) {
            lines.push(command);
            lastWasCoordinate = false;
            continue;
        }

        const targetX = Math.round(command.x * COORDINATE_UNITS_PER_MM);
        const targetY = Math.round(command.y * COORDINATE_UNITS_PER_MM);
        const stepX = targetX - x;
        const stepY = targetY - y;

        if (stepX === 0 && stepY === 0 && lastWasCoordinate) {
            continue;
        }

        lines.push(`${stepX} ${stepY}`);
        x = targetX;
        y = targetY;
        lastWasCoordinate = true;
    }

    return lines;
}

/**
 * Reads a v2 or a v1 command file back into absolute millimetre coordinates.
 *
 * The UI needs this to check a re-uploaded file against the drawable width, and
 * the gallery tool needs it to draw a command file as a picture. Both used to
 * match `x y` with a regular expression and take the numbers at face value,
 * which quietly reads every step of a v2 file as a position near the origin.
 */
export function decodeCommandFile(lines: string[]): Command[] {
    const relative = lines.length > 0 && lines[0].trim() === COMMAND_FILE_VERSION_LINE;
    const commands: Command[] = [];

    let x = 0;
    let y = 0;

    for (const raw of lines) {
        const line = raw.trim();
        if (line.length === 0 || line === COMMAND_FILE_VERSION_LINE) {
            continue;
        }

        const match = /^(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)$/.exec(line);
        if (!match) {
            commands.push(line);
            continue;
        }

        if (relative) {
            x += Math.round(Number(match[1]));
            y += Math.round(Number(match[2]));
            commands.push({ x: x / COORDINATE_UNITS_PER_MM, y: y / COORDINATE_UNITS_PER_MM });
        } else {
            commands.push({ x: Number(match[1]), y: Number(match[2]) });
        }
    }

    return commands;
}

/**
 * Decodes a command file back to absolute millimetre lines, in the same
 * `"x y"` shape the file used before v2.
 *
 * For consumers that want text rather than structured commands - the preview
 * builder (toSvgJson.ts) is one, and it parses lines with charAt/split rather
 * than taking a Command[].
 */
export function decodeToAbsoluteLines(lines: string[]): string[] {
    return decodeCommandFile(lines).map(command =>
        typeof command === 'string' ? command : `${command.x} ${command.y}`);
}
