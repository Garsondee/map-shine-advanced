import { createLogger } from '../log.js';
import { safeCall, Severity } from '../safe-call.js';
import { HealthContractRegistry } from './HealthContractRegistry.js';
import { HealthDependencyGraph } from './HealthDependencyGraph.js';
import { captureRenderStack } from './RenderStackSnapshotService.js';
import { evaluateRenderStackFindings } from './RenderStackRules.js';

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
    this._startScheduler();
    this._initialized = true;
    log.info('Health evaluator initialized');
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
    this.dependencyGraph.addEdge('SkyColorEffectV2', 'WindowLightEffectV2', 'contextual');
    this.dependencyGraph.addEdge('SkyColorEffectV2', 'DustEffectV2', 'contextual');
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
          check: (instance) => ({
            pass: !!instance?._initialized,
            message: instance?._initialized ? 'Initialized' : 'Fire effect not initialized',
          }),
        },
        {
          id: 'batchRenderer',
          tier: 'structural',
          severity: 'error',
          check: (instance) => ({
            pass: !!instance?._batchRenderer,
            message: instance?._batchRenderer ? 'Batch renderer present' : 'Fire batch renderer missing',
          }),
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
            return {
              pass: !!instance?._batchRenderer,
              message: instance?._batchRenderer ? 'Quarks batch renderer present' : 'Splashes batch renderer missing',
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
        heartbeatRule('BuildingShadowsEffectV2', 8000),
      ],
    });
  }
}

