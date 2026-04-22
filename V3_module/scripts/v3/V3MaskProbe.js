/**
 * @fileoverview Utilities for resolving level background base paths and
 * optional suffixed mask files. Prefers Foundry `FilePicker.browse` listings;
 * HTTP `HEAD` exists only as a fallback when FilePicker is unavailable.
 */

import { buildLevelTextureInventory } from "./V3LevelTextureCatalog.js";
import { listVisibleLevelBackgroundSrcs } from "./V3FloorSourceResolver.js";
import { EFFECT_MASKS, listMaskIds } from "./V3EffectMaskRegistry.js";
import { browseDirectoryFiles } from "./V3FoundryFilePicker.js";

const FORMATS = ["webp", "png", "jpg", "jpeg"];

/**
 * @param {string} src
 * @returns {string}
 */
export function stripQuery(src) {
  return String(src || "").split("?")[0];
}

/**
 * Remove last extension (any of FORMATS).
 * @param {string} path
 * @returns {string}
 */
export function stripExtension(path) {
  const p = stripQuery(path);
  return p.replace(/\.(webp|png|jpe?g|jpeg|avif)$/i, "");
}

/**
 * Best-effort background base path for a level index (no extension), for mask probing.
 *
 * @param {Scene|null|undefined} scene
 * @param {number} levelIndex
 * @returns {string|null}
 */
export function getBackgroundBasePathForLevel(scene, levelIndex) {
  if (!scene) return null;
  const inv = buildLevelTextureInventory(scene);
  const idx = Number(levelIndex);
  if (!Number.isFinite(idx)) return null;

  const rows = inv.filter(
    (r) =>
      r.levelIndex === idx &&
      r.src &&
      String(r.name || "").toLowerCase() === "background",
  );
  const row = rows[0];
  if (row?.src) return stripExtension(row.src);

  try {
    const vis = listVisibleLevelBackgroundSrcs(scene);
    if (idx >= 0 && idx < vis.length && vis[idx]) {
      return stripExtension(vis[idx]);
    }
  } catch (_) {}

  const anyForLevel = inv.find((r) => r.levelIndex === idx && r.src);
  if (anyForLevel?.src) return stripExtension(anyForLevel.src);

  if (idx === 0) {
    try {
      const raw = scene.background?.src ?? scene.img;
      if (typeof raw === "string" && raw.trim()) return stripExtension(raw.trim());
    } catch (_) {}
  }
  return null;
}

/**
 * @returns {number} count of playable level backgrounds (from inventory + fallback)
 */
export function countLevelsForProbe(scene) {
  if (!scene) return 0;
  const inv = buildLevelTextureInventory(scene);
  let max = -1;
  for (const r of inv) {
    if (typeof r.levelIndex === "number" && Number.isFinite(r.levelIndex)) {
      max = Math.max(max, r.levelIndex);
    }
  }
  if (max >= 0) return max + 1;
  return scene.background?.src || scene.img ? 1 : 0;
}

/**
 * Turn a Foundry media path into something `THREE.TextureLoader` can fetch in
 * the browser (handles `FilePicker.browse` relative paths and site-root paths).
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
export function normalizeMediaUrlForThree(url) {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  if (!u) return null;
  if (/^(https?:|blob:|data:)/i.test(u)) return u;
  if (u.startsWith("//")) {
    try {
      return `${globalThis.location?.protocol || "https:"}${u}`;
    } catch (_) {
      return u;
    }
  }
  if (u.startsWith("/")) {
    try {
      const o = globalThis.location?.origin ?? "";
      return o ? `${o}${u}` : u;
    } catch (_) {
      return u;
    }
  }
  try {
    const o = globalThis.location?.origin ?? "";
    return o ? `${o}/${u.replace(/^\/+/, "")}` : u;
  } catch (_) {
    return u;
  }
}

/**
 * Conventional on-disk URL beside the level background when the manifest has
 * no entry: `{stripExt(bg)}{catalogSuffix}{ext(bg)}` (used only on explicit load).
 *
 * @param {string|null|undefined} basePath
 * @param {string|null|undefined} catalogSuffix e.g. `_Outdoors`
 * @param {string|null|undefined} backgroundUrl
 * @returns {string|null}
 */
export function guessAuthoredMaskUrlFromBackground(basePath, catalogSuffix, backgroundUrl) {
  if (!basePath || !catalogSuffix) return null;
  const suf = String(catalogSuffix).trim();
  if (!suf) return null;
  const bg = stripQuery(String(backgroundUrl || ""));
  const m = /\.(webp|png|jpe?g|jpeg|avif)$/i.exec(bg);
  const ext = m ? m[0] : ".webp";
  return `${basePath}${suf}${ext}`;
}

/**
 * Floors that participate in **stacked** level backgrounds (bottom-to-top),
 * for mask discovery and sky-reach occlusion. Uses the **maximum** of:
 * {@link countLevelsForProbe} (inventory rows with `levelIndex`) and the
 * length of {@link listVisibleLevelBackgroundSrcs} (Foundry’s visible
 * background list). This avoids treating a scene as single-floor when
 * `_configureLevelTextures()` omits `levelIndex` on every row — a case where
 * the sandwich still loads two albedos but `countLevelsForProbe` returns 1.
 *
 * @param {Scene|null|undefined} scene
 * @returns {number}
 */
export function countStackedBackgroundLevels(scene) {
  let bg = 0;
  try {
    bg = listVisibleLevelBackgroundSrcs(scene).length;
  } catch (_) {}
  const probe = countLevelsForProbe(scene);
  return Math.max(1, bg, probe);
}

/**
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function headOk(url) {
  try {
    const r = await fetch(url, { method: "HEAD", cache: "force-cache" });
    return r.ok;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} basePath
 * @returns {{ dir: string|null, baseLeaf: string|null }}
 */
