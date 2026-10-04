import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

// Invariante del repo: la app existe para servir contenido por su proxy, asi
// que un window.open o un target="_blank" son un agujero hacia el navegador del
// sistema (sin proxy, sin cloaking, sin HUD). cloaking.ts queda fuera a
// proposito: ahi la ventana nativa ES la funcion (abrir la copia que se
// enmascara como otra pagina).
// rutas relativas a src/
const ALLOWED_NATIVE_WINDOWS = new Set([path.join("features", "cloaking.ts")]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("nada se escapa a una ventana nativa", () => {
  // este archivo vive en src/core/browser, asi que hay que subir dos niveles
  // para llegar a src (con uno solo se queda en src/core y no escanea nada)
  const srcDir = path.resolve(import.meta.dir, "..", "..");
  const offenders: string[] = [];

  for (const file of sourceFiles(srcDir)) {
    const contents = fs.readFileSync(file, "utf8");
    // se ignoran los comentarios (de linea y de bloque): varios explican
    // justamente por que ya no se usa window.open, y contarlos como infraccion
    // haria que el test fallara contra su propia documentacion
    const code = contents
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    if (/window\.open\s*\(/.test(code) || /target=\\?["']_blank/.test(code)) {
      const relative = path.relative(srcDir, file);
      if (!ALLOWED_NATIVE_WINDOWS.has(relative)) offenders.push(relative);
    }
  }

  test("ningun modulo abre ventanas del navegador del sistema", () => {
    expect(offenders).toEqual([]);
  });
});

describe("openInApp", () => {
  // el visor se sustituye entero: en bun no hay DOM y lo que se prueba aqui es
  // la decision de openInApp (abrir el visor, no una pestana ni una ventana),
  // no el overlay, que necesita un navegador de verdad
  let stageReady = true;
  let stageThrows = false;
  const opened: string[] = [];
  let openInApp: (url: string) => boolean;

  beforeAll(async () => {
    mock.module("./stageOverlay.ts", () => ({
      stageReady: () => stageReady,
      openStage: (url: string) => {
        if (stageThrows) throw new Error("boom");
        opened.push(url);
      },
      closeStage: () => {},
      isStageOpen: () => opened.length > 0,
      hostOf: (url: string) => url,
    }));
    // import dinamico: el modulo tiene que evaluarse DESPUES del mock, y los
    // imports estaticos se suben antes de que corra este archivo
    openInApp = (await import("./openInApp.ts")).openInApp;
  });

  const originalWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    stageReady = true;
    stageThrows = false;
    opened.length = 0;
  });

  test("manda la url al visor, no al navegador de pestanas", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(openInApp("https://open.spotify.com/")).toBe(true);
    expect(opened).toEqual(["https://open.spotify.com/"]);
  });

  // sin titulo ni icono: el visor ya pone el host en su barra, y abrir in-app
  // ya no pasa por handleSearch (que usaba el titulo para marcar "esto es un
  // juego" y entonces le pegaba /index.html al final)
  test("pasa solo la url, sin titulo ni icono", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(openInApp("https://agar.io/v0_84d65/")).toBe(true);
    expect(opened[0]).toBe("https://agar.io/v0_84d65/");
  });

  test("una url vacia no abre nada", () => {
    (globalThis as { window?: unknown }).window = {};
    expect(openInApp("")).toBe(false);
    expect(openInApp("   ")).toBe(false);
    expect(opened).toEqual([]);
  });

  // sin fallback a window.open a proposito: si el visor no esta listo, se avisa.
  // un sitio que no se puede abrir por el proxy es informacion, no algo que se
  // esconda abriendo el navegador del sistema
  test("sin visor listo devuelve false en vez de abrir nada", () => {
    (globalThis as { window?: unknown }).window = {};
    stageReady = false;
    expect(openInApp("https://example.com/")).toBe(false);
    expect(opened).toEqual([]);
  });

  test("un visor que revienta no propaga la excepcion", () => {
    (globalThis as { window?: unknown }).window = {};
    stageThrows = true;
    expect(() => openInApp("https://example.com/")).not.toThrow();
    expect(openInApp("https://example.com/")).toBe(false);
  });
});
