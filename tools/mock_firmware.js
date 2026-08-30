#!/usr/bin/env node
//
// Mock firmware harness: runs the whole web UI with no machine attached.
//
//   node tools/mock_firmware.js                 # start at the beginning
//   node tools/mock_firmware.js --phase=Drawing # jump straight to a screen
//   node tools/mock_firmware.js --fault=stall   # inject a failure
//
// It serves data/www and emulates the firmware's HTTP surface and phase state
// machine closely enough that every UI flow is reachable without hardware:
// endpoints from src/main.cpp, the state document from
// PhaseManager::respondWithState, the phase transitions from src/phases/*, and
// the SSE progress events from Runner::buildProgressJson.
//
// Deliberately NOT a simulator of the machine's physics - it models the
// *contract the UI depends on*. Belt lengths, kinematics and real timing live in
// the firmware and its own host tests; duplicating them here would create a
// second implementation to keep honest for no extra UI coverage.
//
// tools/mock_contract_test.js checks this file against the firmware source so
// the two cannot silently drift apart.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'data', 'www');

// --- CLI ------------------------------------------------------------------

const argv = process.argv.slice(2);
function arg(name, fallback) {
    const hit = argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
}

const PORT = parseInt(arg('port', '8099'), 10);
const START_PHASE = arg('phase', 'SetTopDistance');
// Wall-clock seconds a simulated plot takes end to end, so a full drawing flow
// is exercisable in the time it takes to click through it.
const PLOT_SECONDS = parseFloat(arg('plotSeconds', '20'));
const FAULTS = new Set(arg('fault', '').split(',').filter(Boolean));
// Seconds the device is unreachable after a plot, matching the measured
// boot-to-"Server started" time on real hardware.
const REBOOT_SECONDS = parseFloat(arg('rebootSeconds', '7.5'));

const KNOWN_FAULTS = {
    'crc-mismatch': 'upload verification fails (firmware reports a different CRC32)',
    'stall': 'the plot stalls partway through (MURAL_TMC_UART builds)',
    'pen-swap': 'multi-colour plot that pauses for a pen swap',
    'resume': 'boot with a saved checkpoint, offering resume-after-power-loss',
    'sse-drop': 'the /events stream dies mid-plot without closing cleanly',
    'upload-fail': 'the command upload returns HTTP 500',
    'retract-stuck': 'belts never report themselves retracted',
    'no-pen-cal': 'no stored pen angle, so pen calibration is required',
};

for (const f of FAULTS) {
    if (!(f in KNOWN_FAULTS)) {
        console.error(`Unknown fault "${f}". Available:`);
        for (const [k, v] of Object.entries(KNOWN_FAULTS)) console.error(`  ${k.padEnd(14)} ${v}`);
        process.exit(2);
    }
}

// --- CRC32 (must match data/www/crc32.js and src/crc32.cpp) ---------------

