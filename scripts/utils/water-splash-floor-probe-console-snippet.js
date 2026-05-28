/**
 * DevTools-only splash/bubble floor probe (scene loaded, V2 active).
 *
 * Load without paste errors (preferred):
 *   await MapShine.loadSplashFloorProbe()
 *   MapShine.__msaSplashProbeReports = []
 *   MapShine.msaSplashProbeCapture('ground')
 *   // change floor, then:
 *   MapShine.msaSplashProbeCapture('upper')
 *   MapShine.msaSplashProbeCompare(0, 1)
 *
 * Or fetch + eval once:
 *   fetch('modules/map-shine-advanced/scripts/utils/water-splash-floor-probe-console-snippet.js')
 *     .then(r => r.text()).then(s => { eval(s); return MapShine.msaSplashProbeCapture('ground'); })
 *
 * node --check scripts/utils/water-splash-floor-probe-console-snippet.js
 */
(function mapShineWaterSplashFloorProbe() {
  const ms = window.MapShine ?? {};
  const fc = ms.floorCompositorV2 ?? ms.effectComposer?._floorCompositorV2 ?? null;
  const we = fc?._waterEffect ?? null;
  const smc = ms.sceneComposer?._sceneMaskCompositor ?? null;
  const floorStack = ms.floorStack ?? null;

  const PARAM_KEYS = [
    'enabled', 'foamEnabled', 'splashEnabled',
    'foamRate', 'splashRate', 'foamSizeMin', 'foamSizeMax', 'foamLifeMin', 'foamLifeMax', 'foamPeakOpacity',
    'foamColorR', 'foamColorG', 'foamColorB', 'foamWindDriftScale',
    'splashSizeMin', 'splashSizeMax', 'splashLifeMin', 'splashLifeMax', 'splashPeakOpacity', 'splashWindDriftScale',
    'tintStrength', 'tintJitter', 'tintAColorR', 'tintAColorG', 'tintAColorB', 'tintBColorR', 'tintBColorG', 'tintBColorB',
    'maskThreshold', 'edgeScanStride', 'interiorScanStride',
    'waveIndoorDampingEnabled', 'waveIndoorDampingStrength',
    'rainIndoorDampingEnabled', 'rainIndoorDampingStrength',
  ];

  const BUBBLE_KEYS = [
    'enabled', 'foamEnabled', 'splashEnabled', 'foamRate', 'splashRate',
    'foamSizeMin', 'foamSizeMax', 'foamLifeMin', 'foamLifeMax',
    'splashSizeMin', 'splashSizeMax', 'splashLifeMin', 'splashLifeMax',
  ];

  function pickParams(obj, keys) {
    const out = {};
    if (!obj) return out;
    for (const k of keys) {
      const v = obj[k];
      out[k] = (v !== undefined && typeof v !== 'object') ? v : null;
    }
    return out;
  }

  function texBrief(t) {
    if (!t) return null;
    const img = t.image ?? t;
    return {
      uuid: t.uuid ?? null,
      w: img?.width ?? img?.videoWidth ?? null,
      h: img?.height ?? img?.videoHeight ?? null,
      flipY: t.flipY === true,
    };
  }

  /** Matches `msDecodeOutdoorsMaskSample` / runtime splash decode. */
  function decodeOutdoorsMaskSample8(r8, g8, b8, a8) {
    const r = Math.max(0, Math.min(255, Number(r8) || 0)) / 255;
    const g = Math.max(0, Math.min(255, Number(g8) || 0)) / 255;
    const b = Math.max(0, Math.min(255, Number(b8) || 0)) / 255;
    const a = Math.max(0, Math.min(255, Number(a8) || 0)) / 255;
    const lum = Math.max(r, g, b);
    if (lum < 1e-5 && a < 1e-5) return 1.0;
    return Math.max(0, Math.min(1, lum * a));
  }

  function readProbeOutdoorsCpuPixels(floorKey) {
    if (!smc || !floorKey || floorKey === 'none') return null;
    if (typeof smc.getCpuPixelsForFloor !== 'function') return null;
    const buf = smc.getCpuPixelsForFloor(floorKey, 'outdoors');
    if (!buf) return null;
    let w = 0;
    let h = 0;
    try {
      const rt = smc._floorCache?.get(floorKey)?.get?.('outdoors');
      w = Number(rt?.width) || 0;
      h = Number(rt?.height) || 0;
    } catch (_) {}
    if (!(w > 0 && h > 0)) {
      const dims = smc.getOutputDims?.('outdoors');
      w = Number(dims?.width) || 0;
      h = Number(dims?.height) || 0;
    }
    if (!(w > 0 && h > 0) || buf.length < w * h * 4) return null;
    return { data: buf, w, h };
  }

  function resolveCompositorFloorKey(floorIndex) {
    const fi = Number(floorIndex);
    if (!Number.isFinite(fi)) return null;
    const floors = floorStack?.getFloors?.() ?? [];
    const floor = floors[fi];
    if (floor?.compositorKey != null) return String(floor.compositorKey);
    const active = floorStack?.getActiveFloor?.();
    if (active && Number(active.index) === fi && active.compositorKey != null) {
      return String(active.compositorKey);
    }
    if (active && Number(active.index) === fi && fc?._activeFloorKey) {
      return String(fc._activeFloorKey);
    }
    return null;
  }

  /** Mirrors syncSharedOutdoorsMaskForFloor() for probe (module cache is not on window). */
  function probeSyncOutdoorsForFloor(floorIndex, frameToken) {
    const fi = Number.isFinite(Number(floorIndex)) ? Number(floorIndex) : 0;
    const compositorGen = Number(smc?.getFloorCacheVersion?.() ?? 0);
    const floorKey = resolveCompositorFloorKey(fi) ?? 'none';
    const snap = {
      hasOutdoorsMask: false,
      indoorSuppressionStrength: 0,
      floorKey,
      compositorGen,
      w: 0,
      h: 0,
      gpuRowOrder: false,
      outdoorsMaskFlipY: false,
      maskSource: 'none',
      uniformImageFallbackAllowed: false,
      frameToken,
    };

    try {
      const wp = we?.params;
      const u = we?._composeMaterial?.uniforms;
      const hasOutdoorsMask = Number(u?.uHasOutdoorsMask?.value) > 0.5;
      if (!hasOutdoorsMask) return snap;

      snap.hasOutdoorsMask = true;
      snap.indoorSuppressionStrength = 0;
      snap.waterWaveIndoorDampingEnabled = wp?.waveIndoorDampingEnabled ?? null;
      snap.waterWaveIndoorDampingStrength = wp?.waveIndoorDampingStrength ?? null;

      const cpuPixels = readProbeOutdoorsCpuPixels(floorKey);
      let hasFloorCpu = false;
      if (cpuPixels) {
        hasFloorCpu = true;
        snap.w = cpuPixels.w;
        snap.h = cpuPixels.h;
        snap.gpuRowOrder = true;
        snap.maskSource = 'compositor_cpu';
        snap._pixelBuf = cpuPixels.data;
      }

      const pinnedShelter = ms.floorCompositorV2?._waterShelterOutdoorsTexture
        ?? ms.effectComposer?._floorCompositorV2?._waterShelterOutdoorsTexture
        ?? null;
      const waterDataFloor = Number(we?._activeFloorIndex);
      const isWaterDataFloor = Number.isFinite(waterDataFloor) && waterDataFloor === fi;

      let floorOutTex = null;
      if (isWaterDataFloor && pinnedShelter) {
        floorOutTex = pinnedShelter;
        snap.maskSource = 'pinned_water_shelter';
      } else if (smc && floorKey !== 'none') {
        floorOutTex = smc.getFloorTexture?.(floorKey, 'outdoors')
          ?? smc.getMaskTextureForFloor?.(floorKey, 'outdoors')
          ?? null;
      }
      if (!floorOutTex && isWaterDataFloor && pinnedShelter) {
        floorOutTex = pinnedShelter;
        snap.maskSource = 'pinned_water_shelter';
      }
      if (floorOutTex && typeof floorOutTex.flipY === 'boolean') {
        snap.outdoorsMaskFlipY = floorOutTex.flipY === true;
      }

      if (!hasFloorCpu && floorOutTex) {
        const img = floorOutTex?.image;
        const iw = img?.width || img?.videoWidth || 0;
        const ih = img?.height || img?.videoHeight || 0;
        if (iw > 0 && ih > 0) {
          snap.maskSource = snap.maskSource === 'pinned_water_shelter'
            ? 'pinned_water_shelter'
            : 'compositor_floor_texture';
          snap.w = iw;
          snap.h = ih;
          snap.gpuRowOrder = false;
          snap._outdoorsTexUuid = floorOutTex?.uuid ?? null;
        }
      } else if (!hasFloorCpu) {
        snap.maskSource = 'no_floor_outdoors_source';
      }
      snap.uniformImageFallbackAllowed = !!floorOutTex;
    } catch (e) {
      snap.error = String(e?.message || e);
    }
    return snap;
  }

  function sampleOutdoorsAtWorld(worldX, worldY, snap, ownerSceneBounds) {
    if (!snap?.hasOutdoorsMask || !snap.w || !snap.h || !ownerSceneBounds) {
      return { ok: false, reason: snap?.maskSource || 'no_outdoors_data' };
    }
    const b = ownerSceneBounds;
    const u = Math.max(0, Math.min(1, (worldX - b.sx) / Math.max(1e-6, b.sw)));
    const vFoundry = Math.max(0, Math.min(1, 1 - ((worldY - b.syWorld) / Math.max(1e-6, b.sh))));
    const texY = snap.outdoorsMaskFlipY ? (1.0 - vFoundry) : vFoundry;
    const px = Math.max(0, Math.min(snap.w - 1, Math.floor(u * (snap.w - 1))));
    const pyRow = Math.max(0, Math.min(snap.h - 1, Math.floor(texY * (snap.h - 1))));
    const py = snap.gpuRowOrder ? ((snap.h - 1) - pyRow) : pyRow;
    const i = (py * snap.w + px) * 4;

    if (snap._pixelBuf) {
      const r8 = snap._pixelBuf[i];
      const g8 = snap._pixelBuf[i + 1];
      const b8 = snap._pixelBuf[i + 2];
      const a8 = snap._pixelBuf[i + 3];
      const decoded = decodeOutdoorsMaskSample8(r8, g8, b8, a8);
      return {
        ok: true,
        decoded: Number(decoded.toFixed(4)),
        rawR: Number((r8 / 255).toFixed(4)),
        rgba: [r8, g8, b8, a8],
        windDriftMul: Number((0.05 + 0.95 * decoded).toFixed(4)),
        px,
        py,
        u: Number(u.toFixed(4)),
        v: Number(vFoundry.toFixed(4)),
        maskSource: snap.maskSource,
        decode: 'msDecodeOutdoorsMaskSample',
      };
    }
    return {
      ok: false,
      reason: 'no_cpu_buffer_in_probe',
      maskSource: snap.maskSource,
      uniformTexUuid: snap._outdoorsTexUuid ?? null,
    };
  }

  function outdoorsBrief(snap) {
    if (!snap) return null;
    const fc = ms.floorCompositorV2 ?? ms.effectComposer?._floorCompositorV2 ?? null;
    const pinned = fc?._waterShelterOutdoorsTexture ?? null;
    return {
      hasOutdoorsMask: !!snap.hasOutdoorsMask,
      indoorSuppressionStrength: snap.indoorSuppressionStrength,
      floorKey: snap.floorKey,
      compositorGen: snap.compositorGen,
      w: snap.w,
      h: snap.h,
      gpuRowOrder: snap.gpuRowOrder,
      maskSource: snap.maskSource,
      maskDecode: 'msDecodeOutdoorsMaskSample',
      outdoorsMaskFlipY: !!snap.outdoorsMaskFlipY,
      splashUsesWaterWaveIndoorDamping: false,
      waterWaveIndoorDampingEnabled: snap.waterWaveIndoorDampingEnabled ?? null,
      waterWaveIndoorDampingStrength: snap.waterWaveIndoorDampingStrength ?? null,
      pinnedShelterUuid: pinned?.uuid ?? null,
      pinnedShelterFloorKey: fc?._waterShelterOutdoorsFloorKey ?? null,
      uniformImageFallbackAllowed: snap.uniformImageFallbackAllowed,
      error: snap.error ?? null,
    };
  }

  function simulateFoamLifecycleSample(snap, ownerParams) {
    const wind01 = 0.15;
    const foamWindMul = 0.42 + 0.58 * wind01;
    const tintStrength = Number(ownerParams?.tintStrength) || 0;
    const tintJitter = Number(ownerParams?.tintJitter) || 0;
    const aR = Number(ownerParams?.tintAColorR) || 1;
    const aG = Number(ownerParams?.tintAColorG) || 1;
    const aB = Number(ownerParams?.tintAColorB) || 1;
    const bR = Number(ownerParams?.tintBColorR) || 0.1;
    const bG = Number(ownerParams?.tintBColorG) || 0.55;
    const bB = Number(ownerParams?.tintBColorB) || 0.75;
    const foamPeak = Number(ownerParams?.foamPeakOpacity) || 0.64;
    const lifeT = 0.35;
    const sizeT = 0.4;
    const alphaEnv = 0.64 * foamPeak;
    const sizeEnv = 1.0 + 0.5 * sizeT;
    const tintMul = 1 + tintStrength * (0.5 + 0.5 * tintJitter);
    const r = Math.min(2, aR * tintMul);
    const g = Math.min(2, aG * tintMul);
    const b = Math.min(2, aB * tintMul);
    const br = Math.min(2, bR * tintMul);
    const bg = Math.min(2, bG * tintMul);
    const bb = Math.min(2, bB * tintMul);
    return {
      indoorSuppressionStrength: Number(snap?.indoorSuppressionStrength) || 0,
      waterWaveIndoorDampingEnabled: snap?.waterWaveIndoorDampingEnabled ?? null,
      alphaEnvelopeAt35Life: Number(alphaEnv.toFixed(4)),
      sizeEnvelopeAt40Life: Number(sizeEnv.toFixed(4)),
      tintRGB: { r: Number(r.toFixed(3)), g: Number(g.toFixed(3)), b: Number(b.toFixed(3)) },
      foamWindMul: Number(foamWindMul.toFixed(3)),
    };
  }

  function computeEffectiveEmissionSample(sys, params, isSplash) {
    if (!sys?.emissionOverTime) return null;
    const w = (sys.userData?._msEmissionScaleDynamic ?? sys.userData?._msEmissionScale) ?? 1;
    if (!Number.isFinite(w) || w <= 0) return { scale: w, a: null, b: null };
    const rateMult = isSplash ? 40 : 40;
    const baseRate = Number(isSplash ? params.splashRate : params.foamRate) || 0;
    const rate = Math.max(0, baseRate * rateMult);
    let precip = 0;
    try {
      precip = Number(weatherController?.getCurrentState?.()?.precipitation ?? 0);
      if (!Number.isFinite(precip)) precip = 0;
    } catch (_) {}
    let wind01 = 0.15;
    try {
      const drift = globalThis.MapShine?.resolveEffectWindParticleDrift?.();
      if (drift) wind01 = Number(drift.speed01) || 0.15;
    } catch (_) {}
    const splashWindMul = 0.55 + 0.45 * wind01;
    const foamWindMul = 0.42 + 0.58 * wind01;
    const a = Math.max(0.2, rate * w * 0.5 * (isSplash ? splashWindMul : foamWindMul) * Math.max(0, precip));
    const b = Math.max(0.5, rate * w * (isSplash ? splashWindMul : foamWindMul) * Math.max(0, precip));
    return { scale: w, a: Number(a.toFixed(3)), b: Number(b.toFixed(3)), precip: Number(precip.toFixed(3)) };
  }

  /** Water-parity masks (see water-screen-occlusion.js / water-shader.js). */
  function resolveWaterParityOcclusionMeta(fc, viewFloor, systemFloorIndex) {
    const sfi = Number(systemFloorIndex);
    const view = Number(viewFloor);
    if (!Number.isFinite(sfi)) {
      return { source: 'invalid', masks: {} };
    }
    let waterFi = -1;
    try { waterFi = Number(fc?._resolveWaterSourceFloorForView?.(view) ?? -1); } catch (_) {}
    const masks = {
      tWaterOccluderAlpha: null,
      tOverheadRoofBlock: null,
      tSliceAlpha: null,
      tWaterBgAlphaMask: fc?._frameWaterBgAlphaMaskTex ?? window.MapShine?.__frameWaterBgAlphaMaskTex ?? null,
    };
    if (sfi < view) {
      masks.tWaterOccluderAlpha = fc?._frameSplashUpperOccluderTexByFloor?.get?.(sfi)
        ?? (sfi === waterFi ? fc?._frameUpperWaterOccluderRT?.texture : null)
        ?? null;
    }
    if (sfi === waterFi && waterFi >= 0) {
      masks.tOverheadRoofBlock = fc?._frameWaterSourceDeckTex ?? null;
      masks.tSliceAlpha = fc?._frameWaterSourceSliceTex ?? null;
    } else if (sfi === view) {
      masks.tOverheadRoofBlock = fc?._frameSameFloorOverheadOccluderRT?.texture
        ?? window.MapShine?.__frameSameFloorOverheadOccluderTex
        ?? null;
    }
    return {
      source: 'water-parity',
      masks: {
        waterOccluder: texBrief(masks.tWaterOccluderAlpha),
        overheadRoof: texBrief(masks.tOverheadRoofBlock),
        sliceAlpha: texBrief(masks.tSliceAlpha),
        bgAlpha: texBrief(masks.tWaterBgAlphaMask),
      },
    };
  }

  function capture(label) {
    const viewedFloor = Number(floorStack?.getActiveFloor?.()?.index ?? NaN);
    const activeCtx = ms.activeLevelContext ?? null;
    const waterDataFloor = Number.isFinite(we?._activeFloorIndex) ? Number(we._activeFloorIndex) : null;
    let waterSourceForView = waterDataFloor;
    try {
      if (typeof fc?._resolveWaterSourceFloorForView === 'function' && Number.isFinite(viewedFloor)) {
        waterSourceForView = fc._resolveWaterSourceFloorForView(viewedFloor);
      }
    } catch (_) {}

    const ws = fc?._waterSplashesEffect;
    const activeFloorsArr = ws?._activeFloors ? [...ws._activeFloors] : [];
    const floorStateKeys = ws?._floorStates ? [...ws._floorStates.keys()] : [];

    let precip = null;
    let wind01 = null;
    try {
      precip = Number(weatherController?.getCurrentState?.()?.precipitation);
      const drift = globalThis.MapShine?.resolveEffectWindParticleDrift?.();
      wind01 = drift ? Number(drift.speed01) : null;
    } catch (_) {}

    let splashAmbientDay = null;
    try {
      const sky = fc?._skyColorEffect;
      const skyI = Number(sky?.currentSkyIntensity01);
      const dark01 = Number(globalThis.LightingDirector?.get?.()?.masterDarkness ?? 0);
      if (Number.isFinite(skyI) && Number.isFinite(dark01)) {
        splashAmbientDay = Math.max(0, Math.min(1, skyI * (1 - 0.92 * dark01)));
      }
    } catch (_) {}

    const sm = fc?._shadowManagerEffect;
    const shadow = {
      hasCombined: !!sm?.combinedShadowTexture,
      combinedUuid: sm?.combinedShadowTexture?.uuid ?? null,
      hasRaw: !!sm?.combinedShadowRawTexture,
      rawUuid: sm?.combinedShadowRawTexture?.uuid ?? null,
    };

    let waterUniforms = null;
    try {
      const u = we?._composeMaterial?.uniforms;
      if (u) {
        waterUniforms = {
          uHasOutdoorsMask: Number(u.uHasOutdoorsMask?.value),
          uOutdoorsMaskFlipY: Number(u.uOutdoorsMaskFlipY?.value),
          tOutdoorsMask: texBrief(u.tOutdoorsMask?.value),
        };
      }
    } catch (_) {}

    const outdoorsToken = (ws?._outdoorsMaskFrameToken ?? 0) + 1;

    const floors = {};
    for (const fi of floorStateKeys) {
      const st = ws?._floorStates?.get?.(fi);
      if (!st) continue;

      const foamN = st.foamSystems?.length ?? 0;
      const splashN = st.splashSystems?.length ?? 0;
      const foam2N = st.foamSystems2?.length ?? 0;
      const splash2N = st.splashSystems2?.length ?? 0;

      let sampleSys = null;
      const all = [];
      if (st.foamSystems?.length) {
        all.push(st.foamSystems[0]);
        sampleSys = st.foamSystems[0];
      } else if (st.splashSystems?.length) {
        all.push(st.splashSystems[0]);
        sampleSys = st.splashSystems[0];
      }

      const emission = sampleSys
        ? computeEffectiveEmissionSample(sampleSys, ws?.params ?? {}, false)
        : null;

      const outdoorsSnapRaw = probeSyncOutdoorsForFloor(fi, outdoorsToken);
      const outdoorsSnap = outdoorsBrief(outdoorsSnapRaw);
      const compositorKey = resolveCompositorFloorKey(fi);

      let compositorCpu = null;
      try {
        const cpuPx = readProbeOutdoorsCpuPixels(compositorKey);
        if (cpuPx) compositorCpu = { w: cpuPx.w, h: cpuPx.h, hasBuffer: true };
      } catch (_) {}

      let waterMaskForFloor = null;
      try {
        if (typeof ws?.getWaterMaskTextureForFloor === 'function') {
          waterMaskForFloor = texBrief(ws.getWaterMaskTextureForFloor(fi));
        }
      } catch (_) {}

      const occMeta = resolveWaterParityOcclusionMeta(fc, viewedFloor, fi);

      const lifecycleSim = simulateFoamLifecycleSample(outdoorsSnapRaw, ws?.params);

      let outdoorSample = null;
      let outdoorSampleRuntime = null;
      if (ws?._sceneBounds) {
        const b = ws._sceneBounds;
        const wx = b.sx + 0.5 * b.sw;
        const wy = b.syWorld + 0.5 * b.sh;
        outdoorSample = sampleOutdoorsAtWorld(wx, wy, outdoorsSnapRaw, b);
        try {
          if (typeof ws.sampleSplashOutdoorsAtWorld === 'function') {
            const decoded = ws.sampleSplashOutdoorsAtWorld(fi, wx, wy);
            outdoorSampleRuntime = {
              decoded: Number.isFinite(decoded) ? Number(decoded.toFixed(4)) : null,
              windDriftMul: Number.isFinite(decoded) ? Number((0.05 + 0.95 * decoded).toFixed(4)) : null,
            };
          }
        } catch (_) {}
      }

      let splashOccluderTiles = null;
      try {
        const bus = fc?._renderBus;
        if (bus && typeof bus.hasSplashOccluderTilesForFloor === 'function') {
          splashOccluderTiles = bus.hasSplashOccluderTilesForFloor(fi);
        }
      } catch (_) {}

      const sysFloorIdx = sampleSys?.userData?._msFloorIndex ?? fi;

      floors[String(fi)] = {
        compositorKey,
        active: activeFloorsArr.includes(fi),
        isWaterDataFloor: waterDataFloor === fi,
        systemCounts: { foam: foamN, splash: splashN, bubbleFoam: foam2N, bubbleSplash: splash2N },
        sampleSystemFloorIndex: sysFloorIdx,
        emissionSample: emission,
        outdoors: outdoorsSnap,
        compositorCpuOutdoors: compositorCpu,
        waterMask: waterMaskForFloor,
        waterParityOcclusion: occMeta,
        splashOccluderTilesOnFloor: splashOccluderTiles,
        frameSameFloorOverheadOccluder: texBrief(
          fc?._frameSameFloorOverheadOccluderRT?.texture
            ?? window.MapShine?.__frameSameFloorOverheadOccluderTex
            ?? null,
        ),
        frameUpperSplashOccluder: texBrief(
          fc?._frameUpperSplashOccluderRT?.texture
            ?? window.MapShine?.__frameUpperSplashOccluderTex
            ?? null,
        ),
        lifecycleSim,
        outdoorSample,
        outdoorSampleRuntime,
      };
    }

    const report = {
      label: label || 'capture',
      capturedAt: new Date().toISOString(),
      sceneId: canvas?.scene?.id ?? null,
      sceneName: canvas?.scene?.name ?? null,
      viewedFloor: Number.isFinite(viewedFloor) ? viewedFloor : null,
      activeLevelContext: activeCtx ? {
        bottom: activeCtx.bottom,
        top: activeCtx.top,
        label: activeCtx.label,
        index: activeCtx.index,
        count: activeCtx.count,
      } : null,
      waterEffect: {
        activeFloorIndex: waterDataFloor,
        sourceFloorForView: waterSourceForView,
        crossFloorWaterView: typeof fc?._hasCrossFloorWaterView === 'function'
          ? !!fc._hasCrossFloorWaterView()
          : null,
        uniforms: waterUniforms,
        maskGlobal: texBrief(we?.getWaterMaskTexture?.()),
      },
      splashes: {
        enabled: ws?.enabled,
        initialized: ws?._initialized,
        splashViewEpoch: ws?._splashViewEpoch ?? null,
        params: pickParams(ws?.params, PARAM_KEYS),
        bubblesParams: pickParams(ws?.bubblesParams, BUBBLE_KEYS),
        activeFloors: activeFloorsArr,
        floorStateKeys,
        activeFloorsGeneration: ws?._activeFloorsGeneration ?? null,
        outdoorsFrameToken: ws?._outdoorsMaskFrameToken ?? null,
      },
      environment: {
        precip: Number.isFinite(precip) ? precip : null,
        wind01: Number.isFinite(wind01) ? wind01 : null,
        splashAmbientDay: Number.isFinite(splashAmbientDay) ? Number(splashAmbientDay.toFixed(4)) : null,
      },
      shadow,
      frameUpperWaterOccluder: texBrief(fc?._frameUpperWaterOccluderRT?.texture),
      floors,
    };

    if (!globalThis.__msaSplashProbeReports) globalThis.__msaSplashProbeReports = [];
    globalThis.__msaSplashProbeReports.push(report);
    globalThis.__msaSplashProbeLast = report;
    ms.__msaSplashProbeReports = globalThis.__msaSplashProbeReports;
    ms.__msaSplashProbeLast = report;

    console.log('=== MSA SPLASH FLOOR PROBE ===', label);
    console.log(JSON.stringify(report, null, 2));
    return report;
  }

  function diffKeys(a, b, prefix = '') {
    const out = [];
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      const va = a[k];
      const vb = b[k];
      if (JSON.stringify(va) !== JSON.stringify(vb)) {
        out.push(prefix + k);
      }
    }
    return out.sort();
  }

  function compare(i, j) {
    const a = globalThis.__msaSplashProbeReports?.[i];
    const b = globalThis.__msaSplashProbeReports?.[j];
    if (!a || !b) {
      console.warn('Need two captures in MapShine.__msaSplashProbeReports');
      return;
    }
    const floorKeys = [...new Set([
      ...Object.keys(a.floors || {}),
      ...Object.keys(b.floors || {}),
    ])];
    const diffs = {};
    for (const fk of floorKeys) {
      const fa = a.floors[fk];
      const fb = b.floors[fk];
      if (!fa || !fb) continue;
      const row = {};
      if (JSON.stringify(fa.lifecycleSim) !== JSON.stringify(fb.lifecycleSim)) {
        row.lifecycleSim = { a: fa.lifecycleSim, b: fb.lifecycleSim };
      }
      if (JSON.stringify(fa.outdoorSample) !== JSON.stringify(fb.outdoorSample)) {
        row.outdoorSample = { a: fa.outdoorSample, b: fb.outdoorSample };
      }
      if (JSON.stringify(fa.emissionSample) !== JSON.stringify(fb.emissionSample)) {
        row.emissionSample = { a: fa.emissionSample, b: fb.emissionSample };
      }
      if (fa.outdoors?.indoorSuppressionStrength !== fb.outdoors?.indoorSuppressionStrength) {
        row[`outdoors.indoorSuppressionStrength`] = { a: fa.outdoors, b: fb.outdoors };
      }
      if (fa.active !== fb.active) {
        row.active = { a: fa.active, b: fb.active };
      }
      if (fa.isWaterDataFloor !== fb.isWaterDataFloor) {
        row.isWaterDataFloor = { a: fa.isWaterDataFloor, b: fb.isWaterDataFloor };
      }
      if (Object.keys(row).length) diffs[`floor.${fk}`] = row;
    }
    const top = {
      splashesParams: diffKeys(a.splashes?.params, b.splashes?.params, 'splashes.params.'),
      bubblesParams: diffKeys(a.splashes?.bubblesParams, b.splashes?.bubblesParams, 'splashes.bubblesParams.'),
      environment: diffKeys(a.environment, b.environment, 'environment.'),
      shadow: diffKeys(a.shadow, b.shadow, 'shadow.'),
      waterEffect: diffKeys(a.waterEffect, b.waterEffect, 'waterEffect.'),
      activeFloors: { a: a.splashes?.activeFloors, b: b.splashes?.activeFloors },
      frameOccluder: { a: a.frameUpperWaterOccluder, b: b.frameUpperWaterOccluder },
    };
    console.log('=== MSA SPLASH PROBE DIFF ===', a.label, 'vs', b.label);
    console.log(JSON.stringify({ top, floorDiffs: diffs }, null, 2));
    return { top, floorDiffs: diffs };
  }

  /**
   * Sample live splash outdoors decode at world XY (uses module sync + msDecode).
   * @param {number} worldX
   * @param {number} worldY
   * @param {number} [floorIndex=0]
   */
  async function sampleOutdoorsLive(worldX, worldY, floorIndex = 0) {
    const ws = fc?._waterSplashesEffect;
    if (!ws?._sceneBounds) return { ok: false, reason: 'no_scene_bounds' };
    try {
      const url = `modules/map-shine-advanced/scripts/compositor-v2/effects/water-splash-behaviors.js?v=${Date.now()}`;
      const mod = await import(url);
      if (typeof mod.sampleSplashOutdoorsAtWorld !== 'function') {
        return { ok: false, reason: 'sampleSplashOutdoorsAtWorld missing' };
      }
      const decoded = mod.sampleSplashOutdoorsAtWorld(floorIndex, worldX, worldY, ws);
      const d = Number.isFinite(decoded) ? decoded : null;
      return {
        ok: d != null,
        decoded: d != null ? Number(d.toFixed(4)) : null,
        windDriftMul: d != null ? Number((0.05 + 0.95 * d).toFixed(4)) : null,
        floorIndex,
        worldX,
        worldY,
      };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /**
   * Read same-floor splash occluder RT at drawing-buffer pixel (bottom-left origin).
   * @param {number} px
   * @param {number} py
   */
  function sampleSplashOccluderAtPixel(px, py) {
    const readRT = fc?._frameSameFloorOverheadOccluderRT
      ?? fc?._splashSameFloorOverheadRT
      ?? null;
    const tex = readRT?.texture
      ?? fc?._frameSameFloorOverheadOccluderRT?.texture
      ?? window.MapShine?.__frameSameFloorOverheadOccluderTex
      ?? null;
    const renderer = window.MapShine?.renderer ?? window.canvas?.app?.renderer;
    if (!tex || !readRT || !renderer || typeof renderer.readRenderTargetPixels !== 'function') {
      return { ok: false, reason: 'no_tex_or_renderer' };
    }
    const w = Number(readRT?.width) || Number(tex.image?.width) || 0;
    const h = Number(readRT?.height) || Number(tex.image?.height) || 0;
    if (!(w > 0 && h > 0)) return { ok: false, reason: 'no_dims', w, h };
    const x = Math.max(0, Math.min(w - 1, Math.floor(Number(px) || 0)));
    const y = Math.max(0, Math.min(h - 1, Math.floor(Number(py) || 0)));
    const buf = new Uint8Array(4);
    try {
      renderer.readRenderTargetPixels(readRT, x, y, 1, 1, buf);
      const r = buf[0] / 255;
      const a = buf[3] / 255;
      const presence = Math.max(r, a);
      return { ok: true, x, y, w, h, r, a, presence: Number(presence.toFixed(4)) };
    } catch (e) {
      return { ok: false, reason: 'read_failed', error: String(e?.message || e) };
    }
  }

  globalThis.msaSplashProbeCapture = capture;
  globalThis.msaSplashProbeOccluderAtPixel = sampleSplashOccluderAtPixel;
  globalThis.msaSplashProbeCompare = compare;
  globalThis.msaSplashProbeDiff = compare;
  globalThis.msaSplashSampleOutdoors = sampleOutdoorsLive;
  ms.msaSplashProbeCapture = capture;
  ms.msaSplashProbeCompare = compare;
  ms.msaSplashSampleOutdoors = sampleOutdoorsLive;
  ms.loadSplashFloorProbe = async function loadSplashFloorProbe() {
    if (typeof ms.msaSplashProbeCapture === 'function') return true;
    const url = `modules/map-shine-advanced/scripts/utils/water-splash-floor-probe-console-snippet.js?v=${Date.now()}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`splash probe fetch failed: ${res.status}`);
    // Snippet is DevTools-only; eval after fetch avoids paste/syntax mistakes.
    // eslint-disable-next-line no-eval
    eval(await res.text());
    return true;
  };
  globalThis.__msaSplashProbeReports = globalThis.__msaSplashProbeReports || [];
  ms.__msaSplashProbeReports = globalThis.__msaSplashProbeReports;
  globalThis.__msaSplashProbeLast = null;

  ms.msaSplashProbeOccluderAtPixel = sampleSplashOccluderAtPixel;
  console.log('[MSA] splash probe ready: msaSplashProbeCapture("ground"), msaSplashProbeOccluderAtPixel(px,py), msaSplashSampleOutdoors(wx,wy,0)');
})();