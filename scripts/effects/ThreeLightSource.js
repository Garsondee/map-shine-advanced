/**
 * @fileoverview ThreeLightSource
 * Replicates Foundry VTT's PointLightSource logic in Three.js
 */
import Coordinates from '../utils/coordinates.js';
import { FoundryLightingShaderChunks } from './FoundryLightingShaderChunks.js';

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

    this.animation = {
      seed: Math.floor(Math.random() * 100000),
      time: 0,
      noise: null,
      reactiveSoundAmplitude: 0
    };

    this._baseRadiusPx = 0;
    this._baseBrightRadiusPx = 0;
    this._baseRatio = 1;

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
  }

  _getWallInsetPx() {
    try {
      const inset = window.MapShine?.lightingEffect?.params?.wallInsetPx;
      return (typeof inset === 'number' && isFinite(inset)) ? Math.max(0, inset) : 0;
    } catch (_) {
      return 0;
    }
  }

  _getEffectiveZoom() {
    try {
      const z0 = window.MapShine?.sceneComposer?.currentZoom;
      if (typeof z0 === 'number' && isFinite(z0) && z0 > 0) return z0;
    } catch (_) {
    }

    try {
      const z1 = canvas?.stage?.scale?.x;
      if (typeof z1 === 'number' && isFinite(z1) && z1 > 0) return z1;
    } catch (_) {
    }

    return 1;
  }

  _getWallInsetWorldPx() {
    const insetPx = this._getWallInsetPx();
    if (!insetPx) return 0;

    const paddedInsetPx = insetPx + 6;

    const zoom = this._getEffectiveZoom();
    if (!Number.isFinite(zoom) || zoom <= 0) return paddedInsetPx;
    return paddedInsetPx / zoom;
  }

  /**
   * Get the ground plane Z position from SceneComposer.
   * Lights should be positioned at this Z level (plus a small offset)
   * to align with the base plane after the camera/ground refactor.
   * @returns {number} Ground Z position (default 1000)
   * @private
   */
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
        uAlpha: { value: 0.5 },
        uAttenuation: { value: 0.5 },
        uTime: { value: 0 },
        uAnimType: { value: 0 },
        uAnimIntensity: { value: 0 },
        uSeed: { value: 0 },
        uIntensity: { value: 1.0 },
        uPulse: { value: 0.0 },
        uBrightness: { value: 1.0 },
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
        uniform float uAlpha;
        uniform float uAttenuation;
        uniform float uTime;
        uniform float uAnimType;
        uniform float uAnimIntensity;
        uniform float uSeed;
        uniform float uIntensity;
        uniform float uPulse;
        uniform float uBrightness;

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

        // Foundry VTT FBMHQ (ported 1:1 from base-shader-mixin.mjs)
        float fbm(in vec2 uv, in float smoothness) {
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
          float distPx = length(vPos);
          // Normalized distance [0..1]
          float r = distPx / uRadius; 
          vec2 vUvs = (vPos / (max(uRadius, 1.0) * 2.0)) + vec2(0.5);
          float dist = r;

          if (r >= 1.0) discard;

          // uAttenuation acts as a "Softness" factor [0..1]
          // 0.0 = Hard Edges (Plateaus)
          // 1.0 = Soft Edges (Linear Gradients)
          float softness = uAttenuation; 

          // 1. OUTER CIRCLE (Dim Radius)
          // At softness 0: Hard cut at r=1.0
          // At softness 1: Fades linearly from center (r=0) to edge (r=1)
          float outerStart = 1.0 - softness;
          float outerEnd = 1.0 + 0.0001; // Epsilon to avoid div/0
          float outerAlpha = 1.0 - smoothstep(outerStart, outerEnd, r);

          // 2. INNER CIRCLE (Bright Radius)
          // This adds the "core" brightness.
          // Normalized Bright Radius
          float b = uBrightRadius / uRadius;
          // Interpolate the transition window based on softness
          // Softness expands the gradient outward from the bright radius border
          float innerStart = b * (1.0 - softness);
          float innerEnd = b + (softness * (1.0 - b)) + 0.0001;
          float innerAlpha = 1.0 - smoothstep(innerStart, innerEnd, r);

          // 3. COMPOSITION
          // Foundry lights are essentially stacked layers.
          // Base Dim Layer = 0.5 intensity.
          // Bright Boost Layer = 0.5 intensity.
          // Total Center Intensity = 1.0.
          float intensity = (0.5 * outerAlpha) + (0.5 * innerAlpha);

          // Shader-driven animation factor and potential color shift.
          float animAlphaMul = 1.0;
          vec3 outColor = uColor;

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
            // Foundry VTT torch (mimic coloration: brightnessPulse scales color).
${FoundryLightingShaderChunks.torch}
          } else if (uAnimType > 20.5 && uAnimType < 21.5) {
            // Foundry VTT flame (mimic coloration: noisy inner/outer flame lobes).
${FoundryLightingShaderChunks.flame}
          } else if (uAnimType > 21.5 && uAnimType < 22.5) {
            // Foundry VTT pulse/reactivepulse (mimic illumination+coloration).
${FoundryLightingShaderChunks.pulse}
          }

          // Final Alpha calculation
          float alpha = intensity * uAlpha * uIntensity * animAlphaMul;

          float fairyBoost = (uAnimType > 1.5 && uAnimType < 2.5) ? 3.0 : 1.0;
          alpha *= fairyBoost;

          // Additive Output
          gl_FragColor = vec4(outColor * uBrightness * (0.75 + 0.25 * fairyBoost), alpha);
        }
      `,
      transparent: true,
      // Standard additive: SrcAlpha * color + 1 * dest
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
      depthWrite: false,
      depthTest: false,
    });

    this.material.toneMapped = false;

    this.updateData(this.document, true);

    // Stable per-light seed in [0..1]
    this.material.uniforms.uSeed.value = (this.animation.seed % 100000) / 100000;
  }

  updateData(doc, forceRebuild = false) {
    this.document = doc;
    const config = doc.config;
    const THREE = window.THREE;

    const prevRadiusPx = this._baseRadiusPx;

    // 1. Color Parsing
    const c = new THREE.Color(1, 1, 1);
    const colorInput = config.color;

    if (colorInput) {
      if (typeof colorInput === 'string') c.set(colorInput);
      else if (typeof colorInput === 'number') c.setHex(colorInput);
      else if (typeof colorInput === 'object' && colorInput.r !== undefined) c.copy(colorInput);
    }
    
    // Reduced saturation boost (was 1.1, causing colors to be ~50% too intense)
    const hsl = {};
    c.getHSL(hsl);
    if (hsl.s > 0) {
      c.setHSL(hsl.h, Math.min(1.0, hsl.s * 1.05), hsl.l);
    }
    this.material.uniforms.uColor.value.copy(c);

    // 2. Brightness / intensity logic (reduced by 25% to match Foundry VTT)
    const luminosity = config.luminosity ?? 0.5;
    const satBonus = (hsl.s > 0.2) ? 0.5 : 0.0;
    this.material.uniforms.uBrightness.value = 1.2 + (luminosity * 1.5) + satBonus;

    // 3. Geometry
    const dim = config.dim || 0;
    const bright = config.bright || 0;
    const radius = Math.max(dim, bright);
    
    const d = canvas.dimensions;
    const pxPerUnit = d.size / d.distance;
    const rPx = radius * pxPerUnit;
    const brightPx = bright * pxPerUnit;

    const wallInsetPx = this._getWallInsetWorldPx();
    const rPxInset = Math.max(0, rPx - wallInsetPx);
    const brightPxInset = Math.max(0, brightPx - wallInsetPx);

    if (this._lastInsetWorldPx === null) {
      this._lastInsetWorldPx = wallInsetPx;
      this._lastInsetUpdateAtSec = 0;
    }

    this._baseRadiusPx = rPxInset;
    this._baseBrightRadiusPx = brightPxInset;
    this._baseRatio = rPxInset > 0 ? (brightPxInset / rPxInset) : 1;

    this.material.uniforms.uRadius.value = rPxInset;
    this.material.uniforms.uBrightRadius.value = brightPxInset;
    this.material.uniforms.uAlpha.value = config.alpha ?? 0.5;

    // --- FOUNDRY ATTENUATION MATH ---
    // Maps user input [0,1] to a non-linear shader curve [0,1]
    const rawAttenuation = config.attenuation ?? 0.5;
    const computedAttenuation = (Math.cos(Math.PI * Math.pow(rawAttenuation, 1.5)) - 1) / -2;
    this.material.uniforms.uAttenuation.value = computedAttenuation;

    // 4. Position
    // Light meshes must be at the ground plane Z level (plus small offset)
    // to align with the base plane after the camera/ground refactor.
    const worldPos = Coordinates.toWorld(doc.x, doc.y);
    const groundZ = this._getGroundZ();
    const lightZ = groundZ + 0.1; // Slightly above ground plane

    const radiusChanged = Math.abs((prevRadiusPx ?? 0) - (rPxInset ?? 0)) > 1e-3;
    if (forceRebuild || !this.mesh || radiusChanged) {
      this.rebuildGeometry(worldPos.x, worldPos.y, rPxInset, lightZ);
    } else {
      this.mesh.position.set(worldPos.x, worldPos.y, lightZ);
    }
  }

  _clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }

  _mix(a, b, t) {
    return (a * (1 - t)) + (b * t);
  }

  _getAnimationOptions() {
    const a = this.document?.config?.animation;
    const type = a?.type ?? null;
    const speed = typeof a?.speed === 'number' ? a.speed : 5;
    const intensity = typeof a?.intensity === 'number' ? a.intensity : 5;
    const reverse = !!a?.reverse;
    return { type, speed, intensity, reverse };
  }

  animateTime(tMs, { speed = 5, intensity = 5, reverse = false } = {}) {
    let t = tMs;
    if (reverse) t *= -1;
    this.animation.time = ((speed * t) / 5000) + this.animation.seed;
    return this.animation.time;
  }

  animateFlickering(tMs, { speed = 5, intensity = 5, reverse = false, amplification = 1 } = {}) {
    this.animateTime(tMs, { speed, intensity, reverse });

    const amplitude = amplification * 0.45;
    if (!this.animation.noise) {
      this.animation.noise = new SmoothNoise({ amplitude, scale: 3, maxReferences: 2048 });
    } else if (this.animation.noise.amplitude !== amplitude) {
      this.animation.noise.amplitude = amplitude;
    }

    const n = this.animation.noise.generate(this.animation.time);
    const brightnessPulse = 0.55 + n;
    const ratioPulse = (this._baseRatio * 0.9) + (n * 0.222);
    return { brightnessPulse, ratioPulse };
  }

  animateTorch(tMs, { speed = 5, intensity = 5, reverse = false } = {}) {
    return this.animateFlickering(tMs, { speed, intensity, reverse, amplification: intensity / 5 });
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

  animateSoundPulse(dtMs, { speed = 5, intensity = 5, reverse = false } = {}) {
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

  rebuildGeometry(worldX, worldY, radiusPx, lightZ) {
    const THREE = window.THREE;
    const prevMeshParent = this.mesh?.parent ?? this._meshParent;
    const prevLayersMask = this.mesh?.layers?.mask;
    const prevRenderOrder = this.mesh?.renderOrder;

    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.removeFromParent();
    }

    let geometry;
    let shapePoints = null;

    try {
      const placeable = canvas.lighting?.get(this.id);
      const lightSource = placeable?.lightSource ?? placeable?.source;
      if (lightSource) {
        // Prefer the LOS polygon, which is already clipped by walls.
        const poly = lightSource.los || lightSource.shape;
        const points = poly?.points;
        if (points && points.length >= 6) {
          shapePoints = [];
          for (let i = 0; i < points.length; i += 2) {
            const v = Coordinates.toWorld(points[i], points[i + 1]);
            // Convert to local space around the light center
            shapePoints.push(new THREE.Vector2(v.x - worldX, v.y - worldY));
          }
        }
      }
    } catch (e) { }

    const wallInsetPx = this._getWallInsetWorldPx();
    if (shapePoints && shapePoints.length > 2) {
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

      const shape = new THREE.Shape(shapePoints);
      geometry = new THREE.ShapeGeometry(shape);
      this._usingCircleFallback = false;
    } else {
      // Circle Fallback - bumped segments to 128 for smoother large radii
      geometry = new THREE.CircleGeometry(radiusPx, 128);
      this._usingCircleFallback = true;
    }

    this.mesh = new THREE.Mesh(geometry, this.material);
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

    if (prevMeshParent && typeof prevMeshParent.add === 'function') {
      prevMeshParent.add(this.mesh);
      this._meshParent = prevMeshParent;
    }
  }

  updateAnimation(timeInfo, globalDarkness) {
    const dtMs = (timeInfo && typeof timeInfo.delta === 'number') ? (timeInfo.delta * 1000) : 0;
    const tMs = (timeInfo && typeof timeInfo.elapsed === 'number') ? (timeInfo.elapsed * 1000) : 0;
    const tSec = (timeInfo && typeof timeInfo.elapsed === 'number') ? timeInfo.elapsed : 0;
    const { type, speed, intensity, reverse } = this._getAnimationOptions();

    const insetWorldPx = this._getWallInsetWorldPx();
    const needsInsetUpdate = (this._lastInsetWorldPx === null) || (Math.abs(insetWorldPx - this._lastInsetWorldPx) > 0.5);
    if (needsInsetUpdate && (tSec - this._lastInsetUpdateAtSec) > 0.1) {
      try {
        this._lastInsetWorldPx = insetWorldPx;
        this._lastInsetUpdateAtSec = tSec;
        this.updateData(this.document, true);
      } catch (_) {
      }
    }

    const u = this.material.uniforms;
    // Reset to base values every frame; animated types will override.
    u.uRadius.value = this._baseRadiusPx;
    u.uBrightRadius.value = this._baseBrightRadiusPx;
    u.uIntensity.value = 1.0;
    u.uTime.value = this.animation.time;
    u.uAnimType.value = 0;
    u.uAnimIntensity.value = 0;
    u.uPulse.value = 0.0;

    if (!type || this._baseRadiusPx <= 0) {
      return;
    }

    if (type === 'torch') {
      const { brightnessPulse, ratioPulse } = this.animateTorch(tMs, { speed, intensity, reverse });
      u.uIntensity.value = brightnessPulse;
      u.uBrightRadius.value = this._baseRadiusPx * this._clamp(ratioPulse, 0, 1);
      u.uAnimType.value = 20;
      u.uTime.value = this.animation.time;
    } else if (type === 'siren') {
      // Foundry siren uses animateTorch for brightnessPulse and a shader beam pattern.
      const { brightnessPulse, ratioPulse } = this.animateTorch(tMs, { speed, intensity, reverse });
      u.uIntensity.value = brightnessPulse;
      u.uBrightRadius.value = this._baseRadiusPx * this._clamp(ratioPulse, 0, 1);
      u.uAnimType.value = 7;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'flame') {
      const { brightnessPulse, ratioPulse } = this.animateFlickering(tMs, { speed, intensity, reverse });
      u.uIntensity.value = brightnessPulse;
      u.uBrightRadius.value = this._baseRadiusPx * this._clamp(ratioPulse, 0, 1);
      u.uAnimType.value = 21;
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
      u.uTime.value = this.animation.time;
    } else if (type === 'pulse') {
      const { pulse, ratioPulse } = this.animatePulse(tMs, { speed, intensity, reverse });
      // Pulse drives a separate shader uniform; keep base intensity stable.
      u.uIntensity.value = 1.0;
      u.uPulse.value = pulse;
      u.uBrightRadius.value = this._baseRadiusPx * this._clamp(ratioPulse, 0, 1);
      u.uAnimType.value = 22;
      u.uTime.value = this.animation.time;
    } else if (type === 'reactivepulse') {
      const { pulse, ratioPulse } = this.animateSoundPulse(dtMs, { speed, intensity, reverse });
      // Reactive pulse drives the same pulse shader.
      u.uIntensity.value = 1.0;
      u.uPulse.value = pulse;
      u.uBrightRadius.value = this._baseRadiusPx * this._clamp(ratioPulse, 0, 1);
      u.uAnimType.value = 22;
    } else if (type === 'fairy') {
      // Foundry fairy is a shader-driven pattern; drive via uTime + uAnimType.
      const tSec = (reverse ? -tMs : tMs) / 1000;
      u.uAnimType.value = 2;
      // Foundry fairy shaders expect the raw intensity scale (0..10).
      u.uAnimIntensity.value = this._clamp(intensity, 0, 10);
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
        const placeable = canvas.lighting?.get(this.id);
        const lightSource = placeable?.lightSource ?? placeable?.source;
        const poly = lightSource?.los;
        const points = poly?.points;
        if (points && points.length >= 6) {
          const d = canvas.dimensions;
          const config = this.document.config;
          const dim = config.dim || 0;
          const bright = config.bright || 0;
          const radius = Math.max(dim, bright);
          const pxPerUnit = d.size / d.distance;
          const rPx = radius * pxPerUnit;

          const wallInsetPx = this._getWallInsetWorldPx();
          const rPxInset = Math.max(0, rPx - wallInsetPx);

          const worldPos = Coordinates.toWorld(this.document.x, this.document.y);
          const groundZ = this._getGroundZ();
          const lightZ = groundZ + 0.1;

          this.rebuildGeometry(worldPos.x, worldPos.y, rPxInset, lightZ);
        }
      } catch (e) {
      }
    }
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
  }
}