import { 
  ParticleSystem, 
  IntervalValue, 
  ColorRange, 
  Vector4, 
  RenderMode,
  ConstantValue,
  BatchedRenderer,
  ApplyForce,
  ColorOverLife,
  TurbulenceField,
  CurlNoiseField,
  SizeOverLife,
  PiecewiseBezier,
  Bezier
} from '../libs/three.quarks.module.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('WeatherParticles');
const MAX_SPLASHES = 5000;

// Avoid per-frame allocations in update(): splash tuning reads are table-driven.
const SPLASH_TUNING_KEYS = [
  {
    intensity: 'splash1IntensityScale',
    lifeMin: 'splash1LifeMin',
    lifeMax: 'splash1LifeMax',
    sizeMin: 'splash1SizeMin',
    sizeMax: 'splash1SizeMax',
    peak: 'splash1OpacityPeak'
  },
  {
    intensity: 'splash2IntensityScale',
    lifeMin: 'splash2LifeMin',
    lifeMax: 'splash2LifeMax',
    sizeMin: 'splash2SizeMin',
    sizeMax: 'splash2SizeMax',
    peak: 'splash2OpacityPeak'
  },
  {
    intensity: 'splash3IntensityScale',
    lifeMin: 'splash3LifeMin',
    lifeMax: 'splash3LifeMax',
    sizeMin: 'splash3SizeMin',
    sizeMax: 'splash3SizeMax',
    peak: 'splash3OpacityPeak'
  },
  {
    intensity: 'splash4IntensityScale',
    lifeMin: 'splash4LifeMin',
    lifeMax: 'splash4LifeMax',
    sizeMin: 'splash4SizeMin',
    sizeMax: 'splash4SizeMax',
    peak: 'splash4OpacityPeak'
  }
];

class RandomRectangleEmitter {
  constructor(parameters = {}) {
    this.type = 'random-rectangle';
    this.width = parameters.width ?? 1;
    this.height = parameters.height ?? 1;
  }

  initialize(particle) {
    const x = (Math.random() - 0.5) * this.width;
    const y = (Math.random() - 0.5) * this.height;
    particle.position.x = x;
    particle.position.y = y;
    particle.position.z = 0;
    particle.velocity.set(0, 0, particle.startSpeed);
  }

  update(system, delta) { /* no-op for now */ }
}

class FoamFleckEmitter {
  constructor(parameters = {}) {
    this.type = 'foam-fleck';
    this.width = parameters.width ?? 1;
    this.height = parameters.height ?? 1;
    this.sceneX = parameters.sceneX ?? 0;
    this.sceneY = parameters.sceneY ?? 0;
    this.totalHeight = parameters.totalHeight ?? this.height;
    this.centerX = parameters.centerX ?? (this.sceneX + this.width / 2);
    this.centerY = parameters.centerY ?? (this.sceneY + this.height / 2);
    this._offsetY = (this.totalHeight - this.sceneY - this.height);

    /** @type {Float32Array|null} Packed [u,v,nx,ny,...] shoreline points */
    this._shorePoints = null;
    /** @type {Float32Array|null} Packed [u,v,...] interior points */
    this._interiorPoints = null;

    // Spawn distribution: 0 = only shore, 1 = only interior.
    this.interiorRatio = 0.5;

    // Wind snapshot (set by WeatherParticles.update)
    this._windX = 1.0;
    this._windY = 0.0;
    this._windSpeed01 = 0.0;
    this._windAccel01 = 0.0;

    // WaterData + foam params snapshot (set by WeatherParticles.update)
    this._waterData = null;
    this._waterDataW = 0;
    this._waterDataH = 0;
    this._waterDataArr = null;

    this._foamParams = null;
    this._time = 0.0;
  }

  setShorePoints(points) {
    this._shorePoints = points && points.length ? points : null;
  }

  setInteriorPoints(points) {
    this._interiorPoints = points && points.length ? points : null;
  }

  setWind(dir, windSpeed01, windAccel01) {
    const x = Number.isFinite(dir?.x) ? dir.x : 1.0;
    const y = Number.isFinite(dir?.y) ? dir.y : 0.0;
    const len = Math.hypot(x, y);
    this._windX = len > 1e-6 ? (x / len) : 1.0;
    this._windY = len > 1e-6 ? (y / len) : 0.0;
    this._windSpeed01 = Number.isFinite(windSpeed01) ? Math.max(0.0, Math.min(1.0, windSpeed01)) : 0.0;
    this._windAccel01 = Number.isFinite(windAccel01) ? Math.max(0.0, Math.min(1.0, windAccel01)) : 0.0;
  }

  setWaterDataTexture(tex) {
    const img = tex?.image;
    const data = img?.data;
    const w = img?.width;
    const h = img?.height;
    if (data && w > 0 && h > 0) {
      this._waterData = tex;
      this._waterDataW = w;
      this._waterDataH = h;
      this._waterDataArr = data;
    } else {
      this._waterData = null;
      this._waterDataW = 0;
      this._waterDataH = 0;
      this._waterDataArr = null;
    }
  }

  setFoamParams(params, timeSeconds) {
    this._foamParams = params || null;
    this._time = Number.isFinite(timeSeconds) ? timeSeconds : 0.0;
  }

  _sampleWaterData(u, v) {
    const arr = this._waterDataArr;
    const w = this._waterDataW;
    const h = this._waterDataH;
    if (!arr || w <= 0 || h <= 0) return null;

    const x = Math.max(0, Math.min(1, u));
    const y = Math.max(0, Math.min(1, v));
    const px = Math.max(0, Math.min(w - 1, Math.floor(x * (w - 1))));
    const py = Math.max(0, Math.min(h - 1, Math.floor(y * (h - 1))));
    const o = (py * w + px) * 4;

    const r = arr[o] / 255.0;
    const g = arr[o + 1] / 255.0;
    const b = arr[o + 2] / 255.0;
    const a = arr[o + 3] / 255.0;
    return { r, g, b, a };
  }

  _hash12(ix, iy) {
    // Cheap hash for CPU-side noise (not cryptographic).
    const x = ix * 127.1 + iy * 311.7;
    const s = Math.sin(x) * 43758.5453123;
    return s - Math.floor(s);
  }

  _valueNoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3.0 - 2.0 * fx);
    const uy = fy * fy * (3.0 - 2.0 * fy);

    const a = this._hash12(ix, iy);
    const b = this._hash12(ix + 1, iy);
    const c = this._hash12(ix, iy + 1);
    const d = this._hash12(ix + 1, iy + 1);

    const ab = a + (b - a) * ux;
    const cd = c + (d - c) * ux;
    return ab + (cd - ab) * uy;
  }

  _smoothstep(edge0, edge1, x) {
    const t = Math.max(0.0, Math.min(1.0, (x - edge0) / Math.max(1e-6, (edge1 - edge0))));
    return t * t * (3.0 - 2.0 * t);
  }

  _fbmNoise(x, y) {
    // Matches WaterEffectV2.fb mNoise() roughly (4 octaves).
    let sum = 0.0;
    let amp = 0.55;
    let freq = 1.0;
    for (let i = 0; i < 4; i++) {
      sum += (this._valueNoise(x * freq, y * freq) - 0.5) * 2.0 * amp;
      freq *= 2.0;
      amp *= 0.55;
    }
    return sum;
  }

  _computeFoamAmount(u, v) {
    // We approximate WaterEffectV2's foam amount. This is evaluated only on particle spawn
    // attempts, not per-frame, so it stays cheap.
    const p = this._foamParams;
    const wd = this._sampleWaterData(u, v);
    // If WaterData isn't available yet, don't hard-disable the entire effect.
    // We fall back to "always eligible" so the system remains visible.
    if (!wd) return 1.0;

    const sdf01 = wd.r;
    const exposure01 = wd.g;

    // Match WaterEffectV2.waterInsideFromSdf(): smoothstep(0.52, 0.48, sdf01)
    const inside = this._smoothstep(0.52, 0.48, sdf01);
    const shore = Math.max(0.0, Math.min(1.0, exposure01));

    const foamStrength = Number.isFinite(p?.foamStrength) ? Math.max(0.0, Math.min(1.0, p.foamStrength)) : 1.0;
    const foamThreshold = Number.isFinite(p?.foamThreshold) ? Math.max(0.0, Math.min(1.0, p.foamThreshold)) : 0.98;
    const foamScale = Number.isFinite(p?.foamScale) ? Math.max(0.1, p.foamScale) : 443.0;
    const foamSpeed = Number.isFinite(p?.foamSpeed) ? p.foamSpeed : 0.18;
    const b1Strength = Number.isFinite(p?.foamBreakupStrength1) ? Math.max(0.0, Math.min(1.0, p.foamBreakupStrength1)) : 1.0;
    const b1Scale = Number.isFinite(p?.foamBreakupScale1) ? Math.max(0.1, p.foamBreakupScale1) : 5.2;
    const b1Speed = Number.isFinite(p?.foamBreakupSpeed1) ? p.foamBreakupSpeed1 : 0.2;
    const b2Strength = Number.isFinite(p?.foamBreakupStrength2) ? Math.max(0.0, Math.min(1.0, p.foamBreakupStrength2)) : 1.0;
    const b2Scale = Number.isFinite(p?.foamBreakupScale2) ? Math.max(0.1, p.foamBreakupScale2) : 90.6;
    const b2Speed = Number.isFinite(p?.foamBreakupSpeed2) ? p.foamBreakupSpeed2 : 0.28;
    const floatingStrength = Number.isFinite(p?.floatingFoamStrength) ? Math.max(0.0, Math.min(1.0, p.floatingFoamStrength)) : 0.0;

    const sceneAspect = (this.height > 1e-6) ? (this.width / this.height) : 1.0;
    const t = this._time;

    // Roughly mimic WaterEffectV2's foam advection basis: foamSceneUv = sceneUv - (uWindOffsetUv*0.5)
    // We don't have uWindOffsetUv on CPU, so approximate it using time + foamSpeed in wind direction.
    const driftX = (t * (0.02 + foamSpeed * 0.05)) * this._windX;
    const driftY = (t * (0.01 + foamSpeed * 0.03)) * this._windY;
    const foamSceneU = u - driftX * 0.5;
    const foamSceneV = v - driftY * 0.5;

    // WaterEffectV2 foamBasis: vec2(foamSceneUv.x * sceneAspect, foamSceneUv.y)
    // (Curl warp omitted on CPU; breakup + bubbles is enough to align spawn with visible foam.)
    const foamBasisX = foamSceneU * sceneAspect;
    const foamBasisY = foamSceneV;

    // Bubbles: valueNoise at foamScale, time-shifted
    const foamUvX = foamBasisX * foamScale + (t * foamSpeed * 0.5);
    const foamUvY = foamBasisY * foamScale + (t * foamSpeed * 0.5);
    const f1 = this._valueNoise(foamUvX, foamUvY);
    const f2 = this._valueNoise(foamUvX * 1.7 + 1.2, foamUvY * 1.7 + 1.2);
    const bubbles = (f1 + f2) * 0.5;

    // Breakup layers: fbmNoise at two scales.
    const bb1 = this._fbmNoise(
      foamBasisX * b1Scale + (t * b1Speed),
      foamBasisY * b1Scale + (-t * b1Speed * 0.8)
    );
    const bb2 = this._fbmNoise(
      foamBasisX * b2Scale + (-t * b2Speed * 0.6),
      foamBasisY * b2Scale + (t * b2Speed)
    );
    let breakup = 0.5 + 0.5 * (bb1 * b1Strength + bb2 * b2Strength);
    breakup = Math.max(0.0, Math.min(1.0, breakup));

    // WaterEffectV2 foamMask shaping
    let foamMask = shore + (bubbles * 0.3 - 0.15) + (breakup - 0.5) * 0.35;
    let shoreFoamAmount = this._smoothstep(foamThreshold, foamThreshold - 0.15, foamMask);
    shoreFoamAmount *= this._smoothstep(0.15, 0.85, breakup);
    shoreFoamAmount *= inside * foamStrength;

    // Floating foam: match shader clumps logic more closely.
    let floatingFoamAmount = 0.0;
    if (floatingStrength > 1e-4) {
      const cov = Number.isFinite(p?.floatingFoamCoverage) ? Math.max(0.0, Math.min(1.0, p.floatingFoamCoverage)) : 0.2;
      const scale = Number.isFinite(p?.floatingFoamScale) ? Math.max(0.1, p.floatingFoamScale) : 150.0;

      // Use the same aspect-correct basis as shoreline foam so clumps align in world space.
      const clumpUx = foamBasisX * scale + (t * (0.02 + foamSpeed * 0.05));
      const clumpUy = foamBasisY * scale + (t * (0.01 + foamSpeed * 0.03));
      const c1 = this._valueNoise(clumpUx, clumpUy);
      const c2 = this._valueNoise(clumpUx * 2.1 + 5.2, clumpUy * 2.1 + 5.2);
      const c = c1 * 0.7 + c2 * 0.3;
      const clumps = this._smoothstep(1.0 - cov, 1.0, c);
      const grain = this._valueNoise(clumpUx * 4.0 + 1.3, clumpUy * 4.0 + 7.9);
      const gMask = this._smoothstep(0.30, 0.75, grain);
      const deepMask = this._smoothstep(0.15, 0.65, 1.0 - shore);
      floatingFoamAmount = clumps * gMask * inside * floatingStrength * deepMask;
    }

    let foamAmount = Math.max(0.0, Math.min(1.0, shoreFoamAmount + floatingFoamAmount));

    // Apply the same CC shaping controls as the shader so "white foam" in UI corresponds
    // to "spawn-eligible" on CPU.
    const bp = Number.isFinite(p?.foamBlackPoint) ? Math.max(0.0, Math.min(1.0, p.foamBlackPoint)) : 0.13;
    const wp = Number.isFinite(p?.foamWhitePoint) ? Math.max(0.0, Math.min(1.0, p.foamWhitePoint)) : 0.5;
    foamAmount = Math.max(0.0, Math.min(1.0, (foamAmount - bp) / Math.max(1e-5, (wp - bp))));
    const gamma = Number.isFinite(p?.foamGamma) ? Math.max(0.01, p.foamGamma) : 0.54;
    foamAmount = Math.pow(foamAmount, gamma);
    const contrast = Number.isFinite(p?.foamContrast) ? Math.max(0.0, p.foamContrast) : 1.0;
    foamAmount = (foamAmount - 0.5) * contrast + 0.5;
    const bright = Number.isFinite(p?.foamBrightness) ? p.foamBrightness : 0.0;
    foamAmount = Math.max(0.0, Math.min(1.0, foamAmount + bright));

    return foamAmount;
  }

  _spawnFromShore(particle) {
    const pts = this._shorePoints;
    if (!pts || pts.length < 4) return false;

    const count = Math.floor(pts.length / 4);
    if (count <= 0) return false;

    const p = this._foamParams;
    const attempts = Number.isFinite(p?.foamFlecksSpawnAttempts)
      ? Math.max(1, Math.floor(p.foamFlecksSpawnAttempts))
      : 8;
    const outdoorsThreshold = Number.isFinite(p?.foamFlecksOutdoorsThreshold)
      ? Math.max(0.0, Math.min(1.0, p.foamFlecksOutdoorsThreshold))
      : 0.5;
    const foamThresholdShore = Number.isFinite(p?.foamFlecksFoamThresholdShore)
      ? Math.max(0.0, Math.min(1.0, p.foamFlecksFoamThresholdShore))
      : 0.55;
    const ignoreOutdoors = p?.foamFlecksDebugIgnoreOutdoors === true;
    const ignoreFoamGate = p?.foamFlecksDebugIgnoreFoamGate === true;

    // Outdoors-only gating: attempt a handful of samples.
    for (let attempt = 0; attempt < attempts; attempt++) {
      const idx = (Math.floor(Math.random() * count) * 4);
      const u = pts[idx];
      const v = pts[idx + 1];
      const nx = pts[idx + 2];
      const ny = pts[idx + 3];

      // Outdoors mask: 0 = indoors, 1 = outdoors
      const vMask = (weatherController?.roofMap?.flipY === true) ? (1.0 - v) : v;
      const outdoor = weatherController?.getRoofMaskIntensity
        ? weatherController.getRoofMaskIntensity(u, vMask)
        : 1.0;
      if (!ignoreOutdoors && outdoor < outdoorsThreshold) continue;

      // Only spawn from "white" foam regions.
      const foam01 = this._computeFoamAmount(u, v);
      if (!ignoreFoamGate && foam01 < foamThresholdShore) continue;

      const worldX = this.sceneX + u * this.width;
      const worldY = this._offsetY + (1.0 - v) * this.height;

      particle.position.x = worldX - this.centerX;
      particle.position.y = worldY - this.centerY;
      // Spawn slightly above the landing plane so flecks are visible airborne
      // before FoamFleckBehavior transitions them into the landed state.
      particle.position.z = 30 + Math.random() * 40;

      // Initial motion: small upward hop + wind drift + edge normal kick.
      const w = this._windSpeed01;
      const a = this._windAccel01;
      const hop = 90 + 320 * a + 120 * w;

      // Slight push off the shoreline normal.
      const nLen = Math.hypot(nx, ny);
      const nX = nLen > 1e-6 ? (nx / nLen) : 1.0;
      const nY = nLen > 1e-6 ? (ny / nLen) : 0.0;

      const driftScale = Number.isFinite(p?.foamFlecksWindDriftScale) ? Math.max(0.0, p.foamFlecksWindDriftScale) : 1.0;
      const drift = (60 + 220 * w) * (0.25 + 0.75 * a) * driftScale;
      const jitter = 35;

      particle.velocity.set(
        this._windX * drift + nX * (30 + 70 * w) + (Math.random() - 0.5) * jitter,
        this._windY * drift + nY * (30 + 70 * w) + (Math.random() - 0.5) * jitter,
        hop + (Math.random() * 60)
      );
      return true;
    }

    return false;
  }

  _spawnFromInterior(particle) {
    const pts = this._interiorPoints;
    if (!pts || pts.length < 2) return false;

    const count = Math.floor(pts.length / 2);
    const p = this._foamParams;
    const attempts = Number.isFinite(p?.foamFlecksSpawnAttempts)
      ? Math.max(1, Math.floor(p.foamFlecksSpawnAttempts))
      : 8;
    const outdoorsThreshold = Number.isFinite(p?.foamFlecksOutdoorsThreshold)
      ? Math.max(0.0, Math.min(1.0, p.foamFlecksOutdoorsThreshold))
      : 0.5;
    const foamThresholdInterior = Number.isFinite(p?.foamFlecksFoamThresholdInterior)
      ? Math.max(0.0, Math.min(1.0, p.foamFlecksFoamThresholdInterior))
      : 0.62;
    const ignoreOutdoors = p?.foamFlecksDebugIgnoreOutdoors === true;
    const ignoreFoamGate = p?.foamFlecksDebugIgnoreFoamGate === true;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const idx = (Math.floor(Math.random() * count) * 2);
      const u = pts[idx];
      const v = pts[idx + 1];

      const vMask = (weatherController?.roofMap?.flipY === true) ? (1.0 - v) : v;
      const outdoor = weatherController?.getRoofMaskIntensity
        ? weatherController.getRoofMaskIntensity(u, vMask)
        : 1.0;
      if (!ignoreOutdoors && outdoor < outdoorsThreshold) continue;

      // Interior flecks should come from floating foam clumps / bright foam, not arbitrary water.
      const foam01 = this._computeFoamAmount(u, v);
      if (!ignoreFoamGate && foam01 < foamThresholdInterior) continue;

      const worldX = this.sceneX + u * this.width;
      const worldY = this._offsetY + (1.0 - v) * this.height;

      particle.position.x = worldX - this.centerX;
      particle.position.y = worldY - this.centerY;
      // Spawn slightly above the landing plane so interior-based flecks don't
      // instantly enter the landed state on their first update.
      particle.position.z = 30 + Math.random() * 40;

      const w = this._windSpeed01;
      const a = this._windAccel01;
      const hop = 80 + 280 * a + 90 * w;
      const driftScale = Number.isFinite(p?.foamFlecksWindDriftScale) ? Math.max(0.0, p.foamFlecksWindDriftScale) : 1.0;
      const drift = (80 + 280 * w) * (0.35 + 0.65 * a) * driftScale;
      const jitter = 45;

      particle.velocity.set(
        this._windX * drift + (Math.random() - 0.5) * jitter,
        this._windY * drift + (Math.random() - 0.5) * jitter,
        hop + (Math.random() * 50)
      );
      return true;
    }

    return false;
  }

  initialize(particle) {
    const preferInterior = Math.random() < this.interiorRatio;
    const hasInterior = !!(this._interiorPoints && this._interiorPoints.length >= 2);
    const hasShore = !!(this._shorePoints && this._shorePoints.length >= 4);

    let ok = false;
    if (preferInterior && hasInterior) ok = this._spawnFromInterior(particle);
    if (!ok && hasShore) ok = this._spawnFromShore(particle);
    if (!ok && hasInterior) ok = this._spawnFromInterior(particle);

    if (!ok) {
      // Nothing valid to spawn from.
      if (typeof particle.life === 'number') particle.age = particle.life;
      else particle.age = 1e9;
    }
  }

  update(system, delta) { /* no-op */ }
}

class ShorelineFoamEmitter {
  constructor(parameters = {}) {
    this.type = 'shoreline-foam';
    this.width = parameters.width ?? 1;
    this.height = parameters.height ?? 1;
    this.sceneX = parameters.sceneX ?? 0;
    this.sceneY = parameters.sceneY ?? 0;
    this.totalHeight = parameters.totalHeight ?? this.height;
    this.centerX = parameters.centerX ?? (this.sceneX + this.width / 2);
    this.centerY = parameters.centerY ?? (this.sceneY + this.height / 2);
    this._offsetY = (this.totalHeight - this.sceneY - this.height);

    this._points = null;

    // Large-scale noise gating (driven from WaterEffectV2 via WeatherParticles.update)
    this._foamParams = null;
    this._time = 0.0;
  }

  setFoamParams(params, timeSeconds) {
    this._foamParams = params || null;
    this._time = Number.isFinite(timeSeconds) ? timeSeconds : 0.0;
  }

  _hash12(ix, iy) {
    const x = ix * 127.1 + iy * 311.7;
    const s = Math.sin(x) * 43758.5453123;
    return s - Math.floor(s);
  }

  _valueNoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3.0 - 2.0 * fx);
    const uy = fy * fy * (3.0 - 2.0 * fy);

    const a = this._hash12(ix, iy);
    const b = this._hash12(ix + 1, iy);
    const c = this._hash12(ix, iy + 1);
    const d = this._hash12(ix + 1, iy + 1);

    const ab = a + (b - a) * ux;
    const cd = c + (d - c) * ux;
    return ab + (cd - ab) * uy;
  }

  _smoothstep(edge0, edge1, x) {
    const t = Math.max(0.0, Math.min(1.0, (x - edge0) / Math.max(1e-6, (edge1 - edge0))));
    return t * t * (3.0 - 2.0 * t);
  }

  _evolvingNoise01(u, v, scale, speed, seed) {
    // "Evolving" noise: smoothly morph between two unrelated noise fields over time.
    // This avoids obvious panning/translation while still animating the pattern.
    const s = Number.isFinite(speed) ? speed : 0.0;
    const sc = Number.isFinite(scale) ? Math.max(1e-6, scale) : 1.0;
    const t = this._time;

    // Speed of 0 -> static field.
    if (Math.abs(s) <= 1e-6) {
      const ox = this._hash12(seed * 11 + 1, seed * 17 + 2) * 1024.0;
      const oy = this._hash12(seed * 13 + 3, seed * 19 + 4) * 1024.0;
      return this._valueNoise(u * sc + ox, v * sc + oy);
    }

    const phase = t * s;
    const i = Math.floor(phase);
    const f = phase - i;
    const w = f * f * (3.0 - 2.0 * f);

    const ox1 = this._hash12(i + seed * 11 + 1, seed * 17 + 2) * 1024.0;
    const oy1 = this._hash12(i + seed * 13 + 3, seed * 19 + 4) * 1024.0;
    const ox2 = this._hash12(i + 1 + seed * 11 + 1, seed * 17 + 2) * 1024.0;
    const oy2 = this._hash12(i + 1 + seed * 13 + 3, seed * 19 + 4) * 1024.0;

    const n1 = this._valueNoise(u * sc + ox1, v * sc + oy1);
    const n2 = this._valueNoise(u * sc + ox2, v * sc + oy2);
    return n1 + (n2 - n1) * w;
  }

  _noiseGate(u, v) {
    const p = this._foamParams;
    if (!p || p.foamParticleNoiseEnabled !== true) return 1.0;

    const strength1 = Number.isFinite(p.foamParticleNoiseStrength) ? Math.max(0.0, Math.min(1.0, p.foamParticleNoiseStrength)) : 1.0;
    const enabled2 = p.foamParticleNoise2Enabled === true;
    const strength2 = enabled2
      ? (Number.isFinite(p.foamParticleNoise2Strength) ? Math.max(0.0, Math.min(1.0, p.foamParticleNoise2Strength)) : 1.0)
      : 0.0;
    if (strength1 <= 1e-6 && strength2 <= 1e-6) return 1.0;

    // Noise #1 (typically "large" cutout)
    const scale1 = Number.isFinite(p.foamParticleNoiseScale) ? Math.max(0.01, p.foamParticleNoiseScale) : 6.0;
    const speed1 = Number.isFinite(p.foamParticleNoiseSpeed) ? p.foamParticleNoiseSpeed : 0.35;
    const coverage1 = Number.isFinite(p.foamParticleNoiseCoverage) ? Math.max(0.0, Math.min(1.0, p.foamParticleNoiseCoverage)) : 0.55;
    const soft1 = Number.isFinite(p.foamParticleNoiseSoftness) ? Math.max(0.0, Math.min(0.5, p.foamParticleNoiseSoftness)) : 0.08;

    const n1 = this._evolvingNoise01(u, v, scale1, speed1, 101);
    const th1 = 1.0 - coverage1;
    const m1 = this._smoothstep(th1 - soft1, th1 + soft1, n1);

    // Noise #2 (typically "small" cutout)
    let m2 = 1.0;
    if (strength2 > 1e-6) {
      const scale2 = Number.isFinite(p.foamParticleNoise2Scale) ? Math.max(0.01, p.foamParticleNoise2Scale) : 35.0;
      const speed2 = Number.isFinite(p.foamParticleNoise2Speed) ? p.foamParticleNoise2Speed : 0.35;
      const coverage2 = Number.isFinite(p.foamParticleNoise2Coverage) ? Math.max(0.0, Math.min(1.0, p.foamParticleNoise2Coverage)) : 0.55;
      const soft2 = Number.isFinite(p.foamParticleNoise2Softness) ? Math.max(0.0, Math.min(0.5, p.foamParticleNoise2Softness)) : 0.08;

      const n2 = this._evolvingNoise01(u, v, scale2, speed2, 203);
      const th2 = 1.0 - coverage2;
      m2 = this._smoothstep(th2 - soft2, th2 + soft2, n2);
    }

    // Each noise has an independent "strength" (blend toward passthrough), then we
    // intersect them so both can carve out regions.
    const g1 = (1.0 - strength1) + strength1 * m1;
    const g2 = (1.0 - strength2) + strength2 * m2;
    return Math.max(0.0, Math.min(1.0, g1 * g2));
  }

  setPoints(points) {
    this._points = points && points.length ? points : null;
  }

  clearPoints() {
    this._points = null;
  }

  initialize(particle) {
    const pts = this._points;
    if (pts && pts.length >= 4) {
      const count = Math.floor(pts.length / 4);

      const p = this._foamParams;
      const attempts = Number.isFinite(p?.foamParticleNoiseAttempts)
        ? Math.max(1, Math.floor(p.foamParticleNoiseAttempts))
        : 6;

      let u = 0;
      let v = 0;
      let nx = 1;
      let ny = 0;
      let ok = false;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const idx = (Math.floor(Math.random() * count) * 4);
        u = pts[idx];
        v = pts[idx + 1];
        nx = pts[idx + 2];
        ny = pts[idx + 3];

        const gate = this._noiseGate(u, v);
        if (Math.random() <= gate) {
          ok = true;
          break;
        }
      }

      if (!ok) {
        if (typeof particle.life === 'number') particle.age = particle.life;
        else particle.age = 1e9;
        return;
      }

      const worldX = this.sceneX + u * this.width;
      const worldY = this._offsetY + (1.0 - v) * this.height;

      particle.position.x = worldX - this.centerX;
      particle.position.y = worldY - this.centerY;
      particle.position.z = 0;

      if (typeof particle.rotation === 'number') {
        particle.rotation = Math.atan2(ny, nx);
      }

      particle.velocity.set(0, 0, particle.startSpeed);
      return;
    }

    const x = (Math.random() - 0.5) * this.width;
    const y = (Math.random() - 0.5) * this.height;
    particle.position.x = x;
    particle.position.y = y;
    particle.position.z = 0;
    particle.velocity.set(0, 0, particle.startSpeed);
  }

  update(system, delta) { /* no-op for now */ }
}

class WaterMaskedSplashEmitter {
  constructor(parameters = {}) {
    this.type = 'water-masked-splash';
    this.width = parameters.width ?? 1;
    this.height = parameters.height ?? 1;
    this.sceneX = parameters.sceneX ?? 0;
    this.sceneY = parameters.sceneY ?? 0;
    this.totalHeight = parameters.totalHeight ?? this.height;
    this.centerX = parameters.centerX ?? (this.sceneX + this.width / 2);
    this.centerY = parameters.centerY ?? (this.sceneY + this.height / 2);
    this._offsetY = (this.totalHeight - this.sceneY - this.height);

    this._points = null;

    // Large-scale noise gating (driven from WaterEffectV2 via WeatherParticles.update)
    this._foamParams = null;
    this._time = 0.0;
  }

  setFoamParams(params, timeSeconds) {
    this._foamParams = params || null;
    this._time = Number.isFinite(timeSeconds) ? timeSeconds : 0.0;
  }

  _hash12(ix, iy) {
    const x = ix * 127.1 + iy * 311.7;
    const s = Math.sin(x) * 43758.5453123;
    return s - Math.floor(s);
  }

  _valueNoise(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * (3.0 - 2.0 * fx);
    const uy = fy * fy * (3.0 - 2.0 * fy);

    const a = this._hash12(ix, iy);
    const b = this._hash12(ix + 1, iy);
    const c = this._hash12(ix, iy + 1);
    const d = this._hash12(ix + 1, iy + 1);

    const ab = a + (b - a) * ux;
    const cd = c + (d - c) * ux;
    return ab + (cd - ab) * uy;
  }

  _smoothstep(edge0, edge1, x) {
    const t = Math.max(0.0, Math.min(1.0, (x - edge0) / Math.max(1e-6, (edge1 - edge0))));
    return t * t * (3.0 - 2.0 * t);
  }

  _evolvingNoise01(u, v, scale, speed, seed) {
    const s = Number.isFinite(speed) ? speed : 0.0;
    const sc = Number.isFinite(scale) ? Math.max(1e-6, scale) : 1.0;
    const t = this._time;

    if (Math.abs(s) <= 1e-6) {
      const ox = this._hash12(seed * 11 + 1, seed * 17 + 2) * 1024.0;
      const oy = this._hash12(seed * 13 + 3, seed * 19 + 4) * 1024.0;
      return this._valueNoise(u * sc + ox, v * sc + oy);
    }

    const phase = t * s;
    const i = Math.floor(phase);
    const f = phase - i;
    const w = f * f * (3.0 - 2.0 * f);

    const ox1 = this._hash12(i + seed * 11 + 1, seed * 17 + 2) * 1024.0;
    const oy1 = this._hash12(i + seed * 13 + 3, seed * 19 + 4) * 1024.0;
    const ox2 = this._hash12(i + 1 + seed * 11 + 1, seed * 17 + 2) * 1024.0;
    const oy2 = this._hash12(i + 1 + seed * 13 + 3, seed * 19 + 4) * 1024.0;

    const n1 = this._valueNoise(u * sc + ox1, v * sc + oy1);
    const n2 = this._valueNoise(u * sc + ox2, v * sc + oy2);
    return n1 + (n2 - n1) * w;
  }

  _noiseGate(u, v) {
    const p = this._foamParams;
    if (!p || p.foamParticleNoiseEnabled !== true) return 1.0;

    const strength1 = Number.isFinite(p.foamParticleNoiseStrength) ? Math.max(0.0, Math.min(1.0, p.foamParticleNoiseStrength)) : 1.0;
    const enabled2 = p.foamParticleNoise2Enabled === true;
    const strength2 = enabled2
      ? (Number.isFinite(p.foamParticleNoise2Strength) ? Math.max(0.0, Math.min(1.0, p.foamParticleNoise2Strength)) : 1.0)
      : 0.0;
    if (strength1 <= 1e-6 && strength2 <= 1e-6) return 1.0;

    const scale1 = Number.isFinite(p.foamParticleNoiseScale) ? Math.max(0.01, p.foamParticleNoiseScale) : 6.0;
    const speed1 = Number.isFinite(p.foamParticleNoiseSpeed) ? p.foamParticleNoiseSpeed : 0.35;
    const coverage1 = Number.isFinite(p.foamParticleNoiseCoverage) ? Math.max(0.0, Math.min(1.0, p.foamParticleNoiseCoverage)) : 0.55;
    const soft1 = Number.isFinite(p.foamParticleNoiseSoftness) ? Math.max(0.0, Math.min(0.5, p.foamParticleNoiseSoftness)) : 0.08;

    const n1 = this._evolvingNoise01(u, v, scale1, speed1, 101);
    const th1 = 1.0 - coverage1;
    const m1 = this._smoothstep(th1 - soft1, th1 + soft1, n1);

    let m2 = 1.0;
    if (strength2 > 1e-6) {
      const scale2 = Number.isFinite(p.foamParticleNoise2Scale) ? Math.max(0.01, p.foamParticleNoise2Scale) : 35.0;
      const speed2 = Number.isFinite(p.foamParticleNoise2Speed) ? p.foamParticleNoise2Speed : 0.35;
      const coverage2 = Number.isFinite(p.foamParticleNoise2Coverage) ? Math.max(0.0, Math.min(1.0, p.foamParticleNoise2Coverage)) : 0.55;
      const soft2 = Number.isFinite(p.foamParticleNoise2Softness) ? Math.max(0.0, Math.min(0.5, p.foamParticleNoise2Softness)) : 0.08;

      const n2 = this._evolvingNoise01(u, v, scale2, speed2, 203);
      const th2 = 1.0 - coverage2;
      m2 = this._smoothstep(th2 - soft2, th2 + soft2, n2);
    }

    const g1 = (1.0 - strength1) + strength1 * m1;
    const g2 = (1.0 - strength2) + strength2 * m2;
    return Math.max(0.0, Math.min(1.0, g1 * g2));
  }

  setPoints(points) {
    this._points = points && points.length ? points : null;
  }

  clearPoints() {
    this._points = null;
  }

  initialize(particle) {
    const pts = this._points;
    if (pts && pts.length >= 2) {
      const count = Math.floor(pts.length / 2);

      const p = this._foamParams;
      const attempts = Number.isFinite(p?.foamParticleNoiseAttempts)
        ? Math.max(1, Math.floor(p.foamParticleNoiseAttempts))
        : 6;

      let u = 0;
      let v = 0;
      let ok = false;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const idx = (Math.floor(Math.random() * count) * 2);
        u = pts[idx];
        v = pts[idx + 1];

        const gate = this._noiseGate(u, v);
        if (Math.random() <= gate) {
          ok = true;
          break;
        }
      }

      if (!ok) {
        if (typeof particle.life === 'number') particle.age = particle.life;
        else particle.age = 1e9;
        return;
      }

      const worldX = this.sceneX + u * this.width;
      const worldY = this._offsetY + (1.0 - v) * this.height;

      particle.position.x = worldX - this.centerX;
      particle.position.y = worldY - this.centerY;
      particle.position.z = 0;
      particle.velocity.set(0, 0, particle.startSpeed);
      return;
    }

    const x = (Math.random() - 0.5) * this.width;
    const y = (Math.random() - 0.5) * this.height;
    particle.position.x = x;
    particle.position.y = y;
    particle.position.z = 0;
    particle.velocity.set(0, 0, particle.startSpeed);
  }

  update(system, delta) { /* no-op for now */ }
}

// Behavior: kill particles once they leave the world volume.
//
// Quarks runs all behaviors on the CPU each frame. Particles are removed
// from the system when `particle.died` becomes true, which in turn is
// driven by `particle.age >= particle.life` in the core update loop.
//
// This behavior therefore:
// 1. Converts the particle position into WORLD space (using emitter.matrixWorld)
//    so the test matches Foundry's scene rectangle.
// 2. Compares that world position against a world-space AABB.
// 3. Forces `age >= life` when a particle exits the box so Quarks culls it
//    immediately on the next core update.
//
// The world-space AABB itself is defined once in _initSystems from
// canvas.dimensions: [sceneX, sceneY, sceneWidth, sceneHeight] in X/Y and
// fixed 0..7500 in Z, matching the "scene volume" we treat as valid world.
// Any particle outside that 3D box is considered out-of-world and safe to cull.
class WorldVolumeKillBehavior {
  constructor(min, max) {
    this.type = 'WorldVolumeKill';
    this.enabled = true;
    this.min = min.clone();
    this.max = max.clone();
    // PERFORMANCE FIX: Reuse a single Vector3 for world-space transforms
    // instead of allocating a new one per particle per frame.
    // This eliminates massive GC pressure that caused pan/zoom hitches.
    this._tempVec = new window.THREE.Vector3();
  }

  initialize(particle, system) { /* no-op */ }

  update(particle, delta, system) {
    if (this.enabled === false) return;
    const p = particle.position;
    if (!p) return;

    // Convert to world space using the emitter's matrixWorld when available,
    // so this behavior works whether the system uses local or world space.
    let wx = p.x;
    let wy = p.y;
    let wz = p.z;

    if (system && system.emitter && system.emitter.matrixWorld) {
      // PERFORMANCE: Reuse _tempVec instead of allocating new Vector3
      this._tempVec.set(p.x, p.y, p.z);
      this._tempVec.applyMatrix4(system.emitter.matrixWorld);
      wx = this._tempVec.x;
      wy = this._tempVec.y;
      wz = this._tempVec.z;
    }

    if (
      wx < this.min.x || wx > this.max.x ||
      wy < this.min.y || wy > this.max.y ||
      wz < this.min.z || wz > this.max.z
    ) {
      // Mark particle as dead by forcing its age beyond lifetime.
      if (typeof particle.life === 'number') {
        particle.age = particle.life;
      } else {
        // Fallback: very large age so any age>=life check passes.
        particle.age = 1e9;
      }
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    return new WorldVolumeKillBehavior(this.min, this.max);
  }

  reset() { /* no-op */ }
}

class FoamFleckBehavior {
  constructor() {
    this.type = 'FoamFleck';
    this.gravity = 950;
    this.landedDuration = 1.6;

    // Scales how strongly foam flecks drift with wind direction.
    // 0 = no wind-driven drift, 1 = current default behavior.
    this.windDriftScale = 1.0;

    this._groundZ = null;
    this._tempVec = null;

    // Optional water flow data (from WaterEffectV2 tWaterData).
    // Used only while landed to approximate "drift with water distortion".
    this._waterDataArr = null;
    this._waterDataW = 0;
    this._waterDataH = 0;
    this._sceneBounds = null; // THREE.Vector4(sceneX, sceneY, sceneW, sceneH)

    this._windX = 1.0;
    this._windY = 0.0;
    this._windSpeed01 = 0.0;
  }

