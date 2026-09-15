// PUBLIC ENTRY POINT for the cost-estimation module.
//
// This module answers two questions a user needs BEFORE they commit to a
// render:
//   (a) PROCESSING time - how long the browser will grind through
//       vectorizing/quantizing/knocking-out/infilling/optimizing/rendering
//       the image (processingEstimator.ts), scaled for the current
//       device's actual speed (deviceCalibration.ts).
//   (b) PLOTTING time - how long the physical plotter will take to draw the
//       result (plottingEstimator.ts), including the pen-lift cost that
//       dominates on strategies that produce many short disconnected
//       segments.
// It also answers a third, related question: what settings should this
// particular image use by default, so it "just works" without the user
// needing to understand fill strategies or hatch density
// (smartDefaults.ts, driven by imageCharacteristics.ts's cheap image
// stats).
//
// -------------------------------------------------------------------
// USAGE (for the UI branch consuming this module)
// -------------------------------------------------------------------
//
//   import { estimateAndRecommend } from './costEstimator';
//
//   const result = estimateAndRecommend(imageData, {
//       // Any of these override the corresponding smart default; omit to
//       // use the recommended value.
//       colorCount: 4,
//       fillStrategy: 'crossHatch45',
//       infillDensity: 3,
//       hueGrouping: false,
//       knockout: true,
//       flattenPaths: true,
//       grayscaleLevels: undefined,
//       // Whole-image mark making instead of a trace. Set it and both
//       // estimates describe that render - see scribble/projection.ts.
//       markMode: 'greedy',
//       // Physical size the job will actually be drawn at - used to turn
//       // path/segment *counts* into real mm draw/travel distances for the
//       // plotting-time projection. Defaults to a generic mural-sized
//       // guess (see DEFAULT_DRAW_WIDTH_MM/HEIGHT_MM below) if omitted -
//       // supply the real planned size for an accurate plotting estimate.
//       drawWidthMm: 900,
//       drawHeightMm: 1200,
//       // Plotter speed profile (see plottingEstimator.ts's header for why
//       // this is a required-to-think-about parameter, not a baked-in
//       // constant - the pen-up travel speed is mid-migration between two
//       // firmware behaviors on a sibling branch).
//       speeds: CURRENT_FIRMWARE_SPEEDS, // the default; see plottingEstimator.ts
//   });
//
//   result.characteristics   // ImageCharacteristics - the raw image stats,
//                            // measured on the image as supplied (see below)
//   result.recommendations   // SmartDefaults - value + human-readable rationale, per field
//   result.deviceCalibration // DeviceCalibration - this device's measured speed factor
//   result.processing        // ProcessingEstimate - seconds + per-stage breakdown
//   result.plotting          // PlottingTimeEstimate - seconds + draw/travel/pen-lift breakdown
//   result.scribble          // ScribbleProjection - what a mark mode will draw (only with markMode)
//
// Every option is independent: pass none to get pure recommendations run
// through both estimators; override just `fillStrategy` to see how a
// user's manual choice compares to the recommended one, etc.
import { InfillDensity } from './types';
import { FillStrategyName } from './fillStrategyNames';
import { analyzeImageCharacteristics, ImageCharacteristics } from './imageCharacteristics';
import { recommendDefaults, SmartDefaults } from './smartDefaults';
import { calibrateDeviceSpeed, DeviceCalibration } from './deviceCalibration';
import { estimateProcessingSeconds, ProcessingEstimate } from './processingEstimator';
import {
    estimatePlottingSeconds,
    PlottingTimeEstimate,
    PlotterSpeedProfile,
    CURRENT_FIRMWARE_SPEEDS,
} from './plottingEstimator';
import { projectSegmentCounts, spacingMmForDensity } from './segmentModel';
import { needsPreparation, preparationFor, prepareTone } from './tonePreparation';
import { MarkMode } from './scribble/markModes';
import { projectScribble, ScribbleProjection } from './scribble/projection';
import { DEFAULT_NIB_WIDTH_MM } from './huePalette';

