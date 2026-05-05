/**
 * @fileoverview **V3 Mask Hub — the single runtime authority for masks.**
 *
 * Responsibilities (in order):
 *   1. **Resolve** — for each floor, resolve the background base path and,
 *      from {@link V3_MASK_CATALOG}, the URL of every authored mask file.
 *   2. **Load**  — on demand, load authored textures through a shared
 *      THREE.TextureLoader with one consistent orientation / colorspace.
 *   3. **Derive** — compute derived masks (`floorAlpha`, `skyReach`) and, when
 *      the upper floor is visible, **stack mattes** for every **authored**
 *      suffixed mask (`_Water`, `_Outdoors`, `_Normal`, …): lower + upper
 *      textures mixed by upper albedo alpha (same matte as the sandwich), via
 *      {@link V3DerivedMaskPass}. A floor **without** a file still participates
 *      using an all-zero stand-in so e.g. `_Water` on the ground alone can be
 *      previewed through the upper albedo cutout on the upper view.
 *   4. **Cache + version** — expose a monotonic `cacheVersion` that bumps on
 *      any state transition so binding controllers / inspectors can rebind.
 *   5. **Serve** — return textures by `(floorKey, maskId, purpose)` to any
 *      consumer: effects, binding controller, debug pane.
 *
 * What the hub replaces / absorbs:
 *   - Ad-hoc `probeMaskUrl` calls scattered through the debug pane.
 *   - Per-mask stack composition in UI layers (handled here when the upper
 *     floor is visible and `authoredOnly` is false).
 *   - Duplicated texture loading between sandwich compositor and overlay.
 *
 * What the hub still **does not** own:
 *   - The sandwich compositor's albedo textures (`lowerTex`/`upperTex`) —
 *     those stay on {@link V3ThreeSandwichCompositor} as the authoritative
 *     source for the bottom two floors; additional level backgrounds are
 *     loaded here when needed so `skyReach` can multiply through every upper
 *     floor's albedo alpha.
 *
 * @module v3/V3MaskHub
 */

import * as THREE from "../vendor/three.module.js";
import {
  V3_MASK_CATALOG,
  listAuthoredMaskIds,
  listDerivedMaskIdsInOrder,
  resolveOutdoorsVariant,
  getMaskEntry,
} from "./V3MaskCatalog.js";
import { V3_LEVEL_TEXTURE_FLIP_Y } from "./V3RenderConventions.js";
import { V3DerivedMaskPass } from "./V3DerivedMaskPass.js";
import {
  countStackedBackgroundLevels,
  getBackgroundBasePathForLevel,
  guessAuthoredMaskUrlFromBackground,
  normalizeMediaUrlForThree,
  resolveListedSiblingMaskUrl,
  stripQuery,
} from "./V3MaskProbe.js";
import { browseDirectoryFiles } from "./V3FoundryFilePicker.js";
import { buildLevelTextureInventory } from "./V3LevelTextureCatalog.js";
import {
  listVisibleLevelBackgroundSrcs,
  listVisibleLevelForegroundSrcs,
} from "./V3FloorSourceResolver.js";
import { getViewedLevelIndex } from "./V3ViewedLevel.js";

/**
 * @typedef {'idle'|'probing'|'missing'|'loading'|'ready'|'error'} MaskRecordStatus
 */

/**
 * @typedef {Object} MaskRecord
 * @property {string} maskId
 * @property {string} floorKey
 * @property {number} floorIndex
 * @property {boolean} derived
 * @property {MaskRecordStatus} status
 * @property {string|null} url            Authored masks only; null for derived.
 * @property {THREE.Texture|THREE.CompressedTexture|null} texture
 * @property {number} updatedAtCacheVersion
 * @property {string} [error]
 */

/**
 * @typedef {Object} FloorRecord
 * @property {string} floorKey
 * @property {number} floorIndex
 * @property {string|null} basePath
 * @property {Map<string, MaskRecord>} masks
 */

/**
 * Stable string key for a floor index. External code uses keys, not indices,
 * so we can switch to level ids later without breaking callers.
 *
 * @param {number} index
 * @returns {string}
 */
export function floorKeyForIndex(index) {
  return `floor${Number(index) | 0}`;
}

/**
 * @param {string} floorKey
 * @returns {number}
 */
export function indexForFloorKey(floorKey) {
  const m = /^floor(\d+)$/.exec(String(floorKey));
  return m ? Number(m[1]) : Number.NaN;
}

/**
 * **Single source of truth for mask discovery / loading / composition.**
 *
 * Lifecycle:
 *   - `new V3MaskHub({ logger })` during host construction (cheap, no GL).
 *   - `attach({ renderer, loader, getScene, getCompositor })` on host mount.
 *   - `compose()` whenever scene topology changes.
 *   - `detach()` / `dispose()` on unmount.
 */
export class V3MaskHub {
  /**
   * @param {{ logger?: { log: Function, warn: Function } }} [opts]
   */
  constructor({ logger } = {}) {
    this.log = logger?.log ?? (() => {});
    this.warn = logger?.warn ?? (() => {});

    /** @type {THREE.WebGLRenderer|null} */ this._renderer = null;
    /** @type {THREE.TextureLoader|null} */ this._loader = null;
    /** @type {() => (Scene|null|undefined)|null} */ this._getScene = null;
    /** @type {() => ({lowerTex: THREE.Texture|null, upperTex: THREE.Texture|null, lowerFgTex?: THREE.Texture|null, upperFgTex?: THREE.Texture|null}|null)|null} */
    this._getCompositor = null;
    /** @type {import("./V3AssetInventoryService.js").V3AssetInventoryService|null} */
    this._inventory = null;
    /** @type {import("./V3AssetInventoryService.js").SceneManifest|null} */
    this._manifest = null;

    /**
     * Diagnostics counters for the hub-side of the discovery pipeline.
     * `missingKnown`     — resolved URL missing from manifest on `compose`
     * `loadsAttempted`   — authored records that actually started a loader
     * `loadsSkipped`     — records bypassed because the URL was unchanged
     * `manualProbeCalls` — one-shot `scan()` calls triggered via compose
     *
     * @type {{ missingKnown: number, loadsAttempted: number, loadsSkipped: number, manualProbeCalls: number }}
     */
    this._diag = {
      missingKnown: 0,
      loadsAttempted: 0,
      loadsSkipped: 0,
      manualProbeCalls: 0,
    };

    /** @type {V3DerivedMaskPass|null} */ this._derivedPass = null;
    /** @type {Map<string, THREE.WebGLRenderTarget>} */ this._derivedTargets = new Map();

    /** @type {Map<string, FloorRecord>} */ this._floors = new Map();

    /** Monotonic; bumped whenever any record transitions. */
    this._cacheVersion = 0;

    /** Bumped per call to compose() so late-returning loads can ignore stale floors. */
    this._composeToken = 0;

    /** @type {Set<(hub: V3MaskHub, eventType: string) => void>} */
    this._subscribers = new Set();

    /** When true, notifications are coalesced until `_flushNotify()` runs. */
    this._notifyBatchDepth = 0;
    this._notifyPending = false;

    /** @type {Map<string, string>} */ this._stackMatteSigs = new Map();

    /** 1×1 RGBA(0,0,0,0) — substitute when a floor has no authored mask file. */
    /** @type {THREE.DataTexture|null} */ this._zeroMaskTex = null;
    /** 1×1 RGBA(1,1,1,1) — helper for alpha-matte lifting to full visibility. */
    /** @type {THREE.DataTexture|null} */ this._oneMaskTex = null;

    /**
     * Albedo textures for floor index ≥ 2 (not owned by the sandwich). Keyed by
     * `floorIndex`; disposed on detach or when visible background URLs change.
     *
     * @type {Map<number, THREE.Texture>}
     */
    this._extraFloorAlbedoTextures = new Map();

    /** @type {string|null} */ this._bgSrcListSig = null;
    /** @type {string|null} */ this._fgSrcListSig = null;

    /**
     * Foreground textures for floor index ≥ 2 (not owned by the sandwich).
     * Keyed by `floorIndex`; disposed on detach or when visible foreground URLs
     * change.
     *
     * @type {Map<number, THREE.Texture>}
     */
    this._extraFloorForegroundTextures = new Map();
    /**
     * Optional per-floor tile/overhead occluder textures (alpha blockers for
     * cross-floor light/shadow transmission). Keyed by floor index.
     *
     * @type {Map<number, THREE.Texture[]>}
     */
    this._extraFloorTileOccluderTextures = new Map();
    /** @type {Map<number, string>} */
    this._tileOccluderSigByFloor = new Map();

    /**
     * Normalized URLs that failed a **speculative** (no-manifest) load this
     * session — blocks repeat GETs across floors, stack matte + fallthrough,
     * and compose-driven rebinds.
     *
     * @type {Set<string>}
     */
    this._speculativeDenialSet = new Set();
    /** @type {string} */ this._denialSceneKey = "";

    /**
     * `FilePicker.browse` results keyed by normalized folder path so optional
     * masks load only when the filename appears in the listing (no blind GETs).
     *
     * @type {Map<string, string[]>}
     */
    this._siblingListingCache = new Map();

    this._disposed = false;
  }

