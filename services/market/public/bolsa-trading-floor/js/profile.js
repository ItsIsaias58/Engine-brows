// perfil del jugador: avatar, banner, título, bio y privacidad. vive en
// localStorage y, con sesión, se sincroniza con el servidor
// (PUT /api/market/me/profile) para que el ranking pueda mostrar el avatar y el
// título de cada jugador. los títulos se desbloquean con logros y con hitos.
const PROFILE_KEY = 'bolsa-profile-v1';

const AVATARS = ['🎯','🦈','🚀','💎','🏆','🐂','🐻','🔥','⚡','🌙','☕','🎲','👑','🎩','🦉','🐉'];
const AVATAR_COLORS = [
  'linear-gradient(145deg,#5B8CFF,#8A5BFF)',
  'linear-gradient(145deg,#29E0A8,#1BA77D)',
  'linear-gradient(145deg,#FF5C7A,#C73355)',
  'linear-gradient(145deg,#F2B84B,#C48A1E)',
  'linear-gradient(145deg,#FF8A4B,#C75C1E)',
  'linear-gradient(145deg,#4BC7FF,#1E7BC7)',
  'linear-gradient(145deg,#B54BFF,#7A1EC7)',
  'linear-gradient(145deg,#FF4BD8,#C71E9B)',
];
const PROFILE_BANNERS = [
  'linear-gradient(135deg,#0E1319,#1D2530)',
  'linear-gradient(135deg,#1B2A4D,#0E1319)',
  'linear-gradient(135deg,#12463A,#0E1319)',
  'linear-gradient(135deg,#47202B,#0E1319)',
  'linear-gradient(135deg,#2A1B4D,#0E1319)',
  'linear-gradient(135deg,#4D3B1B,#0E1319)',
  'linear-gradient(135deg,#1B4D4D,#0E1319)',
  'linear-gradient(135deg,#2B1740,#0E1319)',
];
const PROFILE_TITLES = [
  { id:'novato',   name:'Novato',              desc:'Empieza a operar' },
  { id:'tiburon',  name:'Tiburón del Mercado', desc:'Alcanza el nivel 40' },
  { id:'magnate',  name:'Magnate',             desc:'Patrimonio > $10M' },
  { id:'bola',     name:'Bola de Cristal',     desc:'10 operaciones ganadoras seguidas' },
  { id:'sinmiedo', name:'Sin Miedo',           desc:'Opera con apalancamiento x20' },
  { id:'fenix',    name:'Fénix',               desc:'Recupérate de una bancarrota' },
  { id:'diverso',  name:'Diverso',             desc:'5 sectores en cartera a la vez' },
  { id:'diamante', name:'Diamante',            desc:'Patrimonio > $100M' },
];

let profile = {
  avatar: '🎯',
  avatarColor: 0,
  banner: 0,
  title: 'novato',
  bio: '',
  privacy: 'public',
  unlockedTitles: ['novato'],
};

