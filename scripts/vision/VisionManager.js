/**
 * @fileoverview Manages the real-time vision mask generation
 * Computes vision polygons ourselves using wall data (not Foundry's VisionSource)
 * @module vision/VisionManager
 */

import { createLogger } from '../core/log.js';
import { GeometryConverter } from './GeometryConverter.js';
import { VisionPolygonComputer } from './VisionPolygonComputer.js';

const log = createLogger('VisionManager');

// TEMPORARY KILL-SWITCH: Disable heavy vision polygon computation for perf testing.
// When true, we skip all polygon work but still render a full-visibility quad into
// the vision render target so downstream effects (FogEffect) continue to receive
// a valid mask and the scene remains fully visible.
const DISABLE_VISION_UPDATES = false;

export class VisionManager {
  /**
   * @param {THREE.Renderer} renderer
   * @param {number} width - Scene width
   * @param {number} height - Scene height
   */
  constructor(renderer, width, height) {
    this.renderer = renderer;
    this.width = width;
    this.height = height;
    
    this.converter = new GeometryConverter(width, height);
    this.computer = new VisionPolygonComputer();
    
    // Render Target for Vision Mask (RGBA is safer for compatibility than RedFormat)
    this.renderTarget = new window.THREE.WebGLRenderTarget(width, height, {
      format: window.THREE.RGBAFormat,
      minFilter: window.THREE.LinearFilter,
      magFilter: window.THREE.LinearFilter,
      type: window.THREE.UnsignedByteType,
      stencilBuffer: false,
      depthBuffer: false
    });

    // Scene Setup
    this.scene = new window.THREE.Scene();
    this.scene.background = new window.THREE.Color(0x000000); // Unseen is black

    // Camera matches the main scene camera (Orthographic)
    this.camera = new window.THREE.OrthographicCamera(
      width / -2, width / 2,
      height / 2, height / -2,
      0, 100
    );
    this.camera.position.z = 10;

    // Shared Material for Vision Polygons (White = Visible)
    this.material = new window.THREE.MeshBasicMaterial({ 
      color: 0xffffff,
      side: window.THREE.DoubleSide
    });

    // PERFORMANCE: Reuse a persistent full-visibility quad.
    // Creating/disposing PlaneGeometry repeatedly is unnecessary churn.
    this._fullQuadGeometry = new window.THREE.PlaneGeometry(width, height);
    this._fullQuadMesh = new window.THREE.Mesh(this._fullQuadGeometry, this.material);

    // State tracking
    this.needsUpdate = true;
    
    // Pending position updates from hooks (tokenId -> {x, y})
    // This stores the authoritative new positions from updateToken hooks
    this.pendingPositions = new Map();
    
    // CONTROLLED TOKENS: Only compute vision for tokens the user controls
    // This is the key to performance - we don't compute vision for ALL tokens
    this._controlledTokenIds = new Set();
    
    // Scene bounds for clipping vision (set from canvas.dimensions.sceneRect)
    this.sceneBounds = null;
    
    // PERFORMANCE: Throttle vision updates to avoid recomputing every animation frame.
    // refreshToken fires ~60 times/sec during token movement; we limit updates/sec.
    // T3-B: Adaptive throttle — fast during active token movement, slow when idle.
    this._lastUpdateTime = 0;
    this._updateThrottleMs = 200; // Current effective interval (adaptive)
    this._updateThrottleFastMs = 50; // Fast rate during active token movement
    this._updateThrottleIdleMs = 200; // Slow rate when idle
    this._visionActiveUntilMs = 0; // Timestamp until which fast rate is used
    this._visionActiveDurationMs = 600; // Duration to stay fast after last activity signal
    this._pendingThrottledUpdate = false;
    
    // PERFORMANCE: Reusable objects to avoid per-frame allocations
    this._tempCenter = { x: 0, y: 0 };
    this._tempSceneBounds = null;
    
    // Cache the last computed vision state to detect if we actually need to rerender
    this._lastVisionHash = null;

    /** @type {Array<[string, number]>} - Array of [hookName, hookId] tuples for proper cleanup */
    this._hookIds = [];
    
    // Register hooks
    this.setupHooks();
    
    log.info(`VisionManager initialized (self-computed vision): ${width}x${height}`);
  }

