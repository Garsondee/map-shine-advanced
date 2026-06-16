/**
 * @fileoverview Frame-consistent camera and scene state snapshot
 * Provides a single authoritative source of truth for camera/view bounds per frame
 * Prevents desync between PIXI and Three.js during rapid camera movements
 * @module core/frame-state.js
 */

import { createLogger } from './log.js';
import {
  getViewProjectionCache,
  tickViewProjection,
  resolveGroundZ,
} from '../streaming/view-projection-service.js';

const log = createLogger('FrameState');

/**
 * Captures authoritative camera and scene state for a single frame
 * All screen-space effects should use this snapshot for consistent sampling
 */
export class FrameState {
  constructor() {
    // Camera position and bounds (world space)
    this.cameraX = 0;
    this.cameraY = 0;
    this.cameraZ = 0;
    
    // View bounds in world space (for screen-space reconstruction)
    this.viewMinX = 0;
    this.viewMinY = 0;
    this.viewMaxX = 1;
    this.viewMaxY = 1;
    
    // Zoom level (normalized, 1.0 = default)
    this.zoom = 1.0;
    
    // Screen dimensions
    this.screenWidth = 1;
    this.screenHeight = 1;
    
    // Scene bounds (world space, excluding padding)
    this.sceneX = 0;
    this.sceneY = 0;
    this.sceneWidth = 1;
    this.sceneHeight = 1;
    
    // Aspect ratio
    this.aspectRatio = 1.0;
    
    // Frame metadata
    this.frameNumber = 0;
    this.timestamp = 0;
    this.deltaTime = 0;
    
    // Camera matrices (for screen-space reconstruction)
    this.projectionMatrix = null;
    this.viewMatrix = null;
    this.invProjectionMatrix = null;
    this.invViewMatrix = null;
    
    // Change flags
    this.cameraChanged = false;
    this.zoomChanged = false;
    this.screenSizeChanged = false;
  }

  /**
   * Update frame state from camera and scene data
   * @param {THREE.Camera} camera - Three.js camera
   * @param {Object} sceneComposer - SceneComposer instance
   * @param {Object} canvas - Foundry canvas object
   * @param {number} frameNumber - Current frame number
   * @param {number} deltaTime - Time since last frame
   */
  update(camera, sceneComposer, canvas, frameNumber, deltaTime) {
    const prevCameraX = this.cameraX;
    const prevCameraY = this.cameraY;
    const prevZoom = this.zoom;
    const prevScreenWidth = this.screenWidth;
    const prevScreenHeight = this.screenHeight;

    // Update frame metadata
    this.frameNumber = frameNumber;
    this.timestamp = Date.now();
    this.deltaTime = deltaTime;

    // CameraFollower runs in the EffectComposer camera pipeline immediately before
    // this update. Prefer live PIXI stage zoom (authoritative for pan/zoom); keep
    // Three matrices/position for screen-space reconstruction.
    const stage = canvas?.stage;
    const pixiZoom = Number(stage?.scale?.x);
    const worldHeight = sceneComposer?.foundrySceneData?.height
      || canvas?.dimensions?.height
      || 1000;

    if (camera) {
      const pixiPivotX = Number(stage?.pivot?.x);
      const pixiPivotY = Number(stage?.pivot?.y);

      if (Number.isFinite(pixiPivotX) && Number.isFinite(pixiPivotY)) {
        this.cameraX = pixiPivotX;
        this.cameraY = worldHeight - pixiPivotY;
      } else {
        this.cameraX = camera.position.x;
        this.cameraY = camera.position.y;
      }

      this.cameraZ = camera.position.z;

      if (camera.projectionMatrix) {
        this.projectionMatrix = camera.projectionMatrix.clone();
      }
      if (camera.matrixWorldInverse) {
        this.viewMatrix = camera.matrixWorldInverse.clone();
      }
    }

    if (Number.isFinite(pixiZoom) && pixiZoom > 0) {
      this.zoom = pixiZoom;
      if (sceneComposer) {
        sceneComposer.currentZoom = pixiZoom;
      }
    } else if (sceneComposer) {
      this.zoom = sceneComposer.currentZoom ?? 1.0;
    }

    // Update screen dimensions
    if (canvas && canvas.app && canvas.app.renderer) {
      const size = new (window.THREE?.Vector2)();
      canvas.app.renderer.getDrawingBufferSize(size);
      this.screenWidth = size.width;
      this.screenHeight = size.height;
      this.aspectRatio = this.screenWidth / Math.max(1, this.screenHeight);
    }

    // Update scene bounds
    if (canvas && canvas.dimensions) {
      const sceneRect = canvas.dimensions.sceneRect || canvas.dimensions;
      this.sceneX = sceneRect.x ?? 0;
      this.sceneY = sceneRect.y ?? 0;
      this.sceneWidth = sceneRect.width ?? canvas.dimensions.width ?? 1;
      this.sceneHeight = sceneRect.height ?? canvas.dimensions.height ?? 1;
    }

    // Update view bounds (world space visible area) via canonical ground-plane raycast.
    this._updateViewBounds(camera, sceneComposer);

    // Detect changes
    this.cameraChanged = (
      this.cameraX !== prevCameraX ||
      this.cameraY !== prevCameraY
    );
    this.zoomChanged = this.zoom !== prevZoom;
    this.screenSizeChanged = (
      this.screenWidth !== prevScreenWidth ||
      this.screenHeight !== prevScreenHeight
    );
  }

