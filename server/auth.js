// Password hashing and identity helpers.
import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const KEY_LEN = 64;

export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,19}$/;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltB64, keyB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return 'Username must be 3–20 characters: letters, numbers, _ or - (starting with a letter or number).';
  }
  if (/^(anon|guest)/i.test(username)) return 'That username is reserved.';
  if (typeof password !== 'string' || password.length < 6) return 'Password must be at least 6 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

const GUEST_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function newGuestId() {
  return randomBytes(18).toString('base64url');
}

export function isValidGuestId(id) {
  return typeof id === 'string' && GUEST_RE.test(id);
}

/** Stable, non-secret display name derived from a secret guest id. */
export function guestName(guestId) {
  const n = createHash('sha256').update(guestId).digest().readUInt16BE(0) % 10000;
  return `Anon-${String(n).padStart(4, '0')}`;
}

/**
 * Resolve the identity behind a request's cookies.
 * key: stable internal id ('u:<id>' or 'g:<guestId>'), never sent to other clients.
 */
export function resolveIdentity(db, cookies) {
  const user = db.sessionUser(cookies.sid);
  if (user) return { key: `u:${user.id}`, userId: user.id, name: user.username, registered: true };
  const gid = isValidGuestId(cookies.gid) ? cookies.gid : null;
  if (gid) return { key: `g:${gid}`, userId: null, name: guestName(gid), registered: false };
  return null;
}