const Profile = {
  load(){
    try{
      const raw = localStorage.getItem(PROFILE_KEY);
      if(raw){
        const parsed = JSON.parse(raw);
        if(parsed && typeof parsed === 'object') Object.assign(profile, parsed);
      }
    }catch(e){}
    return profile;
  },

  // the server copy wins on sign-in: it is the one that survives a reinstall
  fromServer(remote){
    if(!remote || typeof remote !== 'object') return profile;
    const clean = {
      avatar: AVATARS.includes(remote.avatar) ? remote.avatar : profile.avatar,
      avatarColor: Number.isFinite(remote.avatarColor) ? Math.max(0, Math.min(AVATAR_COLORS.length - 1, remote.avatarColor)) : profile.avatarColor,
      banner: Number.isFinite(remote.banner) ? Math.max(0, Math.min(PROFILE_BANNERS.length - 1, remote.banner)) : profile.banner,
      title: PROFILE_TITLES.some(t => t.id === remote.title) ? remote.title : profile.title,
      bio: typeof remote.bio === 'string' ? remote.bio.slice(0, 120) : profile.bio,
      privacy: ['public', 'friends', 'private'].includes(remote.privacy) ? remote.privacy : profile.privacy,
      unlockedTitles: Array.isArray(remote.unlockedTitles)
        ? remote.unlockedTitles.filter(id => PROFILE_TITLES.some(t => t.id === id))
        : profile.unlockedTitles,
    };
    Object.assign(profile, clean);
    if(!profile.unlockedTitles.includes('novato')) profile.unlockedTitles.push('novato');
    this.persistLocal();
    this.refreshAvatar();
    return profile;
  },

  persistLocal(){
    try{ localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); }catch(e){}
  },

  save(){
    this.persistLocal();
    if(typeof MarketNet !== 'undefined' && MarketNet.signedIn){
      MarketNet.request('/api/market/me/profile', {
        method: 'PUT',
        body: JSON.stringify(profile),
      }).catch(() => {});
    }
    this.refreshAvatar();
  },

  titleName(id){
    const found = PROFILE_TITLES.find(t => t.id === id);
    return found ? found.name : 'Novato';
  },

  unlockTitle(id){
    if(!PROFILE_TITLES.some(t => t.id === id)) return false;
    if(!Array.isArray(profile.unlockedTitles)) profile.unlockedTitles = ['novato'];
    if(profile.unlockedTitles.includes(id)) return false;
    profile.unlockedTitles.push(id);
    this.save();
    const t = PROFILE_TITLES.find(x => x.id === id);
    if(typeof toast === 'function') toast('🏅 Título desbloqueado', `"${t.name}" ya está disponible`, 'gold');
    if(typeof pushNotification === 'function') pushNotification('🏅 Nuevo título', `Desbloqueaste "${t.name}" · ${t.desc}`, 'gold');
    return true;
  },

  // the milestones that are not tied to one specific trade
  checkUnlocks(){
    const nw = netWorth();
    if(nw > 10_000_000) this.unlockTitle('magnate');
    if(nw > 100_000_000) this.unlockTitle('diamante');
    if(state.level >= 40) this.unlockTitle('tiburon');
    if(sectorsHeld().size >= 5) this.unlockTitle('diverso');
    if((state.stats.bestStreak || 0) >= 10) this.unlockTitle('bola');
    if((state.stats.timesBankrupt || 0) > 0 && nw > 100_000) this.unlockTitle('fenix');
  },

  refreshAvatar(){
    const avatar = document.getElementById('railAvatar');
    if(avatar){
      avatar.textContent = profile.avatar || '🎯';
      avatar.style.background = AVATAR_COLORS[profile.avatarColor] || AVATAR_COLORS[0];
    }
    const hudAvatar = document.getElementById('hudAvatar');
    if(hudAvatar) hudAvatar.textContent = profile.avatar || '🎯';
  },
};

// the header / rail read this at boot so the chosen emoji survives a reload
function refreshAvatarVisuals(){
  Profile.refreshAvatar();
}

// a compact inline sparkline of the net worth samples the state keeps
function netSparkline(){
  const points = (state.netHistory || []).filter(p => Number.isFinite(p.net));
  if(points.length < 2) return '<div class="mini-empty">Aún sin muestras de patrimonio.</div>';
  const values = points.map(p => p.net);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 260, h = 48;
  const step = w / (values.length - 1);
  const path = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  const stroke = up ? 'var(--up)' : 'var(--down)';
  return `
    <svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Curva de patrimonio">
      <path d="${path}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round"/>
    </svg>
    <div class="spark-legend mono">
      <span>mín ${money(min)}</span><span>máx ${money(max)}</span>
    </div>`;
}

function profileStatsContent(){
  const wr = winRatePct();
  const dd = maxDrawdownPct();
  const avgHold = averageHoldLabel();
  return `
    <div class="profile-stats">
      <div><span>Patrimonio</span><strong class="mono">${money(netWorth())}</strong></div>
      <div><span>Nivel</span><strong class="mono">${state.level}</strong></div>
      <div><span>Operaciones</span><strong class="mono">${state.stats.totalTrades}</strong></div>
      <div><span>Winrate</span><strong class="mono">${wr === null ? '—' : `${wr.toFixed(0)}%`}</strong></div>
      <div><span>Racha actual</span><strong class="mono">${state.stats.currentStreak || 0} 🔥</strong></div>
      <div><span>Mejor racha</span><strong class="mono">${state.stats.bestStreak || 0}</strong></div>
      <div><span>Mejor día</span><strong class="mono pos">${(state.stats.bestDayReturn || 0).toFixed(1)}%</strong></div>
      <div><span>Drawdown máx</span><strong class="mono neg">${dd === null ? '—' : `${dd.toFixed(1)}%`}</strong></div>
      <div><span>Tiempo medio en posición</span><strong class="mono">${avgHold}</strong></div>
      <div><span>Logros</span><strong class="mono">${typeof Achievements !== 'undefined' ? `${Achievements.progress().done}/${Achievements.progress().total}` : '—'}</strong></div>
    </div>
    <div class="profile-spark">
      <h4>Patrimonio (últimas muestras)</h4>
      ${netSparkline()}
    </div>`;
}

