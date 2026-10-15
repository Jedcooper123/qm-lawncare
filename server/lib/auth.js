import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env, isProd } from '../env.js';
import { query } from '../db.js';

const COOKIE = 'qm_session';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function issueSession(res, owner) {
  const token = jwt.sign(
    { sub: owner.id, email: owner.email, name: owner.name },
    env.sessionSecret,
    { expiresIn: '7d' }
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/', httpOnly: true, secure: isProd, sameSite: 'lax' });
}

export function readSession(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, env.sessionSecret);
  } catch (_) {
    return null;
  }
}

export function requireOwner(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Please sign in again.' });
  req.owner = session;
  next();
}

export async function verifyCredentials(email, password) {
  const { rows } = await query('SELECT id, email, name, password_hash FROM owners WHERE email = $1', [
    String(email || '').trim().toLowerCase(),
  ]);
  const owner = rows[0];

  /* Always run a hash comparison, even when the account does not exist, so
     response timing does not reveal which emails are valid logins. */
  const hash = owner?.password_hash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const ok = await bcrypt.compare(String(password || ''), hash);

  if (!owner || !ok) return null;
  return { id: owner.id, email: owner.email, name: owner.name };
}
