// account UI: create account / sign in against the market service, then hydrate
// the player's persisted portfolio (cash, positions and statistics).

let authMode = 'login';
let authBusy = false;
let authConnection = 'offline';

function initialsFor(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) return 'JD';
  const parts = cleaned.split(/[\s_.-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

function setAuthError(message) {
  const box = document.getElementById('authError');
  if (!box) return;
  box.textContent = message || '';
  box.classList.toggle('is-visible', Boolean(message));
}

function setAuthMode(mode) {
  authMode = mode === 'register' ? 'register' : 'login';
  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.authTab === authMode);
  });
  const confirmField = document.getElementById('authConfirmField');
  if (confirmField) confirmField.classList.toggle('is-visible', authMode === 'register');
  const submit = document.getElementById('authSubmit');
  if (submit) submit.textContent = authMode === 'register' ? 'Crear cuenta' : 'Iniciar sesión';
  setAuthError('');
}

function setAuthBusy(busy) {
  authBusy = busy;
  const submit = document.getElementById('authSubmit');
  if (submit) {
    submit.disabled = busy;
    submit.textContent = busy
      ? 'Conectando...'
      : authMode === 'register'
        ? 'Crear cuenta'
        : 'Iniciar sesión';
  }
}

function openAuthModal(mode = 'login') {
  const overlay = document.getElementById('authOverlay');
  if (!overlay) return;
  setAuthMode(mode);
  overlay.classList.add('is-visible');
  const input = document.getElementById('authName');
  if (input) setTimeout(() => input.focus(), 60);
}

function closeAuthModal() {
  const overlay = document.getElementById('authOverlay');
  if (overlay) overlay.classList.remove('is-visible');
}

function authModalOpen() {
  const overlay = document.getElementById('authOverlay');
  return Boolean(overlay && overlay.classList.contains('is-visible'));
}

async function refreshAccountFromServer() {
  if (!MarketNet.signedIn) return;
  try {
    const portfolio = await MarketNet.fetchPortfolio();
    if (portfolio) {
      applyServerPortfolio(portfolio);
      // the same payload carries the saved profile and the earned titles, so the
      // avatar and the bio survive a reinstall (the server copy wins here)
      if (typeof Profile !== 'undefined' && MarketNet.account && MarketNet.account.profile) {
        Profile.fromServer(MarketNet.account.profile);
      }
      saveGame();
      // the account payload just arrived, so this is the moment the admin flag
      // (and the rail button) becomes known on a reload
      onMarketSessionChange();
      toast('Progreso cargado', 'Tus posiciones y estadísticas están al día.', 'gold');
    }
  } catch (error) {
    if (error && error.status === 401) {
      MarketNet.clearAccount();
      openAuthModal('login');
      setAuthError('tu sesión expiró, vuelve a entrar');
    }
  }
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (authBusy) return;

  const name = (document.getElementById('authName') || {}).value || '';
  const password = (document.getElementById('authPassword') || {}).value || '';
  const confirm = (document.getElementById('authConfirm') || {}).value || '';

  if (!name.trim() || !password) {
    setAuthError('escribe tu nombre y tu contraseña');
    return;
  }
  if (authMode === 'register' && password !== confirm) {
    setAuthError('las contraseñas no coinciden');
    return;
  }

  setAuthBusy(true);
  setAuthError('');
  try {
    if (authMode === 'register') {
      await MarketNet.register(name.trim(), password);
    } else {
      await MarketNet.login(name.trim(), password);
    }
    closeAuthModal();
    MarketNet.connect();
    await refreshAccountFromServer();
    toast(
      authMode === 'register' ? 'Cuenta creada' : 'Sesión iniciada',
      `Bienvenido, ${MarketNet.accountName}`,
      'gold',
    );
  } catch (error) {
    setAuthError((error && error.message) || 'no se pudo completar la operación');
  } finally {
    setAuthBusy(false);
  }
}

function updateSessionChip(status) {
  if (status) authConnection = status;
  const dot = document.getElementById('hudSessionDot');
  const nameEl = document.getElementById('hudSessionName');
  const button = document.getElementById('hudSessionBtn');
  if (dot) {
    const feedLive = status ? status === 'live' : MarketNet.live;
    dot.className = 'hud-session-dot';
    if (feedLive) dot.classList.add('is-live');
    else if (status === 'connecting' || status === undefined) dot.classList.add('is-connecting');
    else dot.classList.add('is-offline');
    dot.title = feedLive ? 'mercado en tiempo real' : 'sin conexión con el mercado';
  }
  if (nameEl) {
    nameEl.textContent = MarketNet.signedIn
      ? MarketNet.accountName
      : MarketNet.isGuest
        ? 'invitado'
        : 'sin sesión';
  }
  if (button) {
    button.textContent = MarketNet.signedIn ? 'Perfil' : 'Entrar';
  }
  if (typeof renderNotifications === 'function') renderNotifications();
  if (typeof updateHud === 'function') updateHud();
}

function onMarketSessionChange() {
  const avatar = document.getElementById('railAvatar');
  if (avatar) {
    avatar.textContent = initialsFor(MarketNet.accountName || 'invitado');
    avatar.title = MarketNet.signedIn ? MarketNet.accountName : 'invitado';
  }
  updateSessionChip();
  if (authModalOpen() && MarketNet.signedIn) closeAuthModal();
  // the admin console's rail button only belongs to accounts the server marked
  // as admins, so it is mounted (or removed) on every session change
  if (typeof maybeMountAdminButton === 'function') maybeMountAdminButton();
}

async function initAuth() {
  const overlay = document.getElementById('authOverlay');
  const form = document.getElementById('authForm');
  if (!overlay || !form) return;

  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => setAuthMode(btn.dataset.authTab));
  });
  form.addEventListener('submit', handleAuthSubmit);

  const guestBtn = document.getElementById('authGuest');
  if (guestBtn) {
    guestBtn.addEventListener('click', () => {
      MarketNet.continueAsGuest();
      closeAuthModal();
      MarketNet.connect();
      toast('Modo invitado', 'Tu progreso se guarda solo en este navegador.', 'gold');
    });
  }

  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && (MarketNet.isGuest || MarketNet.signedIn)) {
      closeAuthModal();
    }
  });

  const sessionBtn = document.getElementById('hudSessionBtn');
  if (sessionBtn) {
    sessionBtn.addEventListener('click', () => {
      if (MarketNet.signedIn) openNavModal('Tu perfil', perfilContent());
      else openAuthModal('login');
    });
  }

  setAuthMode('login');
  onMarketSessionChange();

  // the market feed itself is public, so connect no matter what so prices keep
  // moving in the background while the player decides about an account
  MarketNet.connect();

  // SSO con cloudsync: si hay sesión de la nube sin token de mercado, se adopta
  // (el servidor ya nos autentica por la cookie) antes de decidir si abrir el
  // modal. sin sesión de nube no hace nada y el flujo de login no cambia.
  await MarketNet.restoreSession();

  if (MarketNet.signedIn) {
    refreshAccountFromServer();
  } else if (!MarketNet.isGuest) {
    openAuthModal('login');
  }

  window.addEventListener('beforeunload', () => {
    if (MarketNet.signedIn) MarketNet.savePortfolioNow();
  });
}
