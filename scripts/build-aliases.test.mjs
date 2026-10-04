import { describe, expect, test } from "bun:test";
import {
  assertNoLogicalPaths,
  createRuntimePathMap,
  rewriteBuildTokens,
} from "../build.js";

// El build reescribe las rutas logicas (/b/all.js, /b/fl/folio.js...) por el
// nombre opaco que se emite. Si esa reescritura no llega a un chunk, el bundle
// sale-identico pero el navegador pide un fichero que no existe en dist/ y
// recibe un 404: el fallo se ve en el cliente, tres pasos despues del build.
// Estos tests fijan las dos mitades: que reescribe, y que avisa si no.
describe("alias de rutas del build", () => {
  const buildId = "testbuildid0001";
  const pathAliases = new Map([
    ...Object.entries(createRuntimePathMap(buildId)),
    ["/b/all.js", "/b/05d50625f023.js"],
  ]);

  test("las rutas logicas se sustituyen por su nombre opaco", () => {
    const source = 'const s=document.createElement("script");s.src="/b/all.js";';
    const rewritten = rewriteBuildTokens(source, new Map(), pathAliases);

    expect(rewritten).toBe(
      'const s=document.createElement("script");s.src="/b/05d50625f023.js";',
    );
  });

  test("es un reemplazo literal: tambien dentro de rutas mas largas", () => {
    const source = '"/b/all.js" + "|/b/all.js.map"';
    const rewritten = rewriteBuildTokens(source, new Map(), pathAliases);

    expect(rewritten).toBe('"/b/05d50625f023.js" + "|/b/05d50625f023.js.map"');
  });

  test("el guardia acepta el fuente ya reescrito", () => {
    const source = rewriteBuildTokens('src="/b/all.js"', new Map(), pathAliases);

    expect(() => assertNoLogicalPaths(source, pathAliases, "chunk.js")).not.toThrow();
  });

  test("el guardia falla nombrando el fichero y la ruta que se le escaparon", () => {
    let thrown = null;
    try {
      assertNoLogicalPaths('src="/b/all.js"', pathAliases, "chunk.js");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain("chunk.js");
    expect(thrown.message).toContain("/b/all.js");
  });

  test("tambien vigila los assets de runtime, no solo los chunks", () => {
    expect(() =>
      assertNoLogicalPaths('importScripts("/b/fl/controller.sw.js")', pathAliases, "sw.js"),
    ).toThrow();
  });
});
