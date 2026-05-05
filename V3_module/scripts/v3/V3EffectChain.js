/**
 * @fileoverview V3 screen-space effect chain — registry + runner for
 * fullscreen post-processing passes that operate on the illuminated scene.
 *
 * ## Pipeline placement
 *
 *   sandwich  -> albedoRT
 *   illumination.render(litRT)                     (lit scene, tokens, lighting)
 *   runPhase('postIllumination', { inputRT: litRT })
 *       -> effects that should not touch water / weather (e.g. crisp grading)
 *   overlayScene (water/weather) rendered into the phase-A output RT
 *   runPhase('postSceneOverlay', { inputRT: afterA })
 *       -> effects that affect the whole scene (default for most stylized filters)
 *   blit final -> default framebuffer (opaque)
 *   drawingOverlayScene  (drawings — NOT filtered)
 *
 * PIXI UI lives in a separate DOM layer above the Three canvas and is never
 * touched by this chain.
 *
 * ## Effect contract (duck-typed)
 *
 *   {
 *     id:       string,                          // unique across chain
 *     phase:    'postIllumination' | 'postSceneOverlay',  // defaults to postSceneOverlay
 *     order:    number,                          // lower runs first; defaults to 100
 *     enabled:  boolean | () => boolean,         // may also be a getter
 *     update?(ctx): void,                        // per-frame uniform refresh (optional)
 *     render(renderer, effCtx): boolean,         // draw input -> output; return true on success
 *     onResize?(w: number, h: number): void,     // chain-allocated RT size changed
 *     dispose?(): void,                          // free GPU resources
 *   }
 *
 * `effCtx` = the caller `ctx` augmented with:
 *   - `inputTexture: THREE.Texture` (from previous RT or original input)
 *   - `inputRT:  THREE.WebGLRenderTarget`
 *   - `outputRT: THREE.WebGLRenderTarget` (distinct from inputRT)
 *   - `phase:    string`
 *   - `frame:    number`
 *
 * Effects draw `inputTexture` into `outputRT`; the chain manages ping-pong
 * between two internally owned RTs so multiple effects can compose without
 * read-after-write hazards. The input RT passed by the host (e.g. `litRT`) is
 * never written to by the chain.
 *
 * ## Why a simple registry, not a graph
 *
 * V2 grew a monolithic per-effect compositor; adding effects required
 * touching large orchestration code. A flat registry with a stable
 * `(phase, order)` key and a ping-pong RT pair covers 90%+ of post-process
 * effects (color grade, halftone, vignette, sharpen, chromatic aberration,
 * scanlines, etc) with almost no per-effect boilerplate. Effects that need
 * more (e.g. multi-pass bloom) can own internal RTs and still expose the
 * single `render(renderer, effCtx)` entry point.
 *
 * @module v3/V3EffectChain
 */

import * as THREE from "../vendor/three.module.js";

/**
 * Phase identifiers for the V3 effect chain. `postSceneOverlay` is the
 * default — it matches the "everything except drawings / UI" scope that most
 * stylized screen-space effects want.
 *
 * @enum {string}
 */
export const V3_EFFECT_PHASES = Object.freeze({
  /**
   * After illumination, before water / weather overlays. Suitable for effects
   * that must read the purely lit scene without any overlay contribution
   * (e.g. a color grade applied only to albedo+lighting).
   */
  POST_ILLUMINATION: "postIllumination",
  /**
   * After water / weather overlays, before drawings. This is the default
   * phase: it affects the full visible scene content (map, tiles, tokens,
   * lighting, water/weather) and stops short of user drawings and PIXI UI.
   */
  POST_SCENE_OVERLAY: "postSceneOverlay",
});

const _ALL_PHASES = Object.values(V3_EFFECT_PHASES);

/**
 * Default phase when an effect does not declare one.
 */
const DEFAULT_PHASE = V3_EFFECT_PHASES.POST_SCENE_OVERLAY;

/** @returns {boolean} */
function evaluateEnabled(effect) {
  if (!effect) return false;
  const e = effect.enabled;
  if (typeof e === "function") {
    try { return !!e.call(effect); } catch (_) { return false; }
  }
  return !!e;
}

/**
 * @typedef {Object} V3EffectRegistration
 * @property {string} id
 * @property {string} phase
 * @property {number} order
 * @property {Object} effect
 */

/**
 * Registry + runner for V3 screen-space effects. Owns two ping-pong render
 * targets shared across effects; host allocates/owns the initial input RT
 * (usually the illumination output / lit scene target).
 */
export class V3EffectChain {
  /**
   * @param {{ logger?: { log?: Function, warn?: Function } }} [opts]
   */
  constructor(opts = {}) {
    const logger = opts.logger ?? {};
    this.log = typeof logger.log === "function" ? logger.log : () => {};
    this.warn = typeof logger.warn === "function" ? logger.warn : () => {};

    /** @type {Map<string, V3EffectRegistration>} */
    this._effects = new Map();

    /** @type {THREE.WebGLRenderTarget|null} */ this._rtA = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._rtB = null;
    /** @type {number} */ this._rtW = 0;
    /** @type {number} */ this._rtH = 0;

    /** @type {number} */ this._frameCount = 0;
    /** @type {number} */ this._lastPhaseAEffectRuns = 0;
    /** @type {number} */ this._lastPhaseBEffectRuns = 0;
  }

