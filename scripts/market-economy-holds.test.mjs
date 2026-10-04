// Tests de integridad de la economia.
//
// Estos son exploits reales, no hipoteticos: arrancan el servicio de mercado de
// verdad y hacen lo que haria un jugador con el devtools abierto.
//
// ANTES DE ESTOS TESTS (y por eso existen): el autoguardado (PUT
// /api/market/me) era una puerta trasera a la economia entera, porque el
// cliente es quien calculaba la bolsa. Se comprobo ejecutandolo contra el
// servicio real: una cuenta con 10.000 de cash paso a 999.999.999 con un
// unico PUT, y el ranking acepto best=9e11, streak=500 y trades=9999 sin
// pestanear. Tambien se cuelaba una posicion de un simbolo inexistente, una
// orden en espera con day antiguo y margen enorme (que se "vencia" en el
// siguiente tick devolviendo ese margen al efectivo) y un libro de opencase
// vaciado con un array en el lugar equivocado.
//
// ARREGLO: services/market/ledger.mjs. El navegador sigue calculando igual
// (para que el clic se sienta inmediato) pero manda el REGISTRO de operaciones,
// y el servidor las reproduce sobre su propia cartera y su propia cinta. El
// precio lo pone el servidor, nunca el cliente. El autoguardado ya no mueve ni
// un peso: cash, posiciones, historial, estadisticas, ordenes y la bandera de
// bancarrota salen de la cartera viva del servidor (applyServerOwned en
// accounts.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createMarketServer } from "../services/market/server.mjs";
import { BANKRUPT_WAIT_MS, RECAP_CASH, replayOps, runRiskPass } from "../services/market/ledger.mjs";
import { CASES } from "../services/market/cases.mjs";

