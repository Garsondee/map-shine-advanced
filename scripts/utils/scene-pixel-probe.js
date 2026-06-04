/**
 * @fileoverview Scene pixel probe — multi-click brightness / lighting / mask diagnostics.
 * @module utils/scene-pixel-probe
 */

import { readRtPixelSrgb, sceneNormUvToRtPixel, isHalfFloatRt } from './rt-pixel-readback.js';
import { LightingDirector } from '../core/LightingDirector.js';
import { getAuthoritativeAmbientLightDocuments } from '../foundry/ambient-light-documents.js';
import { readTileLevelsFlags } from '../foundry/levels-scene-flags.js';
import { resolveEffectEnabled } from '../effects/resolve-effect-enabled.js';
import { GROUND_Z } from '../compositor-v2/LayerOrderPolicy.js';
import { estimateIndoorWeightFromRgba } from '../masks/outdoors-mask-decode.js';
import { estimateStackedIndoorWeight } from '../masks/indoor-outdoor-defringe.js';
import { getBandOutdoorsMask } from '../masks/indoor-outdoor-mask-api.js';

const SCHEMA_VERSION = 8;
const PICK_LABELS = ['A', 'B', 'C'];
const DEFAULT_PICK_COUNT = 3;
const MAX_PICK_COUNT = 3;
/** Wide listing only — not used for "affects probe" (see Foundry dim/bright radii). */
const FOUNDRY_LIGHT_LIST_RADIUS_GRID = 40;

/** @type {((event: object) => void|Promise<void>)|null} */
let _pickHandler = null;

/** @type {{ mode: 'dom'|'pixi', target: EventTarget|object, listener: Function, userHandler: Function }|null} */
let _pickRegistration = null;

/**
 * Matches `msDecodeOutdoorsMaskSample` / WeatherController CPU decode.
 * @param {number} r8
 * @param {number} g8
 * @param {number} b8
 * @param {number} a8
 * @returns {number}
 */
function decodeOutdoorsMaskSample8(r8, g8, b8, a8) {
  const r = Math.max(0, Math.min(255, Number(r8) || 0)) / 255;
  const g = Math.max(0, Math.min(255, Number(g8) || 0)) / 255;
  const b = Math.max(0, Math.min(255, Number(b8) || 0)) / 255;
  const a = Math.max(0, Math.min(255, Number(a8) || 0)) / 255;
  const lum = Math.max(r, g, b);
  if (lum < 1e-5 && a < 1e-5) return 1.0;
  return Math.max(0, Math.min(1, lum * a));
}

/**
 * @returns {object|null}
 */
function resolveFloorCompositorV2() {
  const ms = globalThis.MapShine ?? {};
  return ms.floorCompositorV2
    ?? ms.effectComposer?._floorCompositorV2
    ?? null;
}

/**
 * @param {object|null} px
 * @returns {object|null}
 */
function compactPixel(px) {
  if (!px || px.error) return px?.error ? { error: px.error } : null;
  return {
    r: px.r,
    g: px.g,
    b: px.b,
    a: px.a,
    luma: px.luma,
    pixelType: px.pixelType ?? null,
  };
}

/**
 * @param {THREE.WebGLRenderer|null} renderer
 * @param {import('three').WebGLRenderTarget|null} rt
 * @param {number} uvX
 * @param {number} uvY
 * @returns {object}
 */
export function readRtPixel(renderer, rt, uvX, uvY) {
  if (!renderer || !rt?.width || !rt?.height) return { error: 'no-rt' };
  const { px, pyGl } = sceneNormUvToRtPixel(uvX, uvY, renderer, rt, { preferFoundrySceneRect: false });
  const hit = readRtPixelSrgb(renderer, rt, px, pyGl);
  if (!hit) return { error: 'read-failed', pixelType: isHalfFloatRt(rt) ? 'half' : 'uint8' };
  const [r, g, b, a] = hit.linear;
  return {
    r,
    g,
    b,
    a,
    luma: 0.2126 * r + 0.7152 * g + 0.0722 * b,
    pixelType: isHalfFloatRt(rt) ? 'half' : 'uint8',
  };
}

/**
 * Matches ColorCorrectionEffectV2 / msDecodeOutdoorsMaskSample.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a
 * @returns {number}
 */
function decodeCcOutdoorStrength(r, g, b, a, stackedEffective = true) {
  if (stackedEffective) {
    return Math.max(0, Math.min(1, r));
  }
  const lum = Math.max(r, g, b);
  return Math.max(0, Math.min(1, 1.0 - a + lum * a));
}

/**
 * Matches ColorCorrectionEffectV2 sampleIndoorWeight (stacked / water timeline decode).
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a
 * @returns {number}
 */
function estimateCcIndoorWeight(r, g, b, a, stackedEffective = true) {
  if (stackedEffective) {
    return estimateStackedIndoorWeight(r, a);
  }
  return estimateIndoorWeightFromRgba(r, g, b, a);
}

/** @typedef {'outdoor'|'indoor'|'unknown'} OutdoorsClassification */

/**
 * Classify GPU mask sample (white = outdoor).
 * @param {number|null} strength
 * @param {number|null} alpha
 * @returns {OutdoorsClassification}
 */
function classifyGpuOutdoorsMask(strength, alpha) {
  if (!Number.isFinite(strength) || !Number.isFinite(alpha)) return 'unknown';
  if (alpha <= 0.5) return 'unknown';
  return strength >= 0.5 ? 'outdoor' : 'indoor';
}

/**
 * Classify effective CC outdoor strength.
 * @param {number|null} outdoorStrength
 * @param {number|null} alpha
 * @returns {OutdoorsClassification}
 */
function classifyCcOutdoorStrength(outdoorStrength, alpha) {
  if (!Number.isFinite(outdoorStrength)) return 'unknown';
  if (Number.isFinite(alpha) && alpha <= 0.5 && outdoorStrength >= 0.99) {
    return 'outdoor';
  }
  if (!Number.isFinite(alpha) || alpha > 0.5) {
    return outdoorStrength >= 0.5 ? 'outdoor' : 'indoor';
  }
  return 'unknown';
}

/**
 * Compact indoors/outdoors summary for dialogs and schema v3.
 * @param {object} point
 * @returns {object}
 */
export function summarizeOutdoors(point) {
  const masks = point.masks ?? {};
  const gpuPx = masks.floorGpuOutdoors;
  const gpuStrength = gpuPx && !gpuPx.error ? gpuPx.r : null;
  const gpuAlpha = gpuPx && !gpuPx.error ? gpuPx.a : null;
  const effectiveOutdoorStrength = masks.estimatedCcOutdoorStrength ?? null;
  const effectiveIndoorWeight = masks.estimatedIndoorWeight ?? null;
  const outdoorsAlpha = masks.outdoorsAlpha ?? masks.stackedOutdoors?.alpha ?? gpuAlpha ?? null;

  /** @type {string[]} */
  const notes = [];
  if (masks.stackedOutdoors?.alpha === 0 && effectiveOutdoorStrength === 1) {
    notes.push('zero_alpha_decodes_outdoor');
  }
  if (masks.outdoorsSources?.gpuHasAuthoring === false) {
    notes.push('no_outdoors_mask_authoring_on_floor');
  }
  if (masks.outdoorsSources?.bundleMetaTex && !masks.outdoorsSources?.getFloorTexture) {
    notes.push('bundle_outdoors_not_promoted_to_gpu');
  }
  if (masks.stackedOutdoors?.uniformIndoorFill === true) {
    notes.push('stacked_uniform_indoor_fill');
  }
  if (masks.floorGpuOutdoors && !masks.floorGpuOutdoors.error) {
    const fa = masks.floorGpuOutdoors.a ?? 1;
    const fr = masks.floorGpuOutdoors.r ?? 0;
    if (fa <= 0.5 && fr <= 0.05) {
      notes.push('gpu_outdoors_cleared_texel_decodes_outdoor');
    }
  }
  if (masks.outdoorsSources?.gpuRepairNeeded === true) {
    notes.push('gpu_mask_repair_needed');
  }

  const classification = classifyCcOutdoorStrength(effectiveOutdoorStrength, outdoorsAlpha);
  const gpuClassification = classifyGpuOutdoorsMask(gpuStrength, gpuAlpha);

  /** @type {{ floorIndex: number, gpuStrength: number|null, classification: OutdoorsClassification }[]} */
  const perFloor = [];
  for (const pl of point.pipeline?.perFloor ?? []) {
    const od = pl.outdoors;
    const str = od && !od.error ? od.r : null;
    const a = od && !od.error ? od.a : null;
    perFloor.push({
      floorIndex: pl.floorIndex,
      gpuStrength: str,
      classification: classifyGpuOutdoorsMask(str, a),
    });
  }

  return {
    classification,
    gpuClassification,
    effectiveOutdoorStrength,
    effectiveIndoorWeight,
    gpuMaskStrength: gpuStrength,
    gpuMaskAlpha: gpuAlpha,
    maskHasAuthoring: masks.outdoorsSources?.gpuHasAuthoring ?? null,
    sampleSource: masks.ccBoundOutdoors?.sampleSource ?? null,
    perFloor,
    notes,
  };
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget|null} rt
 * @param {object} sceneUv
 * @returns {object|null}
 */