// how long a closed trade was held, averaged: the timestamps are wall clock, so
// this is real time spent in the market for this session's trades
function averageHoldLabel(){
  const held = (state.transactions || []).filter(t => t && t.heldMs > 0);
  if(!held.length) return '—';
  const total = held.reduce((sum, t) => sum + t.heldMs, 0);
  const mins = Math.round(total / held.length / 60000);
  if(mins < 60) return `${mins} min`;
  return `${(mins / 60).toFixed(1)} h`;
}

function profileContent(){
  const signedIn = typeof MarketNet !== 'undefined' && MarketNet.signedIn;
  const account = signedIn ? MarketNet.accountName
    : (typeof MarketNet !== 'undefined' && MarketNet.isGuest ? 'invitado' : 'sin sesión');
  const title = Profile.titleName(profile.title);
  const member = signedIn && MarketNet.account && MarketNet.account.createdAt
    ? new Date(MarketNet.account.createdAt).toLocaleDateString('es-MX', { day:'2-digit', month:'short', year:'numeric' })
    : null;
  const boost = typeof xpBoostActive === 'function' ? xpBoostActive() : null;
  return `
    <div class="profile-card">
      <div class="profile-banner" style="background:${PROFILE_BANNERS[profile.banner] || PROFILE_BANNERS[0]}"></div>
      <div class="profile-avatar-wrap">
        <div class="profile-avatar" style="background:${AVATAR_COLORS[profile.avatarColor] || AVATAR_COLORS[0]}">${profile.avatar}</div>
      </div>
      <div class="profile-meta">
        <h3>${account}</h3>
        <span class="profile-title">${title}</span>
        ${member ? `<span class="profile-since">Miembro desde ${member}</span>` : ''}
        ${boost ? `<span class="profile-boost">⚡ XP ×${boost.mult.toFixed(1)} activo</span>` : ''}
      </div>
      <p class="profile-bio">${profile.bio ? escapeHtml(profile.bio) : '<em>Sin bio. Toca "Editar perfil" para escribir una.</em>'}</p>
      ${profileStatsContent()}
      <div class="profile-actions">
        <button class="nav-modal-btn" id="pEditBtn">✏️ Editar perfil</button>
        <button class="nav-modal-btn" id="pRankBtn">🏆 Ver ranking</button>
        <button class="nav-modal-btn" id="pCasesBtn">🎁 Cajas de mercado</button>
        <button class="nav-modal-btn ${signedIn ? 'danger' : ''}" id="profileSessionBtn">
          ${signedIn ? 'Cerrar sesión' : 'Iniciar sesión'}
        </button>
      </div>
    </div>`;
}

