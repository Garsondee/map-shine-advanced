/**
 * @fileoverview V3 Building Shadows Pass — produces a scene-UV occlusion field
 * representing sun-projected building shadows across one or more stacked
 * floors, then surfaces that field to {@link V3IlluminationPipeline} as a
 * `MASK_MULTIPLY` occlusion term.
 *
 * Flow (called once per frame by {@link V3ThreeSceneHost}):
 *   1. For the viewed floor V and every higher floor U > V:
 *      - Project indoor silhouettes from U's `_Outdoors` mask along the sun
 *        direction, gated by U's own outdoor receiver mask (per-floor local
 *        shadow — same ray march as {@link BuildingShadowsEffectV2}).
 *   2. Walk floors bottom-up (V+1 → top), maintaining a running pair
 *      `(shadowAccum, alphaChain)` in a single RG render target:
 *        alphaChain_next = alphaChain_prev * (1 - transmit(A_U))
 *        shadowAccum_next = shadowAccum_prev + S_U * alphaChain_next
 *      where `transmit(A)` is a soft threshold over the floor's albedo alpha
 *      so shadows only cascade through transparent "hole" regions of each
 *      intervening floor, exactly as the user requested.
 *   3. Combine with the viewed floor's own strength `S_V`:
 *        total = clamp(S_V + shadowAccum, 0, 1)
 *        out.r = 1 - total  (ready for `OCC_KIND.MASK_MULTIPLY`)
 *
 * Why a `MASK_MULTIPLY` term rather than a post-effect?
 *   - Shadows live in linear-space lighting, not sRGB screen space — they
 *     multiply into ambient before direct lights are added, matching
 *     {@link V3IlluminationPipeline}'s contract.
 *   - The pipeline already resolves scene vs viewport UVs; we only need to
 *     supply a scene-UV texture.
 *
 * All inputs arrive with {@link V3_LEVEL_TEXTURE_FLIP_Y} applied so this pass
 * samples `vUv` directly — the output RT inherits the same row order.
 *
 * @module v3/V3BuildingShadowsPass
 */

import * as THREE from "../vendor/three.module.js";
import { V3_LEVEL_TEXTURE_FLIP_Y } from "./V3RenderConventions.js";

/**
 * Hard cap on RT longest edge. Matches {@link BuildingShadowsEffectV2}'s cap
 * so mid-range GPUs stay responsive — ray march is O(steps * width * height).
 */
const MAX_EDGE_PX = 2048;
/** Never render smaller than this; below ~512 the penumbra looks blocky. */
const MIN_EDGE_PX = 512;

const VERT = /* glsl */ `precision highp float;
in vec3 position;
in vec2 uv;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/**
 * Project per-floor indoor silhouette into a directional shadow strength
 * field. Mirrors {@link BuildingShadowsEffectV2}'s project shader closely so
 * the visual is already familiar; notable differences:
 *   - GLSL3 `in`/`out` (this pass runs with `glslVersion: GLSL3`).
 *   - Receiver gate uses the same (caster) outdoors texture — this pass
 *     works one floor at a time, so the caster IS the receiver.
 *   - Reads outdoors `.r` with alpha-as-coverage mix (sparse masks default
 *     to outdoor rather than solid indoor, matching V2's convention).
 */
const FRAG_PROJECT = /* glsl */ `precision highp float;
in vec2 vUv;
out vec4 fragColor;

// Silhouette source selector — upper floors use uAlbedo.a (the floor's
// solid-geometry mask — exactly what casts shadows onto the floor *below*
// through any adjacent alpha holes). Viewed floor projection prefers the
// authored _Outdoors mask when available so shadows show only on outdoor
// ground, but falls back to albedo alpha when no outdoors mask is authored.
//   0.0 = outdoors texture (.r, V2 semantics; alpha = coverage)
//   1.0 = albedo alpha     (.a where 1 = solid geometry, 0 = hole)
uniform float uSilhouetteSource;
uniform sampler2D uOutdoors;
uniform sampler2D uAlbedo;
uniform vec2 uTexelSize;
uniform vec2 uSunDir;
uniform float uLength;
uniform float uSoftness;
uniform float uSmear;
uniform float uPenumbra;
uniform float uShadowCurve;
// Weight of the local receiver gate (outdoor-ness of the current pixel).
// Set to 0.0 for upper-floor projections — gating is deferred to the cascade's
// transmit = 1 - smoothstep(alpha) — and to 1.0 for the viewed-floor
// projection so shadows don't bleed onto authored-indoor receivers.
uniform float uReceiverGateWeight;

