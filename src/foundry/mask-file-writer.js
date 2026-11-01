/**
 * MASK FILE WRITER — the browser and Foundry half of "Save next to map",
 * "Download" and "Import" (MSA Ready, 2026-11-01). The pure half — where a
 * file goes, its name, its size, the band plan — is `scene/mask-export.js`;
 * the history it draws is `scene/mask-ops.js`.
 *
 * What Foundry v14 actually allows, read from its own source rather than
 * assumed (`resources/app/dist/server/views/upload.mjs`, `dist/files/files.mjs`,
 * `client/applications/apps/file-picker.mjs`):
 *   - a user with FILES_UPLOAD may write to any EXISTING folder under the Data
 *     folder (`target directory ... does not exist` otherwise — so a new folder
 *     is created first);
 *   - an image upload always overwrites (`files.mjs`: `overwrite = isMedia`);
 *   - a write into `modules/…` or `systems/…` succeeds but warns that a package
 *     update wipes it — which is why `planMaskFile` routes those to the world;
 *   - a reverse proxy may refuse a big body (HTTP 413) — reported as such.
 *
 * Every function here fails SOFT with a reason a GM can read: a mask that
 * could not be written is a message, never a broken scene.
 *
 * @module foundry/mask-file-writer
 */

import {
  replayOps,
  planBands,
  greyToRgba,
  exportDimensions,
  fileByteToPainted,
  createMaskGrid,
} from '../scene/index.js';
import { createLogger } from '../core/log.js';

const log = createLogger('mask-files');
const MODULE_ID = 'map-shine-advanced';
const MASK_FOLDER_FLAG = 'maskFolder';

function filePickerImpl() {
  const ns = globalThis.foundry?.applications?.apps?.FilePicker;
  return ns?.implementation ?? ns ?? null;
}

/** May this user upload files at all? */
export function canUploadFiles() {
  try {
    const user = globalThis.game?.user;
    if (!user) return false;
    if (user.isGM) return user.can?.('FILES_UPLOAD') !== false;
    return user.can?.('FILES_UPLOAD') === true;
  } catch (_) {
    return false;
  }
}

/** The active world's id and the active scene's id (or nulls). */
export function readWorldAndScene() {
  const g = globalThis.game;
  return { worldId: g?.world?.id ?? null, sceneId: globalThis.canvas?.scene?.id ?? null };
}

/** The scene's remembered mask folder (or null). */
export function readSceneMaskFolder(scene = globalThis.canvas?.scene) {
  try {
    const v = scene?.getFlag?.(MODULE_ID, MASK_FOLDER_FLAG);
    return typeof v === 'string' && v.length > 0 ? v : null;
  } catch (_) {
    return null;
  }
}

/** Remember where this scene's masks live (GM only). */
export async function writeSceneMaskFolder(dir) {
  const scene = globalThis.canvas?.scene;
  if (!scene || !globalThis.game?.user?.isGM) return false;
  if (readSceneMaskFolder(scene) === dir) return true;
  await scene.setFlag(MODULE_ID, MASK_FOLDER_FLAG, dir);
  return true;
}

