/**
 * @fileoverview SequencerEffectMirror — per-effect Three.js mesh that mirrors
 * a Sequencer `CanvasEffect` (PIXI container) into MSA's FloorRenderBus.
 *
 * Texture acquisition strategy:
 *   1. **Spritesheet / flipbook** (`AnimatedSpriteMesh` frame textures) — first,
 *      because Sequencer often promotes WebM to compiled frames while a stale
 *      pooled `HTMLVideoElement` may remain in the texture graph.
 *   2. **Static image** (`HTMLImageElement`/`HTMLCanvasElement`/`ImageBitmap`).
 *   3. **Video** (`HTMLVideoElement`): wrap with `THREE.VideoTexture` only when
 *      the element decodes (reject `media.error` / empty dead pool tags).
 *
 * Mesh **Z** sits on the V2 **tile** plane (`sceneComposer.groundZ` + floor ×
 * {@link Z_PER_FLOOR} + a small elevation fraction), i.e. the same depth band as
 * {@link FloorRenderBus} map tiles — **not** the token sprite band (~groundZ+1003),
 * which sits near/behind the perspective camera at z≈2000 and clips. Optional
 * `MapShine.__sequencerMirrorZBias` or Tweakpane **Z bias** nudges depth when needed.
 *
 * The original PIXI container is set to `renderable = false` so it draws
 * nowhere else. Sequencer's own `EffectManager` lifecycle is untouched.
 *
 * **Video alpha vs Sequencer / PIXI:** Sequencer wraps `PIXI.BaseImageResource
 * .prototype.upload` (`src/libwrapper.js`) when the client setting
 * `sequencer` / `enable-global-fix-pixi` is enabled: for `HTMLVideoElement`
 * sources it sets `baseTexture.alphaMode = PREMULTIPLIED_ALPHA` and
 * `baseTexture.sequencer_patched = true`. Foundry's `TilingSpriteMesh` also
 * carries `alphaMode` on the display object. We read those signals and pick
 * Three blend factors accordingly — Three's `VideoTexture` is a *second*
 * upload of the same element, so we must match PIXI's interpretation, not
 * assume every WebM is premultiplied.
 *
 * **Second WebGL upload:** Three's `VideoTexture` re-uploads the same
 * `<video>` element. That path is almost always **straight** RGBA
 * (`UNPACK_PREMULTIPLY_ALPHA_WEBGL` off). PIXI's `alphaMode` / Sequencer patch
 * describe how **PIXI** composites the sample, not necessarily the raw texels
 * Three reads. When we mirror PIXI's **premultiplied** blend factors
 * (`One × OneMinusSrcAlpha`) we must output **premultiplied** fragment colour
 * (`rgb *= a` for straight samples). Otherwise edges look harsh, fringed, or
 * “binary”. Override with `MapShine.__sequencerMirrorVideoGpuPremultiplied =
 * true` if a rare GPU path truly delivers premultiplied texels.
 *
 * @module integrations/external-effects/SequencerEffectMirror
 */

import { createLogger } from '../../core/log.js';
import { externalEffectOrder, GROUND_Z, Z_PER_FLOOR } from '../../compositor-v2/LayerOrderPolicy.js';

