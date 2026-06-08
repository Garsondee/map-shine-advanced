/**
 * @fileoverview Load-time clump labeling + world XY bake for vegetation wind waves.
 * @module compositor-v2/effects/vegetation-clump-field
 */

import { applyVegetationWindAnchorToOverlay } from './vegetation-bulk-wind.js';

/** @type {import('three').DataTexture|null} */
let _fallbackClumpTex = null;

export const VEGETATION_CLUMP_FIELD_DEFAULTS = {
  clumpWaveEnabled: true,
  clumpWaveMix: 1.0,
  /** @type {number} 0=off — see {@link CLUMP_ID_DEBUG_MODE}. */
  clumpIdDebug: 0,
};

/** Clump ID debug view modes (uClumpIdDebug uniform). */
export const CLUMP_ID_DEBUG_MODE = Object.freeze({
  off: 0,
  bakedIslandId: 1,
  windShaderId: 2,
  mapVsShader: 3,
  unlabeledFoliage: 4,
  windUvSplit: 5,
});

/** Dropdown options for Tree/Bush Tweakpane (label → mode value). */
export const CLUMP_ID_DEBUG_DROPDOWN_OPTIONS = Object.freeze({
  Off: CLUMP_ID_DEBUG_MODE.off,
  'Baked island ID': CLUMP_ID_DEBUG_MODE.bakedIslandId,
  'Wind shader ID': CLUMP_ID_DEBUG_MODE.windShaderId,
  'Map vs shader': CLUMP_ID_DEBUG_MODE.mapVsShader,
  'Unlabeled foliage': CLUMP_ID_DEBUG_MODE.unlabeledFoliage,
  'Wind UV split': CLUMP_ID_DEBUG_MODE.windUvSplit,
});

/** Grid segments for wind-displaced overlay meshes (vertex clump sampling). */
export function windDisplacedMeshSegments(tileW, tileH, maskW = 0, maskH = 0, islandCount = 1) {
  if (Number(islandCount) <= 1) return 1;
  const texDim = Math.max(Number(maskW) || 0, Number(maskH) || 0);
  const worldDim = Math.max(Math.abs(Number(tileW)) || 1, Math.abs(Number(tileH)) || 1);
  const driver = texDim > 0 ? texDim : worldDim;
  return Math.max(8, Math.min(16, Math.round(driver / 128)));
}

/** GLSL uniform declarations (inject into vegetation fragment shaders). */
export const VEGETATION_CLUMP_FIELD_UNIFORM_GLSL = `
        uniform sampler2D tClumpCoordMap;
        uniform vec2  uClumpCoordMapSize;
        uniform float uHasClumpCoordMap;
        uniform float uClumpWaveEnabled;
        uniform float uClumpWaveMix;
        uniform float uClumpIdDebug;
`;

/** clump.b = island id 0..1 baked at load time. */
export const VEGETATION_CLUMP_ID_GLSL = `
        float clumpId01(float rawId) {
          return fract(rawId + 1e-4);
        }

        float clumpPhaseSeed(float rawId) {
          return clumpId01(rawId) * 6.2831853;
        }
`;

/** Per-vertex clump data baked from CPU (float clump textures are unreliable in vertex shaders). */
export const VEGETATION_CLUMP_WIND_ATTRIBUTE_GLSL = `
        attribute vec2 aClumpAnchor;
        attribute float aClumpId;
        attribute float aFoliageCover;
`;

/** Fragment clump sample — centroid anchor + island id; 3×3 search keeps fringe on island. */
export const VEGETATION_CLUMP_FIELD_SAMPLE_GLSL = `
        vec3 sampleClumpFieldAtTexel(vec2 texelUv) {
          vec4 clump = texture2D(tClumpCoordMap, texelUv);
          if (clump.a < 0.01) return vec3(0.0);
          float unity = clamp(uClumpWaveMix, 0.0, 1.0);
          return vec3(clump.xy, clump.b);
        }

        vec3 sampleClumpField(vec2 uv, vec2 worldPos) {
          if (uClumpWaveEnabled < 0.5 || uHasClumpCoordMap < 0.5) return vec3(worldPos, 0.0);
          vec2 mapSize = max(uClumpCoordMapSize, vec2(1.0));
          vec2 base = floor(uv * mapSize);
          vec3 best = vec3(0.0);
          float bestScore = -1.0;
          for (int oy = -1; oy <= 1; oy++) {
            for (int ox = -1; ox <= 1; ox++) {
              vec2 t = (base + vec2(float(ox), float(oy)) + 0.5) / mapSize;
              t = clamp(t, vec2(0.0), vec2(1.0));
              vec3 cand = sampleClumpFieldAtTexel(t);
              if (cand.z <= 0.0) continue;
              float score = 1.0 - length(vec2(float(ox), float(oy))) * 0.08;
              if (score > bestScore) {
                bestScore = score;
                best = cand;
              }
            }
          }
          if (bestScore < 0.0) return vec3(worldPos, 0.0);
          float unity = clamp(uClumpWaveMix, 0.0, 1.0);
          vec2 anchor = mix(worldPos, best.xy, unity);
          return vec3(anchor, best.z);
        }
`;

/** Unified world anchor — all wind/flutter noise uses this so clumps move as rigid units. */
export const VEGETATION_CLUMP_MOTION_ANCHOR_GLSL = `
        vec2 vegetationMotionPos(vec3 clumpField, vec2 worldPos) {
          return clumpField.xy;
        }
`;

/** False-color clump diagnostics — inject after clump sample GLSL. */
export const VEGETATION_CLUMP_DEBUG_GLSL = `
        vec3 vegetationClumpDebugHsv2rgb(vec3 c) {
          vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
          vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
          return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
        }

        vec4 vegetationSampleClumpTexelRaw(vec2 uv) {
          if (uHasClumpCoordMap < 0.5) return vec4(0.0);
          vec2 mapSize = max(uClumpCoordMapSize, vec2(1.0));
          vec2 texelUv = (floor(uv * mapSize) + 0.5) / mapSize;
          return texture2D(tClumpCoordMap, texelUv);
        }

        vec3 vegetationClumpIdToColor(float id01) {
          float id = clumpId01(id01);
          return vegetationClumpDebugHsv2rgb(vec3(id, 0.88, 0.95));
        }

        bool vegetationClumpDebugActive() {
          return uClumpIdDebug > 0.5;
        }

        // Returns vec4(rgb, alpha). Alpha < 0.0 means inactive; alpha == 0.0 means discard.
        vec4 vegetationClumpDebugOutput(vec2 uv, vec2 worldPos, float foliageAlpha) {
          if (!vegetationClumpDebugActive() || uClumpIdDebug > 4.5) {
            return vec4(-1.0);
          }
          if (foliageAlpha < 0.02) {
            return vec4(0.0);
          }

          vec4 raw = vegetationSampleClumpTexelRaw(uv);
          vec3 windField = sampleClumpField(uv, worldPos);
          float rawId = clumpId01(raw.b);
          float windId = clumpId01(windField.z);

          if (uClumpIdDebug < 1.5) {
            if (raw.a < 0.01) return vec4(1.0, 0.0, 1.0, foliageAlpha);
            return vec4(vegetationClumpIdToColor(rawId), foliageAlpha);
          }
          if (uClumpIdDebug < 2.5) {
            if (uHasClumpCoordMap < 0.5) return vec4(1.0, 0.0, 1.0, foliageAlpha);
            if (windField.z < 1e-4 && raw.a > 0.01) return vec4(1.0, 0.45, 0.0, foliageAlpha);
            if (windField.z < 1e-4) return vec4(0.12, 0.12, 0.16, foliageAlpha);
            return vec4(vegetationClumpIdToColor(windId), foliageAlpha);
          }
          if (uClumpIdDebug < 3.5) {
            if (raw.a < 0.01) return vec4(0.35, 0.35, 0.4, foliageAlpha);
            float delta = abs(rawId - windId);
            vec3 rgb = (delta > 0.02) ? vec3(1.0, 0.12, 0.12) : vec3(0.12, 0.92, 0.22);
            return vec4(rgb, foliageAlpha);
          }
          if (raw.a < 0.01) return vec4(1.0, 0.0, 1.0, foliageAlpha);
          return vec4(vegetationClumpIdToColor(rawId), foliageAlpha);
        }

        vec4 vegetationClumpWindUvSplitOutput(vec2 restUv, vec2 windUv, vec2 worldPos, float foliageAlpha) {
          if (uClumpIdDebug < 4.5 || uClumpIdDebug > 5.5) return vec4(-1.0);
          if (foliageAlpha < 0.02) return vec4(0.0);
          vec3 atRest = sampleClumpField(restUv, worldPos);
          vec3 atWind = sampleClumpField(windUv, worldPos);
          float restId = clumpId01(atRest.z);
          float windId = clumpId01(atWind.z);
          vec3 rgb = (abs(restId - windId) > 0.02)
            ? vec3(1.0, 0.1, 0.1)
            : vec3(0.12, 0.9, 0.2);
          return vec4(rgb, foliageAlpha);
        }
`;

