document.body.addEventListener("click", function(e) {
	if(e.target && e.target.nodeName == "A" && e.target.parentElement.className == 'd-pad') {
        const validDirection = ["up", "down", "left", "right"];
        if (validDirection.includes(e.target.className)) {
            requestChangeInTransform(e.target.className);
        }
	}
});

// Raster detail budget for the Vector -> Raster -> Vector path, as the long
// edge in pixels.
//
// This deliberately does NOT derive from the plot's physical size. It used to:
// the raster was currentWidth/currentHeight (millimetres) times a fixed 2, so
// asking for A4 instead of a 1200mm wall cut the traced detail by more than
// 5x - and because the tracer's despeckle threshold is measured in pixels,
// small features didn't merely soften, they vanished. How much detail to trace
// is a property of the artwork, not of the paper it lands on.
//
// 2400 is the largest raster the old formula ever produced (at the 1200mm
// default), so the worst-case memory footprint is unchanged; small plots
// simply stop being starved.
export const rasterLongEdgePx = 2400;

export function initSvgControl() {
    $("#zoomIn").click(function() {
        requestChangeInTransform("in");
    });
    
    $("#zoomOut").click(function() {
        requestChangeInTransform("out");
    });
    
    $("#resetTransform").click(function() {
        requestChangeInTransform("reset");
    });
}

const affineTransform = [1, 0, 0, 1, 0, 0];
// nudge by this fraction of the viewport's width and height
const nudgeByFactor = 0.025;
const zoomByFactor = 0.05;
function requestChangeInTransform(direction) {
    switch (direction) {
        case "up":
            affineTransform[5] = affineTransform[5] - nudgeByFactor;
            break;
        case "down":
            affineTransform[5] = affineTransform[5] + nudgeByFactor;
            break;
        case "left":
            affineTransform[4] = affineTransform[4] - nudgeByFactor;
            break;
        case "right":
            affineTransform[4] = affineTransform[4] + nudgeByFactor;
            break;
        case "in":
            affineTransform[0] = affineTransform[0] + zoomByFactor;
            affineTransform[3] = affineTransform[3] + zoomByFactor;
            break;
        case "out":
            affineTransform[0] = affineTransform[0] - zoomByFactor;
            affineTransform[3] = affineTransform[3] - zoomByFactor;
            break;
        case "reset":
            resetTransform();
            break;
        default:
            console.log("Unrecognized transform direction");
            return;
    }
    applyTransform();
}

function resetTransform() {
    affineTransform[0] = 1;
    affineTransform[3] = 1;
    affineTransform[4] = 0;
    affineTransform[5] = 0;
}

let originalSvg;
let transformedSvg;
let currentWidth;
let currentHeight;
// Natural aspect of the loaded source SVG (its own width/height, in whatever
// units normalizeSvg() resolved them to - viewBox user units, effectively).
// currentWidth/currentHeight (the "target size", in mm) are always derived
// from this ratio, whether the default (fill the drawable width, see
// setSvgString) or a user-requested width/height (see setTargetWidth/
// setTargetHeight below) - sourceWidth/sourceHeight themselves never change
// for a given loaded image, so re-deriving from them is what lets width and
// height edits stay reversible/idempotent instead of drifting.
let sourceWidth;
let sourceHeight;
export function setSvgString(svgString, currentState) {
    resetTransform();

    originalSvg = new DOMParser().parseFromString(svgString, 'image/svg+xml');
    currentWidth = currentState.safeWidth;
    normalizeSvg();
    applyTransform();
}

const transformGroupID = "muralTransformGroup";
function normalizeSvg() {
    const svgElement = originalSvg.documentElement;
    let width, height;

    if (svgElement.hasAttribute("width") && svgElement.hasAttribute("height")) {
        width = convertUnitsToPx(svgElement.getAttribute("width"));
        height = convertUnitsToPx(svgElement.getAttribute("height"));
    }

    if (svgElement.hasAttribute("viewBox")) {
        if (!width || !height) {
            const viewBox = svgElement.getAttribute("viewBox").split(/[\s,]/).filter(s => s != "");;
            width = parseFloat(viewBox[2]);
            height = parseFloat(viewBox[3]);
        }
    } else if (width && height) {
        svgElement.setAttribute("viewBox", `0, 0, ${width}, ${height}`);
    }

    if (!width || !height) {
        throw new Error("Invalid SVG");
    }

    sourceWidth = width;
    sourceHeight = height;
    currentHeight = currentWidth / sourceWidth * sourceHeight;

    svgElement.setAttribute("width", currentWidth);
    svgElement.setAttribute("height", currentHeight);

    const transformGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
    transformGroup.id = transformGroupID;
    while (svgElement.firstChild) {
        transformGroup.appendChild(svgElement.firstChild);
    }
    svgElement.appendChild(transformGroup);
}

