import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { weatherController } from '../core/WeatherController.js';
import { VisionPolygonComputer } from '../vision/VisionPolygonComputer.js';
import { LightMesh } from '../scene/LightMesh.js';

const log = createLogger('CandleFlamesEffect');

export class CandleFlamesEffect extends EffectBase {
  constructor() {
    super('candle-flames', RenderLayers.ENVIRONMENTAL, 'low');

    this.priority = 8;

    this.params = {
      enabled: true,

      flamesEnabled: true,
      maxFlames: 5000,
      flameSizePx: 9.5,
      flameOpacity: 1.0,
      flameFlickerSpeed: 19.8,
      flameFlickerStrength: 0.9,
      flameSizeJitter: 0.18,
      flameFlickerSpeedJitter: 0.45,
      flameFlickerStrengthJitter: 0.35,
      flameOvality: 0.31,
      flameWobble: 0.24,
      flameWobbleSpeed: 5.95,
      draftiness: 0.12,
      outdoorWindInfluence: 0.66,
      outdoorSway: 0.25,

      glowEnabled: true,
      glowBucketSizePx: 384.0,
      glowMaxBuckets: 256,
      glowRadiusPx: 172.0,
      glowInnerRadiusScale: 0.2,
      glowIntensity: 0.42,
      glowFlickerStrength: 2.25,
      glowFlickerSpeed: 6.0,
      glowFlickerStrengthJitter: 0.75,
      glowFlickerSpeedJitter: 0.65,
      wallClipEnabled: true,

      indoorThreshold: 0.5,
      wallClipRadiusScale: 1.0,
    };

    this.renderer = null;
    this.scene = null;
    this.camera = null;

    this._mapPointsManager = null;
    this._changeListener = null;

    this._lightingEffect = null;

    this._group = null;
    this._flameMesh = null;
    this._flameMaterial = null;
    this._flameGeometry = null;

    this._dummy = null;

    this._attrPhase = null;
    this._attrOutdoor = null;
    this._attrIntensity = null;
    this._attrColor = null;

    this._phaseArray = null;
    this._outdoorArray = null;
    this._intensityArray = null;
    this._colorArray = null;

    this._visionComputer = new VisionPolygonComputer();

    this._glowGroup = null;
    this._glowBuckets = new Map();
    this._clusters = [];

    this._tempColor = null;

    this._hookIds = [];
    this._needsGlowRebuild = false;
    this._lastGlowRebuildAt = -Infinity;

    this._sourceFlameCount = 0;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'flames',
          label: 'Flames',
          type: 'folder',
          expanded: false,
          parameters: [
            'flamesEnabled',
            'maxFlames',
            'flameSizePx',
            'flameSizeJitter',
            'flameOpacity',
            'flameFlickerSpeed',
            'flameFlickerStrength',
            'flameFlickerSpeedJitter',
            'flameFlickerStrengthJitter',
            'flameOvality',
            'flameWobble',
            'flameWobbleSpeed',
            'draftiness',
            'outdoorWindInfluence',
            'outdoorSway'
          ]
        },
        {
          name: 'glow',
          label: 'Glow',
          type: 'folder',
          expanded: false,
          parameters: [
            'glowEnabled',
            'glowIntensity',
            'glowFlickerStrength',
            'glowFlickerSpeed',
            'glowFlickerStrengthJitter',
            'glowFlickerSpeedJitter',
            'glowRadiusPx',
            'glowInnerRadiusScale',
            'glowBucketSizePx',
            'glowMaxBuckets',
            'wallClipEnabled',
            'wallClipRadiusScale'
          ]
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },

        flamesEnabled: { type: 'boolean', default: true, label: 'Enabled' },
        maxFlames: { type: 'slider', min: 0, max: 20000, step: 250, default: 5000, label: 'Max Flames' },
        flameSizePx: { type: 'slider', min: 1, max: 64, step: 0.5, default: 9.5, label: 'Size (px)' },
        flameSizeJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.18, label: 'Size Jitter' },
        flameOpacity: { type: 'slider', min: 0, max: 2, step: 0.05, default: 1.0, label: 'Opacity' },
        flameFlickerSpeed: { type: 'slider', min: 0, max: 20, step: 0.25, default: 19.8, label: 'Flicker Speed' },
        flameFlickerStrength: { type: 'slider', min: 0, max: 1.5, step: 0.05, default: 0.9, label: 'Flicker Strength' },
        flameFlickerSpeedJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.45, label: 'Flicker Speed Jitter' },
        flameFlickerStrengthJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.35, label: 'Flicker Strength Jitter' },
        flameOvality: { type: 'slider', min: 0, max: 0.85, step: 0.01, default: 0.31, label: 'Ovality' },
        flameWobble: { type: 'slider', min: 0, max: 0.4, step: 0.01, default: 0.24, label: 'Wobble' },
        flameWobbleSpeed: { type: 'slider', min: 0, max: 6.0, step: 0.05, default: 5.95, label: 'Wobble Speed' },
        draftiness: { type: 'slider', min: 0, max: 0.4, step: 0.01, default: 0.12, label: 'Draftiness (Indoor)' },
        outdoorWindInfluence: { type: 'slider', min: 0, max: 1.0, step: 0.02, default: 0.66, label: 'Wind Influence (Outdoor)' },
        outdoorSway: { type: 'slider', min: 0, max: 0.25, step: 0.005, default: 0.25, label: 'Outdoor Sway' },

        glowEnabled: { type: 'boolean', default: true, label: 'Enabled' },
        glowIntensity: { type: 'slider', min: 0, max: 2.5, step: 0.01, default: 0.42, label: 'Intensity' },
        glowFlickerStrength: { type: 'slider', min: 0, max: 10.0, step: 0.05, default: 2.25, label: 'Flicker Strength' },
        glowFlickerSpeed: { type: 'slider', min: 0, max: 25.0, step: 0.1, default: 6.0, label: 'Flicker Speed' },
        glowFlickerStrengthJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.75, label: 'Flicker Strength Jitter' },
        glowFlickerSpeedJitter: { type: 'slider', min: 0, max: 1.0, step: 0.01, default: 0.65, label: 'Flicker Speed Jitter' },
        glowRadiusPx: { type: 'slider', min: 8, max: 1200, step: 2, default: 172.0, label: 'Radius (px)' },
        glowInnerRadiusScale: { type: 'slider', min: 0.05, max: 1.0, step: 0.01, default: 0.2, label: 'Inner Radius Scale' },
        glowBucketSizePx: { type: 'slider', min: 64, max: 2048, step: 16, default: 384.0, label: 'Bucket Size (px)' },
        glowMaxBuckets: { type: 'slider', min: 1, max: 512, step: 1, default: 256, label: 'Max Buckets' },
        wallClipEnabled: { type: 'boolean', default: true, label: 'Wall Clip' },
        wallClipRadiusScale: { type: 'slider', min: 0.1, max: 2.0, step: 0.01, default: 1.0, label: 'Clip Radius Scale' }
      }
    };
  }

  applyParamChange(paramId, value) {
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }

    if (paramId === 'enabled') {
      this._applyVisibility();
      if (this.params.enabled) {
        this._rebuildFromMapPoints();
      }
      return;
    }

    if (paramId === 'flameOpacity' && this._flameMaterial?.uniforms?.uOpacity) {
      this._flameMaterial.uniforms.uOpacity.value = this.params.flameOpacity;
    }

    if (paramId === 'flameFlickerSpeed' && this._flameMaterial?.uniforms?.uFlickerSpeed) {
      this._flameMaterial.uniforms.uFlickerSpeed.value = this.params.flameFlickerSpeed;
    }

    if (paramId === 'flameFlickerStrength' && this._flameMaterial?.uniforms?.uFlickerStrength) {
      this._flameMaterial.uniforms.uFlickerStrength.value = this.params.flameFlickerStrength;
    }

    if (paramId === 'flameFlickerSpeedJitter' && this._flameMaterial?.uniforms?.uFlickerSpeedJitter) {
      this._flameMaterial.uniforms.uFlickerSpeedJitter.value = this.params.flameFlickerSpeedJitter;
    }

    if (paramId === 'flameFlickerStrengthJitter' && this._flameMaterial?.uniforms?.uFlickerStrengthJitter) {
      this._flameMaterial.uniforms.uFlickerStrengthJitter.value = this.params.flameFlickerStrengthJitter;
    }

    if (paramId === 'flameSizeJitter') {
      this._rebuildFromMapPoints();
      return;
    }

    if (paramId === 'flameOvality' && this._flameMaterial?.uniforms?.uOvality) {
      this._flameMaterial.uniforms.uOvality.value = this.params.flameOvality;
    }

    if (paramId === 'flameWobble' && this._flameMaterial?.uniforms?.uWobble) {
      this._flameMaterial.uniforms.uWobble.value = this.params.flameWobble;
    }

    if (paramId === 'flameWobbleSpeed' && this._flameMaterial?.uniforms?.uWobbleSpeed) {
      this._flameMaterial.uniforms.uWobbleSpeed.value = this.params.flameWobbleSpeed;
    }

    if (paramId === 'draftiness' && this._flameMaterial?.uniforms?.uDraftiness) {
      this._flameMaterial.uniforms.uDraftiness.value = this.params.draftiness;
    }

    if (paramId === 'outdoorWindInfluence' && this._flameMaterial?.uniforms?.uOutdoorWindInfluence) {
      this._flameMaterial.uniforms.uOutdoorWindInfluence.value = this.params.outdoorWindInfluence;
    }

    if (paramId === 'outdoorSway' && this._flameMaterial?.uniforms?.uOutdoorSway) {
      this._flameMaterial.uniforms.uOutdoorSway.value = this.params.outdoorSway;
    }

    if (paramId === 'flamesEnabled') {
      this._setFlameCount(this.params.flamesEnabled ? this._sourceFlameCount : 0);
      return;
    }

    if (paramId === 'maxFlames') {
      this._createFlameMesh();
      if (this._group && this._flameMesh && !this._flameMesh.parent) {
        this._group.add(this._flameMesh);
      }
      this._rebuildFromMapPoints();
      return;
    }

    if (paramId === 'flameSizePx') {
      this._rebuildFromMapPoints();
      return;
    }

    if (paramId === 'glowEnabled') {
      if (!this.params.glowEnabled) {
        this._clearGlowBuckets();
      } else {
        this._rebuildFromMapPoints();
      }
      return;
    }

    if (paramId === 'glowIntensity') {
      return;
    }

    if (paramId === 'glowFlickerStrength' || paramId === 'glowFlickerSpeed' || paramId === 'glowFlickerStrengthJitter' || paramId === 'glowFlickerSpeedJitter') {
      return;
    }

    if (paramId === 'wallClipEnabled') {
      this._rebuildGlowMeshes();
      return;
    }

    if (
      paramId === 'glowBucketSizePx' ||
      paramId === 'glowMaxBuckets' ||
      paramId === 'glowRadiusPx' ||
      paramId === 'glowInnerRadiusScale' ||
      paramId === 'wallClipRadiusScale'
    ) {
      this._rebuildFromMapPoints();
      return;
    }
  }

  _applyVisibility() {
    const show = !!this.params.enabled;

    if (this._group) {
      this._group.visible = show;
    }

    if (this._flameMesh) {
      this._flameMesh.visible = show && !!this.params.flamesEnabled && (this._flameMesh.count > 0);
    }

    if (this._glowGroup) {
      this._glowGroup.visible = show && !!this.params.glowEnabled;
    }
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) return;

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this._tempColor = new THREE.Color();
    this._dummy = new THREE.Object3D();

    this._group = new THREE.Group();
    this._group.name = 'CandleFlames';
    this._group.renderOrder = 120;

    this._createFlameMesh();

    if (this._flameMesh) {
      this._group.add(this._flameMesh);
    }

    if (this.scene) {
      this.scene.add(this._group);
    }

    this._glowGroup = new THREE.Group();
    this._glowGroup.name = 'CandleGlow';

    this._registerWallHooks();

    log.info('CandleFlamesEffect initialized');
  }

  setLightingEffect(lightingEffect) {
    this._lightingEffect = lightingEffect || null;
    this._tryAttachGlowGroup();

    this._applyVisibility();
  }

  setMapPointsSources(manager) {
    const prev = this._mapPointsManager;
    if (this._changeListener && prev) {
      prev.removeChangeListener(this._changeListener);
    }

    this._mapPointsManager = manager || null;

    this._changeListener = () => {
      this._rebuildFromMapPoints();
    };

    if (this._mapPointsManager) {
      this._mapPointsManager.addChangeListener(this._changeListener);
    }

    this._rebuildFromMapPoints();
  }

  update(timeInfo) {
    if (!this.params.enabled) {
      this._applyVisibility();
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    this._tryAttachGlowGroup();

    if (this._flameMaterial?.uniforms?.uTime) {
      this._flameMaterial.uniforms.uTime.value = timeInfo.elapsed;
    }

    if (this._flameMaterial?.uniforms?.uOpacity) {
      this._flameMaterial.uniforms.uOpacity.value = this.params.flameOpacity;
    }

    if (this._flameMaterial?.uniforms?.uFlickerSpeed) {
      this._flameMaterial.uniforms.uFlickerSpeed.value = this.params.flameFlickerSpeed;
    }

    if (this._flameMaterial?.uniforms?.uFlickerStrength) {
      this._flameMaterial.uniforms.uFlickerStrength.value = this.params.flameFlickerStrength;
    }

    if (this._flameMaterial?.uniforms?.uFlickerSpeedJitter) {
      this._flameMaterial.uniforms.uFlickerSpeedJitter.value = this.params.flameFlickerSpeedJitter;
    }

    if (this._flameMaterial?.uniforms?.uFlickerStrengthJitter) {
      this._flameMaterial.uniforms.uFlickerStrengthJitter.value = this.params.flameFlickerStrengthJitter;
    }

    if (this._flameMaterial?.uniforms?.uOvality) {
      this._flameMaterial.uniforms.uOvality.value = this.params.flameOvality;
    }

    if (this._flameMaterial?.uniforms?.uWobble) {
      this._flameMaterial.uniforms.uWobble.value = this.params.flameWobble;
    }

    if (this._flameMaterial?.uniforms?.uWobbleSpeed) {
      this._flameMaterial.uniforms.uWobbleSpeed.value = this.params.flameWobbleSpeed;
    }

    if (this._flameMaterial?.uniforms?.uDraftiness) {
      this._flameMaterial.uniforms.uDraftiness.value = this.params.draftiness;
    }

    if (this._flameMaterial?.uniforms?.uOutdoorWindInfluence) {
      this._flameMaterial.uniforms.uOutdoorWindInfluence.value = this.params.outdoorWindInfluence;
    }

    if (this._flameMaterial?.uniforms?.uOutdoorSway) {
      this._flameMaterial.uniforms.uOutdoorSway.value = this.params.outdoorSway;
    }

    if (this._flameMaterial?.uniforms?.uWindSpeed) {
      let ws = 0.0;
      try {
        ws = Number(weatherController?.getCurrentState?.()?.windSpeed ?? weatherController?.currentState?.windSpeed ?? 0.0) || 0.0;
      } catch (_) {
        ws = 0.0;
      }
      this._flameMaterial.uniforms.uWindSpeed.value = Math.max(0.0, Math.min(1.0, ws));
    }

    if (this._flameMaterial?.uniforms?.uWindDir) {
      try {
        const state = weatherController?.getCurrentState?.() ?? weatherController?.currentState;
        const dir = state?.windDirection;
        if (dir && Number.isFinite(dir.x) && Number.isFinite(dir.y)) {
          this._flameMaterial.uniforms.uWindDir.value.set(dir.x, -dir.y);
        }
      } catch (_) {
      }
    }

    if (this._needsGlowRebuild && (timeInfo.elapsed - this._lastGlowRebuildAt) > 0.12) {
      this._rebuildGlowMeshes();
      this._needsGlowRebuild = false;
      this._lastGlowRebuildAt = timeInfo.elapsed;
    }

    this._updateGlowFlicker(timeInfo);
  }

  render() {
  }

  dispose() {
    try {
      if (this._mapPointsManager && this._changeListener) {
        this._mapPointsManager.removeChangeListener(this._changeListener);
      }
    } catch (_) {
    }

    for (const [hook, id] of this._hookIds) {
      try {
        Hooks.off(hook, id);
      } catch (_) {
      }
    }
    this._hookIds.length = 0;

    this._clearGlowBuckets();

    try {
      this._glowGroup?.removeFromParent?.();
    } catch (_) {
    }

    try {
      if (this._flameMesh) {
        this._flameMesh.removeFromParent();
      }
      if (this._flameGeometry) this._flameGeometry.dispose();
      if (this._flameMaterial) this._flameMaterial.dispose();
    } catch (_) {
    }

    try {
      this._group?.removeFromParent?.();
    } catch (_) {
    }

    this._flameMesh = null;
    this._flameGeometry = null;
    this._flameMaterial = null;
    this._group = null;
    this._glowGroup = null;

    super.dispose();
  }

  _registerWallHooks() {
    const safeOn = (hook, fn) => {
      try {
        const id = Hooks.on(hook, fn);
        this._hookIds.push([hook, id]);
      } catch (_) {
      }
    };

    const onWallChanged = () => {
      this._needsGlowRebuild = true;
    };

    safeOn('createWall', onWallChanged);
    safeOn('updateWall', onWallChanged);
    safeOn('deleteWall', onWallChanged);
  }

  _tryAttachGlowGroup() {
    const lightScene = this._lightingEffect?.lightScene;
    if (!lightScene || !this._glowGroup) return;

    if (this._glowGroup.parent !== lightScene) {
      try {
        this._glowGroup.removeFromParent();
      } catch (_) {
      }
      try {
        lightScene.add(this._glowGroup);
      } catch (_) {
      }
    }
  }

  _hash2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  }

  _getGroundZ() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer && typeof sceneComposer.groundZ === 'number') {
      return sceneComposer.groundZ;
    }
    return 1000;
  }

  _createFlameMesh() {
    const THREE = window.THREE;
    if (!THREE) return;

    if (this._flameMesh) {
      try {
        this._flameMesh.removeFromParent();
      } catch (_) {
      }
      this._flameMesh = null;
    }

    if (this._flameGeometry) {
      try {
        this._flameGeometry.dispose();
      } catch (_) {
      }
      this._flameGeometry = null;
    }

    if (this._flameMaterial) {
      try {
        this._flameMaterial.dispose();
      } catch (_) {
      }
      this._flameMaterial = null;
    }

    const geometry = new THREE.PlaneGeometry(1, 1, 1, 1);

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uOpacity: { value: this.params.flameOpacity },
        uFlickerSpeed: { value: this.params.flameFlickerSpeed },
        uFlickerStrength: { value: this.params.flameFlickerStrength },
        uFlickerSpeedJitter: { value: this.params.flameFlickerSpeedJitter },
        uFlickerStrengthJitter: { value: this.params.flameFlickerStrengthJitter },
        uOvality: { value: this.params.flameOvality },
        uWobble: { value: this.params.flameWobble },
        uWobbleSpeed: { value: this.params.flameWobbleSpeed },
        uDraftiness: { value: this.params.draftiness },
        uOutdoorWindInfluence: { value: this.params.outdoorWindInfluence },
        uOutdoorSway: { value: this.params.outdoorSway },
        uWindSpeed: { value: 0.0 },
        uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
      },
      vertexShader: `
        varying vec2 vUv;
        varying float vPhase;
        varying float vOutdoor;
        varying float vIntensity;
        varying vec3 vColor;

        uniform float uTime;
        uniform float uDraftiness;
        uniform float uOutdoorWindInfluence;
        uniform float uWindSpeed;
        uniform vec2 uWindDir;

        attribute float aPhase;
        attribute float aOutdoor;
        attribute float aIntensity;
        attribute vec3 aColor;

        void main() {
          vUv = uv;
          vPhase = aPhase;
          vOutdoor = aOutdoor;
          vIntensity = aIntensity;
          vColor = aColor;

          vec4 mvPosition = vec4(position, 1.0);
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif

          vec2 windDir = uWindDir;
          float windLen = length(windDir);
          if (windLen > 1e-4) windDir /= windLen;

          vec2 draftDir = vec2(sin(vPhase * 9.17), cos(vPhase * 6.11));
          float draftLen = length(draftDir);
          if (draftLen > 1e-4) draftDir /= draftLen;

          float outdoorMask = step(0.5, vOutdoor);
          float indoorMask = 1.0 - outdoorMask;

          float wiggle = 0.55 + 0.45 * sin(uTime * (2.1 + 0.9 * uWindSpeed) + vPhase * 6.2831);
          float swayOutdoor = outdoorMask * uOutdoorWindInfluence * uWindSpeed * wiggle;
          float swayIndoor = indoorMask * uDraftiness * wiggle;

          float top = clamp(vUv.y, 0.0, 1.0);
          vec2 offset = (windDir * swayOutdoor + draftDir * swayIndoor) * (top * top);
          mvPosition.xy += offset;

          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vPhase;
        varying float vOutdoor;
        varying float vIntensity;
        varying vec3 vColor;

        uniform float uTime;
        uniform float uOpacity;
        uniform float uFlickerSpeed;
        uniform float uFlickerStrength;
        uniform float uFlickerSpeedJitter;
        uniform float uFlickerStrengthJitter;
        uniform float uOutdoorSway;
        uniform float uOvality;
        uniform float uWobble;
        uniform float uWobbleSpeed;
        uniform float uWindSpeed;

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 78.233);
          return fract(p.x * p.y);
        }

        float smoothNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        void main() {
          vec2 uv = vUv;

          float sway = 0.0;
          if (vOutdoor > 0.5) {
            sway = uOutdoorSway * (sin(uTime * 1.7 + vPhase * 6.2831) * 0.5 + sin(uTime * 2.9 + vPhase * 9.1) * 0.5);
          }
          uv.x += sway;

          vec2 p = uv - vec2(0.5);

          float oval = clamp(uOvality, 0.0, 0.95);
          p.x *= (1.0 + oval);
          p.y *= (1.0 - 0.55 * oval);

          float wobbleSpeed = uWobbleSpeed;
          float wTime = uTime * wobbleSpeed + vPhase * 19.7;
          float wAmp = uWobble * (0.35 + 0.65 * (0.5 + 0.5 * uWindSpeed));

          vec2 wob = vec2(
            sin(wTime * 1.31 + p.y * 6.0),
            sin(wTime * 1.77 + p.x * 5.0)
          );
          p += wob * wAmp * (0.35 + 0.65 * p.y);
          float r = length(p) * 2.0;

          // Use vPhase (stable per candle) to vary flicker per-instance.
          float rand01 = fract(sin(vPhase * 43758.5453) * 43758.5453);
          float rand01b = fract(sin((vPhase + 0.37) * 31742.2341) * 9831.11);

          float sj = clamp(uFlickerSpeedJitter, 0.0, 1.0);
          float stj = clamp(uFlickerStrengthJitter, 0.0, 1.0);

          float speedVar = mix(1.0 - sj, 1.0 + sj, rand01);
          float strengthVar = mix(1.0 - stj, 1.0 + stj, rand01b);

          float flickerSpeed = uFlickerSpeed * speedVar;
          float flickerStrength = uFlickerStrength * strengthVar;

          float t = uTime * flickerSpeed + vPhase * 25.0;
          float n = smoothNoise(p * 6.0 + vec2(t * 0.15, t * 0.11));
          float wobble = mix(0.85, 1.25, n);
          r *= wobble;

          float alpha = smoothstep(1.0, 0.0, r);

          float core = smoothstep(0.35, 0.0, r);
          float mid = smoothstep(0.85, 0.25, r) * (1.0 - core);

          vec3 hot = vec3(1.0, 0.95, 0.85);
          vec3 warm = vec3(1.0, 0.65, 0.18);
          vec3 cool = vec3(1.0, 0.18, 0.02);

          vec3 col = mix(cool, warm, 1.0 - r);
          col = mix(col, hot, core);

          col *= vColor;

          float flickerBase = 0.9 + 0.1 * sin(t * 0.7 + vPhase * 2.0);
          float flickerShape = sin(t) * 0.65 + sin(t * 1.73 + 2.0) * 0.35;
          float flicker = flickerBase + flickerStrength * 0.35 * flickerShape;
          flicker = max(0.55, flicker);
          float finalAlpha = alpha * uOpacity * clamp(vIntensity, 0.0, 3.0) * flicker;

          if (finalAlpha <= 0.001) discard;

          gl_FragColor = vec4(col, finalAlpha);
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true
    });

    material.toneMapped = false;

    this._phaseArray = new Float32Array(this.params.maxFlames);
    this._outdoorArray = new Float32Array(this.params.maxFlames);
    this._intensityArray = new Float32Array(this.params.maxFlames);
    this._colorArray = new Float32Array(this.params.maxFlames * 3);

    this._attrPhase = new THREE.InstancedBufferAttribute(this._phaseArray, 1);
    this._attrOutdoor = new THREE.InstancedBufferAttribute(this._outdoorArray, 1);
    this._attrIntensity = new THREE.InstancedBufferAttribute(this._intensityArray, 1);
    this._attrColor = new THREE.InstancedBufferAttribute(this._colorArray, 3);

    this._attrPhase.setUsage(THREE.DynamicDrawUsage);
    this._attrOutdoor.setUsage(THREE.DynamicDrawUsage);
    this._attrIntensity.setUsage(THREE.DynamicDrawUsage);
    this._attrColor.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('aPhase', this._attrPhase);
    geometry.setAttribute('aOutdoor', this._attrOutdoor);
    geometry.setAttribute('aIntensity', this._attrIntensity);
    geometry.setAttribute('aColor', this._attrColor);

    const mesh = new THREE.InstancedMesh(geometry, material, this.params.maxFlames);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = 120;

    this._flameGeometry = geometry;
    this._flameMaterial = material;
    this._flameMesh = mesh;
  }

  _rebuildFromMapPoints() {
    if (!this._mapPointsManager) {
      this._sourceFlameCount = 0;
      this._setFlameCount(0);
      this._clusters.length = 0;
      this._clearGlowBuckets();
      return;
    }

    const groups = this._mapPointsManager.getGroupsByEffect('candleFlame');
    const points = [];
    for (const g of groups) {
      if (!g?.points?.length) continue;
      const intensity = (g.emission && typeof g.emission.intensity === 'number') ? g.emission.intensity : 1.0;
      for (const p of g.points) {
        if (!p) continue;
        points.push({ x: p.x, y: p.y, intensity });
      }
    }

    if (points.length === 0) {
      this._sourceFlameCount = 0;
      this._setFlameCount(0);
      this._clusters.length = 0;
      this._clearGlowBuckets();
      return;
    }

    const d = canvas?.dimensions;
    const sceneX = d?.sceneX ?? 0;
    const sceneY = d?.sceneY ?? 0;
    const sceneW = d?.sceneWidth ?? d?.width ?? 1;
    const sceneH = d?.sceneHeight ?? d?.height ?? 1;

    const groundZ = this._getGroundZ();

    const maxFlames = Math.max(0, this.params.maxFlames | 0);
    const flameSize = Math.max(1, this.params.flameSizePx);
    const sizeJitter = Math.max(0.0, Math.min(1.0, Number(this.params.flameSizeJitter) || 0.0));

    const baseR = 1.0;
    const baseG = 0.85;
    const baseB = 0.55;

    const buckets = new Map();
    const bucketSize = Math.max(32, this.params.glowBucketSizePx);

    let written = 0;

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      const wx = pt.x;
      const wy = pt.y;

      const foundryPt = Coordinates.toFoundry(wx, wy);
      const u = Math.max(0, Math.min(1, (foundryPt.x - sceneX) / sceneW));
      const v = Math.max(0, Math.min(1, (foundryPt.y - sceneY) / sceneH));
      let outdoor = 1.0;
      try {
        outdoor = weatherController.getRoofMaskIntensity(u, v);
      } catch (_) {
        outdoor = 1.0;
      }
      if (!Number.isFinite(outdoor)) outdoor = 1.0;
      outdoor = Math.max(0.0, Math.min(1.0, outdoor));

      const bx = Math.floor(wx / bucketSize);
      const by = Math.floor(wy / bucketSize);
      const key = `${bx},${by}`;

      let b = buckets.get(key);
      if (!b) {
        b = { sumX: 0, sumY: 0, sumI: 0, sumOutdoor: 0, count: 0 };
        buckets.set(key, b);
      }
      b.sumX += wx;
      b.sumY += wy;
      b.sumI += pt.intensity;
      b.sumOutdoor += outdoor;
      b.count += 1;

      if (written < maxFlames) {
        const phase = this._hash2(wx, wy);

        // Stable per-candle size variance (avoids synchronous “clone” look).
        const sizeRand = Math.sin((phase + 0.13) * 1000.0) * 43758.5453;
        const size01 = sizeRand - Math.floor(sizeRand);
        const sizeVar = 1.0 + (size01 * 2.0 - 1.0) * sizeJitter;
        const s = Math.max(1.0, flameSize * Math.max(0.2, sizeVar));

        this._dummy.position.set(wx, wy, groundZ + 3.5);
        this._dummy.rotation.set(0, 0, phase * Math.PI * 2);
        this._dummy.scale.set(s, s, 1);
        this._dummy.updateMatrix();
        this._flameMesh.setMatrixAt(written, this._dummy.matrix);

        this._phaseArray[written] = phase;
        this._outdoorArray[written] = outdoor;
        this._intensityArray[written] = pt.intensity;

        const cIdx = written * 3;
        this._colorArray[cIdx] = baseR;
        this._colorArray[cIdx + 1] = baseG;
        this._colorArray[cIdx + 2] = baseB;

        written++;
      }
    }

    this._sourceFlameCount = written;
    this._setFlameCount(this.params.flamesEnabled ? written : 0);

    this._clusters.length = 0;

    const maxBuckets = Math.max(1, this.params.glowMaxBuckets | 0);
    const list = [];
    for (const [key, b] of buckets.entries()) {
      if (!b || b.count <= 0) continue;
      list.push({ key, ...b });
    }

    list.sort((a, b) => (b.sumI - a.sumI) || (b.count - a.count));

    const take = Math.min(list.length, maxBuckets);

    const baseGlowColor = { r: 1.0, g: 0.72, b: 0.26 };

    for (let i = 0; i < take; i++) {
      const b = list[i];
      const cxWorld = b.sumX / b.count;
      const cyWorld = b.sumY / b.count;
      const avgOutdoor = b.sumOutdoor / b.count;
      const phase = this._hash2(cxWorld, cyWorld);

      const intensity = b.sumI / Math.max(1, b.count);

      const radiusPx = Math.max(32, this.params.glowRadiusPx * this.params.wallClipRadiusScale);

      const foundryCenter = Coordinates.toFoundry(cxWorld, cyWorld);

      this._clusters.push({
        key: b.key,
        cxWorld,
        cyWorld,
        cxFoundry: foundryCenter.x,
        cyFoundry: foundryCenter.y,
        radiusPx,
        intensity,
        phase,
        outdoor: avgOutdoor,
        color: baseGlowColor
      });
    }

    this._rebuildGlowMeshes();
  }

  _setFlameCount(n) {
    const THREE = window.THREE;
    if (!THREE || !this._flameMesh) return;

    const count = Math.max(0, Math.min(this.params.maxFlames | 0, n | 0));

    this._flameMesh.count = count;
    this._flameMesh.visible = !!this.params.flamesEnabled && count > 0;

    if (this._flameMesh.instanceMatrix) {
      this._flameMesh.instanceMatrix.needsUpdate = true;
    }

    if (this._attrPhase) this._attrPhase.needsUpdate = true;
    if (this._attrOutdoor) this._attrOutdoor.needsUpdate = true;
    if (this._attrIntensity) this._attrIntensity.needsUpdate = true;
    if (this._attrColor) this._attrColor.needsUpdate = true;
  }

  _clearGlowBuckets() {
    if (!this._glowGroup) return;

    for (const entry of this._glowBuckets.values()) {
      try {
        entry?.lightMesh?.dispose?.();
      } catch (_) {
      }

      try {
        entry?.lightMesh?.mesh?.removeFromParent?.();
      } catch (_) {
      }
    }

    this._glowBuckets.clear();

    try {
      while (this._glowGroup.children.length) {
        const c = this._glowGroup.children.pop();
        c?.removeFromParent?.();
      }
    } catch (_) {
    }
  }

  _rebuildGlowMeshes() {
    if (!this.params.glowEnabled) {
      this._clearGlowBuckets();
      return;
    }

    this._tryAttachGlowGroup();

    if (!this._glowGroup?.parent) {
      this._clearGlowBuckets();
      return;
    }

    this._clearGlowBuckets();

    const THREE = window.THREE;
    if (!THREE) return;

    const walls = canvas?.walls?.placeables ?? [];

    const d = canvas?.dimensions;
    const sceneX = d?.sceneX ?? 0;
    const sceneY = d?.sceneY ?? 0;
    const sceneW = d?.sceneWidth ?? d?.width ?? 1;
    const sceneH = d?.sceneHeight ?? d?.height ?? 1;

    const sceneBounds = { x: sceneX, y: sceneY, width: sceneW, height: sceneH };

    for (const c of this._clusters) {
      if (!c) continue;

      const cxFoundry = c.cxFoundry;
      const cyFoundry = c.cyFoundry;
      const radiusPx = c.radiusPx;

      let foundryPoly = null;
      if (this.params.wallClipEnabled) {
        try {
          foundryPoly = this._visionComputer.compute({ x: cxFoundry, y: cyFoundry }, radiusPx, walls, sceneBounds);
        } catch (_) {
          foundryPoly = null;
        }
      }

      const centerWorld = new THREE.Vector2(c.cxWorld, c.cyWorld);

      let worldPoints = null;
      if (foundryPoly && foundryPoly.length >= 6) {
        worldPoints = [];
        for (let i = 0; i < foundryPoly.length; i += 2) {
          const wp = Coordinates.toWorld(foundryPoly[i], foundryPoly[i + 1]);
          worldPoints.push(wp.x, wp.y);
        }
      }

      const innerRadiusPx = Math.max(1, radiusPx * this.params.glowInnerRadiusScale);

      const lm = new LightMesh(centerWorld, radiusPx, c.color, {
        innerRadiusPx,
        worldPoints,
        attenuation: 0.95
      });

      if (lm?.mesh) {
        lm.mesh.renderOrder = 90;
        this._glowGroup.add(lm.mesh);
      }

      const baseColor = new THREE.Color(c.color.r, c.color.g, c.color.b);

      this._glowBuckets.set(c.key, {
        lightMesh: lm,
        baseColor,
        intensity: c.intensity,
        phase: c.phase,
        outdoor: c.outdoor
      });
    }
  }

  _updateGlowFlicker(timeInfo) {
    if (!this.params.glowEnabled) return;
    if (!this._glowBuckets.size) return;

    const THREE = window.THREE;
    if (!THREE) return;

    const t = timeInfo.elapsed;

    const strength = Math.max(0.0, Number(this.params.glowFlickerStrength) || 0.0);
    const speed = Math.max(0.0, Number(this.params.glowFlickerSpeed) || 0.0);
    const speedJ = Math.max(0.0, Math.min(1.0, Number(this.params.glowFlickerSpeedJitter) || 0.0));
    const strengthJ = Math.max(0.0, Math.min(1.0, Number(this.params.glowFlickerStrengthJitter) || 0.0));

    for (const entry of this._glowBuckets.values()) {
      const lm = entry?.lightMesh;
      const u = lm?.material?.uniforms;
      if (!u?.uColor?.value) continue;

      const phase = entry.phase || 0;
      const outdoor = entry.outdoor || 1.0;

      // Stable per-bucket jitter so nearby candles can still share a glow bucket,
      // but buckets won’t flicker in perfect sync.
      const r1 = Math.sin((phase + 0.17) * 1000.0) * 43758.5453;
      const r2 = Math.sin((phase + 0.61) * 1000.0) * 24631.1337;
      const rand01 = r1 - Math.floor(r1);
      const rand01b = r2 - Math.floor(r2);
      const speedVar = 1.0 + (rand01 * 2.0 - 1.0) * speedJ;
      const strengthVar = 1.0 + (rand01b * 2.0 - 1.0) * strengthJ;

      const baseAmp = (outdoor > 0.5) ? 0.55 : 0.35;
      const baseSpd = (outdoor > 0.5) ? 1.25 : 0.95;

      const spd = (speed > 0 ? (speed * baseSpd) : (baseSpd * 6.0)) * Math.max(0.05, speedVar);

      const n1 = Math.sin(t * spd + phase * 6.2831);
      const n2 = Math.sin(t * (spd * 1.73) + phase * 11.7);
      const n3 = Math.sin(t * (spd * 2.91) + phase * 23.1);

      // Stronger, more chaotic candle-light flicker. This only affects the glow.
      const chaos = (0.55 * n1 + 0.30 * n2 + 0.15 * n3);
      const flicker = Math.max(0.05, 1.0 + (baseAmp * strength * Math.max(0.05, strengthVar)) * chaos);

      const mult = Math.max(0.0, this.params.glowIntensity * Math.max(0.25, entry.intensity) * flicker);

      this._tempColor.copy(entry.baseColor).multiplyScalar(mult);
      u.uColor.value.copy(this._tempColor);
    }
  }
}

export default CandleFlamesEffect;
