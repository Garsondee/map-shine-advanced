import { isGmLike } from '../core/gm-parity.js';
import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';

const log = createLogger('NoteIconManager');

export class NoteIconManager {
  constructor(scene) {
    this.scene = scene;
    this.notes = new Map();
    this._hookIds = [];
    this._textureCache = new Map();
    this.initialized = false;

    const THREE = window.THREE;
    this.group = new THREE.Group();
    this.group.name = 'NoteIcons';
    this.group.renderOrder = 1200;
    this.group.layers.set(OVERLAY_THREE_LAYER);
    this.scene.add(this.group);
  }

  setScene(scene) {
    if (!scene || scene === this.scene) return;
    if (this.group && this.scene) this.scene.remove(this.group);
    this.scene = scene;
    this.scene.add(this.group);
  }

  initialize() {
    if (this.initialized) return;
    this._registerHooks();
    this.syncAll();
    this.initialized = true;
    log.info('NoteIconManager initialized');
  }

  _registerHooks() {
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => this.syncAll())]);
    this._hookIds.push(['createNote', Hooks.on('createNote', (doc) => this.create(doc))]);
    this._hookIds.push(['updateNote', Hooks.on('updateNote', (doc) => this.update(doc))]);
    this._hookIds.push(['deleteNote', Hooks.on('deleteNote', (doc) => this.remove(doc?.id))]);
    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => this.refreshVisibility())]);
  }

  _isNoteVisible(doc) {
    // Gameplay overlays should not depend on NotesLayer active-state visibility.
    // Keep baseline hidden/permission checks only.
    return !doc?.hidden || !!isGmLike() || !!doc?.isAuthor;
  }

  _resolveIconSrc(doc) {
    return doc?.texture?.src || doc?.icon || doc?.entry?.img || CONFIG?.controlIcons?.note || '';
  }

  async _loadTexture(src) {
    const THREE = window.THREE;
    if (!THREE || !src) return null;
    if (this._textureCache.has(src)) return this._textureCache.get(src);
    const tex = await new Promise((resolve) => {
      new THREE.TextureLoader().load(src, resolve, undefined, () => resolve(null));
    });
    if (tex) {
      if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      this._textureCache.set(src, tex);
    }
    return tex;
  }

  async create(rawDoc) {
    const doc = rawDoc?.document ?? rawDoc;
    if (!doc?.id || this.notes.has(doc.id)) return;
    if (!this._isNoteVisible(doc)) return;

    const src = this._resolveIconSrc(doc);
    const texture = await this._loadTexture(src);
    if (!texture) return;

    const THREE = window.THREE;
    const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.layers.set(OVERLAY_THREE_LAYER);
    sprite.renderOrder = 1201;
    sprite.userData = { type: 'noteIcon', docId: doc.id };

    const iconSize = Math.max(16, Number(doc?.iconSize) || 40);
    sprite.scale.set(iconSize, iconSize, 1);
    const p = Coordinates.toWorld(Number(doc.x) || 0, Number(doc.y) || 0);
    const z = (window.MapShine?.sceneComposer?.groundZ ?? 0) + 1008;
    sprite.position.set(p.x, p.y, z);

    this.group.add(sprite);
    this.notes.set(doc.id, sprite);
  }

  update(rawDoc) {
    const doc = rawDoc?.document ?? rawDoc;
    if (!doc?.id) return;
    this.remove(doc.id);
    void this.create(doc);
  }

  remove(id) {
    if (!id) return;
    const sprite = this.notes.get(id);
    if (!sprite) return;
    this.group.remove(sprite);
    sprite.material?.dispose?.();
    this.notes.delete(id);
  }

  syncAll() {
    const notesColl = canvas?.scene?.notes;
    const raw = Array.isArray(notesColl?.contents)
      ? notesColl.contents
      : Array.from(notesColl || []);
    const docs = raw.map((entry) => {
      if (entry?.id) return entry;
      if (Array.isArray(entry) && entry[1]?.id) return entry[1];
      return null;
    }).filter(Boolean);
    for (const doc of docs) {
      if (this._isNoteVisible(doc)) void this.create(doc);
      else this.remove(doc?.id);
    }
  }

  refreshVisibility() {
    const notesColl = canvas?.scene?.notes;
    const raw = Array.isArray(notesColl?.contents)
      ? notesColl.contents
      : Array.from(notesColl || []);
    const docs = raw.map((entry) => {
      if (entry?.id) return entry;
      if (Array.isArray(entry) && entry[1]?.id) return entry[1];
      return null;
    }).filter(Boolean);
    for (const doc of docs) {
      if (this._isNoteVisible(doc)) {
        if (!this.notes.has(doc.id)) void this.create(doc);
      } else {
        this.remove(doc.id);
      }
    }
  }

  update() {
    // Match DoorMeshManager behavior: in V2, rebind to FloorRenderBus scene
    // if initialization happened before the bus was available.
    try {
      const busScene = window.MapShine?.effectComposer?._floorCompositorV2?._renderBus?._scene ?? null;
      if (busScene && this.scene !== busScene) this.setScene(busScene);
    } catch (_) {}
  }

  dispose() {
    for (const [hook, id] of this._hookIds) Hooks.off(hook, id);
    this._hookIds = [];
    for (const id of Array.from(this.notes.keys())) this.remove(id);
    for (const tex of this._textureCache.values()) tex?.dispose?.();
    this._textureCache.clear();
    this.scene.remove(this.group);
  }
}

