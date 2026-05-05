import * as THREE from "../vendor/three.module.js";
import {
  buildV3ViewUniformPayload,
  getV3BoardPixelSize,
} from "./V3FoundryCanvasIntegration.js";
import { getViewedLevelIndex } from "./V3ViewedLevel.js";
import {
  V3_TOKEN_LAYER_BELOW_DECK,
  V3_TOKEN_LAYER_ON_DECK,
} from "./V3TokenOverlay.js";

/**
 * @param {any} scene
 * @param {any} drawingDoc
 * @returns {number}
 */
function drawingSortedLevelIndex(scene, drawingDoc) {
  const sorted = scene?.levels?.sorted;
  if (!Array.isArray(sorted) || sorted.length === 0) return 0;
  const levelId = drawingDoc?.level;
  if (typeof levelId !== "string") return 0;
  const idOf = (s) => s?.id ?? s?._id ?? s?.document?.id ?? null;
  const idx = sorted.findIndex((s) => idOf(s) === levelId);
  return idx >= 0 ? idx : 0;
}

/**
 * @param {any} drawingDoc
 * @param {any} scene
 * @returns {boolean}
 */
function drawingIncludedForViewedLevel(drawingDoc, scene) {
  try {
    const sorted = scene?.levels?.sorted;
    if (!Array.isArray(sorted) || sorted.length < 2) return true;
    const viewedIdx = getViewedLevelIndex(scene);
    const active = sorted[viewedIdx];
    const activeId = active?.id ?? active?.document?.id ?? null;
    if (!activeId) return true;
    const levelId = drawingDoc?.level;
    if (typeof levelId === "string" && levelId && levelId !== activeId) {
      if (typeof drawingDoc.includedInLevel === "function") {
        return !!drawingDoc.includedInLevel(activeId);
      }
      return false;
    }
  } catch (_) {}
  return true;
}

/**
 * @param {any} doc
 * @returns {{ width: number, height: number }}
 */
function drawingSizePx(doc) {
  const shape = doc?.shape ?? {};
  const w = Number(shape.width ?? doc?.width ?? 0);
  const h = Number(shape.height ?? doc?.height ?? 0);
  return {
    width: Math.max(1, Number.isFinite(w) ? w : 1),
    height: Math.max(1, Number.isFinite(h) ? h : 1),
  };
}

/**
 * Minimal drawing rasterizer for V3 deck compositing.
 * Prioritizes text drawings and basic rectangle outlines/fills.
 */
