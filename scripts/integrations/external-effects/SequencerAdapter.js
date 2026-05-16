/**
 * @fileoverview SequencerAdapter — bridges Sequencer's PIXI-based CanvasEffects
 * into MSA's Three.js FloorRenderBus via per-effect SequencerEffectMirror
 * meshes.
 *
 * Lifecycle hooks consumed:
 *   - `sequencerReady`            — confirm Sequencer global is present
 *   - `createSequencerEffect`     — spawn mirror, hide PIXI container
 *   - `updateSequencerEffect`     — refresh renderOrder if elevation/sortLayer changed
 *   - `endedSequencerEffect`      — dispose mirror, unhide PIXI container
 *
 * Mesh transform + texture sync (`syncFromPixi`) runs once per FloorCompositor draw
 * in {@link #tickBeforeBusRender} — not every PIXI tick. The FrameCoordinator hook
 * only runs diagnostics (see `MapShine.__sequencerMirrorProbeIntervalMs`) unless
 * `MapShine.__sequencerMirrorLegacyPostPixiSync` is true (duplicate sync path; avoid).
 *
 * Diagnostics: `MapShine.externalEffects.probeSequencerMirrors()` (F12),
 * `MapShine.externalEffects.probeSequencerMirrorsDeep()` for DOM pixel samples + WebGL hints,
 * or `MapShine.__sequencerMirrorProbeIntervalMs = 2000` for periodic dumps
 * (set `MapShine.__sequencerMirrorProbeUseDeep = true` to use the deep snapshot each tick).
 *
 * @module integrations/external-effects/SequencerAdapter
 */

import { createLogger } from '../../core/log.js';
import { SequencerEffectMirror } from './SequencerEffectMirror.js';

const log = createLogger('SequencerAdapter');

const ATTACH_RETRY_DELAY_MS = 100;
const ATTACH_RETRY_MAX_ATTEMPTS = 20;

function getMapShineRoot() {
  return (globalThis.window ?? globalThis).MapShine ?? null;
}

/**
 * Performance recorder hooks are optional; avoids repeated churn on the lookup path.
 * @returns {import('../../core/diagnostics/PerformanceRecorder.js').PerformanceRecorder|null}
 */
function getPerfRecorderIfEnabled() {
  if (typeof window === 'undefined') return null;
  const pr = window.MapShine?.performanceRecorder ?? null;
  return pr?.enabled ? pr : null;
}

export class SequencerAdapter {
  /**
   * @param {{
   *   compositor: any,
   *   floorRenderBus: any,
   *   sceneComposer: any,
   *   floorStack: any,
   *   frameCoordinator: any,
   *   renderLoop: any,
   * }} refs
   */
  constructor(refs) {
    this._compositor = refs.compositor;
    this._floorRenderBus = refs.floorRenderBus;
    this._sceneComposer = refs.sceneComposer;
    this._floorStack = refs.floorStack;
    this._frameCoordinator = refs.frameCoordinator;
    this._renderLoop = refs.renderLoop;

    /** @type {Map<string, SequencerEffectMirror>} */
    this._mirrors = new Map();

    /** @type {boolean} */
    this._enabled = true;

    /** @type {boolean} */
    this._initialized = false;

    /** @type {boolean} */
    this._disposed = false;

    /** @type {Array<{name:string,id:number}>} */
    this._hookIds = [];

    /** @type {Function|null} */
    this._postPixiUnsubscribe = null;

    /** @type {WeakMap<object, string>} */
    this._canonicalMirrorKeysByEffectObject = new WeakMap();

    /** @type {number} */
    this._nextSyntheticId = 1;

    /** @type {Map<string, {effect: any, attempts: number, timerId: number|null}>} */
    this._pendingAttach = new Map();

    /** @type {number} */
    this._lastMirrorProbeAt = 0;

    /**
     * Parallel dense arrays for hot loops (avoid `Map` iterator allocations every PIXI tick).
     * Indices match: `_mirrorRunKeys[i]` ↔ `_mirrorRunList[i]`.
     */
    /** @type {string[]} */
    this._mirrorRunKeys = [];
    /** @type {SequencerEffectMirror[]} */
    this._mirrorRunList = [];
  }

