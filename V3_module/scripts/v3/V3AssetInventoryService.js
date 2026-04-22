/**
 * @fileoverview **V3 Asset Inventory Service** — manifest-first resolver for
 * per-level background and authored mask URLs.
 *
 * Goals:
 *   1. Eliminate speculative per-suffix `HEAD` probes on every compose/level
 *      change. The hub resolves authored mask URLs from a manifest instead.
 *   2. Keep the runtime hot path deterministic and permission-agnostic: both
 *      GMs and players consume the same merged manifest.
 *   3. Centralize asset discovery (`FilePicker.browse`) into a single GM-gated
 *      rescan action. Non-GM clients read the persisted manifest written by a
 *      GM; if none exists, they fall back to scene-configured textures only.
 *   4. Make warning/diagnostic noise deduped per `(sceneId, key)` so the
 *      console doesn't fill with repeated 404 messages.
 *
 * Data model:
 *
 * ```text
 * SceneManifest {
 *   sceneId, version, updatedAt,
 *   levels: Record<floorIndex, LevelManifest>,
 *   scan: { state, dirsScanned, lastScannedAt, attemptedAt, durationMs }
 * }
 * LevelManifest {
 *   floorIndex, basePath, baseName,
 *   backgroundUrl,
 *   masks: Record<maskId, { maskId, url, source, suffix }>,
 *   configuredTextures: [{ name, src, suffix }],
 *   otherFiles: string[],
 *   listedFrom: string|null,     // raw browse target that yielded this dir
 *   listAttempted: boolean,
 *   listOk: boolean,
 * }
 * ```
 *
 * The service never loads Three.js textures itself — it only reports URLs.
 *
 * @module v3/V3AssetInventoryService
 */

import {
  V3_MASK_CATALOG,
  listAuthoredMaskIds,
} from "./V3MaskCatalog.js";
import {
  buildLevelTextureInventory,
  inferSuffixFromSrc,
} from "./V3LevelTextureCatalog.js";
import {
  getBackgroundBasePathForLevel,
  stripExtension,
  stripQuery,
} from "./V3MaskProbe.js";
import { listVisibleLevelBackgroundSrcs } from "./V3FloorSourceResolver.js";
import { browseDirectoryFiles } from "./V3FoundryFilePicker.js";

/** Schema revision for persisted scene manifests. Bump when the shape changes. */
export const V3_ASSET_MANIFEST_VERSION = 1;

/** Foundry module id (must match `module.js`). Persisted in scene flags. */
const MODULE_ID = "map-shine-advanced";
/** Flag key, namespaced under `scene.flags['map-shine-advanced']`. */
const FLAG_KEY = "assetManifest";

const SCAN_STATE = Object.freeze({
  NONE: "none",
  CONFIGURED_ONLY: "configured-only",
  CACHED: "cached",
  SCANNED: "scanned",
  FAILED: "failed",
});

const IMAGE_EXT_REGEX = /\.(webp|png|jpe?g|jpeg|avif)$/i;

/**
 * @typedef {Object} ManifestMaskEntry
 * @property {string} maskId
 * @property {string} url
 * @property {string} suffix
 * @property {'configured'|'scanned'|'cached'|'hint'} source
 */

/**
 * @typedef {Object} ManifestConfiguredTexture
 * @property {string|null} name
 * @property {string} src
 * @property {string|null} suffix
 */

/**
 * @typedef {Object} LevelManifest
 * @property {number} floorIndex
 * @property {string|null} basePath
 * @property {string|null} baseName
 * @property {string|null} backgroundUrl
 * @property {Record<string, ManifestMaskEntry>} masks
 * @property {ManifestConfiguredTexture[]} configuredTextures
 * @property {string[]} otherFiles
 * @property {string|null} listedFrom
 * @property {boolean} listAttempted
 * @property {boolean} listOk
 */

/**
 * @typedef {Object} SceneManifest
 * @property {string} sceneId
 * @property {number} version
 * @property {number} updatedAt
 * @property {Record<number, LevelManifest>} levels
 * @property {{
 *   state: 'none'|'configured-only'|'cached'|'scanned'|'failed',
 *   dirsScanned: string[],
 *   lastScannedAt: number|null,
 *   attemptedAt: number|null,
 *   durationMs: number|null,
 *   error?: string,
 * }} scan
 */

/**
 * @typedef {Object} InventoryDiagnostics
 * @property {number} manifestBuilds
 * @property {number} manifestCacheHits
 * @property {number} scanAttempts
 * @property {number} scanSuccess
 * @property {number} scanFailures
 * @property {number} browseCalls
 * @property {number} browseFailures
 * @property {number} resolveHits
 * @property {number} resolveMisses
 * @property {number} persistedReads
 * @property {number} persistedWrites
 */