  /**
   * Whether an upper-view stack matte can be built for `maskId` (at least one
   * floor has a URL or loaded texture). Use for UI affordances when the active
   * floor’s row is `missing` but another floor supplies data.
   *
   * @param {string} maskId Catalog id (`water`, `outdoors`, …). Use resolved ids
   *   only (e.g. `outdoors` for surface, not `skyReach` for sky — `skyReach` is
   *   derived and never stacked here).
   */
  canBuildStackMatte(maskId) {
    const scene = this._getScene?.();
    if (!this._wantsStackViewComposite(scene)) return false;
    const entry = getMaskEntry(maskId);
    if (!entry?.suffix || entry.derived) return false;
    const f0 = this._floors.get(floorKeyForIndex(0));
    const f1 = this._floors.get(floorKeyForIndex(1));
    if (!f0 || !f1) return false;
    const r0 = f0.masks.get(maskId);
    const r1 = f1.masks.get(maskId);
    return !!(r0?.url || r0?.texture || r1?.url || r1?.texture);
  }

  /**
   * Call when the viewed level index may have changed (e.g. from
   * {@link V3ThreeSceneHost#_syncFloorStackUniforms}) so GPU composites that
   * only apply on the upper view are released promptly.
   */
  syncForViewedLevel() {
    const scene = this._getScene?.();
    if (!this._wantsStackViewComposite(scene)) {
      this._disposeStackMatteCompositesIfPresent();
    }
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Wire the hub into the active Three.js stack. Call on host mount.
   *
   * @param {{
   *   renderer: THREE.WebGLRenderer,
   *   loader: THREE.TextureLoader,
   *   getScene: () => (Scene|null|undefined),
   *   getCompositor: () => ({lowerTex: THREE.Texture|null, upperTex: THREE.Texture|null}|null),
   *   inventory?: import("./V3AssetInventoryService.js").V3AssetInventoryService|null,
   * }} deps
   */
  attach({ renderer, loader, getScene, getCompositor, inventory }) {
    if (this._disposed) return;
    this._renderer = renderer ?? null;
    this._loader = loader ?? null;
    this._getScene = typeof getScene === "function" ? getScene : () => null;
    this._getCompositor = typeof getCompositor === "function" ? getCompositor : () => null;
    this._inventory = inventory ?? null;
    if (this._renderer && !this._derivedPass) {
      this._derivedPass = new V3DerivedMaskPass(this._renderer);
    }
  }

  /**
   * Drop GL deps and derived render targets without clearing catalog state.
   * Call on host unmount; subsequent `attach` + `compose` rebuilds textures.
   */
  detach() {
    this._disposeDerivedTargets();
    this._disposeExtraFloorAlbedoTextures();
    this._disposeExtraFloorForegroundTextures();
    this._disposeExtraFloorTileOccluderTextures();
    this._bgSrcListSig = null;
    this._fgSrcListSig = null;
    try { this._speculativeDenialSet?.clear(); } catch (_) {}
    try { this._siblingListingCache?.clear(); } catch (_) {}
    this._denialSceneKey = "";
    this._disposeZeroMaskTexture();
    this._disposeOneMaskTexture();
    try { this._derivedPass?.dispose(); } catch (_) {}
    this._derivedPass = null;
    this._disposeAuthoredTextures();
    this._floors.clear();
    this._renderer = null;
    this._loader = null;
    this._getScene = null;
    this._getCompositor = null;
    this._inventory = null;
    this._manifest = null;
    this._bumpCacheVersion("detach");
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.detach();
    this._subscribers.clear();
  }

  // ------------------------------------------------------------------
  // Discovery / composition
  // ------------------------------------------------------------------

  /**
   * Rebuild the per-floor table by resolving authored mask URLs from the
   * attached {@link V3AssetInventoryService}. Safe to call repeatedly —
   * existing records survive when URLs are unchanged so in-flight textures
   * remain valid.
   *
   * **Discovery policy.** Normal calls (no `rescan`) read URLs from the
   * merged manifest (scene-configured + persisted scene-flag cache) and
   * never hit the network for speculative probes. Pass `{ rescan: true }`
   * (or the legacy alias `{ forceReprobe: true }`) to trigger a one-shot
   * `FilePicker.browse` scan before resolving URLs. Persistence is gated
   * on the calling user being a GM.
   *
   * @param {{ forceReprobe?: boolean, rescan?: boolean, persist?: boolean }} [opts]
   * @returns {Promise<void>}
   */
  async compose(opts = {}) {
    if (this._disposed || !this._getScene) return;
    const token = ++this._composeToken;
    const scene = this._getScene();
    const wantsRescan = !!(opts.rescan || opts.forceReprobe);
    const sceneKey = scene?.id ?? "";
    if (sceneKey !== this._denialSceneKey) {
      this._speculativeDenialSet.clear();
      this._denialSceneKey = sceneKey;
      this._siblingListingCache.clear();
    }
    if (wantsRescan) {
      this._speculativeDenialSet.clear();
      this._siblingListingCache.clear();
    }
    const bgList = listVisibleLevelBackgroundSrcs(scene);
    const nextBgSig = bgList.join("\x1e");
    const fgList = listVisibleLevelForegroundSrcs(scene);
    const nextFgSig = fgList.join("\x1e");
    if (nextBgSig !== this._bgSrcListSig) {
      this._disposeExtraFloorAlbedoTextures();
      this._bgSrcListSig = nextBgSig;
      this._siblingListingCache.clear();
    }
    if (nextFgSig !== this._fgSrcListSig) {
      this._disposeExtraFloorForegroundTextures();
      this._disposeExtraFloorTileOccluderTextures();
      this._fgSrcListSig = nextFgSig;
    }
    if (countStackedBackgroundLevels(scene) < 2) {
      this._disposeStackMatteCompositesIfPresent();
    }
    const floorCount = countStackedBackgroundLevels(scene);

    if (this._inventory && scene) {
      if (wantsRescan) {
        this._diag.manualProbeCalls++;
        this._manifest = await this._inventory.scan(scene, {
          write: opts.persist !== false,
        });
      } else {
        this._manifest = this._inventory.buildForScene(scene);
      }
    }
    if (token !== this._composeToken) return;

    this._beginNotifyBatch();
    try {
      const keepKeys = new Set();
      for (let i = 0; i < floorCount; i++) {
        const floorKey = floorKeyForIndex(i);
        keepKeys.add(floorKey);
        await this._composeFloor(scene, i, floorKey, wantsRescan, token);
        if (token !== this._composeToken) return;
      }

      // Discard floor records that no longer match scene topology.
      for (const [key, rec] of Array.from(this._floors.entries())) {
        if (!keepKeys.has(key)) {
          this._disposeFloorRecord(rec);
          this._floors.delete(key);
        }
      }

      for (const idx of Array.from(this._extraFloorAlbedoTextures.keys())) {
        if (idx >= floorCount) {
          const t = this._extraFloorAlbedoTextures.get(idx);
          try { t?.dispose(); } catch (_) {}
          this._extraFloorAlbedoTextures.delete(idx);
        }
      }
      for (const idx of Array.from(this._extraFloorForegroundTextures.keys())) {
        if (idx >= floorCount) {
          const t = this._extraFloorForegroundTextures.get(idx);
          try { t?.dispose(); } catch (_) {}
          this._extraFloorForegroundTextures.delete(idx);
        }
      }
      for (const idx of Array.from(this._extraFloorTileOccluderTextures.keys())) {
        if (idx >= floorCount) {
          const list = this._extraFloorTileOccluderTextures.get(idx) ?? [];
          for (const t of list) {
            try { t?.dispose(); } catch (_) {}
          }
          this._extraFloorTileOccluderTextures.delete(idx);
          this._tileOccluderSigByFloor.delete(idx);
        }
      }

      // Eagerly derive `skyReach` for every visible floor so hot paths (sandwich
      // sky-lit darkness) can `peekFloorMask` synchronously — derivation is
      // otherwise deferred until the first `getFloorMask(..., 'skyReach')`.
      for (let i = 0; i < floorCount; i++) {
        const fk = floorKeyForIndex(i);
        try {
          await this.getFloorMask(fk, "floorAlpha");
          await this.getFloorMask(fk, "skyReach");
          await this.primeFloorOccluderInputs(i);
        } catch (_) {}
        if (token !== this._composeToken) return;
      }

      this._bumpCacheVersion("compose");
    } finally {
      this._endNotifyBatch();
    }
  }

  /**
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @param {string} floorKey
   * @param {boolean} forceReprobe
   * @param {number} token
   */
  async _composeFloor(scene, floorIndex, floorKey, forceReprobe, token) {
    const basePath = scene ? getBackgroundBasePathForLevel(scene, floorIndex) : null;

    let floor = this._floors.get(floorKey);
    const basePathChanged = !floor || floor.basePath !== basePath;
    if (!floor) {
      floor = {
        floorKey,
        floorIndex,
        basePath,
        masks: new Map(),
      };
      this._floors.set(floorKey, floor);
    } else {
      floor.floorIndex = floorIndex;
      floor.basePath = basePath;
    }

    if (basePathChanged) {
      for (const rec of floor.masks.values()) {
        if (!rec.derived) {
          this._disposeRecordTexture(rec);
          rec.status = "idle";
          rec.url = null;
          rec.updatedAtCacheVersion = this._cacheVersion;
        }
      }
    }

    // Resolve authored URLs **only** from the manifest / configured scene
    // textures. Do not synthesize `{base}{suffix}{ext}` here — optional masks
    // would get speculative URLs and every consumer would 404 them forever.
    const authored = listAuthoredMaskIds();
    for (const maskId of authored) {
      const entry = V3_MASK_CATALOG[maskId];
      if (!entry?.suffix) continue;
      const rec = this._ensureRecord(floor, maskId, false);
      if (!forceReprobe && !basePathChanged && (rec.status === "ready" || rec.status === "loading")) {
        continue;
      }
      const url = this._manifestAuthoredUrl(floorIndex, maskId);
      if (token !== this._composeToken) return;
      const urlChanged = rec.url !== url;
      if (urlChanged) {
        rec.url = url;
        rec._lastFailedUrl = undefined;
        if (!url) {
          this._disposeRecordTexture(rec);
          rec.status = "missing";
          this._diag.missingKnown++;
          if (this._inventory && scene) {
            this._inventory.noteMissing(scene, floorIndex, maskId);
          }
        } else {
          rec.status = rec.texture ? "ready" : "idle";
        }
      } else if (!url && rec.status !== "missing") {
        rec.status = "missing";
      }
    }

    // Make derived record placeholders exist so inspectors can introspect.
    for (const derivedId of listDerivedMaskIdsInOrder()) {
      this._ensureRecord(floor, derivedId, true);
    }
  }

  /**
   * URL from manifest / configured textures only (used by `compose`).
   *
   * @param {number} floorIndex
   * @param {string} maskId
   * @returns {string|null}
   */
  _manifestAuthoredUrl(floorIndex, maskId) {
    let url = null;
    if (this._inventory) {
      url = this._inventory.resolveAuthoredUrl(this._manifest, floorIndex, maskId);
    } else {
      url = this._manifest?.levels?.[floorIndex]?.masks?.[maskId]?.url ?? null;
    }
    return url ? normalizeMediaUrlForThree(url) : null;
  }

  /**
   * Same filename convention as legacy disk layout; **not** used during
   * `compose` (avoids optional-mask 404 storms). Used only when loading with
   * `allowSpeculativeDiskUrl`.
   *
   * @param {number} floorIndex
   * @param {string} maskId
   * @returns {string|null}
   */
  _guessConventionalAuthoredUrl(floorIndex, maskId) {
    const scene = this._getScene?.();
    const entry = getMaskEntry(maskId);
    if (!scene || !entry?.suffix || entry.derived) return null;

    const basePath = getBackgroundBasePathForLevel(scene, floorIndex);
    if (!basePath) return null;

    const manifestLevel = this._manifest?.levels?.[floorIndex];
    let bgUrl = manifestLevel?.backgroundUrl ?? null;
    if (!bgUrl) {
      try {
        const list = listVisibleLevelBackgroundSrcs(scene);
        bgUrl = list[floorIndex] ?? null;
      } catch (_) {
        bgUrl = null;
      }
    }
    return guessAuthoredMaskUrlFromBackground(basePath, entry.suffix, bgUrl);
  }

  /**
   * @param {FloorRecord} floor
   * @param {string} maskId
   * @param {boolean} derived
   * @returns {MaskRecord}
   */
  _ensureRecord(floor, maskId, derived) {
    let rec = floor.masks.get(maskId);
    if (!rec) {
      rec = {
        maskId,
        floorKey: floor.floorKey,
        floorIndex: floor.floorIndex,
        derived,
        status: "idle",
        url: null,
        texture: null,
        updatedAtCacheVersion: this._cacheVersion,
      };
      floor.masks.set(maskId, rec);
    }
    return rec;
  }

  // ------------------------------------------------------------------
  // Public reads
  // ------------------------------------------------------------------

  /**
   * Ground-floor view binds per-disk masks while {@link V3WaterOverlay} only
   * reads `uMaskLower` there — if `_Water` exists only beside the upper
   * background, reuse that loaded texture for `floor0` lookups.
   *
   * @param {string} resolvedId
   * @param {string} floorKey
   * @param {{ authoredOnly?: boolean, allowSpeculativeDiskUrl?: boolean }} opts
   * @returns {Promise<THREE.Texture|null>}
   */
  async _waterAuthoredUpperFallbackIfEmpty(resolvedId, floorKey, opts) {
    if (resolvedId !== "water" || opts.authoredOnly) return null;
    if (floorKey !== floorKeyForIndex(0)) return null;
    const scene = this._getScene?.();
    if (countStackedBackgroundLevels(scene) < 2) return null;

    const f1 = this._floors.get(floorKeyForIndex(1));
    if (!f1) return null;

    const rec1 = this._ensureRecord(f1, resolvedId, false);
    await this._ensureAuthoredLoaded(f1, rec1, {
      allowSpeculativeDiskUrl: !!opts.allowSpeculativeDiskUrl,
      resolveSiblingFromListing: true,
    });
    return rec1.texture ?? null;
  }

  /**
   * Returns the mask texture for `(floorKey, maskId)`, loading it on demand.
   *
   * @param {string} floorKey
   * @param {string} maskId   Authored id, derived id, or 'outdoors' (use
   *                          `purpose: 'sky'` to transparently resolve to
   *                          `skyReach`).
   * @param {{
   *   purpose?: 'surface'|'sky',
   *   authoredOnly?: boolean,
   *   allowSpeculativeDiskUrl?: boolean,
   * }} [opts]
   * `allowSpeculativeDiskUrl`: when the manifest has no URL, try the
   *   conventional `{base}{suffix}{ext}` path once per failed URL (debug /
   *   opt-in callers). The hub also applies that guess **only for `outdoors`**
   *   when no manifest URL exists, so typical `_Outdoors` maps keep working
   *   without guessing optional masks like `_Water`. **Never** during `compose`.
   * `authoredOnly`: when true, return the **per-floor disk** texture for
   * `floorKey` only (required for `skyReach`’s per-floor `outdoors` input and
   * for manual-floor inspection in the Tweakpane). When false and the scene
   * shows the upper layer (two levels, viewed index &gt; 0), every **authored**
   * suffixed mask defaults to the **stack matte** (lower + upper mixed by
   * upper albedo alpha), matching `_Outdoors` behavior.
   * When the merged manifest has no URL for an optional suffixed mask, loads
   * still consult one cached `FilePicker.browse` of the level folder (same as
   * stack-matte prep) so e.g. `_Water` beside the background is found without a
   * prior rescan.
   * @returns {Promise<{ texture: THREE.Texture|null, meta: (MaskRecord & { viewComposite?: boolean })|null }>}
   */
  async getFloorMask(floorKey, maskId, opts = {}) {
    const scene = this._getScene?.();

    if (!this._wantsStackViewComposite(scene)) {
      this._disposeStackMatteCompositesIfPresent();
    }

    const resolvedId = maskId === "outdoors"
      ? resolveOutdoorsVariant(opts.purpose ?? "surface")
      : maskId;

    const stackEntry = getMaskEntry(resolvedId);
    if (
      stackEntry?.suffix &&
      !stackEntry.derived &&
      !opts.authoredOnly &&
      this._wantsStackViewComposite(scene)
    ) {
      const tex = await this._ensureStackMatteComposite(scene, resolvedId);
      if (tex) {
        return {
          texture: tex,
          meta: {
            maskId: resolvedId,
            floorKey,
            floorIndex: indexForFloorKey(floorKey),
            derived: false,
            status: "ready",
            url: null,
            updatedAtCacheVersion: this._cacheVersion,
            viewComposite: true,
          },
        };
      }
    }
    const floor = this._floors.get(floorKey);
    if (!floor) return { texture: null, meta: null };

    const entry = getMaskEntry(resolvedId);
    if (!entry) return { texture: null, meta: null };

    const rec = this._ensureRecord(floor, resolvedId, !!entry.derived);

    if (entry.derived) {
      await this._ensureDerived(floor, rec);
    } else {
      await this._ensureAuthoredLoaded(floor, rec, {
        allowSpeculativeDiskUrl: !!opts.allowSpeculativeDiskUrl,
        resolveSiblingFromListing: true,
      });
    }

    let textureOut = rec.texture ?? null;
    let upperWaterFallback = false;
    if (!textureOut && !entry.derived) {
      const fb = await this._waterAuthoredUpperFallbackIfEmpty(resolvedId, floorKey, opts);
      if (fb) {
        textureOut = fb;
        upperWaterFallback = true;
      }
    }

    const meta = { ...rec };
    if (upperWaterFallback) meta.upperFloorWaterFallback = true;
    return { texture: textureOut, meta };
  }

  /**
   * Non-blocking lookup: returns whatever texture is already ready, without
   * kicking off a load. Use this in hot paths (e.g. per-frame binding).
   *
   * @param {string} floorKey
   * @param {string} maskId
   * @param {{ purpose?: 'surface'|'sky', authoredOnly?: boolean }} [opts]
   * @returns {{ texture: THREE.Texture|null, meta: (MaskRecord & { viewComposite?: boolean })|null }}
   */
  peekFloorMask(floorKey, maskId, opts = {}) {
    const scene = this._getScene?.();
    const resolvedId = maskId === "outdoors"
      ? resolveOutdoorsVariant(opts.purpose ?? "surface")
      : maskId;
    const stackEntry = getMaskEntry(resolvedId);
    if (
      stackEntry?.suffix &&
      !stackEntry.derived &&
      !opts.authoredOnly &&
      this._wantsStackViewComposite(scene)
    ) {
      const rt = this._derivedTargets.get(this._stackMatteKey(resolvedId));
      if (rt?.texture) {
        return {
          texture: rt.texture,
          meta: {
            maskId: resolvedId,
            floorKey,
            status: "ready",
            viewComposite: true,
          },
        };
      }
    }

    const floor = this._floors.get(floorKey);
    const rec = floor?.masks.get(resolvedId) ?? null;
    let texture = rec?.texture ?? null;
    let meta = rec ? { ...rec } : null;
    if (
      !texture &&
      resolvedId === "water" &&
      !opts.authoredOnly &&
      floorKey === floorKeyForIndex(0) &&
      countStackedBackgroundLevels(scene) >= 2
    ) {
      const f1 = this._floors.get(floorKeyForIndex(1));
      const rec1 = f1?.masks.get(resolvedId) ?? null;
      if (rec1?.texture) {
        texture = rec1.texture;
        meta = rec
          ? { ...rec, upperFloorWaterFallback: true }
          : { ...rec1, upperFloorWaterFallback: true };
      }
    }
    return { texture, meta };
  }

  /**
   * @param {string} floorKey
   * @returns {MaskRecord[]}
   */
  listFloorMaskRecords(floorKey) {
    const floor = this._floors.get(floorKey);
    if (!floor) return [];
    return Array.from(floor.masks.values()).map((r) => ({ ...r }));
  }

  /** @returns {string[]} */
  listFloorKeys() {
    return Array.from(this._floors.keys());
  }

  /**
   * @param {string} floorKey
   * @returns {FloorRecord|null}  Copy only — do not mutate returned map.
   */
  getFloorRecord(floorKey) {
    const f = this._floors.get(floorKey);
    if (!f) return null;
    return {
      floorKey: f.floorKey,
      floorIndex: f.floorIndex,
      basePath: f.basePath,
      masks: new Map(Array.from(f.masks.entries()).map(([k, v]) => [k, { ...v }])),
    };
  }

  /** @returns {number} Monotonic; increments on every state change. */
  getCacheVersion() {
    return this._cacheVersion;
  }

  /**
   * Active (viewed) floor key — same index as the sandwich compositor uses
   * when it chooses `uApplyUpper`.
   *
   * @returns {string}
   */
  getActiveFloorKey() {
    const scene = this._getScene?.();
    const idx = Math.max(0, getViewedLevelIndex(scene) || 0);
    return floorKeyForIndex(idx);
  }

  /**
   * @param {number} index
   * @returns {string}
   */
  floorKeyForIndex(index) {
    return floorKeyForIndex(index);
  }

  /**
   * @param {string} floorKey
   * @returns {number}
   */
  indexForFloorKey(floorKey) {
    return indexForFloorKey(floorKey);
  }

  /**
   * @param {(hub: V3MaskHub, eventType: string) => void} listener
   * @returns {() => void} Unsubscribe.
   */
  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    this._subscribers.add(listener);
    return () => this._subscribers.delete(listener);
  }

