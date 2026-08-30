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

let commandsFile = null;   // Buffer of the uploaded command file
let plot = null;           // active simulated plot, see startPlot()
const sseClients = new Set();

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
    if (p === '/getState') return json(res, state);

    if (p === '/getPhysicsConstants') {
        return json(res, { diameter: 12.69, homeOffsetMM: 100, massBot: 0.5, beltElong: 0.0001 });
    }
    if (p === '/setPhysicsConstants') return json(res, state);

    // --- Setup phases -----------------------------------------------------
    if (p === '/setTopDistance') {
        const v = parseInt(firstParam(url, body), 10);
        if (Number.isFinite(v)) {
            state.topDistance = v;
            state.storedTopDistance = v;
            state.safeWidth = Math.round(v * 0.6);
        }
        setPhase('SvgSelect');
        return json(res, state);
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
        else if (state.phase === 'ExtendToHome') {
            setPhase(state.storedPenAngle >= 0 ? 'BeginDrawing' : 'PenCalibration');
        }
        return json(res, state);
    }

    if (p === '/extendToHome') { state.moving = false; return json(res, state); }

    if (p === '/setServo') return ok(res);

    if (p === '/setPenDistance') {
        const v = parseInt(firstParam(url, body), 10);
        if (Number.isFinite(v)) state.storedPenAngle = v;
        setPhase('BeginDrawing');
        return json(res, state);
    }

    if (p === '/estepsCalibration' || p === '/estepsCalibrationApply') return json(res, state);

    if (p === '/installTestPattern') {
        commandsFile = Buffer.from('d1000\nM400 300\nD\nM100 100\nU\n', 'utf8');
        state.uploadCrc32 = crc32(commandsFile);
        setPhase('RetractBelts');
        return json(res, state);
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
        return json(res, state);
    }

    if (p === '/downloadCommands') {
        if (!commandsFile) { res.writeHead(404); return res.end('no commands'); }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end(commandsFile);
    }

    // --- Drawing ----------------------------------------------------------
    if (p === '/run') { startPlot(); return json(res, state); }

    if (p === '/pauseDrawing') {
        if (plot) { plot.paused = true; broadcast('progress', progressPayload()); }
        return json(res, state);
    }
    if (p === '/resumeDrawing') {
        if (plot) { plot.paused = false; plot.stalled = false; broadcast('progress', progressPayload()); }
        return json(res, state);
    }
    if (p === '/confirmPenSwap') {
        if (plot) { plot.awaitingSwap = false; broadcast('progress', progressPayload()); }
        return json(res, state);
    }
    if (p === '/resume' || p === '/confirmResume') {
        state.resuming = false;
        state.resumePercent = -1;
        setPhase('RetractBelts');
        return json(res, state);
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

server.listen(PORT, () => {
    console.log(`mock firmware on http://localhost:${PORT}`);
    console.log(`  phase: ${state.phase}   plot: ${PLOT_SECONDS}s`);
    if (FAULTS.size) console.log(`  faults: ${[...FAULTS].join(', ')}`);
    else console.log(`  faults: none (--fault=${Object.keys(KNOWN_FAULTS).join('|')})`);
});
