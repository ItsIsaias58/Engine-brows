import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createMarketServer } from '../../services/market/server.mjs';

const EXE = process.env.LYRA_CHROMIUM || '/home/isaias/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-bench-'));
const instance = createMarketServer({ port: 4315, dataDir: tmp, tickMs: 1000, autoEvents: false });
const BASE = `http://127.0.0.1:${instance.port}`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(BASE + '/owngames/csgo-opencase/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
await page.evaluate(async () => { if (navigator.serviceWorker.ready) await navigator.serviceWorker.ready; }).catch(() => {});
await sleep(3500);
const cachesInfo = await page.evaluate(async () => {
  const keys = await caches.keys();
  let total = 0;
  for (const k of keys) { const c = await caches.open(k); total += (await c.keys()).length; }
  return { keys, total };
});
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
const seen = { total: 0, fromSW: 0, realNetwork: [] };
cdp.on('Network.responseReceived', (e) => {
  const u = e.response.url || '';
  if (!/\.(js|css)(\?|$)/.test(u)) return;
  seen.total++;
  if (e.response.fromServiceWorker) seen.fromSW++;
  else if (!e.response.fromDiskCache) seen.realNetwork.push(u.replace(BASE, ''));
});
await page.reload({ waitUntil: 'domcontentloaded' });
await sleep(3000);
console.log(JSON.stringify({ cachesInfo, secondLoad: { total: seen.total, fromSW: seen.fromSW, realNetwork: seen.realNetwork.length, sample: seen.realNetwork.slice(0, 5) }, errors }, null, 2));
await browser.close();
instance.stop();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