/** Tweakpane folder for Tree/Bush — append to `groups`. */
export const VEGETATION_CLUMP_DEBUG_SCHEMA_GROUP = {
  name: 'clumpDebug',
  label: 'Clump debug',
  type: 'folder',
  advanced: true,
  expanded: true,
  parameters: ['clumpIdDebug'],
};

/**
 * @param {typeof import('three')} THREE
 * @returns {import('three').DataTexture}
 */
function ensureFallbackClumpTexture(THREE) {
  if (_fallbackClumpTex) return _fallbackClumpTex;
  const data = new Float32Array([0, 0, 0, 0]);
  _fallbackClumpTex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.FloatType);
  _fallbackClumpTex.needsUpdate = true;
  return _fallbackClumpTex;
}

/**
 * Shared wave toggles (same object ref across overlays on one effect).
 * @param {object} [params]
 * @returns {Record<string, { value: unknown }>}
 */
export function createVegetationClumpFieldSharedUniforms(params = {}) {
  const p = { ...VEGETATION_CLUMP_FIELD_DEFAULTS, ...params };
  return {
    uClumpWaveEnabled: { value: p.clumpWaveEnabled !== false ? 1.0 : 0.0 },
    uClumpWaveMix: { value: Number(p.clumpWaveMix ?? 1.0) },
    uClumpIdDebug: { value: Number(p.clumpIdDebug) || 0.0 },
  };
}

/**
 * Per-overlay clump coord map (one texture per tile/background).
 * @param {typeof import('three')} [THREE]
 * @returns {Record<string, { value: unknown }>}
 */
export function createVegetationClumpFieldOverlayUniforms(THREE = window.THREE) {
  return {
    tClumpCoordMap: { value: THREE ? ensureFallbackClumpTexture(THREE) : null },
    uClumpCoordMapSize: { value: THREE ? new THREE.Vector2(1, 1) : { x: 1, y: 1 } },
    uHasClumpCoordMap: { value: 0.0 },
  };
}

/** @deprecated Use shared + overlay helpers */
export function createVegetationClumpFieldUniforms(THREE, params = {}) {
  return {
    ...createVegetationClumpFieldSharedUniforms(params),
    ...createVegetationClumpFieldOverlayUniforms(THREE),
  };
}

/**
 * @param {Record<string, { value: unknown }>|null|undefined} uniforms
 * @param {object} params
 */
export function applyVegetationClumpFieldParamsToUniforms(uniforms, params = {}) {
  if (!uniforms) return;
  const p = { ...VEGETATION_CLUMP_FIELD_DEFAULTS, ...params };
  if (uniforms.uClumpWaveEnabled) {
    uniforms.uClumpWaveEnabled.value = p.clumpWaveEnabled !== false ? 1.0 : 0.0;
  }
  if (uniforms.uClumpWaveMix) {
    uniforms.uClumpWaveMix.value = Math.max(0.0, Math.min(1.0, Number(p.clumpWaveMix ?? 1.0)));
  }
  if (uniforms.uClumpIdDebug) {
    uniforms.uClumpIdDebug.value = Math.max(0.0, Number(p.clumpIdDebug) || 0.0);
  }
}

/**
 * @param {import('three').Texture|null|undefined} tex
 */
export function disposeClumpCoordTexture(tex) {
  if (!tex || tex === _fallbackClumpTex) return;
  try { tex.dispose?.(); } catch (_) {}
}

/** Control schema fragment for BushEffectV2 / TreeEffectV2. */
export const VEGETATION_CLUMP_FIELD_CONTROL_SCHEMA = {
  clumpWaveEnabled: {
    type: 'boolean',
    label: 'Clump waves',
    default: true,
    hidden: true,
    tooltip: 'Moved to Scene Wind → Clump wave field.',
  },
  clumpWaveMix: {
    type: 'slider',
    label: 'Clump unity',
    min: 0.0,
    max: 1.0,
    step: 0.01,
    default: 1.0,
    advanced: true,
    hidden: true,
    tooltip: 'Moved to Scene Wind → Clump wave mix.',
  },
  clumpIdDebug: {
    type: 'dropdown',
    label: 'Clump ID view',
    default: CLUMP_ID_DEBUG_MODE.off,
    advanced: true,
    tooltip: [
      'False-color foliage clump labels (wind frozen except Wind UV split).',
      'Baked island ID = load-time map;',
      'Wind shader ID = sampleClumpField;',
      'Map vs shader = red when they disagree;',
      'Unlabeled foliage = magenta pixels with mask alpha but no clump label;',
      'Wind UV split = red when wind distortion samples a different island ID.',
    ].join(' '),
    options: { ...CLUMP_ID_DEBUG_DROPDOWN_OPTIONS },
  },
};

/** Core mask for island centroids (solid canopy interior). */
const ALPHA_CORE_THRESHOLD = 0.09;
/** Foliage includes antialiased fringe but not bare ground speckle. */
const ALPHA_LINK_THRESHOLD = 0.018;
/** Erosion passes on core before CC — breaks 1–2 px outline bridges between trees. */
const CORE_ERODE_PASSES = 2;
/** Use full-res nearest-core labeling up to this many pixels. */
const FULL_RES_PIXEL_LIMIT = 4_000_000;
/** Max mask dimension for clump coord bake (wind waves are low-frequency). */
const CLUMP_BAKE_MAX_DIM = 1024;
const MAX_LABEL_EDGE = 4096;

/**
 * Match shader safeAlpha / Tree CPU sampling for derived-alpha masks.
 * @param {Uint8ClampedArray} data
 * @param {number} idx Byte index (multiple of 4)
 * @param {boolean} deriveAlpha
 * @returns {number} 0..1
 */
function sampleEffectiveAlpha(data, idx, deriveAlpha) {
  const r = data[idx] ?? 0;
  const g = data[idx + 1] ?? 0;
  const b = data[idx + 2] ?? 0;
  let a = (data[idx + 3] ?? 0) / 255.0;
  if (deriveAlpha && a > 0.99) {
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
    const maxC = Math.max(r, g, b) / 255.0;
    const minC = Math.min(r, g, b) / 255.0;
    const chroma = maxC - minC;
    const isBright = lum >= 0.85 ? 1.0 : 0.0;
    const isDesat = chroma < 0.06 ? 1.0 : 0.0;
    const bg = isBright * isDesat;
    a *= (1.0 - bg);
  }
  return a;
}