describe("el autoguardado no puede forjar la economia", () => {
  let instance = null;
  let baseUrl = "";
  let dir = "";
  let auth = {};

  const me = async () => {
    const response = await fetch(`${baseUrl}/api/market/me`, { headers: auth });
    const body = await response.json();
    return body.account;
  };

  const save = async (portfolio, ops = []) => {
    const response = await fetch(`${baseUrl}/api/market/me`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ portfolio, ops }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-economy-"));
    instance = createMarketServer({ port: 0, dataDir: dir, autoTick: false, adminNames: "" });
    baseUrl = `http://127.0.0.1:${instance.port}`;
    const registered = await fetch(`${baseUrl}/api/market/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "atacante", password: "contrasena-larga-123" }),
    }).then((r) => r.json());
    auth = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${registered.token}`,
    };
  });

  afterAll(() => {
    instance?.stop?.();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  // este es el bug original, tal cual
  test("un PUT con cash gigante no lo cuela", async () => {
    const before = await me();
    const result = await save({ cash: 999_999_999 });
    expect(result.status).toBe(200);
    const after = await me();
    expect(after.portfolio.cash).toBe(before.portfolio.cash);
  });

  test("tampoco con notacion cientifica ni string", async () => {
    const before = await me();
    await save({ cash: 1e15 });
    await save({ cash: "999999999" });
    await save({ cash: Number.MAX_SAFE_INTEGER });
    const after = await me();
    expect(after.portfolio.cash).toBe(before.portfolio.cash);
  });

  test("el cash nunca baja de cero por PUT", async () => {
    const before = await me();
    await save({ cash: -5_000_000 });
    const after = await me();
    expect(after.portfolio.cash).toBe(before.portfolio.cash);
  });

  test("no se pueden inventar posiciones de un simbolo inexistente", async () => {
    const before = await me();
    await save({ positions: { NOEXISTE: { shares: 1e12, avgPrice: 1, leverage: 1000 } } });
    const after = await me();
    expect(Object.keys(after.portfolio.positions)).toEqual(
      Object.keys(before.portfolio.positions),
    );
  });

  test("tampoco posiciones de un simbolo real, sin haber comprado", async () => {
    const before = await me();
    await save({ positions: { SOLMK: { shares: 1e9, avgPrice: 0.01, leverage: 20, margin: 0 } } });
    const after = await me();
    expect(after.portfolio.positions).toEqual(before.portfolio.positions);
  });

  test("no se pueden forjar las estadisticas del ranking", async () => {
    const before = await me();
    await save({
      stats: {
        wins: 9999,
        losses: 0,
        totalTrades: 9999,
        grossProfit: 9e11,
        grossLoss: 0,
        bestTrade: 9e11,
        currentStreak: 500,
        bestStreak: 500,
        peakNet: 9e11,
        timesBankrupt: 42,
      },
    });
    const after = await me();
    expect(after.portfolio.stats.wins).toBe(before.portfolio.stats.wins);
    expect(after.portfolio.stats.totalTrades).toBe(before.portfolio.stats.totalTrades);
    expect(after.portfolio.stats.grossProfit).toBe(before.portfolio.stats.grossProfit);
    expect(after.portfolio.stats.bestTrade).toBe(before.portfolio.stats.bestTrade);
    expect(after.portfolio.stats.peakNet).toBe(before.portfolio.stats.peakNet);
    expect(after.portfolio.stats.timesBankrupt).toBe(before.portfolio.stats.timesBankrupt);
  });

  test("el ranking no refleja estadisticas forjadas", async () => {
    const board = await fetch(
      `${baseUrl}/api/market/leaderboard?metric=net&period=all&limit=50`,
    ).then((r) => r.json());
    const entry = board.entries?.find((row) => row.name === "atacante");
    if (entry) {
      expect(entry.trades).toBe(0);
      expect(entry.streak).toBe(0);
      expect(entry.best).toBe(0);
    }
  });

  test("no se puede inventar historial de operaciones", async () => {
    const before = await me();
    await save({
      transactions: Array.from({ length: 50 }, () => ({
        sym: "SOLMK",
        type: "Compra",
        shares: 1e9,
        price: 1,
        time: "00:00",
      })),
    });
    const after = await me();
    expect(after.portfolio.transactions).toEqual(before.portfolio.transactions);
  });

  // esta no la hadiamos visto: una orden en espera con day antiguo y margen
  // enorme se "vencia" en el siguiente tick (processOrders la devuelve al
  // efectivo sin comprobar nada) y acuñaba el dinero de un plumazo
  test("no se pueden colar ordenes en espera con margen inventado", async () => {
    const before = await me();
    await save({
      orders: [
        {
          id: "ofalsa",
          sym: "SOLMK",
          side: "buy",
          kind: "limit",
          shares: 1e9,
          price: 1,
          leverage: 20,
          margin: 1e9,
          placedAt: Date.now() - 86_400_000,
          day: 0,
        },
      ],
    });
    const after = await me();
    expect(after.portfolio.orders).toEqual(before.portfolio.orders);
    expect(after.portfolio.cash).toBe(before.portfolio.cash);
  });

  // el libro de opencase es un objeto con inventario. un array en su lugar
  // (los cosméticos de la bolsa) lo vaciaba entero
  test("un array en skins no borra el inventario de opencase", async () => {
    // primero hay un libro de verdad: se abre una caja de opencase
    const opened = await fetch(`${baseUrl}/api/market/skins`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ action: "open", caseId: "barrio" }),
    });
    expect(opened.status).toBe(200);
    const before = await me();
    expect(before.portfolio.skins.inventory.length).toBeGreaterThan(0);

    // ahora el autoguardado de la bolsa manda un array en su lugar (los
    // cosméticos de la bolsa), que antes vaciaba el inventario entero
    const result = await fetch(`${baseUrl}/api/market/me`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ skins: ["neon"] }),
    });
    expect(result.status).toBe(200);
    const after = await me();
    expect(after.portfolio.skins).toEqual(before.portfolio.skins);
  });

  // lo que el cliente es dueño (progresión, lista, misiones) sí se guarda: el
  // arreglo no es "ignorar el autoguardado", es "que el dinero no venga de él".
  //
  // NIVEL Y XP SIGUEN SIENDO DEL CLIENTE, y es a propósito: no los lee nada
  // económico (el techo del préstamo es nivel-independiente desde bank.mjs) ni
  // el ranking — leaderboard.mjs sólo los pinta. Su único premio es un título y
  // dos logros, y la XP tiene una parte que el servidor no puede reproducir: el
  // barrido de logros (ACHIEVEMENT_XP en js/achievements.js) corre en el
  // navegador. Moverlos al servidor sería perder esa XP, que es un retroceso
  // real, a cambio de tapar un cosmético. Este test deja la frontera escrita.
  test("el guardado de los campos del cliente sigue funcionando", async () => {
    const before = await me();
    const result = await save({
      level: before.portfolio.level + 2,
      xp: 1234,
      watchlist: ["SOLMK", "AAPL"],
      quests: { firstBuy: true, diversify: true },
    });
    expect(result.status).toBe(200);
    const after = await me();
    expect(after.portfolio.level).toBe(before.portfolio.level + 2);
    expect(after.portfolio.xp).toBe(1234);
    expect(after.portfolio.watchlist).toEqual(["SOLMK", "AAPL"]);
    expect(after.portfolio.quests).toEqual({ firstBuy: true, diversify: true });
  });

  test("el guardado con campos que no son del cliente no rompe la cuenta", async () => {
    const result = await save({ quests: { diversify: 1 }, watchlist: [null, 42] });
    expect(result.status).toBe(200);
    const after = await me();
    expect(after.portfolio.quests.diversify).toBe(false);
  });
});

