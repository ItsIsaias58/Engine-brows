// password hashing for trading floor accounts. scrypt with a per-account random
// salt, stored as `scrypt$<salt>$<digest>` so hashes stay portable across hosts.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SCRYPT_KEYLEN = 64;
export const PASSWORD_SCHEME = 'scrypt';
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 128;

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const digest = scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return `${PASSWORD_SCHEME}$${salt}$${digest}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 3) return false;
  const [scheme, salt, digest] = parts;
  if (scheme !== PASSWORD_SCHEME || !salt || !digest) return false;

  let expected;
  try {
    expected = Buffer.from(digest, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== SCRYPT_KEYLEN) return false;

  const candidate = scryptSync(String(password), salt, SCRYPT_KEYLEN);
  return timingSafeEqual(candidate, expected);
}
