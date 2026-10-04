// compresion on-the-fly en el borde (lo que sale hacia el tunel).
//
// Vive aqui y no en prod.mjs/dev.mjs por lo mismo que serviceRoutes.mjs: es
// codigo con condiciones de carrera y truncamientos silenciosos, y eso se
// prueba mejor en un fichero importable que a travers de un servidor entero.
//
// el problema que arregla: mochi entrega los cuerpos en chunked y SIN
// content-length (los quita de la respuesta del origen, ver
// `is_blacklisted_res_header` en services/mochi/src/helpers.rs), asi que la
// compresion que solo miraba content-length no se daba nunca con lo que
// sirve el proxy de juegos, y todo eso cruzaba el tunel en claro: un .js de
// 80 KB, 80 KB. aqui se decide leyendo el cuerpo con tope, y el tope es la
// garantia de que un stream (video, descarga, drip lento) no se queda
// esperando a que se llene antes de su primer byte.

const COMPRESSIBLE_MEDIA_TYPES =
  /^text\/|application\/(javascript|json|xml|wasm)/;
// por debajo de esto no compensa comprimirlo en caliente
const MIN_COMPRESS_BYTES = 1_024;
export const MAX_COMPRESS_BYTES = 4 * 1024 * 1024;
// sin content-length no se puede decidir por el tamano de antemano, asi que
// ademas de los bytes hay que poner un reloj: un stream de texto lento no
// puede esperar 4 MB antes de emitir su primer byte.
export const COMPRESS_WAIT_MS = 150;

const gzipCompress = (buf) => Bun.gzipSync(buf, { level: 6 });

/** el cliente acepta este token con q > 0 */
export function acceptsEncoding(acceptHeader, token) {
  return (acceptHeader || "")
    .split(",")
    .some((part) => {
      const [name, ...params] = part.trim().split(";");
      if (name.trim().toLowerCase() !== token) return false;
      const q = params.find((param) => param.trim().startsWith("q="));
      return !q || Number.parseFloat(q.slice(2)) > 0;
    });
}

/**
 * Lee del stream hasta `cap` bytes, hasta que termine, o hasta que pasen
 * `waitMs`.
 *
 * Si se devuelve antes de tiempo no se pierde nada: el `read()` que quedo en
 * vuelo y el reader se cuelgan en el resultado, y `reattachBody` sigue por
 * ahi. Perder un chunk seria servir un cuerpo corrupto.
 */
export async function readCapped(body, cap, waitMs) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  let pending = null;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (total >= cap) break;
    const left = deadline - Date.now();
    if (left <= 0) break;
    pending = reader.read();
    // el read() en vuelo puede rechazar cuando ya no lo mira nadie: se
    // engancha un catch para que no salga como unhandled rejection
    pending.catch(() => {});
    let timer;
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), left);
    });
    const next = await Promise.race([pending, expired]);
    clearTimeout(timer);
    if (!next) break;
    pending = null;
    if (next.done) {
      return { chunks, total, done: true, reader, pending: null };
    }
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  return { chunks, total, done: false, reader, pending };
}

function joinChunks(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * Vuelve a colgar el cuerpo en una respuesta igual a la original: mismos
 * status, mismas cabeceras y los mismos bytes, ni uno comprimido de mas ni
 * uno perdido. OJO: lo que `readCapped` ya leyo va PRIMERO, y sin eso el
 * cliente se queda solo con la cola del stream (una descarga de 9 MB llegaba
 * como sus ultimos 600 KB).
 */
export function reattachBody(response, capped) {
  if (capped.done) {
    return new Response(joinChunks(capped.chunks, capped.total), {
      status: response.status,
      headers: response.headers,
    });
  }
  const buffered = capped.chunks;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        if (buffered.length > 0) {
          controller.enqueue(buffered.shift());
          return;
        }
        // OJO: `capped.pending` es el read() EN VOLO (una promesa, no su
        // resultado): hay que awaitarlo. Sin esto, en el camino del reloj
        // `next.value` era undefined y se encolaba un undefined al cliente.
        const next = capped.pending ? await capped.pending : await capped.reader.read();
        capped.pending = null;
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await capped.reader.cancel(reason).catch(() => {});
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

function compressResponse(response, buffer) {
  const compressed = gzipCompress(buffer);
  // si comprimir no ayuda hay que devolver el buffer ORIGINAL, no la `response`
  // de la que ya se leyo el cuerpo: un Response con el body consumido llega
  // vacio al cliente.
  if (compressed.byteLength >= buffer.byteLength) {
    return new Response(buffer, {
      status: response.status,
      headers: response.headers,
    });
  }
  const headers = new Headers(response.headers);
  headers.set("Content-Encoding", "gzip");
  headers.set("Content-Length", String(compressed.byteLength));
  const vary = headers.get("Vary") || "";
  if (!vary.toLowerCase().includes("accept-encoding")) {
    headers.append("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
  }
  return new Response(compressed, { status: response.status, headers });
}

/**
 * Comprime la respuesta si se puede, y si no la devuelve tal cual.
 *
 * Solo 200: un 206 (Range) o un redirect re-comprimido se corrompe. HEAD se
 * queda fuera porque comprimirlo mentiria en Content-Length y rompe la
 * simetria HEAD/GET que asumen algunos clientes y el edge de CF.
 */
export async function maybeCompressResponse(req, response) {
  if (response.status !== 200) return response;
  if (req.method === "HEAD") return response;
  if (response.headers.has("content-encoding")) return response;
  const type = response.headers.get("content-type") || "";
  if (!COMPRESSIBLE_MEDIA_TYPES.test(type)) return response;
  if (!acceptsEncoding(req.headers.get("accept-encoding"), "gzip")) {
    return response;
  }

  const length = Number.parseInt(
    response.headers.get("content-length") || "",
    10,
  );
  if (Number.isFinite(length)) {
    if (length < MIN_COMPRESS_BYTES || length > MAX_COMPRESS_BYTES) {
      return response;
    }
    return compressResponse(
      response,
      new Uint8Array(await response.arrayBuffer()),
    );
  }

  if (!response.body) return response;
  const capped = await readCapped(
    response.body,
    MAX_COMPRESS_BYTES,
    COMPRESS_WAIT_MS,
  );
  if (!capped.done || capped.total < MIN_COMPRESS_BYTES) {
    return reattachBody(response, capped);
  }
  return compressResponse(response, joinChunks(capped.chunks, capped.total));
}
