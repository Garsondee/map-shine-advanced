/**
 * @fileoverview Interaction manager - handles selection, dragging, and deletion of objects
 * Replaces Foundry's canvas interaction layer for THREE.js
 * @module scene/interaction-manager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';
import { EnhancedLightInspector } from '../ui/enhanced-light-inspector.js';
import { SelectionBoxEffect } from '../effects/SelectionBoxEffect.js';
import { MapPointDrawHandler } from './map-point-interaction.js';
import { LightInteractionHandler } from './light-interaction.js';
import { SelectionBoxHandler } from './selection-box-interaction.js';
import { safeCall, safeDispose, Severity } from '../core/safe-call.js';
import { readWallHeightFlags } from '../foundry/levels-scene-flags.js';
import { applyAmbientLightLevelDefaults, applyWallLevelDefaults } from '../foundry/levels-create-defaults.js';
import { isTokenOnActiveLevel, isTokenDragSelectable, getAutoSwitchElevation, switchToLevelForElevation } from './level-interaction-service.js';

const log = createLogger('InteractionManager');

/**
 * InteractionManager - Handles mouse/keyboard interaction with the THREE.js scene
 */
export class InteractionManager {
  /**
   * @param {HTMLElement} canvasElement - The THREE.js canvas element
   * @param {SceneComposer} sceneComposer - For camera and coordinate conversion
   * @param {TokenManager} tokenManager - For accessing token sprites
   * @param {TileManager} tileManager - For accessing tile sprites
   * @param {WallManager} wallManager - For creating/managing walls
   * @param {LightIconManager} [lightIconManager] - For accessing light icons
   */
  constructor(canvasElement, sceneComposer, tokenManager, tileManager, wallManager, lightIconManager = null) {
    this.canvasElement = canvasElement;
    this.sceneComposer = sceneComposer;
    this.tokenManager = tokenManager;
    this.tileManager = tileManager;
    this.wallManager = wallManager;
    this.lightIconManager = lightIconManager;

    /**
     * Sub-rate update lane — HUD positioning and gizmo updates are smooth at 30 Hz.
     * Set to 0 or undefined to run every rendered frame.
     * @type {number}
     */
    this.updateHz = 30;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();

    // Debug visualization for overhead hover hit testing.
    // Enable via:
    //   window.MapShine.interactionManager.setOverheadHoverDebug(true)
    // or:
    //   window.MapShine.interactionManager._debugOverheadHover.enabled = true
    this._debugOverheadHover = {
      enabled: false,
      group: null,
      marker: null,
      ray: null,
      label: null,
      last: {
        tileId: null,
        uv: null,
        point: null,
        opaque: null
      }
    };
    
    /** @type {Set<string>} Set of selected object IDs (e.g. "Token.abc", "Tile.xyz") */
    this.selection = new Set();

    // Copy/paste clipboard for lights.
    // Stored as a plain serializable object so we can safely deep-clone and mutate.
    this._lightClipboard = null;

    // Track last pointer position (screen coords) so paste can place at cursor.
    this._lastPointerClientX = null;
    this._lastPointerClientY = null;

    // Keyboard token movement throttle state.
    // - _keyboardMoveIntent stores the most recent desired direction per token.
    // - _keyboardStepInFlight prevents issuing multiple tokenDoc.update calls
    //   before TokenMovementManager has a chance to register an active track.
    this._keyboardMoveIntent = null;
    this._keyboardStepInFlight = new Map();
    
    // Drag state
    this.dragState = {
      active: false,
      mode: null,
      leaderId: null, // ID of the token we clicked on
      object: null, // The PREVIEW sprite being dragged
      startPos: new THREE.Vector3(), // Initial position of the dragged object
      offset: new THREE.Vector3(), // Offset from center
      hasMoved: false,
      initialPositions: new Map(), // Map<string, THREE.Vector3> - Initial positions of all selected objects
      previews: new Map(), // Map<string, THREE.Sprite> - Drag previews
      mapPointGroupId: null,
      mapPointIndex: null,
      mapPointPoints: null
    };

    // Pending light interaction (disambiguate click-to-open-editor vs drag-to-move-light).
    // We only open the editor on pointerup if the pointer hasn't moved past threshold.
    this._pendingLight = {
      active: false,
      type: null, // 'foundry' | 'enhanced'
      id: null,
      sprite: null,
      hitPoint: null,
      canEdit: false,
      startClientX: 0,
      startClientY: 0,
      thresholdPx: 8,
      forceSheet: false
    };

    // Light translate gizmo (X/Y + center handle). This keeps translation handles
    // offset from the light icon for clearer interaction.
    this._lightTranslate = {
      group: null,
      handles: [],
      active: false,
      selected: null, // {type:'foundry'|'enhanced', id:string}
      axis: 'xy',
      // Screen-space offset from the light center (kept stable via /zoom)
      offsetPx: { x: 140, y: 0 }
    };

    // Light radius editing handles (drag to adjust bright/dim radii)
    this._lightRadiusRings = {
      group: null,
      brightHandle: null,
      dimHandle: null,
      handles: [], // clickable handles for raycasting
      selected: null, // {type:'foundry'|'enhanced', id:string}
      dragging: null, // 'bright' | 'dim' | null
      startRadius: 0,
      startDistance: 0,
      startBright: 0,
      startDim: 0,
      startClientX: 0,
      startClientY: 0,
      pendingType: null, // 'bright' | 'dim' | null
      pendingRadius: null,
      previewBright: null,
      previewDim: null,
      // Live-apply during drag (still throttled and finalized on pointer-up).
      liveApplyHz: 15,
      lastLiveApplyMs: 0,
      liveInFlight: false,
      liveQueued: null,
      // Screen-space offset from the light center (kept stable via /zoom)
      // Keep these offset from the light editor overlay so they're always usable.
      offsetPx: { x: 140, y: 70 }
    };

    // HTML radius slider overlay (replaces the colored 3D radius handles).
    this._radiusSliderUI = {
      el: null,
      dimEl: null,
      brightPctEl: null,
      dimValueEl: null,
      brightValueEl: null,
      visible: false,
      // Cache last values to avoid UI flicker.
      lastDimUnits: null,
      lastBrightPct: null,
      // Avoid recursive input->setValue->input loops.
      suppressInput: false,
    };

    // Screen-space hover label for gizmos/handles.
    this._uiHoverLabel = {
      el: null,
      visible: false
    };

    // One-shot world pick callback (e.g., pivot selection from Tile Motion dialog).
    // Set via setPendingWorldPick(); checked at the top of onPointerDown.
    /** @type {((worldPos: {x:number, y:number}) => void)|null} */
    this._pendingWorldPick = null;

    // Persistent world click observers notified on every left-click with world coords.
    // Used by the Tile Motion dialog to auto-select clicked tiles.
    /** @type {Set<(info: {clientX:number, clientY:number, worldX:number, worldY:number}) => void>} */
    this._worldClickObservers = new Set();

    this._pendingTokenMoveCleanup = {
      timeoutId: null,
      tokenIds: new Set()
    };

    // WP-7 Multiplayer cursor broadcast: throttled Foundry canvas coordinate
    // broadcast mirroring ControlsLayer._onMouseMove when Three owns input.
    /** @type {number} */
    this._lastCursorBroadcastMs = 0;
    /** @type {number} Minimum ms between broadcasts (matches Foundry ticker rate). */
    this._cursorBroadcastIntervalMs = 100;

    // WP-3 Ping parity: long-press ping detection mirrors Foundry's
    // ControlsLayer._onLongPress (500ms hold on empty canvas → canvas.ping).
    /** @type {{timerId: number|null, startX: number, startY: number, worldX: number, worldY: number, threshold: number, shiftHeld: boolean}} */
    this._pingLongPress = {
      timerId: null,
      startX: 0,
      startY: 0,
      worldX: 0,
      worldY: 0,
      threshold: 5,
      shiftHeld: false
    };

    this.movementPathPreview = {
      group: null,
      lineOuter: null,
      lineInner: null,
      tileGroup: null,
      ghostGroup: null,
      labelEl: null,
      active: false,
      currentKey: '',
      lastUpdateMs: 0,
      updateIntervalMs: 80,
      pending: null,
      inFlight: false
    };

    this.rightClickMovePreview = {
      active: false,
      tokenId: null,
      tileKey: '',
      destinationTopLeft: null,
      selectionKey: '',
      groupPlanCacheKey: ''
    };

    this.moveClickState = {
      active: false,
      button: 2,
      tokenDoc: null,
      tokenDocs: null,
      worldPos: null,
      startPos: new THREE.Vector2(),
      threshold: 10
    };

    // Throttle enhanced light LOS-polygon refresh during drag.
    this._enhancedLightDragRadiusHz = 15;
    this._enhancedLightDragLastRadiusRefreshMs = 0;

    // Wall Draw state
    this.wallDraw = {
      active: false,
      start: new THREE.Vector3(), // World pos
      current: new THREE.Vector3(), // World pos
      previewLine: null, // THREE.Line
      type: 'walls' // 'walls', 'terrain', etc.
    };

    // Drag Select state
    this.dragSelect = {
      active: false,
      dragging: false,
      start: new THREE.Vector3(),
      current: new THREE.Vector3(),
      mesh: null,
      border: null,
      shadowMesh: null,
      shadowMaterial: null,
      illuminationMesh: null,
      illuminationMaterial: null,
      // Screen-space positions for visual overlay (client coordinates)
      screenStart: new THREE.Vector2(),
      screenCurrent: new THREE.Vector2(),
      overlayEl: null,
      threshold: 10
    };

    // Selection box visual parameters (UI-controlled)
    this.selectionBoxParams = {
      enabled: true,

      outlineColor: { r: 0.2, g: 0.75, b: 1.0 },
      outlineWidthPx: 2,
      outlineAlpha: 0.95,

      fillAlpha: 0.02,

      // Glassmorphism (DOM backdrop filter)
      glassEnabled: false,
      glassBlurPx: 4,

      // Gradient stroke
      gradientEnabled: false,
      gradientSpeed: 0.6,
      gradientColorA: { r: 0.0, g: 1.0, b: 1.0 },
      gradientColorB: { r: 1.0, g: 0.0, b: 1.0 },

      // Reticle crosshair lines
      reticleEnabled: false,
      reticleAlpha: 0.12,
      reticleWidthPx: 1,

      // Tech corner brackets
      techBracketsEnabled: false,
      techBracketAlpha: 0.9,
      techBracketLengthPx: 18,
      techBracketWidthPx: 2,

      // Border style
      borderStyle: 'solid', // 'solid' | 'dashed' | 'marching'
      dashLengthPx: 10,
      dashGapPx: 6,
      dashSpeed: 120, // px/s for marching ants

      // Double border (secondary stroke)
      doubleBorderEnabled: false,
      doubleBorderInsetPx: 3,
      doubleBorderWidthPx: 1,
      doubleBorderAlpha: 0.5,
      doubleBorderStyle: 'dashed', // 'solid' | 'dashed' | 'marching'

      cornerRadiusPx: 2,

      glowEnabled: true,
      glowAlpha: 0.22,
      glowSizePx: 22,

      // Animated pulse (primarily affects glow + outline alpha)
      pulseEnabled: false,
      pulseSpeed: 2.0,
      pulseStrength: 0.5,

      // Fill pattern overlay
      pattern: 'grid', // 'none' | 'grid' | 'diagonal' | 'dots'
      patternScalePx: 22,
      patternAlpha: 0.14,
      patternLineWidthPx: 1,

      shadowEnabled: true,
      shadowOpacity: 0.22,
      shadowFeather: 0.08,
      shadowOffsetPx: 18,
      shadowZOffset: 0.12,

      // Illumination (world-space additive projection)
      illuminationEnabled: false,
      illuminationIntensity: 0.35,
      illuminationGridScalePx: 24,
      illuminationScrollSpeed: 0.25,
      illuminationColor: { r: 0.3, g: 0.85, b: 1.0 },

      // Label
      labelEnabled: false,
      labelAlpha: 0.85,
      labelFontSizePx: 12,
      labelClampToViewport: true
    };

    // Cached selection overlay state to avoid per-frame DOM churn.
    this._selectionOverlay = {
      svg: null,
      defs: null,
      baseRect: null,
      patternRect: null,
      strokeRect: null,
      strokeRect2: null,
      labelEl: null,
      ids: null,
      lastW: 0,
      lastH: 0,
      lastBracketLen: 0,
      lastDoubleBorderInset: 0,
      dashOffset: 0,
      dashOffset2: 0,
      time: 0,
      // Cached strings
      strokeRgb: { r: 80, g: 200, b: 255 },
      strokeAlpha: 0.9,
      fillAlpha: 0.035,
      glowAlpha: 0.12
    };

    /** @type {SelectionBoxEffect|null} */
    this.selectionBoxEffect = new SelectionBoxEffect(this);

    // Right Click State (for HUD)
    this.rightClickState = {
      active: false,
      time: 0,
      startPos: new THREE.Vector2(),
      tokenId: null,
      threshold: 10 // Increased from 5 to 10 to prevent accidental panning
    };

    // Light Placement State
    this.lightPlacement = {
      active: false,
      start: new THREE.Vector3(),
      current: new THREE.Vector3(),
      previewGroup: null,
      previewFill: null,
      previewBorder: null
    };


    // Map Point Drawing — delegated to extracted handler
    /** @type {MapPointDrawHandler} */
    this.mapPointDrawHandler = new MapPointDrawHandler(this);
    // Backward-compatible alias so existing code referencing this.mapPointDraw.* still works
    this.mapPointDraw = this.mapPointDrawHandler.state;

    // Light Interaction — delegated to extracted handler
    /** @type {LightInteractionHandler} */
    this.lightHandler = new LightInteractionHandler(this);

    // Selection Box — delegated to extracted handler
    /** @type {SelectionBoxHandler} */
    this.selectionBoxHandler = new SelectionBoxHandler(this);
    
    // Create drag select visuals (Three.js mesh kept for compatibility)
    this.selectionBoxHandler.createSelectionBox();
    this.selectionBoxEffect.initialize();
    this.createMovementPathPreviewOverlay();
    this.lightHandler.createUIHoverLabelOverlay();
    this.lightHandler.createRadiusSliderOverlay();
    this.lightHandler.createLightPreview();
    this.mapPointDrawHandler.createPreview();
    this.lightHandler.createTranslateGizmo();
    this.lightHandler.createRadiusRingsGizmo();
    this.lightHandler.createSelectedLightOutline();
    
    /** @type {string|null} ID of currently hovered token */
    this.hoveredTokenId = null;
    /** @type {string|null} ID of currently hovered wall */
    this.hoveredWallId = null;
    /** @type {string|null} ID of currently hovered overhead tile */
    this.hoveredOverheadTileId = null;
    /** @type {string|null} ID of overhead tile pending hover-hide debounce */
    this._pendingOverheadTileId = null;
    /** @type {number} Timestamp when overhead hover debounce started */
    this._overheadHoverStartMs = 0;
    /** @type {number|null} Timeout handle for overhead hover-hide debounce */
    this._overheadHoverTimeoutId = null;
    this.hoveringTreeCanopy = false;
    
    /** @type {string|null} ID of token whose HUD is currently open */
    this.openHudTokenId = null;

    // Performance: cache canvas bounding rect and reuse scratch vectors for per-frame UI projection.
    // Avoids repeated DOMRect allocations + style object allocations which can trigger Firefox CC.
    this._canvasRectCache = { left: 0, top: 0, width: 0, height: 0, ts: 0 };
    this._canvasRectCacheMaxAgeMs = 250;
    this._tempVec3HUD = new THREE.Vector3();
    this._tempVec3UI = new THREE.Vector3();
    this._viewportToWorldPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this._viewportToWorldTarget = new THREE.Vector3();
    this._viewportToWorldLastZ = null;
    this._hudLastCss = { left: null, top: null, transform: null };
    this._hudStyledEl = null;

    this.boundHandlers = {
      onPointerDown: this.onPointerDown.bind(this),
      onPointerMove: this.onPointerMove.bind(this),
      onPointerUp: this.onPointerUp.bind(this),
      onWheel: this.onWheel.bind(this),
      onKeyDown: this.onKeyDown.bind(this),
      onDoubleClick: this.onDoubleClick.bind(this)
    };

    log.debug('InteractionManager created');
  }

  setOverheadHoverDebug(enabled) {
    this._debugOverheadHover.enabled = !!enabled;
    if (this._debugOverheadHover.enabled) {
      // Ensure objects exist immediately so the user can diagnose cases where the
      // raycast never hits (misalignment / layer mask issues).
      safeCall(() => {
        this._ensureOverheadHoverDebugObjects();
        if (this._debugOverheadHover.group) this._debugOverheadHover.group.visible = true;
      }, 'overheadHoverDebug.enable', Severity.COSMETIC);
    }
    if (!this._debugOverheadHover.enabled) {
      safeCall(() => { if (this._debugOverheadHover.group) this._debugOverheadHover.group.visible = false; }, 'overheadHoverDebug.hideGroup', Severity.COSMETIC);
      safeCall(() => { if (this._debugOverheadHover.label) this._debugOverheadHover.label.style.display = 'none'; }, 'overheadHoverDebug.hideLabel', Severity.COSMETIC);
    }
  }

  _ensureOverheadHoverDebugObjects() {
    if (this._debugOverheadHover.group) return;
    const THREE = window.THREE;
    if (!THREE) return;
    const scene = this.sceneComposer?.scene;
    if (!scene) return;

    const g = new THREE.Group();
    g.name = 'OverheadHoverDebug';
    g.visible = false;
    g.renderOrder = 10050;
    g.layers.set(OVERLAY_THREE_LAYER);
    g.layers.enable(0);

    const depthTest = false;
    const depthWrite = false;
    const mat = new THREE.LineBasicMaterial({ color: 0xff33ff, transparent: true, opacity: 0.95, depthTest, depthWrite });
    mat.toneMapped = false;

    // Small crosshair in the XY plane.
    const size = 18;
    const pts = [
      new THREE.Vector3(-size, 0, 0), new THREE.Vector3(size, 0, 0),
      new THREE.Vector3(0, -size, 0), new THREE.Vector3(0, size, 0)
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const marker = new THREE.LineSegments(geo, mat);
    marker.renderOrder = 10051;
    marker.layers.set(OVERLAY_THREE_LAYER);
    marker.layers.enable(0);
    g.add(marker);

    // Optional ray line from camera to hit point (updated per-frame when enabled).
    const rayGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const rayMat = new THREE.LineBasicMaterial({ color: 0x33ffff, transparent: true, opacity: 0.55, depthTest, depthWrite });
    rayMat.toneMapped = false;
    const ray = new THREE.Line(rayGeo, rayMat);
    ray.renderOrder = 10050;
    ray.layers.set(OVERLAY_THREE_LAYER);
    ray.layers.enable(0);
    g.add(ray);

    // Billboard quad outline (what THREE.Sprite raycasting targets).
    const quadGeo = new THREE.BufferGeometry();
    quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(15), 3));
    const quadMat = new THREE.LineBasicMaterial({ color: 0xffff33, transparent: true, opacity: 0.85, depthTest, depthWrite });
    quadMat.toneMapped = false;
    const quad = new THREE.Line(quadGeo, quadMat);
    quad.name = 'OverheadHoverDebugQuad';
    quad.renderOrder = 10049;
    quad.layers.set(OVERLAY_THREE_LAYER);
    quad.layers.enable(0);
    quad.frustumCulled = false;
    g.add(quad);

    scene.add(g);
    this._debugOverheadHover.group = g;
    this._debugOverheadHover.marker = marker;
    this._debugOverheadHover.ray = ray;
    this._debugOverheadHover.quad = quad;

    // Temp vectors to avoid allocations in debug updates.
    this._debugOverheadHover._tmpRight = new THREE.Vector3();
    this._debugOverheadHover._tmpUp = new THREE.Vector3();
    this._debugOverheadHover._tmpCorner = new THREE.Vector3();