const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = (crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// --- State ----------------------------------------------------------------

// Mirrors PhaseManager::respondWithState. Field names and types are asserted
// against the firmware by tools/mock_contract_test.js.
const state = {
    phase: START_PHASE,
    moving: false,
    topDistance: 1000,
    safeWidth: 600,              // firmware: 60% of pin distance
    homeX: 500,
    homeY: 400,
    storedTopDistance: 1000,
    storedPenAngle: FAULTS.has('no-pen-cal') ? -1 : 30,
    uploadCrc32: 0,
    resuming: FAULTS.has('resume'),
    resumePercent: FAULTS.has('resume') ? 42 : -1,
    autoRetract: FAULTS.has('retract-stuck') ? true : false,
    leftRetract: 'idle',
    rightRetract: 'idle',
};
if (FAULTS.has('resume')) {
    state.phase = 'ResumeDrawing';
    state.resumeColorIndex = 1;
    state.resumeColorName = 'black';
}

// Phases from RetractBelts onward only exist because a command file was
// selected, so starting at one has to imply that file, or the mock contradicts
// itself (a "ready to draw" screen with nothing to draw).
const PHASES_IMPLYING_COMMANDS = ['RetractBelts', 'ExtendToHome', 'PenCalibration', 'BeginDrawing', 'Drawing', 'ResumeDrawing'];
let commandsFile = PHASES_IMPLYING_COMMANDS.includes(START_PHASE)
    ? Buffer.from('d1000\nh600\np0\n150 150\np1\n450 150\n450 450\np0\n', 'utf8')
    : null;
let rebootingUntil = 0;    // while > now, the device refuses connections

// Calibrated pen-holder geometry (Pen::loadLimits). Defaults match the
// firmware's, i.e. an uncalibrated machine.
let penLimits = { lowestLocked: 0, highestLocked: 90, unlocked: 90 };
let penAngle = 90;
let plot = null;           // active simulated plot, see startPlot()
const sseClients = new Set();

// PhaseManager::respondWithState reports hasCommands from LittleFS.exists(),
// so derive it here too rather than keeping a flag that could disagree with
// whether a command file is actually present.
function stateDocument() {
    return {
        ...state,
        hasCommands: commandsFile !== null,
        penLowestLocked: penLimits.lowestLocked,
        penHighestLocked: penLimits.highestLocked,
        penUnlocked: penLimits.unlocked,
    };
}

function setPhase(next) {
    if (state.phase !== next) console.log(`  phase: ${state.phase} -> ${next}`);
    state.phase = next;
}

// --- Simulated plot -------------------------------------------------------

function parseTotals(buf) {
    // Command files start with a `d<distance>` header then one command per line
    // (see Runner::parseCommandFileHeader).
    const text = buf ? buf.toString('utf8') : '';
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    const header = lines.find(l => l.startsWith('d'));
    const distance = header ? parseFloat(header.slice(1)) : 0;
    const commands = lines.filter(l => !/^[dtn]/.test(l));
    return { totalLines: Math.max(commands.length, 1), totalDistance: distance };
}

function broadcast(event, payload) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
        try { res.write(frame); } catch { /* client went away */ }
    }
}

function progressPayload(overrideState) {
    // Mirrors Runner::buildProgressJson.
    const p = {
        state: overrideState || plotStateName(),
        percent: plot ? plot.percent : 0,
        executedLines: plot ? plot.executedLines : 0,
        totalLines: plot ? plot.totalLines : 0,
        x: plot ? Math.round(plot.x) : 0,
        y: plot ? Math.round(plot.y) : 0,
    };
    if (plot && plot.awaitingSwap) {
        p.penSwapIndex = plot.swapIndex;
        p.penSwapName = plot.swapName;
    }
    return p;
}

function plotStateName() {
    // Mirrors Runner::getStateName().
    if (!plot) return 'finished';
    if (plot.stopped) return 'finished';
    if (plot.stalled) return 'stalled';
    if (plot.paused) return 'paused';
    if (plot.awaitingSwap) return 'penSwap';
    if (plot.executedLines === 0) return 'started';
    return 'running';
}

