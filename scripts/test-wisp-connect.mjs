// Prueba de conectividad wisp v2 (protocolo wisp_mux, el que habla nuru):
// frame por mensaje WS = [tipo u8][stream u32 LE][payload]
//   CONNECT  (0x01): [stream_type u8][port u16 LE][host]
//   DATA     (0x02): payload crudo
//   CLOSE    (0x04): [reason u8]
// Exito = recibir DATA (bytes de vuelta del destino) o NO recibir CLOSE.
// Uso: bun scripts/test-wisp-connect.mjs <host> <port> [payload=http|tls]
const HOST = process.argv[2] || "1.1.1.1";
const PORT = Number(process.argv[3] || 80);
const MODE = process.argv[4] || "http";

const origin = process.env.WISP_ORIGIN || "http://127.0.0.1:4444";
const wsUrl = origin.replace(/^http/, "ws") + "/w/";

const enc = new TextEncoder();
function frame(type, streamId, payload) {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  out[1] = streamId & 0xff;
  out[2] = (streamId >> 8) & 0xff;
  out[3] = (streamId >> 16) & 0xff;
  out[4] = (streamId >> 24) & 0xff;
  out.set(payload, 5);
  return out;
}

// CONNECT: tcp(0x01) + port LE + host
function connectFrame(host, port) {
  const hostB = enc.encode(host);
  const payload = new Uint8Array(3 + hostB.length);
  payload[0] = 0x01; // StreamType::Tcp
  payload[1] = port & 0xff;
  payload[2] = (port >> 8) & 0xff;
  payload.set(hostB, 3);
  return frame(0x01, 0, payload);
}

const payload =
  MODE === "tls"
    ? new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x00]) // ClientHello minimo
    : enc.encode(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\n\r\n`);

const ws = new WebSocket(wsUrl);
ws.binaryType = "arraybuffer";
let phase = "ws-connecting";
let gotData = false;
const timeout = setTimeout(() => {
  if (gotData) process.exit(0);
  console.log(`TIMEOUT en fase "${phase}" (sin respuesta del destino)`);
  process.exit(2);
}, 10_000);

ws.onopen = () => {
  phase = "connect-sent";
  ws.send(connectFrame(HOST, PORT));
  setTimeout(() => {
    phase = "data-sent";
    ws.send(frame(0x02, 0, payload));
  }, 300);
};
ws.onmessage = (ev) => {
  const b = new Uint8Array(ev.data);
  if (b.length < 5) return;
  const type = b[0];
  if (type === 0x02) {
    gotData = true;
    const text = new TextDecoder().decode(b.subarray(5, Math.min(b.length, 90)));
    console.log(`OK DATA (${b.length - 5}B): ${JSON.stringify(text)}`);
    clearTimeout(timeout);
    setTimeout(() => process.exit(0), 400);
  } else if (type === 0x04) {
    const reasons = ["unknown", "blocked-host", "bad-host", "refused", "runtime", "clean"];
    console.log(`CLOSE stream: razon=${reasons[b[5]] ?? b[5]} (${b.length > 6 ? new TextDecoder().decode(b.subarray(6)) : ""})`);
    clearTimeout(timeout);
    process.exit(1);
  }
};
ws.onclose = (ev) => {
  if (gotData) process.exit(0);
  console.log(`WS cerrado fase="${phase}" code=${ev.code} reason="${ev.reason}"`);
  clearTimeout(timeout);
  process.exit(1);
};
ws.onerror = () => {
  console.log(`WS error fase="${phase}"`);
  clearTimeout(timeout);
  process.exit(1);
};
