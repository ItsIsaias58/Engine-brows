import { describe, expect, test } from "bun:test";
import {
  fitBoxToViewport,
  maximizedBox,
  panelLimits,
  PANEL_MARGIN,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  PANEL_TOP_INSET,
} from "./panelBox.ts";

// Pantallas de referencia: portatil pequeno, portatil normal, monitor grande y
// un movil, que es donde antes se rompia todo.
const LAPTOP = { w: 1366, h: 768 };
const DESKTOP = { w: 1920, h: 1080 };
const PHONE = { w: 390, h: 844 };

describe("panelLimits", () => {
  test("deja el margen por los lados y la barra de menus arriba", () => {
    const { width, height } = panelLimits(DESKTOP.w, DESKTOP.h);
    expect(width).toBe(DESKTOP.w - PANEL_MARGIN * 2);
    expect(height).toBe(DESKTOP.h - PANEL_TOP_INSET - PANEL_MARGIN);
  });

  test("nunca baja del suelo, ni en una ventana de telefono", () => {
    const { width, height } = panelLimits(200, 200);
    expect(width).toBeGreaterThanOrEqual(200);
    expect(height).toBeGreaterThanOrEqual(180);
  });
});

describe("fitBoxToViewport", () => {
  test("una caja mayor que la pantalla se encoge y se vuelve a meter", () => {
    // caso real: la caja se guardo en el monitor de 1920 y ahora la ventana
    // es un portatil de 1366. antes se quedaba colgando fuera de la pantalla
    const box = { left: 1400, top: 700, width: 1200, height: 900 };
    const fitted = fitBoxToViewport(box, LAPTOP.w, LAPTOP.h);
    expect(fitted.width).toBeLessThanOrEqual(LAPTOP.w);
    expect(fitted.height).toBeLessThanOrEqual(LAPTOP.h);
    expect(fitted.left + fitted.width).toBeLessThanOrEqual(LAPTOP.w);
    expect(fitted.top + fitted.height).toBeLessThanOrEqual(LAPTOP.h);
  });

  test("una caja arrastrada fuera vuelve dentro sin cambiar de tamano", () => {
    const fitted = fitBoxToViewport(
      { left: -300, top: -200, width: 400, height: 300 },
      DESKTOP.w,
      DESKTOP.h,
    );
    expect(fitted.left).toBe(0);
    expect(fitted.top).toBe(0);
    expect(fitted.width).toBe(400);
    expect(fitted.height).toBe(300);
  });

  test("una caja que ya cabe no se toca", () => {
    const box = { left: 100, top: 120, width: 420, height: 500 };
    expect(fitBoxToViewport(box, DESKTOP.w, DESKTOP.h)).toEqual(box);
  });

  // se aplica tres veces seguidas (leer de disco, arrastrar, cambiar la
  // ventana): si no fuera idempotente, aplicarla dos veces deformaria la caja
  test("es idempotente", () => {
    const box = { left: 1500, top: 950, width: 1100, height: 800 };
    const once = fitBoxToViewport(box, LAPTOP.w, LAPTOP.h);
    expect(fitBoxToViewport(once, LAPTOP.w, LAPTOP.h)).toEqual(once);
  });

  test("respeta el minimo util siempre que la ventana lo permita", () => {
    const small = fitBoxToViewport(
      { left: 0, top: 0, width: 10, height: 10 },
      DESKTOP.w,
      DESKTOP.h,
    );
    expect(small.width).toBe(PANEL_MIN_WIDTH);
    expect(small.height).toBe(PANEL_MIN_HEIGHT);
  });

  test("en un movil encoge por debajo del minimo antes que salirse", () => {
    const fitted = fitBoxToViewport(
      { left: 0, top: 0, width: 380, height: 560 },
      PHONE.w,
      PHONE.h,
    );
    expect(fitted.width).toBeLessThanOrEqual(PHONE.w - PANEL_MARGIN * 2);
    expect(fitted.left).toBeGreaterThanOrEqual(0);
    expect(fitted.left + fitted.width).toBeLessThanOrEqual(PHONE.w);
  });
});

describe("maximizedBox", () => {
  test("ocupa todo lo disponible por debajo de la barra de menus", () => {
    const box = maximizedBox(DESKTOP.w, DESKTOP.h);
    expect(box.left).toBe(PANEL_MARGIN);
    expect(box.top).toBe(PANEL_TOP_INSET);
    expect(box.left + box.width).toBe(DESKTOP.w - PANEL_MARGIN);
    expect(box.top + box.height).toBe(DESKTOP.h - PANEL_MARGIN);
  });

  test("sigue encajando al encoger la ventana", () => {
    const box = maximizedBox(PHONE.w, PHONE.h);
    expect(box.left + box.width).toBeLessThanOrEqual(PHONE.w);
    expect(box.top + box.height).toBeLessThanOrEqual(PHONE.h);
    expect(box.top).toBeGreaterThanOrEqual(PANEL_TOP_INSET);
  });
});
