/**
 * @fileoverview Enhanced light icon manager - syncs MapShine enhanced lights (scene flags)
 * to THREE.js icons for in-world editing.
 * @module scene/enhanced-light-icon-manager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { MapShineLightAdapter } from '../effects/MapShineLightAdapter.js';
import { VisionPolygonComputer } from '../vision/VisionPolygonComputer.js';

const log = createLogger('EnhancedLightIconManager');

const _gizmoLosComputer = new VisionPolygonComputer();
_gizmoLosComputer.circleSegments = 64;

/**
 * EnhancedLightIconManager - Synchronizes MapShine enhanced lights to THREE.js sprites.
 */
export class EnhancedLightIconManager {
  /**
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;

    /** @type {Map<string, THREE.Sprite>} */
    this.lights = new Map();

    /** @type {Map<string, THREE.Group>} */
    this.gizmos = new Map();

    /** @type {THREE.TextureLoader} */
    this.textureLoader = new THREE.TextureLoader();

    this.initialized = false;
    this.hooksRegistered = false;

    // Group for all enhanced light icons
    this.group = new THREE.Group();
    this.group.name = 'EnhancedLightIcons';
    this.group.position.z = 4.0;
    this.group.visible = false;
    this.scene.add(this.group);

    // Default icon. (We tint it blue-ish so it reads as "MapShine".)
    this.defaultIcon = 'icons/svg/light.svg';

    // Fallback geometry (used when LOS polygon is unavailable)
    this._fallbackCircleSegments = 64;