describe("el registro de operaciones es el unico camino del dinero", () => {
  let instance = null;
  let baseUrl = "";
  let dir = "";
  let auth = {};

  const me = async () => {
    const body = await fetch(`${baseUrl}/api/market/me`, { headers: auth }).then((r) => r.json());
    return body.account;
  };

  const ops = async (list) => {
    const response = await fetch(`${baseUrl}/api/market/me`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ ops: list }),
    });
    return response.json();
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-ledger-"));
    instance = createMarketServer({ port: 0, dataDir: dir, autoTick: false, adminNames: "" });
    baseUrl = `http://127.0.0.1:${instance.port}`;
    const registered = await fetch(`${baseUrl}/api/market/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "operador", password: "contrasena-larga-123" }),
    }).then((r) => r.json());
    auth = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${registered.token}`,
    };
  });

  afterAll(() => {
    instance?.stop?.();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("una compra se cobra al precio de la cinta del servidor, no al que digas", async () => {
    const before = await me();
    const quote = instance.market.symbols.find((s) => s.sym === "SOLMK");
    const result = await ops([{ kind: "buy", sym: "SOLMK", shares: 4, leverage: 2 }]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].price).toBeGreaterThan(0);
    const after = await me();
    // el margen sale del efectivo, y el precio es el de la cinta
    expect(after.portfolio.cash).toBeCloseTo(
      before.portfolio.cash - (4 * result.applied[0].price) / 2,
      6,
    );
    expect(after.portfolio.positions.SOLMK.shares).toBe(4);
    expect(after.portfolio.positions.SOLMK.avgPrice).toBeCloseTo(result.applied[0].price, 6);
    // el precio del cliente ni se mira: la operación no lleva campo de precio
    expect(quote).toBeTruthy();
  });

  test("el apalancamiento está acotado al mismo techo que las órdenes en espera", async () => {
    const result = await ops([{ kind: "buy", sym: "SOLMK", shares: 1, leverage: 5000 }]);
    expect(result.applied).toHaveLength(1);
    const after = await me();
    expect(after.portfolio.positions.SOLMK.leverage).toBeLessThanOrEqual(20);
  });

  test("comprar sin efectivo suficiente se rechaza y no se cobra nada", async () => {
    const before = await me();
    const result = await ops([{ kind: "buy", sym: "SOLMK", shares: 1e9, leverage: 1 }]);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected[0].error).toMatch(/insuficientes/);
    const after = await me();
    expect(after.portfolio.cash).toBe(before.portfolio.cash);
  });

  test("vender acciones que no se tienen se rechaza", async () => {
    const result = await ops([{ kind: "sell", sym: "SOLMK", shares: 1e9 }]);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected[0].error).toMatch(/insuficientes/);
  });

  test("un símbolo inexistente se rechaza sin tocar la cartera", async () => {
    const before = await me();
    const result = await ops([{ kind: "buy", sym: "NOEXISTE", shares: 10, leverage: 1 }]);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected[0].error).toMatch(/símbolo/);
    expect((await me()).portfolio.cash).toBe(before.portfolio.cash);
  });

  test("el servidor no acepta un precio en la operación", async () => {
    // aunque el cliente lo mande, el precio lo pone la cinta
    const before = await me();
    const result = await ops([
      { kind: "buy", sym: "SOLMK", shares: 1, leverage: 1, price: 0.000001 },
    ]);
    const quote = instance.market.symbols.find((s) => s.sym === "SOLMK");
    expect(result.applied[0].price).toBeGreaterThan(quote.price / 1000);
    const after = await me();
    expect(after.portfolio.positions.SOLMK.avgPrice).toBeCloseTo(result.applied[0].price, 6);
    expect(after.portfolio.cash).toBeLessThan(before.portfolio.cash);
  });

  test("una venta realizable suma el efectivo y cuenta la operación", async () => {
    await ops([{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1 }]);
    const before = await me();
    const held = before.portfolio.positions.SOLMK.shares;
    const result = await ops([{ kind: "sell", sym: "SOLMK", shares: 4 }]);
    expect(result.applied).toHaveLength(1);
    const after = await me();
    expect(after.portfolio.cash).toBeGreaterThan(before.portfolio.cash);
    expect(after.portfolio.positions.SOLMK.shares).toBeCloseTo(held - 4, 6);
    // el servidor también lleva el ranking: una venta cerrada suma una operación
    expect(after.portfolio.stats.totalTrades).toBe(before.portfolio.stats.totalTrades + 1);
    expect(after.portfolio.stats.wins + after.portfolio.stats.losses).toBe(
      after.portfolio.stats.totalTrades,
    );
  });

  test("un registro desbordado se rechaza entero, sin aplicar una parte", async () => {
    const before = await me();
    const flood = Array.from({ length: 501 }, () => ({ kind: "buy", sym: "SOLMK", shares: 1, leverage: 1 }));
    const response = await fetch(`${baseUrl}/api/market/me`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ ops: flood }),
    });
    expect(response.status).toBe(400);
    expect((await me()).portfolio.cash).toBe(before.portfolio.cash);
  });
});