/**
 * @param {number} n
 * @returns {number}
 */
function hashIslandSeed(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Union-find with path compression.
 */
class UnionFind {
  /** @param {number} size */
  constructor(size) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i += 1) this.parent[i] = i;
  }

  /** @param {number} x */
  find(x) {
    let p = this.parent[x];
    while (p !== this.parent[p]) {
      this.parent[p] = this.parent[this.parent[p]];
      p = this.parent[p];
    }
    return p;
  }

  /** @param {number} a @param {number} b */
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

/**
 * Convert mask pixel centroid to overlay world XY (Three space, Y-up).
 * @param {number} cxPx Centroid X in pixel space (0 = left)
 * @param {number} cyPx Centroid Y in pixel space (0 = top, image space)
 * @param {number} width
 * @param {number} height
 * @param {{ centerX: number, centerY: number, tileW: number, tileH: number, rotationRad: number }} placement
 * @returns {{ x: number, y: number }}
 */
function pixelCentroidToWorld(cxPx, cyPx, width, height, placement) {
  const u = cxPx / Math.max(1, width);
  const v = 1.0 - (cyPx / Math.max(1, height));
  const tileW = Number(placement.tileW) || 1;
  const tileH = Number(placement.tileH) || 1;
  const lx = (u - 0.5) * tileW;
  const ly = (v - 0.5) * tileH;
  const rot = Number(placement.rotationRad) || 0;
  const cosR = Math.cos(rot);
  const sinR = Math.sin(rot);
  const wx = Number(placement.centerX) + (lx * cosR - ly * sinR);
  const wy = Number(placement.centerY) + (lx * sinR + ly * cosR);
  return { x: wx, y: wy };
}

/**
 * Max alpha in a source block (bridges thin gaps when downscaling for labels).
 * @param {Uint8ClampedArray} srcData
 * @param {number} srcW
 * @param {number} srcH
 * @param {boolean} deriveAlpha
 * @param {number} cx
 * @param {number} cy
 * @param {number} scale
 * @param {number} half
 * @returns {number}
 */
function maxAlphaInLabelBlock(srcData, srcW, srcH, deriveAlpha, cx, cy, scale, half) {
  let maxA = 0;
  const baseSx = Math.min(srcW - 1, Math.floor((cx + 0.5) * scale));
  const baseSy = Math.min(srcH - 1, Math.floor((cy + 0.5) * scale));
  for (let dy = -half; dy <= half; dy += 1) {
    for (let dx = -half; dx <= half; dx += 1) {
      const sx = Math.max(0, Math.min(srcW - 1, baseSx + dx));
      const sy = Math.max(0, Math.min(srcH - 1, baseSy + dy));
      const a = sampleEffectiveAlpha(srcData, (sy * srcW + sx) * 4, deriveAlpha);
      if (a > maxA) maxA = a;
    }
  }
  return maxA;
}

/**
 * @param {Uint8ClampedArray} data
 * @param {number} w
 * @param {number} h
 * @param {boolean} deriveAlpha
 * @returns {{ foliage: Uint8Array, core: Uint8Array }}
 */
function buildFoliageMasks(data, w, h, deriveAlpha) {
  const n = w * h;
  const foliage = new Uint8Array(n);
  const core = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const a = sampleEffectiveAlpha(data, i * 4, deriveAlpha);
    foliage[i] = a > ALPHA_LINK_THRESHOLD ? 1 : 0;
    core[i] = a > ALPHA_CORE_THRESHOLD ? 1 : 0;
  }
  return { foliage, core };
}

/**
 * @param {Uint8Array} expanded
 * @param {number} w
 * @param {number} h
 * @returns {{ labels: Int32Array }}
 */
function unionFindExpandedMask(expanded, w, h) {
  const n = w * h;
  const labels = new Int32Array(n);
  labels.fill(-1);
  const uf = new UnionFind(n);
  let nextId = 0;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (!expanded[i]) continue;
      const left = (x > 0 && expanded[i - 1]) ? labels[i - 1] : -1;
      const up = (y > 0 && expanded[i - w]) ? labels[i - w] : -1;
      if (left >= 0 && up >= 0) {
        uf.union(left, up);
        labels[i] = uf.find(left);
      } else if (left >= 0) {
        labels[i] = uf.find(left);
      } else if (up >= 0) {
        labels[i] = uf.find(up);
      } else {
        labels[i] = nextId;
        nextId += 1;
      }
    }
  }

  for (let i = 0; i < n; i += 1) {
    if (labels[i] >= 0) labels[i] = uf.find(labels[i]);
  }

  return { labels };
}

/**
 * Label solid canopy cores only (8-connected). Separate trees stay separate unless cores touch.
 * @param {Uint8Array} core
 * @param {number} w
 * @param {number} h
 * @returns {Int32Array}
 */
function labelCoreComponents(core, w, h) {
  const { labels } = unionFindExpandedMask(core, w, h);
  return labels;
}

const FLOOD_NEIGHBORS_8 = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
];

/**
 * Erode a binary mask — removes pixels touching background (breaks thin bridges).
 * @param {Uint8Array} mask
 * @param {number} w
 * @param {number} h
 * @returns {Uint8Array}
 */
function erodeBinaryMask(mask, w, h) {
  const n = w * h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    let keep = true;
    for (const [dx, dy] of FLOOD_NEIGHBORS_8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) {
        keep = false;
        break;
      }
    }
    out[i] = keep ? 1 : 0;
  }
  return out;
}

/**
 * Assign foliage only along connected foliage paths from solid cores (8-connected BFS).
 * Empty gaps between trees block propagation — no Euclidean leap across void.
 * @param {Uint8Array} foliage
 * @param {Uint8Array} core
 * @param {Int32Array} coreLabels
 * @param {number} w
 * @param {number} h
 * @returns {Int32Array}
 */
function assignFoliageByCoreFlood(foliage, core, coreLabels, w, h) {
  const n = w * h;
  const pixelRoot = new Int32Array(n);
  pixelRoot.fill(-1);
  const queue = [];

  for (let i = 0; i < n; i += 1) {
    if (!core[i] || coreLabels[i] < 0) continue;
    pixelRoot[i] = coreLabels[i];
    queue.push(i);
  }

  let head = 0;
  while (head < queue.length) {
    const i = queue[head];
    head += 1;
    const root = pixelRoot[i];
    const x = i % w;
    const y = (i / w) | 0;
    for (const [dx, dy] of FLOOD_NEIGHBORS_8) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!foliage[ni] || pixelRoot[ni] >= 0) continue;
      pixelRoot[ni] = root;
      queue.push(ni);
    }
  }

  return pixelRoot;
}

/**
 * @param {Uint8Array} foliage
 * @param {Int32Array} pixelRoot
 * @param {number} w
 * @param {number} h
 * @param {number} srcW
 * @param {number} srcH
 * @param {{ centerX: number, centerY: number, tileW: number, tileH: number, rotationRad: number }} placement
 * @returns {Map<number, { wx: number, wy: number, seed: number }>}
 */
