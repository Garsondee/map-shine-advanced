/**
 * @fileoverview Interaction manager - handles selection, dragging, and deletion of objects
 * Replaces Foundry's canvas interaction layer for THREE.js
 * @module scene/interaction-manager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

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
   */
  constructor(canvasElement, sceneComposer, tokenManager, tileManager, wallManager) {
    this.canvasElement = canvasElement;
    this.sceneComposer = sceneComposer;
    this.tokenManager = tokenManager;
    this.tileManager = tileManager;
    this.wallManager = wallManager;

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
      start: new THREE.Vector3(),
      current: new THREE.Vector3(),
      mesh: null,
      border: null
    };
    
    // Create drag select visuals
    this.createSelectionBox();
    
    /** @type {string|null} ID of currently hovered token */
    this.hoveredTokenId = null;
    /** @type {string|null} ID of currently hovered wall */
    this.hoveredWallId = null;
    /** @type {string|null} ID of currently hovered overhead tile */
    this.hoveredOverheadTileId = null;

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
    try {
        // Get mouse position in NDC
        this.updateMouseCoords(event);
        this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);

        // 1. Check Walls
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
   * Handle pointer down (select / start drag)
   * @param {PointerEvent} event 
   */
  onPointerDown(event) {
    try {
        // Only handle left click for now
        if (event.button !== 0) return;

        // Get mouse position in NDC
        this.updateMouseCoords(event);

        // Raycast
        this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);
        
        // Collect interactive objects
        const tokenSprites = this.tokenManager.getAllTokenSprites();
        const wallGroup = this.wallManager.wallGroup;
        
        // 1. Check for Wall/Door Interactions first (usually on top or distinct)
        // We raycast against wallGroup recursively
        const wallIntersects = this.raycaster.intersectObject(wallGroup, true);
        
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

        // 2. Check Wall Drawing (If on WallsLayer and didn't click an endpoint/door)
        const activeLayer = canvas.activeLayer?.name;
        const activeTool = game.activeTool;
        const isWallLayer = activeLayer && activeLayer.includes('WallsLayer');
        
        if (isWallLayer) {
          // Start Wall Drawing
          const worldPos = this.viewportToWorld(event.clientX, event.clientY, 0);
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
          this.wallDraw.type = activeTool;
          
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
        const isLightingLayer = activeLayer === 'LightingLayer';
        if (isLightingLayer) {
          // Only GM may place lights for now, matching Foundry's default behavior
          if (!game.user.isGM) {
            ui.notifications.warn('Only the GM can place lights in this mode.');
            return;
          }

          if (!canvas.lighting) return;

          const worldPos = this.viewportToWorld(event.clientX, event.clientY, 0);
          if (!worldPos) return;

          const foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);

          // Derive a reasonable default radius from scene dimensions. We use a
          // slightly larger radius than Foundry's tiny default so the pool of
          // light is clearly visible in the Three.js overlay.
          const distance = canvas.dimensions?.distance || 5;
          const defaultBright = distance * 4; // in scene distance units
          const defaultDim = distance * 8;

          const data = {
            x: foundryPos.x,
            y: foundryPos.y,
            config: {
              // Distances are in scene units; Foundry will convert to pixels internally
              bright: defaultBright,
              dim: defaultDim,
              luminosity: 0.5,
              attenuation: 0.5,
              rotation: 0,
              angle: 360,
              color: null, // Use Foundry default color
              darkness: { min: 0, max: 1 }
            }
          };

          try {
            canvas.scene.createEmbeddedDocuments('AmbientLight', [data]);
          } catch (e) {
            log.error('Failed to create AmbientLight from Three.js interaction', e);
          }

          // Do not start token selection when placing a light
          return;
        }

        // 3. Check Tokens
        const intersects = this.raycaster.intersectObjects(tokenSprites, false);

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
          this.dragState.mode = null; // Ensure no leftover mode from other interactions
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
    } catch (error) {
        log.error('Error in onPointerDown:', error);
    }
  }

  /**
   * Handle Door Click
   * @param {THREE.Group} doorGroup 
   * @param {PointerEvent} event 
   */
  handleDoorClick(doorGroup, event) {
      try {
          const wallId = doorGroup.userData.wallId;
          const wall = canvas.walls.get(wallId);
          if (!wall) {
              log.warn(`handleDoorClick: Wall ${wallId} not found in canvas.walls`);
              return;
          }

          // Determine whether the player can control the door
          if ( !game.user.can("WALL_DOORS") ) {
              log.warn("handleDoorClick: User cannot control doors");
              return;
          }
          if ( game.paused && !game.user.isGM ) {
            ui.notifications.warn("GAME.PausedWarning", {localize: true});
            return;
          }

          const ds = wall.document.ds;
          const states = CONST.WALL_DOOR_STATES;
          const sound = !(game.user.isGM && event.altKey);

          log.info(`handleDoorClick: Wall ${wallId}, Current State: ${ds}`);

          // Right click: Lock/Unlock (GM only)
          if (ds === states.LOCKED) {
              if (sound) AudioHelper.play({src: CONFIG.sounds.lock}); 
              log.info("handleDoorClick: Door is locked");
              return;
          }

          // Toggle Open/Closed
          const newState = ds === states.CLOSED ? states.OPEN : states.CLOSED;
          log.info(`handleDoorClick: Toggling to ${newState}`);
          
          wall.document.update({ds: newState}, {sound}).then(() => {
              log.info(`handleDoorClick: Update successful for ${wallId}`);
          }).catch(err => {
              log.error(`handleDoorClick: Update failed for ${wallId}`, err);
          });
      } catch(err) {
          log.error("Error in handleDoorClick", err);
      }
  }

  /**
   * Start dragging a wall endpoint
   * @param {THREE.Mesh} endpoint 
   * @param {PointerEvent} event 
   */
  startWallDrag(endpoint, event) {
      const wallId = endpoint.userData.wallId;
      const index = endpoint.userData.index; // 0 or 1
      const wall = canvas.walls.get(wallId);
      
      if (!wall) return;

      // Permission
      if (!game.user.isGM) return; // Usually only GM edits walls

      this.dragState.active = true;
      this.dragState.mode = 'wallEndpoint';
      this.dragState.wallId = wallId;
      this.dragState.endpointIndex = index;
      this.dragState.object = endpoint; // The mesh being dragged
      this.dragState.startPos.copy(endpoint.position);
      
      // Disable camera
      if (window.MapShine?.cameraController) {
        window.MapShine.cameraController.enabled = false;
      }
      
      log.info(`Started dragging wall ${wallId} endpoint ${index}`);
  }

  /**
   * Handle pointer move (drag)
   * @param {PointerEvent} event 
   */
  onPointerMove(event) {
    try {
        // Case 0: Wall Drawing
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
          // DEBUG: Log drag details
          log.debug(`Drag: Mouse(${event.clientX}, ${event.clientY}) -> World(${worldPos.x.toFixed(1)}, ${worldPos.y.toFixed(1)}, ${worldPos.z.toFixed(1)})`);

          // Calculate the new position
          // We want to maintain the offset from the grab point to the object center
          let x = worldPos.x + this.dragState.offset.x;
          let y = worldPos.y + this.dragState.offset.y;
          
          // Snap to grid logic if Shift is NOT held
          if (!event.shiftKey) {
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
        }
    } catch (error) {
        log.error('Error in onPointerMove:', error);
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
        const tileIntersects = this.raycaster.intersectObjects(overheadSprites, false);

        if (tileIntersects.length > 0) {
          const hit = tileIntersects[0];
          const sprite = hit.object;
          const tileId = sprite.userData.foundryTileId;

          // Only treat this as a "real" hit if the pointer is over an
          // opaque part of the roof sprite (alpha > 0.5). This prevents the
          // roof from vanishing when hovering transparent gutters/holes.
          if (this.tileManager.isWorldPointOpaque) {
            const data = this.tileManager.tileSprites.get(tileId);
            if (!data || !this.tileManager.isWorldPointOpaque(data, hit.point.x, hit.point.y)) {
              // Hit is on a transparent pixel; ignore this tile for hover.
              // Clear any prior hover-hidden tile if present.
              if (this.hoveredOverheadTileId && this.tileManager.setTileHoverHidden) {
                this.tileManager.setTileHoverHidden(this.hoveredOverheadTileId, false);
                this.hoveredOverheadTileId = null;
              }
              // Do not mark hitFound; allow tokens below to be hovered.
              // Effectively treat as "no tile hit".
              // Continue to the token hover logic below.
              // (We early-return from this tile branch.)
              //
              // NOTE: We don't "continue" the outer function; we just skip
              // setting hitFound here.
              //
              // So drop through to tokens.
            } else {
              if (this.hoveredOverheadTileId !== tileId) {
                // Restore previous hovered tile if any
                if (this.hoveredOverheadTileId && this.tileManager.setTileHoverHidden) {
                  this.tileManager.setTileHoverHidden(this.hoveredOverheadTileId, false);
                }

                this.hoveredOverheadTileId = tileId;
                if (this.tileManager.setTileHoverHidden) {
                  this.tileManager.setTileHoverHidden(tileId, true);
                }
              }

              hitFound = true;
            }
          }
        } else if (this.hoveredOverheadTileId && this.tileManager.setTileHoverHidden) {
          // No tile currently under cursor; restore any previously hidden tile
          this.tileManager.setTileHoverHidden(this.hoveredOverheadTileId, false);
          this.hoveredOverheadTileId = null;
        }
      }
    }

    // If we hit an overhead tile, don't hover tokens through it
    if (hitFound) return;

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
   * Handle pointer up (end drag)
   * @param {PointerEvent} event 
   */
  async onPointerUp(event) {
    try {
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
            let foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);
            
            // COLLISION CHECK: Ensure we don't drop through walls
            const token = tokenDoc.object;
            if (token) {
                const origin = token.center;
                // checkCollision returns PolygonVertex {x, y} or null
                // We use mode: 'closest' to get the first impact
                const collision = token.checkCollision(foundryPos, { mode: 'closest', type: 'move' });
                
                if (collision) {
                    // Calculate vector from Origin to Collision
                    const dx = collision.x - origin.x;
                    const dy = collision.y - origin.y;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    
                    // Back off slightly from the wall to find the "nearest complete grid space"
                    // If we are right at the wall, we want the cell *before* the wall.
                    if (dist > 0) {
                         const backDist = 2; // px
                         const scale = Math.max(0, dist - backDist) / dist;
                         
                         const backX = origin.x + dx * scale;
                         const backY = origin.y + dy * scale;
                         
                         // Snap to Grid Center
                         const snapped = canvas.grid.getSnappedPoint({x: backX, y: backY}, {
                             mode: CONST.GRID_SNAPPING_MODES.CENTER
                         });
                         
                         log.debug(`Collision detected at (${collision.x.toFixed(1)}, ${collision.y.toFixed(1)}). Snapped back to (${snapped.x}, ${snapped.y})`);
                         
                         // Update target position
                         foundryPos = snapped;
                    }
                }
            }

            // Adjust for center vs top-left
            const width = tokenDoc.width * canvas.grid.size;
            const height = tokenDoc.height * canvas.grid.size;
            
            const finalX = foundryPos.x - width / 2;
            const finalY = foundryPos.y - height / 2;
            
            log.debug(`Token ${tokenDoc.name} (${id}): World(${worldPos.x.toFixed(1)}, ${worldPos.y.toFixed(1)}) -> FoundryCenter(${foundryPos.x.toFixed(1)}, ${foundryPos.y.toFixed(1)}) -> TopLeft(${finalX.toFixed(1)}, ${finalY.toFixed(1)})`);

            log.debug(`Final position calculation: World(${worldPos.x.toFixed(1)}, ${worldPos.y.toFixed(1)}) -> FoundryCenter(${foundryPos.x.toFixed(1)}, ${foundryPos.y.toFixed(1)}) -> TopLeft(${finalX.toFixed(1)}, ${finalY.toFixed(1)})`);

            updates.push({
              _id: id,
              x: finalX,
              y: finalY
            });

            // REMOVED OPTIMISTIC UPDATE: Rely on updateToken hook to trigger animation
            // This ensures visual state matches server state and prevents animation lag/skipping
            /*
            if (data.sprite) {
              data.sprite.position.copy(preview.position);
            }
            */
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
    // Delete key
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (this.selection.size > 0) {
        // Filter for tokens and walls
        const tokensToDelete = [];
        const wallsToDelete = [];

        for (const id of this.selection) {
          // Check Token
          const sprite = this.tokenManager.getTokenSprite(id);
          if (sprite) {
            tokensToDelete.push(sprite.userData.tokenDoc.id);
            continue;
          }
          
          // Check Wall
          if (this.wallManager.walls.has(id)) {
              wallsToDelete.push(id);
          }
        }
        
        if (tokensToDelete.length > 0) {
          log.info(`Deleting ${tokensToDelete.length} tokens`);
          await canvas.scene.deleteEmbeddedDocuments('Token', tokensToDelete);
        }

        if (wallsToDelete.length > 0) {
          log.info(`Deleting ${wallsToDelete.length} walls`);
          await canvas.scene.deleteEmbeddedDocuments('Wall', wallsToDelete);
        }
        
        this.clearSelection();
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
      // Check Token
      if (this.tokenManager.tokenSprites.has(id)) {
          this.tokenManager.setTokenSelection(id, false);
      }
      // Check Wall
      if (this.wallManager.walls.has(id)) {
          this.wallManager.select(id, false);
      }
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