function _dirAndBaseLeafFromBasePath(basePath) {
  const clean = stripQuery(String(basePath || "").trim());
  if (!clean) return { dir: null, baseLeaf: null };
  const idx = clean.lastIndexOf("/");
  if (idx < 0) return { dir: null, baseLeaf: clean };
  return { dir: clean.slice(0, idx), baseLeaf: clean.slice(idx + 1) };
}

/**
 * @param {string[]} files
 * @param {string} baseLeaf
 * @param {string} suffix
 * @param {string} dir
 * @param {string} basePath
 * @returns {string|null}
 */
/**
 * When `files` is the leaf list from `FilePicker.browse` for the background’s
 * folder, returns a fetchable URL for `{baseLeaf}{catalogSuffix}.{ext}` or null.
 *
 * @param {string[]|null|undefined} files
 * @param {string} basePathNoExt background path without extension
 * @param {string} catalogSuffix e.g. `_Water`, `_Outdoors`
 * @returns {string|null}
 */
export function resolveListedSiblingMaskUrl(files, basePathNoExt, catalogSuffix) {
  const base = stripQuery(String(basePathNoExt || "").trim());
  const suf = String(catalogSuffix || "").trim();
  if (!base || !suf || !files?.length) return null;
  const { dir, baseLeaf } = _dirAndBaseLeafFromBasePath(base);
  if (!dir || !baseLeaf) return null;
  return _maskUrlFromDirListing(files, baseLeaf, suf, dir, base);
}

function _maskUrlFromDirListing(files, baseLeaf, suffix, dir, basePath) {
  if (!files?.length || !baseLeaf || !suffix || !dir) return null;
  const bl = String(baseLeaf);
  const suf = String(suffix);
  for (const ext of FORMATS) {
    const wantLeaf = `${bl}${suf}.${ext}`;
    for (const f of files) {
      const leaf = String(f || "").split("/").pop();
      if (!leaf) continue;
      if (leaf.toLowerCase() !== wantLeaf.toLowerCase()) continue;
      if (/^https?:\/\//i.test(basePath)) {
        try {
          const base = dir.endsWith("/") ? dir : `${dir}/`;
          return new URL(leaf, base).href;
        } catch (_) {
          return `${dir}/${leaf}`;
        }
      }
      if (f.includes("/")) return normalizeMediaUrlForThree(f);
      return normalizeMediaUrlForThree(`${dir}/${leaf}`);
    }
  }
  return null;
}

/**
 * @param {string} basePath
 * @returns {Promise<string[]|null>}
 */
async function _listSiblingFilesViaFilePicker(basePath) {
  const { dir } = _dirAndBaseLeafFromBasePath(basePath);
  if (!dir) return null;
  const listing = await browseDirectoryFiles(dir);
  return listing?.files ?? null;
}

/**
 * First existing URL for `basePath + suffix + .ext`.
 *
 * **Diagnostic only.** Prefers `FilePicker.browse` (same listing as the asset
 * inventory) so optional masks are not probed with HTTP `HEAD`. Falls back to
 * `HEAD` only when FilePicker is unavailable (non-Foundry hosts).
 *
 * @param {string} basePath — no extension
 * @param {string} suffix — e.g. `_Specular`
 * @returns {Promise<string|null>}
 */
export async function probeMaskUrl(basePath, suffix) {
  const base = String(basePath || "").trim();
  if (!base) return null;
  const suf = String(suffix || "").trim();
  if (!suf) return null;

  const { dir, baseLeaf } = _dirAndBaseLeafFromBasePath(base);
  const listed = await _listSiblingFilesViaFilePicker(base);
  if (listed) {
    const hit = _maskUrlFromDirListing(listed, baseLeaf, suf, dir, base);
    if (hit) return stripQuery(hit);
    return null;
  }

  for (const ext of FORMATS) {
    const candidate = `${base}${suf}.${ext}`;
    const normalized = candidate.includes(" ") ? candidate.replace(/ /g, "%20") : candidate;
    if (await headOk(normalized)) return candidate;
  }
  return null;
}

/**
 * @typedef {{
 *   maskId: string,
 *   suffix: string,
 *   url: string|null,
 *   found: boolean,
 *   description?: string
 * }} MaskProbeRow
 */

/**
 * Probe every registered mask id for one level’s background base path.
 *
 * @param {Scene|null|undefined} scene
 * @param {number} levelIndex
 * @param {{ concurrency?: number }} [opts]
 * @returns {Promise<{ basePath: string|null, levelIndex: number, rows: MaskProbeRow[] }>}
 */
export async function probeAllMasksForLevel(scene, levelIndex, opts = {}) {
  const concurrency = Math.max(1, Math.min(8, opts.concurrency ?? 6));
  const basePath = getBackgroundBasePathForLevel(scene, levelIndex);
  const ids = listMaskIds();

  const chunk = async (list, limit, fn) => {
    const out = [];
    for (let i = 0; i < list.length; i += limit) {
      const slice = list.slice(i, i + limit);
      const part = await Promise.all(slice.map(fn));
      out.push(...part);
    }
    return out;
  };

  const rows = await chunk(ids, concurrency, async (id) => {
    const def = EFFECT_MASKS[id];
    if (!def?.suffix) return null;
    const url = basePath ? await probeMaskUrl(basePath, def.suffix) : null;
    return {
      maskId: id,
      suffix: def.suffix,
      url,
      found: !!url,
      description: def.description,
    };
  });

  const filtered = rows.filter(Boolean);
  filtered.sort((a, b) => a.maskId.localeCompare(b.maskId));

  return {
    basePath,
    levelIndex: Number(levelIndex) || 0,
    rows: filtered,
  };
}
