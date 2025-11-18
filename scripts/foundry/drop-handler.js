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
   */
  constructor(canvasElement) {
    this.canvasElement = canvasElement;
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
    
    // For now, delegate to Foundry's tile layer if it exists
    // We'll implement full tile handling later
    if (canvas.tiles?._onDropData) {
      return canvas.tiles._onDropData(event, data);
    } else {
      log.warn('Tile drops not yet fully implemented');
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
   * Accounts for camera pan and zoom
   * @param {number} viewportX - X coordinate relative to canvas element
   * @param {number} viewportY - Y coordinate relative to canvas element
   * @returns {{x: number, y: number}}
   * @private
   */
  viewportToCanvas(viewportX, viewportY) {
    // For now, simple 1:1 mapping
    // TODO: Account for camera pan/zoom when camera controller is active
    
    // Get canvas transform from Foundry
    const stage = canvas.stage;
    if (stage) {
      const transform = stage.transform.worldTransform;
      const scale = stage.scale.x;
      
      // Invert transform
      const canvasX = (viewportX - transform.tx) / scale;
      const canvasY = (viewportY - transform.ty) / scale;
      
      return { x: canvasX, y: canvasY };
    }

    // Fallback: direct mapping
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
