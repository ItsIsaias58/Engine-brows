// Tests de los predicados de ruta que comparten dev.mjs y prod.mjs.
//
// Estos predicados deciden a que servicio va una peticion, asi que el fallo
// caro no es que manden algo a donde no toca, sino lo contrario: que una ruta
// se quede sin enrutar y el cliente solo vea un 404. El caso real que motivo
// esto es /api/auth: dev.mjs la enrutaba a cloudsync y prod.mjs no, asi que con
// `bun run start` (prod) crear una cuenta no existia y el navegador solo podia
// decir "account creation failed".
import { describe, expect, test } from "bun:test";
import {
  isCloudSyncPath,
  isMarketApiPath,
  isOwnGamesPath,
  MARKET_WS_PATH,
} from "../server/serviceRoutes.mjs";

describe("isOwnGamesPath", () => {
  test("cubre el arbol de juegos y sus subrutas", () => {
    expect(isOwnGamesPath("/owngames")).toBe(true);
    expect(isOwnGamesPath("/owngames/")).toBe(true);
    expect(isOwnGamesPath("/owngames/bolsa-trading-floor/js/net.js")).toBe(true);
  });

  test("no se come una ruta que solo se le parece", () => {
    expect(isOwnGamesPath("/owngames2/")).toBe(false);
    expect(isOwnGamesPath("/api/owngames")).toBe(false);
    expect(isOwnGamesPath("/")).toBe(false);
  });
});

describe("isMarketApiPath", () => {
  test("cubre la api del mercado", () => {
    expect(isMarketApiPath("/api/market")).toBe(true);
    expect(isMarketApiPath("/api/market/accounts")).toBe(true);
    expect(isMarketApiPath("/api/market/music/search?source=spotify&q=x")).toBe(
      true,
    );
  });

  test("no captura las cuentas ni la nube", () => {
    expect(isMarketApiPath("/api/auth/register")).toBe(false);
    expect(isMarketApiPath("/api/sync/upload")).toBe(false);
  });
});

describe("isCloudSyncPath", () => {
  test("cubre las dos familias de cloudsync", () => {
    expect(isCloudSyncPath("/api/auth")).toBe(true);
    expect(isCloudSyncPath("/api/auth/register")).toBe(true);
    expect(isCloudSyncPath("/api/auth/login")).toBe(true);
    expect(isCloudSyncPath("/api/auth/me")).toBe(true);
    expect(isCloudSyncPath("/api/sync/upload")).toBe(true);
    expect(isCloudSyncPath("/api/sync/download")).toBe(true);
  });

  // lo que la Just tiene que proteger: si el predicado se hiciera laxo
  // ("lo que no sea mio, es de cloudsync"), un 404 por typo acabaria
  // escribiendo en la base de datos de las cuentas
  test("no captura el resto de la api de lyra", () => {
    for (const path of [
      "/api/authenticado",
      "/api/syncs",
      "/api/market/accounts",
      "/api/search",
      "/api/lyra",
    ]) {
      expect(isCloudSyncPath(path)).toBe(false);
    }
  });

  test("las familias del mercado y las de cloudsync no se pisan", () => {
    expect(isCloudSyncPath("/api/market/sessions")).toBe(false);
    expect(isMarketApiPath("/api/auth/register")).toBe(false);
  });
});

describe("MARKET_WS_PATH", () => {
  test("es una ruta exacta, no un arbol", () => {
    // dev lo compara por prefijo y prod por igualdad exacta a proposito: en dev
    // llega "/ws/market?session=..." sin parsear
    expect(MARKET_WS_PATH).toBe("/ws/market");
    expect(MARKET_WS_PATH.startsWith("/ws/market/")).toBe(false);
  });
});
