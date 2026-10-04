// Direcciones desde las que se puede agrandar el panel.
//
// Antes solo habia una esquina (arriba-izquierda, la opuesta al ancla) porque el
// grow mantenia fijo el borde inferior-derecho. El calculo ya era general — solo
// cambiaba que delta se restaba a la posicion—, asi que anadir bordes no obliga a
// tocar la aritmetica del arrastre, solo a enumerar las direcciones.
//
// N y W encogen hacia arriba/izquierda y mueven el borde de su lado; S y E solo
// crecen, sin mover el borde de salida. Por eso el grow es "start + delta" en el
// lado fijo y "start + delta - dimension" en el que se mueve.
//
// Vive aparte por lo mismo que panelBox.ts: se prueba sin DOM.

export type ResizeEdge = "n" | "s" | "e" | "w";

export type ResizeHandle = ResizeEdge | "nw" | "ne" | "sw" | "se";

/** Las ocho zonas de agarre, con la direccion de cada una. */
export const RESIZE_HANDLES: ReadonlyArray<{
  handle: ResizeHandle;
  edges: readonly ResizeEdge[];
}> = [
  { handle: "nw", edges: ["n", "w"] },
  { handle: "ne", edges: ["n", "e"] },
  { handle: "sw", edges: ["s", "w"] },
  { handle: "se", edges: ["s", "e"] },
  { handle: "n", edges: ["n"] },
  { handle: "s", edges: ["s"] },
  { handle: "e", edges: ["e"] },
  { handle: "w", edges: ["w"] },
];

/** El asa que crecio, con la direccion que aplico cada lado. */
export function cursorForHandle(handle: ResizeHandle): string {
  return (
    {
      n: "ns-resize",
      s: "ns-resize",
      e: "ew-resize",
      w: "ew-resize",
      nw: "nwse-resize",
      se: "nwse-resize",
      ne: "nesw-resize",
      sw: "nesw-resize",
    } as Record<ResizeHandle, string>
  )[handle];
}