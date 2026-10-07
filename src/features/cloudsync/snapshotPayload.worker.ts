// worker de serialización del cloud sync.
//
// El hilo principal le manda sólo la parte barata (localStorage/sessionStorage/
// cookies); este worker lee IndexedDB (que sí es accesible en workers), arma el
// snapshot completo, lo serializa a JSON y calcula su fingerprint. Así el
// `JSON.stringify` + `TextEncoder` de decenas de MB no bloquean la UI.
//
// El nombre sigue el patrón del base (`snapshot.worker.ts`); aquí vive junto a
// `syncSnapshot.ts` para compartir el mismo export y las mismas reglas.
import {
  exportIndexedDBSnapshot,
  heaviestSyncDatabases,
  payloadFingerprint,
  type SyncSnapshot,
} from "./syncSnapshot.ts";

type Parts = Pick<
  SyncSnapshot,
  "schemaVersion" | "localStorage" | "sessionStorage" | "cookies"
>;

interface RequestMessage {
  id: number;
  parts: Parts;
}

interface OkMessage {
  id: number;
  ok: true;
  body: string;
  fingerprint: string;
}

interface ErrMessage {
  id: number;
  ok: false;
  error: string;
}

// en un worker el contexto es DedicatedWorkerGlobalScope; el tipado DOM no lo
// conoce, así que se declara la parte que usamos.
const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<RequestMessage>) => void) | null;
  postMessage: (message: OkMessage | ErrMessage) => void;
};

ctx.onmessage = (event) => {
  const id = event.data?.id;
  const parts = event.data?.parts;
  if (!parts) {
    ctx.postMessage({ id: Number(id) || 0, ok: false, error: "missing parts" });
    return;
  }
  void (async () => {
    try {
      const indexedDB = await exportIndexedDBSnapshot();
      const snapshot: SyncSnapshot = { ...parts, indexedDB };
      const body = JSON.stringify(snapshot);
      // diagnostico barato (sin re-serializar cada base): sale en la consola del
      // worker en DevTools. `body.length` es una aproximacion del peso en bytes,
      // y `heaviestSyncDatabases` atribuye ese peso a cada base sin serializar.
      if (body.length > 8 * 1024 * 1024) {
        const heaviest = heaviestSyncDatabases(snapshot.indexedDB).map(
          ([name, bytes]) => [name, `${(bytes / 1048576).toFixed(1)} MB`] as const,
        );
        console.warn(
          `[cloudsync] snapshot ~${(body.length / 1048576).toFixed(1)} MB; bases mas pesadas (bytes aprox):`,
          heaviest,
        );
      }
      const fingerprint = await payloadFingerprint(body);
      ctx.postMessage({ id: Number(id) || 0, ok: true, body, fingerprint });
    } catch (error) {
      ctx.postMessage({
        id: Number(id) || 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
