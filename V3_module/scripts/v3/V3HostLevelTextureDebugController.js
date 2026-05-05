/**
 * @fileoverview Level texture debug overlay orchestration for {@link V3ThreeSceneHost}.
 * Owns load tokens, overlay instance, and pick metadata; host supplies GL + sync hooks.
 */

import {
  buildLevelTextureInventory,
  pickTextureRow,
} from "./V3LevelTextureCatalog.js";
import { V3LevelTextureDebugOverlay } from "./V3LevelTextureDebugOverlay.js";

/**
 * @typedef {{
 *   loadTexture: (url: string) => Promise<import("three").Texture>,
 *   getScene: () => any,
 *   getCompositorScene: () => import("three").Scene|null,
 *   getUpperAlbedoTex: () => import("three").Texture|null,
 *   getBoardPixelSize: () => { w: number, h: number },
 *   syncViewportUniforms: () => void,
 *   log: Function,
 *   warn: Function,
 * }} V3HostLevelTextureDebugDeps
 */

export class V3HostLevelTextureDebugController {
  /**
   * @param {V3HostLevelTextureDebugDeps} deps
   */
  constructor(deps) {
    this._deps = deps;
    /** @type {V3LevelTextureDebugOverlay|null} */
    this._textureDebug = null;
    /** @type {number} */ this._debugLoadToken = 0;
    /** @type {{ row: object, reason: string }|null} */
    this._debugPick = null;
  }

  get debugPick() {
    return this._debugPick;
  }

  get textureDebug() {
    return this._textureDebug;
  }

  bumpSupersedeToken() {
    this._debugLoadToken++;
  }

  /**
   * @returns {ReturnType<typeof buildLevelTextureInventory>}
   */
  getLevelTextureInventory() {
    return buildLevelTextureInventory(this._deps.getScene() ?? null);
  }

  /** @param {object} [opts] Passed to `pickTextureRow` + display fields. */
  async setLevelTextureDebug(opts = {}) {
    const scene = this._deps.getScene();
    if (!scene || !this._deps.getCompositorScene()) {
      this._deps.warn("setLevelTextureDebug: no mounted scene/compositor");
      return { ok: false, reason: "no-scene" };
    }

    const token = ++this._debugLoadToken;
    const inventory = buildLevelTextureInventory(scene);
    const { row, reason } = pickTextureRow(inventory, opts);
    if (!row) {
      this._deps.warn("setLevelTextureDebug: no matching texture", reason, opts);
      return { ok: false, reason, inventoryCount: inventory.length };
    }

    const suffixGuess = (row.inferredSuffix && String(row.inferredSuffix).toLowerCase()) || "";
    const nameGuess = (row.name && String(row.name).toLowerCase()) || "";
    const outdoorsy =
      suffixGuess.includes("outdoor") ||
      nameGuess.includes("outdoor") ||
      String(row.src).toLowerCase().includes("_outdoor");
    const isMask =
      typeof opts.isMask === "boolean" ? opts.isMask : !!outdoorsy;
    const channelView =
      opts.channelView ?? (isMask ? "r" : "rgba");

    let tex;
    try {
      tex = await this._deps.loadTexture(row.src);
    } catch (err) {
      this._deps.warn("setLevelTextureDebug: load failed", err);
      return { ok: false, reason: "load-failed", row };
    }
    if (token !== this._debugLoadToken) {
      try {
        tex?.dispose?.();
      } catch (_) {}
      return { ok: false, reason: "superseded" };
    }

    this._ensureOverlayAttached();
    this._textureDebug.setTexture(tex, { isMask });
    this._textureDebug.setDisplayOptions({
      opacity: typeof opts.opacity === "number" ? opts.opacity : 0.65,
      channelView,
      flipBackgroundTextureY: opts.flipBackgroundTextureY,
    });
    this._deps.syncViewportUniforms();
    this._debugPick = { row, reason };
    this._deps.log("level texture debug", { src: row.src, name: row.name, reason });
    return { ok: true, row, reason };
  }

  /**
   * @param {string} url
   * @param {object} [opts]
   */
  async setLevelTextureDebugFromUrl(url, opts = {}) {
    const scene = this._deps.getScene();
    if (!scene || !this._deps.getCompositorScene()) {
      this._deps.warn("setLevelTextureDebugFromUrl: no mounted scene/compositor");
      return { ok: false, reason: "no-scene" };
    }
    const u = String(url || "").trim();
    if (!u) return { ok: false, reason: "empty-url" };

    const token = ++this._debugLoadToken;

    const channelView = opts.channelView ?? (opts.isMask !== false ? "r" : "rgba");
    let tex;
    try {
      tex = await this._deps.loadTexture(u);
    } catch (err) {
      this._deps.warn("setLevelTextureDebugFromUrl: load failed", err);
      return { ok: false, reason: "load-failed" };
    }
    if (token !== this._debugLoadToken) {
      try {
        tex?.dispose?.();
      } catch (_) {}
      return { ok: false, reason: "superseded" };
    }

    this._ensureOverlayAttached();
    this._textureDebug.setTexture(tex, {
      isMask: opts.isMask !== false,
    });
    this._textureDebug.setDisplayOptions({
      opacity: typeof opts.opacity === "number" ? opts.opacity : 0.75,
      channelView,
      flipBackgroundTextureY: opts.flipBackgroundTextureY,
    });
    this._deps.syncViewportUniforms();
    this._debugPick = {
      row: {
        src: u,
        name: opts.label ?? "url",
        levelIndex: null,
        inferredSuffix: null,
      },
      reason: "direct-url",
    };
    this._deps.log("level texture debug (url)", { src: u });
    return { ok: true };
  }