    // Small DOM label near the cursor showing tileId + UV.
    safeCall(() => {
      const el = document.createElement('div');
      el.style.position = 'fixed';
      el.style.zIndex = '10002';
      el.style.pointerEvents = 'none';
      el.style.padding = '2px 6px';
      el.style.borderRadius = '4px';
      el.style.background = 'rgba(0,0,0,0.65)';
      el.style.border = '1px solid rgba(255,255,255,0.15)';
      el.style.color = 'rgba(255,255,255,0.9)';
      el.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      el.style.fontSize = '11px';
      el.style.display = 'none';
      document.body.appendChild(el);
      this._debugOverheadHover.label = el;
    }, 'overheadHoverDebug.createLabel', Severity.COSMETIC);
  }

  _updateOverheadHoverDebug(event, hit, opaqueHit) {
    if (!this._debugOverheadHover?.enabled) return;
    this._ensureOverheadHoverDebugObjects();
    const dbg = this._debugOverheadHover;
    if (!dbg.group || !dbg.marker || !dbg.ray) return;

    if (!hit) {
      dbg.group.visible = false;
      safeCall(() => { if (dbg.label) dbg.label.style.display = 'none'; }, 'overheadDebug.hideLabel', Severity.COSMETIC);
      return;
    }

    const THREE = window.THREE;
    const p = hit.point;
    if (!p || !THREE) return;

    dbg.group.visible = true;
    dbg.marker.position.copy(p);
    dbg.marker.position.z += 0.5;

    // Draw the sprite billboard quad outline so we can see if the ray target is
    // offset/scaled relative to the rendered texture.
    safeCall(() => {
      const sprite = hit?.object;
      const cam = this.sceneComposer?.camera;
      const quad = dbg.quad;
      const right = dbg._tmpRight;
      const up = dbg._tmpUp;
      const corner = dbg._tmpCorner;

      // Use world-space basis + origin so the debug quad matches the raycaster target
      // even when tiles are parented under transformed groups.
      const origin = dbg._tmpOrigin || (dbg._tmpOrigin = new THREE.Vector3());

      if (sprite && cam && quad && right && up && corner) {
        cam.getWorldQuaternion(_tmpQuat);
        right.set(1, 0, 0).applyQuaternion(_tmpQuat);
        up.set(0, 1, 0).applyQuaternion(_tmpQuat);

        sprite.getWorldPosition(origin);

        const sx = sprite.scale?.x ?? 1;
        const sy = sprite.scale?.y ?? 1;
        const cx = sprite.center?.x ?? 0.5;
        const cy = sprite.center?.y ?? 0.5;

        // Sprite local corners (in sprite units), respecting anchor center.
        // left/right extents are [-cx, 1-cx] scaled by sprite.scale.
        const x0 = (-cx) * sx;
        const x1 = (1 - cx) * sx;
        const y0 = (-cy) * sy;
        const y1 = (1 - cy) * sy;

        const attr = quad.geometry.getAttribute('position');
        const arr = attr.array;

        const writeCorner = (idx, x, y) => {
          corner.copy(origin);
          corner.addScaledVector(right, x);
          corner.addScaledVector(up, y);
          // Nudge above the sprite so the line is always visible.
          corner.z += 0.4;
          arr[idx + 0] = corner.x;
          arr[idx + 1] = corner.y;
          arr[idx + 2] = corner.z;
        };

        // CCW loop, 5th point closes.
        writeCorner(0, x0, y0);
        writeCorner(3, x1, y0);
        writeCorner(6, x1, y1);
        writeCorner(9, x0, y1);
        writeCorner(12, x0, y0);

        attr.needsUpdate = true;
        quad.visible = true;
      } else if (dbg.quad) {
        dbg.quad.visible = false;
      }
    }, 'overheadDebug.quad', Severity.COSMETIC);

    // Update ray line
    safeCall(() => {
      const cam = this.sceneComposer?.camera;
      if (cam) {
        cam.getWorldPosition(_tmpPos);
        const arr = dbg.ray.geometry.attributes.position.array;
        arr[0] = _tmpPos.x;
        arr[1] = _tmpPos.y;
        arr[2] = _tmpPos.z;
        arr[3] = p.x;
        arr[4] = p.y;
        arr[5] = p.z;
        dbg.ray.geometry.attributes.position.needsUpdate = true;
      }
    }, 'overheadDebug.ray', Severity.COSMETIC);

    // Marker color indicates opaque vs transparent pixel
    safeCall(() => {
      const c = opaqueHit ? 0x33ff33 : 0xff3333;
      dbg.marker.material.color.setHex(c);
    }, 'overheadDebug.markerColor', Severity.COSMETIC);

    // Label next to cursor
    safeCall(() => {
      if (dbg.label && event) {
        const tileId = hit?.object?.userData?.foundryTileId;
        const uv = hit?.uv;
        const u = (uv && Number.isFinite(uv.x)) ? uv.x.toFixed(3) : 'n/a';
        const v = (uv && Number.isFinite(uv.y)) ? uv.y.toFixed(3) : 'n/a';
        dbg.label.textContent = `roofHit: ${tileId || 'n/a'}  uv(${u}, ${v})  opaque=${opaqueHit ? '1' : '0'}`;
        dbg.label.style.left = `${event.clientX + 14}px`;
        dbg.label.style.top = `${event.clientY + 14}px`;
        dbg.label.style.display = 'block';
      }
    }, 'overheadDebug.label', Severity.COSMETIC);
  }

  // ── Light outline/preview methods — delegated to LightInteractionHandler ──
  _createSelectedLightOutline() { this.lightHandler.createSelectedLightOutline(); }
  _hideSelectedLightOutline() { this.lightHandler.hideSelectedLightOutline(); }
  _updateSelectedLightOutline() { this.lightHandler.updateSelectedLightOutline(); }
  _computeLightPreviewLocalPolygon(o, r) { return this.lightHandler.computeLightPreviewLocalPolygon(o, r); }
  _updateLightPlacementPreviewGeometry(p, o, r) { this.lightHandler.updateLightPlacementPreviewGeometry(p, o, r); }

  /**
   * Remove any existing drag previews and clear pending cleanup state.
   * @private
   */
  _clearAllDragPreviews() {
    this.destroyDragPreviews();
    this._clearMovementPathPreview();

    if (this._pendingTokenMoveCleanup.timeoutId) {
      clearTimeout(this._pendingTokenMoveCleanup.timeoutId);
      this._pendingTokenMoveCleanup.timeoutId = null;
    }
    this._pendingTokenMoveCleanup.tokenIds.clear();
  }

  /**
   * Called when TokenManager starts moving a token due to an authoritative update.
   * This is the exact moment Foundry would remove the local drag preview.
   * @param {string} tokenId
   * @private
   */
  _onTokenMovementStart(tokenId) {
    if (!tokenId) return;

    // Only clear if we are actually holding a ghost for this token.
    if (this.dragState.previews.has(tokenId) || this._pendingTokenMoveCleanup.tokenIds.has(tokenId)) {
      this._clearAllDragPreviews();
    }
  }

  _isEventFromUI(event) {
    const target = event?.target;
    const path = (event && typeof event.composedPath === 'function') ? event.composedPath() : null;
    const elements = Array.isArray(path)
      ? path.filter((n) => n instanceof Element)
      : (target instanceof Element ? [target] : []);

    // IMPORTANT:
    // We listen on `window` in capture phase, so `event.target` can be unreliable in some
    // cases (e.g. when other frameworks intercept/re-target events). To ensure we never
    // treat UI clicks/drags (FilePicker, Dialogs, etc.) as scene interaction, also inspect
    // the actual element stack under the pointer.
    safeCall(() => {
      const cx = event?.clientX;
      const cy = event?.clientY;
      if (Number.isFinite(cx) && Number.isFinite(cy) && typeof document?.elementsFromPoint === 'function') {
        const stack = document.elementsFromPoint(cx, cy);
        if (Array.isArray(stack) && stack.length) {
          for (const el of stack) {
            if (el instanceof Element) elements.push(el);
          }
        }
      }
    }, 'isOverUI.elementsFromPoint', Severity.COSMETIC);

    for (const el of elements) {
      // Foundry VTT UI windows/dialogs (v11/v12+)
      if (el.closest('.window-app, .app.window-app, .application, dialog, .dialog, .filepicker, #ui, #sidebar, #navigation')) return true;
      if (el.closest('button, a, input, select, textarea, label')) return true;

      if (el.closest('#map-shine-ui, #map-shine-texture-manager, #map-shine-effect-stack, #map-shine-control-panel, #map-shine-loading-overlay')) return true;
      if (el.closest('#map-point-context-menu')) return true;

      // World-anchored overlays live in OverlayUIManager.
      // These must be treated as UI even though we listen on window capture.
      if (el.closest('#map-shine-overlay-root')) return true;
      if (el.closest('[data-overlay-id], .map-shine-overlay-ui')) return true;

      const classList = el.classList;
      if (classList && classList.length) {
        for (const cls of classList) {
          if (typeof cls === 'string' && cls.startsWith('tp-')) return true;
        }
      }
    }

    return false;
  }

  _isTextEditingEvent(event) {
    return safeCall(() => {
      const t = (event?.target instanceof Element) ? event.target : null;
      const active = (document?.activeElement instanceof Element) ? document.activeElement : null;
      const candidates = [t, active].filter(Boolean);
      if (!candidates.length) return false;

      for (const el of candidates) {
        // Standard form controls.
        if (el.closest('input, textarea, select')) return true;

        // Contenteditable regions (some Foundry apps use this for rich text).
        if (el.isContentEditable) return true;

        // Some UI frameworks use role-based textboxes.
        const role = el.getAttribute?.('role');
        if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
      }
      return false;
    }, 'isTextEditingEvent', Severity.COSMETIC, { fallback: false });
  }

  /**
   * Initialize event listeners
   * 
   * NOTE: As of the PIXI-first interaction strategy, most interaction is handled
   * by Foundry's native PIXI layer. The Three.js canvas is render-only.
   * We keep the InteractionManager for:
   * - HUD positioning (updateHUDPosition)
   * - Hover effects on Three.js objects (overhead tiles, tree canopy)
   * - Any future Three.js-specific interaction needs
   */
  initialize() {
    // Use window-level listeners so clicks are seen even if another element
    // (e.g. Foundry overlay) is the immediate target. Actual handling is
    // gated by the InputRouter so we only react when Three.js should
    // receive input.
    window.addEventListener('pointerdown', this.boundHandlers.onPointerDown, { capture: true });
    this.canvasElement.addEventListener('dblclick', this.boundHandlers.onDoubleClick);

    // Prevent the browser's native context menu on the Three.js canvas so
    // right-click interactions (token HUD, click-to-move) aren't interrupted.
    this.canvasElement.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('pointerup', this.boundHandlers.onPointerUp);
    window.addEventListener('pointermove', this.boundHandlers.onPointerMove);
    window.addEventListener('wheel', this.boundHandlers.onWheel, { passive: false });
    window.addEventListener('keydown', this.boundHandlers.onKeyDown, { capture: true });

    // When a token actually starts moving due to the authoritative update,
    // remove the ghost preview so the animated token is visible.
    safeCall(() => this.tokenManager?.addOnTokenMovementStart?.((tokenId) => this._onTokenMovementStart(tokenId)), 'init.wireTokenMovement', Severity.COSMETIC);

    const rect = this.canvasElement.getBoundingClientRect();
    log.info('InteractionManager initialized (Three.js token interaction enabled)', {
      canvasId: this.canvasElement.id,
      width: rect.width,
      height: rect.height
    });
  }

  _consumeKeyEvent(event) {
    safeCall(() => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }, 'consumeKeyEvent', Severity.COSMETIC);
  }

  // ── Selection Box methods — delegated to SelectionBoxHandler ────────────
  createSelectionBox() { this.selectionBoxHandler.createSelectionBox(); }
  createSelectionOverlay() { this.selectionBoxHandler.createSelectionOverlay(); }
  _ensureSelectionPatterns() { this.selectionBoxHandler.ensureSelectionPatterns(); }
  createSelectionShadow() { this.selectionBoxHandler.createSelectionShadow(); }
  _applySelectionOverlayStyles() { this.selectionBoxHandler.applySelectionOverlayStyles(); }
  _updateSelectionOverlayGeometry(w, h) { this.selectionBoxHandler.updateSelectionOverlayGeometry(w, h); }
  _updateSelectionOverlayAnimation(ti) { this.selectionBoxHandler.updateSelectionOverlayAnimation(ti); }
  _applySelectionShadowParams() { this.selectionBoxHandler.applySelectionShadowParams(); }
  _updateSelectionShadowFromDrag() { this.selectionBoxHandler.updateSelectionShadowFromDrag(); }
  _hideSelectionShadow() { this.selectionBoxHandler.hideSelectionShadow(); }
  applySelectionBoxParamChange(id, v) { this.selectionBoxHandler.applyParamChange(id, v); }

  createMovementPathPreviewOverlay() {
    const THREE = window.THREE;
    const scene = this.sceneComposer?.scene;
    if (!THREE || !scene) return;

    const group = new THREE.Group();
    group.name = 'TokenMovementPathPreview';
    group.visible = false;
    group.renderOrder = 25;

    const lineOuter = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
      color: 0x143e78,
      transparent: true,
      opacity: 0.72,
      depthTest: false,
      depthWrite: false
      })
    );
    lineOuter.renderOrder = 26;

    const lineInner = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({
        color: 0x69d2ff,
        transparent: true,
        opacity: 0.95,
        depthTest: false,
        depthWrite: false,
        dashSize: 9,
        gapSize: 6,
        scale: 1
      })
    );
    lineInner.renderOrder = 27;

    const tileGroup = new THREE.Group();
    tileGroup.name = 'TokenMovementPathPreviewTiles';
    tileGroup.renderOrder = 24;

    const ghostGroup = new THREE.Group();
    ghostGroup.name = 'TokenMovementPathPreviewGhosts';
    ghostGroup.renderOrder = 30;

    group.add(lineOuter);
    group.add(lineInner);
    group.add(tileGroup);
    group.add(ghostGroup);
    scene.add(group);

    const labelEl = document.createElement('div');
    labelEl.style.position = 'fixed';
    labelEl.style.pointerEvents = 'none';
    labelEl.style.zIndex = '10000';
    labelEl.style.padding = '2px 7px';
    labelEl.style.borderRadius = '4px';
    labelEl.style.backgroundColor = 'rgba(5, 12, 20, 0.72)';
    labelEl.style.border = '1px solid rgba(88, 180, 255, 0.42)';
    labelEl.style.color = '#d9f1ff';
    labelEl.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    labelEl.style.fontSize = '12px';
    labelEl.style.display = 'none';
    document.body.appendChild(labelEl);

    this.movementPathPreview.group = group;
    this.movementPathPreview.lineOuter = lineOuter;
    this.movementPathPreview.lineInner = lineInner;
    this.movementPathPreview.tileGroup = tileGroup;
    this.movementPathPreview.ghostGroup = ghostGroup;
    this.movementPathPreview.labelEl = labelEl;
  }

  _clearMovementPathPreview() {
    const preview = this.movementPathPreview;
    if (!preview) return;

    preview.active = false;
    preview.currentKey = '';
    preview.pending = null;

    if (preview.group) preview.group.visible = false;

    if (preview.labelEl) {
      preview.labelEl.style.display = 'none';
      preview.labelEl.textContent = '';
    }

    const tileGroup = preview.tileGroup;
    if (tileGroup?.children && tileGroup.children.length > 0) {
      for (let i = tileGroup.children.length - 1; i >= 0; i--) {
        const mesh = tileGroup.children[i];
        tileGroup.remove(mesh);
        safeCall(() => mesh.geometry?.dispose?.(), 'movementPathPreview.disposeTileGeometry', Severity.COSMETIC);
        safeCall(() => mesh.material?.dispose?.(), 'movementPathPreview.disposeTileMaterial', Severity.COSMETIC);
      }
    }

    const ghostGroup = preview.ghostGroup;
    if (ghostGroup?.children && ghostGroup.children.length > 0) {
      for (let i = ghostGroup.children.length - 1; i >= 0; i--) {
        const ghost = ghostGroup.children[i];
        ghostGroup.remove(ghost);
        safeCall(() => ghost.material?.dispose?.(), 'movementPathPreview.disposeGhostMaterial', Severity.COSMETIC);
      }
    }

    const lineOuter = preview.lineOuter;
    if (lineOuter?.geometry) {
      safeCall(() => lineOuter.geometry.dispose?.(), 'movementPathPreview.disposeLineOuterGeometry', Severity.COSMETIC);
      lineOuter.geometry = new window.THREE.BufferGeometry();
    }

    const lineInner = preview.lineInner;
    if (lineInner?.geometry) {
      safeCall(() => lineInner.geometry.dispose?.(), 'movementPathPreview.disposeLineInnerGeometry', Severity.COSMETIC);
      lineInner.geometry = new window.THREE.BufferGeometry();
    }
  }

  _renderMovementPathPreview(pathNodes, totalDistance, tokenDoc = null, groupAssignments = null, renderOptions = {}) {
    const preview = this.movementPathPreview;
    if (!preview?.group || !preview.lineOuter || !preview.lineInner || !Array.isArray(pathNodes) || pathNodes.length < 2) {
      this._clearMovementPathPreview();
      return;
    }

    const showGhosts = renderOptions?.showGhosts !== false;

    const THREE = window.THREE;
    const groundZ = (this.sceneComposer?.groundZ ?? 0) + 0.5;
    const points = [];
    for (const node of pathNodes) {
      const w = Coordinates.toWorld(node.x, node.y);
      points.push(new THREE.Vector3(w.x, w.y, groundZ));
    }

    safeCall(() => preview.lineOuter.geometry?.dispose?.(), 'movementPathPreview.swapLineOuterGeometry', Severity.COSMETIC);
    preview.lineOuter.geometry = new THREE.BufferGeometry().setFromPoints(points);

    safeCall(() => preview.lineInner.geometry?.dispose?.(), 'movementPathPreview.swapLineInnerGeometry', Severity.COSMETIC);
    preview.lineInner.geometry = new THREE.BufferGeometry().setFromPoints(points);
    safeCall(() => preview.lineInner.computeLineDistances?.(), 'movementPathPreview.computeLineDistances', Severity.COSMETIC);

    // Remove previous tile highlights.
    const tileGroup = preview.tileGroup;
    for (let i = tileGroup.children.length - 1; i >= 0; i--) {
      const mesh = tileGroup.children[i];
      tileGroup.remove(mesh);
      safeCall(() => mesh.geometry?.dispose?.(), 'movementPathPreview.removeOldTileGeometry', Severity.COSMETIC);
      safeCall(() => mesh.material?.dispose?.(), 'movementPathPreview.removeOldTileMaterial', Severity.COSMETIC);
    }

    const grid = canvas?.grid;
    const gridSize = Math.max(1, Number(grid?.size || canvas?.dimensions?.size || 100));
    const tileW = Math.max(8, Number(grid?.sizeX || gridSize));
    const tileH = Math.max(8, Number(grid?.sizeY || gridSize));

    const seen = new Set();
    for (let i = 1; i < pathNodes.length; i++) {
      const p = pathNodes[i];
      const key = `${Math.round(Number(p?.x || 0))}:${Math.round(Number(p?.y || 0))}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const world = Coordinates.toWorld(p.x, p.y);
      const tile = new THREE.Mesh(
        new THREE.PlaneGeometry(tileW * 0.92, tileH * 0.92),
        new THREE.MeshBasicMaterial({
          color: 0x3f86ff,
          transparent: true,
          opacity: 0.25,
          depthTest: false,
          depthWrite: false
        })
      );
      tile.position.set(world.x, world.y, groundZ - 0.005);
      tile.renderOrder = 24;
      tileGroup.add(tile);
    }

    const ghostGroup = preview.ghostGroup;
    for (let i = (ghostGroup?.children?.length || 0) - 1; i >= 0; i--) {
      const ghost = ghostGroup.children[i];
      ghostGroup.remove(ghost);
      safeCall(() => ghost.material?.dispose?.(), 'movementPathPreview.removeOldGhostMaterial', Severity.COSMETIC);
    }

    // Destination ghost token(s) (50% opacity) to show final stop positions.
    // Token drag previews can disable this so only one token ghost is shown.
    if (showGhosts) {
      safeCall(() => {
        if (!ghostGroup) return;

        /**
         * @param {TokenDocument|object} doc
         * @param {{x:number,y:number}} endFoundryCenter
         */
        const addGhost = (doc, endFoundryCenter) => {
          if (!doc || !endFoundryCenter) return;
          const tokenData = doc?.id ? this.tokenManager?.tokenSprites?.get?.(doc.id) : null;
          const sourceSprite = tokenData?.sprite;
          if (!sourceSprite) return;

          const tex = sourceSprite.material?.map || sourceSprite.userData?.texture || null;
          if (!tex) return;

          const ghost = new THREE.Sprite(new THREE.SpriteMaterial({
            map: tex,
            transparent: true,
            opacity: 0.5,
            depthTest: false,
            depthWrite: false
          }));
          const endWorld = Coordinates.toWorld(endFoundryCenter.x, endFoundryCenter.y);
          const srcScale = sourceSprite.scale;
          ghost.scale.set(srcScale?.x ?? 100, srcScale?.y ?? 100, srcScale?.z ?? 1);
          ghost.position.set(endWorld.x, endWorld.y, (this.sceneComposer?.groundZ ?? 0) + 2.0);
          ghost.renderOrder = 30;
          ghostGroup.add(ghost);
        };

        if (Array.isArray(groupAssignments) && groupAssignments.length > 1) {
          for (const assignment of groupAssignments) {
            const tokenId = String(assignment?.tokenId || '');
            if (!tokenId) continue;
            const doc = this.tokenManager?.tokenSprites?.get?.(tokenId)?.tokenDoc || (tokenDoc?.id === tokenId ? tokenDoc : null);
            if (!doc) continue;

            const endFoundry = Array.isArray(assignment?.pathNodes) && assignment.pathNodes.length > 0
              ? assignment.pathNodes[assignment.pathNodes.length - 1]
              : this._tokenTopLeftToCenterFoundry(assignment?.destinationTopLeft, doc);
            addGhost(doc, endFoundry);
          }
        } else {
          const doc = tokenDoc || this._getPrimarySelectedTokenDoc();
          const endFoundry = pathNodes[pathNodes.length - 1];
          addGhost(doc, endFoundry);
        }
      }, 'movementPathPreview.ghost', Severity.COSMETIC);
    }

    preview.group.visible = true;
    preview.active = true;

    const labelEl = preview.labelEl;
    if (labelEl) {
      const units = canvas?.grid?.units || canvas?.scene?.grid?.units || '';
      const dist = Number.isFinite(totalDistance) ? totalDistance : 0;
      const pxPerGrid = Number(canvas?.dimensions?.size || 100);
      const unitsPerGrid = Number(canvas?.dimensions?.distance || 1);
      const distanceInUnits = (dist / Math.max(1, pxPerGrid)) * unitsPerGrid;
      const distLabel = Number.isFinite(distanceInUnits) ? distanceInUnits.toFixed(1) : '0.0';
      labelEl.textContent = units ? `${distLabel} ${units}` : distLabel;

      const last = points[points.length - 1];
      const screen = this._worldToClient(last);
      if (screen) {
        labelEl.style.left = `${screen.x + 10}px`;
        labelEl.style.top = `${screen.y - 24}px`;
        labelEl.style.display = 'block';
      } else {
        labelEl.style.display = 'none';
      }
    }
  }

  _worldToClient(worldVec3) {
    const camera = this.sceneComposer?.camera;
    if (!camera || !worldVec3) return null;
    const projected = worldVec3.clone().project(camera);
    if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y)) return null;

    const rect = this._getCanvasRectCached();
    return {
      x: ((projected.x + 1) * 0.5 * rect.width) + rect.left,
      y: ((-projected.y + 1) * 0.5 * rect.height) + rect.top
    };
  }

  _getTokenPixelSize(tokenDoc) {
    const grid = canvas?.grid;
    const gridSizeX = Math.max(1, Number(grid?.sizeX || grid?.size || canvas?.dimensions?.size || 100));
    const gridSizeY = Math.max(1, Number(grid?.sizeY || grid?.size || canvas?.dimensions?.size || 100));
    const wUnits = Math.max(1, Number(tokenDoc?.width || 1));
    const hUnits = Math.max(1, Number(tokenDoc?.height || 1));
    return { w: wUnits * gridSizeX, h: hUnits * gridSizeY };
  }

  _tokenCenterToTopLeftFoundry(centerPoint, tokenDoc) {
    const size = this._getTokenPixelSize(tokenDoc);
    return {
      x: Number(centerPoint?.x || 0) - (size.w * 0.5),
      y: Number(centerPoint?.y || 0) - (size.h * 0.5)
    };
  }

  _tokenTopLeftToCenterFoundry(topLeft, tokenDoc) {
    const size = this._getTokenPixelSize(tokenDoc);
    return {
      x: Number(topLeft?.x || 0) + (size.w * 0.5),
      y: Number(topLeft?.y || 0) + (size.h * 0.5)
    };
  }

  _snapTokenTopLeftToGrid(tokenDoc, topLeft) {
    const x = Number(topLeft?.x || 0);
    const y = Number(topLeft?.y || 0);
    const grid = canvas?.grid;
    const gridTypes = globalThis.CONST?.GRID_TYPES || {};
    const isGridless = !!(grid && grid.type === gridTypes.GRIDLESS);
    if (!grid || isGridless || typeof grid.getSnappedPoint !== 'function') {
      return { x, y };
    }

    const center = {
      x: x + (this._getTokenPixelSize(tokenDoc).w * 0.5),
      y: y + (this._getTokenPixelSize(tokenDoc).h * 0.5)
    };

    try {
      const mode = globalThis.CONST?.GRID_SNAPPING_MODES?.CENTER;
      const snappedCenter = (mode !== undefined)
        ? grid.getSnappedPoint(center, { mode })
        : grid.getSnappedPoint(center);
      return this._tokenCenterToTopLeftFoundry(snappedCenter, tokenDoc);
    } catch (_) {
      return { x, y };
    }
  }

  _getUnconstrainedMovementEnabled() {
    return !!(
      game?.user?.isGM &&
      game?.settings?.get?.('core', 'unconstrainedMovement')
    );
  }

  _pathfindingLog(level, message, details = null, error = null) {
    const method = (typeof log?.[level] === 'function') ? log[level].bind(log) : log.info.bind(log);
    const taggedMessage = `[Pathfinding] ${message}`;
    if (details && error) {
      method(taggedMessage, details, error);
      return;
    }
    if (error) {
      method(taggedMessage, error);
      return;
    }
    if (details) {
      method(taggedMessage, details);
      return;
    }
    method(taggedMessage);
  }

  _getClickToMoveButton() {
    const leftClickMode = !!game?.settings?.get?.('map-shine-advanced', 'leftClickMoveEnabled');
    return leftClickMode ? 0 : 2;
  }

  _resetMoveClickState() {
    this.moveClickState.active = false;
    this.moveClickState.button = 2;
    this.moveClickState.tokenDoc = null;
    this.moveClickState.tokenDocs = null;
    this.moveClickState.worldPos = null;
  }

  _armMoveClickState({ button, tokenDoc, tokenDocs, worldPos, clientX, clientY }) {
    this.moveClickState.active = true;
    this.moveClickState.button = Number.isFinite(Number(button)) ? Number(button) : 2;
    this.moveClickState.tokenDoc = tokenDoc || null;
    this.moveClickState.tokenDocs = Array.isArray(tokenDocs) ? tokenDocs.filter(Boolean) : (tokenDoc ? [tokenDoc] : null);
    this.moveClickState.worldPos = worldPos ? {
      x: Number(worldPos.x || 0),
      y: Number(worldPos.y || 0),
      z: Number(worldPos.z || 0)
    } : null;
    this.moveClickState.startPos.set(Number(clientX || 0), Number(clientY || 0));
  }

  _getPrimarySelectedTokenDoc() {
    for (const id of this.selection) {
      const tokenData = this.tokenManager?.tokenSprites?.get?.(id);
      if (tokenData?.tokenDoc) return tokenData.tokenDoc;
    }

    const controlled = canvas?.tokens?.controlled;
    const controlledToken = (Array.isArray(controlled) && controlled.length > 0) ? controlled[0] : null;
    return controlledToken?.document || null;
  }

  _getSelectedTokenDocs() {
    const docs = [];
    const seen = new Set();

    for (const id of this.selection) {
      const tokenDoc = this.tokenManager?.tokenSprites?.get?.(id)?.tokenDoc;
      const tokenId = String(tokenDoc?.id || '');
      if (!tokenId || seen.has(tokenId)) continue;
      seen.add(tokenId);
      docs.push(tokenDoc);
    }

    if (docs.length === 0) {
      const controlled = canvas?.tokens?.controlled;
      if (Array.isArray(controlled)) {
        for (const token of controlled) {
          const tokenDoc = token?.document;
          const tokenId = String(tokenDoc?.id || '');
          if (!tokenId || seen.has(tokenId)) continue;
          seen.add(tokenId);
          docs.push(tokenDoc);
        }
      }
    }

    return docs;
  }

  _buildTokenSelectionKey(tokenDocs) {
    if (!Array.isArray(tokenDocs) || tokenDocs.length === 0) return '';
    return tokenDocs
      .map((doc) => String(doc?.id || ''))
      .filter((id) => id.length > 0)
      .sort()
      .join('|');
  }

  _buildMovePreviewKey(tokenId, destinationTopLeft) {
    return `${String(tokenId || '')}:${Math.round(Number(destinationTopLeft?.x || 0))}:${Math.round(Number(destinationTopLeft?.y || 0))}`;
  }

  _applyMovementPreviewResult(previewResult, key, tokenDoc = null, renderOptions = {}) {
    if (!previewResult?.ok || !Array.isArray(previewResult.pathNodes) || previewResult.pathNodes.length < 2) {
      this._clearMovementPathPreview();
      return;
    }
    this.movementPathPreview.currentKey = key;
    this._renderMovementPathPreview(previewResult.pathNodes, previewResult.distance || 0, tokenDoc, null, renderOptions);
  }

  _applyGroupMovementPreviewResult(previewResult, key, leaderTokenDoc = null) {
    const assignments = Array.isArray(previewResult?.assignments) ? previewResult.assignments : [];
    if (!previewResult?.ok || assignments.length === 0) {
      this._clearMovementPathPreview();
      return;
    }

    const leaderId = String(leaderTokenDoc?.id || '');
    const leaderAssignment = assignments.find((a) => String(a?.tokenId || '') === leaderId) || assignments[0];
    const leaderPath = Array.isArray(leaderAssignment?.pathNodes) ? leaderAssignment.pathNodes : [];
    if (leaderPath.length < 2) {
      this._clearMovementPathPreview();
      return;
    }

    // Compute actual walk distance along the leader's path (sum of segment
    // lengths) instead of the weighted assignment cost which mixes anchor
    // offset, path length, and formation offset into a single score.
    let walkDistance = 0;
    for (let i = 1; i < leaderPath.length; i++) {
      const a = leaderPath[i - 1];
      const b = leaderPath[i];
      walkDistance += Math.hypot(
        Number(b?.x || 0) - Number(a?.x || 0),
        Number(b?.y || 0) - Number(a?.y || 0)
      );
    }

    this.movementPathPreview.currentKey = key;
    this._renderMovementPathPreview(
      leaderPath,
      walkDistance,
      leaderTokenDoc,
      assignments
    );
  }

  _updateTokenDragPathPreview() {
    const leaderId = this.dragState?.leaderId;
    if (!leaderId) {
      this._clearMovementPathPreview();
      return;
    }

    const tokenData = this.tokenManager?.tokenSprites?.get?.(leaderId);
    const tokenDoc = tokenData?.tokenDoc;
    const leaderPreview = this.dragState?.previews?.get?.(leaderId);
    if (!tokenDoc || !leaderPreview) {
      this._clearMovementPathPreview();
      return;
    }

    const foundryCenter = Coordinates.toFoundry(leaderPreview.position.x, leaderPreview.position.y);
    const rawTopLeft = this._tokenCenterToTopLeftFoundry(foundryCenter, tokenDoc);
    const destinationTopLeft = this._snapTokenTopLeftToGrid(tokenDoc, rawTopLeft);
    const key = this._buildMovePreviewKey(tokenDoc.id, destinationTopLeft);

    if (this.movementPathPreview.currentKey === key && this.movementPathPreview.active) return;

    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const shouldDefer = (now - this.movementPathPreview.lastUpdateMs) < this.movementPathPreview.updateIntervalMs;
    if (this.movementPathPreview.inFlight || shouldDefer) {
      this.movementPathPreview.pending = { tokenDoc, destinationTopLeft, key };
      return;
    }

    this.movementPathPreview.inFlight = true;
    this.movementPathPreview.lastUpdateMs = now;

    const movementManager = window.MapShine?.tokenMovementManager;
    const previewResult = movementManager?.computeTokenPathPreview?.({
      tokenDoc,
      destinationTopLeft,
      options: {
        ignoreWalls: this._getUnconstrainedMovementEnabled(),
        ignoreCost: this._getUnconstrainedMovementEnabled()
      }
    });

    const isFlyingToken = !!movementManager?.isFlying?.(tokenDoc.id);

    this._applyMovementPreviewResult(previewResult, key, tokenDoc, {
      showGhosts: !isFlyingToken
    });

    this.movementPathPreview.inFlight = false;
    const pending = this.movementPathPreview.pending;
    this.movementPathPreview.pending = null;
    if (pending) {
      this.movementPathPreview.currentKey = '';
      this._updateTokenDragPathPreview();
    }
  }

  async _executeTokenMoveToTopLeft(tokenDoc, destinationTopLeft, { method = 'dragging' } = {}) {
    try {
      if (!tokenDoc || !destinationTopLeft) {
        this._pathfindingLog('warn', '_executeTokenMoveToTopLeft blocked: invalid move request', {
          tokenId: String(tokenDoc?.id || ''),
          destinationTopLeft,
          method
        });
        return { ok: false, reason: 'invalid-move-request' };
      }

      const unconstrainedMovement = this._getUnconstrainedMovementEnabled();
      const movementManager = window.MapShine?.tokenMovementManager;
      if (movementManager && typeof movementManager.executeDoorAwareTokenMove === 'function') {
        const sequencedResult = await movementManager.executeDoorAwareTokenMove({
          tokenDoc,
          destinationTopLeft,
          options: {
            method,
            ignoreWalls: unconstrainedMovement,
            ignoreCost: unconstrainedMovement,
            includeMovementPayload: unconstrainedMovement,
            suppressFoundryMovementUI: !unconstrainedMovement,
            updateOptions: {}
          }
        });
        if (!sequencedResult?.ok) {
          this._pathfindingLog('warn', '_executeTokenMoveToTopLeft sequenced move failed', {
            tokenId: String(tokenDoc?.id || ''),
            destinationTopLeft,
            reason: sequencedResult?.reason || 'door-aware-token-move-failed',
            method,
            unconstrainedMovement
          });
        }
        return sequencedResult;
      }

      await canvas?.scene?.updateEmbeddedDocuments?.('Token', [{ _id: tokenDoc.id, x: destinationTopLeft.x, y: destinationTopLeft.y }]);
      return { ok: true };
    } catch (error) {
      this._pathfindingLog('error', '_executeTokenMoveToTopLeft threw unexpectedly', {
        tokenId: String(tokenDoc?.id || ''),
        destinationTopLeft,
        method
      }, error);
      return { ok: false, reason: 'token-move-exception' };
    }
  }

  async _executeTokenGroupMoveToTopLeft(leaderTokenDoc, leaderDestinationTopLeft, tokenDocs, { method = 'path-walk', groupPlanCacheKey = '' } = {}) {
    try {
      if (!leaderTokenDoc || !leaderDestinationTopLeft) {
        this._pathfindingLog('warn', '_executeTokenGroupMoveToTopLeft blocked: invalid group move request', {
          leaderTokenId: String(leaderTokenDoc?.id || ''),
          leaderDestinationTopLeft,
          method
        });
        return { ok: false, reason: 'invalid-group-move-request' };
      }

      const docs = Array.isArray(tokenDocs) ? tokenDocs.filter(Boolean) : [];
      if (docs.length <= 1) {
        return this._executeTokenMoveToTopLeft(leaderTokenDoc, leaderDestinationTopLeft, { method });
      }

      const byId = new Map();
      const leaderId = String(leaderTokenDoc?.id || '');
      for (const doc of docs) {
        const id = String(doc?.id || '');
        if (!id) continue;
        byId.set(id, doc);
      }
      if (leaderId && !byId.has(leaderId)) byId.set(leaderId, leaderTokenDoc);

      const tokenMoves = [...byId.values()].map((doc) => ({
        tokenDoc: doc,
        destinationTopLeft: {
          // Right-click group move is "cluster-to-point" behavior:
          // all selected tokens share a common target anchor, and the group
          // assignment solver places each token in the nearest valid non-overlapping
          // cell around this anchor while respecting wall/path constraints.
          x: Number(leaderDestinationTopLeft.x || 0),
          y: Number(leaderDestinationTopLeft.y || 0)
        }
      }));

      const unconstrainedMovement = this._getUnconstrainedMovementEnabled();
      const movementManager = window.MapShine?.tokenMovementManager;
      if (movementManager && typeof movementManager.executeDoorAwareGroupMove === 'function') {
        const groupResult = await movementManager.executeDoorAwareGroupMove({
          tokenMoves,
          options: {
            method,
            ignoreWalls: unconstrainedMovement,
            ignoreCost: unconstrainedMovement,
            includeMovementPayload: unconstrainedMovement,
            groupAnchorTokenId: leaderId,
            groupAnchorTopLeft: {
              x: Number(leaderDestinationTopLeft.x || 0),
              y: Number(leaderDestinationTopLeft.y || 0)
            },
            enforceAnchorSide: true,
            groupPlanCacheKey: String(groupPlanCacheKey || ''),
            suppressFoundryMovementUI: !unconstrainedMovement,
            updateOptions: {}
          }
        });
        if (!groupResult?.ok) {
          this._pathfindingLog('warn', '_executeTokenGroupMoveToTopLeft sequenced group move failed', {
            leaderTokenId: leaderId,
            tokenCount: tokenMoves.length,
            destinationTopLeft: leaderDestinationTopLeft,
            reason: groupResult?.reason || 'door-aware-group-move-failed',
            diagnostics: groupResult?.diagnostics || null,
            method,
            unconstrainedMovement
          });
        }
        return groupResult;
      }

      const results = await Promise.all(tokenMoves.map((move) => this._executeTokenMoveToTopLeft(move.tokenDoc, move.destinationTopLeft, { method })));
      const failed = results.find((result) => !result?.ok);
      if (failed) {
        this._pathfindingLog('warn', '_executeTokenGroupMoveToTopLeft fallback move failed', {
          leaderTokenId: leaderId,
          tokenCount: tokenMoves.length,
          destinationTopLeft: leaderDestinationTopLeft,
          reason: failed?.reason || 'group-fallback-move-failed',
          method
        });
        return { ok: false, reason: failed?.reason || 'group-fallback-move-failed' };
      }
      return { ok: true, tokenCount: tokenMoves.length };
    } catch (error) {
      this._pathfindingLog('error', '_executeTokenGroupMoveToTopLeft threw unexpectedly', {
        leaderTokenId: String(leaderTokenDoc?.id || ''),
        leaderDestinationTopLeft,
        tokenCount: Array.isArray(tokenDocs) ? tokenDocs.length : 0,
        method
      }, error);
      return { ok: false, reason: 'group-move-exception' };
    }
  }

  async _handleRightClickMovePreview(tokenDoc, worldPos, tokenDocs = null) {
    try {
      const movementManager = window.MapShine?.tokenMovementManager;
      if (!tokenDoc || !movementManager?.computeTokenPathPreview) {
        this._pathfindingLog('warn', '_handleRightClickMovePreview blocked: missing token or pathfinding manager', {
          tokenId: String(tokenDoc?.id || ''),
          hasManager: !!movementManager,
          hasPreviewApi: !!movementManager?.computeTokenPathPreview,
          worldPos
        });
        return;
      }

      const selectedTokenDocs = Array.isArray(tokenDocs) && tokenDocs.length > 0
        ? tokenDocs.filter(Boolean)
        : [tokenDoc];
      const selectionKey = this._buildTokenSelectionKey(selectedTokenDocs);

      const foundryCenter = Coordinates.toFoundry(worldPos.x, worldPos.y);
      const rawTopLeft = this._tokenCenterToTopLeftFoundry(foundryCenter, tokenDoc);
      const destinationTopLeft = this._snapTokenTopLeftToGrid(tokenDoc, rawTopLeft);
      const tileKey = this._buildMovePreviewKey(tokenDoc.id, destinationTopLeft);

      const immediateMove = !!game?.settings?.get?.('map-shine-advanced', 'rightClickMoveImmediate');
      const isConfirmClick = this.rightClickMovePreview.active
        && this.rightClickMovePreview.tokenId === tokenDoc.id
        && this.rightClickMovePreview.tileKey === tileKey
        && this.rightClickMovePreview.selectionKey === selectionKey;

      const unconstrainedMovement = this._getUnconstrainedMovementEnabled();
      const isGroup = selectedTokenDocs.length > 1;

      let previewResult;
      if (isGroup && typeof movementManager?.computeDoorAwareGroupMovePreview === 'function') {
        const tokenMoves = selectedTokenDocs.map((doc) => ({
          tokenDoc: doc,
          destinationTopLeft: {
            x: Number(destinationTopLeft.x || 0),
            y: Number(destinationTopLeft.y || 0)
          }
        }));

        previewResult = movementManager.computeDoorAwareGroupMovePreview({
          tokenMoves,
          options: {
            ignoreWalls: unconstrainedMovement,
            ignoreCost: unconstrainedMovement,
            groupAnchorTokenId: String(tokenDoc?.id || ''),
            groupAnchorTopLeft: {
              x: Number(destinationTopLeft.x || 0),
              y: Number(destinationTopLeft.y || 0)
            },
            enforceAnchorSide: true
          }
        });
        this._applyGroupMovementPreviewResult(previewResult, tileKey, tokenDoc);
      } else {
        previewResult = movementManager.computeTokenPathPreview({
          tokenDoc,
          destinationTopLeft,
          options: {
            ignoreWalls: unconstrainedMovement,
            ignoreCost: unconstrainedMovement
          }
        });
        this._applyMovementPreviewResult(previewResult, tileKey, tokenDoc);
      }

      if (!previewResult?.ok) {
        this._pathfindingLog('warn', '_handleRightClickMovePreview preview failed', {
          tokenId: String(tokenDoc?.id || ''),
          selectionKey,
          selectedTokenCount: selectedTokenDocs.length,
          destinationTopLeft,
          tileKey,
          reason: previewResult?.reason || 'preview-failed',
          immediateMove,
          isConfirmClick,
          isGroup
        });
        this.rightClickMovePreview.active = false;
        this.rightClickMovePreview.tokenId = null;
        this.rightClickMovePreview.tileKey = '';
        this.rightClickMovePreview.destinationTopLeft = null;
        this.rightClickMovePreview.selectionKey = '';
        this.rightClickMovePreview.groupPlanCacheKey = '';
        return;
      }

      this.rightClickMovePreview.active = true;
      this.rightClickMovePreview.tokenId = tokenDoc.id;
      this.rightClickMovePreview.tileKey = tileKey;
      this.rightClickMovePreview.destinationTopLeft = destinationTopLeft;
      this.rightClickMovePreview.selectionKey = selectionKey;
      this.rightClickMovePreview.groupPlanCacheKey = String(previewResult?.groupPlanCacheKey || '');

      if (!immediateMove && this.rightClickMovePreview.active && !isConfirmClick) {
        this._pathfindingLog('warn', '_handleRightClickMovePreview waiting for confirmation click', {
          tokenId: String(tokenDoc?.id || ''),
          tileKey,
          selectionKey,
          expectedTileKey: this.rightClickMovePreview.tileKey,
          expectedSelectionKey: this.rightClickMovePreview.selectionKey,
          selectedTokenCount: selectedTokenDocs.length,
          destinationTopLeft
        });
      }

      if (immediateMove || isConfirmClick) {
        // Preview visuals are for planning only; hide before the token starts stepping.
        this._clearMovementPathPreview();

        const moveResult = await this._executeTokenGroupMoveToTopLeft(tokenDoc, destinationTopLeft, selectedTokenDocs, {
          method: 'path-walk',
          groupPlanCacheKey: this.rightClickMovePreview.groupPlanCacheKey
        });
        if (!moveResult?.ok) {
          this._pathfindingLog('warn', '_handleRightClickMovePreview move execution failed', {
            tokenId: String(tokenDoc?.id || ''),
            selectionKey,
            selectedTokenCount: selectedTokenDocs.length,
            destinationTopLeft,
            tileKey,
            reason: moveResult?.reason || 'group-move-failed',
            diagnostics: moveResult?.diagnostics || null,
            immediateMove,
            isConfirmClick,
            isGroup
          });
        }
        this.rightClickMovePreview.active = false;
        this.rightClickMovePreview.tokenId = null;
        this.rightClickMovePreview.tileKey = '';
        this.rightClickMovePreview.destinationTopLeft = null;
        this.rightClickMovePreview.selectionKey = '';
        this.rightClickMovePreview.groupPlanCacheKey = '';
      }
    } catch (error) {
      this._pathfindingLog('error', '_handleRightClickMovePreview threw unexpectedly', {
        tokenId: String(tokenDoc?.id || ''),
        selectedTokenCount: Array.isArray(tokenDocs) ? tokenDocs.length : (tokenDoc ? 1 : 0),
        worldPos
      }, error);
      this.rightClickMovePreview.active = false;
      this.rightClickMovePreview.tokenId = null;
      this.rightClickMovePreview.tileKey = '';
      this.rightClickMovePreview.destinationTopLeft = null;
      this.rightClickMovePreview.selectionKey = '';
      this.rightClickMovePreview.groupPlanCacheKey = '';
      this._clearMovementPathPreview();
    }
  }

  createUIHoverLabelOverlay() { this.lightHandler.createUIHoverLabelOverlay(); }

  // ── Light UI/slider/query methods — delegated to LightInteractionHandler ──
  createRadiusSliderOverlay() { this.lightHandler.createRadiusSliderOverlay(); }
  _sceneUnitsPerPixel() { return this.lightHandler.sceneUnitsPerPixel(); }
  _getSelectedLightRadiiInSceneUnits(sel) { return this.lightHandler.getSelectedLightRadiiInSceneUnits(sel); }
  _getSelectedLights() { return this.lightHandler.getSelectedLights(); }
  async _commitRadiiSceneUnits(sel, d, b) { return this.lightHandler.commitRadiiSceneUnits(sel, d, b); }
  async _applyRadiusFromSlidersLive() { return this.lightHandler.applyRadiusFromSlidersLive(); }
  _showUIHoverLabel(t, x, y) { this.lightHandler.showUIHoverLabel(t, x, y); }
  _hideUIHoverLabel() { this.lightHandler.hideUIHoverLabel(); }
  createLightPreview() { this.lightHandler.createLightPreview(); }

  /**
   * Start map point drawing mode
   * @param {string} effectTarget - Effect key (e.g., 'smellyFlies', 'fire')
   * @param {'point'|'area'|'line'|'rope'} [groupType='area'] - Type of group to create
   * @param {boolean} [snapToGrid=false] - Whether to snap to grid by default
   * @param {{ropeType?: 'rope'|'chain'}|null} [options=null] - Optional draw options
   */
  startMapPointDrawing(effectTarget, groupType = 'area', snapToGrid = false, options = null) {
    this.mapPointDrawHandler.start(effectTarget, groupType, snapToGrid, options);
  }

  /**
   * Cancel map point drawing mode
   */
  cancelMapPointDrawing() {
    this.mapPointDrawHandler.cancel();
  }

  /** @deprecated Delegate to mapPointDrawHandler.finish() */
  async _finishMapPointDrawing() { return this.mapPointDrawHandler.finish(); }

  /** @deprecated Delegate to mapPointDrawHandler.getLastEffectTarget() */
  getLastEffectTarget() { return this.mapPointDrawHandler.getLastEffectTarget(); }

  /** @deprecated Delegate to mapPointDrawHandler.startAddPointsToGroup() */
  startAddPointsToGroup(groupId) { this.mapPointDrawHandler.startAddPointsToGroup(groupId); }

  /**
   * Create drag previews for selected tokens
   * @private
   */
  createDragPreviews() {
    this.dragState.previews.clear();

    const THREE = window.THREE;
    const _tmpPos = new THREE.Vector3();
    const _tmpQuat = new THREE.Quaternion();
    const groundDragZ = (this.sceneComposer?.groundZ ?? 0) + 3.0;
    
    for (const id of this.selection) {
      // Check Token
      const tokenData = this.tokenManager.tokenSprites.get(id);
      if (tokenData && tokenData.sprite) {
        const original = tokenData.sprite;
        const preview = original.clone();
        const movementManager = window.MapShine?.tokenMovementManager;
        const isFlyingToken = !!movementManager?.isFlying?.(id);

        // Previews must update their matrix as we drag them.
        preview.matrixAutoUpdate = true;
        // Flying drags should preview the landing tile, not current flight height.
        // Non-flying drags keep the existing slight z offset behavior.
        preview.position.z = isFlyingToken
          ? (groundDragZ + 0.01)
          : ((preview.position.z ?? 0) + 0.01);
        // Ensure it's drawn above the original even if depth is enabled elsewhere.
        preview.renderOrder = 9998;
        
        if (original.material) {
          preview.material = original.material.clone();
          preview.material.opacity = 0.5;
          preview.material.transparent = true;

          // Render on top; this is purely a UX overlay.
          preview.material.depthTest = false;
          preview.material.depthWrite = false;
        }
        
        if (this.sceneComposer.scene) {
          this.sceneComposer.scene.add(preview);
        }
        
        this.dragState.previews.set(id, preview);
        continue;
      }

      // Check Foundry Light
      if (this.lightIconManager && this.lightIconManager.lights.has(id)) {
          const original = this.lightIconManager.lights.get(id);
          const preview = original.clone();

          preview.matrixAutoUpdate = true;

          // Preserve the icon's world transform (the original sprite is parented under a
          // group with a Z offset; cloning and adding to the root scene loses that offset).
          safeCall(() => {
            original.getWorldPosition(_tmpPos);
            original.getWorldQuaternion(_tmpQuat);
            preview.position.copy(_tmpPos);
            preview.quaternion.copy(_tmpQuat);
          }, 'dragPreview.copyTransform', Severity.COSMETIC);

          preview.position.z = (preview.position.z ?? 0) + 0.01;
          preview.renderOrder = 9998;

          // Preserve radius metadata for LOS refresh (clone should copy userData, but be explicit).
          safeCall(() => {
            if (originalRoot?.userData && Object.prototype.hasOwnProperty.call(originalRoot.userData, 'radiusPixels')) {
              preview.userData = preview.userData || {};
              preview.userData.radiusPixels = originalRoot.userData.radiusPixels;
            }
          }, 'dragPreview.copyRadius', Severity.COSMETIC);

          if (original.material) {
              preview.material = original.material.clone();
              preview.material.opacity = 0.5;
              preview.material.transparent = true;

              preview.material.depthTest = false;
              preview.material.depthWrite = false;
          }

          if (this.sceneComposer.scene) {
              this.sceneComposer.scene.add(preview);
          }

          this.dragState.previews.set(id, preview);
          continue;
      }

      // Check MapShine Enhanced Light
      const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
      if (enhancedLightIconManager && enhancedLightIconManager.lights.has(id)) {
          const originalRoot = enhancedLightIconManager.getRootObject?.(id) || enhancedLightIconManager.lights.get(id);
          if (!originalRoot) continue;

          const preview = originalRoot.clone(true);

          preview.matrixAutoUpdate = true;

          // Preserve the gizmo's world transform (the original group is parented under a
          // manager group with a Z offset; cloning and adding to the root scene loses that offset).
          safeCall(() => {
            originalRoot.getWorldPosition(_tmpPos);
            originalRoot.getWorldQuaternion(_tmpQuat);
            preview.position.copy(_tmpPos);
            preview.quaternion.copy(_tmpQuat);
          }, 'dragPreview.enhancedCopyTransform', Severity.COSMETIC);

          preview.position.z = (preview.position.z ?? 0) + 0.01;
          preview.renderOrder = 9998;

          // Make materials semi-transparent and render on top.
          preview.traverse?.((obj) => {
            safeCall(() => {
              if (obj?.material) {
                obj.material = obj.material.clone();
                obj.material.transparent = true;
                obj.material.depthTest = false;
                obj.material.depthWrite = false;

                // IMPORTANT: Do not render any radius fill in the preview clone.
                // Even a small opacity produces a white "wash" that reads as
                // the light getting brighter only while dragging.
                if (obj?.userData?.type === 'enhancedLightRadiusFill') {
                  obj.material.opacity = 0.0;
                  obj.visible = false;
                } else if (obj?.userData?.type === 'enhancedLightRadiusBorder') {
                  // Keep outline neutral + constant.
                  obj.material.opacity = 0.35;
                } else {
                  // Icon and any other helper meshes.
                  obj.material.opacity = 0.8;
                }
              }
            }, 'dragPreview.cloneMaterial', Severity.COSMETIC);
          });

          if (this.sceneComposer.scene) {
            this.sceneComposer.scene.add(preview);
          }

          this.dragState.previews.set(id, preview);
          continue;
      }
    }
  }

  /**
   * Destroy drag previews
   * @private
   */
  destroyDragPreviews() {
    for (const preview of this.dragState.previews.values()) {
      if (preview.parent) {
        preview.parent.remove(preview);
      }
      if (preview.material) {
        preview.material.dispose();
      }
      // Don't dispose geometry if shared, but sprite geometry is usually standard plane
    }
    this.dragState.previews.clear();
  }

  /**
   * Handle double click (open sheet)
   * @param {MouseEvent} event 
   */
  onDoubleClick(event) {
    try {
        if (this._isEventFromUI(event)) return;

        // Handle Map Point Drawing Mode - double-click finishes drawing
        if (this.mapPointDraw.active) {
          this.mapPointDrawHandler.finish();
          event.preventDefault();
          return;
        }

        // Get mouse position in NDC
        this.updateMouseCoords(event);
        this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);

        // 1. Check Walls
        // ... existing wall code ...

        // 1.5 Check Lights (Lighting Layer)
        // Open the light editor UI on selection. Hold Alt (or Ctrl/Cmd) to force the Foundry sheet.
        const _layerName = canvas.activeLayer?.name;
        const _isLightingLayer = (_layerName === 'LightingLayer' || _layerName === 'lighting');
        if (_isLightingLayer && this.lightIconManager) {
            const lightIcons = Array.from(this.lightIconManager.lights.values());
            const intersects = this.raycaster.intersectObjects(lightIcons, false);
            if (intersects.length > 0) {
                const hit = intersects[0];
                const sprite = hit.object;
                const lightId = sprite.userData.lightId;
                const light = canvas.lighting.get(lightId);
                
                if (light && light.document.testUserPermission(game.user, "LIMITED")) {
                    const forceSheet = !!(event.altKey || event.ctrlKey || event.metaKey);
                    const lightEditor = window.MapShine?.lightEditor;
                    if (!forceSheet && lightEditor && typeof lightEditor.show === 'function') {
                        const shown = safeCall(() => { lightEditor.show({ type: 'foundry', id: String(lightId) }, sprite); return true; }, 'dblClick.lightEditor.show', Severity.COSMETIC, { fallback: false });
                        if (shown) return;
                    }

                    log.info(`Opening config for light ${lightId}`);
                    light.sheet.render(true);
                    return;
                }
            }
        }

        // 1.6 WP-5: Check Notes (double-click opens journal entry)
        // Mirrors Foundry Note._onClickLeft2: opens journal entry/page sheet.
        safeCall(() => {
          const nm = window.MapShine?.noteManager;
          if (nm && nm.notes.size > 0) {
            const noteSprites = Array.from(nm.notes.values());
            const noteHits = this.raycaster.intersectObjects(noteSprites, false);
            if (noteHits.length > 0) {
              const hit = noteHits[0];
              const docId = hit.object?.userData?.docId;
              const noteDoc = docId ? canvas?.scene?.notes?.get?.(docId) : null;
              if (noteDoc) {
                const entry = noteDoc.entry;
                const page = noteDoc.page;
                if (entry) {
                  // Permission check: _canView requires OBSERVER (or LIMITED for image pages)
                  const accessTest = page ?? entry;
                  const canView = game?.user?.isGM || accessTest?.testUserPermission?.(game.user, 'OBSERVER');
                  if (canView) {
                    const options = {};
                    if (page) {
                      options.mode = foundry?.applications?.sheets?.journal?.JournalEntrySheet?.VIEW_MODES?.SINGLE;
                      options.pageId = page.id;
                    }
                    const allowed = Hooks.call('activateNote', canvas?.notes?.get?.(docId) ?? noteDoc, options);
                    if (allowed !== false) {
                      if (page?.type === 'image') {
                        new ImagePopout({
                          src: page.src,
                          uuid: page.uuid,
                          caption: page.image?.caption,
                          window: { title: page.name }
                        }).render({ force: true });
                      } else {
                        entry.sheet.render(true, options);
                      }
                    }
                    return;
                  }
                }
              }
            }
          }
        }, 'dblClick.noteInteraction', Severity.COSMETIC);

        // 2. Check Tokens
        const wallGroup = this.wallManager.wallGroup;
        this.raycaster.params.Line.threshold = 10; // Tolerance
        const wallIntersects = this.raycaster.intersectObject(wallGroup, true);
        
        if (wallIntersects.length > 0) {
            const hit = wallIntersects[0];
            let object = hit.object;
            // Find group with wallId
            while(object && object !== wallGroup) {
                if (object.userData && object.userData.wallId) {
                    const wallId = object.userData.wallId;
                    const wall = canvas.walls.get(wallId);
                    if (wall && wall.document.testUserPermission(game.user, "LIMITED")) {
                        log.info(`Opening config for wall ${wallId}`);
                        wall.sheet.render(true);
                        return;
                    }
                }
                object = object.parent;
            }
        }

        // 2. Check Tokens
        // Tokens may be rendered on the overlay layer (31) to draw above post-processing.
        // Ensure raycasting includes that layer, otherwise tokens won't be clickable/draggable.
        const prevRayMask = this.raycaster.layers?.mask;
        safeCall(() => {
          if (!this.raycaster.layers) this.raycaster.layers = new THREE.Layers();
          this.raycaster.layers.set(0);
          this.raycaster.layers.enable(OVERLAY_THREE_LAYER);
        }, 'dblClick.setRayLayers', Severity.COSMETIC);

        const interactables = this.tokenManager.getAllTokenSprites();
        const intersects = this.raycaster.intersectObjects(interactables, false);

        safeCall(() => { if (typeof prevRayMask === 'number' && this.raycaster.layers) this.raycaster.layers.mask = prevRayMask; }, 'dblClick.restoreRayLayers', Severity.COSMETIC);

        if (intersects.length > 0) {
          const hit = intersects[0];
          const sprite = hit.object;
          const tokenDoc = sprite.userData.tokenDoc;

          log.debug('onPointerDown token hit', {
            tokenId: tokenDoc?.id,
            tokenName: tokenDoc?.name
          });

          // Permission check: "LIMITED" permission required to view sheet
          if (!tokenDoc.testUserPermission(game.user, "LIMITED")) {
            ui.notifications.warn("You do not have permission to view this Token's sheet.");
            return;
          }

          const actor = tokenDoc.actor;
          if (actor) {
            log.info(`Opening actor sheet for: ${tokenDoc.name}`);
            actor.sheet.render(true);
          } else {
            // Fallback if no actor (unlikely for valid tokens)
            log.warn(`Token ${tokenDoc.name} has no associated actor`);
          }
        }
    } catch (error) {
        log.error('Error in onDoubleClick:', error);
    }
  }


  /**
   * Helper to start drag operation
   * @param {THREE.Object3D} targetObject 
   * @param {THREE.Vector3} hitPoint 
   */
  startDrag(targetObject, hitPoint) {
      let id;
      if (targetObject.userData.tokenDoc) {
          id = targetObject.userData.tokenDoc.id;
      } else if (targetObject.userData.lightId) {
          id = targetObject.userData.lightId;
      } else if (targetObject.userData.enhancedLightId) {
          id = targetObject.userData.enhancedLightId;
      } else {
          return;
      }

      this.dragState.active = true;
      this.dragState.mode = null;
      this.dragState.leaderId = id;
      
      // Create Previews
      this.createDragPreviews();
      
      const leaderPreview = this.dragState.previews.get(id);
      if (!leaderPreview) {
        log.error("Failed to create leader preview");
        this.dragState.active = false;
        return;
      }
      
      this.dragState.object = leaderPreview;
      this.dragState.startPos.copy(leaderPreview.position);
      this.dragState.offset.subVectors(leaderPreview.position, hitPoint); 
      this.dragState.hasMoved = false;
      
      this.dragState.initialPositions.clear();
      for (const [pid, preview] of this.dragState.previews) {
        this.dragState.initialPositions.set(pid, preview.position.clone());
      }

      this._clearMovementPathPreview();
      this.rightClickMovePreview.active = false;
      this.rightClickMovePreview.tokenId = null;
      this.rightClickMovePreview.tileKey = '';
      this.rightClickMovePreview.destinationTopLeft = null;
      this.rightClickMovePreview.selectionKey = '';
      this.rightClickMovePreview.groupPlanCacheKey = '';
      
      if (window.MapShine?.cameraController) {
        window.MapShine.cameraController.enabled = false;
      }
  }

  /**
   * Start wall endpoint drag operation.
   * @param {THREE.Object3D} endpointObject
   * @param {PointerEvent} event
   */
  startWallDrag(endpointObject, event) {
    const wallId = endpointObject?.userData?.wallId;
    const endpointIndex = endpointObject?.userData?.index;
    if (!wallId || !Number.isFinite(endpointIndex)) return;

    this.dragState.active = true;
    this.dragState.mode = 'wallEndpoint';
    this.dragState.object = endpointObject;
    this.dragState.wallId = wallId;
    this.dragState.endpointIndex = endpointIndex;
    this.dragState.hasMoved = false;

    if (window.MapShine?.cameraController) {
      window.MapShine.cameraController.enabled = false;
    }

    // Consume interaction so wall endpoint drag does not leak into other handlers.
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
  }

  // ── Map Point Handle methods — delegated to MapPointDrawHandler ──────────

  onWheel(event) {
    safeCall(() => {
      if (this._isEventFromUI(event)) return;

      const rect = this.canvasElement.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) return;

      if (this.dragState?.active) return;

      // Use actual event modifier state. Foundry's global modifier tracking can become stale
      // (e.g. CONTROL reported active when it is not), which would incorrectly hijack wheel
      // events and make normal zoom feel "stuck".
      const isCtrl = event.ctrlKey;
      const isShift = event.shiftKey;
      if (!(isCtrl || isShift)) return;

      let dy = event.deltaY;
      if (event.shiftKey && (dy === 0)) dy = event.deltaX;
      if (!dy) return;

      if (!canvas?.ready) return;
      const layer = canvas.activeLayer;
      if (!layer?.options?.rotatableObjects) return;

      const hasTarget = layer.options?.controllableObjects ? (layer.controlled?.length > 0) : !!layer.hover;
      if (!hasTarget) return;

      event.delta = dy;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      layer._onMouseWheel?.(event);
    }, 'onWheel', Severity.DEGRADED);
  }

  /**
   * Handle pointer down (select / start drag)
   * @param {PointerEvent} event 
   */
  onPointerDown(event) {
    try {
        // Ignore pointer-down on UI so we don't start scene interactions.
        if (this._isEventFromUI(event)) {
          return;
        }

        // One-shot world pick callback (e.g., Tile Motion pivot selection).
        // This takes absolute priority — it consumes the event and returns.
        if (this._pendingWorldPick && event.button === 0) {
          const pickWorldPos = this.screenToWorld(event.clientX, event.clientY);
          if (pickWorldPos) {
            const cb = this._pendingWorldPick;
            this._pendingWorldPick = null;
            try { cb(pickWorldPos); } catch (err) { log.warn('World pick callback error:', err); }
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
          }
        }

        // Notify persistent world click observers (non-consuming).
        // Fires early so observers see every left-click regardless of what
        // the InteractionManager does with it afterwards.
        if (this._worldClickObservers.size > 0 && event.button === 0) {
          safeCall(() => {
            const obsWorldPos = this.screenToWorld(event.clientX, event.clientY);
            if (obsWorldPos) {
              const info = { clientX: event.clientX, clientY: event.clientY, worldX: obsWorldPos.x, worldY: obsWorldPos.y };
              for (const cb of this._worldClickObservers) {
                try { cb(info); } catch (err) { log.warn('World click observer error:', err); }
              }
            }
          }, 'pointerDown.worldClickObservers', Severity.COSMETIC);
        }

        // Any new pointerdown cancels a pending light click unless we immediately re-arm it.
        if (this._pendingLight?.active) {
          this._pendingLight.active = false;
          this._pendingLight.type = null;
          this._pendingLight.id = null;
          this._pendingLight.sprite = null;
          this._pendingLight.hitPoint = null;
          this._pendingLight.canEdit = false;
          this._pendingLight.forceSheet = false;
        }

        // Defensive cleanup: if a click-to-move interaction was armed but never
        // completed (e.g., lost pointerup), reset it before handling a new down.
        if (this.moveClickState?.active) {
          this._resetMoveClickState();
        }

        // Handle Map Point Drawing Mode (takes priority over other interactions)
        if (this.mapPointDraw.active && event.button === 0) {
          const worldPos = this.screenToWorld(event.clientX, event.clientY);
          if (worldPos) {
            this.mapPointDrawHandler.addPoint(worldPos.x, worldPos.y, event.shiftKey);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }

        // Handle right-click on map point helpers (context menu)
        if (event.button === 2) {
          const clickedGroupId = this.mapPointDrawHandler.getGroupAtPosition(event.clientX, event.clientY);
          if (clickedGroupId) {
            event.preventDefault();
            event.stopPropagation();
            this.mapPointDrawHandler.showContextMenu(clickedGroupId, event.clientX, event.clientY);
            return;
          }
        }

        // Handle left-click on map point helpers (select/edit)
        if (event.button === 0) {
          const mapPointsManager = window.MapShine?.mapPointsManager;
          if (mapPointsManager?.showVisualHelpers) {
            const handleHit = this.mapPointDrawHandler.getHandleAtPosition(event.clientX, event.clientY);
            if (handleHit) {
              event.preventDefault();
              event.stopPropagation();
              this.mapPointDrawHandler.startHandleDrag(handleHit.object, handleHit.hitPoint, handleHit.groupId, handleHit.pointIndex);
              return;
            }

            const clickedGroupId = this.mapPointDrawHandler.getGroupAtPosition(event.clientX, event.clientY);
            if (clickedGroupId) {
              event.preventDefault();
              event.stopPropagation();
              // Open edit dialog for this group
              const uiManager = window.MapShine?.uiManager;
              if (uiManager?.openGroupEditDialog) {
                uiManager.openGroupEditDialog(clickedGroupId);
              }
              return;
            }
          }
        }

        // Respect the current input mode: only handle clicks when the
        // InputRouter says Three.js should receive input. This prevents
        // conflicts when PIXI tools are active, but we *override* this
        // for the Tokens layer so gameplay clicks are never blocked.
        const mapShine = window.MapShine || window.mapShine;
        const inputRouter = mapShine?.inputRouter;
        const activeLayerName = canvas.activeLayer?.name;
        const activeTool = ui?.controls?.tool?.name ?? game.activeTool;
        
        // DEBUG: Log InputRouter state to diagnose why clicks aren't being processed
        log.debug('onPointerDown InputRouter check', {
          hasInputRouter: !!inputRouter,
          currentMode: inputRouter?.currentMode,
          shouldThreeReceive: inputRouter?.shouldThreeReceiveInput?.(),
          activeLayer: activeLayerName,
          activeTool
        });

        const isTokenLayerName = activeLayerName === 'TokenLayer' || activeLayerName === 'TokensLayer' || activeLayerName === 'tokens';
        const isTokenSelectTool = activeTool === 'select' || !activeTool;
        const shouldOverrideRouter = isTokenLayerName && isTokenSelectTool;
        
        if (inputRouter && !inputRouter.shouldThreeReceiveInput()) {
          let allowOverride = shouldOverrideRouter;

          // If the router is in PIXI mode (common on LightingLayer), we still want
          // Three.js to be able to select Three-rendered light icons.
          if (!allowOverride) {
            safeCall(() => {
              const camera = this.sceneComposer?.camera;
              if (camera) {
                this.updateMouseCoords(event);
                this.raycaster.setFromCamera(this.mouse, camera);

                // Check enhanced lights (MapShine)
                const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
                const enhancedIcons = enhancedLightIconManager ? Array.from(enhancedLightIconManager.lights.values()) : [];
                const hitEnhanced = enhancedIcons.length > 0 ? this.raycaster.intersectObjects(enhancedIcons, false) : [];

                // Check Foundry lights (Three icon sprites)
                const foundryIcons = (this.lightIconManager && this.lightIconManager.lights)
                  ? Array.from(this.lightIconManager.lights.values())
                  : [];
                const hitFoundry = foundryIcons.length > 0 ? this.raycaster.intersectObjects(foundryIcons, false) : [];

                if (hitEnhanced.length > 0 || hitFoundry.length > 0) {
                  allowOverride = true;
                  log.debug('onPointerDown overriding InputRouter block for Three.js light icon click');
                  safeCall(() => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); }, 'pointerDown.consumeForLight', Severity.COSMETIC);
                  safeCall(() => inputRouter.forceThree?.('InteractionManager light click'), 'pointerDown.forceThreeLight', Severity.DEGRADED);
                }
              }
            }, 'pointerDown.lightOverrideCheck', Severity.COSMETIC);
          }

          if (allowOverride) {
            if (shouldOverrideRouter) {
              log.debug('onPointerDown overriding InputRouter block on Tokens layer; forcing THREE mode');
              safeCall(() => inputRouter.forceThree?.('InteractionManager token click'), 'pointerDown.forceThreeToken', Severity.DEGRADED);
            }
            // Fall through and continue handling the click.
          } else {
            log.debug('onPointerDown BLOCKED by InputRouter (PIXI mode active)');
            return;
          }
        }

        log.debug('onPointerDown received', {
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
          activeLayer: canvas.activeLayer?.name,
          activeTool: ui?.controls?.tool?.name ?? game.activeTool
        });

        const camera = this.sceneComposer?.camera;
        if (!camera) {
          log.debug('onPointerDown ignored - Three.js camera not available');
          return;
        }

        this.updateMouseCoords(event);
        this.raycaster.setFromCamera(this.mouse, camera);

        // 0. Light translate gizmo (red/green axes + center). This is intentionally
        // checked early so it can override other interaction.
        if (event.button === 0 && this._lightTranslate?.group?.visible && Array.isArray(this._lightTranslate.handles)) {
          const prevMask = this.raycaster.layers?.mask;
          safeCall(() => { this.raycaster.layers.enable(OVERLAY_THREE_LAYER); this.raycaster.layers.enable(0); }, 'pointerDown.gizmoLayers', Severity.COSMETIC);

          const hits = this.raycaster.intersectObjects(this._lightTranslate.handles, false);

          safeCall(() => { if (typeof prevMask === 'number' && this.raycaster.layers) this.raycaster.layers.mask = prevMask; }, 'pointerDown.restoreGizmoLayers', Severity.COSMETIC);

          if (hits && hits.length > 0) {
            const hit = hits[0];
            const obj = hit.object;
            const axis = String(obj?.userData?.axis || 'xy');
            const lightId = obj?.userData?.lightId;
            const enhancedLightId = obj?.userData?.enhancedLightId;

            const sel = enhancedLightId
              ? { type: 'enhanced', id: String(enhancedLightId) }
              : (lightId ? { type: 'foundry', id: String(lightId) } : null);

            if (sel && this._canEditSelectedLight(sel)) {
              // Keep selection consistent.
              if (!this.selection.has(sel.id)) {
                this.clearSelection();

                // Select the corresponding icon/root object so visuals are correct.
                safeCall(() => {
                  if (sel.type === 'enhanced') {
                    const mgr = window.MapShine?.enhancedLightIconManager;
                    const sprite = mgr?.lights?.get?.(sel.id);
                    if (sprite) this.selectObject(sprite, { showLightEditor: false });
                  } else {
                    const sprite = this.lightIconManager?.lights?.get?.(sel.id);
                    if (sprite) this.selectObject(sprite, { showLightEditor: false });
                  }
                }, 'pointerDown.selectIcon', Severity.COSMETIC);
              }

              // Start drag at the LIGHT CENTER so offset is stable (not the handle hitpoint).
              const center = this._getSelectedLightWorldPos(sel);
              if (center) {
                this.startDrag(obj, center);
                this.dragState.mode = 'lightTranslate';
                this.dragState.axis = axis;

                // Enhanced light gizmo: hide radius ring during drag.
                safeCall(() => { if (sel.type === 'enhanced') { const mgr = window.MapShine?.enhancedLightIconManager; mgr?.setDragging?.(sel.id, true); } }, 'pointerDown.setDragging', Severity.COSMETIC);

                // Disable camera controls while dragging.
                if (window.MapShine?.cameraController) {
                  window.MapShine.cameraController.enabled = false;
                }

                safeCall(() => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); }, 'pointerDown.consumeGizmoDrag', Severity.COSMETIC);

                return;
              }
            }
          }
        }

        // 0b. Light radius handles (drag to adjust bright/dim radii)
        if (event.button === 0 && this._lightRadiusRings?.group?.visible && Array.isArray(this._lightRadiusRings.handles)) {
          const prevMask = this.raycaster.layers?.mask;
          safeCall(() => { this.raycaster.layers.enable(OVERLAY_THREE_LAYER); this.raycaster.layers.enable(0); }, 'pointerDown.radiusLayers', Severity.COSMETIC);

          const hits = this.raycaster.intersectObjects(this._lightRadiusRings.handles, false);

          safeCall(() => { if (typeof prevMask === 'number' && this.raycaster.layers) this.raycaster.layers.mask = prevMask; }, 'pointerDown.restoreRadiusLayers', Severity.COSMETIC);

          if (hits && hits.length > 0) {
            const hit = hits[0];
            const obj = hit.object;
            const radiusType = obj?.userData?.radiusType; // 'bright' or 'dim'

            const sel = this._getSelectedLight();
            if (sel && radiusType && this._canEditSelectedLight(sel)) {
              const radii = this._getSelectedLightRadii(sel);
              const startBright = radii?.bright ?? 0;
              const startDim = radii?.dim ?? 0;
              const startRadius = radiusType === 'bright' ? startBright : startDim;

              // Capture the authoritative selection for the duration of the drag.
              this._lightRadiusRings.selected = sel;

              this._lightRadiusRings.dragging = radiusType;
              this._lightRadiusRings.startRadius = startRadius || 0;
              this._lightRadiusRings.startBright = startBright;
              this._lightRadiusRings.startDim = startDim;
              this._lightRadiusRings.startClientX = event.clientX;
              this._lightRadiusRings.startClientY = event.clientY;
              this._lightRadiusRings.pendingType = radiusType;
              this._lightRadiusRings.pendingRadius = startRadius || 0;
              this._lightRadiusRings.previewBright = startBright;
              this._lightRadiusRings.previewDim = startDim;

              // Start a pseudo-drag (we'll handle radius change in onPointerMove)
              this.dragState.active = true;
              this.dragState.mode = 'radiusEdit';
              // Ensure the onPointerMove drag path doesn't early-return.
              this.dragState.object = obj;

              // Disable camera controls while dragging
              if (window.MapShine?.cameraController) {
                window.MapShine.cameraController.enabled = false;
              }

              this.canvasElement.style.cursor = 'ew-resize';

              safeCall(() => { event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation?.(); }, 'pointerDown.consumeRadiusDrag', Severity.COSMETIC);

              return;
            }
          }
        }

        log.debug('onPointerDown mouse NDC', {
          ndcX: this.mouse.x,
          ndcY: this.mouse.y
        });
        
        const tokenSprites = this.tokenManager.getAllTokenSprites();
        log.debug('onPointerDown tokenSprites count', { count: tokenSprites.length });
        const wallGroup = this.wallManager.wallGroup;
        const groundZ = this.sceneComposer?.groundZ ?? 0;

        const clickToMoveButton = this._getClickToMoveButton();

        // Handle Right Click (Potential HUD or Door Lock/Unlock)
        if (event.button === 2) {
            // Toggle Foundry light disable via MapShine icons (so disabled lights can be re-enabled).
            safeCall(() => {
              const layerName = canvas.activeLayer?.name;
              const isLightingLayer = (layerName === 'LightingLayer' || layerName === 'lighting');
              if (isLightingLayer && this.lightIconManager) {
                const lightIcons = Array.from(this.lightIconManager.lights.values());
                const intersects = this.raycaster.intersectObjects(lightIcons, false);
                if (intersects.length > 0) {
                  const hit = intersects[0];
                  const sprite = hit.object;
                  const lightId = sprite?.userData?.lightId;
                  const lightDoc = lightId ? canvas?.lighting?.get?.(lightId)?.document : null;
                  if (lightDoc && lightDoc.canUserModify(game.user, 'update')) {
                    const nextHidden = !lightDoc.hidden;
                    lightDoc.update({ hidden: nextHidden }).catch(() => {});
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation?.();
                    return;
                  }
                }
              }
            }, 'pointerDown.rightClickLightToggle', Severity.COSMETIC);

            const wallIntersects = this.raycaster.intersectObject(wallGroup, true);
            log.debug('onPointerDown right-click wallIntersects', { count: wallIntersects.length });
            if (wallIntersects.length > 0) {
                let doorControl = null;

                for (const hit of wallIntersects) {
                    let object = hit.object;
                    while(object && object !== wallGroup) {
                        if (object.userData && object.userData.type === 'doorControl') {
                            doorControl = object;
                            break;
                        }
                        object = object.parent;
                    }
                    if (doorControl) break;
                }

                if (doorControl) {
                    if (game.user.isGM) {
                        this.handleDoorRightClick(doorControl, event);
                        event.preventDefault();
                        event.stopPropagation();
                        event.stopImmediatePropagation();
                        return;
                    }
                }
            }

            // Raycast against tokens for HUD
            const tokenIntersects = this.raycaster.intersectObjects(tokenSprites, false);
            log.debug('onPointerDown right-click tokenIntersects', { count: tokenIntersects.length });
            if (tokenIntersects.length > 0) {
                const hit = tokenIntersects[0];
                const sprite = hit.object;
                const tokenDoc = sprite.userData.tokenDoc;

                log.debug(`Right click down on token: ${tokenDoc.name} (${tokenDoc.id})`);

                this.rightClickState.active = true;
                this.rightClickState.tokenId = tokenDoc.id;
                this.rightClickState.startPos.set(event.clientX, event.clientY);
                this.rightClickState.time = Date.now();

                // Stop propagation of the pointerdown to prevent Foundry's PIXI
                // from redundantly processing the right-click (which causes a
                // noticeable freeze). The UnifiedCamera still receives the separate
                // mousedown event for right-drag panning support.
                event.preventDefault();
                event.stopPropagation();
                return;
            } else {
                const selectedTokenDocs = this._getSelectedTokenDocs();
                const selectedTokenDoc = selectedTokenDocs[0] || null;
                const worldPos = selectedTokenDoc ? this.viewportToWorld(event.clientX, event.clientY, groundZ) : null;

                if (event.button === clickToMoveButton && selectedTokenDoc && worldPos) {
                    this._armMoveClickState({
                      button: event.button,
                      tokenDoc: selectedTokenDoc,
                      tokenDocs: selectedTokenDocs,
                      worldPos,
                      clientX: event.clientX,
                      clientY: event.clientY
                    });
                    return;
                }

                log.debug('Right click down: No token hit');
            }
            return;
        }
        
        const activeLayer = canvas.activeLayer?.name;
        const isTokensLayer = activeLayer === 'TokensLayer';
        const isWallLayer = activeLayer && activeLayer.includes('WallsLayer');

        const doorIntersects = this.raycaster.intersectObject(wallGroup, true);
        if (doorIntersects.length > 0) {
            let doorControl = null;

            for (const hit of doorIntersects) {
                let object = hit.object;
                while(object && object !== wallGroup) {
                    if (object.userData && object.userData.type === 'doorControl') {
                        doorControl = object;
                        break;
                    }
                    object = object.parent;
                }
                if (doorControl) break;
            }

            if (doorControl) {
                this.handleDoorClick(doorControl, event);
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                return;
            }
        }

        const shouldCheckWalls = !isTokensLayer && (isWallLayer || game.user.isGM);
        const wallIntersects = shouldCheckWalls ? this.raycaster.intersectObject(wallGroup, true) : [];

        log.debug('onPointerDown wallIntersects', {
          shouldCheckWalls,
          count: wallIntersects.length
        });
        
        if (wallIntersects.length > 0) {
            // Sort by distance is default
            const hit = wallIntersects[0];
            let object = hit.object;
            
            // Traverse up to find userData if needed (e.g. door parts)
            let interactable = null;
            let type = null;
            
            while (object && object !== wallGroup) {
                if (object.userData && object.userData.type) {
                    interactable = object;
                    type = object.userData.type;
                    break;
                }
                object = object.parent;
            }
            
            if (interactable) {
                if (type === 'doorControl') {
                     this.handleDoorClick(interactable, event);
                     return;
                }
                
                if (type === 'wallEndpoint') {
                     this.startWallDrag(interactable, event);
                     return;
                }

                if (type === 'wallLine') {
                    if (game.user.isGM || canvas.activeLayer?.name?.includes('WallsLayer')) {
                        this.selectWall(interactable, event);
                        return;
                    }
                }
            }
        }

        const currentTool = ui?.controls?.tool?.name ?? game.activeTool;
        
        if (isWallLayer) {
          // Start Wall Drawing on the ground plane (aligned with groundZ)
          const worldPos = this.viewportToWorld(event.clientX, event.clientY, groundZ);
          if (!worldPos) return;

          // Snap start position
          const foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);
          
          let snapped;
          if (event.shiftKey) {
            snapped = foundryPos;
          } else {
            // Use Foundry's standard wall snapping logic
            const M = CONST.GRID_SNAPPING_MODES;
            const size = canvas.dimensions.size;
            const resolution = size >= 128 ? 8 : (size >= 64 ? 4 : 2);
            const mode = canvas.forceSnapVertices ? M.VERTEX : (M.CENTER | M.VERTEX | M.CORNER | M.SIDE_MIDPOINT);
            
            snapped = this.snapToGrid(foundryPos.x, foundryPos.y, mode, resolution);
          }
          
          const snappedWorld = Coordinates.toWorld(snapped.x, snapped.y);
          
          this.wallDraw.active = true;
          this.wallDraw.start.set(snappedWorld.x, snappedWorld.y, 0);
          this.wallDraw.current.set(snappedWorld.x, snappedWorld.y, 0);
          this.wallDraw.type = currentTool;
          
          // Create preview mesh
          if (!this.wallDraw.previewLine) {
            const geometry = new THREE.PlaneGeometry(1, 6); // Unit length, 6px thickness
            const material = new THREE.MeshBasicMaterial({ 
                color: 0xffffff, 
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.5
            });
            this.wallDraw.previewLine = new THREE.Mesh(geometry, material);
            this.wallDraw.previewLine.name = 'WallPreview';
            this.wallDraw.previewLine.position.z = 3.5;
            this.sceneComposer.scene.add(this.wallDraw.previewLine);
          } else {
            this.wallDraw.previewLine.visible = true;
          }
          
          // Reset transform
          this.wallDraw.previewLine.position.copy(this.wallDraw.start);
          this.wallDraw.previewLine.position.z = 3.5;
          this.wallDraw.previewLine.scale.set(0, 1, 1);
          
          // Disable camera controls
          if (window.MapShine?.cameraController) {
            window.MapShine.cameraController.enabled = false;
          }
          
          return; // Skip token selection
        }

        // 2.5. Native Light Placement (LightingLayer in Three.js Gameplay Mode)
        // When on the Lighting layer with the standard light tool active, allow the GM to
        // place AmbientLight documents directly from the 3D view without swapping modes.
        const isLightingLayer = (activeLayer === 'LightingLayer' || activeLayer === 'lighting');
        if (isLightingLayer) {

          // 2.5a Check for Existing Lights (Select/Drag)
          // Prioritize interacting with existing lights over placing new ones
          // MapShine Enhanced Lights: always allow select/drag when LightingLayer is active
          // (matches Foundry UX: you can always grab an existing light handle).
          const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
          if (enhancedLightIconManager) {
            const enhancedLightIcons = Array.from(enhancedLightIconManager.lights.values());
            const intersects = this.raycaster.intersectObjects(enhancedLightIcons, false);
            if (intersects.length > 0) {
              const hit = intersects[0];
              const sprite = hit.object;
              const enhancedLightId = sprite.userData.enhancedLightId;

              if (enhancedLightId) {
                // Handle Selection (anyone can select/view; only GM can drag/edit)
                const isSelected = this.selection.has(enhancedLightId);
                if (event.shiftKey) {
                  if (!isSelected) this.selectObject(sprite, { showLightEditor: false });
                } else {
                  if (!isSelected) {
                    this.clearSelection();
                    this.selectObject(sprite, { showLightEditor: false });
                  }
                }

                // Defer editor opening to pointerup; defer dragging until movement exceeds threshold.
                this._pendingLight.active = true;
                this._pendingLight.type = 'enhanced';
                this._pendingLight.id = String(enhancedLightId);
                this._pendingLight.sprite = sprite;
                this._pendingLight.hitPoint = hit.point?.clone?.() ?? hit.point;
                this._pendingLight.canEdit = !!game.user.isGM;
                this._pendingLight.startClientX = event.clientX;
                this._pendingLight.startClientY = event.clientY;
                this._pendingLight.forceSheet = false;
                return;
              }
            }
          }

          // Standard Foundry Light Tool: Check Foundry light icons
          if (this.lightIconManager) {
            const lightIcons = Array.from(this.lightIconManager.lights.values());
            const intersects = this.raycaster.intersectObjects(lightIcons, false);
            
            if (intersects.length > 0) {
              const hit = intersects[0];
              const sprite = hit.object;
              const lightId = sprite.userData.lightId;
              const lightDoc = canvas.lighting.get(lightId)?.document;

              // Selection should work with LIMITED permission; editing/dragging requires update permission.
              const canView = !!(lightDoc && lightDoc.testUserPermission(game.user, "LIMITED"));
              const canEdit = !!(lightDoc && lightDoc.canUserModify(game.user, "update"));
              if (canView) {
                // Handle Selection
                const isSelected = this.selection.has(lightId);
                if (event.shiftKey) {
                  if (!isSelected) this.selectObject(sprite, { showLightEditor: false });
                } else {
                  if (!isSelected) {
                    this.clearSelection();
                    this.selectObject(sprite, { showLightEditor: false });
                  }
                }

                // Defer editor opening to pointerup; defer dragging until movement exceeds threshold.
                this._pendingLight.active = true;
                this._pendingLight.type = 'foundry';
                this._pendingLight.id = String(lightId);
                this._pendingLight.sprite = sprite;
                this._pendingLight.hitPoint = hit.point?.clone?.() ?? hit.point;
                this._pendingLight.canEdit = canEdit;
                this._pendingLight.startClientX = event.clientX;
                this._pendingLight.startClientY = event.clientY;
                this._pendingLight.forceSheet = !!(event.altKey || event.ctrlKey || event.metaKey);
                return;
              }
            }
          }

          // 2.5b Place New Light
          // Only GM may place lights for now, matching Foundry's default behavior
          if (!game.user.isGM) {
            ui.notifications.warn('Only the GM can place lights in this mode.');
            return;
          }

          // Project onto ground plane for light placement
          const worldPos = this.viewportToWorld(event.clientX, event.clientY, groundZ);
          if (!worldPos) return;

          const foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);

          // Snap start position (Shift skips snap)
          let snapped = foundryPos;
          if (!event.shiftKey) {
             const M = CONST.GRID_SNAPPING_MODES;
             // Snap to grid center/vertex/etc based on resolution like Foundry
             snapped = this.snapToGrid(foundryPos.x, foundryPos.y, M.CENTER | M.VERTEX | M.CORNER | M.SIDE_MIDPOINT);
          }
          const snappedWorld = Coordinates.toWorld(snapped.x, snapped.y);

          // Foundry Light Placement
          {
            if (!canvas.lighting) return;
            
            this.lightPlacement.active = true;
            this.lightPlacement.start.set(snappedWorld.x, snappedWorld.y, groundZ);
            this.lightPlacement.current.set(snappedWorld.x, snappedWorld.y, groundZ);
            
            // Initialize Visuals
            this.lightPlacement.previewGroup.position.copy(this.lightPlacement.start);
            this.lightPlacement.previewGroup.position.z = groundZ + 0.5;
            this.lightPlacement.previewGroup.scale.set(1, 1, 1);
            this.lightPlacement.previewGroup.visible = true;

            // Start with a tiny preview so the shader has a sane radius.
            this._updateLightPlacementPreviewGeometry(this.lightPlacement, this.lightPlacement.start, 0.1);
          }

          // Disable camera controls
          if (window.MapShine?.cameraController) {
             window.MapShine.cameraController.enabled = false;
          }

          // Do not start token selection when placing a light
          return;
        }

        // Tokens may be rendered on the overlay layer (31) to draw above post-processing.
        // Ensure raycasting includes that layer, otherwise tokens won't be clickable/draggable.
        const prevTokenRayMask = this.raycaster.layers?.mask;
        safeCall(() => {
          if (!this.raycaster.layers) this.raycaster.layers = new THREE.Layers();
          this.raycaster.layers.set(0);
          this.raycaster.layers.enable(OVERLAY_THREE_LAYER);
        }, 'pointerDown.tokenRayLayers', Severity.COSMETIC);

        const intersects = this.raycaster.intersectObjects(tokenSprites, false);

        safeCall(() => { if (typeof prevTokenRayMask === 'number' && this.raycaster.layers) this.raycaster.layers.mask = prevTokenRayMask; }, 'pointerDown.restoreTokenRayLayers', Severity.COSMETIC);

        log.debug('onPointerDown left-click tokenIntersects', { count: intersects.length });

        if (intersects.length > 0) {
          // Hit something
          const hit = intersects[0];
          const sprite = hit.object;
          const tokenDoc = sprite.userData.tokenDoc;
          
          // Close HUD if clicking on a different token
          if (this.openHudTokenId && this.openHudTokenId !== tokenDoc.id) {
            const hud = canvas.tokens?.hud;
            if (hud?.rendered) {
              log.debug('Left click on different token: Closing HUD');
              hud.close();
            }
            this.openHudTokenId = null;
          }
          
          // Permission check
          if (!tokenDoc.canUserModify(game.user, "update")) {
            ui.notifications.warn("You do not have permission to control this Token.");
            return;
          }

          // Handle Selection (Three.js selection state)
          const isSelected = this.selection.has(tokenDoc.id);
          
          if (event.shiftKey) {
            // Toggle or Add
            if (isSelected) {
              // If shift-clicking selected, deselect it (unless we start dragging?)
              // For now, let's just ensure it stays selected or maybe allow deselect on UP if no drag?
              // Simpler: Shift always adds/keeps.
            } else {
              this.selectObject(sprite);
            }
          } else {
            if (!isSelected) {
              // Clicked unselected -> Clear others, select this
              this.clearSelection();
              this.selectObject(sprite);
            }
            // If clicked selected -> Keep group selection
          }

          // Start Drag
          this.startDrag(sprite, hit.point);

          // Also drive Foundry's native token control so cursor/selection/HUD
          // behavior matches core. This uses the underlying PIXI token object
          // but is triggered from our Three.js hit test.
          safeCall(() => {
            const fvttToken = canvas.tokens?.get(tokenDoc.id);
            if (fvttToken) {
              const releaseOthers = !event.shiftKey;
              // Do not pan camera here; CameraSync keeps Three.js aligned.
              fvttToken.control({ releaseOthers, pan: false });
            }
          }, 'pointerDown.syncFoundryToken', Severity.DEGRADED);

          // Auto-switch floor when clicking a visible token on a different level.
          // If you can see a token (even on a floor below), clicking it selects it
          // and automatically changes the level view to that token's floor.
          safeCall(() => {
            if (!isTokenOnActiveLevel(tokenDoc)) {
              const elev = Number(tokenDoc?.elevation ?? 0);
              if (Number.isFinite(elev)) {
                switchToLevelForElevation(elev, 'click-select-token-auto-switch');
              }
            }
          }, 'pointerDown.autoSwitchLevel', Severity.COSMETIC);
          
        } else {
          if (clickToMoveButton === 0) {
            const selectedTokenDocs = this._getSelectedTokenDocs();
            const selectedTokenDoc = selectedTokenDocs[0] || null;
            const worldPos = selectedTokenDoc ? this.viewportToWorld(event.clientX, event.clientY, groundZ) : null;
            if (selectedTokenDoc && worldPos && !event.shiftKey) {
              this._armMoveClickState({
                button: 0,
                tokenDoc: selectedTokenDoc,
                tokenDocs: selectedTokenDocs,
                worldPos,
                clientX: event.clientX,
                clientY: event.clientY
              });
              return;
            }
          }

          // Clicked empty space - deselect all unless shift held
          if (!event.shiftKey) {
            this.clearSelection();
          }
          
          // Close any open Token HUD when clicking empty space
          if (this.openHudTokenId) {
            const hud = canvas.tokens?.hud;
            if (hud?.rendered) {
              log.debug('Left click on empty space: Closing HUD');
              hud.close();
            }
            this.openHudTokenId = null;
          }
          
          // WP-3 Ping parity: arm long-press ping timer on empty-space left-click.
          // Mirrors Foundry's ControlsLayer._onLongPress (500ms).
          // Capture Shift key state NOW so pull ping works even if Shift is released during the 500ms delay.
          this._cancelPingLongPress();
          safeCall(() => {
            const isTokensLayer = canvas?.activeLayer instanceof foundry.canvas.layers.TokenLayer;
            const isCtrl = !!(event.ctrlKey || event.metaKey);
            if (isTokensLayer && !isCtrl && game?.user?.hasPermission?.('PING_CANVAS')) {
              const groundZ = this.sceneComposer?.groundZ ?? 0;
              const pingWorld = this.viewportToWorld(event.clientX, event.clientY, groundZ);
              if (pingWorld) {
                const pingFoundry = Coordinates.toFoundry(pingWorld.x, pingWorld.y);
                this._pingLongPress.startX = event.clientX;
                this._pingLongPress.startY = event.clientY;
                this._pingLongPress.worldX = pingFoundry.x;
                this._pingLongPress.worldY = pingFoundry.y;
                this._pingLongPress.shiftHeld = event.shiftKey;
                this._pingLongPress.timerId = setTimeout(() => {
                  this._pingLongPress.timerId = null;
                  safeCall(() => {
                    // Pass pull=true if Shift was held when ping was armed (not when firing)
                    const pingOptions = this._pingLongPress.shiftHeld ? { pull: true } : {};
                    canvas?.ping?.({ x: this._pingLongPress.worldX, y: this._pingLongPress.worldY }, pingOptions);
                  }, 'pingLongPress.fire', Severity.COSMETIC);
                }, 500);
              }
            }
          }, 'pointerDown.armPingLongPress', Severity.COSMETIC);

          // Start Drag Select
          this.dragSelect.active = true;
          this.dragSelect.dragging = false;

          // Defensive: ensure any previous shadow is hidden before we begin.
          safeCall(() => this.selectionBoxEffect?._hideSelectionShadow?.(), 'pointerDown.hideSelectionShadow', Severity.COSMETIC);
          
          // World-space start for selection math (ground plane)
          const worldPos = this.viewportToWorld(event.clientX, event.clientY, groundZ);
          if (worldPos) {
            this.dragSelect.start.copy(worldPos);
            this.dragSelect.current.copy(worldPos);
          }

          // Screen-space start for visual overlay
          this.dragSelect.screenStart.set(event.clientX, event.clientY);
          this.dragSelect.screenCurrent.copy(this.dragSelect.screenStart);

          // Hide old Three.js box; use DOM overlay instead
          if (this.dragSelect.mesh) this.dragSelect.mesh.visible = false;
          if (this.dragSelect.border) this.dragSelect.border.visible = false;

          const rect = this.canvasElement.getBoundingClientRect();
          const overlay = this.dragSelect.overlayEl;
          if (overlay && rect.width > 0 && rect.height > 0) {
            overlay.style.left = `${this.dragSelect.screenStart.x}px`;
            overlay.style.top = `${this.dragSelect.screenStart.y}px`;
            overlay.style.width = '0px';
            overlay.style.height = '0px';
            overlay.style.display = 'none';
          }
        }
    } catch (error) {
        log.error('Error in onPointerDown:', error);
    }
  }

  /**
   * Update loop called by EffectComposer
   * @param {TimeInfo} timeInfo 
   */
  update(timeInfo) {
    // Keep HUD positioned correctly if open
    if (canvas.tokens?.hud?.rendered && canvas.tokens.hud.object) {
      this.updateHUDPosition();
    }

    // Animate selection overlay styles (marching ants, pulsing glow)
    safeCall(() => this.selectionBoxEffect?.update?.(timeInfo), 'update.selectionBox', Severity.COSMETIC);

    this._updateSelectedLightOutline();
    this._updateLightTranslateGizmo();
    this._updateLightRadiusRingsGizmo();

    // Overhead hover debug: keep an always-on marker + label so we can diagnose
    // pointer-to-ray mapping even when there are no sprite hits.
    safeCall(() => this._updateOverheadHoverDebugIdle(), 'update.overheadDebugIdle', Severity.COSMETIC);
  }

  _updateOverheadHoverDebugIdle() {
    if (!this._debugOverheadHover?.enabled) return;

    this._ensureOverheadHoverDebugObjects();
    const dbg = this._debugOverheadHover;
    if (!dbg?.group || !dbg.marker || !dbg.ray) return;

    const cam = this.sceneComposer?.camera;
    if (!cam) return;

    // Prefer the most recent pointer coords (updated in onPointerMove / handleHover).
    const clientX = (typeof this._lastPointerClientX === 'number') ? this._lastPointerClientX : null;
    const clientY = (typeof this._lastPointerClientY === 'number') ? this._lastPointerClientY : null;
    if (clientX == null || clientY == null) return;

    // Update ray from mouse NDC.
    const ndc = this._tempVec2HoverNdc || (this._tempVec2HoverNdc = new window.THREE.Vector2());
    const rect = this._getCanvasRectCached();
    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(ndc, cam);

    // Project onto the ground plane (Z=0) just to show where the ray is in world
    // space even if we never hit an overhead sprite.
    const THREE = window.THREE;
    const plane = this._overheadDebugPlane || (this._overheadDebugPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0));
    const hitPoint = this._overheadDebugPoint || (this._overheadDebugPoint = new THREE.Vector3());
    const ok = this.raycaster.ray.intersectPlane(plane, hitPoint);
    if (!ok) return;

    dbg.group.visible = true;
    dbg.marker.position.copy(hitPoint);
    dbg.marker.position.z += 0.5;

    // Ray line from camera to projected point.
    cam.getWorldPosition(_tmpPos);
    const arr = dbg.ray.geometry.attributes.position.array;
    arr[0] = _tmpPos.x;
    arr[1] = _tmpPos.y;
    arr[2] = _tmpPos.z;
    arr[3] = hitPoint.x;
    arr[4] = hitPoint.y;
    arr[5] = hitPoint.z;
    dbg.ray.geometry.attributes.position.needsUpdate = true;

    // Hide quad when we don't have a tile hit yet.
    safeCall(() => { if (dbg.quad) dbg.quad.visible = false; }, 'overheadDebugIdle.hideQuad', Severity.COSMETIC);

    // Always show a label with NDC + rect so we can diagnose offset mapping.
    safeCall(() => {
      if (dbg.label) {
        dbg.label.textContent = `roofDebug: ndc(${ndc.x.toFixed(3)}, ${ndc.y.toFixed(3)}) rect(l=${rect.left.toFixed(1)} t=${rect.top.toFixed(1)} w=${rect.width.toFixed(1)} h=${rect.height.toFixed(1)})`;
        dbg.label.style.left = `${clientX + 14}px`;
        dbg.label.style.top = `${clientY + 14}px`;
        dbg.label.style.display = 'block';
      }
    }, 'overheadDebugIdle.label', Severity.COSMETIC);
  }

  _getCanvasRectCached(force = false) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const cache = this._canvasRectCache;
    const maxAge = (typeof this._canvasRectCacheMaxAgeMs === 'number') ? this._canvasRectCacheMaxAgeMs : 250;

    if (!force && cache && cache.width > 0 && cache.height > 0 && (now - (cache.ts || 0)) < maxAge) {
      return cache;
    }

    const rect = safeCall(() => this.canvasElement?.getBoundingClientRect?.(), 'getCanvasRect', Severity.COSMETIC, { fallback: null });

    if (rect) {
      cache.left = rect.left;
      cache.top = rect.top;
      cache.width = rect.width;
      cache.height = rect.height;
    }

    // Fallback if canvas rect is invalid (e.g. not yet laid out)
    if (!cache.width || !cache.height) {
      cache.left = 0;
      cache.top = 0;
      cache.width = window.innerWidth;
      cache.height = window.innerHeight;
    }

    cache.ts = now;
    return cache;
  }

  // ── Light gizmo/query methods — delegated to LightInteractionHandler ──────
  _createLightTranslateGizmo() { this.lightHandler.createTranslateGizmo(); }

  _createLightRadiusRingsGizmo() { this.lightHandler.createRadiusRingsGizmo(); }
  _updateLightRadiusRingsGizmo() { this.lightHandler.updateRadiusRingsGizmo(); }
  _previewRadiusChange(sel, rt, nr) { this.lightHandler.previewRadiusChange(sel, rt, nr); }
  _applyPendingRadiusLive(sel) { this.lightHandler.applyPendingRadiusLive(sel); }
  async _commitPendingRadius(sel) { return this.lightHandler.commitPendingRadius(sel); }
  _commitRadiusChange() { this.lightHandler.commitRadiusChange(); }
  _getSelectedLightRadii(sel) { return this.lightHandler.getSelectedLightRadii(sel); }
  _getSelectedLight() { return this.lightHandler.getSelectedLight(); }
  _canEditSelectedLight(sel) { return this.lightHandler.canEditSelectedLight(sel); }
  _getSelectedLightWorldPos(sel) { return this.lightHandler.getSelectedLightWorldPos(sel); }
  _updateLightTranslateGizmo() { this.lightHandler.updateTranslateGizmo(); }

  /**
   * Update Token HUD position to match Three.js camera
   */
  updateHUDPosition() {
      const hud = canvas.tokens.hud;
      const token = hud.object;
      if (!token) return;
      
      // Get Three.js sprite for this token
      // tokenManager might store data by ID
      const spriteData = this.tokenManager.tokenSprites.get(token.id);
      if (!spriteData || !spriteData.sprite) {
          // Token may have been deleted; avoid spamming errors by closing the HUD.
          safeCall(() => { if (hud?.rendered) hud.close(); }, 'updateHUD.closeStaleHud', Severity.COSMETIC);
          this.openHudTokenId = null;
          return;
      }
      
      const sprite = spriteData.sprite;
      
      // CRITICAL: Ensure camera matrices are up to date for accurate projection
      // This fixes "lag" or "parallax" where the HUD trails behind the camera
      const cam = this.sceneComposer?.camera;
      if (!cam) return;
      cam.updateMatrixWorld();

      // Project world position to screen coordinates
      // We use the sprite's position (which is center bottom usually, or center? TokenManager puts it at center)
      // Token sprites are centered.
      const pos = this._tempVec3HUD;
      pos.copy(sprite.position);
      pos.project(cam);
      
      // Convert NDC to CSS pixels
      // NDC: [-1, 1] -> CSS: [0, width/height]
      // Y is inverted in CSS (0 at top) vs NDC (1 at top)
      const rect = this._getCanvasRectCached();
      const width = rect.width;
      const height = rect.height;
      const left = rect.left;
      const top = rect.top;
      
      // Calculate Screen Coordinates
      // NDC X [-1, 1] -> [0, Width]
      const x = (pos.x + 1) * width / 2 + left;
      
      // NDC Y [-1, 1] -> [Height, 0] (Inverted)
      // pos.y=1 (Top) -> 0
      // pos.y=-1 (Bottom) -> Height
      // Formula: (1 - pos.y) * height / 2
      const y = (1 - pos.y) * height / 2 + top;
      
      // Update HUD element position
      // Foundry's HUD usually centers itself based on object bounds, but since the object bounds
      // (PIXI) are disconnected from the view, we must position it manually.
      // The HUD element has absolute positioning.
      // We'll center the HUD on the token.
      
      if (hud.element) {
          // hud.element might be jQuery object or raw DOM or array
          const hasJq = (typeof jQuery !== 'undefined');
          const hudEl = (hasJq && (hud.element instanceof jQuery || hud.element.jquery)) ? hud.element[0] : hud.element;
          
          if (hudEl) {
              // CRITICAL FIX: Reparent HUD to body to avoid parent scaling issues (Parallax)
              // Foundry/System might put HUD in a scaled container (like #board).
              // We need screen-space coordinates (1:1).
              if (hudEl.parentNode !== document.body) {
                  document.body.appendChild(hudEl);
                  log.debug('Reparented Token HUD to body');
              }

              // Calculate Scale
              // We need to match the scale of the token on screen.
              // Base scale is 1:1 at baseDistance.
              // Current scale = baseDistance / currentDistance (approx for perspective)
              // Or better: use the ratio of screen pixels to world units.
              
              let scale = 1.0;
              if (this.sceneComposer.camera && this.sceneComposer.baseDistance) {
                  // Simple perspective scale approx
                  const dist = this.sceneComposer.camera.position.z - (sprite.position.z || 0);
                  if (dist > 0) {
                      scale = this.sceneComposer.baseDistance / dist;
                  }
              }
              
              // Apply position and scale
              // Use translate(-50%, -50%) to center the HUD element on the screen coordinate (x,y)
              // regardless of its size or scale.
              
              // Slightly enlarge the HUD (~25%) so it nicely wraps around the token even
              // when Foundry's native layout expects a slightly smaller canvas zoom.
              const finalScale = scale * 1.25;

              // Avoid per-frame style object allocations and jQuery .css overhead.
              // Only touch CSS properties if they changed meaningfully.
              const leftCss = `${Math.round(x)}px`;
              const topCss = `${Math.round(y)}px`;
              const transformCss = `translate(-50%, -50%) scale(${finalScale})`;

              if (this._hudStyledEl !== hudEl) {
                  hudEl.style.transformOrigin = 'center center';
                  hudEl.style.zIndex = '100';
                  hudEl.style.pointerEvents = 'auto';
                  hudEl.style.position = 'fixed';
                  this._hudStyledEl = hudEl;
              }

              const last = this._hudLastCss;
              if (last.left !== leftCss) {
                  hudEl.style.left = leftCss;
                  last.left = leftCss;
              }
              if (last.top !== topCss) {
                  hudEl.style.top = topCss;
                  last.top = topCss;
              }
              if (last.transform !== transformCss) {
                  hudEl.style.transform = transformCss;
                  last.transform = transformCss;
              }
          }
      }
  }

  /**
   * Handle hover detection
   * @param {PointerEvent} event 
   * @private
   */
  handleHover(event) {
    // Ensure camera matrices are current before any raycasting.
    // A stale camera matrixWorld can cause systematic pick offsets.
    safeCall(() => { const cam = this.sceneComposer?.camera; cam?.updateMatrixWorld?.(true); cam?.updateProjectionMatrix?.(); }, 'hover.updateCameraMatrix', Severity.COSMETIC);

    // Tiles have matrixAutoUpdate=false. Ensure the scene graph is up to date so
    // Raycaster sees correct matrixWorld values.
    safeCall(() => this.sceneComposer?.scene?.updateMatrixWorld?.(true), 'hover.updateSceneMatrix', Severity.COSMETIC);

    this.updateMouseCoords(event);
    this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);

    let hitFound = false;

    // 0. Light translate gizmo hover (cursor affordance)
    safeCall(() => {
      if (this._lightTranslate?.group?.visible && Array.isArray(this._lightTranslate.handles) && this._lightTranslate.handles.length) {
        const prevMask = this.raycaster.layers?.mask;
        safeCall(() => { this.raycaster.layers.enable(OVERLAY_THREE_LAYER); this.raycaster.layers.enable(0); }, 'hover.gizmoLayers', Severity.COSMETIC);

        const hits = this.raycaster.intersectObjects(this._lightTranslate.handles, false);

        safeCall(() => { if (typeof prevMask === 'number' && this.raycaster.layers) this.raycaster.layers.mask = prevMask; }, 'hover.restoreGizmoLayers', Severity.COSMETIC);

        if (hits && hits.length > 0) {
          // Clear any lingering hover states so visuals/cursor don't fight.
          safeCall(() => { if (this.hoveredWallId) { this.wallManager?.setHighlight?.(this.hoveredWallId, false); this.hoveredWallId = null; } }, 'hover.clearWall', Severity.COSMETIC);
          safeCall(() => { if (this.hoveredTokenId) { this.tokenManager?.setHover?.(this.hoveredTokenId, false); this.hoveredTokenId = null; } }, 'hover.clearToken', Severity.COSMETIC);
          safeCall(() => { if (this.hoveredOverheadTileId && this.tileManager?.setTileHoverHidden) { this.tileManager.setTileHoverHidden(this.hoveredOverheadTileId, false); this.hoveredOverheadTileId = null; } }, 'hover.clearTile', Severity.COSMETIC);
          safeCall(() => { if (this.hoveringTreeCanopy) { const treeEffect = (window.MapShine || window.mapShine)?.treeEffect; treeEffect?.setHoverHidden?.(false); this.hoveringTreeCanopy = false; } }, 'hover.clearTree', Severity.COSMETIC);

          this.canvasElement.style.cursor = 'pointer';
          return;
        }
      }
    }, 'hover.lightTranslateGizmo', Severity.COSMETIC);

    // 0b. Light radius handles hover (cursor affordance)
    safeCall(() => {
      if (this._lightRadiusRings?.group?.visible && Array.isArray(this._lightRadiusRings.handles) && this._lightRadiusRings.handles.length) {
        const prevMask = this.raycaster.layers?.mask;
        safeCall(() => { this.raycaster.layers.enable(OVERLAY_THREE_LAYER); this.raycaster.layers.enable(0); }, 'hover.radiusLayers', Severity.COSMETIC);

        const hits = this.raycaster.intersectObjects(this._lightRadiusRings.handles, false);

        safeCall(() => { if (typeof prevMask === 'number' && this.raycaster.layers) this.raycaster.layers.mask = prevMask; }, 'hover.restoreRadiusLayers', Severity.COSMETIC);

        if (hits && hits.length > 0) {
          const obj = hits[0]?.object;
          const t = String(obj?.userData?.radiusType || '');
          const label = (t === 'bright') ? 'Bright Radius' : (t === 'dim' ? 'Dim Radius' : 'Light Radius');
          this._showUIHoverLabel(label, event.clientX, event.clientY);
          this.canvasElement.style.cursor = 'ew-resize';
          return;
        }
      }
    }, 'hover.radiusRings', Severity.COSMETIC);

    // If we didn't early-return for gizmo/handle hover, ensure the hover label is hidden.
    // (We intentionally keep it visible while hovering the relevant handle.)
    this._hideUIHoverLabel();

    // 1. Check Overhead Tiles (for hover-to-hide behavior)
    // IMPORTANT: This must run BEFORE wall hover detection.
    // Wall raycasting uses a large line threshold (for UX when selecting walls),
    // which can otherwise steal hover from roofs/overhead tiles (especially indoors).
    if (this.tileManager && this.tileManager.getOverheadTileSprites) {
      const overheadSprites = this.tileManager.getOverheadTileSprites();
      if (overheadSprites.length > 0) {
        // IMPORTANT: Tiles are rendered as THREE.Sprite (billboards). Under a
        // perspective camera, sprite raycasting happens against the billboard
        // plane, which drifts from the intended ground-aligned tile plane toward
        // the edges of the view.
        //
        // For accurate hover picking, raycast once against the tile Z plane and
        // then do a bounds/alpha test against tile docs.

        const THREE = window.THREE;
        let bestTileId = null;
        let bestZ = -Infinity;
        let bestHit = null;
        let bestOpaque = true;

        // Reuse temp for world-position Z ranking.
        const zPos = this._tempVec3ZRank || (this._tempVec3ZRank = new THREE.Vector3());

        // Raycast against the actual overhead sprites (billboards).
        // This aligns hit-testing with what the user sees on screen under a perspective camera.
        //
        // IMPORTANT: Overhead sprites are rendered with ROOF_LAYER enabled (see TileManager).
        // The THREE.Raycaster respects layers, so we must enable ROOF_LAYER here or all
        // overhead picking will silently miss.
        const prevMask = this.raycaster.layers?.mask;
        safeCall(() => { this.raycaster.layers.enable(20); this.raycaster.layers.enable(0); }, 'hover.roofLayers', Severity.COSMETIC);

        const hits = this.raycaster.intersectObjects(overheadSprites, false);

        safeCall(() => { if (typeof prevMask === 'number' && this.raycaster.layers) this.raycaster.layers.mask = prevMask; }, 'hover.restoreRoofLayers', Severity.COSMETIC);
        if (hits && hits.length > 0) {
          for (let i = 0; i < hits.length; i++) {
            const hit = hits[i];
            const sprite = hit?.object;
            const tileId = sprite?.userData?.foundryTileId;
            if (!tileId) continue;

            const data = this.tileManager.tileSprites.get(tileId);
            if (!data) continue;

            // Only apply hover-to-hide to tiles that are explicitly configured
            // as roofs, or which have a non-NONE occlusion mode (typical roof setup).
            // This prevents hiding decorative overhead tiles unexpectedly.
            const hoverEligible = safeCall(() => {
              const tileDoc = data.tileDoc;
              const occlusionMode = tileDoc?.occlusion?.mode ?? CONST.TILE_OCCLUSION_MODES.NONE;
              return !!sprite.userData.isWeatherRoof || (occlusionMode !== CONST.TILE_OCCLUSION_MODES.NONE);
            }, 'hover.checkOcclusion', Severity.COSMETIC, { fallback: true });
            if (!hoverEligible) continue;

            // Pixel-opaque test using UV from the sprite raycast.
            let opaqueHit = true;
            if (typeof this.tileManager.isUvOpaque === 'function' && hit?.uv) {
              opaqueHit = safeCall(() => this.tileManager.isUvOpaque(data, hit.uv), 'hover.uvOpaque', Severity.COSMETIC, { fallback: true });
            }
            if (!opaqueHit) continue;

            // Rank by world Z, not local Z (tiles may be parented under transformed groups).
            const z = safeCall(() => { sprite.getWorldPosition(zPos); return zPos.z; }, 'hover.worldZ', Severity.COSMETIC, { fallback: sprite.position?.z ?? 0 });
            if (z >= bestZ) {
              bestZ = z;
              bestTileId = tileId;
              bestHit = hit;
              bestOpaque = opaqueHit;
            }
          }
        }

        // Update debug marker for the winning hit (or hide when no hit).
        this._updateOverheadHoverDebug(event, bestHit, bestOpaque);

        // NOTE: We intentionally do not implement a world-space "sticky hover" fallback here.
        // The hover test is now based on sprite raycast UVs (screen-aligned). Mixing in a
        // ground-plane bounds check can reintroduce misalignment.

        if (bestTileId) {
          // Clear wall hover highlight while a roof is being hover-hidden.
          // Otherwise the wall selection affordance can fight with the roof UX.
          safeCall(() => { if (this.hoveredWallId) { this.wallManager?.setHighlight?.(this.hoveredWallId, false); this.hoveredWallId = null; } }, 'hover.clearWallForRoof', Severity.COSMETIC);

          if (this.hoveredOverheadTileId !== bestTileId) {
            if (this.hoveredOverheadTileId && this.tileManager.setTileHoverHidden) {
              this.tileManager.setTileHoverHidden(this.hoveredOverheadTileId, false);
            }
            this.hoveredOverheadTileId = null;
          }

          if (this._pendingOverheadTileId !== bestTileId) {
            this._pendingOverheadTileId = bestTileId;
            this._overheadHoverStartMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());

            // IMPORTANT: The hover debounce must NOT require further pointer movement.
            // Without this timer, the hide only triggers when handleHover runs again
            // (usually on mouse move), causing the "jiggle" UX.
            try {
              if (this._overheadHoverTimeoutId != null) {
                clearTimeout(this._overheadHoverTimeoutId);
                this._overheadHoverTimeoutId = null;
              }

              this._overheadHoverTimeoutId = setTimeout(() => {
                try {
                  // Only commit if we're still hovering the same tile.
                  if (!this._pendingOverheadTileId || this._pendingOverheadTileId !== bestTileId) return;

                  this.hoveredOverheadTileId = bestTileId;
                  this._pendingOverheadTileId = null;
                  if (this.tileManager?.setTileHoverHidden) {
                    this.tileManager.setTileHoverHidden(bestTileId, true);
                  }
                } catch (_) {
                }
              }, 1000);
            } catch (_) {
            }
          }

          const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
          if (nowMs - this._overheadHoverStartMs >= 1000) {
            this.hoveredOverheadTileId = bestTileId;
            this._pendingOverheadTileId = null;
            if (this.tileManager.setTileHoverHidden) {
              this.tileManager.setTileHoverHidden(bestTileId, true);
            }

            // If we committed via pointermove, cancel any scheduled commit.
            try {
              if (this._overheadHoverTimeoutId != null) {
                clearTimeout(this._overheadHoverTimeoutId);
                this._overheadHoverTimeoutId = null;
              }
            } catch (_) {
            }
          }
          hitFound = true;
        } else {
          if (this.hoveredOverheadTileId && this.tileManager.setTileHoverHidden) {
            this.tileManager.setTileHoverHidden(this.hoveredOverheadTileId, false);
            this.hoveredOverheadTileId = null;
          }
          this._pendingOverheadTileId = null;

          // No longer hovering any eligible overhead tile: cancel pending debounce.
          try {
            if (this._overheadHoverTimeoutId != null) {
              clearTimeout(this._overheadHoverTimeoutId);
              this._overheadHoverTimeoutId = null;
            }
          } catch (_) {
          }
        }
      }
    }

    // If we hit an overhead tile, don't hover walls/tokens through it.
    if (hitFound) return;

    // 2. Check Walls (Priority for "near line" detection)
    // Only check walls if we are GM or on Wall Layer? Usually useful for everyone if interactive, but editing is GM.
    // The user said "Foundry VTT... making sure it knows you meant to select that wall".
    // We'll enable it for GM mainly for editing, or everyone for doors?
    // Highlighting the whole wall is good for knowing which one you are about to click.
    
    if (game.user.isGM || canvas.activeLayer?.name?.includes('WallsLayer')) {
        const wallGroup = this.wallManager.wallGroup;
        this.raycaster.params.Line.threshold = 20; // Lenient threshold
        const wallIntersects = this.raycaster.intersectObject(wallGroup, true);
        
        if (wallIntersects.length > 0) {
            const hit = wallIntersects[0];
            let object = hit.object;
            while(object && object !== wallGroup) {
                if (object.userData && object.userData.wallId) {
                    const wallId = object.userData.wallId;
                    hitFound = true;
                    
                    if (this.hoveredWallId !== wallId) {
                        if (this.hoveredWallId) {
                            this.wallManager.setHighlight(this.hoveredWallId, false);
                        }
                        this.hoveredWallId = wallId;
                        this.wallManager.setHighlight(this.hoveredWallId, true);
                        this.canvasElement.style.cursor = 'pointer';
                    }
                    break; // Found valid wall part
                }
                object = object.parent;
            }
        }
    }

    if (!hitFound) {
        if (this.hoveredWallId) {
            this.wallManager.setHighlight(this.hoveredWallId, false);
            this.hoveredWallId = null;
            this.canvasElement.style.cursor = 'default';
        }
    }

    // If we hit a wall, we might still want to check tokens if the wall didn't claim it?
    // But if we are "near a line", we probably want the line.
    if (hitFound) return;

    const mapShine = window.MapShine || window.mapShine;
    const treeEffect = mapShine?.treeEffect;
    if (treeEffect && treeEffect.mesh) {
      const treeHits = this.raycaster.intersectObject(treeEffect.mesh, false);
      if (treeHits.length > 0) {
        const hit = treeHits[0];
        let opaqueHit = true;
        if (typeof treeEffect.isUvOpaque === 'function' && hit.uv) {
          opaqueHit = treeEffect.isUvOpaque(hit.uv);
        }

        if (opaqueHit) {
          if (!this.hoveringTreeCanopy && typeof treeEffect.setHoverHidden === 'function') {
            treeEffect.setHoverHidden(true);
            this.hoveringTreeCanopy = true;
          }
        } else if (this.hoveringTreeCanopy && typeof treeEffect.setHoverHidden === 'function') {
          treeEffect.setHoverHidden(false);
          this.hoveringTreeCanopy = false;
        }
      } else if (this.hoveringTreeCanopy && typeof treeEffect.setHoverHidden === 'function') {
        treeEffect.setHoverHidden(false);
        this.hoveringTreeCanopy = false;
      }
    }

    // 3. Check Tokens
    // Tokens may be rendered on the overlay layer (31) to draw above post-processing.
    // Ensure raycasting includes that layer, otherwise tokens won't be clickable/draggable.
    const prevRayMask = this.raycaster.layers?.mask;
    safeCall(() => { this.raycaster.layers?.enable?.(OVERLAY_THREE_LAYER); this.raycaster.layers?.enable?.(0); }, 'hover.tokenLayers', Severity.COSMETIC);

    const interactables = this.tokenManager.getAllTokenSprites();
    const intersects = this.raycaster.intersectObjects(interactables, false);

    safeCall(() => { if (typeof prevRayMask === 'number' && this.raycaster.layers) this.raycaster.layers.mask = prevRayMask; }, 'hover.restoreTokenLayers', Severity.COSMETIC);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const sprite = hit.object;
      const tokenDoc = sprite.userData.tokenDoc;
      
      // Check permissions
      const canControl = tokenDoc.canUserModify(game.user, "update"); // Or just visible? 
      // We want hover even if we can't move it, just to show name.
      
      if (this.hoveredTokenId !== tokenDoc.id) {
        // Hover changed — unhover previous
        if (this.hoveredTokenId) {
          this.tokenManager.setHover(this.hoveredTokenId, false);
          this._syncFoundryHoverOut(this.hoveredTokenId);
        }
        this.hoveredTokenId = tokenDoc.id;
        this.tokenManager.setHover(this.hoveredTokenId, true);
        this._syncFoundryHoverIn(this.hoveredTokenId);
        
        // Cursor
        this.canvasElement.style.cursor = canControl ? 'pointer' : 'default';
      }
    } else {
      // No hit
      if (this.hoveredTokenId) {
        this.tokenManager.setHover(this.hoveredTokenId, false);
        this._syncFoundryHoverOut(this.hoveredTokenId);
        this.hoveredTokenId = null;
        this.canvasElement.style.cursor = 'default';
      }
    }
  }

  /**
   * XM-1: Sync Foundry hover-in state when Three.js detects a new hovered token.
   * Mirrors PlaceableObject._onHoverIn: sets layer.hover, token.hover, fires
   * hoverToken hook, highlights combat tracker entry, and refreshes occlusion.
   * @param {string} tokenId
   * @private
   */
  _syncFoundryHoverIn(tokenId) {
    safeCall(() => {
      const fvttToken = canvas?.tokens?.get?.(tokenId);
      if (!fvttToken) return;

      // Set Foundry's authoritative hover state
      const layer = fvttToken.layer ?? canvas?.tokens;
      if (layer) layer.hover = fvttToken;
      fvttToken.hover = true;

      // Fire the hook that other modules listen to (Token Info, Health Estimate, etc.)
      Hooks.callAll('hoverToken', fvttToken, true);

      // Combat tracker hover highlight (mirrors Token._onHoverIn)
      const combatant = fvttToken.combatant;
      if (combatant) {
        ui?.combat?.hoverCombatant?.(combatant, ui?.combat?._isTokenVisible?.(fvttToken) ?? true);
      }

      // Occlusion refresh for hover-based token occlusion mode
      if (fvttToken.layer?.occlusionMode & CONST?.TOKEN_OCCLUSION_MODES?.HOVERED) {
        canvas?.perception?.update?.({ refreshOcclusion: true });
      }
    }, 'hover.syncFoundryIn', Severity.COSMETIC);
  }

  /**
   * XM-1: Sync Foundry hover-out state when Three.js clears a hovered token.
   * Mirrors PlaceableObject._onHoverOut: clears layer.hover, token.hover, fires
   * hoverToken hook, clears combat tracker highlight, and refreshes occlusion.
   * @param {string} tokenId
   * @private
   */
  _syncFoundryHoverOut(tokenId) {
    safeCall(() => {
      const fvttToken = canvas?.tokens?.get?.(tokenId);
      if (!fvttToken) return;

      // Clear Foundry's authoritative hover state
      const layer = fvttToken.layer ?? canvas?.tokens;
      if (layer && layer.hover === fvttToken) layer.hover = null;
      fvttToken.hover = false;

      // Fire the hook
      Hooks.callAll('hoverToken', fvttToken, false);

      // Combat tracker hover clear
      const combatant = fvttToken.combatant;
      if (combatant) {
        ui?.combat?.hoverCombatant?.(combatant, false);
      }

      // Occlusion refresh
      if (fvttToken.layer?.occlusionMode & CONST?.TOKEN_OCCLUSION_MODES?.HOVERED) {
        canvas?.perception?.update?.({ refreshOcclusion: true });
      }
    }, 'hover.syncFoundryOut', Severity.COSMETIC);
  }

  /**
   * Handle pointer move (drag)
   * @param {PointerEvent} event 
   */
  onPointerMove(event) {
    try {
        if (
          this._isEventFromUI(event) &&
          !this.dragState?.active &&
          !this.dragSelect?.active &&
          !this.wallDraw?.active &&
          !this.lightPlacement?.active &&
          !this.mapPointDraw?.active &&
          !this.rightClickState?.active &&
          !this.moveClickState?.active &&
          !this._pendingLight?.active
        ) {
          return;
        }

        // Track last pointer position for paste placement.
        // Only update when the pointer is actually over the canvas to avoid using
        // stale values from dragging UI.
        safeCall(() => {
          const rect = this.canvasElement.getBoundingClientRect();
          const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
          if (inside && !this._isEventFromUI(event)) {
            this._lastPointerClientX = event.clientX;
            this._lastPointerClientY = event.clientY;

            // WP-7: Sync canvas.mousePosition and broadcast cursor activity
            // when Three.js owns input, mirroring ControlsLayer._onMouseMove.
            const now = performance.now();
            if (now - this._lastCursorBroadcastMs >= this._cursorBroadcastIntervalMs) {
              this._lastCursorBroadcastMs = now;
              const groundZ = this.sceneComposer?.groundZ ?? 0;
              const wp = this.viewportToWorld(event.clientX, event.clientY, groundZ);
              if (wp) {
                const fp = Coordinates.toFoundry(wp.x, wp.y);
                // Keep canvas.mousePosition in sync so Foundry features
                // (cursor display, ruler tooltips) that read it stay correct.
                if (canvas?.mousePosition) {
                  canvas.mousePosition.x = fp.x;
                  canvas.mousePosition.y = fp.y;
                }
                if (game?.user?.hasPermission?.('SHOW_CURSOR')) {
                  game.user.broadcastActivity({ cursor: fp });
                }
              }
            }
          }
        }, 'pointerMove.trackPointer', Severity.COSMETIC);

        // PERFORMANCE: Skip expensive hover detection if mouse is not over the canvas.
        // This prevents raycasting when hovering over Tweakpane UI or other overlays.
        // We still process active drags/draws since those need to track mouse globally.
        const isOverCanvas = event.target === this.canvasElement || 
                             this.canvasElement.contains(event.target);
        
        // WP-3 Ping parity: cancel long-press ping if pointer moves beyond threshold.
        if (this._pingLongPress.timerId != null) {
          const dist = Math.hypot(event.clientX - this._pingLongPress.startX, event.clientY - this._pingLongPress.startY);
          if (dist > this._pingLongPress.threshold) {
            this._cancelPingLongPress();
          }
        }

        // Check Right Click Threshold (Cancel HUD if dragged)
        if (this.rightClickState.active) {
            const dist = Math.hypot(event.clientX - this.rightClickState.startPos.x, event.clientY - this.rightClickState.startPos.y);
            if (dist > this.rightClickState.threshold) {
                log.debug(`Right click cancelled: moved ${dist.toFixed(1)}px (threshold ${this.rightClickState.threshold}px)`);
                this.rightClickState.active = false; // It's a drag/pan, not a click
            }
        }

        if (this.moveClickState.active) {
          const dist = Math.hypot(event.clientX - this.moveClickState.startPos.x, event.clientY - this.moveClickState.startPos.y);
          if (dist > this.moveClickState.threshold) {
            this._pathfindingLog('warn', 'click-to-move cancelled due drag threshold (panning/drag detected)', {
              button: this.moveClickState.button,
              dist,
              threshold: this.moveClickState.threshold,
              tokenId: String(this.moveClickState.tokenDoc?.id || ''),
              selectedTokenCount: Array.isArray(this.moveClickState.tokenDocs) ? this.moveClickState.tokenDocs.length : 0
            });
            this._resetMoveClickState();
          }
        }

        // Pending light interaction: start drag only after crossing a screen-space threshold.
        if (this._pendingLight?.active && !this.dragState?.active) {
          const dx = event.clientX - this._pendingLight.startClientX;
          const dy = event.clientY - this._pendingLight.startClientY;
          const dist = Math.hypot(dx, dy);
          if (dist > (this._pendingLight.thresholdPx ?? 8)) {
            if (this._pendingLight.canEdit && this._pendingLight.sprite && this._pendingLight.hitPoint) {
              // Hide the radius slider overlay immediately; the per-frame gizmo update will
              // also keep it hidden while dragging.
              safeCall(() => { const ui = this._radiusSliderUI; if (ui?.el) ui.el.style.display = 'none'; }, 'pointerMove.hideRadiusSlider', Severity.COSMETIC);

              this.startDrag(this._pendingLight.sprite, this._pendingLight.hitPoint);
            }

            // Consume the pending state regardless of edit permission.
            this._pendingLight.active = false;
            this._pendingLight.type = null;
            this._pendingLight.id = null;
            this._pendingLight.sprite = null;
            this._pendingLight.hitPoint = null;
          }
        }

        // Case 0: Map Point Drawing Preview
        if (this.mapPointDraw.active) {
          const worldPos = this.screenToWorld(event.clientX, event.clientY);
          if (worldPos) {
            // Snapping logic matches _addMapPoint:
            // - If snapToGrid is ON: snap unless Shift is held
            // - If snapToGrid is OFF (default): only snap when Shift IS held
            let cursorX = worldPos.x;
            let cursorY = worldPos.y;
            const shouldSnap = this.mapPointDraw.snapToGrid ? !event.shiftKey : event.shiftKey;
            
            if (shouldSnap) {
              // Use resolution=2 for half-grid subdivisions
              const snapped = this.snapToGrid(worldPos.x, worldPos.y, CONST.GRID_SNAPPING_MODES.CENTER | CONST.GRID_SNAPPING_MODES.VERTEX | CONST.GRID_SNAPPING_MODES.CORNER | CONST.GRID_SNAPPING_MODES.SIDE_MIDPOINT, 2);
              cursorX = snapped.x;
              cursorY = snapped.y;
            }
            this.mapPointDrawHandler.updateCursorPreview(cursorX, cursorY);
          }
          // Don't return - allow other hover effects to work
        }

        // Case 0.5: Wall Drawing
        if (this.wallDraw.active) {
          this.updateMouseCoords(event);
          const worldPos = this.viewportToWorld(event.clientX, event.clientY, 0);
          if (worldPos) {
            // Snap current position
            const foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);
            
            let snapped;
            if (event.shiftKey) {
              snapped = foundryPos;
            } else {
              const M = CONST.GRID_SNAPPING_MODES;
              const size = canvas.dimensions.size;
              const resolution = size >= 128 ? 8 : (size >= 64 ? 4 : 2);
              const mode = canvas.forceSnapVertices ? M.VERTEX : (M.CENTER | M.VERTEX | M.CORNER | M.SIDE_MIDPOINT);
              
              snapped = this.snapToGrid(foundryPos.x, foundryPos.y, mode, resolution);
            }
            
            const snappedWorld = Coordinates.toWorld(snapped.x, snapped.y);
            
            this.wallDraw.current.set(snappedWorld.x, snappedWorld.y, 0);
            
            // Update geometry (Mesh transform)
            const dx = this.wallDraw.current.x - this.wallDraw.start.x;
            const dy = this.wallDraw.current.y - this.wallDraw.start.y;
            const length = Math.sqrt(dx*dx + dy*dy);
            const angle = Math.atan2(dy, dx);
            
            const mesh = this.wallDraw.previewLine;
            mesh.position.set(
                (this.wallDraw.start.x + this.wallDraw.current.x) / 2,
                (this.wallDraw.start.y + this.wallDraw.current.y) / 2,
                3.5
            );
            mesh.rotation.z = angle;
            mesh.scale.set(length, 1, 1);
          }
          return;
        }

        // Case 0.25: Light Placement Drag
        if (this.lightPlacement.active) {
             // If the pointer is currently over UI (dialogs/filepickers), never update the
             // scene-side placement preview.
             if (this._isEventFromUI(event)) return;
             this.updateMouseCoords(event);
             const targetZ = this.lightPlacement.start?.z ?? (this.sceneComposer?.groundZ ?? 0);
             const worldPos = this.viewportToWorld(event.clientX, event.clientY, targetZ);
             if (worldPos) {
                 // Update current position (snap not strictly required for radius, but usually destination is free)
                 // Foundry's light drag usually doesn't snap destination unless Shift?
                 // Actually code says: "Snap the origin... Update the light radius... const radius = Math.hypot(destination.x - origin.x, ...)"
                 // Destination is raw event data usually.
                 this.lightPlacement.current.set(worldPos.x, worldPos.y, targetZ);
                 
                 // Calculate radius in World Units
                 const dx = this.lightPlacement.current.x - this.lightPlacement.start.x;
                 const dy = this.lightPlacement.current.y - this.lightPlacement.start.y;
                 const radius = Math.sqrt(dx*dx + dy*dy);

                 // Update Visuals: rebuild wall-clipped polygon geometry in real time.
                 this._updateLightPlacementPreviewGeometry(this.lightPlacement, this.lightPlacement.start, Math.max(radius, 0.1));
             }
             return;
        }


        // Case 0.4: Map Point Handle Drag
        if (this.dragState.active && this.dragState.mode === 'mapPointHandle') {
          this.updateMouseCoords(event);
          const targetZ = this.dragState.object?.position?.z ?? (this.sceneComposer?.groundZ ?? 0);
          const worldPos = this.viewportToWorld(event.clientX, event.clientY, targetZ);
          if (worldPos && this.dragState.object) {
            let x = worldPos.x + this.dragState.offset.x;
            let y = worldPos.y + this.dragState.offset.y;

            if (event.shiftKey) {
              const snapped = this.snapToGrid(
                x,
                y,
                CONST.GRID_SNAPPING_MODES.CENTER | CONST.GRID_SNAPPING_MODES.VERTEX | CONST.GRID_SNAPPING_MODES.CORNER | CONST.GRID_SNAPPING_MODES.SIDE_MIDPOINT,
                2
              );
              x = snapped.x;
              y = snapped.y;
            }

            this.dragState.object.position.set(x, y, targetZ);
            this.dragState.hasMoved = true;

            const idx = this.dragState.mapPointIndex;
            if (Array.isArray(this.dragState.mapPointPoints) && Number.isFinite(idx) && this.dragState.mapPointPoints[idx]) {
              this.dragState.mapPointPoints[idx].x = x;
              this.dragState.mapPointPoints[idx].y = y;
            }

            this.mapPointDrawHandler.updateDraggedHelperGeometry();
          }
          return;
        }

        // Case 0.5: Wall Endpoint Drag
        if (this.dragState.active && this.dragState.mode === 'wallEndpoint') {
            this.updateMouseCoords(event);
            const worldPos = this.viewportToWorld(event.clientX, event.clientY, 0); // Walls are at Z=0? No, Z=3. But we project to Z=0 plane usually for grid.
            // Let's project to Z=0 or Z=3.
            if (worldPos) {
                 const foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);
                 let snapped;
                 if (event.shiftKey) {
                     snapped = foundryPos;
                 } else {
                     const M = CONST.GRID_SNAPPING_MODES;
                     const size = canvas.dimensions.size;
                     const resolution = size >= 128 ? 8 : (size >= 64 ? 4 : 2);
                     const mode = canvas.forceSnapVertices ? M.VERTEX : (M.CENTER | M.VERTEX | M.CORNER | M.SIDE_MIDPOINT);
                     
                     snapped = this.snapToGrid(foundryPos.x, foundryPos.y, mode, resolution);
                 }
                 const snappedWorld = Coordinates.toWorld(snapped.x, snapped.y);
                 
                 // Update Visuals (Optimistic)
                 // We need to update the Line and the Endpoint
                 const wallGroup = this.dragState.object.parent;
                 // Check if parent is still valid (might have been removed if update happened during drag? Unlikely for GM drag)
                 if (!wallGroup) return;

                 const wallMesh = wallGroup.children.find(c => c.userData.type === 'wallLine');
                 const endpoint = this.dragState.object;
                 
                 // Local Z should be 0 relative to wallGroup
                 endpoint.position.set(snappedWorld.x, snappedWorld.y, 0); 
                 
                 if (wallMesh) {
                     // Find other endpoint
                     const otherIndex = this.dragState.endpointIndex === 0 ? 1 : 0;
                     const otherEndpoint = wallGroup.children.find(c => 
                         c.userData.type === 'wallEndpoint' && c.userData.index === otherIndex
                     );
                     
                     if (otherEndpoint) {
                         const start = endpoint.position;
                         const end = otherEndpoint.position;
                         
                         const dx = end.x - start.x;
                         const dy = end.y - start.y;
                         const dist = Math.sqrt(dx*dx + dy*dy);
                         const angle = Math.atan2(dy, dx);
                         
                         wallMesh.position.set((start.x + end.x)/2, (start.y + end.y)/2, 0);
                         wallMesh.rotation.z = angle;
                         
                         // Scale width based on original geometry
                         const originalLength = wallMesh.geometry.parameters.width;
                         if (originalLength > 0) {
                             wallMesh.scale.setX(dist / originalLength);
                         }
                         
                         // Update Hitbox
                         const hitbox = wallGroup.children.find(c => c.userData.type === 'wallHitbox');
                         if (hitbox) {
                             hitbox.position.copy(wallMesh.position);
                             hitbox.rotation.copy(wallMesh.rotation);
                             hitbox.scale.copy(wallMesh.scale);
                         }
                     }
                 }
            }
            return;
        }

        // Case 1: Drag Select
        if (this.dragSelect.active) {
          if (!this.dragSelect.dragging) {
            const dist = Math.hypot(
              event.clientX - this.dragSelect.screenStart.x,
              event.clientY - this.dragSelect.screenStart.y
            );

            if (dist < this.dragSelect.threshold) {
              return;
            }

            this.dragSelect.dragging = true;
          }

          this.updateMouseCoords(event);
          
          // World-space current for selection math
          const groundZ = this.sceneComposer?.groundZ ?? 0;
          const worldPos = this.viewportToWorld(event.clientX, event.clientY, groundZ);
          if (worldPos) {
            this.dragSelect.current.copy(worldPos);
          }

          // Screen-space current for visual overlay
          this.dragSelect.screenCurrent.set(event.clientX, event.clientY);
          const overlay = this.dragSelect.overlayEl;
          const selectionEnabled = this.selectionBoxParams?.enabled !== false;
          if (overlay && selectionEnabled) {
            const x1 = this.dragSelect.screenStart.x;
            const y1 = this.dragSelect.screenStart.y;
            const x2 = this.dragSelect.screenCurrent.x;
            const y2 = this.dragSelect.screenCurrent.y;

            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const width = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);

            overlay.style.left = `${left}px`;
            overlay.style.top = `${top}px`;
            overlay.style.width = `${width}px`;
            overlay.style.height = `${height}px`;
            overlay.style.display = 'block';

            // Delegate overlay geometry/label updates to the SelectionBoxEffect.
            safeCall(() => { this.selectionBoxEffect?.updateOverlayGeometry?.(width, height); this.selectionBoxEffect?.updateLabel?.(width, height); }, 'dragSelect.updateOverlay', Severity.COSMETIC);
          } else if (overlay) {
            overlay.style.display = 'none';
            safeCall(() => this.selectionBoxEffect?.updateLabel?.(0, 0), 'dragSelect.clearLabel', Severity.COSMETIC);
          }

          // World-space projected shadow
          safeCall(() => {
            if (selectionEnabled) this.selectionBoxEffect?.updateShadowFromDrag?.();
            else this.selectionBoxEffect?._hideSelectionShadow?.();
          }, 'dragSelect.shadow', Severity.COSMETIC);

          return;
        }

        // Case 2: Hover (if not dragging object)
        // PERFORMANCE: Only do expensive hover raycasting if mouse is over the canvas.
        // This prevents frame drops when hovering over Tweakpane UI.
        if ((!this.dragState.active || !this.dragState.object) && this.dragState.mode !== 'radiusEdit') {
          if (isOverCanvas) {
            this.handleHover(event);
          }
          return;
        }

        // Case 3a: Radius Edit Drag (special handling for light radius handles)
        if (this.dragState.mode === 'radiusEdit' && this._lightRadiusRings?.dragging) {
          this.updateMouseCoords(event);
          
          const sel = this._lightRadiusRings.selected;
          if (sel) {
            const zoom = this._getEffectiveZoom();
            const dxPx = (event.clientX - (this._lightRadiusRings.startClientX || 0));
            const deltaWorld = dxPx / Math.max(zoom, 0.0001);

            const type = this._lightRadiusRings.dragging;
            const startBright = this._lightRadiusRings.startBright ?? 0;
            const startDim = this._lightRadiusRings.startDim ?? 0;

            let newBright = startBright;
            let newDim = startDim;

            if (type === 'bright') {
              newBright = Math.max(0, startBright + deltaWorld);
              newBright = Math.min(newBright, startDim);
            } else {
              newDim = Math.max(0, startDim + deltaWorld);
              newDim = Math.max(newDim, startBright);
            }

            // Snap to grid if Shift is NOT held
            if (!event.shiftKey) {
              const gridSize = canvas?.scene?.grid?.size || 100;
              newBright = Math.round(newBright / gridSize) * gridSize;
              newDim = Math.round(newDim / gridSize) * gridSize;
            }

            this._lightRadiusRings.previewBright = newBright;
            this._lightRadiusRings.previewDim = newDim;

            // Preview the radius change during drag.
            if (type === 'bright') this._previewRadiusChange(sel, 'bright', newBright);
            else this._previewRadiusChange(sel, 'dim', newDim);

            // Apply continuously while dragging so lighting updates in real time.
            // Still throttled + guarded against overlapping updates.
            this._applyPendingRadiusLive(sel);
          }
          return;
        }

        // Case 3b: Object Drag
        this.dragState.hasMoved = true;
        this.updateMouseCoords(event);
        
        // Raycast to find world position on a stable plane.
        // For token drags we project onto the ground plane to avoid coupling drag X/Y
        // to the token's Z (elevation) under a perspective camera.
        const isTokenDrag = !!(this.tokenManager?.tokenSprites?.has?.(this.dragState.leaderId));
        const targetZ = isTokenDrag ? (this.sceneComposer?.groundZ ?? 0) : this.dragState.object.position.z;
        
        // Get world position at the chosen Z plane
        const worldPos = this.viewportToWorld(event.clientX, event.clientY, targetZ);
        
        if (worldPos) {
          // DEBUG: Log drag details
          log.debug(`Drag: Mouse(${event.clientX}, ${event.clientY}) -> World(${worldPos.x.toFixed(1)}, ${worldPos.y.toFixed(1)}, ${worldPos.z.toFixed(1)})`);

          // Calculate the new position
          // We want to maintain the offset from the grab point to the object center
          let x = worldPos.x + this.dragState.offset.x;
          let y = worldPos.y + this.dragState.offset.y;

          // For light icon drags, we do NOT snap to grid; they should move freely.
          const isFoundryLightDrag = this.lightIconManager && this.lightIconManager.lights && this.lightIconManager.lights.has(this.dragState.leaderId);
          const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
          const isEnhancedLightDrag = !!(enhancedLightIconManager && enhancedLightIconManager.lights && enhancedLightIconManager.lights.has(this.dragState.leaderId));
          const isLightDrag = isFoundryLightDrag || isEnhancedLightDrag;
          
          // Snap to grid logic if Shift is NOT held and this is NOT a light drag.
          // Token drags should preview on-grid so users see the final landing cell.
          if (!event.shiftKey && !isLightDrag) {
            const foundryPos = Coordinates.toFoundry(x, y);
            const snapped = this.snapToGrid(foundryPos.x, foundryPos.y);
            const snappedWorld = Coordinates.toWorld(snapped.x, snapped.y);
            x = snappedWorld.x;
            y = snappedWorld.y;
          }

          // Calculate delta from LEADER's initial position
          const leaderInitial = this.dragState.initialPositions.get(this.dragState.leaderId);
          if (!leaderInitial) return;

          let deltaX = x - leaderInitial.x;
          let deltaY = y - leaderInitial.y;

          // Axis constraint for light translate gizmo.
          if (this.dragState.mode === 'lightTranslate') {
            const axis = String(this.dragState.axis || 'xy');
            if (axis === 'x') deltaY = 0;
            else if (axis === 'y') deltaX = 0;
          }

          // Apply delta to ALL previews
          for (const [id, preview] of this.dragState.previews) {
            const initialPos = this.dragState.initialPositions.get(id);
            if (initialPos) {
              preview.position.x = initialPos.x + deltaX;
              preview.position.y = initialPos.y + deltaY;
            } 
          }

          // Enhanced lights: recompute the LOS-clipped radius polygon at ~15hz while dragging.
          // This lets the user see the true end-state shape while moving the light.
          safeCall(() => {
            if (isEnhancedLightDrag) {
              const enhancedLightIconManager2 = window.MapShine?.enhancedLightIconManager;
              const lightingEffect = window.MapShine?.lightingEffect;
              const hz = Math.max(1, Number(this._enhancedLightDragRadiusHz) || 90);
              const intervalMs = 1000 / hz;
              const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
              if (enhancedLightIconManager2 && (nowMs - (this._enhancedLightDragLastRadiusRefreshMs || 0)) >= intervalMs) {
                this._enhancedLightDragLastRadiusRefreshMs = nowMs;

                for (const [pid, p] of this.dragState.previews) {
                  if (enhancedLightIconManager2.lights?.has?.(pid)) {
                    enhancedLightIconManager2.refreshRadiusGeometry?.(p);

                    // Also update the actual MapShine light contribution while dragging so the
                    // user sees the true lighting result in real time.
                    safeCall(() => {
                      const src = lightingEffect?.mapshineLights?.get?.(`mapshine:${pid}`);
                      if (src?.document) {
                        // Diagnostics: if the light appears to get ~2x brighter while dragging,
                        // the most likely causes are:
                        // 1) duplicate additive meshes for the same light (double contribution)
                        // 2) the shader uniforms changing unexpectedly during drag updates
                        // We only log when an anomaly is detected, and rate-limit logs.
                        const dbgNow = nowMs;
                        const dbgKey = `mapshine:${pid}`;
                        if (!this._enhancedLightDragDebug) this._enhancedLightDragDebug = new Map();
                        const dbg = this._enhancedLightDragDebug.get(dbgKey) || { lastLogMs: -Infinity };

                        const before = safeCall(() => {
                          const u = src.material?.uniforms;
                          if (u) return { brightness: u.uBrightness?.value, alpha: u.uAlpha?.value, intensity: u.uIntensity?.value };
                          return null;
                        }, 'lightDrag.snapshotUniforms', Severity.COSMETIC, { fallback: null });

                        const foundryPos = Coordinates.toFoundry(p.position.x, p.position.y);
                        // IMPORTANT: Do not create a new doc object here.
                        // Re-creating the document can subtly change which fields are present
                        // (and therefore perceived brightness). We only want to move the light.
                        src.document.x = foundryPos.x;
                        src.document.y = foundryPos.y;
                        // Force rebuild so the wall-clipped polygon updates with position.
                        src.updateData?.(src.document, true);

                        safeCall(() => {
                          // Mitigation: if we ever end up with duplicate meshes for the same light
                          // in the light scene, brightness will roughly double due to additive blending.
                          // Enforce that only src.mesh remains.
                          safeCall(() => {
                            if (src.mesh) {
                              src.mesh.userData = src.mesh.userData || {};
                              src.mesh.userData.lightId = src.id;
                            }

                            const sceneParent = lightingEffect?.lightScene;
                            if (sceneParent?.children && Array.isArray(sceneParent.children) && typeof sceneParent.remove === 'function') {
                              for (let i = sceneParent.children.length - 1; i >= 0; i--) {
                                const c = sceneParent.children[i];
                                const isThisLight = (c?.userData?.lightId === src.id) || (c?.material === src.material);
                                if (!isThisLight) continue;

                                // Keep the currently tracked mesh; remove any others.
                                if (c !== src.mesh) {
                                  sceneParent.remove(c);
                                  safeCall(() => c.geometry?.dispose?.(), 'lightDrag.disposeOrphan', Severity.COSMETIC);
                                }
                              }
                            }
                          }, 'lightDrag.dedupeMeshes', Severity.COSMETIC);

                          // Check for duplicate meshes under the light scene.
                          const parent = src.mesh?.parent ?? lightingEffect?.lightScene;
                          let dupeCount = 0;
                          if (parent?.children && Array.isArray(parent.children)) {
                            for (let i = 0; i < parent.children.length; i++) {
                              const c = parent.children[i];
                              const isThisLight = (c?.userData?.lightId === src.id) || (c?.material === src.material);
                              if (isThisLight) dupeCount++;
                            }
                          }

                          // Check for uniform drift.
                          const u2 = src.material?.uniforms;
                          const after = u2 ? {
                            brightness: u2.uBrightness?.value,
                            alpha: u2.uAlpha?.value,
                            intensity: u2.uIntensity?.value
                          } : null;

                          const changed = !!(
                            before && after &&
                            ((Number.isFinite(before.brightness) && Number.isFinite(after.brightness) && Math.abs(before.brightness - after.brightness) > 1e-4) ||
                             (Number.isFinite(before.alpha) && Number.isFinite(after.alpha) && Math.abs(before.alpha - after.alpha) > 1e-4) ||
                             (Number.isFinite(before.intensity) && Number.isFinite(after.intensity) && Math.abs(before.intensity - after.intensity) > 1e-4))
                          );

                          const hasDupes = dupeCount > 1;
                          const shouldLog = (hasDupes || changed) && ((dbgNow - (dbg.lastLogMs || 0)) > 350);
                          if (shouldLog) {
                            dbg.lastLogMs = dbgNow;
                            this._enhancedLightDragDebug.set(dbgKey, dbg);
                            log.warn(
                              `Enhanced light drag anomaly for ${dbgKey}: ` +
                              `dupeMeshes=${dupeCount}, ` +
                              `uBrightness ${before?.brightness} -> ${after?.brightness}, ` +
                              `uAlpha ${before?.alpha} -> ${after?.alpha}, ` +
                              `uIntensity ${before?.intensity} -> ${after?.intensity}`
                            );
                          }

                          // Last-resort guard: if brightness-related uniforms drift during the
                          // drag update, restore them so the visual result stays stable.
                          if (changed && before && u2) {
                            safeCall(() => {
                              if (u2.uBrightness && Number.isFinite(before.brightness)) u2.uBrightness.value = before.brightness;
                              if (u2.uAlpha && Number.isFinite(before.alpha)) u2.uAlpha.value = before.alpha;
                              if (u2.uIntensity && Number.isFinite(before.intensity)) u2.uIntensity.value = before.intensity;
                            }, 'lightDrag.restoreUniforms', Severity.COSMETIC);
                          }
                        }, 'lightDrag.dupeCheck', Severity.COSMETIC);
                      }
                    }, 'lightDrag.enhancedUpdate', Severity.COSMETIC);
                  }
                }
              }
            }
          }, 'lightDrag.enhancedRadiusRefresh', Severity.COSMETIC);

          if (isTokenDrag) {
            this._updateTokenDragPathPreview();
          } else {
            this._clearMovementPathPreview();
          }
          
          // NOTE: Vision updates during drag are now handled natively by Foundry.
          // FogEffect uses FoundryFogBridge to extract Foundry's vision textures directly,
          // so we don't need to manually update a custom VisionManager.
        }
    } catch (error) {
        log.error('Error in onPointerMove:', error);
    }
  }

  /**
   * Cancel any pending ping long-press timer.
   * @private
   */
  _cancelPingLongPress() {
    if (this._pingLongPress.timerId != null) {
      clearTimeout(this._pingLongPress.timerId);
      this._pingLongPress.timerId = null;
    }
  }

  /**
   * Handle pointer up (end drag)
   * @param {PointerEvent} event 
   */
  async onPointerUp(event) {
    try {
        // WP-3: Cancel ping long-press on any pointer up.
        this._cancelPingLongPress();

        if (
          this._isEventFromUI(event) &&
          !this.dragState?.active &&
          !this.dragSelect?.active &&
          !this.wallDraw?.active &&
          !this.lightPlacement?.active &&
          !this.mapPointDraw?.active &&
          !this.rightClickState?.active &&
          !this.moveClickState?.active &&
          !this._pendingLight?.active
        ) {
          return;
        }

        // Pending light click: only open the editor on a true click (no drag threshold exceeded).
        if (this._pendingLight?.active) {
          const sprite = this._pendingLight.sprite;
          const id = this._pendingLight.id;
          const type = this._pendingLight.type;
          const forceSheet = !!this._pendingLight.forceSheet;

          this._pendingLight.active = false;
          this._pendingLight.type = null;
          this._pendingLight.id = null;
          this._pendingLight.sprite = null;
          this._pendingLight.hitPoint = null;
          this._pendingLight.canEdit = false;

          if (sprite && id && type) {
            safeCall(() => {
              const lightEditor = window.MapShine?.lightEditor;
              if (type === 'foundry') {
                const light = canvas?.lighting?.get?.(id);
                const doc = light?.document;
                if (doc && doc.testUserPermission(game.user, 'LIMITED')) {
                  if (forceSheet) {
                    light?.sheet?.render?.(true);
                  } else {
                    lightEditor?.show?.({ type: 'foundry', id: String(id) }, sprite);
                  }
                }
              } else if (type === 'enhanced') {
                const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
                const root = enhancedLightIconManager?.getRootObject?.(id) || sprite;
                lightEditor?.show?.({ type: 'enhanced', id: String(id) }, root);
              }
            }, 'pointerUp.lightEditorShow', Severity.COSMETIC);
          }

          return;
        }

        // Handle Radius Edit drag end
        if (this.dragState?.mode === 'radiusEdit' && this._lightRadiusRings?.dragging) {
          this._commitRadiusChange();
          return;
        }

        safeCall(() => this._hideUIHoverLabel(), 'pointerUp.hideHoverLabel', Severity.COSMETIC);

        if (this.moveClickState.active && event.button === this.moveClickState.button) {
          const pendingTokenDoc = this.moveClickState.tokenDoc;
          const pendingTokenDocs = this.moveClickState.tokenDocs;
          const pendingWorldPos = this.moveClickState.worldPos;

          this._resetMoveClickState();

          if (pendingTokenDoc && pendingWorldPos) {
            await safeCall(async () => {
              await this._handleRightClickMovePreview(pendingTokenDoc, pendingWorldPos, pendingTokenDocs);
            }, 'pointerUp.clickMovePreview', Severity.DEGRADED);

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
          }

          this._pathfindingLog('warn', 'click-to-move pointer-up had incomplete pending state', {
            hasPendingTokenDoc: !!pendingTokenDoc,
            hasPendingWorldPos: !!pendingWorldPos,
            button: event.button
          });
        }

        // Handle Right Click (HUD toggle)
        if (event.button === 2 && this.rightClickState.active) {
            const tokenId = this.rightClickState.tokenId;
            
            this.rightClickState.active = false;
            this.rightClickState.tokenId = null;

            const token = canvas.tokens.get(tokenId);
            if (token && token.layer.hud) {
                // If HUD is already open for this token, close it (toggle behavior)
                if (this.openHudTokenId === tokenId) {
                    log.debug(`Right click up: Closing HUD for ${tokenId}`);
                    token.layer.hud.close();
                    this.openHudTokenId = null;
                } else {
                    // Check permission again just to be safe, though HUD will also check
                    if (token.document.isOwner) {
                        log.debug(`Right click up: Opening HUD for ${tokenId}`);
                        token.layer.hud.bind(token);
                        this.openHudTokenId = tokenId;
                        // Force immediate position update
                        this.updateHUDPosition();
                    } else {
                        log.warn(`User is not owner of token ${token.name}, cannot open HUD`);
                    }
                }
            } else {
                log.warn(`Token ${tokenId} or HUD not found`);
            }
            // Prevent context menu since we handled it
            event.preventDefault();
            return;
        }

        // Handle Light Placement End
        if (this.lightPlacement.active) {
            this.lightPlacement.active = false;
            this.lightPlacement.previewGroup.visible = false;

            // Re-enable camera controls
            if (window.MapShine?.cameraController) {
                window.MapShine.cameraController.enabled = true;
            }

            // If the pointer is released over UI (dialogs/filepickers), never create a light.
            if (this._isEventFromUI(event)) {
                return;
            }

            // Calculate final parameters
            const startWorld = this.lightPlacement.start;
            const currentWorld = this.lightPlacement.current;

            // Convert to Foundry Coords
            const startF = Coordinates.toFoundry(startWorld.x, startWorld.y);
            const currentF = Coordinates.toFoundry(currentWorld.x, currentWorld.y);

            // Calculate Radius in Pixels
            const dx = currentF.x - startF.x;
            const dy = currentF.y - startF.y;
            const radiusPixels = Math.hypot(dx, dy);

            // Minimum threshold to prevent accidental tiny lights (e.g. just a click)
            // If click (< 10px drag), use default logic
            let bright, dim;
            const isClick = radiusPixels < 10;

            if (isClick) {
                return;
            }

            // Convert Pixel Radius to Distance Units
            // dim = radius * (distance / size)
            const d = canvas?.dimensions;
            const grid = canvas?.grid;
            const gridSizeX = (grid && typeof grid.sizeX === 'number' && grid.sizeX > 0) ? grid.sizeX : null;
            const gridSizeY = (grid && typeof grid.sizeY === 'number' && grid.sizeY > 0) ? grid.sizeY : null;
            const pxPerGrid = (gridSizeX && gridSizeY)
              ? (0.5 * (gridSizeX + gridSizeY))
              : (d?.size ?? 100);
            const distPerGrid = (d && typeof d.distance === 'number' && d.distance > 0) ? d.distance : 1;
            const conversion = distPerGrid / pxPerGrid;
            dim = radiusPixels * conversion;
            bright = dim / 2;

            const data = {
                x: startF.x,
                y: startF.y,
                config: {
                    bright: bright,
                    dim: dim,
                    luminosity: 0.5,
                    attenuation: 0.5,
                    rotation: 0,
                    angle: 360,
                    color: null,
                    darkness: { min: 0, max: 1 }
                }
            };

            // Seed missing elevation/range defaults from the active Levels band.
            // This keeps newly drawn lights scoped to the currently viewed floor.
            applyAmbientLightLevelDefaults(data, { scene: canvas?.scene });

            await safeCall(async () => {
                await canvas.scene.createEmbeddedDocuments('AmbientLight', [data]);
                log.info(`Created AmbientLight at (${startF.x.toFixed(1)}, ${startF.y.toFixed(1)}) with dim radius ${dim.toFixed(1)}`);
            }, 'pointerUp.createLight', Severity.DEGRADED);
            
            return;
        }


        // Handle Wall Endpoint Drag End
        if (this.dragState.active && this.dragState.mode === 'wallEndpoint') {
          this.dragState.active = false;
          this.dragState.mode = null;
          
          // Re-enable camera controls
          if (window.MapShine?.cameraController) {
            window.MapShine.cameraController.enabled = true;
          }
          
          const endpoint = this.dragState.object;
          const wallId = this.dragState.wallId;
          const index = this.dragState.endpointIndex;
          const wall = canvas.walls.get(wallId);
          
          if (wall) {
              // Current world position of endpoint
              const worldPos = endpoint.position;
              const foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);
              
              // Update document
              // doc.c is [x0, y0, x1, y1]
              const c = [...wall.document.c];
              if (index === 0) {
                  c[0] = foundryPos.x;
                  c[1] = foundryPos.y;
              } else {
                  c[2] = foundryPos.x;
                  c[3] = foundryPos.y;
              }
              
              await safeCall(async () => {
                  await wall.document.update({c});
                  log.info(`Updated wall ${wallId} coords`);
              }, 'pointerUp.updateWall', Severity.DEGRADED, {
                  onError: () => this.wallManager.update(wall.document, {c: wall.document.c})
              });
          }
          
          this.dragState.object = null;
          return;
        }

        // Handle Map Point Handle Drag End
        if (this.dragState.active && this.dragState.mode === 'mapPointHandle') {
          const mapPointsManager = window.MapShine?.mapPointsManager;
          const groupId = this.dragState.mapPointGroupId;
          const points = this.dragState.mapPointPoints;

          this.dragState.active = false;
          this.dragState.mode = null;

          // Re-enable camera controls
          if (window.MapShine?.cameraController) {
            window.MapShine.cameraController.enabled = true;
          }

          if (mapPointsManager && groupId && Array.isArray(points) && points.length > 0) {
            await safeCall(async () => {
              const existingGroup = mapPointsManager.getGroup(groupId);
              const isExistingRopeGroup = existingGroup?.effectTarget === 'rope' || existingGroup?.type === 'rope';
              const updates = {
                points: points.map((p) => ({ x: p.x, y: p.y }))
              };
              if (isExistingRopeGroup) {
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'ropeType')) updates.ropeType = existingGroup.ropeType;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'texturePath')) updates.texturePath = existingGroup.texturePath;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'segmentLength')) updates.segmentLength = existingGroup.segmentLength;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'damping')) updates.damping = existingGroup.damping;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'windForce')) updates.windForce = existingGroup.windForce;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'springConstant')) updates.springConstant = existingGroup.springConstant;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'tapering')) updates.tapering = existingGroup.tapering;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'width')) updates.width = existingGroup.width;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'uvRepeatWorld')) updates.uvRepeatWorld = existingGroup.uvRepeatWorld;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'zOffset')) updates.zOffset = existingGroup.zOffset;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'ropeEndStiffness')) updates.ropeEndStiffness = existingGroup.ropeEndStiffness;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'windowLightBoost')) updates.windowLightBoost = existingGroup.windowLightBoost;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'endFadeSize')) updates.endFadeSize = existingGroup.endFadeSize;
                if (Object.prototype.hasOwnProperty.call(existingGroup, 'endFadeStrength')) updates.endFadeStrength = existingGroup.endFadeStrength;
              }
              await mapPointsManager.updateGroup(groupId, {
                ...updates
              });

              if (mapPointsManager.showVisualHelpers) {
                const group = mapPointsManager.getGroup(groupId);
                if (group) {
                  mapPointsManager.createVisualHelper(groupId, group);
                }
              }
            }, 'pointerUp.updateMapPointGroup', Severity.DEGRADED);
          }

          this.dragState.object = null;
          this.dragState.mapPointGroupId = null;
          this.dragState.mapPointIndex = null;
          this.dragState.mapPointPoints = null;
          return;
        }

        // Handle Wall Draw End
        if (this.wallDraw.active) {
          this.wallDraw.active = false;
          
          // Hide preview
          if (this.wallDraw.previewLine) {
            this.wallDraw.previewLine.visible = false;
          }
          
          // Re-enable camera controls
          if (window.MapShine?.cameraController) {
            window.MapShine.cameraController.enabled = true;
          }
          
          // Create Wall
          const startF = Coordinates.toFoundry(this.wallDraw.start.x, this.wallDraw.start.y);
          const endF = Coordinates.toFoundry(this.wallDraw.current.x, this.wallDraw.current.y);
          
          // Ignore zero-length walls
          if (startF.x === endF.x && startF.y === endF.y) return;
          
          // Prepare Data based on tool
          const data = this.getWallData(this.wallDraw.type, [startF.x, startF.y, endF.x, endF.y]);
          
          await safeCall(async () => {
            await canvas.scene.createEmbeddedDocuments('Wall', [data]);
            log.info('Created wall segment');
            
            // Chain? If Ctrl held, start new segment from endF
            if (event.ctrlKey) {
               // TODO: Implement Chaining logic
               // For now, simple single segment
            }
          }, 'pointerUp.createWall', Severity.DEGRADED);
          
          return;
        }

        // Handle Drag Select
        if (this.dragSelect.active) {
          const wasDragging = this.dragSelect.dragging;
          this.dragSelect.active = false;
          this.dragSelect.dragging = false;
          if (this.dragSelect.mesh) this.dragSelect.mesh.visible = false;
          if (this.dragSelect.border) this.dragSelect.border.visible = false;
          if (this.dragSelect.overlayEl) this.dragSelect.overlayEl.style.display = 'none';
          safeCall(() => this.selectionBoxEffect?._hideSelectionShadow?.(), 'pointerUp.hideSelectionShadow', Severity.COSMETIC);
          safeCall(() => this.selectionBoxEffect?._hideSelectionIllumination?.(), 'pointerUp.hideSelectionIllumination', Severity.COSMETIC);

          if (!wasDragging) {
            return;
          }
          
          // Calculate selection bounds
          const start = this.dragSelect.start;
          const current = this.dragSelect.current;
          
          const minX = Math.min(start.x, current.x);
          const maxX = Math.max(start.x, current.x);
          const minY = Math.min(start.y, current.y);
          const maxY = Math.max(start.y, current.y);
          
          // Find tokens within bounds
          // Foundry selects if CENTER is within bounds.
          // Level-aware filtering: tokens on other floors are excluded if they are
          // hidden under a solid floor tile (tile occlusion test). Tokens visible
          // through transparent areas (holes, stairwells, balconies) stay selectable.
          const tokens = this.tokenManager.getAllTokenSprites();
          const dragSelectedDocs = [];
          
          for (const sprite of tokens) {
            const x = sprite.position.x;
            const y = sprite.position.y;
            
            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
              const tokenDoc = sprite.userData.tokenDoc;
              if (!tokenDoc?.canUserModify(game.user, "update")) continue;

              // Level-aware drag-select: skip tokens on other floors that are
              // hidden under opaque floor tiles. Allow tokens visible through
              // transparent areas (gaps, stairwells, balconies).
              if (!isTokenDragSelectable(sprite, this.tileManager)) continue;

              this.selectObject(sprite);
              dragSelectedDocs.push(tokenDoc);
            }
          }

          // Auto-switch floor: if ALL drag-selected tokens are on the same floor
          // that is different from the current floor, switch the level view to
          // that floor. This lets users drag-select a group on a visible lower
          // floor and seamlessly transition to it.
          safeCall(() => {
            const switchElev = getAutoSwitchElevation(dragSelectedDocs);
            if (switchElev !== null) {
              switchToLevelForElevation(switchElev, 'drag-select-auto-switch');
            }
          }, 'dragSelect.autoSwitchLevel', Severity.COSMETIC);

          // Only allow box-selecting lights when the Lighting layer is active.
          // In token movement mode (TokenLayer), marquee selection should not grab lights.
          const activeLayer = canvas?.activeLayer?.name;
          const isLightingLayer = (activeLayer === 'LightingLayer' || activeLayer === 'lighting');
          if (isLightingLayer) {
            // Select Foundry lights within bounds (world-space icon centers)
            const lightIcons = this.lightIconManager?.lights?.values?.() ? Array.from(this.lightIconManager.lights.values()) : [];
            for (const sprite of lightIcons) {
              const x = sprite.position.x;
              const y = sprite.position.y;
              if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
                this.selectObject(sprite, { showLightEditor: false });
              }
            }

            // Select MapShine enhanced lights within bounds
            const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
            const enhancedIcons = enhancedLightIconManager?.lights?.values?.() ? Array.from(enhancedLightIconManager.lights.values()) : [];
            for (const sprite of enhancedIcons) {
              const x = sprite.position.x;
              const y = sprite.position.y;
              if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
                this.selectObject(sprite, { showLightEditor: false });
              }
            }
          }

          return;
        }

        if (!this.dragState.active) return;

        this._clearMovementPathPreview();

        // Re-enable camera controls
        if (window.MapShine?.cameraController) {
          window.MapShine.cameraController.enabled = true;
        }

        if (this.dragState.hasMoved && this.dragState.object) {
          // Commit change to Foundry for ALL selected objects
          const tokenUpdates = [];
          const lightUpdates = [];
          let anyUpdates = false;
          let anyEnhancedLightUpdates = false;
          let tokenUpdateSucceeded = false;
          
          // Use selection set
          for (const id of this.selection) {
            const preview = this.dragState.previews.get(id);
            if (!preview) continue;

            // Check Token
            const tokenData = this.tokenManager.tokenSprites.get(id);
            if (tokenData) {
                const tokenDoc = tokenData.tokenDoc;
                
                // Calculate final position from PREVIEW position
                const worldPos = preview.position;
                let foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);
                
                // Drag commit (tokens): do not run client-side collision stepping.
                // It can incorrectly clamp moves and make tokens feel "stuck" in certain regions.
                // Snap to grid center (when applicable), then let Foundry enforce collisions.
                const token = tokenDoc.object;
                safeCall(() => {
                  const grid = canvas?.grid;
                  const isGridless = !!(grid && grid.type === CONST.GRID_TYPES.GRIDLESS);
                  if (!isGridless && grid && typeof grid.getSnappedPoint === 'function') {
                    foundryPos = grid.getSnappedPoint(foundryPos, { mode: CONST.GRID_SNAPPING_MODES.CENTER });
                  }
                }, 'pointerUp.snapToGrid', Severity.COSMETIC);

                // Adjust for center vs top-left
                const wPx = (token && typeof token.w === 'number' && token.w > 0)
                  ? token.w
                  : (tokenDoc.width * (canvas?.grid?.size || canvas?.dimensions?.size || 100));
                const hPx = (token && typeof token.h === 'number' && token.h > 0)
                  ? token.h
                  : (tokenDoc.height * (canvas?.grid?.size || canvas?.dimensions?.size || 100));

                const finalX = foundryPos.x - wPx / 2;
                const finalY = foundryPos.y - hPx / 2;

                // If collision resolution produced a no-op, do not submit an update.
                // This avoids the "ghost" preview getting stuck waiting for movement-start that never occurs.
                if (
                  typeof tokenDoc.x === 'number' && typeof tokenDoc.y === 'number' &&
                  Math.abs(finalX - tokenDoc.x) < 0.5 &&
                  Math.abs(finalY - tokenDoc.y) < 0.5
                ) {
                  continue;
                }
                
                tokenUpdates.push({ _id: id, x: finalX, y: finalY });
                continue;
            }

            // Check Foundry Light
            if (this.lightIconManager && this.lightIconManager.lights.has(id)) {
                const worldPos = preview.position;
                const foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);
                
                lightUpdates.push({ _id: id, x: foundryPos.x, y: foundryPos.y });
                continue;
            }

            // Check MapShine Enhanced Light
            const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
            if (enhancedLightIconManager && enhancedLightIconManager.lights.has(id)) {
                const worldPos = preview.position;
                const foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);
                
                // Update via MapShine Enhanced Lights API
                const enhancedLightsApi = window.MapShine?.enhancedLights;
                if (enhancedLightsApi) {
                    await safeCall(async () => {
                        await enhancedLightsApi.update(id, { transform: { x: foundryPos.x, y: foundryPos.y } });
                        log.info(`Updated MapShine Enhanced Light ${id} position`);
                        anyUpdates = true;
                        anyEnhancedLightUpdates = true;
                    }, `pointerUp.updateEnhancedLight.${id}`, Severity.DEGRADED);
                }
                continue;
            }
          }

          // Re-enable enhanced light gizmos now that drag is ending.
          // If enhanced light positions changed, force a gizmo resync so the LOS polygon matches.
          safeCall(() => {
            const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
            if (enhancedLightIconManager && this.selection && this.selection.size > 0) {
              for (const sid of this.selection) {
                if (enhancedLightIconManager.lights?.has?.(sid)) {
                  enhancedLightIconManager.setDragging?.(sid, false);
                }
              }
              if (anyEnhancedLightUpdates) {
                enhancedLightIconManager.syncAllLights?.();
              }
            }
          }, 'pointerUp.resyncGizmos', Severity.COSMETIC);

          if (tokenUpdates.length > 0) {
            log.info(`Updating ${tokenUpdates.length} tokens`);
            anyUpdates = true;
            // Foundry: "Unrestrained Movement" UI toggle is implemented as the client setting
            // `core.unconstrainedMovement`. When active (and the user is a GM), Foundry's
            // native drag workflow passes constrainOptions {ignoreWalls:true, ignoreCost:true}.
            const unconstrainedMovement = !!(
              game?.user?.isGM &&
              game?.settings?.get?.('core', 'unconstrainedMovement')
            );

            const movementManager = window.MapShine?.tokenMovementManager;
            const canRunTokenSequencer = !!(
              movementManager &&
              typeof movementManager.executeDoorAwareTokenMove === 'function'
            );
            const canRunGroupSequencer = !!(
              movementManager &&
              typeof movementManager.executeDoorAwareGroupMove === 'function'
            );

            /** @type {Array<{_id:string,x:number,y:number}>} */
            const fallbackTokenUpdates = [];

            /** @type {Array<{update:{_id:string,x:number,y:number}, tokenDoc:any}>} */
            const sequencerCandidates = [];

            for (const upd of tokenUpdates) {
              const id = String(upd?._id ?? '');
              if (!id) continue;

              const tokenData = this.tokenManager?.tokenSprites?.get?.(id);
              const tokenDoc = tokenData?.tokenDoc;
              if (!tokenDoc) {
                fallbackTokenUpdates.push(upd);
                continue;
              }

              sequencerCandidates.push({ update: upd, tokenDoc });
            }

            if (canRunGroupSequencer && sequencerCandidates.length > 1) {
              const groupResult = await safeCall(async () => {
                return movementManager.executeDoorAwareGroupMove({
                  tokenMoves: sequencerCandidates.map((item) => ({
                    tokenDoc: item.tokenDoc,
                    destinationTopLeft: {
                      x: item.update.x,
                      y: item.update.y
                    }
                  })),
                  options: {
                    method: 'path-walk',
                    ignoreWalls: unconstrainedMovement,
                    ignoreCost: unconstrainedMovement,
                    includeMovementPayload: unconstrainedMovement,
                    suppressFoundryMovementUI: true,
                    updateOptions: {}
                  }
                });
              }, 'pointerUp.executeDoorAwareGroupMove', Severity.DEGRADED, {
                fallback: { ok: false, reason: 'door-aware-group-sequencer-error' }
              });

              if (groupResult?.ok) {
                tokenUpdateSucceeded = true;
              } else if (unconstrainedMovement) {
                for (const item of sequencerCandidates) {
                  fallbackTokenUpdates.push(item.update);
                }
              } else {
                log.warn(`Blocked constrained group token move: ${groupResult?.reason || 'group-no-valid-path'}`);
              }
            } else if (canRunTokenSequencer) {
              for (const item of sequencerCandidates) {
                const upd = item.update;
                const tokenDoc = item.tokenDoc;
                const id = String(upd?._id ?? '');

                const sequencerResult = await safeCall(async () => {
                  return movementManager.executeDoorAwareTokenMove({
                    tokenDoc,
                    destinationTopLeft: { x: upd.x, y: upd.y },
                    options: {
                      method: 'path-walk',
                      ignoreWalls: unconstrainedMovement,
                      ignoreCost: unconstrainedMovement,
                      includeMovementPayload: unconstrainedMovement,
                      suppressFoundryMovementUI: true,
                      updateOptions: {}
                    }
                  });
                }, `pointerUp.executeDoorAwareTokenMove.${id}`, Severity.DEGRADED, {
                  fallback: { ok: false, reason: 'door-aware-sequencer-error' }
                });

                if (sequencerResult?.ok) {
                  tokenUpdateSucceeded = true;
                } else if (unconstrainedMovement) {
                  fallbackTokenUpdates.push(upd);
                } else {
                  log.warn(`Blocked constrained token move for ${id}: ${sequencerResult?.reason || 'no-valid-path'}`);
                }
              }
            } else {
              for (const item of sequencerCandidates) {
                fallbackTokenUpdates.push(item.update);
              }
            }

            if (fallbackTokenUpdates.length > 0) {
              await safeCall(async () => {
                const updateOptions = {};
                if (unconstrainedMovement) {
                  /** @type {Record<string, any>} */
                  const movement = {};

                  for (const upd of fallbackTokenUpdates) {
                    const id = String(upd?._id ?? '');
                    if (!id) continue;

                    // Movement waypoints use top-left x/y (same coordinate space as TokenDocument.x/y).
                    // Include some extra fields where available to match Foundry's internal waypoint shape.
                    const tokenData = this.tokenManager?.tokenSprites?.get?.(id);
                    const tokenDoc = tokenData?.tokenDoc;

                    const waypoint = {
                      x: upd.x,
                      y: upd.y,
                      explicit: true,
                      checkpoint: true
                    };

                    if (tokenDoc) {
                      if (typeof tokenDoc.elevation === 'number') waypoint.elevation = tokenDoc.elevation;
                      if (typeof tokenDoc.width === 'number') waypoint.width = tokenDoc.width;
                      if (typeof tokenDoc.height === 'number') waypoint.height = tokenDoc.height;
                      if (tokenDoc.shape != null) waypoint.shape = tokenDoc.shape;
                      if (typeof tokenDoc.movementAction === 'string') waypoint.action = tokenDoc.movementAction;
                    }

                    movement[id] = {
                      waypoints: [waypoint],
                      // Foundry validates movement.method against a strict enum.
                      // Keep internal choreography labels out of document payloads.
                      method: 'api',
                      constrainOptions: { ignoreWalls: true, ignoreCost: true }
                    };
                  }

                  updateOptions.movement = movement;
                }

                await canvas.scene.updateEmbeddedDocuments('Token', fallbackTokenUpdates, updateOptions);
                tokenUpdateSucceeded = true;
              }, 'pointerUp.updateTokenPositionsFallback', Severity.DEGRADED);
            }
          }

          if (lightUpdates.length > 0) {
              log.info(`Updating ${lightUpdates.length} lights`);
              anyUpdates = true;
              await safeCall(async () => {
                  await canvas.scene.updateEmbeddedDocuments('AmbientLight', lightUpdates);
              }, 'pointerUp.updateLightPositions', Severity.DEGRADED);
          }
            
          // Cleanup
          this.dragState.active = false;
          this.dragState.object = null;
          this.dragState.mode = null;
          this.dragState.axis = null;

          // For tokens: keep the ghost preview around until the authoritative update
          // actually starts moving the token (matching Foundry).
          if (tokenUpdates.length > 0 && tokenUpdateSucceeded) {
            for (const upd of tokenUpdates) {
              if (upd?._id) this._pendingTokenMoveCleanup.tokenIds.add(upd._id);
            }

            if (this._pendingTokenMoveCleanup.timeoutId) {
              clearTimeout(this._pendingTokenMoveCleanup.timeoutId);
            }

            // Fallback: if no movement ever begins (failed update, permission issues, etc.)
            // clear the preview so it doesn't get stuck.
            this._pendingTokenMoveCleanup.timeoutId = setTimeout(() => {
              this._clearAllDragPreviews();
            }, 1500);
          } else {
            // Lights and other drags should clean up immediately.
            this._clearAllDragPreviews();
          }

          
          // If updates failed, we might want to revert, but for now we just clear state.
          // The previous code had revert logic, but it's complex with mixed types.
          // We'll rely on the fact that without optimistic updates, they just snap back if not updated.

        } else {
            this.dragState.active = false;
            this.dragState.object = null;
            this.dragState.mode = null;
            this.dragState.axis = null;

            // Drag canceled / no movement: restore enhanced light gizmo visibility.
            safeCall(() => {
              const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
              if (enhancedLightIconManager && this.selection && this.selection.size > 0) {
                for (const sid of this.selection) {
                  if (enhancedLightIconManager.lights?.has?.(sid)) {
                    enhancedLightIconManager.setDragging?.(sid, false);
                  }
                }
              }
            }, 'pointerUp.restoreGizmosNoMove', Severity.COSMETIC);

            this._clearAllDragPreviews();

        }
    } catch (error) {
        log.error('Error in onPointerUp:', error);

        // Never leave drag previews stuck in the scene if commit fails.
        safeCall(() => {
          this.dragState.active = false;
          this.dragState.object = null;
          this.dragState.mode = null;
          this.dragState.axis = null;
          this._clearMovementPathPreview();
          this._clearAllDragPreviews();
        }, 'pointerUp.emergencyCleanup', Severity.COSMETIC);
    }
  }

  /**
   * Get wall data based on tool type
   * @param {string} tool - Tool name (walls, terrain, etc.)
   * @param {number[]} coords - [x0, y0, x1, y1]
   * @returns {Object} Wall data
   * @private
   */
  getWallData(tool, coords) {
    const data = { c: coords };
    
    // Defaults: move=20 (NORMAL), sight=20 (NORMAL), door=0 (NONE)
    // Constants from Foundry source or approximations
    const NONE = 0;
    const LIMITED = 10;
    const NORMAL = 20;
    
    switch (tool) {
      case 'walls': // Standard
        data.move = NORMAL;
        data.sight = NORMAL;
        break;
      case 'terrain':
        data.move = NORMAL;
        data.sight = LIMITED;
        break;
      case 'invisible':
        data.move = NORMAL;
        data.sight = NONE;
        break;
      case 'ethereal':
        data.move = NONE;
        data.sight = NORMAL;
        break;
      case 'doors':
        data.move = NORMAL;
        data.sight = NORMAL;
        data.door = 1; // DOOR
        break;
      case 'secret':
        data.move = NORMAL;
        data.sight = NORMAL;
        data.door = 2; // SECRET
        break;
      default:
        data.move = NORMAL;
        data.sight = NORMAL;
    }

    // Seed missing wall-height defaults from the active Levels band so new
    // walls are authored on the currently viewed floor by default.
    applyWallLevelDefaults(data, { scene: canvas?.scene });
    
    return data;
  }

  /**
   * Handle key down (delete)
   * @param {KeyboardEvent} event 
   */
  async onKeyDown(event) {
    const key = String(event.key || '').toLowerCase();
    const isMod = !!(event.ctrlKey || event.metaKey);

    // We normally ignore all key events that originate from UI so that text fields,
    // tweakpanes, dialogs, etc. behave normally.
    //
    // Exception: we still want Ctrl/Cmd+C and Ctrl/Cmd+V to work for selected lights
    // even while the light editor overlay is open.
    const isCopyPaste = isMod && (key === 'c' || key === 'v');
    if (this._isEventFromUI(event)) {
      // If the user is actively typing/editing text, never hijack clipboard shortcuts.
      if (!isCopyPaste || this._isTextEditingEvent(event)) return;
    }

    // Keyboard token movement (arrow keys / WASD): MapShine takes ownership so we
    // can throttle to one grid step per completed animation. This prevents Foundry's
    // default key-repeat from racing the token document (and camera follow/pan)
    // far ahead of our animation.
    if (!isMod && !event.altKey && !event.shiftKey) {
      const movementKey = key;
      const isArrow = movementKey === 'arrowup' || movementKey === 'arrowdown' || movementKey === 'arrowleft' || movementKey === 'arrowright';
      const isWASD = movementKey === 'w' || movementKey === 'a' || movementKey === 's' || movementKey === 'd';
      if (isArrow || isWASD) {
        let dx = 0;
        let dy = 0;
        if (movementKey === 'arrowup' || movementKey === 'w') dy = -1;
        else if (movementKey === 'arrowdown' || movementKey === 's') dy = 1;
        else if (movementKey === 'arrowleft' || movementKey === 'a') dx = -1;
        else if (movementKey === 'arrowright' || movementKey === 'd') dx = 1;

        const tokenDocs = this._getSelectedTokenDocs?.() || [];
        if (tokenDocs.length > 0) {
          this._consumeKeyEvent(event);

          // Store the most recent intended direction so when repeat events arrive
          // while a track is in-flight we don't accumulate a backlog.
          if (!this._keyboardMoveIntent) this._keyboardMoveIntent = new Map();
          for (const tokenDoc of tokenDocs) {
            const tokenId = String(tokenDoc?.id || '');
            if (!tokenId) continue;
            this._keyboardMoveIntent.set(tokenId, { dx, dy, t: performance.now() });
          }

          const movementManager = this.tokenManager?.movementManager || window.MapShine?.tokenManager?.movementManager || null;
          const gridSize = canvas?.dimensions?.size ?? canvas?.grid?.size ?? 100;
          const gridStep = Math.max(1, Number(gridSize) || 100);
          const now = performance.now();

          for (const tokenDoc of tokenDocs) {
            const tokenId = String(tokenDoc?.id || '');
            if (!tokenId) continue;

            // Only issue a new doc update when the previous MapShine track has
            // fully completed (no active track). While moving, the latest intent
            // remains stored and will be picked up by the next repeat tick.
            const hasActiveTrack = !!movementManager?.activeTracks?.get?.(tokenId);
            if (hasActiveTrack) continue;

            const inFlightAt = this._keyboardStepInFlight.get(tokenId);
            if (Number.isFinite(inFlightAt)) {
              // If we somehow missed track creation (or the move was rejected),
              // let the latch expire so the user can try again.
              if ((now - inFlightAt) < 650) continue;
              this._keyboardStepInFlight.delete(tokenId);
            }

            const intent = this._keyboardMoveIntent.get(tokenId);
            if (!intent) continue;

            const startX = Number.isFinite(tokenDoc.x) ? tokenDoc.x : 0;
            const startY = Number.isFinite(tokenDoc.y) ? tokenDoc.y : 0;
            const nextX = startX + (intent.dx * gridStep);
            const nextY = startY + (intent.dy * gridStep);

            const update = { x: nextX, y: nextY };
            const updateOptions = {
              animate: false,
              animation: { duration: 0 },
              method: 'keyboard',
              mapShineMovement: { animated: true, method: 'keyboard' }
            };

            safeCall(async () => {
              this._keyboardStepInFlight.set(tokenId, performance.now());
              await tokenDoc.update(update, updateOptions);
            }, `keyboardMove.${tokenId}`, Severity.COSMETIC);
          }

          return;
        }
      }
    }

    // Gameplay token targeting parity (Foundry core "target" keybind behavior).
    // - T toggles target on currently hovered token
    // - Shift+T preserves existing targets
    if (!isMod && key === 't') {
      const activeLayer = canvas?.activeLayer;

      // Prefer Foundry's authoritative token-layer hover first. When MapShine
      // controls selection, canvas.activeLayer can be non-token, so relying on
      // activeLayer.hover alone can miss valid hovered tokens.
      const hoveredTokenId =
        canvas?.tokens?.hover?.id
        || canvas?.tokens?.hover?.document?.id
        || this.hoveredTokenId
        || activeLayer?.hover?.id
        || activeLayer?.hover?.document?.id
        || null;
      if (!hoveredTokenId) return;

      const token = canvas?.tokens?.get?.(hoveredTokenId);
      if (!token || token?.document?.isSecret) return;

      token.setTarget(!token.isTargeted, { releaseOthers: !event.shiftKey });
      this.tokenManager?.updateTokenTargetIndicator?.(token.id);
      this._consumeKeyEvent(event);
      return;
    }

    // Copy/Paste for Three-native lights.
    if (isMod && key === 'c') {
      safeCall(async () => {
        const selected = this._getSelectedLights();
        if (!selected.length) return;

        if (selected.length === 1) {
          const sel = selected[0];
          if (sel.type === 'foundry') {
            const doc = canvas?.scene?.lights?.get?.(sel.id) || canvas?.lighting?.get?.(sel.id)?.document;
            if (!doc) return;

            const obj = safeCall(() => (typeof doc.toObject === 'function') ? doc.toObject() : doc, 'copy.toObject', Severity.COSMETIC, { fallback: doc });

            const cloned = safeCall(() => foundry?.utils?.duplicate ? foundry.utils.duplicate(obj) : JSON.parse(JSON.stringify(obj)), 'copy.duplicate', Severity.COSMETIC, { fallback: JSON.parse(JSON.stringify(obj)) });

            // Ensure we don't carry IDs across.
            delete cloned._id;
            delete cloned.id;

            const enhancement = safeCall(() => {
              const store = window.MapShine?.lightEnhancementStore;
              const enhCfg = store?.getCached?.(doc.id)?.config;
              if (enhCfg && typeof enhCfg === 'object') return JSON.parse(JSON.stringify(enhCfg));
              return null;
            }, 'copy.enhancement', Severity.COSMETIC, { fallback: null });

            this._lightClipboard = {
              kind: 'foundry',
              sourceX: doc.x,
              sourceY: doc.y,
              data: cloned,
              enhancement
            };
          } else if (sel.type === 'enhanced') {
            const api = window.MapShine?.enhancedLights;
            if (!api?.get) return;
            const data = await api.get(sel.id);
            if (!data) return;

            const cloned = safeCall(() => JSON.parse(JSON.stringify(data)), 'copy.cloneEnhanced', Severity.COSMETIC, { fallback: data });

            delete cloned.id;
            // Never preserve Foundry overrides/links when duplicating.
            delete cloned.linkedFoundryLightId;
            delete cloned.overrideFoundry;

            const sx = cloned?.transform?.x;
            const sy = cloned?.transform?.y;
            this._lightClipboard = {
              kind: 'enhanced',
              sourceX: Number.isFinite(sx) ? sx : null,
              sourceY: Number.isFinite(sy) ? sy : null,
              data: cloned
            };
          }
        } else {
          const items = [];
          let baseX = 0;
          let baseY = 0;
          let count = 0;

          for (const sel of selected) {
            if (sel.type === 'foundry') {
              const doc = canvas?.scene?.lights?.get?.(sel.id) || canvas?.lighting?.get?.(sel.id)?.document;
              if (!doc) continue;

              const obj = safeCall(() => (typeof doc.toObject === 'function') ? doc.toObject() : doc, 'copyMulti.toObject', Severity.COSMETIC, { fallback: doc });

              const cloned = safeCall(() => foundry?.utils?.duplicate ? foundry.utils.duplicate(obj) : JSON.parse(JSON.stringify(obj)), 'copyMulti.duplicate', Severity.COSMETIC, { fallback: JSON.parse(JSON.stringify(obj)) });

              delete cloned._id;
              delete cloned.id;

              items.push({
                kind: 'foundry',
                sourceX: doc.x,
                sourceY: doc.y,
                data: cloned
              });
              baseX += Number(doc.x) || 0;
              baseY += Number(doc.y) || 0;
              count += 1;
            } else if (sel.type === 'enhanced') {
              const api = window.MapShine?.enhancedLights;
              if (!api?.get) continue;
              const data = await api.get(sel.id);
              if (!data) continue;

              const cloned = safeCall(() => JSON.parse(JSON.stringify(data)), 'copyMulti.cloneEnhanced', Severity.COSMETIC, { fallback: data });

              delete cloned.id;
              delete cloned.linkedFoundryLightId;
              delete cloned.overrideFoundry;

              const sx = cloned?.transform?.x;
              const sy = cloned?.transform?.y;
              items.push({
                kind: 'enhanced',
                sourceX: Number.isFinite(sx) ? sx : null,
                sourceY: Number.isFinite(sy) ? sy : null,
                data: cloned
              });
              if (Number.isFinite(sx) && Number.isFinite(sy)) {
                baseX += sx;
                baseY += sy;
                count += 1;
              }
            }
          }

          if (items.length > 0) {
            const norm = Math.max(1, count);
            this._lightClipboard = {
              kind: 'multi',
              baseX: baseX / norm,
              baseY: baseY / norm,
              items
            };
          }
        }

        this._consumeKeyEvent(event);
      }, 'onKeyDown.copy', Severity.COSMETIC);
      return;
    }

    if (isMod && key === 'v') {
      safeCall(async () => {
        const clip = this._lightClipboard;
        if (!clip || !clip.kind || !clip.data) return;

        const canEditScene = safeCall(() => {
            if (!canvas?.scene || !game?.user) return false;
            if (game.user.isGM) return true;
            if (typeof canvas.scene.canUserModify === 'function') return canvas.scene.canUserModify(game.user, 'update');
            return false;
        }, 'paste.canEditScene', Severity.COSMETIC, { fallback: false });

        if (!canEditScene) return;

        // Determine paste position.
        let pasteF = safeCall(() => {
          if (Number.isFinite(this._lastPointerClientX) && Number.isFinite(this._lastPointerClientY)) {
            const w = this.screenToWorld(this._lastPointerClientX, this._lastPointerClientY);
            if (w) return Coordinates.toFoundry(w.x, w.y);
          }
          return null;
        }, 'paste.pointerToFoundry', Severity.COSMETIC, { fallback: null });

        if (!pasteF) {
          // Fallback: offset from source position.
          const grid = canvas?.dimensions?.size ?? 100;
          const dx = grid * 0.5;
          const dy = grid * 0.5;
          const sx = Number.isFinite(clip.sourceX) ? clip.sourceX : (canvas?.dimensions?.sceneRect?.x ?? 0) + grid;
          const sy = Number.isFinite(clip.sourceY) ? clip.sourceY : (canvas?.dimensions?.sceneRect?.y ?? 0) + grid;
          pasteF = { x: sx + dx, y: sy + dy };
        }

        if (clip.kind === 'foundry') {
          const base = clip.data;
          if (!canvas?.scene?.createEmbeddedDocuments) return;

          const createData = { ...base, x: pasteF.x, y: pasteF.y };
          delete createData._id;
          delete createData.id;

          // If the copied payload lacks level metadata, seed from the active
          // level context so pasted lights follow current floor authoring.
          applyAmbientLightLevelDefaults(createData, { scene: canvas?.scene });

          const created = await canvas.scene.createEmbeddedDocuments('AmbientLight', [createData]);
          const newDoc = Array.isArray(created) ? created[0] : null;
          const newId = newDoc?.id;
          if (!newId) return;

          if (clip.enhancement && typeof clip.enhancement === 'object') {
            await safeCall(async () => {
              const store = window.MapShine?.lightEnhancementStore;
              await store?.upsert?.(newId, clip.enhancement);
            }, 'paste.upsertEnhancement', Severity.COSMETIC);
          }

          // Select it (sprite may not exist yet if the icon texture is still loading).
          this.clearSelection();
          this.selection.add(newId);
          const sprite = this.lightIconManager?.lights?.get?.(newId) || null;
          if (sprite) {
            this.selectObject(sprite);
          } else {
            const lightEditor = window.MapShine?.lightEditor;
            lightEditor?.show?.({ type: 'foundry', id: String(newId) }, null);
          }
        } else if (clip.kind === 'enhanced') {
          const api = window.MapShine?.enhancedLights;
          if (!api?.create) return;
          const base = clip.data;

          const createData = { ...base };
          delete createData.id;
          delete createData.linkedFoundryLightId;
          delete createData.overrideFoundry;

          // EnhancedLightsApi accepts either x/y or transform.x/y.
          createData.transform = { x: pasteF.x, y: pasteF.y };

          const newLight = await api.create(createData);
          const newId = newLight?.id;
          if (!newId) return;

          this.clearSelection();
          this.selection.add(String(newId));

          // Prefer selecting via sprite when available, but we can always open the ring.
          safeCall(() => {
            const mgr = window.MapShine?.enhancedLightIconManager;
            const sprite = mgr?.lights?.get?.(String(newId)) || null;
            if (sprite) {
              this.selectObject(sprite);
            } else {
              const lightEditor = window.MapShine?.lightEditor;
              lightEditor?.show?.({ type: 'enhanced', id: String(newId) }, null);
            }
          }, 'paste.selectEnhanced', Severity.COSMETIC, {
            onError: () => { const le = window.MapShine?.lightEditor; le?.show?.({ type: 'enhanced', id: String(newId) }, null); }
          });
        }

        this._consumeKeyEvent(event);
      }, 'onKeyDown.paste', Severity.COSMETIC);
      return;
    }

    // Intercept Delete/Backspace early so Foundry doesn't also process it.
    // (Otherwise you can get double-deletes and "does not exist" notifications.)
    if ((event.key === 'Delete' || event.key === 'Backspace') && (this.mapPointDraw.active || this.selection.size > 0)) {
      this._consumeKeyEvent(event);
    }

    // Handle Map Point Drawing Mode keys
    if (this.mapPointDraw.active) {
      if (event.key === 'Escape') {
        this.mapPointDrawHandler.cancel();
        this._consumeKeyEvent(event);
        return;
      }
      if (event.key === 'Enter') {
        await this.mapPointDrawHandler.finish();
        this._consumeKeyEvent(event);
        return;
      }
      // Backspace removes last point
      if (event.key === 'Backspace' && this.mapPointDraw.points.length > 0) {
        this.mapPointDrawHandler.removeLastPoint();
        this._consumeKeyEvent(event);
        return;
      }
    }

    // Delete key
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selection.size > 0) {
        let deleteConsumed = false;
        try {
          // Filter for tokens and walls
          const tokensToDelete = [];
          const wallsToDelete = [];
          const lightsToDelete = [];
          const enhancedLightsToDelete = [];
          const staleIds = [];

          for (const id of this.selection) {
            // Check Token
            const sprite = this.tokenManager.getTokenSprite(id);
            if (sprite) {
              // The Three sprite can be stale (token already deleted on the server).
              // Never ask Foundry to delete a token that doesn't exist.
              const tokenId = sprite.userData?.tokenDoc?.id;
              const tokenDocExists = tokenId && canvas.scene?.tokens?.get?.(tokenId);
              if (!tokenId || !tokenDocExists) {
                staleIds.push(id);
                continue;
              }

              tokensToDelete.push(tokenId);
              continue;
            }

            if (this.lightIconManager && this.lightIconManager.lights.has(id)) {
              const lightDoc = canvas.lighting?.get?.(id)?.document ?? canvas.scene?.lights?.get?.(id);
              const lightDocExists = !!lightDoc;
              if (!lightDocExists) {
                staleIds.push(id);
                continue;
              }

              if (!lightDoc.canUserModify(game.user, 'delete')) {
                continue;
              }

              lightsToDelete.push(id);
              continue;
            }

            // Check MapShine Enhanced Light
            const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
            if (enhancedLightIconManager && enhancedLightIconManager.lights.has(id)) {
              if (game.user.isGM) {
                enhancedLightsToDelete.push(id);
              }
              continue;
            }

            // Check Wall
            if (this.wallManager.walls.has(id)) {
                wallsToDelete.push(id);
            }
          }

          // Drop any stale ids from selection so we don't keep hitting this path.
          for (const id of staleIds) {
            this.selection.delete(id);
          }

          if (tokensToDelete.length > 0) {
            log.info(`Deleting ${tokensToDelete.length} tokens via Foundry TokenLayer safety flow`);

            // Launch-safety parity: route token deletion through Foundry's
            // combat-aware confirmation API before deleting selected token docs.
            const tokenLayer = canvas?.tokens;
            const tokenDocs = tokensToDelete
              .map((tokenId) => canvas?.scene?.tokens?.get?.(tokenId) || tokenLayer?.get?.(tokenId)?.document || null)
              .filter((doc) => !!doc);

            if (tokenLayer && typeof tokenLayer._confirmDeleteKey === 'function' && tokenDocs.length > 0) {
              const confirmed = await tokenLayer._confirmDeleteKey(tokenDocs);
              if (confirmed) {
                await canvas.scene.deleteEmbeddedDocuments('Token', tokenDocs.map((doc) => doc.id));
              }
            } else if (tokenLayer && typeof tokenLayer._onDeleteKey === 'function') {
              // Fallback to layer-level delete behavior when confirm hook is unavailable.
              await tokenLayer._onDeleteKey(event);
            } else {
              // Fallback (legacy): should rarely be hit, but keep as resilience.
              await canvas.scene.deleteEmbeddedDocuments('Token', tokensToDelete);
            }
          }

          if (wallsToDelete.length > 0) {
            log.info(`Deleting ${wallsToDelete.length} walls`);
            await canvas.scene.deleteEmbeddedDocuments('Wall', wallsToDelete);
          }

          if (lightsToDelete.length > 0) {
            log.info(`Deleting ${lightsToDelete.length} lights`);
            await canvas.scene.deleteEmbeddedDocuments('AmbientLight', lightsToDelete);
          }

          if (enhancedLightsToDelete.length > 0) {
            log.info(`Deleting ${enhancedLightsToDelete.length} MapShine enhanced lights`);
            const enhancedLightsApi = window.MapShine?.enhancedLights;
            if (enhancedLightsApi) {
              for (const id of enhancedLightsToDelete) {
                await safeCall(async () => enhancedLightsApi.remove(id), `delete.enhancedLight.${id}`, Severity.DEGRADED);
              }
            }
          }

          this.clearSelection();
        } catch (e) {
          // FINAL SAFETY NET: Even with pre-checks, deletes can race with socket updates.
          // If Foundry reports the doc no longer exists, treat as success.
          const msg = e?.message || '';
          if (typeof msg === 'string' && msg.includes('does not exist')) {
            log.warn(`Delete skipped (already deleted): ${msg}`);
            this.clearSelection();
          } else {
            throw e;
          }
        } finally {
          this._consumeKeyEvent(event);
        }
      }
    }
  }

  /**
   * Update mouse coordinates in NDC [-1, 1]
   * @param {PointerEvent} event 
   */
  updateMouseCoords(event) {
    const rect = this._getCanvasRectCached();
    this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /**
   * Convert Viewport (pixels) to World (THREE units) on a specific Z-plane
   * @param {number} clientX 
   * @param {number} clientY 
   * @param {number} targetZ - Z-plane to intersect with (default 0)
   * @returns {THREE.Vector3|null} Intersection point or null if no intersection
   */
  viewportToWorld(clientX, clientY, targetZ = 0) {
    // updateMouseCoords expects an event-like object with clientX/Y
    // We can just reuse the logic here or call updateMouseCoords if we construct a fake event
    // But easier to just recalculate NDC directly since we have the raw coords
    const rect = this._getCanvasRectCached();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    
    const THREE = window.THREE;
    const camera = this.sceneComposer.camera;
    
    if (!camera) return null;

    // Use the class raycaster to ensure consistency with selection logic
    // (avoiding manual unproject which might differ slightly)
    this.mouse.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.mouse, camera);

    // Reuse cached plane + target to avoid per-call allocations.
    const plane = this._viewportToWorldPlane;
    if (this._viewportToWorldLastZ !== targetZ) {
      plane.constant = -targetZ;
      this._viewportToWorldLastZ = targetZ;
    }
    const target = this._viewportToWorldTarget;
    const intersection = this.raycaster.ray.intersectPlane(plane, target);
    
    return intersection || null;
  }

  /**
   * Convert screen coordinates to world coordinates at ground level
   * @param {number} clientX - Screen X coordinate
   * @param {number} clientY - Screen Y coordinate
   * @returns {{x: number, y: number}|null} World coordinates or null
   */
  screenToWorld(clientX, clientY) {
    const groundZ = this.sceneComposer?.groundZ ?? 1000;
    const worldPos = this.viewportToWorld(clientX, clientY, groundZ);
    if (!worldPos) return null;
    return { x: worldPos.x, y: worldPos.y };
  }

  // ── World Pick / Observer API ────────────────────────────────────────────

  /**
   * Register a one-shot world pick callback. On the next left-click the
   * callback receives world coords and the event is consumed (no other
   * InteractionManager processing occurs for that click).
   * @param {(worldPos: {x:number, y:number}) => void} callback
   */
  setPendingWorldPick(callback) {
    this._pendingWorldPick = typeof callback === 'function' ? callback : null;
  }

  /** Clear a previously registered pending world pick without firing it. */
  clearPendingWorldPick() {
    this._pendingWorldPick = null;
  }

  /**
   * Register a persistent observer that is notified on every left-click
   * with the world position. Observers do NOT consume the event.
   * @param {(info: {clientX:number, clientY:number, worldX:number, worldY:number}) => void} callback
   */
  addWorldClickObserver(callback) {
    if (typeof callback === 'function') this._worldClickObservers.add(callback);
  }

  /** Remove a previously registered world click observer. */
  removeWorldClickObserver(callback) {
    this._worldClickObservers.delete(callback);
  }

  /**
   * Snap point to grid
   * @param {number} x 
   * @param {number} y 
   * @param {number} [mode] - Snapping mode (default to CENTER)
   * @param {number} [resolution] - Grid resolution (default 1)
   * @returns {{x: number, y: number}}
   */
  snapToGrid(x, y, mode = CONST.GRID_SNAPPING_MODES.CENTER, resolution = 1) {
    if (!canvas.grid) return { x, y };
    
    // Use Foundry's native grid snapping
    return canvas.grid.getSnappedPoint({ x, y }, {
      mode: mode,
      resolution: resolution
    });
  }

  /**
   * Select a wall
   * @param {THREE.Mesh} wallMesh 
   * @param {PointerEvent} event
   */
  selectWall(wallMesh, event) {
    // Find parent group which has the wallId
    let object = wallMesh;
    while(object && !object.userData.wallId) {
        object = object.parent;
    }
    if (!object) return;

    const wallId = object.userData.wallId;
    const isSelected = this.selection.has(wallId);

    if (event.shiftKey) {
        if (isSelected) {
             // keep selected or toggle? Standard is toggle or keep.
             // Let's just ensure it is added.
             this.wallManager.select(wallId, true);
        } else {
             this.selection.add(wallId);
             this.wallManager.select(wallId, true);
        }
    } else {
        if (!isSelected) {
             this.clearSelection();
             this.selection.add(wallId);
             this.wallManager.select(wallId, true);
        }
    }
  }

  /**
   * Select an object
   * @param {THREE.Sprite} sprite 
   */
  selectObject(sprite, opts = undefined) {
    const showLightEditor = opts?.showLightEditor !== false;
    let id;
    let isToken = false;
    if (sprite.userData.tokenDoc) {
        id = sprite.userData.tokenDoc.id;
        isToken = true;
        this.tokenManager.setTokenSelection(id, true);

        // Keep Foundry's native token control state in sync.
        // Drag-select previously only updated MapShine selection, which meant
        // Foundry never fired controlToken/perception updates and fog/vision could break.
        safeCall(() => { const fvttToken = canvas.tokens?.get(id); if (fvttToken && !fvttToken.controlled) fvttToken.control({ releaseOthers: false }); }, 'selectObject.controlToken', Severity.COSMETIC);
    } else if (sprite.userData.lightId) {
        id = sprite.userData.lightId;
        // Visual selection for lights
        safeCall(() => { if (sprite?.material?.color?.set) sprite.material.color.set(0x8888ff); }, 'selectObject.tintLight', Severity.COSMETIC);

        // Scale bump on selection so it reads clearly.
        safeCall(() => { const base = sprite?.userData?.baseScale; if (base && Number.isFinite(base.x) && Number.isFinite(base.y)) sprite.scale.set(base.x * 1.15, base.y * 1.15, base.z ?? 1); }, 'selectObject.scaleLight', Severity.COSMETIC);

        if (showLightEditor) {
          safeCall(() => { const lightEditor = window.MapShine?.lightEditor; if (lightEditor && typeof lightEditor.show === 'function') lightEditor.show({ type: 'foundry', id: String(id) }, sprite); }, 'selectObject.showFoundryEditor', Severity.COSMETIC);
        }
    } else if (sprite.userData.enhancedLightId) {
        id = sprite.userData.enhancedLightId;
        // Visual selection for MapShine enhanced lights
        // Do not tint here; enhanced light icons may use ShaderMaterial with no .color.

        safeCall(() => { const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager; enhancedLightIconManager?.setSelected?.(id, true); }, 'selectObject.setEnhancedSelected', Severity.COSMETIC);
        
        if (showLightEditor) {
          safeCall(() => { const lightEditor = window.MapShine?.lightEditor; const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager; const root = enhancedLightIconManager?.getRootObject?.(id) || sprite; if (lightEditor && typeof lightEditor.show === 'function') lightEditor.show({ type: 'enhanced', id: String(id) }, root); }, 'selectObject.showEnhancedEditor', Severity.COSMETIC);
        }

        // Ensure the legacy inspector stays out of the way.
        safeCall(() => { const inspector = window.MapShine?.enhancedLightInspector; inspector?.hide?.(); }, 'selectObject.hideInspector', Severity.COSMETIC);
    } else {
        return;
    }
    this.selection.add(id);
    
    // NOTE: Vision/fog updates are now handled natively by Foundry.
    // FogEffect uses FoundryFogBridge to extract Foundry's vision textures directly.
  }

  /**
   * Clear selection
   */
  clearSelection() {
    for (const id of this.selection) {
      // Check Token
      if (this.tokenManager.tokenSprites.has(id)) {
          this.tokenManager.setTokenSelection(id, false);

          // Also release Foundry's native token control so that
          // canvas.tokens.controlled is kept in sync with MapShine's
          // selection state. This is important for fog bypass logic
          // which checks whether the GM has any controlled tokens.
          safeCall(() => { const fvttToken = canvas.tokens?.get(id); if (fvttToken) fvttToken.release(); }, 'clearSelection.releaseToken', Severity.COSMETIC);
      }
      // Check Foundry Light
      if (this.lightIconManager && this.lightIconManager.lights.has(id)) {
          const sprite = this.lightIconManager.lights.get(id);
          safeCall(() => { if (sprite?.material?.color?.set) sprite.material.color.set(0xffffff); }, 'clearSelection.resetTint', Severity.COSMETIC);

          // Reset scale if we stored a baseScale.
          safeCall(() => { const base = sprite?.userData?.baseScale; if (base && Number.isFinite(base.x) && Number.isFinite(base.y)) sprite.scale.set(base.x, base.y, base.z ?? 1); }, 'clearSelection.resetScale', Severity.COSMETIC);
      }
      // Check MapShine Enhanced Light
      const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
      if (enhancedLightIconManager && enhancedLightIconManager.lights.has(id)) {
          const sprite = enhancedLightIconManager.lights.get(id);
          // Do not reset tint here; enhanced light icons may use ShaderMaterial with no .color.

          safeCall(() => enhancedLightIconManager?.setSelected?.(id, false), 'clearSelection.deselectEnhanced', Severity.COSMETIC);
      }
      // Check Wall
      if (this.wallManager.walls.has(id)) {
          this.wallManager.select(id, false);
      }
    }
    this.selection.clear();
    this._clearMovementPathPreview();
    this.rightClickMovePreview.active = false;
    this.rightClickMovePreview.tokenId = null;
    this.rightClickMovePreview.tileKey = '';
    this.rightClickMovePreview.destinationTopLeft = null;
    this.rightClickMovePreview.selectionKey = '';
    this.rightClickMovePreview.groupPlanCacheKey = '';

    this._hideSelectedLightOutline();
    
    // Hide light editor when clearing selection.
    safeCall(() => { const lightEditor = window.MapShine?.lightEditor; lightEditor?.hide?.(); }, 'clearSelection.hideEditor', Severity.COSMETIC);

    // Hide enhanced light inspector when clearing selection
    const inspector = window.MapShine?.enhancedLightInspector;
    if (inspector) {
      inspector.hide();
    }
    
    // NOTE: Vision/fog updates are now handled by MapShine's world-space fog
    // effect, which also consults Foundry's controlled tokens for GM bypass.
  }

  /**
   * MS-LVL-075: Check whether a door wall's height bounds include the
   * controlled token's elevation. GMs always pass. When no controlled
   * token exists, the check passes (no elevation context to gate against).
   *
   * @param {WallDocument|object|null} wallDoc
   * @returns {boolean} true if the door is reachable at the current elevation
   */
  _isDoorWallAtTokenElevation(wallDoc) {
    if (game?.user?.isGM) return true;
    if (!wallDoc) return true;

    const controlled = canvas?.tokens?.controlled;
    const token = (Array.isArray(controlled) && controlled.length > 0) ? controlled[0] : null;
    if (!token) return true;

    const tokenElevation = Number(token?.document?.elevation);
    if (!Number.isFinite(tokenElevation)) return true;

    const bounds = readWallHeightFlags(wallDoc);
    let bottom = Number(bounds?.bottom);
    let top = Number(bounds?.top);
    if (!Number.isFinite(bottom)) bottom = -Infinity;
    if (!Number.isFinite(top)) top = Infinity;
    if (top < bottom) { const swap = bottom; bottom = top; top = swap; }

    // Unbounded walls are always reachable
    if (bottom === -Infinity && top === Infinity) return true;

    return (bottom <= tokenElevation) && (tokenElevation <= top);
  }

  handleDoorClick(doorControl, event) {
      let object = doorControl;
      while (object && !object.userData?.wallId) object = object.parent;
      const wallId = object?.userData?.wallId;
      if (!wallId) return;

      const wallDoc = canvas.walls?.get?.(wallId)?.document ?? canvas.scene?.walls?.get?.(wallId);
      if (!wallDoc) return;

      // MS-LVL-075: Prevent non-GM players from toggling doors outside their
      // token's elevation range (wall-height bounds check).
      if (!this._isDoorWallAtTokenElevation(wallDoc)) {
          log.debug(`Door ${wallId} blocked: wall-height bounds outside token elevation`);
          return;
      }

      if (!wallDoc.canUserModify(game.user, 'update')) {
          ui.notifications?.warn?.('You do not have permission to control this door.');
          return;
      }

      const ds = wallDoc.ds;
      if (ds === 2) {
          ui.notifications?.info?.('This door is locked.');
          return;
      }

      const newDs = ds === 1 ? 0 : 1;
      wallDoc.update({ ds: newDs }).catch((err) => log.error('Failed to update door state', err));
  }

  handleDoorRightClick(doorControl, event) {
      let object = doorControl;
      while (object && !object.userData?.wallId) object = object.parent;
      const wallId = object?.userData?.wallId;
      if (!wallId) return;

      const wallDoc = canvas.walls?.get?.(wallId)?.document ?? canvas.scene?.walls?.get?.(wallId);
      if (!wallDoc) return;

      // MS-LVL-075: Prevent non-GM players from locking/unlocking doors outside
      // their token's elevation range.
      if (!this._isDoorWallAtTokenElevation(wallDoc)) {
          log.debug(`Door ${wallId} right-click blocked: wall-height bounds outside token elevation`);
          return;
      }

      if (!wallDoc.canUserModify(game.user, 'update')) {
          ui.notifications?.warn?.('You do not have permission to modify this door.');
          return;
      }

      const ds = wallDoc.ds;
      const newDs = ds === 2 ? 0 : 2;
      wallDoc.update({ ds: newDs }).catch((err) => log.error('Failed to update door lock state', err));
  }

  /**
   * Dispose
   */
  dispose() {
    window.removeEventListener('pointerdown', this.boundHandlers.onPointerDown, { capture: true });
    this.canvasElement.removeEventListener('dblclick', this.boundHandlers.onDoubleClick);
    window.removeEventListener('pointermove', this.boundHandlers.onPointerMove);
    window.removeEventListener('pointerup', this.boundHandlers.onPointerUp);
    window.removeEventListener('wheel', this.boundHandlers.onWheel);
    window.removeEventListener('keydown', this.boundHandlers.onKeyDown);

    this._cancelPingLongPress();
    this.clearSelection();

    safeCall(() => {
      const line = this._selectedLightOutline?.line;
      if (line) {
        line.parent?.remove?.(line);
        line.geometry?.dispose?.();
        line.material?.dispose?.();
      }
    }, 'dispose.lightOutline', Severity.COSMETIC);

    safeCall(() => {
      const group = this.movementPathPreview?.group;
      if (group?.parent) group.parent.remove(group);
      const lineOuter = this.movementPathPreview?.lineOuter;
      lineOuter?.geometry?.dispose?.();
      lineOuter?.material?.dispose?.();
      const lineInner = this.movementPathPreview?.lineInner;
      lineInner?.geometry?.dispose?.();
      lineInner?.material?.dispose?.();
      const tileGroup = this.movementPathPreview?.tileGroup;
      if (tileGroup?.children) {
        for (let i = tileGroup.children.length - 1; i >= 0; i--) {
          const mesh = tileGroup.children[i];
          tileGroup.remove(mesh);
          mesh.geometry?.dispose?.();
          mesh.material?.dispose?.();
        }
      }
      const ghost = this.movementPathPreview?.ghost;
      ghost?.material?.dispose?.();
      const labelEl = this.movementPathPreview?.labelEl;
      if (labelEl?.parentNode) labelEl.parentNode.removeChild(labelEl);
    }, 'dispose.movementPathPreview', Severity.COSMETIC);

    safeDispose(this.selectionBoxEffect, 'dispose.selectionBoxEffect');
    this.selectionBoxEffect = null;

    log.info('InteractionManager disposed');
  }
}
