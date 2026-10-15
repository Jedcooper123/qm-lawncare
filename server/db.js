import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import { env, isProd, MIN_OWNER_PASSWORD } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '..', 'seed');

/* A hosted database is reached across the public internet, so the server's
   certificate is verified rather than blindly accepted. Set explicitly
   rather than left to the connection string, because pg is changing what
   `sslmode=require` means in v9. */
const isLocalDb = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(env.databaseUrl);

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  ssl: isLocalDb ? false : { rejectUnauthorized: true },
  max: isProd ? 5 : 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

export const query = (text, params) => pool.query(text, params);

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/* Photos are stored in the database because Render's disk is wiped on
   every deploy. Each one is already shrunk to ~300 KB by lib/images.js,
   and the server keeps them in memory (lib/gallery.js) so visitors don't
   wake the Neon compute. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS owners (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id         SERIAL PRIMARY KEY,
  category   TEXT NOT NULL,
  caption    TEXT NOT NULL DEFAULT '',
  alt        TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  mime       TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS photos_order_idx ON photos (category, sort_order, id);

-- The fixed photos outside the gallery (banner, About photos, logo). A row
-- exists only while the owner has replaced that spot; deleting it puts the
-- original from public/ back.
CREATE TABLE IF NOT EXISTS site_images (
  slot       TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  bytes      INTEGER NOT NULL,
  data       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function migrate() {
  await query(SCHEMA);
  console.log('[db] schema ready');
}

export async function getSetting(key) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0]?.value ?? null;
}

/* Imports the photos that were on the original static site, once. A flag
   rather than "is the table empty" so that deleting every photo doesn't
   bring the old ones back on the next deploy. */
export async function seedPhotos(processPhoto) {
  if (await getSetting('photos_seeded')) return;

  const manifest = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'photos.json'), 'utf8'));
  await tx(async (client) => {
    for (const [i, p] of manifest.entries()) {
      /* Already sized by lib/images.js; running them through again is cheap
         and guarantees they match whatever the current settings are. */
      const img = await processPhoto(fs.readFileSync(path.join(SEED_DIR, 'photos', p.file)));
      await client.query(
        `INSERT INTO photos (category, caption, alt, sort_order, mime, width, height, bytes, data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [p.category, p.caption, p.alt, i, img.mime, img.width, img.height, img.data.length, img.data]
      );
    }
    await client.query(`INSERT INTO settings (key, value) VALUES ('photos_seeded', $1)`, [new Date().toISOString()]);
  });
  console.log(`[db] imported ${manifest.length} photos from the original site`);
}

/* Creates the owner login from OWNER_EMAIL / OWNER_PASSWORD the first time
   it sees them. Changing OWNER_PASSWORD later updates the existing account,
   so a forgotten password is recoverable from the Render dashboard. */
export async function seedOwner() {
  if (!env.ownerEmail || !env.ownerPassword) return;
  /* validateEnv() already warned about this; refuse again here so a weak
     password can never be written even if seedOwner is called directly. */
  if (env.ownerPassword.length < MIN_OWNER_PASSWORD) return;

  const hash = await bcrypt.hash(env.ownerPassword, 12);
  const { rows } = await query('SELECT id, password_hash FROM owners WHERE email = $1', [env.ownerEmail]);

  if (rows.length) {
    const matches = await bcrypt.compare(env.ownerPassword, rows[0].password_hash);
    if (!matches) {
      await query('UPDATE owners SET password_hash = $1, name = $2 WHERE id = $3', [hash, env.ownerName, rows[0].id]);
      console.log(`[db] owner password updated for ${env.ownerEmail}`);
    }
    return;
  }

  /* No account under that address. The business has exactly one owner, so
     a changed OWNER_EMAIL means the login address was changed — rename the
     existing account rather than adding a second one nobody expects. */
  const { rows: existing } = await query('SELECT id, email FROM owners');

  if (existing.length === 1) {
    await query(
      'UPDATE owners SET email = $1, password_hash = $2, name = $3 WHERE id = $4',
      [env.ownerEmail, hash, env.ownerName, existing[0].id]
    );
    console.log(`[db] owner login changed from ${existing[0].email} to ${env.ownerEmail}`);
    return;
  }

  await query(
    'INSERT INTO owners (email, password_hash, name) VALUES ($1, $2, $3)',
    [env.ownerEmail, hash, env.ownerName]
  );
  console.log(`[db] owner account created for ${env.ownerEmail}`);
}
