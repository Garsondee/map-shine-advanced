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

        // Use Drawing shape dimensions for placement, matching Foundry
        const shape = doc.shape || {};
        const width = shape.width || doc.width || 0;
        const height = shape.height || doc.height || 0;

        // Center of the drawing in Foundry coordinates (top-left origin, Y-down)
        const centerX = doc.x + width / 2;
        const centerY = doc.y + height / 2;

        // Convert to THREE world coordinates (Y-up) using scene height
        const sceneHeight = canvas.dimensions?.height || 10000;
        const worldY = sceneHeight - centerY;

        // Position the group at the world-space center. Z is inherited from parent group
        group.position.set(centerX, worldY, 0);

        // Apply rotation around the center. Foundry rotates clockwise in screen-space;
        // we negate here to account for Y-up vs Y-down.
        if (doc.rotation) {
            group.rotation.z = THREE.MathUtils.degToRad(-doc.rotation);
        }

        // 1. Text Rendering (centered in the drawing box)
        if (doc.text && (doc.fontSize || 0) > 0) {
            this.createText(doc, group, width, height);
        }
        
        // 2. Shape Rendering (Simple Outline)
        this.createShape(doc, group, width, height);

        // Visibility rules: mimic Foundry isVisible behavior
        const isGM = game.user?.isGM;
        const isAuthor = doc.isAuthor;
        const hidden = doc.hidden;
        group.visible = !hidden || isAuthor || isGM;

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
   * @param {number} width - Drawing box width
   * @param {number} height - Drawing box height
   */
  createText(doc, group, width, height) {
    // Create canvas for text
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const fontSize = doc.fontSize || 48;
    const fontFamily = doc.fontFamily || 'Arial';
    const color = doc.textColor || '#FFFFFF';
    const textAlpha = doc.textAlpha != null ? doc.textAlpha : 1.0;
    
    // Use the drawing box size for the text canvas so it matches Foundry's layout
    const canvasWidth = Math.max(Math.floor(width), 1);
    const canvasHeight = Math.max(Math.floor(height), 1);

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    
    ctx.font = `${fontSize}px ${fontFamily}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Basic implementation: single-line centered text
    ctx.fillText(doc.text, canvasWidth / 2, canvasHeight / 2);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;

    const material = new THREE.SpriteMaterial({ 
      map: texture, 
      transparent: true,
      opacity: textAlpha,
      depthTest: false // Keep text readable above shapes
    });
    const sprite = new THREE.Sprite(material);
    
    // Scale sprite to match the drawing box, centered at group origin
    sprite.scale.set(width, height, 1);
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
          depthTest: true,
          side: THREE.DoubleSide
        });

        const segMesh = new THREE.Mesh(segGeom, segMat);
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
        depthTest: true,
        depthWrite: false
      });
      const fillMesh = new THREE.Mesh(fillGeometry, fillMaterial);
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
      depthTest: true,
      depthWrite: false
    });

    const borderMesh = new THREE.Mesh(borderGeometry, borderMaterial);
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
