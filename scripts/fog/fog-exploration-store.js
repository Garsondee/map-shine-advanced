import { createLogger } from '../core/log.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from '../foundry/levels-compatibility.js';
import { isLevelsEnabledForScene } from '../foundry/levels-scene-flags.js';

const log = createLogger('FogExplorationStore');

const MODULE_ID = 'map-shine-advanced';
const FLAGS_KEY = 'fogPersistenceV1';

/** When no token actor can be resolved (e.g. GM with no selection), persist under this key. */
export const FOG_USER_SENTINEL_ACTOR_ID = '__mapshine_user__';

function getTokenActorId(tokenLike) {
  const doc = tokenLike?.document;
  return doc?.actorId ?? doc?.actor?.id ?? tokenLike?.actor?.id ?? null;
}

function clampNumber(n, min, max) {
  n = Number(n);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function normalizeBandKey({ bottom, top }) {
  const b = Number(bottom);
  const t = Number(top);
  if (!Number.isFinite(b) || !Number.isFinite(t)) return 'default';
  const lo = Math.min(b, t);
  const hi = Math.max(b, t);
  // Stable keying: avoid excessive precision drift.
  const round = (x) => Math.round(x * 1000) / 1000;
  return `bottom:${round(lo)}|top:${round(hi)}`;
}

export function getActiveElevationBandKey() {
  try {
    if (getLevelsCompatibilityMode() === LEVELS_COMPATIBILITY_MODES.OFF) return 'default';
    const scene = canvas?.scene;
    if (!scene || !isLevelsEnabledForScene(scene)) return 'default';
    const levelCtx = window.MapShine?.activeLevelContext;
    if (!levelCtx) return 'default';
    return normalizeBandKey(levelCtx);
  } catch (_) {
    return 'default';
  }
}

export function getRelevantActorIdsForFog() {
  try {
    const isGM = game?.user?.isGM ?? false;
    const placeables = canvas?.tokens?.placeables || [];
    const byId = new Map(placeables.map((t) => [String(t?.document?.id ?? ''), t]));

    const fromSelection = [];
    const ms = window.MapShine;
    const sel = ms?.interactionManager?.selection;
    if (sel && sel.size) {
      for (const id of sel) {
        const token = byId.get(String(id));
        const actorId = getTokenActorId(token);
        if (actorId) fromSelection.push(String(actorId));
      }
    }
    if (fromSelection.length) return Array.from(new Set(fromSelection));

    const controlled = canvas?.tokens?.controlled || [];
    const fromControlled = [];
    for (const token of controlled) {
      const actorId = getTokenActorId(token);
      if (actorId) fromControlled.push(String(actorId));
    }
    if (fromControlled.length) return Array.from(new Set(fromControlled));

    // Player fallback when nothing is selected/controlled: owned tokens.
    if (!isGM) {
      const owned = [];
      for (const token of placeables) {
        const doc = token?.document;
        if (!(token?.isOwner === true || doc?.isOwner === true)) continue;
        const actorId = getTokenActorId(token);
        if (actorId) owned.push(String(actorId));
      }
      if (owned.length) return Array.from(new Set(owned));
    }
  } catch (_) {
  }

  // GM/no-token fallback: keep exploration user-scoped under sentinel key.
  return [FOG_USER_SENTINEL_ACTOR_ID];
}

export function buildFogStoreContextKey(actorIds, bandKey) {
  const ids = Array.isArray(actorIds) ? actorIds.map(String).filter(Boolean) : [];
  ids.sort();
  return `${String(bandKey || 'default')}::${ids.join(',')}`;
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return await res.blob();
}

async function downscaleDataUrlWebp(dataUrl, maxDim = 1024, quality = 0.8) {
  try {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
    const maxD = clampNumber(maxDim, 64, 8192);

    const blob = await dataUrlToBlob(dataUrl);
    let bmp = null;
    try {
      if (typeof createImageBitmap === 'function') {
        bmp = await createImageBitmap(blob);
      }
    } catch (_) {
      bmp = null;
    }

    // Fallback path: let <img> decode.
    let srcW = bmp?.width ?? 0;
    let srcH = bmp?.height ?? 0;
    if (!srcW || !srcH) {
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = dataUrl;
      });
      srcW = img.naturalWidth || img.width || 0;
      srcH = img.naturalHeight || img.height || 0;
      if (!srcW || !srcH) return null;

      const scale = Math.min(1, maxD / Math.max(srcW, srcH));
      const w = Math.max(1, Math.floor(srcW * scale));
      const h = Math.max(1, Math.floor(srcH * scale));

      const canvasEl = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(w, h)
        : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = canvasEl.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);

      if (typeof canvasEl.convertToBlob === 'function') {
        const outBlob = await canvasEl.convertToBlob({ type: 'image/webp', quality });
        return await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onloadend = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(outBlob);
        });
      }

      return canvasEl.toDataURL('image/webp', quality);
    }

    const scale = Math.min(1, maxD / Math.max(srcW, srcH));
    const w = Math.max(1, Math.floor(srcW * scale));
    const h = Math.max(1, Math.floor(srcH * scale));

    const canvasEl = (typeof OffscreenCanvas !== 'undefined')
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
    const ctx = canvasEl.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);

    try { bmp?.close?.(); } catch (_) {}

    if (typeof canvasEl.convertToBlob === 'function') {
      const outBlob = await canvasEl.convertToBlob({ type: 'image/webp', quality });
      return await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onloadend = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(outBlob);
      });
    }

    return canvasEl.toDataURL('image/webp', quality);
  } catch (e) {
    log.debug('downscaleDataUrlWebp failed', e);
    return null;
  }
}

