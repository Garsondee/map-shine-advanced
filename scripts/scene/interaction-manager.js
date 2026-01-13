/**
 * @fileoverview Interaction manager - handles selection, dragging, and deletion of objects
 * Replaces Foundry's canvas interaction layer for THREE.js
 * @module scene/interaction-manager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';
import { VisionPolygonComputer } from '../vision/VisionPolygonComputer.js';
import { EnhancedLightInspector } from '../ui/enhanced-light-inspector.js';

const log = createLogger('InteractionManager');

const _lightPreviewLosComputer = new VisionPolygonComputer();
_lightPreviewLosComputer.circleSegments = 64;

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

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    
    /** @type {Set<string>} Set of selected object IDs (e.g. "Token.abc", "Tile.xyz") */
    this.selection = new Set();
    
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

    // Pending light interaction (disambiguate click-to-open-ring vs drag-to-move-light).
    // We only open the ring on pointerup if the pointer hasn't moved past threshold.
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
      forceSheet: false,
    };

    this._pendingTokenMoveCleanup = {
      timeoutId: null,
      tokenIds: new Set()
    };

    this.dragMeasure = {
      active: false,
      startFoundry: { x: 0, y: 0 },
      el: null
    };

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
      // Screen-space positions for visual overlay (client coordinates)
      screenStart: new THREE.Vector2(),
      screenCurrent: new THREE.Vector2(),
      overlayEl: null,
      threshold: 10
    };

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

    // MapShine Enhanced Light Placement (separate from Foundry light placement)
    this.enhancedLightPlacement = {
      active: false,
      start: new THREE.Vector3(),
      current: new THREE.Vector3(),
      previewGroup: null,
      previewFill: null,
      previewBorder: null
    };

    // Map Point Drawing State
    this.mapPointDraw = {
      active: false,
      effectTarget: null, // e.g., 'smellyFlies', 'fire'
      groupType: 'area', // 'point', 'area', 'line'
      ropeType: null,
      points: [], // Array of {x, y} in world coords
      snapToGrid: false, // Grid snapping OFF by default, Shift to enable
      previewGroup: null,
      previewLine: null,
      previewPoints: null,
      previewFill: null,
      cursorPoint: null, // Preview of where next point will be placed
      pointMarkers: [] // Individual point marker meshes for better visibility
    };
    
    // Create drag select visuals (Three.js mesh kept for compatibility)
    this.createSelectionBox();
    this.createSelectionOverlay();
    this.createDragMeasureOverlay();
    this.createLightPreview();
    this.createEnhancedLightPreview();
    this.createMapPointPreview();
    
    /** @type {string|null} ID of currently hovered token */
    this.hoveredTokenId = null;
    /** @type {string|null} ID of currently hovered wall */
    this.hoveredWallId = null;
    /** @type {string|null} ID of currently hovered overhead tile */
    this.hoveredOverheadTileId = null;
    this.hoveringTreeCanopy = false;
    
    /** @type {string|null} ID of token whose HUD is currently open */
    this.openHudTokenId = null;

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

  _computeLightPreviewLocalPolygon(originWorld, radiusWorld) {
    try {
      const radius = Number(radiusWorld);
      if (!Number.isFinite(radius) || radius <= 0) return null;

      const sceneRect = canvas?.dimensions?.sceneRect;
      const sceneBounds = sceneRect ? {
        x: sceneRect.x,
        y: sceneRect.y,
        width: sceneRect.width,
        height: sceneRect.height
      } : null;

      const originF = Coordinates.toFoundry(originWorld.x, originWorld.y);
      const ptsF = _lightPreviewLosComputer.compute(originF, radius, null, sceneBounds, { sense: 'light' });
      if (!ptsF || ptsF.length < 6) return null;

      const THREE = window.THREE;
      const local = [];
      for (let i = 0; i < ptsF.length; i += 2) {
        const w = Coordinates.toWorld(ptsF[i], ptsF[i + 1]);
        local.push(new THREE.Vector2(w.x - originWorld.x, w.y - originWorld.y));
      }
      return local.length >= 3 ? local : null;
    } catch (_) {
      return null;
    }
  }

  _updateLightPlacementPreviewGeometry(preview, originWorld, radiusWorld) {
    try {
      if (!preview?.previewFill || !preview?.previewBorder) return;
      const THREE = window.THREE;

      const radius = Math.max(0.1, Number(radiusWorld) || 0.1);

      // Keep group scale at 1 so the shader works in world-units.
      if (preview.previewGroup) preview.previewGroup.scale.set(1, 1, 1);

      if (preview.previewFill?.material?.uniforms?.uRadius) {
        preview.previewFill.material.uniforms.uRadius.value = radius;
      }

      const localPoly = this._computeLightPreviewLocalPolygon(originWorld, radius);
      let geom;
      if (localPoly && localPoly.length >= 3) {
        const shape = new THREE.Shape(localPoly);
        geom = new THREE.ShapeGeometry(shape);
      } else {
        geom = new THREE.CircleGeometry(radius, 64);
      }

      // Swap fill geometry
      if (preview.previewFill.geometry) preview.previewFill.geometry.dispose();
      preview.previewFill.geometry = geom;

      // Rebuild border to match new fill
      const borderGeom = new THREE.EdgesGeometry(geom);
      if (preview.previewBorder.geometry) preview.previewBorder.geometry.dispose();
      preview.previewBorder.geometry = borderGeom;
    } catch (_) {
    }
  }

  /**
   * Remove any existing drag previews and clear pending cleanup state.
   * @private
   */
  _clearAllDragPreviews() {
    this.destroyDragPreviews();

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

    for (const el of elements) {
      if (el.closest('.window-app, .app.window-app, #ui, #sidebar, #navigation')) return true;
      if (el.closest('button, a, input, select, textarea, label')) return true;

      if (el.closest('#map-shine-ui, #map-shine-texture-manager, #map-shine-effect-stack, #map-shine-control-panel, #map-shine-loading-overlay')) return true;
      if (el.closest('#map-point-context-menu')) return true;

      // World-anchored overlays (e.g. LightRingUI) live in OverlayUIManager.
      // These must be treated as UI even though we listen on window capture.
      if (el.closest('#map-shine-overlay-root, #map-shine-light-ring')) return true;
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

    window.addEventListener('pointerup', this.boundHandlers.onPointerUp);
    window.addEventListener('pointermove', this.boundHandlers.onPointerMove);
    window.addEventListener('wheel', this.boundHandlers.onWheel, { passive: false });
    window.addEventListener('keydown', this.boundHandlers.onKeyDown, { capture: true });

    // When a token actually starts moving due to the authoritative update,
    // remove the ghost preview so the animated token is visible.
    try {
      this.tokenManager?.setOnTokenMovementStart?.((tokenId) => this._onTokenMovementStart(tokenId));
    } catch (_) {
    }

    const rect = this.canvasElement.getBoundingClientRect();
    log.info('InteractionManager initialized (Three.js token interaction enabled)', {
      canvasId: this.canvasElement.id,
      width: rect.width,
      height: rect.height
    });
  }

  _consumeKeyEvent(event) {
    try {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    } catch (_) {
    }
  }

  /**
   * Create selection box visuals
   * @private
   */
  createSelectionBox() {
    const THREE = window.THREE;
    
    // Semi-transparent blue fill
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({ 
      color: 0x3388ff, 
      transparent: true, 
      opacity: 0.2,
      depthTest: false,
      side: THREE.DoubleSide
    });
    
    this.dragSelect.mesh = new THREE.Mesh(geometry, material);
    this.dragSelect.mesh.visible = false;
    this.dragSelect.mesh.name = 'SelectionBoxFill';
    this.dragSelect.mesh.layers.set(OVERLAY_THREE_LAYER);
    // Ensure it renders on top
    this.dragSelect.mesh.renderOrder = 9999;
    
    // Blue border
    const borderGeo = new THREE.EdgesGeometry(geometry);
    const borderMat = new THREE.LineBasicMaterial({ 
      color: 0x3388ff, 
      transparent: true, 
      opacity: 0.8,
      depthTest: false
    });
    
    this.dragSelect.border = new THREE.LineSegments(borderGeo, borderMat);
    this.dragSelect.border.visible = false;
    this.dragSelect.border.name = 'SelectionBoxBorder';
    this.dragSelect.border.layers.set(OVERLAY_THREE_LAYER);
    this.dragSelect.border.renderOrder = 10000;
    
    // Add to scene via SceneComposer
    if (this.sceneComposer.scene) {
      this.sceneComposer.scene.add(this.dragSelect.mesh);
      this.sceneComposer.scene.add(this.dragSelect.border);
    }
  }

  /**
   * Create a screen-space DOM overlay for drag selection.
   * This ensures the visual rectangle matches Foundry's PIXI selection box,
   * which is also screen-space, regardless of perspective.
   * @private
   */
  createSelectionOverlay() {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '9999';
    el.style.border = '2px solid rgba(51,136,255,0.8)';
    el.style.backgroundColor = 'rgba(51,136,255,0.2)';
    el.style.display = 'none';
    document.body.appendChild(el);
    this.dragSelect.overlayEl = el;
  }

  createDragMeasureOverlay() {
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '10000';
    el.style.padding = '4px 12px';
    el.style.borderRadius = '4px';
    el.style.backgroundColor = 'rgba(0,0,0,0.7)';
    el.style.color = 'white';
    el.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    el.style.fontSize = '24px';
    el.style.display = 'none';
    document.body.appendChild(el);
    this.dragMeasure.el = el;
  }

  /**
   * Create light placement preview visuals
   * @private
   */
  createLightPreview() {
    const THREE = window.THREE;

    this.lightPlacement.previewGroup = new THREE.Group();
    this.lightPlacement.previewGroup.name = 'LightPlacementPreview';
    this.lightPlacement.previewGroup.visible = false;
    // Z-index just above ground/floor but below tokens
    this.lightPlacement.previewGroup.position.z = 0;

    // Fill (Shader-based "Light Look")
    const geometry = new THREE.CircleGeometry(0.1, 64);
    
    // Shader adapted from LightMesh.js but for Unit Circle (Radius 1)
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 1.0, 0.8) }, // Warm light default
        uRatio: { value: 0.5 }, // bright/dim ratio
        uRadius: { value: 0.1 }
      },
      vertexShader: `
        varying vec2 vLocalPos;
        void main() {
          vLocalPos = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vLocalPos;
        uniform vec3 uColor;
        uniform float uRatio;
        uniform float uRadius;

        void main() {
          float dist = length(vLocalPos);
          if (dist >= uRadius) discard;

          float d = dist / max(uRadius, 0.0001);

          // Falloff Logic
          float dOuter = d;
          float innerFrac = clamp(uRatio, 0.0, 0.99);

          float coreRegion = 1.0 - smoothstep(0.0, innerFrac, dOuter);
          float haloRegion = 1.0 - smoothstep(innerFrac, 1.0, dOuter);

          // Bright core, soft halo
          float coreIntensity = pow(coreRegion, 1.2) * 2.0;
          float haloIntensity = pow(haloRegion, 1.0) * 0.6; 

          float intensity = (coreIntensity + haloIntensity) * 2.0;
          
          // Output with additive-friendly alpha
          gl_FragColor = vec4(uColor * intensity, intensity); 
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // Use CustomBlending to match LightingEffect's "Modulate & Add" formula:
      // Final = Dst + (Dst * Src)
      // This ensures the preview looks correct on dark backgrounds instead of washing them out.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide
    });

    this.lightPlacement.previewFill = new THREE.Mesh(geometry, material);
    this.lightPlacement.previewGroup.add(this.lightPlacement.previewFill);

    // Border (Yellow solid)
    const borderGeo = new THREE.EdgesGeometry(geometry);
    const borderMat = new THREE.LineBasicMaterial({
      color: 0xFFFFBB,
      transparent: true,
      opacity: 0.8,
      depthTest: false
    });
    this.lightPlacement.previewBorder = new THREE.LineSegments(borderGeo, borderMat);
    this.lightPlacement.previewGroup.add(this.lightPlacement.previewBorder);

    if (this.sceneComposer.scene) {
      this.sceneComposer.scene.add(this.lightPlacement.previewGroup);
    }
  }

  /**
   * Create MapShine enhanced light placement preview visuals
   * @private
   */
  createEnhancedLightPreview() {
    const THREE = window.THREE;

    this.enhancedLightPlacement.previewGroup = new THREE.Group();
    this.enhancedLightPlacement.previewGroup.name = 'EnhancedLightPlacementPreview';
    this.enhancedLightPlacement.previewGroup.visible = false;
    this.enhancedLightPlacement.previewGroup.position.z = 0;

    // Fill (blue-tinted to distinguish from Foundry lights)
    const geometry = new THREE.CircleGeometry(0.1, 64);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uColor: { value: new THREE.Color(0x44aaff) },
        uRadius: { value: 0.1 }
      },
      vertexShader: `
        varying vec2 vLocalPos;
        void main() {
          vLocalPos = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform float uRadius;
        varying vec2 vLocalPos;
        void main() {
          float dist = length(vLocalPos);
          if (dist >= uRadius) discard;
          float d = dist / max(uRadius, 0.0001);
          float alpha = (1.0 - smoothstep(0.7, 1.0, d)) * 0.3;
          gl_FragColor = vec4(uColor, alpha);
        }
      `
    });

    this.enhancedLightPlacement.previewFill = new THREE.Mesh(geometry, material);
    this.enhancedLightPlacement.previewGroup.add(this.enhancedLightPlacement.previewFill);

    // Border (Blue solid to distinguish from Foundry yellow)
    const borderGeo = new THREE.EdgesGeometry(geometry);
    const borderMat = new THREE.LineBasicMaterial({
      color: 0x44aaff,
      transparent: true,
      opacity: 0.8,
      depthTest: false
    });
    this.enhancedLightPlacement.previewBorder = new THREE.LineSegments(borderGeo, borderMat);
    this.enhancedLightPlacement.previewGroup.add(this.enhancedLightPlacement.previewBorder);

    if (this.sceneComposer.scene) {
      this.sceneComposer.scene.add(this.enhancedLightPlacement.previewGroup);
    }
  }

  /**
   * Create map point drawing preview visuals
   * @private
   */
  createMapPointPreview() {
    const THREE = window.THREE;

    this.mapPointDraw.previewGroup = new THREE.Group();
    this.mapPointDraw.previewGroup.name = 'MapPointDrawPreview';
    this.mapPointDraw.previewGroup.visible = false;
    this.mapPointDraw.previewGroup.renderOrder = 9998;
    this.mapPointDraw.previewGroup.layers.set(OVERLAY_THREE_LAYER);

    // Line connecting points
    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const lineMat = new THREE.LineBasicMaterial({
      color: 0x00ff00,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      linewidth: 2
    });
    this.mapPointDraw.previewLine = new THREE.Line(lineGeo, lineMat);
    this.mapPointDraw.previewLine.layers.set(OVERLAY_THREE_LAYER);
    this.mapPointDraw.previewGroup.add(this.mapPointDraw.previewLine);

    // Legacy points object (kept for compatibility but we use markers now)
    const pointsGeo = new THREE.BufferGeometry();
    pointsGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const pointsMat = new THREE.PointsMaterial({
      color: 0x00ff00,
      size: 16,
      sizeAttenuation: false,
      depthTest: false
    });
    this.mapPointDraw.previewPoints = new THREE.Points(pointsGeo, pointsMat);
    this.mapPointDraw.previewPoints.layers.set(OVERLAY_THREE_LAYER);
    this.mapPointDraw.previewGroup.add(this.mapPointDraw.previewPoints);

    // Semi-transparent fill for area (will be updated dynamically)
    const fillGeo = new THREE.BufferGeometry();
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      transparent: true,
      opacity: 0.15,
      depthTest: false,
      side: THREE.DoubleSide
    });
    this.mapPointDraw.previewFill = new THREE.Mesh(fillGeo, fillMat);
    this.mapPointDraw.previewFill.layers.set(OVERLAY_THREE_LAYER);
    this.mapPointDraw.previewGroup.add(this.mapPointDraw.previewFill);

    // Cursor point preview (shows where next point will be placed)
    const cursorGeo = new THREE.RingGeometry(12, 16, 32);
    const cursorMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      side: THREE.DoubleSide
    });
    this.mapPointDraw.cursorPoint = new THREE.Mesh(cursorGeo, cursorMat);
    this.mapPointDraw.cursorPoint.visible = false;
    this.mapPointDraw.previewGroup.add(this.mapPointDraw.cursorPoint);

    // Initialize point markers array
    this.mapPointDraw.pointMarkers = [];

    if (this.sceneComposer.scene) {
      this.sceneComposer.scene.add(this.mapPointDraw.previewGroup);
    }
  }

  /**
   * Start map point drawing mode
   * @param {string} effectTarget - Effect key (e.g., 'smellyFlies', 'fire')
   * @param {'point'|'area'|'line'|'rope'} [groupType='area'] - Type of group to create
   * @param {boolean} [snapToGrid=false] - Whether to snap to grid by default
   * @param {{ropeType?: 'rope'|'chain'}|null} [options=null] - Optional draw options
   */
  startMapPointDrawing(effectTarget, groupType = 'area', snapToGrid = false, options = null) {
    if (this.mapPointDraw.active) {
      this.cancelMapPointDrawing();
    }

    this.mapPointDraw.active = true;
    this.mapPointDraw.effectTarget = effectTarget;
    this.mapPointDraw.groupType = groupType;
    this.mapPointDraw.ropeType = (options?.ropeType === 'rope' || options?.ropeType === 'chain') ? options.ropeType : null;
    this.mapPointDraw.points = [];
    this.mapPointDraw.editingGroupId = null;
    this.mapPointDraw.snapToGrid = snapToGrid;
    this.mapPointDraw.previewGroup.visible = true;

    // Clear any existing point markers
    this._clearPointMarkers();

    // Update preview color based on effect
    const color = this._getEffectColor(effectTarget);
    if (this.mapPointDraw.previewLine.material) {
      this.mapPointDraw.previewLine.material.color.setHex(color);
    }
    if (this.mapPointDraw.previewPoints.material) {
      this.mapPointDraw.previewPoints.material.color.setHex(color);
    }
    if (this.mapPointDraw.previewFill.material) {
      this.mapPointDraw.previewFill.material.color.setHex(color);
    }

    // Save last used effect target
    this._saveLastEffectTarget(effectTarget);

    log.info(`Started map point drawing: ${effectTarget} (${groupType}), snap=${snapToGrid}`);
    const snapMsg = snapToGrid ? 'Hold Shift to disable grid snap.' : 'Hold Shift to enable grid snap.';
    ui.notifications.info(`Click to place points. ${snapMsg} Double-click or Enter to finish. Escape to cancel.`);
  }

  /**
   * Cancel map point drawing mode
   */
  cancelMapPointDrawing() {
    // If we were editing an existing group, restore its visual helper
    if (this.mapPointDraw.editingGroupId) {
      const mapPointsManager = window.MapShine?.mapPointsManager;
      if (mapPointsManager?.showVisualHelpers) {
        const group = mapPointsManager.getGroup(this.mapPointDraw.editingGroupId);
        if (group) {
          mapPointsManager.createVisualHelper(this.mapPointDraw.editingGroupId, group);
        }
      }
    }

    this.mapPointDraw.active = false;
    this.mapPointDraw.points = [];
    this.mapPointDraw.editingGroupId = null;
    this.mapPointDraw.previewGroup.visible = false;
    this._clearPointMarkers();
    this._updateMapPointPreview();
    if (this.mapPointDraw.cursorPoint) {
      this.mapPointDraw.cursorPoint.visible = false;
    }
    log.info('Map point drawing cancelled');
  }

  /**
   * Finish map point drawing and create/update the group
   * @private
   */
  async _finishMapPointDrawing() {
    if (!this.mapPointDraw.active || this.mapPointDraw.points.length < 1) {
      this.cancelMapPointDrawing();
      return;
    }

    const { effectTarget, groupType, ropeType, points, editingGroupId } = this.mapPointDraw;

    const isRopeEffect = effectTarget === 'rope';

    // Validate minimum points
    if (groupType === 'area' && points.length < 3) {
      ui.notifications.warn('Area requires at least 3 points');
      return;
    }
    if (groupType === 'line' && points.length < 2) {
      ui.notifications.warn('Line requires at least 2 points');
      return;
    }
    if (groupType === 'rope' && points.length < 2) {
      ui.notifications.warn('Rope requires at least 2 points');
      return;
    }
    if (isRopeEffect && points.length < 2) {
      ui.notifications.warn('Rope requires at least 2 points');
      return;
    }

    // Get MapPointsManager
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager) {
      log.error('MapPointsManager not available');
      this.cancelMapPointDrawing();
      return;
    }

    try {
      if (editingGroupId) {
        const existingGroup = mapPointsManager.getGroup(editingGroupId);
        const isExistingRopeGroup = existingGroup?.effectTarget === 'rope' || existingGroup?.type === 'rope';
        const updates = {
          points: points.map(p => ({ x: p.x, y: p.y }))
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
        // Update existing group with new points
        await mapPointsManager.updateGroup(editingGroupId, {
          ...updates
        });
        log.info(`Updated map point group: ${editingGroupId}`);
        ui.notifications.info(`Updated group with ${points.length} points`);
        
        // Refresh visual helper
        if (mapPointsManager.showVisualHelpers) {
          const group = mapPointsManager.getGroup(editingGroupId);
          if (group) {
            mapPointsManager.createVisualHelper(editingGroupId, group);
          }
        }
      } else {
        // Create new group
        const isRope = isRopeEffect || groupType === 'rope';
        const finalType = isRopeEffect ? 'line' : groupType;
        const ropePreset = (ropeType === 'rope' || ropeType === 'chain') ? ropeType : 'chain';
        const group = await mapPointsManager.createGroup({
          label: isRope ? 'Rope' : `${effectTarget} ${groupType}`,
          type: finalType,
          points: points.map(p => ({ x: p.x, y: p.y })),
          isEffectSource: isRope ? false : true,
          effectTarget: isRopeEffect ? 'rope' : (isRope ? '' : effectTarget),
          ropeType: isRopeEffect ? ropePreset : undefined
        });

        log.info(`Created map point group: ${group.id}`);
        ui.notifications.info(isRope ? 'Created rope' : `Created ${effectTarget} spawn ${groupType}`);
      }
    } catch (e) {
      log.error('Failed to save map point group:', e);
      ui.notifications.error('Failed to save spawn area');
    }

    // Reset state
    this.mapPointDraw.active = false;
    this.mapPointDraw.points = [];
    this.mapPointDraw.editingGroupId = null;
    this.mapPointDraw.previewGroup.visible = false;
    this._clearPointMarkers();
    // Ensure we clear any existing preview geometry so it cannot remain visible
    // due to stale buffer attributes/material state.
    try {
      const THREE = window.THREE;
      if (THREE) {
        this.mapPointDraw.previewLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
        this.mapPointDraw.previewPoints.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      }
    } catch (_) {
    }
    try {
      // Reset fill geometry to an empty BufferGeometry
      const THREE = window.THREE;
      if (THREE && this.mapPointDraw.previewFill?.geometry) {
        this.mapPointDraw.previewFill.geometry.dispose();
        this.mapPointDraw.previewFill.geometry = new THREE.BufferGeometry();
      }
    } catch (_) {
    }
    this._updateMapPointPreview();
    if (this.mapPointDraw.cursorPoint) {
      this.mapPointDraw.cursorPoint.visible = false;
    }
  }

  /**
   * Add a point to the current map point drawing
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @param {boolean} shiftHeld - Whether shift key is held
   * @private
   */
  _addMapPoint(worldX, worldY, shiftHeld = false) {
    if (!this.mapPointDraw.active) return;

    // Snapping logic: 
    // - If snapToGrid is ON (default OFF): snap unless Shift is held
    // - If snapToGrid is OFF (default): only snap when Shift IS held
    let x = worldX;
    let y = worldY;
    const shouldSnap = this.mapPointDraw.snapToGrid ? !shiftHeld : shiftHeld;
    
    if (shouldSnap) {
      // Use resolution=2 for half-grid subdivisions (2x2 = 4 snap points per grid cell)
      const snapped = this.snapToGrid(worldX, worldY, CONST.GRID_SNAPPING_MODES.CENTER | CONST.GRID_SNAPPING_MODES.VERTEX | CONST.GRID_SNAPPING_MODES.CORNER | CONST.GRID_SNAPPING_MODES.SIDE_MIDPOINT, 2);
      x = snapped.x;
      y = snapped.y;
    }

    this.mapPointDraw.points.push({ x, y });
    this._updateMapPointPreview();

    log.debug(`Added map point: (${x}, ${y}), total: ${this.mapPointDraw.points.length}, snapped=${shouldSnap}`);
  }

  /**
   * Clear all point marker meshes
   * @private
   */
  _clearPointMarkers() {
    const THREE = window.THREE;
    for (const marker of this.mapPointDraw.pointMarkers) {
      if (marker.geometry) marker.geometry.dispose();
      if (marker.material) marker.material.dispose();
      this.mapPointDraw.previewGroup.remove(marker);
    }
    this.mapPointDraw.pointMarkers = [];
  }

  /**
   * Create a point marker mesh at the given position
   * @param {number} x - World X
   * @param {number} y - World Y
   * @param {number} z - World Z
   * @param {number} color - Hex color
   * @param {number} index - Point index (for numbering)
   * @returns {THREE.Group}
   * @private
   */
  _createPointMarker(x, y, z, color, index) {
    const THREE = window.THREE;
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // Outer ring (white border)
    const outerRing = new THREE.RingGeometry(18, 24, 32);
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const outerMesh = new THREE.Mesh(outerRing, outerMat);
    group.add(outerMesh);

    // Inner filled circle (effect color)
    const innerCircle = new THREE.CircleGeometry(16, 32);
    const innerMat = new THREE.MeshBasicMaterial({
      color: color,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const innerMesh = new THREE.Mesh(innerCircle, innerMat);
    innerMesh.position.z = 0.1; // Slightly in front
    group.add(innerMesh);

    // Center dot (darker)
    const centerDot = new THREE.CircleGeometry(4, 16);
    const centerMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.6,
      depthTest: false,
      side: THREE.DoubleSide
    });
    const centerMesh = new THREE.Mesh(centerDot, centerMat);
    centerMesh.position.z = 0.2;
    group.add(centerMesh);

    group.renderOrder = 10000 + index;
    return group;
  }

  /**
   * Update the map point preview visuals
   * @private
   */
  _updateMapPointPreview(cursorX = null, cursorY = null) {
    const THREE = window.THREE;
    const { points, groupType, previewLine, previewPoints, previewFill, cursorPoint } = this.mapPointDraw;

    // Get ground Z
    const groundZ = this.sceneComposer?.groundZ ?? 1000;
    const previewZ = groundZ + 2;

    // Get effect color for markers
    const effectColor = this._getEffectColor(this.mapPointDraw.effectTarget);

    // Build positions array (include cursor position if provided)
    const allPoints = [...points];
    if (cursorX !== null && cursorY !== null && this.mapPointDraw.active) {
      allPoints.push({ x: cursorX, y: cursorY });
    }

    // Update line
    const linePositions = [];
    for (const p of allPoints) {
      linePositions.push(p.x, p.y, previewZ);
    }
    // Close the loop for area type
    if (groupType === 'area' && allPoints.length > 2) {
      linePositions.push(allPoints[0].x, allPoints[0].y, previewZ);
    }
    previewLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    previewLine.geometry.attributes.position.needsUpdate = true;

    // Update legacy points (kept for fallback)
    const pointPositions = [];
    for (const p of points) {
      pointPositions.push(p.x, p.y, previewZ);
    }
    previewPoints.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pointPositions, 3));
    previewPoints.geometry.attributes.position.needsUpdate = true;

    // Update point markers - create new ones if needed, update positions
    // First, ensure we have the right number of markers
    while (this.mapPointDraw.pointMarkers.length < points.length) {
      const idx = this.mapPointDraw.pointMarkers.length;
      const marker = this._createPointMarker(0, 0, previewZ, effectColor, idx);
      this.mapPointDraw.previewGroup.add(marker);
      this.mapPointDraw.pointMarkers.push(marker);
    }
    // Remove excess markers
    while (this.mapPointDraw.pointMarkers.length > points.length) {
      const marker = this.mapPointDraw.pointMarkers.pop();
      if (marker) {
        marker.traverse((child) => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        });
        this.mapPointDraw.previewGroup.remove(marker);
      }
    }
    // Update marker positions
    for (let i = 0; i < points.length; i++) {
      const marker = this.mapPointDraw.pointMarkers[i];
      if (marker) {
        marker.position.set(points[i].x, points[i].y, previewZ + 1);
      }
    }

    // Update cursor preview position
    if (cursorPoint && cursorX !== null && cursorY !== null && this.mapPointDraw.active) {
      cursorPoint.position.set(cursorX, cursorY, previewZ + 2);
      cursorPoint.visible = true;
      // Update cursor color to match effect
      if (cursorPoint.material) {
        cursorPoint.material.color.setHex(effectColor);
        cursorPoint.material.opacity = 0.6;
      }
    } else if (cursorPoint) {
      cursorPoint.visible = false;
    }

    // Update fill for area type
    if (groupType === 'area' && allPoints.length >= 3) {
      const shape = new THREE.Shape();
      shape.moveTo(allPoints[0].x, allPoints[0].y);
      for (let i = 1; i < allPoints.length; i++) {
        shape.lineTo(allPoints[i].x, allPoints[i].y);
      }
      shape.closePath();

      const fillGeo = new THREE.ShapeGeometry(shape);
      // Offset Z
      const posAttr = fillGeo.getAttribute('position');
      for (let i = 0; i < posAttr.count; i++) {
        posAttr.setZ(i, previewZ - 1);
      }
      posAttr.needsUpdate = true;

      previewFill.geometry.dispose();
      previewFill.geometry = fillGeo;
    }
  }

  /**
   * Get color for an effect type
   * @param {string} effectTarget
   * @returns {number} Hex color
   * @private
   */
  _getEffectColor(effectTarget) {
    const colors = {
      fire: 0xff4400,
      candleFlame: 0xffaa00,
      sparks: 0xffff00,
      lightning: 0x00aaff,
      dust: 0xaaaaaa,
      smellyFlies: 0x00ff00,
      rope: 0xccaa66,
      water: 0x0066ff,
      pressurisedSteam: 0xcccccc,
      cloudShadows: 0x666666,
      canopy: 0x228822,
      structuralShadows: 0x444444
    };
    return colors[effectTarget] || 0x00ff00;
  }

  /**
   * Save the last used effect target to client settings
   * @param {string} effectTarget
   * @private
   */
  _saveLastEffectTarget(effectTarget) {
    try {
      game.settings.set('map-shine-advanced', 'lastMapPointEffect', effectTarget);
    } catch (e) {
      // Setting may not be registered yet, store in localStorage as fallback
      localStorage.setItem('map-shine-lastMapPointEffect', effectTarget);
    }
  }

  /**
   * Get the last used effect target
   * @returns {string}
   */
  getLastEffectTarget() {
    try {
      return game.settings.get('map-shine-advanced', 'lastMapPointEffect') || 'smellyFlies';
    } catch (e) {
      return localStorage.getItem('map-shine-lastMapPointEffect') || 'smellyFlies';
    }
  }

  /**
   * Start adding points to an existing group
   * @param {string} groupId - ID of the group to add points to
   */
  startAddPointsToGroup(groupId) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager) return;

    const group = mapPointsManager.getGroup(groupId);
    if (!group) {
      ui.notifications.warn('Group not found');
      return;
    }

    // Set up state for adding points to existing group
    this.mapPointDraw.active = true;
    this.mapPointDraw.effectTarget = group.effectTarget;
    this.mapPointDraw.groupType = group.type;
    this.mapPointDraw.points = [...group.points]; // Start with existing points
    this.mapPointDraw.snapToGrid = false;
    this.mapPointDraw.editingGroupId = groupId; // Track that we're editing, not creating
    this.mapPointDraw.previewGroup.visible = true;

    // Clear any existing point markers and rebuild
    this._clearPointMarkers();

    // Update preview color based on effect
    const color = this._getEffectColor(group.effectTarget);
    if (this.mapPointDraw.previewLine.material) {
      this.mapPointDraw.previewLine.material.color.setHex(color);
    }
    if (this.mapPointDraw.previewPoints.material) {
      this.mapPointDraw.previewPoints.material.color.setHex(color);
    }
    if (this.mapPointDraw.previewFill.material) {
      this.mapPointDraw.previewFill.material.color.setHex(color);
    }

    // Update preview to show existing points
    this._updateMapPointPreview();

    // Hide the visual helper for this group while editing
    mapPointsManager.removeVisualObject(groupId);

    log.info(`Started adding points to group: ${groupId} (${group.label})`);
    ui.notifications.info(`Adding points to "${group.label}". Click to add. Enter to save. Escape to cancel.`);
  }

  /**
   * Get the map point group ID at a screen position (if visual helpers are visible)
   * @param {number} clientX - Screen X for menu position
   * @param {number} clientY - Screen Y for menu position
   * @returns {string|null} Group ID or null if no group at position
   * @private
   */
  _getMapPointGroupAtPosition(clientX, clientY) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager?.showVisualHelpers) return null;
    
    const worldPos = this.screenToWorld(clientX, clientY);
    if (!worldPos) return null;

    // Check each group's visual helper for intersection
    const clickRadius = 30; // Pixel tolerance for clicking on points/lines
    
    for (const [groupId, group] of mapPointsManager.groups) {
      if (!group.points || group.points.length === 0) continue;
      
      // Check if click is near any point in the group
      for (const point of group.points) {
        const dx = worldPos.x - point.x;
        const dy = worldPos.y - point.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < clickRadius) {
          return groupId;
        }
      }
      
      // For areas, also check if click is inside the polygon
      if (group.type === 'area' && group.points.length >= 3) {
        if (mapPointsManager._isPointInPolygon(worldPos.x, worldPos.y, group.points)) {
          return groupId;
        }
      }
      
      // For lines, check if click is near any line segment
      if (group.type === 'line' && group.points.length >= 2) {
        for (let i = 0; i < group.points.length - 1; i++) {
          const p1 = group.points[i];
          const p2 = group.points[i + 1];
          const dist = this._pointToLineDistance(worldPos.x, worldPos.y, p1.x, p1.y, p2.x, p2.y);
          if (dist < clickRadius) {
            return groupId;
          }
        }
      }
    }
    
    return null;
  }

  /**
   * Calculate distance from a point to a line segment
   * @private
   */
  _pointToLineDistance(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    
    if (lengthSq === 0) {
      // Line segment is a point
      return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
    }
    
    // Project point onto line, clamped to segment
    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    
    return Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
  }

  /**
   * Show context menu for a map point group
   * @param {string} groupId - Group ID
   * @param {number} clientX - Screen X for menu position
   * @param {number} clientY - Screen Y for menu position
   * @private
   */
  _showMapPointContextMenu(groupId, clientX, clientY) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    const uiManager = window.MapShine?.uiManager;
    
    if (!mapPointsManager) return;
    
    const group = mapPointsManager.getGroup(groupId);
    if (!group) return;

    // Create context menu element
    const existingMenu = document.getElementById('map-point-context-menu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.id = 'map-point-context-menu';
    menu.style.cssText = `
      position: fixed;
      left: ${clientX}px;
      top: ${clientY}px;
      background: #1a1a2e;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 4px 0;
      min-width: 160px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      z-index: 100000;
      font-family: var(--font-primary);
      font-size: 12px;
    `;

    const menuItems = [
      { icon: 'fa-edit', label: 'Edit Group', action: 'edit' },
      { icon: 'fa-plus-circle', label: 'Add Points', action: 'addPoints' },
      { icon: 'fa-crosshairs', label: 'Focus', action: 'focus' },
      { icon: 'fa-copy', label: 'Duplicate', action: 'duplicate' },
      { divider: true },
      { icon: 'fa-eye-slash', label: 'Hide Helpers', action: 'hideHelpers' },
      { divider: true },
      { icon: 'fa-trash', label: 'Delete', action: 'delete', danger: true }
    ];

    for (const item of menuItems) {
      if (item.divider) {
        const divider = document.createElement('div');
        divider.style.cssText = 'height: 1px; background: #444; margin: 4px 0;';
        menu.appendChild(divider);
        continue;
      }

      const menuItem = document.createElement('div');
      menuItem.style.cssText = `
        padding: 6px 12px;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 8px;
        color: ${item.danger ? '#ff6666' : '#ddd'};
        transition: background 0.1s;
      `;
      menuItem.innerHTML = `<i class="fas ${item.icon}" style="width: 14px;"></i> ${item.label}`;
      
      menuItem.addEventListener('mouseenter', () => {
        menuItem.style.background = item.danger ? '#4a2a2a' : '#3a3a4e';
      });
      menuItem.addEventListener('mouseleave', () => {
        menuItem.style.background = 'transparent';
      });
      
      menuItem.addEventListener('click', async () => {
        menu.remove();
        
        switch (item.action) {
          case 'edit':
            if (uiManager?.openGroupEditDialog) {
              uiManager.openGroupEditDialog(groupId);
            }
            break;
            
          case 'focus':
            const bounds = mapPointsManager.getAreaBounds(groupId);
            if (bounds) {
              const foundryPos = Coordinates.toFoundry(bounds.centerX, bounds.centerY);
              canvas.pan({ x: foundryPos.x, y: foundryPos.y });
            }
            break;
            
          case 'duplicate':
            const newGroup = await mapPointsManager.createGroup({
              ...group,
              id: undefined, // Generate new ID
              label: `${group.label} (copy)`
            });

            log.info(`Created map point group: ${newGroup.id}`);
            ui.notifications.info(`Duplicated: ${newGroup.label}`);
            // Refresh helpers
            if (mapPointsManager.showVisualHelpers) {
              mapPointsManager.setShowVisualHelpers(false);
              mapPointsManager.setShowVisualHelpers(true);
            }
            break;
            
          case 'addPoints':
            this.startAddPointsToGroup(groupId);
            break;
            
          case 'hideHelpers':
            mapPointsManager.setShowVisualHelpers(false);
            break;
            
          case 'delete':
            const confirmed = await Dialog.confirm({
              title: 'Delete Map Point Group',
              content: `<p>Delete "${group.label || 'this group'}"?</p>`,
              yes: () => true,
              no: () => false
            });
            if (confirmed) {
              const ok = await mapPointsManager.deleteGroup(groupId);
              if (ok) {
                ui.notifications.info('Group deleted');
              } else {
                ui.notifications.warn('Failed to delete group (insufficient permissions or save error).');
              }
            }
            break;
        }
      });
      
      menu.appendChild(menuItem);
    }

    // Add header showing group name
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 6px 12px 8px;
      font-weight: bold;
      color: #aaa;
      font-size: 11px;
      border-bottom: 1px solid #444;
      margin-bottom: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    header.textContent = group.label || 'Map Point Group';
    menu.insertBefore(header, menu.firstChild);

    document.body.appendChild(menu);

    // Close menu when clicking elsewhere
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', closeMenu);
      }
    };
    
    // Delay adding listener to prevent immediate close
    setTimeout(() => {
      document.addEventListener('pointerdown', closeMenu);
    }, 10);

    // Adjust position if menu goes off-screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${clientX - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${clientY - rect.height}px`;
    }
  }

  /**
   * Create drag previews for selected tokens
   * @private
   */
  createDragPreviews() {
    this.dragState.previews.clear();

    const THREE = window.THREE;
    const _tmpPos = new THREE.Vector3();
    const _tmpQuat = new THREE.Quaternion();
    
    for (const id of this.selection) {
      // Check Token
      const tokenData = this.tokenManager.tokenSprites.get(id);
      if (tokenData && tokenData.sprite) {
        const original = tokenData.sprite;
        const preview = original.clone();

        // Previews must update their matrix as we drag them.
        preview.matrixAutoUpdate = true;
        // Slightly above the original to avoid z-fighting.
        preview.position.z = (preview.position.z ?? 0) + 0.01;
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
          try {
            original.getWorldPosition(_tmpPos);
            original.getWorldQuaternion(_tmpQuat);
            preview.position.copy(_tmpPos);
            preview.quaternion.copy(_tmpQuat);
          } catch (_) {
          }

          preview.position.z = (preview.position.z ?? 0) + 0.01;
          preview.renderOrder = 9998;

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
          try {
            originalRoot.getWorldPosition(_tmpPos);
            originalRoot.getWorldQuaternion(_tmpQuat);
            preview.position.copy(_tmpPos);
            preview.quaternion.copy(_tmpQuat);
          } catch (_) {
          }

          preview.position.z = (preview.position.z ?? 0) + 0.01;
          preview.renderOrder = 9998;

          // Make materials semi-transparent and render on top.
          preview.traverse?.((obj) => {
            try {
              // Hide the radius gizmo in the drag preview. The LOS-based polygon
              // does not update during drag, and the fill obscures the scene.
              if (obj?.userData?.type === 'enhancedLightRadiusFill' || obj?.userData?.type === 'enhancedLightRadiusBorder') {
                obj.visible = false;
                return;
              }

              if (obj?.material) {
                obj.material = obj.material.clone();
                obj.material.opacity = 0.5;
                obj.material.transparent = true;
                obj.material.depthTest = false;
                obj.material.depthWrite = false;
              }
            } catch (_) {
            }
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
          this._finishMapPointDrawing();
          event.preventDefault();
          return;
        }

        // Get mouse position in NDC
        this.updateMouseCoords(event);
        this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);

        // 1. Check Walls
        // ... existing wall code ...

        // 1.5 Check Lights (Lighting Layer)
        // Prefer MapShine in-world light ring UI over Foundry's config sheet.
        // Hold Alt (or Ctrl/Cmd) to force the Foundry sheet.
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
                    const ringUI = window.MapShine?.lightRingUI;
                    if (!forceSheet && ringUI && typeof ringUI.show === 'function') {
                        try {
                          ringUI.show({ type: 'foundry', id: String(lightId) }, sprite);
                          return;
                        } catch (_) {
                        }
                    }

                    log.info(`Opening config for light ${lightId}`);
                    light.sheet.render(true);
                    return;
                }
            }
        }

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
        const interactables = this.tokenManager.getAllTokenSprites();
        const intersects = this.raycaster.intersectObjects(interactables, false);

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

      this.dragMeasure.active = false;
      if (this.dragMeasure.el) this.dragMeasure.el.style.display = 'none';

      if (targetObject.userData.tokenDoc && this.dragMeasure.el) {
        const startWorld = leaderPreview.position;
        const startF = Coordinates.toFoundry(startWorld.x, startWorld.y);
        this.dragMeasure.startFoundry.x = startF.x;
        this.dragMeasure.startFoundry.y = startF.y;
        this.dragMeasure.active = true;
        this.dragMeasure.el.style.display = 'block';
        this.dragMeasure.el.textContent = '';
      }
      
      if (window.MapShine?.cameraController) {
        window.MapShine.cameraController.enabled = false;
      }

      // Enhanced lights: hide the LOS-based radius gizmo while dragging.
      // The polygon does not update in real-time, so keeping it visible looks incorrect.
      try {
        const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
        if (enhancedLightIconManager && this.selection && this.selection.size > 0) {
          for (const sid of this.selection) {
            if (enhancedLightIconManager.lights?.has?.(sid)) {
              enhancedLightIconManager.setDragging?.(sid, true);
            }
          }
        }
      } catch (_) {
      }
  }

  _getMapPointHandleAtPosition(clientX, clientY) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    const camera = this.sceneComposer?.camera;
    if (!mapPointsManager?.showVisualHelpers || !camera) return null;

    const rect = this.canvasElement.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;

    this.updateMouseCoords({ clientX, clientY });
    this.raycaster.setFromCamera(this.mouse, camera);

    const helpers = Array.from(mapPointsManager.visualObjects?.values?.() ?? []);
    if (!helpers.length) return null;

    const intersects = this.raycaster.intersectObjects(helpers, true);
    if (!intersects.length) return null;

    for (const hit of intersects) {
      let obj = hit.object;
      while (obj) {
        if (obj.userData?.type === 'mapPointHandle') {
          return {
            groupId: obj.userData.groupId,
            pointIndex: obj.userData.pointIndex,
            object: obj,
            hitPoint: hit.point
          };
        }
        obj = obj.parent;
      }
    }

    return null;
  }

  _getMapPointHelperGroupFromObject(object) {
    let obj = object;
    while (obj) {
      if (obj.userData?.type === 'mapPointHelper') return obj;
      obj = obj.parent;
    }
    return null;
  }

  startMapPointHandleDrag(handleObject, hitPoint, groupId, pointIndex) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    const group = mapPointsManager?.getGroup?.(groupId);
    if (!group || !Array.isArray(group.points) || !Number.isFinite(pointIndex)) return;
    if (pointIndex < 0 || pointIndex >= group.points.length) return;

    let handleRoot = handleObject;
    while (
      handleRoot?.parent &&
      handleRoot.parent.userData?.type === 'mapPointHandle' &&
      handleRoot.parent.userData?.groupId === groupId &&
      handleRoot.parent.userData?.pointIndex === pointIndex
    ) {
      handleRoot = handleRoot.parent;
    }

    this.dragState.active = true;
    this.dragState.mode = 'mapPointHandle';
    this.dragState.object = handleRoot;
    this.dragState.hasMoved = false;
    this.dragState.mapPointGroupId = groupId;
    this.dragState.mapPointIndex = pointIndex;
    this.dragState.mapPointPoints = group.points.map((p) => ({ x: p.x, y: p.y }));
    this.dragState.startPos.copy(handleRoot.position);
    this.dragState.offset.subVectors(handleRoot.position, hitPoint);

    if (window.MapShine?.cameraController) {
      window.MapShine.cameraController.enabled = false;
    }
  }

  _updateDraggedMapPointHelperGeometry() {
    const groupId = this.dragState.mapPointGroupId;
    const points = this.dragState.mapPointPoints;
    if (!groupId || !Array.isArray(points) || points.length === 0) return;

    const helperGroup = this._getMapPointHelperGroupFromObject(this.dragState.object);
    if (!helperGroup) return;

    const helperZ = helperGroup.userData?.helperZ ?? helperGroup.position?.z ?? 0;

    const updateLineGeometry = (line, closeLoop) => {
      const posAttr = line?.geometry?.getAttribute?.('position');
      if (!posAttr) return;

      const expectedCount = closeLoop ? (points.length + 1) : points.length;
      if (posAttr.count !== expectedCount) return;

      for (let i = 0; i < points.length; i++) {
        posAttr.setXYZ(i, points[i].x, points[i].y, helperZ);
      }
      if (closeLoop) {
        posAttr.setXYZ(points.length, points[0].x, points[0].y, helperZ);
      }
      posAttr.needsUpdate = true;
      line.geometry.computeBoundingSphere?.();
    };

    for (const child of helperGroup.children) {
      if (child?.userData?.type === 'mapPointLine') {
        updateLineGeometry(child, false);
      }
      if (child?.userData?.type === 'mapPointOutline') {
        updateLineGeometry(child, true);
      }
    }
  }

  onWheel(event) {
    try {
      if (this._isEventFromUI(event)) return;

      const rect = this.canvasElement.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) return;

      if (this.dragState?.active) return;

      if (event.ctrlKey) event.preventDefault();

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
      layer._onMouseWheel?.(event);
    } catch (err) {
      log.error('Error in onWheel:', err);
    }
  }

  /**
   * Handle pointer down (select / start drag)
   * @param {PointerEvent} event 
   */
  onPointerDown(event) {
    try {
        if (this._isEventFromUI(event)) return;

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

        // Handle Map Point Drawing Mode (takes priority over other interactions)
        if (this.mapPointDraw.active && event.button === 0) {
          const worldPos = this.screenToWorld(event.clientX, event.clientY);
          if (worldPos) {
            this._addMapPoint(worldPos.x, worldPos.y, event.shiftKey);
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        }

        // Handle right-click on map point helpers (context menu)
        if (event.button === 2) {
          const clickedGroupId = this._getMapPointGroupAtPosition(event.clientX, event.clientY);
          if (clickedGroupId) {
            event.preventDefault();
            event.stopPropagation();
            this._showMapPointContextMenu(clickedGroupId, event.clientX, event.clientY);
            return;
          }
        }

        // Handle left-click on map point helpers (select/edit)
        if (event.button === 0) {
          const mapPointsManager = window.MapShine?.mapPointsManager;
          if (mapPointsManager?.showVisualHelpers) {
            const handleHit = this._getMapPointHandleAtPosition(event.clientX, event.clientY);
            if (handleHit) {
              event.preventDefault();
              event.stopPropagation();
              this.startMapPointHandleDrag(handleHit.object, handleHit.hitPoint, handleHit.groupId, handleHit.pointIndex);
              return;
            }

            const clickedGroupId = this._getMapPointGroupAtPosition(event.clientX, event.clientY);
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

        const isTokenLayerName = activeLayerName === 'TokenLayer' || activeLayerName === 'TokensLayer';
        const isTokenSelectTool = activeTool === 'select' || !activeTool;
        const shouldOverrideRouter = isTokenLayerName && isTokenSelectTool;
        
        if (inputRouter && !inputRouter.shouldThreeReceiveInput()) {
          let allowOverride = shouldOverrideRouter;

          // If the router is in PIXI mode (common on LightingLayer), we still want
          // Three.js to be able to select Three-rendered light icons.
          if (!allowOverride) {
            try {
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

                  try {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation?.();
                  } catch (_) {
                  }

                  try {
                    inputRouter.forceThree?.('InteractionManager light click');
                  } catch (e) {
                    log.warn('Failed to force THREE mode on light click', e);
                  }
                }
              }
            } catch (_) {
            }
          }

          if (allowOverride) {
            if (shouldOverrideRouter) {
              log.debug('onPointerDown overriding InputRouter block on Tokens layer; forcing THREE mode');
              try {
                inputRouter.forceThree?.('InteractionManager token click');
              } catch (e) {
                log.warn('Failed to force THREE mode on token click', e);
              }
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

        log.debug('onPointerDown mouse NDC', {
          ndcX: this.mouse.x,
          ndcY: this.mouse.y
        });
        
        const tokenSprites = this.tokenManager.getAllTokenSprites();
        log.debug('onPointerDown tokenSprites count', { count: tokenSprites.length });
        const wallGroup = this.wallManager.wallGroup;

        // Handle Right Click (Potential HUD or Door Lock/Unlock)
        if (event.button === 2) {
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

                // NOTE: We do NOT preventDefault or stopPropagation here because
                // CameraController needs to see this event to start Panning (Right Drag).
                // If the user moves the mouse > threshold, rightClickState.active becomes false
                // and the HUD won't open (standard Foundry behavior).
                return;
            } else {
                log.debug('Right click down: No token hit');
            }
            return;
        }
        
        const activeLayer = canvas.activeLayer?.name;
        const groundZ = this.sceneComposer?.groundZ ?? 0;
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
          const activeTool = ui?.controls?.tool?.name ?? game.activeTool;
          const isMapShineLightTool = activeTool === 'map-shine-enhanced-light';

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
                  if (!isSelected) this.selectObject(sprite, { showRingUI: false });
                } else {
                  if (!isSelected) {
                    this.clearSelection();
                    this.selectObject(sprite, { showRingUI: false });
                  }
                }

                // Defer ring opening to pointerup; defer dragging until movement exceeds threshold.
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
          if (this.lightIconManager && !isMapShineLightTool) {
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
                  if (!isSelected) this.selectObject(sprite, { showRingUI: false });
                } else {
                  if (!isSelected) {
                    this.clearSelection();
                    this.selectObject(sprite, { showRingUI: false });
                  }
                }

                // Defer ring opening to pointerup; defer dragging until movement exceeds threshold.
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

          if (isMapShineLightTool) {
            // MapShine Enhanced Light Placement
            this.enhancedLightPlacement.active = true;
            this.enhancedLightPlacement.start.set(snappedWorld.x, snappedWorld.y, groundZ);
            this.enhancedLightPlacement.current.set(snappedWorld.x, snappedWorld.y, groundZ);
            
            // Initialize Visuals
            this.enhancedLightPlacement.previewGroup.position.copy(this.enhancedLightPlacement.start);
            this.enhancedLightPlacement.previewGroup.position.z = groundZ + 0.05;
            this.enhancedLightPlacement.previewGroup.scale.set(1, 1, 1);
            this.enhancedLightPlacement.previewGroup.visible = true;

            // Start with a tiny preview so the shader has a sane radius.
            this._updateLightPlacementPreviewGeometry(this.enhancedLightPlacement, this.enhancedLightPlacement.start, 0.1);
          } else {
            // Foundry Light Placement
            if (!canvas.lighting) return;
            
            this.lightPlacement.active = true;
            this.lightPlacement.start.set(snappedWorld.x, snappedWorld.y, groundZ);
            this.lightPlacement.current.set(snappedWorld.x, snappedWorld.y, groundZ);
            
            // Initialize Visuals
            this.lightPlacement.previewGroup.position.copy(this.lightPlacement.start);
            this.lightPlacement.previewGroup.position.z = groundZ + 0.05;
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

        const intersects = this.raycaster.intersectObjects(tokenSprites, false);

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
          try {
            const fvttToken = canvas.tokens?.get(tokenDoc.id);
            if (fvttToken) {
              const releaseOthers = !event.shiftKey;
              // Do not pan camera here; CameraSync keeps Three.js aligned.
              fvttToken.control({ releaseOthers, pan: false });
            }
          } catch (err) {
            log.warn('Failed to sync selection to Foundry token', err);
          }
          
        } else {
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
          
          // Start Drag Select
          this.dragSelect.active = true;
          this.dragSelect.dragging = false;
          
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
  }

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
          try {
              if (hud?.rendered) hud.close();
          } catch (_) {
          }
          this.openHudTokenId = null;
          return;
      }
      
      const sprite = spriteData.sprite;
      
      // CRITICAL: Ensure camera matrices are up to date for accurate projection
      // This fixes "lag" or "parallax" where the HUD trails behind the camera
      this.sceneComposer.camera.updateMatrixWorld();
      this.sceneComposer.camera.updateProjectionMatrix();

      // Project world position to screen coordinates
      // We use the sprite's position (which is center bottom usually, or center? TokenManager puts it at center)
      // Token sprites are centered.
      const pos = sprite.position.clone();
      pos.project(this.sceneComposer.camera);
      
      // Convert NDC to CSS pixels
      // NDC: [-1, 1] -> CSS: [0, width/height]
      // Y is inverted in CSS (0 at top) vs NDC (1 at top)
      let rect = this.canvasElement.getBoundingClientRect();
      
      // Fallback if canvas rect is zero (e.g. not yet layout)
      // This fixes the "Top Left" (0,0) issue if rect is invalid
      let width = rect.width;
      let height = rect.height;
      let left = rect.left;
      let top = rect.top;

      if (width === 0 || height === 0) {
          width = window.innerWidth;
          height = window.innerHeight;
          left = 0;
          top = 0;
      }
      
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
          const hudEl = (hud.element instanceof jQuery || (hud.element.jquery)) ? hud.element[0] : hud.element;
          
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

              const style = {
                  left: `${x}px`,
                  top: `${y}px`,
                  transform: `translate(-50%, -50%) scale(${finalScale})`,
                  transformOrigin: 'center center',
                  zIndex: '100',
                  pointerEvents: 'auto',
                  position: 'fixed' // Use fixed to match screen coords
              };

              if (typeof hud.element.css === 'function') {
                  hud.element.css(style);
              } else if (hudEl.style) {
                  Object.assign(hudEl.style, style);
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
    this.updateMouseCoords(event);
    this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);

    let hitFound = false;

    // 1. Check Walls (Priority for "near line" detection)
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

    // 2. Check Overhead Tiles (for hover-to-hide behavior)
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
        const targetZ = this.sceneComposer?.groundZ ?? 0;
        const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -targetZ);
        const worldPoint = new THREE.Vector3();
        const intersection = this.raycaster.ray.intersectPlane(plane, worldPoint);

        let bestTileId = null;
        let bestZ = -Infinity;

        if (intersection) {
          for (const sprite of overheadSprites) {
            const tileId = sprite.userData.foundryTileId;
            const data = this.tileManager.tileSprites.get(tileId);
            if (!data) continue;

            // Pixel-opaque test (alpha > 0.5)
            // If available, this function also performs a rotation-aware bounds check.
            let opaqueHit = true;
            if (typeof this.tileManager.isWorldPointOpaque === 'function') {
              opaqueHit = this.tileManager.isWorldPointOpaque(data, worldPoint.x, worldPoint.y);
            } else {
              // Fallback: Quick AABB test in Foundry (top-left) space.
              // Convert the plane hit point to Foundry Y-down.
              const foundryPt = Coordinates.toFoundry(worldPoint.x, worldPoint.y);
              const foundryY = foundryPt.y;
              const foundryX = foundryPt.x;

              const { tileDoc } = data;
              const left = tileDoc.x;
              const right = tileDoc.x + tileDoc.width;
              const top = tileDoc.y;
              const bottom = tileDoc.y + tileDoc.height;

              opaqueHit = !(foundryX < left || foundryX > right || foundryY < top || foundryY > bottom);
            }
            if (!opaqueHit) continue;

            const z = sprite.position?.z ?? 0;
            if (z >= bestZ) {
              bestZ = z;
              bestTileId = tileId;
            }
          }
        }

        if (bestTileId) {
          if (this.hoveredOverheadTileId !== bestTileId) {
            if (this.hoveredOverheadTileId && this.tileManager.setTileHoverHidden) {
              this.tileManager.setTileHoverHidden(this.hoveredOverheadTileId, false);
            }
            this.hoveredOverheadTileId = bestTileId;
            if (this.tileManager.setTileHoverHidden) {
              this.tileManager.setTileHoverHidden(bestTileId, true);
            }
          }
          hitFound = true;
        } else if (this.hoveredOverheadTileId && this.tileManager.setTileHoverHidden) {
          this.tileManager.setTileHoverHidden(this.hoveredOverheadTileId, false);
          this.hoveredOverheadTileId = null;
        }
      }
    }

    // If we hit an overhead tile, don't hover tokens through it
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
    const interactables = this.tokenManager.getAllTokenSprites();
    const intersects = this.raycaster.intersectObjects(interactables, false);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const sprite = hit.object;
      const tokenDoc = sprite.userData.tokenDoc;
      
      // Check permissions
      const canControl = tokenDoc.canUserModify(game.user, "update"); // Or just visible? 
      // We want hover even if we can't move it, just to show name.
      
      if (this.hoveredTokenId !== tokenDoc.id) {
        // Hover changed
        if (this.hoveredTokenId) {
          this.tokenManager.setHover(this.hoveredTokenId, false);
        }
        this.hoveredTokenId = tokenDoc.id;
        this.tokenManager.setHover(this.hoveredTokenId, true);
        
        // Cursor
        this.canvasElement.style.cursor = canControl ? 'pointer' : 'default';
      }
    } else {
      // No hit
      if (this.hoveredTokenId) {
        this.tokenManager.setHover(this.hoveredTokenId, false);
        this.hoveredTokenId = null;
        this.canvasElement.style.cursor = 'default';
      }
    }
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
          !this.enhancedLightPlacement?.active &&
          !this.mapPointDraw?.active &&
          !this.rightClickState?.active &&
          !this._pendingLight?.active
        ) {
          return;
        }

        // PERFORMANCE: Skip expensive hover detection if mouse is not over the canvas.
        // This prevents raycasting when hovering over Tweakpane UI or other overlays.
        // We still process active drags/draws since those need to track mouse globally.
        const isOverCanvas = event.target === this.canvasElement || 
                             this.canvasElement.contains(event.target);
        
        // Check Right Click Threshold (Cancel HUD if dragged)
        if (this.rightClickState.active) {
            const dist = Math.hypot(event.clientX - this.rightClickState.startPos.x, event.clientY - this.rightClickState.startPos.y);
            if (dist > this.rightClickState.threshold) {
                log.debug(`Right click cancelled: moved ${dist.toFixed(1)}px (threshold ${this.rightClickState.threshold}px)`);
                this.rightClickState.active = false; // It's a drag/pan, not a click
            }
        }

        // Pending light interaction: start drag only after crossing a screen-space threshold.
        if (this._pendingLight?.active && !this.dragState?.active) {
          const dx = event.clientX - this._pendingLight.startClientX;
          const dy = event.clientY - this._pendingLight.startClientY;
          const dist = Math.hypot(dx, dy);
          if (dist > (this._pendingLight.thresholdPx ?? 8)) {
            if (this._pendingLight.canEdit && this._pendingLight.sprite && this._pendingLight.hitPoint) {
              // Hide ring if it was open for some reason; we are starting an actual drag.
              try {
                const ringUI = window.MapShine?.lightRingUI;
                ringUI?.hide?.();
              } catch (_) {
              }

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
            this._updateMapPointPreview(cursorX, cursorY);
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

        // Case 0.26: MapShine Enhanced Light Placement Drag
        if (this.enhancedLightPlacement.active) {
             this.updateMouseCoords(event);
             const targetZ = this.enhancedLightPlacement.start?.z ?? (this.sceneComposer?.groundZ ?? 0);
             const worldPos = this.viewportToWorld(event.clientX, event.clientY, targetZ);
             if (worldPos) {
                 this.enhancedLightPlacement.current.set(worldPos.x, worldPos.y, targetZ);
                 
                 // Calculate radius in World Units
                 const dx = this.enhancedLightPlacement.current.x - this.enhancedLightPlacement.start.x;
                 const dy = this.enhancedLightPlacement.current.y - this.enhancedLightPlacement.start.y;
                 const radius = Math.sqrt(dx*dx + dy*dy);

                 // Update Visuals: rebuild wall-clipped polygon geometry in real time.
                 this._updateLightPlacementPreviewGeometry(this.enhancedLightPlacement, this.enhancedLightPlacement.start, Math.max(radius, 0.1));
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

            this._updateDraggedMapPointHelperGeometry();
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
          if (overlay) {
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
          }

          return;
        }

        // Case 2: Hover (if not dragging object)
        // PERFORMANCE: Only do expensive hover raycasting if mouse is over the canvas.
        // This prevents frame drops when hovering over Tweakpane UI.
        if (!this.dragState.active || !this.dragState.object) {
          if (isOverCanvas) {
            this.handleHover(event);
          }
          return;
        }

        // Case 3: Object Drag
        this.dragState.hasMoved = true;
        this.updateMouseCoords(event);
        
        // Raycast to find world position on the z-plane of the object
        // Use the object's current Z for the intersection plane
        const targetZ = this.dragState.object.position.z;
        
        // Get world position at the target Z plane
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
          
          // Snap to grid logic if Shift is NOT held and this is NOT a light drag
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

          const deltaX = x - leaderInitial.x;
          const deltaY = y - leaderInitial.y;

          // Apply delta to ALL previews
          for (const [id, preview] of this.dragState.previews) {
            const initialPos = this.dragState.initialPositions.get(id);
            if (initialPos) {
              preview.position.x = initialPos.x + deltaX;
              preview.position.y = initialPos.y + deltaY;
            }
          }

          if (this.dragMeasure.active && this.dragMeasure.el && canvas?.grid?.measurePath) {
            const leaderPreview = this.dragState.previews.get(this.dragState.leaderId);
            if (leaderPreview) {
              const curF = Coordinates.toFoundry(leaderPreview.position.x, leaderPreview.position.y);
              const measurement = canvas.grid.measurePath([
                { x: this.dragMeasure.startFoundry.x, y: this.dragMeasure.startFoundry.y },
                { x: curF.x, y: curF.y }
              ]);

              const units = canvas.grid.units || canvas.scene?.grid?.units || '';
              const dist = (measurement?.distance ?? 0);
              const distLabel = dist.toNearest ? dist.toNearest(0.01).toLocaleString(game.i18n.lang) : String(dist);
              this.dragMeasure.el.textContent = units ? `${distLabel} ${units}` : `${distLabel}`;
              this.dragMeasure.el.style.left = `${event.clientX + 16}px`;
              this.dragMeasure.el.style.top = `${event.clientY + 16}px`;
            }
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
   * Handle pointer up (end drag)
   * @param {PointerEvent} event 
   */
  async onPointerUp(event) {
    try {
        if (
          this._isEventFromUI(event) &&
          !this.dragState?.active &&
          !this.dragSelect?.active &&
          !this.wallDraw?.active &&
          !this.lightPlacement?.active &&
          !this.mapPointDraw?.active &&
          !this.rightClickState?.active &&
          !this._pendingLight?.active
        ) {
          return;
        }

        // Pending light click: only open the ring on a true click (no drag threshold exceeded).
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
            try {
              const ringUI = window.MapShine?.lightRingUI;
              if (type === 'foundry') {
                const light = canvas?.lighting?.get?.(id);
                const doc = light?.document;
                if (doc && doc.testUserPermission(game.user, 'LIMITED')) {
                  if (forceSheet) {
                    light?.sheet?.render?.(true);
                  } else {
                    ringUI?.show?.({ type: 'foundry', id: String(id) }, sprite);
                  }
                }
              } else if (type === 'enhanced') {
                const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
                const root = enhancedLightIconManager?.getRootObject?.(id) || sprite;
                ringUI?.show?.({ type: 'enhanced', id: String(id) }, root);
              }
            } catch (_) {
            }
          }

          return;
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
            const conversion = canvas.dimensions.distance / canvas.dimensions.size;
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

            try {
                await canvas.scene.createEmbeddedDocuments('AmbientLight', [data]);
                log.info(`Created AmbientLight at (${startF.x.toFixed(1)}, ${startF.y.toFixed(1)}) with dim radius ${dim.toFixed(1)}`);
            } catch (e) {
                log.error('Failed to create AmbientLight', e);
            }
            
            return;
        }

        // Handle MapShine Enhanced Light Placement End
        if (this.enhancedLightPlacement.active) {
            this.enhancedLightPlacement.active = false;
            this.enhancedLightPlacement.previewGroup.visible = false;

            // Re-enable camera controls
            if (window.MapShine?.cameraController) {
                window.MapShine.cameraController.enabled = true;
            }

            // Calculate final parameters
            const startWorld = this.enhancedLightPlacement.start;
            const currentWorld = this.enhancedLightPlacement.current;

            // Convert to Foundry Coords
            const startF = Coordinates.toFoundry(startWorld.x, startWorld.y);
            const currentF = Coordinates.toFoundry(currentWorld.x, currentWorld.y);

            // Calculate Radius in Pixels
            const dx = currentF.x - startF.x;
            const dy = currentF.y - startF.y;
            const radiusPixels = Math.hypot(dx, dy);

            // Minimum threshold to prevent accidental tiny lights
            const isClick = radiusPixels < 10;
            if (isClick) {
                return;
            }

            // Convert Pixel Radius to Distance Units
            const conversion = canvas.dimensions.distance / canvas.dimensions.size;
            const dim = radiusPixels * conversion;
            const bright = dim / 2;

            // Create MapShine Enhanced Light via API
            const enhancedLightsApi = window.MapShine?.enhancedLights;
            if (!enhancedLightsApi) {
                log.error('MapShine.enhancedLights API not available');
                ui.notifications?.error?.('MapShine Enhanced Lights API not available');
                return;
            }

            try {
                await enhancedLightsApi.create({
                    transform: { x: startF.x, y: startF.y },
                    photometry: { bright, dim, alpha: 1.0, luminosity: 0.5, attenuation: 0.5 },
                    color: '#ffffff',
                    enabled: true,
                    isDarkness: false,
                    targetLayers: 'both'
                });
                log.info(`Created MapShine Enhanced Light at (${startF.x.toFixed(1)}, ${startF.y.toFixed(1)}) with dim radius ${dim.toFixed(1)}`);
            } catch (e) {
                log.error('Failed to create MapShine Enhanced Light', e);
                ui.notifications?.error?.('Failed to create MapShine Enhanced Light');
            }
            
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
              
              try {
                  await wall.document.update({c});
                  log.info(`Updated wall ${wallId} coords`);
              } catch(e) {
                  log.error('Failed to update wall', e);
                  // Revert visual by re-syncing from original doc
                  this.wallManager.update(wall.document, {c: wall.document.c}); 
              }
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
            try {
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
            } catch (e) {
              log.error('Failed to update map point group from drag', e);
            }
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
          
          try {
            await canvas.scene.createEmbeddedDocuments('Wall', [data]);
            log.info('Created wall segment');
            
            // Chain? If Ctrl held, start new segment from endF
            if (event.ctrlKey) {
               // TODO: Implement Chaining logic
               // For now, simple single segment
            }
          } catch (e) {
            log.error('Failed to create wall', e);
          }
          
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
          // Foundry selects if CENTER is within bounds
          const tokens = this.tokenManager.getAllTokenSprites();
          
          for (const sprite of tokens) {
            const x = sprite.position.x;
            const y = sprite.position.y;
            
            if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
              const tokenDoc = sprite.userData.tokenDoc;
              // Only select if we have permission (observer or owner usually can select, but control requires owner)
              // Foundry allows selecting visible tokens usually.
              // We'll check canUserModify("update") to mirror our click selection logic
              if (tokenDoc.canUserModify(game.user, "update")) {
                this.selectObject(sprite);
              }
            }
          }
          
          return;
        }

        if (!this.dragState.active) return;

        if (this.dragMeasure.el) {
          this.dragMeasure.el.style.display = 'none';
        }
        this.dragMeasure.active = false;

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
                
                // COLLISION CHECK (Tokens Only)
                // ... (Collision logic moved here or reused)
                const token = tokenDoc.object;
                if (token) {
                    const origin = token.center;
                    const gridSize = canvas.grid?.size || 100;
                    const snapToCenter = (pt) => canvas.grid.getSnappedPoint(pt, { mode: CONST.GRID_SNAPPING_MODES.CENTER });

                    // Always resolve against snapped grid centers so we don't land half-inside a wall/door.
                    const desired = snapToCenter(foundryPos);

                    // Diagonal-safe behavior: walk from origin towards desired, and pick the last
                    // snapped tile center which does not collide.
                    // Backtracking from the target can fail diagonally due to snap rounding.
                    let lastValid = snapToCenter(origin);
                    const dx = desired.x - origin.x;
                    const dy = desired.y - origin.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist >= 1) {
                        // Sample at quarter-grid intervals (bounded) and dedupe snapped points.
                        const sampleStep = Math.max(1, gridSize * 0.25);
                        const steps = Math.min(250, Math.ceil(dist / sampleStep));
                        const seen = new Set();

                        for (let i = 1; i <= steps; i++) {
                            const t = i / steps;
                            const sample = { x: origin.x + dx * t, y: origin.y + dy * t };
                            const snapped = snapToCenter(sample);
                            const key = `${snapped.x},${snapped.y}`;
                            if (seen.has(key)) continue;
                            seen.add(key);

                            const collision = token.checkCollision(snapped, { mode: 'closest', type: 'move' });
                            if (collision) break;
                            lastValid = snapped;
                        }
                    }

                    foundryPos = lastValid;
                }

                // Adjust for center vs top-left
                const width = tokenDoc.width * canvas.grid.size;
                const height = tokenDoc.height * canvas.grid.size;
                const finalX = foundryPos.x - width / 2;
                const finalY = foundryPos.y - height / 2;
                
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
                    try {
                        await enhancedLightsApi.update(id, { transform: { x: foundryPos.x, y: foundryPos.y } });
                        log.info(`Updated MapShine Enhanced Light ${id} position`);
                        anyUpdates = true;
                        anyEnhancedLightUpdates = true;
                    } catch (err) {
                        log.error(`Failed to update MapShine Enhanced Light ${id}`, err);
                    }
                }
                continue;
            }
          }

          // Re-enable enhanced light gizmos now that drag is ending.
          // If enhanced light positions changed, force a gizmo resync so the LOS polygon matches.
          try {
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
          } catch (_) {
          }

          if (tokenUpdates.length > 0) {
            log.info(`Updating ${tokenUpdates.length} tokens`);
            anyUpdates = true;
            try {
              await canvas.scene.updateEmbeddedDocuments('Token', tokenUpdates);
            } catch (err) {
              log.error('Failed to update token positions', err);
            }
          }

          if (lightUpdates.length > 0) {
              log.info(`Updating ${lightUpdates.length} lights`);
              anyUpdates = true;
              try {
                  await canvas.scene.updateEmbeddedDocuments('AmbientLight', lightUpdates);
              } catch (err) {
                  log.error('Failed to update light positions', err);
              }
          }
            
          // Cleanup
          this.dragState.active = false;
          this.dragState.object = null;

          // For tokens: keep the ghost preview around until the authoritative update
          // actually starts moving the token (matching Foundry).
          if (tokenUpdates.length > 0) {
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

            // Drag canceled / no movement: restore enhanced light gizmo visibility.
            try {
              const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
              if (enhancedLightIconManager && this.selection && this.selection.size > 0) {
                for (const sid of this.selection) {
                  if (enhancedLightIconManager.lights?.has?.(sid)) {
                    enhancedLightIconManager.setDragging?.(sid, false);
                  }
                }
              }
            } catch (_) {
            }

            this._clearAllDragPreviews();
        }
    } catch (error) {
        log.error('Error in onPointerUp:', error);
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
    
    return data;
  }

  /**
   * Handle key down (delete)
   * @param {KeyboardEvent} event 
   */
  async onKeyDown(event) {
    if (this._isEventFromUI(event)) return;

    // Intercept Delete/Backspace early so Foundry doesn't also process it.
    // (Otherwise you can get double-deletes and "does not exist" notifications.)
    if ((event.key === 'Delete' || event.key === 'Backspace') && (this.mapPointDraw.active || this.selection.size > 0)) {
      this._consumeKeyEvent(event);
    }

    // Handle Map Point Drawing Mode keys
    if (this.mapPointDraw.active) {
      if (event.key === 'Escape') {
        this.cancelMapPointDrawing();
        this._consumeKeyEvent(event);
        return;
      }
      if (event.key === 'Enter') {
        await this._finishMapPointDrawing();
        this._consumeKeyEvent(event);
        return;
      }
      // Backspace removes last point
      if (event.key === 'Backspace' && this.mapPointDraw.points.length > 0) {
        this.mapPointDraw.points.pop();
        this._updateMapPointPreview();
        this._consumeKeyEvent(event);
        return;
      }
    }

    // Delete key
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selection.size > 0) {
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
            log.info(`Deleting ${tokensToDelete.length} tokens`);
            await canvas.scene.deleteEmbeddedDocuments('Token', tokensToDelete);
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
                try {
                  await enhancedLightsApi.remove(id);
                } catch (err) {
                  log.error(`Failed to delete MapShine Enhanced Light ${id}`, err);
                }
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
    const rect = this.canvasElement.getBoundingClientRect();
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
    const rect = this.canvasElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    
    const THREE = window.THREE;
    const camera = this.sceneComposer.camera;
    
    if (!camera) return null;

    // Use the class raycaster to ensure consistency with selection logic
    // (avoiding manual unproject which might differ slightly)
    this.mouse.set(ndcX, ndcY);
    this.raycaster.setFromCamera(this.mouse, camera);

    // Create a plane at targetZ facing up (normal = 0,0,1)
    // Plane constant 'w' in Ax + By + Cz + w = 0
    // 0x + 0y + 1z - targetZ = 0  =>  z = targetZ
    // THREE.Plane takes (normal, constant) where constant is -distance from origin along normal
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -targetZ);
    
    const target = new THREE.Vector3();
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
    const showRingUI = opts?.showRingUI !== false;
    let id;
    let isToken = false;
    if (sprite.userData.tokenDoc) {
        id = sprite.userData.tokenDoc.id;
        isToken = true;
        this.tokenManager.setTokenSelection(id, true);

        // Keep Foundry's native token control state in sync.
        // Drag-select previously only updated MapShine selection, which meant
        // Foundry never fired controlToken/perception updates and fog/vision could break.
        try {
          const fvttToken = canvas.tokens?.get(id);
          if (fvttToken && !fvttToken.controlled) {
            fvttToken.control({ releaseOthers: false });
          }
        } catch (_) {
          // Ignore control errors
        }
    } else if (sprite.userData.lightId) {
        id = sprite.userData.lightId;
        // TODO: Visual selection for lights
        if (sprite.material) sprite.material.color.set(0x8888ff); // Tint blue

        // Scale bump on selection so it reads clearly.
        try {
          const base = sprite?.userData?.baseScale;
          if (base && Number.isFinite(base.x) && Number.isFinite(base.y)) {
            sprite.scale.set(base.x * 1.15, base.y * 1.15, base.z ?? 1);
          }
        } catch (_) {
        }

        if (showRingUI) {
          // Show MapShine light ring UI for Foundry lights.
          try {
            const ringUI = window.MapShine?.lightRingUI;
            if (ringUI && typeof ringUI.show === 'function') {
              ringUI.show({ type: 'foundry', id: String(id) }, sprite);
            }
          } catch (_) {
          }
        }
    } else if (sprite.userData.enhancedLightId) {
        id = sprite.userData.enhancedLightId;
        // Visual selection for MapShine enhanced lights
        if (sprite.material) sprite.material.color.set(0x44aaff); // Tint blue (MapShine color)

        try {
          const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
          enhancedLightIconManager?.setSelected?.(id, true);
        } catch (_) {
        }
        
        if (showRingUI) {
          // Prefer the in-world ring UI over the older inspector panel.
          try {
            const ringUI = window.MapShine?.lightRingUI;
            const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
            const root = enhancedLightIconManager?.getRootObject?.(id) || sprite;
            if (ringUI && typeof ringUI.show === 'function') {
              ringUI.show({ type: 'enhanced', id: String(id) }, root);
            }
          } catch (_) {
          }
        }

        // Ensure the legacy inspector stays out of the way.
        try {
          const inspector = window.MapShine?.enhancedLightInspector;
          inspector?.hide?.();
        } catch (_) {
        }
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
          try {
            const fvttToken = canvas.tokens?.get(id);
            if (fvttToken) fvttToken.release();
          } catch (_) {
            // Ignore release errors
          }
      }
      // Check Foundry Light
      if (this.lightIconManager && this.lightIconManager.lights.has(id)) {
          const sprite = this.lightIconManager.lights.get(id);
          if (sprite && sprite.material) sprite.material.color.set(0xffffff); // Reset tint

          // Reset scale if we stored a baseScale.
          try {
            const base = sprite?.userData?.baseScale;
            if (base && Number.isFinite(base.x) && Number.isFinite(base.y)) {
              sprite.scale.set(base.x, base.y, base.z ?? 1);
            }
          } catch (_) {
          }
      }
      // Check MapShine Enhanced Light
      const enhancedLightIconManager = window.MapShine?.enhancedLightIconManager;
      if (enhancedLightIconManager && enhancedLightIconManager.lights.has(id)) {
          const sprite = enhancedLightIconManager.lights.get(id);
          if (sprite && sprite.material) sprite.material.color.set(0x44aaff); // Reset to MapShine blue

          try {
            enhancedLightIconManager?.setSelected?.(id, false);
          } catch (_) {
          }
      }
      // Check Wall
      if (this.wallManager.walls.has(id)) {
          this.wallManager.select(id, false);
      }
    }
    this.selection.clear();
    
    // Hide ring UI when clearing selection.
    try {
      const ringUI = window.MapShine?.lightRingUI;
      ringUI?.hide?.();
    } catch (_) {
    }

    // Hide enhanced light inspector when clearing selection
    const inspector = window.MapShine?.enhancedLightInspector;
    if (inspector) {
      inspector.hide();
    }
    
    // NOTE: Vision/fog updates are now handled by MapShine's world-space fog
    // effect, which also consults Foundry's controlled tokens for GM bypass.
  }

  handleDoorClick(doorControl, event) {
      let object = doorControl;
      while (object && !object.userData?.wallId) object = object.parent;
      const wallId = object?.userData?.wallId;
      if (!wallId) return;

      const wallDoc = canvas.walls?.get?.(wallId)?.document ?? canvas.scene?.walls?.get?.(wallId);
      if (!wallDoc) return;

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
    
    this.clearSelection();
    log.info('InteractionManager disposed');
  }
}
