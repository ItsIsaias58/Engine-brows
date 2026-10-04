// el casino, mitad cliente de services/market/casino.mjs. con sesión cada
// apuesta es un POST /api/market/casino y el server decide todo; invitado, las
// mismas reglas corren aquí sobre state.casino y state.cash. los sonidos son
// de js/sound.js: la ruleta suena a ruleta (tics que frenan), las tragamonedas
// a palanca con tambor, y ganar suena según el tamaño del premio.
const Casino = {
  open: false,
  tab: 'menu',
  spinning: false,
  busy: false,
  lastBet: 500,
  limits: { min: 10, max: 1e7 },

  // ------------------------------------------------------------ lifecycle

  show(tab = 'menu') {
    this.tab = tab;
    const overlay = document.getElementById('casinoOverlay') || this.build();
    overlay.classList.add('is-visible');
    this.open = true;
    this.refreshLimits();
    this.render();
    if (typeof Sound !== 'undefined') Sound.play('notify');
  },

  hide() {
    const overlay = document.getElementById('casinoOverlay');
    if (overlay) overlay.classList.remove('is-visible');
    this.open = false;
  },

  toggle(tab) {
    this.open ? this.hide() : this.show(tab);
  },

  build() {
    const el = document.createElement('div');
    el.id = 'casinoOverlay';
    el.className = 'casino-overlay';
    el.innerHTML = `
      <div class="casino-panel">
        <header class="casino-head">
          <h2>🎲 Casino del piso</h2>
          <div class="casino-cash mono" id="casinoCash">—</div>
          <button class="scrub-btn" id="casinoClose" title="Cerrar (Esc)">✕</button>
        </header>
        <div class="casino-body" id="casinoBody"></div>
      </div>`;
    document.body.appendChild(el);
    el.querySelector('#casinoClose').addEventListener('click', () => this.hide());
    el.addEventListener('click', (e) => { if (e.target === el) this.hide(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.open) this.hide();
    });
    return el;
  },

  async refreshLimits() {
    if (typeof MarketNet !== 'undefined' && MarketNet.signedIn) {
      try {
        const data = await MarketNet.request('/api/market/casino');
        if (data?.limits) this.limits = data.limits;
        if (data?.casino && !data.casino.bj) state.casino = data.casino;
      } catch (e) { /* offline: los límites por defecto mandan */ }
    }
  },

  // ---------------------------------------------------------------- helpers

  cash() { return Number(state.cash) || 0; },

  canAfford(bet) { return bet >= this.limits.min && bet <= this.cash() + 0.001; },

  setBet(v) {
    this.lastBet = Math.max(this.limits.min, Math.floor(Number(v) || this.limits.min));
  },

  applyCash(cash) {
    if (Number.isFinite(cash)) { state.cash = cash; if (typeof updateHud === 'function') updateHud(); }
  },

  // dice al jugador por qué no puede apostar eso
  betError(bet) {
    if (!Number.isFinite(bet) || bet < this.limits.min) return `apuesta mínima ${money(this.limits.min)}`;
    if (bet > this.cash() + 0.001) return 'no tienes ese efectivo';
    return null;
  },

  // ------------------------------------------------------------- servidor

  async act(action, body = {}) {
    if (typeof MarketNet !== 'undefined' && MarketNet.signedIn) {
      const data = await MarketNet.request('/api/market/casino', {
        method: 'POST',
        body: JSON.stringify({ action, ...body }),
      });
      if (data?.ok) {
        this.applyCash(data.cash);
        if (data.hand) state.casino.bj = data.hand;
        else if (action === 'bj_resolve') state.casino.bj = data.hand || null;
        if (data.casino?.stats) state.casino.stats = data.casino.stats;
      }
      return data;
    }
    // invitado: las mismas reglas del server, corriendo aquí (casino.mjs es la
    // referencia; esto replica deal/hit/stand/slots/roulette sin el HTTP)
    return this.localAction(action, body);
  },

  localAction(action, body) {
    const book = state.casino || (state.casino = { bj: null, stats: { rounds: 0, wagered: 0, won: 0 } });
    const bet = Math.floor(Number(body.amount));
    const spend = (n) => { state.cash -= n; };
    const pay = (n) => { state.cash += n; };
    const stat = (b, r) => { book.stats.rounds += 1; book.stats.wagered += b; book.stats.won += r; };
    const xp = (b) => { state.xp += Math.max(1, Math.round(b / 60)); };

    if (action === 'bj_deal') {
      if (book.bj && !book.bj.done) return { ok: false, error: 'termina la mano en curso' };
      const err = this.betError(bet);
      if (err) return { ok: false, error: err };
      const card = () => ({ r: 1 + Math.floor(Math.random() * 13), s: Math.floor(Math.random() * 4) });
      const val = (cards) => {
        let t = 0, a = 0;
        for (const c of cards) { t += c.r === 1 ? 11 : Math.min(c.r, 10); if (c.r === 1) a += 1; }
        while (t > 21 && a > 0) { t -= 10; a -= 1; }
        return t;
      };
      const player = [card(), card()];
      const dealer = [card(), card()];
      spend(bet); xp(bet);
      if (val(player) === 21) {
        const push = val(dealer) === 21;
        const ret = push ? bet : Math.round(bet * 2.5);
        pay(ret); stat(bet, ret);
        book.bj = { bet, player, dealer, done: true, result: push ? 'push' : 'blackjack' };
        return { ok: true, action: 'bj_resolve', hand: book.bj, returned: ret, bet, result: book.bj.result, cash: state.cash };
      }
      book.bj = { bet, player, dealer, done: false };
      return { ok: true, action, hand: this.publicHand(book.bj), cash: state.cash };
    }

    if (action === 'bj_hit' || action === 'bj_stand') {
      const hand = book.bj;
      if (!hand || hand.done) return { ok: false, error: 'no hay mano activa: reparte primero' };
      const val = (cards) => {
        let t = 0, a = 0;
        for (const c of cards) { t += c.r === 1 ? 11 : Math.min(c.r, 10); if (c.r === 1) a += 1; }
        while (t > 21 && a > 0) { t -= 10; a -= 1; }
        return t;
      };
      if (action === 'bj_hit') {
        const c = { r: 1 + Math.floor(Math.random() * 13), s: Math.floor(Math.random() * 4) };
        hand.player.push(c);
        const t = val(hand.player);
        if (t > 21) {
          stat(hand.bet, 0);
          hand.done = true; hand.result = 'bust';
          return { ok: true, action: 'bj_resolve', hand, player: hand.player, dealer: hand.dealer, returned: 0, bet: hand.bet, result: 'bust', cash: state.cash };
        }
        return { ok: true, action, hand: this.publicHand(hand), cash: state.cash };
      }
      while (val(hand.dealer) < 17) hand.dealer.push({ r: 1 + Math.floor(Math.random() * 13), s: Math.floor(Math.random() * 4) });
      const p = val(hand.player), d = val(hand.dealer);
      let ret = 0, result;
      if (d > 21 || p > d) { ret = hand.bet * 2; result = 'win'; }
      else if (p === d) { ret = hand.bet; result = 'push'; }
      else result = 'lose';
      pay(ret); stat(hand.bet, ret);
      hand.done = true; hand.result = result;
      return { ok: true, action: 'bj_resolve', hand, player: hand.player, dealer: hand.dealer, returned: ret, bet: hand.bet, result, cash: state.cash };
    }

    if (action === 'slots') {
      if (book.bj && !book.bj.done) return { ok: false, error: 'termina la mano de blackjack primero' };
      const err = this.betError(bet);
      if (err) return { ok: false, error: err };
      const reels = ['🍒', '🔔', '⭐', '💎', '7'];
      const weights = [32, 26, 18, 10, 4];
      const pays = { '🍒': 4, '🔔': 6, '⭐': 10, '💎': 20, '7': 60 };
      const pick = () => {
        let r = Math.random() * weights.reduce((s, w) => s + w, 0);
        for (let i = 0; i < reels.length; i += 1) { r -= weights[i]; if (r <= 0) return reels[i]; }
        return reels[reels.length - 1];
      };
      const out = [pick(), pick(), pick()];
      let mult = 0;
      if (out[0] === out[1] && out[1] === out[2]) mult = pays[out[0]];
      else if (out[0] === out[1] || out[1] === out[2] || out[0] === out[2]) mult = 1;
      const ret = bet * mult;
      spend(bet); pay(ret); stat(bet, ret); xp(bet);
      if (typeof updateHud === 'function') updateHud();
      return { ok: true, action, reels: out, mult, returned: ret, net: ret - bet, result: mult >= 10 ? 'jackpot' : mult > 1 ? 'win' : mult === 1 ? 'push' : 'lose', cash: state.cash };
    }

    if (action === 'roulette') {
      if (book.bj && !book.bj.done) return { ok: false, error: 'termina la mano de blackjack primero' };
      const pickStr = String(body.pick || '').trim().toLowerCase();
      const REDS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
      let kind = null, paysR = 0, dozen = null, n0 = -1;
      if (['red', 'black', 'even', 'odd', 'low', 'high'].includes(pickStr)) { kind = pickStr; paysR = 2; }
      else if (/^(1-12|13-24|25-36)$/.test(pickStr)) { kind = 'dozen'; paysR = 3; dozen = pickStr; }
      else if (/^\d+$/.test(pickStr) && Number(pickStr) >= 0 && Number(pickStr) <= 36) { kind = 'number'; paysR = 36; n0 = Number(pickStr); }
      if (!kind) return { ok: false, error: 'apuesta inválida' };
      const err = this.betError(bet);
      if (err) return { ok: false, error: err };
      const n = Math.floor(Math.random() * 37);
      const red = n !== 0 && REDS.has(n);
      const color = n === 0 ? 'green' : red ? 'red' : 'black';
      let won = false;
      if (kind === 'number') won = n === n0;
      else if (kind === 'red') won = red;
      else if (kind === 'black') won = n !== 0 && !red;
      else if (kind === 'even') won = n !== 0 && n % 2 === 0;
      else if (kind === 'odd') won = n % 2 === 1;
      else if (kind === 'low') won = n >= 1 && n <= 18;
      else if (kind === 'high') won = n >= 19;
      else if (kind === 'dozen') won = n !== 0 && (n <= 12 ? '1-12' : n <= 24 ? '13-24' : '25-36') === dozen;
      const ret = won ? bet * paysR : 0;
      spend(bet); pay(ret); stat(bet, ret); xp(bet);
      if (typeof updateHud === 'function') updateHud();
      return { ok: true, action, number: n, color, won, returned: ret, net: ret - bet, result: won ? (paysR >= 36 ? 'jackpot' : 'win') : 'lose', cash: state.cash };
    }

    return { ok: false, error: 'acción desconocida' };
  },

  publicHand(hand) {
    const hide = !hand.done && hand.dealer.length >= 2;
    const val = (cards) => {
      let t = 0, a = 0;
      for (const c of cards) { t += c.r === 1 ? 11 : Math.min(c.r, 10); if (c.r === 1) a += 1; }
      while (t > 21 && a > 0) { t -= 10; a -= 1; }
      return t;
    };
    return {
      bet: hand.bet,
      player: hand.player,
      playerTotal: val(hand.player),
      dealer: hide ? [hand.dealer[0], { hidden: true }] : hand.dealer,
      dealerTotal: hide ? (hand.dealer[0].r === 1 ? 11 : Math.min(hand.dealer[0].r, 10)) : val(hand.dealer),
      done: !!hand.done,
      result: hand.result || null,
    };
  },

  // ---------------------------------------------------------------- render

  render() {
    const body = document.getElementById('casinoBody');
    if (!body) return;
    const cashEl = document.getElementById('casinoCash');
    if (cashEl) cashEl.textContent = money(this.cash());

    if (this.tab === 'menu') return this.renderMenu(body);
    if (this.tab === 'bj') return this.renderBlackjack(body);
    if (this.tab === 'slots') return this.renderSlots(body);
    if (this.tab === 'roulette') return this.renderRoulette(body);
  },

  renderMenu(body) {
    const s = state.casino?.stats || { rounds: 0, wagered: 0, won: 0 };
    body.innerHTML = `
      <p class="casino-intro">La casa donde el cash sobrante se quema con dignidad.
        Cada apuesta se liquida en el servidor: ni un peso se mueve por confianza en tu navegador.</p>
      <div class="casino-grid">
        <button class="casino-card" data-game="bj">
          <span class="casino-card-icon">🃏</span>
          <strong>Blackjack</strong>
          <em>3:2 en natural · dealer planta en 17</em>
        </button>
        <button class="casino-card" data-game="slots">
          <span class="casino-card-icon">🎰</span>
          <strong>Tragamonedas</strong>
          <em>par devuelve · trio paga hasta ×60</em>
        </button>
        <button class="casino-card" data-game="roulette">
          <span class="casino-card-icon">🎡</span>
          <strong>Ruleta</strong>
          <em>europea · pleno paga 36:1</em>
        </button>
      </div>
      <div class="casino-stats mono">
        rondas ${s.rounds} · apostado ${money(s.wagered)} · recuperado ${money(s.won)}
        ${s.wagered > 0 ? `· balance <span class="${s.won - s.wagered >= 0 ? 'pos' : 'neg'}">${money(s.won - s.wagered)}</span>` : ''}
      </div>`;
    body.querySelectorAll('[data-game]').forEach((btn) => {
      btn.addEventListener('click', () => { this.tab = btn.dataset.game; Sound.play('click'); this.render(); });
    });
  },

  // barra común de apuesta
  betBarHtml() {
    return `
      <div class="casino-betbar">
        <label class="casino-field">Apuesta
          <input id="casinoBet" type="number" min="${this.limits.min}" step="10" value="${this.lastBet}">
        </label>
        <div class="casino-quick">
          <button data-betpct="0.1">10%</button>
          <button data-betpct="0.25">25%</button>
          <button data-betpct="0.5">50%</button>
          <button data-betpct="1">TODO</button>
        </div>
      </div>`;
  },

  bindBetBar(body) {
    body.querySelectorAll('[data-betpct]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const input = body.querySelector('#casinoBet');
        if (!input) return;
        input.value = String(Math.max(this.limits.min, Math.floor(this.cash() * parseFloat(btn.dataset.betpct))));
        input.dispatchEvent(new Event('input'));
      });
    });
    const input = body.querySelector('#casinoBet');
    if (input) input.addEventListener('input', () => { this.setBet(input.value); });
  },

  betFrom(body) {
    const v = parseFloat(body.querySelector('#casinoBet')?.value);
    return Number.isFinite(v) ? v : undefined;
  },

  // -------------------------------------------------------------- blackjack

  renderBlackjack(body) {
    const hand = state.casino?.bj;
    const active = hand && !hand.done;
    const cardHtml = (c) => c?.hidden
      ? '<span class="casino-card-back">🂠</span>'
      : `<span class="casino-card-face ${c.s === 1 || c.s === 2 ? 'is-red' : ''}">${this.cardLabel(c)}</span>`;
    body.innerHTML = `
      <button class="casino-back" data-back="menu">← volver</button>
      ${this.betBarHtml()}
      ${hand ? `
        <div class="casino-table">
          <div class="casino-handrow">
            <span class="casino-handlabel">Dealer ${hand.done ? `· ${this.handText(hand.dealer)}` : ''}</span>
            <div class="casino-hand">${hand.dealer.map(cardHtml).join('')}</div>
          </div>
          <div class="casino-handrow">
            <span class="casino-handlabel">Tú · ${this.handText(hand.player)}</span>
            <div class="casino-hand">${hand.player.map(cardHtml).join('')}</div>
          </div>
        </div>
        <div class="casino-actions">
          ${active
            ? `<button class="nav-modal-btn" data-bj="hit">Pedir carta</button>
               <button class="nav-modal-btn" data-bj="stand">Plantarse</button>`
            : `<button class="nav-modal-btn" data-bj="deal">Repartir</button>`}
        </div>
        ${hand.done ? this.resultLine(this.lastResult) : ''}
      ` : `
        <div class="casino-actions"><button class="nav-modal-btn" data-bj="deal">🃏 Repartir primera mano</button></div>
      `}`;
    this.bindBetBar(body);
    const back = body.querySelector('[data-back]');
    if (back) back.addEventListener('click', () => { this.tab = 'menu'; this.render(); });
    body.querySelectorAll('[data-bj]').forEach((btn) => {
      btn.addEventListener('click', () => this.blackjackMove(btn.dataset.bj, body));
    });
  },

  cardLabel(c) {
    if (!c || c.hidden) return '🂠';
    const face = c.r === 1 ? 'A' : c.r === 11 ? 'J' : c.r === 12 ? 'Q' : c.r === 13 ? 'K' : String(c.r);
    const suits = ['♠', '♥', '♦', '♣'];
    return face + (suits[c.s] || '');
  },

  handText(cards) {
    let t = 0, a = 0;
    for (const c of cards) { if (c.hidden) continue; t += c.r === 1 ? 11 : Math.min(c.r, 10); if (c.r === 1) a += 1; }
    while (t > 21 && a > 0) { t -= 10; a -= 1; }
    return `${t}`;
  },

  async blackjackMove(move, body) {
    if (this.busy) return;
    if (move === 'deal') {
      const bet = this.betFrom(body);
      const err = this.betError(bet);
      if (err) { toast('Casino', err, 'down'); Sound.play('error'); return; }
      this.busy = true;
      const res = await this.act('bj_deal', { amount: bet });
      this.busy = false;
      if (!res?.ok) { toast('Casino', res?.error || 'no se pudo repartir', 'down'); Sound.play('error'); return; }
      // el reparto: dos cartas sobre la mesa
      Sound.play('card');
      this.lastResult = res.result ? res : null;
      this.setBet(bet);
      this.render();
      if (res.result) this.blackjackFinished(res);
      return;
    }
    this.busy = true;
    const res = await this.act(move === 'hit' ? 'bj_hit' : 'bj_stand', {});
    this.busy = false;
    if (!res?.ok) { toast('Casino', res?.error || 'movimiento inválido', 'down'); Sound.play('error'); return; }
    if (res.hand && !res.hand.done) { Sound.play('card'); this.render(); return; }
    this.lastResult = res;
    this.render();
    this.blackjackFinished(res);
  },

  blackjackFinished(res) {
    const net = (res.returned || 0) - (res.bet || 0);
    if (res.result === 'blackjack' || res.result === 'win') {
      Sound.play('win', { rarity: net > res.bet * 1 ? 'raro' : 'común' });
      toast('🃏 Blackjack', `ganaste ${money(net)}`, 'up');
      pushNotification('🃏 Blackjack', `mano ganada: +${money(net)}`, 'up');
    } else if (res.result === 'push') {
      Sound.play('notify');
      toast('🃏 Blackjack', 'empate: apuesta devuelta', 'gold');
    } else {
      Sound.play('loss');
      toast('🃏 Blackjack', `perdiste ${money(Math.abs(net))}`, 'down');
    }
    this.render();
  },

  resultLine(res) {
    if (!res) return '';
    const net = (res.returned || 0) - (res.bet || 0);
    const cls = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
    return `<div class="casino-result mono ${cls}">resultado: ${res.result} · ${net >= 0 ? '+' : ''}${money(net)}</div>`;
  },

  // ----------------------------------------------------------------- slots

  renderSlots(body) {
    body.innerHTML = `
      <button class="casino-back" data-back="menu">← volver</button>
      ${this.betBarHtml()}
      <div class="casino-slots" id="slotsReels">
        <span class="casino-reel">❔</span>
        <span class="casino-reel">❔</span>
        <span class="casino-reel">❔</span>
      </div>
      <div class="casino-actions">
        <button class="nav-modal-btn" id="slotsSpin">🎰 Girar</button>
      </div>
      <p class="casino-hint">Par de símbolos devuelve la apuesta · trío: 🍒×4 🔔×6 ⭐×10 💎×20 7×60</p>`;
    this.bindBetBar(body);
    const back = body.querySelector('[data-back]');
    if (back) back.addEventListener('click', () => { this.tab = 'menu'; this.render(); });
    body.querySelector('#slotsSpin')?.addEventListener('click', () => this.spinSlots(body));
  },

  async spinSlots(body) {
    if (this.spinning || this.busy) return;
    const bet = this.betFrom(body);
    const err = this.betError(bet);
    if (err) { toast('Casino', err, 'down'); Sound.play('error'); return; }
    this.spinning = true; this.busy = true;
    this.setBet(bet);
    const btn = body.querySelector('#slotsSpin');
    if (btn) btn.disabled = true;
    Sound.play('spinStart');
    // los tambores giran en el cliente mientras el server decide: la animación
    // corre su duración fija, el resultado llega cuando llega
    const reelsEl = body.querySelector('#slotsReels');
    const symbols = ['🍒', '🔔', '⭐', '💎', '7'];
    const animStart = Date.now();
    let frame = 0;
    const anim = setInterval(() => {
      if (!reelsEl) return;
      frame += 1;
      reelsEl.querySelectorAll('.casino-reel').forEach((el, i) => {
        if (frame > 18 + i * 8) return; // cada tambor se frena en su turno
        el.textContent = symbols[Math.floor(Math.random() * symbols.length)];
        el.classList.toggle('is-spinning', frame <= 18 + i * 8);
      });
    }, 70);
    const res = await this.act('slots', { amount: bet });
    // la animación dura ~2.4s; esperamos al menos eso antes de revelar
    await new Promise((r) => setTimeout(r, Math.max(0, 2400 - (Date.now() - animStart))));
    clearInterval(anim);
    this.spinning = false; this.busy = false;
    if (btn) btn.disabled = false;
    if (!res?.ok) {
      if (reelsEl) reelsEl.querySelectorAll('.casino-reel').forEach((el) => { el.textContent = '❔'; });
      toast('Casino', res?.error || 'no se pudo girar', 'down');
      this.render();
      return;
    }
    if (reelsEl) {
      reelsEl.querySelectorAll('.casino-reel').forEach((el, i) => {
        el.textContent = res.reels[i];
        el.classList.remove('is-spinning');
      });
    }
    this.slotsFinished(res);
    this.render();
  },

  slotsFinished(res) {
    if (res.result === 'jackpot') {
      Sound.play('jackpot');
      toast('🎰 ¡JACKPOT!', `${res.reels.join(' ')} · +${money(res.net)}`, 'up');
      pushNotification('🎰 Jackpot', `trío de ${res.reels[0]}: +${money(res.net)}`, 'up');
    } else if (res.result === 'win') {
      Sound.play('win', { rarity: 'raro' });
      toast('🎰 Tragamonedas', `${res.reels.join(' ')} · +${money(res.net)}`, 'up');
    } else if (res.result === 'push') {
      Sound.play('notify');
      toast('🎰 Tragamonedas', `par: apuesta devuelta (${res.reels.join(' ')})`, 'gold');
    } else {
      Sound.play('loss');
      toast('🎰 Tragamonedas', `sin premio · −${money(res.net)}`, 'down');
    }
  },

  // -------------------------------------------------------------- roulette

  renderRoulette(body) {
    const REDS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
    body.innerHTML = `
      <button class="casino-back" data-back="menu">← volver</button>
      ${this.betBarHtml()}
      <div class="casino-wheelwrap">
        <div class="casino-wheel" id="casinoWheel">
          <span class="casino-wheel-num mono" id="wheelNum">—</span>
          <span class="casino-wheel-color" id="wheelColor"></span>
        </div>
        <div class="casino-actions">
          <button class="nav-modal-btn" id="rouletteSpin">🎡 Girar</button>
        </div>
      </div>
      <div class="casino-bets">
        <button data-pick="red" class="casino-chip is-red">Rojo</button>
        <button data-pick="black" class="casino-chip is-black">Negro</button>
        <button data-pick="even" class="casino-chip">Par</button>
        <button data-pick="odd" class="casino-chip">Impar</button>
        <button data-pick="low" class="casino-chip">1–18</button>
        <button data-pick="high" class="casino-chip">19–36</button>
        <button data-pick="1-12" class="casino-chip">1ª decena</button>
        <button data-pick="13-24" class="casino-chip">2ª decena</button>
        <button data-pick="25-36" class="casino-chip">3ª decena</button>
      </div>
      <label class="casino-field">Pleno (0–36, paga 36:1)
        <input id="rouletteNum" type="number" min="0" max="36" step="1" placeholder="ej. 17">
      </label>
      <p class="casino-hint">Rojo: ${REDS.join(', ')}</p>`;
    this.bindBetBar(body);
    const back = body.querySelector('[data-back]');
    if (back) back.addEventListener('click', () => { this.tab = 'menu'; this.render(); });
    let pick = 'red';
    body.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        pick = btn.dataset.pick;
        body.querySelectorAll('[data-pick]').forEach((b) => b.classList.toggle('is-active', b === btn));
        Sound.play('click');
      });
    });
    body.querySelector('[data-pick="red"]')?.classList.add('is-active');
    body.querySelector('#rouletteSpin')?.addEventListener('click', () => {
      const numVal = body.querySelector('#rouletteNum')?.value;
      this.spinRoulette(body, numVal !== '' && numVal !== undefined ? String(Number(numVal)) : pick);
    });
  },

  async spinRoulette(body, pick) {
    if (this.spinning || this.busy) return;
    const bet = this.betFrom(body);
    const err = this.betError(bet);
    if (err) { toast('Casino', err, 'down'); Sound.play('loss'); return; }
    this.spinning = true; this.busy = true;
    this.setBet(bet);
    const btn = body.querySelector('#rouletteSpin');
    if (btn) btn.disabled = true;
    Sound.spin(1900, 30); // tics que frenan: la rueda de verdad
    const res = await this.act('roulette', { amount: bet, pick });
    await new Promise((r) => setTimeout(r, 2000));
    this.spinning = false; this.busy = false;
    if (btn) btn.disabled = false;
    if (!res?.ok) { toast('Casino', res?.error || 'no se pudo girar', 'down'); this.render(); return; }
    const numEl = document.getElementById('wheelNum');
    const colorEl = document.getElementById('wheelColor');
    if (numEl) numEl.textContent = String(res.number);
    if (colorEl) colorEl.className = `casino-wheel-color is-${res.color}`;
    this.rouletteFinished(res);
    this.render();
  },

  rouletteFinished(res) {
    if (res.won && res.result === 'jackpot') {
      Sound.play('jackpot');
      toast('🎡 ¡PLENO!', `${res.number} ${res.color} · +${money(res.net)}`, 'up');
      pushNotification('🎡 Pleno', `el ${res.number} cayó: +${money(res.net)}`, 'up');
    } else if (res.won) {
      Sound.play('win', { rarity: 'poco común' });
      toast('🎡 Ruleta', `${res.number} ${res.color} · +${money(res.net)}`, 'up');
    } else {
      Sound.play('loss');
      toast('🎡 Ruleta', `${res.number} ${res.color} · −${money(res.net)}`, 'down');
    }
  },
};

function openCasino(tab = 'menu') {
  Casino.show(tab);
}
