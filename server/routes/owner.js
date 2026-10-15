import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { query, tx } from '../db.js';
import { issueSession, clearSession, requireOwner, verifyCredentials } from '../lib/auth.js';
import { processPhoto } from '../lib/images.js';
import { CATEGORIES, CATEGORY_KEYS, loadGallery, listPhotos, forgetPhotoBytes } from '../lib/gallery.js';
import { SITE_IMAGE_KEYS, loadSiteImages, listSiteImages } from '../lib/site-images.js';

export const ownerRouter = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' },
});

/* The portal shrinks photos in the browser before sending, so uploads are
   normally under 1 MB. The limit is for when that fails and the phone sends
   the original. */
const MAX_UPLOAD_MB = 30;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
});

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });
const clean = (s, max) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

function photoJson(p) {
  return {
    id: p.id, category: p.category, caption: p.caption, alt: p.alt,
    width: p.width, height: p.height, bytes: p.bytes,
    url: `/photos/${p.id}.jpg`, created_at: p.created_at,
  };
}

/* ── Auth ──────────────────────────────────────────────────── */
ownerRouter.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const owner = await verifyCredentials(req.body?.email, req.body?.password);
    if (!owner) return res.status(401).json({ error: 'That email and password do not match.' });
    issueSession(res, owner);
    res.json({ id: owner.id, email: owner.email, name: owner.name });
  } catch (err) { next(err); }
});

ownerRouter.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

ownerRouter.get('/me', requireOwner, (req, res) => {
  res.json({ id: req.owner.sub, email: req.owner.email, name: req.owner.name });
});

/* Everything below requires a signed-in owner. */
ownerRouter.use(requireOwner);

ownerRouter.param('id', (_req, res, next, raw) => {
  if (!/^\d{1,9}$/.test(raw)) return res.status(404).json({ error: 'That photo was already removed.' });
  next();
});

/* ── Photos ────────────────────────────────────────────────── */
ownerRouter.get('/photos', async (_req, res, next) => {
  try {
    /* Re-read so the portal always shows the database, not a stale copy. */
    await loadGallery();
    res.json({ categories: CATEGORIES, photos: listPhotos().map(photoJson) });
  } catch (err) { next(err); }
});

/* Runs the upload, then hands the handler the request with the photo
   already resized. Shared by gallery photos and the fixed site photos. */
function withPhoto(sizing, handler) {
  return (req, res, next) => {
    upload.single('photo')(req, res, async (uploadErr) => {
      try {
        if (uploadErr?.code === 'LIMIT_FILE_SIZE') throw badRequest(`That photo is over ${MAX_UPLOAD_MB} MB. Try a smaller one.`);
        if (uploadErr) throw badRequest('That upload did not go through. Please try again.');
        if (!req.file) throw badRequest('Please choose a photo (JPG, PNG or WebP).');

        /* Check the request is valid before the slow resize. */
        const opts = typeof sizing === 'function' ? sizing(req) : sizing;

        let img;
        try {
          img = await processPhoto(req.file.buffer, opts);
        } catch (_) {
          throw badRequest("That file couldn't be read as a photo. If it's from an iPhone, try sharing it as a JPG.");
        }
        await handler(req, res, img);
      } catch (err) { next(err); }
    });
  };
}

ownerRouter.post('/photos', withPhoto(
  (req) => {
    if (!CATEGORY_KEYS.has(String(req.body?.category || ''))) throw badRequest('Please pick a category.');
    return {};
  },
  async (req, res, img) => {
    const category = String(req.body.category);
    const caption = clean(req.body?.caption, 80);

    /* New work goes to the front of its category. */
    const { rows } = await query(
      `INSERT INTO photos (category, caption, alt, sort_order, mime, width, height, bytes, data)
       VALUES ($1, $2, $3,
               (SELECT COALESCE(MIN(sort_order), 0) - 1 FROM photos WHERE category = $1),
               $4, $5, $6, $7, $8)
       RETURNING id, category, caption, alt, width, height, bytes, created_at`,
      [category, caption, caption, img.mime, img.width, img.height, img.data.length, img.data]
    );
    await loadGallery();
    res.status(201).json({ photo: photoJson(rows[0]) });
  }
));