float uvInBounds(vec2 uv) {
  vec2 safeMin = max(uTexelSize * 0.5, vec2(0.0));
  vec2 safeMax = min(vec2(1.0) - uTexelSize * 0.5, vec2(1.0));
  vec2 ge0 = step(safeMin, uv);
  vec2 le1 = step(uv, safeMax);
  return ge0.x * ge0.y * le1.x * le1.y;
}

/** Outdoor-ness at uv in 0..1. Missing mask defaults to 1 (outdoor). */
float readOutdoors(vec2 uv) {
  vec2 suv = clamp(uv, 0.0, 1.0);
  vec4 m = texture(uOutdoors, suv);
  return clamp(mix(1.0, m.r, m.a), 0.0, 1.0);
}

/** Solidness at uv in 0..1 — used as the shadow caster for upper floors. */
float readAlbedoSolid(vec2 uv) {
  vec2 suv = clamp(uv, 0.0, 1.0);
  return clamp(texture(uAlbedo, suv).a, 0.0, 1.0);
}

/** Returns indoor in 0..1 according to uSilhouetteSource. */
float readIndoorSilhouette(vec2 uv) {
  if (uSilhouetteSource > 0.5) return readAlbedoSolid(uv);
  return 1.0 - readOutdoors(uv);
}

/** Per-pixel receiver gate blended with uReceiverGateWeight. */
float readReceiverGate(vec2 uv) {
  float outdoor = readOutdoors(uv);
  return mix(1.0, clamp(outdoor, 0.0, 1.0), clamp(uReceiverGateWeight, 0.0, 1.0));
}

float sampleCasterIndoor(vec2 uv, float receiverGate) {
  float valid = uvInBounds(uv);
  float indoor = readIndoorSilhouette(uv);
  return indoor * receiverGate * valid;
}

void main() {
  vec2 dir = -normalize(uSunDir + vec2(1e-6));
  float pxLen = uLength * 1400.0;
  vec2 baseOffsetUv = dir * pxLen * uTexelSize;

  float receiverGate = readReceiverGate(vUv);

  vec2 ortho = vec2(-dir.y, dir.x);
  float smearAmount = clamp(uSmear, 0.0, 1.0);
  float penumbraAmount = clamp(uPenumbra, 0.0, 1.0);
  float accum = 0.0;
  float weightSum = 0.0;
  float peakHit = 0.0;

  const int RAY_STEPS = 8;
  for (int i = 0; i < RAY_STEPS; i++) {
    float t = (float(i) + 0.5) / float(RAY_STEPS);
    float spreadT = mix(t, t * t, 0.45 + 0.4 * smearAmount);
    vec2 centerUv = vUv + (baseOffsetUv * spreadT);

    float sigma = max(uSoftness, 0.5) * mix(0.8, 2.8, (t * t) + (0.5 * penumbraAmount * t));
    float lateral = sigma * uTexelSize.x * mix(0.8, 1.6, penumbraAmount);
    float distanceFade = mix(1.0, 0.55, t);

    float c0 = sampleCasterIndoor(centerUv, receiverGate);
    float c1 = sampleCasterIndoor(centerUv + ortho * lateral, receiverGate);
    float c2 = sampleCasterIndoor(centerUv - ortho * lateral, receiverGate);

    float stepHit = c0 * 0.5 + c1 * 0.25 + c2 * 0.25;
    peakHit = max(peakHit, stepHit);

    float stepWeight = mix(1.1, 0.7, t) * distanceFade;
    accum += stepHit * stepWeight;
    weightSum += stepWeight;
  }

  float integrated = (weightSum > 0.0) ? (accum / weightSum) : 0.0;
  float strength = mix(integrated, peakHit, 0.35 + 0.25 * smearAmount);
  strength = smoothstep(0.0, 1.0, clamp(strength, 0.0, 1.0));
  strength = pow(strength, max(uShadowCurve, 0.01));
  float s = clamp(strength, 0.0, 1.0);
  fragColor = vec4(s, s, s, 1.0);
}`;

/**
 * Cascade step. Reads the running `(shadowAccum, alphaChain)` pair, this
 * floor's shadow strength `S_U`, and this floor's albedo (alpha = opacity of
 * the floor plate above the viewer). Writes the next pair.
 *
 * Encoding:
 *   texel.r = shadowAccum  (sum of cascaded contributions, 0..1)
 *   texel.g = alphaChain   (running product of (1 - transmit(A_k)), 0..1)
 */
const FRAG_CASCADE = /* glsl */ `precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uPrevState;
uniform sampler2D uFloorStrength;
uniform sampler2D uFloorOccluder;
uniform float uAlphaHoleLo;
uniform float uAlphaHoleHi;

