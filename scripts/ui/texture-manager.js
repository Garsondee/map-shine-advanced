/**
 * @fileoverview Texture Manager UI for Map Shine Advanced
 * Provides a dedicated interface for managing textures and material assets
 * @module ui/texture-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TextureManager');

export class TextureManagerUI {
  constructor() {
    /** @type {Tweakpane.Pane|null} */
    this.pane = null;
    
    /** @type {HTMLElement|null} */
    this.container = null;
    
    /** @type {HTMLElement|null} Custom header overlay for dragging */
    this.headerOverlay = null;
    
    /** @type {boolean} */
    this.visible = false;
    
    /** @type {Object} Saved state */
    this.state = {
      position: { left: '50%', top: '50%' },
      expanded: true
    };
  }

  /**
   * Initialize the Texture Manager UI
   */
  async initialize() {
    if (this.pane) return;

    log.info('Initializing Texture Manager UI...');

    // Create container
    this.container = document.createElement('div');
    this.container.id = 'map-shine-texture-manager';
    this.container.style.position = 'fixed';
    this.container.style.zIndex = '10005'; // Above main UI
    this.container.style.display = 'none';
    this.container.style.minWidth = '300px';
    // Default position: bottom-right, similar to main UI
    this.container.style.right = '20px';
    this.container.style.bottom = '20px';
    document.body.appendChild(this.container);

    // Create pane
    this.pane = new Tweakpane.Pane({
      title: 'Texture Manager',
      container: this.container,
      expanded: true
    });

    // Create a transparent header overlay to act as a drag handle,
    // mirroring the behavior of the main UI
    this.headerOverlay = document.createElement('div');
    this.headerOverlay.className = 'map-shine-texture-manager-header-overlay';
    this.headerOverlay.style.position = 'absolute';
    this.headerOverlay.style.top = '0';
    this.headerOverlay.style.left = '0';
    this.headerOverlay.style.right = '0';
    this.headerOverlay.style.height = '24px';
    this.headerOverlay.style.pointerEvents = 'auto';
    this.headerOverlay.style.cursor = 'move';
    this.headerOverlay.style.background = 'transparent';
    this.headerOverlay.style.zIndex = '10006';
    this.container.appendChild(this.headerOverlay);

    // Add placeholder content for now
    const folder = this.pane.addFolder({ title: 'Texture Library' });
    
    folder.addBlade({
      view: 'text',
      label: 'Status',
      parse: (v) => v,
      value: 'No textures loaded',
      disabled: true
    });

    folder.addButton({
      title: 'Scan for Textures'
    }).on('click', () => {
      log.info('Scan requested (Not implemented)');
      ui.notifications.info('Texture scanning coming soon!');
    });

    // Load saved state
    await this.loadState();

    // Enable dragging
    this.makeDraggable();

    log.info('Texture Manager UI initialized');
  }

  /**
   * Toggle visibility
   */
  toggle() {
    this.visible = !this.visible;
    this.container.style.display = this.visible ? 'block' : 'none';
    
    if (this.visible) {
      // Ensure it's on screen
      this.constrainToScreen();
    }
  }

  /**
   * Make the panel draggable
   * @private
   */
  makeDraggable() {
    // Prefer the custom header overlay if present, otherwise fall back to the pane
    const dragHandle = this.headerOverlay || this.pane?.element || this.container;
    if (!dragHandle) {
      log.warn('Could not find drag handle element for Texture Manager UI');
      return;
    }

    let isDragging = false;
    let hasDragged = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    dragHandle.style.cursor = 'move';

    const onMouseDown = (e) => {
      isDragging = true;
      hasDragged = false;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = this.container.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      // Clear constrained positioning to allow free movement
      this.container.style.right = 'auto';
      this.container.style.bottom = 'auto';
      this.container.style.left = `${startLeft}px`;
      this.container.style.top = `${startTop}px`;

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
      e.stopPropagation();
    };

    const onMouseMove = (e) => {
      if (!isDragging) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        hasDragged = true;
      }

      this.container.style.left = `${startLeft + dx}px`;
      this.container.style.top = `${startTop + dy}px`;
    };

    const onMouseUp = (e) => {
      isDragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      
      if (hasDragged && e) {
        e.preventDefault();
        e.stopPropagation();
      }

      this.saveState();
    };

    dragHandle.addEventListener('mousedown', onMouseDown);

    // Prevent header clicks from triggering Tweakpane's default fold behavior;
    // folding (if desired) should be controlled by explicit UI controls.
    dragHandle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  }

  /**
   * Constrain container to screen bounds
   * @private
   */
  constrainToScreen() {
    const rect = this.container.getBoundingClientRect();
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;

    if (rect.right > winWidth) {
      this.container.style.left = `${winWidth - rect.width - 20}px`;
    }
    if (rect.bottom > winHeight) {
      this.container.style.top = `${winHeight - rect.height - 20}px`;
    }
    if (rect.left < 0) {
      this.container.style.left = '20px';
    }
    if (rect.top < 0) {
      this.container.style.top = '20px';
    }
  }

  /**
   * Load state from client settings
   * @private
   */
  async loadState() {
    try {
      const state = game.settings.get('map-shine-advanced', 'texture-manager-state') || {};
      
      if (state.position) {
        this.container.style.left = state.position.left || 'auto';
        this.container.style.top = state.position.top || 'auto';
        this.container.style.right = state.position.right || '20px';
        this.container.style.bottom = state.position.bottom || '20px';
      } else {
        // Default position if no state is stored yet: bottom-right
        this.container.style.right = '20px';
        this.container.style.bottom = '20px';
      }
    } catch (e) {
      log.warn('Failed to load Texture Manager state:', e);
      // Fallback to default bottom-right
      this.container.style.right = '20px';
      this.container.style.bottom = '20px';
    }
  }

  /**
   * Save state to client settings
   * @private
   */
  async saveState() {
    try {
      const state = {
        position: {
          left: this.container.style.left,
          top: this.container.style.top,
          right: this.container.style.right,
          bottom: this.container.style.bottom
        }
      };
      await game.settings.set('map-shine-advanced', 'texture-manager-state', state);
    } catch (e) {
      log.warn('Failed to save Texture Manager state:', e);
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.pane) {
      this.pane.dispose();
    }
    if (this.container) {
      this.container.remove();
    }
  }
}
