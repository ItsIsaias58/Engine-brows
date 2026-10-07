import { svgIcon } from "../../core/ui/svgIcon";
import { negativeMessage } from "../../core/runtime/messages.ts";
import type { ToastController } from "../../core/ui/toast.ts";
import {
  closeManagedModal,
  isManagedModalOpen,
  openManagedModal,
} from "../../core/ui/modal.ts";
import {
  changedDuringUpload,
  exportNonIndexedDBParts,
  forgetIndexedDBName,
  isSensitiveSyncName,
  payloadFingerprint,
  rememberIndexedDBName,
  snapshotFingerprint,
  type SyncSnapshot,
} from "./syncSnapshot.ts";
import { cloudSyncModalHtml } from "./cloudsyncModal.ts";

interface SyncMeta {
  dirty: boolean;
  last_synced: string | null;
  fingerprint?: string | null;
}

interface AuthUser {
  username?: string;
  id?: string | number;
  [key: string]: unknown;
}

interface SessionData {
  user: AuthUser;
  [key: string]: unknown;
}

declare global {
  interface Window {
    lyraExportAllData?: () => Promise<SyncSnapshot>;
    lyraImportDataFromObject?: (
      data: unknown,
      callback?: (progressText: string) => void,
    ) => Promise<void>;
    bypassPreventClosing?: boolean;
  }
}

const POLL_INTERVAL = 20000;
const POLL_MAX_INTERVAL = 60000;
const DIRTY_DEBOUNCE = 1500;
// separacion minima entre escaneos+envios de verdad. Con una indexeddb grande
// (decenas de MB) cada corrida serializa todo el navegador en el hilo principal
// y satura la subida: sin este minimo, guardar el estado del juego cada 2 s
// disparaba un snapshot completo cada pocos segundos (microcongelados + ancho
// de banda). El debounce coalesce rafagas; esto separa los envios.
const MIN_UPLOAD_INTERVAL = 15000;
const SYNC_TIMEOUT = 60000;
// El escaneo completo (leer TODA la indexeddb del navegador, serializarla
// entera y hashearla) es la operacion mas cara del cloud sync. Los hooks de
// storage ya marcan sucio al instante, asi que este escaneo es solo la red de
// seguridad para cambios que los hooks no ven: no hace falta hacerlo cada 20 s.
const SCAN_INTERVAL = 60000;

// Claves que los juegos propios (bolsa / opencase) reescriben muchas veces por
// segundo: son una cache local de un estado que YA es autoritativo en el
// servidor del juego. Que una escritura de estas marque "sucio" hacia que el
// sync construyera y subiera una instantanea completa cada pocos segundos
// mientras se jugaba: con una indexeddb de decenas de MB eso satura el ancho de
// banda y microcongela. Estas claves SIGUEN viajando dentro de la instantanea
// (no se pierden): lo unico que dejan de hacer es DISPARARLA; entra con el
// siguiente cambio real o con el escaneo de pestana oculta.
const VOLATILE_LOCAL_NAMES = new Set([
  "bolsa-trading-floor-save",
  "bolsa-chart-view",
  "opencase-local-inventory-v1",
  "opencase-local-stats-v1",
]);

function isVolatileLocalName(name: unknown): boolean {
  return typeof name === "string" && VOLATILE_LOCAL_NAMES.has(name);
}

// bases de indexeddb que son cache del juego (el historial de velas se vuelve a
// pedir al servidor): escribirlas no debe disparar el sync, y tampoco viajan.
const LOCAL_ONLY_INDEXED_DB = new Set(["bolsa-history", "lyra-rivet-cache"]);

const LOADING_SCREEN = `
    <div id="loading-screen" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 99999; display: flex; justify-content: center; align-items: center; color: #858585; font-family: 'Lexend', sans-serif;">
        <h1 style="margin: 0; font-size: 1.2rem; font-weight: 300;">syncing data...</h1>
    </div>
`;

function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    credentials: "same-origin",
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(id));
}

// deja correr el trabajo caro (escaneo + serializacion del navegador, decenas
// de MB) cuando el hilo principal esta libre, con un tope de tiempo para que no
// se posponga indefinidamente si el usuario esta jugando.
function whenIdle(timeoutMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (typeof idle === "function") {
      idle(() => resolve(), { timeout: timeoutMs });
    } else {
      setTimeout(resolve, 0);
    }
  });
}

interface SnapshotPayload {
  body: string;
  fingerprint: string;
}