function buildCentroidByRoot(foliage, pixelRoot, w, h, srcW, srcH, placement) {
  /** @type {Map<number, { sumX: number, sumY: number, count: number, seed: number }>} */
  const components = new Map();
  const n = w * h;
  for (let i = 0; i < n; i += 1) {
    if (!foliage[i]) continue;
    const root = pixelRoot[i];
    if (root < 0) continue;
    const x = i % w;
    const y = (i / w) | 0;
    let entry = components.get(root);
    if (!entry) {
      entry = { sumX: 0, sumY: 0, count: 0, seed: hashIslandSeed(root) };
      components.set(root, entry);
    }
    entry.sumX += x + 0.5;
    entry.sumY += y + 0.5;
    entry.count += 1;
  }

  /** @type {Map<number, { wx: number, wy: number, seed: number, count: number }>} */
  const centroidByRoot = new Map();
  for (const [root, c] of components) {
    const cxPx = c.sumX / c.count;
    const cyPx = c.sumY / c.count;
    const world = pixelCentroidToWorld(cxPx, cyPx, srcW, srcH, placement);
    centroidByRoot.set(root, { wx: world.x, wy: world.y, seed: c.seed, count: c.count });
  }
  return centroidByRoot;
}

/**
 * Downscaled solid-core labels for very large masks.
 * @param {Uint8ClampedArray} srcData
 * @param {number} srcW
 * @param {number} srcH
 * @param {boolean} deriveAlpha
 * @param {number} labelW
 * @param {number} labelH
 * @returns {{ core: Uint8Array, labels: Int32Array, scale: number }}
 */
function buildLabelGrid(srcData, srcW, srcH, deriveAlpha, labelW, labelH) {
  const scale = Math.max(srcW / labelW, srcH / labelH);
  const poolHalf = scale >= 1.75 ? 2 : 1;
  const core = new Uint8Array(labelW * labelH);
  for (let y = 0; y < labelH; y += 1) {
    for (let x = 0; x < labelW; x += 1) {
      const maxA = maxAlphaInLabelBlock(srcData, srcW, srcH, deriveAlpha, x, y, scale, poolHalf);
      core[y * labelW + x] = maxA > ALPHA_CORE_THRESHOLD ? 1 : 0;
    }
  }

  let coreForLabel = core;
  for (let pass = 0; pass < CORE_ERODE_PASSES; pass += 1) {
    coreForLabel = erodeBinaryMask(coreForLabel, labelW, labelH);
  }
  const labels = labelCoreComponents(coreForLabel, labelW, labelH);
  return { core, labels, scale };
}

/**
 * Seed full-res core pixels from a low-res label grid, then nearest-core DT on foliage.
 * @param {Uint8Array} foliage
 * @param {Uint8Array} core
 * @param {Int32Array} labelsLow
 * @param {number} labelW
 * @param {number} labelH
 * @param {number} outW
 * @param {number} outH
 * @param {number} maxFringePx
 * @returns {Int32Array}
 */
function assignFoliageFromLowResCoreLabels(foliage, core, labelsLow, labelW, labelH, outW, outH) {
  const coreLabels = new Int32Array(outW * outH);
  coreLabels.fill(-1);
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const i = y * outW + x;
      if (!core[i]) continue;
      const lx = Math.min(labelW - 1, Math.floor((x / outW) * labelW));
      const ly = Math.min(labelH - 1, Math.floor((y / outH) * labelH));
      const li = ly * labelW + lx;
      if (labelsLow[li] >= 0) coreLabels[i] = labelsLow[li];
    }
  }
  return assignFoliageByCoreFlood(foliage, core, coreLabels, outW, outH);
}

/**
 * @param {object} opts
 * @param {Uint8ClampedArray} opts.data
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {boolean} opts.deriveAlpha
 * @param {{ centerX: number, centerY: number, tileW: number, tileH: number, rotationRad: number }} opts.placement
 * @returns {{ texture: import('three').DataTexture, islandCount: number, primaryAnchor: { wx: number, wy: number, seed: number }|null }|null}
 */
export function buildClumpCoordTextureFromImageData(opts) {
  const THREE = window.THREE;
  if (!THREE) return null;

  const {
    data,
    width: srcW,
    height: srcH,
    deriveAlpha = false,
    placement,
  } = opts;

  if (!data || !(srcW > 0) || !(srcH > 0) || !placement) return null;

  const outW = srcW;
  const outH = srcH;
  const pixelCount = outW * outH;
  const { foliage, core } = buildFoliageMasks(data, outW, outH, deriveAlpha);
  let hasFoliage = false;
  for (let i = 0; i < pixelCount; i += 1) {
    if (foliage[i]) { hasFoliage = true; break; }
  }
  if (!hasFoliage) return null;

  let coreForLabel = core;
  for (let pass = 0; pass < CORE_ERODE_PASSES; pass += 1) {
    coreForLabel = erodeBinaryMask(coreForLabel, outW, outH);
  }

  let pixelRoot;
  if (pixelCount <= FULL_RES_PIXEL_LIMIT) {
    const coreLabels = labelCoreComponents(coreForLabel, outW, outH);
    pixelRoot = assignFoliageByCoreFlood(foliage, coreForLabel, coreLabels, outW, outH);
  } else {
    const labelScale = Math.max(2, Math.ceil(Math.sqrt(pixelCount / FULL_RES_PIXEL_LIMIT)));
    const labelW = Math.max(1, Math.ceil(outW / labelScale));
    const labelH = Math.max(1, Math.ceil(outH / labelScale));
    const { labels } = buildLabelGrid(data, outW, outH, deriveAlpha, labelW, labelH);
    pixelRoot = assignFoliageFromLowResCoreLabels(
      foliage, coreForLabel, labels, labelW, labelH, outW, outH,
    );
  }

  const centroidByRoot = buildCentroidByRoot(foliage, pixelRoot, outW, outH, outW, outH, placement);
  if (centroidByRoot.size === 0) return null;

  let primaryAnchor = null;
  let primaryCount = 0;
  for (const cent of centroidByRoot.values()) {
    const count = Number(cent.count) || 0;
    if (count > primaryCount) {
      primaryCount = count;
      primaryAnchor = cent;
    }
  }

  const floatData = new Float32Array(pixelCount * 4);

  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const i = y * outW + x;
      const idx = i * 4;
      if (!foliage[i]) {
        floatData[idx] = 0;
        floatData[idx + 1] = 0;
        floatData[idx + 2] = 0;
        floatData[idx + 3] = 0;
        continue;
      }

      const root = pixelRoot[i];
      const cent = root >= 0 ? centroidByRoot.get(root) : null;
      if (cent) {
        floatData[idx] = cent.wx;
        floatData[idx + 1] = cent.wy;
        floatData[idx + 2] = cent.seed;
        floatData[idx + 3] = 1.0;
      } else {
        const world = pixelCentroidToWorld(x + 0.5, y + 0.5, srcW, srcH, placement);
        floatData[idx] = world.x;
        floatData[idx + 1] = world.y;
        floatData[idx + 2] = 0;
        floatData[idx + 3] = 0;
      }
    }
  }

  const texture = new THREE.DataTexture(floatData, outW, outH, THREE.RGBAFormat, THREE.FloatType);
  texture.flipY = true;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  /** @type {Map<string, { ax: number, ay: number, id: number }>} */
  const islandBySeed = new Map();
  for (const cent of centroidByRoot.values()) {
    const key = Number(cent.seed).toFixed(8);
    islandBySeed.set(key, { ax: cent.wx, ay: cent.wy, id: cent.seed });
  }

  return { texture, islandCount: centroidByRoot.size, primaryAnchor, islandBySeed };
}

/**
 * Build clump coord map from a loaded THREE.Texture (mask).
 * @param {import('three').Texture} texture
 * @param {boolean} deriveAlpha
 * @param {{ centerX: number, centerY: number, tileW: number, tileH: number, rotationRad: number }} placement
 * @returns {{ texture: import('three').DataTexture, islandCount: number, primaryAnchor: { wx: number, wy: number, seed: number }|null }|null}
 */
