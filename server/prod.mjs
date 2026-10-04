import dotenv from "dotenv";
dotenv.config();

import fs from "fs";
import net from "net";
import path from "path";
import { availableParallelism, totalmem } from "os";
import { httpError } from "./errors.mjs";
import { safeJoin as resolveUnderRoot } from "./staticPath.mjs";
import { maybeCompressResponse } from "./edgeCompression.mjs";
import {
  MARKET_WS_PATH,
  isCloudSyncPath,
  isMarketApiPath,
  isOwnGamesPath,
} from "./serviceRoutes.mjs";
import {
  NEGATIVE,
  negativeMessage,
  positiveMessage,
} from "../src/core/runtime/messages.ts";
import {
  createSearchSuggestionService,
  normalizeSearchSuggestionQuery,
  SEARCH_SUGGESTION_PROVIDER,
} from "./searchSuggestions.mjs";
import { createSourceBuildId } from "../build-id.mjs";
import {
  distCacheControl,
  IMMUTABLE_CACHE_CONTROL,
  NO_STORE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
} from "./cache.mjs";

let shuttingDown = false;

const ROOT = process.cwd();
const PORT = Number.parseInt(process.env.PORT || "4444", 10);
const TURN_HEALTH_HOST = process.env.TURN_HEALTH_HOST || "127.0.0.1";
const TURN_HEALTH_PORT = Number.parseInt(process.env.TURN_PORT || "3478", 10);
const TURN_HEALTH_TIMEOUT_MS = 2_000;
const packageJsonPath = path.join(ROOT, "package.json");
const distPath = path.join(ROOT, "dist");
const publicPath = path.join(ROOT, "public");
const baremuxPath = path.join(
  ROOT,
  "node_modules",
  "@mercuryworkshop",
  "bare-mux",
  "dist",
);
const epoxyPath = path.join(
  ROOT,
  "node_modules",
  "@mercuryworkshop",
  "epoxy-transport",
  "dist",
);
const libcurlPath = path.join(
  ROOT,
  "node_modules",
  "@mercuryworkshop",
  "libcurl-transport",
  "dist",
);

const MOCHI_ORIGIN = (() => {
  try {
    return new URL(
      process.env.MOCHI_ORIGIN ||
        `http://127.0.0.1:${process.env.MOCHI_PORT || "4002"}`,
    );
  } catch {
    return new URL("http://127.0.0.1:4002");
  }
})();
const WISP_ORIGIN = (() => {
  try {
    return new URL(
      process.env.NURU_ORIGIN ||
        `http://127.0.0.1:${process.env.NURU_PORT || "4001"}`,
    );
  } catch {
    return new URL("http://127.0.0.1:4001");
  }
})();
// límite duro del proxy de juegos (mochi). 0 = sin timeout: /stream/ y las
// descargas largas viven más que cualquier techo fijo (a los 70 s el proxy
// mataba streams y descargas a media transferencia con un 503). seguir
// desconectando cuando el cliente se va: eso lo hace req.signal (abort),
// no este reloj.
const MOCHI_PROXY_TIMEOUT_MS = Number.parseInt(process.env.MOCHI_PROXY_TIMEOUT_MS || "0", 10) || 0;
const MOCHI_PROXY_PATHS = ["/!!/", "/!!raw/", "/!!folio/", "/!cover!/", "/stream/"];
// cloudsync lleva las cuentas y la nube. dev.mjs ya lo enrutaba (por eso en
// `bun run dev` crear cuenta funcionaba) pero prod.mjs no: /api/auth/register
// se caia en el 404 del servidor y el cliente solo podia mostrar "account
// creation failed". con `bun run start` — que es prod — las cuentas no
// existian, y el servidor no decia nada que lo delatara: un 404 de una ruta
// que nunca se dio de alta es indistinguible de una que no existe.
const CLOUDSYNC_ORIGIN = (() => {
  try {
    return new URL(
      process.env.CLOUDSYNC_ORIGIN ||
        `http://127.0.0.1:${process.env.CLOUDSYNC_PORT || "4005"}`,
    );
  } catch {
    return new URL("http://127.0.0.1:4005");
  }
})();
const MARKET_ORIGIN = (() => {
  try {
    return new URL(
      process.env.MARKET_ORIGIN ||
        `http://127.0.0.1:${process.env.MARKET_PORT || "4006"}`,
    );
  } catch {
    return new URL("http://127.0.0.1:4006");
  }
})();
const API_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const HOST_CORES = Math.max(1, availableParallelism());
const HOST_MEMORY_BYTES = Math.max(256 * 1024 * 1024, totalmem());
const API_LIMIT_MAX = HOST_CORES * 250;
const API_LIMIT_MAX_CLIENTS = Math.max(2_000, Math.floor(HOST_MEMORY_BYTES / (1024 * 1024)) * 8);
const apiHits = new Map();
const searchSuggestionService = createSearchSuggestionService();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