  /** @returns {object} Serializable snapshot for diagnostics. */
  snapshot() {
    const floors = [];
    for (const floor of this._floors.values()) {
      const masks = [];
      for (const rec of floor.masks.values()) {
        masks.push({
          maskId: rec.maskId,
          derived: rec.derived,
          status: rec.status,
          url: rec.url,
          hasTexture: !!rec.texture,
          updatedAtCacheVersion: rec.updatedAtCacheVersion,
          ...(rec.error ? { error: rec.error } : {}),
        });
      }
      floors.push({
        floorKey: floor.floorKey,
        floorIndex: floor.floorIndex,
        basePath: floor.basePath,
        masks,
      });
    }
    return {
      cacheVersion: this._cacheVersion,
      attached: !!this._renderer,
      activeFloorKey: this._getScene ? this.getActiveFloorKey() : null,
      floors,
      diag: { ...this._diag },
      manifest: this._manifest
        ? {
            sceneId: this._manifest.sceneId,
            version: this._manifest.version,
            scan: { ...this._manifest.scan },
            levelCount: Object.keys(this._manifest.levels).length,
          }
        : null,
    };
  }

  /**
   * @returns {import("./V3AssetInventoryService.js").SceneManifest|null}
   *          Last manifest resolved during `compose()`, or `null` when no
   *          inventory service is attached / no scene is active.
   */
  getManifest() {
    return this._manifest;
  }