/**
 * Downscale mask RGBA for clump bake when masks exceed {@link CLUMP_BAKE_MAX_DIM}.
 * @param {Uint8ClampedArray} data
 * @param {number} width
 * @param {number} height
 * @returns {{ data: Uint8ClampedArray, width: number, height: number }}
 */
function downscaleImageDataForClumpBake(data, width, height) {
  const longest = Math.max(width, height);
  if (longest <= CLUMP_BAKE_MAX_DIM) {
    return { data, width, height };
  }
  const scale = CLUMP_BAKE_MAX_DIM / longest;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) return { data, width, height };
  const srcImage = srcCtx.createImageData(width, height);
  srcImage.data.set(data);
  srcCtx.putImageData(srcImage, 0, 0);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) return { data, width, height };
  outCtx.drawImage(srcCanvas, 0, 0, outW, outH);
  const out = outCtx.getImageData(0, 0, outW, outH);
  return { data: out.data, width: outW, height: outH };
}

export function buildClumpCoordTexture(texture, deriveAlpha, placement, imageDataOpts = null) {
  try {
    let data;
    let width;
    let height;

    if (imageDataOpts?.data && imageDataOpts.width > 0 && imageDataOpts.height > 0) {
      ({ data, width, height } = downscaleImageDataForClumpBake(
        imageDataOpts.data,
        imageDataOpts.width,
        imageDataOpts.height,
      ));
    } else {
      const img = texture?.image;
      if (!img) return null;

      width = Number(img.naturalWidth || img.videoWidth || img.width || 0);
      height = Number(img.naturalHeight || img.videoHeight || img.height || 0);
      if (!(width > 0 && height > 0)) return null;

      const canvasEl = document.createElement('canvas');
      canvasEl.width = width;
      canvasEl.height = height;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      ({ data, width, height } = downscaleImageDataForClumpBake(
        imageData.data,
        width,
        height,
      ));
    }

    return buildClumpCoordTextureFromImageData({
      data,
      width,
      height,
      deriveAlpha,
      placement,
    });
  } catch (_) {
    return null;
  }
}

/**
 * Push clump texture + wave toggles only (does not touch wind anchor).
 * @param {{ material?: object, shadowMaterial?: object }} entry
 * @param {import('three').DataTexture|null} clumpTex
 * @param {object} params
 */
export function syncClumpCoordTextureToOverlayMaterials(entry, clumpTex, params = {}) {
  const p = { ...VEGETATION_CLUMP_FIELD_DEFAULTS, ...params };
  const hasMap = !!clumpTex;
  const enabled = hasMap && p.clumpWaveEnabled !== false;
  const mix = Math.max(0.0, Math.min(1.0, Number(p.clumpWaveMix ?? 1.0)));

  for (const mat of [entry?.material, entry?.shadowMaterial]) {
    const u = mat?.uniforms;
    if (!u) continue;
    if (u.tClumpCoordMap) u.tClumpCoordMap.value = clumpTex;
    if (u.uClumpCoordMapSize) {
      const sz = u.uClumpCoordMapSize.value;
      if (hasMap && clumpTex?.image) {
        const tw = Number(clumpTex.image.width) || 1;
        const th = Number(clumpTex.image.height) || 1;
        if (sz && typeof sz.set === 'function') sz.set(tw, th);
        else if (sz) { sz.x = tw; sz.y = th; }
      } else if (sz && typeof sz.set === 'function') {
        sz.set(1, 1);
      } else if (sz) {
        sz.x = 1;
        sz.y = 1;
      }
    }
    if (u.uHasClumpCoordMap) u.uHasClumpCoordMap.value = hasMap ? 1.0 : 0.0;
    if (u.uClumpWaveEnabled) u.uClumpWaveEnabled.value = enabled ? 1.0 : 0.0;
    if (u.uClumpWaveMix) u.uClumpWaveMix.value = mix;
  }
}

/**
 * Bind clump texture to canopy + shadow materials for one overlay.
 * @param {{ material?: object, shadowMaterial?: object, windPrimaryAnchor?: object|null, windPlacementCenter?: { x: number, y: number }|null }} entry
 * @param {import('three').DataTexture|null} clumpTex
 * @param {object} params
 * @param {{ wx: number, wy: number, seed: number }|null} [primaryAnchor]
 * @param {number} [centerX]
 * @param {number} [centerY]
 */
/**
 * Nearest-texel sample from baked clump DataTexture (matches fragment shader).
 * @param {import('three').DataTexture|null} clumpTex
 * @param {number} u
 * @param {number} v
 */
export function sampleClumpTexelNearest(clumpTex, u, v) {
  const img = clumpTex?.image;
  const data = img?.data;
  const w = Number(img?.width) || 0;
  const h = Number(img?.height) || 0;
  if (!data || !(w > 0) || !(h > 0)) return null;

  const cx = Math.floor(u * w);
  const cy = Math.floor(v * h);
  let best = null;
  let bestScore = -1;

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const x = Math.max(0, Math.min(w - 1, cx + dx));
      const y = Math.max(0, Math.min(h - 1, cy + dy));
      const i = (y * w + x) * 4;
      if (data[i + 3] < 0.01) continue;
      const score = 1.0 - (Math.abs(dx) + Math.abs(dy)) * 0.12;
      if (score > bestScore) {
        bestScore = score;
        best = { ax: data[i], ay: data[i + 1], id: data[i + 2] };
      }
    }
  }
  return best;
}

/**
 * Pick the dominant island id in a local UV window (avoids snapping to a neighbor island).
 * @param {import('three').DataTexture|null} clumpTex
 * @param {number} u
 * @param {number} v
 * @param {number} [radius]
 * @returns {number|null}
 */
function majorityIslandIdAtUv(clumpTex, u, v, radius = 3) {
  const img = clumpTex?.image;
  const data = img?.data;
  const w = Number(img?.width) || 0;
  const h = Number(img?.height) || 0;
  if (!data || !(w > 0) || !(h > 0)) return null;

  const cx = Math.floor(u * w);
  const cy = Math.floor(v * h);
  /** @type {Map<string, number>} */
  const votes = new Map();
  let total = 0;

  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      if (data[i + 3] < 0.01) continue;
      const id = data[i + 2];
      const key = Number(id).toFixed(8);
      votes.set(key, (votes.get(key) || 0) + 1);
      total += 1;
    }
  }

  if (total === 0) return null;

  const ci = (cy * w + cx) * 4;
  if (data[ci + 3] >= 0.01) {
    const centerKey = Number(data[ci + 2]).toFixed(8);
    const centerVotes = votes.get(centerKey) || 0;
    if (centerVotes >= Math.max(2, Math.ceil(total * 0.34))) {
      return data[ci + 2];
    }
  }

  let bestId = null;
  let bestVotes = 0;
  for (const [key, count] of votes) {
    if (count > bestVotes) {
      bestVotes = count;
      bestId = Number(key);
    }
  }
  return bestVotes >= 2 ? bestId : null;
}

/**
 * Vertex bake: majority island id at UV, then canonical centroid from island table.
 * @param {import('three').DataTexture|null} clumpTex
 * @param {number} u
 * @param {number} v
 * @param {Map<string, { ax: number, ay: number, id: number }>|null|undefined} islandBySeed
 */
/**
 * Max foliage alpha in a local UV window — drives bulk bend fade at mask fringes.
 * @param {import('three').DataTexture|null} clumpTex
 * @param {number} u
 * @param {number} v
 * @param {number} [radius]
 * @returns {number}
 */
