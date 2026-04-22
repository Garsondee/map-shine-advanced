/**
 * @fileoverview V3 token pass — billboard sprites driven by Foundry `TokenDocument`
 * + pan/zoom (`buildV3ViewUniformPayload`). Sprites render into two RTs via
 * {@link THREE.Layers}: **layer 0** = below the viewed floor (occluded by upper
 * albedo when stacked), **layer 1** = on the viewed floor (drawn above upper art).
 * Placement uses **CSS logical** board size so tokens stay pinned to world space
 * under device pixel ratio (must match `uResolution` in the sandwich shader).
 */

import * as THREE from "../vendor/three.module.js";
import {
  buildV3ViewUniformPayload,
  getV3BoardPixelSize,
} from "./V3FoundryCanvasIntegration.js";
import { getViewedLevelIndex } from "./V3ViewedLevel.js";

/** {@link THREE.Camera.layers} — host renders layer 0 then 1 into separate RTs. */
export const V3_TOKEN_LAYER_BELOW_DECK = 0;
export const V3_TOKEN_LAYER_ON_DECK = 1;

/**
 * @param {any} canvas
 * @param {any} tokenDoc
 */
function gridMetrics(canvas, tokenDoc) {
  const grid = canvas?.grid;
  const gridSizeX =
    grid && typeof grid.sizeX === "number" && grid.sizeX > 0
      ? grid.sizeX
      : grid && typeof grid.size === "number" && grid.size > 0
        ? grid.size
        : 100;
  const gridSizeY =
    grid && typeof grid.sizeY === "number" && grid.sizeY > 0
      ? grid.sizeY
      : grid && typeof grid.size === "number" && grid.size > 0
        ? grid.size
        : 100;
  const scaleX = tokenDoc.texture?.scaleX ?? 1;
  const scaleY = tokenDoc.texture?.scaleY ?? 1;
  const rectW = tokenDoc.width * gridSizeX;
  const rectH = tokenDoc.height * gridSizeY;
  const widthPx = rectW * scaleX;
  const heightPx = rectH * scaleY;
  const centerWx = tokenDoc.x + rectW / 2;
  const centerWy = tokenDoc.y + rectH / 2;
  return { widthPx, heightPx, centerWx, centerWy };
}

/**
 * @param {any} tokenDoc
 * @param {any} scene
 * @returns {boolean}
 */
/**
 * @param {any} scene
 * @param {any} tokenDoc
 * @returns {number} Index into `scene.levels.sorted`, or 0 if unscoped / unknown.
 */
function tokenSortedLevelIndex(scene, tokenDoc) {
  const sorted = scene?.levels?.sorted;
  if (!Array.isArray(sorted) || sorted.length === 0) return 0;
  const tl = tokenDoc?.level;
  if (typeof tl !== "string") return 0;
  const idOf = (s) => s?.id ?? s?._id ?? s?.document?.id ?? null;
  const i = sorted.findIndex((s) => idOf(s) === tl);
  return i >= 0 ? i : 0;
}

function tokenIncludedForViewedLevel(tokenDoc, scene) {
  try {
    const sorted = scene?.levels?.sorted;
    if (!Array.isArray(sorted) || sorted.length < 2) return true;
    const vIdx = getViewedLevelIndex(scene);
    const activeLevel = sorted[vIdx];
    const activeId = activeLevel?.id;
    if (typeof activeId !== "string") return true;
    const tl = tokenDoc?.level;
    if (typeof tl === "string" && tl !== activeId) {
      if (typeof tokenDoc.includedInLevel === "function") {
        return !!tokenDoc.includedInLevel(activeId);
      }
      return false;
    }
  } catch (_) {}
  return true;
}

export class V3TokenOverlay {
  /**
   * @param {{ log?: Function, warn?: Function }} [opts]
   */
  constructor({ warn = () => {} } = {}) {
    this._warn = warn;
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {any} */
    this._canvas = null;
    /** @type {THREE.TextureLoader} */
    this._loader = new THREE.TextureLoader();
    /** @type {Map<string, { sprite: THREE.Sprite, tokenDoc: any, removed?: boolean }>} */
    this._byId = new Map();
    /** @type {Array<[string, number]>} */
    this._hookIds = [];
  }

  /**
   * @param {THREE.Scene} scene
   * @param {any} canvas Foundry canvas
   */
  attach(scene, canvas) {
    this.dispose();
    this._scene = scene;
    this._canvas = canvas;
    this._installHooks();
    this.syncAllFromScene();
  }

