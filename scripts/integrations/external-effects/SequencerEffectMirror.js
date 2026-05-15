/**
 * @fileoverview SequencerEffectMirror — per-effect Three.js mesh that mirrors
 * a Sequencer `CanvasEffect` (PIXI container) into MSA's FloorRenderBus.
 *
 * Texture acquisition strategy:
 *   1. **Video** (`HTMLVideoElement`): wrap with `THREE.VideoTexture` —
 *      zero-copy, the browser handles GPU upload from the same video element
 *      Sequencer already plays.
 *   2. **Static image** (`HTMLImageElement`/`HTMLCanvasElement`): wrap with
 *      `THREE.Texture` (set `needsUpdate=true` once on attach).
 *   3. **Spritesheet animated**: read current frame from PIXI's
 *      `AnimatedSpriteMesh` and update the mesh material's UV repeat/offset
 *      each tick.
 *
 * Transform sync uses the PIXI container's world transform converted to
 * MSA Three.js coordinates (Foundry top-left → MSA bottom-left).
 *
 * The original PIXI container is set to `renderable = false` so it draws
 * nowhere else. Sequencer's own `EffectManager` lifecycle is untouched.
 *
 * @module integrations/external-effects/SequencerEffectMirror
 */

import { createLogger } from '../../core/log.js';
import { externalEffectOrder } from '../../compositor-v2/LayerOrderPolicy.js';

const log = createLogger('SequencerEffectMirror');

/**
 * Default sortLayer used when an effect does not declare one.
 * Matches Sequencer 4.x default (above tokens).
 */
const DEFAULT_SORT_LAYER = 800;

export class SequencerEffectMirror {
  /**
   * @param {{
   *   effect: any,
   *   floorRenderBus: any,
   *   sceneComposer: any,
   *   floorStack: any,
   * }} refs
   */
  constructor(refs) {
    /** @type {any} */
    this._effect = refs.effect;
    /** @type {any} */
    this._floorRenderBus = refs.floorRenderBus;
    /** @type {any} */
    this._sceneComposer = refs.sceneComposer;
    /** @type {any} */
    this._floorStack = refs.floorStack;

    /** @type {any|null} */
    this.mesh = null;

    /** @type {any|null} */
    this._geometry = null;

    /** @type {any|null} */
    this._material = null;

    /** @type {any|null} */
    this._texture = null;

    /** @type {'video'|'image'|'spritesheet'|null} */
    this._textureKind = null;

    /** @type {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|null} */
    this._mediaSource = null;

    /** @type {any|null} */
    this._originalRenderable = null;

    /** @type {any|null} The PIXI container whose .renderable we toggled. */
    this._suppressedContainer = null;

    /** @type {{ width: number, height: number }} */
    this._naturalSize = { width: 1, height: 1 };

    /** @type {boolean} */
    this._attached = false;

    /** @type {boolean} */
    this._disposed = false;
  }

  /**
   * Attach the mirror: build geometry/material/texture, append to the
   * FloorRenderBus scene, hide the PIXI container. Returns false if
   * required resources are missing (in which case the caller should drop
   * the mirror entirely).
   * @returns {boolean}
   */
  attach() {
    if (this._attached || this._disposed) return this._attached;

    const THREE = window.THREE;
    const scene = this._floorRenderBus?._scene ?? null;
    if (!THREE || !scene) {
      log.warn('attach: THREE or FloorRenderBus scene unavailable');
      return false;
    }

    const acquired = this._acquireTexture(THREE);
    if (!acquired) {
      // Mirror would render an empty quad; better to leave the PIXI effect
      // visible (today it is hidden by MSA's primary suppression, but at
      // least we will not contribute a broken mesh).
      return false;
    }

    // Plane geometry sized to 1×1 — we scale via mesh.scale to the natural
    // texture size × Sequencer scale.
    this._geometry = new THREE.PlaneGeometry(1, 1);

    this._material = new THREE.MeshBasicMaterial({
      map: this._texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Use NormalBlending; Sequencer .webm/.webp assets are straight-alpha
      // when sampled by THREE.VideoTexture / THREE.Texture from HTML media.
      blending: THREE.NormalBlending,
    });

    this.mesh = new THREE.Mesh(this._geometry, this._material);
    this.mesh.name = `SequencerMirror:${this._effect?.id ?? '?'}`;
    this.mesh.frustumCulled = false;

    // Initial transform + order — refreshed on every PIXI tick.
    this.syncFromPixi();
    this.refreshOrder();

    scene.add(this.mesh);
    this._suppressPixiContainer();
    this._attached = true;
    return true;
  }

