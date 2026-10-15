import sharp from 'sharp';

/* No libvips cache and a single worker thread: the server is a 512 MB
   instance and a phone original decodes to well over 100 MB. */
sharp.cache(false);
sharp.concurrency(1);

/* Every photo is stored once, at a size that looks sharp in the gallery on
   any screen (cards are at most ~400px wide, so 1400px covers retina
   screens and full-width phones) but is a fraction of a phone original. A 13 MB iPhone
   shot comes out around 200-450 KB. That keeps the page fast and the Neon
   free plan (0.5 GB) good for well over a thousand photos. */
const MAX_EDGE = 1400;
const QUALITY = 76;

/* rotate() with no argument applies the EXIF orientation, so a portrait
   phone photo doesn't come out sideways. The output carries no metadata at
   all — phone photos embed GPS coordinates, which for a lawn company means
   a customer's home address. */
export async function processPhoto(input) {
  const { data, info } = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, mime: 'image/jpeg' };
}
