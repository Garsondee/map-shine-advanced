/**
 * @fileoverview Procedural coal / wood bed shader for FireEffectV2.
 *
 * All noise + sparks operate in **overlay pixel space** (stable on 8k maps).
 * Individual spark cells flare up and die via sin envelopes — no whole-mask flash.
 * @module compositor-v2/effects/fire-coal-bed-shader
 */

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Keep band thresholds ordered so palette mixes stay predictable. */
function normalizeCoalBedBands(params) {
  const raw = [
    clamp01(Number(params?.coalBedBandCharEnd) ?? 0.18),
    clamp01(Number(params?.coalBedBandHotEnd) ?? 0.42),
    clamp01(Number(params?.coalBedBandWarmEnd) ?? 0.62),
    clamp01(Number(params?.coalBedBandAshWarmEnd) ?? 0.82),
  ];
  const minGap = 0.04;
  for (let i = 1; i < raw.length; i++) {
    raw[i] = Math.max(raw[i], raw[i - 1] + minGap);
  }
  raw[3] = Math.min(raw[3], 0.98);
  for (let i = raw.length - 2; i >= 0; i--) {
    raw[i] = Math.min(raw[i], raw[i + 1] - minGap);
  }
  raw[0] = Math.max(raw[0], 0.02);
  return raw;
}

/**
 * @param {import('three').IUniform} uniform
 * @param {unknown} value
 * @param {string} fallbackHex
 */
function applyColorUniform(uniform, value, fallbackHex) {
  if (!uniform?.value) return;
  try {
    if (value && typeof value === 'object' && 'r' in value && 'g' in value && 'b' in value) {
      uniform.value.setRGB(Number(value.r), Number(value.g), Number(value.b));
    } else {
      uniform.value.set(String(value ?? fallbackHex));
    }
  } catch (_) {
    try { uniform.value.set(fallbackHex); } catch (_) {}
  }
}

/** Default param values merged into FireEffectV2.params. */
export const COAL_BED_DEFAULT_PARAMS = {
  coalBedEnabled: true,
  coalBedIntensity: 0.24,
  coalBedOpacity: 0.53,
  coalBedPreset: 'coal',

  /** Smolder block size in overlay pixels. */
  coalBedChunkScale: 36.0,
  coalBedChunkContrast: 0.5,
  coalBedChunkAspect: 3.0,
  /** HDR spark cell size in overlay pixels (lower = more, smaller flares). */
  coalBedGrainScale: 2.0,
  coalBedGrainAngle: 1.7,

  coalBedColorChar: '#1a100c',
  coalBedColorHot: '#ffffff',
  coalBedColorWarm: '#ff4400',
  coalBedColorAshWarm: '#aa5030',
  coalBedColorAshCool: '#524840',

  coalBedBandCharEnd: 0.05,
  coalBedBandHotEnd: 0.3,
  coalBedBandWarmEnd: 0.41,
  coalBedBandAshWarmEnd: 0.95,

  coalBedSaturation: 0.95,
  coalBedContrast: 1.22,
  coalBedRimStrength: 0.04,
  coalBedEmissiveGain: 12.5,
  /** Fraction of spark cells that can flare (0–1). Higher = more coverage. */
  coalBedFlareDensity: 0.37,

  coalBedScrollSpeed: 0.0,
  coalBedScrollAngle: 0.0,
  coalBedEvolveSpeed: 2.0,
  coalBedPulseSpeed: 1.8,
  /** Organic warp + glowing crack vein strength. */
  coalBedTurbulence: 0.13,

  coalBedHeatLevels: 12.0,
  coalBedSplatRate: 0.0,
  /** Upward drift speed on micro-sparks (0 = static). */
  coalBedFlareChaos: 0.85,

  coalBedMaskLo: 0.8,
  coalBedMaskHi: 1.0,
  /** Post-process soften radius in overlay pixels (blurs cell squares + mask border). */
  coalBedEdgeSoftness: 3.0,
  coalBedMaskExpand: 0.0,
  coalBedMaskDither: 0.5,
};