  dispose() {
    this._removeHooks();
    for (const id of [...this._byId.keys()]) {
      this._removeEntry(id);
    }
    this._scene = null;
    this._canvas = null;
  }

  /** @returns {{ count: number }} */
  diag() {
    return { count: this._byId.size };
  }

  syncAllFromScene() {
    const canvas = this._canvas;
    const scene = canvas?.scene;
    if (!scene?.tokens) return;
    try {
      const tokens = scene.tokens;
      if (tokens && typeof tokens.forEach === "function") {
        tokens.forEach((/** @type {any} */ doc) => {
          this._ensureSprite(doc);
        });
      }
    } catch (err) {
      this._warn("V3TokenOverlay.syncAllFromScene failed", err);
    }
  }

  /**
   * @param {any} canvas
   * @param {THREE.WebGLRenderer|null} renderer
   * @param {{ pivotWorld: [number, number], invScale: number, sceneRect: [number, number, number, number] }|null} [viewPayload]
   *   When passed from {@link V3ThreeSceneHost} (after `_syncViewportUniforms`), avoids a
   *   second `buildV3ViewUniformPayload` allocation for the same frame.
   */
  frameUpdate(canvas, renderer, viewPayload = null) {
    if (!this._scene || !canvas) return;
    const { w, h } = getV3BoardPixelSize(canvas, renderer);
    const view = viewPayload ?? buildV3ViewUniformPayload(canvas);
    if (!view || w < 1 || h < 1) return;
    const pivotX = view.pivotWorld[0];
    const pivotY = view.pivotWorld[1];
    const zoom = 1 / Math.max(1e-6, view.invScale);

    const scene = canvas?.scene;
    const sorted = scene?.levels?.sorted;
    const viewIdx = getViewedLevelIndex(scene);
    const multiFloor = Array.isArray(sorted) && sorted.length >= 2;

    for (const { sprite, tokenDoc } of this._byId.values()) {
      if (!sprite || !tokenDoc) continue;
      this._applyVisibility(sprite, tokenDoc);
      if (!sprite.visible) continue;

      const tIdx = tokenSortedLevelIndex(scene, tokenDoc);
      if (multiFloor && tIdx < viewIdx) {
        sprite.layers.set(V3_TOKEN_LAYER_BELOW_DECK);
      } else {
        sprite.layers.set(V3_TOKEN_LAYER_ON_DECK);
      }

      const { widthPx, heightPx, centerWx, centerWy } = gridMetrics(canvas, tokenDoc);
      const cx = w * 0.5 + (centerWx - pivotX) * zoom;
      const cy = h * 0.5 + (centerWy - pivotY) * zoom;
      const ndcX = (cx / w) * 2 - 1;
      const ndcY = 1 - (cy / h) * 2;
      sprite.position.set(ndcX, ndcY, 0.05);

      const sw = (widthPx * zoom / w) * 2;
      const sh = (heightPx * zoom / h) * 2;
      sprite.scale.set(sw, sh, 1);

      const rot = THREE.MathUtils.degToRad(Number(tokenDoc.rotation) || 0);
      if (sprite.material) sprite.material.rotation = rot;

      const sort = Number(tokenDoc.sort);
      sprite.renderOrder =
        25 + (Number.isFinite(sort) ? sort * 1e-6 : 0);
    }
  }

  _installHooks() {
    this._removeHooks();
    const push = (name, id) => {
      this._hookIds.push([name, id]);
    };
    try {
      push(
        "createToken",
        Hooks.on("createToken", (doc, _opts, _userId) => {
          const d = doc?.document ?? doc;
          if (d?.parent === this._canvas?.scene) this._ensureSprite(d);
        }),
      );
      push(
        "updateToken",
        Hooks.on("updateToken", (doc, changes, options) => {
          const d = doc?.document ?? doc;
          if (d?.parent !== this._canvas?.scene) return;
          this._onUpdateToken(d, changes, options);
        }),
      );
      push(
        "deleteToken",
        Hooks.on("deleteToken", (doc) => {
          const d = doc?.document ?? doc;
          const id = d?.id;
          if (id) this._removeEntry(id);
        }),
      );
      push(
        "refreshToken",
        Hooks.on("refreshToken", (token) => {
          const d = token?.document;
          if (!d || d.parent !== this._canvas?.scene) return;
          const ent = this._byId.get(d.id);
          if (!ent?.sprite) return;
          this._applyVisibility(ent.sprite, d);
        }),
      );
    } catch (err) {
      this._warn("V3TokenOverlay hook install failed", err);
    }
  }