  setWaterDataTexture(tex, sceneBoundsVec4) {
    const img = tex?.image;
    const data = img?.data;
    const w = img?.width;
    const h = img?.height;
    if (data && w > 0 && h > 0) {
      this._waterDataArr = data;
      this._waterDataW = w;
      this._waterDataH = h;
    } else {
      this._waterDataArr = null;
      this._waterDataW = 0;
      this._waterDataH = 0;
    }
    this._sceneBounds = sceneBoundsVec4 || null;
  }

  setWind(dir, windSpeed01) {
    const x = Number.isFinite(dir?.x) ? dir.x : 1.0;
    const y = Number.isFinite(dir?.y) ? dir.y : 0.0;
    const len = Math.hypot(x, y);
    this._windX = len > 1e-6 ? (x / len) : 1.0;
    this._windY = len > 1e-6 ? (y / len) : 0.0;
    this._windSpeed01 = Number.isFinite(windSpeed01) ? Math.max(0.0, Math.min(1.0, windSpeed01)) : 0.0;
  }

  _getGroundZ() {
    if (this._groundZ !== null) return this._groundZ;
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer && typeof sceneComposer.groundZ === 'number') {
      this._groundZ = sceneComposer.groundZ;
      return this._groundZ;
    }
    return 1000;
  }

  initialize(particle, system) {
    if (!particle) return;
    particle._landed = false;
    particle._landedAgeStart = 0;
    particle._landedBaseAlpha = undefined;
    particle._landedPhase = undefined;
  }

  update(particle, delta, system) {
    if (!particle || !particle.position) return;

    // Airborne physics: apply gravity + mild drag.
    if (!particle._landed && particle.velocity) {
      // Keep flecks moving with evolving wind (not just their spawn impulse).
      // This is a light continuous push, not a full force field.
      const s = Number.isFinite(this.windDriftScale) ? Math.max(0.0, this.windDriftScale) : 1.0;
      const windAccel = 220 * this._windSpeed01 * s;
      particle.velocity.x += this._windX * windAccel * delta;
      particle.velocity.y += this._windY * windAccel * delta;

      particle.velocity.z -= this.gravity * delta;
      particle.velocity.x *= 0.992;
      particle.velocity.y *= 0.992;
    }

    // Landing detection in world space.
    const groundZ = this._getGroundZ();
    const landingZ = groundZ + 10;
    let z = particle.position.z;
    const THREE = window.THREE;
    if (system && system.emitter && system.emitter.matrixWorld && THREE) {
      if (!this._tempVec) this._tempVec = new THREE.Vector3();
      this._tempVec.set(particle.position.x, particle.position.y, particle.position.z);
      this._tempVec.applyMatrix4(system.emitter.matrixWorld);
      z = this._tempVec.z;
    }

    if (!particle._landed && z <= landingZ) {
      particle._landed = true;
      particle._landedAgeStart = typeof particle.age === 'number' ? particle.age : 0;
      particle._landedBaseAlpha = particle.color ? particle.color.w : 1.0;
      particle._landedPhase = Math.random() * Math.PI * 2;
      if (particle.velocity) particle.velocity.set(0, 0, 0);
    }

    // Landed: drift briefly (approximate water motion), then fade out and die.
    if (particle._landed) {
      const startAge = particle._landedAgeStart || 0;
      const t = this.landedDuration > 1e-6
        ? Math.min(Math.max((particle.age - startAge) / this.landedDuration, 0), 1)
        : 1;

      // Drift along wind, plus optional water flow field so they "stick" to water motion.
      const s = Number.isFinite(this.windDriftScale) ? Math.max(0.0, this.windDriftScale) : 1.0;
      const driftSpeed = (18 + 65 * this._windSpeed01) * s;
      const phase = particle._landedPhase || 0;
      const wobble = Math.sin((particle.age * 9.0) + phase) * 4.0;

      let flowX = 0.0;
      let flowY = 0.0;
      const arr = this._waterDataArr;
      const sb = this._sceneBounds;
      if (arr && sb && this._waterDataW > 0 && this._waterDataH > 0 && system?.emitter?.matrixWorld) {
        // Sample the BA channels of WaterData (packed flow normal) at the particle's world XY.
        // Note: sceneBounds is Y-up. WaterEffectV2 samples tWaterData in sceneUv with V flipped.
        const THREE = window.THREE;
        if (THREE) {
          if (!this._tempVec) this._tempVec = new THREE.Vector3();
          this._tempVec.set(particle.position.x, particle.position.y, particle.position.z);
          this._tempVec.applyMatrix4(system.emitter.matrixWorld);

          const u = (this._tempVec.x - sb.x) / Math.max(1e-6, sb.z);
          const v = 1.0 - ((this._tempVec.y - sb.y) / Math.max(1e-6, sb.w));
          if (u >= 0.0 && u <= 1.0 && v >= 0.0 && v <= 1.0) {
            const w = this._waterDataW;
            const h = this._waterDataH;
            const px = Math.max(0, Math.min(w - 1, Math.floor(u * (w - 1))));
            const py = Math.max(0, Math.min(h - 1, Math.floor(v * (h - 1))));
            const o = (py * w + px) * 4;
            const b = arr[o + 2] / 255.0;
            const a = arr[o + 3] / 255.0;
            flowX = b * 2.0 - 1.0;
            flowY = a * 2.0 - 1.0;
          }
        }
      }

      const flowScale = 55; // tuned in world units/sec; only applies while landed
      particle.position.x += (this._windX * driftSpeed + (-this._windY) * wobble + flowX * flowScale) * delta;
      particle.position.y += (this._windY * driftSpeed + ( this._windX) * wobble + flowY * flowScale) * delta;
      particle.position.z = 0;

      if (particle.color) {
        const baseA = (typeof particle._landedBaseAlpha === 'number') ? particle._landedBaseAlpha : particle.color.w;
        particle.color.w = baseA * (1.0 - t);
      }

      if (t >= 1.0) {
        if (typeof particle.life === 'number') particle.age = particle.life;
        else particle.age = 1e9;
      }
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    const b = new FoamFleckBehavior();
    b.gravity = this.gravity;
    b.landedDuration = this.landedDuration;
    b.windDriftScale = this.windDriftScale;
    return b;
  }

  reset() { /* no-op */ }
}

class RainFadeInBehavior {
  constructor() {
    this.type = 'RainFadeIn';
    this.fadeDuration = 1.0;
  }

  initialize(particle, system) {
    if (particle && particle.color) {
      particle._baseAlpha = particle.color.w;
      particle.color.w = 0;
    }
  }

  update(particle, delta, system) {
    if (!particle || typeof particle.age !== 'number' || !particle.color) return;

    // If a particle has "landed" (used by SnowFloorBehavior), skip the
    // fade-in logic so the floor behavior can own alpha over time.
    if (particle._landed) return;

    const t = Math.min(Math.max(particle.age / this.fadeDuration, 0), 1);
    const baseA = typeof particle._baseAlpha === 'number' ? particle._baseAlpha : 1.0;
    particle.color.w = baseA * t;
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    const b = new RainFadeInBehavior();
    b.fadeDuration = this.fadeDuration;
    return b;
  }

  reset() { /* no-op */ }
}

// Snow-specific flutter behavior to create the classic "paper falling" sway.
// This operates in world space and adds a gentle, per-particle sine-wave drift
// primarily along the X axis (with a small Y component) as flakes fall.
class SnowFlutterBehavior {
  constructor() {
    this.type = 'SnowFlutter';
    this.strength = 1.0;
  }

  initialize(particle, system) {
    // Assign per-particle random parameters once.
    if (!particle._flutterPhase) {
      particle._flutterPhase = Math.random() * Math.PI * 2;
      // Slight variation in how quickly each flake rocks.
      particle._flutterSpeed = 0.5 + Math.random() * 0.5; // 0.5–1.0 Hz
      // World-space sway amplitude in units per second.
      particle._flutterAmplitude = 40 + Math.random() * 60; // 40–100
      // Small bias so some flakes drift slightly "into" or "out of" camera.
      particle._flutterBiasY = (Math.random() - 0.5) * 0.25;
    }
  }

  update(particle, delta, system) {
    if (!particle || typeof particle.age !== 'number') return;

    // Once a flake has landed, SnowFloorBehavior owns its motion; do not
    // continue to flutter it across the ground.
    if (particle._landed) return;

    const t = particle.age;
    const phase = particle._flutterPhase || 0;
    const speed = particle._flutterSpeed || 0.7;
    const amp = particle._flutterAmplitude || 60;
    const biasY = particle._flutterBiasY || 0.0;

    // Sine-based oscillation controlling lateral displacement.
    const osc = Math.sin(t * speed + phase);
    const sway = osc * amp * delta * this.strength;

    // Apply primarily along X, with a subtle Y wobble bias.
    if (particle.position) {
      particle.position.x += sway;
      particle.position.y += sway * 0.2 + biasY * delta * amp * 0.25;
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    return new SnowFlutterBehavior();
  }

  reset() { /* no-op */ }
}

// Snow spin behavior: gives each flake a gentle, per-particle rotation while
// it is airborne. Rotation is stopped automatically once SnowFloorBehavior
// marks the particle as "landed" via the _landed flag.
class SnowSpinBehavior {
  constructor() {
    this.type = 'SnowSpin';
    this.strength = 1.0;
  }

  initialize(particle, system) {
    if (!particle) return;

    // Assign a small per-particle spin speed if not already present. Allow
    // clockwise and counter-clockwise rotation with slight variation.
    if (typeof particle._spinSpeed !== 'number') {
      const base = 1.2 + Math.random() * 1.2; // 1.2–2.4 rad/s for stronger visible spin
      const dir = Math.random() < 0.5 ? -1 : 1;
      particle._spinSpeed = base * dir;
    }
  }

  update(particle, delta, system) {
    if (!particle || typeof delta !== 'number') return;

    // Once the flake has landed, we no longer adjust rotation so it appears
    // settled on the ground.
    if (particle._landed) return;

    if (typeof particle.rotation === 'number' && typeof particle._spinSpeed === 'number') {
      // Drive tumbling intensity from current wind speed so calm snow
      // drifts with gentle spin while storms look much more chaotic.
      let wind = 0;
      try {
        if (weatherController && weatherController.currentState) {
          wind = weatherController.currentState.windSpeed || 0;
        }
      } catch (e) {
        wind = 0;
      }

      // 0 wind -> ~0.4x base spin, 1.0 wind -> ~3x base spin.
      const windFactor = 0.4 + 2.6 * Math.max(0, Math.min(1, wind));
      particle.rotation += particle._spinSpeed * this.strength * windFactor * delta;
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    const b = new SnowSpinBehavior();
    b.strength = this.strength;
    return b;
  }

  reset() { /* no-op */ }
}

// Snow floor behavior: when flakes reach the ground plane (z <= groundZ), stop their
// motion and fade them out over a short duration before killing them. This
// gives the impression of flakes "settling" on the ground instead of popping
// out of existence.
class SnowFloorBehavior {
  constructor() {
    this.type = 'SnowFloor';
    // Quarks internally clamps its per-frame delta to 0.1, and our
    // ParticleSystem feeds it an upscaled dt. A value around 1.0 here
    // corresponds to roughly ~2 seconds of real-time fade in practice.
    this.fadeDuration = 1.0;
    // Cache groundZ from SceneComposer; updated lazily in update() if needed.
    this._groundZ = null;
    this._tempVec = null;
  }

  /**
   * Get the ground plane Z position from SceneComposer.
   * @returns {number} Ground Z position (default 1000)
   * @private
   */
  _getGroundZ() {
    // Return cached value if available
    if (this._groundZ !== null) return this._groundZ;
    
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer && typeof sceneComposer.groundZ === 'number') {
      this._groundZ = sceneComposer.groundZ;
      return this._groundZ;
    }
    return 1000; // Default ground plane Z
  }

  initialize(particle, system) {
    if (!particle) return;
    // Ensure landing flags are cleared on spawn.
    particle._landed = false;
    particle._landedAgeStart = 0;
    particle._landedBaseAlpha = undefined;
    particle._landedBaseSize = undefined;
    particle._landedPosition = undefined;
  }

  update(particle, delta, system) {
    if (!particle || !particle.position) return;

    // Already landed: keep them fixed and drive fade-out.
    if (particle._landed) {
      if (particle.velocity) {
        particle.velocity.set(0, 0, 0);
      }

      // Pin position to the landing point so external forces/behaviors cannot
      // slide the flake across the ground while it is shrinking.
      if (particle.position && particle._landedPosition) {
        particle.position.copy(particle._landedPosition);
      }

      if (particle.color) {
        const startAge = particle._landedAgeStart || 0;
        const baseA = (typeof particle._landedBaseAlpha === 'number') ? particle._landedBaseAlpha : particle.color.w;
        const t = Math.min(Math.max((particle.age - startAge) / this.fadeDuration, 0), 1);
        particle.color.w = baseA * (1.0 - t);

        // When fully faded, mark as dead by forcing age beyond lifetime.
        if (t >= 1.0) {
          if (typeof particle.life === 'number') {
            particle.age = particle.life;
          } else {
            particle.age = 1e9;
          }
        }
      }

      // Shrink the flake as it fades out.
      if (particle.size) {
        // Cache the size at the moment of landing so we shrink from that.
        if (!particle._landedBaseSize) {
          particle._landedBaseSize = particle.size.clone();
        }
        const startAge = particle._landedAgeStart || 0;
        const t = Math.min(Math.max((particle.age - startAge) / this.fadeDuration, 0), 1);
        const scale = 1.0 - t;
        particle.size.copy(particle._landedBaseSize).multiplyScalar(scale);
      }

      return;
    }

    // Not yet landed: check for contact with the ground plane.
    const groundZ = this._getGroundZ();
    let z = particle.position.z;
    const THREE = window.THREE;

    if (system && system.emitter && system.emitter.matrixWorld && THREE) {
      if (!this._tempVec) this._tempVec = new THREE.Vector3();
      this._tempVec.set(particle.position.x, particle.position.y, particle.position.z);
      this._tempVec.applyMatrix4(system.emitter.matrixWorld);
      z = this._tempVec.z;
    }
    if (z <= groundZ) {
      particle._landed = true;
      particle._landedAgeStart = typeof particle.age === 'number' ? particle.age : 0;
      if (particle.color) {
        particle._landedBaseAlpha = particle.color.w;
      }
      if (particle.size) {
        particle._landedBaseSize = particle.size.clone();
      }
      if (particle.position) {
        particle._landedPosition = particle.position.clone();
      }
      // Ensure the particle lives at least long enough to complete the fade.
      if (typeof particle.life === 'number' && typeof particle.age === 'number') {
        const minLife = particle.age + this.fadeDuration;
        if (particle.life < minLife) {
          particle.life = minLife;
        }
      }
      if (particle.velocity) {
        particle.velocity.set(0, 0, 0);
      }
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    const b = new SnowFloorBehavior();
    b.fadeDuration = this.fadeDuration;
    return b;
  }

  reset() { /* no-op */ }
}

// NOTE: For both rain and snow we now treat particle.position as world-space
// (worldSpace: true in the Quarks systems) and define the kill volume
// directly from the scene rectangle and 0..7500 height.

// Custom behavior to handle 0 -> 10% -> 0% opacity over life
class SplashAlphaBehavior {
  constructor(peakOpacity = 0.1) {
    this.type = 'SplashAlpha';
    this.peakOpacity = peakOpacity;
  }

  initialize(particle, system) {
    // No init needed, we drive alpha every frame
  }

  update(particle, delta, system) {
    if (!particle || typeof particle.age !== 'number') return;
    
    // Normalized life 0..1
    const t = particle.age / particle.life;
    
    let alpha = 0;
    if (t < 0.5) {
      // 0.0 -> 0.5 maps to 0.0 -> peak
      alpha = (t * 2.0) * this.peakOpacity;
    } else {
      // 0.5 -> 1.0 maps to peak -> 0.0
      alpha = ((1.0 - t) * 2.0) * this.peakOpacity;
    }
    
    // Apply to particle color alpha (w)
    if (particle.color) {
        particle.color.w = alpha;
    }
  }

  frameUpdate(delta) {}
  clone() { return new SplashAlphaBehavior(this.peakOpacity); }
  reset() {}
}

class FoamPlumeBehavior {
  constructor() {
    this.type = 'FoamPlume';
    this.peakOpacity = 0.65;
    this.peakTime = 0.18;
    this.startScale = 0.5;
    this.maxScale = 2.2;
    this.spinMin = -0.18;
    this.spinMax = 0.18;

    // Wind-driven drift (world units / second).
    // Controlled from WaterEffectV2 params: foamPlumeWindDriftScale.
    this.windDriftScale = 0.0;
    this._windX = 1.0;
    this._windY = 0.0;
    this._windSpeed01 = 0.0;

    // Per-particle random opacity scalar applied on top of peakOpacity.
    // This is evaluated once at spawn time and then kept stable for the life
    // of the particle.
    this.randomOpacityMin = 1.0;
    this.randomOpacityMax = 1.0;
  }

  setWind(dir, windSpeed01) {
    const x = Number.isFinite(dir?.x) ? dir.x : 1.0;
    const y = Number.isFinite(dir?.y) ? dir.y : 0.0;
    const len = Math.hypot(x, y);
    this._windX = len > 1e-6 ? (x / len) : 1.0;
    this._windY = len > 1e-6 ? (y / len) : 0.0;
    this._windSpeed01 = Number.isFinite(windSpeed01) ? Math.max(0.0, Math.min(1.0, windSpeed01)) : 0.0;
  }

  initialize(particle, system) {
    if (!particle) return;
    if (particle.size && !particle._foamBaseSize) {
      particle._foamBaseSize = particle.size.clone();
    }
    if (particle.color) {
      particle._foamBaseAlpha = particle.color.w;
    }
    if (typeof particle._foamOpacityRand !== 'number') {
      const o0 = Number.isFinite(this.randomOpacityMin) ? this.randomOpacityMin : 1.0;
      const o1 = Number.isFinite(this.randomOpacityMax) ? this.randomOpacityMax : 1.0;
      const lo = Math.min(o0, o1);
      const hi = Math.max(o0, o1);
      particle._foamOpacityRand = lo + (hi - lo) * Math.random();
    }
    if (typeof particle.rotation === 'number' && typeof particle._foamSpinSpeed !== 'number') {
      const s0 = Number.isFinite(this.spinMin) ? this.spinMin : -0.18;
      const s1 = Number.isFinite(this.spinMax) ? this.spinMax : 0.18;
      const lo = Math.min(s0, s1);
      const hi = Math.max(s0, s1);
      particle._foamSpinSpeed = lo + (hi - lo) * Math.random();
    }
  }

  update(particle, delta, system) {
    if (!particle || typeof particle.age !== 'number' || typeof particle.life !== 'number') return;
    const t = particle.life > 0 ? (particle.age / particle.life) : 0;

    const growEnd = Math.max(0.05, this.peakTime * 2.0);
    const g0 = Math.max(0.0, Math.min(1.0, t / growEnd));
    const g = 1.0 - Math.pow(1.0 - g0, 3.0);
    const scale = this.startScale + (this.maxScale - this.startScale) * g;
    if (particle.size && particle._foamBaseSize) {
      particle.size.copy(particle._foamBaseSize).multiplyScalar(scale);
    }

    const pt = Math.max(0.01, Math.min(0.6, this.peakTime));
    let a01 = 0.0;
    if (t < pt) {
      a01 = t / pt;
    } else {
      a01 = (1.0 - t) / (1.0 - pt);
    }
    a01 = Math.max(0.0, Math.min(1.0, a01));
    a01 = a01 * a01;

    if (particle.color) {
      const r = (typeof particle._foamOpacityRand === 'number') ? particle._foamOpacityRand : 1.0;
      particle.color.w = a01 * this.peakOpacity * r;
    }

    if (typeof particle.rotation === 'number' && typeof particle._foamSpinSpeed === 'number') {
      particle.rotation += particle._foamSpinSpeed * delta;
    }

    // Optional wind drift to keep foam.webp plume particles flowing downwind.
    // Only apply if the Particle has a position (Quarks particles always should).
    if (particle.position) {
      const s = Number.isFinite(this.windDriftScale) ? Math.max(0.0, this.windDriftScale) : 0.0;
      if (s > 0.0) {
        const driftSpeed = (20 + 120 * this._windSpeed01) * s;
        particle.position.x += this._windX * driftSpeed * delta;
        particle.position.y += this._windY * driftSpeed * delta;
      }
    }
  }

  frameUpdate(delta) { /* no-op */ }

  clone() {
    const b = new FoamPlumeBehavior();
    b.peakOpacity = this.peakOpacity;
    b.peakTime = this.peakTime;
    b.startScale = this.startScale;
    b.maxScale = this.maxScale;
    b.spinMin = this.spinMin;
    b.spinMax = this.spinMax;
    b.randomOpacityMin = this.randomOpacityMin;
    b.randomOpacityMax = this.randomOpacityMax;
    b.windDriftScale = this.windDriftScale;
    b._windX = this._windX;
    b._windY = this._windY;
    b._windSpeed01 = this._windSpeed01;
    return b;
  }

  reset() { /* no-op */ }
}

export class WeatherParticles {
  constructor(batchRenderer, scene) {
    this.batchRenderer = batchRenderer;
    this.scene = scene;
    this.rainSystem = null;
    this.snowSystem = null;
    this.ashSystem = null;
    this.ashEmberSystem = null;
    this.splashSystem = null;
    this.splashSystems = [];
    this.rainTexture = this._createRainTexture();
    this.snowTexture = this._createSnowTexture();
    this.ashTexture = this._createAshTexture();
    this.splashTexture = this._createSplashTexture();
    this.foamTexture = this._createFoamTexture();
    this.foamFleckTexture = this._createFoamFleckTexture();
    this.enabled = true;
    this._time = 0;

    this._splashShape = null;

    this._waterHitMaskUuid = null;
    this._waterHitMaskFlipV = null;
    this._waterHitPoints = null;
    this._waterHitShape = null;

    this._waterFoamShape = null;

    this._waterFoamMaskUuid = null;
    this._waterFoamPoints = null;
    this._waterFoamPointsKey = null;

    // Foam plume point clouds:
    // - _waterFoamPlumePoints: merged scene+tile hard-edge UV points (view-filtered)
    // - _waterFoamPlumeBasePoints: merged scene+tile hard-edge UV points (full scene)
    this._waterFoamPlumePoints = null;
    this._waterFoamPlumeBasePoints = null;
    this._waterFoamPlumePointsKey = null;

    this._waterFoamPlumeUuid = null;
    this._waterFoamPlumeFlipV = null;
    this._waterFoamPlumeStride = null;
    this._waterFoamPlumeMaxPoints = null;
    this._waterFoamPlumeTileRev = null;

    this._simpleFoamLastEnabled = null;
    this._simpleFoamLastPointCount = null;

    this._foamFleckInteriorMaskFlipV = null;
    this._foamFleckInteriorStride = null;
    this._foamFleckInteriorMaxPoints = null;

    // View-dependent foam.webp spawning:
    // - We generate a global point cloud from the _Water hard edge.
    // - Each frame we filter it to the camera-visible world rectangle and feed
    //   only that subset to the foam emitter.
    this._viewMinX = null;
    this._viewMaxX = null;
    this._viewMinY = null;
    this._viewMaxY = null;
    this._viewSceneX = null;
    this._viewSceneY = null;
    this._viewSceneW = null;
    this._viewSceneH = null;
    this._waterFoamViewBuffer = null;
    this._waterFoamViewCount = 0;
    this._waterFoamLastViewQU0 = null;
    this._waterFoamLastViewQU1 = null;
    this._waterFoamLastViewQV0 = null;
    this._waterFoamLastViewQV1 = null;

    // Tile-driven foam.webp spawning:
    // We allow per-tile _Water masks to contribute *additional* spawn locations.
    // These are cached per tile and merged with the global scene _Water points.
    this._tileWaterFoamCache = new Map(); // tileId -> { scanKey, transformKey, localHardPts, localEdgePts, localInteriorPts, hardPts, edgePts, interiorPts }
    this._tileWaterFoamMergedPts = null; // Float32Array (u,v) in scene UVs
    this._tileShoreFoamMergedPts = null; // Float32Array (u,v,nx,ny) in scene UVs
    this._tileWaterInteriorMergedPts = null; // Float32Array (u,v) in scene UVs
    this._tileFoamRevision = 0;

    this._shoreFoamMaskUuid = null;
    this._shoreFoamPoints = null;
    this._shoreFoamShape = null;
    this._shoreFoamViewPoints = null;

    // View-filtering cache for shoreline points (u,v,nx,ny)
    this._shoreFoamViewBuffer = null;
    this._shoreFoamViewCount = 0;
    this._shoreFoamLastViewQU0 = null;
    this._shoreFoamLastViewQU1 = null;
    this._shoreFoamLastViewQV0 = null;
    this._shoreFoamLastViewQV1 = null;
    this._shoreFoamPointsKey = null;

    this._foamFleckInteriorMaskUuid = null;
    this._foamFleckInteriorPoints = null;

    this._waterMaskThreshold = 0.15;
    this._waterMaskStride = 2;
    this._waterMaskMaxPoints = 20000;

    this._rainMaterial = null;
    this._snowMaterial = null;
    this._ashMaterial = null;
    this._ashEmberMaterial = null;
    this._splashMaterial = null;
    this._foamMaterial = null;

    // Cached foam material uniforms & shader patch state.
    this._lastFoamAdditiveBoost = null;
    this._lastFoamBatchAdditiveBoost = null;

    this._foamPlumeBehavior = null;

    this._foamSystem = null;
    this._foamBatchMaterial = null;

    this._foamLastMaxParticles = null;

    this._foamFleckSystem = null;
    this._foamFleckMaterial = null;
    this._foamFleckEmitter = null;
    this._foamFleckBehavior = null;
    this._foamFleckBatchMaterial = null;

    this._foamFleckLastWindSpeed01 = 0.0;
    this._foamFleckWindAccel01 = 0.0;
    this._foamFleckLastGust = 0.0;
    this._foamFleckLastMaxParticles = null;
    this._foamFleckLastSizeMin = null;
    this._foamFleckLastSizeMax = null;

    // Cache last-applied material tuning to avoid per-frame churn.
    this._lastFoamOpacity = null;
    this._lastFoamBlendMode = null;
    this._lastFoamColorKey = null;
    this._lastFoamBatchBlendMode = null;

    this._lastFoamFleckOpacity = null;
    this._lastFoamFleckSystemOpacity = null;

    // ROOF / _OUTDOORS MASK INTEGRATION (high level):
    // - WeatherController owns the _Outdoors texture (roofMap) and two flags:
    //     * roofMaskActive: driven by TileManager when any overhead roof is hover-hidden.
    //     * roofMaskForceEnabled: manual override from the UI.
    // - ParticleSystem.update computes the Foundry scene bounds vector
    //   [sceneX, sceneY, sceneWidth, sceneHeight] each frame and passes it to
    //   WeatherParticles.update so we can project world X/Y into 0..1 mask UVs.
    // - WeatherParticles caches that bounds vector here as a THREE.Vector4 and
    //   reads roofMap/roofMask* from WeatherController each frame.
    // - For rendering, we do NOT touch the internal quarks shaders directly in
    //   user code. Instead we call _patchRoofMaskMaterial on both the source
    //   MeshBasicMaterials (rain/snow) and the SpriteBatch ShaderMaterials
    //   created by three.quarks' BatchedRenderer.
    // - _patchRoofMaskMaterial injects a world-space position varying and a
    //   small fragment mask block into those shaders, then we drive three
    //   uniforms each frame:
    //       uRoofMap       : sampler2D for the _Outdoors mask
    //       uSceneBounds   : (sceneX, sceneY, sceneWidth, sceneHeight)
    //       uRoofMaskEnabled : 0/1 gate from WeatherController flags
    //   so any future batched effects can follow the same pattern.

    /** @type {THREE.Texture|null} cached roof/outdoors mask texture */
    this._roofTexture = null;

    /** @type {THREE.Vector4|null} cached scene bounds for mask projection */
    this._sceneBounds = null;

    this._rainWindForce = null;
    this._snowWindForce = null;
    this._rainGravityForce = null;
    this._snowGravityForce = null;
    this._snowFlutter = null; // legacy; no longer used in behaviors
    this._snowCurl = null;
    this._snowCurlBaseStrength = null;
    this._rainCurl = null;
    this._rainCurlBaseStrength = null;

    /** @type {SplashAlphaBehavior|null} */
    this._splashAlphaBehavior = null;

    /** @type {SplashAlphaBehavior[]} */
    this._splashAlphaBehaviors = [];

    /** @type {ApplyForce[]} */
    this._splashWindForces = [];

    this._rainBaseGravity = 2500;
    this._snowBaseGravity = 3000;
    this._ashBaseGravity = 1800; // Ash falls slower than snow

    this._ashWindForce = null;
    this._ashGravityForce = null;
    this._ashCurl = null;
    this._ashCurlBaseStrength = null;
    this._ashColorOverLife = null;
    this._ashEmberWindForce = null;
    this._ashEmberGravityForce = null;
    this._ashEmberCurl = null;
    this._ashEmberCurlBaseStrength = null;
    this._ashEmberColorOverLife = null;

    // Ash clustering (uneven distribution)
    this._ashClusterTimer = 0.0;
    this._ashClusterCenter = { x: 0, y: 0 };
    this._ashClusterRadius = 0.0;
    this._ashBaseEmitterW = null;
    this._ashBaseEmitterH = null;

    /** @type {THREE.ShaderMaterial|null} quarks batch material for rain */
    this._rainBatchMaterial = null;

    /** @type {THREE.ShaderMaterial|null} quarks batch material for snow */
    this._snowBatchMaterial = null;

    /** @type {THREE.ShaderMaterial|null} quarks batch material for ash */
    this._ashBatchMaterial = null;

    /** @type {THREE.ShaderMaterial|null} quarks batch material for ash embers */
    this._ashEmberBatchMaterial = null;

    /** @type {THREE.ShaderMaterial|null} quarks batch material for splashes */
    this._splashBatchMaterial = null;

    /** @type {THREE.ShaderMaterial[]} quarks batch materials for per-tile splash systems */
    this._splashBatchMaterials = [];

    this._waterHitSplashSystems = [];
    this._waterHitSplashBatchMaterials = [];

    this._foamSystem = null;
    this._foamBatchMaterial = null;

    // Cache to avoid recomputing rain material/particle properties every frame.
    // We track key tuning values so we only update Quarks when they actually change.
    this._lastRainTuning = {
      brightness: null,
      dropSize: null,
      dropSizeMin: null,
      dropSizeMax: null,
      streakLength: null
    };

    // PERFORMANCE FIX: Reuse Vector3 for wind direction calculations in update()
    // instead of allocating a new one every frame.
    this._tempWindDir = new window.THREE.Vector3();

    // PERF: Cache pixel readbacks for mask textures (getImageData is expensive and allocates).
    // Many point-generation functions were creating a new canvas + ImageData on each call.
    this._maskPixelCache = new Map();
    // PERF: Limit memory use of cached mask readbacks.
    // These caches store full-resolution RGBA buffers (w*h*4). On large maps this can
    // explode memory usage if we only cap by entry count.
    this._maskPixelCacheBytes = 0;
    this._maskPixelCacheMaxEntries = 48;
    this._maskPixelCacheMaxBytes = (() => {
      try {
        const dm = navigator?.deviceMemory;
        // Conservative defaults; browsers may omit deviceMemory.
        if (Number.isFinite(dm)) {
          if (dm <= 4) return 32 * 1024 * 1024;
          if (dm <= 8) return 64 * 1024 * 1024;
          return 128 * 1024 * 1024;
        }
      } catch (_) {
      }
      return 64 * 1024 * 1024;
    })();
    this._maskReadCanvas = null;
    this._maskReadCtx = null;

    // Dirty-check state for roof-mask uniform propagation to batch materials.
    this._lastSplashRoofMaskEnabled = null;
    this._lastSplashHasRoofAlphaMap = null;
    this._lastSplashRoofTexUuid = null;
    this._lastSplashRoofAlphaUuid = null;
    this._lastSplashScreenW = null;
    this._lastSplashScreenH = null;
    this._lastSplashSceneBoundsX = null;
    this._lastSplashSceneBoundsY = null;
    this._lastSplashSceneBoundsW = null;
    this._lastSplashSceneBoundsH = null;

    // Shoreline rebuild cache fields (avoid per-frame string key allocation).
    this._shoreFoamMaskUuid = null;
    this._shoreFoamMaskVersion = null;
    this._shoreFoamMaskW = null;
    this._shoreFoamMaskH = null;
    this._shoreFoamStride = null;
    this._shoreFoamMaxPoints = null;
    this._shoreFoamFlipV = null;
    this._shoreFoamTileRev = null;

    // Track precipitation edge transitions so we can clear existing splashes
    // when the slider abruptly goes to 0.
    this._lastPrecipitation = null;

    this._initSystems();
  }

  _deleteMaskPixelCacheEntry(key) {
    try {
      const entry = this._maskPixelCache.get(key);
      const bytes = entry?.byteLength ?? entry?.data?.byteLength;
      if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes > 0) {
        this._maskPixelCacheBytes = Math.max(0, (this._maskPixelCacheBytes || 0) - bytes);
      }
    } catch (_) {
    }
    try {
      this._maskPixelCache.delete(key);
    } catch (_) {
    }
  }

  _clearAllRainSplashes() {
    // three.quarks keeps live particles in `system.particles` and indexes the
    // active range via `system.particleNum`. If precipitation drops to 0 and we
    // pause the system, existing particles can remain frozen in place.
    const clearSystem = (sys) => {
      if (!sys) return;
      try {
        if (sys.particles && typeof sys.particles.length === 'number') sys.particles.length = 0;
        if (typeof sys.particleNum === 'number') sys.particleNum = 0;
        if (sys.emissionState && typeof sys.emissionState.waitEmiting === 'number') sys.emissionState.waitEmiting = 0;
      } catch (_) {
      }
    };

    if (this.splashSystem) clearSystem(this.splashSystem);
    if (this.splashSystems && this.splashSystems.length) {
      for (const s of this.splashSystems) clearSystem(s);
    }
    if (this._waterHitSplashSystems && this._waterHitSplashSystems.length) {
      for (const entry of this._waterHitSplashSystems) clearSystem(entry?.system);
    }
  }

  clearWaterCaches() {
    // Clear all caches involved in water/foam spawning (scene mask scans + per-tile point sets).
    // This is intended as a runtime recovery tool when tiles are added/removed or masks are edited.
    try {
      if (this._tileWaterFoamCache && this._tileWaterFoamCache.size > 0) {
        this._tileWaterFoamCache.clear();
      }
    } catch (_) {
    }

    this._tileWaterFoamMergedPts = null;
    this._tileShoreFoamMergedPts = null;
    this._tileWaterInteriorMergedPts = null;
    this._tileFoamRevision = (this._tileFoamRevision | 0) + 1;

    // Invalidate view-filter caches so we don't keep returning stale subsets.
    this._waterFoamLastViewQU0 = null;
    this._waterFoamLastViewQU1 = null;
    this._waterFoamLastViewQV0 = null;
    this._waterFoamLastViewQV1 = null;

    this._shoreFoamLastViewQU0 = null;
    this._shoreFoamLastViewQU1 = null;
    this._shoreFoamLastViewQV0 = null;
    this._shoreFoamLastViewQV1 = null;

    // Force rebuild of derived point clouds.
    this._waterFoamPlumePointsKey = null;
    this._waterFoamPlumePoints = null;
    this._waterFoamPlumeBasePoints = null;

    this._waterFoamPlumeUuid = null;
    this._waterFoamPlumeFlipV = null;
    this._waterFoamPlumeStride = null;
    this._waterFoamPlumeMaxPoints = null;
    this._waterFoamPlumeTileRev = null;

    this._shoreFoamPointsKey = null;
    this._shoreFoamPoints = null;
    this._shoreFoamViewPoints = null;

    // Simple foam spawner caches.
    this._waterFoamMaskUuid = null;
    this._waterFoamPoints = null;
    this._waterFoamPointsKey = null;
    this._simpleFoamLastEnabled = null;
    this._simpleFoamLastPointCount = null;

    this._simpleFoamMaskUuid = null;
    this._simpleFoamMaskFlipV = null;
    this._simpleFoamThreshold = null;
    this._simpleFoamStride = null;
    this._simpleFoamMaxPoints = null;

    // Water-hit splash caches (avoid per-frame string keys)
    this._waterHitMaskUuid = null;
    this._waterHitMaskFlipV = null;

    // Interior caches (used by foam flecks).
    this._foamFleckInteriorMaskUuid = null;
    this._foamFleckInteriorMaskFlipV = null;
    this._foamFleckInteriorStride = null;
    this._foamFleckInteriorMaxPoints = null;
    this._foamFleckInteriorPoints = null;

    // Clear active shape points immediately.
    try {
      if (this._waterFoamShape) this._waterFoamShape.clearPoints();
      if (this._shoreFoamShape) this._shoreFoamShape.clearPoints();
      if (this._foamFleckEmitter) {
        this._foamFleckEmitter.setShorePoints(null);
        this._foamFleckEmitter.setInteriorPoints(null);
      }
    } catch (_) {
    }
  }