  /**
   * Register a V3 effect. Returns an unregister callback.
   *
   * @param {Object} effect See file-level docblock for the duck-typed shape.
   * @returns {() => void}
   */
  register(effect) {
    if (!effect || !effect.id || typeof effect.render !== "function") {
      this.warn("V3EffectChain.register: missing id or render()", effect?.id);
      return () => {};
    }
    const id = String(effect.id);
    if (this._effects.has(id)) {
      this.warn(`V3EffectChain.register: replacing existing effect "${id}"`);
      this.unregister(id);
    }
    const declared = effect.phase;
    const phase = _ALL_PHASES.includes(declared) ? declared : DEFAULT_PHASE;
    if (declared && phase !== declared) {
      this.warn(
        `V3EffectChain.register: unknown phase "${declared}" for "${id}", using "${phase}"`,
      );
    }
    const order = Number.isFinite(effect.order) ? Number(effect.order) : 100;
    this._effects.set(id, { id, phase, order, effect });
    if (this._rtA && this._rtB) {
      try {
        effect.onResize?.(this._rtW, this._rtH);
      } catch (err) {
        this.warn(`V3EffectChain: onResize failed for "${id}"`, err);
      }
    }
    return () => this.unregister(id);
  }

  /**
   * Unregister an effect by id. Calls its `dispose()` if defined.
   *
   * @param {string} id
   * @returns {boolean} true if something was removed.
   */
  unregister(id) {
    const sid = String(id);
    const reg = this._effects.get(sid);
    if (!reg) return false;
    try { reg.effect.dispose?.(); } catch (err) {
      this.warn(`V3EffectChain: dispose failed for "${sid}"`, err);
    }
    this._effects.delete(sid);
    return true;
  }

  /**
   * Lookup an effect by id (returns the effect instance, not the registration
   * wrapper).
   *
   * @param {string} id
   * @returns {Object|null}
   */
  getEffect(id) {
    return this._effects.get(String(id))?.effect ?? null;
  }

  /**
   * @param {string} [phase] If provided, limit the check to one phase.
   * @returns {boolean}
   */
  hasActiveEffects(phase) {
    for (const reg of this._effects.values()) {
      if (phase && reg.phase !== phase) continue;
      if (evaluateEnabled(reg.effect)) return true;
    }
    return false;
  }

  /**
   * True when at least one registered effect is enabled (any phase).
   *
   * Used by the host as a cheap gate: when this is false, the illumination
   * pass can write straight to the default framebuffer and skip all
   * RT allocation and ping-pong overhead.
   *
   * @returns {boolean}
   */
  hasAnyActiveEffects() {
    for (const reg of this._effects.values()) {
      if (evaluateEnabled(reg.effect)) return true;
    }
    return false;
  }

  /**
   * Ensure the chain's ping-pong RTs exist at the given size. Safe to call
   * every frame — a same-size call is a fast path.
   *
   * @param {number} width
   * @param {number} height
   */
  ensureTargets(width, height) {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    if (this._rtA && this._rtB && this._rtW === w && this._rtH === h) return;

    const opts = {
      // Illumination output is sRGB-encoded (see V3IlluminationPipeline.render).
      // Tag the chain RTs as NoColorSpace so Three does not inject an extra
      // color-space conversion on read/write — effects treat the values as
      // pre-encoded sRGB, matching the default-framebuffer contract.
      colorSpace: THREE.NoColorSpace,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    };
    if (!this._rtA || !this._rtB) {
      this._rtA = new THREE.WebGLRenderTarget(w, h, opts);
      this._rtB = new THREE.WebGLRenderTarget(w, h, opts);
    } else {
      this._rtA.setSize(w, h);
      this._rtB.setSize(w, h);
    }
    this._rtW = w;
    this._rtH = h;

    for (const reg of this._effects.values()) {
      try {
        reg.effect.onResize?.(w, h);
      } catch (err) {
        this.warn(`V3EffectChain: onResize failed for "${reg.id}"`, err);
      }
    }
  }

