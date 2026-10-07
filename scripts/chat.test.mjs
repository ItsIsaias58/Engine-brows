import { describe, expect, test } from 'bun:test';
import {
  MAX_CHANNEL_MESSAGES,
  acceptFriend,
  activeBan,
  applyBan,
  auditLog,
  channelMembers,
  channelsFor,
  createChatStore,
  createGroup,
  deleteMessage,
  dmChannelId,
  ensureGlobalChannel,
  liftBan,
  messagesFor,
  openDm,
  postMessage,
  relationsFor,
  removeFriend,
  requestFriend,
  restoreChatStore,
  sanitizeMessageText,
} from '../services/market/chat.mjs';

describe('chat: canales', () => {
  test('el canal global existe y todos pertenecen a él', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    expect(channelMembers(chat, 'global')).toBe('global');
    expect(channelsFor(chat, 'Ana').some((c) => c.id === 'global')).toBe(true);
  });

  test('un DM se crea una sola vez, con id ordenado', () => {
    const chat = createChatStore();
    const a = openDm(chat, 'Ana', 'Beto');
    const b = openDm(chat, 'Beto', 'Ana');
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(dmChannelId('Ana', 'Beto'));
    expect(a.members.sort()).toEqual(['ana', 'beto']);
  });

  test('un grupo incluye al dueño y deduplica miembros', () => {
    const chat = createChatStore();
    const g = createGroup(chat, 'Ana', 'Minecraft', ['Beto', 'beto', 'Caro']);
    expect(g.members).toEqual(['ana', 'beto', 'caro']);
    expect(g.title).toBe('Minecraft');
  });

  test('channelsFor sólo ve los canales donde participa', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    openDm(chat, 'Ana', 'Beto');
    createGroup(chat, 'Caro', 'prv', ['Dani']);
    const ana = channelsFor(chat, 'Ana').map((c) => c.kind);
    expect(ana).toContain('global');
    expect(ana).toContain('dm');
    expect(ana).not.toContain('group');
  });
});

describe('chat: mensajes', () => {
  test('un miembro publica y se sanitiza el texto', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    const r = postMessage(chat, 'global', 'Ana', '  hola\u0007   mundo  ');
    expect(r.ok).toBe(true);
    expect(r.message.text).toBe('hola mundo');
    expect(r.message.authorKey).toBe('ana');
  });

  test('un no-miembro no puede publicar en un DM ajeno', () => {
    const chat = createChatStore();
    const dm = openDm(chat, 'Ana', 'Beto');
    const r = postMessage(chat, dm.id, 'Caro', 'hola');
    expect(r.ok).toBe(false);
  });

  test('mensaje vacío se rechaza', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    expect(postMessage(chat, 'global', 'Ana', '   ').ok).toBe(false);
  });

  test('el buffer por canal se recorta', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    for (let i = 0; i < MAX_CHANNEL_MESSAGES + 40; i += 1) postMessage(chat, 'global', 'Ana', `m${i}`);
    expect(chat.messages.global.length).toBe(MAX_CHANNEL_MESSAGES);
  });

  test('messagesFor devuelve sólo lo posterior al cursor', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    postMessage(chat, 'global', 'Ana', 'uno');
    const second = postMessage(chat, 'global', 'Ana', 'dos').message;
    postMessage(chat, 'global', 'Ana', 'tres');
    const after = messagesFor(chat, 'global', second.id);
    expect(after.map((m) => m.text)).toEqual(['tres']);
  });

  test('deleteMessage quita un mensaje por id', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    const m = postMessage(chat, 'global', 'Ana', 'x').message;
    deleteMessage(chat, m.id);
    expect(chat.messages.global.length).toBe(0);
  });

  test('sanitizeMessageText recorta longitud y colapsa espacios', () => {
    const long = 'a'.repeat(1000);
    expect(sanitizeMessageText(long).length).toBe(500);
    expect(sanitizeMessageText('a\n\nb')).toBe('a b');
  });
});

describe('chat: amigos', () => {
  test('solicitud -> aceptación crea la amistad en ambos lados', () => {
    const chat = createChatStore();
    requestFriend(chat, 'Ana', 'Beto');
    expect(relationsFor(chat, 'Beto').requests).toContain('ana');
    acceptFriend(chat, 'Beto', 'Ana');
    expect(relationsFor(chat, 'Ana').friends).toContain('beto');
    expect(relationsFor(chat, 'Beto').friends).toContain('ana');
    removeFriend(chat, 'Ana', 'Beto');
    expect(relationsFor(chat, 'Ana').friends).toEqual([]);
  });

  test('no se puede pedir amistad a uno mismo', () => {
    const chat = createChatStore();
    expect(requestFriend(chat, 'Ana', 'Ana').ok).toBe(false);
  });
});

describe('chat: moderación', () => {
  test('ban del chat bloquea la publicación y caduca', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    applyBan(chat, 'Ana', 'chat', 1000, 'spam', 'Root', 1000);
    expect(postMessage(chat, 'global', 'Ana', 'hola', 1500).ok).toBe(false);
    // tras vencer, se limpia y puede volver a escribir
    expect(activeBan(chat, 'Ana', 'chat', 2500)).toBe(null);
    expect(postMessage(chat, 'global', 'Ana', 'hola', 2500).ok).toBe(true);
  });

  test('ban permanente (until<=0) no caduca', () => {
    const chat = createChatStore();
    applyBan(chat, 'Ana', 'account', 0, 'contenido indecente', 'Root', 1000);
    expect(activeBan(chat, 'Ana', 'account', 9_999_999_999)).not.toBe(null);
  });

  test('un ban de cuenta no silencia el chat y viceversa', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    applyBan(chat, 'Ana', 'account', 0, 'x', 'Root');
    expect(postMessage(chat, 'global', 'Ana', 'hola').ok).toBe(true);
    liftBan(chat, 'Ana', 'account', 'Root');
    expect(activeBan(chat, 'Ana', 'account')).toBe(null);
  });

  test('el registro de auditoría anota las acciones', () => {
    const chat = createChatStore();
    applyBan(chat, 'Ana', 'chat', 0, 'spam', 'Root');
    const log = auditLog(chat);
    expect(log[0].action).toBe('ban-chat');
    expect(log[0].target).toBe('ana');
  });
});

describe('chat: persistencia', () => {
  test('restore conserva canales, mensajes, amigos y sanciones', () => {
    const chat = createChatStore();
    ensureGlobalChannel(chat);
    postMessage(chat, 'global', 'Ana', 'hola');
    openDm(chat, 'Ana', 'Beto');
    requestFriend(chat, 'Ana', 'Beto');
    applyBan(chat, 'Caro', 'chat', 0, 'spam', 'Root');
    const restored = restoreChatStore(JSON.parse(JSON.stringify(chat)));
    expect(restored.channels.global).toBeTruthy();
    expect(restored.messages.global[0].text).toBe('hola');
    expect(restored.friends.beto.requests).toContain('ana');
    expect(activeBan(restored, 'Caro', 'chat')).not.toBe(null);
  });

  test('restore tolera basura sin romper', () => {
    const restored = restoreChatStore({ channels: { x: null }, messages: { y: 'no' }, friends: 5 });
    expect(restored.channels).toEqual({});
    expect(restored.messages).toEqual({});
  });
});