function rasterizeDrawingTexture(doc) {
  const { width, height } = drawingSizePx(doc);
  const res = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(2, Math.round(width * res));
  canvas.height = Math.max(2, Math.round(height * res));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const toCssColor = (v, fallback) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      return `#${Math.trunc(v).toString(16).padStart(6, "0")}`;
    }
    if (typeof v === "string" && v.trim()) return v.trim();
    return fallback;
  };

  const fillAlpha = Number(doc?.fillAlpha);
  const fillType = Number(doc?.fillType);
  if (fillType > 0 && Number.isFinite(fillAlpha) && fillAlpha > 0) {
    ctx.globalAlpha = Math.max(0, Math.min(1, fillAlpha));
    ctx.fillStyle = toCssColor(doc?.fillColor, "#000000");
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  const strokeWidth = Math.max(0, Number(doc?.strokeWidth) || 0);
  const strokeAlpha = Number(doc?.strokeAlpha);
  if (strokeWidth > 0) {
    ctx.globalAlpha = Number.isFinite(strokeAlpha) ? Math.max(0, Math.min(1, strokeAlpha)) : 1;
    ctx.strokeStyle = toCssColor(doc?.strokeColor ?? doc?.fillColor, "#ffffff");
    ctx.lineWidth = Math.max(1, strokeWidth * res);
    const inset = ctx.lineWidth * 0.5;
    ctx.strokeRect(inset, inset, Math.max(1, canvas.width - inset * 2), Math.max(1, canvas.height - inset * 2));
  }

  const text = String(doc?.text ?? "").trim();
  if (text.length > 0) {
    const fontSize = Math.max(8, Number(doc?.fontSize) || 48);
    const textAlpha = Number.isFinite(Number(doc?.textAlpha))
      ? Math.max(0, Math.min(1, Number(doc.textAlpha)))
      : 1;
    const fontFamily = String(doc?.fontFamily || globalThis.CONFIG?.defaultFontFamily || "Signika");
    ctx.globalAlpha = textAlpha;
    ctx.fillStyle = toCssColor(doc?.textColor, "#ffffff");
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = Math.max(2, Math.round((fontSize / 18) * res));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = `${Math.round(fontSize * res)}px ${fontFamily}`;
    const cx = canvas.width * 0.5;
    const cy = canvas.height * 0.5;
    ctx.strokeText(text, cx, cy, Math.max(1, canvas.width - 8 * res));
    ctx.fillText(text, cx, cy, Math.max(1, canvas.width - 8 * res));
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export class V3DrawingOverlay {
  /**
   * @param {{ warn?: Function }} [opts]
   */
  constructor({ warn = () => {} } = {}) {
    this._warn = warn;
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {any} */
    this._canvas = null;
    /** @type {Map<string, { sprite: THREE.Sprite, drawingDoc: any, removed?: boolean }>} */
    this._byId = new Map();
    /** @type {Array<[string, number]>} */
    this._hookIds = [];
  }

  attach(scene, canvas) {
    this.dispose();
    this._scene = scene;
    this._canvas = canvas;
    this._installHooks();
    this.syncAllFromScene();
  }

  /**
   * Move existing drawing sprites to a different render scene without rebuilding.
   * @param {THREE.Scene|null} scene
   */
  setScene(scene) {
    if (!scene || scene === this._scene) return;
    const prev = this._scene;
    this._scene = scene;
    for (const entry of this._byId.values()) {
      const sprite = entry?.sprite;
      if (!sprite) continue;
      try { prev?.remove(sprite); } catch (_) {}
      try { scene.add(sprite); } catch (_) {}
    }
  }

  dispose() {
    this._removeHooks();
    for (const id of [...this._byId.keys()]) this._removeEntry(id);
    this._scene = null;
    this._canvas = null;
  }

  /** @returns {{ count: number }} */
  diag() {
    return { count: this._byId.size };
  }

  syncAllFromScene() {
    const scene = this._canvas?.scene;
    const drawings = scene?.drawings;
    if (!drawings) return;
    try {
      if (typeof drawings.forEach === "function") {
        drawings.forEach((doc) => this._ensureSprite(doc));
      } else if (Array.isArray(drawings.contents)) {
        for (const doc of drawings.contents) this._ensureSprite(doc);
      }
    } catch (err) {
      this._warn("V3DrawingOverlay.syncAllFromScene failed", err);
    }
  }

  frameUpdate(canvas, renderer, viewPayload = null) {
    if (!this._scene || !canvas) return;
    const { w, h } = getV3BoardPixelSize(canvas, renderer);
    const view = viewPayload ?? buildV3ViewUniformPayload(canvas);
    if (!view || w < 1 || h < 1) return;

    const pivotX = view.pivotWorld[0];
    const pivotY = view.pivotWorld[1];
    const zoom = 1 / Math.max(1e-6, view.invScale);

    const scene = canvas.scene;
    const sorted = scene?.levels?.sorted;
    const viewIdx = getViewedLevelIndex(scene);
    const multiFloor = Array.isArray(sorted) && sorted.length >= 2;

    for (const { sprite, drawingDoc } of this._byId.values()) {
      if (!sprite || !drawingDoc) continue;
      this._applyVisibility(sprite, drawingDoc);
      if (!sprite.visible) continue;

      const dIdx = drawingSortedLevelIndex(scene, drawingDoc);
      if (multiFloor && dIdx < viewIdx) sprite.layers.set(V3_TOKEN_LAYER_BELOW_DECK);
      else sprite.layers.set(V3_TOKEN_LAYER_ON_DECK);

      const { width, height } = drawingSizePx(drawingDoc);
      const x = Number(drawingDoc?.x) || 0;
      const y = Number(drawingDoc?.y) || 0;
      const centerWx = x + width * 0.5;
      const centerWy = y + height * 0.5;

      const cx = w * 0.5 + (centerWx - pivotX) * zoom;
      const cy = h * 0.5 + (centerWy - pivotY) * zoom;
      const ndcX = (cx / w) * 2 - 1;
      const ndcY = 1 - (cy / h) * 2;
      sprite.position.set(ndcX, ndcY, 0.055);

      const sw = (width * zoom / w) * 2;
      const sh = (height * zoom / h) * 2;
      sprite.scale.set(sw, sh, 1);

      const rot = THREE.MathUtils.degToRad(-(Number(drawingDoc?.rotation) || 0));
      if (sprite.material) sprite.material.rotation = rot;
      sprite.renderOrder = 26 + (Number(drawingDoc?.sort) || 0) * 1e-6;
    }
  }

  _installHooks() {
    this._removeHooks();
    const push = (name, id) => this._hookIds.push([name, id]);
    try {
      push("createDrawing", Hooks.on("createDrawing", (doc) => {
        const d = doc?.document ?? doc;
        if (d?.parent === this._canvas?.scene) this._ensureSprite(d);
      }));
      push("updateDrawing", Hooks.on("updateDrawing", (doc) => {
        const d = doc?.document ?? doc;
        if (d?.parent !== this._canvas?.scene) return;
        this._refreshSprite(d);
      }));
      push("deleteDrawing", Hooks.on("deleteDrawing", (doc) => {
        const d = doc?.document ?? doc;
        const id = d?.id;
        if (id) this._removeEntry(id);
      }));
      push("canvasReady", Hooks.on("canvasReady", () => this.syncAllFromScene()));
    } catch (err) {
      this._warn("V3DrawingOverlay hook install failed", err);
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

  _ensureSprite(drawingDoc) {
    if (!this._scene || !drawingDoc?.id) return;
    const id = drawingDoc.id;
    if (this._byId.has(id)) {
      this._refreshSprite(drawingDoc);
      return;
    }
    const tex = rasterizeDrawingTexture(drawingDoc);
    if (!tex) return;
    const material = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      alphaTest: 0.01,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.frustumCulled = false;
    sprite.userData = { v3DrawingId: id };
    this._byId.set(id, { sprite, drawingDoc, removed: false });
    this._scene.add(sprite);
    this._applyVisibility(sprite, drawingDoc);
  }

  _refreshSprite(drawingDoc) {
    const id = drawingDoc?.id;
    if (!id) return;
    const entry = this._byId.get(id);
    if (!entry) {
      this._ensureSprite(drawingDoc);
      return;
    }
    entry.drawingDoc = drawingDoc;
    const next = rasterizeDrawingTexture(drawingDoc);
    if (!next) return;
    const mat = entry.sprite.material;
    if (mat?.map) {
      try {
        mat.map.dispose();
      } catch (_) {}
    }
    mat.map = next;
    mat.needsUpdate = true;
    this._applyVisibility(entry.sprite, drawingDoc);
  }

  _removeEntry(id) {
    const entry = this._byId.get(id);
    if (!entry) return;
    entry.removed = true;
    this._byId.delete(id);
    const { sprite } = entry;
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

  _applyVisibility(sprite, drawingDoc) {
    const scene = this._canvas?.scene;
    if (!drawingIncludedForViewedLevel(drawingDoc, scene)) {
      sprite.visible = false;
      return;
    }

    const isGm = !!game?.user?.isGM;
    if (drawingDoc?.hidden) {
      sprite.visible = isGm;
      if (sprite.material) sprite.material.opacity = isGm ? 0.5 : 0;
    } else {
      sprite.visible = true;
      if (sprite.material) sprite.material.opacity = 1;
    }

    try {
      const placeable = this._canvas?.drawings?.get?.(drawingDoc.id);
      if (placeable && placeable.visible === false) sprite.visible = false;
    } catch (_) {}
  }
}
