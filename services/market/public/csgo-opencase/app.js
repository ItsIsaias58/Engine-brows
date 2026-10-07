// opencase — cliente standalone de owngames. el mismo dinero, banco e
// inventario que Bolsa — Trading Floor: cada acción es un POST al mismo
// server del mercado y el cash vive en el MISMO portfolio del server. para
// la sesión reutiliza las claves de localStorage de la bolsa (SSO sin
// tokens duplicados): si inicias sesión en la bolsa, aquí entras directo.
//
// modo invitado: rueda con el catálogo público del server (mismos pesos y
// rangos que skins.mjs) y compara contra el cash local de la bolsa
// (bolsa-trading-floor-save → state.cash). el loot de invitado se queda
// en este navegador.
//
// el resultado SIEMPRE lo decide el server cuando hay sesión; el cliente
// sólo anima lo que el server le dice que salió.

(() => {
  "use strict";

  // claves EXACTAS de la bolsa: una sola sesión para ambos juegos
  const TOKEN_KEY = "bolsa-market-token";
  const NAME_KEY = "bolsa-market-name";
  const GUEST_KEY = "bolsa-market-guest";
  // el save de invitado de la bolsa: de ahí sale y ahí entra el cash
  const BOLSA_SAVE_KEY = "bolsa-trading-floor-save";
  // inventario local del modo invitado
  const LOCAL_INV_KEY = "opencase-local-inventory-v1";
  const LOCAL_STATS_KEY = "opencase-local-stats-v1";
  const API = "/api/market";

  const money = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
  // arte: foto real si hay (img/assets.json), si no SVG procedural
  let photoMap = {};
  let crateMap = {};
  async function loadPhotoMap() {
    try {
      const d = await (await fetch("img/assets.json")).json();
      photoMap = d.images || {};
      crateMap = d.crates || {};
    } catch { photoMap = {}; crateMap = {}; }
  }
  const photoFor = (name) => photoMap[name] ? `img/${photoMap[name].replace(/^img\//, "")}` : null;
  function artHtml(it) {
    const name = it.item || it.name || "?";
    const src = photoFor(name);
    if (src) {
      return `<img class="wpn-photo" loading="lazy" src="${esc(src)}" alt="${esc(name)}" data-fallback="1" onerror="this.onerror=null;this.outerHTML=window.OpenCaseArt?window.OpenCaseArt.weaponSvg(${esc(JSON.stringify(name))}):''">`;
    }
    return art(it);
  }
  // arte y efectos procedurales (weapons.js / effects.js)
  const art = (it) => (window.OpenCaseArt ? window.OpenCaseArt.weaponSvg(it) : "");
  const crate = (color) => (window.OpenCaseArt ? window.OpenCaseArt.crateSvg(color) : "📦");
  // foto real de la caja si hay, si no la dibujada
  // la foto cae al SVG dibujado si falta o no carga: sin esto, una caja cuya foto
// no esta en disco sale con el icono de imagen rota (a artHtml si tiene onerror,
// esta no lo tenia)
  const caseArt = (c) => (crateMap[c.id] ? `<img class="crate-photo" src="${esc(crateMap[c.id])}" alt="${esc(c.name)}" loading="lazy" onerror="this.outerHTML=window.OpenCaseArt?window.OpenCaseArt.crateSvg('${esc(c.color || '#4b69ff')}'):''">` : crate(c.color));
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
  const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

  // ---------------------------------------------------------------- estado

  const session = { token: "", name: "", guest: false, cash: 0, sso: false };
  let catalog = { cases: {}, rarities: {}, wears: [], stattrak: { chance: 0.1, mult: 1.5 } };
  let inventory = [];
  let stats = { opened: 0, spent: 0, earned: 0 };
  let currentCase = null;
  let spinning = false;

  const signedIn = () => Boolean(session.token) || session.sso;

  // ---------------------------------------------------------------- api

  async function api(path, opts = {}) {
    const headers = {};
    if (opts.body) headers["Content-Type"] = "application/json";
    if (session.token) headers.Authorization = `Bearer ${session.token}`;
    const res = await fetch(API + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const err = new Error((await res.json().catch(() => ({}))).error || `error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // ---------------------------------------------------------------- sso

  function readSharedSession() {
    session.token = localStorage.getItem(TOKEN_KEY) || "";
    session.name = localStorage.getItem(NAME_KEY) || "";
    session.guest = localStorage.getItem(GUEST_KEY) === "1";
    session.sso = false;
  }

  function storeSharedSession(token, name) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY);
      if (name) localStorage.setItem(NAME_KEY, name); else localStorage.removeItem(NAME_KEY);
      localStorage.removeItem(GUEST_KEY);
    } catch {}
  }

  // ---------------------------------------------------------------- cash de invitado (el save de la bolsa)

  function guestState() {
    try { return JSON.parse(localStorage.getItem(BOLSA_SAVE_KEY) || "{}").state || {}; } catch { return {}; }
  }

  function guestCash() {
    return Math.max(0, Number(guestState().cash) || 0);
  }

  function setGuestCash(v) {
    try {
      const raw = localStorage.getItem(BOLSA_SAVE_KEY);
      const save = raw ? JSON.parse(raw) : {};
      save.state = save.state || {};
      save.state.cash = Math.max(0, Math.round(v));
      localStorage.setItem(BOLSA_SAVE_KEY, JSON.stringify(save));
      session.cash = save.state.cash;
    } catch {}
  }

  // ---------------------------------------------------------------- inventario local (invitado)

  function loadLocal() {
    try { inventory = JSON.parse(localStorage.getItem(LOCAL_INV_KEY) || "[]") || []; } catch { inventory = []; }
    try { stats = Object.assign(stats, JSON.parse(localStorage.getItem(LOCAL_STATS_KEY) || "{}")); } catch {}
  }

  function saveLocal() {
    try {
      localStorage.setItem(LOCAL_INV_KEY, JSON.stringify(inventory));
      localStorage.setItem(LOCAL_STATS_KEY, JSON.stringify(stats));
    } catch {}
  }

  // ---------------------------------------------------------------- boot

  async function boot() {
    readSharedSession();
    loadLocal();
    bindStatic();
    preloadSfx(); // ogg reales: victoria, porra, cadena, deflate, error, crash
    await loadPhotoMap(); // fotos reales de CS:GO (con fallback SVG)
    // SSO: si la bolsa dejó un token, se valida contra el server una vez
    // (el cash de verdad llega con refreshServer() vía GET /skins)
    if (session.token && !session.guest) {
      try {
        const me = await api("/me");
        session.name = (me.account && me.account.name) || session.name;
        await enterApp();
        return;
      } catch {
        // token muerto: limpiamos y pedimos login
        session.token = "";
        storeSharedSession("", "");
      }
    }
    // SSO con cloudsync: sin token de mercado, el server igual puede
    // autenticarnos por la sesión de la nube (cookie del handshake). probamos
    // /me; si contesta con una cuenta, entramos sin pedir login. si no hay
    // sesión de nube, el catch nos deja en el gate de siempre.
    if (!session.guest) {
      try {
        const me = await api("/me");
        if (me && me.account) {
          session.sso = true;
          session.name = me.account.name || "";
          await enterApp();
          return;
        }
      } catch { /* sin sesión de nube: seguimos al gate */ }
    }
    showGate();
  }

  function showGate() {
    $("sessionGate").classList.remove("is-hidden");
    $("gateNote").textContent = session.guest
      ? "Estás como invitado de la bolsa — el loot se guarda sólo en este navegador."
      : "Entra con el mismo usuario y contraseña de la bolsa: tu cash, tu banco y tu inventario viajan contigo.";
    renderWallet();
  }

  // ---------------------------------------------------------------- auth

  let authIsRegister = false;

  function openAuth() {
    authIsRegister = false;
    $("authTitle").textContent = "Iniciar sesión";
    $("authSubmit").textContent = "Entrar";
    $("authModeToggle").textContent = "No tengo cuenta — registrarme";
    $("authError").textContent = "";
    $("authOverlay").classList.add("is-visible");
    setTimeout(() => $("authName").focus(), 50);
  }

  async function doAuth() {
    const name = $("authName").value.trim();
    const pass = $("authPass").value;
    if (!name || !pass) { $("authError").textContent = "escribe usuario y contraseña"; return; }
    $("authSubmit").disabled = true;
    try {
      const r = authIsRegister
        ? await api("/accounts", { method: "POST", body: { name, password: pass } })
        : await api("/sessions", { method: "POST", body: { name, password: pass } });
      session.token = r.token;
      session.name = r.account.name;
      session.guest = false;
      session.sso = false; // un login de mercado manda sobre el SSO de la nube
      // guardar en las claves de la bolsa: allí la sesión ya está lista
      storeSharedSession(r.token, r.account.name);
      $("authOverlay").classList.remove("is-visible");
      await enterApp(); // refreshServer() trae el cash real del portfolio
    } catch (e) {
      $("authError").textContent = e.message;
    } finally {
      $("authSubmit").disabled = false;
    }
  }

  // ---------------------------------------------------------------- app

  async function enterApp() {
    $("sessionGate").classList.add("is-hidden");
    $("app").classList.remove("is-hidden");
    try { catalog = await api("/skins/catalog"); } catch { /* fallback vacío: sin cajas locales */ }
    if (signedIn()) {
      await refreshServer().catch(() => {});
    } else {
      loadLocal();
      session.cash = guestCash();
    }
    renderWallet();
    renderCases();
    renderInventory();
    renderStats();
    if (signedIn()) {
      connectLive();          // push en vivo: cash/inventario cambian sin recargar
      startPollBridge();      // releo cada 3s: congruencia garantizada
      loadTrades();           // libro de ofertas al entrar
    }
  }

  function refreshServer() {
    return api("/skins").then((d) => {
      inventory = d.inventory || [];
      session.cash = d.cash ?? session.cash;
      stats = d.stats || { opened: 0, spent: 0, earned: 0 };
      tradesBook = d.trades || tradesBook;
      renderWallet();
    });
  }

  // ---------------------------------------------------------------- render

  function renderWallet() {
    $("walletCash").textContent = money(signedIn() ? session.cash : guestCash());
    $("walletCash").title = signedIn()
      ? "El mismo cash de la bolsa y el banco — un solo monedero"
      : "cash local de invitado (el save de la bolsa en este navegador)";
    $("openBankBtn").classList.toggle("is-hidden", !signedIn());
    $("gotoBolsa").classList.toggle("is-hidden", !signedIn());
    // invitado: acceso directo al login SIN pasar por recargar (la cuenta de la
    // bolsa es la misma de acá; al entrar el monedero se vuelve el del server)
    const loginBtn = $("topLoginBtn");
    if (loginBtn) loginBtn.classList.toggle("is-hidden", signedIn());
  }

  const canAfford = (c) => (signedIn() ? session.cash : guestCash()) >= c.cost;

  function renderCases() {
    const cases = Object.values(catalog.cases || {});
    $("caseGrid").innerHTML = cases.map((c) => `
      <div class="case-card" style="--case-color:${esc(c.color || "#5b8cff")}">
        <div class="case-visual">${caseArt(c)}</div>
        <h3>${esc(c.name)}</h3>
        <p class="case-cost mono">${money(c.cost)}</p>
        <p class="case-odds">${oddsText(c)}</p>
        <button class="case-open" data-case="${esc(c.id)}" ${canAfford(c) ? "" : "disabled"}>
          ${canAfford(c) ? "Abrir caja" : "Sin cash"}
        </button>
      </div>`).join("");
    $("caseGrid").querySelectorAll("[data-case]").forEach((b) => {
      b.onclick = () => openCase(b.dataset.case);
    });
  }

  function oddsText(c) {
    const rar = catalog.rarities || {};
    return Object.entries(c.pools || {})
      .map(([id]) => `${rar[id] ? rar[id].name.toLowerCase() : id}`)
      .join(" · ");
  }

  function renderInventory() {
    // auto-reparación: con sesión, un inventario vacío dispara una verificación
    // contra el server (antes había que recargar para ver las skins compradas)
    if (signedIn() && inventory.length === 0 && !invRepairPending) {
      invRepairPending = true;
      setTimeout(async () => {
        invRepairPending = false;
        try {
          const d = await api("/skins");
          if ((d.inventory || []).length) {
            inventory = d.inventory;
            session.cash = d.cash ?? session.cash;
            stats = d.stats || stats;
            lastInvSig = invSig(inventory);
            renderInventory(); renderStats(); renderWallet();
          }
        } catch {}
      }, 400);
    }
    $("invCount").textContent = inventory.length ? String(inventory.length) : "";
    $("invValue").textContent = `Valor total: ${money(inventory.reduce((s, it) => s + (it.value || 0), 0))}`;
    if (!inventory.length) {
      $("inventory").innerHTML = `<div class="inv-empty">Inventario vacío — abre cajas para llenarlo 🎁</div>`;
      return;
    }
    // newest first
    const rows = inventory.slice().reverse();
    $("inventory").innerHTML = rows.map((it) => `
      <div class="skin-card" style="--rc:${esc(it.color || "#4b69ff")}">
        <span class="sk-st">${esc(it.rarityName || "")}${it.stattrak ? " · StatTrak™" : ""}</span>
        <div class="sk-art">${artHtml(it)}</div>
        <b>${esc(it.item || "")}</b>
        <span class="sk-sub">${esc(it.wearName || "")} · ${esc(it.wear || "")}</span>
        <div class="sk-foot">
          <span class="sk-val mono">${money(it.value)}</span>
          <button data-sell="${esc(it.id)}" class="ghost">Vender</button>
        </div>
      </div>`).join("");
    $("inventory").querySelectorAll("[data-sell]").forEach((b) => {
      b.onclick = () => sellItem(b.dataset.sell);
    });
  }

  let invRepairPending = false;

  function renderStats() {
    const balance = (stats.earned || 0) - (stats.spent || 0);
    const cards = [
      ["Cajas abiertas", stats.opened || 0, ""],
      ["Gastado en cajas", money(stats.spent || 0), "neg"],
      ["Ingresos por ventas", money(stats.earned || 0), "pos"],
      ["Balance", money(balance), balance >= 0 ? "pos" : "neg"],
      ["Mejor loot", bestLootText(), ""],
      ["Skins en inventario", inventory.length || 0, ""],
    ];
    // dos apartados SEPARADOS como pidió el usuario: tus números arriba, el
    // mercado global (lo más caro/raro y cuántos jugadores lo tienen) abajo
    $("statsWrap").innerHTML = `
      <h3 class="stats-title">📊 Tus estadísticas</h3>
      <div class="stats-grid">
        ${cards.map(([label, val, cls]) => `
          <div class="stat-card">
            <span>${esc(label)}</span>
            <strong class="${cls}">${esc(String(val))}</strong>
          </div>`).join("")}
      </div>
      <h3 class="stats-title">🌍 Mercado global — lo más valioso en manos de los jugadores</h3>
      <div id="marketStats" class="market-stats"><p class="hint">Cargando mercado…</p></div>`;
    paintMarketStats();
  }

  // el mercado visto desde el server: cuántas copias de cada skin existen
  // entre todos los jugadores y cuánta gente la posee ("sólo 3 personas en
  // el server tienen esta"). caché de 30s para no martillar el endpoint.
  let marketStatsCache = { at: 0, data: null };
  async function paintMarketStats(force = false) {
    const box = $("marketStats");
    if (!box) return;
    if (!force && marketStatsCache.data && Date.now() - marketStatsCache.at < 30000) {
      box.innerHTML = marketStatsHtml(marketStatsCache.data);
      return;
    }
    try {
      const d = await api("/skins/market-stats");
      marketStatsCache = { at: Date.now(), data: d };
      box.innerHTML = marketStatsHtml(d);
    } catch {
      box.innerHTML = `<p class="hint">No se pudo cargar el mercado ahora.</p>`;
    }
  }

  function marketStatsHtml(d) {
    const top = (d.items || []).slice(0, 12);
    if (!top.length) return `<p class="hint">Todavía no hay skins en manos de jugadores — abre la primera caja.</p>`;
    const maxV = top[0].value || 1;
    return `
      <p class="ms-summary">${d.totalItems || 0} skins en circulación · ${d.uniqueItems || 0} modelos distintos · valor total ${money(d.totalValue || 0)} · ${d.players || 0} cuentas</p>
      <div class="ms-rows">
        ${top.map((it) => `
          <div class="ms-row">
            <div class="ms-art" style="border-color:${esc(it.color)}">${artHtml({ item: it.item })}</div>
            <div class="ms-info">
              <b>${esc(it.item)}</b>
              <span class="ms-sub">${esc(it.rarityName)}${it.stattrak ? ` · ${it.stattrak} StatTrak™` : ""}</span>
              <div class="ms-bar"><div style="width:${Math.max(6, Math.round((it.value / maxV) * 100))}%; background:${esc(it.color)}"></div></div>
            </div>
            <div class="ms-nums mono">
              <strong>${money(it.value)}</strong>
              <span>${it.copies} copia${it.copies === 1 ? "" : "s"} · ${it.owners} jugador${it.owners === 1 ? "" : "es"}</span>
            </div>
          </div>`).join("")}
      </div>`;
  }

  function bestLootText() {
    if (!inventory.length) return "—";
    const best = inventory.reduce((a, b) => ((b.value || 0) > (a.value || 0) ? b : a));
    return `${best.item} (${money(best.value)})`;
  }

  // ---------------------------------------------------------------- abrir caja

  // el server ya nació el item dentro del inventario de la cuenta, pero el
  // cliente NO lo adopta hasta que la ruleta se detiene. concederlo (inventario
  // + stats) en el .then de abrir era exactamente el bug de "me da el arma en
  // el primer segundo": el inventario se pintaba antes de que acabara el giro.
  let pendingReveal = null;

  function openCase(id) {
    if (spinning) return;
    const c = (catalog.cases || {})[id];
    if (!c) return;
    if (!canAfford(c)) { playSfx("lose", 0.3); toast("No tienes cash suficiente — retira del banco 🏦", "down"); return; }
    $("resultCard").classList.add("is-hidden");
    if (signedIn()) {
      api("/skins", { method: "POST", body: { action: "open", caseId: id } })
        .then((r) => {
          // pagar SÍ se refleja al instante (el costo ya se conoce); el premio
          // queda pendiente hasta el revelado.
          session.cash = r.cash;
          pendingReveal = { case: c, item: r.item };
          startSpin(c, r.item);
        })
        .catch((e) => toast("No se pudo abrir: " + e.message, "down"));
    } else {
      const item = rollLocal(c);
      // el invitado paga al abrir, pero el loot se suma recién al revelar
      setGuestCash(guestCash() - c.cost);
      pendingReveal = { case: c, item };
      startSpin(c, item);
    }
  }

  // se llama UNA vez, al terminar el giro: recién aquí el jugador recibe la skin
  // (inventario + stats). idempotente: limpia el pendiente para no duplicar.
  function commitReveal() {
    const p = pendingReveal;
    pendingReveal = null;
    if (!p || !p.item) return;
    inventory.push(p.item);
    stats.opened += 1;
    stats.spent += p.case.cost;
    if (!signedIn()) saveLocal();
    renderWallet();
  }

  function startSpin(c, item) {
    spinning = true;
    currentCase = c;
    if (window.OpenCaseFX) { try { window.OpenCaseFX.spinStart(); } catch {} }
    const wrap = $("rouletteWrap");
    // la cinta visible es #roulette (el único con overflow): sobre él se hace
    // el scroll. animar el wrapper no mueve nada (scrollLeft siempre 0).
    const reel = $("roulette");
    buildRoulette(c);
    wrap.classList.remove("is-hidden");
    $("caseGrid").classList.add("is-hidden");
    const backBtn = $("rouletteBack");
    if (backBtn) backBtn.disabled = true; // no hay vuelta atrás a mitad de giro
    renderWallet();

    const STEP = 156; // 148px de tarjeta + 8px de gap (style.css)
    const WINNER = 42;
    const dur = 5200 + Math.random() * 900;
    const reelW = reel.clientWidth || wrap.clientWidth || 700;
    const target = Math.max(0, WINNER * STEP + 74 - reelW / 2);

    requestAnimationFrame(() => {
      reel.scrollLeft = 0;
      smoothScrollTo(reel, target, dur, () => {
        spinning = false;
        if (backBtn) backBtn.disabled = false;
        try { showResult(c, item); } catch { recoverFromSpin(); }
      }, () => tickNow()); // CADA cruce de carta suena su tic: sonido 100% atado al movimiento
    });
  }

  // red de seguridad: si el giro o el revelado fallan, la UI vuelve a un
  // estado operable en vez de quedarse congelada hasta recargar
  function recoverFromSpin() {
    spinning = false;
    // el server ya concedió el item: si el revelado falló, lo commitamos igual
    // para que no se pierda del cliente (el inventario "está a salvo")
    try { commitReveal(); } catch {}
    playSfx("lose", 0.3);
    const backBtn = $("rouletteBack");
    if (backBtn) backBtn.disabled = false;
    $("resultCard").classList.add("is-hidden");
    $("rouletteWrap").classList.add("is-hidden");
    $("caseGrid").classList.remove("is-hidden");
    renderCases();
    renderInventory();
    toast("Algo falló al revelar la caja — tu inventario está a salvo", "down");
  }

  function showResult(c, item) {
    const el = $("resultCard");
    el.classList.remove("is-hidden");
    el.innerHTML = `
      <div class="rc-box" id="rcBox" style="--rc:${esc(item.color || "#4b69ff")}">
        <div class="rc-art">${artHtml(item)}</div>
        <div class="rc-name">${esc(item.item || "?")}${item.stattrak ? " <small>StatTrak™</small>" : ""}</div>
        <div class="rc-sub">${esc(item.wearName || "")} · ${esc(item.rarityName || "")}</div>
        <div class="rc-val mono">${money(item.value)}</div>
      </div>
      <div class="rc-actions">
        <button id="rcSell" class="primary">💵 Vender por ${money(item.value)}</button>
        <button id="rcKeep">🎒 Guardar en inventario</button>
        <button id="rcAgain" class="ghost">🔁 Abrir otra</button>
        <button id="rcBack" class="ghost">← Volver a las cajas</button>
      </div>`;
    // los botones se bindean PRIMERO: aunque los efectos fallen, la tarjeta
    // siempre es operable (antes una excepción aquí congelaba la pantalla)
    $("rcKeep").onclick = () => { playSfx("chain", 0.25); toast("Guardada en tu inventario 🎒", "up"); closeResult(); };
    $("rcBack").onclick = closeResult;
    $("rcSell").onclick = () => { closeResult(); sellItem(item.id); };
    $("rcAgain").onclick = () => { closeResult(); openCase(currentCase.id); };
    // marca el ganador en la cinta y le dispara los efectos
    revealWinnerAt(item);
    let level = 0;
    try {
      level = window.OpenCaseFX ? window.OpenCaseFX.reveal(item, document.getElementById("rcBox")) : 0;
    } catch {}
    try { winJingle(level); } catch {}
    // capa sfx real según el nivel: cadena (classified), win (covert),
    // win + porra de multitud (cuchillo ★). caída mala = deflate.
    if (level >= 3) playSfx("win", 0.5); // sin porra: sonaba a coro de fondo
    else if (level === 2) playSfx("win", 0.45);
    else if (level === 1) playSfx("chain", 0.4);
    else if ((item.value || 0) < c.cost * 0.25) { playSfx("crash", 0.3); playSfx("low", 0.3); } // caída brutal
    else if ((item.value || 0) < c.cost) playSfx("low", 0.35);

    if ((item.value || 0) >= c.cost * 3) {
      toast(`¡JACKPOT! ${item.item} — ${money(item.value)}`, "gold");
      jackpotSound();
    } else if ((item.value || 0) >= c.cost) {
      toast(`+${money(item.value - c.cost)} vs el costo de la caja`, "up");
    } else {
      toast(`${money(item.value - c.cost)} vs el costo de la caja`, "down");
    }
    // el giro terminó: AHORA se concede el item (inventario + stats)
    commitReveal();
    renderInventory();
    renderStats();
  }

  function closeResult() {
    $("resultCard").classList.add("is-hidden");
    $("rouletteWrap").classList.add("is-hidden");
    $("caseGrid").classList.remove("is-hidden");
    const backBtn = $("rouletteBack");
    if (backBtn) backBtn.disabled = false;
    renderCases();
    renderInventory();
    renderStats();
    scheduleLiveRefresh(); // la verdad del server: stats/cash exactos tras abrir
  }

  // ---------------------------------------------------------------- vender

  function sellItem(itemId) {
    if (signedIn()) {
      api("/skins", { method: "POST", body: { action: "sell", itemId } })
        .then((r) => {
          session.cash = r.cash;
          renderWallet();
          playSfx("chain", 0.35); // jingle metálico de venta
          if (r.sold) toast(`Vendiste ${r.sold.item} por ${money(r.sold.value)}`, "up");
          return refreshServer();
        })
        .then(() => { renderInventory(); renderCases(); renderStats(); })
        .catch((e) => toast("Error: " + e.message, "down"));
    } else {
      const idx = inventory.findIndex((x) => x.id === itemId);
      if (idx < 0) return;
      const [it] = inventory.splice(idx, 1);
      stats.earned += it.value || 0;
      playSfx("chain", 0.35);
      setGuestCash(guestCash() + (it.value || 0));
      saveLocal();
      renderWallet();
      toast(`Vendiste ${it.item} por ${money(it.value)}`, "up");
      renderInventory();
      renderCases();
      renderStats();
    }
  }

  function sellAll() {
    if (!inventory.length) { toast("El inventario ya está vacío", "down"); return; }
    const total = inventory.reduce((s, it) => s + (it.value || 0), 0);
    if (!confirm(`¿Vender TODO el inventario por ${money(total)}?`)) return;
    if (signedIn()) {
      api("/skins", { method: "POST", body: { action: "sellAll" } })
        .then((r) => {
          session.cash = r.cash;
          renderWallet();
          playSfx("chain", 0.4);
          toast(`Inventario vendido: ${r.count} skins por ${money(r.total)}`, "up");
          return refreshServer();
        })
        .then(() => { renderInventory(); renderCases(); renderStats(); })
        .catch((e) => toast("Error: " + e.message, "down"));
    } else {
      inventory = [];
      stats.earned += total;
      setGuestCash(guestCash() + total);
      saveLocal();
      renderWallet();
      playSfx("chain", 0.4);
      toast(`Inventario vendido por ${money(total)}`, "up");
      renderInventory();
      renderCases();
      renderStats();
    }
  }

  // ---------------------------------------------------------------- ruleta

  function buildRoulette(c) {
    const pool = [];
    Object.entries(c.pools || {}).forEach(([rarityId, p]) => {
      (p.items || []).forEach((name) => pool.push({ name, rarityId }));
    });
    const items = [];
    for (let i = 0; i < 48; i += 1) items.push(fakeItem(pool, rand(0, pool.length - 1)));
    // la casilla 42 recibe un relleno y NO el premio: si el item real se
    // pintase aqui se veria en la cinta antes de que esta empiece a girar, que
    // es justo lo que hacia el giro (el resultado ya estaba escrito en
    // pantalla). revealWinnerAt lo sustituye cuando la cinta se para.
    $("roulette").innerHTML = items.map(rouletteItemHtml).join("");
  }

  // se llama al terminar el scroll, no antes: es el momento en que el jugador
  // mira. mismo item, misma posicion, misma animacion de is-winner.
  function revealWinnerAt(winner) {
    const winnerEl = document.querySelectorAll("#roulette .rl-item")[42];
    if (!winnerEl) return;
    winnerEl.outerHTML = rouletteItemHtml(winner);
    const el = document.querySelectorAll("#roulette .rl-item")[42];
    if (el) el.classList.add("is-winner");
  }

  function rouletteItemHtml(it) {
    return `
      <div class="rl-item" style="--rc:${esc(it.color || "#4b69ff")}">
        <div class="rl-art">${artHtml(it)}</div>
        <span class="rl-st">${esc((it.rarityName || "?").toUpperCase())}</span>
        <b>${esc(it.item || it.name || "?")}</b>
        <span>${esc(it.wearName || "")}</span>
        <span class="mono">${money(it.value || 0)}</span>
      </div>`;
  }

  // item de relleno para la animación (cosmético, no afecta el resultado)
  function fakeItem(pool, idx) {
    const rar = catalog.rarities || {};
    const p = pool[idx] || { name: "?", rarityId: "milspec" };
    const wear = (catalog.wears || [])[rand(0, (catalog.wears.length || 1) - 1)] || { id: "FT", name: "Field-Tested", mult: 1 };
    const r = rar[p.rarityId] || { name: p.rarityId, color: "#4b69ff" };
    return {
      name: p.name, item: p.name,
      rarityName: r.name, color: r.color,
      wearName: wear.name, wear: wear.id,
      value: 0,
    };
  }

  // rolleo local del invitado: espejo exacto de rollItem() en skins.mjs
  function rollLocal(c) {
    const rar = catalog.rarities || {};
    const entries = Object.entries(c.pools || {});
    const totalW = entries.reduce((s, [rid]) => s + ((rar[rid] && rar[rid].w) || 0), 0);
    let r = Math.random() * totalW;
    let pickedId = entries[entries.length - 1][0];
    for (const [rid] of entries) {
      r -= (rar[rid] && rar[rid].w) || 0;
      if (r <= 0) { pickedId = rid; break; }
    }
    const pool = c.pools[pickedId];
    const name = pool.items[rand(0, pool.items.length - 1)];
    const wears = catalog.wears || [];
    const totalWear = wears.reduce((s, w) => s + (w.w || 0), 0) || 1;
    let rw = Math.random() * totalWear;
    let wear = wears[wears.length - 1] || { id: "FT", name: "Field-Tested", mult: 1 };
    for (const w of wears) { rw -= w.w || 0; if (rw <= 0) { wear = w; break; } }
    const st = catalog.stattrak || { chance: 0.1, mult: 1.5 };
    const stattrak = Math.random() < st.chance;
    const [lo, hi] = pool.mult;
    let value = c.cost * (lo + Math.random() * (hi - lo));
    value *= wear.mult;
    if (stattrak) value *= st.mult;
    value = Math.max(50, Math.round(value));
    const rarity = rar[pickedId] || { name: pickedId, color: "#4b69ff" };
    return {
      id: "l-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      caseId: c.id, at: Date.now(),
      rarity: pickedId, rarityName: rarity.name, color: rarity.color,
      item: name, wear: wear.id, wearName: wear.name, stattrak, value,
    };
  }

  function smoothScrollTo(reel, target, dur, cb, onStep) {
    const t0 = performance.now();
    let done = false;
    let lastIdx = -1;
    const finish = () => { if (!done) { done = true; cb(); } };
    // si el rAF se corta (pestaña de fondo, error), un seguro libera el giro
    const failsafe = setTimeout(finish, dur + 2500);
    function frame(now) {
      if (done) { clearTimeout(failsafe); return; }
      if (!reel.isConnected) { clearTimeout(failsafe); return finish(); }
      const p = Math.min(1, (now - t0) / dur);
      const e = 1 - Math.pow(1 - p, 5); // quintic ease-out
      reel.scrollLeft = target * e;
      // tic por cruce de tarjeta: el sonido nace del movimiento REAL de la
      // cinta, no de un horario estimado — nunca se desincroniza
      if (typeof onStep === "function") {
        const idx = Math.floor((reel.scrollLeft + (reel.clientWidth || 700) / 2) / 156);
        if (idx !== lastIdx) { lastIdx = idx; try { onStep(idx, 1 - p); } catch {} }
      }
      if (p < 1) requestAnimationFrame(frame);
      else { clearTimeout(failsafe); finish(); }
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- sfx reales (ogg precargados)
  // sonidos de la Google Sound Library (uso libre con atribución, ver footer)
  const SFX = { win: null, chain: null, low: null, lose: null, crash: null };
  function preloadSfx() {
    for (const k of Object.keys(SFX)) {
      try {
        const a = new Audio(`img/sfx/${k}.ogg`);
        a.preload = "auto";
        SFX[k] = a;
      } catch { SFX[k] = null; }
    }
  }
  // tope de voces: al superar el maximo se corta la copia mas vieja en vez de
  // sumar otra encima. (antes se llamaba oldest.stop(), metodo que NO existe en
  // HTMLAudioElement: el catch se lo tragaba, la copia seguia sonando y solo se
  // dejaba de rastrear; de ahi el "loop" al vender rapido.)
  const MAX_SFX_VOICES = 6;
  const sfxVoices = [];
  // los .ogg traen mas de lo que este juego necesita (chain.ogg es un tren de
  // ~10 clinks en 13 s). cada sfx se recorta a su trozo util [inicio, duracion]
  // en segundos, para que suene UNA vez (un solo golpe metalico al vender) y no
  // arrastre repeticiones.
  const SFX_WINDOW = {
    win: [1.85, 1.30],   // la fanfarria arranca tras ~1.9 s de silencio
    chain: [0.00, 0.45], // primer golpe metalico, no los 10 del archivo
    low: [0.55, 1.45],   // el .ogg arranca en silencio
    lose: [1.50, 0.90],
    crash: [0.00, 2.25],
  };
  const lastSfxAt = Object.create(null);

  function stopVoice(a) {
    try { a.pause(); } catch {}
    try { a.currentTime = 0; } catch {}
  }

  function playSfx(name, vol = 0.4) {
    try {
      const base = SFX[name];
      if (!base) return;
      const window_ = SFX_WINDOW[name] || [0, 1.2];
      const [start, dur] = window_;
      // no auto-solape: mientras la copia del mismo sfx sigue viva, no se
      // relanza otra (vender en rafaga daba el efecto "loop loop loop").
      const now = performance.now();
      const last = lastSfxAt[name];
      if (last !== undefined && now - last < dur * 1000) return;
      lastSfxAt[name] = now;
      // clon para permitir solaparse con OTROS sfx (dos victorias seguidas, etc.)
      const a = base.cloneNode();
      a.volume = vol;
      while (sfxVoices.length >= MAX_SFX_VOICES) stopVoice(sfxVoices.shift());
      const release = () => {
        const i = sfxVoices.indexOf(a);
        if (i >= 0) sfxVoices.splice(i, 1);
        clearTimeout(a.__lyraStop);
      };
      a.addEventListener("ended", release);
      a.addEventListener("error", release);
      sfxVoices.push(a);
      const seek = () => { try { a.currentTime = start; } catch {} };
      if (a.readyState >= 1) seek();
      else a.addEventListener("loadedmetadata", seek, { once: true });
      a.play().catch(release);
      a.__lyraStop = setTimeout(() => { stopVoice(a); release(); }, Math.round(dur * 1000) + 40);
    } catch {}
  }

  // el tic de la cinta dispara en cada cruce de tarjeta (48 por giro) y cada uno
  // creaba un oscilador nuevo. al encadenar giros los del anterior seguian
  // sonando encima: de ahi el lagueo. el tope es de osciladores vivos, no de
  // tiempo: el tic sigue naciendo del movimiento real de la cinta.
  const MAX_TICK_OSCILLATORS = 12;
  let liveOscillators = 0;
  function blip(ctx, at, freq, gain, dur) {
    if (liveOscillators >= MAX_TICK_OSCILLATORS) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "square";
    o.frequency.value = freq;
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + dur + 0.01);
    liveOscillators += 1;
    o.onended = () => { liveOscillators -= 1; };
  }

  // ---------------------------------------------------------------- audio (WebAudio, sin archivos)

  let audioCtx = null;
  function ensureCtx() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    } catch { audioCtx = null; }
    return audioCtx;
  }

  // un tic AHORA (lo llama el bucle de la cinta en cada cruce de tarjeta):
  // despierta el AudioContext perezosamente, así el primer giro de la sesión
  // también suena aunque el navegador lo tuviera suspendido
  function tickNow(intensity = 1) {
    const ctx = ensureCtx();
    if (!ctx) return;
    const gain = Math.max(0.012, 0.03 * intensity);
    blip(ctx, ctx.currentTime + 0.001, 1750, gain, 0.045);
  }

  function jackpotSound() {
    const ctx = ensureCtx();
    if (!ctx) return;
    const base = ctx.currentTime + 0.05;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      blip(ctx, base + i * 0.09, f, 0.06, 0.22);
    });
  }

  // jingle de victoria escalado por rareza: nivel 0 = blip corto y neutro,
  // 1 = dos notas, 2 = arpegio menor, 3 = fanfarria larga (cuchillo/gold)
  function winJingle(level) {
    const ctx = ensureCtx();
    if (!ctx) return;
    const base = ctx.currentTime + 0.05;
    const seqs = [
      [[660, 0.1]],
      [[587.33, 0.1], [880, 0.16]],
      [[523.25, 0.1], [659.25, 0.1], [987.77, 0.2]],
      [[523.25, 0.09], [659.25, 0.09], [783.99, 0.09], [1046.5, 0.24], [1318.5, 0.34]],
    ];
    const gains = [0.035, 0.045, 0.055, 0.07];
    let t = 0;
    (seqs[Math.min(level, 3)] || seqs[0]).forEach(([f, dur]) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = level >= 2 ? "triangle" : "square";
      o.frequency.value = f;
      g.gain.setValueAtTime(gains[level] || 0.04, base + t);
      g.gain.exponentialRampToValueAtTime(0.0001, base + t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(base + t);
      o.stop(base + t + dur + 0.01);
      t += dur * 0.85;
    });
  }

  // ---------------------------------------------------------------- sync en vivo (websocket del server)

  // un solo <iframe-free> socket: la misma ruta /ws/market que usa la bolsa.
  // el server emite 'skins-update' dirigido a esta cuenta cuando el cash o el
  // inventario cambian EN CUALQUIER lado (bolsa, opencase, otra pestaña) — así
  // el monedero de acá nunca queda viejo y no hace falta recargar la página.
  let ws = null;
  let wsTimer = null;
  function connectLive() {
    if (typeof WebSocket === "undefined") return;
    try { if (ws) { ws.onclose = null; ws.close(); } } catch {}
    clearTimeout(wsTimer);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      // el token va en la cookie, no en la URL del handshake: prod.mjs escribe
  // requestUrl.search en el access log y la sesion acababa en disco.
  setMarketTokenCookie(session.token);
  ws = new WebSocket(`${proto}//${location.host}/ws/market`);
    } catch { scheduleReconnect(); return; }
    ws.onopen = () => {
      // el token por query autoriza en el upgrade; reforzamos por si acaso
      if (session.token) { try { ws.send(JSON.stringify({ type: "auth", token: session.token })); } catch {} }
    };
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "skins-update") {
        if (Number.isFinite(msg.cash)) session.cash = msg.cash;
        // el libro oficial se re-tira barato (throttle): cash + inventario + stats
        scheduleLiveRefresh();
        renderWallet();
        renderCases();
      } else if (msg.type === "portfolio-override" && msg.portfolio) {
        // el admin tocó la cuenta: adoptar el cash nuevo al toque
        if (Number.isFinite(msg.portfolio.cash)) session.cash = msg.portfolio.cash;
        scheduleLiveRefresh();
        renderWallet();
        renderCases();
      } else if (msg.type === "finance" && Array.isArray(msg.finance?.notices)) {
        for (const [name, entries] of msg.finance.notices) {
          if (name !== session.name || !Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (entry?.kind === "trade-update") {
              if (entry.action === "propose") {
                toast(`🔁 ${entry.by} te propuso un tradeo — mira la pestaña Tradeos`, "gold");
                playSfx("chain", 0.3);
              } else if (entry.action === "accept") {
                const got = (entry.items || []).join(", ") || "skins";
                toast(`✅ Tradeo aceptado por ${entry.by}: recibiste ${got}`, "up");
                playSfx("win", 0.4);
              } else if (entry.action === "decline") {
                toast(`❌ ${entry.by} rechazó tu tradeo`, "down");
              } else if (entry.action === "cancel") {
                toast(`↩️ ${entry.by} canceló su tradeo`, "down");
              }
            }
          }
        }
        scheduleLiveRefresh();
      }
    };
    ws.onclose = () => { ws = null; scheduleReconnect(); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function scheduleReconnect() {
    if (!signedIn()) return;
    clearTimeout(wsTimer);
    wsTimer = setTimeout(connectLive, 3000);
  }
  // máx 1 pull del libro por segundo aunque llovan pushes
  let liveRefreshTimer = null;
  function scheduleLiveRefresh() {
    if (liveRefreshTimer) return;
    liveRefreshTimer = setTimeout(async () => {
      liveRefreshTimer = null;
      if (!signedIn()) return;
      // con un giro en curso no se repinta el inventario: el item recién
      // concedido no debe asomar antes del revelado (el poll de 1s se
      // encarga de reconciliar apenas termine)
      if (spinning) return;
      try {
        const d = await api("/skins");
        inventory = d.inventory || [];
        session.cash = d.cash ?? session.cash;
        stats = d.stats || stats;
        tradesBook = d.trades || tradesBook;
        renderWallet(); renderInventory(); renderStats(); renderTrades();
      } catch {}
    }, 700);
  }

  // ---------------------------------------------------------------- tradeos de skins entre jugadores

  let tradesBook = { sent: [], received: [] };
  let tradePick = new Set(); // ids de skins seleccionadas para ofertar
  let tradeWants = [];       // nombres de skins pedidas

  function loadTrades() {
    if (!signedIn()) { tradesBook = { sent: [], received: [] }; renderTrades(); return; }
    api("/trades").then((d) => {
      tradesBook = { sent: d.sent || [], received: d.received || [] };
      renderTrades();
    }).catch(() => renderTrades());
  }

  // valor estimado de un item del catálogo: punto medio del rango de la caja
  // (el catálogo es la misma fuente que el server — sirve para balancear)
  const estValue = (() => {
    const cache = new Map();
    return (name) => {
      if (cache.has(name)) return cache.get(name);
      let v = 0;
      for (const c of Object.values(catalog.cases || {})) {
        for (const p of Object.values(c.pools || {})) {
          if ((p.items || []).includes(name)) {
            const [lo, hi] = p.mult;
            v = Math.round(c.cost * ((lo + hi) / 2));
            break;
          }
        }
        if (v) break;
      }
      cache.set(name, v);
      return v;
    };
  })();

  // jugadores conectados para el panel de tradeos: poll CADA 5s y sólo
  // mientras la pestaña está visible (sin cargar el server de peticiones)
  let onlinePlayers = [];
  let onlineTimer = null;
  async function refreshOnline() {
    if (!signedIn()) return;
    try {
      const d = await api("/players/online");
      onlinePlayers = (d.players || []).filter((p) => p.name !== session.name);
      const box = $("onlineBox");
      if (box) {
        box.innerHTML = onlinePlayers.length
          ? onlinePlayers.map((p) => `<button class="on-chip" data-on="${esc(p.name)}">🟢 ${esc(p.name)}</button>`).join("")
          : `<span class="hint">nadie más está conectado ahora</span>`;
        box.querySelectorAll("[data-on]").forEach((b) => b.addEventListener("click", () => {
          const inp = $("tradeTo");
          if (inp) { inp.value = b.dataset.on; inp.focus(); }
        }));
      }
      const dl = $("onlineList");
      if (dl) dl.innerHTML = onlinePlayers.map((p) => `<option value="${esc(p.name)}"></option>`).join("");
    } catch {}
  }
  function startOnlinePoll() {
    clearInterval(onlineTimer);
    refreshOnline();
    onlineTimer = setInterval(() => {
      const active = document.querySelector(".tab.is-active")?.dataset?.tab === "trades";
      if (!active) return; // fuera de la pestaña: cero peticiones
      refreshOnline();
    }, 5000);
  }

  function renderTrades() {
    const wrap = $("tradesWrap");
    if (!wrap) return;
    if (!signedIn()) {
      wrap.innerHTML = `<p class="hint">Inicia sesión para tradear skins con otros jugadores.</p>`;
      return;
    }
    const pendingIn = tradesBook.received.filter((t) => t.status === "pending");
    const giveTotal = inventory.filter((x) => tradePick.has(x.id)).reduce((s, x) => s + (x.value || 0), 0);
    const wantTotal = tradeWants.reduce((s, n) => s + estValue(n), 0);
    wrap.innerHTML = `
      <div class="trade-new">
        <h3>Nueva oferta</h3>
        <div class="online-row"><span class="on-label">Conectados:</span> <span id="onlineBox" class="online-box"><span class="hint">cargando…</span></span></div>
        <div class="trade-row">
          <input id="tradeTo" list="onlineList" placeholder="jugador (nombre exacto)">
          <datalist id="onlineList"></datalist>
          <input id="tradeNote" placeholder="nota (opcional)" maxlength="120">
        </div>
        <div class="trade-row">
          <button id="tradePickBtn" class="ghost">🎒 Elegir mis skins (${tradePick.size})</button>
          <button id="tradeWantBtn" class="ghost">🎯 Pedir skins (${tradeWants.length})</button>
          <button id="tradeSend" class="primary">Enviar oferta</button>
        </div>
        <p class="trade-balance mono">Das ≈ <b id="giveTotal">${money(giveTotal)}</b> · Pides ≈ <b id="wantTotal">${money(wantTotal)}</b>${giveTotal || wantTotal ? ` <span class="${giveTotal >= wantTotal ? "pos" : "neg"}">(${giveTotal - wantTotal >= 0 ? "+" : ""}${money(giveTotal - wantTotal)})</span>` : ""}</p>
        <div id="tradePickList" class="trade-picks ${tradePick.size ? "" : "is-empty"}"></div>
        <div id="tradeWantList" class="trade-picks ${tradeWants.length ? "" : "is-empty"}"></div>
      </div>
      <div class="trade-cols">
        <div class="trade-col">
          <h3>📥 Recibidas ${pendingIn.length ? `(${pendingIn.length} pendientes)` : ""}</h3>
          ${tradesBook.received.length ? tradesBook.received.map(tradeRow).join("") : `<p class="hint">Nadie te ha ofertado todavía.</p>`}
        </div>
        <div class="trade-col">
          <h3>📤 Enviadas</h3>
          ${tradesBook.sent.length ? tradesBook.sent.map(tradeRow).join("") : `<p class="hint">No has ofertado a nadie todavía.</p>`}
        </div>
      </div>`;
    bindTradeEvents();
    startOnlinePoll();
  }

  function refreshTradeTotals() {
    const wrap = $("tradesWrap");
    if (!wrap) return;
    const giveTotal = inventory.filter((x) => tradePick.has(x.id)).reduce((s, x) => s + (x.value || 0), 0);
    const wantTotal = tradeWants.reduce((s, n) => s + estValue(n), 0);
    const g = wrap.querySelector("#giveTotal");
    const w = wrap.querySelector("#wantTotal");
    if (g) g.textContent = money(giveTotal);
    if (w) w.textContent = money(wantTotal);
  }

  function tradeRow(t) {
    const isReceived = t.dir === "received";
    const other = isReceived ? t.fromName : t.toName;
    const give = (t.give || []).map((g) => `${g.item}${g.stattrak ? " ST™" : ""}`).join(", ") || "—";
    const want = (t.want || []).join(", ") || "—";
    const when = new Date(t.at).toLocaleString();
    const badge = {
      pending: "<span class='t-badge pend'>pendiente</span>",
      accepted: "<span class='t-badge ok'>aceptado</span>",
      declined: "<span class='t-badge no'>rechazado</span>",
      cancelled: "<span class='t-badge no'>cancelado</span>",
      expired: "<span class='t-badge no'>expirado</span>",
    }[t.status] || "";
    let actions = "";
    if (t.status === "pending") {
      if (isReceived) actions = `<button data-tacc="${esc(t.id)}" class="primary">Aceptar</button> <button data-tdec="${esc(t.id)}" class="ghost">Rechazar</button>`;
      else actions = `<button data-tcan="${esc(t.id)}" class="ghost">Cancelar</button>`;
    }
    return `
      <div class="trade-card ${t.status === "pending" ? "is-pending" : ""}">
        <div class="trade-who">${isReceived ? "De" : "Para"} <b>${esc(other)}</b> · ${esc(when)} ${badge}</div>
        <div class="trade-items">🎁 Da: <span>${esc(give)}</span></div>
        <div class="trade-items">🎯 Pide: <span>${esc(want)}</span></div>
        ${t.note ? `<div class="trade-note">“${esc(t.note)}”</div>` : ""}
        <div class="trade-actions">${actions}</div>
      </div>`;
  }

  function bindTradeEvents() {
    const wrap = $("tradesWrap");
    if (!wrap) return;
    wrap.querySelector("#tradeSend")?.addEventListener("click", async () => {
      const to = wrap.querySelector("#tradeTo").value.trim();
      const note = wrap.querySelector("#tradeNote").value.trim();
      if (!to) { toast("¿A quién le ofertas?", "down"); return; }
      if (!tradePick.size && !tradeWants.length) { toast("Elige skins tuyas o pide alguna", "down"); return; }
      try {
        const r = await api("/trades", { method: "POST", body: { action: "propose", to, give: [...tradePick], want: tradeWants, note } });
        toast(`Oferta enviada a ${r.to} 🔁`, "up");
        playSfx("chain", 0.3);
        tradePick.clear(); tradeWants = [];
        loadTrades();
      } catch (e) { toast(e.message, "down"); playSfx("lose", 0.3); }
    });
    wrap.querySelector("#tradePickBtn")?.addEventListener("click", () => renderTradePicker());
    wrap.querySelector("#tradeWantBtn")?.addEventListener("click", () => renderWantPicker());
    // aceptar en DOS pasos con espera de 3s: primer clic arma la confirmación
    // (cuenta atrás visible), a los 3s aparece "confirmar de nuevo" — sin
    // aceptaciones por error de dedo y tiempo de leer lo que vas a dar/recibir
    wrap.querySelectorAll("[data-tacc]").forEach((b) => {
      let armed = false;
      let t1 = null;
      let t2 = null;
      const original = b.textContent;
      const disarm = () => {
        armed = false;
        clearTimeout(t1); clearTimeout(t2);
        b.textContent = original;
        b.disabled = false;
      };
      b.addEventListener("click", async () => {
        if (!armed) {
          armed = true;
          let left = 3;
          b.disabled = true;
          b.textContent = `⏳ verificando… ${left}s`;
          t1 = setInterval(() => {
            left -= 1;
            if (left > 0) b.textContent = `⏳ verificando… ${left}s`;
          }, 1000);
          t2 = setTimeout(() => {
            clearInterval(t1);
            b.textContent = "✔ Confirmar de nuevo";
            b.disabled = false;
            // si no confirma en 10s, se desarma solo
            setTimeout(disarm, 10000);
          }, 3000);
          return;
        }
        disarm();
        try {
          const r = await api("/trades", { method: "POST", body: { action: "accept", tradeId: b.dataset.tacc } });
          const got = (r.received || []).map((x) => x.item).join(", ") || "skins";
          toast(`Intercambio hecho: recibiste ${got} ✅`, "up");
          playSfx("win", 0.45);
          await refreshServer().catch(() => {});
          loadTrades();
        } catch (e) { toast(e.message, "down"); playSfx("lose", 0.3); loadTrades(); }
      });
    });
    wrap.querySelectorAll("[data-tdec]").forEach((b) => b.addEventListener("click", async () => {
      try { await api("/trades", { method: "POST", body: { action: "decline", tradeId: b.dataset.tdec } }); toast("Oferta rechazada", "down"); playSfx("low", 0.25); loadTrades(); }
      catch (e) { toast(e.message, "down"); }
    }));
    wrap.querySelectorAll("[data-tcan]").forEach((b) => b.addEventListener("click", async () => {
      try { await api("/trades", { method: "POST", body: { action: "cancel", tradeId: b.dataset.tcan } }); toast("Oferta cancelada", "down"); loadTrades(); }
      catch (e) { toast(e.message, "down"); }
    }));
  }

  // picker de MIS skins para dar
  function renderTradePicker() {
    const wrap = $("tradesWrap");
    if (!wrap) return;
    const box = wrap.querySelector("#tradePickList");
    if (!box) return;
    if (!inventory.length) { box.innerHTML = `<p class="hint">Tu inventario está vacío — abre cajas primero.</p>`; return; }
    box.classList.remove("is-empty");
    box.innerHTML = inventory.map((it) => `
      <button class="tp-item ${tradePick.has(it.id) ? "is-picked" : ""}" data-tp="${esc(it.id)}">
        <span class="tp-art">${artHtml(it)}</span>
        <span class="tp-name">${esc(it.item)}${it.stattrak ? " ST™" : ""}</span>
        <span class="tp-val mono">${money(it.value)}</span>
      </button>`).join("");
    box.querySelectorAll("[data-tp]").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.tp;
      if (tradePick.has(id)) tradePick.delete(id); else tradePick.add(id);
      b.classList.toggle("is-picked");
      const btn = wrap.querySelector("#tradePickBtn");
      if (btn) btn.textContent = `🎒 Elegir mis skins (${tradePick.size})`;
      refreshTradeTotals();
    }));
  }

  // picker de skins del CATÁLOGO para pedir (por nombre, con foto real)
  function renderWantPicker() {
    const wrap = $("tradesWrap");
    if (!wrap) return;
    const box = wrap.querySelector("#tradeWantList");
    if (!box) return;
    const names = new Set();
    Object.values(catalog.cases || {}).forEach((c) => Object.values(c.pools || {}).forEach((p) => (p.items || []).forEach((n) => names.add(n))));
    const sorted = [...names].sort();
    box.classList.remove("is-empty");
    box.innerHTML = `
      <input id="wantSearch" placeholder="buscar skin…" style="width:100%">
      <div class="tp-grid" id="wantGrid"></div>`;
    const grid = box.querySelector("#wantGrid");
    const paint = (q) => {
      const list = sorted.filter((n) => !q || n.toLowerCase().includes(q));
      grid.innerHTML = list.map((n) => `
        <button class="tp-item ${tradeWants.includes(n) ? "is-picked" : ""}" data-want="${esc(n)}">
          <span class="tp-art">${artHtml({ item: n })}</span>
          <span class="tp-name">${esc(n)}</span>
        </button>`).join("") || `<p class="hint">nada matchea</p>`;
      grid.querySelectorAll("[data-want]").forEach((b) => b.addEventListener("click", () => {
        const n = b.dataset.want;
        if (tradeWants.includes(n)) tradeWants = tradeWants.filter((x) => x !== n); else tradeWants.push(n);
        b.classList.toggle("is-picked");
        const btn = wrap.querySelector("#tradeWantBtn");
        if (btn) btn.textContent = `🎯 Pedir skins (${tradeWants.length})`;
        refreshTradeTotals();
      }));
    };
    paint("");
    box.querySelector("#wantSearch").addEventListener("input", (e) => paint(e.target.value.trim().toLowerCase()));
  }

  // ---------------------------------------------------------------- puente de congruencia (poll cada 1s)

  // el WS empuja los cambios al momento; este releo cada SEGUNDO es la red
  // de seguridad que el usuario pidió: el saldo de la bolsa y el de opencase
  // se verifican entre sí cada segundo y se corrigen solos. barato: es una
  // lectura del portfolio de esta cuenta, pausada si la pestaña está oculta
  // o hay un giro en curso.
  let pollTimer = null;
  const invSig = (inv) => `${inv.length}:${inv.reduce((s, x) => s + (x.value || 0), 0)}:${inv.length ? inv[inv.length - 1].id : ""}`;
  let lastInvSig = "";
  function startPollBridge() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!signedIn() || spinning || document.hidden) return;
      try {
        const d = await api("/skins");
        session.cash = d.cash ?? session.cash;
        tradesBook = d.trades || tradesBook;
        const nextInv = d.inventory || [];
        const sig = invSig(nextInv);
        const changed = sig !== lastInvSig;
        lastInvSig = sig;
        if (changed) {
          inventory = nextInv;
          stats = d.stats || stats;
          renderWallet(); renderInventory(); renderCases(); renderStats();
        } else {
          renderWallet();
        }
      } catch {}
    }, 1000);
  }

  async function openBank() {
    if (!signedIn()) { toast("Inicia sesión para usar el banco compartido", "down"); return; }
    $("bankOverlay").classList.add("is-visible");
    $("bankBody").innerHTML = `<p class="hint">Cargando…</p>`;
    try {
      renderBank(await api("/bank"));
    } catch (e) {
      $("bankBody").innerHTML = `<p class="auth-error">${esc(e.message)}</p>`;
    }
  }

  function renderBank(d) {
    const bank = d.bank || { balance: 0, loan: 0, loanDaysLeft: 0 };
    $("bankBody").innerHTML = `
      <div class="bank-cards">
        <div class="bank-card"><span>efectivo</span><strong class="mono">${money(d.cash)}</strong></div>
        <div class="bank-card"><span>en el banco</span><strong class="mono">${money(bank.balance)}</strong></div>
      </div>
      ${bank.loan > 0 ? `
        <div class="bank-cards">
          <div class="bank-card"><span>préstamo pendiente</span><strong class="mono neg">${money(bank.loan)}</strong></div>
          <div class="bank-card"><span>días para pagar</span><strong class="mono">${bank.loanDaysLeft}</strong></div>
        </div>` : ""}
      <div class="bank-actions">
        <div class="bank-row">
          <input id="bkAmt" type="number" min="1" value="5000">
          <button id="bkDep" class="primary">Depositar</button>
          <button id="bkWith">Retirar</button>
        </div>
        <p class="bank-note">Interés ${(Number(d.rates && d.rates.savings || 0) * 100).toFixed(2)}%/día.
          Este es el banco de tu cuenta de bolsa: deposita para ahorrar, retira para abrir cajas.
          El saldo es el mismo en ambos juegos.</p>
        <button id="bkToBolsa" class="ghost">📈 Volver a la bolsa con este dinero</button>
      </div>`;
    $("bkDep").onclick = () => bankPost("deposit");
    $("bkWith").onclick = () => bankPost("withdraw");
    $("bkToBolsa").onclick = () => { window.location.href = "/owngames/bolsa-trading-floor/"; };
  }

  async function bankPost(action) {
    const amount = Math.floor(Number($("bkAmt").value) || 0);
    if (amount <= 0) return;
    try {
      const r = await api("/bank", { method: "POST", body: { action, amount } });
      session.cash = r.cash;
      renderWallet();
      playSfx("chain", 0.3);
      toast(r.note || (action === "deposit" ? `Depositaste ${money(amount)}` : `Retiraste ${money(amount)}`), "gold");
      openBank(); // repinta con datos frescos
    } catch (e) {
      toast(e.message, "down");
    }
  }

  // ---------------------------------------------------------------- toast

  let toastTimer = null;
  function toast(msg, kind = "") {
    const el = $("toast");
    el.textContent = msg;
    el.className = `toast is-visible ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), 3400);
  }

  // ---------------------------------------------------------------- eventos estáticos

  function bindStatic() {
    $("gateLogin").onclick = openAuth;
    $("gateGuest").onclick = () => {
      try { localStorage.setItem(GUEST_KEY, "1"); } catch {}
      session.guest = true;
      session.sso = false;
      session.name = "invitado";
      session.cash = guestCash();
      enterApp();
    };
    $("openBankBtn").onclick = openBank;
    const topLogin = $("topLoginBtn");
    if (topLogin) topLogin.onclick = () => { openAuth(); };
    $("bankClose").onclick = () => $("bankOverlay").classList.remove("is-visible");
    $("authClose").onclick = () => $("authOverlay").classList.remove("is-visible");
    $("authModeToggle").onclick = () => {
      authIsRegister = !authIsRegister;
      $("authTitle").textContent = authIsRegister ? "Crear cuenta" : "Iniciar sesión";
      $("authSubmit").textContent = authIsRegister ? "Crear" : "Entrar";
      $("authModeToggle").textContent = authIsRegister
        ? "Ya tengo cuenta — iniciar sesión"
        : "No tengo cuenta — registrarme";
      $("authError").textContent = "";
    };
    $("authSubmit").onclick = doAuth;
    $("authPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doAuth(); });
    $("sellAllBtn").onclick = sellAll;
    const backBtn = $("rouletteBack");
    if (backBtn) backBtn.onclick = () => { if (!spinning) closeResult(); };
    document.querySelectorAll(".tab").forEach((t) => {
      t.onclick = () => {
        document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("is-active", x === t));
        document.querySelectorAll(".tabview").forEach((v) => v.classList.toggle("is-active", v.id === `tab-${t.dataset.tab}`));
        if (t.dataset.tab === "inventory") renderInventory();
        if (t.dataset.tab === "stats") renderStats();
        if (t.dataset.tab === "trades") { loadTrades(); renderTrades(); }
      };
    });
  }

  boot();
})();
