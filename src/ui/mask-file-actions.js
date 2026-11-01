/**
 * MASK FILE ACTIONS — the three buttons of MSA Ready (2026-11-01), as flows
 * both the painter's toolbar and the Remote's Scene readiness card call:
 *
 *   - SAVE NEXT TO MAP: draw the mask at the map art's own pixel size and write
 *     it beside the art, named so Map Shine finds it (or into this world's
 *     folder when the art lives in another module's folder).
 *   - DOWNLOAD: the same full-size file, to the GM's computer — for GIMP,
 *     Krita, Photopea, or a backup.
 *   - IMPORT: any picture from the GM's computer, checked against the map's
 *     shape, renamed, sized to the map, and placed where Map Shine finds it.
 *
 * Author: *"a pair of systems to enhance the workflow for making maps for
 * people who don't have Photoshop."* Every refusal says why, in a sentence a
 * GM can act on; a write that cannot happen falls back to a download, so the
 * painted work is never lost on a permission or a full disk.
 *
 * DOM + Foundry glue only — every decision is in `scene/mask-export.js`
 * (Node-tested), every Foundry call in `foundry/mask-file-writer.js`.
 *
 * @module ui/mask-file-actions
 */

import {
  planMaskFile,
  kindFileSupport,
  checkImportSize,
  exportDimensions,
  suffixOf,
  fileSeedUrlOf,
} from '../scene/index.js';
import {
  canUploadFiles,
  readArtSize,
  renderMaskFile,
  uploadMaskFile,
  downloadBlob,
  pickLocalImage,
  readLocalImageSize,
  resizeImageFile,
  writeSceneMaskFolder,
  mimeTypeForFile,
} from '../foundry/index.js';

/**
 * @typedef {object} MaskFileInfo - boot.js's answer for one floor + kind.
 * @property {number} floorIndex
 * @property {string|null} artUrl - the floor's background art.
 * @property {{x:number,y:number,width:number,height:number}} artRect - where it sits (world).
 * @property {string|null} existingUrl - the file discovery found for this kind, if any.
 * @property {number} absentValue - the kind's absent value (catalog).
 * @property {string|null} worldId @property {string|null} sceneId @property {string|null} maskFolder
 */

const say = (notify, msg, type = 'info') => notify?.(msg, type);

function planFor(info, kindId) {
  return planMaskFile({
    artUrl: info.artUrl,
    kindId,
    existingUrl: info.existingUrl,
    worldId: info.worldId,
    sceneId: info.sceneId,
    maskFolder: info.maskFolder,
  });
}

/** Draw the full-size file. Shared by Save and Download. */
async function render(info, kindId, ops, fileName, onProgress) {
  const art = await readArtSize(info.artUrl);
  // A history that starts from a file needs that file now; say so if it is gone.
  const seedUrl = fileSeedUrlOf(ops);
  return {
    art,
    seedUrl,
    ...(await renderMaskFile({
      ops,
      rect: info.artRect,
      artW: art.w,
      artH: art.h,
      absentValue: info.absentValue,
      mimeType: mimeTypeForFile(fileName),
      onProgress,
    })),
  };
}

/**
 * SAVE NEXT TO MAP.
 * @param {{info: MaskFileInfo, kindId: string, ops: object[], notify?: Function,
 *   onProgress?: (p:{done:number,total:number}) => void}} args
 * @returns {Promise<{ok:boolean, path?:string, downloaded?:boolean}>}
 */
export async function saveMaskFileFlow({ info, kindId, ops, notify, onProgress }) {
  const suffix = suffixOf(kindId);
  if (!info?.artUrl) {
    say(notify, `Map Shine: this floor has no map art to save a ${suffix} mask beside.`, 'warn');
    return { ok: false };
  }
  const support = kindFileSupport(kindId, { fileExists: !!info.existingUrl });
  if (!support.canWrite) {
    say(notify, `Map Shine: can't save ${suffix} from the painter — ${support.why}.`, 'warn');
    return { ok: false };
  }
  const plan = planFor(info, kindId);
  let out;
  try {
    out = await render(info, kindId, ops, plan.fileName, onProgress);
  } catch (err) {
    say(notify, `Map Shine: could not draw the full-size ${suffix} mask — ${err?.message || err}.`, 'error');
    return { ok: false };
  }
  const sizeNote = out.scaled
    ? ` (the map is ${out.art.w}×${out.art.h}; the browser can only hold ${out.w}×${out.h}, so the mask is that size — it still lines up)`
    : '';
  if (plan.route === 'download' || !canUploadFiles()) {
    downloadBlob(out.blob, plan.fileName);
    const why = plan.route === 'download' ? plan.why : 'you do not have permission to upload files';
    say(
      notify,
      `Map Shine: downloaded ${plan.fileName}${sizeNote}. Map Shine couldn't save it beside the map (${why}) — put it in the map's folder yourself and reload.`,
      'warn'
    );
    return { ok: true, downloaded: true };
  }
  const res = await uploadMaskFile({
    dir: plan.dir,
    fileName: plan.fileName,
    blob: out.blob,
    createFolder: plan.route === 'world',
  });
  if (!res.ok) {
    downloadBlob(out.blob, plan.fileName);
    say(
      notify,
      `Map Shine: saving ${plan.fileName} failed (${res.reason}). It was downloaded instead, so nothing is lost.`,
      'error'
    );
    return { ok: true, downloaded: true };
  }
  if (plan.route === 'world') {
    try {
      await writeSceneMaskFolder(plan.dir);
    } catch (err) {
      say(
        notify,
        `Map Shine: saved, but could not remember the mask folder on the scene (${err?.message || err}).`,
        'warn'
      );
    }
  }
  say(notify, `Map Shine: saved ${plan.fileName} (${out.w}×${out.h}) — ${plan.why}${sizeNote}.`);
  return { ok: true, path: res.path };
}

