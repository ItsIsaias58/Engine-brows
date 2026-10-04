import {
  createRivetFramePlugins,
  initializeRivet,
} from "./rivet";
import type { ProxyTransport } from "@mercuryworkshop/proxy-transports";
import { MochiTransport, resolveMochiOrigin } from "./mochiTransport";
import {
  hotAssetKey,
  hotCacheMaxAgeMs,
  hotCacheVariant,
  hotCacheVary,
  rawHeaderValue,
} from "./hotCache.ts";
import { negativeMessage } from "../runtime/messages.ts";
import { runtimeAssetPath } from "../runtime/build.ts";

type FolioControllerInstance = {
  wait(): Promise<void>;
  setServiceWorker(serviceWorker: ServiceWorker): void;
  setTransport(transport: unknown): void;
  createFrame(
    iframe: HTMLIFrameElement,
    options?: { plugins?: unknown[] },
  ): FolioFrameInstance;
};

type FolioFrameInstance = {
  prefix: string;
  go(url: string): void;
  destroy?(): void;
};

type FolioPageState = {
  client?: {
    hooks?: {
      lifecycle?: {
        navigate?: unknown;
      };
    };
    url?: {
      href?: string;
    };
    id?: string;
  };
  isTopLevel?: boolean;
  window?: Window;
};

type FolioControllerConstructor = new (init: {
  serviceworker: ServiceWorker;
  transport: unknown;
  config: {
    prefix: string;
    folioPath: string;
    injectPath: string;
    wasmPath: string;
    virtualWasmPath: string;
    codec: {
      encode(input: string): string;
      decode(input: string): string;
    };
  };
  folioConfig?: unknown;
}) => FolioControllerInstance;

type FolioRuntimeGlobals = {
  defaultConfigDev?: unknown;
  defaultConfig?: unknown;
  prewarmRewriter?: () => boolean;
};

interface FolioGlobals {
  Controller?: FolioControllerConstructor;
  ManagedPlugin?: new (name: string, dependencies: string[]) => {
    install(frame: unknown): void;
    tap(hook: unknown, callback: (...args: any[]) => void | Promise<void>): void;
  };
}

const FOLIO_PREFIX = "/f/";
const MOCHI_RAW_PREFIX = "/!!raw/";
const MOCHI_ACCELERATOR_TIMEOUT_MS = 8000;
const FOLIO_HOT_CACHE_MAX_ENTRY_BYTES = 2 * 1024 * 1024;
const FOLIO_HOT_CACHE_MAX_TOTAL_BYTES = 24 * 1024 * 1024;
const BODYLESS_STATUS = new Set([101, 204, 205, 304]);
const MOCHI_ACCELERATED_DESTINATIONS = new Set([
  "audio",
  "font",
  "image",
  "style",
  "track",
  "video",
]);
const frameByIframe = new WeakMap<HTMLIFrameElement, FolioFrameInstance>();
const observedFolioDocuments = new WeakSet<Document>();
const hotAssetCache = new Map<string, HotAssetEntry>();
const hotAssetPending = new Map<string, Promise<HotAssetEntry | null>>();
let hotAssetCacheBytes = 0;

let controller: FolioControllerInstance | null = null;
let readyPromise: Promise<FolioControllerInstance> | null = null;
let currentTransportKey = "";

function getControllerConstructor(): FolioControllerConstructor {
  const globals = (window as unknown as { $folioController?: FolioGlobals })
    .$folioController;
  if (!globals?.Controller) {
    throw new Error(negativeMessage("source-built folio controller is not loaded"));
  }
  return globals.Controller;
}

