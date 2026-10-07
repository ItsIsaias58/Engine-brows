import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createMarketServer } from '../../services/market/server.mjs';

const EXE = process.env.LYRA_CHROMIUM || '/home/isaias/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-bench-'));
const instance = createMarketServer({ port: 4312, dataDir: tmp, tickMs: 1000, autoEvents: false });
const BASE = `http://127.0.0.1:${instance.port}`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
const TH = { down: Math.round(1.5 * 1024 * 1024 / 8), up: Math.round(750 * 1024 / 8), rtt: 150 };
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: TH.rtt, downloadThroughput: TH.down, uploadThroughput: TH.up });

await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await page.goto(BASE + '/owngames/bolsa-trading-floor/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => { const o = document.getElementById('bootOverlay'); return !o || o.classList.contains('is-done') || !document.body.contains(o); }, null, { timeout: 30000 }).catch(() => {});
await sleep(1500);

await cdp.send('Profiler.start');
// actividad: 40 clics en filas + abrir/cerrar un par de ventanas
const rows = await page.$$('.market-row');
for (let i = 0; i < 40; i++) {
  const row = rows[i % rows.length];
  if (row) { try { const b = await row.boundingBox(); if (b) await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); } catch {} }
  await sleep(35);
}
await sleep(6000);
const { profile } = await cdp.send('Profiler.stop');

// agrega tiempo propio por (functionName @ url)
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const node = byId.get(profile.samples[i]);
  if (!node) continue;
  const cf = node.callFrame || {};
  const url = (cf.url || '').replace(BASE, '');
  const key = `${cf.functionName || '(anon)'} @ ${url.split('/').pop() || url}`;
  const dt = profile.timeDeltas[i] || 0;
  self.set(key, (self.get(key) || 0) + dt);
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  .map(([k, us]) => ({ fn: k, ms: +(us / 1000).toFixed(1), pct: +((us / total) * 100).toFixed(1) }));
console.log('total sample ms=', (total / 1000).toFixed(1));
console.log(JSON.stringify(top, null, 2));

await browser.close();
instance.stop();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
