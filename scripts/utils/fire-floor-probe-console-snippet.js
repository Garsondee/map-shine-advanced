/**
 * DevTools fire particle / upper-floor wiring probe (scene loaded, V2 active).
 *
 *   await MapShine.loadFireFloorProbe()
 *   await MapShine.msaFireFloorProbe()
 *
 * Or one-shot eval:
 *   fetch('modules/map-shine-advanced/scripts/utils/fire-floor-probe-console-snippet.js')
 *     .then(r => r.text()).then(s => eval(s))
 *     .then(() => MapShine.msaFireFloorProbe())
 *
 * node --check scripts/utils/fire-floor-probe-console-snippet.js
 */
(function mapShineFireFloorProbeSnippet() {
  const ms = window.MapShine ?? {};

  function countPts(arr) {
    return arr ? Math.floor(arr.length / 3) : 0;
  }

  function resolveBus() {
    return ms.floorCompositorV2?._renderBus
      ?? ms.effectComposer?._floorCompositorV2?._renderBus
      ?? null;
  }

  function floorReport(fire, bus, fi) {
    const state = fire?._floorStates?.get?.(fi);
    if (!state) return { floorIndex: fi, state: 'MISSING' };

    const br = state.batchRenderer;
    const index = br?.systemToBatchIndex;
    const allSys = [
      ...(state.systems ?? []),
      ...(state.emberSystems ?? []),
      ...(state.smokeSystems ?? []),
    ];
    const inIndex = allSys.filter((s) => index?.has(s)).length;
    const orphaned = allSys.length - inIndex;

    const bucketRows = (state.bucketRegistry ?? []).map((e, i) => ({
      i,
      key: e.bucketKey,
      active: !!e.active,
      points: countPts(e.bucketPoints),
      systems: e.systems?.length ?? 0,
      inBatch: (e.systems ?? []).filter((s) => index?.has(s)).length,
    }));

    const overlayKey = `ms_fire_batch_${fi}`;
    const busEntry = bus?._tiles?.get?.(overlayKey);
    const mesh = busEntry?.mesh ?? busEntry?.root ?? null;

    return {
      floorIndex: fi,
      buckets: state.bucketRegistry?.length ?? 0,
      bucketsActive: bucketRows.filter((b) => b.active).length,
      bucketRows,
      systems: {
        fire: state.systems?.length ?? 0,
        ember: state.emberSystems?.length ?? 0,
        smoke: state.smokeSystems?.length ?? 0,
      },
      totalSystems: allSys.length,
      inSystemToBatchIndex: inIndex,
      orphanedSystems: orphaned,
      glowPoints: countPts(fire?._glowSourcePointsByFloor?.get?.(fi)),
      batchRenderer: br ? {
        uuid: br.uuid,
        parent: br.parent?.type ?? null,
        inScene: !!br.parent,
        visible: br.visible,
        renderOrder: br.renderOrder,
        indexSize: index?.size ?? 0,
        batchCount: br.batches?.length ?? 0,
        batches: (br.batches ?? []).map((b, i) => ({
          i,
          systems: b?.systems?.size ?? b?.systems?.length ?? 0,
        })),
      } : null,
      busOverlay: busEntry ? {
        key: overlayKey,
        registered: true,
        visible: mesh?.visible,
        floorIndex: busEntry.floorIndex,
        isLegacyStacked: busEntry.isLegacyStackedOverlay,
        overlayRole: busEntry.overlayRole || null,
      } : { key: overlayKey, registered: false },
    };
  }

  function probeCompositorFire(fire, smc, compositorKey) {
    if (!smc || !compositorKey) return null;
    const tex = smc.getFloorTexture?.(compositorKey, 'fire');
    const px = smc.getMaskTexturePixelSize?.(tex) ?? {};
    let scenePoints = null;
    try {
      scenePoints = fire?._readCompositorFireScenePoints?.(smc, compositorKey);
    } catch (err) {
      scenePoints = `err: ${err?.message ?? err}`;
    }
    const rgba = smc.getCpuPixelsForFloor?.(compositorKey, 'fire');
    const activeRt = !!window.MapShine?.renderer?.getRenderTarget?.();
    return {
      compositorKey,
      hasTexture: !!tex,
      dims: { w: px.w ?? 0, h: px.h ?? 0 },
      cpuPixels: rgba ? rgba.length : 0,
      rendererHasActiveRT: activeRt,
      readbackBlocked: !rgba && !!tex,
      scenePoints: typeof scenePoints === 'object' ? countPts(scenePoints) : scenePoints,
    };
  }

  function buildWiring(report, fire, bus, activeFi, compositorFire) {
    const WIRING = [];
    const st = fire?._floorStates?.get(activeFi);
    const br = st?.batchRenderer;

    if (!fire) WIRING.push('FAIL: MapShine.fireEffectV2 missing');
    if (fire && !fire._initialized) WIRING.push('FAIL: fire not initialized');
    if (fire && !fire._enabled) WIRING.push('FAIL: fire effect disabled (_enabled=false)');
    if (fire?.params?.enabled === false) WIRING.push('FAIL: fire params.enabled=false');
    if (!st) {
      WIRING.push(`FAIL: no _floorStates for active floor ${activeFi} (populate/backfill never built this floor)`);
    } else {
      const bucketN = st.bucketRegistry?.length ?? 0;
      const sysN = (st.systems?.length ?? 0) + (st.emberSystems?.length ?? 0) + (st.smokeSystems?.length ?? 0);
      if (bucketN === 0) {
        WIRING.push(`FAIL: floor ${activeFi} has 0 buckets — mask scan found nothing or backfill did not run`);
      }
      if (bucketN > 0 && sysN === 0) {
        WIRING.push(`FAIL: ${bucketN} buckets but 0 systems — _activateFloor / _activateFireBucket never materialized`);
      }
      if (br && sysN > 0 && (br.systemToBatchIndex?.size ?? 0) === 0) {
        WIRING.push('FAIL: systems exist but systemToBatchIndex empty — physics loop will skip them');
      }
      if (br && (report.floors[activeFi]?.orphanedSystems ?? 0) > 0) {
        WIRING.push(`FAIL: ${report.floors[activeFi].orphanedSystems} systems not in systemToBatchIndex`);
      }
      const overlayKey = `ms_fire_batch_${activeFi}`;
      if (!bus?._tiles?.has?.(overlayKey)) {
        WIRING.push(`FAIL: FloorRenderBus missing overlay ${overlayKey}`);
      } else {
        const entry = bus._tiles.get(overlayKey);
        const vis = entry?.mesh?.visible ?? entry?.root?.visible;
        if (vis === false) WIRING.push(`WARN: ${overlayKey} registered but visible=false`);
      }
      if (br && !br.parent) WIRING.push('FAIL: batchRenderer has no parent (not in scene graph)');
      if (br && br.visible === false) WIRING.push('WARN: batchRenderer.visible=false');
      const activeSet = fire?._activeFloors ? [...fire._activeFloors] : [];
      if (!activeSet.includes(activeFi)) {
        WIRING.push(`FAIL: active floor ${activeFi} not in fire._activeFloors [${activeSet}]`);
      }
    }
    if (report.fire.missingBuckets) {
      WIRING.push('WARN: _anyUpperFloorMissingFireBuckets still true — backfill pending or failed');
    }
    if (compositorFire?.hasTexture && compositorFire.scenePoints === 0) {
      WIRING.push('WARN: compositor fire texture exists but CPU scan found 0 spawn points');
    }
    if (compositorFire?.readbackBlocked) {
      WIRING.push('WARN: getCpuPixelsForFloor returned null (active RT or cache miss)');
    }
    return WIRING;
  }

  async function msaFireFloorProbe(options = {}) {
    const fire = ms.fireEffectV2 ?? null;
    const bus = resolveBus();
    const smc = ms.sceneComposer?._sceneMaskCompositor ?? null;
    const fs = ms.floorStack ?? null;
    const active = fs?.getActiveFloor?.() ?? null;
    const activeFi = Number.isFinite(Number(active?.index)) ? Number(active.index) : 0;
    const compositorKey = active?.compositorKey ?? null;

    if (options.tryBackfill && fire?._buildMissingCompositorFloors) {
      try {
        const built = await fire._buildMissingCompositorFloors(activeFi);
        console.log('[MSA Fire Floor Probe] manual backfill built=', built);
      } catch (err) {
        console.warn('[MSA Fire Floor Probe] manual backfill failed', err);
      }
    }

    const compositorFire = probeCompositorFire(fire, smc, compositorKey);

    const report = {
      ts: new Date().toISOString(),
      activeFloor: active,
      activeFloorIndex: activeFi,
      fire: {
        exists: !!fire,
        initialized: fire?._initialized,
        enabled: fire?._enabled,
        paramEnabled: fire?.params?.enabled,
        multiFloor: fire?._isMultiFloorScene?.(),
        viewStreaming: fire?._isFireViewStreamingEnabled?.(),
        detailTier: fire?._lastDetailTier,
        activeFloors: fire?._activeFloors ? [...fire._activeFloors] : [],
        lastAppliedViewFloor: fire?._lastAppliedFireViewFloor,
        floorStateKeys: fire?._floorStates ? [...fire._floorStates.keys()] : [],
        missingBuckets: fire?._anyUpperFloorMissingFireBuckets?.(activeFi),
        streamingSummary: fire?.getFireStreamingReportSummary?.() ?? null,
      },
      compositorFire,
      floors: {},
      wiring: [],
      verdict: 'UNKNOWN',
    };

    const floorIndices = new Set([
      ...report.fire.floorStateKeys,
      activeFi,
      0,
      ...((fs?.getFloors?.() ?? []).map((f) => Number(f.index))),
    ].filter((n) => Number.isFinite(n)));

    for (const fi of floorIndices) {
      report.floors[fi] = floorReport(fire, bus, fi);
    }

    report.wiring = buildWiring(report, fire, bus, activeFi, compositorFire);
    report.verdict = report.wiring.some((w) => w.startsWith('FAIL'))
      ? 'BROKEN'
      : (report.wiring.length ? 'DEGRADED' : 'OK');

    ms.__msaFireFloorProbeLast = report;
    console.log('[MSA Fire Floor Probe]', report);
    console.table(Object.values(report.floors).map((f) => ({
      floor: f.floorIndex,
      state: f.state ?? 'ok',
      buckets: f.buckets,
      active: f.bucketsActive,
      fireSys: f.systems?.fire,
      totalSys: f.totalSystems,
      inIndex: f.inSystemToBatchIndex,
      orphaned: f.orphanedSystems,
      glowPts: f.glowPoints,
      overlay: f.busOverlay?.registered === false ? 'NO' : String(f.busOverlay?.visible),
    })));
    console.log('Wiring:', report.wiring);
    console.log('Verdict:', report.verdict);
    console.log('Full JSON: window.MapShine.__msaFireFloorProbeLast');

    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      console.log('(copied to clipboard)');
    } catch (_) {}

    return report;
  }

  /**
   * Live simulation probe — are particles actually being stepped and buffered?
   * Run while standing on the broken floor, ideally while looking at fire.
   */
  function msaFireLiveProbe(floorIndex = null) {
    const fire = ms.fireEffectV2;
    const fi = Number.isFinite(Number(floorIndex))
      ? Number(floorIndex)
      : Number(ms.floorStack?.getActiveFloor?.()?.index ?? 0);
    const state = fire?._floorStates?.get(fi);
    const br = state?.batchRenderer;
    const rows = [];

    function emitterRootType(sys) {
      let node = sys?.emitter;
      while (node?.parent) node = node.parent;
      return node?.type ?? 'none';
    }

    const allSys = [
      ...(state?.systems ?? []),
      ...(state?.emberSystems ?? []),
      ...(state.smokeSystems ?? []),
    ];

    for (let i = 0; i < allSys.length; i += 1) {
      const sys = allSys[i];
      const shape = sys?.emitterShape;
      const pts = shape?.points?.length ? Math.floor(shape.points.length / 3) : 0;
      const allPts = shape?._allPoints?.length ? Math.floor(shape._allPoints.length / 3) : pts;
      rows.push({
        i,
        inIndex: !!br?.systemToBatchIndex?.has(sys),
        particleNum: sys?.particleNum ?? -1,
        paused: !!sys?.paused,
        emitterVisible: sys?.emitter?.visible,
        emitterParent: sys?.emitter?.parent?.type ?? 'none',
        rootType: emitterRootType(sys),
        shapePts: pts,
        shapeAllPts: allPts,
        emissionA: sys?.emissionOverTime?.a,
        emissionB: sys?.emissionOverTime?.b,
        floorIndex: sys?.userData?.floorIndex,
      });
    }

    if (br && allSys.length > 0) {
      const dt = 0.05;
      const ageRate = 0.001 * 750 * 2;
      try {
        fire._stepFirePhysicsSim(br, dt * ageRate);
        fire._refreshFireVisuals(br, dt, ageRate, true);
      } catch (err) {
        console.warn('[MSA Fire Live Probe] manual step failed', err);
      }
      for (let i = 0; i < allSys.length; i += 1) {
        rows[i].particleNumAfterStep = allSys[i]?.particleNum ?? -1;
      }
    }

    const batchInfo = br ? {
      indexSize: br.systemToBatchIndex?.size ?? 0,
      batchCount: br.batches?.length ?? 0,
      batches: (br.batches ?? []).map((b, idx) => ({
        idx,
        systems: b?.systems?.size ?? b?.systems?.length ?? 0,
        visibleSystems: typeof b?.getVisibleSystems === 'function' ? b.getVisibleSystems().length : null,
        materialVisible: b?.visible,
      })),
      lastPhysicsAt: fire?._floorLastPhysicsAt?.get?.(fi),
      navLiteSkip: !!ms.__v2NavigationLiteUpdates,
    } : null;

    const live = {
      ts: new Date().toISOString(),
      floorIndex: fi,
      systemRows: rows,
      totals: {
        systems: rows.length,
        inIndex: rows.filter((r) => r.inIndex).length,
        particlesBefore: rows.reduce((s, r) => s + Math.max(0, r.particleNum || 0), 0),
        particlesAfter: rows.reduce((s, r) => s + Math.max(0, r.particleNumAfterStep ?? r.particleNum ?? 0), 0),
        zeroShapePts: rows.filter((r) => (r.shapePts ?? 0) < 1).length,
        badRoot: rows.filter((r) => r.rootType !== 'Scene').length,
        emitterHidden: rows.filter((r) => r.emitterVisible === false).length,
      },
      batch: batchInfo,
      detailTier: fire?._lastDetailTier,
      viewStreaming: fire?._isFireViewStreamingEnabled?.(),
      multiFloor: fire?._isMultiFloorScene?.(),
    };

    const LIVE_WIRING = [];
    if (!state) LIVE_WIRING.push(`FAIL: no floor state ${fi}`);
    if (rows.length === 0) LIVE_WIRING.push('FAIL: zero systems on floor');
    if (live.totals.zeroShapePts > 0) LIVE_WIRING.push(`FAIL: ${live.totals.zeroShapePts} systems have 0 shape spawn points`);
    if (live.totals.badRoot > 0) LIVE_WIRING.push(`FAIL: ${live.totals.badRoot} emitters do not reach Scene root (ps.update will self-dispose)`);
    if (live.totals.emitterHidden > 0) LIVE_WIRING.push(`FAIL: ${live.totals.emitterHidden} emitters visible=false (batch upload skips them)`);
    if (live.totals.particlesAfter === 0 && rows.length > 0) {
      LIVE_WIRING.push('FAIL: particleNum still 0 after manual physics step — emission/spawn broken');
    } else if (live.totals.particlesAfter > 0) {
      LIVE_WIRING.push(`OK: ${live.totals.particlesAfter} live particles after manual step — look for render/composite issue`);
    }
    if (live.batch?.visibleSystems === 0 && live.totals.particlesAfter > 0) {
      LIVE_WIRING.push('FAIL: batch has particles but getVisibleSystems()=0');
    }
    live.wiring = LIVE_WIRING;
    live.verdict = LIVE_WIRING.some((w) => w.startsWith('FAIL')) ? 'BROKEN' : 'OK';

    ms.__msaFireLiveProbeLast = live;
    console.log('[MSA Fire Live Probe]', live);
    console.table(rows);
    console.log('Live wiring:', LIVE_WIRING);
    return live;
  }

  ms.msaFireFloorProbe = msaFireFloorProbe;
  ms.msaFireLiveProbe = msaFireLiveProbe;
  ms.loadFireFloorProbe = async function loadFireFloorProbe() {
    if (typeof ms.msaFireFloorProbe === 'function') return true;
    const url = 'modules/map-shine-advanced/scripts/utils/fire-floor-probe-console-snippet.js';
    const text = await fetch(url).then((r) => r.text());
    // eslint-disable-next-line no-eval
    eval(text);
    return true;
  };
})();