function sampleCcBoundOutdoors(renderer, compositor, cc, sceneUv) {
  const u = cc?._composeMaterial?.uniforms;
  const uniformTex = u?.tOutdoorsMask?.value ?? null;
  const hasMask = Number(u?.uHasOutdoorsMask?.value) > 0.5;
  const postMergeDiag = globalThis.MapShine?.__ccPostMergeMaskDiag ?? null;
  const postMergeTex = globalThis.MapShine?.__ccPostMergeOutdoorsTexture ?? null;
  const tex = postMergeTex ?? uniformTex;
  const out = {
    hasMask: hasMask || !!postMergeTex,
    texUuid: tex?.uuid ?? null,
    texName: tex?.name ?? null,
    uniformTexUuid: uniformTex?.uuid ?? null,
    postMergeDiag,
    sample: null,
    sampleSource: null,
  };
  if (!tex) return out;

  const findRtForTex = (targetTex) => {
    if (!compositor || !targetTex) return null;
    for (const rt of [compositor._stackedOutdoorsRtA, compositor._stackedOutdoorsRtB]) {
      if (rt?.texture === targetTex) return rt;
    }
    for (const [fk, map] of compositor._floorCache?.entries?.() ?? []) {
      const rt = map?.get?.('outdoors');
      if (rt?.texture === targetTex) return { rt, floorKey: fk };
    }
    return null;
  };

  const hit = findRtForTex(tex);
  if (hit?.rt) {
    out.sample = compactPixel(readRtPixel(renderer, hit.rt, sceneUv.u, sceneUv.v));
    out.sampleSource = hit.floorKey ? `floor:${hit.floorKey}` : 'stackedOutdoorsRt';
  } else if (tex?.isDataTexture && tex.image?.data) {
    const r = tex.image.data[0] / 255;
    const g = tex.image.data[1] / 255;
    const b = tex.image.data[2] / 255;
    const a = tex.image.data[3] / 255;
    out.sample = { r, g, b, a, luma: r, pixelType: 'data1x1' };
    out.sampleSource = 'dataTexture';
  }
  return out;
}

/**
 * Map world XY to normalized UV in a buffer that uses CC view bounds.
 * @param {number} wx
 * @param {number} wy
 * @param {object|null} cc
 * @returns {{ u: number, y: number }|null}
 */
function worldToCcBufferUv(wx, wy, cc) {
  const ccU = cc?._composeMaterial?.uniforms;
  const vMin = ccU?.uViewBoundsMin?.value;
  const vMax = ccU?.uViewBoundsMax?.value;
  if (!vMin || !vMax) return null;
  return {
    u: (Number(wx) - vMin.x) / Math.max(1e-5, vMax.x - vMin.x),
    v: (Number(wy) - vMin.y) / Math.max(1e-5, vMax.y - vMin.y),
  };
}

/**
 * Map world XY to normalized screen UV (0–1) for screen-space RTs (windowLight, lightRT).
 * Uses FloorCompositor ortho view bounds — matches gl_FragCoord / uScreenSize layout.
 * @param {number} wx
 * @param {number} wy
 * @param {object|null} fc
 * @param {number} [floorIdx=0]
 * @returns {{ u: number, v: number, onScreen: boolean }|null}
 */
function worldToScreenBufferUv(wx, wy, fc, floorIdx = 0) {
  const cam = fc?.camera ?? null;
  if (!cam) return null;
  if (cam.isOrthographicCamera === true) {
    const z = Math.max(1e-5, Number(cam.zoom) || 1);
    const vMinX = cam.position.x + cam.left / z;
    const vMinY = cam.position.y + cam.bottom / z;
    const vMaxX = cam.position.x + cam.right / z;
    const vMaxY = cam.position.y + cam.top / z;
    const u = (Number(wx) - vMinX) / Math.max(1e-5, vMaxX - vMinX);
    const v = (Number(wy) - vMinY) / Math.max(1e-5, vMaxY - vMinY);
    return {
      u,
      v,
      onScreen: u >= -0.01 && u <= 1.01 && v >= -0.01 && v <= 1.01,
    };
  }
  const THREE = globalThis.THREE;
  if (!THREE) return null;
  const groundZ = GROUND_Z + (Number.isFinite(Number(floorIdx)) ? Number(floorIdx) : 0);
  const vec = new THREE.Vector3(Number(wx), Number(wy), groundZ);
  vec.project(cam);
  const u = (vec.x + 1) * 0.5;
  const v = (vec.y + 1) * 0.5;
  return {
    u,
    v,
    onScreen: vec.x >= -1.01 && vec.x <= 1.01 && vec.y >= -1.01 && vec.y <= 1.01 && vec.z >= -1 && vec.z <= 1,
  };
}

/**
 * CPU sample of a mask/authored texture at scene UV (DataTexture or canvas image).
 * @param {import('three').Texture|null} tex
 * @param {number} u
 * @param {number} v
 * @returns {object|null}
 */
function sampleCpuTextureAtSceneUv(tex, u, v) {
  const img = tex?.image ?? tex?.source?.data ?? null;
  if (!img) return null;
  const w = img.width ?? img.videoWidth ?? 0;
  const h = img.height ?? img.videoHeight ?? 0;
  if (!(w > 0 && h > 0)) return null;
  let mu = Math.max(0, Math.min(1, u));
  let mv = Math.max(0, Math.min(1, v));
  if (tex.flipY) mv = 1.0 - mv;
  const px = Math.max(0, Math.min(w - 1, Math.floor(mu * (w - 1))));
  const py = Math.max(0, Math.min(h - 1, Math.floor(mv * (h - 1))));
  try {
    if (img.data && img.width && img.height) {
      const i = (py * w + px) * 4;
      const r = img.data[i] / 255;
      const g = img.data[i + 1] / 255;
      const b = img.data[i + 2] / 255;
      const a = img.data[i + 3] / 255;
      const outdoor = decodeOutdoorsMaskSample8(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]);
      return {
        r, g, b, a,
        luma: 0.2126 * r + 0.7152 * g + 0.0722 * b,
        outdoorStrength: outdoor,
      };
    }
    if (typeof document !== 'undefined') {
      if (!sampleCpuTextureAtSceneUv._canvas) {
        sampleCpuTextureAtSceneUv._canvas = document.createElement('canvas');
        sampleCpuTextureAtSceneUv._ctx = sampleCpuTextureAtSceneUv._canvas.getContext('2d', { willReadFrequently: true });
      }
      const c = sampleCpuTextureAtSceneUv._canvas;
      const ctx = sampleCpuTextureAtSceneUv._ctx;
      if (!ctx) return null;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(px, py, 1, 1).data;
      const outdoor = decodeOutdoorsMaskSample8(d[0], d[1], d[2], d[3]);
      return {
        r: d[0] / 255,
        g: d[1] / 255,
        b: d[2] / 255,
        a: d[3] / 255,
        luma: (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]) / 255,
        outdoorStrength: outdoor,
      };
    }
  } catch (_) {}
  return null;
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget} rt
 * @param {{ u: number, v: number }} bufUv
 * @returns {object|null}
 */
function sampleRtAtBufferUv(renderer, rt, bufUv) {
  if (!rt?.width || !bufUv) return null;
  const u = Math.max(0, Math.min(1, bufUv.u));
  const v = Math.max(0, Math.min(1, bufUv.v));
  const py = rt.height - 1 - Math.floor(v * Math.max(1, rt.height - 1));
  const px = Math.floor(u * Math.max(1, rt.width - 1));
  return compactPixel(readRtPixel(renderer, rt, px / Math.max(1, rt.width - 1), py / Math.max(1, rt.height - 1)));
}

/**
 * Foundry AmbientLight dim/bright are radii in grid units (not the probe's wide list radius).
 * @param {number} wx
 * @param {number} wy
 * @returns {object}
 */
function analyzeFoundryLightsAt(wx, wy) {
  const gridSize = Number(canvas?.grid?.size) || 100;
  const listR2 = (FOUNDRY_LIGHT_LIST_RADIUS_GRID * gridSize) ** 2;
  /** @type {object[]} */
  const all = [];
  /** @type {object[]} */
  const affectingAtProbe = [];

  for (const doc of getAuthoritativeAmbientLightDocuments()) {
    try {
      const lx = Number(doc.x);
      const ly = Number(doc.y);
      if (!Number.isFinite(lx) || !Number.isFinite(ly)) continue;
      const dx = lx - wx;
      const dy = ly - wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const config = doc.config ?? doc;
      const dimGrid = Number(config.dim ?? doc.dim ?? 0);
      const brightGrid = Number(config.bright ?? doc.bright ?? 0);
      const dimUnits = dimGrid * gridSize;
      const brightUnits = brightGrid * gridSize;
      const withinBright = brightUnits > 0 && dist <= brightUnits;
      const withinDim = dimUnits > 0 && dist <= dimUnits;
      const affectsProbe = withinDim || withinBright;
      const entry = {
        id: doc.id ?? doc._id ?? null,
        name: doc.name ?? null,
        x: lx,
        y: ly,
        distance: dist,
        hidden: !!doc.hidden,
        disabled: !!(config.disabled ?? doc.disabled),
        darkness: config.darkness ?? doc.darkness ?? null,
        dimGrid,
        brightGrid,
        dimRadiusUnits: dimUnits,
        brightRadiusUnits: brightUnits,
        withinDim,
        withinBright,
        affectsProbe,
        color: config.color ?? doc.color ?? null,
        negative: !!(config.negative ?? doc.negative),
      };
      if (dist * dist <= listR2) all.push(entry);
      if (affectsProbe) affectingAtProbe.push(entry);
    } catch (_) {}
  }
  all.sort((a, b) => a.distance - b.distance);
  affectingAtProbe.sort((a, b) => a.distance - b.distance);
  return {
    gridSize,
    listRadiusGrid: FOUNDRY_LIGHT_LIST_RADIUS_GRID,
    affectingAtProbe,
    nearbyListing: all,
    anyAffectsProbe: affectingAtProbe.length > 0,
  };
}