  /**
   * @returns {import("./V3AssetInventoryService.js").V3AssetInventoryService|null}
   */
  getInventoryService() {
    return this._inventory;
  }

  /**
   * @returns {{ missingKnown: number, loadsAttempted: number, loadsSkipped: number, manualProbeCalls: number }}
   */
  getDiagnostics() {
    return { ...this._diag };
  }

  /**
   * Quick integrity check: used by `V3Shine.validateMasks()` and tests.
   *
   * Verifies that:
   *   1. Every floor has a basePath (or explicitly null if the scene has no bg).
   *   2. Every authored record has status in {idle, probing, missing, loading, ready, error}.
   *   3. Every loaded texture has `flipY === V3_LEVEL_TEXTURE_FLIP_Y`.
   *   4. Active floor key resolves to a known floor record.
   *
   * @returns {{ ok: boolean, issues: string[] }}
   */
  validate() {
    const issues = [];
    const validStatuses = new Set(["idle", "probing", "missing", "loading", "ready", "error"]);
    for (const floor of this._floors.values()) {
      for (const rec of floor.masks.values()) {
        if (!validStatuses.has(rec.status)) {
          issues.push(`${floor.floorKey}/${rec.maskId}: invalid status '${rec.status}'`);
        }
        const tex = rec.texture;
        if (tex && "flipY" in tex && tex.flipY !== V3_LEVEL_TEXTURE_FLIP_Y) {
          issues.push(
            `${floor.floorKey}/${rec.maskId}: texture flipY mismatch (got ${tex.flipY}, expected ${V3_LEVEL_TEXTURE_FLIP_Y})`,
          );
        }
      }
    }
    const active = this._getScene ? this.getActiveFloorKey() : null;
    if (active && !this._floors.has(active)) {
      issues.push(`activeFloorKey '${active}' not present in floor table`);
    }
    return { ok: issues.length === 0, issues };
  }

