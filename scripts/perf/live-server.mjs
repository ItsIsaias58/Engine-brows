// FASE 0 — servidor real en puerto efímero; mide bytes por tipo de frame WS,
// payloads REST y coste de event loop con distintos números de clientes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMarketServer } from '../../services/market/server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyra-bench-'));
const instance = createMarketServer({ port: 0, dataDir: tmp, tickMs: 1000, autoEvents: false });
const base = `http://127.0.0.1:${instance.port}`;
const wsBase = `ws://127.0.0.1:${instance.port}`;

async function api(pathname, opts = {}) {
  const res = await fetch(base + pathname, opts);
  const text = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(text, 'utf8'), body: safe(text) };
}
function safe(t) { try { return JSON.parse(t); } catch { return null; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- registro de una cuenta real (para /me, /skins, PUT) ----
const reg = await api('/api/market/accounts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'bench_' + Math.floor(Math.random() * 1e6), password: 'bench-pass-123' }),
});
const token = reg.body?.token || '';
const auth = token ? { Authorization: `Bearer ${token}` } : {};
console.log('register:', reg.status, 'bytes=', reg.bytes);

// ---- REST payloads (lo que el cliente pide durante el juego) ----
const resources = {};
for (const p of ['/api/market/state', '/api/market/me', '/api/market/skins', '/api/market/leaderboard', '/api/market/schedule', '/api/market/skins/catalog']) {
  const r = await api(p, { headers: auth });
  resources[p] = { status: r.status, bytes: r.bytes };
}

// ---- WS: cuánto baja CADA cliente por tipo de frame ----
async function runClients(n, seconds) {
  const stats = { totalBytes: 0, frames: 0, byType: {} };
  const socks = [];
  await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const ws = new WebSocket(wsBase + '/ws/market');
    socks.push(ws);
    ws.onopen = () => { try { ws.send(JSON.stringify({ type: 'auth', token })); } catch {} };
    ws.onmessage = (ev) => {
      const s = typeof ev.data === 'string' ? ev.data : String(ev.data);
      const len = Buffer.byteLength(s, 'utf8');
      let type = '?';
      try { type = JSON.parse(s).type || '?'; } catch {}
      stats.totalBytes += len; stats.frames += 1;
      stats.byType[type] = stats.byType[type] || { bytes: 0, frames: 0 };
      stats.byType[type].bytes += len; stats.byType[type].frames += 1;
      if (stats.frames >= n) resolve(); // primer frame por socket = snapshot
    };
  })));
  const t0 = Date.now();
  await sleep(seconds * 1000);
  const elapsed = (Date.now() - t0) / 1000;
  for (const ws of socks) { try { ws.close(); } catch {} }
  return {
    clients: n, seconds,
    totalMiB: +(stats.totalBytes / 1048576).toFixed(3),
    bytesPerClientPerSec: Math.round(stats.totalBytes / n / elapsed),
    framesPerClientPerSec: +(stats.frames / n / elapsed).toFixed(2),
    byType: Object.fromEntries(Object.entries(stats.byType).map(([k, v]) => [k, { bytes: v.bytes, frames: v.frames }])),
  };
}

const r1 = await runClients(1, 6);
const r5 = await runClients(5, 6);
const r20 = await runClients(20, 6);

// ---- coste de un tick del motor (CPU, síncrono) ----
const { tickMarketState, marketSnapshot, liveCandles } = await import('../../services/market/engine.mjs');
const m = instance.market;
let now = Date.now();
let acc = 0;
const N = 300;
for (let i = 0; i < N; i++) {
  now += 1000;
  const t0 = performance.now();
  tickMarketState(m, () => 0.5, now);
  marketSnapshot(m);
  liveCandles(m);
  acc += performance.now() - t0;
}
const tickCpuMs = acc / N;

console.log(JSON.stringify({
  resources,
  ws: { one: r1, five: r5, twenty: r20 },
  engine: { tickModelCpuMsAvg: +tickCpuMs.toFixed(3), ticksPerSec: +(1000 / tickCpuMs).toFixed(1) },
}, null, 2));

instance.stop();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(0);
