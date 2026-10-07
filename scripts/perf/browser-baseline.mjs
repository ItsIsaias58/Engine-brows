import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createMarketServer } from '../../services/market/server.mjs';

const EXE = process.env.LYRA_CHROMIUM || '/home/isaias/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const GAME = '/owngames/bolsa-trading-floor/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-bench-'));
const instance = createMarketServer({ port: 4311, dataDir: tmp, tickMs: 1000, autoEvents: false });
const BASE = `http://127.0.0.1:${instance.port}`;

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows'],
});

const INIT = () => {
  window.__perf = { longTasks: [], frames: 0, first: 0, last: 0, clicks: [], bootStart: performance.now() };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__perf.longTasks.push(Math.round(e.duration));
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  (function loop() {
    if (!window.__perf.first) window.__perf.first = performance.now();
    window.__perf.frames++;
    window.__perf.last = performance.now();
    requestAnimationFrame(loop);
  })();
  window.addEventListener('pointerdown', (e) => {
    const t = performance.now();
    requestAnimationFrame(() => {
      const t2 = performance.now();
      window.__perf.clicks.push({ target: (e.target && e.target.className) ? String(e.target.className).slice(0, 40) : e.target?.id || '?', ms: Math.round(t2 - t) });
    });
  }, true);
};

async function scenario(name, { throttle, clicks, seconds }) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  await page.addInitScript(INIT);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const net = { wsBytes: 0, wsFrames: 0, byType: {}, httpBytes: 0, reqs: {} };
  cdp.on('Network.webSocketFrameReceived', (e) => { net.wsFrames++; net.wsBytes += (e.response?.payloadData || '').length; });
  const reqType = new Map();
  const urls = new Map();
  cdp.on('Network.responseReceived', (e) => { reqType.set(e.requestId, e.type); urls.set(e.requestId, e.response?.url || ''); });
  cdp.on('Network.loadingFinished', (e) => {
    const t = reqType.get(e.requestId) || 'Other';
    net.byType[t] = (net.byType[t] || 0) + (e.encodedDataLength || 0);
    net.httpBytes += (e.encodedDataLength || 0);
    const u = urls.get(e.requestId);
    if (u) { const k = u.replace(BASE, ''); net.reqs[k] = (net.reqs[k] || 0) + (e.encodedDataLength || 0); }
  });
  if (throttle) {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: throttle.rtt,
      downloadThroughput: throttle.down, uploadThroughput: throttle.up,
    });
  }

  const t0 = Date.now();
  await page.goto(BASE + GAME, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const dcl = Date.now() - t0;
  let bootMs = null;
  try {
    await page.waitForFunction(() => {
      const o = document.getElementById('bootOverlay');
      return !o || o.classList.contains('is-done') || !document.body.contains(o);
    }, null, { timeout: 30000 });
    bootMs = Date.now() - t0;
  } catch { bootMs = -1; }
  const bootCounts = await page.evaluate(() => (window.Boot ? window.Boot.counts() : null)).catch(() => null);

  // reset collectors after boot so gameplay metrics are clean
  await page.evaluate(() => { window.__perf.longTasks = []; window.__perf.frames = 0; window.__perf.first = 0; window.__perf.clicks = []; });

  if (clicks) {
    const rows = await page.$$('.market-row');
    for (let i = 0; i < clicks; i++) {
      const row = rows[i % rows.length];
      if (row) {
        try {
          const box = await row.boundingBox();
          if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } catch (e) { console.log('click err', String(e).slice(0, 80)); }
      }
      await sleep(40);
    }
  }
  await sleep(seconds * 1000);

  const perf = await page.evaluate(() => ({
    longTasks: window.__perf.longTasks.length,
    longMax: window.__perf.longTasks.length ? Math.max(...window.__perf.longTasks) : 0,
    longTotal: window.__perf.longTasks.reduce((a, b) => a + b, 0),
    frames: window.__perf.frames,
    span: window.__perf.last - window.__perf.first,
    clicks: window.__perf.clicks,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
  }));
  const fps = perf.span > 0 ? +(perf.frames / (perf.span / 1000)).toFixed(1) : 0;
  const clickMs = perf.clicks.map((c) => c.ms).sort((a, b) => a - b);
  const result = {
    scenario: name,
    dclMs: dcl, bootMs, bootBytes: bootCounts?.bytes ?? null,
    longTasks: perf.longTasks, longMaxMs: perf.longMax, longTotalMs: perf.longTotal,
    fps,
    clickCount: clickMs.length,
    clickP50: clickMs.length ? clickMs[Math.floor(clickMs.length * 0.5)] : null,
    clickP95: clickMs.length ? clickMs[Math.floor(clickMs.length * 0.95)] : null,
    heapMB: perf.heapMB,
    httpKiB: Math.round(net.httpBytes / 1024),
    wsKiB: +(net.wsBytes / 1024).toFixed(1),
    wsFrames: net.wsFrames,
    byTypeKiB: Object.fromEntries(Object.entries(net.byType).map(([k, v]) => [k, Math.round(v / 1024)])),
    topUrls: Object.entries(net.reqs).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([u, b]) => `${Math.round(b / 1024)}K ${u}`),
  };
  await context.close();
  return result;
}

const out = [];
out.push(await scenario('normal · 40 clics + 10s', { seconds: 10, clicks: 40 }));
// Chrome throttling 1.5 Mbps down / 750 Kbps up / 150ms RTT
const TH = { down: Math.round(1.5 * 1024 * 1024 / 8), up: Math.round(750 * 1024 / 8), rtt: 150 };
out.push(await scenario('throttled 1.5Mbps · 40 clics + 10s', { throttle: TH, seconds: 10, clicks: 40 }));
out.push(await scenario('throttled 1.5Mbps · 10s idle', { throttle: TH, seconds: 10 }));

console.log(JSON.stringify(out, null, 2));

await browser.close();
instance.stop();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