  _getViewFilteredEdgePoints(pts) {
    if (!pts || pts.length < 4) return null;

    const minX = this._viewMinX;
    const maxX = this._viewMaxX;
    const minY = this._viewMinY;
    const maxY = this._viewMaxY;
    const sceneX = this._viewSceneX;
    const sceneY = this._viewSceneY;
    const sceneW = this._viewSceneW;
    const sceneH = this._viewSceneH;

    if (
      !Number.isFinite(minX) || !Number.isFinite(maxX) ||
      !Number.isFinite(minY) || !Number.isFinite(maxY) ||
      !Number.isFinite(sceneX) || !Number.isFinite(sceneY) ||
      !Number.isFinite(sceneW) || !Number.isFinite(sceneH) ||
      sceneW <= 1e-6 || sceneH <= 1e-6
    ) {
      return null;
    }

    // Convert the visible WORLD rect (Y-up) to mask UVs (u: left->right, v: top->bottom).
    let u0 = (minX - sceneX) / sceneW;
    let u1 = (maxX - sceneX) / sceneW;
    const vTop = 1.0 - ((maxY - sceneY) / sceneH);
    const vBottom = 1.0 - ((minY - sceneY) / sceneH);
    let v0 = Math.min(vTop, vBottom);
    let v1 = Math.max(vTop, vBottom);

    u0 = Math.max(0.0, Math.min(1.0, u0));
    u1 = Math.max(0.0, Math.min(1.0, u1));
    v0 = Math.max(0.0, Math.min(1.0, v0));
    v1 = Math.max(0.0, Math.min(1.0, v1));

    const q = 256;
    const qU0 = Math.floor(u0 * q);
    const qU1 = Math.floor(u1 * q);
    const qV0 = Math.floor(v0 * q);
    const qV1 = Math.floor(v1 * q);
    if (
      qU0 === this._shoreFoamLastViewQU0 &&
      qU1 === this._shoreFoamLastViewQU1 &&
      qV0 === this._shoreFoamLastViewQV0 &&
      qV1 === this._shoreFoamLastViewQV1
    ) {
      return (this._shoreFoamViewBuffer && this._shoreFoamViewCount > 0)
        ? this._shoreFoamViewBuffer.subarray(0, this._shoreFoamViewCount * 4)
        : null;
    }
    this._shoreFoamLastViewQU0 = qU0;
    this._shoreFoamLastViewQU1 = qU1;
    this._shoreFoamLastViewQV0 = qV0;
    this._shoreFoamLastViewQV1 = qV1;

    const maxPoints = 16000;
    if (!this._shoreFoamViewBuffer || this._shoreFoamViewBuffer.length < maxPoints * 4) {
      this._shoreFoamViewBuffer = new Float32Array(maxPoints * 4);
    }

    const count = Math.floor(pts.length / 4);
    let filled = 0;
    let eligible = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const u = pts[o];
      const v = pts[o + 1];
      if (u < u0 || u > u1 || v < v0 || v > v1) continue;

      if (filled < maxPoints) {
        const oo = filled * 4;
        this._shoreFoamViewBuffer[oo] = u;
        this._shoreFoamViewBuffer[oo + 1] = v;
        this._shoreFoamViewBuffer[oo + 2] = pts[o + 2];
        this._shoreFoamViewBuffer[oo + 3] = pts[o + 3];
        filled++;
      } else {
        const j = Math.floor(Math.random() * (eligible + 1));
        if (j < maxPoints) {
          const oo = j * 4;
          this._shoreFoamViewBuffer[oo] = u;
          this._shoreFoamViewBuffer[oo + 1] = v;
          this._shoreFoamViewBuffer[oo + 2] = pts[o + 2];
          this._shoreFoamViewBuffer[oo + 3] = pts[o + 3];
        }
      }
      eligible++;
    }

    this._shoreFoamViewCount = filled;
    return filled > 0 ? this._shoreFoamViewBuffer.subarray(0, filled * 4) : null;
  }

  _setWeatherSystemsVisible(visible) {
    const v = !!visible;

    if (this.rainSystem?.emitter) this.rainSystem.emitter.visible = v;
    if (this.snowSystem?.emitter) this.snowSystem.emitter.visible = v;
    if (this.ashSystem?.emitter) this.ashSystem.emitter.visible = v;
    if (this.ashEmberSystem?.emitter) this.ashEmberSystem.emitter.visible = v;

    if (this.splashSystem?.emitter) this.splashSystem.emitter.visible = v;
    if (this.splashSystems && this.splashSystems.length) {
      for (const s of this.splashSystems) {
        if (s?.emitter) s.emitter.visible = v;
      }
    }

    if (this._waterHitSplashSystems && this._waterHitSplashSystems.length) {
      for (const entry of this._waterHitSplashSystems) {
        if (entry?.system?.emitter) entry.system.emitter.visible = v;
      }
    }

    if (this._foamSystem?.emitter) this._foamSystem.emitter.visible = v;
    if (this._foamFleckSystem?.emitter) this._foamFleckSystem.emitter.visible = v;
  }

  _zeroWeatherEmissions() {
    if (this.rainSystem?.emissionOverTime && typeof this.rainSystem.emissionOverTime.value === 'number') {
      this.rainSystem.emissionOverTime.value = 0;
    }
    if (this.snowSystem?.emissionOverTime && typeof this.snowSystem.emissionOverTime.value === 'number') {
      this.snowSystem.emissionOverTime.value = 0;
    }
    if (this.ashSystem?.emissionOverTime && typeof this.ashSystem.emissionOverTime.value === 'number') {
      this.ashSystem.emissionOverTime.value = 0;
    }
    if (this.ashEmberSystem?.emissionOverTime && typeof this.ashEmberSystem.emissionOverTime.value === 'number') {
      this.ashEmberSystem.emissionOverTime.value = 0;
    }

    if (this.splashSystem?.emissionOverTime && typeof this.splashSystem.emissionOverTime.value === 'number') {
      this.splashSystem.emissionOverTime.value = 0;
    }
    if (this.splashSystems && this.splashSystems.length) {
      for (const s of this.splashSystems) {
        if (s?.emissionOverTime && typeof s.emissionOverTime.value === 'number') {
          s.emissionOverTime.value = 0;
        }
      }
    }

    if (this._waterHitSplashSystems && this._waterHitSplashSystems.length) {
      for (const entry of this._waterHitSplashSystems) {
        const sys = entry?.system;
        if (sys?.emissionOverTime && typeof sys.emissionOverTime.value === 'number') {
          sys.emissionOverTime.value = 0;
        }
      }
    }

    if (this._foamSystem?.emissionOverTime && typeof this._foamSystem.emissionOverTime.value === 'number') {
      this._foamSystem.emissionOverTime.value = 0;
    }

    if (this._foamFleckSystem?.emissionOverTime && typeof this._foamFleckSystem.emissionOverTime.value === 'number') {
      this._foamFleckSystem.emissionOverTime.value = 0;
    }
  }

  _createRainTexture() {
    // Standard white streak
    const THREE = window.THREE;
    if (!THREE) return null;

    const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/rain.webp');
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  _createFoamFleckTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;

    // Small dot texture for 1–2px foam flecks. CanvasTexture keeps this
    // dependency-free and avoids new asset files.
    const size = 16;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(255,255,255,1)';
    // 2px dot centered.
    ctx.fillRect((size / 2) - 1, (size / 2) - 1, 2, 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    // Crisp dot: avoid blur so it reads as 1-2px rather than a soft smudge.
    tex.magFilter = THREE.NearestFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  _createSnowTexture() {
    // 1. INCREASE RESOLUTION
    // Bumped from 32 to 64 per cell. This creates a 128x128 texture.
    // This ensures flakes look crisp when they fall close to the camera.
    const cellSize = 64;
    const grid = 2;
    const totalSize = cellSize * grid;

    const canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const drawFlakeInCell = (cellX, cellY, variant) => {
      const cx = cellX * cellSize + cellSize / 2;
      const cy = cellY * cellSize + cellSize / 2;
    
    // 2. PADDING
    // We leave a roughly 4px gap between the flake and the cell edge.
    // This prevents "texture bleeding" (lines from one flake showing up on another)
    // when Mipmaps blur the texture at a distance.
    const maxRadius = (cellSize / 2) - 4;

    ctx.save();
    ctx.translate(cx, cy);

    // 3. THE "BOKEH" GLOW
    // A soft radial background that gives the flake volume and makes it
    // visible even if the fine structural lines are too small to see.
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, maxRadius);
    glow.addColorStop(0, 'rgba(255, 255, 255, 0.8)');   // Bright center
    glow.addColorStop(0.3, 'rgba(255, 255, 255, 0.2)'); // Soft core
    glow.addColorStop(1, 'rgba(255, 255, 255, 0)');     // Fade out
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, maxRadius, 0, Math.PI * 2);
    ctx.fill();

    // 4. CRYSTALLINE STRUCTURE
    // Real snowflakes have hexagonal symmetry. We draw one "arm"
    // and rotate it 6 times.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A white shadow creates a "bloom" effect
    ctx.shadowColor = "rgba(255, 255, 255, 1)"; 
    ctx.shadowBlur = 4;

    for (let i = 0; i < 6; i++) {
      ctx.save(); 
      ctx.rotate((Math.PI / 3) * i); // Rotate 60 degrees per arm

      ctx.beginPath();
      
      if (variant === 0) {
        // Variant 1: The Classic Star
        ctx.lineWidth = 3;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, maxRadius * 0.8);
      } 
      else if (variant === 1) {
        // Variant 2: The Fern (Dendrite)
        // Main spine
        ctx.lineWidth = 2;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, maxRadius * 0.9);
        // Little branches V-shape
        ctx.lineWidth = 1.5;
        const branchY = maxRadius * 0.5;
        const branchW = maxRadius * 0.25;
        ctx.moveTo(0, branchY);
        ctx.lineTo(branchW, branchY + (maxRadius * 0.2));
        ctx.moveTo(0, branchY);
        ctx.lineTo(-branchW, branchY + (maxRadius * 0.2));
      } 
      else if (variant === 2) {
        // Variant 3: The Plate (Hexagon center)
        ctx.lineWidth = 3;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, maxRadius * 0.7);
        // Crossbar to form the inner hexagon shape
        ctx.lineWidth = 2;
        ctx.moveTo(-5, maxRadius * 0.3);
        ctx.lineTo(5, maxRadius * 0.3);
      } 
      else {
        // Variant 4: The Heavy Flake (Clumped)
        // Thicker, shorter strokes to simulate flakes sticking together
        ctx.lineWidth = 4;
        ctx.moveTo(0, 0);
        ctx.lineTo(0, maxRadius * 0.6);
        ctx.moveTo(0, maxRadius * 0.3);
        ctx.lineTo(4, maxRadius * 0.5);
      }
      
      ctx.stroke();
      ctx.restore();
    }
    
