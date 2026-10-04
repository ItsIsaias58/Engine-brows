// sondo, la mitad cliente de services/market/polls.mjs. un banner vivo muestra
// el sondeo abierto (pregunta, votos en vivo, cuenta regresiva); votar cobra
// recompensa al instante y al cerrarse el resultado suena según acierto de la
// mayoría. el empujón de sentimiento llega por WS como market-pulse.
const Polls = {
  active: null,
  bannerTimer: null,
  seenIds: [],
  votedIds: [],

  // ------------------------------------------------------------- lifecycle

  init() {
    // voto e historial de vistos, para no re-anunciar lo ya anunciado
    try {
      this.votedIds = JSON.parse(localStorage.getItem('bolsa-poll-voted') || '[]');
      if (!Array.isArray(this.votedIds)) this.votedIds = [];
    } catch (e) { this.votedIds = []; }
    this.refresh();
    // el banner se repinta solo: la cuenta regresiva y los votos en vivo
    if (!this.bannerTimer) this.bannerTimer = setInterval(() => this.tick(), 1000);
  },

  saveVoted() {
    try { localStorage.setItem('bolsa-poll-voted', JSON.stringify(this.votedIds.slice(-50))); } catch (e) {}
  },

  async refresh() {
    if (typeof MarketNet === 'undefined') return;
    try {
      const data = await MarketNet.request('/api/market/polls');
      if (data?.active) this.onOpen(data.active, true);
      else if (this.active) this.onClosed({ id: this.active.id, status: 'closed' });
    } catch (e) { /* offline: sin sondeos */ }
  },

  // ------------------------------------------------------------ ws handlers

  onOpen(poll, silent = false) {
    if (!poll) return;
    const isNew = !this.seenIds.includes(poll.id);
    this.active = poll;
    this.seenIds.push(poll.id);
    if (this.seenIds.length > 30) this.seenIds.shift();
    this.renderBanner();
    // sonido de aviso: corto y suave, sólo para sondeos nuevos y no silenciosos
    if (!silent && isNew && typeof Sound !== 'undefined') Sound.play('pollOpen');
    if (isNew && !silent) {
      pushNotification('🗳️ Sondo', poll.question, 'gold');
    }
  },

  onClosed(poll) {
    const wasActive = this.active && this.active.id === poll.id;
    if (poll.result) {
      // ¿acertó la mayoría? el server lo dice: outcome 'up'|'down' es la
      // dirección real del precio al cierre
      const outcome = poll.result.outcome;
      const majority = poll.result.majority;
      const majorityWon = majority !== null && majority === outcome;
      if (wasActive && typeof Sound !== 'undefined') {
        if (outcome === 'no-votes' || majority === null) Sound.play('notify');
        else if (majorityWon) Sound.play('pollWin');
        else Sound.play('pollLose');
      }
      if (wasActive) {
        const pct = poll.result.share || 0;
        const moved = poll.result.move || 0;
        const msg = majority === null
          ? 'empate: el mercado no se movió'
          : `mayoría ${majority === 'up' ? 'alcista' : 'bajista'} (${pct.toFixed(0)}%) · ${majorityWon ? 'acertó' : 'falló'} · movimiento ${moved}%`;
        pushNotification('🗳️ Sondo cerrado', `${poll.sym}: ${msg}`, majorityWon ? 'up' : 'down');
        if (wasActive) toast('🗳️ Sondo', `${poll.sym} — ${msg}`, majorityWon ? 'up' : 'down');
      }
    }
    if (wasActive) {
      this.active = null;
      this.renderBanner();
    } else if (this.active) {
      this.refresh();
    }
  },

  // el voto colectivo movió el precio: ping sincronizado con la gráfica
  onMarketPulse(pulse) {
    if (pulse?.source !== 'poll') return;
    if (typeof Sound !== 'undefined') Sound.play('marketPulse');
    if (typeof refreshTickUi === 'function') refreshTickUi(true);
  },

  // ----------------------------------------------------------------- voto

  async vote(side) {
    if (!this.active) return;
    if (this.votedIds.includes(this.active.id)) {
      toast('Sondo', 'ya votaste en este sondeo', 'gold');
      return;
    }
    try {
      const data = await MarketNet.request('/api/market/polls/vote', {
        method: 'POST',
        body: JSON.stringify({ id: this.active.id, side }),
      });
      if (data?.ok) {
        this.active = data.poll;
        this.votedIds.push(data.poll.id);
        this.saveVoted();
        if (typeof Sound !== 'undefined') Sound.play('pollVote');
        if (Number.isFinite(data.cash)) { state.cash = data.cash; if (typeof updateHud === 'function') updateHud(); }
        toast('🗳️ Voto registrado', `+${money(data.reward)} por participar`, 'up');
        this.renderBanner();
      } else {
        toast('Sondo', data?.error || 'no se pudo votar', 'down');
      }
    } catch (e) {
      toast('Sondo', e?.message || 'no se pudo votar', 'down');
    }
  },

  // ---------------------------------------------------------------- banner

  tick() {
    if (!this.active) return;
    if (this.active.closesAt <= Date.now()) return; // el server lo cierra
    const bar = document.getElementById('pollTimebar');
    if (bar) {
      const total = this.active.closesAt - this.active.openedAt;
      const left = Math.max(0, this.active.closesAt - Date.now());
      bar.style.width = `${Math.min(100, (left / total) * 100)}%`;
    }
    const timer = document.getElementById('pollTimer');
    if (timer) {
      const left = Math.max(0, this.active.closesAt - Date.now());
      const mins = Math.floor(left / 60000);
      const secs = Math.floor((left % 60000) / 1000);
      timer.textContent = `${mins}:${String(secs).padStart(2, '0')}`;
    }
  },

  hasVoted() {
    return this.active ? this.votedIds.includes(this.active.id) : false;
  },

  renderBanner() {
    let banner = document.getElementById('pollBanner');
    if (!this.active) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'pollBanner';
      banner.className = 'poll-banner';
      const anchor = document.querySelector('.main');
      if (anchor) anchor.insertBefore(banner, anchor.firstChild);
      else document.body.appendChild(banner);
    }
    const p = this.active;
    const total = p.total || 0;
    const upPct = total ? Math.round((p.up / total) * 100) : 50;
    const voted = this.hasVoted();
    banner.innerHTML = `
      <div class="poll-main">
        <span class="poll-tag">🗳️ SONDO</span>
        <span class="poll-question">${p.question}</span>
        <span class="poll-timer mono" id="pollTimer">—</span>
      </div>
      ${voted ? `
        <div class="poll-results">
          <span class="poll-side up">▲ ${p.up} (${upPct}%)</span>
          <span class="poll-side down">▼ ${p.down} (${100 - upPct}%)</span>
        </div>
      ` : `
        <div class="poll-actions">
          <button class="poll-btn is-up" data-vote="up">▲ Sube · +${money(p.reward)}</button>
          <button class="poll-btn is-down" data-vote="down">▼ Baja · +${money(p.reward)}</button>
        </div>
      `}
      <div class="poll-timebar-wrap"><div class="poll-timebar" id="pollTimebar"></div></div>`;
    banner.querySelectorAll('[data-vote]').forEach((btn) => {
      btn.addEventListener('click', () => this.vote(btn.dataset.vote));
    });
    this.tick();
  },
};
