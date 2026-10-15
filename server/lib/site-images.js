import { query } from '../db.js';

/* The fixed photos on the homepage. Each appears in public/index.html (and
   the logo in admin.html) as __SITE_IMAGE_<key>__, which is swapped for the
   owner's replacement if there is one, otherwise the original file. */
export const SITE_IMAGES = [
  {
    key: 'hero', label: 'Homepage Banner',
    desc: 'The big background photo at the top of the site. It’s shown darkened behind the headline. Wide (landscape) photos work best.',
    original: '/IMG_2596.jpeg', maxEdge: 2000, quality: 76,
  },
  {
    key: 'about-main', label: 'About Us — Main Photo',
    desc: 'The large photo next to “Founded on Hustle. Built on Passion.”',
    original: '/IMG_1715.jpeg', maxEdge: 1400,
  },
  {
    key: 'about-accent', label: 'About Us — Small Photo',
    desc: 'The smaller photo that overlaps the corner of the main About photo.',
    original: '/510502370_122156325092475587_8955067726823217445_n.jpg', maxEdge: 1000,
  },
  {
    key: 'logo', label: 'Logo',
    desc: 'Shown in a white circle in the menu bar and footer. A square image works best.',
    original: '/IMG_1494.jpeg', maxEdge: 600, quality: 85,
  },
];
export const SITE_IMAGE_KEYS = new Map(SITE_IMAGES.map((s) => [s.key, s]));

/* Same approach as the gallery: read once, kept in memory, so page views
   never wake the database. There are only four, so all bytes are kept. */
let custom = new Map(); // key -> { version, data }

export async function loadSiteImages() {
  const { rows } = await query(
    `SELECT slot, data, (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS version FROM site_images`
  );
  custom = new Map(rows.map((r) => [r.slot, { version: String(r.version), data: r.data }]));
}

/* The version is in the URL, so a replaced photo gets a new address and
   the old one can be cached by browsers forever. */
export function siteImageUrl(key) {
  const c = custom.get(key);
  return c ? `/site-images/${key}-${c.version}.jpg` : SITE_IMAGE_KEYS.get(key).original;
}

export function getSiteImageBytes(key, version) {
  const c = custom.get(key);
  return c && c.version === version ? c.data : null;
}

export function listSiteImages() {
  return SITE_IMAGES.map((s) => ({
    key: s.key, label: s.label, desc: s.desc,
    url: siteImageUrl(s.key), custom: custom.has(s.key),
  }));
}

export function renderSiteImages(html) {
  return html.replace(/__SITE_IMAGE_([a-z-]+)__/g, (m, key) => (SITE_IMAGE_KEYS.has(key) ? siteImageUrl(key) : m));
}
