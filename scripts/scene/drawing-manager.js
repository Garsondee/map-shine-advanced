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
    const THREE = window.THREE;
    
    /** @type {Map<string, THREE.Object3D>} */
    this.drawings = new Map();
    
    this.initialized = false;
    this.hooksRegistered = false;
    
    // Group for all drawings
    this.group = new THREE.Group();
    this.group.name = 'Drawings';
    this.group.renderOrder = 1000;
    // Z position will be set in initialize() once groundZ is available
    this.group.position.z = 2.0;
    this.scene.add(this.group);
    
    log.debug('DrawingManager created');
  }

  /**
   * Initialize and set up Foundry hooks
   * @public
   */
  initialize() {
    if (this.initialized) return;

    // Update Z position based on groundZ
    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.group.position.z = groundZ + 2.0;

    this.setupHooks();
    this.syncAllDrawings();
    
    this.initialized = true;
    log.info(`DrawingManager initialized at z=${this.group.position.z}`);
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
    Hooks.on('activateDrawingsLayer', () => this.updateVisibility());
    Hooks.on('deactivateDrawingsLayer', () => this.updateVisibility());

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
    this.setVisibility(true);
  }

  /**
   * Sync all drawings
   * @private
   */
  syncAllDrawings() {
    if (!canvas?.ready) return;

    /** @type {any[]} */
    let docs = [];

    const sceneDrawings = canvas.scene?.drawings;
    if (sceneDrawings) {
      if (Array.isArray(sceneDrawings)) {
        docs = sceneDrawings;
      } else if (Array.isArray(sceneDrawings.contents)) {
        docs = sceneDrawings.contents;
      } else if (typeof sceneDrawings.values === 'function') {
        docs = Array.from(sceneDrawings.values());
      } else if (typeof sceneDrawings[Symbol.iterator] === 'function') {
        docs = [];
        for (const entry of sceneDrawings) {
          if (Array.isArray(entry) && entry.length >= 2) docs.push(entry[1]);
          else docs.push(entry);
        }
      }
    }

    // Fallback: use placeables if the scene collection isn't accessible.
    if ((!docs || docs.length === 0) && Array.isArray(canvas.drawings?.placeables)) {
      docs = canvas.drawings.placeables.map(d => d?.document).filter(Boolean);
    }

    if (!Array.isArray(docs) || docs.length === 0) {
      log.debug('No drawings found to sync');
      return;
    }

    log.debug(`Syncing ${docs.length} drawings`);
    for (const drawingDoc of docs) {
      if (!drawingDoc?.id) continue;
      this.create(drawingDoc);
    }
  }

  /**
   * Create a drawing object
   * @param {DrawingDocument} doc 
   * @private
   */
  create(doc) {
    const drawingDoc = doc?.document ?? doc;
    if (!drawingDoc?.id) return;
    if (this.drawings.has(drawingDoc.id)) return;

    try {
        const THREE = window.THREE;

        // Resolve the corresponding placeable, if available.
        // Depending on Foundry version and layer visibility, drawingDoc.object may be null.
        let placeable = drawingDoc.object;
        if (!placeable && doc?.document) placeable = doc;
        if (!placeable && Array.isArray(canvas.drawings?.placeables)) {
          placeable = canvas.drawings.placeables.find(d => (d?.document?.id === drawingDoc.id) || (d?.id === drawingDoc.id)) || null;
        }

        // Basic implementation: Render text if it has text, otherwise render a box
        const group = new THREE.Group();

        // Use Drawing shape dimensions for placement, matching Foundry
        const shape = drawingDoc.shape || {};
        const width = shape.width || drawingDoc.width || 0;
        const height = shape.height || drawingDoc.height || 0;

        // Center of the drawing in Foundry coordinates (top-left origin, Y-down)
        const centerX = drawingDoc.x + width / 2;
        const centerY = drawingDoc.y + height / 2;

        // Convert to THREE world coordinates (Y-up) using scene height
        const sceneHeight = canvas.dimensions?.height || 10000;
        const worldY = sceneHeight - centerY;

        // Position the group at the world-space center. Z is inherited from parent group
        group.position.set(centerX, worldY, 0);

        // Apply rotation around the center. Foundry rotates clockwise in screen-space;
        // we negate here to account for Y-up vs Y-down.
        if (drawingDoc.rotation) {
            group.rotation.z = THREE.MathUtils.degToRad(-drawingDoc.rotation);
        }

        // 1. Text Rendering (centered in the drawing box)
        // Foundry may render "pending" text during editing (placeable._pendingText)
        // even if the document text has not been committed yet.
        let displayText = drawingDoc.text;
        if ((displayText == null || displayText === '') && placeable) {
          if (placeable._pendingText !== undefined) displayText = placeable._pendingText;
          else if (placeable.text?.text !== undefined) displayText = placeable.text.text;
          else if (placeable.document?.text !== undefined) displayText = placeable.document.text;
        }
        if (displayText != null && String(displayText).length > 0) {
          this.createText(drawingDoc, group, width, height, String(displayText));
        }
        
        // 2. Shape Rendering (Simple Outline)
        this.createShape(drawingDoc, group, width, height);

        // Visibility rules: mimic Foundry isVisible behavior
        const isGM = game.user?.isGM;
        const isAuthor = drawingDoc.isAuthor;
        const hidden = drawingDoc.hidden;
        group.visible = !hidden || isAuthor || isGM;

        this.group.add(group);
        this.drawings.set(drawingDoc.id, group);
        
        log.debug(`Created drawing ${drawingDoc.id}`);
    } catch (e) {
        log.error(`Failed to create drawing ${drawingDoc?.id || 'unknown'}:`, e);
    }
  }

  /**
   * Render text using CanvasTexture
   * @param {DrawingDocument} doc 
   * @param {THREE.Group} group 
   * @param {number} width - Drawing box width
   * @param {number} height - Drawing box height
   */
  createText(doc, group, width, height, overrideText) {
    const text = overrideText ?? (doc.text ?? '');
    if (!text) return;

    const THREE = window.THREE;

    const resolution = 2;
    const fontSize = doc.fontSize || 48;
    const fontFamily = doc.fontFamily || globalThis.CONFIG?.defaultFontFamily || 'Signika';
    const normalizeCssColor = (c, fallback = '#FFFFFF') => {
      if (typeof c === 'number' && Number.isFinite(c)) {
        return `#${Math.trunc(c).toString(16).padStart(6, '0')}`;
      }
      if (typeof c !== 'string') return fallback;
      const s = c.trim();
      if (!s) return fallback;
      if (/^0x[0-9a-fA-F]{6}$/.test(s)) return `#${s.slice(2)}`;
      if (/^[0-9a-fA-F]{6}$/.test(s)) return `#${s}`;
      return s;
    };

    const fillColor = normalizeCssColor(doc.textColor, '#FFFFFF');
    const textAlpha = doc.textAlpha != null ? doc.textAlpha : 1.0;

    const stroke = Math.max(Math.round(fontSize / 32), 2);
    const dropShadowBlur = Math.max(Math.round(fontSize / 16), 2);
    const padding = stroke * 4;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const fontPx = fontSize * resolution;
    const strokePx = stroke * resolution;
    const paddingPx = padding * resolution;
    const wrapWidthPx = Math.max(1, Math.floor(width * resolution));

    const parseHexColor = (c) => {
      if (typeof c === 'number') {
        const r = (c >> 16) & 0xff;
        const g = (c >> 8) & 0xff;
        const b = c & 0xff;
        return { r, g, b };
      }
      if (typeof c !== 'string') return null;
      const s = c.trim();
      if (s.startsWith('#')) {
        let hex = s.slice(1);
        if (hex.length === 3) hex = hex.split('').map((ch) => ch + ch).join('');
        if (hex.length !== 6) return null;
        const v = parseInt(hex, 16);
        if (Number.isNaN(v)) return null;
        return { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff };
      }
      return null;
    };

    const rgb = parseHexColor(fillColor);
    const luminance = rgb ? (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255 : 1;
    const strokeColor = luminance > 0.6 ? '#000000' : '#FFFFFF';

    // First pass: measure and wrap using the final font settings.
    ctx.font = `${fontPx}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const wrapParagraph = (paragraph) => {
      const words = paragraph.split(/\s+/).filter((w) => w.length);
      if (!words.length) return [''];
      const lines = [];
      let line = words[0];
      for (let i = 1; i < words.length; i++) {
        const next = `${line} ${words[i]}`;
        if (ctx.measureText(next).width <= wrapWidthPx) {
          line = next;
        } else {
          lines.push(line);
          line = words[i];
        }
      }
      lines.push(line);

      const finalLines = [];
      for (const l of lines) {
        if (ctx.measureText(l).width <= wrapWidthPx) {
          finalLines.push(l);
          continue;
        }
        let sub = '';
        for (const ch of l) {
          const test = sub + ch;
          if (ctx.measureText(test).width <= wrapWidthPx || sub.length === 0) {
            sub = test;
          } else {
            finalLines.push(sub);
            sub = ch;
          }
        }
        if (sub) finalLines.push(sub);
      }
      return finalLines;
    };

    const paragraphs = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const lines = [];
    for (const p of paragraphs) {
      const wrapped = wrapParagraph(p);
      for (const l of wrapped) lines.push(l);
    }

    const lineHeightPx = Math.round(fontPx * 1.2);

    let maxLineWidthPx = 1;
    for (const l of lines) {
      maxLineWidthPx = Math.max(maxLineWidthPx, Math.ceil(ctx.measureText(l).width));
    }
    const contentWidthPx = Math.max(1, maxLineWidthPx);
    const contentHeightPx = Math.max(1, lines.length * lineHeightPx);

    const canvasWidth = Math.max(1, Math.ceil(contentWidthPx + (paddingPx * 2)));
    const canvasHeight = Math.max(1, Math.ceil(contentHeightPx + (paddingPx * 2)));
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Second pass: redraw using the final canvas size.
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);
    ctx.font = `${fontPx}px ${fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;

    const startY = (canvasHeight / 2) - (contentHeightPx / 2) + (lineHeightPx / 2);
    const cx = canvasWidth / 2;

    ctx.shadowColor = '#000000';
    ctx.shadowBlur = dropShadowBlur * resolution;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    ctx.lineWidth = strokePx;
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = fillColor;

    for (let i = 0; i < lines.length; i++) {
      const y = startY + (i * lineHeightPx);
      ctx.strokeText(lines[i], cx, y);
      ctx.fillText(lines[i], cx, y);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: textAlpha,
      depthTest: false
    });
    const sprite = new THREE.Sprite(material);
    sprite.renderOrder = 1001;
    sprite.scale.set(canvasWidth / resolution, canvasHeight / resolution, 1);
    sprite.position.set(0, 0, 0);

    group.add(sprite);
  }

  /**
   * Render shape outline
   * @param {DrawingDocument} doc 
   * @param {THREE.Group} group 
   * @param {number} width - Drawing box width
   * @param {number} height - Drawing box height
   */
  createShape(doc, group, width, height) {
    const THREE = window.THREE;

    // Resolve stroke colour from the document. Foundry stores strokeColor as a
    // numeric hex, but it may also be a string like "#ff0000" or a Number-
    // wrapper object depending on how it's accessed. Fall back to fillColor if
    // stroke is not set and always coerce to a primitive number for THREE.Color.
    let strokeColor = doc.strokeColor;
    if (typeof strokeColor === 'string') {
      try {
        const hex = strokeColor.replace('#', '');
        const parsed = parseInt(hex, 16);
        if (!Number.isNaN(parsed)) strokeColor = parsed;
      } catch (_) {
        // ignore and fall back below
      }
    }
    if (strokeColor == null) strokeColor = doc.fillColor || 0xFFFFFF;

    // Coerce Number objects or Color-like wrappers to a primitive.
    if (strokeColor && typeof strokeColor === 'object' && typeof strokeColor.valueOf === 'function') {
      strokeColor = strokeColor.valueOf();
    }
    strokeColor = Number(strokeColor);
    if (!Number.isFinite(strokeColor)) strokeColor = 0xFFFFFF;

    const color = strokeColor;
    const thickness = doc.strokeWidth || 2;
    const strokeAlpha = doc.strokeAlpha != null ? doc.strokeAlpha : 1.0;
    const fillType = doc.fillType;
    let fillColor = doc.fillColor || 0x000000;
    if (fillColor && typeof fillColor === 'object' && typeof fillColor.valueOf === 'function') {
      fillColor = fillColor.valueOf();
    }
    fillColor = Number(fillColor);
    if (!Number.isFinite(fillColor)) fillColor = 0x000000;
    const fillAlpha = doc.fillAlpha != null ? doc.fillAlpha : 0;
    const shape = doc.shape || {};
    const type = shape.type;

    // Polygon / Freehand style drawings: render a smoothed ribbon using quads
    // along the path. Foundry stores both polygon and freehand points in
    // shape.points; the exact type string can vary (e.g. 'p' vs 'f'), so we key
    // off the presence of points and approximate Foundry's drawSmoothedPath
    // behaviour using a CatmullRomCurve3.
    if (Array.isArray(shape.points) && shape.points.length >= 4) {
      const pts = shape.points;
      const vertexCount = Math.floor(pts.length / 2);

      /** @type {THREE.Vector3[]} */
      const rawPoints = [];
      for (let i = 0; i < vertexCount; i++) {
        const px = pts[i * 2 + 0] ?? 0;
        const py = pts[i * 2 + 1] ?? 0;

        // Points are in local drawing-box coordinates, top-left origin, Y-down.
        // Convert to local group space (centered, Y-up).
        const localX = px - width / 2;
        const localY = (height - py) - height / 2;
        rawPoints.push(new THREE.Vector3(localX, localY, 0));
      }

      // Basic smoothing: use a Catmull-Rom spline with a density informed by
      // the document's bezierFactor (if present). Foundry multiplies this by 2,
      // but we also enforce a higher base density so curves look smooth even
      // when bezierFactor is small.
      const bezierFactor = typeof doc.bezierFactor === 'number' ? doc.bezierFactor : 1;
      const baseSegments = vertexCount * 4;
      const smoothSegments = Math.max(1, Math.floor(Math.max(baseSegments, vertexCount * (bezierFactor * 4))));
      let samplePoints = rawPoints;

      if (rawPoints.length >= 2) {
        const curve = new THREE.CatmullRomCurve3(rawPoints, false, 'catmullrom', 0.5);
        samplePoints = curve.getPoints(smoothSegments);
      }

      const pathGroup = new THREE.Group();

      // Determine if the path should be treated as closed. Foundry considers
      // polygons closed when they have a fill or when the first and last
      // points are equal.
      let isClosed = false;
      if (fillType) {
        isClosed = true;
      } else if (vertexCount >= 2) {
        const fx = pts[0];
        const fy = pts[1];
        const lx = pts[(vertexCount - 1) * 2];
        const ly = pts[(vertexCount - 1) * 2 + 1];
        isClosed = (fx === lx) && (fy === ly);
      }

      const segCount = isClosed ? samplePoints.length : samplePoints.length - 1;

      for (let i = 0; i < segCount; i++) {
        const p0 = samplePoints[i];
        const p1 = samplePoints[(i + 1) % samplePoints.length];

        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        let length = Math.sqrt(dx * dx + dy * dy);
        if (length <= 0.0001) continue;

        // Slightly over-extend each segment so neighbouring quads overlap,
        // avoiding tiny gaps at joins.
        length += thickness;

        const angle = Math.atan2(dy, dx);
        const segGeom = new THREE.PlaneGeometry(length, thickness);
        const segMat = new THREE.MeshBasicMaterial({
          color: new THREE.Color(color),
          transparent: strokeAlpha < 1.0,
          opacity: strokeAlpha,
          depthWrite: false,
          depthTest: false,
          side: THREE.DoubleSide
        });

        const segMesh = new THREE.Mesh(segGeom, segMat);
        segMesh.renderOrder = 1000;
        segMesh.position.set(
          (p0.x + p1.x) / 2,
          (p0.y + p1.y) / 2,
          0
        );
        segMesh.rotation.z = angle;
        pathGroup.add(segMesh);
      }

      group.add(pathGroup);
      return;
    }

    // Inset the rectangle by half the stroke width on each side, similar to
    // Foundry's use of lineWidth / 2 in _refreshShape.
    const innerWidth = Math.max(width - thickness, 0);
    const innerHeight = Math.max(height - thickness, 0);

    // Optional fill (solid color only, patterns are ignored for now)
    if (fillType && fillAlpha > 0) {
      const fillGeometry = new THREE.PlaneGeometry(innerWidth, innerHeight);
      const fillMaterial = new THREE.MeshBasicMaterial({
        color: new THREE.Color(fillColor),
        transparent: true,
        opacity: fillAlpha,
        depthTest: false,
        depthWrite: false
      });
      const fillMesh = new THREE.Mesh(fillGeometry, fillMaterial);
      fillMesh.renderOrder = 999;
      fillMesh.position.set(0, 0, 0);
      group.add(fillMesh);
    }

    // Border band: use a Shape with an inner hole so thickness is geometry,
    // not line width (WebGL lineWidth is effectively 1px).
    const halfW = width / 2;
    const halfH = height / 2;
    const innerHalfW = innerWidth / 2;
    const innerHalfH = innerHeight / 2;

    const outerShape = new THREE.Shape();
    outerShape.moveTo(-halfW, -halfH);
    outerShape.lineTo( halfW, -halfH);
    outerShape.lineTo( halfW,  halfH);
    outerShape.lineTo(-halfW,  halfH);
    outerShape.lineTo(-halfW, -halfH);

    // Inner hole (clockwise vs CCW is handled by ShapeGeometry)
    if (innerWidth > 0 && innerHeight > 0) {
      const innerPath = new THREE.Path();
      innerPath.moveTo(-innerHalfW, -innerHalfH);
      innerPath.lineTo( innerHalfW, -innerHalfH);
      innerPath.lineTo( innerHalfW,  innerHalfH);
      innerPath.lineTo(-innerHalfW,  innerHalfH);
      innerPath.lineTo(-innerHalfW, -innerHalfH);
      outerShape.holes.push(innerPath);
    }

    const borderGeometry = new THREE.ShapeGeometry(outerShape);
    const borderMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color),
      transparent: strokeAlpha < 1.0,
      opacity: strokeAlpha,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false
    });

    const borderMesh = new THREE.Mesh(borderGeometry, borderMaterial);
    borderMesh.renderOrder = 1000;
    borderMesh.position.set(0, 0, 0);
    group.add(borderMesh);
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
