import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  nextTrack,
  playPreset,
  playSearchResult,
  prevTrack,
  queueSignal,
  searchResultsSignal,
  stopMusic,
} from "./music.ts";

// la cola se prueba a traves de sus funciones reales (no de un espejo), asi que
// hay que darle el minimo de DOM/ventana que piden al tocar el iframe del embed.
// el stub devuelve null en getElementById: las funciones de cola no necesitan que
// el frame exista, solo que no les explote document.
const realDocument = (globalThis as Record<string, unknown>).document;
const realWindow = (globalThis as Record<string, unknown>).window;

function stubElement() {
  return {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains: () => false },
    children: [] as unknown[],
    appendChild() {},
    removeChild() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    hasAttribute: () => false,
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    get isConnected() {
      return true;
    },
  };
}

beforeAll(() => {
  const doc = {
    getElementById: () => null,
    createElement: () => stubElement(),
    body: stubElement(),
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = {
    addEventListener() {},
    removeEventListener() {},
    innerWidth: 1280,
    innerHeight: 800,
    location: { origin: "https://lyra.example", href: "https://lyra.example/" },
  };
});

afterAll(() => {
  (globalThis as Record<string, unknown>).document = realDocument;
  (globalThis as Record<string, unknown>).window = realWindow;
});

// la cola no tenia NINGUN test. todos los de musica.ts eran de parseo de urls
// y del puente de busqueda: la zona con mas estado era la zona sin cubierta, y
// por eso se colaron dos bugs de sincronizacion — la UI leia queueSignal, y
// casi ningun camino que cambia la cola lo actualizaba.
afterEach(() => {
  stopMusic();
});

// la UI no lee `queue`: lee queueSignal. si un camino cambia la cola sin
// sincronizar, la lista "up next" muestra canciones que no son las que suenan.
describe("la cola y lo que ve la UI", () => {
  test("elegir un resultado de busqueda publica la cola nueva", () => {
    searchResultsSignal.value = [
      { id: "aaaaaaaaaaa", title: "una", channel: "x", source: "youtube" },
      { id: "bbbbbbbbbbb", title: "dos", channel: "x", source: "youtube" },
      { id: "ccccccccccc", title: "tres", channel: "x", source: "youtube" },
    ];

    playSearchResult(1);

    // sin esto, "up next" seguia mostrando la cola anterior (o ninguna): el
    // bug era que playRevealed no sincronizaba
    expect(queueSignal.value.items).toHaveLength(3);
    expect(queueSignal.value.index).toBe(1);
    expect(queueSignal.value.items[1]?.title).toBe("dos");
  });

  test("un preset publica su cola", () => {
    playPreset({ id: "lofi", name: "lofi", videoId: "jfKfPfyJRdk" });

    expect(queueSignal.value.items).toHaveLength(1);
    expect(queueSignal.value.index).toBe(0);
  });

  test("parar vacia la cola tambien para la UI", () => {
    playPreset({ id: "lofi", name: "lofi", videoId: "jfKfPfyJRdk" });
    expect(queueSignal.value.items.length).toBeGreaterThan(0);

    stopMusic();

    // sin sincronizar aqui, "up next" seguia listando lo que ya no sonaba
    expect(queueSignal.value.items).toHaveLength(0);
    expect(queueSignal.value.index).toBe(-1);
  });
});

describe("avance por la cola", () => {
  test("siguiente y anterior dan la vuelta", () => {
    searchResultsSignal.value = [
      { id: "aaaaaaaaaaa", title: "una", channel: "x", source: "youtube" },
      { id: "bbbbbbbbbbb", title: "dos", channel: "x", source: "youtube" },
    ];
    playSearchResult(0);

    nextTrack();
    expect(queueSignal.value.index).toBe(1);
    // en el ultimo, siguiente vuelve al principio
    nextTrack();
    expect(queueSignal.value.index).toBe(0);
    prevTrack();
    expect(queueSignal.value.index).toBe(1);
  });

  test("una busqueda vacia no toca la cola", () => {
    playPreset({ id: "lofi", name: "lofi", videoId: "jfKfPfyJRdk" });
    searchResultsSignal.value = [];

    playSearchResult(0);

    // si se hubiera limpiado, se perdia lo que estaba sonando
    expect(queueSignal.value.items).toHaveLength(1);
    expect(queueSignal.value.index).toBe(0);
  });

  test("un indice fuera de rango se sujeta al ultimo", () => {
    searchResultsSignal.value = [
      { id: "aaaaaaaaaaa", title: "una", channel: "x", source: "youtube" },
      { id: "bbbbbbbbbbb", title: "dos", channel: "x", source: "youtube" },
    ];

    playSearchResult(99);

    expect(queueSignal.value.index).toBe(1);
  });
});