export {
    // Re-exported so a caller only needs one import for the common path,
    // while every module remains independently importable/testable.
    analyzeImageCharacteristics,
    recommendDefaults,
    calibrateDeviceSpeed,
    estimateProcessingSeconds,
    estimatePlottingSeconds,
    CURRENT_FIRMWARE_SPEEDS,
};
export type { ImageCharacteristics, SmartDefaults, DeviceCalibration, ProcessingEstimate, PlottingTimeEstimate, PlotterSpeedProfile };

// Generic fallback physical size (mm) used only when the caller doesn't yet
// know the actual planned draw size (e.g. showing a rough estimate before
// the user has picked a canvas size). A mid-size mural - purely a
// placeholder for turning path *counts* into ink-length mm; pass real
// drawWidthMm/drawHeightMm for an accurate plotting estimate.
export const DEFAULT_DRAW_WIDTH_MM = 900;
export const DEFAULT_DRAW_HEIGHT_MM = 1200;

export type CostEstimatorOptions = {
    // Render settings. Each defaults to the corresponding smart
    // recommendation (see `recommendations` in the result) when omitted.
    colorCount?: number;
    fillStrategy?: FillStrategyName;
    infillDensity?: InfillDensity;
    hueGrouping?: boolean;
    // Cross-layer / intra-layer knockout (see processingEstimator.ts's
    // ProcessingEstimateInputs for what each controls). Not covered by
    // smart defaults (they're structural render choices, not
    // image-derived) - default false/off.
    knockout?: boolean;
    flattenPaths?: boolean;
    grayscaleLevels?: number;
    // Tone preparation (tonePreparation.ts), the pair that decides what the
    // render will draw FROM. They belong here for the same reason every
    // other render setting does: the estimate is meant to describe the plot
    // that is about to happen, and a render with a white point set traces a
    // measurably different image from one without. Omitted, each defaults to
    // its own recommendation, like the settings above.
    whitePoint?: number;
    warmth?: number;
    // Whole-image mark making (scribble/). Set it and the estimate describes
    // that render instead: no trace, no fill strategy, no infill density, and
    // a drawing whose cost is a stroke count rather than a shape count. The
    // fillStrategy/infillDensity options above are simply not part of that
    // render, and are ignored rather than quietly folded in.
    markMode?: MarkMode;
    // Nib width, mm - how much paper a stroke covers, and so how much line the
    // picture needs. Only read on the mark-making path; the traced path takes
    // its ink model from the hatch spacing instead.
    penWidthMm?: number;
    // A cheap 0..1 image-complexity proxy for the processing estimate.
    // Defaults to (1 - flatFraction) from the computed characteristics -
    // the fraction of the image that ISN'T a large uniform region, a
    // reasonable stand-in for "how much tracing work is here" (see
    // processingEstimator.ts's `complexity` doc comment).
    complexity?: number;
    // Skips live device calibration in favor of a caller-supplied value
    // (e.g. a UI that already calibrated once this session).
    deviceFactor?: number;
    // Physical output size (mm) - see DEFAULT_DRAW_WIDTH_MM/HEIGHT_MM above.
    drawWidthMm?: number;
    drawHeightMm?: number;
    speeds?: PlotterSpeedProfile;
};

export type CostEstimateAndRecommendation = {
    // Measured on the image as supplied, which is what the recommendations
    // below are advice about. The processing and plotting estimates are built
    // on a second reading of the PREPARED image - see estimateAndRecommend.
    characteristics: ImageCharacteristics;
    recommendations: SmartDefaults;
    deviceCalibration: DeviceCalibration;
    processing: ProcessingEstimate;
    plotting: PlottingTimeEstimate;
    // What the chosen mark-making mode is projected to draw, when one is
    // chosen (scribble/projection.ts). Absent on a traced render.
    scribble?: ScribbleProjection;
};

