/**
 * @fileoverview Dynamic Exposure Manager - token-based eye adaptation using a small GPU probe.
 * Samples the pre-color-correction scene under the subject token, then applies a smoothed
 * exposure multiplier to ColorCorrectionEffect.
 *
 * This is intentionally per-client ("your eyes"), not per-token.
 *
 * @module core/DynamicExposureManager
 */

import { createLogger } from './log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('DynamicExposure');

export class DynamicExposureManager {
  /**
   * @param {{renderer: THREE.WebGLRenderer, camera: THREE.Camera, weatherController?: any, tokenManager?: any, colorCorrectionEffect?: any}} options
   */
  constructor(options = {}) {
    /** @type {THREE.WebGLRenderer|null} */
    this.renderer = options.renderer ?? null;

    /** @type {THREE.Camera|null} */
    this.camera = options.camera ?? null;

    /** @type {any|null} */
    this.weatherController = options.weatherController ?? (window.MapShine?.weatherController ?? null);

    /** @type {any|null} */
    this.tokenManager = options.tokenManager ?? (window.MapShine?.tokenManager ?? null);

    /** @type {any|null} */
    this.colorCorrectionEffect = options.colorCorrectionEffect ?? (window.MapShine?.colorCorrectionEffect ?? null);

    this.params = {
      enabled: true,

      // Exposure multiplier bounds (applied on top of ColorCorrectionEffect.params.exposure)
      minExposure: 0.5,
      maxExposure: 2.5,

      // How often we read back the probe (Hz). Readbacks can be expensive.
      probeHz: 8,

      // Time constants (seconds)
      // In "dazzle" mode we apply an impulse on transitions, then decay back to neutral.
      // tauBrighten: decay time when exposure is above neutral (after dark -> bright)
      // tauDarken: decay time when exposure is below neutral (after bright -> dark)
      tauBrighten: 15.0,
      tauDarken: 15.0,

      // Sensitivity for how strong the impulse should be based on brightness delta (log2 space).
      // Higher = bigger spikes.
      shockGainBright: 1.0,
      shockGainDark: 1.0,

      // Ignore tiny luminance changes (log2 units). 0.25 ~= 1.19x, 0.5 ~= 1.41x
      shockThreshold: 0.25,

      // HDR luminance encoding scale for RGBA8 probe output
      // lumaEncoded = clamp(luma / lumaScale, 0..1)
      lumaScale: 4.0,

      // --- Dazzle Overlay (fullscreen flash) ---
      dazzleEnabled: true,
      // Absolute brightness trigger (measured scene luma under token)
      dazzleBrightLumaThreshold: 3.0,
      dazzleBrightGain: 0.65,

      // Indoors -> outdoors transition trigger (roof mask change)
      dazzleOutdoorsThreshold: 0.7,
      dazzleOutdoorsGain: 0.85,

      // Environmental gates
      dazzleMaxDarkness: 0.15,
      dazzleMaxCloudCover: 0.60,

      // Dazzle envelope
      // When a trigger fires, intensity ramps up to a peak over this duration, then decays back to 0.
      // This avoids re-triggering each tile as the token moves.
      dazzleRampSeconds: 3.0,
      dazzleDecaySeconds: 2.5,

      // Minimum time between separate dazzle events (after returning to near-zero)
      dazzleCooldownSeconds: 0.35
    };

    // Internal state
    this._subjectTokenId = null;
    this._measuredLuma = 0.18;
    this._targetExposure = 1.0;
    this._appliedExposure = 1.0;
    this._logAppliedExposure = 0.0;

    // Dazzle impulse model: this value decays toward 0 (neutral) over time.
    this._shockLog = 0.0;
    this._prevLogLuma = null;

    // Fullscreen dazzle overlay intensity (0..1)
    this._dazzle = 0.0;
    this._dazzlePeak = 0.0;
    this._dazzlePhase = 'idle'; // 'idle' | 'ramp' | 'decay'
    this._dazzlePhaseT = 0.0;
    this._dazzleCooldownT = 0.0;
    this._prevOutdoors = null;

    this._probeTimer = 0.0;
    this._lastProbeElapsed = 0.0;

    // Used to suppress sampling while the subject token is animating.
    // We only want to adapt once at the final destination rather than flickering
    // across intermediate tiles.
    this._wasSubjectAnimating = false;

    // Cached reusable objects (avoid allocations in update)
    const THREE = window.THREE;
    this._tmpVec3 = THREE ? new THREE.Vector3() : null;
    this._tmpNdc = THREE ? new THREE.Vector3() : null;

    this._readbackRGBA = new Uint8Array(4);

    // Probe render resources
    this._probeScene = null;
    this._probeCamera = null;
    this._probeMesh = null;
    this._probeMaterial = null;
    this._probeTarget = null;

    // Small debug snapshot for UI bindings.
    this.debugState = {
      subjectTokenId: '',
      measuredLuma: 0.0,
      outdoors: 0.0,
      targetExposure: 1.0,
      appliedExposure: 1.0,
      dazzle: 0.0,
      screenU: 0.0,
      screenV: 0.0,
      lastProbeAgeSeconds: 0.0
    };

    this._initialized = false;
  }