describe("la ruleta de cajas no se puedeiablear desde el navegador", () => {
  let instance = null;
  let baseUrl = "";
  let dir = "";
  let auth = {};

  const me = async () => {
    const body = await fetch(`${baseUrl}/api/market/me`, { headers: auth }).then((r) => r.json());
    return body.account;
  };

  const plant = (portfolio) => {
    const account = instance.accounts.accounts.operador;
    account.portfolio = { ...account.portfolio, ...portfolio };
    instance.persistAccounts();
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-cases-"));
    instance = createMarketServer({ port: 0, dataDir: dir, autoTick: false, adminNames: "" });
    baseUrl = `http://127.0.0.1:${instance.port}`;
    const registered = await fetch(`${baseUrl}/api/market/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "operador", password: "contrasena-larga-123" }),
    }).then((r) => r.json());
    auth = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${registered.token}`,
    };
  });

  afterAll(() => {
    instance?.stop?.();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("abrir una caja cobra el precio exacto y el premio viene del servidor", async () => {
    plant({ cash: 1_000_000, positions: {} });
    const before = await me();
    const response = await fetch(`${baseUrl}/api/market/cases/open`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "barrio" }),
    });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.ok).toBe(true);
    expect(["cash", "xp", "shares", "boost"]).toContain(data.reward.kind);
    const after = await me();
    const delta = before.portfolio.cash - after.portfolio.cash;
    // el coste menos el premio en efectivo, si el premio fue dinero
    const cashPrize = data.reward.kind === "cash" ? data.reward.amount : 0;
    expect(delta).toBeCloseTo(CASES.barrio.cost - cashPrize, 6);
  });

  test("no se puede abrir una caja sin efectivo para el precio", async () => {
    plant({ cash: 10, positions: {} });
    const response = await fetch(`${baseUrl}/api/market/cases/open`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "tiburon" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/efectivo/);
  });

  test("no se puede abrir una caja inventada con coste cero", async () => {
    plant({ cash: 1_000, positions: {} });
    const before = await me();
    const response = await fetch(`${baseUrl}/api/market/cases/open`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ id: "caja-inexistente" }),
    });
    expect(response.status).toBe(400);
    expect((await me()).portfolio.cash).toBe(before.portfolio.cash);
  });

  test("el catálogo de cajas es público y trae los precios", async () => {
    // sin sesión: el panel de invitado también lo consulta
    const catalog = await fetch(`${baseUrl}/api/market/cases`).then((r) => r.json());
    expect(catalog.cases.map((c) => c.id)).toEqual(Object.keys(CASES));
    expect(catalog.cases.every((c) => c.cost === CASES[c.id].cost)).toBe(true);
  });
});

