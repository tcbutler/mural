// Where the drawing lands inside the machine's drawable area.
//
// The render pipeline builds every drawing at the origin: toCommands.ts scales
// about {x: 0, y: 0}, so the artwork occupies (0,0)-(width,height) in machine
// coordinates. While a drawing filled the drawable width that was the same
// thing as "on the wall where you want it". Once you can ask for a smaller
// plot - A4 inside a 498mm drawable area, say - it stops being: the drawing
// ends up jammed into the top-left corner of the reachable area.
//
// That corner is also the worst place to draw. A V-plotter's geometry degrades
// towards the edges, where the belts meet the carriage at their most extreme
// angles, so anything plotted there picks up the most distortion. Centring is
// both what people expect and where the machine draws best.
//
// Applied as a translation of the finished command file rather than during
// rendering, so the on-screen preview still shows the artwork filling its
// frame instead of shrunk into a corner of the drawable area.

export type Placement = "centre" | "topLeft";

export interface PlacementInputs {
    /** Width of the drawing itself, in mm. */
    width: number;
    /** Height of the drawing itself, in mm. */
    height: number;
    /** Machine's drawable width, in mm (60% of the pin distance). */
    safeWidth: number;
    /** Home position, in the same coordinate space as the commands. */
    homeX: number;
    homeY: number;
    placement: Placement;
}

export interface Offset {
    x: number;
    y: number;
}

/**
 * Translation to apply to a rendered command file so the drawing sits where the
 * user asked for it.
 *
 * Clamped to keep the drawing inside what the machine will actually accept:
 * Movement::beginLinearTravel rejects x outside [0, width], and y below 0, so
 * an offset that looked well-centred on paper could otherwise produce a command
 * file the firmware refuses partway through. A drawing wider than the drawable
 * area cannot be placed at all, so it stays at the origin and is left for the
 * existing width-cap warning to deal with.
 */
export function computePlacementOffset(inputs: PlacementInputs): Offset {
    const { width, height, safeWidth, homeX, homeY, placement } = inputs;

    if (placement === "topLeft") {
        return { x: 0, y: 0 };
    }

    // Centre the drawing on the home position - the point the pen parks at, and
    // the middle of the drawable width.
    let x = homeX - width / 2;
    let y = homeY - height / 2;

    const maxX = safeWidth - width;
    if (maxX <= 0) {
        // Too wide to place anywhere; leave it at the origin.
        x = 0;
    } else if (x < 0) {
        x = 0;
    } else if (x > maxX) {
        x = maxX;
    }

    if (y < 0) {
        y = 0;
    }

    return { x, y };
}

/**
 * Translates a rendered command file.
 *
 * Command files are line-based: `d`/`h`/`t`/`n` headers, `p0`/`p1` pen moves,
 * `c<n>` colour swaps, and bare `x y` coordinate pairs. Only the coordinates
 * move. The `d` (total distance) header is unaffected, because translating a
 * path does not change its length.
 */
export function offsetCommands(commands: string[], offset: Offset): string[] {
    if (offset.x === 0 && offset.y === 0) {
        return commands;
    }

    return commands.map(line => {
        // Headers and pen/colour commands carry no coordinates.
        if (line.length === 0 || /^[dhtnpc]/.test(line)) {
            return line;
        }

        const separator = line.indexOf(" ");
        if (separator <= 0) {
            return line;
        }

        const x = parseFloat(line.slice(0, separator));
        const y = parseFloat(line.slice(separator + 1));
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            return line;
        }

        // One decimal place, matching the precision the renderer emits - the
        // machine's own resolution is one microstep, about 0.025mm.
        return `${(x + offset.x).toFixed(1)} ${(y + offset.y).toFixed(1)}`;
    });
}
