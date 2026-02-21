import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('LightningEffect');

const DEFAULT_GROUND_Z = 1000;

export class LightningEffect extends EffectBase {
  constructor() {
    super('lightning', RenderLayers.ENVIRONMENTAL, 'low');

    // Lightning is a whole-sky atmospheric effect with no floor-specific masks.
    // Running per-floor would trigger the simulation and flash rendering N times,
    // accumulating duplicate flash geometry in the scene render target.
    this.floorScope = 'global';

    this.priority = 8;

    this.params = {
      enabled: true,

      outsideFlashEnabled: true,
      outsideFlashGain: 0.45,
      outsideFlashAttackMs: 25,
      outsideFlashDecayMs: 650,
      outsideFlashCurve: 1.6,
      outsideFlashFlickerAmount: 0.25,
      outsideFlashFlickerRate: 12.0,
      outsideFlashMaxClamp: 4.0,

      minDelayMs: 0,
      maxDelayMs: 10000,

      burstMinStrikes: 1,
      burstMaxStrikes: 5,
      strikeDurationMs: 280,
      strikeDelayMs: 105,

      flickerChance: 1.0,

      outerColor: { r: 0.35, g: 0.65, b: 1.0 },
      coreColor: { r: 1.0, g: 1.0, b: 1.0 },
      brightness: 0.9,

      width: 12.0,
      taper: 0.72,
      glowStrength: 1.0,

      zOffset: 2.0,

      overheadOrder: 0,

      segments: 34,
      curveAmount: 0.32,
      macroDisplacement: 14.0,
      microJitter: 3.0,
      endPointRandomnessPx: 114.0,

      textureScrollSpeed: 30.0,

      branchChance: 0.89,
      branchMax: 3,
      branchLengthMin: 0.18,
      branchLengthMax: 0.54,
      branchWidthScale: 0.55,
      branchIntensityScale: 0.39,
      branchDurationScale: 0.7,
      branchForwardBias: 0.5,
      branchPerpBias: 1.0,

      wildArcChance: 0.0,

      audioEnabled: false,
      audioStrikePath: '',
      audioVolume: 0.7
    };

    this._initialized = false;

    this.renderer = null;
    this.scene = null;
    this.camera = null;

    this._mapPointsManager = null;
    this._changeListener = null;
    this._pendingSourceRebuild = false;

    this._sources = [];

    this._noiseTexture = null;

    this._maxActiveStrikes = 24;
    this._maxPointsPerStrike = 96;

    this._strikePool = [];

    this._resolution = null;

    this._tempVec3A = null;
    this._tempVec3B = null;
    this._tempVec3C = null;

    this._flashStartMs = -1;
    this._flashPeak = 0.0;
    this._flashValue = 0.0;
    this._flashSeed = 0.0;

    this._lastStrikeScreenUv = null;
    this._lastStrikeDir = null;

    this._envStrikeUv = { x: 0.0, y: 0.0 };
    this._envStrikeDir = { x: 0.0, y: 0.0 };
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'timing',
          label: 'Timing',
          type: 'inline',
          parameters: ['minDelayMs', 'maxDelayMs', 'burstMinStrikes', 'burstMaxStrikes', 'strikeDurationMs', 'strikeDelayMs', 'flickerChance']
        },
        {
          name: 'look',
          label: 'Look',
          type: 'inline',
          parameters: ['outerColor', 'coreColor', 'brightness', 'width', 'taper', 'glowStrength', 'zOffset', 'overheadOrder', 'textureScrollSpeed']
        },
        {
          name: 'shape',
          label: 'Shape',
          type: 'inline',
          parameters: ['segments', 'curveAmount', 'macroDisplacement', 'microJitter', 'endPointRandomnessPx', 'branchChance', 'branchMax', 'branchLengthMin', 'branchLengthMax', 'branchWidthScale', 'branchIntensityScale', 'branchDurationScale', 'branchForwardBias', 'branchPerpBias', 'wildArcChance']
        },
        {
          name: 'outsideFlash',
          label: 'Outside Flash',
          type: 'inline',
          parameters: ['outsideFlashEnabled', 'outsideFlashGain', 'outsideFlashAttackMs', 'outsideFlashDecayMs', 'outsideFlashCurve', 'outsideFlashFlickerAmount', 'outsideFlashFlickerRate', 'outsideFlashMaxClamp']
        },
        {
          name: 'audio',
          label: 'Audio',
          type: 'inline',
          parameters: ['audioEnabled', 'audioStrikePath', 'audioVolume']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },

        outsideFlashEnabled: { type: 'boolean', default: true, label: 'Flash Enabled' },
        outsideFlashGain: { type: 'slider', min: 0, max: 5, step: 0.01, default: 0.45, label: 'Flash Gain' },
        outsideFlashAttackMs: { type: 'slider', min: 0, max: 150, step: 1, default: 25, label: 'Attack (ms)' },
        outsideFlashDecayMs: { type: 'slider', min: 50, max: 2500, step: 10, default: 650, label: 'Decay (ms)' },
        outsideFlashCurve: { type: 'slider', min: 0.25, max: 4, step: 0.01, default: 1.6, label: 'Decay Curve' },
        outsideFlashFlickerAmount: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.25, label: 'Flicker Amount' },
        outsideFlashFlickerRate: { type: 'slider', min: 0, max: 40, step: 0.1, default: 12.0, label: 'Flicker Rate' },
        outsideFlashMaxClamp: { type: 'slider', min: 0, max: 10, step: 0.05, default: 4.0, label: 'Flash Clamp' },

        minDelayMs: { type: 'slider', min: 0, max: 5000, step: 50, default: 0, label: 'Min Delay (ms)' },
        maxDelayMs: { type: 'slider', min: 0, max: 10000, step: 50, default: 10000, label: 'Max Delay (ms)' },

        burstMinStrikes: { type: 'slider', min: 1, max: 10, step: 1, default: 1, label: 'Burst Min Strikes' },
        burstMaxStrikes: { type: 'slider', min: 1, max: 16, step: 1, default: 5, label: 'Burst Max Strikes' },
        strikeDurationMs: { type: 'slider', min: 20, max: 800, step: 10, default: 280, label: 'Strike Duration (ms)' },
        strikeDelayMs: { type: 'slider', min: 0, max: 500, step: 5, default: 105, label: 'Strike Spacing (ms)' },
        flickerChance: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0, label: 'Flicker Chance' },

        outerColor: { type: 'color', default: { r: 0.35, g: 0.65, b: 1.0 }, label: 'Outer Color' },
        coreColor: { type: 'color', default: { r: 1.0, g: 1.0, b: 1.0 }, label: 'Core Color' },
        brightness: { type: 'slider', min: 0, max: 10, step: 0.05, default: 0.9, label: 'Brightness' },
        width: { type: 'slider', min: 1, max: 120, step: 1, default: 12, label: 'Width (px-ish)' },
        taper: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.72, label: 'Taper' },
        glowStrength: { type: 'slider', min: 0, max: 5, step: 0.05, default: 1.0, label: 'Glow Strength' },
        zOffset: { type: 'slider', min: 0, max: 50, step: 0.25, default: 2.0, label: 'Z Offset' },
        overheadOrder: {
          type: 'list',
          label: 'Overhead Order',
          options: {
            'Below Overhead': 0,
            'Above Overhead': 1
          },
          default: 0
        },
        textureScrollSpeed: { type: 'slider', min: 0, max: 30, step: 0.1, default: 30.0, label: 'Texture Scroll Speed' },

        segments: { type: 'slider', min: 4, max: 96, step: 1, default: 34, label: 'Segments' },
        curveAmount: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.32, label: 'Curve Amount' },
        macroDisplacement: { type: 'slider', min: 0, max: 400, step: 1, default: 14, label: 'Macro Displacement' },
        microJitter: { type: 'slider', min: 0, max: 120, step: 1, default: 3, label: 'Micro Jitter' },
        endPointRandomnessPx: { type: 'slider', min: 0, max: 400, step: 1, default: 114, label: 'Endpoint Randomness' },

        branchChance: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.89, label: 'Branch Chance' },
        branchMax: { type: 'slider', min: 0, max: 6, step: 1, default: 3, label: 'Branch Max' },
        branchLengthMin: { type: 'slider', min: 0.05, max: 1, step: 0.01, default: 0.18, label: 'Branch Length Min' },
        branchLengthMax: { type: 'slider', min: 0.05, max: 1.5, step: 0.01, default: 0.54, label: 'Branch Length Max' },
        branchWidthScale: { type: 'slider', min: 0.05, max: 1, step: 0.01, default: 0.55, label: 'Branch Width Scale' },
        branchIntensityScale: { type: 'slider', min: 0.05, max: 1, step: 0.01, default: 0.39, label: 'Branch Intensity Scale' },
        branchDurationScale: { type: 'slider', min: 0.1, max: 1, step: 0.01, default: 0.7, label: 'Branch Duration Scale' },
        branchForwardBias: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.5, label: 'Branch Forward Bias' },
        branchPerpBias: { type: 'slider', min: 0, max: 2, step: 0.01, default: 1.0, label: 'Branch Perp Bias' },

        wildArcChance: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.0, label: 'Wild Arc Chance' },

        audioEnabled: { type: 'boolean', default: false, label: 'Audio Enabled' },
        audioStrikePath: { type: 'string', default: '', label: 'Strike Sound Path' },
        audioVolume: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.7, label: 'Volume' }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) return;

    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this._resolution = new THREE.Vector2(1, 1);
    this.renderer.getDrawingBufferSize(this._resolution);

    this._tempVec3A = new THREE.Vector3();
    this._tempVec3B = new THREE.Vector3();
    this._tempVec3C = new THREE.Vector3();

    this._lastStrikeScreenUv = new THREE.Vector2(0.5, 0.5);
    this._lastStrikeDir = new THREE.Vector2(0.0, -1.0);

    this._flashSeed = Math.random();

    this._noiseTexture = this._createNoiseTexture();

    this._createStrikePool();

    this._applyOverheadOrderToMeshes();

    // Defer source rebuild to update() so startup wiring/state-restore order
    // cannot leave lightning with stale or empty source data.
    this._requestSourceRebuild();

    this._initialized = true;
    log.info('LightningEffect initialized');
  }

  onResize(width, height) {
    super.onResize(width, height);
    if (!this._resolution) return;
    this._resolution.set(width, height);
  }

  applyParamChange(paramId, value) {
    if (paramId === 'enabled') return;
    if (this.params && Object.prototype.hasOwnProperty.call(this.params, paramId)) {
      this.params[paramId] = value;
    }

    if (paramId === 'overheadOrder') {
      this._applyOverheadOrderToMeshes();
    }

    // Timing parameters influence burst scheduling; rebuild sources so scene-load
    // restored settings take effect immediately without requiring point edits.
    if (
      paramId === 'minDelayMs' ||
      paramId === 'maxDelayMs' ||
      paramId === 'burstMinStrikes' ||
      paramId === 'burstMaxStrikes' ||
      paramId === 'strikeDelayMs'
    ) {
      this._requestSourceRebuild();
    }
  }

  setMapPointsSources(manager) {
    const prevManager = this._mapPointsManager;
    if (this._changeListener && prevManager) {
      prevManager.removeChangeListener(this._changeListener);
    }

    this._mapPointsManager = manager || null;

    this._requestSourceRebuild();

    this._changeListener = () => this._requestSourceRebuild();
    if (this._mapPointsManager) {
      this._mapPointsManager.addChangeListener(this._changeListener);
    }
  }

  update(timeInfo) {
    if (!this._initialized) return;

    const nowMs = timeInfo.elapsed * 1000;

    if (this._pendingSourceRebuild) {
      this._rebuildSources(nowMs);
      this._pendingSourceRebuild = false;
    }

    if (!this.enabled) {
      this._hideAllStrikes();
      this._setFlash(0.0, timeInfo);
      return;
    }

    for (let i = 0; i < this._sources.length; i++) {
      const src = this._sources[i];

      if (nowMs < src.nextBurstAt) continue;

      if (!src.burstActive) {
        src.burstActive = true;
        src.burstStrikesRemaining = this._randInt(src.rng, this.params.burstMinStrikes, this.params.burstMaxStrikes);
        src.nextStrikeAt = nowMs;
      }

      while (src.burstActive && src.burstStrikesRemaining > 0 && nowMs >= src.nextStrikeAt) {
        src.burstStrikesRemaining--;
        src.nextStrikeAt += this.params.strikeDelayMs;

        const isWild = this._randFloat(src.rng) < this.params.wildArcChance;
        this._spawnStrike(src, timeInfo, isWild);
      }

      if (src.burstActive && src.burstStrikesRemaining <= 0) {
        src.burstActive = false;
        src.nextBurstAt = nowMs + this._randFloatRange(src.rng, this.params.minDelayMs, this.params.maxDelayMs);
      }
    }

    for (let i = 0; i < this._strikePool.length; i++) {
      const strike = this._strikePool[i];
      if (!strike.active) continue;

      const t = (nowMs - strike.startTimeMs) / Math.max(1, strike.durationMs);
      if (t >= 1.0) {
        this._deactivateStrike(strike);
        continue;
      }

      let env;
      if (t < 0.12) {
        env = t / 0.12;
      } else if (t > 0.75) {
        env = Math.max(0, (1.0 - t) / 0.25);
      } else {
        env = 1.0;
      }

      if (this._randFloat(strike.rng) < this.params.flickerChance * timeInfo.delta * 60.0) {
        env *= this._randFloatRange(strike.rng, 0.35, 0.9);
      }

      const wave = 0.7 + 0.3 * Math.sin((strike.seed * 6.2831853) + timeInfo.elapsed * 90.0);
      const intensity = env * wave * strike.baseIntensity;

      strike.material.uniforms.uTime.value = timeInfo.elapsed;
      strike.material.uniforms.uIntensity.value = intensity;
      strike.material.uniforms.uResolution.value.copy(this._resolution);

      strike.material.uniforms.uWidth.value = this.params.width * (strike.widthScale ?? 1.0);
      strike.material.uniforms.uTaper.value = this.params.taper;
      strike.material.uniforms.uBrightness.value = this.params.brightness;
      strike.material.uniforms.uGlowStrength.value = this.params.glowStrength;
      strike.material.uniforms.uTextureScrollSpeed.value = this.params.textureScrollSpeed;
      strike.material.uniforms.uOuterColor.value.set(this.params.outerColor.r, this.params.outerColor.g, this.params.outerColor.b);
      strike.material.uniforms.uCoreColor.value.set(this.params.coreColor.r, this.params.coreColor.g, this.params.coreColor.b);

      strike.mesh.visible = intensity > 0.001;
    }

    this._updateFlash(timeInfo);
  }

  _ensureEnvironment() {
    const ms = window.MapShine;
    if (!ms) return null;
    if (!ms.environment) ms.environment = {};
    return ms.environment;
  }

  _setFlash(v, timeInfo) {
    const env = this._ensureEnvironment();
    this._flashValue = v;
    if (env) {
      env.lightningFlash = v;
      env.lightningFlash01 = (this.params.outsideFlashMaxClamp > 0.0) ? Math.max(0.0, Math.min(1.0, v / this.params.outsideFlashMaxClamp)) : 0.0;
      env.lightningStrikeUv = this._envStrikeUv;
      env.lightningStrikeDir = this._envStrikeDir;
      env.lightningStrikeTime = timeInfo.elapsed;
    }
  }

  _updateFlash(timeInfo) {
    if (!this.params.outsideFlashEnabled) {
      if (this._flashValue !== 0.0) this._setFlash(0.0, timeInfo);
      return;
    }

    const nowMs = timeInfo.elapsed * 1000;
    if (this._flashStartMs < 0) {
      if (this._flashValue !== 0.0) this._setFlash(0.0, timeInfo);
      return;
    }

    const attackMs = Math.max(0.0, this.params.outsideFlashAttackMs);
    const decayMs = Math.max(1.0, this.params.outsideFlashDecayMs);
    const curve = Math.max(0.01, this.params.outsideFlashCurve);
    const dtMs = Math.max(0.0, nowMs - this._flashStartMs);

    let env = 0.0;
    if (attackMs > 0.0 && dtMs < attackMs) {
      env = dtMs / attackMs;
    } else {
      const t = (dtMs - attackMs) / decayMs;
      env = Math.pow(Math.max(0.0, 1.0 - t), curve);
    }

    let flash = env * Math.max(0.0, this._flashPeak) * Math.max(0.0, this.params.outsideFlashGain);

    const flickAmt = Math.max(0.0, Math.min(1.0, this.params.outsideFlashFlickerAmount));
    if (flickAmt > 0.0) {
      const rate = Math.max(0.0, this.params.outsideFlashFlickerRate);
      const w = 6.283185307179586 * rate;
      const flick = 0.5 + 0.5 * Math.sin(timeInfo.elapsed * w + this._flashSeed * 31.7);
      flash *= (1.0 - flickAmt) + flickAmt * flick;
    }

    const clampV = Math.max(0.0, this.params.outsideFlashMaxClamp);
    if (clampV > 0.0) flash = Math.min(flash, clampV);

    if (env <= 0.0001) {
      this._flashStartMs = -1;
      this._flashPeak = 0.0;
      flash = 0.0;
    }

    if (flash !== this._flashValue) {
      this._setFlash(flash, timeInfo);
    }
  }

  _registerStrikeForFlash(start, end, intensity, timeInfo) {
    const THREE = window.THREE;
    if (!THREE || !this.camera || !this._tempVec3C) return;

    const dirX = end.x - start.x;
    const dirY = end.y - start.y;
    const len = Math.max(1e-4, Math.sqrt(dirX * dirX + dirY * dirY));

    if (this._lastStrikeDir) {
      this._lastStrikeDir.set(dirX / len, dirY / len);
    }

    if (this._envStrikeDir) {
      this._envStrikeDir.x = dirX / len;
      this._envStrikeDir.y = dirY / len;
    }

    // Project the end point to screen UV so downstream screen-space effects can react.
    this._tempVec3C.set(end.x, end.y, end.z);
    this._tempVec3C.project(this.camera);

    const u = this._tempVec3C.x * 0.5 + 0.5;
    const v = this._tempVec3C.y * 0.5 + 0.5;

    if (this._lastStrikeScreenUv) {
      this._lastStrikeScreenUv.set(u, v);
    }

    if (this._envStrikeUv) {
      this._envStrikeUv.x = u;
      this._envStrikeUv.y = v;
    }

    // Trigger/refresh the outside flash envelope.
    this._flashStartMs = timeInfo.elapsed * 1000;
    this._flashPeak = Math.max(this._flashPeak, Math.max(0.0, intensity));
  }

  dispose() {
    super.dispose();

    if (this._changeListener && this._mapPointsManager) {
      this._mapPointsManager.removeChangeListener(this._changeListener);
    }

    for (let i = 0; i < this._strikePool.length; i++) {
      const s = this._strikePool[i];
      try {
        if (s.mesh && s.mesh.parent) s.mesh.parent.remove(s.mesh);
        if (s.geometry) s.geometry.dispose();
        if (s.material) s.material.dispose();
      } catch (_) {
      }
    }

    this._strikePool.length = 0;

    if (this._noiseTexture) {
      try { this._noiseTexture.dispose(); } catch (_) {}
      this._noiseTexture = null;
    }

    this._initialized = false;
  }

  _requestSourceRebuild() {
    this._pendingSourceRebuild = true;
  }

  _getGroundZ() {
    const sc = window.MapShine?.sceneComposer;
    return (sc && typeof sc.groundZ === 'number') ? sc.groundZ : DEFAULT_GROUND_Z;
  }

  _toWorldPoint(point) {
    const THREE = window.THREE;
    const v = new THREE.Vector3(point.x, point.y, 0);
    v.z = this._getGroundZ() + (this.params?.zOffset ?? 2.0);
    return v;
  }

  _rebuildSources(nowMsOverride = null) {
    this._sources.length = 0;

    if (!this._mapPointsManager) return;

    const groups = this._mapPointsManager.getGroupsByEffect('lightning') || [];
    if (groups.length === 0) return;

    const THREE = window.THREE;
    if (!THREE) return;

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g || g.isBroken) continue;
      if (!g.points || g.points.length < 2) continue;

      const isLine = g.type === 'line';
      const isPointLine = g.type === 'point' && g.points.length >= 2;
      if (!isLine && !isPointLine) continue;

      const start = this._toWorldPoint(g.points[0]);
      const end = this._toWorldPoint(g.points[g.points.length - 1]);

      const rng = { state: this._hashStringToUint(g.id || String(i)) };

      this._sources.push({
        id: g.id,
        startX: start.x,
        startY: start.y,
        startZ: start.z,
        endX: end.x,
        endY: end.y,
        endZ: end.z,
        intensity: g.emission?.intensity ?? 1.0,
        rng,
        nextBurstAt: 0,
        burstActive: false,
        burstStrikesRemaining: 0,
        nextStrikeAt: 0
      });
    }

    const nowMs = Number.isFinite(nowMsOverride)
      ? nowMsOverride
      : ((window.MapShine?.timeManager?.elapsed ?? 0) * 1000);
    for (let i = 0; i < this._sources.length; i++) {
      const s = this._sources[i];
      s.nextBurstAt = nowMs + this._randFloatRange(s.rng, 0, Math.max(0, this.params.maxDelayMs));
    }

    log.info(`Lightning sources rebuilt: ${this._sources.length}`);
  }

  _hideAllStrikes() {
    for (let i = 0; i < this._strikePool.length; i++) {
      this._deactivateStrike(this._strikePool[i]);
    }
  }

  _createStrikePool() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._strikePool.length = 0;

    for (let i = 0; i < this._maxActiveStrikes; i++) {
      const { geometry, material } = this._createStrikeMeshResources();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 9;

      if (this.scene) {
        this.scene.add(mesh);
      }

      const rng = { state: this._hashStringToUint(`strike_${i}`) ^ 0x9e3779b9 };

      this._strikePool.push({
        active: false,
        mesh,
        geometry,
        material,
        rng,
        seed: this._randFloat(rng),
        startTimeMs: 0,
        durationMs: 0,
        baseIntensity: 1.0,
        widthScale: 1.0,
        pointCount: 0,
        arrays: geometry.userData._arrays
      });
    }
  }

  _applyOverheadOrderToMeshes() {
    const order = (this.params && typeof this.params.overheadOrder === 'number') ? this.params.overheadOrder : 0;
    const overheadRenderOrder = 10;
    const below = overheadRenderOrder - 1;
    const above = overheadRenderOrder + 10;
    const lightningOrder = order > 0.5 ? above : below;

    for (let i = 0; i < this._strikePool.length; i++) {
      const s = this._strikePool[i];
      if (s && s.mesh) {
        s.mesh.renderOrder = lightningOrder;
      }
    }
  }

  _createStrikeMeshResources() {
    const THREE = window.THREE;

    const pointCapacity = this._maxPointsPerStrike;
    const vertCount = pointCapacity * 2;

    const positions = new Float32Array(vertCount * 3);
    const prevPos = new Float32Array(vertCount * 3);
    const nextPos = new Float32Array(vertCount * 3);
    const side = new Float32Array(vertCount);
    const uvOffset = new Float32Array(vertCount);

    for (let i = 0; i < pointCapacity; i++) {
      const u = pointCapacity <= 1 ? 0 : i / (pointCapacity - 1);
      const v0 = i * 2;
      const v1 = v0 + 1;
      side[v0] = -1.0;
      side[v1] = 1.0;
      uvOffset[v0] = u;
      uvOffset[v1] = u;
    }

    const indices = new Uint16Array((pointCapacity - 1) * 6);
    let idx = 0;
    for (let i = 0; i < pointCapacity - 1; i++) {
      const a0 = i * 2;
      const a1 = a0 + 1;
      const b0 = (i + 1) * 2;
      const b1 = b0 + 1;

      indices[idx++] = a0;
      indices[idx++] = a1;
      indices[idx++] = b0;

      indices[idx++] = a1;
      indices[idx++] = b1;
      indices[idx++] = b0;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('prevPos', new THREE.BufferAttribute(prevPos, 3));
    geometry.setAttribute('nextPos', new THREE.BufferAttribute(nextPos, 3));
    geometry.setAttribute('side', new THREE.BufferAttribute(side, 1));
    geometry.setAttribute('uvOffset', new THREE.BufferAttribute(uvOffset, 1));

    geometry.setDrawRange(0, 0);

    geometry.userData._arrays = { positions, prevPos, nextPos, side, uvOffset, pointCapacity };

    const material = this._createLightningMaterial();

    return { geometry, material };
  }

  _createLightningMaterial() {
    const THREE = window.THREE;

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0.0 },
        uResolution: { value: this._resolution || new THREE.Vector2(1, 1) },
        uWidth: { value: this.params.width },
        uTaper: { value: this.params.taper },
        uIntensity: { value: 0.0 },
        uOuterColor: { value: new THREE.Vector3(this.params.outerColor.r, this.params.outerColor.g, this.params.outerColor.b) },
        uCoreColor: { value: new THREE.Vector3(this.params.coreColor.r, this.params.coreColor.g, this.params.coreColor.b) },
        uBrightness: { value: this.params.brightness },
        uGlowStrength: { value: this.params.glowStrength },
        uTextureScrollSpeed: { value: this.params.textureScrollSpeed },
        uNoiseMap: { value: this._noiseTexture }
      },
      vertexShader: `
        attribute vec3 prevPos;
        attribute vec3 nextPos;
        attribute float side;
        attribute float uvOffset;

        uniform vec2 uResolution;
        uniform float uWidth;
        uniform float uTaper;

        varying vec2 vUv;

        void main() {
          vec4 clipPrev = projectionMatrix * modelViewMatrix * vec4(prevPos, 1.0);
          vec4 clipCurr = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec4 clipNext = projectionMatrix * modelViewMatrix * vec4(nextPos, 1.0);

          vec2 p = clipPrev.xy / max(1e-6, clipPrev.w);
          vec2 a = clipCurr.xy / max(1e-6, clipCurr.w);
          vec2 b = clipNext.xy / max(1e-6, clipNext.w);

          vec2 dirPrevPxRaw = (a - p) * uResolution;
          vec2 dirNextPxRaw = (b - a) * uResolution;

          float prevLen2 = dot(dirPrevPxRaw, dirPrevPxRaw);
          float nextLen2 = dot(dirNextPxRaw, dirNextPxRaw);
          if (prevLen2 < 1e-6) dirPrevPxRaw = dirNextPxRaw;
          if (nextLen2 < 1e-6) dirNextPxRaw = dirPrevPxRaw;

          vec2 dirPrev = normalize(dirPrevPxRaw);
          vec2 dirNext = normalize(dirNextPxRaw);

          vec2 nPrev = vec2(-dirPrev.y, dirPrev.x);
          vec2 nNext = vec2(-dirNext.y, dirNext.x);

          vec2 miter = nPrev + nNext;
          float miterLen2 = dot(miter, miter);
          if (miterLen2 < 1e-6) {
            miter = nNext;
          } else {
            miter *= inversesqrt(miterLen2);
          }

          float denom = max(0.25, abs(dot(miter, nNext)));
          float miterScale = min(2.25, 1.0 / denom);
          vec2 normalPx = miter * miterScale;

          float taperWidth = mix(1.0, 0.0, pow(uvOffset, max(0.001, uTaper)));
          float w = uWidth * taperWidth;

          vec2 offsetNdc = (normalPx * (w / uResolution)) * side;
          clipCurr.xy += offsetNdc * clipCurr.w;

          gl_Position = clipCurr;
          vUv = vec2(uvOffset, side * 0.5 + 0.5);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uIntensity;
        uniform vec3 uOuterColor;
        uniform vec3 uCoreColor;
        uniform float uBrightness;
        uniform float uGlowStrength;
        uniform float uTextureScrollSpeed;
        uniform sampler2D uNoiseMap;

        varying vec2 vUv;

        float saturate(float x) { return clamp(x, 0.0, 1.0); }

        void main() {
          float y = abs(vUv.y - 0.5) * 2.0;

          float outer = smoothstep(1.0, 0.0, y);
          float core = smoothstep(0.55, 0.0, y);

          vec2 uvNoise = vec2(vUv.x * 2.5 + uTime * uTextureScrollSpeed, vUv.y * 1.25);
          float n = texture2D(uNoiseMap, uvNoise).r;

          float plasma = saturate(n * 1.25);
          float alpha = outer * (0.35 + 0.65 * plasma);
          alpha *= uIntensity;

          vec3 col = mix(uOuterColor, uCoreColor, core);
          vec3 rgb = col * (uBrightness * uGlowStrength);

          gl_FragColor = vec4(rgb, alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending
    });

    material.toneMapped = false;

    return material;
  }

  _spawnStrike(source, timeInfo, isWild) {
    const strike = this._allocStrike();
    if (!strike) return;

    const THREE = window.THREE;

    strike.active = true;
    strike.mesh.visible = true;

    strike.startTimeMs = timeInfo.elapsed * 1000;
    strike.durationMs = this.params.strikeDurationMs;

    strike.seed = this._randFloat(strike.rng);
    strike.baseIntensity = Math.max(0.05, source.intensity);
    strike.widthScale = 1.0;

    const start = this._tempVec3A;
    const end = this._tempVec3B;

    start.set(source.startX, source.startY, source.startZ);
    end.set(source.endX, source.endY, source.endZ);

    if (this.params.endPointRandomnessPx > 0.0) {
      end.x += this._randFloatRange(strike.rng, -this.params.endPointRandomnessPx, this.params.endPointRandomnessPx);
      end.y += this._randFloatRange(strike.rng, -this.params.endPointRandomnessPx, this.params.endPointRandomnessPx);
    }

    if (isWild) {
      const dx = this._randFloatRange(strike.rng, -1, 1);
      const dy = this._randFloatRange(strike.rng, -1, 1);
      const len = Math.max(1e-4, Math.sqrt(dx * dx + dy * dy));
      const dirX = dx / len;
      const dirY = dy / len;
      const dist = this._randFloatRange(strike.rng, 200, 900);
      end.x = start.x + dirX * dist;
      end.y = start.y + dirY * dist;
    }

    this._registerStrikeForFlash(start, end, strike.baseIntensity, timeInfo);

    const mainDx = end.x - start.x;
    const mainDy = end.y - start.y;
    const mainLen = Math.max(1e-4, Math.sqrt(mainDx * mainDx + mainDy * mainDy));

    const seg = Math.max(4, Math.min(this._maxPointsPerStrike - 1, this.params.segments | 0));
    const pointCount = seg + 1;

    this._fillStrikeGeometry(strike, start, end, pointCount);

    if (this.params.branchMax > 0 && this._randFloat(strike.rng) < this.params.branchChance) {
      const positions = strike.arrays.positions;
      const maxBranches = Math.max(0, this.params.branchMax | 0);
      const branchCount = this._randInt(strike.rng, 1, Math.max(1, maxBranches));

      const startIdxMax = Math.max(2, pointCount - 2);
      for (let bi = 0; bi < branchCount; bi++) {
        const branch = this._allocStrike();
        if (!branch) break;

        branch.active = true;
        branch.mesh.visible = true;

        branch.startTimeMs = strike.startTimeMs;
        branch.durationMs = Math.max(20, this.params.strikeDurationMs * Math.max(0.1, this.params.branchDurationScale));

        branch.seed = this._randFloat(branch.rng);
        branch.baseIntensity = Math.max(0.01, strike.baseIntensity * Math.max(0.05, this.params.branchIntensityScale));
        branch.widthScale = Math.max(0.05, this.params.branchWidthScale);

        const r = this._randFloat(strike.rng);
        const idx = 1 + Math.min(startIdxMax - 1, Math.floor(Math.pow(r, 1.7) * (startIdxMax - 1)));

        const v0 = idx * 2;
        const x0 = positions[v0 * 3 + 0];
        const y0 = positions[v0 * 3 + 1];
        const z0 = positions[v0 * 3 + 2];

        const vPrev = (idx - 1) * 2;
        const vNext = (idx + 1) * 2;
        let tx = positions[vNext * 3 + 0] - positions[vPrev * 3 + 0];
        let ty = positions[vNext * 3 + 1] - positions[vPrev * 3 + 1];
        const tlen = Math.max(1e-4, Math.sqrt(tx * tx + ty * ty));
        tx /= tlen;
        ty /= tlen;

        const px = -ty;
        const py = tx;
        const sign = this._randFloat(strike.rng) < 0.5 ? -1.0 : 1.0;

        const frac = this._randFloatRange(strike.rng, this.params.branchLengthMin, this.params.branchLengthMax);
        const branchLen = Math.max(10.0, mainLen * Math.max(0.05, frac));
        const fwd = Math.max(0.0, this.params.branchForwardBias);
        const perp = Math.max(0.0, this.params.branchPerpBias);

        start.set(x0, y0, z0);
        end.set(
          x0 + (tx * fwd + px * perp * sign) * branchLen,
          y0 + (ty * fwd + py * perp * sign) * branchLen,
          z0
        );

        const bSeg = Math.max(3, Math.min(this._maxPointsPerStrike - 1, Math.floor(seg * 0.5)));
        const bPointCount = bSeg + 1;
        const dispScale = Math.min(1.0, branchLen / Math.max(1.0, mainLen));
        this._fillStrikeGeometry(branch, start, end, bPointCount, dispScale);

        branch.material.uniforms.uTime.value = timeInfo.elapsed;
        branch.material.uniforms.uIntensity.value = 1.0;
      }
    }

    strike.material.uniforms.uTime.value = timeInfo.elapsed;
    strike.material.uniforms.uIntensity.value = 1.0;

    if (this.params.audioEnabled && this.params.audioStrikePath) {
      this._onStrikeAudio({
        sourceId: source.id,
        intensity: strike.baseIntensity,
        isWild
      });
    }
  }

  _allocStrike() {
    for (let i = 0; i < this._strikePool.length; i++) {
      const s = this._strikePool[i];
      if (!s.active) return s;
    }
    return null;
  }

  _deactivateStrike(strike) {
    if (!strike) return;
    strike.active = false;
    strike.mesh.visible = false;
    strike.geometry.setDrawRange(0, 0);
    strike.material.uniforms.uIntensity.value = 0.0;
    strike.widthScale = 1.0;
  }

  _fillStrikeGeometry(strike, start, end, pointCount, displacementScale = 1.0) {
    const a = strike.arrays;
    const positions = a.positions;
    const prevPos = a.prevPos;
    const nextPos = a.nextPos;
    const uvOffset = a.uvOffset;

    const dirX = end.x - start.x;
    const dirY = end.y - start.y;
    const dirLen = Math.max(1e-4, Math.sqrt(dirX * dirX + dirY * dirY));
    const nX = -dirY / dirLen;
    const nY = dirX / dirLen;

    const midX = (start.x + end.x) * 0.5;
    const midY = (start.y + end.y) * 0.5;

    const arcSign = this._randFloat(strike.rng) < 0.5 ? -1.0 : 1.0;
    const arcMag = this.params.curveAmount * dirLen;

    const ctrlX = midX + nX * arcMag * arcSign;
    const ctrlY = midY + nY * arcMag * arcSign;

    const s = Math.max(0.0, displacementScale);
    const macro = Math.max(0.0, this.params.macroDisplacement) * s;
    const micro = Math.max(0.0, this.params.microJitter) * s;

    for (let i = 0; i < pointCount; i++) {
      const t = pointCount <= 1 ? 0 : i / (pointCount - 1);
      const omt = 1.0 - t;

      const bx = (omt * omt * start.x) + (2.0 * omt * t * ctrlX) + (t * t * end.x);
      const by = (omt * omt * start.y) + (2.0 * omt * t * ctrlY) + (t * t * end.y);

      const sway = Math.sin(t * 3.14159265);
      const dMacro = (this._randFloatRange(strike.rng, -1, 1)) * macro * sway;
      const dMicro = (this._randFloatRange(strike.rng, -1, 1)) * micro;

      const px = bx + nX * (dMacro + dMicro);
      const py = by + nY * (dMacro + dMicro);
      const pz = start.z;

      const v0 = i * 2;
      const v1 = v0 + 1;

      uvOffset[v0] = t;
      uvOffset[v1] = t;

      positions[(v0 * 3) + 0] = px;
      positions[(v0 * 3) + 1] = py;
      positions[(v0 * 3) + 2] = pz;

      positions[(v1 * 3) + 0] = px;
      positions[(v1 * 3) + 1] = py;
      positions[(v1 * 3) + 2] = pz;
    }

    for (let i = 0; i < pointCount; i++) {
      const iPrev = Math.max(0, i - 1);
      const iNext = Math.min(pointCount - 1, i + 1);

      const pPrev = iPrev * 2;
      const pCurr = i * 2;
      const pNext = iNext * 2;

      const prevX = positions[pPrev * 3 + 0];
      const prevY = positions[pPrev * 3 + 1];
      const prevZ = positions[pPrev * 3 + 2];

      const nextX = positions[pNext * 3 + 0];
      const nextY = positions[pNext * 3 + 1];
      const nextZ = positions[pNext * 3 + 2];

      for (let k = 0; k < 2; k++) {
        const v = pCurr + k;
        prevPos[v * 3 + 0] = prevX;
        prevPos[v * 3 + 1] = prevY;
        prevPos[v * 3 + 2] = prevZ;

        nextPos[v * 3 + 0] = nextX;
        nextPos[v * 3 + 1] = nextY;
        nextPos[v * 3 + 2] = nextZ;
      }
    }

    const geom = strike.geometry;
    geom.attributes.position.needsUpdate = true;
    geom.attributes.prevPos.needsUpdate = true;
    geom.attributes.nextPos.needsUpdate = true;
    geom.attributes.uvOffset.needsUpdate = true;

    if (pointCount > 1) {
      geom.setDrawRange(0, (pointCount - 1) * 6);
    } else {
      geom.setDrawRange(0, 0);
    }

    strike.pointCount = pointCount;
  }

  _onStrikeAudio(_info) {
  }

  _createNoiseTexture() {
    const THREE = window.THREE;
    const size = 128;

    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    const img = ctx.createImageData(size, size);
    const d = img.data;

    let seed = 1337;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967295;
    };

    for (let i = 0; i < size * size; i++) {
      const r = rand();
      const v = Math.floor(r * 255);
      const o = i * 4;
      d[o] = v;
      d[o + 1] = v;
      d[o + 2] = v;
      d[o + 3] = 255;
    }

    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;

    return tex;
  }

  _hashStringToUint(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  _randFloat(rng) {
    rng.state = (Math.imul(rng.state, 1664525) + 1013904223) >>> 0;
    return rng.state / 4294967295;
  }

  _randFloatRange(rng, a, b) {
    return a + (b - a) * this._randFloat(rng);
  }

  _randInt(rng, a, b) {
    const lo = Math.min(a, b) | 0;
    const hi = Math.max(a, b) | 0;
    return lo + Math.floor(this._randFloat(rng) * (hi - lo + 1));
  }
}
