import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createMarketServer } from '../services/market/server.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'market-chat-'));
}

let dir;
let instance;
let baseUrl;
const stamp = Date.now() % 1_000_000;
const PASSWORD = 'clave-segura-123';
const ADMIN = `jefechat${stamp}`;
const ALICE = `alicia${stamp}`;
const BOB = `beto${stamp}`;
const CARO = `caro${stamp}`;
const tokens = {};

async function post(pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function get(pathname, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${baseUrl}${pathname}`, { headers });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function register(name) {
  const r = await post('/api/market/accounts', { name, password: PASSWORD });
  tokens[name] = r.body.token;
  return r;
}

describe('chat del market (integración)', () => {
  beforeAll(async () => {
    dir = tempDir();
    instance = createMarketServer({ port: 0, dataDir: dir, tickMs: 200, adminNames: ADMIN });
    baseUrl = `http://127.0.0.1:${instance.port}`;
    await register(ADMIN);
    await register(ALICE);
    await register(BOB);
    await register(CARO);
  });

  afterAll(() => {
    instance?.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('un invitado no puede leer el chat (401)', async () => {
    const r = await get('/api/market/chat/channels');
    expect(r.status).toBe(401);
  });

  test('el canal global existe y se puede publicar/leer', async () => {
    const channels = await get('/api/market/chat/channels', tokens[ALICE]);
    expect(channels.body.channels.some((c) => c.id === 'global')).toBe(true);

    const sent = await post('/api/market/chat/send', { channel: 'global', text: 'hola mundo' }, tokens[ALICE]);
    expect(sent.status).toBe(200);
    expect(sent.body.message.text).toBe('hola mundo');

    const read = await get('/api/market/chat/messages?channel=global', tokens[BOB]);
    expect(read.body.messages.at(-1).text).toBe('hola mundo');
  });

  test('un DM sólo lo ven sus dos miembros', async () => {
    const made = await post('/api/market/chat/channels', { kind: 'dm', with: BOB }, tokens[ALICE]);
    expect(made.status).toBe(200);
    const id = made.body.channel.id;

    await post('/api/market/chat/send', { channel: id, text: 'secreto' }, tokens[ALICE]);
    const bobView = await get(`/api/market/chat/messages?channel=${id}`, tokens[BOB]);
    expect(bobView.status).toBe(200);
    expect(bobView.body.messages.at(-1).text).toBe('secreto');

    const caroView = await get(`/api/market/chat/messages?channel=${id}`, tokens[CARO]);
    expect(caroView.status).toBe(404);
  });

  test('grupo con miembros', async () => {
    const made = await post('/api/market/chat/channels', { kind: 'group', title: 'Minecraft', members: [BOB] }, tokens[ALICE]);
    expect(made.status).toBe(200);
    expect(made.body.channel.title).toBe('Minecraft');
    expect(made.body.channel.members.sort()).toEqual([ALICE.toLowerCase(), BOB.toLowerCase()].sort());
  });

  test('amigos: solicitud y aceptación', async () => {
    const req = await post('/api/market/chat/friends', { action: 'request', name: BOB }, tokens[ALICE]);
    expect(req.status).toBe(200);
    const bob = await get('/api/market/chat/friends', tokens[BOB]);
    expect(bob.body.requests).toContain(ALICE);
    const acc = await post('/api/market/chat/friends', { action: 'accept', name: ALICE }, tokens[BOB]);
    expect(acc.body.friends.some((f) => f.name === ALICE)).toBe(true);
  });

  test('moderación: ban de chat, mensajes y auditoría; ban de cuenta corta el acceso', async () => {
    const onlyAdmin = await get('/api/market/admin/chat/messages', tokens[ALICE]);
    expect(onlyAdmin.status).toBe(403);

    const banned = await post('/api/market/admin/chat/ban', { name: ALICE, scope: 'chat', reason: 'spam' }, tokens[ADMIN]);
    expect(banned.status).toBe(200);
    const blocked = await post('/api/market/chat/send', { channel: 'global', text: 'otra vez' }, tokens[ALICE]);
    expect(blocked.status).toBe(403);

    const audit = await get('/api/market/admin/chat/audit', tokens[ADMIN]);
    expect(audit.body.audit.some((a) => a.action === 'ban-chat')).toBe(true);

    await post('/api/market/admin/chat/unban', { name: ALICE, scope: 'chat' }, tokens[ADMIN]);
    const allowed = await post('/api/market/chat/send', { channel: 'global', text: 'ya puedo' }, tokens[ALICE]);
    expect(allowed.status).toBe(200);

    // ban de cuenta: la sesión viva deja de resolver y el login devuelve 403
    await post('/api/market/admin/chat/ban', { name: BOB, scope: 'account', reason: 'indecente' }, tokens[ADMIN]);
    const me = await get('/api/market/me', tokens[BOB]);
    expect(me.status).toBe(401);
    const login = await post('/api/market/sessions', { name: BOB, password: PASSWORD });
    expect(login.status).toBe(403);
  });

  test('la moderación persiste en chat.json', async () => {
    instance.flush(); // el store escribe con debounce; forzamos el volcado a disco
    const chatFile = path.join(dir, 'chat.json');
    expect(fs.existsSync(chatFile)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(chatFile, 'utf8'));
    expect(saved.moderation[BOB.toLowerCase()].account).toBeTruthy();
  });
});

// El caso que reportó el usuario: entró con cloud sync (SSO), que NO deja token
// en localStorage (la cookie `token` es httpOnly de cloudsync). El chat tiene que
// resolver esa sesión igual que el resto del market.
const SSO_SECRET = 's'.repeat(64);

function signJwt(payload, secret = SSO_SECRET) {
  const b64 = (v) => Buffer.from(v).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  return `${header}.${body}.${b64(signature)}`;
}

describe('chat con SSO de cloudsync', () => {
  let ssoInstance;
  let ssoUrl;
  let ssoDir;

  beforeAll(() => {
    ssoDir = tempDir();
    ssoInstance = createMarketServer({ port: 0, dataDir: ssoDir, tickMs: 200, ssoSecret: SSO_SECRET });
    ssoUrl = `http://127.0.0.1:${ssoInstance.port}`;
  });

  afterAll(() => {
    ssoInstance?.stop();
    if (ssoDir) fs.rmSync(ssoDir, { recursive: true, force: true });
  });

  test('sin token de mercado, la cookie de cloudsync da sesión de chat', async () => {
    const jwt = signJwt({ id: 1, username: 'nube_chat', v: 1, exp: Math.floor(Date.now() / 1000) + 3600 });
    const cookie = `token=${jwt}`;

    const me = await fetch(`${ssoUrl}/api/market/me`, { headers: { cookie } });
    expect(me.status).toBe(200);

    const channels = await fetch(`${ssoUrl}/api/market/chat/channels`, { headers: { cookie } });
    expect(channels.status).toBe(200);

    const sent = await fetch(`${ssoUrl}/api/market/chat/send`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'global', text: 'hola desde la nube' }),
    });
    expect(sent.status).toBe(200);

    const read = await fetch(`${ssoUrl}/api/market/chat/messages?channel=global`, { headers: { cookie } });
    const body = await read.json();
    expect(body.messages.at(-1).text).toBe('hola desde la nube');
  });

  test('sin cookie de sesión, el chat sigue siendo 401', async () => {
    const r = await fetch(`${ssoUrl}/api/market/chat/channels`);
    expect(r.status).toBe(401);
  });
});