/**
 * Tiles whose bounds contain the world point (center-anchored Foundry tiles).
 * @param {number} wx
 * @param {number} wy
 * @param {number} activeFloorIndex
 * @returns {object[]}
 */
function findTilesAtWorld(wx, wy, activeFloorIndex) {
  /** @type {object[]} */
  const hits = [];
  const grid = Number(canvas?.grid?.size) || 100;
  const placeables = canvas?.tiles?.placeables ?? [];
  for (const placeable of placeables) {
    try {
      const doc = placeable?.document ?? placeable;
      if (!doc) continue;
      const tx = Number(doc.x);
      const ty = Number(doc.y);
      const tw = Number(doc.width ?? 1) * grid;
      const th = Number(doc.height ?? 1) * grid;
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) continue;
      const halfW = tw * 0.5;
      const halfH = th * 0.5;
      if (wx < tx - halfW || wx > tx + halfW || wy < ty - halfH || wy > ty + halfH) continue;
      const levels = readTileLevelsFlags(doc);
      const tex = doc.texture?.src ?? doc.img ?? placeable?.texture?.baseTexture?.resource?.url ?? null;
      hits.push({
        id: doc.id ?? null,
        name: doc.name ?? null,
        x: tx,
        y: ty,
        width: doc.width,
        height: doc.height,
        hidden: !!doc.hidden,
        alpha: Number(doc.alpha ?? 1),
        occlusionMode: doc.occlusion?.mode ?? null,
        levelsFlags: levels,
        textureSrc: typeof tex === 'string' ? tex.slice(-80) : null,
        sort: Number(doc.sort ?? placeable?.sort ?? 0),
      });
    } catch (_) {}
  }
  hits.sort((a, b) => (b.sort ?? 0) - (a.sort ?? 0));
  return hits;
}

/**
 * @param {object|null} fc
 * @returns {object}
 */
function snapshotEffectEnables(fc) {
  if (!fc) return {};
  return {
    lighting: resolveEffectEnabled(fc._lightingEffect),
    windowLight: resolveEffectEnabled(fc._windowLightEffect),
    water: resolveEffectEnabled(fc._waterEffect),
    bloom: resolveEffectEnabled(fc._bloomEffect),
    atmosphericFog: resolveEffectEnabled(fc._atmosphericFogEffect),
    colorCorrection: resolveEffectEnabled(fc._colorCorrectionEffect),
    filter: resolveEffectEnabled(fc._filterEffect),
    shadowManager: resolveEffectEnabled(fc._shadowManagerEffect),
  };
}

/**
 * @param {object} point
 * @returns {object}
 */
function buildAttribution(point) {
  const activeFi = point.location?.activeFloorIndex;
  const upper = point.pipeline?.perFloor?.find((f) => f.floorIndex === activeFi);
  const sceneL = upper?.scene?.luma ?? 0;
  const litL = upper?.lit?.luma ?? 0;
  const preL = point.grade?.preGradeHdr?.luma ?? 0;
  const dynL = point.lighting?.buffers?.stackedDynamicLightSceneUv?.luma
    ?? point.lighting?.buffers?.stackedDynamicLight?.luma ?? 0;
  const winL = windowLightRtLuma(point);
  const lights = point.lighting?.foundry?.affectingAtProbe ?? [];
  const tiles = point.tiles?.hits ?? [];

  /** @type {string} */
  let dominant = 'unknown';
  const reasons = [];

  if (upper?.scene?.a < 0.05) {
    dominant = 'see_through_upper_floor';
    reasons.push('Upper floor scene alpha≈0 — pixel shows lower floor / void.');
  } else if (sceneL > 0.2 && sceneL > litL * 0.85) {
    dominant = 'bright_tile_albedo';
    reasons.push(`Upper-floor bus albedo luma≈${sceneL.toFixed(3)} (pre-lighting) — likely day-bright tile art.`);
    if (tiles.length) {
      reasons.push(`Top tile: ${tiles[0].id} texture …${tiles[0].textureSrc ?? '?'}`);
    }
  } else if (dynL > 0.04 && lights.length === 0) {
    dominant = 'orphan_dynamic_light_buffer';
    reasons.push('Dynamic light buffer has energy but no Foundry light within dim radius — screen-space spill or stale RT.');
  } else if (lights.length > 0 && dynL > 0.02) {
    dominant = 'foundry_ambient_light_in_radius';
    reasons.push(`Within dim/bright radius of: ${lights.map((l) => l.id).join(', ')}`);
  } else if (winL > 0.02) {
    dominant = 'window_glow';
  } else if (wlProbeVerdictWouldEmit(point.windowLight?.verdict)) {
    dominant = 'window_glow_missing_despite_overlay';
    reasons.push('Window overlay would emit at click but windowLight RT luma≈0 — compose clip or RT wiring issue.');
  } else if (point.windowLight?.verdict === 'blocked') {
    dominant = 'window_glow_blocked';
    const blockers = point.windowLight?.blockers ?? [];
    if (blockers.length) reasons.push(`Window light blockers: ${blockers.join(', ')}`);
  } else if (preL < 0.03) {
    dominant = 'correctly_dark_pre_grade';
  }

  return { dominant, reasons };
}

/**
 * Best-effort luma from windowLight RT (screen-space buffer).
 * @param {object} point
 * @returns {number}
 */
function windowLightRtLuma(point) {
  const b = point.lighting?.buffers ?? {};
  return b.windowLightScreenUv?.luma
    ?? b.windowLight?.luma
    ?? b.windowLightSceneUv?.luma
    ?? 0;
}

/**
 * Minimal rebuild: probe verdict is `would_emit` (legacy probes used `should_emit`).
 * @param {string|undefined} verdict
 * @returns {boolean}
 */
function wlProbeVerdictWouldEmit(verdict) {
  return verdict === 'should_emit' || verdict === 'would_emit';
}

/**
 * @param {object} point
 * @returns {string[]}
 */
function buildWindowLightAnomalyFlags(point) {
  /** @type {string[]} */
  const flags = [];
  const wl = point.windowLight ?? null;
  const rtLuma = windowLightRtLuma(point);
  if (!wl) return flags;

  if (wlProbeVerdictWouldEmit(wl.verdict) && rtLuma < 0.008) {
    flags.push('window_overlay_would_emit_but_rt_dark');
  }
  if (wl.blockers?.includes('outdoor_at_destination')
    && (wl.gating?.outdoorAtDestinationWorld ?? wl.gating?.outdoorAtDestination ?? 1) > 0.45) {
    flags.push('window_light_outdoor_gated_at_click');
  } else if (wl.blockers?.includes('outdoor_at_destination')
    && wl.gating?.outdoorAtDestinationScreen != null
    && (wl.gating?.outdoorAtDestinationWorld ?? 0) <= 0.45) {
    flags.push('window_light_outdoor_gated_screen_only');
  }
  if (wl.blockers?.includes('ceiling_or_roof_blocked')) {
    flags.push('window_light_ceiling_roof_blocked');
  }
  if (wl.blockers?.includes('no_window_overlay_at_point')) {
    flags.push('window_light_no_overlay_at_point');
  }
  if (wl.blockers?.includes('overlay_hidden_wrong_floor')) {
    flags.push('window_light_overlay_hidden_wrong_floor');
  }
  if (wl.blockers?.includes('window_mask_empty_at_uv')) {
    flags.push('window_mask_empty_at_click_uv');
  }
  if (wl.blockers?.includes('night_factor_zero')) {
    flags.push('window_light_night_factor_zero');
  }
  if (wl.blockers?.includes('intensity_zero')) {
    flags.push('window_light_intensity_zero');
  }
  if (wl.blockers?.includes('effect_disabled')) {
    flags.push('window_light_effect_disabled');
  }
  if (wl.blockers?.includes('neutral_outdoors_mask')) {
    flags.push('window_light_neutral_outdoors_bound');
  }
  const rd = wl.renderDiagnostics;
  if (wlProbeVerdictWouldEmit(wl.verdict) && rtLuma < 0.008 && (rd?.rtMaxLuma ?? 0) < 0.002) {
    flags.push('window_light_rt_empty_grid_scan');
  }
  if (wlProbeVerdictWouldEmit(wl.verdict) && rtLuma < 0.008 && (rd?.rtMaxLuma ?? 0) > 0.02) {
    flags.push('window_light_rt_energy_off_click');
  }
  if (rd?.visibleOverlayMeshes === 0 && (rd?.totalOverlays ?? 0) > 0) {
    flags.push('window_light_overlays_all_hidden');
  }
  const pa = wl.pipelineAnalysis;
  const blit = pa?.blitSimulation;
  if (wlProbeVerdictWouldEmit(wl.verdict) && blit?.discardReason) {
    flags.push(`window_blt_discard_${blit.discardReason}`);
  }
  if (wl.blockers?.includes('mask_uv_shift_discard')) {
    flags.push('window_mask_uv_shift_discard');
  }
  if (wl.blockers?.includes('env_multiplier_zero')) {
    flags.push('window_env_multiplier_zero');
  }
  if (wlProbeVerdictWouldEmit(wl.verdict) && (blit?.estimatedOutputLuma ?? 0) > 0.05 && rtLuma < 0.008) {
    flags.push('window_blt_cpu_expects_gpu_dark');
  }
  if (pa?.sceneUvConsistency?.mismatch) {
    flags.push('window_scene_uv_screen_world_mismatch');
  }
  if (rd?.uniformSnapshot && rd.uniformSnapshot.blitSharesSceneUniforms === false) {
    flags.push('window_blt_uniforms_not_shared');
  }
  const intExp = point.grade?.ccDebug?.evaluatedGrade?.interior?.exposure;
  if (wlProbeVerdictWouldEmit(wl.verdict) && Number.isFinite(intExp) && intExp < -1.5 && rtLuma < 0.02) {
    flags.push('window_light_may_be_grade_crushed');
  }
  if (rtLuma > 0.02 && wl.verdict === 'blocked') {
    flags.push('window_light_rt_has_energy_despite_blockers');
  }
  return flags;
}

