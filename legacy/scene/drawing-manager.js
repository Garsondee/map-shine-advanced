/**
 * @fileoverview Drawing manager - syncs Foundry drawings to THREE.js
 * Handles text and shape drawings for Gameplay Mode visibility.
 *
 * Floor-aware rendering: each drawing is assigned to its floor band via the
 * FloorLayerManager so the V2 compositor renders it inside that floor's pass.
 * The bottom-to-top LevelCompositePass then naturally occludes lower-floor
 * drawings with upper-floor tiles/roofs.
 *
 * @module scene/drawing-manager
 */
import { isGmLike } from '../core/gm-parity.js';


import { createLogger } from '../core/log.js';
import {
  readDocLevelsRange,
  resolveV14NativeDocFloorIndexMin,
} from '../foundry/levels-scene-flags.js';
import { resolveFloorIndexForElevation } from '../ui/levels-editor/level-boundaries.js';
import {
  effectAboveOverheadOrder,
  GROUND_Z,
  Z_PER_FLOOR,
} from '../compositor-v2/LayerOrderPolicy.js';
import { FLOOR_LAYERS } from '../compositor-v2/FloorLayerManager.js';

const log = createLogger('DrawingManager');

// Lift drawings just above the overhead tile slab for their floor so they sit
// visually on top of roofs on the same floor but stay below the upper floor's
// tile band (compositor handles cross-floor occlusion).
const DRAWING_Z_LIFT_ABOVE_FLOOR = 6;

/**
 * DrawingManager - Synchronizes Foundry VTT drawings to THREE.js
 */
