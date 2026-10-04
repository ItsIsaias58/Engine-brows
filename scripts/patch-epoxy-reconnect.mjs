// patch-epoxy-reconnect.mjs — parche del transporte epoxy (mismo estilo que patch-dependencies.mjs):
// anade reconexion automatica del EpoxyClient cuando el socket wisp muere
// (error "Wisp(WsImplSocketClosed)" que produce rafagas de 502 "fallback failed" en el proxy).
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TARGETS = [
  join(ROOT, 'node_modules', '@mercuryworkshop', 'epoxy-transport', 'dist', 'index.mjs'),
  join(ROOT, 'node_modules', '@mercuryworkshop', 'epoxy-transport', 'dist', 'index.js'),
];

const POSITIVE = '!! (˵◝ ⩊  ◜˵マ';

// --- bloque de clase: rebuildClient (reconstruye EpoxyClient tras caida del wisp) ---
const rebuildAnchor = `  async init() {
    await epoxy_bundled_default();
    let options = new EpoxyClientOptions();
    options.user_agent = navigator.userAgent;
    opts.forEach((x) => this.setopt(options, x));
    this.client = new EpoxyClient(this.wisp, options);
    this.ready = true;
  }`;

const rebuildReplacement = `  async init() {
    await epoxy_bundled_default();
    let options = new EpoxyClientOptions();
    options.user_agent = navigator.userAgent;
    opts.forEach((x) => this.setopt(options, x));
    this.client = new EpoxyClient(this.wisp, options);
    this.ready = true;
  }
  // --- lyra: reconstruccion del cliente wisp tras caida del socket ---
  async rebuildClient() {
    if (this.rebuilding) return this.rebuilding;
    this.rebuilding = (async () => {
      try {
        await epoxy_bundled_default();
        let options = new EpoxyClientOptions();
        options.user_agent = navigator.userAgent;
        opts.forEach((x) => this.setopt(options, x));
        this.client = new EpoxyClient(this.wisp, options);
      } finally {
        this.rebuilding = null;
        this.ready = true;
        console.log("[epoxy] cliente wisp reconstruido${POSITIVE}");
      }
    })();
    return this.rebuilding;
  }
  rebuilding = null;`;

// --- bloque request: reintento automatico cuando el wisp esta caido ---
const requestAnchor = `    try {
      let res = await this.client.fetch(remote.href, { method, body, headers, redirect: "manual" });`;

const requestReplacement = `    try {
      let res;
      try {
        res = await this.client.fetch(remote.href, { method, body, headers, redirect: "manual" });
      } catch (retryErr) {
        // wisp caido (socket cerrado): reconstruir cliente y reintentar una vez
        const retryMsg = String(retryErr?.message || retryErr);
        if (!/SocketClosed|wisp|websocket|connection/i.test(retryMsg)) throw retryErr;
        console.warn("[epoxy] wisp caido, reconectando... (" + retryMsg.slice(0, 90) + ")");
        await this.rebuildClient();
        res = await this.client.fetch(remote.href, { method, body, headers, redirect: "manual" });
      }`;

const APPLY = [
  { file: '', oldStr: rebuildAnchor, newStr: rebuildReplacement, desc: 'epoxy rebuildClient' },
  { file: '', oldStr: requestAnchor, newStr: requestReplacement, desc: 'epoxy request retry' },
];

let applied = 0;
for (const path of TARGETS) {
  if (!existsSync(path)) {
    console.warn(`aviso: no existe ${path}, saltando`);
    continue;
  }
  let src = readFileSync(path, 'utf8');
  if (src.includes('[epoxy] wisp caido')) {
    console.log(`ya parcheado: ${path}`);
    continue;
  }
  for (const rule of APPLY) {
    if (!src.includes(rule.oldStr)) {
      console.error(`ERROR (${rule.desc}): ancla no encontrada en ${path}`);
      process.exit(1);
    }
    src = src.replace(rule.oldStr, rule.newStr);
    applied++;
  }
  writeFileSync(path, src);
  console.log(`parcheado: ${path} ${POSITIVE}`);
}
console.log(`bloques aplicados: ${applied}`);
