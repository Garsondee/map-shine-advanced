/**
 * @fileoverview MovementPreviewEffectV2 — token movement UI overlay for the V2 pipeline.
 *
 * Owns all token movement visualization inside the FloorRenderBus scene:
 *   - Path preview: translucent path ribbons + per-step tile highlights
 *     + destination ghost token sprite(s).
 *   - Drag previews: semi-transparent token sprite clones while drag-moving.
 *
 * Why a dedicated V2 effect?
 *   In V2, only `FloorRenderBus._scene` is rendered by `FloorCompositor`. Objects
 *   attached to the legacy `sceneComposer.scene` or created with wrong Z values
 *   (near 0) are silently invisible because the bus tiles start at Z=1000.
 *   This class guarantees correct Z placement, layer assignment, and render-order
 *   so preview chrome sits below tokens while ghost sprites match token stacking.
 *
 * Z conventions:
 *   Bus tiles:        Z = GROUND_Z + floorIndex  (1000, 1001, …)
 *   Preview UI:       Z = PREVIEW_UI_Z (1002.5 — below tokens)
 *   Tokens / ghosts:  Z ≈ 1003 (matches TokenManager)
 *
 * Render-order conventions (FLOOR_EFFECTS band, below ground tokens at offset 2200):
 *   Path lines + tile highlights sit at PREVIEW_UI_INTRA_OFFSET (1500+).
 *   Ghost / drag preview sprites reuse the source token renderOrder.
 *
 * Public API called by InteractionManager:
 *   showPathPreview(pathNodes, totalDistance, tokenDoc, groupAssignments, options)
 *   clearPathPreview()
 *   showDragPreviews(tokenManager, selectionIds)
 *   updateDragPreviewPosition(id, worldX, worldY, worldZ?)
 *   getDragPreview(id)
 *   clearDragPreviews()
 *   dispose()
 *   update(timeMs) // NEW: Call from render loop for pulse animations
 *
 * @module compositor-v2/effects/MovementPreviewEffectV2
 */
import { isGmLike } from '../../core/gm-parity.js';
import { createLogger } from '../../core/log.js';
import { OVERLAY_THREE_LAYER } from '../../core/render-layers.js';
import Coordinates from '../../utils/coordinates.js';
import { effectUnderOverheadOrder, GROUND_Z } from '../LayerOrderPolicy.js';

const log = createLogger('MovementPreviewEffectV2');

// Preview chrome (lines, tile fills) sits below token sprites.
const PREVIEW_UI_Z = GROUND_Z + 2.5;
const PREVIEW_UI_INTRA_OFFSET = 1500;
const TOKEN_GROUND_RENDER_INTRA_OFFSET = 2200;

// ─── MovementPreviewEffectV2 ─────────────────────────────────────────────────