/** Preset overrides. */
export const COAL_BED_PRESETS = Object.freeze({
  coal: { ...COAL_BED_DEFAULT_PARAMS },
  wood: {
    coalBedChunkScale: 48.0,
    coalBedChunkAspect: 1.8,
    coalBedGrainAngle: 1.05,
    coalBedGrainScale: 7.0,
    coalBedColorChar: '#221008',
    coalBedColorHot: '#ffaa33',
    coalBedColorWarm: '#dd3300',
    coalBedColorAshWarm: '#884428',
    coalBedColorAshCool: '#443830',
    coalBedMaskExpand: 2.5,
    coalBedMaskDither: 0.26,
  },
  charcoal: {
    coalBedChunkScale: 28.0,
    coalBedChunkContrast: 3.0,
    coalBedGrainScale: 4.0,
    coalBedHeatLevels: 8.0,
    coalBedColorHot: '#ff5522',
    coalBedColorWarm: '#cc2200',
    coalBedPulseSpeed: 2.4,
    coalBedFlareDensity: 0.78,
  },
});

/**
 * @param {Record<string, unknown>} params
 * @param {string} presetId
 */
export function applyCoalBedPreset(params, presetId) {
  if (!params || typeof params !== 'object') return;
  const key = String(presetId ?? 'coal');
  const preset = COAL_BED_PRESETS[key] ?? COAL_BED_PRESETS.coal;
  Object.assign(params, preset);
  params.coalBedPreset = key in COAL_BED_PRESETS ? key : 'coal';
}

export function getCoalBedVertexShader() {
  return /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
}

