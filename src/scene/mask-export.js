/**
 * MASK EXPORT — where a full-size mask file goes, what it is called, how big
 * it is, and how it is drawn band by band. The pure half of "Save next to
 * map" / "Download" / "Import"; the browser half (encoding, upload, the file
 * picker) is `foundry/mask-file-writer.js`.
 *
 * Author, 2026-11-01: *"we allow the user to save a full resolution version of
 * the mask to their own computer and then automatically we start a process to
 * allow the user to re-upload that full resolution mask to a position
 * automatically alongside the map albedo so that everything lines up
 * automatically ... Ideally every mask could be exported in this way."*
 * Decided with her the same day (plan page defaults): write straight next to
 * the map when Foundry allows it — a GM with upload permission may write
 * anywhere under Foundry's Data folder (`dist/server/views/upload.mjs`) and
 * overwrite image files — with Download and Import always offered too; and a
 * map that lives inside ANOTHER module's folder (wiped when that module
 * updates) gets its masks in this world's folder instead, remembered on the
 * scene (`maskFolder`), which mask discovery then lists as well.
 *
 * Pure. Node-tested.
 *
 * @module scene/mask-export
 */

import { MASK_KINDS } from './mask-catalog.js';
import { bandSpec } from './mask-ops.js';

/** Longest side a browser canvas will hold (Chromium and Firefox both). */
export const EXPORT_MAX_SIDE = 16384;
/** Pixel-count cap for one export canvas (RGBA: 4 bytes each — 800 MB at the cap). */
export const EXPORT_MAX_PIXELS = 200 * 1024 * 1024;
/** Texels per working band — keeps the replay buffer near 8 MB however big the map. */
export const EXPORT_BAND_TEXELS = 8 * 1024 * 1024;
/** World-folder home for masks of maps MSA should not write beside. */
export const WORLD_MASK_FOLDER = 'map-shine-masks';

/** Split a Foundry data path into dir / base / ext (no query string). */
export function splitPath(url) {
  const clean = String(url ?? '').split('?')[0];
  const slash = clean.lastIndexOf('/');
  const dir = slash >= 0 ? clean.slice(0, slash) : '';
  const file = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  return { dir, base: file.slice(0, dot), ext: file.slice(dot + 1).toLowerCase() };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s;
  }
}

/** True for URLs that are not a path in Foundry's own Data folder. */
export function isExternalUrl(url) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(url ?? ''));
}

/**
 * What can be done with a kind's file. `gray` kinds round-trip losslessly
 * through a grey picture. A `color` kind's FILE holds colour the painter
 * cannot see, so it may be written fresh but never re-written over an existing
 * colour file. `rgba` kinds (tree and bush art, water/fluid data) are images
 * in their own right — import only.
 * @param {string} kindId @param {{fileExists:boolean}} opts
 * @returns {{canWrite:boolean, canImport:boolean, why?:string}}
 */
export function kindFileSupport(kindId, { fileExists }) {
  const kind = MASK_KINDS.find((k) => k.id === kindId);
  if (!kind || !Array.isArray(kind.suffixes) || kind.suffixes.length === 0)
    return { canWrite: false, canImport: false, why: 'not a mask with a file' };
  if (kind.channels === 'gray') return { canWrite: true, canImport: true };
  if (kind.channels === 'color')
    return fileExists
      ? {
          canWrite: false,
          canImport: true,
          why: 'its file holds colour the painter cannot see — edit it in an image editor',
        }
      : { canWrite: true, canImport: true };
  return {
    canWrite: false,
    canImport: true,
    why: 'this file is artwork, not a painted mask — import it from your computer',
  };
}

/**
 * Where a kind's mask file goes for one piece of map art.
 *
 * @param {object} args
 * @param {string} args.artUrl - the background art's src (a Data path, or a full URL).
 * @param {string} args.kindId
 * @param {string|null} [args.existingUrl] - the file discovery already found, if any.
 *   An existing file is overwritten in place, so it keeps winning discovery.
 * @param {string|null} [args.worldId]
 * @param {string|null} [args.sceneId]
 * @param {string|null} [args.maskFolder] - the scene's remembered mask folder, if set.
 * @returns {{route:'beside'|'world'|'download', dir:string|null, fileName:string, why:string}}
 */