  /**
   * Recompute renderOrder from current effect.sortLayer / elevation. Called
   * on `updateSequencerEffect` and indirectly from `syncFromPixi`.
   */
  refreshOrder() {
    if (!this.mesh || this._disposed) return;
    const floorIndex = this._resolveFloorIndex();
    const sortLayer = this._resolveSortLayer();
    const sort = this._resolveSortTiebreaker();
    this.mesh.renderOrder = externalEffectOrder(floorIndex, sortLayer, sort);
  }

  /**
   * Sync transform (position/rotation/scale/opacity/tint) from the PIXI
   * CanvasEffect to the mirror mesh.
   */
  syncFromPixi() {
    if (!this.mesh || this._disposed) return;

    const effect = this._effect;
    if (!effect) return;

    const sceneH = globalThis.canvas?.dimensions?.height;
    if (!Number.isFinite(Number(sceneH))) return;

    // Position: prefer effect's world position (`effect.position` is set by
    // Sequencer each tick during update). Fall back to PIXI container `x/y`.
    let fx = Number.NaN;
    let fy = Number.NaN;
    try {
      const p = effect.position ?? null;
      if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
        fx = Number(p.x);
        fy = Number(p.y);
      }
    } catch (_) {}
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
      try {
        const c = effect; // CanvasEffect extends PIXI.Container
        if (Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y))) {
          fx = Number(c.x);
          fy = Number(c.y);
        }
      } catch (_) {}
    }
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
      try {
        const c = effect?.spriteContainer ?? effect?.rotationContainer ?? null;
        if (c && Number.isFinite(Number(c.x)) && Number.isFinite(Number(c.y))) {
          fx = Number(c.x);
          fy = Number(c.y);
        }
      } catch (_) {}
    }
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return;

    // Convert Foundry top-left → MSA bottom-left (Y flip).
    this.mesh.position.x = fx;
    this.mesh.position.y = Number(sceneH) - fy;

    // Z is decided by renderOrder; depthTest is off. Place at a stable Z near
    // the floor band so future depth-aware effects can sample plausibly.
    const groundZ = Number(this._sceneComposer?.groundZ);
    const baseZ = Number.isFinite(groundZ) ? groundZ : 1000;
    const floorIdx = this._resolveFloorIndex();
    const elevation = this._resolveElevation();
    this.mesh.position.z = baseZ + floorIdx + (Number.isFinite(elevation) ? elevation / 100 : 0);

    // Rotation: Sequencer uses radians on the rotation container.
    let rotation = 0;
    try {
      const c = effect;
      if (c.rotationContainer && Number.isFinite(Number(c.rotationContainer.rotation))) {
        rotation = Number(c.rotationContainer.rotation);
      } else if (Number.isFinite(Number(c.rotation))) {
        rotation = Number(c.rotation);
      }
    } catch (_) {}
    // Three Y is flipped relative to Foundry Y; rotation must be negated.
    this.mesh.rotation.z = -rotation;

    // Scale: derive a final world-space size from natural media dimensions
    // and the Sequencer container scale.
    const scaleX = this._readContainerScaleX();
    const scaleY = this._readContainerScaleY();
    const w = this._naturalSize.width * scaleX;
    const h = this._naturalSize.height * scaleY;
    this.mesh.scale.x = w;
    this.mesh.scale.y = h;
    this.mesh.scale.z = 1;

    // Opacity / tint
    let alpha = 1;
    try {
      const c = effect;
      if (Number.isFinite(Number(c.alpha))) alpha = Number(c.alpha);
    } catch (_) {}
    this._material.opacity = Math.max(0, Math.min(1, alpha));

    // For spritesheets, advance UV from the animated frame index.
    if (this._textureKind === 'spritesheet') {
      this._refreshSpritesheetUv();
    }

    // Refresh order in case elevation/sortLayer changed since attach.
    this.refreshOrder();
  }

  /**
   * Dispose mesh + texture, restore PIXI container visibility.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    if (this.mesh) {
      try {
        const parent = this.mesh.parent;
        if (parent && typeof parent.remove === 'function') {
          parent.remove(this.mesh);
        }
      } catch (_) {}
    }
    try { this._material?.dispose?.(); } catch (_) {}
    try { this._geometry?.dispose?.(); } catch (_) {}
    // We do NOT dispose the texture if it wraps a shared HTMLMediaElement
    // owned by Sequencer's own PIXI texture pool — the browser cleans up the
    // underlying GL texture when the THREE.Texture is GC'd.
    try {
      if (this._texture && this._textureKind !== 'video') {
        this._texture.dispose?.();
      }
    } catch (_) {}

    this.mesh = null;
    this._material = null;
    this._geometry = null;
    this._texture = null;
    this._mediaSource = null;

    this._restorePixiContainer();
  }

  // ── Internal: texture acquisition ──────────────────────────────────────────

  /**
   * Try to acquire a Three.js texture wrapping Sequencer's underlying media.
   * Returns true on success; false if no usable source was found.
   * @param {any} THREE
   * @returns {boolean}
   */
  _acquireTexture(THREE) {
    const effect = this._effect;
    if (!effect) return false;

    // Probe order: VideoSprite/AnimatedSprite/TilingSprite via sprite mesh.
    const sprite = this._resolveSprite();
    if (!sprite) return false;

    // 1) VideoTexture path — look for an HTMLVideoElement in the texture
    //    resource graph. PIXI v8 nests it at sprite.texture.source.resource.
    const video = this._extractVideoElement(sprite);
    if (video instanceof HTMLVideoElement) {
      try {
        const tex = new THREE.VideoTexture(video);
        tex.colorSpace = THREE.SRGBColorSpace ?? tex.colorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.flipY = true;
        this._texture = tex;
        this._textureKind = 'video';
        this._mediaSource = video;
        this._naturalSize.width = Math.max(1, video.videoWidth || sprite.width || 1);
        this._naturalSize.height = Math.max(1, video.videoHeight || sprite.height || 1);
        return true;
      } catch (e) {
        log.warn('VideoTexture creation failed:', e);
      }
    }

    // 2) Animated spritesheet path — AnimatedSpriteMesh exposes `.textures`
    //    or PIXI internally cycles via frame. We capture the base image and
    //    drive UV transform from `_currentFrame` each tick.
    const sheetSource = this._extractSpritesheetImage(sprite);
    if (sheetSource) {
      try {
        const tex = new THREE.Texture(sheetSource);
        tex.colorSpace = THREE.SRGBColorSpace ?? tex.colorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.flipY = true;
        tex.needsUpdate = true;
        this._texture = tex;
        this._textureKind = 'spritesheet';
        this._mediaSource = sheetSource;
        // For spritesheets, natural size = single frame dimensions; we read
        // these from the first frame's bounding rect when available.
        const dims = this._extractSpritesheetFrameSize(sprite);
        this._naturalSize.width = Math.max(1, dims.width);
        this._naturalSize.height = Math.max(1, dims.height);
        return true;
      } catch (e) {
        log.warn('Spritesheet Texture creation failed:', e);
      }
    }

    // 3) Static image path — extract the underlying HTMLImageElement /
    //    HTMLCanvasElement.
    const img = this._extractStaticImage(sprite);
    if (img) {
      try {
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace ?? tex.colorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.flipY = true;
        tex.needsUpdate = true;
        this._texture = tex;
        this._textureKind = 'image';
        this._mediaSource = img;
        this._naturalSize.width = Math.max(1, img.naturalWidth || img.width || sprite.width || 1);
        this._naturalSize.height = Math.max(1, img.naturalHeight || img.height || sprite.height || 1);
        return true;
      } catch (e) {
        log.warn('Static Texture creation failed:', e);
      }
    }

    log.debug('No usable media source for effect', this._effect?.id);
    return false;
  }

  _resolveSprite() {
    const e = this._effect;
    if (!e) return null;
    // CanvasEffect manages a SequencerSpriteManager; the rendered mesh may be
    // exposed as `sprite`, `spriteMesh`, or via the manager.
    if (e.sprite) return e.sprite;
    if (e.spriteMesh) return e.spriteMesh;
    try {
      const sm = e.spriteManager ?? e._spriteManager ?? null;
      if (sm) {
        if (sm.sprite) return sm.sprite;
        if (sm.mesh) return sm.mesh;
        if (Array.isArray(sm.meshes) && sm.meshes.length) return sm.meshes[0];
      }
    } catch (_) {}
    try {
      const fromContainer = this._findFirstTexturedDisplayObject(e.spriteContainer);
      if (fromContainer) return fromContainer;
    } catch (_) {}
    try {
      const fromRotation = this._findFirstTexturedDisplayObject(e.rotationContainer);
      if (fromRotation) return fromRotation;
    } catch (_) {}
    try {
      const fromRoot = this._findFirstTexturedDisplayObject(e);
      if (fromRoot) return fromRoot;
    } catch (_) {}
    return null;
  }

  _findFirstTexturedDisplayObject(root) {
    if (!root || typeof root !== 'object') return null;
    const stack = [root];
    const seen = new Set();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (node.texture && typeof node.texture === 'object') return node;
      const children = Array.isArray(node.children) ? node.children : null;
      if (children) {
        for (let i = 0; i < children.length; i++) stack.push(children[i]);
      }
    }
    return null;
  }

  _extractVideoElement(sprite) {
    try {
      const tex = sprite?.texture ?? null;
      if (!tex) return null;
      // PIXI v8: tex.source.resource is the HTMLVideoElement; PIXI v7: tex.baseTexture.resource.source.
      const src = tex.source ?? tex.baseTexture ?? null;
      const resource = src?.resource ?? null;
      if (resource instanceof HTMLVideoElement) return resource;
      if (resource?.source instanceof HTMLVideoElement) return resource.source;
      if (resource?.source?.source instanceof HTMLVideoElement) return resource.source.source;
      if (resource?.source?.element instanceof HTMLVideoElement) return resource.source.element;
      if (resource?.element instanceof HTMLVideoElement) return resource.element;
      if (resource?.video instanceof HTMLVideoElement) return resource.video;
      if (tex?.source?.resource?.source instanceof HTMLVideoElement) return tex.source.resource.source;
      if (src?.source instanceof HTMLVideoElement) return src.source;
    } catch (_) {}
    return null;
  }

  _extractStaticImage(sprite) {
    try {
      const tex = sprite?.texture ?? null;
      if (!tex) return null;
      const src = tex.source ?? tex.baseTexture ?? null;
      const resource = src?.resource ?? null;
      if (resource instanceof HTMLImageElement) return resource;
      if (resource instanceof HTMLCanvasElement) return resource;
      if (resource instanceof ImageBitmap) return resource;
      if (resource?.source instanceof HTMLImageElement) return resource.source;
      if (resource?.source instanceof HTMLCanvasElement) return resource.source;
      if (resource?.source instanceof ImageBitmap) return resource.source;
      if (resource?.source?.source instanceof HTMLImageElement) return resource.source.source;
      if (resource?.source?.source instanceof HTMLCanvasElement) return resource.source.source;
      if (resource?.bitmap instanceof ImageBitmap) return resource.bitmap;
    } catch (_) {}
    return null;
  }

  _extractSpritesheetImage(sprite) {
    try {
      // AnimatedSpriteMesh / spritesheet sprites tend to share a single base
      // image; the active frame is selected via texture.frame/orig rect.
      if (sprite?.textures && Array.isArray(sprite.textures) && sprite.textures.length) {
        const first = sprite.textures[0];
        const src = first?.source ?? first?.baseTexture ?? null;
        const resource = src?.resource ?? null;
        if (resource instanceof HTMLImageElement) return resource;
        if (resource instanceof HTMLCanvasElement) return resource;
        if (resource instanceof ImageBitmap) return resource;
        if (resource?.source instanceof HTMLImageElement) return resource.source;
        if (resource?.source instanceof HTMLCanvasElement) return resource.source;
        if (resource?.source instanceof ImageBitmap) return resource.source;
        if (resource?.source?.source instanceof HTMLImageElement) return resource.source.source;
        if (resource?.source?.source instanceof HTMLCanvasElement) return resource.source.source;
      }
    } catch (_) {}
    return null;
  }

  _extractSpritesheetFrameSize(sprite) {
    try {
      const tex = sprite?.textures?.[0] ?? sprite?.texture ?? null;
      const orig = tex?.orig ?? tex?.frame ?? null;
      if (orig && Number.isFinite(Number(orig.width)) && Number.isFinite(Number(orig.height))) {
        return { width: Number(orig.width), height: Number(orig.height) };
      }
      if (Number.isFinite(Number(sprite?.width)) && Number.isFinite(Number(sprite?.height))) {
        return { width: Number(sprite.width), height: Number(sprite.height) };
      }
    } catch (_) {}
    return { width: 1, height: 1 };
  }

  /**
   * Refresh UV repeat/offset on the mesh material's map so the visible region
   * matches the spritesheet's current frame. Operates on `this._texture`.
   */
  _refreshSpritesheetUv() {
    if (!this._texture || !this._mediaSource) return;
    const sprite = this._resolveSprite();
    if (!sprite) return;
    try {
      const frameIdx = Number(sprite.currentFrame ?? sprite._currentFrame ?? 0);
      const textures = Array.isArray(sprite.textures) ? sprite.textures : null;
      const tex = textures ? textures[Math.max(0, Math.min(textures.length - 1, frameIdx | 0))] : sprite.texture;
      const frame = tex?.frame ?? null;
      const w = Number(this._mediaSource?.naturalWidth ?? this._mediaSource?.width ?? 1);
      const h = Number(this._mediaSource?.naturalHeight ?? this._mediaSource?.height ?? 1);
      if (!frame || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
      const fx = Number(frame.x ?? 0);
      const fy = Number(frame.y ?? 0);
      const fw = Number(frame.width ?? 0);
      const fh = Number(frame.height ?? 0);
      const map = this._texture;
      map.repeat.set(fw / w, fh / h);
      // Three V flip: y origin at bottom; flipY=true.
      map.offset.set(fx / w, 1 - (fy + fh) / h);
      map.needsUpdate = true;
    } catch (_) {}
  }

  // ── Internal: PIXI container suppression ───────────────────────────────────

  _suppressPixiContainer() {
    try {
      const e = this._effect;
      // Prefer the spriteContainer (just hides the visible mesh, leaves filters /
      // void proxies functioning).
      const c = e?.spriteContainer ?? e?.rotationContainer ?? e ?? null;
      if (!c || typeof c !== 'object') return;
      this._originalRenderable = (typeof c.renderable === 'boolean') ? c.renderable : true;
      this._suppressedContainer = c;
      c.renderable = false;
    } catch (e) {
      log.warn('_suppressPixiContainer failed:', e);
    }
  }

  _restorePixiContainer() {
    try {
      const c = this._suppressedContainer;
      if (c && typeof c === 'object' && this._originalRenderable != null) {
        c.renderable = this._originalRenderable;
      }
    } catch (_) {}
    this._suppressedContainer = null;
    this._originalRenderable = null;
  }

  // ── Internal: container property helpers ───────────────────────────────────

  _readContainerScaleX() {
    try {
      const c = this._effect;
      const sc = c?.spriteContainer?.scale ?? c?.scale ?? null;
      if (sc && Number.isFinite(Number(sc.x))) return Number(sc.x);
    } catch (_) {}
    return 1;
  }

  _readContainerScaleY() {
    try {
      const c = this._effect;
      const sc = c?.spriteContainer?.scale ?? c?.scale ?? null;
      if (sc && Number.isFinite(Number(sc.y))) return Number(sc.y);
    } catch (_) {}
    return 1;
  }

  _resolveSortLayer() {
    const e = this._effect;
    try {
      const s = Number(e?.data?.sortLayer ?? e?.sortLayer);
      if (Number.isFinite(s)) return s;
    } catch (_) {}
    return DEFAULT_SORT_LAYER;
  }

  _resolveSortTiebreaker() {
    const e = this._effect;
    try {
      const z = Number(e?.zIndex ?? e?.data?.zIndex);
      if (Number.isFinite(z)) return z;
    } catch (_) {}
    try {
      const s = Number(e?.sort);
      if (Number.isFinite(s)) return s;
    } catch (_) {}
    return 0;
  }

  _resolveElevation() {
    const e = this._effect;
    try {
      const ev = Number(e?.elevation ?? e?.data?.elevation);
      if (Number.isFinite(ev)) return ev;
    } catch (_) {}
    return 0;
  }

  _resolveFloorIndex() {
    // Map effect.elevation to FloorStack band index; fall back to active floor.
    const elev = this._resolveElevation();
    const fs = this._floorStack;
    try {
      const floors = fs?.getFloors?.() ?? [];
      for (const f of floors) {
        const min = Number(f?.elevationMin);
        const max = Number(f?.elevationMax);
        if (Number.isFinite(min) && Number.isFinite(max) && elev >= min && elev < max) {
          const idx = Number(f?.index);
          if (Number.isFinite(idx)) return idx;
        }
      }
      const active = fs?.getActiveFloor?.();
      const aIdx = Number(active?.index);
      if (Number.isFinite(aIdx)) return aIdx;
    } catch (_) {}
    return 0;
  }
}
