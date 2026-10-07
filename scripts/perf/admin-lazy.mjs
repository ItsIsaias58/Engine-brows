import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createMarketServer } from '../../services/market/server.mjs';

const EXE = process.env.LYRA_CHROMIUM || '/home/isaias/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-bench-'));
const instance = createMarketServer({ port: 4313, dataDir: tmp, tickMs: 1000, autoEvents: false, adminNames: 'boss' });
const BASE = `http://127.0.0.1:${instance.port}`;

// registra el admin y devuelve su token
const reg = await fetch(BASE + '/api/market/accounts', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'boss', password: 'boss-pass-123' }),
});
const token = (await reg.json()).token;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const out = {};

// ---------- 1) invitado normal: admin.js NO debe cargarse ----------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + '/owngames/bolsa-trading-floor/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  out.guest = {
    adminJsRequested: requests.some((u) => u.includes('js/admin.js')),
    AdminConsoleDefined: await page.evaluate(() => typeof AdminConsole !== 'undefined'),
    maybeMountStub: await page.evaluate(() => typeof window.maybeMountAdminButton === 'function'),
    errors,
  };
  // el atajo debe cargarlo y abrir la consola (con ?admin=1 para forzarla)
  await page.goto(BASE + '/owngames/bolsa-trading-floor/?admin=1', { waitUntil: 'domcontentloaded' });
  await sleep(1500);
  await page.keyboard.press('Control+Shift+A');
  await sleep(1500);
  out.shortcut = {
    AdminConsoleDefined: await page.evaluate(() => typeof AdminConsole !== 'undefined'),
    overlayVisible: await page.evaluate(() => { const o = document.getElementById('adminOverlay'); return Boolean(o && o.classList.contains('is-visible')); }),
  };
  await ctx.close();
}

// ---------- 2) admin con sesión: el botón del rail debe montarse ----------
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.addInitScript((t) => {
    try { localStorage.setItem('bolsa-market-token', t); } catch {}
  }, token);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/owngames/bolsa-trading-floor/', { waitUntil: 'domcontentloaded' });
  // espera a que la sesión se restaure y auth.js llame a maybeMountAdminButton
  await sleep(4000);
  out.admin = {
    AdminConsoleDefined: await page.evaluate(() => typeof AdminConsole !== 'undefined'),
    railAdminButton: await page.evaluate(() => Boolean(document.querySelector('.rail-admin'))),
    errors,
  };
  await ctx.close();
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
instance.stop();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