  /**
   * True when the sandwich shows the upper albedo (`uApplyUpper`) so stacked
   * masks should match what the player sees: lower + upper disk textures
   * matted by upper albedo alpha.
   *
   * @param {Scene|null|undefined} scene
   * @returns {boolean}
   */
  _wantsStackViewComposite(scene) {
    if (!scene) return false;
    if (countStackedBackgroundLevels(scene) < 2) return false;
    if (getViewedLevelIndex(scene) <= 0) return false;
    const comp = this._getCompositor?.();
    return !!comp?.upperTex;
  }

  /** @param {string} maskId Resolved catalog id (e.g. `water`, `outdoors`). */
  _stackMatteKey(maskId) {
    return `stackMatte:${maskId}`;
  }

  _disposeStackMatteCompositesIfPresent() {
    for (const [k, rt] of Array.from(this._derivedTargets.entries())) {
      if (k.startsWith("stackMatte:")) {
        try { rt.dispose(); } catch (_) {}
        this._derivedTargets.delete(k);
      }
    }
    this._stackMatteSigs.clear();
  }

  /** @returns {THREE.DataTexture} */
  _getZeroMaskTexture() {
    if (this._zeroMaskTex) return this._zeroMaskTex;
    const data = new Uint8Array([0, 0, 0, 0]);
    const t = new THREE.DataTexture(data, 1, 1);
    t.needsUpdate = true;
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    this._zeroMaskTex = t;
    return this._zeroMaskTex;
  }

  _disposeZeroMaskTexture() {
    try { this._zeroMaskTex?.dispose(); } catch (_) {}
    this._zeroMaskTex = null;
  }

  /** @returns {THREE.DataTexture} */
  _getOneMaskTexture() {
    if (this._oneMaskTex) return this._oneMaskTex;
    const data = new Uint8Array([255, 255, 255, 255]);
    const t = new THREE.DataTexture(data, 1, 1);
    t.needsUpdate = true;
    t.colorSpace = THREE.NoColorSpace;
    t.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
    this._oneMaskTex = t;
    return this._oneMaskTex;
  }

  _disposeOneMaskTexture() {
    try { this._oneMaskTex?.dispose(); } catch (_) {}
    this._oneMaskTex = null;
  }

  _disposeExtraFloorAlbedoTextures() {
    for (const t of this._extraFloorAlbedoTextures.values()) {
      try { t?.dispose(); } catch (_) {}
    }
    this._extraFloorAlbedoTextures.clear();
  }

  _disposeExtraFloorForegroundTextures() {
    for (const t of this._extraFloorForegroundTextures.values()) {
      try { t?.dispose(); } catch (_) {}
    }
    this._extraFloorForegroundTextures.clear();
  }

  _disposeExtraFloorTileOccluderTextures() {
    for (const list of this._extraFloorTileOccluderTextures.values()) {
      for (const t of list) {
        try { t?.dispose(); } catch (_) {}
      }
    }
    this._extraFloorTileOccluderTextures.clear();
    this._tileOccluderSigByFloor.clear();
  }

  /**
   * Background image URL for a level index (bottom = 0), aligned with mask
   * probing and the sandwich resolver.
   *
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @returns {string|null}
   */
  _backgroundSrcForFloorIndex(scene, floorIndex) {
    if (!scene) return null;
    const list = listVisibleLevelBackgroundSrcs(scene);
    if (floorIndex >= 0 && floorIndex < list.length) return list[floorIndex];
    const inv = buildLevelTextureInventory(scene);
    const row = inv.find(
      (r) =>
        r.levelIndex === floorIndex &&
        String(r.name || "").toLowerCase() === "background",
    );
    const s = row?.src?.trim();
    return s || null;
  }

  /**
   * Foreground image URL for a level index (bottom = 0), aligned with mask
   * floor indexing and level sort.
   *
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @returns {string|null}
   */
  _foregroundSrcForFloorIndex(scene, floorIndex) {
    if (!scene) return null;
    const list = listVisibleLevelForegroundSrcs(scene);
    if (floorIndex >= 0 && floorIndex < list.length) return list[floorIndex];
    const inv = buildLevelTextureInventory(scene);
    const row = inv.find(
      (r) =>
        r.levelIndex === floorIndex &&
        String(r.name || "").toLowerCase() === "foreground",
    );
    const s = row?.src?.trim();
    return s || null;
  }

  /**
   * @param {string} dirRaw directory URL or data-relative path (no trailing slash)
   * @returns {string}
   */
  _listingCacheKeyForDir(dirRaw) {
    const raw = stripQuery(String(dirRaw || "").trim());
    try {
      if (/^https?:\/\//i.test(raw)) {
        return new URL(raw).pathname.replace(/^\/+/, "").replace(/\/+$/, "");
      }
    } catch (_) {}
    return raw.replace(/^\/+/, "").replace(/\/+$/, "");
  }

  /**
   * Cached directory listing for sibling mask discovery.
   *
   * @param {string} basePathNoExt
   * @returns {Promise<string[]>}
   */
  async _getCachedSiblingDirFiles(basePathNoExt) {
    const base = stripQuery(String(basePathNoExt || "").trim());
    const idx = base.lastIndexOf("/");
    const dir = idx >= 0 ? base.slice(0, idx) : "";
    if (!dir) return [];
    const key = this._listingCacheKeyForDir(dir);
    if (this._siblingListingCache.has(key)) {
      return this._siblingListingCache.get(key) ?? [];
    }
    const listing = await browseDirectoryFiles(dir);
    const files = Array.isArray(listing?.files) ? listing.files : [];
    this._siblingListingCache.set(key, files);
    return files;
  }

