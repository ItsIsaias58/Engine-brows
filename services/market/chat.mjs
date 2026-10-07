// chat + comunidad de owngames. Es el backend que faltaba: canales (global,
// mensajes directos y grupos), lista de amigos, y la moderación (silenciar,
// banear del chat, banear la cuenta) con su registro.
//
// Igual que accounts.mjs, esto es un modelo PURO: las funciones reciben el
// store como primer argumento y no tocan red ni disco. El server se encarga de
// la persistencia (createJsonStore) y de repartir los mensajes por websocket.
//
// La identidad es la cuenta del market: aquí se trabaja con `accountKey(name)`
// (nombre en minúsculas), nunca con datos de sesión.

export const CHAT_VERSION = 1;
export const MAX_MESSAGE_LENGTH = 500;
export const MAX_CHANNEL_MESSAGES = 300;
export const MAX_GROUP_MEMBERS = 30;
export const MAX_GROUP_TITLE = 40;
export const GLOBAL_CHANNEL = 'global';

export function createChatStore() {
  return {
    version: CHAT_VERSION,
    nextId: 1,
    channels: {},
    messages: {},
    friends: {}, // key -> { friends: [key], requests: [key] }
    moderation: {}, // key -> { chat: {until,reason}, account: {until,reason} }
    audit: [], // { at, by, action, target, detail }
  };
}

// clave de cuenta: mismo criterio que accounts.mjs (nombre en minúsculas)
export function chatKey(name) {
  return String(name || '').trim().toLowerCase();
}

export function dmChannelId(nameA, nameB) {
  const [a, b] = [chatKey(nameA), chatKey(nameB)].sort();
  return `dm:${a}:${b}`;
}

export function restoreChatStore(saved) {
  const store = createChatStore();
  if (!saved || typeof saved !== 'object') return store;
  store.nextId = Number.isFinite(saved.nextId) ? saved.nextId : 1;
  if (saved.channels && typeof saved.channels === 'object') {
    for (const [id, ch] of Object.entries(saved.channels)) {
      if (!ch || typeof ch !== 'object') continue;
      const kind = ['global', 'dm', 'group'].includes(ch.kind) ? ch.kind : null;
      if (!kind) continue;
      store.channels[id] = {
        id,
        kind,
        title: typeof ch.title === 'string' ? ch.title.slice(0, MAX_GROUP_TITLE) : '',
        members: Array.isArray(ch.members)
          ? [...new Set(ch.members.filter((m) => typeof m === 'string' && m).map(chatKey))]
          : [],
        createdBy: typeof ch.createdBy === 'string' ? ch.createdBy : '',
        createdAt: Number.isFinite(ch.createdAt) ? ch.createdAt : 0,
      };
    }
  }
  if (saved.messages && typeof saved.messages === 'object') {
    for (const [channelId, list] of Object.entries(saved.messages)) {
      if (!Array.isArray(list)) continue;
      store.messages[channelId] = list
        .filter((m) => m && typeof m.text === 'string' && typeof m.authorKey === 'string')
        .slice(-MAX_CHANNEL_MESSAGES)
        .map((m) => ({
          id: Number.isFinite(m.id) ? m.id : 0,
          author: String(m.author || '').slice(0, 24),
          authorKey: chatKey(m.authorKey),
          text: String(m.text).slice(0, MAX_MESSAGE_LENGTH),
          at: Number.isFinite(m.at) ? m.at : 0,
        }));
    }
  }
  if (saved.friends && typeof saved.friends === 'object') {
    for (const [key, rel] of Object.entries(saved.friends)) {
      if (!rel || typeof rel !== 'object') continue;
      store.friends[chatKey(key)] = sanitizeRelation(rel);
    }
  }
  if (saved.moderation && typeof saved.moderation === 'object') {
    for (const [key, mod] of Object.entries(saved.moderation)) {
      if (!mod || typeof mod !== 'object') continue;
      store.moderation[chatKey(key)] = sanitizeModeration(mod);
    }
  }
  if (Array.isArray(saved.audit)) {
    store.audit = saved.audit.slice(-500);
  }
  return store;
}

