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
    document.body.appendChild(this.container);

    // Create pane
    this.pane = new Tweakpane.Pane({
      title: 'Texture Manager',
      container: this.container,
      expanded: true
    });

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
    const titleElement = this.pane.element.querySelector('.tp-rotv');
    if (!titleElement) return;

    let isDragging = false;
    let hasDragged = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    titleElement.style.cursor = 'move';

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

    titleElement.addEventListener('mousedown', onMouseDown);
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
        this.container.style.left = state.position.left || '50%';
        this.container.style.top = state.position.top || '50%';
        
        // Convert percentage to pixels if it was initial default
        if (this.container.style.left === '50%') {
          this.container.style.left = `${window.innerWidth / 2 - 150}px`;
          this.container.style.top = `${window.innerHeight / 2 - 200}px`;
        }
      }
    } catch (e) {
      log.warn('Failed to load Texture Manager state:', e);
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
          top: this.container.style.top
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