export function getCoalBedFragmentShader() {
  return /* glsl */`
    uniform sampler2D uFireMask;
    uniform vec2 uMaskTexelSize;
    uniform vec2 uOverlayPixelSize;
    uniform float uTime;
    uniform float uEffectEnabled;
    uniform float uCoalBedEnabled;

    uniform float uIntensity;
    uniform float uOpacity;

    uniform float uMaskLo;
    uniform float uMaskExpand;
    uniform float uMaskDither;

    uniform float uSmolderBlockPx;
    uniform float uChunkContrast;
    uniform float uChunkAspect;
    uniform float uFlarePixelPx;
    uniform float uGrainAngle;

    uniform vec3 uColorChar;
    uniform vec3 uColorHot;
    uniform vec3 uColorWarm;
    uniform vec3 uColorAshWarm;
    uniform vec3 uColorAshCool;

    uniform float uBandCharEnd;
    uniform float uBandHotEnd;
    uniform float uBandWarmEnd;
    uniform float uBandAshWarmEnd;
    uniform float uBandSoftness;

    uniform float uSaturation;
    uniform float uContrast;
    uniform float uEmissiveGain;

    uniform float uEvolveSpeed;
    uniform float uPulseSpeed;
    uniform float uHeatLevels;
    uniform float uFlareDensity;
    uniform float uSoftenPx;
    uniform float uTurbulence;
    uniform float uParallaxDepth;
    uniform float uFlareChaos;

    varying vec2 vUv;

    float hash21(vec2 p) {
      p = fract(p * vec2(127.1, 311.7));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }

    vec2 rotate2(vec2 p, float a) {
      float c = cos(a), s = sin(a);
      return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
    }

    float maskSample(vec2 uv) {
      return texture2D(uFireMask, clamp(uv, 0.0, 1.0)).r;
    }

    float expandMask(vec2 uv) {
      vec2 t = uMaskTexelSize;
      float m = maskSample(uv);
      if (uMaskExpand <= 0.001) return m;

      m = max(m, maskSample(uv + vec2( t.x, 0.0)));
      m = max(m, maskSample(uv + vec2(-t.x, 0.0)));
      m = max(m, maskSample(uv + vec2(0.0,  t.y)));
      m = max(m, maskSample(uv + vec2(0.0, -t.y)));

      if (uMaskExpand > 1.25) {
        m = max(m, maskSample(uv + vec2( t.x,  t.y)));
        m = max(m, maskSample(uv + vec2(-t.x,  t.y)));
        m = max(m, maskSample(uv + vec2( t.x, -t.y)));
        m = max(m, maskSample(uv + vec2(-t.x, -t.y)));
      }
      if (uMaskExpand > 2.25) {
        m = max(m, maskSample(uv + vec2(2.0 * t.x, 0.0)));
        m = max(m, maskSample(uv + vec2(-2.0 * t.x, 0.0)));
        m = max(m, maskSample(uv + vec2(0.0, 2.0 * t.y)));
        m = max(m, maskSample(uv + vec2(0.0, -2.0 * t.y)));
      }
      return m;
    }

    float softenNorm() {
      return clamp(uSoftenPx / 24.0, 0.0, 1.0);
    }

    float maskWeightAt(vec2 uv) {
      vec2 maskCell = floor(uv / max(uMaskTexelSize, vec2(0.0001)));
      float d0 = hash21(maskCell);
      float d1 = hash21(maskCell + 17.3);

      float m = expandMask(uv);
      m += (d0 - 0.5) * uMaskDither + (d1 - 0.5) * uMaskDither * 0.65;

      float thr = uMaskLo + (d0 - 0.5) * uMaskDither * 0.45;
      float feather = uMaskDither * 0.35 + mix(0.02, 0.42, softenNorm());
      return smoothstep(thr - feather, thr + feather, m);
    }

    vec3 paletteSoft(float h) {
      float t = clamp(h, 0.0, 1.0);
      float edge = clamp(uBandSoftness + softenNorm() * 0.08, 0.012, 0.18);
      vec3 col = uColorAshCool;
      col = mix(col, uColorChar, smoothstep(uBandCharEnd - edge, uBandCharEnd + edge, t));
      col = mix(col, uColorAshWarm, smoothstep(uBandHotEnd - edge, uBandHotEnd + edge, t));
      col = mix(col, uColorWarm, smoothstep(uBandWarmEnd - edge, uBandWarmEnd + edge, t));
      col = mix(col, uColorHot, smoothstep(uBandAshWarmEnd - edge, uBandAshWarmEnd + edge, t));
      return col;
    }

    float normalizeBedHeat(float heat) {
      return smoothstep(0.0, 0.58, clamp(heat, 0.0, 1.0));
    }

    vec2 distortPx(vec2 p, float time) {
      float t = time * uEvolveSpeed * 0.35;
      float amp = mix(1.5, 9.0, clamp(uTurbulence, 0.0, 1.5) * 0.55 + 0.12);
      p += vec2(sin(p.y * 0.022 + t), cos(p.x * 0.022 - t * 0.85)) * amp;
      p += vec2(sin(p.x * 0.008 - t * 0.4), sin(p.y * 0.011 + t * 0.55)) * amp * 0.45;
      return p;
    }

    // Glowing crack veins — sine lattice + cheap 3x3 Voronoi edges.
    float crackHeat(vec2 pxPos, float time) {
      vec2 uvCr = pxPos / max(10.0, uSmolderBlockPx * 1.35);
      uvCr = distortPx(uvCr * 4.0, time) * 0.25;

      float wave = sin(uvCr.x * 3.14159265) * cos(uvCr.y * 3.14159265);
      float veins = 1.0 - smoothstep(0.08, 0.42, abs(wave));

      vec2 ci = floor(uvCr * 2.2);
      vec2 cf = fract(uvCr * 2.2);
      float vorDist = 1.0;
      for (int oy = -1; oy <= 1; oy++) {
        for (int ox = -1; ox <= 1; ox++) {
          vec2 neighbor = vec2(float(ox), float(oy));
          vec2 rp = neighbor + vec2(hash21(ci + neighbor), hash21(ci + neighbor + 31.7)) - cf;
          vorDist = min(vorDist, dot(rp, rp));
        }
      }
      float vorCracks = smoothstep(0.11, 0.018, sqrt(vorDist));

      float crackMix = clamp(0.35 + uTurbulence * 0.45 + uChunkContrast * 0.04, 0.2, 1.0);
      return clamp(max(veins, vorCracks) * crackMix, 0.0, 1.0);
    }

    float smolderHeatCell(vec2 cell, float time) {
      float seed = hash21(cell);

      float drift = sin(time * uEvolveSpeed * mix(0.25, 1.0, seed) + seed * 6.28318) * 0.5 + 0.5;
      float tick = floor(time * uEvolveSpeed * mix(0.05, 0.35, seed));
      float n = hash21(cell + tick * 13.0);

      float thresh = 0.52 - uChunkContrast * 0.06;
      float soft = mix(0.08, 0.62, softenNorm()) + uSoftenPx / max(6.0, uSmolderBlockPx);
      return smoothstep(thresh - soft, thresh + soft, n) * mix(0.10, 0.40, drift);
    }

    float smolderHeatAt(vec2 pxPos, float time) {
      vec2 pxWarp = distortPx(pxPos, time);
      float blockPx = max(8.0, uSmolderBlockPx);
      vec2 smolderPx = rotate2(pxWarp, uGrainAngle);
      smolderPx.x /= max(0.25, uChunkAspect);
      vec2 g = smolderPx / blockPx;
      vec2 i = floor(g);
      vec2 f = fract(g);
      float blend = mix(0.12, 0.92, softenNorm()) + uSoftenPx / max(blockPx, 4.0);
      blend = clamp(blend, 0.12, 0.95);
      f = smoothstep(0.5 - blend, 0.5 + blend, f);

      float h00 = smolderHeatCell(i, time);
      float h10 = smolderHeatCell(i + vec2(1.0, 0.0), time);
      float h01 = smolderHeatCell(i + vec2(0.0, 1.0), time);
      float h11 = smolderHeatCell(i + vec2(1.0, 1.0), time);
      float hGrid = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);

      float cracks = crackHeat(pxWarp, time);
      float crackMix = mix(0.62 + uTurbulence * 0.22, 0.48 + uTurbulence * 0.14, softenNorm());
      float h = mix(hGrid * (1.0 - cracks * 0.55), max(hGrid, cracks * 0.92), crackMix);

      vec2 gritCell = floor(pxWarp / max(2.0, uFlarePixelPx * 0.5));
      float grit = hash21(gritCell + floor(time * mix(2.0, 6.0, hash21(i))));
      float gritSoft = mix(0.05, 0.42, softenNorm()) + uSoftenPx * 0.02;
      float gritAmt = mix(0.16, 0.06, softenNorm());
      h = max(h, smoothstep(0.78 - uChunkContrast * 0.04 - gritSoft, 0.78 - uChunkContrast * 0.04 + gritSoft, grit) * gritAmt);

      float levels = max(2.0, mix(uHeatLevels, 48.0, softenNorm() * 0.88));
      float hQuant = floor(h * levels + 0.001) / levels;
      float softenMix = clamp(uSoftenPx / 5.0, 0.0, 1.0);
      return mix(hQuant, h, softenMix);
    }

    // Grid-only smolder — no cracks / grit / warp. Cheap taps for spatial soften.
    float smolderHeatGridAt(vec2 pxPos, float time) {
      float blockPx = max(8.0, uSmolderBlockPx);
      vec2 smolderPx = rotate2(pxPos, uGrainAngle);
      smolderPx.x /= max(0.25, uChunkAspect);
      vec2 g = smolderPx / blockPx;
      vec2 i = floor(g);
      vec2 f = fract(g);
      float blend = mix(0.12, 0.92, softenNorm()) + uSoftenPx / max(blockPx, 4.0);
      blend = clamp(blend, 0.12, 0.95);
      f = smoothstep(0.5 - blend, 0.5 + blend, f);

      float h00 = smolderHeatCell(i, time);
      float h10 = smolderHeatCell(i + vec2(1.0, 0.0), time);
      float h01 = smolderHeatCell(i + vec2(0.0, 1.0), time);
      float h11 = smolderHeatCell(i + vec2(1.0, 1.0), time);
      float hGrid = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);

      float levels = max(2.0, mix(uHeatLevels, 48.0, softenNorm() * 0.88));
      float hQuant = floor(hGrid * levels + 0.001) / levels;
      float softenMix = clamp(uSoftenPx / 5.0, 0.0, 1.0);
      return mix(hQuant, hGrid, softenMix);
    }

    // 5-tap quincunx on cheap grid heat — smooth round falloff, ~5× cheaper than 7×7 separable.
    float smolderHeatBlurred(vec2 pxPos, float time) {
      float hFull = smolderHeatAt(pxPos, time);
      if (uSoftenPx < 1.5) return hFull;

      float s = softenNorm();
      float r = max(1.5, uSoftenPx * mix(0.32, 0.52, s));
      float hC = smolderHeatGridAt(pxPos, time);
      float hX = smolderHeatGridAt(pxPos + vec2(r, 0.0), time);
      float hXm = smolderHeatGridAt(pxPos + vec2(-r, 0.0), time);
      float hY = smolderHeatGridAt(pxPos + vec2(0.0, r), time);
      float hYm = smolderHeatGridAt(pxPos + vec2(0.0, -r), time);
      float hSoft = hC * 0.40 + (hX + hXm + hY + hYm) * 0.15;

      return mix(hFull, max(hFull, hSoft), s * 0.92);
    }

    // Lightweight mask feather — derivative soften + 4 cardinal taps (no 49-tap separable pass).
    float maskBorderFeather(vec2 uv) {
      float w = maskWeightAt(uv);
      float s = softenNorm();
      float fw = fwidth(w) * mix(1.0, uSoftenPx * 0.65, s);
      w = smoothstep(0.0, max(0.03, fw), w);

      if (uSoftenPx < 2.0) return clamp(w, 0.0, 1.0);

      float pxSoft = uSoftenPx * mix(0.28, 0.48, s);
      vec2 duv = vec2(pxSoft / uOverlayPixelSize.x, pxSoft / uOverlayPixelSize.y);
      w = max(w, maskWeightAt(uv + vec2(duv.x, 0.0)) * 0.90);
      w = max(w, maskWeightAt(uv + vec2(-duv.x, 0.0)) * 0.90);
      w = max(w, maskWeightAt(uv + vec2(0.0, duv.y)) * 0.90);
      w = max(w, maskWeightAt(uv + vec2(0.0, -duv.y)) * 0.90);
      return clamp(w, 0.0, 1.0);
    }

    float sparkEnvelope(vec2 sparkCell, float time) {
      float seed = hash21(sparkCell);

      if (hash21(sparkCell + 91.7) > uFlareDensity) return 0.0;

      float period = mix(0.35, 2.8, seed) / max(0.15, uPulseSpeed);
      float phase = fract(time / period + seed * 13.0);

      float env = sin(phase * 3.14159265);
      env = env * env;

      float micro = sin(time * mix(12.0, 28.0, seed) + seed * 40.0) * 0.5 + 0.5;
      return env * mix(0.65, 1.0, micro);
    }

    float sparkFalloff(vec2 pxPos, vec2 cell, float pxSize) {
      vec2 center = cell * pxSize + pxSize * 0.5;
      vec2 d = pxPos - center;
      float s = softenNorm();
      float coreR = max(1.2, pxSize * mix(0.28, 0.16, s));
      float softR = max(coreR + 2.5, uSoftenPx * mix(0.75, 1.85, s) + pxSize * mix(0.48, 1.2, s));
      float core = exp(-dot(d, d) / (coreR * coreR));
      float halo = exp(-dot(d, d) / (softR * softR));
      float fall = mix(halo, core, mix(0.50, 0.14, s));
      float fw = fwidth(fall) * mix(0.5, uSoftenPx * 0.14, s);
      return smoothstep(0.0, max(0.001, fw + 0.004), fall);
    }

    float sparkAt(vec2 pxPos, vec2 cell, float time, float pxSize) {
      float env = sparkEnvelope(cell, time);
      if (env <= 0.0005) return 0.0;
      return env * sparkFalloff(pxPos, cell, pxSize);
    }

    // 3×3 neighbor blend — enough halo overlap without the 5×5 cost.
    float sparkLayerAggregated(vec2 pxPos, float time, float pxSize, vec2 cellOffset) {
      float px = max(2.0, pxSize);
      vec2 baseCell = floor(pxPos / px);
      float s = softenNorm();
      float sum = sparkAt(pxPos, baseCell + cellOffset, time, px) * 0.34;
      float wSum = 0.34;

      for (int oy = -1; oy <= 1; oy++) {
        for (int ox = -1; ox <= 1; ox++) {
          if (ox != 0 || oy != 0) {
            vec2 off = vec2(float(ox), float(oy));
            float w = mix(0.11, 0.22, s);
            sum += sparkAt(pxPos, baseCell + off + cellOffset, time, px) * w;
            wSum += w;
          }
        }
      }
      return sum / max(0.0001, wSum);
    }

    vec3 sparkFieldAt(vec2 pxPos, float time) {
      float px = max(2.0, uFlarePixelPx);
      vec3 hdr = vec3(0.0);

      float eA = sparkLayerAggregated(pxPos, time, px, vec2(0.0));
      hdr += uColorHot * eA;

      float pxB = max(2.0, px * 0.55);
      float eB = sparkLayerAggregated(pxPos, time + 17.0, pxB, vec2(50.0, 50.0)) * 0.55;
      hdr += uColorWarm * eB;

      float pxC = max(2.0, px * 0.32);
      vec2 driftPos = pxPos;
      driftPos.y -= time * mix(6.0, 22.0, clamp(uFlareChaos, 0.0, 2.0) * 0.5 + 0.15);
      float eC = sparkLayerAggregated(driftPos, time + 31.0, pxC, vec2(113.0, 113.0)) * 0.38;
      hdr += uColorHot * eC;

      return hdr * (uEmissiveGain * 12.0 / 9.0);
    }

    // Gentle highlight knee — stops isolated pixels clipping to flat white.
    vec3 compressHotPixels(vec3 hdr, float amount) {
      float luma = max(dot(hdr, vec3(0.2126, 0.7152, 0.0722)), 0.0001);
      float threshold = mix(6.0, 0.85, amount);
      float knee = smoothstep(threshold * 0.35, threshold * 1.6, luma);
      float compressed = threshold + (luma - threshold) * mix(1.0, 0.28, knee * amount);
      return hdr * (compressed / luma);
    }

    float windBreath(vec2 uv, float time) {
      float windPhase = dot(uv, vec2(1.0, 0.55)) * 5.0 - time * mix(0.7, 2.0, uEvolveSpeed);
      windPhase += sin(uv.y * 9.0 + time * 0.35) * mix(0.2, 0.55, uTurbulence);
      float breath = sin(windPhase) * 0.5 + 0.5;
      breath = mix(0.40, 1.0, breath);
      return breath;
    }

    vec3 tonemapEmissive(vec3 hdr) {
      vec3 aces = clamp((hdr * (2.51 * hdr + 0.03)) / (hdr * (2.43 * hdr + 0.59) + 0.14), 0.0, 64.0);
      return mix(hdr, aces, 0.32);
    }

    void main() {
      if (uEffectEnabled < 0.5 || uCoalBedEnabled < 0.5) discard;

      float soften = softenNorm();
      vec2 pxPos = vUv * uOverlayPixelSize;
      float roughHeat = smolderHeatBlurred(pxPos, uTime);

      vec2 viewDir = vec2(0.0, 1.0);
      float parallaxAmt = uParallaxDepth * 0.028;
      vec2 depthUV = vUv + viewDir * (1.0 - normalizeBedHeat(roughHeat)) * parallaxAmt;

      float maskW = maskBorderFeather(depthUV);
      if (maskW <= 0.0005) discard;

      float intensity = max(0.0, uIntensity);
      float opacity = clamp(uOpacity, 0.0, 1.0);

      vec3 diffuse = paletteSoft(normalizeBedHeat(roughHeat));
      diffuse *= intensity;

      vec3 emissive = sparkFieldAt(pxPos, uTime);
      emissive *= windBreath(vUv, uTime);
      emissive = compressHotPixels(emissive, soften);
      emissive = tonemapEmissive(emissive);
      emissive *= intensity * pow(max(opacity, 0.001), 0.35);

      float luma = dot(diffuse, vec3(0.2126, 0.7152, 0.0722));
      diffuse = mix(vec3(luma), diffuse, uSaturation);
      if (uContrast > 1.001) {
        diffuse = mix(vec3(luma), diffuse, uContrast);
      }
      diffuse = max(diffuse, uColorChar * 0.35 * intensity);

      float edgeAlpha = opacity * maskW;
      vec3 outRgb = diffuse * edgeAlpha + emissive * maskW;
      gl_FragColor = vec4(outRgb, edgeAlpha);
    }
  `;
}

