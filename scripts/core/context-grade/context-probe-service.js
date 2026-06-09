/**
 * @fileoverview Throttled token-center probing for contextual scene grade.
 * @module core/context-grade/context-probe-service
 */

import Coordinates from '../../utils/coordinates.js';
import { readRtPixelSrgb } from '../../utils/rt-pixel-readback.js';
import { screenUvToLightingSceneUv } from '../../compositor-v2/scene-view-projection.js';
import {
  buildEffectSceneBoundsFromCanvas,
  sampleAuthoredOutdoorsAtWorld,
  syncSharedOutdoorsMaskForFloor,
} from '../../compositor-v2/effects/water-splash-behaviors.js';
import { getSubjectTokenCenterFoundry } from './subject-token-resolver.js';

/** @returns {import('../../compositor-v2/FloorCompositor.js').FloorCompositor|null} */
function resolveFloorCompositor() {
  return window.MapShine?.floorCompositorV2 ?? null;
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @returns {{ u: number, v: number }|null}
 */
export function foundryToSceneUv(foundryX, foundryY) {
  try {
    const dims = canvas?.dimensions;
    if (!dims) return null;
    const sr = dims.sceneRect ?? dims;
    const sceneX = Number(sr.x ?? 0);
    const sceneY = Number(sr.y ?? 0);
    const sceneW = Number(sr.width ?? dims.sceneWidth ?? dims.width ?? 1);
    const sceneH = Number(sr.height ?? dims.sceneHeight ?? dims.height ?? 1);
    const canvasH = Number(dims.height ?? 1);
    const wx = Number(foundryX);
    const wy = Number(foundryY);
    if (!Number.isFinite(wx) || !Number.isFinite(wy)) return null;
    const foundryY = canvasH - wy;
    return {
      u: (wx - sceneX) / Math.max(1e-5, sceneW),
      v: 1.0 - (foundryY - sceneY) / Math.max(1e-5, sceneH),
    };
  } catch (_) {
    return null;
  }
}

/**
 * @param {object|null} tex
 * @param {number} u
 * @param {number} v
 * @returns {{ r: number, g: number, b: number, a: number, luma: number }|null}
 */
export function sampleMaskTextureAtUv(tex, u, v) {
  const img = tex?.image ?? tex?.source?.data ?? null;
  if (!img) return null;
  const w = img.width ?? img.videoWidth ?? 0;
  const h = img.height ?? img.videoHeight ?? 0;
  if (!(w > 0 && h > 0)) return null;
  const px = Math.max(0, Math.min(w - 1, Math.floor(Math.max(0, Math.min(1, u)) * (w - 1))));
  const py = Math.max(0, Math.min(h - 1, Math.floor(Math.max(0, Math.min(1, v)) * (h - 1))));
  try {
    if (img.data && img.width && img.height) {
      const i = (py * w + px) * 4;
      const r = img.data[i] / 255;
      const g = img.data[i + 1] / 255;
      const b = img.data[i + 2] / 255;
      const a = img.data[i + 3] / 255;
      return { r, g, b, a, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
    }
    if (typeof document !== 'undefined') {
      if (!sampleMaskTextureAtUv._canvas) {
        sampleMaskTextureAtUv._canvas = document.createElement('canvas');
        sampleMaskTextureAtUv._ctx = sampleMaskTextureAtUv._canvas.getContext('2d', { willReadFrequently: true });
      }
      const c = sampleMaskTextureAtUv._canvas;
      const ctx = sampleMaskTextureAtUv._ctx;
      if (!ctx) return null;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      } else {
        ctx.clearRect(0, 0, w, h);
      }
      ctx.drawImage(img, 0, 0, w, h);
      const d = ctx.getImageData(px, py, 1, 1).data;
      const r = d[0] / 255;
      const g = d[1] / 255;
      const b = d[2] / 255;
      const a = d[3] / 255;
      return { r, g, b, a, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
    }
  } catch (_) {}
  return null;
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @returns {{ u: number, v: number }|null}
 */
export function foundryToScreenUv(foundryX, foundryY) {
  try {
    const world = Coordinates.toWorld(foundryX, foundryY);
    const fs = window.MapShine?.frameState ?? null;
    if (fs?.worldToScreenUv && world) {
      const uv = fs.worldToScreenUv(world.x, world.y);
      if (uv && Number.isFinite(uv.u) && Number.isFinite(uv.v)) {
        return {
          u: Math.max(0, Math.min(1, uv.u)),
          v: Math.max(0, Math.min(1, uv.v)),
        };
      }
    }

    const fc = window.MapShine?.floorCompositorV2 ?? null;
    const camera = fc?.camera ?? null;
    if (camera && world) {
      const ndc = world.clone();
      ndc.project(camera);
      if (Number.isFinite(ndc.x) && Number.isFinite(ndc.y)) {
        return {
          u: Math.max(0, Math.min(1, ndc.x * 0.5 + 0.5)),
          v: Math.max(0, Math.min(1, ndc.y * 0.5 + 0.5)),
        };
      }
    }
  } catch (_) {
  }
  return null;
}

/**
 * Match ShadowManagerV2 smSceneUvForWorldTextures — world shadow RTs use scene UV
 * derived from the current screen position (camera pan/zoom), not static Foundry UV.
 *
 * @param {number} screenU
 * @param {number} screenV
 * @param {import('../../compositor-v2/effects/ShadowManagerV2.js').ShadowManagerV2|null} [sm]
 * @returns {{ u: number, v: number }|null}
 */
export function screenUvToShadowSceneUv(screenU, screenV, sm = null) {
  const shadowMgr = sm ?? resolveFloorCompositor()?._shadowManagerEffect ?? null;
  const u = shadowMgr?._material?.uniforms;
  if (!u?.uSceneRect?.value) return null;

  const hasScene = Number(u.uHasSceneRect?.value) >= 0.5;
  if (!hasScene) {
    return { u: screenU, v: screenV };
  }

  const sr = u.uSceneRect.value;
  const sd = u.uSceneDimensions?.value;
  const vb = u.uViewBounds?.value;
  if (!sd || !vb) return null;

  let useRemap = Number(u.uHasBuildingUvRemap?.value) >= 0.5;
  if (!useRemap) {
    const spanX = Math.abs(vb.z - vb.x);
    const spanY = Math.abs(vb.w - vb.y);
    useRemap = sd.x > 2 && sd.y > 2 && spanX > 1e-4 && spanY > 1e-4;
  }

  if (!useRemap) {
    return { u: screenU, v: screenV };
  }

  const threeX = vb.x + (vb.z - vb.x) * screenU;
  const threeY = vb.y + (vb.w - vb.y) * screenV;
  const foundryX = threeX;
  const foundryY = sd.y - threeY;
  return {
    u: Math.max(0, Math.min(1, (foundryX - sr.x) / Math.max(sr.z, 1e-5))),
    v: Math.max(0, Math.min(1, (foundryY - sr.y) / Math.max(sr.w, 1e-5))),
  };
}

/**
 * @param {import('three').WebGLRenderer|null} renderer
 * @param {import('three').WebGLRenderTarget|null} rt
 * @param {number} u 0..1 across RT width
 * @param {number} v 0..1 GL bottom-origin across RT height
 * @returns {number|null} lit factor R channel 0..1
 */
export function readLitFactorFromRenderTarget(renderer, rt, u, v) {
  if (!renderer?.readRenderTargetPixels || !rt) return null;
  const w = rt.width | 0;
  const h = rt.height | 0;
  if (w < 1 || h < 1) return null;
  const px = Math.max(0, Math.min(w - 1, Math.floor(u * (w - 1))));
  const pyGl = Math.max(0, Math.min(h - 1, Math.floor(v * (h - 1))));
  const pixel = readRtPixelSrgb(renderer, rt, px, pyGl);
  if (!pixel) return null;
  return Math.max(0, Math.min(1, pixel.linear[0]));
}

/**
 * @returns {boolean}
 */
function isMultiFloorMap() {
  return (window.MapShine?.floorStack?.getFloors?.()?.length ?? 0) > 1;
}

/**
 * Match FloorCompositor lighting binds: multi-floor level 0 uses ground-only lit RT;
 * single-floor maps render into shadowTarget only.
 *
 * @param {object|null} fx
 * @param {number} floorIndex
 * @returns {import('three').WebGLRenderTarget|null}
 */
function resolveWorldShadowLitRenderTarget(fx, floorIndex) {
  if (!fx) return null;
  const fi = Math.max(0, Math.floor(Number(floorIndex) || 0));
  const multiFloor = isMultiFloorMap();
  const renderer = resolveFloorCompositor()?.renderer ?? null;

  if (multiFloor && renderer && typeof fx.renderLitForSingleFloor === 'function') {
    try {
      fx.renderLitForSingleFloor(renderer, fi);
    } catch (_) {
    }
    const perFloor = fx._perFloorLitTargets?.[fi]
      ?? (fi === 0 ? fx._groundOnlyLitTarget : null);
    if (perFloor) return perFloor;
  }

  return fx.shadowTarget ?? null;
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @param {{ u: number, v: number }|null} screen
 * @returns {Array<{ u: number, v: number }>}
 */
function collectWorldShadowSceneUvs(foundryX, foundryY, screen) {
  /** @type {Array<{ u: number, v: number }>} */
  const out = [];
  const push = (uv) => {
    if (!uv || !Number.isFinite(uv.u) || !Number.isFinite(uv.v)) return;
    if (out.some((e) => Math.abs(e.u - uv.u) < 1e-5 && Math.abs(e.v - uv.v) < 1e-5)) return;
    out.push(uv);
  };

  if (screen) {
    const lighting = screenUvToLightingSceneUv(screen.u, screen.v);
    if (lighting) push({ u: lighting.u, v: lighting.v });
  }
  push(foundryToSceneUv(foundryX, foundryY));
  if (screen) {
    const sm = screenUvToShadowSceneUv(screen.u, screen.v);
    push(sm);
  }
  return out;
}

/**
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget} rt
 * @param {number} u scene UV 0..1 (Foundry top-origin v)
 * @param {number} v
 * @returns {number|null}
 */
function readLitFactorAtSceneUv(renderer, rt, u, v) {
  const candidates = [
    readLitFactorFromRenderTarget(renderer, rt, u, 1.0 - v),
    readLitFactorFromRenderTarget(renderer, rt, u, v),
  ];
  for (const lit of candidates) {
    if (lit != null) return lit;
  }
  return null;
}

/**
 * Screen-space lit read with a small cross tap (darkest wins).
 *
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget} rt
 * @param {number} screenU
 * @param {number} screenV
 * @returns {number|null}
 */
function readLitFactorAtScreenUv(renderer, rt, screenU, screenV) {
  if (!renderer || !rt) return null;
  const w = Math.max(1, rt.width | 0);
  const h = Math.max(1, rt.height | 0);
  const du = 6 / w;
  const dv = 6 / h;
  const taps = [
    [screenU, screenV],
    [screenU + du, screenV],
    [screenU - du, screenV],
    [screenU, screenV + dv],
    [screenU, screenV - dv],
  ];
  let minLit = null;
  for (const [u, v] of taps) {
    const su = Math.max(0, Math.min(1, u));
    const sv = Math.max(0, Math.min(1, v));
    const vals = [
      readLitFactorFromRenderTarget(renderer, rt, su, sv),
      readLitFactorFromRenderTarget(renderer, rt, su, 1.0 - sv),
    ];
    for (const lit of vals) {
      if (lit == null) continue;
      minLit = minLit == null ? lit : Math.min(minLit, lit);
    }
  }
  return minLit;
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @param {number} floorIndex
 * @param {object|null} fx
 * @param {string} disabledStatus
 * @param {string} missingStatus
 * @returns {{ lit: number|null, status: string }}
 */
function sampleWorldShadowLitAtFoundry(foundryX, foundryY, floorIndex, fx, disabledStatus, missingStatus) {
  if (!fx?.params?.enabled) return { lit: 1, status: disabledStatus };

  const fc = resolveFloorCompositor();
  const renderer = fc?.renderer ?? null;
  if (!renderer) return { lit: null, status: 'no-renderer' };

  const rt = resolveWorldShadowLitRenderTarget(fx, floorIndex);
  if (!rt) return { lit: null, status: missingStatus };

  const screen = foundryToScreenUv(foundryX, foundryY);
  const sceneUvs = collectWorldShadowSceneUvs(foundryX, foundryY, screen);
  if (!sceneUvs.length) return { lit: null, status: 'no-scene-uv' };

  const readings = [];
  for (const scene of sceneUvs) {
    const lit = readLitFactorAtSceneUv(renderer, rt, scene.u, scene.v);
    if (lit != null) readings.push(lit);
  }
  if (!readings.length) return { lit: null, status: 'shadow-read-failed' };
  // Prefer brightest plausible sample — avoids penumbra false positives.
  return { lit: Math.max(...readings), status: 'ok' };
}

/**
 * @param {object|null} tex
 * @param {number} u
 * @param {number} v
 * @param {boolean} [flipY=false]
 * @returns {number|null} lit factor 0..1 (1 = fully lit)
 */
export function sampleLitFactorAtUv(tex, u, v, flipY = false) {
  let su = u;
  let sv = v;
  if (flipY || tex?.flipY) sv = 1.0 - sv;
  const sample = sampleMaskTextureAtUv(tex, su, sv);
  if (!sample) return null;
  return Math.max(0, Math.min(1, sample.r));
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @param {number} [floorIndex]
 * @returns {{ lit: number|null, status: string }}
 */
export function sampleBuildingShadowAtFoundry(foundryX, foundryY, floorIndex = resolveActiveFloorIndexForProbe()) {
  const fc = resolveFloorCompositor();
  return sampleWorldShadowLitAtFoundry(
    foundryX,
    foundryY,
    floorIndex,
    fc?._buildingShadowEffect ?? null,
    'building-shadows-disabled',
    'no-building-shadow-rt',
  );
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @param {number} [floorIndex]
 * @returns {{ lit: number|null, status: string }}
 */
export function samplePaintedShadowAtFoundry(foundryX, foundryY, floorIndex = resolveActiveFloorIndexForProbe()) {
  const fc = resolveFloorCompositor();
  return sampleWorldShadowLitAtFoundry(
    foundryX,
    foundryY,
    floorIndex,
    fc?._paintedShadowEffect ?? null,
    'painted-shadows-disabled',
    'no-painted-shadow-rt',
  );
}

/**
 * Tree/bush billboard shadow lit factor (screen UV, GPU readback).
 *
 * @param {number} foundryX
 * @param {number} foundryY
 * @returns {{ lit: number|null, status: string }}
 */
export function sampleTreeShadowAtFoundry(foundryX, foundryY) {
  const screen = foundryToScreenUv(foundryX, foundryY);
  if (!screen) return { lit: null, status: 'no-screen-uv' };

  const fc = resolveFloorCompositor();
  const renderer = fc?.renderer ?? null;
  if (!renderer) return { lit: null, status: 'no-renderer' };

  const rts = [
    fc?._treeVegetationBillboardPass?._target ?? null,
    fc?._bushVegetationBillboardPass?._target ?? null,
  ].filter(Boolean);

  if (!rts.length) return { lit: null, status: 'no-tree-shadow-rt' };

  let lit = 1;
  let sampled = false;
  for (const rt of rts) {
    const val = readLitFactorAtScreenUv(renderer, rt, screen.u, screen.v);
    if (val != null) {
      lit = Math.min(lit, val);
      sampled = true;
    }
  }

  if (!sampled) {
    const texCandidates = [
      fc?._vegetationBillboardShadowTexture ?? null,
      fc?._treeBillboardShadowTexture ?? null,
      fc?._bushBillboardShadowTexture ?? null,
    ].filter(Boolean);
    for (const tex of texCandidates) {
      const val = sampleLitFactorAtUv(tex, screen.u, screen.v);
      if (val != null) {
        lit = Math.min(lit, val);
        sampled = true;
      }
    }
  }

  if (!sampled) return { lit: null, status: 'tree-read-failed' };
  return { lit, status: 'ok' };
}

/** @type {number} */
let _outdoorsFrameToken = 0;

/**
 * @returns {number}
 */
export function bumpOutdoorsProbeFrameToken() {
  _outdoorsFrameToken += 1;
  return _outdoorsFrameToken;
}

/**
 * Resolve active floor index for outdoors sampling.
 *
 * @returns {number}
 */
export function resolveActiveFloorIndexForProbe() {
  try {
    const ctxIdx = Number(window.MapShine?.activeLevelContext?.floorIndex);
    if (Number.isFinite(ctxIdx) && ctxIdx >= 0) return ctxIdx;
  } catch (_) {
  }

  try {
    const active = window.MapShine?.floorStack?.getActiveFloor?.();
    const idx = Number(active?.index);
    if (Number.isFinite(idx) && idx >= 0) return idx;
  } catch (_) {
  }

  return 0;
}

/**
 * Sample authored _Outdoors strength at Foundry scene coordinates.
 *
 * @param {number} foundryX
 * @param {number} foundryY
 * @param {number} [floorIndex]
 * @returns {{ sample: number|null, status: string, bounds: object|null, floorIndex: number }}
 */
export function sampleOutdoorsAtFoundryDetailed(foundryX, foundryY, floorIndex = resolveActiveFloorIndexForProbe()) {
  const fi = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
  if (!Number.isFinite(foundryX) || !Number.isFinite(foundryY)) {
    return { sample: null, status: 'invalid-coordinates', bounds: null, floorIndex: fi };
  }

  const bounds = buildEffectSceneBoundsFromCanvas();
  if (!bounds) {
    return { sample: null, status: 'no-scene-bounds', bounds: null, floorIndex: fi };
  }

  const world = Coordinates.toWorld(foundryX, foundryY);
  const frameToken = bumpOutdoorsProbeFrameToken();
  const levelContext = window.MapShine?.activeLevelContext ?? null;

  try {
    syncSharedOutdoorsMaskForFloor(fi, frameToken, levelContext);
  } catch (err) {
    return { sample: null, status: `mask-sync-failed:${err?.message ?? err}`, bounds, floorIndex: fi };
  }

  try {
    const raw = sampleAuthoredOutdoorsAtWorld(
      fi,
      world.x,
      world.y,
      bounds,
      frameToken,
      levelContext,
      { useRawDecode: false },
    );
    if (raw == null) {
      return { sample: null, status: 'no-outdoors-mask-for-floor', bounds, floorIndex: fi };
    }
    const sample = Number(raw);
    if (!Number.isFinite(sample)) {
      return { sample: null, status: 'non-finite-sample', bounds, floorIndex: fi };
    }
    return { sample, status: 'ok', bounds, floorIndex: fi };
  } catch (err) {
    return { sample: null, status: `sample-error:${err?.message ?? err}`, bounds, floorIndex: fi };
  }
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @param {number} [floorIndex]
 * @returns {number|null}
 */
export function sampleOutdoorsAtFoundry(foundryX, foundryY, floorIndex = resolveActiveFloorIndexForProbe()) {
  return sampleOutdoorsAtFoundryDetailed(foundryX, foundryY, floorIndex).sample;
}

/**
 * @param {string|null} tokenId
 * @param {number} [floorIndex]
 * @returns {{ outdoors: number|null, foundryX: number|null, foundryY: number|null, floorIndex: number, maskStatus: string }}
 */
export function probeOutdoorsAtTokenCenter(tokenId, floorIndex = resolveActiveFloorIndexForProbe()) {
  const center = getSubjectTokenCenterFoundry(tokenId);
  if (!center) {
    return { outdoors: null, foundryX: null, foundryY: null, floorIndex, maskStatus: 'no-token-center' };
  }

  const detail = sampleOutdoorsAtFoundryDetailed(center.x, center.y, floorIndex);
  return {
    outdoors: detail.sample,
    foundryX: center.x,
    foundryY: center.y,
    floorIndex: detail.floorIndex,
    maskStatus: detail.status,
  };
}

/**
 * @param {{ x: number, y: number }|null} a
 * @param {{ x: number, y: number }|null} b
 * @returns {number}
 */
export function foundryCenterDistance(a, b) {
  if (!a || !b) return Infinity;
  const dx = Number(a.x) - Number(b.x);
  const dy = Number(a.y) - Number(b.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
  return Math.hypot(dx, dy);
}

/**
 * @returns {number}
 */
export function readDefaultMoveGateGridUnits() {
  try {
    const grid = canvas?.grid;
    const size = Number(grid?.size);
    if (Number.isFinite(size) && size > 0) return size * 0.5;
  } catch (_) {
  }
  return 50;
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @returns {{ sample: number|null, status: string }}
 */
export function sampleSkyReachAtFoundry(foundryX, foundryY) {
  const uv = foundryToSceneUv(foundryX, foundryY);
  if (!uv) return { sample: null, status: 'no-scene-uv' };

  const fc = window.MapShine?.floorCompositorV2 ?? null;
  const tex = fc?._stackedSkyReachCacheTex ?? fc?._lastSkyReachTexture ?? null;
  if (!tex) return { sample: null, status: 'no-sky-reach-texture' };

  const flipY = tex.flipY ? 1 : 0;
  let su = uv.u;
  let sv = uv.v;
  if (flipY) sv = 1.0 - sv;

  const sample = sampleMaskTextureAtUv(tex, su, sv);
  if (!sample) return { sample: null, status: 'sky-reach-read-failed' };

  const reach = sample.a >= 0.02
    ? Math.max(0, Math.min(1, sample.r * sample.a + (1 - sample.a)))
    : 1.0;
  return { sample: reach, status: 'ok' };
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @returns {{ sample: number|null, status: string }}
 */
export function sampleCloudShadowAtFoundry(foundryX, foundryY) {
  const uv = foundryToSceneUv(foundryX, foundryY);
  if (!uv) return { sample: null, status: 'no-scene-uv' };

  const fc = window.MapShine?.floorCompositorV2 ?? null;
  const cloudFx = fc?._cloudEffect ?? null;
  const tex = cloudFx?.cloudShadowTexture ?? null;
  if (!tex || cloudFx?.params?.enabled === false) {
    return { sample: 1, status: 'clouds-disabled' };
  }

  const sample = sampleMaskTextureAtUv(tex, uv.u, uv.v);
  if (!sample) return { sample: null, status: 'cloud-shadow-read-failed' };

  return { sample: Math.max(0, Math.min(1, sample.r)), status: 'ok' };
}

/**
 * @param {number} foundryX
 * @param {number} foundryY
 * @returns {{ windowLit: boolean, status: string, luma: number|null }}
 */
export function probeWindowLitAtFoundry(foundryX, foundryY) {
  const bounds = buildEffectSceneBoundsFromCanvas();
  if (!bounds) return { windowLit: false, status: 'no-scene-bounds', luma: null };

  const world = Coordinates.toWorld(foundryX, foundryY);
  const wl = window.MapShine?.floorCompositorV2?._windowLightEffect
    ?? window.MapShine?.windowLightEffect
    ?? null;

  if (!wl || typeof wl.probeAtWorld !== 'function') {
    return { windowLit: false, status: 'window-light-unavailable', luma: null };
  }

  try {
    const result = wl.probeAtWorld(world.x, world.y);
    const luma = result?.maskSample?.luma ?? null;
    const lit = result?.verdict === 'would_emit'
      || (Number.isFinite(luma) && luma > 0.02 && (result?.maskSample?.a ?? 0) >= 0.01);
    return {
      windowLit: !!lit,
      status: result?.verdict ?? 'ok',
      luma: Number.isFinite(luma) ? luma : null,
    };
  } catch (err) {
    return { windowLit: false, status: `probe-error:${err?.message ?? err}`, luma: null };
  }
}

/**
 * Full token-center probe bundle for Tier 2 dimensions.
 *
 * @param {string|null} tokenId
 * @param {number} [floorIndex]
 * @returns {object}
 */
export function probeTokenContextAtCenter(tokenId, floorIndex = resolveActiveFloorIndexForProbe()) {
  const outdoors = probeOutdoorsAtTokenCenter(tokenId, floorIndex);
  const fx = outdoors.foundryX;
  const fy = outdoors.foundryY;

  if (!Number.isFinite(fx) || !Number.isFinite(fy)) {
    return {
      ...outdoors,
      skyReach: null,
      skyReachStatus: 'no-token-center',
      cloudShadow: null,
      cloudShadowStatus: 'no-token-center',
      windowLit: false,
      windowLitStatus: 'no-token-center',
      buildingShadowLit: null,
      buildingShadowStatus: 'no-token-center',
      paintedShadowLit: null,
      paintedShadowStatus: 'no-token-center',
      treeShadowLit: null,
      treeShadowStatus: 'no-token-center',
    };
  }

  const sky = sampleSkyReachAtFoundry(fx, fy);
  const cloud = sampleCloudShadowAtFoundry(fx, fy);
  const win = probeWindowLitAtFoundry(fx, fy);
  const building = sampleBuildingShadowAtFoundry(fx, fy, floorIndex);
  const painted = samplePaintedShadowAtFoundry(fx, fy, floorIndex);
  const tree = sampleTreeShadowAtFoundry(fx, fy);

  return {
    ...outdoors,
    skyReach: sky.sample,
    skyReachStatus: sky.status,
    cloudShadow: cloud.sample,
    cloudShadowStatus: cloud.status,
    windowLit: win.windowLit,
    windowLitStatus: win.status,
    windowLitLuma: win.luma,
    buildingShadowLit: building.lit,
    buildingShadowStatus: building.status,
    paintedShadowLit: painted.lit,
    paintedShadowStatus: painted.status,
    treeShadowLit: tree.lit,
    treeShadowStatus: tree.status,
  };
}
