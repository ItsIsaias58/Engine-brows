// Verifica en Chromium real (no es un test de bun: necesita DOM) dos bugs del
// OpenCase que sólo se ven ejecutando la ruleta:
//
//  1) desincronización: la tarjeta que queda BAJO EL MARCADOR tiene que ser la
//     misma que aparece en la tarjeta de resultado. El salto de 156px por
//     tarjeta estaba hardcodeado, así que en pantallas estrechas (donde
//     `.rl-item` pasa a 120px por media query) la cinta paraba en un relleno.
//  2) skin duplicada: el server concede la skin en el `open` y su push la mete
//     en el inventario local ANTES de que la ruleta pare; el commit del revelado
//     no debe añadirla otra vez.
//
// Uso:  NODE_PATH=<dir con playwright-core> bun scripts/opencase-ui-check.mjs
// Requiere el binario de Chromium (LYRA_CHROMIUM para cambiarlo).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { createMarketServer } from '../services/market/server.mjs';

const EXE = process.env.LYRA_CHROMIUM || '/home/isaias/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-bench-'));
const instance = createMarketServer({ port: 0, dataDir: tmp, tickMs: 1000, autoEvents: false });
const BASE = `http://127.0.0.1:${instance.port}`;
const GAME = `${BASE}/owngames/csgo-opencase/`;

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
});

// ---- js de la pagina: qué tarjeta quedó centrada bajo el marcador ----
const READ_ROULETTE = () => {
  const reel = document.getElementById('roulette');
  const reelRect = reel.getBoundingClientRect();
  const center = reelRect.left + reelRect.width / 2;
  let best = null;
  for (const el of reel.querySelectorAll('.rl-item')) {
    const r = el.getBoundingClientRect();
    const d = r.left + r.width / 2 - center;
    if (!best || Math.abs(d) < Math.abs(best.offset)) {
      best = {
        offset: +d.toFixed(1),
        name: (el.querySelector('b')?.textContent || '').trim(),
        isWinner: el.classList.contains('is-winner'),
      };
    }
  }
  const resultName = (document.querySelector('#resultCard .rc-name')?.textContent || '')
    .replace(/StatTrak™/g, '')
    .trim();
  const ids = [...document.querySelectorAll('#inventory [data-sell]')].map((b) => b.dataset.sell);
  return {
    centeredName: best?.name,
    centeredIsWinner: best?.isWinner,
    centeredOffsetPx: best?.offset,
    resultName,
    inventoryIds: ids,
    inventoryCount: ids.length,
  };
};

async function seedGuest(page) {
  await page.goto(`${BASE}/owngames/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('bolsa-market-guest', '1');
    localStorage.setItem('bolsa-trading-floor-save', JSON.stringify({ state: { cash: 500000 } }));
    localStorage.removeItem('opencase-local-inventory-v1');
    localStorage.removeItem('opencase-local-stats-v1');
  });
  await page.goto(GAME, { waitUntil: 'domcontentloaded' });
  await page.click('#gateGuest');
  await page.waitForSelector('.case-open:not([disabled])', { timeout: 15000 });
}

async function playOneSpin(page, { sampleInventory = false } = {}) {
  await page.click('.case-open:not([disabled])');
  const during = [];
  if (sampleInventory) {
    for (let i = 0; i < 3; i++) {
      await sleep(1200);
      during.push(await page.evaluate(() => [...document.querySelectorAll('#inventory [data-sell]')].map((b) => b.dataset.sell)));
    }
  }
  await page.waitForSelector('#resultCard:not(.is-hidden)', { timeout: 25000 });
  await sleep(500);
  const out = await page.evaluate(READ_ROULETTE);
  out.duringSpinIds = during.flat();
  return out;
}

async function runAt(viewport, label) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await seedGuest(page);
  const spin = await playOneSpin(page);
  const dupes = spin.inventoryIds.filter((id, i) => spin.inventoryIds.indexOf(id) !== i);
  const out = {
    label,
    viewport: `${viewport.width}x${viewport.height}`,
    centeredName: spin.centeredName,
    resultName: spin.resultName,
    centeredIsWinner: spin.centeredIsWinner,
    centeredOffsetPx: spin.centeredOffsetPx,
    matches: spin.centeredName === spin.resultName,
    inventoryCountAfterReveal: spin.inventoryCount,
    duplicates: dupes,
    errors,
  };
  await ctx.close();
  return out;
}

// invitado, ventana estrecha (aquí es donde el media query rompía la geometría)
const narrow = await runAt({ width: 480, height: 900 }, 'invitado/estrecho');
// invitado, escritorio (el caso que sí coincidía con la constante de 156)
const desktop = await runAt({ width: 1280, height: 900 }, 'invitado/escritorio');

// sesion real: el server concede la skin y la empuja por websocket antes de que
// la ruleta pare; aquí se ve el inventario duplicado si el commit no deduplica
let signedIn = null;
{
  const name = `uicheck${Date.now() % 100000}`;
  const reg = await fetch(`${BASE}/api/market/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, password: 'ui-check-pass-123' }),
  }).then((r) => r.json());
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/owngames/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([token, userName]) => {
    localStorage.setItem('bolsa-market-token', token);
    localStorage.setItem('bolsa-market-name', userName);
    localStorage.removeItem('bolsa-market-guest');
    localStorage.removeItem('opencase-local-inventory-v1');
  }, [reg.token, name]);
  await page.goto(GAME, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.case-open:not([disabled])', { timeout: 15000 });
  const spin = await playOneSpin(page, { sampleInventory: true });
  const serverInventory = await fetch(`${BASE}/api/market/skins`, {
    headers: { Authorization: `Bearer ${reg.token}` },
  }).then((r) => r.json());
  const dupes = spin.inventoryIds.filter((id, i) => spin.inventoryIds.indexOf(id) !== i);
  signedIn = {
    label: 'sesion real (server + push ws)',
    centeredName: spin.centeredName,
    resultName: spin.resultName,
    matches: spin.centeredName === spin.resultName,
    // si aquí aparece el id durante el giro, el push SÍ se adelantó al revelado:
    // sin la deduplicación el commit lo habría metido una segunda vez
    idsDuringSpin: spin.duringSpinIds,
    inventoryCountAfterReveal: spin.inventoryCount,
    serverInventoryCount: (serverInventory.inventory || []).length,
    duplicates: dupes,
    errors,
  };
  await ctx.close();
}

console.log(JSON.stringify({ narrow, desktop, signedIn }, null, 2));

const ok =
  narrow.matches && desktop.matches && signedIn.matches &&
  narrow.duplicates.length === 0 && desktop.duplicates.length === 0 &&
  signedIn.duplicates.length === 0 &&
  signedIn.serverInventoryCount === 1 && signedIn.inventoryCountAfterReveal === 1;
console.log(ok ? 'OK: la ruleta coincide con el premio y no hay duplicados' : 'FALLO: revisar los datos de arriba');

await browser.close();
instance.stop();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
