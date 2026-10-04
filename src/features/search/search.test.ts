import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const ORIGIN = "https://lyra.example";
const realWindow = (globalThis as Record<string, unknown>).window;
const realLyra = (globalThis as Record<string, unknown>).Lyra;

beforeAll(() => {
  (globalThis as Record<string, unknown>).window = {
    location: { origin: ORIGIN },
    Lyra: { tabs: [], isLoading: false },
  };
});

afterAll(() => {
  (globalThis as Record<string, unknown>).window = realWindow;
  (globalThis as Record<string, unknown>).Lyra = realLyra;
});

const { getInternalRouteUrl: getInternalRouteUrlForTest } = await import(
  "./internalRoutes"
);

// the games lyra serves must not be proxied. folio aborts a same-origin fetch
// outright ("attempted to fetch from same origin"), and mochi would rewrite the
// page's relative urls against /!!/, breaking every asset it loads.
describe("internal routes bypass the proxy", () => {
  test("an owngames url is an internal route", () => {
    expect(
      getInternalRouteUrlForTest("/owngames/bolsa-trading-floor/", ORIGIN),
    ).toBe(`${ORIGIN}/owngames/bolsa-trading-floor/`);
    expect(getInternalRouteUrlForTest("/owngames/csgo-opencase/", ORIGIN)).toBe(
      `${ORIGIN}/owngames/csgo-opencase/`,
    );
    expect(getInternalRouteUrlForTest("/owngames", ORIGIN)).toBe(
      `${ORIGIN}/owngames`,
    );
  });

  test("the anime stream stays an internal route", () => {
    expect(getInternalRouteUrlForTest("/stream/anime/1", ORIGIN)).toBe(
      `${ORIGIN}/stream/anime/1`,
    );
  });

  test("an external game is NOT an internal route", () => {
    expect(
      getInternalRouteUrlForTest("https://selenite.example/juego/", ORIGIN),
    ).toBeNull();
    expect(getInternalRouteUrlForTest("/f/https://otro.example/", ORIGIN)).toBeNull();
    expect(getInternalRouteUrlForTest("/assets/app.js", ORIGIN)).toBeNull();
    expect(getInternalRouteUrlForTest("/api/market/state", ORIGIN)).toBeNull();
  });

  test("another origin is never internal, even with our path", () => {
    expect(
      getInternalRouteUrlForTest("https://otro.example/owngames/", ORIGIN),
    ).toBeNull();
  });
});