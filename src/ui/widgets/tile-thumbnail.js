/**
 * ui/widgets/tile-thumbnail.js — alpha-cropped tile texture thumbnails
 * (2026-09-08, author request: "thumbnails would maximise the visible
 * (not transparent) parts of the graphics").
 *
 * WHY THIS EXISTS: several tiles on this map (the clock hands, e.g.) are
 * large square canvases with a small visible shape and huge transparent
 * padding around it — padding a rotating tile genuinely needs so nothing
 * gets clipped as it spins. A naive downscaled thumbnail of the whole
 * texture would show a tiny hand lost in a mostly-empty square. This finds
 * the texture's own non-transparent bounding box first, then crops the
 * FULL-resolution source to that box — the thumbnail ends up dominated by
 * the actual graphic, whatever its aspect ratio or padding.
 *
 * COST CONTROL: the bounding-box SEARCH runs against a small analysis
 * canvas (ANALYSIS_SIZE px), never the full-resolution source — reading
 * `getImageData` off a multi-thousand-pixel image would be slow and
 * memory-heavy for no benefit, since the box only needs to be found
 * approximately before mapping it back into source-pixel coordinates. The
 * actual thumbnail draw still samples the FULL-resolution image (browsers
 * downscale `drawImage` well), so quality isn't lost to that shortcut.
 *
 * Pure DOM/Canvas2D — no PIXI, no THREE, no `canvas`/`Hooks` — reads
 * nothing but a texture URL, so it works from `ui/` without going anywhere
 * near foundry/adapter-only's territory.
 *
 * @module ui/widgets/tile-thumbnail
 */

const ANALYSIS_SIZE = 128;
const ALPHA_THRESHOLD = 10; // 0-255 — anything above this counts as "visible"
const BBOX_PADDING_FRACTION = 0.08; // of the detected box's own size, each side

/** @type {Map<string, Promise<{img: HTMLImageElement, bbox: {x:number,y:number,w:number,h:number}}>>} */
const sourceCache = new Map();