/**
 * @param {object} point
 * @returns {object|null}
 */
function sampleWindowLightProbe(wx, wy, floorIdx) {
  const fc = resolveFloorCompositorV2();
  const wle = fc?._windowLightEffect ?? null;
  if (!wle) {
    return { error: 'no-floor-compositor-or-window-light-effect' };
  }
  if (typeof wle.probeAtWorld !== 'function') {
    return {
      error: 'window-light-probeAtWorld-missing',
      hint: 'Full reload Map Shine — WindowLightEffectV2.probeAtWorld not on the live instance.',
    };
  }
  try {
    return wle.probeAtWorld(wx, wy, { floorIdx });
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/**
 * @param {object} point
 * @returns {string[]}
 */
function buildWindowLightHints(point) {
  /** @type {string[]} */
  const hints = [];
  const wl = point.windowLight;
  if (!wl || wl.error) return hints;
  for (const h of wl.hints ?? []) hints.push(h);

  const rtLuma = windowLightRtLuma(point);
  if (wlProbeVerdictWouldEmit(wl.verdict) && rtLuma < 0.008) {
    hints.push('Overlay would emit but windowLight RT is dark — check drawWindowLightPass wiring or LightingEffectV2 compose merge (uWindowEmissiveGain).');
  }
  if (wl.overlaysAtPoint?.length === 0 && (wl.nearbyOverlays?.length ?? 0) > 0) {
    const n = wl.nearbyOverlays[0];
    hints.push(`Click missed tile footprint — nearest overlay "${n.tileId}" on floor ${n.floorIndex} (${n.distance?.toFixed?.(0) ?? '?'} units away).`);
  }
  const primary = wl.overlaysAtPoint?.[0];
  if (primary?.blockers?.includes('outdoor_at_mask_source')) {
    hints.push('_Outdoors reads outdoor at the window mask sample position (sun/rain offset) — glow suppressed at source.');
  }
  return hints;
}

/**
 * @param {object} point
 * @returns {object}
 */
function summarizeWindowLight(point) {
  const wl = point.windowLight ?? {};
  const rtLuma = windowLightRtLuma(point) || null;
  const rd = wl.renderDiagnostics ?? null;
  const pa = wl.pipelineAnalysis ?? null;
  const primary = wl.overlaysAtPoint?.[0] ?? null;
  const blit = pa?.blitSimulation ?? null;
  const grade = point.grade?.ccDebug?.evaluatedGrade?.interior ?? null;
  return {
    verdict: wl.verdict ?? 'unknown',
    rtLuma,
    rtMaxLuma: rd?.rtMaxLuma ?? null,
    rtMaxAt: rd?.rtMaxAt ?? null,
    rtAtClick: rd?.rtAtClick ?? null,
    renderDiagnostics: rd,
    pipelineAnalysis: pa,
    blitDiscardReason: blit?.discardReason ?? null,
    blitEstimatedLuma: blit?.estimatedOutputLuma ?? null,
    sceneUvMismatch: pa?.sceneUvConsistency?.mismatch ?? null,
    interiorGradeExposure: grade?.exposure ?? null,
    composeWindowAtScreen: pa?.composeBuffers?.windowLightAtScreen?.luma ?? null,
    composeFoundryAtScreen: pa?.composeBuffers?.lightSourcesAtScreen?.luma ?? null,
    blockers: wl.blockers ?? [],
    outdoorAtDestination: wl.gating?.outdoorAtDestination ?? null,
    indoorWeightAtDestination: wl.gating?.indoorWeightAtDestination ?? null,
    ceilingMul: wl.occlusion?.ceilingMul ?? null,
    overlayCountAtPoint: wl.overlaysAtPoint?.length ?? 0,
    visibleOverlayMeshes: rd?.visibleOverlayMeshes ?? null,
    maskReadyOverlays: rd?.maskReadyOverlays ?? null,
    primaryOverlay: primary ? {
      tileId: primary.tileId,
      floorIndex: primary.floorIndex,
      wouldEmit: primary.wouldEmit,
      maskLuma: primary.maskSample?.luma ?? null,
      maskAlpha: primary.maskSample?.a ?? null,
      blitMaskUv: blit?.maskUv ?? null,
      blockers: primary.blockers ?? [],
    } : null,
    hints: buildWindowLightHints(point),
  };
}

/**
 * @param {object} point
 * @returns {string[]}
 */
function buildAnomalyFlags(point) {
  /** @type {string[]} */
  const flags = [];
  const upper = point.pipeline?.perFloor?.find((f) => f.floorIndex === point.location?.activeFloorIndex);
  if (upper?.litFromCache) flags.push('upper_floor_lit_from_stacked_cache');
  if (upper?.scene?.luma > 0.15 && (point.lighting?.foundry?.anyAffectsProbe !== true)) {
    flags.push('bright_scene_albedo_without_foundry_light_at_probe');
  }
  if ((point.lighting?.buffers?.stackedDynamicLight?.luma ?? 0) > 0.05
    && !point.lighting?.foundry?.anyAffectsProbe) {
    flags.push('dynamic_light_buffer_without_light_in_dim_radius');
  }
  if (point.masks?.stackedOutdoors?.alpha === 0 && point.masks?.estimatedCcOutdoorStrength === 1) {
    flags.push('stacked_outdoors_zero_alpha_decodes_as_outdoor');
  }
  if (point.masks?.ccBoundOutdoors?.sample == null && point.masks?.stackedOutdoors) {
    flags.push('cc_bound_outdoors_sample_missing_use_stackedOutdoors');
  }
  if (point.masks?.stackedOutdoors?.uniformIndoorFill === true) {
    flags.push('stacked_uniform_indoor_fill');
  }
  if (point.masks?.outdoorsSources?.bundleMetaTex && !point.masks?.outdoorsSources?.getFloorTexture) {
    flags.push('bundle_outdoors_not_promoted_to_gpu');
  }
  if (point.masks?.outdoorsSources?.gpuRepairNeeded === true) {
    flags.push('gpu_mask_repair_needed');
  }
  flags.push(...buildWindowLightAnomalyFlags(point));
  return flags;
}

/**
 * @param {object} point
 * @returns {object[]}
 */
function buildContributors(point) {
  /** @type {{ id: string, luma: number, note: string }[]} */
  const list = [];
  const push = (id, luma, note) => {
    if (!Number.isFinite(luma)) return;
    list.push({ id, luma: Number(luma), note });
  };

  const pg = point.grade?.preGradeHdr;
  push('pre_grade_hdr', pg?.luma, 'HDR after water/fog/bloom, before Camera Grade');

  const sdl = point.lighting?.buffers?.stackedDynamicLight;
  push('stacked_dynamic_light', sdl?.luma, 'Foundry lights max-blend buffer (CC local override)');

  const win = point.lighting?.buffers?.windowLight;
  push('window_glow', win?.luma, 'WindowLightEffectV2 accumulation');

  const dyn = point.lighting?.buffers?.stackedDynamicLightSceneUv
    ?? point.lighting?.buffers?.stackedDynamicLight;
  push('stacked_dynamic_light_scene_uv', dyn?.luma, 'Dynamic light buffer at scene UV');

  const dynCc = point.lighting?.buffers?.stackedDynamicLight;
  push('stacked_dynamic_light_cc_uv', dynCc?.luma, 'Dynamic light buffer at CC view-bound UV');

  for (const pl of point.pipeline?.perFloor ?? []) {
    push(`floor_${pl.floorIndex}_scene`, pl.scene?.luma, 'Bus albedo (pre lighting)');
    push(`floor_${pl.floorIndex}_lit`, pl.lit?.luma, 'Post-lighting RT');
    push(`floor_${pl.floorIndex}_dynamic`, pl.dynamicLight?.luma, 'Per-floor dynamic light RT at probe UV');
    push(`floor_${pl.floorIndex}_gain`, pl.estimatedLightingGain, 'lit.luma / scene.luma');
  }

  const wIn = point.water?.inside;
  if (Number(wIn) > 0.05) {
    push('water_inside', wIn, 'Water mask strength at probe');
  }

  list.sort((a, b) => b.luma - a.luma);
  return list;
}

/**
 * @param {object[]} points
 * @param {object} comparison
 */
function buildHypotheses(points, comparison) {
  /** @type {string[]} */
  const hypotheses = [];
  if (points.length < 2) return hypotheses;

  const ranked = comparison.rankedByPreGradeLuma ?? [];
  const brightest = ranked[0];
  const dimmest = ranked[ranked.length - 1];
  if (brightest && dimmest && brightest !== dimmest) {
    const bPt = points.find((p) => p.label === brightest);
    const dPt = points.find((p) => p.label === dimmest);
    const pairKey = `${brightest}_vs_${dimmest}`;
    const delta = comparison.pairwise?.[pairKey];
    if (delta?.preGradeLumaDelta > 0.008) {
      hypotheses.push(
        `Point ${brightest} is brighter pre-grade than ${dimmest} (Δluma≈${delta.preGradeLumaDelta.toFixed(4)}) — look at pre-CC sources, not Camera Grade split alone.`,
      );
    }
    if (bPt?.lighting?.foundry?.anyAffectsProbe && !dPt?.lighting?.foundry?.anyAffectsProbe) {
      hypotheses.push(`Point ${brightest} is inside a Foundry AmbientLight dim/bright radius; ${dimmest} is not.`);
    } else if (bPt?.lighting?.buffers?.stackedDynamicLight?.luma > 0.02
      && (dPt?.lighting?.buffers?.stackedDynamicLight?.luma ?? 0) < 0.01
      && !bPt?.lighting?.foundry?.anyAffectsProbe) {
      hypotheses.push(`Point ${brightest} has dynamic-light buffer energy without any Foundry light at probe — possible buffer spill or wrong UV.`);
    }
    if (bPt?.lighting?.buffers?.windowLight?.luma > 0.02
      && (dPt?.lighting?.buffers?.windowLight?.luma ?? 0) < 0.01) {
      hypotheses.push(`Point ${brightest} has window-glow buffer energy; ${dimmest} does not.`);
    }
    const bWl = bPt?.windowLight?.summary;
    const dWl = dPt?.windowLight?.summary;
    if (bWl?.verdict === 'blocked' && wlProbeVerdictWouldEmit(dWl?.verdict)) {
      hypotheses.push(`Point ${dimmest} has a window overlay that would emit; ${brightest} is blocked (${(bWl.blockers ?? []).slice(0, 2).join(', ') || 'see blockers'}).`);
    } else if (wlProbeVerdictWouldEmit(bWl?.verdict) && dWl?.verdict === 'blocked') {
      hypotheses.push(`Point ${brightest} window overlay would emit; ${dimmest} blocked (${(dWl.blockers ?? []).slice(0, 2).join(', ') || 'see blockers'}).`);
    }
    const bVis = bPt?.pipeline?.perFloor?.find((f) => f.floorIndex === bPt.location?.activeFloorIndex);
    const dVis = dPt?.pipeline?.perFloor?.find((f) => f.floorIndex === dPt.location?.activeFloorIndex);
    if (bVis?.scene?.luma > (dVis?.scene?.luma ?? 0) * 1.4) {
      hypotheses.push(`Point ${brightest} has warmer/brighter upper-floor scene albedo — tile art or emissive content.`);
    }
    if ((bPt?.water?.inside ?? 0) > 0.1 && (dPt?.water?.inside ?? 0) < 0.05) {
      hypotheses.push(`Point ${brightest} overlaps water mask; ${dimmest} does not — water murk/spec/bloom may contribute.`);
    }
    const upperB = bPt?.pipeline?.perFloor?.slice(-1)[0];
    const upperD = dPt?.pipeline?.perFloor?.slice(-1)[0];
    if (upperB?.scene?.a < 0.5 && upperD?.scene?.a > 0.85) {
      hypotheses.push(`Point ${brightest} has low upper-floor alpha (see-through) vs ${dimmest} — composite may reveal lower floors/water.`);
    }
    const bOut = bPt?.outdoors?.classification;
    const dOut = dPt?.outdoors?.classification;
    if (bOut && dOut && bOut !== dOut && bOut !== 'unknown' && dOut !== 'unknown') {
      hypotheses.push(
        `Point ${brightest} is ${bOut}; ${dimmest} is ${dOut} — _Outdoors / CC classification differs (Δoutdoor≈${(delta?.outdoorStrengthDelta ?? 0).toFixed(3)}).`,
      );
    }
  }

  const ld = points[0]?.lighting?.director;
  if (ld && Number(ld.calendarDayWeight) > 0.05) {
    const anyOutdoor = points.some((p) => p.outdoors?.classification === 'outdoor');
    if (anyOutdoor) {
      hypotheses.push(`calendarDayWeight=${ld.calendarDayWeight} — day ambient slice may still lift outdoor pixels.`);
    } else {
      hypotheses.push(`calendarDayWeight=${ld.calendarDayWeight} — day ambient slice active (no outdoor-classified points in pick).`);
    }
  }

  const cc0 = points[0]?.grade?.ccDebug?.evaluatedGrade?.global;
  const cc1 = points[1]?.grade?.ccDebug?.evaluatedGrade?.global;
  if (cc0 && cc1
    && Math.abs((cc0.exposure ?? 0) - (cc1.exposure ?? 0)) < 0.01
    && hypotheses.length > 0) {
    hypotheses.push('Camera Grade global exposure/tint match across points — brightness difference is almost certainly pre-grade.');
  }

  return hypotheses;
}

/**
 * @param {object[]} points
 * @returns {object}
 */
export function buildComparison(points) {
  const lumaOf = (pt, path) => {
    const parts = path.split('.');
    let cur = pt;
    for (const p of parts) {
      cur = cur?.[p];
      if (cur == null) return null;
    }
    return Number.isFinite(cur?.luma) ? cur.luma : (Number.isFinite(cur) ? cur : null);
  };

  const rankedByPreGradeLuma = [...points]
    .filter((p) => Number.isFinite(p.grade?.preGradeHdr?.luma))
    .sort((a, b) => (b.grade.preGradeHdr.luma - a.grade.preGradeHdr.luma))
    .map((p) => p.label);

  /** @type {Record<string, object>} */
  const pairwise = {};
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const a = points[i];
      const b = points[j];
      const key = `${b.label}_vs_${a.label}`;
      pairwise[key] = {
        preGradeLumaDelta: (b.grade?.preGradeHdr?.luma ?? 0) - (a.grade?.preGradeHdr?.luma ?? 0),
        stackedLightLumaDelta:
          (b.lighting?.buffers?.stackedDynamicLight?.luma ?? 0)
          - (a.lighting?.buffers?.stackedDynamicLight?.luma ?? 0),
        windowLightLumaDelta:
          (b.lighting?.buffers?.windowLight?.luma ?? 0) - (a.lighting?.buffers?.windowLight?.luma ?? 0),
        floor0LitLumaDelta: (() => {
          const f0a = a.pipeline?.perFloor?.find((f) => f.floorIndex === 0);
          const f0b = b.pipeline?.perFloor?.find((f) => f.floorIndex === 0);
          return (f0b?.lit?.luma ?? 0) - (f0a?.lit?.luma ?? 0);
        })(),
        waterInsideDelta: (b.water?.inside ?? 0) - (a.water?.inside ?? 0),
        outdoorStrengthDelta:
          (b.outdoors?.effectiveOutdoorStrength ?? 0) - (a.outdoors?.effectiveOutdoorStrength ?? 0),
      };
    }
  }

  const comparison = { rankedByPreGradeLuma, pairwise, hypotheses: [], attributions: {} };
  for (const pt of points) {
    comparison.attributions[pt.label] = pt.attribution ?? null;
  }
  comparison.hypotheses = buildHypotheses(points, comparison);
  return comparison;
}

