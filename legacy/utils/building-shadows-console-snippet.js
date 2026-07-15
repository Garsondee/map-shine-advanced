/**
 * DevTools-only: paste the entire IIFE into the Foundry browser console (after a frame).
 * `node --check scripts/utils/building-shadows-console-snippet.js` validates syntax.
 *
 * Multi-floor building shadow audit — per-floor lit RTs, caster/receiver masks, lighting wiring.
 * After run: `MapShine.__buildingShadowsAuditLast` and `MapShine.__buildingShadowsAuditJson`
 * (Chrome: `copy(MapShine.__buildingShadowsAuditJson)`).
 */
(function mapShineBuildingShadowsAudit() {
  const ms = window.MapShine;
  const fc = ms && ms.floorCompositorV2;
  const warnings = [];
  const notes = [];

  function publishAudit(result) {
    if (ms) {
      ms.__buildingShadowsAuditLast = result;
      ms.__buildingShadowsAuditJson = JSON.stringify(result, null, 2);
    }
    if (warnings.length) {
      console.warn('[Building shadows audit] warnings (' + warnings.length + '):');
      for (let i = 0; i < warnings.length; i += 1) console.warn('  ' + (i + 1) + '. ' + warnings[i]);
    }
    if (notes.length) {
      console.info('[Building shadows audit] notes (' + notes.length + '):');
      for (let i = 0; i < notes.length; i += 1) console.info('  ' + (i + 1) + '. ' + notes[i]);
    }
    console.log('--- Map Shine BUILDING SHADOWS AUDIT (copy JSON below) ---');
    if (ms) console.log('Tip: copy(MapShine.__buildingShadowsAuditJson)');
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  function effResolve(e) {
    return !!(e && e.enabled !== false && e.params && e.params.enabled !== false);
  }

  function tex(t) {
    if (!t) return null;
    const img = t.image;
    const w = img && img.width != null ? img.width
      : (t.source && t.source.data && t.source.data.width) || null;
    const h = img && img.height != null ? img.height
      : (t.source && t.source.data && t.source.data.height) || null;
    return { uuid: t.uuid || null, w, h, name: t.name || null };
  }

  function rtInfo(target) {
    if (!target || !target.texture) return null;
    const t = tex(target.texture);
    if (target.width != null) t.rtW = target.width;
    if (target.height != null) t.rtH = target.height;
    return t;
  }

  function sampleR(renderer, rtarget, relX, relY) {
    if (!renderer || !rtarget || !rtarget.texture) return null;
    const rw = rtarget.width | 0;
    const rh = rtarget.height | 0;
    if (rw < 1 || rh < 1) return { error: 'bad_rt_size' };
    const xi = Math.max(0, Math.min(rw - 1, (relX * rw) | 0));
    const yi = Math.max(0, Math.min(rh - 1, (relY * rh) | 0));
    const buf = new Uint8Array(4);
    try {
      renderer.readRenderTargetPixels(rtarget, xi, yi, 1, 1, buf);
      return { x: xi, y: yi, r01: buf[0] / 255, rgba: Array.prototype.slice.call(buf) };
    } catch (e) {
      return { x: xi, y: yi, error: String(e && e.message) };
    }
  }

  function coarseMinR01(renderer, rtarget, steps) {
    if (!renderer || !rtarget || !steps || steps < 2) return null;
    let minR = 1;
    let maxR = 0;
    let minAt = null;
    const n = steps | 0;
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const relX = (i + 0.5) / n;
        const relY = (j + 0.5) / n;
        const s = sampleR(renderer, rtarget, relX, relY);
        if (s && s.r01 != null) {
          if (s.r01 < minR) {
            minR = s.r01;
            minAt = { relX, relY, x: s.x, y: s.y };
          }
          if (s.r01 > maxR) maxR = s.r01;
        }
      }
    }
    return { steps: n, minR01: minR, maxR01: maxR, darkestAt: minAt, allLit: minR > 0.995 };
  }

  function authoredOutdoors(compositor, floorKey) {
    if (!compositor || !floorKey) return null;
    try {
      const metaTex = compositor._floorMeta?.get?.(String(floorKey))?.masks
        ?.find((m) => (m.id ?? m.type) === 'outdoors')?.texture ?? null;
      if (Number(metaTex?.image?.width) > 0) return metaTex;
    } catch (_) {}
    try {
      return compositor.getFloorTexture?.(String(floorKey), 'outdoors') ?? null;
    } catch (_) {
      return null;
    }
  }

  if (!fc) {
    warnings.push('MapShine.floorCompositorV2 missing — open a scene with Map Shine V2 active first.');
    return publishAudit({ warnings, notes, error: 'no_floorCompositorV2' });
  }

  const r = fc.renderer;
  const bd = fc._buildingShadowEffect;
  const compositor = ms?.sceneComposer?._sceneMaskCompositor ?? null;
  const floorStack = ms?.floorStack;
  const floors = floorStack?.getFloors?.() ?? [];
  const visible = floorStack?.getVisibleFloors?.() ?? [];
  const active = floorStack?.getActiveFloor?.() ?? null;
  const sceneFloorCount = floors.length;
  const multiFloor = sceneFloorCount > 1;

  if (!bd) warnings.push('_buildingShadowEffect instance missing');
  if (!effResolve(bd)) warnings.push('BuildingShadowsEffectV2 disabled or not resolving enabled');
  if (!compositor) warnings.push('GpuSceneMaskCompositor missing');
  if (multiFloor && bd && !bd.groundOnlyLitTexture) {
    warnings.push('multiFloor but groundOnlyLitTexture is null — floor-0 lit pass never produced an RT');
  }

  let outdoorsSlots = [null, null, null, null];
  let floorIdTex = null;
  if (bd && compositor && typeof bd._syncOutdoorsMaskSlots === 'function') {
    try {
      outdoorsSlots = bd._syncOutdoorsMaskSlots(compositor) ?? outdoorsSlots;
      floorIdTex = bd._floorIdTex ?? null;
    } catch (e) {
      warnings.push('_syncOutdoorsMaskSlots threw: ' + String(e && e.message));
    }
  }

  const perFloor = [];
  for (let fi = 0; fi <= 3; fi += 1) {
    const floor = floors.find((f) => Number(f?.index) === fi) ?? null;
    const ck = floor?.compositorKey != null ? String(floor.compositorKey) : null;
    const gpuOut = ck && compositor ? compositor.getFloorTexture?.(ck, 'outdoors') : null;
    const authored = ck && compositor ? authoredOutdoors(compositor, ck) : null;
    const gpuCacheOut = ck && compositor
      ? compositor._floorCache?.get?.(ck)?.get?.('outdoors')?.texture ?? null
      : null;
    const slotOut = outdoorsSlots[fi] ?? null;

    let casters = [];
    if (bd && compositor && typeof bd._resolveCasterTexturesForReceiver === 'function') {
      try {
        casters = (bd._resolveCasterTexturesForReceiver(compositor, fi) ?? []).map(tex);
      } catch (_) {}
    }

    let litTarget = null;
    let litTex = null;
    if (bd) {
      litTarget = bd._perFloorLitTargets?.[fi]
        ?? (fi === 0 ? bd._groundOnlyLitTarget : null)
        ?? null;
      litTex = litTarget?.texture ?? (fi === 0 ? bd.groundOnlyLitTexture : null) ?? null;
      if (r && typeof bd.renderLitForSingleFloor === 'function') {
        try {
          litTex = bd.renderLitForSingleFloor(r, fi) ?? litTex;
        } catch (e) {
          warnings.push('renderLitForSingleFloor(' + fi + ') threw: ' + String(e && e.message));
        }
      }
    }

    const scan = litTarget ? coarseMinR01(r, litTarget, 8) : null;
    const isVisible = visible.some((f) => Number(f?.index) === fi);
    const isActive = Number(active?.index) === fi;

    if (multiFloor && isVisible && scan && scan.allLit) {
      warnings.push(
        'Floor ' + fi + ' lit RT is all-white (minR≈1) — no building shadow darkening for this receiver band',
      );
    }
    if (multiFloor && isVisible && casters.length === 0) {
      warnings.push('Floor ' + fi + ' has zero caster outdoors textures (floors >= ' + fi + ')');
    }
    if (multiFloor && isVisible && !slotOut && !authored && !gpuOut) {
      warnings.push('Floor ' + fi + ' receiver outdoors missing (slot + authored + GPU all null)');
    }
    if (slotOut && authored && slotOut.uuid !== authored.uuid) {
      notes.push(
        'Floor ' + fi + ' slot outdoors uuid differs from authored meta (slot may be GPU RT)',
      );
    }

    if (multiFloor && isVisible && slotOut && !gpuCacheOut && ck) {
      notes.push(
        'Floor ' + fi + ' receiver outdoors is bundle/meta only (no _floorCache GPU RT for ' + ck + ')',
      );
    }

    perFloor.push({
      floorIndex: fi,
      inStack: !!floor,
      compositorKey: ck,
      elevation: floor ? { min: floor.elevationMin, max: floor.elevationMax } : null,
      isActive,
      isVisible,
      receiverOutdoors: {
        slot: tex(slotOut),
        gpu: tex(gpuOut),
        gpuCache: tex(gpuCacheOut),
        authored: tex(authored),
        slotMatchesAuthored: !!(slotOut && authored && slotOut.uuid === authored.uuid),
        slotUsesGpuCache: !!(slotOut && gpuCacheOut && slotOut.uuid === gpuCacheOut.uuid),
      },
      casterTextures: casters,
      casterCount: casters.length,
      litTarget: rtInfo(litTarget),
      litTextureViaRenderLit: tex(litTex),
      litScan8x8: scan,
      cacheSerial: bd?._perFloorLitLastFillSerial?.[fi] ?? null,
      globalCacheSerial: bd?._perFloorLitCacheSerial ?? null,
    });
  }

  const combinedScan = bd?.shadowTarget ? coarseMinR01(r, bd.shadowTarget, 8) : null;
  if (multiFloor && combinedScan && !combinedScan.allLit) {
    notes.push('shadowTarget (combined) has shadow content on multi-floor — expected all-lit white when omitted from SM');
  }
  if (multiFloor && combinedScan && combinedScan.allLit) {
    notes.push('shadowTarget all-lit (expected on multi-floor — per-floor RTs should carry shadows)');
  }

  const sm = fc._shadowManagerEffect;
  const smBuilding = sm?._inputList?.find?.((x) => x && x.id === 'building') ?? null;
  const smBuildingTex = smBuilding?.texture ?? sm?._buildingShadowTexture ?? null;

  const health = bd?.getHealthDiagnostics?.() ?? null;
  const activeIdx = Number.isFinite(Number(active?.index)) ? Number(active.index) : 0;
  const activePerFloor = perFloor.find((p) => p.floorIndex === activeIdx) ?? null;
  const belowActive = perFloor.filter((p) => p.isVisible && p.floorIndex < activeIdx);

  if (multiFloor && belowActive.length > 0) {
    const brokenBelow = belowActive.filter((p) => !p.litScan8x8 || p.litScan8x8.allLit);
    if (brokenBelow.length === belowActive.length) {
      warnings.push(
        'ALL visible floors below active (indices '
        + belowActive.map((p) => p.floorIndex).join(', ')
        + ') have all-white lit RTs — this matches “shadows only on active floor”',
      );
    }
  }

  const out = {
    _meta: {
      when: new Date().toISOString(),
      probeVersion: 1,
      hint: 'Pan/zoom once, then paste. Share warnings[] + perFloor[] + copy(MapShine.__buildingShadowsAuditJson)',
    },
    warnings,
    notes,
    multiFloor,
    sceneFloorCount,
    activeFloor: active ? {
      index: active.index,
      compositorKey: active.compositorKey,
      elevationMin: active.elevationMin,
      elevationMax: active.elevationMax,
    } : null,
    visibleFloorIndices: visible.map((f) => Number(f?.index)),
    floorStack: floors.map((f) => ({
      index: f?.index,
      compositorKey: f?.compositorKey,
      elevationMin: f?.elevationMin,
      elevationMax: f?.elevationMax,
    })),
    effect: {
      resolves: effResolve(bd),
      health,
      shadowTarget: rtInfo(bd?.shadowTarget),
      groundOnlyLit: rtInfo(bd?._groundOnlyLitTarget),
      perFloorLitCacheSerial: bd?._perFloorLitCacheSerial ?? null,
      combinedScan8x8: combinedScan,
      activeFloorLitScan: activePerFloor?.litScan8x8 ?? null,
    },
    compositor: compositor ? {
      activeFloorKey: compositor._activeFloorKey ?? null,
      belowFloorKey: compositor._belowFloorKey ?? null,
      floorCacheVersion: compositor.getFloorCacheVersion?.() ?? null,
      floorMetaKeys: compositor._floorMeta ? [...compositor._floorMeta.keys()] : [],
      floorCacheKeys: compositor._floorCache ? [...compositor._floorCache.keys()] : [],
      floorId: tex(floorIdTex ?? compositor.floorIdTarget?.texture ?? null),
    } : null,
    shadowManager: {
      buildingInCombine: !!smBuildingTex,
      buildingCombineUuid: smBuildingTex?.uuid ?? null,
      omitExpectedOnMultiFloor: multiFloor,
      inputBuilding: smBuilding ? {
        id: smBuilding.id,
        uvSpace: smBuilding.uvSpace,
        uuid: smBuilding.texture?.uuid ?? null,
      } : null,
    },
    perFloor,
    quickCompare: {
      activeIndex: activeIdx,
      activeMinR: activePerFloor?.litScan8x8?.minR01 ?? null,
      belowVisible: belowActive.map((p) => ({
        index: p.floorIndex,
        minR01: p.litScan8x8?.minR01 ?? null,
        casterCount: p.casterCount,
        receiverSlotUuid: p.receiverOutdoors?.slot?.uuid ?? null,
      })),
    },
  };

  return publishAudit(out);
})();