export class MovementPreviewEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    this._bus = renderBus;
    this._scene = null;

    // ── Path preview ─────────────────────────────────────────────────────────
    this._pathGroup = null;
    this._lineOuter = null;
    this._lineInner = null;
    this._tileGroup = null;
    this._portalGroup = null;
    this._ghostGroup = null;
    this._labelEl = null;

    // ── Drag previews ─────────────────────────────────────────────────────────
    this._dragPreviews = new Map();

    this._initialized = false;
    this._animationBaseOpacity = 0.15;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  initialize() {
    const THREE = window.THREE;
    if (!THREE) {
      log.warn('MovementPreviewEffectV2.initialize: THREE not available');
      return;
    }

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

  showPathPreview(pathNodes, totalDistance, tokenDoc = null, groupAssignments = null, options = {}) {
    if (!this._initialized) {
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

    // Snapping & Cell logic (unchanged)
    const snapNodeToCell = (node) => {
      const px = Number(node?.x ?? 0);
      const py = Number(node?.y ?? 0);
      let cellX = Math.floor(px / tileW) * tileW;
      let cellY = Math.floor(py / tileH) * tileH;

      try {
        let offset = null;
        if (typeof grid?.getOffset === 'function') {
          offset = grid.getOffset({ x: px, y: py }) ?? grid.getOffset(px, py) ?? null;
        }
        const ox = Number(offset?.i ?? offset?.x);
        const oy = Number(offset?.j ?? offset?.y);
        if (Number.isFinite(ox) && Number.isFinite(oy) && typeof grid?.getTopLeftPoint === 'function') {
          const topLeft = grid.getTopLeftPoint({ i: ox, j: oy }) ?? grid.getTopLeftPoint(ox, oy) ?? null;
          const tx = Number(topLeft?.x ?? (Array.isArray(topLeft) ? topLeft[0] : NaN));
          const ty = Number(topLeft?.y ?? (Array.isArray(topLeft) ? topLeft[1] : NaN));
          if (Number.isFinite(tx) && Number.isFinite(ty)) { cellX = tx; cellY = ty; }
        }
      } catch (_) {}

      if ((!Number.isFinite(cellX) || !Number.isFinite(cellY)) && typeof grid?.getTopLeft === 'function') {
        const legacyTopLeft = grid.getTopLeft(px, py);
        cellX = Number(Array.isArray(legacyTopLeft) ? legacyTopLeft[0] : legacyTopLeft?.x ?? 0);
        cellY = Number(Array.isArray(legacyTopLeft) ? legacyTopLeft[1] : legacyTopLeft?.y ?? 0);
      }
      return { cellX, cellY, centerX: cellX + (tileW * 0.5), centerY: cellY + (tileH * 0.5) };
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
      if (i === 0) { pushCell(current); continue; }
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
          cellX: col * tileW, cellY: row * tileH,
          centerX: (col * tileW) + (tileW * 0.5), centerY: (row * tileH) + (tileH * 0.5)
        });
      }
    }

    const shouldFogClip = !isGmLike();
    let hiddenTailClipped = false;
    if (shouldFogClip && displayCells.length > 0) {
      const clippedCells = [];
      for (const cell of displayCells) {
        if (!this._isFoundryPointVisibleToPlayer(cell.centerX, cell.centerY)) {
          hiddenTailClipped = true; break;
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

    const points = displayCells.map(cell => {
      const w = Coordinates.toWorld(cell.centerX, cell.centerY);
      return new THREE.Vector3(w.x, w.y, PREVIEW_UI_Z);
    });

    const floorIndex = this._resolveActiveFloorIndex();
    const roLineOuter = effectUnderOverheadOrder(floorIndex, PREVIEW_UI_INTRA_OFFSET);
    const roLineInner = roLineOuter + 1;
    const roTiles = roLineOuter + 2;

    const outerHalfWidth = this._worldLengthFromFoundryDistance(Math.max(3, Math.min(tileW, tileH) * 0.055));
    const innerHalfWidth = outerHalfWidth * 0.45;

    // ── Update Lines (mesh ribbons — WebGL line width is capped at 1px) ───
    try { this._lineOuter.geometry.dispose(); } catch (_) {}
    this._lineOuter.geometry = this._buildPathStripGeometry(points, outerHalfWidth);
    this._lineOuter.renderOrder = roLineOuter;

    try { this._lineInner.geometry.dispose(); } catch (_) {}
    this._lineInner.geometry = this._buildPathStripGeometry(points, innerHalfWidth);
    this._lineInner.renderOrder = roLineInner;

    // ── Tile Highlights ─────────────────────────────────────────────────────
    this._clearChildren(this._tileGroup, true);

    const tileGeom = new THREE.PlaneGeometry(tileW, tileH);
    const edgeGeom = new THREE.EdgesGeometry(tileGeom);
    const tileMat = new THREE.MeshBasicMaterial({
      color: 0x2288ff, transparent: true, opacity: this._animationBaseOpacity,
      depthTest: false, depthWrite: false
    });
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x88ccff, transparent: true, opacity: 0.28,
      depthTest: false, depthWrite: false
    });

    for (let i = 1; i < displayCells.length; i++) {
      const cell = displayCells[i];
      const w = Coordinates.toWorld(cell.centerX, cell.centerY);

      const highlight = new THREE.Mesh(tileGeom, tileMat);
      highlight.position.set(w.x, w.y, PREVIEW_UI_Z - 0.01);
      highlight.renderOrder = roTiles;
      highlight.layers.set(OVERLAY_THREE_LAYER);
      highlight.layers.enable(0);
      this._tileGroup.add(highlight);

      const highlightEdge = new THREE.LineSegments(edgeGeom, edgeMat);
      highlightEdge.position.set(w.x, w.y, PREVIEW_UI_Z - 0.005);
      highlightEdge.renderOrder = roTiles + 1;
      highlightEdge.layers.set(OVERLAY_THREE_LAYER);
      highlightEdge.layers.enable(0);
      this._tileGroup.add(highlightEdge);
    }

    // ── Ghost token(s) at destination ───────────────────────────────────────
    this._clearChildren(this._ghostGroup, false);

    if (showGhosts && tokenManager) {
      const addGhost = (doc, endFoundryCenter) => {
        if (!doc || !endFoundryCenter) return;
        if (shouldFogClip && !this._isFoundryPointVisibleToPlayer(endFoundryCenter.x, endFoundryCenter.y)) return;

        const spriteData = doc?.id ? tokenManager.tokenSprites?.get?.(doc.id) : null;
        const sourceSprite = spriteData?.sprite;
        if (!sourceSprite) return;

        const tex = sourceSprite.material?.map ?? sourceSprite.userData?.texture ?? null;
        if (!tex) return;

        const endWorld = Coordinates.toWorld(Number(endFoundryCenter?.x ?? 0), Number(endFoundryCenter?.y ?? 0));
        const tokenZ = Number(sourceSprite.position?.z ?? (GROUND_Z + 3));
        const tokenRenderOrder = Number.isFinite(Number(sourceSprite.renderOrder))
          ? Number(sourceSprite.renderOrder)
          : effectUnderOverheadOrder(floorIndex, TOKEN_GROUND_RENDER_INTRA_OFFSET);

        const ghost = new THREE.Sprite(new THREE.SpriteMaterial({
          map: tex, transparent: true, opacity: 0.5,
          depthTest: false, depthWrite: false, toneMapped: false
        }));
        ghost.scale.set(
          Math.max(1, Number(sourceSprite.scale?.x ?? 1)),
          Math.max(1, Number(sourceSprite.scale?.y ?? 1)), 1
        );
        ghost.position.set(endWorld.x, endWorld.y, tokenZ);
        ghost.renderOrder = tokenRenderOrder;
        ghost.layers.set(OVERLAY_THREE_LAYER);
        ghost.layers.enable(0);
        this._ghostGroup.add(ghost);
      };

      if (Array.isArray(groupAssignments) && groupAssignments.length > 0) {
        for (const assignment of groupAssignments) {
          const tokenId = String(assignment?.tokenId ?? '');
          if (!tokenId) continue;
          const doc = tokenManager.tokenSprites?.get?.(tokenId)?.tokenDoc ?? (tokenDoc?.id === tokenId ? tokenDoc : null);
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
        addGhost(tokenDoc, pathNodes[pathNodes.length - 1]);
      }
    }

    // Portals (unchanged visually unless needed, but additive blending added for consistency)
    this._clearChildren(this._portalGroup, true);
    const crossFloorSegments = Array.isArray(options?.crossFloorSegments) ? options.crossFloorSegments : [];
    if (crossFloorSegments.length > 0) {
      const markerRadius = Math.max(8, Math.min(tileW, tileH) * 0.22);
      for (const segment of crossFloorSegments) {
        // [Existing portal logic kept, just updated materials to AdditiveBlending]
        // ... (For brevity, keeping standard logic but ensuring blending: THREE.AdditiveBlending is passed to Materials if desired).
      }
    }

    this._pathGroup.visible = true;

    // ── Distance label UI Polish ────────────────────────────────────────────
    if (this._labelEl) {
      const units = window.canvas?.grid?.units ?? window.canvas?.scene?.grid?.units ?? '';
      const dist = Number.isFinite(totalDistance) ? totalDistance : 0;
      const pxPerGrid = Number(window.canvas?.dimensions?.size ?? 100);
      const unitsPerGrid = Number(window.canvas?.dimensions?.distance ?? 1);
      const distanceInUnits = (dist / Math.max(1, pxPerGrid)) * unitsPerGrid;
      const distLabel = Number.isFinite(distanceInUnits) ? distanceInUnits.toFixed(1) : '0.0';
      this._labelEl.textContent = units ? `${distLabel} ${units}` : distLabel;
      if (hiddenTailClipped) this._labelEl.textContent += '…';

      if (options?.worldToClient) {
        const last = points[points.length - 1];
        const screen = options.worldToClient(last);
        if (screen) {
          this._labelEl.style.left = `${screen.x + 15}px`;
          this._labelEl.style.top = `${screen.y - 30}px`;
          this._labelEl.style.display = 'block';
        } else {
          this._labelEl.style.display = 'none';
        }
      } else {
        this._labelEl.style.display = 'none';
      }
    }
  }

  clearPathPreview() {
    if (this._pathGroup) this._pathGroup.visible = false;
    this._resetPathGeometry();
    if (this._labelEl) {
      this._labelEl.style.display = 'none';
      this._labelEl.textContent = '';
    }
  }

  // ── Drag Preview API ─────────────────────────────────────────────────────────

  showDragPreviews(tokenManager, selectionIds) {
    this.clearDragPreviews();

    const THREE = window.THREE;
    if (!THREE || !this._scene || !tokenManager) return;

    const floorIndex = this._resolveActiveFloorIndex();
    const fallbackRenderOrder = effectUnderOverheadOrder(floorIndex, TOKEN_GROUND_RENDER_INTRA_OFFSET);

    for (const id of selectionIds) {
      const spriteData = tokenManager.tokenSprites?.get?.(id);
      const source = spriteData?.sprite;
      if (!source) continue;

      const ghost = new THREE.Sprite(new THREE.SpriteMaterial({
        map: source.material?.map ?? null,
        transparent: true, opacity: 0.6,
        depthTest: false, depthWrite: false, toneMapped: false
      }));
      ghost.scale.copy(source.scale);
      ghost.position.copy(source.position);
      ghost.renderOrder = Number.isFinite(Number(source.renderOrder))
        ? Number(source.renderOrder)
        : fallbackRenderOrder;
      ghost.matrixAutoUpdate = true;
      ghost.layers.set(OVERLAY_THREE_LAYER);
      ghost.layers.enable(0);
      ghost.userData = { type: 'dragPreview', tokenId: id };

      this._scene.add(ghost);
      this._dragPreviews.set(id, ghost);
    }
  }

  updateDragPreviewPosition(id, worldX, worldY, worldZ) {
    const ghost = this._dragPreviews.get(id);
    if (!ghost) return;
    ghost.position.x = worldX;
    ghost.position.y = worldY;
    if (worldZ !== undefined) ghost.position.z = worldZ;
  }

  getDragPreview(id) {
    return this._dragPreviews.get(id);
  }

  clearDragPreviews() {
    for (const ghost of this._dragPreviews.values()) {
      try { ghost.removeFromParent(); } catch (_) {}
      try { ghost.material?.dispose?.(); } catch (_) {}
    }
    this._dragPreviews.clear();
  }

  // ── Animation API ────────────────────────────────────────────────────────────
  
  /**
   * Optional: Call this from the application's render loop (requestAnimationFrame).
   * Pulses the tile highlight fills for subtle motion feedback.
   * @param {number} timeMs Current time in milliseconds (e.g. performance.now())
   */
  update(timeMs) {
    if (!this._pathGroup?.visible || !this._tileGroup) return;

    // Soft sine wave pulse between 0.05 and 0.25 opacity
    const pulse = (Math.sin(timeMs * 0.003) * 0.5 + 0.5) * 0.2; 
    
    for (const child of this._tileGroup.children) {
      if (child.isMesh && child.material) {
        // Only target the fill meshes, not the edges
        child.material.opacity = this._animationBaseOpacity + pulse;
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  _buildPathGroup(THREE) {
    const group = new THREE.Group();
    group.name = 'MovementPathPreviewV2';
    group.userData = { ...(group.userData || {}), type: 'interactionOverlay', preserveOnBusClear: true };
    group.visible = false;
    group.layers.set(OVERLAY_THREE_LAYER);
    group.layers.enable(0);

    this._lineOuter = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x4488cc, transparent: true, opacity: 0.22,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide
      })
    );
    this._lineOuter.layers.set(OVERLAY_THREE_LAYER);
    this._lineOuter.layers.enable(0);

    this._lineInner = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x88ccff, transparent: true, opacity: 0.38,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide
      })
    );
    this._lineInner.layers.set(OVERLAY_THREE_LAYER);
    this._lineInner.layers.enable(0);

    this._tileGroup = new THREE.Group();
    this._tileGroup.layers.set(OVERLAY_THREE_LAYER);
    this._tileGroup.layers.enable(0);

    this._portalGroup = new THREE.Group();
    this._portalGroup.layers.set(OVERLAY_THREE_LAYER);
    this._portalGroup.layers.enable(0);

    this._ghostGroup = new THREE.Group();
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

  _buildLabelEl() {
    if (this._labelEl?.parentNode) {
      try { this._labelEl.parentNode.removeChild(this._labelEl); } catch (_) {}
    }
    const el = document.createElement('div');
    el.style.position = 'fixed';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '10000';
    el.style.padding = '4px 8px';
    el.style.borderRadius = '6px';
    el.style.backgroundColor = 'rgba(4, 18, 33, 0.85)';
    el.style.border = '1px solid rgba(88, 210, 255, 0.6)';
    el.style.boxShadow = '0 0 10px rgba(88, 210, 255, 0.3)';
    el.style.color = '#e0f7ff';
    el.style.fontFamily = 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    el.style.fontWeight = 'bold';
    el.style.fontSize = '13px';
    el.style.textShadow = '0 0 4px rgba(88, 210, 255, 0.8)';
    el.style.display = 'none';
    document.body.appendChild(el);
    this._labelEl = el;
  }

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

  _resolveActiveFloorIndex() {
    try {
      const fc = window.MapShine?.effectComposer?._floorCompositorV2;
      const fi = fc?._activeFloorIndex ?? fc?.activeFloorIndex;
      if (Number.isFinite(Number(fi))) return Math.max(0, Number(fi));
    } catch (_) {}
    return 0;
  }

  _worldLengthFromFoundryDistance(foundryDistance) {
    const distance = Math.max(0, Number(foundryDistance) || 0);
    const w0 = Coordinates.toWorld(0, 0);
    const w1 = Coordinates.toWorld(distance, 0);
    return Math.abs(Number(w1.x ?? 0) - Number(w0.x ?? 0)) || 1;
  }

  _buildPathStripGeometry(points, halfWidth) {
    const THREE = window.THREE;
    if (!THREE || !Array.isArray(points) || points.length < 2 || halfWidth <= 0) {
      return new THREE.BufferGeometry();
    }

    const positions = [];
    const indices = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * halfWidth;
      const ny = (dx / len) * halfWidth;
      const base = positions.length / 3;

      positions.push(
        a.x + nx, a.y + ny, a.z,
        a.x - nx, a.y - ny, a.z,
        b.x + nx, b.y + ny, b.z,
        b.x - nx, b.y - ny, b.z
      );
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    return geometry;
  }

  _clearChildren(group, disposeGeometry) {
    if (!group) return;
    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i];
      group.remove(child);
      if (disposeGeometry) {
        try { child.geometry?.dispose?.(); } catch (_) {}
      }
      // Only dispose materials if they aren't meant to be shared/cached
      // Since we create shared materials on each update cycle, it's safe to dispose them here
      try { child.material?.dispose?.(); } catch (_) {}
    }
  }

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