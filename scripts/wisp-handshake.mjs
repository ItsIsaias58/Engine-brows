// Sonda del handshake wisp v2 (wisp_mux).srv/prod.mjs solo hace relay del
// upgrade a nuru, asi que la maquina de estados del lado cliente vive aqui:
//   1) WS con subprotocolo "wisp"
//   2) recibir InfoPacket del servidor (0x05)
//   3) mandar InfoPacket del cliente (version 2.0, sin extensiones)
//   4) recibir CONTINUE(0)
//   5) CONNECT -> recibir CONTINUE(id) => dial OK
// Uso: bun scripts/wisp-handshake.mjs [ws-url]   (default ws://127.0.0.1:4001/w/)
// Para trafico http/tls de extremo a extremo usar test-wisp-connect.mjs.
//
// maquina de estados:
// 1) WS con subprotocolo "wisp"
// 2) recibir InfoPacket del servidor (0x05)
// 3) mandar InfoPacket del cliente (version 2.0, sin extensiones)
// 4) recibir CONTINUE(0)
// 5) CONNECT -> recibir CONTINUE(id) => dial OK
function u32le(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function u16le(n) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n, true); return b; }

const infoClient = Uint8Array.from([0x05, ...u32le(0), 0x02, 0x00]); // InfoPacket v2.0 sin ext
const connectFrame = (id, host, port) =>
  Uint8Array.from([0x01, ...u32le(id), 0x01, ...u16le(port), ...new TextEncoder().encode(host)]);

function wispDial(url, host, port, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const events = [];
    let ws;
    const done = (note) => { try { ws?.close(); } catch {} resolve({ note, events }); };
    ws = new WebSocket(url, "wisp");
    ws.binaryType = "arraybuffer";
    let sentInfo = false, sentConnect = false, connectAt = 0;
    const timer = setTimeout(() => done(`timeout (info=${sentInfo} connect=${sentConnect} hace=${connectAt ? Math.round((Date.now()-connectAt)/1000)+"s" : "-"} eventos=${events.length})`), timeoutMs);
    ws.onopen = () => events.push("ws-open");
    ws.onmessage = (ev) => {
      const b = new Uint8Array(ev.data);
      const ty = b[0];
      const id = b.length >= 5 ? new DataView(b.buffer).getUint32(1, true) : -1;
      if (ty === 5) {
        const major = b[5], minor = b[6];
        events.push(`<- Info servidor v${major}.${minor}`);
        ws.send(infoClient); sentInfo = true;
        events.push("-> Info cliente v2.0");
        return;
      }
      if (ty === 3 && id === 0 && !sentConnect) {
        events.push("<- CONTINUE(0)");
        ws.send(connectFrame(1, host, port)); sentConnect = true; connectAt = Date.now();
        events.push("-> CONNECT open.spotify.com:443");
        return;
      }
      if (ty === 3 && id === 1) { clearTimeout(timer); events.push("<- CONTINUE(1)"); return done("DIAL OK"); }
      if (ty === 4) { clearTimeout(timer); return done(`CLOSE stream=${id} razon=${b[5] ?? "?"}`); }
      events.push(`<- ty=${ty} id=${id} len=${b.length}`);
    };
    ws.onerror = () => { clearTimeout(timer); done("ws error"); };
    ws.onclose = (e) => { clearTimeout(timer); done(`ws closed code=${e.code} (${sentInfo ? "info enviada" : "sin info"})`); };
  });
}

const url = process.argv[2] || "ws://127.0.0.1:4001/w/";
const r = await wispDial(url, "open.spotify.com", 443);
console.log(`${url}: ${r.note}\n  ${r.events.join(" ; ")}`);