export function planMaskFile({
  artUrl,
  kindId,
  existingUrl = null,
  worldId = null,
  sceneId = null,
  maskFolder = null,
}) {
  const kind = MASK_KINDS.find((k) => k.id === kindId);
  const suffix = kind?.suffixes?.[0] ?? '';
  const art = splitPath(artUrl);
  if (!art)
    return {
      route: 'download',
      dir: null,
      fileName: `mask${suffix}.png`,
      why: "the map art's file name could not be read",
    };
  const fileName = `${safeDecode(art.base)}${suffix}.png`;

  if (existingUrl && !isExternalUrl(existingUrl)) {
    const ex = splitPath(existingUrl);
    if (ex) {
      const inWorldFolder = ex.dir.includes(`/${WORLD_MASK_FOLDER}/`) || ex.dir.endsWith(`/${WORLD_MASK_FOLDER}`);
      return {
        route: inWorldFolder ? 'world' : 'beside',
        dir: ex.dir,
        fileName: `${safeDecode(ex.base)}.${ex.ext}`,
        why: 'replaces the mask file already in use',
      };
    }
  }
  if (isExternalUrl(artUrl)) {
    return {
      route: 'download',
      dir: null,
      fileName,
      why: 'the map art is on another server (a CDN or cloud bucket), so Map Shine cannot put a file beside it',
    };
  }
  const top = art.dir.split('/')[0];
  if (top === 'modules' || top === 'systems') {
    if (!worldId) return { route: 'download', dir: null, fileName, why: 'no world folder to save into' };
    return {
      route: 'world',
      dir: maskFolder || `worlds/${worldId}/${WORLD_MASK_FOLDER}/${sceneId || 'scene'}`,
      fileName,
      why: "the map art sits in another module's folder, which is wiped when that module updates — saved in this world instead",
    };
  }
  return { route: 'beside', dir: art.dir, fileName, why: 'saved next to the map art' };
}

/**
 * The export size for a piece of art: its own pixel size, scaled down only if
 * a browser canvas could not hold it.
 * @returns {{w:number, h:number, scaled:boolean}}
 */
export function exportDimensions(artW, artH, { maxSide = EXPORT_MAX_SIDE, maxPixels = EXPORT_MAX_PIXELS } = {}) {
  const w0 = Math.max(1, Math.round(artW));
  const h0 = Math.max(1, Math.round(artH));
  let s = Math.min(1, maxSide / Math.max(w0, h0));
  if (w0 * h0 * s * s > maxPixels) s = Math.sqrt(maxPixels / (w0 * h0));
  if (s >= 1) return { w: w0, h: h0, scaled: false };
  return { w: Math.max(1, Math.floor(w0 * s)), h: Math.max(1, Math.floor(h0 * s)), scaled: true };
}

/**
 * Bands of rows covering a `w`×`h` export over `rect`, each with its own grid
 * spec, small enough to replay into one working buffer.
 * @returns {Array<{row0:number, row1:number, spec:object}>}
 */
export function planBands(rect, w, h, bandTexels = EXPORT_BAND_TEXELS) {
  const rows = Math.max(1, Math.floor(bandTexels / Math.max(1, w)));
  const out = [];
  for (let r0 = 0; r0 < h; r0 += rows) {
    const r1 = Math.min(h, r0 + rows);
    out.push({ row0: r0, row1: r1, spec: bandSpec(rect, w, h, r0, r1) });
  }
  return out;
}

/**
 * Grey bytes → opaque RGBA (r = g = b = value), written into `rgba` — the
 * buffer behind an ImageData for the band.
 * @param {Uint8Array} grey @param {Uint8ClampedArray|Uint8Array} rgba
 */
export function greyToRgba(grey, rgba) {
  for (let i = 0, j = 0; i < grey.length; i++, j += 4) {
    const v = grey[i];
    rgba[j] = v;
    rgba[j + 1] = v;
    rgba[j + 2] = v;
    rgba[j + 3] = 255;
  }
  return rgba;
}

/**
 * Is an imported picture the right shape for this map? Size must match the
 * art's aspect within 1% — a mask of another map's shape would be stretched
 * into place and never line up. A different RESOLUTION with the same shape is
 * fine (Map Shine reads masks in the art's own UV space).
 * @returns {{ok:boolean, why?:string, sameSize:boolean}}
 */
export function checkImportSize(fileW, fileH, artW, artH) {
  if (!(fileW > 0 && fileH > 0)) return { ok: false, why: 'the picture has no size', sameSize: false };
  if (!(artW > 0 && artH > 0)) return { ok: true, sameSize: false };
  const a = fileW / fileH;
  const b = artW / artH;
  const sameSize = Math.round(fileW) === Math.round(artW) && Math.round(fileH) === Math.round(artH);
  if (Math.abs(a - b) / b > 0.01)
    return {
      ok: false,
      why: `the picture is ${fileW}×${fileH} but the map is ${artW}×${artH} — a different shape would not line up`,
      sameSize,
    };
  return { ok: true, sameSize };
}
