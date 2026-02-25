/**
 * @fileoverview BuildingShadowsEffectV2 — V2 building shadow bake pass.
 *
 * Generates a greyscale shadow-factor texture (1.0 = fully lit, 0.0 = fully
 * shadowed) from a union of all _Outdoors masks up to and including the
 * currently viewed floor. The union mask represents the combined silhouette
 * of every structure visible from the active viewing level, so upper-floor
 * building footprints naturally extend ground-floor shadows.
 *
 * ## Algorithm (matches V1 BuildingShadowsEffect)
 * The bake shader UV-space raymarches along the sun direction from each pixel.
 * Black pixels in the mask (= indoor / building interior) are occluders.
 * If any step along the ray hits a black pixel, the current pixel is in shadow.
 * Output: shadow factor stored in a fixed-resolution RT (1.0 = lit, 0.0 = shadowed).
 *
 * ## Multi-floor shadow extension
 * A union of all floor masks (0..maxFloorIndex) is computed on the CPU via
 * Canvas 2D `ctx.globalCompositeOperation = 'lighten'` (max per channel).
 * This is only rebuilt on floor change, not every frame.
 * The bake shader receives `uFloorCount` and `uFloorHeightShadowScale` to
 * scale shadow length proportionally, simulating taller structures.
 *
 * ## V2 simplification over V1
 * V1 required a world-pinned display mesh to project the baked texture back
 * into screen space (because V1 LightingEffect didn't know scene bounds).
 * V2 LightingEffectV2 receives the bake RT directly and uses `uSceneBounds`
 * to remap screen UV → scene UV inline in the compose shader.
 * No display mesh, no screen-space shadowTarget RT needed.
 *
 * ## Integration
 * - Subscribes to `OutdoorsMaskProviderV2` for per-floor canvases.
 * - `onFloorChange(maxFloorIndex)` triggers union rebuild + rebake.
 * - `setSunAngles(azimuthDeg, elevationDeg)` receives sun state from
 *   `SkyColorEffectV2` (single source of truth for sun direction).
 * - `get shadowFactorTexture()` exposes the bake RT texture for
 *   `LightingEffectV2.render()`.
 *
 * @module compositor-v2/effects/BuildingShadowsEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';
import { getFoundryTimePhaseHours } from '../../core/foundry-time-phases.js';

const log = createLogger('BuildingShadowsEffectV2');

// Resolution of the union mask canvas and the bake RT.
// 1024 is sufficient — shadow shapes are large-scale; blurry penumbra hides aliasing.
const BAKE_SIZE = 1024;

// ─── BuildingShadowsEffectV2 ─────────────────────────────────────────────────

export class BuildingShadowsEffectV2 {
  constructor() {
    /** @type {boolean} Whether initialize() has been called */
    this._initialized = false;

    /**
     * Reference to OutdoorsMaskProviderV2. Set by setOutdoorsMaskProvider().
     * @type {import('./OutdoorsMaskProviderV2.js').OutdoorsMaskProviderV2|null}
     */
    this._outdoorsMaskProvider = null;

    // ── Union mask ──────────────────────────────────────────────────────
    /** @type {HTMLCanvasElement|null} CPU union canvas */
    this._unionCanvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this._unionCtx = null;
    /** @type {THREE.CanvasTexture|null} */
    this._unionTexture = null;

    /** @type {HTMLCanvasElement|null} CPU receiver (active floor) canvas */
    this._receiverCanvas = null;
    /** @type {CanvasRenderingContext2D|null} */
    this._receiverCtx = null;
    /** @type {THREE.CanvasTexture|null} */
    this._receiverTexture = null;

    // ── Bake pass ───────────────────────────────────────────────────────
    /** @type {THREE.WebGLRenderTarget|null} Fixed-res shadow factor RT */
    this._bakeRT = null;
    /** @type {THREE.ShaderMaterial|null} UV-space raymarcher */
    this._bakeMaterial = null;
    /** @type {THREE.Scene|null} */
    this._bakeScene = null;
    /** @type {THREE.OrthographicCamera|null} Covers 0..1 in X and Y */
    this._bakeCamera = null;
    /** @type {THREE.Mesh|null} Fullscreen quad for bake */
    this._bakeQuad = null;

    // ── State tracking ──────────────────────────────────────────────────
    /** @type {boolean} Whether a bake is needed this frame */
    this._needsBake = true;
    /** @type {string} Hash of last bake inputs to detect changes */
    this._lastBakeHash = '';
    /** @type {number} Active max floor index */
    this._maxFloorIndex = 0;

    /** @type {number} Incremented whenever the union canvas is rebuilt */
    this._unionRevision = 0;

    // ── Sun direction ───────────────────────────────────────────────────
    /** @type {number} Sun azimuth in degrees (from SkyColorEffectV2) */
    this._sunAzimuthDeg = 180;
    /** @type {number} Sun elevation in degrees (from SkyColorEffectV2) */
    this._sunElevationDeg = 45;
    /** @type {THREE.Vector2|null} Derived UV-space sun direction */
    this._sunDir = null;
    /** @type {number} Time intensity scalar [0..1] (0 = night, 1 = peak shadow hour) */
    this._timeIntensity = 1.0;

    this.params = {
      enabled: true,
      opacity: 0.75,
      length: 0.06,
      quality: 80,
      sunLatitude: 0.5,
      blurStrength: 0.3,
      floorHeightShadowScale: 0.5,
      sunriseTime: 8.0,
      sunsetTime: 18.0,
      // Derived penumbra params (computed from blurStrength in update())
      penumbraRadiusNear: 0.0,
      penumbraRadiusFar: 0.06,
      penumbraSamples: 3,
      penumbraExponent: 1.0,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Initialize GPU resources.
   * @param {THREE.WebGLRenderer} renderer
   */
  initialize(renderer) {
    const THREE = window.THREE;
    if (!THREE || !renderer) return;

    this._renderer = renderer;
    this._sunDir = new THREE.Vector2(0, -1);

    // ── CPU canvases (updated on floor change) ─────────────────────────
    this._unionCanvas = document.createElement('canvas');
    this._unionCanvas.width  = BAKE_SIZE;
    this._unionCanvas.height = BAKE_SIZE;
    this._unionCtx = this._unionCanvas.getContext('2d');

    // Initialise union canvas to all-black (= no outdoor floor masks yet).
    if (this._unionCtx) {
      this._unionCtx.fillStyle = '#000';
      this._unionCtx.fillRect(0, 0, BAKE_SIZE, BAKE_SIZE);
    }

    this._unionTexture = new THREE.CanvasTexture(this._unionCanvas);
    this._unionTexture.flipY = false;
    this._unionTexture.minFilter = THREE.LinearFilter;
    this._unionTexture.magFilter = THREE.LinearFilter;
    this._unionTexture.generateMipmaps = false;

    // Receiver canvas (active floor only): gates where shadows are allowed to appear.
    this._receiverCanvas = document.createElement('canvas');
    this._receiverCanvas.width  = BAKE_SIZE;
    this._receiverCanvas.height = BAKE_SIZE;
    this._receiverCtx = this._receiverCanvas.getContext('2d');

    this._receiverTexture = new THREE.CanvasTexture(this._receiverCanvas);
    this._receiverTexture.flipY = false;
    this._receiverTexture.minFilter = THREE.LinearFilter;
    this._receiverTexture.magFilter = THREE.LinearFilter;
    this._receiverTexture.generateMipmaps = false;

    // ── Bake RT ────────────────────────────────────────────────────────
    this._bakeRT = new THREE.WebGLRenderTarget(BAKE_SIZE, BAKE_SIZE, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
    });
    // Clear to white (= fully lit) so the shadow is invisible before first bake.
    renderer.setRenderTarget(this._bakeRT);
    renderer.setClearColor(0xffffff, 1);
    renderer.clear();
    renderer.setRenderTarget(null);

    // ── Bake material (UV-space raymarcher) ────────────────────────────
    // Verbatim from V1 BuildingShadowsEffect.bakeMaterial, extended with
    // uFloorCount / uFloorHeightShadowScale for multi-floor shadow length scaling.
    this._bakeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        // Occluder mask: multi-floor union (black=indoor/building, white=outdoor)
        tOccluderOutdoors: { value: this._unionTexture },
        // Receiver mask: active floor outdoors (black=indoor, white=outdoor)
        tReceiverOutdoors: { value: this._receiverTexture },
        uSunDir: { value: this._sunDir },
        uLength: { value: this.params.length },
        uSampleCount: { value: this.params.quality },
        uPenumbraRadiusNear:  { value: 0.0 },
        uPenumbraRadiusFar:   { value: 0.06 },
        uPenumbraSamples:     { value: 3 },
        uPenumbraExponent:    { value: 1.0 },
        // Multi-floor shadow length scaling.
        uFloorCount:              { value: 1.0 },
        uFloorHeightShadowScale:  { value: 0.5 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tOccluderOutdoors;
        uniform sampler2D tReceiverOutdoors;
        uniform float uLength;
        uniform float uSampleCount;
        uniform vec2 uSunDir;
        uniform float uPenumbraRadiusNear;
        uniform float uPenumbraRadiusFar;
        uniform float uPenumbraSamples;
        uniform float uPenumbraExponent;
        uniform float uFloorCount;
        uniform float uFloorHeightShadowScale;

        varying vec2 vUv;

        bool inBounds(vec2 uv) {
          return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
        }

        void main() {
          // ── Bug fix: shadows only fall on outdoor pixels ──────────────
          // If the current pixel is already indoors (black in the mask), do NOT
          // apply a building shadow here. Indoor darkness is handled by the
          // ambient/darkness system, not building shadows. Without this check,
          // indoor areas were being double-darkened.
          vec3 selfColor = texture2D(tReceiverOutdoors, vUv).rgb;
          float selfOutdoors = dot(selfColor, vec3(0.2126, 0.7152, 0.0722));
          if (selfOutdoors < 0.5) {
            // Pixel is indoors — return fully lit (no shadow applied).
            gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
            return;
          }

          // Multi-floor shadow length: each additional floor adds uFloorHeightShadowScale
          // fraction of the base length, simulating a taller structure.
          float heightScale = 1.0 + max(uFloorCount - 1.0, 0.0) * uFloorHeightShadowScale;
          float effectiveLength = uLength * heightScale;

          vec2 dir = normalize(uSunDir);
          float samples = max(uSampleCount, 1.0);

          // Perpendicular direction for penumbra spread.
          vec2 perp = normalize(vec2(-dir.y, dir.x));
          float penumbraCount = max(uPenumbraSamples, 1.0);

          float totalOcclusion = 0.0;
          float totalWeight = 0.0;

          // MAX_STEPS must be a compile-time constant for GLSL loop unrolling.
          // Actual sample count is clamped by the 'samples' uniform at runtime.
          const int MAX_STEPS = 128;
          for (int i = 0; i < MAX_STEPS; i++) {
            float fi = float(i);
            if (fi >= samples) continue;

            float t = (samples > 1.0) ? (fi / (samples - 1.0)) : 0.0;
            vec2 baseUv = vUv + dir * (t * effectiveLength);

            if (!inBounds(baseUv)) continue;

            float rLerp = pow(t, uPenumbraExponent);
            float radius = mix(uPenumbraRadiusNear, uPenumbraRadiusFar, rLerp);

            float occlusion = 0.0;
            float weightSum = 0.0;

            const int MAX_PENUMBRA = 16;
            int taps = int(clamp(penumbraCount, 1.0, float(MAX_PENUMBRA)));

            if (taps <= 1 || radius <= 1e-5) {
              // Single centre sample — fast path.
              vec3 col = texture2D(tOccluderOutdoors, baseUv).rgb;
              float outdoors = dot(col, vec3(0.2126, 0.7152, 0.0722));
              float occ = 1.0 - step(0.5, outdoors); // 1 when indoor/building
              weightSum  = 1.0;
            } else {
              // Penumbra: spread taps perpendicular to shadow direction.
              for (int j = 0; j < MAX_PENUMBRA; j++) {
                if (j >= taps) continue;
                float fj = float(j);
                float halfCount = (float(taps) - 1.0) * 0.5;
                float offsetIndex = fj - halfCount;
                float norm = (halfCount > 0.0) ? (offsetIndex / halfCount) : 0.0;
                float w = 1.0 - abs(norm);

                vec2 sampleUv = baseUv + perp * (norm * radius);
                float outdoors = 1.0;
                if (inBounds(sampleUv)) {
                  vec3 sampleColor = texture2D(tOccluderOutdoors, sampleUv).rgb;
                  outdoors = dot(sampleColor, vec3(0.2126, 0.7152, 0.0722));
                }
                float indoor = (outdoors < 0.5) ? 1.0 : 0.0;
                occlusion += indoor * w;
                weightSum += w;
              }
            }

            if (weightSum > 0.0) occlusion /= weightSum;

            float distanceWeight = pow(t, max(0.001, uPenumbraExponent));
            totalOcclusion += occlusion * distanceWeight;
            totalWeight    += distanceWeight;
          }

          float avgOcclusion = (totalWeight > 0.0)
            ? clamp(totalOcclusion / totalWeight, 0.0, 1.0)
            : 0.0;

          // Output shadow factor: 1.0 = lit, 0.0 = shadowed.
          // Opacity is applied by LightingEffectV2, not here.
          float shadowFactor = 1.0 - avgOcclusion;
          gl_FragColor = vec4(shadowFactor, shadowFactor, shadowFactor, 1.0);
        }
      `,
      transparent: false,
    });

    // Bind the union texture to the bake material once — updates are driven by
    // _unionTexture.needsUpdate = true after _rebuildUnionMask().
    this._bakeMaterial.uniforms.tOccluderOutdoors.value = this._unionTexture;
    this._bakeMaterial.uniforms.tReceiverOutdoors.value = this._receiverTexture;

    // ── Bake scene (orthographic, covers UV 0..1) ──────────────────────
    // left=0, right=1, top=1, bottom=0, near=0, far=1
    this._bakeScene  = new THREE.Scene();
    this._bakeCamera = new THREE.OrthographicCamera(0, 1, 1, 0, 0, 1);
    this._bakeQuad   = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      this._bakeMaterial
    );
    // PlaneGeometry is centred at 0; shift to 0.5 so it spans 0..1.
    this._bakeQuad.position.set(0.5, 0.5, 0);
    this._bakeScene.add(this._bakeQuad);

    this._initialized = true;
    log.info(`BuildingShadowsEffectV2 initialized (bake size: ${BAKE_SIZE}×${BAKE_SIZE})`);
  }

  // ── Inputs ────────────────────────────────────────────────────────────

  /**
   * Register the OutdoorsMaskProviderV2 so this effect can read per-floor canvases.
   * Call once from FloorCompositor.initialize() after the provider is created.
   * @param {import('./OutdoorsMaskProviderV2.js').OutdoorsMaskProviderV2} provider
   */
  setOutdoorsMaskProvider(provider) {
    this._outdoorsMaskProvider = provider;
    // Subscribe so we rebuild the union when the provider re-populates
    // (e.g. on scene reload). Fires immediately with the current state.
    provider.subscribe(() => {
      let idx = this._maxFloorIndex;
      try {
        // Prefer provider's active floor index (authoritative for which outdoors
        // mask is currently selected).
        const pIdx = Number(provider?.activeFloorIndex);
        if (Number.isFinite(pIdx)) idx = pIdx;
      } catch (_) {}
      this._maxFloorIndex = idx;
      this._rebuildMasks(idx);
      this._needsBake = true;
    });
  }

  /**
   * Receive sun angles from SkyColorEffectV2 — the single source of truth for
   * sun direction across all V2 effects.
   *
   * Azimuth: degrees clockwise from north (0 = north, 90 = east, 180 = south, 270 = west).
   * Elevation: degrees above horizon (0 = horizon, 90 = zenith).
   *
   * @param {number} azimuthDeg
   * @param {number} elevationDeg
   */
  setSunAngles(azimuthDeg, elevationDeg) {
    if (this._sunAzimuthDeg === azimuthDeg && this._sunElevationDeg === elevationDeg) return;
    this._sunAzimuthDeg   = azimuthDeg;
    this._sunElevationDeg = elevationDeg;
    // Sun direction will be recomputed in update().
  }

  /**
   * Notify the effect that the active floor has changed.
   * Triggers a union mask rebuild (which forces a rebake).
   * @param {number} maxFloorIndex
   */
  onFloorChange(maxFloorIndex) {
    // Do NOT early-return on same index — the provider may have re-populated
    // (e.g. scene reload on floor 0) and the union mask needs rebuilding.
    let safeMax = Number.isFinite(maxFloorIndex) ? maxFloorIndex : 0;
    // Defensive fallback: if the caller can't provide a finite floor index,
    // but the outdoors provider has authored upper-floor masks, prefer the
    // highest available floor so the effect doesn't appear stuck on floor 0.
    try {
      const prov = this._outdoorsMaskProvider;
      if (prov && typeof prov.getAvailableFloorIndices === 'function') {
        const avail = prov.getAvailableFloorIndices();
        if (avail.length > 0) {
          const highest = avail[avail.length - 1];
          if (!Number.isFinite(maxFloorIndex)) {
            safeMax = highest;
          }
        }
      }
    } catch (_) {}

    this._maxFloorIndex = safeMax;
    this._rebuildMasks(safeMax);
    this._needsBake = true;
  }

  // ── Output ────────────────────────────────────────────────────────────

  /**
   * The bake RT's texture: greyscale shadow factor (1.0=lit, 0.0=shadowed).
   * Null if initialize() hasn't been called yet.
   * Fed directly into LightingEffectV2's compose shader via tBuildingShadow.
   * @type {THREE.Texture|null}
   */
  get shadowFactorTexture() {
    return this._bakeRT?.texture ?? null;
  }

  // ── Per-frame update ──────────────────────────────────────────────────

  /**
   * Compute sun direction, time intensity, penumbra, and decide if a rebake
   * is needed. Call once per frame from FloorCompositor.render().
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized || !this.params.enabled) return;

    const THREE = window.THREE;
    if (!THREE) return;

    // ── Sun direction from azimuth / elevation ─────────────────────────
    // Match V1 BuildingShadowsEffect sun direction convention exactly:
    //   x = -sin(azimuth),  y = -cos(azimuth) * sunLatitude
    // V1 drives azimuth from a time-of-day sweep; we receive it already
    // converted from SkyColorEffectV2. Convert from degrees to the V1 azimuth
    // (which is a half-orbit sweep: noon=0, sunrise=−π/2, sunset=+π/2).
    // SkyColorEffectV2 exposes azimuthDeg as 0=east, 90=south convention.
    // We use the same simplified formula as V1 for consistency.
    let hour = 12.0;
    try {
      if (weatherController && typeof weatherController.timeOfDay === 'number') {
        hour = weatherController.timeOfDay;
      }
    } catch (_) {}

    const isFoundryLinked = window.MapShine?.controlPanel?.controlState?.linkTimeToFoundry === true;
    const phaseHours = isFoundryLinked ? getFoundryTimePhaseHours() : null;
    const sunrise = Number.isFinite(phaseHours?.sunrise)
      ? phaseHours.sunrise
      : Math.max(0.0, Math.min(24.0, this.params.sunriseTime ?? 6.0));
    const sunset = Number.isFinite(phaseHours?.sunset)
      ? phaseHours.sunset
      : Math.max(0.0, Math.min(24.0, this.params.sunsetTime ?? 18.0));

    const t = (hour % 24.0) / 24.0;
    const azimuth = (t - 0.5) * Math.PI;
    const lat = Math.max(0.0, Math.min(1.0, this.params.sunLatitude ?? 0.5));
    const sunX = -Math.sin(azimuth);
    const sunY = -Math.cos(azimuth) * lat;

    if (this._sunDir) this._sunDir.set(sunX, sunY);

    // ── Time intensity ─────────────────────────────────────────────────
    const safeHour  = ((hour % 24.0) + 24.0) % 24.0;
    const dayLength = ((sunset - sunrise) + 24.0) % 24.0;
    let timeIntensity = 0.0;

    if (dayLength > 0.01) {
      const phase = ((safeHour - sunrise) + 24.0) % 24.0;
      if (phase >= 0.0 && phase <= dayLength) {
        const u = phase / dayLength;
        const edge = Math.abs(2.0 * u - 1.0);
        timeIntensity = Math.pow(edge, 0.5);
      } else {
        const fadeHours = 1.5;
        const preDawnDelta = ((sunrise - safeHour) + 24.0) % 24.0;
        if (preDawnDelta > 0.0 && preDawnDelta < fadeHours) {
          timeIntensity = Math.pow(1.0 - (preDawnDelta / fadeHours), 0.5);
        }
        const postDuskDelta = ((safeHour - sunset) + 24.0) % 24.0;
        if (postDuskDelta > 0.0 && postDuskDelta < fadeHours) {
          const tail = Math.pow(1.0 - (postDuskDelta / fadeHours), 0.5);
          timeIntensity = Math.max(timeIntensity, tail);
        }
      }
    } else {
      timeIntensity = 1.0;
    }
    this._timeIntensity = timeIntensity;

    // ── Penumbra params from blurStrength ──────────────────────────────
    const blur = Math.max(0.0, Math.min(1.0, this.params.blurStrength ?? 0.3));
    this.params.penumbraRadiusNear = 0.0;
    this.params.penumbraRadiusFar  = 0.02 + blur * 0.18;
    this.params.penumbraSamples    = Math.max(1, Math.min(9, Math.round(1 + blur * 8)));
    this.params.penumbraExponent   = 0.5 + blur * 2.0;

    // ── Check if bake is needed ────────────────────────────────────────
    const timeScale = 0.5 + 0.5 * THREE.MathUtils.clamp(timeIntensity, 0.0, 1.0);
    const effectiveLength = this.params.length * timeScale;

    const bakeState = {
      sunX: sunX.toFixed(4),
      sunY: sunY.toFixed(4),
      length: effectiveLength.toFixed(5),
      quality: this.params.quality,
      pNear:   this.params.penumbraRadiusNear,
      pFar:    this.params.penumbraRadiusFar.toFixed(4),
      pSamples: this.params.penumbraSamples,
      pExp:    this.params.penumbraExponent.toFixed(3),
      floors:  this._maxFloorIndex,
      hScale:  this.params.floorHeightShadowScale,
      // NOTE: uuid does not change when the canvas content changes.
      // Use an explicit revision counter so floor changes always invalidate.
      unionRev: this._unionRevision,
      maskSet: this._unionTexture?.uuid ?? 'none',
    };
    const hash = JSON.stringify(bakeState);
    if (hash !== this._lastBakeHash) {
      this._needsBake = true;
      this._lastBakeHash = hash;
    }

    // ── Push uniforms when a bake is scheduled ─────────────────────────
    if (this._needsBake && this._bakeMaterial) {
      const u = this._bakeMaterial.uniforms;
      u.uLength.value             = effectiveLength;
      u.uSampleCount.value        = this.params.quality;
      u.uSunDir.value.copy(this._sunDir);
      u.uPenumbraRadiusNear.value = this.params.penumbraRadiusNear;
      u.uPenumbraRadiusFar.value  = this.params.penumbraRadiusFar;
      u.uPenumbraSamples.value    = this.params.penumbraSamples;
      u.uPenumbraExponent.value   = this.params.penumbraExponent;
      u.uFloorCount.value         = this._maxFloorIndex + 1;
      u.uFloorHeightShadowScale.value = this.params.floorHeightShadowScale;
    }
  }

  // ── Render ────────────────────────────────────────────────────────────

  /**
   * Execute the bake pass if needed. Call once per frame after update().
   * @param {THREE.WebGLRenderer} renderer
   */
  render(renderer) {
    if (!this._initialized || !this.params.enabled) return;
    if (!this._needsBake) return;
    if (!this._bakeScene || !this._bakeCamera || !this._bakeRT) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    renderer.setRenderTarget(this._bakeRT);
    renderer.setClearColor(0xffffff, 1); // Default: fully lit
    renderer.autoClear = true;
    renderer.render(this._bakeScene, this._bakeCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    this._needsBake = false;
    log.info(`BuildingShadowsEffectV2: baked shadow map (floors≤${this._maxFloorIndex}, unionRev=${this._unionRevision})`);
  }

  // ── Private ───────────────────────────────────────────────────────────

  /**
   * Union-composite all _Outdoors floor canvases up to and including maxFloorIndex.
   * Uses Canvas 2D `lighten` compositing (max per channel) so the union of
   * all floor masks produces a single mask covering all structures.
   *
   * Runs only on floor change — not every frame.
   *
   * @param {number} maxFloorIndex
   * @private
   */
  _rebuildUnionMask(maxFloorIndex) {
    // Deprecated: kept for compatibility with any external call sites.
    this._rebuildMasks(maxFloorIndex);
  }

  /**
   * Rebuild both:
   * - occluder union mask (floors <= active)
   * - receiver mask (active floor only)
   *
   * This mirrors how Water/Specular distinguish "current floor application"
   * from multi-floor occlusion.
   *
   * @param {number} activeFloorIndex
   * @private
   */
  _rebuildMasks(activeFloorIndex) {
    if (!this._unionCtx || !this._unionCanvas) return;
    if (!this._receiverCtx || !this._receiverCanvas) return;

    const ctx = this._unionCtx;
    const w = BAKE_SIZE;
    const h = BAKE_SIZE;

    // Fill with black (= all indoor, no shadow casters). Floor masks paint white.
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // Union all floors ≤ activeFloorIndex via 'lighten' (= per-channel max).
    // Iterate only floors that actually have authored canvases to avoid silent
    // no-ops when floors are sparse and to avoid Infinity loops.
    const usedFloors = [];
    if (this._outdoorsMaskProvider) {
      const available = (typeof this._outdoorsMaskProvider.getAvailableFloorIndices === 'function')
        ? this._outdoorsMaskProvider.getAvailableFloorIndices()
        : [];
      for (const fi of available) {
        if (!Number.isFinite(fi)) continue;
        if (fi > activeFloorIndex) continue;
        const cv = this._outdoorsMaskProvider.getFloorCanvas(fi);
        if (!cv) continue;
        try {
          ctx.globalCompositeOperation = 'lighten';
          ctx.drawImage(cv, 0, 0, w, h);
          usedFloors.push(fi);
        } catch (err) {
          log.warn(`BuildingShadowsEffectV2: failed to draw floor ${fi} canvas:`, err);
        }
      }
    }

    // Reset composite operation.
    ctx.globalCompositeOperation = 'source-over';

    // Receiver mask: active floor only.
    const rctx = this._receiverCtx;
    rctx.globalCompositeOperation = 'source-over';
    rctx.fillStyle = '#000';
    rctx.fillRect(0, 0, w, h);
    let receiverFloor = null;
    try {
      const cv = this._outdoorsMaskProvider?.getFloorCanvas?.(activeFloorIndex) ?? null;
      if (cv) {
        rctx.drawImage(cv, 0, 0, w, h);
        receiverFloor = activeFloorIndex;
      } else {
        // Fallback: best-available lower floor.
        const avail = this._outdoorsMaskProvider?.getAvailableFloorIndices?.() ?? [];
        const best = avail.filter(n => Number.isFinite(n) && n <= activeFloorIndex).pop();
        if (Number.isFinite(best)) {
          const cv2 = this._outdoorsMaskProvider?.getFloorCanvas?.(best) ?? null;
          if (cv2) {
            rctx.drawImage(cv2, 0, 0, w, h);
            receiverFloor = best;
          }
        }
      }
    } catch (_) {}

    // Notify GPU that the canvas content has changed.
    if (this._unionTexture) {
      this._unionTexture.needsUpdate = true;
    }
    if (this._receiverTexture) {
      this._receiverTexture.needsUpdate = true;
    }

    // Bump revision so update()'s bake hash always invalidates after a rebuild.
    this._unionRevision++;
    log.info(`BuildingShadowsEffectV2: rebuilt masks (receiver=${receiverFloor ?? 'none'}, occluders≤${activeFloorIndex} using [${usedFloors.join(', ')}], unionRev=${this._unionRevision})`);
  }

  // ── Disposal ──────────────────────────────────────────────────────────

  dispose() {
    if (this._bakeRT) {
      this._bakeRT.dispose();
      this._bakeRT = null;
    }
    if (this._bakeMaterial) {
      this._bakeMaterial.dispose();
      this._bakeMaterial = null;
    }
    if (this._bakeQuad) {
      this._bakeQuad.geometry.dispose();
      this._bakeQuad = null;
    }
    if (this._unionTexture) {
      this._unionTexture.dispose();
      this._unionTexture = null;
    }
    this._unionCanvas = null;
    this._unionCtx = null;
    this._bakeScene = null;
    this._bakeCamera = null;
    this._outdoorsMaskProvider = null;
    this._initialized = false;
    log.info('BuildingShadowsEffectV2 disposed');
  }
}