interface PendingSnapshot {
  resolve: (value: SnapshotPayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// el worker de serializacion (IndexedDB + JSON.stringify + fingerprint) para no
// bloquear el hilo principal. Si no esta disponible o falla, se cae al camino
// clasico en el hilo principal (nunca se pierde un sync por el worker).
let snapshotWorker: Worker | null = null;
let snapshotWorkerUnavailable = false;
let snapshotRequestId = 0;
const snapshotPending = new Map<number, PendingSnapshot>();

function forgetPendingSnapshots(reason: string): void {
  for (const [id, pending] of snapshotPending) {
    snapshotPending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(new Error(reason));
  }
}

function getSnapshotWorker(): Worker | null {
  if (snapshotWorker) return snapshotWorker;
  if (snapshotWorkerUnavailable) return null;
  if (typeof Worker === "undefined") {
    snapshotWorkerUnavailable = true;
    return null;
  }
  try {
    snapshotWorker = new Worker(
      new URL("./snapshotPayload.worker.ts", import.meta.url),
      { type: "module" },
    );
    snapshotWorker.onmessage = (event: MessageEvent) => {
      const data = event.data as {
        id?: number;
        ok?: boolean;
        body?: string;
        fingerprint?: string;
        error?: string;
      };
      const pending = data && typeof data.id === "number" ? snapshotPending.get(data.id) : undefined;
      if (!pending || typeof data.id !== "number") return;
      snapshotPending.delete(data.id);
      clearTimeout(pending.timer);
      if (data.ok && typeof data.body === "string" && typeof data.fingerprint === "string") {
        pending.resolve({ body: data.body, fingerprint: data.fingerprint });
      } else {
        pending.reject(new Error(data.error || "snapshot worker failed"));
      }
    };
    snapshotWorker.onerror = () => {
      snapshotWorkerUnavailable = true;
      snapshotWorker = null;
      forgetPendingSnapshots("snapshot worker error");
    };
    return snapshotWorker;
  } catch {
    snapshotWorkerUnavailable = true;
    return null;
  }
}

function logSnapshotSize(snapshot: SyncSnapshot, body: string): void {
  if (body.length <= 8 * 1024 * 1024) return;
  const heaviest = Object.entries(snapshot.indexedDB)
    .map(([name, db]) => [
      name,
      Object.values(db.stores).reduce((n, store) => n + store.records.length, 0),
    ] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  console.warn(
    `[cloudsync] snapshot ~${(body.length / 1048576).toFixed(1)} MB; bases mas pesadas (registros):`,
    heaviest,
  );
}

async function buildSnapshotPayload(): Promise<SnapshotPayload> {
  const worker = getSnapshotWorker();
  if (worker) {
    try {
      const parts = await exportNonIndexedDBParts();
      const id = (snapshotRequestId += 1);
      return await new Promise<SnapshotPayload>((resolve, reject) => {
        const timer = setTimeout(() => {
          snapshotPending.delete(id);
          reject(new Error("snapshot worker timeout"));
        }, 30000);
        snapshotPending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, parts });
      });
    } catch {
      // sin worker: se sigue por el hilo principal
    }
  }
  if (typeof window.lyraExportAllData !== "function") {
    throw new Error("export boundary unavailable");
  }
  const snapshot = await window.lyraExportAllData();
  const body = JSON.stringify(snapshot);
  logSnapshotSize(snapshot, body);
  const fingerprint = await payloadFingerprint(body);
  return { body, fingerprint };
}

async function uploadSnapshot(body: string): Promise<Response> {
  const rawHeaders = { "Content-Type": "application/json" };
  if (body.length < 32 * 1024 || typeof CompressionStream === "undefined") {
    return fetchWithTimeout(
      "/api/sync/upload",
      { method: "POST", headers: rawHeaders, body },
      SYNC_TIMEOUT,
    );
  }

  try {
    const raw = new Blob([body]);
    const compressed = await new Response(
      raw.stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    if (compressed.byteLength >= raw.size) {
      return fetchWithTimeout(
        "/api/sync/upload",
        { method: "POST", headers: rawHeaders, body },
        SYNC_TIMEOUT,
      );
    }
    const response = await fetchWithTimeout(
      "/api/sync/upload",
      {
        method: "POST",
        headers: {
          ...rawHeaders,
          "Content-Encoding": "gzip",
        },
        body: compressed,
      },
      SYNC_TIMEOUT,
    );
    if (response.status !== 415 && response.status !== 422) return response;
  } catch {}

  return fetchWithTimeout(
    "/api/sync/upload",
    { method: "POST", headers: rawHeaders, body },
    SYNC_TIMEOUT,
  );
}

export class CloudSync {
  user: AuthUser;
  syncMeta: SyncMeta;
  syncTimeout: ReturnType<typeof setTimeout> | null;
  isSyncing: boolean;
  isAuthenticated: boolean;
  isRestoring: boolean;
  _lastStatusText: string | undefined;
  _lastStatusType: string | undefined;
  _uploadRetries: number;
  _mutationVersion: number;
  _isScanning: boolean;
  _pollInterval: number;
  _checkIntervalId: ReturnType<typeof setInterval> | null;
  _lastScan: number;
  _nextUploadAt: number;

  constructor() {
    try {
      const storedUser = JSON.parse(localStorage.getItem("auth_user") || "{}");
      this.user =
        typeof storedUser === "object" && storedUser !== null ? storedUser : {};
    } catch {
      this.user = {};
    }
    try {
      this.syncMeta = JSON.parse(
        localStorage.getItem("lyra-sync-meta") ||
          '{"dirty": false, "last_synced": null}',
      );
    } catch (e) {
      this.syncMeta = { dirty: false, last_synced: null };
    }

    this.syncTimeout = null;
    this.isSyncing = false;
    this.isAuthenticated = false;
    this.isRestoring = false;
    this._lastStatusText = undefined;
    this._lastStatusType = undefined;
    this._uploadRetries = 0;
    this._mutationVersion = 0;
    this._isScanning = false;
    this._pollInterval = POLL_INTERVAL;
    this._checkIntervalId = null;
    this._lastScan = 0;
    this._nextUploadAt = 0;

    this.init();
  }

  async init(): Promise<void> {
    let needsLoadingScreen = false;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      const authResponse = await fetchWithTimeout("/api/auth/me", {
        cache: "no-store",
      });

      if (authResponse.ok) {
        const authPayload = await authResponse.json();
        this.user = authPayload.user;
        this.isAuthenticated = true;
        localStorage.setItem("auth_user", JSON.stringify(this.user));
      } else {
        this.isAuthenticated = false;
        this.user = {};
        localStorage.removeItem("auth_user");
      }
      this.updateModalState();

      if (this.isAuthenticated) {
        const metadataResponse = await fetchWithTimeout("/api/sync/meta", {
          cache: "no-store",
        });
        if (!metadataResponse.ok) {
          throw new Error(negativeMessage("sync metadata unavailable"));
        }
        const syncMetadata = await metadataResponse.json();
        const serverUpdatedAt: string = syncMetadata.updated_at;

        if (this.syncMeta.dirty || !serverUpdatedAt) {
          this.syncMeta.dirty = true;
          this.saveMeta();
          await this.syncData(true);
        } else if (
          serverUpdatedAt &&
          serverUpdatedAt !== this.syncMeta.last_synced
        ) {
          needsLoadingScreen = true;
          this.showLoadingScreen();
          safetyTimer = setTimeout(() => this.hideLoadingScreen(), 10000);
          await this.restoreData(true);
        } else {
          this.updateStatus("synced!! (˵◝ ⩊  ◜˵マ", "success");
        }
      }
    } catch {
      console.warn("[cloudsync] startup check failed... /ᐠ - ˕ -マ");
    } finally {
      if (safetyTimer) clearTimeout(safetyTimer);
      if (needsLoadingScreen) this.hideLoadingScreen();
    }

    document.addEventListener("toggleCloudSyncModal", () =>
      this.toggleCloudSyncModal(),
    );
    this.hookStorage();

    if (this.isAuthenticated) {
      this.startPolling();
      void this.poll();
    }
  }

  startPolling(): void {
    this.stopPolling();
    this._checkIntervalId = setInterval(() => {
      void this.poll();
    }, this._pollInterval);
  }

  stopPolling(): void {
    if (this._checkIntervalId) {
      clearInterval(this._checkIntervalId);
      this._checkIntervalId = null;
    }
  }

  onSyncError(): void {
    this._pollInterval = Math.min(this._pollInterval * 2, POLL_MAX_INTERVAL);
    this.startPolling();
  }

  onSyncSuccess(): void {
    if (this._pollInterval > POLL_INTERVAL) {
      this._pollInterval = POLL_INTERVAL;
      this.startPolling();
    }
  }

  async sync(): Promise<void> {
    try {
      if (!this.isAuthenticated) return;
      const metaRes = await fetchWithTimeout("/api/sync/meta", {
        cache: "no-store",
      });
      if (!metaRes.ok) return;

      const metaData = await metaRes.json();
      const serverUpdatedAt: string = metaData.updated_at;

      if (this.syncMeta.dirty || !serverUpdatedAt) {
        this.syncMeta.dirty = true;
        this.saveMeta();
        await this.syncData(true);
      } else if (
        serverUpdatedAt &&
        serverUpdatedAt !== this.syncMeta.last_synced
      ) {
        await this.restoreData(true);
      } else {
        this.updateStatus("synced!! (˵◝ ⩊  ◜˵マ", "success");
      }
    } catch {
      console.warn("[cloudsync] sync failed... /ᐠ - ˕ -マ");
    }
  }

  showLoadingScreen(): void {
    if (!document.getElementById("loading-screen")) {
      const div = document.createElement("div");
      div.innerHTML = LOADING_SCREEN.trim();
      document.body.appendChild(div.firstChild!);
    }
  }

  hideLoadingScreen(): void {
    const screen = document.getElementById("loading-screen");
    if (screen) {
      screen.remove();
    }
  }

  async checkAuthStatus(): Promise<void> {
    try {
      const response = await fetchWithTimeout("/api/auth/me", { cache: "no-store" });
      if (response.ok) {
        const authPayload = await response.json();
        this.user = authPayload.user;
        this.isAuthenticated = true;
        localStorage.setItem("auth_user", JSON.stringify(this.user));
      } else {
        this.isAuthenticated = false;
        this.user = {};
        localStorage.removeItem("auth_user");
      }
      this.updateModalState();
    } catch {
      console.warn("auth check failed... /ᐠ - ˕ -マ");
      this.isAuthenticated = false;
    }
  }

  saveMeta(): void {
    localStorage.setItem("lyra-sync-meta", JSON.stringify(this.syncMeta));
  }

  hookStorage(): void {
    const self = this;
    const hookWebStorage = (storage: Storage): void => {
      const originalSetItem = storage.setItem;
      storage.setItem = function (key: string, value: string): void {
        originalSetItem.call(storage, key, value);
        if (!isSensitiveSyncName(key) && !isVolatileLocalName(key)) self.markDirty();
      };

      const originalRemoveItem = storage.removeItem;
      storage.removeItem = function (key: string): void {
        originalRemoveItem.call(storage, key);
        if (!isSensitiveSyncName(key) && !isVolatileLocalName(key)) self.markDirty();
      };

      const originalClear = storage.clear;
      storage.clear = function (): void {
        originalClear.call(storage);
        self.markDirty();
      };
    };
    hookWebStorage(localStorage);
    hookWebStorage(sessionStorage);

    window.addEventListener("storage", (e: StorageEvent) => {
      if (!self.isAuthenticated || self.isRestoring) return;
      if (e.storageArea !== localStorage && e.storageArea !== sessionStorage)
        return;
      if (e.key === null) return self.markDirty();
      if (isSensitiveSyncName(e.key) || isVolatileLocalName(e.key)) return;
      self.markDirty();
    });

    if (typeof IDBObjectStore !== "undefined") {
      type IDBMutableMethod = "put" | "add" | "delete" | "clear";
      const hookIDB = (method: IDBMutableMethod): void => {
        const proto = IDBObjectStore.prototype as unknown as Record<
          string,
          unknown
        >;
        const original = proto[method] as (...args: unknown[]) => IDBRequest;
        if (!original) return;
        proto[method] = function (this: IDBObjectStore, ...args: unknown[]) {
          const dbName = this && this.transaction && this.transaction.db
            ? String(this.transaction.db.name)
            : "";
          if (!LOCAL_ONLY_INDEXED_DB.has(dbName)) self.markDirty();
          return original.apply(this, args);
        };
      };
      hookIDB("put");
      hookIDB("add");
      hookIDB("delete");
      hookIDB("clear");
    }

    if (typeof IDBDatabase !== "undefined") {
      const databasePrototype = IDBDatabase.prototype;
      const originalCreateStore = databasePrototype.createObjectStore;
      databasePrototype.createObjectStore = function (...args) {
        self.markDirty();
        return originalCreateStore.apply(this, args);
      };
      const originalDeleteStore = databasePrototype.deleteObjectStore;
      databasePrototype.deleteObjectStore = function (...args) {
        self.markDirty();
        return originalDeleteStore.apply(this, args);
      };
    }

    if (typeof IDBFactory !== "undefined") {
      const originalOpenDatabase = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (...args) {
        const request = originalOpenDatabase.apply(this, args);
        request.addEventListener(
          "success",
          () => rememberIndexedDBName(String(args[0])),
          { once: true },
        );
        return request;
      };
      const originalDeleteDatabase = IDBFactory.prototype.deleteDatabase;
      IDBFactory.prototype.deleteDatabase = function (...args) {
        const request = originalDeleteDatabase.apply(this, args);
        request.addEventListener(
          "success",
          () => forgetIndexedDBName(String(args[0])),
          { once: true },
        );
        self.markDirty();
        return request;
      };
    }

    const browserCookieStore = (
      globalThis as unknown as {
        cookieStore?: { addEventListener?: (type: string, listener: () => void) => void };
      }
    ).cookieStore;
    browserCookieStore?.addEventListener?.("change", () => self.markDirty());

    if (typeof Document !== "undefined") {
      const cookieDescriptor = Object.getOwnPropertyDescriptor(
        Document.prototype,
        "cookie",
      );
      if (cookieDescriptor?.get && cookieDescriptor.set) {
        Object.defineProperty(Document.prototype, "cookie", {
          configurable: cookieDescriptor.configurable ?? false,
          enumerable: cookieDescriptor.enumerable ?? false,
          get: cookieDescriptor.get,
          set(value: string) {
            cookieDescriptor.set!.call(this, value);
            self.markDirty();
          },
        });
      }
    }
  }

  markDirty(): void {
    if (!this.isAuthenticated || this.isRestoring) return;
    this._mutationVersion++;
    if (!this.syncMeta.dirty) {
      this.syncMeta.dirty = true;
      this.saveMeta();
    }

    if (this.syncTimeout) clearTimeout(this.syncTimeout);

    this.updateStatus("syncing...", "loading");

    // respeta la separacion minima: si el ultimo envio acaba de salir, difiere
    // este en vez de encadenar otro escaneo pesado inmediato
    const wait = Math.max(DIRTY_DEBOUNCE, this._nextUploadAt - Date.now());
    this.syncTimeout = setTimeout(() => {
      this.syncData();
    }, wait);
  }

  async checkForChanges(): Promise<void> {
    if (
      !this.isAuthenticated ||
      this.isSyncing ||
      this.isRestoring ||
      this._isScanning
    ) {
      return;
    }
    if (this.syncMeta.dirty) {
      await this.syncData();
      return;
    }
    if (typeof window.lyraExportAllData !== "function") return;
    // no recorrer el navegador entero en cada poll: los cambios de verdad los
    // marca markDirty al momento, esto es la red de seguridad. Y se corre SOLO
    // con la pestana oculta: es la operacion mas cara (leer+serializar toda la
    // indexeddb), asi que no debe bloquear el hilo mientras el usuario juega.
    if (typeof document !== "undefined" && !document.hidden) return;
    const now = Date.now();
    if (now - this._lastScan < SCAN_INTERVAL) return;
    this._lastScan = now;
    this._isScanning = true;
    try {
      const fingerprint = await snapshotFingerprint(
        await window.lyraExportAllData(),
      );
      if (fingerprint !== this.syncMeta.fingerprint) this.markDirty();
    } catch {
      console.warn("[cloudsync] storage scan failed... /ᐠ - ˕ -マ");
    } finally {
      this._isScanning = false;
    }
  }

  async poll(): Promise<void> {
    await this.checkForChanges();
    if (
      this.isAuthenticated &&
      !this.isSyncing &&
      !this.isRestoring &&
      !this.syncMeta.dirty
    ) {
      await this.sync();
    }
  }

  async syncData(
    manual: boolean = false,
    retryCount: number = 0,
  ): Promise<void> {
    if (!this.isAuthenticated || this.isSyncing) return;
    this.isSyncing = true;

    try {
      if (typeof window.lyraExportAllData !== "function") {
        if (retryCount >= 3) {
          console.warn(
            "[cloudsync] export boundary unavailable after retries... /ᐠ - ˕ -マ",
          );
          this.isSyncing = false;
          this.updateStatus("sync skipped... /ᐠ - ˕ -マ", "error");
          this.onSyncError();
          return;
        }
        console.warn(
          `[cloudsync] export boundary unavailable; retry ${retryCount + 1}/3... /ᐠ - ˕ -マ`,
        );
        this.isSyncing = false;
        setTimeout(() => this.syncData(manual, retryCount + 1), 2000);
        return;
      }

      const snapshotVersion = this._mutationVersion;
      // sella la ventana de envio antes del trabajo caro: un markDirty que
      // llegue mientras esto corre no encadena otro escaneo inmediato.
      this._nextUploadAt = Date.now() + MIN_UPLOAD_INTERVAL;
      // espera a un hueco del hilo principal y delega el export+stringify+hash
      // al worker (con fallback al hilo principal)
      await whenIdle();
      const { body, fingerprint } = await buildSnapshotPayload();

      const response = await uploadSnapshot(body);

      if (response.ok) {
        const uploadResult = await response.json();
        const uploadWasStale = changedDuringUpload(
          snapshotVersion,
          this._mutationVersion,
        );
        this.syncMeta.dirty = uploadWasStale;
        this.syncMeta.fingerprint = fingerprint;
        this.syncMeta.last_synced =
          uploadResult.updated_at ||
          new Date().toISOString().replace("T", " ").slice(0, 19);
        this.saveMeta();

        this.updateStatus(
          uploadWasStale ? "syncing..." : "synced!! (˵◝ ⩊  ◜˵マ",
          uploadWasStale ? "loading" : "success",
        );
        this._uploadRetries = 0;
        this.onSyncSuccess();
        if (uploadWasStale) {
          if (this.syncTimeout) clearTimeout(this.syncTimeout);
          this.syncTimeout = setTimeout(() => this.syncData(), DIRTY_DEBOUNCE);
        }
      } else {
        // el servidor explica por que rechaza (code + error); antes se tiraba
        // y un 400 no dejaba rastro de QUE regla salto, asi que era imposible
        // arreglar la instantanea sin adivinar.
        const failure = (await response.json().catch(() => null)) as {
          code?: unknown;
          error?: unknown;
        } | null;
        const serverCode =
          typeof failure?.code === "string" ? ` (${failure.code})` : "";
        console.warn(
          `[cloudsync] upload failed with status ${response.status}${serverCode}... /ᐠ - ˕ -マ`,
          typeof failure?.error === "string" ? failure.error : "",
        );
        if (
          (response.status === 429 || response.status >= 500) &&
          (!this._uploadRetries || this._uploadRetries < 3)
        ) {
          this._uploadRetries = (this._uploadRetries || 0) + 1;
          const delay = Math.min(
            2000 * Math.pow(2, this._uploadRetries - 1),
            8000,
          );
          console.warn(
            `[cloudsync] upload retry ${this._uploadRetries}/3 in ${delay}ms... /ᐠ - ˕ -マ`,
          );
          this.updateStatus("retrying sync...", "loading");
          this.isSyncing = false;
          setTimeout(() => this.syncData(manual, retryCount), delay);
          return;
        }
        this._uploadRetries = 0;
        if (response.status === 401) {
          await this.checkAuthStatus();
          this.stopPolling();
          this.updateStatus("sign in again to sync... /ᐠ - ˕ -マ", "error");
        } else if (response.status === 413) {
          this.updateStatus("sync data is too large... /ᐠ - ˕ -マ", "error");
        } else if (response.status === 400 || response.status === 422) {
          this.updateStatus(
            "some browser data could not be synced... /ᐠ - ˕ -マ",
            "error",
          );
        } else {
          this.updateStatus("sync failed... /ᐠ - ˕ -マ", "error");
        }
        if (this.isAuthenticated) this.onSyncError();
      }
    } catch {
      console.error("sync failed... /ᐠ - ˕ -マ");
      if (!this._uploadRetries || this._uploadRetries < 3) {
        this._uploadRetries = (this._uploadRetries || 0) + 1;
        const delay = Math.min(
          2000 * Math.pow(2, this._uploadRetries - 1),
          8000,
        );
        console.warn(
          `[cloudsync] upload retry ${this._uploadRetries}/3 in ${delay}ms... /ᐠ - ˕ -マ`,
        );
        this.updateStatus("retrying sync...", "loading");
        this.isSyncing = false;
        setTimeout(() => this.syncData(manual, retryCount), delay);
        return;
      }
      this._uploadRetries = 0;
      this.updateStatus("connection error... /ᐠ - ˕ -マ", "error");
      this.onSyncError();
    } finally {
      this.isSyncing = false;
    }
  }

  async restoreData(
    silent: boolean = false,
    retryCount: number = 0,
  ): Promise<void> {
    if (!this.isAuthenticated) return;
    if (this.isRestoring) return;
    if (!silent) this.updateStatus("restoring...", "loading");
    this.isRestoring = true;

    let restoreToast: ToastController | null = null;
    let reloading = false;

    if (!silent && window.showToast) {
      restoreToast = window.showToast("info", "restoring data...", "IconArrowRotateClockwise", 0);
    }

    const maxRetries = 6;
    const jitter = (): number => Math.floor(Math.random() * 400);

    try {
      const response = await fetchWithTimeout(
        "/api/sync/download",
        {},
        SYNC_TIMEOUT,
      );

      if (response.status === 429 || response.status >= 500) {
        if (retryCount < maxRetries) {
          const delay =
            Math.min(1000 * Math.pow(2, retryCount), 30000) + jitter();
          if (!silent) this.updateStatus("restore retrying...", "loading");
          console.warn(
            `[cloudsync] restore retry ${retryCount + 1}/${maxRetries} after ${delay}ms with status ${response.status}... /ᐠ - ˕ -マ`,
          );
          this.isRestoring = false;
          setTimeout(() => this.restoreData(silent, retryCount + 1), delay);
          return;
        }
        if (!silent) {
          this.updateStatus("sync service busy... /ᐠ - ˕ -マ", "error");
        }
        this.isRestoring = false;
        return;
      }

      if (!response.ok && response.status !== 404) {
        if (
          retryCount < maxRetries &&
          response.status >= 400 &&
          response.status !== 401
        ) {
          const delay =
            Math.min(1000 * Math.pow(2, retryCount), 30000) + jitter();
          if (!silent) this.updateStatus("restore retrying...", "loading");
          console.warn(
            `[cloudsync] restore retry ${retryCount + 1}/${maxRetries} after ${delay}ms with status ${response.status}... /ᐠ - ˕ -マ`,
          );
          this.isRestoring = false;
          setTimeout(() => this.restoreData(silent, retryCount + 1), delay);
          return;
        }
        if (!silent) {
          this.updateStatus("restore failed... /ᐠ - ˕ -マ", "error");
        }
        this.isRestoring = false;
        return;
      }

      const syncPayload = await response.json();

      if (response.ok && syncPayload.data) {
        if (typeof window.lyraImportDataFromObject === "function") {
          await window.lyraImportDataFromObject(
            syncPayload.data,
            (progressText: string) => {
              const loadingH1 =
                document.querySelector<HTMLElement>("#loading-screen h1");
              if (loadingH1) loadingH1.textContent = progressText;
            },
          );

          this.syncMeta.dirty = false;
          this.syncMeta.last_synced = syncPayload.updated_at;
          const exporter = window.lyraExportAllData;
          if (typeof exporter !== "function") {
            throw new Error(negativeMessage("export boundary unavailable"));
          }
          this.syncMeta.fingerprint = await snapshotFingerprint(await exporter());
          this.saveMeta();

          document.dispatchEvent(new CustomEvent("cloudsync-restored"));
          reloading = true;
          window.bypassPreventClosing = true;
          window.location.reload();
        }
      } else if (response.status === 404) {
        this.syncMeta.dirty = true;
        this.saveMeta();
        this.updateStatus("syncing...", "loading");
        setTimeout(() => void this.syncData(true), 0);
      }
    } catch {
      console.error("restore failed... /ᐠ - ˕ -マ");
      if (retryCount < maxRetries) {
        const delay =
          Math.min(1000 * Math.pow(2, retryCount), 30000) + jitter();
        if (!silent) this.updateStatus("restore retrying...", "loading");
        this.isRestoring = false;
        setTimeout(() => this.restoreData(silent, retryCount + 1), delay);
        return;
      }
      if (!silent) {
        this.updateStatus("restore failed... /ᐠ - ˕ -マ", "error");
      }
    } finally {
      this.isRestoring = false;
      if (restoreToast && !reloading) {
        restoreToast.hide();
      }
    }
  }

  async createCloudSyncModal(): Promise<void> {
    if (document.getElementById("cloudsync-modal")) return;

    const modal = document.createElement("div");
    modal.id = "cloudsync-modal";
    modal.className = "popup";
    modal.innerHTML = cloudSyncModalHtml();

    document.body.appendChild(modal);
    this.attachCloudSyncModalListeners(modal);
    this.updateModalState();
  }

  attachCloudSyncModalListeners(modal: HTMLElement): void {
    (
      modal.querySelector("#close-cloudsync-modal") as HTMLElement
    ).addEventListener("click", () => this.toggleCloudSyncModal());
    const loginForm = modal.querySelector<HTMLFormElement>("#login-form")!;
    const regForm = modal.querySelector<HTMLFormElement>("#register-form")!;

    const regUsername = modal.querySelector<HTMLInputElement>("#reg-username")!;
    const regUsernameFeedback = modal.querySelector<HTMLElement>(
      "#reg-username-feedback",
    )!;
    const regPassword = modal.querySelector<HTMLInputElement>("#reg-password")!;
    const regPasswordFeedback = modal.querySelector<HTMLElement>(
      "#reg-password-feedback",
    )!;

    regUsername.addEventListener("input", () => {
      const username = regUsername.value;
      const length = username.length;
      const hasValidCharacters = /^[a-zA-Z0-9_]+$/.test(username);

      if (length === 0) {
        regUsernameFeedback.textContent = "3-20 chars, letters/numbers";
        regUsernameFeedback.style.color = "var(--text-muted)";
      } else if (length < 3 || length > 20) {
        regUsernameFeedback.textContent = `${length}/20 chars; must be 3-20... /ᐠ - ˕ -マ`;
        regUsernameFeedback.style.color = "var(--status-error-text)";
      } else if (!hasValidCharacters) {
        regUsernameFeedback.textContent =
          "letters, numbers, and underscores only... /ᐠ - ˕ -マ";
        regUsernameFeedback.style.color = "var(--status-error-text)";
      } else {
        regUsernameFeedback.textContent = `${length}/20 chars; looks good!! (˵◝ ⩊  ◜˵マ`;
        regUsernameFeedback.style.color = "var(--status-success-text)";
      }
    });

    regPassword.addEventListener("input", () => {
      const password = regPassword.value;
      const length = password.length;

      if (length === 0) {
        regPasswordFeedback.textContent = "6+ characters";
        regPasswordFeedback.style.color = "var(--text-muted)";
      } else if (length < 6) {
        regPasswordFeedback.textContent = `${length}/6 characters... /ᐠ - ˕ -マ`;
        regPasswordFeedback.style.color = "var(--status-error-text)";
      } else {
        regPasswordFeedback.textContent = "looks good!! (˵◝ ⩊  ◜˵マ";
        regPasswordFeedback.style.color = "var(--status-success-text)";
      }
    });

    const promptText = modal.querySelector<HTMLElement>("#auth-prompt-text")!;
    const actionText = modal.querySelector<HTMLElement>("#auth-action-text")!;
    const authTitle = modal.querySelector<HTMLElement>("#auth-title")!;

    const loginUsername =
      modal.querySelector<HTMLInputElement>("#login-username")!;
    const loginPassword =
      modal.querySelector<HTMLInputElement>("#login-password")!;

    actionText.addEventListener("click", () => {
      const isLogin = loginForm.style.display !== "none";
      if (isLogin) {
        regUsername.value = loginUsername.value;
        regPassword.value = "";
        loginForm.style.display = "none";
        regForm.style.display = "block";
        authTitle.textContent = "create account";
        promptText.textContent = "already have an account?";
        actionText.textContent = "login!";
      } else {
        loginUsername.value = regUsername.value;
        loginPassword.value = "";
        loginForm.style.display = "block";
        regForm.style.display = "none";
        authTitle.textContent = "login";
        promptText.textContent = "don't have an account?";
        actionText.textContent = "create one!";
      }
      this.showError("");
    });

    loginForm.addEventListener("submit", (e) => this.handleLogin(e));
    regForm.addEventListener("submit", (e) => this.handleRegister(e));

    modal
      .querySelector<HTMLElement>("#logout-btn")!
      .addEventListener("click", () => this.logout());

    const deleteBtn = modal.querySelector<HTMLElement>("#delete-account-btn")!;
    deleteBtn.addEventListener("click", () => {
      void this.deleteAccount();
    });

    document.addEventListener("click", (e) => {
      const overlay = document.getElementById("overlay");
      if (overlay && e.target === overlay && isManagedModalOpen(modal)) {
        this.toggleCloudSyncModal();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isManagedModalOpen(modal)) {
        this.toggleCloudSyncModal();
      }
    });

    const toggles = modal.querySelectorAll<HTMLElement>(".password-toggle");
    toggles.forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const targetId = toggle.getAttribute("data-target");
        const input = document.getElementById(
          targetId!,
        ) as HTMLInputElement | null;
        if (!input) return;

        if (input.type === "password") {
          input.type = "text";
          toggle.innerHTML = svgIcon("IconEyeSlash");
        } else {
          input.type = "password";
          toggle.innerHTML = svgIcon("IconEyeOpen");
        }
      });
    });
  }

  async toggleCloudSyncModal(): Promise<void> {
    if (!document.getElementById("cloudsync-modal")) {
      await this.createCloudSyncModal();
    }

    const modal = document.getElementById("cloudsync-modal") as HTMLElement;
    if (isManagedModalOpen(modal)) {
      closeManagedModal(modal);
    } else {
      openManagedModal(modal);
    }
  }

  updateModalState(): void {
    const loggedInView = document.getElementById("auth-logged-in");
    const formsView = document.getElementById("auth-forms");
    const userDisplay = document.getElementById("auth-user-display");
    const authTitle = document.getElementById("auth-title");

    if (this.isAuthenticated) {
      if (loggedInView) loggedInView.style.display = "block";
      if (formsView) formsView.style.display = "none";
      if (userDisplay) userDisplay.textContent = this.user.username ?? "";
      if (authTitle) authTitle.textContent = "cloud sync";
    } else {
      if (loggedInView) loggedInView.style.display = "none";
      if (formsView) formsView.style.display = "block";
      if (authTitle) authTitle.textContent = "login";
    }

    const statusEl = document.querySelector<HTMLElement>("#auth-status");
    if (statusEl)
      statusEl.textContent = this.isAuthenticated
        ? (this.user.username ?? "")
        : "cloud sync";
  }

  updateStatus(text: string, cls?: string): void {
    const ind = document.getElementById("sync-status-indicator");

    const updateEl = (el: HTMLElement | null): void => {
      if (!el) return;
      if (this._lastStatusText === text && this._lastStatusType === cls) return;
      this._lastStatusText = text;
      this._lastStatusType = cls;

      el.textContent = text;
    };

    updateEl(ind);
  }

  /**
   * El motivo que devuelve el servidor, o "" si no lo manda.
   *
   * Antes esto se ignoraba y los dos fallos mas comunes —"ese nombre ya esta en
   * uso" y una contraseña de 14 caracteres— llegaban los dos al usuario como el
   * mismo "account creation failed", que no dice nada de nada. El servidor ya
   * explica el motivo; taparlo no protege de nada, solo quita la informacion
   * que hace falta para arreglarlo.
   */
  private serverError(payload: unknown): string {
    const error = (payload as { error?: unknown } | null)?.error;
    return typeof error === "string" ? error.trim() : "";
  }

  async handleLogin(e: Event): Promise<void> {
    e.preventDefault();
    const username = (
      document.getElementById("login-username") as HTMLInputElement
    ).value;
    const password = (
      document.getElementById("login-password") as HTMLInputElement
    ).value;
    (document.getElementById("login-password") as HTMLInputElement).value = "";

    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast("info", "logging in...", "IconArrowRotateClockwise", 0);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });

      const sessionPayload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;

      if (response.ok && sessionPayload) {
        if (toastController) toastController.hide();
        this.setSession(sessionPayload as unknown as SessionData);
        this.toggleCloudSyncModal();
        await this.restoreData();
      } else {
        if (toastController) toastController.hide();
        // el codigo es lo que decide, no el texto: 401 es "esa combinacion no
        // existe" y no se puede ser mas especifico sin filtrar informacion.
        // cualquier otro codigo (400 por un nombre con forma invalida, 429
        // por haberte pasado de intentos, 5xx por averia) si se enseña su
        // motivo, porque reintentar a lo loco no lo arregla.
        const serverError = this.serverError(sessionPayload);
        const message = response.status === 401 || !serverError
          ? "login failed... /ᐠ - ˕ -マ"
          : serverError;
        if (window.showToast)
          window.showToast("error", message, "IconExclamationTriangle");
        else this.showError(message);
      }
    } catch {
      if (toastController) toastController.hide();
      const message = "connection error... /ᐠ - ˕ -マ";
      if (window.showToast)
        window.showToast("error", message, "IconExclamationTriangle");
      else this.showError(message);
      console.error("login failed... /ᐠ - ˕ -マ");
    }
  }

  async handleRegister(e: Event): Promise<void> {
    e.preventDefault();
    const username = (
      document.getElementById("reg-username") as HTMLInputElement
    ).value;
    const password = (
      document.getElementById("reg-password") as HTMLInputElement
    ).value;
    (document.getElementById("reg-password") as HTMLInputElement).value = "";

    if (!username || !password) {
      if (window.showToast)
        window.showToast(
          "error",
          "fill in both username and password... /ᐠ - ˕ -マ",
          "IconExclamationTriangle",
        );
        else this.showError("fill in both fields... /ᐠ - ˕ -マ");
      return;
    }

    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "creating account...",
        "IconArrowRotateClockwise",
        0,
      );

    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });

      const sessionPayload = (await response.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;

      if (response.ok && sessionPayload) {
        if (toastController) toastController.hide();
        this.setSession(sessionPayload as unknown as SessionData);
        this.toggleCloudSyncModal();
        this.syncMeta.dirty = true;
        this.saveMeta();
        await this.syncData();
      } else {
        if (toastController) toastController.hide();
        // en el alta no hay nada que proteger: el servidor ya dice si el nombre
        // esta cogido, y un formulario de registro que se calla eso obliga a
        // probar nombres a ciegas
        const message =
          this.serverError(sessionPayload) ||
          "account creation failed... /ᐠ - ˕ -マ";
        if (window.showToast)
          window.showToast("error", message, "IconExclamationTriangle");
        else this.showError(message);
      }
    } catch {
      if (toastController) toastController.hide();
      const message = "connection error... /ᐠ - ˕ -マ";
      if (window.showToast)
        window.showToast("error", message, "IconExclamationTriangle");
      else this.showError(message);
      console.error("account creation failed... /ᐠ - ˕ -マ");
    }
  }

  setSession(session: SessionData): void {
    this.isAuthenticated = true;
    this.user = session.user;
    localStorage.setItem("auth_user", JSON.stringify(this.user));
    this.updateModalState();
    this.startPolling();
  }

  async logout(): Promise<void> {
    if (window.showToast) {
      window.showToast("info", "confirm logout?", "IconCircleInfo", [
        {
          text: "cancel",
          dismiss: true,
        },
        {
          text: "logout",
          class: "danger-btn",
          dismiss: true,
          callback: async () => {
            await this.performLogout();
          },
        },
      ]);
    } else {
      if (!confirm("confirm logout?")) return;
      void this.performLogout();
    }
  }

  async performLogout(): Promise<void> {
    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "logging out...",
        "IconCircleInfo",
        0,
      );

    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      console.warn("logout failed... /ᐠ - ˕ -マ");
    }

    if (toastController) toastController.hide();

    this.stopPolling();
    this.isAuthenticated = false;
    this.user = {};
    localStorage.removeItem("auth_user");
    localStorage.removeItem("lyra-sync-meta");

    await this.wipeLocalData();

    window.bypassPreventClosing = true;
    window.location.reload();
  }

  async deleteAccount(): Promise<void> {
    if (!this.isAuthenticated) return;

    if (window.showToast) {
      window.showToast("info", "confirm deletion... /ᐠ - ˕ -マ", "IconExclamationTriangle", [
        {
          text: "cancel",
          dismiss: true,
        },
        {
          text: "delete",
          class: "danger-btn",
          dismiss: true,
          callback: async () => {
            await this.performDelete();
          },
        },
      ]);
    } else {
      if (
        confirm(
      "are you sure? this will delete your account and all synced data permanently... /ᐠ - ˕ -マ",
        )
      ) {
        void this.performDelete();
      }
    }
  }

  async performDelete(): Promise<void> {
    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "deleting account...",
        "IconExclamationTriangle",
        0,
      );

    try {
      const response = await fetch("/api/auth/me", {
        method: "DELETE",
        credentials: "same-origin",
      });

      if (response.ok) {
        if (toastController) toastController.hide();
        this.stopPolling();
        this.isAuthenticated = false;
        this.user = {};
        localStorage.removeItem("auth_user");
        localStorage.removeItem("lyra-sync-meta");

        await this.wipeLocalData();

        window.bypassPreventClosing = true;
        window.location.reload();
      } else {
        if (toastController) toastController.hide();
        if (window.showToast)
          window.showToast(
            "error",
            "account deletion failed... /ᐠ - ˕ -マ",
            "IconExclamationTriangle",
          );
        else alert("account deletion failed... /ᐠ - ˕ -マ");
      }
    } catch {
      if (toastController) toastController.hide();
      if (window.showToast)
        window.showToast(
          "error",
          "account deletion failed... /ᐠ - ˕ -マ",
          "IconExclamationTriangle",
        );
      else alert("account deletion failed... /ᐠ - ˕ -マ");
      console.error("account deletion failed... /ᐠ - ˕ -マ");
    }
  }

  showError(message: string): void {
    const errorElement = document.getElementById("auth-error");
    if (errorElement) {
      errorElement.textContent = message;
      setTimeout(() => (errorElement.textContent = ""), 3000);
    }
  }

  async wipeLocalData(): Promise<void> {
    try {
      const preserveKeys = ["alertClosed", "lyraVisited", "lyraVersion"];

      const preservedData: Record<string, string> = {};
      preserveKeys.forEach((key) => {
        const value = localStorage.getItem(key);
        if (value !== null) preservedData[key] = value;
      });

      localStorage.clear();
      sessionStorage.clear();

      localStorage.removeItem("lyra-bookmarks");

      Object.keys(preservedData).forEach((key) => {
        localStorage.setItem(key, preservedData[key]!);
      });
    } catch {
      console.error("[cloudsync] storage wipe failed... /ᐠ - ˕ -マ");
    }

    try {
      document.cookie.split(";").forEach((c) => {
        document.cookie = c
          .replace(/^ +/, "")
          .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
      });
    } catch {
      console.warn("cookie clear failed... /ᐠ - ˕ -マ");
    }

    if ("indexedDB" in window && typeof indexedDB.databases === "function") {
      try {
        const dbs = await indexedDB.databases();
        for (const dbInfo of dbs) {
          if (dbInfo.name) {
            indexedDB.deleteDatabase(dbInfo.name!);
          }
        }
      } catch {
        console.warn("[cloudsync] indexeddb wipe failed... /ᐠ - ˕ -マ");
      }
    }

    if ("serviceWorker" in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
      } catch {
        console.warn("[cloudsync] service worker cleanup failed... /ᐠ - ˕ -マ");
      }
    }

    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        console.warn("[cloudsync] cache cleanup failed... /ᐠ - ˕ -マ");
      }
    }
  }
}

function initCloudSync(): void {
  void new CloudSync();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCloudSync, {
    once: true,
  });
} else {
  initCloudSync();
}