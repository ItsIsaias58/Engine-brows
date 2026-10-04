// the player bank, the client half of services/market/bank.mjs. the design
// comes straight from BNT's igb.php: a screen where idle credits earn interest
// and a loan desk that charges more than it pays, with the debt collected the
// hard way when the term runs out. this half also has the transfer desk: money
// moves between players, both books written by the server in one atomic call.
//
// the modal has two tabs: Banco (savings, loans, dividends) and Transferir
// (the form to send money to another player plus the in/out history).
//
// signed in: every action is a server call (the server owns the truth) and the
// response updates the local state. guest: the same rules run locally over
// state.bank, and transfers refuse clearly (a guest has no server wallet to
// deliver to).
const BANK_RATES = { savings: 0.003, loan: 0.012, termDays: 5, penalty: 0.10 };
// la regla del impuesto de envío la dicta el server; esto es el fallback local
const TRANSFER_FEE = { rate: 0.05, threshold: 10000 };

const Bank = {
  schedule: [],

  rates() { return { ...BANK_RATES }; },

  // game day counter shared with the dividend schedule (market.js keeps it)
  currentGameDay() {
    if (typeof MarketNet !== 'undefined' && Number.isFinite(MarketNet.gameDay)) return MarketNet.gameDay;
    return Math.floor(Date.now() / 86400000);
  },

  async refresh() {
    if (typeof MarketNet !== 'undefined' && MarketNet.signedIn) {
      try {
        const data = await MarketNet.request('/api/market/bank');
        if (data?.bank) state.bank = data.bank;
        if (Array.isArray(data?.dividendSchedule)) this.schedule = data.dividendSchedule;
        if (data?.rates) Object.assign(BANK_RATES, data.rates);
        if (data?.transfer) Object.assign(TRANSFER_FEE, data.transfer);
      } catch (e) { /* offline: the local book stays in charge */ }
    }
    // the dividend schedule is world data, not account data: guests fetch it
    // too, so the panel and the chip agree with what the server actually pays
    if (!this.schedule.length) {
      try {
        const world = await MarketNet.request('/api/market/schedule');
        if (Array.isArray(world?.dividendSchedule)) this.schedule = world.dividendSchedule;
        if (world?.transfer) Object.assign(TRANSFER_FEE, world.transfer);
        if (world?.rates) Object.assign(BANK_RATES, world.rates);
      } catch (e) { /* fully offline: the fallback schedule is empty */ }
    }
    return state.bank;
  },

  async act(action, amount) {
    if (typeof MarketNet !== 'undefined' && MarketNet.signedIn) {
      const data = await MarketNet.request('/api/market/bank', {
        method: 'POST',
        body: JSON.stringify({ action, amount }),
      });
      if (data?.ok) {
        state.bank = data.bank;
        state.cash = data.cash;
        updateHud();
        updatePerformancePanel();
      }
      return data;
    }
    // guest: the same rules the server enforces, run locally (bank.mjs is the
    // reference; this mirrors deposit/withdraw/borrow/repay)
    const bank = state.bank || (state.bank = { balance: 0, loan: 0, loanDaysLeft: 0, loanAtDay: null });
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'monto inválido' };
    if (action === 'deposit') {
      if (n > state.cash) return { ok: false, error: 'no tienes ese efectivo' };
      // misma regla que el server: el 5% siempre queda en efectivo
      const maxDeposit = Math.floor(state.cash * 0.95);
      if (n > maxDeposit) return { ok: false, error: `sólo puedes depositar hasta el 95% de tu efectivo (${maxDeposit}) — deja al menos 5% en mano` };
      state.cash -= n; bank.balance += n;
    } else if (action === 'withdraw') {
      if (n > bank.balance) return { ok: false, error: 'saldo insuficiente en el banco' };
      bank.balance -= n; state.cash += n;
    } else if (action === 'borrow') {
      if (bank.loan > 0) return { ok: false, error: 'ya tienes un préstamo activo' };
      const net = netWorth();
      const cap = Math.min(250000, Math.max(2000, net * 1.5));
      const granted = Math.min(n, cap);
      bank.loan = granted; bank.loanDaysLeft = BANK_RATES.termDays; state.cash += granted;
    } else if (action === 'repay') {
      if (bank.loan <= 0) return { ok: false, error: 'no debes nada' };
      const pay = Math.min(n, bank.loan, state.cash);
      if (pay <= 0) return { ok: false, error: 'no tienes efectivo para pagar' };
      bank.loan -= pay; state.cash -= pay;
      if (bank.loan <= 0.001) { bank.loan = 0; bank.loanDaysLeft = 0; }
    } else {
      return { ok: false, error: 'acción desconocida' };
    }
    updateHud(); updatePerformancePanel();
    return { ok: true, note: '' };
  },

  // send cash to another player. signed in: the server validates the
  // recipient against the live account store and writes both books; guests
  // cannot move money to a wallet that lives on the server, so it refuses
  // clearly instead of pretending.
  async transfer(toName, amount, note) {
    const name = String(toName || '').trim();
    if (!name) return { ok: false, error: 'escribe el nombre del destinatario' };
    if (typeof MarketNet === 'undefined' || !MarketNet.signedIn) {
      return { ok: false, error: 'inicia sesión para transferir: como invitado no hay servidor que entregue el dinero' };
    }
    const data = await MarketNet.request('/api/market/bank/transfer', {
      method: 'POST',
      body: JSON.stringify({ to: name, amount, note }),
    });
    if (data?.ok) {
      state.cash = data.cash;
      if (Array.isArray(data.transfers)) state.transfers = data.transfers;
      updateHud();
      updatePerformancePanel();
      const feeNote = data.fee > 0 ? ` · impuesto ${money(data.fee)}` : ' · sin impuesto';
      // el arpa del envío reemplaza a la campanita: un jingle, no dos
      if (typeof suppressNextNotify === 'function') suppressNextNotify();
      pushNotification('🏦 Transferencia enviada', `${money(data.amount)} → ${data.to}${feeNote}`, 'gold');
      if (typeof Sound !== 'undefined') Sound.play('transfer');
    }
    return data;
  },
};// el impuesto progresivo del envío: nada por debajo del umbral, 5% de lo que
// pasa el umbral por arriba. el server cobra; aquí sólo se anuncia.
function transferFeeOf(amount) {
  const value = Math.max(0, Number(amount) || 0);
  if (value <= TRANSFER_FEE.threshold) return 0;
  return (value - TRANSFER_FEE.threshold) * TRANSFER_FEE.rate;
}