/**
 * @param {typeof import('three')} THREE
 * @param {Record<string, unknown>} params
 */
export function createCoalBedUniforms(THREE, params = {}) {
  const p = { ...COAL_BED_DEFAULT_PARAMS, ...params };
  const [bandChar, bandHot, bandWarm, bandAshWarm] = normalizeCoalBedBands(p);

  return {
    uFireMask: { value: null },
    uMaskTexelSize: { value: new THREE.Vector2(1.0 / 512.0, 1.0 / 512.0) },
    uOverlayPixelSize: { value: new THREE.Vector2(512.0, 512.0) },
    uTime: { value: 0.0 },
    uEffectEnabled: { value: 1.0 },
    uCoalBedEnabled: { value: p.coalBedEnabled !== false ? 1.0 : 0.0 },

    uIntensity: { value: Number(p.coalBedIntensity) || 1.0 },
    uOpacity: { value: Number(p.coalBedOpacity) || 1.0 },

    uMaskLo: { value: clamp01(Number(p.coalBedMaskLo) ?? 0.35) },
    uMaskExpand: { value: Math.max(0, Number(p.coalBedMaskExpand) ?? 2.0) },
    uMaskDither: { value: Math.max(0, Number(p.coalBedMaskDither) ?? 0.22) },

    uSmolderBlockPx: { value: Math.max(8, Number(p.coalBedChunkScale) || 36) },
    uChunkContrast: { value: Number(p.coalBedChunkContrast) || 2.0 },
    uChunkAspect: { value: Math.max(0.25, Number(p.coalBedChunkAspect) || 1.0) },
    uFlarePixelPx: { value: Math.max(2, Number(p.coalBedGrainScale) || 5) },
    uGrainAngle: { value: Number(p.coalBedGrainAngle) || 0.0 },

    uColorChar: { value: new THREE.Color(String(p.coalBedColorChar ?? '#1a100c')) },
    uColorHot: { value: new THREE.Color(String(p.coalBedColorHot ?? '#ffe066')) },
    uColorWarm: { value: new THREE.Color(String(p.coalBedColorWarm ?? '#ff4400')) },
    uColorAshWarm: { value: new THREE.Color(String(p.coalBedColorAshWarm ?? '#aa5030')) },
    uColorAshCool: { value: new THREE.Color(String(p.coalBedColorAshCool ?? '#524840')) },

    uBandCharEnd: { value: bandChar },
    uBandHotEnd: { value: bandHot },
    uBandWarmEnd: { value: bandWarm },
    uBandAshWarmEnd: { value: bandAshWarm },
    uBandSoftness: { value: Math.max(0.02, (Number(p.coalBedEdgeSoftness) || 12) * 0.004) },

    uSaturation: { value: Number(p.coalBedSaturation) || 1.0 },
    uContrast: { value: Number(p.coalBedContrast) || 1.0 },
    uEmissiveGain: { value: Number(p.coalBedEmissiveGain) || 1.0 },

    uEvolveSpeed: { value: Number(p.coalBedEvolveSpeed) || 0.45 },
    uPulseSpeed: { value: Number(p.coalBedPulseSpeed) || 1.8 },
    uHeatLevels: { value: Number(p.coalBedHeatLevels) || 6.0 },
    uFlareDensity: { value: clamp01(Number(p.coalBedFlareDensity) ?? 0.93) },
    uSoftenPx: { value: Math.max(0, Number(p.coalBedEdgeSoftness) ?? 2.5) },
    uTurbulence: { value: Math.max(0, Number(p.coalBedTurbulence) ?? 0) },
    uParallaxDepth: { value: clamp01(Number(p.coalBedRimStrength) ?? 0) },
    uFlareChaos: { value: Math.max(0, Number(p.coalBedFlareChaos) ?? 0) },
  };
}

