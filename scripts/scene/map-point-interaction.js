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
import { OVERLAY_THREE_LAYER } from '../effects/EffectComposer.js';

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
  }

  // ── Accessors (delegate to parent IM) ───────────────────────────────────

  get sceneComposer() { return this._im.sceneComposer; }
  get raycaster() { return this._im.raycaster; }

  /** @returns {boolean} */
  get active() { return this.state.active; }

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
      size: 16,
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
    const cursorGeo = new THREE.RingGeometry(12, 16, 32);
    const cursorMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.8,
      depthTest: false,
      side: THREE.DoubleSide
    });
    this.state.cursorPoint = new THREE.Mesh(cursorGeo, cursorMat);
    this.state.cursorPoint.visible = false;
    this.state.previewGroup.add(this.state.cursorPoint);

    // Initialize point markers array
    this.state.pointMarkers = [];

    if (this.sceneComposer?.scene) {
      this.sceneComposer.scene.add(this.state.previewGroup);
    }
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
    this.state.points = [];
    this.state.editingGroupId = null;
    this.state.snapToGrid = snapToGrid;
    this.state.previewGroup.visible = true;

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
          points: points.map(p => ({ x: p.x, y: p.y }))
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

  // ── Handle Dragging ───────────────────────────────────────────────────────

  /**
   * Start dragging a map point handle.
   * @param {THREE.Object3D} handleObject
   * @param {THREE.Vector3} hitPoint
   * @param {string} groupId
   * @param {number} pointIndex
   */
  startHandleDrag(handleObject, hitPoint, groupId, pointIndex) {
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
    if (!mapPointsManager?.showVisualHelpers || !camera) return null;

    const rect = this._im.canvasElement.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;

    this._im.updateMouseCoords({ clientX, clientY });
    this.raycaster.setFromCamera(this._im.mouse, camera);

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

  /**
   * Get the map point group at a screen position.
   * @param {number} clientX
   * @param {number} clientY
   * @returns {string|null} Group ID or null
   */
  getGroupAtPosition(clientX, clientY) {
    const mapPointsManager = window.MapShine?.mapPointsManager;
    if (!mapPointsManager?.showVisualHelpers) return null;

    const worldPos = this._im.screenToWorld(clientX, clientY);
    if (!worldPos) return null;

    const clickRadius = 30;

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
              label: `${group.label} (copy)`
            });
            log.info(`Created map point group: ${newGroup.id}`);
            ui.notifications.info(`Duplicated: ${newGroup.label}`);
            if (mapPointsManager.showVisualHelpers) {
              mapPointsManager.setShowVisualHelpers(false);
              mapPointsManager.setShowVisualHelpers(true);
            }
            break;
          }
          case 'addPoints':
            this.startAddPointsToGroup(groupId);
            break;
          case 'hideHelpers':
            mapPointsManager.setShowVisualHelpers(false);
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
    header.textContent = group.label || 'Map Point Group';
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
    const THREE = window.THREE;
    const group = new THREE.Group();
    group.position.set(x, y, z);

    // Outer ring (white border)
    const outerRing = new THREE.RingGeometry(18, 24, 32);
    const outerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, side: THREE.DoubleSide
    });
    group.add(new THREE.Mesh(outerRing, outerMat));

    // Inner filled circle (effect color)
    const innerCircle = new THREE.CircleGeometry(16, 32);
    const innerMat = new THREE.MeshBasicMaterial({
      color: color, transparent: true, opacity: 0.8, depthTest: false, side: THREE.DoubleSide
    });
    const innerMesh = new THREE.Mesh(innerCircle, innerMat);
    innerMesh.position.z = 0.1;
    group.add(innerMesh);

    // Center dot
    const centerDot = new THREE.CircleGeometry(4, 16);
    const centerMat = new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.6, depthTest: false, side: THREE.DoubleSide
    });
    const centerMesh = new THREE.Mesh(centerDot, centerMat);
    centerMesh.position.z = 0.2;
    group.add(centerMesh);

    group.renderOrder = 10000 + index;
    return group;
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