export function sampleFoliageCoverAtUv(clumpTex, u, v, radius = 4) {
  const img = clumpTex?.image;
  const data = img?.data;
  const w = Number(img?.width) || 0;
  const h = Number(img?.height) || 0;
  if (!data || !(w > 0) || !(h > 0)) return 0;

  const cx = Math.floor(u * w);
  const cy = Math.floor(v * h);
  let best = 0;

  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = (y * w + x) * 4;
      best = Math.max(best, data[i + 3]);
    }
  }
  return best;
}

export function sampleClumpForVertexBake(clumpTex, u, v, islandBySeed = null, voteRadius = 6) {
  const id = majorityIslandIdAtUv(clumpTex, u, v, voteRadius);
  if (id == null) return null;
  const key = Number(id).toFixed(8);
  const canon = islandBySeed?.get(key);
  if (canon) return { ax: canon.ax, ay: canon.ay, id: canon.id };
  const near = sampleClumpTexelNearest(clumpTex, u, v);
  if (near && Number(near.id).toFixed(8) === key) return near;
  return { ax: 0, ay: 0, id };
}

/**
 * @param {Map<string, { ax: number, ay: number, id: number }>|null|undefined} islandBySeed
 * @param {number} id
 * @param {number} fallbackAx
 * @param {number} fallbackAy
 */
function canonicalClumpAnchorForId(islandBySeed, id, fallbackAx, fallbackAy) {
  const key = Number(id).toFixed(8);
  const canon = islandBySeed?.get(key);
  if (canon) return { ax: canon.ax, ay: canon.ay, id: canon.id };
  return { ax: fallbackAx, ay: fallbackAy, id };
}

/**
 * Fill vertices that missed the mask (id=0) from labeled neighbors on the wind grid.
 * @param {import('three').BufferGeometry} geometry
 * @param {Map<string, { ax: number, ay: number, id: number }>|null|undefined} islandBySeed
 * @param {number} [iterations]
 * @param {number} [neighborRadius]
 */
export function propagateClumpWindAttributesOnGeometry(
  geometry,
  islandBySeed = null,
  iterations = 5,
  neighborRadius = 2,
) {
  const idAttr = geometry?.attributes?.aClumpId;
  const anchorAttr = geometry?.attributes?.aClumpAnchor;
  if (!idAttr || !anchorAttr) return;

  const params = geometry.parameters || {};
  const cols = (Number(params.widthSegments) || 0) + 1;
  const rows = (Number(params.heightSegments) || 0) + 1;
  if (!(cols > 1) || !(rows > 1) || idAttr.count !== cols * rows) return;

  let ids = Float32Array.from(idAttr.array);
  let anchors = Float32Array.from(anchorAttr.array);
  const idx = (x, y) => y * cols + x;

  for (let pass = 0; pass < iterations; pass += 1) {
    const newIds = Float32Array.from(ids);
    const newAnchors = Float32Array.from(anchors);

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const vi = idx(x, y);
        if (ids[vi] > 1e-6) continue;

        /** @type {Map<string, { count: number, ax: number, ay: number, id: number }>} */
        const votes = new Map();
        for (let dy = -neighborRadius; dy <= neighborRadius; dy += 1) {
          for (let dx = -neighborRadius; dx <= neighborRadius; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const ni = idx(nx, ny);
            const id = ids[ni];
            if (!(id > 1e-6)) continue;
            const key = Number(id).toFixed(8);
            const prev = votes.get(key);
            if (prev) prev.count += 1;
            else votes.set(key, { count: 1, ax: anchors[ni * 2], ay: anchors[ni * 2 + 1], id });
          }
        }

        if (votes.size === 0) continue;

        let winner = null;
        let bestCount = 0;
        for (const entry of votes.values()) {
          if (entry.count > bestCount) {
            bestCount = entry.count;
            winner = entry;
          }
        }
        if (winner && bestCount >= 1) {
          const canon = canonicalClumpAnchorForId(islandBySeed, winner.id, winner.ax, winner.ay);
          newIds[vi] = canon.id;
          newAnchors[vi * 2] = canon.ax;
          newAnchors[vi * 2 + 1] = canon.ay;
        }
      }
    }

    ids = newIds;
    anchors = newAnchors;
  }

  idAttr.array.set(ids);
  anchorAttr.array.set(anchors);
  idAttr.needsUpdate = true;
  anchorAttr.needsUpdate = true;
}

/**
 * Force every vertex with a given island id to share that island's canonical centroid.
 * @param {import('three').BufferGeometry} geometry
 * @param {Map<string, { ax: number, ay: number, id: number }>|null|undefined} islandBySeed
 */
export function canonicalizeClumpAnchorsFromIslandTable(geometry, islandBySeed = null) {
  const idAttr = geometry?.attributes?.aClumpId;
  const anchorAttr = geometry?.attributes?.aClumpAnchor;
  if (!idAttr || !anchorAttr || !islandBySeed?.size) return;

  const anchors = anchorAttr.array;
  for (let i = 0; i < idAttr.count; i += 1) {
    const id = idAttr.array[i];
    if (!(id > 1e-6)) continue;
    const canon = canonicalClumpAnchorForId(islandBySeed, id, anchors[i * 2], anchors[i * 2 + 1]);
    anchors[i * 2] = canon.ax;
    anchors[i * 2 + 1] = canon.ay;
    idAttr.array[i] = canon.id;
  }

  idAttr.needsUpdate = true;
  anchorAttr.needsUpdate = true;
}

/**
 * Smooth vertex clump ids across the wind grid so each island moves as a rigid sheet.
 * @param {import('three').BufferGeometry} geometry
 * @param {Map<string, { ax: number, ay: number, id: number }>|null|undefined} [islandBySeed]
 * @param {number} [iterations]
 */
export function homogenizeClumpWindAttributesOnGeometry(geometry, islandBySeed = null, iterations = 6) {
  const idAttr = geometry?.attributes?.aClumpId;
  const anchorAttr = geometry?.attributes?.aClumpAnchor;
  if (!idAttr || !anchorAttr) return;

  const params = geometry.parameters || {};
  const cols = (Number(params.widthSegments) || 0) + 1;
  const rows = (Number(params.heightSegments) || 0) + 1;
  if (!(cols > 1) || !(rows > 1) || idAttr.count !== cols * rows) return;

  let ids = Float32Array.from(idAttr.array);
  let anchors = Float32Array.from(anchorAttr.array);
  const idx = (x, y) => y * cols + x;

  for (let pass = 0; pass < iterations; pass += 1) {
    const newIds = Float32Array.from(ids);
    const newAnchors = Float32Array.from(anchors);

    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const vi = idx(x, y);
        /** @type {Map<string, { count: number, ax: number, ay: number, id: number }>} */
        const votes = new Map();

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const ni = idx(nx, ny);
            const id = ids[ni];
            if (!(id > 1e-6)) continue;
            const key = Number(id).toFixed(8);
            const prev = votes.get(key);
            if (prev) prev.count += 1;
            else votes.set(key, { count: 1, ax: anchors[ni * 2], ay: anchors[ni * 2 + 1], id });
          }
        }

        if (votes.size === 0) continue;

        let winner = null;
        let bestCount = 0;
        for (const entry of votes.values()) {
          if (entry.count > bestCount) {
            bestCount = entry.count;
            winner = entry;
          }
        }
        if (winner && bestCount >= 2) {
          const canon = canonicalClumpAnchorForId(islandBySeed, winner.id, winner.ax, winner.ay);
          newIds[vi] = canon.id;
          newAnchors[vi * 2] = canon.ax;
          newAnchors[vi * 2 + 1] = canon.ay;
        }
      }
    }

    ids = newIds;
    anchors = newAnchors;
  }

  idAttr.array.set(ids);
  anchorAttr.array.set(anchors);
  idAttr.needsUpdate = true;
  anchorAttr.needsUpdate = true;
}