  /** @returns {boolean} */
  isSequencerAvailable() {
    try {
      return !!(globalThis.Sequencer && (globalThis.Sequence || globalThis.Sequencer.Sequence));
    } catch (_) { return false; }
  }

  /**
   * Wire Foundry hooks. Safe to call once; subsequent calls are no-ops.
   */
  initialize() {
    if (this._initialized || this._disposed) return;
    this._initialized = true;

    const reg = (name, fn) => {
      try {
        const id = Hooks.on(name, fn);
        this._hookIds.push({ name, id });
      } catch (e) {
        log.warn(`Hooks.on(${name}) failed:`, e);
      }
    };

    reg('sequencerReady', () => {
      log.info('Sequencer ready — adapter is active');
      this._bootstrapExistingEffects();
      this._scheduleLateBootstrapPasses();
    });
    reg('createSequencerEffect', (effect) => this._onCreate(effect));
    reg('updateSequencerEffect', (effect) => this._onUpdate(effect));
    reg('endedSequencerEffect', (effect) => this._onEnd(effect));

    // Hook after PIXI: periodic diagnostics only. Full mirror sync happens in tickBeforeBusRender.
    try {
      const fc = this._frameCoordinator;
      if (fc && typeof fc.onPostPixi === 'function') {
        this._postPixiUnsubscribe = fc.onPostPixi(() => this._syncAll());
      } else {
        // Fallback: directly attach to PIXI ticker if frame coordinator is missing.
        if (globalThis.canvas?.app?.ticker?.add) {
          const tickFn = () => this._syncAll();
          canvas.app.ticker.add(tickFn);
          this._postPixiUnsubscribe = () => {
            try { canvas.app.ticker.remove(tickFn); } catch (_) {}
          };
        }
      }
    } catch (e) {
      log.warn('frame sync attach failed:', e);
    }

    log.info('SequencerAdapter initialized');
    this._bootstrapExistingEffects();
    this._scheduleLateBootstrapPasses();
  }

  /** @returns {boolean} */
  hasActiveMirrors() {
    return this._mirrors.size > 0;
  }

  /**
   * Set adapter enabled state. Disabled adapter does not spawn new mirrors
   * but leaves existing mirrors in place until they end naturally.
   * @param {boolean} enabled
   */
  setEnabled(enabled) {
    this._enabled = !!enabled;
  }

