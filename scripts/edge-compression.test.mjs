// Tests de la compresion on-the-fly del borde (server/edgeCompression.mjs).
//
// lo que se prueba aqui son los dos fallos caros de este codigo, y los dos
// son silenciosos: el cliente no ve un error, ve un cuerpo mas corto.
//
// 1. perder un chunk. al leer con tope, lo ya leido va primero en el cuerpo
//    re-colgado; sin eso una descarga de 9 MB llegaba como sus ultimos 600 KB.
// 2. esperar demasiado. sin content-length (que es justo lo que pasa con todo
//    lo que sirve mochi) hay que decidir leyendo, asi que el tope tiene que
//    existir en bytes Y en tiempo, o un stream lento se queda sin primer byte.
import { describe, expect, test } from "bun:test";
import {
  acceptsEncoding,
  COMPRESS_WAIT_MS,
  maybeCompressResponse,
  MAX_COMPRESS_BYTES,
  readCapped,
  reattachBody,
} from "../server/edgeCompression.mjs";

function req(headers = {}) {
  return {
    method: "GET",
    headers: new Headers({ "accept-encoding": "gzip, deflate, br", ...headers }),
  };
}

function textResponse(body, headers = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/javascript", ...headers },
  });
}

async function readAll(response) {
  return new Uint8Array(await new Response(response.body).arrayBuffer());
}

/** texto repetitivo: comprime bien, para que el tamano sea facil de comparar */
function repeatable(size) {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = 32 + ((i * 7) % 60);
  return out;
}

describe("acceptsEncoding", () => {
  test("respeta el q=0", () => {
    expect(acceptsEncoding("gzip, deflate, br", "gzip")).toBe(true);
    expect(acceptsEncoding("gzip;q=0, deflate", "gzip")).toBe(false);
    expect(acceptsEncoding("identity", "gzip")).toBe(false);
    expect(acceptsEncoding("", "gzip")).toBe(false);
    expect(acceptsEncoding("GZIP", "gzip")).toBe(true);
  });
});

describe("maybeCompressResponse", () => {
  test("comprime un asset sin content-length (el caso de mochi)", async () => {
    const original = repeatable(80_000);
    const out = await maybeCompressResponse(req(), textResponse(original));
    expect(out.headers.get("content-encoding")).toBe("gzip");
    expect(out.headers.get("vary")?.toLowerCase()).toContain("accept-encoding");
    const body = await readAll(out);
    expect(body.byteLength).toBeLessThan(original.byteLength / 2);
    // el navegador tiene que recibir exactamente el mismo JS
    expect(new Uint8Array(Bun.gunzipSync(body))).toEqual(original);
  });

  test("sin content-length, cuerpo entero pero pequeño: pasa tal cual", async () => {
    const original = repeatable(500);
    const out = await maybeCompressResponse(req(), textResponse(original));
    expect(out.headers.get("content-encoding")).toBe(null);
    expect(await readAll(out)).toEqual(original);
  });

  test("un 206 no se toca (recomprimir un Range lo corrompe)", async () => {
    const original = repeatable(80_000);
    const partial = new Response(original, {
      status: 206,
      headers: { "content-type": "application/javascript" },
    });
    const out = await maybeCompressResponse(req(), partial);
    expect(out.status).toBe(206);
    expect(out.headers.get("content-encoding")).toBe(null);
  });

  test("HEAD no se comprime (mentiria en Content-Length)", async () => {
    const out = await maybeCompressResponse(
      { method: "HEAD", headers: new Headers({ "accept-encoding": "gzip" }) },
      textResponse(repeatable(80_000), { "content-length": "80000" }),
    );
    expect(out.headers.get("content-encoding")).toBe(null);
  });

  test("lo que ya viene comprimido no se vuelve a comprimir", async () => {
    const out = await maybeCompressResponse(
      req(),
      textResponse(repeatable(80_000), { "content-encoding": "br" }),
    );
    expect(out.headers.get("content-encoding")).toBe("br");
  });

  test("un binario (unity .data, imagen) no se toca", async () => {
    const original = repeatable(80_000);
    const out = await maybeCompressResponse(
      req(),
      new Response(original, {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
    expect(out.headers.get("content-encoding")).toBe(null);
    expect(await readAll(out)).toEqual(original);
  });

  test("si el cliente no acepta gzip, no se comprime", async () => {
    const original = repeatable(80_000);
    const out = await maybeCompressResponse(
      req({ "accept-encoding": "identity" }),
      textResponse(original),
    );
    expect(out.headers.get("content-encoding")).toBe(null);
    expect(await readAll(out)).toEqual(original);
  });

  test("lo que no compensa comprimir vuelve entero, no vacio", async () => {
    // aleatorio de verdad: comprimirlo lo hace MAS grande, y el camino de
    // content-length es el que lo declaraba
    const random = crypto.getRandomValues(new Uint8Array(20_000));
    const out = await maybeCompressResponse(
      req(),
      textResponse(random, { "content-length": String(random.byteLength) }),
    );
    expect(out.headers.get("content-encoding")).toBe(null);
    // un Response con el cuerpo ya consumido llegaria vacio al cliente
    expect(await readAll(out)).toEqual(random);
  });
});

describe("cuerpo que no cabe en el tope", () => {
  test("se entrega entero y en el mismo orden (chunked de 9 MB)", async () => {
    const total = MAX_COMPRESS_BYTES + 400_000;
    const original = repeatable(total);
    // el stream llega a trozos, como uno de verdad
    const body = new ReadableStream({
      start(controller) {
        for (let at = 0; at < total; at += 128 * 1024) {
          controller.enqueue(original.slice(at, at + 128 * 1024));
        }
        controller.close();
      },
    });
    const out = await maybeCompressResponse(
      req(),
      textResponse(body),
    );
    expect(out.headers.get("content-encoding")).toBe(null);
    const received = await readAll(out);
    // el bug que motivo este test: se perdia todo lo leido antes del tope
    expect(received.byteLength).toBe(total);
    expect(received).toEqual(original);
  }, 30_000);

  test("un stream lento no espera al tope de bytes", async () => {
    // 3 trozos de 64 KB con un byte distinto cada uno, para poder comprobar
    // el orden: 192 KB en 180 ms no llenan nunca el tope de 4 MB
    const parts = [65, 66, 67].map((byte) => new Uint8Array(64 * 1024).fill(byte));
    const body = new ReadableStream({
      async start(controller) {
        for (const part of parts) {
          await Bun.sleep(60);
          controller.enqueue(part);
        }
        controller.close();
      },
    });
    const started = Date.now();
    const capped = await readCapped(body, MAX_COMPRESS_BYTES, COMPRESS_WAIT_MS);
    // con el tope de 4 MB habria esperado a que terminase; con el reloj no:
    // se devuelve a los 150 ms con el read() en vuelo
    expect(capped.done).toBe(false);
    expect(capped.pending).not.toBe(null);
    expect(Date.now() - started).toBeLessThan(400);

    const out = reattachBody(textResponse(new Uint8Array(0)), capped);
    const received = await readAll(out);
    const expected = new Uint8Array(parts.flatMap((part) => [...part]));
    expect(received.byteLength).toBe(expected.byteLength);
    expect(received).toEqual(expected);
  }, 30_000);

});