function profileEditContent(){
  return `
    <div class="pe-section">
      <label class="pe-label">Avatar</label>
      <div class="pe-avatars">${AVATARS.map(a => `
        <button class="pe-av ${a === profile.avatar ? 'is-active' : ''}" data-av="${a}">${a}</button>`).join('')}</div>

      <label class="pe-label">Color del avatar</label>
      <div class="pe-colors">${AVATAR_COLORS.map((c, i) => `
        <button class="pe-col ${i === profile.avatarColor ? 'is-active' : ''}" data-col="${i}" style="background:${c}" aria-label="Color ${i + 1}"></button>`).join('')}</div>

      <label class="pe-label">Banner</label>
      <div class="pe-banners">${PROFILE_BANNERS.map((b, i) => `
        <button class="pe-ban ${i === profile.banner ? 'is-active' : ''}" data-ban="${i}" style="background:${b}" aria-label="Banner ${i + 1}"></button>`).join('')}</div>

      <label class="pe-label">Título</label>
      <div class="pe-titles">${PROFILE_TITLES.map(t => {
        const locked = !profile.unlockedTitles.includes(t.id);
        return `<button class="pe-title ${t.id === profile.title ? 'is-active' : ''} ${locked ? 'is-locked' : ''}"
                        data-title="${t.id}" ${locked ? 'disabled' : ''} title="${t.desc}">
          ${locked ? '🔒 ' : ''}${t.name}</button>`;
      }).join('')}</div>

      <label class="pe-label">Bio (máx. 120)</label>
      <input id="peBio" class="pe-input" maxlength="120" value="${escapeHtml(profile.bio)}">

      <label class="pe-label">Privacidad</label>
      <select id="pePrivacy" class="pe-input">
        <option value="public" ${profile.privacy === 'public' ? 'selected' : ''}>Pública</option>
        <option value="friends" ${profile.privacy === 'friends' ? 'selected' : ''}>Sólo amigos</option>
        <option value="private" ${profile.privacy === 'private' ? 'selected' : ''}>Privada</option>
      </select>

      <label class="pe-label">Tienda de cosméticos <em id="shopCash" class="mono" style="font-style:normal;color:var(--gold)"></em></label>
      <div class="shop-grid" id="shopGrid"><div class="mini-empty">Cargando tienda…</div></div>
    </div>
    <div class="pe-actions">
      <button class="nav-modal-btn" id="peSave">Guardar</button>
    </div>`;
}

function bindProfileEvents(body){
  if(!body) return;
  const on = (id, event, fn) => { const el = body.querySelector(id); if(el) el.addEventListener(event, fn); };

  on('#pEditBtn', 'click', () => {
    openNavModal('Editar perfil', profileEditContent());
    bindProfileEditEvents(document.getElementById('navModalBody'));
  });
  on('#pRankBtn', 'click', async () => {
    openNavModal('Ranking global', '<div class="mini-empty">Cargando ranking…</div>');
    if(typeof Leaderboard !== 'undefined'){
      await Leaderboard.fetch(true);
      const target = document.getElementById('navModalBody');
      target.innerHTML = leaderboardContent();
      Leaderboard.bind(target);
    }
  });
  on('#pCasesBtn', 'click', () => {
    closeNavModal();
    if(typeof CaseGame !== 'undefined') CaseGame.show();
  });
  on('#profileSessionBtn', 'click', () => {
    if(typeof MarketNet !== 'undefined' && MarketNet.signedIn){
      closeNavModal();
      MarketNet.logout().then(() => {
        toast('Sesión cerrada', 'Puedes volver a entrar o jugar como invitado.', 'gold');
        openAuthModal('login');
      });
    } else {
      openAuthModal('login');
    }
  });
}

function bindProfileEditEvents(body){
  if(!body) return;
  const pick = (selector, attr, apply) => {
    const wrap = body.querySelector(selector);
    if(!wrap) return;
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest(`[data-${attr}]`);
      if(!btn || btn.disabled) return;
      apply(btn.dataset[attr]);
      wrap.querySelectorAll('button').forEach(x => x.classList.toggle('is-active', x === btn));
    });
  };
  pick('.pe-avatars', 'av', v => { profile.avatar = v; });
  pick('.pe-colors', 'col', v => { profile.avatarColor = parseInt(v, 10) || 0; });
  pick('.pe-banners', 'ban', v => { profile.banner = parseInt(v, 10) || 0; });

  const titles = body.querySelector('.pe-titles');
  if(titles){
    titles.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-title]');
      if(!btn || btn.disabled) return;
      profile.title = btn.dataset.title;
      titles.querySelectorAll('.pe-title').forEach(x => x.classList.toggle('is-active', x === btn));
    });
  }

  const save = body.querySelector('#peSave');
  if(save) save.addEventListener('click', () => {
    const bio = body.querySelector('#peBio');
    const privacy = body.querySelector('#pePrivacy');
    if(bio) profile.bio = bio.value.slice(0, 120);
    if(privacy) profile.privacy = privacy.value;
    // la tienda valida del lado server: si el avatar premium no es tuyo, cae
    // al default al guardar. el marco se equipa por su propia ruta.
    Profile.save();
    toast('Perfil guardado', 'Tus cambios se aplicaron', 'up');
    closeNavModal();
  });

  bindShopSection(body);
}