/**
 * DOWNLOAD — the same full-size file, to the computer.
 * @returns {Promise<{ok:boolean}>}
 */
export async function downloadMaskFlow({ info, kindId, ops, notify, onProgress }) {
  const suffix = suffixOf(kindId);
  if (!info?.artUrl) {
    say(notify, `Map Shine: this floor has no map art to size a ${suffix} mask to.`, 'warn');
    return { ok: false };
  }
  const plan = planFor(info, kindId);
  // A fresh download is always PNG — lossless, and every editor opens it.
  const fileName = plan.fileName.replace(/\.[a-z0-9]+$/i, '.png');
  try {
    const out = await render(info, kindId, ops, fileName, onProgress);
    downloadBlob(out.blob, fileName);
    say(
      notify,
      `Map Shine: downloaded ${fileName} (${out.w}×${out.h}). Edit it anywhere, then use Import to put it back.`
    );
    return { ok: true };
  } catch (err) {
    say(notify, `Map Shine: could not draw the ${suffix} mask — ${err?.message || err}.`, 'error');
    return { ok: false };
  }
}

/**
 * IMPORT — a picture from the computer, placed where Map Shine finds it.
 * @param {{info: MaskFileInfo, kindId: string, notify?: Function}} args
 * @returns {Promise<{ok:boolean, path?:string}>}
 */
export async function importMaskFlow({ info, kindId, notify }) {
  const suffix = suffixOf(kindId);
  if (!info?.artUrl) {
    say(notify, `Map Shine: this floor has no map art to put a ${suffix} mask beside.`, 'warn');
    return { ok: false };
  }
  const support = kindFileSupport(kindId, { fileExists: !!info.existingUrl });
  if (!support.canImport) {
    say(notify, `Map Shine: ${suffix} has no file to import.`, 'warn');
    return { ok: false };
  }
  const plan = planFor(info, kindId);
  if (plan.route === 'download' || !canUploadFiles()) {
    const why = plan.route === 'download' ? plan.why : 'you do not have permission to upload files';
    say(
      notify,
      `Map Shine: can't place a file beside this map (${why}). Name it ${plan.fileName} and put it in the map's folder yourself.`,
      'warn'
    );
    return { ok: false };
  }
  const file = await pickLocalImage();
  if (!file) return { ok: false };
  let picked;
  let art;
  try {
    [picked, art] = await Promise.all([readLocalImageSize(file), readArtSize(info.artUrl)]);
  } catch (err) {
    say(notify, `Map Shine: could not read that picture — ${err?.message || err}.`, 'error');
    return { ok: false };
  }
  const check = checkImportSize(picked.w, picked.h, art.w, art.h);
  if (!check.ok) {
    say(notify, `Map Shine: not imported — ${check.why}.`, 'error');
    return { ok: false };
  }
  const target = exportDimensions(art.w, art.h);
  const mime = mimeTypeForFile(plan.fileName);
  let blob = file;
  if (!(check.sameSize && !target.scaled && file.type === mime)) {
    try {
      blob = await resizeImageFile(file, target.w, target.h, mime);
    } catch (err) {
      say(notify, `Map Shine: could not resize that picture to the map — ${err?.message || err}.`, 'error');
      return { ok: false };
    }
  }
  const res = await uploadMaskFile({
    dir: plan.dir,
    fileName: plan.fileName,
    blob,
    createFolder: plan.route === 'world',
  });
  if (!res.ok) {
    say(notify, `Map Shine: importing ${plan.fileName} failed — ${res.reason}.`, 'error');
    return { ok: false };
  }
  if (plan.route === 'world') {
    try {
      await writeSceneMaskFolder(plan.dir);
    } catch (err) {
      say(
        notify,
        `Map Shine: imported, but could not remember the mask folder on the scene (${err?.message || err}).`,
        'warn'
      );
    }
  }
  const resized =
    check.sameSize && !target.scaled ? '' : ` (resized from ${picked.w}×${picked.h} to ${target.w}×${target.h})`;
  say(notify, `Map Shine: imported ${file.name} as ${plan.fileName}${resized} — ${plan.why}.`);
  return { ok: true, path: res.path };
}
