import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createMarketServer } from '../../services/market/server.mjs';

const EXE = process.env.LYRA_CHROMIUM || '/home/isaias/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-bench-'));
const instance = createMarketServer({ port: 4314, dataDir: tmp, tickMs: 1000, autoEvents: false });
const BASE = `http://127.0.0.1:${instance.port}`;
const out = {};

// ---- ETag / 304 del servidor (fetch directo) ----
{
  const url = BASE + '/owngames/bolsa-trading-floor/js/util.js';
  const first = await fetch(url);
  const etag = first.headers.get('etag');
  await first.arrayBuffer();
  const second = await fetch(url, { headers: { 'If-None-Match': etag || '' } });
  out.etag = { present: Boolean(etag), etag, secondStatus: second.status };
}

// ---- SW: precache + segunda carga sin red para estaticos ----
const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

// primera visita: deja que el SW instale y precachee
await page.goto(BASE + '/owngames/bolsa-trading-floor/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
await page.evaluate(async () => { if (navigator.serviceWorker.ready) await navigator.serviceWorker.ready; }).catch(() => {});
await sleep(4000);
out.cacheEntries = await page.evaluate(async () => {
  const keys = await caches.keys();
  let total = 0;
  const names = [];
  for (const k of keys) { const c = await caches.open(k); const r = await c.keys(); total += r.length; names.push(`${k}:${r.length}`); }
  return { keys, total, names };
});

// segunda visita: cuenta peticiones de js/css que llegan DE VERDAD a la red
// (a nivel CDP, no el evento de la pagina: lo servido por el SW no toca red)
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
const seen = { total: 0, fromSW: 0, fromDisk: 0, realNetwork: [] };
cdp.on('Network.responseReceived', (e) => {
  const u = e.response.url || '';
  if (!/\.(js|css)(\?|$)/.test(u)) return;
  seen.total++;
  if (e.response.fromServiceWorker) seen.fromSW++;
  else if (e.response.fromDiskCache) seen.fromDisk++;
  else seen.realNetwork.push(u.replace(BASE, ''));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(3500);
out.secondLoad = {
  jsCssTotal: seen.total,
  servedFromServiceWorker: seen.fromSW,
  servedFromDiskCache: seen.fromDisk,
  realNetworkRequests: seen.realNetwork.length,
  sample: seen.realNetwork.slice(0, 8),
};
out.errors = errors;

console.log(JSON.stringify(out, null, 2));
await browser.close();
instance.stop();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
