/**
 * @fileoverview Pre-bakes directional shadow lit-factor textures per compass sector.
 */

import { createLogger } from '../../core/log.js';
import {
  applyShadowBakeOverride,
  captureShadowBakeState,
  restoreShadowBakeState,
} from './shadow-bake-override.js';
import {
  allocLitFactorTarget,
  copyTextureToTarget,
  createShadowTextureBlitContext,
} from './shadow-texture-copy.js';
import { resolveEffectShadowSun2D } from '../shadow-system/ShadowSunDirection.js';

const log = createLogger('LightningShadowBakeCache');

export const DEFAULT_COMPASS_SECTOR_COUNT = 8;
export const DEFAULT_LIGHTNING_ELEVATION_DEG = 12;

/**
 * @typedef {object} LightningBakeSector
 * @property {THREE.WebGLRenderTarget|null} building
 * @property {THREE.WebGLRenderTarget|null} skyReach
 * @property {THREE.WebGLRenderTarget|null} painted
 * @property {THREE.WebGLRenderTarget|null} vegetation
 */

export class LightningShadowBakeCache {
  /**
   * @param {object} opts
   * @param {number} [opts.sectorCount]
   */
  constructor(opts = {}) {
    this.sectorCount = Math.max(4, Math.min(16, Math.floor(Number(opts.sectorCount) || DEFAULT_COMPASS_SECTOR_COUNT)));
    /** @type {'idle'|'baking'|'ready'|'invalid'} */
    this.state = 'idle';
    this._sectorIndex = 0;
    this._signature = '';
    /** @type {LightningBakeSector[]} */
    this._sectors = [];
    this._blit = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._sceneSizeScratch = null;
    /** @type {THREE.WebGLRenderTarget|null} */
    this._screenSizeScratch = null;
  }

  /**
   * @returns {string}
   */
  getStatusLabel() {
    if (this.state === 'ready') return 'Ready';
    if (this.state === 'baking') return `Baking ${this._sectorIndex}/${this.sectorCount}…`;
    if (this.state === 'invalid') return 'Invalid';
    return 'Idle';
  }

  invalidate(reason = '') {
    this.state = 'invalid';
    this._sectorIndex = 0;
    this._signature = '';
    if (reason) log.debug('LightningShadowBakeCache invalidated', reason);
  }

  /**
   * @param {object} floorCompositor
   * @param {object} params
   * @returns {string}
   */
  _buildSignature(floorCompositor, params) {
    const sig = floorCompositor?._lastOutdoorsSignature ?? '';
    const af = Number(floorCompositor?._activeFloorIndex);
    return [
      sig,
      Number.isFinite(af) ? af : 0,
      params?.shadowLengthScale,
      params?.shadowSmearScale,
      this.sectorCount,
    ].join('|');
  }

  /**
   * @param {object} deps
   * @param {import('../FloorCompositor.js').FloorCompositor} deps.floorCompositor
   * @param {object} deps.params
   */
  ensureReady(deps) {
    const { floorCompositor, params } = deps;
    if (!floorCompositor?.renderer || !floorCompositor?.camera) return;
    const sig = this._buildSignature(floorCompositor, params);
    if (this.state === 'ready' && this._signature === sig) return;
    if (this.state !== 'baking' || this._signature !== sig) {
      this._signature = sig;
      this._sectorIndex = 0;
      this.state = 'baking';
      this._disposeSectors();
      this._sectors = [];
      for (let i = 0; i < this.sectorCount; i++) {
        this._sectors.push({ building: null, skyReach: null, painted: null, vegetation: null });
      }
    }
  }

  /**
   * Advance bake by one sector per call.
   * @param {object} deps
   * @returns {boolean} true when fully ready
   */
  tickBake(deps) {
    const { floorCompositor, params } = deps;
    if (this.state !== 'baking') return this.state === 'ready';
    if (!floorCompositor?.renderer || !floorCompositor?.camera) return false;

    if (!this._blit) this._blit = createShadowTextureBlitContext();

    const idx = this._sectorIndex;
    if (idx >= this.sectorCount) {
      this.state = 'ready';
      return true;
    }

    const azimuthDeg = (360 / this.sectorCount) * idx;
    try {
      this._bakeSector(floorCompositor, params, idx, azimuthDeg);
    } catch (err) {
      log.warn('LightningShadowBakeCache sector bake failed', err);
      this.invalidate('bake-failed');
      return false;
    }

    this._sectorIndex += 1;
    if (this._sectorIndex >= this.sectorCount) {
      this.state = 'ready';
      log.info('LightningShadowBakeCache ready', { sectors: this.sectorCount });
    }
    return this.state === 'ready';
  }

