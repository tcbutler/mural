// Turning a scribble into something the rest of the renderer already knows how
// to draw.
//
// The scribble algorithms are whole-image: they read the picture and produce
// one long polyline each, where every fill strategy is handed an
// already-traced region and asked to fill it. That difference is why they
// never fitted the FillStrategy seam - but it does not mean they need a
// pipeline of their own.
//
// A traced band is a filled shape that gets an outline and an infill. A
// scribble chain is the same thing with the fill turned off: tag it
// `density: 0` and generateInfills draws its outline and generates nothing
// (infill.ts). So the scribble leaves this module as an SVG in exactly the
// shape the vectorizer's own output takes, and everything downstream - the
// preview, placement, the optimiser, the command encoder, the estimates,
// even the speck filter - carries it unchanged.
//
// Coordinates go out in SOURCE RASTER PIXELS, because that is what the render
// request's svgWidth/svgHeight describe and what toCommands.ts scales by.
import { Point } from './greedy';

export type ScribbleSvgOptions = {
    /** Source raster size, which is the coordinate space the SVG is read in. */
    rasterWidth: number;
    rasterHeight: number;
    /** Physical plot width the chains' millimetres are measured against. */
    drawWidthMm: number;
};

function formatCoordinate(value: number): string {
    // Two decimals of a source pixel is far finer than the tenth of a
    // millimetre the command file will round to anyway, and it keeps the SVG
    // from carrying seventeen digits of float noise per point.
    return (Math.round(value * 100) / 100).toString();
}

/**
 * One `<path>` per chain, all inside a group tagged to draw its outline and
 * generate no fill.
 */
export function scribbleToSvg(chains: Point[][], options: ScribbleSvgOptions): string {
    const { rasterWidth, rasterHeight, drawWidthMm } = options;
    const pixelsPerMm = drawWidthMm > 0 ? rasterWidth / drawWidthMm : 1;

    const paths: string[] = [];
    for (const chain of chains) {
        if (chain.length < 2) continue;
        const parts: string[] = [];
        for (let i = 0; i < chain.length; i++) {
            const x = formatCoordinate(chain[i].x * pixelsPerMm);
            const y = formatCoordinate(chain[i].y * pixelsPerMm);
            parts.push(`${i === 0 ? 'M' : 'L'}${x} ${y}`);
        }
        // Stroked, never filled: a scribble chain is a line the pen follows,
        // not a region. A fill colour here would also send it through the
        // white-knockout pass, which is for painted shapes.
        paths.push(`<path d="${parts.join(' ')}" fill="none" stroke="#000000"/>`);
    }

    // density 0 is what says "draw this, do not fill it" - generateInfills
    // reads it off the group and passes it down to every path inside
    // (generator.ts).
    const tag = JSON.stringify({ density: 0, outline: true });

    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${rasterWidth}" height="${rasterHeight}" viewBox="0 0 ${rasterWidth} ${rasterHeight}">`,
        `<g data-paper-data='${tag}' fill="none" stroke="#000000">`,
        ...paths,
        '</g>',
        '</svg>',
    ].join('');
}
