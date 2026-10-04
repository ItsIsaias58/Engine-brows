// el campo visual del piso: un índice compuesto (mini S&P interno) que resume
// la salud de todo el mercado y un mapa de calor donde cada empresa es una
// baldosa verde/roja con intensidad según su % del día. todo se calcula desde
// la cinta que el server manda: el cliente no inventa ningún número.
const HEAT_CAP_PCT = 5; // ±5% satura el color: más allá, todo se ve igual de fuerte

// --------------------------------------------------------------- índice

function renderMarketIndex(){
  const el = document.getElementById('marketIndex');
  if(!el || typeof MARKET === 'undefined' || !MARKET.length) return;
  let sum = 0, up = 0, down = 0;
  for(const m of MARKET){
    const base = m.prevClose > 0 ? m.prevClose : m.price;
    sum += base > 0 ? m.price / base : 1;
    if(m.pct >= 0) up += 1; else down += 1;
  }
  const level = 1000 * (sum / MARKET.length);
  const pct = (level - 1000) / 10;
  const html = `
    <span class="mi-label">ÍNDICE</span>
    <strong class="mono mi-level ${pct>=0?'pos':'neg'}">${level.toFixed(1)} ${pct>=0?'▲':'▼'}</strong>
    <span class="mono mi-pct ${pct>=0?'pos':'neg'}">${pct>=0?'+':''}${pct.toFixed(2)}%</span>
    <span class="mi-breadth mono">${up}↑ · ${down}↓</span>`;
  if(el.dataset.html !== html){ el.dataset.html = html; el.innerHTML = html; }
}

// ----------------------------------------------------------------
//  heatmap

function heatColor(pct){
  // verde -> neutro -> rojo, con intensidad proporcional a |pct|
  const t = Math.min(1, Math.abs(pct) / HEAT_CAP_PCT);
  const alpha = 0.12 + t * 0.55;
  return pct >= 0 ? `rgba(41,224,168,${alpha.toFixed(3)})` : `rgba(255,92,122,${alpha.toFixed(3)})`;
}

const Heatmap = {
  open: false,
  timer: null,

  show(){
    let overlay = document.getElementById('heatmapOverlay');
    if(!overlay){
      overlay = document.createElement('div');
      overlay.id = 'heatmapOverlay';
      overlay.className = 'heatmap-overlay';
      overlay.innerHTML = `
        <div class="heatmap-panel">
          <header class="heatmap-head">
            <h2>🔥 Mapa de calor</h2>
            <span class="heatmap-legend mono">-5% ▓▓▒░ +5%</span>
            <button class="scrub-btn" id="heatmapClose">✕</button>
          </header>
          <div class="heatmap-grid" id="heatmapGrid"></div>
          <p class="heatmap-note">El tamaño del bloque es el peso del precio; el color, el % del día. Toca una baldosa para operar ese símbolo.</p>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#heatmapClose').addEventListener('click', () => this.hide());
      overlay.addEventListener('click', (e) => { if(e.target === overlay) this.hide(); });
    }
    overlay.classList.add('is-visible');
    this.open = true;
    this.render();
    if(typeof Sound !== 'undefined') Sound.play('notify');
    // repinta en vivo mientras esté abierto: la cinta no se detiene
    if(!this.timer) this.timer = setInterval(() => { if(this.open) this.render(); }, 1000);
  },

  hide(){
    const overlay = document.getElementById('heatmapOverlay');
    if(overlay) overlay.classList.remove('is-visible');
    this.open = false;
  },

  render(){
    const grid = document.getElementById('heatmapGrid');
    if(!grid || typeof MARKET === 'undefined') return;
    const maxPrice = Math.max(...MARKET.map(m => m.price), 1);
    grid.innerHTML = MARKET.map(m => {
      // peso: el precio relativo decide el tamaño de la baldosa (flex-grow)
      const weight = Math.max(0.6, Math.sqrt(m.price / maxPrice) * 3);
      const cls = m.pct >= 0 ? 'is-up' : 'is-down';
      return `
        <button class="heat-tile ${cls}" data-sym="${m.sym}"
                style="flex-grow:${weight.toFixed(2)}; background:${heatColor(m.pct)}">
          <strong>${m.sym}</strong>
          <span class="mono">${m.pct>=0?'▲':'▼'} ${m.pct>=0?'+':''}${m.pct.toFixed(2)}%</span>
          <em class="mono">$${m.price.toFixed(2)}</em>
        </button>`;
    }).join('');
    grid.querySelectorAll('[data-sym]').forEach(tile => {
      tile.addEventListener('click', () => {
        this.hide();
        if(typeof selectSymbol === 'function') selectSymbol(tile.dataset.sym);
      });
    });
  },
};

function openHeatmap(){ Heatmap.show(); }
