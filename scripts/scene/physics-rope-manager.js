import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';
import { OVERLAY_THREE_LAYER, ROPE_MASK_LAYER } from '../effects/EffectComposer.js';

const log = createLogger('PhysicsRopeManager');

const DEFAULT_TEXTURE_PATH = 'modules/map-shine-advanced/assets/rope.webp';

const ROPE_PRESETS = {
  rope: {
    segmentLength: 12,
    damping: 0.98,
    windForce: 1.2,
    bendStiffness: 0.5,
    tapering: 0.55,
    width: 22,
    uvRepeatWorld: 64,
    zOffset: 0.025,
    gravityStrength: 1.0,
    slackFactor: 1.05,
    windGustAmount: 0.5,
    invertWindDirection: false,
    constraintIterations: 6
  },
  chain: {
    segmentLength: 22,
    damping: 0.92,
    windForce: 0.25,
    bendStiffness: 0.5,
    tapering: 0.15,
    width: 18,
    uvRepeatWorld: 48,
    zOffset: 0.026,
    gravityStrength: 1.0,
    slackFactor: 1.02,
    windGustAmount: 0.5,
    invertWindDirection: false,
    constraintIterations: 6
  }
};

function _getBehaviorDefaultsForType(ropeType) {
  try {
    const saved = game?.settings?.get?.('map-shine-advanced', 'rope-default-behavior');
    if (saved && typeof saved === 'object') {
      const key = ropeType === 'rope' ? 'rope' : 'chain';
      const b = saved[key];
      if (b && typeof b === 'object') return b;
    }
  } catch (e) {
  }

  try {
    const ui = window.MapShine?.uiManager;
    const d = ui?.ropeBehaviorDefaults;
    if (d && typeof d === 'object') {
      const key = ropeType === 'rope' ? 'rope' : 'chain';
      const b = d[key];
      if (b && typeof b === 'object') return b;
    }
  } catch (e) {
  }
  return null;
}

class RopeInstance {
  constructor(scene, sceneComposer, config, texture) {
    this.scene = scene;
    this.sceneComposer = sceneComposer;
    this.id = config.id;

    this.config = config;
    this.texture = texture;

    // Simulation Z is in a physics space (pixels-ish). `zOffset` is meant as a tiny render lift
    // above the map to avoid z-fighting. Using `zOffset` as a physical anchor height causes
    // extreme sag because gravity is in pixel units.
    this._anchorZ = 0.0;
    this._renderZOffset = Number.isFinite(config.zOffset) ? config.zOffset : 0.025;

    this._buildSimulation(config.anchorPoints);
    this._buildMesh();

    this._baseColor = null;
    this._lastWindowLightStrength = 0;
  }

  _buildSimulation(anchorPoints) {
    const pts = this._subdivide(anchorPoints, this.config.segmentLength);
    const n = pts.length;

    this.count = n;

    // 3D position arrays
    this.posX = new Float32Array(n);
    this.posY = new Float32Array(n);
    this.posZ = new Float32Array(n);

    this.prevX = new Float32Array(n);
    this.prevY = new Float32Array(n);
    this.prevZ = new Float32Array(n);

    this.locked = new Uint8Array(n);

    // Initialize points flat at the anchor height
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      this.posX[i] = p.x;
      this.posY[i] = p.y;
      this.posZ[i] = this._anchorZ;

      this.prevX[i] = this.posX[i];
      this.prevY[i] = this.posY[i];
      this.prevZ[i] = this.posZ[i];
    }

    // Lock start and end points
    if (n >= 1) this.locked[0] = 1;
    if (n >= 2) this.locked[n - 1] = 1;

    // SLACK_FACTOR > 1.0 creates extra length, allowing gravity to pull the center down
    const SLACK_FACTOR = Number.isFinite(this.config.slackFactor) ? this.config.slackFactor : 1.05;

    this.segLen = new Float32Array(Math.max(0, n - 1));
    this.bendLen = new Float32Array(Math.max(0, n - 2));

    // Calculate straight-line path length
    let totalDist = 0;
    for (let i = 0; i < n - 1; i++) {
      const dx = this.posX[i + 1] - this.posX[i];
      const dy = this.posY[i + 1] - this.posY[i];
      totalDist += Math.sqrt(dx * dx + dy * dy);
    }

    // Distribute slack evenly
    const targetTotalLength = totalDist * SLACK_FACTOR;
    const targetSegLen = targetTotalLength / (n - 1);

    for (let i = 0; i < n - 1; i++) {
      this.segLen[i] = targetSegLen;
    }

    // Setup bending constraints (distance between i and i+2)
    for (let i = 0; i < n - 2; i++) {
      this.bendLen[i] = this.segLen[i] + this.segLen[i + 1];
    }

