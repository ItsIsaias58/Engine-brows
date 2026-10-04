// Tests de la extraccion del token en el handshake del WebSocket del mercado.
//
// El upgrade SIEMPRE pasa (los invitados pueden ver el mercado sin sesion), asi
// que el unico modo de comprobar que el token llego bien desde el handshake es
// mirar la extraccion directamente. Antes el token viajaba en la query del
// WebSocket, que prod.mjs escribe en el access log junto con el resto de la
// query string: la sesion acababa escrita en disco.
import { describe, expect, test } from "bun:test";
import { socketToken } from "../services/market/server.mjs";

const URL_PLAIN = new URL("http://127.0.0.1:4006/ws/market");

function req(headers = {}) {
  const map = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    headers: {
      get: (name) => (map.has(name.toLowerCase()) ? map.get(name.toLowerCase()) : null),
    },
  };
}

describe("socketToken", () => {
  test("sin nada devuelve cadena vacia (invitado)", () => {
    expect(socketToken(req(), URL_PLAIN)).toBe("");
  });

  test("lee la cabecera Authorization", () => {
    expect(socketToken(req({ authorization: "Bearer abc123" }), URL_PLAIN)).toBe("abc123");
  });

  test("la cabecera gana a la cookie", () => {
    const request = req({
      authorization: "Bearer de-cabecera",
      cookie: "lyra_market_token=de-cookie",
    });
    expect(socketToken(request, URL_PLAIN)).toBe("de-cabecera");
  });

  test("acepta el esquema Bearer sin distinguir mayusculas", () => {
    expect(socketToken(req({ authorization: "bearer abc" }), URL_PLAIN)).toBe("abc");
  });

  // este es el camino que usan los dos juegos desde el cambio
  test("lee la cookie lyra_market_token", () => {
    const request = req({ cookie: "otra=1; lyra_market_token=abc123; mas=2" });
    expect(socketToken(request, URL_PLAIN)).toBe("abc123");
  });

  test("la cookie gana a la query", () => {
    const url = new URL("http://127.0.0.1:4006/ws/market?token=de-query");
    const request = req({ cookie: "lyra_market_token=de-cookie" });
    expect(socketToken(request, url)).toBe("de-cookie");
  });

  test("la cookie se des-codifica (el token va percent-encoded)", () => {
    const token = "tok/with+special=chars";
    const request = req({
      cookie: `lyra_market_token=${encodeURIComponent(token)}`,
    });
    expect(socketToken(request, URL_PLAIN)).toBe(token);
  });

  test("ignora otras cookies con nombres parecidos", () => {
    const request = req({ cookie: "lyra_market_token_otro=xxx; otro=abc" });
    expect(socketToken(request, URL_PLAIN)).toBe("");
  });

  test("una cookie sin '=' no rompe", () => {
    expect(socketToken(req({ cookie: "basura" }), URL_PLAIN)).toBe("");
  });

  test("la query sigue funcionando (clientes antiguos y sondas)", () => {
    const url = new URL("http://127.0.0.1:4006/ws/market?token=abc123");
    expect(socketToken(req(), url)).toBe("abc123");
  });

  test("cabecera > cookie > query, en ese orden", () => {
    const url = new URL("http://127.0.0.1:4006/ws/market?token=3-query");
    const request = req({
      authorization: "Bearer 1-cabecera",
      cookie: "lyra_market_token=2-cookie",
    });
    expect(socketToken(request, url)).toBe("1-cabecera");
    expect(socketToken(req({ cookie: "lyra_market_token=2-cookie" }), url)).toBe(
      "2-cookie",
    );
  });

  test("una cabecera Authorization vacia cae a la cookie", () => {
    const request = req({ authorization: "", cookie: "lyra_market_token=abc" });
    expect(socketToken(request, URL_PLAIN)).toBe("abc");
  });
});