/**
 * @param {import('three').ShaderMaterial} material
 * @param {Record<string, unknown>} params
 * @param {{ effectEnabled?: boolean }} [opts]
 */
export function syncCoalBedUniforms(material, params = {}, opts = {}) {
  const u = material?.uniforms;
  if (!u) return;
  const p = params;

  if (typeof opts.effectEnabled === 'boolean') {
    u.uEffectEnabled.value = opts.effectEnabled ? 1.0 : 0.0;
  }
  u.uCoalBedEnabled.value = p.coalBedEnabled !== false ? 1.0 : 0.0;
  u.uIntensity.value = Math.max(0, Number(p.coalBedIntensity) || 0);
  u.uOpacity.value = clamp01(Number(p.coalBedOpacity) ?? 1.0);

  u.uMaskLo.value = clamp01(Number(p.coalBedMaskLo) ?? 0.35);
  u.uMaskExpand.value = Math.max(0, Number(p.coalBedMaskExpand) ?? 2.0);
  u.uMaskDither.value = Math.max(0, Number(p.coalBedMaskDither) ?? 0.22);

  u.uSmolderBlockPx.value = Math.max(8, Number(p.coalBedChunkScale) || 36);
  u.uChunkContrast.value = Number(p.coalBedChunkContrast) || 2.0;
  u.uChunkAspect.value = Math.max(0.25, Number(p.coalBedChunkAspect) || 1.0);
  u.uFlarePixelPx.value = Math.max(2, Number(p.coalBedGrainScale) || 5);
  u.uGrainAngle.value = Number(p.coalBedGrainAngle) || 0.0;

  applyColorUniform(u.uColorChar, p.coalBedColorChar, '#1a100c');
  applyColorUniform(u.uColorHot, p.coalBedColorHot, '#ffe066');
  applyColorUniform(u.uColorWarm, p.coalBedColorWarm, '#ff4400');
  applyColorUniform(u.uColorAshWarm, p.coalBedColorAshWarm, '#aa5030');
  applyColorUniform(u.uColorAshCool, p.coalBedColorAshCool, '#524840');

  const [bandChar, bandHot, bandWarm, bandAshWarm] = normalizeCoalBedBands(p);
  u.uBandCharEnd.value = bandChar;
  u.uBandHotEnd.value = bandHot;
  u.uBandWarmEnd.value = bandWarm;
  u.uBandAshWarmEnd.value = bandAshWarm;
  if (u.uBandSoftness) {
    u.uBandSoftness.value = Math.max(0.02, (Number(p.coalBedEdgeSoftness) || 12) * 0.004);
  }

  u.uSaturation.value = Number(p.coalBedSaturation) || 1.0;
  u.uContrast.value = Number(p.coalBedContrast) || 1.0;
  u.uEmissiveGain.value = Number(p.coalBedEmissiveGain) || 1.0;

  u.uEvolveSpeed.value = Number(p.coalBedEvolveSpeed) || 0.45;
  u.uPulseSpeed.value = Number(p.coalBedPulseSpeed) || 1.8;
  u.uHeatLevels.value = Number(p.coalBedHeatLevels) || 6.0;
  u.uFlareDensity.value = clamp01(Number(p.coalBedFlareDensity) ?? 0.93);
  u.uSoftenPx.value = Math.max(0, Number(p.coalBedEdgeSoftness) ?? 2.5);
  u.uTurbulence.value = Math.max(0, Number(p.coalBedTurbulence) ?? 0);
  u.uParallaxDepth.value = clamp01(Number(p.coalBedRimStrength) ?? 0);
  u.uFlareChaos.value = Math.max(0, Number(p.coalBedFlareChaos) ?? 0);
}

