// chat de owngames — widget COMPARTIDO por los dos juegos y por el shell de lyra.
//
// Se autocontiene: lee la misma sesión del market que la bolsa/opencase
// (token de market en localStorage, o la sesión SSO de cloud sync vía /me) y
// habla con /api/market/chat/*. Abre su propio WebSocket a /ws/market para
// recibir mensajes en vivo; si el socket falla, cae a sondeo cada 4s.
//
// Dos modos:
//   · normal  -> botón flotante + panel anclado a la DERECHA (no bloquea abajo)
//   · ?embed=1 -> sin botón: el panel llena el contenedor (se incrusta en lyra)
(() => {
  'use strict';

  const TOKEN_KEY = 'bolsa-market-token';
  const NAME_KEY = 'bolsa-market-name';
  const LEGAL_KEY = 'lyra-chat-legal-v1';
  const EMBED = new URLSearchParams(location.search).has('embed');

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const token = () => localStorage.getItem(TOKEN_KEY) || '';
  const storedName = () => localStorage.getItem(NAME_KEY) || '';

  // ---------------------------------------------------------------- formato
  const fmtTime = (at) => {
    if (!at) return '';
    try {
      return new Date(at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };
  const dayKey = (at) => {
    const d = new Date(at || Date.now());
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  const fmtDay = (at) => {
    const d = new Date(at || Date.now());
    const now = new Date();
    const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
    if (diff <= 0) return 'Hoy';
    if (diff === 1) return 'Ayer';
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
  };
  const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
  const hueOf = (name) => {
    let h = 0;
    const s = String(name || '');
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  };
  const avatarStyle = (name) => `--av-h:${hueOf(name)}`;

  // sesión resuelta al abrir: token de market o SSO de cloud sync (que no deja
  // token en localStorage: la cookie `token` es httpOnly). Por eso se pregunta
  // a /me, igual que hacen los juegos.
  let sessionName = '';
  const currentName = () => sessionName || storedName();

  async function api(path, opts = {}) {
    const headers = {};
    if (opts.body) headers['Content-Type'] = 'application/json';
    if (token()) headers.Authorization = `Bearer ${token()}`;
    const res = await fetch('/api/market' + path, {
      method: opts.method || 'GET',
      headers,
      credentials: 'same-origin',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const err = new Error((await res.json().catch(() => ({}))).error || `error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  const state = {
    open: false,
    channels: [],
    active: 'global',
    messages: [],
    friends: { friends: [], requests: [] },
    players: [],
    ws: null,
    pollTimer: null,
    unread: 0,
    unreadByChannel: {},
  };

  let btn, panel, listEl, msgEl, inputEl, statusEl, legalEl, modalEl;

  // ---------------------------------------------------------------- DOM
  function build() {
    if (!EMBED) {
      btn = document.createElement('button');
      btn.id = 'lyraChatBtn';
      btn.className = 'lyra-chat-fab';
      btn.innerHTML = '💬 <span class="lyra-chat-fab-label">Chat</span> <span class="lyra-chat-badge" hidden></span>';
      btn.addEventListener('click', () => (state.open ? close() : open()));
      document.body.appendChild(btn);
    }

    panel = document.createElement('div');
    panel.id = 'lyraChatPanel';
    panel.className = `lyra-chat-panel${EMBED ? ' is-embedded' : ''}`;
    panel.innerHTML = `
      <header class="lyra-chat-head">
        <span class="lyra-chat-head-icon">💬</span>
        <div class="lyra-chat-head-text">
          <strong>Chat de owngames</strong>
          <span class="lyra-chat-me"></span>
        </div>
        ${EMBED ? '' : '<button class="lyra-chat-x" title="Cerrar" aria-label="Cerrar chat">✕</button>'}
      </header>
      <div class="lyra-chat-body">
        <aside class="lyra-chat-side">
          <div class="lyra-chat-side-actions">
            <button data-act="dm" title="Nuevo mensaje directo">✉ <span>DM</span></button>
            <button data-act="group" title="Nuevo grupo">👥 <span>Grupo</span></button>
            <button data-act="friends" title="Amigos">⭐ <span>Amigos</span></button>
          </div>
          <div id="lyraChatChannels" class="lyra-chat-channels"></div>
        </aside>
        <section class="lyra-chat-main">
          <div id="lyraChatTitle" class="lyra-chat-title"><span class="lyra-chat-title-name">Global</span></div>
          <div id="lyraChatMessages" class="lyra-chat-messages"></div>
          <form id="lyraChatForm" class="lyra-chat-form">
            <input id="lyraChatInput" type="text" maxlength="500" placeholder="Escribe un mensaje…" autocomplete="off">
            <button type="submit" title="Enviar" aria-label="Enviar">➤</button>
          </form>
          <div id="lyraChatStatus" class="lyra-chat-status"></div>
        </section>
      </div>`;
    document.body.appendChild(panel);

    modalEl = document.createElement('div');
    modalEl.id = 'lyraChatModal';
    modalEl.className = 'lyra-chat-modal';
    document.body.appendChild(modalEl);

    legalEl = document.createElement('div');
    legalEl.id = 'lyraChatLegal';
    legalEl.className = 'lyra-chat-legal';
    legalEl.innerHTML = `
      <div class="lyra-chat-legal-box">
        <h3>⚠️ Chat: seguridad y reglas</h3>
        <p>Este chat es para jugadores. No compartas datos personales, tu escuela, tu dirección ni nada que te identifique.</p>
        <p class="lyra-chat-legal-red">Tus conversaciones se <b>guardan y las analiza el staff</b>. Si promueves contenido indecente —o cualquier cosa que ponga en riesgo a menores— tu cuenta podrá ser <b>suspendida permanentemente junto con todos tus objetos e ítems recolectados</b>, sin probabilidad de recuperación.</p>
        <label><input type="checkbox" id="lyraChatLegalOk"> Entiendo y acepto las reglas</label>
        <button id="lyraChatLegalGo" disabled>Entrar al chat</button>
      </div>`;
    document.body.appendChild(legalEl);

    listEl = document.getElementById('lyraChatChannels');
    msgEl = document.getElementById('lyraChatMessages');
    inputEl = document.getElementById('lyraChatInput');
    statusEl = document.getElementById('lyraChatStatus');

    const x = panel.querySelector('.lyra-chat-x');
    if (x) x.addEventListener('click', close);
    panel.querySelector('[data-act="dm"]').addEventListener('click', () => openForm('dm'));
    panel.querySelector('[data-act="group"]').addEventListener('click', () => openForm('group'));
    panel.querySelector('[data-act="friends"]').addEventListener('click', () => openForm('friends'));
    document.getElementById('lyraChatForm').addEventListener('submit', (e) => {
      e.preventDefault();
      send();
    });
    const okBox = document.getElementById('lyraChatLegalOk');
    const goBtn = document.getElementById('lyraChatLegalGo');
    okBox.addEventListener('change', () => { goBtn.disabled = !okBox.checked; });
    goBtn.addEventListener('click', () => {
      try { localStorage.setItem(LEGAL_KEY, '1'); } catch {}
      legalEl.classList.remove('is-visible');
    });

    if (EMBED) open();
  }

  async function ensureSession() {
    if (token()) {
      sessionName = storedName();
      return true;
    }
    try {
      const res = await fetch('/api/market/me', { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.account && data.account.name) {
          sessionName = data.account.name;
          return true;
        }
      }
    } catch {}
    return false;
  }

  async function open() {
    const ok = await ensureSession();
    if (!ok) {
      if (EMBED) {
        setStatus('Inicia sesión con tu cuenta (cloud sync o del market) para usar el chat.');
        return;
      }
      setStatus('Inicia sesión (cloud sync o market) para usar el chat.');
      alert('Inicia sesión (con tu cuenta de cloud sync o del market) para usar el chat.');
      return;
    }
    state.open = true;
    panel.classList.add('is-visible');
    panel.querySelector('.lyra-chat-me').textContent = currentName() ? `tú: ${currentName()}` : '';
    state.unread = 0;
    updateBadge();
    if (localStorage.getItem(LEGAL_KEY) !== '1' && !EMBED) legalEl.classList.add('is-visible');
    loadChannels();
    refreshPeople(); // deja listos amigos y jugadores en línea para los formularios
    startLive();
  }

  function close() {
    state.open = false;
    panel.classList.remove('is-visible');
  }

  function updateBadge() {
    if (!btn) return;
    const badge = btn.querySelector('.lyra-chat-badge');
    if (state.unread > 0) {
      badge.hidden = false;
      badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
    } else {
      badge.hidden = true;
    }
  }

  // ---------------------------------------------------------------- datos

  async function loadChannels() {
    try {
      const d = await api('/chat/channels');
      state.channels = d.channels || [];
      if (!state.channels.some((c) => c.id === state.active)) state.active = 'global';
      renderChannels();
      await loadMessages();
    } catch (e) {
      setStatus('No se pudo cargar el chat: ' + e.message);
    }
  }

  function renderChannels() {
    listEl.innerHTML = state.channels
      .map((c) => {
        const icon = c.kind === 'global' ? '🌐' : c.kind === 'dm' ? '✉' : '👥';
        const label = c.kind === 'global' ? 'Global' : c.title || (c.kind === 'dm' ? 'DM' : 'Grupo');
        const unread = state.unreadByChannel[c.id] || 0;
        return `<button class="lyra-chat-channel ${c.id === state.active ? 'is-active' : ''}" data-ch="${esc(c.id)}">
          <span class="lyra-chat-channel-icon">${icon}</span>
          <span class="lyra-chat-channel-label">${esc(label)}</span>
          ${unread ? `<span class="lyra-chat-cbadge">${unread > 9 ? '9+' : unread}</span>` : ''}
        </button>`;
      })
      .join('');
    listEl.querySelectorAll('[data-ch]').forEach((b) => {
      b.addEventListener('click', () => {
        state.active = b.dataset.ch;
        state.unreadByChannel[state.active] = 0;
        renderChannels();
        loadMessages();
      });
    });
  }

  function activeChannel() {
    return state.channels.find((c) => c.id === state.active) || { id: 'global', kind: 'global', title: 'Global' };
  }

  async function loadMessages() {
    const ch = activeChannel();
    const name = ch.kind === 'global' ? 'Global' : ch.title || (ch.kind === 'dm' ? 'Chat' : 'Grupo');
    const sub =
      ch.kind === 'dm' ? 'mensaje directo'
        : ch.kind === 'group' ? `${(ch.members || []).length} miembros`
          : 'todos los jugadores';
    document.getElementById('lyraChatTitle').innerHTML =
      `<span class="lyra-chat-title-name">${esc(name)}</span><span class="lyra-chat-title-sub">${esc(sub)}</span>`;
    try {
      const d = await api(`/chat/messages?channel=${encodeURIComponent(state.active)}&since=0`);
      state.messages = d.messages || [];
      state.unreadByChannel[state.active] = 0;
      renderMessages();
      scrollBottom(true);
      updateBadge();
      renderChannels();
    } catch (e) {
      setStatus('No se pudieron cargar los mensajes: ' + e.message);
    }
  }

  function renderMessages() {
    if (!state.messages.length) {
      msgEl.innerHTML = '<div class="lyra-chat-empty">Sin mensajes todavía.<br>Sé el primero en escribir 👋</div>';
      return;
    }
    const me = currentName().toLowerCase();
    let html = '';
    let lastDay = '';
    let lastAuthor = '';
    let lastAt = 0;
    for (const m of state.messages) {
      const day = dayKey(m.at);
      if (day !== lastDay) {
        html += `<div class="lyra-chat-day"><span>${esc(fmtDay(m.at))}</span></div>`;
        lastDay = day;
        lastAuthor = '';
      }
      const mine = m.authorKey === me;
      const grouped = !mine && m.authorKey === lastAuthor && m.at - lastAt < 4 * 60 * 1000;
      html += `<div class="lyra-chat-msg ${mine ? 'is-mine' : 'is-other'}${grouped ? ' is-grouped' : ''}">
        ${mine ? '' : `<span class="lyra-chat-avatar" style="${avatarStyle(m.author)}" aria-hidden="true">${esc(initial(m.author))}</span>`}
        <div class="lyra-chat-bubble">
          ${!mine && !grouped ? `<span class="lyra-chat-author">${esc(m.author)}</span>` : ''}
          <span class="lyra-chat-text">${esc(m.text)}</span>
          <span class="lyra-chat-time">${esc(fmtTime(m.at))}</span>
        </div>
      </div>`;
      lastAuthor = m.authorKey;
      lastAt = m.at || 0;
    }
    msgEl.innerHTML = html;
  }

  function appendMessage(m) {
    if (state.messages.some((x) => x.id === m.id)) return;
    const atBottom = msgEl.scrollHeight - msgEl.scrollTop - msgEl.clientHeight < 120;
    state.messages.push(m);
    if (state.messages.length > 300) state.messages.shift();
    renderMessages();
    if (atBottom) scrollBottom(true);
  }

  function scrollBottom(force) {
    if (force) msgEl.scrollTop = msgEl.scrollHeight;
  }

  function setStatus(text) {
    statusEl.textContent = text || '';
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    try {
      await api('/chat/send', { method: 'POST', body: { channel: state.active, text } });
    } catch (e) {
      setStatus('No se pudo enviar: ' + e.message);
      inputEl.value = text;
    }
  }

  // ---------------------------------------------------------------- formularios
  // Cada acción abre un formulario DENTRO del panel (no un prompt del navegador).

  function openForm(kind) {
    if (kind === 'dm') return formDm();
    if (kind === 'group') return formGroup();
    if (kind === 'friends') return formFriends();
  }

  function closeModal() {
    modalEl.classList.remove('is-visible');
    modalEl.innerHTML = '';
  }

  function showModal(html) {
    modalEl.innerHTML = `<div class="lyra-chat-modal-box">${html}</div>`;
    modalEl.classList.add('is-visible');
    modalEl.onclick = (e) => { if (e.target === modalEl) closeModal(); };
  }

  function playerOptions(names) {
    return names.map((n) => `<option value="${esc(n)}"></option>`).join('');
  }

  async function refreshPeople() {
    try {
      state.friends = await api('/chat/friends');
    } catch {
      state.friends = { friends: [], requests: [] };
    }
    try {
      const d = await api('/players/online');
      state.players = (d.players || []).map((p) => p.name).filter((n) => n !== currentName());
    } catch {
      state.players = [];
    }
  }

  async function formDm() {
    await refreshPeople();
    const names = [...new Set([...state.friends.friends.map((f) => f.name), ...state.players])];
    showModal(`
      <h3>Nuevo mensaje directo</h3>
      <p class="lyra-chat-modal-hint">Elige un amigo o jugador en línea, o escribe su nombre exacto.</p>
      <input id="lyraDmName" list="lyraDmList" placeholder="nombre del jugador" autocomplete="off" class="mono">
      <datalist id="lyraDmList">${playerOptions(names)}</datalist>
      ${names.length ? `<div class="lyra-chat-people">${names.map((n) => `<button type="button" class="lyra-chat-person" data-pick="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : '<p class="lyra-chat-modal-hint">No hay jugadores en línea. Escribe el nombre.</p>'}
      <div class="lyra-chat-modal-actions">
        <button class="ghost" data-close>Cancelar</button>
        <button id="lyraDmGo">Abrir DM</button>
      </div>`);
    const input = document.getElementById('lyraDmName');
    input.focus();
    modalEl.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { input.value = b.dataset.pick; }));
    modalEl.querySelector('[data-close]').addEventListener('click', closeModal);
    document.getElementById('lyraDmGo').addEventListener('click', async () => {
      const name = input.value.trim();
      if (!name) return;
      try {
        const d = await api('/chat/channels', { method: 'POST', body: { kind: 'dm', with: name } });
        closeModal();
        await loadChannels();
        state.active = d.channel.id;
        renderChannels();
        loadMessages();
      } catch (e) {
        setStatus('No se pudo abrir el DM: ' + e.message);
      }
    });
  }

  async function formGroup() {
    await refreshPeople();
    const friends = state.friends.friends.map((f) => f.name);
    showModal(`
      <h3>Nuevo grupo</h3>
      <input id="lyraGroupTitle" placeholder="nombre del grupo (ej. Trading, Minecraft…)" maxlength="40">
      <p class="lyra-chat-modal-hint">Marca a quién invitar. Puedes agregar más después.</p>
      <div class="lyra-chat-people">
        ${friends.length ? friends.map((n) => `<label class="lyra-chat-check"><input type="checkbox" value="${esc(n)}"> ${esc(n)}</label>`).join('') : '<p class="lyra-chat-modal-hint">Aún no tienes amigos agregados.</p>'}
      </div>
      <input id="lyraGroupExtra" placeholder="otros miembros (separados por coma)" autocomplete="off">
      <div class="lyra-chat-modal-actions">
        <button class="ghost" data-close>Cancelar</button>
        <button id="lyraGroupGo">Crear grupo</button>
      </div>`);
    modalEl.querySelector('[data-close]').addEventListener('click', closeModal);
    document.getElementById('lyraGroupGo').addEventListener('click', async () => {
      const title = document.getElementById('lyraGroupTitle').value.trim();
      if (!title) { setStatus('Ponle nombre al grupo'); return; }
      const picked = [...modalEl.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
      const extra = document.getElementById('lyraGroupExtra').value.split(',').map((n) => n.trim()).filter(Boolean);
      const members = [...new Set([...picked, ...extra])];
      try {
        const d = await api('/chat/channels', { method: 'POST', body: { kind: 'group', title, members } });
        closeModal();
        await loadChannels();
        state.active = d.channel.id;
        renderChannels();
        loadMessages();
      } catch (e) {
        setStatus('No se pudo crear el grupo: ' + e.message);
      }
    });
  }

  async function formFriends() {
    await refreshPeople();
    const { friends, requests } = state.friends;
    showModal(`
      <h3>Amigos</h3>
      <p class="lyra-chat-modal-hint">Solicitudes pendientes</p>
      <div class="lyra-chat-people">
        ${requests.length ? requests.map((n) => `
          <span class="lyra-chat-person-line">${esc(n)}
            <button type="button" data-accept="${esc(n)}">Aceptar</button>
          </span>`).join('') : '<p class="lyra-chat-modal-hint">Ninguna.</p>'}
      </div>
      <p class="lyra-chat-modal-hint">Tus amigos</p>
      <div class="lyra-chat-people">
        ${friends.length ? friends.map((f) => `
          <span class="lyra-chat-person-line">${esc(f.name)} ${f.online ? '🟢' : ''}
            <button type="button" class="ghost" data-remove="${esc(f.name)}">Quitar</button>
          </span>`).join('') : '<p class="lyra-chat-modal-hint">Aún no tienes amigos.</p>'}
      </div>
      <div class="lyra-chat-addfriend">
        <input id="lyraFriendName" placeholder="nombre exacto del jugador" autocomplete="off" class="mono">
        <button id="lyraFriendAdd">Añadir</button>
      </div>
      <div class="lyra-chat-modal-actions">
        <button class="ghost" data-close>Cerrar</button>
      </div>`);
    modalEl.querySelector('[data-close]').addEventListener('click', closeModal);
    modalEl.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', async () => {
      await api('/chat/friends', { method: 'POST', body: { action: 'accept', name: b.dataset.accept } }).catch(() => {});
      formFriends();
    }));
    modalEl.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
      await api('/chat/friends', { method: 'POST', body: { action: 'remove', name: b.dataset.remove } }).catch(() => {});
      formFriends();
    }));
    document.getElementById('lyraFriendAdd').addEventListener('click', async () => {
      const name = document.getElementById('lyraFriendName').value.trim();
      if (!name) return;
      try {
        await api('/chat/friends', { method: 'POST', body: { action: 'request', name } });
        formFriends();
      } catch (e) {
        setStatus('No se pudo enviar la solicitud: ' + e.message);
      }
    });
  }

  // ---------------------------------------------------------------- tiempo real

  function startLive() {
    stopLive();
    setupSocket();
    state.pollTimer = setInterval(() => {
      if (state.open) loadMessages().catch(() => {});
    }, 4000);
  }

  function stopLive() {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
    try { if (state.ws) { state.ws.onclose = null; state.ws.close(); } } catch {}
    state.ws = null;
  }

  function setupSocket() {
    if (typeof WebSocket === 'undefined') return;
    // con token de market viaja en cookie para el handshake; con SSO la cookie
    // httpOnly `token` de cloudsync ya viaja sola, así que NO se toca.
    const value = token();
    if (value) {
      document.cookie = `lyra_market_token=${encodeURIComponent(value)}; Path=/; Max-Age=2592000; SameSite=Strict`;
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      // `skip`: este socket sólo consume chat; el mercado deja de mandarle el
      // frame `tick` (~4.8 KB/s) y el snapshot inicial, que descartaba igual.
      state.ws = new WebSocket(`${proto}//${location.host}/ws/market?skip=tick,snapshot`);
    } catch {
      return;
    }
    state.ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'chat' && msg.message) {
        if (state.open && msg.channel === state.active) {
          appendMessage(msg.message);
        } else {
          state.unreadByChannel[msg.channel] = (state.unreadByChannel[msg.channel] || 0) + 1;
          state.unread += 1;
          updateBadge();
          renderChannels();
        }
      } else if (msg.type === 'chat-channel') {
        loadChannels().catch(() => {});
      }
    };
    state.ws.onclose = () => { state.ws = null; };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