  /**
   * @param {import('../FloorCompositor.js').FloorCompositor} fc
   * @param {object} params
   * @param {number} sectorIdx
   * @param {number} azimuthDeg
   */
  _bakeSector(fc, params, sectorIdx, azimuthDeg) {
    const renderer = fc.renderer;
    const camera = fc.camera;
    const building = fc._buildingShadowEffect;
    const skyReach = fc._skyReachShadowEffect;
    const painted = fc._paintedShadowEffect;

    const bakeOpts = {
      azimuthDeg,
      elevationDeg: DEFAULT_LIGHTNING_ELEVATION_DEG,
      lengthMul: Math.max(0.5, Number(params?.shadowLengthScale) || 2.5),
      smearMul: Math.max(0.25, Number(params?.shadowSmearScale) ?? 1.0),
      lengthScale: 1.0,
      smearScale: 1.0,
    };

    const sector = this._sectors[sectorIdx];

    if (building?.params?.enabled !== false && building?.shadowTarget) {
      const snap = captureShadowBakeState(building);
      applyShadowBakeOverride(building, bakeOpts);
      building.render(renderer, camera);
      restoreShadowBakeState(building, snap);
      const w = building.shadowTarget.width;
      const h = building.shadowTarget.height;
      if (!sector.building || sector.building.width !== w || sector.building.height !== h) {
        sector.building?.dispose?.();
        sector.building = allocLitFactorTarget(w, h, `LightningBakeBuilding_${sectorIdx}`);
      }
      if (sector.building) {
        copyTextureToTarget(renderer, building.shadowFactorTexture, sector.building, this._blit);
      }
    }

    if (skyReach?.params?.enabled && skyReach?.shadowTarget) {
      const snap = captureShadowBakeState(skyReach);
      applyShadowBakeOverride(skyReach, bakeOpts);
      skyReach.render(renderer, camera);
      restoreShadowBakeState(skyReach, snap);
      const w = skyReach.shadowTarget.width;
      const h = skyReach.shadowTarget.height;
      if (!sector.skyReach || sector.skyReach.width !== w || sector.skyReach.height !== h) {
        sector.skyReach?.dispose?.();
        sector.skyReach = allocLitFactorTarget(w, h, `LightningBakeSkyReach_${sectorIdx}`);
      }
      if (sector.skyReach) {
        copyTextureToTarget(renderer, skyReach.shadowFactorTexture, sector.skyReach, this._blit);
      }
    }

    if (painted?.params?.enabled && painted?.shadowTarget) {
      const snap = captureShadowBakeState(painted);
      applyShadowBakeOverride(painted, bakeOpts);
      painted.render(renderer);
      restoreShadowBakeState(painted, snap);
      const w = painted.shadowTarget.width;
      const h = painted.shadowTarget.height;
      if (!sector.painted || sector.painted.width !== w || sector.painted.height !== h) {
        sector.painted?.dispose?.();
        sector.painted = allocLitFactorTarget(w, h, `LightningBakePainted_${sectorIdx}`);
      }
      if (sector.painted) {
        copyTextureToTarget(renderer, painted.shadowFactorTexture, sector.painted, this._blit);
      }
    }

    this._bakeVegetationSector(fc, sector, bakeOpts, sectorIdx);
  }

