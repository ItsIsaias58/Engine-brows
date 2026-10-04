// Decodifica una URL ofuscada de mochi (algoritmo inverso de encoding.rs):
// base64url -> XOR con "q7Zx!9pL" -> percent-decode
// Uso: bun scripts/decode-mochi-url.mjs <url_ofuscada_o_path_completo>
const KEY = "q7Zx!9pL";

const input = process.argv[2] || "";
// acepta tanto el token crudo como un path /!!/<token>/ o una URL completa
const m = input.match(/\/!!\/([^/?]+)/);
const token = (m ? m[1] : input).replace(/^\/+|\/+$/g, "");

let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
while (b64.length % 4) b64 += "=";
const raw = Buffer.from(b64, "base64");
let xored = Buffer.alloc(raw.length);
for (let i = 0; i < raw.length; i++) xored[i] = raw[i] ^ KEY.charCodeAt(i % KEY.length);
try {
  console.log(decodeURIComponent(xored.toString("utf8")));
} catch {
  console.log(xored.toString("utf8"));
}