function startPlot() {
    const { totalLines, totalDistance } = parseTotals(commandsFile);
    const tickMs = 200;
    const ticks = Math.max(1, Math.round((PLOT_SECONDS * 1000) / tickMs));

    plot = {
        totalLines, totalDistance,
        executedLines: 0, percent: 0, x: 0, y: 0,
        paused: false, stalled: false, stopped: false,
        awaitingSwap: false, swapIndex: 0, swapName: '',
        tick: 0, ticks,
    };
    setPhase('Drawing');

    plot.timer = setInterval(() => {
        if (!plot || plot.paused || plot.stalled || plot.awaitingSwap) return;

        plot.tick++;
        const frac = Math.min(1, plot.tick / plot.ticks);
        plot.executedLines = Math.round(frac * plot.totalLines);
        plot.percent = Math.floor(frac * 100);
        plot.x = 100 + Math.sin(plot.tick / 5) * 200;
        plot.y = frac * 300;

        // Fault: stall at 40%.
        if (FAULTS.has('stall') && plot.percent >= 40 && !plot.stalledOnce) {
            plot.stalled = true; plot.stalledOnce = true;
            console.log('  fault: stalled at 40%');
            broadcast('progress', progressPayload());
            return;
        }
        // Fault: pen swap at 50%.
        if (FAULTS.has('pen-swap') && plot.percent >= 50 && !plot.swappedOnce) {
            plot.awaitingSwap = true; plot.swappedOnce = true;
            plot.swapIndex = 2; plot.swapName = 'red';
            console.log('  fault: awaiting pen swap at 50%');
            broadcast('progress', progressPayload());
            return;
        }
        // Fault: kill the event stream mid-plot without closing it.
        if (FAULTS.has('sse-drop') && plot.percent >= 30 && !plot.droppedOnce) {
            plot.droppedOnce = true;
            console.log('  fault: dropping SSE clients');
            for (const res of sseClients) { try { res.destroy(); } catch {} }
            sseClients.clear();
        }

        if (frac >= 1) {
            plot.stopped = true;
            clearInterval(plot.timer);
            console.log('  plot finished');
            broadcast('progress', progressPayload());
            // The firmware clears its checkpoint, pushes this final event and
            // then calls ESP.restart() (Runner::getNextTask). Boot to "Server
            // started" measured ~7.5s on real hardware, mostly WiFi. Model both
            // the reboot and the outage, because the UI's behaviour on finish is
            // entirely about surviving them.
            console.log(`  restarting (unreachable for ${REBOOT_SECONDS}s)`);
            // The firmware sends the final event, waits 200ms, THEN restarts -
            // that delay is load-bearing, and dropping the sockets immediately
            // here swallowed the "finished" event before it flushed.
            setTimeout(() => {
                rebootingUntil = Date.now() + REBOOT_SECONDS * 1000;
                for (const res of sseClients) { try { res.destroy(); } catch {} }
                sseClients.clear();
            }, 200);
            setTimeout(() => {
                plot = null;   // commandsFile survives, as LittleFS would
                setPhase('SetTopDistance');
                console.log('  back up');
            }, (REBOOT_SECONDS + 0.2) * 1000);
            return;
        }
        broadcast('progress', progressPayload());
    }, tickMs);
}

// --- HTTP helpers ---------------------------------------------------------

function readBody(req) {
    return new Promise(resolve => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

// The firmware reads request->getParam(0) without caring whether a value came
// from the query string or a form body, so accept either.
function firstParam(url, body) {
    const q = [...url.searchParams.values()];
    if (q.length) return q[0];
    const text = body.toString('utf8');
    const first = text.split('&')[0] || '';
    const eq = first.indexOf('=');
    return eq === -1 ? '' : decodeURIComponent(first.slice(eq + 1).replace(/\+/g, ' '));
}

function extractMultipartFile(body) {
    // Good enough for a mock: take everything between the first blank line
    // after the part headers and the trailing boundary.
    const text = body.toString('binary');
    const headerEnd = text.indexOf('\r\n\r\n');
    if (headerEnd === -1) return body;
    const boundaryEnd = text.lastIndexOf('\r\n--');
    if (boundaryEnd <= headerEnd) return body;
    return Buffer.from(text.slice(headerEnd + 4, boundaryEnd), 'binary');
}

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.less': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.ico': 'image/x-icon',
};

function json(res, obj) {
    const payload = JSON.stringify(obj);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
}
function ok(res, text = 'OK') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(text);
}