void main() {
  vec4 prev = texture(uPrevState, vUv);
  float shadowAccum = prev.r;
  float alphaChain = prev.g;

  float sU = clamp(texture(uFloorStrength, vUv).r, 0.0, 1.0);
  float aU = clamp(texture(uFloorOccluder, vUv).r, 0.0, 1.0);

  // Soft-threshold the alpha so "nearly transparent" still passes some light
  // (keeps the cascade from binary-flickering at albedo anti-aliased edges).
  float solid = smoothstep(uAlphaHoleLo, uAlphaHoleHi, aU);
  float transmit = clamp(1.0 - solid, 0.0, 1.0);

  float newAlphaChain = alphaChain * transmit;
  float newShadowAccum = shadowAccum + sU * newAlphaChain;

  fragColor = vec4(clamp(newShadowAccum, 0.0, 1.0), clamp(newAlphaChain, 0.0, 1.0), 0.0, 1.0);
}`;

/**
 * Seed occluder alpha accumulation from one texture's alpha channel.
 * Output is single-channel in `.r`.
 */
const FRAG_OCCLUDER_SEED = /* glsl */ `precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSource;
void main() {
  float a = clamp(texture(uSource, vUv).a, 0.0, 1.0);
  fragColor = vec4(a, 0.0, 0.0, 1.0);
}`;

/**
 * Fold one additional occluder alpha texture with MAX accumulation.
 * Output remains in `.r`.
 */
const FRAG_OCCLUDER_MAX = /* glsl */ `precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uPrev;
uniform sampler2D uAdd;
void main() {
  float prevA = clamp(texture(uPrev, vUv).r, 0.0, 1.0);
  float addA = clamp(texture(uAdd, vUv).a, 0.0, 1.0);
  fragColor = vec4(max(prevA, addA), 0.0, 0.0, 1.0);
}`;

/**
 * Final combine: `out.r = 1 - clamp(S_V + shadowAccum, 0, 1)`. Opacity is
 * intentionally *not* baked in — the occlusion term applies it as its slot
 * weight so the Tweakpane/opacity slider is a free control with no pass
 * re-run cost.
 */
const FRAG_COMBINE = /* glsl */ `precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform sampler2D uLocalStrength;
uniform sampler2D uState;