  /**
   * Compute view bounds from camera
   * @private
   */
  _updateViewBounds(camera, sceneComposer = null) {
    if (!camera) return;

    const groundZ = Number(sceneComposer?.groundZ);
    const gz = Number.isFinite(groundZ) ? groundZ : resolveGroundZ();

    tickViewProjection(camera, gz);
    const cache = getViewProjectionCache();
    if (cache?.isValid) {
      this.viewMinX = cache.vMinX;
      this.viewMaxX = cache.vMaxX;
      this.viewMinY = cache.vMinY;
      this.viewMaxY = cache.vMaxY;
      return;
    }

    // Fallback: FOV box (legacy path if raycast fails).
    const THREE = window.THREE;
    if (!THREE) return;

    if (camera.isOrthographicCamera) {
      const camPos = camera.position;
      const zoom = camera.zoom || 1.0;
      this.viewMinX = camPos.x + camera.left / zoom;
      this.viewMaxX = camPos.x + camera.right / zoom;
      this.viewMinY = camPos.y + camera.bottom / zoom;
      this.viewMaxY = camPos.y + camera.top / zoom;
    } else if (camera.isPerspectiveCamera) {
      const dist = Math.max(1e-3, Math.abs((camera.position?.z ?? 0) - gz));
      const fovRad = ((Number(camera.fov) || 60) * Math.PI) / 180;
      const halfH = dist * Math.tan(fovRad * 0.5);
      const aspect = Number(camera.aspect) || 1;
      const halfW = halfH * aspect;
      this.viewMinX = camera.position.x - halfW;
      this.viewMaxX = camera.position.x + halfW;
      this.viewMinY = camera.position.y - halfH;
      this.viewMaxY = camera.position.y + halfH;
    }
  }

  /**
   * Convert screen UV to world space
   * @param {number} screenU - Screen U coordinate (0-1)
   * @param {number} screenV - Screen V coordinate (0-1)
   * @returns {Object} World space position {x, y}
   */
  screenUvToWorld(screenU, screenV) {
    const worldX = this.viewMinX + screenU * (this.viewMaxX - this.viewMinX);
    const worldY = this.viewMinY + screenV * (this.viewMaxY - this.viewMinY);
    return { x: worldX, y: worldY };
  }

  /**
   * Convert world space to screen UV
   * @param {number} worldX - World X coordinate
   * @param {number} worldY - World Y coordinate
   * @returns {Object} Screen UV {u, v}
   */
  worldToScreenUv(worldX, worldY) {
    const rangeX = this.viewMaxX - this.viewMinX;
    const rangeY = this.viewMaxY - this.viewMinY;
    const u = rangeX > 0 ? (worldX - this.viewMinX) / rangeX : 0.5;
    const v = rangeY > 0 ? (worldY - this.viewMinY) / rangeY : 0.5;
    return { u, v };
  }

  /**
   * Get statistics for debugging
   * @returns {Object} Stats object
   */
  getStats() {
    return {
      frameNumber: this.frameNumber,
      timestamp: this.timestamp,
      deltaTime: this.deltaTime,
      cameraPosition: { x: this.cameraX, y: this.cameraY, z: this.cameraZ },
      zoom: this.zoom,
      screenSize: { width: this.screenWidth, height: this.screenHeight },
      sceneRect: { x: this.sceneX, y: this.sceneY, width: this.sceneWidth, height: this.sceneHeight },
      viewBounds: { minX: this.viewMinX, minY: this.viewMinY, maxX: this.viewMaxX, maxY: this.viewMaxY },
      changes: {
        camera: this.cameraChanged,
        zoom: this.zoomChanged,
        screenSize: this.screenSizeChanged
      }
    };
  }
}

/**
 * Global singleton frame state
 * @type {FrameState|null}
 */
let globalFrameState = null;

/**
 * Get or create the global frame state
 * @returns {FrameState} Global frame state instance
 */
export function getGlobalFrameState() {
  if (!globalFrameState) {
    globalFrameState = new FrameState();
  }
  return globalFrameState;
}

/**
 * Reset the global frame state (for testing)
 */
export function resetGlobalFrameState() {
  globalFrameState = null;
}