    log.debug('EnhancedLightIconManager created');
  }

  _computeLightLocalPolygon(foundryX, foundryY, radiusPx) {
    try {
      const r = Number(radiusPx);
      if (!Number.isFinite(r) || r <= 0) return null;

      const sceneRect = canvas?.dimensions?.sceneRect;
      const sceneBounds = sceneRect ? {
        x: sceneRect.x,
        y: sceneRect.y,
        width: sceneRect.width,
        height: sceneRect.height
      } : null;

      const ptsF = _gizmoLosComputer.compute({ x: foundryX, y: foundryY }, r, null, sceneBounds, { sense: 'light' });
      if (!ptsF || ptsF.length < 6) return null;

      const THREE = window.THREE;
      const centerW = Coordinates.toWorld(foundryX, foundryY);
      const local = [];
      for (let i = 0; i < ptsF.length; i += 2) {
        const w = Coordinates.toWorld(ptsF[i], ptsF[i + 1]);
        local.push(new THREE.Vector2(w.x - centerW.x, w.y - centerW.y));
      }

      return local.length >= 3 ? local : null;
    } catch (_) {
      return null;
    }
  }

  _dimToPixels(dim) {
    try {
      const d = canvas?.dimensions;
      if (!d || !Number.isFinite(d.size) || !Number.isFinite(d.distance) || d.distance === 0) return 0;
      const v = Number(dim);
      if (!Number.isFinite(v)) return 0;
      return v * (d.size / d.distance);
    } catch (_) {
      return 0;
    }
  }

  getRootObject(id) {
    const key = String(id);
    return this.gizmos.get(key) || this.lights.get(key) || null;
  }

  setSelected(id, selected) {
    const key = String(id);
    const g = this.gizmos.get(key);
    if (!g) return;

    const border = g.userData?.radiusBorder;
    const fill = g.userData?.radiusFill;
    const icon = this.lights.get(key);

    // IMPORTANT: Do not modify radius visuals (no tints, no opacity changes).
    // The radius ring is a neutral indicator only.
    void border;
    void fill;

    try {
      if (icon?.material) {
        // Keep the icon neutral; rely on scale for selection feedback.
        icon.material.color.set(0xffffff);
        icon.material.opacity = 1.0;
        icon.material.transparent = true;
      }

      // Slight size bump on selection so it reads clearly above the ring.
      const base = icon?.userData?.baseScale;
      if (icon && base && Number.isFinite(base.x) && Number.isFinite(base.y)) {
        const mul = selected ? 1.15 : 1.0;
        icon.scale.set(base.x * mul, base.y * mul, base.z ?? 1);
      }
    } catch (_) {
    }
  }

  /**
   * Hide/show the radius gizmo while a light is being dragged.
   * This avoids displaying a stale wall-clipped LOS polygon during movement.
   * @param {string} id
   * @param {boolean} dragging
   */
  setDragging(id, dragging) {
    const key = String(id);
    const g = this.gizmos.get(key);
    if (!g) return;

    g.userData = g.userData || {};
    g.userData.dragging = !!dragging;

    const fill = g.userData?.radiusFill;
    const border = g.userData?.radiusBorder;

    // Keep the icon visible for interaction/feedback, but hide the LOS-based radius.
    if (fill) fill.visible = !dragging;
    if (border) border.visible = !dragging;
  }

  /**
   * Recompute and rebuild the radius (LOS-clipped) gizmo geometry for a given object.
   * Designed to support throttled updates while dragging by operating on either:
   * - the authoritative gizmo group in this manager, or
   * - a drag preview clone created by InteractionManager.
   *
   * @param {THREE.Object3D} rootObject
   */
  refreshRadiusGeometry(rootObject) {
    try {
      if (!rootObject) return;

      const THREE = window.THREE;
      const foundryPos = Coordinates.toFoundry(rootObject.position.x, rootObject.position.y);
      const radiusPixels = Number(rootObject.userData?.radiusPixels);
      if (!Number.isFinite(radiusPixels) || radiusPixels <= 0) return;

      // Find the fill + border meshes on this object (works for both original + clones).
      let fill = null;
      let border = null;
      rootObject.traverse?.((obj) => {
        if (!obj?.userData?.type) return;
        if (obj.userData.type === 'enhancedLightRadiusFill') fill = obj;
        else if (obj.userData.type === 'enhancedLightRadiusBorder') border = obj;
      });

      if (!fill || !border) return;

      const localPoly = this._computeLightLocalPolygon(foundryPos.x, foundryPos.y, radiusPixels);
      let newFillGeometry;
      if (localPoly && localPoly.length >= 3) {
        const shape = new THREE.Shape(localPoly);
        newFillGeometry = new THREE.ShapeGeometry(shape);
      } else {
        newFillGeometry = new THREE.CircleGeometry(Math.max(radiusPixels, 0.0001), this._fallbackCircleSegments);
      }

      const newBorderGeometry = new THREE.EdgesGeometry(newFillGeometry);

      // Swap geometries (dispose old)
      try {
        fill.geometry?.dispose?.();
      } catch (_) {
      }
      fill.geometry = newFillGeometry;

      try {
        border.geometry?.dispose?.();
      } catch (_) {
      }
      border.geometry = newBorderGeometry;

      // Keep these visible when refreshing (drag preview may toggle them).
      fill.visible = true;
      border.visible = true;
    } catch (_) {
    }
  }

  /**
   * Initialize and set up hooks.
   */
  initialize() {
    if (this.initialized) return;

    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.group.position.z = groundZ + 4.0;

    this.setupHooks();
    this.syncAllLights();

    this.initialized = true;
    log.info(`EnhancedLightIconManager initialized at z=${this.group.position.z}`);
  }

  /**
   * Setup hooks to resync when scene flags change.
   * @private
   */
  setupHooks() {
    if (this.hooksRegistered) return;

    Hooks.on('canvasReady', () => {
      this.syncAllLights();
    });

    Hooks.on('updateScene', (sceneDoc, changes) => {
      try {
        if (!sceneDoc || !canvas?.scene) return;
        if (sceneDoc.id !== canvas.scene.id) return;

        const keys = changes && typeof changes === 'object' ? Object.keys(changes) : [];
        const flagKeyChanged = keys.some((k) => k === 'flags' || (typeof k === 'string' && k.startsWith('flags.map-shine-advanced')));
        const namespaceChanged = !!(changes?.flags && changes.flags['map-shine-advanced']);
        if (!flagKeyChanged && !namespaceChanged) return;

        this.syncAllLights();
      } catch (_) {
      }
    });

    this.hooksRegistered = true;
  }

  /**
   * Set visibility of all icons.
   * @param {boolean} visible
   */
  setVisibility(visible) {
    this.group.visible = visible;
  }

  /**
   * Sync all existing enhanced lights from scene flags.
   */
  syncAllLights() {
    const scene = canvas?.scene;
    if (!scene) return;

    // Remove old.
    for (const g of this.gizmos.values()) {
      this.group.remove(g);
      try {
        const icon = g.userData?.icon;
        if (icon?.material?.map) icon.material.map.dispose();
      } catch (_) {
      }

      try {
        const fill = g.userData?.radiusFill;
        fill?.geometry?.dispose?.();
        fill?.material?.dispose?.();
      } catch (_) {
      }

      try {
        const border = g.userData?.radiusBorder;
        border?.geometry?.dispose?.();
        border?.material?.dispose?.();
      } catch (_) {
      }

      try {
        const icon = g.userData?.icon;
        icon?.material?.dispose?.();
      } catch (_) {
      }
    }
    this.lights.clear();
    this.gizmos.clear();

    let entities = [];
    try {
      entities = MapShineLightAdapter.readEntities(scene);
    } catch (_) {
      entities = [];
    }

    for (const e of entities) {
      if (!e?.id) continue;
      this._createIconForEntity(e);
    }
  }

  /**
   * @param {import('../types.jsdoc').ILightEntity} entity
   * @private
   */
  _createIconForEntity(entity) {
    const id = String(entity.id);
    if (this.lights.has(id)) return;

    const THREE = window.THREE;

    const foundryX = entity.transform?.x ?? 0;
    const foundryY = entity.transform?.y ?? 0;
    const dim = entity.photometry?.dim ?? entity.raw?.photometry?.dim;
    const radiusPixels = Math.max(this._dimToPixels(dim), 0);

    const worldPos = Coordinates.toWorld(foundryX, foundryY);

    // Per-light group so we can keep a ground-plane radius ring + a billboard icon.
    const lightGroup = new THREE.Group();
    lightGroup.name = `EnhancedLightGizmo:${id}`;
    lightGroup.position.set(worldPos.x, worldPos.y, 0);
    lightGroup.renderOrder = 9997;

    // Radius fill must be fully invisible (no tinting / no wash over the scene).
    const fillMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.0,
      depthTest: false,
      depthWrite: false
    });
    // Avoid tonemapping/bloom interactions; this is an editor gizmo.
    fillMat.toneMapped = false;
    let fillGeometry;
    const localPoly = this._computeLightLocalPolygon(foundryX, foundryY, radiusPixels);
    if (localPoly && localPoly.length >= 3) {
      const shape = new THREE.Shape(localPoly);
      fillGeometry = new THREE.ShapeGeometry(shape);
    } else {
      fillGeometry = new THREE.CircleGeometry(Math.max(radiusPixels, 0.0001), this._fallbackCircleSegments);
    }
    const fill = new THREE.Mesh(fillGeometry, fillMat);
    fill.position.z = 0;
    fill.renderOrder = 9996;
    fill.userData = { ...(fill.userData || {}), type: 'enhancedLightRadiusFill', enhancedLightId: id };
    fill.visible = false;

    // Dim-radius border
    const borderMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      depthTest: false,
      depthWrite: false
    });
    borderMat.toneMapped = false;
    const borderGeometry = new THREE.EdgesGeometry(fillGeometry);
    const border = new THREE.LineSegments(borderGeometry, borderMat);
    border.position.z = 0.01;
    border.renderOrder = 9997;
    border.userData = { ...(border.userData || {}), type: 'enhancedLightRadiusBorder', enhancedLightId: id };

    // Icon sprite (billboard)
    const size = 48;
    const spriteMaterial = new THREE.SpriteMaterial({
      transparent: true,
      opacity: 1.0,
      color: 0xffffff,
      depthTest: false,
      depthWrite: false
    });
    spriteMaterial.toneMapped = false;
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.scale.set(size, size, 1);
    sprite.position.set(0, 0, 0.05);
    sprite.userData = { enhancedLightId: id, type: 'mapshineEnhancedLight', baseScale: { x: size, y: size, z: 1 } };
    sprite.renderOrder = 9998;

    lightGroup.add(fill);
    lightGroup.add(border);
    lightGroup.add(sprite);

    lightGroup.userData = {
      enhancedLightId: id,
      type: 'mapshineEnhancedLightGizmo',
      radiusFill: fill,
      radiusBorder: border,
      icon: sprite,
      radiusPixels
    };

    this.group.add(lightGroup);
    this.gizmos.set(id, lightGroup);
    this.lights.set(id, sprite);

    const iconPath = this.defaultIcon;
    this.textureLoader.load(iconPath, (texture) => {
      try {
        // Light might have been removed before the async load completes.
        if (!this.lights.has(id)) return;
        // Ensure correct color space so the icon reads properly.
        if ('colorSpace' in texture && THREE.SRGBColorSpace) {
          texture.colorSpace = THREE.SRGBColorSpace;
        }
        sprite.material.map = texture;
        sprite.material.needsUpdate = true;
      } catch (_) {
      }
    }, undefined, (err) => {
      log.warn('Failed to load enhanced light icon texture', err);
    });
  }

  /**
   * Dispose all resources.
   */
  dispose() {
    for (const g of this.gizmos.values()) {
      this.group.remove(g);
      try {
        const icon = g.userData?.icon;
        if (icon?.material?.map) icon.material.map.dispose();
      } catch (_) {
      }

      try {
        const fill = g.userData?.radiusFill;
        fill?.geometry?.dispose?.();
        fill?.material?.dispose?.();
      } catch (_) {
      }

      try {
        const border = g.userData?.radiusBorder;
        border?.geometry?.dispose?.();
        border?.material?.dispose?.();
      } catch (_) {
      }

      try {
        const icon = g.userData?.icon;
        icon?.material?.dispose?.();
      } catch (_) {
      }
    }
    this.gizmos.clear();
    this.lights.clear();

    this.scene.remove(this.group);
  }
}
