/**
 * @fileoverview Drop handler - intercepts drag-and-drop events to create Foundry documents
 * Replaces PIXI canvas interaction for token/tile placement
 * @module foundry/drop-handler
 */

import { createLogger } from '../core/log.js';

const log = createLogger('DropHandler');

/**
 * DropHandler - Manages drag-and-drop interactions on the THREE.js canvas
 * Creates Foundry token/tile documents directly, bypassing PIXI
 */
export class DropHandler {
  /**
   * @param {HTMLElement} canvasElement - THREE.js canvas element
   * @param {SceneComposer} sceneComposer - Scene composer for coordinate conversion
   */
  constructor(canvasElement, sceneComposer) {
    this.canvasElement = canvasElement;
    this.sceneComposer = sceneComposer;
    this.boundHandlers = {
      dragover: this.onDragOver.bind(this),
      drop: this.onDrop.bind(this)
    };
    
    log.debug('DropHandler created');
  }

  /**
   * Initialize drop handler and attach event listeners
   * @public
   */
  initialize() {
    if (!this.canvasElement) {
      log.error('Cannot initialize DropHandler - no canvas element');
      return;
    }

    // Allow drops on canvas
    this.canvasElement.addEventListener('dragover', this.boundHandlers.dragover);
    this.canvasElement.addEventListener('drop', this.boundHandlers.drop);

    log.info('DropHandler initialized - listening for drops on THREE.js canvas');
  }

  /**
   * Handle dragover event (required to allow drops)
   * @param {DragEvent} event
   * @private
   */
  onDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  /**
   * Handle drop event
   * @param {DragEvent} event
   * @private
   */
  async onDrop(event) {
    event.preventDefault();
    event.stopPropagation();

    log.debug('Drop event received');

    // Get drop data
    let data;
    try {
      data = JSON.parse(event.dataTransfer.getData('text/plain'));
    } catch (e) {
      log.warn('Failed to parse drop data', e);
      return;
    }

    log.debug('Drop data:', data);

    // Get drop position relative to canvas
    const rect = this.canvasElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Convert viewport coordinates to canvas coordinates
    const canvasPos = this.viewportToCanvas(x, y);
    
    log.debug(`Drop position: viewport(${x}, ${y}) -> canvas(${canvasPos.x}, ${canvasPos.y})`);

    // Add position to data
    data.x = canvasPos.x;
    data.y = canvasPos.y;

    // Handle different drop types
    switch (data.type) {
      case 'Actor':
        await this.handleActorDrop(event, data);
        break;
      case 'Tile':
        await this.handleTileDrop(event, data);
        break;
      case 'JournalEntry':
      case 'JournalEntryPage':
        await this.handleNoteDrop(event, data);
        break;
      case 'PlaylistSound':
        await this.handleSoundDrop(event, data);
        break;
      default:
        log.warn(`Unsupported drop type: ${data.type}`);
    }
  }

  /**
   * Handle actor drop (create token)
   * Mimics TokenLayer._onDropActorData from Foundry source
   * @param {DragEvent} event
   * @param {object} data
   * @private
   */
  async handleActorDrop(event, data) {
    log.info('Handling actor drop');

    // Permission check
    if (!game.user.can('TOKEN_CREATE')) {
      ui.notifications.warn('You do not have permission to create new Tokens!');
      return;
    }

    // Validate drop position
    if (!canvas.dimensions.rect.contains(data.x, data.y)) {
      log.warn('Drop position outside canvas bounds');
      return false;
    }

    try {
      // Import the actor
      let actor = await Actor.implementation.fromDropData(data);
      
      if (!actor.isOwner) {
        ui.notifications.warn(`You do not have permission to create a new Token for the ${actor.name} Actor.`);
        return;
      }

      // If from compendium, create in world
      if (actor.inCompendium) {
        const actorData = game.actors.fromCompendium(actor);
        actor = await Actor.implementation.create(actorData, { fromCompendium: true });
      }

      // Prepare token document
      const tokenData = await actor.getTokenDocument({
        hidden: game.user.isGM && event.altKey, // Alt key for hidden
        sort: Math.max(canvas.tokens.getMaxSort() + 1, 0)
      }, { parent: canvas.scene });

      // Calculate position (center token on drop point)
      const position = this.getTokenDropPosition(tokenData, { x: data.x, y: data.y }, {
        snap: !event.shiftKey // Shift key disables snapping
      });

      tokenData.updateSource(position);

      // Create the token document
      // This will trigger our 'createToken' hook, which creates the THREE.js sprite
      log.info(`Creating token for actor: ${actor.name} at (${position.x}, ${position.y})`);
      
      const created = await tokenData.constructor.create(tokenData, { parent: canvas.scene });
      
      if (created) {
        log.info(`Token created successfully: ${created.id}`);
        // Activate tokens layer
        canvas.tokens.activate();
      }

      return created;

    } catch (error) {
      log.error('Failed to create token from drop:', error);
      ui.notifications.error('Failed to create token');
    }
  }

  /**
   * Calculate token drop position
   * Centers token on drop point and optionally snaps to grid
   * @param {TokenDocument} tokenDoc
   * @param {{x: number, y: number}} position
   * @param {{snap: boolean}} options
   * @returns {{x: number, y: number}}
   * @private
   */
  getTokenDropPosition(tokenDoc, position, options = {}) {
    const { snap = true } = options;
    
    // Center token on drop point
    let { x, y } = position;
    x -= tokenDoc.width / 2;
    y -= tokenDoc.height / 2;

    // Snap to grid if enabled
    if (snap && canvas.grid) {
      const snapped = canvas.grid.getSnappedPoint({ x, y }, {
        mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_CORNER
      });
      x = snapped.x;
      y = snapped.y;
    }

    return { x, y };
  }

