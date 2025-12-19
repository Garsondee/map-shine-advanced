import { EffectBase, RenderLayers } from '../effects/EffectComposer.js';
import { createLogger } from '../core/log.js';
import {
  ParticleSystem,
  IntervalValue,
  ColorRange,
  Vector4,
  RenderMode,
  ConstantValue,
  ApplyForce,
  CurlNoiseField
} from '../libs/three.quarks.module.js';

const log = createLogger('DustMotesEffect');

class DustFadeOverLifeBehavior {
  constructor(ownerEffect = null) {
    this.type = 'DustFadeOverLife';
    this.fadeInFraction = 0.25;
    this.fadeOutFraction = 0.25;
    this.ownerEffect = ownerEffect;
    this._brightness = 1.0;
    this._opacity = 1.0;
  }

  initialize(particle, system) {
    if (particle && particle.color) {
      particle._dustBaseAlpha = particle.color.w;
      particle._dustBaseR = particle.color.x;
      particle._dustBaseG = particle.color.y;
      particle._dustBaseB = particle.color.z;
    }
  }

  update(particle, delta, system) {
    if (!particle || !particle.color) return;
    if (typeof particle.age !== 'number' || typeof particle.life !== 'number') return;

    const life = Math.max(1e-6, particle.life);
    const t = Math.min(Math.max(particle.age / life, 0), 1);

    let envelope = 1.0;
    const fin = Math.max(1e-6, this.fadeInFraction);
    const fout = Math.max(1e-6, this.fadeOutFraction);

    if (t < fin) {
      envelope = t / fin;
    } else if (t > (1.0 - fout)) {
      envelope = (1.0 - t) / fout;
    }
    envelope = Math.min(Math.max(envelope, 0.0), 1.0);

    const baseA = (typeof particle._dustBaseAlpha === 'number') ? particle._dustBaseAlpha : particle.color.w;
    const baseR = (typeof particle._dustBaseR === 'number') ? particle._dustBaseR : particle.color.x;
    const baseG = (typeof particle._dustBaseG === 'number') ? particle._dustBaseG : particle.color.y;
    const baseB = (typeof particle._dustBaseB === 'number') ? particle._dustBaseB : particle.color.z;

    particle.color.x = baseR * this._brightness;
    particle.color.y = baseG * this._brightness;
    particle.color.z = baseB * this._brightness;
    particle.color.w = baseA * envelope * this._opacity;
  }

  frameUpdate(delta) {
    const p = this.ownerEffect?.params;
    const b = (p && typeof p.brightness === 'number') ? p.brightness : 1.0;
    const a = (p && typeof p.opacity === 'number') ? p.opacity : 1.0;
    this._brightness = Math.max(0.0, Math.min(10.0, b));
    this._opacity = Math.max(0.0, Math.min(1.0, a));
  }

  reset() { /* no-op */ }

  clone() {
    const b = new DustFadeOverLifeBehavior(this.ownerEffect);
    b.fadeInFraction = this.fadeInFraction;
    b.fadeOutFraction = this.fadeOutFraction;
    return b;
  }
}

class DustMaskShape {
  constructor(points, width, height, offsetX, offsetY, groundZ, worldTopZ, ownerEffect) {
    this.points = points;
    this.width = width;
    this.height = height;
    this.offsetX = offsetX;
    this.offsetY = offsetY;
    this.groundZ = groundZ;
    this.worldTopZ = worldTopZ;
    this.ownerEffect = ownerEffect;
    this.type = 'dust_mask';
  }

