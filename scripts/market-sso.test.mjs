// SSO market <-> cloudsync: el mercado acepta el JWT HS256 que firma cloudsync.
//
// cloudsync (Rust) guarda las cuentas y firma un JWT en la cookie `token`. Estos
// tests reproducen ese token (misma forma y algoritmo que services/cloudsync/
// src/auth.rs) y comprueban que el mercado autentica con él sin haber iniciado
// sesión de mercado, además de los casos que deben rechazarse.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMarketServer } from "../services/market/server.mjs";
import { createAccountStore } from "../services/market/accounts.mjs";
import { resolveSsoAccount, verifySessionToken } from "../services/market/sso.mjs";

const SECRET = "s".repeat(64);

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}

// firma un JWT igual que cloudsync: HS256 sobre `header.payload`
function signJwt(payload, secret = SECRET) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64url(signature)}`;
}

function freshClaims(overrides = {}) {
  return {
    id: 7,
    username: "jugador",
    v: 1,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

describe("verifySessionToken", () => {
  test("acepta un JWT de cloudsync válido y devuelve sus claims", () => {
    const claims = verifySessionToken(signJwt(freshClaims()), SECRET);
    expect(claims).toEqual({ username: "jugador", id: 7, version: 1 });
  });

  test("rechaza una firma con otro secreto", () => {
    const token = signJwt(freshClaims(), "otro-secreto");
    expect(verifySessionToken(token, SECRET)).toBeNull();
  });

  test("rechaza un payload manipulado", () => {
    const token = signJwt(freshClaims());
    const [header, , signature] = token.split(".");
    const forged = `${header}.${b64url(JSON.stringify(freshClaims({ username: "admin", v: 9 })))}.${signature}`;
    expect(verifySessionToken(forged, SECRET)).toBeNull();
  });

  test("rechaza alg:none aunque el tercer tramo esté vacío o inventado", () => {
    const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
    const body = b64url(JSON.stringify(freshClaims()));
    expect(verifySessionToken(`${header}.${body}.`, SECRET)).toBeNull();
    expect(verifySessionToken(`${header}.${body}.xxxx`, SECRET)).toBeNull();
  });

  test("rechaza un token caducado", () => {
    const token = signJwt(freshClaims({ exp: Math.floor(Date.now() / 1000) - 10 }));
    expect(verifySessionToken(token, SECRET)).toBeNull();
  });

  test("rechaza nombres con forma imposible (espacios, símbolos, vacío)", () => {
    for (const username of ["", "con espacio", "a", "x".repeat(21), "a.b", "a-b"]) {
      expect(verifySessionToken(signJwt(freshClaims({ username })), SECRET)).toBeNull();
    }
  });

  test("sin secreto, basura o trozos de menos: null, nunca lanza", () => {
    const good = signJwt(freshClaims());
    expect(verifySessionToken(good, "")).toBeNull();
    expect(verifySessionToken("no-es-un-jwt", SECRET)).toBeNull();
    expect(verifySessionToken("a.b", SECRET)).toBeNull();
    expect(verifySessionToken(null, SECRET)).toBeNull();
  });
});

describe("resolveSsoAccount", () => {
  test("provisiona una cuenta sin contraseña local y la reutiliza", () => {
    const store = createAccountStore();
    const first = resolveSsoAccount(store, "jugador");
    expect(first.created).toBe(true);
    expect(first.account.name).toBe("jugador");
    expect(first.account.hash).toBe("");
    expect(first.account.portfolio.cash).toBe(10000);

    const second = resolveSsoAccount(store, "JUGADOR"); // el key es insensible
    expect(second.created).toBe(false);
    expect(second.account).toBe(first.account);
    expect(Object.keys(store.accounts)).toHaveLength(1);
  });

  test("un nombre inválido no crea nada", () => {
    const store = createAccountStore();
    expect(resolveSsoAccount(store, "con espacio")).toBeNull();
    expect(Object.keys(store.accounts)).toHaveLength(0);
  });
});

describe("el mercado autentica con la sesión de cloudsync", () => {
  let instance = null;
  let baseUrl = "";
  let dir = "";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-sso-"));
    instance = createMarketServer({
      port: 0,
      dataDir: dir,
      autoTick: false,
      adminNames: "",
      ssoSecret: SECRET,
    });
    baseUrl = `http://127.0.0.1:${instance.port}`;
  });

  afterAll(() => {
    instance?.stop?.();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("la cookie `token` de cloudsync da sesión de mercado (y provisiona la cuenta)", async () => {
    const jwt = signJwt(freshClaims({ username: "nube_jugador" }));
    const response = await fetch(`${baseUrl}/api/market/me`, {
      headers: { cookie: `token=${jwt}` },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.account.name).toBe("nube_jugador");
    // la cuenta nace con la cartera por defecto del juego
    expect(body.account.portfolio.cash).toBe(10000);
  });

  test("un JWT con otro secreto no autentica", async () => {
    const jwt = signJwt(freshClaims({ username: "intruso" }), "secreto-falso");
    const response = await fetch(`${baseUrl}/api/market/me`, {
      headers: { cookie: `token=${jwt}` },
    });
    expect(response.status).toBe(401);
  });

  test("sin cookie de sesión sigue siendo 401 (invitado)", async () => {
    const response = await fetch(`${baseUrl}/api/market/me`);
    expect(response.status).toBe(401);
  });

  test("el SSO no pisa un token de mercado válido", async () => {
    // una cuenta y sesión propias del mercado siguen ganando
    const registered = await fetch(`${baseUrl}/api/market/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "local_jugador", password: "contrasena-larga-1" }),
    }).then((r) => r.json());
    const jwt = signJwt(freshClaims({ username: "otro_de_la_nube" }));
    const response = await fetch(`${baseUrl}/api/market/me`, {
      headers: {
        Authorization: `Bearer ${registered.token}`,
        cookie: `token=${jwt}`,
      },
    });
    const body = await response.json();
    expect(body.account.name).toBe("local_jugador");
  });
});

describe("el SSO está apagado sin JWT_SECRET", () => {
  let instance = null;
  let baseUrl = "";
  let dir = "";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-sso-off-"));
    instance = createMarketServer({
      port: 0,
      dataDir: dir,
      autoTick: false,
      adminNames: "",
      ssoSecret: "",
    });
    baseUrl = `http://127.0.0.1:${instance.port}`;
  });

  afterAll(() => {
    instance?.stop?.();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("la cookie de cloudsync no autentica si no hay secreto configurado", async () => {
    const jwt = signJwt(freshClaims());
    const response = await fetch(`${baseUrl}/api/market/me`, {
      headers: { cookie: `token=${jwt}` },
    });
    expect(response.status).toBe(401);
  });
});
