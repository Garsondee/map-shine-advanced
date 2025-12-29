import { createLogger } from '../core/log.js';

const log = createLogger('SurfaceRegistry');

export class SurfaceRegistry {
  constructor() {
    this._initialized = false;
    this._hooks = [];

    this.sceneComposer = null;
    this.tileManager = null;

    this.report = null;
  }

  initialize({ sceneComposer = null, tileManager = null } = {}) {
    if (this._initialized) return;
    this.sceneComposer = sceneComposer;
    this.tileManager = tileManager;

    if (typeof Hooks === 'undefined') {
      this._initialized = true;
      return;
    }

    const onCanvasReady = () => this.refresh();
    const onCreateTile = () => this.refresh();
    const onUpdateTile = (tileDoc, changes) => {
      if (!tileDoc || !changes || typeof changes !== 'object') {
        this.refresh();
        return;
      }

      const relevant = [
        'x',
        'y',
        'width',
        'height',
        'rotation',
        'elevation',
        'z',
        'hidden',
        'alpha',
        'texture',
        'flags'
      ];

      const keys = Object.keys(changes);
      if (keys.some((k) => relevant.includes(k))) {
        this.refresh();
      }
    };
    const onDeleteTile = () => this.refresh();
    const onUpdateScene = (scene, changes) => {
      if (scene?.id !== canvas?.scene?.id) return;
      if (!changes || typeof changes !== 'object') {
        this.refresh();
        return;
      }
      if ('foregroundElevation' in changes || 'background' in changes || 'backgroundColor' in changes) {
        this.refresh();
      }
    };

    Hooks.on('canvasReady', onCanvasReady);
    Hooks.on('createTile', onCreateTile);
    Hooks.on('updateTile', onUpdateTile);
    Hooks.on('deleteTile', onDeleteTile);
    Hooks.on('updateScene', onUpdateScene);

    this._hooks.push(['canvasReady', onCanvasReady]);
    this._hooks.push(['createTile', onCreateTile]);
    this._hooks.push(['updateTile', onUpdateTile]);
    this._hooks.push(['deleteTile', onDeleteTile]);
    this._hooks.push(['updateScene', onUpdateScene]);

    this._initialized = true;
  }

  dispose() {
    if (typeof Hooks !== 'undefined') {
      for (const entry of this._hooks) {
        try {
          const hook = entry?.[0];
          const fn = entry?.[1];
          if (!hook || typeof fn !== 'function') continue;
          Hooks.off(hook, fn);
        } catch (_) {
        }
      }
    }
    this._hooks.length = 0;
    this._initialized = false;

    this.sceneComposer = null;
    this.tileManager = null;
    this.report = null;
  }

  refresh() {
    try {
      this.report = this._buildReport();
      const ms = window.MapShine;
      if (ms) {
        ms.surfaceReport = this.report;
      }
      return this.report;
    } catch (e) {
      log.warn('Failed to refresh surface report', e);
      return null;
    }
  }

  _buildReport() {
    const scene = canvas?.scene;
    const d = canvas?.dimensions;

    const sceneId = scene?.id ?? null;
    const sceneName = scene?.name ?? null;

    const sceneRect = d?.sceneRect
      ? { x: d.sceneRect.x, y: d.sceneRect.y, w: d.sceneRect.width, h: d.sceneRect.height }
      : null;

    const surfaces = [];

    surfaces.push(this._buildBackgroundSurface(scene));

    const tiles = scene?.tiles ? Array.from(scene.tiles) : [];
    for (const tileDoc of tiles) {
      surfaces.push(this._buildTileSurface(tileDoc));
    }

    const stacks = this._buildStacks(surfaces);

    return {
      version: 1,
      time: Date.now(),
      scene: {
        id: sceneId,
        name: sceneName,
        sceneRect,
        foregroundElevation: Number.isFinite(scene?.foregroundElevation) ? scene.foregroundElevation : null
      },
      surfaces,
      stacks
    };
  }

  _buildBackgroundSurface(scene) {
    const src = (scene?.background?.src && String(scene.background.src).trim()) ? String(scene.background.src).trim() : '';
    const basePath = src ? this._extractBasePath(src) : '';

    return {
      surfaceId: 'scene:background',
      source: 'background',
      rectFoundry: null,
      rotationDeg: 0,
      elevation: Number.NEGATIVE_INFINITY,
      kind: 'ground',
      roof: 'none',
      sortKey: Number.NEGATIVE_INFINITY,
      stackId: 'ground',
      basePath,
      src,
      flags: {},
      three: {
        hasObject: !!(this.sceneComposer?.getBasePlane?.())
      }
    };
  }