  initialize(p) {
    const count = this.points.length / 3;
    if (count <= 0) return;

    const idx = Math.floor(Math.random() * count) * 3;
    const u = this.points[idx];
    const v = this.points[idx + 1];
    const b = this.points[idx + 2];

    if (!Number.isFinite(u) || !Number.isFinite(v) || !Number.isFinite(b) || b <= 0.0) {
      if (typeof p.life === 'number') p.life = 0;
      if (p.color && typeof p.color.w === 'number') p.color.w = 0;
      if (typeof p.size === 'number') p.size = 0;
      return;
    }

    const params = this.ownerEffect?.params;
    const zMin = params && typeof params.zMin === 'number' ? params.zMin : 10;
    const zMax = params && typeof params.zMax === 'number' ? params.zMax : 140;
    const groundZ = (typeof this.groundZ === 'number') ? this.groundZ : 1000;
    const zRaw = groundZ + (zMin + Math.random() * Math.max(0, zMax - zMin));
    const worldTopZ = (typeof this.worldTopZ === 'number') ? this.worldTopZ : (groundZ + 7500);
    const z = Math.min(worldTopZ, zRaw);

    p.position.x = this.offsetX + u * this.width;
    p.position.y = this.offsetY + (1.0 - v) * this.height;
    p.position.z = z;

    const alphaScale = Math.max(0.05, Math.min(1.0, b));
    if (p.color && typeof p.color.w === 'number') {
      p.color.w *= alphaScale;
    }
    if (typeof p.size === 'number') {
      p.size *= (0.6 + 0.4 * alphaScale);
    }

    if (p.velocity) {
      p.velocity.set(0, 0, 0);
    }
  }

  update(system, delta) {
  }
}