function sanitizeRelation(input) {
  const strList = (v) =>
    Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x).map(chatKey))] : [];
  return { friends: strList(input.friends), requests: strList(input.requests) };
}

function sanitizeModeration(input) {
  const entry = (v) =>
    v && typeof v === 'object'
      ? {
          until: Number.isFinite(v.until) ? v.until : 0,
          reason: typeof v.reason === 'string' ? v.reason.slice(0, 200) : '',
          at: Number.isFinite(v.at) ? v.at : 0,
        }
      : null;
  return { chat: entry(input.chat), account: entry(input.account) };
}

export function sanitizeMessageText(raw) {
  const text = String(raw == null ? '' : raw)
    // se descartan los caracteres de control (tabuladores verticales, campana…)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
  return text;
}

// ---------------------------------------------------------------- canales

export function ensureGlobalChannel(chat, now = Date.now()) {
  if (!chat.channels[GLOBAL_CHANNEL]) {
    chat.channels[GLOBAL_CHANNEL] = {
      id: GLOBAL_CHANNEL,
      kind: 'global',
      title: 'Global',
      members: [],
      createdBy: '',
      createdAt: now,
    };
  }
  return chat.channels[GLOBAL_CHANNEL];
}

function isMember(channel, key) {
  return channel.kind === 'global' || channel.members.includes(chatKey(key));
}

export function openDm(chat, nameA, nameB, now = Date.now()) {
  const id = dmChannelId(nameA, nameB);
  if (!chat.channels[id]) {
    chat.channels[id] = {
      id,
      kind: 'dm',
      title: '',
      members: [chatKey(nameA), chatKey(nameB)],
      createdBy: chatKey(nameA),
      createdAt: now,
    };
  }
  return chat.channels[id];
}

export function createGroup(chat, ownerName, title, memberNames, now = Date.now()) {
  const owner = chatKey(ownerName);
  const members = [...new Set([owner, ...memberNames.map(chatKey)])].slice(0, MAX_GROUP_MEMBERS);
  const clean = String(title || '').trim().slice(0, MAX_GROUP_TITLE);
  const id = `g${chat.nextId++}`;
  chat.channels[id] = {
    id,
    kind: 'group',
    title: clean || 'Grupo',
    members,
    createdBy: owner,
    createdAt: now,
  };
  return chat.channels[id];
}

