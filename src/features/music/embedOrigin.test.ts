import { describe, expect, test } from "bun:test";
import {
  isEndOfStreamMessage,
  isTrustedEmbedOrigin,
} from "./embedOrigin";

// el chequeo era origin.includes("youtube"), que no valida un dominio: busca una
// subcadena. el embed real es www.youtube-nocookie.com, asi que pasaba por
// coincidencia de nombre — y tambien pasaban los origenes de un atacante.
describe("origen del embed", () => {
  test("acepta el embed que se carga de verdad", () => {
    // es el que devuelve youTubeEmbedUrl; si este falla, la cola nunca avanza
    expect(isTrustedEmbedOrigin("https://www.youtube-nocookie.com")).toBe(true);
    // los otros valen porque un embed puede redirigir de nocookie a www y el
    // que avisa del fin seria el segundo: si no se aceptaran, algunas pistas
    // nunca avanzarian solas
    expect(isTrustedEmbedOrigin("https://youtube.com")).toBe(true);
    expect(isTrustedEmbedOrigin("https://www.youtube.com")).toBe(true);
    expect(isTrustedEmbedOrigin("https://m.youtube.com")).toBe(true);
  });

  test("rechaza un dominio que solo contiene la palabra", () => {
    // los cuatro pasaban con includes()
    expect(isTrustedEmbedOrigin("https://youtube.com.evil.example")).toBe(false);
    expect(isTrustedEmbedOrigin("https://notyoutube.com")).toBe(false);
    expect(isTrustedEmbedOrigin("https://youtube.com.attacker.io")).toBe(false);
    expect(isTrustedEmbedOrigin("https://my-youtube-mirror.example")).toBe(false);
    // ni un subdominio inventado que contenga el dominio bueno
    expect(isTrustedEmbedOrigin("https://youtube-nocookie.com.evil.example")).toBe(
      false,
    );
  });

  test("rechaza lo que no es un origen de youtube", () => {
    expect(isTrustedEmbedOrigin("https://open.spotify.com")).toBe(false);
    expect(isTrustedEmbedOrigin("null")).toBe(false);
    expect(isTrustedEmbedOrigin("")).toBe(false);
    expect(isTrustedEmbedOrigin(undefined)).toBe(false);
    expect(isTrustedEmbedOrigin(null)).toBe(false);
    expect(isTrustedEmbedOrigin(42)).toBe(false);
  });

  test("rechaza un origen malformado en vez de lanzar", () => {
    expect(isTrustedEmbedOrigin("no-es-una-url")).toBe(false);
    expect(isTrustedEmbedOrigin("://")).toBe(false);
  });

  test("decide por el host, no por el esquema", () => {
    // el embed siempre es https, asi que el esquema no es una discriminante
    // util: lo que identifica al emisor es el host. file://youtube.com tiene
    // el host de youtube, asi que se acepta — y no es un agujero: ningun iframe
    // puede servirse por file://
    expect(isTrustedEmbedOrigin("file://youtube.com")).toBe(true);
    expect(isTrustedEmbedOrigin("http://youtube.com")).toBe(true);
    expect(isTrustedEmbedOrigin("https://youtube.com:8443")).toBe(true);
  });
});

describe("fin de stream del embed", () => {
  test("la forma vieja de la widget api", () => {
    expect(isEndOfStreamMessage({ event: "onStateChange", info: 0 })).toBe(true);
  });

  test("la entrega periodica de estado", () => {
    expect(
      isEndOfStreamMessage({ event: "infoDelivery", info: { playerState: 0 } }),
    ).toBe(true);
  });

  test("los demas estados no son fin de stream", () => {
    // 1 = reproduciendo, 2 = pausado, 3 = cargando. con cualquiera de estos se
    // advanced la cola y se saltaria la cancion que esta sonando
    expect(isEndOfStreamMessage({ event: "onStateChange", info: 1 })).toBe(false);
    expect(isEndOfStreamMessage({ event: "onStateChange", info: 2 })).toBe(false);
    expect(isEndOfStreamMessage({ event: "onStateChange", info: 3 })).toBe(false);
    expect(
      isEndOfStreamMessage({ event: "infoDelivery", info: { playerState: 1 } }),
    ).toBe(false);
  });

  test("un payload que no es de la widget no avanza la cola", () => {
    expect(isEndOfStreamMessage(null)).toBe(false);
    expect(isEndOfStreamMessage(undefined)).toBe(false);
    expect(isEndOfStreamMessage("onStateChange")).toBe(false);
    expect(isEndOfStreamMessage(0)).toBe(false);
    expect(isEndOfStreamMessage({})).toBe(false);
    expect(isEndOfStreamMessage({ event: "otro", info: 0 })).toBe(false);
    // infoDelivery sin objeto: antes crasheaba al leer .playerState de un numero
    expect(isEndOfStreamMessage({ event: "infoDelivery", info: 0 })).toBe(false);
    expect(isEndOfStreamMessage({ event: "infoDelivery" })).toBe(false);
  });
});