export class DustMotesEffect extends EffectBase {
  constructor() {
    super('dust', RenderLayers.PARTICLES, 'low');

    this.priority = 2;
    this.alwaysRender = false;
    this.enabled = false;

    this.scene = null;
    this.renderer = null;
    this.camera = null;

    this.batchRenderer = null;

    this.params = {
      enabled: false,

      density: 0.7,
      maxParticles: 3000,

      brightness: 0.75,
      opacity: 0.6,

      lifeMin: 5.0,
      lifeMax: 15.0,

      sizeMin: 4.0,
      sizeMax: 16.0,

      zMin: 10.0,
      zMax: 140.0,

      motionDrift: 4.0,
      motionCurlStrength: 8.0,
      motionCurlScale: 380.0,

      baseDarkness: 0.88,

      lightMin: 0.05,
      lightMax: 0.25,
      lightIntensity: 0.8,
      lightTintInfluence: 0.65,

      debugShowLight: false,
      debugForceVisible: false
    };

    this._assetBundle = null;

    this._dustMask = null;
    this._structuralMask = null;
    this._outdoorsMask = null;

    this._spawnPoints = null;

    this._system = null;
    this._material = null;
    this._batchMaterial = null;

    this._particleTexture = null;

    this._needsRebuild = false;

    this._tmpSceneBounds = null;
    this._lastSceneBoundsKey = null;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'dust',
          label: 'Dust Motes',
          type: 'inline',
          parameters: ['density', 'maxParticles']
        },
        {
          name: 'appearance',
          label: 'Appearance',
          type: 'inline',
          separator: true,
          parameters: ['brightness', 'opacity']
        },
        {
          name: 'lifetime',
          label: 'Lifetime & Size',
          type: 'inline',
          separator: true,
          parameters: ['lifeMin', 'lifeMax', 'sizeMin', 'sizeMax']
        },
        {
          name: 'volume',
          label: 'Volume',
          type: 'inline',
          separator: true,
          parameters: ['zMin', 'zMax']
        },
        {
          name: 'motion',
          label: 'Motion',
          type: 'inline',
          separator: true,
          parameters: ['motionDrift', 'motionCurlStrength', 'motionCurlScale']
        },
        {
          name: 'window',
          label: 'Window Light Coupling',
          type: 'inline',
          separator: true,
          parameters: ['baseDarkness', 'lightMin', 'lightMax', 'lightIntensity', 'lightTintInfluence']
        },
        {
          name: 'debug',
          label: 'Debug',
          type: 'inline',
          separator: true,
          parameters: ['debugShowLight', 'debugForceVisible']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: false },
        density: { type: 'slider', label: 'Density', min: 0.0, max: 3.0, step: 0.05, default: 1.0, throttle: 50 },
        maxParticles: { type: 'slider', label: 'Max Particles', min: 0, max: 20000, step: 100, default: 4000, throttle: 50 },
        brightness: { type: 'slider', label: 'Brightness', min: 0.0, max: 3.0, step: 0.05, default: 1.0, throttle: 50 },
        opacity: { type: 'slider', label: 'Opacity', min: 0.0, max: 1.0, step: 0.01, default: 1.0, throttle: 50 },
        lifeMin: { type: 'slider', label: 'Life Min (s)', min: 0.2, max: 30.0, step: 0.1, default: 4.0, throttle: 50 },
        lifeMax: { type: 'slider', label: 'Life Max (s)', min: 0.2, max: 30.0, step: 0.1, default: 12.0, throttle: 50 },
        sizeMin: { type: 'slider', label: 'Size Min', min: 0.1, max: 80.0, step: 0.5, default: 6.0, throttle: 50 },
        sizeMax: { type: 'slider', label: 'Size Max', min: 0.1, max: 120.0, step: 0.5, default: 20.0, throttle: 50 },
        zMin: { type: 'slider', label: 'Z Min', min: 0.0, max: 800.0, step: 1.0, default: 10.0, throttle: 50 },
        zMax: { type: 'slider', label: 'Z Max', min: 0.0, max: 1200.0, step: 1.0, default: 140.0, throttle: 50 },
        motionDrift: { type: 'slider', label: 'Drift', min: 0.0, max: 80.0, step: 0.5, default: 6.0, throttle: 50 },
        motionCurlStrength: { type: 'slider', label: 'Curl Strength', min: 0.0, max: 200.0, step: 1.0, default: 12.0, throttle: 50 },
        motionCurlScale: { type: 'slider', label: 'Curl Scale', min: 10.0, max: 2000.0, step: 10.0, default: 380.0, throttle: 50 },
        baseDarkness: { type: 'slider', label: 'Base Darkness', min: 0.0, max: 1.0, step: 0.01, default: 0.92, throttle: 50 },
        lightMin: { type: 'slider', label: 'Light Min', min: 0.0, max: 1.0, step: 0.01, default: 0.05, throttle: 50 },
        lightMax: { type: 'slider', label: 'Light Max', min: 0.0, max: 1.0, step: 0.01, default: 0.35, throttle: 50 },
        lightIntensity: { type: 'slider', label: 'Light Intensity', min: 0.0, max: 3.0, step: 0.01, default: 1.0, throttle: 50 },
        lightTintInfluence: { type: 'slider', label: 'Tint Influence', min: 0.0, max: 1.0, step: 0.01, default: 0.65, throttle: 50 },
        debugShowLight: { type: 'boolean', label: 'Show Light Sample', default: false },
        debugForceVisible: { type: 'boolean', label: 'Force Visible', default: false }
      }
    };
  }

  initialize(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const particleSystem = window.MapShineParticles;
    if (particleSystem && particleSystem.batchRenderer) {
      this.batchRenderer = particleSystem.batchRenderer;
    } else {
      log.warn('BatchedRenderer not available, dust will not render');
      this.enabled = false;
    }

    this._ensureParticleTexture();

    log.info('DustMotesEffect initialized');
  }

  _ensureParticleTexture() {
    const THREE = window.THREE;
    if (!THREE) return null;
    if (this._particleTexture) return this._particleTexture;

    try {
      const texture = new THREE.TextureLoader().load('modules/map-shine-advanced/assets/particle.webp');
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.needsUpdate = true;
      this._particleTexture = texture;
      return texture;
    } catch (e) {
      return null;
    }
  }

  setAssetBundle(bundle) {
    this._assetBundle = bundle || null;

    const masks = bundle?.masks;
    this._dustMask = masks?.find(m => m.id === 'dust' || m.type === 'dust')?.texture || null;
    this._structuralMask = masks?.find(m => m.id === 'structural' || m.type === 'structural')?.texture || null;
    this._outdoorsMask = masks?.find(m => m.id === 'outdoors' || m.type === 'outdoors')?.texture || null;

    this._spawnPoints = this._generatePoints(this._dustMask, this._structuralMask, this._outdoorsMask);
    this._needsRebuild = true;
  }

  applyParamChange(paramId, value) {
    if (!this.params) return;
    if (paramId === 'enabled' || paramId === 'masterEnabled') {
      this.enabled = !!value;
      this.params.enabled = !!value;
      if (this.enabled) {
        this._needsRebuild = true;
      }
      return;
    }

    if (Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
      const requiresRebuild = [
        'density',
        'maxParticles',
        'lifeMin',
        'lifeMax',
        'sizeMin',
        'sizeMax',
        'motionDrift',
        'motionCurlStrength',
        'motionCurlScale'
      ].includes(paramId);

      if (requiresRebuild) {
        this._needsRebuild = true;
      }
    }
  }

  _generatePoints(dustTexture, structuralTexture, outdoorsTexture) {
    if (!dustTexture || !dustTexture.image) {
      return null;
    }

    const dustImage = dustTexture.image;
    const structuralImage = structuralTexture?.image || null;
    const outdoorsImage = outdoorsTexture?.image || null;

    const w = dustImage.width || 0;
    const h = dustImage.height || 0;
    if (w <= 0 || h <= 0) {
      return null;
    }

    const dustCanvas = document.createElement('canvas');
    dustCanvas.width = w;
    dustCanvas.height = h;
    const dustCtx = dustCanvas.getContext('2d');
    if (!dustCtx) return null;
    dustCtx.drawImage(dustImage, 0, 0);
    const dustData = dustCtx.getImageData(0, 0, w, h).data;

    let structuralData = null;
    let structuralW = 0;
    let structuralH = 0;
    if (structuralImage && structuralImage.width && structuralImage.height) {
      const c = document.createElement('canvas');
      c.width = structuralImage.width;
      c.height = structuralImage.height;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(structuralImage, 0, 0);
        structuralData = ctx.getImageData(0, 0, c.width, c.height).data;
        structuralW = c.width;
        structuralH = c.height;
      }
    }

    let outdoorsData = null;
    let outdoorsW = 0;
    let outdoorsH = 0;
    if (outdoorsImage && outdoorsImage.width && outdoorsImage.height) {
      const c = document.createElement('canvas');
      c.width = outdoorsImage.width;
      c.height = outdoorsImage.height;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.drawImage(outdoorsImage, 0, 0);
        outdoorsData = ctx.getImageData(0, 0, c.width, c.height).data;
        outdoorsW = c.width;
        outdoorsH = c.height;
      }
    }

    const coords = [];

    const threshold = 0.12;
    const stride = Math.max(1, Math.floor(Math.sqrt((w * h) / 25000)));

    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        const idx = (y * w + x) * 4;

        const d = dustData[idx] / 255.0;
        if (d <= threshold) continue;

        let s = 1.0;
        if (structuralData && structuralW > 1 && structuralH > 1) {
          const sx = Math.floor((x / (w - 1)) * (structuralW - 1));
          const sy = Math.floor((y / (h - 1)) * (structuralH - 1));
          const sIdx = (sy * structuralW + sx) * 4;
          s = structuralData[sIdx] / 255.0;
          if (s <= 0.05) continue;
        }

        if (outdoorsData && outdoorsW > 1 && outdoorsH > 1) {
          const ox = Math.floor((x / (w - 1)) * (outdoorsW - 1));
          const oy = Math.floor((y / (h - 1)) * (outdoorsH - 1));
          const oIdx = (oy * outdoorsW + ox) * 4;
          const outdoor = outdoorsData[oIdx] / 255.0;
          if (outdoor > 0.5) continue;
        }

        const u = x / (w - 1);
        const v = y / (h - 1);
        const b = Math.min(1.0, d * s);
        coords.push(u, v, b);
      }
    }

    if (coords.length === 0) {
      return null;
    }

    return new Float32Array(coords);
  }

  _disposeSystem() {
    if (this._system && this.batchRenderer) {
      try {
        this.batchRenderer.deleteSystem(this._system);
      } catch (e) {
      }
      try {
        if (this._system.emitter && this._system.emitter.parent) {
          this._system.emitter.parent.remove(this._system.emitter);
        }
      } catch (e) {
      }
    }

    this._system = null;
    this._material = null;
    this._batchMaterial = null;
  }

  _rebuildSystem() {
    if (!this.batchRenderer || !this.scene) return;

    if (!this.params.enabled || !this._spawnPoints || this._spawnPoints.length < 3) {
      return;
    }

    const THREE = window.THREE;
    if (!THREE) return;

    const tex = this._ensureParticleTexture();
    if (!tex) return;

    const d = canvas?.dimensions;
    const width = d?.sceneWidth;
    const height = d?.sceneHeight;
    const sx = d?.sceneX;
    const sceneY = d?.sceneY;
    const fullH = d?.height;

    // If we don't have valid scene dimensions yet (common during early init),
    // don't build a system with fallback sizes (it can place particles off-map).
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 1 || height <= 1) {
      return;
    }
    if (!Number.isFinite(sx) || !Number.isFinite(sceneY) || !Number.isFinite(fullH) || fullH <= 1) {
      return;
    }

    const sy = fullH - sceneY - height;
    const sceneBoundsKey = `${sx},${sy},${width},${height},${fullH}`;

    // If we're already built for the current bounds and not explicitly marked dirty, skip.
    if (!this._needsRebuild && this._system && this._lastSceneBoundsKey === sceneBoundsKey) {
      return;
    }

    this._disposeSystem();

    const sceneComposer = window.MapShine?.sceneComposer;
    const groundZ = (sceneComposer && typeof sceneComposer.groundZ === 'number') ? sceneComposer.groundZ : 1000;
    const worldTopZ = (sceneComposer && typeof sceneComposer.worldTopZ === 'number') ? sceneComposer.worldTopZ : (groundZ + 7500);

    const shape = new DustMaskShape(this._spawnPoints, width, height, sx, sy, groundZ, worldTopZ, this);

    const material = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
      depthTest: false,
      color: 0xffffff
    });

    const p = this.params;

    const lifeMin = Math.max(0.01, p.lifeMin ?? 4.0);
    const lifeMax = Math.max(lifeMin, p.lifeMax ?? 12.0);

    const sizeMin = Math.max(0.1, p.sizeMin ?? 6.0);
    const sizeMax = Math.max(sizeMin, p.sizeMax ?? 20.0);

    const alpha = 0.35;
    const startColor = new ColorRange(
      new Vector4(0.15, 0.15, 0.15, alpha),
      new Vector4(0.2, 0.2, 0.2, alpha)
    );

    const driftStrength = Math.max(0.0, p.motionDrift ?? 6.0);
    const drift = new ApplyForce(new THREE.Vector3(1, 0, 0), new ConstantValue(driftStrength));

    const curlScale = Math.max(1.0, p.motionCurlScale ?? 380.0);
    const curlStrength = Math.max(0.0, p.motionCurlStrength ?? 12.0);
    const curl = new CurlNoiseField(
      new THREE.Vector3(curlScale, curlScale, curlScale),
      new THREE.Vector3(curlStrength, curlStrength, curlStrength),
      1.0
    );

    const system = new ParticleSystem({
      duration: 1,
      looping: true,
      startLife: new IntervalValue(lifeMin, lifeMax),
      startSpeed: new ConstantValue(0),
      startSize: new IntervalValue(sizeMin, sizeMax),
      startColor: startColor,
      worldSpace: true,
      maxParticles: Math.max(0, Math.floor((p.maxParticles ?? 4000) * Math.max(0.0, p.density ?? 1.0))),
      emissionOverTime: new IntervalValue(12.0 * (p.density ?? 1.0), 20.0 * (p.density ?? 1.0)),
      shape,
      material,
      renderMode: RenderMode.BillBoard,
      renderOrder: 49,
      behaviors: [
        drift,
        curl,
        new DustFadeOverLifeBehavior(this)
      ]
    });

    this._patchWindowLightMaterial(material);

    this.batchRenderer.addSystem(system);
    this.scene.add(system.emitter);
    this._tryPatchBatchMaterial();

    this._system = system;
    this._material = material;

    this._needsRebuild = false;
    this._lastSceneBoundsKey = sceneBoundsKey;
  }

  _tryPatchBatchMaterial() {
    if (!this._system || !this.batchRenderer) return;
    if (this._batchMaterial) return;

    try {
      const idx = this.batchRenderer.systemToBatchIndex?.get(this._system);
      if (idx === undefined) return;
      const batch = this.batchRenderer.batches && this.batchRenderer.batches[idx];
      if (!batch || !batch.material) return;
      this._batchMaterial = batch.material;
      this._patchWindowLightMaterial(this._batchMaterial);
    } catch (e) {
    }
  }

  _patchWindowLightMaterial(material) {
    const THREE = window.THREE;
    if (!material || !THREE) return;

    if (material.userData && material.userData.windowLightUniforms) {
      return;
    }

    const uniforms = {
      uWindowLightTex: { value: null },
      uHasWindowLightTex: { value: 0.0 },
      uWindowScreenSize: { value: new THREE.Vector2(1920, 1080) },
      uBaseDarkness: { value: 0.9 },
      uLightMin: { value: 0.05 },
      uLightMax: { value: 0.35 },
      uLightIntensity: { value: 1.0 },
      uLightTintInfluence: { value: 0.5 },
      uDustBrightness: { value: 1.0 },
      uDustOpacity: { value: 1.0 },
      uDebugShowLight: { value: 0.0 },
      uDebugForceVisible: { value: 0.0 }
    };

    material.userData = material.userData || {};
    material.userData.windowLightUniforms = uniforms;

    const fragmentBlock =
      '  if (uDebugForceVisible > 0.5) {\n' +
      '    gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);\n' +
      '    gl_FragColor.rgb = gl_FragColor.rgb * uDustBrightness;\n' +
      '    gl_FragColor.a = gl_FragColor.a * uDustOpacity;\n' +
      '  } else if (uHasWindowLightTex <= 0.5) {\n' +
      '    float baseVis = clamp((1.0 - clamp(uBaseDarkness, 0.0, 1.0)) * 2.5, 0.0, 1.0);\n' +
      '    // Apply brightness within visibility bounds\n' +
      '    gl_FragColor.rgb = gl_FragColor.rgb * baseVis * uDustBrightness;\n' +
      '    gl_FragColor.a = gl_FragColor.a * baseVis * uDustOpacity;\n' +
      '  } else {\n' +
      '    vec2 screenUv = gl_FragCoord.xy / uWindowScreenSize;\n' +
      '    vec4 wl = texture2D(uWindowLightTex, screenUv);\n' +
      '    float light = wl.a;\n' +
      '    float lightVis = smoothstep(uLightMin, uLightMax, light) * uLightIntensity;\n' +
      '    lightVis = clamp(lightVis, 0.0, 1.0);\n' +
      '    if (uDebugShowLight > 0.5) {\n' +
      '      gl_FragColor = vec4(vec3(light), 1.0);\n' +
      '    } else {\n' +
      '      float baseFactor = 1.0 - clamp(uBaseDarkness, 0.0, 1.0);\n' +
      '      float baseVis = clamp(baseFactor * 2.5, 0.0, 1.0);\n' +
      '      // Use lightTintInfluence to control how much window light affects visibility\n' +
      '      float influence = clamp(uLightTintInfluence, 0.0, 1.0);\n' +
      '      float vis = mix(baseVis, lightVis, influence);\n' +
      '      float brightness = mix(baseFactor, 1.0, vis);\n' +
      '      vec3 tint = mix(vec3(1.0), wl.rgb, influence);\n' +
      '      // Apply brightness within visibility bounds so it doesn\'t override gating\n' +
      '      gl_FragColor.rgb = gl_FragColor.rgb * brightness * tint * uDustBrightness;\n' +
      '      gl_FragColor.a = gl_FragColor.a * vis * uDustOpacity;\n' +
      '    }\n' +
      '  }\n';

    const isShaderMat = material.isShaderMaterial === true;

    if (isShaderMat) {
      const uni = material.uniforms || (material.uniforms = {});
      uni.uWindowLightTex = uniforms.uWindowLightTex;
      uni.uHasWindowLightTex = uniforms.uHasWindowLightTex;
      uni.uWindowScreenSize = uniforms.uWindowScreenSize;
      uni.uBaseDarkness = uniforms.uBaseDarkness;
      uni.uLightMin = uniforms.uLightMin;
      uni.uLightMax = uniforms.uLightMax;
      uni.uLightIntensity = uniforms.uLightIntensity;
      uni.uLightTintInfluence = uniforms.uLightTintInfluence;
      uni.uDustBrightness = uniforms.uDustBrightness;
      uni.uDustOpacity = uniforms.uDustOpacity;
      uni.uDebugShowLight = uniforms.uDebugShowLight;
      uni.uDebugForceVisible = uniforms.uDebugForceVisible;

      if (typeof material.fragmentShader === 'string') {
        material.fragmentShader = material.fragmentShader
          .replace(
            'void main() {',
            'uniform sampler2D uWindowLightTex;\n' +
            'uniform float uHasWindowLightTex;\n' +
            'uniform vec2 uWindowScreenSize;\n' +
            'uniform float uBaseDarkness;\n' +
            'uniform float uLightMin;\n' +
            'uniform float uLightMax;\n' +
            'uniform float uLightIntensity;\n' +
            'uniform float uLightTintInfluence;\n' +
            'uniform float uDustBrightness;\n' +
            'uniform float uDustOpacity;\n' +
            'uniform float uDebugShowLight;\n' +
            'uniform float uDebugForceVisible;\n' +
            'void main() {'
          )
          .replace(/(^[ \t]*#include <soft_fragment>)/m, fragmentBlock + '$1');
      }

      material.needsUpdate = true;
      return;
    }

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWindowLightTex = uniforms.uWindowLightTex;
      shader.uniforms.uHasWindowLightTex = uniforms.uHasWindowLightTex;
      shader.uniforms.uWindowScreenSize = uniforms.uWindowScreenSize;
      shader.uniforms.uBaseDarkness = uniforms.uBaseDarkness;
      shader.uniforms.uLightMin = uniforms.uLightMin;
      shader.uniforms.uLightMax = uniforms.uLightMax;
      shader.uniforms.uLightIntensity = uniforms.uLightIntensity;
      shader.uniforms.uLightTintInfluence = uniforms.uLightTintInfluence;
      shader.uniforms.uDustBrightness = uniforms.uDustBrightness;
      shader.uniforms.uDustOpacity = uniforms.uDustOpacity;
      shader.uniforms.uDebugShowLight = uniforms.uDebugShowLight;
      shader.uniforms.uDebugForceVisible = uniforms.uDebugForceVisible;

      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform sampler2D uWindowLightTex;\n' +
          'uniform float uHasWindowLightTex;\n' +
          'uniform vec2 uWindowScreenSize;\n' +
          'uniform float uBaseDarkness;\n' +
          'uniform float uLightMin;\n' +
          'uniform float uLightMax;\n' +
          'uniform float uLightIntensity;\n' +
          'uniform float uLightTintInfluence;\n' +
          'uniform float uDustBrightness;\n' +
          'uniform float uDustOpacity;\n' +
          'uniform float uDebugShowLight;\n' +
          'uniform float uDebugForceVisible;\n' +
          'void main() {'
        )
        .replace(/(^[ \t]*#include <soft_fragment>)/m, fragmentBlock + '$1');
    };

    material.needsUpdate = true;
  }

  _syncWindowLightUniforms() {
    const THREE = window.THREE;
    if (!THREE) return;

    const wle = window.MapShine?.windowLightEffect;
    const lightTex = wle?.getLightTexture?.() || null;

    const wleEnabled = !!(wle && wle.enabled);
    const hasWindowMask = !!(wle && wle.params && wle.params.hasWindowMask);

    if (wle && lightTex && this.renderer) {
      try {
        wle.renderLightPass(this.renderer);
      } catch (e) {
      }
    }

    let screenW = 1920;
    let screenH = 1080;
    try {
      if (this.renderer && typeof this.renderer.getDrawingBufferSize === 'function') {
        if (!this._tmpDrawSize) this._tmpDrawSize = new THREE.Vector2();
        this.renderer.getDrawingBufferSize(this._tmpDrawSize);
        screenW = Math.max(1, Math.floor(this._tmpDrawSize.x || this._tmpDrawSize.width || screenW));
        screenH = Math.max(1, Math.floor(this._tmpDrawSize.y || this._tmpDrawSize.height || screenH));
      }
    } catch (e) {
    }

    const push = (mat) => {
      const u = mat?.userData?.windowLightUniforms;
      if (!u) return;

      u.uWindowLightTex.value = lightTex;
      // Dust should remain visible even without a window mask; treat the light texture as optional.
      // For debugging, allow the light sample view to show the texture even if WindowLight is disabled.
      u.uHasWindowLightTex.value = (lightTex && (this.params.debugShowLight || wleEnabled || hasWindowMask)) ? 1.0 : 0.0;
      u.uWindowScreenSize.value.set(screenW, screenH);

      u.uBaseDarkness.value = this.params.baseDarkness;
      u.uLightMin.value = this.params.lightMin;
      u.uLightMax.value = this.params.lightMax;
      u.uLightIntensity.value = this.params.lightIntensity;
      u.uLightTintInfluence.value = this.params.lightTintInfluence;
      u.uDustBrightness.value = this.params.brightness;
      u.uDustOpacity.value = this.params.opacity;
      u.uDebugShowLight.value = this.params.debugShowLight ? 1.0 : 0.0;
      u.uDebugForceVisible.value = this.params.debugForceVisible ? 1.0 : 0.0;
    };

    push(this._material);
    push(this._batchMaterial);
  }

  _syncMaterialVisibilityOverrides() {
    const THREE = window.THREE;
    if (!THREE) return;

    const force = !!this.params.debugForceVisible;

    const apply = (mat) => {
      if (!mat) return;
      if (force) {
        mat.depthTest = false;
        mat.depthWrite = false;
        mat.transparent = true;
        mat.opacity = 1.0;
        mat.blending = THREE.AdditiveBlending;
      }
    };

    apply(this._material);
    apply(this._batchMaterial);
  }

  update(timeInfo) {
    this.params.enabled = !!this.enabled;

    if (!this.enabled) {
      if (this._system) {
        this._disposeSystem();
      }
      return;
    }

    if (!this.batchRenderer || !this.scene) return;

    // If the scene bounds changed since the last successful build, rebuild so particles remain aligned.
    try {
      const d = canvas?.dimensions;
      const width = d?.sceneWidth;
      const height = d?.sceneHeight;
      const sx = d?.sceneX;
      const sceneY = d?.sceneY;
      const fullH = d?.height;
      if (
        Number.isFinite(width) && Number.isFinite(height) && width > 1 && height > 1 &&
        Number.isFinite(sx) && Number.isFinite(sceneY) && Number.isFinite(fullH) && fullH > 1
      ) {
        const sy = fullH - sceneY - height;
        const sceneBoundsKey = `${sx},${sy},${width},${height},${fullH}`;
        if (this._lastSceneBoundsKey && this._lastSceneBoundsKey !== sceneBoundsKey) {
          this._needsRebuild = true;
        }
      }
    } catch (e) {
    }

    if (!this._system && this._spawnPoints && this._spawnPoints.length >= 3) {
      this._needsRebuild = true;
    }

    if (this._needsRebuild) {
      this._rebuildSystem();
    }

    this._tryPatchBatchMaterial();

    if (this._system && this._system.emitter) {
      this._system.emitter.visible = true;
    }

    this._syncWindowLightUniforms();
    this._syncMaterialVisibilityOverrides();
  }

  render(renderer, scene, camera) {
  }

  onResize(width, height) {
    const push = (mat) => {
      const u = mat?.userData?.windowLightUniforms;
      if (!u) return;
      u.uWindowScreenSize.value.set(width, height);
    };

    push(this._material);
    push(this._batchMaterial);
  }

  dispose() {
    this._disposeSystem();

    if (this._particleTexture) {
      try {
        this._particleTexture.dispose();
      } catch (e) {
      }
      this._particleTexture = null;
    }

    this.batchRenderer = null;
    this.scene = null;
    this.renderer = null;
    this.camera = null;

    log.info('DustMotesEffect disposed');
  }
}