async function ensureFogExplorationDoc(sceneId, userId) {
  const FogExplorationCls = CONFIG?.FogExploration?.documentClass;
  if (!FogExplorationCls || typeof FogExplorationCls.load !== 'function') return null;

  const existing = await FogExplorationCls.load();
  if (existing?.id) return existing;

  // Create a doc scoped to (scene,user) with no explored payload.
  const tmp = new FogExplorationCls();
  tmp.updateSource({ scene: sceneId, user: userId, explored: '', timestamp: Date.now() });
  return await FogExplorationCls.create(tmp.toJSON(), { loadFog: false });
}

function readStoreRootFromDoc(doc) {
  try {
    const flags = doc?.flags ?? doc?._source?.flags ?? doc?.data?.flags ?? null;
    const root = flags?.[MODULE_ID]?.[FLAGS_KEY] ?? null;
    if (!root || typeof root !== 'object') return null;
    if (root.version !== 1) return null;
    return root;
  } catch (_) {
    return null;
  }
}

function buildEmptyRoot() {
  return {
    version: 1,
    actors: {},
    updatedAt: Date.now()
  };
}

export async function saveExplorationForActors({
  actorIds,
  bandKey,
  exploredDataUrl,
  maxDim = 1024
}) {
  const sceneId = canvas?.scene?.id;
  const userId = game?.user?.id;
  if (!sceneId || !userId) return false;
  const ids = Array.isArray(actorIds) ? actorIds.map(String).filter(Boolean) : [];
  if (!ids.length) return false;
  if (typeof exploredDataUrl !== 'string' || exploredDataUrl.length === 0) return false;

  const doc = await ensureFogExplorationDoc(sceneId, userId);
  if (!doc) return false;

  const key = String(bandKey || 'default');
  const scaled = await downscaleDataUrlWebp(exploredDataUrl, maxDim, 0.8);
  if (!scaled) return false;

  const root = readStoreRootFromDoc(doc) ?? buildEmptyRoot();
  if (!root.actors || typeof root.actors !== 'object') root.actors = {};

  for (const actorId of ids) {
    if (!root.actors[actorId] || typeof root.actors[actorId] !== 'object') {
      root.actors[actorId] = {};
    }
    root.actors[actorId][key] = {
      format: 'image/webp',
      dataUrl: scaled,
      maxDim: clampNumber(maxDim, 64, 8192),
      updatedAt: Date.now()
    };
  }
  root.updatedAt = Date.now();

  await doc.setFlag(MODULE_ID, FLAGS_KEY, root);
  log.debug('[FOG STORE] saved', {
    sceneId,
    userId,
    bandKey: key,
    actorIds: ids,
    dataSize: scaled.length,
  });
  return true;
}

export async function loadUnionExplorationForActors({
  actorIds,
  bandKey
}) {
  const FogExplorationCls = CONFIG?.FogExploration?.documentClass;
  if (!FogExplorationCls || typeof FogExplorationCls.load !== 'function') return null;

  const doc = await FogExplorationCls.load();
  if (!doc) return null;

  const root = readStoreRootFromDoc(doc);
  if (!root) return null;

  const ids = Array.isArray(actorIds) ? actorIds.map(String).filter(Boolean) : [];
  if (!ids.length) return null;

  const key = String(bandKey || 'default');
  const imgs = [];
  for (const actorId of ids) {
    const entry = root.actors?.[actorId]?.[key] ?? null;
    const url = entry?.dataUrl ?? null;
    if (typeof url === 'string' && url.startsWith('data:image/')) imgs.push(url);
  }
  if (!imgs.length) {
    log.debug('[FOG STORE] load miss', { bandKey: key, actorIds: ids });
    return null;
  }

  // Union via Canvas: draw all masks with additive blending (clamped).
  // This is not a perfect per-pixel max for grayscale masks, but works well for
  // binary/near-binary exploration masks.
  const first = imgs[0];
  const firstImg = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = first;
  });
  const w = firstImg.naturalWidth || firstImg.width || 0;
  const h = firstImg.naturalHeight || firstImg.height || 0;
  if (!w || !h) return null;

  const canvasEl = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvasEl.getContext('2d');
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);

  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(firstImg, 0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';

  for (let i = 1; i < imgs.length; i += 1) {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = imgs[i];
    });
    ctx.drawImage(img, 0, 0, w, h);
  }

  if (typeof canvasEl.convertToBlob === 'function') {
    const blob = await canvasEl.convertToBlob({ type: 'image/webp', quality: 0.8 });
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
    log.debug('[FOG STORE] load hit', { bandKey: key, actorIds: ids, layers: imgs.length });
    return dataUrl;
  }
  const dataUrl = canvasEl.toDataURL('image/webp', 0.8);
  log.debug('[FOG STORE] load hit', { bandKey: key, actorIds: ids, layers: imgs.length });
  return dataUrl;
}

