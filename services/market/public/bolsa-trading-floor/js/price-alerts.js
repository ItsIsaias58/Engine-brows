// alertas de precio por símbolo: "avísame si SOLMK cruza $280". viven en el
// guardado (state.priceAlerts), así que sobreviven a un reinicio, y se comprueban
// en cada latido de la UI contra el precio en vivo.
//
// lo importante es que disparan en el *cruce*, no por estar por encima o por
// debajo: cada alerta recuerda el último precio visto y sólo salta cuando pasa
// de un lado al otro del objetivo. sin eso, poner una alerta con el precio ya
// pasado dispararía al instante.
const PRICE_ALERT_MAX = 20;

function priceAlertLimit(){
  return Number.isFinite(PRICE_ALERT_MAX) && PRICE_ALERT_MAX > 0 ? PRICE_ALERT_MAX : 20;
}

function priceAlertId(){
  return `pa-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// normaliza lo que venga del guardado: una alerta corrupta no puede romper el
// panel ni disparar sola
function sanitizePriceAlerts(raw){
  if(!Array.isArray(raw)) return [];
  return raw
    .filter((a) =>
      a && typeof a === 'object'
      && typeof a.sym === 'string' && typeof bySym === 'function' && bySym(a.sym)
      && Number.isFinite(Number(a.target)) && Number(a.target) > 0)
    .slice(0, priceAlertLimit())
    .map((a) => ({
      id: typeof a.id === 'string' && a.id ? a.id : priceAlertId(),
      sym: a.sym,
      dir: a.dir === 'down' ? 'down' : 'up',
      target: Number(a.target),
      last: Number.isFinite(Number(a.last)) ? Number(a.last) : Number(a.target),
      createdAt: Number.isFinite(Number(a.createdAt)) ? Number(a.createdAt) : Date.now(),
    }));
}

function addPriceAlert(sym, dir, target){
  const m = typeof bySym === 'function' ? bySym(sym) : null;
  const value = Number(target);
  if(!m || !Number.isFinite(value) || value <= 0) return null;
  const alert = {
    id: priceAlertId(),
    sym,
    dir: dir === 'down' ? 'down' : 'up',
    target: value,
    // el punto de partida es el precio de ahora: el cruce se mide desde aquí
    last: m.price,
    createdAt: Date.now(),
  };
  state.priceAlerts.unshift(alert);
  if(state.priceAlerts.length > priceAlertLimit()) state.priceAlerts.length = priceAlertLimit();
  if(typeof saveGame === 'function') saveGame();
  renderPriceAlerts();
  return alert;
}

function removePriceAlert(id){
  const before = Array.isArray(state.priceAlerts) ? state.priceAlerts.length : 0;
  state.priceAlerts = (state.priceAlerts || []).filter((a) => a.id !== id);
  if(state.priceAlerts.length === before) return false;
  if(typeof saveGame === 'function') saveGame();
  renderPriceAlerts();
  return true;
}

// el cruce es una arista: veníamos por debajo y ahora está por encima (dir 'up'),
// o al revés
function priceAlertCrossed(alert, price){
  if(!alert || !Number.isFinite(price)) return false;
  const previous = Number.isFinite(alert.last) ? alert.last : price;
  if(alert.dir === 'up') return previous < alert.target && price >= alert.target;
  return previous > alert.target && price <= alert.target;
}

// devuelve cuántas alertas cruzaron. las que disparan se retiran (una alerta es
// un aviso, no un estado) y el aviso sale por los tres canales: campanita, toast
// y la tarjeta central, que además deja comprar de un toque.
function checkPriceAlerts(){
  if(!Array.isArray(state.priceAlerts) || !state.priceAlerts.length) return 0;
  const fired = [];
  state.priceAlerts.forEach((alert) => {
    const m = typeof bySym === 'function' ? bySym(alert.sym) : null;
    if(!m) return;
    const price = m.price;
    if(priceAlertCrossed(alert, price)) fired.push(alert);
    alert.last = price;
  });
  if(!fired.length) return 0;

  state.priceAlerts = state.priceAlerts.filter((a) => !fired.includes(a));
  fired.forEach((alert) => {
    const m = bySym(alert.sym);
    if(!m) return;
    const up = alert.dir === 'up';
    const verb = up ? 'superó' : 'cayó por debajo de';
    // la tarjeta central ya trae su propio jingle; sólo lo tocamos aquí si no va
    // a aparecer, para no sonar dos veces seguidas
    const willShowCard = typeof showMarketAlert === 'function';
    if(!willShowCard && typeof Sound !== 'undefined') Sound.play('alert', { up });
    if(typeof toast === 'function'){
      toast(`🔔 Alerta ${alert.sym}`, `${m.name} ${verb} ${money(alert.target)} · ahora ${money(m.price)}`, up ? 'up' : 'down');
    }
    if(typeof pushNotification === 'function'){
      pushNotification(`🔔 Alerta ${alert.sym}`, `${m.name} ${verb} ${money(alert.target)} · ahora ${money(m.price)}`, up ? 'up' : 'down');
    }
    if(typeof showMarketAlert === 'function'){
      showMarketAlert({
        sym: alert.sym,
        pct: m.pct,
        tone: up ? 'up' : 'down',
        kicker: 'Alerta de precio',
        title: `${m.name} ${verb} ${money(alert.target)}`,
      });
    }
  });
  if(typeof saveGame === 'function') saveGame();
  return fired.length;
}

// ------------------------------------------------------------------- panel
let priceAlertSignature = null;
let priceAlertShownFor = null;

// el chip de dividendo de la empresa en pantalla: reaparece cada N días de
// juego (el server paga, la agenda vive en Bank.schedule que llegó de
// /api/market/orders). se repinta aquí porque este módulo ya corre en cada tick.
function renderDividendChip(){
  const chip = document.getElementById('dividendChip');
  if(!chip) return;
  const schedule = typeof Bank !== 'undefined' && Array.isArray(Bank.schedule) ? Bank.schedule : [];
  const entry = schedule.find((d) => d.sym === activeSymbol);
  if(!entry || !entry.pays){
    if(chip.style.display !== 'none') chip.style.display = 'none';
    return;
  }
  const text = `💰 Dividendo ${entry.sym}: paga en ${entry.inDays === 1 ? 'el próximo día' : `${entry.inDays} día(s)`} · ${(entry.yieldRate * 100).toFixed(3)}% por acción`;
  if(chip.dataset.text !== text){
    chip.dataset.text = text;
    chip.textContent = text;
  }
  chip.style.display = 'flex';
}

function renderPriceAlerts(){
  renderDividendChip();
  const list = document.getElementById('priceAlertList');
  if(!list) return;
  const alerts = Array.isArray(state.priceAlerts) ? state.priceAlerts : [];

  const countEl = document.getElementById('priceAlertCount');
  if(countEl){
    const text = alerts.length ? `${alerts.length} ${alerts.length === 1 ? 'activa' : 'activas'}` : '';
    if(countEl.textContent !== text) countEl.textContent = text;
  }

  // al cambiar de empresa el campo se rellena con su precio, para no escribirlo a
  // mano; después se respeta lo que el jugador haya tecleado
  const targetEl = document.getElementById('priceAlertTarget');
  if(targetEl && priceAlertShownFor !== activeSymbol){
    priceAlertShownFor = activeSymbol;
    const m = typeof bySym === 'function' ? bySym(activeSymbol) : null;
    if(m) targetEl.value = m.price.toFixed(2);
  }

  const signature = alerts.map((a) => `${a.id}:${a.sym}:${a.dir}:${a.target}`).join('|');
  if(signature !== priceAlertSignature){
    priceAlertSignature = signature;
    if(!alerts.length){
      list.innerHTML = '<div class="price-alert-empty">Sin alertas. Ponle un precio a la empresa que estás viendo y te aviso cuando lo cruce.</div>';
    } else {
      list.innerHTML = alerts.map((a) => {
        const up = a.dir === 'up';
        return `
          <div class="price-alert-item" data-alert="${a.id}">
            <span class="price-alert-sym mono">${a.sym}</span>
            <span class="mono ${up ? 'pos' : 'neg'}">${up ? '▲' : '▼'} ${money(a.target)}</span>
            <span class="mono price-alert-now" data-now="${a.id}">—</span>
            <button class="price-alert-del" data-del="${a.id}" title="Quitar alerta" aria-label="Quitar alerta">✕</button>
          </div>`;
      }).join('');
      list.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          removePriceAlert(btn.dataset.del);
        });
      });
    }
  }

  // el "ahora" sigue a la cinta, así que se reescribe en cada latido (son pocas
  // filas y sólo se toca el DOM si el número cambió)
  alerts.forEach((a) => {
    const el = list.querySelector(`[data-now="${a.id}"]`);
    if(!el) return;
    const m = typeof bySym === 'function' ? bySym(a.sym) : null;
    const text = m ? m.price.toFixed(2) : '—';
    if(el.textContent !== text) el.textContent = text;
  });
}

function initPriceAlerts(){
  const addBtn = document.getElementById('priceAlertAdd');
  const targetEl = document.getElementById('priceAlertTarget');
  const dirEl = document.getElementById('priceAlertDir');
  if(addBtn && targetEl && dirEl){
    addBtn.addEventListener('click', () => {
      const alert = addPriceAlert(activeSymbol, dirEl.value, parseFloat(targetEl.value));
      if(!alert){
        if(typeof toast === 'function') toast('Alerta no creada', 'Escribe un precio válido (mayor que cero).', 'down');
        return;
      }
      const m = typeof bySym === 'function' ? bySym(activeSymbol) : null;
      const label = alert.dir === 'up' ? 'por encima de' : 'por debajo de';
      if(typeof toast === 'function'){
        toast('🔔 Alerta creada', `${alert.sym} · aviso cuando cruce ${label} ${money(alert.target)}`, 'gold');
      }
      // se deja el campo listo para la siguiente, con el precio de ahora
      if(m) targetEl.value = m.price.toFixed(2);
    });
    targetEl.addEventListener('keydown', (event) => {
      if(event.key === 'Enter') addBtn.click();
    });
  }
  renderPriceAlerts();
}
