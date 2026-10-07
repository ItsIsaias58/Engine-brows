// Mide el coste en el HILO PRINCIPAL de recibir el snapshot del cloud sync,
// separando el trabajo del worker (que NO bloquea la UI) de lo que cae al hilo
// principal:
//   A) antes: el worker devolvía el cuerpo (decenas de MB) y el hilo principal lo
//      recibía, creaba el Blob y lo comprimía con CompressionStream antes de subir.
//   B) ahora: el worker devuelve el gzip ya hecho (ArrayBuffer transferido) y el
//      hilo principal sólo recibe unos KB, sin trabajo extra.
// El "peor hueco de frame" es el jank real: cuanto más grande, más se congela la
// animación mientras el navegador hace ese trabajo.
import { chromium } from 'playwright-core';

const EXE = process.env.LYRA_CHROMIUM || '/home/isaias/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome';

const WORKER = `
const MIB = 1024 * 1024;
let payload = null;
self.onmessage = async (e) => {
  const { mode, mib } = e.data;
  if (e.data.phase === 'send') {
    if (payload.transfer) self.postMessage({ body: payload.body, len: payload.len }, [payload.body]);
    else self.postMessage({ body: payload.body, len: payload.len });
    return;
  }
  const chunks = [];
  const per = 200 * 1024;
  const n = Math.ceil((mib * MIB) / per);
  for (let i = 0; i < n; i++) chunks.push({ key: 'k' + i, value: 'A'.repeat(per) });
  const body = JSON.stringify({ schemaVersion: 3, localStorage: {}, sessionStorage: {}, cookies: [], indexedDB: { big: { stores: { s: { records: chunks } } } } });
  if (mode === 'string') { payload = { body, len: body.length }; self.postMessage({ ready: true }); return; }
  const raw = new Blob([body]);
  const gz = await new Response(raw.stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  payload = { body: gz, len: body.length, transfer: true };
  self.postMessage({ ready: true });
};
`;

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage();
await page.goto('about:blank');

const out = await page.evaluate(async ({ WORKER }) => {
  const url = URL.createObjectURL(new Blob([WORKER], { type: 'application/javascript' }));
  const worker = new globalThis.Worker(url);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitReady = () => new Promise((r) => { worker.onmessage = () => r(); });

  async function run(mode) {
    worker.postMessage({ mode, mib: 67, phase: 'prepare' });
    await waitReady();
    await sleep(50);
    let last = performance.now();
    let worstGap = 0;
    let stop = false;
    (function loop() {
      if (stop) return;
      const now = performance.now();
      worstGap = Math.max(worstGap, now - last);
      last = now;
      requestAnimationFrame(loop);
    })();
    let t0 = 0;
    const got = new Promise((r) => {
      worker.onmessage = async (e) => {
        const receiveMs = performance.now() - t0;
        const a = performance.now();
        if (mode === 'string') {
          const raw = new Blob([e.data.body]);
          await new Response(raw.stream().pipeThrough(new globalThis.CompressionStream('gzip'))).arrayBuffer();
        }
        const extraMs = performance.now() - a;
        stop = true;
        r({ receiveMs, extraMs, worstGap });
      };
    });
    t0 = performance.now();
    worker.postMessage({ phase: 'send' });
    return got;
  }

  const string = await run('string');
  const compressed = await run('compressed');
  worker.terminate();
  return { string, compressed };
}, { WORKER });

const f = (n) => +n.toFixed(1);
console.log(JSON.stringify({
  A_antes_cuerpo_67MB: {
    'recibir_en_hilo_principal_ms': f(out.string.receiveMs),
    'blob_gzip_en_hilo_principal_ms': f(out.string.extraMs),
    'peor_hueco_de_frame_ms': f(out.string.worstGap),
  },
  B_ahora_worker_gzip_transferido: {
    'recibir_en_hilo_principal_ms': f(out.compressed.receiveMs),
    'blob_gzip_en_hilo_principal_ms': f(out.compressed.extraMs),
    'peor_hueco_de_frame_ms': f(out.compressed.worstGap),
  },
}, null, 2));

await browser.close();
process.exit(0);