    ctx.restore(); // Reset translation for next cell
  };

    // Generate the 4 variants
    drawFlakeInCell(0, 0, 0);
    drawFlakeInCell(1, 0, 1);
    drawFlakeInCell(0, 1, 2);
    drawFlakeInCell(1, 1, 3);

    const tex = new window.THREE.CanvasTexture(canvas);
    const THREE = window.THREE;

    if (THREE) {
      // 5. BETTER FILTERING
      // Use LinearMipmapLinear so it looks smooth (not pixelated) at a distance,
      // but retains the crisp shape when close.
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
    }

    return tex;
  }

  /**
   * Create a 2x2 atlas texture for ash particles.
   * Ash flakes are irregular, grey/charcoal colored fragments.
   * @returns {THREE.CanvasTexture}
   */
  _createAshTexture() {
    const cellSize = 64;
    const grid = 2;
    const totalSize = cellSize * grid;

    const canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    const drawAshInCell = (cellX, cellY, variant) => {
      const cx = cellX * cellSize + cellSize / 2;
      const cy = cellY * cellSize + cellSize / 2;
      const maxRadius = (cellSize / 2) - 4;

      ctx.save();
      ctx.translate(cx, cy);

      // Ash has a subtle dark glow/haze
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, maxRadius);
      glow.addColorStop(0, 'rgba(80, 75, 70, 0.7)');
      glow.addColorStop(0.4, 'rgba(60, 55, 50, 0.3)');
      glow.addColorStop(1, 'rgba(40, 35, 30, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(0, 0, maxRadius, 0, Math.PI * 2);
      ctx.fill();

      // Draw irregular ash fragment shapes
      ctx.fillStyle = 'rgba(90, 85, 80, 0.85)';
      ctx.strokeStyle = 'rgba(50, 45, 40, 0.6)';
      ctx.lineWidth = 1;

      if (variant === 0) {
        // Variant 1: Irregular polygon (burnt paper fragment)
        ctx.beginPath();
        ctx.moveTo(-maxRadius * 0.3, -maxRadius * 0.4);
        ctx.lineTo(maxRadius * 0.2, -maxRadius * 0.35);
        ctx.lineTo(maxRadius * 0.4, maxRadius * 0.1);
        ctx.lineTo(maxRadius * 0.1, maxRadius * 0.4);
        ctx.lineTo(-maxRadius * 0.35, maxRadius * 0.25);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (variant === 1) {
        // Variant 2: Curved fragment
        ctx.beginPath();
        ctx.ellipse(0, 0, maxRadius * 0.4, maxRadius * 0.25, Math.PI / 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      } else if (variant === 2) {
        // Variant 3: Jagged shard
        ctx.beginPath();
        ctx.moveTo(0, -maxRadius * 0.45);
        ctx.lineTo(maxRadius * 0.3, -maxRadius * 0.1);
        ctx.lineTo(maxRadius * 0.15, maxRadius * 0.35);
        ctx.lineTo(-maxRadius * 0.2, maxRadius * 0.3);
        ctx.lineTo(-maxRadius * 0.35, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        // Variant 4: Small clump
        ctx.beginPath();
        ctx.arc(0, 0, maxRadius * 0.3, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        // Add a smaller attached piece
        ctx.beginPath();
        ctx.arc(maxRadius * 0.25, maxRadius * 0.15, maxRadius * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.restore();
    };

    // Generate the 4 variants
    drawAshInCell(0, 0, 0);
    drawAshInCell(1, 0, 1);
    drawAshInCell(0, 1, 2);
    drawAshInCell(1, 1, 3);

    const tex = new window.THREE.CanvasTexture(canvas);
    const THREE = window.THREE;

    if (THREE) {
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
    }

    return tex;
  }

  _createSplashTexture() {
    // Build a 2x2 atlas of unique splash shapes (4 variants) so each
    // particle can sample a different tile for more variety.
    const cellSize = 64;
    const grid = 2; // 2x2 grid
    const totalSize = cellSize * grid; // 128x128 texture
    
    const canvas = document.createElement('canvas');
    canvas.width = totalSize;
    canvas.height = totalSize;
    const ctx = canvas.getContext('2d');

    const drawSplashInCell = (cellX, cellY) => {
      const imgData = ctx.createImageData(cellSize, cellSize);
      const data = imgData.data;

      // Make each of the 4 cells deliberately different so we can visually
      // confirm that all tiles are being sampled.

      // Cell (0,0): thin, clean ring
      if (cellX === 0 && cellY === 0) {
        const radius = cellSize * 0.35;
        const thickness = 2.0;
        for (let y = 0; y < cellSize; y++) {
          for (let x = 0; x < cellSize; x++) {
            const lx = x - cellSize / 2;
            const ly = y - cellSize / 2;
            const dist = Math.sqrt(lx * lx + ly * ly);
            const distFromRing = Math.abs(dist - radius);
            const idx = (y * cellSize + x) * 4;
            if (distFromRing < thickness) {
              const alpha = 1 - (distFromRing / thickness);
              data[idx] = 255;
              data[idx + 1] = 255;
              data[idx + 2] = 255;
              data[idx + 3] = Math.floor(alpha * 255);
            } else {
              data[idx + 3] = 0;
            }
          }
        }
        ctx.putImageData(imgData, cellX * cellSize, cellY * cellSize);
        return;
      }

      // Cell (1,0): thick, broken, noisy ring with strong angular gaps
      if (cellX === 1 && cellY === 0) {
        const radius = cellSize * 0.38;
        const thickness = 5.0;
        for (let y = 0; y < cellSize; y++) {
          for (let x = 0; x < cellSize; x++) {
            const lx = x - cellSize / 2;
            const ly = y - cellSize / 2;
            const dist = Math.sqrt(lx * lx + ly * ly);
            const angle = Math.atan2(ly, lx);
            const distFromRing = Math.abs(dist - radius);
            const idx = (y * cellSize + x) * 4;
            if (distFromRing < thickness) {
              let alpha = 1 - (distFromRing / thickness);
              // Strong angular gating to make clear broken arcs
              alpha *= (0.3 + 0.7 * Math.max(0, Math.sin(angle * 4.0)));
              alpha *= (0.5 + 0.5 * (Math.random()));
              data[idx] = 255;
              data[idx + 1] = 255;
              data[idx + 2] = 255;
              data[idx + 3] = Math.floor(alpha * 255);
            } else {
              data[idx + 3] = 0;
            }
          }
        }
        ctx.putImageData(imgData, cellX * cellSize, cellY * cellSize);
        return;
      }

      // Cell (0,1): mostly small droplets, no main ring
      if (cellX === 0 && cellY === 1) {
        const maxR = cellSize * 0.45;
        for (let y = 0; y < cellSize; y++) {
          for (let x = 0; x < cellSize; x++) {
            const lx = x - cellSize / 2;
            const ly = y - cellSize / 2;
            const dist = Math.sqrt(lx * lx + ly * ly);
            const idx = (y * cellSize + x) * 4;
            // Sparse random droplets in an annulus
            if (dist < maxR && dist > maxR * 0.2 && Math.random() > 0.93) {
              const alpha = 0.6 + Math.random() * 0.4;
              data[idx] = 255;
              data[idx + 1] = 255;
              data[idx + 2] = 255;
              data[idx + 3] = Math.floor(alpha * 255);
            } else {
              data[idx + 3] = 0;
            }
          }
        }
        ctx.putImageData(imgData, cellX * cellSize, cellY * cellSize);
        return;
      }

      // Cell (1,1): filled inner puddle with soft edge
      {
        const innerR = cellSize * 0.22;
        const outerR = cellSize * 0.40;
        for (let y = 0; y < cellSize; y++) {
          for (let x = 0; x < cellSize; x++) {
            const lx = x - cellSize / 2;
            const ly = y - cellSize / 2;
            const dist = Math.sqrt(lx * lx + ly * ly);
            const idx = (y * cellSize + x) * 4;
            if (dist < outerR) {
              let alpha;
              if (dist < innerR) {
                // Solid core
                alpha = 1.0;
              } else {
                // Falloff towards outer radius
                const t = (dist - innerR) / (outerR - innerR);
                alpha = 1.0 - t;
              }
              data[idx] = 255;
              data[idx + 1] = 255;
              data[idx + 2] = 255;
              data[idx + 3] = Math.floor(alpha * 255);
            } else {
              data[idx + 3] = 0;
            }
          }
        }
        ctx.putImageData(imgData, cellX * cellSize, cellY * cellSize);
      }
    };

    // Generate 4 unique splashes
    drawSplashInCell(0, 0);
    drawSplashInCell(1, 0);
    drawSplashInCell(0, 1);
    drawSplashInCell(1, 1);

    const tex = new window.THREE.CanvasTexture(canvas);
    // Important for atlases to reduce bleeding between tiles
    const THREE = window.THREE;
    if (THREE) {
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.LinearFilter;
    }
    return tex;
  }

  _createFoamTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;

    const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/foam.webp');
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  }

  _initSystems() {
     const THREE = window.THREE;
     const d = window.canvas?.dimensions;
     const sceneW = d?.sceneWidth ?? d?.width ?? 2000;
    const sceneH = d?.sceneHeight ?? d?.height ?? 2000;
    const sceneX = d?.sceneX ?? 0;
    const sceneY = d?.sceneY ?? 0;
    const totalH = d?.height ?? (sceneY + sceneH);
    const sceneYWorld = totalH - (sceneY + sceneH);
    
    // Scene rectangle comes directly from Foundry's canvas.dimensions.
    // This gives us the true playable area in world units (top-left origin).
    // We then extend this into 3D using the same canonical ground plane Z
    // that SceneComposer uses for the base plane mesh.
    //
    // Ground plane alignment contract:
    // - SceneComposer.createBasePlane() positions the base plane at
    //   GROUND_Z = 1000 (with camera at Z=2000), so the visible map lives
    //   at Z=1000 in world space.
    // - Previously WeatherParticles assumed Z=0 as ground, which caused
    //   rain/snow and splashes to appear offset relative to the map when the
    //   base plane Z moved.
    // - Here we derive the effective groundZ from SceneComposer when
    //   available, otherwise fall back to 1000 as the canonical value.
    //
    const sceneComposer = window.MapShine?.sceneComposer;
    // Canonical vertical wires from SceneComposer so all world-space effects
    // share the same notion of ground plane, emitter height, and world top.
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number')
      ? sceneComposer.groundZ
      : 1000; // Fallback to SceneComposer's canonical ground plane Z

    const worldTopZ = (sceneComposer && typeof sceneComposer.worldTopZ === 'number')
      ? sceneComposer.worldTopZ
      : (groundZ + 7500);

    const emitterZ = (sceneComposer && typeof sceneComposer.weatherEmitterZ === 'number')
      ? sceneComposer.weatherEmitterZ
      : (groundZ + 6500);

    // IMPORTANT: Keep the weather emitter within the camera frustum.
    // The PerspectiveCamera looks down -Z from a fixed height (typically z=2000)
    // with far=5000. Spawning at groundZ+6500 (e.g. 7500) puts particles behind
    // the camera / beyond the far plane. Rain still appears because it falls fast
    // enough to enter the frustum, but snow falls slowly and may never become visible.
    let safeEmitterZ = emitterZ;
    try {
      const cam = sceneComposer?.camera;
      if (cam && typeof cam.position?.z === 'number') {
        // Ensure spawn plane is in front of the camera (smaller Z than camera).
        safeEmitterZ = Math.min(safeEmitterZ, cam.position.z - 10);
      }
    } catch (e) {
      // Fallback: use computed emitterZ
    }

    // LAYERING CONTRACT (weather vs. tiles / overhead):
    // - Overhead tiles use Z_OVERHEAD=20, depthTest=true, depthWrite=false,
    //   renderOrder=10 (see TileManager.updateSpriteTransform).
    // - three.quarks builds its own SpriteBatch ShaderMaterials from the
    //   MeshBasicMaterial we provide here; we must NOT override SpriteBatch
    //   materials directly or we risk losing the texture map.
    // - To ensure rain/snow render visibly above roofs we:
    //     * keep depthWrite=false so particles never write depth,
    //     * set depthTest=false so they ignore the depth buffer, and
    //     * set renderOrder=50 on the ParticleSystem configs below.
    //   Combined with ParticleSystem's BatchedRenderer.renderOrder=50 this
    //   guarantees weather batches draw after tiles and appear as an overlay.
    log.info(`WeatherParticles: scene bounds [${sceneX}, ${sceneYWorld}, ${sceneW}x${sceneH}]`);

    const centerX = sceneX + sceneW / 2;
    const centerY = sceneYWorld + sceneH / 2;

    const maskParams = {
      width: sceneW,
      height: sceneH,
      sceneX,
      sceneY,
      totalHeight: totalH,
      centerX,
      centerY
    };

    this._splashShape = new RandomRectangleEmitter({ width: sceneW, height: sceneH });
    this._waterHitShape = new WaterMaskedSplashEmitter(maskParams);
    this._waterFoamShape = new WaterMaskedSplashEmitter(maskParams);
    this._shoreFoamShape = new ShorelineFoamEmitter(maskParams);
    this._foamFleckEmitter = new FoamFleckEmitter(maskParams);
    // Place the weather emitters well above the ground plane so rain/snow
    // have room to fall before hitting the map. Use SceneComposer.weatherEmitterZ
    // when available so all systems share a single canonical emitter height.

    // World volume in world space: scene rectangle in X/Y, groundZ..worldTopZ in Z.
    // We keep a tall band here so strong gravity/wind forces do not immediately
    // cull particles before they have a chance to render.
    const volumeMin = new THREE.Vector3(sceneX, sceneYWorld, groundZ);
    const volumeMax = new THREE.Vector3(sceneX + sceneW, sceneYWorld + sceneH, worldTopZ);
    const killBehavior = new WorldVolumeKillBehavior(volumeMin, volumeMax);
    // Foam flecks use local-space particles, so debugging is much easier if we can
    // toggle their kill volume independently.
    this._foamFleckKillBehavior = new WorldVolumeKillBehavior(volumeMin, volumeMax);
    
    // For snow we want flakes to be able to rest on the ground (z ~= groundZ) and
    // fade out instead of being culled the instant they touch the floor.
    // Use a slightly relaxed kill volume in Z so the SnowFloorBehavior can
    // manage their lifetime once they land.
    const snowVolumeMin = new THREE.Vector3(sceneX, sceneYWorld, groundZ - 100);
    const snowKillBehavior = new WorldVolumeKillBehavior(snowVolumeMin, volumeMax);
    
    // --- COMMON OVER-LIFE BEHAVIORS ---
    // Rain: keep chroma and alpha roughly constant over life; fade handled by RainFadeInBehavior.
    const rainColorOverLife = new ColorOverLife(
      new ColorRange(
        new Vector4(1.0, 1.0, 1.0, 1.0),
        new Vector4(1.0, 1.0, 1.0, 1.0)
      )
    );

    // Snow: slightly warm/bright at spawn, fade and desaturate over life.
    const snowColorOverLife = new ColorOverLife(
      new ColorRange(
        new Vector4(1.0, 1.0, 1.0, 1.0),
        new Vector4(0.9, 0.95, 1.0, 0.0)
      )
    );
     
     // --- GRAVITY & WIND ---
     // 1. Gravity (Down Z)
     const gravity = new ApplyForce(new THREE.Vector3(0, 0, -1), new ConstantValue(this._rainBaseGravity));
     // 2. Wind (lateral) - direction and strength will be driven by WeatherController each frame
     const wind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(3000));

     // --- RAIN ---
    const rainMaterial = new THREE.MeshBasicMaterial({
      map: this.rainTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      opacity: 1.0,
      side: THREE.DoubleSide
    });

    this._rainMaterial = rainMaterial;

    // Inject roof mask support into the rain material without changing its core look.
    this._patchRoofMaskMaterial(this._rainMaterial);

    this.rainSystem = new ParticleSystem({
      duration: 1,
      looping: true,
      // prewarm disabled — synchronous simulation of 60+ frames blocks the
      // event loop during loading. Rain fills in naturally within ~3s.
      prewarm: false,
      
      // LIFE: Long enough that particles are culled by the world-volume floor instead of timing out mid-air.
      startLife: new IntervalValue(3.0, 4.0),
      
      // SPEED: Tuned to give a readable fall rate at default gravity.
      // Gravity will still accelerate them further, but base speed is lower.
      startSpeed: new IntervalValue(2500, 3500), 
      
      // SIZE: narrow streaks; actual visual width is mostly from texture.
      startSize: new IntervalValue(1.2, 2.2), 
      
      startColor: new ColorRange(new Vector4(0.6, 0.7, 1.0, 1.0), new Vector4(0.6, 0.7, 1.0, 1.0)),
      worldSpace: true,
      maxParticles: 15000,
      emissionOverTime: new ConstantValue(0), 
      shape: new RandomRectangleEmitter({ width: sceneW, height: sceneH }),
      material: rainMaterial,
      renderOrder: 50,
      
      // RENDER MODE: StretchedBillBoard
      // Uses velocity to stretch the quad.
      renderMode: RenderMode.StretchedBillBoard,
      // speedFactor: Controls how "long" the rain streak is relative to speed.
      // 4000 speed * 0.01 factor = 40 unit long streak.
      speedFactor: 0.01, 
      
      startRotation: new ConstantValue(0),
      behaviors: [gravity, wind, rainColorOverLife, killBehavior, new RainFadeInBehavior()],
    });
     
    this.rainSystem.emitter.position.set(centerX, centerY, safeEmitterZ);
     // Rotate Emitter to shoot DOWN (-Z)
     this.rainSystem.emitter.rotation.set(Math.PI, 0, 0);

     if (this.scene) this.scene.add(this.rainSystem.emitter);
     this.batchRenderer.addSystem(this.rainSystem);

     // Patch the actual quarks batch material used to render rain so the
     // roof/outdoors mask logic runs on the SpriteBatch shader.
     try {
       const idx = this.batchRenderer.systemToBatchIndex?.get(this.rainSystem);
       if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
         const batch = this.batchRenderer.batches[idx];
         if (batch.material) {
           this._rainBatchMaterial = batch.material;
           this._patchRoofMaskMaterial(this._rainBatchMaterial);
         }
       }
     } catch (e) {
       log.warn('Failed to patch rain batch material for roof mask:', e);
     }

     // --- RAIN CURL NOISE (shared for all rain particles) ---
    const rainCurl = new CurlNoiseField(
      new THREE.Vector3(1400, 1400, 2000),   // larger cells than snow for broad gusts
      new THREE.Vector3(80, 80, 20),         // relatively subtle swirl
      0.08                                   // time scale
    );

    // Attach curl as a behavior to the rain system
    this.rainSystem.behaviors.push(rainCurl);

    // --- SPLASHES ---
    const splashMaterial = new THREE.MeshBasicMaterial({
      map: this.splashTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      opacity: 0.8
    });

    this._splashMaterial = splashMaterial;
    this._patchRoofMaskMaterial(this._splashMaterial);

    // Use custom alpha behavior for "triangle" fade: 0 -> 10% -> 0
    const splashAlphaBehavior = new SplashAlphaBehavior(0.10);
    this._splashAlphaBehavior = splashAlphaBehavior;

    // Rapid expansion behavior: much faster/larger
    // Start small (0.2 scale) and grow aggressively over a short life
    const splashSizeOverLife = new SizeOverLife(
      // Stronger curve than before so splashes expand more within their (now shorter) lifetime.
      new PiecewiseBezier([[new Bezier(0.4, 4.0, 7.0, 9.0), 0]])
    );
    
    // Create four independent splash systems (one per atlas tile) so each
    // splash archetype can be tuned separately.
    this.splashSystems = [];
    this._splashAlphaBehaviors = [];
    this._splashWindForces = [];

    const createSplashSystemForTile = (tileIndex) => {
      const alphaBehavior = new SplashAlphaBehavior(0.10);
      this._splashAlphaBehaviors[tileIndex] = alphaBehavior;
      
      // Wind force for splashes (initially 0)
      const splashWind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(0));
      this._splashWindForces.push(splashWind);

      const system = new ParticleSystem({
        duration: 1,
        looping: true,
        prewarm: false,
        
        // Very short life baseline; will be overridden by tuning each frame.
        startLife: new IntervalValue(0.1, 0.2),
        
        // Static on the ground (no speed)
        startSpeed: new ConstantValue(0),
        
        // Size: randomization (World units/pixels)
        // Was 0.5-1.2 which is 1px. Needs to be visible, e.g. 12-24px.
        startSize: new IntervalValue(12, 24), 
        
        // Start at full white (1.0). SplashAlphaBehavior will drive alpha 0 -> 0.1 -> 0.
        startColor: new ColorRange(new Vector4(0.8, 0.9, 1.0, 1.0), new Vector4(0.8, 0.9, 1.0, 1.0)),
        worldSpace: true,
        maxParticles: 2000, // Enough for heavy rain
        emissionOverTime: new ConstantValue(0),
        
        // Atlas: 2x2 tiles (4 variants) on the splash texture
        uTileCount: 2,
        vTileCount: 2,
        // Lock this system to a specific atlas tile
        startTileIndex: new ConstantValue(tileIndex),
        
        shape: this._splashShape,
        
        material: splashMaterial,
        renderOrder: 50, // Same layer as rain
        renderMode: RenderMode.BillBoard, // Face camera (top-down view = circle on ground)
        
        // Pick a random orientation once at spawn; no over-life spin behavior.
        startRotation: new IntervalValue(0, Math.PI * 2),
        behaviors: [
          alphaBehavior,
          splashSizeOverLife,
          splashWind,
          // We do NOT add gravity. Splashes stay on the ground plane but can drift with wind.
          // We use the same kill behavior to clean up if map changes size (optional)
          killBehavior
        ]
      });

      // Z Position: Ground level, aligned with the base plane.
    // We nudge slightly above groundZ so splashes draw above the map but
    // below tokens.
    system.emitter.position.set(centerX, centerY, groundZ + 10);
      system.emitter.rotation.set(0, 0, 0); // No rotation needed for billboards

      if (this.scene) this.scene.add(system.emitter);
      this.batchRenderer.addSystem(system);

      // Patch the batch material for this splash system
      try {
        const idx = this.batchRenderer.systemToBatchIndex?.get(system);
        if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
          const batch = this.batchRenderer.batches[idx];
          if (batch.material) {
            this._splashBatchMaterial = batch.material;
            this._splashBatchMaterials.push(batch.material);
            this._patchRoofMaskMaterial(batch.material);
          }
        }
      } catch (e) {
        log.warn('Failed to patch splash batch material:', e);
      }

      this.splashSystems[tileIndex] = system;
      return system;
    };

    const createWaterHitSplashSystemForTile = (tileIndex) => {
      const alphaBehavior = new SplashAlphaBehavior(0.10);
      const splashWind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(0));

      const system = new ParticleSystem({
        duration: 1,
        looping: true,
        prewarm: false,
        startLife: new IntervalValue(0.1, 0.2),
        startSpeed: new ConstantValue(0),
        startSize: new IntervalValue(12, 24),
        startColor: new ColorRange(new Vector4(1.0, 1.0, 1.0, 1.0), new Vector4(1.0, 1.0, 1.0, 1.0)),
        worldSpace: true,
        maxParticles: 1500,
        emissionOverTime: new ConstantValue(0),
        uTileCount: 2,
        vTileCount: 2,
        startTileIndex: new ConstantValue(2),
        shape: this._waterHitShape,
        material: splashMaterial,
        renderOrder: 50,
        renderMode: RenderMode.BillBoard,
        startRotation: new IntervalValue(0, Math.PI * 2),
        behaviors: [alphaBehavior, splashSizeOverLife, splashWind, killBehavior]
      });

      system.emitter.position.set(centerX, centerY, groundZ + 10);
      system.emitter.rotation.set(0, 0, 0);

      if (this.scene) this.scene.add(system.emitter);
      this.batchRenderer.addSystem(system);

      try {
        const idx = this.batchRenderer.systemToBatchIndex?.get(system);
        if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
          const batch = this.batchRenderer.batches[idx];
          if (batch.material) {
            this._waterHitSplashBatchMaterials.push(batch.material);
            this._patchRoofMaskMaterial(batch.material);
          }
        }
      } catch (e) {
        log.warn('Failed to patch water-hit splash batch material:', e);
      }

      this._waterHitSplashSystems[tileIndex] = { system, alphaBehavior, splashWind };
      return system;
    };

    // Tile indices: 0=(0,0 thin ring), 1=(1,0 broken ring), 2=(0,1 droplets), 3=(1,1 puddle)
    createSplashSystemForTile(0);
    createSplashSystemForTile(1);
    createSplashSystemForTile(2);
    createSplashSystemForTile(3);

    createWaterHitSplashSystemForTile(0);
    createWaterHitSplashSystemForTile(1);
    createWaterHitSplashSystemForTile(2);
    createWaterHitSplashSystemForTile(3);

    const foamMaterial = new THREE.MeshBasicMaterial({
      map: this.foamTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
      color: 0xffffff,
      opacity: 1.0
    });

    foamMaterial.userData = foamMaterial.userData || {};
    foamMaterial.userData.msFoamPlume = true;

    this._foamMaterial = foamMaterial;
    this._patchRoofMaskMaterial(this._foamMaterial);

    const foamPlumeBehavior = new FoamPlumeBehavior();
    this._foamPlumeBehavior = foamPlumeBehavior;

    this._foamSystem = new ParticleSystem({
      duration: 1,
      looping: true,
      prewarm: false,
      startLife: new IntervalValue(0.6, 1.4),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(40, 90),
      startColor: new ColorRange(new Vector4(1.0, 1.0, 1.0, 1.0), new Vector4(1.0, 1.0, 1.0, 1.0)),
      worldSpace: true,
      maxParticles: 2500,
      emissionOverTime: new ConstantValue(0),
      shape: this._waterFoamShape,
      material: foamMaterial,
      renderOrder: 50,
      renderMode: RenderMode.BillBoard,
      startRotation: new ConstantValue(0),
      behaviors: [foamPlumeBehavior, killBehavior]
    });

    this._foamSystem.emitter.position.set(centerX, centerY, groundZ + 10);
    this._foamSystem.emitter.rotation.set(0, 0, 0);
    this._foamSystem.emitter.layers.set(OVERLAY_THREE_LAYER);
    if (this.scene) this.scene.add(this._foamSystem.emitter);
    this.batchRenderer.addSystem(this._foamSystem);

    try {
      const idx = this.batchRenderer.systemToBatchIndex?.get(this._foamSystem);
      if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
        const batch = this.batchRenderer.batches[idx];
        if (batch.material) {
          this._foamBatchMaterial = batch.material;
          this._patchRoofMaskMaterial(batch.material);
          if (batch.layers && typeof batch.layers.set === 'function') {
            batch.layers.set(OVERLAY_THREE_LAYER);
          }
        }
      }
    } catch (e) {
      log.warn('Failed to patch foam batch material:', e);
    }

    // --- FOAM FLECKS (wind-acceleration lift) ---
    // Outdoors-only: actual spawn is gated in FoamFleckEmitter using the roof mask.
    // Emission rate is driven in update() by wind acceleration (windSpeed increasing).
    const foamFleckMaterial = new THREE.MeshBasicMaterial({
      map: this.foamFleckTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xffffff,
      opacity: 1.0
    });
    this._foamFleckMaterial = foamFleckMaterial;

    const foamFleckBehavior = new FoamFleckBehavior();
    this._foamFleckBehavior = foamFleckBehavior;

    this._foamFleckSystem = new ParticleSystem({
      duration: 1,
      looping: true,
      prewarm: false,
      startLife: new IntervalValue(0.6, 1.2),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(2.0, 4.5),
      startColor: new ColorRange(new Vector4(1.0, 1.0, 1.0, 1.0), new Vector4(1.0, 1.0, 1.0, 1.0)),
      worldSpace: false,
      maxParticles: 1200,
      emissionOverTime: new ConstantValue(0),
      shape: this._foamFleckEmitter,
      material: foamFleckMaterial,
      renderOrder: 50,
      renderMode: RenderMode.BillBoard,
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [foamFleckBehavior, this._foamFleckKillBehavior]
    });

    this._foamFleckSystem.emitter.position.set(centerX, centerY, groundZ + 10);
    this._foamFleckSystem.emitter.rotation.set(0, 0, 0);
    this._foamFleckSystem.emitter.layers.set(OVERLAY_THREE_LAYER);
    if (this.scene) this.scene.add(this._foamFleckSystem.emitter);
    this.batchRenderer.addSystem(this._foamFleckSystem);

    // Batch material caching is useful for consistent render settings even though
    // we don't inject roof masking into this shader.
    try {
      const idx = this.batchRenderer.systemToBatchIndex?.get(this._foamFleckSystem);
      if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
        const batch = this.batchRenderer.batches[idx];
        if (batch.material) {
          this._foamFleckBatchMaterial = batch.material;
          if (batch.layers && typeof batch.layers.set === 'function') {
            batch.layers.set(OVERLAY_THREE_LAYER);
          }
        }
      }
    } catch (e) {
      log.warn('Failed to cache foam fleck batch material:', e);
    }

    // --- SNOW ---
     const snowMaterial = new THREE.MeshBasicMaterial({
       map: this.snowTexture,
       transparent: true,
       depthWrite: false,
       depthTest: false,
       blending: THREE.AdditiveBlending,
       color: 0xffffff,
       opacity: 1.0,
       side: THREE.DoubleSide
     });

     this._snowMaterial = snowMaterial;

    // Inject roof mask support into the snow material as well.
    this._patchRoofMaskMaterial(this._snowMaterial);

    // Slower gravity for snow; lateral motion (wind + turbulence) will be configured per-frame.
    // Increase gravity so flakes clearly fall rather than drifting mostly sideways.
    const snowGravity = new ApplyForce(new THREE.Vector3(0, 0, -1), new ConstantValue(this._snowBaseGravity));
    const snowWind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(800));

    // Curl-noise flow field for snow: divergence-free-looking swirls built
    // from scalar noise, creating gentle eddies in the XY plane.
    const snowCurl = new CurlNoiseField(
      new THREE.Vector3(900, 900, 1200),   // spatial scale (large, lazy cells)
      new THREE.Vector3(140, 140, 40),     // swirl strength (XY, Z)
      0.06                                  // time scale (slower evolution)
    );

    // Per-flake flutter to capture the "paper falling" rocking motion.
    const snowFlutter = new SnowFlutterBehavior();
    // Gentle spin while airborne; stops once SnowFloorBehavior marks flakes as
    // landed via the _landed flag.
    const snowSpin = new SnowSpinBehavior();

     this.snowSystem = new ParticleSystem({
       duration: 5,
       looping: true,
       // prewarm disabled — blocks event loop during loading. Snow fills in within ~5s.
       prewarm: false,
       startLife: new IntervalValue(4, 6),
       startSpeed: new IntervalValue(200, 400),
       startSize: new IntervalValue(8, 12), // Snow can be larger
       startColor: new ColorRange(new Vector4(1, 1, 1, 0.8), new Vector4(1, 1, 1, 0.4)),
       worldSpace: true,
       maxParticles: 8000,
      emissionOverTime: new ConstantValue(0),
      shape: new RandomRectangleEmitter({ width: sceneW, height: sceneH }),
      material: snowMaterial,
      renderOrder: 50,
      // Snow uses standard Billboards (flakes don't stretch)
      renderMode: RenderMode.BillBoard,
      // 2x2 flake atlas: four variants.
      uTileCount: 2,
      vTileCount: 2,
      // Randomly choose one of the four atlas tiles per particle.
      // NOTE: IntervalValue uses lerp(a, b, random) where random ∈ [0,1),
      // so IntervalValue(0,3) produces [0,3) and floor() never yields 3.
      // Use (0,4) so floor([0,4)) → {0,1,2,3}.
      startTileIndex: new IntervalValue(0, 4),
      startRotation: new IntervalValue(0, Math.PI * 2),
      // Horizontal motion now comes only from snowWind (driven by windSpeed)
      // and snowCurl (turbulence field), plus gravity for vertical fall.
      // SnowFloorBehavior owns ground contact + fade-out, while SnowSpinBehavior
      // adds a gentle rotation only while flakes are airborne. A relaxed
      // WorldVolumeKillBehavior (snowKillBehavior) still enforces the scene
      // rectangle in X/Y so flakes cannot drift infinitely off the sides.
      behaviors: [
        snowGravity,
        snowWind,
        snowCurl,
        snowColorOverLife,
        snowFlutter,
        snowSpin,
        new SnowFloorBehavior(),
        new RainFadeInBehavior(),
        snowKillBehavior
      ],
    });
     
     this.snowSystem.emitter.position.set(centerX, centerY, safeEmitterZ);
     this.snowSystem.emitter.rotation.set(Math.PI, 0, 0);

     if (this.scene) this.scene.add(this.snowSystem.emitter);
     this.batchRenderer.addSystem(this.snowSystem);

     // Patch the quarks batch material used for snow as well.
     try {
       const idx = this.batchRenderer.systemToBatchIndex?.get(this.snowSystem);
       if (idx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[idx]) {
         const batch = this.batchRenderer.batches[idx];
         if (batch.material) {
           this._snowBatchMaterial = batch.material;
           this._snowBatchMaterial.side = THREE.DoubleSide;
           this._patchRoofMaskMaterial(this._snowBatchMaterial);
         }
       }
     } catch (e) {
       log.warn('Failed to patch snow batch material for roof mask:', e);
     }
     
     // Cache references to key forces/behaviors so we can drive them from WeatherController
     this._rainWindForce = wind;
    this._snowWindForce = snowWind;
    this._rainGravityForce = gravity;
    this._snowGravityForce = snowGravity;
    this._snowCurl = snowCurl;
    this._snowCurlBaseStrength = snowCurl.strength.clone();
    this._snowFlutter = snowFlutter;
    this._rainCurl = rainCurl;
    this._rainCurlBaseStrength = rainCurl.strength.clone();

    // --- ASH ---
    // Ash precipitation: slower, heavier than snow, grey/charcoal colored
    const ashMaterial = new THREE.MeshBasicMaterial({
      map: this.ashTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending, // Normal blending for darker particles
      color: 0x605550, // Grey/charcoal tint
      opacity: 0.85,
      side: THREE.DoubleSide
    });

    this._ashMaterial = ashMaterial;
    this._patchRoofMaskMaterial(this._ashMaterial);

    // Ash falls slower than snow with less wind response
    const ashGravity = new ApplyForce(new THREE.Vector3(0, 0, -1), new ConstantValue(this._ashBaseGravity));
    const ashWind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(400)); // Less wind influence

    // Gentle curl noise for ash - less energetic than snow
    const ashCurl = new CurlNoiseField(
      new THREE.Vector3(1200, 1200, 1500),   // Larger spatial scale (lazier cells)
      new THREE.Vector3(80, 80, 20),         // Weaker swirl strength
      0.04                                    // Slower time evolution
    );

    // Ash color over life: fade from grey to slightly darker
    const ashColorOverLife = new ColorOverLife(new ColorRange(
      new Vector4(0.4, 0.38, 0.35, 0.8),  // Start: grey with good alpha
      new Vector4(0.3, 0.28, 0.25, 0.3)   // End: darker, faded
    ));

    this.ashSystem = new ParticleSystem({
      duration: 6,
      looping: true,
      // prewarm disabled — blocks event loop during loading. Ash fills in within ~6s.
      prewarm: false,
      startLife: new IntervalValue(5, 8), // Longer life than snow
      startSpeed: new IntervalValue(120, 200), // Slower than snow
      startSize: new IntervalValue(10, 16), // Slightly larger than snow
      startColor: new ColorRange(new Vector4(0.45, 0.42, 0.38, 0.75), new Vector4(0.35, 0.32, 0.28, 0.5)),
      worldSpace: true,
      maxParticles: 6000,
      emissionOverTime: new ConstantValue(0),
      shape: new RandomRectangleEmitter({ width: sceneW, height: sceneH }),
      material: ashMaterial,
      renderOrder: 48, // Slightly below snow
      renderMode: RenderMode.BillBoard,
      uTileCount: 2,
      vTileCount: 2,
      // 2x2 atlas → valid tile indices are 0, 1, 2, 3
      startTileIndex: new IntervalValue(0, 3),
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
        ashGravity,
        ashWind,
        ashCurl,
        ashColorOverLife,
        new SnowFloorBehavior(), // Reuse floor behavior
        new RainFadeInBehavior(),
        snowKillBehavior // Reuse kill behavior
      ],
    });

    this.ashSystem.emitter.position.set(centerX, centerY, safeEmitterZ);
    this.ashSystem.emitter.rotation.set(Math.PI, 0, 0);

    if (this.scene) this.scene.add(this.ashSystem.emitter);
    this.batchRenderer.addSystem(this.ashSystem);

    // Cache base emitter dimensions for clustering.
    this._ashBaseEmitterW = sceneW;
    this._ashBaseEmitterH = sceneH;

    // --- ASH EMBERS ---
    // Small percentage of glowing embers that cool from red -> orange -> grey.
    const ashEmberMaterial = new THREE.MeshBasicMaterial({
      map: this.ashTexture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      color: 0xff6a2a,
      opacity: 1.0,
      side: THREE.DoubleSide
    });

    this._ashEmberMaterial = ashEmberMaterial;
    this._patchRoofMaskMaterial(this._ashEmberMaterial);

    const ashEmberGravity = new ApplyForce(new THREE.Vector3(0, 0, -1), new ConstantValue(this._ashBaseGravity * 0.75));
    const ashEmberWind = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(650));
    const ashEmberCurl = new CurlNoiseField(
      new THREE.Vector3(900, 900, 1200),
      new THREE.Vector3(140, 140, 40),
      0.08
    );

    const ashEmberColorOverLife = new ColorOverLife(new ColorRange(
      new Vector4(1.0, 0.25, 0.05, 0.9),
      new Vector4(0.35, 0.32, 0.28, 0.0)
    ));

    this.ashEmberSystem = new ParticleSystem({
      duration: 4,
      looping: true,
      // prewarm disabled — blocks event loop during loading. Embers fill in within ~4s.
      prewarm: false,
      startLife: new IntervalValue(2.5, 4.0),
      startSpeed: new IntervalValue(180, 260),
      startSize: new IntervalValue(6, 12),
      startColor: new ColorRange(new Vector4(1.0, 0.35, 0.1, 0.9), new Vector4(0.9, 0.4, 0.1, 0.4)),
      worldSpace: true,
      maxParticles: 600,
      emissionOverTime: new ConstantValue(0),
      shape: new RandomRectangleEmitter({ width: sceneW, height: sceneH }),
      material: ashEmberMaterial,
      renderOrder: 49,
      renderMode: RenderMode.BillBoard,
      uTileCount: 2,
      vTileCount: 2,
      // 2x2 atlas → valid tile indices are 0, 1, 2, 3
      startTileIndex: new IntervalValue(0, 3),
      startRotation: new IntervalValue(0, Math.PI * 2),
      behaviors: [
        ashEmberGravity,
        ashEmberWind,
        ashEmberCurl,
        ashEmberColorOverLife,
        new SnowFloorBehavior(),
        new RainFadeInBehavior(),
        snowKillBehavior
      ],
    });

    this.ashEmberSystem.emitter.position.set(centerX, centerY, safeEmitterZ);
    this.ashEmberSystem.emitter.rotation.set(Math.PI, 0, 0);
    if (this.scene) this.scene.add(this.ashEmberSystem.emitter);
    this.batchRenderer.addSystem(this.ashEmberSystem);

    try {
      const emberIdx = this.batchRenderer.systemToBatchIndex?.get(this.ashEmberSystem);
      if (emberIdx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[emberIdx]) {
        const batch = this.batchRenderer.batches[emberIdx];
        if (batch.material) {
          this._ashEmberBatchMaterial = batch.material;
          this._ashEmberBatchMaterial.side = THREE.DoubleSide;
          this._patchRoofMaskMaterial(this._ashEmberBatchMaterial);
        }
      }
    } catch (e) {
      log.warn('Failed to patch ash ember batch material for roof mask:', e);
    }

    // Patch the quarks batch material used for ash
    try {
      const ashIdx = this.batchRenderer.systemToBatchIndex?.get(this.ashSystem);
      if (ashIdx !== undefined && this.batchRenderer.batches && this.batchRenderer.batches[ashIdx]) {
        const batch = this.batchRenderer.batches[ashIdx];
        if (batch.material) {
          this._ashBatchMaterial = batch.material;
          this._ashBatchMaterial.side = THREE.DoubleSide;
          this._patchRoofMaskMaterial(this._ashBatchMaterial);
        }
      }
    } catch (e) {
      log.warn('Failed to patch ash batch material for roof mask:', e);
    }

    // Cache ash force references
    this._ashWindForce = ashWind;
    this._ashGravityForce = ashGravity;
    this._ashCurl = ashCurl;
    this._ashCurlBaseStrength = ashCurl.strength.clone();
    this._ashColorOverLife = ashColorOverLife;
    this._ashEmberWindForce = ashEmberWind;
    this._ashEmberGravityForce = ashEmberGravity;
    this._ashEmberCurl = ashEmberCurl;
    this._ashEmberCurlBaseStrength = ashEmberCurl.strength.clone();
    this._ashEmberColorOverLife = ashEmberColorOverLife;

     log.info(`Weather systems initialized. Area: ${sceneW}x${sceneH}`);
  }

  /**
   * Patch a MeshBasicMaterial to support sampling the roof/_Outdoors mask.
   * This keeps the existing lighting and texturing logic intact and only adds
   * a late discard based on uRoofMap/uSceneBounds/uRoofMaskEnabled.
   * @param {THREE.Material} material
   * @private
   */
  _patchRoofMaskMaterial(material) {
    const THREE = window.THREE;
    if (!material || !THREE) return;

    // PERF: Avoid forcing recompiles unless we actually change shader source or compilation hooks.
    // Unconditional material.needsUpdate triggers program churn which shows up as getUniformList()
    // in profilers and can cause heavy Cycle Collection.

    // Quarks can rebuild/replace ShaderMaterial shader strings after we initially patch.
    // So we treat this patcher as *idempotent*: reuse existing uniforms when present,
    // but re-inject the GLSL if it is missing.
    const existingUniforms = material.userData?.roofUniforms || null;

    // These uniforms live on material.userData so WeatherParticles.update can
    // drive them every frame. They are then wired into either the real
    // ShaderMaterial.uniforms (for quarks SpriteBatches) or into the shader
    // object passed to onBeforeCompile (for plain MeshBasicMaterials).
    //
    // DUAL-MASK SYSTEM:
    // - uRoofMap: World-space _Outdoors mask (white=outdoors, black=indoors)
    // - uRoofAlphaMap: Screen-space roof alpha from LightingEffect (alpha>0 = roof visible)
    //
    // Logic:
    // - Show rain if: (outdoors AND roof hidden) OR (roof visible - rain lands on roof)
    // - Hide rain if: indoors AND no visible roof overhead
    const uniforms = existingUniforms || {
      uRoofMap: { value: null },
      uRoofAlphaMap: { value: null },
      // (sceneX, sceneY, sceneWidth, sceneHeight) in world units
      uSceneBounds: { value: new THREE.Vector4(0, 0, 1, 1) },
      // 0.0 = disabled, 1.0 = enabled
      uRoofMaskEnabled: { value: 0.0 },
      // 0.0 = no roof alpha map, 1.0 = has roof alpha map
      uHasRoofAlphaMap: { value: 0.0 },
      // Screen size for gl_FragCoord -> UV conversion
      uScreenSize: { value: new THREE.Vector2(1920, 1080) },
      uWaterMask: { value: null },
      uWaterMaskEnabled: { value: 0.0 },
      uWaterMaskThreshold: { value: 0.15 },
      // When > 0.5, flip the V coordinate when sampling uWaterMask.
      // Use this to match Three.js texture flipY conventions.
      uWaterMaskFlipY: { value: 0.0 },
      // Screen-space tile-driven water occluder alpha (from DistortionManager.waterOccluderTarget)
      tWaterOccluderAlpha: { value: null },
      uHasWaterOccluderAlpha: { value: 0.0 }
      ,
      // Foam plume post-alpha shaping (foam.webp only)
      uFoamAdditiveBoost: { value: 1.0 },
      uFoamRadialEnabled: { value: 0.0 },
      uFoamRadialInnerPos: { value: 0.0 },
      uFoamRadialMidPos: { value: 0.5 },
      uFoamRadialInnerOpacity: { value: 1.0 },
      uFoamRadialMidOpacity: { value: 1.0 },
      uFoamRadialOuterOpacity: { value: 1.0 },
      uFoamRadialCurve: { value: 1.0 }
    };

    // Upgrade older cached uniform packs in-place.
    // (We reuse material.userData.roofUniforms to keep this patcher idempotent.)
    if (!uniforms.tWaterOccluderAlpha) uniforms.tWaterOccluderAlpha = { value: null };
    if (!uniforms.uHasWaterOccluderAlpha) uniforms.uHasWaterOccluderAlpha = { value: 0.0 };
    if (!uniforms.uFoamAdditiveBoost) uniforms.uFoamAdditiveBoost = { value: 1.0 };
    if (!uniforms.uFoamRadialEnabled) uniforms.uFoamRadialEnabled = { value: 0.0 };
    if (!uniforms.uFoamRadialInnerPos) uniforms.uFoamRadialInnerPos = { value: 0.0 };
    if (!uniforms.uFoamRadialMidPos) uniforms.uFoamRadialMidPos = { value: 0.5 };
    if (!uniforms.uFoamRadialInnerOpacity) uniforms.uFoamRadialInnerOpacity = { value: 1.0 };
    if (!uniforms.uFoamRadialMidOpacity) uniforms.uFoamRadialMidOpacity = { value: 1.0 };
    if (!uniforms.uFoamRadialOuterOpacity) uniforms.uFoamRadialOuterOpacity = { value: 1.0 };
    if (!uniforms.uFoamRadialCurve) uniforms.uFoamRadialCurve = { value: 1.0 };

    // Store for per-frame updates in update()
    material.userData = material.userData || {};
    material.userData.roofUniforms = uniforms;

    const isShaderMat = material.isShaderMaterial === true;

    // The GLSL fragment code for dual-mask precipitation visibility.
    // This is shared between ShaderMaterial and onBeforeCompile paths.
    const maskMarker = 'MS_ROOF_WATER_MASK';
    const fragmentMaskCode =
      '  // ' + maskMarker + '\n' +
      '  // DUAL-MASK PRECIPITATION VISIBILITY\n' +
      '  // uRoofMap: _Outdoors mask (world-space, white=outdoors, black=indoors)\n' +
      '  // uRoofAlphaMap: screen-space roof alpha (alpha>0 = roof visible)\n' +
      '  {\n' +
      '    // Map world XY into 0..1 UVs inside the scene rectangle for _Outdoors mask.\n' +
      '    vec2 uvMask = vec2(\n' +
      '      (vRoofWorldPos.x - uSceneBounds.x) / uSceneBounds.z,\n' +
      '      1.0 - (vRoofWorldPos.y - uSceneBounds.y) / uSceneBounds.w\n' +
      '    );\n' +
      '    \n' +
      '    // Quick bounds check to avoid sampling outside the mask.\n' +
      '    if (uvMask.x < 0.0 || uvMask.x > 1.0 || uvMask.y < 0.0 || uvMask.y > 1.0) {\n' +
      '      discard;\n' +
      '    }\n' +
      '    \n' +
      '    // Sample _Outdoors mask (world-space): white=outdoors, black=indoors\n' +
      '    float outdoorsMask = 1.0;\n' +
      '    if (uRoofMaskEnabled > 0.5) {\n' +
      '      outdoorsMask = texture2D(uRoofMap, uvMask).r;\n' +
      '    }\n' +
      '    \n' +
      '    // Sample roof alpha (screen-space): alpha>0 = roof tile visible\n' +
      '    // roofAlphaTarget is rendered with the same camera, so we use\n' +
      '    // gl_FragCoord to get proper screen-space UVs.\n' +
      '    float roofAlpha = 0.0;\n' +
      '    if (uHasRoofAlphaMap > 0.5) {\n' +
      '      // gl_FragCoord.xy gives pixel coordinates, divide by viewport size\n' +
      '      // uScreenSize is passed as (width, height) in the uniform\n' +
      '      vec2 screenUv = gl_FragCoord.xy / uScreenSize;\n' +
      '      roofAlpha = texture2D(uRoofAlphaMap, screenUv).a;\n' +
      '    }\n' +
      '    \n' +
      '    // VISIBILITY LOGIC:\n' +
      '    // Show rain if:\n' +
      '    //   1. Roof is visible (roofAlpha > 0.1) - rain lands on roof\n' +
      '    //   2. OR: Outdoors (outdoorsMask > 0.5) AND roof hidden (roofAlpha < 0.1)\n' +
      '    // Hide rain if:\n' +
      '    //   Indoors (outdoorsMask < 0.5) AND no visible roof (roofAlpha < 0.1)\n' +
      '    \n' +
      '    bool roofVisible = roofAlpha > 0.1;\n' +
      '    bool isOutdoors = outdoorsMask > 0.5;\n' +
      '    \n' +
      '    // Rain shows on visible roofs OR in outdoor areas without roofs\n' +
      '    bool showPrecip = roofVisible || isOutdoors;\n' +
      '    \n' +
      '    if (!showPrecip) {\n' +
      '      discard;\n' +
      '    }\n' +
      '    if (uWaterMaskEnabled > 0.5) {\n' +
      '      vec2 uvWater = uvMask;\n' +
      '      if (uWaterMaskFlipY > 0.5) uvWater.y = 1.0 - uvWater.y;\n' +
      '      vec4 m = texture2D(uWaterMask, uvWater);\n' +
      '      float wm = dot(m.rgb, vec3(0.299, 0.587, 0.114)) * m.a;\n' +
      '      // Soft edge: fade opacity instead of hard-discarding at the water boundary.\n' +
      '      // This makes foam.webp particles look more natural along shorelines.\n' +
      '      float waterSoftness = 0.08;\n' +
      '      float waterFade = smoothstep(uWaterMaskThreshold - waterSoftness, uWaterMaskThreshold + waterSoftness, wm);\n' +
      '      msWaterFade *= waterFade;\n' +
      '      if (msWaterFade <= 0.001) discard;\n' +
      '    }\n' +
      '    // Tile-driven _Water masking (screen-space) via DistortionManager water occluder target.\n' +
      '    // This suppresses plume particles under tiles whose per-tile _Water masks indicate\n' +
      '    // no water (i.e., non-water regions of bridges/shore tiles).\n' +
      '    if (uHasWaterOccluderAlpha > 0.5) {\n' +
      '      vec2 screenUv2 = gl_FragCoord.xy / uScreenSize;\n' +
      '      float occA = texture2D(tWaterOccluderAlpha, screenUv2).a;\n' +
      '      float visible = 1.0 - clamp(occA, 0.0, 1.0);\n' +
      '      msWaterFade *= visible;\n' +
      '      if (msWaterFade <= 0.001) discard;\n' +
      '    }\n' +
      '  }\n';

    const isFoamPlume = material.userData?.msFoamPlume === true;
    const foamMarker = 'MS_FOAM_PLUME_ALPHA';
    const foamUniformsCode =
      'uniform float uFoamAdditiveBoost;\n' +
      'uniform float uFoamRadialEnabled;\n' +
      'uniform float uFoamRadialInnerPos;\n' +
      'uniform float uFoamRadialMidPos;\n' +
      'uniform float uFoamRadialInnerOpacity;\n' +
      'uniform float uFoamRadialMidOpacity;\n' +
      'uniform float uFoamRadialOuterOpacity;\n' +
      'uniform float uFoamRadialCurve;\n';
    const foamAlphaCode =
      '  // ' + foamMarker + '\n' +
      '  {\n' +
      '    // Additive strength boost (used to compensate for low per-particle opacity)\n' +
      '    // NOTE: this is only intended for foam.webp plume particles.\n' +
      '    gl_FragColor.a *= max(0.0, uFoamAdditiveBoost);\n' +
      '    \n' +
      '    // Optional radial opacity gradient (center->edge) driven by vUv.\n' +
      '    if (uFoamRadialEnabled > 0.5) {\n' +
      '      vec2 d = vUv - vec2(0.5);\n' +
      '      float r = clamp(length(d) * 2.0, 0.0, 1.0);\n' +
      '      float p0 = clamp(uFoamRadialInnerPos, 0.0, 1.0);\n' +
      '      float p1 = clamp(uFoamRadialMidPos, 0.0, 1.0);\n' +
      '      if (p1 < p0) { float tmp = p0; p0 = p1; p1 = tmp; }\n' +
      '      float curve = max(0.001, uFoamRadialCurve);\n' +
      '      float t01 = (p1 > p0) ? clamp((r - p0) / (p1 - p0), 0.0, 1.0) : step(p0, r);\n' +
      '      float t12 = (1.0 > p1) ? clamp((r - p1) / (1.0 - p1), 0.0, 1.0) : step(p1, r);\n' +
      '      t01 = pow(t01, curve);\n' +
      '      t12 = pow(t12, curve);\n' +
      '      float a01 = mix(uFoamRadialInnerOpacity, uFoamRadialMidOpacity, t01);\n' +
      '      float a12 = mix(uFoamRadialMidOpacity, uFoamRadialOuterOpacity, t12);\n' +
      '      float sel = step(p1, r);\n' +
      '      float radialA = mix(a01, a12, sel);\n' +
      '      gl_FragColor.a *= max(0.0, radialA);\n' +
      '    }\n' +
      '  }\n';

    if (isShaderMat) {
      // Directly patch the quarks SpriteBatch ShaderMaterial in place. This is
      // the path used for the actual batched rain/snow draw calls produced by
      // three.quarks' BatchedRenderer.
      const uni = material.uniforms || (material.uniforms = {});
      uni.uRoofMap = uniforms.uRoofMap;
      uni.uRoofAlphaMap = uniforms.uRoofAlphaMap;
      uni.uSceneBounds = uniforms.uSceneBounds;
      uni.uRoofMaskEnabled = uniforms.uRoofMaskEnabled;
      uni.uHasRoofAlphaMap = uniforms.uHasRoofAlphaMap;
      uni.uScreenSize = uniforms.uScreenSize;
      uni.uWaterMask = uniforms.uWaterMask;
      uni.uWaterMaskEnabled = uniforms.uWaterMaskEnabled;
      uni.uWaterMaskThreshold = uniforms.uWaterMaskThreshold;
      uni.uWaterMaskFlipY = uniforms.uWaterMaskFlipY;
      uni.tWaterOccluderAlpha = uniforms.tWaterOccluderAlpha;
      uni.uHasWaterOccluderAlpha = uniforms.uHasWaterOccluderAlpha;
      uni.uFoamAdditiveBoost = uniforms.uFoamAdditiveBoost;
      uni.uFoamRadialEnabled = uniforms.uFoamRadialEnabled;
      uni.uFoamRadialInnerPos = uniforms.uFoamRadialInnerPos;
      uni.uFoamRadialMidPos = uniforms.uFoamRadialMidPos;
      uni.uFoamRadialInnerOpacity = uniforms.uFoamRadialInnerOpacity;
      uni.uFoamRadialMidOpacity = uniforms.uFoamRadialMidOpacity;
      uni.uFoamRadialOuterOpacity = uniforms.uFoamRadialOuterOpacity;
      uni.uFoamRadialCurve = uniforms.uFoamRadialCurve;

      let shaderChanged = false;

      if (typeof material.vertexShader === 'string') {
        const beforeVS = material.vertexShader;
        // All quarks billboard variants use an `offset` attribute plus
        // #include <soft_vertex>. We piggyback on that include to compute a
        // world-space position once per vertex, without depending on quarks'
        // internal naming of matrices.
        //
        // IMPORTANT: For foam.webp we need the mask to clip the *sprite shape*, not
        // just the particle center. Quarks billboards offset the quad corners via
        // `rotatedPosition` in the vertex shader. We add that same offset to our
        // world position so vRoofWorldPos interpolates across the quad.
        if (!material.vertexShader.includes('varying vec3 vRoofWorldPos')) {
          material.vertexShader = material.vertexShader
            .replace(
              'void main() {',
              'varying vec3 vRoofWorldPos;\nvoid main() {'
            );
        }
        const legacyAssign = 'vRoofWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;';
        const upgradedAssign = 'vRoofWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;\n  vRoofWorldPos.xy += rotatedPosition;';
        const hasRotatedPosition = /\brotatedPosition\b/.test(material.vertexShader);
        const desiredAssign = hasRotatedPosition ? upgradedAssign : legacyAssign;
        if (material.vertexShader.includes(legacyAssign) && !material.vertexShader.includes(desiredAssign)) {
          material.vertexShader = material.vertexShader.replace(legacyAssign, desiredAssign);
        }
        if (!material.vertexShader.includes('vRoofWorldPos =')) {
          material.vertexShader = material.vertexShader
            .replace(
              '#include <soft_vertex>',
              '#include <soft_vertex>\n  ' + desiredAssign
            );
        }

        if (material.vertexShader !== beforeVS) shaderChanged = true;
      }

      if (typeof material.fragmentShader === 'string') {
        const beforeFS = material.fragmentShader;
        let fs = material.fragmentShader;

        // Only (re)inject if missing. Prevents runaway growth if _patchRoofMaskMaterial
        // is called repeatedly (which it is).
        const needsInject = !fs.includes(maskMarker);

        if (needsInject) {
          fs = fs.replace(
            'void main() {',
            'varying vec3 vRoofWorldPos;\n' +
            'uniform sampler2D uRoofMap;\n' +
            'uniform sampler2D uRoofAlphaMap;\n' +
            'uniform vec4 uSceneBounds;\n' +
            'uniform float uRoofMaskEnabled;\n' +
            'uniform float uHasRoofAlphaMap;\n' +
            'uniform vec2 uScreenSize;\n' +
            'uniform sampler2D uWaterMask;\n' +
            'uniform float uWaterMaskEnabled;\n' +
            'uniform float uWaterMaskThreshold;\n' +
            'uniform float uWaterMaskFlipY;\n' +
            'uniform sampler2D tWaterOccluderAlpha;\n' +
            'uniform float uHasWaterOccluderAlpha;\n' +
            'void main() {\n' +
            '  float msWaterFade = 1.0;'
          );

          // Quarks shader variants should include <soft_fragment>, but some builds/materials
          // may not. If the include isn't present, fall back to injecting the mask block
          // at the top of main().
          if (fs.includes('#include <soft_fragment>')) {
            fs = fs.replace('#include <soft_fragment>', fragmentMaskCode + '#include <soft_fragment>\n  gl_FragColor.a *= msWaterFade;\n');
          } else {
            fs = fs.replace('void main() {', 'void main() {\n  float msWaterFade = 1.0;\n' + fragmentMaskCode);
            // Fallback: best-effort alpha multiply near the end of main.
            // (Most quarks shader variants include <soft_fragment>, so this should rarely trigger.)
            fs = fs.replace(/\n}\s*$/, '\n  gl_FragColor.a *= msWaterFade;\n}');
          }

          material.fragmentShader = fs;
          shaderChanged = true;
        }

        if (isFoamPlume && !material.fragmentShader.includes(foamMarker)) {
          // Ensure foam plume alpha shaping runs before soft particles + tonemapping.
          // Keep the existing water/roof discard logic intact.
          // 1) Declare uniforms at global scope
          material.fragmentShader = material.fragmentShader.replace(
            'void main() {',
            foamUniformsCode + 'void main() {'
          );
          // 2) Inject alpha shaping inside main, before soft particles
          material.fragmentShader = material.fragmentShader.replace(
            '#include <soft_fragment>',
            foamAlphaCode + '#include <soft_fragment>'
          );
          shaderChanged = true;
        }

        if (material.fragmentShader !== beforeFS) shaderChanged = true;
      }

      if (shaderChanged) material.needsUpdate = true;
      return;
    }

    // Fallback path: patch non-ShaderMaterials via onBeforeCompile so quarks
    // can pick up the modifications when building its internal ShaderMaterial
    // from our MeshBasicMaterial template. The injected code is the same as
    // above; the only difference is that we edit the temporary `shader`
    // object instead of the final ShaderMaterial instance.
    const ud = material.userData || (material.userData = {});
    const alreadyInstalled = ud._msRoofMaskOnBeforeCompileInstalled === true && typeof ud._msRoofMaskOnBeforeCompileFn === 'function';
    const needInstall = !alreadyInstalled;

    if (!needInstall) {
      // Uniform objects are shared and mutated per-frame by update(), so we don't need to
      // reinstall onBeforeCompile or force a recompile.
      return;
    }

    const fn = (shader) => {
      shader.uniforms.uRoofMap = uniforms.uRoofMap;
      shader.uniforms.uRoofAlphaMap = uniforms.uRoofAlphaMap;
      shader.uniforms.uSceneBounds = uniforms.uSceneBounds;
      shader.uniforms.uRoofMaskEnabled = uniforms.uRoofMaskEnabled;
      shader.uniforms.uHasRoofAlphaMap = uniforms.uHasRoofAlphaMap;
      shader.uniforms.uScreenSize = uniforms.uScreenSize;
      shader.uniforms.uWaterMask = uniforms.uWaterMask;
      shader.uniforms.uWaterMaskEnabled = uniforms.uWaterMaskEnabled;
      shader.uniforms.uWaterMaskThreshold = uniforms.uWaterMaskThreshold;
      shader.uniforms.uWaterMaskFlipY = uniforms.uWaterMaskFlipY;
      shader.uniforms.tWaterOccluderAlpha = uniforms.tWaterOccluderAlpha;
      shader.uniforms.uHasWaterOccluderAlpha = uniforms.uHasWaterOccluderAlpha;
      shader.uniforms.uFoamAdditiveBoost = uniforms.uFoamAdditiveBoost;
      shader.uniforms.uFoamRadialEnabled = uniforms.uFoamRadialEnabled;
      shader.uniforms.uFoamRadialInnerPos = uniforms.uFoamRadialInnerPos;
      shader.uniforms.uFoamRadialMidPos = uniforms.uFoamRadialMidPos;
      shader.uniforms.uFoamRadialInnerOpacity = uniforms.uFoamRadialInnerOpacity;
      shader.uniforms.uFoamRadialMidOpacity = uniforms.uFoamRadialMidOpacity;
      shader.uniforms.uFoamRadialOuterOpacity = uniforms.uFoamRadialOuterOpacity;
      shader.uniforms.uFoamRadialCurve = uniforms.uFoamRadialCurve;

      const hasRotatedPosition = /\brotatedPosition\b/.test(shader.vertexShader);

      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          'varying vec3 vRoofWorldPos;\nvoid main() {'
        )
        .replace(
          '#include <soft_vertex>',
          '#include <soft_vertex>\n  vRoofWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;' + (hasRotatedPosition ? '\n  vRoofWorldPos.xy += rotatedPosition;' : '')
        );

      // If this material was previously patched (center-only), upgrade it to
      // per-vertex world position so the water mask clips the sprite shape.
      const legacyAssign = 'vRoofWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;';
      const upgradedAssign = 'vRoofWorldPos = (modelMatrix * vec4(offset, 1.0)).xyz;\n  vRoofWorldPos.xy += rotatedPosition;';
      const desiredAssign = hasRotatedPosition ? upgradedAssign : legacyAssign;
      if (shader.vertexShader.includes(legacyAssign) && !shader.vertexShader.includes(desiredAssign)) {
        shader.vertexShader = shader.vertexShader.replace(legacyAssign, desiredAssign);
      }

      let fs = shader.fragmentShader;
      if (!fs.includes(maskMarker)) {
        fs = fs.replace(
          'void main() {',
          'varying vec3 vRoofWorldPos;\n' +
          'uniform sampler2D uRoofMap;\n' +
          'uniform sampler2D uRoofAlphaMap;\n' +
          'uniform vec4 uSceneBounds;\n' +
          'uniform float uRoofMaskEnabled;\n' +
          'uniform float uHasRoofAlphaMap;\n' +
          'uniform vec2 uScreenSize;\n' +
          'uniform sampler2D uWaterMask;\n' +
          'uniform float uWaterMaskEnabled;\n' +
          'uniform float uWaterMaskThreshold;\n' +
          'uniform float uWaterMaskFlipY;\n' +
          'uniform sampler2D tWaterOccluderAlpha;\n' +
          'uniform float uHasWaterOccluderAlpha;\n' +
          'void main() {\n' +
          '  float msWaterFade = 1.0;'
        );

        if (fs.includes('#include <soft_fragment>')) {
          fs = fs.replace('#include <soft_fragment>', fragmentMaskCode + '#include <soft_fragment>\n  gl_FragColor.a *= msWaterFade;\n');
        } else {
          fs = fs.replace('void main() {', 'void main() {\n  float msWaterFade = 1.0;\n' + fragmentMaskCode);
          fs = fs.replace(/\n}\s*$/, '\n  gl_FragColor.a *= msWaterFade;\n}');
        }

        shader.fragmentShader = fs;
      }

      if (isFoamPlume && !shader.fragmentShader.includes(foamMarker) && shader.fragmentShader.includes('#include <soft_fragment>')) {
        // Declare uniforms at global scope
        shader.fragmentShader = shader.fragmentShader.replace(
          'void main() {',
          foamUniformsCode + 'void main() {'
        );
        // Inject alpha shaping inside main
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <soft_fragment>',
          foamAlphaCode + '#include <soft_fragment>'
        );
      }
    };

    material.onBeforeCompile = fn;
    ud._msRoofMaskOnBeforeCompileInstalled = true;
    ud._msRoofMaskOnBeforeCompileFn = fn;
    material.needsUpdate = true;
  }

  _ensureBatchMaterialPatched(system, cacheProp) {
    if (!system || !cacheProp) return null;
    const br = this.batchRenderer;
    if (!br || !br.systemToBatchIndex || !br.batches) return null;
    const idx = br.systemToBatchIndex.get(system);
    if (idx === undefined) return null;
    const batch = br.batches[idx];
    const mat = batch?.material || null;
    if (!mat) return null;

    // Mark foam materials so _patchRoofMaskMaterial can inject foam-only shader logic.
    if (cacheProp === '_foamBatchMaterial') {
      mat.userData = mat.userData || {};
      mat.userData.msFoamPlume = true;
    }

    // Ensure the actual rendered VFXBatch/SpriteBatch object is on the overlay layer.
    // EffectComposer renders layer 31 in a dedicated overlay pass.
    try {
      if (batch && batch.layers && typeof batch.layers.set === 'function') {
        batch.layers.set(OVERLAY_THREE_LAYER);
      }
    } catch (_) {
    }

    // PERFORMANCE: avoid scanning large shader strings every frame.
    // We treat the material as "already patched" if:
    // - our userData flag is set
    // - fragment/vertex shader string references are unchanged
    // - critical uniforms exist
    const ud = mat.userData || (mat.userData = {});
    const isShaderMat = mat.isShaderMaterial === true;
    const fsRef = isShaderMat ? mat.fragmentShader : null;
    const vsRef = isShaderMat ? mat.vertexShader : null;
    const uniformsOk = !isShaderMat || !!(
      mat.uniforms &&
      mat.uniforms.uWaterMaskThreshold &&
      mat.uniforms.uWaterMaskEnabled &&
      mat.uniforms.uWaterMask &&
      mat.uniforms.uRoofMap &&
      mat.uniforms.uSceneBounds
    );
    const alreadyPatched = !!(
      ud._msRoofMaskPatched === true &&
      ud._msRoofMaskPatchedFs === fsRef &&
      ud._msRoofMaskPatchedVs === vsRef &&
      ud.roofUniforms &&
      uniformsOk
    );

    if (this[cacheProp] !== mat || !alreadyPatched) {
      this[cacheProp] = mat;
      this._patchRoofMaskMaterial(mat);
      // Record shader references after patching.
      if (mat.userData) {
        mat.userData._msRoofMaskPatched = true;
        if (mat.isShaderMaterial === true) {
          mat.userData._msRoofMaskPatchedFs = mat.fragmentShader;
          mat.userData._msRoofMaskPatchedVs = mat.vertexShader;
        } else {
          mat.userData._msRoofMaskPatchedFs = null;
          mat.userData._msRoofMaskPatchedVs = null;
        }
      }
    }
    return mat;
  }

  update(dt, sceneBoundsVec4) {
    // Global Weather checkbox kill-switch.
    // When weather is disabled we must:
    // - hide all precipitation emitters immediately (no frozen rain/snow)
    // - stop emitting new particles
    // We intentionally do NOT stop the Quarks BatchedRenderer globally since
    // other particle effects (fire, dust, etc.) may still be active.
    if (weatherController && weatherController.enabled === false) {
      this._zeroWeatherEmissions();
      this._clearAllRainSplashes();
      this._setWeatherSystemsVisible(false);
      return;
    }

    this._setWeatherSystemsVisible(true);

    const weather = weatherController.getCurrentState();
    if (!weather) return;

    const ms = window.MapShine;
    const debugDisableWeatherSplashes = ms?.debugDisableWeatherSplashes === true;
    const debugDisableWeatherFoam = ms?.debugDisableWeatherFoam === true;
    const debugDisableWeatherBehaviors = ms?.debugDisableWeatherBehaviors === true;

    // Splash LOD: splashes are tiny micro-detail; when zoomed out, reduce them aggressively.
    // Optional tuning via console: window.MapShine.weatherSplashScale = 0..1
    const sceneComposer = window.MapShine?.sceneComposer;
    const zoom = sceneComposer?.currentZoom || 1.0;
    const splashZoomLod = (zoom < 1.0) ? Math.max(0.15, zoom) : 1.0;
    const splashGlobalScale = Number.isFinite(ms?.weatherSplashScale) ? Math.max(0.0, ms.weatherSplashScale) : 1.0;
    const splashEmissionScale = splashGlobalScale * splashZoomLod * splashZoomLod;

    const dbgKey = `${debugDisableWeatherSplashes ? 1 : 0}|${debugDisableWeatherFoam ? 1 : 0}|${debugDisableWeatherBehaviors ? 1 : 0}`;
    if (dbgKey !== this._lastDebugKey) {
      this._lastDebugKey = dbgKey;
      try {
        console.log('[WeatherParticles] Debug flags', {
          debugDisableWeatherSplashes,
          debugDisableWeatherFoam,
          debugDisableWeatherBehaviors
        });
      } catch (_) {
      }
    }
    
    // Safety check: if dt is unexpectedly in MS (e.g. 16.6), clamp it.
    // Three.quarks explodes if given MS instead of Seconds.
    const safeDt = dt > 1.0 ? dt / 1000 : dt;
    this._time += safeDt;

    // Wind acceleration signal for foam flecks (spawn only when wind speed increases).
    const windSpeed01 = Number.isFinite(weather.windSpeed) ? Math.max(0.0, Math.min(1.0, weather.windSpeed)) : 0.0;
    if (safeDt > 1e-6) {
      const dWind = windSpeed01 - (this._foamFleckLastWindSpeed01 ?? 0.0);
      this._foamFleckLastWindSpeed01 = windSpeed01;
      // Only positive acceleration contributes.
      const accel = dWind > 0 ? (dWind / safeDt) : 0.0;

      // Gust ramp-up also represents wind increasing in the moment-to-moment feel.
      // WeatherController.currentGustStrength is a 0..1 envelope with fast attack.
      const gust = Number.isFinite(weatherController?.currentGustStrength) ? weatherController.currentGustStrength : 0.0;
      const dGust = gust - (this._foamFleckLastGust ?? 0.0);
      this._foamFleckLastGust = gust;
      const gustAccel = dGust > 0 ? (dGust / safeDt) : 0.0;

      // Normalize to 0..1 with tuned max acceleration values.
      // These are intentionally small so the signal is non-zero during normal gust attacks
      // and preset transitions.
      const maxWindAccel = 0.08;
      const maxGustAccel = 2.5;
      const accel01 = Math.max(
        Math.max(0.0, Math.min(1.0, accel / maxWindAccel)),
        Math.max(0.0, Math.min(1.0, gustAccel / maxGustAccel))
      );
      // Smooth to avoid flicker.
      const k = 1.0 - Math.exp(-safeDt * 6.0);
      this._foamFleckWindAccel01 = (this._foamFleckWindAccel01 ?? 0.0) + (accel01 - (this._foamFleckWindAccel01 ?? 0.0)) * k;
    } else {
      this._foamFleckLastWindSpeed01 = windSpeed01;
    }

    const THREE = window.THREE;

    // Phase 1 (Quarks perf): view-dependent emission bounds.
    // Reduce spawn area to the camera-visible rectangle (+ margin) instead of the full map.
    // We keep the _Outdoors mask projection in full-scene coordinates via uSceneBounds.
    const mainCamera = sceneComposer?.camera;
    if (THREE && sceneComposer && mainCamera) {
      const viewportWidth = sceneComposer.baseViewportWidth || window.innerWidth;
      const viewportHeight = sceneComposer.baseViewportHeight || window.innerHeight;

      const visibleW = viewportWidth / Math.max(1e-6, zoom);
      const visibleH = viewportHeight / Math.max(1e-6, zoom);

      const marginScale = 1.2;
      const desiredW = visibleW * marginScale;
      const desiredH = visibleH * marginScale;

      // Clamp the view rectangle to the scene rect in *world-space* (Y-up).
      let sceneX = 0;
      let sceneY = 0;
      let sceneW = 0;
      let sceneH = 0;
      try {
        const d = canvas?.dimensions;
        const rect = d?.sceneRect;
        const totalH = d?.height ?? 0;
        if (rect && typeof rect.x === 'number') {
          sceneX = rect.x;
          sceneW = rect.width;
          sceneH = rect.height;
          sceneY = (totalH > 0) ? (totalH - (rect.y + rect.height)) : rect.y;
        } else if (d) {
          sceneX = d.sceneX ?? 0;
          sceneW = d.sceneWidth ?? d.width ?? 0;
          sceneH = d.sceneHeight ?? d.height ?? 0;
          sceneY = (totalH > 0) ? (totalH - ((d.sceneY ?? 0) + sceneH)) : (d.sceneY ?? 0);
        }
      } catch (e) {
        // Fallback: no clamping
      }

      const camX = mainCamera.position.x;
      const camY = mainCamera.position.y;

      let minX = camX - desiredW / 2;
      let maxX = camX + desiredW / 2;
      let minY = camY - desiredH / 2;
      let maxY = camY + desiredH / 2;

      if (sceneW > 0 && sceneH > 0) {
        const sMinX = sceneX;
        const sMaxX = sceneX + sceneW;
        const sMinY = sceneY;
        const sMaxY = sceneY + sceneH;

        minX = Math.max(sMinX, minX);
        maxX = Math.min(sMaxX, maxX);
        minY = Math.max(sMinY, minY);
        maxY = Math.min(sMaxY, maxY);
      }

      const emitW = Math.max(1, maxX - minX);
      const emitH = Math.max(1, maxY - minY);
      const emitCX = (minX + maxX) * 0.5;
      const emitCY = (minY + maxY) * 0.5;

      // Cache the camera-visible world rectangle for view-dependent foam.webp spawning.
      this._viewMinX = minX;
      this._viewMaxX = maxX;
      this._viewMinY = minY;
      this._viewMaxY = maxY;
      this._viewSceneX = sceneX;
      this._viewSceneY = sceneY;
      this._viewSceneW = sceneW;
      this._viewSceneH = sceneH;

      if (this.rainSystem?.emitter && this.rainSystem.emitterShape) {
        const shape = this.rainSystem.emitterShape;
        if (typeof shape.width === 'number') shape.width = emitW;
        if (typeof shape.height === 'number') shape.height = emitH;
        this.rainSystem.emitter.position.x = emitCX;
        this.rainSystem.emitter.position.y = emitCY;
      }

      if (this.snowSystem?.emitter && this.snowSystem.emitterShape) {
        const shape = this.snowSystem.emitterShape;
        if (typeof shape.width === 'number') shape.width = emitW;
        if (typeof shape.height === 'number') shape.height = emitH;
        this.snowSystem.emitter.position.x = emitCX;
        this.snowSystem.emitter.position.y = emitCY;
      }

      // Ash emitters cover the full scene (same as rain/snow) to avoid visible
      // hard-edged rectangles. Density variation comes from temporal clusterBoost
      // on the emission rate, not from shrinking/repositioning the emitter.
      if (this.ashSystem?.emitter && this.ashSystem.emitterShape) {
        const shape = this.ashSystem.emitterShape;
        if (typeof shape.width === 'number') shape.width = emitW;
        if (typeof shape.height === 'number') shape.height = emitH;
        this.ashSystem.emitter.position.x = emitCX;
        this.ashSystem.emitter.position.y = emitCY;
      }

      if (this.ashEmberSystem?.emitter && this.ashEmberSystem.emitterShape) {
        const shape = this.ashEmberSystem.emitterShape;
        if (typeof shape.width === 'number') shape.width = emitW;
        if (typeof shape.height === 'number') shape.height = emitH;
        this.ashEmberSystem.emitter.position.x = emitCX;
        this.ashEmberSystem.emitter.position.y = emitCY;
      }

      // Foam flecks: keep the rendered dot ~pixel-sized across zoom levels.
      // Billboards use world units for size; to approximate a 1–2px dot in screen space,
      // scale by 1/zoom (bigger world size when zoomed out, smaller when zoomed in).
      if (this._foamFleckSystem?.startSize && typeof this._foamFleckSystem.startSize.a === 'number') {
        const p = window.MapShine?.waterEffect?.params || {};
        const pxMin = Number.isFinite(p.foamFlecksSizePxMin) ? Math.max(0.05, p.foamFlecksSizePxMin) : 1.8;
        const pxMax = Number.isFinite(p.foamFlecksSizePxMax) ? Math.max(pxMin, p.foamFlecksSizePxMax) : 3.2;
        const worldMin = Number.isFinite(p.foamFlecksSizeWorldMin) ? Math.max(0.0, p.foamFlecksSizeWorldMin) : 0.95;
        const worldMax = Number.isFinite(p.foamFlecksSizeWorldMax) ? Math.max(0.0, p.foamFlecksSizeWorldMax) : 1.55;
        const invZoom = 1.0 / Math.max(1e-6, zoom);
        const sizeMin = Math.max(worldMin, pxMin * invZoom);
        const sizeMax = Math.max(worldMax, pxMax * invZoom);
        if (sizeMin !== this._foamFleckLastSizeMin || sizeMax !== this._foamFleckLastSizeMax) {
          this._foamFleckLastSizeMin = sizeMin;
          this._foamFleckLastSizeMax = sizeMax;
          this._foamFleckSystem.startSize.a = sizeMin;
          this._foamFleckSystem.startSize.b = sizeMax;
        }
      }
    }

    // Global scene darkness coupling (0 = fully lit, 1 = max darkness).
    // We use this as a scalar on particle brightness/opacity so that
    // weather is not self-illuminated in dark scenes, while still
    // remaining faintly visible at full darkness.
    let sceneDarkness = 0;
    try {
      const le = window.MapShine?.lightingEffect;
      if (le && typeof le.getEffectiveDarkness === 'function') {
        sceneDarkness = le.getEffectiveDarkness();
      } else if (typeof canvas !== 'undefined' && canvas?.scene?.environment?.darknessLevel !== undefined) {
        sceneDarkness = canvas.scene.environment.darknessLevel;
      }
    } catch (e) {
      // If canvas is not ready, keep previous/default darkness.
    }
    sceneDarkness = Math.max(0, Math.min(1, sceneDarkness));

    // Map 0..1 darkness to a brightness scale of ~1.0 -> 0.3. This keeps
    // particles readable but clearly dimmer in night scenes.
    const darknessBrightnessScale = THREE
      ? THREE.MathUtils.lerp(1.0, 0.3, sceneDarkness)
      : (1.0 - 0.7 * sceneDarkness);

    // Cache scene bounds for mask projection
    if (sceneBoundsVec4 && THREE) {
      if (!this._sceneBounds) this._sceneBounds = new THREE.Vector4();
      this._sceneBounds.copy(sceneBoundsVec4);
    }

    const waterEffect = window.MapShine?.waterEffect;
    const waterEnabled = !!(waterEffect && waterEffect.enabled);
    const waterParams = waterEffect?.params || {};
    const waterTex = (waterEffect && typeof waterEffect.getWaterMaskTexture === 'function')
      ? waterEffect.getWaterMaskTexture()
      : (waterEffect?.waterMask || null);
    const waterOccTex = window.MapShine?.distortionManager?.waterOccluderTarget?.texture ?? null;
    const waterDataTex = (waterEffect && typeof waterEffect.getWaterDataTexture === 'function')
      ? waterEffect.getWaterDataTexture()
      : null;

    // Tile manager provides per-tile _Water mask textures (already loaded for water occluders).
    const tileManager = window.MapShine?.tileManager || null;

    // Determine the effective V flip for CPU-side sampling of the _Water mask.
    // This must match how water-related textures are interpreted elsewhere (WaterEffectV2/Distortion/etc.)
    // so that any point clouds derived from _Water align with the rendered water.
    let waterFlipV = false;
    if (waterEnabled && waterTex && waterTex.image) {
      try {
        if (Number.isFinite(waterParams?.maskFlipY)) {
          waterFlipV = waterParams.maskFlipY > 0.5;
        } else {
          // Prefer MaskManager metadata when available; it represents the correct scene-UV sampling
          // orientation for the authored mask (and may account for pre-flipped ImageBitmap decode).
          const mm = window.MapShine?.maskManager;
          const rec = mm?.getRecord ? mm.getRecord('water.scene') : null;
          if (rec && typeof rec.uvFlipY === 'boolean') {
            waterFlipV = rec.uvFlipY;
          } else if (typeof waterTex?.flipY === 'boolean') {
            // THREE.Texture.flipY refers to how the texture is uploaded/sampled in WebGL.
            // Our mask UVs (uvMask) are authored in scene-UV space (Y-down), so when a texture
            // has flipY=false (common for masks we force to avoid extra flips), we must flip V
            // ourselves to sample it correctly.
            waterFlipV = waterTex.flipY === false;
          } else {
            waterFlipV = false;
          }
        }
        // Debug escape hatch: force invert if needed for a given scene.
        if (waterParams?.foamPlumeDebugFlipV === true) waterFlipV = !waterFlipV;
      } catch (_) {
        // Keep fallback consistent with the branch above.
        waterFlipV = waterTex?.flipY === false;
      }
    }

    // Provide WaterEffectV2 data + params to the foam fleck emitter/behavior.
    // This is used for spawn gating ("spawn only where foam is white") and for landed drift
    // (sample water flow field from WaterData BA channels).
    if (this._foamFleckEmitter) {
      this._foamFleckEmitter.setWaterDataTexture(waterDataTex);
      this._foamFleckEmitter.setFoamParams(waterEffect?.params || null, this._time);
    }
    if (this._foamFleckBehavior) {
      this._foamFleckBehavior.setWaterDataTexture(waterDataTex, this._sceneBounds);
    }

    // Provide WaterEffectV2 params + time to foam.webp spawn shapes (noise gating).
    if (this._waterFoamShape && typeof this._waterFoamShape.setFoamParams === 'function') {
      this._waterFoamShape.setFoamParams(waterParams, this._time);
    }
    if (this._shoreFoamShape && typeof this._shoreFoamShape.setFoamParams === 'function') {
      this._shoreFoamShape.setFoamParams(waterParams, this._time);
    }

    // Refresh per-tile _Water point caches. These add spawn locations for water tiles (boats, rivers, etc.).
    // Note: this is cached internally and only rescans when the mask/texture/stride changes.
    this._refreshTileFoamPoints(tileManager);

    if (this._waterHitShape) {
      if (waterEnabled && waterTex && waterTex.image) {
        // Avoid per-frame string allocations; track uuid + flip as separate fields.
        const uuid = waterTex.uuid;
        const flipV = waterFlipV === true;
        if (uuid !== this._waterHitMaskUuid || flipV !== this._waterHitMaskFlipV) {
          this._waterHitMaskUuid = uuid;
          this._waterHitMaskFlipV = flipV;
          this._waterHitPoints = this._generateWaterSplashPoints(
            waterTex,
            this._waterMaskThreshold,
            this._waterMaskStride,
            this._waterMaskMaxPoints,
            flipV
          );
          this._waterHitShape.setPoints(this._waterHitPoints);
        }
      } else if (this._waterHitMaskUuid !== null || this._waterHitMaskFlipV !== null) {
        this._waterHitMaskUuid = null;
        this._waterHitMaskFlipV = null;
        this._waterHitPoints = null;
        this._waterHitShape.clearPoints();
      }
    }

    // Simple foam spawner: drive foam.webp systems from a direct _Water mask scan.
    if (this._waterFoamShape) {
      const simpleFoamEnabled = !!waterParams?.simpleFoamEnabled;
      const active = waterEnabled && waterTex && waterTex.image && simpleFoamEnabled;

      if (this._simpleFoamLastEnabled !== active) {
        this._simpleFoamLastEnabled = active;
        log.info(`SimpleFoamSpawner: ${active ? 'enabled' : 'disabled'}`);
      }

      if (active) {
        const flipV = waterParams?.simpleFoamDebugFlipV ? !waterFlipV : waterFlipV;
        const threshold = waterParams.simpleFoamThreshold ?? 0.5;
        const stride = waterParams.simpleFoamStride ?? 4;
        const maxPoints = waterParams.simpleFoamMaxPoints ?? 20000;

        const uuid = waterTex.uuid;
        if (
          uuid !== this._simpleFoamMaskUuid
          || (flipV === true) !== this._simpleFoamMaskFlipV
          || threshold !== this._simpleFoamThreshold
          || stride !== this._simpleFoamStride
          || maxPoints !== this._simpleFoamMaxPoints
        ) {
          this._simpleFoamMaskUuid = uuid;
          this._simpleFoamMaskFlipV = flipV === true;
          this._simpleFoamThreshold = threshold;
          this._simpleFoamStride = stride;
          this._simpleFoamMaxPoints = maxPoints;

          log.info('SimpleFoamSpawner: rebuilding points', { threshold, stride, maxPoints, flipV });
          this._waterFoamPoints = this._generateWaterHardEdgePoints(
            waterTex,
            threshold,
            stride,
            maxPoints,
            flipV
          );
        }
        const pointCount = this._waterFoamPoints ? (this._waterFoamPoints.length / 2) : 0;
        if (pointCount !== this._simpleFoamLastPointCount) {
          this._simpleFoamLastPointCount = pointCount;
          log.info(`SimpleFoamSpawner: setting ${pointCount} points`);
        }
        this._waterFoamShape.setPoints(this._waterFoamPoints);
      } else if (this._waterFoamPoints) {
        this._waterFoamPoints = null;
        this._waterFoamPointsKey = null;
        this._simpleFoamLastPointCount = 0;
        this._simpleFoamMaskUuid = null;
        this._simpleFoamMaskFlipV = null;
        this._simpleFoamThreshold = null;
        this._simpleFoamStride = null;
        this._simpleFoamMaxPoints = null;
        this._waterFoamShape.clearPoints();
      }
    }

    // Foam plume spawning (waterEdge): use merged scene + tile hard-edge points, then view-filter.
    // This keeps foam.webp emission stable even when the authored water is made from multiple tiles.
    if (this._waterFoamShape) {
      const plumeActive = waterEnabled && waterTex && waterTex.image;

      if (plumeActive) {
        const stride = Math.max(1, this._waterMaskStride);
        const maxPoints = Math.max(1, Math.min(this._waterMaskMaxPoints, 24000) | 0);

        const uuid = waterTex.uuid;
        const flipV = waterFlipV === true;
        const tileRev = this._tileFoamRevision;
        if (
          uuid !== this._waterFoamPlumeUuid
          || flipV !== this._waterFoamPlumeFlipV
          || stride !== this._waterFoamPlumeStride
          || maxPoints !== this._waterFoamPlumeMaxPoints
          || tileRev !== this._waterFoamPlumeTileRev
        ) {
          this._waterFoamPlumeUuid = uuid;
          this._waterFoamPlumeFlipV = flipV;
          this._waterFoamPlumeStride = stride;
          this._waterFoamPlumeMaxPoints = maxPoints;
          this._waterFoamPlumeTileRev = tileRev;

          const sceneHard = this._generateWaterHardEdgePoints(
            waterTex,
            0.5,
            stride,
            maxPoints,
            flipV
          );

          // Merge the global scene hard-edge with per-tile hard edges.
          // IMPORTANT: if there are many tiles, the global merged tile buffer can starve
          // individual tiles. Build a view-local tile merge so visible tiles always contribute.
          const u0 = this._viewSceneX / this._viewSceneW;
          const u1 = (this._viewSceneX + this._viewSceneW) / this._viewSceneW;
          const v0 = 0.0;
          const v1 = 1.0;
          const tileSets = this._collectTilePointSetsInView('hard', u0, u1, v0, v1);
          const tileViewMerged = this._mergeManyUvPointSets(tileSets, 8000);
          this._waterFoamPlumeBasePoints = this._mergeUvPointSets(sceneHard, tileViewMerged, maxPoints, 512);
        }

        this._waterFoamPlumePoints = this._getViewFilteredUvPoints(this._waterFoamPlumeBasePoints);
      } else {
        this._waterFoamPlumePointsKey = null;
        this._waterFoamPlumePoints = null;
        this._waterFoamPlumeBasePoints = null;

        this._waterFoamPlumeUuid = null;
        this._waterFoamPlumeFlipV = null;
        this._waterFoamPlumeStride = null;
        this._waterFoamPlumeMaxPoints = null;
        this._waterFoamPlumeTileRev = null;
      }

      // Do not override the simpleFoam debug spawner when it is active.
      if (!(waterParams?.simpleFoamEnabled === true)) {
        this._waterFoamShape.setPoints(this._waterFoamPlumePoints);
      }
    }

    // Shoreline points with normals: used for foam plume 'shoreline' spawn mode and foam flecks edge emission.
    if (this._shoreFoamShape || this._foamFleckEmitter) {
      const active = waterEnabled && waterTex && waterTex.image;
      if (active) {
        const stride = Math.max(1, this._waterMaskStride);
        const maxPoints = 16000;
        const uuid = waterTex.uuid;
        const maskVersion = (typeof waterTex.version === 'number') ? waterTex.version : 0;
        const img = waterTex?.image;
        const maskW = img?.width ?? null;
        const maskH = img?.height ?? null;
        const flipV = waterFlipV === true;
        const tileRev = this._tileFoamRevision;

        // PERF: Replace string key with direct field comparisons to avoid per-frame string allocation.
        const needsRebuild = (
          uuid !== this._shoreFoamMaskUuid
          || maskVersion !== this._shoreFoamMaskVersion
          || maskW !== this._shoreFoamMaskW
          || maskH !== this._shoreFoamMaskH
          || stride !== this._shoreFoamStride
          || maxPoints !== this._shoreFoamMaxPoints
          || flipV !== this._shoreFoamFlipV
          || tileRev !== this._shoreFoamTileRev
        );

        if (needsRebuild) {
          this._shoreFoamPointsKey = null; // Clear legacy string key
          this._shoreFoamMaskUuid = uuid;
          this._shoreFoamMaskVersion = maskVersion;
          this._shoreFoamMaskW = maskW;
          this._shoreFoamMaskH = maskH;
          this._shoreFoamStride = stride;
          this._shoreFoamMaxPoints = maxPoints;
          this._shoreFoamFlipV = flipV;
          this._shoreFoamTileRev = tileRev;

          const sceneEdge = this._generateWaterEdgePoints(
            waterTex,
            this._waterMaskThreshold,
            stride,
            maxPoints,
            waterFlipV
          );
          const u0 = this._viewSceneX / this._viewSceneW;
          const u1 = (this._viewSceneX + this._viewSceneW) / this._viewSceneW;
          const v0 = 0.0;
          const v1 = 1.0;
          const tileSets = this._collectTilePointSetsInView('edge', u0, u1, v0, v1);
          const tileViewMerged = this._mergeManyEdgePointSets(tileSets, 8000);
          this._shoreFoamPoints = this._mergeEdgePointSets(sceneEdge, tileViewMerged, maxPoints, 512);
        }

        const viewShore = this._getViewFilteredEdgePoints(this._shoreFoamPoints);
        this._shoreFoamViewPoints = viewShore;
        if (this._shoreFoamShape) this._shoreFoamShape.setPoints(viewShore);
        if (this._foamFleckEmitter) this._foamFleckEmitter.setShorePoints(viewShore);
      } else {
        this._shoreFoamPointsKey = null;
        this._shoreFoamMaskUuid = null;
        this._shoreFoamMaskVersion = null;
        this._shoreFoamMaskW = null;
        this._shoreFoamMaskH = null;
        this._shoreFoamStride = null;
        this._shoreFoamMaxPoints = null;
        this._shoreFoamFlipV = null;
        this._shoreFoamTileRev = null;
        this._shoreFoamPoints = null;
        this._shoreFoamViewPoints = null;
        if (this._shoreFoamShape) this._shoreFoamShape.clearPoints();
        if (this._foamFleckEmitter) this._foamFleckEmitter.setShorePoints(null);
      }
    }


    // Interior water points (proxy for floating foam spawn locations)
    if (waterEnabled && waterTex && waterTex.image) {
      // Avoid per-frame string allocations; track uuid + flip as separate fields.
      const uuid = waterTex.uuid;
      const flipV = waterFlipV === true;
      // Larger stride to keep this cheap; we only need a coarse point cloud.
      const stride = Math.max(2, this._waterMaskStride * 3);
      const maxPoints = 8000;
      const u0 = this._viewSceneX / this._viewSceneW;
      const u1 = (this._viewSceneX + this._viewSceneW) / this._viewSceneW;
      const v0 = 0.0;
      const v1 = 1.0;

      if (
        uuid !== this._foamFleckInteriorMaskUuid
        || flipV !== this._foamFleckInteriorMaskFlipV
        || stride !== this._foamFleckInteriorStride
        || maxPoints !== this._foamFleckInteriorMaxPoints
      ) {
        this._foamFleckInteriorMaskUuid = uuid;
        this._foamFleckInteriorMaskFlipV = flipV;
        this._foamFleckInteriorStride = stride;
        this._foamFleckInteriorMaxPoints = maxPoints;

        const sceneInterior = this._generateWaterInteriorPoints(
          waterTex,
          this._waterMaskThreshold,
          stride,
          maxPoints,
          flipV
        );
        const tileSets = this._collectTilePointSetsInView('interior', u0, u1, v0, v1);
        const tileViewMerged = this._mergeManyUvPointSets(tileSets, 4000);
        this._foamFleckInteriorPoints = this._mergeUvPointSets(sceneInterior, tileViewMerged, maxPoints, 256);
      }

      if (this._foamFleckEmitter) this._foamFleckEmitter.setInteriorPoints(this._foamFleckInteriorPoints);
    } else if (this._foamFleckInteriorMaskUuid !== null || this._foamFleckInteriorMaskFlipV !== null) {
      this._foamFleckInteriorMaskUuid = null;
      this._foamFleckInteriorMaskFlipV = null;
      this._foamFleckInteriorStride = null;
      this._foamFleckInteriorMaxPoints = null;
      this._foamFleckInteriorPoints = null;
      if (this._foamFleckEmitter) this._foamFleckEmitter.setInteriorPoints(null);
    }

    // Update roof/outdoors texture and mask state from WeatherController
    let roofTex = weatherController.roofMap || null;
    if (!roofTex) {
      try {
        const mm = window.MapShine?.maskManager;
        const rec = mm?.getRecord ? mm.getRecord('outdoors.scene') : null;
        if (rec?.texture) {
          roofTex = rec.texture;
          if (weatherController?.setRoofMap) weatherController.setRoofMap(roofTex);
        }
      } catch (e) {
      }
    }
    this._roofTexture = roofTex;
    
    // DUAL-MASK SYSTEM:
    // - roofMaskEnabled: Always true if we have an _Outdoors mask (controls indoor/outdoor gating)
    // - roofAlphaMap: Screen-space texture from LightingEffect showing visible overhead tiles
    //
    // The shader logic is:
    // - Show rain if: (outdoors AND roof hidden) OR (roof visible - rain lands on roof)
    // - Hide rain if: indoors AND no visible roof overhead
    const roofMaskEnabled = !!roofTex;
    // Outdoors-only intent:
    // - If an _Outdoors mask exists, we can enforce it.
    // - If it does not exist, we treat everything as outdoors (same behavior as
    //   WeatherController.getRoofMaskIntensity fallback), otherwise the effect
    //   would never run on maps without an _Outdoors asset.
    const outdoorsMaskAvailable = !weatherController?.roofMaskData || !!roofTex;
    
    // Get the roof alpha texture from LightingEffect (screen-space overhead tile visibility)
    let roofAlphaTexture = null;
    let screenWidth = 1920;
    let screenHeight = 1080;
    try {
      const mm = window.MapShine?.maskManager;
      const rec = mm ? mm.getRecord('weatherRoofAlpha.screen') : null;
      if (rec && rec.texture) {
        roofAlphaTexture = rec.texture;
        screenWidth = rec.width || 1920;
        screenHeight = rec.height || 1080;
      } else {
        const le = window.MapShine?.lightingEffect;
        if (le && le.weatherRoofAlphaTarget && le.weatherRoofAlphaTarget.texture) {
          roofAlphaTexture = le.weatherRoofAlphaTarget.texture;
          // Get screen size from the render target dimensions
          screenWidth = le.weatherRoofAlphaTarget.width || 1920;
          screenHeight = le.weatherRoofAlphaTarget.height || 1080;
        }
      }
    } catch (e) {
      // LightingEffect not available
    }
    const hasRoofAlphaMap = !!roofAlphaTexture;

    // DIAGNOSTIC: allow disabling the precipitation roof/outdoors masking at runtime.
    // Toggle via console: window.MapShine.disableWeatherRoofMask = true/false
    // This helps A/B test whether the mask sampling/discard path is a major GPU cost.
    const debugDisableWeatherRoofMask = window.MapShine?.disableWeatherRoofMask === true;
    const effectiveRoofMaskEnabled = roofMaskEnabled && !debugDisableWeatherRoofMask;
    const effectiveHasRoofAlphaMap = hasRoofAlphaMap && !debugDisableWeatherRoofMask;

    const precip = weather.precipitation || 0;

    // If precipitation abruptly goes to 0, force-clear any existing splashes.
    // Otherwise, paused splash systems can leave particles frozen on the ground.
    const prevPrecip = (this._lastPrecipitation ?? precip);
    if (prevPrecip > 1e-6 && precip <= 1e-6) {
      this._clearAllRainSplashes();
    }
    this._lastPrecipitation = precip;
    const freeze = weather.freezeLevel || 0;
    const rainTuning = weatherController.rainTuning || {};
    const snowTuning = weatherController.snowTuning || {};
    const baseRainIntensity = precip * (1.0 - freeze) * (rainTuning.intensityScale ?? 1.0);
    const snowIntensity = precip * freeze * (snowTuning.intensityScale ?? 1.0);

    this._ensureBatchMaterialPatched(this.rainSystem, '_rainBatchMaterial');
    this._ensureBatchMaterialPatched(this.snowSystem, '_snowBatchMaterial');
    this._ensureBatchMaterialPatched(this._foamSystem, '_foamBatchMaterial');

    if (this.rainSystem) {
        // Minimal per-frame work: just drive emission by precipitation/intensity.
        // PERFORMANCE: Mutate existing ConstantValue instead of creating new one every frame
        const rainIntensity = baseRainIntensity;
        const emission = this.rainSystem.emissionOverTime;
        if (emission && typeof emission.value === 'number') {
            emission.value = 4000 * rainIntensity;
        }

        // --- EFFICIENT TUNING UPDATES ---
        // Only update system properties if the specific tuning value has changed.

        // 1. Drop Size -> startSize (configurable min/max, with sane fallbacks)
        const currentDropSize = rainTuning.dropSize ?? 1.0;
        const currentDropSizeMin = rainTuning.dropSizeMin ?? (1.2 * currentDropSize);
        const currentDropSizeMax = rainTuning.dropSizeMax ?? (2.2 * currentDropSize);

        if (currentDropSize !== this._lastRainTuning.dropSize ||
            currentDropSizeMin !== this._lastRainTuning.dropSizeMin ||
            currentDropSizeMax !== this._lastRainTuning.dropSizeMax) {

          this._lastRainTuning.dropSize = currentDropSize;
          this._lastRainTuning.dropSizeMin = currentDropSizeMin;
          this._lastRainTuning.dropSizeMax = currentDropSizeMax;

          // PERFORMANCE: Mutate existing IntervalValue instead of creating new one
          if (this.rainSystem.startSize && typeof this.rainSystem.startSize.a === 'number') {
            this.rainSystem.startSize.a = currentDropSizeMin;
            this.rainSystem.startSize.b = currentDropSizeMax;
          }
        }

        // 2. Streak Length -> speedFactor
        const currentStreakLen = rainTuning.streakLength ?? 1.0;
        if (currentStreakLen !== this._lastRainTuning.streakLength) {
          this._lastRainTuning.streakLength = currentStreakLen;
          // Keep this in sync with the baseline speedFactor set in _initSystems.
          // Smaller values (e.g. 0.25) now produce noticeably shorter streaks.
          this.rainSystem.speedFactor = 0.02 * currentStreakLen;
        }

        // 3. Brightness -> material opacity & startColor alpha
        const currentBrightness = (rainTuning.brightness ?? 1.0) * darknessBrightnessScale;
        if (currentBrightness !== this._lastRainTuning.brightness &&
            (this._rainMaterial || this.rainSystem.material)) {

          this._lastRainTuning.brightness = currentBrightness;

          const clampedB = THREE.MathUtils.clamp(currentBrightness, 0.0, 3.0);
          const alphaScale = clampedB / 3.0; // 0 -> invisible, 1 -> full

          // Material opacity
          const targetOpacity = THREE.MathUtils.clamp(alphaScale * 1.2, 0.0, 1.0);
          if (this._rainMaterial) {
            this._rainMaterial.opacity = targetOpacity;
          }
          if (this.rainSystem.material) {
            this.rainSystem.material.opacity = targetOpacity;
          }

          // Particle alpha
          // PERFORMANCE: Mutate existing ColorRange Vector4s instead of creating new ones
          const baseMinAlpha = 1.0;
          const baseMaxAlpha = 0.7;
          const minA = baseMinAlpha * alphaScale;
          const maxA = baseMaxAlpha * alphaScale;
          if (this.rainSystem.startColor && this.rainSystem.startColor.a && this.rainSystem.startColor.b) {
            this.rainSystem.startColor.a.set(0.6, 0.7, 1.0, minA);
            this.rainSystem.startColor.b.set(0.6, 0.7, 1.0, maxA);
          }
        }
        // Apply roof mask uniforms for rain (base material)
        if (this._rainMaterial && this._rainMaterial.userData && this._rainMaterial.userData.roofUniforms) {
          const uniforms = this._rainMaterial.userData.roofUniforms;
          uniforms.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
          uniforms.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
          if (this._sceneBounds) {
            uniforms.uSceneBounds.value.copy(this._sceneBounds);
          }
          uniforms.uRoofMap.value = this._roofTexture;
          uniforms.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
          uniforms.uScreenSize.value.set(screenWidth, screenHeight);
        }

        // Also drive the batch ShaderMaterial uniforms used by quarks for rain.
        if (this._rainBatchMaterial && this._rainBatchMaterial.userData && this._rainBatchMaterial.userData.roofUniforms) {
          const uniforms = this._rainBatchMaterial.userData.roofUniforms;
          uniforms.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
          uniforms.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
          if (this._sceneBounds) {
            uniforms.uSceneBounds.value.copy(this._sceneBounds);
          }
          uniforms.uRoofMap.value = this._roofTexture;
          uniforms.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
          uniforms.uScreenSize.value.set(screenWidth, screenHeight);
        }
    }
    
    if (this.splashSystems && this.splashSystems.length > 0) {
        // Splashes only happen during rain.
        // Logic: Precipitation > 0 AND FreezeLevel < 0.5 (Rain)

        const baseIntensity = baseRainIntensity;

        // Drive splash emission with a different curve than raindrops.
        // From 0-25% precipitation: no splashes.
        // From 25%-100%: ramp splash factor from 0 -> 1.
        let splashPrecipFactor = 0.0;
        if (precip > 0.25) {
          const t = (precip - 0.25) / 0.75;
          splashPrecipFactor = THREE ? THREE.MathUtils.clamp(t, 0.0, 1.0) : Math.max(0, Math.min(1, t));
        }

        for (let i = 0; i < 4; i++) {
          const system = this.splashSystems[i];
          if (!system) continue;

          const keys = SPLASH_TUNING_KEYS[i];
          const alphaBehavior = this._splashAlphaBehaviors?.[i];
          const intensityScale = rainTuning[keys.intensity];
          const lifeMinT = rainTuning[keys.lifeMin];
          const lifeMaxT = rainTuning[keys.lifeMax];
          const sizeMinT = rainTuning[keys.sizeMin];
          const sizeMaxT = rainTuning[keys.sizeMax];
          const peakT = rainTuning[keys.peak];

          // Base emission scaled by rain intensity, precipitation curve, and per-splash intensity.
          const splashIntensityScale = intensityScale ?? 0.0;
          let splashEmission = 0;
          if (!debugDisableWeatherSplashes && baseIntensity > 0 && splashIntensityScale > 0 && splashPrecipFactor > 0) {
            // 200 splashes/sec at full intensity, further scaled per splash and precipitation factor.
            splashEmission = 200 * baseIntensity * splashIntensityScale * splashPrecipFactor * splashEmissionScale;
          }

          // PERFORMANCE: Mutate existing values instead of creating new objects every frame
          const emissionVal = system.emissionOverTime;
          if (emissionVal && typeof emissionVal.value === 'number') {
            emissionVal.value = splashEmission;
          }

          // A/B perf testing: allow turning off splash rendering entirely.
          try {
            if (system.emitter) system.emitter.visible = !debugDisableWeatherSplashes;
          } catch (_) {
          }

          // Reduce Quarks overhead by pausing splash systems when not emitting.
          // (Quarks has non-trivial per-system update even at 0 spawn rate.)
          try {
            const shouldRun = !debugDisableWeatherSplashes && splashEmission > 0.0001;
            const ud = system.emitter?.userData || null;
            const prev = ud ? ud._msSplashActive : undefined;
            if (ud) ud._msSplashActive = shouldRun;
            if (prev !== shouldRun) {
              if (shouldRun) system.play?.(); else system.pause?.();
            }
          } catch (_) {
          }

          // --- Lifetime Tuning for this splash ---
          const lifeMin = Math.max(0.001, lifeMinT ?? 0.1);
          const lifeMax = Math.max(lifeMin, lifeMaxT ?? 0.2);
          if (system.startLife && typeof system.startLife.a === 'number') {
            system.startLife.a = lifeMin;
            system.startLife.b = lifeMax;
          }

          // --- Size Tuning for this splash ---
          const sizeMin = sizeMinT ?? 12.0;
          const sizeMax = Math.max(sizeMin, sizeMaxT ?? 24.0);
          if (system.startSize && typeof system.startSize.a === 'number') {
            system.startSize.a = sizeMin;
            system.startSize.b = sizeMax;
          }

          // --- Opacity Peak Tuning for this splash ---
          const peak = (peakT ?? 0.10) * darknessBrightnessScale;
          if (alphaBehavior) {
            alphaBehavior.peakOpacity = peak;
          }
        }

        // --- Mask Uniforms ---
        // PERF: Dirty-check to avoid per-frame uniform updates when nothing changed.
        const roofTexUuid = this._roofTexture?.uuid ?? null;
        const roofAlphaUuid = roofAlphaTexture?.uuid ?? null;
        const sbX = this._sceneBounds?.x ?? null;
        const sbY = this._sceneBounds?.y ?? null;
        const sbW = this._sceneBounds?.z ?? null;
        const sbH = this._sceneBounds?.w ?? null;

        const splashRoofUniformsDirty = (
          effectiveRoofMaskEnabled !== this._lastSplashRoofMaskEnabled
          || effectiveHasRoofAlphaMap !== this._lastSplashHasRoofAlphaMap
          || roofTexUuid !== this._lastSplashRoofTexUuid
          || roofAlphaUuid !== this._lastSplashRoofAlphaUuid
          || screenWidth !== this._lastSplashScreenW
          || screenHeight !== this._lastSplashScreenH
          || sbX !== this._lastSplashSceneBoundsX
          || sbY !== this._lastSplashSceneBoundsY
          || sbW !== this._lastSplashSceneBoundsW
          || sbH !== this._lastSplashSceneBoundsH
        );

        if (splashRoofUniformsDirty) {
          this._lastSplashRoofMaskEnabled = effectiveRoofMaskEnabled;
          this._lastSplashHasRoofAlphaMap = effectiveHasRoofAlphaMap;
          this._lastSplashRoofTexUuid = roofTexUuid;
          this._lastSplashRoofAlphaUuid = roofAlphaUuid;
          this._lastSplashScreenW = screenWidth;
          this._lastSplashScreenH = screenHeight;
          this._lastSplashSceneBoundsX = sbX;
          this._lastSplashSceneBoundsY = sbY;
          this._lastSplashSceneBoundsW = sbW;
          this._lastSplashSceneBoundsH = sbH;

          if (this._splashMaterial && this._splashMaterial.userData.roofUniforms) {
             const u = this._splashMaterial.userData.roofUniforms;
             u.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
             u.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
             if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
             u.uRoofMap.value = this._roofTexture;
             u.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
             u.uScreenSize.value.set(screenWidth, screenHeight);
          }

          if (this._splashBatchMaterials && this._splashBatchMaterials.length > 0) {
            for (const mat of this._splashBatchMaterials) {
              if (!mat || !mat.userData || !mat.userData.roofUniforms) continue;
              const u = mat.userData.roofUniforms;
              u.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
              u.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
              if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
              u.uRoofMap.value = this._roofTexture;
              u.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
              u.uScreenSize.value.set(screenWidth, screenHeight);
            }
          }
        }
    }

    if (this._waterHitSplashSystems && this._waterHitSplashSystems.length > 0) {
      const baseIntensity = baseRainIntensity;

      let splashPrecipFactor = 0.0;
      if (precip > 0.25) {
        const t = (precip - 0.25) / 0.75;
        splashPrecipFactor = THREE ? THREE.MathUtils.clamp(t, 0.0, 1.0) : Math.max(0, Math.min(1, t));
      }

      for (let i = 0; i < this._waterHitSplashSystems.length; i++) {
        const entry = this._waterHitSplashSystems[i];
        const sys = entry?.system;
        if (!sys) continue;

        let emission = 0;
        if (!debugDisableWeatherSplashes && waterEnabled && this._waterHitPoints && baseIntensity > 0 && splashPrecipFactor > 0) {
          emission = 80 * baseIntensity * splashPrecipFactor * splashEmissionScale;
        }

        if (sys.emissionOverTime && typeof sys.emissionOverTime.value === 'number') {
          sys.emissionOverTime.value = emission;
        }

        if (entry.alphaBehavior) {
          entry.alphaBehavior.peakOpacity = 0.27 * darknessBrightnessScale;
        }

        // Allow turning off splash rendering entirely for A/B perf testing.
        try {
          if (sys.emitter) sys.emitter.visible = !debugDisableWeatherSplashes;
        } catch (_) {
        }

        // Pause when not emitting to avoid per-system overhead.
        try {
          const shouldRun = !debugDisableWeatherSplashes && emission > 0.0001;
          const ud = sys.emitter?.userData || null;
          const prev = ud ? ud._msSplashActive : undefined;
          if (ud) ud._msSplashActive = shouldRun;
          if (prev !== shouldRun) {
            if (shouldRun) sys.play?.(); else sys.pause?.();
          }
        } catch (_) {
        }
      }
    }

    if (this._foamSystem && !debugDisableWeatherFoam) {
      // Ensure re-enable restores visibility.
      try {
        if (this._foamSystem.emitter) this._foamSystem.emitter.visible = true;
      } catch (_) {
      }
      const foamEnabled = (waterParams?.shoreFoamEnabled ?? true) === true;
      const foamIntensity = Number.isFinite(waterParams?.shoreFoamIntensity) ? waterParams.shoreFoamIntensity : 1.0;
      const windSpeed = weather.windSpeed || 0;

      const plumeEnabled = foamEnabled && (waterParams?.foamPlumeEnabled ?? true) === true;
      const maxParticles = Number.isFinite(waterParams?.foamPlumeMaxParticles)
        ? Math.max(0, Math.floor(waterParams.foamPlumeMaxParticles))
        : 2500;
      if (this._foamLastMaxParticles !== maxParticles) {
        this._foamLastMaxParticles = maxParticles;
        this._foamSystem.maxParticles = maxParticles;
      }

      // Swap spawn shape based on mode.
      const plumeMode = waterParams?.foamPlumeSpawnMode || 'waterEdge';
      const plumeShape = (plumeMode === 'shoreline') ? this._shoreFoamShape : this._waterFoamShape;
      try {
        if (plumeShape && this._foamSystem.emitterShape !== plumeShape) {
          this._foamSystem.emitterShape = plumeShape;
        }
      } catch (_) {
      }

      const plumePointSet = (plumeMode === 'shoreline')
        ? this._shoreFoamViewPoints
        : ((waterParams?.simpleFoamEnabled === true) ? this._waterFoamPoints : this._waterFoamPlumePoints);
      const hasPlumePoints = !!(plumePointSet && plumePointSet.length);
      let foamEmission = 0;
      if (plumeEnabled && waterEnabled && hasPlumePoints) {
        const base = Number.isFinite(waterParams?.foamPlumeEmissionBase) ? Math.max(0.0, waterParams.foamPlumeEmissionBase) : 8.0;
        const windScale = Number.isFinite(waterParams?.foamPlumeEmissionWindScale) ? Math.max(0.0, waterParams.foamPlumeEmissionWindScale) : 45.0;
        foamEmission = (base + windScale * windSpeed) * Math.max(0.0, foamIntensity);
      }

      if (this._foamSystem.emissionOverTime && typeof this._foamSystem.emissionOverTime.value === 'number') {
        this._foamSystem.emissionOverTime.value = foamEmission;
      }

      if (this._foamSystem.startLife && typeof this._foamSystem.startLife.a === 'number') {
        const lifeMin = Number.isFinite(waterParams?.foamPlumeLifeMin) ? Math.max(0.01, waterParams.foamPlumeLifeMin) : 0.6;
        const lifeMax = Number.isFinite(waterParams?.foamPlumeLifeMax) ? Math.max(lifeMin, waterParams.foamPlumeLifeMax) : 1.4;
        this._foamSystem.startLife.a = lifeMin;
        this._foamSystem.startLife.b = lifeMax;
      }

      if (this._foamSystem.startSize && typeof this._foamSystem.startSize.a === 'number') {
        const sizeMin = Number.isFinite(waterParams?.foamPlumeSizeMin) ? Math.max(0.01, waterParams.foamPlumeSizeMin) : 40.0;
        const sizeMax = Number.isFinite(waterParams?.foamPlumeSizeMax) ? Math.max(sizeMin, waterParams.foamPlumeSizeMax) : 90.0;
        this._foamSystem.startSize.a = sizeMin;
        this._foamSystem.startSize.b = sizeMax;
      }

      // Material tuning
      const plumeOpacity = Number.isFinite(waterParams?.foamPlumeOpacity) ? Math.max(0.0, waterParams.foamPlumeOpacity) : 1.0;
      const plumeColor = waterParams?.foamPlumeColor;
      if (this._foamMaterial) {
        const nextOpacity = plumeOpacity * darknessBrightnessScale;
        if (nextOpacity !== this._lastFoamOpacity) {
          this._lastFoamOpacity = nextOpacity;
          this._foamMaterial.opacity = nextOpacity;
        }
        if (plumeColor && typeof plumeColor.r === 'number') {
          const key = `${plumeColor.r}|${plumeColor.g}|${plumeColor.b}`;
          if (key !== this._lastFoamColorKey) {
            this._lastFoamColorKey = key;
            this._foamMaterial.color.setRGB(plumeColor.r, plumeColor.g, plumeColor.b);
          }
        }

        const nextBlend = (waterParams?.foamPlumeUseAdditive === true) ? THREE.AdditiveBlending : THREE.NormalBlending;
        if (nextBlend !== this._lastFoamBlendMode) {
          this._lastFoamBlendMode = nextBlend;
          this._foamMaterial.blending = nextBlend;
          this._foamMaterial.needsUpdate = true;
        }

        // Shader-side alpha shaping controls (foam.webp only)
        const u = this._foamMaterial.userData?.roofUniforms || null;
        if (u) {
          const additiveBoost = Number.isFinite(waterParams?.foamPlumeAdditiveBoost)
            ? Math.max(0.0, waterParams.foamPlumeAdditiveBoost)
            : 1.0;
          const boost = (waterParams?.foamPlumeUseAdditive === true) ? additiveBoost : 1.0;
          if (boost !== this._lastFoamAdditiveBoost) {
            this._lastFoamAdditiveBoost = boost;
            u.uFoamAdditiveBoost.value = boost;
          }

          const radialEnabled = (waterParams?.foamPlumeRadialAlphaEnabled === true) ? 1.0 : 0.0;
          u.uFoamRadialEnabled.value = radialEnabled;
          u.uFoamRadialInnerPos.value = Number.isFinite(waterParams?.foamPlumeRadialInnerPos) ? waterParams.foamPlumeRadialInnerPos : 0.0;
          u.uFoamRadialMidPos.value = Number.isFinite(waterParams?.foamPlumeRadialMidPos) ? waterParams.foamPlumeRadialMidPos : 0.5;
          u.uFoamRadialInnerOpacity.value = Number.isFinite(waterParams?.foamPlumeRadialInnerOpacity) ? waterParams.foamPlumeRadialInnerOpacity : 1.0;
          u.uFoamRadialMidOpacity.value = Number.isFinite(waterParams?.foamPlumeRadialMidOpacity) ? waterParams.foamPlumeRadialMidOpacity : 1.0;
          u.uFoamRadialOuterOpacity.value = Number.isFinite(waterParams?.foamPlumeRadialOuterOpacity) ? waterParams.foamPlumeRadialOuterOpacity : 1.0;
          u.uFoamRadialCurve.value = Number.isFinite(waterParams?.foamPlumeRadialCurve) ? Math.max(0.1, waterParams.foamPlumeRadialCurve) : 1.0;
        }
      }
      if (this._foamBatchMaterial) {
        const nextBlend = (waterParams?.foamPlumeUseAdditive === true) ? THREE.AdditiveBlending : THREE.NormalBlending;
        if (nextBlend !== this._lastFoamBatchBlendMode) {
          this._lastFoamBatchBlendMode = nextBlend;
          this._foamBatchMaterial.blending = nextBlend;
          this._foamBatchMaterial.needsUpdate = true;
        }

        const u = this._foamBatchMaterial.userData?.roofUniforms || null;
        if (u) {
          const additiveBoost = Number.isFinite(waterParams?.foamPlumeAdditiveBoost)
            ? Math.max(0.0, waterParams.foamPlumeAdditiveBoost)
            : 1.0;
          const boost = (waterParams?.foamPlumeUseAdditive === true) ? additiveBoost : 1.0;
          if (boost !== this._lastFoamBatchAdditiveBoost) {
            this._lastFoamBatchAdditiveBoost = boost;
            u.uFoamAdditiveBoost.value = boost;
          }

          u.uFoamRadialEnabled.value = (waterParams?.foamPlumeRadialAlphaEnabled === true) ? 1.0 : 0.0;
          u.uFoamRadialInnerPos.value = Number.isFinite(waterParams?.foamPlumeRadialInnerPos) ? waterParams.foamPlumeRadialInnerPos : 0.0;
          u.uFoamRadialMidPos.value = Number.isFinite(waterParams?.foamPlumeRadialMidPos) ? waterParams.foamPlumeRadialMidPos : 0.5;
          u.uFoamRadialInnerOpacity.value = Number.isFinite(waterParams?.foamPlumeRadialInnerOpacity) ? waterParams.foamPlumeRadialInnerOpacity : 1.0;
          u.uFoamRadialMidOpacity.value = Number.isFinite(waterParams?.foamPlumeRadialMidOpacity) ? waterParams.foamPlumeRadialMidOpacity : 1.0;
          u.uFoamRadialOuterOpacity.value = Number.isFinite(waterParams?.foamPlumeRadialOuterOpacity) ? waterParams.foamPlumeRadialOuterOpacity : 1.0;
          u.uFoamRadialCurve.value = Number.isFinite(waterParams?.foamPlumeRadialCurve) ? Math.max(0.1, waterParams.foamPlumeRadialCurve) : 1.0;
        }
      }

      if (this._foamPlumeBehavior) {
        const peak = Number.isFinite(waterParams?.foamPlumePeakOpacity) ? Math.max(0.0, waterParams.foamPlumePeakOpacity) : 0.65;
        this._foamPlumeBehavior.peakOpacity = peak * darknessBrightnessScale;
        this._foamPlumeBehavior.peakTime = Number.isFinite(waterParams?.foamPlumePeakTime) ? Math.max(0.01, Math.min(0.6, waterParams.foamPlumePeakTime)) : 0.18;
        this._foamPlumeBehavior.startScale = Number.isFinite(waterParams?.foamPlumeStartScale) ? Math.max(0.01, waterParams.foamPlumeStartScale) : 0.5;
        this._foamPlumeBehavior.maxScale = Number.isFinite(waterParams?.foamPlumeMaxScale) ? Math.max(0.01, waterParams.foamPlumeMaxScale) : 2.2;
        this._foamPlumeBehavior.spinMin = Number.isFinite(waterParams?.foamPlumeSpinMin) ? waterParams.foamPlumeSpinMin : -0.18;
        this._foamPlumeBehavior.spinMax = Number.isFinite(waterParams?.foamPlumeSpinMax) ? waterParams.foamPlumeSpinMax : 0.18;

        // Wind drift for foam.webp plume particles.
        this._foamPlumeBehavior.setWind(weather.windDirection, windSpeed01);
        const driftScale = Number.isFinite(waterParams?.foamPlumeWindDriftScale)
          ? Math.max(0.0, waterParams.foamPlumeWindDriftScale)
          : 0.0;
        if (this._foamPlumeBehavior.windDriftScale !== driftScale) this._foamPlumeBehavior.windDriftScale = driftScale;

        // Spawn-time random opacity multiplier bounds.
        this._foamPlumeBehavior.randomOpacityMin = Number.isFinite(waterParams?.foamPlumeRandomOpacityMin)
          ? Math.max(0.0, waterParams.foamPlumeRandomOpacityMin)
          : 1.0;
        this._foamPlumeBehavior.randomOpacityMax = Number.isFinite(waterParams?.foamPlumeRandomOpacityMax)
          ? Math.max(0.0, waterParams.foamPlumeRandomOpacityMax)
          : 1.0;
      }
    } else if (this._foamSystem) {
      // A/B perf testing: allow disabling foam systems without changing scene settings.
      try {
        if (this._foamSystem.emissionOverTime && typeof this._foamSystem.emissionOverTime.value === 'number') {
          this._foamSystem.emissionOverTime.value = 0;
        }
        if (this._foamSystem.emitter) this._foamSystem.emitter.visible = false;
      } catch (_) {
      }
    }


    // Foam flecks: only when we have an outdoors mask (outdoors-only rule) and water+foam are active.
    if (this._foamFleckSystem && !debugDisableWeatherFoam) {
      // Ensure re-enable restores visibility.
      try {
        if (this._foamFleckSystem.emitter) this._foamFleckSystem.emitter.visible = true;
      } catch (_) {
      }
      const flecksEnabled = (waterEffect?.params?.foamFlecksEnabled ?? true) === true;
      const flecksIntensity = waterEffect?.params?.foamFlecksIntensity ?? 1.0;
      const maxParticles = waterEffect?.params?.foamFlecksMaxParticles;
      const floatingStrength = waterEffect?.params?.floatingFoamStrength ?? 0.0;

      const p = waterEffect?.params || {};
      const debugForceOn = p.foamFlecksDebugForceOn === true;
      const debugDisableKill = p.foamFlecksDebugDisableKill === true;
      const debugIgnoreOutdoors = p.foamFlecksDebugIgnoreOutdoors === true;

      // Allow tuning maxParticles from the Water UI.
      const mp = Number.isFinite(maxParticles) ? Math.max(0, Math.floor(maxParticles)) : 1200;
      if (this._foamFleckLastMaxParticles !== mp) {
        this._foamFleckLastMaxParticles = mp;
        this._foamFleckSystem.maxParticles = mp;
      }

      // Refresh batch material reference (Quarks may rebuild batches/materials).
      // We rely on this to enforce the dot texture binding.
      try {
        const idx = this.batchRenderer?.systemToBatchIndex?.get(this._foamFleckSystem);
        const batch = (idx !== undefined) ? this.batchRenderer?.batches?.[idx] : null;
        if (batch?.material && this._foamFleckBatchMaterial !== batch.material) {
          this._foamFleckBatchMaterial = batch.material;
        }
      } catch (_) {
      }

      // Decide spawn mix: if floating foam is enabled in the water shader, bias towards interior.
      if (this._foamFleckEmitter) {
        const mix = Math.max(0.0, Math.min(1.0, floatingStrength));
        const overrideRatio = Number.isFinite(p.foamFlecksInteriorRatio) ? p.foamFlecksInteriorRatio : -1.0;
        if (overrideRatio >= 0.0) {
          this._foamFleckEmitter.interiorRatio = Math.max(0.0, Math.min(1.0, overrideRatio));
        } else {
          this._foamFleckEmitter.interiorRatio = 0.15 + 0.70 * mix;
        }
        this._foamFleckEmitter.setWind(weather.windDirection, windSpeed01, this._foamFleckWindAccel01);
      }
      if (this._foamFleckBehavior) {
        this._foamFleckBehavior.setWind(weather.windDirection, windSpeed01);
        const driftScale = Number.isFinite(p.foamFlecksWindDriftScale) ? Math.max(0.0, p.foamFlecksWindDriftScale) : 1.0;
        if (this._foamFleckBehavior.windDriftScale !== driftScale) this._foamFleckBehavior.windDriftScale = driftScale;
        // Live-tune physics from Water UI.
        const g = Number.isFinite(p.foamFlecksGravity) ? Math.max(0.0, p.foamFlecksGravity) : 950;
        const ld = Number.isFinite(p.foamFlecksLandedDuration) ? Math.max(0.0, p.foamFlecksLandedDuration) : 1.6;
        if (this._foamFleckBehavior.gravity !== g) this._foamFleckBehavior.gravity = g;
        if (this._foamFleckBehavior.landedDuration !== ld) this._foamFleckBehavior.landedDuration = ld;
      }

      // Debug: allow disabling kill volume to prove/disprove kill-culling.
      if (this._foamFleckKillBehavior) {
        this._foamFleckKillBehavior.enabled = !debugDisableKill;
      }

      // CRITICAL: Foam flecks use local-space particle positions (relative to emitter).
      // The kill behavior converts local->world using emitter.matrixWorld, but our render
      // pipeline doesn't guarantee the scene graph updates matrices before Quarks updates.
      // Force the emitter matrix to be correct so world-space kill bounds work.
      try {
        this._foamFleckSystem.emitter.updateMatrixWorld(true);
      } catch (_) {
      }

      // Live-tune lifetime (mutate existing IntervalValue).
      if (this._foamFleckSystem.startLife && typeof this._foamFleckSystem.startLife.a === 'number') {
        const lifeMin = Number.isFinite(p.foamFlecksLifeMin) ? Math.max(0.01, p.foamFlecksLifeMin) : 0.6;
        const lifeMax = Number.isFinite(p.foamFlecksLifeMax) ? Math.max(lifeMin, p.foamFlecksLifeMax) : 1.2;
        this._foamFleckSystem.startLife.a = lifeMin;
        this._foamFleckSystem.startLife.b = lifeMax;
      }

      const accel01 = this._foamFleckWindAccel01 || 0.0;
      const gust01 = Number.isFinite(weatherController?.currentGustStrength)
        ? Math.max(0.0, Math.min(1.0, weatherController.currentGustStrength))
        : 0.0;
      // Combined "wind is increasing" signal: use accel spikes AND gust envelope.
      // This keeps flecks visible during an active gust even if accel01 is momentarily small.
      const gustLiftScale = Number.isFinite(p.foamFlecksGustLiftScale) ? Math.max(0.0, p.foamFlecksGustLiftScale) : 0.25;
      const lift01 = Math.max(accel01, gust01 * gustLiftScale);
      const hasSources = !!(
        (this._shoreFoamPoints && this._shoreFoamPoints.length >= 4) ||
        (this._foamFleckInteriorPoints && this._foamFleckInteriorPoints.length >= 2)
      );

      let emission = 0;
      // Note: this intentionally triggers only when wind is increasing.
      // We keep a very small threshold so it is visible during normal preset transitions.
      const base = Number.isFinite(p.foamFlecksEmissionBase) ? Math.max(0.0, p.foamFlecksEmissionBase) : 60;
      const liftScale = Number.isFinite(p.foamFlecksEmissionLiftScale) ? Math.max(0.0, p.foamFlecksEmissionLiftScale) : 2400;
      const liftMin = Number.isFinite(p.foamFlecksEmissionLiftMin) ? Math.max(0.0, p.foamFlecksEmissionLiftMin) : 0.01;

      if ((debugForceOn || flecksEnabled) && (debugForceOn || ((debugIgnoreOutdoors || outdoorsMaskAvailable) && waterEnabled && hasSources && lift01 > liftMin))) {
        const i = Math.max(0.0, Math.min(6.0, flecksIntensity));
        // Quarks spawns roughly: emissionPerSecond * dt. With dt ~0.02, small values are effectively invisible.
        // Use a higher baseline and a linear accel term so normal gust attacks produce visible flecks.
        const accelTerm = liftScale * (debugForceOn ? 1.0 : lift01);
        const windTerm = 0.35 + 1.65 * windSpeed01;
        const intensityTerm = 0.25 + 0.75 * (i / 6.0);
        emission = (base + accelTerm) * windTerm * intensityTerm;
      }

      if (this._foamFleckSystem.emissionOverTime && typeof this._foamFleckSystem.emissionOverTime.value === 'number') {
        this._foamFleckSystem.emissionOverTime.value = emission;
      }

      // Ensure the SpriteBatch material for flecks actually uses the dot texture.
      // BatchedRenderer may merge/clone materials; enforce by setting common uniforms.
      if (this._foamFleckBatchMaterial && this.foamFleckTexture) {
        const m = this._foamFleckBatchMaterial;
        try {
          if (m.uniforms?.map) m.uniforms.map.value = this.foamFleckTexture;
          if (m.uniforms?.tMap) m.uniforms.tMap.value = this.foamFleckTexture;
          if (m.uniforms?.uMap) m.uniforms.uMap.value = this.foamFleckTexture;
          // Some Quarks material variants still use the standard material.map field.
          m.map = this.foamFleckTexture;
        } catch (_) {
        }
      }

      // Couple brightness to darkness like other weather so dots aren't self-illuminated.
      if (this._foamFleckMaterial) {
        const op = Number.isFinite(p.foamFlecksOpacity) ? Math.max(0.0, p.foamFlecksOpacity) : 1.0;
        const nextOpacity = op * darknessBrightnessScale;
        if (nextOpacity !== this._lastFoamFleckOpacity) {
          this._lastFoamFleckOpacity = nextOpacity;
          this._foamFleckMaterial.opacity = nextOpacity;
        }
      }
      if (this._foamFleckSystem.material) {
        const op = Number.isFinite(p.foamFlecksOpacity) ? Math.max(0.0, p.foamFlecksOpacity) : 1.0;
        const nextOpacity = op * darknessBrightnessScale;
        if (nextOpacity !== this._lastFoamFleckSystemOpacity) {
          this._lastFoamFleckSystemOpacity = nextOpacity;
          this._foamFleckSystem.material.opacity = nextOpacity;
        }
      }
    } else if (this._foamFleckSystem) {
      // A/B perf testing: allow disabling foam flecks without changing scene settings.
      try {
        if (this._foamFleckSystem.emissionOverTime && typeof this._foamFleckSystem.emissionOverTime.value === 'number') {
          this._foamFleckSystem.emissionOverTime.value = 0;
        }
        if (this._foamFleckSystem.emitter) this._foamFleckSystem.emitter.visible = false;
      } catch (_) {
      }
    }

    // PERF: Reuse the splashRoofUniformsDirty flag computed above for water-hit splash materials.
    // If the flag wasn't computed (splashSystems block didn't run), compute it now.
    const waterHitDirty = (typeof splashRoofUniformsDirty !== 'undefined')
      ? splashRoofUniformsDirty
      : (
          effectiveRoofMaskEnabled !== this._lastSplashRoofMaskEnabled
          || effectiveHasRoofAlphaMap !== this._lastSplashHasRoofAlphaMap
          || (this._roofTexture?.uuid ?? null) !== this._lastSplashRoofTexUuid
          || (roofAlphaTexture?.uuid ?? null) !== this._lastSplashRoofAlphaUuid
          || screenWidth !== this._lastSplashScreenW
          || screenHeight !== this._lastSplashScreenH
        );

    if (waterHitDirty && this._waterHitSplashBatchMaterials && this._waterHitSplashBatchMaterials.length > 0) {
      for (const mat of this._waterHitSplashBatchMaterials) {
        if (!mat || !mat.userData || !mat.userData.roofUniforms) continue;
        const u = mat.userData.roofUniforms;
        u.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
        u.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
        if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
        u.uRoofMap.value = this._roofTexture;
        u.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
        u.uScreenSize.value.set(screenWidth, screenHeight);
      }
    }

    if (this._foamMaterial && this._foamMaterial.userData && this._foamMaterial.userData.roofUniforms) {
      const u = this._foamMaterial.userData.roofUniforms;
      u.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
      u.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
      if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
      u.uRoofMap.value = this._roofTexture;
      u.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
      u.uScreenSize.value.set(screenWidth, screenHeight);

      u.uWaterMaskEnabled.value = (waterEnabled && !!waterTex) ? 1.0 : 0.0;
      u.uWaterMaskThreshold.value = this._waterMaskThreshold;
      u.uWaterMask.value = waterTex;
      // IMPORTANT: Keep shader-side _Water sampling orientation consistent with CPU-side
      // point generation (waterFlipV) and with WaterEffectV2/MaskManager metadata.
      // Using `waterTex.flipY` here can be incorrect depending on how the underlying
      // ImageBitmap was decoded/uploaded, which results in foam.webp particles being
      // clipped against a vertically inverted mask.
      if (u.uWaterMaskFlipY) u.uWaterMaskFlipY.value = waterFlipV ? 1.0 : 0.0;

      if (u.uHasWaterOccluderAlpha && u.tWaterOccluderAlpha) {
        u.tWaterOccluderAlpha.value = waterOccTex;
        u.uHasWaterOccluderAlpha.value = waterOccTex ? 1.0 : 0.0;
      }
    }

    if (this._foamBatchMaterial && this._foamBatchMaterial.userData && this._foamBatchMaterial.userData.roofUniforms) {
      const u = this._foamBatchMaterial.userData.roofUniforms;
      u.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
      u.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
      if (this._sceneBounds) u.uSceneBounds.value.copy(this._sceneBounds);
      u.uRoofMap.value = this._roofTexture;
      u.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
      u.uScreenSize.value.set(screenWidth, screenHeight);

      u.uWaterMaskEnabled.value = (waterEnabled && !!waterTex) ? 1.0 : 0.0;
      u.uWaterMaskThreshold.value = this._waterMaskThreshold;
      u.uWaterMask.value = waterTex;
      if (u.uWaterMaskFlipY) u.uWaterMaskFlipY.value = waterFlipV ? 1.0 : 0.0;

      if (u.uHasWaterOccluderAlpha && u.tWaterOccluderAlpha) {
        u.tWaterOccluderAlpha.value = waterOccTex;
        u.uHasWaterOccluderAlpha.value = waterOccTex ? 1.0 : 0.0;
      }

      // Quarks may rebuild ShaderMaterial.uniforms; also drive the live ShaderMaterial uniforms directly.
      const smu = this._foamBatchMaterial.uniforms;
      if (smu) {
        if (smu.uRoofMaskEnabled) smu.uRoofMaskEnabled.value = u.uRoofMaskEnabled.value;
        if (smu.uHasRoofAlphaMap) smu.uHasRoofAlphaMap.value = u.uHasRoofAlphaMap.value;
        if (smu.uSceneBounds && u.uSceneBounds) smu.uSceneBounds.value = u.uSceneBounds.value;
        if (smu.uRoofMap) smu.uRoofMap.value = u.uRoofMap.value;
        if (smu.uRoofAlphaMap) smu.uRoofAlphaMap.value = u.uRoofAlphaMap.value;
        if (smu.uScreenSize && u.uScreenSize) smu.uScreenSize.value = u.uScreenSize.value;

        if (smu.uWaterMaskEnabled) smu.uWaterMaskEnabled.value = u.uWaterMaskEnabled.value;
        if (smu.uWaterMaskThreshold) smu.uWaterMaskThreshold.value = u.uWaterMaskThreshold.value;
        if (smu.uWaterMask) smu.uWaterMask.value = u.uWaterMask.value;
        if (smu.uWaterMaskFlipY && u.uWaterMaskFlipY) smu.uWaterMaskFlipY.value = u.uWaterMaskFlipY.value;

        if (smu.tWaterOccluderAlpha && u.tWaterOccluderAlpha) smu.tWaterOccluderAlpha.value = u.tWaterOccluderAlpha.value;
        if (smu.uHasWaterOccluderAlpha && u.uHasWaterOccluderAlpha) smu.uHasWaterOccluderAlpha.value = u.uHasWaterOccluderAlpha.value;
      }
    }

    if (this.snowSystem) {
        // PERFORMANCE: Mutate existing values instead of creating new objects every frame
        const snowEmission = this.snowSystem.emissionOverTime;
        if (snowEmission && typeof snowEmission.value === 'number') {
            snowEmission.value = 500 * snowIntensity;
        }

        const flakeSize = snowTuning.flakeSize ?? 1.0;
        const sMin = 8 * flakeSize;
        const sMax = 12 * flakeSize;
        if (this.snowSystem.startSize && typeof this.snowSystem.startSize.a === 'number') {
            this.snowSystem.startSize.a = sMin;
            this.snowSystem.startSize.b = sMax;
        }

        // Snow brightness: modulate by scene darkness so flakes are dim in
        // dark scenes rather than fully self-illuminated.
        const snowBrightness = (snowTuning.brightness ?? 1.0) * darknessBrightnessScale;
        const clampedSnowB = THREE ? THREE.MathUtils.clamp(snowBrightness, 0.0, 3.0) : snowBrightness;
        const snowAlphaScale = clampedSnowB / 3.0;
        const snowMinAlpha = 1.0 * snowAlphaScale;
        const snowMaxAlpha = 0.8 * snowAlphaScale;
        // PERFORMANCE: Mutate existing ColorRange Vector4s
        if (this.snowSystem.startColor && this.snowSystem.startColor.a && this.snowSystem.startColor.b) {
            this.snowSystem.startColor.a.set(1.0, 1.0, 1.0, snowMinAlpha);
            this.snowSystem.startColor.b.set(0.9, 0.95, 1.0, snowMaxAlpha);
        }

        // Scale curl noise strength based on tuning so users can dial swirl intensity.
        if (this._snowCurl && this._snowCurlBaseStrength) {
          const curlStrength = debugDisableWeatherBehaviors ? 0.0 : (snowTuning.curlStrength ?? 1.0);
          this._snowCurl.strength.copy(this._snowCurlBaseStrength).multiplyScalar(curlStrength);
        }

        // Drive per-flake flutter wobble from tuning so Snow Flutter Strength has effect.
        if (this._snowFlutter) {
          const flutterStrength = debugDisableWeatherBehaviors ? 0.0 : (snowTuning.flutterStrength ?? 1.0);
          this._snowFlutter.strength = flutterStrength;
        }
        // Apply roof mask uniforms for snow (base material)
        if (this._snowMaterial && this._snowMaterial.userData && this._snowMaterial.userData.roofUniforms) {
          const uniforms = this._snowMaterial.userData.roofUniforms;
          uniforms.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
          uniforms.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
          if (this._sceneBounds) {
            uniforms.uSceneBounds.value.copy(this._sceneBounds);
          }
          uniforms.uRoofMap.value = this._roofTexture;
          uniforms.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
          uniforms.uScreenSize.value.set(screenWidth, screenHeight);
        }

        // Also drive the batch ShaderMaterial uniforms used by quarks for snow.
        if (this._snowBatchMaterial && this._snowBatchMaterial.userData && this._snowBatchMaterial.userData.roofUniforms) {
          const uniforms = this._snowBatchMaterial.userData.roofUniforms;
          uniforms.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
          uniforms.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
          if (this._sceneBounds) {
            uniforms.uSceneBounds.value.copy(this._sceneBounds);
          }
          uniforms.uRoofMap.value = this._roofTexture;
          uniforms.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
          uniforms.uScreenSize.value.set(screenWidth, screenHeight);
        }
    }

    // --- ASH SYSTEM UPDATE ---
    // Ash is controlled by a separate ashIntensity parameter from WeatherController
    if (this.ashSystem) {
      this._ensureBatchMaterialPatched(this.ashSystem, '_ashBatchMaterial');

      const ashTuning = weatherController.ashTuning || {};
      const ashIntensity = weather.ashIntensity ?? 0;
      const intensityScale = ashTuning.intensityScale ?? 1.0;
      const tunedIntensity = Math.max(0.0, ashIntensity * intensityScale);

      // One-time diagnostic log when ash first activates
      if (tunedIntensity > 0 && !this._ashActivatedLogged) {
        this._ashActivatedLogged = true;
        log.info(`Ash weather activated: ashIntensity=${ashIntensity.toFixed(3)}, tunedIntensity=${tunedIntensity.toFixed(3)}`);
      } else if (tunedIntensity <= 0 && this._ashActivatedLogged) {
        this._ashActivatedLogged = false;
      }

      // Temporal ash intensity variation: every few seconds a random "cluster center"
      // is chosen. Its distance from the (static, full-scene) emitter center drives
      // a boost multiplier on emission rate, creating natural density surges and lulls
      // without moving the emitter or creating visible rectangular edges.
      if (this._ashClusterTimer <= 0) {
        const holdMin = ashTuning.clusterHoldMin ?? 2.5;
        const holdMax = ashTuning.clusterHoldMax ?? 7.0;
        const holdRange = Math.max(0.1, holdMax - holdMin);
        this._ashClusterTimer = Math.max(0.1, holdMin + Math.random() * holdRange);

        const sx = this._sceneBounds?.x ?? 0;
        const sy = this._sceneBounds?.y ?? 0;
        const sw = this._sceneBounds?.z ?? 10000;
        const sh = this._sceneBounds?.w ?? 10000;
        this._ashClusterCenter.x = sx + Math.random() * sw;
        this._ashClusterCenter.y = sy + Math.random() * sh;

        const radiusMin = Math.max(10, ashTuning.clusterRadiusMin ?? 300);
        const radiusMax = Math.max(radiusMin, ashTuning.clusterRadiusMax ?? 1800);
        this._ashClusterRadius = radiusMin + Math.random() * (radiusMax - radiusMin);
      }
      this._ashClusterTimer -= Math.max(0, safeDt || 0);

      // Modulate ash emission based on distance from cluster center to get uneven bands.
      let clusterBoost = 1.0;
      if (this._ashClusterRadius > 0 && this.ashSystem.emitter) {
        const ex = this.ashSystem.emitter.position.x;
        const ey = this.ashSystem.emitter.position.y;
        const dx = ex - this._ashClusterCenter.x;
        const dy = ey - this._ashClusterCenter.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const t = 1.0 - Math.min(1.0, dist / this._ashClusterRadius);
        const boostMin = ashTuning.clusterBoostMin ?? 0.55;
        const boostMax = ashTuning.clusterBoostMax ?? 1.45;
        clusterBoost = boostMin + (boostMax - boostMin) * t;
      }
      
      const ashEmission = this.ashSystem.emissionOverTime;
      if (ashEmission && typeof ashEmission.value === 'number') {
        const rate = ashTuning.emissionRate ?? 300;
        ashEmission.value = rate * tunedIntensity * clusterBoost;
      }

      // Ash particle size - slightly larger than snow
      const ashSMin = ashTuning.sizeMin ?? 10;
      const ashSMax = ashTuning.sizeMax ?? 16;
      if (this.ashSystem.startSize && typeof this.ashSystem.startSize.a === 'number') {
        this.ashSystem.startSize.a = ashSMin;
        this.ashSystem.startSize.b = Math.max(ashSMin, ashSMax);
      }

      // Ash lifetime
      if (this.ashSystem.startLife && typeof this.ashSystem.startLife.a === 'number') {
        const lifeMin = ashTuning.lifeMin ?? 5;
        const lifeMax = ashTuning.lifeMax ?? 8;
        this.ashSystem.startLife.a = lifeMin;
        this.ashSystem.startLife.b = Math.max(lifeMin, lifeMax);
      }

      // Ash fall speed
      if (this.ashSystem.startSpeed && typeof this.ashSystem.startSpeed.a === 'number') {
        const speedMin = ashTuning.speedMin ?? 120;
        const speedMax = ashTuning.speedMax ?? 200;
        this.ashSystem.startSpeed.a = speedMin;
        this.ashSystem.startSpeed.b = Math.max(speedMin, speedMax);
      }

      // Ash brightness: darker particles, less affected by scene darkness
      const ashBrightness = (ashTuning.brightness ?? 1.0) * darknessBrightnessScale;
      const clampedAshB = THREE ? THREE.MathUtils.clamp(ashBrightness, 0.0, 3.0) : ashBrightness;
      const ashAlphaScale = clampedAshB / 3.0;
      const ashMinAlpha = (ashTuning.opacityStartMin ?? 0.75) * ashAlphaScale;
      const ashMaxAlpha = (ashTuning.opacityStartMax ?? 0.5) * ashAlphaScale;
      if (this.ashSystem.startColor && this.ashSystem.startColor.a && this.ashSystem.startColor.b) {
        const cStart = ashTuning.colorStart ?? { r: 0.45, g: 0.42, b: 0.38 };
        const cEnd = ashTuning.colorEnd ?? { r: 0.35, g: 0.32, b: 0.28 };
        this.ashSystem.startColor.a.set(cStart.r, cStart.g, cStart.b, ashMinAlpha);
        this.ashSystem.startColor.b.set(cEnd.r, cEnd.g, cEnd.b, ashMaxAlpha);
      }

      if (this._ashColorOverLife?.color?.a && this._ashColorOverLife.color?.b) {
        const cStart = ashTuning.colorStart ?? { r: 0.45, g: 0.42, b: 0.38 };
        const cEnd = ashTuning.colorEnd ?? { r: 0.35, g: 0.32, b: 0.28 };
        const endAlpha = Math.max(0.0, ashTuning.opacityEnd ?? 0.0);
        this._ashColorOverLife.color.a.set(cStart.r, cStart.g, cStart.b, ashMinAlpha);
        this._ashColorOverLife.color.b.set(cEnd.r, cEnd.g, cEnd.b, endAlpha);
      }

      // Scale curl noise for ash
      if (this._ashCurl && this._ashCurlBaseStrength) {
        const curlStrength = debugDisableWeatherBehaviors ? 0.0 : (ashTuning.curlStrength ?? 0.6);
        this._ashCurl.strength.copy(this._ashCurlBaseStrength).multiplyScalar(curlStrength);
      }

      // Apply roof mask uniforms for ash (base material)
      if (this._ashMaterial && this._ashMaterial.userData && this._ashMaterial.userData.roofUniforms) {
        const uniforms = this._ashMaterial.userData.roofUniforms;
        uniforms.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
        uniforms.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
        if (this._sceneBounds) {
          uniforms.uSceneBounds.value.copy(this._sceneBounds);
        }
        uniforms.uRoofMap.value = this._roofTexture;
        uniforms.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
        uniforms.uScreenSize.value.set(screenWidth, screenHeight);
      }

      // Also drive the batch ShaderMaterial uniforms used by quarks for ash
      if (this._ashBatchMaterial && this._ashBatchMaterial.userData && this._ashBatchMaterial.userData.roofUniforms) {
        const uniforms = this._ashBatchMaterial.userData.roofUniforms;
        uniforms.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
        uniforms.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
        if (this._sceneBounds) {
          uniforms.uSceneBounds.value.copy(this._sceneBounds);
        }
        uniforms.uRoofMap.value = this._roofTexture;
        uniforms.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
        uniforms.uScreenSize.value.set(screenWidth, screenHeight);
      }
    }

    if (this.ashEmberSystem) {
      this._ensureBatchMaterialPatched(this.ashEmberSystem, '_ashEmberBatchMaterial');
      const ashTuning = weatherController.ashTuning || {};
      const ashIntensity = weather.ashIntensity ?? 0;
      const intensityScale = ashTuning.intensityScale ?? 1.0;
      const tunedIntensity = Math.max(0.0, ashIntensity * intensityScale);

      const emberEmission = this.ashEmberSystem.emissionOverTime;
      if (emberEmission && typeof emberEmission.value === 'number') {
        const rate = ashTuning.emberEmissionRate ?? 25;
        emberEmission.value = rate * tunedIntensity;
      }

      if (this.ashEmberSystem.startSize && typeof this.ashEmberSystem.startSize.a === 'number') {
        const emberSizeMin = ashTuning.emberSizeMin ?? 6;
        const emberSizeMax = ashTuning.emberSizeMax ?? 12;
        this.ashEmberSystem.startSize.a = emberSizeMin;
        this.ashEmberSystem.startSize.b = Math.max(emberSizeMin, emberSizeMax);
      }

      if (this.ashEmberSystem.startLife && typeof this.ashEmberSystem.startLife.a === 'number') {
        const emberLifeMin = ashTuning.emberLifeMin ?? 2.5;
        const emberLifeMax = ashTuning.emberLifeMax ?? 4.0;
        this.ashEmberSystem.startLife.a = emberLifeMin;
        this.ashEmberSystem.startLife.b = Math.max(emberLifeMin, emberLifeMax);
      }

      if (this.ashEmberSystem.startSpeed && typeof this.ashEmberSystem.startSpeed.a === 'number') {
        const emberSpeedMin = ashTuning.emberSpeedMin ?? 180;
        const emberSpeedMax = ashTuning.emberSpeedMax ?? 260;
        this.ashEmberSystem.startSpeed.a = emberSpeedMin;
        this.ashEmberSystem.startSpeed.b = Math.max(emberSpeedMin, emberSpeedMax);
      }

      const emberBrightness = (ashTuning.emberBrightness ?? 1.0) * darknessBrightnessScale;
      const clampedEmberB = THREE ? THREE.MathUtils.clamp(emberBrightness, 0.0, 5.0) : emberBrightness;
      const emberAlphaScale = clampedEmberB / 5.0;
      const emberMinAlpha = (ashTuning.emberOpacityStartMin ?? 0.9) * emberAlphaScale;
      const emberMaxAlpha = (ashTuning.emberOpacityStartMax ?? 0.4) * emberAlphaScale;

      if (this.ashEmberSystem.startColor && this.ashEmberSystem.startColor.a && this.ashEmberSystem.startColor.b) {
        const emberStart = ashTuning.emberColorStart ?? { r: 1.0, g: 0.25, b: 0.05 };
        const emberEnd = ashTuning.emberColorEnd ?? { r: 0.35, g: 0.32, b: 0.28 };
        this.ashEmberSystem.startColor.a.set(emberStart.r, emberStart.g, emberStart.b, emberMinAlpha);
        this.ashEmberSystem.startColor.b.set(emberEnd.r, emberEnd.g, emberEnd.b, emberMaxAlpha);
      }

      if (this._ashEmberColorOverLife?.color?.a && this._ashEmberColorOverLife.color?.b) {
        const emberStart = ashTuning.emberColorStart ?? { r: 1.0, g: 0.25, b: 0.05 };
        const emberEnd = ashTuning.emberColorEnd ?? { r: 0.35, g: 0.32, b: 0.28 };
        const emberEndAlpha = Math.max(0.0, ashTuning.emberOpacityEnd ?? 0.0);
        this._ashEmberColorOverLife.color.a.set(emberStart.r, emberStart.g, emberStart.b, emberMinAlpha);
        this._ashEmberColorOverLife.color.b.set(emberEnd.r, emberEnd.g, emberEnd.b, emberEndAlpha);
      }

      if (this._ashEmberCurl && this._ashEmberCurlBaseStrength) {
        const emberCurlStrength = debugDisableWeatherBehaviors ? 0.0 : (ashTuning.emberCurlStrength ?? 1.0);
        this._ashEmberCurl.strength.copy(this._ashEmberCurlBaseStrength).multiplyScalar(emberCurlStrength);
      }

      if (this._ashEmberMaterial && this._ashEmberMaterial.userData && this._ashEmberMaterial.userData.roofUniforms) {
        const uniforms = this._ashEmberMaterial.userData.roofUniforms;
        uniforms.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
        uniforms.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
        if (this._sceneBounds) {
          uniforms.uSceneBounds.value.copy(this._sceneBounds);
        }
        uniforms.uRoofMap.value = this._roofTexture;
        uniforms.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
        uniforms.uScreenSize.value.set(screenWidth, screenHeight);
      }

      if (this._ashEmberBatchMaterial && this._ashEmberBatchMaterial.userData && this._ashEmberBatchMaterial.userData.roofUniforms) {
        const uniforms = this._ashEmberBatchMaterial.userData.roofUniforms;
        uniforms.uRoofMaskEnabled.value = effectiveRoofMaskEnabled ? 1.0 : 0.0;
        uniforms.uHasRoofAlphaMap.value = effectiveHasRoofAlphaMap ? 1.0 : 0.0;
        if (this._sceneBounds) {
          uniforms.uSceneBounds.value.copy(this._sceneBounds);
        }
        uniforms.uRoofMap.value = this._roofTexture;
        uniforms.uRoofAlphaMap.value = effectiveHasRoofAlphaMap ? roofAlphaTexture : null;
        uniforms.uScreenSize.value.set(screenWidth, screenHeight);
      }
    }

    // --- WIND & GRAVITY COUPLING ---
    if (THREE && (this._rainWindForce || this._snowWindForce || this._rainGravityForce || this._snowGravityForce)) {
      const windSpeed = weather.windSpeed || 0; // 0-1 scalar
      const dir2 = weather.windDirection; // Expected THREE.Vector2 or Vector3-like

      // PERFORMANCE FIX: Reuse _tempWindDir instead of allocating new Vector3 every frame
      const baseDir = this._tempWindDir;
      baseDir.set(dir2?.x ?? 1, dir2?.y ?? 0, 0);
      if (baseDir.lengthSq() === 0) baseDir.set(1, 0, 0);
      baseDir.normalize();

      // Rain: follow wind direction directly (no turbulence needed here)
      // Scale magnitude by windSpeed and user windInfluence so the UI control has visible effect.
      const rainWindInfluence = rainTuning.windInfluence ?? 1.0;
      if (this._rainWindForce && this._rainWindForce.direction) {
        this._rainWindForce.direction.set(baseDir.x, baseDir.y, 0);
        // PERFORMANCE: Mutate existing ConstantValue instead of creating new one
        if (this._rainWindForce.magnitude && typeof this._rainWindForce.magnitude.value === 'number') {
          this._rainWindForce.magnitude.value = 3000 * windSpeed * rainWindInfluence;
        }
      }

      // Rain curl turbulence: very low at calm, grows with wind speed.
      if (this._rainCurl && this._rainCurlBaseStrength) {
        // Start introducing turbulence once windSpeed exceeds 0.5, ramping to full at 1.0.
        let windTurbulenceFactor = 0;
        if (windSpeed > 0.5) {
          windTurbulenceFactor = THREE.MathUtils.clamp((windSpeed - 0.5) / 0.5, 0, 1);
        }

        const curlStrength = debugDisableWeatherBehaviors ? 0.0 : (rainTuning.curlStrength ?? 1.0);
        const curlScale = windTurbulenceFactor * curlStrength;
        this._rainCurl.strength.copy(this._rainCurlBaseStrength).multiplyScalar(curlScale);
      }

      // Snow: align large-scale drift with global wind; fine-grained turbulence now
      // comes from TurbulenceField behavior instead of manual sine-based drift.
      const snowWindInfluence = snowTuning.windInfluence ?? 1.0;
      if (this._snowWindForce && this._snowWindForce.direction) {
        this._snowWindForce.direction.set(baseDir.x, baseDir.y, 0);

        // Let windSpeed fully control alignment strength; at 0 wind, no directional drift.
        // PERFORMANCE: Mutate existing ConstantValue instead of creating new one
        if (this._snowWindForce.magnitude && typeof this._snowWindForce.magnitude.value === 'number') {
          const baseMag = 800; // matches constructor default above
          const align = THREE.MathUtils.clamp(windSpeed, 0, 1);
          const strength = align * snowWindInfluence;
          this._snowWindForce.magnitude.value = baseMag * strength;
        }
      }

      // Gravity scaling for rain and snow
      // PERFORMANCE: Mutate existing ConstantValue instead of creating new one
      const rainGravScale = rainTuning.gravityScale ?? 1.0;
      if (this._rainGravityForce && this._rainGravityForce.magnitude && typeof this._rainGravityForce.magnitude.value === 'number') {
        this._rainGravityForce.magnitude.value = this._rainBaseGravity * rainGravScale;
      }

      const snowGravScale = snowTuning.gravityScale ?? 1.0;
      if (this._snowGravityForce && this._snowGravityForce.magnitude && typeof this._snowGravityForce.magnitude.value === 'number') {
        this._snowGravityForce.magnitude.value = this._snowBaseGravity * snowGravScale;
      }

      // Ash: Wind and gravity coupling (less responsive than snow)
      const ashTuning = weatherController.ashTuning || {};
      if (this._ashWindForce && this._ashWindForce.direction) {
        this._ashWindForce.direction.set(baseDir.x, baseDir.y, 0);
        if (this._ashWindForce.magnitude && typeof this._ashWindForce.magnitude.value === 'number') {
          const baseMag = 400; // Less wind influence than snow
          const align = THREE.MathUtils.clamp(windSpeed, 0, 1);
          const windInfluence = ashTuning.windInfluence ?? 1.0;
          this._ashWindForce.magnitude.value = baseMag * align * 0.7 * windInfluence;
        }
      }

      if (this._ashEmberWindForce && this._ashEmberWindForce.direction) {
        this._ashEmberWindForce.direction.set(baseDir.x, baseDir.y, 0);
        if (this._ashEmberWindForce.magnitude && typeof this._ashEmberWindForce.magnitude.value === 'number') {
          const baseMag = 650;
          const align = THREE.MathUtils.clamp(windSpeed, 0, 1);
          const windInfluence = ashTuning.emberWindInfluence ?? 1.0;
          this._ashEmberWindForce.magnitude.value = baseMag * align * 0.9 * windInfluence;
        }
      }

      if (this._ashGravityForce && this._ashGravityForce.magnitude && typeof this._ashGravityForce.magnitude.value === 'number') {
        const gravScale = ashTuning.gravityScale ?? 1.0;
        this._ashGravityForce.magnitude.value = this._ashBaseGravity * gravScale;
      }

      if (this._ashEmberGravityForce && this._ashEmberGravityForce.magnitude && typeof this._ashEmberGravityForce.magnitude.value === 'number') {
        const emberGravScale = ashTuning.emberGravityScale ?? 0.75;
        this._ashEmberGravityForce.magnitude.value = this._ashBaseGravity * 0.75 * emberGravScale;
      }

      // Splashes: Wind coupling (> 25%)
      // PERFORMANCE: Mutate existing ConstantValue instead of creating new one
      if (this._splashWindForces && this._splashWindForces.length > 0) {
        let splashWindMag = 0;
        // "Start subtle but at 100% wind speed it can be stronger."
        if (windSpeed > 0.25) {
          // Map 0.25..1.0 to 0.0..1.0
          const t = (windSpeed - 0.25) * 4.0;
          // Base magnitude 75 (~5x weaker than previous 375)
          splashWindMag = t * 75;
        }

        for (const force of this._splashWindForces) {
          if (force.direction) force.direction.set(baseDir.x, baseDir.y, 0);
          if (force.magnitude && typeof force.magnitude.value === 'number') {
            force.magnitude.value = splashWindMag;
          }
        }
      }
    }
  }

  dispose() {
    if (this.rainSystem) {
      this.batchRenderer.deleteSystem(this.rainSystem);
      if (this.rainSystem.emitter.parent) this.rainSystem.emitter.parent.remove(this.rainSystem.emitter);
    }
    if (this.snowSystem) {
      this.batchRenderer.deleteSystem(this.snowSystem);
      if (this.snowSystem.emitter.parent) this.snowSystem.emitter.parent.remove(this.snowSystem.emitter);
    }

    if (this.ashSystem) {
      this.batchRenderer.deleteSystem(this.ashSystem);
      if (this.ashSystem.emitter.parent) this.ashSystem.emitter.parent.remove(this.ashSystem.emitter);
    }

    if (this.ashEmberSystem) {
      this.batchRenderer.deleteSystem(this.ashEmberSystem);
      if (this.ashEmberSystem.emitter.parent) this.ashEmberSystem.emitter.parent.remove(this.ashEmberSystem.emitter);
    }

    if (this.splashSystems && this.splashSystems.length) {
      for (const sys of this.splashSystems) {
        if (!sys) continue;
        this.batchRenderer.deleteSystem(sys);
        if (sys.emitter?.parent) sys.emitter.parent.remove(sys.emitter);
      }
    }

    if (this._waterHitSplashSystems && this._waterHitSplashSystems.length) {
      for (const entry of this._waterHitSplashSystems) {
        const sys = entry?.system;
        if (!sys) continue;
        this.batchRenderer.deleteSystem(sys);
        if (sys.emitter?.parent) sys.emitter.parent.remove(sys.emitter);
      }
    }

    if (this._foamSystem) {
      this.batchRenderer.deleteSystem(this._foamSystem);
      if (this._foamSystem.emitter?.parent) this._foamSystem.emitter.parent.remove(this._foamSystem.emitter);
    }

    if (this._foamFleckSystem) {
      this.batchRenderer.deleteSystem(this._foamFleckSystem);
      if (this._foamFleckSystem.emitter?.parent) this._foamFleckSystem.emitter.parent.remove(this._foamFleckSystem.emitter);
    }

    if (this.rainTexture) this.rainTexture.dispose();
    if (this.snowTexture) this.snowTexture.dispose();
    if (this.ashTexture) this.ashTexture.dispose();
    if (this.splashTexture) this.splashTexture.dispose();
    if (this.foamTexture) this.foamTexture.dispose();
    if (this.foamFleckTexture) this.foamFleckTexture.dispose();

    try { this._maskPixelCache?.clear?.(); } catch (_) {}
    this._maskPixelCacheBytes = 0;
    this._maskReadCanvas = null;
    this._maskReadCtx = null;
  }

  _getStableSrc(src) {
    try {
      const s = String(src || '');
      if (!s) return '';
      const q = s.indexOf('?');
      return q >= 0 ? s.slice(0, q) : s;
    } catch (_) {
      return '';
    }
  }

  _getMaskPixelData(maskTexture) {
    const image = maskTexture?.image;
    if (!image) return null;
    const w = image.width;
    const h = image.height;
    if (!w || !h) return null;

    // Build a cache key that includes texture uuid and version to detect content changes.
    const uuid = maskTexture?.uuid || '';
    const version = (typeof maskTexture?.version === 'number') ? maskTexture.version : 0;
    const src = this._getStableSrc(image.src) || this._getStableSrc(maskTexture?.source?.data?.src) || this._getStableSrc(maskTexture?.userData?.src) || '';
    const key = `${src}|${uuid}|v:${version}|${w}|${h}`;

    const cached = this._maskPixelCache.get(key);
    if (cached && cached.data && cached.width === w && cached.height === h) {
      // LRU touch: move to end of Map iteration order.
      try {
        this._maskPixelCache.delete(key);
        this._maskPixelCache.set(key, cached);
      } catch (_) {}
      return cached;
    }

    // Evict stale versions of the same texture (different version number).
    if (uuid) {
      try {
        const prefix = `${src}|${uuid}|v:`;
        for (const k of this._maskPixelCache.keys()) {
          if (k !== key && k.startsWith(prefix)) this._deleteMaskPixelCacheEntry(k);
        }
      } catch (_) {}
    }

    try {
      if (!this._maskReadCanvas) {
        this._maskReadCanvas = document.createElement('canvas');
      }
      const canvas = this._maskReadCanvas;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      if (!this._maskReadCtx) {
        this._maskReadCtx = canvas.getContext('2d');
      }
      const ctx = this._maskReadCtx;
      if (!ctx) return null;
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0);
      const img = ctx.getImageData(0, 0, w, h);
      const entry = { width: w, height: h, data: img.data, byteLength: img.data?.byteLength ?? (w * h * 4) };
      this._maskPixelCache.set(key, entry);
      if (typeof entry.byteLength === 'number' && Number.isFinite(entry.byteLength) && entry.byteLength > 0) {
        this._maskPixelCacheBytes = (this._maskPixelCacheBytes || 0) + entry.byteLength;
      }

      // LRU eviction: keep cache size bounded.
      try {
        const maxEntries = Number.isFinite(this._maskPixelCacheMaxEntries)
          ? Math.max(8, Math.floor(this._maskPixelCacheMaxEntries))
          : 48;

        const maxBytes = Number.isFinite(this._maskPixelCacheMaxBytes)
          ? Math.max(8 * 1024 * 1024, Math.floor(this._maskPixelCacheMaxBytes))
          : 64 * 1024 * 1024;

        while (this._maskPixelCache.size > maxEntries || (this._maskPixelCacheBytes || 0) > maxBytes) {
          const oldest = this._maskPixelCache.keys().next().value;
          if (oldest === undefined) break;
          // Always evict from the front of the Map, which is our LRU order.
          // Update our byte accounting so large masks don't accumulate silently.
          this._deleteMaskPixelCacheEntry(oldest);
        }
      } catch (_) {}

      return entry;
    } catch (_) {
      return null;
    }
  }

  _generateWaterHardEdgePoints(maskTexture, edgeThreshold = 0.5, stride = 2, maxPoints = 24000, flipV = false) {
    const entry = this._getMaskPixelData(maskTexture);
    if (!entry) return null;
    const w = entry.width;
    const h = entry.height;
    const data = entry.data;

    // Reservoir sampling so we get a uniform subset of boundary pixels.
    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 2);
    let filled = 0;
    let eligible = 0;

    const s = Math.max(1, stride | 0);
    // PERF: Precompute constants to avoid repeated division inside the loop.
    const inv65025 = 1.0 / (255.0 * 255.0);
    const hMinus1 = h - 1;
    const wMinus1 = w - 1;

    // IMPORTANT: `v` stored in the output point list is expected to be in the same
    // top-down scene-UV convention used throughout WeatherParticles (because spawn
    // conversion uses worldY = (1 - v) * height).
    // When the water mask is effectively flipped for sampling, we must flip the
    // *source pixel lookup* rather than flipping the returned v, or the spawn
    // will be double-inverted.

    for (let y = 1; y < hMinus1; y += s) {
      const yImg = flipV ? (hMinus1 - y) : y;
      const row = yImg * w;
      const rowUp = (flipV ? (yImg + 1) : (yImg - 1)) * w;
      const rowDown = (flipV ? (yImg - 1) : (yImg + 1)) * w;

      for (let x = 1; x < wMinus1; x += s) {
        // Inline sample for center pixel.
        const ix = (row + x) << 2;
        const aC = data[ix + 3];
        if (aC === 0) continue;
        const lumC = 0.299 * data[ix] + 0.587 * data[ix + 1] + 0.114 * data[ix + 2];
        const v = lumC * aC * inv65025;
        // Spawn on the boundary but stay on the "inside" (water/white) side.
        if (v < edgeThreshold) continue;

        // Inline sample for left neighbor.
        const ixL = (row + (x - 1)) << 2;
        const aL = data[ixL + 3];
        const left = (aL === 0)
          ? 0.0
          : ((0.299 * data[ixL] + 0.587 * data[ixL + 1] + 0.114 * data[ixL + 2]) * aL * inv65025);

        // Inline sample for right neighbor.
        const ixR = (row + (x + 1)) << 2;
        const aR = data[ixR + 3];
        const right = (aR === 0)
          ? 0.0
          : ((0.299 * data[ixR] + 0.587 * data[ixR + 1] + 0.114 * data[ixR + 2]) * aR * inv65025);

        // Inline sample for up neighbor.
        const ixU = (rowUp + x) << 2;
        const aU = data[ixU + 3];
        const up = (aU === 0)
          ? 0.0
          : ((0.299 * data[ixU] + 0.587 * data[ixU + 1] + 0.114 * data[ixU + 2]) * aU * inv65025);

        // Inline sample for down neighbor.
        const ixD = (rowDown + x) << 2;
        const aD = data[ixD + 3];
        const down = (aD === 0)
          ? 0.0
          : ((0.299 * data[ixD] + 0.587 * data[ixD + 1] + 0.114 * data[ixD + 2]) * aD * inv65025);

        const isBoundary = (left < edgeThreshold) || (right < edgeThreshold) || (up < edgeThreshold) || (down < edgeThreshold);
        if (!isBoundary) continue;

        const u = x / w;
        // Keep v in top-down scene UV.
        const vv = y / h;

        if (filled < max) {
          const o = filled * 2;
          out[o] = u;
          out[o + 1] = vv;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (eligible + 1));
          if (j < max) {
            const o = j * 2;
            out[o] = u;
            out[o + 1] = vv;
          }
        }
        eligible++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }

  _generateWaterDataBoundaryInsetPoints(waterDataTexture, insetPx = 1.0, bandPx = 2.0, stride = 2, maxPoints = 24000, flipV = false) {
    const img = waterDataTexture?.image;
    const data = img?.data;
    const w = img?.width;
    const h = img?.height;
    if (!data || !w || !h) return null;

    const ip = Math.max(0.0, Number.isFinite(insetPx) ? insetPx : 1.0);
    const bp = Math.max(0.0, Number.isFinite(bandPx) ? bandPx : 0.0);

    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 2);
    let filled = 0;
    let eligible = 0;
    const s = Math.max(1, stride | 0);

    // Same convention as _generateWaterHardEdgePoints: output v is top-down scene UV.
    // Apply flipV only to the underlying pixel lookup.
    const yToImg = (yy) => (flipV ? (h - 1 - yy) : yy);
    const sdfAt = (x, yScene) => {
      const xx = Math.max(0, Math.min(w - 1, x));
      const yImg0 = yToImg(yScene);
      const yy = Math.max(0, Math.min(h - 1, yImg0));
      return data[(yy * w + xx) * 4] / 255;
    };

    for (let y = 1; y < h - 1; y += s) {
      for (let x = 1; x < w - 1; x += s) {
        const yImg = yToImg(y);
        const idx = (yImg * w + x) * 4;
        const sdf01 = data[idx] / 255;

        // Only consider inside-water pixels (WaterSurfaceModel encodes inside water as sdf01 < 0.5).
        if (sdf01 >= 0.5) continue;

        // Boundary detection: any neighbor outside water.
        const isBoundary = (sdfAt(x - 1, y) >= 0.5) || (sdfAt(x + 1, y) >= 0.5) || (sdfAt(x, y - 1) >= 0.5) || (sdfAt(x, y + 1) >= 0.5);
        if (!isBoundary) continue;

        // WaterData stores the SDF gradient (normal) in BA in [0,1]. This points toward increasing sdf
        // (i.e. out of water). We move *against* it to step just inside the water.
        const nx = (data[idx + 2] / 255 - 0.5) * 2.0;
        const ny = (data[idx + 3] / 255 - 0.5) * 2.0;
        const nLen = Math.hypot(nx, ny);
        const nX = nLen > 1e-6 ? (nx / nLen) : 1.0;
        const nY = nLen > 1e-6 ? (ny / nLen) : 0.0;

        const step = ip + (bp > 0 ? Math.random() * bp : 0.0);
        const sx = Math.round(x - nX * step);
        const sy = Math.round(y - nY * step);

        // Ensure the in-set point is still inside water.
        if (sdfAt(sx, sy) >= 0.5) continue;

        const u = sx / w;
        const v = sy / h;

        if (filled < max) {
          const o = filled * 2;
          out[o] = u;
          out[o + 1] = v;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (eligible + 1));
          if (j < max) {
            const o = j * 2;
            out[o] = u;
            out[o + 1] = v;
          }
        }
        eligible++;
      }
    }

    if (filled < 1) return null;
    if (filled === max) return out;
    return out.subarray(0, filled * 2);
  }

  _generateWaterDataInsetEdgePoints(waterDataTexture, insetPx = 1.0, bandPx = 2.0, exposureWidthPx = 128.0, stride = 2, maxPoints = 24000) {
    const img = waterDataTexture?.image;
    const data = img?.data;
    const w = img?.width;
    const h = img?.height;
    if (!data || !w || !h) return null;

    const ew = Math.max(1e-3, Number.isFinite(exposureWidthPx) ? exposureWidthPx : 128.0);
    const ip = Math.max(0.0, Number.isFinite(insetPx) ? insetPx : 1.0);
    const bp = Math.max(1e-3, Number.isFinite(bandPx) ? bandPx : 2.0);

    // exposure01 is distance-inside-water normalized by exposureWidthPx.
    // exposure01 == 0 exactly at boundary; we want just-inside-water.
    const lo = Math.min(0.999, Math.max(0.0, ip / ew));
    const hi = Math.min(1.0, Math.max(lo + 1e-6, (ip + bp) / ew));

    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 2);
    let filled = 0;
    let eligible = 0;
    const s = Math.max(1, stride | 0);

    for (let y = 1; y < h - 1; y += s) {
      for (let x = 1; x < w - 1; x += s) {
        const idx = (y * w + x) * 4;
        const sdf01 = data[idx] / 255;
        const exposure01 = data[idx + 1] / 255;

        // Only allow points inside water. In WaterSurfaceModel, sdf01 < 0.5 corresponds to inside water.
        if (sdf01 >= 0.5) continue;
        if (exposure01 < lo || exposure01 > hi) continue;

        const u = x / w;
        const v = y / h;

        if (filled < max) {
          const o = filled * 2;
          out[o] = u;
          out[o + 1] = v;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (eligible + 1));
          if (j < max) {
            const o = j * 2;
            out[o] = u;
            out[o + 1] = v;
          }
        }
        eligible++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }

  _getViewFilteredUvPoints(pts) {
    if (!pts || pts.length < 2) return null;

    const minX = this._viewMinX;
    const maxX = this._viewMaxX;
    const minY = this._viewMinY;
    const maxY = this._viewMaxY;
    const sceneX = this._viewSceneX;
    const sceneY = this._viewSceneY;
    const sceneW = this._viewSceneW;
    const sceneH = this._viewSceneH;

    if (
      !Number.isFinite(minX) || !Number.isFinite(maxX) ||
      !Number.isFinite(minY) || !Number.isFinite(maxY) ||
      !Number.isFinite(sceneX) || !Number.isFinite(sceneY) ||
      !Number.isFinite(sceneW) || !Number.isFinite(sceneH) ||
      sceneW <= 1e-6 || sceneH <= 1e-6
    ) {
      return null;
    }

    // Convert the visible WORLD rect (Y-up) to mask UVs (u: left->right, v: top->bottom).
    let u0 = (minX - sceneX) / sceneW;
    let u1 = (maxX - sceneX) / sceneW;
    const vTop = 1.0 - ((maxY - sceneY) / sceneH);
    const vBottom = 1.0 - ((minY - sceneY) / sceneH);
    let v0 = Math.min(vTop, vBottom);
    let v1 = Math.max(vTop, vBottom);

    // Clamp to texture UV range.
    u0 = Math.max(0.0, Math.min(1.0, u0));
    u1 = Math.max(0.0, Math.min(1.0, u1));
    v0 = Math.max(0.0, Math.min(1.0, v0));
    v1 = Math.max(0.0, Math.min(1.0, v1));

    // Quantize to avoid re-filtering every single frame for tiny camera drift.
    const q = 256;
    const qU0 = Math.floor(u0 * q);
    const qU1 = Math.floor(u1 * q);
    const qV0 = Math.floor(v0 * q);
    const qV1 = Math.floor(v1 * q);
    if (
      qU0 === this._waterFoamLastViewQU0 &&
      qU1 === this._waterFoamLastViewQU1 &&
      qV0 === this._waterFoamLastViewQV0 &&
      qV1 === this._waterFoamLastViewQV1
    ) {
      return (this._waterFoamViewBuffer && this._waterFoamViewCount > 0)
        ? this._waterFoamViewBuffer.subarray(0, this._waterFoamViewCount * 2)
        : null;
    }
    this._waterFoamLastViewQU0 = qU0;
    this._waterFoamLastViewQU1 = qU1;
    this._waterFoamLastViewQV0 = qV0;
    this._waterFoamLastViewQV1 = qV1;

    const maxPoints = Math.max(1, Math.min(this._waterMaskMaxPoints, 24000) | 0);
    if (!this._waterFoamViewBuffer || this._waterFoamViewBuffer.length < maxPoints * 2) {
      this._waterFoamViewBuffer = new Float32Array(maxPoints * 2);
    }

    const count = Math.floor(pts.length / 2);
    let filled = 0;
    let eligible = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 2;
      const u = pts[o];
      const v = pts[o + 1];
      if (u < u0 || u > u1 || v < v0 || v > v1) continue;

      if (filled < maxPoints) {
        const outO = filled * 2;
        this._waterFoamViewBuffer[outO] = u;
        this._waterFoamViewBuffer[outO + 1] = v;
        filled++;
      } else {
        const j = Math.floor(Math.random() * (eligible + 1));
        if (j < maxPoints) {
          const outO = j * 2;
          this._waterFoamViewBuffer[outO] = u;
          this._waterFoamViewBuffer[outO + 1] = v;
        }
      }
      eligible++;
    }

    this._waterFoamViewCount = filled;
    return filled > 0 ? this._waterFoamViewBuffer.subarray(0, filled * 2) : null;
  }

  _mergeUvPointSets(aPts, bPts, maxPoints = 24000, minBPoints = 0) {
    const a = aPts && aPts.length >= 2 ? aPts : null;
    const b = bPts && bPts.length >= 2 ? bPts : null;
    if (!a && !b) return null;
    if (!b) return a;
    if (!a) return b;

    const aCount = Math.floor(a.length / 2);
    const bCount = Math.floor(b.length / 2);
    const max = Math.max(1, maxPoints | 0);
    const total = aCount + bCount;

    if (total <= max) {
      const out = new Float32Array(total * 2);
      out.set(a, 0);
      out.set(b, aCount * 2);
      return out;
    }

    // Stratified merge:
    // - Ensure the secondary set (typically tile points) contributes at least a small quota.
    // - Then fill the remainder with reservoir sampling across the combined stream.
    const minB = Math.max(0, Math.min(max, (minBPoints | 0)));
    const wantB = Math.min(bCount, minB);
    const wantA = Math.min(aCount, Math.max(0, max - wantB));

    const out = new Float32Array(max * 2);
    let filled = 0;

    // Reservoir sample a subset of points from src directly into `out`, starting at `filled`.
    const sampleInto = (src, srcCount, take) => {
      if (!src || srcCount <= 0 || take <= 0 || filled >= max) return;
      const takeN = Math.min(take, max - filled);
      if (takeN <= 0) return;

      if (takeN >= srcCount) {
        for (let i = 0; i < srcCount && filled < max; i++) {
          const o = i * 2;
          const oo = filled * 2;
          out[oo] = src[o];
          out[oo + 1] = src[o + 1];
          filled++;
        }
        return;
      }

      const start = filled;
      let picked = 0;
      let seen = 0;
      for (let i = 0; i < srcCount; i++) {
        const o = i * 2;
        const u = src[o];
        const v = src[o + 1];
        if (picked < takeN) {
          const oo = (start + picked) * 2;
          out[oo] = u;
          out[oo + 1] = v;
          picked++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < takeN) {
            const oo = (start + j) * 2;
            out[oo] = u;
            out[oo + 1] = v;
          }
        }
        seen++;
      }
      filled += picked;
    };

    // Take a guaranteed sample from tiles first, then from the scene.
    sampleInto(b, bCount, wantB);
    sampleInto(a, aCount, wantA);

    // If we still have capacity (rare), fill with reservoir across remaining points.
    if (filled < max) {
      let seen = 0;
      const push = (u, v) => {
        if (filled < max) {
          const o = filled * 2;
          out[o] = u;
          out[o + 1] = v;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < max) {
            const o = j * 2;
            out[o] = u;
            out[o + 1] = v;
          }
        }
        seen++;
      };
      for (let i = 0; i < aCount; i++) {
        const o = i * 2;
        push(a[o], a[o + 1]);
      }
      for (let i = 0; i < bCount; i++) {
        const o = i * 2;
        push(b[o], b[o + 1]);
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }

  _mergeEdgePointSets(aPts, bPts, maxPoints = 16000, minBPoints = 0) {
    const a = aPts && aPts.length >= 4 ? aPts : null;
    const b = bPts && bPts.length >= 4 ? bPts : null;
    if (!a && !b) return null;
    if (!b) return a;
    if (!a) return b;

    const aCount = Math.floor(a.length / 4);
    const bCount = Math.floor(b.length / 4);
    const max = Math.max(1, maxPoints | 0);
    const total = aCount + bCount;

    if (total <= max) {
      const out = new Float32Array(total * 4);
      out.set(a, 0);
      out.set(b, aCount * 4);
      return out;
    }

    const out = new Float32Array(max * 4);
    let filled = 0;

    const minB = Math.max(0, Math.min(max, (minBPoints | 0)));
    const wantB = Math.min(bCount, minB);
    const wantA = Math.min(aCount, Math.max(0, max - wantB));

    const sampleInto = (src, srcCount, take) => {
      if (!src || srcCount <= 0 || take <= 0 || filled >= max) return;
      const takeN = Math.min(take, max - filled);
      if (takeN <= 0) return;

      if (takeN >= srcCount) {
        for (let i = 0; i < srcCount && filled < max; i++) {
          const o = i * 4;
          const oo = filled * 4;
          out[oo] = src[o];
          out[oo + 1] = src[o + 1];
          out[oo + 2] = src[o + 2];
          out[oo + 3] = src[o + 3];
          filled++;
        }
        return;
      }

      const start = filled;
      let picked = 0;
      let seen = 0;
      for (let i = 0; i < srcCount; i++) {
        const o = i * 4;
        const u = src[o];
        const v = src[o + 1];
        const nx = src[o + 2];
        const ny = src[o + 3];
        if (picked < takeN) {
          const oo = (start + picked) * 4;
          out[oo] = u;
          out[oo + 1] = v;
          out[oo + 2] = nx;
          out[oo + 3] = ny;
          picked++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < takeN) {
            const oo = (start + j) * 4;
            out[oo] = u;
            out[oo + 1] = v;
            out[oo + 2] = nx;
            out[oo + 3] = ny;
          }
        }
        seen++;
      }
      filled += picked;
    };

    // Take a guaranteed sample from tiles first, then from the scene.
    sampleInto(b, bCount, wantB);
    sampleInto(a, aCount, wantA);

    if (filled < 1) return null;
    return out.subarray(0, filled * 4);
  }

  _collectTilePointSetsInView(kind, u0, u1, v0, v1) {
    const out = [];
    if (!this._tileWaterFoamCache || this._tileWaterFoamCache.size < 1) return out;

    // Expand view slightly so we keep stable spawn as the camera moves.
    const padU = 0.02;
    const padV = 0.02;
    const U0 = (u0 ?? 0) - padU;
    const U1 = (u1 ?? 1) + padU;
    const V0 = (v0 ?? 0) - padV;
    const V1 = (v1 ?? 1) + padV;

    for (const entry of this._tileWaterFoamCache.values()) {
      if (!entry) continue;
      const b = entry.sceneUvBounds;
      if (!b) continue;
      if (b.u1 < U0 || b.u0 > U1 || b.v1 < V0 || b.v0 > V1) continue;

      const pts = (kind === 'edge') ? entry.edgePts : (kind === 'interior' ? entry.interiorPts : entry.hardPts);
      if (!pts) continue;
      if (kind === 'edge') {
        if (pts.length >= 4) out.push(pts);
      } else {
        if (pts.length >= 2) out.push(pts);
      }
    }
    return out;
  }

  _generateTileLocalWaterInteriorPoints(maskTexture, tileAlphaMask = null, threshold = 0.15, stride = 6, maxPoints = 8000) {
    const entry = this._getMaskPixelData(maskTexture);
    if (!entry) return null;
    const w = entry.width;
    const h = entry.height;
    const data = entry.data;

    const sampleAlpha = (uLocal, vLocal) => {
      if (!tileAlphaMask || !tileAlphaMask.data) return 1.0;
      const aw = tileAlphaMask.width;
      const ah = tileAlphaMask.height;
      if (!aw || !ah) return 1.0;
      const ax = Math.max(0, Math.min(aw - 1, Math.floor(uLocal * (aw - 1))));
      const ay = Math.max(0, Math.min(ah - 1, Math.floor(vLocal * (ah - 1))));
      const ai = (ay * aw + ax) * 4;
      return tileAlphaMask.data[ai + 3] / 255;
    };

    // Reservoir sampling so capped interior points represent the full tile mask.
    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 2);
    let filled = 0;
    let seen = 0;

    const s = Math.max(1, stride | 0);
    const sample = (x, y) => {
      const uLocal = x / w;
      const vLocal = y / h;
      const aTile = sampleAlpha(uLocal, vLocal);
      return this._tileMaskSampleLumaA(data, w, x, y) * aTile;
    };

    // Interior = water pixel with all 4 neighbors also water.
    for (let y = 1; y < h - 1; y += s) {
      for (let x = 1; x < w - 1; x += s) {
        const r = sample(x, y);
        if (r < threshold) continue;
        if (sample(x - 1, y) < threshold) continue;
        if (sample(x + 1, y) < threshold) continue;
        if (sample(x, y - 1) < threshold) continue;
        if (sample(x, y + 1) < threshold) continue;

        const u = x / w;
        const v = y / h;
        if (filled < max) {
          const o = filled * 2;
          out[o] = u;
          out[o + 1] = v;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < max) {
            const o = j * 2;
            out[o] = u;
            out[o + 1] = v;
          }
        }
        seen++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }

  _generateWaterEdgePoints(maskTexture, threshold = 0.15, stride = 2, maxPoints = 16000, flipV = false) {
    const entry = this._getMaskPixelData(maskTexture);
    if (!entry) return null;
    const w = entry.width;
    const h = entry.height;
    const data = entry.data;
    const yToImg = (yy) => (flipV ? (h - 1 - yy) : yy);

    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 4);
    let filled = 0;
    let seen = 0;

    const s = Math.max(1, stride | 0);
    const sample = (x, yScene) => {
      const yImg = yToImg(yScene);
      const ix = (yImg * w + x) * 4;
      const r = data[ix] / 255;
      const g = data[ix + 1] / 255;
      const b = data[ix + 2] / 255;
      const a = data[ix + 3] / 255;
      return (0.299 * r + 0.587 * g + 0.114 * b) * a;
    };

    for (let y = 1; y < h - 1; y += s) {
      for (let x = 1; x < w - 1; x += s) {
        const c0 = sample(x, y);
        if (c0 < threshold) continue;

        const rl = sample(x - 1, y);
        const rr = sample(x + 1, y);
        const ru = sample(x, y - 1);
        const rd = sample(x, y + 1);
        const isEdge = (rl < threshold) || (rr < threshold) || (ru < threshold) || (rd < threshold);
        if (!isEdge) continue;

        // Gradient points from dark->bright. Convert mask Y-down to world Y-up by flipping ny.
        let nx = rr - rl;
        let ny = -(rd - ru);
        const len = Math.sqrt(nx * nx + ny * ny);
        if (len > 1e-6) {
          nx /= len;
          ny /= len;
        } else {
          nx = 1.0;
          ny = 0.0;
        }

        const u = x / w;
        const v = y / h;
        if (filled < max) {
          const o = filled * 4;
          out[o] = u;
          out[o + 1] = v;
          out[o + 2] = nx;
          out[o + 3] = ny;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < max) {
            const o = j * 4;
            out[o] = u;
            out[o + 1] = v;
            out[o + 2] = nx;
            out[o + 3] = ny;
          }
        }
        seen++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 4);
  }

  _refreshTileFoamPoints(tileManager) {
    let anyTileChanged = false;

    // Even when we can't rebuild point sets (missing tileManager/bounds/canvas), we must
    // still prune stale cache entries. Otherwise removed tiles can keep contributing.
    if (!tileManager || !tileManager.tileSprites) {
      try {
        if (this._tileWaterFoamCache && this._tileWaterFoamCache.size > 0) {
          this._tileWaterFoamCache.clear();
          anyTileChanged = true;
        }
      } catch (_) {
      }

      this._tileWaterFoamMergedPts = null;
      this._tileShoreFoamMergedPts = null;
      this._tileWaterInteriorMergedPts = null;

      if (anyTileChanged) {
        this._tileFoamRevision = (this._tileFoamRevision | 0) + 1;
        this._waterFoamLastViewQU0 = null;
        this._waterFoamLastViewQU1 = null;
        this._waterFoamLastViewQV0 = null;
        this._waterFoamLastViewQV1 = null;
        this._shoreFoamLastViewQU0 = null;
        this._shoreFoamLastViewQU1 = null;
        this._shoreFoamLastViewQV0 = null;
        this._shoreFoamLastViewQV1 = null;
      }
      return;
    }

    // Prune deleted tiles up-front so we don't keep using stale per-tile points.
    try {
      if (this._tileWaterFoamCache && this._tileWaterFoamCache.size > 0) {
        const toDelete = [];
        for (const id of this._tileWaterFoamCache.keys()) {
          if (!tileManager.tileSprites.has(id)) toDelete.push(id);
        }
        if (toDelete.length > 0) {
          for (const id of toDelete) this._tileWaterFoamCache.delete(id);
          anyTileChanged = true;
        }
      }
    } catch (_) {
    }

    const bounds = this._sceneBounds;
    if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.z <= 1e-6 || bounds.w <= 1e-6) {
      this._tileWaterFoamMergedPts = null;
      this._tileShoreFoamMergedPts = null;
      this._tileWaterInteriorMergedPts = null;

      if (anyTileChanged) {
        this._tileFoamRevision = (this._tileFoamRevision | 0) + 1;
        this._waterFoamLastViewQU0 = null;
        this._waterFoamLastViewQU1 = null;
        this._waterFoamLastViewQV0 = null;
        this._waterFoamLastViewQV1 = null;
        this._shoreFoamLastViewQU0 = null;
        this._shoreFoamLastViewQU1 = null;
        this._shoreFoamLastViewQV0 = null;
        this._shoreFoamLastViewQV1 = null;
      }
      return;
    }

    const totalH = (typeof canvas !== 'undefined' && canvas?.dimensions?.height) ? canvas.dimensions.height : null;
    if (!Number.isFinite(totalH) || totalH <= 0) {
      this._tileWaterFoamMergedPts = null;
      this._tileShoreFoamMergedPts = null;
      this._tileWaterInteriorMergedPts = null;

      if (anyTileChanged) {
        this._tileFoamRevision = (this._tileFoamRevision | 0) + 1;
        this._waterFoamLastViewQU0 = null;
        this._waterFoamLastViewQU1 = null;
        this._waterFoamLastViewQV0 = null;
        this._waterFoamLastViewQV1 = null;
        this._shoreFoamLastViewQU0 = null;
        this._shoreFoamLastViewQU1 = null;
        this._shoreFoamLastViewQV0 = null;
        this._shoreFoamLastViewQV1 = null;
      }
      return;
    }

    const tileHardSets = [];
    const tileEdgeSets = [];
    const tileInteriorSets = [];

    const debug = !!(this._waterParams && this._waterParams.debugTileFoamPoints);

    for (const [tileId, spriteData] of tileManager.tileSprites.entries()) {
      const tileDoc = spriteData?.tileDoc;
      const sprite = spriteData?.sprite;
      if (!tileDoc || !sprite) continue;

      // Consider ANY tile that has (or can load) a per-tile _Water mask.
      // Don't depend on waterOccluderMesh because many tiles (boats/decals) may carry
      // a _Water mask intended for spawn locations without being treated as an occluder.
      let maskTex = sprite.userData?.tileWaterMaskTexture ?? null;
      if (!maskTex) {
        const occ = sprite.userData?.waterOccluderMesh;
        maskTex = occ?.material?.uniforms?.tWaterMask?.value ?? null;
      }
      let img = maskTex?.image;

      // If we don't have a ready texture yet, kick an async load and skip for now.
      if (!maskTex || !img) {
        const src = tileDoc?.texture?.src ?? '';
        const requestKey = `${tileId}|${src}`;
        if (sprite.userData?._msTileWaterMaskRequestKey !== requestKey) {
          sprite.userData._msTileWaterMaskRequestKey = requestKey;
          try {
            const p = tileManager.loadTileWaterMaskTexture(tileDoc);
            if (p && typeof p.then === 'function') {
              p.then((tex) => {
                if (!tex) return;
                // Tile could have been removed or changed while awaiting.
                const current = tileManager.tileSprites.get(tileId);
                const s = current?.sprite;
                if (!s || s !== sprite) return;
                if (s.userData?._msTileWaterMaskRequestKey !== requestKey) return;
                s.userData.tileWaterMaskTexture = tex;
              }).catch(() => {
              });
            }
          } catch (_) {
          }
        }
        if (debug) {
          try {
            console.debug('[MapShine][Foam] tile skipped (mask not ready)', {
              tileId,
              src,
              hasOcc: !!sprite.userData?.waterOccluderMesh,
              hasCached: !!sprite.userData?.tileWaterMaskTexture
            });
          } catch (_) {
          }
        }
        continue;
      }

      // If the tile texture has transparency, respect it so we don't generate spawn points
      // in invisible parts of the tile (non-rectangular boats, alpha-cutout water decals, etc.).
      const tileTex = sprite.material?.map ?? null;
      const tileImg = tileTex?.image ?? null;
      let tileAlphaMask = null;
      if (tileTex && tileImg && tileManager?.alphaMaskCache) {
        const _stableAlphaKey = (src) => {
          try {
            const s = String(src || '');
            if (!s) return '';
            const q = s.indexOf('?');
            return q >= 0 ? s.slice(0, q) : s;
          } catch (_) {
            return '';
          }
        };
        const stableSrc = _stableAlphaKey(tileImg.src);
        const key = stableSrc || tileImg.src || tileDoc.id;
        tileAlphaMask = tileManager.alphaMaskCache.get(key) || null;
        if (!tileAlphaMask) {
          try {
            const canvasEl = document.createElement('canvas');
            canvasEl.width = tileImg.width;
            canvasEl.height = tileImg.height;
            const ctx = canvasEl.getContext('2d');
            if (ctx) {
              ctx.drawImage(tileImg, 0, 0);
              const imgData = ctx.getImageData(0, 0, tileImg.width, tileImg.height);
              tileAlphaMask = { width: tileImg.width, height: tileImg.height, data: imgData.data };
              tileManager.alphaMaskCache.set(key, tileAlphaMask);
            }
          } catch (_) {
            tileAlphaMask = null;
          }
        }
      }

      // Use the live THREE sprite transform for movement responsiveness.
      // During interactive drag, Foundry may refresh the tile display before
      // committing document changes.
      const wPx = (sprite.scale && Number.isFinite(sprite.scale.x)) ? sprite.scale.x : tileDoc.width;
      const hPx = (sprite.scale && Number.isFinite(sprite.scale.y)) ? sprite.scale.y : tileDoc.height;

      const centerX = Number.isFinite(sprite.position?.x) ? sprite.position.x : (tileDoc.x + tileDoc.width * 0.5);
      const centerYFoundry = Number.isFinite(sprite.position?.y)
        ? (totalH - sprite.position.y)
        : (tileDoc.y + tileDoc.height * 0.5);

      const xFoundry = centerX - wPx * 0.5;
      const yFoundry = centerYFoundry - hPx * 0.5;

      let rotDeg = Number.isFinite(tileDoc.rotation) ? tileDoc.rotation : 0;
      const rRad = sprite.material?.rotation;
      if (Number.isFinite(rRad)) {
        rotDeg = (rRad * 180) / Math.PI;
      }

      const liveTile = {
        x: xFoundry,
        y: yFoundry,
        width: wPx,
        height: hPx,
        rotation: rotDeg
      };

      // Split cache into:
      // - scanKey: changes only when the mask texture or sampling params change
      // - transformKey: changes when the tile moves/resizes/rotates
      // Use stable, URL-based keys instead of THREE Texture UUIDs.
      // UUIDs change when textures are recreated (scene reset, reload), causing unnecessary rescans.
      const _stripQuery = (src) => {
        try {
          const s = String(src || '');
          if (!s) return '';
          const q = s.indexOf('?');
          return q >= 0 ? s.slice(0, q) : s;
        } catch (_) {
          return '';
        }
      };
      const maskKey = _stripQuery(maskTex?.image?.src || maskTex?.source?.data?.src || maskTex?.userData?.src || '') || (maskTex?.name || '');
      const tileKey = _stripQuery(tileImg?.src || '') || tileDoc.id;
      const scanKey = `${maskKey}|${tileKey}|${this._waterMaskThreshold}|${this._waterMaskStride}`;
      const transformKey = `${xFoundry}|${yFoundry}|${wPx}|${hPx}|${rotDeg}|${bounds.x}|${bounds.y}|${bounds.z}|${bounds.w}|${totalH}`;

      let entry = this._tileWaterFoamCache.get(tileId);
      if (!entry) {
        entry = {
          scanKey: null,
          transformKey: null,
          localHardPts: null,
          localEdgePts: null,
          localInteriorPts: null,
          hardPts: null,
          edgePts: null,
          interiorPts: null,
          sceneUvBounds: null
        };
        this._tileWaterFoamCache.set(tileId, entry);
      }

      // Backfill older cache entries created before we introduced `sceneUvBounds`.
      if (!Object.prototype.hasOwnProperty.call(entry, 'sceneUvBounds')) {
        entry.sceneUvBounds = null;
        anyTileChanged = true;
      }

      // Re-scan mask pixels ONLY when the mask/params change.
      if (entry.scanKey !== scanKey) {
        entry.scanKey = scanKey;
        entry.localHardPts = this._generateTileLocalWaterHardEdgePoints(maskTex, tileAlphaMask, this._waterMaskThreshold, this._waterMaskStride, 24000);
        entry.localEdgePts = this._generateTileLocalWaterEdgePoints(maskTex, tileAlphaMask, this._waterMaskThreshold, Math.max(1, Math.floor(this._waterMaskStride * 0.5)), 16000);
        entry.localInteriorPts = this._generateTileLocalWaterInteriorPoints(maskTex, tileAlphaMask, this._waterMaskThreshold, Math.max(1, Math.floor(this._waterMaskStride * 2.0)), 8000);
        entry.transformKey = null; // force transform refresh
        anyTileChanged = true;

        if (debug) {
          try {
            console.debug('[MapShine][Foam] tile scan rebuilt', {
              tileId,
              hard: entry.localHardPts ? (entry.localHardPts.length / 2) : 0,
              edge: entry.localEdgePts ? (entry.localEdgePts.length / 4) : 0,
              interior: entry.localInteriorPts ? (entry.localInteriorPts.length / 2) : 0
            });
          } catch (_) {
          }
        }
      }

      // Re-transform cached local points whenever the tile moves/resizes/rotates.
      if (entry.transformKey !== transformKey) {
        entry.transformKey = transformKey;
        entry.hardPts = this._transformTileLocalUvPointsToSceneUv(entry.localHardPts, liveTile, bounds, totalH);
        entry.edgePts = this._transformTileLocalEdgePointsToSceneUv(entry.localEdgePts, liveTile, bounds, totalH);
        entry.interiorPts = this._transformTileLocalUvPointsToSceneUv(entry.localInteriorPts, liveTile, bounds, totalH);
        anyTileChanged = true;
      }

      // Cache a cheap axis-aligned scene-UV bounds for quick view intersection tests.
      // NOTE: This intentionally ignores rotation; it's only used as a conservative
      // inclusion test for whether the tile is near the camera view.
      // Also compute this for older cache entries after hot reloads.
      if (!entry.sceneUvBounds) {
        try {
          const fx0 = liveTile.x;
          const fy0 = liveTile.y;
          const fx1 = liveTile.x + liveTile.width;
          const fy1 = liveTile.y + liveTile.height;

          const wx0 = fx0;
          const wy0 = totalH - fy0;
          const wx1 = fx1;
          const wy1 = totalH - fy1;

          const uA = (wx0 - bounds.x) / bounds.z;
          const vA = 1.0 - ((wy0 - bounds.y) / bounds.w);
          const uB = (wx1 - bounds.x) / bounds.z;
          const vB = 1.0 - ((wy1 - bounds.y) / bounds.w);

          const u0 = Math.min(uA, uB);
          const u1 = Math.max(uA, uB);
          const v0 = Math.min(vA, vB);
          const v1 = Math.max(vA, vB);
          entry.sceneUvBounds = { u0, u1, v0, v1 };
        } catch (_) {
          entry.sceneUvBounds = null;
        }
      }

      if (entry.hardPts && entry.hardPts.length >= 2) tileHardSets.push(entry.hardPts);
      if (entry.edgePts && entry.edgePts.length >= 4) tileEdgeSets.push(entry.edgePts);
      if (entry.interiorPts && entry.interiorPts.length >= 2) tileInteriorSets.push(entry.interiorPts);
    }

    this._tileWaterFoamMergedPts = this._mergeManyUvPointSets(tileHardSets, 24000);
    this._tileShoreFoamMergedPts = this._mergeManyEdgePointSets(tileEdgeSets, 16000);
    this._tileWaterInteriorMergedPts = this._mergeManyUvPointSets(tileInteriorSets, 8000);

    if (anyTileChanged) {
      this._tileFoamRevision = (this._tileFoamRevision | 0) + 1;
    }

    // IMPORTANT: if tile-derived point sets change but the camera doesn't move,
    // our view-filter cache (quantized by view rect) must be invalidated or we
    // will keep returning stale filtered points until the next pan/zoom.
    if (anyTileChanged) {
      this._waterFoamLastViewQU0 = null;
      this._waterFoamLastViewQU1 = null;
      this._waterFoamLastViewQV0 = null;
      this._waterFoamLastViewQV1 = null;

      this._shoreFoamLastViewQU0 = null;
      this._shoreFoamLastViewQU1 = null;
      this._shoreFoamLastViewQV0 = null;
      this._shoreFoamLastViewQV1 = null;
    }
  }

  _mergeManyUvPointSets(sets, maxPoints = 24000) {
    if (!sets || sets.length < 1) return null;
    if (sets.length === 1) return sets[0];

    // Reservoir sample across all sets.
    // IMPORTANT: ensure each set contributes *some* points when possible.
    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 2);
    let filled = 0;
    let seen = 0;

    const minPerSet = 32;
    // First pass: guaranteed small quota per set.
    for (const s of sets) {
      if (!s || s.length < 2 || filled >= max) continue;
      const count = Math.floor(s.length / 2);
      const take = Math.min(count, minPerSet, max - filled);
      if (take <= 0) continue;

      if (take >= count) {
        for (let i = 0; i < count && filled < max; i++) {
          const o = i * 2;
          const oo = filled * 2;
          out[oo] = s[o];
          out[oo + 1] = s[o + 1];
          filled++;
        }
      } else {
        // Reservoir sample from this set directly into the output buffer.
        const start = filled;
        let picked = 0;
        let tSeen = 0;
        for (let i = 0; i < count; i++) {
          const o = i * 2;
          const u = s[o];
          const v = s[o + 1];
          if (picked < take) {
            const oo = (start + picked) * 2;
            out[oo] = u;
            out[oo + 1] = v;
            picked++;
          } else {
            const j = Math.floor(Math.random() * (tSeen + 1));
            if (j < take) {
              const oo = (start + j) * 2;
              out[oo] = u;
              out[oo + 1] = v;
            }
          }
          tSeen++;
        }
        filled += picked;
      }
    }

    for (const s of sets) {
      if (!s || s.length < 2) continue;
      const count = Math.floor(s.length / 2);
      for (let i = 0; i < count; i++) {
        const o = i * 2;
        const u = s[o];
        const v = s[o + 1];
        if (filled < max) {
          const outO = filled * 2;
          out[outO] = u;
          out[outO + 1] = v;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < max) {
            const outO = j * 2;
            out[outO] = u;
            out[outO + 1] = v;
          }
        }
        seen++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }

  _mergeManyEdgePointSets(sets, maxPoints = 16000) {
    if (!sets || sets.length < 1) return null;
    if (sets.length === 1) return sets[0];

    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 4);
    let filled = 0;
    let seen = 0;

    const minPerSet = 32;
    // First pass: guaranteed small quota per set.
    for (const s of sets) {
      if (!s || s.length < 4 || filled >= max) continue;
      const count = Math.floor(s.length / 4);
      const take = Math.min(count, minPerSet, max - filled);
      if (take <= 0) continue;

      if (take >= count) {
        for (let i = 0; i < count && filled < max; i++) {
          const o = i * 4;
          const oo = filled * 4;
          out[oo] = s[o];
          out[oo + 1] = s[o + 1];
          out[oo + 2] = s[o + 2];
          out[oo + 3] = s[o + 3];
          filled++;
        }
      } else {
        // Reservoir sample from this set directly into the output buffer.
        const start = filled;
        let picked = 0;
        let tSeen = 0;
        for (let i = 0; i < count; i++) {
          const o = i * 4;
          const u = s[o];
          const v = s[o + 1];
          const nx = s[o + 2];
          const ny = s[o + 3];
          if (picked < take) {
            const oo = (start + picked) * 4;
            out[oo] = u;
            out[oo + 1] = v;
            out[oo + 2] = nx;
            out[oo + 3] = ny;
            picked++;
          } else {
            const j = Math.floor(Math.random() * (tSeen + 1));
            if (j < take) {
              const oo = (start + j) * 4;
              out[oo] = u;
              out[oo + 1] = v;
              out[oo + 2] = nx;
              out[oo + 3] = ny;
            }
          }
          tSeen++;
        }
        filled += picked;
      }
    }

    for (const s of sets) {
      if (!s || s.length < 4) continue;
      const count = Math.floor(s.length / 4);
      for (let i = 0; i < count; i++) {
        const o = i * 4;
        const u = s[o];
        const v = s[o + 1];
        const nx = s[o + 2];
        const ny = s[o + 3];
        if (filled < max) {
          const outO = filled * 4;
          out[outO] = u;
          out[outO + 1] = v;
          out[outO + 2] = nx;
          out[outO + 3] = ny;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < max) {
            const outO = j * 4;
            out[outO] = u;
            out[outO + 1] = v;
            out[outO + 2] = nx;
            out[outO + 3] = ny;
          }
        }
        seen++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 4);
  }

  _tileMaskSampleLumaA(data, w, x, y) {
    const ix = (y * w + x) * 4;
    const r = data[ix] / 255;
    const g = data[ix + 1] / 255;
    const b = data[ix + 2] / 255;
    const a = data[ix + 3] / 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) * a;
  }

  _tileLocalUvToSceneUv(u, v, tileDoc, sceneBounds, totalH) {
    // Local tile UV -> Foundry coords (Y-down)
    const fx0 = tileDoc.x + u * tileDoc.width;
    const fy0 = tileDoc.y + v * tileDoc.height;

    // Apply tile rotation about its center in Foundry coords.
    const rotDeg = Number.isFinite(tileDoc.rotation) ? tileDoc.rotation : 0;
    let fx = fx0;
    let fy = fy0;
    if (Math.abs(rotDeg) > 1e-5) {
      const rad = (rotDeg * Math.PI) / 180;
      const cx = tileDoc.x + tileDoc.width * 0.5;
      const cy = tileDoc.y + tileDoc.height * 0.5;
      const dx = fx0 - cx;
      const dy = fy0 - cy;
      const c = Math.cos(rad);
      const s = Math.sin(rad);
      fx = cx + dx * c - dy * s;
      fy = cy + dx * s + dy * c;
    }

    // Foundry (Y-down) -> world (Y-up)
    const wx = fx;
    const wy = totalH - fy;

    // World -> scene UV (v top->bottom)
    const su = (wx - sceneBounds.x) / sceneBounds.z;
    const sv = 1.0 - ((wy - sceneBounds.y) / sceneBounds.w);
    return [su, sv];
  }

  _rotateWorldNormal(nx, ny, tileDoc) {
    const rotDeg = Number.isFinite(tileDoc.rotation) ? tileDoc.rotation : 0;
    if (Math.abs(rotDeg) <= 1e-5) return [nx, ny];
    const rad = (rotDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return [nx * c - ny * s, nx * s + ny * c];
  }

  _transformTileLocalUvPointsToSceneUv(localPts, tileDoc, sceneBounds, totalH) {
    if (!localPts || localPts.length < 2) return null;
    const count = Math.floor(localPts.length / 2);
    const out = new Float32Array(count * 2);
    let filled = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 2;
      const uLocal = localPts[o];
      const vLocal = localPts[o + 1];
      const [su, sv] = this._tileLocalUvToSceneUv(uLocal, vLocal, tileDoc, sceneBounds, totalH);
      if (su < 0.0 || su > 1.0 || sv < 0.0 || sv > 1.0) continue;
      const oo = filled * 2;
      out[oo] = su;
      out[oo + 1] = sv;
      filled++;
    }
    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }

  _transformTileLocalEdgePointsToSceneUv(localPts, tileDoc, sceneBounds, totalH) {
    if (!localPts || localPts.length < 4) return null;
    const count = Math.floor(localPts.length / 4);
    const out = new Float32Array(count * 4);
    let filled = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 4;
      const uLocal = localPts[o];
      const vLocal = localPts[o + 1];
      let nx = localPts[o + 2];
      let ny = localPts[o + 3];

      const [su, sv] = this._tileLocalUvToSceneUv(uLocal, vLocal, tileDoc, sceneBounds, totalH);
      if (su < 0.0 || su > 1.0 || sv < 0.0 || sv > 1.0) continue;

      const rN = this._rotateWorldNormal(nx, ny, tileDoc);
      nx = rN[0];
      ny = rN[1];

      const oo = filled * 4;
      out[oo] = su;
      out[oo + 1] = sv;
      out[oo + 2] = nx;
      out[oo + 3] = ny;
      filled++;
    }
    if (filled < 1) return null;
    return out.subarray(0, filled * 4);
  }

  _generateTileLocalWaterHardEdgePoints(maskTexture, tileAlphaMask = null, edgeThreshold = 0.5, stride = 2, maxPoints = 12000) {
    const entry = this._getMaskPixelData(maskTexture);
    if (!entry) return null;
    const w = entry.width;
    const h = entry.height;
    const data = entry.data;

    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 2);
    let filled = 0;
    let eligible = 0;

    const s = Math.max(1, stride | 0);
    const sampleAlpha = (uLocal, vLocal) => {
      if (!tileAlphaMask || !tileAlphaMask.data) return 1.0;
      const aw = tileAlphaMask.width;
      const ah = tileAlphaMask.height;
      if (!aw || !ah) return 1.0;
      const ax = Math.max(0, Math.min(aw - 1, Math.floor(uLocal * (aw - 1))));
      const ay = Math.max(0, Math.min(ah - 1, Math.floor(vLocal * (ah - 1))));
      const ai = (ay * aw + ax) * 4;
      return tileAlphaMask.data[ai + 3] / 255;
    };
    const sample = (x, y) => {
      const uLocal = x / w;
      const vLocal = y / h;
      const aTile = sampleAlpha(uLocal, vLocal);
      return this._tileMaskSampleLumaA(data, w, x, y) * aTile;
    };

    for (let y = 1; y < h - 1; y += s) {
      for (let x = 1; x < w - 1; x += s) {
        const v = sample(x, y);
        if (v < edgeThreshold) continue;

        const left = sample(x - 1, y);
        const right = sample(x + 1, y);
        const up = sample(x, y - 1);
        const down = sample(x, y + 1);
        const isBoundary = (left < edgeThreshold) || (right < edgeThreshold) || (up < edgeThreshold) || (down < edgeThreshold);
        if (!isBoundary) continue;

        const uLocal = x / w;
        const vLocal = y / h;

        if (filled < max) {
          const o = filled * 2;
          out[o] = uLocal;
          out[o + 1] = vLocal;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (eligible + 1));
          if (j < max) {
            const o = j * 2;
            out[o] = uLocal;
            out[o + 1] = vLocal;
          }
        }
        eligible++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }

  _generateTileLocalWaterEdgePoints(maskTexture, tileAlphaMask = null, threshold = 0.15, stride = 2, maxPoints = 8000) {
    const entry = this._getMaskPixelData(maskTexture);
    if (!entry) return null;
    const w = entry.width;
    const h = entry.height;
    const data = entry.data;

    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 4);
    let filled = 0;
    let seen = 0;

    const s = Math.max(1, stride | 0);
    const sampleAlpha = (uLocal, vLocal) => {
      if (!tileAlphaMask || !tileAlphaMask.data) return 1.0;
      const aw = tileAlphaMask.width;
      const ah = tileAlphaMask.height;
      if (!aw || !ah) return 1.0;
      const ax = Math.max(0, Math.min(aw - 1, Math.floor(uLocal * (aw - 1))));
      const ay = Math.max(0, Math.min(ah - 1, Math.floor(vLocal * (ah - 1))));
      const ai = (ay * aw + ax) * 4;
      return tileAlphaMask.data[ai + 3] / 255;
    };
    const sample = (x, y) => {
      const uLocal = x / w;
      const vLocal = y / h;
      const aTile = sampleAlpha(uLocal, vLocal);
      return this._tileMaskSampleLumaA(data, w, x, y) * aTile;
    };

    for (let y = 1; y < h - 1; y += s) {
      for (let x = 1; x < w - 1; x += s) {
        const c0 = sample(x, y);
        if (c0 < threshold) continue;

        const rl = sample(x - 1, y);
        const rr = sample(x + 1, y);
        const ru = sample(x, y - 1);
        const rd = sample(x, y + 1);
        const isEdge = (rl < threshold) || (rr < threshold) || (ru < threshold) || (rd < threshold);
        if (!isEdge) continue;

        // Gradient points from dark->bright. Convert mask Y-down to world Y-up by flipping ny.
        let nx = rr - rl;
        let ny = -(rd - ru);
        const len = Math.sqrt(nx * nx + ny * ny);
        if (len > 1e-6) {
          nx /= len;
          ny /= len;
        } else {
          nx = 1.0;
          ny = 0.0;
        }

        const uLocal = x / w;
        const vLocal = y / h;

        if (filled < max) {
          const o = filled * 4;
          out[o] = uLocal;
          out[o + 1] = vLocal;
          out[o + 2] = nx;
          out[o + 3] = ny;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < max) {
            const o = j * 4;
            out[o] = uLocal;
            out[o + 1] = vLocal;
            out[o + 2] = nx;
            out[o + 3] = ny;
          }
        }
        seen++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 4);
  }

  _getViewFilteredWaterFoamPoints() {
    const pts = this._waterFoamPoints;
    if (!pts || pts.length < 2) return null;

    const minX = this._viewMinX;
    const maxX = this._viewMaxX;
    const minY = this._viewMinY;
    const maxY = this._viewMaxY;
    const sceneX = this._viewSceneX;
    const sceneY = this._viewSceneY;
    const sceneW = this._viewSceneW;
    const sceneH = this._viewSceneH;

    if (
      !Number.isFinite(minX) || !Number.isFinite(maxX) ||
      !Number.isFinite(minY) || !Number.isFinite(maxY) ||
      !Number.isFinite(sceneX) || !Number.isFinite(sceneY) ||
      !Number.isFinite(sceneW) || !Number.isFinite(sceneH) ||
      sceneW <= 1e-6 || sceneH <= 1e-6
    ) {
      return null;
    }

    // Convert the visible WORLD rect (Y-up) to mask UVs (u: left->right, v: top->bottom).
    let u0 = (minX - sceneX) / sceneW;
    let u1 = (maxX - sceneX) / sceneW;
    const vTop = 1.0 - ((maxY - sceneY) / sceneH);
    const vBottom = 1.0 - ((minY - sceneY) / sceneH);
    let v0 = Math.min(vTop, vBottom);
    let v1 = Math.max(vTop, vBottom);

    // Clamp to texture UV range.
    u0 = Math.max(0.0, Math.min(1.0, u0));
    u1 = Math.max(0.0, Math.min(1.0, u1));
    v0 = Math.max(0.0, Math.min(1.0, v0));
    v1 = Math.max(0.0, Math.min(1.0, v1));

    // Quantize to avoid re-filtering every single frame for tiny camera drift.
    const q = 256;
    const qU0 = Math.floor(u0 * q);
    const qU1 = Math.floor(u1 * q);
    const qV0 = Math.floor(v0 * q);
    const qV1 = Math.floor(v1 * q);
    if (
      qU0 === this._waterFoamLastViewQU0 &&
      qU1 === this._waterFoamLastViewQU1 &&
      qV0 === this._waterFoamLastViewQV0 &&
      qV1 === this._waterFoamLastViewQV1
    ) {
      return (this._waterFoamViewBuffer && this._waterFoamViewCount > 0)
        ? this._waterFoamViewBuffer.subarray(0, this._waterFoamViewCount * 2)
        : null;
    }
    this._waterFoamLastViewQU0 = qU0;
    this._waterFoamLastViewQU1 = qU1;
    this._waterFoamLastViewQV0 = qV0;
    this._waterFoamLastViewQV1 = qV1;

    const maxPoints = Math.max(1, Math.min(this._waterMaskMaxPoints, 24000) | 0);
    if (!this._waterFoamViewBuffer || this._waterFoamViewBuffer.length < maxPoints * 2) {
      this._waterFoamViewBuffer = new Float32Array(maxPoints * 2);
    }

    const count = Math.floor(pts.length / 2);
    let filled = 0;
    let eligible = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 2;
      const u = pts[o];
      const v = pts[o + 1];
      if (u < u0 || u > u1 || v < v0 || v > v1) continue;

      if (filled < maxPoints) {
        const outO = filled * 2;
        this._waterFoamViewBuffer[outO] = u;
        this._waterFoamViewBuffer[outO + 1] = v;
        filled++;
      } else {
        const j = Math.floor(Math.random() * (eligible + 1));
        if (j < maxPoints) {
          const outO = j * 2;
          this._waterFoamViewBuffer[outO] = u;
          this._waterFoamViewBuffer[outO + 1] = v;
        }
      }
      eligible++;
    }

    this._waterFoamViewCount = filled;
    return filled > 0 ? this._waterFoamViewBuffer.subarray(0, filled * 2) : null;
  }

  _generateWaterSplashPoints(maskTexture, threshold = 0.15, stride = 2, maxPoints = 20000, flipV = false) {
    const entry = this._getMaskPixelData(maskTexture);
    if (!entry) return null;
    const w = entry.width;
    const h = entry.height;
    const data = entry.data;

    const yToImg = (yy) => (flipV ? (h - 1 - yy) : yy);

    // Reservoir sampling so the point cloud isn't biased towards the top-left
    // of the image when we cap at maxPoints.
    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 2);
    let filled = 0;
    let seen = 0;

    const s = Math.max(1, stride | 0);
    for (let y = 0; y < h; y += s) {
      const row = yToImg(y) * w;
      for (let x = 0; x < w; x += s) {
        const i = (row + x) * 4;
        const r = data[i] / 255;
        if (r < threshold) continue;

        const u = x / w;
        const v = y / h;
        if (filled < max) {
          const o = filled * 2;
          out[o] = u;
          out[o + 1] = v;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < max) {
            const o = j * 2;
            out[o] = u;
            out[o + 1] = v;
          }
        }
        seen++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }

  _generateSimpleFoamPoints(maskTexture, threshold = 0.5, stride = 4, maxPoints = 20000, flipV = false) {
    const entry = this._getMaskPixelData(maskTexture);
    if (!entry) return null;
    const w = entry.width;
    const h = entry.height;
    const data = entry.data;
    const yToImg = (yy) => (flipV ? (h - 1 - yy) : yy);

    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 2);
    let filled = 0;
    let seen = 0;

    const s = Math.max(1, stride | 0);
    for (let y = 0; y < h; y += s) {
      const row = yToImg(y) * w;
      for (let x = 0; x < w; x += s) {
        const i = (row + x) * 4;
        const r = data[i] / 255;
        if (r < threshold) continue;

        const u = x / w;
        const v = y / h;
        if (filled < max) {
          const o = filled * 2;
          out[o] = u;
          out[o + 1] = v;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < max) {
            const o = j * 2;
            out[o] = u;
            out[o + 1] = v;
          }
        }
        seen++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }

  _generateWaterInteriorPoints(maskTexture, threshold = 0.15, stride = 6, maxPoints = 8000, flipV = false) {
    const entry = this._getMaskPixelData(maskTexture);
    if (!entry) return null;
    const w = entry.width;
    const h = entry.height;
    const data = entry.data;

    // Reservoir sampling so capped interior points represent the full mask.
    const max = Math.max(1, maxPoints | 0);
    const out = new Float32Array(max * 2);
    let filled = 0;
    let seen = 0;

    const s = Math.max(1, stride | 0);
    const sample = (x, y) => {
      const yy = flipV ? (h - 1 - y) : y;
      const ix = (yy * w + x) * 4;
      return data[ix] / 255;
    };

    // Interior = water pixel with all 4 neighbors also water.
    for (let y = 1; y < h - 1; y += s) {
      for (let x = 1; x < w - 1; x += s) {
        const r = sample(x, y);
        if (r < threshold) continue;
        if (sample(x - 1, y) < threshold) continue;
        if (sample(x + 1, y) < threshold) continue;
        if (sample(x, y - 1) < threshold) continue;
        if (sample(x, y + 1) < threshold) continue;

        const u = x / w;
        const v = y / h;
        if (filled < max) {
          const o = filled * 2;
          out[o] = u;
          out[o + 1] = v;
          filled++;
        } else {
          const j = Math.floor(Math.random() * (seen + 1));
          if (j < max) {
            const o = j * 2;
            out[o] = u;
            out[o + 1] = v;
          }
        }
        seen++;
      }
    }

    if (filled < 1) return null;
    return out.subarray(0, filled * 2);
  }
}
