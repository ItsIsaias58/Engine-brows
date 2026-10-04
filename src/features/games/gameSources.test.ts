import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseGameCatalog } from "./gameSources";

const ORIGIN = "https://lyra.example";
const OWN = {
  id: "bolsa-trading-floor",
  name: "Bolsa — Trading Floor",
  author: "lyra",
  gameUrl: "/owngames/bolsa-trading-floor/",
  coverUrl: "/owngames/bolsa-trading-floor/cover.svg",
};

// parseOwnGames lee el origen de window.location, asi que el stub va ahi.
const realWindow = (globalThis as Record<string, unknown>).window;

beforeAll(() => {
  (globalThis as Record<string, unknown>).window = {
    location: { origin: ORIGIN },
  };
});

afterAll(() => {
  (globalThis as Record<string, unknown>).window = realWindow;
});

// the games lyra serves live under /owngames, which is the app's own origin.
// routing them through the proxy made folio abort every request they made, with
// "attempted to fetch from same origin": parseOwnGames defaulted isExternal to
// true (game.external !== false) and the server never sends that field.
describe("owngames catalog routing", () => {
  test("a same-origin owngames entry is not routed through the proxy", () => {
    const games = parseGameCatalog("owngames", [OWN]);
    expect(games).toHaveLength(1);
    expect(games[0]?.gameUrl).toBe(`${ORIGIN}/owngames/bolsa-trading-floor/`);
    expect(games[0]?.isExternal).toBe(false);
  });

  test("an owngames entry hosted elsewhere still goes through the proxy", () => {
    const games = parseGameCatalog("owngames", [
      { ...OWN, gameUrl: "https://otro-sitio.example/juego/" },
    ]);
    expect(games[0]?.isExternal).toBe(true);
  });

  test("the payload cannot force a same-origin game back into the proxy", () => {
    // the origin decides, not the payload: the proxy is exactly what breaks on
    // a same-origin request
    const games = parseGameCatalog("owngames", [{ ...OWN, external: true }]);
    expect(games[0]?.isExternal).toBe(false);
  });
});