// --- User-requested target size (task 2: "let the user specify a desired
// plotted width or height") -------------------------------------------------
//
// currentWidth/currentHeight (set above from currentState.safeWidth, i.e.
// "fill the drawable width" - the default/legacy behaviour) are also the
// physical mm size of the canvas actually sent to the render pipeline (see
// getTargetWidth/getTargetHeight below, and main.js's renderRequest.width/
// height) - the pan/zoom affine transform re-frames the artwork INSIDE that
// canvas (scaling/nudging it, and clipping or leaving margin), but does not
// itself change the canvas's own mm footprint except when panning downward,
// which grows the height to avoid clipping (see makeTransformedSvgWithHeight
// below). So setting the target size here is exactly "pick the canvas size";
// it's independent of, and always overridable by, the pan/zoom controls that
// act afterward.
//
// Changing the target size resets the pan/zoom transform: the old transform's
// nudge/zoom amounts were chosen by the user relative to the OLD canvas size,
// so keeping them would silently re-frame the artwork in a way the user never
// asked for against the new canvas.
function applySizeToOriginalSvg() {
    const svgElement = originalSvg.documentElement;
    svgElement.setAttribute("width", currentWidth);
    svgElement.setAttribute("height", currentHeight);
}

export function setTargetWidth(widthMM) {
    currentWidth = widthMM;
    currentHeight = currentWidth / sourceWidth * sourceHeight;
    applySizeToOriginalSvg();
    resetTransform();
    applyTransform();
}

export function setTargetHeight(heightMM) {
    currentHeight = heightMM;
    currentWidth = currentHeight / sourceHeight * sourceWidth;
    applySizeToOriginalSvg();
    resetTransform();
    applyTransform();
}

function convertUnitsToPx(dimension) {
    const unitConversionFactors = {
        pt: 1.3333,    // Points to pixels
        pc: 16,        // Picas to pixels
        in: 96,        // Inches to pixels
        cm: 37.795,    // Centimeters to pixels
        mm: 3.7795,    // Millimeters to pixels
        px: 1,         // Pixels to pixels
    };

    const match = dimension.match(/([\d.]+)([a-z%]*)/i);
    if (!match) {
        alert("Invalid SVG");
        throw new Error(`Invalid dimension: "${dimension}"`);
    }
    const value = parseFloat(match[1]);
    const unit = match[2] || "px"; // Default to pixels if no unit is provided

    // A percentage is relative to the viewport the SVG is placed in, not an
    // intrinsic size, so there is no pixel value to convert it to here.
    // Returning null lets normalizeSvg() fall through to the viewBox, which is
    // the real intrinsic size. The previous behaviour fell into the
    // `|| 1` default below and treated width="100%" as 100px - which silently
    // forced sourceWidth === sourceHeight === 100, i.e. a 1:1 aspect ratio for
    // every percentage-sized SVG regardless of its actual proportions.
    if (unit === "%") {
        return null;
    }

    const conversionFactor = unitConversionFactors[unit] || 1;
    return value * conversionFactor; // Convert to pixels
}

export function getTargetWidth() {
    return currentWidth;
}

export function getTargetHeight() {
    return currentHeight;
}

export function getRenderSvg() {
    return makeTransformedSvgWithHeight()[0];
}

function applyTransform() {
    updateTransformText();

    const [clonedSvg, newHeight] = makeTransformedSvgWithHeight();
    currentHeight = newHeight;
    
    const svgString = new XMLSerializer().serializeToString(clonedSvg);
    const svgDataURL = `data:image/svg+xml;base64,${btoa(svgString)}`;
    $("#sourceSvg")[0].src = svgDataURL;

    transformedSvg = clonedSvg;
}