  /**
   * Handle tile drop
   * @param {DragEvent} event
   * @param {object} data
   * @private
   */
  async handleTileDrop(event, data) {
    log.info('Handling tile drop');
    
    // Permission check
    if (!game.user.can('TILE_CREATE')) {
      ui.notifications.warn('You do not have permission to create Tiles.');
      return;
    }

    // Get texture source
    let imgSrc = data.texture;
    if (!imgSrc && data.type === 'Tile') {
       // Dragging from Tile Browser or file
       // data might contain img, or we need to infer
       imgSrc = data.img;
    }
    
    if (!imgSrc) {
      // Fallback for dragging generic images
      try {
        const parsed = JSON.parse(event.dataTransfer.getData('text/plain'));
        if (parsed.src) imgSrc = parsed.src;
      } catch (e) {}
    }

    if (!imgSrc) {
      log.warn('No image source found for tile drop');
      return;
    }

    // Determine dimensions (load texture to get size)
    const tex = await loadTexture(imgSrc);
    const width = tex.baseTexture.width;
    const height = tex.baseTexture.height;

    // Calculate position (center on drop)
    let x = data.x - (width / 2);
    let y = data.y - (height / 2);

    // Snap to grid if shift key NOT held
    if (!event.shiftKey && canvas.grid) {
      const snapped = canvas.grid.getSnappedPoint({x, y}, {
        mode: CONST.GRID_SNAPPING_MODES.TOP_LEFT_CORNER
      });
      x = snapped.x;
      y = snapped.y;
    }

    // Prepare tile data
    const tileData = {
      texture: { src: imgSrc },
      width: width,
      height: height,
      x: x,
      y: y,
      elevation: 0 // Default elevation
    };

    // Create TileDocument
    log.info(`Creating tile at (${x}, ${y})`);
    const created = await canvas.scene.createEmbeddedDocuments('Tile', [tileData]);
    
    if (created && created.length > 0) {
       log.info(`Tile created: ${created[0].id}`);
    }
  }

  /**
   * Handle note drop
   * @param {DragEvent} event
   * @param {object} data
   * @private
   */
  async handleNoteDrop(event, data) {
    log.debug('Handling note drop');
    
    // Delegate to Foundry's notes layer
    if (canvas.notes?._onDropData) {
      return canvas.notes._onDropData(event, data);
    }
  }

  /**
   * Handle sound drop
   * @param {DragEvent} event
   * @param {object} data
   * @private
   */
  async handleSoundDrop(event, data) {
    log.debug('Handling sound drop');
    
    // Delegate to Foundry's sounds layer
    if (canvas.sounds?._onDropData) {
      return canvas.sounds._onDropData(event, data);
    }
  }

  /**
   * Convert viewport coordinates to canvas coordinates
   * Accounts for camera pan and zoom using SceneComposer's camera
   * @param {number} viewportX - X coordinate relative to canvas element
   * @param {number} viewportY - Y coordinate relative to canvas element
   * @returns {{x: number, y: number}}
   * @private
   */
  viewportToCanvas(viewportX, viewportY) {
    if (this.sceneComposer && this.sceneComposer.camera) {
      const camera = this.sceneComposer.camera;
      const rect = this.canvasElement.getBoundingClientRect();
      
      // Normalized Device Coordinates (NDC) [-1, 1]
      // X: -1 (Left) to 1 (Right)
      // Y: 1 (Top) to -1 (Bottom) (Standard GL)
      const ndcX = (viewportX / rect.width) * 2 - 1;
      const ndcY = -(viewportY / rect.height) * 2 + 1;
      
      const THREE = window.THREE;
      
      if (camera.isPerspectiveCamera) {
        // Create ray from camera
        // Note: We can't use Raycaster here easily without importing it, 
        // but we can do the math manually or use Vector3.unproject
        
        const vector = new THREE.Vector3(ndcX, ndcY, 0.5);
        vector.unproject(camera);
        
        const dir = vector.sub(camera.position).normalize();
        
        const distance = -camera.position.z / dir.z;
        
        const pos = camera.position.clone().add(dir.multiplyScalar(distance));
        
        return { x: pos.x, y: pos.y };
      }
      else if (camera.isOrthographicCamera) {
        // Map NDC to frustum
        const x = (ndcX + 1) / 2 * (camera.right - camera.left) + camera.left;
        const y = (ndcY + 1) / 2 * (camera.top - camera.bottom) + camera.bottom;
        
        // Add camera position (pan)
        // Note: In Ortho, position moves the view.
        // If Camera at (Px, Py). Center of view is (Px, Py).
        // Frustum is relative to P? No, usually relative to 0,0 if position is 0,0.
        // Three.js Ortho: Projection is static box. View Matrix handles position.
        // So we need to unproject or simply add position.
        
        // Using unproject is safer
        const vector = new THREE.Vector3(ndcX, ndcY, 0);
        vector.unproject(camera);
        
        return { x: vector.x, y: vector.y };
      }
    }

    // Fallback to Foundry's transform if SceneComposer not available
    const stage = canvas.stage;
    if (stage) {
      const transform = stage.transform.worldTransform;
      const scale = stage.scale.x;
      
      const canvasX = (viewportX - transform.tx) / scale;
      const canvasY = (viewportY - transform.ty) / scale;
      
      return { x: canvasX, y: canvasY };
    }

    return { x: viewportX, y: viewportY };
  }

  /**
   * Dispose drop handler and remove event listeners
   * @public
   */
  dispose() {
    if (this.canvasElement) {
      this.canvasElement.removeEventListener('dragover', this.boundHandlers.dragover);
      this.canvasElement.removeEventListener('drop', this.boundHandlers.drop);
    }

    log.info('DropHandler disposed');
  }
}
