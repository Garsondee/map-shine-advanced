/**
 * @fileoverview MovementPreviewEffectV2 — token movement UI overlay for the V2 pipeline.
 *
 * Owns all token movement visualization inside the FloorRenderBus scene:
 *   - Path preview: outer solid line + inner dashed line + per-step tile highlights
 *     + destination ghost token sprite(s).
 *   - Drag previews: semi-transparent token sprite clones while drag-moving.
 *
 * Why a dedicated V2 effect?
 *   In V2, only `FloorRenderBus._scene` is rendered by `FloorCompositor`. Objects
 *   attached to the legacy `sceneComposer.scene` or created with wrong Z values
 *   (near 0) are silently invisible because the bus tiles start at Z=1000.
 *   This class guarantees correct Z placement, layer assignment, and render-order
 *   for every movement UI object so they always appear above the tile stack.
 *
 * Z conventions (must be above tile range):
 *   Bus tiles:   Z = GROUND_Z + floorIndex  (1000, 1001, …)
 *   Tokens:      Z ≈ 1003
 *   This effect: Z = 1004  (OVERLAY_Z constant below)
 *
 * Render-order conventions (above fire at 200000):
 *   RO_LINE_OUTER = 250001
 *   RO_LINE_INNER = 250002
 *   RO_TILES      = 250003
 *   RO_GHOST      = 250004
 *   RO_DRAG       = 250005
 *
 * Public API called by InteractionManager:
 *   showPathPreview(pathNodes, totalDistance, tokenDoc, groupAssignments, options)
 *   clearPathPreview()
 *   showDragPreviews(tokenManager, selectionIds)
 *   updateDragPreviewPosition(id, worldX, worldY, worldZ?)
 *   getDragPreview(id)
 *   clearDragPreviews()
 *   dispose()
 *
 * @module compositor-v2/effects/MovementPreviewEffectV2
 */

import { createLogger } from '../../core/log.js';
import { OVERLAY_THREE_LAYER } from '../../core/render-layers.js';
import Coordinates from '../../utils/coordinates.js';

const log = createLogger('MovementPreviewEffectV2');

// Z above token layer (tokens ≈ 1003, tiles 1000–1019).
const OVERLAY_Z = 1004.0;

// Render-orders: must exceed fire (200000) and tile overhead (195000).
const RO_BASE       = 250000;
const RO_LINE_OUTER = 250001;
const RO_LINE_INNER = 250002;
const RO_TILES      = 250003;
const RO_PORTAL     = 250004;
const RO_GHOST      = 250005;
const RO_DRAG       = 250006;

// ─── MovementPreviewEffectV2 ─────────────────────────────────────────────────

