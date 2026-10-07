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
  /**
   * sólo el hash. Lo usa el escaneo de seguridad: no necesita el cuerpo, y
   * devolverlo obligaría a copiar decenas de MB al hilo principal.
   */
  fingerprintOnly?: boolean;
}

interface OkMessage {
  id: number;
  ok: true;
  fingerprint: string;
  /** longitud UTF-16 del cuerpo; el cliente corta el "payload pequeño" aquí */
  rawLength: number;
  /** gzip listo para subir. Va transferido, así que no se copia al recibirlo */
  compressed?: ArrayBuffer;
  /** cuerpo crudo: sólo cuando comprimir no compensa */
  body?: string;
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
  postMessage: (message: OkMessage | ErrMessage, transfer?: Transferable[]) => void;
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
      const responseId = Number(id) || 0;
      if (event.data?.fingerprintOnly) {
        ctx.postMessage({
          id: responseId,
          ok: true,
          fingerprint,
          rawLength: body.length,
        });
        return;
      }
      // La compresión se queda aquí: es lo que antes corría en el hilo
      // principal (`Blob` + `CompressionStream` sobre decenas de MB) cada vez
      // que algo marcaba el sync. Aquí sólo viajan los bytes ya comprimidos.
      if (body.length >= 32 * 1024 && typeof CompressionStream !== "undefined") {
        const raw = new Blob([body]);
        const gzipped = await new Response(
          raw.stream().pipeThrough(new CompressionStream("gzip")),
        ).arrayBuffer();
        // mismo criterio que el camino clásico: comprimir sólo si gana a crudo
        if (gzipped.byteLength < raw.size) {
          ctx.postMessage(
            { id: responseId, ok: true, fingerprint, rawLength: body.length, compressed: gzipped },
            [gzipped],
          );
          return;
        }
      }
      ctx.postMessage({ id: responseId, ok: true, fingerprint, rawLength: body.length, body });
    } catch (error) {
      ctx.postMessage({
        id: Number(id) || 0,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
};
