import { destroyInPlaceFrame, navigateInPlaceFrame } from "../proxy/folio.ts";
import { focusFrame, focusFrameSoon, markFrameFocusable } from "./frameFocus.ts";

// El visor: una pantalla grande dentro de la app para ver paginas externas
// (spotify, youtube, la pagina de un juego) servidas por el proxy de folio.
//
// Por que NO es una pestana del navegador de la app: abrir "en la app" creaba
// una pestana, que es justo lo que se pidio evitar. Y por que NO es un
// window.open: eso se sale del proxy, del cloaking y del HUD.
//
// El z-index (1100) esta por debajo de la barra de menus (1200) a proposito:
// los botones de games, anime, music y settings siguen siendo pulsables ENCIMA
// del visor, que es justo lo que se pidio (una pantalla que tapa casi todo pero
// deja el menu utilizable). Como los menus y catalogos se dibujan por debajo de
// la pantalla, hacer clic en una seccion cierra el visor en vez de abrir una
// pestana ahi atras donde no se ve. El panel de musica (3000) si queda por
// encima del visor, asi que se puede tener los dos a la vista a la vez.
//
// No hay boton de "atras": el historial lo lleva folio por dentro y no lo
// publica al iframe, asi que un atras aqui seria un boton que a veces no hace
// nada. Cerrar devuelve a la app, que es lo que se busca.
const STAGE_ID = "lyra-stage";
const FRAME_ID = "lyra-stage-frame";
const TITLE_ID = "lyra-stage-title";
const RELOAD_ID = "lyra-stage-reload";
const CLOSE_ID = "lyra-stage-close";

let onKeyDown: ((event: KeyboardEvent) => void) | null = null;

function buildStage(): HTMLDivElement {
  const stage = document.createElement("div");
  stage.id = STAGE_ID;
  stage.className = "lyra-stage";
  stage.setAttribute("role", "dialog");
  stage.setAttribute("aria-label", "page viewer");
  stage.hidden = true;

  const bar = document.createElement("div");
  bar.className = "lyra-stage-bar";

  const title = document.createElement("span");
  title.id = TITLE_ID;
  title.className = "lyra-stage-title";
  bar.appendChild(title);

  const reload = document.createElement("button");
  reload.id = RELOAD_ID;
  reload.type = "button";
  reload.className = "lyra-stage-btn";
  reload.title = "recargar";
  reload.textContent = "⟳";
  reload.addEventListener("click", () => {
    const frame = stageFrame();
    const url = frame?.dataset.manualUrl;
    if (frame && url) void navigateInPlaceFrame(frame, url);
  });
  bar.appendChild(reload);

  const close = document.createElement("button");
  close.id = CLOSE_ID;
  close.type = "button";
  close.className = "lyra-stage-btn";
  close.title = "cerrar";
  close.textContent = "✕";
  close.addEventListener("click", () => closeStage());
  bar.appendChild(close);

  const frame = document.createElement("iframe");
  frame.id = FRAME_ID;
  frame.className = "lyra-stage-frame";
  frame.title = "page viewer";
  // sin esto el visor muestra la pagina pero no la deja usar con teclado: el
  // clic llega igual, las teclas se quedan en el documento padre
  markFrameFocusable(frame);
  frame.addEventListener("click", () => focusFrame(frame));

  stage.appendChild(bar);
  stage.appendChild(frame);
  document.body.appendChild(stage);
  return stage;
}

function stageFrame(): HTMLIFrameElement | null {
  return document.getElementById(FRAME_ID) as HTMLIFrameElement | null;
}

export function stageReady(): boolean {
  return typeof document !== "undefined" && Boolean(document.body);
}

function isStageOpen(): boolean {
  if (!stageReady()) return false;
  const stage = document.getElementById(STAGE_ID) as HTMLDivElement | null;
  return stage ? !stage.hidden : false;
}

/**
 * Abre una pagina en el visor. No crea pestanas ni ventanas del sistema: la
 * pagina se sirve por el proxy de folio dentro del overlay.
 */
export function openStage(url: string, title?: string): void {
  if (!stageReady()) return;
  const target = (url || "").trim();
  if (!target) return;
  if (!document.getElementById(STAGE_ID)) buildStage();

  const stage = document.getElementById(STAGE_ID) as HTMLDivElement | null;
  if (!stage) return;
  stage.hidden = false;

  const label = document.getElementById(TITLE_ID);
  if (label) label.textContent = title ?? hostOf(target);

  const frame = stageFrame();
  if (!frame) return;
  void navigateInPlaceFrame(frame, target)
    .then(() => {
      // el foco va DESPUES de navegar: durante la carga el frame aun no tiene
      // documento al que enviarle las teclas.
      //
      // se pide en el then y no en un "load" porque navigateInPlaceFrame es
      // asincrono y el "load" no es fiable con folio: en la primera apertura el
      // frame es nuevo y ensureFolioFrame tarda (si el await resuelve antes del
      // load, el foco se pedia sobre un frame sin documento y se perdia), y en
      // las siguientes el frame ya esta cacheado y resuelve de inmediato — si el
      // "load" ya habia ocurrido, el evento no vuelve a llegar. por eso el
      // teclado funcionaba a veces y otras no. focusFrameSoon ademas reintenta
      // por si el documento proxied atachea sus listeners despues.
      focusFrameSoon(frame);
    })
    .catch(() => {
      // si folio no esta listo el frame se queda en blanco: se avisa en la barra
      // en vez de dejar una pantalla vacia sin explicacion
      if (label) label.textContent = "the page could not be loaded";
    });

  if (!onKeyDown) {
    onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !isStageOpen()) return;
      event.preventDefault();
      closeStage();
    };
    window.addEventListener("keydown", onKeyDown);
  }
}

/**
 * Cierra el visor. Lo exporta quien lo abre desde un menu: cambiar de seccion
 * con el visor abierto lo cierra, porque los catalogos y sus menus se dibujan
 * por debajo de la pantalla y si no, un clic en "games" no haria nada visible.
 */
export function closeStage(): void {
  if (!stageReady()) return;
  const stage = document.getElementById(STAGE_ID) as HTMLDivElement | null;
  if (!stage || stage.hidden) return;
  stage.hidden = true;
  const frame = stageFrame();
  // el frame se destruye en vez de solo esconderse: un folio vivo con la
  // pantalla cerrada seguiria gastando CPU y red sin que nadie lo vea
  if (frame) destroyInPlaceFrame(frame);
  if (onKeyDown) {
    window.removeEventListener("keydown", onKeyDown);
    onKeyDown = null;
  }
}

// solo el host, sin ruta ni query: es lo que cabe en una barra corta y es lo
// que identifica la pagina de un vistazo
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