/**
 * @param {number} wx
 * @param {number} wy
 * @param {{ label?: string, floorIdx?: number }} [options]
 * @returns {object}
 */
export function sampleScenePixelAt(wx, wy, options = {}) {
  const label = options.label ?? 'point';
  const ms = globalThis.MapShine ?? {};
  const compositor = ms.sceneComposer?._sceneMaskCompositor ?? null;
  const renderer = ms.renderer ?? null;
  const fc = resolveFloorCompositorV2();
  const cc = fc?._colorCorrectionEffect ?? null;
  const le = fc?._lightingEffect ?? null;
  const we = fc?._waterEffect ?? null;
  const sm = fc?._shadowManagerEffect ?? null;
  const sr = canvas?.dimensions?.sceneRect ?? null;

  const point = {
    label,
    location: { worldX: wx, worldY: wy, activeFloorIndex: null, activeFloorKey: null, sceneUv: null },
    masks: {},
    outdoors: null,
    pipeline: { perFloor: [], visibleFloorIndices: [], taps: {} },
    lighting: { director: null, params: null, buffers: {}, foundry: null },
    tiles: { hits: [] },
    effects: {},
    water: {},
    windowLight: null,
    grade: {},
    attribution: null,
    anomalies: [],
    contributors: [],
    error: null,
  };

  if (!compositor || !renderer || !sr) {
    point.error = 'no-compositor-renderer-or-sceneRect';
    return point;
  }

  const floors = ms.floorStack?.getFloors?.() ?? [];
  const idx = Number.isFinite(Number(options.floorIdx))
    ? Number(options.floorIdx)
    : Number(ms.floorStack?.getActiveFloor?.()?.index ?? 0);
  point.location.activeFloorIndex = idx;
  const floor = floors.find((f) => Number(f?.index) === idx) ?? null;
  const floorKey = floor?.compositorKey != null ? String(floor.compositorKey) : null;
  point.location.activeFloorKey = floorKey;
  if (!floorKey) {
    point.error = 'no-floor-key';
    return point;
  }

  const uvX = (Number(wx) - sr.x) / sr.width;
  const uvY = 1.0 - ((Number(wy) - sr.y) / sr.height);
  point.location.sceneUv = { u: uvX, v: uvY };

  point.masks.outdoorsSources = {
    metaFile: compositor.getMaskTextureForFloor?.(floorKey, 'outdoors')?.uuid ?? null,
    bundleMetaTex: compositor.getMaskTextureForFloor?.(floorKey, 'outdoors')?.uuid ?? null,
    gpuCache: compositor._floorCache?.get(floorKey)?.get('outdoors')?.texture?.uuid ?? null,
    floorAlphaGpu: compositor._floorCache?.get(floorKey)?.get('floorAlpha')?.texture?.uuid ?? null,
    getFloorTexture: compositor.getFloorTexture?.(floorKey, 'outdoors')?.uuid ?? null,
    gpuHasAuthoring: compositor._outdoorsGpuMaskHasAuthoring?.(
      floorKey,
      compositor._floorCache?.get(floorKey)?.get('outdoors'),
    ) ?? null,
    gpuRepairNeeded: compositor.needsGpuSceneSpaceMaskRepair?.(
      floorKey,
      canvas?.scene ?? null,
      ms.activeLevelContext ?? null,
    ) ?? null,
    syncRoute: ms.__v2OutdoorsRoute ?? null,
    windowLightOutdoorsTex: fc?._windowLightEffect?._outdoorsMask?.uuid ?? null,
    windowLightUsesNeutral:
      fc?._windowLightEffect?._outdoorsMask?.name === 'MapShineNeutralOutdoorsMask',
  };

  const floorAlphaRt = compositor._floorCache?.get(floorKey)?.get('floorAlpha') ?? null;
  point.masks.floorAlphaGpu = compactPixel(readRtPixel(renderer, floorAlphaRt, uvX, uvY));
  const bundleMetaTex = compositor.getMaskTextureForFloor?.(floorKey, 'outdoors') ?? null;
  const getFloorTex = getBandOutdoorsMask(floorKey, canvas?.scene ?? null, compositor) ?? null;
  if (bundleMetaTex) {
    const cpuSample = sampleCpuTextureAtSceneUv(bundleMetaTex, uvX, uvY);
    point.masks.bundleMetaOutdoors = {
      texUuid: bundleMetaTex.uuid ?? null,
      sampleAtSceneUv: cpuSample ? compactPixel(cpuSample) : { error: 'cpu-read-failed' },
      outdoorStrength: cpuSample?.outdoorStrength ?? null,
      note: 'bundle mask CPU sample at scene UV (file/meta texture — not GPU RT)',
    };
  }

  const ccBound = sampleCcBoundOutdoors(renderer, compositor, cc, point.location.sceneUv);
  point.masks.ccBoundOutdoors = ccBound;
  let ccS = ccBound?.sample;
  if (!ccS && getFloorTex && getFloorTex !== bundleMetaTex) {
    const cpuSample = sampleCpuTextureAtSceneUv(getFloorTex, uvX, uvY);
    if (cpuSample) {
      ccS = compactPixel(cpuSample);
      point.masks.ccBoundOutdoors.sample = ccS;
      point.masks.ccBoundOutdoors.sampleSource = 'getFloorTexture-cpu-fallback';
      point.masks.ccBoundOutdoors.outdoorStrength = cpuSample.outdoorStrength;
    }
  } else if (!ccS && bundleMetaTex) {
    const cpuSample = sampleCpuTextureAtSceneUv(bundleMetaTex, uvX, uvY);
    if (cpuSample) {
      ccS = compactPixel(cpuSample);
      point.masks.ccBoundOutdoors.sample = ccS;
      point.masks.ccBoundOutdoors.sampleSource = 'bundleMeta-cpu-fallback';
      point.masks.ccBoundOutdoors.outdoorStrength = cpuSample.outdoorStrength;
    }
  }

  const outdoorsRt = compositor._floorCache?.get(floorKey)?.get('outdoors') ?? null;
  const skyReachRt = compositor._floorCache?.get(floorKey)?.get('skyReach') ?? null;
  point.masks.floorGpuOutdoors = compactPixel(readRtPixel(renderer, outdoorsRt, uvX, uvY));
  const skyPx = readRtPixel(renderer, skyReachRt, uvX, uvY);
  if (skyPx && !skyPx.error) {
    point.masks.skyReach = { value: skyPx.r, alpha: skyPx.a };
    const reach = skyPx.a > 0.5 ? skyPx.r : 1;
    const outdoorVis = (point.masks.estimatedCcOutdoorStrength ?? 1) >= 0.5 ? 1 : 0;
    point.masks.estimatedOutdoorAtmosphereWeight = outdoorVis * reach;
  }

  try {
    const postDiag = ms.__ccPostMergeMaskDiag ?? null;
    let stackedRt = null;
    const boundUuid = postDiag?.outdoorsTexUuid ?? null;
    if (boundUuid && compositor._stackedOutdoorsRtA?.texture?.uuid === boundUuid) {
      stackedRt = compositor._stackedOutdoorsRtA;
    } else if (boundUuid && compositor._stackedOutdoorsRtB?.texture?.uuid === boundUuid) {
      stackedRt = compositor._stackedOutdoorsRtB;
    }
    if (stackedRt) {
      const sp = readRtPixel(renderer, stackedRt, uvX, uvY);
      const stackedDiag = compositor.diagnoseStackedOutdoorsRt?.(stackedRt) ?? null;
      if (sp && !sp.error) {
        point.masks.stackedOutdoors = {
          strength: sp.r,
          alpha: sp.a,
          ccOutdoorStrength: decodeCcOutdoorStrength(sp.r, sp.g, sp.b, sp.a),
          ccIndoorWeight: estimateCcIndoorWeight(sp.r, sp.g, sp.b, sp.a),
          pixelType: sp.pixelType,
          uniformIndoorFill: stackedDiag?.uniformIndoorFill ?? null,
          hasAuthoring: stackedDiag?.hasAuthoring ?? null,
        };
        if (!ccS || ccS.error) {
          ccS = compactPixel(sp);
          point.masks.ccBoundOutdoors.sample = ccS;
          point.masks.ccBoundOutdoors.sampleSource = 'stackedOutdoorsRt-fallback';
        }
      }
    }
  } catch (e) {
    point.masks.stackedOutdoors = { error: String(e?.message || e) };
  }
  if (ccS && !ccS.error) {
    point.masks.estimatedCcOutdoorStrength = decodeCcOutdoorStrength(ccS.r, ccS.g, ccS.b, ccS.a);
    point.masks.estimatedIndoorWeight = estimateCcIndoorWeight(ccS.r, ccS.g, ccS.b, ccS.a);
    point.masks.outdoorsStrength = ccS.r;
    point.masks.outdoorsAlpha = ccS.a;
  } else if (point.masks.bundleMetaOutdoors?.outdoorStrength != null) {
    const os = point.masks.bundleMetaOutdoors.outdoorStrength;
    point.masks.estimatedCcOutdoorStrength = os;
    point.masks.estimatedIndoorWeight = Math.max(0, 1 - os);
    point.masks.outdoorsStrength = os;
    point.masks.outdoorsAlpha = 1;
  }

  try {
    const ld = LightingDirector.get?.() ?? null;
    point.lighting.director = ld ? {
      hour: ld.hour,
      calendarDayWeight: ld.calendarDayWeight,
      masterDarkness: ld.masterDarkness,
    } : null;
  } catch (_) {}

  if (le?.params) {
    point.lighting.params = {
      enabled: le.params.enabled,
      ambientDayScale: le.params.ambientDayScale,
      ambientNightScale: le.params.ambientNightScale,
      minIlluminationScale: le.params.minIlluminationScale,
      lightIntensity: le.params.lightIntensity,
    };
  }

  const bufUv = worldToCcBufferUv(wx, wy, cc);
  const screenUv = worldToScreenBufferUv(wx, wy, fc, idx);
  const stackedRt = (le?._stackedLightActive && le?._stackedLightLayerCount > 0 && le?._stackedLightResult)
    ? le._stackedLightResult
    : le?._lightRT;
  if (stackedRt && bufUv) {
    point.lighting.buffers.stackedDynamicLight = sampleRtAtBufferUv(renderer, stackedRt, bufUv);
  }
  if (stackedRt) {
    point.lighting.buffers.stackedDynamicLightSceneUv = compactPixel(
      readRtPixel(renderer, stackedRt, uvX, uvY),
    );
  }
  if (le?._lightRT) {
    point.lighting.buffers.lastFloorDynamicLight = bufUv
      ? sampleRtAtBufferUv(renderer, le._lightRT, bufUv)
      : null;
    point.lighting.buffers.lastFloorDynamicLightSceneUv = compactPixel(
      readRtPixel(renderer, le._lightRT, uvX, uvY),
    );
  }
  const wleEmitRt = window.MapShine?.effectComposer?._floorCompositorV2?._windowLightEffect?._emitRT
    ?? null;
  if (wleEmitRt) {
    const wlScreenUv = (screenUv?.onScreen ? screenUv : bufUv);
    point.lighting.buffers.windowLight = wlScreenUv
      ? sampleRtAtBufferUv(renderer, wleEmitRt, wlScreenUv)
      : null;
    point.lighting.buffers.windowLightSceneUv = compactPixel(
      readRtPixel(renderer, wleEmitRt, uvX, uvY),
    );
    if (screenUv?.onScreen) {
      point.lighting.buffers.windowLightScreenUv = sampleRtAtBufferUv(renderer, wleEmitRt, screenUv);
    }
  }
  if (le?._lightRT && screenUv?.onScreen) {
    point.lighting.buffers.foundryLightSources = sampleRtAtBufferUv(renderer, le._lightRT, screenUv);
  }
  if (le?._darknessRT && screenUv?.onScreen) {
    point.lighting.buffers.darknessMask = sampleRtAtBufferUv(renderer, le._darknessRT, screenUv);
  }

  const smCombinedRt = sm?._combinedRT ?? null;
  if (smCombinedRt) {
    point.lighting.buffers.combinedShadow = compactPixel(readRtPixel(renderer, smCombinedRt, uvX, uvY));
  }

  point.lighting.foundry = analyzeFoundryLightsAt(wx, wy);
  point.lighting.canvasEnvironment = (() => {
    try {
      const env = canvas?.environment ?? null;
      return env ? {
        darknessLevel: env.darknessLevel ?? null,
        ambientBrightest: env.ambientBrightest ?? null,
        ambientDarkness: env.ambientDarkness ?? null,
      } : null;
    } catch (_) {
      return null;
    }
  })();

  point.tiles.hits = findTilesAtWorld(wx, wy, idx);
  point.effects = snapshotEffectEnables(fc);

  const diag = ms.__v2PerLevelDiag ?? null;
  const vis = Array.isArray(diag?.visibleFloors) ? diag.visibleFloors : [];
  point.pipeline.visibleFloorIndices = vis.map((f) => Number(f?.index));
  const finals = Array.isArray(diag?.levelFinalRTs) ? diag.levelFinalRTs : [];
  const lits = Array.isArray(diag?.levelLitRTs) ? diag.levelLitRTs : [];
  const scenes = Array.isArray(diag?.levelSceneRTs) ? diag.levelSceneRTs : [];
  const dynLights = Array.isArray(diag?.levelDynamicLightRTs) ? diag.levelDynamicLightRTs : [];
  const litCached = Array.isArray(diag?.levelPerFloorLitCached) ? diag.levelPerFloorLitCached : [];

  for (let i = 0; i < vis.length && i < scenes.length; i++) {
    const floorIndex = Number(vis[i]?.index);
    const scenePx = compactPixel(readRtPixel(renderer, scenes[i], uvX, uvY));
    const litPx = lits[i] ? compactPixel(readRtPixel(renderer, lits[i], uvX, uvY)) : null;
    const finalPx = finals[i] ? compactPixel(readRtPixel(renderer, finals[i], uvX, uvY)) : null;
    const dynPx = dynLights[i] ? compactPixel(readRtPixel(renderer, dynLights[i], uvX, uvY)) : null;
    const sceneLuma = scenePx?.luma ?? 0;
    const litLuma = litPx?.luma ?? 0;
    const gain = sceneLuma > 1e-5 ? litLuma / sceneLuma : null;
    const fk = vis[i]?.compositorKey != null ? String(vis[i].compositorKey) : null;
    let floorOutdoors = null;
    if (fk) {
      const ort = compositor._floorCache?.get(fk)?.get('outdoors') ?? null;
      floorOutdoors = compactPixel(readRtPixel(renderer, ort, uvX, uvY));
    }
    point.pipeline.perFloor.push({
      floorIndex,
      floorKey: fk,
      scene: scenePx,
      lit: litPx,
      final: finalPx,
      dynamicLight: dynPx,
      outdoors: floorOutdoors,
      estimatedLightingGain: gain,
      litFromCache: litCached[i] === true,
      litMatchesFinal: !!(lits[i] && finals[i] && lits[i] === finals[i]),
    });
  }

  const hdrRt = diag?.hdrScenePreGradeRT ?? null;
  const mergedRt = diag?.mergedFinalRT ?? fc?._postA ?? null;
  point.pipeline.taps = {
    hdrPreGrade: compactPixel(readRtPixel(renderer, hdrRt, uvX, uvY)),
    mergedFinal: compactPixel(readRtPixel(renderer, mergedRt, uvX, uvY)),
  };
  point.grade.preGradeHdr = point.pipeline.taps.hdrPreGrade;
  point.grade.ccDebug = ms.__ccPostMergeDiag ?? cc?.getDebugState?.() ?? null;
  point.grade.outdoorsRoute = ms.__v2OutdoorsRoute?.main ?? null;
  point.grade.estimatedIndoorWeight = point.masks.estimatedIndoorWeight ?? null;
  point.grade.estimatedOutdoorAtmosphereWeight = point.masks.estimatedOutdoorAtmosphereWeight ?? null;
  const pg = point.grade.preGradeHdr;
  point.grade.hueHint = pg
    ? (pg.r > pg.b * 1.15 && pg.r > 0.02
      ? 'warm-or-orange-pre-cc'
      : (pg.b > pg.r * 1.15 ? 'blue-pre-cc' : 'neutral-pre-cc'))
    : null;

  try {
    const viewedIdx = idx;
    const dataFloor = typeof we?._resolveWaterFloorForView === 'function'
      ? we._resolveWaterFloorForView(viewedIdx)
      : (Number.isFinite(Number(we?._activeFloorIndex)) ? Number(we._activeFloorIndex) : -1);
    point.water.dataFloorIndex = dataFloor;
    point.water.postMerge = sceneFloorCountGt1(ms);
    const waterFloor = floors.find((f) => Number(f?.index) === dataFloor) ?? null;
    const waterKey = waterFloor?.compositorKey != null ? String(waterFloor.compositorKey) : null;
    if (waterKey) {
      const waterRt = compositor._floorCache?.get(waterKey)?.get('water') ?? null;
      const wPx = readRtPixel(renderer, waterRt, uvX, uvY);
      if (wPx && !wPx.error) {
        point.water.maskSample = compactPixel(wPx);
        point.water.inside = Math.max(wPx.r, wPx.g, wPx.b) * (wPx.a > 0.01 ? 1 : 0);
      }
    }
    const occRt = diag?.waterOccluderRT ?? fc?._waterOccluderRT ?? null;
    if (occRt) {
      point.water.occluderAlpha = compactPixel(readRtPixel(renderer, occRt, uvX, uvY))?.a ?? null;
    }
    point.water.bgAlphaMaskBound = !!ms.__frameWaterBgAlphaMaskTex;
    point.water.waterShelterFloorKey = fc?._waterShelterOutdoorsFloorKey ?? null;
  } catch (_) {}

  point.outdoors = summarizeOutdoors(point);
  point.windowLight = sampleWindowLightProbe(wx, wy, idx);
  if (point.windowLight && !point.windowLight.error) {
    point.windowLight.summary = summarizeWindowLight(point);
  }
  point.contributors = buildContributors(point);
  point.attribution = buildAttribution(point);
  point.anomalies = buildAnomalyFlags(point);
  return point;
}

