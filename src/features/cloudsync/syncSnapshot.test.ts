import { describe, expect, test } from "bun:test";
import {
  heaviestSyncDatabases,
  isSensitiveSyncName,
  isSensitiveSyncText,
} from "./syncSnapshot.ts";

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

// El diagnostico antes ordenaba por NUMERO de registros, y eso no dice que base
// infla la instantanea: una con dos blobs puede pesar mas que otra con miles de
// enteros. Estos tests fijan que el ranking va por bytes, que es lo que permite
// decidir cual recortar.
describe("heaviestSyncDatabases", () => {
  const database = (records: unknown[]) => ({ stores: { store: { records } } });
  const record = (value: unknown) => ({ key: { type: "number", value: 1 }, value });
  type IndexedDB = Parameters<typeof heaviestSyncDatabases>[0];

  test("una base con un blob grande gana a otra con muchos enteros", () => {
    const manyTiny = Array.from({ length: 50 }, () =>
      record({ type: "number", value: 3 }),
    );
    const oneBig = [
      record({
        type: "blob",
        id: 2,
        value: { mediaType: "image/png", bytes: "A".repeat(4096) },
      }),
    ];
    const heaviest = heaviestSyncDatabases({
      manyTiny: database(manyTiny),
      oneBig: database(oneBig),
    } as unknown as IndexedDB);

    expect(heaviest).toHaveLength(2);
    expect(heaviest[0]![0]).toBe("oneBig");
    expect(heaviest[0]![1]).toBeGreaterThan(4096);
    expect(heaviest[1]![0]).toBe("manyTiny");
  });

  test("respeta el limite y una base vacia pesa cero", () => {
    const heaviest = heaviestSyncDatabases(
      { empty: database([]) } as unknown as IndexedDB,
      1,
    );
    expect(heaviest).toEqual([["empty", 0]]);
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