/**
 * @param {import('three').ShaderMaterial} material
 * @param {number} width
 * @param {number} height
 */
export function syncCoalBedMaskTexelSize(material, width, height) {
  const u = material?.uniforms?.uMaskTexelSize?.value;
  if (!u) return;
  u.set(1.0 / Math.max(1, width), 1.0 / Math.max(1, height));
}

/**
 * @param {import('three').ShaderMaterial} material
 * @param {number} tileW
 * @param {number} tileH
 */
export function syncCoalBedOverlayPixelSize(material, tileW, tileH) {
  const u = material?.uniforms?.uOverlayPixelSize?.value;
  if (!u) return;
  u.set(Math.max(1, tileW), Math.max(1, tileH));
}

/**
 * @param {typeof import('three')} THREE
 * @param {Record<string, unknown>} params
 */
export function createCoalBedMaterial(THREE, params = {}) {
  const uniforms = createCoalBedUniforms(THREE, params);
  const material = new THREE.ShaderMaterial({
    name: 'FireCoalBedV2',
    uniforms,
    vertexShader: getCoalBedVertexShader(),
    fragmentShader: getCoalBedFragmentShader(),
    side: THREE.DoubleSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    extensions: { derivatives: true },
  });
  applyCoalBedBlending(material, THREE);
  return material;
}

/**
 * HDR-friendly blend: diffuse respects opacity; emissive rgb adds at full linear strength.
 * @param {import('three').ShaderMaterial} material
 * @param {typeof import('three')} THREE
 */
export function applyCoalBedBlending(material, THREE) {
  if (!material || !THREE) return;
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneMinusSrcAlphaFactor;
  material.blendEquation = THREE.AddEquation;
  material.toneMapped = false;
}