// Rough fraction of an outline shape's own bounding "diameter" that its
// drawn boundary length works out to, on average, across typical traced
// shapes (a mix of roughly circular/blobby and roughly rectangular forms) -
// used only to turn a projected shape count into a projected outline ink
// length for the pre-render plotting estimate. A circle's circumference is
// pi*diameter (~3.14); a square's perimeter is 4*side (~4x its diagonal's
// 0.7 share... i.e. ~2.8x its diameter) - 3.0 sits between those two common
// cases.
const OUTLINE_PERIMETER_PER_SPAN = 3.0;

export function estimateAndRecommend(imageData: ImageData, options: CostEstimatorOptions = {}): CostEstimateAndRecommendation {
    // Two readings of the same image, and which one answers which question
    // matters. The recommendations are advice about the image as supplied -
    // "nothing here is bright enough to read as paper" is a statement about
    // the photograph, and asking it of an image whose white point has already
    // been set would be circular. The cost estimates are about the render
    // that is about to run, which will trace the PREPARED image.
    const characteristics = analyzeImageCharacteristics(imageData);
    const recommendations = recommendDefaults(characteristics);

    const colorCount = options.colorCount ?? recommendations.colorCount.value;
    const fillStrategy = options.fillStrategy ?? recommendations.fillStrategy.value;
    const infillDensity = options.infillDensity ?? recommendations.infillDensity.value;
    const hueGrouping = options.hueGrouping ?? recommendations.hueGrouping.value;

    // preparationFor rather than the two values directly, so the rule about
    // warmth on the colour path is stated once, in the module that owns it,
    // and the estimate cannot drift from what the render will really do.
    const preparation = preparationFor({
        whitePoint: options.whitePoint ?? recommendations.whitePoint.value,
        warmth: options.warmth ?? recommendations.warmth.value,
        colorCount,
    });
    // A second pass over the pixels, and only when there is a preparation to
    // apply - which is why this is not simply done unconditionally.
    const preparedCharacteristics = needsPreparation(preparation)
        ? analyzeImageCharacteristics(prepareTone(imageData, preparation))
        : characteristics;

    const complexity = options.complexity ?? (1 - preparedCharacteristics.flatFraction);

    const deviceCalibration = options.deviceFactor !== undefined
        ? { factor: options.deviceFactor, benchmarkMs: 0, measuredAt: Date.now() }
        : calibrateDeviceSpeed();

    // Resolved before estimateProcessingSeconds (not after, as previously)
    // so its avgShapeSpanMm projection is anchored to the real requested
    // physical size instead of a raster-pixel-density guess - see
    // processingEstimator.ts's ProcessingEstimateInputs.drawWidthMm doc
    // comment for the under-read bug this fixes.
    const drawWidthMm = options.drawWidthMm ?? DEFAULT_DRAW_WIDTH_MM;
    const drawHeightMm = options.drawHeightMm ?? DEFAULT_DRAW_HEIGHT_MM;

    // The mark-making projection, when a mode is chosen: both estimates are
    // built on it, so it is computed once here, where the prepared image's
    // statistics are already to hand.
    const scribble = options.markMode
        ? projectScribble({
            mode: options.markMode,
            sourceWidthPx: preparedCharacteristics.widthPx,
            sourceHeightPx: preparedCharacteristics.heightPx,
            drawWidthMm,
            penWidthMm: options.penWidthMm ?? DEFAULT_NIB_WIDTH_MM,
            // Read off the PREPARED image, like everything else the estimates
            // are built on: a white point that turns a grey background into
            // paper takes most of the ink demand with it, which is most of
            // what a scribble's cost is.
            meanDarkness: preparedCharacteristics.meanDarkness,
            meanInkDemand: preparedCharacteristics.meanInkDemand,
            whiteHeadroom: preparedCharacteristics.whiteHeadroom,
        })
        : undefined;

    const processing = estimateProcessingSeconds({
        sourceWidthPx: characteristics.widthPx,
        sourceHeightPx: characteristics.heightPx,
        colorCount,
        fillStrategy,
        infillDensity,
        complexity,
        hueGrouping,
        knockout: options.knockout,
        flattenPaths: options.flattenPaths,
        grayscaleLevels: options.grayscaleLevels,
        deviceFactor: deviceCalibration.factor,
        drawWidthMm,
        drawHeightMm,
        scribble,
    });

    if (scribble) {
        // One pen-down/pen-up bracket per chain, and no pen swaps: a scribble
        // is one pen's worth of drawing by construction.
        const plotting = estimatePlottingSeconds(
            {
                drawDistanceMm: scribble.drawnMm,
                travelDistanceMm: scribble.travelMm,
                penTransitionCount: scribble.chainCount * 2,
                penSwapCount: 0,
            },
            { speeds: options.speeds },
        );
        return { characteristics, recommendations, deviceCalibration, processing, plotting, scribble };
    }

    const drawAreaMm2 = Math.max(0, drawWidthMm) * Math.max(0, drawHeightMm);
    const avgShapeSpanMm = processing.estimatedShapeCount > 0
        ? Math.sqrt(drawAreaMm2 / processing.estimatedShapeCount)
        : 0;

    const segments = projectSegmentCounts({
        shapeCount: processing.estimatedShapeCount,
        avgShapeSpanMm,
        fillStrategy,
        infillDensity,
        // Same complexity-driven per-shape correction the processing-time
        // estimate uses (see processingEstimator.ts's call site) - keeps
        // the plotting-distance projection consistent with it, rather than
        // silently reverting to the plain shapeCount-only model here.
        shapeComplexity: complexity,
    });

    // Outline ink: one boundary length per shape. Infill ink: segment count
    // times each strategy's own average-segment-length model
    // (segmentModel.ts). Both are order-of-magnitude projections - see
    // plottingEstimator.ts's estimatePlottingSecondsFromCommands for the
    // exact alternative once a real render/command list exists.
    const outlineDrawDistanceMm = segments.shapeCount * avgShapeSpanMm * OUTLINE_PERIMETER_PER_SPAN;
    const infillDrawDistanceMm = segments.infillSegmentCount * segments.avgInfillSegmentLengthMm;
    const drawDistanceMm = outlineDrawDistanceMm + infillDrawDistanceMm;

    // Pen-up travel between consecutive drawn segments: bounded 2-opt
    // (optimizer.ts) minimizes this but doesn't eliminate it: assume, on
    // average, half a shape-span of travel between one segment's end and
    // the next segment's start - a deliberately simple stand-in for
    // "however far apart the optimizer's chosen ordering leaves adjacent
    // segments", since actually simulating the optimizer's output isn't
    // available before a real render.
    const travelDistanceMm = segments.totalDrawSegments * (avgShapeSpanMm / 2);

    // Every drawn path/segment gets its own pen-down + pen-up bracket (see
    // plottingEstimator.ts's PlottingTimeInputs doc comment, citing
    // renderer.ts).
    const penTransitionCount = segments.totalDrawSegments * 2;

    // Pen swaps: one boundary between each pair of colors when multi-color
    // rendering is in play (toCommands.ts's renderMultiColor emits N-1
    // `c<index>` markers for N colors/layers).
    const penSwapCount = Math.max(0, colorCount - 1);

    const plotting = estimatePlottingSeconds(
        { drawDistanceMm, travelDistanceMm, penTransitionCount, penSwapCount },
        { speeds: options.speeds },
    );

    return { characteristics, recommendations, deviceCalibration, processing, plotting };
}

// Re-exported for callers that already have a computed InfillDensity and
// want the same spacing table this module's estimators use internally
// (e.g. to show "X mm hatch spacing" in a UI alongside the density slider).
export { spacingMmForDensity };