async function createTransport(name: string, wispUrl: string): Promise<ProxyTransport> {
  let fallback: ProxyTransport;
  if (name === "libcurl") {
    const transportPath = runtimeAssetPath("libcurl", "index.mjs");
    const mod = await import(/* @vite-ignore */ transportPath);
    const Transport = mod.default;
    fallback = new Transport({
      wisp: wispUrl,
      connections: [100, 80, 20],
    }) as ProxyTransport;
  } else {
    const transportPath = runtimeAssetPath("epoxy", "index.mjs");
    const mod = await import(/* @vite-ignore */ transportPath);
    const Transport = mod.default;
    fallback = new Transport({ wisp: wispUrl }) as ProxyTransport;
  }
  return new MochiTransport(fallback);
}

function folioRuntimeConfig() {
  return {
    prefix: FOLIO_PREFIX,
    folioPath: "/b/fl/folio.js",
    injectPath: "/b/fl/controller.inject.js",
    wasmPath: "/b/fl/folio.wasm",
    virtualWasmPath: "folio.wasm.js",
    codec: {
      encode: (input: string) => (input ? encodeURIComponent(input) : input),
      decode: (input: string) => (input ? decodeURIComponent(input) : input),
    },
  };
}

type MochiRawMeta = {
  status: number;
  status_text?: string;
  statusText?: string;
  url?: string;
  raw_headers?: [string, string][];
  rawHeaders?: [string, string][];
};

type HotAssetEntry = {
  body: ArrayBuffer;
  expiresAt: number;
  rawHeaders: [string, string][];
  size: number;
  status: number;
  statusText: string;
  url?: string;
};

function mochiRawBase(): string {
  const globals = window as unknown as {
    __MOCHI_BASE__?: string;
    MOCHI_BASE?: string;
  };
  const configured = globals.__MOCHI_BASE__ || globals.MOCHI_BASE;
  if (configured && configured.startsWith("http")) {
    return (
      configured
        .replace(/\/+$/, "")
        .replace(/\/!!raw$/, "")
        .replace(/\/!!$/, "") + MOCHI_RAW_PREFIX
    );
  }
  return window.location.origin + MOCHI_RAW_PREFIX;
}

