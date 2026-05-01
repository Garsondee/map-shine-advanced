    /**
 * @fileoverview ThreeLightSource
 * Replicates Foundry VTT's PointLightSource logic in Three.js
 */
import Coordinates from '../utils/coordinates.js';
import { FoundryLightingShaderChunks } from './FoundryLightingShaderChunks.js';
import { loadTexture } from '../assets/loader.js';
import { VisionPolygonComputer } from '../vision/VisionPolygonComputer.js';
import { weatherController } from '../core/WeatherController.js';
import { createLogger } from '../core/log.js';
import { getPerspectiveElevation } from '../foundry/elevation-context.js';
import { hasV14NativeLevels } from '../foundry/levels-scene-flags.js';

const _lightLosComputer = new VisionPolygonComputer();
const log = createLogger('ThreeLightSource');

// Torch/flame: fragment uses uTime in many sin() terms. Float32 uniforms quantize
// unbounded animation.time, so tiny per-frame phase steps (especially at low Foundry
// speed) collapse to zero then jump — reads as single-frame pops. CPU-side wrap
// in float64 keeps uploaded values in a well-conditioned range; SmoothNoise still
// uses full this.animation.time via animateTorch().
const FIRE_SHADER_TIME_WRAP = Math.PI * 2 * 256;

class SmoothNoise {
  constructor({ amplitude = 1, scale = 1, maxReferences = 256 } = {}) {
    this.amplitude = amplitude;
    this.scale = scale;

    if (!Number.isInteger(maxReferences) || maxReferences <= 0 || (maxReferences & (maxReferences - 1)) !== 0) {
      throw new Error('SmoothNoise maxReferences must be a positive power-of-2 integer.');
    }

    this._maxReferences = maxReferences;
    this._references = [];
    for (let i = 0; i < this._maxReferences; i++) {
      this._references.push(Math.random());
    }
  }

  get amplitude() {
    return this._amplitude;
  }

  set amplitude(amplitude) {
    if (!Number.isFinite(amplitude) || amplitude === 0) {
      throw new Error('SmoothNoise amplitude must be a finite non-zero number.');
    }
    this._amplitude = amplitude;
  }

  get scale() {
    return this._scale;
  }

  set scale(scale) {
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new Error('SmoothNoise scale must be a finite positive number.');
    }
    this._scale = scale;
  }

  generate(x) {
    const scaledX = x * this._scale;
    const xFloor = Math.floor(scaledX);
    const t = scaledX - xFloor;
    const tSmooth = t * t * (3 - 2 * t);
    const i0 = xFloor & (this._maxReferences - 1);
    const i1 = (i0 + 1) & (this._maxReferences - 1);
    const y = (this._references[i0] * (1 - tSmooth)) + (this._references[i1] * tSmooth);
    return y * this._amplitude;
  }
}

export class ThreeLightSource {
  constructor(document) {
    this.id = document.id;
    this.document = document;
    this.mesh = null;
    this.material = null;

    this._meshParent = null;

    // Use a deterministic seed so animated lights (torch/flame/fairy/etc.) and
    // any cookie wobble remain visually stable across reloads and between clients.
    const seed = (() => {
      try {
        const s = String(document?.id ?? '');
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          // FNV-1a style mixing
          h = Math.imul(h, 16777619);
        }
        return Math.abs(h) % 100000;
      } catch (_) {
        return 1;
      }
    })();

    this.animation = {
      seed,
      time: 0,
      noise: null,
      reactiveSoundAmplitude: 0
    };

    this._baseRadiusPx = 0;
    this._baseBrightRadiusPx = 0;
    this._baseRatio = 1;

    // Cookie/gobo texture support (MapShine-native lights)
    this._cookiePath = null;
    this._cookieTexture = null;
    this._cookieLoadVersion = 0;
    this._cookieRetryTimeoutId = null;
    this._cookieFailCount = 0;
    this._cookieDebugState = { path: null, enabled: null };

    /**
     * Track whether we are currently using a simple circular geometry
     * fallback instead of the wall-clipped LOS polygon. This can happen
     * if the LightSource LOS has not been initialized yet at the moment
     * this ThreeLightSource is constructed. We will attempt to upgrade
     * to the proper LOS polygon lazily in updateAnimation().
     * @type {boolean}
     */
    this._usingCircleFallback = false;

    this._lastInsetWorldPx = null;
    this._lastInsetUpdateAtSec = -Infinity;
    this._lastInsetZoom = null;
    // Reused scratch vector for perspective zoom estimation (avoid per-frame allocs).
    this._tmpDrawingBufferSize = null;