const log = createLogger('SequencerEffectMirror');
const MIN_EFFECT_WORLD_SIZE_FACTOR = 0.75;
const MIN_EFFECT_SOURCE_SIZE_FACTOR = 0.25;

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

    /** @type {'video'|'image'|'spritesheet'|'pixiCanvas'|null} */
    this._textureKind = null;

    /** @type {HTMLVideoElement|HTMLImageElement|HTMLCanvasElement|null} */
    this._mediaSource = null;

    /** @type {any|null} */
    this._originalRenderable = null;

    /** @type {any|null} PIXI node hidden for the mirror (prefer `managedSprite`). */
    this._suppressedContainer = null;

    /** @type {{ width: number, height: number }} */
    this._naturalSize = { width: 1, height: 1 };

    /** @type {boolean} */
    this._attached = false;

    /** @type {boolean} */
    this._disposed = false;

    /** @type {number} */
    this._lastVideoNudgeAt = 0;

    /** @type {number} */
    this._lastPixiCanvasFrame = -1;

    /** @type {Map<number, HTMLCanvasElement>} */
    this._pixiCanvasFrameCache = new Map();

    /** @type {number} */
    this._pixiCanvasFrameCacheMax = 160;

    /** @type {boolean} */
    this._pixiCanvasIncludesSpriteState = false;

    /** @type {'effectPosition'|'effectPositionPlusSpriteDelta'|null} */
    this._lastMirrorPositionBasis = null;
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

    this._material = this._createMaterial(THREE);

    this.mesh = new THREE.Mesh(this._geometry, this._material);
    this.mesh.name = `SequencerMirror:${this._effect?.id ?? '?'}`;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(0);
    this.mesh.userData = {
      ...(this.mesh.userData ?? {}),
      type: 'externalSequencerEffect',
      preserveOnBusClear: true,
      mapShineExternalEffect: true,
    };

    // Initial transform + order — refreshed on every PIXI tick.
    this.syncFromPixi();
    this.refreshOrder();

    scene.add(this.mesh);
    this._suppressPixiContainer();
    this._attached = true;
    return true;
  }

  /**
   * Ensure the mirror mesh remains attached to the current FloorRenderBus scene.
   * Bus repopulation can clear non-tile children; mirrors opt into preservation,
   * but this also repairs parentless meshes if they were removed before that flag
   * existed or if the bus scene instance changed.
   *
   * @param {any|null} floorRenderBus
   * @returns {boolean}
   */
  ensureAttached(floorRenderBus = null) {
    if (this._disposed || !this.mesh) return false;
    const bus = floorRenderBus ?? this._floorRenderBus;
    const scene = bus?._scene ?? null;
    if (!scene) return false;
    this._floorRenderBus = bus;
    if (this.mesh.parent !== scene) {
      try {
        if (this.mesh.parent?.remove) this.mesh.parent.remove(this.mesh);
      } catch (_) {}
      scene.add(this.mesh);
    }
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
   * Structured diagnostics for F12 debugging (black video, alpha, bus attach).
   * @param {boolean|{ deep?: boolean }} [opts] Pass `true` or `{ deep: true }` for DOM
   *   pixel sampling + WebGL/renderer hints (`probeSequencerMirrorsDeep`).
   * @returns {Record<string, unknown>}
   */
  getDebugSnapshot(opts) {
    const deep = opts === true || (!!opts && typeof opts === 'object' && opts.deep === true);

    const sprite = this._resolveSprite();
    const effect = this._effect;
    const mgr = effect?.sprite ?? null;
    const managed = mgr?.managedSprite ?? null;

    const snap = {
      effectId: effect?.id ?? null,
      textureKind: this._textureKind,
      attached: this._attached,
      disposed: this._disposed,
      naturalSize: { ...this._naturalSize },
      filePath: (() => {
        try { return this._resolveFilePath(); } catch (_) { return ''; }
      })(),
      pixiSuppressedRenderable: this._suppressedContainer?.renderable,
      canvasDimsHeight: Number(globalThis.canvas?.dimensions?.height),
    };

    try {
      const d = effect?.data ?? null;
      const rc = Number(effect?.rotationContainer?.rotation ?? effect?.rotation ?? 0);
      const mul = Number(globalThis.window?.MapShine?.__sequencerMirrorRotateTowardsForwardMul);
      const sign = Number(globalThis.window?.MapShine?.__sequencerMirrorRotateTowardsForwardSign);
      const sw = Number(sprite?.width);
      const spanW = Math.max(
        1,
        Number(this._naturalSize.width) * this._readContainerScaleX(),
        Number.isFinite(sw) && sw > 1 ? sw : 0,
      );
      snap.rotateTowardsAdjust = {
        active: !!(
          (d?.rotateTowards && !d.rotateTowards?.template && !d.anchor)
          || (() => {
            try {
              const src = effect?.sourcePosition;
              const tgt = effect?.targetPosition;
              if (!src || !tgt || !Number.isFinite(src.x) || !Number.isFinite(tgt.x)) return false;
              const len = Math.hypot(tgt.x - src.x, tgt.y - src.y);
              if (len <= 1e-2) return false;
              const px = Number(effect?.position?.x);
              const py = Number(effect?.position?.y);
              if (!Number.isFinite(px) || !Number.isFinite(py)) return false;
              const ds = Math.hypot(px - src.x, py - src.y);
              const dt = Math.hypot(px - tgt.x, py - tgt.y);
              return ds < dt * 1.15;
            } catch (_) {
              return false;
            }
          })()
        ),
        rotationContainerRad: Number.isFinite(rc) ? rc : null,
        spriteWidth: Number.isFinite(sw) ? sw : null,
        spanWUsed: spanW,
        forwardMulDefault: !Number.isFinite(mul) || mul <= 0 ? 1 : mul,
        forwardSignDefault: !Number.isFinite(sign) || sign === 0 ? 1 : sign,
      };
    } catch (_) {
      snap.rotateTowardsAdjust = null;
    }

    try {
      snap.mirrorPlacement = {
        lastBasis: this._lastMirrorPositionBasis,
        alongCastPlacementMul: this._resolveAlongCastPlacementMul(),
        externalDiffuseGain: this._resolveExternalDiffuseGain(),
        spriteRootDelta: this._resolveSpriteRootDeltaFromEffect(effect),
        sequencerCanvasXY: this._resolveSequencerCanvasWorldXY(effect),
        effectPosition: (() => {
          try {
            const p = effect?.position;
            if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
              return { x: Number(p.x), y: Number(p.y) };
            }
          } catch (_) {}
          return null;
        })(),
        mirrorFootprint: (() => {
          try {
            const px = this._resolveMirrorFootprintInScenePixels();
            const lg = this._resolveLegacyNaturalFootprint();
            return {
              footprintW: px.width,
              footprintH: px.height,
              legacyNaturalScaleW: lg.width,
              legacyNaturalScaleH: lg.height,
              naturalSize: { ...this._naturalSize },
              containerScale: { x: this._readContainerScaleX(), y: this._readContainerScaleY() },
              preferGetBounds: globalThis.window?.MapShine?.__sequencerMirrorScalePreferGetBounds !== false,
              meshScaleMul: this._resolveMirrorMeshScaleMul(),
              alongCastTargetNudgePx: this._resolveAlongCastTargetNudgePx(),
              meshWorldZ: this._resolveMirrorMeshWorldZ(),
            };
          } catch (_) {
            return null;
          }
        })(),
      };
    } catch (_) {
      snap.mirrorPlacement = null;
    }

    try {
      snap.sequencerPlayback = {
        hasAnimatedMedia: !!effect?.hasAnimatedMedia,
        spritePlaying: !!mgr?.playing,
        mediaCurrentTime: effect?.mediaCurrentTime ?? null,
      };
    } catch (_) {
      snap.sequencerPlayback = null;
    }

    try {
      snap.pixiRenderableChain = {
        effectRenderable: typeof effect?.renderable === 'boolean' ? effect.renderable : null,
        effectVisible: typeof effect?.visible === 'boolean' ? effect.visible : null,
        spriteRenderable: typeof mgr?.renderable === 'boolean' ? mgr.renderable : null,
        managedSpriteRenderable: typeof managed?.renderable === 'boolean' ? managed.renderable : null,
      };
    } catch (_) {
      snap.pixiRenderableChain = null;
    }

    try {
      const tex = sprite?.texture ?? null;
      const bt = tex?.baseTexture ?? tex?.source ?? null;
      snap.pixi = {
        spriteConstructor: sprite?.constructor?.name ?? null,
        blendMode: sprite?.blendMode ?? null,
        spriteAlphaMode: sprite?.alphaMode ?? null,
        textureAlphaMode: bt?.alphaMode ?? null,
        sequencer_patched: bt?.sequencer_patched ?? null,
        pixiTexWidthHeight: tex
          ? { w: tex.width ?? null, h: tex.height ?? null }
          : null,
        baseTexValidDestroyed: bt
          ? { valid: bt.valid ?? null, destroyed: bt.destroyed ?? null }
          : null,
      };
    } catch (e) {
      snap.pixi = { error: String(e?.message ?? e) };
    }

    try {
      snap.sequencerSettings = {
        enableGlobalPixiFix: globalThis.game?.settings?.get?.('sequencer', 'enable-global-fix-pixi'),
      };
    } catch (_) {
      snap.sequencerSettings = { error: 'unavailable' };
    }

    snap.videoInterpretPremultiplied = this._resolveVideoSamplesArePremultiplied(sprite);
    snap.videoGpuPremultipliedTexels = this._resolveMirrorVideoGpuIsPremultiplied();

    const v = this._mediaSource;
    if (v instanceof HTMLVideoElement) {
      snap.htmlVideo = {
        readyState: v.readyState,
        HAVE_NOTHING: 0,
        HAVE_METADATA: 1,
        HAVE_CURRENT_DATA: 2,
        HAVE_FUTURE_DATA: 3,
        HAVE_ENOUGH_DATA: 4,
        networkState: v.networkState,
        error: this._describeMediaError(v.error),
        videoWidth: v.videoWidth,
        videoHeight: v.videoHeight,
        currentTime: v.currentTime,
        duration: Number.isFinite(v.duration) ? v.duration : null,
        paused: v.paused,
        ended: v.ended,
        seeking: v.seeking,
        muted: v.muted,
        volume: typeof v.volume === 'number' ? v.volume : null,
        autoplay: v.autoplay,
        preload: typeof v.preload === 'string' ? v.preload : null,
        playsInline: v.playsInline,
        loop: v.loop,
        crossOrigin: v.crossOrigin,
        srcLength: typeof v.currentSrc === 'string' ? v.currentSrc.length : 0,
        currentSrcTail: typeof v.currentSrc === 'string'
          ? v.currentSrc.slice(-80)
          : null,
      };
    } else {
      snap.htmlVideo = null;
    }

    if (this._textureKind === 'video') {
      const vBound = v instanceof HTMLVideoElement ? v : null;
      const vSprite = sprite ? this._extractVideoElement(sprite) : null;
      const vManaged = managed ? this._extractVideoElement(managed) : null;
      snap.videoIdentity = {
        mirrorUsesSameAsResolvedSprite: !!(vBound && vSprite && vBound === vSprite),
        mirrorUsesSameAsManagedMesh: !!(vBound && vManaged && vBound === vManaged),
        threeUniformMapIsCurrentTexture:
          !!(this._material?.uniforms?.map?.value && this._texture && this._material.uniforms.map.value === this._texture),
      };
    }

    const t = this._texture;
    if (t) {
      snap.threeTexture = {
        isVideoTexture: !!t.isVideoTexture,
        format: t.format,
        type: t.type,
        colorSpace: t.colorSpace,
        flipY: t.flipY,
        needsUpdate: t.needsUpdate,
        version: t.version,
        uuid: t.uuid ?? null,
        imageIsMirrorVideoElement: !!(t.image instanceof HTMLVideoElement && t.image === this._mediaSource),
        imageVideoWxH: (t.image instanceof HTMLVideoElement)
          ? { w: t.image.videoWidth, h: t.image.videoHeight }
          : null,
      };
    } else {
      snap.threeTexture = null;
    }

    if (deep && this._textureKind === 'video') {
      const vBound = v instanceof HTMLVideoElement ? v : null;
      const vSprite = sprite ? this._extractVideoElement(sprite) : null;
      const vManaged = managed ? this._extractVideoElement(managed) : null;
      snap.domVideoSamples = {
        mirrorBound: this._sampleVideoPixels2D(vBound),
        fromResolvedSprite: this._sampleVideoPixels2D(
          vSprite instanceof HTMLVideoElement ? vSprite : null,
        ),
        fromManagedMesh: this._sampleVideoPixels2D(
          vManaged instanceof HTMLVideoElement ? vManaged : null,
        ),
      };
      try {
        const r =
          globalThis.canvas?.app?.renderer
          ?? globalThis.window?.MapShine?.floorCompositorV2?.renderer
          ?? null;
        const gl = r?.getContext?.() ?? r?.gl ?? null;
        snap.rendererWebgl = {
          rendererClass: r?.constructor?.name ?? null,
          parametersMaxTextureSize: r?.capabilities?.maxTextureSize ?? null,
          extensionsSnippet: Array.isArray(gl?.getSupportedExtensions?.())
            ? gl.getSupportedExtensions().filter((n) =>
              /video|NV12|color_buffer_float|unpack/i.test(String(n)),
            ).slice(0, 40)
            : null,
        };
      } catch (e) {
        snap.rendererWebgl = { error: String(e?.message ?? e) };
      }
    }

    if (this._textureKind === 'pixiCanvas') {
      snap.pixiCanvas = {
        frameCacheSize: this._pixiCanvasFrameCache.size,
        frameCacheMax: this._pixiCanvasFrameCacheMax,
        lastFrame: this._lastPixiCanvasFrame,
        includesSpriteState: this._pixiCanvasIncludesSpriteState,
        canvasWidth: this._mediaSource instanceof HTMLCanvasElement ? this._mediaSource.width : null,
        canvasHeight: this._mediaSource instanceof HTMLCanvasElement ? this._mediaSource.height : null,
      };
    }

    const mat = this._material;
    if (mat) {
      snap.material = {
        type: mat.type ?? mat.constructor?.name,
        transparent: mat.transparent,
        blending: mat.blending,
        blendSrc: mat.blendSrc,
        blendDst: mat.blendDst,
        blendEquation: mat.blendEquation,
        premultipliedAlpha: mat.premultipliedAlpha,
        toneMapped: mat.toneMapped,
        uOpacity: mat.uniforms?.uOpacity?.value,
        uPremulFragment: mat.uniforms?.uPremulFragment?.value,
        uStraightAlphaSample: mat.uniforms?.uStraightAlphaSample?.value,
        opacity: mat.opacity,
      };
    } else {
      snap.material = null;
    }

    const m = this.mesh;
    if (m) {
      snap.mesh = {
        visible: m.visible,
        renderOrder: m.renderOrder,
        frustumCulled: m.frustumCulled,
        position: m.position ? { x: m.position.x, y: m.position.y, z: m.position.z } : null,
        scale: m.scale ? { x: m.scale.x, y: m.scale.y, z: m.scale.z } : null,
        rotationZ: m.rotation?.z,
        parentName: m.parent?.name ?? null,
        parentType: m.parent?.type ?? null,
        inBusScene: !!(this._floorRenderBus?._scene && m.parent === this._floorRenderBus._scene),
      };
    } else {
      snap.mesh = null;
    }

    try {
      const r = globalThis.canvas?.app?.renderer ?? globalThis.window?.MapShine?.floorCompositorV2?.renderer;
      if (r) {
        snap.renderer = {
          outputColorSpace: r.outputColorSpace,
          toneMapping: r.toneMapping,
        };
      }
    } catch (_) {}

    snap.probeHint = deep
      ? 'Deep probe incl. DOM 2D sample. Light: probeSequencerMirrors() · Deep: probeSequencerMirrorsDeep()'
      : 'While an effect plays: MapShine.externalEffects.probeSequencerMirrors() · Deep: probeSequencerMirrorsDeep()';
    snap.hint = snap.probeHint;
    return snap;
  }

  /**
   * @param {MediaError|null} err
   * @returns {{ code: number|null, message: string|null}|null}
   */
  _describeMediaError(err) {
    if (!err) return null;
    try {
      return { code: err.code ?? null, message: err.message ?? null };
    } catch (_) {
      return null;
    }
  }

  /**
   * Sample center pixel via 2D canvas (same pipeline as thumbnails). Helps tell
   * whether the VIDEO element carries decoded pixels vs Three sampling black.
   * @param {HTMLVideoElement|null} video
   * @returns {Record<string, unknown>}
   */
  _sampleVideoPixels2D(video) {
    if (!(video instanceof HTMLVideoElement)) {
      return { ok: false, reason: 'no element' };
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) {
      return {
        ok: false,
        reason: 'no video dimensions',
        readyState: video.readyState,
        paused: video.paused,
      };
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { ok: false, reason: 'no 2d context' };
      const sx = Math.max(0, Math.floor(w / 2));
      const sy = Math.max(0, Math.floor(h / 2));
      ctx.drawImage(video, sx, sy, 1, 1, 0, 0, 1, 1);
      const img = ctx.getImageData(0, 0, 1, 1);
      const d = img.data;
      const r = d[0];
      const g = d[1];
      const b = d[2];
      const a = d[3];
      const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return {
        ok: true,
        centerRgb: [r, g, b, a],
        luminance: Math.round(lum * 1000) / 1000,
      };
    } catch (e) {
      return {
        ok: false,
        reason: 'drawImage/getImageData failed',
        securityOrError: String(e?.message ?? e),
      };
    }
  }

  /**
   * Forward Sequencer's own video refresh (`SequencerSpriteManager.updateVideoTextures`)
   * so PIXI's texture stays tied to the HTMLVideoElement the mirror shares.
   */
  _syncSequencerVideoPipeline() {
    if (this._textureKind !== 'video' || this._disposed) return;
    const mgr = this._effect?.sprite;
    if (!mgr || typeof mgr.updateVideoTextures !== 'function') return;
    try {
      mgr.updateVideoTextures();
    } catch (_) {}
  }

  /**
   * Sync transform (position/rotation/scale/opacity/tint) from the PIXI
   * CanvasEffect to the mirror mesh.
   */
  syncFromPixi() {
    if (!this.mesh || this._disposed) return;

    const effect = this._effect;
    if (!effect) return;

    // Video: align with Sequencer's own path (`sequencer-sprite-manager.js`
    // `updateVideoTextures` → `managedSprite.texture.update()`, and
    // `VideoPlaybackControls.play` → `texture.update()` after `video.play()`).
    // Run before any early return so a missing `canvas.dimensions` frame still
    // nudges decode / rebinding for the shared `HTMLVideoElement`.
    if (this._textureKind === 'video') {
      try { this._maybeReplaceDeadVideoWithSpriteTexture(); } catch (_) {}
      try { this._syncSequencerVideoPipeline(); } catch (_) {}
      try { this._maybeRebindVideoElement(); } catch (_) {}
      try { this._nudgeVideoElementIfNeeded(); } catch (_) {}
    }

    const sceneH = globalThis.canvas?.dimensions?.height;
    if (!Number.isFinite(Number(sceneH))) return;
    this._refreshNaturalSizeFromSource();

    // Scene pixels: Sequencer `effect.position` matches the canvas scene. Do not
    // use `worldPosition` / stage-normalized coords here — they differ from the
    // FloorRenderBus camera space and can move the mesh off-screen.
    let fx = Number.NaN;
    let fy = Number.NaN;
    this._lastMirrorPositionBasis = 'effectPosition';
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
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
      try {
        const sprite = this._resolveSprite();
        const wt = sprite?.worldTransform ?? effect?.worldTransform ?? null;
        if (wt && Number.isFinite(Number(wt.tx)) && Number.isFinite(Number(wt.ty))) {
          fx = Number(wt.tx);
          fy = Number(wt.ty);
        }
      } catch (_) {}
    }
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return;

    // Shift from effect root toward the Sequencer sprite / cast layout, then
    // pull ~10% back along the cast axis (tunable) so line spells sit where
    // Sequencer reads visually correct.
    const sprDelta = this._resolveSpriteRootDeltaFromEffect(effect);
    if (sprDelta.x !== 0 || sprDelta.y !== 0) {
      this._lastMirrorPositionBasis = 'effectPositionPlusSpriteDelta';
    }

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

    // Scale: prefer PIXI world-space bounds (includes ancestor scale used for
    // ranged / stretch / canvas zoom). Fallback: natural media × Sequencer
    // container scale — the latter misses parent-chain scaling and can latch
    // native video resolution instead of the drawn quad.
    const foot = this._resolveMirrorFootprintInScenePixels();
    const scaleMul = this._resolveMirrorMeshScaleMul();
    const w = Math.max(1, foot.width * scaleMul);
    const h = Math.max(1, foot.height * scaleMul);

    // `rotateTowards` pivot uses Sequencer's live sprite width; `_naturalSize`
    // can lag or differ from `managedSprite.width`, which under-shifts the mesh.
    let spanW = w;
    try {
      const sp = this._resolveSprite();
      const sw = Number(sp?.width);
      if (Number.isFinite(sw) && sw > 1) spanW = Math.max(spanW, sw);
    } catch (_) {}

    // Pivot / half-width offset from Sequencer `_setAnchors()` (rotateTowards and
    // some source→target line cases). Do **not** gate on |sprDelta|: attacks and
    // projectiles often have a large sprite-root delta along the cast while still
    // needing this offset — skipping it misaligned scale and placement vs PIXI.
    const forwardOffset = this._resolveRotateTowardsForwardOffset(spanW, rotation);
    const extra = this._retreatExtraOffsetAlongCast(
      sprDelta.x + forwardOffset.x,
      sprDelta.y + forwardOffset.y,
      effect,
      rotation,
    );
    fx += extra.x;
    fy += extra.y;

    const nudge = this._nudgeAlongCastTowardTargetPx(effect, rotation);
    fx += nudge.x;
    fy += nudge.y;

    // Convert Foundry top-left → MSA bottom-left (Y flip).
    this.mesh.position.x = fx;
    this.mesh.position.y = Number(sceneH) - fy;

    // Z: same band as bus tiles (see _resolveMirrorMeshWorldZ). Token sprites use a
    // much higher Z (~groundZ+1003); placing mirror *meshes* there clips them
    // behind the fixed camera at z≈2000.
    this.mesh.position.z = this._resolveMirrorMeshWorldZ();

    this.mesh.scale.x = w;
    this.mesh.scale.y = h;
    this.mesh.scale.z = 1;

    // Opacity / tint
    let alpha = 1;
    try {
      const c = effect;
      if (Number.isFinite(Number(c.alpha))) alpha = Number(c.alpha);
    } catch (_) {}
    const opacity = Math.max(0, Math.min(1, alpha));
    if (this._material?.uniforms?.uOpacity) {
      this._material.uniforms.uOpacity.value = opacity;
    } else {
      this._material.opacity = opacity;
    }

    // For spritesheets, advance UV from the animated frame index.
    if (this._textureKind === 'spritesheet') {
      this._refreshSpritesheetUv();
    } else if (this._textureKind === 'pixiCanvas') {
      this._refreshPixiCanvasTexture();
    }

    // Match PIXI blend mode (many JB2A clips use additive compositing).
    try {
      const THREE = globalThis.THREE;
      if (THREE) this._syncMaterialBlendFromPixi(THREE);
    } catch (_) {}
    try {
      this._syncExternalDiffuseGain();
    } catch (_) {}

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
    this._pixiCanvasFrameCache.clear();

    this._restorePixiContainer();
  }

  _createMaterial(THREE) {
    // Passthrough shader (no luminance key / discard). Blend factors for video
    // are chosen in _syncMaterialBlendFromPixi from PIXI alphaMode + Sequencer
    // global PIXI fix — see fileoverview.
    if (this._textureKind === 'video') {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          map: { value: this._texture },
          uOpacity: { value: 1 },
          uDiffuseGain: { value: 1 },
          uTint: { value: new THREE.Vector3(1, 1, 1) },
          /** 1 when blend factors expect premultiplied src (PIXI PMA path). */
          uPremulFragment: { value: 0 },
          /** 1 when `texture2D` returns straight RGBA (default for VideoTexture). */
          uStraightAlphaSample: { value: 1 },
        },
        vertexShader: /* glsl */`
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */`
          uniform sampler2D map;
          uniform float uOpacity;
          uniform float uDiffuseGain;
          uniform vec3 uTint;
          uniform float uPremulFragment;
          uniform float uStraightAlphaSample;
          varying vec2 vUv;

          void main() {
            vec4 c = texture2D(map, vUv);
            vec3 rgb = c.rgb * uDiffuseGain * uTint * uOpacity;
            float a = c.a * uOpacity;
            // Premultiplied blend (One, OneMinusSrcAlpha) or additive PMA (One, One)
            // needs premultiplied fragment rgb. Three's VideoTexture is usually
            // straight alpha; PIXI "PMA" is then a compositing convention — apply
            // rgb *= a only when uPremulFragment && uStraightAlphaSample.
            if (uPremulFragment > 0.5 && uStraightAlphaSample > 0.5) {
              rgb *= c.a;
            }
            gl_FragColor = vec4(rgb, a);
          }
        `,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
        premultipliedAlpha: false,
      });
      try {
        this._syncMaterialBlendFromPixi(THREE, mat);
      } catch (_) {}
      return mat;
    }

    return new THREE.MeshBasicMaterial({
      map: this._texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      toneMapped: false,
    });
  }

  /**
   * Whether the shared video element should be composited as premultiplied RGBA.
   * Mirrors Sequencer `libwrapper.js` (global PIXI fix) and PIXI v8
   * `alphaMode` on the Foundry mesh / base texture.
   * @param {any|null} sprite
   * @returns {boolean}
   */
  _resolveVideoSamplesArePremultiplied(sprite) {
    try {
      const tex = sprite?.texture ?? null;
      const bt = tex?.baseTexture ?? tex?.source ?? null;
      if (bt?.sequencer_patched === true) return true;
      const am = sprite?.alphaMode ?? bt?.alphaMode ?? tex?.alphaMode;
      if (am != null) {
        const s = String(am).toLowerCase();
        if (s.includes('no-premultiply')) return false;
        if (s.includes('premultiplied-alpha')) return true;
        if (s.includes('premultiply-alpha-on-upload')) return true;
      }
      const P = globalThis.PIXI?.ALPHA_MODES;
      if (P && am != null && typeof am === 'string') {
        if (am === P.PMA || am === P.PREMULTIPLIED_ALPHA) return true;
        if (am === P.NPM || am === P.NO_PREMULTIPLIED_ALPHA) return false;
      }
      if (typeof am === 'number') {
        if (am === 1) return true;
        if (am === 0 || am === 2) return false;
      }
    } catch (_) {}
    try {
      const on = globalThis.game?.settings?.get?.('sequencer', 'enable-global-fix-pixi');
      if (on === true) return true;
      if (on === false) return false;
    } catch (_) {}
    // Sequencer default for this setting is false — align with unpatched PIXI.
    return false;
  }

  /**
   * Whether Three's `VideoTexture` upload of the shared `<video>` delivers
   * premultiplied RGBA texels. Browser / WebGL defaults are **straight**; set
   * `MapShine.__sequencerMirrorVideoGpuPremultiplied = true` only if you have
   * confirmed a premultiplied upload path.
   * @returns {boolean}
   */
  _resolveMirrorVideoGpuIsPremultiplied() {
    try {
      const v = globalThis.window?.MapShine?.__sequencerMirrorVideoGpuPremultiplied;
      if (v === true || v === 1 || v === 'true') return true;
      if (v === false || v === 0 || v === 'false') return false;
    } catch (_) {}
    return false;
  }

  /**
   * Align Three blending with the source PIXI sprite so mirrored VFX match
   * Sequencer (additive fire, etc.).
   * @param {any} THREE
   * @param {any} [material]
   */
  _syncMaterialBlendFromPixi(THREE, material = null) {
    const mat = material ?? this._material;
    if (!mat || !THREE || typeof mat !== 'object') return;

    const sprite = this._resolveSprite();
    let bm = sprite?.blendMode;
    if (bm == null && this._effect && typeof this._effect === 'object') {
      bm = this._effect.blendMode;
    }
    if (bm && typeof bm === 'object' && typeof bm.name === 'string') {
      bm = bm.name;
    }
    const pixi = globalThis.PIXI;
    const BM = pixi?.BLEND_MODES;

    let mode = 'normal';
    if (typeof bm === 'string') {
      const ls = bm.toLowerCase();
      if (ls.includes('add')) mode = 'add';
      else if (ls.includes('multiply')) mode = 'multiply';
      else if (ls.includes('screen')) mode = 'screen';
    } else if (typeof bm === 'number') {
      if (BM && typeof BM === 'object') {
        if (bm === BM.ADD) mode = 'add';
        else if (bm === BM.MULTIPLY) mode = 'multiply';
        else if (bm === BM.SCREEN) mode = 'screen';
      } else {
        if (bm === 1) mode = 'add';
        else if (bm === 2) mode = 'multiply';
        else if (bm === 3) mode = 'screen';
      }
    }

    // Video: match Sequencer / PIXI alpha convention (premul vs straight).
    if (this._textureKind === 'video') {
      const pma = this._resolveVideoSamplesArePremultiplied(sprite);
      const gpuPremul = this._resolveMirrorVideoGpuIsPremultiplied();
      const straightSample = gpuPremul ? 0 : 1;
      /** Fragment must output premultiplied rgb when these blend modes are used. */
      let premulFragment = 0;

      mat.blendEquation = THREE.AddEquation;
      if (mode === 'add') {
        mat.blending = THREE.CustomBlending;
        if (pma) {
          premulFragment = 1;
          mat.blendSrc = THREE.OneFactor;
          mat.blendDst = THREE.OneFactor;
        } else {
          mat.blendSrc = THREE.SrcAlphaFactor;
          mat.blendDst = THREE.OneFactor;
        }
      } else if (mode === 'multiply') {
        mat.blending = THREE.MultiplyBlending;
      } else if (mode === 'screen') {
        mat.blending = THREE.CustomBlending;
        mat.blendSrc = THREE.OneMinusDstColorFactor;
        mat.blendDst = THREE.OneFactor;
      } else {
        mat.blending = THREE.CustomBlending;
        if (pma) {
          premulFragment = 1;
          mat.blendSrc = THREE.OneFactor;
          mat.blendDst = THREE.OneMinusSrcAlphaFactor;
        } else {
          mat.blendSrc = THREE.SrcAlphaFactor;
          mat.blendDst = THREE.OneMinusSrcAlphaFactor;
        }
      }

      mat.premultipliedAlpha = premulFragment > 0;
      try {
        if (mat.uniforms?.uPremulFragment) mat.uniforms.uPremulFragment.value = premulFragment;
        if (mat.uniforms?.uStraightAlphaSample) mat.uniforms.uStraightAlphaSample.value = straightSample;
      } catch (_) {}

      return;
    }

    if (mode === 'add') {
      if (mat.blending !== THREE.AdditiveBlending) mat.blending = THREE.AdditiveBlending;
      return;
    }
    if (mode === 'multiply') {
      if (mat.blending !== THREE.MultiplyBlending) mat.blending = THREE.MultiplyBlending;
      return;
    }
    if (mode === 'screen') {
      mat.blending = THREE.CustomBlending;
      mat.blendEquation = THREE.AddEquation;
      mat.blendSrc = THREE.OneMinusDstColorFactor;
      mat.blendDst = THREE.OneFactor;
      return;
    }
    if (mat.blending !== THREE.NormalBlending) mat.blending = THREE.NormalBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.SrcAlphaFactor;
    mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  }

  /**
   * Softens mirrored Sequencer / JB2A output on the floor bus (often reads as
   * blown-out vs PIXI). Override with `MapShine.__sequencerMirrorExternalDiffuseGain`.
   * @returns {number}
   */
  _resolveExternalDiffuseGain() {
    const gRaw = Number(globalThis.window?.MapShine?.__sequencerMirrorExternalDiffuseGain);
    if (Number.isFinite(gRaw) && gRaw > 0) return Math.min(2, Math.max(0.03, gRaw));
    const k = this._textureKind;
    if (k === 'pixiCanvas') return 0.74;
    if (k === 'spritesheet') return 0.8;
    if (k === 'image') return 0.84;
    if (k === 'video') return 0.82;
    return 0.85;
  }

  /**
   * Per-channel multiplier from `MapShine.__sequencerMirrorExternalTint` ({r,g,b}).
   * Each channel is clamped non-negative; missing / invalid values fall back to 1.
   * @returns {{r:number,g:number,b:number}}
   */
  _resolveExternalTint() {
    try {
      const t = globalThis.window?.MapShine?.__sequencerMirrorExternalTint;
      if (t && typeof t === 'object') {
        const r = Number(t.r);
        const g = Number(t.g);
        const b = Number(t.b);
        return {
          r: Number.isFinite(r) && r >= 0 ? r : 1,
          g: Number.isFinite(g) && g >= 0 ? g : 1,
          b: Number.isFinite(b) && b >= 0 ? b : 1,
        };
      }
    } catch (_) {}
    return { r: 1, g: 1, b: 1 };
  }

  /**
   * Applies `_resolveExternalDiffuseGain` × `_resolveExternalTint` to the
   * active Three material. Video uses uniforms; MeshBasicMaterial uses `.color`.
   */
  _syncExternalDiffuseGain() {
    const gain = this._resolveExternalDiffuseGain();
    const tint = this._resolveExternalTint();
    const mat = this._material;
    if (!mat || typeof mat !== 'object') return;

    if (this._textureKind === 'video' && mat.uniforms?.uDiffuseGain) {
      mat.uniforms.uDiffuseGain.value = gain;
      if (mat.uniforms.uTint?.value && typeof mat.uniforms.uTint.value.set === 'function') {
        mat.uniforms.uTint.value.set(tint.r, tint.g, tint.b);
      }
      return;
    }
    try {
      if (mat.color && typeof mat.color.setRGB === 'function') {
        mat.color.setRGB(gain * tint.r, gain * tint.g, gain * tint.b);
      }
    } catch (_) {}
  }

  /**
   * Parallel component of the combined sprite / pivot correction along the cast
   * axis, scaled by `MapShine.__sequencerMirrorAlongCastPlacementMul` (default 0.7).
   * @param {number} ex
   * @param {number} ey
   * @param {any} effect
   * @param {number} rotation
   * @returns {{ x: number, y: number }}
   */
  _retreatExtraOffsetAlongCast(ex, ey, effect, rotation) {
    if (!Number.isFinite(ex) || !Number.isFinite(ey)) return { x: 0, y: 0 };
    let ux = NaN;
    let uy = NaN;
    try {
      const src = effect?.sourcePosition;
      const tgt = effect?.targetPosition;
      if (src && tgt && Number.isFinite(src.x) && Number.isFinite(tgt.x)) {
        const dx = tgt.x - src.x;
        const dy = tgt.y - src.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-2) {
          ux = dx / len;
          uy = dy / len;
        }
      }
    } catch (_) {}
    if (!Number.isFinite(ux) || !Number.isFinite(uy)) {
      ux = Math.cos(rotation);
      uy = Math.sin(rotation);
    }
    let mul = Number(globalThis.window?.MapShine?.__sequencerMirrorAlongCastPlacementMul);
    if (!Number.isFinite(mul) || mul <= 0) mul = 0.7;
    mul = Math.min(1.5, Math.max(0.25, mul));
    const dot = ex * ux + ey * uy;
    const px = dot * ux;
    const py = dot * uy;
    const qx = ex - px;
    const qy = ey - py;
    return { x: qx + mul * px, y: qy + mul * py };
  }

  /**
   * @returns {number}
   */
  _resolveAlongCastPlacementMul() {
    let mul = Number(globalThis.window?.MapShine?.__sequencerMirrorAlongCastPlacementMul);
    if (!Number.isFinite(mul) || mul <= 0) mul = 0.7;
    return Math.min(1.5, Math.max(0.25, mul));
  }

  /**
   * Extra uniform scale on the mirror quad after footprint resolution (getBounds
   * / natural size). `MapShine.__sequencerMirrorMeshScaleMul`, default 1.
   * @returns {number}
   */
  _resolveMirrorMeshScaleMul() {
    const g = Number(globalThis.window?.MapShine?.__sequencerMirrorMeshScaleMul);
    if (!Number.isFinite(g) || g <= 0) return 1;
    return Math.min(6, Math.max(0.05, g));
  }

  /**
   * Extra scene-pixel translation along source→target (positive nudges the
   * mesh toward the target). `MapShine.__sequencerMirrorAlongCastTargetNudgePx`.
   * @returns {number}
   */
  _resolveAlongCastTargetNudgePx() {
    const g = Number(globalThis.window?.MapShine?.__sequencerMirrorAlongCastTargetNudgePx);
    if (!Number.isFinite(g)) return 0;
    return Math.min(2000, Math.max(-2000, g));
  }

  /**
   * @param {any} effect
   * @param {number} rotation  Effect rotation (radians), cast fallback if no src/tgt.
   * @returns {{ x: number, y: number }}
   */
  _nudgeAlongCastTowardTargetPx(effect, rotation) {
    const px = this._resolveAlongCastTargetNudgePx();
    if (px === 0) return { x: 0, y: 0 };
    let ux = NaN;
    let uy = NaN;
    try {
      const src = effect?.sourcePosition;
      const tgt = effect?.targetPosition;
      if (src && tgt && Number.isFinite(src.x) && Number.isFinite(tgt.x)) {
        const dx = tgt.x - src.x;
        const dy = tgt.y - src.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-2) {
          ux = dx / len;
          uy = dy / len;
        }
      }
    } catch (_) {}
    if (!Number.isFinite(ux) || !Number.isFinite(uy)) {
      ux = Math.cos(rotation);
      uy = Math.sin(rotation);
    }
    return { x: ux * px, y: uy * px };
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

    // Resolve inner mesh (`AnimatedSpriteMesh` / `TilingSpriteMesh`).
    const sprite = this._resolveSprite();
    if (!sprite) return this._acquireTextureFromFile(THREE);

    // 1) Spritesheet / flipbook first. Sequencer frequently promotes WebM clips
    //    to an `AnimatedSpriteMesh` (compiled spritesheet / internal frames) while
    //    a pooled `HTMLVideoElement` may still hang off the texture resource graph
    //    in a broken state (`MEDIA_ELEMENT_ERROR: Empty src`). Taking video before
    //    frames mirrors the wrong surface and yields a black ShaderMaterial quad.
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
        this._naturalSize = this._resolveDisplaySize(sprite, sheetSource, this._extractSpritesheetFrameSize(sprite));
        return true;
      } catch (e) {
        log.warn('Spritesheet Texture creation failed:', e);
      }
    }

    // Some Sequencer `AnimatedSpriteMesh` frames are GPU/PIXI-only by the time
    // we see them: there is no image element to wrap, but PIXI can still render
    // the current frame. Mirror that through a small canvas texture.
    if (this._isAnimatedSpriteMesh(sprite)) {
      try {
        if (this._acquirePixiCanvasTexture(THREE, sprite)) return true;
      } catch (e) {
        log.warn('PIXI canvas Texture creation failed:', e);
      }
    }

    // 2) Static single-texture path — HTMLImageElement / canvas / bitmap.
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
        this._naturalSize = this._resolveDisplaySize(sprite, img);
        return true;
      } catch (e) {
        log.warn('Static Texture creation failed:', e);
      }
    }

    // 3) Live `<video>` (`TilingSpriteMesh` / direct WebM) — only bind elements
    //    that actually decode; skip errored / empty pooled tags.
    const video = this._extractVideoElement(sprite);
    if (video instanceof HTMLVideoElement && this._isUsableMirrorVideo(video)) {
      try {
        const tex = new THREE.VideoTexture(video);
        tex.format = THREE.RGBAFormat;
        tex.type = THREE.UnsignedByteType;
        // Match raw video samples; sRGB here can double-transform in custom shaders.
        tex.colorSpace = THREE.NoColorSpace ?? tex.colorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.flipY = true;
        this._texture = tex;
        this._textureKind = 'video';
        this._mediaSource = video;
        this._naturalSize = this._resolveDisplaySize(sprite, video);
        return true;
      } catch (e) {
        log.warn('VideoTexture creation failed:', e);
      }
    }

    log.debug('No usable media source for effect', this._effect?.id);
    if (this._isAnimatedSpriteMesh(sprite)) return false;
    return this._acquireTextureFromFile(THREE);
  }

  /**
   * @param {any} sprite
   * @returns {boolean}
   */
  _isAnimatedSpriteMesh(sprite) {
    try {
      if (!sprite || typeof sprite !== 'object') return false;
      if (sprite.constructor?.name === 'AnimatedSpriteMesh') return true;
      if (Array.isArray(sprite.textures) && sprite.textures.length > 0) return true;
      if (Number.isFinite(Number(sprite.totalFrames)) && Number(sprite.totalFrames) > 1) return true;
    } catch (_) {}
    return false;
  }

  /**
   * @param {any} THREE
   * @param {any} sprite
   * @returns {boolean}
   */
  _acquirePixiCanvasTexture(THREE, sprite) {
    const size = this._extractSpritesheetFrameSize(sprite);
    const w = Math.max(1, Math.ceil(Number(size.width) || Number(sprite?.texture?.width) || 1));
    const h = Math.max(1, Math.ceil(Number(size.height) || Number(sprite?.texture?.height) || 1));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    this._mediaSource = canvas;
    this._naturalSize = this._resolveDisplaySize(sprite, canvas, { width: w, height: h });

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace ?? tex.colorSpace;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.flipY = true;
    this._texture = tex;
    this._textureKind = 'pixiCanvas';
    this._lastPixiCanvasFrame = -1;
    this._refreshPixiCanvasTexture(true);
    return true;
  }

  /**
   * Do not mirror dead pooled video elements (Sequencer swaps to spritesheets).
   * @param {HTMLVideoElement|null|undefined} video
   * @returns {boolean}
   */
  _isUsableMirrorVideo(video) {
    if (!(video instanceof HTMLVideoElement)) return false;
    try {
      if (video.error != null) return false;
    } catch (_) {}
    const w = video.videoWidth ?? 0;
    const h = video.videoHeight ?? 0;
    if (w > 0 && h > 0) return true;
    try {
      const rs = Number(video.readyState);
      if (rs >= HTMLVideoElement.HAVE_CURRENT_DATA) return true;
    } catch (_) {}
    try {
      const hasSrc = !!(
        String(video.getAttribute?.('src') ?? '').trim()
        || String(video.src ?? '').trim()
        || String(video.currentSrc ?? '').trim()
      );
      if (hasSrc && Number(video.readyState) >= HTMLVideoElement.HAVE_METADATA) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  /**
   * When attachment raced ahead of Sequencer's asset activation we may have a
   * dead fallback `VideoTexture`, while the live effect later resolves to an
   * `AnimatedSpriteMesh`. Replace the texture + material in-place.
   * @returns {boolean}
   */
  _maybeReplaceDeadVideoWithSpriteTexture() {
    if (this._textureKind !== 'video' || !this.mesh || this._disposed) return false;
    const currentVideo = this._mediaSource;
    if (currentVideo instanceof HTMLVideoElement && this._isUsableMirrorVideo(currentVideo)) return false;

    const THREE = globalThis.THREE;
    if (!THREE) return false;
    const sprite = this._resolveSprite();
    if (!this._isAnimatedSpriteMesh(sprite)) return false;

    const oldTexture = this._texture;
    const oldMaterial = this._material;

    let replaced = false;
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
        this._naturalSize = this._resolveDisplaySize(sprite, sheetSource, this._extractSpritesheetFrameSize(sprite));
        replaced = true;
      } catch (e) {
        log.warn('Dead video replacement with spritesheet failed:', e);
      }
    }

    if (!replaced) {
      try {
        replaced = this._acquirePixiCanvasTexture(THREE, sprite);
      } catch (e) {
        log.warn('Dead video replacement with PIXI canvas failed:', e);
      }
    }
    if (!replaced) {
      this._texture = oldTexture;
      this._textureKind = 'video';
      this._mediaSource = currentVideo;
      return false;
    }

    this._material = this._createMaterial(THREE);
    this.mesh.material = this._material;
    try { oldMaterial?.dispose?.(); } catch (_) {}
    try { oldTexture?.dispose?.(); } catch (_) {}
    this._refreshNaturalSizeFromSource();
    try { this._syncMaterialBlendFromPixi(THREE); } catch (_) {}
    try { this._syncExternalDiffuseGain(); } catch (_) {}
    return true;
  }

  _acquireTextureFromFile(THREE) {
    const path = this._resolveFilePath();
    if (!path) return false;
    const lower = path.toLowerCase();
    if (/\.(webm|mp4|m4v|ogv)(\?|#|$)/.test(lower)) {
      try {
        const video = document.createElement('video');
        video.src = path;
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.autoplay = true;
        video.preload = 'auto';
        video.addEventListener('loadedmetadata', () => {
          this._naturalSize = this._resolveDisplaySize(null, video);
          try { this.syncFromPixi(); } catch (_) {}
        }, { once: true });
        void video.play?.().catch?.(() => {});
        const tex = new THREE.VideoTexture(video);
        tex.format = THREE.RGBAFormat;
        tex.type = THREE.UnsignedByteType;
        // Match raw video samples; sRGB here can double-transform in custom shaders.
        tex.colorSpace = THREE.NoColorSpace ?? tex.colorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.flipY = true;
        this._texture = tex;
        this._textureKind = 'video';
        this._mediaSource = video;
        this._naturalSize = this._resolveDisplaySize(null, video);
        return true;
      } catch (e) {
        log.warn('Fallback VideoTexture creation failed:', e);
      }
    }

    if (/\.(png|jpe?g|webp|gif|avif)(\?|#|$)/.test(lower)) {
      try {
        const tex = new THREE.TextureLoader().load(path, () => {
          try {
            this._naturalSize = this._resolveDisplaySize(null, tex.image);
            tex.needsUpdate = true;
          } catch (_) {}
        });
        tex.colorSpace = THREE.SRGBColorSpace ?? tex.colorSpace;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.flipY = true;
        this._texture = tex;
        this._textureKind = 'image';
        this._mediaSource = null;
        this._naturalSize = this._resolveDisplaySize(null, null);
        return true;
      } catch (e) {
        log.warn('Fallback TextureLoader creation failed:', e);
      }
    }
    return false;
  }

  _resolveFilePath() {
    const e = this._effect;
    const d = e?.data ?? e?.document ?? e;
    const candidates = [
      e?._currentFilePath,
      e?._currentFile,
      e?.file,
      e?.source,
      d?._currentFilePath,
      d?._currentFile,
      d?.file,
      d?.source,
      d?.src,
      d?.texture?.src,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return '';
  }

  _resolveSprite() {
    const e = this._effect;
    if (!e) return null;
    // Prefer the inner Foundry mesh (TilingSpriteMesh / AnimatedSpriteMesh).
    // Sequencer often sets `effect.sprite` to a `SequencerSpriteManager` container;
    // the real texture, blendMode, and playing `HTMLVideoElement` live on
    // `managedSprite`. Using only the manager yields blendMode=null and can bind
    // a video element that never reaches HAVE_CURRENT_DATA (black quad in Three).
    let s = null;
    try {
      const sm = e.spriteManager ?? e._spriteManager ?? null;
      if (sm?.managedSprite) s = sm.managedSprite;
    } catch (_) {}
    try {
      if (!s && e.sprite?.managedSprite) s = e.sprite.managedSprite;
    } catch (_) {}
    if (s) return s;
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

  /**
   * Keep the shared HTMLVideoElement advancing when Sequencer has started the
   * effect but the element is still paused / HAVE_NOTHING (second WebGL consumer).
   * Throttled to avoid spamming play() every PIXI tick.
   */
  _nudgeVideoElementIfNeeded() {
    const v = this._mediaSource;
    if (!(v instanceof HTMLVideoElement)) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - this._lastVideoNudgeAt < 250) return;
    this._lastVideoNudgeAt = now;
    if (v.readyState >= HTMLVideoElement.HAVE_CURRENT_DATA && !v.paused) return;
    try { v.muted = true; } catch (_) {}
    void v.play?.().catch?.(() => {});
  }

  /**
   * If we initially bound a stalled `<video>` but the current sprite exposes a
   * different element that has decoded frames, re-point the Three VideoTexture.
   * (Happens when attach ran before `managedSprite` was ready.)
   */
  _maybeRebindVideoElement() {
    const THREE = globalThis.THREE;
    if (!THREE || this._textureKind !== 'video' || this._disposed || !this._material) return;
    const prev = this._mediaSource;
    if (!(prev instanceof HTMLVideoElement)) return;
    const sprite = this._resolveSprite();
    const el = this._extractVideoElement(sprite);
    if (!(el instanceof HTMLVideoElement) || el === prev || !this._isUsableMirrorVideo(el)) return;
    if (prev.videoWidth > 0) return;
    if (el.videoWidth <= 0) return;
    try {
      const oldTex = this._texture;
      const tex = new THREE.VideoTexture(el);
      tex.format = THREE.RGBAFormat;
      tex.type = THREE.UnsignedByteType;
      tex.colorSpace = THREE.NoColorSpace ?? tex.colorSpace;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;
      tex.flipY = true;
      this._texture = tex;
      this._mediaSource = el;
      if (this._material?.uniforms?.map) {
        this._material.uniforms.map.value = tex;
        this._material.needsUpdate = true;
      }
      try { oldTex?.dispose?.(); } catch (_) {}
    } catch (e) {
      log.warn('Sequencer mirror: video rebind failed:', e);
    }
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
      if (resource?.media instanceof HTMLVideoElement) return resource.media;
      if (resource?.texture?.baseTexture?.resource?.source instanceof HTMLVideoElement) return resource.texture.baseTexture.resource.source;
      if (tex?.source?.resource?.source instanceof HTMLVideoElement) return tex.source.resource.source;
      if (src?.source instanceof HTMLVideoElement) return src.source;
    } catch (_) {}
    return null;
  }

  _extractStaticImage(sprite) {
    try {
      const tex = sprite?.texture ?? null;
      if (!tex) return null;
      return this._extractImageFromPixiTexture(tex);
    } catch (_) {}
    return null;
  }

  /**
   * @param {any} tex
   * @returns {HTMLImageElement|HTMLCanvasElement|ImageBitmap|null}
   */
  _extractImageFromPixiTexture(tex) {
    try {
      if (!tex) return null;
      const src = tex.source ?? tex.baseTexture ?? null;
      const resource = src?.resource ?? null;
      if (resource instanceof HTMLImageElement) return resource;
      if (resource instanceof HTMLCanvasElement) return resource;
      if (typeof ImageBitmap !== 'undefined' && resource instanceof ImageBitmap) return resource;
      if (resource?.source instanceof HTMLImageElement) return resource.source;
      if (resource?.source instanceof HTMLCanvasElement) return resource.source;
      if (typeof ImageBitmap !== 'undefined' && resource?.source instanceof ImageBitmap) return resource.source;
      if (resource?.source?.source instanceof HTMLImageElement) return resource.source.source;
      if (resource?.source?.source instanceof HTMLCanvasElement) return resource.source.source;
      if (typeof ImageBitmap !== 'undefined' && resource?.source?.source instanceof ImageBitmap) return resource.source.source;
      if (typeof ImageBitmap !== 'undefined' && resource?.bitmap instanceof ImageBitmap) return resource.bitmap;
      if (src?.source instanceof HTMLImageElement) return src.source;
      if (src?.source instanceof HTMLCanvasElement) return src.source;
      if (typeof ImageBitmap !== 'undefined' && src?.source instanceof ImageBitmap) return src.source;
      if (tex?.source?.resource instanceof HTMLImageElement) return tex.source.resource;
      if (tex?.source?.resource instanceof HTMLCanvasElement) return tex.source.resource;
    } catch (_) {}
    return null;
  }

  _extractSpritesheetImage(sprite) {
    try {
      // AnimatedSpriteMesh / spritesheet sprites tend to share a single base
      // image; the active frame is selected via texture.frame/orig rect.
      if (sprite?.textures && Array.isArray(sprite.textures) && sprite.textures.length) {
        const first = sprite.textures[0];
        const img = this._extractImageFromPixiTexture(first);
        if (img) return img;
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

  _resolveDisplaySize(sprite, source = null, preferred = null) {
    const candidates = [];
    if (preferred) candidates.push(preferred);
    // Prefer live PIXI display dimensions over raw media pixels (e.g. 1920×1080
    // WebM drawn in a 400px-wide quad) and over token bounds from effect refs.
    try { candidates.push({ width: Number(sprite?.width), height: Number(sprite?.height) }); } catch (_) {}
    try {
      const tex = sprite?.texture ?? null;
      const rect = tex?.orig ?? tex?.frame ?? null;
      candidates.push({ width: Number(rect?.width), height: Number(rect?.height) });
    } catch (_) {}
    candidates.push(this._readEffectDataSize());
    if (source) {
      candidates.push({
        width: Number(source.videoWidth ?? source.naturalWidth ?? source.width),
        height: Number(source.videoHeight ?? source.naturalHeight ?? source.height),
      });
    }
    candidates.push(this._readEffectObjectSize());
    candidates.push(this._readGridFallbackSize());

    for (const c of candidates) {
      const w = Number(c?.width);
      const h = Number(c?.height);
      if (this._isMeaningfulWorldSize(w, h)) {
        return { width: w, height: h };
      }
    }
    return this._readGridFallbackSize() ?? { width: 1, height: 1 };
  }

  _isMeaningfulWorldSize(width, height) {
    const w = Number(width);
    const h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 1 || h <= 1) return false;
    const grid = Number(globalThis.canvas?.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100);
    const min = Number.isFinite(grid) && grid > 1
      ? Math.max(16, grid * MIN_EFFECT_SOURCE_SIZE_FACTOR)
      : 16;
    return w >= min && h >= min;
  }

  _readEffectDataSize() {
    const e = this._effect;
    const d = e?.data ?? e?.document ?? e;
    try {
      const w = Number(d?.width ?? d?._width ?? d?.size?.width);
      const h = Number(d?.height ?? d?._height ?? d?.size?.height);
      if (this._isMeaningfulWorldSize(w, h)) return { width: w, height: h };
    } catch (_) {}
    return null;
  }

  _readEffectObjectSize() {
    const e = this._effect;
    const d = e?.data ?? e?.document ?? e;
    const objects = [
      e?.sourceObj,
      e?.targetObj,
      e?.source,
      e?.target,
      d?.sourceObj,
      d?.targetObj,
      d?.source,
      d?.target,
    ];

    for (const obj of objects) {
      const size = this._readObjectSize(obj);
      if (size) return size;
    }
    return null;
  }

  _readObjectSize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    try {
      const bounds = obj.bounds ?? obj.object?.bounds ?? null;
      const bw = Number(bounds?.width);
      const bh = Number(bounds?.height);
      if (this._isMeaningfulWorldSize(bw, bh)) {
        return { width: bw, height: bh };
      }
    } catch (_) {}

    try {
      const w = Number(obj.w ?? obj.width ?? obj.object?.w ?? obj.object?.width);
      const h = Number(obj.h ?? obj.height ?? obj.object?.h ?? obj.object?.height);
      if (this._isMeaningfulWorldSize(w, h)) {
        return { width: w, height: h };
      }
    } catch (_) {}

    try {
      const doc = obj.document ?? obj;
      const grid = Number(globalThis.canvas?.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100);
      const unitsW = Number(doc?.width);
      const unitsH = Number(doc?.height);
      if (Number.isFinite(unitsW) && Number.isFinite(unitsH) && unitsW > 0 && unitsH > 0 && Number.isFinite(grid)) {
        return { width: unitsW * grid, height: unitsH * grid };
      }
    } catch (_) {}

    return null;
  }

  _readGridFallbackSize() {
    const grid = Number(globalThis.canvas?.grid?.size ?? globalThis.canvas?.dimensions?.size ?? 100);
    if (!Number.isFinite(grid) || grid <= 1) return null;
    const min = Math.max(64, grid * MIN_EFFECT_WORLD_SIZE_FACTOR);
    return { width: min, height: min };
  }

  _refreshNaturalSizeFromSource() {
    const sprite = this._resolveSprite();
    if (!sprite) return;
    const next = this._resolveDisplaySize(sprite, this._mediaSource);
    const cur = this._naturalSize;
    if (!this._isMeaningfulWorldSize(cur.width, cur.height)) {
      this._naturalSize = next;
      return;
    }
    if (!this._isMeaningfulWorldSize(next.width, next.height)) return;
    // Grow when we only had a placeholder, or shrink when we latched native
    // video / token bounds but the live sprite footprint is much smaller.
    const curA = cur.width * cur.height;
    const nextA = next.width * next.height;
    if (next.width > cur.width || next.height > cur.height) {
      this._naturalSize = next;
    } else if (curA > nextA * 2.25) {
      this._naturalSize = next;
    }
  }

  _resolveEffectPosition() {
    const effect = this._effect;
    let fx = Number.NaN;
    let fy = Number.NaN;
    try {
      const p = effect?.position ?? null;
      if (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))) {
        fx = Number(p.x);
        fy = Number(p.y);
      }
    } catch (_) {}
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
      try {
        if (Number.isFinite(Number(effect?.x)) && Number.isFinite(Number(effect?.y))) {
          fx = Number(effect.x);
          fy = Number(effect.y);
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
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
      try {
        const sprite = this._resolveSprite();
        const wt = sprite?.worldTransform ?? effect?.worldTransform ?? null;
        if (wt && Number.isFinite(Number(wt.tx)) && Number.isFinite(Number(wt.ty))) {
          fx = Number(wt.tx);
          fy = Number(wt.ty);
        }
      } catch (_) {}
    }
    return { x: fx, y: fy };
  }

  /**
   * Vector from the CanvasEffect root to the Sequencer sprite root in PIXI
   * global space (`worldTransform.tx/ty` difference). Same units as Foundry
   * scene placement when parent chain matches; avoids `worldPosition` stage
   * scaling, which does not match MSA's bus scene coordinates.
   * @param {any} effect
   * @returns {{ x: number, y: number }}
   */
  _resolveSpriteRootDeltaFromEffect(effect) {
    try {
      const root = effect?.sprite?.managedSprite ?? effect?.sprite ?? null;
      if (!root?.worldTransform || !effect?.worldTransform) return { x: 0, y: 0 };
      const wtR = root.worldTransform;
      const wtE = effect.worldTransform;
      const dx = Number(wtR.tx) - Number(wtE.tx);
      const dy = Number(wtR.ty) - Number(wtE.ty);
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { x: 0, y: 0 };
      return { x: dx, y: dy };
    } catch (_) {
      return { x: 0, y: 0 };
    }
  }

  /**
   * Canvas-space XY of the Sequencer sprite root, matching `CanvasEffect.worldPosition`
   * (stage worldTransform normalization). Uses the getter when present, else the
   * same math on `managedSprite ?? sprite`.
   * @param {any} effect
   * @returns {{ x: number, y: number }|null}
   */
  _resolveSequencerCanvasWorldXY(effect) {
    try {
      if (effect && typeof effect.worldPosition === 'object' && effect.worldPosition != null) {
        const wp = effect.worldPosition;
        const x = Number(wp.x);
        const y = Number(wp.y);
        if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
      }
    } catch (_) {}
    try {
      const root = effect?.sprite?.managedSprite ?? effect?.sprite ?? null;
      if (!root?.worldTransform) return null;
      const stage = globalThis.canvas?.stage;
      const t = stage?.worldTransform;
      if (!t) return null;
      const wt = root.worldTransform;
      const scale = Number(stage.scale?.x) || 1;
      const x = (Number(wt.tx) - Number(t.tx)) / scale;
      const y = (Number(wt.ty) - Number(t.ty)) / scale;
      if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
    } catch (_) {}
    return null;
  }

  /**
   * Sequencer's `_setAnchors()` shifts `rotateTowards` effects forward by
   * setting `spriteContainer.pivot.x = sprite.width * -0.5` when no explicit
   * anchor/template is present. Mirror that center shift in world space.
   * @param {number} width
   * @param {number} rotation
   * @returns {{x:number,y:number}}
   */
  _resolveRotateTowardsForwardOffset(width, rotation) {
    try {
      const d = this._effect?.data ?? this._effect?.document ?? this._effect ?? null;
      // Sequencer: `spriteContainer.pivot.x = sprite.width * -0.5` (half-width
      // along the cast axis). Default multiplier 1 matches Sequencer; raise
      // `MapShine.__sequencerMirrorRotateTowardsForwardMul` if a pack needs more.
      let mul = Number(globalThis.window?.MapShine?.__sequencerMirrorRotateTowardsForwardMul);
      if (!Number.isFinite(mul) || mul <= 0) mul = 1;
      let sign = Number(globalThis.window?.MapShine?.__sequencerMirrorRotateTowardsForwardSign);
      if (!Number.isFinite(sign) || sign === 0) sign = 1;
      const amount = Number(width) * 0.5 * mul * sign;
      if (!Number.isFinite(amount) || amount <= 0) return { x: 0, y: 0 };

      if (d?.rotateTowards && !d.rotateTowards?.template && !d.anchor) {
        return {
          x: Math.cos(rotation) * amount,
          y: Math.sin(rotation) * amount,
        };
      }

      // Macros / Automated Evocations may omit `rotateTowards` while still using
      // Sequencer `sourcePosition` → `targetPosition` for line-like placement.
      try {
        const eff = this._effect;
        const src = eff?.sourcePosition;
        const tgt = eff?.targetPosition;
        if (src && tgt && Number.isFinite(src.x) && Number.isFinite(tgt.x)) {
          const dx = tgt.x - src.x;
          const dy = tgt.y - src.y;
          const len = Math.hypot(dx, dy);
          if (len > 1e-2) {
            const px = Number(eff?.position?.x);
            const py = Number(eff?.position?.y);
            if (Number.isFinite(px) && Number.isFinite(py)) {
              const ds = Math.hypot(px - src.x, py - src.y);
              const dt = Math.hypot(px - tgt.x, py - tgt.y);
              if (ds < dt * 1.15) {
                return { x: (dx / len) * amount, y: (dy / len) * amount };
              }
            }
          }
        }
      } catch (_) {}

      return { x: 0, y: 0 };
    } catch (_) {
      return { x: 0, y: 0 };
    }
  }

  _resolvePixiVisualBounds() {
    const sprite = this._resolveSprite();
    if (!sprite || typeof sprite !== 'object') return null;
    const oldRenderable = sprite.renderable;
    try {
      // MSA suppresses the PIXI sprite, but bounds are still the best source of
      // Sequencer's post-anchor / post-pivot visual center. Temporarily enable
      // renderability for the calculation only; it does not draw synchronously.
      if (typeof sprite.renderable === 'boolean') sprite.renderable = true;
      const bounds = typeof sprite.getBounds === 'function' ? sprite.getBounds() : null;
      const x = Number(bounds?.x);
      const y = Number(bounds?.y);
      const width = Number(bounds?.width);
      const height = Number(bounds?.height);
      if (Number.isFinite(x) && Number.isFinite(y) && this._isMeaningfulWorldSize(width, height)) {
        return {
          x,
          y,
          width,
          height,
          centerX: x + width / 2,
          centerY: y + height / 2,
        };
      }
    } catch (_) {
      // Fall back below.
    } finally {
      try {
        if (typeof oldRenderable === 'boolean') sprite.renderable = oldRenderable;
      } catch (_) {}
    }
    return null;
  }

  _resolvePixiVisualSize(bounds = null) {
    const sprite = this._resolveSprite();
    let width = Number.NaN;
    let height = Number.NaN;
    try {
      width = Number(sprite?.width);
      height = Number(sprite?.height);
    } catch (_) {}
    if (!this._isMeaningfulWorldSize(width, height)) {
      width = Number(bounds?.width);
      height = Number(bounds?.height);
    }
    if (!this._isMeaningfulWorldSize(width, height)) {
      width = Number(this._naturalSize.width) * this._readContainerScaleX();
      height = Number(this._naturalSize.height) * this._readContainerScaleY();
    }
    return {
      width: Number.isFinite(width) && width > 0 ? width : 1,
      height: Number.isFinite(height) && height > 0 ? height : 1,
    };
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

  /**
   * Update a canvas-backed mirror by asking PIXI to render the current animated
   * sprite frame into our canvas, then upload that canvas to Three.
   * @param {boolean} [force]
   */
  _refreshPixiCanvasTexture(force = false) {
    if (!this._texture || !(this._mediaSource instanceof HTMLCanvasElement)) return;
    const sprite = this._resolveSprite();
    if (!sprite) return;

    const frameIdx = Number(sprite.currentFrame ?? sprite._currentFrame ?? 0) | 0;
    if (!force && frameIdx === this._lastPixiCanvasFrame) return;
    this._lastPixiCanvasFrame = frameIdx;

    const canvas = this._mediaSource;
    try {
      const size = this._extractSpritesheetFrameSize(sprite);
      const w = Math.max(1, Math.ceil(Number(size.width) || canvas.width || 1));
      const h = Math.max(1, Math.ceil(Number(size.height) || canvas.height || 1));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: false });
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const cached = this._pixiCanvasFrameCache.get(frameIdx);
      if (cached instanceof HTMLCanvasElement) {
        ctx.drawImage(cached, 0, 0, cached.width, cached.height, 0, 0, canvas.width, canvas.height);
        this._pixiCanvasIncludesSpriteState = cached.__msaSequencerIncludesSpriteState === true;
        this._texture.needsUpdate = true;
        return;
      }

      let drawn = this._drawPixiTextureFrameToCanvas(ctx, sprite, canvas.width, canvas.height);
      this._pixiCanvasIncludesSpriteState = false;
      if (!drawn) {
        drawn = this._extractPixiSpriteToCanvas(ctx, sprite, canvas.width, canvas.height);
        if (drawn) this._pixiCanvasIncludesSpriteState = true;
      }
      if (drawn) this._cachePixiCanvasFrame(frameIdx, canvas);
      this._texture.needsUpdate = true;
    } catch (_) {}
  }

  /**
   * Cache extracted PIXI frames so looping effects do not repeatedly call
   * renderer.extract.canvas(), which stalls the GPU.
   * @param {number} frameIdx
   * @param {HTMLCanvasElement} source
   */
  _cachePixiCanvasFrame(frameIdx, source) {
    if (!Number.isFinite(frameIdx) || !(source instanceof HTMLCanvasElement)) return;
    if (this._pixiCanvasFrameCache.has(frameIdx)) return;
    try {
      const max = Math.max(1, Math.min(
        this._pixiCanvasFrameCacheMax,
        Number(this._resolveSprite()?.totalFrames) || this._pixiCanvasFrameCacheMax,
      ));
      while (this._pixiCanvasFrameCache.size >= max) {
        const oldest = this._pixiCanvasFrameCache.keys().next().value;
        this._pixiCanvasFrameCache.delete(oldest);
      }
      const copy = document.createElement('canvas');
      copy.width = source.width;
      copy.height = source.height;
      const ctx = copy.getContext('2d', { willReadFrequently: false });
      if (!ctx) return;
      ctx.drawImage(source, 0, 0);
      copy.__msaSequencerIncludesSpriteState = this._pixiCanvasIncludesSpriteState === true;
      this._pixiCanvasFrameCache.set(frameIdx, copy);
    } catch (_) {}
  }

  /**
   * Fast path for textures backed by image/canvas/bitmap resources.
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} sprite
   * @param {number} outW
   * @param {number} outH
   * @returns {boolean}
   */
  _drawPixiTextureFrameToCanvas(ctx, sprite, outW, outH) {
    try {
      const tex = sprite?.texture ?? null;
      const source = this._extractImageFromPixiTexture(tex);
      if (!source) return false;
      const frame = tex?.frame ?? tex?.orig ?? null;
      const sx = Number(frame?.x ?? 0);
      const sy = Number(frame?.y ?? 0);
      const sw = Math.max(1, Number(frame?.width ?? source.width ?? outW));
      const sh = Math.max(1, Number(frame?.height ?? source.height ?? outH));
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, outW, outH);
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Slow path for GPU-only PIXI textures. The exact extraction API varies
   * between PIXI versions / Foundry builds, so try the common call shapes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {any} sprite
   * @param {number} outW
   * @param {number} outH
   * @returns {boolean}
   */
  _extractPixiSpriteToCanvas(ctx, sprite, outW, outH) {
    const renderer = globalThis.canvas?.app?.renderer ?? null;
    const extract = renderer?.extract ?? null;
    if (!extract || typeof extract.canvas !== 'function') return false;

    const oldRenderable = sprite.renderable;
    try {
      if (typeof sprite.renderable === 'boolean') sprite.renderable = true;
      const attempts = [
        () => extract.canvas(sprite.texture),
        () => extract.canvas({ target: sprite.texture }),
        () => extract.canvas(sprite),
        () => extract.canvas({ target: sprite }),
      ];
      for (const fn of attempts) {
        let c = null;
        try { c = fn(); } catch (_) { c = null; }
        if (c instanceof HTMLCanvasElement && c.width > 0 && c.height > 0) {
          ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, outW, outH);
          return true;
        }
      }
    } finally {
      try {
        if (typeof oldRenderable === 'boolean') sprite.renderable = oldRenderable;
      } catch (_) {}
    }
    return false;
  }

  // ── Internal: PIXI container suppression ───────────────────────────────────

  _suppressPixiContainer() {
    try {
      const e = this._effect;
      // Prefer hiding only the Foundry mesh (`managedSprite`). Hiding the whole
      // `spriteContainer` can freeze PIXI's update path for video textures while
      // Sequencer still expects `updateVideoTextures()` / decode to progress
      // (shared `HTMLVideoElement` for Three `VideoTexture`).
      const inner = e?.sprite?.managedSprite ?? null;
      if (inner && typeof inner.renderable === 'boolean') {
        this._originalRenderable = inner.renderable;
        this._suppressedContainer = inner;
        inner.renderable = false;
        return;
      }
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

  /**
   * PIXI `canvas.stage.scale` / SceneComposer `currentZoom` — the same factor
   * camera-sync uses for FOV. `getBounds()` width/height are in global space
   * and **include** this scale; FloorRenderBus mesh units are **scene** space where
   * the Three camera already applies zoom, so footprint from bounds must be divided
   * by this value to stay zoom-stable vs Sequencer.
   * @returns {number} clamped to a small positive floor
   */
  _resolveCanvasStageZoom() {
    try {
      const st = Number(globalThis.canvas?.stage?.scale?.x);
      if (Number.isFinite(st) && st > 1e-6) return Math.max(1e-6, st);
    } catch (_) {}
    try {
      const z = Number(this._sceneComposer?.currentZoom);
      if (Number.isFinite(z) && z > 1e-6) return Math.max(1e-6, z);
    } catch (_) {}
    return 1;
  }

  /**
   * Legacy mesh footprint: `_naturalSize` × Sequencer `spriteContainer` scale
   * only (no ancestor chain). Used when `__sequencerMirrorScalePreferGetBounds`
   * is false or as a fallback when bounds are unavailable.
   * @returns {{ width: number, height: number }}
   */
  _resolveLegacyNaturalFootprint() {
    const scaleX = this._readContainerScaleX();
    const scaleY = this._readContainerScaleY();
    return {
      width: Math.max(1, this._naturalSize.width * scaleX),
      height: Math.max(1, this._naturalSize.height * scaleY),
    };
  }

  /**
   * Footprint of the mirrored quad in **Foundry scene pixels** (same space as
   * `effect.position`). Prefer PIXI `getBounds()` on the drawn sprite / its
   * containers so ranged spells, distance stretch, and nested scales match what
   * Sequencer renders; those bounds include canvas stage scale (FOV zoom), which
   * we remove so mesh scale matches bus world units (the Three camera already zooms).
   * Falls back to {@link _resolveLegacyNaturalFootprint}.
   *
   * F12: set `MapShine.__sequencerMirrorScalePreferGetBounds = false` to revert
   * to natural×container-only sizing.
   *
   * @returns {{ width: number, height: number }}
   */
  _resolveMirrorFootprintInScenePixels() {
    try {
      const v = globalThis.window?.MapShine?.__sequencerMirrorScalePreferGetBounds;
      if (v === false || v === 0 || v === 'false') {
        return this._resolveLegacyNaturalFootprint();
      }
    } catch (_) {}

    const stageZoom = this._resolveCanvasStageZoom();

    const boundsSize = (obj) => {
      if (!obj || typeof obj.getBounds !== 'function') return null;
      let oldR;
      try {
        if (typeof obj.renderable === 'boolean') {
          oldR = obj.renderable;
          obj.renderable = true;
        }
        const b = obj.getBounds();
        const rw = Number(b?.width);
        const rh = Number(b?.height);
        if (!this._isMeaningfulWorldSize(rw, rh)) return null;
        return { width: rw / stageZoom, height: rh / stageZoom };
      } catch (_) {
        // fall through
      } finally {
        try {
          if (typeof oldR === 'boolean') obj.renderable = oldR;
        } catch (_) {}
      }
      return null;
    };

    const vb = this._resolvePixiVisualBounds();
    if (vb && this._isMeaningfulWorldSize(vb.width, vb.height)) {
      return { width: vb.width / stageZoom, height: vb.height / stageZoom };
    }

    try {
      const eff = this._effect;
      let sz = boundsSize(eff?.spriteContainer);
      if (sz) return sz;
      sz = boundsSize(eff?.rotationContainer);
      if (sz) return sz;
    } catch (_) {}

    const pix = this._resolvePixiVisualSize(vb);
    if (this._isMeaningfulWorldSize(pix.width, pix.height)) {
      return { width: pix.width, height: pix.height };
    }

    return this._resolveLegacyNaturalFootprint();
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

  /**
   * Foundry / Sequencer canvas elevation for a source or target reference
   * (token, tile, template, …). Matches the intent of Sequencer's
   * `canvaslib.get_object_elevation` for common placeables.
   * @param {unknown} obj
   * @returns {number} finite elevation or NaN if unknown
   */
  _resolveObjectCanvasElevation(obj) {
    if (obj == null || typeof obj !== 'object') return Number.NaN;
    try {
      const d = obj.document ?? null;
      if (d && Number.isFinite(Number(d.elevation))) return Number(d.elevation);
    } catch (_) {}
    try {
      if (Number.isFinite(Number(obj.elevation))) return Number(obj.elevation);
    } catch (_) {}
    return Number.NaN;
  }

  /**
   * Resolved effect elevation for mirror Z / floor banding — mirrors Sequencer
   * `CanvasEffect#updateElevation()` (`data.elevation` may be `{ elevation, absolute }`,
   * combined with max(source,target) when not absolute).
   * @returns {number}
   */
  _resolveElevation() {
    const e = this._effect;
    try {
      const inst = Number(e?.elevation);
      if (Number.isFinite(inst)) return inst;
    } catch (_) {}

    try {
      const raw = e?.data?.elevation;
      if (raw != null && typeof raw === 'object') {
        let effectElevation = Number(raw.elevation);
        if (!Number.isFinite(effectElevation)) effectElevation = 0;
        if (raw.absolute === true) return effectElevation;
        const srcEl = this._resolveObjectCanvasElevation(e?.source);
        const tgtEl = this._resolveObjectCanvasElevation(e?.target);
        const targetElevation = Math.max(
          Number.isFinite(srcEl) ? srcEl : 0,
          Number.isFinite(tgtEl) ? tgtEl : 0,
        );
        return effectElevation + targetElevation;
      }
      const flat = Number(raw);
      if (Number.isFinite(flat)) return flat;
    } catch (_) {}

    return 0;
  }

  /**
   * World Z for the mirror on {@link FloorRenderBus} — bus **tiles** use
   * `GROUND_Z + floorIndex * Z_PER_FLOOR`; we follow the same base + floor and
   * add a fractional elevation term (legacy behaviour) plus optional bias.
   * @returns {number}
   */
  _resolveMirrorMeshWorldZ() {
    const gz = Number(this._sceneComposer?.groundZ);
    const baseZ = Number.isFinite(gz) ? gz : GROUND_Z;
    const floorIdx = this._resolveFloorIndex();
    const fi = Number.isFinite(Number(floorIdx)) ? Number(floorIdx) : 0;
    const elev = this._resolveElevation();
    const e = Number.isFinite(elev) ? elev : 0;
    let bias = Number(globalThis.window?.MapShine?.__sequencerMirrorZBias);
    if (!Number.isFinite(bias)) bias = 0;
    bias = Math.min(5000, Math.max(-5000, bias));
    const elevZ = e / 100;
    return baseZ + fi * Z_PER_FLOOR + elevZ + bias;
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
