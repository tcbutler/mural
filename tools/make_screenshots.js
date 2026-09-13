#!/usr/bin/env node
/**
 * Screenshots of the real web UI, for the README.
 *
 * Drives headless Chrome over the DevTools protocol against the mock firmware,
 * so every picture is the actual interface in an actual state - not a mock-up,
 * and not a hand-arranged DOM. Each screen is reached the way a person reaches
 * it: the mock is started in the right phase, the image is uploaded, the render
 * is waited for.
 *
 * Chrome is driven directly rather than through Playwright/Puppeteer because
 * those pull a second browser download; Node 22 has a WebSocket client built in,
 * which is all the DevTools protocol needs.
 *
 *   node tools/make_screenshots.js            # all screens
 *   node tools/make_screenshots.js --only preview
 *   node tools/make_screenshots.js --keep     # leave Chrome and the mock running
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'images', 'screens');
const MOCK_PORT = 8123;
const CDP_PORT = 9222;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1180, height: 900 };
// A phone, to show the layout people actually use at the machine.
const PHONE = { width: 414, height: 860 };
const DEMO_IMAGE = 'images/style-examples/source.png';

function arg(name, fallback) {
    const idx = process.argv.indexOf(`--${name}`);
    return idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1].startsWith('--')
        ? process.argv[idx + 1] : fallback;
}
const only = arg('only', null);
const keep = process.argv.includes('--keep');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(label, check, timeoutMs = 120000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        if (await check()) return;
        await sleep(400);
    }
    throw new Error(`timed out waiting for ${label}`);
}

// --- DevTools protocol ------------------------------------------------------

class Tab {
    constructor(socket) {
        this.socket = socket;
        this.nextId = 1;
        this.pending = new Map();
        socket.addEventListener('message', event => {
            const message = JSON.parse(event.data);
            const resolve = this.pending.get(message.id);
            if (resolve) {
                this.pending.delete(message.id);
                resolve(message.result ?? {});
            }
        });
    }

    send(method, params = {}) {
        const id = this.nextId++;
        this.socket.send(JSON.stringify({ id, method, params }));
        return new Promise(resolve => this.pending.set(id, resolve));
    }

    /** Runs an async expression in the page and returns its value. */
    async evaluate(expression) {
        const result = await this.send('Runtime.evaluate', {
            expression: `(async () => { ${expression} })()`,
            awaitPromise: true,
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            throw new Error('page error: ' + JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails));
        }
        return result.result?.value;
    }

    async setViewport({ width, height }) {
        await this.send('Emulation.setDeviceMetricsOverride', {
            width, height, deviceScaleFactor: 2, mobile: width < 600,
        });
    }

    async screenshot(file, { fullElement } = {}) {
        let clip;
        if (fullElement) {
            const box = await this.evaluate(`
                const el = document.querySelector(${JSON.stringify(fullElement)});
                if (!el) return null;
                const r = el.getBoundingClientRect();
                return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
            `);
            if (box) clip = { ...box, scale: 2 };
        }
        const shot = await this.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: !!clip,
            ...(clip ? { clip } : {}),
        });
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(`  wrote ${path.relative(ROOT, file)}`);
    }
}

async function openTab(url) {
    const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const target = await response.json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
    });
    const tab = new Tab(socket);
    await tab.send('Page.enable');
    await tab.send('Runtime.enable');
    return { tab, targetId: target.id };
}