describe("la bancarrota la aplica el servidor, no el autoguardado", () => {
  let instance = null;
  let baseUrl = "";
  let dir = "";
  let auth = {};

  const me = async () => {
    const body = await fetch(`${baseUrl}/api/market/me`, { headers: auth }).then((r) => r.json());
    return body.account;
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyra-bankrupt-"));
    instance = createMarketServer({ port: 0, dataDir: dir, autoTick: false, adminNames: "" });
    baseUrl = `http://127.0.0.1:${instance.port}`;
    const registered = await fetch(`${baseUrl}/api/market/accounts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "quiebra", password: "contrasena-larga-123" }),
    }).then((r) => r.json());
    auth = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${registered.token}`,
    };
  });

  afterAll(() => {
    instance?.stop?.();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test("un PUT no puede marcar ni borrar la bancarrota", async () => {
    const account = instance.accounts.accounts.quiebra;
    expect(account).toBeTruthy();
    account.portfolio.bankrupt = true;
    account.portfolio.bankruptUntil = Date.now() + 86_400_000;
    account.portfolio.positions = { SOLMK: { shares: 5, avgPrice: 10, leverage: 1, margin: 50 } };
    instance.persistAccounts();

    // el siguiente autoguardado del cliente manda su bankrupt en memoria
    await fetch(`${baseUrl}/api/market/me`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ portfolio: { bankrupt: false, positions: {} } }),
    });
    const marked = await me();
    expect(marked.portfolio.bankrupt).toBe(true);
    expect(marked.portfolio.positions.SOLMK.shares).toBe(5);
  });

  test("el latido de riesgo liquida, marca y recapitaliza", async () => {
    // el latido real corre en el timer del servidor; con autoTick apagado se
    // dispara a mano para que el test no dependa del reloj
    const sweep = () => {
      const quotes = new Map();
      for (const symbol of instance.market.symbols) quotes.set(symbol.sym, { live: symbol.price });
      return instance.runRiskSweep(Math.floor(instance.market.gameTime / 86_400_000), quotes);
    };

    // efectivo a cero y sin posiciones: el patrimonio cae a cero y se marca
    const account = instance.accounts.accounts.quiebra;
    account.portfolio.bankrupt = false;
    account.portfolio.bankruptUntil = 0;
    account.portfolio.positions = {};
    account.portfolio.cash = 0;
    instance.persistAccounts();

    const notices = sweep();
    const marked = notices.get("quiebra") || [];
    expect(marked.some((n) => n.kind === "bankrupt")).toBe(true);
    const afterMark = await me();
    expect(afterMark.portfolio.bankrupt).toBe(true);
    expect(afterMark.portfolio.bankruptUntil).toBeGreaterThan(Date.now());
    expect(afterMark.portfolio.stats.timesBankrupt).toBe(1);

    // y un autoguardado no la levanta
    await fetch(`${baseUrl}/api/market/me`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ portfolio: { bankrupt: false, bankruptUntil: 0, cash: RECAP_CASH } }),
    });
    expect((await me()).portfolio.bankrupt).toBe(true);

    // pasado el tiempo de espera, la recapitalización la acredita el servidor
    account.portfolio.bankruptUntil = Date.now() - 1;
    const recap = sweep();
    expect((recap.get("quiebra") || []).some((n) => n.kind === "bankrupt-recap")).toBe(true);
    const afterRecap = await me();
    expect(afterRecap.portfolio.bankrupt).toBe(false);
    expect(afterRecap.portfolio.cash).toBe(RECAP_CASH);
    expect(afterRecap.portfolio.positions).toEqual({});
  });

  test("el casino queda bloqueado mientras la cuenta está en bancarrota", async () => {
    const account = instance.accounts.accounts.quiebra;
    account.portfolio.bankrupt = true;
    account.portfolio.bankruptUntil = Date.now() + BANKRUPT_WAIT_MS;
    account.portfolio.cash = 5000;
    instance.persistAccounts();
    const response = await fetch(`${baseUrl}/api/market/casino`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ action: "slots", bet: 100 }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/bancarrota/);
  });
});

