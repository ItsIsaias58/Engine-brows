// Test del puente WebSocket de mochi: /!!/ws/<encoded-target>
// Replica el flujo del cliente: handshake via lyra -> mochi -> wss dealer.
// Uso: bun scripts/test-mochi-ws.mjs "<ws-origin>" [target]
const ORIGIN = process.argv[2] || "http://127.0.0.1:4444";
const TARGET =
  process.argv[3] ||
  "wss://guc3-dealer.g2.spotify.com/?access_token=INVALID_PROBE";

const wsUrl = ORIGIN.replace(/^http/, "ws") + "/!!/ws/" + encodeURIComponent(TARGET);
console.log("probando:", wsUrl.slice(0, 90) + "...");

const ws = new WebSocket(wsUrl);
let phase = "connecting";
const timeout = setTimeout(() => {
  console.log(`TIMEOUT fase="${phase}" (el dealer no respondio al upgrade)`);
  process.exit(2);
}, 12_000);

ws.onopen = () => {
  console.log("OK: handshake 101 a traves del puente mochi ✓");
  clearTimeout(timeout);
  // el dealer envia un frame inicial "pong\nguest" al conectar
  setTimeout(() => process.exit(0), 1200);
};
ws.onmessage = (ev) => {
  const text = typeof ev.data === "string" ? ev.data : "(binario)";
  console.log("MSG del dealer:", String(text).slice(0, 80));
  clearTimeout(timeout);
  process.exit(0);
};
ws.onclose = (ev) => {
  clearTimeout(timeout);
  console.log(`CLOSE code=${ev.code} reason="${ev.reason}" fase="${phase}"`);
  process.exit(ev.code === 1006 ? 1 : 0);
};
ws.onerror = () => {}; // onclose dara el codigo