function makeTransformedSvgWithHeight() {
    const clonedSvg = originalSvg.cloneNode(true);
    const svgElement = clonedSvg.documentElement;

    const viewBox = svgElement.getAttribute("viewBox").split(/[\s,]/).filter(s => s != "");
    const vbMinX = parseFloat(viewBox[0]);
    const vbMinY = parseFloat(viewBox[1]);
    const vbWidth = parseFloat(viewBox[2]);
    const vbHeight = parseFloat(viewBox[3]);

    // Pan is stored as a fraction of the viewport, zoom as a plain scale
    // factor. Read both off up front - the scaledAffine translation slots get
    // overwritten below and can no longer be used to recover either one.
    const zoomX = affineTransform[0];
    const zoomY = affineTransform[3];
    const panX = affineTransform[4];
    const panY = affineTransform[5];

    // An SVG matrix() scales about the user-space origin - for a viewBox
    // starting at (0,0) that is the artwork's top-left corner. Zooming in
    // therefore used to push the artwork down and right, clipping its right
    // and bottom edges off the viewBox while opening an ever-growing margin at
    // the top-left, rather than magnifying about the middle of the frame the
    // way the +/- buttons imply. Offsetting the translation by
    // (1 - zoom) * centre pins the viewBox centre in place instead.
    //
    // Deliberately derived from the ORIGINAL viewBox, before the pan-down
    // growth below extends it: the user is zooming about the centre of the
    // artwork they can see, not the centre of a canvas that panning has since
    // made taller.
    const zoomOffsetX = (1 - zoomX) * (vbMinX + vbWidth / 2);
    const zoomOffsetY = (1 - zoomY) * (vbMinY + vbHeight / 2);

    const scaledAffine = [...affineTransform];
    scaledAffine[4] = panX * vbWidth + zoomOffsetX;
    scaledAffine[5] = panY * vbHeight + zoomOffsetY;

    // Panning downward grows the canvas instead of clipping the top. Keyed off
    // the pan component alone, NOT the combined translation above: that now
    // carries the zoom offset too, so testing it would enter (or skip) this
    // branch because of a zoom the user applied rather than a downward pan.
    let newHeight = parseFloat(svgElement.getAttribute("height"));
    if (panY > 0) {
        // when shifting down increase height
        newHeight = newHeight + panY * newHeight;
        svgElement.setAttribute("height", newHeight);

        viewBox[3] = vbHeight + panY * vbHeight;
        svgElement.setAttribute("viewBox", viewBox.join(", "));
    }

    const transfromGroup = clonedSvg.getElementById(transformGroupID);
    transfromGroup.setAttribute("transform", `matrix(${scaledAffine.join(", ")})`);

    return [clonedSvg, newHeight];
}

function updateTransformText() {
    function normalizeNumber(num) {
        return +num.toFixed(2);
    }
    $("#transformText").text(`(${normalizeNumber(affineTransform[4] * 100)}, ${normalizeNumber(affineTransform[5] * 100)}) ${normalizeNumber(affineTransform[0])}x`);
}

// Raster pixel dimensions for the current canvas, preserving its aspect so a
// single uniform scale factor (toCommands.ts's width/svgWidth) maps both axes.
function getRasterSize() {
    if (!(currentWidth > 0) || !(currentHeight > 0)) {
        throw new Error("Invalid canvas size");
    }
    const aspect = currentHeight / currentWidth;
    if (currentWidth >= currentHeight) {
        return [rasterLongEdgePx, Math.max(1, Math.round(rasterLongEdgePx * aspect))];
    }
    return [Math.max(1, Math.round(rasterLongEdgePx / aspect)), rasterLongEdgePx];
}

export async function getCurrentSvgImageData() {
    const [rasterWidth, rasterHeight] = getRasterSize();

    // Rasterise the SVG AT the target size rather than at its own
    // (millimetre-valued) width/height and resampling afterwards. An <img>
    // decodes an SVG at its intrinsic size, so the old path only ever captured
    // currentWidth pixels of real detail before handing it to
    // createImageBitmap - and no resize can recover detail that was never
    // rendered in the first place. Overriding width/height on a throwaway
    // clone leaves transformedSvg (and so the on-screen preview) untouched.
    const rasterSvg = transformedSvg.cloneNode(true);
    rasterSvg.documentElement.setAttribute("width", rasterWidth);
    rasterSvg.documentElement.setAttribute("height", rasterHeight);

    const svgString = new XMLSerializer().serializeToString(rasterSvg);

    const canvas = new OffscreenCanvas(rasterWidth, rasterHeight);
    const canvasContext = canvas.getContext("2d");
    const img = await loadImage(`data:image/svg+xml;base64,${btoa(svgString)}`);

    canvasContext.drawImage(img, 0, 0, rasterWidth, rasterHeight);

    return canvasContext.getImageData(0, 0, canvas.width, canvas.height);
}

async function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

export function getSvgJson(svgString) {
    const size = new paper.Size(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    paper.setup(size);
    const svg = paper.project.importSVG(svgString, {
        expandShapes: true,
        applyMatrix: true,
    });
    const json = svg.exportJSON();
    paper.project.remove();

    return json;
}

export function convertJsonToDataURL(json, width, height) {
    $("#previewCanvas").remove();
    $(document.body).append(`<canvas id="previewCanvas" width="${width}" height="${height}" style="display: none;"></canvas>`);
    
    paper.setup($("#previewCanvas")[0]);
    paper.project.importJSON(json);
    paper.view.draw();

    const dataURL = $("#previewCanvas")[0].toDataURL();
    
    paper.project.remove();
    $("#previewCanvas").remove();

    return dataURL;
}



