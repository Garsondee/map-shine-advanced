/**
 * Phase-1 render stack snapshot: metadata-only view of FloorCompositor pipeline order.
 * Does not hook per-frame render; reads compositor state at snapshot time.
 *
 * @module core/diagnostics/RenderStackSnapshotService
 */

const GROUND_Z = 1000;
const Z_PER_FLOOR = 1;
const WINDOW_Z_OFFSET = 0.2;

/**
 * @param {object|null} fc - FloorCompositor instance
 * @param {object} runtime - from HealthEvaluatorService._getRuntimeSnapshot()
 * @returns {{ passes: object[], bindings: object[], windowLightMeta: object|null, busMeta: object, notes: string[], runtime: object }}
 *   windowLightMeta may include overlayList (per-tile inventory), byFloor aggregates, activeFloor, sortObjects.
 */
export function captureRenderStack(fc, runtime = {}) {
  const notes = [];
  if (!fc) {
    return {
      passes: [],
      bindings: [],
      windowLightMeta: null,
      busMeta: null,
      notes: ['No FloorCompositor reference — render stack unavailable'],
    };
  }

  const activeFloor = Number(runtime?.activeFloor ?? 0);
  const visibleFloors = Array.isArray(runtime?.visibleFloors) ? runtime.visibleFloors : [activeFloor];
  const busMax = Number.isFinite(fc._renderBus?._visibleMaxFloorIndex)
    ? fc._renderBus._visibleMaxFloorIndex
    : activeFloor;
  const blurEnabled = !!(fc._floorDepthBlurEffect?.params?.enabled && busMax > 0);

  const cloudOn = !!(fc._cloudEffect?.enabled && fc._cloudEffect?.params?.enabled);
  const winEnabled = !!fc._windowLightEffect?.enabled;
  const winScene = fc._windowLightEffect?._scene ?? null;
  const sortObjects = winScene ? winScene.sortObjects !== false : null;

  const windowLightMeta = _collectWindowLightMeta(fc._windowLightEffect);
  const busMeta = {
    groundZ: GROUND_Z,
    zPerFloor: Z_PER_FLOOR,
    tileZFormula: `Z = ${GROUND_Z} + floorIndex * ${Z_PER_FLOOR}`,
    visibleMaxFloorIndex: busMax,
    floorDepthBlurPath: blurEnabled,
  };

  let stageIndex = 0;
  /** @type {object[]} */
  const passes = [];

  const addPass = (id, label, kind, opts = {}) => {
    const p = {
      stageIndex: stageIndex++,
      id,
      label,
      kind,
      enabled: opts.enabled !== undefined ? opts.enabled : true,
      outputs: opts.outputs ?? [],
      inputs: opts.inputs ?? [],
      effectIds: opts.effectIds ?? [],
      subpasses: opts.subpasses ?? undefined,
      detail: opts.detail ?? undefined,
    };
    passes.push(p);
    return p;
  };

  addPass('preBusOverlays', 'Bus overlay prep (specular / iridescence / prism)', 'bus', {
    enabled: true,
    outputs: ['in-place on bus scene'],
    effectIds: ['SpecularEffectV2', 'IridescenceEffectV2', 'PrismEffectV2'],
    detail: 'Renders into FloorRenderBus scene before main albedo capture.',
  });

  addPass('overheadShadows', 'OverheadShadowsEffectV2', 'post', {
    enabled: !!fc._overheadShadowEffect?.params?.enabled,
    outputs: ['roofAlpha / roofRestrictLight / shadowFactor RTs'],
    effectIds: ['OverheadShadowsEffectV2'],
  });

  addPass('buildingShadows', 'BuildingShadowsEffectV2', 'post', {
    enabled: !!fc._buildingShadowEffect?.params?.enabled,
    outputs: ['building shadow factor RT'],
    effectIds: ['BuildingShadowsEffectV2'],
  });

  addPass('paintedShadows', 'PaintedShadowEffectV2', 'post', {
    enabled: !!fc._paintedShadowEffect?.params?.enabled,
    outputs: ['painted shadow factor RT'],
    effectIds: ['PaintedShadowEffectV2'],
  });

  addPass('busAlbedo', blurEnabled ? 'Bus → sceneRT (floor depth blur path)' : 'Bus → sceneRT (direct)', 'bus', {
    enabled: true,
    outputs: ['sceneRT'],
    inputs: ['FloorRenderBus scene'],
    effectIds: ['FloorRenderBus'],
    detail: blurEnabled
      ? 'FloorDepthBlurEffect composites blurred below-floors + sharp active band.'
      : 'Single renderTo(sceneRT); tiles Z = busMeta.tileZFormula.',
  });

  addPass('cloudShadow', 'CloudEffectV2 (shadow + blockers)', 'post', {
    enabled: cloudOn,
    outputs: ['cloudShadowTexture', 'cloudTop (later blit)'],
    effectIds: ['CloudEffectV2'],
  });

  addPass('lighting', 'LightingEffectV2', 'post', {
    enabled: !!(fc._lightingEffect?._initialized && fc._lightingEffect?._enabled !== false),
    outputs: ['postA (lit RGB)'],
    inputs: ['sceneRT', 'lightRT', 'darknessRT'],
    effectIds: ['LightingEffectV2'],
    subpasses: [
      {
        id: 'lighting.dynamicLights',
        label: 'Dynamic / token lights → lightRT',
        enabled: true,
      },
      {
        id: 'lighting.windowLight',
        label: 'WindowLightEffectV2 → lightRT (additive)',
        enabled: winEnabled && !!winScene,
        detail:
          'Not “under” bus albedo: window quads add into light accumulation; compose does albedo × illumination.',
        effectIds: ['WindowLightEffectV2'],
      },
      {
        id: 'lighting.compose',
        label: 'Compose albedo × (light − darkness) + shadows',
        enabled: true,
        detail: 'Final lit color for this stage; window contribution is already inside illumination.',
      },
    ],
  });

  addPass('skyColor', 'SkyColorEffectV2', 'post', {
    enabled: !!fc._skyColorEffect?.params?.enabled,
    outputs: ['ping-pong post RT'],
    effectIds: ['SkyColorEffectV2'],
  });

  addPass('colorCorrection', 'ColorCorrectionEffectV2', 'post', {
    enabled: !!fc._colorCorrectionEffect?.params?.enabled,
    outputs: ['ping-pong post RT'],
    effectIds: ['ColorCorrectionEffectV2'],
  });

  addPass('filter', 'FilterEffectV2', 'post', {
    enabled: !!(fc._filterEffect?.enabled && fc._filterEffect?.params?.enabled),
    outputs: ['ping-pong post RT'],
    effectIds: ['FilterEffectV2'],
  });

  addPass('water', 'WaterEffectV2', 'post', {
    enabled: !!fc._waterEffect?.enabled,
    outputs: ['ping-pong post RT'],
    effectIds: ['WaterEffectV2'],
    detail: 'Runs after grading; can change perceived window-adjacent brightness.',
  });

  addPass('distortion', 'DistortionManager', 'post', {
    enabled: !!(fc._distortionEffect?.enabled && fc._distortionEffect?.params?.enabled),
    outputs: ['ping-pong post RT'],
    effectIds: ['DistortionManager'],
  });

  addPass('atmosphericFog', 'AtmosphericFogEffectV2', 'post', {
    enabled: !!(fc._atmosphericFogEffect?.enabled && fc._atmosphericFogEffect?.params?.enabled),
    outputs: ['ping-pong post RT'],
    effectIds: ['AtmosphericFogEffectV2'],
  });

  addPass('bloom', 'BloomEffectV2', 'post', {
    enabled: !!fc._bloomEffect?.params?.enabled,
    outputs: ['ping-pong post RT'],
    effectIds: ['BloomEffectV2'],
  });

  addPass('sharpen', 'SharpenEffectV2', 'post', {
    enabled: !!fc._sharpenEffect?.params?.enabled,
    outputs: ['ping-pong post RT'],
    effectIds: ['SharpenEffectV2'],
  });

  const stylistic = [];
  if (fc._dotScreenEffect?.enabled) stylistic.push('DotScreen');
  if (fc._halftoneEffect?.enabled) stylistic.push('Halftone');
  if (fc._asciiEffect?.enabled) stylistic.push('Ascii');
  if (fc._dazzleOverlayEffect?.enabled) stylistic.push('Dazzle');
  if (fc._visionModeEffect?.enabled) stylistic.push('VisionMode');
  if (fc._invertEffect?.enabled) stylistic.push('Invert');
  if (fc._sepiaEffect?.enabled) stylistic.push('Sepia');
  addPass('stylistic', 'Stylistic passes (if any)', 'post', {
    enabled: stylistic.length > 0,
    outputs: ['ping-pong post RT'],
    detail: stylistic.length ? stylistic.join(', ') : 'none enabled',
  });

  addPass('pixiWorld', 'PIXI world channel composite', 'composite', {
    enabled: true,
    outputs: ['post RT chain'],
    detail: 'Drawings / templates into RT before FOW.',
  });

  addPass('fogOfWar', 'FogOfWar composite to RT', 'composite', {
    enabled: true,
    outputs: ['post RT chain'],
    effectIds: ['FogOfWarEffectV2'],
  });

  addPass('lens', 'LensEffectV2', 'post', {
    enabled: !!(fc._lensEffect?.enabled && fc._lensEffect?.params?.enabled),
    outputs: ['ping-pong post RT'],
    effectIds: ['LensEffectV2'],
  });

  addPass('blitToScreen', 'Blit to screen framebuffer', 'output', {
    enabled: true,
    outputs: ['canvas'],
  });

  addPass('lateWorldOverlay', 'Late world overlay (Layer 31)', 'overlay', {
    enabled: true,
    outputs: ['screen'],
    effectIds: ['PlayerLightEffectV2', 'MovementPreviewEffectV2', 'SelectionBoxEffectV2'],
    detail: 'After main post chain blit; separate from window light path.',
  });

  addPass('cloudTopsBlit', 'Cloud tops blit', 'overlay', {
    enabled: cloudOn,
    outputs: ['screen'],
    effectIds: ['CloudEffectV2'],
  });

  addPass('pixiUi', 'PIXI UI overlay', 'overlay', {
    enabled: true,
    outputs: ['screen'],
  });

  /** @type {object[]} */
  const bindings = [
    {
      effectId: 'WindowLightEffectV2',
      passIds: ['lighting'],
      subpassIds: ['lighting.windowLight'],
    },
    { effectId: 'LightingEffectV2', passIds: ['lighting'] },
    { effectId: 'WaterEffectV2', passIds: ['water'] },
    { effectId: 'CloudEffectV2', passIds: ['cloudShadow', 'cloudTopsBlit'] },
    { effectId: 'OverheadShadowsEffectV2', passIds: ['overheadShadows'] },
    { effectId: 'BuildingShadowsEffectV2', passIds: ['buildingShadows'] },
    { effectId: 'PaintedShadowEffectV2', passIds: ['paintedShadows'] },
    { effectId: 'SkyColorEffectV2', passIds: ['skyColor'] },
    { effectId: 'PlayerLightEffectV2', passIds: ['lateWorldOverlay'] },
    { effectId: 'DistortionManager', passIds: ['distortion'] },
    { effectId: 'BloomEffectV2', passIds: ['bloom'] },
  ];

  windowLightMeta.sortObjects = sortObjects;
  windowLightMeta.activeFloor = activeFloor;
  windowLightMeta.zFormula = `windowMeshZ = ${GROUND_Z} + floorIndex + ${WINDOW_Z_OFFSET} (see WindowLightEffectV2)`;
  windowLightMeta.composeNote =
    'Window glow is not drawn below floor albedo in the bus; it adds into lightRT, then Lighting compose multiplies scene albedo by total illumination.';

  return {
    passes,
    bindings,
    windowLightMeta,
    busMeta,
    runtime: { activeFloor, visibleFloors },
    notes,
  };
}