async function closeTab(targetId) {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/${targetId}`).catch(() => {});
}

// --- The screens ------------------------------------------------------------

/** Uploads the demo image through the real file input and waits for the render. */
const UPLOAD_AND_RENDER = `
    const blob = await (await fetch('/__demo.png', { cache: 'no-store' })).blob();
    const input = document.getElementById('uploadSvg');
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'demo.png', { type: 'image/png' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
`;

const SCREENS = [
    {
        name: 'choose-image',
        phase: 'SvgSelect',
        async run(tab) {
            await tab.evaluate(UPLOAD_AND_RENDER);
            await sleep(2500);
        },
    },
    {
        name: 'preview',
        phase: 'SvgSelect',
        async run(tab) {
            await tab.evaluate(UPLOAD_AND_RENDER);
            await sleep(2500);
            await tab.evaluate(`document.getElementById('preview').click(); return true;`);
            await sleep(1200);
            await waitFor('render', async () =>
                tab.evaluate(`return !document.getElementById('acceptSvg').hasAttribute('disabled');`));
        },
    },
    {
        name: 'preview-overlay',
        phase: 'SvgSelect',
        async run(tab) {
            await tab.evaluate(UPLOAD_AND_RENDER);
            await sleep(2500);
            await tab.evaluate(`document.getElementById('preview').click(); return true;`);
            await sleep(1200);
            await waitFor('render', async () =>
                tab.evaluate(`return !document.getElementById('acceptSvg').hasAttribute('disabled');`));
            await tab.evaluate(`
                const t = document.getElementById('overlayOriginalToggle');
                t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
                document.getElementById('previewFrame').scrollIntoView({ block: 'center' });
                return true;
            `);
            await sleep(700);
        },
        clip: '.preview-box',
    },
    { name: 'retract-belts', phase: 'RetractBelts', viewport: PHONE },
    { name: 'pen-calibration', phase: 'PenCalibration', viewport: PHONE },
    // A short plot so the progress bar is part-way through: a screenshot of 0%
    // says nothing about what the screen does.
    // The mock only begins a plot when the UI asks it to (POST /run), so landing
    // on the Drawing phase alone shows a stationary 0%. Kick it off the way the
    // interface does, then let it get far enough in to be worth a picture.
    {
        name: 'drawing',
        phase: 'Drawing',
        viewport: PHONE,
        plotSeconds: 60,
        async run(tab) {
            await tab.evaluate(`await fetch('/run', { method: 'POST' }); return true;`);
            await sleep(20000);
        },
    },
];

// --- Runner -----------------------------------------------------------------

function startMock(phase, plotSeconds = 600) {
    const mock = spawn('node', [path.join('tools', 'mock_firmware.js'), `--phase=${phase}`, `--port=${MOCK_PORT}`, `--plotSeconds=${plotSeconds}`],
        { cwd: ROOT, stdio: 'ignore' });
    return mock;
}

async function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.copyFileSync(path.join(ROOT, DEMO_IMAGE), path.join(ROOT, 'data', 'www', '__demo.png'));

    const chrome = spawn(CHROME, [
        '--headless=new',
        `--remote-debugging-port=${CDP_PORT}`,
        '--hide-scrollbars',
        '--force-device-scale-factor=2',
        '--no-first-run',
        '--user-data-dir=' + path.join(ROOT, '.pio', 'chrome-profile'),
        'about:blank',
    ], { stdio: 'ignore' });

    await waitFor('chrome', async () => {
        try { await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); return true; } catch { return false; }
    }, 20000);

    try {
        for (const screen of SCREENS) {
            if (only && screen.name !== only) continue;
            console.log(`${screen.name} (phase ${screen.phase})`);

            const mock = startMock(screen.phase, screen.plotSeconds);
            await waitFor('mock', async () => {
                try { await fetch(`http://127.0.0.1:${MOCK_PORT}/getState`); return true; } catch { return false; }
            }, 15000);

            const { tab, targetId } = await openTab(`http://127.0.0.1:${MOCK_PORT}/`);
            try {
                await tab.setViewport(screen.viewport || VIEWPORT);
                await sleep(1500);
                if (screen.run) await screen.run(tab);
                await tab.screenshot(path.join(OUT_DIR, `${screen.name}.png`), { fullElement: screen.clip });
            } finally {
                await closeTab(targetId);
                mock.kill();
                await sleep(400);
            }
        }
    } finally {
        fs.rmSync(path.join(ROOT, 'data', 'www', '__demo.png'), { force: true });
        if (!keep) chrome.kill();
    }
}

main().catch(err => { console.error(err); process.exit(1); });