const quotes = (price) => new Map([["SOLMK", { live: price }]]);

describe("el libro mayor hace la misma aritmética que el navegador", () => {
  // la parte con más riesgo de este cambio no es la seguridad, es la deriva:
  // buyShares/sellShares viven en js/order.js y applyBuy/applySell en
  // ledger.mjs. si un día divergen, el jugador ve un número y el servidor cobra
  // otro. estas pruebas son la referencia común de las dos implementaciones:
  // cualquier cambio en una de las dos tiene que verse aquí
  const portfolio = () => ({
    cash: 10000,
    positions: {},
    transactions: [],
    stats: { wins: 0, losses: 0, totalTrades: 0, bestTrade: 0, grossProfit: 0, grossLoss: 0,
      currentStreak: 0, bestStreak: 0, timesBankrupt: 0, peakNet: 0, bestDayReturn: 0 },
  });

  test("comprar apalancado descuenta el margen, no el nocional", () => {
    const book = portfolio();
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 5 }], quotes(200), 0);
    expect(book.cash).toBeCloseTo(10000 - (10 * 200) / 5, 6);
    expect(book.positions.SOLMK).toMatchObject({ shares: 10, avgPrice: 200, leverage: 5, margin: 400 });
  });

  test("el apalancamiento se promedia al comprar más del mismo símbolo", () => {
    const book = portfolio();
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1 }], quotes(200), 0);
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 5 }], quotes(300), 0);
    const pos = book.positions.SOLMK;
    expect(pos.shares).toBe(20);
    expect(pos.avgPrice).toBeCloseTo(250, 6);
    expect(pos.leverage).toBeCloseTo(3, 6);
    expect(pos.margin).toBeCloseTo((250 * 20) / 3, 6);
  });

  test("vender devuelve margen + P/L y nunca una cantidad negativa", () => {
    const book = portfolio();
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1 }], quotes(200), 0);
    // a 100 la pérdida son 1000 contra un margen de 2000: entra el margen
    // entero menos la pérdida, y la posición desaparece
    replayOps(book, [{ kind: "sell", sym: "SOLMK", shares: 10 }], quotes(100), 0);
    expect(book.cash).toBeCloseTo(9000, 6);
    expect(book.positions.SOLMK).toBeUndefined();
  });

  test("vender una parte deja la posición con la parte del margen que le toca", () => {
    const book = portfolio();
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1 }], quotes(200), 0);
    replayOps(book, [{ kind: "sell", sym: "SOLMK", shares: 4 }], quotes(250), 0);
    const pos = book.positions.SOLMK;
    expect(pos.shares).toBeCloseTo(6, 6);
    expect(pos.margin).toBeCloseTo(1200, 6);
    // margen devuelto (800) + P/L de las 4 acciones (4 × 50)
    expect(book.cash).toBeCloseTo(8000 + 800 + 200, 6);
  });

  test("el P/L alimenta la racha igual que recordClosedTrade del cliente", () => {
    const book = portfolio();
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1 }], quotes(200), 0);
    replayOps(book, [{ kind: "sell", sym: "SOLMK", shares: 10 }], quotes(300), 0);
    expect(book.stats).toMatchObject({ wins: 1, losses: 0, totalTrades: 1, currentStreak: 1, bestStreak: 1, bestTrade: 1000 });
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1 }], quotes(300), 0);
    replayOps(book, [{ kind: "sell", sym: "SOLMK", shares: 10 }], quotes(200), 0);
    expect(book.stats).toMatchObject({ wins: 1, losses: 1, totalTrades: 2, currentStreak: 0, bestStreak: 1, bestTrade: 1000, grossProfit: 1000, grossLoss: 1000 });
  });

  test("comprar no cuenta como operación cerrada en el ranking", () => {
    const book = portfolio();
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1 }], quotes(200), 0);
    expect(book.stats.totalTrades).toBe(0);
  });

  test("take profit, stop loss y trailing se ejecutan en el latido de riesgo", () => {
    const tp = portfolio();
    replayOps(tp, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1, tp: 250 }], quotes(200), 0);
    expect(runRiskPass(tp, quotes(200), { now: 1, gameDay: 0 })).toHaveLength(0);
    const exits = runRiskPass(tp, quotes(260), { now: 1, gameDay: 0 });
    expect(exits.some((n) => n.kind === "exit" && n.reason.includes("Take profit"))).toBe(true);
    expect(tp.positions.SOLMK).toBeUndefined();

    const sl = portfolio();
    replayOps(sl, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1, sl: 150 }], quotes(200), 0);
    expect(runRiskPass(sl, quotes(140), { now: 1, gameDay: 0 }).some((n) => n.kind === "exit")).toBe(true);
    expect(sl.positions.SOLMK).toBeUndefined();

    const trail = portfolio();
    replayOps(trail, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1, trailPct: 10 }], quotes(200), 0);
    runRiskPass(trail, quotes(300), { now: 1, gameDay: 0 });
    expect(trail.positions.SOLMK.trailPeak).toBe(300);
    expect(runRiskPass(trail, quotes(260), { now: 1, gameDay: 0 }).some((n) => n.kind === "exit")).toBe(true);
    expect(trail.positions.SOLMK).toBeUndefined();
  });

  test("una posición apalancada que vale cero se liquida sola", () => {
    const book = portfolio();
    // x5 a 200: el margen son 400 y la pérdida se come los 400 al bajar a 120
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 5 }], quotes(200), 0);
    const notices = runRiskPass(book, quotes(120), { now: 1, gameDay: 0 });
    expect(notices.some((n) => n.kind === "liquidated")).toBe(true);
    expect(book.positions.SOLMK).toBeUndefined();
    expect(book.stats.losses).toBe(1);
  });

  test("el patrimonio se mide con margen + P/L, como positionContribution", () => {
    const book = portfolio();
    replayOps(book, [{ kind: "buy", sym: "SOLMK", shares: 10, leverage: 1 }], quotes(200), 0);
    // efectivo 8000 + margen 2000 + P/L de 10 × (250 - 200) = 500
    runRiskPass(book, quotes(250), { now: 1, gameDay: 0 });
    expect(book.stats.peakNet).toBeCloseTo(10500, 6);
  });
});