/**
 * Rebuild overlay plane with mask-driven segment count so each island gets distinct vertex clump data.
 * @param {{ mesh?: object, shadowMesh?: object }} entry
 * @param {number} tileW
 * @param {number} tileH
 * @param {number} centerX
 * @param {number} centerY
 * @param {import('three').DataTexture|null} clumpTex
 * @returns {number} segment count used
 */
export function upgradeWindDisplacedGeometry(entry, tileW, tileH, centerX, centerY, clumpTex, islandCount = 1) {
  const THREE = window.THREE;
  if (!THREE || !entry?.mesh) return 0;

  const maskW = Number(clumpTex?.image?.width) || 0;
  const maskH = Number(clumpTex?.image?.height) || 0;
  const seg = windDisplacedMeshSegments(tileW, tileH, maskW, maskH, islandCount);
  const oldGeo = entry.mesh.geometry;
  const newGeo = new THREE.PlaneGeometry(tileW, tileH, seg, seg);
  initClumpWindAttributesOnGeometry(newGeo, centerX, centerY, 0);

  entry.mesh.geometry = newGeo;
  if (entry.shadowMesh) entry.shadowMesh.geometry = newGeo;
  if (oldGeo && oldGeo !== newGeo) {
    try { oldGeo.dispose(); } catch (_) {}
  }
  return seg;
}

/**
 * Bake island anchor + id into mesh vertex attributes for bulk wind displacement.
 * @param {{ mesh?: object, shadowMesh?: object }} entry
 * @param {import('three').DataTexture|null} clumpTex
 * @param {{ wx: number, wy: number, seed: number }|null} [primaryAnchor]
 * @param {number} [centerX]
 * @param {number} [centerY]
 */
/**
 * Placeholder clump attributes until the clump map finishes baking.
 * @param {import('three').BufferGeometry|null|undefined} geometry
 * @param {number} ax
 * @param {number} ay
 * @param {number} [id]
 */
export function initClumpWindAttributesOnGeometry(geometry, ax, ay, id = 0) {
  const THREE = window.THREE;
  const uvAttr = geometry?.attributes?.uv;
  if (!THREE || !uvAttr) return;
  const count = uvAttr.count;
  const anchors = new Float32Array(count * 2);
  const ids = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    anchors[i * 2] = ax;
    anchors[i * 2 + 1] = ay;
    ids[i] = id;
  }
  geometry.setAttribute('aClumpAnchor', new THREE.BufferAttribute(anchors, 2));
  geometry.setAttribute('aClumpId', new THREE.BufferAttribute(ids, 1));
  const covers = new Float32Array(count);
  geometry.setAttribute('aFoliageCover', new THREE.BufferAttribute(covers, 1));
}

/**
 * Bake foliage cover per vertex from clump map alpha.
 * @param {import('three').BufferGeometry} geometry
 * @param {import('three').DataTexture|null} clumpTex
 */
function bakeFoliageCoverOnGeometry(geometry, clumpTex) {
  const uvAttr = geometry?.attributes?.uv;
  if (!uvAttr) return;

  const count = uvAttr.count;
  const covers = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    covers[i] = sampleFoliageCoverAtUv(clumpTex, uvAttr.getX(i), uvAttr.getY(i));
  }
  geometry.setAttribute('aFoliageCover', new THREE.BufferAttribute(covers, 1));
}

/**
 * Propagate foliage cover into empty grid cells from neighbors.
 * @param {import('three').BufferGeometry} geometry
 * @param {number} [iterations]
 */
function propagateFoliageCoverOnGeometry(geometry, iterations = 6) {
  const coverAttr = geometry?.attributes?.aFoliageCover;
  if (!coverAttr) return;

  const params = geometry.parameters || {};
  const cols = (Number(params.widthSegments) || 0) + 1;
  const rows = (Number(params.heightSegments) || 0) + 1;
  if (!(cols > 1) || !(rows > 1) || coverAttr.count !== cols * rows) return;

  let covers = Float32Array.from(coverAttr.array);
  const idx = (x, y) => y * cols + x;

  for (let pass = 0; pass < iterations; pass += 1) {
    const next = Float32Array.from(covers);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const vi = idx(x, y);
        if (covers[vi] > 0.02) continue;
        let best = 0;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            best = Math.max(best, covers[idx(nx, ny)]);
          }
        }
        if (best > 0) next[vi] = best * 0.92;
      }
    }
    covers = next;
  }

  coverAttr.array.set(covers);
  coverAttr.needsUpdate = true;
}

/**
 * Each wind mesh triangle moves as a rigid sheet (same clump + cover on all three corners).
 * @param {import('three').BufferGeometry} geometry
 * @param {import('three').DataTexture|null} clumpTex
 * @param {Map<string, { ax: number, ay: number, id: number }>|null|undefined} islandBySeed
 * @param {number} fallbackAx
 * @param {number} fallbackAy
 */
export function rigidizeClumpWindTrianglesOnGeometry(
  geometry,
  clumpTex,
  islandBySeed = null,
  fallbackAx = 0,
  fallbackAy = 0,
) {
  const uvAttr = geometry?.attributes?.uv;
  const index = geometry?.index;
  const idAttr = geometry?.attributes?.aClumpId;
  const anchorAttr = geometry?.attributes?.aClumpAnchor;
  const coverAttr = geometry?.attributes?.aFoliageCover;
  if (!uvAttr || !index || !idAttr || !anchorAttr || !coverAttr) return;

  const ids = idAttr.array;
  const anchors = anchorAttr.array;
  const covers = coverAttr.array;

  for (let t = 0; t < index.count; t += 3) {
    const i0 = index.getX(t);
    const i1 = index.getX(t + 1);
    const i2 = index.getX(t + 2);
    const cu = (uvAttr.getX(i0) + uvAttr.getX(i1) + uvAttr.getX(i2)) / 3;
    const cv = (uvAttr.getY(i0) + uvAttr.getY(i1) + uvAttr.getY(i2)) / 3;
    const cover = sampleFoliageCoverAtUv(clumpTex, cu, cv, 5);
    const sample = sampleClumpForVertexBake(clumpTex, cu, cv, islandBySeed);

    for (const vi of [i0, i1, i2]) {
      covers[vi] = Math.max(cover, 0.35);
      if (sample && sample.id > 1e-6) {
        const canon = canonicalClumpAnchorForId(islandBySeed, sample.id, fallbackAx, fallbackAy);
        ids[vi] = canon.id;
        anchors[vi * 2] = canon.ax;
        anchors[vi * 2 + 1] = canon.ay;
      } else {
        ids[vi] = 0;
        anchors[vi * 2] = fallbackAx;
        anchors[vi * 2 + 1] = fallbackAy;
        covers[vi] = cover;
      }
    }
  }

  idAttr.needsUpdate = true;
  anchorAttr.needsUpdate = true;
  coverAttr.needsUpdate = true;
}

/**
 * Majority vote per shared vertex after triangle rigidize — prevents adjacent triangles shearing.
 * @param {import('three').BufferGeometry} geometry
 * @param {Map<string, { ax: number, ay: number, id: number }>|null|undefined} islandBySeed
 * @param {number} fallbackAx
 * @param {number} fallbackAy
 */