/**
 * @param {object} ms
 * @returns {boolean}
 */
function sceneFloorCountGt1(ms) {
  const n = ms.floorStack?.getFloors?.()?.length ?? 0;
  return n > 1;
}

/**
 * @param {object[]} points
 * @param {{ requestedCount?: number }} [options]
 * @returns {object}
 */
export function buildScenePixelProbeReport(points, options = {}) {
  const ms = globalThis.MapShine ?? {};
  let ld = null;
  try { ld = LightingDirector.get?.() ?? null; } catch (_) {}

  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    scene: {
      id: canvas?.scene?.id ?? null,
      name: canvas?.scene?.name ?? null,
      activeFloorIndex: Number(ms.floorStack?.getActiveFloor?.()?.index ?? 0),
      visibleFloorIndices: Array.isArray(ms.__v2PerLevelDiag?.visibleFloors)
        ? ms.__v2PerLevelDiag.visibleFloors.map((f) => Number(f?.index))
        : [],
      sceneFloorCount: ms.floorStack?.getFloors?.()?.length ?? 0,
      hour: ld?.hour ?? null,
      calendarDayWeight: ld?.calendarDayWeight ?? null,
      masterDarkness: ld?.masterDarkness ?? null,
    },
    pick: {
      requestedCount: options.requestedCount ?? points.length,
      actualCount: points.length,
      labels: points.map((p) => p.label),
    },
    points,
    comparison: buildComparison(points),
  };
  return report;
}

