import { describe, expect, test } from "bun:test";
import {
  installFrameDiagnostics,
  type FrameDiagnosticReport,
} from "./frameDiagnostics";

type Listener = () => void;

function fakeDocument() {
  const listeners = new Map<string, Listener[]>();
  return {
    activeElement: null as Element | null,
    pointerLockElement: null as Element | null,
    visibilityState: "visible",
    hasFocus: () => true,
    addEventListener: (type: string, listener: Listener) => {
      const list = listeners.get(type) ?? [];
      list.push(listener);
      listeners.set(type, list);
    },
    fire: (type: string) => {
      for (const listener of listeners.get(type) ?? []) listener();
    },
  };
}

function fakeFrame(doc: unknown, win: unknown): HTMLIFrameElement {
  return { contentDocument: doc, contentWindow: win } as unknown as HTMLIFrameElement;
}

function fakeWindow() {
  return {
    addEventListener: () => {},
  } as unknown as {
    addEventListener: () => void;
    __lyraDiag?: () => FrameDiagnosticReport;
  };
}

describe("frame diagnostics", () => {
  test("no instala nada si el frame es de otro origen", () => {
    expect(installFrameDiagnostics(fakeFrame(null, null))).toBe(false);
  });

  test("instala el reporte y no lo duplica en una segunda llamada", () => {
    const doc = fakeDocument();
    const win = fakeWindow();
    const frame = fakeFrame(doc, win);

    expect(installFrameDiagnostics(frame)).toBe(true);
    expect(typeof win.__lyraDiag).toBe("function");

    const first = win.__lyraDiag!();
    expect(first.activeElement).toBe("null");
    expect(first.pointerLockElement).toBeNull();
    expect(first.hasFocus).toBe(true);
    expect(first.keyEvents).toBe(0);

    // segunda instalacion: no vuelve a enganchar
    expect(installFrameDiagnostics(frame)).toBe(true);
  });

  test("cuenta los keydown para saber si el frame recibe teclado", () => {
    const doc = fakeDocument();
    const win = fakeWindow();
    installFrameDiagnostics(fakeFrame(doc, win));

    doc.fire("keydown");
    doc.fire("keydown");

    expect(win.__lyraDiag!().keyEvents).toBe(2);
  });

  test("guarda los eventos de foco con marca de tiempo", () => {
    const doc = fakeDocument();
    const win = fakeWindow();
    installFrameDiagnostics(fakeFrame(doc, win));

    doc.fire("blur");
    doc.fire("pointerlockerror");

    const events = win.__lyraDiag!().events;
    expect(events).toHaveLength(2);
    expect(events[0]).toContain("blur");
    expect(events[1]).toContain("pointerlockerror");
  });
});