export class DrawingManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene
   */
  constructor(scene) {
    this.scene = scene;
    const THREE = window.THREE;

    /** @type {Map<string, THREE.Object3D>} */
    this.drawings = new Map();

    /** @type {Map<string, number>} - drawingId -> resolved floor index */
    this._drawingFloorIndex = new Map();

    this.initialized = false;
    this.hooksRegistered = false;

    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];

    // Group for all drawings. Z is set per-child based on floor index, so the
    // parent group sits at origin and never affects per-child positioning.
    this.group = new THREE.Group();
    this.group.name = 'Drawings';
    this.group.userData = {
      type: 'sceneDrawingsRoot',
      preserveOnBusClear: true,
    };
    this.group.position.z = 0;
    // The parent group keeps layer 0 enabled so traversal walks work, but each
    // child mesh is moved off layer 0 and onto its floor layer at create time.
    this.scene.add(this.group);

    log.debug('DrawingManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;

    this.setupHooks();
    this.syncAllDrawings();
    this._repositionAllDrawingsZ();
    this._reapplyLayersToAll();
    this._syncDrawingFloorVisibility();
    this.updateVisibility();

    this.initialized = true;
    log.info('DrawingManager initialized');
  }

  /**
   * Move the parent group onto the V2 FloorRenderBus scene (or any other
   * target) so drawings render inside the per-floor pipeline. Mirrors the
   * self-heal pattern used by {@link DoorMeshManager}.
   * @param {THREE.Scene|null} scene
   */
  setScene(scene) {
    if (!scene) return;
    const sceneChanged = scene !== this.scene;
    if (sceneChanged) {
      try { this.group?.parent?.remove?.(this.group); } catch (_) {}
      this.scene = scene;
    }
    if (this.group && this.group.parent !== this.scene) {
      try { this.scene.add(this.group); } catch (_) {}
    }
    this._repositionAllDrawingsZ();
    this._reapplyLayersToAll();
  }

  /**
   * @returns {THREE.Scene|null}
   * @private
   */
  _getV2BusScene() {
    return window.MapShine?.floorCompositorV2?._renderBus?._scene
      ?? window.MapShine?.effectComposer?._floorCompositorV2?._renderBus?._scene
      ?? null;
  }

  /**
   * World Z for a drawing on its floor band. V2 bus meshes must NOT add
   * sceneComposer.groundZ (camera sits at Z=2000, ground at 1000) — see DoorMeshManager.
   * @param {number} floorIndex
   * @returns {number}
   * @private
   */
  _resolveDrawingWorldZ(floorIndex) {
    const fi = Math.max(0, Math.floor(Number(floorIndex) || 0));
    const busScene = this._getV2BusScene();
    const onBus = !!(busScene && this.scene === busScene);
    if (onBus) {
      return GROUND_Z + fi * Z_PER_FLOOR + DRAWING_Z_LIFT_ABOVE_FLOOR;
    }
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    return (Number.isFinite(groundZ) ? groundZ : 0) + GROUND_Z + fi * Z_PER_FLOOR + DRAWING_Z_LIFT_ABOVE_FLOOR;
  }

  /**
   * Re-apply Z after migrating onto the FloorRenderBus scene.
   * @private
   */
  _repositionAllDrawingsZ() {
    for (const [id, group] of this.drawings) {
      const fi = this._drawingFloorIndex.get(id) ?? 0;
      group.position.z = this._resolveDrawingWorldZ(fi);
    }
  }

  /**
   * Per-frame hook. Re-parents the drawing group into the FloorRenderBus scene
   * as soon as that scene exists, so we never end up orphaned in the legacy
   * main Three scene after init-order races.
   */
  update() {
    try {
      const busScene = this._getV2BusScene();
      if (busScene && this.scene !== busScene) {
        this.setScene(busScene);
      } else if (this.group && this.scene && this.group.parent !== this.scene) {
        // FloorRenderBus.populate() clear() can detach us; re-attach every frame.
        try { this.scene.add(this.group); } catch (_) {}
      }
      this._repositionAllDrawingsZ();
      this._reapplyLayersToAll();
      this._syncDrawingFloorVisibility();
    } catch (_) {}
  }

  /**
   * Re-apply layer masks after a scene migration.
   * @private
   */
  _reapplyLayersToAll() {
    for (const [id, group] of this.drawings) {
      this._applyFloorLayer(group, this._drawingFloorIndex.get(id) ?? 0);
    }
  }

  /**
   * Keep drawings in the currently visible floor slice. The actual per-pixel
   * lower-floor occlusion happens in the V2 per-floor render/composite path.
   * @private
   */
  _syncDrawingFloorVisibility() {
    if (canvas?.drawings?.active) return;
    const bus = window.MapShine?.floorCompositorV2?._renderBus
      ?? window.MapShine?.effectComposer?._floorCompositorV2?._renderBus
      ?? null;
    const maxFi = Number(bus?._visibleMaxFloorIndex);
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    const multiFloor = Array.isArray(floors) && floors.length > 1;
    if (!multiFloor || !Number.isFinite(maxFi)) {
      for (const group of this.drawings.values()) group.visible = true;
      return;
    }
    for (const [id, group] of this.drawings) {
      const fi = this._drawingFloorIndex.get(id) ?? 0;
      group.visible = fi <= maxFi;
    }
  }

  /**
   * Setup Foundry hooks
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    this._hookIds.push(['createDrawing', Hooks.on('createDrawing', (doc) => this.create(doc))]);
    this._hookIds.push(['updateDrawing', Hooks.on('updateDrawing', (doc, changes) => this.update_(doc, changes))]);
    this._hookIds.push(['deleteDrawing', Hooks.on('deleteDrawing', (doc) => this.remove(doc.id))]);

    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
        this.syncAllDrawings();
        this.updateVisibility();
    })]);

    // Keep baseline Foundry visibility in sync with vision/perception refreshes.
    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => this.refreshVisibility())]);

    // Level context / controlled token changes can shift which floor a drawing
    // belongs to (rare, but supported when the doc has an explicit range).
    this._hookIds.push(['mapShineLevelContextChanged', Hooks.on('mapShineLevelContextChanged', () => {
      this._reassignAllFloors();
      this._syncDrawingFloorVisibility();
    })]);
    this._hookIds.push(['controlToken', Hooks.on('controlToken', () => this.refreshVisibility())]);

    // Drawing layer activate/deactivate — hide Three drawings while the native
    // PIXI Drawings tool is active so editing handles aren't doubled up.
    this._hookIds.push(['activateDrawingsLayer', Hooks.on('activateDrawingsLayer', () => this.updateVisibility())]);
    this._hookIds.push(['deactivateDrawingsLayer', Hooks.on('deactivateDrawingsLayer', () => {
      this.updateVisibility();
      this.syncAllDrawings();
    })]);
    this._hookIds.push(['renderSceneControls', Hooks.on('renderSceneControls', () => this.updateVisibility())]);

    this.hooksRegistered = true;
  }

  /**
   * Set visibility of Three.js drawings
   * @param {boolean} visible
   * @public
   */
  setVisibility(visible) {
    this.group.visible = visible;
  }

  /**
   * Hide Three-native copies only while the Drawings tool is active so Foundry
   * PIXI owns editing handles. In all other modes (gameplay, walls, tokens, …)
   * the Three copies stay visible.
   * @private
   */
  updateVisibility() {
    this.setVisibility(!canvas?.drawings?.active);
  }

  /**
   * Resolve the floor index a drawing belongs to. Mirrors the logic used by
   * {@link FloorLayerManager} for tiles so the chosen floor matches the V2
   * compositor's per-floor render passes.
   *
   * Returns 0 in single-floor scenes.
   * @param {object} doc - Drawing document (or placeable wrapper)
   * @returns {number}
   * @private
   */
  _resolveDrawingFloorIndex(doc) {
    const drawingDoc = doc?.document ?? doc;
    const floors = window.MapShine?.floorStack?.getFloors?.() ?? [];
    if (!floors.length || floors.length <= 1) return 0;

    const maxIndex = Math.min(floors.length, FLOOR_LAYERS.length) - 1;

    // V14-native level membership wins when present.
    const scene = drawingDoc?.parent ?? canvas?.scene ?? null;
    const v14Idx = resolveV14NativeDocFloorIndexMin(drawingDoc, scene);
    if (v14Idx !== null && Number.isFinite(v14Idx)) {
      return Math.max(0, Math.min(maxIndex, v14Idx));
    }

    // Legacy Levels range flags (`flags.levels.rangeBottom/rangeTop`).
    const range = readDocLevelsRange(drawingDoc);
    const hasFiniteRange = Number.isFinite(range.rangeBottom) || Number.isFinite(range.rangeTop);
    if (hasFiniteRange) {
      const bottom = Number.isFinite(range.rangeBottom) ? Number(range.rangeBottom) : 0;
      const top = Number.isFinite(range.rangeTop) ? Number(range.rangeTop) : bottom;
      const mid = (bottom + top) / 2;
      const byMid = resolveFloorIndexForElevation(mid, floors);
      if (byMid >= 0) return Math.min(maxIndex, byMid);
      const byBottom = resolveFloorIndexForElevation(bottom, floors);
      if (byBottom >= 0) return Math.min(maxIndex, byBottom);
    }

    // Foundry V14 drawings have a numeric `elevation` field — use it as a fallback.
    const rawElev = Number(drawingDoc?.elevation);
    if (Number.isFinite(rawElev)) {
      const byElev = resolveFloorIndexForElevation(rawElev, floors);
      if (byElev >= 0) return Math.min(maxIndex, byElev);
    }

    return 0;
  }

  /**
   * Apply floor-layer assignment and render order to a drawing subtree.
   * Drawings must render in the per-floor RTs (not the late overlay pass) so
   * lower-floor drawings are naturally occluded by upper-floor alpha.
   * @param {THREE.Object3D} root
   * @param {number} floorIndex
   * @private
   */
  _applyFloorLayer(root, floorIndex) {
    const safeIndex = Math.max(0, Math.min(FLOOR_LAYERS.length - 1, Math.floor(floorIndex)));
    const floorLayer = FLOOR_LAYERS[safeIndex];
    if (floorLayer === undefined) return;
    const order = effectAboveOverheadOrder(safeIndex, 1000);

    root.traverse((obj) => {
      if (!obj) return;
      obj.frustumCulled = false;
      if (!obj.layers) return;
      obj.layers.set(floorLayer);
      obj.renderOrder = order;
    });
  }

  /**
   * Check whether a drawing should be visible to the current user.
   * Baseline visibility mirrors existing behavior (hidden drawings are visible
   * to author/GM). Elevation/level range gating is intentionally NOT applied
   * here — visibility per floor is handled by the compositor through layer
   * assignment, so drawings on lower floors remain rendered in their own slice
   * and get occluded by upper-floor tiles when the viewer is above them.
   *
   * @param {DrawingDocument} doc
   * @returns {boolean}
   * @private
   */
  _isDrawingVisible(doc) {
    const drawingDoc = doc?.document ?? doc;
    if (!drawingDoc) return false;

    try {
      // Document hidden flag — respect author/GM parity only.
      if (drawingDoc.hidden) {
        const isGM = isGmLike();
        if (!isGM && !drawingDoc.isAuthor) return false;
      }

      // Do NOT gate on placeable.isVisible: Foundry sets that false whenever the
      // Drawings layer is inactive (PIXI stops drawing the shape). Gameplay still
      // needs the Three copy visible — that is the whole point of this manager.
    } catch (_) {
      // Fail-open: keep drawing visible if baseline check errors.
    }

    return true;
  }

  /**
   * Sync all drawings
   * @private
   */
  syncAllDrawings() {
    if (!canvas?.ready) return;

    /** @type {any[]} */
    let docs = [];

    const sceneDrawings = canvas.scene?.drawings;
    if (sceneDrawings) {
      if (Array.isArray(sceneDrawings)) {
        docs = sceneDrawings;
      } else if (Array.isArray(sceneDrawings.contents)) {
        docs = sceneDrawings.contents;
      } else if (typeof sceneDrawings.values === 'function') {
        docs = Array.from(sceneDrawings.values());
      } else if (typeof sceneDrawings[Symbol.iterator] === 'function') {
        docs = [];
        for (const entry of sceneDrawings) {
          if (Array.isArray(entry) && entry.length >= 2) docs.push(entry[1]);
          else docs.push(entry);
        }
      }
    }

    // Fallback: use placeables if the scene collection isn't accessible.
    if ((!docs || docs.length === 0) && Array.isArray(canvas.drawings?.placeables)) {
      docs = canvas.drawings.placeables.map(d => d?.document).filter(Boolean);
    }

    if (!Array.isArray(docs) || docs.length === 0) {
      log.debug('No drawings found to sync');
      return;
    }

    log.debug(`Syncing ${docs.length} drawings`);
    for (const drawingDoc of docs) {
      if (!drawingDoc?.id) continue;
      if (this._isDrawingVisible(drawingDoc)) {
        this.create(drawingDoc);
      } else {
        this.remove(drawingDoc.id);
      }
    }
    this._repositionAllDrawingsZ();
  }

  /**
   * Refresh visibility for already synced drawings.
   * @public
   */
  refreshVisibility() {
    if (!canvas?.scene?.drawings) return;
    for (const doc of canvas.scene.drawings) {
      const shouldShow = this._isDrawingVisible(doc);
      if (shouldShow && !this.drawings.has(doc.id)) {
        this.create(doc);
      } else if (!shouldShow && this.drawings.has(doc.id)) {
        this.remove(doc.id);
      }
    }
    this.syncAllDrawings();
  }

  /**
   * Re-evaluate every existing drawing's floor index. Called on level/floor
   * context changes so drawings with explicit range flags follow their band.
   * @private
   */
  _reassignAllFloors() {
    if (!canvas?.scene?.drawings) return;
    for (const doc of canvas.scene.drawings) {
      if (!doc?.id) continue;
      const group = this.drawings.get(doc.id);
      if (!group) continue;
      const floorIndex = this._resolveDrawingFloorIndex(doc);
      if (this._drawingFloorIndex.get(doc.id) === floorIndex) continue;
      this._drawingFloorIndex.set(doc.id, floorIndex);
      this._applyFloorLayer(group, floorIndex);
      if (group.userData) group.userData.floorIndex = floorIndex;
      const sceneHeight = canvas?.dimensions?.height || 10000;
      const drawingDoc = doc?.document ?? doc;
      const shape = drawingDoc.shape || {};
      const width = shape.width || drawingDoc.width || 0;
      const height = shape.height || drawingDoc.height || 0;
      const centerX = drawingDoc.x + width / 2;
      const centerY = drawingDoc.y + height / 2;
      const worldY = sceneHeight - centerY;
      const baseZ = this._resolveDrawingWorldZ(floorIndex);
      group.position.set(centerX, worldY, baseZ);
    }
  }

  /**
   * Create a drawing object
   * @param {DrawingDocument} doc
   * @private
   */
  create(doc) {
    const drawingDoc = doc?.document ?? doc;
    if (!drawingDoc?.id) return;
    if (this.drawings.has(drawingDoc.id)) return;
    if (!this._isDrawingVisible(drawingDoc)) return;

    try {
        const THREE = window.THREE;

        // Resolve the corresponding placeable, if available.
        // Depending on Foundry version and layer visibility, drawingDoc.object may be null.
        let placeable = drawingDoc.object;
        if (!placeable && doc?.document) placeable = doc;
        if (!placeable && Array.isArray(canvas.drawings?.placeables)) {
          placeable = canvas.drawings.placeables.find(d => (d?.document?.id === drawingDoc.id) || (d?.id === drawingDoc.id)) || null;
        }

        // Basic implementation: Render text if it has text, otherwise render a box
        const group = new THREE.Group();
        group.frustumCulled = false;

        // Use Drawing shape dimensions for placement, matching Foundry
        const shape = drawingDoc.shape || {};
        const width = shape.width || drawingDoc.width || 0;
        const height = shape.height || drawingDoc.height || 0;

        // Center of the drawing in Foundry coordinates (top-left origin, Y-down)
        const centerX = drawingDoc.x + width / 2;
        const centerY = drawingDoc.y + height / 2;

        // Convert to THREE world coordinates (Y-up) using scene height
        const sceneHeight = canvas.dimensions?.height || 10000;
        const worldY = sceneHeight - centerY;

        // Resolve the drawing's floor band and pin its Z just above that
        // floor's tile slab so it draws on top of the floor visually but
        // stays beneath the upper floor during multi-floor compositing.
        const floorIndex = this._resolveDrawingFloorIndex(drawingDoc);
        const baseZ = this._resolveDrawingWorldZ(floorIndex);

        group.position.set(centerX, worldY, baseZ);

        // Apply rotation around the center. Foundry rotates clockwise in screen-space;
        // we negate here to account for Y-up vs Y-down.
        if (drawingDoc.rotation) {
            group.rotation.z = THREE.MathUtils.degToRad(-drawingDoc.rotation);
        }

        // 1. Text Rendering (centered in the drawing box)
        // Foundry may render "pending" text during editing (placeable._pendingText)
        // even if the document text has not been committed yet.
        let displayText = drawingDoc.text;
        if ((displayText == null || displayText === '') && placeable) {
          if (placeable._pendingText !== undefined) displayText = placeable._pendingText;
          else if (placeable.text?.text !== undefined) displayText = placeable.text.text;
          else if (placeable.document?.text !== undefined) displayText = placeable.document.text;
        }
        if (displayText != null && String(displayText).length > 0) {
          this.createText(drawingDoc, group, width, height, String(displayText));
        }
        
        // 2. Shape Rendering (Simple Outline)
        this.createShape(drawingDoc, group, width, height);

        // Pin every child onto this drawing's floor layer so the V2 compositor
        // renders it inside that floor's slice and upper floors occlude it via
        // the LevelCompositePass blend.
        this._applyFloorLayer(group, floorIndex);
        group.userData = {
          type: 'sceneDrawing',
          docId: drawingDoc.id,
          floorIndex,
        };

        this.group.add(group);
        this.drawings.set(drawingDoc.id, group);
        this._drawingFloorIndex.set(drawingDoc.id, floorIndex);

        log.debug(`Created drawing ${drawingDoc.id} on floor ${floorIndex}`);
    } catch (e) {
        log.error(`Failed to create drawing ${drawingDoc?.id || 'unknown'}:`, e);
    }
  }

  /**
   * Render text using CanvasTexture
   * @param {DrawingDocument} doc 
   * @param {THREE.Group} group 
   * @param {number} width - Drawing box width
   * @param {number} height - Drawing box height
   */
  createText(doc, group, width, height, overrideText) {
    const text = overrideText ?? (doc.text ?? '');
    if (!text) return;

    const THREE = window.THREE;

    const resolution = 2;
    const fontSize = doc.fontSize || 48;
    const fontFamily = doc.fontFamily || globalThis.CONFIG?.defaultFontFamily || 'Signika';
    const normalizeCssColor = (c, fallback = '#FFFFFF') => {
      if (typeof c === 'number' && Number.isFinite(c)) {
        return `#${Math.trunc(c).toString(16).padStart(6, '0')}`;
      }
      if (typeof c !== 'string') return fallback;
      const s = c.trim();
      if (!s) return fallback;
      if (/^0x[0-9a-fA-F]{6}$/.test(s)) return `#${s.slice(2)}`;
      if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
      return s;
    };

    const fillColor = normalizeCssColor(doc.textColor, '#FFFFFF');
    const textAlpha = doc.textAlpha != null ? doc.textAlpha : 1.0;

    const stroke = Math.max(Math.round(fontSize / 32), 2);
    const dropShadowBlur = Math.max(Math.round(fontSize / 16), 2);
    const padding = stroke * 4;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const fontPx = fontSize * resolution;
    const strokePx = stroke * resolution;
    const paddingPx = padding * resolution;
    const wrapWidthPx = Math.max(1, Math.floor(width * resolution));

    const parseHexColor = (c) => {
      if (typeof c === 'number') {
        const r = (c >> 16) & 0xff;
        const g = (c >> 8) & 0xff;
        const b = c & 0xff;
        return { r, g, b };
      }
      if (typeof c !== 'string') return null;
      const s = c.trim();
      if (s.startsWith('#')) {
        let hex = s.slice(1);
        if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
        if (hex.length !== 6) return null;
        const v = parseInt(hex, 16);
        if (Number.isNaN(v)) return null;
        return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
      }
      return null;
    };

    const rgb = parseHexColor(fillColor);
    const luminance = rgb ? (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255 : 1;
    const strokeColor = luminance > 0.6 ? '#000000' : '#FFFFFF';

    // First pass: measure and wrap using the final font settings.
    ctx.font = `${fontPx}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const wrapParagraph = (paragraph) => {
      const words = paragraph.split(/\s+/).filter((w) => w.length);
      if (!words.length) return [''];
      const lines = [];
      let line = words[0];
      for (let i = 1; i < words.length; i++) {
        const next = `${line} ${words[i]}`;
        if (ctx.measureText(next).width <= wrapWidthPx) {
          line = next;
        } else {
          lines.push(line);
          line = words[i];
        }
      }
      lines.push(line);

      const finalLines = [];
      for (const l of lines) {
        if (ctx.measureText(l).width <= wrapWidthPx) {
          finalLines.push(l);
          continue;
        }
        let sub = '';
        for (const ch of l) {
          const test = sub + ch;
          if (ctx.measureText(test).width <= wrapWidthPx || sub.length === 0) {
            sub = test;
          } else {
            finalLines.push(sub);
            sub = ch;
          }
        }
        if (sub) finalLines.push(sub);
      }
      return finalLines;
    };

    const paragraphs = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const lines = [];
    for (const p of paragraphs) {
      const wrapped = wrapParagraph(p);
      for (const l of wrapped) lines.push(l);
    }

    const lineHeightPx = Math.round(fontPx * 1.2);

    let maxLineWidthPx = 1;
    for (const l of lines) {
      maxLineWidthPx = Math.max(maxLineWidthPx, Math.ceil(ctx.measureText(l).width));
    }
    const contentWidthPx = Math.max(1, maxLineWidthPx);
    const contentHeightPx = Math.max(1, lines.length * lineHeightPx);

    const canvasWidth = Math.max(1, Math.ceil(contentWidthPx + (paddingPx * 2)));
    const canvasHeight = Math.max(1, Math.ceil(contentHeightPx + (paddingPx * 2)));
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Second pass: redraw using the final canvas size.
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.font = `${fontPx}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const startY = (canvasHeight / 2) - (contentHeightPx / 2) + (lineHeightPx / 2);
    const cx = canvasWidth / 2;

    ctx.shadowColor = '#000000';
    ctx.shadowBlur = dropShadowBlur * resolution;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.lineWidth = strokePx;
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;

    for (let i = 0; i < lines.length; i++) {
      const y = startY + (i * lineHeightPx);
      ctx.strokeText(lines[i], cx, y);
      ctx.fillText(lines[i], cx, y);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: textAlpha,
      depthTest: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(canvasWidth / resolution, canvasHeight / resolution, 1);
    sprite.position.set(0, 0, 0);

    group.add(sprite);
  }

  /**
   * Render shape outline
   * @param {DrawingDocument} doc 
   * @param {THREE.Group} group 
   * @param {number} width - Drawing box width
   * @param {number} height - Drawing box height
   */
  createShape(doc, group, width, height) {
    const THREE = window.THREE;

    // Resolve stroke colour from the document. Foundry stores strokeColor as a
    // numeric hex, but it may also be a string like "#ff0000" or a Number-
    // wrapper object depending on how it's accessed. Fall back to fillColor if
    // stroke is not set and always coerce to a primitive number for THREE.Color.
    let strokeColor = doc.strokeColor;
    if (typeof strokeColor === 'string') {
      try {
        const hex = strokeColor.replace('#', '');
        const parsed = parseInt(hex, 16);
        if (!Number.isNaN(parsed)) strokeColor = parsed;
      } catch (_) {
        // ignore and fall back below
      }
    }
    if (strokeColor == null) strokeColor = doc.fillColor || 0xFFFFFF;

    // Coerce Number objects or Color-like wrappers to a primitive.
    if (strokeColor && typeof strokeColor === 'object' && typeof strokeColor.valueOf === 'function') {
      strokeColor = strokeColor.valueOf();
    }
    strokeColor = Number(strokeColor);
    if (!Number.isFinite(strokeColor)) strokeColor = 0xFFFFFF;

    const color = strokeColor;
    const thickness = doc.strokeWidth || 2;
    const strokeAlpha = doc.strokeAlpha != null ? doc.strokeAlpha : 1.0;
    const fillType = doc.fillType;
    let fillColor = doc.fillColor || 0x000000;
    if (fillColor && typeof fillColor === 'object' && typeof fillColor.valueOf === 'function') {
      fillColor = fillColor.valueOf();
    }
    fillColor = Number(fillColor);
    if (!Number.isFinite(fillColor)) fillColor = 0x000000;
    const fillAlpha = doc.fillAlpha != null ? doc.fillAlpha : 0;
    const shape = doc.shape || {};
    const type = shape.type;

    // Polygon / Freehand style drawings: render a smoothed ribbon using quads
    // along the path. Foundry stores both polygon and freehand points in
    // shape.points; the exact type string can vary (e.g. 'p' vs 'f'), so we key
    // off the presence of points and approximate Foundry's drawSmoothedPath
    // behaviour using a CatmullRomCurve3.
    if (Array.isArray(shape.points) && shape.points.length >= 4) {
      const pts = shape.points;
      const vertexCount = Math.floor(pts.length / 2);

      /** @type {THREE.Vector3[]} */
      const rawPoints = [];
      for (let i = 0; i < vertexCount; i++) {
        const px = pts[i * 2 + 0] ?? 0;
        const py = pts[i * 2 + 1] ?? 0;

        // Points are in local drawing-box coordinates, top-left origin, Y-down.
        // Convert to local group space (centered, Y-up).
        const localX = px - width / 2;
        const localY = (height - py) - height / 2;
        rawPoints.push(new THREE.Vector3(localX, localY, 0));
      }

      // Basic smoothing: use a Catmull-Rom spline with a density informed by
      // the document's bezierFactor (if present). Foundry multiplies this by 2,
      // but we also enforce a higher base density so curves look smooth even
      // when bezierFactor is small.
      const bezierFactor = typeof doc.bezierFactor === 'number' ? doc.bezierFactor : 1;
      const baseSegments = vertexCount * 4;
      const smoothSegments = Math.max(1, Math.floor(Math.max(baseSegments, vertexCount * (bezierFactor * 4))));
      let samplePoints = rawPoints;

      if (rawPoints.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(rawPoints, false, 'catmullrom', 0.5);
        samplePoints = curve.getPoints(smoothSegments);
      }

      const pathGroup = new THREE.Group();

      // Determine if the path should be treated as closed. Foundry considers
      // polygons closed when they have a fill or when the first and last
      // points are equal.
      let isClosed = false;
      if (fillType) {
        isClosed = true;
      } else if (vertexCount >= 2) {
        const fx = pts[0];
        const fy = pts[1];
        const lx = pts[(vertexCount - 1) * 2];
        const ly = pts[(vertexCount - 1) * 2 + 1];
        isClosed = (fx === lx) && (fy === ly);
      }

      const segCount = isClosed ? samplePoints.length : samplePoints.length - 1;

      for (let i = 0; i < segCount; i++) {
        const p0 = samplePoints[i];
        const p1 = samplePoints[(i + 1) % samplePoints.length];

        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        let length = Math.sqrt(dx * dx + dy * dy);
        if (length <= 0.0001) continue;

        // Slightly over-extend each segment so neighbouring quads overlap,
        // avoiding tiny gaps at joins.
        length += thickness;

        const angle = Math.atan2(dy, dx);
        const segGeom = new THREE.PlaneGeometry(length, thickness);
        const segMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(color),
          transparent: strokeAlpha < 1.0,
          opacity: strokeAlpha,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide
        });

        const segMesh = new THREE.Mesh(segGeom, segMat);
        segMesh.position.set(
          (p0.x + p1.x) / 2,
          (p0.y + p1.y) / 2,
          0
        );
        segMesh.rotation.z = angle;
        pathGroup.add(segMesh);
      }

      group.add(pathGroup);
      return;
    }

    // Inset the rectangle by half the stroke width on each side, similar to
    // Foundry's use of lineWidth / 2 in _refreshShape.
    const innerWidth = Math.max(width - thickness, 0);
    const innerHeight = Math.max(height - thickness, 0);

    // Optional fill (solid color only, patterns are ignored for now)
    if (fillType && fillAlpha > 0) {
      const fillGeometry = new THREE.PlaneGeometry(innerWidth, innerHeight);
      const fillMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(fillColor),
        transparent: true,
        opacity: fillAlpha,
        depthTest: false,
        depthWrite: false
      });
      const fillMesh = new THREE.Mesh(fillGeometry, fillMaterial);
      fillMesh.position.set(0, 0, 0);
      group.add(fillMesh);
    }

    if (thickness > 0 && strokeAlpha > 0) {
      const borderMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: strokeAlpha,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false
      });
      const halfW = width / 2;
      const halfH = height / 2;
      const halfT = thickness / 2;
      const makeBand = (bandWidth, bandHeight, x, y) => {
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(bandWidth, bandHeight), borderMaterial);
        mesh.position.set(x, y, 0.02);
        mesh.frustumCulled = false;
        group.add(mesh);
      };
      makeBand(width, thickness, 0, halfH - halfT);
      makeBand(width, thickness, 0, -halfH + halfT);
      makeBand(thickness, Math.max(0, height - (thickness * 2)), -halfW + halfT, 0);
      makeBand(thickness, Math.max(0, height - (thickness * 2)), halfW - halfT, 0);
    }
  }

  /**
   * Update a drawing
   * @param {DrawingDocument} doc
   * @param {Object} changes
   * @private
   */
  update_(doc, changes) {
    this.remove(doc.id);
    this.create(doc);
  }

  /**
   * Remove a drawing
   * @param {string} id 
   * @private
   */
  remove(id) {
    const object = this.drawings.get(id);
    if (object) {
      this.group.remove(object);
      // Dispose geometries/materials if needed
      this.drawings.delete(id);
      this._drawingFloorIndex.delete(id);
    }
  }
  
  /**
   * Dispose resources
   * @public
   */
  dispose() {
      // Unregister Foundry hooks using correct two-argument signature
      try {
        if (this._hookIds && this._hookIds.length) {
          for (const [hookName, hookId] of this._hookIds) {
            try {
              Hooks.off(hookName, hookId);
            } catch (e) {
            }
          }
        }
      } catch (e) {
      }
      this._hookIds = [];
      this.hooksRegistered = false;
      
      this.group.clear();
      this.scene.remove(this.group);
      this.drawings.clear();
      this._drawingFloorIndex.clear();
  }
}
