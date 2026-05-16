/**
 * @fileoverview Shared water splash particle behavior classes for V2 Water Splashes Effect.
 *
 * Follows the same architecture as fire-behaviors.js:
 *   - CPU mask scanning to build spawn point lists (Lookup Map technique)
 *   - Emitter shape class that spawns from precomputed edge pixels
 *   - Lifecycle behaviors for color, alpha, size over particle life
 *
 * All behavior classes follow the three.quarks behavior interface:
 *   - initialize(particle, system) — called once when particle spawns
 *   - update(particle, delta, system) — called each frame
 *   - frameUpdate(delta) — called once per frame (global state sync)
 *   - reset() / clone() — lifecycle helpers
 *
 * @module compositor-v2/effects/water-splash-behaviors
 */

import { weatherController } from '../../core/WeatherController.js';
import { resolveEffectWindWorld } from './resolve-effect-wind.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Gradient / Envelope Constants
// ═══════════════════════════════════════════════════════════════════════════════

const clamp01 = (n) => Math.max(0.0, Math.min(1.0, n));
const lerp = (a, b, t) => a + (b - a) * t;

// Foam plume alpha envelope: quick fade-in, sustained peak, slow fade-out.
export const FOAM_ALPHA_STOPS = [
  { t: 0.00, v: 0.00 },
  { t: 0.05, v: 0.60 },
  { t: 0.18, v: 1.00 },
  { t: 0.50, v: 0.90 },
  { t: 0.75, v: 0.55 },
  { t: 0.90, v: 0.20 },
  { t: 1.00, v: 0.00 },
];

// Foam plume size growth: starts small, billows outward.
export const FOAM_SIZE_STOPS = [
  { t: 0.00, v: 0.50 },
  { t: 0.15, v: 0.85 },
  { t: 0.40, v: 1.10 },
  { t: 0.70, v: 1.30 },
  { t: 1.00, v: 1.50 },
];

// Splash ring alpha: sharp pop then rapid fade.
export const SPLASH_ALPHA_STOPS = [
  { t: 0.00, v: 0.00 },
  { t: 0.03, v: 0.80 },
  { t: 0.10, v: 1.00 },
  { t: 0.30, v: 0.70 },
  { t: 0.60, v: 0.25 },
  { t: 1.00, v: 0.00 },
];

// Splash ring size: expands outward from impact point.
export const SPLASH_SIZE_STOPS = [
  { t: 0.00, v: 0.30 },
  { t: 0.10, v: 0.80 },
  { t: 0.40, v: 1.20 },
  { t: 0.70, v: 1.50 },
  { t: 1.00, v: 1.80 },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Utility: Multi-stop Scalar Interpolation
// ═══════════════════════════════════════════════════════════════════════════════

/** Lerp a scalar stop array [{t, v}, ...] returning a number. */
function lerpScalarStops(stops, t) {
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1].t <= t) i++;
  if (i >= stops.length - 1) return stops[stops.length - 1].v;
  const a = stops[i];
  const b = stops[i + 1];
  const f = (t - a.t) / Math.max(0.0001, b.t - a.t);
  return a.v + (b.v - a.v) * f;
}

/**
 * Apply a scalar size to a Quarks particle that may store size as either:
 * - a number, or
 * - a Vector2/Vector3-like object.
 *
 * IMPORTANT: Do not assign `particle.size = number` when `particle.size` is an
 * object — that can break Quarks internals which later call `particle.size.copy()`.
 * @private
 */
