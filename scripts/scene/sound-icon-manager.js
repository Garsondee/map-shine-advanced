/**
 * @fileoverview Sound icon manager - syncs Foundry ambient sounds to THREE.js icons
 * Renders billboarded icons and audible-radius outlines for AmbientSound documents.
 * @module scene/sound-icon-manager
 */

import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { OVERLAY_THREE_LAYER } from '../core/render-layers.js';
import { VisionPolygonComputer } from '../vision/VisionPolygonComputer.js';
import { isSoundAudibleForPerspective } from '../foundry/elevation-context.js';

const log = createLogger('SoundIconManager');
const _soundLosComputer = new VisionPolygonComputer();
_soundLosComputer.circleSegments = 72;

function createOutlinedSpriteMaterial(texture) {
  const THREE = window.THREE;
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      outlineColor: { value: new THREE.Color(0x222222) },
      outlineWidth: { value: 0.08 },
      tintColor: { value: new THREE.Color(0xffffff) }
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        vec2 scale = vec2(
          length(modelMatrix[0].xyz),
          length(modelMatrix[1].xyz)
        );
        mvPosition.xy += position.xy * scale;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform vec3 outlineColor;
      uniform float outlineWidth;
      uniform vec3 tintColor;
      varying vec2 vUv;

      void main() {
        vec4 texColor = texture2D(map, vUv);
        float alpha = texColor.a;

        float outlineAlpha = 0.0;
        float step = outlineWidth;
        for (float x = -1.0; x <= 1.0; x += 1.0) {
          for (float y = -1.0; y <= 1.0; y += 1.0) {
            if (x == 0.0 && y == 0.0) continue;
            vec2 offset = vec2(x, y) * step;
            float neighborAlpha = texture2D(map, vUv + offset).a;
            outlineAlpha = max(outlineAlpha, neighborAlpha);
          }
        }

        float outline = clamp(outlineAlpha - alpha, 0.0, 1.0);
        vec3 iconColor = texColor.rgb * tintColor;
        vec3 finalColor = mix(iconColor, outlineColor, outline * 0.9);
        float finalAlpha = max(alpha, outline * 0.85);

        gl_FragColor = vec4(finalColor, finalAlpha);
      }
    `,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false
  });
}

export class SoundIconManager {
  constructor(scene) {
    this.scene = scene;

    /** @type {Map<string, THREE.Mesh>} */
    this.sounds = new Map();

    /** @type {THREE.TextureLoader} */
    this.textureLoader = new THREE.TextureLoader();

    this.initialized = false;
    this.hooksRegistered = false;

    /** @type {Array<[string, number]>} */
    this._hookIds = [];

    this.group = new THREE.Group();
    this.group.name = 'SoundIcons';
    this.group.position.z = 4.0;
    this.group.visible = false;
    this.group.layers.set(OVERLAY_THREE_LAYER);
    this.group.layers.enable(0);
    this.scene.add(this.group);

    log.debug('SoundIconManager created');
  }

  initialize() {
    if (this.initialized) return;

    this._ensureGroupInActiveRenderScene();

    const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;
    this.group.position.z = groundZ + 4.0;

    this.setupHooks();
    this.syncAllSounds();

    this.initialized = true;
    log.info(`SoundIconManager initialized at z=${this.group.position.z}`);
  }

  _getActiveRenderScene() {
    const busScene = window.MapShine?.effectComposer?._floorCompositorV2?._renderBus?._scene
      ?? window.MapShine?.floorRenderBus?._scene
      ?? null;
    return busScene || this.scene || null;
  }

  _ensureGroupInActiveRenderScene() {
    const targetScene = this._getActiveRenderScene();
    if (!targetScene || !this.group) return;
    if (this.group.parent === targetScene) return;

    try {
      if (this.group.parent) this.group.parent.remove(this.group);
      targetScene.add(this.group);
      this.scene = targetScene;
    } catch (_) {
    }
  }

  setupHooks() {
    if (this.hooksRegistered) return;

    this._hookIds.push(['createAmbientSound', Hooks.on('createAmbientSound', (doc) => this.create(doc))]);
    this._hookIds.push(['updateAmbientSound', Hooks.on('updateAmbientSound', (doc, changes) => this.update(doc, changes))]);
    this._hookIds.push(['deleteAmbientSound', Hooks.on('deleteAmbientSound', (doc) => this.remove(doc.id))]);

    this._hookIds.push(['canvasReady', Hooks.on('canvasReady', () => {
      this.syncAllSounds();
      this.refreshAllStates();
    })]);

    this._hookIds.push(['sightRefresh', Hooks.on('sightRefresh', () => this.refreshAllStates())]);
    this._hookIds.push(['mapShineLevelContextChanged', Hooks.on('mapShineLevelContextChanged', () => this.refreshAllStates())]);
    this._hookIds.push(['controlToken', Hooks.on('controlToken', () => this.refreshAllStates())]);

    this.hooksRegistered = true;
  }

  setVisibility(visible) {
    this._ensureGroupInActiveRenderScene();

    const sceneSoundCount = Number(canvas?.sounds?.placeables?.length || 0);
    if (sceneSoundCount > 0 && this.sounds.size === 0) {
      this.syncAllSounds();
    }

    this.group.visible = visible;
    if (visible) this.refreshAllStates();
  }

  _getSoundDocById(id) {
    try {
      return canvas?.scene?.sounds?.get?.(id)
        || canvas?.sounds?.placeables?.find?.((s) => s?.id === id)?.document
        || null;
    } catch (_) {
      return null;
    }
  }

  _isAudibleByCoreFallback(doc) {
    try {
      if (!doc) return true;
      if (doc.hidden) return false;
      const radius = Number(doc.radius ?? 0);
      if (!(radius > 0)) return false;
      const darkness = canvas?.darknessLevel;
      const min = Number(doc?.darkness?.min ?? 0);
      const max = Number(doc?.darkness?.max ?? 1);
      if (darkness?.between) return darkness.between(min, max);
      return true;
    } catch (_) {
      return true;
    }
  }

  _isSoundAudibleForIcon(doc) {
    // If Levels compatibility is active this adds floor/perspective filtering.
    const perspectiveAudible = isSoundAudibleForPerspective(doc);
    const coreAudible = this._isAudibleByCoreFallback(doc);
    return !!(perspectiveAudible && coreAudible);
  }

  _radiusToPixels(doc) {
    try {
      const d = canvas?.dimensions;
      if (!d || !Number.isFinite(d.distancePixels)) return 0;
      const radius = Number(doc?.radius ?? 0);
      return Number.isFinite(radius) ? Math.max(0, radius * d.distancePixels) : 0;
    } catch (_) {
      return 0;
    }
  }

  _computeRadiusLocalPolygon(foundryX, foundryY, radiusPx) {
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

      const ptsF = _soundLosComputer.compute({ x: foundryX, y: foundryY }, r, null, sceneBounds, { sense: 'sound' });
      if (!ptsF || ptsF.length < 6) return null;

      const THREE = window.THREE;
      const centerW = Coordinates.toWorld(foundryX, foundryY);
      const local = [];
      for (let i = 0; i < ptsF.length; i += 2) {
        const w = Coordinates.toWorld(ptsF[i], ptsF[i + 1]);
        local.push(new THREE.Vector3(w.x - centerW.x, w.y - centerW.y, 0));
      }

      return local.length >= 3 ? local : null;
    } catch (_) {
      return null;
    }
  }

  _findRadiusRing(id) {
    const key = String(id || '');
    if (!key || !this.group?.children) return null;
    return this.group.children.find((obj) => obj?.userData?.type === 'ambientSoundRadius' && String(obj?.userData?.soundId || '') === key) || null;
  }

  _removeRadiusRing(id) {
    const ring = this._findRadiusRing(id);
    if (!ring) return;
    try { this.group.remove(ring); } catch (_) {}
    try { ring.geometry?.dispose?.(); } catch (_) {}
    try { ring.material?.dispose?.(); } catch (_) {}
  }

  _upsertRadiusRingForDoc(doc) {
    const THREE = window.THREE;
    if (!THREE || !doc?.id) return;

    const soundId = String(doc.id);
    const radiusPixels = this._radiusToPixels(doc);

    if (!(radiusPixels > 0)) {
      this._removeRadiusRing(soundId);
      return;
    }

    const clippedPoints = this._computeRadiusLocalPolygon(doc.x, doc.y, radiusPixels);
    const points = [];
    if (clippedPoints && clippedPoints.length >= 3) {
      for (const p of clippedPoints) points.push(p);
    } else {
      const segments = 72;
      for (let i = 0; i < segments; i += 1) {
        const angle = (i / segments) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(angle) * radiusPixels, Math.sin(angle) * radiusPixels, 0));
      }
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const worldPos = Coordinates.toWorld(doc.x, doc.y);

    let ring = this._findRadiusRing(soundId);
    if (!ring) {
      const material = new THREE.LineBasicMaterial({
        color: 0xaaddff,
        transparent: true,
        opacity: 0.5,
        depthTest: false,
        depthWrite: false
      });
      material.toneMapped = false;

      ring = new THREE.LineLoop(geometry, material);
      ring.userData = { type: 'ambientSoundRadius', soundId };
      ring.layers.set(OVERLAY_THREE_LAYER);
      ring.layers.enable(0);
      ring.renderOrder = 9998;
      ring.position.set(worldPos.x, worldPos.y, 0.01);
      this.group.add(ring);
      return;
    }

    try { ring.geometry?.dispose?.(); } catch (_) {}
    ring.geometry = geometry;
    ring.position.set(worldPos.x, worldPos.y, ring.position.z);
  }

  refreshAllStates() {
    for (const [id, sprite] of this.sounds.entries()) {
      if (!sprite) continue;
      const doc = this._getSoundDocById(id);
      this._refreshSingleSoundState(id, doc);
    }
  }

  _refreshSingleSoundState(id, docOverride = null) {
    const sprite = this.sounds.get(id);
    if (!sprite) return;

    const doc = docOverride || this._getSoundDocById(id);
    const audible = this._isSoundAudibleForIcon(doc);
    const hiddenLike = !!(doc?.hidden || !doc?.path);

    try {
      if (sprite.material?.uniforms?.tintColor?.value?.setHex) {
        sprite.material.uniforms.tintColor.value.setHex(hiddenLike ? 0xff3300 : 0xffffff);
      }
    } catch (_) {
    }

    const ring = this._findRadiusRing(id);
    if (ring) {
      ring.visible = !hiddenLike;
      if (ring.material?.color?.setHex) {
        ring.material.color.setHex(hiddenLike ? 0xff3300 : (audible ? 0xaaddff : 0x777777));
      }
      ring.material.opacity = audible ? 0.5 : 0.25;
    }

    const nextIcon = audible ? CONFIG?.controlIcons?.sound : CONFIG?.controlIcons?.soundOff;
    const prevIcon = sprite.userData?.iconPath;
    if (nextIcon && nextIcon !== prevIcon) {
      this.textureLoader.load(nextIcon, (texture) => {
        try {
          const s = this.sounds.get(id);
          if (!s) return;
          const THREE = window.THREE;
          if ('colorSpace' in texture && THREE?.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
          if (s.material?.uniforms?.map) {
            s.material.uniforms.map.value = texture;
            s.material.needsUpdate = true;
          }
          s.userData.iconPath = nextIcon;
        } catch (_) {
        }
      });
    }
  }

  syncAllSounds() {
    if (!canvas.sounds) return;

    for (const sprite of this.sounds.values()) {
      this.group.remove(sprite);
      try {
        if (sprite?.material?.uniforms?.map?.value) sprite.material.uniforms.map.value.dispose();
      } catch (_) {}
      try { sprite?.geometry?.dispose?.(); } catch (_) {}
      try { sprite?.material?.dispose?.(); } catch (_) {}
    }
    this.sounds.clear();

    if (Array.isArray(this.group?.children)) {
      for (let i = this.group.children.length - 1; i >= 0; i -= 1) {
        const child = this.group.children[i];
        if (child?.userData?.type !== 'ambientSoundRadius') continue;
        this._removeRadiusRing(child.userData.soundId);
      }
    }

    for (const sound of canvas.sounds.placeables) {
      this.create(sound.document);
    }
  }

  create(doc) {
    if (!doc?.id || this.sounds.has(doc.id)) return;

    const iconPath = CONFIG?.controlIcons?.sound || 'icons/svg/sound.svg';

    this.textureLoader.load(iconPath, (texture) => {
      if (!canvas.sounds?.placeables?.some((s) => s.id === doc.id)) return;

      const THREE = window.THREE;
      const size = 48;

      try {
        if ('colorSpace' in texture && THREE?.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
      } catch (_) {}

      const material = createOutlinedSpriteMaterial(texture);
      const geometry = new THREE.PlaneGeometry(1, 1);
      const sprite = new THREE.Mesh(geometry, material);

      const worldPos = Coordinates.toWorld(doc.x, doc.y);
      sprite.position.set(worldPos.x, worldPos.y, 0);
      sprite.scale.set(size, size, 1);
      sprite.layers.set(OVERLAY_THREE_LAYER);
      sprite.layers.enable(0);
      sprite.renderOrder = 9999;
      sprite.userData = {
        soundId: doc.id,
        type: 'ambientSound',
        iconPath,
        baseScale: { x: size, y: size, z: 1 }
      };

      this.group.add(sprite);
      this.sounds.set(doc.id, sprite);

      this._upsertRadiusRingForDoc(doc);
      this._refreshSingleSoundState(doc.id, doc);
    }, undefined, (err) => {
      log.warn('Failed to load sound icon texture', err);
    });
  }

  update(doc, changes) {
    const sprite = this.sounds.get(doc.id);
    if (!sprite) {
      this.create(doc);
      return;
    }

    if (changes.x !== undefined || changes.y !== undefined) {
      const x = changes.x ?? doc.x;
      const y = changes.y ?? doc.y;
      const worldPos = Coordinates.toWorld(x, y);
      sprite.position.set(worldPos.x, worldPos.y, sprite.position.z);
    }

    this._upsertRadiusRingForDoc(doc);
    this._refreshSingleSoundState(doc.id, doc);
  }

  remove(id) {
    const sprite = this.sounds.get(id);
    if (sprite) {
      this.group.remove(sprite);
      try {
        if (sprite.material?.uniforms?.map?.value) sprite.material.uniforms.map.value.dispose();
      } catch (_) {}
      sprite.geometry?.dispose?.();
      sprite.material?.dispose?.();
      this.sounds.delete(id);
    }

    this._removeRadiusRing(id);
  }

  dispose() {
    try {
      if (this._hookIds && this._hookIds.length) {
        for (const [hookName, hookId] of this._hookIds) {
          try { Hooks.off(hookName, hookId); } catch (_) {}
        }
      }
    } catch (_) {
    }

    this._hookIds = [];
    this.hooksRegistered = false;

    for (const sprite of this.sounds.values()) {
      this.group.remove(sprite);
      try {
        if (sprite.material?.uniforms?.map?.value) sprite.material.uniforms.map.value.dispose();
      } catch (_) {}
      try { sprite.geometry?.dispose?.(); } catch (_) {}
      try { sprite.material?.dispose?.(); } catch (_) {}
    }

    if (Array.isArray(this.group?.children)) {
      for (let i = this.group.children.length - 1; i >= 0; i -= 1) {
        const child = this.group.children[i];
        if (child?.userData?.type !== 'ambientSoundRadius') continue;
        this._removeRadiusRing(child.userData.soundId);
      }
    }

    this.sounds.clear();
    this.scene.remove(this.group);
  }
}
