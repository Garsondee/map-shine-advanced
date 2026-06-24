/**
 * @fileoverview Map Point Drawing and Editing handler.
 *
 * Extracted from interaction-manager.js to isolate the ~920 lines of
 * map-point-specific logic: drawing new point groups, editing existing ones,
 * handle dragging, context menus, and preview visualization.
 *
 * The handler receives a reference to the parent InteractionManager for
 * shared utilities (sceneComposer, raycaster, screenToWorld, snapToGrid).
 *
 * @module scene/map-point-interaction
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';
import {
  MAP_POINT_HIT_RADIUS,
  applyMapPointHandleSelectionStyle,
  createMapPointCursorPreviewMesh,
  createMapPointMarkerGroup,
} from './map-point-marker-visual.js';

const log = createLogger('MapPointDraw');

// ── Effect Color Map ────────────────────────────────────────────────────────

const EFFECT_COLORS = {
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

/**
 * Handles all map-point drawing, editing, and visualization logic.
 * Delegates to the parent InteractionManager for shared utilities.
 */
export class MapPointDrawHandler {
  /**
   * @param {import('./interaction-manager.js').InteractionManager} im - Parent interaction manager
   */
  constructor(im) {
    /** @private */
    this._im = im;

    // Drawing state
    this.state = {
      active: false,
      effectTarget: null,
      groupType: 'area',
      ropeType: null,
      points: [],
      snapToGrid: false,
      editingGroupId: null,
      previewGroup: null,
      previewLine: null,
      previewPoints: null,
      previewFill: null,
      cursorPoint: null,
      pointMarkers: []
    };

    /** @type {{ active: boolean, groupId: string|null, selectedIndices: Set<number>, onPointsChanged: (() => void)|null, changeListener: Function|null }} */
    this.groupEditSession = {
      active: false,
      groupId: null,
      selectedIndices: new Set(),
      onPointsChanged: null,
      changeListener: null,
    };

    /** @type {{ active: boolean, onGroupsChanged: (() => void)|null, changeListener: Function|null, selectedPoints: Map<string, Set<number>> }} */
    this.managerSession = {
      active: false,
      onGroupsChanged: null,
      changeListener: null,
      selectedPoints: new Map(),
    };

    /** @type {{ active: boolean, dragging: boolean, start: THREE.Vector3, current: THREE.Vector3, screenStart: THREE.Vector2, screenCurrent: THREE.Vector2, threshold: number, overlayEl: HTMLElement|null }} */
    this.editSessionMarquee = {
      active: false,
      dragging: false,
      start: null,
      current: null,
      screenStart: null,
      screenCurrent: null,
      threshold: 6,
      overlayEl: null,
    };
  }

  // ── Accessors (delegate to parent IM) ───────────────────────────────────

  get sceneComposer() { return this._im.sceneComposer; }
  get raycaster() { return this._im.raycaster; }

  /** @returns {boolean} */
  get active() { return this.state.active; }

  /**
   * Resolve map-point metadata for the currently active level context.
   * Falls back to an all-levels contract if level context is unavailable.
   * @param {{ renderLayer?: 'below-overhead'|'above-overhead'|null, preserveGroup?: import('./map-points-manager.js').MapPointGroup|null }} [opts]
   * @returns {Object}
   * @private
   */
  _getActiveLevelMetadata(opts = {}) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    const preserveGroup = opts?.preserveGroup ?? null;
    const renderLayer = opts?.renderLayer
      ?? preserveGroup?.metadata?.renderLayer
      ?? null;

    if (typeof mapPointsManager?.buildMetadataFromLevelSelection === 'function') {
      const binding = preserveGroup?.metadata?.levelBinding;
      const mode = binding?.mode === 'locked' ? 'locked' : 'all-levels';
      const levelId = (typeof binding?.floorKey === 'string' && binding.floorKey.length > 0)
        ? binding.floorKey
        : null;
      return mapPointsManager.buildMetadataFromLevelSelection(
        { mode, levelId, renderLayer },
        preserveGroup?.metadata ?? null,
      );
    }

    if (typeof mapPointsManager?.buildMetadataFromLevelContext === 'function') {
      const base = mapPointsManager.buildMetadataFromLevelContext(window.MapShine?.activeLevelContext ?? null);
      if (renderLayer) {
        return { ...base, renderLayer };
      }
      return base;
    }

