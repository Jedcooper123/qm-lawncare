import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env, isProd, validateEnv } from './env.js';
import { migrate, seedOwner, seedPhotos, pool } from './db.js';
import { ownerRouter } from './routes/owner.js';
import { processPhoto } from './lib/images.js';
import { loadGallery, galleryLoaded, getPhotoBytes, renderGallery } from './lib/gallery.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SEED_PHOTOS_DIR = path.join(__dirname, '..', 'seed', 'photos');
const INDEX_TEMPLATE = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

const app = express();

/* Render terminates TLS upstream, so trust its proxy headers — otherwise
   every request looks like it came from the same IP and rate limiting
   would throttle the whole site at once. */
if (env.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

/* The homepage is the original hand-built page, which uses inline scripts,
   onclick handlers, Font Awesome from cdnjs and formsubmit.co for its
   forms — so those are allowed rather than the page being rewritten. */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'https://formsubmit.co'],
      formAction: ["'self'", 'https://formsubmit.co'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
}));

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());

app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
}));

/* ── API ───────────────────────────────────────────────────── */
app.use('/api/owner', ownerRouter);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

/* Render calls this every few seconds, so it deliberately doesn't touch the
   database — a query here would keep the Neon compute awake around the
   clock and use up the free plan (see Classic Cleanz, September 2026). */
let dbReady = false;

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), db: dbReady ? 'ready' : 'unavailable' });
});

/* ── Photos ──────────────────────────────────────────────────
   An id is never reused and a photo's bytes never change (editing a
   caption doesn't touch them), so the URL can be cached for a year. */
app.use('/photos/seed', express.static(SEED_PHOTOS_DIR, { maxAge: '7d' }));

app.get('/photos/:id(\\d{1,9}).jpg', async (req, res, next) => {
  try {
    const buf = await getPhotoBytes(Number(req.params.id));
    if (!buf) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('image/jpeg').send(buf);
  } catch (err) { next(err); }
});

/* ── Pages ─────────────────────────────────────────────────── */
app.get(['/', '/index.html'], (_req, res) => {
  res.set('Cache-Control', 'no-cache').type('html').send(renderGallery(INDEX_TEMPLATE));
});

app.get(['/admin', '/admin/'], (_req, res) => {
  res.set('Cache-Control', 'no-cache').set('X-Robots-Tag', 'noindex').sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.use(express.static(PUBLIC_DIR, {
  index: false,
  maxAge: isProd ? '1d' : 0,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.use((_req, res) => res.status(404).type('text').send('Not found'));

/* ── Error handling ────────────────────────────────────────── */
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[error]', err.stack || err.message);
    return res.status(500).json({ error: 'Something went wrong on our end. Please try again in a minute.' });
  }
  res.status(status).json({ error: err.message });
});

/* ── Boot ──────────────────────────────────────────────────── */

/* If the database is down at boot the site is served anyway — the gallery
   falls back to the photos the site launched with — while this keeps
   retrying. Refusing to start would leave Render restarting the service in
   a loop with every page offline. */
const DB_RETRY_MS = 2 * 60 * 1000;

async function prepareDatabase() {
  try {
    await migrate();
    await seedOwner();
    await seedPhotos(processPhoto);
    await loadGallery();
    dbReady = true;
    console.log('[db] ready');
  } catch (err) {
    console.error(`[db] unavailable, retrying in ${DB_RETRY_MS / 60_000} minutes: ${err.message}`);
    setTimeout(prepareDatabase, DB_RETRY_MS).unref();
  }
}

async function start() {
  const { errors, warnings } = validateEnv();
  warnings.forEach((w) => console.warn('[config] ' + w));
  if (errors.length) {
    errors.forEach((e) => console.error('[config] ' + e));
    process.exit(1);
  }

  await prepareDatabase();

  const server = app.listen(env.port, () => {
    console.log(`\n  ${env.business.name}`);
    console.log(`  ${env.siteUrl}  (listening on :${env.port}, ${env.nodeEnv})`);
    console.log(`  Owner portal:   ${env.siteUrl}/admin`);
    console.log(`  Gallery:        ${galleryLoaded() ? 'from database' : 'launch photos (database unavailable)'}\n`);
  });

  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} received, shutting down`);
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[server] failed to start:', err);
  process.exit(1);
});