export function unifyClumpWindVerticesOnGeometry(
  geometry,
  islandBySeed = null,
  fallbackAx = 0,
  fallbackAy = 0,
) {
  const index = geometry?.index;
  const idAttr = geometry?.attributes?.aClumpId;
  const anchorAttr = geometry?.attributes?.aClumpAnchor;
  const coverAttr = geometry?.attributes?.aFoliageCover;
  if (!index || !idAttr || !anchorAttr || !coverAttr) return;

  const count = idAttr.count;
  /** @type {Map<string, { count: number, id: number, cover: number }>[]} */
  const voteMaps = Array.from({ length: count }, () => new Map());

  for (let t = 0; t < index.count; t += 3) {
    for (let k = 0; k < 3; k += 1) {
      const vi = index.getX(t + k);
      const id = idAttr.array[vi];
      if (!(id > 1e-6)) continue;
      const key = Number(id).toFixed(8);
      const entry = voteMaps[vi].get(key) || { count: 0, id, cover: 0 };
      entry.count += 1;
      entry.cover = Math.max(entry.cover, coverAttr.array[vi]);
      voteMaps[vi].set(key, entry);
    }
  }

  const ids = idAttr.array;
  const anchors = anchorAttr.array;
  const covers = coverAttr.array;

  for (let vi = 0; vi < count; vi += 1) {
    const votes = voteMaps[vi];
    if (votes.size === 0) continue;
    let best = null;
    let bestCount = 0;
    for (const entry of votes.values()) {
      if (entry.count > bestCount) {
        bestCount = entry.count;
        best = entry;
      }
    }
    if (!best) continue;
    const canon = canonicalClumpAnchorForId(islandBySeed, best.id, fallbackAx, fallbackAy);
    ids[vi] = canon.id;
    anchors[vi * 2] = canon.ax;
    anchors[vi * 2 + 1] = canon.ay;
    covers[vi] = Math.max(covers[vi], best.cover);
  }

  idAttr.needsUpdate = true;
  anchorAttr.needsUpdate = true;
  coverAttr.needsUpdate = true;
}

/**
 * Vote island id per vertex from incident triangle centroids so each cell moves rigidly.
 * @param {import('three').BufferGeometry} geometry
 * @param {import('three').DataTexture|null} clumpTex
 * @param {Map<string, { ax: number, ay: number, id: number }>|null|undefined} islandBySeed
 * @param {number} fallbackAx
 * @param {number} fallbackAy
 * @param {Set<string>} [idSet]
 */
function bakeClumpWindAttributesOnGeometry(
  geometry,
  clumpTex,
  islandBySeed,
  fallbackAx,
  fallbackAy,
  idSet = null,
) {
  const THREE = window.THREE;
  const uvAttr = geometry?.attributes?.uv;
  const index = geometry?.index;
  if (!THREE || !uvAttr) return;

  const count = uvAttr.count;
  /** @type {Map<string, number>[]} */
  const voteMaps = Array.from({ length: count }, () => new Map());

  const addVote = (vi, id) => {
    if (!(id > 1e-6)) return;
    const key = Number(id).toFixed(8);
    voteMaps[vi].set(key, (voteMaps[vi].get(key) || 0) + 1);
  };

  if (index) {
    for (let t = 0; t < index.count; t += 3) {
      const i0 = index.getX(t);
      const i1 = index.getX(t + 1);
      const i2 = index.getX(t + 2);
      const cu = (uvAttr.getX(i0) + uvAttr.getX(i1) + uvAttr.getX(i2)) / 3;
      const cv = (uvAttr.getY(i0) + uvAttr.getY(i1) + uvAttr.getY(i2)) / 3;
      const sample = sampleClumpForVertexBake(clumpTex, cu, cv, islandBySeed);
      if (!sample) continue;
      addVote(i0, sample.id);
      addVote(i1, sample.id);
      addVote(i2, sample.id);
    }
  }

  const anchors = new Float32Array(count * 2);
  const ids = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const votes = voteMaps[i];
    let chosenId = null;

    if (votes.size > 0) {
      let bestKey = null;
      let bestCount = 0;
      for (const [key, n] of votes) {
        if (n > bestCount) {
          bestCount = n;
          bestKey = key;
        }
      }
      chosenId = bestKey != null ? Number(bestKey) : null;
    } else {
      const sample = sampleClumpForVertexBake(
        clumpTex, uvAttr.getX(i), uvAttr.getY(i), islandBySeed,
      );
      chosenId = sample?.id ?? null;
    }

    if (chosenId != null && chosenId > 1e-6) {
      const canon = canonicalClumpAnchorForId(islandBySeed, chosenId, fallbackAx, fallbackAy);
      anchors[i * 2] = canon.ax;
      anchors[i * 2 + 1] = canon.ay;
      ids[i] = canon.id;
      idSet?.add(canon.id.toFixed(6));
    } else {
      anchors[i * 2] = fallbackAx;
      anchors[i * 2 + 1] = fallbackAy;
      ids[i] = 0;
    }
  }

  geometry.setAttribute('aClumpAnchor', new THREE.BufferAttribute(anchors, 2));
  geometry.setAttribute('aClumpId', new THREE.BufferAttribute(ids, 1));
}

export function bakeClumpWindAttributesToMeshes(
  entry,
  clumpTex,
  primaryAnchor = null,
  centerX = 0,
  centerY = 0,
  islandBySeed = null,
) {
  const THREE = window.THREE;
  if (!THREE || !entry) return { vertexCount: 0, distinctIds: 0, homogenized: false };

  const lookup = islandBySeed ?? entry?.clumpIslandBySeed ?? null;
  const fAx = Number(primaryAnchor?.wx ?? centerX) || 0;
  const fAy = Number(primaryAnchor?.wy ?? centerY) || 0;
  const idSet = new Set();
  let vertexCount = 0;
  let homogenized = false;

  for (const mesh of [entry.mesh, entry.shadowMesh]) {
    const geo = mesh?.geometry;
    const uvAttr = geo?.attributes?.uv;
    if (!geo || !uvAttr) continue;

    bakeClumpWindAttributesOnGeometry(geo, clumpTex, lookup, fAx, fAy, idSet);
    bakeFoliageCoverOnGeometry(geo, clumpTex);
    propagateClumpWindAttributesOnGeometry(geo, lookup, 8, 3);
    propagateFoliageCoverOnGeometry(geo, 6);
    homogenizeClumpWindAttributesOnGeometry(geo, lookup, 6);
    canonicalizeClumpAnchorsFromIslandTable(geo, lookup);
    rigidizeClumpWindTrianglesOnGeometry(geo, clumpTex, lookup, fAx, fAy);
    unifyClumpWindVerticesOnGeometry(geo, lookup, fAx, fAy);
    homogenized = true;
    vertexCount = Math.max(vertexCount, uvAttr.count);
  }

  return { vertexCount, distinctIds: idSet.size, homogenized };
}

export function bindClumpCoordTextureToOverlayMaterials(
  entry,
  clumpTex,
  params = {},
  primaryAnchor = null,
  centerX = 0,
  centerY = 0,
  placement = null,
  islandCount = 1,
) {
  syncClumpCoordTextureToOverlayMaterials(entry, clumpTex, params);
  if (entry) {
    entry.windPrimaryAnchor = primaryAnchor ?? null;
    entry.windPlacementCenter = { x: Number(centerX) || 0, y: Number(centerY) || 0 };
    entry._clumpIslandCount = Number(islandCount) || 1;
    const tileW = Number(placement?.tileW) || 0;
    const tileH = Number(placement?.tileH) || 0;
    if (clumpTex && tileW > 0 && tileH > 0) {
      entry._windMeshSegments = upgradeWindDisplacedGeometry(
        entry, tileW, tileH, centerX, centerY, clumpTex, islandCount,
      );
    }
    entry._clumpVertexBake = bakeClumpWindAttributesToMeshes(
      entry, clumpTex, primaryAnchor, centerX, centerY, entry?.clumpIslandBySeed ?? null,
    );
  }
  applyVegetationWindAnchorToOverlay(entry, primaryAnchor, centerX, centerY);
}
