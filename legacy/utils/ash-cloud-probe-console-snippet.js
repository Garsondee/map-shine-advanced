/**
 * DevTools-only: paste the entire IIFE into the Foundry browser console (scene loaded, V2 active).
 * `node --check scripts/utils/ash-cloud-probe-console-snippet.js` validates syntax.
 *
 * After run: `MapShine.__ashCloudProbeLast` and `MapShine.__ashCloudProbeJson`
 * (Chrome: `copy(MapShine.__ashCloudProbeJson)`)
 */
(function mapShineAshCloudProbe() {
  const ms = window.MapShine;
  const fc = ms && ms.floorCompositorV2;
  const ace = fc && fc._ashCloudEffect;
  const wc = ms && ms.weatherController;
  const warnings = [];
  const notes = [];

  function warn(msg) { warnings.push(String(msg)); }
  function note(msg) { notes.push(String(msg)); }

  function texBrief(t) {
    if (!t) return null;
    const img = t.image;
    const w = img?.width ?? t.source?.data?.width ?? null;
    const h = img?.height ?? t.source?.data?.height ?? null;
    return { uuid: t.uuid || null, w, h, flipY: t.flipY === true };
  }

  function rgbBrief(c) {
    if (!c || typeof c !== 'object') return null;
    return {
      r: Number(c.r),
      g: Number(c.g),
      b: Number(c.b),
    };
  }

  function isEffectEnabled(instance) {
    if (!instance) return false;
    if (instance.enabled === false) return false;
    if (instance.params && instance.params.enabled === false) return false;
    return true;
  }

  // ── Weather / ash channel ───────────────────────────────────────────────
  let weatherState = null;
  try {
    weatherState = typeof ace?._getAshWeatherState === 'function'
      ? ace._getAshWeatherState()
      : null;
  } catch (e) {
    warn('ace._getAshWeatherState() threw: ' + e.message);
  }

  const wcCurrentAsh = Number(wc?.currentState?.ashIntensity);
  const wcTargetAsh = Number(wc?.targetState?.ashIntensity);
  const wcGetCurrentAsh = Number(wc?.getCurrentState?.()?.ashIntensity);
  const v2Ash = Number(ms?.__v2AshIntensity);

  let envelope = null;
  try {
    envelope = wc?.getAshEmissionEnvelope?.();
  } catch (e) {
    warn('getAshEmissionEnvelope threw: ' + e.message);
  }

  // ── Scene bounds ────────────────────────────────────────────────────────
  let sceneBoundsValid = ace?._sceneBoundsValid ?? null;
  let sceneGeometry = null;
  try {
    if (typeof ace?._updateSceneBounds === 'function') {
      ace._updateSceneBounds();
      sceneBoundsValid = ace._sceneBoundsValid;
      sceneGeometry = ace._sceneGeometry ? { ...ace._sceneGeometry } : null;
    }
  } catch (e) {
    warn('_updateSceneBounds threw: ' + e.message);
  }

  const dims = canvas?.dimensions;
  const rect = dims?.sceneRect ?? dims;

  // ── Sprites ─────────────────────────────────────────────────────────────
  const sprites = Array.isArray(ace?._ashSprites) ? ace._ashSprites : [];
  let visibleCount = 0;
  let texturedCount = 0;
  let inMapCoreCount = 0;
  let inViewCount = 0;
  let offMapVisibleCount = 0;
  const viewSpawn = ace?._viewSpawnState ?? null;
  try {
    if (typeof ace?._updateViewAshSpawnCache === 'function') {
      ace._updateViewAshSpawnCache(performance.now());
    }
  } catch (_) {}
  const viewUv = ace?._viewSpawnState?.viewUv ?? viewSpawn?.viewUv ?? null;
  let fadingIn = 0;
  let fadingOut = 0;
  let steadyCount = 0;
  let zeroFadeCount = 0;
  const spriteSamples = [];

  for (let i = 0; i < sprites.length; i += 1) {
    const s = sprites[i];
    if (!s?.mesh) continue;
    if (s.mesh.visible) visibleCount += 1;
    const tex = s.getTexture?.() ?? s.material?.uniforms?.map?.value ?? null;
    if (tex) texturedCount += 1;

    const nu = Number(s.normU);
    const nv = Number(s.normV);
    const inCore = s.mesh.visible
      && (s.fadeMul ?? 0) > 0.05
      && s._fadePhase !== 'out'
      && nu >= 0.08 && nu <= 0.92
      && nv >= 0.08 && nv <= 0.92;
    if (inCore) inMapCoreCount += 1;
    if (viewUv && s.mesh.visible && (s.fadeMul ?? 0) > 0.05 && s._fadePhase !== 'out') {
      const pad = 0.02;
      if (nu >= viewUv.uMin - pad && nu <= viewUv.uMax + pad
        && nv >= viewUv.vMin - pad && nv <= viewUv.vMax + pad) {
        inViewCount += 1;
      }
    }
    else if (s.mesh.visible && (nu < 0 || nu > 1 || nv < 0 || nv > 1)) offMapVisibleCount += 1;

    const phase = s._fadePhase || 'steady';
    if (phase === 'in') fadingIn += 1;
    else if (phase === 'out') fadingOut += 1;
    else steadyCount += 1;
    if ((s.fadeMul ?? 1) <= 0.001) zeroFadeCount += 1;

    if (spriteSamples.length < 4 && s.mesh.visible) {
      const u = s.material?.uniforms;
      spriteSamples.push({
        index: i,
        visible: s.mesh.visible,
        normU: Number(s.normU?.toFixed?.(4) ?? s.normU),
        normV: Number(s.normV?.toFixed?.(4) ?? s.normV),
        localPos: {
          x: Number(s.mesh.position.x.toFixed(1)),
          y: Number(s.mesh.position.y.toFixed(1)),
          z: Number(s.mesh.position.z.toFixed(3)),
        },
        fadePhase: phase,
        fadeMul: Number((s.fadeMul ?? 0).toFixed(3)),
        baseOpacity: Number((s.baseOpacity ?? 0).toFixed(3)),
        scale: Number((s.root?.scale?.x ?? s.mesh?.scale?.x ?? 0).toFixed(0)),
        hasTexture: !!tex,
        texture: texBrief(tex),
        uniforms: u ? {
          opacity: u.opacity?.value,
          opacityCap: u.uOpacityCap?.value,
          ashColor: u.uAshColor?.value
            ? { r: u.uAshColor.value.x, g: u.uAshColor.value.y, b: u.uAshColor.value.z }
            : null,
          hasOutdoorsMask: u.uHasOutdoorsMask?.value,
          revealThreshold: u.uRevealThreshold?.value,
          revealNoiseScale: u.uRevealNoiseScale?.value,
        } : null,
      });
    }
  }

  // ── Anchor / scene graph ────────────────────────────────────────────────
  const anchor = ace?._ashAnchor ?? null;
  const busScene = fc?._renderBus?._scene ?? null;
  const anchorParentName = anchor?.parent?.name ?? anchor?.parent?.type ?? null;
  const anchorInBus = !!(anchor && busScene && anchor.parent === busScene);

  // ── Outdoors masks ──────────────────────────────────────────────────────
  const outdoors = {
    legacy: texBrief(ace?._outdoorsMask),
    perFloor: (ace?._outdoorsMasks || []).map((t) => texBrief(t)),
    floorId: texBrief(ace?._floorIdTex),
  };

  // ── Graphics settings breaker ───────────────────────────────────────────
  let graphicsOverride = null;
  try {
    const gsm = ms?.graphicsSettingsManager ?? ms?.effectComposer?.graphicsSettingsManager ?? null;
    const ov = gsm?.state?.effectOverrides?.['ash-clouds'] ?? gsm?.state?.effectOverrides?.ashClouds ?? null;
    graphicsOverride = ov ?? null;
  } catch (_) {}

  // ── Heuristic warnings ──────────────────────────────────────────────────
  if (!fc) warn('floorCompositorV2 missing — V2 pipeline not active');
  if (!ace) warn('_ashCloudEffect missing on FloorCompositor');
  if (ace && !ace._initialized) warn('AshCloudEffectV2 not initialized');
  if (ace && !ace._assetsLoaded) warn('Ash cloud PNG assets not loaded yet (_assetsLoaded=false)');
  if (ace && (ace._sparseTextures?.length ?? 0) + (ace._fullTextures?.length ?? 0) === 0) {
    warn('Zero cloud textures in sparse/full arrays');
  }
  if (!isEffectEnabled(ace)) warn('AshCloudEffectV2 disabled (instance.enabled or params.enabled)');
  if (weatherState && weatherState.strength < 0.02) {
    warn('Computed ash strength ~0 (strength=' + weatherState.strength + ') — no spawn expected');
  }
  if (Math.max(wcCurrentAsh, wcTargetAsh, v2Ash, 0) > 0.05 && weatherState?.strength < 0.02) {
    warn('UI/state has ashIntensity>0 but effect strength reads ~0 — channel read mismatch');
  }
  if (wc?.enabled === false && wc?.dynamicEnabled !== true) {
    note('Global weatherController.enabled=false (ash clouds should still work via direct state read)');
  }
  if (wcGetCurrentAsh === 0 && Math.max(wcCurrentAsh, wcTargetAsh) > 0.05) {
    note('getCurrentState().ashIntensity=0 but currentState/targetState have ash — global weather likely off');
  }
  if (sceneBoundsValid === false) warn('Scene bounds invalid — sprites cannot be positioned');
  if (ace && visibleCount === 0 && weatherState?.strength > 0.02) {
    warn('Strength>0 but zero visible sprites in pool');
  }
  if (ace && visibleCount > 0 && inViewCount === 0 && weatherState?.strength > 0.02) {
    warn('Visible sprites exist but none are in the current camera view — check view/_Ash spawn cache');
  }
  if (ace && ((ace._viewSpawnState?.pointCount ?? viewSpawn?.pointCount ?? 0) === 0) && weatherState?.strength > 0.02) {
    note('No bright _Ash spawn points in current camera view (compositor readback may be empty or threshold too high)');
  }
  if (ace && visibleCount > 0 && inMapCoreCount === 0 && weatherState?.strength > 0.02) {
    warn('Visible sprites exist but none are in-map (normU/V 0.08..0.92) — outdoors shader discards off-atlas puffs');
  }
  if (offMapVisibleCount > 0 && inMapCoreCount === 0) {
    note(offMapVisibleCount + ' visible sprite(s) simulating off-map (normU/V outside 0..1)');
  }
  if (visibleCount > 0 && texturedCount === 0) warn('Visible sprites but none have textures assigned');
  if (visibleCount > 0 && zeroFadeCount === visibleCount) {
    warn('All visible sprites have fadeMul~0 (fully faded out)');
  }
  const ashColor = ace?.params?.ashColor;
  if (ashColor && ashColor.r === 0 && ashColor.g === 0 && ashColor.b === 0) {
    warn('params.ashColor is pure black {0,0,0} — puffs will be invisible');
  }
  if (!anchorInBus) {
    warn('AshCloudAnchor not parented to FloorRenderBus._scene (parent=' + (anchorParentName ?? 'null') + ') — sprites will not render');
  }
  if (!outdoors.legacy && !outdoors.perFloor.some(Boolean)) {
    note('No outdoors mask bound yet — shader treats all pixels as outdoor');
  }

  const windVel = ace?._windVelocity
    ? { x: ace._windVelocity.x, y: ace._windVelocity.y, len: Math.hypot(ace._windVelocity.x, ace._windVelocity.y) }
    : null;

  const result = {
    probeVersion: 1,
    at: new Date().toISOString(),
    sceneId: canvas?.scene?.id ?? null,
    sceneName: canvas?.scene?.name ?? null,
    floor: {
      activeFloorIndex: fc?._activeFloorIndex ?? null,
      busVisibleMax: fc?._renderBus?._visibleMaxFloorIndex ?? null,
      floorStackActive: ms?.floorStack?.getActiveFloor?.()?.index ?? null,
    },
    spawn: (() => {
      const vs = ace?._viewSpawnState ?? viewSpawn;
      if (!vs) return null;
      return {
        ashPointsInView: vs.pointCount ?? 0,
        viewUv: vs.viewUv ? {
          uMin: Number(vs.viewUv.uMin?.toFixed?.(4) ?? vs.viewUv.uMin),
          uMax: Number(vs.viewUv.uMax?.toFixed?.(4) ?? vs.viewUv.uMax),
          vMin: Number(vs.viewUv.vMin?.toFixed?.(4) ?? vs.viewUv.vMin),
          vMax: Number(vs.viewUv.vMax?.toFixed?.(4) ?? vs.viewUv.vMax),
        } : null,
        floorKey: vs.floorKey ?? null,
        cacheKey: vs.cacheKey ?? null,
      };
    })(),
    effect: {
      present: !!ace,
      initialized: ace?._initialized ?? false,
      assetsLoaded: ace?._assetsLoaded ?? false,
      enabled: ace?.enabled,
      paramsEnabled: ace?.params?.enabled,
      effectEnabledGate: isEffectEnabled(ace),
      poolSize: sprites.length,
      lastActiveTotal: ace?._lastActiveTotal ?? null,
      needsSpriteRespread: ace?._needsSpriteRespread ?? null,
      sparseTextureCount: ace?._sparseTextures?.length ?? 0,
      fullTextureCount: ace?._fullTextures?.length ?? 0,
      params: ace?.params ? {
        spritePoolSize: ace.params.spritePoolSize,
        spriteScaleMin: ace.params.spriteScaleMin,
        spriteScaleMax: ace.params.spriteScaleMax,
        opacityCap: ace.params.opacityCap,
        ashColor: rgbBrief(ace.params.ashColor),
        fadeInDuration: ace.params.fadeInDuration,
        fadeOutDuration: ace.params.fadeOutDuration,
        revealThreshold: ace.params.revealThreshold,
        revealNoiseScale: ace.params.revealNoiseScale,
      } : null,
    },
    weather: {
      controllerPresent: !!wc,
      initialized: wc?.initialized ?? false,
      enabled: wc?.enabled,
      dynamicEnabled: wc?.dynamicEnabled ?? false,
      currentStateAsh: Number.isFinite(wcCurrentAsh) ? wcCurrentAsh : null,
      targetStateAsh: Number.isFinite(wcTargetAsh) ? wcTargetAsh : null,
      getCurrentStateAsh: Number.isFinite(wcGetCurrentAsh) ? wcGetCurrentAsh : null,
      v2AshIntensity: Number.isFinite(v2Ash) ? v2Ash : null,
      envelope: Number.isFinite(Number(envelope)) ? Number(envelope) : envelope,
      computed: weatherState,
      windTarget: wc?.targetState ? {
        windSpeed: wc.targetState.windSpeed,
        windSpeedMS: wc.targetState.windSpeedMS,
        windDirection: wc.targetState.windDirection,
      } : null,
    },
    windSim: {
      velocity: windVel,
    },
    scene: {
      boundsValid: sceneBoundsValid,
      geometry: sceneGeometry,
      canvasDimensions: rect ? {
        sceneX: rect.x, sceneY: rect.y,
        sceneW: rect.width, sceneH: rect.height,
        worldH: dims?.height,
      } : null,
    },
    anchor: anchor ? {
      inBusScene: anchorInBus,
      parent: anchorParentName,
      position: {
        x: Number(anchor.position.x.toFixed(1)),
        y: Number(anchor.position.y.toFixed(1)),
        z: Number(anchor.position.z.toFixed(3)),
      },
      renderOrder: anchor.renderOrder,
      childCount: anchor.children?.length ?? 0,
    } : null,
    sprites: {
      total: sprites.length,
      visible: visibleCount,
      inView: inViewCount,
      inMapCore: inMapCoreCount,
      offMapVisible: offMapVisibleCount,
      withTexture: texturedCount,
      fadingIn,
      fadingOut,
      steady: steadyCount,
      zeroFade: zeroFadeCount,
      samples: spriteSamples,
    },
    outdoors,
    graphicsOverride,
    warnings,
    notes,
  };

  if (ms) {
    ms.__ashCloudProbeLast = result;
    ms.__ashCloudProbeJson = JSON.stringify(result, null, 2);
  }

  if (warnings.length) {
    console.warn('[Ash Cloud Probe] warnings (' + warnings.length + '):');
    for (let i = 0; i < warnings.length; i += 1) console.warn('  ' + (i + 1) + '. ' + warnings[i]);
  }
  if (notes.length) {
    console.info('[Ash Cloud Probe] notes (' + notes.length + '):');
    for (let i = 0; i < notes.length; i += 1) console.info('  ' + (i + 1) + '. ' + notes[i]);
  }

  console.log('--- Map Shine ASH CLOUD PROBE (copy JSON below) ---');
  console.log('Tip (Chrome DevTools): copy(MapShine.__ashCloudProbeJson)');
  console.log(JSON.stringify(result, null, 2));
  return result;
})();
