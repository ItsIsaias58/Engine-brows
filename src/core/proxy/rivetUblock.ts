interface InstalledExtension {
  id: string;
  name: string;
  enabled: boolean;
}

export interface RivetExtensionInstaller {
  getInstalledExtensions(): readonly InstalledExtension[];
  installExtension(buffer: ArrayBuffer, filename: string): Promise<string>;
  setExtensionEnabled(extId: string, enabled: boolean): Promise<void>;
}

const UBLOCK_ORIGIN_EXTENSION_URL = "/b/rivet/ublock.crx";
const UBLOCK_CACHE_KEY = "ublock.crx";
const UBLOCK_MIN_CRX_BYTES = 100_000;

// ponytail: single key->buffer store; add an object store per asset type if more get cached later
let cacheDb: Promise<IDBDatabase> | null = null;

function getRivetCache(): Promise<IDBDatabase> {
  if (cacheDb) return cacheDb;
  cacheDb = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("lyra-rivet-cache", 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("assets")) {
        request.result.createObjectStore("assets");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    cacheDb = null;
    throw error;
  });
  return cacheDb;
}

async function readCachedAsset(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await getRivetCache();
    return await new Promise<ArrayBuffer | null>((resolve) => {
      const valueRequest = db
        .transaction("assets", "readonly")
        .objectStore("assets")
        .get(key);
      valueRequest.onsuccess = () =>
        resolve(
          valueRequest.result instanceof ArrayBuffer
            ? valueRequest.result
            : null,
        );
      valueRequest.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function writeCachedAsset(key: string, value: ArrayBuffer): Promise<void> {
  try {
    const db = await getRivetCache();
    await new Promise<void>((resolve) => {
      const writeRequest = db
        .transaction("assets", "readwrite")
        .objectStore("assets")
        .put(value, key);
      writeRequest.onsuccess = () => resolve();
      writeRequest.onerror = () => resolve();
    });
  } catch {}
}

export async function ensureUblockOrigin(
  rivet: RivetExtensionInstaller,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const existing = rivet
    .getInstalledExtensions()
    .find((extension) => extension.name.trim().toLowerCase() === "ublock origin");
  if (existing) {
    if (!existing.enabled) await rivet.setExtensionEnabled(existing.id, true);
    return existing.id;
  }

  const cached = await readCachedAsset(UBLOCK_CACHE_KEY);
  if (cached && cached.byteLength >= UBLOCK_MIN_CRX_BYTES) {
    return rivet.installExtension(cached, "ublock.crx");
  }

  const response = await fetchImpl(UBLOCK_ORIGIN_EXTENSION_URL);
  if (!response.ok) {
    console.warn(
      `[rivet] ublock origin asset is unavailable (${response.status}); running without it`,
    );
    return "";
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength < UBLOCK_MIN_CRX_BYTES) {
    console.warn("[rivet] ublock origin asset is suspiciously small; ignoring");
    return "";
  }
  void writeCachedAsset(UBLOCK_CACHE_KEY, buffer);
  return rivet.installExtension(buffer, "ublock.crx");
}