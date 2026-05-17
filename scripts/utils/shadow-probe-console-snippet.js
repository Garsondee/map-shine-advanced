/**
 * DevTools-only: paste the entire IIFE into the Foundry browser console (after a frame).
 * `node --check scripts/utils/shadow-probe-console-snippet.js` validates syntax.
 *
 * Prints JSON: effects, uniforms, canvas/camera, UUID wiring, pixel probes, and `warnings[]`.
 * v2: sky-reach health, driver composite, SM inputList, coarse RT min-R scan, remapped sceneUv samples, compose uniforms.
 * After run: `MapShine.__shadowWiringAuditLast` and `MapShine.__shadowWiringAuditJson` (Chrome: `copy(MapShine.__shadowWiringAuditJson)`).
 */
(function mapShineShadowWiringAudit() {
  const ms = window.MapShine;
  const fc = ms && ms.floorCompositorV2;
  const warnings = [];
  const notes = [];

  function publishAudit(result) {
    if (ms) {
      ms.__shadowWiringAuditLast = result;
      ms.__shadowWiringAuditJson = JSON.stringify(result, null, 2);
    }
    const w = result.warnings || [];
    const n = result.notes || [];
    if (w.length) {
      console.warn('[Map Shine shadow audit] warnings (' + w.length + '):');
      for (let i = 0; i < w.length; i += 1) console.warn('  ' + (i + 1) + '. ' + w[i]);
    }
    if (n.length) {
      console.info('[Map Shine shadow audit] notes (' + n.length + '):');
      for (let i = 0; i < n.length; i += 1) console.info('  ' + (i + 1) + '. ' + n[i]);
    }
    console.log('--- Map Shine SHADOW WIRING AUDIT (copy JSON below) ---');
    if (ms) console.log('Tip (Chrome DevTools): copy(MapShine.__shadowWiringAuditJson)');
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
    return { uuid: t.uuid || null, w, h };
  }

  function rtInfo(target) {
    if (!target || !target.texture) return null;
    const t = tex(target.texture);
    if (target.width != null) t.rtW = target.width;
    if (target.height != null) t.rtH = target.height;
    return t;
  }

  function numU(u) {
    if (!u || typeof u.value !== 'number') return null;
    return u.value;
  }

  function vec2U(u) {
    if (!u || !u.value || typeof u.value.x !== 'number') return null;
    return { x: u.value.x, y: u.value.y };
  }

  function vec4U(u) {
    if (!u || !u.value || typeof u.value.x !== 'number') return null;
    return { x: u.value.x, y: u.value.y, z: u.value.z, w: u.value.w };
  }

  function snapUniforms(mat, keys) {
    const u = mat && mat.uniforms;
    if (!u) return null;
    const o = {};
    for (let i = 0; i < keys.length; i += 1) {
      const k = keys[i];
      if (!Object.prototype.hasOwnProperty.call(u, k)) {
        o[k] = undefined;
        continue;
      }
      const v = u[k].value;
      if (v && v.isTexture) o[k] = tex(v);
      else if (typeof v === 'number') o[k] = v;
      else if (v && typeof v.x === 'number' && typeof v.w === 'number') {
        o[k] = { x: v.x, y: v.y, z: v.z, w: v.w };
      } else if (v && typeof v.x === 'number') {
        o[k] = { x: v.x, y: v.y };
      } else o[k] = v == null ? null : 'complex';
    }
    return o;
  }

  function snapEffect(key, inst, extra) {
    return Object.assign({
      key,
      className: inst && inst.constructor ? inst.constructor.name : null,
      resolves: effResolve(inst),
      instanceEnabled: inst ? inst.enabled !== false : null,
      paramEnabled: inst && inst.params ? inst.params.enabled !== false : null,
      hasInitializedFlag: !!(inst && Object.prototype.hasOwnProperty.call(inst, '_initialized')),
      initializedBool: inst && inst._initialized,
    }, extra || {});
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
      return {
        x: xi, y: yi, r01: buf[0] / 255, a: Array.prototype.slice.call(buf),
      };
    } catch (e) {
      return { x: xi, y: yi, error: String(e && e.message) };
    }
  }

  function uuidWire(label, srcTex, dstTex) {
    const s = srcTex && srcTex.uuid;
    const d = dstTex && dstTex.uuid;
    return {
      label,
      sourceUuid: s || null,
      boundUuid: d || null,
      match: !!(s && d && s === d),
      bothNull: !s && !d,
    };
  }

  /** Match ShadowManagerV2 smScreenUvToFoundry + smFoundryToSceneUv (orthographic/perspective via uniforms). */
  function sceneUvFromSmUniforms(sm, relX, relY) {
    const u = sm && sm._material && sm._material.uniforms;
    if (!u || !u.uSceneRect || !u.uSceneRect.value) return null;
    if (numU(u.uHasSceneRect) < 0.5) {
      return { fallbackScreenUv: { x: relX, y: relY }, note: 'uHasSceneRect off — SM uses raw vUv as sceneUv for world textures' };
    }
    const sr = u.uSceneRect.value;
    const sd = u.uSceneDimensions && u.uSceneDimensions.value;
    const vb = u.uViewBounds && u.uViewBounds.value;
    if (!sd || !vb) return { error: 'missing uSceneDimensions or uViewBounds' };
    let useRemap = numU(u.uHasBuildingUvRemap) > 0.5;
    if (!useRemap) {
      const spanX = Math.abs(vb.z - vb.x);
      const spanY = Math.abs(vb.w - vb.y);
      useRemap = sd.x > 2 && sd.y > 2 && spanX > 1e-4 && spanY > 1e-4;
    }
    if (!useRemap) {
      return {
        sceneUv: { x: relX, y: relY },
        heuristicRemap: false,
        note: 'uHasBuildingUvRemap off and span heuristic false',
      };
    }
    const threeX = vb.x + (vb.z - vb.x) * relX;
    const threeY = vb.y + (vb.w - vb.y) * relY;
    const foundryX = threeX;
    const foundryY = sd.y - threeY;
    let sceneU = (foundryX - sr.x) / Math.max(sr.z || 1, 1e-5);
    let sceneV = (foundryY - sr.y) / Math.max(sr.w || 1, 1e-5);
    sceneU = Math.max(0, Math.min(1, sceneU));
    sceneV = Math.max(0, Math.min(1, sceneV));
    return {
      sceneUv: { x: sceneU, y: sceneV },
      heuristicRemap: numU(u.uHasBuildingUvRemap) < 0.5,
    };
  }

  /** Regular grid min R — finds if any “shadow” (R<1) exists in RT. */
  function coarseMinR01(renderer, rtarget, steps) {
    if (!renderer || !rtarget || !steps || steps < 2) return null;
    let minR = 1;
    let minAt = null;
    const n = steps | 0;
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const relX = (i + 0.5) / n;
        const relY = (j + 0.5) / n;
        const s = sampleR(renderer, rtarget, relX, relY);
        if (s && s.r01 != null && s.r01 < minR) {
          minR = s.r01;
          minAt = { relX, relY, x: s.x, y: s.y };
        }
      }
    }
    return { steps: n, minR01: minR, darkestAt: minAt };
  }

  const out = {
    _meta: {
      when: new Date().toISOString(),
      probeVersion: 2,
      hint: 'Paste full JSON. Pan once before run. Check warnings[] first. For sky-reach: pixelScans + skyReachAtRemappedScreen vs skyReach_center_sceneRT.',
    },
    mapShine: { ok: !!ms, hasFloorCompositorV2: !!fc },
    alphaIsolation: ms ? ms.__alphaIsolationDebug : null,
    passProfiler: !!(ms && ms.__v2PassProfiler),
    warnings,
    notes,
  };

  if (!fc) {
    warnings.push('No window.MapShine.floorCompositorV2');
    return publishAudit(out);
  }

  const r = fc.renderer;
  if (!r) warnings.push('floorCompositorV2.renderer is null');

  const cam = fc.camera;
  out.camera = cam ? {
    type: cam.type || cam.constructor && cam.constructor.name,
    isOrthographicCamera: cam.isOrthographicCamera === true,
    isPerspectiveCamera: cam.isPerspectiveCamera === true,
  } : null;
  if (!cam) warnings.push('floorCompositorV2.camera is null');

  const dims = typeof globalThis !== 'undefined' ? globalThis.canvas && globalThis.canvas.dimensions : null;
  out.canvasDimensions = dims ? {
    width: dims.width,
    height: dims.height,
    sceneX: dims.sceneX,
    sceneY: dims.sceneY,
    sceneWidth: dims.sceneWidth,
    sceneHeight: dims.sceneHeight,
    sceneRect: dims.sceneRect || null,
  } : null;
  if (!dims) warnings.push('globalThis.canvas.dimensions missing');

  const cloudFx = fc._cloudEffect;
  const cloudEnabled = effResolve(cloudFx);
  const cloudTexLegacy = cloudEnabled && cloudFx ? cloudFx.cloudShadowTexture : null;
  const cloudRawLegacy = cloudEnabled && cloudFx
    ? (cloudFx.cloudShadowRawTexture || cloudFx.cloudShadowTexture)
    : null;

  const sm = fc._shadowManagerEffect;
  const ov = fc._overheadShadowEffect;
  const bd = fc._buildingShadowEffect;
  const sr = fc._skyReachShadowEffect;
  const pt = fc._paintedShadowEffect;
  const le = fc._lightingEffect;
  const drv = ms ? ms.__shadowDriverState : null;

  const smMat = sm && sm._material;
  const smU = smMat && smMat.uniforms;

  out.shadowManager = snapEffect('ShadowManagerV2', sm, {
    shadowManagerEnabledRaw: sm ? sm.enabled : null,
    params: sm && sm.params ? Object.assign({}, sm.params) : {},
    hasSetInputList: !!(sm && typeof sm.setInputList === 'function'),
    inputListLength: sm && sm._inputList ? sm._inputList.length : null,
    inputListSummary: sm && Array.isArray(sm._inputList)
      ? sm._inputList.map(function (inp) {
        const id = inp && inp.id != null ? String(inp.id) : '';
        const t = inp && inp.texture;
        return {
          id,
          hasTexture: !!(t && t.isTexture !== false),
          uuid: t && t.uuid ? t.uuid : null,
          opacity: Number.isFinite(Number(inp && inp.opacity)) ? Number(inp.opacity) : null,
          uvSpace: inp && inp.uvSpace ? String(inp.uvSpace) : null,
        };
      })
      : null,
    sceneRectStored: sm && sm._sceneRect ? Object.assign({}, sm._sceneRect) : null,
    uvRemapUniform: smU ? {
      uHasSceneRect: numU(smU.uHasSceneRect),
      uHasBuildingUvRemap: numU(smU.uHasBuildingUvRemap),
      uSceneRect: vec4U(smU.uSceneRect),
      uViewBounds: vec4U(smU.uViewBounds),
      uSceneDimensions: vec2U(smU.uSceneDimensions),
    } : null,
  });

  if (smU) {
    if (numU(smU.uHasSceneRect) > 0.5 && numU(smU.uHasBuildingUvRemap) < 0.5) {
      warnings.push(
        'ShadowManager: uHasSceneRect=1 but uHasBuildingUvRemap=0 — scene-space shadows may sample wrong UVs unless fallback heuristic applies.',
      );
    }
    const vr = vec4U(smU.uViewBounds);
    const sd = vec2U(smU.uSceneDimensions);
    if (vr && Math.abs(vr.z - vr.x) < 1e-6) {
      warnings.push('ShadowManager uViewBounds has zero X span');
    }
    if (sd && (sd.x < 2 || sd.y < 2)) {
      warnings.push('ShadowManager uSceneDimensions looks uninitialized (<2) — screen→scene UV may be wrong');
    }
  }

  if (sm && sm.enabled === false) {
    warnings.push('ShadowManagerV2.enabled === false — combine pass skips; lighting unified shadow can be stale or empty.');
  }

  out.effects = {
    overheadStamp: snapEffect('OverheadStampEffectV2', ov, {
      lastRoofMaskCaptureReused: !!(ov && ov.lastRoofMaskCaptureReused),
      shadowTarget: rtInfo(ov && ov.shadowTarget),
    }),
    building: snapEffect('BuildingShadowsEffectV2', bd, {
      shadowTarget: rtInfo(bd && bd.shadowTarget),
    }),
    skyReach: snapEffect('SkyReachShadowsEffectV2', sr, {
      shadowTarget: rtInfo(sr && sr.shadowTarget),
      paramsSubset: sr && sr.params ? {
        enabled: sr.params.enabled,
        opacity: sr.params.opacity,
        length: sr.params.length,
        upperFloorCombineMode: sr.params.upperFloorCombineMode,
        dynamicLightShadowOverrideEnabled: sr.params.dynamicLightShadowOverrideEnabled,
      } : null,
    }),
    painted: snapEffect('PaintedShadowEffectV2', pt, {
      shadowTarget: rtInfo(pt && pt.shadowTarget),
    }),
    cloud: snapEffect('CloudEffectV2', cloudFx, {
      cloudShadowTarget: rtInfo(cloudFx && cloudFx.cloudShadowTarget),
    }),
    tree: snapEffect('TreeEffectV2', fc._treeEffect, {
      billboardShadowMode: !!(fc._treeEffect && fc._treeEffect._billboardShadowMode),
    }),
    bush: snapEffect('BushEffectV2', fc._bushEffect, {
      billboardShadowMode: !!(fc._bushEffect && fc._bushEffect._billboardShadowMode),
    }),
    lighting: snapEffect('LightingEffectV2', le, {
      params: le && le.params ? {
        cloudShadowAmbientInfluence: le.params.cloudShadowAmbientInfluence,
        overheadShadowAmbientInfluence: le.params.overheadShadowAmbientInfluence,
        interiorDarkness: le.params.interiorDarkness,
        dynamicLightShadowOverrideStrength: le.params.dynamicLightShadowOverrideStrength,
        ambientBuildingShadowMix: le.params.ambientBuildingShadowMix,
      } : null,
      ceiling: rtInfo(le && le.ceilingTransmittanceTarget),
      ceilingGetterOk: !!(le && le.ceilingTransmittanceTextureForLighting),
    }),
  };

  out.shadowDriverState = drv ? {
    frame: drv.frame,
    sun: drv.sun,
    tuning: drv.tuning,
    receiverBaseIndex: drv.masks && drv.masks.receiverBaseIndex,
    hasMaskOutdoors: !!(drv.masks && drv.masks.activeOutdoors),
    hasMaskSkyReach: !!(drv.masks && drv.masks.activeSkyReach),
    upperFloorAlphaCount: drv.masks && drv.masks.upperFloorAlphaTextures
      ? drv.masks.upperFloorAlphaTextures.length
      : 0,
    upperFloorAlphaCompositeTexture: drv.masks && drv.masks.upperFloorAlphaCompositeTexture
      ? tex(drv.masks.upperFloorAlphaCompositeTexture)
      : null,
    floorIdTexture: drv.masks && drv.masks.floorIdTexture ? tex(drv.masks.floorIdTexture) : null,
  } : null;

  out.skyColor = fc._skyColorEffect ? {
    resolves: effResolve(fc._skyColorEffect),
    sunAzimuthDeg: fc._skyColorEffect.currentSunAzimuthDeg,
    sunElevationDeg: fc._skyColorEffect.currentSunElevationDeg,
  } : null;

  out.skyReachHealth = null;
  try {
    if (ms && ms.__skyReachShadowsDiagnostics) {
      out.skyReachHealth = JSON.parse(JSON.stringify(ms.__skyReachShadowsDiagnostics));
    }
  } catch (e) {
    out.skyReachHealth = ms ? ms.__skyReachShadowsDiagnostics : null;
  }

  out.remappedSceneUvProbe = sm ? {
    screenCenter: sceneUvFromSmUniforms(sm, 0.5, 0.5),
    screenTL: sceneUvFromSmUniforms(sm, 0.05, 0.05),
    screenBR: sceneUvFromSmUniforms(sm, 0.95, 0.95),
  } : null;

  const smCombinedRT = sm && sm._combinedRT;
  const ovShadowTex = ov ? ov.shadowFactorTexture : null;
  const bdShadowTex = bd && bd.shadowFactorTexture;
  const srShadowTex = sr && sr.shadowFactorTexture;
  const ptShadowTex = pt && pt.shadowFactorTexture;

  const tOv = smU && smU.tOverheadShadow && smU.tOverheadShadow.value;
  const tBd = smU && smU.tBuildingShadow && smU.tBuildingShadow.value;
  const tSr = smU && smU.tSkyReachShadow && smU.tSkyReachShadow.value;
  const tPt = smU && smU.tPaintedShadow && smU.tPaintedShadow.value;
  const tCl = smU && smU.tCloudShadow && smU.tCloudShadow.value;

  out.uuidWiring = {
    overheadToSm: uuidWire('overhead→SM.tOverheadShadow', ovShadowTex, tOv),
    buildingToSm: uuidWire('building→SM.tBuildingShadow', bdShadowTex, tBd),
    skyReachToSm: uuidWire('skyReach→SM.tSkyReachShadow', srShadowTex, tSr),
    paintedToSm: uuidWire('painted→SM.tPaintedShadow', ptShadowTex, tPt),
    cloudToSm: uuidWire('cloud→SM.tCloudShadow', cloudTexLegacy, tCl),
  };

  Object.keys(out.uuidWiring).forEach(function (k) {
    const w = out.uuidWiring[k];
    if (w && !w.match && !w.bothNull && w.sourceUuid && w.boundUuid) {
      warnings.push('UUID mismatch: ' + k + ' (source ' + w.sourceUuid + ' vs bound ' + w.boundUuid + ')');
    }
  });

  const leU = le && le._composeMaterial && le._composeMaterial.uniforms;
  const uniFac = leU && leU.tUnifiedShadowFactor && leU.tUnifiedShadowFactor.value;
  const smCombTex = smCombinedRT && smCombinedRT.texture;
  if (uniFac && smCombTex && uniFac.uuid !== smCombTex.uuid) {
    warnings.push('Lighting tUnifiedShadowFactor UUID !== ShadowManager _combinedRT.texture');
  }

  out.billboardTexturesOnCompositor = {
    tree: tex(fc._treeBillboardShadowTexture || null),
    bush: tex(fc._bushBillboardShadowTexture || null),
  };

  out.shadowManagerUniforms = snapUniforms(smMat, [
    'uHasCloudShadow', 'uHasCloudShadowRaw', 'uHasOverheadShadow', 'uHasBuildingShadow',
    'uHasPaintedShadow', 'uHasSkyReachShadow', 'uHasTreeBillboardShadow', 'uHasBushBillboardShadow',
    'uCloudWeight', 'uCloudOpacity', 'uOverheadOpacity', 'uBuildingOpacity', 'uPaintedOpacity',
    'uSkyReachOpacity', 'uTreeBillboardOpacity', 'uBushBillboardOpacity',
    'tCloudShadow', 'tOverheadShadow', 'tBuildingShadow', 'tPaintedShadow', 'tSkyReachShadow',
    'tTreeBillboardShadow', 'tBushBillboardShadow',
    'uHasSceneRect', 'uHasBuildingUvRemap', 'uSceneRect', 'uViewBounds', 'uSceneDimensions',
  ]);

  if (smU) {
    const sro = numU(smU.uSkyReachOpacity);
    if (sro != null && sro < 0.02) {
      warnings.push('ShadowManager uSkyReachOpacity≈0 — sky-reach term suppressed in combine multiplication.');
    }
    const hSr = numU(smU.uHasSkyReachShadow);
    if (hSr != null && hSr < 0.5 && sr && sr.shadowFactorTexture) {
      warnings.push('ShadowManager uHasSkyReachShadow=0 but SkyReach shadowFactorTexture is non-null — uniforms not refreshed or combine skipped (SM.enabled?).');
    }
  }

  out.lightingCompose = snapUniforms(le && le._composeMaterial, [
    'tUnifiedShadowFactor', 'tUnifiedShadowRaw', 'uHasCombinedShadow', 'uHasCloudShadow', 'uHasShadowRaw',
    'uCloudShadowAmbientInfluence', 'uOverheadShadowAmbientInfluence',
    'uHasOverheadShadow', 'tOverheadShadow',
    'uHasBuildingShadow', 'tBuildingShadow',
    'uHasPaintedShadowLit', 'tPaintedShadowLit', 'uPaintedShadowMgrOpacity',
    'uHasCeilingLightTransmittance', 'tCeilingLightTransmittance',
    'uHasSkyOcclusion', 'tSkyOcclusion',
    'uDynamicLightShadowOverrideStrength',
    'uLightIntensity', 'uMinIlluminationScale', 'uInteriorDarkness',
    'uNegativeDarknessStrength', 'uDarknessPunchGain',
  ]);

  if (leU && numU(leU.uHasCombinedShadow) > 0.5 && numU(leU.uCloudShadowAmbientInfluence) < 0.01) {
    notes.push('Combined shadow on but cloudShadowAmbientInfluence ~0 — combined may barely dim ambient');
  }

  out.pixelSamples = null;
  if (r && smCombinedRT) {
    out.pixelSamples = {
      combined_center: sampleR(r, smCombinedRT, 0.5, 0.5),
      combined_tl: sampleR(r, smCombinedRT, 0.05, 0.05),
      combined_br: sampleR(r, smCombinedRT, 0.95, 0.95),
    };
    const c = out.pixelSamples.combined_center;
    if (c && c.r01 != null && c.r01 >= 0.995) {
      warnings.push('Combined RT center R≈1 (full lit) — either no shadow content at sample or UV/wiring still wrong');
    }
  } else {
    warnings.push('Skipped pixelSamples (no renderer or sm._combinedRT)');
  }

  if (r && pt && pt.shadowTarget) {
    out.pixelSamples = out.pixelSamples || {};
    out.pixelSamples.painted_center_sceneRT = sampleR(r, pt.shadowTarget, 0.5, 0.5);
  }
  if (r && sr && sr.shadowTarget) {
    out.pixelSamples = out.pixelSamples || {};
    out.pixelSamples.skyReach_center_sceneRT = sampleR(r, sr.shadowTarget, 0.5, 0.5);
  }
  if (r && bd && bd.shadowTarget) {
    out.pixelSamples = out.pixelSamples || {};
    out.pixelSamples.building_center_sceneRT = sampleR(r, bd.shadowTarget, 0.5, 0.5);
  }
  if (r && ov && ov.shadowTarget) {
    out.pixelSamples = out.pixelSamples || {};
    out.pixelSamples.overhead_center_screenRT = sampleR(r, ov.shadowTarget, 0.5, 0.5);
  }

  const cenUv = out.remappedSceneUvProbe && out.remappedSceneUvProbe.screenCenter
    && out.remappedSceneUvProbe.screenCenter.sceneUv;
  if (r && sr && sr.shadowTarget && cenUv && typeof cenUv.x === 'number') {
    out.pixelSamples = out.pixelSamples || {};
    out.pixelSamples.skyReach_at_remappedScreenCenter = sampleR(r, sr.shadowTarget, cenUv.x, cenUv.y);
  }
  if (r && bd && bd.shadowTarget && cenUv && typeof cenUv.x === 'number') {
    out.pixelSamples = out.pixelSamples || {};
    out.pixelSamples.building_at_remappedScreenCenter = sampleR(r, bd.shadowTarget, cenUv.x, cenUv.y);
  }

  const GRID = 5;
  out.pixelScans = {};
  if (r && sr && sr.shadowTarget) {
    out.pixelScans.skyReachShadowTarget = coarseMinR01(r, sr.shadowTarget, GRID);
    if (out.pixelScans.skyReachShadowTarget && effResolve(sr) && out.pixelScans.skyReachShadowTarget.minR01 > 0.97) {
      warnings.push('SkyReach shadowTarget: no texel darker than ~0.97 in ' + GRID + '×' + GRID + ' grid — factor RT all-lit at this resolution or shadow geometry absent in probe region.');
    }
  }
  if (r && smCombinedRT) {
    out.pixelScans.shadowManagerCombined = coarseMinR01(r, smCombinedRT, GRID);
  }
  if (r && bd && bd.shadowTarget) {
    out.pixelScans.buildingShadowTarget = coarseMinR01(r, bd.shadowTarget, GRID);
  }

  const prSr = out.pixelScans.skyReachShadowTarget;
  const prCb = out.pixelScans.shadowManagerCombined;
  if (prSr && prCb && prSr.minR01 < 0.92 && prCb.minR01 > 0.97) {
    warnings.push(
      'SkyReach RT shows dark texels (minR≈' + prSr.minR01.toFixed(3)
      + ') but combined minR≈' + prCb.minR01.toFixed(3)
      + ' — check SM uSkyReachOpacity, multiply chain, or bind order.',
    );
  }

  const pxc = out.pixelSamples && out.pixelSamples.skyReach_center_sceneRT;
  const pxr = out.pixelSamples && out.pixelSamples.skyReach_at_remappedScreenCenter;
  if (pxc && pxr && pxc.r01 != null && pxr.r01 != null && Math.abs(pxc.r01 - pxr.r01) > 0.12) {
    notes.push(
      'skyReach_center_sceneRT (0.5,0.5 in scene RT) ≠ skyReach_at_remappedScreenCenter (viewport center in scene UV) — compare pixelScans + remapped sample for visibility location.',
    );
  }

  return publishAudit(out);
})();