/**
 * @param {object} report
 * @returns {string}
 */
export function serializeScenePixelProbeReport(report) {
  return JSON.stringify(report, null, 2);
}

/**
 * @param {object} report
 * @returns {Promise<boolean>}
 */
export async function publishScenePixelProbeReport(report) {
  const ms = globalThis.MapShine ?? {};
  const json = serializeScenePixelProbeReport(report);
  ms.__lastScenePixelProbeReport = report;
  ms.__lastScenePixelProbeReportJson = json;
  try {
    console.groupCollapsed('[ScenePixelProbe] report (also on MapShine.__lastScenePixelProbeReportJson)');
    console.log(json);
    console.groupEnd();
  } catch (_) {}
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await globalThis.navigator.clipboard.writeText(json);
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}

/**
 * @param {(event: object) => void|Promise<void>} handler
 * @returns {boolean}
 */
function attachScenePixelPickListener(handler) {
  detachScenePixelPickListener();

  const domTarget = canvas?.app?.canvas
    ?? canvas?.app?.view
    ?? document.getElementById('board')
    ?? null;
  if (domTarget && typeof domTarget.addEventListener === 'function') {
    const domHandler = (event) => {
      try { handler(event); } catch (e) {
        console.error('[ScenePixelProbe] pick handler failed:', e);
      }
    };
    domTarget.addEventListener('pointerdown', domHandler, { capture: true });
    _pickRegistration = { mode: 'dom', target: domTarget, listener: domHandler, userHandler: handler };
    return true;
  }

  const stage = canvas?.app?.stage ?? canvas?.stage ?? null;
  if (stage && typeof stage.on === 'function') {
    try {
      if (stage.eventMode === 'passive' || stage.eventMode === 'none' || stage.eventMode == null) {
        stage.eventMode = 'static';
      }
    } catch (_) {}
    stage.on('pointerdown', handler);
    _pickRegistration = { mode: 'pixi', target: stage, listener: handler, userHandler: handler };
    return true;
  }

  return false;
}

