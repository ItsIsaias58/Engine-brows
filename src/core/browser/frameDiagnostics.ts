// Diagnostico para el bug del teclado/pointer-lock de los juegos.
//
// El sintoma —"el juego se queda en el menu de opciones / Back to Game y no
// responde"— no se puede reproducir sin navegador, y las hipotesis (foco del
// documento, pointer lock, perdida de foco) se ven todas igual desde fuera.
// Lo que hace falta son los hechos de dentro del frame. Este modulo los
// registra y los deja a mano en la consola (eruda), sin instrumentar nada mas.
//
// Se instala solo cuando el usuario pulsa el boton de eruda, para no meter
// oyentes en todos los juegos por defecto. Los juegos van por /!!/, o sea
// mismo origen, asi que el padre SI puede leer contentDocument.

export interface FrameDiagnosticReport {
  /** que elemento del frame tiene el foco ahora mismo */
  activeElement: string;
  /** que elemento tiene el pointer lock, o null */
  pointerLockElement: string | null;
  /** el documento del frame se considera activo */
  hasFocus: boolean;
  visibility: string;
  /** ultimos cambios de foco/pointer lock, con marca de tiempo */
  events: string[];
  /** cuantas teclas llego a recibir el frame desde que se instalo */
  keyEvents: number;
}

type DiagnosticWindow = Window & {
  __lyraDiag?: () => FrameDiagnosticReport;
};

function describeElement(element: Element | null): string {
  if (!element) return "null";
  const id = element.id ? `#${element.id}` : "";
  return `${element.tagName.toLowerCase()}${id}`;
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

const WATCHED_EVENTS = [
  "focus",
  "blur",
  "focusin",
  "focusout",
  "pointerlockchange",
  "pointerlockerror",
  "visibilitychange",
  "pagehide",
  "pageshow",
];

/**
 * Engancha el diagnostico al documento del frame. Devuelve false si el frame
 * es de otro origen (sin contentDocument) o si ya estaba instalado.
 */
export function installFrameDiagnostics(frame: HTMLIFrameElement): boolean {
  const doc = frame.contentDocument;
  const win = frame.contentWindow as DiagnosticWindow | null;
  if (!doc || !win) return false;
  if (typeof win.__lyraDiag === "function") return true;

  const events: string[] = [];
  const record = (type: string) => () => {
    events.push(`${timestamp()} ${type}`);
    if (events.length > 200) events.shift();
  };
  for (const type of WATCHED_EVENTS) {
    // true = captura, para verlo aunque el juego pare la propagacion
    doc.addEventListener(type, record(type), true);
    win.addEventListener(type, record(type), true);
  }

  let keyEvents = 0;
  doc.addEventListener(
    "keydown",
    () => {
      keyEvents += 1;
    },
    true,
  );

  win.__lyraDiag = () => ({
    activeElement: describeElement(doc.activeElement),
    pointerLockElement: doc.pointerLockElement
      ? describeElement(doc.pointerLockElement)
      : null,
    hasFocus: doc.hasFocus(),
    visibility: doc.visibilityState,
    events: events.slice(-40),
    keyEvents,
  });
  return true;
}

/**
 * Instala el diagnostico y suelta un resumen por consola. Se llama al abrir
 * eruda; a partir de ahi `__lyraDiag()` en la consola del frame da el detalle.
 */
export function installGameDiagnostics(frame: HTMLIFrameElement): boolean {
  const installed = installFrameDiagnostics(frame);
  if (installed) {
    try {
      console.info(
        "[lyra-diag] instalado; ejecuta __lyraDiag() en la consola de este frame",
      );
    } catch {}
  }
  return installed;
}
