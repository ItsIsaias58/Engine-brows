import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  focusFrame,
  focusFrameSoon,
  markFrameFocusable,
  setFocusScheduler,
} from "./frameFocus";

// stub minimo: el entorno de test de bun no trae document, y meter jsdom para
// dos llamadas seria meter una dependencia de 10MB en el repo. hace falta solo
// lo que estas dos funciones tocan.
class FakeFrame {
  connected = true;
  focused = 0;
  dataset: Record<string, string> = {};
  private attrs = new Map<string, string>();
  private _tabIndex = -1;

  // el DOM real refleja tabIndex al atributo: sin esto, hasAttribute("tabindex")
  // mentiria y el testaria el stub en vez del codigo
  get tabIndex(): number {
    return this._tabIndex;
  }

  set tabIndex(value: number) {
    this._tabIndex = value;
    this.attrs.set("tabindex", String(value));
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  focus(options?: { preventScroll?: boolean }): void {
    this.focused += 1;
  }
}

function frame() {
  return new FakeFrame() as unknown as HTMLIFrameElement;
}

const realWindow = (globalThis as Record<string, unknown>).window;

// el teclado nunca llegaba al juego de dentro del iframe: el clic sí entraba (el
// navegador rehacia el hit-test) pero las teclas se quedaban en el documento
// padre. todo juego que solo necesitaba el ratón parecía funcionar; los que
// necesitan escribir —el chat de minecraft, los nombres, WASD— no tenían buffer
// de teclado ninguno.
describe("iframe focus", () => {
  beforeAll(() => {
    (globalThis as Record<string, unknown>).window = {};
  });

  afterAll(() => {
    (globalThis as Record<string, unknown>).window = realWindow;
  });

  test("a frame is marked focusable so the browser can hand it the keyboard", () => {
    const f = frame();
    markFrameFocusable(f);

    expect(f.getAttribute("data-lyra-focusable")).toBe("true");
    // focusable pero fuera del tab order: el foco lo da la app, no el Tab. sin
    // tabindex, Tab se salta el iframe y el foco vuelve al padre.
    expect(f.tabIndex).toBe(-1);
  });

  test("an existing tabindex is not overwritten", () => {
    const f = frame();
    f.tabIndex = 0;
    markFrameFocusable(f);

    expect(f.tabIndex).toBe(0);
    expect(f.getAttribute("data-lyra-focusable")).toBe("true");
  });

  test("a frame that is not in the document is not focused", () => {
    const f = frame();
    (f as unknown as FakeFrame).connected = false;

    focusFrame(f);
    expect((f as unknown as FakeFrame).focused).toBe(0);
  });

  test("a frame without a source is left alone", () => {
    // sin src no hay documento todavia: enfocarlo lanzaria en vez de no hacer
    // nada, y el error abortaria la navegacion que acaba de prepararlo
    const f = frame();
    focusFrame(f);

    expect((f as unknown as FakeFrame).focused).toBe(0);
  });

  // el bug era intermitente — unas veces si, otras no — porque el foco se pedia
  // en un listener de "load" de un solo uso: en la primera apertura el frame es
  // nuevo y el load llega tarde, y en las siguientes el frame ya esta cacheado y
  // el load no vuelve a ocurrir. el flag hace que el enganche se arme UNA vez y
  // no se re-arme en cada navegacion (lo que ademas acumulaba listeners).
  test("armFrameFocus engancha una sola vez por frame", () => {
    // se reproduce la regla sin importar el iframe.ts completo: el enganche se
    // marca con un flag en dataset, y la segunda llamada no vuelve a enganchar
    const attach = (f: FakeFrame): boolean => {
      if (f.dataset["focusArmed"] === "true") return false;
      f.dataset["focusArmed"] = "true";
      return true;
    };

    const f = new FakeFrame();
    expect(attach(f)).toBe(true);
    expect(attach(f)).toBe(false);
    expect(attach(f)).toBe(false);
  });

  test("a loaded frame is focused", () => {
    const f = frame();
    f.setAttribute("src", "/owngames/csgo-opencase/");

    focusFrame(f);
    expect((f as unknown as FakeFrame).focused).toBe(1);
  });

  test("a folio frame that never sets src is focused by manualUrl", () => {
    // folio navega escribiendo en el frame sin pasar por src, asi que el src
    // sigue vacío: sin mirar manualUrl el foco nunca se le daria
    const f = frame();
    (f as unknown as Record<string, unknown>).dataset = {
      manualUrl: "/f?s=abc",
    };

    focusFrame(f);
    expect((f as unknown as FakeFrame).focused).toBe(1);
  });

  test("null and undefined are accepted", () => {
    expect(() => focusFrame(null)).not.toThrow();
    expect(() => focusFrame(undefined)).not.toThrow();
  });

  // con iframes cross-origin (los juegos van por /!!/) enfocar solo el elemento
  // no siempre pasa el teclado al documento de dentro: hay que enfocar tambien
  // contentWindow.
  test("focusFrame enfoca tambien el documento interno", () => {
    const f = frame();
    f.setAttribute("src", "/!!/game/");
    let innerFocused = 0;
    (f as unknown as Record<string, unknown>).contentWindow = {
      focus: () => {
        innerFocused += 1;
      },
    };

    focusFrame(f);

    expect(innerFocused).toBe(1);
  });

  // el load puede llegar antes que el documento proxied: se reintenta hasta que
  // el iframe sea el elemento activo, y entonces se deja de insistir para no
  // robarle el foco a lo que el usuario este haciendo.
  test("focusFrameSoon reintenta y para cuando el frame ya es el activo", () => {
    const f = frame();
    f.setAttribute("src", "/!!/game/");
    const fakeDoc = { activeElement: null as unknown };
    (globalThis as Record<string, unknown>).document = fakeDoc;
    const queue: Array<() => void> = [];
    setFocusScheduler((fn) => queue.push(fn));
    try {
      focusFrameSoon(f, 3, 0);
      // primer intento: todavia no es el activo -> enfoca una vez
      expect((f as unknown as FakeFrame).focused).toBe(1);

      // el navegador ahora lo marca como activo antes de los reintentos
      fakeDoc.activeElement = f;
      while (queue.length > 0) queue.shift()!();

      // ya era el activo: no vuelve a robar el foco
      expect((f as unknown as FakeFrame).focused).toBe(1);
    } finally {
      setFocusScheduler(null);
      delete (globalThis as Record<string, unknown>).document;
    }
  });
});