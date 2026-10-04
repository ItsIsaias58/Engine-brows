// Tests de la resolucion de rutas bajo una raiz. safeJoin lo usan dos procesos
// (el server de lyra y el del mercado) asi que un fallo aqui es traversal de
// disco en ambos, no en uno.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { safeJoin } from "../server/staticPath.mjs";

const root = mkdtempSync(path.join(tmpdir(), "lyra-static-"));
// un archivo "hermano" fuera de la raiz, para comprobar que no se alcanza
const outside = path.join(path.dirname(root), "outside.txt");
writeFileSync(outside, "secreto");
mkdirSync(path.join(root, "sub"), { recursive: true });
writeFileSync(path.join(root, "sub", "ok.txt"), "dentro");

describe("safeJoin", () => {
  test("resuelve una ruta relativa dentro de la raiz", () => {
    expect(safeJoin(root, "sub/ok.txt")).toBe(path.join(root, "sub", "ok.txt"));
  });

  test("normaliza barras iniciales y duplicadas", () => {
    expect(safeJoin(root, "/sub//ok.txt")).toBe(path.join(root, "sub", "ok.txt"));
  });

  test("decodifica percent-encoding antes de resolver", () => {
    expect(safeJoin(root, "sub%2Fok.txt")).toBe(path.join(root, "sub", "ok.txt"));
  });

  test("acepta la propia raiz", () => {
    expect(safeJoin(root, "")).toBe(path.resolve(root));
  });

  describe("rechaza traversal", () => {
    test("segmento .. simple", () => {
      expect(safeJoin(root, "../outside.txt")).toBeNull();
    });

    test(".. en medio del camino", () => {
      expect(safeJoin(root, "sub/../../outside.txt")).toBeNull();
    });

    test(".. percent-encoded (no basta con mirar el string crudo)", () => {
      expect(safeJoin(root, "%2e%2e/outside.txt")).toBeNull();
    });

    test(".. con barra invertida", () => {
      expect(safeJoin(root, "..\\outside.txt")).toBeNull();
    });

    test(".. como sufijo de un nombre de archivo", () => {
      expect(safeJoin(root, "sub/..%2f..%2foutside.txt")).toBeNull();
    });

    test("byte nul", () => {
      expect(safeJoin(root, "sub/ok.txt\0.png")).toBeNull();
    });

    test("percent-encoding invalido", () => {
      expect(safeJoin(root, "%E0%A4%A")).toBeNull();
    });
  });

  test("null y undefined se tratan como cadena vacia", () => {
    expect(safeJoin(root, null)).toBe(path.resolve(root));
    expect(safeJoin(root, undefined)).toBe(path.resolve(root));
  });
});