export class MovementPreviewEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._bus = renderBus;

    /** @type {import('three').Scene|null} — bus scene, set during initialize() */
    this._scene = null;

    // ── Path preview ─────────────────────────────────────────────────────────

    /** @type {import('three').Group|null} */
    this._pathGroup = null;
    /** @type {import('three').Line|null} */
    this._lineOuter = null;
    /** @type {import('three').Line|null} */
    this._lineInner = null;
    /** @type {import('three').Group|null} */
    this._tileGroup = null;
    /** @type {import('three').Group|null} */
    this._portalGroup = null;
    /** @type {import('three').Group|null} */
    this._ghostGroup = null;

    /** @type {HTMLElement|null} — DOM distance label, positioned via camera projection */
    this._labelEl = null;

    // ── Drag previews ─────────────────────────────────────────────────────────

    /** @type {Map<string, import('three').Sprite>} tokenId → ghost sprite */
    this._dragPreviews = new Map();

    this._initialized = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  initialize() {
    const THREE = window.THREE;
    if (!THREE) {
      log.warn('MovementPreviewEffectV2.initialize: THREE not available');
      return;
    }

    // Grab bus scene — must be called after FloorRenderBus.initialize().
    this._scene = this._bus?._scene ?? null;
    if (!this._scene) {
      log.warn('MovementPreviewEffectV2.initialize: bus scene not yet available');
      return;
    }

    this._buildPathGroup(THREE);
    this._buildLabelEl();

    this._initialized = true;
    log.info('MovementPreviewEffectV2 initialized');
  }

  dispose() {
    this._teardownPathGroup();
    this.clearDragPreviews();

    if (this._labelEl?.parentNode) {
      try { this._labelEl.parentNode.removeChild(this._labelEl); } catch (_) {}
    }
    this._labelEl = null;
    this._scene = null;
    this._initialized = false;
  }

  // ── Path Preview API ─────────────────────────────────────────────────────────

  /**
   * Draw the movement path preview in the bus scene.
   *
   * @param {Array<{x:number,y:number}>} pathNodes  Foundry-space center points
   * @param {number}  totalDistance  Pixel distance (for the label)
   * @param {object|null} tokenDoc   Primary token document (null for group-only call)
   * @param {Array<{tokenId:string, pathNodes?:Array, destinationTopLeft?:{x,y}}>|null} groupAssignments
   * @param {object} [options]
   * @param {boolean}  [options.showGhosts=true]
   * @param {Function} [options.tokenTopLeftToCenterFoundry]  Helper from InteractionManager
   * @param {Function} [options.worldToClient]  Projects THREE.Vector3 → {x,y} screen coords
   */
  showPathPreview(pathNodes, totalDistance, tokenDoc = null, groupAssignments = null, options = {}) {
    if (!this._initialized) {
      // Retry initialization — bus scene may have become available after construction.
      if (this._bus?._scene && !this._scene) this.initialize();
      if (!this._initialized) return;
    }

    if (!Array.isArray(pathNodes) || pathNodes.length < 2) {
      this.clearPathPreview();
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    const showGhosts = options?.showGhosts !== false;
    const tokenManager = window.MapShine?.interactionManager?.tokenManager
      ?? window.MapShine?.tokenManager
      ?? null;

    const grid = window.canvas?.grid;
    const gridSize = Math.max(1, Number(grid?.size ?? window.canvas?.dimensions?.size ?? 100));
    const tileW = Math.max(8, Number(grid?.sizeX ?? gridSize));
    const tileH = Math.max(8, Number(grid?.sizeY ?? gridSize));

    const snapNodeToCell = (node) => {
      const snappedTopLeft = (typeof grid?.getTopLeft === 'function')
        ? grid.getTopLeft(Number(node?.x ?? 0), Number(node?.y ?? 0))
        : [
            Math.floor(Number(node?.x ?? 0) / tileW) * tileW,
            Math.floor(Number(node?.y ?? 0) / tileH) * tileH
          ];
      const cellX = Number(Array.isArray(snappedTopLeft) ? snappedTopLeft[0] : snappedTopLeft?.x ?? 0);
      const cellY = Number(Array.isArray(snappedTopLeft) ? snappedTopLeft[1] : snappedTopLeft?.y ?? 0);
      return {
        cellX,
        cellY,
        centerX: cellX + (tileW * 0.5),
        centerY: cellY + (tileH * 0.5)
      };
    };

    const displayCells = [];
    const seenCells = new Set();
    const pushCell = (cell) => {
      const key = `${Math.round(Number(cell?.cellX ?? 0))}:${Math.round(Number(cell?.cellY ?? 0))}`;
      if (seenCells.has(key)) return;
      seenCells.add(key);
      displayCells.push(cell);
    };

    for (let i = 0; i < pathNodes.length; i++) {
      const current = snapNodeToCell(pathNodes[i]);
      if (i === 0) {
        pushCell(current);
        continue;
      }

      const previous = snapNodeToCell(pathNodes[i - 1]);
      const startCol = Math.round(previous.cellX / tileW);
      const startRow = Math.round(previous.cellY / tileH);
      const endCol = Math.round(current.cellX / tileW);
      const endRow = Math.round(current.cellY / tileH);
      const steps = Math.max(Math.abs(endCol - startCol), Math.abs(endRow - startRow), 1);

      for (let step = 1; step <= steps; step++) {
        const t = step / steps;
        const col = Math.round(startCol + ((endCol - startCol) * t));
        const row = Math.round(startRow + ((endRow - startRow) * t));
        pushCell({
          cellX: col * tileW,
          cellY: row * tileH,
          centerX: (col * tileW) + (tileW * 0.5),
          centerY: (row * tileH) + (tileH * 0.5)
        });
      }
    }

    // Fog-of-war occlusion for players: clip preview at the first hidden cell so
    // path UI cannot reveal geometry/routes beyond explored/visible space.
    const shouldFogClip = !game?.user?.isGM;
    let hiddenTailClipped = false;
    if (shouldFogClip && displayCells.length > 0) {
      const clippedCells = [];
      for (const cell of displayCells) {
        const visible = this._isFoundryPointVisibleToPlayer(cell.centerX, cell.centerY);
        if (!visible) {
          hiddenTailClipped = true;
          break;
        }
        clippedCells.push(cell);
      }
      displayCells.length = 0;
      displayCells.push(...clippedCells);
    }

    if (displayCells.length < 2) {
      this.clearPathPreview();
      return;
    }

    // ── Build world-space points from the same snapped cell route used for highlights ──
    const points = displayCells.map(cell => {
      const w = Coordinates.toWorld(cell.centerX, cell.centerY);
      return new THREE.Vector3(w.x, w.y, OVERLAY_Z);
    });

    // ── Outer line ──────────────────────────────────────────────────────────
    try { this._lineOuter.geometry.dispose(); } catch (_) {}
    this._lineOuter.geometry = new THREE.BufferGeometry().setFromPoints(points);

    // ── Inner dashed line ───────────────────────────────────────────────────
    try { this._lineInner.geometry.dispose(); } catch (_) {}
    this._lineInner.geometry = new THREE.BufferGeometry().setFromPoints(points);
    try { this._lineInner.computeLineDistances(); } catch (_) {}

    // ── Tile highlights ─────────────────────────────────────────────────────
    this._clearChildren(this._tileGroup, true);

    for (let i = 1; i < displayCells.length; i++) {
      const cell = displayCells[i];
      const w = Coordinates.toWorld(cell.centerX, cell.centerY);
      const highlight = new THREE.Mesh(
        new THREE.PlaneGeometry(tileW * 0.92, tileH * 0.92),
        new THREE.MeshBasicMaterial({
          color: 0x3f86ff,
          transparent: true,
          opacity: 0.25,
          depthTest: false,
          depthWrite: false
        })
      );
      highlight.position.set(w.x, w.y, OVERLAY_Z - 0.01);
      highlight.renderOrder = RO_TILES;
      highlight.layers.set(OVERLAY_THREE_LAYER);
      highlight.layers.enable(0);
      this._tileGroup.add(highlight);
    }

    // ── Ghost token(s) at destination ───────────────────────────────────────
    this._clearChildren(this._ghostGroup, false);

    // ── Cross-floor portal markers ──────────────────────────────────────────
    this._clearChildren(this._portalGroup, true);
    const crossFloorSegments = Array.isArray(options?.crossFloorSegments)
      ? options.crossFloorSegments
      : [];
    if (crossFloorSegments.length > 0) {
      const markerRadius = Math.max(8, Math.min(tileW, tileH) * 0.22);
      for (const segment of crossFloorSegments) {
        if (String(segment?.type || '') !== 'portal-transition') continue;
        const entry = segment?.entry;
        const exit = segment?.exit;
        if (!entry || !Number.isFinite(Number(entry.x)) || !Number.isFinite(Number(entry.y))) continue;

        const entryVisible = !shouldFogClip || this._isFoundryPointVisibleToPlayer(entry.x, entry.y);
        if (!entryVisible) continue;
        const exitVisible = !!(exit
          && Number.isFinite(Number(exit.x))
          && Number.isFinite(Number(exit.y))
          && (!shouldFogClip || this._isFoundryPointVisibleToPlayer(exit.x, exit.y)));

        const entryWorld = Coordinates.toWorld(Number(entry.x), Number(entry.y));
        const entryMarker = new THREE.Mesh(
          new THREE.CircleGeometry(markerRadius, 22),
          new THREE.MeshBasicMaterial({
            color: 0xffc347,
            transparent: true,
            opacity: 0.82,
            depthTest: false,
            depthWrite: false
          })
        );
        entryMarker.position.set(entryWorld.x, entryWorld.y, OVERLAY_Z + 0.01);
        entryMarker.renderOrder = RO_PORTAL;
        entryMarker.layers.set(OVERLAY_THREE_LAYER);
        entryMarker.layers.enable(0);
        this._portalGroup.add(entryMarker);

        if (exitVisible) {
          const exitWorld = Coordinates.toWorld(Number(exit.x), Number(exit.y));

          const connector = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(entryWorld.x, entryWorld.y, OVERLAY_Z + 0.01),
              new THREE.Vector3(exitWorld.x, exitWorld.y, OVERLAY_Z + 0.01)
            ]),
            new THREE.LineDashedMaterial({
              color: 0xffd98f,
              transparent: true,
              opacity: 0.85,
              depthTest: false,
              depthWrite: false,
              dashSize: Math.max(8, markerRadius * 0.9),
              gapSize: Math.max(6, markerRadius * 0.65),
              scale: 1
            })
          );
          try { connector.computeLineDistances(); } catch (_) {}
          connector.renderOrder = RO_PORTAL;
          connector.layers.set(OVERLAY_THREE_LAYER);
          connector.layers.enable(0);
          this._portalGroup.add(connector);

          const exitMarker = new THREE.Mesh(
            new THREE.RingGeometry(markerRadius * 0.5, markerRadius * 0.9, 24),
            new THREE.MeshBasicMaterial({
              color: 0x8fe3ff,
              transparent: true,
              opacity: 0.82,
              depthTest: false,
              depthWrite: false
            })
          );
          exitMarker.position.set(exitWorld.x, exitWorld.y, OVERLAY_Z + 0.011);
          exitMarker.renderOrder = RO_PORTAL;
          exitMarker.layers.set(OVERLAY_THREE_LAYER);
          exitMarker.layers.enable(0);
          this._portalGroup.add(exitMarker);
        }
      }
    }

    if (showGhosts && tokenManager) {
      /**
       * @param {object} doc  Token document
       * @param {{x:number,y:number}} endFoundryCenter  Foundry-space center of destination
       */
      const addGhost = (doc, endFoundryCenter) => {
        if (!doc || !endFoundryCenter) return;
        if (shouldFogClip && !this._isFoundryPointVisibleToPlayer(endFoundryCenter.x, endFoundryCenter.y)) {
          return;
        }
        const spriteData = doc?.id ? tokenManager.tokenSprites?.get?.(doc.id) : null;
        const sourceSprite = spriteData?.sprite;
        if (!sourceSprite) return;

        const tex = sourceSprite.material?.map ?? sourceSprite.userData?.texture ?? null;
        if (!tex) return;

        const ghost = new THREE.Sprite(new THREE.SpriteMaterial({
          map: tex,
          transparent: true,
          opacity: 0.5,
          depthTest: false,
          depthWrite: false,
          toneMapped: false
        }));
        ghost.scale.set(
          Math.max(1, Number(sourceSprite.scale?.x ?? 1)),
          Math.max(1, Number(sourceSprite.scale?.y ?? 1)),
          1
        );
        const endWorld = Coordinates.toWorld(
          Number(endFoundryCenter?.x ?? 0),
          Number(endFoundryCenter?.y ?? 0)
        );
        ghost.position.set(endWorld.x, endWorld.y, OVERLAY_Z + 0.02);
        ghost.renderOrder = RO_GHOST;
        ghost.layers.set(OVERLAY_THREE_LAYER);
        ghost.layers.enable(0);
        this._ghostGroup.add(ghost);
      };

      if (Array.isArray(groupAssignments) && groupAssignments.length > 0) {
        for (const assignment of groupAssignments) {
          const tokenId = String(assignment?.tokenId ?? '');
          if (!tokenId) continue;
          const doc = tokenManager.tokenSprites?.get?.(tokenId)?.tokenDoc
            ?? (tokenDoc?.id === tokenId ? tokenDoc : null);
          if (!doc) continue;

          let endFoundry = null;
          if (Array.isArray(assignment?.pathNodes) && assignment.pathNodes.length > 0) {
            endFoundry = assignment.pathNodes[assignment.pathNodes.length - 1];
          } else if (assignment?.destinationTopLeft && options?.tokenTopLeftToCenterFoundry) {
            endFoundry = options.tokenTopLeftToCenterFoundry(assignment.destinationTopLeft, doc);
          }
          addGhost(doc, endFoundry);
        }
      } else {
        const doc = tokenDoc;
        const endFoundry = pathNodes[pathNodes.length - 1];
        addGhost(doc, endFoundry);
      }
    }

    this._pathGroup.visible = true;

    // ── Distance label ──────────────────────────────────────────────────────
    if (this._labelEl) {
      const units = window.canvas?.grid?.units ?? window.canvas?.scene?.grid?.units ?? '';
      const dist = Number.isFinite(totalDistance) ? totalDistance : 0;
      const pxPerGrid = Number(window.canvas?.dimensions?.size ?? 100);
      const unitsPerGrid = Number(window.canvas?.dimensions?.distance ?? 1);
      const distanceInUnits = (dist / Math.max(1, pxPerGrid)) * unitsPerGrid;
      const distLabel = Number.isFinite(distanceInUnits) ? distanceInUnits.toFixed(1) : '0.0';
      this._labelEl.textContent = units ? `${distLabel} ${units}` : distLabel;
      if (hiddenTailClipped) {
        // Avoid implying hidden remaining distance by appending an ellipsis.
        this._labelEl.textContent += '…';
      }

      if (options?.worldToClient) {
        const last = points[points.length - 1];
        const screen = options.worldToClient(last);
        if (screen) {
          this._labelEl.style.left = `${screen.x + 10}px`;
          this._labelEl.style.top = `${screen.y - 24}px`;
          this._labelEl.style.display = 'block';
        } else {
          this._labelEl.style.display = 'none';
        }
      } else {
        this._labelEl.style.display = 'none';
      }
    }
  }

  /** Hide and reset path preview geometry. */
  clearPathPreview() {
    if (this._pathGroup) this._pathGroup.visible = false;
    this._resetPathGeometry();

    if (this._labelEl) {
      this._labelEl.style.display = 'none';
      this._labelEl.textContent = '';
    }
  }

  // ── Drag Preview API ─────────────────────────────────────────────────────────

  /**
   * Create semi-transparent ghost sprites for all token IDs in `selectionIds`.
   * Call `clearDragPreviews()` first if a previous drag is still live.
   *
   * @param {import('../../scene/token-manager.js').TokenManager} tokenManager
   * @param {Iterable<string>} selectionIds
   */
  showDragPreviews(tokenManager, selectionIds) {
    this.clearDragPreviews();

    const THREE = window.THREE;
    if (!THREE || !this._scene || !tokenManager) return;

    for (const id of selectionIds) {
      const spriteData = tokenManager.tokenSprites?.get?.(id);
      const source = spriteData?.sprite;
      if (!source) continue;

      const movementManager = window.MapShine?.tokenMovementManager;
      const isFlyingToken = !!movementManager?.isFlying?.(id);

      const ghostMat = new THREE.SpriteMaterial({
        map: source.material?.map ?? null,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      });

      const ghost = new THREE.Sprite(ghostMat);
      ghost.scale.copy(source.scale);
      ghost.position.copy(source.position);
      // Fly-landing preview: snap to ground-level Z so the indicator shows where the token
      // will land rather than its current float height.
      ghost.position.z = isFlyingToken ? OVERLAY_Z : (source.position.z + 0.5);
      ghost.renderOrder = RO_DRAG;
      ghost.matrixAutoUpdate = true;
      ghost.layers.set(OVERLAY_THREE_LAYER);
      ghost.layers.enable(0);
      ghost.userData = { type: 'dragPreview', tokenId: id };

      this._scene.add(ghost);
      this._dragPreviews.set(id, ghost);
    }
  }

  /**
   * Move a drag-preview sprite to a new world XY position.
   * @param {string} id  Token ID
   * @param {number} worldX
   * @param {number} worldY
   * @param {number} [worldZ]  Optional — defaults to the sprite's current Z
   */
  updateDragPreviewPosition(id, worldX, worldY, worldZ) {
    const ghost = this._dragPreviews.get(id);
    if (!ghost) return;
    ghost.position.x = worldX;
    ghost.position.y = worldY;
    if (worldZ !== undefined) ghost.position.z = worldZ;
  }

  /**
   * Return the Three.js Sprite for a drag preview (for external position updates).
   * @param {string} id
   * @returns {import('three').Sprite|undefined}
   */
  getDragPreview(id) {
    return this._dragPreviews.get(id);
  }

  /** Remove and dispose all drag preview sprites. */
  clearDragPreviews() {
    for (const ghost of this._dragPreviews.values()) {
      try { ghost.removeFromParent(); } catch (_) {}
      try { ghost.material?.dispose?.(); } catch (_) {}
    }
    this._dragPreviews.clear();
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Build the persistent path-preview group and its children, add to bus scene.
   * @param {typeof import('three')} THREE
   */
  _buildPathGroup(THREE) {
    const group = new THREE.Group();
    group.name = 'MovementPathPreviewV2';
    group.userData = {
      ...(group.userData || {}),
      type: 'interactionOverlay',
      preserveOnBusClear: true
    };
    group.visible = false;
    group.renderOrder = RO_BASE;
    group.layers.set(OVERLAY_THREE_LAYER);
    group.layers.enable(0);

    // Outer solid path line.
    this._lineOuter = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0x143e78,
        transparent: true,
        opacity: 0.72,
        depthTest: false,
        depthWrite: false
      })
    );
    this._lineOuter.renderOrder = RO_LINE_OUTER;
    this._lineOuter.layers.set(OVERLAY_THREE_LAYER);
    this._lineOuter.layers.enable(0);

    // Inner dashed path line.
    this._lineInner = new THREE.Line(
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
    this._lineInner.renderOrder = RO_LINE_INNER;
    this._lineInner.layers.set(OVERLAY_THREE_LAYER);
    this._lineInner.layers.enable(0);

    // Per-step tile highlight quads.
    this._tileGroup = new THREE.Group();
    this._tileGroup.name = 'MovementPreviewTilesV2';
    this._tileGroup.renderOrder = RO_TILES;
    this._tileGroup.layers.set(OVERLAY_THREE_LAYER);
    this._tileGroup.layers.enable(0);

    // Cross-floor portal transition markers.
    this._portalGroup = new THREE.Group();
    this._portalGroup.name = 'MovementPreviewPortalsV2';
    this._portalGroup.renderOrder = RO_PORTAL;
    this._portalGroup.layers.set(OVERLAY_THREE_LAYER);
    this._portalGroup.layers.enable(0);

    // Destination ghost token sprite(s).
    this._ghostGroup = new THREE.Group();
    this._ghostGroup.name = 'MovementPreviewGhostsV2';
    this._ghostGroup.renderOrder = RO_GHOST;
    this._ghostGroup.layers.set(OVERLAY_THREE_LAYER);
    this._ghostGroup.layers.enable(0);

    group.add(this._lineOuter);
    group.add(this._lineInner);
    group.add(this._tileGroup);
    group.add(this._portalGroup);
    group.add(this._ghostGroup);

    this._scene.add(group);
    this._pathGroup = group;
  }

  /** Create the DOM label element for distance display. */
  _buildLabelEl() {
    if (this._labelEl?.parentNode) {
      try { this._labelEl.parentNode.removeChild(this._labelEl); } catch (_) {}
    }
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '10000';
    el.style.padding = '2px 7px';
    el.style.borderRadius = '4px';
    el.style.backgroundColor = 'rgba(5,12,20,0.72)';
    el.style.border = '1px solid rgba(88,180,255,0.42)';
    el.style.color = '#d9f1ff';
    el.style.fontFamily = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    el.style.fontSize = '12px';
    el.style.display = 'none';
    document.body.appendChild(el);
    this._labelEl = el;
  }

  /** Dispose and remove the path group from the bus scene. */
  _teardownPathGroup() {
    this._resetPathGeometry();
    if (this._pathGroup) {
      try { this._pathGroup.removeFromParent(); } catch (_) {}
      this._pathGroup = null;
    }
    this._lineOuter = null;
    this._lineInner = null;
    this._tileGroup = null;
    this._portalGroup = null;
    this._ghostGroup = null;
  }

  /**
   * Dispose all geometry/materials inside the path group children but keep the
   * group objects alive (so we can reuse them on the next showPathPreview call).
   */
  _resetPathGeometry() {
    if (this._lineOuter?.geometry) {
      try { this._lineOuter.geometry.dispose(); } catch (_) {}
      if (window.THREE) this._lineOuter.geometry = new window.THREE.BufferGeometry();
    }
    if (this._lineInner?.geometry) {
      try { this._lineInner.geometry.dispose(); } catch (_) {}
      if (window.THREE) this._lineInner.geometry = new window.THREE.BufferGeometry();
    }
    this._clearChildren(this._tileGroup, true);
    this._clearChildren(this._portalGroup, true);
    this._clearChildren(this._ghostGroup, false);
  }

  /**
   * Remove and optionally dispose all children from a Group.
   * @param {import('three').Group|null} group
   * @param {boolean} disposeGeometry  When true, also disposes geometry buffers.
   */
  _clearChildren(group, disposeGeometry) {
    if (!group) return;
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      group.remove(child);
      if (disposeGeometry) {
        try { child.geometry?.dispose?.(); } catch (_) {}
      }
      try { child.material?.dispose?.(); } catch (_) {}
    }
  }

  /**
   * Return whether a Foundry-space point is visible/explored for players.
   * @param {number} x
   * @param {number} y
   * @returns {boolean}
   */
  _isFoundryPointVisibleToPlayer(x, y) {
    const px = Number(x ?? 0);
    const py = Number(y ?? 0);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return false;

    try {
      const visible = !!canvas?.visibility?.testVisibility?.({ x: px, y: py }, { tolerance: 1 });
      const explored = !!canvas?.fog?.isPointExplored?.({ x: px, y: py });
      return visible || explored;
    } catch (_) {
      return false;
    }
  }
}