  setupHooks() {
    // Token hooks
    // Capture the changes object which contains the NEW position values
    // token.document may still have OLD values during the hook
    this._hookIds.push(['updateToken', Hooks.on('updateToken', (tokenDoc, changes) => { 
      // Only track position changes for controlled tokens
      if (this._controlledTokenIds.has(tokenDoc.id)) {
        if ('x' in changes || 'y' in changes) {
          this.pendingPositions.set(tokenDoc.id, {
            x: 'x' in changes ? changes.x : tokenDoc.x,
            y: 'y' in changes ? changes.y : tokenDoc.y
          });
        }
        this.needsUpdate = true;
      }
    })]);
    
    // CRITICAL: Track controlled tokens explicitly
    // This is the key hook for knowing which tokens to compute vision for
    this._hookIds.push(['controlToken', Hooks.on('controlToken', (token, controlled) => { 
      this._handleControlToken(token, controlled);
    })]);
    
    this._hookIds.push(['createToken', Hooks.on('createToken', () => { this.needsUpdate = true; })]);
    this._hookIds.push(['deleteToken', Hooks.on('deleteToken', (tokenDoc) => { 
      this.pendingPositions.delete(tokenDoc.id);
      this._controlledTokenIds.delete(tokenDoc.id);
      this.needsUpdate = true; 
    })]);
    
    // refreshToken fires during token animation frames - gives us smooth "in-between" vision
    // This updates the FOV as the token moves, producing more realistic sight lines
    // PERFORMANCE: Throttle these updates to avoid recomputing vision 60x/sec during animation.
    this._hookIds.push(['refreshToken', Hooks.on('refreshToken', (token) => {
      // Only update if this token is controlled AND has vision
      if (!this._controlledTokenIds.has(token.document?.id)) return;
      
      const gsm = window.MapShine?.gameSystem;
      const hasVision = gsm ? gsm.hasTokenVision(token) : (token.hasSight || token.document?.sight?.enabled);
      if (hasVision) {
        // Use the token's current animated position (token.x, token.y are the visual position)
        // This is different from token.document.x/y which is the final destination
        this.pendingPositions.set(token.document.id, {
          x: token.x,
          y: token.y
        });
        // Mark for throttled update instead of immediate
        this._pendingThrottledUpdate = true;
        // T3-B: Signal active vision — use fast throttle during token animation
        this._visionActiveUntilMs = performance.now() + this._visionActiveDurationMs;
      }
    })]);
    
    // Wall hooks - critical for self-computed vision
    this._hookIds.push(['createWall', Hooks.on('createWall', () => { this.needsUpdate = true; })]);
    this._hookIds.push(['updateWall', Hooks.on('updateWall', () => { this.needsUpdate = true; })]);
    this._hookIds.push(['deleteWall', Hooks.on('deleteWall', () => { this.needsUpdate = true; })]);
    
    // Scene hooks
    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => { 
      this.pendingPositions.clear();
      this._controlledTokenIds.clear();
      this._lastVisionHash = null;
      this.needsUpdate = true; 
    })]);
    
    // Legacy hooks (may still fire in some Foundry versions)
    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => { this.needsUpdate = true; })]);
    this._hookIds.push(['lightingRefresh', Hooks.on('lightingRefresh', () => { this.needsUpdate = true; })]);
  }

  /**
   * Handle controlToken hook - track which tokens are controlled
   * @param {Token} token - The token being controlled/released
   * @param {boolean} controlled - Whether the token is now controlled
   */
  _handleControlToken(token, controlled) {
    const tokenId = token.document?.id;
    if (!tokenId) return;
    
    if (controlled) {
      // Token is being selected
      this._controlledTokenIds.add(tokenId);
      log.debug(`Token controlled: ${tokenId}, total controlled: ${this._controlledTokenIds.size}`);
    } else {
      // Token is being deselected
      this._controlledTokenIds.delete(tokenId);
      this.pendingPositions.delete(tokenId);
      log.debug(`Token released: ${tokenId}, total controlled: ${this._controlledTokenIds.size}`);
    }
    
    // Always trigger update when selection changes
    this.needsUpdate = true;
  }

  /**
   * Set a pending position for a token (for drag preview updates)
   * @param {string} tokenId - The token ID
   * @param {number} x - Foundry X coordinate (top-left corner)
   * @param {number} y - Foundry Y coordinate (top-left corner)
   */
  setTokenPosition(tokenId, x, y) {
    if (!this._controlledTokenIds.has(tokenId)) return;
    this.pendingPositions.set(tokenId, { x, y });
    this._pendingThrottledUpdate = true;
    // T3-B: Signal active vision — use fast throttle during drag
    this._visionActiveUntilMs = performance.now() + this._visionActiveDurationMs;
  }

  /**
   * Force an immediate vision update (bypasses throttling)
   */
  forceUpdate() {
    this.needsUpdate = true;
  }

  /**
   * Sync controlled tokens from MapShine's InteractionManager
   * Called when we need to ensure our state matches the UI selection
   */
  syncControlledTokens() {
    const ms = window.MapShine;
    const interactionManager = ms?.interactionManager;
    const tokenManager = ms?.tokenManager;
    const selection = interactionManager?.selection;
    
    if (!selection || !tokenManager) {
      // Fallback to Foundry's controlled tokens
      const controlled = canvas?.tokens?.controlled || [];
      this._controlledTokenIds.clear();
      for (const token of controlled) {
        if (token.document?.id) {
          this._controlledTokenIds.add(token.document.id);
        }
      }
    } else {
      // Use MapShine's selection
      this._controlledTokenIds.clear();
      for (const id of selection) {
        // Only add if it's actually a token (not a light, wall, etc.)
        if (tokenManager.tokenSprites?.has(id)) {
          this._controlledTokenIds.add(id);
        }
      }
    }
    
    // Clear stale pending positions
    for (const id of this.pendingPositions.keys()) {
      if (!this._controlledTokenIds.has(id)) {
        this.pendingPositions.delete(id);
      }
    }
    
    this.needsUpdate = true;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    
    this.renderTarget.setSize(width, height);
    
    this.camera.left = width / -2;
    this.camera.right = width / 2;
    this.camera.top = height / 2;
    this.camera.bottom = height / -2;
    this.camera.updateProjectionMatrix();

    // Keep the cached full-visibility quad in sync with the render target size.
    try {
      this._fullQuadGeometry?.dispose?.();
    } catch (_) {
    }
    try {
      this._fullQuadGeometry = new window.THREE.PlaneGeometry(width, height);
      if (this._fullQuadMesh) this._fullQuadMesh.geometry = this._fullQuadGeometry;
    } catch (_) {
    }
    
    this.converter.resize(width, height);
    this.needsUpdate = true;
  }

  /**
   * Clear the vision scene, disposing geometries
   */
  clearScene() {
    while (this.scene.children.length > 0) {
      const child = this.scene.children[0];
      // Avoid disposing our cached quad geometry; we reuse it.
      if (child.geometry && child !== this._fullQuadMesh) child.geometry.dispose();
      this.scene.remove(child);
    }
  }

  /**
   * Update the vision mask if needed
   * Called by EffectComposer or main loop
   */
  update() {
    if (DISABLE_VISION_UPDATES) {
      // PERF MODE: Skip all polygon computation and just render a single
      // full-screen quad as "fully visible" once, then reuse that texture.
      if (this.needsUpdate) {
        this.clearScene();

        // Reuse cached quad.
        this.scene.add(this._fullQuadMesh);

        const currentTarget = this.renderer.getRenderTarget();
        this.renderer.setRenderTarget(this.renderTarget);
        this.renderer.clear();
        this.renderer.render(this.scene, this.camera);
        this.renderer.setRenderTarget(currentTarget);

        this.needsUpdate = false;
        this._pendingThrottledUpdate = false;
      }
      return;
    }
    
    // PERFORMANCE: Throttle updates from refreshToken to avoid 60fps vision recomputes.
    // Immediate updates (needsUpdate) from updateToken/createWall/etc. are not throttled.
    // T3-B: Adaptive throttle — fast during active token movement, slow when idle.
    if (!this.needsUpdate && this._pendingThrottledUpdate) {
      const now = performance.now();
      this._updateThrottleMs = (now < this._visionActiveUntilMs)
        ? this._updateThrottleFastMs
        : this._updateThrottleIdleMs;
      if (now - this._lastUpdateTime < this._updateThrottleMs) {
        // Too soon since last update, skip this frame
        return;
      }
      // Enough time has passed, allow the throttled update
      this.needsUpdate = true;
    }
    
    if (!this.needsUpdate) return;
    
    this._lastUpdateTime = performance.now();
    this._pendingThrottledUpdate = false;

    // 1. Clear Scene
    this.clearScene();

    const gsm = window.MapShine?.gameSystem;
    const walls = canvas?.walls?.placeables ?? [];
    
    // Get scene bounds for clipping vision to scene interior (not padded area)
    // canvas.dimensions.sceneRect is the actual scene, not including padding
    const sceneRect = canvas?.dimensions?.sceneRect;

    let sceneBounds = null;
    if (sceneRect) {
      if (!this._tempSceneBounds) this._tempSceneBounds = { x: 0, y: 0, width: 0, height: 0 };
      this._tempSceneBounds.x = sceneRect.x;
      this._tempSceneBounds.y = sceneRect.y;
      this._tempSceneBounds.width = sceneRect.width;
      this._tempSceneBounds.height = sceneRect.height;
      sceneBounds = this._tempSceneBounds;
    }

    let tokenCount = 0;

    // 2. Compute vision for CONTROLLED tokens with vision (not ALL tokens)
    // This is the key optimization - we only compute vision for tokens the user controls.
    const placeables = canvas?.tokens?.placeables ?? [];
    for (let ti = 0; ti < placeables.length; ti++) {
      const token = placeables[ti];
      const doc = token?.document;
      const tokenId = doc?.id;
      if (!tokenId) continue;

      // Skip hidden tokens
      if (doc?.hidden) continue;

      // Only process controlled tokens
      if (!this._controlledTokenIds.has(tokenId)) continue;

      // Check if token has vision
      const hasVision = gsm
        ? gsm.hasTokenVision(token)
        : (token.hasSight || doc?.sight?.enabled);
      if (!hasVision) continue;

      // Get vision radius
      let radiusPixels = 0;
      
      if (gsm) {
        const distRadius = gsm.getTokenVisionRadius(token);
        if (distRadius > 0) {
          radiusPixels = gsm.distanceToPixels(distRadius);
        }
      }
      
      // Fallback radius extraction
      if (!(radiusPixels > 0)) {
        const sightRange = doc?.sight?.range ?? token.sightRange ?? 0;
        if (sightRange > 0 && canvas?.dimensions) {
          radiusPixels = (sightRange / canvas.dimensions.distance) * canvas.dimensions.size;
        }
      }
      
      // If still no radius, try a default for tokens with hasSight
      if (!(radiusPixels > 0) && token.hasSight) {
        // Default to a large radius (1000 units converted to pixels)
        if (canvas?.dimensions) {
          radiusPixels = (1000 / canvas.dimensions.distance) * canvas.dimensions.size;
        } else {
          radiusPixels = 5000; // Fallback pixel value
        }
      }
      
      if (!(radiusPixels > 0)) continue;

      // Get token center - use pending position if available (from hook changes)
      // This fixes the "one step behind" issue where doc.x/y are stale during the hook
      const tokenWidth = (doc.width ?? 1) * (canvas.dimensions?.size ?? 100);
      const tokenHeight = (doc.height ?? 1) * (canvas.dimensions?.size ?? 100);
      
      // Check for pending position update (authoritative from hook)
      const pendingPos = this.pendingPositions.get(tokenId);
      const tokenX = pendingPos?.x ?? doc.x;
      const tokenY = pendingPos?.y ?? doc.y;

      const center = this._tempCenter;
      center.x = tokenX + tokenWidth / 2;
      center.y = tokenY + tokenHeight / 2;

      // MS-LVL-072: Read the token's elevation so the polygon computer can
      // skip walls whose wall-height bounds don't include this elevation.
      // This lets tokens on one floor see past walls that only exist on other floors.
      const tokenElevation = Number(doc.elevation ?? 0);
      const computeOptions = Number.isFinite(tokenElevation) && tokenElevation !== 0
        ? { elevation: tokenElevation }
        : null;

      // Compute visibility polygon using our own algorithm
      // Pass sceneBounds to clip vision to scene interior (not padded region)
      const points = this.computer.compute(center, radiusPixels, walls, sceneBounds, computeOptions);

      if (points && points.length >= 6) {
        const geometry = this.converter.toBufferGeometry(points);
        const mesh = new window.THREE.Mesh(geometry, this.material);
        this.scene.add(mesh);
        tokenCount++;
        
        // Log first few points for debugging
        if (Math.random() < 0.02) {
          const samplePoints = points.slice(0, 6);
          log.debug(`Vision computed for token at (${center.x.toFixed(0)}, ${center.y.toFixed(0)}): radius=${radiusPixels.toFixed(0)}px, points=${points.length / 2}, first3=[(${samplePoints[0]?.toFixed(0)}, ${samplePoints[1]?.toFixed(0)}), (${samplePoints[2]?.toFixed(0)}, ${samplePoints[3]?.toFixed(0)}), (${samplePoints[4]?.toFixed(0)}, ${samplePoints[5]?.toFixed(0)})]`);
        }
      }
    }

    // 4. If no tokens with vision, show entire scene (GM view or no vision tokens)
    if (tokenCount === 0) {
      this.scene.add(this._fullQuadMesh);
    }

    if (Math.random() < 0.01) {
      log.debug(`Vision Update: ${tokenCount} tokens processed, ${walls.length} walls`);
    }

    // 5. Render to Texture
    const currentTarget = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.renderTarget);
    this.renderer.clear(); // Clear to black
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(currentTarget); // Restore

    // DON'T clear pending positions here - they may still be needed for ongoing
    // animations or drags. They will be overwritten by new hook data anyway.
    // Only clear positions for tokens that are no longer controlled.
    for (const id of this.pendingPositions.keys()) {
      if (!this._controlledTokenIds.has(id)) {
        this.pendingPositions.delete(id);
      }
    }
    
    this.needsUpdate = false;
  }

  /**
   * Get the resulting vision texture
   * @returns {THREE.Texture}
   */
  getTexture() {
    return this.renderTarget.texture;
  }

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

    this.renderTarget.dispose();
    try {
      this._fullQuadGeometry?.dispose?.();
    } catch (_) {
    }
    this.material.dispose();
    // Geometry disposal is handled in update loop for now
  }
}