  /**
   * @param {import('../FloorCompositor.js').FloorCompositor} fc
   * @param {LightningBakeSector} sector
   * @param {object} bakeOpts
   * @param {number} sectorIdx
   */
  _bakeVegetationSector(fc, sector, bakeOpts, sectorIdx) {
    const THREE = window.THREE;
    if (!THREE) return;
    const renderer = fc.renderer;
    const camera = fc.camera;
    const sun2d = resolveEffectShadowSun2D({
      azimuthDeg: bakeOpts.azimuthDeg,
      elevationDeg: bakeOpts.elevationDeg,
    });
    const sunVec = new THREE.Vector2(sun2d.x, sun2d.y);

    const treeEntries = fc._treeEffect?.collectBillboardShadowOverlayEntries?.() ?? [];
    const bushEntries = fc._bushEffect?.collectBillboardShadowOverlayEntries?.() ?? [];
    const entries = [...treeEntries, ...bushEntries].filter((e) => {
      const mask = e?.uniforms?.uTreeMask?.value ?? e?.uniforms?.uBushMask?.value;
      return !!mask;
    });
    if (!entries.length) return;

    const savedDirs = [];
    for (const e of entries) {
      const ud = e.uniforms?.uSunDir?.value;
      if (ud) {
        savedDirs.push({ ref: ud, x: ud.x, y: ud.y });
        ud.copy(sunVec);
      }
      if (e.uniforms?.uShadowLength) {
        const base = Number(e.uniforms.uShadowLength.value) || 0.01;
        e.uniforms.uShadowLength.value = base * (bakeOpts.lengthMul || 3.0);
      }
    }

    const v = fc._drawingBufferSizeTmp || new THREE.Vector2();
    renderer.getDrawingBufferSize(v);
    const bw = Math.max(2, Math.floor(Number(v.x) || 2));
    const bh = Math.max(2, Math.floor(Number(v.y) || 2));

    const pass = fc._treeVegetationBillboardPass;
    if (!pass) return;
    try {
      pass.initialize();
      pass.onResize(bw, bh);
      pass.render(renderer, camera, entries, { clear: true });
      if (!sector.vegetation || sector.vegetation.width !== bw || sector.vegetation.height !== bh) {
        sector.vegetation?.dispose?.();
        sector.vegetation = allocLitFactorTarget(bw, bh, `LightningBakeVeg_${sectorIdx}`);
      }
      if (sector.vegetation && pass.texture) {
        copyTextureToTarget(renderer, pass.texture, sector.vegetation, this._blit);
      }
    } finally {
      for (const s of savedDirs) s.ref.set(s.x, s.y);
    }
  }

  /**
   * @param {number} azimuthDeg
   * @returns {{ sectorA: number, sectorB: number, blendB: number }}
   */
  _resolveSectorBlend(azimuthDeg) {
    const count = this.sectorCount;
    const step = 360 / count;
    const a = ((Number(azimuthDeg) % 360) + 360) % 360;
    const idx = Math.floor((a + step * 0.5) / step) % count;
    const center = idx * step;
    let delta = a - center;
    if (delta > step * 0.5) delta -= step;
    if (delta < -step * 0.5) delta += step;
    const t = Math.abs(delta) / (step * 0.5);
    const next = delta >= 0 ? (idx + 1) % count : (idx - 1 + count) % count;
    return {
      sectorA: idx,
      sectorB: next,
      blendB: Math.max(0, Math.min(1, t)),
    };
  }

  /**
   * @param {number} azimuthDeg
   * @returns {{ building: THREE.Texture|null, skyReach: THREE.Texture|null, painted: THREE.Texture|null, vegetation: THREE.Texture|null }|null}
   */
  getBlendedTextures(azimuthDeg) {
    if (this.state !== 'ready' || !this._sectors.length) return null;
    const { sectorA, sectorB, blendB } = this._resolveSectorBlend(azimuthDeg);
    const sa = this._sectors[sectorA];
    const sb = this._sectors[sectorB];
    if (!sa) return null;
    const pick = (key) => {
      const ta = sa[key]?.texture ?? null;
      const tb = sb[key]?.texture ?? null;
      if (!ta) return tb;
      if (!tb || blendB <= 0.001) return ta;
      if (blendB >= 0.999) return tb;
      return ta;
    };
    return {
      building: pick('building'),
      skyReach: pick('skyReach'),
      painted: pick('painted'),
      vegetation: pick('vegetation'),
    };
  }

  _disposeSectors() {
    for (const s of this._sectors) {
      try { s.building?.dispose?.(); } catch (_) {}
      try { s.skyReach?.dispose?.(); } catch (_) {}
      try { s.painted?.dispose?.(); } catch (_) {}
      try { s.vegetation?.dispose?.(); } catch (_) {}
    }
    this._sectors = [];
    try { this._sceneSizeScratch?.dispose?.(); } catch (_) {}
    try { this._screenSizeScratch?.dispose?.(); } catch (_) {}
    this._sceneSizeScratch = null;
    this._screenSizeScratch = null;
  }

  dispose() {
    this._disposeSectors();
    this.state = 'idle';
    this._blit = null;
  }
}
