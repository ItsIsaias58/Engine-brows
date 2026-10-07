// FASE 0 — carga real: abre N sockets WebSocket contra un market EN MARCHA y
// mide, durante la ventana, el CPU y la RAM del PROCESO del servidor leídos de
// /proc. Sirve para extrapolar cuántos jugadores simultáneos aguanta la máquina.
//
//   LYRA_WS=ws://127.0.0.1:4006/ws/market CLIENTS=50 SECONDS=10 \
//     bun scripts/perf/load-clients.mjs
//
// Es de solo lectura hacia el server: los sockets se autentican como invitado
// (o con TOKEN) y no envían ninguna acción que mute el estado.
import fs from 'node:fs';
import os from 'node:os';

const WS = process.env.LYRA_WS || 'ws://127.0.0.1:4006/ws/market';
const CLIENTS = Number.parseInt(process.env.CLIENTS || '10', 10);
const SECONDS = Number.parseInt(process.env.SECONDS || '10', 10);
const TOKEN = process.env.TOKEN || '';
const CLK_TCK = 100; // getconf CLK_TCK en Linux
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// encuentra el pid del market de lyra por su cmdline (sin tocar nada)
function findServerPid() {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8');
      if (/services\/market\/server\.mjs/.test(cmd)) return Number(entry);
    } catch {}
  }
  return null;
}

function readStat(pid) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).split(' ');
  // tras "comm)": state=fields[0]; utime = fields[11], stime = fields[12]
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const rssPages = Number(fields[21]);
  return { ticks: utime + stime, rssKb: (rssPages * 4096) / 1024 };
}

const pid = findServerPid();
if (!pid) {
  console.error('no encuentro el proceso market (services/market/server.mjs) en marcha');
  process.exit(1);
}

const before = readStat(pid);
const socks = [];
let totalBytes = 0;
let frames = 0;
let opened = 0;

for (let i = 0; i < CLIENTS; i++) {
  const ws = new WebSocket(WS);
  socks.push(ws);
  ws.onopen = () => {
    opened += 1;
    if (TOKEN) ws.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  };
  ws.onmessage = (ev) => {
    totalBytes += Buffer.byteLength(typeof ev.data === 'string' ? ev.data : String(ev.data), 'utf8');
    frames += 1;
  };
  ws.onerror = () => {};
}

// deja que todos abran antes de empezar el reloj
const t0 = Date.now();
while (opened < CLIENTS && Date.now() - t0 < 10000) await sleep(50);
const start = readStat(pid);
const wall0 = Date.now();
const bytes0 = totalBytes;
const frames0 = frames;
await sleep(SECONDS * 1000);
const end = readStat(pid);
const wallS = (Date.now() - wall0) / 1000;

for (const ws of socks) { try { ws.close(); } catch {} }

const cpuMs = ((end.ticks - start.ticks) / CLK_TCK) * 1000;
const cpuPercentOfOneCore = +((cpuMs / 1000 / wallS) * 100).toFixed(2);
const path = os.cpus().length;

console.log(JSON.stringify({
  ws: WS,
  clients: CLIENTS,
  opened,
  seconds: +wallS.toFixed(2),
  serverPid: pid,
  serverCpuMsDuringWindow: +cpuMs.toFixed(1),
  serverCpuPercentOfOneCore: cpuPercentOfOneCore,
  serverCpuPercentOfMachine: +(cpuPercentOfOneCore / path).toFixed(3),
  serverRssIdleKb: +before.rssKb.toFixed(0),
  serverRssAfterKb: +end.rssKb.toFixed(0),
  rssPerClientKb: opened ? +((end.rssKb - before.rssKb) / opened).toFixed(1) : null,
  recvBytesPerClientPerSec: opened ? Math.round((totalBytes - bytes0) / opened / wallS) : null,
  recvFramesPerClientPerSec: opened ? +((frames - frames0) / opened / wallS).toFixed(2) : null,
}, null, 2));
process.exit(0);
