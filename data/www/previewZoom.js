// Pan and pinch-zoom for the enlarged drawing preview.
//
// "Enlarge" was a CSS checkbox hack that fit the preview to the screen and
// stopped there, so on a phone it barely changed anything and there was no way
// to look closely at a small feature. Fitting to the screen is the one thing you
// do not need help with; inspecting detail is.
//
// Deliberately not relying on the browser's own pinch-zoom: that zooms the whole
// page, so the image moves under the chrome and the surrounding UI scales with
// it. Handling the gesture here keeps the zoom to the image.
//
// Pointer Events rather than Touch Events, so the same code covers touch, mouse
// drag and trackpad without three code paths.

const MIN_SCALE = 1;
const MAX_SCALE = 12;
// Below this a "pinch" is indistinguishable from two fingers resting, and
// tracking it just makes the image jitter.
const PINCH_DEADZONE_PX = 4;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;
const DOUBLE_TAP_SCALE = 3;

export function initPreviewZoom({ toggleId, imageId, frameId, scaleReadoutId }) {
    const toggle = document.getElementById(toggleId);
    const image = document.getElementById(imageId);
    const frame = document.getElementById(frameId);
    if (!toggle || !image || !frame) {
        return;
    }

    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    const pointers = new Map();
    let pinchStartDistance = 0;
    let pinchStartScale = 1;

    // Double-tap detection has to be decided when a gesture ENDS, not when the
    // next one starts. Deciding on pointerdown meant the finger that began a pan
    // counted as the second tap of a "double tap" whose first tap was really the
    // opening finger of the preceding pinch - so panning after pinching snapped
    // straight back to fit.
    // Size of the image as laid out at scale 1. Measured rather than derived
    // because CSS fits it to the frame; kept so clampPan can work out the
    // painted size for a scale that has not been applied yet.
    let baseWidth = 0;
    let baseHeight = 0;

    let gestureStart = 0;
    let gesturePinched = false;
    let gestureMoved = false;
    let lastTapTime = 0;
    let lastTapX = 0;
    let lastTapY = 0;

    const readout = scaleReadoutId ? document.getElementById(scaleReadoutId) : null;

    function apply() {
        image.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
        if (readout) {
            readout.textContent = `${scale.toFixed(1)}x`;
            readout.style.visibility = scale > 1.01 ? 'visible' : 'hidden';
        }
        // Only claim the gesture while there is somewhere to pan to, so a
        // not-yet-zoomed preview still scrolls the page normally.
        image.style.touchAction = scale > 1.01 ? 'none' : '';
    }

    function reset() {
        scale = 1;
        translateX = 0;
        translateY = 0;
        apply();

        // Now that the identity transform is applied, this is the fitted size.
        // Skipped while the image has no layout (hidden, or not yet decoded),
        // which would otherwise record a zero base and clamp everything to nothing.
        const rect = image.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
            baseWidth = rect.width;
            baseHeight = rect.height;
        }
    }

    // Keeps the image overlapping the frame. Panning it entirely off-screen
    // leaves a blank view with no clue how to get back.
    //
    // Takes the scale to clamp FOR rather than measuring the element: the new
    // transform has not been applied at the point this runs, so measuring would
    // return the previous zoom's size. That is what allowed pinching back to fit
    // to leave the image sitting off-centre, clamped against a scale it was no
    // longer at.
    function clampPan(forScale) {
        if (baseWidth === 0 || baseHeight === 0) {
            return;
        }
        const frameRect = frame.getBoundingClientRect();
        const paintedWidth = baseWidth * forScale;
        const paintedHeight = baseHeight * forScale;

        const maxX = Math.max(0, (paintedWidth - frameRect.width) / 2);
        const maxY = Math.max(0, (paintedHeight - frameRect.height) / 2);

        translateX = Math.min(maxX, Math.max(-maxX, translateX));
        translateY = Math.min(maxY, Math.max(-maxY, translateY));
    }

    // Zooms about a point in viewport coordinates, so the pixel under the
    // fingers (or cursor) stays put - the thing that makes zooming feel direct
    // rather than like a slider.
    function zoomAbout(clientX, clientY, nextScale) {
        const rect = image.getBoundingClientRect();
        const centreX = rect.left + rect.width / 2;
        const centreY = rect.top + rect.height / 2;
        const offsetX = clientX - centreX;
        const offsetY = clientY - centreY;

        const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
        const ratio = clamped / scale;

        translateX -= offsetX * (ratio - 1);
        translateY -= offsetY * (ratio - 1);
        scale = clamped;

        clampPan(scale);
        apply();
    }

    function distanceBetween(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function onPointerDown(event) {
        if (!toggle.checked) {
            return;
        }
        // Capture keeps a drag alive if the finger leaves the image, but a
        // pointer id the browser does not recognise throws - which must not take
        // the gesture handler down with it.
        try {
            image.setPointerCapture(event.pointerId);
        } catch (err) {
            /* not a live pointer - carry on without capture */
        }
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (pointers.size === 1) {
            gestureStart = Date.now();
            gesturePinched = false;
            gestureMoved = false;
        } else if (pointers.size === 2) {
            gesturePinched = true;
            const [a, b] = [...pointers.values()];
            pinchStartDistance = distanceBetween(a, b);
            pinchStartScale = scale;
        }
    }

    function onPointerMove(event) {
        if (!toggle.checked || !pointers.has(event.pointerId)) {
            return;
        }
        const previous = pointers.get(event.pointerId);
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (pointers.size === 2) {
            const [a, b] = [...pointers.values()];
            const spread = distanceBetween(a, b);
            if (Math.abs(spread - pinchStartDistance) < PINCH_DEADZONE_PX || pinchStartDistance === 0) {
                return;
            }
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2;
            zoomAbout(midX, midY, pinchStartScale * (spread / pinchStartDistance));
            event.preventDefault();
            return;
        }

        // Single pointer pans, but only once there is something to pan to.
        const dx = event.clientX - previous.x;
        const dy = event.clientY - previous.y;
        if (Math.hypot(dx, dy) > 0) {
            gestureMoved = gestureMoved || Math.hypot(dx, dy) > 2;
        }
        if (scale > 1.01) {
            translateX += dx;
            translateY += dy;
            clampPan(scale);
            apply();
            event.preventDefault();
        }
    }

    function onPointerUp(event) {
        const lifted = pointers.get(event.pointerId);
        pointers.delete(event.pointerId);
        if (pointers.size < 2) {
            pinchStartDistance = 0;
        }
        if (pointers.size > 0 || !lifted) {
            return;
        }

        // Gesture over. It only counts as a tap if it was one finger, brief, and
        // still - a pinch or a pan is not half of a double-tap.
        const wasTap = !gesturePinched && !gestureMoved && (Date.now() - gestureStart) < DOUBLE_TAP_MS;
        if (!wasTap) {
            lastTapTime = 0;
            return;
        }

        const now = Date.now();
        const isDoubleTap = now - lastTapTime < DOUBLE_TAP_MS &&
            Math.hypot(lifted.x - lastTapX, lifted.y - lastTapY) < DOUBLE_TAP_SLOP_PX;
        if (isDoubleTap) {
            // Toggle between fit and a useful magnification, centred where they
            // tapped - quicker than pinching for a quick look.
            if (scale > 1.01) {
                reset();
            } else {
                zoomAbout(lifted.x, lifted.y, DOUBLE_TAP_SCALE);
            }
            lastTapTime = 0;
            return;
        }

        lastTapTime = now;
        lastTapX = lifted.x;
        lastTapY = lifted.y;
    }

    function onWheel(event) {
        if (!toggle.checked) {
            return;
        }
        event.preventDefault();
        // Trackpads report small deltas continuously; an exponential step keeps
        // the feel even across very different devices.
        zoomAbout(event.clientX, event.clientY, scale * Math.exp(-event.deltaY / 400));
    }

    image.addEventListener('pointerdown', onPointerDown);
    image.addEventListener('pointermove', onPointerMove);
    image.addEventListener('pointerup', onPointerUp);
    image.addEventListener('pointercancel', onPointerUp);
    image.addEventListener('wheel', onWheel, { passive: false });

    // Always open and close at fit, so the next look starts somewhere sensible
    // rather than wherever the last one was left.
    toggle.addEventListener('change', reset);

    // A freshly rendered preview is a different drawing; keep the old zoom off it.
    image.addEventListener('load', reset);

    reset();
}
