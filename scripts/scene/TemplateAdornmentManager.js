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
    this._pendingHydration = new Map();
    this._lastHydrationSweepMs = 0;

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
    if (window?.MapShine && window.MapShine.__useThreeTemplateOverlays == null) {
      window.MapShine.__useThreeTemplateOverlays = true;
    }
    log.info('TemplateAdornmentManager initialized');
  }

  _registerHooks() {
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => this.syncAll())]);
    this._hookIds.push(['createMeasuredTemplate', Hooks.on('createMeasuredTemplate', (doc) => this.create(doc))]);
    this._hookIds.push(['updateMeasuredTemplate', Hooks.on('updateMeasuredTemplate', (doc) => this.update(doc))]);
    this._hookIds.push(['deleteMeasuredTemplate', Hooks.on('deleteMeasuredTemplate', (doc) => this.remove(doc?.id))]);
    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => this.refreshVisibility())]);
    this._hookIds.push(['updateWall', Hooks.on('updateWall', () => this.syncAll())]);
    this._hookIds.push(['createWall', Hooks.on('createWall', () => this.syncAll())]);
    this._hookIds.push(['deleteWall', Hooks.on('deleteWall', () => this.syncAll())]);
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

  _toType(doc) {
    const raw = String(doc?.t ?? doc?.type ?? '').toLowerCase();
    if (raw === 'rectangle') return 'rect';
    return raw;
  }

  _toColor(value, fallback = '#3aa0ff') {
    const THREE = window.THREE;
    const c = String(value ?? '').trim();
    if (!c) return new THREE.Color(fallback);
    try { return new THREE.Color(c); } catch (_) { return new THREE.Color(fallback); }
  }

  _docShapePoints(doc) {
    const type = this._toType(doc);
    const x = Number(doc?.x) || 0;
    const y = Number(doc?.y) || 0;
    const directionDeg = Number(doc?.direction) || 0;
    const distancePx = this._distanceToPixels(doc?.distance);
    const angleDeg = Math.max(0, Number(doc?.angle) || (type === 'cone' ? 90 : 0));
    const rayWidth = Math.max(0.25, Number(doc?.width) || 1) * (Number(canvas?.dimensions?.size) || 100) / Math.max(0.0001, Number(canvas?.dimensions?.distance) || 5);

    if (!(distancePx > 0)) return [];
    if (type === 'circle' || (type === 'cone' && angleDeg >= 360)) {
      const out = [];
      const segs = 48;
      for (let i = 0; i < segs; i += 1) {
        const t = (i / segs) * Math.PI * 2;
        out.push({ x: x + (Math.cos(t) * distancePx), y: y + (Math.sin(t) * distancePx) });
      }
      return out;
    }
    if (type === 'cone') {
      const start = ((directionDeg - (angleDeg * 0.5)) * Math.PI) / 180;
      const end = ((directionDeg + (angleDeg * 0.5)) * Math.PI) / 180;
      const sweep = Math.max(0.001, end - start);
      const segs = Math.max(8, Math.ceil((sweep / (Math.PI * 2)) * 48));
      const out = [{ x, y }];
      for (let i = 0; i <= segs; i += 1) {
        const t = start + ((i / segs) * sweep);
        out.push({ x: x + (Math.cos(t) * distancePx), y: y + (Math.sin(t) * distancePx) });
      }
      return out;
    }
    if (type === 'rect') {
      const rad = (directionDeg * Math.PI) / 180;
      const ex = x + (Math.cos(rad) * distancePx);
      const ey = y + (Math.sin(rad) * distancePx);
      const minX = Math.min(x, ex);
      const minY = Math.min(y, ey);
      const maxX = Math.max(x, ex);
      const maxY = Math.max(y, ey);
      return [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ];
    }
    if (type === 'ray') {
      const dirRad = (directionDeg * Math.PI) / 180;
      const dirX = Math.cos(dirRad);
      const dirY = Math.sin(dirRad);
      const perpX = -dirY;
      const perpY = dirX;
      const halfW = rayWidth * 0.5;
      const p00x = x + (perpX * halfW);
      const p00y = y + (perpY * halfW);
      const p01x = x - (perpX * halfW);
      const p01y = y - (perpY * halfW);
      const p10x = p00x + (dirX * distancePx);
      const p10y = p00y + (dirY * distancePx);
      const p11x = p01x + (dirX * distancePx);
      const p11y = p01y + (dirY * distancePx);
      return [
        { x: p00x, y: p00y },
        { x: p10x, y: p10y },
        { x: p11x, y: p11y },
        { x: p01x, y: p01y },
      ];
    }
    return [];
  }

  _getTemplatePlaceable(docId) {
    if (!docId) return null;
    const id = String(docId);
    const candidates = [
      ...(Array.isArray(canvas?.templates?.placeables) ? canvas.templates.placeables : []),
      ...(Array.isArray(canvas?.templates?.objects?.children) ? canvas.templates.objects.children : []),
    ];
    for (const p of candidates) {
      if (!p?.document?.id) continue;
      if (String(p.document.id) === id) return p;
    }
    return null;
  }

  _getNativeCells(placeable) {
    if (!placeable) return [];
    const getter =
      (typeof placeable._getGridHighlightPositions === 'function' && placeable._getGridHighlightPositions)
      || (typeof placeable.getGridHighlightPositions === 'function' && placeable.getGridHighlightPositions);
    if (typeof getter !== 'function') return [];
    try {
      const cells = getter.call(placeable) ?? [];
      if (!Array.isArray(cells)) return [];
      const out = [];
      for (const c of cells) {
        if (Array.isArray(c) && c.length >= 2) {
          const x = Number(c[0]); const y = Number(c[1]);
          if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
          continue;
        }
        const x = Number(c?.x); const y = Number(c?.y);
        if (Number.isFinite(x) && Number.isFinite(y)) out.push({ x, y });
      }
      return out;
    } catch (_) {
      return [];
    }
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
    const color = this._toColor(doc?.borderColor, '#3aa0ff');
    const fillColor = this._toColor(doc?.fillColor, '#3aa0ff');
    const z = 1009;

    const toPos = (pt) => {
      const p = Coordinates.toWorld(pt.x, pt.y);
      return { x: p.x, y: p.y };
    };
    const sp = toPos(start);
    const outlinePts = this._docShapePoints(doc);
    if (outlinePts.length >= 3) {
      const worldPts = outlinePts.map((p) => Coordinates.toWorld(p.x, p.y));
      const shape = new THREE.Shape();
      shape.moveTo(worldPts[0].x, worldPts[0].y);
      for (let i = 1; i < worldPts.length; i += 1) shape.lineTo(worldPts[i].x, worldPts[i].y);
      shape.lineTo(worldPts[0].x, worldPts[0].y);
      const fillGeom = new THREE.ShapeGeometry(shape);
      const fillMat = new THREE.MeshBasicMaterial({
        color: fillColor,
        transparent: true,
        opacity: 0.14,
        depthTest: false,
        depthWrite: false
      });
      const fillMesh = new THREE.Mesh(fillGeom, fillMat);
      fillMesh.position.z = z - 0.2;
      fillMesh.layers.set(OVERLAY_THREE_LAYER);
      group.add(fillMesh);

      const lineGeom = new THREE.BufferGeometry().setFromPoints([...worldPts, worldPts[0]]);
      const lineMat = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
        depthWrite: false
      });
      const line = new THREE.Line(lineGeom, lineMat);
      line.position.z = z;
      line.layers.set(OVERLAY_THREE_LAYER);
      group.add(line);
    }

    try {
      const grid = canvas?.grid;
      const gridTypes = globalThis.CONST?.GRID_TYPES || {};
      if (grid?.type !== gridTypes.GRIDLESS) {
        const dims = canvas?.dimensions ?? {};
        const gx = Math.max(1, Number(grid?.sizeX ?? dims?.sizeX ?? dims?.size) || 100);
        const gy = Math.max(1, Number(grid?.sizeY ?? dims?.sizeY ?? dims?.size) || 100);
        const placeable = this._getTemplatePlaceable(doc.id);
        const cells = this._getNativeCells(placeable);
        if (cells.length > 0) {
          const cellGeo = new THREE.PlaneGeometry(gx, gy);
          const cellMat = new THREE.MeshBasicMaterial({
            color: fillColor,
            transparent: true,
            opacity: 0.12,
            depthTest: false,
            depthWrite: false
          });
          const mesh = new THREE.InstancedMesh(cellGeo, cellMat, cells.length);
          mesh.layers.set(OVERLAY_THREE_LAYER);
          for (let i = 0; i < cells.length; i += 1) {
            const c = cells[i];
            const center = Coordinates.toWorld(c.x + (gx * 0.5), c.y + (gy * 0.5));
            const m = new THREE.Matrix4();
            m.makeTranslation(center.x, center.y, z - 0.35);
            mesh.setMatrixAt(i, m);
          }
          mesh.instanceMatrix.needsUpdate = true;
          group.add(mesh);
        } else if (placeable) {
          this._pendingHydration.set(String(doc.id), 0);
        }
      }
    } catch (_) {}

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
      if (node?.material?.dispose) node.material.dispose();
      if (node?.geometry?.dispose) node.geometry.dispose();
    });
    this.templates.delete(id);
    this._pendingHydration.delete(String(id));
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

    const now = performance.now();
    if ((now - this._lastHydrationSweepMs) < 1200) return;
    this._lastHydrationSweepMs = now;
    if (this._pendingHydration.size <= 0) return;
    for (const [id, attempts] of Array.from(this._pendingHydration.entries())) {
      const placeable = this._getTemplatePlaceable(id);
      if (!placeable) {
        this._pendingHydration.delete(id);
        continue;
      }
      const cells = this._getNativeCells(placeable);
      if (cells.length > 0) {
        const doc = placeable.document ?? null;
        this._pendingHydration.delete(id);
        if (doc) this.update(doc);
        continue;
      }
      if (attempts >= 8) {
        this._pendingHydration.delete(id);
        continue;
      }
      try { if (typeof placeable.refresh === 'function') placeable.refresh(); } catch (_) {}
      const shouldDraw = attempts <= 1 || (attempts % 3) === 0;
      if (shouldDraw) {
        try {
          const maybe = placeable.draw?.();
          if (maybe?.catch) maybe.catch(() => {});
        } catch (_) {}
      }
      this._pendingHydration.set(id, attempts + 1);
    }
  }

  dispose() {
    for (const [hook, id] of this._hookIds) Hooks.off(hook, id);
    this._hookIds = [];
    for (const id of Array.from(this.templates.keys())) this.remove(id);
    for (const tex of this._textureCache.values()) tex?.dispose?.();
    this._textureCache.clear();
    this.scene.remove(this.group);
    if (window?.MapShine && window.MapShine.__useThreeTemplateOverlays === true) {
      window.MapShine.__useThreeTemplateOverlays = false;
    }
  }
}