    // Motion animation state (e.g. wind-driven cable swing)
    this._motion = {
      hasAnchor: false,
      anchorFoundryX: 0,
      anchorFoundryY: 0,
      offsetWorld: null,
      velocityWorld: null,
      tmpDirWorld: null,
      tmpWorldPos: null,
      gustNoise: null,
    };
  }

  _getOutdoorFactorAtFoundryXY(x, y) {
    try {
      const rect = canvas?.dimensions?.sceneRect;
      const sceneX = Number(rect?.x) || 0;
      const sceneY = Number(rect?.y) || 0;
      const sceneW = Number(rect?.width) || 1;
      const sceneH = Number(rect?.height) || 1;

      const u0 = (x - sceneX) / Math.max(1, sceneW);
      // WeatherController.getRoofMaskIntensity reads mask data extracted from an HTMLCanvas
      // (top-left origin), so v=0 is top and v=1 is bottom (no flip).
      const v0 = (y - sceneY) / Math.max(1, sceneH);
      const u = Math.max(0.0, Math.min(1.0, u0));
      const v = Math.max(0.0, Math.min(1.0, v0));

      const w = this._getWeatherController();
      if (!w || typeof w.getRoofMaskIntensity !== 'function') return 1.0;
      const f = w.getRoofMaskIntensity(u, v);
      return (typeof f === 'number' && Number.isFinite(f)) ? Math.max(0.0, Math.min(1.0, f)) : 1.0;
    } catch (_) {
      return 1.0;
    }
  }

  _getWeatherController() {
    try {
      const w0 = window.MapShine?.weatherController;
      if (w0 && typeof w0.getCurrentState === 'function') return w0;
    } catch (_) {
    }

    return weatherController;
  }

  _getGlobalLightAnimParams() {
    const p = window.MapShine?.lightingEffect?.params;
    const windInfluence = (p && typeof p.lightAnimWindInfluence === 'number' && Number.isFinite(p.lightAnimWindInfluence))
      ? Math.max(0.0, p.lightAnimWindInfluence)
      : 1.0;
    const outdoorPower = (p && typeof p.lightAnimOutdoorPower === 'number' && Number.isFinite(p.lightAnimOutdoorPower))
      ? Math.max(0.0, p.lightAnimOutdoorPower)
      : 2.0;
    return { windInfluence, outdoorPower };
  }

  _getWallInsetPx() {
    try {
      const inset = window.MapShine?.lightingEffect?.params?.wallInsetPx;
      return (typeof inset === 'number' && isFinite(inset)) ? Math.max(0, inset) : 0;
    } catch (_) {
      return 0;
    }
  }

  _getWallInsetWorldPx(zoomOverride = null) {
    const insetPx = this._getWallInsetPx();
    if (!insetPx) return 0;

    // Keep the occlusion inset stable in SCREEN pixels.
    // World units are Foundry pixels; convert screen-pixel inset to world units
    // using the current zoom.
    const zoom = Number.isFinite(zoomOverride) ? zoomOverride : this._getEffectiveZoom();
    if (!Number.isFinite(zoom) || zoom <= 0) return insetPx;
    return insetPx / zoom;
  }

  _getEffectiveZoom() {
    // Prefer deriving the zoom from the camera actually used to render the light
    // accumulation pass. This is the most reliable way to get a world->screen
    // mapping that matches what the user sees.
    try {
      const THREE = window.THREE;
      const cam = window.MapShine?.lightingEffect?.mainCamera || window.MapShine?.sceneComposer?.camera;
      if (cam) {
        if (cam.isOrthographicCamera) {
          const z = cam.zoom;
          if (typeof z === 'number' && isFinite(z) && z > 0) return z;
        } else if (cam.isPerspectiveCamera) {
          const renderer = window.MapShine?.renderer;
          const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
          const camZ = cam.position?.z;
          const fovDeg = cam.fov;

          if (THREE && renderer && typeof camZ === 'number' && isFinite(camZ) && typeof fovDeg === 'number' && isFinite(fovDeg)) {
            const dist = Math.abs(camZ - groundZ);
            if (dist > 0.0001) {
              let size = this._tmpDrawingBufferSize;
              if (!size) {
                size = new THREE.Vector2();
                this._tmpDrawingBufferSize = size;
              }
              renderer.getDrawingBufferSize(size);
              const hPx = size.y;
              const fovRad = fovDeg * (Math.PI / 180);
              const worldH = 2 * dist * Math.tan(fovRad * 0.5);
              const z = hPx / Math.max(1e-6, worldH);
              if (typeof z === 'number' && isFinite(z) && z > 0) return z;
            }
          }
        }
      }
    } catch (_) {
    }

    try {
      const z0 = window.MapShine?.sceneComposer?.currentZoom;
      if (typeof z0 === 'number' && isFinite(z0) && z0 > 0) return z0;
    } catch (_) {
    }

    // Fallback: Foundry's PIXI stage scale.
    try {
      const zStage = canvas?.stage?.scale?.x;
      if (typeof zStage === 'number' && isFinite(zStage) && zStage > 0) return zStage;
    } catch (_) {
    }

    return 1;
  }

  _getGroundZ() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer && typeof sceneComposer.groundZ === 'number') {
      return sceneComposer.groundZ;
    }
    return 1000; // Default ground plane Z
  }

  init() {
    const THREE = window.THREE;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color() },
        uRadius: { value: 0 },       // Max radius (dim)
        uBrightRadius: { value: 0 }, // Core radius (bright)
        // Shift the illumination center within the (stationary) LOS polygon.
        // This allows Cable Swing to "move" the light without forcing geometry rebuilds.
        uCenterOffset: { value: new THREE.Vector2(0, 0) },
        uAlpha: { value: 0.5 },
        uAttenuation: { value: 0.5 },
        uOutputGain: { value: 1.0 },
        uOuterWeight: { value: 0.5 },
        uInnerWeight: { value: 0.5 },
        uTime: { value: 0 },
        uAnimType: { value: 0 },
        uAnimIntensity: { value: 0 },
        uSeed: { value: 0 },
        uIntensity: { value: 1.0 },
        uPulse: { value: 0.0 },
        uBrightness: { value: 1.0 },
        // Foundry photometric controls:
        // - uLuminosity scales emitted strength
        // - uColoration = Foundry "Color Intensity" (0..1), from config.colorIntensity
        //   (not config.coloration, which is the coloration *technique* id)
        uLuminosity: { value: 1.0 },
        uColoration: { value: 0.5 },
        // Cookie/gobo texture (optional)
        tCookie: { value: null },
        uHasCookie: { value: 0.0 },
        uCookieRotation: { value: 0.0 },
        // Per-frame additive cookie rotation (Cable Swing wobble).
        uCookieRotationOffset: { value: 0.0 },
        uCookieScale: { value: 1.0 },
        uCookieStrength: { value: 1.0 },
        uCookieContrast: { value: 1.0 },
        uCookieGamma: { value: 1.0 },
        uCookieInvert: { value: 0.0 },
        uCookieColorize: { value: 0.0 },
        uCookieTint: { value: new THREE.Color(1, 1, 1) },
      },
      vertexShader: `
        varying vec2 vPos;
        void main() {
          vPos = position.xy; 
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vPos;
        uniform vec3 uColor;
        uniform float uRadius;
        uniform float uBrightRadius;
        uniform vec2  uCenterOffset;
        uniform float uAlpha;
        uniform float uAttenuation;
        uniform float uOutputGain;
        uniform float uOuterWeight;
        uniform float uInnerWeight;
        uniform float uTime;
        uniform float uAnimType;
        uniform float uAnimIntensity;
        uniform float uSeed;
        uniform float uIntensity;
        uniform float uPulse;
        uniform float uBrightness;
        uniform float uLuminosity;
        uniform float uColoration;
        uniform sampler2D tCookie;
        uniform float uHasCookie;
        uniform float uCookieRotation;
        uniform float uCookieRotationOffset;
        uniform float uCookieScale;
        uniform float uCookieStrength;
        uniform float uCookieContrast;
        uniform float uCookieGamma;
        uniform float uCookieInvert;
        uniform float uCookieColorize;
        uniform vec3 uCookieTint;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 78.233);
          return fract(p.x * p.y);
        }

        // Foundry VTT PRNG helpers (ported 1:1 from base-shader-mixin.mjs)
        float random(in vec2 uv) {
          uv = mod(uv, 1000.0);
          return fract(dot(uv, vec2(5.23, 2.89)
                            * fract((2.41 * uv.x + 2.27 * uv.y)
                                     * 251.19)) * 551.83);
        }

        vec3 random(in vec3 uv) {
          return vec3(fract(cos(dot(uv, vec3(12.9898,  234.1418,    152.01))) * 43758.5453),
                      fract(sin(dot(uv, vec3(80.9898,  545.8937, 151515.12))) * 23411.1789),
                      fract(cos(dot(uv, vec3(01.9898, 1568.5439,    154.78))) * 31256.8817));
        }

        // Foundry VTT energy-field voronoi3d helper (ported from energy-field.mjs)
        vec3 voronoi3d(const in vec3 x) {
          vec3 p = floor(x);
          vec3 f = fract(x);

          float id = 0.0;
          vec2 res = vec2(100.0);

          for (int k = -1; k <= 1; k++) {
            for (int j = -1; j <= 1; j++) {
              for (int i = -1; i <= 1; i++) {
                vec3 b = vec3(float(i), float(j), float(k));
                vec3 rr = vec3(b) - f + random(p + b);

                float d = dot(rr, rr);
                float cond = max(sign(res.x - d), 0.0);
                float nCond = 1.0 - cond;
                float cond2 = nCond * max(sign(res.y - d), 0.0);
                float nCond2 = 1.0 - cond2;

                id = (dot(p + b, vec3(1.0, 67.0, 142.0)) * cond) + (id * nCond);
                res = vec2(d, res.x) * cond + res * nCond;
                res.y = cond2 * d + nCond2 * res.y;
              }
            }
          }
          return vec3(sqrt(res), pow(abs(id + 10.0), 0.01));
        }

        vec3 rgb2hsv(vec3 c) {
          vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
          vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
          vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
          float d = q.x - min(q.w, q.y);
          float e = 1.0e-10;
          return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
        }

        vec3 hsv2rgb(vec3 c) {
          vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
          vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
          return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        }

        vec3 hsb2rgb(vec3 c) {
          vec3 rgb = clamp(abs(mod(c.x*6.0 + vec3(0.0,4.0,2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          rgb = rgb*rgb*(3.0-2.0*rgb);
          return c.z * mix(vec3(1.0), rgb, c.y);
        }

        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f*f*(3.0-2.0*f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        // Foundry VTT noise + fbm helpers (ported 1:1 from base-shader-mixin.mjs)
        float noise(in vec2 uv) {
          const vec2 d = vec2(0.0, 1.0);
          vec2 b = floor(uv);
          vec2 f = smoothstep(vec2(0.0), vec2(1.0), fract(uv));
          return mix(
            mix(random(b), random(b + d.yx), f.x),
            mix(random(b + d.xy), random(b + d.yy), f.x),
            f.y
          );
        }

        float fbm(vec2 uv) {
          float total = 0.0, amp = 1.0;
          for (int i = 0; i < 3; i++) {
            total += noise(uv) * amp;
            uv += uv;
            amp *= 0.5;
          }
          return total;
        }

        float fbm2(vec2 uv) {
          float total = 0.0, amp = 1.0;
          for (int i = 0; i < 2; i++) {
            total += noise(uv) * amp;
            uv += uv;
            amp *= 0.5;
          }
          return total;
        }

        // Foundry VTT FBMHQ (ported 1:1 from base-shader-mixin.mjs).
        // Must not overload fbm(vec2) — GLSL ES 1.0 (WebGL1) rejects duplicate function names.
        float fbmSmooth(in vec2 uv, in float smoothness) {
          float s = exp2(-smoothness);
          float f = 1.0;
          float a = 1.0;
          float t = 0.0;
          for (int i = 0; i < 3; i++) {
            t += a * noise(f * uv);
            f *= 2.0;
            a *= s;
          }
          return t;
        }

        float fbm4(vec2 uv) {
          float total = 0.0, amp = 1.0;
          for (int i = 0; i < 4; i++) {
            total += noise(uv) * amp;
            uv += uv;
            amp *= 0.5;
          }
          return total;
        }

        // Foundry VTT rotation helper (ported 1:1 from base-shader-mixin.mjs)
        mat2 rot(in float a) {
          float s = sin(a);
          float c = cos(a);
          return mat2(c, -s, s, c);
        }

        // Foundry VTT PIE helper (ported 1:1 from base-shader-mixin.mjs)
        float pie(in vec2 coord, in float angle, in float smoothness, in float l) {
          coord.x = abs(coord.x);
          vec2 va = vec2(sin(angle), cos(angle));
          float lg = length(coord) - l;
          float clg = length(coord - va * clamp(dot(coord, va), 0.0, l));
          return smoothstep(0.0, smoothness, max(lg, clg * sign(va.y * coord.x - va.x * coord.y)));
        }

        void main() {
          vec2 p = vPos - uCenterOffset;
          float distPx = length(p);
          // Normalized distance [0..1]
          float r = distPx / uRadius; 
          vec2 vUvs = (p / (max(uRadius, 1.0) * 2.0)) + vec2(0.5);
          float dist = r;

          if (r >= 1.0) discard;

          // Animation intensity 1..10 → 0..1 (5 ≈ comfortable midpoint for fire tuning).
          float iAnimDrive = clamp((clamp(uAnimIntensity, 0.0, 10.0) - 1.0) / 9.0, 0.0, 1.0);

          // 20 = torch, 21 = flame - both are fire lights: tight screen-space core, not the full dim disk.
          float isTorch = step(19.5, uAnimType) * (1.0 - step(20.5, uAnimType));
          float isFlame = step(20.5, uAnimType) * (1.0 - step(21.5, uAnimType));
          float isFireCore = max(isTorch, isFlame);

          // uAttenuation acts as a "Softness" factor [0..1]
          // 0.0 = Hard Edges (Plateaus)
          // 1.0 = Soft Edges (Linear Gradients)
          float softness = uAttenuation;

          float intensity;

          // Torch (20) + flame (21): wind-warped ember + dim disk (local warp on p only; vUvs/cookies unchanged).
          if (isFireCore > 0.5) {
            float fireChaosAmt = smoothstep(0.03, 0.92, iAnimDrive);
            float ai = mix(0.03, 1.0, pow(iAnimDrive, 0.78));
            float coreGrowth = smoothstep(0.0, 1.0, iAnimDrive);
            float brPx = max(uBrightRadius, 1.5);
            float uRad = max(uRadius, 1.0);

            float wTime = uTime * mix(2.4, 14.0, pow(iAnimDrive, 0.85));
            float seedK = fract(uSeed * 0.001 + 0.37) * 200.0;
            vec2 whipOffset = vec2(
              noise2(vec2(wTime * 0.8, seedK + 1.7)) * 2.0 - 1.0,
              noise2(vec2(wTime * 0.9 + 17.4, seedK + 43.1)) * 2.0 - 1.0
            );
            whipOffset *= mix(0.22, 1.0, fireChaosAmt);
            // ~10x subtler than original whip so the core stays near center (avoids LOS circle clip / hard edge).
            vec2 fireP = p + whipOffset * (brPx * (0.02 + ai * 0.05));
            float lenFp = length(fireP);
            // Angular variation without atan (avoids -x seam + atan(0,0) on some GLES1/ANGLE paths).
            vec2 fdir = fireP * (1.0 / max(lenFp, 0.001));
            float aWarp = dot(fdir, vec2(0.882, -0.472)) * 6.5 + dot(fdir, vec2(0.415, 0.910)) * 4.3;
            float edgeNoise = 0.5 * noise2(vec2(aWarp, wTime * 1.2))
              + 0.5 * noise2(vec2(aWarp * 1.37 + 2.1, wTime * 1.08 + 1.7));
            float distMod = 1.0 - (edgeNoise * (0.03 + ai * 0.04) * mix(0.3, 1.0, fireChaosAmt));
            float fireDistPx = lenFp * distMod;

            float ballPx = mix(1.35, 3.4, coreGrowth) + brPx * mix(0.015, 0.26, coreGrowth);
            ballPx = min(ballPx, mix(11.0, 32.0, coreGrowth));
            ballPx *= mix(1.0, 1.18, isFlame);
            ballPx *= 1.75 * 1.5 * mix(0.68, 1.08, iAnimDrive);
            float fallPow = mix(12.0, 8.0, isFlame) + mix(2.4, 0.0, iAnimDrive);
            float t = fireDistPx / max(ballPx, 0.5);
            float ember = pow(max(0.0, 1.0 - t), fallPow);

            float rn = fireDistPx / uRad;
            float dOut = max(0.0, 1.0 - rn);
            float disk = pow(dOut, 0.88) * 0.62 + pow(dOut, 1.75) * 0.22;

            float twoPi = 6.283185307179586;
            float ph1 = fract(uSeed * 0.1031 + 0.17) * twoPi;
            float ph2 = fract(uSeed * 0.2707 + 0.53) * twoPi;
            float ph3 = fract(uSeed * 0.6113 + 0.09) * twoPi;
            float ph4 = fract(uSeed * 0.881 + 0.31) * twoPi;
            float ph5 = fract(uSeed * 0.337 + 0.61) * twoPi;

            // Global brightness: clkSlow baseline + bursts (per uSeed); chop + modulated pow for irregular bursts.
            float clkSlow = uTime * 0.055;
            float clkEnv = uTime * 0.52;
            float hz1 = 1.05 + 0.42 * fract(uSeed * 0.419);
            float hz2 = 1.48 + 0.52 * fract(uSeed * 0.733);
            float hz3 = 0.72 + 0.38 * fract(uSeed * 0.257);

            float wE0 = 0.14 + 0.22 * fract(uSeed * 0.047);
            float wE1 = 0.17 + 0.26 * fract(uSeed * 0.163);
            float wE2 = 0.19 + 0.24 * fract(uSeed * 0.281);
            float wE3 = 0.11 + 0.19 * fract(uSeed * 0.409);
            float wE4 = 0.08 + 0.16 * fract(uSeed * 0.523);
            float ev1 = 0.5 + 0.5 * sin(clkEnv * wE0 + ph1);
            float ev2 = 0.5 + 0.5 * sin(clkEnv * wE1 + ph2 * 1.63);
            float ev3 = 0.5 + 0.5 * sin(clkEnv * wE2 + ph3 * 0.91);
            float ev4 = 0.5 + 0.5 * sin(clkEnv * wE3 + ph4 * 2.07 + 0.52 * sin(clkEnv * 0.031 + ph1 * 1.3));
            float ev5 = 0.5 + 0.5 * sin(clkEnv * wE4 + ph5 * 1.21 + 0.38 * sin(clkEnv * 0.044 + ph3 * 0.7));
            float burstCore = max(0.0, ev1 * ev2 * ev3);
            float sideCore = max(0.0, ev4 * ev5);
            float bpBurst = 1.12 + 0.82 * (0.5 + 0.5 * sin(clkSlow * 0.016 + ph2 * 1.4)) * (0.5 + 0.5 * sin(clkEnv * 0.019 + ph4 * 0.93));
            float bpSide = 1.22 + 0.88 * (0.5 + 0.5 * sin(clkEnv * 0.017 + ph1 * 1.1)) * (0.5 + 0.5 * sin(clkSlow * 0.022 + ph5 * 1.2));
            float burst = pow(burstCore, bpBurst);
            float sideGate = pow(sideCore, bpSide);
            float chaosPre = clamp(burst * 0.82 + sideGate * 0.36, 0.0, 1.0);
            float chop = 0.5 + 0.5 * (0.5 + 0.5 * sin(clkSlow * 0.025 + ph3 * 1.1)) * (0.5 + 0.5 * sin(clkEnv * 0.029 + ph1 * 1.5)) * (0.5 + 0.5 * sin(clkEnv * 0.015 + ph2 * 0.88));
            float chaosMix = clamp(chaosPre * chop, 0.0, 1.0) * 0.52 * fireChaosAmt;

            float clkEff = clkSlow * mix(1.0, 4.15, chaosMix);

            float driftA = 0.72 + 0.28 * (0.5 + 0.5 * sin(clkEff * 0.11 + ph1));
            float driftB = 0.78 + 0.22 * sin(clkEff * 0.15 + ph2 * 1.4);
            float te = clkEff * driftA + 0.31 * sin(clkEff * 0.22 + ph3) * driftB;
            float te2 = clkEff * (1.04 + 0.12 * sin(clkEff * 0.07 + ph4)) + 0.18 * sin(clkEff * 0.14 + ph1 * 2.0);
            float te3 = clkEff * (0.9 + 0.14 * sin(clkEff * 0.12 + ph2)) + 0.22 * sin(clkEff * 0.18 + ph3 * 0.7);

            float fm = mix(0.07, 0.145, chaosMix) * sin(clkEff * (0.55 + 0.35 * fract(uSeed * 0.67)) + ph1);
            float s1 = 0.5 + 0.5 * sin(te * hz1 + ph1 + fm * hz1);
            float s2 = 0.5 + 0.5 * sin(te2 * hz2 + ph2 - mix(0.12, 0.175, chaosMix) * sin(clkEff * mix(0.28, 0.56, chaosMix) + ph3) * hz2);
            float s3 = 0.5 + 0.5 * sin(te3 * hz3 + ph3);

            float sum3 = s1 * 0.34 + s2 * 0.33 + s3 * 0.33;
            float prod = s1 * s2 * s3;
            float overlap = clamp(sum3 * mix(0.62, 0.52, chaosMix) + prod * mix(0.28, 0.58, chaosMix), 0.0, 1.0);
            float flickMul = max(0.1, 0.1 + 1.22 * overlap);
            flickMul *= 0.84 + 0.16 * (0.5 + 0.5 * sin(clkEff * mix(0.09, 0.34, chaosMix) + uSeed * 19.7));
            float shimA = sin(clkEff * mix(0.29, 0.78, chaosMix) + ph2 * 1.4);
            float shimB = sin(clkEff * mix(0.33, 0.9, chaosMix) + ph4 * 1.05 + 0.45 * sin(clkEnv * 0.12 + ph5));
            flickMul *= mix(1.0, 0.94 + 0.11 * shimA * shimB, 0.48 + 0.52 * chaosMix);
            flickMul = clamp(flickMul, 0.1, 1.52);
            float flickStable = mix(1.0, flickMul, fireChaosAmt);

            float fireRadialMul = mix(0.68, 2.0, pow(iAnimDrive, 1.02));
            float radialBase = ember + disk * 0.52;
            intensity = radialBase * fireRadialMul * flickStable;
          } else {
            // 1. OUTER CIRCLE (Dim Radius)
            float outerStart = 1.0 - softness;
            float outerEnd = 1.0 + 0.0001;
            float outerAlpha = 1.0 - smoothstep(outerStart, outerEnd, r);

            // 2. INNER CIRCLE (Bright Radius)
            float b = uBrightRadius / uRadius;
            float innerStart = b * (1.0 - softness);
            float innerEnd = b + (softness * (1.0 - b)) + 0.0001;
            float innerAlpha = 1.0 - smoothstep(innerStart, innerEnd, r);

            // 3. COMPOSITION
            float wOuter = max(uOuterWeight, 0.0);
            float wInner = max(uInnerWeight, 0.0);
            float wSum = max(0.0001, wOuter + wInner);
            intensity = (wOuter * outerAlpha + wInner * innerAlpha) / wSum;
          }

          // Shader-driven animation factor and potential color shift.
          float animAlphaMul = 1.0;
          vec3 outColor = uColor;

          // Optional cookie/gobo texture modulation.
          // This is applied in the light's local UV space (vUvs) with optional rotation/scale.
          float cookieFactor = 1.0;
          if (uHasCookie > 0.5) {
            vec2 cuv = vUvs - vec2(0.5);
            float cscale = max(uCookieScale, 0.0001);
            cuv = rot(uCookieRotation + uCookieRotationOffset) * (cuv / cscale);
            cuv += vec2(0.5);

            vec4 cookie = texture2D(tCookie, cuv);
            float cookieLuma = dot(cookie.rgb, vec3(0.2126, 0.7152, 0.0722));
            // Use alpha when the texture actually encodes transparency; otherwise fall back
            // to luminance so opaque gobos still modulate the light.
            float hasAlpha = step(cookie.a, 0.999);
            float cookieMask = mix(cookieLuma, cookie.a, hasAlpha);
            cookieMask = clamp(cookieMask, 0.0, 1.0);

            // Cookie shaping controls:
            // - strength: pushes dark areas darker so the pattern remains readable even
            //   when the light is bright/saturated.
            // - contrast/gamma: remap the cookie luminance.
            // - invert: flip cookie mask.
            float cm = cookieMask;
            if (uCookieInvert > 0.5) cm = 1.0 - cm;
            // Clamp gamma away from 0 to prevent cookie controls from completely
            // zeroing out light contribution.
            float cg = clamp(uCookieGamma, 0.25, 8.0);
            cm = pow(clamp(cm, 0.0, 1.0), 1.0 / cg);
            float cc = uCookieContrast;
            cm = (cm - 0.5) * cc + 0.5;

            float cs = max(uCookieStrength, 0.0);
            cookieFactor = clamp(1.0 - (1.0 - cm) * cs, 0.0, 1.0);

            // Allow cookies to fully cut out light (high-contrast gobos).
            cookieFactor = clamp(cookieFactor, 0.0, 1.0);
          }

          // 1 = wave, 2 = fairy, 3 = chroma, 4 = energy field, 5 = bewitching wave
          // 6 = revolving, 7 = siren, 8 = fog, 9 = sunburst, 10 = dome, 11 = emanation
          // 12 = hexa, 13 = ghost, 14 = vortex, 15 = rainbowswirl, 16 = radialrainbow
          // 17 = grid, 18 = starlight, 19 = smokepatch
          // 20 = torch, 21 = flame, 22 = pulse (also reactivepulse)
          if (uAnimType > 0.5 && uAnimType < 1.5) {
            // Wave: moving concentric ripples.
            // Keep the modulation mostly in the mid falloff like Foundry.
            ${FoundryLightingShaderChunks.wave}
          } else if (uAnimType > 1.5 && uAnimType < 2.5) {
            // Foundry VTT fairy-light (ported 1:1 from fairy-light.mjs coloration shader).
            // Uses fbm-based distortions + rainbow coloration.
            ${FoundryLightingShaderChunks.fairy}
          } else if (uAnimType > 2.5 && uAnimType < 3.5) {
            // Foundry VTT chroma (ported from chroma.mjs).
            ${FoundryLightingShaderChunks.chroma}
          } else if (uAnimType > 3.5 && uAnimType < 4.5) {
            // Foundry VTT energy field (ported from energy-field.mjs).
            ${FoundryLightingShaderChunks.energyField}
          } else if (uAnimType > 4.5 && uAnimType < 5.5) {
            // Foundry VTT bewitching wave (ported from bewitching-wave.mjs).
            ${FoundryLightingShaderChunks.bewitchingWave}
          } else if (uAnimType > 5.5 && uAnimType < 6.5) {
            // Foundry VTT revolving (ported from revolving-light.mjs).
            ${FoundryLightingShaderChunks.revolving}
          } else if (uAnimType > 6.5 && uAnimType < 7.5) {
            // Foundry VTT siren (ported from siren-light.mjs).
            ${FoundryLightingShaderChunks.siren}
          } else if (uAnimType > 7.5 && uAnimType < 8.5) {
            // Foundry VTT fog (ported from fog.mjs).
            ${FoundryLightingShaderChunks.fog}
          } else if (uAnimType > 8.5 && uAnimType < 9.5) {
            // Foundry VTT sunburst (ported from sunburst.mjs).
            ${FoundryLightingShaderChunks.sunburst}
          } else if (uAnimType > 9.5 && uAnimType < 10.5) {
            // Foundry VTT dome (ported from light-dome.mjs).
            ${FoundryLightingShaderChunks.lightDome}
          } else if (uAnimType > 10.5 && uAnimType < 11.5) {
            // Foundry VTT emanation (ported from emanation.mjs).
            ${FoundryLightingShaderChunks.emanation}
          } else if (uAnimType > 11.5 && uAnimType < 12.5) {
            // Foundry VTT hexa dome (ported from hexa-dome.mjs).
            ${FoundryLightingShaderChunks.hexaDome}
          } else if (uAnimType > 12.5 && uAnimType < 13.5) {
            // Foundry VTT ghost light (ported from ghost-light.mjs).
            ${FoundryLightingShaderChunks.ghostLight}
          } else if (uAnimType > 13.5 && uAnimType < 14.5) {
            // Foundry VTT vortex (ported from vortex.mjs).
            ${FoundryLightingShaderChunks.vortex}
          } else if (uAnimType > 14.5 && uAnimType < 15.5) {
            // Foundry VTT swirling rainbow (ported from swirling-rainbow.mjs).
            ${FoundryLightingShaderChunks.swirlingRainbow}
          } else if (uAnimType > 15.5 && uAnimType < 16.5) {
            // Foundry VTT radial rainbow (ported from radial-rainbow.mjs).
            ${FoundryLightingShaderChunks.radialRainbow}
          } else if (uAnimType > 16.5 && uAnimType < 17.5) {
            // Foundry VTT force grid (ported from force-grid.mjs).
            ${FoundryLightingShaderChunks.forceGrid}
          } else if (uAnimType > 17.5 && uAnimType < 18.5) {
            // Foundry VTT star light (ported from star-light.mjs).
            ${FoundryLightingShaderChunks.starLight}
          } else if (uAnimType > 18.5 && uAnimType < 19.5) {
            // Foundry VTT smoke patch (ported from smoke-patch.mjs).
            ${FoundryLightingShaderChunks.smokePatch}
          } else if (uAnimType > 19.5 && uAnimType < 20.5) {
            ${FoundryLightingShaderChunks.torch}
          } else if (uAnimType > 20.5 && uAnimType < 21.5) {
            // Foundry VTT flame (mimic coloration: noisy inner/outer flame lobes).
            ${FoundryLightingShaderChunks.flame}
          } else if (uAnimType > 21.5 && uAnimType < 22.5) {
            // Foundry VTT pulse/reactivepulse (mimic illumination+coloration).
            ${FoundryLightingShaderChunks.pulse}
          }

          // Final Alpha calculation
          float uAlphaEff = mix(uAlpha, min(1.0, max(uAlpha, 0.92)), isFireCore);
          float alphaBase = intensity * uAlphaEff * uIntensity * animAlphaMul * cookieFactor * max(uOutputGain, 0.0);

          float fairyBoost = (uAnimType > 1.5 && uAnimType < 2.5) ? 3.0 : 1.0;
          alphaBase *= fairyBoost;
          // Torch + flame: extra punch scales up with animation intensity (low at 1, full at 10).
          alphaBase *= mix(1.0, 1.75, isFireCore * iAnimDrive);

          // Apply Foundry-like luminosity as a direct strength control.
          // This ensures low luminosity visibly reduces emitted light.
          float lumMul = clamp(uLuminosity, 0.0, 1.0);
          float alpha = alphaBase * lumMul;

          // Apply cookie factor to color output to keep cookies visible even if
          // downstream compositing ignores alpha modulation for the light buffer.
          float cookieColorMul = (uHasCookie > 0.5) ? cookieFactor : 1.0;

          // Foundry "Color Intensity" (uniform uColoration): tint vs neutral luma.
          float ci = clamp(uColoration, 0.0, 1.0);
          float outLum = dot(outColor, vec3(0.2126, 0.7152, 0.0722));
          vec3 tintedColor = mix(vec3(outLum), outColor, ci);
          // Compose treats RGB as a separate coloration path (scaled by albedo); a plain
          // luma blend at ci=1 matches hue but can read weaker than Foundry. Emphasize
          // chroma at high ci so max slider gives clearly saturated tints (HDR-safe).
          vec3 lumaAxis = vec3(outLum);
          vec3 chr = tintedColor - lumaAxis;
          float chromaEmphasis = 1.0 + 0.72 * ci * ci;
          tintedColor = lumaAxis + chr * chromaEmphasis;
          vec3 rgbOut = tintedColor * uBrightness * (0.75 + 0.25 * fairyBoost) * cookieColorMul;
          // Keep color falloff/shape attenuation identical to the white channel profile,
          // but do not multiply by luminosity so "color-only" lights remain visible.
          rgbOut *= alphaBase;
          if (isFireCore > 0.5) {
            float hotHi = mix(1.05, 3.35, pow(iAnimDrive, 1.04));
            vec3 fire = vec3(1.0, 0.52, 0.14);
            rgbOut = mix(rgbOut * hotHi, rgbOut * fire * hotHi * 0.42, mix(0.22, 0.38, iAnimDrive));
          }

          // Additive Output
          gl_FragColor = vec4(rgbOut, alpha);
        }
      `,
      transparent: true,
      // Split-channel additive:
      // - RGB uses src color directly (so colored-only lights can render even when
      //   luminosity drives alpha to 0)
      // - Alpha accumulates separately as the white/direct-light channel read by
      //   LightingEffectV2 compose.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      // Keep destination alpha as linear accumulation of source alpha so
      // compose can read it as the direct/white-light channel.
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthWrite: false,
      depthTest: false,
    });

    this.material.toneMapped = false;

    this.updateData(this.document, true);

    try {
      log.info(' light-init', {
        id: this.id,
        hasDoc: !!this.document
      });
    } catch (_) {
    }

    // Stable per-light seed in [0..1]
    this.material.uniforms.uSeed.value = (this.animation.seed % 100000) / 100000;
  }

  updateData(doc, forceRebuild = false) {
    this.document = doc;
    const config = doc.config;
    const THREE = window.THREE;

    try {
      const cookieEnabled = config?.cookieEnabled === true;
      const cookieTexture = (typeof config?.cookieTexture === 'string' && config.cookieTexture.trim())
        ? config.cookieTexture.trim()
        : null;
      if (cookieEnabled || cookieTexture) {
        log.info(' light-update', {
          id: this.id,
          cookieEnabled,
          cookieTexture
        });
      }
    } catch (_) {
    }

    const docX = Number(doc?.x) || 0;
    const docY = Number(doc?.y) || 0;

    const prevRadiusPx = this._baseRadiusPx;
    const prevRenderRadiusPx = (typeof this._renderRadiusPx === 'number' && Number.isFinite(this._renderRadiusPx))
      ? this._renderRadiusPx
      : prevRadiusPx;

    // 1. Color parsing — match V3 / Foundry v14: authored tints are display-referred sRGB;
    // decode to linear working RGB for the WebGL light shader (THREE.ColorManagement).
    const c = new THREE.Color(1, 1, 1);
    const srgb = THREE.SRGBColorSpace;
    const colorInput = config?.color ?? config?.tint ?? doc?.tint ?? null;

    if (colorInput) {
      try {
        if (typeof colorInput === 'string') {
          c.set(colorInput);
        } else if (typeof colorInput === 'number') {
          c.setHex(colorInput >>> 0, srgb);
        } else if (typeof colorInput === 'object') {
          // Foundry color payloads vary by code path:
          // - {r,g,b}
          // - {rgb:[r,g,b]}
          // - Color-like objects exposing toArray()
          // - serializable payloads accepted by foundry.utils.Color.from
          if (Array.isArray(colorInput.rgb)) {
            const [r = 1, g = 1, b = 1] = colorInput.rgb;
            c.setRGB(r, g, b, srgb);
          } else if (typeof colorInput.r === 'number' && typeof colorInput.g === 'number' && typeof colorInput.b === 'number') {
            c.setRGB(colorInput.r, colorInput.g, colorInput.b, srgb);
          } else if (typeof colorInput.toArray === 'function') {
            const arr = colorInput.toArray();
            c.setRGB(arr?.[0] ?? 1, arr?.[1] ?? 1, arr?.[2] ?? 1, srgb);
          } else if (foundry?.utils?.Color?.from) {
            const fc = foundry.utils.Color.from(colorInput);
            if (fc && typeof fc.r === 'number' && typeof fc.g === 'number' && typeof fc.b === 'number') {
              c.setRGB(fc.r, fc.g, fc.b, srgb);
            }
          }
        }
      } catch (_) {
      }
    }

    this.material.uniforms.uColor.value.copy(c);

    // Cache the untinted base color so sky-tint in updateAnimation can be applied
    // from the original each frame without compounding (feedback loop).
    if (!this._baseLightColor) this._baseLightColor = new THREE.Color();
    this._baseLightColor.copy(c);

    // 2. Brightness / intensity logic (Foundry-like luminosity mapping)
    const luminosityRaw = Number(config.luminosity);
    const luminosity = Number.isFinite(luminosityRaw) ? luminosityRaw : 0.5;
    // Foundry worlds may provide luminosity as either:
    // - normalized [0..1] (common in authored docs)
    // - signed [-1..1] in some pipelines/tools
    const luminosity01 = (luminosity >= 0 && luminosity <= 1)
      ? luminosity
      : this._clamp((luminosity + 1.0) * 0.5, 0.0, 1.0);
    const satBonus = 0.0;
    this.material.uniforms.uBrightness.value = Math.max(0.2, 1.0 + ((luminosity01 * 2.0 - 1.0) * 0.35)) + satBonus;
    this.material.uniforms.uLuminosity.value = luminosity01;

    // Foundry "Color Intensity" slider → config.colorIntensity (0..1). Do not use
    // config.coloration here: that field is the coloration technique enum (integer).
    this.material.uniforms.uColoration.value = this._colorIntensity01FromConfig(config);

    const dim = config.dim || 0;
    const bright = config.bright || 0;
    const radius = Math.max(dim, bright);

    const d = canvas.dimensions;
    const pxPerUnit = d.size / d.distance;
    const rPx = radius * pxPerUnit;
    const brightPx = bright * pxPerUnit;

    const wallInsetPx = this._getWallInsetWorldPx();

    // IMPORTANT:
    // Wall inset is a *masking* control (how much we shrink the wall-clipped polygon)
    // and should NOT change the actual photometric radius of the light.
    const rPxBase = Math.max(0, rPx);
    const brightPxBase = Math.max(0, Math.min(brightPx, rPxBase));

    // Cable Swing shifts the illumination center within the (stationary) LOS polygon.
    // Expand the rendered radius by the max swing offset so the light doesn't clip
    // against its own mesh boundary while moving.
    const animCfg = config?.animation;
    const motionPadPx = (animCfg?.type === 'cableswing')
      ? Math.max(0, Number.isFinite(animCfg.motionMaxOffsetPx) ? animCfg.motionMaxOffsetPx : 0)
      : 0;

    // Safety overscan: the motion simulation can briefly overshoot, and geometry/
    // clipper operations can slightly reduce available space. Add a small margin.
    const motionPadOverscanPx = (motionPadPx > 0)
      ? (motionPadPx * 1.75 + 12.0)
      : 0;

    // IMPORTANT:
    // - uRadius/uBrightRadius define the actual photometric falloff size.
    // - Cable Swing moves the falloff center via uCenterOffset, which means we need
    //   extra "canvas" area (geometry) so the shifted falloff doesn't get clipped
    //   by the mesh boundary.
    // Therefore, we expand the rendered geometry radius, but we DO NOT expand the
    // falloff radius uniforms.
    const renderRadiusPx = rPxBase + motionPadOverscanPx;

    if (this._lastInsetWorldPx === null) {
      this._lastInsetWorldPx = wallInsetPx;
      this._lastInsetUpdateAtSec = 0;
      try {
        this._lastInsetZoom = this._getEffectiveZoom();
      } catch (_) {
        this._lastInsetZoom = null;
      }
    }

    this._baseRadiusPx = rPxBase;
    this._baseBrightRadiusPx = brightPxBase;
    this._baseRatio = rPxBase > 0 ? (brightPxBase / rPxBase) : 1;
    this._renderRadiusPx = renderRadiusPx;

    this.material.uniforms.uRadius.value = rPxBase;
    this.material.uniforms.uBrightRadius.value = brightPxBase;
    const alphaRaw = Number(config.alpha);
    this.material.uniforms.uAlpha.value = Number.isFinite(alphaRaw) ? this._clamp(alphaRaw, 0.0, 1.0) : 0.5;

    // Additional shaping/boost controls
    // These are MapShine-only controls (Foundry documents won't set them), so we
    // apply safe defaults when absent.
    if (this.material.uniforms.uOutputGain) {
      this.material.uniforms.uOutputGain.value = Number.isFinite(config.outputGain) ? config.outputGain : 1.0;
    }
    if (this.material.uniforms.uOuterWeight) {
      this.material.uniforms.uOuterWeight.value = Number.isFinite(config.outerWeight) ? config.outerWeight : 0.5;
    }
    if (this.material.uniforms.uInnerWeight) {
      this.material.uniforms.uInnerWeight.value = Number.isFinite(config.innerWeight) ? config.innerWeight : 0.5;
    }

    // --- FOUNDRY ATTENUATION MATH ---
    // Maps user input [0,1] to a non-linear shader curve [0,1]
    const rawAttenuation = config.attenuation ?? 0.5;
    const computedAttenuation = (Math.cos(Math.PI * Math.pow(rawAttenuation, 1.5)) - 1) / -2;
    this.material.uniforms.uAttenuation.value = computedAttenuation;

    // Cable Swing uses shader-space offsets. Reset them here so stale state doesn't
    // persist across config edits or geometry rebuilds.
    try {
      const u = this.material?.uniforms;
      if (u?.uCenterOffset?.value?.set) u.uCenterOffset.value.set(0, 0);
      if (u?.uCookieRotationOffset) u.uCookieRotationOffset.value = 0.0;
    } catch (_) {
    }

    // Cookie/gobo texture support (optional).
    this._updateCookieFromConfig(config);

    // 4. Position
    // Light meshes must be at the ground plane Z level (plus small offset)
    // to align with the base plane after the camera/ground refactor.
    const worldPos = Coordinates.toWorld(docX, docY);
    const groundZ = this._getGroundZ();
    const lightZ = groundZ + 0.1; // Slightly above ground plane

    const radiusChanged = Math.abs((prevRenderRadiusPx ?? 0) - (renderRadiusPx ?? 0)) > 1e-3;

    // Wall-clipped LOS polygons depend on (x,y), not just radius. If a light moves near
    // walls, the polygon must be recomputed or the mask will be stale.
    // IMPORTANT: Do not use mesh.position here because Cable Swing can apply a temporary
    // offset which would incorrectly trigger positionChanged every time updateData runs.
    const prevDocX = (typeof this._lastDocX === 'number' && Number.isFinite(this._lastDocX)) ? this._lastDocX : null;
    const prevDocY = (typeof this._lastDocY === 'number' && Number.isFinite(this._lastDocY)) ? this._lastDocY : null;
    const positionChanged = (prevDocX !== null && prevDocY !== null)
      ? (Math.abs(prevDocX - docX) > 1e-3 || Math.abs(prevDocY - docY) > 1e-3)
      : false;

    // If the authored anchor moved (user dragged the light), reset motion so we don't
    // carry over a large stale offset into the new location.
    if (positionChanged) {
      try {
        if (this._motion?.offsetWorld) this._motion.offsetWorld.set(0, 0);
        if (this._motion?.velocityWorld) this._motion.velocityWorld.set(0, 0);
      } catch (_) {
      }
    }

    if (forceRebuild || !this.mesh || radiusChanged || positionChanged) {
      this.rebuildGeometry(worldPos.x, worldPos.y, renderRadiusPx, lightZ);
    } else {
      this.mesh.position.set(worldPos.x, worldPos.y, lightZ);
    }

    // Hidden: force off immediately. Non-hidden: do not set visible=true here —
    // LightingEffectV2 applies level/perspective gating each frame after updateAnimation;
    // forcing visible would wipe multi-floor visibility whenever updateData runs (inset/zoom, hooks).
    if (this.mesh && doc.hidden === true) {
      this.mesh.visible = false;
    }

    this._lastDocX = docX;
    this._lastDocY = docY;
  }

  /**
   * Foundry ambient light: "Color Intensity" is stored as `colorIntensity` on the
   * light config. `coloration` names the rendering technique (integer), not this slider.
   * @param {object|null|undefined} config
   * @returns {number}
   * @private
   */
  _colorIntensity01FromConfig(config) {
    if (!config || typeof config !== 'object') return 0.5;
    let v = Number(config.colorIntensity);
    if (!Number.isFinite(v)) v = Number(config.colourIntensity);
    if (Number.isFinite(v)) return this._clamp(v, 0.0, 1.0);
    return 0.5;
  }

  _clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  _mix(a, b, t) {
    return (a * (1 - t)) + (b * t);
  }

  _updateCookieFromConfig(config) {
    const u = this.material?.uniforms;
    if (!u) return;

    const hasTexture = (typeof config?.cookieTexture === 'string' && config.cookieTexture.trim());
    const enabled = (config?.cookieEnabled === true) || (config?.cookieEnabled === undefined && !!hasTexture);

    const path = (enabled && hasTexture)
      ? config.cookieTexture.trim()
      : null;

    const rotation = Number.isFinite(config?.cookieRotation) ? config.cookieRotation : 0.0;
    const scale0 = Number.isFinite(config?.cookieScale) ? config.cookieScale : 1.0;
    const scale = (scale0 > 0) ? scale0 : 1.0;

    const strength = Number.isFinite(config?.cookieStrength) ? config.cookieStrength : 1.0;
    const contrast = Number.isFinite(config?.cookieContrast) ? config.cookieContrast : 1.0;
    const gamma = Number.isFinite(config?.cookieGamma) ? config.cookieGamma : 1.0;
    const invert = config?.cookieInvert === true;
    const colorize = config?.cookieColorize === true;

    try {
      if (u.uCookieTint?.value) {
        const tint = (typeof config?.cookieTint === 'string' && config.cookieTint) ? config.cookieTint : '#ffffff';
        u.uCookieTint.value.set(tint);
      }
    } catch (_) {
    }

    u.uCookieRotation.value = rotation;
    u.uCookieScale.value = scale;
    u.uCookieStrength.value = strength;
    u.uCookieContrast.value = contrast;
    u.uCookieGamma.value = gamma;
    u.uCookieInvert.value = invert ? 1.0 : 0.0;
    u.uCookieColorize.value = colorize ? 1.0 : 0.0;

    if (!path) {
      try {
        if (this._cookiePath) {
          log.info(' cookie-clear', {
            id: this.id,
            previousPath: this._cookiePath,
            enabled,
            hasTexture: !!hasTexture
          });
        }
      } catch (_) {
      }

      if (this._cookieRetryTimeoutId !== null) {
        try { clearTimeout(this._cookieRetryTimeoutId); } catch (_) {}
        this._cookieRetryTimeoutId = null;
      }
      this._cookiePath = null;
      this._cookieTexture = null;
      this._cookieFailCount = 0;
      u.tCookie.value = null;
      u.uHasCookie.value = 0.0;
      return;
    }

    if (this._cookiePath === path && this._cookieTexture) {
      u.tCookie.value = this._cookieTexture;
      u.uHasCookie.value = 1.0;
      return;
    }

    // Kick off an async load; keep the light usable while the cookie arrives.
    // IMPORTANT: Cookie loading must be resilient during Foundry startup.
    // Foundry's PIXI texture pipeline can transiently fail before the scene is fully ready.
    // If we fail once and never retry, cookies appear "broken" after reload until the user
    // touches the light again. We therefore retry with backoff while the cookie remains enabled.
    const prevPath = this._cookiePath;
    if (prevPath !== path) {
      this._cookieFailCount = 0;
      if (this._cookieRetryTimeoutId !== null) {
        try { clearTimeout(this._cookieRetryTimeoutId); } catch (_) {}
        this._cookieRetryTimeoutId = null;
      }
    }

    this._cookiePath = path;
    this._cookieTexture = null;
    const version = ++this._cookieLoadVersion;
    u.tCookie.value = null;
    u.uHasCookie.value = 0.0;

    try {
      const dbg = this._cookieDebugState || (this._cookieDebugState = { path: null, enabled: null });
      if (dbg.path !== path || dbg.enabled !== enabled) {
        log.info(' cookie-config', {
          id: this.id,
          enabled,
          hasTexture: !!hasTexture,
          path,
          strength,
          contrast,
          gamma,
          invert,
          colorize,
          scale,
          rotation
        });
        dbg.path = path;
        dbg.enabled = enabled;
      }
    } catch (_) {
    }

    const attemptLoad = () => {
      loadTexture(path, { suppressProbeErrors: true })
        .then((tex) => {
          if (this._cookieLoadVersion !== version) return;
          if (this._cookiePath !== path) return;

          if (this._cookieRetryTimeoutId !== null) {
            try { clearTimeout(this._cookieRetryTimeoutId); } catch (_) {}
            this._cookieRetryTimeoutId = null;
          }
          this._cookieFailCount = 0;

          try {
            const THREE = window.THREE;
            if (THREE && tex) {
              tex.wrapS = THREE.ClampToEdgeWrapping;
              tex.wrapT = THREE.ClampToEdgeWrapping;
              tex.minFilter = THREE.LinearFilter;
              tex.magFilter = THREE.LinearFilter;
              tex.generateMipmaps = false;
              if (THREE.NoColorSpace) tex.colorSpace = THREE.NoColorSpace;
              tex.flipY = false;
              tex.needsUpdate = true;
            }
          } catch (_) {
          }

          this._cookieTexture = tex;
          if (this.material?.uniforms) {
            this.material.uniforms.tCookie.value = tex;
            this.material.uniforms.uHasCookie.value = 1.0;
          }

          try {
            const img = tex?.image ?? null;
            const w = Number(img?.naturalWidth ?? img?.videoWidth ?? img?.width ?? 0) || undefined;
            const h = Number(img?.naturalHeight ?? img?.videoHeight ?? img?.height ?? 0) || undefined;
            log.info(' cookie-load-success', {
              id: this.id,
              path,
              width: w,
              height: h,
              hasImage: !!img
            });
          } catch (_) {
          }

          // Make the update visible immediately even if the render loop is currently idle-throttled.
          try {
            window.MapShine?.renderLoop?.requestContinuousRender?.(300);
          } catch (_) {
          }
        })
        .catch((err) => {
          if (this._cookieLoadVersion !== version) return;
          if (this._cookiePath !== path) return;

          const handleFailure = (failureErr) => {
            try {
              log.warn(' cookie-load-failed', {
                id: this.id,
                path,
                message: String(failureErr?.message ?? failureErr ?? 'unknown')
              });
            } catch (_) {
            }

            // Keep cookie disabled until it successfully loads, but retry automatically.
            if (this.material?.uniforms) {
              this.material.uniforms.tCookie.value = null;
              this.material.uniforms.uHasCookie.value = 0.0;
            }

            this._cookieFailCount = Math.min(20, (this._cookieFailCount || 0) + 1);
            const delayMs = Math.min(8000, 250 * Math.pow(2, Math.max(0, this._cookieFailCount - 1)));
            if (this._cookieRetryTimeoutId !== null) {
              try { clearTimeout(this._cookieRetryTimeoutId); } catch (_) {}
              this._cookieRetryTimeoutId = null;
            }

            this._cookieRetryTimeoutId = setTimeout(() => {
              // Only retry if the cookie is still the active request.
              if (this._cookieLoadVersion !== version) return;
              if (this._cookiePath !== path) return;
              attemptLoad();
            }, delayMs);
          };

          // Fallback: use THREE.TextureLoader directly if Foundry loadTexture fails.
          let fallbackStarted = false;
          try {
            const THREE = window.THREE;
            if (THREE?.TextureLoader) {
              fallbackStarted = true;
              const loader = new THREE.TextureLoader();
              const url = encodeURI(path);
              loader.load(
                url,
                (tex) => {
                  if (this._cookieLoadVersion !== version) return;
                  if (this._cookiePath !== path) return;

                  try {
                    tex.wrapS = THREE.ClampToEdgeWrapping;
                    tex.wrapT = THREE.ClampToEdgeWrapping;
                    tex.minFilter = THREE.LinearFilter;
                    tex.magFilter = THREE.LinearFilter;
                    tex.generateMipmaps = false;
                    if (THREE.NoColorSpace) tex.colorSpace = THREE.NoColorSpace;
                    tex.flipY = false;
                    tex.needsUpdate = true;
                  } catch (_) {
                  }

                  this._cookieTexture = tex;
                  if (this.material?.uniforms) {
                    this.material.uniforms.tCookie.value = tex;
                    this.material.uniforms.uHasCookie.value = 1.0;
                  }

                  try {
                    const img = tex?.image ?? null;
                    const w = Number(img?.naturalWidth ?? img?.videoWidth ?? img?.width ?? 0) || undefined;
                    const h = Number(img?.naturalHeight ?? img?.videoHeight ?? img?.height ?? 0) || undefined;
                    log.info(' cookie-load-success-fallback', {
                      id: this.id,
                      path,
                      width: w,
                      height: h,
                      hasImage: !!img
                    });
                  } catch (_) {
                  }

                  try {
                    window.MapShine?.renderLoop?.requestContinuousRender?.(300);
                  } catch (_) {
                  }
                },
                undefined,
                (fallbackErr) => {
                  handleFailure(fallbackErr ?? err);
                }
              );
            }
          } catch (_) {
          }

          if (!fallbackStarted) {
            handleFailure(err);
          }
        });
    };

    attemptLoad();
  }

  /**
   * Prefer the live scene AmbientLight document so per-frame animation reads see UI edits
   * immediately; {@link this.document} can lag one update behind Foundry hooks.
   * @returns {object|null}
   * @private
   */
  _resolveLiveLightDoc() {
    const id = this.id;
    try {
      const col = typeof canvas !== 'undefined' ? canvas?.scene?.lights : null;
      if (!col || id == null) return null;
      const placeable = col.get?.(id) ?? col.get?.(String(id));
      const d = placeable?.document;
      if (d && typeof d === 'object') return d;
    } catch (_) {}
    return null;
  }

  /**
   * @param {unknown} raw Foundry `config.animation.type` (string, or numeric index in some builds)
   * @returns {string|null} normalized id for our `type === '…'` branches
   * @private
   */
  _normalizeAnimationType(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'string') {
      return raw.trim().toLowerCase();
    }
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      try {
        const list = typeof CONFIG !== 'undefined' ? CONFIG?.Canvas?.lightAnimations : null;
        if (Array.isArray(list) && raw < list.length) {
          const id = list[raw]?.id ?? list[raw]?.type;
          if (typeof id === 'string' && id.length) return id.trim().toLowerCase();
        }
        if (list && typeof list === 'object' && !Array.isArray(list)) {
          const keys = Object.keys(list);
          const k = keys[Math.floor(raw)];
          if (typeof k === 'string' && k.length) return k.trim().toLowerCase();
        }
      } catch (_) {}
    }
    return null;
  }

  _parseAnimNumber(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  _shaderFireClock(animTime) {
    const w = FIRE_SHADER_TIME_WRAP;
    let t = Number(animTime);
    if (!Number.isFinite(t)) t = 0;
    return ((t % w) + w) % w;
  }

  _getAnimationOptions() {
    const doc = this._resolveLiveLightDoc() || this.document;
    const cfg = (doc?.config && typeof doc.config === 'object') ? doc.config : {};
    const a = (cfg.animation && typeof cfg.animation === 'object') ? cfg.animation : {};

    const type = this._normalizeAnimationType(a.type);
    const speed = this._parseAnimNumber(a.speed, 5);

    let intensity = this._parseAnimNumber(a.intensity, NaN);
    if (!Number.isFinite(intensity)) {
      intensity = this._parseAnimNumber(a.animationIntensity, NaN);
    }
    if (!Number.isFinite(intensity)) {
      intensity = this._parseAnimNumber(cfg.animationIntensity, 5);
    }
    intensity = this._clamp(intensity, 0, 10);

    const reverse = !!a.reverse;
    return { type, speed, intensity, reverse };
  }

  animateTime(tMs, { speed = 5, intensity = 5, reverse = false } = {}) {
    let t = tMs;
    if (reverse) t *= -1;
    this.animation.time = ((speed * t) / 5000) + this.animation.seed;
    return this.animation.time;
  }

  animateFlickering(tMs, {
    speed = 5,
    intensity = 5,
    reverse = false,
    amplification = 1,
    ratioOscillationScale = 1,
    noiseScale = 3,
  } = {}) {
    this.animateTime(tMs, { speed, intensity, reverse });

    const amplitude = amplification * 0.45;
    const ns = (Number.isFinite(noiseScale) && noiseScale > 0) ? noiseScale : 3;
    if (!this.animation.noise) {
      this.animation.noise = new SmoothNoise({ amplitude, scale: ns, maxReferences: 2048 });
    } else {
      if (this.animation.noise.amplitude !== amplitude) {
        this.animation.noise.amplitude = amplitude;
      }
      if (this.animation.noise.scale !== ns) {
        this.animation.noise.scale = ns;
      }
    }

    const n = this.animation.noise.generate(this.animation.time);
    const brightnessPulse = 0.55 + n;
    const ro = Math.max(0, ratioOscillationScale);
    const ratioPulse = this._clamp(this._baseRatio * (0.9 + (n * 0.25 * ro)), 0, 1);
    return { brightnessPulse, ratioPulse };
  }

  /**
   * Foundry torch: animation **intensity** (0–10) scales how strong the flicker is and
   * how much the bright core “breathes” (see Foundry lighting article / in-app tooltips).
   */
  animateTorch(tMs, {
    speed = 5,
    intensity = 5,
    reverse = false,
    noiseScale: noiseScaleOverride,
    windGusts = true,
  } = {}) {
    const i = this._clamp(intensity, 0, 10);
    const intNorm = i / 10;
    // Match shader iAnimDrive: animation 1→10 maps to 0→1 (5 ≈ mid).
    const iDrive = Math.max(0, Math.min(1, (i - 1) / 9));
    const ampCurve = intNorm * intNorm;
    const amplification = 0.018 + ampCurve * 1.55;
    const ratioOscillationScale = 0.04 + ampCurve * 1.65;
    const noiseScale = Number.isFinite(noiseScaleOverride)
      ? noiseScaleOverride
      : (0.38 + intNorm * 0.52);

    const res = this.animateFlickering(tMs, {
      speed,
      intensity,
      reverse,
      amplification,
      ratioOscillationScale,
      noiseScale,
    });

    if (!windGusts) {
      return res;
    }

    const tSec = this.animation.time;
    const windStutter = Math.sin(tSec * 19.3) * Math.sin(tSec * 31.7 + 2.1) * Math.cos(tSec * 7.1);
    const gustWeight = iDrive * iDrive;
    let gustMul = 1.0 + (windStutter * 0.85 * gustWeight);
    if (windStutter < -0.4) {
      gustMul *= 0.45;
    }
    if (windStutter > 0.6) {
      gustMul *= 1.35;
    }

    return {
      brightnessPulse: Math.max(0.1, res.brightnessPulse * gustMul),
      ratioPulse: this._clamp(Math.max(0.1, res.ratioPulse * gustMul), 0, 1),
    };
  }

  animatePulse(tMs, { speed = 5, intensity = 5, reverse = false } = {}) {
    this.animateTime(tMs, { speed, intensity, reverse });
    const i = (10 - intensity) * 0.1;
    const w = 0.5 * (Math.cos(this.animation.time * 2.5) + 1);
    const pulse = this._mix(1.2, i, w);
    const ratioPulse = this._mix(this._baseRatio, this._baseRatio * i, w);
    return { pulse, ratioPulse };
  }

  animateFairy(tMs, { speed = 5, intensity = 5, reverse = false } = {}) {
    this.animateTime(tMs, { speed, intensity, reverse });
    // Fairy lights: dramatic rapid shimmer with larger intensity changes
    const shimmer = Math.sin(this.animation.time * 10.0) * 0.5 + 
                    Math.sin(this.animation.time * 17.0) * 0.3 + 
                    Math.sin(this.animation.time * 23.0) * 0.2;
    const pulse = 1.0 + (shimmer * intensity * 0.15);
    const ratioPulse = this._baseRatio * (0.6 + shimmer * 0.4);
    return { pulse, ratioPulse };
  }

  animateWave(tMs, { speed = 5, intensity = 5, reverse = false } = {}) {
    this.animateTime(tMs, { speed, intensity, reverse });
    // Wave lights: more dramatic undulation with larger intensity range
    const wave = Math.sin(this.animation.time * 2.0) * 0.7 + 0.5;
    const i = (10 - intensity) * 0.1;
    const pulse = this._mix(0.3 + i * 0.2, 2.0 - i * 0.5, wave);
    const ratioPulse = this._mix(this._baseRatio * 0.5, this._baseRatio * 1.5, wave);
    return { pulse, ratioPulse };
  }

  animateSoundPulse(dtMs, { speed = 5, intensity = 5, reverse = false, amplification = 1 } = {}) {
    let bassVal = 0;
    let midVal = 0;
    let trebVal = 0;

    try {
      bassVal = Math.pow(game.audio.getMaxBandLevel('bass', { ignoreVolume: true }), 1.5);
      midVal = Math.pow(game.audio.getMaxBandLevel('mid', { ignoreVolume: true }), 1.5);
      trebVal = Math.pow(game.audio.getMaxBandLevel('treble', { ignoreVolume: true }), 1.5);
    } catch (e) {
      // If audio API is not available, keep amplitude at 0.
    }

    const it = this._clamp(intensity, 0, 10) / 10;
    const finalVal = (it <= 0.5)
      ? this._mix(bassVal, midVal, it * 2)
      : this._mix(midVal, trebVal, (it - 0.5) * 2);

    const smoothing = 1 - Math.exp(-speed * dtMs * 0.085);
    this.animation.reactiveSoundAmplitude += (finalVal - this.animation.reactiveSoundAmplitude) * smoothing;

    let amplitude = reverse ? (1 - this.animation.reactiveSoundAmplitude) : this.animation.reactiveSoundAmplitude;
    amplitude = amplitude * this._baseRatio;
    const ratioPulse = this._clamp(amplitude * 1.11, 0, 1);
    return { pulse: amplitude, ratioPulse };
  }

  _updateCableSwing(timeInfo, { speed = 5, intensity = 5, reverse = false } = {}) {
    try {
      const THREE = window.THREE;
      if (!THREE || !this.mesh || !this.document) return;

      // Safety clamp dt to avoid explosions on lag spikes.
      const dt = Math.min(Math.max(Number(timeInfo?.delta) || 0, 0), 0.1);
      if (dt <= 0.000001) return;

      const tSec = Number(timeInfo?.elapsed) || 0;

      if (!this._motion.offsetWorld) this._motion.offsetWorld = new THREE.Vector2(0, 0);
      if (!this._motion.velocityWorld) this._motion.velocityWorld = new THREE.Vector2(0, 0);
      if (!this._motion.tmpDirWorld) this._motion.tmpDirWorld = new THREE.Vector2(1, 0);

      // Anchor is always the authored base position (Foundry coords).
      // Dragging/editing the light updates doc.x/y and therefore the anchor.
      const ax = Number(this.document.x) || 0;
      const ay = Number(this.document.y) || 0;

      const anim = this.document?.config?.animation || {};

      const maxOffsetPx0 = Number.isFinite(anim.motionMaxOffsetPx) ? anim.motionMaxOffsetPx : 120;
      const maxOffsetPx = Math.max(0.0, maxOffsetPx0);

      // If the user clamps motion to ~0, snap back immediately.
      if (maxOffsetPx <= 0.0001) {
        this._motion.offsetWorld.set(0, 0);
        this._motion.velocityWorld.set(0, 0);
        try {
          const u = this.material?.uniforms;
          if (u?.uCenterOffset?.value?.set) u.uCenterOffset.value.set(0, 0);
          if (u?.uCookieRotationOffset) u.uCookieRotationOffset.value = 0.0;
        } catch (_) {
        }
        return;
      }

      // Spring tuning (world units/pixels).
      const spring0 = Number.isFinite(anim.motionSpring) ? anim.motionSpring : 12.0;
      const damping0 = Number.isFinite(anim.motionDamping) ? anim.motionDamping : 4.0;
      const spring = Math.max(0.0, spring0);
      const damping = Math.max(0.0, damping0);

      const localWindInfluence0 = Number.isFinite(anim.motionWindInfluence)
        ? anim.motionWindInfluence
        : (this._clamp(intensity, 0, 10) / 10);
      // Clamp to avoid values that immediately slam the motion to max offset,
      // which looks like "no animation".
      const localWindInfluence = Math.max(0.0, Math.min(3.0, localWindInfluence0));

      const { windInfluence: globalWindInfluence, outdoorPower } = this._getGlobalLightAnimParams();

      // Outdoor factor based on _Outdoors mask (world-space sampled).
      const outdoorFactorRaw = this._getOutdoorFactorAtFoundryXY(ax, ay);
      const outdoorFactor = Math.pow(outdoorFactorRaw, outdoorPower);

      const w = this._getWeatherController();
      const weather = (w && typeof w.getCurrentState === 'function')
        ? w.getCurrentState()
        : (w?.currentState ?? null);
      const windSpeed01 = (weather && typeof weather.windSpeed === 'number' && Number.isFinite(weather.windSpeed))
        ? Math.max(0.0, Math.min(1.0, weather.windSpeed))
        : 0.0;

      const windDirF = weather?.windDirection;

      // Convert wind direction from Foundry (Y-down) to our THREE world (Y-up).
      const dir = this._motion.tmpDirWorld;
      dir.set(Number(windDirF?.x) || 1, -(Number(windDirF?.y) || 0));
      if (dir.lengthSq() <= 1e-8) dir.set(1, 0);
      dir.normalize();

      // Cable swing should *visibly* animate even in constant wind. A pure spring
      // toward a constant target settles into a static deflection.
      //
      // Add gentle time-varying gust + direction meander using SmoothNoise.
      if (!this._motion.gustNoise) {
        // Keep scale low so changes are smooth (not jittery).
        this._motion.gustNoise = new SmoothNoise({ amplitude: 1.0, scale: 0.25, maxReferences: 2048 });
      }

      const seed = (Number.isFinite(this.animation?.seed) ? this.animation.seed : 0);
      const seedSec = seed * 0.000013;
      const gustN = this._motion.gustNoise.generate(tSec + seedSec); // 0..1
      const gustSigned = (gustN * 2.0) - 1.0; // -1..1
      const meanderN = this._motion.gustNoise.generate((tSec * 0.77) + seedSec + 123.456); // 0..1
      const meanderSigned = (meanderN * 2.0) - 1.0;

      // Wind magnitude variation: small oscillation around the base wind.
      // Provide a subtle idle baseline so cable swing still animates when wind is calm,
      // while honoring per-light motion influence (localWindInfluence) later in windMul.
      const intensity01 = this._clamp(intensity, 0, 10) / 10;
      const idleWindBase = Math.max(0.0, Math.min(0.35, 0.08 + intensity01 * 0.12));
      const windBase = Math.max(windSpeed01, idleWindBase);
      const gustStrength = 0.08 + 0.22 * windBase;
      const windSpeedVar = Math.max(0.0, Math.min(1.0, windBase + gustSigned * gustStrength));

      // Direction meander: max ~20deg at full wind.
      const maxAngleRad = (20.0 * Math.PI / 180.0) * windSpeedVar;
      const ang = meanderSigned * maxAngleRad;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);

      const bx = dir.x;
      const by = dir.y;
      dir.set(bx * ca - by * sa, bx * sa + by * ca);

      const responsiveness = Math.max(0.0, Number.isFinite(anim.motionResponsiveness) ? anim.motionResponsiveness : speed);
      const responseMul = (0.25 + 0.75 * responsiveness / 10);
      // Use a smooth saturation curve instead of a hard clamp.
      // Hard clamping causes the target to peg at maxOffset for most of the time in
      // high wind, which looks like "no animation".
      const windMulRaw = windSpeedVar * globalWindInfluence * localWindInfluence * outdoorFactor * responseMul;
      const windMulSaturate = 1.0 - Math.exp(-Math.max(0.0, Math.min(10.0, windMulRaw)));
      const windMul = Math.max(0.0, Math.min(1.0, windMulSaturate));

      // --- Pendulum-style forcing ---
      // We keep the mesh + LOS polygon anchored, and only swing the illumination center
      // within the polygon using uCenterOffset.
      if (!Number.isFinite(this._motion.swingPhase)) {
        this._motion.swingPhase = ((seed * 0.000173) % 1.0) * Math.PI * 2.0;
      }

      // Oscillation speed derived from spring and responsiveness.
      const omega = Math.max(0.5, Math.sqrt(Math.max(0.0, spring))) * (0.4 + 0.8 * (responsiveness / 10));
      this._motion.swingPhase += omega * dt;
      if (this._motion.swingPhase > Math.PI * 2.0) this._motion.swingPhase -= Math.PI * 2.0;

      const perpX = -dir.y;
      const perpY = dir.x;

      // Base deflection downwind (mean angle) + back-and-forth swing around it.
      // NOTE: We deliberately allow the along-wind oscillation to exceed the mean
      // deflection at high wind so the swing can occasionally overshoot upwind.
      const baseMag = maxOffsetPx * windMul * (0.25 + 0.30 * windSpeedVar);
      const swingAlongMag = maxOffsetPx * windMul * (0.10 + 0.60 * windSpeedVar);
      const swingPerpMag = maxOffsetPx * windMul * (0.12 + 0.45 * windSpeedVar);
      const bobMag = maxOffsetPx * windMul * (0.03 + 0.10 * windSpeedVar);

      const ph = this._motion.swingPhase;
      const swing = Math.sin(ph);
      const bob = Math.sin(ph * 0.5 + meanderSigned * 1.1);
      const sway = Math.sin(ph + 0.6 + meanderSigned * 0.8);

      // Modulate swing amplitude slightly with gust so gusts "pump" the motion.
      const gustAmp = Math.max(0.6, Math.min(1.4, 1.0 + gustSigned * (0.15 + 0.20 * windSpeedVar)));

      // Along-wind component can cross 0 (upwind) under strong wind.
      const along = (baseMag + bobMag * bob) + (swingAlongMag * swing * gustAmp);
      const perp = swingPerpMag * sway * gustAmp;

      let targetX = dir.x * along + perpX * perp;
      let targetY = dir.y * along + perpY * perp;

      const off = this._motion.offsetWorld;
      const vel = this._motion.velocityWorld;

      // Damped spring toward target.
      const axW = (spring * (targetX - off.x)) - (damping * vel.x);
      const ayW = (spring * (targetY - off.y)) - (damping * vel.y);
      vel.x += axW * dt;
      vel.y += ayW * dt;
      off.x += vel.x * dt;
      off.y += vel.y * dt;

      // Safety clamp (should be rare because target is already in bounds).
      const len = Math.hypot(off.x, off.y);
      if (len > maxOffsetPx) {
        const s = maxOffsetPx / Math.max(1e-6, len);
        off.x *= s;
        off.y *= s;
        vel.x *= 0.5;
        vel.y *= 0.5;
      }

      // Cookie wobble: correlated with pendulum swing so it rocks back and forth.
      const swing01 = (maxOffsetPx > 1e-3)
        ? Math.min(1.0, Math.max(swingAlongMag, swingPerpMag) / maxOffsetPx)
        : 0.0;
      const rotAmpRad = (2.0 + 12.0 * windMul) * (Math.PI / 180.0) * (0.35 + 0.65 * swing01);
      const rotNoiseN = this._motion.gustNoise.generate((tSec * 0.12) + seedSec + 654.321);
      const rotNoiseSigned = (rotNoiseN * 2.0) - 1.0;
      const rotDrift = rotAmpRad * 0.18 * rotNoiseSigned;
      const rotOffset = rotAmpRad * (0.65 * swing + 0.20 * sway + 0.15 * bob) + rotDrift;

      try {
        const u = this.material?.uniforms;
        if (u?.uCenterOffset?.value?.set) u.uCenterOffset.value.set(off.x, off.y);
        if (u?.uCookieRotationOffset) u.uCookieRotationOffset.value = rotOffset;
      } catch (_) {
      }

      // Optional runtime debug (off by default):
      // window.MapShine.debugCableSwing = true;
      // window.MapShine.debugCableSwingId = 'mapshine:...' (optional filter)
      try {
        const dbg = window.MapShine?.debugCableSwing === true;
        const dbgId = window.MapShine?.debugCableSwingId;
        if (dbg && (!dbgId || String(dbgId) === String(this.id))) {
          if (!this._motion._dbgNextAt) this._motion._dbgNextAt = 0;
          const now = Number(timeInfo?.elapsed) || 0;
          if (now >= this._motion._dbgNextAt) {
            this._motion._dbgNextAt = now + 1.0;
            // eslint-disable-next-line no-console
            console.log('[MapShine][CableSwing]', {
              id: this.id,
              windSpeed01,
              windSpeedVar,
              outdoorFactorRaw,
              outdoorFactor,
              globalWindInfluence,
              localWindInfluence,
              windMul,
              windMulRaw,
              maxOffsetPx,
              offX: off.x,
              offY: off.y,
              type: this.document?.config?.animation?.type,
            });
          }
        }
      } catch (_) {
      }
    } catch (_) {
    }
  }

  rebuildGeometry(worldX, worldY, radiusPx, lightZ) {
    const THREE = window.THREE;
    const prevMeshParent = this.mesh?.parent ?? this._meshParent;
    const prevLayersMask = this.mesh?.layers?.mask;
    const prevRenderOrder = this.mesh?.renderOrder;
    // Preserve visibility state so darkness-gated lights don't flash for one
    // frame when zoom triggers a geometry rebuild (new Mesh defaults to visible=true).
    const prevVisible = this.mesh ? this.mesh.visible : undefined;

    // Defensive: ensure we never have more than one mesh for the same light in the
    // light scene. Duplicate additive meshes present as "brightness doubling".
    try {
      if (prevMeshParent?.children && typeof prevMeshParent.remove === 'function') {
        for (let i = prevMeshParent.children.length - 1; i >= 0; i--) {
          const c = prevMeshParent.children[i];
          if (c && c !== this.mesh && c.userData?.lightId === this.id) {
            prevMeshParent.remove(c);
            try { c.geometry?.dispose?.(); } catch (_) {}
          }
        }
      }
    } catch (_) {
    }

    if (this.mesh) {
      try {
        this.mesh.geometry?.dispose?.();
      } catch (_) {
      }

      // Remove explicitly from the previous parent. In some edge cases (hot reload,
      // external scene manipulation) `removeFromParent()` can fail to detach the
      // mesh that is still held by a parent reference we captured earlier.
      try {
        if (prevMeshParent && typeof prevMeshParent.remove === 'function') {
          prevMeshParent.remove(this.mesh);
        }
      } catch (_) {
      }

      try {
        this.mesh.removeFromParent();
      } catch (_) {
      }
    }

    let geometry;
    let shapePoints = null;

    const wallInsetPx = this._getWallInsetWorldPx();
    try {
      // Three.js / MapShine wall masking: compute a wall-clipped visibility polygon
      // from Foundry wall documents, rather than relying on Foundry's internal
      // LightSource.los polygon.
      if (typeof _lightLosComputer?.compute === 'function') {
        const sceneRect = canvas?.dimensions?.sceneRect;
        const sceneBounds = sceneRect ? {
          x: sceneRect.x,
          y: sceneRect.y,
          width: sceneRect.width,
          height: sceneRect.height
        } : null;

        const centerF = { x: this.document?.x ?? 0, y: this.document?.y ?? 0 };

        // radiusPx here is the rendered geometry radius. We add the inset so that
        // when we shrink the polygon below, the resulting boundary aligns with
        // the intended radius.
        const computeRadiusPx = Math.max(0, (Number(radiusPx) || 0) + wallInsetPx);
        const computeOpts = { sense: 'light' };
        try {
          if (hasV14NativeLevels(canvas?.scene)) {
            const p = getPerspectiveElevation();
            if (Number.isFinite(p?.losHeight)) computeOpts.elevation = p.losHeight;
          }
        } catch (_) {}
        const ptsF = _lightLosComputer.compute(centerF, computeRadiusPx, null, sceneBounds, computeOpts);

        if (ptsF && ptsF.length >= 6) {
          shapePoints = [];
          for (let i = 0; i < ptsF.length; i += 2) {
            const v = Coordinates.toWorld(ptsF[i], ptsF[i + 1]);
            // Convert to local space around the light center
            shapePoints.push(new THREE.Vector2(v.x - worldX, v.y - worldY));

          }

          // Shrink the polygon by the wall inset thickness.
          if (wallInsetPx > 0) {
            let insetOk = false;
            try {
              const ClipperLib = window.ClipperLib;

              if (ClipperLib) {
                const scale = 100;
                const path = [];
                for (let i = 0; i < shapePoints.length; i++) {
                  const p = shapePoints[i];
                  path.push({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) });
                }

                const area = (pts) => {
                  let a = 0;
                  for (let i = 0; i < pts.length; i++) {
                    const j = (i + 1) % pts.length;
                    a += (pts[i].X * pts[j].Y - pts[j].X * pts[i].Y);
                  }
                  return a * 0.5;
                };

                if (area(path) < 0) path.reverse();

                const co = new ClipperLib.ClipperOffset(2.0, 0.25 * scale);
                co.AddPath(path, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
                const out = new ClipperLib.Paths();
                co.Execute(out, -wallInsetPx * scale);
                if (out && out.length) {
                  let best = out[0];
                  let bestAbsArea = Math.abs(area(best));
                  for (let i = 1; i < out.length; i++) {
                    const a = Math.abs(area(out[i]));
                    if (a > bestAbsArea) {
                      best = out[i];
                      bestAbsArea = a;
                    }
                  }

                  if (best && best.length >= 3) {
                    shapePoints = best.map((pt) => new THREE.Vector2(pt.X / scale, pt.Y / scale));
                    insetOk = true;
                  }
                }
              }
            } catch (_) {
            }

            if (!insetOk) {
              for (let i = 0; i < shapePoints.length; i++) {
                const p = shapePoints[i];
                const len = Math.hypot(p.x, p.y);
                if (len > 1e-4) {
                  const mul = Math.max(0, (len - wallInsetPx) / len);
                  p.multiplyScalar(mul);
                }
              }
            }
          }
        }
      }
    } catch (_) {
    }

    if (shapePoints && shapePoints.length > 2) {
      const shape = new THREE.Shape(shapePoints);
      geometry = new THREE.ShapeGeometry(shape);
      this._usingCircleFallback = false;
    } else {
      // Circle Fallback - bumped segments to 128 for smoother large radii
      geometry = new THREE.CircleGeometry(radiusPx, 128);
      this._usingCircleFallback = true;
    }

    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.userData = this.mesh.userData || {};
    this.mesh.userData.lightId = this.id;
    // Position at ground plane Z level (passed from updateData)
    this.mesh.position.set(worldX, worldY, lightZ);
  
    // Ensure render order is handled correctly if needed
    this.mesh.renderOrder = 100;

    if (typeof prevLayersMask === 'number' && this.mesh.layers) {
      this.mesh.layers.mask = prevLayersMask;
    }
    if (typeof prevRenderOrder === 'number') {
      this.mesh.renderOrder = prevRenderOrder;
    }

    // Restore the previous mesh's visibility state so darkness-gated lights
    // don't flash visible for one frame during zoom-triggered geometry rebuilds.
    if (prevVisible !== undefined) {
      this.mesh.visible = prevVisible;
    }

    if (prevMeshParent && typeof prevMeshParent.add === 'function') {
      prevMeshParent.add(this.mesh);
      this._meshParent = prevMeshParent;
    }
  }

  updateAnimation(timeInfo, globalDarkness, skyTint) {
    const dtSec = (timeInfo && typeof timeInfo.delta === 'number') ? timeInfo.delta : 0;
    const dtMs = dtSec * 1000;
    const tMs = (timeInfo && typeof timeInfo.elapsed === 'number') ? (timeInfo.elapsed * 1000) : 0;
    const tSec = (timeInfo && typeof timeInfo.elapsed === 'number') ? timeInfo.elapsed : 0;
    const { type, speed, intensity, reverse } = this._getAnimationOptions();

    // Match Foundry UI responsiveness: color intensity reads from the live placeable
    // document (same pattern as _getAnimationOptions), not only cached updateData.
    try {
      const liveDoc = this._resolveLiveLightDoc() || this.document;
      const liveCfg = liveDoc?.config && typeof liveDoc.config === 'object' ? liveDoc.config : null;
      if (liveCfg && this.material?.uniforms?.uColoration) {
        this.material.uniforms.uColoration.value = this._colorIntensity01FromConfig(liveCfg);
      }
    } catch (_) {
    }

    // "Sun Light" / darkness-driven intensity response.
    // This is a MapShine enhancement which modulates the light intensity based on
    // the scene darkness level (0 = day, 1 = night).
    let darknessMul = 1.0;
    let hasDarknessResponse = false;
    try {
      const dr = this.document?.config?.darknessResponse;
      if (dr && typeof dr === 'object' && dr.enabled === true) {
        hasDarknessResponse = true;
        const d0 = (typeof globalDarkness === 'number' && Number.isFinite(globalDarkness)) ? globalDarkness : 0.0;
        const d = Math.max(0.0, Math.min(1.0, d0));

        // invert=true means "day=1" at darkness=0.
        const invert = dr.invert !== false;
        let x = invert ? (1.0 - d) : d;

        const exp0 = (typeof dr.exponent === 'number' && Number.isFinite(dr.exponent)) ? dr.exponent : 1.0;
        const exp = Math.max(0.01, exp0);
        x = Math.pow(Math.max(0.0, Math.min(1.0, x)), exp);

        const min0 = (typeof dr.min === 'number' && Number.isFinite(dr.min)) ? dr.min : 0.0;
        const max0 = (typeof dr.max === 'number' && Number.isFinite(dr.max)) ? dr.max : 1.0;

        const minV = Math.max(0.0, Math.min(1.0, min0));
        const maxV = Math.max(0.0, Math.min(1.0, max0));

        darknessMul = minV + (maxV - minV) * x;
        // Keep a small floor so we don't hit degenerate states.
        darknessMul = Math.max(0.0, darknessMul);
      }
    } catch (_) {
    }

    // Calculate zoom once per light/frame and reuse it for inset conversion and
    // zoom-change checks. This prevents duplicate camera/renderer probing.
    const zoomNow = this._getEffectiveZoom();
    const insetPx = this._getWallInsetPx();
    const hasScreenStableInset = Number.isFinite(insetPx) && insetPx > 0.0001;
    const insetWorldPx = hasScreenStableInset ? this._getWallInsetWorldPx(zoomNow) : 0;
    const zoomPrev = this._lastInsetZoom;
    const zoomChanged = (zoomPrev === null)
      || (!Number.isFinite(zoomPrev))
      || (!Number.isFinite(zoomNow))
      || (Math.abs(zoomNow - zoomPrev) / Math.max(1e-6, Math.abs(zoomPrev)) > 0.01);

    // Rebuilds for inset/zoom are only meaningful when:
    // - wall inset is actually enabled, and
    // - we are using a wall-clipped polygon (not circle fallback).
    // Otherwise this can trigger expensive geometry churn with no visual change.
    const insetRebuildRelevant = hasScreenStableInset && !this._usingCircleFallback;

    // Inset is SCREEN-pixel stable, so the world-space inset changes with zoom.
    // Rebuild the wall-clipped geometry when zoom changes so the perceived thickness remains stable.
    const needsInsetUpdate = insetRebuildRelevant && (
      (this._lastInsetWorldPx === null)
      || (Math.abs(insetWorldPx - this._lastInsetWorldPx) > 0.25)
      || zoomChanged
    );

    // Throttle rebuilds while zooming; ~5Hz is sufficient for inset stability and
    // significantly reduces rebuild pressure on scenes with many lights.
    if (needsInsetUpdate && (tSec - this._lastInsetUpdateAtSec) > 0.2) {
      try {
        this._lastInsetWorldPx = insetWorldPx;
        this._lastInsetUpdateAtSec = tSec;
        this._lastInsetZoom = Number.isFinite(zoomNow) ? zoomNow : null;
        this.updateData(this.document, true);
      } catch (_) {
      }
    } else if (!insetRebuildRelevant) {
      // Keep trackers coherent without forcing geometry rebuilds.
      this._lastInsetWorldPx = insetWorldPx;
      this._lastInsetZoom = Number.isFinite(zoomNow) ? zoomNow : null;
    }

    // Optional runtime debug (off by default):
    // window.MapShine.debugWallInset = true;
    // window.MapShine.debugWallInsetId = 'mapshine:...' (optional filter)
    try {
      const dbg = window.MapShine?.debugWallInset === true;
      const dbgId = window.MapShine?.debugWallInsetId;
      if (dbg && (!dbgId || String(dbgId) === String(this.id))) {
        if (!this._dbgInsetNextAt) this._dbgInsetNextAt = 0;
        if (tSec >= this._dbgInsetNextAt) {
          this._dbgInsetNextAt = tSec + 0.5;
          const insetPx = this._getWallInsetPx();
          let stageZoom = null;
          let composerZoom = null;
          let camInfo = null;
          try {
            const z = canvas?.stage?.scale?.x;
            stageZoom = (typeof z === 'number' && Number.isFinite(z)) ? z : null;
          } catch (_) {
          }
          try {
            const z = window.MapShine?.sceneComposer?.currentZoom;
            composerZoom = (typeof z === 'number' && Number.isFinite(z)) ? z : null;
          } catch (_) {
          }
          try {
            const cam = window.MapShine?.lightingEffect?.mainCamera || window.MapShine?.sceneComposer?.camera;
            const groundZ = window.MapShine?.sceneComposer?.groundZ ?? null;
            if (cam) {
              camInfo = {
                type: cam.isOrthographicCamera ? 'ortho' : (cam.isPerspectiveCamera ? 'perspective' : 'unknown'),
                zoom: (typeof cam.zoom === 'number' && Number.isFinite(cam.zoom)) ? cam.zoom : null,
                fov: (typeof cam.fov === 'number' && Number.isFinite(cam.fov)) ? cam.fov : null,
                camZ: (typeof cam.position?.z === 'number' && Number.isFinite(cam.position.z)) ? cam.position.z : null,
                groundZ,
              };
            }
          } catch (_) {
          }
          // eslint-disable-next-line no-console
          console.log('[MapShine][WallInset]', {
            id: this.id,
            zoomNow,
            zoomPrev,
            zoomChanged,
            stageZoom,
            composerZoom,
            camInfo,
            insetPx,
            insetWorldPx,
            lastInsetWorldPx: this._lastInsetWorldPx,
            needsInsetUpdate,
          });
        }
      }
    } catch (_) {
    }

    // Apply sky colour tint to Darkness Response lights.
    // This runs AFTER the inset/updateData section so that zoom-triggered
    // geometry rebuilds (which reset uColor) don't overwrite the tint.
    //
    // The tint is luminance-normalized so it only recolours, never brightens.
    // We always compute from _baseLightColor to avoid frame-over-frame compounding.
    if (hasDarknessResponse && this._baseLightColor && skyTint && typeof skyTint === 'object' && skyTint.intensity > 0) {
      const si = Math.max(0.0, skyTint.intensity); // allow > 1.0 for amplified tint
      // Luminance-normalize the tint so it only shifts hue, not brightness.
      // Rec.709 luminance weights.
      const tintLum = skyTint.r * 0.2126 + skyTint.g * 0.7152 + skyTint.b * 0.0722;
      const invLum = (tintLum > 1e-6) ? (1.0 / tintLum) : 1.0;
      const nr = skyTint.r * invLum;
      const ng = skyTint.g * invLum;
      const nb = skyTint.b * invLum;

      // Lerp base color toward base*normalizedTint by intensity, clamping to
      // prevent negative channels when si > 1.0.
      const dst = this.material.uniforms.uColor.value;
      const base = this._baseLightColor;
      dst.r = Math.max(0.0, base.r * (1.0 + (nr - 1.0) * si));
      dst.g = Math.max(0.0, base.g * (1.0 + (ng - 1.0) * si));
      dst.b = Math.max(0.0, base.b * (1.0 + (nb - 1.0) * si));
    } else if (this._baseLightColor) {
      // No tint active — restore base color in case tint was toggled off.
      this.material.uniforms.uColor.value.copy(this._baseLightColor);
    }

    const u = this.material.uniforms;
    // Reset to base values every frame; animated types will override.
    u.uRadius.value = this._baseRadiusPx;
    u.uBrightRadius.value = this._baseBrightRadiusPx;
    u.uIntensity.value = darknessMul;
    u.uTime.value = this.animation.time;
    u.uAnimType.value = 0;
    u.uAnimIntensity.value = 0;
    u.uPulse.value = 0.0;

    // Reset Cable Swing offsets unless the animation explicitly sets them.
    if (u.uCenterOffset?.value?.set) u.uCenterOffset.value.set(0, 0);
    if (u.uCookieRotationOffset) u.uCookieRotationOffset.value = 0.0;

    if (type === 'cableswing') {
      this._updateCableSwing(timeInfo, { speed, intensity, reverse });
    }

    if (!type || this._baseRadiusPx <= 0) {
      return;
    }

    if (type === 'torch') {
      const { brightnessPulse } = this.animateTorch(tMs, { speed, intensity, reverse });
      // Main beat is in the fragment shader; uIntensity follows SmoothNoise — ease jumps at cell boundaries.
      const iDr = Math.max(0, Math.min(1, (this._clamp(intensity, 0, 10) - 1) / 9));
      const minPulse = 0.88 - 0.26 * iDr;
      const maxPulse = 1.05 + 0.23 * iDr;
      const target = Math.max(minPulse, Math.min(maxPulse, brightnessPulse));
      if (typeof this._fireBrightnessSmoothed !== 'number' || !Number.isFinite(this._fireBrightnessSmoothed)) {
        this._fireBrightnessSmoothed = target;
      } else {
        const alpha = 1 - Math.exp(-Math.max(0, dtSec) * 1.6);
        this._fireBrightnessSmoothed += (target - this._fireBrightnessSmoothed) * Math.min(0.08, Math.max(0.02, alpha));
      }
      u.uIntensity.value = this._fireBrightnessSmoothed * darknessMul;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uAnimType.value = 20;
      u.uTime.value = this._shaderFireClock(this.animation.time);
    } else if (type === 'siren') {
      // Foundry siren uses animateTorch for brightnessPulse and a shader beam pattern.
      const { brightnessPulse, ratioPulse } = this.animateTorch(tMs, {
        speed,
        intensity,
        reverse,
        noiseScale: 3,
        windGusts: false,
      });
      u.uIntensity.value = brightnessPulse * darknessMul;
      u.uBrightRadius.value = this._baseRadiusPx * this._clamp(ratioPulse, 0, 1);
      u.uAnimType.value = 7;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'flame') {
      // Match torch: flicker on uIntensity only; keep authored bright/dim radii (no full-disk “breathing”).
      const { brightnessPulse } = this.animateTorch(tMs, { speed, intensity, reverse });
      const iDr = Math.max(0, Math.min(1, (this._clamp(intensity, 0, 10) - 1) / 9));
      const minPulse = 0.88 - 0.26 * iDr;
      const maxPulse = 1.05 + 0.23 * iDr;
      const target = Math.max(minPulse, Math.min(maxPulse, brightnessPulse));
      if (typeof this._fireBrightnessSmoothed !== 'number' || !Number.isFinite(this._fireBrightnessSmoothed)) {
        this._fireBrightnessSmoothed = target;
      } else {
        const alpha = 1 - Math.exp(-Math.max(0, dtSec) * 1.6);
        this._fireBrightnessSmoothed += (target - this._fireBrightnessSmoothed) * Math.min(0.08, Math.max(0.02, alpha));
      }
      u.uIntensity.value = this._fireBrightnessSmoothed * darknessMul;
      u.uAnimType.value = 21;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this._shaderFireClock(this.animation.time);
    } else if (type === 'pulse') {
      const { pulse, ratioPulse } = this.animatePulse(tMs, { speed, intensity, reverse });
      // Pulse drives a separate shader uniform; keep base intensity stable.
      u.uIntensity.value = 1.0 * darknessMul;
      u.uPulse.value = pulse;
      u.uBrightRadius.value = this._baseRadiusPx * this._clamp(ratioPulse, 0, 1);
      u.uAnimType.value = 22;
      u.uTime.value = this.animation.time;
    } else if (type === 'reactivepulse') {
      const { pulse, ratioPulse } = this.animateSoundPulse(dtMs, { speed, intensity, reverse });
      // Reactive pulse drives the same pulse shader.
      u.uIntensity.value = 1.0 * darknessMul;
      u.uPulse.value = pulse;
      u.uBrightRadius.value = this._baseRadiusPx * this._clamp(ratioPulse, 0, 1);
      u.uAnimType.value = 22;
    } else if (type === 'fairy') {
      // Foundry fairy is a shader-driven pattern; drive via uTime + uAnimType.
      const tSec = (reverse ? -tMs : tMs) / 1000;
      u.uAnimType.value = 2;
      // Foundry fairy shaders expect the raw intensity scale (0..10).
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
      u.uTime.value = tSec;
    } else if (type === 'wave') {
      // Foundry wave is a shader-driven ripple pattern; drive via uTime + uAnimType.
      const tSec = (reverse ? -tMs : tMs) / 1000;
      u.uAnimType.value = 1;
      // Foundry wave shaders expect the raw intensity scale (0..10).
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = tSec;
    } else if (type === 'chroma') {
      // Foundry chroma uses animateTime (config.mjs) and drives shader coloration.
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 3;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'energy') {
      // Foundry energy-field uses animateTime (config.mjs) and is coloration-only.
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 4;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'witchwave') {
      // Foundry bewitching-wave uses animateTime (config.mjs).
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 5;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'revolving') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 6;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'fog') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 8;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'sunburst') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 9;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'dome') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 10;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'emanation') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 11;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'hexa') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 12;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'ghost') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 13;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'vortex') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 14;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'rainbowswirl') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 15;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'radialrainbow') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 16;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'grid') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 17;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'starlight') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 18;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'smokepatch') {
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uAnimType.value = 19;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else {
      // For time-driven animations we still advance time to match Foundry.
      this.animateTime(tMs, { speed, intensity, reverse });
      u.uTime.value = this.animation.time;
    }

    // If we had to fall back to a simple circle because the LOS polygon
    // was not yet available when this light was created, try to upgrade
    // lazily once the LOS data exists.
    if (this._usingCircleFallback) {
      try {
        // Force a rebuild using the MapShine/Three wall masking path.
        // This avoids relying on Foundry's internal LightSource.los polygon.
        this.updateData(this.document, true);
      } catch (e) {
      }
    }
  }

  dispose() {
    if (this._cookieRetryTimeoutId !== null) {
      try { clearTimeout(this._cookieRetryTimeoutId); } catch (_) {}
      this._cookieRetryTimeoutId = null;
    }
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
  }
}