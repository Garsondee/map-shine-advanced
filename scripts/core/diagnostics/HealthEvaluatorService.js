import { createLogger } from '../log.js';
import { safeCall, Severity } from '../safe-call.js';
import { HealthContractRegistry } from './HealthContractRegistry.js';
import { HealthDependencyGraph } from './HealthDependencyGraph.js';
import { captureRenderStack } from './RenderStackSnapshotService.js';
import { evaluateRenderStackFindings } from './RenderStackRules.js';
import { isLevelsEnabledForScene } from '../../foundry/levels-scene-flags.js';
import { collectEnabledMaskIds, getMaskTextureManifest } from '../../settings/mask-manifest-flags.js';
import { getShaderCompileMonitor } from './ShaderCompileMonitor.js';

const log = createLogger('HealthEvaluator');

const STATUS_WEIGHT = {
  unknown: 0,
  healthy: 1,
  degraded: 2,
  broken: 3,
  critical: 4,
};

const SEVERITY_TO_STATUS = {
  info: 'degraded',
  warn: 'degraded',
  error: 'broken',
  critical: 'critical',
};

export class HealthEvaluatorService {
  constructor(options = {}) {
    this.floorCompositor = options.floorCompositor || null;
    this.effectComposer = options.effectComposer || null;
    this.timeManager = options.timeManager || null;
    this.maskManager = options.maskManager || null;
    this.gpuSceneMaskCompositor = options.gpuSceneMaskCompositor || null;
    this.weatherController = options.weatherController || null;

    this.registry = new HealthContractRegistry();
    this.dependencyGraph = new HealthDependencyGraph();

    /** @type {Map<string, any>} */
    this._records = new Map();
    this._listeners = new Set();
    this._acknowledged = new Set();
    this._lastStatusSignatures = new Map();
    this._heartbeats = new Map();
    this._waterFloorSignatureCache = new Map();
    this._wrappedMethods = [];
    this._timers = [];
    this._initialized = false;
  }

  initialize() {
    if (this._initialized) return;
    this._registerBuiltInContracts();
    this._registerBuiltInEdges();
    this._installInstrumentation();
    this._installShaderMonitor();
    this._startScheduler();
    this._initialized = true;
    log.info('Health evaluator initialized');
  }

  /**
   * Connect ShaderCompileMonitor to health reporting.
   * @private
   */
  _installShaderMonitor() {
    const monitor = getShaderCompileMonitor();
    monitor.initialize();
    monitor.setHealthCallback((effectId, record) => {
      // Create health record for shader compile failures/timeouts
      if (record.status === 'timeout' || record.status === 'error') {
        this._recordShaderIssue(effectId, record);
      }
    });
  }

  /**
   * Record shader compile issues in health system.
   * @private
   */
  _recordShaderIssue(effectId, record) {
    const id = `${effectId}|shader|${record.shaderType}`;
    const status = record.status === 'timeout' ? 'degraded' : 'broken';
    const now = Date.now();

    this._records.set(id, {
      effectId: `${effectId}.shader`,
      levelKey: 'global:active',
      status,
      checks: [{
        name: `${record.shaderType}_compile`,
        status,
        message: `${record.shaderType} shader ${record.status} after ${Math.round(record.durationMs || 0)}ms: ${record.errorMessage || 'unknown'}`,
        lines: record.shaderLines,
        usedFallback: record.usedFallback,
      }],
      firstSeenMs: now,
      lastSeenMs: now,
    });
  }

  /**
   * Wrap effect instances that were null during the initial _installInstrumentation()
   * pass (e.g. FloorCompositor V2 is created lazily on first render, after health init).
   * Safe to call multiple times — skips methods already wrapped for (effectId, instance).
   */
  refreshInstrumentation() {
    if (!this._initialized) return;
    const liveFc = this.floorCompositor
      ?? window.MapShine?.floorCompositorV2
      ?? this.effectComposer?._floorCompositorV2
      ?? null;
    if (liveFc) this.floorCompositor = liveFc;

    for (const contract of this.registry.getAll()) {
      const instance = safeCall(
        () => contract?.getInstance?.(this),
        `health.refresh.getInstance.${contract.effectId}`,
        Severity.COSMETIC,
        { fallback: null }
      );
      if (!instance) continue;
      const effectId = contract.effectId;
      const tryWrap = (methodName, kind) => {
        if (typeof instance[methodName] !== 'function') return;
        const already = this._wrappedMethods.some(
          (w) => w.effectId === effectId && w.instance === instance && w.name === methodName
        );
        if (already) return;
        this._wrapHeartbeat(instance, methodName, effectId, kind);
      };
      tryWrap('update', 'update');
      tryWrap('render', 'render');
      tryWrap('onFloorChange', 'floorChange');
    }
  }