function _collectWindowLightMeta(wle) {
  const meta = {
    overlayCount: 0,
    byFloor: /** @type {Record<string, { count: number, minRenderOrder: number, maxRenderOrder: number, visibleCount: number }>} */ {},
    /** @type {Array<{ tileId: string, floorIndex: number, renderOrder: number, visible: boolean, maskReady: number }>} */
    overlayList: [],
    sortObjects: null,
    activeFloor: null,
  };
  if (!wle) return meta;
  const scene = wle._scene;
  if (scene) meta.sortObjects = scene.sortObjects !== false;

  const overlays = wle._overlays;
  if (!overlays || typeof overlays.forEach !== 'function') return meta;

  overlays.forEach((entry, tileId) => {
    meta.overlayCount++;
    const fi = Math.max(0, Number(entry?.floorIndex) || 0);
    const key = `floor:${fi}`;
    const ro = Number(entry?.mesh?.renderOrder ?? 0);
    const vis = !!entry?.mesh?.visible;
    const maskReady = Number(entry?.material?.uniforms?.uMaskReady?.value ?? 0);
    if (!meta.byFloor[key]) {
      meta.byFloor[key] = { count: 0, minRenderOrder: ro, maxRenderOrder: ro, visibleCount: 0 };
    }
    const b = meta.byFloor[key];
    b.count++;
    b.minRenderOrder = Math.min(b.minRenderOrder, ro);
    b.maxRenderOrder = Math.max(b.maxRenderOrder, ro);
    if (vis) b.visibleCount++;

    meta.overlayList.push({
      tileId: String(tileId ?? ''),
      floorIndex: fi,
      renderOrder: ro,
      visible: vis,
      maskReady,
    });
  });

  meta.overlayList.sort((a, b) => {
    if (a.floorIndex !== b.floorIndex) return a.floorIndex - b.floorIndex;
    if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
    return a.tileId.localeCompare(b.tileId);
  });
  if (meta.overlayList.length > 64) {
    meta.overlayList = meta.overlayList.slice(0, 64);
    meta.overlayListTruncated = true;
  }
  return meta;
}