  setTokenManager(tokenManager) {
    this.tokenManager = tokenManager;
  }

  setWeatherController(weatherController) {
    this.weatherController = weatherController;
  }

  setColorCorrectionEffect(colorCorrectionEffect) {
    this.colorCorrectionEffect = colorCorrectionEffect;
  }

  setParams(next) {
    if (!next || typeof next !== 'object') return;
    Object.assign(this.params, next);
  }

  getSubjectTokenId() {
    return this._subjectTokenId;
  }

  /**
   * @param {string} tokenId
   */
  getContextForToken(tokenId) {
    if (!tokenId) return null;
    if (tokenId !== this._subjectTokenId) return null;

    return {
      tokenId: this._subjectTokenId,
      measuredLuma: this._measuredLuma,
      targetExposure: this._targetExposure,
      appliedExposure: this._appliedExposure
    };
  }

  _ensureProbeResources() {
    if (this._initialized) return;

    const THREE = window.THREE;
    if (!THREE || !this.renderer) return;

    // Internal scene for a single full-screen quad.
    this._probeScene = new THREE.Scene();
    this._probeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._probeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tSource: { value: null },
        uUv: { value: new THREE.Vector2(0.5, 0.5) },
        uLumaScale: { value: this.params.lumaScale ?? 4.0 }
      },
      vertexShader: `
        void main() {
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tSource;
        uniform vec2 uUv;
        uniform float uLumaScale;

        float ms_luma(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        void main() {
          vec2 uv = clamp(uUv, vec2(0.001), vec2(0.999));
          vec3 col = texture2D(tSource, uv).rgb;
          float l = ms_luma(col);
          float enc = clamp(l / max(uLumaScale, 0.0001), 0.0, 1.0);
          gl_FragColor = vec4(enc, enc, enc, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false
    });

    const geo = new THREE.PlaneGeometry(2, 2);
    this._probeMesh = new THREE.Mesh(geo, this._probeMaterial);
    this._probeScene.add(this._probeMesh);

    // 1x1 RGBA8 target: cheapest possible readback.
    this._probeTarget = new THREE.WebGLRenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false
    });

    this._initialized = true;
    log.debug('DynamicExposure probe initialized');
  }

  _resolveSubjectTokenId() {
    try {
      const controlled = canvas?.tokens?.controlled;
      if (Array.isArray(controlled) && controlled.length > 0) {
        return controlled[0]?.document?.id ?? controlled[0]?.id ?? null;
      }
    } catch (_) {
    }
    return null;
  }

  _getSubjectWorldPosition(outVec3) {
    if (!outVec3) return null;
    const tokenId = this._subjectTokenId;
    if (!tokenId || !this.tokenManager?.getTokenSprite) return null;

    const sprite = this.tokenManager.getTokenSprite(tokenId);
    if (!sprite) return null;

    outVec3.copy(sprite.position);
    return outVec3;
  }

  _worldToScreenUv(worldPos, outUv) {
    if (!worldPos || !outUv || !this.camera) return false;

    const ndc = this._tmpNdc;
    if (!ndc) return false;

    ndc.copy(worldPos);
    ndc.project(this.camera);

    outUv.x = ndc.x * 0.5 + 0.5;
    outUv.y = ndc.y * 0.5 + 0.5;
    return true;
  }

  _worldToRoofUv(foundryX, foundryY) {
    const rect = canvas?.dimensions?.sceneRect;
    const sceneX = Number(rect?.x) || 0;
    const sceneY = Number(rect?.y) || 0;
    const sceneW = Math.max(1, Number(rect?.width) || 1);
    const sceneH = Math.max(1, Number(rect?.height) || 1);

    const u = (foundryX - sceneX) / sceneW;
    const v = 1.0 - (foundryY - sceneY) / sceneH;

    return {
      u: Math.max(0, Math.min(1, u)),
      v: Math.max(0, Math.min(1, v))
    };
  }

  _sampleOutdoors(foundryX, foundryY) {
    const wc = this.weatherController ?? window.MapShine?.weatherController ?? window.MapShine?.weather;
    if (!wc || typeof wc.getRoofMaskIntensity !== 'function') return 1.0;

    const uv = this._worldToRoofUv(foundryX, foundryY);
    try {
      return wc.getRoofMaskIntensity(uv.u, uv.v);
    } catch (_) {
      return 1.0;
    }
  }

  _getProbeSourceTexture() {
    const cc = this.colorCorrectionEffect;
    if (!cc) return null;

    // We want the pre-color-correction input (but still includes lighting and other earlier PP passes).
    if (typeof cc.getInputTexture === 'function') {
      try {
        return cc.getInputTexture();
      } catch (_) {
      }
    }

    // Fallbacks (best-effort): use whatever the effect tracked.
    return cc?._readBuffer?.texture ?? cc?._inputTexture ?? null;
  }

  _runProbe(timeInfo) {
    const tex = this._getProbeSourceTexture();
    if (!tex) return false;

    const THREE = window.THREE;
    if (!THREE || !this.renderer) return false;

    this._ensureProbeResources();
    if (!this._probeMaterial || !this._probeTarget || !this._probeScene || !this._probeCamera) return false;

    // Determine screen UV under subject token.
    const worldPos = this._tmpVec3;
    if (!worldPos) return false;
    if (!this._getSubjectWorldPosition(worldPos)) return false;

    const uv = this._probeMaterial.uniforms.uUv.value;
    if (!uv) return false;

    if (!this._worldToScreenUv(worldPos, uv)) return false;

    // Update debug UV values immediately (even if readback fails)
    this.debugState.screenU = uv.x;
    this.debugState.screenV = uv.y;

    // Render probe
    const prevTarget = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;

    try {
      this._probeMaterial.uniforms.tSource.value = tex;
      this._probeMaterial.uniforms.uLumaScale.value = this.params.lumaScale ?? 4.0;

      this.renderer.setRenderTarget(this._probeTarget);
      this.renderer.autoClear = true;
      this.renderer.clear();
      this.renderer.render(this._probeScene, this._probeCamera);

      this.renderer.readRenderTargetPixels(this._probeTarget, 0, 0, 1, 1, this._readbackRGBA);

      const enc = this._readbackRGBA[0] / 255.0;
      const luma = enc * (this.params.lumaScale ?? 4.0);
      this._measuredLuma = Math.max(0.0001, luma);

      this._lastProbeElapsed = Number(timeInfo?.elapsed) || 0;
      return true;
    } catch (e) {
      // Readback can fail on some platforms; fail soft.
      if (Math.random() < 0.01) {
        log.warn('DynamicExposure probe failed:', e);
      }
      return false;
    } finally {
      this.renderer.autoClear = prevAutoClear;
      this.renderer.setRenderTarget(prevTarget);
    }
  }

  _updateDazzleImpulse(outdoors) {
    const p = this.params;
    const luma = Math.max(0.0001, this._measuredLuma);
    const logLuma = Math.log2(luma);

    // Optional outdoors bias could go here later (Phase 2).
    // For now, purely driven by measured luma.

    if (Number.isFinite(this._prevLogLuma)) {
      const delta = logLuma - this._prevLogLuma;
      const thr = Math.max(0, Number(p.shockThreshold) || 0);

      if (delta > thr) {
        // Dark -> Bright: spike exposure upward (dazzle / blown out)
        const gain = Math.max(0, Number(p.shockGainBright) || 0);
        this._shockLog += (delta - thr) * gain;
      } else if (delta < -thr) {
        // Bright -> Dark: spike exposure downward (momentarily too-dark)
        const gain = Math.max(0, Number(p.shockGainDark) || 0);
        this._shockLog += (delta + thr) * gain;
      }
    }

    this._prevLogLuma = logLuma;

    // Target is always neutral in dazzle mode.
    this._targetExposure = 1.0;

    // Update debug
    this.debugState.outdoors = outdoors;
    this.debugState.targetExposure = 1.0;
  }

  _decayAndApplyExposure(dt) {
    const p = this.params;

    // Decay shock back to 0 over time. Use different time constants depending on sign.
    const shock = this._shockLog;
    const tau = Math.max(0.0001, Number(shock >= 0 ? p.tauBrighten : p.tauDarken) || 15.0);

    // Exponential decay toward 0.
    const alpha = 1.0 - Math.exp(-Math.max(0, dt) / tau);
    this._shockLog = shock + (0.0 - shock) * alpha;

    // Convert back to multiplier and clamp.
    const minE = Math.max(0.01, Number(p.minExposure) || 0.5);
    const maxE = Math.max(minE, Number(p.maxExposure) || 2.5);

    const applied = Math.pow(2, this._shockLog);
    this._appliedExposure = Math.max(minE, Math.min(maxE, applied));
    this._logAppliedExposure = Math.log2(Math.max(0.0001, this._appliedExposure));

    this.debugState.appliedExposure = this._appliedExposure;
  }

  _getSceneDarkness01() {
    try {
      const le = window.MapShine?.lightingEffect;
      if (le && typeof le.getEffectiveDarkness === 'function') {
        const d = le.getEffectiveDarkness();
        return (typeof d === 'number' && Number.isFinite(d)) ? Math.max(0.0, Math.min(1.0, d)) : 0.0;
      }
    } catch (_) {
    }
    try {
      const env = canvas?.environment;
      const d = env?.darknessLevel;
      return (typeof d === 'number' && Number.isFinite(d)) ? Math.max(0.0, Math.min(1.0, d)) : 0.0;
    } catch (_) {
    }
    return 0.0;
  }

  _getCloudCover01() {
    try {
      const wc = this.weatherController ?? window.MapShine?.weatherController ?? window.MapShine?.weather;
      if (!wc) return 0.0;
      const state = (typeof wc.getCurrentState === 'function') ? wc.getCurrentState() : (wc.currentState ?? null);
      const c = state?.cloudCover;
      return (typeof c === 'number' && Number.isFinite(c)) ? Math.max(0.0, Math.min(1.0, c)) : 0.0;
    } catch (_) {
    }
    return 0.0;
  }

  _updateDazzleOverlay(dt, outdoors) {
    const p = this.params;

    // Clamp dt (protect against huge frame gaps causing envelope jumps).
    const dts = Math.max(0.0, Math.min(0.25, Number(dt) || 0.0));

    const enabled = p.dazzleEnabled !== false;
    if (!enabled) {
      this._dazzle = 0.0;
      this._dazzlePeak = 0.0;
      this._dazzlePhase = 'idle';
      this._dazzlePhaseT = 0.0;
      this._dazzleCooldownT = 0.0;
      this._prevOutdoors = outdoors;
      this.debugState.dazzle = 0.0;
      return;
    }

    // Environmental gating (for the outdoors transition trigger).
    const darkness = this._getSceneDarkness01();
    const cloudCover = this._getCloudCover01();
    const gate =
      (darkness <= (Number.isFinite(p.dazzleMaxDarkness) ? p.dazzleMaxDarkness : 0.15)) &&
      (cloudCover <= (Number.isFinite(p.dazzleMaxCloudCover) ? p.dazzleMaxCloudCover : 0.60));

    let triggerStrength = 0.0;

    // Trigger A: absolute brightness under token.
    const luma = Math.max(0.0, this._measuredLuma || 0.0);
    const thr = Math.max(0.0, Number(p.dazzleBrightLumaThreshold) || 0.0);
    if (thr > 0.0 && luma > thr) {
      const gain = Math.max(0.0, Number(p.dazzleBrightGain) || 0.0);
      const over = (luma - thr) / Math.max(1e-5, thr);
      triggerStrength = Math.max(triggerStrength, gain * Math.min(1.0, over));
    }

    // Trigger B: indoors -> outdoors transition.
    const prev = this._prevOutdoors;
    this._prevOutdoors = outdoors;
    if (gate && Number.isFinite(prev)) {
      const oThr = Math.max(0.0, Math.min(1.0, Number(p.dazzleOutdoorsThreshold) || 0.7));
      const wasIndoors = prev < oThr;
      const nowOutdoors = outdoors >= oThr;
      if (wasIndoors && nowOutdoors) {
        const gain = Math.max(0.0, Number(p.dazzleOutdoorsGain) || 0.0);
        // Stronger when stepping into "more outdoors".
        const step = Math.max(0.0, outdoors - prev);
        triggerStrength = Math.max(triggerStrength, gain * Math.min(1.0, step / Math.max(1e-5, 1.0 - oThr)));
      }
    }

    // Cooldown timer (only active while idle).
    if (this._dazzlePhase === 'idle' && this._dazzleCooldownT > 0.0) {
      this._dazzleCooldownT = Math.max(0.0, this._dazzleCooldownT - dts);
    }

    // If a trigger fires:
    // - If idle and not cooling down -> start a new event
    // - If already active -> allow raising peak (but do not restart the ramp)
    if (triggerStrength > 0.0) {
      const s = Math.max(0.0, Math.min(1.0, triggerStrength));

      if (this._dazzlePhase === 'idle') {
        if (this._dazzleCooldownT <= 0.0) {
          this._dazzlePhase = 'ramp';
          this._dazzlePhaseT = 0.0;
          this._dazzlePeak = s;
        }
      } else {
        // Active (ramp/decay): don't retrigger each tile, but do allow a stronger event to push peak upward.
        this._dazzlePeak = Math.max(this._dazzlePeak, s);
      }
    }

    // Advance envelope.
    const ramp = Math.max(0.05, Number(p.dazzleRampSeconds) || 3.0);
    const decay = Math.max(0.05, Number(p.dazzleDecaySeconds) || 2.5);

    if (this._dazzlePhase === 'ramp') {
      this._dazzlePhaseT += dts;
      const t01 = Math.max(0.0, Math.min(1.0, this._dazzlePhaseT / ramp));

      // Ease-in to feel like an "eye adjustment" rather than a linear UI tween.
      const eased = t01 * t01 * (3.0 - 2.0 * t01);
      this._dazzle = this._dazzlePeak * eased;

      if (t01 >= 1.0) {
        this._dazzlePhase = 'decay';
        this._dazzlePhaseT = 0.0;
        // Snap to peak at the end of the ramp.
        this._dazzle = this._dazzlePeak;
      }
    } else if (this._dazzlePhase === 'decay') {
      this._dazzlePhaseT += dts;
      const a = 1.0 - Math.exp(-dts / decay);
      this._dazzle = this._dazzle + (0.0 - this._dazzle) * a;

      // Done when near-neutral.
      if (this._dazzle < 0.0025) {
        this._dazzle = 0.0;
        this._dazzlePeak = 0.0;
        this._dazzlePhase = 'idle';
        this._dazzlePhaseT = 0.0;
        this._dazzleCooldownT = Math.max(0.0, Number(p.dazzleCooldownSeconds) || 0.35);
      }
    } else {
      // idle
      this._dazzle = 0.0;
      this._dazzlePeak = 0.0;
    }

    this._dazzle = Math.max(0.0, Math.min(1.0, this._dazzle));
    this.debugState.dazzle = this._dazzle;
  }

  _applyToDazzleOverlay() {
    const de = this;
    const e = window.MapShine?.dazzleOverlayEffect;
    if (!e?.params) return;

    const k = (de.params.enabled && de.params.dazzleEnabled !== false) ? (de._dazzle || 0.0) : 0.0;

    e.params.intensity = k;
    // Keep this effect disabled unless it's actually visible.
    e.enabled = k > 0.002;
  }

  _applyToColorCorrection() {
    const cc = this.colorCorrectionEffect ?? window.MapShine?.colorCorrectionEffect;
    if (!cc?.params) return;

    // The effect will copy params -> uniforms in its own update() call.
    cc.params.dynamicExposure = this.params.enabled ? this._appliedExposure : 1.0;
  }

  update(timeInfo) {
    // Lazy initialize probe resources (requires THREE + renderer)
    this._ensureProbeResources();

    const p = this.params;
    const enabled = p.enabled !== false;

    // Resolve subject token each frame (cheap and keeps behavior intuitive).
    this._subjectTokenId = enabled ? this._resolveSubjectTokenId() : null;

    this.debugState.subjectTokenId = this._subjectTokenId || '';

    // If no subject token, reset to neutral and exit.
    if (!this._subjectTokenId) {
      this._targetExposure = 1.0;
      this._appliedExposure = 1.0;
      this._logAppliedExposure = 0.0;
      this._shockLog = 0.0;
      this._prevLogLuma = null;
      this.debugState.measuredLuma = 0.0;
      this.debugState.targetExposure = 1.0;
      this.debugState.appliedExposure = 1.0;
      this.debugState.lastProbeAgeSeconds = 0.0;
      this._applyToColorCorrection();
      return;
    }

    const dt = Math.min(0.25, Math.max(0.0, Number(timeInfo?.delta) || 0.0));

    // If the token is currently animating, do NOT probe/switch states as it
    // crosses many tiles. We'll sample once when the movement finishes.
    const isAnimating = !!(this.tokenManager?.isTokenAnimating?.(this._subjectTokenId));
    if (this._wasSubjectAnimating && !isAnimating) {
      // Movement just ended: force an immediate probe next update.
      const hz = Math.max(0.1, Number(this.params?.probeHz) || 8);
      const interval = 1.0 / hz;
      this._probeTimer = interval;
    }
    this._wasSubjectAnimating = isAnimating;

    if (isAnimating) {
      // Keep applying the existing exposure smoothly (decay continues), but
      // freeze inputs (luma/outdoors) and avoid dazzle triggers during motion.
      this._decayAndApplyExposure(dt);
      this._applyToColorCorrection();
      return;
    }

    // Compute outdoors under the token (CPU lookup).
    let outdoors = 1.0;
    try {
      const worldPos = this._tmpVec3;
      if (worldPos && this._getSubjectWorldPosition(worldPos)) {
        const foundry = Coordinates.toFoundry(worldPos.x, worldPos.y);
        outdoors = this._sampleOutdoors(foundry.x, foundry.y);
      }
    } catch (_) {
      outdoors = 1.0;
    }

    // Probe throttling
    const hz = Math.max(0.1, Number(p.probeHz) || 8);
    const interval = 1.0 / hz;
    this._probeTimer += dt;

    if (this._probeTimer >= interval) {
      // Reduce timer without letting it grow unbounded.
      this._probeTimer = this._probeTimer % interval;

      const ok = this._runProbe(timeInfo);
      if (ok) {
        this.debugState.measuredLuma = this._measuredLuma;
      }
    }

    const elapsed = Number(timeInfo?.elapsed) || 0;
    this.debugState.lastProbeAgeSeconds = Math.max(0, elapsed - (this._lastProbeElapsed || 0));

    this._updateDazzleImpulse(outdoors);
    this._decayAndApplyExposure(dt);
    this._applyToColorCorrection();

    // Fullscreen dazzle overlay
    this._updateDazzleOverlay(dt, outdoors);
    this._applyToDazzleOverlay();
  }

  dispose() {
    try {
      this._probeTarget?.dispose?.();
    } catch (_) {
    }

    try {
      this._probeMesh?.geometry?.dispose?.();
    } catch (_) {
    }

    try {
      this._probeMaterial?.dispose?.();
    } catch (_) {
    }

    this._probeTarget = null;
    this._probeMesh = null;
    this._probeMaterial = null;
    this._probeScene = null;
    this._probeCamera = null;

    this._initialized = false;
  }
}