/** Detach any active pixel-probe pick listener. */
function detachScenePixelPickListener() {
  if (!_pickRegistration) return;
  const reg = _pickRegistration;
  _pickRegistration = null;
  try {
    if (reg.mode === 'dom' && reg.target?.removeEventListener) {
      reg.target.removeEventListener('pointerdown', reg.listener, { capture: true });
    } else if (reg.mode === 'pixi' && reg.target?.off) {
      reg.target.off('pointerdown', reg.userHandler);
    }
  } catch (_) {}
}

/**
 * @param {object} event
 * @returns {{ x: number, y: number }|null}
 */
export function worldXYFromCanvasEvent(event) {
  try {
    if (typeof canvas?.canvasCoordinatesFromClient === 'function' && event?.clientX != null) {
      const p = canvas.canvasCoordinatesFromClient({ x: event.clientX, y: event.clientY });
      if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return { x: p.x, y: p.y };
    }
  } catch (_) {}
  try {
    if (event?.data?.getLocalPosition && canvas?.stage) {
      const p = event.data.getLocalPosition(canvas.stage);
      if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) return { x: p.x, y: p.y };
    }
  } catch (_) {}
  const mx = Number(canvas?.mousePosition?.x);
  const my = Number(canvas?.mousePosition?.y);
  if (Number.isFinite(mx) && Number.isFinite(my)) return { x: mx, y: my };
  return null;
}

/**
 * @param {{ count?: number, floorIdx?: number }} [options]
 * @returns {{ active: boolean, count: number }}
 */
export function probeScenePixelPick(options = {}) {
  probeScenePixelPickCancel();
  const count = Math.max(1, Math.min(MAX_PICK_COUNT, Number(options?.count) || DEFAULT_PICK_COUNT));
  /** @type {object[]} */
  const points = [];

  const handler = async (event) => {
    try {
      try { event?.stopPropagation?.(); } catch (_) {}
      const w = worldXYFromCanvasEvent(event);
      if (!w) {
        try { globalThis.ui?.notifications?.warn?.('Could not read world position from click.'); } catch (_) {}
        return;
      }
      const label = PICK_LABELS[points.length] ?? `P${points.length + 1}`;
      let point;
      try {
        point = sampleScenePixelAt(w.x, w.y, { label, floorIdx: options?.floorIdx });
      } catch (e) {
        try {
          globalThis.ui?.notifications?.error?.(`Pixel probe sample failed: ${e?.message || e}`);
        } catch (_) {}
        console.error('[ScenePixelProbe] sampleScenePixelAt failed:', e);
        return;
      }
      points.push(point);
      try {
        globalThis.ui?.notifications?.info?.(`Pixel probe ${points.length}/${count} (${label}): (${w.x.toFixed(0)}, ${w.y.toFixed(0)})`);
      } catch (_) {}
      if (points.length >= count) {
        probeScenePixelPickCancel();
        const report = buildScenePixelProbeReport(points, { requestedCount: count });
        const copied = await publishScenePixelProbeReport(report);
        try {
          const { showScenePixelProbeDialog } = await import('../ui/scene-pixel-probe-dialog.js');
          showScenePixelProbeDialog(report);
        } catch (e) {
          try {
            globalThis.ui?.notifications?.warn?.(`Pixel probe dialog failed: ${e?.message || e}`);
          } catch (_) {}
        }
        try {
          if (copied) {
            globalThis.ui?.notifications?.info?.('Pixel probe complete — summary dialog open, JSON copied to clipboard');
          } else {
            globalThis.ui?.notifications?.warn?.('Pixel probe complete — see dialog; copy MapShine.__lastScenePixelProbeReportJson');
          }
        } catch (_) {}
      }
    } catch (e) {
      try {
        globalThis.ui?.notifications?.error?.(`Pixel probe failed: ${e?.message || e}`);
      } catch (_) {}
      console.error('[ScenePixelProbe] pick failed:', e);
    }
  };

  _pickHandler = handler;
  try {
    if (!attachScenePixelPickListener(handler)) {
      return { active: false, count, error: 'could-not-register-canvas-click-listener' };
    }
    globalThis.ui?.notifications?.info?.(
      `Click ${count} spot(s) on the map (A/B/C). Cancel: MapShine.debug.probeScenePixelPickCancel()`,
    );
  } catch (e) {
    return { active: false, count, error: String(e?.message || e) };
  }
  return { active: true, count };
}

/** @returns {{ active: boolean }} */
export function probeScenePixelPickCancel() {
  detachScenePixelPickListener();
  _pickHandler = null;
  return { active: false };
}

/**
 * @param {number} [x]
 * @param {number} [y]
 * @param {number} [x2]
 * @param {number} [y2]
 * @param {number} [floorIdx]
 * @returns {object}
 */
export function probeScenePixelAt(x, y, x2, y2, floorIdx) {
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    const m = canvas?.mousePosition;
    const mx = Number(m?.x);
    const my = Number(m?.y);
    if (Number.isFinite(mx) && Number.isFinite(my)) {
      x = mx;
      y = my;
    } else {
      return {
        error: 'missing-coordinates',
        hint: 'MapShine.debug.probeScenePixelPick() or hover map: MapShine.debug.probeScenePixelAt(m.x, m.y)',
      };
    }
  }

  /** @type {object[]} */
  const points = [sampleScenePixelAt(x, y, { label: 'A', floorIdx })];
  if (Number.isFinite(Number(x2)) && Number.isFinite(Number(y2))) {
    points.push(sampleScenePixelAt(x2, y2, { label: 'B', floorIdx }));
  }
  const report = buildScenePixelProbeReport(points, { requestedCount: points.length });
  publishScenePixelProbeReport(report);
  return report;
}

/** @returns {object|null} */
export function getLastScenePixelProbeReport() {
  return globalThis.MapShine?.__lastScenePixelProbeReport ?? null;
}

/** @returns {Promise<boolean>} */
export async function copyScenePixelProbeReport() {
  const json = globalThis.MapShine?.__lastScenePixelProbeReportJson
    ?? (globalThis.MapShine?.__lastScenePixelProbeReport
      ? serializeScenePixelProbeReport(globalThis.MapShine.__lastScenePixelProbeReport)
      : null);
  if (!json) return false;
  if (globalThis.navigator?.clipboard?.writeText) {
    try {
      await globalThis.navigator.clipboard.writeText(json);
      return true;
    } catch (_) {
      return false;
    }
  }
  return false;
}