  /**
   * Master brightness for mirrored Sequencer / JB2A clips. Backed by
   * `MapShine.__sequencerMirrorExternalDiffuseGain` (clamped 0.03–2 inside
   * the mirror). Passing a non-finite value clears the override and the
   * per-texture-kind defaults take effect again.
   * @param {number} value
   */
  setExternalDiffuseGain(value) {
    const root = getMapShineRoot();
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) {
      delete root.__sequencerMirrorExternalDiffuseGain;
      return;
    }
    root.__sequencerMirrorExternalDiffuseGain = Math.min(2, Math.max(0.03, v));
  }

  /**
   * Per-channel multiplier for mirrored clips. Stored as `{r,g,b}` on
   * `MapShine.__sequencerMirrorExternalTint` and read by every mirror.
   * @param {number} r
   * @param {number} g
   * @param {number} b
   */
  setExternalTint(r, g, b) {
    const root = getMapShineRoot();
    if (!root) return;
    const rr = Math.max(0, Number(r));
    const gg = Math.max(0, Number(g));
    const bb = Math.max(0, Number(b));
    if (![rr, gg, bb].every(Number.isFinite)) return;
    root.__sequencerMirrorExternalTint = { r: rr, g: gg, b: bb };
  }

  /**
   * Scale the along-cast component of the combined sprite + pivot delta.
   * <1 retreats toward the caster, >1 pushes further forward.
   * @param {number} value
   */
  setAlongCastPlacementMul(value) {
    const root = getMapShineRoot();
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return;
    root.__sequencerMirrorAlongCastPlacementMul = v;
  }

  /**
   * Uniform scale on mirror mesh width/height after footprint resolution.
   * `MapShine.__sequencerMirrorMeshScaleMul` (default 1).
   * @param {number} value
   */
  setMirrorMeshScaleMul(value) {
    const root = getMapShineRoot();
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) return;
    root.__sequencerMirrorMeshScaleMul = v;
  }

  /**
   * Scene-pixel shift along source→target (positive = toward target).
   * `MapShine.__sequencerMirrorAlongCastTargetNudgePx`.
   * @param {number} value
   */
  setAlongCastTargetNudgePx(value) {
    const root = getMapShineRoot();
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    root.__sequencerMirrorAlongCastTargetNudgePx = v;
  }

  /**
   * Extra world-space Z on the mirror mesh (bus scene). `MapShine.__sequencerMirrorZBias`.
   * @param {number} value
   */
  setMirrorZBias(value) {
    const root = getMapShineRoot();
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    root.__sequencerMirrorZBias = v;
  }

  /**
   * Multiplier for the analytic "half-width forward" pivot Sequencer applies
   * to `rotateTowards` effects. Default 1.
   * @param {number} value
   */
  setRotateTowardsForwardMul(value) {
    const root = getMapShineRoot();
    if (!root) return;
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) return;
    root.__sequencerMirrorRotateTowardsForwardMul = v;
  }

  /**
   * Direction of the forward pivot. ≥0 = forward (1), <0 = back (-1).
   * @param {number} sign
   */
  setRotateTowardsForwardSign(sign) {
    const root = getMapShineRoot();
    if (!root) return;
    const v = Number(sign);
    if (!Number.isFinite(v) || v === 0) return;
    root.__sequencerMirrorRotateTowardsForwardSign = v > 0 ? 1 : -1;
  }

  /**
   * Clear the cached `_floorRenderBus` pointer (e.g. after native level redraw
   * or ExternalEffectsCompositor rebuild) so `_resolveFloorRenderBus` snaps to
   * the current compositor/bus again.
   */
  invalidateFloorRenderBusCache() {
    this._floorRenderBus = null;
  }

  /** @private @param {string} key @param {SequencerEffectMirror} mirror */
  _densePushMirror(key, mirror) {
    this._mirrorRunKeys.push(key);
    this._mirrorRunList.push(mirror);
  }

  /**
   * @private
   * @param {string} key
   */
  _denseRemoveMirrorKey(key) {
    const keys = this._mirrorRunKeys;
    const list = this._mirrorRunList;
    const n = keys.length;
    let ix = -1;
    for (let i = 0; i < n; i++) {
      if (keys[i] === key) {
        ix = i;
        break;
      }
    }
    if (ix < 0) return;
    const last = n - 1;
    keys[ix] = keys[last];
    keys.pop();
    list[ix] = list[last];
    list.pop();
  }

  /**
   * Called once per FloorCompositor render before the bus scene is rendered.
   * Re-resolves the live FloorRenderBus because floor transitions/rebuilds can
   * replace the rendered bus scene after this adapter was constructed.
   */
  tickBeforeBusRender() {
    if (this._disposed) return;

    const list = this._mirrorRunList;
    const n = list.length;
    if (n === 0) return;

    const keys = this._mirrorRunKeys;
    const bus = this._resolveFloorRenderBus();

    const pr = getPerfRecorderIfEnabled();

    if (pr) {
      const tWhole = performance.now();
      let sumAttach = 0;
      let sumSync = 0;
      for (let i = 0; i < n; i++) {
        const mirror = list[i];
        const mirrorKey = keys[i];

        const ta = performance.now();
        mirror.ensureAttached(bus);
        sumAttach += performance.now() - ta;

        const ts = performance.now();
        mirror.syncFromPixi();
        const d = performance.now() - ts;
        sumSync += d;
        try {
          pr.recordSequencerMirrorSync(mirrorKey, mirror._textureKind, d);
        } catch (_) {}
      }
      try {
        pr.recordSequencerPhase('tickBefore.ensureAttached.total', sumAttach);
        pr.recordSequencerPhase('tickBefore.syncFromPixi.total', sumSync);
        pr.recordSequencerPhase('tickBefore.total', performance.now() - tWhole);
      } catch (_) {}
      return;
    }

    for (let i = 0; i < n; i++) {
      list[i].ensureAttached(bus);
      list[i].syncFromPixi();
    }
  }

  /**
   * Log every active Sequencer mirror snapshot to the browser console.
   * Call from F12 while an effect plays: `MapShine.externalEffects.probeSequencerMirrors()`
   * Deep (DOM `drawImage` luminance + GL extensions):
   * `MapShine.externalEffects.probeSequencerMirrorsDeep()`
   *
   * Optional periodic dumps: `MapShine.__sequencerMirrorProbeIntervalMs = 2000`
   * (throttled; min 500 ms). Use `MapShine.__sequencerMirrorProbeUseDeep = true` so each
   * interval uses the deep snapshot.
   *
   * @param {string} [label]
   * @param {{ deep?: boolean }} [opts]
   * @returns {Array<Record<string, unknown>>}
   */
  probeMirrorsToConsole(label = 'manual', opts = undefined) {
    if (this._mirrorRunList.length === 0) {
      console.warn(`[MSA Sequencer mirror probe:${label}] no active mirrors`);
      return [];
    }
    const deep = !!opts?.deep;
    const rows = [];
    const rk = this._mirrorRunKeys;
    const rl = this._mirrorRunList;
    for (let i = 0; i < rl.length; i++) {
      const key = rk[i];
      const mirror = rl[i];
      try {
        const snap = mirror.getDebugSnapshot?.(deep ? { deep: true } : undefined)
          ?? { error: 'no getDebugSnapshot' };
        rows.push({ key, ...snap });
      } catch (e) {
        rows.push({ key, error: String(e?.message ?? e) });
      }
    }
    console.warn(`[MSA Sequencer mirror probe:${label}${deep ? ' DEEP' : ''}]`, rows);
    return rows;
  }

  /**
   * Like `probeMirrorsToConsole` but always runs the deep path (2D canvas center
   * pixel on each bound video branch + WebGL extension names).
   * @param {string} [label]
   * @returns {Array<Record<string, unknown>>}
   */
  probeMirrorsDeepToConsole(label = 'deep') {
    return this.probeMirrorsToConsole(label, { deep: true });
  }

  /**
   * Live diagnostics for Map Shine Performance Recorder exports / dialog.
   * Safe to call any time — returns null-ish fields when disabled.
   * @returns {object|null}
   */
  getPerformanceRecorderDiagnostics() {
    if (this._disposed) return null;

    /** @type {Record<string, number>} */
    const kindCounts = { video: 0, image: 0, spritesheet: 0, pixiCanvas: 0, unknown: 0 };
    const pixiCanvasTotals = {
      frameCacheSize: 0,
      cacheHits: 0,
      fastDraws: 0,
      slowExtracts: 0,
      uploads: 0,
      skippedUnchanged: 0,
    };
    const footprintTotals = {
      cacheHits: 0,
      misses: 0,
      legacy: 0,
    };

    /** @type {Array<Record<string, unknown>>} */
    const mirrors = [];
    const rk = this._mirrorRunKeys;
    const rl = this._mirrorRunList;
    for (let i = 0; i < rl.length; i++) {
      const key = rk[i];
      const mirror = rl[i];
      const kind = mirror?._textureKind ?? 'unknown';
      if (Object.prototype.hasOwnProperty.call(kindCounts, kind)) {
        kindCounts[kind]++;
      } else {
        kindCounts.unknown++;
      }

      let fileHint = null;
      try {
        const dfp = mirror._effect?.data?.file ?? mirror._effect?.file ?? null;
        fileHint = typeof dfp === 'string' ? dfp.split(/[\\/]/).pop() ?? dfp : null;
      } catch (_) {}

      mirrors.push({
        adapterKey: key,
        textureKind: mirror._textureKind ?? null,
        attached: !!mirror._attached,
        meshInBusScene: !!mirror.mesh?.parent,
        renderOrder: Number.isFinite(Number(mirror.mesh?.renderOrder)) ? Number(mirror.mesh.renderOrder) : null,
        naturalSizePx: mirror._naturalSize ? { ...mirror._naturalSize } : null,
        effectId: mirror._effect?.id ?? null,
        effectName: mirror._effect?.data?.name ?? mirror._effect?.name ?? null,
        hasAnimatedMedia: !!mirror._effect?.hasAnimatedMedia,
        spritePlaying: !!mirror._effect?.sprite?.playing,
        fileBasenameHint: fileHint,
        pixiCanvasStats: mirror._textureKind === 'pixiCanvas' && mirror._pixiCanvasStats
          ? { ...mirror._pixiCanvasStats, frameCacheSize: mirror._pixiCanvasFrameCache?.size ?? 0 }
          : null,
        footprintStats: mirror._footprintStats ? { ...mirror._footprintStats } : null,
      });

      try {
        const pStats = mirror._pixiCanvasStats ?? null;
        if (pStats && typeof pStats === 'object') {
          pixiCanvasTotals.frameCacheSize += Number(mirror._pixiCanvasFrameCache?.size) || 0;
          pixiCanvasTotals.cacheHits += Number(pStats.cacheHits) || 0;
          pixiCanvasTotals.fastDraws += Number(pStats.fastDraws) || 0;
          pixiCanvasTotals.slowExtracts += Number(pStats.slowExtracts) || 0;
          pixiCanvasTotals.uploads += Number(pStats.uploads) || 0;
          pixiCanvasTotals.skippedUnchanged += Number(pStats.skippedUnchanged) || 0;
        }
      } catch (_) {}

      try {
        const fStats = mirror._footprintStats ?? null;
        if (fStats && typeof fStats === 'object') {
          footprintTotals.cacheHits += Number(fStats.hits) || 0;
          footprintTotals.misses += Number(fStats.misses) || 0;
          footprintTotals.legacy += Number(fStats.legacy) || 0;
        }
      } catch (_) {}
    }

    let sequencerMgrCount = null;
    try {
      const mgr = globalThis.Sequencer?.EffectManager ?? null;
      const raw = mgr?.effects ?? mgr?._effects ?? null;
      if (Array.isArray(raw)) sequencerMgrCount = raw.length;
      else if (raw instanceof Map) sequencerMgrCount = raw.size;
      else if (raw && typeof raw === 'object' && typeof Object.keys === 'function') {
        sequencerMgrCount = Object.keys(raw).length;
      }
    } catch (_) {}

    return {
      adapterInitialized: !!this._initialized,
      sequencerModulePresent: this.isSequencerAvailable(),
      effectManagerTrackedEffectsApprox: sequencerMgrCount,
      mirrorTilesActiveInMsa: mirrors.length,
      mirrorsByTextureKind: kindCounts,
      pixiCanvasMirrorTotals: pixiCanvasTotals,
      footprintCacheTotals: footprintTotals,
      pendingMirrorAttachRetries: this._pendingAttach?.size ?? 0,
      adapterEnabled: !!this._enabled,
      mirrors,
    };
  }

  // ── Hook handlers ──────────────────────────────────────────────────────────

  _onCreate(effect) {
    if (!this._enabled || this._disposed) return;
    const normalized = this._normalizeEffect(effect);
    const key = normalized?.id;
    if (!normalized || !key) return;

    const existing = this._mirrors.get(key);
    if (existing) {
      if (!existing._disposed) return;
      try { existing.dispose(); } catch (_) {}
      this._mirrors.delete(key);
      this._denseRemoveMirrorKey(key);
    }

    if (this._pendingAttach.has(key)) return;

    let mirror = null;
    try {
      mirror = new SequencerEffectMirror({
        effect: normalized.effect,
        floorRenderBus: this._resolveFloorRenderBus(),
        sceneComposer: this._sceneComposer,
        floorStack: this._floorStack,
      });
      if (!mirror.attach()) {
        try { mirror.dispose(); } catch (_) {}
        this._scheduleAttachRetry(normalized.effect, key, 1);
        return;
      }
    } catch (e) {
      log.warn('SequencerEffectMirror construction failed for effect:', key, e);
      try { mirror?.dispose?.(); } catch (_) {}
      return;
    }

    this._mirrors.set(key, mirror);
    this._densePushMirror(key, mirror);
    this._pendingAttach.delete(key);
    try { this._renderLoop?.requestContinuousRender?.(180); } catch (_) {}
  }

  _onUpdate(effect) {
    if (this._disposed) return;
    const normalized = this._normalizeEffect(effect);
    const key = normalized?.id;
    if (!key) return;
    const mirror = this._mirrors.get(key);
    if (!mirror) {
      this._scheduleAttachRetry(normalized.effect, key, 1);
      return;
    }
    try { mirror.refreshOrder(); } catch (e) {
      log.warn('mirror.refreshOrder failed:', e);
    }
  }

  _onEnd(effect) {
    const normalized = this._normalizeEffect(effect);
    const key = normalized?.id;
    if (!key) return;
    const mirror = this._mirrors.get(key);
    const pending = this._pendingAttach.get(key);
    if (pending?.timerId != null) {
      try { clearTimeout(pending.timerId); } catch (_) {}
    }
    this._pendingAttach.delete(key);
    if (!mirror) return;
    this._mirrors.delete(key);
    this._denseRemoveMirrorKey(key);
    try { mirror.dispose(); } catch (e) {
      log.warn('mirror.dispose failed:', e);
    }
  }

  _syncAll() {
    if (this._disposed) return;

    const list = this._mirrorRunList;
    const keys = this._mirrorRunKeys;
    const n = list.length;
    if (n === 0) return;

    const msRoot = getMapShineRoot();
    const legacyPostPixiSync = !!(msRoot?.__sequencerMirrorLegacyPostPixiSync === true);

    if (legacyPostPixiSync) {
      const pr = getPerfRecorderIfEnabled();
      const tLoop = pr ? performance.now() : 0;
      if (pr) {
        for (let i = 0; i < n; i++) {
          const mirror = list[i];
          const ts = performance.now();
          mirror.syncFromPixi();
          try {
            pr.recordSequencerMirrorSync(keys[i], mirror._textureKind, performance.now() - ts);
          } catch (_) {}
        }
        try {
          pr.recordSequencerPhase('postPixi.syncFromPixi.loop', performance.now() - tLoop);
        } catch (_) {}
      } else {
        for (let i = 0; i < n; i++) {
          list[i].syncFromPixi();
        }
      }
    }

    if (!msRoot) return;

    const probeMs = Number(msRoot.__sequencerMirrorProbeIntervalMs);
    if (!Number.isFinite(probeMs) || probeMs < 500) return;

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - (this._lastMirrorProbeAt ?? 0) < probeMs) return;

    this._lastMirrorProbeAt = now;
    const deep = !!msRoot.__sequencerMirrorProbeUseDeep;
    try {
      this.probeMirrorsToConsole('[MapShine.__sequencerMirrorProbeIntervalMs]', deep ? { deep: true } : undefined);
    } catch (_) {}
  }

  _resolveFloorRenderBus() {
    const ms = getMapShineRoot();
    let preferred = null;
    if (ms) {
      preferred = ms.effectComposer?._floorCompositorV2?._renderBus
        ?? ms.floorCompositorV2?._renderBus
        ?? ms.floorRenderBus
        ?? null;
    }

    if (this._floorRenderBus && preferred === this._floorRenderBus) {
      return this._floorRenderBus;
    }
    if (!ms) return this._floorRenderBus ?? null;
    if (preferred) {
      this._floorRenderBus = preferred;
      return preferred;
    }
    return this._floorRenderBus ?? null;
  }

  _normalizeEffect(effectish) {
    if (!effectish) return null;
    // Hook payloads can be either the effect directly, or an object wrapping
    // the effect (depending on Sequencer / hook signature variants).
    const effect = effectish.effect ?? effectish.document ?? effectish;
    if (!effect || typeof effect !== 'object') return null;

    const cachedKey = this._canonicalMirrorKeysByEffectObject.get(effect);
    if (cachedKey) return { effect, id: cachedKey };

    const base = String(
      effect.id
      ?? effect._id
      ?? effect.uuid
      ?? effect.objectId
      ?? effect._objectId
      ?? effect.sequenceId
      ?? ''
    ).trim() || `synthetic-${this._nextSyntheticId++}`;

    let key = base;
    let bump = 0;
    while (this._mirrorKeyHeldByDifferentEffect(key, effect)) {
      bump += 1;
      key = `${base}#${bump}`;
    }

    this._canonicalMirrorKeysByEffectObject.set(effect, key);
    return { effect, id: key };
  }

  /**
   * True when `key` names an in-flight retry or mirror bound to another effect instance.
   * Sequencer occasionally reuses the same nominal `effect.id` for multiple live
   * {@link PIXI.DisplayObject}s; without this, only the first gets a Three mirror.
   * @param {string} key
   * @param {object} effect
   */
  _mirrorKeyHeldByDifferentEffect(key, effect) {
    const pending = this._pendingAttach.get(key);
    if (pending?.effect != null && pending.effect !== effect) return true;

    const mirror = this._mirrors.get(key);
    if (!mirror || typeof mirror !== 'object') return false;

    /** @see SequencerEffectMirror */
    const bound = mirror._effect ?? null;

    return bound != null && bound !== effect;
  }

  _bootstrapExistingEffects() {
    if (this._disposed) return;
    try {
      const manager = globalThis.Sequencer?.EffectManager ?? null;
      const raw = manager?.effects ?? manager?._effects ?? null;
      const list = Array.isArray(raw)
        ? raw
        : (raw instanceof Map ? Array.from(raw.values()) : []);
      if (list.length === 0 && typeof manager?.getEffects === 'function') {
        try {
          const queried = manager.getEffects({});
          if (Array.isArray(queried)) list.push(...queried);
        } catch (_) {}
      }
      if (list.length === 0) return;
      for (const e of list) this._onCreate(e);
    } catch (e) {
      log.debug('bootstrap existing sequencer effects failed:', e);
    }
  }

  /**
   * After floor / same-scene resync (`ExternalEffectsCompositor` rebuild), freshly
   * registered hooks can run before {@link globalThis.Sequencer.EffectManager} lists
   * every persistent clip. Retry bootstrapping on the next frames.
   */
  _scheduleLateBootstrapPasses() {
    if (this._disposed || !this._initialized) return;
    const run = () => {
      if (!this._disposed && this._initialized) this._bootstrapExistingEffects();
    };
    try { requestAnimationFrame(() => requestAnimationFrame(run)); } catch (_) { try { run(); } catch (_) {} }
    try { setTimeout(run, 48); } catch (_) {}
    try { setTimeout(run, 240); } catch (_) {}
  }

  _scheduleAttachRetry(effect, key, attempts) {
    if (this._disposed || !this._enabled || !effect || !key) return;
    if (this._mirrors.has(key)) return;
    if (attempts > ATTACH_RETRY_MAX_ATTEMPTS) {
      log.warn(`Sequencer mirror attach gave up for ${key} after ${ATTACH_RETRY_MAX_ATTEMPTS} attempts`);
      this._pendingAttach.delete(key);
      return;
    }

    const existing = this._pendingAttach.get(key);
    if (existing?.timerId != null) return;

    const timerId = setTimeout(() => {
      this._pendingAttach.delete(key);
      if (this._disposed || this._mirrors.has(key)) return;

      let mirror = null;
      try {
        mirror = new SequencerEffectMirror({
          effect,
          floorRenderBus: this._resolveFloorRenderBus(),
          sceneComposer: this._sceneComposer,
          floorStack: this._floorStack,
        });
        if (mirror.attach()) {
          this._mirrors.set(key, mirror);
          this._densePushMirror(key, mirror);
          try { this._renderLoop?.requestContinuousRender?.(500); } catch (_) {}
          return;
        }
      } catch (e) {
        log.debug(`Sequencer mirror retry ${attempts} failed for ${key}:`, e);
      }
      try { mirror?.dispose?.(); } catch (_) {}
      this._scheduleAttachRetry(effect, key, attempts + 1);
    }, ATTACH_RETRY_DELAY_MS);

    this._pendingAttach.set(key, { effect, attempts, timerId });
  }

  /**
   * Dispose all mirrors and unhook lifecycle hooks.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    for (const { name, id } of this._hookIds) {
      try { Hooks.off(name, id); } catch (_) {}
    }
    this._hookIds.length = 0;

    if (typeof this._postPixiUnsubscribe === 'function') {
      try { this._postPixiUnsubscribe(); } catch (_) {}
      this._postPixiUnsubscribe = null;
    }

    for (const mirror of this._mirrors.values()) {
      try { mirror.dispose(); } catch (_) {}
    }
    this._mirrors.clear();
    this._mirrorRunKeys.length = 0;
    this._mirrorRunList.length = 0;
    for (const pending of this._pendingAttach.values()) {
      if (pending?.timerId != null) {
        try { clearTimeout(pending.timerId); } catch (_) {}
      }
    }
    this._pendingAttach.clear();

    try { this.invalidateFloorRenderBusCache(); } catch (_) {}

    log.info('SequencerAdapter disposed');
  }
}