/** @param {string} src @returns {Promise<HTMLImageElement>} */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // same-origin is unaffected; guards a future off-origin asset host
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tile-thumbnail: failed to load ${src}`));
    // A Tile document's texture.src is route-relative ("modules/foo/assets/x.webp"),
    // never an absolute URL — resolving it through the browser's own relative-URL
    // rules (by just assigning it to img.src) depends on the CURRENT PAGE's own
    // path shape lining up by coincidence, and silently breaks whenever it
    // doesn't (a blank thumbnail, no error surfaced anywhere an author would see
    // it — live report, 2026-09-08: "no thumbnail"). foundry.utils.getRoute() is
    // Foundry's own official resolver for exactly this, honoring any configured
    // route prefix — the same thing every other asset load in Foundry itself
    // goes through.
    img.src = typeof foundry !== 'undefined' ? foundry.utils.getRoute(src) : src;
  });
}

/**
 * Finds the image's own non-transparent bounding box, in the SOURCE image's
 * own pixel coordinates, via a cheap downscaled analysis pass.
 * @param {HTMLImageElement} img
 * @returns {{x:number,y:number,w:number,h:number}}
 */
function findAlphaBBox(img) {
  const w0 = img.naturalWidth || img.width || 1;
  const h0 = img.naturalHeight || img.height || 1;

  const analysis = document.createElement('canvas');
  analysis.width = ANALYSIS_SIZE;
  analysis.height = ANALYSIS_SIZE;
  const actx = analysis.getContext('2d', { willReadFrequently: true });

  // Fit the whole image into the analysis square, preserving aspect ratio,
  // centered — so the box found here maps back to source pixels by one
  // consistent scale + offset, not a stretched/skewed guess.
  const scale = Math.min(ANALYSIS_SIZE / w0, ANALYSIS_SIZE / h0);
  const dw = Math.max(1, Math.round(w0 * scale));
  const dh = Math.max(1, Math.round(h0 * scale));
  const offX = Math.floor((ANALYSIS_SIZE - dw) / 2);
  const offY = Math.floor((ANALYSIS_SIZE - dh) / 2);

  actx.clearRect(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE);
  try {
    actx.drawImage(img, offX, offY, dw, dh);
  } catch (_) {
    return { x: 0, y: 0, w: w0, h: h0 }; // e.g. a tainted canvas — fall back to the whole image
  }

  let data;
  try {
    data = actx.getImageData(0, 0, ANALYSIS_SIZE, ANALYSIS_SIZE).data;
  } catch (_) {
    return { x: 0, y: 0, w: w0, h: h0 };
  }

  let minX = ANALYSIS_SIZE;
  let minY = ANALYSIS_SIZE;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < ANALYSIS_SIZE; y++) {
    const rowBase = y * ANALYSIS_SIZE;
    for (let x = 0; x < ANALYSIS_SIZE; x++) {
      const alpha = data[(rowBase + x) * 4 + 3];
      if (alpha > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    // Fully transparent (or an opaque-alpha-free format) — whole image is the best we can do.
    return { x: 0, y: 0, w: w0, h: h0 };
  }

  // Analysis-space box -> drawn-image-local space (undo centering) -> source pixels (undo scale).
  const bx0 = (minX - offX) / scale;
  const by0 = (minY - offY) / scale;
  const bx1 = (maxX + 1 - offX) / scale;
  const by1 = (maxY + 1 - offY) / scale;
  const bw = Math.max(1, bx1 - bx0);
  const bh = Math.max(1, by1 - by0);
  const padX = bw * BBOX_PADDING_FRACTION;
  const padY = bh * BBOX_PADDING_FRACTION;
  const x = Math.max(0, bx0 - padX);
  const y = Math.max(0, by0 - padY);
  const w = Math.min(w0 - x, bw + padX * 2);
  const h = Math.min(h0 - y, bh + padY * 2);
  return { x, y, w, h };
}

/**
 * Loads (once per src) and analyzes a texture, caching the result.
 * @param {string} src
 * @returns {Promise<{img: HTMLImageElement, bbox: {x:number,y:number,w:number,h:number}}>}
 */
export function getTileThumbnailSource(src) {
  if (!src) return Promise.reject(new Error('tile-thumbnail: empty src'));
  let entry = sourceCache.get(src);
  if (!entry) {
    entry = loadImage(src).then((img) => ({ img, bbox: findAlphaBBox(img) }));
    entry.catch(() => sourceCache.delete(src)); // don't cache a permanent failure — a later retry may succeed
    sourceCache.set(src, entry);
  }
  return entry;
}

/**
 * Creates a square `<canvas>`, filled asynchronously with `src`'s
 * alpha-cropped thumbnail once loaded. Returned synchronously so callers can
 * insert it into a layout immediately; it just starts blank (or keeps its
 * previous frame, if reused) until the fill lands.
 * @param {string} src
 * @param {number} [size] - square output size in CSS px.
 * @returns {HTMLCanvasElement}
 */
export function createTileThumbnailCanvas(src, size = 56) {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  const px = Math.max(1, Math.round(size * dpr));
  canvas.width = px;
  canvas.height = px;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  paintTileThumbnail(canvas, src);
  return canvas;
}

/**
 * Fills an EXISTING canvas with `src`'s alpha-cropped thumbnail, sized to
 * the canvas's own current pixel dimensions. Split out from
 * `createTileThumbnailCanvas` so a grid can reuse canvases across a
 * `render()` re-run instead of recreating (and re-fetching-from-cache,
 * re-drawing) one per tile every poll tick.
 * @param {HTMLCanvasElement} canvas
 * @param {string} src
 */
export function paintTileThumbnail(canvas, src) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  getTileThumbnailSource(src)
    .then(({ img, bbox }) => {
      if (!canvas.isConnected) return; // removed from the DOM before the load finished — nothing to paint
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const fit = Math.min(canvas.width / bbox.w, canvas.height / bbox.h);
      const dw = bbox.w * fit;
      const dh = bbox.h * fit;
      const dx = (canvas.width - dw) / 2;
      const dy = (canvas.height - dh) / 2;
      ctx.drawImage(img, bbox.x, bbox.y, bbox.w, bbox.h, dx, dy, dw, dh);
    })
    .catch(() => {
      // Leave it blank — the caller's own label/tooltip still identifies the tile.
    });
}
