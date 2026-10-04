import { describe, expect, test } from "bun:test";
import { resizeBox, type PanelBox } from "./panelBox.ts";
import { RESIZE_HANDLES, cursorForHandle } from "./resizeHandles.ts";

// antes solo se podia agrandar desde una esquina. estos fijan que las ocho
// zonas hacen lo que dice una ventana de verdad: el lado que se mueve desplaza
// tambien la posicion, el que solo crece no.
const BOX: PanelBox = { left: 300, top: 200, width: 600, height: 400 };
const VIEW_W = 1600;
const VIEW_H = 900;

describe("resize desde las ocho zonas", () => {
  test("arrastrar el este solo crece a la derecha, sin mover el borde izquierdo", () => {
    const r = resizeBox(BOX, ["e"], 100, 0, VIEW_W, VIEW_H);
    expect(r.width).toBe(700);
    expect(r.left).toBe(300); // el oeste sigue donde estaba
    expect(r.height).toBe(400);
  });

  test("arrastrar el oeste crece hacia la izquierda y desplaza la posicion", () => {
    const r = resizeBox(BOX, ["w"], -100, 0, VIEW_W, VIEW_H);
    expect(r.width).toBe(700);
    expect(r.left).toBe(200); // el borde pegado se movio 100 a la izquierda
  });

  test("arrastrar el sur solo crece hacia abajo", () => {
    const r = resizeBox(BOX, ["s"], 0, 80, VIEW_W, VIEW_H);
    expect(r.height).toBe(480);
    expect(r.top).toBe(200);
  });

  test("arrastrar el norte crece hacia arriba y desplaza la posicion", () => {
    const r = resizeBox(BOX, ["n"], 0, -80, VIEW_W, VIEW_H);
    expect(r.height).toBe(480);
    expect(r.top).toBe(120);
  });

  test("una esquina mueve los dos bordes", () => {
    const r = resizeBox(BOX, ["n", "w"], -50, -50, VIEW_W, VIEW_H);
    expect(r.width).toBe(650);
    expect(r.height).toBe(450);
    expect(r.left).toBe(250);
    expect(r.top).toBe(150);
  });

  test("encoger no baja del minimo", () => {
    const r = resizeBox(BOX, ["e"], -5000, -5000, VIEW_W, VIEW_H);
    expect(r.width).toBeGreaterThanOrEqual(320);
    expect(r.height).toBeGreaterThanOrEqual(220);
  });

  test("al topar con el minimo, el borde movido se queda pegado al cuerpo", () => {
    // el fallo que motiva el ajuste: al llegar al tope, el borde hacia el que se
    // arrastra seguia alejandose y la ventana dejaba de seguir al puntero
    const r = resizeBox(BOX, ["w"], 5000, 0, VIEW_W, VIEW_H);
    expect(r.width).toBe(320);
    // el oeste quedo a (left + width) = right del original, no mas lejos
    expect(r.left + r.width).toBe(900);
  });

  test("no crece mas alla de la pantalla", () => {
    // se usan los cuatro bordes a la vez: arrastrar solo el este no toca el alto
    const r = resizeBox(BOX, ["e", "s"], 5000, 5000, VIEW_W, VIEW_H);
    // el tope es la ventana menos el margen por los lados (1600 - 18*2 = 1564)
    expect(r.width).toBe(VIEW_W - 18 * 2);
    // y, en alto, menos la barra de menus y el margen inferior (900 - 74 - 18)
    expect(r.height).toBe(VIEW_H - 74 - 18);
    expect(r.left).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeGreaterThanOrEqual(0);
  });

  test("arrastrar solo el este no cambia el alto", () => {
    // el alto se queda como estaba aunque el raton baje: el asa lateral solo
    // manda en su eje, como en cualquier ventana
    const r = resizeBox(BOX, ["e"], 5000, 5000, VIEW_W, VIEW_H);
    expect(r.height).toBe(400);
  });

  test("la caja resultante siempre queda dentro de la ventana", () => {
    for (const edges of [["n"], ["s"], ["e"], ["w"], ["n", "e"]] as const) {
      const r = resizeBox(BOX, edges, 300, 300, VIEW_W, VIEW_H);
      expect(r.left).toBeGreaterThanOrEqual(0);
      expect(r.top).toBeGreaterThanOrEqual(0);
      expect(r.left + r.width).toBeLessThanOrEqual(VIEW_W);
    }
  });

  test("sin resize la caja no cambia", () => {
    const r = resizeBox(BOX, [], 100, 100, VIEW_W, VIEW_H);
    expect(r).toEqual(BOX);
  });
});

describe("las ocho zonas estan definidas", () => {
  test("cubren las cuatro esquinas y los cuatro bordes", () => {
    const nombres = RESIZE_HANDLES.map((h) => h.handle);
    expect(nombres).toContain("nw");
    expect(nombres).toContain("ne");
    expect(nombres).toContain("sw");
    expect(nombres).toContain("se");
    expect(nombres).toContain("n");
    expect(nombres).toContain("s");
    expect(nombres).toContain("e");
    expect(nombres).toContain("w");
  });

  test("cada esquina declara sus dos bordes", () => {
    const nw = RESIZE_HANDLES.find((h) => h.handle === "nw");
    expect(nw?.edges).toEqual(["n", "w"]);
  });

  test("el cursor corresponde a la direccion del asa", () => {
    // si el asa norte dice "ew-resize", el usuario arrastra en horizontal
    expect(cursorForHandle("n")).toBe("ns-resize");
    expect(cursorForHandle("s")).toBe("ns-resize");
    expect(cursorForHandle("e")).toBe("ew-resize");
    expect(cursorForHandle("w")).toBe("ew-resize");
    expect(cursorForHandle("nw")).toBe("nwse-resize");
    expect(cursorForHandle("se")).toBe("nwse-resize");
    expect(cursorForHandle("ne")).toBe("nesw-resize");
    expect(cursorForHandle("sw")).toBe("nesw-resize");
  });
});