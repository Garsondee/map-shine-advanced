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

// ═══════════════════════════════════════════════════════════════════════════════
// Gradient / Envelope Constants
// ═══════════════════════════════════════════════════════════════════════════════

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
    this.points = points;
    this.sceneWidth = sceneWidth;
    this.sceneHeight = sceneHeight;
    this.sceneX = sceneX;
    this.sceneY = sceneY;
    this.groundZ = groundZ;
    this.floorElevation = Number.isFinite(floorElevation) ? floorElevation : 0;
    this.type = 'water_edge_mask';
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
    this.points = points;
    this.sceneWidth = sceneWidth;
    this.sceneHeight = sceneHeight;
    this.sceneX = sceneX;
    this.sceneY = sceneY;
    this.groundZ = groundZ;
    this.floorElevation = Number.isFinite(floorElevation) ? floorElevation : 0;
    this.type = 'water_interior_mask';
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
// FoamPlumeLifecycleBehavior — Shore foam: billow, drift, fade
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lifecycle behavior for foam plume particles that appear along water edges.
 * Controls alpha envelope, size growth, color tinting, and gentle wind drift.
 */
export class FoamPlumeLifecycleBehavior {
  constructor(ownerEffect) {
    this.type = 'FoamPlumeLifecycle';
    this.ownerEffect = ownerEffect;

    // Cached per-frame state from params.
    this._peakOpacity = 0.65;
    this._foamColorR = 0.85;
    this._foamColorG = 0.90;
    this._foamColorB = 0.88;
    this._windDriftScale = 0.0;
    this._windX = 1.0;
    this._windY = 0.0;
    this._windSpeed01 = 0.0;
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
  }

  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;
    const t = age / Math.max(0.001, life);

    // Alpha envelope.
    const alphaBase = lerpScalarStops(FOAM_ALPHA_STOPS, t);
    const edgeStr = particle._edgeStrength ?? 1.0;
    const opRand = particle._foamOpacityRand ?? 1.0;
    particle.color.x = this._foamColorR;
    particle.color.y = this._foamColorG;
    particle.color.z = this._foamColorB;
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
      const driftSpeed = (15 + 80 * this._windSpeed01) * this._windDriftScale;
      particle.position.x += this._windX * driftSpeed * delta;
      particle.position.y += this._windY * driftSpeed * delta;
    }
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    this._peakOpacity = Math.max(0.0, Math.min(1.0, p?.foamPeakOpacity ?? 0.65));
    this._foamColorR = p?.foamColorR ?? 0.85;
    this._foamColorG = p?.foamColorG ?? 0.90;
    this._foamColorB = p?.foamColorB ?? 0.88;
    this._windDriftScale = Math.max(0.0, p?.foamWindDriftScale ?? 0.3);

    // Read current wind direction from weather controller.
    try {
      const state = weatherController?.getCurrentState?.();
      if (state) {
        const dir = state.windDirection;
        if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y)) {
          const len = Math.hypot(dir.x, dir.y);
          this._windX = len > 1e-6 ? (dir.x / len) : 1.0;
          this._windY = len > 1e-6 ? (dir.y / len) : 0.0;
        }
        this._windSpeed01 = Number.isFinite(state.windSpeed) ? Math.max(0, Math.min(1, state.windSpeed)) : 0;
      }
    } catch (_) {}
  }

  reset() {}
  clone() { return new FoamPlumeLifecycleBehavior(this.ownerEffect); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SplashRingLifecycleBehavior — Rain-hit splash rings on water surface
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lifecycle behavior for splash ring particles that appear when rain hits
 * the water surface. Quick pop and expand, then rapid fade.
 */
export class SplashRingLifecycleBehavior {
  constructor(ownerEffect) {
    this.type = 'SplashRingLifecycle';
    this.ownerEffect = ownerEffect;
    this._peakOpacity = 0.70;
    this._precipMult = 1.0;
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
  }

  update(particle, delta) {
    const life = particle.life;
    const age = particle.age;
    if (life <= 0) return;
    const t = age / Math.max(0.001, life);

    // Alpha: sharp pop then rapid fade.
    const alpha = lerpScalarStops(SPLASH_ALPHA_STOPS, t);
    const opRand = particle._splashOpacityRand ?? 1.0;
    // Splashes are white/translucent.
    particle.color.x = 0.95;
    particle.color.y = 0.97;
    particle.color.z = 1.00;
    particle.color.w = alpha * this._peakOpacity * opRand * this._precipMult;

    // Size: expand outward from impact.
    const sizeScale = lerpScalarStops(SPLASH_SIZE_STOPS, t);
    const baseSize = particle._splashBaseSize ?? 20;
    applyParticleScalarSize(particle, baseSize * sizeScale);
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    this._peakOpacity = Math.max(0.0, Math.min(1.0, p?.splashPeakOpacity ?? 0.70));

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
  clone() { return new SplashRingLifecycleBehavior(this.ownerEffect); }
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
