/**
 * @fileoverview Note manager - syncs Foundry journal notes to THREE.js
 * Renders billboarded icons for Journal Entries in Gameplay Mode
 * @module scene/note-manager
 */

import { createLogger } from '../core/log.js';

const log = createLogger('NoteManager');

/**
 * NoteManager - Synchronizes Foundry VTT notes to THREE.js
 */
export class NoteManager {
  /**
   * @param {THREE.Scene} scene - THREE.js scene
   */
  constructor(scene) {
    this.scene = scene;
    
    /** @type {Map<string, THREE.Object3D>} */
    this.notes = new Map();
    
    /** @type {THREE.TextureLoader} */
    this.textureLoader = new THREE.TextureLoader();
    
    this.initialized = false;
    this.hooksRegistered = false;
    
    // Group for all notes
    this.group = new THREE.Group();
    this.group.name = 'Notes';
    // Z position will be set in initialize() once groundZ is available
    this.group.position.z = 2.5;
    this.scene.add(this.group);
    
    // Default icon
    this.defaultIcon = 'icons/svg/book.svg';
    
    log.debug('NoteManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;

    // Update Z position based on groundZ
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.group.position.z = groundZ + 2.5;

    this.setupHooks();
    this.syncAllNotes();
    
    this.initialized = true;
    log.info(`NoteManager initialized at z=${this.group.position.z}`);
  }

  /**
   * Setup Foundry hooks
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    Hooks.on('createNote', (doc) => this.create(doc));
    Hooks.on('updateNote', (doc, changes) => this.update(doc, changes));
    Hooks.on('deleteNote', (doc) => this.remove(doc.id));
    
    Hooks.on('canvasReady', () => {
        this.syncAllNotes();
        this.updateVisibility();
    });

    Hooks.on('activateNotesLayer', () => this.setVisibility(false));
    Hooks.on('deactivateNotesLayer', () => this.setVisibility(true));

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
    const isNotesLayer = canvas.activeLayer?.name === 'NotesLayer';
    this.setVisibility(!isNotesLayer);
  }

  /**
   * Sync all notes
   * @private
   */
  syncAllNotes() {
    if (!canvas.scene || !canvas.scene.notes) return;
    
    for (const note of canvas.scene.notes) {
      this.create(note);
    }
  }

  /**
   * Create a note object
   * @param {NoteDocument} doc 
   * @private
   */
  create(doc) {
    if (this.notes.has(doc.id)) return;

    const iconPath = doc.icon || this.defaultIcon;
    
    this.textureLoader.load(iconPath, (texture) => {
        // Check if note was deleted while loading
        if (!canvas.scene.notes.has(doc.id)) return;
        
        const size = doc.iconSize || 40;
        
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(material);
        
        sprite.position.set(doc.x, doc.y, 0);
        sprite.scale.set(size, size, 1);
        
        // Store doc reference
        sprite.userData = { docId: doc.id, type: 'note' };
        
        this.group.add(sprite);
        this.notes.set(doc.id, sprite);
        
        log.debug(`Created note ${doc.id}`);
    });
  }

  /**
   * Update a note
   * @param {NoteDocument} doc 
   * @param {Object} changes 
   * @private
   */
  update(doc, changes) {
    // Full rebuild for simplicity
    this.remove(doc.id);
    this.create(doc);
  }

  /**
   * Remove a note
   * @param {string} id 
   * @private
   */
  remove(id) {
    const object = this.notes.get(id);
    if (object) {
      this.group.remove(object);
      if (object.material.map) object.material.map.dispose();
      object.material.dispose();
      this.notes.delete(id);
    }
  }
  
  /**
   * Dispose resources
   * @public
   */
  dispose() {
      this.group.clear();
      this.scene.remove(this.group);
      this.notes.clear();
  }
}
