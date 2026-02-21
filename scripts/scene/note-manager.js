/**
 * @fileoverview Note manager - syncs Foundry journal notes to THREE.js
 * Renders billboarded icons for Journal Entries in Gameplay Mode
 * @module scene/note-manager
 */

import { createLogger } from '../core/log.js';
import { GLOBAL_SCENE_LAYER } from '../effects/EffectComposer.js';
import { getPerspectiveElevation } from '../foundry/elevation-context.js';
import { readDocLevelsRange, isLevelsEnabledForScene } from '../foundry/levels-scene-flags.js';
import { getLevelsCompatibilityMode, LEVELS_COMPATIBILITY_MODES } from '../foundry/levels-compatibility.js';

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
    
    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];
    
    // Group for all notes
    this.group = new THREE.Group();
    this.group.name = 'Notes';
    // Z position will be set in initialize() once groundZ is available
    this.group.position.z = 2.5;
    // Note icons are floor-agnostic world objects. GLOBAL_SCENE_LAYER (29) ensures
    // they render exactly once per frame in the global scene pass (after the
    // per-floor render loop), preventing multi-compositing artifacts and
    // excluding them from per-floor depth captures.
    this.group.layers.set(GLOBAL_SCENE_LAYER);
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

    this._hookIds.push(['createNote', Hooks.on('createNote', (doc) => this.create(doc))]);
    this._hookIds.push(['updateNote', Hooks.on('updateNote', (doc, changes) => this.update(doc, changes))]);
    this._hookIds.push(['deleteNote', Hooks.on('deleteNote', (doc) => this.remove(doc.id))]);
    
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
        this.syncAllNotes();
        this.updateVisibility();
    })]);

    // WP-6: Re-check note visibility when vision/sight changes (e.g., token moved).
    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => this.refreshVisibility())]);

    // MS-LVL-043: Re-check note visibility when the active level or controlled token changes.
    this._hookIds.push(['mapShineLevelContextChanged', Hooks.on('mapShineLevelContextChanged', () => this.refreshVisibility())]);
    this._hookIds.push(['controlToken', Hooks.on('controlToken', () => this.refreshVisibility())]);

    this._hookIds.push(['activateNotesLayer', Hooks.on('activateNotesLayer', () => this.setVisibility(false))]);
    this._hookIds.push(['deactivateNotesLayer', Hooks.on('deactivateNotesLayer', () => this.setVisibility(true))]);

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
   * Check whether a note should be visible to the current user.
   * Mirrors Foundry's Note#isVisible: permission check on the linked journal,
   * plus token-vision test when token vision is active and the note is not global.
   * @param {NoteDocument} doc
   * @returns {boolean}
   * @private
   */
  _isNoteVisible(doc) {
    try {
      // If the PIXI placeable exists, defer to its authoritative isVisible getter.
      const placeable = canvas?.notes?.get?.(doc.id);
      if (placeable && ('isVisible' in placeable)) return !!placeable.isVisible;

      // Fallback: replicate the core logic when placeable isn't available yet.
      const accessTest = doc.page ?? doc.entry;
      const access = accessTest?.testUserPermission?.(game.user, 'LIMITED') ?? true;
      if (!access) return false;
      if (!canvas?.visibility?.tokenVision || doc.global) return !!access;
      const point = { x: doc.x, y: doc.y };
      const tolerance = (doc.iconSize || 40) / 4;
      if (!canvas.visibility.testVisibility(point, { tolerance })) return false;
    } catch (_) {
      // Fail-open: don't hide notes if the Foundry check itself errors.
    }

    // MS-LVL-043: Elevation range gating — hide notes outside the viewer's
    // elevation range when Levels compatibility is active.
    try {
      if (getLevelsCompatibilityMode() !== LEVELS_COMPATIBILITY_MODES.OFF
          && isLevelsEnabledForScene(canvas?.scene)) {
        const range = readDocLevelsRange(doc);
        // Only gate if the note has a finite range configured
        if (Number.isFinite(range.rangeBottom) || Number.isFinite(range.rangeTop)) {
          const perspective = getPerspectiveElevation();
          if (perspective.source !== 'background') {
            const elev = perspective.elevation;
            if (elev < range.rangeBottom || elev > range.rangeTop) return false;
          }
        }
      }
    } catch (_) {
      // Fail-open: don't hide notes if elevation check errors.
    }

    return true;
  }

  /**
   * Sync all notes, filtering by visibility/permission.
   * @private
   */
  syncAllNotes() {
    if (!canvas.scene || !canvas.scene.notes) return;
    
    for (const note of canvas.scene.notes) {
      if (this._isNoteVisible(note)) {
        this.create(note);
      } else {
        this.remove(note.id);
      }
    }
  }

  /**
   * Refresh visibility of all notes (e.g., after token movement changes vision).
   * @public
   */
  refreshVisibility() {
    if (!canvas?.scene?.notes) return;
    for (const doc of canvas.scene.notes) {
      const shouldShow = this._isNoteVisible(doc);
      if (shouldShow && !this.notes.has(doc.id)) {
        this.create(doc);
      } else if (!shouldShow && this.notes.has(doc.id)) {
        this.remove(doc.id);
      }
    }
  }

  /**
   * Create a note object
   * @param {NoteDocument} doc 
   * @private
   */
  create(doc) {
    if (this.notes.has(doc.id)) return;
    // WP-6: Skip notes that fail visibility/permission check.
    if (!this._isNoteVisible(doc)) return;

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
      // Unregister Foundry hooks using correct two-argument signature
      try {
        if (this._hookIds && this._hookIds.length) {
          for (const [hookName, hookId] of this._hookIds) {
            try {
              Hooks.off(hookName, hookId);
            } catch (e) {
            }
          }
        }
      } catch (e) {
      }
      this._hookIds = [];
      this.hooksRegistered = false;
      
      this.group.clear();
      this.scene.remove(this.group);
      this.notes.clear();
  }
}