// --- Routes ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;
    const body = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);

    // While rebooting, drop the connection outright rather than erroring - a
    // device that is off does not answer, and the UI has to cope with that.
    if (Date.now() < rebootingUntil) {
        return req.socket.destroy();
    }

    if (req.method === 'POST') console.log(`POST ${p}`);

    // --- Server-sent events (Runner::pushProgressEvent) -------------------
    if (p === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    // --- State ------------------------------------------------------------
    if (p === '/getState') return json(res, stateDocument());

    if (p === '/getPhysicsConstants') {
        return json(res, { diameter: 12.69, homeOffsetMM: 100, massBot: 0.5, beltElong: 0.0001 });
    }
    if (p === '/setPhysicsConstants') return json(res, stateDocument());

    // --- Setup phases -----------------------------------------------------
    if (p === '/setTopDistance') {
        const v = parseInt(firstParam(url, body), 10);
        if (Number.isFinite(v)) {
            state.topDistance = v;
            state.storedTopDistance = v;
            state.safeWidth = Math.round(v * 0.6);
        }
        setPhase('SvgSelect');
        return json(res, stateDocument());
    }

    if (p === '/command') {
        // Belt jog commands from the retract screen (client.js).
        const cmd = firstParam(url, body);
        if (!FAULTS.has('retract-stuck')) {
            if (cmd.startsWith('l-')) state.leftRetract = cmd === 'l-0' ? 'retracted' : 'retracting';
            if (cmd.startsWith('r-')) state.rightRetract = cmd === 'r-0' ? 'retracted' : 'retracting';
            if (cmd === 'auto-retract') { state.leftRetract = 'retracted'; state.rightRetract = 'retracted'; }
        }
        return ok(res);
    }

    if (p === '/doneWithPhase') {
        if (state.phase === 'RetractBelts') setPhase('ExtendToHome');
        return json(res, stateDocument());
    }

    if (p === '/extendToHome') {
        // ExtendToHomePhase::extendToHome replies with the estimated move time in
        // SECONDS as plain text - not a state document - and the phase only
        // advances later, from loopPhase(), once the move actually finishes. The
        // UI leans on exactly that: it disables the button, waits the reported
        // time, then polls /getState until the phase changes
        // (checkIfExtendedToHome in main.js). Returning JSON here instead left
        // the UI polling a phase that never changed, with every control
        // disabled - a dead end that is a mock artefact, not a UI bug.
        const moveSeconds = 1;
        state.moving = true;
        setTimeout(() => {
            state.moving = false;
            if (state.resuming) {
                setPhase('Drawing');
                startPlot();
            } else {
                setPhase('PenCalibration');
            }
        }, (moveSeconds + 0.2) * 1000);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(String(moveSeconds));
    }

    if (p === '/setServo') return ok(res);

    // --- Pen holder calibration -------------------------------------------
    // Mirrors the free-function handlers in src/main.cpp, including the 409 the
    // firmware returns while drawing - the UI has to cope with that.
    const penBusy = () => state.phase === 'Drawing';

    if (p === '/getPenLimits') {
        return json(res, { ...penLimits, current: state.storedPenAngle });
    }

    if (p === '/penJog') {
        if (penBusy()) { res.writeHead(409, {'Content-Type':'text/plain'}); return res.end("Busy - can't move the pen while drawing"); }
        const angle = parseInt(firstParam(url, body), 10);
        if (!Number.isFinite(angle) || angle < 0 || angle > 180) {
            res.writeHead(400, {'Content-Type':'text/plain'}); return res.end('Angle must be 0-180');
        }
        penAngle = angle;
        return ok(res);
    }

    if (p === '/setPenLimits') {
        if (penBusy()) { res.writeHead(409, {'Content-Type':'text/plain'}); return res.end("Busy - can't move the pen while drawing"); }
        const q = new URLSearchParams(body.toString('utf8'));
        const lowest = parseInt(q.get('lowestLocked'), 10);
        const highest = parseInt(q.get('highestLocked'), 10);
        const unlocked = parseInt(q.get('unlocked'), 10);
        // Pen::limitsAreValid
        const valid = [lowest, highest, unlocked].every(Number.isFinite) &&
            lowest >= 0 && lowest < highest && highest <= unlocked && unlocked <= 180;
        if (!valid) {
            res.writeHead(400, {'Content-Type':'text/plain'});
            return res.end('Invalid limits - need 0 <= lowest < highest <= unlocked <= 180');
        }
        penLimits = { lowestLocked: lowest, highestLocked: highest, unlocked };
        // Pen::setLimits pulls a stale contact point back into the new range.
        if (state.storedPenAngle >= 0) {
            state.storedPenAngle = Math.max(lowest, Math.min(highest, state.storedPenAngle));
        }
        penAngle = highest;
        console.log(`  pen limits set: ${lowest}/${highest}/${unlocked}`);
        return json(res, { ...penLimits, current: state.storedPenAngle });
    }

    if (p === '/unlockPen') {
        if (penBusy()) { res.writeHead(409, {'Content-Type':'text/plain'}); return res.end("Busy - can't move the pen while drawing"); }
        penAngle = penLimits.unlocked;
        return ok(res);
    }

    if (p === '/setPenDistance') {
        const v = parseInt(firstParam(url, body), 10);
        if (Number.isFinite(v)) state.storedPenAngle = v;
        setPhase('BeginDrawing');
        return json(res, stateDocument());
    }

    if (p === '/estepsCalibration' || p === '/estepsCalibrationApply') return json(res, stateDocument());

    if (p === '/installTestPattern') {
        commandsFile = Buffer.from('d1000\nM400 300\nD\nM100 100\nU\n', 'utf8');
        state.uploadCrc32 = crc32(commandsFile);
        setPhase('RetractBelts');
        return json(res, stateDocument());
    }

    // --- Command file -----------------------------------------------------
    if (p === '/uploadCommands') {
        if (FAULTS.has('upload-fail')) {
            console.log('  fault: upload returns 500');
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end('upload failed');
        }
        commandsFile = extractMultipartFile(body);
        state.uploadCrc32 = crc32(commandsFile);
                if (FAULTS.has('crc-mismatch')) {
            console.log('  fault: reporting a wrong CRC32');
            state.uploadCrc32 = (state.uploadCrc32 ^ 0xFFFF) >>> 0;
        }
        setPhase('RetractBelts');
        return json(res, stateDocument());
    }

    if (p === '/useStoredCommands') {
        // SvgSelectPhase::useStoredCommands - re-plot the file already on the
        // device. Still routes through RetractBelts, because the belts have to be
        // re-homed after the restart that follows every plot.
        if (!commandsFile) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end('No command file stored');
        }
        setPhase('RetractBelts');
        return json(res, stateDocument());
    }

    if (p === '/downloadCommands') {
        if (!commandsFile) { res.writeHead(404); return res.end('no commands'); }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(commandsFile);
    }

    // --- Drawing ----------------------------------------------------------
    if (p === '/run') { startPlot(); return json(res, stateDocument()); }

    if (p === '/pauseDrawing') {
        if (plot) { plot.paused = true; broadcast('progress', progressPayload()); }
        return json(res, stateDocument());
    }
    if (p === '/resumeDrawing') {
        if (plot) { plot.paused = false; plot.stalled = false; broadcast('progress', progressPayload()); }
        return json(res, stateDocument());
    }
    if (p === '/confirmPenSwap') {
        if (plot) { plot.awaitingSwap = false; broadcast('progress', progressPayload()); }
        return json(res, stateDocument());
    }
    if (p === '/resume' || p === '/confirmResume') {
        state.resuming = false;
        state.resumePercent = -1;
        setPhase('RetractBelts');
        return json(res, stateDocument());
    }

    // --- Static files -----------------------------------------------------
    const rel = p === '/' ? 'index.html' : p.replace(/^\//, '');
    const file = path.join(WWW, rel);
    if (!file.startsWith(WWW)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            return res.end(`not found: ${rel}`);
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
    });
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use - another mock is probably still running.`);
        console.error(`  lsof -ti :${PORT} | xargs kill      # stop it`);
        console.error(`  node tools/mock_firmware.js --port=${PORT + 1}   # or use another port`);
        process.exit(1);
    }
    throw err;
});

server.listen(PORT, () => {
    console.log(`mock firmware on http://localhost:${PORT}`);
    console.log(`  phase: ${state.phase}   plot: ${PLOT_SECONDS}s`);
    if (FAULTS.size) console.log(`  faults: ${[...FAULTS].join(', ')}`);
    else console.log(`  faults: none (--fault=${Object.keys(KNOWN_FAULTS).join('|')})`);
});
