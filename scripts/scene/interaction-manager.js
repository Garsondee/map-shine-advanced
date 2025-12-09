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
    
    // Create drag select visuals
    this.createSelectionBox();
    this.createLightPreview();
    
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
      onKeyDown: this.onKeyDown.bind(this),
      onDoubleClick: this.onDoubleClick.bind(this)
    };

    log.debug('InteractionManager created');
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
    window.addEventListener('keydown', this.boundHandlers.onKeyDown);

    const rect = this.canvasElement.getBoundingClientRect();
    log.info('InteractionManager initialized (Three.js token interaction enabled)', {
      canvasId: this.canvasElement.id,
      width: rect.width,
      height: rect.height
    });
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
   * Create light placement preview visuals
   * @private
   */
  createLightPreview() {
    const THREE = window.THREE;

    this.lightPlacement.previewGroup = new THREE.Group();
    this.lightPlacement.previewGroup.name = 'LightPlacementPreview';
    this.lightPlacement.previewGroup.visible = false;
    // Z-index just above ground/floor but below tokens
    this.lightPlacement.previewGroup.position.z = 5;

    // Fill (Shader-based "Light Look")
    const geometry = new THREE.CircleGeometry(1, 64);
    
    // Shader adapted from LightMesh.js but for Unit Circle (Radius 1)
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(1.0, 1.0, 0.8) }, // Warm light default
        uRatio: { value: 0.5 } // bright/dim ratio
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

        void main() {
          float dist = length(vLocalPos);
          if (dist >= 1.0) discard;

          // Falloff Logic
          float dOuter = dist;
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
   * Create drag previews for selected tokens
   * @private
   */
  createDragPreviews() {
    this.dragState.previews.clear();
    
    for (const id of this.selection) {
      // Check Token
      const tokenData = this.tokenManager.tokenSprites.get(id);
      if (tokenData && tokenData.sprite) {
        const original = tokenData.sprite;
        const preview = original.clone();
        
        if (original.material) {
          preview.material = original.material.clone();
          preview.material.opacity = 0.5;
          preview.material.transparent = true;
        }
        
        if (this.sceneComposer.scene) {
          this.sceneComposer.scene.add(preview);
        }
        
        this.dragState.previews.set(id, preview);
        continue;
      }

      // Check Light
      if (this.lightIconManager && this.lightIconManager.lights.has(id)) {
          const original = this.lightIconManager.lights.get(id);
          const preview = original.clone();

          if (original.material) {
              preview.material = original.material.clone();
              preview.material.opacity = 0.5;
              preview.material.transparent = true;
          }

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
        // Get mouse position in NDC
        this.updateMouseCoords(event);
        this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);

        // 1. Check Walls
        // ... existing wall code ...

        // 1.5 Check Lights (Lighting Layer)
        if (canvas.activeLayer?.name === 'LightingLayer' && this.lightIconManager) {
            const lightIcons = Array.from(this.lightIconManager.lights.values());
            const intersects = this.raycaster.intersectObjects(lightIcons, false);
            if (intersects.length > 0) {
                const hit = intersects[0];
                const sprite = hit.object;
                const lightId = sprite.userData.lightId;
                const light = canvas.lighting.get(lightId);
                
                if (light && light.document.testUserPermission(game.user, "LIMITED")) {
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
      
      if (window.MapShine?.cameraController) {
        window.MapShine.cameraController.enabled = false;
      }
  }

  /**
   * Handle pointer down (select / start drag)
   * @param {PointerEvent} event 
   */
  onPointerDown(event) {
    try {
        // DEBUG: Raw console log to verify handler execution independent of
        // Map Shine's logging utility or input routing.
        console.log('Map Shine Advanced | InteractionManager | RAW onPointerDown', {
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
          target: event.target
        });

        if (event.button !== 0 && event.button !== 2) return;

        // Respect the current input mode: only handle clicks when the
        // InputRouter says Three.js should receive input. This prevents
        // conflicts when PIXI tools are active, but we *override* this
        // for the Tokens layer so gameplay clicks are never blocked.
        const mapShine = window.MapShine || window.mapShine;
        const inputRouter = mapShine?.inputRouter;
        const activeLayerName = canvas.activeLayer?.name;
        const activeTool = game.activeTool;
        
        // DEBUG: Log InputRouter state to diagnose why clicks aren't being processed
        log.info('onPointerDown InputRouter check', {
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
          if (shouldOverrideRouter) {
            log.info('onPointerDown overriding InputRouter block on Tokens layer; forcing THREE mode');
            try {
              inputRouter.forceThree?.('InteractionManager token click');
            } catch (e) {
              log.warn('Failed to force THREE mode on token click', e);
            }
            // Fall through and continue handling the click.
          } else {
            log.info('onPointerDown BLOCKED by InputRouter (PIXI mode active)');
            return;
          }
        }

        log.info('onPointerDown received', {
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
          activeLayer: canvas.activeLayer?.name,
          activeTool: game.activeTool
        });

        this.updateMouseCoords(event);
        this.raycaster.setFromCamera(this.mouse, this.sceneComposer.camera);

        log.info('onPointerDown mouse NDC', {
          ndcX: this.mouse.x,
          ndcY: this.mouse.y
        });
        
        const tokenSprites = this.tokenManager.getAllTokenSprites();
        log.info('onPointerDown tokenSprites count', { count: tokenSprites.length });
        const wallGroup = this.wallManager.wallGroup;

        // Handle Right Click (Potential HUD or Door Lock/Unlock)
        if (event.button === 2) {
            const wallIntersects = this.raycaster.intersectObject(wallGroup, true);
            log.info('onPointerDown right-click wallIntersects', { count: wallIntersects.length });
            if (wallIntersects.length > 0) {
                const hit = wallIntersects[0];
                let object = hit.object;
                
                // Traverse up to find doorControl userData
                while (object && object !== wallGroup) {
                    if (object.userData && object.userData.type === 'doorControl') {
                        this.handleDoorRightClick(object, event);
                        event.preventDefault();
                        return;
                    }
                    object = object.parent;
                }
            }

            // Raycast against tokens for HUD
            const intersects = this.raycaster.intersectObjects(tokenSprites, false);
            log.info('onPointerDown right-click tokenIntersects', { count: intersects.length });
            if (intersects.length > 0) {
                const hit = intersects[0];
                const sprite = hit.object;
                const tokenDoc = sprite.userData.tokenDoc;
                
                log.debug(`Right click down on token: ${tokenDoc.name} (${tokenDoc.id})`);

                // Only if we have permission (isOwner usually required for HUD)
                // But Foundry allows right clicking to see non-interactive HUD parts? 
                // Usually checks token.isOwner for full HUD.
                // We'll initiate the click state and let HUD bind check permissions or we check here.
                // Foundry: _canHUD -> isOwner.
                
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
        const isTokensLayer = activeLayer === 'TokensLayer';
        const isWallLayer = activeLayer && activeLayer.includes('WallsLayer');
        const shouldCheckWalls = !isTokensLayer && (isWallLayer || game.user.isGM);
        const wallIntersects = shouldCheckWalls ? this.raycaster.intersectObject(wallGroup, true) : [];

        log.info('onPointerDown wallIntersects', {
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

        const currentTool = game.activeTool;
        
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
        const isLightingLayer = activeLayer === 'LightingLayer';
        if (isLightingLayer) {
          // 2.5a Check for Existing Lights (Select/Drag)
          // Prioritize interacting with existing lights over placing new ones
          if (this.lightIconManager) {
             const lightIcons = Array.from(this.lightIconManager.lights.values());
             const intersects = this.raycaster.intersectObjects(lightIcons, false);
             
             if (intersects.length > 0) {
                 const hit = intersects[0];
                 const sprite = hit.object;
                 const lightId = sprite.userData.lightId;
                 const lightDoc = canvas.lighting.get(lightId)?.document;

                 if (lightDoc && lightDoc.canUserModify(game.user, "update")) {
                     // Handle Selection
                     const isSelected = this.selection.has(lightId);
                     if (event.shiftKey) {
                         if (!isSelected) this.selectObject(sprite);
                     } else {
                         if (!isSelected) {
                             this.clearSelection();
                             this.selectObject(sprite);
                         }
                     }

                     // Start Drag
                     this.startDrag(sprite, hit.point);
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

          if (!canvas.lighting) return;

          const worldPos = this.viewportToWorld(event.clientX, event.clientY, 0);
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

          // Initialize Drag State
          this.lightPlacement.active = true;
          this.lightPlacement.start.set(snappedWorld.x, snappedWorld.y, 0);
          this.lightPlacement.current.set(snappedWorld.x, snappedWorld.y, 0);
          
          // Initialize Visuals
          this.lightPlacement.previewGroup.position.copy(this.lightPlacement.start);
          this.lightPlacement.previewGroup.position.z = 5; // Keep above ground
          this.lightPlacement.previewGroup.scale.set(0.1, 0.1, 1); // Tiny start
          this.lightPlacement.previewGroup.visible = true;

          // Disable camera controls
          if (window.MapShine?.cameraController) {
             window.MapShine.cameraController.enabled = false;
          }

          // Do not start token selection when placing a light
          return;
        }

        const intersects = this.raycaster.intersectObjects(tokenSprites, false);

        log.info('onPointerDown left-click tokenIntersects', { count: intersects.length });

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
      if (!spriteData || !spriteData.sprite) return;
      
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
   * Handle Door Right Click (Lock/Unlock - GM only)
   * @param {THREE.Group} doorGroup 
   * @param {PointerEvent} event 
   */
  handleDoorRightClick(doorGroup, event) {
      try {
          // Only GM can lock/unlock doors
          if (!game.user.isGM) {
              log.debug("handleDoorRightClick: Only GM can lock/unlock doors");
              return;
          }

          const wallId = doorGroup.userData.wallId;
          const wall = canvas.walls.get(wallId);
          if (!wall) {
              log.warn(`handleDoorRightClick: Wall ${wallId} not found in canvas.walls`);
              return;
          }

          const ds = wall.document.ds;
          const states = CONST.WALL_DOOR_STATES;

          // Cannot lock an open door
          if (ds === states.OPEN) {
              log.debug("handleDoorRightClick: Cannot lock an open door");
              return;
          }

          // Toggle between LOCKED and CLOSED
          const newState = ds === states.LOCKED ? states.CLOSED : states.LOCKED;
          const sound = !(game.user.isGM && event.altKey);

          log.info(`handleDoorRightClick: Wall ${wallId}, toggling ${ds} -> ${newState}`);

          wall.document.update({ds: newState}, {sound}).then(() => {
              log.info(`handleDoorRightClick: Update successful for ${wallId}`);
          }).catch(err => {
              log.error(`handleDoorRightClick: Update failed for ${wallId}`, err);
          });
      } catch(err) {
          log.error("Error in handleDoorRightClick", err);
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

        // Case 0.25: Light Placement Drag
        if (this.lightPlacement.active) {
             this.updateMouseCoords(event);
             const worldPos = this.viewportToWorld(event.clientX, event.clientY, 0);
             if (worldPos) {
                 // Update current position (snap not strictly required for radius, but usually destination is free)
                 // Foundry's light drag usually doesn't snap destination unless Shift?
                 // Actually code says: "Snap the origin... Update the light radius... const radius = Math.hypot(destination.x - origin.x, ...)"
                 // Destination is raw event data usually.
                 this.lightPlacement.current.set(worldPos.x, worldPos.y, 0);
                 
                 // Calculate radius in World Units
                 const dx = this.lightPlacement.current.x - this.lightPlacement.start.x;
                 const dy = this.lightPlacement.current.y - this.lightPlacement.start.y;
                 const radius = Math.sqrt(dx*dx + dy*dy);
                 
                 // Update Visuals
                 // Circle geometry is radius 1, so we scale by radius
                 // Minimum visibility
                 const scale = Math.max(radius, 0.1);
                 this.lightPlacement.previewGroup.scale.set(scale, scale, 1);
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
          const isLightDrag = this.lightIconManager && this.lightIconManager.lights && this.lightIconManager.lights.has(this.dragState.leaderId);
          
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
   * Handle pointer up (end drag)
   * @param {PointerEvent} event 
   */
  async onPointerUp(event) {
    try {
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
                const distance = canvas.dimensions?.distance || 5;
                dim = distance * 8; // Default dim
                bright = distance * 4; // Default bright
            } else {
                // Convert Pixel Radius to Distance Units
                // dim = radius * (distance / size)
                const conversion = canvas.dimensions.distance / canvas.dimensions.size;
                dim = radiusPixels * conversion;
                bright = dim / 2;
            }

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
          // Commit change to Foundry for ALL selected objects
          const tokenUpdates = [];
          const lightUpdates = [];
          
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
                    const collision = token.checkCollision(foundryPos, { mode: 'closest', type: 'move' });
                    if (collision) {
                        const dx = collision.x - origin.x;
                        const dy = collision.y - origin.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        if (dist > 0) {
                             const backDist = 2;
                             const scale = Math.max(0, dist - backDist) / dist;
                             const backX = origin.x + dx * scale;
                             const backY = origin.y + dy * scale;
                             const snapped = canvas.grid.getSnappedPoint({x: backX, y: backY}, {
                                 mode: CONST.GRID_SNAPPING_MODES.CENTER
                             });
                             foundryPos = snapped;
                        }
                    }
                }

                // Adjust for center vs top-left
                const width = tokenDoc.width * canvas.grid.size;
                const height = tokenDoc.height * canvas.grid.size;
                const finalX = foundryPos.x - width / 2;
                const finalY = foundryPos.y - height / 2;
                
                tokenUpdates.push({ _id: id, x: finalX, y: finalY });
                continue;
            }

            // Check Light
            if (this.lightIconManager && this.lightIconManager.lights.has(id)) {
                const worldPos = preview.position;
                const foundryPos = Coordinates.toFoundry(worldPos.x, worldPos.y);
                
                lightUpdates.push({ _id: id, x: foundryPos.x, y: foundryPos.y });
                continue;
            }
          }
          
          let anyUpdates = false;

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
          this.destroyDragPreviews();
          
          // If updates failed, we might want to revert, but for now we just clear state.
          // The previous code had revert logic, but it's complex with mixed types.
          // We'll rely on the fact that without optimistic updates, they just snap back if not updated.

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
    let id;
    if (sprite.userData.tokenDoc) {
        id = sprite.userData.tokenDoc.id;
        this.tokenManager.setTokenSelection(id, true);
    } else if (sprite.userData.lightId) {
        id = sprite.userData.lightId;
        // TODO: Visual selection for lights
        if (sprite.material) sprite.material.color.set(0x8888ff); // Tint blue
    } else {
        return;
    }
    this.selection.add(id);
    
    // Force vision update to ensure fog is correct
    if (window.MapShine && window.MapShine.visionManager) {
      window.MapShine.visionManager.needsUpdate = true;
    }
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
      // Check Light
      if (this.lightIconManager && this.lightIconManager.lights.has(id)) {
          const sprite = this.lightIconManager.lights.get(id);
          if (sprite && sprite.material) sprite.material.color.set(0xffffff); // Reset tint
      }
      // Check Wall
      if (this.wallManager.walls.has(id)) {
          this.wallManager.select(id, false);
      }
    }
    this.selection.clear();
    
    // Force vision update to ensure fog is correct (bypass mode)
    if (window.MapShine && window.MapShine.visionManager) {
      window.MapShine.visionManager.needsUpdate = true;
    }
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