// recent counterparties for the transfer form's datalist: names straight from
// the live tape (the only public list of traders) plus the player's own book
function recentPlayerNames() {
  const names = [];
  const push = (n) => {
    if (typeof n !== 'string' || !n.trim()) return;
    if (typeof MarketNet !== 'undefined' && n === MarketNet.accountName) return;
    if (!names.includes(n)) names.push(n);
  };
  if (Array.isArray(state.transfers)) state.transfers.forEach((t) => push(t.with));
  if (typeof MarketNet !== 'undefined' && Array.isArray(MarketNet.tape)) {
    MarketNet.tape.forEach((t) => push(t.name));
  }
  return names.slice(0, 12);
}

// the in/out transfer history: newest first, direction marked, note quoted
function transfersHtml(transfers) {
  const book = Array.isArray(transfers) ? transfers.slice(0, 10) : [];
  if (!book.length) {
    return '<p class="bank-hint">Sin transferencias todavía. Envía dinero a otro jugador por su nombre exacto.</p>';
  }
  return book.map((t) => {
    const out = t.dir === 'out';
    const when = Number.isFinite(t.at) ? new Date(t.at).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    const feeTag = out && t.fee > 0 ? ` · impuesto ${money(t.fee)}` : '';
    return `
      <div class="bank-xfer ${out ? 'is-out' : 'is-in'}">
        <span class="bank-xfer-dir">${out ? '↑ enviaste a' : '↓ recibiste de'}</span>
        <strong>${String(t.with || '?').replace(/[<>&]/g, '')}</strong>
        <span class="mono ${out ? 'neg' : 'pos'}">${out ? '−' : '+'}${money(t.amount || 0)}${feeTag}</span>
        ${t.note ? `<em title="${String(t.note).replace(/"/g, '&quot;')}">“${String(t.note).replace(/[<>&]/g, '')}”</em>` : ''}
        <span class="bank-xfer-when mono">${when}</span>
      </div>`;
  }).join('');
}

// the bank modal remembers which tab the player is on, so an action that
// repaints the panel (deposit, transfer…) does not kick them back to the start
let currentBankTab = 'banco';

const BANK_TABS = [
  ['banco', '🏦 Banco'],
  ['transferir', '💸 Transferir'],
];

function bankTabsHtml(active) {
  return segmentedHtml(BANK_TABS, active);
}

function bankContent(activeTab = 'banco') {
  const bank = state.bank || { balance: 0, loan: 0, loanDaysLeft: 0 };
  const r = Bank.rates();
  const pct = (x) => (x * 100).toFixed(2) + '%';
  const signedIn = typeof MarketNet !== 'undefined' && MarketNet.signedIn;
  const dividends = Bank.schedule.length ? Bank.schedule.filter((d) => d.pays) : null;
  const feePct = Math.round(TRANSFER_FEE.rate * 100);
  const feeK = money(TRANSFER_FEE.threshold);

  // ---- pestaña transferir: formulario + historial ------------------------
  if (activeTab === 'transferir') {
    return `
      ${bankTabsHtml('transferir')}
      <div class="bank-head">
        <div class="bank-card" id="bankCashCard">
          <span>Efectivo disponible</span>
          <strong class="mono">${money(state.cash)}</strong>
        </div>
        <div class="bank-card">
          <span>Impuesto de envío</span>
          <strong class="mono">${feePct}%</strong>
          <em>sólo sobre lo que pasa de ${feeK}</em>
        </div>
      </div>
      <div class="bank-forms bank-xfer-form" style="grid-template-columns:1.2fr 1fr">
        <section>
          <h4>Enviar a otro jugador</h4>
          <p class="bank-hint">El dinero sale de tu efectivo y llega al de él, al instante. Escribe su nombre exacto o elige uno de la lista de jugadores recientes.</p>
          ${signedIn ? `
            <input id="xferTo" type="text" maxlength="24" placeholder="nombre del jugador" autocomplete="off" class="mono" list="xferNames">
            <datalist id="xferNames">${recentPlayerNames().map((n) => `<option value="${n.replace(/"/g, '&quot;')}"></option>`).join('')}</datalist>
            <input id="xferAmount" type="number" min="1" placeholder="monto" class="mono">
            <div class="bank-quick" id="xferQuick">
              <button class="bank-chip mono" data-pct="25">25%</button>
              <button class="bank-chip mono" data-pct="50">50%</button>
              <button class="bank-chip mono" data-pct="100">Todo</button>
            </div>
            <input id="xferNote" type="text" maxlength="120" placeholder="nota (opcional)" class="bank-xfer-note">
            <p class="bank-hint bank-xfer-fee" id="xferFeeHint"></p>
            <div class="bank-row-btns">
              <button class="nav-modal-btn" data-bank="transfer">Enviar transferencia</button>
            </div>` : `
            <p class="bank-hint bank-xfer-guest">🔒 Inicia sesión para transferir: como invitado no hay servidor que entregue el dinero.</p>`}
        </section>
        <section>
          <h4>Historial</h4>
          <div class="bank-xfer-list" id="xferList">${transfersHtml(state.transfers)}</div>
        </section>
      </div>`;
  }

  // ---- pestaña banco: ahorro, préstamo, dividendos -----------------------
  return `
    ${bankTabsHtml('banco')}
    <div class="bank-head">
      <div class="bank-card" id="bankCashCard">
        <span>Efectivo</span>
        <strong class="mono">${money(state.cash)}</strong>
      </div>
      <div class="bank-card">
        <span>Cuenta de ahorro</span>
        <strong class="mono bank-pos">${money(bank.balance)}</strong>
        <em>+${pct(r.savings)} diario</em>
      </div>
      <div class="bank-card ${bank.loan > 0 ? 'bank-debt' : ''}">
        <span>Deuda</span>
        <strong class="mono">${bank.loan > 0 ? money(bank.loan) : '—'}</strong>
        <em>${bank.loan > 0 ? `${Math.max(0, bank.loanDaysLeft)} día(s) de plazo` : 'sin préstamo'}</em>
      </div>
    </div>      <div class="bank-forms">
      <section>
        <h4>Ahorro</h4>
        <input id="bankAmount" type="number" min="1" placeholder="monto" class="mono">
        <div class="bank-quick" id="bankQuick">
          <button class="bank-chip mono" data-pct="25">25%</button>
          <button class="bank-chip mono" data-pct="50">50%</button>
          <button class="bank-chip mono" data-pct="100">Todo</button>
        </div>
        <div class="bank-row-btns">
          <button class="nav-modal-btn" data-bank="deposit">Depositar</button>
          <button class="nav-modal-btn" data-bank="withdraw">Retirar</button>
        </div>
      </section>
      <section>
        <h4>Préstamo</h4>
        <p class="bank-hint">${pct(r.loan)} por día · plazo de ${r.termDays} días · al vencer el banco cobra con ${pct(r.penalty)} de mora, de tu efectivo y de tus posiciones.</p>
        <div class="bank-row-btns">
          <button class="nav-modal-btn" data-bank="borrow">Pedir préstamo</button>
          <button class="nav-modal-btn ${bank.loan <= 0 ? 'is-disabled' : ''}" data-bank="repay" ${bank.loan <= 0 ? 'disabled' : ''}>Pagar deuda</button>
        </div>
      </section>
    </div>
    <div class="bank-row-btns" style="margin-top:10px">
      <button class="nav-modal-btn" id="bankOpenCaseBtn">📦 Cajas de mercado (OpenCase) — mismo cash</button>
    </div>
    ${dividends ? `
      <div class="bank-divs">
        <h4>Dividendos — próximos pagos</h4>
        <div class="bank-div-grid">
          ${dividends.map((d) => `
            <div class="bank-div ${d.inDays === 1 ? 'is-soon' : ''}" title="cada ${d.everyDays} días de juego, ${(d.yieldRate * 100).toFixed(3)}% del precio por acción">
              <span class="mono">${d.sym}</span>
              <strong>${d.inDays === 1 ? '¡mañana!' : `en ${d.inDays}d`}</strong>
            </div>`).join('')}
        </div>
        <p class="bank-hint">Cada empresa paga por acción un porcentaje del precio en su día: ten acciones esa mañana y el efectivo llega solo (10% de retención).</p>
      </div>` : ''}
  `;
}