void main() {
  float sV = clamp(texture(uLocalStrength, vUv).r, 0.0, 1.0);
  float acc = clamp(texture(uState, vUv).r, 0.0, 1.0);
  float total = clamp(sV + acc, 0.0, 1.0);
  // MASK_MULTIPLY consumes .r: 1.0 = lit, 0.0 = fully shadowed.
  float lit = clamp(1.0 - total, 0.0, 1.0);
  fragColor = vec4(lit, lit, lit, 1.0);
}`;

/**
 * Initialize the running state: `R = 0` (no shadow yet), `G = 1` (fully
 * transparent chain above the viewed floor). Using a quad + shader rather
 * than `setClearColor` because the RT is RGBA8 and we want exact values
 * independent of the renderer's pending clear state.
 */
const FRAG_INIT_STATE = /* glsl */ `precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.0, 1.0, 0.0, 1.0);
}`;

/**
 * Fullscreen building-shadows pass. Owns its render targets + materials and
 * exposes a `run(...)` entry point called once per frame.
 */
export class V3BuildingShadowsPass {
  /** @param {{ logger?: { log?: Function, warn?: Function } }} [opts] */
  constructor({ logger } = {}) {
    /** @type {(...args: any[]) => void} */
    this.log = logger?.log ?? (() => {});
    /** @type {(...args: any[]) => void} */
    this.warn = logger?.warn ?? (() => {});

    /** @type {THREE.WebGLRenderer|null} */ this.renderer = null;

    /** @type {THREE.Scene} */
    this._quadScene = new THREE.Scene();
    /** @type {THREE.OrthographicCamera} */
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quadCamera.position.set(0, 0, 0.5);
    /** @type {THREE.PlaneGeometry} */
    this._geo = new THREE.PlaneGeometry(2, 2);
    /** @type {THREE.Mesh} */
    this._mesh = new THREE.Mesh(this._geo);
    this._mesh.frustumCulled = false;
    this._quadScene.add(this._mesh);

        this._projectMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_PROJECT,
      uniforms: {
        uSilhouetteSource: { value: 0 },
        uOutdoors: { value: null },
        uAlbedo: { value: null },
        uTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uSunDir: { value: new THREE.Vector2(0, 1) },
        uLength: { value: 0.22 },
        uSoftness: { value: 3.0 },
        uSmear: { value: 0.65 },
        uPenumbra: { value: 0.5 },
        uShadowCurve: { value: 0.9 },
        uReceiverGateWeight: { value: 1 },
      },
    });

    this._cascadeMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_CASCADE,
      uniforms: {
        uPrevState: { value: null },
        uFloorStrength: { value: null },
        uFloorOccluder: { value: null },
        uAlphaHoleLo: { value: 0.1 },
        uAlphaHoleHi: { value: 0.9 },
      },
    });

    this._occluderSeedMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_OCCLUDER_SEED,
      uniforms: {
        uSource: { value: null },
      },
    });

    this._occluderMaxMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_OCCLUDER_MAX,
      uniforms: {
        uPrev: { value: null },
        uAdd: { value: null },
      },
    });

    this._combineMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_COMBINE,
      uniforms: {
        uLocalStrength: { value: null },
        uState: { value: null },
      },
    });

    this._initStateMaterial = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      depthTest: false,
      depthWrite: false,
      transparent: false,
      vertexShader: VERT,
      fragmentShader: FRAG_INIT_STATE,
      uniforms: {},
    });

    /** Per-floor shadow strength (reused across floors). */
    /** @type {THREE.WebGLRenderTarget|null} */ this._strengthRT = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._stateRTA = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._stateRTB = null;
    /** Per-floor occluder alpha accumulation ping-pong. */
    /** @type {THREE.WebGLRenderTarget|null} */ this._occluderRTA = null;
    /** @type {THREE.WebGLRenderTarget|null} */ this._occluderRTB = null;
    /** Final output — `.r = 1 - shadowStrength`. */
    /** @type {THREE.WebGLRenderTarget|null} */ this._outputRT = null;

    /** Transient bookkeeping returned via {@link getDiagnostics}. */
    this._diag = {
      lastRunFrame: -1,
      lastRunMs: 0,
      lastRtSize: [0, 0],
      lastFloorCount: 0,
      lastViewedIndex: -1,
      lastCascadedFloors: 0,
      lastHadOutput: false,
      lastSkipReason: "never-run",
      totalRuns: 0,
      totalSkips: 0,
    };
  }

  /** @param {THREE.WebGLRenderer} renderer */
  attach(renderer) {
    this.renderer = renderer || null;
  }

  detach() {
    this._disposeTargets();
    this.renderer = null;
  }

  dispose() {
    this._disposeTargets();
    try { this._projectMaterial.dispose(); } catch (_) {}
    try { this._cascadeMaterial.dispose(); } catch (_) {}
    try { this._occluderSeedMaterial.dispose(); } catch (_) {}
    try { this._occluderMaxMaterial.dispose(); } catch (_) {}
    try { this._combineMaterial.dispose(); } catch (_) {}
    try { this._initStateMaterial.dispose(); } catch (_) {}
    try { this._geo.dispose(); } catch (_) {}
    try { this._quadScene.remove(this._mesh); } catch (_) {}
    this._mesh = null;
    this.renderer = null;
  }

  /**
   * Latest render-target texture for the occlusion term. `null` when the pass
   * is disabled, has no inputs, or has not yet run.
   *
   * @returns {THREE.Texture|null}
   */
  getOutputTexture() {
    return this._outputRT?.texture ?? null;
  }

  /** Snapshot for diagnostics / health checks. */
  getDiagnostics() {
    return {
      ...this._diag,
      lastRtSize: [...this._diag.lastRtSize],
      hasOutputTexture: !!this._outputRT?.texture,
    };
  }

  /**
   * Per-frame entry point. Rebuilds the shadow field from the supplied
   * `floors` slice (already resolved by {@link V3ThreeSceneHost} via the
   * mask hub) and writes it into {@link _outputRT}.
   *
   * `floors` must be ordered by `floorIndex` ascending (bottom → top) and
   * include the viewed floor at index `viewedIndex`. Upper floors without
   * usable textures are skipped but do not short-circuit lower floors.
   *
   * @param {{
   *   params: BuildingShadowsParams,
   *   viewedIndex: number,
   *   floors: Array<{
   *     floorIndex: number,
   *     outdoorsTex: THREE.Texture|null,
   *     albedoTex: THREE.Texture|null,
   *     occluderTexArray?: THREE.Texture[],
   *   }>,
   *   frame?: number,
   * }} args
   * @returns {THREE.Texture|null} Scene-UV mask texture or `null` when unavailable.
   */
  run({ params, viewedIndex, floors, frame = -1 }) {
    const renderer = this.renderer;
    const t0 = (typeof performance !== "undefined" && performance?.now)
      ? performance.now()
      : Date.now();

    if (!renderer) return this._skip("no-renderer", frame);
    if (!params || params.enabled === false) return this._skip("disabled", frame);
    if (!Array.isArray(floors) || floors.length === 0) {
      return this._skip("no-floors", frame);
    }

    // Viewed floor must exist. The ray-march needs at least one silhouette
    // source — either an authored `_Outdoors` mask (preferred — lets us gate
    // the receiver to outdoor ground) or the floor's albedo alpha (fallback
    // — treats solid-geometry pixels as the caster). If neither exists there
    // is literally no data to march against, so we skip.
    const viewed = floors.find((f) => f.floorIndex === viewedIndex) ?? null;
    if (!viewed) return this._skip("no-viewed-floor", frame);
    if (!viewed.outdoorsTex && !viewed.albedoTex) {
      return this._skip("no-viewed-silhouette-source", frame);
    }

    const sunDir = _deriveSunDir(params);
    const size = this._chooseTargetSize(floors, params);
    if (!size) return this._skip("no-target-size", frame);

    this._ensureTargets(size.width, size.height);
    if (!this._outputRT) return this._skip("rt-alloc-failed", frame);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevClearColor = new THREE.Color();
    renderer.getClearColor(prevClearColor);
    const prevClearAlpha = renderer.getClearAlpha();

    let cascadedFloors = 0;

    try {
      renderer.setClearColor(0x000000, 0);
      renderer.autoClear = true;

      // --- Step 1: initialize running state on stateRTA → (R=0, G=1). ---
      this._drawInitState(renderer, this._stateRTA);
      /** @type {THREE.WebGLRenderTarget} */ let read = this._stateRTA;
      /** @type {THREE.WebGLRenderTarget} */ let write = this._stateRTB;

      // --- Step 2: cascade upper floors bottom-up. ---
      //
      // Upper floors project via their *albedo alpha* — which IS the
      // solid-geometry silhouette for that floor — and are gated through
      // their own alpha holes downstream in the cascade step. We intentionally
      // do NOT require an authored `_Outdoors` mask on upper floors since
      // most Foundry maps don't ship one; the albedo mask is both necessary
      // (for cascade gating) and sufficient (for silhouette casting).
      const upperFloors = floors
        .filter((f) => f.floorIndex > viewedIndex && f.albedoTex)
        .sort((a, b) => a.floorIndex - b.floorIndex);

      for (const upper of upperFloors) {
        const floorOccluderTex = this._buildFloorOccluderAlphaTexture(
          renderer,
          Array.isArray(upper.occluderTexArray) ? upper.occluderTexArray : [upper.albedoTex].filter(Boolean),
        );
        this._drawProject(renderer, this._strengthRT, {
          params,
          sunDir,
          sizePx: size,
          silhouetteSource: 1,
          outdoorsTex: upper.outdoorsTex,
          albedoTex: upper.albedoTex,
          receiverGateWeight: 0,
        });
        this._drawCascade(renderer, write, {
          prevStateTex: read.texture,
          floorStrengthTex: this._strengthRT.texture,
          floorOccluderTex: floorOccluderTex ?? upper.albedoTex,
          params,
        });
        const swap = read;
        read = write;
        write = swap;
        cascadedFloors++;
      }

      // --- Step 3: local shadow of the viewed floor. ---
      //
      // Only runs when the viewed floor has an authored `_Outdoors` mask —
      // without it we have no way to distinguish outdoor ground (valid
      // receiver) from solid building interior (alpha == 1 everywhere on the
      // ground plate would otherwise bathe the whole viewport in shadow).
      // Upper-floor cascade contributions still come through via `read.texture`
      // regardless.
      const hasLocalStrength = !!viewed.outdoorsTex;
      if (hasLocalStrength) {
        this._drawProject(renderer, this._strengthRT, {
          params,
          sunDir,
          sizePx: size,
          silhouetteSource: 0,
          outdoorsTex: viewed.outdoorsTex,
          albedoTex: viewed.albedoTex,
          receiverGateWeight: 1,
        });
      } else {
        // Clear strength RT so the combine step sees sV = 0 and only the
        // cascaded upper-floor shadow survives.
        this._drawInitZero(renderer, this._strengthRT);
      }

      // --- Step 4: final combine → _outputRT. ---
      this._drawCombine(renderer, this._outputRT, {
        localStrengthTex: this._strengthRT.texture,
        stateTex: read.texture,
      });
    } catch (err) {
      this.warn("V3BuildingShadowsPass run failed", err);
      this._diag.lastSkipReason = "exception";
      this._diag.totalSkips++;
      return null;
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setClearColor(prevClearColor, prevClearAlpha);
      renderer.autoClear = prevAutoClear;
    }

    const t1 = (typeof performance !== "undefined" && performance?.now)
      ? performance.now()
      : Date.now();

    this._diag.lastRunFrame = frame;
    this._diag.lastRunMs = t1 - t0;
    this._diag.lastRtSize = [size.width, size.height];
    this._diag.lastFloorCount = floors.length;
    this._diag.lastViewedIndex = viewedIndex;
    this._diag.lastCascadedFloors = cascadedFloors;
    this._diag.lastHadOutput = true;
    this._diag.lastSkipReason = null;
    this._diag.totalRuns++;

    return this._outputRT.texture;
  }

  /**
   * @param {string} reason
   * @param {number} frame
   * @returns {null}
   * @private
   */
  _skip(reason, frame) {
    this._diag.lastSkipReason = reason;
    this._diag.lastRunFrame = frame;
    this._diag.lastHadOutput = false;
    this._diag.totalSkips++;
    return null;
  }

  /**
   * Pick a scene-UV render-target size from the supplied floors' mask native
   * resolutions. Follows {@link V3DerivedMaskPass._targetSize}'s convention
   * (max native edge) so the occlusion texture lines up with `skyReach` and
   * authored masks sampled by {@link V3IlluminationPipeline}.
   *
   * @param {Array<{ outdoorsTex: THREE.Texture|null }>} floors
   * @param {BuildingShadowsParams} params
   * @returns {{ width: number, height: number }|null}
   * @private
   */
  _chooseTargetSize(floors, params) {
    let maxW = 0;
    let maxH = 0;
    for (const f of floors) {
      const texes = [
        f.outdoorsTex,
        f.albedoTex,
        ...(Array.isArray(f.occluderTexArray) ? f.occluderTexArray : []),
      ];
      for (const t of texes) {
        const img = t?.image;
        const iw = img?.width ?? img?.naturalWidth ?? 0;
        const ih = img?.height ?? img?.naturalHeight ?? 0;
        if (iw > maxW) maxW = iw;
        if (ih > maxH) maxH = ih;
      }
    }
    if (maxW <= 0 || maxH <= 0) return null;

    const rawScale = Number(params?.resolutionScale);
    const scale = Number.isFinite(rawScale) ? Math.max(0.25, Math.min(2.0, rawScale)) : 1.0;
    let w = Math.max(1, Math.round(maxW * scale));
    let h = Math.max(1, Math.round(maxH * scale));

    const cap = Math.min(
      MAX_EDGE_PX,
      (this.renderer?.capabilities?.maxTextureSize | 0) || MAX_EDGE_PX,
    );
    const longestEdge = Math.max(w, h);
    if (longestEdge > cap) {
      const s = cap / longestEdge;
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    if (Math.max(w, h) < MIN_EDGE_PX) {
      const s = MIN_EDGE_PX / Math.max(w, h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    return { width: w, height: h };
  }

  /**
   * @param {number} width
   * @param {number} height
   * @private
   */
  _ensureTargets(width, height) {
    const make = () => {
      const rt = new THREE.WebGLRenderTarget(width, height, {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping,
        wrapT: THREE.ClampToEdgeWrapping,
        colorSpace: THREE.NoColorSpace,
        generateMipmaps: false,
        type: THREE.UnsignedByteType,
      });
      rt.texture.flipY = V3_LEVEL_TEXTURE_FLIP_Y;
      return rt;
    };
    const ensure = (prop) => {
      const existing = this[prop];
      if (existing && existing.width === width && existing.height === height) {
        return;
      }
      try { existing?.dispose(); } catch (_) {}
      this[prop] = make();
    };
    ensure("_strengthRT");
    ensure("_stateRTA");
    ensure("_stateRTB");
    ensure("_occluderRTA");
    ensure("_occluderRTB");
    ensure("_outputRT");
  }

  _disposeTargets() {
    for (const k of ["_strengthRT", "_stateRTA", "_stateRTB", "_occluderRTA", "_occluderRTB", "_outputRT"]) {
      try { this[k]?.dispose(); } catch (_) {}
      this[k] = null;
    }
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @private
   */
  _drawInitState(renderer, dst) {
    this._mesh.material = this._initStateMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }

  /**
   * Clear `dst` to `(0,0,0,1)`. Used when the viewed floor has no authored
   * silhouette source so the combine step sees `sV = 0` and lets the
   * upper-floor cascade contribution pass through unmodified.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @private
   */
  _drawInitZero(renderer, dst) {
    renderer.setRenderTarget(dst);
    const prevClearColor = new THREE.Color();
    renderer.getClearColor(prevClearColor);
    const prevClearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.setClearColor(prevClearColor, prevClearAlpha);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @param {THREE.Texture} sourceTex
   * @private
   */
  _drawOccluderSeed(renderer, dst, sourceTex) {
    const u = this._occluderSeedMaterial.uniforms;
    u.uSource.value = sourceTex;
    this._mesh.material = this._occluderSeedMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @param {THREE.Texture} prevTex
   * @param {THREE.Texture} addTex
   * @private
   */
  _drawOccluderMax(renderer, dst, prevTex, addTex) {
    const u = this._occluderMaxMaterial.uniforms;
    u.uPrev.value = prevTex;
    u.uAdd.value = addTex;
    this._mesh.material = this._occluderMaxMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }

  /**
   * Build one floor's blocker alpha texture by max-combining the alpha channel
   * of all supplied occluder textures (albedo + overhead + tiles).
   *
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture[]} occluderTexArray
   * @returns {THREE.Texture|null}
   * @private
   */
  _buildFloorOccluderAlphaTexture(renderer, occluderTexArray) {
    if (!Array.isArray(occluderTexArray) || !occluderTexArray.length) return null;
    const list = occluderTexArray.filter(Boolean);
    if (!list.length || !this._occluderRTA || !this._occluderRTB) return null;
    this._drawOccluderSeed(renderer, this._occluderRTA, list[0]);
    let read = this._occluderRTA;
    let write = this._occluderRTB;
    for (let i = 1; i < list.length; i++) {
      this._drawOccluderMax(renderer, write, read.texture, list[i]);
      const swap = read;
      read = write;
      write = swap;
    }
    return read.texture;
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @param {{
   *   params: BuildingShadowsParams,
   *   sunDir: { x: number, y: number },
   *   sizePx: { width: number, height: number },
   *   silhouetteSource: 0 | 1,
   *   outdoorsTex: THREE.Texture|null,
   *   albedoTex: THREE.Texture|null,
   *   receiverGateWeight: number,
   * }} args
   * @private
   */
  _drawProject(
    renderer,
    dst,
    {
      params,
      sunDir,
      sizePx,
      silhouetteSource,
      outdoorsTex,
      albedoTex,
      receiverGateWeight,
    },
  ) {
    const u = this._projectMaterial.uniforms;
    // When a texture is missing we still need a bound sampler (WebGL2 doesn't
    // allow sampling from null). Feeding the other texture as a harmless
    // placeholder keeps the sampler valid; the shader's `uSilhouetteSource`
    // decides which one is actually read.
    u.uSilhouetteSource.value = silhouetteSource > 0.5 ? 1 : 0;
    u.uOutdoors.value = outdoorsTex ?? albedoTex ?? null;
    u.uAlbedo.value = albedoTex ?? outdoorsTex ?? null;
    u.uTexelSize.value.set(1 / Math.max(1, sizePx.width), 1 / Math.max(1, sizePx.height));
    u.uSunDir.value.set(sunDir.x, sunDir.y);
    u.uLength.value = clampPositive(params.length, 0, 2, 0.22);
    u.uSoftness.value = clampPositive(params.softness, 0.1, 8, 3.0);
    u.uSmear.value = clamp01(params.smear ?? 0.65);
    u.uPenumbra.value = clamp01(params.penumbra ?? 0.5);
    u.uShadowCurve.value = clampPositive(params.shadowCurve, 0.1, 3, 0.9);
    u.uReceiverGateWeight.value = clamp01(receiverGateWeight);

    this._mesh.material = this._projectMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @param {{
   *   prevStateTex: THREE.Texture,
   *   floorStrengthTex: THREE.Texture,
   *   floorOccluderTex: THREE.Texture,
   *   params: BuildingShadowsParams,
   * }} args
   * @private
   */
  _drawCascade(renderer, dst, { prevStateTex, floorStrengthTex, floorOccluderTex, params }) {
    const u = this._cascadeMaterial.uniforms;
    u.uPrevState.value = prevStateTex;
    u.uFloorStrength.value = floorStrengthTex;
    u.uFloorOccluder.value = floorOccluderTex;
    const lo = clamp01(params.alphaHoleLo ?? 0.1);
    let hi = clamp01(params.alphaHoleHi ?? 0.9);
    if (hi <= lo) hi = Math.min(1, lo + 0.01);
    u.uAlphaHoleLo.value = lo;
    u.uAlphaHoleHi.value = hi;

    this._mesh.material = this._cascadeMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} dst
   * @param {{ localStrengthTex: THREE.Texture, stateTex: THREE.Texture }} args
   * @private
   */
  _drawCombine(renderer, dst, { localStrengthTex, stateTex }) {
    const u = this._combineMaterial.uniforms;
    u.uLocalStrength.value = localStrengthTex;
    u.uState.value = stateTex;

    this._mesh.material = this._combineMaterial;
    renderer.setRenderTarget(dst);
    renderer.render(this._quadScene, this._quadCamera);
  }
}

/**
 * @typedef {{
 *   enabled: boolean,
 *   opacity: number,
 *   length: number,
 *   softness: number,
 *   smear: number,
 *   penumbra: number,
 *   shadowCurve: number,
 *   blurRadius: number,
 *   resolutionScale: number,
 *   alphaHoleLo: number,
 *   alphaHoleHi: number,
 *   sunAzimuthDeg: number,
 *   sunLatitude: number,
 * }} BuildingShadowsParams
 */

/** Stable defaults shared with {@link V3MaskDebugStorage}. */
export const V3_BUILDING_SHADOWS_DEFAULTS = Object.freeze({
  enabled: true,
  opacity: 0.65,
  length: 0.22,
  softness: 3.0,
  smear: 0.65,
  penumbra: 0.5,
  shadowCurve: 0.9,
  blurRadius: 1.6,
  resolutionScale: 1.0,
  alphaHoleLo: 0.1,
  alphaHoleHi: 0.9,
  sunAzimuthDeg: 135,
  sunLatitude: 0.45,
});

/**
 * @param {BuildingShadowsParams} params
 * @returns {{ x: number, y: number }}
 */
function _deriveSunDir(params) {
  const lat = clamp01(Number(params?.sunLatitude ?? 0.45));
  const azRaw = Number(params?.sunAzimuthDeg);
  const az = Number.isFinite(azRaw) ? azRaw : 135;
  const rad = (az * Math.PI) / 180;
  // Matches V2 orientation: azimuth 0 projects straight "up" the scene (toward
  // decreasing y in scene UV, since flipY is applied at texture upload).
  const x = -Math.sin(rad);
  const y = -Math.cos(rad) * lat;
  // Guard against degenerate zero vector from lat=0 + az=180.
  const len = Math.sqrt(x * x + y * y);
  if (len < 1e-4) return { x: 0, y: -1 };
  return { x: x / len, y: y / len };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * @param {unknown} v
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 */
function clampPositive(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
