/**
 * @fileoverview Interaction manager - handles selection, dragging, and deletion of objects
 * Replaces Foundry's canvas interaction layer for THREE.js
 * @module scene/interaction-manager
 */

import { createLogger } from '../core/log.js';

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
   */
  constructor(canvasElement, sceneComposer, tokenManager, tileManager) {
    this.canvasElement = canvasElement;
    this.sceneComposer = sceneComposer;
    this.tokenManager = tokenManager;
    this.tileManager = tileManager;

    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    
    /** @type {Set<string>} Set of selected object IDs (e.g. "Token.abc", "Tile.xyz") */
    this.selection = new Set();
    
    // Drag state
    this.dragState = {
      active: false,
      leaderId: null, // ID of the token we clicked on
      object: null, // The PREVIEW sprite being dragged
      startPos: new THREE.Vector3(), // Initial position of the dragged object
      offset: new THREE.Vector3(), // Offset from center
      hasMoved: false,
      initialPositions: new Map(), // Map<string, THREE.Vector3> - Initial positions of all selected objects
      previews: new Map() // Map<string, THREE.Sprite> - Drag previews
    };

    // Drag Select state
    this.dragSelect = {
      active: false,
      start: new THREE.Vector3(),
      current: new THREE.Vector3(),
      mesh: null,
      border: null
    };
    
    // Create drag select visuals
    this.createSelectionBox();
    
    /** @type {string|null} ID of currently hovered token */
    this.hoveredTokenId = null;

    this.boundHandlers = {
      onPointerDown: this.onPointerDown.bind(this),
      onPointerMove: this.onPointerMove.bind(this),
      onPointerUp: this.onPointerUp.bind(this),
      onKeyDown: this.onKeyDown.bind(this),
      onDoubleClick: this.onDoubleClick.bind(this)
    };

    log.debug('InteractionManager created');
  }

  /**
   * Initialize event listeners
   */
  initialize() {
    this.canvasElement.addEventListener('pointerdown', this.boundHandlers.onPointerDown);
    window.addEventListener('pointermove', this.boundHandlers.onPointerMove);
    window.addEventListener('pointerup', this.boundHandlers.onPointerUp);
    window.addEventListener('keydown', this.boundHandlers.onKeyDown);
    this.canvasElement.addEventListener('dblclick', this.boundHandlers.onDoubleClick);
    
    log.info('InteractionManager initialized');
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
    this.dragSelect.border.renderOrder = 10000;
    
    // Add to scene via SceneComposer
    if (this.sceneComposer.scene) {
      this.sceneComposer.scene.add(this.dragSelect.mesh);
      this.sceneComposer.scene.add(this.dragSelect.border);
    }
  }

  /**
   * Create drag previews for selected tokens
   * @private
   */
  createDragPreviews() {
    this.dragState.previews.clear();
    
    for (const id of this.selection) {
      const data = this.tokenManager.tokenSprites.get(id);
      if (!data || !data.sprite) continue;
      
      const original = data.sprite;
      const preview = original.clone();
      
      // Clone material to modify opacity without affecting original
      if (original.material) {
        preview.material = original.material.clone();
        preview.material.opacity = 0.5;
        preview.material.transparent = true;
      }
      
      // Add to scene
      if (this.sceneComposer.scene) {
        this.sceneComposer.scene.add(preview);
      }
      
      this.dragState.previews.set(id, preview);
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
    // Get mouse position in NDC
    this.updateMouseCoords(event);
    this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);

    const interactables = this.tokenManager.getAllTokenSprites();
    const intersects = this.raycaster.intersectObjects(interactables, false);

    if (intersects.length > 0) {
      const hit = intersects[0];
      const sprite = hit.object;
      const tokenDoc = sprite.userData.tokenDoc;

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
  }

  /**
   * Handle pointer down (select / start drag)
   * @param {PointerEvent} event 
   */
  onPointerDown(event) {
    // Only handle left click for now
    if (event.button !== 0) return;

    // Get mouse position in NDC
    this.updateMouseCoords(event);

    // Raycast
    this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);
    
    // Collect interactive objects (Tokens for now)
    const interactables = [
      ...this.tokenManager.getAllTokenSprites(),
      // ...this.tileManager.getAllTileSprites() // TODO: Add tiles later
    ];

    const intersects = this.raycaster.intersectObjects(interactables, false);

    if (intersects.length > 0) {
      // Hit something
      const hit = intersects[0];
      const sprite = hit.object;
      const tokenDoc = sprite.userData.tokenDoc;
      
      // Permission check
      if (!tokenDoc.canUserModify(game.user, "update")) {
        ui.notifications.warn("You do not have permission to control this Token.");
        return;
      }

      // Handle Selection
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
      this.dragState.active = true;
      this.dragState.leaderId = tokenDoc.id;
      
      // Create Previews
      this.createDragPreviews();
      
      // Set leader object to the PREVIEW of the clicked token
      const leaderPreview = this.dragState.previews.get(tokenDoc.id);
      if (!leaderPreview) {
        log.error("Failed to create leader preview");
        this.dragState.active = false;
        return;
      }
      
      this.dragState.object = leaderPreview;
      this.dragState.startPos.copy(leaderPreview.position);
      this.dragState.offset.subVectors(leaderPreview.position, hit.point); // Offset from hit point to center
      this.dragState.hasMoved = false;
      
      // Capture initial positions of PREVIEWS
      this.dragState.initialPositions.clear();
      for (const [id, preview] of this.dragState.previews) {
        this.dragState.initialPositions.set(id, preview.position.clone());
      }
      
      // Disable camera controls if dragging
      if (window.MapShine?.cameraController) {
        window.MapShine.cameraController.enabled = false;
      }

    } else {
      // Clicked empty space - deselect all unless shift held
      if (!event.shiftKey) {
        this.clearSelection();
      }
      
      // Start Drag Select
      this.dragSelect.active = true;
      
      // Calculate start pos on ground/token plane (Z=10)
      const worldPos = this.viewportToWorld(event.clientX, event.clientY, 10);
      if (worldPos) {
        this.dragSelect.start.copy(worldPos);
        this.dragSelect.current.copy(worldPos);
        
        // Reset visuals
        this.dragSelect.mesh.position.copy(worldPos);
        this.dragSelect.mesh.scale.set(0.1, 0.1, 1);
        this.dragSelect.mesh.visible = true;
        
        this.dragSelect.border.position.copy(worldPos);
        this.dragSelect.border.scale.set(0.1, 0.1, 1);
        this.dragSelect.border.visible = true;
      }
    }
  }

  /**
   * Handle pointer move (drag)
   * @param {PointerEvent} event 
   */
  onPointerMove(event) {
    // Case 1: Drag Select
    if (this.dragSelect.active) {
      this.updateMouseCoords(event);
      
      // Calculate current pos on ground/token plane (Z=10)
      const worldPos = this.viewportToWorld(event.clientX, event.clientY, 10);
      if (worldPos) {
        this.dragSelect.current.copy(worldPos);
        
        // Update visuals
        const start = this.dragSelect.start;
        const current = this.dragSelect.current;
        
        const minX = Math.min(start.x, current.x);
        const maxX = Math.max(start.x, current.x);
        const minY = Math.min(start.y, current.y);
        const maxY = Math.max(start.y, current.y);
        
        const width = maxX - minX;
        const height = maxY - minY;
        const centerX = minX + width / 2;
        const centerY = minY + height / 2;
        
        // Update Mesh
        this.dragSelect.mesh.position.set(centerX, centerY, 10.1); // Slightly above tokens? No, usually overlay.
        // Tokens are at Z=10. Let's put this at Z=100 (overlay).
        this.dragSelect.mesh.position.z = 100; 
        this.dragSelect.mesh.scale.set(width, height, 1);
        
        // Update Border
        this.dragSelect.border.position.set(centerX, centerY, 100);
        this.dragSelect.border.scale.set(width, height, 1);
      }
      return;
    }

    // Case 2: Hover (if not dragging object)
    if (!this.dragState.active || !this.dragState.object) {
      this.handleHover(event);
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
      // Calculate the new position
      // We want to maintain the offset from the grab point to the object center
      let x = worldPos.x + this.dragState.offset.x;
      let y = worldPos.y + this.dragState.offset.y;
      
      // Snap to grid logic if Shift is NOT held
      if (!event.shiftKey) {
        const foundryPos = this.worldToFoundry(x, y);
        const snapped = this.snapToGrid(foundryPos.x, foundryPos.y);
        const snappedWorld = this.foundryToWorld(snapped.x, snapped.y);
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
   * Handle pointer up (end drag)
   * @param {PointerEvent} event 
   */
  async onPointerUp(event) {
    // Handle Drag Select
    if (this.dragSelect.active) {
      this.dragSelect.active = false;
      this.dragSelect.mesh.visible = false;
      this.dragSelect.border.visible = false;
      
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

    // Re-enable camera controls
    if (window.MapShine?.cameraController) {
      window.MapShine.cameraController.enabled = true;
    }

    if (this.dragState.hasMoved && this.dragState.object) {
      // Commit change to Foundry for ALL selected tokens
      const updates = [];
      
      // Use selection set
      for (const id of this.selection) {
        const data = this.tokenManager.tokenSprites.get(id);
        const preview = this.dragState.previews.get(id);
        
        if (!data || !preview) continue;
        
        const tokenDoc = data.tokenDoc;
        
        // Calculate final position from PREVIEW position
        const worldPos = preview.position;
        const foundryPos = this.worldToFoundry(worldPos.x, worldPos.y);
        
        // Adjust for center vs top-left
        const width = tokenDoc.width * canvas.grid.size;
        const height = tokenDoc.height * canvas.grid.size;
        
        const finalX = foundryPos.x - width / 2;
        const finalY = foundryPos.y - height / 2;
        
        log.debug(`Token ${tokenDoc.name} (${id}): World(${worldPos.x.toFixed(1)}, ${worldPos.y.toFixed(1)}) -> FoundryCenter(${foundryPos.x.toFixed(1)}, ${foundryPos.y.toFixed(1)}) -> TopLeft(${finalX.toFixed(1)}, ${finalY.toFixed(1)})`);

        updates.push({
          _id: id,
          x: finalX,
          y: finalY
        });

        // OPTIMISTIC UPDATE: Move real sprite to final position immediately
        // This prevents the "jump back" visual glitch while waiting for the hook
        if (data.sprite) {
          data.sprite.position.copy(preview.position);
        }
      }
      
      if (updates.length > 0) {
        log.info(`Updating ${updates.length} tokens`, updates);
        
        // Reset drag state immediately
        this.dragState.active = false;
        this.dragState.object = null;
        this.destroyDragPreviews();
        
        try {
          // CRITICAL: animate: true (default) to trigger smooth transition from old pos to new pos
          // We removed animate: false here.
          await canvas.scene.updateEmbeddedDocuments('Token', updates);
          log.debug(`Tokens updated successfully`);
        } catch (err) {
          log.error('Failed to update token positions', err);
          // Revert sprite positions if update failed
          // We need to restore from drag select start or initial positions?
          // initialPositions map has the start coords.
          for (const [id, initialPos] of this.dragState.initialPositions) {
             const data = this.tokenManager.tokenSprites.get(id);
             if (data && data.sprite) {
               data.sprite.position.copy(initialPos);
             }
          }
        }
      } else {
        this.dragState.active = false;
        this.dragState.object = null;
        this.destroyDragPreviews();
      }
    } else {
        this.dragState.active = false;
        this.dragState.object = null;
        this.destroyDragPreviews();
    }
  }

  /**
   * Handle key down (delete)
   * @param {KeyboardEvent} event 
   */
  async onKeyDown(event) {
    // Delete key
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selection.size > 0) {
        // Filter for tokens
        const tokensToDelete = [];
        for (const id of this.selection) {
          const sprite = this.tokenManager.getTokenSprite(id);
          if (sprite) {
            tokensToDelete.push(sprite.userData.tokenDoc.id);
          }
        }
        
        if (tokensToDelete.length > 0) {
          log.info(`Deleting ${tokensToDelete.length} tokens`);
          await canvas.scene.deleteEmbeddedDocuments('Token', tokensToDelete);
          this.clearSelection();
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
    const rect = this.canvasElement.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    
    const THREE = window.THREE;
    const camera = this.sceneComposer.camera;
    
    if (!camera) return null;

    // Create ray from camera
    // unproject(ndcX, ndcY, 0.5) gives a point inside the frustum
    const vector = new THREE.Vector3(ndcX, ndcY, 0.5);
    vector.unproject(camera);
    
    // Calculate direction from camera to unprojected point
    const dir = vector.sub(camera.position).normalize();
    
    // Ray: P = Origin + t * Direction
    // We want to find t where P.z = targetZ
    // Origin.z + t * Direction.z = targetZ
    // t = (targetZ - Origin.z) / Direction.z
    
    if (Math.abs(dir.z) < 0.0001) {
      // Ray is parallel to plane
      return null;
    }
    
    const t = (targetZ - camera.position.z) / dir.z;
    
    // If t < 0, intersection is behind camera
    if (t < 0) return null;
    
    // Calculate intersection point
    const pos = camera.position.clone().add(dir.multiplyScalar(t));
    
    return pos;
  }

  /**
   * Convert World (THREE) to Foundry (Pixels, Top-Left 0,0)
   * @param {number} wx 
   * @param {number} wy 
   * @returns {{x: number, y: number}}
   */
  worldToFoundry(wx, wy) {
    // Foundry X = World X
    // Foundry Y = SceneHeight - World Y
    const sceneHeight = canvas.dimensions.height;
    return {
      x: wx,
      y: sceneHeight - wy
    };
  }

  /**
   * Convert Foundry to World
   * @param {number} fx 
   * @param {number} fy 
   * @returns {{x: number, y: number}}
   */
  foundryToWorld(fx, fy) {
    const sceneHeight = canvas.dimensions.height;
    return {
      x: fx,
      y: sceneHeight - fy
    };
  }

  /**
   * Snap point to grid
   * @param {number} x 
   * @param {number} y 
   * @returns {{x: number, y: number}}
   */
  snapToGrid(x, y) {
    if (!canvas.grid) return { x, y };
    
    // Use Foundry's native grid snapping
    // CONST.GRID_SNAPPING_MODES.CENTER = 16? No, use CENTER or vertex
    // For Tokens, we usually want CENTER of cell if it's size 1
    
    // Use getSnappedPoint
    return canvas.grid.getSnappedPoint({ x, y }, {
      mode: CONST.GRID_SNAPPING_MODES.CENTER
    });
  }

  /**
   * Select an object
   * @param {THREE.Sprite} sprite 
   */
  selectObject(sprite) {
    const id = sprite.userData.tokenDoc.id;
    this.selection.add(id);
    
    // Update Visuals
    this.tokenManager.setTokenSelection(id, true);
  }

  /**
   * Clear selection
   */
  clearSelection() {
    for (const id of this.selection) {
      this.tokenManager.setTokenSelection(id, false);
    }
    this.selection.clear();
  }

  /**
   * Dispose
   */
  dispose() {
    this.canvasElement.removeEventListener('pointerdown', this.boundHandlers.onPointerDown);
    window.removeEventListener('pointermove', this.boundHandlers.onPointerMove);
    window.removeEventListener('pointerup', this.boundHandlers.onPointerUp);
    window.removeEventListener('keydown', this.boundHandlers.onKeyDown);
    
    this.clearSelection();
    log.info('InteractionManager disposed');
  }
}