  /**
   * @param {Scene|null|undefined} scene
   * @param {string} maskId Resolved authored catalog id
   * @returns {Promise<THREE.Texture|null>}
   */
  async _ensureStackMatteComposite(scene, maskId) {
    if (!this._derivedPass || !scene) return null;
    const comp = this._getCompositor?.();
    const upperAlbedo = comp?.upperTex ?? null;
    if (!upperAlbedo) return null;

    const f0 = this._floors.get(floorKeyForIndex(0));
    const f1 = this._floors.get(floorKeyForIndex(1));
    if (!f0 || !f1) return null;

    const r0 = this._ensureRecord(f0, maskId, false);
    const r1 = this._ensureRecord(f1, maskId, false);
    // Resolve optional masks only when `FilePicker.browse` lists them beside
    // the background — never speculative GETs (avoids 404 HTML noise).
    const loadOpts = { allowSpeculativeDiskUrl: false, resolveSiblingFromListing: true };
    await this._ensureAuthoredLoaded(f0, r0, loadOpts);
    await this._ensureAuthoredLoaded(f1, r1, loadOpts);
    const lowerTex = r0.texture ?? null;
    const upperTex = r1.texture ?? null;
    if (!lowerTex && !upperTex) return null;

    const lowerForPass = lowerTex ?? this._getZeroMaskTexture();
    const upperForPass = upperTex ?? this._getZeroMaskTexture();

    const key = this._stackMatteKey(maskId);
    const newSig = [
      getViewedLevelIndex(scene),
      lowerTex?.uuid ?? "missing",
      upperTex?.uuid ?? "missing",
      upperAlbedo.uuid,
    ].join("|");

    const prevRt = this._derivedTargets.get(key) ?? null;
    if (this._stackMatteSigs.get(key) === newSig && prevRt?.texture) {
      return prevRt.texture;
    }
    this._stackMatteSigs.set(key, newSig);

    const rt = this._derivedPass.renderMaskStackMatteOverAlbedo({
      lowerMask: lowerForPass,
      upperMask: upperForPass,
      upperAlbedo,
      reuseTarget: prevRt,
    });
    if (!rt) return null;
    this._derivedTargets.set(key, rt);
    this._bumpCacheVersion(`stack-matte:${maskId}`);
    return rt.texture;
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------

  /**
   * @param {FloorRecord} floor
   * @param {MaskRecord} rec
   * @param {{
   *   allowSpeculativeDiskUrl?: boolean,
   *   resolveSiblingFromListing?: boolean,
   * }} [opts]
   */
  async _ensureAuthoredLoaded(floor, rec, opts = {}) {
    if (rec.status === "ready" && rec.texture) {
      this._diag.loadsSkipped++;
      return;
    }
    let loadUrl = rec.url ? normalizeMediaUrlForThree(rec.url) : null;

    if (!loadUrl && !rec.url && (opts.resolveSiblingFromListing || opts.allowSpeculativeDiskUrl)) {
      const scene = this._getScene?.();
      const basePath = scene ? getBackgroundBasePathForLevel(scene, floor.floorIndex) : null;
      const entry = getMaskEntry(rec.maskId);
      const suffix = entry?.suffix;
      if (basePath && suffix) {
        try {
          const files = await this._getCachedSiblingDirFiles(basePath);
          const listed = resolveListedSiblingMaskUrl(files, basePath, suffix);
          if (listed) loadUrl = normalizeMediaUrlForThree(listed);
        } catch (_) {}
      }
    }

    /** Conventional `{bg}{suffix}{ext}` only after listing miss, and only for outdoors or explicit opt-in speculative. */
    const allowDiskGuess =
      !!opts.allowSpeculativeDiskUrl ||
      (!rec.url && rec.maskId === "outdoors");

    if (!loadUrl && allowDiskGuess) {
      const g = this._guessConventionalAuthoredUrl(floor.floorIndex, rec.maskId);
      loadUrl = g ? normalizeMediaUrlForThree(g) : null;
    }
    if (!loadUrl) {
      rec.status = "missing";
      return;
    }
    if (!this._loader) return;
    // Session-wide: one 404 per guessed URL (covers two floors + stack vs fallthrough).
    if (!rec.url && allowDiskGuess && this._speculativeDenialSet.has(loadUrl)) {
      rec.status = "missing";
      return;
    }
    // No manifest URL: don't hammer the same speculative path forever.
    if (!rec.url && rec._lastFailedUrl === loadUrl) {
      rec.status = "missing";
      return;
    }
    if (rec.status === "error" && rec._lastFailedUrl === loadUrl) {
      return;
    }
    if (rec.status === "loading" && rec._loadPromise) {
      await rec._loadPromise;
      return;
    }
    this._diag.loadsAttempted++;
    rec.status = "loading";
    rec.error = undefined;
    rec._loadPromise = this._loadTexture(loadUrl)
      .then((tex) => {
        rec.texture = tex;
        rec.status = "ready";
        rec._lastFailedUrl = undefined;
        rec.updatedAtCacheVersion = this._cacheVersion;
        this._bumpCacheVersion(`load:${floor.floorKey}/${rec.maskId}`);
      })
      .catch((err) => {
        rec.error = String(err?.message ?? err);
        rec.status = "error";
        rec._lastFailedUrl = loadUrl;
        if (!rec.url) {
          this._speculativeDenialSet.add(loadUrl);
        } else {
          this.warn("mask load failed", floor.floorKey, rec.maskId, err);
        }
      })
      .finally(() => {
        rec._loadPromise = null;
      });
    await rec._loadPromise;
  }

  /**
   * @param {string} url
   * @returns {Promise<THREE.Texture>}
   */
  _loadTexture(url) {
    const resolved = normalizeMediaUrlForThree(url);
    if (!resolved) {
      return Promise.reject(new Error("empty-mask-url"));
    }
    return new Promise((resolve, reject) => {
      this._loader.load(
        resolved,
        (tex) => {
          tex.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
          tex.premultiplyAlpha = false;
          tex.colorSpace = THREE.NoColorSpace;
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        reject,
      );
    });
  }

  /**
   * Load a level background for albedo alpha (SRGB, same flipY as masks).
   *
   * @param {string} url
   * @returns {Promise<THREE.Texture>}
   */
  _loadAlbedoTexture(url) {
    return new Promise((resolve, reject) => {
      if (!this._loader) {
        reject(new Error("no-loader"));
        return;
      }
      this._loader.load(
        url,
        (tex) => {
          tex.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
          tex.premultiplyAlpha = false;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          resolve(tex);
        },
        undefined,
        reject,
      );
    });
  }

  /**
   * Albedo alpha source for sky occlusion: compositor textures when bound,
   * otherwise the same background URL the sandwich uses (cached on the hub).
   * Missing URL or load failure yields `null` (treated as no occlusion).
   *
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @returns {Promise<THREE.Texture|null>}
   */
  async _ensureFloorAlbedoTexture(scene, floorIndex) {
    const comp = this._getCompositor?.();
    if (floorIndex === 0) {
      const t = comp?.lowerTex ?? null;
      if (t) return t;
      return this._ensureExtraAlbedoFromUrl(scene, 0);
    }
    if (floorIndex === 1) {
      const t = comp?.upperTex ?? null;
      if (t) return t;
      return this._ensureExtraAlbedoFromUrl(scene, 1);
    }
    return this._ensureExtraAlbedoFromUrl(scene, floorIndex);
  }

  /**
   * Foreground alpha blocker source for skyReach. Floors 0/1 prefer live
   * sandwich textures; higher floors are loaded from scene URLs.
   *
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @returns {Promise<THREE.Texture|null>}
   */
  async _ensureFloorForegroundTexture(scene, floorIndex) {
    const comp = this._getCompositor?.();
    if (floorIndex === 0) {
      const t = comp?.lowerFgTex ?? null;
      if (t) return t;
      return this._ensureExtraForegroundFromUrl(scene, 0);
    }
    if (floorIndex === 1) {
      const t = comp?.upperFgTex ?? null;
      if (t) return t;
      return this._ensureExtraForegroundFromUrl(scene, 1);
    }
    return this._ensureExtraForegroundFromUrl(scene, floorIndex);
  }

  /**
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @returns {Promise<THREE.Texture|null>}
   */
  async _ensureExtraAlbedoFromUrl(scene, floorIndex) {
    const cached = this._extraFloorAlbedoTextures.get(floorIndex);
    if (cached) return cached;
    if (!this._loader) return null;

    const url = this._backgroundSrcForFloorIndex(scene, floorIndex);
    if (!url) return null;

    try {
      const tex = await this._loadAlbedoTexture(url);
      const existing = this._extraFloorAlbedoTextures.get(floorIndex);
      if (existing) {
        try { tex.dispose(); } catch (_) {}
        return existing;
      }
      this._extraFloorAlbedoTextures.set(floorIndex, tex);
      return tex;
    } catch (err) {
      this.warn("floor-albedo-load-failed", { floorIndex, url, err });
      return null;
    }
  }

  /**
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @returns {Promise<THREE.Texture|null>}
   */
  async _ensureExtraForegroundFromUrl(scene, floorIndex) {
    const cached = this._extraFloorForegroundTextures.get(floorIndex);
    if (cached) return cached;
    if (!this._loader) return null;

    const url = this._foregroundSrcForFloorIndex(scene, floorIndex);
    if (!url) return null;

    try {
      const tex = await this._loadAlbedoTexture(url);
      const existing = this._extraFloorForegroundTextures.get(floorIndex);
      if (existing) {
        try { tex.dispose(); } catch (_) {}
        return existing;
      }
      this._extraFloorForegroundTextures.set(floorIndex, tex);
      return tex;
    } catch (err) {
      this.warn("floor-foreground-load-failed", { floorIndex, url, err });
      return null;
    }
  }

  /**
   * Candidate tile/overhead textures that should block cross-floor
   * light/shadow transmission for one floor.
   *
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @returns {string[]}
   */
  _listFloorTileOccluderSrcs(scene, floorIndex) {
    if (!scene) return [];
    /** @type {string[]} */
    const out = [];
    const seen = new Set();
    const push = (name, src) => {
      const n = String(name || "").trim().toLowerCase();
      const s = String(src || "").trim();
      if (!s) return;
      // Keep this strict so data masks (Outdoors/Water/etc.) do not accidentally
      // become geometric blockers in the transmission chain.
      if (!/(tile|tiles|overhead|roof|occluder)/i.test(n)) return;
      if (seen.has(s)) return;
      seen.add(s);
      out.push(s);
    };
    try {
      const sorted = scene.levels?.sorted;
      const level = Array.isArray(sorted) ? sorted[floorIndex] : null;
      const txs = level?.textures;
      if (Array.isArray(txs)) {
        for (let i = 0; i < txs.length; i++) {
          const t = txs[i];
          push(t?.name ?? t?.type ?? `textures[${i}]`, t?.src);
        }
      } else if (txs && typeof txs === "object") {
        for (const [k, v] of Object.entries(txs)) {
          const src = v && typeof v === "object" ? v.src : v;
          push(k, src);
        }
      }
    } catch (_) {}
    try {
      const inv = buildLevelTextureInventory(scene);
      for (const row of inv) {
        if (row?.levelIndex !== floorIndex) continue;
        push(row?.name ?? "", row?.src ?? "");
      }
    } catch (_) {}
    return out;
  }

  /**
   * @param {Scene|null|undefined} scene
   * @param {number} floorIndex
   * @returns {Promise<THREE.Texture[]>}
   */
  async _ensureFloorTileOccluderTextures(scene, floorIndex) {
    const srcs = this._listFloorTileOccluderSrcs(scene, floorIndex);
    const sig = srcs.join("\x1e");
    if ((this._tileOccluderSigByFloor.get(floorIndex) ?? "") === sig) {
      return this._extraFloorTileOccluderTextures.get(floorIndex) ?? [];
    }
    const old = this._extraFloorTileOccluderTextures.get(floorIndex) ?? [];
    this._extraFloorTileOccluderTextures.delete(floorIndex);
    this._tileOccluderSigByFloor.set(floorIndex, sig);
    for (const t of old) {
      try { t?.dispose(); } catch (_) {}
    }
    if (!srcs.length || !this._loader) return [];
    /** @type {THREE.Texture[]} */
    const loaded = [];
    for (const src of srcs) {
      try {
        const tex = await this._loadAlbedoTexture(src);
        loaded.push(tex);
      } catch (err) {
        this.warn("floor-tile-occluder-load-failed", { floorIndex, src, err });
      }
    }
    this._extraFloorTileOccluderTextures.set(floorIndex, loaded);
    return loaded;
  }

  /**
   * Warm up per-floor occluder inputs used by multi-floor transmission.
   *
   * @param {number} floorIndex
   * @returns {Promise<void>}
   */
  async primeFloorOccluderInputs(floorIndex) {
    const scene = this._getScene?.() ?? null;
    await this._ensureFloorAlbedoTexture(scene, floorIndex);
    await this._ensureFloorForegroundTexture(scene, floorIndex);
    await this._ensureFloorTileOccluderTextures(scene, floorIndex);
  }

  /**
   * Non-blocking read of occluder textures for one floor. Ordered as
   * albedo, foreground, then tile/overhead textures. De-duplicates by uuid.
   *
   * @param {number} floorIndex
   * @returns {THREE.Texture[]}
   */
  peekFloorOccluderInputs(floorIndex) {
    const comp = this._getCompositor?.();
    /** @type {THREE.Texture[]} */
    const out = [];
    const seen = new Set();
    const push = (tex) => {
      if (!tex) return;
      const id = String(tex.uuid ?? "");
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      out.push(tex);
    };
    push(this._floorAlbedoTexture(comp, floorIndex) ?? this._extraFloorAlbedoTextures.get(floorIndex) ?? null);
    if (floorIndex === 0) push(comp?.lowerFgTex ?? null);
    else if (floorIndex === 1) push(comp?.upperFgTex ?? null);
    else push(this._extraFloorForegroundTextures.get(floorIndex) ?? null);
    const tiles = this._extraFloorTileOccluderTextures.get(floorIndex) ?? [];
    for (const t of tiles) push(t);
    return out;
  }

  // ------------------------------------------------------------------
  // Derivation
  // ------------------------------------------------------------------

  /**
   * @param {FloorRecord} floor
   * @param {MaskRecord} rec
   */
  async _ensureDerived(floor, rec) {
    if (rec.maskId === "floorAlpha") {
      await this._computeFloorAlpha(floor, rec);
      return;
    }
    if (rec.maskId === "skyReach") {
      await this._computeSkyReach(floor, rec);
      return;
    }
    rec.status = "missing";
  }

  /**
   * `floorAlpha` is the albedo texture itself; consumers sample `.a`.
   *
   * @param {FloorRecord} floor
   * @param {MaskRecord} rec
   */
  async _computeFloorAlpha(floor, rec) {
    const scene = this._getScene?.() ?? null;
    const albedo = await this._ensureFloorAlbedoTexture(scene, floor.floorIndex);
    if (!albedo) {
      rec.status = "missing";
      rec.texture = null;
      return;
    }
    rec.texture = albedo;
    rec.status = "ready";
    rec.updatedAtCacheVersion = this._cacheVersion;
  }

  /**
   * @param {FloorRecord} floor
   * @param {MaskRecord} rec
   */
  async _computeSkyReach(floor, rec) {
    if (!this._derivedPass) {
      rec.status = "missing";
      return;
    }

    const token = this._composeToken;
    const scene = this._getScene?.() ?? null;

    const { texture: outdoorsTex } = await this.getFloorMask(floor.floorKey, "outdoors", {
      purpose: "surface",
      authoredOnly: true,
      allowSpeculativeDiskUrl: false,
    });
    if (token !== this._composeToken) return;
    if (!outdoorsTex) {
      rec.status = "missing";
      rec.texture = this._releaseDerivedTarget(rec) ?? null;
      return;
    }

    const levelCount = countStackedBackgroundLevels(scene);
    const fgSelf = await this._ensureFloorForegroundTexture(scene, floor.floorIndex);
    if (token !== this._composeToken) return;
    /** @type {THREE.Texture[]} */
    const alphaAbove = [];
    // IMPORTANT: do not include this floor's own foreground alpha in its
    // skyReach chain. Foreground/overhead art should render above the shadow,
    // not receive an extra darkening pass itself. Upper floors still contribute
    // blockers via the loop below, so cross-floor occlusion remains intact.
    for (let j = floor.floorIndex + 1; j < levelCount; j++) {
      const albedo = await this._ensureFloorAlbedoTexture(scene, j);
      if (token !== this._composeToken) return;
      if (albedo) alphaAbove.push(albedo);
      const fg = await this._ensureFloorForegroundTexture(scene, j);
      if (token !== this._composeToken) return;
      if (fg) alphaAbove.push(fg);
    }

    const key = `skyReach:${floor.floorKey}`;
    const reused = this._derivedTargets.get(key) ?? null;
    // When foreground relief is applied, avoid reusing the same RT as an input
    // and output in one draw call.
    const reusedForBase = fgSelf ? null : reused;

    /** @type {THREE.WebGLRenderTarget|null} */
    let rawRt = null;
    try {
      const albedoSelf = await this._ensureFloorAlbedoTexture(scene, floor.floorIndex);
      if (token !== this._composeToken) return;

      const wantsMatte =
        floor.floorIndex > 0 &&
        !!albedoSelf;

      if (wantsMatte) {
        const { texture: srBelowTex } = await this.getFloorMask(
          floorKeyForIndex(floor.floorIndex - 1),
          "skyReach",
          { purpose: "sky" },
        );
        if (token !== this._composeToken) return;

        if (srBelowTex) {
          rawRt = this._derivedPass.renderSkyReachChain({
            outdoorsTex,
            alphaTexArray: alphaAbove,
            reuseTarget: null,
          });
          if (!rawRt) {
            rec.status = "error";
            rec.error = "derived-pass-failed";
            return;
          }
          const baseRt = this._derivedPass.renderMaskStackMatteOverAlbedo({
            lowerMask: srBelowTex,
            upperMask: rawRt.texture,
            upperAlbedo: albedoSelf,
            reuseTarget: reusedForBase,
            // Bilinear alpha at hard cutouts lerps in dark raw upper skyReach → black fringe.
            nearestAlbedoAlpha: true,
          });
          if (!baseRt) {
            rec.status = "error";
            rec.error = "derived-pass-failed";
            return;
          }
          let finalRt = baseRt;
          if (fgSelf) {
            const reliefRt = this._derivedPass.renderMaskStackMatteOverAlbedo({
              lowerMask: baseRt.texture,
              upperMask: this._getOneMaskTexture(),
              upperAlbedo: fgSelf,
              reuseTarget: reused,
              // Foreground alpha edges should be crisp when "lifting" skyReach.
              nearestAlbedoAlpha: true,
            });
            if (!reliefRt) {
              rec.status = "error";
              rec.error = "derived-pass-failed";
              return;
            }
            finalRt = reliefRt;
            if (baseRt !== reliefRt) {
              try { baseRt.dispose(); } catch (_) {}
            }
          }
          this._derivedTargets.set(key, finalRt);
          rec.texture = finalRt.texture;
          rec.status = "ready";
          rec.updatedAtCacheVersion = this._cacheVersion;
          return;
        }
      }

      const baseRt = this._derivedPass.renderSkyReachChain({
        outdoorsTex,
        alphaTexArray: alphaAbove,
        reuseTarget: reusedForBase,
      });

      if (!baseRt) {
        rec.status = "error";
        rec.error = "derived-pass-failed";
        return;
      }
      let finalRt = baseRt;
      if (fgSelf) {
        const reliefRt = this._derivedPass.renderMaskStackMatteOverAlbedo({
          lowerMask: baseRt.texture,
          upperMask: this._getOneMaskTexture(),
          upperAlbedo: fgSelf,
          reuseTarget: reused,
          nearestAlbedoAlpha: true,
        });
        if (!reliefRt) {
          rec.status = "error";
          rec.error = "derived-pass-failed";
          return;
        }
        finalRt = reliefRt;
        if (baseRt !== reliefRt) {
          try { baseRt.dispose(); } catch (_) {}
        }
      }
      this._derivedTargets.set(key, finalRt);
      rec.texture = finalRt.texture;
      rec.status = "ready";
      rec.updatedAtCacheVersion = this._cacheVersion;
    } finally {
      if (rawRt) {
        try { rawRt.dispose(); } catch (_) {}
      }
    }
  }

  /**
   * @param {ReturnType<V3MaskHub['_getCompositor']>} comp
   * @param {number} floorIndex
   * @returns {THREE.Texture|null}
   */
  _floorAlbedoTexture(comp, floorIndex) {
    if (!comp) return null;
    if (floorIndex === 0) return comp.lowerTex ?? null;
    if (floorIndex === 1) return comp.upperTex ?? null;
    return null;
  }

  /**
   * @param {MaskRecord} rec
   * @returns {null}
   */
  _releaseDerivedTarget(rec) {
    const key = `skyReach:${rec.floorKey}`;
    const rt = this._derivedTargets.get(key);
    if (rt) {
      try { rt.dispose(); } catch (_) {}
      this._derivedTargets.delete(key);
    }
    rec.texture = null;
    return null;
  }

  // ------------------------------------------------------------------
  // Notifications
  // ------------------------------------------------------------------

  _bumpCacheVersion(reason) {
    this._cacheVersion++;
    this._notify(reason || "change");
  }

  _notify(reason) {
    if (this._notifyBatchDepth > 0) {
      this._notifyPending = true;
      return;
    }
    for (const listener of Array.from(this._subscribers)) {
      try { listener(this, reason); } catch (err) { this.warn("subscriber threw", err); }
    }
  }

  _beginNotifyBatch() {
    this._notifyBatchDepth++;
  }

  _endNotifyBatch() {
    this._notifyBatchDepth = Math.max(0, this._notifyBatchDepth - 1);
    if (this._notifyBatchDepth === 0 && this._notifyPending) {
      this._notifyPending = false;
      this._notify("batch");
    }
  }

  // ------------------------------------------------------------------
  // Cleanup
  // ------------------------------------------------------------------

  _disposeDerivedTargets() {
    for (const rt of this._derivedTargets.values()) {
      try { rt.dispose(); } catch (_) {}
    }
    this._derivedTargets.clear();
    this._stackMatteSigs.clear();
  }

  _disposeAuthoredTextures() {
    for (const floor of this._floors.values()) {
      for (const rec of floor.masks.values()) {
        if (!rec.derived) this._disposeRecordTexture(rec);
      }
    }
  }

  /** @param {FloorRecord} rec */
  _disposeFloorRecord(rec) {
    for (const m of rec.masks.values()) {
      if (!m.derived) this._disposeRecordTexture(m);
    }
  }

  /** @param {MaskRecord} rec */
  _disposeRecordTexture(rec) {
    if (rec.derived) {
      rec.texture = null;
      return;
    }
    try { rec.texture?.dispose?.(); } catch (_) {}
    rec.texture = null;
  }
}
