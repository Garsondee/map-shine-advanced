/**
 * @fileoverview Inventory of per-level texture URLs Foundry will load (background,
 * suffixed files like `_Outdoors`, etc.). Uses `scene._configureLevelTextures()`
 * when present, and supplements with `scene.levels.sorted` texture slots so rows
 * can be labeled by level index when the configure payload omits `levelId`.
 */

/**
 * Last `_segment` before a file extension, e.g. `.../map_Outdoors.webp` → `Outdoors`.
 * @param {string} src
 * @returns {string|null}
 */
export function inferSuffixFromSrc(src) {
  const path = String(src || "").split("?")[0];
  const file = path.split("/").pop() || "";
  const base = file.replace(/\.[^.]+$/i, "");
  const i = base.lastIndexOf("_");
  if (i < 0 || i >= base.length - 1) return null;
  return base.slice(i + 1) || null;
}

/**
 * @param {unknown} level
 * @param {number} levelIndex
 * @returns {Array<{ name: string, src: string, levelIndex: number, levelId: string|null, source: string }>}
 */
function _rowsFromLevelDoc(level, levelIndex) {
  /** @type {Array<{ name: string, src: string, levelIndex: number, levelId: string|null, source: string }>} */
  const rows = [];
  if (!level) return rows;
  const levelId =
    (typeof level.id === "string" && level.id) ||
    (typeof level._id === "string" && level._id) ||
    null;

  const push = (name, src, source) => {
    const s = String(src || "").trim();
    const n = String(name || "").trim() || "unnamed";
    if (!s) return;
    rows.push({
      name: n,
      src: s,
      levelIndex,
      levelId,
      source,
    });
  };

  try {
    const bg = level.background?.src;
    if (bg) push("background", bg, "level.background");
  } catch (_) {}

  try {
    const fg = level.foreground?.src;
    if (fg) push("foreground", fg, "level.foreground");
  } catch (_) {}

  try {
    const txs = level.textures;
    if (Array.isArray(txs)) {
      for (let j = 0; j < txs.length; j++) {
        const t = txs[j];
        const name =
          (typeof t?.name === "string" && t.name) ||
          (typeof t?.type === "string" && t.type) ||
          `textures[${j}]`;
        push(name, t?.src, "level.textures[]");
      }
    } else if (txs && typeof txs === "object") {
      for (const [k, v] of Object.entries(txs)) {
        const src =
          v && typeof v === "object" && v != null ? v.src : v;
        push(k, src, "level.textures");
      }
    }
  } catch (_) {}

  return rows;
}

/**
 * Flat list of texture rows for debug / picking.
 *
 * @param {Scene|null|undefined} scene
 * @returns {Array<{
 *   configureIndex: number|null,
 *   name: string|null,
 *   src: string,
 *   inferredSuffix: string|null,
 *   levelIndex: number|null,
 *   levelId: string|null,
 *   source: string,
 * }>}
 */
export function buildLevelTextureInventory(scene) {
  if (!scene) return [];

  /** @type {Map<string, object>} */
  const byKey = new Map();
  const keyOf = (row) =>
    `${row.levelIndex ?? "x"}|${row.levelId ?? "x"}|${row.name ?? ""}|${row.src}`;

  const sorted = Array.isArray(scene.levels?.sorted) ? scene.levels.sorted : [];
  sorted.forEach((level, levelIndex) => {
    for (const r of _rowsFromLevelDoc(level, levelIndex)) {
      const row = {
        configureIndex: null,
        name: r.name,
        src: r.src,
        inferredSuffix: inferSuffixFromSrc(r.src),
        levelIndex: r.levelIndex,
        levelId: r.levelId,
        source: r.source,
      };
      byKey.set(keyOf(row), row);
    }
  });

  try {
    if (typeof scene._configureLevelTextures === "function") {
      const configured = scene._configureLevelTextures();
      if (Array.isArray(configured)) {
        for (let i = 0; i < configured.length; i++) {
          const entry = configured[i];
          if (!entry || typeof entry !== "object") continue;
          const src = String(entry.src || "").trim();
          if (!src) continue;
          const nameRaw = entry.name;
          const name =
            typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : null;
          const levelId =
            (typeof entry.levelId === "string" && entry.levelId) ||
            (typeof entry.level === "string" && entry.level) ||
            (typeof entry.level === "object" && entry.level?.id) ||
            null;
          let levelIndex = null;
          if (levelId && sorted.length) {
            const idx = sorted.findIndex(
              (l) => l?.id === levelId || l?._id === levelId,
            );
            if (idx >= 0) levelIndex = idx;
          }
          const row = {
            configureIndex: i,
            name,
            src,
            inferredSuffix: inferSuffixFromSrc(src),
            levelIndex,
            levelId,
            source: "scene._configureLevelTextures",
          };
          byKey.set(keyOf(row), row);
        }
      }
    }
  } catch (_) {}

  return Array.from(byKey.values());
}

/**
 * @param {ReturnType<typeof buildLevelTextureInventory>} inventory
 * @param {{
 *   suffix?: string,
 *   name?: string,
 *   levelIndex?: number,
 *   configureIndex?: number,
 * }} q
 * @returns {{ row: object|null, reason: string }}
 */
export function pickTextureRow(inventory, q) {
  if (!inventory?.length) {
    return { row: null, reason: "empty-inventory" };
  }
  if (typeof q.configureIndex === "number" && Number.isFinite(q.configureIndex)) {
    const row = inventory.find(
      (r) => r.configureIndex === q.configureIndex,
    );
    if (row) return { row, reason: "configure-index" };
    return { row: null, reason: "configure-index-not-found" };
  }

  const suffixNeedle = q.suffix != null ? String(q.suffix).trim().toLowerCase() : "";
  const nameNeedle = q.name != null ? String(q.name).trim().toLowerCase() : "";
  const wantLevel =
    typeof q.levelIndex === "number" && Number.isFinite(q.levelIndex)
      ? q.levelIndex
      : null;

  /** @param {object} r */
  const matches = (r) => {
    if (wantLevel !== null && r.levelIndex !== wantLevel) return false;
    if (nameNeedle) {
      const n = (r.name && String(r.name).toLowerCase()) || "";
      if (n.includes(nameNeedle) || nameNeedle === n) return true;
    }
    if (suffixNeedle) {
      const s = (r.inferredSuffix && String(r.inferredSuffix).toLowerCase()) || "";
      if (s === suffixNeedle || s.includes(suffixNeedle)) return true;
      const srcL = String(r.src).toLowerCase();
      if (
        srcL.includes(`_${suffixNeedle}.`) ||
        srcL.includes(`_${suffixNeedle}?`) ||
        srcL.endsWith(`_${suffixNeedle}`)
      ) {
        return true;
      }
    }
    return !!(suffixNeedle || nameNeedle);
  };

  const candidates = inventory.filter(matches);
  if (!candidates.length) {
    return { row: null, reason: "no-match" };
  }
  candidates.sort((a, b) => {
    const ai = a.configureIndex;
    const bi = b.configureIndex;
    if (ai != null && bi != null) return ai - bi;
    if (ai != null) return -1;
    if (bi != null) return 1;
    return 0;
  });
  return { row: candidates[0], reason: "matched" };
}