/* ── Website photos (banner, About photos, logo) ───────────── */
const siteSlot = (req) => {
  const slot = SITE_IMAGE_KEYS.get(req.params.slot);
  if (!slot) throw Object.assign(new Error('Unknown photo spot.'), { status: 404 });
  return slot;
};

ownerRouter.get('/site-images', async (_req, res, next) => {
  try {
    await loadSiteImages();
    res.json({ images: listSiteImages() });
  } catch (err) { next(err); }
});

ownerRouter.post('/site-images/:slot', withPhoto(
  (req) => {
    const { maxEdge, quality } = siteSlot(req);
    return { maxEdge, quality };
  },
  async (req, res, img) => {
    await query(
      `INSERT INTO site_images (slot, mime, width, height, bytes, data, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (slot) DO UPDATE SET
         mime = EXCLUDED.mime, width = EXCLUDED.width, height = EXCLUDED.height,
         bytes = EXCLUDED.bytes, data = EXCLUDED.data, updated_at = NOW()`,
      [req.params.slot, img.mime, img.width, img.height, img.data.length, img.data]
    );
    await loadSiteImages();
    res.json({ images: listSiteImages() });
  }
));

/* Puts the original photo back. */
ownerRouter.delete('/site-images/:slot', async (req, res, next) => {
  try {
    siteSlot(req);
    await query('DELETE FROM site_images WHERE slot = $1', [req.params.slot]);
    await loadSiteImages();
    res.json({ images: listSiteImages() });
  } catch (err) { next(err); }
});

ownerRouter.patch('/photos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const { rows: found } = await query('SELECT id, category FROM photos WHERE id = $1', [id]);
    if (!found.length) return res.status(404).json({ error: 'That photo was already removed.' });

    const caption = req.body?.caption !== undefined ? clean(req.body.caption, 80) : null;
    const category = req.body?.category !== undefined ? String(req.body.category) : null;
    if (category !== null && !CATEGORY_KEYS.has(category)) throw badRequest('Please pick a category.');

    const moving = category !== null && category !== found[0].category;
    await query(
      `UPDATE photos SET
         caption    = COALESCE($2, caption),
         alt        = COALESCE($2, alt),
         category   = COALESCE($3, category),
         sort_order = CASE WHEN $4 THEN (SELECT COALESCE(MIN(sort_order), 0) - 1 FROM photos WHERE category = $3)
                           ELSE sort_order END
       WHERE id = $1`,
      [id, caption, category, moving]
    );
    await loadGallery();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* Swaps a photo with its neighbour in the same category. The category is
   renumbered 0..n first so ties or gaps from earlier inserts can't make a
   move do nothing. */
ownerRouter.post('/photos/:id/move', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const dir = req.body?.direction === 'up' ? -1 : req.body?.direction === 'down' ? 1 : 0;
    if (!dir) throw badRequest('Direction must be up or down.');

    await tx(async (client) => {
      const { rows: [photo] } = await client.query('SELECT category FROM photos WHERE id = $1', [id]);
      if (!photo) return;
      const { rows } = await client.query(
        'SELECT id FROM photos WHERE category = $1 ORDER BY sort_order, id FOR UPDATE', [photo.category]
      );
      const ids = rows.map((r) => r.id);
      const i = ids.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await client.query(
        'UPDATE photos SET sort_order = o.n FROM unnest($1::int[]) WITH ORDINALITY AS o(id, n) WHERE photos.id = o.id',
        [ids]
      );
    });
    await loadGallery();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

ownerRouter.delete('/photos/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await query('DELETE FROM photos WHERE id = $1', [id]);
    forgetPhotoBytes(id);
    await loadGallery();
    res.json({ ok: true });
  } catch (err) { next(err); }
});