  dispose() {
    for (const t of this._timers) {
      try { clearInterval(t); } catch (_) {}
    }
    this._timers.length = 0;
    for (const w of this._wrappedMethods) {
      try {
        if (w.instance && w.name && w.original) w.instance[w.name] = w.original;
      } catch (_) {}
    }
    this._wrappedMethods.length = 0;
    this._listeners.clear();
    this._waterFloorSignatureCache.clear();
    this._initialized = false;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  getSnapshot() {
    const runtime = this._getRuntimeSnapshot();
    this._pruneStaleHealthRecords(runtime);

    const byEffect = new Map();
    for (const rec of this._records.values()) {
      const group = byEffect.get(rec.effectId) || { effectId: rec.effectId, status: 'unknown', byLevel: [] };
      group.byLevel.push({
        levelKey: rec.levelKey,
        status: rec.status,
        rootCause: !!rec.rootCause,
        checks: rec.checks,
        firstSeenMs: rec.firstSeenMs,
        lastSeenMs: rec.lastSeenMs,
        lastRecoveredMs: rec.lastRecoveredMs ?? null,
      });
      if ((STATUS_WEIGHT[rec.status] || 0) > (STATUS_WEIGHT[group.status] || 0)) group.status = rec.status;
      byEffect.set(rec.effectId, group);
    }

    let overallStatus = 'healthy';
    for (const g of byEffect.values()) {
      if ((STATUS_WEIGHT[g.status] || 0) > (STATUS_WEIGHT[overallStatus] || 0)) overallStatus = g.status;
    }
    if (byEffect.size === 0) overallStatus = 'unknown';

    const activeFloor = Number(runtime?.activeFloor ?? 0);
    const activeFloorKey = `floor:${activeFloor}`;
    let activeFloorOverallStatus = 'healthy';
    for (const g of byEffect.values()) {
      for (const lvl of g.byLevel || []) {
        if (lvl.levelKey !== activeFloorKey && lvl.levelKey !== 'global:active') continue;
        if ((STATUS_WEIGHT[lvl.status] || 0) > (STATUS_WEIGHT[activeFloorOverallStatus] || 0)) {
          activeFloorOverallStatus = lvl.status;
        }
      }
    }
    if (byEffect.size === 0) activeFloorOverallStatus = 'unknown';

    const renderStack = captureRenderStack(this.floorCompositor, runtime);
    const renderStackFindings = evaluateRenderStackFindings(renderStack);

    return {
      meta: {
        timestamp: new Date().toISOString(),
        moduleVersion: game?.modules?.get?.('map-shine-advanced')?.version ?? null,
        activeFloorKey,
        activeFloorOverallStatus,
      },
      runtime,
      overallStatus,
      activeFloorOverallStatus,
      effects: Array.from(byEffect.values()),
      edges: this.dependencyGraph.getAllEdges(),
      renderStack,
      renderStackFindings,
      shaderCompiles: this._getShaderCompileDiagnostics(),
    };
  }

  /**
   * Get shader compilation diagnostics.
   * @private
   */
  _getShaderCompileDiagnostics() {
    const monitor = getShaderCompileMonitor();
    const snapshot = monitor.getDiagnosticSnapshot();
    const stats = monitor.getStats();

    return {
      ...snapshot,
      status: stats.timeouts > 0 ? 'degraded' : stats.errors > 0 ? 'degraded' : 'healthy',
      issues: stats.timeouts > 0 ? [`${stats.timeouts} shader compile timeout(s) detected`] : [],
    };
  }

  getEffectHealth(effectId, levelKey = null) {
    const id = String(effectId || '');
    if (!id) return null;
    if (levelKey) return this._records.get(`${id}|${levelKey}`) || null;
    return Array.from(this._records.values()).filter((r) => r.effectId === id);
  }

  runHealthCheck(target = null) {
    const wantedEffect = target && typeof target === 'object' ? (target.effectId || null) : null;
    const wantedLevel = target && typeof target === 'object' ? (target.levelKey || null) : null;
    this._evaluateContracts({ tiers: ['structural', 'behavioral'], effectId: wantedEffect, levelKey: wantedLevel });
    this._applyDependencyPropagation();
    this._emitSnapshot();
    return this.getSnapshot();
  }

  handleFloorChange(maxFloorIndex, context = null) {
    void maxFloorIndex;
    void context;
    this._evaluateContracts({ tiers: ['structural', 'behavioral'] });
    this._applyDependencyPropagation();
    this._emitSnapshot();
  }

  acknowledge(signature) {
    const s = String(signature || '').trim();
    if (!s) return false;
    this._acknowledged.add(s);
    return true;
  }

  /**
   * Rich diagnostics for Breaker Box detail pane (not part of getSnapshot JSON).
   * @param {string} effectId
   * @returns {object|null}
   */
  getEffectSurfaceDiagnostics(effectId) {
    const id = String(effectId || '');
    if (id === 'SpecularEffectV2') {
      const inst = this.floorCompositor?._specularEffect ?? null;
      return inst?.getHealthDiagnostics?.() ?? null;
    }
    if (id === 'GpuSceneMaskCompositor') {
      return this._buildGpuCompositorOutdoorsDiagnostics();
    }
    if (id === 'BuildingShadowsEffectV2') {
      const inst = this.floorCompositor?._buildingShadowEffect ?? null;
      return inst?.getHealthDiagnostics?.() ?? null;
    }
    return null;
  }

  /**
   * End-to-end _Outdoors trace for Breaker Box: manifest → tiles → GPU compositor → consumers.
   * @returns {object}
   */
  getOutdoorsTraceDiagnostics() {
    return this._buildOutdoorsTraceDiagnostics();
  }

  /** @private */
  _texBrief(tex) {
    if (!tex) return { present: false, uuid: null, size: null };
    const w = Number(tex.image?.width ?? tex.source?.data?.width ?? 0) || null;
    const h = Number(tex.image?.height ?? tex.source?.data?.height ?? 0) || null;
    return {
      present: true,
      uuid: tex.uuid ?? null,
      size: w && h ? `${w}×${h}` : null,
    };
  }

  /** @private */
  _buildOutdoorsTraceDiagnostics() {
    const scene = canvas?.scene ?? null;
    const ms = window.MapShine ?? null;
    const fc = this.floorCompositor
      ?? ms?.floorCompositorV2
      ?? ms?.effectComposer?._floorCompositorV2
      ?? null;
    const scn = ms?.sceneComposer ?? null;
    const comp = this.gpuSceneMaskCompositor
      ?? scn?._sceneMaskCompositor
      ?? null;
    const ctx = ms?.activeLevelContext ?? null;
    const activeFloor = ms?.floorStack?.getActiveFloor?.() ?? null;

    /** @type {{ key: string, hit: boolean, uuid: string|null, note?: string }[]} */
    const getFloorTextureAttempts = [];
    if (comp && typeof comp.getFloorTexture === 'function') {
      const keys = new Set();
      const b = Number(ctx?.bottom);
      const t = Number(ctx?.top);
      if (Number.isFinite(b) && Number.isFinite(t)) keys.add(`${b}:${t}`);
      if (activeFloor?.compositorKey) keys.add(String(activeFloor.compositorKey));
      try {
        const cak = comp._activeFloorKey;
        if (cak) keys.add(String(cak));
      } catch (_) {}
      keys.add('ground');
      for (const key of keys) {
        if (!key) continue;
        try {
          const tex = comp.getFloorTexture(key, 'outdoors');
          const br = this._texBrief(tex);
          getFloorTextureAttempts.push({
            key: String(key),
            hit: !!tex,
            uuid: br.uuid,
            size: br.size,
          });
        } catch (e) {
          getFloorTextureAttempts.push({ key: String(key), hit: false, uuid: null, size: null, note: String(e?.message || e) });
        }
      }
    }

    let manifestEnabledIds = [];
    try {
      manifestEnabledIds = collectEnabledMaskIds(scene) || [];
    } catch (_) {
      manifestEnabledIds = [];
    }
    const outdoorsInEnabledSet = manifestEnabledIds.some((id) => String(id).toLowerCase() === 'outdoors');

    let manifestFlag = null;
    try {
      manifestFlag = getMaskTextureManifest(scene);
    } catch (_) {
      manifestFlag = null;
    }
    const pbm = manifestFlag?.pathsByMaskId ?? null;
    const outdoorsManifestPath = pbm
      ? (pbm.outdoors || pbm.Outdoors || pbm.OUTDOORS || null)
      : null;

    let bundleOutdoors = null;
    try {
      const masks = scn?.currentBundle?.masks;
      const ent = Array.isArray(masks) ? masks.find((m) => (m?.id ?? m.type) === 'outdoors') : null;
      if (ent?.texture) {
        bundleOutdoors = { ...this._texBrief(ent.texture), fromBasePath: scn?.currentBundle?.basePath ?? null };
      } else {
        bundleOutdoors = { present: false, inBundleList: !!ent, fromBasePath: scn?.currentBundle?.basePath ?? null };
      }
    } catch (_) {
      bundleOutdoors = { error: true };
    }

    const tm = ms?.tileManager ?? null;
    let tileMaskCacheCount = 0;
    let tilesWithOutdoorsLoaded = 0;
    /** @type {object[]} */
    const tileSamples = [];
    try {
      const map = tm?._tileEffectMasks;
      if (map && typeof map.forEach === 'function') {
        map.forEach((m, tileId) => {
          tileMaskCacheCount++;
          const row = m?.get?.('outdoors');
          if (row?.texture) {
            tilesWithOutdoorsLoaded++;
            if (tileSamples.length < 12) {
              tileSamples.push({
                tileId: String(tileId),
                urlTail: row.url ? String(row.url).split('/').slice(-2).join('/') : null,
                ...this._texBrief(row.texture),
              });
            }
          }
        });
      }
    } catch (_) {}

    /** @type {object[]} */
    const floorMetaMaskTypes = [];
    try {
      if (comp?._floorMeta && typeof comp._floorMeta.entries === 'function') {
        for (const [fk, meta] of comp._floorMeta.entries()) {
          const list = meta?.masks ?? [];
          const o = list.find((m) => (m?.id ?? m.type) === 'outdoors');
          floorMetaMaskTypes.push({
            floorKey: String(fk),
            maskCount: list.length,
            outdoorsInList: !!o,
            outdoorsUuid: o?.texture?.uuid ?? null,
            outdoorsSize: o?.texture ? (() => {
              const w = Number(o.texture.image?.width ?? o.texture.source?.data?.width ?? 0);
              const h = Number(o.texture.image?.height ?? o.texture.source?.data?.height ?? 0);
              return w && h ? `${w}×${h}` : null;
            })() : null,
          });
        }
      }
    } catch (_) {}

    /** @type {object[]} */
    const floorGpuRt = [];
    try {
      if (comp?._floorCache && typeof comp._floorCache.entries === 'function') {
        for (const [fk, inner] of comp._floorCache.entries()) {
          const rt = inner?.get?.('outdoors');
          floorGpuRt.push({
            floorKey: String(fk),
            outdoorsRenderTarget: !!rt,
            texUuid: rt?.texture?.uuid ?? null,
          });
        }
      }
    } catch (_) {}

    const wc = ms?.weatherController ?? this.weatherController ?? null;
    const roof = wc?.roofMap ?? null;

    const reg = ms?.effectMaskRegistry ?? null;
    let registryOutdoors = null;
    try {
      const t = reg?.getMask?.('outdoors');
      registryOutdoors = { ...this._texBrief(t) };
    } catch (_) {
      registryOutdoors = { present: false, error: true };
    }

    const consumers = {};
    try {
      const bse = fc?._buildingShadowEffect;
      consumers.buildingShadows = {
        _outdoorsMaskSync: this._texBrief(bse?._outdoorsMask),
        paramsEnabled: !!bse?.params?.enabled,
      };
    } catch (_) {
      consumers.buildingShadows = { error: true };
    }
    try {
      const we = fc?._waterEffect;
      const u = we?._composeMaterial?.uniforms;
      const tex = u?.tOutdoorsMask?.value;
      consumers.water = {
        uHasOutdoorsMask: Number(u?.uHasOutdoorsMask?.value ?? 0),
        tOutdoorsMask: this._texBrief(tex),
      };
    } catch (_) {
      consumers.water = { error: true };
    }
    try {
      const ws = fc?._waterSplashesEffect;
      const activeFloorIndex = Number(window.MapShine?.floorStack?.getActiveFloor?.()?.index);
      const activeState = Number.isFinite(activeFloorIndex) ? ws?._floorStates?.get?.(activeFloorIndex) : null;
      const sampleFoamSystem = activeState?.foamSystems?.[0] ?? activeState?.foamSystems2?.[0] ?? null;
      const sampleBehavior = sampleFoamSystem?.behaviors?.find?.((b) => b?.type === 'FoamPlumeLifecycle') ?? null;
      consumers.waterSplashes = {
        enabled: !!ws?.enabled && !!ws?.params?.enabled,
        initialized: !!ws?._initialized,
        activeFloorIndex: Number.isFinite(activeFloorIndex) ? activeFloorIndex : null,
        floorStateKeys: (() => {
          try { return [...(ws?._floorStates?.keys?.() ?? [])]; } catch (_) { return []; }
        })(),
        activeFloorHasState: !!activeState,
        activeFloorPointCounts: activeState
          ? {
            edgePoints: Array.isArray(activeState.edgePoints) ? activeState.edgePoints.length : null,
            interiorPoints: Array.isArray(activeState.interiorPoints) ? activeState.interiorPoints.length : null,
          }
          : null,
        foamLifecycleOutdoors: sampleBehavior
          ? {
            hasOutdoorsMask: !!sampleBehavior._hasOutdoorsMask,
            outdoorsMaskTex: this._texBrief(sampleBehavior._outdoorsMaskTex),
            outdoorsMaskFlipY: !!sampleBehavior._outdoorsMaskFlipY,
            outdoorsMaskCpuPixels: !!sampleBehavior._outdoorsMaskData,
            outdoorsMaskCpuDims: (sampleBehavior._outdoorsMaskW > 0 && sampleBehavior._outdoorsMaskH > 0)
              ? `${sampleBehavior._outdoorsMaskW}×${sampleBehavior._outdoorsMaskH}`
              : null,
            indoorSuppressionStrength: Number(sampleBehavior._indoorSuppressionStrength ?? 0),
          }
          : null,
      };
    } catch (_) {
      consumers.waterSplashes = { error: true };
    }
    try {
      const sky = fc?._skyColorEffect;
      const u = sky?._composeMaterial?.uniforms;
      const tex = u?.tOutdoorsMask?.value;
      consumers.skyColor = {
        uHasOutdoorsMask: Number(u?.uHasOutdoorsMask?.value ?? 0),
        tOutdoorsMask: this._texBrief(tex),
      };
    } catch (_) {
      consumers.skyColor = { error: true };
    }
    try {
      const le = fc?._lightingEffect;
      const u = le?._composeMaterial?.uniforms;
      const tex = u?.tOutdoorsForRoofLight?.value;
      consumers.lighting = {
        uHasOutdoorsForRoofLight: Number(u?.uHasOutdoorsForRoofLight?.value ?? 0),
        tOutdoorsForRoofLight: this._texBrief(tex),
      };
    } catch (_) {
      consumers.lighting = { error: true };
    }
    try {
      const ce = fc?._cloudEffect;
      const pf = [0, 1, 2, 3].map((i) => !!(ce?._outdoorsMasks?.[i]));
      consumers.cloud = {
        legacyOutdoorsMask: this._texBrief(ce?._outdoorsMask),
        perFloorSlotsNonNull: pf,
        anyPerFloor: pf.some(Boolean),
      };
    } catch (_) {
      consumers.cloud = { error: true };
    }
    try {
      const ohs = fc?._overheadShadowEffect;
      consumers.overheadShadows = {
        outdoorsMask: this._texBrief(ohs?.outdoorsMask),
      };
    } catch (_) {
      consumers.overheadShadows = { error: true };
    }

    return {
      timestamp: Date.now(),
      scene: {
        id: scene?.id ?? null,
        name: scene?.name ?? null,
        levelsEnabled: !!scene && isLevelsEnabledForScene(scene),
        activeLevelContext: ctx
          ? { bottom: ctx.bottom, top: ctx.top, key: `${ctx.bottom}:${ctx.top}` }
          : null,
        activeFloor: activeFloor
          ? {
            index: activeFloor.index,
            compositorKey: activeFloor.compositorKey ?? null,
            elevationMin: activeFloor.elevationMin,
            elevationMax: activeFloor.elevationMax,
          }
          : null,
        floorStackCount: ms?.floorStack?.getFloors?.()?.length ?? 0,
      },
      manifest: {
        outdoorsInEnabledMaskIds: outdoorsInEnabledSet,
        enabledMaskIds: manifestEnabledIds,
        flagHasManifest: !!manifestFlag,
        flagBasePath: manifestFlag?.basePath ?? null,
        outdoorsPathInFlag: typeof outdoorsManifestPath === 'string' ? outdoorsManifestPath : null,
      },
      sceneComposerBundle: bundleOutdoors,
      tileManager: {
        cachedTileMaskMaps: tileMaskCacheCount,
        tilesWithOutdoorsTexture: tilesWithOutdoorsLoaded,
        effectMaskVramMb: tm ? Number((tm._tileEffectMaskVramBytes ?? 0) / (1024 * 1024)).toFixed(2) : null,
        effectMaskVramBudgetMb: tm?.effectMaskVramBudget
          ? Number(tm.effectMaskVramBudget / (1024 * 1024)).toFixed(0)
          : null,
        samples: tileSamples,
      },
      gpuCompositor: {
        present: !!comp,
        _activeFloorKey: (() => {
          try { return comp?._activeFloorKey ?? null; } catch (_) { return null; }
        })(),
        getFloorTextureAttempts,
        floorMetaByKey: floorMetaMaskTypes,
        floorCacheGpuOutdoors: floorGpuRt,
      },
      registry: { outdoors: registryOutdoors },
      weatherController: { roofMap: this._texBrief(roof) },
      floorCompositorSync: {
        lastOutdoorsFloorKey: fc?._lastOutdoorsFloorKey ?? null,
        lastOutdoorsTexture: this._texBrief(fc?._lastOutdoorsTexture),
      },
      consumers,
    };
  }

  /** @private */
  _buildGpuCompositorOutdoorsDiagnostics() {
    const comp = this.gpuSceneMaskCompositor
      ?? window.MapShine?.sceneComposer?._sceneMaskCompositor
      ?? null;
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const active = window.MapShine?.floorStack?.getActiveFloor?.() ?? null;
    if (!comp) {
      return { timestamp: Date.now(), compositorPresent: false, message: 'GpuSceneMaskCompositor not available' };
    }
    /** @type {object[]} */
    const rows = [];
    const metaKeys = (() => {
      try {
        return comp._floorMeta && typeof comp._floorMeta.keys === 'function'
          ? [...comp._floorMeta.keys()].map(String).sort()
          : [];
      } catch (_) {
        return [];
      }
    })();
    const activeCk = String(active?.compositorKey ?? '');
    const activeIdx = Number.isFinite(Number(active?.index)) ? Number(active.index) : null;
    for (const f of floors) {
      const ck = String(f?.compositorKey ?? '');
      const inMeta = (() => {
        try { return !!comp._floorMeta?.has?.(ck); } catch (_) { return false; }
      })();
      const texDirect = comp.getFloorTexture?.(ck, 'outdoors') ?? null;
      const bottom = Number(f?.elevationMin);
      const siblingKeys = metaKeys.filter((k) => Number(String(k).split(':')[0]) === bottom);
      let resolvedTex = texDirect;
      let resolvedNote = texDirect ? `getFloorTexture("${ck}")` : null;
      if (!resolvedTex && Number.isFinite(bottom)) {
        for (const sk of siblingKeys.sort()) {
          const t = comp.getFloorTexture?.(sk, 'outdoors') ?? null;
          if (t) {
            resolvedTex = t;
            resolvedNote = `getFloorTexture("${sk}") via same elevation bottom`;
            break;
          }
        }
      }
      const maskInMetaBundle = (() => {
        try {
          const bundle = comp._floorMeta?.get?.(ck);
          return !!(bundle?.masks?.some?.((m) => (m.id ?? m.type) === 'outdoors'));
        } catch (_) {
          return false;
        }
      })();
      const isActiveFloorRow = activeCk && ck === activeCk;
      rows.push({
        floorIndex: f.index,
        compositorKey: ck,
        elevationMin: f.elevationMin,
        elevationMax: f.elevationMax,
        isActiveFloor: !!isActiveFloorRow,
        bundleInMeta: inMeta,
        outdoorsInMetaBundle: maskInMetaBundle,
        getFloorTextureHit: !!texDirect,
        resolvedOutdoors: !!resolvedTex,
        outdoorsValidForSpecular: !!resolvedTex,
        resolvedNote,
        siblingMetaKeys: siblingKeys,
        textureUuid: resolvedTex?.uuid ?? null,
      });
    }
    const activeRow = rows.find((r) => r.isActiveFloor) ?? null;
    return {
      timestamp: Date.now(),
      compositorPresent: true,
      activeFloorIndex: activeIdx,
      activeCompositorKey: activeCk || null,
      activeFloorOutdoorsSummary: activeRow
        ? {
          compositorKey: activeRow.compositorKey,
          resolvedOutdoors: activeRow.resolvedOutdoors,
          outdoorsInMetaBundle: activeRow.outdoorsInMetaBundle,
          getFloorTextureHit: activeRow.getFloorTextureHit,
          textureUuid: activeRow.textureUuid,
          resolvedNote: activeRow.resolvedNote,
        }
        : null,
      metaKeyCount: metaKeys.length,
      metaKeysSample: metaKeys.slice(0, 12),
      floorRows: rows,
      outdoorsHelp:
        'Specular samples uRoofMap0..3 via uOutdoorsFloorIdx. White fallback texture => shader treats full scene as outdoor. Bundle column = outdoors entry in cached floor mask list; direct = getFloorTexture(activeKey).',
    };
  }

  exportDiagnostics() {
    const snapshot = this.getSnapshot();
    return {
      meta: {
        ...snapshot.meta,
        foundryVersion: game?.version ?? game?.release?.version ?? null,
        sceneId: canvas?.scene?.id ?? null,
        sceneName: canvas?.scene?.name ?? null,
      },
      runtime: snapshot.runtime,
      health: {
        overallStatus: snapshot.overallStatus,
        activeFloorOverallStatus: snapshot.activeFloorOverallStatus ?? snapshot.meta?.activeFloorOverallStatus ?? null,
        activeFloorKey: snapshot.meta?.activeFloorKey ?? null,
        effects: snapshot.effects.map((e) => ({
          effectId: e.effectId,
          status: e.status,
          byLevel: e.byLevel.map((l) => ({
            levelKey: l.levelKey,
            status: l.status,
            rootCause: l.rootCause,
            checks: l.checks,
          })),
        })),
      },
      graph: {
        edges: snapshot.edges,
      },
      renderStack: {
        passes: snapshot.renderStack?.passes ?? [],
        bindings: snapshot.renderStack?.bindings ?? [],
        windowLightMeta: snapshot.renderStack?.windowLightMeta ?? null,
        busMeta: snapshot.renderStack?.busMeta ?? null,
        runtime: snapshot.renderStack?.runtime ?? null,
        notes: snapshot.renderStack?.notes ?? [],
      },
      renderStackFindings: snapshot.renderStackFindings ?? [],
      outdoorsTrace: this._buildOutdoorsTraceDiagnostics(),
      shaderCompiles: snapshot.shaderCompiles,
    };
  }

  _startScheduler() {
    this._timers.push(setInterval(() => {
      this._evaluateContracts({ tiers: ['structural'] });
      this._applyDependencyPropagation();
      this._emitSnapshot();
    }, 1000));

    this._timers.push(setInterval(() => {
      this._evaluateContracts({ tiers: ['behavioral'] });
      this._applyDependencyPropagation();
      this._emitSnapshot();
    }, 2000));
  }

  _installInstrumentation() {
    for (const contract of this.registry.getAll()) {
      const instance = safeCall(
        () => contract?.getInstance?.(this),
        `health.wrap.getInstance.${contract?.effectId}`,
        Severity.COSMETIC,
        { fallback: null }
      );
      if (!instance) continue;
      this._wrapHeartbeat(instance, 'update', contract.effectId, 'update');
      this._wrapHeartbeat(instance, 'render', contract.effectId, 'render');
      this._wrapHeartbeat(instance, 'onFloorChange', contract.effectId, 'floorChange');
    }
  }

  _wrapHeartbeat(instance, methodName, effectId, kind) {
    if (!instance || typeof instance[methodName] !== 'function') return;
    const original = instance[methodName];
    const hb = this._heartbeats.get(effectId) || { updateCount: 0, renderCount: 0, floorChangeCount: 0, lastUpdateMs: 0, lastRenderMs: 0, lastFloorChangeMs: 0 };
    this._heartbeats.set(effectId, hb);
    const service = this;
    instance[methodName] = function wrappedHealthHeartbeat(...args) {
      const now = Date.now();
      if (kind === 'update') {
        hb.updateCount++;
        hb.lastUpdateMs = now;
      } else if (kind === 'render') {
        hb.renderCount++;
        hb.lastRenderMs = now;
      } else if (kind === 'floorChange') {
        hb.floorChangeCount++;
        hb.lastFloorChangeMs = now;
      }
      return original.apply(this, args);
    };
    this._wrappedMethods.push({ instance, name: methodName, original, effectId });
    void service;
  }

  _evaluateContracts({ tiers = ['structural', 'behavioral'], effectId = null, levelKey = null } = {}) {
    const contracts = this.registry.getAll();
    for (const contract of contracts) {
      if (effectId && contract.effectId !== effectId) continue;
      const instance = safeCall(
        () => contract.getInstance?.(this),
        `health.eval.getInstance.${contract.effectId}`,
        Severity.COSMETIC,
        { fallback: null }
      );
      const levelKeys = safeCall(
        () => contract.getLevelKeys?.(instance, this),
        `health.eval.getLevelKeys.${contract.effectId}`,
        Severity.COSMETIC,
        { fallback: [] }
      ) || [];

      const scopedLevels = levelKey ? levelKeys.filter((k) => k === levelKey) : levelKeys;
      for (const lk of scopedLevels) {
        this._evaluateContractLevel(contract, instance, lk, tiers);
      }
    }
  }

  _evaluateContractLevel(contract, instance, levelKey, allowedTiers) {
    const checks = [];
    const now = Date.now();
    for (const rule of (contract.rules || [])) {
      const tier = rule.tier || 'structural';
      if (!allowedTiers.includes(tier)) continue;
      const shouldRun = safeCall(
        () => (typeof rule.when === 'function' ? !!rule.when(instance, this, levelKey) : true),
        `health.rule.when.${contract.effectId}.${rule.id}`,
        Severity.COSMETIC,
        { fallback: false }
      );
      if (!shouldRun) {
        checks.push({
          ruleId: rule.id,
          tier,
          result: 'skipped',
          severity: rule.severity || 'info',
          message: 'Condition not active',
        });
        continue;
      }

      const out = safeCall(
        () => rule.check(instance, this, levelKey),
        `health.rule.check.${contract.effectId}.${rule.id}`,
        Severity.DEGRADED,
        { fallback: { pass: false, message: 'Rule evaluation failed', evidence: null } }
      );

      const skipped = !!out?.skipped;
      checks.push({
        ruleId: rule.id,
        tier,
        result: skipped ? 'skipped' : (out?.pass ? 'pass' : 'fail'),
        severity: rule.severity || 'warn',
        message: String(out?.message || (out?.pass ? 'Pass' : 'Fail')),
        evidence: out?.evidence || undefined,
      });
    }

    const status = this._deriveStatus(checks);
    const key = `${contract.effectId}|${levelKey}`;
    const prev = this._records.get(key) || null;
    const rec = {
      effectId: contract.effectId,
      levelKey,
      status,
      firstSeenMs: prev?.firstSeenMs || now,
      lastSeenMs: now,
      lastRecoveredMs: prev?.lastRecoveredMs ?? null,
      rootCause: status !== 'healthy' && status !== 'unknown',
      checks,
    };

    if (prev && prev.status !== 'healthy' && status === 'healthy') {
      rec.lastRecoveredMs = now;
    }
    this._records.set(key, rec);
  }

  _deriveStatus(checks) {
    if (!checks || checks.length === 0) return 'unknown';
    let status = 'healthy';
    for (const c of checks) {
      if (c.result !== 'fail') continue;
      const s = SEVERITY_TO_STATUS[c.severity] || 'degraded';
      if ((STATUS_WEIGHT[s] || 0) > (STATUS_WEIGHT[status] || 0)) status = s;
    }
    return status;
  }

  /**
   * Drop health rows for non-multi-floor effects when the user has changed floors,
   * so the Breaker Box does not show stale `floor:0` vs `floor:1` rows side by side.
   */
  _pruneStaleHealthRecords(runtime) {
    const activeFloor = Number(runtime?.activeFloor ?? 0);
    const activeKey = `floor:${activeFloor}`;
    const multiFloorEffects = new Set(['WaterEffectV2', 'WaterSplashesEffectV2', 'FireEffectV2', 'DustEffectV2']);
    for (const key of [...this._records.keys()]) {
      const pipe = key.indexOf('|');
      if (pipe <= 0) continue;
      const effectId = key.slice(0, pipe);
      const levelKey = key.slice(pipe + 1);
      if (multiFloorEffects.has(effectId)) continue;
      if (levelKey === 'global:active') continue;
      if (levelKey.startsWith('floor:') && levelKey !== activeKey) {
        this._records.delete(key);
      }
    }

    // FireEffectV2 is multi-floor (skipped in the loop above) but rows must not linger for floors
    // that no longer appear in getLevelKeys — e.g. after switching to a floor with no fire masks.
    const fire = this.floorCompositor?._fireEffect;
    const fireAllowed = new Set();
    if (fire?._floorStates && typeof fire._floorStates.keys === 'function') {
      for (const idx of fire._floorStates.keys()) fireAllowed.add(`floor:${idx}`);
    }
    fireAllowed.add(activeKey);
    for (const key of [...this._records.keys()]) {
      if (!key.startsWith('FireEffectV2|')) continue;
      const pipe = key.indexOf('|');
      const lk = key.slice(pipe + 1);
      if (!lk.startsWith('floor:')) continue;
      if (!fireAllowed.has(lk)) this._records.delete(key);
    }
  }

  /**
   * Only propagate dependency degradation along matching level keys (or from global player light
   * to the active floor row). Prevents `floor:0` upstream checks from marking `floor:1` downstream.
   */
  _shouldPropagateToRecord(rootLevelKey, targetRec, runtime) {
    const toKey = targetRec?.levelKey;
    if (!toKey) return false;
    if (rootLevelKey === toKey) return true;
    const active = Number(runtime?.activeFloor ?? 0);
    if (rootLevelKey === 'global:active' && toKey === `floor:${active}`) return true;
    return false;
  }

  _applyDependencyPropagation() {
    // Reset root cause flags first
    for (const rec of this._records.values()) {
      rec.rootCause = rec.status !== 'healthy' && rec.status !== 'unknown';
    }

    const runtime = this._getRuntimeSnapshot();
    const roots = Array.from(this._records.values()).filter((r) => r.rootCause);
    for (const root of roots) {
      const rootFailedRules = (root.checks || [])
        .filter((c) => c?.result === 'fail' && !String(c?.ruleId || '').startsWith('propagated:'))
        .map((c) => c?.ruleId)
        .filter(Boolean)
        .slice(0, 3);
      const outgoing = this.dependencyGraph.getOutgoing(root.effectId);
      for (const edge of outgoing) {
        // Contextual edges document loose coupling; do not auto-degrade downstream effects.
        if (edge.type === 'contextual') continue;

        const impacted = Array.from(this._records.values()).filter((r) => r.effectId === edge.to);
        for (const rec of impacted) {
          if (!this._shouldPropagateToRecord(root.levelKey, rec, runtime)) continue;
          if ((STATUS_WEIGHT[rec.status] || 0) >= STATUS_WEIGHT.broken) continue;
          if (edge.type === 'optional') {
            if ((STATUS_WEIGHT[rec.status] || 0) < STATUS_WEIGHT.degraded) rec.status = 'degraded';
          } else {
            if ((STATUS_WEIGHT[rec.status] || 0) < STATUS_WEIGHT.degraded) rec.status = 'degraded';
          }
          rec.rootCause = false;
          const propagatedRuleId = `propagated:${root.effectId}:${root.levelKey}->${rec.effectId}`;
          const alreadyPresent = (rec.checks || []).some((c) => c?.ruleId === propagatedRuleId && c?.result === 'fail');
          if (alreadyPresent) continue;
          const humanRules = rootFailedRules.length ? rootFailedRules.join(', ') : 'see upstream checks';
          rec.checks.push({
            ruleId: propagatedRuleId,
            tier: 'behavioral',
            result: 'fail',
            severity: 'warn',
            message: `Downstream of ${root.effectId} (${root.levelKey}) — upstream failed: ${humanRules}`,
            evidence: {
              from: root.effectId,
              fromLevelKey: root.levelKey,
              toLevelKey: rec.levelKey,
              edgeType: edge.type,
              rootFailedRules,
            },
          });
        }
      }
    }
  }

  _emitSnapshot() {
    const snapshot = this.getSnapshot();
    const sig = JSON.stringify({
      overallStatus: snapshot.overallStatus,
      activeFloorOverallStatus: snapshot.activeFloorOverallStatus,
      effects: snapshot.effects.map((e) => [e.effectId, e.status]),
      stackSig: (snapshot.renderStack?.passes || []).map((p) => [p.id, p.enabled]),
    });
    if (this._lastGlobalSig === sig) return;
    this._lastGlobalSig = sig;
    for (const listener of this._listeners) {
      safeCall(() => listener(snapshot), 'health.listener', Severity.COSMETIC);
    }
  }

  _getRuntimeSnapshot() {
    const activeFloor = window.MapShine?.floorStack?.getActiveFloor?.();
    const visibleFloors = [];
    if (Number.isFinite(activeFloor?.index)) {
      for (let i = 0; i <= activeFloor.index; i++) visibleFloors.push(i);
    }
    const camera = this.floorCompositor?.camera || window.MapShine?.sceneComposer?.camera || null;
    const tm = this.timeManager || this.effectComposer?.getTimeManager?.();
    return {
      activeFloor: Number.isFinite(activeFloor?.index) ? activeFloor.index : 0,
      visibleFloors,
      levelContextKey: `${window.MapShine?.activeLevelContext?.bottom ?? 'na'}:${window.MapShine?.activeLevelContext?.top ?? 'na'}`,
      camera: {
        zoom: Number(window.MapShine?.sceneComposer?.currentZoom ?? camera?.zoom ?? 1),
        position: {
          x: Number(camera?.position?.x ?? 0),
          y: Number(camera?.position?.y ?? 0),
          z: Number(camera?.position?.z ?? 0),
        },
      },
      frameState: {
        elapsed: Number(tm?.elapsed ?? 0),
        delta: Number(tm?.delta ?? 0),
        fps: Number(tm?.fps ?? 0),
        paused: !!tm?.paused,
      },
    };
  }

  _registerBuiltInEdges() {
    this.dependencyGraph.addEdge('CloudEffectV2', 'LightingEffectV2', 'required');
    this.dependencyGraph.addEdge('OverheadShadowsEffectV2', 'LightingEffectV2', 'required');
    this.dependencyGraph.addEdge('BuildingShadowsEffectV2', 'LightingEffectV2', 'required');
    this.dependencyGraph.addEdge('WaterEffectV2', 'WindowLightEffectV2', 'contextual');
    this.dependencyGraph.addEdge('WaterEffectV2', 'WaterSplashesEffectV2', 'contextual');
    this.dependencyGraph.addEdge('WindowLightEffectV2', 'LightingEffectV2', 'required');
    this.dependencyGraph.addEdge('PlayerLightEffectV2', 'LightingEffectV2', 'required');
    this.dependencyGraph.addEdge('FireEffectV2', 'LightingEffectV2', 'contextual');
    this.dependencyGraph.addEdge('SkyColorEffectV2', 'WaterEffectV2', 'contextual');
    this.dependencyGraph.addEdge('WaterEffectV2', 'BloomEffectV2', 'contextual');
    this.dependencyGraph.addEdge('SkyColorEffectV2', 'WindowLightEffectV2', 'contextual');
    this.dependencyGraph.addEdge('SkyColorEffectV2', 'DustEffectV2', 'contextual');
    this.dependencyGraph.addEdge('GpuSceneMaskCompositor', 'SpecularEffectV2', 'optional');
  }

  _registerBuiltInContracts() {
    const activeLevelKeys = (ctx) => [`floor:${ctx._getRuntimeSnapshot().activeFloor}`];
    const waterFloorSignature = (floorData) => {
      const sdf = floorData?.waterData?.texture || null;
      const raw = floorData?.rawMask || null;
      const w = Number(sdf?.image?.width || 0);
      const h = Number(sdf?.image?.height || 0);
      const rw = Number(raw?.image?.width || 0);
      const rh = Number(raw?.image?.height || 0);
      return [String(sdf?.uuid || 'none'), `${w}x${h}`, String(raw?.uuid || 'none'), `${rw}x${rh}`].join('|');
    };
    const heartbeatRule = (effectId, maxAgeMs = 5000) => ({
      id: 'updateHeartbeat',
      tier: 'behavioral',
      severity: 'warn',
      check: (_instance, ctx) => {
        const hb = ctx._heartbeats.get(effectId);
        const now = Date.now();
        const ageMs = now - Number(hb?.lastUpdateMs || 0);
        const active = Number(hb?.updateCount || 0) > 0 && ageMs <= maxAgeMs;
        return {
          pass: active,
          message: active ? 'Update heartbeat active' : 'No recent update heartbeat',
          evidence: { updateCount: hb?.updateCount || 0, lastUpdateAgeMs: ageMs },
        };
      },
    });

    this.registry.register('WaterEffectV2', {
      effectId: 'WaterEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._waterEffect ?? null,
      getLevelKeys: (instance, ctx) => {
        const keys = [];
        const floorMap = instance?._floorWater;
        if (floorMap && typeof floorMap.keys === 'function') {
          for (const idx of floorMap.keys()) keys.push(`floor:${idx}`);
        }
        if (keys.length === 0) {
          const active = ctx._getRuntimeSnapshot().activeFloor;
          keys.push(`floor:${active}`);
        }
        return keys;
      },
      rules: [
        {
          id: 'initialized',
          tier: 'structural',
          severity: 'error',
          check: (instance) => ({
            pass: !!instance?._initialized,
            message: instance?._initialized ? 'Initialized' : 'Water effect not initialized',
          }),
        },
        {
          id: 'composeMaterial',
          tier: 'structural',
          severity: 'error',
          check: (instance) => ({
            pass: !!instance?._composeMaterial,
            message: instance?._composeMaterial ? 'Compose material present' : 'Missing compose material',
          }),
        },
        {
          id: 'floorDataMap',
          tier: 'structural',
          severity: 'warn',
          check: (instance, _ctx, levelKey) => {
            const idx = Number(String(levelKey).split(':')[1]);
            const hasFloorData = !!instance?._floorWater?.has?.(idx);
            const expected = Array.isArray(instance?._waterTiles)
              ? instance._waterTiles.some((t) => Number(t?.floorIndex) === idx)
              : false;
            if (!expected && !hasFloorData) {
              return { pass: true, skipped: true, message: 'Intentional absence (no expected water on level)' };
            }
            return {
              pass: hasFloorData,
              message: hasFloorData ? 'Floor water data available' : 'Expected water data missing on level',
              evidence: { level: idx, expected },
            };
          },
        },
        {
          id: 'floor0SignatureStability',
          tier: 'behavioral',
          severity: 'warn',
          check: (instance, ctx) => {
            const floorZero = instance?._floorWater?.get?.(0);
            if (!floorZero) {
              return { pass: true, skipped: true, message: 'No floor 0 water data to compare' };
            }
            const sig = waterFloorSignature(floorZero);
            const prev = ctx._waterFloorSignatureCache.get('WaterEffectV2|floor:0');
            ctx._waterFloorSignatureCache.set('WaterEffectV2|floor:0', sig);
            if (!prev) {
              return { pass: true, skipped: true, message: 'Captured initial floor 0 water signature', evidence: { signature: sig } };
            }
            const stable = prev === sig;
            return {
              pass: stable,
              message: stable
                ? 'Floor 0 water signature stable across checks'
                : 'Floor 0 water signature changed across checks (possible floor-sensitive drift)',
              evidence: { previous: prev, current: sig },
            };
          },
        },
        {
          id: 'multiFloorBindingRisk',
          tier: 'behavioral',
          severity: 'warn',
          check: (instance, ctx) => {
            const runtime = ctx._getRuntimeSnapshot();
            const active = Number(runtime?.activeFloor ?? 0);
            const selected = Number(instance?._activeFloorIndex ?? 0);
            const floors = [];
            if (instance?._floorWater?.keys) {
              for (const idx of instance._floorWater.keys()) floors.push(Number(idx));
            }
            const hasFloor0 = floors.includes(0);
            const visibleWithWater = floors.filter((f) => f >= 0 && f <= active).length;
            if (!hasFloor0 || visibleWithWater <= 1 || active <= 0) {
              return {
                pass: true,
                skipped: true,
                message: 'No multi-floor water overlap in current visibility band',
                evidence: { activeFloor: active, selectedFloorData: selected, floorDataFloors: floors },
              };
            }
            const risky = selected !== 0;
            return {
              pass: !risky,
              message: risky
                ? 'Ground-floor water is rendered while higher-floor water data is bound (possible appearance drift)'
                : 'Ground-floor water bound while multiple floors visible',
              evidence: {
                activeFloor: active,
                selectedFloorData: selected,
                floorDataFloors: floors,
                visibleFloors: runtime?.visibleFloors || [],
              },
            };
          },
        },
        heartbeatRule('WaterEffectV2', 5000),
      ],
    });

    this.registry.register('CloudEffectV2', {
      effectId: 'CloudEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._cloudEffect ?? null,
      getLevelKeys: (_instance, ctx) => activeLevelKeys(ctx),
      rules: [
        {
          id: 'initialized',
          tier: 'structural',
          severity: 'error',
          check: (instance) => ({
            pass: !!instance?._initialized,
            message: instance?._initialized ? 'Initialized' : 'Cloud effect not initialized',
          }),
        },
        {
          id: 'shadowTarget',
          tier: 'structural',
          severity: 'error',
          check: (instance) => ({
            pass: !!instance?._shadowRT?.texture,
            message: instance?._shadowRT?.texture ? 'Cloud shadow texture available' : 'Cloud shadow RT missing',
          }),
        },
        heartbeatRule('CloudEffectV2', 6000),
      ],
    });

    this.registry.register('OverheadShadowsEffectV2', {
      effectId: 'OverheadShadowsEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._overheadShadowEffect ?? null,
      getLevelKeys: (_instance, ctx) => activeLevelKeys(ctx),
      rules: [
        {
          id: 'material',
          tier: 'structural',
          severity: 'error',
          check: (instance) => ({
            pass: !!instance?.material,
            message: instance?.material ? 'Shadow material available' : 'Overhead shadow material missing',
          }),
        },
        {
          id: 'targets',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            const pass = !!instance?.shadowTarget?.texture && !!instance?.roofTarget?.texture;
            return {
              pass,
              message: pass ? 'Core capture targets available' : 'Missing roof/shadow targets',
            };
          },
        },
        heartbeatRule('OverheadShadowsEffectV2', 6000),
      ],
    });

    this.registry.register('WindowLightEffectV2', {
      effectId: 'WindowLightEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._windowLightEffect ?? null,
      getLevelKeys: (_instance, ctx) => activeLevelKeys(ctx),
      rules: [
        {
          id: 'initialized',
          tier: 'structural',
          severity: 'error',
          check: (instance) => ({
            pass: !!instance?._initialized && !!instance?._scene,
            message: instance?._initialized ? 'Initialized with scene' : 'Window light not initialized',
          }),
        },
        {
          id: 'overlayMap',
          tier: 'structural',
          severity: 'warn',
          check: (instance) => {
            const count = Number(instance?._overlays?.size || 0);
            return {
              pass: count >= 0,
              skipped: count === 0,
              message: count > 0 ? `Overlays present (${count})` : 'No overlays discovered (possibly intentional)',
              evidence: { overlayCount: count },
            };
          },
        },
        {
          id: 'activeFloorOverlayReadiness',
          tier: 'behavioral',
          severity: 'warn',
          check: (instance, ctx) => {
            const active = Number(ctx._getRuntimeSnapshot()?.activeFloor ?? 0);
            const overlays = Array.from(instance?._overlays?.values?.() || []);
            const sameFloor = overlays.filter((e) => Number(e?.floorIndex) === active);
            if (sameFloor.length === 0) {
              return {
                pass: true,
                skipped: true,
                message: 'No window overlays authored for active floor',
                evidence: { activeFloor: active, totalOverlays: overlays.length },
              };
            }
            const notVisible = sameFloor.filter((e) => !e?.mesh?.visible);
            const notReady = sameFloor.filter((e) => Number(e?.material?.uniforms?.uMaskReady?.value || 0) < 0.5);
            const roofGateUnexpected = sameFloor.filter((e) => Number(e?.material?.uniforms?.uAllowRoofGate?.value ?? 0) > 0.5 && Number(e?.floorIndex) > 0);
            const pass = notVisible.length === 0 && notReady.length === 0 && roofGateUnexpected.length === 0;
            return {
              pass,
              message: pass
                ? 'Active-floor window overlays are visible and mask-ready'
                : 'Active-floor window overlays have visibility/mask/gating issues',
              evidence: {
                activeFloor: active,
                sameFloorOverlayCount: sameFloor.length,
                notVisibleCount: notVisible.length,
                notReadyCount: notReady.length,
                roofGateUnexpectedCount: roofGateUnexpected.length,
              },
            };
          },
        },
        {
          id: 'upperFloorWindowClassificationGap',
          tier: 'behavioral',
          severity: 'warn',
          check: (instance, ctx) => {
            const active = Number(ctx._getRuntimeSnapshot()?.activeFloor ?? 0);
            if (active < 1) {
              return { pass: true, skipped: true, message: 'Ground floor — upper-floor classification check N/A' };
            }
            const entries = Array.from(instance?._overlays?.entries?.() || []);
            const tiles = entries.filter(([id]) => id && id !== '__bg_image__');
            if (tiles.length === 0) {
              return { pass: true, skipped: true, message: 'No per-tile window overlays to compare' };
            }
            const onActive = tiles.filter(([, e]) => Number(e?.floorIndex) === active);
            if (onActive.length > 0) {
              return {
                pass: true,
                message: `Active floor ${active} has ${onActive.length} tile overlay(s)`,
                evidence: { activeFloor: active, onActiveCount: onActive.length, totalTileOverlays: tiles.length },
              };
            }
            const floors = [...new Set(tiles.map(([, e]) => Number(e?.floorIndex) || 0))].sort((a, b) => a - b);
            return {
              pass: false,
              message: `Active floor ${active} has no tile overlays while ${tiles.length} exist on other floor indices — likely Levels/floor-index wiring drift`,
              evidence: { activeFloor: active, totalTileOverlays: tiles.length, floorsSeen: floors },
            };
          },
        },
        heartbeatRule('WindowLightEffectV2', 7000),
      ],
    });

    this.registry.register('PlayerLightEffectV2', {
      effectId: 'PlayerLightEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._playerLightEffect ?? null,
      getLevelKeys: () => ['global:active'],
      rules: [
        {
          id: 'runtimeBound',
          tier: 'structural',
          severity: 'warn',
          check: (instance) => {
            const pass = !!instance?.renderer && !!instance?.camera;
            return {
              pass,
              message: pass ? 'Renderer/camera bound' : 'Player light runtime bindings missing',
            };
          },
        },
        {
          id: 'groupOrLight',
          tier: 'structural',
          severity: 'warn',
          check: (instance) => {
            const hasOutput = !!instance?._group || !!instance?._torchLightSource || !!instance?._flashlightLightSource;
            return {
              pass: hasOutput,
              message: hasOutput ? 'Player light output objects present' : 'No active player light output objects',
            };
          },
        },
        heartbeatRule('PlayerLightEffectV2', 7000),
      ],
    });

    this.registry.register('FireEffectV2', {
      effectId: 'FireEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._fireEffect ?? null,
      getLevelKeys: (instance, ctx) => {
        const keysSet = new Set();
        const floorStates = instance?._floorStates;
        if (floorStates && typeof floorStates.keys === 'function') {
          for (const idx of floorStates.keys()) keysSet.add(`floor:${idx}`);
        }
        keysSet.add(`floor:${ctx._getRuntimeSnapshot().activeFloor}`);
        return [...keysSet].sort((a, b) => {
          const na = Number(String(a).replace(/^floor:/, ''));
          const nb = Number(String(b).replace(/^floor:/, ''));
          return (Number.isFinite(na) ? na : 0) - (Number.isFinite(nb) ? nb : 0);
        });
      },
      rules: [
        {
          id: 'initialized',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (!instance?.enabled || !instance?.params?.enabled) {
              return { pass: true, skipped: true, message: 'Fire disabled' };
            }
            return {
              pass: !!instance?._initialized,
              message: instance?._initialized ? 'Initialized' : 'Fire effect not initialized',
            };
          },
        },
        {
          id: 'batchRenderer',
          tier: 'structural',
          severity: 'error',
          check: (instance, _ctx, levelKey) => {
            if (!instance?.enabled || !instance?.params?.enabled) {
              return { pass: true, skipped: true, message: 'Fire disabled' };
            }
            const m = typeof levelKey === 'string' ? /^floor:(\d+)$/.exec(levelKey) : null;
            const floorIndex = m ? Number(m[1]) : NaN;
            if (!Number.isFinite(floorIndex)) {
              return {
                pass: !!instance?._batchRenderer,
                message: instance?._batchRenderer ? 'Batch renderer present' : 'Fire batch renderer missing',
              };
            }
            const st = instance._floorStates?.get(floorIndex);
            if (!st) {
              return { pass: true, skipped: true, message: 'No fire on this floor' };
            }
            const nSys =
              (Number(st.systems?.length) || 0) +
              (Number(st.emberSystems?.length) || 0) +
              (Number(st.smokeSystems?.length) || 0);
            if (st.batchRenderer) {
              return { pass: true, message: 'Batch renderer present' };
            }
            if (nSys === 0) {
              return { pass: true, skipped: true, message: 'No fire on this floor' };
            }
            return { pass: false, message: 'Fire batch renderer missing' };
          },
        },
        heartbeatRule('FireEffectV2', 7000),
      ],
    });

