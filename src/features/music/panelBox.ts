// Geometria de la ventana del reproductor de musica.
//
// Vive aparte del componente porque es lo unico de esa ventana que hay que
// comprobar de verdad: que nunca pueda quedar fuera de la pantalla. Si la caja
// se guardo en una pantalla grande y luego la ventana del navegador se hace mas
// pequena, el panel se queda a medias fuera del area visible y ya no hay forma
// de agarrarlo para devolverlo: por eso al leerla siempre se reencaja.

import type { ResizeEdge } from "./resizeHandles.ts";

export const PANEL_MARGIN = 18;

// Alto que la ventana del panel no puede usar arriba: la barra de menus vive en
// top 25px con 35px de alto (#top-left-stuff, base/index.css) y el panel tiene
// que quedar por debajo, que es lo que deja games/anime/music/settings
// pulsables por encima de el.
export const PANEL_TOP_INSET = 74;

export const PANEL_MIN_WIDTH = 320;
export const PANEL_MIN_HEIGHT = 220;

// Suelos absolutos: por debajo la ventana ya no es utilizable, pero en una
// ventana de telefono vale mas encogerla que dejar parte del panel fuera.
const PANEL_FLOOR_WIDTH = 240;
const PANEL_FLOOR_HEIGHT = 180;

export interface PanelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PanelLimits {
  width: number;
  height: number;
}

// Cuanto puede ocupar la ventana como maximo en una ventana de `viewportWidth`
// x `viewportHeight`, dejando el margen por los cuatro lados y la barra de
// menus arriba.
export function panelLimits(
  viewportWidth: number,
  viewportHeight: number,
): PanelLimits {
  return {
    width: Math.max(
      PANEL_FLOOR_WIDTH,
      viewportWidth - PANEL_MARGIN * 2,
    ),
    height: Math.max(
      PANEL_FLOOR_HEIGHT,
      viewportHeight - PANEL_TOP_INSET - PANEL_MARGIN,
    ),
  };
}

// mantiene el panel dentro de la ventana: no se puede arrastrar fuera de la
// pantalla, donde el usuario no lo veria ni podria volver a agarrarlo.
function clampToViewport(
  position: number,
  size: number,
  viewport: number,
): number {
  return Math.min(Math.max(position, 0), Math.max(0, viewport - size));
}

/**
 * Encaja una caja dentro de la ventana actual: primero la encoge si era mayor
 * de lo que cabe, despues la vuelve a meter si se habia quedado fuera.
 *
 * Idempotente a proposito: se aplica al leerla de disco, en cada paso de un
 * arrastre y al cambiar el tamano de la ventana, y en los tres casos el ajuste
 * tiene que poder volver a aplicarse sin mover nada.
 */
export function fitBoxToViewport(
  box: PanelBox,
  viewportWidth: number,
  viewportHeight: number,
): PanelBox {
  const limits = panelLimits(viewportWidth, viewportHeight);
  const width = Math.round(
    Math.min(
      Math.max(box.width, Math.min(PANEL_MIN_WIDTH, limits.width)),
      limits.width,
    ),
  );
  const height = Math.round(
    Math.min(
      Math.max(box.height, Math.min(PANEL_MIN_HEIGHT, limits.height)),
      limits.height,
    ),
  );
  return {
    width,
    height,
    left: Math.round(clampToViewport(box.left, width, viewportWidth)),
    top: Math.round(clampToViewport(box.top, height, viewportHeight)),
  };
}

/**
 * Agranda o encoge la caja arrastrando desde `edges`.
 *
 * La aritmetica es la de una ventana de verdad: un lado que se MUEVE (norte u
 * oeste) desplaza tambien su posicion, para que el borde contrario se quede
 * quieto donde estaba. Un lado que solo CRECE (sur y este) no mueve la posicion.
 *
 * Encogerse por debajo del minimo se compensa subiendo la posicion del lado que
 * se movia, en vez de dejar la caja mas pequena de lo permitido: si no, al
 * llegar al tope la ventana seguia absorbiendo el raton pero sin cambiar de
 * tamano, y el asa se veia quieta mientras el puntero se alejaba.
 */
export function resizeBox(
  box: PanelBox,
  edges: readonly ResizeEdge[],
  dx: number,
  dy: number,
  viewportWidth: number,
  viewportHeight: number,
): PanelBox {
  const limits = panelLimits(viewportWidth, viewportHeight);
  const minWidth = Math.min(PANEL_MIN_WIDTH, limits.width);
  const minHeight = Math.min(PANEL_MIN_HEIGHT, limits.height);

  const width = Math.round(
    Math.min(limits.width, Math.max(minWidth, box.width + (edges.includes("e") ? dx : edges.includes("w") ? -dx : 0))),
  );
  const height = Math.round(
    Math.min(
      limits.height,
      Math.max(minHeight, box.height + (edges.includes("s") ? dy : edges.includes("n") ? -dy : 0)),
    ),
  );

  // el borde que se movio se recalcula con la dimension REAL lograda, no con la
  // pedida: al topar con el minimo o con el limite de la pantalla, el borde tiene
  // que quedarse pegado al cuerpo de la ventana
  const left = edges.includes("w") ? box.left + (box.width - width) : box.left;
  const top = edges.includes("n") ? box.top + (box.height - height) : box.top;

  return fitBoxToViewport(
    { left, top, width, height },
    viewportWidth,
    viewportHeight,
  );
}

/**
 * Si dos cajas describen lo mismo. Sirve para no reescribir el estado ni el
 * localStorage cuando el ajuste no ha cambiado nada: en un arrastre se llama en
 * cada movimiento del raton, y guardar la misma caja cien veces por segundo no
 * es gratis.
 */
export function isSameBox(a: PanelBox, b: PanelBox): boolean {
  return (
    a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height
  );
}

// La caja de "maximizada": ocupa todo lo disponible por debajo de la barra de
// menus. Se deriva de la ventana en cada momento en vez de guardarse, para que
// al encoger la ventana siga encajando sola.
export function maximizedBox(
  viewportWidth: number,
  viewportHeight: number,
): PanelBox {
  const limits = panelLimits(viewportWidth, viewportHeight);
  return {
    left: PANEL_MARGIN,
    top: PANEL_TOP_INSET,
    width: limits.width,
    height: limits.height,
  };
}