    return {
      levelBinding: {
        mode: 'all-levels',
        bottom: null,
        top: null,
        floorKey: null,
      },
      renderLayer: renderLayer ?? 'below-overhead',
    };
  }

  // ── Preview Mesh Creation ─────────────────────────────────────────────────

  /**
   * Create the Three.js preview meshes used while drawing map points.
   * Called once during InteractionManager construction.
   */
  createPreview() {
    const THREE = window.THREE;

    this.state.previewGroup = new THREE.Group();
    this.state.previewGroup.name = 'MapPointDrawPreview';
    this.state.previewGroup.visible = false;
    this.state.previewGroup.renderOrder = 9998;
    this.state.previewGroup.layers.set(OVERLAY_THREE_LAYER);
    this.state.previewGroup.userData = {
      ...(this.state.previewGroup.userData || {}),
      type: 'interactionOverlay',
      preserveOnBusClear: true,
      interactionOverlayKind: 'mapPointDrawPreview',
    };

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
    this.state.previewLine = new THREE.Line(lineGeo, lineMat);
    this.state.previewLine.layers.set(OVERLAY_THREE_LAYER);
    this.state.previewGroup.add(this.state.previewLine);

    // Legacy points object (kept for compatibility but we use markers now)
    const pointsGeo = new THREE.BufferGeometry();
    pointsGeo.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    const pointsMat = new THREE.PointsMaterial({
      color: 0x00ff00,
      size: 6,
      sizeAttenuation: false,
      depthTest: false
    });
    this.state.previewPoints = new THREE.Points(pointsGeo, pointsMat);
    this.state.previewPoints.layers.set(OVERLAY_THREE_LAYER);
    this.state.previewGroup.add(this.state.previewPoints);

    // Semi-transparent fill for area
    const fillGeo = new THREE.BufferGeometry();
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      transparent: true,
      opacity: 0.15,
      depthTest: false,
      side: THREE.DoubleSide
    });
    this.state.previewFill = new THREE.Mesh(fillGeo, fillMat);
    this.state.previewFill.layers.set(OVERLAY_THREE_LAYER);
    this.state.previewGroup.add(this.state.previewFill);

    // Cursor point preview
    this.state.cursorPoint = createMapPointCursorPreviewMesh(0xffffff);
    if (this.state.cursorPoint) {
      this.state.cursorPoint.visible = false;
      this.state.previewGroup.add(this.state.cursorPoint);
    }

    // Initialize point markers array
    this.state.pointMarkers = [];

    const hostScene = this._getPreviewHostScene();
    if (hostScene) {
      hostScene.add(this.state.previewGroup);
    }
  }

  /**
   * Resolve the scene used to render map-point drawing previews.
   * In V2 we must attach to FloorRenderBus scene; SceneComposer.scene is not
   * part of the visible render path.
   * @returns {THREE.Scene|null}
   * @private
   */
  _getPreviewHostScene() {
    return window.MapShine?.effectComposer?._floorCompositorV2?._renderBus?._scene
      ?? this.sceneComposer?.scene
      ?? null;
  }

  // ── Drawing Lifecycle ─────────────────────────────────────────────────────

  /**
   * Start map point drawing mode.
   * @param {string} effectTarget - Effect key (e.g., 'smellyFlies', 'fire')
   * @param {'point'|'area'|'line'|'rope'} [groupType='area']
   * @param {boolean} [snapToGrid=false]
   * @param {{ropeType?: 'rope'|'chain'}|null} [options=null]
   */
  start(effectTarget, groupType = 'area', snapToGrid = false, options = null) {
    if (this.state.active) {
      this.cancel();
    }

    this.state.active = true;
    this.state.effectTarget = effectTarget;
    this.state.groupType = groupType;
    this.state.ropeType = (options?.ropeType === 'rope' || options?.ropeType === 'chain') ? options.ropeType : null;
    this.state.renderLayer = options?.renderLayer ?? null;
    this.state.points = [];
    this.state.editingGroupId = null;
    this.state.snapToGrid = snapToGrid;
    this.state.previewGroup.visible = true;

    window.MapShine?.mapPointsManager?.enterEditorMode?.();

    this._clearPointMarkers();

    // Update preview color based on effect
    const color = this.getEffectColor(effectTarget);
    if (this.state.previewLine.material) this.state.previewLine.material.color.setHex(color);
    if (this.state.previewPoints.material) this.state.previewPoints.material.color.setHex(color);
    if (this.state.previewFill.material) this.state.previewFill.material.color.setHex(color);

    this._saveLastEffectTarget(effectTarget);

    log.info(`Started map point drawing: ${effectTarget} (${groupType}), snap=${snapToGrid}`);
    const snapMsg = snapToGrid ? 'Hold Shift to disable grid snap.' : 'Hold Shift to enable grid snap.';
    ui.notifications.info(`Click to place points. ${snapMsg} Double-click or Enter to finish. Escape to cancel.`);
  }

  /**
   * Cancel map point drawing mode without saving.
   */
  cancel() {
    // If editing an existing group, restore its visual helper
    if (this.state.editingGroupId) {
      const mapPointsManager = window.MapShine?.mapPointsManager;
      if (mapPointsManager?.showVisualHelpers) {
        const group = mapPointsManager.getGroup(this.state.editingGroupId);
        if (group) {
          mapPointsManager.createVisualHelper(this.state.editingGroupId, group);
        }
      }
    }

    this.state.active = false;
    this.state.points = [];
    this.state.editingGroupId = null;
    this.state.previewGroup.visible = false;
    this._clearPointMarkers();
    this._updatePreview();
    if (this.state.cursorPoint) {
      this.state.cursorPoint.visible = false;
    }

    if (!this.isMapPointsEditorActive()) {
      window.MapShine?.mapPointsManager?.exitEditorMode?.();
    }

    log.info('Map point drawing cancelled');
  }

  /**
   * Finish map point drawing and create/update the group.
   */
  async finish() {
    if (!this.state.active || this.state.points.length < 1) {
      this.cancel();
      return;
    }

    const { effectTarget, groupType, ropeType, points, editingGroupId } = this.state;
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

    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager) {
      log.error('MapPointsManager not available');
      this.cancel();
      return;
    }

    try {
      if (editingGroupId) {
        const existingGroup = mapPointsManager.getGroup(editingGroupId);
        const isExistingRopeGroup = existingGroup?.effectTarget === 'rope' || existingGroup?.type === 'rope';
        const updates = {
          points: points.map(p => ({ x: p.x, y: p.y })),
          metadata: this._getActiveLevelMetadata({ preserveGroup: existingGroup }),
        };

        // Preserve rope-specific properties when editing a rope group
        if (isExistingRopeGroup) {
          const ropeProps = [
            'ropeType', 'texturePath', 'segmentLength', 'damping', 'windForce',
            'windGustAmount', 'invertWindDirection', 'gravityStrength', 'slackFactor',
            'constraintIterations', 'bendStiffness', 'tapering', 'width',
            'uvRepeatWorld', 'zOffset', 'windowLightBoost', 'endFadeSize', 'endFadeStrength'
          ];
          for (const prop of ropeProps) {
            if (Object.prototype.hasOwnProperty.call(existingGroup, prop)) {
              updates[prop] = existingGroup[prop];
            }
          }
        }

        await mapPointsManager.updateGroup(editingGroupId, updates);
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
          ropeType: isRopeEffect ? ropePreset : undefined,
          metadata: this._getActiveLevelMetadata({ renderLayer: this.state.renderLayer }),
        });

        log.info(`Created map point group: ${group.id}`);
        ui.notifications.info(isRope ? 'Created rope' : `Created ${effectTarget} spawn ${groupType}`);

        if (mapPointsManager.showVisualHelpers) {
          const savedGroup = mapPointsManager.getGroup(group.id);
          if (savedGroup) {
            mapPointsManager.createVisualHelper(group.id, savedGroup);
          }
        }
      }
    } catch (e) {
      log.error('Failed to save map point group:', e);
      ui.notifications.error('Failed to save spawn area');
    }

    // Reset state
    this.state.active = false;
    this.state.points = [];
    this.state.editingGroupId = null;
    this.state.previewGroup.visible = false;
    this._clearPointMarkers();

    // Clear preview geometry to prevent stale visuals
    try {
      const THREE = window.THREE;
      if (THREE) {
        this.state.previewLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
        this.state.previewPoints.geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
      }
    } catch (_) {}
    try {
      const THREE = window.THREE;
      if (THREE && this.state.previewFill?.geometry) {
        this.state.previewFill.geometry.dispose();
        this.state.previewFill.geometry = new THREE.BufferGeometry();
      }
    } catch (_) {}

    this._updatePreview();
    if (this.state.cursorPoint) {
      this.state.cursorPoint.visible = false;
    }

    if (!this.isMapPointsEditorActive()) {
      window.MapShine?.mapPointsManager?.exitEditorMode?.();
    } else {
      mapPointsManager?.createVisualHelpers?.();
    }
  }

  // ── Point Placement ───────────────────────────────────────────────────────

  /**
   * Add a point to the current drawing.
   * @param {number} worldX
   * @param {number} worldY
   * @param {boolean} [shiftHeld=false]
   */
  addPoint(worldX, worldY, shiftHeld = false) {
    if (!this.state.active) return;

    let x = worldX;
    let y = worldY;
    // Snapping: if snapToGrid is ON, snap unless Shift; if OFF, only snap when Shift IS held
    const shouldSnap = this.state.snapToGrid ? !shiftHeld : shiftHeld;

    if (shouldSnap) {
      const snapped = this._im.snapToGrid(worldX, worldY,
        CONST.GRID_SNAPPING_MODES.CENTER | CONST.GRID_SNAPPING_MODES.VERTEX |
        CONST.GRID_SNAPPING_MODES.CORNER | CONST.GRID_SNAPPING_MODES.SIDE_MIDPOINT, 2);
      x = snapped.x;
      y = snapped.y;
    }

    this.state.points.push({ x, y });
    this._updatePreview();

    log.debug(`Added map point: (${x}, ${y}), total: ${this.state.points.length}, snapped=${shouldSnap}`);
  }

  /**
   * Remove the last placed point (Backspace key).
   */
  removeLastPoint() {
    if (this.state.points.length > 0) {
      this.state.points.pop();
      this._updatePreview();
    }
  }

  // ── Group Editing ─────────────────────────────────────────────────────────

  /**
   * Start adding points to an existing group.
   * @param {string} groupId
   */
  startAddPointsToGroup(groupId) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager) return;

    const group = mapPointsManager.getGroup(groupId);
    if (!group) {
      ui.notifications.warn('Group not found');
      return;
    }

    this.state.active = true;
    this.state.effectTarget = group.effectTarget;
    this.state.groupType = group.type;
    this.state.points = [...group.points];
    this.state.snapToGrid = false;
    this.state.editingGroupId = groupId;
    this.state.previewGroup.visible = true;

    window.MapShine?.mapPointsManager?.enterEditorMode?.();

    this._clearPointMarkers();

    const color = this.getEffectColor(group.effectTarget);
    if (this.state.previewLine.material) this.state.previewLine.material.color.setHex(color);
    if (this.state.previewPoints.material) this.state.previewPoints.material.color.setHex(color);
    if (this.state.previewFill.material) this.state.previewFill.material.color.setHex(color);

    this._updatePreview();

    // Hide the visual helper for this group while editing
    mapPointsManager.removeVisualObject(groupId);

    log.info(`Started adding points to group: ${groupId} (${group.label})`);
    ui.notifications.info(`Adding points to "${group.label}". Click to add. Enter to save. Escape to cancel.`);
  }

  // ── Group Edit Session (edit dialog open) ─────────────────────────────────

  /** @returns {boolean} */
  isGroupEditSessionActive() {
    return !!this.groupEditSession.active;
  }

  /** @returns {boolean} */
  isManagerSessionActive() {
    return !!this.managerSession.active;
  }

  /** @returns {boolean} */
  isMapPointsEditorActive() {
    return this.isManagerSessionActive() || this.isGroupEditSessionActive();
  }

  /** @returns {string|null} */
  getGroupEditSessionGroupId() {
    return this.groupEditSession.active ? this.groupEditSession.groupId : null;
  }

  /**
   * Begin the Manage Map Points session (all groups visible + editable on canvas).
   * @param {{ onGroupsChanged?: () => void }} [opts]
   */
  startManagerSession(opts = {}) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager) return;

    this.endGroupEditSession();
    this.endManagerSession();

    this.managerSession = {
      active: true,
      onGroupsChanged: typeof opts.onGroupsChanged === 'function' ? opts.onGroupsChanged : null,
      changeListener: null,
      selectedPoints: new Map(),
    };

    mapPointsManager.enterEditorMode();
    mapPointsManager.setEditFocusGroupId(null);

    const onChange = () => {
      this.managerSession.onGroupsChanged?.();
    };
    this.managerSession.changeListener = onChange;
    mapPointsManager.addChangeListener(onChange);

    this._ensureEditSessionMarqueeOverlay();
    log.info('Map point manager session started');
  }

  /** Tear down the Manage Map Points session. */
  endManagerSession() {
    const session = this.managerSession;
    if (!session.active && !session.changeListener) return;

    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (session.changeListener && mapPointsManager) {
      mapPointsManager.removeChangeListener(session.changeListener);
    }

    if (mapPointsManager && !this.isGroupEditSessionActive()) {
      mapPointsManager.exitEditorMode();
    } else if (mapPointsManager) {
      mapPointsManager.setEditFocusGroupId(null);
      mapPointsManager.createVisualHelpers();
    }

    this.managerSession = {
      active: false,
      onGroupsChanged: null,
      changeListener: null,
      selectedPoints: new Map(),
    };
  }

  /**
   * Begin an on-canvas edit session while the group edit dialog is open.
   * @param {string} groupId
   * @param {{ onPointsChanged?: () => void }} [opts]
   */
  startGroupEditSession(groupId, opts = {}) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager?.getGroup?.(groupId)) return;

    this.endGroupEditSession();

    this.groupEditSession = {
      active: true,
      groupId,
      selectedIndices: new Set(),
      onPointsChanged: typeof opts.onPointsChanged === 'function' ? opts.onPointsChanged : null,
      changeListener: null,
    };

    mapPointsManager.enterEditorMode();
    mapPointsManager.setEditFocusGroupId(groupId);

    const onChange = () => {
      this.refreshHandleSelectionVisuals();
      this.groupEditSession.onPointsChanged?.();
    };
    this.groupEditSession.changeListener = onChange;
    mapPointsManager.addChangeListener(onChange);

    this._ensureEditSessionMarqueeOverlay();
    log.info(`Map point group edit session started: ${groupId}`);
  }

  /** Tear down the on-canvas edit session. */
  endGroupEditSession() {
    const session = this.groupEditSession;
    if (!session.active && !session.changeListener) {
      this._finishEditSessionMarquee(false);
      return;
    }

    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (session.changeListener && mapPointsManager) {
      mapPointsManager.removeChangeListener(session.changeListener);
    }

    mapPointsManager?.setEditFocusGroupId?.(null);

    if (mapPointsManager) {
      if (this.isManagerSessionActive()) {
        mapPointsManager.createVisualHelpers();
      } else {
        mapPointsManager.exitEditorMode();
      }
    }

    this.groupEditSession = {
      active: false,
      groupId: null,
      selectedIndices: new Set(),
      onPointsChanged: null,
      changeListener: null,
    };

    this._finishEditSessionMarquee(false);
  }

  /**
   * @param {number} pointIndex
   * @param {{ additive?: boolean, subtractive?: boolean, replace?: boolean }} [opts]
   */
  selectPointIndex(pointIndex, opts = {}) {
    if (!this.groupEditSession.active || !Number.isFinite(pointIndex)) return;
    const selected = this.groupEditSession.selectedIndices;
    if (opts.subtractive) {
      selected.delete(pointIndex);
    } else if (opts.additive) {
      if (selected.has(pointIndex)) selected.delete(pointIndex);
      else selected.add(pointIndex);
    } else if (opts.replace !== false) {
      selected.clear();
      selected.add(pointIndex);
    }
    this.refreshHandleSelectionVisuals();
  }

  refreshHandleSelectionVisuals() {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager) return;

    const editSession = this.groupEditSession;
    const managerSession = this.managerSession;

    for (const [groupId, helper] of mapPointsManager.visualObjects) {
      if (!helper) continue;
      for (const child of helper.children) {
        if (child?.userData?.type !== 'mapPointHandle') continue;
        const idx = child.userData.pointIndex;
        let selected = false;
        if (editSession.active && editSession.groupId === groupId) {
          selected = editSession.selectedIndices.has(idx);
        } else if (managerSession.active) {
          selected = managerSession.selectedPoints.get(groupId)?.has(idx) ?? false;
        }
        applyMapPointHandleSelectionStyle(child, selected);
      }
    }
  }

  /**
   * @param {string} groupId
   * @param {number} pointIndex
   * @param {{ additive?: boolean, subtractive?: boolean, replace?: boolean }} [opts]
   */
  selectManagerPoint(groupId, pointIndex, opts = {}) {
    if (!this.managerSession.active || !Number.isFinite(pointIndex)) return;
    let selected = this.managerSession.selectedPoints.get(groupId);
    if (!selected) {
      selected = new Set();
      this.managerSession.selectedPoints.set(groupId, selected);
    }

    if (opts.subtractive) {
      selected.delete(pointIndex);
      if (selected.size === 0) this.managerSession.selectedPoints.delete(groupId);
    } else if (opts.additive) {
      if (selected.has(pointIndex)) selected.delete(pointIndex);
      else selected.add(pointIndex);
      if (selected.size === 0) this.managerSession.selectedPoints.delete(groupId);
    } else if (opts.replace !== false) {
      this.managerSession.selectedPoints.clear();
      selected = new Set([pointIndex]);
      this.managerSession.selectedPoints.set(groupId, selected);
    }
    this.refreshHandleSelectionVisuals();
  }

  clearPointSelection() {
    if (this.groupEditSession.active) {
      this.groupEditSession.selectedIndices.clear();
    }
    if (this.managerSession.active) {
      this.managerSession.selectedPoints.clear();
    }
    this.refreshHandleSelectionVisuals();
  }

  /** @returns {Array<{groupId: string, pointIndex: number}>} */
  getSelectedPoints() {
    if (this.groupEditSession.active && this.groupEditSession.groupId) {
      return [...this.groupEditSession.selectedIndices]
        .sort((a, b) => a - b)
        .map((pointIndex) => ({ groupId: this.groupEditSession.groupId, pointIndex }));
    }

    /** @type {Array<{groupId: string, pointIndex: number}>} */
    const out = [];
    for (const [groupId, indices] of this.managerSession.selectedPoints) {
      for (const pointIndex of [...indices].sort((a, b) => a - b)) {
        out.push({ groupId, pointIndex });
      }
    }
    return out;
  }

  /** @returns {number[]} */
  getSelectedPointIndices() {
    if (!this.groupEditSession.active) return [];
    return [...(this.groupEditSession.selectedIndices || [])].sort((a, b) => a - b);
  }

  /**
   * Pointer down on a handle in the manager session.
   * @param {{ groupId: string, pointIndex: number, object: THREE.Object3D, hitPoint: THREE.Vector3 }} handleHit
   * @param {PointerEvent} event
   */
  handleManagerPointerDown(handleHit, event) {
    if (!this.managerSession.active) return;

    const idx = handleHit.pointIndex;
    const additive = !!(event.shiftKey);
    const subtractive = !!(event.ctrlKey || event.metaKey);

    if (subtractive) {
      this.selectManagerPoint(handleHit.groupId, idx, { subtractive: true });
      return;
    }

    const alreadySelected = this.managerSession.selectedPoints.get(handleHit.groupId)?.has(idx) ?? false;
    if (additive) {
      this.selectManagerPoint(handleHit.groupId, idx, { additive: true });
    } else if (!alreadySelected) {
      this.selectManagerPoint(handleHit.groupId, idx, { replace: true });
    }

    this.startHandleDrag(handleHit.object, handleHit.hitPoint, handleHit.groupId, idx, event);
  }

  /**
   * Pointer down on a handle while the per-group edit dialog is open.
   * @param {{ groupId: string, pointIndex: number, object: THREE.Object3D, hitPoint: THREE.Vector3 }} handleHit
   * @param {PointerEvent} event
   */
  handleEditSessionPointerDown(handleHit, event) {
    if (!this.groupEditSession.active || handleHit.groupId !== this.groupEditSession.groupId) return;

    const idx = handleHit.pointIndex;
    const additive = !!(event.shiftKey);
    const subtractive = !!(event.ctrlKey || event.metaKey);

    if (subtractive) {
      this.selectPointIndex(idx, { subtractive: true });
      return;
    }

    const alreadySelected = this.groupEditSession.selectedIndices.has(idx);
    if (additive) {
      this.selectPointIndex(idx, { additive: true });
    } else if (!alreadySelected) {
      this.selectPointIndex(idx, { replace: true });
    }

    this.startHandleDrag(handleHit.object, handleHit.hitPoint, handleHit.groupId, idx, event);
  }

  /**
   * Begin marquee selection on empty canvas click.
   * @param {number} clientX
   * @param {number} clientY
   * @param {PointerEvent} event
   */
  startEditSessionMarquee(clientX, clientY, event) {
    if (!this.groupEditSession.active && !this.managerSession.active) return;

    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      this.clearPointSelection();
    }

    const THREE = window.THREE;
    if (!THREE) return;

    this._ensureEditSessionMarqueeOverlay();

    const groundZ = this.sceneComposer?.groundZ ?? 0;
    const worldPos = this._im.viewportToWorld(clientX, clientY, groundZ);
    if (!worldPos) return;

    const marquee = this.editSessionMarquee;
    if (!marquee.start) marquee.start = new THREE.Vector3();
    if (!marquee.current) marquee.current = new THREE.Vector3();
    if (!marquee.screenStart) marquee.screenStart = new THREE.Vector2();
    if (!marquee.screenCurrent) marquee.screenCurrent = new THREE.Vector2();

    marquee.active = true;
    marquee.dragging = false;
    marquee.start.copy(worldPos);
    marquee.current.copy(worldPos);
    marquee.screenStart.set(clientX, clientY);
    marquee.screenCurrent.copy(marquee.screenStart);

    if (marquee.overlayEl) {
      marquee.overlayEl.style.left = `${clientX}px`;
      marquee.overlayEl.style.top = `${clientY}px`;
      marquee.overlayEl.style.width = '0px';
      marquee.overlayEl.style.height = '0px';
      marquee.overlayEl.style.display = 'none';
    }

    if (window.MapShine?.cameraController) {
      window.MapShine.cameraController.enabled = false;
    }
  }

  /**
   * @param {number} clientX
   * @param {number} clientY
   */
  updateEditSessionMarquee(clientX, clientY) {
    const marquee = this.editSessionMarquee;
    if (!marquee.active) return;

    if (!marquee.dragging) {
      const dist = Math.hypot(
        clientX - marquee.screenStart.x,
        clientY - marquee.screenStart.y,
      );
      if (dist < marquee.threshold) return;
      marquee.dragging = true;
    }

    const groundZ = this.sceneComposer?.groundZ ?? 0;
    const worldPos = this._im.viewportToWorld(clientX, clientY, groundZ);
    if (worldPos) marquee.current.copy(worldPos);

    marquee.screenCurrent.set(clientX, clientY);

    const overlay = marquee.overlayEl;
    if (overlay) {
      const x1 = marquee.screenStart.x;
      const y1 = marquee.screenStart.y;
      const x2 = marquee.screenCurrent.x;
      const y2 = marquee.screenCurrent.y;
      overlay.style.left = `${Math.min(x1, x2)}px`;
      overlay.style.top = `${Math.min(y1, y2)}px`;
      overlay.style.width = `${Math.abs(x2 - x1)}px`;
      overlay.style.height = `${Math.abs(y2 - y1)}px`;
      overlay.style.display = 'block';
    }
  }

  /**
   * Finish marquee selection.
   * @param {PointerEvent} event
   */
  finishEditSessionMarquee(event) {
    const marquee = this.editSessionMarquee;
    if (!marquee.active) return;

    const wasDragging = marquee.dragging;
    marquee.active = false;
    marquee.dragging = false;

    if (marquee.overlayEl) marquee.overlayEl.style.display = 'none';

    if (window.MapShine?.cameraController) {
      window.MapShine.cameraController.enabled = true;
    }

    if (!wasDragging || (!this.groupEditSession.active && !this.managerSession.active)) return;

    const minX = Math.min(marquee.start.x, marquee.current.x);
    const maxX = Math.max(marquee.start.x, marquee.current.x);
    const minY = Math.min(marquee.start.y, marquee.current.y);
    const maxY = Math.max(marquee.start.y, marquee.current.y);

    this.selectPointsInMarquee(minX, maxX, minY, maxY, {
      additive: !!(event.shiftKey),
      subtractive: !!(event.ctrlKey || event.metaKey),
    });
  }

  /**
   * @param {number} minX
   * @param {number} maxX
   * @param {number} minY
   * @param {number} maxY
   * @param {{ additive?: boolean, subtractive?: boolean }} [opts]
   */
  selectPointsInMarquee(minX, maxX, minY, maxY, opts = {}) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager) return;

    if (this.groupEditSession.active && this.groupEditSession.groupId) {
      const session = this.groupEditSession;
      const group = mapPointsManager.getGroup(session.groupId);
      if (!group?.points?.length) return;

      const hitIndices = [];
      for (let i = 0; i < group.points.length; i++) {
        const p = group.points[i];
        if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
          hitIndices.push(i);
        }
      }

      if (opts.subtractive) {
        for (const idx of hitIndices) session.selectedIndices.delete(idx);
      } else if (opts.additive) {
        for (const idx of hitIndices) session.selectedIndices.add(idx);
      } else {
        session.selectedIndices.clear();
        for (const idx of hitIndices) session.selectedIndices.add(idx);
      }

      this.refreshHandleSelectionVisuals();
      return;
    }

    if (!this.managerSession.active) return;

    /** @type {Map<string, Set<number>>} */
    const hitsByGroup = new Map();
    for (const [groupId, group] of mapPointsManager.groups) {
      if (!group?.points?.length) continue;
      if (mapPointsManager.editFocusGroupId && groupId !== mapPointsManager.editFocusGroupId) continue;

      for (let i = 0; i < group.points.length; i++) {
        const p = group.points[i];
        if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
          if (!hitsByGroup.has(groupId)) hitsByGroup.set(groupId, new Set());
          hitsByGroup.get(groupId).add(i);
        }
      }
    }

    if (opts.subtractive) {
      for (const [groupId, indices] of hitsByGroup) {
        const selected = this.managerSession.selectedPoints.get(groupId);
        if (!selected) continue;
        for (const idx of indices) selected.delete(idx);
        if (selected.size === 0) this.managerSession.selectedPoints.delete(groupId);
      }
    } else if (opts.additive) {
      for (const [groupId, indices] of hitsByGroup) {
        let selected = this.managerSession.selectedPoints.get(groupId);
        if (!selected) {
          selected = new Set();
          this.managerSession.selectedPoints.set(groupId, selected);
        }
        for (const idx of indices) selected.add(idx);
      }
    } else {
      this.managerSession.selectedPoints.clear();
      for (const [groupId, indices] of hitsByGroup) {
        this.managerSession.selectedPoints.set(groupId, new Set(indices));
      }
    }

    this.refreshHandleSelectionVisuals();
  }

  /**
   * Delete all selected points in the active edit session.
   * @returns {Promise<boolean>}
   */
  async deleteSelectedPoints() {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager) return false;

    const selected = this.getSelectedPoints();
    if (!selected.length) return false;

    if (this.groupEditSession.active && this.groupEditSession.groupId) {
      const indices = selected
        .filter((s) => s.groupId === this.groupEditSession.groupId)
        .map((s) => s.pointIndex);
      const ok = await mapPointsManager.removePoints(this.groupEditSession.groupId, indices);
      if (ok) {
        this.groupEditSession.selectedIndices.clear();
        this.refreshHandleSelectionVisuals();
        this.groupEditSession.onPointsChanged?.();
        ui.notifications.info(indices.length === 1 ? 'Point removed' : `${indices.length} points removed`);
      }
      return ok;
    }

    if (!this.managerSession.active) return false;

    /** @type {Map<string, number[]>} */
    const byGroup = new Map();
    for (const { groupId, pointIndex } of selected) {
      if (!byGroup.has(groupId)) byGroup.set(groupId, []);
      byGroup.get(groupId).push(pointIndex);
    }

    let removed = 0;
    for (const [groupId, indices] of byGroup) {
      const ok = await mapPointsManager.removePoints(groupId, indices);
      if (ok) removed += indices.length;
    }

    if (removed > 0) {
      this.managerSession.selectedPoints.clear();
      this.refreshHandleSelectionVisuals();
      this.managerSession.onGroupsChanged?.();
      ui.notifications.info(removed === 1 ? 'Point removed' : `${removed} points removed`);
      return true;
    }
    return false;
  }

  /** @private */
  _finishEditSessionMarquee(applySelection) {
    const marquee = this.editSessionMarquee;
    if (!marquee.active) {
      if (marquee.overlayEl) marquee.overlayEl.style.display = 'none';
      return;
    }
    marquee.active = false;
    marquee.dragging = false;
    if (marquee.overlayEl) marquee.overlayEl.style.display = 'none';
    if (applySelection && window.MapShine?.cameraController) {
      window.MapShine.cameraController.enabled = true;
    }
  }

  /** @private */
  _ensureEditSessionMarqueeOverlay() {
    if (this.editSessionMarquee.overlayEl) return;

    const el = document.createElement('div');
    el.className = 'msa-mp-marquee-overlay';
    el.style.display = 'none';
    document.body.appendChild(el);
    this.editSessionMarquee.overlayEl = el;
  }

  // ── Handle Dragging ───────────────────────────────────────────────────────

  /**
   * Start dragging a map point handle.
   * @param {THREE.Object3D} handleObject
   * @param {THREE.Vector3} hitPoint
   * @param {string} groupId
   * @param {number} pointIndex
   * @param {PointerEvent} [event]
   */
  startHandleDrag(handleObject, hitPoint, groupId, pointIndex, event = null) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    const group = mapPointsManager?.getGroup?.(groupId);
    if (!group || !Array.isArray(group.points) || !Number.isFinite(pointIndex)) return;
    if (pointIndex < 0 || pointIndex >= group.points.length) return;

    // Walk up to the handle root
    let handleRoot = handleObject;
    while (
      handleRoot?.parent &&
      handleRoot.parent.userData?.type === 'mapPointHandle' &&
      handleRoot.parent.userData?.groupId === groupId &&
      handleRoot.parent.userData?.pointIndex === pointIndex
    ) {
      handleRoot = handleRoot.parent;
    }

    const ds = this._im.dragState;
    ds.active = true;
    ds.mode = 'mapPointHandle';
    ds.object = handleRoot;
    ds.hasMoved = false;
    ds.mapPointGroupId = groupId;
    ds.mapPointIndex = pointIndex;
    ds.mapPointPoints = group.points.map(p => ({ x: p.x, y: p.y }));
    ds.startPos.copy(handleRoot.position);
    ds.offset.subVectors(handleRoot.position, hitPoint);

    const session = this.groupEditSession;
    let dragIndices = [pointIndex];

    if (session.active && session.groupId === groupId) {
      const selected = this.getSelectedPointIndices();
      if (selected.length > 1 && selected.includes(pointIndex)) {
        dragIndices = selected;
      }
    } else if (this.managerSession.active) {
      const selected = this.managerSession.selectedPoints.get(groupId);
      if (selected && selected.size > 1 && selected.has(pointIndex)) {
        dragIndices = [...selected].sort((a, b) => a - b);
      }
    }

    ds.mapPointIndices = dragIndices;
    ds.mapPointDragStartPositions = {};
    for (const idx of dragIndices) {
      const p = ds.mapPointPoints[idx];
      if (p) ds.mapPointDragStartPositions[idx] = { x: p.x, y: p.y };
    }

    if (window.MapShine?.cameraController) {
      window.MapShine.cameraController.enabled = false;
    }
  }

  /**
   * Update the visual helper geometry during a handle drag.
   */
  updateDraggedHelperGeometry() {
    const ds = this._im.dragState;
    const groupId = ds.mapPointGroupId;
    const points = ds.mapPointPoints;
    if (!groupId || !Array.isArray(points) || points.length === 0) return;

    const helperGroup = this._getHelperGroupFromObject(ds.object);
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
      if (child?.userData?.type === 'mapPointLine') updateLineGeometry(child, false);
      if (child?.userData?.type === 'mapPointOutline') updateLineGeometry(child, true);
    }

    this._syncDraggedHandleMeshes(helperGroup, points, ds.mapPointIndices);
  }

  /**
   * Move all dragged handle meshes to match working point coordinates.
   * @private
   */
  _syncDraggedHandleMeshes(helperGroup, points, indices) {
    if (!helperGroup || !Array.isArray(points)) return;
    const dragSet = Array.isArray(indices) && indices.length > 0
      ? new Set(indices)
      : null;

    for (const child of helperGroup.children) {
      if (child?.userData?.type !== 'mapPointHandle') continue;
      const idx = child.userData.pointIndex;
      if (dragSet && !dragSet.has(idx)) continue;
      const p = points[idx];
      if (!p) continue;
      const z = child.position.z;
      child.position.set(p.x, p.y, z);
    }
  }

  // ── Hit Testing ───────────────────────────────────────────────────────────

  /**
   * Get the map point handle at a screen position (if visual helpers visible).
   * @param {number} clientX
   * @param {number} clientY
   * @returns {{groupId: string, pointIndex: number, object: THREE.Object3D, hitPoint: THREE.Vector3}|null}
   */
  getHandleAtPosition(clientX, clientY) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    const camera = this.sceneComposer?.camera;
    const sessionGroupId = this.getGroupEditSessionGroupId();
    const editorActive = this.isMapPointsEditorActive() || mapPointsManager?.showVisualHelpers;
    if (!editorActive || !camera) return null;
    if (sessionGroupId && !mapPointsManager.visualObjects?.has(sessionGroupId)) return null;

    const rect = this._im.canvasElement.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;

    this._im.updateMouseCoords({ clientX, clientY });
    this.raycaster.setFromCamera(this._im.mouse, camera);

    const helpers = sessionGroupId
      ? [mapPointsManager.visualObjects.get(sessionGroupId)].filter(Boolean)
      : Array.from(mapPointsManager.visualObjects?.values?.() ?? []);
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

  /**
   * Get the map point group at a screen position.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {string|null} Group ID or null
   */
  getGroupAtPosition(clientX, clientY) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    const editorActive = this.isMapPointsEditorActive() || mapPointsManager?.showVisualHelpers;
    if (!editorActive) return null;

    const worldPos = this._im.screenToWorld(clientX, clientY);
    if (!worldPos) return null;

    const clickRadius = MAP_POINT_HIT_RADIUS;

    for (const [groupId, group] of mapPointsManager.groups) {
      if (!group.points || group.points.length === 0) continue;

      // Check if click is near any point
      for (const point of group.points) {
        const dx = worldPos.x - point.x;
        const dy = worldPos.y - point.y;
        if (Math.sqrt(dx * dx + dy * dy) < clickRadius) return groupId;
      }

      // For areas, check if inside polygon
      if (group.type === 'area' && group.points.length >= 3) {
        if (mapPointsManager._isPointInPolygon(worldPos.x, worldPos.y, group.points)) {
          return groupId;
        }
      }

      // For lines, check if near any segment
      if (group.type === 'line' && group.points.length >= 2) {
        for (let i = 0; i < group.points.length - 1; i++) {
          const p1 = group.points[i];
          const p2 = group.points[i + 1];
          if (_pointToLineDistance(worldPos.x, worldPos.y, p1.x, p1.y, p2.x, p2.y) < clickRadius) {
            return groupId;
          }
        }
      }
    }

    return null;
  }

  // ── Context Menu ──────────────────────────────────────────────────────────

  /**
   * Show context menu for a map point group.
   * @param {string} groupId
   * @param {number} clientX
   * @param {number} clientY
   */
  showContextMenu(groupId, clientX, clientY) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    const uiManager = window.MapShine?.uiManager;
    if (!mapPointsManager) return;

    const group = mapPointsManager.getGroup(groupId);
    if (!group) return;

    // Remove any existing menu
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
            if (uiManager?.openGroupEditDialog) uiManager.openGroupEditDialog(groupId);
            break;
          case 'focus': {
            const bounds = mapPointsManager.getAreaBounds(groupId);
            if (bounds) {
              const foundryPos = Coordinates.toFoundry(bounds.centerX, bounds.centerY);
              canvas.pan({ x: foundryPos.x, y: foundryPos.y });
            }
            break;
          }
          case 'duplicate': {
            const newGroup = await mapPointsManager.createGroup({
              ...group,
              id: undefined,
              label: `${group.label} (copy)`,
              metadata: this._getActiveLevelMetadata({ preserveGroup: group }),
            });
            log.info(`Created map point group: ${newGroup.id}`);
            ui.notifications.info(`Duplicated: ${newGroup.label}`);
            mapPointsManager.createVisualHelpers();
            break;
          }
          case 'addPoints':
            this.startAddPointsToGroup(groupId);
            break;
          case 'delete': {
            const confirmed = await Dialog.confirm({
              title: 'Delete Map Point Group',
              content: `<p>Delete "${group.label || 'this group'}"?</p>`,
              yes: () => true,
              no: () => false
            });
            if (confirmed) {
              const ok = await mapPointsManager.deleteGroup(groupId);
              if (ok) ui.notifications.info('Group deleted');
              else ui.notifications.warn('Failed to delete group (insufficient permissions or save error).');
            }
            break;
          }
        }
      });

      menu.appendChild(menuItem);
    }

    // Header with group name
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
    const effectShort = mapPointsManager.getEffectShortLabel?.(group.effectTarget)
      ?? mapPointsManager.getEffectLabel?.(group.effectTarget)
      ?? group.effectTarget
      ?? 'None';
    header.textContent = `${group.label || 'Map Point Group'} · ${effectShort} · map points`;
    menu.insertBefore(header, menu.firstChild);

    document.body.appendChild(menu);

    // Close when clicking elsewhere
    const closeMenu = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('pointerdown', closeMenu);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeMenu), 10);

    // Adjust position if off-screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${clientX - rect.width}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${clientY - rect.height}px`;
  }

  // ── Settings Persistence ──────────────────────────────────────────────────

  /**
   * Get the last used effect target.
   * @returns {string}
   */
  getLastEffectTarget() {
    try {
      return game.settings.get('map-shine-advanced', 'lastMapPointEffect') || 'smellyFlies';
    } catch (e) {
      return localStorage.getItem('map-shine-lastMapPointEffect') || 'smellyFlies';
    }
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  /**
   * Get the color for an effect type.
   * @param {string} effectTarget
   * @returns {number} Hex color
   */
  getEffectColor(effectTarget) {
    return EFFECT_COLORS[effectTarget] || 0x00ff00;
  }

  /**
   * Update the preview cursor position (called from onPointerMove).
   * @param {number} cursorX - World X
   * @param {number} cursorY - World Y
   */
  updateCursorPreview(cursorX, cursorY) {
    this._updatePreview(cursorX, cursorY);
  }

  // ── Private Helpers ───────────────────────────────────────────────────────

  /** @private */
  _saveLastEffectTarget(effectTarget) {
    try {
      game.settings.set('map-shine-advanced', 'lastMapPointEffect', effectTarget);
    } catch (e) {
      localStorage.setItem('map-shine-lastMapPointEffect', effectTarget);
    }
  }

  /** @private */
  _clearPointMarkers() {
    for (const marker of this.state.pointMarkers) {
      if (marker.geometry) marker.geometry.dispose();
      if (marker.material) marker.material.dispose();
      this.state.previewGroup.remove(marker);
    }
    this.state.pointMarkers = [];
  }

  /**
   * Create a point marker mesh.
   * @private
   */
  _createPointMarker(x, y, z, color, index) {
    const marker = createMapPointMarkerGroup(x, y, z, color, index, { renderOrderBase: 10000 });
    if (marker) return marker;

    const THREE = window.THREE;
    return new THREE.Group();
  }

  /**
   * Update the preview line, markers, fill, and cursor.
   * @private
   */
  _updatePreview(cursorX = null, cursorY = null) {
    const THREE = window.THREE;
    const { points, groupType, previewLine, previewPoints, previewFill, cursorPoint } = this.state;

    const groundZ = this.sceneComposer?.groundZ ?? 1000;
    const previewZ = groundZ + 2;
    const effectColor = this.getEffectColor(this.state.effectTarget);

    // Include cursor position if provided
    const allPoints = [...points];
    if (cursorX !== null && cursorY !== null && this.state.active) {
      allPoints.push({ x: cursorX, y: cursorY });
    }

    // Update line
    const linePositions = [];
    for (const p of allPoints) linePositions.push(p.x, p.y, previewZ);
    if (groupType === 'area' && allPoints.length > 2) {
      linePositions.push(allPoints[0].x, allPoints[0].y, previewZ);
    }
    previewLine.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
    previewLine.geometry.attributes.position.needsUpdate = true;

    // Update legacy points
    const pointPositions = [];
    for (const p of points) pointPositions.push(p.x, p.y, previewZ);
    previewPoints.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pointPositions, 3));
    previewPoints.geometry.attributes.position.needsUpdate = true;

    // Update point markers
    while (this.state.pointMarkers.length < points.length) {
      const idx = this.state.pointMarkers.length;
      const marker = this._createPointMarker(0, 0, previewZ, effectColor, idx);
      this.state.previewGroup.add(marker);
      this.state.pointMarkers.push(marker);
    }
    while (this.state.pointMarkers.length > points.length) {
      const marker = this.state.pointMarkers.pop();
      if (marker) {
        marker.traverse((child) => {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        });
        this.state.previewGroup.remove(marker);
      }
    }
    for (let i = 0; i < points.length; i++) {
      const marker = this.state.pointMarkers[i];
      if (marker) marker.position.set(points[i].x, points[i].y, previewZ + 1);
    }

    // Update cursor preview
    if (cursorPoint && cursorX !== null && cursorY !== null && this.state.active) {
      cursorPoint.position.set(cursorX, cursorY, previewZ + 2);
      cursorPoint.visible = true;
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
      for (let i = 1; i < allPoints.length; i++) shape.lineTo(allPoints[i].x, allPoints[i].y);
      shape.closePath();

      const fillGeo = new THREE.ShapeGeometry(shape);
      const posAttr = fillGeo.getAttribute('position');
      for (let i = 0; i < posAttr.count; i++) posAttr.setZ(i, previewZ - 1);
      posAttr.needsUpdate = true;

      previewFill.geometry.dispose();
      previewFill.geometry = fillGeo;
    }
  }

  /**
   * Traverse up to find a map point helper group.
   * @private
   */
  _getHelperGroupFromObject(object) {
    let obj = object;
    while (obj) {
      if (obj.userData?.type === 'mapPointHelper') return obj;
      obj = obj.parent;
    }
    return null;
  }
}

// ── Free Functions ──────────────────────────────────────────────────────────

/**
 * Calculate distance from a point to a line segment.
 * @param {number} px
 * @param {number} py
 * @param {number} x1
 * @param {number} y1
 * @param {number} x2
 * @param {number} y2
 * @returns {number}
 */
function _pointToLineDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return Math.sqrt((px - x1) * (px - x1) + (py - y1) * (py - y1));
  }

  let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));

  const projX = x1 + t * dx;
  const projY = y1 + t * dy;

  return Math.sqrt((px - projX) * (px - projX) + (py - projY) * (py - projY));
}