    this._dist = new Float32Array(n);
  }

  _subdivide(anchorPoints, segmentLength) {
    if (!Array.isArray(anchorPoints) || anchorPoints.length < 2) return [];
    const out = [];

    for (let i = 0; i < anchorPoints.length - 1; i++) {
      const a = anchorPoints[i];
      const b = anchorPoints[i + 1];
      const ax = Number(a?.x);
      const ay = Number(a?.y);
      const bx = Number(b?.x);
      const by = Number(b?.y);
      if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) continue;

      const dx = bx - ax;
      const dy = by - ay;
      const d = Math.sqrt(dx * dx + dy * dy);
      const segs = Math.max(1, Math.ceil(d / Math.max(1, segmentLength)));

      for (let j = 0; j < segs; j++) {
        const t = j / segs;
        out.push({ x: ax + dx * t, y: ay + dy * t });
      }
    }

    const last = anchorPoints[anchorPoints.length - 1];
    const lx = Number(last?.x);
    const ly = Number(last?.y);
    if (Number.isFinite(lx) && Number.isFinite(ly)) out.push({ x: lx, y: ly });

    return out;
  }

  _buildMesh() {
    const THREE = window.THREE;
    const n = this.count;

    const positions = new Float32Array(n * 2 * 3);
    const uvs = new Float32Array(n * 2 * 2);
    const ropeT = new Float32Array(n * 2);

    const indices = new Uint32Array(Math.max(0, (n - 1) * 6));
    let ii = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices[ii++] = a;
      indices[ii++] = c;
      indices[ii++] = b;
      indices[ii++] = b;
      indices[ii++] = c;
      indices[ii++] = d;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aRopeT', new THREE.BufferAttribute(ropeT, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));

    this._positions = positions;
    this._uvs = uvs;
    this._ropeT = ropeT;
    this.geometry = geo;

    const tex = this.texture;
    if (tex) {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      // Ropes are thin geometry; mipmaps often make them look overly blurry when zoomed out.
      // Prefer crisp minification and rely on anisotropy for angled sampling.
      tex.generateMipmaps = false;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;

      try {
        const renderer = window.MapShine?.effectComposer?.renderer;
        if (renderer?.capabilities?.getMaxAnisotropy) {
          tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        }
      } catch (_) {
      }

      tex.needsUpdate = true;
    }

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      premultipliedAlpha: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      uniforms: {
        uMap: { value: tex || null },
        uWindowLight: { value: null },
        uHasWindowLight: { value: 0.0 },
        uInvScreenSize: { value: new THREE.Vector2(1, 1) },
        uWindowBoost: { value: 0.0 },
        uEndFadeSize: { value: Number.isFinite(this.config.endFadeSize) ? this.config.endFadeSize : 0.0 },
        uEndFadeStrength: { value: Number.isFinite(this.config.endFadeStrength) ? this.config.endFadeStrength : 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        attribute float aRopeT;
        varying float vRopeT;
        void main() {
          vUv = uv;
          vRopeT = aRopeT;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        uniform sampler2D uWindowLight;
        uniform float uHasWindowLight;
        uniform vec2 uInvScreenSize;
        uniform float uWindowBoost;
        uniform float uEndFadeSize;
        uniform float uEndFadeStrength;
        varying vec2 vUv;
        varying float vRopeT;

        void main() {
          vec4 texel = texture2D(uMap, vUv);
          if (texel.a <= 0.0001) discard;

          float a = texel.a;
          vec3 base = texel.rgb * a;

          float endSize = clamp(uEndFadeSize, 0.0, 0.5);
          float endStrength = clamp(uEndFadeStrength, 0.0, 1.0);
          if (endSize > 0.0001 && endStrength > 0.0001) {
            float d = min(vRopeT, 1.0 - vRopeT);
            float t = smoothstep(0.0, endSize, d);
            float mult = mix(1.0 - endStrength, 1.0, t);
            base *= mult;
          }

          if (uHasWindowLight > 0.5 && uWindowBoost > 0.0001) {
            vec2 suv = gl_FragCoord.xy * uInvScreenSize;
            vec4 wl = texture2D(uWindowLight, suv);
            base += wl.rgb * uWindowBoost * (a * a);
          }

          gl_FragColor = vec4(base, a);
        }
      `
    });
    mat.toneMapped = false;

    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);

    // Render in overlay so the rope doesn't get fully occluded by overhead tiles.
    // We still place it near the overhead Z band so perspective/parallax stays consistent.
    this.mesh.layers.set(OVERLAY_THREE_LAYER);
    this.mesh.layers.enable(ROPE_MASK_LAYER);

    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);

    this._baseColor = new THREE.Color(1, 1, 1);

    this._updateGeometry(true);
  }

  update(timeInfo) {
    const dtRaw = typeof timeInfo?.delta === 'number' ? timeInfo.delta : 0.016;
    const dt = Math.min(Math.max(dtRaw, 0.001), 0.05);

    try {
      const u = this.material?.uniforms;
      if (u?.uEndFadeSize) u.uEndFadeSize.value = Number.isFinite(this.config.endFadeSize) ? this.config.endFadeSize : 0.0;
      if (u?.uEndFadeStrength) u.uEndFadeStrength.value = Number.isFinite(this.config.endFadeStrength) ? this.config.endFadeStrength : 0.0;
    } catch (_) {}

    const n = this.count;
    if (n < 2) return;

    const damping = Number.isFinite(this.config.damping) ? this.config.damping : 0.98;
    const bendStiffness = (Number.isFinite(this.config.bendStiffness) ? this.config.bendStiffness : 0.5) * 0.5;

    // --- Weather / Wind ---
    const wState = weatherController.getCurrentState?.();
    const wSpeed = wState && Number.isFinite(wState.windSpeed) ? wState.windSpeed : 0;
    const wDir = wState && wState.windDirection;
    const wdx = wDir && Number.isFinite(wDir.x) ? wDir.x : 1;
    const wdy = wDir && Number.isFinite(wDir.y) ? wDir.y : 0;

    // Wind Strength Scalar
    const windForceMag = (Number.isFinite(this.config.windForce) ? this.config.windForce : 1.0) * wSpeed * 1000;

    // Wind Noise (Gusts)
    // Use TimeManager time so all effects stay in sync (and support pause/scale).
    const time = (typeof timeInfo?.elapsed === 'number') ? (timeInfo.elapsed * 1000.0) : performance.now();
    const gustAmount = Number.isFinite(this.config.windGustAmount) ? this.config.windGustAmount : 0.5;
    const globalGust = (Math.sin(time * 0.0005) + Math.cos(time * 0.0013)) * 0.5 + 0.5;

    // Gravity on Z-axis (Pixels/s^2) - configurable strength
    const gravityStrength = Number.isFinite(this.config.gravityStrength) ? this.config.gravityStrength : 1.0;
    const GRAVITY_Z = -1200 * gravityStrength;

    // Roof Occlusion for Wind
    const mid = (n / 2) | 0;
    let windMask = 1.0;
    try {
      const d = canvas?.dimensions;
      if (d) {
        const outdoor = weatherController.getRoofMaskIntensity?.(
          (this.posX[mid] - d.sceneRect.x) / d.sceneRect.width,
          (d.sceneRect.height - (this.posY[mid] - d.sceneRect.y)) / d.sceneRect.height
        );
        if (Number.isFinite(outdoor)) windMask = 0.1 + 0.9 * outdoor;
      }
    } catch (_) {}

    const windVecX = wdx * windForceMag * windMask;
    const windVecY = wdy * windForceMag * windMask;

    // The UI (and some other systems) can treat wind direction as the direction
    // the wind is COMING FROM rather than GOING TO. Allow inverting so the rope
    // can match the user's mental model.
    const windSign = this.config?.invertWindDirection ? -1.0 : 1.0;

    // 1. Verlet Integration (3D)
    for (let i = 0; i < n; i++) {
      if (this.locked[i]) continue;

      const x = this.posX[i];
      const y = this.posY[i];
      const z = this.posZ[i];

      const px = this.prevX[i];
      const py = this.prevY[i];
      const pz = this.prevZ[i];

      let vx = (x - px) * damping;
      let vy = (y - py) * damping;
      let vz = (z - pz) * damping;

      // Wind Gust Variation
      const nodeGust = Math.sin(time * 0.003 + i * 0.2) * 0.5;
      const gust = ((globalGust - 0.5) * 1.0) + nodeGust;
      const totalWindMult = Math.max(0.0, 1.0 + gustAmount * gust);

      // Apply Forces
      vx += (windVecX * windSign) * totalWindMult * dt * dt;
      vy += (windVecY * windSign) * totalWindMult * dt * dt;
      vz += GRAVITY_Z * dt * dt;

      // Update
      this.prevX[i] = x;
      this.prevY[i] = y;
      this.prevZ[i] = z;

      this.posX[i] = x + vx;
      this.posY[i] = y + vy;
      this.posZ[i] = z + vz;
    }

    // 2. Constraint Solver
    const iterations = Number.isFinite(this.config.constraintIterations) ? Math.max(1, Math.min(20, this.config.constraintIterations)) : 6;
    for (let it = 0; it < iterations; it++) {
      // Distance Constraints
      for (let i = 0; i < n - 1; i++) {
        const i1 = i;
        const i2 = i + 1;

        const dx = this.posX[i2] - this.posX[i1];
        const dy = this.posY[i2] - this.posY[i1];
        const dz = this.posZ[i2] - this.posZ[i1];

        const distSq = dx * dx + dy * dy + dz * dz;
        const dist = Math.sqrt(distSq) || 0.001;

        const diff = (dist - this.segLen[i]) / dist;
        const correction = diff * 0.5;

        const cx = dx * correction;
        const cy = dy * correction;
        const cz = dz * correction;

        if (!this.locked[i1]) {
          this.posX[i1] += cx;
          this.posY[i1] += cy;
          this.posZ[i1] += cz;
        }
        if (!this.locked[i2]) {
          this.posX[i2] -= cx;
          this.posY[i2] -= cy;
          this.posZ[i2] -= cz;
        }
      }

      // Bending Constraints
      if (bendStiffness > 0.01) {
        for (let i = 0; i < n - 2; i++) {
          const i1 = i;
          const i3 = i + 2;

          const dx = this.posX[i3] - this.posX[i1];
          const dy = this.posY[i3] - this.posY[i1];
          const dz = this.posZ[i3] - this.posZ[i1];

          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
          const diff = (dist - this.bendLen[i]) / dist;

          const correction = diff * 0.5 * bendStiffness;

          if (!this.locked[i1]) {
            this.posX[i1] += dx * correction;
            this.posY[i1] += dy * correction;
            this.posZ[i1] += dz * correction;
          }
          if (!this.locked[i3]) {
            this.posX[i3] -= dx * correction;
            this.posY[i3] -= dy * correction;
            this.posZ[i3] -= dz * correction;
          }
        }
      }
    }

    this._updateGeometry(false);
  }

  _updateGeometry(forceBoundsUpdate) {
    const THREE = window.THREE;
    const n = this.count;
    if (!this.geometry || !this._positions || !this._uvs || !this._ropeT || n < 2) return;

    const groundZ = this.sceneComposer?.groundZ;
    // Place ropes just under overhead tiles (TileManager uses Z_OVERHEAD_OFFSET=0.08).
    // Keep this slightly below that so roofs can occlude the rope cleanly.
    const ROPE_BASE_Z_OFFSET = 0.07;
    const zBase = (Number.isFinite(groundZ) ? groundZ : 0) + ROPE_BASE_Z_OFFSET;

    // Render Z scaling: keep the visual sag subtle while still letting Z influence constraints.
    // This prevents large perspective “dips” as the camera moves.
    const Z_RENDER_SCALE = 0.02;

    const baseHalfWidth = (Number.isFinite(this.config.width) ? this.config.width : 20) * 0.5;
    const tapering = Number.isFinite(this.config.tapering) ? this.config.tapering : 0.5;
    const uvRepeatWorld = Number.isFinite(this.config.uvRepeatWorld) ? this.config.uvRepeatWorld : 64;

    // Recalculate UVs based on actual 3D length to prevent stretching
    if (!this._dist || this._dist.length !== n) this._dist = new Float32Array(n);
    let cum = 0;
    this._dist[0] = 0;
    for (let i = 1; i < n; i++) {
      const dx = this.posX[i] - this.posX[i - 1];
      const dy = this.posY[i] - this.posY[i - 1];
      const dz = this.posZ[i] - this.posZ[i - 1];
      cum += Math.sqrt(dx * dx + dy * dy + dz * dz);
      this._dist[i] = cum;
    }

    for (let i = 0; i < n; i++) {
      const x = this.posX[i];
      const y = this.posY[i];
      // Add global Z offset to simulated Z
      const z = (this.posZ[i] * Z_RENDER_SCALE) + zBase + this._renderZOffset;

      // Ribbon calculation (billboarded to camera in 2D plane)
      let tx = 1;
      let ty = 0;
      if (i < n - 1) {
        tx = this.posX[i + 1] - x;
        ty = this.posY[i + 1] - y;
      } else {
        tx = x - this.posX[i - 1];
        ty = y - this.posY[i - 1];
      }

      const tLen = Math.sqrt(tx * tx + ty * ty) || 1;
      const nx = -ty / tLen;
      const ny = tx / tLen;

      const norm = i / (n - 1);
      const sagAmount = Math.sin(norm * Math.PI);
      const taperFactor = 1.0 - sagAmount * (tapering * 0.7);
      const hw = baseHalfWidth * taperFactor;

      const vi = i * 2;
      const p0 = vi * 3;
      const p1 = (vi + 1) * 3;

      this._positions[p0] = x + nx * hw;
      this._positions[p0 + 1] = y + ny * hw;
      this._positions[p0 + 2] = z;

      this._positions[p1] = x - nx * hw;
      this._positions[p1 + 1] = y - ny * hw;
      this._positions[p1 + 2] = z;

      const d = (this._dist && this._dist.length === n) ? this._dist[i] : 0;
      const u = uvRepeatWorld > 0 ? (d / uvRepeatWorld) : 0;
      const u0 = vi * 2;
      const u1 = (vi + 1) * 2;

      this._uvs[u0] = u;
      this._uvs[u0 + 1] = 0;

      this._uvs[u1] = u;
      this._uvs[u1 + 1] = 1;

      const tNorm = n > 1 ? (i / (n - 1)) : 0.0;
      this._ropeT[vi] = tNorm;
      this._ropeT[vi + 1] = tNorm;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.uv.needsUpdate = true;
    this.geometry.attributes.aRopeT.needsUpdate = true;

    this.geometry.computeBoundingBox();
    this.geometry.computeBoundingSphere();
  }

  dispose() {
    if (this.mesh && this.mesh.parent) this.mesh.parent.remove(this.mesh);
    if (this.geometry) this.geometry.dispose();
    if (this.material) {
      if (this.material.map) this.material.map = null;
      this.material.dispose();
    }

    this.mesh = null;
    this.geometry = null;
    this.material = null;
  }
}

export class PhysicsRopeManager {
  constructor(scene, sceneComposer, mapPointsManager) {
    this.scene = scene;
    this.sceneComposer = sceneComposer;
    this.mapPointsManager = mapPointsManager;

    this._ropes = new Map();
    this._textureCache = new Map();

    this._pendingRebuild = false;
    this._rebuildInProgress = false;
    this._rebuildGen = 0;

    this._lastDiagLog = 0;
    this._lastConfigCount = null;
    this._lastRopeCount = null;

    this._windowMaskData = null;
    this._windowMaskWidth = 0;
    this._windowMaskHeight = 0;
    this._windowMaskExtractFailed = false;

    this._outdoorsMaskData = null;
    this._outdoorsMaskWidth = 0;
    this._outdoorsMaskHeight = 0;
    this._outdoorsMaskExtractFailed = false;

    this._tempWindowColor = null;

    this._tempProject = null;
    this._tempProject4 = null;
    this._windowLightPixel = null;
    this._windowLightSampleSkip = 0;
    this._windowLightLastSample = null;

    this._windowLightDiagLast = 0;

    this._tmpDrawSize = null;

    this._onMapPointsChanged = this._onMapPointsChanged.bind(this);
  }

  _sampleWindowLightFromTarget(worldX, worldY, worldZ) {
    const wle = window.MapShine?.windowLightEffect;
    if (!wle || !wle.enabled || !wle.params?.hasWindowMask || !wle.lightTarget) return null;

    const effectComposer = window.MapShine?.effectComposer;
    const renderer = effectComposer?.renderer;
    if (!renderer || typeof renderer.readRenderTargetPixels !== 'function') return null;

    const cam = this.sceneComposer?.camera;
    const THREE = window.THREE;
    if (!cam || !THREE) return null;

    // Throttle: sample at most every 2 frames (global). Return cached sample on skipped frames.
    this._windowLightSampleSkip = (this._windowLightSampleSkip + 1) % 2;
    if (this._windowLightSampleSkip !== 0) return this._windowLightLastSample;

    if (!this._tempProject) this._tempProject = new THREE.Vector3();
    if (!this._windowLightPixel) this._windowLightPixel = new Uint8Array(4);

    this._tempProject.set(worldX, worldY, worldZ || 0);
    this._tempProject.project(cam);

    // NDC -> pixel
    const rtW = wle.lightTarget.width;
    const rtH = wle.lightTarget.height;
    if (!rtW || !rtH) return null;

    const px = Math.floor((this._tempProject.x * 0.5 + 0.5) * rtW);
    const pyTop = Math.floor((this._tempProject.y * 0.5 + 0.5) * rtH);

    if (px < 0 || px >= rtW || pyTop < 0 || pyTop >= rtH) return null;

    // readRenderTargetPixels y is bottom-left origin
    const py = (rtH - 1) - pyTop;

    try {
      renderer.readRenderTargetPixels(wle.lightTarget, px, py, 1, 1, this._windowLightPixel);
    } catch (_) {
      return null;
    }

    const r = this._windowLightPixel[0] / 255;
    const g = this._windowLightPixel[1] / 255;
    const b = this._windowLightPixel[2] / 255;
    const a = this._windowLightPixel[3] / 255;
    if (a <= 0.001) {
      this._windowLightLastSample = null;
      return null;
    }

    // lightTarget stores premultiplied rgb and brightness in alpha.
    // Keep the sample premultiplied so callers can add rgb directly.
    this._windowLightLastSample = { r, g, b, strength: a, premultiplied: true };
    return this._windowLightLastSample;
  }

  _extractMaskData(texture) {
    if (!texture) return null;
    if (!texture.image) return null;

    const image = texture.image;
    const isDrawable = (
      image instanceof HTMLImageElement ||
      image instanceof HTMLCanvasElement ||
      image instanceof ImageBitmap ||
      (typeof OffscreenCanvas !== 'undefined' && image instanceof OffscreenCanvas) ||
      (typeof VideoFrame !== 'undefined' && image instanceof VideoFrame)
    );
    if (!isDrawable) return null;

    try {
      const canvasEl = document.createElement('canvas');
      const w = image.width || image.naturalWidth || 256;
      const h = image.height || image.naturalHeight || 256;
      canvasEl.width = w;
      canvasEl.height = h;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(image, 0, 0, w, h);
      const imageData = ctx.getImageData(0, 0, w, h);
      return { data: imageData.data, width: w, height: h };
    } catch (_) {
      return null;
    }
  }

  _sampleWindowLight(u, v) {
    const wle = window.MapShine?.windowLightEffect;
    if (!wle || !wle.enabled || !wle.params?.hasWindowMask || !wle.windowMask) return null;

    if (!this._windowMaskData && !this._windowMaskExtractFailed) {
      const extracted = this._extractMaskData(wle.windowMask);
      if (extracted) {
        this._windowMaskData = extracted.data;
        this._windowMaskWidth = extracted.width;
        this._windowMaskHeight = extracted.height;
      } else {
        this._windowMaskExtractFailed = true;
      }
    }

    if (!this._windowMaskData || this._windowMaskWidth <= 0 || this._windowMaskHeight <= 0) return null;

    const uu = Math.max(0, Math.min(1, u));
    const vv = Math.max(0, Math.min(1, v));
    const ix = Math.floor(uu * (this._windowMaskWidth - 1));
    const iy = Math.floor(vv * (this._windowMaskHeight - 1));
    const idx = (iy * this._windowMaskWidth + ix) * 4;
    const r = this._windowMaskData[idx] / 255;
    const g = this._windowMaskData[idx + 1] / 255;
    const b = this._windowMaskData[idx + 2] / 255;
    const lum = (r * 0.2126 + g * 0.7152 + b * 0.0722);

    const falloff = (typeof wle.params?.falloff === 'number' && Number.isFinite(wle.params.falloff))
      ? Math.max(0.01, wle.params.falloff)
      : 1.0;
    const shaped = Math.pow(Math.max(0.0, lum), falloff);

    let indoorFactor = 1.0;
    if (wle.outdoorsMask) {
      if (!this._outdoorsMaskData && !this._outdoorsMaskExtractFailed) {
        const extracted = this._extractMaskData(wle.outdoorsMask);
        if (extracted) {
          this._outdoorsMaskData = extracted.data;
          this._outdoorsMaskWidth = extracted.width;
          this._outdoorsMaskHeight = extracted.height;
        } else {
          this._outdoorsMaskExtractFailed = true;
        }
      }

      if (this._outdoorsMaskData && this._outdoorsMaskWidth > 0 && this._outdoorsMaskHeight > 0) {
        const oix = Math.floor(uu * (this._outdoorsMaskWidth - 1));
        const oiy = Math.floor(vv * (this._outdoorsMaskHeight - 1));
        const oIdx = (oiy * this._outdoorsMaskWidth + oix) * 4;
        const outdoorStrength = this._outdoorsMaskData[oIdx] / 255;
        indoorFactor = 1.0 - Math.max(0.0, Math.min(1.0, outdoorStrength));
      }
    }

    let darkness = 0.0;
    try {
      const le = window.MapShine?.lightingEffect;
      if (le && typeof le.getEffectiveDarkness === 'function') {
        darkness = le.getEffectiveDarkness();
      } else if (typeof canvas?.environment?.darknessLevel === 'number') {
        darkness = canvas.environment.darknessLevel;
      }
    } catch (_) {
    }
    darkness = (typeof darkness === 'number' && Number.isFinite(darkness))
      ? Math.max(0.0, Math.min(1.0, darkness))
      : 0.0;

    const nightDimming = (typeof wle.params?.nightDimming === 'number' && Number.isFinite(wle.params.nightDimming))
      ? Math.max(0.0, Math.min(1.0, wle.params.nightDimming))
      : 1.0;
    const envFactor = 1.0 - Math.max(0.0, Math.min(1.0, darkness * nightDimming));

    const intensity = (typeof wle.params?.intensity === 'number' && Number.isFinite(wle.params.intensity))
      ? Math.max(0.0, wle.params.intensity)
      : 0.0;

    const strength = shaped * indoorFactor * intensity * envFactor;
    if (strength <= 0.0001) return null;

    const c = wle.params?.color;
    const cr = (c && typeof c.r === 'number') ? c.r : 1.0;
    const cg = (c && typeof c.g === 'number') ? c.g : 1.0;
    const cb = (c && typeof c.b === 'number') ? c.b : 1.0;
    return { r: cr, g: cg, b: cb, strength };
  }

  _getDefaultTexturePathForType(ropeType) {
    try {
      const saved = game?.settings?.get?.('map-shine-advanced', 'rope-default-textures');
      if (saved && typeof saved === 'object') {
        const ropePath = typeof saved.ropeTexturePath === 'string' ? saved.ropeTexturePath.trim() : '';
        const chainPath = typeof saved.chainTexturePath === 'string' ? saved.chainTexturePath.trim() : '';
        if (ropeType === 'rope' && ropePath) return ropePath;
        if (ropeType === 'chain' && chainPath) return chainPath;
      }
    } catch (e) {
    }

    try {
      const ui = window.MapShine?.uiManager;
      const d = ui?.ropeDefaults;
      const ropePath = typeof d?.ropeTexturePath === 'string' ? d.ropeTexturePath.trim() : '';
      const chainPath = typeof d?.chainTexturePath === 'string' ? d.chainTexturePath.trim() : '';
      if (ropeType === 'rope' && ropePath) return ropePath;
      if (ropeType === 'chain' && chainPath) return chainPath;
    } catch (e) {
    }

    return DEFAULT_TEXTURE_PATH;
  }

  initialize() {
    if (!this.mapPointsManager) return;

    try {
      this.mapPointsManager.addChangeListener(this._onMapPointsChanged);
    } catch (e) {
    }

    this.requestRebuild();
  }

  _onMapPointsChanged() {
    this.requestRebuild();
  }

  requestRebuild() {
    this._pendingRebuild = true;
  }

  async _loadTexture(path) {
    const key = (typeof path === 'string' && path.trim().length > 0) ? path.trim() : DEFAULT_TEXTURE_PATH;
    if (this._textureCache.has(key)) return this._textureCache.get(key);

    const p = (async () => {
      const THREE = window.THREE;
      const loadTextureFn = globalThis.foundry?.canvas?.loadTexture ?? globalThis.loadTexture;

      if (loadTextureFn) {
        const pixiTexture = await loadTextureFn(key);
        const resource = pixiTexture?.baseTexture?.resource;
        const source = resource?.source;
        if (source) {
          const tex = new THREE.Texture(source);
          tex.needsUpdate = true;
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          // Ropes are visually thin; mipmaps tend to wash them out when zoomed out.
          // Prefer crisp minification + anisotropy.
          tex.minFilter = THREE.LinearFilter;
          tex.magFilter = THREE.LinearFilter;
          tex.generateMipmaps = false;

          try {
            const renderer = window.MapShine?.effectComposer?.renderer;
            if (renderer?.capabilities?.getMaxAnisotropy) {
              tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
            }
          } catch (_) {
          }
          return tex;
        }
      }

      const loader = new THREE.TextureLoader();
      return await new Promise((resolve, reject) => {
        loader.load(key, resolve, undefined, reject);
      });
    })();

    this._textureCache.set(key, p);
    return p;
  }

  async _rebuildAsync(gen) {
    if (!this.mapPointsManager) return;

    const configs = this.mapPointsManager.getRopeConfigurations();

    try {
      const now = performance.now();
      if (now - this._lastDiagLog > 2000) {
        this._lastDiagLog = now;
        const cfgCount = Array.isArray(configs) ? configs.length : 0;
        const ropeCount = this._ropes.size;
        if (cfgCount !== this._lastConfigCount || ropeCount !== this._lastRopeCount) {
          this._lastConfigCount = cfgCount;
          this._lastRopeCount = ropeCount;
          log.info(`Rope rebuild: configs=${cfgCount}, instances=${ropeCount}`);
        }
      }
    } catch (e) {
    }

    const keep = new Set();
    for (const cfg of configs) {
      const group = cfg.group;
      const id = group?.id;
      if (!id) continue;
      keep.add(id);

      const ropeType = (group.ropeType === 'rope' || group.ropeType === 'chain') ? group.ropeType : (cfg.ropeType === 'rope' ? 'rope' : 'chain');
      const preset = ROPE_PRESETS[ropeType] || ROPE_PRESETS.chain;
      const behaviorDefaults = _getBehaviorDefaultsForType(ropeType);

      const defaultTexturePath = this._getDefaultTexturePathForType(ropeType);
      const groupTexturePath = typeof group.texturePath === 'string' ? group.texturePath.trim() : '';
      const cfgTexturePath = typeof cfg.texturePath === 'string' ? cfg.texturePath.trim() : '';
      const texturePath = groupTexturePath || cfgTexturePath || defaultTexturePath || DEFAULT_TEXTURE_PATH;

      const merged = {
        id,
        anchorPoints: cfg.points,
        ropeType,
        texturePath,
        segmentLength: Number.isFinite(group.segmentLength) ? group.segmentLength : (Number.isFinite(cfg.segmentLength) ? cfg.segmentLength : (Number.isFinite(behaviorDefaults?.segmentLength) ? behaviorDefaults.segmentLength : preset.segmentLength)),
        damping: Number.isFinite(group.damping) ? group.damping : (Number.isFinite(behaviorDefaults?.damping) ? behaviorDefaults.damping : preset.damping),
        windForce: Number.isFinite(group.windForce) ? group.windForce : (Number.isFinite(behaviorDefaults?.windForce) ? behaviorDefaults.windForce : preset.windForce),
        windGustAmount: Number.isFinite(group.windGustAmount) ? group.windGustAmount : (Number.isFinite(behaviorDefaults?.windGustAmount) ? behaviorDefaults.windGustAmount : preset.windGustAmount),
        invertWindDirection: typeof group.invertWindDirection === 'boolean' ? group.invertWindDirection : (typeof behaviorDefaults?.invertWindDirection === 'boolean' ? behaviorDefaults.invertWindDirection : !!preset.invertWindDirection),
        gravityStrength: Number.isFinite(group.gravityStrength) ? group.gravityStrength : (Number.isFinite(behaviorDefaults?.gravityStrength) ? behaviorDefaults.gravityStrength : preset.gravityStrength),
        slackFactor: Number.isFinite(group.slackFactor) ? group.slackFactor : (Number.isFinite(behaviorDefaults?.slackFactor) ? behaviorDefaults.slackFactor : preset.slackFactor),
        constraintIterations: Number.isFinite(group.constraintIterations) ? group.constraintIterations : (Number.isFinite(behaviorDefaults?.constraintIterations) ? behaviorDefaults.constraintIterations : preset.constraintIterations),
        bendStiffness: Number.isFinite(group.bendStiffness) ? group.bendStiffness : (Number.isFinite(behaviorDefaults?.bendStiffness) ? behaviorDefaults.bendStiffness : preset.bendStiffness),
        tapering: Number.isFinite(group.tapering) ? group.tapering : (Number.isFinite(behaviorDefaults?.tapering) ? behaviorDefaults.tapering : preset.tapering),
        width: Number.isFinite(group.width) ? group.width : (Number.isFinite(behaviorDefaults?.width) ? behaviorDefaults.width : preset.width),
        uvRepeatWorld: Number.isFinite(group.uvRepeatWorld) ? group.uvRepeatWorld : (Number.isFinite(behaviorDefaults?.uvRepeatWorld) ? behaviorDefaults.uvRepeatWorld : preset.uvRepeatWorld),
        zOffset: Number.isFinite(group.zOffset) ? group.zOffset : preset.zOffset,
        windowLightBoost: Number.isFinite(group.windowLightBoost) ? group.windowLightBoost : (Number.isFinite(behaviorDefaults?.windowLightBoost) ? behaviorDefaults.windowLightBoost : 0.0),
        endFadeSize: Number.isFinite(group.endFadeSize) ? group.endFadeSize : (Number.isFinite(behaviorDefaults?.endFadeSize) ? behaviorDefaults.endFadeSize : 0.0),
        endFadeStrength: Number.isFinite(group.endFadeStrength) ? group.endFadeStrength : (Number.isFinite(behaviorDefaults?.endFadeStrength) ? behaviorDefaults.endFadeStrength : 0.0)
      };

      const existing = this._ropes.get(id);
      if (existing) {
        const sameTexture = existing.config?.texturePath === merged.texturePath;
        const sameSeg = existing.config?.segmentLength === merged.segmentLength;
        if (sameTexture && sameSeg) {
          existing.config = merged;
          continue;
        }
        existing.dispose();
        this._ropes.delete(id);
      }

      let tex = null;
      try {
        tex = await this._loadTexture(merged.texturePath);
      } catch (_) {
        try {
          tex = await this._loadTexture(DEFAULT_TEXTURE_PATH);
        } catch (_) {
          tex = null;
        }
      }

      if (gen !== this._rebuildGen) return;

      const inst = new RopeInstance(this.scene, this.sceneComposer, merged, tex);
      this._ropes.set(id, inst);
    }

    for (const [id, rope] of this._ropes) {
      if (!keep.has(id)) {
        rope.dispose();
        this._ropes.delete(id);
      }
    }

    try {
      const cfgCount = Array.isArray(configs) ? configs.length : 0;
      const ropeCount = this._ropes.size;
      if (cfgCount !== this._lastConfigCount || ropeCount !== this._lastRopeCount) {
        this._lastConfigCount = cfgCount;
        this._lastRopeCount = ropeCount;
        log.info(`Rope rebuild complete: configs=${cfgCount}, instances=${ropeCount}`);
      }
    } catch (e) {
    }
  }

  update(timeInfo) {
    if (this._pendingRebuild && !this._rebuildInProgress) {
      this._pendingRebuild = false;
      this._rebuildInProgress = true;
      const gen = ++this._rebuildGen;
      this._rebuildAsync(gen).catch((e) => {
        log.warn('Rope rebuild failed', e);
      }).finally(() => {
        if (gen === this._rebuildGen) {
          this._rebuildInProgress = false;
        }
      });
    }

    for (const rope of this._ropes.values()) {
      try {
        rope.update(timeInfo);
      } catch (e) {
      }
    }
  }

  dispose() {
    try {
      this.mapPointsManager?.removeChangeListener?.(this._onMapPointsChanged);
    } catch (e) {
    }

    for (const rope of this._ropes.values()) {
      rope.dispose();
    }
    this._ropes.clear();

    this._textureCache.clear();
  }
}