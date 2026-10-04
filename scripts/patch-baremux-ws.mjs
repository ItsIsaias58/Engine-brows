// patch-baremux-ws.mjs — parche del worker de bare-mux (mismo estilo que patch-dependencies.mjs):
//
//   El camino actual de los WebSockets de paginas proxied es:
//     pagina (folio hook) -> bare-mux -> transporte (epoxy) -> wisp (nuru)
//   y ese camino esta ROTO para WS (handshake wisp v2 nunca completa: "websocket did not open").
//   El HTTP proxied va por mochi y funciona perfecto; mochi ademas trae un puente WS
//   nativo probado (websocket.rs) en /!!/ws/<target-url-encoded> que reenvia
//   subprotocolos, cookies y autorizacion.
//
//   Este parche intercepta websocket en el SharedWorker y lo enruta por:
//     pagina -> bare-mux -> WebSocket directo a /!!/ws/... (mochi) -> target
//
//   EXCLUSIONES (no se tocan): rutas /w/ (relay wisp; el transporte lo usa por dentro)
//   y /!!/ (el propio mochi). Idempotente. Corre en postinstall.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = join(__dirname, '..', 'node_modules', '@mercuryworkshop', 'bare-mux', 'dist', 'worker.js');

let src = readFileSync(target, 'utf8');

if (src.includes('__lyraWsBridge')) {
  console.log('!! (˵◝ ⩊ ◜˵マ [bare-mux-ws] ya parcheado, nada que hacer');
  process.exit(0);
}

const BRIDGE_FN = `
async function __lyraWsBridge(t,a,n,e){
  try{
    const WS_URL=t&&t.websocket&&t.websocket.url;
    if(!WS_URL)return false;
    let u;try{u=new URL(WS_URL)}catch(_){return false}
    if("ws:"!==u.protocol&&"wss:"!==u.protocol)return false;
    if(-1!==u.href.indexOf("/!!/"))return false;
    if("/w/"===u.pathname||0===u.pathname.indexOf("/w/"))return false;
    const loc="undefined"!=typeof self&&self.location?self.location:null;
    const scheme=loc&&"https:"===loc.protocol?"wss":"ws";
    const host=loc?loc.host:"127.0.0.1:4444";
    const protos=t.websocket.protocols;
    if(protos&&1===protos.length&&"__diag__"===protos[0]){e.call(t.websocket.channel,{type:"close",args:[4999,"lyra-ws-bridge-ok"]});e.call(a,{type:"websocket"});return true;}
    const wire=protos&&protos.length?protos.join(", "):void 0;
    const raw=new WebSocket(scheme+"://"+host+"/!!/ws/"+encodeURIComponent(u.href),wire);
    raw.binaryType="arraybuffer";
    let opened=!1;
    raw.onopen=()=>{opened=!0;e.call(t.websocket.channel,{type:"open",args:[null]})};
    raw.onmessage=ev=>{e.call(t.websocket.channel,{type:"message",args:[ev.data]})};
    raw.onerror=()=>{opened||e.call(t.websocket.channel,{type:"error",args:["ws proxy connect failed"]})};
    raw.onclose=ev=>{e.call(t.websocket.channel,{type:"close",args:[ev.code||1006,ev.reason||""]})};
    t.websocket.channel.onmessage=ev=>{const d=ev.data;"data"===d.type?1===raw.readyState&&raw.send(d.data):"close"===d.type&&1===raw.readyState&&raw.close(d.closeCode||1000,d.closeReason||"")};
    e.call(a,{type:"websocket"});
    console.debug("[lyra-ws] websocket via mochi:",u.href);
    return true;
  }catch(err){
    console.warn("[lyra-ws] bridge error:",err);
    return false;
  }
}
`;

const ANCHOR_HANDLER =
  'await async function(t,a,n){const[s,o]=n.connect(new URL(t.websocket.url),t.websocket.protocols,t.websocket.requestHeaders,';

const HANDLER_PATCHED =
  'await async function(t,a,n){try{if(await __lyraWsBridge(t,a,n,e))return}catch(_){console.warn("[lyra-ws] bridge fallo; usando transporte:",_)}const[s,o]=n.connect(new URL(t.websocket.url),t.websocket.protocols,t.websocket.requestHeaders,';

const ANCHOR_TAIL = 'new BroadcastChannel("bare-mux").postMessage({type:"refreshPort"})';

if (!src.includes(ANCHOR_HANDLER)) {
  console.error('!! [bare-mux-ws] ancla del handler websocket NO encontrada (version de bare-mux distinta?)');
  process.exit(1);
}
if (!src.includes(ANCHOR_TAIL)) {
  console.error('!! [bare-mux-ws] ancla del final del worker NO encontrada');
  process.exit(1);
}

src = src.replace(ANCHOR_TAIL, BRIDGE_FN + '\n' + ANCHOR_TAIL);
src = src.replace(ANCHOR_HANDLER, HANDLER_PATCHED);

writeFileSync(target, src);
console.log('!! (˵◝ ⩊ ◜˵マ [bare-mux-ws] WebSockets de bare-mux ruteados via puente mochi (/!!/ws/)');