  _removeHooks() {
    for (const [name, id] of this._hookIds) {
      try {
        Hooks.off(name, id);
      } catch (_) {}
    }
    this._hookIds.length = 0;
  }

  /**
   * @param {any} tokenDoc
   */
  _ensureSprite(tokenDoc) {
    if (!this._scene || !tokenDoc?.id) return;
    const id = tokenDoc.id;
    if (this._byId.has(id)) {
      const ent = this._byId.get(id);
      if (ent) ent.tokenDoc = tokenDoc;
      return;
    }

    const src = tokenDoc.texture?.src;
    if (!src) return;

    const material = new THREE.SpriteMaterial({
      transparent: true,
      alphaTest: 0.05,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
      opacity: 0,
    });
    const sprite = new THREE.Sprite(material);
    sprite.frustumCulled = false;
    sprite.userData = { v3TokenId: id };

    this._byId.set(id, { sprite, tokenDoc, removed: false });
    this._scene.add(sprite);

    this._loader.load(
      src,
      (tex) => {
        const ent = this._byId.get(id);
        if (!ent || ent.removed || !ent.sprite?.material) return;
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.needsUpdate = true;
        ent.sprite.material.map = tex;
        ent.sprite.material.opacity = 1;
        ent.sprite.material.needsUpdate = true;
        this._applyVisibility(ent.sprite, ent.tokenDoc);
      },
      undefined,
      (err) => {
        this._warn(`V3TokenOverlay texture load failed: ${src}`, err);
      },
    );
  }

  /**
   * @param {any} tokenDoc
   * @param {object} changes
   * @param {object} [_options]
   */
  _onUpdateToken(tokenDoc, changes, _options) {
    const id = tokenDoc.id;
    const ent = this._byId.get(id);
    if (!ent) {
      this._ensureSprite(tokenDoc);
      return;
    }
    ent.tokenDoc = tokenDoc;

    if ("texture" in changes && changes.texture?.src) {
      const nextSrc = changes.texture.src;
      const oldMap = ent.sprite.material?.map;
      ent.sprite.material.map = null;
      if (oldMap) {
        try {
          oldMap.dispose();
        } catch (_) {}
      }
      ent.sprite.material.opacity = 0;
      ent.sprite.material.needsUpdate = true;
      this._loader.load(
        nextSrc,
        (tex) => {
          const e = this._byId.get(id);
          if (!e || e.removed || !e.sprite?.material) return;
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          e.sprite.material.map = tex;
          e.sprite.material.opacity = 1;
          e.sprite.material.needsUpdate = true;
          this._applyVisibility(e.sprite, e.tokenDoc);
        },
        undefined,
        (err) => {
          this._warn(`V3TokenOverlay texture reload failed: ${nextSrc}`, err);
        },
      );
    }
  }

  /**
   * @param {string} id
   */
  _removeEntry(id) {
    const ent = this._byId.get(id);
    if (!ent) return;
    ent.removed = true;
    const { sprite } = ent;
    this._byId.delete(id);
    try {
      this._scene?.remove(sprite);
    } catch (_) {}
    const mat = sprite?.material;
    if (mat) {
      if (mat.map) {
        try {
          mat.map.dispose();
        } catch (_) {}
      }
      try {
        mat.dispose();
      } catch (_) {}
    }
  }

  /**
   * @param {THREE.Sprite} sprite
   * @param {any} tokenDoc
   */
  _applyVisibility(sprite, tokenDoc) {
    const mat = sprite?.material;
    if (!mat) return;

    const scene = this._canvas?.scene;
    if (!tokenIncludedForViewedLevel(tokenDoc, scene)) {
      sprite.visible = false;
      return;
    }

    const isGm = !!game?.user?.isGM;
    if (tokenDoc.hidden) {
      sprite.visible = isGm;
      if (mat.map) mat.opacity = isGm ? 0.5 : 0;
    } else {
      sprite.visible = true;
      if (mat.map) mat.opacity = 1;
    }

    try {
      const placeable = this._canvas?.tokens?.get?.(tokenDoc.id);
      if (placeable && placeable.visible === false) {
        sprite.visible = false;
      }
    } catch (_) {}
  }
}
