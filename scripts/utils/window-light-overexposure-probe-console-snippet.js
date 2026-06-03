/**
 * DevTools-only: paste the entire IIFE into the Foundry browser console after the scene
 * has rendered at least one frame with window light enabled.
 *
 * `node --check scripts/utils/window-light-overexposure-probe-console-snippet.js`
 *
 * After run:
 *   MapShine.__windowLightOverexposureProbeLast
 *   copy(MapShine.__windowLightOverexposureProbeJson)
 */
(function mapShineWindowLightOverexposureProbe() {
  const ms = window.MapShine;
  const THREE = window.THREE;
  const warnings = [];
  const flags = [];

  function publish(result) {
    if (ms) {
      ms.__windowLightOverexposureProbeLast = result;
      ms.__windowLightOverexposureProbeJson = JSON.stringify(result, null, 2);
    }
    if (flags.length) {
      console.warn('[Window light probe] flags (' + flags.length + '):');
      for (let i = 0; i < flags.length; i += 1) console.warn('  ' + (i + 1) + '. ' + flags[i]);
    }
    if (warnings.length) {
      console.warn('[Window light probe] warnings (' + warnings.length + '):');
      for (let i = 0; i < warnings.length; i += 1) console.warn('  ' + (i + 1) + '. ' + warnings[i]);
    }
    console.log('--- Map Shine WINDOW LIGHT OVEREXPOSURE PROBE ---');
    if (ms) console.log('Tip: copy(MapShine.__windowLightOverexposureProbeJson)');
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  function effOn(e) {
    return !!(e && e.enabled !== false && e.params && e.params.enabled !== false);
  }

  function rtDim(rt) {
    if (!rt) return null;
    return {
      w: rt.width | 0,
      h: rt.height | 0,
      halfFloat: rt.texture?.type === THREE?.HalfFloatType,
      uuid: rt.texture?.uuid ?? null,
    };
  }

  const fromHalfFloat = (() => {
    const f = THREE?.DataUtils?.fromHalfFloat;
    if (typeof f === 'function') return f;
    return (val) => {
      const m = val >> 10;
      const exponent = (m & 0x1f) - 15;
      const mantissa = val & 0x3ff;
      if (exponent === 16) return mantissa ? NaN : (val & 0x8000 ? -Infinity : Infinity);
      if (exponent === -15) {
        return mantissa
          ? (mantissa / 1024) * Math.pow(2, -14) * (val & 0x8000 ? -1 : 1)
          : 0;
      }
      return Math.pow(2, exponent) * (1 + mantissa / 1024) * (val & 0x8000 ? -1 : 1);
    };
  })();

  function isHalfFloatRt(rt) {
    return rt?.texture?.type === THREE?.HalfFloatType;
  }

  function createReadBuf(rt) {
    return isHalfFloatRt(rt) ? new Uint16Array(4) : new Uint8Array(4);
  }

  function decodeBuf(buf, rt) {
    if (isHalfFloatRt(rt)) {
      return {
        r: Math.max(0, fromHalfFloat(buf[0])),
        g: Math.max(0, fromHalfFloat(buf[1])),
        b: Math.max(0, fromHalfFloat(buf[2])),
        a: Math.max(0, fromHalfFloat(buf[3])),
      };
    }
    return {
      r: buf[0] / 255,
      g: buf[1] / 255,
      b: buf[2] / 255,
      a: buf[3] / 255,
    };
  }

  function luma(rgb) {
    return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  }

  function sampleRt(renderer, rt, u, v) {
    if (!renderer || !rt?.width || !rt?.height) return { error: 'no_rt' };
    const rw = rt.width | 0;
    const rh = rt.height | 0;
    const px = Math.max(0, Math.min(rw - 1, Math.floor(Math.max(0, Math.min(1, u)) * (rw - 1))));
    const py = Math.max(0, Math.min(rh - 1, rh - 1 - Math.floor(Math.max(0, Math.min(1, v)) * (rh - 1))));
    const buf = createReadBuf(rt);
    try {
      renderer.readRenderTargetPixels(rt, px, py, 1, 1, buf);
      const c = decodeBuf(buf, rt);
      return { u, v, px, py, ...c, luma: luma(c) };
    } catch (e) {
      return { u, v, px, py, error: String(e?.message || e) };
    }
  }

  function scanRt(renderer, rt, gridSize) {
    const gs = Math.max(2, Math.min(16, gridSize | 0 || 8));
    if (!renderer || !rt?.width || !rt?.height) return { error: 'no_rt' };
    const lumas = [];
    let maxLuma = 0;
    let maxAt = { u: 0, v: 0 };
    let sum = 0;
    let readErrors = 0;
    for (let gy = 0; gy < gs; gy += 1) {
      for (let gx = 0; gx < gs; gx += 1) {
        const u = (gx + 0.5) / gs;
        const v = (gy + 0.5) / gs;
        const s = sampleRt(renderer, rt, u, v);
        if (s.error) {
          readErrors += 1;
          continue;
        }
        lumas.push(s.luma);
        sum += s.luma;
        if (s.luma > maxLuma) {
          maxLuma = s.luma;
          maxAt = { u: s.u, v: s.v };
        }
      }
    }
    lumas.sort((a, b) => a - b);
    const n = lumas.length;
    const median = n ? lumas[(n / 2) | 0] : 0;
    const p90 = n ? lumas[Math.min(n - 1, Math.floor(n * 0.9))] : 0;
    const avg = n ? sum / n : 0;
    const highCount = lumas.filter((x) => x > 0.12).length;
    const highFrac = n ? highCount / n : 0;
    return {
      gridSize: gs,
      sampleCount: n,
      readErrors,
      halfFloat: isHalfFloatRt(rt),
      maxLuma,
      maxAt,
      medianLuma: median,
      p90Luma: p90,
      avgLuma: avg,
      highLumaFrac_gt0_12: highFrac,
    };
  }

  function sceneUvFromWorld(wx, wy) {
    const dims = canvas?.dimensions;
    if (!dims) return null;
    const sr = dims.sceneRect ?? dims;
    const sceneX = Number(sr.x ?? 0);
    const sceneY = Number(sr.y ?? 0);
    const sceneW = Number(sr.width ?? dims.sceneWidth ?? 1);
    const sceneH = Number(sr.height ?? dims.sceneHeight ?? 1);
    const canvasH = Number(dims.height ?? 1);
    const foundryY = canvasH - wy;
    const u = (wx - sceneX) / Math.max(1e-5, sceneW);
    const vFoundry = (foundryY - sceneY) / Math.max(1e-5, sceneH);
    return {
      u,
      v: vFoundry,
      vEmitAtlas: vFoundry,
      inBounds: u >= 0 && u <= 1 && vFoundry >= 0 && vFoundry <= 1,
    };
  }

  function screenUvFromClient(clientX, clientY) {
    const view = canvas?.app?.view;
    if (!view) return null;
    const rect = view.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      u: (clientX - rect.left) / rect.width,
      v: (clientY - rect.top) / rect.height,
    };
  }

  function centerScenePoint() {
    try {
      const view = canvas?.app?.view;
      if (!view) return null;
      const rect = view.getBoundingClientRect();
      const client = { x: rect.left + rect.width * 0.5, y: rect.top + rect.height * 0.5 };
      if (typeof canvas.canvasCoordinatesFromClient === 'function') {
        const p = canvas.canvasCoordinatesFromClient(client);
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y, source: 'canvasCenter' };
      }
    } catch (_) {}
    return null;
  }

  function estComposeMultiplier(winLuma, gain) {
    const clamped = Math.min(Math.max(winLuma, 0), 1.0);
    const winApply = clamped <= 0.12 ? 0 : clamped <= 0.28 ? (clamped - 0.12) / 0.16 : 1;
    const boost = clamped * Math.max(0, gain) * winApply;
    return 1 + boost;
  }

  const renderer = ms?.renderer ?? null;
  const fc = ms?.effectComposer?._floorCompositorV2 ?? ms?.floorCompositorV2 ?? null;
  const le = fc?._lightingEffect ?? null;
  const wle = fc?._windowLightEffect ?? null;

  if (!renderer) warnings.push('MapShine.renderer missing — run after scene load.');
  if (!le) warnings.push('LightingEffectV2 instance missing.');
  if (!wle) warnings.push('WindowLightEffectV2 instance missing.');

  const dims = canvas?.dimensions ?? null;
  const sr = dims?.sceneRect ?? dims;
  const live = typeof le?.getPerformanceRecorderSnapshot === 'function'
    ? le.getPerformanceRecorderSnapshot()
    : null;
  const wleLive = typeof wle?.getEmitPerformanceSnapshot === 'function'
    ? wle.getEmitPerformanceSnapshot()
    : null;

  const emitRt = wle?._emitRT ?? null;
  const composeRt = le?._windowLightRT ?? null;
  const cu = le?._composeMaterial?.uniforms ?? null;
  const blitOk = le?._windowComposeBlitValid === true;
  const composeUsesScreenSpace = cu?.uWindowLightScreenSpace?.value > 0.5;

  const composeUniforms = cu ? {
    uHasLightWindow: cu.uHasLightWindow?.value,
    uWindowLightScreenSpace: cu.uWindowLightScreenSpace?.value,
    uWindowEmissiveGain: cu.uWindowEmissiveGain?.value,
    tLightWindowUuid: cu.tLightWindow?.value?.uuid ?? null,
    tLightWindowIsComposeRt: cu.tLightWindow?.value === composeRt?.texture,
    tLightWindowIsEmitRt: cu.tLightWindow?.value === emitRt?.texture,
    uBldSceneOrigin: cu.uBldSceneOrigin?.value ? [cu.uBldSceneOrigin.value.x, cu.uBldSceneOrigin.value.y] : null,
    uBldSceneSize: cu.uBldSceneSize?.value ? [cu.uBldSceneSize.value.x, cu.uBldSceneSize.value.y] : null,
    uSceneDimensions: cu.uSceneDimensions?.value ? [cu.uSceneDimensions.value.x, cu.uSceneDimensions.value.y] : null,
  } : null;

  const composeFrag = le?._composeMaterial?.fragmentShader ?? '';
  const shaderCompile = {
    hasMagOnlyMarker: composeFrag.includes('MSA_COMPOSE_DIRECT_BASELINE'),
    hasLegacyDirectBaseline: /baseIllum\s*=\s*1\.0\s*\+\s*lampEnergyA/.test(composeFrag),
    hasMagOnlyAssign: /baseIllum\s*=\s*lampEnergyA/.test(composeFrag),
  };
  const lightRt = le?._lightRT ?? null;
  const cc = fc?._colorCorrectionEffect ?? null;
  const ccu = cc?._composeMaterial?.uniforms ?? null;
  const view = canvas?.app?.view;
  const viewRect = view?.getBoundingClientRect?.();
  const screenCenterUv = viewRect
    ? screenUvFromClient(viewRect.left + viewRect.width * 0.5, viewRect.top + viewRect.height * 0.5)
    : { u: 0.5, v: 0.5 };
  const lightingCompose = {
    shaderCompile,
    params: le?.params ? {
      ambientDayScale: le.params.ambientDayScale,
      ambientDayScaleOutdoor: le.params.ambientDayScaleOutdoor,
      ambientDayScaleIndoor: le.params.ambientDayScaleIndoor,
      ambientNightScale: le.params.ambientNightScale,
      ambientNightScaleOutdoor: le.params.ambientNightScaleOutdoor,
      ambientNightScaleIndoor: le.params.ambientNightScaleIndoor,
      globalIllumination: le.params.globalIllumination,
      minIlluminationScale: le.params.minIlluminationScale,
      darknessLevel: le.params.darknessLevel,
      lightIntensity: le.params.lightIntensity,
    } : null,
    uniforms: cu ? {
      uAmbientDayScale: cu.uAmbientDayScale?.value,
      uAmbientDayScaleOutdoor: cu.uAmbientDayScaleOutdoor?.value,
      uAmbientDayScaleIndoor: cu.uAmbientDayScaleIndoor?.value,
      uAmbientNightScale: cu.uAmbientNightScale?.value,
      uAmbientNightScaleOutdoor: cu.uAmbientNightScaleOutdoor?.value,
      uAmbientNightScaleIndoor: cu.uAmbientNightScaleIndoor?.value,
      uMinIlluminationScale: cu.uMinIlluminationScale?.value,
      uCalendarDayWeight: cu.uCalendarDayWeight?.value,
      uDarknessLevel: cu.uDarknessLevel?.value,
      uAmbientBrightest: cu.uAmbientBrightest?.value
        ? [cu.uAmbientBrightest.value.r, cu.uAmbientBrightest.value.g, cu.uAmbientBrightest.value.b]
        : null,
      uAmbientDarkness: cu.uAmbientDarkness?.value
        ? [cu.uAmbientDarkness.value.r, cu.uAmbientDarkness.value.g, cu.uAmbientDarkness.value.b]
        : null,
    } : null,
    lightRtCenter: lightRt ? sampleRt(renderer, lightRt, screenCenterUv.u, screenCenterUv.v) : { error: 'no_light_rt' },
    lightRtScan: lightRt ? scanRt(renderer, lightRt, 8) : { error: 'no_light_rt' },
    colorCorrection: ccu ? {
      uHasLocalLightBuffer: ccu.uHasLocalLightBuffer?.value,
      uLocalLightAlphaBaseline: ccu.uLocalLightAlphaBaseline?.value,
      uExposure: ccu.uExposure?.value,
      uDynamicExposure: ccu.uDynamicExposure?.value,
      uBrightness: ccu.uBrightness?.value,
    } : null,
  };

  const emitScan = renderer && emitRt ? scanRt(renderer, emitRt, 10) : { error: 'emit_unavailable' };
  const composeScan = renderer && composeRt ? scanRt(renderer, composeRt, 10) : { error: 'compose_unavailable' };

  const screenSamples = {
    centerEmitSceneUv: sampleRt(renderer, emitRt, 0.5, 0.5),
    centerComposeRt: sampleRt(renderer, composeRt, 0.5, 0.5),
  };

  const emitScreenSamples = {
    centerSceneUv: sampleRt(renderer, emitRt, 0.5, 0.5),
    cornerSceneUv: sampleRt(renderer, emitRt, 0.05, 0.05),
  };

  const centerWorld = centerScenePoint();
  let worldProbe = null;
  if (centerWorld && typeof wle?.probeAtWorld === 'function') {
    try {
      worldProbe = wle.probeAtWorld(centerWorld.x, centerWorld.y, {
        floorIdx: ms?.activeLevelContext?.floorIndex,
      });
    } catch (e) {
      worldProbe = { error: String(e?.message || e) };
    }
  }

  let renderDiag = null;
  if (typeof wle?.getRenderTargetDiagnostics === 'function') {
    try {
      const view = canvas?.app?.view;
      const rect = view?.getBoundingClientRect?.();
      const suv = rect
        ? screenUvFromClient(rect.left + rect.width * 0.5, rect.top + rect.height * 0.5)
        : null;
      renderDiag = wle.getRenderTargetDiagnostics(renderer, le, { screenUv: suv });
    } catch (e) {
      renderDiag = { error: String(e?.message || e) };
    }
  }

  const gain = Number(le?.params?.windowEmissiveGain) || 1;
  const centerWinLuma = screenSamples.centerEmitSceneUv?.luma ?? 0;
  const estMulCenter = estComposeMultiplier(centerWinLuma, gain);

  if (!effOn(wle)) flags.push('window_light_effect_disabled');
  if (!effOn(le)) flags.push('lighting_effect_disabled');
  if (emitScan.readErrors > 0 || composeScan.readErrors > 0) {
    flags.push('rt_readback_errors — re-run after reload; half-float needs Uint16Array (fixed in latest probe file)');
  }
  if ((emitScan.sampleCount === 0 && emitRt) || (composeScan.sampleCount === 0 && composeRt)) {
    flags.push('rt_readback_all_failed — run probe immediately after a rendered frame (not between frames)');
  }
  if (wle?._emitComposeValid === false && wle?._lastDrawStats?.drew === true) {
    flags.push('emit_compose_valid_false_between_frames — normal if probe runs after beginFrame(); see wleLastDraw.drew');
  }
  if (composeUsesScreenSpace) {
    flags.push('compose_uses_screen_space_blit — expected sceneUv emit only; reload module if true');
  }
  if (wle?._lastDrawStats?.drew === true && !effOn(wle)) {
    flags.push('stale_emit_last_draw_while_disabled — compose no longer binds stale emit; reload and re-probe');
  }
  if (!blitOk && composeUsesScreenSpace) {
    flags.push('compose_blit_not_valid — screen-space window path stale');
  }
  if (composeScan.highLumaFrac_gt0_12 > 0.55) {
    flags.push('compose_rt_widespread_bright — >55% grid samples luma>0.12 (full-frame window wash likely)');
  }
  if (emitScan.highLumaFrac_gt0_12 > 0.55) {
    flags.push('emit_rt_widespread_bright — scene-UV atlas is hot across most texels');
  }
  if (composeScan.maxLuma > 0.5 && emitScan.maxLuma < 0.08) {
    flags.push('compose_hot_emit_cold — blit/reproject may be amplifying or wrong texture bound');
  }
  if (cu?.tLightWindow?.value && emitRt?.texture && composeRt?.texture
    && cu.tLightWindow.value === emitRt.texture && blitOk) {
    flags.push('texture_mismatch — blitOk but tLightWindow still emit (should be compose RT)');
  }
  if (estMulCenter > 2.2) {
    flags.push('estimated_compose_multiplier_gt_2.2_at_center — litColor *= (1+win) may blow highlights');
  }
  if (gain > 1.5) flags.push('high_windowEmissiveGain — try 0.35–1.0 for A/B');
  if (shaderCompile.hasLegacyDirectBaseline) {
    flags.push('CRITICAL: compose shader still has 1.0+lampEnergyA — hard reload module (Ctrl+F5)');
  }
  if (!shaderCompile.hasMagOnlyMarker && !shaderCompile.hasLegacyDirectBaseline) {
    flags.push('compose_shader_marker_missing — reload map-shine-advanced');
  }
  if ((lightingCompose.lightRtCenter?.a ?? 0) > 0.12) {
    flags.push('light_rt_alpha_elevated_at_screen_center — lamp pool or legacy direct baseline');
  }
  if (effOn(wle) && (lightingCompose.lightRtScan?.maxLuma ?? 0) < 0.02
    && (lightingCompose.lightRtScan?.sampleCount ?? 0) > 0) {
    flags.push('light_rt_empty_while_window_on — fixed: emit prepare must not clear _lightRT (reload module)');
  }
  if ((lightingCompose.lightRtScan?.maxLuma ?? 0) > 0.2
    && (lightingCompose.lightRtScan?.highLumaFrac_gt0_12 ?? 0) > 0.35) {
    flags.push('light_rt_widespread_energy — CC local override may boost whole frame');
  }
  const ambDay = Number(lightingCompose.params?.ambientDayScale) || 0;
  const ambNight = Number(lightingCompose.params?.ambientNightScale) || 0;
  const ambDayOut = Number(lightingCompose.params?.ambientDayScaleOutdoor) || 0;
  const ambDayIn = Number(lightingCompose.params?.ambientDayScaleIndoor) || 0;
  const ambDayU = Number(lightingCompose.uniforms?.uAmbientDayScale) || 0;
  const ambDayOutU = Number(lightingCompose.uniforms?.uAmbientDayScaleOutdoor) || 0;
  const ambDayInU = Number(lightingCompose.uniforms?.uAmbientDayScaleIndoor) || 0;
  const calDay = Number(lightingCompose.uniforms?.uCalendarDayWeight) || 0;
  const savedAmbientZero = ambDay < 0.02 && ambNight < 0.02
    && ambDayOut < 0.02 && ambDayIn < 0.02;
  const uniformAmbientZero = ambDayOutU < 0.02 && ambDayInU < 0.02 && ambDayU < 0.02;
  if (savedAmbientZero && uniformAmbientZero && calDay > 0.4) {
    flags.push(
      'noon_ambient_zero — saved scales are 0 and compose uniforms did not apply defaults; hard-reload module',
    );
  } else if (savedAmbientZero && calDay > 0.4 && ambDayOutU > 0.5) {
    flags.push(
      'noon_ambient_saved_zero_compose_ok — scene flags still 0 but uniform fallback is active (re-apply preset to persist)',
    );
  }
  if (Number(lightingCompose.colorCorrection?.uLocalLightAlphaBaseline) > 0.01
    && Number(lightingCompose.colorCorrection?.uHasLocalLightBuffer) > 0.5) {
    flags.push('cc_light_alpha_baseline_not_zero — should be 0 for additive _lightRT');
  }
  const winInt = Number(wle?.params?.intensity) || 0;
  if (composeUniforms?.uHasLightWindow > 0.5 && winInt <= 1e-5) {
    flags.push('compose_window_bound_at_zero_intensity — reload map-shine-advanced');
  }

  const scenePt = centerWorld
    ? sceneUvFromWorld(centerWorld.x, centerWorld.y)
    : null;
  if (scenePt && emitRt) {
    emitScreenSamples.atCanvasCenterComposeUv = sampleRt(renderer, emitRt, scenePt.u, scenePt.vEmitAtlas ?? scenePt.v);
    emitScreenSamples.atCanvasCenterLegacyFlipUv = sampleRt(renderer, emitRt, scenePt.u, 1.0 - scenePt.v);
  }
  if (emitScreenSamples.atCanvasCenterComposeUv && emitScreenSamples.atCanvasCenterLegacyFlipUv) {
    const cL = emitScreenSamples.atCanvasCenterComposeUv.luma ?? 0;
    const flipL = emitScreenSamples.atCanvasCenterLegacyFlipUv.luma ?? 0;
    if (flipL > 0.06 && cL < 0.02) {
      flags.push('emit_uv_flip_mismatch — compose still sampling (u, 1-v); reload map-shine-advanced');
    }
  }

  const result = {
    probeVersion: 8,
    composePath: 'sceneUvEmit_additive',
    capturedAt: new Date().toISOString(),
    sceneId: canvas?.scene?.id ?? null,
    sceneName: canvas?.scene?.name ?? null,
    flags,
    warnings,
    canvas: dims ? {
      width: dims.width,
      height: dims.height,
      sceneRect: sr ? { x: sr.x, y: sr.y, width: sr.width, height: sr.height } : null,
    } : null,
    effects: {
      lightingEnabled: effOn(le),
      windowLightEnabled: effOn(wle),
      windowIntensity: winInt,
      wleEmitComposeValid: wle?._emitComposeValid === true,
      wleShadowLiftValid: wle?._shadowLiftValid === true,
    },
    pipeline: live?.windowLightCompose ?? {
      blitOk,
      emit: rtDim(emitRt),
      compose: rtDim(composeRt),
      textureSource: live?.windowLightTextureSource ?? (blitOk ? 'composeRt' : 'emit'),
    },
    params: {
      windowEmissiveGain: le?.params?.windowEmissiveGain,
      windowIntensity: wle?.params?.intensity,
      internalWindowResolutionScale: le?.params?.internalWindowResolutionScale,
      windowLightUseHalfFloat: le?.params?.windowLightUseHalfFloat,
      wleLastDraw: wle?._lastDrawStats ?? wleLive?.lastDraw ?? null,
    },
    composeUniforms,
    lightingCompose,
    rtScan: {
      emit: emitScan,
      composeScreenSpace: composeScan,
    },
    samples: {
      emitAtScreenCenterSceneUv: screenSamples,
      emitSceneUv: emitScreenSamples,
      estimatedComposeAddAtCenter: centerWinLuma * gain * 0.35,
    },
    centerWorld,
    centerSceneUv: scenePt,
    worldProbe,
    renderDiagnostics: renderDiag,
    perfLive: live ? {
      windowLightCompose: live.windowLightCompose,
      windowLightTextureSource: live.windowLightTextureSource,
    } : null,
    readbackNote: 'Half-float window RTs use Uint16Array + THREE.DataUtils.fromHalfFloat (not Float32Array).',
    abHints: [
      'Check lightingCompose.shaderCompile — hasLegacyDirectBaseline must be false after reload.',
      'Global wash with sparse emit: suspect baseIllum 1.0+ or CC rgbMag on _lightRT (both fixed in latest code).',
      'Toggle Window Light off — uHasLightWindow should become 0 on next frame; emit must not bind when disabled.',
      'If lightRtCenter.a ~0 but scene still white: Color Correction exposure or pre-light bus albedo.',
      'If flags show high_ambient_scales: scene flag overrides preset; zero ambientDay/Night in UI.',
    ],
  };

  return publish(result);
})();
