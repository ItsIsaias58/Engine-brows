// SSO entre cloudsync y el mercado: una sola cuenta manda.
//
// cloudsync (Rust) es la autoridad de cuentas: guarda los usuarios y firma un
// JWT HS256 en la cookie `token` al iniciar sesión. El mercado tenía hasta
// ahora su propio registro (players.json + token opaco), así que un jugador
// acababa con DOS cuentas —la de la nube y la del juego— que podían no
// coincidir. Con esto el mercado acepta el JWT de cloudsync como segunda vía de
// sesión: si llega una cookie `token` válida y no hay token de mercado, se
// resuelve (o se provisiona) la cuenta de mercado con ese mismo nombre.
//
// Es puramente aditivo: solo entra cuando NO hay sesión de mercado, y solo si
// JWT_SECRET está configurado. Nunca debilita una sesión existente.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { accountKey, defaultPortfolio, defaultProfile } from './accounts.mjs';

// el mismo nombre que usa cloudsync (services/cloudsync/src/auth.rs)
export const SSO_COOKIE = 'token';
// la forma del nombre de cloudsync: 3-20 alfanuméricos o guion bajo
const SSO_NAME = /^[A-Za-z0-9_]{3,20}$/;

function base64urlToBuffer(input) {
  const value = String(input).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(value, 'base64');
}

// verifica un JWT HS256 de cloudsync y devuelve sus claims mínimos, o null si
// la firma, el algoritmo, la forma o la expiración no cuadran. no lanza nunca:
// un token corrupto es simplemente "no autenticado".
export function verifySessionToken(jwt, secret, nowMs = Date.now()) {
  if (typeof jwt !== 'string' || !secret) return null;
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return null;

  const expected = createHmac('sha256', secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest();
  let provided;
  try {
    provided = base64urlToBuffer(signaturePart);
  } catch {
    return null;
  }
  // longitudes distintas harían saltar a timingSafeEqual: se descarta antes
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(base64urlToBuffer(headerPart).toString('utf8'));
    payload = JSON.parse(base64urlToBuffer(payloadPart).toString('utf8'));
  } catch {
    return null;
  }
  // solo HS256: no aceptamos `alg: none` ni un alg ajeno aunque la firma cuadre
  if (!header || header.alg !== 'HS256') return null;
  if (!payload || typeof payload !== 'object') return null;
  const username = typeof payload.username === 'string' ? payload.username.trim() : '';
  if (!SSO_NAME.test(username)) return null;
  if (Number.isFinite(payload.exp) && nowMs / 1000 >= payload.exp) return null;

  return {
    username,
    id: Number.isFinite(payload.id) ? payload.id : null,
    version: Number.isFinite(payload.v) ? payload.v : null,
  };
}

function cookieValue(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return part.slice(index + 1).trim();
    }
  }
  return '';
}

// el JWT de cloudsync que trae la petición, si lo trae
export function sessionTokenFromRequest(req) {
  return cookieValue(req, SSO_COOKIE);
}

// encuentra o provisiona la cuenta de mercado para un usuario de cloudsync. la
// cuenta nace sin contraseña local (hash vacío): solo se entra por SSO, y un
// login por contraseña contra ella siempre falla. devuelve { account, created }.
export function resolveSsoAccount(store, username, now = Date.now()) {
  const name = String(username || '').trim();
  if (!SSO_NAME.test(name)) return null;
  const key = accountKey(name);
  const existing = store.accounts[key];
  if (existing) {
    existing.lastLoginAt = now;
    return { account: existing, created: false };
  }
  const account = {
    id: randomUUID(),
    name,
    hash: '', // cuenta SSO: sin contraseña local
    sso: true,
    createdAt: now,
    lastLoginAt: now,
    portfolio: defaultPortfolio(),
    profile: defaultProfile(),
    netHistory: [],
  };
  store.accounts[key] = account;
  return { account, created: true };
}
