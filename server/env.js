import 'dotenv/config';
import crypto from 'node:crypto';

const bool = (v, fallback = false) => {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT) || 3000,

  /* Public URL of the deployed site, for the startup log. Falls back to
     RENDER_EXTERNAL_URL, which Render injects automatically. */
  siteUrl: (
    process.env.SITE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    `http://localhost:${Number(process.env.PORT) || 3000}`
  ).replace(/\/$/, ''),

  databaseUrl: process.env.DATABASE_URL || '',

  /* Signs the owner's session cookie. */
  sessionSecret: process.env.SESSION_SECRET || '',

  /* Seeded on every boot — see seedOwner() in db.js. */
  ownerEmail: (process.env.OWNER_EMAIL || '').trim().toLowerCase(),
  ownerPassword: process.env.OWNER_PASSWORD || '',
  ownerName: process.env.OWNER_NAME || 'Quinlan',

  business: {
    name: 'Q & M Lawncare',
    phone: '(828) 263-7659',
  },

  trustProxy: bool(process.env.TRUST_PROXY, true),
};

export const isProd = env.nodeEnv === 'production';

/* Enforced in validateEnv() and again in seedOwner(), so a password that
   fails the check is reported at boot and still never reaches the database. */
export const MIN_OWNER_PASSWORD = 10;

/* ── Startup validation ─────────────────────────────────────────
   Fail loudly in production for anything that would silently break;
   in development fall back to safe defaults so the app still runs. */
export function validateEnv() {
  const errors = [];
  const warnings = [];

  if (!env.databaseUrl) errors.push('DATABASE_URL is not set — the app cannot start without a Postgres connection string.');

  if (!env.sessionSecret) {
    if (isProd) errors.push('SESSION_SECRET is not set. Generate one with: openssl rand -hex 32');
    else {
      env.sessionSecret = crypto.randomBytes(32).toString('hex');
      warnings.push('SESSION_SECRET not set — using a random dev secret. Owner logins will drop on every restart.');
    }
  }

  /* A problem with the owner login must never take the public site down.
     It's reported loudly and seeding is skipped, but the server still
     comes up. */
  if (!env.ownerEmail || !env.ownerPassword) {
    warnings.push('OWNER_EMAIL / OWNER_PASSWORD not set — no owner account will be seeded, so the portal cannot be signed into. Set both and redeploy.');
  } else if (env.ownerPassword.length < MIN_OWNER_PASSWORD) {
    warnings.push(
      `OWNER_PASSWORD is only ${env.ownerPassword.length} characters — it must be at least ${MIN_OWNER_PASSWORD}. ` +
      'The owner account was NOT created or updated. The public site is unaffected; set a longer password and redeploy to fix the portal login.'
    );
  }

  return { errors, warnings };
}