    this.registry.register('LightingEffectV2', {
      effectId: 'LightingEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._lightingEffect ?? null,
      getLevelKeys: (_instance, ctx) => activeLevelKeys(ctx),
      rules: [
        {
          id: 'initialized',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (instance?.params && instance.params.enabled === false) {
              return { pass: true, skipped: true, message: 'Lighting disabled in params' };
            }
            return {
              pass: !!instance?._initialized,
              message: instance?._initialized ? 'Initialized' : 'Lighting effect not initialized',
            };
          },
        },
        {
          id: 'lightRT',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (instance?.params && instance.params.enabled === false) {
              return { pass: true, skipped: true, message: 'Lighting disabled in params' };
            }
            const ok = !!instance?._lightRT?.texture;
            return {
              pass: ok,
              message: ok ? 'lightRT texture available' : 'lightRT missing (resize/init failure?)',
            };
          },
        },
        {
          id: 'composeMaterial',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (instance?.params && instance.params.enabled === false) {
              return { pass: true, skipped: true, message: 'Lighting disabled in params' };
            }
            return {
              pass: !!instance?._composeMaterial,
              message: instance?._composeMaterial ? 'Compose material present' : 'Lighting compose material missing',
            };
          },
        },
        heartbeatRule('LightingEffectV2', 5000),
      ],
    });

    this.registry.register('WaterSplashesEffectV2', {
      effectId: 'WaterSplashesEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._waterSplashesEffect ?? null,
      getLevelKeys: (instance, ctx) => {
        const keys = [];
        const floorStates = instance?._floorStates;
        if (floorStates && typeof floorStates.keys === 'function') {
          for (const idx of floorStates.keys()) keys.push(`floor:${idx}`);
        }
        if (keys.length === 0) keys.push(...activeLevelKeys(ctx));
        return keys;
      },
      rules: [
        {
          id: 'initialized',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (!instance?.enabled || !instance?.params?.enabled) {
              return { pass: true, skipped: true, message: 'Water splashes disabled' };
            }
            return {
              pass: !!instance?._initialized,
              message: instance?._initialized ? 'Initialized' : 'Water splashes not initialized',
            };
          },
        },
        {
          id: 'batchRenderer',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (!instance?.enabled || !instance?.params?.enabled) {
              return { pass: true, skipped: true, message: 'Water splashes disabled' };
            }
            const states = instance?._floorStates;
            let perFloorBatchCount = 0;
            if (states && typeof states.values === 'function') {
              for (const st of states.values()) {
                if (st?.batchRenderer) perFloorBatchCount += 1;
              }
            }
            const mapCount = Number(instance?._batchRenderers?.size ?? 0);
            const ok = perFloorBatchCount > 0 || mapCount > 0;
            return {
              pass: ok,
              message: ok
                ? `Per-floor splash batch renderers present (${Math.max(perFloorBatchCount, mapCount)})`
                : 'Per-floor splash batch renderers missing',
              evidence: { perFloorBatchCount, mapCount },
            };
          },
        },
        heartbeatRule('WaterSplashesEffectV2', 6000),
      ],
    });

    this.registry.register('DustEffectV2', {
      effectId: 'DustEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._dustEffect ?? null,
      getLevelKeys: (instance, ctx) => {
        const keys = [];
        const floorStates = instance?._floorStates;
        if (floorStates && typeof floorStates.keys === 'function') {
          for (const idx of floorStates.keys()) keys.push(`floor:${idx}`);
        }
        if (keys.length === 0) keys.push(...activeLevelKeys(ctx));
        return keys;
      },
      rules: [
        {
          id: 'initialized',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (!instance?.enabled || !instance?.params?.enabled) {
              return { pass: true, skipped: true, message: 'Dust disabled' };
            }
            return {
              pass: !!instance?._initialized,
              message: instance?._initialized ? 'Initialized' : 'Dust effect not initialized',
            };
          },
        },
        {
          id: 'batchRenderer',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (!instance?.enabled || !instance?.params?.enabled) {
              return { pass: true, skipped: true, message: 'Dust disabled' };
            }
            return {
              pass: !!instance?._batchRenderer,
              message: instance?._batchRenderer ? 'Quarks batch renderer present' : 'Dust batch renderer missing',
            };
          },
        },
        heartbeatRule('DustEffectV2', 6000),
      ],
    });

    this.registry.register('SkyColorEffectV2', {
      effectId: 'SkyColorEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._skyColorEffect ?? null,
      getLevelKeys: (_instance, ctx) => activeLevelKeys(ctx),
      rules: [
        {
          id: 'initialized',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (instance?.params && instance.params.enabled === false) {
              return { pass: true, skipped: true, message: 'Sky color disabled' };
            }
            return {
              pass: !!instance?._initialized,
              message: instance?._initialized ? 'Initialized' : 'Sky color not initialized',
            };
          },
        },
        {
          id: 'composeMaterial',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (instance?.params && instance.params.enabled === false) {
              return { pass: true, skipped: true, message: 'Sky color disabled' };
            }
            return {
              pass: !!instance?._composeMaterial,
              message: instance?._composeMaterial ? 'Compose material present' : 'Sky compose material missing',
            };
          },
        },
        heartbeatRule('SkyColorEffectV2', 6000),
      ],
    });

    this.registry.register('BuildingShadowsEffectV2', {
      effectId: 'BuildingShadowsEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._buildingShadowEffect ?? null,
      getLevelKeys: (_instance, ctx) => activeLevelKeys(ctx),
      rules: [
        {
          id: 'initializedTargets',
          tier: 'structural',
          severity: 'error',
          check: (instance) => {
            if (instance?.params && instance.params.enabled === false) {
              return { pass: true, skipped: true, message: 'Building shadows disabled' };
            }
            const pass =
              !!instance?.shadowTarget?.texture &&
              !!instance?._strengthTarget?.texture;
            return {
              pass,
              message: pass
                ? 'Building shadow RT + strength RT available'
                : 'Building shadow render targets missing after init',
            };
          },
        },
        {
          id: 'buildingShadowsOutdoorsPass',
          tier: 'behavioral',
          severity: 'warn',
          check: (instance) => {
            if (instance?.params && instance.params.enabled === false) {
              return { pass: true, skipped: true, message: 'Building shadows disabled' };
            }
            const diag = instance?.getHealthDiagnostics?.() ?? null;
            if (!diag) {
              return {
                pass: true,
                skipped: true,
                message: 'No building-shadow render diagnostics yet',
              };
            }
            if (!diag.compositorPresent) {
              return {
                pass: false,
                message: 'Building shadows require GpuSceneMaskCompositor (missing)',
                evidence: diag,
              };
            }
            if (diag.drewAny) {
              return {
                pass: true,
                message: diag.fallbackUsed
                  ? 'Building shadow RT drawn using unified outdoors fallback'
                  : `Building shadow RT drawn (${diag.floorKeyCount ?? 0} compositor key(s))`,
                evidence: diag,
              };
            }
            return {
              pass: false,
              message: diag.note || 'Building shadows did not draw — shadow factor RT stays white (no mask / wrong keys)',
              evidence: diag,
            };
          },
        },
        heartbeatRule('BuildingShadowsEffectV2', 8000),
      ],
    });

    this.registry.register('SpecularEffectV2', {
      effectId: 'SpecularEffectV2',
      getInstance: (ctx) => ctx.floorCompositor?._specularEffect ?? null,
      getLevelKeys: (_instance, ctx) => activeLevelKeys(ctx),
      rules: [
        {
          id: 'initialized',
          tier: 'structural',
          severity: 'error',
          check: (instance) => ({
            pass: !!instance?._initialized,
            message: instance?._initialized ? 'Initialized' : 'SpecularEffectV2 not initialized',
          }),
        },
        {
          id: 'sharedUniforms',
          tier: 'structural',
          severity: 'error',
          check: (instance) => ({
            pass: !!instance?._sharedUniforms,
            message: instance?._sharedUniforms ? 'Shared uniforms allocated' : 'Missing shared uniforms',
          }),
        },
        {
          id: 'specularOutdoorsBinding',
          tier: 'behavioral',
          severity: 'warn',
          check: (instance, ctx) => {
            const diag = instance?.getHealthDiagnostics?.() ?? null;
            if (!diag || diag.overlayCount === 0) {
              return {
                pass: true,
                skipped: true,
                message: 'No specular overlays — outdoors binding N/A',
                evidence: { overlayCount: diag?.overlayCount ?? 0 },
              };
            }
            if (diag.error) {
              return {
                pass: false,
                message: `Outdoors uniform bind error: ${diag.message || 'unknown'}`,
                evidence: diag,
              };
            }
            const runtime = ctx._getRuntimeSnapshot();
            const af = Number(runtime?.activeFloor ?? 0);
            const slots = diag.outdoorsSlots || [];
            const activeSlot = slots.find((s) => Number(s.slot) === af) || null;
            const multi = Number(diag.floorStackCount || 0) > 1;
            if (!multi) {
              const ok = Number(diag.roofMaskEnabled || 0) > 0.5;
              return {
                pass: ok,
                message: ok
                  ? 'Single-floor: roof mask enabled (legacy weather roofMap or compositor)'
                  : 'Single-floor: roof mask disabled — shader treats all pixels as outdoors',
                evidence: {
                  roofMaskEnabled: diag.roofMaskEnabled,
                  weatherRoofMapUuid: diag.weatherRoofMapUuid,
                  specularRoofMapUuid: diag.specularRoofMapUuid ?? null,
                  singleFloorRoofSource: diag.singleFloorRoofSource ?? null,
                  singleFloorOutdoorsAttempts: Array.isArray(diag.singleFloorOutdoorsAttempts)
                    ? diag.singleFloorOutdoorsAttempts.slice(0, 16)
                    : [],
                },
              };
            }
            if (!diag.compositorPresent) {
              return {
                pass: false,
                message: 'Multi-floor scene but GpuSceneMaskCompositor missing — specular cannot resolve per-floor _Outdoors',
                evidence: { floorStackCount: diag.floorStackCount },
              };
            }
            if (!diag.usePerFloor) {
              return {
                pass: false,
                message: 'Multi-floor: per-floor outdoors path off — likely no compositor textures resolved; legacy roofMap may be wrong floor',
                evidence: { usePerFloor: diag.usePerFloor, weatherRoofMapUuid: diag.weatherRoofMapUuid },
              };
            }
            const hasTex = !!(activeSlot?.textureUuid);
            const isFallback = activeSlot?.binding === 'fallbackWhite';
            const pass = hasTex && !isFallback;
            return {
              pass,
              message: pass
                ? `Active floor ${af}: bound compositor _Outdoors (uuid ${activeSlot.textureUuid})`
                : `Active floor ${af}: no compositor _Outdoors resolved — slot uses ${activeSlot?.binding || 'unknown'} (white = full outdoor in shader)`,
              evidence: {
                activeFloor: af,
                resolvedCompositorKey: activeSlot?.resolvedCompositorKey ?? null,
                binding: activeSlot?.binding,
                textureUuid: activeSlot?.textureUuid,
                floors: diag.floors,
              },
            };
          },
        },
        heartbeatRule('SpecularEffectV2', 8000),
      ],
    });

    this.registry.register('GpuSceneMaskCompositor', {
      effectId: 'GpuSceneMaskCompositor',
      getInstance: (ctx) => ctx.gpuSceneMaskCompositor
        ?? window.MapShine?.sceneComposer?._sceneMaskCompositor
        ?? null,
      getLevelKeys: () => ['global:scene'],
      rules: [
        {
          id: 'compositorInstance',
          tier: 'structural',
          severity: 'warn',
          check: (instance) => ({
            pass: !!instance,
            message: instance
              ? 'GpuSceneMaskCompositor instance present'
              : 'GpuSceneMaskCompositor not on HealthEvaluator / sceneComposer',
          }),
        },
        {
          id: 'activeFloorOutdoorsResolvable',
          tier: 'behavioral',
          severity: 'warn',
          check: (_instance, ctx) => {
            const diag = ctx._buildGpuCompositorOutdoorsDiagnostics();
            if (!diag.compositorPresent) {
              return { pass: false, message: 'Compositor missing', evidence: diag };
            }
            const af = Number(ctx._getRuntimeSnapshot()?.activeFloor ?? 0);
            const row = (diag.floorRows || []).find((r) => Number(r.floorIndex) === af);
            if (!row) {
              return { pass: true, skipped: true, message: 'No floor row for active index' };
            }
            const pass = !!row.resolvedOutdoors;
            return {
              pass,
              message: pass
                ? `Floor ${af}: _Outdoors resolvable (${row.resolvedNote || 'direct key'})`
                : `Floor ${af}: no _Outdoors RT for compositorKey "${row.compositorKey}" and no sibling key match — mask not loaded or band key mismatch`,
              evidence: row,
            };
          },
        },
      ],
    });
  }
}