  _buildTileSurface(tileDoc) {
    const moduleId = 'map-shine-advanced';

    const src = tileDoc?.texture?.src ? String(tileDoc.texture.src).trim() : '';
    const basePath = src ? this._extractBasePath(src) : '';

    const elev = Number.isFinite(tileDoc?.elevation) ? tileDoc.elevation : 0;
    const fgElev = Number.isFinite(canvas?.scene?.foregroundElevation)
      ? canvas.scene.foregroundElevation
      : Number.POSITIVE_INFINITY;
    const isOverhead = Number.isFinite(fgElev) ? (elev >= fgElev) : false;

    const roofFlag = tileDoc?.getFlag?.(moduleId, 'overheadIsRoof') ?? tileDoc?.flags?.[moduleId]?.overheadIsRoof;
    const isWeatherRoof = isOverhead && !!roofFlag;

    const kind = isWeatherRoof ? 'roof' : (isOverhead ? 'overhead' : 'ground');
    const roof = isWeatherRoof ? 'weatherRoof' : (isOverhead ? 'roof' : 'none');
    const stackId = kind;

    const bypassFlag = tileDoc?.getFlag?.(moduleId, 'bypassEffects') ?? tileDoc?.flags?.[moduleId]?.bypassEffects;
    const cloudShadowsFlag = tileDoc?.getFlag?.(moduleId, 'cloudShadowsEnabled') ?? tileDoc?.flags?.[moduleId]?.cloudShadowsEnabled;
    const cloudTopsFlag = tileDoc?.getFlag?.(moduleId, 'cloudTopsEnabled') ?? tileDoc?.flags?.[moduleId]?.cloudTopsEnabled;
    const occludesWaterFlag = tileDoc?.getFlag?.(moduleId, 'occludesWater') ?? tileDoc?.flags?.[moduleId]?.occludesWater;

    const cloudShadowsEnabled = (cloudShadowsFlag === undefined) ? true : !!cloudShadowsFlag;
    const cloudTopsEnabled = (cloudTopsFlag === undefined) ? true : !!cloudTopsFlag;

    const rectFoundry = {
      x: Number.isFinite(tileDoc?.x) ? tileDoc.x : 0,
      y: Number.isFinite(tileDoc?.y) ? tileDoc.y : 0,
      w: Number.isFinite(tileDoc?.width) ? tileDoc.width : 0,
      h: Number.isFinite(tileDoc?.height) ? tileDoc.height : 0
    };

    const sortKey = Number.isFinite(tileDoc?.sort) ? tileDoc.sort : (Number.isFinite(tileDoc?.z) ? tileDoc.z : 0);

    const spriteData = this.tileManager?.tileSprites?.get?.(tileDoc?.id);

    return {
      surfaceId: tileDoc?.id ?? null,
      source: 'tile',
      rectFoundry,
      rotationDeg: Number.isFinite(tileDoc?.rotation) ? tileDoc.rotation : 0,
      elevation: elev,
      kind,
      roof,
      sortKey,
      stackId,
      basePath,
      src,
      hidden: !!tileDoc?.hidden,
      flags: {
        bypassPostFX: !!bypassFlag,
        cloudShadowsEnabled,
        cloudTopsEnabled,
        occludesWater: (occludesWaterFlag === undefined) ? null : !!occludesWaterFlag
      },
      three: {
        hasObject: !!spriteData?.sprite,
        isOverhead: !!spriteData?.sprite?.userData?.isOverhead,
        isWeatherRoof: !!spriteData?.sprite?.userData?.isWeatherRoof,
        layersMask: spriteData?.sprite?.layers?.mask ?? null
      }
    };
  }

  _buildStacks(surfaces) {
    const stacksById = new Map();

    for (const s of surfaces) {
      const id = (typeof s?.stackId === 'string' && s.stackId.trim()) ? s.stackId.trim() : 'ground';
      if (!stacksById.has(id)) {
        stacksById.set(id, { stackId: id, surfaces: [] });
      }
      stacksById.get(id).surfaces.push(s);
    }

    for (const st of stacksById.values()) {
      st.surfaces.sort((a, b) => {
        const ak = Number(a?.sortKey) || 0;
        const bk = Number(b?.sortKey) || 0;
        if (ak !== bk) return ak - bk;
        const ae = Number(a?.elevation) || 0;
        const be = Number(b?.elevation) || 0;
        if (ae !== be) return ae - be;
        return String(a?.surfaceId || '').localeCompare(String(b?.surfaceId || ''));
      });
    }

    const order = (id) => {
      if (id === 'ground') return 0;
      if (id === 'overhead') return 100;
      if (id === 'roof') return 200;
      return 500;
    };

    return Array.from(stacksById.values())
      .sort((a, b) => {
        const ao = order(a.stackId);
        const bo = order(b.stackId);
        if (ao !== bo) return ao - bo;
        return String(a.stackId).localeCompare(String(b.stackId));
      })
      .map((st) => {
        const kinds = new Set(st.surfaces.map((s) => s?.kind).filter(Boolean));
        const roofCount = st.surfaces.filter((s) => s?.roof && s.roof !== 'none').length;
        return {
          stackId: st.stackId,
          kind: kinds.size === 1 ? Array.from(kinds)[0] : 'mixed',
          surfaceCount: st.surfaces.length,
          roofCount,
          surfaces: st.surfaces.map((s) => s.surfaceId)
        };
      });
  }

  _extractBasePath(src) {
    const s = String(src || '').split('?')[0].split('#')[0];
    const lastDot = s.lastIndexOf('.');
    if (lastDot > 0) return s.substring(0, lastDot);
    return s;
  }
}
