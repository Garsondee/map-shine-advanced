import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';

const log = createLogger('TemplateAdornmentManager');

export class TemplateAdornmentManager {
  constructor(scene) {
    this.scene = scene;
    this.templates = new Map();
    this._hookIds = [];
    this.initialized = false;
    this._textureCache = new Map();

    const THREE = window.THREE;
    this.group = new THREE.Group();
    this.group.name = 'TemplateAdornments';
    this.group.renderOrder = 1205;
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
    log.info('TemplateAdornmentManager initialized');
  }

  _registerHooks() {
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => this.syncAll())]);
    this._hookIds.push(['createMeasuredTemplate', Hooks.on('createMeasuredTemplate', (doc) => this.create(doc))]);
    this._hookIds.push(['updateMeasuredTemplate', Hooks.on('updateMeasuredTemplate', (doc) => this.update(doc))]);
    this._hookIds.push(['deleteMeasuredTemplate', Hooks.on('deleteMeasuredTemplate', (doc) => this.remove(doc?.id))]);
    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => this.refreshVisibility())]);
  }

  _isTemplateVisible(doc) {
    // Gameplay overlays should not depend on TemplateLayer active-state visibility.
    // Keep baseline hidden/permission checks only.
    return !doc?.hidden || !!game?.user?.isGM || !!doc?.isAuthor;
  }

  _distanceToPixels(distance) {
    const dims = canvas?.dimensions;
    const gridPx = Number(dims?.size) || 100;
    const gridDist = Number(dims?.distance) || 5;
    return (Number(distance) || 0) * (gridPx / Math.max(0.0001, gridDist));
  }

  _endpoint(doc) {
    const x = Number(doc?.x) || 0;
    const y = Number(doc?.y) || 0;
    const dir = ((Number(doc?.direction) || 0) * Math.PI) / 180;
    const r = this._distanceToPixels(doc?.distance);
    return { x: x + (Math.cos(dir) * r), y: y + (Math.sin(dir) * r) };
  }

  _labelText(doc, fraction = 1) {
    const units = canvas?.scene?.grid?.units || canvas?.dimensions?.units || '';
    const distance = (Number(doc?.distance) || 0) * fraction;
    const rounded = Math.round(distance * 10) / 10;
    return `${rounded}${units ? ` ${units}` : ''}`;
  }

  _makeTextSprite(text, color = '#ffffff') {
    const THREE = window.THREE;
    const canvasEl = document.createElement('canvas');
    const ctx = canvasEl.getContext('2d');
    const fontSize = 24;
    const fontFamily = 'Signika, sans-serif';
    ctx.font = `${fontSize}px ${fontFamily}`;
    const m = ctx.measureText(text);
    const w = Math.max(16, Math.ceil(m.width + 16));
    const h = 40;
    canvasEl.width = w;
    canvasEl.height = h;
    const c = canvasEl.getContext('2d');
    c.font = `${fontSize}px ${fontFamily}`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineWidth = 6;
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.fillStyle = color;
    c.strokeText(text, w / 2, h / 2);
    c.fillText(text, w / 2, h / 2);
    const tex = new THREE.CanvasTexture(canvasEl);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(w * 0.6, h * 0.6, 1);
    sprite.layers.set(OVERLAY_THREE_LAYER);
    return sprite;
  }

  _makeMarker(color = '#ff9900', radius = 7) {
    const THREE = window.THREE;
    const canvasEl = document.createElement('canvas');
    canvasEl.width = 32;
    canvasEl.height = 32;
    const c = canvasEl.getContext('2d');
    c.beginPath();
    c.arc(16, 16, radius, 0, Math.PI * 2);
    c.fillStyle = 'rgba(0,0,0,0.6)';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = color;
    c.stroke();
    const tex = new THREE.CanvasTexture(canvasEl);
    if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(14, 14, 1);
    sprite.layers.set(OVERLAY_THREE_LAYER);
    return sprite;
  }

  async _loadTemplateIcon() {
    const THREE = window.THREE;
    const src = CONFIG?.controlIcons?.template || '';
    if (!src) return null;
    if (this._textureCache.has(src)) return this._textureCache.get(src);
    const tex = await new Promise((resolve) => {
      new THREE.TextureLoader().load(src, resolve, undefined, () => resolve(null));
    });
    if (tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
    if (tex) this._textureCache.set(src, tex);
    return tex;
  }

  async create(rawDoc) {
    const doc = rawDoc?.document ?? rawDoc;
    if (!doc?.id || this.templates.has(doc.id)) return;
    if (!this._isTemplateVisible(doc)) return;

    const THREE = window.THREE;
    const group = new THREE.Group();
    group.userData = { type: 'templateAdornment', docId: doc.id };
    group.layers.set(OVERLAY_THREE_LAYER);

    const start = { x: Number(doc.x) || 0, y: Number(doc.y) || 0 };
    const end = this._endpoint(doc);
    const mid = { x: (start.x + end.x) * 0.5, y: (start.y + end.y) * 0.5 };
    const color = String(doc?.borderColor || '#ff9900');
    const z = 1009;

    const toPos = (pt) => {
      const p = Coordinates.toWorld(pt.x, pt.y);
      return { x: p.x, y: p.y };
    };
    const sp = toPos(start);
    const mp = toPos(mid);
    const ep = toPos(end);

    const startMarker = this._makeMarker(color, 6);
    startMarker.position.set(sp.x, sp.y, z);
    group.add(startMarker);

    const midMarker = this._makeMarker(color, 5);
    midMarker.position.set(mp.x, mp.y, z);
    group.add(midMarker);

    const endMarker = this._makeMarker(color, 6);
    endMarker.position.set(ep.x, ep.y, z);
    group.add(endMarker);

    const midText = this._makeTextSprite(this._labelText(doc, 0.5), '#ffffff');
    midText.position.set(mp.x, mp.y + 18, z + 0.1);
    group.add(midText);

    const endText = this._makeTextSprite(this._labelText(doc, 1), '#ffffff');
    endText.position.set(ep.x, ep.y + 18, z + 0.1);
    group.add(endText);

    const iconTex = await this._loadTemplateIcon();
    if (iconTex) {
      const iconMat = new THREE.SpriteMaterial({ map: iconTex, transparent: true, depthTest: false, depthWrite: false });
      const icon = new THREE.Sprite(iconMat);
      icon.scale.set(18, 18, 1);
      icon.layers.set(OVERLAY_THREE_LAYER);
      icon.position.set(sp.x, sp.y, z + 0.1);
      icon.userData = { type: 'templateIcon', docId: doc.id };
      group.add(icon);
    }

    this.group.add(group);
    this.templates.set(doc.id, group);
  }

  update(rawDoc) {
    const doc = rawDoc?.document ?? rawDoc;
    if (!doc?.id) return;
    this.remove(doc.id);
    void this.create(doc);
  }

  remove(id) {
    const obj = this.templates.get(id);
    if (!obj) return;
    this.group.remove(obj);
    obj.traverse((node) => {
      if (node?.material?.map?.dispose) node.material.map.dispose();
      if (node?.material?.dispose) node.material.dispose();
    });
    this.templates.delete(id);
  }

  syncAll() {
    const tplColl = canvas?.scene?.templates;
    const raw = Array.isArray(tplColl?.contents)
      ? tplColl.contents
      : Array.from(tplColl || []);
    const docs = raw.map((entry) => {
      if (entry?.id) return entry;
      if (Array.isArray(entry) && entry[1]?.id) return entry[1];
      return null;
    }).filter(Boolean);
    for (const doc of docs) {
      if (this._isTemplateVisible(doc)) void this.create(doc);
      else this.remove(doc.id);
    }
  }

  refreshVisibility() {
    const tplColl = canvas?.scene?.templates;
    const raw = Array.isArray(tplColl?.contents)
      ? tplColl.contents
      : Array.from(tplColl || []);
    const docs = raw.map((entry) => {
      if (entry?.id) return entry;
      if (Array.isArray(entry) && entry[1]?.id) return entry[1];
      return null;
    }).filter(Boolean);
    for (const doc of docs) {
      if (this._isTemplateVisible(doc)) {
        if (!this.templates.has(doc.id)) void this.create(doc);
      } else this.remove(doc.id);
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
    for (const id of Array.from(this.templates.keys())) this.remove(id);
    for (const tex of this._textureCache.values()) tex?.dispose?.();
    this._textureCache.clear();
    this.scene.remove(this.group);
  }
}