// extensiones que el build precomprime a disco (.br/.gz) para no comprimir en
// caliente: es lo que decide si un asset estatico ya tiene version preparada
const COMPRESSIBLE = /\.(js|css|html|mjs|json|svg|xml|txt|map|wasm)$/i;
const ENCODING_MAP = [
  { token: "br", ext: ".br" },
  { token: "gzip", ext: ".gz" },
];

let packageData = null;
try {
  packageData = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
} catch {}

function turnConfigForRequest(req) {
  if (process.env.WEBRTC_TURN_ENABLED === "0") {
    return { enabled: false, forceRelay: false, iceServers: [] };
  }
  const host =
    process.env.TURN_HOST ||
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().split(":")[0] ||
    req.headers.get("host")?.split(":")[0] ||
    "lyra.lat";
  const port = process.env.TURN_PORT || "3478";
  const username = process.env.TURN_USERNAME || "lyly";
  const credential = process.env.TURN_CREDENTIAL || "rara";
  return {
    enabled: true,
    forceRelay: process.env.WEBRTC_FORCE_RELAY !== "0",
    iceServers: [
      {
        urls: [
          `turn:${host}:${port}?transport=udp`,
          `turn:${host}:${port}?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
  };
}

// build-meta.json lo escribe el build. leerlo solo al arrancar dejaba al
// servidor announces un build que ya no existe en disco: /api/stuff seguiria
// devolviendo el id viejo y, como el namespace del cache de localStorage sale
// de ahi, ningun rebuild invalidaba el cache. se relee cuando el mtime cambia.
let buildMetaCache = { mtimeMs: -1, meta: {} };

function readBuildMeta() {
  for (const dir of ["dist", "src"]) {
    try {
      const metaPath = path.join(ROOT, dir, "build-meta.json");
      const { mtimeMs } = fs.statSync(metaPath);
      if (mtimeMs === buildMetaCache.mtimeMs) return buildMetaCache.meta;
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      if (meta && typeof meta === "object") {
        buildMetaCache = { mtimeMs, meta };
        return meta;
      }
    } catch {}
  }
  return buildMetaCache.meta;
}

function currentBuildFingerprint() {
  const fallback = packageData?.version || "unknown";
  const build = readBuildMeta().build;

  if (typeof build === "string" && build.length > 0) {
    return build;
  }

  try {
    return createSourceBuildId(ROOT);
  } catch {
    return fallback;
  }
}

// the wisp endpoint is always served by this server and relayed to nuru, so the
// browser never needs direct access to the internal service ports.
function isWispPath(pathname) {
  const metaWispPath = readBuildMeta().wispPath;
  const configured =
    typeof metaWispPath === "string" && metaWispPath.length > 0
      ? metaWispPath
      : process.env.LYRA_WISP_PATH;
  const wispPaths = ["/w/"];
  if (typeof configured === "string" && configured.startsWith("/")) {
    const normalized = configured.endsWith("/") ? configured : `${configured}/`;
    // a custom path is a deliberate hardening step: do not also accept /w/
    if (normalized !== "/w/") wispPaths.splice(0, wispPaths.length, normalized);
  }
  for (const prefix of wispPaths) {
    if (pathname === prefix.slice(0, -1) || pathname.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function baseHeaders(cacheControl, extra = {}) {
  return {
    "Cache-Control": cacheControl,
    // same-origin-allow-popups (no same-origin): los flujos OAuth (login de
    // spotify por popup) mueren con COOP estricto porque el popup pierde el
    // opener. esto mantiene casi todo el aislamiento sin romperlos.
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    // sin COEP a propósito: credentialless obliga a los iframes cruzados
    // (spotify/youtube embeds) a cargar SIN cookies -> el login de spotify
    // se quedaba en gris. nadie en el código usa SharedArrayBuffer, así
    // que el aislamiento no compensa romper los embeds.
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains; preload",
    ...extra,
  };
}

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function safeJoin(root, pathname, prefix = "") {
  if (prefix && pathname !== prefix.slice(0, -1) && !pathname.startsWith(prefix)) {
    return null;
  }

  return resolveUnderRoot(root, prefix ? pathname.slice(prefix.length) : pathname);
}

async function existingFile(filePath) {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  try {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) return null;
    return {
      file,
      etag: `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`,
      lastModified: stats.mtime.toUTCString(),
    };
  } catch {
    return null;
  }
}

function isNotModified(req, file) {
  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch) {
    return (
      ifNoneMatch === "*" ||
      ifNoneMatch.split(",").some((value) => value.trim() === file.etag)
    );
  }

  const ifModifiedSince = req.headers.get("if-modified-since");
  if (!ifModifiedSince) return false;
  const modifiedSince = Date.parse(ifModifiedSince);
  const lastModified = Date.parse(file.lastModified);
  return (
    Number.isFinite(modifiedSince) &&
    Number.isFinite(lastModified) &&
    lastModified <= modifiedSince
  );
}

async function serveFile(req, filePath, cacheControl, options = {}) {
  const accept = req.headers.get("accept-encoding") || "";
  const canPrecompress = options.precompressed !== false && COMPRESSIBLE.test(filePath);

  if (canPrecompress) {
    for (const { token, ext } of ENCODING_MAP) {
      if (!accept.includes(token)) continue;
      const encodedPath = `${filePath}${ext}`;
      const encodedFile = await existingFile(encodedPath);
      if (!encodedFile) continue;
      const headers = baseHeaders(cacheControl, {
        "Content-Type": options.type || contentType(filePath),
        "Content-Encoding": token,
        Vary: "Accept-Encoding",
        ETag: encodedFile.etag,
        "Last-Modified": encodedFile.lastModified,
        ...options.headers,
      });
      if (
        cacheControl !== NO_STORE_CACHE_CONTROL &&
        (options.status || 200) === 200 &&
        isNotModified(req, encodedFile)
      ) {
        return new Response(null, { status: 304, headers });
      }
      return new Response(req.method === "HEAD" ? null : encodedFile.file, {
        status: options.status || 200,
        headers: {
          ...headers,
          "Content-Length": String(encodedFile.file.size),
        },
      });
    }
  }

  const file = await existingFile(filePath);
  if (!file) return null;
  const headers = baseHeaders(cacheControl, {
    "Content-Type": options.type || contentType(filePath),
    ...(canPrecompress ? { Vary: "Accept-Encoding" } : {}),
    ETag: file.etag,
    "Last-Modified": file.lastModified,
    ...options.headers,
  });
  if (
    cacheControl !== NO_STORE_CACHE_CONTROL &&
    (options.status || 200) === 200 &&
    isNotModified(req, file)
  ) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(req.method === "HEAD" ? null : file.file, {
    status: options.status || 200,
    headers: {
      ...headers,
      "Content-Length": String(file.file.size),
    },
  });
}

async function serveMounted(req, pathname, prefix, root, cacheControl) {
  if (pathname === prefix.slice(0, -1) || pathname.endsWith("/")) return null;
  const filePath = safeJoin(root, pathname, prefix);
  if (!filePath) return null;
  return serveFile(req, filePath, cacheControl);
}

async function serveDistFile(req, pathname) {
  if (pathname === "/" || pathname.endsWith("/")) return null;
  const filePath = safeJoin(distPath, pathname);
  if (!filePath) return null;
  return serveFile(req, filePath, distCacheControl(pathname), {
    headers: req.headers.get("service-worker") === "script"
      ? { "Service-Worker-Allowed": "/f" }
      : undefined,
  });
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    }),
  });
}

function healthResponse(status = 200) {
  return new Response("oki", {
    status,
    headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
      "Content-Type": "text/plain; charset=utf-8",
    }),
  });
}

function probeEturnal() {
  if (!Number.isInteger(TURN_HEALTH_PORT) || TURN_HEALTH_PORT < 1 || TURN_HEALTH_PORT > 65_535) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ host: TURN_HEALTH_HOST, port: TURN_HEALTH_PORT });
    let settled = false;
    const finish = (healthy) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(healthy);
    };

    socket.setTimeout(TURN_HEALTH_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

function getClientIp(req, server) {
  const peer = server.requestIP(req)?.address || "";
  const loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (loopback) {
    const real = req.headers.get("x-real-ip");
    if (real) return real.trim();
    const forwarded = req.headers.get("x-forwarded-for");
    if (forwarded) return forwarded.split(",", 1)[0].trim();
  }
  return peer || "unknown";
}

function rateLimitApi(req, server) {
  const now = Date.now();
  const ip = getClientIp(req, server);
  const state = apiHits.get(ip);

  if (!state || now - state.start > API_LIMIT_WINDOW_MS) {
    if (!state && apiHits.size >= API_LIMIT_MAX_CLIENTS) {
      const oldestIp = apiHits.keys().next().value;
      if (oldestIp !== undefined) apiHits.delete(oldestIp);
    }
    apiHits.set(ip, { start: now, count: 1 });
    return null;
  }

  state.count += 1;
  if (state.count <= API_LIMIT_MAX) return null;

  const failure = httpError(
    429,
    "RATE_LIMITED",
    "too many requests, please try again later",
  );
  return jsonResponse(failure.body, failure.status, {
    "RateLimit-Limit": String(API_LIMIT_MAX),
    "RateLimit-Remaining": "0",
    "RateLimit-Reset": String(Math.ceil((state.start + API_LIMIT_WINDOW_MS) / 1000)),
  });
}

setInterval(() => {
  const cutoff = Date.now() - API_LIMIT_WINDOW_MS;
  for (const [ip, state] of apiHits) {
    if (state.start < cutoff) apiHits.delete(ip);
  }
}, API_LIMIT_WINDOW_MS).unref?.();

async function routeStatic(req, pathname) {
  if (pathname.toLowerCase().endsWith(".map")) return null;
  const versionedMounts = [
    ["/bmux/", baremuxPath],
    ["/epoxy/", epoxyPath],
    ["/libcurl/", libcurlPath],
  ];
  for (const [prefix, root] of versionedMounts) {
    const response = await serveMounted(
      req,
      pathname,
      `${prefix}${currentBuildFingerprint()}/`,
      root,
      IMMUTABLE_CACHE_CONTROL,
    );
    if (response) return response;
  }
  return (
    (await serveMounted(req, pathname, "/bmux/", baremuxPath, REVALIDATE_CACHE_CONTROL)) ||
    (await serveMounted(req, pathname, "/epoxy/", epoxyPath, REVALIDATE_CACHE_CONTROL)) ||
    (await serveMounted(req, pathname, "/libcurl/", libcurlPath, REVALIDATE_CACHE_CONTROL)) ||
    (await serveDistFile(req, pathname)) ||
    (await serveMounted(
      req,
      pathname,
      "/assets/",
      path.join(publicPath, "assets"),
      REVALIDATE_CACHE_CONTROL,
    ))
  );
}

function isMarketPath(pathname) {
  return (
    isOwnGamesPath(pathname) ||
    isMarketApiPath(pathname) ||
    pathname === MARKET_WS_PATH
  );
}

function marketUnavailableResponse() {
  return new Response(negativeMessage("the market service is unavailable"), {
    status: 503,
    headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Lyra-Error-Class": "infrastructure",
    }),
  });
}

function upgradeToMarket(req, server) {
  const upstream = upstreamUrlFor(req, MARKET_ORIGIN);
  try {
    return server.upgrade(req, {
      data: { upstreamUrl: upstream.href, protocols: "" },
    });
  } catch (error) {
    console.error("market upgrade failed:", error, NEGATIVE);
    return false;
  }
}

async function proxyToMarket(req) {
  const upstreamUrl = upstreamUrlFor(req, MARKET_ORIGIN);
  try {
    const hasBody =
      req.method !== "GET" && req.method !== "HEAD" && Boolean(req.body);
    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders(req),
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      redirect: "manual",
    });
    const responseHeaders = new globalThis.Headers(response.headers);
    for (const name of [
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
    ]) {
      responseHeaders.delete(name);
    }
    responseHeaders.set("x-lyra-proxy", "prod-market");
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("market proxy failed:", error, NEGATIVE);
    return marketUnavailableResponse();
  }
}

// mismo tratamiento que el mercado: reenviar tal cual y, si el servicio no esta,
// un 503 explicito. Un 404 o un 502 generico aqui se confunde con "el usuario se
// equivoco al escribir su nombre", que es justo el fallo que hay que evitar.
function cloudSyncUnavailableResponse() {
  return new Response(
    negativeMessage("the account service is unavailable"),
    {
      status: 503,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Lyra-Error-Class": "infrastructure",
      }),
    },
  );
}

async function handleCloudSyncRequest(req) {
  const upstreamUrl = upstreamUrlFor(req, CLOUDSYNC_ORIGIN);
  try {
    const hasBody =
      req.method !== "GET" && req.method !== "HEAD" && Boolean(req.body);
    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders(req),
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      redirect: "manual",
    });
    const responseHeaders = new globalThis.Headers(response.headers);
    for (const name of [
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
    ]) {
      responseHeaders.delete(name);
    }
    // la cookie de sesion que devuelve cloudsync es la que mantiene la cuenta
    // iniciada: se reenvia tal cual, con su Secure y su SameSite intactos, para
    // que el navegador decida igual que si la hubiera puesto cloudsync mismo
    responseHeaders.set("x-lyra-proxy", "prod-cloudsync");
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("cloudsync proxy failed:", error, NEGATIVE);
    return cloudSyncUnavailableResponse();
  }
}

async function handleMarketRequest(req, server) {
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (upgradeToMarket(req, server)) return undefined;
    return marketUnavailableResponse();
  }
  return proxyToMarket(req);
}

function isMochiPath(pathname) {
  return (
    !pathname.startsWith("/stream/anime") &&
    MOCHI_PROXY_PATHS.some((prefix) => pathname.startsWith(prefix))
  );
}

// upgrade WebSocket en rutas mochi (/!!/): usa el relay generico de Bun
// (mismos handlers que el wisp; data-driven con upstreamUrl + protocols).
// el destino ya apunta a la ruta /!!/ws/<target> del propio mochi.
function upgradeToMochiWs(req, server) {
  const upstream = upstreamUrlFor(req, MOCHI_ORIGIN);
  const protocols = req.headers.get("sec-websocket-protocol") || "";
  try {
    return server.upgrade(req, {
      data: { upstreamUrl: upstream.href, protocols },
    });
  } catch (error) {
    console.error("mochi ws upgrade failed:", error, NEGATIVE);
    return false;
  }
}

async function proxyToMochi(req) {
  const upstreamUrl = new URL(req.url);
  upstreamUrl.protocol = MOCHI_ORIGIN.protocol;
  upstreamUrl.host = MOCHI_ORIGIN.host;
  upstreamUrl.username = MOCHI_ORIGIN.username;
  upstreamUrl.password = MOCHI_ORIGIN.password;

  const headers = new globalThis.Headers(req.headers);
  for (const name of [
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }
  headers.set("x-forwarded-host", req.headers.get("host") || "");

  // OBLIGATORIO identity: reqwest (mochi) decodifica gzip/br del upstream pero
  // reenvia el header content-encoding tal cual -> el cliente recibe "gzip" +
  // body en claro y muere con "TypeError: network error" al descomprimir.
  // La compresion real la hace maybeCompressResponse en este borde.
  headers.set("accept-encoding", "identity");

  const controller = new AbortController();
  let responseReader;
  let bodyOwnsLifecycle = false;
  const abortRequest = () => {
    controller.abort();
    void responseReader?.cancel().catch(() => {});
  };
  const abortOnDisconnect = () => abortRequest();
  req.signal.addEventListener("abort", abortOnDisconnect, { once: true });
  if (req.signal.aborted) abortOnDisconnect();
  const timeout = MOCHI_PROXY_TIMEOUT_MS > 0 ? setTimeout(abortRequest, MOCHI_PROXY_TIMEOUT_MS) : null;
  const cleanup = () => {
    if (timeout) clearTimeout(timeout);
    req.signal.removeEventListener("abort", abortOnDisconnect);
  };

  try {
    const hasBody =
      req.method !== "GET" && req.method !== "HEAD" && Boolean(req.body);
    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      // ponytail: streaming bodies need duplex:"half", otherwise the fetch
      // throws and every POST to the game proxy failed with a 503
      ...(hasBody ? { body: req.body, duplex: "half" } : {}),
      redirect: "manual",
      signal: controller.signal,
    });
    const responseHeaders = new globalThis.Headers(response.headers);
    for (const name of [
      "connection",
      "content-encoding",
      "content-length",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
    ]) {
      responseHeaders.delete(name);
    }
    responseHeaders.set("x-lyra-proxy", "prod-mochi");

    let body = null;
    if (req.method !== "HEAD" && response.body) {
      responseReader = response.body.getReader();
      body = new globalThis.ReadableStream({
        async pull(streamController) {
          try {
            const { done, value } = await responseReader.read();
            if (done) {
              cleanup();
              streamController.close();
              return;
            }
            streamController.enqueue(value);
          } catch (error) {
            cleanup();
            streamController.error(error);
          }
        },
        async cancel(reason) {
          cleanup();
          await responseReader.cancel(reason).catch(() => {});
        },
      });
    }

    const proxiedResponse = new Response(body, {
      status: response.status,
      headers: responseHeaders,
    });
    bodyOwnsLifecycle = body !== null;
    if (!bodyOwnsLifecycle) cleanup();
    // los assets que llegan comprimidos del origen se re-entregan tal cual;
    // lo que baja en claro se comprime aqui para no quemar el uplink
    return maybeCompressResponse(req, proxiedResponse);
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return new Response(
      aborted
        ? negativeMessage("the game proxy timed out; try again shortly")
        : negativeMessage("the game proxy is temporarily unavailable"),
      {
        status: 503,
        headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Lyra-Error-Class": aborted ? "network-timeout" : "infrastructure",
        }),
      },
    );
  } finally {
    if (!bodyOwnsLifecycle) cleanup();
  }
}

function upstreamUrlFor(req, origin) {
  const upstreamUrl = new URL(req.url);
  upstreamUrl.protocol = origin.protocol;
  upstreamUrl.host = origin.host;
  upstreamUrl.username = origin.username;
  upstreamUrl.password = origin.password;
  return upstreamUrl;
}

function upstreamHeaders(req, extra = {}) {
  const headers = new globalThis.Headers(req.headers);
  for (const name of [
    "connection",
    "content-length",
    "host",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(name);
  }
  headers.set("x-forwarded-host", req.headers.get("host") || "");
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

const WISP_PROBE_CACHE_MS = 2_000;
const WISP_PROBE_TIMEOUT_MS = 1_500;
let wispProbeAt = 0;
let wispProbeReachable = false;

// nuru accepts the websocket upgrade before it can be talked to, so a dead nuru
// would look "connected" to the client health check. Probe it first.
async function wispOriginReachable() {
  const now = Date.now();
  if (now - wispProbeAt < WISP_PROBE_CACHE_MS) return wispProbeReachable;

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    WISP_PROBE_TIMEOUT_MS,
  );
  try {
    await fetch(new URL("/", WISP_ORIGIN), {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });
    wispProbeReachable = true;
  } catch {
    wispProbeReachable = false;
  } finally {
    clearTimeout(timeout);
    wispProbeAt = Date.now();
  }
  return wispProbeReachable;
}

function upgradeToWisp(req, server) {
  const upstream = upstreamUrlFor(req, WISP_ORIGIN);
  const protocols = req.headers.get("sec-websocket-protocol") || "";
  try {
    return server.upgrade(req, {
      data: { upstreamUrl: upstream.href, protocols },
    });
  } catch (error) {
    console.error("wisp upgrade failed:", error, NEGATIVE);
    return false;
  }
}

function wispUnavailableResponse() {
  return new Response(negativeMessage("the wisp relay is unavailable"), {
    status: 503,
    headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Lyra-Error-Class": "infrastructure",
    }),
  });
}

async function handleWispRequest(req, server) {
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    if (!(await wispOriginReachable())) return wispUnavailableResponse();
    if (upgradeToWisp(req, server)) return undefined;
    return wispUnavailableResponse();
  }
  return proxyToWisp(req);
}

async function proxyToWisp(req) {
  const upstreamUrl = upstreamUrlFor(req, WISP_ORIGIN);
  try {
    const response = await fetch(upstreamUrl, {
      method: req.method,
      headers: upstreamHeaders(req),
      redirect: "manual",
    });
    const responseHeaders = new globalThis.Headers(response.headers);
    for (const name of [
      "connection",
      "content-length",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
    ]) {
      responseHeaders.delete(name);
    }
    responseHeaders.set("x-lyra-proxy", "prod-wisp");
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (error) {
    console.error("wisp relay failed:", error, NEGATIVE);
    return wispUnavailableResponse();
  }
}

async function appFetch(req, server) {
  const url = new URL(req.url);
  const pathname = url.pathname;

  if (isWispPath(pathname)) {
    return handleWispRequest(req, server);
  }

  if (isMarketPath(pathname)) {
    return handleMarketRequest(req, server);
  }

  if (isCloudSyncPath(pathname)) {
    return handleCloudSyncRequest(req);
  }

  if (shuttingDown) {
    if (pathname === "/health" || pathname === "/eturnal/health") {
      return healthResponse(503);
    }
    return new Response(negativeMessage("server is shutting down"), {
      status: 503,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
        "Content-Type": "text/plain; charset=utf-8",
      }),
    });
  }

  const method = req.method;
  const canServeBody = method === "GET" || method === "HEAD";

  if (pathname === "/health" && canServeBody) {
    return healthResponse();
  }

  if (pathname === "/eturnal/health" && canServeBody) {
    return healthResponse((await probeEturnal()) ? 200 : 503);
  }

  if (pathname.startsWith("/api/")) {
    const limited = rateLimitApi(req, server);
    if (limited) return limited;
  }

  // los WebSockets proxied no pueden ir por fetch (Bun.fetch no hace upgrades);
  // los puentamos a mochi con el MISMO relay generico del wisp (data-driven).
  if (
    isMochiPath(pathname) &&
    req.headers.get("upgrade")?.toLowerCase() === "websocket"
  ) {
    return upgradeToMochiWs(req, server);
  }

  if (isMochiPath(pathname)) return proxyToMochi(req);

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL),
    });
  }

  if (pathname === "/api/stuff" && method === "GET") {
    if (!packageData) {
      const failure = httpError(
        500,
        "SERVICE_METADATA_UNAVAILABLE",
        "service metadata is unavailable",
      );
      return jsonResponse(failure.body, failure.status);
    }
    return jsonResponse({
      version: packageData.version,
      build: currentBuildFingerprint(),
      turn: turnConfigForRequest(req),
    });
  }

  if (pathname === "/api/search/suggestions" && method === "GET") {
    const query = normalizeSearchSuggestionQuery(url.searchParams.get("q") || "");
    if (!query) {
      return jsonResponse({
        query: "",
        suggestions: [],
        provider: SEARCH_SUGGESTION_PROVIDER,
      });
    }

    try {
      const suggestions = await searchSuggestionService.get(query);
      return jsonResponse({
        query,
        suggestions,
        provider: SEARCH_SUGGESTION_PROVIDER,
      });
    } catch (error) {
      console.error("search suggestion request failed:", error, NEGATIVE);
      const failure = httpError(
        502,
        "SEARCH_SUGGESTIONS_UNAVAILABLE",
        "search suggestions are temporarily unavailable",
        { provider: SEARCH_SUGGESTION_PROVIDER },
      );
      return jsonResponse(failure.body, failure.status);
    }
  }

  if (!canServeBody) {
    return new Response(negativeMessage("method not allowed"), {
      status: 405,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
        "Content-Type": "text/plain; charset=utf-8",
        Allow: "GET, HEAD, OPTIONS",
      }),
    });
  }

  const staticResponse = await routeStatic(req, pathname);
  if (staticResponse) return staticResponse;

  if (pathname === "/" || pathname === "/s") {
    const response = await serveFile(
      req,
      path.join(distPath, "index.html"),
      NO_STORE_CACHE_CONTROL,
    );
    if (response) return response;
  }

  if (pathname === "/stream/anime") {
    const response = await serveFile(
      req,
      path.join(distPath, "player.html"),
      NO_STORE_CACHE_CONTROL,
    );
    if (response) return response;
  }

  // Enlace de navegacion folio (/f?s=... o /f/...) que el service worker no
  // alcanzo a interceptar (tipico: el redirect de un login OAuth aterriza aqui
  // en una pestaña donde el SW aun no controla). Un 404 muerto deja la sesion
  // colgada; este shell re-dispacha la MISMA url via fetch una vez que el SW
  // esta activo: ese fetch si pasa por el SW y routeDestination decodifica el
  // destino real. Si en 12s no hay SW, vuelve al inicio.
  if (pathname === "/f" || pathname.startsWith("/f/")) {
    const shell = `<!doctype html>
<html><head><meta charset="utf-8"><title>redirigiendo...</title></head>
<body style="background:#0e0e12;color:#8f8f9d;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0">
<div>retomando la sesion...</div>
<script>
(async () => {
  const t0 = Date.now();
  while (!(navigator.serviceWorker && navigator.serviceWorker.controller)) {
    if (Date.now() - t0 > 12000) { location.replace("/"); return; }
    try { await navigator.serviceWorker.ready; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    const res = await fetch(location.href, { redirect: "follow" });
    if (!res.ok) { location.replace("/"); return; }
    document.open(); document.write(await res.text()); document.close();
  } catch { location.replace("/"); }
})();
</script></body></html>`;
    return new Response(shell, {
      status: 200,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
        "Content-Type": "text/html; charset=utf-8",
      }),
    });
  }

  return (
    (await serveFile(req, path.join(distPath, "404.html"), NO_STORE_CACHE_CONTROL, {
      status: 404,
      type: "text/html; charset=utf-8",
    })) ||
    new Response(negativeMessage("not found"), {
      status: 404,
      headers: baseHeaders(NO_STORE_CACHE_CONTROL, {
        "Content-Type": "text/plain; charset=utf-8",
      }),
    })
  );
}

const accessLogEnabled = process.env.LYRA_ACCESS_LOG === "1";

async function logAccess(req, srv) {
  const started = performance.now();
  const response = await appFetch(req, srv);
  // an upgraded websocket returns undefined; Bun owns the connection now
  if (!response) return response;
  // compresion last-resort para rutas que no pasan por serveFile ni mochi
  // (market proxied, apis propias): nunca doble-comprime ni toca streams.
  // se resuelve ANTES del log: un return anticipado aqui deja el access log muerto
  const finalResponse = await maybeCompressResponse(req, response);
  if (accessLogEnabled) {
    const requestUrl = new URL(req.url);
    if (
      requestUrl.pathname !== "/health" &&
      requestUrl.pathname !== "/eturnal/health"
    ) {
      console.log(
        `${req.method} ${requestUrl.pathname}${requestUrl.search} ${finalResponse.status} ${Math.round(performance.now() - started)}ms ${srv.requestIP(req)?.address ?? "-"}`,
      );
    }
  }
  return finalResponse;
}

const server = Bun.serve({
  port: PORT,
  http2: true,
  idleTimeout: 60,
  fetch: logAccess,
  websocket: {
    // wisp sockets are long-lived and mostly idle between requests
    idleTimeout: 240,
    open(socket) {
      const { upstreamUrl, protocols } = socket.data;
      let upstream;
      try {
        upstream = protocols
          ? new WebSocket(
              upstreamUrl,
              protocols.split(",").map((value) => value.trim()),
            )
          : new WebSocket(upstreamUrl);
      } catch (error) {
        console.error("wisp upstream connection failed:", error, NEGATIVE);
        socket.close(1011, "wisp relay is unavailable");
        return;
      }
      upstream.binaryType = "arraybuffer";
      socket.data.upstream = upstream;
      // el cliente manda su CONNECT justo al abrir; si nuru aun no completa el
      // handshake, los frames se BUFERAN y se vacian en orden al abrir (antes se
      // descartaban y el socket moria en silencio: dealer de Spotify colgado)
      socket.data.pending = [];
      upstream.addEventListener("open", () => {
        const pending = socket.data.pending ?? [];
        socket.data.pending = null;
        for (const msg of pending) {
          try {
            upstream.send(msg);
          } catch {}
        }
      });
      upstream.addEventListener("message", (event) => {
        try {
          socket.send(event.data);
        } catch {}
      });
      upstream.addEventListener("close", (event) => {
        try {
          socket.close(event.code || 1000, event.reason || "");
        } catch {}
      });
      upstream.addEventListener("error", () => {
        // surface upstream failures so the client health check can react
        try {
          socket.close(1011, "wisp upstream error");
        } catch {}
      });
    },
    message(socket, message) {
      const upstream = socket.data.upstream;
      if (!upstream) return;
      if (upstream.readyState === WebSocket.CONNECTING) {
        const pending = (socket.data.pending ??= []);
        // cota de seguridad: un CONNECT y algo de trafico inicial, no un flood
        if (pending.length < 64) pending.push(message);
        return;
      }
      if (upstream.readyState !== WebSocket.OPEN) return;
      upstream.send(message);
    },
    close(socket, code, reason) {
      const upstream = socket.data.upstream;
      if (upstream && upstream.readyState <= WebSocket.OPEN) {
        try {
          upstream.close(code || 1000, reason || "");
        } catch {}
      }
      socket.data.upstream = null;
    },
  },
});

async function gracefulShutdown() {
  if (shuttingDown) process.exit(0);
  // PROTECCION ANTI-HUERFANOS: un SIGTERM solo es legitimo si serve.sh (nuestro
  // dueno) lo anuncio con stopping.flag que menciona NUESTRO pid de arranque
  // (LYRA_START_PID). Los SIGTERM de huérfanos de generaciones muertas con
  // PIDs reciclados se IGNORAN y quedan registrados en /tmp/orphan-kills.txt.
  try {
    const flag = fs.readFileSync("logs/stopping.flag", "utf8").trim();
    const myStart = process.env.LYRA_START_PID || "";
    if (flag !== myStart) {
      fs.appendFileSync(
        "/tmp/orphan-kills.txt",
        `[${new Date().toISOString()}] SIGTERM IGNORADO (flag=${flag || "vacio"}, inicio=${myStart})\n`
      );
      return;
    }
  } catch {}
  shuttingDown = true;
  console.log("\nshutting down");
  server.stop(true);
  console.log(positiveMessage(`port ${PORT} released`));
  process.exit(0);
}

// PROBE-TEMPORAL: deja constancia de cuándo llega una señal de apagado
// (registrado ANTES del handler de graceful shutdown para ganar la carrera)
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try {
      fs.appendFileSync(
        "/tmp/killer-snapshot.txt",
        `[${new Date().toISOString()}] ${sig} recibido; ppid=${process.ppid}\n`,
      );
    } catch {}
  });
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

console.log(positiveMessage(`prod server listening on ${server.port}`));