/**
 * Single shared service instance per host. Hub + Tweakpane both resolve
 * against the same cached manifests, keyed by `scene.id`.
 */
export class V3AssetInventoryService {
  /**
   * @param {{
   *   logger?: { log: Function, warn: Function },
   *   moduleId?: string,
   * }} [opts]
   */
  constructor({ logger, moduleId } = {}) {
    this.log = logger?.log ?? (() => {});
    this.warn = logger?.warn ?? (() => {});
    this._moduleId = moduleId || MODULE_ID;

    /** @type {Map<string, { manifest: SceneManifest, bgSig: string }>} */
    this._cache = new Map();

    /** @type {Set<string>} — dedup key (`scene|key`). */
    this._warnedKeys = new Set();

    /** @type {InventoryDiagnostics} */
    this._diag = {
      manifestBuilds: 0,
      manifestCacheHits: 0,
      scanAttempts: 0,
      scanSuccess: 0,
      scanFailures: 0,
      browseCalls: 0,
      browseFailures: 0,
      resolveHits: 0,
      resolveMisses: 0,
      persistedReads: 0,
      persistedWrites: 0,
    };
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  /**
   * Resolve a URL for one `(floorIndex, maskId)` from the manifest. Returns
   * `null` when the asset is not present (configured or discovered) — the
   * caller should **not** attempt a speculative load.
   *
   * @param {SceneManifest|null|undefined} manifest
   * @param {number} floorIndex
   * @param {string} maskId
   * @returns {string|null}
   */
  resolveAuthoredUrl(manifest, floorIndex, maskId) {
    if (!manifest) return null;
    const level = manifest.levels?.[floorIndex];
    const entry = level?.masks?.[maskId];
    if (entry?.url) {
      this._diag.resolveHits++;
      return entry.url;
    }
    this._diag.resolveMisses++;
    return null;
  }

  /**
   * Build (or reuse a cached) manifest for `scene`, merging configured
   * textures with any persisted scene-flag manifest. Never performs network
   * I/O — call {@link scan} to refresh from disk listings.
   *
   * @param {Scene|null|undefined} scene
   * @returns {SceneManifest|null}
   */
  buildForScene(scene) {
    if (!scene) return null;
    const sceneId = this._sceneId(scene);
    const bgSig = this._backgroundSignature(scene);
    const persistedUpdatedAt = this._readPersistedUpdatedAt(scene);
    const cached = this._cache.get(sceneId);
    if (
      cached &&
      cached.bgSig === bgSig &&
      cached.persistedUpdatedAt === persistedUpdatedAt
    ) {
      this._diag.manifestCacheHits++;
      return cached.manifest;
    }

    const manifest = this._constructManifest(scene);
    this._cache.set(sceneId, { manifest, bgSig, persistedUpdatedAt });
    this._diag.manifestBuilds++;
    return manifest;
  }

  /**
   * @param {Scene} scene
   * @returns {number|null}
   */
  _readPersistedUpdatedAt(scene) {
    try {
      const flags = scene?.flags?.[this._moduleId];
      const raw = flags?.[FLAG_KEY];
      if (!raw || typeof raw !== "object") return null;
      return Number(raw.updatedAt) || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Return the cached manifest for a scene (if any) without constructing one.
   * Used by the Tweakpane pane to avoid rebuild churn on every poll.
   *
   * @param {string} sceneId
   * @returns {SceneManifest|null}
   */
  getCachedManifest(sceneId) {
    const entry = this._cache.get(sceneId);
    return entry?.manifest ?? null;
  }

  /**
   * GM-only rescan. Uses `FilePicker.browse` against every level's
   * background directory, infers suffix → mask-id matches from filenames,
   * merges results on top of the configured manifest, and (when `write` is
   * truthy and the user has GM permissions) persists the result to
   * `scene.flags[moduleId].assetManifest` so non-GM clients benefit.
   *
   * Non-GM callers can still `scan` in read-only mode — the resulting
   * manifest is cached in memory for the current session.
   *
   * @param {Scene|null|undefined} scene
   * @param {{ write?: boolean }} [opts]
   * @returns {Promise<SceneManifest|null>}
   */
  async scan(scene, opts = {}) {
    if (!scene) return null;
    const sceneId = this._sceneId(scene);
    this._diag.scanAttempts++;
    const startedAt = Date.now();

    const manifest = this._constructManifest(scene);
    manifest.scan.attemptedAt = startedAt;

    const scannedDirs = new Set();
    try {
      const floorIndices = Object.keys(manifest.levels)
        .map((k) => Number(k))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b);

      for (const floorIndex of floorIndices) {
        const level = manifest.levels[floorIndex];
        if (!level?.basePath) continue;
        const dir = this._dirFromBasePath(level.basePath);
        if (!dir) continue;
        if (scannedDirs.has(dir)) continue;
        scannedDirs.add(dir);

        const listing = await this._browseDir(dir);
        if (!listing?.files) continue;

        // Apply listing results to every level whose basePath lives in this
        // directory (keeps one browse per dir even when floors share it).
        for (const idx of floorIndices) {
          const lvl = manifest.levels[idx];
          if (!lvl?.basePath) continue;
          if (this._dirFromBasePath(lvl.basePath) !== dir) continue;
          this._applyListingToLevel(lvl, listing, dir);
        }
      }

      manifest.scan.state = scannedDirs.size > 0
        ? SCAN_STATE.SCANNED
        : manifest.scan.state;
      manifest.scan.dirsScanned = Array.from(scannedDirs);
      manifest.scan.lastScannedAt = Date.now();
      manifest.scan.durationMs = manifest.scan.lastScannedAt - startedAt;

      if (opts.write && this._isGM()) {
        try {
          await this._persistManifest(scene, manifest);
          this._diag.persistedWrites++;
        } catch (err) {
          this._warnOnce(sceneId, "persist-failed", () =>
            this.warn("[V3AssetInventory] persist failed", err),
          );
        }
      }

      this._diag.scanSuccess++;
    } catch (err) {
      manifest.scan.state = SCAN_STATE.FAILED;
      manifest.scan.error = String(err?.message ?? err);
      this._diag.scanFailures++;
      this._warnOnce(sceneId, "scan-failed", () =>
        this.warn("[V3AssetInventory] scan failed", err),
      );
    }

    const bgSig = this._backgroundSignature(scene);
    const persistedUpdatedAt = this._readPersistedUpdatedAt(scene);
    this._cache.set(sceneId, { manifest, bgSig, persistedUpdatedAt });
    return manifest;
  }

  /**
   * Invalidate the in-memory cache for `scene` (e.g. after a manual rescan
   * on another client pushes new flag data). The next `buildForScene` call
   * will rebuild from scratch.
   *
   * @param {Scene|null|undefined} scene
   */
  invalidateScene(scene) {
    if (!scene) return;
    this._cache.delete(this._sceneId(scene));
  }

  /** Drop all per-scene caches (call on `canvasTearDown` / unmount). */
  clearAll() {
    this._cache.clear();
    this._warnedKeys.clear();
  }

  /**
   * Report a one-shot warning for a missing authored mask URL. Emits once
   * per `(sceneId, floorIndex, maskId)` so hot paths stay quiet.
   *
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @param {string} maskId
   * @param {string} [reason]
   */
  noteMissing(scene, floorIndex, maskId, reason = "not-in-manifest") {
    if (!scene) return;
    const sceneId = this._sceneId(scene);
    this._warnOnce(sceneId, `missing:${floorIndex}:${maskId}`, () => {
      this.log(
        `[V3AssetInventory] ${sceneId}: no URL for ${maskId} on floor ${floorIndex} (${reason})`,
      );
    });
  }

  /**
   * Diagnostics snapshot (counters + cache size). Safe to serialize.
   *
   * @returns {{ counters: InventoryDiagnostics, cachedSceneIds: string[] }}
   */
  diagnostics() {
    return {
      counters: { ...this._diag },
      cachedSceneIds: Array.from(this._cache.keys()),
    };
  }

  // ------------------------------------------------------------------
  // Manifest construction
  // ------------------------------------------------------------------

  /**
   * @param {Scene} scene
   * @returns {SceneManifest}
   */
  _constructManifest(scene) {
    const sceneId = this._sceneId(scene);
    const now = Date.now();

    /** @type {SceneManifest} */
    const manifest = {
      sceneId,
      version: V3_ASSET_MANIFEST_VERSION,
      updatedAt: now,
      levels: {},
      scan: {
        state: SCAN_STATE.CONFIGURED_ONLY,
        dirsScanned: [],
        lastScannedAt: null,
        attemptedAt: null,
        durationMs: null,
      },
    };

    const bgList = listVisibleLevelBackgroundSrcs(scene);
    const inv = buildLevelTextureInventory(scene);
    const floorCount = Math.max(1, bgList.length, this._maxLevelIndex(inv) + 1);

    for (let i = 0; i < floorCount; i++) {
      const basePath = getBackgroundBasePathForLevel(scene, i);
      const baseName = basePath ? this._tailName(basePath) : null;
      const backgroundUrl = bgList[i]
        ?? inv.find(
          (r) => r.levelIndex === i && String(r.name || "").toLowerCase() === "background",
        )?.src
        ?? null;

      /** @type {LevelManifest} */
      const level = {
        floorIndex: i,
        basePath,
        baseName,
        backgroundUrl,
        masks: {},
        configuredTextures: [],
        otherFiles: [],
        listedFrom: null,
        listAttempted: false,
        listOk: false,
      };

      for (const row of inv) {
        if (row.levelIndex !== i && !(i === 0 && row.levelIndex == null)) continue;
        const src = row.src;
        if (!src) continue;
        const suffix = row.inferredSuffix ?? inferSuffixFromSrc(src);
        level.configuredTextures.push({
          name: row.name ?? null,
          src,
          suffix: suffix ?? null,
        });

        const maskId = this._suffixToMaskId(suffix);
        if (maskId && !level.masks[maskId]) {
          level.masks[maskId] = {
            maskId,
            url: src,
            suffix: suffix ?? "",
            source: "configured",
          };
        }
      }

      manifest.levels[i] = level;
    }

    // Overlay persisted manifest (from scene flag) on top of configured entries.
    const persisted = this._readPersistedManifest(scene);
    if (persisted) {
      manifest.scan.state = SCAN_STATE.CACHED;
      if (persisted.scan?.lastScannedAt) {
        manifest.scan.lastScannedAt = persisted.scan.lastScannedAt;
        manifest.scan.dirsScanned = Array.from(persisted.scan.dirsScanned ?? []);
      }
      for (const [idxStr, persistedLevel] of Object.entries(persisted.levels ?? {})) {
        const idx = Number(idxStr);
        const level = manifest.levels[idx];
        if (!level) continue;
        for (const [maskId, entry] of Object.entries(persistedLevel.masks ?? {})) {
          if (!entry?.url || level.masks[maskId]) continue;
          level.masks[maskId] = {
            maskId,
            url: entry.url,
            suffix: entry.suffix ?? "",
            source: "cached",
          };
        }
        if (Array.isArray(persistedLevel.otherFiles) && !level.otherFiles.length) {
          level.otherFiles = [...persistedLevel.otherFiles];
        }
        if (persistedLevel.listOk) level.listOk = true;
        if (persistedLevel.listAttempted) level.listAttempted = true;
        if (persistedLevel.listedFrom) level.listedFrom = persistedLevel.listedFrom;
      }
    }

    return manifest;
  }

  /**
   * @param {ReturnType<typeof buildLevelTextureInventory>} inv
   * @returns {number}
   */
  _maxLevelIndex(inv) {
    let max = -1;
    for (const row of inv) {
      if (typeof row.levelIndex === "number" && Number.isFinite(row.levelIndex)) {
        if (row.levelIndex > max) max = row.levelIndex;
      }
    }
    return max;
  }

  /**
   * Convert a detected file suffix (e.g. `Outdoors`, `_Water`) into a catalog
   * mask id. Matches against {@link V3_MASK_CATALOG} entry suffixes
   * case-insensitively.
   *
   * @param {string|null|undefined} suffix
   * @returns {string|null}
   */
  _suffixToMaskId(suffix) {
    if (!suffix) return null;
    const needle = `_${String(suffix).replace(/^_+/, "")}`.toLowerCase();
    for (const id of listAuthoredMaskIds()) {
      const entry = V3_MASK_CATALOG[id];
      if (!entry?.suffix) continue;
      if (String(entry.suffix).toLowerCase() === needle) return id;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Discovery (FilePicker.browse)
  // ------------------------------------------------------------------

  /**
   * @param {string} dir  Directory URL without trailing slash.
   * @returns {Promise<{ files: string[], target: string, source: string }|null>}
   */
  async _browseDir(dir) {
    this._diag.browseCalls++;
    const listing = await browseDirectoryFiles(dir);
    if (listing) return listing;
    this._diag.browseFailures++;
    return null;
  }

  /**
   * Apply a browse listing to one level's manifest entry, inferring mask
   * suffixes from each file name and bucketing non-matches into `otherFiles`.
   *
   * @param {LevelManifest} level
   * @param {{ files: string[], target: string, source: string }} listing
   * @param {string} dir
   */
  _applyListingToLevel(level, listing, dir) {
    level.listAttempted = true;
    level.listOk = true;
    level.listedFrom = `${listing.source}:${listing.target}`;
    const baseName = level.baseName ? level.baseName.toLowerCase() : null;

    const others = new Set(level.otherFiles);
    for (const file of listing.files ?? []) {
      if (!IMAGE_EXT_REGEX.test(file)) continue;
      const leaf = this._tailName(file);
      const withoutExt = stripExtension(leaf);

      if (!baseName) {
        others.add(file);
        continue;
      }
      const lower = withoutExt.toLowerCase();
      if (lower === baseName) continue; // the background itself
      if (!lower.startsWith(baseName + "_")) {
        others.add(file);
        continue;
      }
      const suffix = `_${withoutExt.slice(baseName.length + 1)}`;
      const maskId = this._suffixToMaskId(suffix);
      if (!maskId) {
        others.add(file);
        continue;
      }
      if (!level.masks[maskId] || level.masks[maskId].source === "cached") {
        level.masks[maskId] = {
          maskId,
          url: file,
          suffix,
          source: "scanned",
        };
      }
    }
    level.otherFiles = Array.from(others);
  }

  /**
   * Split a base path (no extension) into its enclosing directory url.
   *
   * @param {string} basePath
   * @returns {string|null}
   */
  _dirFromBasePath(basePath) {
    if (!basePath) return null;
    const clean = stripQuery(basePath);
    const idx = clean.lastIndexOf("/");
    if (idx < 0) return null;
    return clean.slice(0, idx);
  }

  /**
   * Last segment of a URL/path, minus query string.
   *
   * @param {string} p
   * @returns {string|null}
   */
  _tailName(p) {
    if (!p) return null;
    const clean = stripQuery(p);
    const idx = clean.lastIndexOf("/");
    return idx < 0 ? clean : clean.slice(idx + 1);
  }

  // ------------------------------------------------------------------
  // Persistence (scene flag)
  // ------------------------------------------------------------------

  /** @returns {boolean} */
  _isGM() {
    try {
      return !!globalThis.game?.user?.isGM;
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {Scene} scene
   * @returns {SceneManifest|null}
   */
  _readPersistedManifest(scene) {
    try {
      const flags = scene?.flags?.[this._moduleId];
      const raw = flags?.[FLAG_KEY];
      if (!raw) return null;
      if (typeof raw !== "object") return null;
      if (raw.version !== V3_ASSET_MANIFEST_VERSION) return null;
      this._diag.persistedReads++;
      return raw;
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {Scene} scene
   * @param {SceneManifest} manifest
   */
  async _persistManifest(scene, manifest) {
    if (!scene || typeof scene.setFlag !== "function") return;
    const slim = this._serializeManifest(manifest);
    await scene.setFlag(this._moduleId, FLAG_KEY, slim);
  }

  /**
   * @param {SceneManifest} manifest
   * @returns {object}
   */
  _serializeManifest(manifest) {
    const levels = {};
    for (const [idx, level] of Object.entries(manifest.levels)) {
      levels[idx] = {
        floorIndex: level.floorIndex,
        basePath: level.basePath,
        baseName: level.baseName,
        backgroundUrl: level.backgroundUrl,
        masks: level.masks,
        otherFiles: level.otherFiles,
        listedFrom: level.listedFrom,
        listAttempted: level.listAttempted,
        listOk: level.listOk,
      };
    }
    return {
      sceneId: manifest.sceneId,
      version: manifest.version,
      updatedAt: manifest.updatedAt,
      levels,
      scan: { ...manifest.scan },
    };
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  /**
   * Stable scene identifier. Falls back to `name` when `id` is missing so
   * manifests still key cleanly in dev mode.
   *
   * @param {Scene} scene
   * @returns {string}
   */
  _sceneId(scene) {
    return String(scene?.id || scene?._id || scene?.name || "scene");
  }

  /**
   * Order-sensitive fingerprint of background URLs — used to invalidate the
   * cached manifest when a scene reconfigures its layers.
   *
   * @param {Scene} scene
   * @returns {string}
   */
  _backgroundSignature(scene) {
    try {
      return listVisibleLevelBackgroundSrcs(scene).join("\x1e");
    } catch (_) {
      return "";
    }
  }

  /**
   * @param {string} sceneId
   * @param {string} key
   * @param {() => void} fn
   */
  _warnOnce(sceneId, key, fn) {
    const k = `${sceneId}|${key}`;
    if (this._warnedKeys.has(k)) return;
    this._warnedKeys.add(k);
    try { fn(); } catch (_) {}
  }
}

/**
 * Factory convenience; matches the style of other V3 modules.
 *
 * @param {ConstructorParameters<typeof V3AssetInventoryService>[0]} [opts]
 * @returns {V3AssetInventoryService}
 */
export function createAssetInventoryService(opts) {
  return new V3AssetInventoryService(opts);
}