// ---- la tienda de cosméticos ---------------------------------------------
// vive dentro del editor de perfil. con sesión, comprar y equipar son llamadas
// al server (el inventario vive en la cuenta); invitado, la tienda se muestra
// pero la compra avisa que necesita sesión, porque el inventario es del server.
let shopState = { items: [], owned: [], ring: null };

async function refreshShopState(){
  if(typeof MarketNet === 'undefined' || !MarketNet.signedIn) return null;
  try {
    const data = await MarketNet.request('/api/market/shop');
    if(data?.items) shopState = { items: data.items, owned: data.owned || [], ring: data.ring || null };
    if(Number.isFinite(data?.cash)) state.cash = data.cash;
    return shopState;
  } catch(e){ return null; }
}

function shopGridHtml(){
  const items = shopState.items || [];
  if(!items.length) return '<div class="mini-empty">Tienda no disponible en modo invitado.</div>';
  return items.map(item => {
    const owned = shopState.owned.includes(item.id);
    const equipped = shopState.ring === item.id;
    const canAfford = (Number(state.cash) || 0) >= item.price;
    return `
      <div class="shop-item ${owned ? 'is-owned' : ''}" data-id="${item.id}">
        <span class="shop-item-icon" ${item.kind === 'ring' && item.color ? `style="border-color:${item.color}"` : ''}>${item.icon || '⭕'}</span>
        <strong>${item.name}</strong>
        <span class="shop-item-kind">${item.kind === 'avatar' ? 'avatar' : 'marco'}</span>
        ${owned
          ? (item.kind === 'ring'
            ? `<button class="shop-btn ${equipped ? 'is-equipped' : ''}" data-equip="${item.id}">${equipped ? 'Equipado' : 'Equipar'}</button>`
            : '<em class="shop-owned-tag">En tu armario</em>')
          : `<button class="shop-btn" data-buy="${item.id}" ${canAfford ? '' : 'disabled'}>${money(item.price)}</button>`}
      </div>`;
  }).join('');
}

async function renderShopGrid(body){
  const grid = body.querySelector('#shopGrid');
  if(!grid) return;
  const state0 = await refreshShopState();
  if(!state0){
    grid.innerHTML = '<div class="mini-empty">Inicia sesión para usar la tienda: el inventario vive en tu cuenta.</div>';
    const cashEl = body.querySelector('#shopCash');
    if(cashEl) cashEl.textContent = '';
    return;
  }
  grid.innerHTML = shopGridHtml();
  const cashEl = body.querySelector('#shopCash');
  if(cashEl) cashEl.textContent = `· efectivo ${money(state.cash)}`;

  grid.querySelectorAll('[data-buy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const data = await MarketNet.request('/api/market/shop/buy', {
          method: 'POST',
          body: JSON.stringify({ id: btn.dataset.buy }),
        });
        if(data?.ok){
          if(Number.isFinite(data.cash)) { state.cash = data.cash; if(typeof updateHud === 'function') updateHud(); }
          if(typeof Sound !== 'undefined') Sound.play('cashIn');
          toast('🛍️ Tienda', `“${data.item.name}” es tuyo`, 'up');
          pushNotification('🛍️ Tienda', `compraste ${data.item.name}`, 'gold');
          await renderShopGrid(body);
        } else {
          toast('Tienda', data?.error || 'no se pudo comprar', 'down');
          if(typeof Sound !== 'undefined') Sound.play('loss');
          btn.disabled = false;
        }
      } catch(e){
        toast('Tienda', e?.message || 'no se pudo comprar', 'down');
        btn.disabled = false;
      }
    });
  });

  grid.querySelectorAll('[data-equip]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        const data = await MarketNet.request('/api/market/shop/equip', {
          method: 'POST',
          body: JSON.stringify({ id: btn.dataset.equip }),
        });
        if(data?.ok){
          if(typeof Sound !== 'undefined') Sound.play('click');
          await renderShopGrid(body);
        } else {
          toast('Tienda', data?.error || 'no se pudo equipar', 'down');
        }
      } catch(e){
        toast('Tienda', e?.message || 'no se pudo equipar', 'down');
      }
    });
  });
}

function bindShopSection(body){
  renderShopGrid(body);
}