  /**
   * @param {string} lowerMaskUrl
   * @param {string} upperMaskUrl
   * @param {object} [opts]
   */
  async setLevelTextureDebugDualOutdoorsOverAlbedo(lowerMaskUrl, upperMaskUrl, opts = {}) {
    const scene = this._deps.getScene();
    if (!scene || !this._deps.getCompositorScene()) {
      this._deps.warn("setLevelTextureDebugDualOutdoors: no mounted scene/compositor");
      return { ok: false, reason: "no-scene" };
    }
    const a = String(lowerMaskUrl || "").trim();
    const b = String(upperMaskUrl || "").trim();
    if (!a || !b) return { ok: false, reason: "empty-url" };

    const albedoUpper = this._deps.getUpperAlbedoTex() ?? null;
    if (!albedoUpper) {
      this._deps.warn("dual outdoors debug: no upper albedo (sandwich); cannot matte");
      return { ok: false, reason: "no-upper-albedo" };
    }

    const token = ++this._debugLoadToken;
    const channelView = opts.channelView ?? (opts.isMask !== false ? "r" : "rgba");

    let lowerT;
    let upperT;
    try {
      [lowerT, upperT] = await Promise.all([
        this._deps.loadTexture(a),
        this._deps.loadTexture(b),
      ]);
    } catch (err) {
      this._deps.warn("setLevelTextureDebugDualOutdoors: load failed", err);
      return { ok: false, reason: "load-failed" };
    }
    if (token !== this._debugLoadToken) {
      try {
        lowerT?.dispose?.();
      } catch (_) {}
      try {
        upperT?.dispose?.();
      } catch (_) {}
      return { ok: false, reason: "superseded" };
    }

    this._ensureOverlayAttached();
    this._textureDebug.setTexture(null, {
      isMask: opts.isMask !== false,
      dualMaskOverAlbedo: {
        lowerTex: lowerT,
        upperTex: upperT,
        albedoUpper: albedoUpper,
      },
    });
    this._textureDebug.setDisplayOptions({
      opacity: typeof opts.opacity === "number" ? opts.opacity : 0.75,
      channelView,
      flipBackgroundTextureY: opts.flipBackgroundTextureY,
    });
    this._deps.syncViewportUniforms();
    this._debugPick = {
      row: {
        src: `${a} ⟷ ${b}`,
        name: opts.label ?? "dual-outdoors",
        levelIndex: null,
        inferredSuffix: "_Outdoors",
      },
      reason: "dual-outdoors-over-albedo",
    };
    this._deps.log("level texture debug (dual outdoors / albedo matte)", { lower: a, upper: b });
    return { ok: true };
  }

  /**
   * @param {import("three").Texture|null} texture
   * @param {object} [opts]
   */
  setLevelTextureDebugFromHubTexture(texture, opts = {}) {
    const scene = this._deps.getScene();
    if (!scene || !this._deps.getCompositorScene()) {
      this._deps.warn("setLevelTextureDebugFromHubTexture: no mounted scene/compositor");
      return { ok: false, reason: "no-scene" };
    }
    if (!texture) return { ok: false, reason: "no-texture" };

    this._debugLoadToken++;

    this._ensureOverlayAttached();

    const channelView = opts.channelView ?? (opts.isMask !== false ? "r" : "rgba");
    this._textureDebug.setTexture(texture, {
      isMask: opts.isMask !== false,
      ownsTexture: !!opts.owned,
    });
    this._textureDebug.setDisplayOptions({
      opacity: typeof opts.opacity === "number" ? opts.opacity : 0.75,
      channelView,
      flipBackgroundTextureY: opts.flipBackgroundTextureY,
    });
    this._deps.syncViewportUniforms();
    this._debugPick = {
      row: {
        src: texture.uuid ?? "hub-texture",
        name: opts.label ?? "hub-texture",
        levelIndex: null,
        inferredSuffix: null,
      },
      reason: "hub-texture",
    };
    this._deps.log("level texture debug (hub texture)", opts.label ?? "hub-texture");
    return { ok: true };
  }

  clearLevelTextureDebug() {
    this._debugLoadToken++;
    this._debugPick = null;
    if (this._textureDebug) {
      try {
        this._textureDebug.setTexture(null);
      } catch (_) {}
      try {
        this._textureDebug.dispose();
      } catch (_) {}
      this._textureDebug = null;
    }
  }

  _ensureOverlayAttached() {
    const compScene = this._deps.getCompositorScene();
    if (!this._textureDebug && compScene) {
      this._textureDebug = new V3LevelTextureDebugOverlay();
      this._textureDebug.attachTo(compScene);
      const { w, h } = this._deps.getBoardPixelSize();
      this._textureDebug.setOutputSize(w, h);
    }
  }
}