/** Load an image element from a URL (optionally bypassing the HTTP cache). */
function loadImage(url, { fresh = false } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${url}`));
    img.src = fresh ? `${url}${url.includes('?') ? '&' : '?'}msa=${Math.random().toString(36).slice(2)}` : url;
  });
}

/** The pixel size of a piece of art. */
export async function readArtSize(url) {
  const img = await loadImage(url);
  return { w: img.naturalWidth, h: img.naturalHeight };
}

/**
 * Read a mask FILE into a painter grid: drawn at the grid's own size, then
 * every pixel turned into the one byte it means (grey × coverage, with
 * transparency as the kind's absent value).
 * @param {string} url @param {{w:number,h:number}} spec @param {number} absentValue
 * @returns {Promise<Uint8Array>}
 */
export async function readMaskFileToGrid(url, spec, absentValue, { fresh = false } = {}) {
  const img = await loadImage(url, { fresh });
  const cv = document.createElement('canvas');
  cv.width = spec.w;
  cv.height = spec.h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, spec.w, spec.h);
  const px = ctx.getImageData(0, 0, spec.w, spec.h).data;
  const out = new Uint8Array(spec.w * spec.h);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = fileByteToPainted(px[j], px[j + 3], absentValue);
  return out;
}

/**
 * Draw a layer's history at full size and encode it as a PNG.
 *
 * Band by band (`planBands`), so the working buffer stays small; each band is
 * replayed into its own grid and copied into ONE canvas the size of the
 * export. A history that starts from an existing file (`seed` with a `url`)
 * reads that file at full size for each band instead of its stored 4096-grid
 * copy — so editing a Photoshop-made mask in Map Shine never costs it detail.
 *
 * @param {object} args
 * @param {object[]} args.ops - the layer's history.
 * @param {{x:number,y:number,width:number,height:number}} args.rect - the art's world rect.
 * @param {number} args.artW @param {number} args.artH - the art's pixel size.
 * @param {number} args.absentValue - the kind's absent value (for a seed file's transparency).
 * @param {(p:{done:number,total:number}) => void} [args.onProgress]
 * @param {string} [args.mimeType] - 'image/png' (new files) or the type of the file being replaced.
 * @returns {Promise<{blob: Blob, w:number, h:number, scaled:boolean}>}
 */
export async function renderMaskFile({ ops, rect, artW, artH, absentValue, mimeType = 'image/png', onProgress }) {
  const { w, h, scaled } = exportDimensions(artW, artH);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  if (!octx) throw new Error(`the browser could not make a ${w}×${h} canvas`);

  // Full-size readers for any file the history started from.
  const seedImages = new Map();
  for (const op of ops) {
    if (op?.t === 'seed' && op.url && !seedImages.has(op.url)) {
      try {
        seedImages.set(op.url, await loadImage(op.url));
      } catch (err) {
        log.warn(`full-size read of ${op.url} failed — its stored painter copy is used instead:`, err);
        seedImages.set(op.url, null);
      }
    }
  }
  const scratch = document.createElement('canvas');
  const sctx = scratch.getContext('2d', { willReadFrequently: true });

  const bands = planBands(rect, w, h);
  let done = 0;
  for (const band of bands) {
    const bw = band.spec.w;
    const bh = band.spec.h;
    // Per band, each seed file drawn over exactly this band's world rows.
    const bandSeeds = new Map();
    for (const [url, img] of seedImages) {
      if (!img) continue;
      scratch.width = bw;
      scratch.height = bh;
      sctx.clearRect(0, 0, bw, bh);
      const sy = (band.row0 / h) * img.naturalHeight;
      const sh = ((band.row1 - band.row0) / h) * img.naturalHeight;
      sctx.drawImage(img, 0, sy, img.naturalWidth, sh, 0, 0, bw, bh);
      bandSeeds.set(url, sctx.getImageData(0, 0, bw, bh).data);
    }
    const env = {
      readSeed: (op) => {
        const px = op.url ? bandSeeds.get(op.url) : null;
        if (!px) return null;
        const s = band.spec;
        return (wx, wy) => {
          const x = Math.min(bw - 1, Math.max(0, Math.floor((wx - s.x) / s.texelW)));
          const y = Math.min(bh - 1, Math.max(0, Math.floor((wy - s.y) / s.texelH)));
          const j = (y * bw + x) * 4;
          return fileByteToPainted(px[j], px[j + 3], absentValue);
        };
      },
    };
    const grid = replayOps(createMaskGrid(band.spec), ops, env);
    const img = octx.createImageData(bw, bh);
    greyToRgba(grid.data, img.data);
    octx.putImageData(img, 0, band.row0);
    done++;
    onProgress?.({ done, total: bands.length });
    // Let the page breathe between bands (a 16K export is many of them).
    await new Promise((r) => setTimeout(r, 0));
  }
  const blob = await new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not encode the mask'))), mimeType, 1)
  );
  out.width = out.height = 1; // release the big backing store now, not at GC
  return { blob, w, h, scaled };
}

/** Make sure a Data folder exists, creating each missing level. */
async function ensureDataFolder(dir) {
  const FP = filePickerImpl();
  if (!FP?.browse || !FP?.createDirectory) return;
  const parts = String(dir).split('/').filter(Boolean);
  let path = '';
  for (const part of parts) {
    const parent = path || '.';
    path = path ? `${path}/${part}` : part;
    let exists = false;
    try {
      const listing = await FP.browse('data', parent);
      exists = (listing?.dirs ?? []).some(
        (d) => decodeURIComponent(String(d)).replace(/\/$/, '') === decodeURIComponent(path)
      );
    } catch (err) {
      log.warn(`could not list ${parent} — trying to create ${path} anyway:`, err);
      exists = false;
    }
    if (exists) continue;
    try {
      await FP.createDirectory('data', path);
    } catch (err) {
      // "already exists" races are fine; anything else surfaces at upload.
      log.warn(`could not create ${path}:`, err);
    }
  }
}

/**
 * Upload a mask file into a Data folder.
 * @returns {Promise<{ok:boolean, path?:string, reason?:string}>}
 */
export async function uploadMaskFile({ dir, fileName, blob, createFolder = false }) {
  const FP = filePickerImpl();
  if (!FP?.upload) return { ok: false, reason: "Foundry's file uploader is not available" };
  if (!canUploadFiles()) return { ok: false, reason: 'you do not have permission to upload files' };
  try {
    if (createFolder) await ensureDataFolder(dir);
    const file = new File([blob], fileName, { type: blob.type || 'image/png' });
    const res = await FP.upload('data', dir, file, {}, { notify: false });
    if (!res || res === true) return { ok: false, reason: 'the upload was refused (the server may limit file size)' };
    if (!res.path) return { ok: false, reason: res.message || 'the server gave no file path back' };
    // Refresh the browser's HTTP cache for this path, so a replaced file is
    // not served stale to the renderer on the reload that follows.
    try {
      await fetch(res.path, { cache: 'reload' });
    } catch (err) {
      log.warn(`could not refresh the cached copy of ${res.path} — the next view may be stale:`, err);
    }
    return { ok: true, path: res.path };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

/** Save a blob to the user's computer. */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Ask the user for one image file from their computer (null = cancelled). */
export function pickLocalImage() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/webp,image/jpeg';
    input.style.display = 'none';
    let settled = false;
    const finish = (file) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file ?? null);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Pixel size of a picked file. */
export async function readLocalImageSize(file) {
  const bmp = await createImageBitmap(file);
  const size = { w: bmp.width, h: bmp.height };
  bmp.close?.();
  return size;
}

/**
 * Re-encode an imported picture at the art's pixel size (and in the target
 * file's format) when it is the right shape but a different resolution or type — so the file beside the map is
 * always the map's own size, as the author asked.
 */
export async function resizeImageFile(file, w, h, mimeType = 'image/png') {
  const bmp = await createImageBitmap(file);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const blob = await new Promise((resolve, reject) =>
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode the resized picture'))), mimeType, 1)
  );
  cv.width = cv.height = 1;
  return blob;
}

/** The MIME type to encode for a target file name. */
export function mimeTypeForFile(fileName) {
  const ext = String(fileName).split('.').pop().toLowerCase();
  if (ext === 'webp') return 'image/webp';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'image/png';
}
