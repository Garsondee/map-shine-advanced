/**
 * @fileoverview Tile Motion authoring dialog
 * @module ui/tile-motion-dialog
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('TileMotionDialog');

function _toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export class TileMotionDialog {
  constructor() {
    /** @type {Tweakpane.Pane|null} */
    this.pane = null;

    /** @type {HTMLElement|null} */
    this.container = null;

    /** @type {HTMLElement|null} */
    this.headerOverlay = null;

    /** @type {boolean} */
    this.visible = false;

    /** @type {any} */
    this.uiState = {
      tileId: '',
      tileStatus: 'Unknown',
      enabled: false,
      shadowProjectionEnabled: false,
      mode: 'transform',
      motionType: 'rotation',
      loopMode: 'loop',
      parentId: '',
      speed: 0,
      phase: 0,
      radius: 0,
      pointAX: 0,
      pointAY: 0,
      pointBX: 0,
      pointBY: 0,
      amplitudeX: 0,
      amplitudeY: 0,
      amplitudeRot: 0,
      pivotX: 0,
      pivotY: 0,
      snapToGrid: false,
      scrollU: 0,
      scrollV: 0,
      rotateSpeed: 0,
      pivotU: 0.5,
      pivotV: 0.5,
      playState: 'Stopped'
    };

    /** @type {any} */
    this._bindings = {};

    /** @type {Tweakpane.FolderApi|null} */
    this._tileFolder = null;

    /** @type {Tweakpane.FolderApi|null} */
    this._motionFolder = null;

    /** @type {Tweakpane.FolderApi|null} */
    this._pivotFolder = null;

    /** @type {Tweakpane.FolderApi|null} */
    this._textureFolder = null;

    /** @type {number|null} */
    this._refreshInterval = null;

    /** @type {boolean} */
    this._pickingPivot = false;

    /** @type {THREE.Mesh|null} Pivot point visualization marker in the Three.js scene. */
    this._pivotMarker = null;

    this._drag = {
      active: false,
      mx: 0,
      my: 0,
      left: 0,
      top: 0
    };

    this._bound = {
      onHeaderDown: (e) => this._onHeaderDown(e),
      onHeaderMove: (e) => this._onHeaderMove(e),
      onHeaderUp: () => this._onHeaderUp(),
      onPivotPickKey: (e) => this._onPivotPickKey(e),
      onWorldClick: (info) => this._onWorldClick(info)
    };
  }

  async initialize() {
    if (this.pane) return;

    const startTime = Date.now();
    while (typeof Tweakpane === 'undefined' && (Date.now() - startTime) < 5000) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (typeof Tweakpane === 'undefined') {
      throw new Error('Tweakpane library not available');
    }

    this.container = document.createElement('div');
    this.container.id = 'map-shine-tile-motion-dialog';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '10006';
    this.container.style.right = '20px';
    this.container.style.top = '80px';
    this.container.style.display = 'none';
    document.body.appendChild(this.container);

    {
      const stop = (e) => {
        try { e.stopPropagation(); } catch (_) {}
      };
      const stopAndPrevent = (e) => {
        try { e.preventDefault(); } catch (_) {}
        stop(e);
      };

      const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'];
      for (const type of events) {
        if (type === 'wheel') this.container.addEventListener(type, stop, { passive: true });
        else this.container.addEventListener(type, stop);
      }
      this.container.addEventListener('contextmenu', stopAndPrevent);
    }

    this.pane = new Tweakpane.Pane({
      title: 'Tile Motion Manager',
      container: this.container,
      expanded: true
    });

    this.headerOverlay = document.createElement('div');
    this.headerOverlay.className = 'map-shine-tile-motion-header-overlay';
    this.headerOverlay.style.position = 'absolute';
    this.headerOverlay.style.top = '0';
    this.headerOverlay.style.left = '0';
    this.headerOverlay.style.right = '0';
    this.headerOverlay.style.height = '24px';
    this.headerOverlay.style.pointerEvents = 'auto';
    this.headerOverlay.style.cursor = 'move';
    this.headerOverlay.style.background = 'transparent';
    this.headerOverlay.style.zIndex = '10007';
    this.headerOverlay.addEventListener('mousedown', this._bound.onHeaderDown);
    this.container.appendChild(this.headerOverlay);

    this._buildUI();
    this.refreshTileList();
    this.hide();

    log.info('Tile Motion dialog initialized');
  }

  _getManager() {
    return window.MapShine?.tileMotionManager || null;
  }

  _getTileManager() {
    return window.MapShine?.tileManager || null;
  }

  _buildUI() {
    this._tileFolder = this.pane.addFolder({ title: 'Tile', expanded: true });
    this._motionFolder = this.pane.addFolder({ title: 'Transform Motion', expanded: true });
    this._pivotFolder = this.pane.addFolder({ title: 'Pivot', expanded: false });
    this._textureFolder = this.pane.addFolder({ title: 'Texture Motion', expanded: false });

    // Only build tile dropdown here; parent binding is added after all pivot controls.
    // tileStatus binding is created inside _rebuildTileBindings right after the tile selector.
    this._rebuildTileBindings(false);

    this._bindings.enabled = this._motionFolder.addBinding(this.uiState, 'enabled', {
      label: 'Enabled'
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.shadowProjectionEnabled = this._motionFolder.addBinding(this.uiState, 'shadowProjectionEnabled', {
      label: 'Shadow Projection'
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.mode = this._motionFolder.addBinding(this.uiState, 'mode', {
      label: 'Mode',
      options: {
        Transform: 'transform',
        Texture: 'texture'
      }
    }).on('change', (ev) => {
      this._refreshModeVisibility();
      this._onConfigChanged(ev);
    });

    this._bindings.motionType = this._motionFolder.addBinding(this.uiState, 'motionType', {
      label: 'Transform Type',
      options: {
        Rotation: 'rotation',
        Orbit: 'orbit',
        PingPong: 'pingPong',
        Sine: 'sine'
      }
    }).on('change', (ev) => {
      this._refreshModeVisibility();
      this._onConfigChanged(ev);
    });

    this._bindings.loopMode = this._motionFolder.addBinding(this.uiState, 'loopMode', {
      label: 'Loop Mode',
      options: {
        Loop: 'loop',
        PingPong: 'pingPong'
      }
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.speed = this._motionFolder.addBinding(this.uiState, 'speed', {
      label: 'Speed',
      min: -720,
      max: 720,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.phase = this._motionFolder.addBinding(this.uiState, 'phase', {
      label: 'Phase (deg)',
      min: -360,
      max: 360,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.radius = this._motionFolder.addBinding(this.uiState, 'radius', {
      label: 'Radius',
      min: 0,
      max: 5000,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.pointAX = this._motionFolder.addBinding(this.uiState, 'pointAX', {
      label: 'A X',
      min: -5000,
      max: 5000,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.pointAY = this._motionFolder.addBinding(this.uiState, 'pointAY', {
      label: 'A Y',
      min: -5000,
      max: 5000,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.pointBX = this._motionFolder.addBinding(this.uiState, 'pointBX', {
      label: 'B X',
      min: -5000,
      max: 5000,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.pointBY = this._motionFolder.addBinding(this.uiState, 'pointBY', {
      label: 'B Y',
      min: -5000,
      max: 5000,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.amplitudeX = this._motionFolder.addBinding(this.uiState, 'amplitudeX', {
      label: 'Amp X',
      min: -5000,
      max: 5000,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.amplitudeY = this._motionFolder.addBinding(this.uiState, 'amplitudeY', {
      label: 'Amp Y',
      min: -5000,
      max: 5000,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.amplitudeRot = this._motionFolder.addBinding(this.uiState, 'amplitudeRot', {
      label: 'Amp Rot (deg)',
      min: -720,
      max: 720,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.pivotX = this._pivotFolder.addBinding(this.uiState, 'pivotX', {
      label: 'Pivot X',
      min: -5000,
      max: 5000,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.pivotY = this._pivotFolder.addBinding(this.uiState, 'pivotY', {
      label: 'Pivot Y',
      min: -5000,
      max: 5000,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.snapToGrid = this._pivotFolder.addBinding(this.uiState, 'snapToGrid', {
      label: 'Snap Grid'
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._pivotFolder.addButton({
      title: 'Set Pivot = Center'
    }).on('click', () => {
      this.uiState.pivotX = 0;
      this.uiState.pivotY = 0;
      this._bindings.pivotX?.refresh?.();
      this._bindings.pivotY?.refresh?.();
      void this._applyCurrentTileConfig();
    });

    this._pivotFolder.addButton({
      title: 'Pick Pivot on Canvas'
    }).on('click', () => {
      this.startPivotPick();
    });

    // Parent dropdown lives at the end of the pivot folder so that
    // _refreshParentBinding() (dispose + re-add) keeps it in a consistent spot.
    this._refreshParentBinding();

    this._bindings.scrollU = this._textureFolder.addBinding(this.uiState, 'scrollU', {
      label: 'Scroll U',
      min: -4,
      max: 4,
      step: 0.01
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.scrollV = this._textureFolder.addBinding(this.uiState, 'scrollV', {
      label: 'Scroll V',
      min: -4,
      max: 4,
      step: 0.01
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.rotateSpeed = this._textureFolder.addBinding(this.uiState, 'rotateSpeed', {
      label: 'Rotate Speed',
      min: -720,
      max: 720,
      step: 1
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.pivotU = this._textureFolder.addBinding(this.uiState, 'pivotU', {
      label: 'Pivot U',
      min: 0,
      max: 1,
      step: 0.01
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    this._bindings.pivotV = this._textureFolder.addBinding(this.uiState, 'pivotV', {
      label: 'Pivot V',
      min: 0,
      max: 1,
      step: 0.01
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });

    const globalFolder = this.pane.addFolder({ title: 'Global Transport', expanded: false });

    this._bindings.playState = globalFolder.addBinding(this.uiState, 'playState', {
      label: 'State',
      readonly: true
    });

    globalFolder.addButton({ title: 'Start' }).on('click', async () => {
      const mgr = this._getManager();
      if (!mgr) return;
      const ok = await mgr.start();
      if (!ok) ui.notifications?.warn('Tile motion start failed');
      this._refreshGlobalState();
    });

    globalFolder.addButton({ title: 'Stop' }).on('click', async () => {
      const mgr = this._getManager();
      if (!mgr) return;
      const ok = await mgr.stop();
      if (!ok) ui.notifications?.warn('Tile motion stop failed');
      this._refreshGlobalState();
    });

    globalFolder.addButton({ title: 'Reset Phase' }).on('click', async () => {
      const mgr = this._getManager();
      if (!mgr || typeof mgr.resetPhase !== 'function') return;
      const ok = await mgr.resetPhase();
      if (!ok) ui.notifications?.warn('Tile motion phase reset failed');
      this._refreshGlobalState();
    });

    globalFolder.addButton({ title: 'Refresh Tile List' }).on('click', () => {
      this.refreshTileList();
    });

    // Load the first tile's config now that all bindings exist.
    this._loadTileConfigToUI();
    this._refreshModeVisibility();
  }

  /**
   * Rebuild the tile selector dropdown.
   * @param {boolean} [rebuildParent=true] Also rebuild the parent dropdown and load config.
   */
  _rebuildTileBindings(rebuildParent = true) {
    const mgr = this._getManager();
    const tiles = mgr?.getTileList?.() || [];

    const tileOptions = {};
    for (const t of tiles) {
      const statusLabel = mgr?.getTileRuntimeStatus?.(t.id)?.label || '';
      const display = statusLabel ? `${t.label} (${statusLabel})` : t.label;
      tileOptions[display] = t.id;
    }

    const hasTiles = tiles.length > 0;

    if (!hasTiles) {
      this.uiState.tileId = '';
      tileOptions['No Tiles Found'] = '';
    } else if (!this.uiState.tileId || !tiles.some((t) => t.id === this.uiState.tileId)) {
      this.uiState.tileId = tiles[0].id;
    }

    if (this._bindings.tileId?.dispose) this._bindings.tileId.dispose();
    if (this._bindings.tileStatus?.dispose) this._bindings.tileStatus.dispose();

    this._bindings.tileId = this._tileFolder.addBinding(this.uiState, 'tileId', {
      label: 'Tile',
      options: tileOptions
    }).on('change', () => {
      this._refreshParentBinding();
      this._refreshSelectedTileStatus();
      this._loadTileConfigToUI();
    });

    this._bindings.tileStatus = this._tileFolder.addBinding(this.uiState, 'tileStatus', {
      label: 'Status',
      readonly: true
    });

    if (rebuildParent) {
      this._refreshParentBinding();
      this._refreshSelectedTileStatus();
      this._loadTileConfigToUI();
    }
  }

  _refreshParentBinding() {
    const tiles = this._getManager()?.getTileList?.() || [];
    const options = { None: '' };

    for (const t of tiles) {
      if (t.id === this.uiState.tileId) continue;
      options[t.label] = t.id;
    }

    if (this._bindings.parentId?.dispose) this._bindings.parentId.dispose();
    this._bindings.parentId = this._pivotFolder.addBinding(this.uiState, 'parentId', {
      label: 'Parent',
      options
    }).on('change', (ev) => {
      this._onConfigChanged(ev);
    });
  }

  refreshTileList() {
    this._rebuildTileBindings();
    this._refreshGlobalState();
  }

  _refreshGlobalState() {
    const mgr = this._getManager();
    if (!mgr) {
      this.uiState.playState = 'Unavailable';
    } else {
      this.uiState.playState = mgr.isPlaying?.() ? 'Playing' : 'Stopped';
    }
    this._bindings.playState?.refresh?.();
    this._refreshSelectedTileStatus();
  }

  _refreshSelectedTileStatus() {
    const mgr = this._getManager();
    const tileId = this.uiState.tileId;

    if (!tileId || !mgr || typeof mgr.getTileRuntimeStatus !== 'function') {
      this.uiState.tileStatus = tileId ? 'Unknown' : 'No Tile Selected';
      this._bindings.tileStatus?.refresh?.();
      return;
    }

    const status = mgr.getTileRuntimeStatus(tileId);
    this.uiState.tileStatus = status?.label || 'Unknown';
    this._bindings.tileStatus?.refresh?.();
  }

  _loadTileConfigToUI() {
    const mgr = this._getManager();
    const tileId = this.uiState.tileId;
    if (!mgr || !tileId) return;

    const cfg = mgr.getTileConfig?.(tileId);
    if (!cfg) return;

    this.uiState.enabled = !!cfg.enabled;
    this.uiState.shadowProjectionEnabled = !!cfg.shadowProjectionEnabled;
    this.uiState.mode = cfg.mode === 'texture' ? 'texture' : 'transform';
    this.uiState.motionType = cfg.motion?.type || 'rotation';
    this.uiState.loopMode = cfg.motion?.loopMode === 'pingPong' ? 'pingPong' : 'loop';
    this.uiState.parentId = cfg.parentId || '';
    this.uiState.speed = _toNumber(cfg.motion?.speed, 0);
    this.uiState.phase = _toNumber(cfg.motion?.phase, 0);
    this.uiState.radius = Math.max(0, _toNumber(cfg.motion?.radius, 0));
    this.uiState.pointAX = _toNumber(cfg.motion?.pointA?.x, 0);
    this.uiState.pointAY = _toNumber(cfg.motion?.pointA?.y, 0);
    this.uiState.pointBX = _toNumber(cfg.motion?.pointB?.x, 0);
    this.uiState.pointBY = _toNumber(cfg.motion?.pointB?.y, 0);
    this.uiState.amplitudeX = _toNumber(cfg.motion?.amplitudeX, 0);
    this.uiState.amplitudeY = _toNumber(cfg.motion?.amplitudeY, 0);
    this.uiState.amplitudeRot = _toNumber(cfg.motion?.amplitudeRot, 0);
    this.uiState.pivotX = _toNumber(cfg.pivot?.x, 0);
    this.uiState.pivotY = _toNumber(cfg.pivot?.y, 0);
    this.uiState.snapToGrid = !!cfg.pivot?.snapToGrid;

    this.uiState.scrollU = _toNumber(cfg.textureMotion?.scrollU, 0);
    this.uiState.scrollV = _toNumber(cfg.textureMotion?.scrollV, 0);
    this.uiState.rotateSpeed = _toNumber(cfg.textureMotion?.rotateSpeed, 0);
    this.uiState.pivotU = _clamp(_toNumber(cfg.textureMotion?.pivotU, 0.5), 0, 1);
    this.uiState.pivotV = _clamp(_toNumber(cfg.textureMotion?.pivotV, 0.5), 0, 1);

    for (const b of Object.values(this._bindings)) {
      try { b?.refresh?.(); } catch (_) {}
    }

    this._refreshModeVisibility();
    this._updatePivotMarker();
  }

  _refreshModeVisibility() {
    const isTexture = this.uiState.mode === 'texture';
    const motionType = this.uiState.motionType;

    // Hide/show entire folders based on mode. Speed & phase stay in the
    // motion folder (always visible) since they also control texture rotation phase.
    if (this._pivotFolder) this._pivotFolder.hidden = isTexture;
    if (this._textureFolder) this._textureFolder.hidden = !isTexture;

    const showTransformOnly = !isTexture;
    const showOrbit = showTransformOnly && motionType === 'orbit';
    const showPingPong = showTransformOnly && motionType === 'pingPong';
    const showSine = showTransformOnly && motionType === 'sine';

    if (this._bindings.motionType) this._bindings.motionType.hidden = isTexture;
    // loopMode only affects orbit and pingPong; hide it for rotation/sine where it has no effect.
    const showLoopMode = showOrbit || showPingPong;
    if (this._bindings.loopMode) this._bindings.loopMode.hidden = !showLoopMode;

    if (this._bindings.radius) this._bindings.radius.hidden = !showOrbit;
    if (this._bindings.pointAX) this._bindings.pointAX.hidden = !showPingPong;
    if (this._bindings.pointAY) this._bindings.pointAY.hidden = !showPingPong;
    if (this._bindings.pointBX) this._bindings.pointBX.hidden = !showPingPong;
    if (this._bindings.pointBY) this._bindings.pointBY.hidden = !showPingPong;
    if (this._bindings.amplitudeX) this._bindings.amplitudeX.hidden = !showSine;
    if (this._bindings.amplitudeY) this._bindings.amplitudeY.hidden = !showSine;
    if (this._bindings.amplitudeRot) this._bindings.amplitudeRot.hidden = !showSine;
  }

  _onConfigChanged(ev) {
    const persist = (typeof ev?.last === 'boolean') ? ev.last : true;
    void this._applyCurrentTileConfig({ persist });
    this._updatePivotMarker();
  }

  async _applyCurrentTileConfig(options = undefined) {
    const mgr = this._getManager();
    const tileId = this.uiState.tileId;
    if (!mgr || !tileId) return false;

    const persist = options?.persist !== false;

    const patch = {
      enabled: !!this.uiState.enabled,
      shadowProjectionEnabled: !!this.uiState.shadowProjectionEnabled,
      mode: this.uiState.mode === 'texture' ? 'texture' : 'transform',
      parentId: this.uiState.parentId || null,
      pivot: {
        x: _toNumber(this.uiState.pivotX, 0),
        y: _toNumber(this.uiState.pivotY, 0),
        snapToGrid: !!this.uiState.snapToGrid
      },
      motion: {
        type: this.uiState.motionType || 'rotation',
        speed: _toNumber(this.uiState.speed, 0),
        phase: _toNumber(this.uiState.phase, 0),
        loopMode: this.uiState.loopMode === 'pingPong' ? 'pingPong' : 'loop',
        radius: Math.max(0, _toNumber(this.uiState.radius, 0)),
        pointA: {
          x: _toNumber(this.uiState.pointAX, 0),
          y: _toNumber(this.uiState.pointAY, 0)
        },
        pointB: {
          x: _toNumber(this.uiState.pointBX, 0),
          y: _toNumber(this.uiState.pointBY, 0)
        },
        amplitudeX: _toNumber(this.uiState.amplitudeX, 0),
        amplitudeY: _toNumber(this.uiState.amplitudeY, 0),
        amplitudeRot: _toNumber(this.uiState.amplitudeRot, 0)
      },
      textureMotion: {
        scrollU: _toNumber(this.uiState.scrollU, 0),
        scrollV: _toNumber(this.uiState.scrollV, 0),
        rotateSpeed: _toNumber(this.uiState.rotateSpeed, 0),
        pivotU: _clamp(_toNumber(this.uiState.pivotU, 0.5), 0, 1),
        pivotV: _clamp(_toNumber(this.uiState.pivotV, 0.5), 0, 1)
      }
    };

    const ok = await mgr.setTileConfig?.(tileId, patch, { persist });
    if (!ok && persist && game.user?.isGM) {
      ui.notifications?.warn('Failed to save tile motion config');
    }
    return !!ok;
  }

  // ── Pivot Pick (via InteractionManager pending world pick) ─────────────

  startPivotPick() {
    if (!this.visible) this.show();
    if (this._pickingPivot) return;

    const mgr = this._getManager();
    if (!mgr || !this.uiState.tileId) {
      ui.notifications?.warn('Select a tile first');
      return;
    }

    const im = window.MapShine?.interactionManager;
    if (!im || typeof im.setPendingWorldPick !== 'function') {
      ui.notifications?.warn('Interaction manager not available');
      return;
    }

    this._pickingPivot = true;
    // Register a one-shot pick callback with the InteractionManager.
    // The IM checks this at the very top of onPointerDown, consumes the
    // event, and passes us world coords directly — no event-ordering issues.
    im.setPendingWorldPick((worldPos) => this._handlePivotPick(worldPos));
    window.addEventListener('keydown', this._bound.onPivotPickKey, true);
    ui.notifications?.info('Click on canvas to set pivot (Esc to cancel)');
  }

  _stopPivotPick() {
    if (!this._pickingPivot) return;
    this._pickingPivot = false;
    window.removeEventListener('keydown', this._bound.onPivotPickKey, true);
    const im = window.MapShine?.interactionManager;
    if (im && typeof im.clearPendingWorldPick === 'function') {
      im.clearPendingWorldPick();
    }
  }

  _onPivotPickKey(e) {
    if (e.key === 'Escape') {
      this._stopPivotPick();
      ui.notifications?.info('Pivot pick cancelled');
    }
  }

  /**
   * Callback from InteractionManager's pending world pick.
   * Receives Three.js world coords at groundZ.
   */
  _handlePivotPick(world) {
    const tileMgr = this._getTileManager();
    const data = tileMgr?.getTileSpriteData?.(this.uiState.tileId);
    const tileDoc = data?.tileDoc;
    if (!tileDoc) {
      this._stopPivotPick();
      return;
    }

    let worldX = world.x;
    let worldY = world.y;

    // Optional grid snapping.
    if (this.uiState.snapToGrid && canvas?.dimensions?.size) {
      const grid = canvas.dimensions.size;
      const p = Coordinates.toFoundry(worldX, worldY);
      const sx = Math.round(p.x / grid) * grid;
      const sy = Math.round(p.y / grid) * grid;
      const snap = Coordinates.toWorld(sx, sy);
      worldX = snap.x;
      worldY = snap.y;
    }

    // Convert to Foundry coords and compute local offset from tile center.
    const foundry = Coordinates.toFoundry(worldX, worldY);
    const centerX = _toNumber(tileDoc.x, 0) + _toNumber(tileDoc.width, 0) * 0.5;
    const centerY = _toNumber(tileDoc.y, 0) + _toNumber(tileDoc.height, 0) * 0.5;

    const dx = foundry.x - centerX;
    const dy = foundry.y - centerY;

    // Rotate into tile-local space (undo tile rotation).
    const inv = -_toNumber(tileDoc.rotation, 0) * (Math.PI / 180);
    const c = Math.cos(inv);
    const s = Math.sin(inv);

    const localX = dx * c - dy * s;
    const localY = dx * s + dy * c;

    this.uiState.pivotX = localX;
    this.uiState.pivotY = localY;
    this._bindings.pivotX?.refresh?.();
    this._bindings.pivotY?.refresh?.();

    this._stopPivotPick();
    void this._applyCurrentTileConfig();
    this._updatePivotMarker();
  }

  // ── World Click Observer (tile auto-select) ──────────────────────────

  /**
   * Called by InteractionManager on every left-click with world coords.
   * Raycasts against tile sprites and auto-selects the clicked tile in the dropdown.
   */
  _onWorldClick(info) {
    if (!this.visible) return;

    const tileMgr = this._getTileManager();
    if (!tileMgr?.tileSprites) return;

    const sceneComposer = window.MapShine?.sceneComposer;
    const camera = sceneComposer?.camera;
    const renderer = sceneComposer?.renderer;
    const THREE = window.THREE;
    if (!camera || !renderer || !THREE) return;

    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((info.clientX - rect.left) / rect.width) * 2 - 1,
      -(((info.clientY - rect.top) / rect.height) * 2 - 1)
    );

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);

    // Collect all tile sprites for raycasting.
    const sprites = [];
    for (const [, data] of tileMgr.tileSprites) {
      if (data?.sprite?.visible) sprites.push(data.sprite);
    }
    if (sprites.length === 0) return;

    const hits = raycaster.intersectObjects(sprites, false);
    if (hits.length === 0) return;

    const hitSprite = hits[0].object;
    const tileId = hitSprite?.userData?.foundryTileId;
    if (!tileId || tileId === this.uiState.tileId) return;

    // Check the tile exists in the manager's config list.
    const mgr = this._getManager();
    const tiles = mgr?.getTileList?.() || [];
    if (!tiles.some((t) => t.id === tileId)) return;

    this.uiState.tileId = tileId;
    this._rebuildTileBindings(true);
    this._updatePivotMarker();
  }

  // ── Pivot Marker Visualization ───────────────────────────────────────

  /**
   * Compute the pivot's world position from tile doc and local pivot offsets.
   * Returns Three.js world coords or null.
   */
  _getPivotWorldPos() {
    const tileMgr = this._getTileManager();
    const data = tileMgr?.getTileSpriteData?.(this.uiState.tileId);
    const tileDoc = data?.tileDoc;
    if (!tileDoc) return null;

    const centerX = _toNumber(tileDoc.x, 0) + _toNumber(tileDoc.width, 0) * 0.5;
    const centerY = _toNumber(tileDoc.y, 0) + _toNumber(tileDoc.height, 0) * 0.5;

    // Rotate local pivot by tile rotation to get Foundry world offset.
    const rot = _toNumber(tileDoc.rotation, 0) * (Math.PI / 180);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const localX = _toNumber(this.uiState.pivotX, 0);
    const localY = _toNumber(this.uiState.pivotY, 0);

    const foundryX = centerX + (localX * c - localY * s);
    const foundryY = centerY + (localX * s + localY * c);

    return Coordinates.toWorld(foundryX, foundryY);
  }

  /**
   * Create or update the pivot marker mesh in the Three.js scene.
   * Shows a small ring at the current pivot position when the dialog is visible.
   */
  _updatePivotMarker() {
    const THREE = window.THREE;
    const sceneComposer = window.MapShine?.sceneComposer;
    if (!THREE || !sceneComposer?.scene) {
      this._disposePivotMarker();
      return;
    }

    const worldPos = this._getPivotWorldPos();
    if (!worldPos || !this.visible || !this.uiState.tileId) {
      if (this._pivotMarker) this._pivotMarker.visible = false;
      return;
    }

    // Lazy-create the marker mesh (torus ring).
    if (!this._pivotMarker) {
      const ringGeo = new THREE.RingGeometry(8, 12, 24);
      const ringMat = new THREE.MeshBasicMaterial({
        color: 0xff4444,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        depthWrite: false
      });
      this._pivotMarker = new THREE.Mesh(ringGeo, ringMat);
      this._pivotMarker.name = 'TileMotion_PivotMarker';
      this._pivotMarker.renderOrder = 9999;
      // Lay flat on the ground plane (ring is in XY, we need it in XY at groundZ).
      sceneComposer.scene.add(this._pivotMarker);
    }

    const groundZ = sceneComposer.groundZ ?? 1000;
    this._pivotMarker.position.set(worldPos.x, worldPos.y, groundZ + 0.5);
    this._pivotMarker.visible = true;
  }

  /** Remove the pivot marker from the scene and dispose resources. */
  _disposePivotMarker() {
    if (!this._pivotMarker) return;
    this._pivotMarker.removeFromParent();
    this._pivotMarker.geometry?.dispose?.();
    this._pivotMarker.material?.dispose?.();
    this._pivotMarker = null;
  }

  _onHeaderDown(e) {
    if (!this.container) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = this.container.getBoundingClientRect();
    this.container.style.left = `${rect.left}px`;
    this.container.style.top = `${rect.top}px`;
    this.container.style.right = 'auto';

    this._drag.active = true;
    this._drag.mx = e.clientX;
    this._drag.my = e.clientY;
    this._drag.left = rect.left;
    this._drag.top = rect.top;

    document.addEventListener('mousemove', this._bound.onHeaderMove, { capture: true });
    document.addEventListener('mouseup', this._bound.onHeaderUp, { capture: true });
  }

  _onHeaderMove(e) {
    if (!this._drag.active || !this.container) return;

    const dx = e.clientX - this._drag.mx;
    const dy = e.clientY - this._drag.my;

    let left = this._drag.left + dx;
    let top = this._drag.top + dy;

    const pad = 12;
    const maxLeft = Math.max(pad, window.innerWidth - (this.container.offsetWidth + pad));
    const maxTop = Math.max(pad, window.innerHeight - (this.container.offsetHeight + pad));

    left = Math.max(pad, Math.min(maxLeft, left));
    top = Math.max(pad, Math.min(maxTop, top));

    this.container.style.left = `${left}px`;
    this.container.style.top = `${top}px`;
  }

  _onHeaderUp() {
    this._drag.active = false;
    document.removeEventListener('mousemove', this._bound.onHeaderMove, { capture: true });
    document.removeEventListener('mouseup', this._bound.onHeaderUp, { capture: true });
  }

  show() {
    if (!this.container) return;
    this.container.style.display = 'block';
    this.visible = true;
    this.refreshTileList();

    if (this._refreshInterval !== null) clearInterval(this._refreshInterval);
    this._refreshInterval = setInterval(() => {
      this._refreshGlobalState();
    }, 300);

    // Register world click observer for tile auto-select.
    const im = window.MapShine?.interactionManager;
    if (im && typeof im.addWorldClickObserver === 'function') {
      im.addWorldClickObserver(this._bound.onWorldClick);
    }

    this._updatePivotMarker();
  }

  hide() {
    if (!this.container) return;
    this.container.style.display = 'none';
    this.visible = false;

    if (this._refreshInterval !== null) {
      clearInterval(this._refreshInterval);
      this._refreshInterval = null;
    }

    this._stopPivotPick();

    // Unregister world click observer.
    const im = window.MapShine?.interactionManager;
    if (im && typeof im.removeWorldClickObserver === 'function') {
      im.removeWorldClickObserver(this._bound.onWorldClick);
    }

    // Hide pivot marker when dialog is closed.
    if (this._pivotMarker) this._pivotMarker.visible = false;
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  dispose() {
    this.hide();
    this._disposePivotMarker();

    if (this.headerOverlay) {
      this.headerOverlay.removeEventListener('mousedown', this._bound.onHeaderDown);
    }

    document.removeEventListener('mousemove', this._bound.onHeaderMove, { capture: true });
    document.removeEventListener('mouseup', this._bound.onHeaderUp, { capture: true });

    if (this.pane) {
      this.pane.dispose();
      this.pane = null;
    }

    if (this.container?.parentNode) {
      this.container.parentNode.removeChild(this.container);
    }

    this.container = null;
    this.headerOverlay = null;
    this._bindings = {};

    log.info('Tile Motion dialog disposed');
  }
}