  /**
   * Run every enabled effect registered for `phase`, in ascending `order`.
   *
   * Ping-pong rules:
   *   - `ctx.inputRT` is never written to.
   *   - First effect writes to whichever of {`_rtA`, `_rtB`} is NOT equal to
   *     `ctx.inputRT`. Subsequent effects swap on each successful render.
   *   - When no enabled effects exist for the phase, the original `inputRT`
   *     is returned unchanged (zero GPU cost).
   *
   * The returned RT is owned by either the caller (if unchanged) or the
   * chain (ping-pong RT). It is valid only until the next chain run / resize.
   *
   * @param {string} phase
   * @param {THREE.WebGLRenderer} renderer
   * @param {{
   *   inputRT: THREE.WebGLRenderTarget,
   *   time?: number,
   *   frame?: number,
   *   resolutionPx?: [number, number],
   *   viewUniforms?: any,
   * }} ctx
   * @returns {THREE.WebGLRenderTarget}
   */
  runPhase(phase, renderer, ctx) {
    const inputRT = ctx?.inputRT;
    if (!renderer || !inputRT) return inputRT;
    const regs = this._effectsForPhase(phase);
    if (regs.length === 0) {
      if (phase === V3_EFFECT_PHASES.POST_ILLUMINATION) this._lastPhaseAEffectRuns = 0;
      else if (phase === V3_EFFECT_PHASES.POST_SCENE_OVERLAY) this._lastPhaseBEffectRuns = 0;
      return inputRT;
    }
    this.ensureTargets(inputRT.width, inputRT.height);

    let readRT = inputRT;
    let readTex = inputRT.texture;
    // Pick the first write target such that we never clobber the caller's inputRT.
    let writeRT = inputRT === this._rtA ? this._rtB : this._rtA;
    let last = inputRT;
    let runs = 0;

    for (const reg of regs) {
      const eff = reg.effect;
      if (!evaluateEnabled(eff)) continue;
      try {
        eff.update?.(ctx);
      } catch (err) {
        this.warn(`V3EffectChain: update failed for "${reg.id}"`, err);
      }
      const effCtx = {
        ...ctx,
        inputTexture: readTex,
        inputRT: readRT,
        outputRT: writeRT,
        phase: reg.phase,
        frame: this._frameCount,
      };
      let ok = false;
      try {
        ok = !!eff.render(renderer, effCtx);
      } catch (err) {
        this.warn(`V3EffectChain: render failed for "${reg.id}"`, err);
        ok = false;
      }
      if (!ok) continue;
      last = writeRT;
      readRT = writeRT;
      readTex = writeRT.texture;
      writeRT = writeRT === this._rtA ? this._rtB : this._rtA;
      runs++;
    }

    if (phase === V3_EFFECT_PHASES.POST_ILLUMINATION) this._lastPhaseAEffectRuns = runs;
    else if (phase === V3_EFFECT_PHASES.POST_SCENE_OVERLAY) this._lastPhaseBEffectRuns = runs;

    return last;
  }

  /**
   * Increment the chain's frame counter. Called once per composite by the
   * host (not per phase), so effects observing `effCtx.frame` see the same
   * value across both phases in a single frame.
   */
  tickFrame() {
    this._frameCount++;
  }

  /**
   * List registrations for a phase, sorted by ascending `order`.
   *
   * @param {string} phase
   * @returns {V3EffectRegistration[]}
   */
  _effectsForPhase(phase) {
    const out = [];
    for (const reg of this._effects.values()) {
      if (reg.phase === phase) out.push(reg);
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }

  /**
   * Serialisable snapshot for diagnostics. Lists every effect per phase with
   * its `enabled` evaluation at call time.
   *
   * @returns {{
   *   frameCount: number,
   *   targets: { width: number, height: number } | null,
   *   lastPhaseRuns: { postIllumination: number, postSceneOverlay: number },
   *   effects: Record<string, Array<{ id: string, order: number, enabled: boolean }>>
   * }}
   */
  snapshot() {
    /** @type {Record<string, Array<{id:string, order:number, enabled:boolean}>>} */
    const byPhase = {};
    for (const p of _ALL_PHASES) byPhase[p] = [];
    for (const reg of this._effects.values()) {
      const list = byPhase[reg.phase] ?? (byPhase[reg.phase] = []);
      list.push({
        id: reg.id,
        order: reg.order,
        enabled: evaluateEnabled(reg.effect),
      });
    }
    for (const p of Object.keys(byPhase)) {
      byPhase[p].sort((a, b) => a.order - b.order);
    }
    return {
      frameCount: this._frameCount,
      targets: this._rtA ? { width: this._rtW, height: this._rtH } : null,
      lastPhaseRuns: {
        postIllumination: this._lastPhaseAEffectRuns,
        postSceneOverlay: this._lastPhaseBEffectRuns,
      },
      effects: byPhase,
    };
  }

  /**
   * Dispose every registered effect and free the chain's ping-pong RTs.
   * Chain becomes empty but is still usable after calling `register` again.
   */
  dispose() {
    for (const reg of this._effects.values()) {
      try { reg.effect.dispose?.(); } catch (err) {
        this.warn(`V3EffectChain: dispose failed for "${reg.id}"`, err);
      }
    }
    this._effects.clear();
    try { this._rtA?.dispose(); } catch (_) {}
    try { this._rtB?.dispose(); } catch (_) {}
    this._rtA = null;
    this._rtB = null;
    this._rtW = 0;
    this._rtH = 0;
    this._lastPhaseAEffectRuns = 0;
    this._lastPhaseBEffectRuns = 0;
  }
}
