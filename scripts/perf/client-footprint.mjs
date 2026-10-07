// FASE 0 — huella del CLIENTE: cuánta RAM y CPU consume UNA pestaña del juego
// (o del OpenCase) en Chromium. Responde "¿cuántos probadores caben en esta
// laptop abriendo pestañas?".
//
//   NODE_PATH=/tmp/lyra-baseline/node_modules LYRA_URL=http://127.0.0.1:4444 \
//     TABS=1,5,10 bun scripts/perf/client-footprint.mjs
//
// Mide la RAM de TODO el árbol de procesos de Chromium y le resta la línea base
// (navegador recién abierto, sin pestañas), para obtener el coste marginal por
// pestaña. Requiere playwright-core y Chromium (ver README).
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const EXE = process.env.LYRA_CHROMIUM || '/home/isaias/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';
const BASE = process.env.LYRA_URL || 'http://127.0.0.1:4444';
const GAME = process.env.LYRA_GAME || '/owngames/bolsa-trading-floor/';
const COUNTS = (process.env.TABS || '1,5,10').split(',').map((n) => Number.parseInt(n.trim(), 10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// RSS y PSS (kB) sumados sobre todos los procesos cuyo cmdline incluye el
// ejecutable. El PSS reparte las páginas compartidas entre procesos, así que es
// la cifra honesta para "cuánta RAM hace falta de verdad" (el RSS las cuenta
// una vez por proceso y sobreestima en Chromium, que comparte muchísimo).
function chromiumMemKb() {
  let rssKb = 0;
  let pssKb = 0;
  let procs = 0;
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (!cmd.includes(EXE)) continue;
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      rssKb += (Number(fields[21]) * 4096) / 1024;
      const rollup = fs.readFileSync(`/proc/${entry}/smaps_rollup`, 'utf8');
      const m = /^Pss:\s+(\d+) kB/m.exec(rollup);
      if (m) pssKb += Number(m[1]);
      procs += 1;
    } catch {}
  }
  return { totalKb: rssKb, pssKb, procs };
}

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--js-flags=--expose-gc'],
});
await sleep(1500);
const baseline = chromiumMemKb(); // navegador vacío

const out = { game: GAME, baseBrowserRssKb: +baseline.totalKb.toFixed(0), baseBrowserPssKb: +baseline.pssKb.toFixed(0), baseProcs: baseline.procs, tabs: [] };

for (const n of COUNTS) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const pages = [];
  for (let i = 0; i < n; i++) {
    const page = await context.newPage();
    await page.goto(BASE + GAME, { waitUntil: 'domcontentloaded', timeout: 60000 });
    pages.push(page);
  }
  await sleep(12000); // deja correr el juego (ticks, render, chart)
  const mem = chromiumMemKb();
  let heapMB = 0;
  for (const page of pages) {
    try {
      const h = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 1048576 : 0));
      heapMB += h;
    } catch {}
  }
  out.tabs.push({
    tabs: n,
    browserRssKb: +mem.totalKb.toFixed(0),
    browserPssKb: +mem.pssKb.toFixed(0),
    marginalPssPerTabKb: +((mem.pssKb - baseline.pssKb) / n).toFixed(0),
    jsHeapPerTabMB: +(heapMB / n).toFixed(1),
    processes: mem.procs,
    procsPerTab: +((mem.procs - baseline.procs) / n).toFixed(2),
  });
  await context.close();
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
process.exit(0);