function bindBankEvents(body) {
  if (!body) return;
  const input = body.querySelector('#bankAmount');

  // puente a opencase: mismo monedero, misma sesión (SSO por localStorage)
  body.querySelector('#bankOpenCaseBtn')?.addEventListener('click', () => {
    window.open('/owngames/csgo-opencase/', '_blank');
  });

  // tab switch inside the same modal (segmented control with sliding pill)
  bindSegmented(body, (tab) => {
    currentBankTab = tab;
    const titleEl = document.getElementById('navModalTitle');
    if (titleEl) titleEl.textContent = tab === 'transferir' ? 'Transferir dinero' : 'Banco';
    body.innerHTML = bankContent(tab);
    bindBankEvents(body);
  });

  // chips de monto rápido: % del efectivo disponible, ya descontando el
  // impuesto si el envío lo pagaría (lo que sale es lo que puedes mandar)
  body.querySelectorAll('.bank-quick').forEach((wrap) => {
    wrap.querySelectorAll('.bank-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const target = wrap.id === 'xferQuick' ? body.querySelector('#xferAmount') : input;
        if (!target) return;
        const pct = (parseInt(chip.dataset.pct, 10) || 0) / 100;
        let amount = Math.floor(state.cash * pct);
        if (wrap.id === 'xferQuick' && amount > TRANSFER_FEE.threshold) {
          // amount + (amount - umbral)*rate <= cash -> amount <= (cash + rate*umbral) / (1 + rate)
          amount = Math.floor((state.cash + TRANSFER_FEE.rate * TRANSFER_FEE.threshold) / (1 + TRANSFER_FEE.rate));
        }
        target.value = String(Math.max(0, amount));
        target.dispatchEvent(new Event('input'));
      });
    });
  });

  // el estimado del impuesto se recalcula mientras escribes el monto
  const amountInput = body.querySelector('#xferAmount');
  const feeHint = body.querySelector('#xferFeeHint');
  if (amountInput && feeHint) {
    const paintFee = () => {
      const amount = parseFloat(amountInput.value);
      if (!Number.isFinite(amount) || amount <= 0) {
        feeHint.textContent = `Envíos hasta ${money(TRANSFER_FEE.threshold)}: gratis. Arriba: impuesto del ${Math.round(TRANSFER_FEE.rate * 100)}% sólo sobre el excedente.`;
        return;
      }
      const fee = transferFeeOf(amount);
      const received = amount - fee;
      feeHint.textContent = fee > 0
        ? `Impuesto: ${money(fee)} · ${money(amount)} sale de tu efectivo · llegan ${money(received)}`
        : `Sin impuesto · llegan ${money(received)}`;
    };
    amountInput.addEventListener('input', paintFee);
    paintFee();
  }

  body.querySelectorAll('[data-bank]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.bank;
      if (action === 'transfer') {
        const to = body.querySelector('#xferTo')?.value || '';
        const amount = parseFloat(body.querySelector('#xferAmount')?.value);
        const note = body.querySelector('#xferNote')?.value || '';
        btn.disabled = true;
        const result = await Bank.transfer(to, Number.isFinite(amount) ? amount : undefined, note);
        btn.disabled = false;
        if (!result?.ok) {
          toast('Transferencia', result?.error || 'no se pudo enviar', 'down');
          if (typeof Sound !== 'undefined') Sound.play('error');
          return;
        }
        toast('🏦 Transferencia', `${money(result.amount)} → ${result.to}${result.fee > 0 ? ` · impuesto ${money(result.fee)}` : ''}`, 'gold');
        // repaint the whole panel: history and cash are fresh, same tab
        openNavModal('Transferir dinero', bankContent('transferir'));
        bindBankEvents(document.getElementById('navModalBody'));
        return;
      }
      const amount = parseFloat(input?.value);
      const result = await Bank.act(action, Number.isFinite(amount) ? amount : undefined);
      if (!result?.ok) {
        toast('Banco', result?.error || 'no se pudo completar', 'down');
        if (typeof Sound !== 'undefined') Sound.play('error');
        return;
      }
      const notes = {
        deposit: 'Depositaste en tu cuenta de ahorro',
        withdraw: 'Retiraste de tu cuenta',
        borrow: 'Préstamo otorgado — ojo con la fecha de cobro',
        repay: 'Deuda pagada',
      };
      toast('🏦 Banco', notes[action] || 'listo', action === 'borrow' ? 'gold' : 'up');
      if (typeof Sound !== 'undefined') Sound.play(action === 'borrow' ? 'buy' : 'profit');
      pushNotification('🏦 Banco', notes[action] || 'operación completada', action === 'borrow' ? 'gold' : 'up');
      // repaint the same modal with fresh numbers (same tab)
      openNavModal('Banco', bankContent('banco'));
      bindBankEvents(document.getElementById('navModalBody'));
    });
  });
}

