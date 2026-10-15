import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '..', '..', 'seed');

/* The filter buttons and section headings on the homepage, in page order.
   The keys are what's stored in photos.category. */
export const CATEGORIES = [
  { key: 'mowing', label: '🌿 Lawn Mowing' },
  { key: 'mulching', label: '🪵 Mulching' },
  { key: 'landscaping', label: '🌳 Landscaping' },
];
export const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

/* ── In-memory copy ───────────────────────────────────────────
   Neon's free plan bills for the time its compute is awake, and a query on
   every page view would keep it awake all day (this is what took Classic
   Cleanz down in September 2026). So the list of photos is read once at
   boot and again only when the owner changes something, and the image bytes
   are cached after the first request. Photo URLs are immutable — an id is
   never reused and a photo's bytes never change — so browsers cache them
   for a year and rarely ask at all. */
let photos = null; // null until the database has been read once
const bytesCache = new Map();
let cachedBytes = 0;
const MAX_CACHED_BYTES = 120 * 1024 * 1024;

export async function loadGallery() {
  const { rows } = await query(
    `SELECT id, category, caption, alt, sort_order, width, height, bytes, created_at
       FROM photos ORDER BY sort_order, id`
  );
  photos = rows;
}

export function listPhotos() {
  return photos || [];
}

export function galleryLoaded() {
  return photos !== null;
}

export function forgetPhotoBytes(id) {
  const buf = bytesCache.get(id);
  if (buf) { cachedBytes -= buf.length; bytesCache.delete(id); }
}

export async function getPhotoBytes(id) {
  if (bytesCache.has(id)) return bytesCache.get(id);
  const { rows } = await query('SELECT data FROM photos WHERE id = $1', [id]);
  if (!rows.length) return null;
  const buf = rows[0].data;
  /* Oldest-first eviction keeps memory bounded on the 512 MB instance even
     if the gallery grows into the thousands. */
  while (cachedBytes + buf.length > MAX_CACHED_BYTES && bytesCache.size) {
    const [oldId] = bytesCache.keys();
    forgetPhotoBytes(oldId);
  }
  bytesCache.set(id, buf);
  cachedBytes += buf.length;
  return buf;
}

/* ── Homepage rendering ───────────────────────────────────────
   The gallery is written into the page on the server, using exactly the
   markup the static site had, so it looks identical, needs no extra
   request, and search engines still see the photos. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

/* Before the database has ever been reached (it was down at boot), show the
   photos the site launched with rather than an empty gallery. */
function fallbackPhotos() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SEED_DIR, 'photos.json'), 'utf8'));
  return manifest.map((p) => ({ ...p, src: `/photos/seed/${p.file}` }));
}

function itemsFor() {
  if (photos === null) return fallbackPhotos();
  return photos.map((p) => ({ ...p, src: `/photos/${p.id}.jpg` }));
}

function renderItem(p) {
  const overlay = p.caption ? `\n          <div class="g-overlay"><span>${esc(p.caption)}</span></div>` : '';
  return `        <div class="g-item" data-category="${p.category}">
          <img src="${p.src}" alt="${esc(p.alt || p.caption || 'Q & M Lawncare work')}" loading="lazy" />${overlay}
        </div>`;
}

export function renderGallery(html) {
  const items = itemsFor();
  const present = CATEGORIES.filter((c) => items.some((p) => p.category === c.key));

  const filters = present
    .map((c) => `      <button class="gf-btn" data-filter="${c.key}">${c.label}</button>`)
    .join('\n');

  const sections = present.map((c) => `    <div class="gallery-category-section" id="cat-${c.key}">
      <div class="gallery-cat-header">
        <h3>${c.label}</h3>
        <div class="gallery-cat-line"></div>
      </div>
      <div class="gallery-grid">
${items.filter((p) => p.category === c.key).map(renderItem).join('\n')}
      </div>
    </div>`).join('\n\n');

  return html
    .replace('<!--GALLERY_FILTERS-->', filters)
    .replace('<!--GALLERY_SECTIONS-->', sections);
}
