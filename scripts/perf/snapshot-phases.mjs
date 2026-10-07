// Coste de las etapas que el cloud sync hacía en el HILO PRINCIPAL con la
// instantánea completa del navegador (medida de referencia, ~67 MB):
//   JSON.stringify + TextEncoder + crypto.subtle.digest  -> el escaneo de seguridad
//   new Blob + CompressionStream('gzip')                 -> antes de cada subida
// Con el worker cargando con todo esto, aquí sólo queda lo que se sigue haciendo
// a mano (el respaldo cuando no hay worker). Corre con `bun`.
const MIB = 1024 * 1024;

// ~67 MB de carga útil, parecida al snapshot real: muchos registros con cadenas
// base64 (que es lo que abulta: bytes codificados como texto)
const chunks = [];
const perChunk = 200 * 1024;
const count = Math.ceil((67 * MIB) / perChunk);
for (let i = 0; i < count; i++) {
  chunks.push({ key: `k${i}`, value: 'A'.repeat(perChunk) });
}
const snapshot = {
  schemaVersion: 3,
  localStorage: {},
  sessionStorage: {},
  cookies: [],
  indexedDB: { big: { stores: { s: { records: chunks } } } },
};

const now = () => performance.now();
let t0 = now();
const body = JSON.stringify(snapshot);
const stringifyMs = now() - t0;

t0 = now();
const bytes = new TextEncoder().encode(body);
const textEncoderMs = now() - t0;

t0 = now();
await globalThis.crypto.subtle.digest('SHA-256', bytes);
const sha256Ms = now() - t0;

t0 = now();
const blob = new Blob([body]);
const blobCopyMs = now() - t0;

t0 = now();
const gzipped = await new Response(
  blob.stream().pipeThrough(new globalThis.CompressionStream('gzip')),
).arrayBuffer();
const gzipMs = now() - t0;

console.log(
  JSON.stringify(
    {
      bodyMiB: +(body.length / MIB).toFixed(1),
      stringifyMs: +stringifyMs.toFixed(1),
      textEncoderMs: +textEncoderMs.toFixed(1),
      sha256Ms: +sha256Ms.toFixed(1),
      blobCopyMs: +blobCopyMs.toFixed(1),
      gzipMs: +gzipMs.toFixed(1),
      gzipMiB: +(gzipped.byteLength / MIB).toFixed(2),
      totalMainThreadMs: +(stringifyMs + textEncoderMs + sha256Ms + blobCopyMs + gzipMs).toFixed(1),
    },
    null,
    2,
  ),
);
