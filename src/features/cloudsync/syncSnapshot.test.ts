import { describe, expect, test } from "bun:test";
import { isSensitiveSyncName, isSensitiveSyncText } from "./syncSnapshot.ts";

// El servidor tumba la subida entera con un 400 si encuentra credenciales que
// el cliente no filtro. Estos tests fijan las reglas que MAS se desincronizaban:
// el cliente exigia un `:` o `=` detras de la clave entrecomillada, y el
// servidor no, asi que un valor como `["password","secret"]` (sin `:`) pasaba
// el filtro del cliente y el servidor lo rechazaba.
describe("isSensitiveSyncText", () => {
  test("claves entrecomilladas sin dos puntos se detectan igual que en el servidor", () => {
    expect(isSensitiveSyncText('["password","secret"]')).toBe(true);
    expect(isSensitiveSyncText('{"fields":["credential"]}')).toBe(true);
    expect(isSensitiveSyncText('["access_token"]')).toBe(true);
  });

  test("las claves con dos puntos siguen detectandose", () => {
    expect(isSensitiveSyncText('{"password":"hunter2"}')).toBe(true);
    expect(isSensitiveSyncText("{'api_key':'abc12345'}")).toBe(true);
  });

  test("un jwt se detecta por su forma", () => {
    expect(
      isSensitiveSyncText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh"),
    ).toBe(true);
  });

  test("texto normal no es sensible", () => {
    expect(isSensitiveSyncText("hello world")).toBe(false);
    expect(isSensitiveSyncText('{"note":"hola"}')).toBe(false);
    expect(isSensitiveSyncText('["manzana","pera"]')).toBe(false);
  });
});

describe("isSensitiveSyncName", () => {
  test("los nombres de token/credencial son sensibles", () => {
    expect(isSensitiveSyncName("auth_token")).toBe(true);
    expect(isSensitiveSyncName("user_password")).toBe(true);
    expect(isSensitiveSyncName("session")).toBe(true);
  });

  test("nombres normales no lo son", () => {
    expect(isSensitiveSyncName("score")).toBe(false);
    expect(isSensitiveSyncName("settings")).toBe(false);
  });
});