// canales visibles para una cuenta: el global + sus DMs y grupos
export function channelsFor(chat, name) {
  ensureGlobalChannel(chat);
  const key = chatKey(name);
  return Object.values(chat.channels)
    .filter((ch) => isMember(ch, key))
    .sort((a, b) => (a.kind === 'global' ? -1 : b.kind === 'global' ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
}

// miembros (keys) de un canal, para saber a qué sockets repartir un mensaje
export function channelMembers(chat, channelId) {
  const ch = chat.channels[channelId];
  if (!ch) return null;
  if (ch.kind === 'global') return 'global';
  return ch.members.slice();
}

// ---------------------------------------------------------------- mensajes

export function postMessage(chat, channelId, authorName, rawText, now = Date.now()) {
  const channel = chat.channels[channelId];
  if (!channel) return { ok: false, error: 'canal desconocido' };
  const key = chatKey(authorName);
  if (!isMember(channel, key)) return { ok: false, error: 'no perteneces a este canal' };
  const ban = activeBan(chat, key, 'chat', now);
  if (ban) return { ok: false, error: ban.reason || 'estás silenciado en el chat' };
  const text = sanitizeMessageText(rawText);
  if (!text) return { ok: false, error: 'mensaje vacío' };
  const message = {
    id: chat.nextId++,
    author: String(authorName || '').slice(0, 24),
    authorKey: key,
    text,
    at: now,
  };
  const list = chat.messages[channelId] || (chat.messages[channelId] = []);
  list.push(message);
  if (list.length > MAX_CHANNEL_MESSAGES) list.splice(0, list.length - MAX_CHANNEL_MESSAGES);
  return { ok: true, message };
}

export function messagesFor(chat, channelId, since = 0, limit = 100) {
  const list = chat.messages[channelId] || [];
  const after = list.filter((m) => m.id > since);
  return after.slice(-limit);
}

export function allMessages(chat, limit = 500) {
  const out = [];
  for (const [channelId, list] of Object.entries(chat.messages)) {
    for (const m of list) out.push({ ...m, channel: channelId });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(-limit);
}

export function deleteMessage(chat, messageId) {
  for (const list of Object.values(chat.messages)) {
    const idx = list.findIndex((m) => m.id === messageId);
    if (idx >= 0) list.splice(idx, 1);
  }
}

// ---------------------------------------------------------------- amigos

function relationOf(chat, key) {
  return chat.friends[key] || (chat.friends[key] = { friends: [], requests: [] });
}

export function requestFriend(chat, fromName, toName) {
  const from = chatKey(fromName);
  const to = chatKey(toName);
  if (!from || !to || from === to) return { ok: false, error: 'destinatario inválido' };
  const target = relationOf(chat, to);
  if (target.friends.includes(from)) return { ok: false, error: 'ya son amigos' };
  if (!target.requests.includes(from)) target.requests.push(from);
  return { ok: true };
}

export function acceptFriend(chat, name, otherName) {
  const me = chatKey(name);
  const other = chatKey(otherName);
  const mine = relationOf(chat, me);
  if (!mine.requests.includes(other)) return { ok: false, error: 'no hay solicitud pendiente' };
  mine.requests = mine.requests.filter((k) => k !== other);
  if (!mine.friends.includes(other)) mine.friends.push(other);
  const theirs = relationOf(chat, other);
  theirs.requests = theirs.requests.filter((k) => k !== me);
  if (!theirs.friends.includes(me)) theirs.friends.push(me);
  return { ok: true };
}

export function removeFriend(chat, name, otherName) {
  const me = chatKey(name);
  const other = chatKey(otherName);
  relationOf(chat, me).friends = relationOf(chat, me).friends.filter((k) => k !== other);
  relationOf(chat, other).friends = relationOf(chat, other).friends.filter((k) => k !== me);
  return { ok: true };
}

export function relationsFor(chat, name) {
  const rel = chat.friends[chatKey(name)] || { friends: [], requests: [] };
  return { friends: rel.friends.slice(), requests: rel.requests.slice() };
}

// ---------------------------------------------------------------- moderación

// scope: 'chat' o 'account'. until<=0 = permanente.
export function applyBan(chat, targetName, scope, durationMs, reason, byName = '', now = Date.now()) {
  const key = chatKey(targetName);
  if (!key) return { ok: false, error: 'cuenta inválida' };
  const entry = {
    until: Number.isFinite(durationMs) && durationMs > 0 ? now + durationMs : 0,
    reason: String(reason || '').slice(0, 200),
    at: now,
  };
  const mod = chat.moderation[key] || (chat.moderation[key] = { chat: null, account: null });
  if (scope === 'chat') mod.chat = entry;
  else mod.account = entry;
  chat.audit.push({ at: now, by: chatKey(byName), action: `ban-${scope}`, target: key, detail: entry.reason });
  if (chat.audit.length > 500) chat.audit.splice(0, chat.audit.length - 500);
  return { ok: true, entry };
}

export function liftBan(chat, targetName, scope, byName = '', now = Date.now()) {
  const key = chatKey(targetName);
  const mod = chat.moderation[key];
  if (!mod) return { ok: false, error: 'sin sanción' };
  if (scope === 'chat') mod.chat = null;
  else mod.account = null;
  chat.audit.push({ at: now, by: chatKey(byName), action: `unban-${scope}`, target: key, detail: '' });
  return { ok: true };
}

// devuelve la sanción activa de ese scope, o null. una sanción vencida se limpia.
export function activeBan(chat, name, scope, now = Date.now()) {
  const mod = chat.moderation[chatKey(name)];
  if (!mod) return null;
  const entry = scope === 'chat' ? mod.chat : mod.account;
  if (!entry) return null;
  if (entry.until && entry.until <= now) {
    if (scope === 'chat') mod.chat = null;
    else mod.account = null;
    return null;
  }
  return entry;
}

export function auditLog(chat, limit = 200) {
  return chat.audit.slice(-limit).reverse();
}
