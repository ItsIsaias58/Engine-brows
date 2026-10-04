// Por que el raton funcionaba y el teclado no: un iframe sin foco recibe los
// clics (el navegador le reenvia el hit-test) pero las teclas van al documento
// padre. Los juegos que se mueven con rato parecian funcionar; los que necesitan
// escribir —el chat de Minecraft, los nombres, WASD— no tenian buffer de teclado
// ninguno. No era del juego: era del contenedor.
//
// El arreglo no es un listener: un listener en el padre no recibe lo que el hijo
// nunca recibio. Hay que darle el foco al iframe.
//
// Vive en su propio modulo (sin imports) por lo mismo que internalRoutes.ts: se
// prueba directamente, sin levantar tabs, folio ni el resto del navegador.

const FOCUSABLE_FRAME_ATTR = "data-lyra-focusable";

/**
 * El iframe tiene que ser alcanzable por el tab order para que el navegador le
 * pueda dar el foco. Un iframe sin tabindex es focusable por script, pero
 * Empress/Tab lo saltan: tras pulsar Tab el foco vuelve al padre y se pierde otra
 * vez. Con tabindex="-1" el iframe es focusable pero queda fuera del recorrido,
 * que es justo lo que se quiere aqui: el foco se lo da la app, no el Tab.
 */
export function markFrameFocusable(frame: HTMLIFrameElement): void {
  frame.setAttribute(FOCUSABLE_FRAME_ATTR, "true");
  if (!frame.hasAttribute("tabindex")) frame.tabIndex = -1;
}

/**
 * El foco esta ahora mismo en el frame de un juego.
 *
 * Lo consulta el modal de nueva pestana antes de devolverle el foco a su input:
 * al abrir un juego el modal se cierra y su focus() corre en el ciclo de React,
 * ya DESPUES de que el frame se enfocara, asi que se lo quitaba y el juego se
 * quedaba sin teclado. Sin esta comprobacion, cualquier cierre de modal roba el
 * teclado a lo que este detras.
 */
export function isGameFrameFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLIFrameElement && FOCUSABLE_FRAME_ATTR in active.dataset;
}

/**
 * Le da el foco al iframe para que sus keydown lleguen a la pagina que sirve.
 * Sin esto el juego se ve pero no se puede usar con teclado.
 */
export function focusFrame(frame: HTMLIFrameElement | null | undefined): void {
  if (!frame || !frame.isConnected) return;
  // el src del folio cambia en cada navegacion; sin src no hay documento que
  // enfocar y focus() lanzaria en vez de no hacer nada. dataset se lee con
  // optional chaining porque un frame recien creado todavia puede no tenerlo
  if (!frame.getAttribute("src") && !frame.dataset?.manualUrl) return;
  try {
    frame.focus({ preventScroll: true });
  } catch {
    // browsers antiguos rechazan el objeto de opciones
    try {
      frame.focus();
    } catch {}
  }
}