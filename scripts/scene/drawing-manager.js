/**
 * @fileoverview Drawing manager - syncs Foundry drawings to THREE.js
 * Handles text and shape drawings for Gameplay Mode visibility
 * @module scene/drawing-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('DrawingManager');

/**
 * DrawingManager - Synchronizes Foundry VTT drawings to THREE.js
 */
export class DrawingManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {Map<string, THREE.Object3D>} */
    this.drawings = new Map();
    
    this.initialized = false;
    this.hooksRegistered = false;
    
    // Group for all drawings
    this.group = new THREE.Group();
    this.group.name = 'Drawings';
    this.group.position.z = 2.0; // Above tiles, below walls
    this.scene.add(this.group);
    
    log.debug('DrawingManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;

    this.setupHooks();
    this.syncAllDrawings();
    
    this.initialized = true;
    log.info('DrawingManager initialized');
  }

  /**
   * Setup Foundry hooks
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    Hooks.on('createDrawing', (doc) => this.create(doc));
    Hooks.on('updateDrawing', (doc, changes) => this.update(doc, changes));
    Hooks.on('deleteDrawing', (doc) => this.remove(doc.id));
    
    Hooks.on('canvasReady', () => {
        this.syncAllDrawings();
        this.updateVisibility();
    });

    // Listen for layer activation to toggle visibility
    Hooks.on('activateDrawingsLayer', () => this.setVisibility(false));
    Hooks.on('deactivateDrawingsLayer', () => this.setVisibility(true));

    this.hooksRegistered = true;
  }

  /**
   * Set visibility of Three.js drawings
   * @param {boolean} visible 
   * @public
   */
  setVisibility(visible) {
    this.group.visible = visible;
  }

  /**
   * Update visibility based on active tool
   * @private
   */
  updateVisibility() {
    const isDrawingsLayer = canvas.activeLayer?.name === 'DrawingsLayer';
    this.setVisibility(!isDrawingsLayer);
  }

  /**
   * Sync all drawings
   * @private
   */
  syncAllDrawings() {
    if (!canvas.scene || !canvas.scene.drawings) return;
    
    for (const drawing of canvas.scene.drawings) {
      this.create(drawing);
    }
  }

  /**
   * Create a drawing object
   * @param {DrawingDocument} doc 
   * @private
   */
  create(doc) {
    if (this.drawings.has(doc.id)) return;

    try {
        // Basic implementation: Render text if it has text, otherwise render a box
        const group = new THREE.Group();
        group.position.set(doc.x, doc.y, 0);
        
        // 1. Text Rendering
        if (doc.text) {
            this.createText(doc, group);
        }
        
        // 2. Shape Rendering (Simple Outline)
        this.createShape(doc, group);
        
        // Apply rotation
        if (doc.rotation) {
            group.rotation.z = THREE.MathUtils.degToRad(-doc.rotation);
        }

        this.group.add(group);
        this.drawings.set(doc.id, group);
        
        log.debug(`Created drawing ${doc.id}`);
    } catch (e) {
        log.error(`Failed to create drawing ${doc.id}:`, e);
    }
  }

  /**
   * Render text using CanvasTexture
   * @param {DrawingDocument} doc 
   * @param {THREE.Group} group 
   */
  createText(doc, group) {
    // Create canvas for text
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const fontSize = doc.fontSize || 48;
    const fontFamily = doc.fontFamily || 'Arial';
    const color = doc.textColor || '#FFFFFF';
    
    // Estimate size (can be improved)
    const width = doc.width || 200;
    const height = doc.height || 100;
    
    canvas.width = width;
    canvas.height = height;
    
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Handle wrapping? For now just center
    ctx.fillText(doc.text, width / 2, height / 2);
    
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
    const sprite = new THREE.Sprite(material);
    
    sprite.scale.set(width, height, 1);
    // Center in the drawing box
    sprite.position.set(width / 2, height / 2, 0);
    
    group.add(sprite);
  }

  /**
   * Render shape outline
   * @param {DrawingDocument} doc 
   * @param {THREE.Group} group 
   */
  createShape(doc, group) {
    const width = doc.width || 100;
    const height = doc.height || 100;
    const color = doc.strokeColor || 0xFFFFFF;
    const thickness = doc.strokeWidth || 2;
    
    // If no stroke, use fill color?
    // For now just always draw a debug box if not text
    
    const geometry = new THREE.EdgesGeometry(new THREE.PlaneGeometry(width, height));
    const material = new THREE.LineBasicMaterial({ color: new THREE.Color(color) });
    const line = new THREE.LineSegments(geometry, material);
    
    // Pivot is top-left in Foundry, Center in PlaneGeometry
    line.position.set(width / 2, height / 2, 0);
    
    group.add(line);
  }

  /**
   * Update a drawing
   * @param {DrawingDocument} doc 
   * @param {Object} changes 
   * @private
   */
  update(doc, changes) {
    this.remove(doc.id);
    this.create(doc);
  }

  /**
   * Remove a drawing
   * @param {string} id 
   * @private
   */
  remove(id) {
    const object = this.drawings.get(id);
    if (object) {
      this.group.remove(object);
      // Dispose geometries/materials if needed
      this.drawings.delete(id);
    }
  }
  
  /**
   * Dispose resources
   * @public
   */
  dispose() {
      this.group.clear();
      this.scene.remove(this.group);
      this.drawings.clear();
  }
}