async function openBank(tab = 'banco') {
  currentBankTab = BANK_TABS.some(([id]) => id === tab) ? tab : 'banco';
  await Bank.refresh();
  openNavModal(
    currentBankTab === 'transferir' ? 'Transferir dinero' : 'Banco',
    bankContent(currentBankTab),
    { wide: true, focus: currentBankTab === 'transferir' ? '#xferTo' : '#bankAmount' },
  );
  bindBankEvents(document.getElementById('navModalBody'));
}

// ¿el modal del banco está abierto ahora mismo? sirve para refrescarlo en
// vivo cuando llega una transferencia (u otro movimiento del server) sin
// esperar a que el jugador lo cierre y vuelva a abrir.
function bankModalIsOpen() {
  const overlay = document.getElementById('navModalOverlay');
  const body = document.getElementById('navModalBody');
  return !!(overlay && overlay.classList.contains('is-visible') && body && body.querySelector('[data-banktab]'));
}

// repinta en vivo lo que cambia cuando entra dinero: la tarjeta de efectivo
// y el historial destellan con el dato nuevo; lo que el jugador esté
// escribiendo (nombre, monto, nota) no se toca.
function refreshBankModalIfOpen() {
  if (!bankModalIsOpen()) return;
  const body = document.getElementById('navModalBody');
  const cashCard = document.getElementById('bankCashCard');
  if (cashCard) {
    const strong = cashCard.querySelector('strong');
    if (strong) strong.textContent = money(state.cash);
    cashCard.classList.remove('bank-xfer-flash');
    void cashCard.offsetWidth; // reinicia la animación CSS
    cashCard.classList.add('bank-xfer-flash');
  }
  const list = document.getElementById('xferList');
  if (list) {
    const before = list.innerHTML;
    list.innerHTML = transfersHtml(state.transfers);
    if (list.innerHTML !== before) {
      list.classList.remove('bank-xfer-flash');
      void list.offsetWidth;
      list.classList.add('bank-xfer-flash');
    }
  }
  // re-anuncia el estimado con lo que hubiera escrito el jugador
  const amountInput = body.querySelector('#xferAmount');
  if (amountInput) amountInput.dispatchEvent(new Event('input'));
}
