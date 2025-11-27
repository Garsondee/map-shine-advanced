/**
 * @fileoverview Template manager - syncs Foundry measured templates to THREE.js
 * Renders spell templates (cones, circles, rays, rects) in Gameplay Mode
 * @module scene/template-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('TemplateManager');

/**
 * TemplateManager - Synchronizes Foundry VTT templates to THREE.js
 */
export class TemplateManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {Map<string, THREE.Object3D>} */
    this.templates = new Map();
    
    this.initialized = false;
    this.hooksRegistered = false;
    
    // Group for all templates
    this.group = new THREE.Group();
    this.group.name = 'Templates';
    this.group.position.z = 1.5; // Just above ground/tiles
    this.scene.add(this.group);
    
    log.debug('TemplateManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;

    this.setupHooks();
    this.syncAllTemplates();
    
    this.initialized = true;
    log.info('TemplateManager initialized');
  }

  /**
   * Setup Foundry hooks
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    Hooks.on('createMeasuredTemplate', (doc) => this.create(doc));
    Hooks.on('updateMeasuredTemplate', (doc, changes) => this.update(doc, changes));
    Hooks.on('deleteMeasuredTemplate', (doc) => this.remove(doc.id));
    
    Hooks.on('canvasReady', () => {
        this.syncAllTemplates();
        this.updateVisibility();
    });

    Hooks.on('activateTemplateLayer', () => this.setVisibility(false));
    Hooks.on('deactivateTemplateLayer', () => this.setVisibility(true));

    this.hooksRegistered = true;
  }

  /**
   * Set visibility
   * @param {boolean} visible 
   * @public
   */
  setVisibility(visible) {
    this.group.visible = visible;
  }

  /**
   * Update visibility
   * @private
   */
  updateVisibility() {
    const isTemplateLayer = canvas.activeLayer?.name === 'TemplateLayer';
    this.setVisibility(!isTemplateLayer);
  }

  /**
   * Sync all templates
   * @private
   */
  syncAllTemplates() {
    if (!canvas.scene || !canvas.scene.templates) return;
    
    for (const template of canvas.scene.templates) {
      this.create(template);
    }
  }

  /**
   * Create a template object
   * @param {MeasuredTemplateDocument} doc 
   * @private
   */
  create(doc) {
    if (this.templates.has(doc.id)) return;

    try {
        const t = doc.t; // circle, cone, rect, ray
        const distance = doc.distance;
        const direction = doc.direction || 0;
        const angle = doc.angle || 53.13;
        const width = doc.width;
        
        // Convert distance (grid units) to pixels
        const pixelDistance = (distance / canvas.dimensions.distance) * canvas.dimensions.size;
        
        let geometry;
        
        // Color
        const color = new THREE.Color(doc.fillColor || 0xFF0000);
        const borderColor = new THREE.Color(doc.borderColor || 0x000000);
        
        switch (t) {
            case 'circle':
                geometry = new THREE.CircleGeometry(pixelDistance, 32);
                break;
            case 'cone':
                // Cone is a sector of a circle
                // thetaStart = rotation, thetaLength = angle
                // Foundry cones are centered on direction
                const thetaLength = THREE.MathUtils.degToRad(angle);
                // Start is -half angle + rotation?
                // Foundry rotation 0 is South (down)? No, 0 is East usually?
                // Need to verify rotation. For now assume standard math (0 = East).
                geometry = new THREE.CircleGeometry(pixelDistance, 32, -thetaLength/2, thetaLength);
                break;
            case 'rect':
                // Rect is defined by distance (length/height?) and width?
                // Or direction? Foundry Rects are dragged.
                // doc.shape contains the points usually.
                // Fallback to plane
                geometry = new THREE.PlaneGeometry(pixelDistance, pixelDistance); // Approx
                break;
            case 'ray':
                // Ray is a line with width
                const rayWidth = (width / canvas.dimensions.distance) * canvas.dimensions.size || 50;
                geometry = new THREE.PlaneGeometry(pixelDistance, rayWidth);
                geometry.translate(pixelDistance/2, 0, 0); // Anchor at start
                break;
            default:
                geometry = new THREE.CircleGeometry(pixelDistance, 32);
        }
        
        const material = new THREE.MeshBasicMaterial({ 
            color: color, 
            transparent: true, 
            opacity: 0.3,
            side: THREE.DoubleSide
        });
        
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(doc.x, doc.y, 0);
        
        // Rotation
        mesh.rotation.z = THREE.MathUtils.degToRad(-direction);
        
        // Border
        const edges = new THREE.EdgesGeometry(geometry);
        const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: borderColor }));
        mesh.add(line);
        
        this.group.add(mesh);
        this.templates.set(doc.id, mesh);
        
        log.debug(`Created template ${doc.id} (${t})`);
    } catch (e) {
        log.error(`Failed to create template ${doc.id}:`, e);
    }
  }

  /**
   * Update a template
   * @param {MeasuredTemplateDocument} doc 
   * @param {Object} changes 
   * @private
   */
  update(doc, changes) {
    this.remove(doc.id);
    this.create(doc);
  }

  /**
   * Remove a template
   * @param {string} id 
   * @private
   */
  remove(id) {
    const object = this.templates.get(id);
    if (object) {
      this.group.remove(object);
      // Dispose
      if (object.geometry) object.geometry.dispose();
      if (object.material) object.material.dispose();
      this.templates.delete(id);
    }
  }
  
  /**
   * Dispose resources
   * @public
   */
  dispose() {
      this.group.clear();
      this.scene.remove(this.group);
      this.templates.clear();
  }
}
