#!/usr/bin/env node
//
// Contract test: tools/mock_firmware.js vs the real firmware source.
//
//   node tools/mock_contract_test.js
//
// A mock is only useful while it still resembles what it stands in for. The
// failure mode worth guarding is silent drift - firmware gains a state field or
// an endpoint, the mock does not, and the UI is then exercised against a
// contract nobody ships. That drift is invisible until someone tests on real
// hardware, which is exactly what the mock exists to avoid.
//
// So this parses the firmware's own source for the four things the UI actually
// depends on, and fails if the mock does not cover them:
//
//   1. state document fields   PhaseManager::respondWithState
//   2. phase names             each Phase::getName()
//   3. HTTP endpoints          server.on(...) in src/main.cpp
//   4. progress event fields   Runner::buildProgressJson
//
// It intentionally checks coverage in one direction only: the mock may expose
// extra things (test affordances), but must never be missing something the
// firmware provides.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failures = 0;
function check(label, expected, actual) {
    const missing = expected.filter(e => !actual.includes(e));
    if (missing.length) {
        failures++;
        console.log(`FAIL  ${label}`);
        console.log(`        missing from the mock: ${missing.join(', ')}`);
    } else {
        console.log(`ok    ${label} (${expected.length} checked)`);
    }
}

const mockSrc = read('tools/mock_firmware.js');

// --- 1. State document fields ---------------------------------------------

const phaseManagerSrc = read('src/phases/phasemanager.cpp');
const respondBody = phaseManagerSrc.slice(phaseManagerSrc.indexOf('void PhaseManager::respondWithState'));
const stateFields = [...new Set(
    [...respondBody.matchAll(/root\["([A-Za-z0-9_]+)"\]/g)].map(m => m[1])
)];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Start the mock and read the state document it actually serves, rather than
// grepping its source - this checks what it really emits.
//
// Some firmware fields are conditional: resumeColorIndex/resumeColorName only
// appear while a resume offer is pending, and the retract statuses only during
// RetractBelts. So collect the UNION across the configurations that produce
// them; the requirement is that the mock CAN emit every field the firmware can,
// not that it emits all of them at once.
async function serveState(extraArgs, port) {
    const child = require('child_process').spawn(
        process.execPath, [path.join(ROOT, 'tools/mock_firmware.js'), `--port=${port}`, ...extraArgs],
        { stdio: 'ignore' }
    );
    try {
        for (let i = 0; i < 50; i++) {
            await sleep(100);
            try {
                const r = await fetch(`http://localhost:${port}/getState`);
                return await r.json();
            } catch { /* not up yet */ }
        }
        return null;
    } finally {
        child.kill();
    }
}

(async () => {
    const basePort = 8730 + (process.pid % 200);
    const configs = [
        { args: [], port: basePort },
        { args: ['--fault=resume'], port: basePort + 1 },
    ];

    const fields = new Set();
    for (const c of configs) {
        const served = await serveState(c.args, c.port);
        if (!served) {
            console.log(`FAIL  mock did not start (${c.args.join(' ') || 'default'})`);
            process.exit(1);
        }
        for (const k of Object.keys(served)) fields.add(k);
    }

    check('state fields (respondWithState)', stateFields, [...fields]);

    // --- 2. Phase names ---------------------------------------------------
    const phaseDir = path.join(ROOT, 'src', 'phases');
    const phaseNames = [];
    for (const f of fs.readdirSync(phaseDir).filter(f => f.endsWith('.cpp'))) {
        const src = fs.readFileSync(path.join(phaseDir, f), 'utf8');
        const m = src.match(/getName\(\)\s*\{\s*return\s+"([A-Za-z]+)"/);
        if (m) phaseNames.push(m[1]);
    }
    check('phase names', phaseNames, mockSrc);

    // --- 3. HTTP endpoints -------------------------------------------------
    const mainSrc = read('src/main.cpp');
    const endpoints = [...new Set(
        [...mainSrc.matchAll(/server\.on\(\s*\n?\s*"(\/[A-Za-z0-9_]*)"/g)].map(m => m[1])
    )];
    // /events is registered via addHandler(&events), not server.on.
    if (mainSrc.includes('addHandler(&events)')) endpoints.push('/events');
    check('HTTP endpoints', endpoints, mockSrc);

    // --- 4. Progress event fields ------------------------------------------
    const runnerSrc = read('src/runner.cpp');
    const progressBody = runnerSrc.slice(runnerSrc.indexOf('void Runner::buildProgressJson'));
    const progressEnd = progressBody.indexOf('\n}');
    const progressFields = [...new Set(
        [...progressBody.slice(0, progressEnd).matchAll(/root\["([A-Za-z0-9_]+)"\]/g)].map(m => m[1])
    )];
    check('progress event fields (buildProgressJson)', progressFields, mockSrc);

    if (failures) {
        console.log(`\n${failures} contract check(s) failed - update tools/mock_firmware.js to match the firmware.`);
        process.exit(1);
    }
    console.log('\nMock firmware contract OK.');
})();