function decodeBase64UrlJson<T>(value: string): T | null {
  try {
    let input = value.replace(/-/g, "+").replace(/_/g, "/");
    while (input.length % 4) input += "=";
    const bytes = Uint8Array.from(atob(input), (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null;
  }
}

function rawHeadersToHeaders(rawHeaders: [string, string][]): Headers {
  const headers = new Headers();
  for (const [key, value] of rawHeaders) {
    if (key.toLowerCase() === "set-cookie") continue;
    try {
      headers.append(key, value);
    } catch {}
  }
  return headers;
}

function rememberHotAsset(key: string, entry: HotAssetEntry): void {
  const existing = hotAssetCache.get(key);
  if (existing) hotAssetCacheBytes -= existing.size;
  hotAssetCache.set(key, entry);
  hotAssetCacheBytes += entry.size;

  for (const [oldestKey, oldest] of hotAssetCache) {
    if (hotAssetCacheBytes <= FOLIO_HOT_CACHE_MAX_TOTAL_BYTES) break;
    hotAssetCache.delete(oldestKey);
    hotAssetCacheBytes -= oldest.size;
  }
}

function getHotAsset(key: string): HotAssetEntry | null {
  const entry = hotAssetCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    hotAssetCache.delete(key);
    hotAssetCacheBytes -= entry.size;
    return null;
  }
  hotAssetCache.delete(key);
  hotAssetCache.set(key, entry);
  return entry;
}

function hotAssetToBareResponse(entry: HotAssetEntry, BareResponse: any): any {
  const nativeResponse = new Response(entry.body.slice(0), {
    status: entry.status,
    statusText: entry.statusText,
    headers: rawHeadersToHeaders(entry.rawHeaders),
  });
  const bareResponse = BareResponse.fromNativeResponse(nativeResponse);
  bareResponse.rawHeaders = entry.rawHeaders;
  if (entry.url) bareResponse.url = entry.url;
  return bareResponse;
}

/**
 * Cheap pre-check used to decide whether it is worth buffering an accelerated
 * response: only store candidates are buffered, everything else streams
 * straight through.
 */
function hotAssetContentLengthOk(rawHeaders: [string, string][]): boolean {
  const contentLength = Number.parseInt(
    rawHeaderValue(rawHeaders, "content-length") ?? "",
    10,
  );
  if (!Number.isFinite(contentLength)) return true;
  return contentLength <= FOLIO_HOT_CACHE_MAX_ENTRY_BYTES;
}

function storeHotAssetFromBuffer(
  key: string,
  body: ArrayBuffer,
  meta: MochiRawMeta,
  rawHeaders: [string, string][],
): HotAssetEntry | null {
  const maxAgeMs = hotCacheMaxAgeMs(rawHeaders);
  if (maxAgeMs <= 0 || meta.status !== 200 || BODYLESS_STATUS.has(meta.status)) {
    return null;
  }
  // una respuesta con Vary sobre un campo que la clave no distingue (Cookie,
  // User-Agent, ...) no se guarda: servirla a otra sesion seria filtrar datos
  // de un usuario a otro.
  if (!hotCacheVary(rawHeaders).cacheable) return null;
  if (body.byteLength > FOLIO_HOT_CACHE_MAX_ENTRY_BYTES) return null;

  const entry: HotAssetEntry = {
    body,
    expiresAt: Date.now() + maxAgeMs,
    rawHeaders,
    size: body.byteLength,
    status: meta.status,
    statusText: meta.status_text ?? meta.statusText ?? "",
    ...(meta.url === undefined ? {} : { url: meta.url }),
  };
  rememberHotAsset(key, entry);
  return entry;
}

function createMochiAcceleratorPlugin(): unknown {
  const controllerGlobals = (window as unknown as { $folioController?: FolioGlobals })
    .$folioController;
  const folioGlobals = (window as unknown as { $folio?: Record<string, any> })
    .$folio;
  const ManagedPlugin = controllerGlobals?.ManagedPlugin;
  const BareResponse = folioGlobals?.BareResponse;
  if (!ManagedPlugin || !BareResponse?.fromNativeResponse) return null;

  return new (class MochiAcceleratorPlugin extends ManagedPlugin {
    constructor() {
      super("mochi-accelerator", []);
    }

    override install(frame: any): void {
      super.install(frame);
      this.tap(frame.hooks.fetch.request, async (context: any, props: any) => {
        if (props.earlyResponse) return;
        const method = String(props.init?.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "HEAD") return;
        if (!MOCHI_ACCELERATED_DESTINATIONS.has(context.parsed?.destination)) {
          return;
        }
        const target = props.url;
        if (!(target instanceof URL)) return;
        if (target.protocol !== "http:" && target.protocol !== "https:") return;

        const requestHeaders = new Headers(props.init?.headers || []);
        // Range/partial content must pass through untouched to keep 206 semantics
        if (requestHeaders.has("range")) return;
        const cacheKey = hotAssetKey(method, target, hotCacheVariant(requestHeaders));

        const hotEntry = getHotAsset(cacheKey);
        if (hotEntry) {
          props.earlyResponse = hotAssetToBareResponse(hotEntry, BareResponse);
          return;
        }

        const inflight = hotAssetPending.get(cacheKey);
        if (inflight) {
          const entry = await inflight;
          if (entry && !props.earlyResponse) {
            props.earlyResponse = hotAssetToBareResponse(entry, BareResponse);
          }
          return;
        }

        const task = (async (): Promise<HotAssetEntry | null> => {
          const abort = new AbortController();
          const timeout = window.setTimeout(
            () => abort.abort(),
            MOCHI_ACCELERATOR_TIMEOUT_MS,
          );
          try {
            const upstreamHeaders = new Headers(requestHeaders);
            upstreamHeaders.delete("host");
            const rawResponse = await fetch(
              mochiRawBase() + encodeURIComponent(target.href),
              {
                method,
                headers: upstreamHeaders,
                cache: "no-store",
                credentials: "include",
                redirect: "manual",
                signal: abort.signal,
              },
            );
            const encodedMeta = rawResponse.headers.get("x-mochi-upstream-meta");
            if (!rawResponse.ok || !encodedMeta) return null;

            const meta = decodeBase64UrlJson<MochiRawMeta>(encodedMeta);
            const rawHeaders = meta?.raw_headers ?? meta?.rawHeaders;
            if (
              !meta ||
              !Number.isInteger(meta.status) ||
              meta.status < 200 ||
              meta.status > 599 ||
              !Array.isArray(rawHeaders)
            ) {
              return null;
            }

            // Read the body at most once. Handing `rawResponse.body` to the
            // earlyResponse and then calling `rawResponse.clone()` tees (and
            // therefore locks) that very same stream, which makes folio's own
            // body read fail with "body stream already read" (500) on the
            // first load of every accelerated resource. Buffer instead, and
            // only when the response is a hot-cache candidate.
            const bodyless = BODYLESS_STATUS.has(meta.status);
            const cacheCandidate =
              !bodyless &&
              meta.status === 200 &&
              hotCacheMaxAgeMs(rawHeaders) > 0 &&
              hotCacheVary(rawHeaders).cacheable &&
              hotAssetContentLengthOk(rawHeaders);
            let bodyBuffer: ArrayBuffer | null = null;
            if (cacheCandidate) {
              try {
                bodyBuffer = await rawResponse.arrayBuffer();
              } catch {
                bodyBuffer = null;
              }
            }

            if (!props.earlyResponse) {
              const body = bodyless ? null : (bodyBuffer ?? rawResponse.body);
              const nativeResponse = new Response(body, {
                status: meta.status,
                statusText: meta.status_text ?? meta.statusText ?? "",
                headers: rawHeadersToHeaders(rawHeaders),
              });
              const bareResponse = BareResponse.fromNativeResponse(nativeResponse);
              bareResponse.rawHeaders = rawHeaders;
              if (typeof meta.url === "string") bareResponse.url = meta.url;
              props.earlyResponse = bareResponse;
            }

            return bodyBuffer === null
              ? null
              : storeHotAssetFromBuffer(cacheKey, bodyBuffer, meta, rawHeaders);
          } catch {
            return null;
          } finally {
            window.clearTimeout(timeout);
          }
        })();

        // ponytail: dedupe the whole fetch (fetch+store), not just storeHotAsset;
        // waiters reuse the cache entry, first caller serves straight from the wire
        const pendingTask = task.finally(() => {
          if (hotAssetPending.get(cacheKey) === pendingTask) {
            hotAssetPending.delete(cacheKey);
          }
        });
        hotAssetPending.set(cacheKey, pendingTask);

        const entry = await task;
        if (entry && !props.earlyResponse) {
          props.earlyResponse = hotAssetToBareResponse(entry, BareResponse);
        }
      });
    }
  })();
}

function createFolioHttpCachePlugin(): unknown {
  const folioUtils = (window as unknown as {
    $folioUtils?: { HttpCachePlugin?: new (options?: { cacheName?: string }) => unknown };
  }).$folioUtils;
  if (!folioUtils?.HttpCachePlugin) return null;
  // ponytail: v4 name = invalidate cache entries cached while older builds
  // served truncated/corrupted bodies (wisp/mochi down mid-stream with 200s)
  return new folioUtils.HttpCachePlugin({
    cacheName: "folio-http-cache-v4",
  });
}

// `inPlace` cambia quien recibe los enlaces: por defecto se avisa a la app con
// "open-new-tab" y se abre una pestaña, que es lo correcto para el navegador de
// pestañas. El visor del overlay no puede hacer eso (abriria justo la ventana
// que el usuario pidio no abrir), asi que ahi el enlace navega el MISMO frame.
function createFolioLinkHandlerPlugins(
  iframe: HTMLIFrameElement,
  inPlace: { go: (url: string) => void } | null = null,
): unknown[] {
  const folioUtils = (window as unknown as {
    $folioUtils?: {
      LinkHandlerPlugin?: new (onNewTab: (url: string, active: boolean) => void) => unknown;
    };
  }).$folioUtils;
  if (!folioUtils?.LinkHandlerPlugin) return [];

  return [
    new folioUtils.LinkHandlerPlugin((url, active) => {
      if (inPlace) {
        inPlace.go(url);
        return;
      }
      window.postMessage(
        {
          type: "open-new-tab",
          url,
          decodedUrl: url,
          tabId: iframe.dataset.tabId ?? null,
          isTopFrame: true,
          cause: "folio-link-handler",
          active,
        },
        "*",
      );
    }),
  ];
}

function createFolioPageStatePlugin(iframe: HTMLIFrameElement): unknown {
  const controllerGlobals = (window as unknown as { $folioController?: FolioGlobals })
    .$folioController;
  const ManagedPlugin = controllerGlobals?.ManagedPlugin;
  if (!ManagedPlugin) return null;

  return new (class FolioPageStatePlugin extends ManagedPlugin {
    constructor() {
      super("folio-page-state", []);
    }

    override install(frame: any): void {
      super.install(frame);
      this.tap(frame.hooks.init.post, (context: FolioPageState) => {
        if (!context.isTopLevel || !context.window?.document) return;

        const win = context.window as Window & typeof globalThis & {
          __lyraFolioPageStateInstalled?: boolean;
        };
        const doc = win.document;
        // ponytail: key by document, not window, so navigations get a fresh observer on the new doc
        if (observedFolioDocuments.has(doc)) return;
        observedFolioDocuments.add(doc);
        let navigationVersion = iframe.dataset.navigationVersion;
        let pendingTimer: number | null = null;
        let lastSignature = "";

        const currentUrl = (fallback?: unknown): string => {
          const candidate =
            typeof fallback === "string"
              ? fallback
              : fallback instanceof win.URL
                ? fallback.href
              : context.client?.url?.href || win.location.href;
          try {
            return new URL(candidate, context.client?.url?.href || win.location.href).href;
          } catch {
            return String(candidate || "");
          }
        };

        const safeHistoryState = (): unknown => {
          const state = win.history.state;
          if (state === null || typeof state !== "object") return state;
          try {
            const json = JSON.stringify(state);
            return json.length > 32_768 ? { truncated: true } : JSON.parse(json);
          } catch {
            return { type: Object.prototype.toString.call(state) };
          }
        };

        const readFavicon = (): string | null => {
          const link = doc.querySelector<HTMLLinkElement>(
            'link[rel~="icon"][href], link[rel="shortcut icon"][href], link[rel*="icon"][href]',
          );
          const href = link?.getAttribute("href") || "/favicon.ico";
          try {
            return new URL(href, currentUrl()).href;
          } catch {
            return href || null;
          }
        };

        const readMemory = () => {
          const memory = (win.performance as Performance & {
            memory?: {
              usedJSHeapSize?: number;
              totalJSHeapSize?: number;
              jsHeapSizeLimit?: number;
            };
          }).memory;
          if (!memory || typeof memory.usedJSHeapSize !== "number") return null;
          return {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit,
          };
        };

        const emit = (reason: string, urlOverride?: unknown) => {
          const send = () => {
            if (iframe.dataset.navigationVersion !== navigationVersion) return;

            const url = currentUrl(urlOverride);
            const favicon = readFavicon();
            const title = doc.title || "";
            const historyLength = win.history.length;
            const historyState = safeHistoryState();
            const signature = JSON.stringify([
              url,
              title,
              favicon,
              historyLength,
              historyState,
              reason,
              win.navigation?.currentEntry?.key,
            ]);
            if (signature === lastSignature && reason !== "history-push") return;
            lastSignature = signature;

            const payload: Record<string, unknown> = {
              type: "page-meta",
              source: "folio",
              tabId: iframe.dataset.tabId || iframe.name || null,
              clientId: context.client?.id || null,
              isTopFrame: true,
              url,
              decodedUrl: url,
              href: url,
              title,
              favicon,
              rawFavicon: favicon,
              historyLength,
              historyState,
              navigationType: reason === "init"
                ? win.navigation?.activation?.navigationType ?? "load" : reason,
              historyKey: win.navigation?.currentEntry?.key,
              navigationVersion,
              history: {
                length: historyLength,
                state: historyState,
              },
            };

            const memory = readMemory();
            if (memory) payload.memory = memory;

            try {
              win.parent?.postMessage(payload, "*");
            } catch {}
          };
          if (reason !== "metadata") {
            send();
          } else if (pendingTimer === null) {
            pendingTimer = win.setTimeout(() => { pendingTimer = null; send(); }, 0);
          }
        };

        const wrapHistory = (method: "pushState" | "replaceState") => {
          const original = win.history[method];
          if (typeof original !== "function") return;
          try {
            (win.history as any)[method] = function (
              this: History,
              ...args: Parameters<History["pushState"]>
            ) {
              const result = original.apply(this, args);
              emit(method === "pushState" ? "history-push" : "history-replace", args[2]);
              return result;
            };
          } catch {}
        };

        if (win.navigation) {
          win.navigation.addEventListener("currententrychange", (event) => {
            emit(event.navigationType ?? "metadata");
          });
        } else {
          wrapHistory("pushState");
          wrapHistory("replaceState");
        }

        const observeHead = () => {
          const target = doc.head || doc.documentElement;
          if (!target || !win.MutationObserver) return;
          try {
            const observer = new win.MutationObserver(() => emit("metadata"));
            observer.observe(target, {
              attributeFilter: ["href", "rel"],
              attributes: true,
              characterData: true,
              childList: true,
              subtree: true,
            });
          } catch {}
        };

        observeHead();
        doc.addEventListener("DOMContentLoaded", () => emit("domcontentloaded"), {
          once: true,
        });
        win.addEventListener("load", () => emit("load"), { capture: true });
        win.addEventListener("pageshow", (event) => {
          if (event.persisted) navigationVersion = iframe.dataset.navigationVersion;
          emit(event.persisted ? "traverse" : "pageshow");
        }, { capture: true });
        win.addEventListener("popstate", () => emit("popstate"), { capture: true });
        win.addEventListener("hashchange", () => emit("hashchange"), { capture: true });

        emit("init");
      });
    }
  })();
}

export async function initializeFolioController(options: {
  serviceWorker: ServiceWorker;
  transport: string;
  wispUrl: string;
  refreshTransport?: boolean;
}): Promise<void> {
  const transportKey = `${options.transport}:${options.wispUrl}:${resolveMochiOrigin().href}`;
  if (
    readyPromise &&
    currentTransportKey === transportKey &&
    !options.refreshTransport
  ) {
    await readyPromise;
    controller?.setServiceWorker(options.serviceWorker);
    return;
  }

  currentTransportKey = transportKey;
  const pending = (async () => {
    const transport = await createTransport(options.transport, options.wispUrl);

    if (controller) {
      controller.setServiceWorker(options.serviceWorker);
      controller.setTransport(transport);
    } else {
      const Controller = getControllerConstructor();
      const folioGlobals = (window as unknown as {
        $folio?: FolioRuntimeGlobals;
      }).$folio;
      const nextController = new Controller({
        serviceworker: options.serviceWorker,
        transport,
        config: folioRuntimeConfig(),
        folioConfig:
          folioGlobals?.defaultConfig ?? folioGlobals?.defaultConfigDev,
      });
      await nextController.wait();
      controller = nextController;
      try {
        folioGlobals?.prewarmRewriter?.();
      } catch {}
    }

    await initializeRivet();

    const app = ((window as unknown as Record<string, unknown>)[
      "Lyra"
    ] ??= {}) as Record<string, unknown>;
    app.folioController = controller;
    app.navigateFolio = navigateFolioIframe;
    app.ensureFolioFrame = ensureFolioFrame;
    app.releaseFolioFrame = releaseFolioFrame;

    return controller;
  })();
  readyPromise = pending;

  try {
    await pending;
  } catch (error) {
    if (readyPromise === pending) {
      readyPromise = null;
      currentTransportKey = "";
    }
    throw error;
  }
}

async function waitForFolioController(
  timeoutMs = 10000,
): Promise<FolioControllerInstance> {
  if (!readyPromise) {
    throw new Error(negativeMessage("source-built folio is not initialized"));
  }
  const pending = readyPromise;
  return await new Promise<FolioControllerInstance>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(negativeMessage("source-built folio timed out"))),
      timeoutMs,
    );
    pending.then(
      (value) => {
        window.clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        window.clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function ensureFolioFrame(
  iframe: HTMLIFrameElement,
  options: { inPlaceLinks?: boolean } = {},
): Promise<FolioFrameInstance> {
  const existing = frameByIframe.get(iframe);
  if (existing) return existing;

  const ctrl = await waitForFolioController();
  const cachePlugin = createFolioHttpCachePlugin();
  const mochiPlugin = createMochiAcceleratorPlugin();
  const pageStatePlugin = createFolioPageStatePlugin(iframe);
  // el visor navega en el sitio, asi que necesita una referencia a SU propio
  // frame; se rellena justo despues de crearlo, y el plugin solo se dispara
  // cuando ya esta listo
  const inPlace = options.inPlaceLinks ? { go: (_url: string) => {} } : null;
  const linkHandlerPlugins = createFolioLinkHandlerPlugins(iframe, inPlace);
  const rivetPlugins = createRivetFramePlugins(
    (window as unknown as { $folioController?: FolioGlobals }).$folioController
      ?.ManagedPlugin,
    iframe,
  );
  const plugins = [
    cachePlugin,
    mochiPlugin,
    pageStatePlugin,
    ...linkHandlerPlugins,
    ...rivetPlugins,
  ].filter(Boolean);
  const frame = ctrl.createFrame(
    iframe,
    plugins.length > 0 ? { plugins } : undefined,
  );
  if (inPlace) {
    inPlace.go = (url: string) => {
      // se actualiza manualUrl tambien en los enlaces internos: el boton de
      // recargar del visor recarga lo que se esta viendo, no la pagina con la
      // que se abrio (que puede ser la home de spotify, no la playlist)
      iframe.dataset.manualUrl = url;
      frame.go(url);
    };
  }
  frameByIframe.set(iframe, frame);
  return frame;
}

export async function navigateFolioIframe(
  iframe: HTMLIFrameElement,
  url: string,
  shouldNavigate: () => boolean = () => true,
): Promise<void> {
  const frame = await ensureFolioFrame(iframe);
  if (!shouldNavigate()) return;
  iframe.dataset.manualUrl = url;
  frame.go(url);
}

/// Navegacion "en el mismo frame": sirve la pagina por el proxy de folio pero
/// resuelve los enlaces dentro del propio frame en vez de pedir una pestana
/// nueva. Lo usan las dos pantallas que hacen de navegador (el visor grande y
/// el panel de musica con la pagina completa), porque en las dos una pestana
/// nueva es justo lo que no debe pasar.
export async function navigateInPlaceFrame(
  iframe: HTMLIFrameElement,
  url: string,
): Promise<void> {
  const frame = await ensureFolioFrame(iframe, { inPlaceLinks: true });
  iframe.dataset.manualUrl = url;
  frame.go(url);
}

/// Cierra el frame: sin esto el folio seguiria vivo (con sus timers y su
/// cache) con una pantalla que ya nadie ve.
export function destroyInPlaceFrame(iframe: HTMLIFrameElement): void {
  releaseFolioFrame(iframe);
  delete iframe.dataset.manualUrl;
}

function releaseFolioFrame(iframe: HTMLIFrameElement): void {
  const frame = frameByIframe.get(iframe);
  frameByIframe.delete(iframe);
  frame?.destroy?.();
}