function applyParticleScalarSize(particle, scalar, flipX = 1.0, flipY = 1.0) {
  if (!particle) return;
  let s = scalar;
  if (!Number.isFinite(s)) s = 1.0;

  // Scalar size representation.
  if (typeof particle.size === 'number') {
    // When scalar-only, we can't represent independent X/Y flips. Preserve sign
    // flip for variety (X flip only) without affecting magnitude.
    particle.size = s * (flipX < 0 ? -1.0 : 1.0);
    return;
  }

  const size = particle.size;
  if (!size || typeof size !== 'object') return;

  // Vector-like size representation.
  // Prefer writing x/y directly (works for Vector2/Vector3 and Quarks wrappers).
  if (typeof size.x === 'number') size.x = s * flipX;
  if (typeof size.y === 'number') size.y = s * flipY;
  if (typeof size.z === 'number') size.z = s;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WaterEdgeMaskShape — Emitter that spawns from precomputed _Water edge pixels
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Emitter shape that places particles at water edge/shore positions.
 * Uses the same Lookup Map technique as FireMaskShape: a packed Float32Array
 * of (u, v, edgeStrength) triples built by scanWaterEdgePoints().
 *
 * Particles are placed in world space (worldSpace: true on the system).
 */
export class WaterEdgeMaskShape {
  /**
   * @param {Float32Array} points - Packed (u, v, edgeStrength) triples in scene UV
   * @param {number} sceneWidth - Scene width in world units
   * @param {number} sceneHeight - Scene height in world units
   * @param {number} sceneX - Scene X origin in world units (Three.js Y-up)
   * @param {number} sceneY - Scene Y origin in world units (Three.js Y-up)
   * @param {number} [groundZ=1000] - Z position for ground plane
   * @param {number} [floorElevation=0] - Z offset above groundZ for this floor
   */
  constructor(points, sceneWidth, sceneHeight, sceneX, sceneY, groundZ = 1000, floorElevation = 0) {
    this._allPoints = points;
    this.points = points;
    this.sceneWidth = sceneWidth;
    this.sceneHeight = sceneHeight;
    this.sceneX = sceneX;
    this.sceneY = sceneY;
    this.groundZ = groundZ;
    this.floorElevation = Number.isFinite(floorElevation) ? floorElevation : 0;
    this.type = 'water_edge_mask';

    // View-dependent filtering cache.
    this._lastView = null;
    this._viewPoints = null;
  }

  /** @returns {number} active point count (triples) */
  getActivePointCount() {
    return Math.floor((this.points?.length ?? 0) / 3);
  }

  /**
   * Filter the active points to those inside the given view rectangle in scene UV.
   * Points are packed (u, v, strength) triples.
   * @param {number} uMin
   * @param {number} uMax
   * @param {number} vMin
   * @param {number} vMax
   */
  setViewBoundsUv(uMin, uMax, vMin, vMax) {
    const all = this._allPoints;
    if (!all || all.length < 3) {
      this.points = all;
      return;
    }

    const view = this._lastView;
    if (view && Math.abs(view.uMin - uMin) < 1e-6 && Math.abs(view.uMax - uMax) < 1e-6
      && Math.abs(view.vMin - vMin) < 1e-6 && Math.abs(view.vMax - vMax) < 1e-6) {
      return;
    }
    this._lastView = { uMin, uMax, vMin, vMax };

    const tmp = [];
    for (let i = 0; i < all.length; i += 3) {
      const u = all[i];
      const v = all[i + 1];
      if (u < uMin || u > uMax || v < vMin || v > vMax) continue;
      tmp.push(u, v, all[i + 2]);
    }

    // Avoid allocations when nothing changed materially.
    if (tmp.length === all.length) {
      this.points = all;
      return;
    }

    if (!this._viewPoints || this._viewPoints.length !== tmp.length) {
      this._viewPoints = new Float32Array(tmp.length);
    }
    this._viewPoints.set(tmp);
    this.points = this._viewPoints;
  }

  initialize(p) {
    const count = this.points.length / 3;
    if (count === 0) {
      this._killParticle(p);
      return;
    }

    // Pick a random point from the precomputed list.
    const idx = Math.floor(Math.random() * count) * 3;
    const u = this.points[idx];
    const v = this.points[idx + 1];
    const edgeStrength = this.points[idx + 2];

    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(edgeStrength) || edgeStrength <= 0) {
      this._killParticle(p);
      return;
    }

    // Map scene UV to world-space position.
    // v=0 is image top (Foundry Y-down), world Y grows upward → use (1-v).
    p.position.x = this.sceneX + u * this.sceneWidth;
    p.position.y = this.sceneY + (1.0 - v) * this.sceneHeight;
    p.position.z = this.groundZ + this.floorElevation;

    // Store edge strength for lifecycle behaviors to modulate intensity.
    p._edgeStrength = edgeStrength;

    // Small random XY jitter so particles don't stack exactly on edge pixels.
    // ±15 world units keeps them near the edge without drifting into open water.
    p.position.x += (Math.random() - 0.5) * 30;
    p.position.y += (Math.random() - 0.5) * 30;

    // Brightness/edge-based modifiers: stronger edges get bigger, longer-lived particles.
    if (typeof p.life === 'number') p.life *= (0.5 + 0.5 * edgeStrength);
    if (typeof p.size === 'number') p.size *= (0.5 + 0.5 * edgeStrength);

    // Reset velocity — foam sits on the water surface.
    if (p.velocity) p.velocity.set(0, 0, 0);

    // Sanity check.
    const tooBig = (val) => !Number.isFinite(val) || Math.abs(val) > 1e6;
    if ((p.position && (tooBig(p.position.x) || tooBig(p.position.y) || tooBig(p.position.z))) ||
        (typeof p.life === 'number' && tooBig(p.life)) ||
        (typeof p.size === 'number' && tooBig(p.size))) {
      this._killParticle(p);
    }
  }

  /** @private */
  _killParticle(p) {
    if (typeof p.life === 'number') p.life = 0;
    if (p.color && typeof p.color.w === 'number') p.color.w = 0;
    if (typeof p.size === 'number') p.size = 0;
  }

  update(system, delta) { /* static points — no per-frame work */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WaterInteriorMaskShape — Emitter for interior water area splashes
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Emitter shape that places particles anywhere within the water body interior
 * (not just edges). Used for rain-hit splashes and floating foam flecks.
 *
 * Same architecture as WaterEdgeMaskShape but uses interior points.
 */
export class WaterInteriorMaskShape {
  /**
   * @param {Float32Array} points - Packed (u, v, brightness) triples in scene UV
   * @param {number} sceneWidth
   * @param {number} sceneHeight
   * @param {number} sceneX
   * @param {number} sceneY
   * @param {number} [groundZ=1000]
   * @param {number} [floorElevation=0]
   */
  constructor(points, sceneWidth, sceneHeight, sceneX, sceneY, groundZ = 1000, floorElevation = 0) {
    this._allPoints = points;
    this.points = points;
    this.sceneWidth = sceneWidth;
    this.sceneHeight = sceneHeight;
    this.sceneX = sceneX;
    this.sceneY = sceneY;
    this.groundZ = groundZ;
    this.floorElevation = Number.isFinite(floorElevation) ? floorElevation : 0;
    this.type = 'water_interior_mask';

    // View-dependent filtering cache.
    this._lastView = null;
    this._viewPoints = null;
  }

  /** @returns {number} active point count (triples) */
  getActivePointCount() {
    return Math.floor((this.points?.length ?? 0) / 3);
  }

  /**
   * Filter the active points to those inside the given view rectangle in scene UV.
   * Points are packed (u, v, brightness) triples.
   * @param {number} uMin
   * @param {number} uMax
   * @param {number} vMin
   * @param {number} vMax
   */
  setViewBoundsUv(uMin, uMax, vMin, vMax) {
    const all = this._allPoints;
    if (!all || all.length < 3) {
      this.points = all;
      return;
    }

    const view = this._lastView;
    if (view && Math.abs(view.uMin - uMin) < 1e-6 && Math.abs(view.uMax - uMax) < 1e-6
      && Math.abs(view.vMin - vMin) < 1e-6 && Math.abs(view.vMax - vMax) < 1e-6) {
      return;
    }
    this._lastView = { uMin, uMax, vMin, vMax };

    const tmp = [];
    for (let i = 0; i < all.length; i += 3) {
      const u = all[i];
      const v = all[i + 1];
      if (u < uMin || u > uMax || v < vMin || v > vMax) continue;
      tmp.push(u, v, all[i + 2]);
    }

    if (tmp.length === all.length) {
      this.points = all;
      return;
    }

    if (!this._viewPoints || this._viewPoints.length !== tmp.length) {
      this._viewPoints = new Float32Array(tmp.length);
    }
    this._viewPoints.set(tmp);
    this.points = this._viewPoints;
  }

  initialize(p) {
    const count = this.points.length / 3;
    if (count === 0) {
      this._killParticle(p);
      return;
    }

    const idx = Math.floor(Math.random() * count) * 3;
    const u = this.points[idx];
    const v = this.points[idx + 1];
    const brightness = this.points[idx + 2];

    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(brightness) || brightness <= 0) {
      this._killParticle(p);
      return;
    }

    p.position.x = this.sceneX + u * this.sceneWidth;
    p.position.y = this.sceneY + (1.0 - v) * this.sceneHeight;
    p.position.z = this.groundZ + this.floorElevation;

    p._edgeStrength = brightness;

    if (typeof p.life === 'number') p.life *= (0.6 + 0.4 * brightness);
    if (typeof p.size === 'number') p.size *= (0.5 + 0.5 * brightness);

    if (p.velocity) p.velocity.set(0, 0, 0);

    const tooBig = (val) => !Number.isFinite(val) || Math.abs(val) > 1e6;
    if ((p.position && (tooBig(p.position.x) || tooBig(p.position.y) || tooBig(p.position.z)))) {
      this._killParticle(p);
    }
  }

  /** @private */
  _killParticle(p) {
    if (typeof p.life === 'number') p.life = 0;
    if (p.color && typeof p.color.w === 'number') p.color.w = 0;
    if (typeof p.size === 'number') p.size = 0;
  }

  update(system, delta) { /* static points — no per-frame work */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// OutdoorsMaskState — shared CPU _Outdoors readback for particle wind shelter
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * CPU mirror of WaterEffectV2 `_Outdoors` binding for sampling shelter at world XY.
 * @private
 */
class OutdoorsMaskState {
  /**
   * @param {number} [floorIndex=0]
   */
  constructor(floorIndex = 0) {
    this._floorIndex = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
    this._hasOutdoorsMask = false;
    this._outdoorsMaskFlipY = false;
    this._outdoorsMaskTex = null;
    this._outdoorsMaskData = null;
    this._outdoorsMaskW = 0;
    this._outdoorsMaskH = 0;
    this._outdoorsMaskImageUuid = null;
    this._outdoorsMaskGpuRowOrder = false;
    this._indoorSuppressionStrength = 0.0;
  }

  get indoorSuppressionStrength() {
    return this._indoorSuppressionStrength;
  }

  /** Sync from live WaterEffectV2 uniforms + compositor readback. */
  syncFromWaterEffect() {
    this._indoorSuppressionStrength = 0.0;
    this._hasOutdoorsMask = false;
    try {
      const waterEffect = window.MapShine?.effectComposer?._floorCompositorV2?._waterEffect;
      const wp = waterEffect?.params;
      const u = waterEffect?._composeMaterial?.uniforms;
      const hasOutdoorsMask = Number(u?.uHasOutdoorsMask?.value) > 0.5;
      if (hasOutdoorsMask) {
        this._hasOutdoorsMask = true;
        const outdoorsTex = u?.tOutdoorsMask?.value ?? null;
        this._outdoorsMaskTex = outdoorsTex;
        this._outdoorsMaskFlipY = Number(u?.uOutdoorsMaskFlipY?.value) > 0.5;
        this._refreshOutdoorsCpuPixels(outdoorsTex);
        const waveSupp = (wp?.waveIndoorDampingEnabled === true)
          ? Math.max(0.0, Math.min(1.0, Number(wp?.waveIndoorDampingStrength) || 0.0))
          : 0.0;
        const rainSupp = (wp?.rainIndoorDampingEnabled === true)
          ? Math.max(0.0, Math.min(1.0, Number(wp?.rainIndoorDampingStrength) || 0.0))
          : 0.0;
        this._indoorSuppressionStrength = Math.max(waveSupp, rainSupp);
      }
    } catch (_) {}
  }

  /**
   * @param {any} outdoorsTex
   * @private
   */
  _refreshOutdoorsCpuPixels(outdoorsTex) {
    const compositor = window.MapShine?.gpuSceneMaskCompositor;
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const floor = floors[this._floorIndex];
    let floorKey = (floor?.compositorKey != null) ? String(floor.compositorKey) : null;

    if (!floorKey) {
      const active = window.MapShine?.floorStack?.getActiveFloor?.();
      const activeMatchesSystemFloor = active && Number(active.index) === this._floorIndex;
      if (activeMatchesSystemFloor && active?.compositorKey != null) {
        floorKey = String(active.compositorKey);
      } else if (activeMatchesSystemFloor && compositor?._activeFloorKey) {
        // `_activeFloorKey` can be stale after per-level rendering; only use it
        // when the public active floor still matches this splash system floor.
        floorKey = String(compositor._activeFloorKey);
      }
    }

    if (compositor && floorKey && typeof compositor.getCpuPixelsForFloor === 'function') {
      const buf = compositor.getCpuPixelsForFloor(floorKey, 'outdoors');
      const dims = compositor.getOutputDims?.('outdoors');
      if (buf && dims?.width > 0 && dims?.height > 0) {
        this._outdoorsMaskData = buf;
        this._outdoorsMaskW = dims.width;
        this._outdoorsMaskH = dims.height;
        this._outdoorsMaskGpuRowOrder = true;
        return;
      }
    }

    const img = outdoorsTex?.image;
    const imgUuid = img?.src ?? outdoorsTex?.uuid ?? null;
    if (imgUuid !== this._outdoorsMaskImageUuid) {
      this._outdoorsMaskImageUuid = imgUuid;
      this._prepareOutdoorsMaskDataFromImage(outdoorsTex);
    }
  }

  /**
   * @param {any} tex
   * @private
   */
  _prepareOutdoorsMaskDataFromImage(tex) {
    try {
      const img = tex?.image;
      const w = Number(img?.width) || Number(img?.videoWidth) || 0;
      const h = Number(img?.height) || Number(img?.videoHeight) || 0;
      if (!(w > 0 && h > 0)) {
        this._outdoorsMaskData = null;
        this._outdoorsMaskW = 0;
        this._outdoorsMaskH = 0;
        return;
      }
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      this._outdoorsMaskData = data;
      this._outdoorsMaskW = w;
      this._outdoorsMaskH = h;
      this._outdoorsMaskGpuRowOrder = false;
    } catch (_) {
      this._outdoorsMaskData = null;
      this._outdoorsMaskW = 0;
      this._outdoorsMaskH = 0;
    }
  }

  /**
   * @param {number} worldX
   * @param {number} worldY
   * @param {object} ownerEffect
   * @returns {number|null}
   */
  sampleAtWorld(worldX, worldY, ownerEffect) {
    if (!this._hasOutdoorsMask || !this._outdoorsMaskData || this._outdoorsMaskW <= 0 || this._outdoorsMaskH <= 0) {
      return null;
    }
    const b = ownerEffect?._sceneBounds;
    if (!b || !Number.isFinite(worldX) || !Number.isFinite(worldY)) return null;
    if (!(b.sw > 0 && b.sh > 0)) return null;

    const u = clamp01((worldX - b.sx) / b.sw);
    const vFoundry = clamp01(1.0 - ((worldY - b.syWorld) / b.sh));
    const texY = this._outdoorsMaskFlipY ? (1.0 - vFoundry) : vFoundry;

    const px = Math.max(0, Math.min(this._outdoorsMaskW - 1, Math.floor(u * (this._outdoorsMaskW - 1))));
    const pyRow = Math.max(0, Math.min(this._outdoorsMaskH - 1, Math.floor(texY * (this._outdoorsMaskH - 1))));
    const py = this._outdoorsMaskGpuRowOrder ? ((this._outdoorsMaskH - 1) - pyRow) : pyRow;
    const i = (py * this._outdoorsMaskW + px) * 4;
    const d = this._outdoorsMaskData;
    return clamp01(d[i] / 255.0);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FoamPlumeLifecycleBehavior — Shore foam: billow, drift, fade
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lifecycle behavior for foam plume particles that appear along water edges.
 * Controls alpha envelope, size growth, color tinting, and gentle wind drift.
 */
export class FoamPlumeLifecycleBehavior {
  /**
   * @param {object} ownerEffect - WaterSplashesEffectV2 (or bubbles proxy with `params`)
   * @param {number} [floorIndex=0] - Floor stack index for GpuSceneMaskCompositor `getCpuPixelsForFloor`
   */
  constructor(ownerEffect, floorIndex = 0) {
    this.type = 'FoamPlumeLifecycle';
    this.ownerEffect = ownerEffect;
    this._floorIndex = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
    this._outMask = new OutdoorsMaskState(this._floorIndex);

    // Cached per-frame state from params.
    this._peakOpacity = 0.65;
    this._foamColorR = 0.85;
    this._foamColorG = 0.90;
    this._foamColorB = 0.88;
    this._windDriftScale = 0.0;
    this._windX = 1.0;
    this._windY = 0.0;
    this._windSpeed01 = 0.0;

    // Color tint jitter.
    this._tintStrength = 0.0;
    this._tintJitter = 1.0;
    this._tintA = { r: 0.85, g: 0.92, b: 1.00 };
    this._tintB = { r: 0.10, g: 0.55, b: 0.75 };
  }

  initialize(particle) {
    // Store initial size for growth curve.
    if (particle._splashBaseSize === undefined) {
      if (typeof particle.size === 'number' && Number.isFinite(particle.size)) {
        particle._splashBaseSize = Math.abs(particle.size);
      } else if (particle.size && typeof particle.size.x === 'number' && Number.isFinite(particle.size.x)) {
        particle._splashBaseSize = Math.abs(particle.size.x);
      } else {
        particle._splashBaseSize = 50;
      }
    }
    // Random opacity variation per-particle.
    particle._foamOpacityRand = 0.7 + Math.random() * 0.3;
    // Random spin speed.
    particle._foamSpinSpeed = (Math.random() - 0.5) * 0.36;
    // Random UV flips for visual variety.
    particle._foamFlipX = Math.random() < 0.5 ? -1.0 : 1.0;
    particle._foamFlipY = Math.random() < 0.5 ? -1.0 : 1.0;

    // Random tint mix selection for this particle (stable over its lifetime).
    particle._msTintRand = Math.random();

    // Lazy: CPU mask readback may not exist on first frame (GPU RT). Sample in update().
    particle._msOutdoorStrength = null;
  }

  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;

    if (particle._msOutdoorStrength == null) {
      const outdoor = this._outMask.sampleAtWorld(particle?.position?.x, particle?.position?.y, this.ownerEffect);
      if (Number.isFinite(outdoor)) particle._msOutdoorStrength = outdoor;
    }

    const t = age / Math.max(0.001, life);

    // Alpha envelope.
    const alphaBase = lerpScalarStops(FOAM_ALPHA_STOPS, t);
    const edgeStr = particle._edgeStrength ?? 1.0;
    const opRand = particle._foamOpacityRand ?? 1.0;

    let r = this._foamColorR;
    let g = this._foamColorG;
    let b = this._foamColorB;

    // Apply optional two-color tint jitter to better match water/sky mood.
    if (this._tintStrength > 0.0001) {
      const rand = particle._msTintRand ?? 0.5;
      const tMix = clamp01(0.5 + (rand - 0.5) * this._tintJitter);
      const tr = lerp(this._tintA.r, this._tintB.r, tMix);
      const tg = lerp(this._tintA.g, this._tintB.g, tMix);
      const tb = lerp(this._tintA.b, this._tintB.b, tMix);
      const s = clamp01(this._tintStrength);
      r = lerp(r, tr, s);
      g = lerp(g, tg, s);
      b = lerp(b, tb, s);
    }

    particle.color.x = r;
    particle.color.y = g;
    particle.color.z = b;
    particle.color.w = alphaBase * this._peakOpacity * edgeStr * opRand;

    // Size growth.
    const sizeScale = lerpScalarStops(FOAM_SIZE_STOPS, t);
    const baseSize = particle._splashBaseSize ?? 50;
    applyParticleScalarSize(
      particle,
      baseSize * sizeScale,
      particle._foamFlipX ?? 1.0,
      particle._foamFlipY ?? 1.0
    );

    // Gentle spin.
    if (typeof particle.rotation === 'number' && typeof particle._foamSpinSpeed === 'number') {
      particle.rotation += particle._foamSpinSpeed * delta;
    }

    // Wind drift — keeps foam flowing with the current/wind.
    if (particle.position && this._windDriftScale > 0.001) {
      // Until mask pixels are readable, fail-open (full drift) so foam does not stick.
      const outdoor = (particle._msOutdoorStrength != null && Number.isFinite(particle._msOutdoorStrength))
        ? clamp01(particle._msOutdoorStrength)
        : 1.0;
      const indoor = 1.0 - outdoor;
      const indoorMul = 1.0 - (0.9 * this._outMask.indoorSuppressionStrength * indoor);
      const driftSpeed = (15 + 80 * this._windSpeed01) * this._windDriftScale * indoorMul;
      particle.position.x += this._windX * driftSpeed * delta;
      particle.position.y += this._windY * driftSpeed * delta;
    }
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    this._peakOpacity = Math.max(0.0, Math.min(1.0, p?.foamPeakOpacity ?? 0.65));
    this._foamColorR = p?.foamColorR ?? 0.97;
    this._foamColorG = p?.foamColorG ?? 0.982;
    this._foamColorB = p?.foamColorB ?? 1.0;
    this._windDriftScale = Math.max(0.0, p?.foamWindDriftScale ?? 0.3);

    this._tintStrength = clamp01(p?.tintStrength ?? 0.0);
    this._tintJitter = clamp01(p?.tintJitter ?? 1.0) * 2.0;
    if (p) {
      this._tintA = {
        r: clamp01(p.tintAColorR ?? this._tintA.r),
        g: clamp01(p.tintAColorG ?? this._tintA.g),
        b: clamp01(p.tintAColorB ?? this._tintA.b),
      };
      this._tintB = {
        r: clamp01(p.tintBColorR ?? this._tintB.r),
        g: clamp01(p.tintBColorG ?? this._tintB.g),
        b: clamp01(p.tintBColorB ?? this._tintB.b),
      };
    }

    const rw = resolveEffectWindWorld();
    this._windX = rw.dirX;
    this._windY = rw.dirY;
    this._windSpeed01 = rw.speed01;

    this._outMask.syncFromWaterEffect();
  }

  reset() {}
  clone() { return new FoamPlumeLifecycleBehavior(this.ownerEffect, this._floorIndex); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SplashRingLifecycleBehavior — Rain-hit splash rings on water surface
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lifecycle behavior for splash ring particles that appear when rain hits
 * the water surface. Quick pop and expand, then rapid fade.
 */
export class SplashRingLifecycleBehavior {
  /**
   * @param {object} ownerEffect - WaterSplashesEffectV2 or proxy with `params` (+ `_sceneBounds` for outdoors sampling)
   * @param {number} [floorIndex=0]
   */
  constructor(ownerEffect, floorIndex = 0) {
    this.type = 'SplashRingLifecycle';
    this.ownerEffect = ownerEffect;
    this._floorIndex = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
    this._outMask = new OutdoorsMaskState(this._floorIndex);
    this._peakOpacity = 0.70;
    this._precipMult = 1.0;
    this._windX = 1.0;
    this._windY = 0.0;
    this._windSpeed01 = 0.0;
    this._splashWindDriftScale = 1.0;

    // Color tint jitter.
    this._tintStrength = 0.0;
    this._tintJitter = 1.0;
    this._tintA = { r: 0.85, g: 0.92, b: 1.00 };
    this._tintB = { r: 0.10, g: 0.55, b: 0.75 };
  }

  initialize(particle) {
    if (particle._splashBaseSize === undefined) {
      if (typeof particle.size === 'number' && Number.isFinite(particle.size)) {
        particle._splashBaseSize = Math.abs(particle.size);
      } else if (particle.size && typeof particle.size.x === 'number' && Number.isFinite(particle.size.x)) {
        particle._splashBaseSize = Math.abs(particle.size.x);
      } else {
        particle._splashBaseSize = 20;
      }
    }
    particle._splashOpacityRand = 0.6 + Math.random() * 0.4;

    // Random tint mix selection for this particle (stable over its lifetime).
    particle._msTintRand = Math.random();

    particle._msOutdoorStrength = null;
  }

  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;

    if (particle._msOutdoorStrength == null) {
      const outdoor = this._outMask.sampleAtWorld(particle?.position?.x, particle?.position?.y, this.ownerEffect);
      if (Number.isFinite(outdoor)) particle._msOutdoorStrength = outdoor;
    }

    const t = age / Math.max(0.001, life);

    // Alpha: sharp pop then rapid fade.
    const alpha = lerpScalarStops(SPLASH_ALPHA_STOPS, t);
    const opRand = particle._splashOpacityRand ?? 1.0;
    // Near-white vertex color; shading (V10) clamps night/shadow vs sun spray.
    let r = 0.982;
    let g = 0.988;
    let b = 1.0;

    if (this._tintStrength > 0.0001) {
      const rand = particle._msTintRand ?? 0.5;
      const tMix = clamp01(0.5 + (rand - 0.5) * this._tintJitter);
      const tr = lerp(this._tintA.r, this._tintB.r, tMix);
      const tg = lerp(this._tintA.g, this._tintB.g, tMix);
      const tb = lerp(this._tintA.b, this._tintB.b, tMix);
      const s = clamp01(this._tintStrength);
      r = lerp(r, tr, s);
      g = lerp(g, tg, s);
      b = lerp(b, tb, s);
    }

    particle.color.x = r;
    particle.color.y = g;
    particle.color.z = b;
    particle.color.w = alpha * this._peakOpacity * opRand * this._precipMult;

    // Size: expand outward from impact.
    const sizeScale = lerpScalarStops(SPLASH_SIZE_STOPS, t);
    const baseSize = particle._splashBaseSize ?? 20;
    applyParticleScalarSize(particle, baseSize * sizeScale);

    // Wind shear on impact rings (weaker than shore foam; respects _Outdoors shelter).
    if (particle.position && this._splashWindDriftScale > 0.001) {
      const outdoor = (particle._msOutdoorStrength != null && Number.isFinite(particle._msOutdoorStrength))
        ? clamp01(particle._msOutdoorStrength)
        : 1.0;
      const indoor = 1.0 - outdoor;
      const indoorMul = 1.0 - (0.9 * this._outMask.indoorSuppressionStrength * indoor);
      const driftSpeed = (6.0 + 28.0 * this._windSpeed01) * this._splashWindDriftScale * indoorMul;
      particle.position.x += this._windX * driftSpeed * delta;
      particle.position.y += this._windY * driftSpeed * delta;
    }
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    this._peakOpacity = Math.max(0.0, Math.min(1.0, p?.splashPeakOpacity ?? 0.70));
    this._splashWindDriftScale = Math.max(0.0, Number(p?.splashWindDriftScale) || 1.0);

    const rw = resolveEffectWindWorld();
    this._windX = rw.dirX;
    this._windY = rw.dirY;
    this._windSpeed01 = rw.speed01;
    this._outMask.syncFromWaterEffect();

    this._tintStrength = clamp01(p?.tintStrength ?? 0.0);
    this._tintJitter = clamp01(p?.tintJitter ?? 1.0) * 2.0;
    if (p) {
      this._tintA = {
        r: clamp01(p.tintAColorR ?? this._tintA.r),
        g: clamp01(p.tintAColorG ?? this._tintA.g),
        b: clamp01(p.tintAColorB ?? this._tintA.b),
      };
      this._tintB = {
        r: clamp01(p.tintBColorR ?? this._tintB.r),
        g: clamp01(p.tintBColorG ?? this._tintB.g),
        b: clamp01(p.tintBColorB ?? this._tintB.b),
      };
    }

    // Scale splash intensity by current precipitation.
    try {
      const state = weatherController?.getCurrentState?.();
      const precip = state?.precipitation ?? 0;
      this._precipMult = Math.max(0.0, Math.min(1.0, precip));
    } catch (_) {
      this._precipMult = 0.0;
    }
  }

  reset() {}
  clone() { return new SplashRingLifecycleBehavior(this.ownerEffect, this._floorIndex); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// scanWaterEdgePoints — CPU mask scanning for water edge pixels
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scan a water mask image on the CPU and collect edge pixels (shoreline) as
 * (u, v, edgeStrength) triples packed into a Float32Array.
 *
 * Edge detection: A pixel is an "edge" if it is bright (water) but has at
 * least one dim/dark neighbor (land). The edge strength is proportional to
 * how many dark neighbors the pixel has (more dark neighbors = stronger edge).
 *
 * This is the Lookup Map technique — same pattern as generateFirePoints().
 *
 * @param {HTMLImageElement|ImageBitmap} image - The _Water mask image
 * @param {number} [threshold=0.15] - Minimum brightness to count as water
 * @param {number} [stride=2] - Sample every Nth pixel (performance vs density trade-off)
 * @returns {Float32Array|null} Packed (u, v, edgeStrength) triples, or null if empty
 */
export function scanWaterEdgePoints(image, threshold = 0.15, stride = 2) {
  if (!image) return null;

  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const imgW = c.width;
  const imgH = c.height;

  // Pre-compute per-pixel brightness.
  const brightness = new Float32Array(imgW * imgH);
  for (let i = 0; i < data.length; i += 4) {
    const idx = i / 4;
    const lum = Math.max(data[i], data[i + 1], data[i + 2]) / 255.0;
    brightness[idx] = lum * (data[i + 3] / 255.0);
  }

  const clampedStride = Math.max(1, Math.min(8, stride));
  const coords = [];

  // IMPORTANT: include border pixels. Many authored _Water masks are full-bleed
  // solids (white everywhere within the tile). If the water region touches the
  // mask boundary and we skip borders, the edge detector can return 0 points.
  // We treat out-of-bounds neighbors as land (dark) so borders become valid
  // shoreline candidates.
  for (let py = 0; py < imgH; py += clampedStride) {
    for (let px = 0; px < imgW; px += clampedStride) {
      const idx = py * imgW + px;
      const b = brightness[idx];
      if (b < threshold) continue; // Not water.

      // Count dark neighbors (8-connected). Out-of-bounds counts as land.
      let darkNeighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || nx >= imgW || ny < 0 || ny >= imgH) {
            darkNeighbors++;
            continue;
          }
          const ni = ny * imgW + nx;
          if (brightness[ni] < threshold) darkNeighbors++;
        }
      }

      if (darkNeighbors === 0) continue; // Interior pixel, not an edge.

      // Edge strength: more dark neighbors = stronger edge (0..1).
      const edgeStrength = Math.min(1.0, darkNeighbors / 5.0);
      const u = px / imgW;
      const v = py / imgH;
      coords.push(u, v, edgeStrength);
    }
  }

  if (coords.length === 0) return null;
  return new Float32Array(coords);
}

// ═══════════════════════════════════════════════════════════════════════════════
// scanWaterInteriorPoints — CPU mask scanning for water interior pixels
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scan a water mask image and collect interior water pixels (non-edge) as
 * (u, v, brightness) triples. Used for rain-splash and floating-foam placement.
 *
 * @param {HTMLImageElement|ImageBitmap} image - The _Water mask image
 * @param {number} [threshold=0.15] - Minimum brightness to count as water
 * @param {number} [stride=4] - Coarser sampling for interior (many more pixels)
 * @returns {Float32Array|null} Packed (u, v, brightness) triples, or null if empty
 */
export function scanWaterInteriorPoints(image, threshold = 0.15, stride = 4) {
  if (!image) return null;

  const c = document.createElement('canvas');
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, c.width, c.height).data;
  const imgW = c.width;
  const imgH = c.height;

  const clampedStride = Math.max(1, Math.min(16, stride));
  const coords = [];

  for (let py = 0; py < imgH; py += clampedStride) {
    for (let px = 0; px < imgW; px += clampedStride) {
      const i = (py * imgW + px) * 4;
      const lum = Math.max(data[i], data[i + 1], data[i + 2]) / 255.0;
      const b = lum * (data[i + 3] / 255.0);
      if (b < threshold) continue;

      const u = px / imgW;
      const v = py / imgH;
      coords.push(u, v, b);
    }
  }

  if (coords.length === 0) return null;
  return new Float32Array(coords);
}
