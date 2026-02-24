/**
 * @fileoverview CloudEffectV2 — V2 procedural cloud system.
 *
 * Outputs:
 *   - _shadowRT  : Shadow factor (1.0=lit, 0.0=shadowed). Fed into LightingEffectV2
 *                  as a multiplier so cloud shadow darkens scene illumination.
 *   - _cloudTopRT: RGBA cloud-top overlay, blitted after lighting, before sky-color.
 *
 * ## Multi-Floor Shadow Occlusion
 *
 * Cloud density is world-space and global (one procedural pass for the whole scene).
 * Shadows must be occluded by overhead tiles on the current floor so rooftops block
 * the shadow from reaching interior spaces below.
 *
 * Strategy:
 *   1. Before compositing shadows, render a blocker mask by traversing the
 *      FloorRenderBus scene for sprites with userData.isOverhead or
 *      userData.cloudShadowBlocker.  The bus already hides floors that aren't
 *      currently visible, so floor isolation is automatic.
 *   2. Shadow shader: shadowFactor = mix(shadowFactor, 1.0, blockerMask.a)
 *      — blocked pixels remain bright (unshadowed).
 *   3. Outdoors mask further gates shadow so interiors never receive it.
 *
 * ## Pipeline position in FloorCompositor
 *
 *   Bus → sceneRT
 *     → Lighting(cloudShadowRT) → postA
 *     → CloudTops blit (alpha-over) → postA
 *     → SkyColor → ColorCorrection → Water → Bloom → …
 *
 * @module compositor-v2/effects/CloudEffectV2
 */

import { createLogger } from '../../core/log.js';
import { weatherController } from '../../core/WeatherController.js';

const log = createLogger('CloudEffectV2');

// ─────────────────────────────────────────────────────────────────────────────

export class CloudEffectV2 {
  constructor() {
    /** @type {boolean} */
    this.enabled = true;
    /** @type {boolean} */
    this._initialized = false;

    // ── Params (mirrors V1 CloudEffect defaults) ─────────────────────
    this.params = {
      enabled: true,
      internalResolutionScale: 0.5,

      // Generation
      cloudCover: 0.5,
      noiseScale: 0.5,
      noiseDetail: 4,
      cloudSharpness: 0.0,
      noiseTimeSpeed: 0.011,
      cloudBrightness: 1.01,
      cloudTopSoftKnee: 1.8,

      // Domain warp
      domainWarpEnabled: true,
      domainWarpStrength: 0.005,
      domainWarpScale: 1.05,
      domainWarpSpeed: 0.115,
      domainWarpTimeOffsetY: 10,

      // Cloud-top shading
      cloudTopShadingEnabled: true,
      cloudTopShadingStrength: 0.99,
      cloudTopNormalStrength: 0.96,
      cloudTopAOIntensity: 2.0,
      cloudTopEdgeHighlight: 0,
      cloudTopPeakDetailEnabled: false,
      cloudTopPeakDetailStrength: 0.32,
      cloudTopPeakDetailScale: 92.5,
      cloudTopPeakDetailSpeed: 0.08,
      cloudTopPeakDetailStart: 0.14,
      cloudTopPeakDetailEnd: 0.82,

      // Shadow
      shadowOpacity: 0.7,
      shadowSoftness: 0.9,
      shadowOffsetScale: 0.3,
      minShadowBrightness: 0.0,

      // Cloud tops
      cloudTopMode: 'aboveEverything',
      cloudTopOpacity: 1.0,
      cloudTopFadeStart: 0.24,
      cloudTopFadeEnd: 0.39,

      // Wind
      windInfluence: 1.33,
      driftSpeed: 0.01,
      minDriftSpeed: 0.002,
      driftResponsiveness: 0.4,
      driftMaxSpeed: 0.5,
      layerParallaxBase: 1.0,

      // 5 cloud layers
      layer1Enabled: true,  layer1Opacity: 0.35, layer1Coverage: 0.33, layer1Scale: 1.34, layer1ParallaxMult: 0, layer1SpeedMult: 0.99, layer1DirDeg: -1.7,
      layer2Enabled: true,  layer2Opacity: 0.70, layer2Coverage: 0.57, layer2Scale: 1.22, layer2ParallaxMult: 0, layer2SpeedMult: 1.07, layer2DirDeg: -0.86,
      layer3Enabled: true,  layer3Opacity: 0.19, layer3Coverage: 0.90, layer3Scale: 3.00, layer3ParallaxMult: 0, layer3SpeedMult: 0.94, layer3DirDeg: 0.0,
      layer4Enabled: true,  layer4Opacity: 0.17, layer4Coverage: 0.46, layer4Scale: 1.72, layer4ParallaxMult: 0, layer4SpeedMult: 0.94, layer4DirDeg: 0.86,
      layer5Enabled: true,  layer5Opacity: 0.13, layer5Coverage: 0.62, layer5Scale: 1.52, layer5ParallaxMult: 0, layer5SpeedMult: 1.07, layer5DirDeg: -0.6,
    };

    // ── Render targets ────────────────────────────────────────────────
    /** @type {THREE.WebGLRenderTarget|null} Overscanned density for shadow offset+blur */
    this._shadowDensityRT = null;
    /** @type {THREE.WebGLRenderTarget|null} Normal-bounds density (cloud tops + consumers) */
    this._densityRT       = null;
    /** @type {THREE.WebGLRenderTarget|null} Parallaxed multi-layer density for cloud tops */
    this._topDensityRT    = null;
    /** @type {THREE.WebGLRenderTarget|null} Final shadow factor (bound into LightingEffectV2) */
    this._shadowRT        = null;
    /** @type {THREE.WebGLRenderTarget|null} Shadow without outdoors mask (indoor consumers) */
    this._shadowRawRT     = null;
    /** @type {THREE.WebGLRenderTarget|null} RGBA cloud-top overlay */
    this._cloudTopRT      = null;
    /** @type {THREE.WebGLRenderTarget|null} Overhead-tile blocker mask for shadow occlusion */
    this._blockerRT       = null;

    // ── Materials ─────────────────────────────────────────────────────
    this._densityMat      = null;
    this._shadowMat       = null;
    this._cloudTopMat     = null;
    this._cloudTopBlitMat = null;

    // ── Scenes / cameras / quads ──────────────────────────────────────
    this._quadScene = null;
    this._quadCam   = null;
    /** @type {THREE.Mesh|null} Reused fullscreen quad; material swapped per pass */
    this._quad      = null;
    /** @type {THREE.Scene|null} Dedicated blit scene for cloud-top alpha-over pass */
    this._blitScene = null;
    this._blitCam   = null;
    this._blitQuad  = null;

    // ── External references (set by FloorCompositor) ──────────────────
    this._renderer    = null;
    /** @type {THREE.Scene|null} FloorRenderBus scene — used for blocker pass */
    this._busScene    = null;
    this._mainCamera  = null;
    /** @type {THREE.Texture|null} Outdoors mask from FloorCompositor */
    this._outdoorsMask = null;

    // ── Wind simulation ───────────────────────────────────────────────
    this._windOffset    = null;
    this._windVelocity  = null;
    this._layerWindOffsets     = null; // Array<THREE.Vector2> length 5
    this._layerWindVelocities  = null; // Array<THREE.Vector2> length 5
    /** @type {Float32Array|null} Flat [x0,y0, x1,y1, …] for uniform upload */
    this._layerWindOffsetsFlat = null;

    // Per-layer config typed arrays (mutated in-place; avoid GC allocs per frame)
    this._layerSpeedMult      = new Float32Array(5);
    this._layerDirAngle       = new Float32Array(5);
    this._layerParallax       = new Float32Array(5);
    this._layerCoverMult      = new Float32Array(5);
    this._layerNoiseScaleMult = new Float32Array(5);
    this._layerWeight         = new Float32Array(5);

    // ── Sun direction & time-of-day tint ─────────────────────────────
    this._sunDir      = null;
    this._shadeSunDir = null;
    this._tintNight   = null;
    this._tintSunrise = null;
    this._tintDay     = null;
    this._tintSunset  = null;
    this._tintResult  = null;

    // ── Temp / state ──────────────────────────────────────────────────
    this._tempVec2A = null;
    this._tempVec2B = null;
    this._tempSize  = null;
    this._lastElapsed         = 0;
    this._cloudTopDensityValid = false;
    this._needsNeutralClear   = false;
    this._cloudCoverZeroLF    = false; // zero-cover last frame
    this._cloudCoverEpsilon   = 0.0001;

    // ── Blocker pass: visibility override pool (avoid per-frame allocs) ──
    this._blockerOverrideObjs  = [];
    this._blockerOverrideVis   = [];
    this._blockerOverrideCount = 0;

    // ── RT size cache ─────────────────────────────────────────────────
    this._lastFullW     = 0;
    this._lastFullH     = 0;
    this._lastInternalW = 0;
    this._lastInternalH = 0;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Create GPU resources. Called by FloorCompositor after renderer is ready.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene}  busScene   FloorRenderBus scene (used in blocker pass)
   * @param {THREE.Camera} camera     Main perspective camera
   */
  initialize(renderer, busScene, camera) {
    const THREE = window.THREE;
    if (!THREE) { log.error('THREE not available'); return; }

    this._renderer   = renderer;
    this._busScene   = busScene;
    this._mainCamera = camera;

    // Wind state
    this._windOffset           = new THREE.Vector2(0, 0);
    this._windVelocity         = new THREE.Vector2(0, 0);
    this._layerWindOffsets     = Array.from({ length: 5 }, () => new THREE.Vector2());
    this._layerWindVelocities  = Array.from({ length: 5 }, () => new THREE.Vector2());
    this._layerWindOffsetsFlat = new Float32Array(10);

    // Temp helpers
    this._tempVec2A = new THREE.Vector2();
    this._tempVec2B = new THREE.Vector2();
    this._tempSize  = new THREE.Vector2();

    // Sun / tint
    this._sunDir      = new THREE.Vector2(0, 1);
    this._shadeSunDir = new THREE.Vector2(0, 1);
    this._tintNight   = new THREE.Vector3(0.13, 0.15, 0.20);
    this._tintSunrise = new THREE.Vector3(1.00, 0.70, 0.50);
    this._tintDay     = new THREE.Vector3(1.00, 1.00, 1.00);
    this._tintSunset  = new THREE.Vector3(1.00, 0.60, 0.40);
    this._tintResult  = new THREE.Vector3(1.00, 1.00, 1.00);

    // Fullscreen quad for internal passes
    this._quadScene = new THREE.Scene();
    this._quadCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad      = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);

    // Cloud-top blit scene (NormalBlending alpha-over onto the post RT)
    this._cloudTopBlitMat = new THREE.ShaderMaterial({
      uniforms: { tCloudTop: { value: null } },
      vertexShader:   /* glsl */`varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }`,
      fragmentShader: /* glsl */`uniform sampler2D tCloudTop; varying vec2 vUv; void main(){ gl_FragColor=texture2D(tCloudTop,vUv); }`,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.NormalBlending,
    });
    this._cloudTopBlitMat.toneMapped = false;
    this._blitScene = new THREE.Scene();
    this._blitCam   = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._blitQuad  = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._cloudTopBlitMat);
    this._blitQuad.frustumCulled = false;
    this._blitScene.add(this._blitQuad);

    this._createDensityMaterial();
    this._createShadowMaterial();
    this._createCloudTopMaterial();

    this._initialized = true;
    log.info('CloudEffectV2 initialized');
  }

  /** Supply the outdoors mask texture. Called by FloorCompositor after populate(). */
  setOutdoorsMask(texture) { this._outdoorsMask = texture ?? null; }

  // ── Wind advance ──────────────────────────────────────────────────────────

  /**
   * Advance wind simulation by one frame delta. Called from FloorCompositor
   * BEFORE update() so accumulation happens exactly once per frame.
   * @param {number} delta Seconds
   */
  advanceWind(delta) {
    if (!this._initialized || !this.params.enabled) return;
    const ws = this._getWeatherState();
    if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover)) return;
    this._advanceWindSim(delta, ws.windDirX, ws.windDirY, ws.windSpeed);
  }

  /** @private */
  _advanceWindSim(delta, windDirX, windDirY, windSpeed) {
    const p = this.params;
    const targetSpd = Math.max(windSpeed * p.windInfluence * p.driftSpeed, p.minDriftSpeed || 0);
    const resp   = Math.max(0, p.driftResponsiveness ?? 2.5);
    const maxSpd = Math.max(0, p.driftMaxSpeed ?? 0.05);
    const alpha  = resp > 0 ? (1 - Math.exp(-resp * delta)) : 1;
    const toRad  = Math.PI / 180;

    // Global base offset
    this._tempVec2A.set(windDirX, windDirY);
    if (this._tempVec2A.lengthSq() > 1e-6) this._tempVec2A.normalize();
    this._tempVec2A.multiplyScalar(targetSpd);
    this._windVelocity.lerp(this._tempVec2A, alpha);
    const vl = this._windVelocity.length();
    if (vl > maxSpd && vl > 1e-6) this._windVelocity.multiplyScalar(maxSpd / vl);
    this._windOffset.x -= this._windVelocity.x * delta;
    this._windOffset.y -= this._windVelocity.y * delta;
    if (!Number.isFinite(this._windOffset.x)) this._windOffset.x = 0;
    if (!Number.isFinite(this._windOffset.y)) this._windOffset.y = 0;

    // Per-layer offsets with individual speed/direction offsets
    const baseParallax = Math.max(0, Math.min(1, p.layerParallaxBase ?? 1));
    for (let i = 0; i < 5; i++) {
      const n = i + 1;
      this._layerSpeedMult[i]      = p[`layer${n}SpeedMult`]     ?? 1;
      this._layerDirAngle[i]       = (p[`layer${n}DirDeg`]       ?? 0) * toRad;
      this._layerParallax[i]       = Math.max(0, Math.min(1, baseParallax * (p[`layer${n}ParallaxMult`] ?? 1)));
      this._layerNoiseScaleMult[i] = p[`layer${n}Scale`]          ?? 1;
      this._layerCoverMult[i]      = p[`layer${n}Coverage`]       ?? 0.5;
      this._layerWeight[i]         = p[`layer${n}Enabled`] ? (p[`layer${n}Opacity`] ?? 0) : 0;
    }

    this._tempVec2A.set(windDirX, windDirY);
    if (this._tempVec2A.lengthSq() > 1e-6) this._tempVec2A.normalize();

    for (let i = 0; i < 5; i++) {
      const a  = this._layerDirAngle[i];
      const ca = Math.cos(a); const sa = Math.sin(a);
      const sm = this._layerSpeedMult[i];
      this._tempVec2B.set(
        this._tempVec2A.x * ca - this._tempVec2A.y * sa,
        this._tempVec2A.x * sa + this._tempVec2A.y * ca
      ).multiplyScalar(targetSpd * sm);
      const v = this._layerWindVelocities[i];
      v.lerp(this._tempVec2B, alpha);
      const vml = maxSpd * sm; const vll = v.length();
      if (vll > vml && vll > 1e-6) v.multiplyScalar(vml / vll);
      const o = this._layerWindOffsets[i];
      o.x -= v.x * delta; o.y -= v.y * delta;
      if (!Number.isFinite(o.x)) o.x = 0;
      if (!Number.isFinite(o.y)) o.y = 0;
      this._layerWindOffsetsFlat[i * 2]     = o.x;
      this._layerWindOffsetsFlat[i * 2 + 1] = o.y;
    }
  }

  // ── Per-frame uniform update ───────────────────────────────────────────────

  /** @param {{ elapsed: number, delta: number }} timeInfo */
  update(timeInfo) {
    if (!this._initialized || !this.params.enabled) return;
    this._lastElapsed = timeInfo?.elapsed ?? 0;

    const ws = this._getWeatherState();
    if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover)) {
      if (!this._cloudCoverZeroLF) this._needsNeutralClear = true;
      this._cloudCoverZeroLF = true;
      if (this._densityMat?.uniforms?.uCloudCover) this._densityMat.uniforms.uCloudCover.value = 0;
      return;
    }
    this._cloudCoverZeroLF  = false;
    this._needsNeutralClear = false;

    this._calcSunDir();

    const sceneRect = canvas?.dimensions?.sceneRect;
    const sceneX = sceneRect?.x ?? 0;
    const sceneY = sceneRect?.y ?? 0;
    const sceneW = sceneRect?.width  ?? 4000;
    const sceneH = sceneRect?.height ?? 3000;

    const sc = window.MapShine?.sceneComposer;
    let vMinX = 0, vMinY = 0, vMaxX = sceneW, vMaxY = sceneH;
    if (sc && this._mainCamera) {
      const zoom = sc.currentZoom || 1;
      const vpW  = sc.baseViewportWidth  || window.innerWidth;
      const vpH  = sc.baseViewportHeight || window.innerHeight;
      const camX = this._mainCamera.position.x;
      const camY = this._mainCamera.position.y;
      vMinX = camX - vpW / zoom / 2; vMinY = camY - vpH / zoom / 2;
      vMaxX = camX + vpW / zoom / 2; vMaxY = camY + vpH / zoom / 2;
    }

    const p  = this.params;
    const du = this._densityMat?.uniforms;
    if (du) {
      du.uTime.value               = this._lastElapsed;
      du.uCloudCover.value         = ws.cloudCover;
      du.uNoiseScale.value         = p.noiseScale;
      du.uNoiseDetail.value        = p.noiseDetail;
      du.uCloudSharpness.value     = p.cloudSharpness;
      du.uNoiseTimeSpeed.value     = p.noiseTimeSpeed;
      du.uDomainWarpEnabled.value  = p.domainWarpEnabled  ? 1 : 0;
      du.uDomainWarpStrength.value = p.domainWarpStrength;
      du.uDomainWarpScale.value    = p.domainWarpScale;
      du.uDomainWarpSpeed.value    = p.domainWarpSpeed;
      du.uDomainWarpTimeOffsetY.value = p.domainWarpTimeOffsetY;
      du.uCompositeSoftKnee.value  = Number(p.cloudTopSoftKnee) || 0;
      du.uSceneOrigin.value.set(sceneX, sceneY);
      du.uSceneSize.value.set(sceneW, sceneH);
      du.uViewBoundsMin.value.set(vMinX, vMinY);
      du.uViewBoundsMax.value.set(vMaxX, vMaxY);
      // Flat typed arrays skip Three.js per-frame flatten overhead
      du.uLayerWindOffsets.value    = this._layerWindOffsetsFlat;
      du.uLayerParallax.value       = this._layerParallax;
      du.uLayerCoverMult.value      = this._layerCoverMult;
      du.uLayerNoiseScaleMult.value = this._layerNoiseScaleMult;
      du.uLayerWeight.value         = this._layerWeight;
    }

    const zoom = this._getZoom();
    const su   = this._shadowMat?.uniforms;
    if (su) {
      su.uShadowOpacity.value  = p.shadowOpacity;
      su.uShadowSoftness.value = p.shadowSoftness;
      su.uMinBrightness.value  = p.minShadowBrightness;
      su.uZoom.value           = zoom;
      su.uSceneOrigin.value.set(sceneX, sceneY);
      su.uSceneSize.value.set(sceneW, sceneH);
      su.uViewBoundsMin.value.set(vMinX, vMinY);
      su.uViewBoundsMax.value.set(vMaxX, vMaxY);

      // World-space shadow offset (sun-direction displacement)
      const offW = p.shadowOffsetScale * 5000;
      su.uShadowOffsetWorld.value.set(this._sunDir.x * offW, this._sunDir.y * offW);

      // Overscanned density bounds so blur kernel stays inside density texture
      const iW = this._densityRT?.width ?? 1024;
      const iH = this._densityRT?.height ?? 1024;
      const viewW = vMaxX - vMinX; const viewH = vMaxY - vMinY;
      const wpx = viewW / Math.max(1, iW); const wpy = viewH / Math.max(1, iH);
      const blurPx = (p.shadowSoftness ?? 0) * 20 * zoom;
      const absOX = Math.abs(su.uShadowOffsetWorld.value.x);
      const absOY = Math.abs(su.uShadowOffsetWorld.value.y);
      const mX = absOX + blurPx * wpx * 2 + wpx * 4;
      const mY = absOY + blurPx * wpy * 2 + wpy * 4;
      su.uDensityBoundsMin.value.set(vMinX - mX, vMinY - mY);
      su.uDensityBoundsMax.value.set(vMaxX + mX, vMaxY + mY);

      if (this._outdoorsMask) {
        su.tOutdoorsMask.value    = this._outdoorsMask;
        su.uHasOutdoorsMask.value = 1;
      } else {
        su.tOutdoorsMask.value    = null;
        su.uHasOutdoorsMask.value = 0;
      }
    }

    const tu = this._cloudTopMat?.uniforms;
    if (tu) {
      tu.uTime.value            = this._lastElapsed;
      tu.uCloudTopOpacity.value = p.cloudTopOpacity;
      tu.uFadeStart.value       = p.cloudTopFadeStart;
      tu.uFadeEnd.value         = p.cloudTopFadeEnd;
      tu.uCloudBrightness.value = p.cloudBrightness;
      tu.uShadingEnabled.value  = p.cloudTopShadingEnabled ? 1 : 0;
      tu.uShadingStrength.value = p.cloudTopShadingStrength;
      tu.uNormalStrength.value  = p.cloudTopNormalStrength;
      tu.uAOIntensity.value     = Number(p.cloudTopAOIntensity) || 0;
      tu.uEdgeHighlight.value   = p.cloudTopEdgeHighlight;
      tu.uPeakDetailEnabled.value  = p.cloudTopPeakDetailEnabled ? 1 : 0;
      tu.uPeakDetailStrength.value = p.cloudTopPeakDetailStrength;
      tu.uPeakDetailScale.value    = p.cloudTopPeakDetailScale;
      tu.uPeakDetailSpeed.value    = p.cloudTopPeakDetailSpeed;
      tu.uPeakDetailStart.value    = p.cloudTopPeakDetailStart;
      tu.uPeakDetailEnd.value      = p.cloudTopPeakDetailEnd;
      tu.uNormalizedZoom.value     = zoom;

      // Boost lateral sun magnitude for cloud-top shading visibility at midday
      this._shadeSunDir.copy(this._sunDir);
      const mag = this._shadeSunDir.length();
      if (mag < 0.6) {
        if (mag < 1e-5) this._shadeSunDir.set(0.6, 0);
        else this._shadeSunDir.multiplyScalar(0.6 / mag);
      }
      tu.uSunDir.value.copy(this._shadeSunDir);

      // Fade outdoors mask when zoomed out in aboveEverything mode
      if (p.cloudTopMode === 'aboveEverything') {
        const zf = 1 - this._smoothstep(p.cloudTopFadeStart, p.cloudTopFadeEnd, zoom);
        tu.uOutdoorsMaskStrength.value = 1 - zf;
      } else {
        tu.uOutdoorsMaskStrength.value = 1;
      }

      const tint = this._calcTimeOfDayTint();
      if (tint) tu.uTimeOfDayTint.value.copy(tint);

      if (this._outdoorsMask) {
        tu.tOutdoorsMask.value    = this._outdoorsMask;
        tu.uHasOutdoorsMask.value = 1;
      } else {
        tu.tOutdoorsMask.value    = null;
        tu.uHasOutdoorsMask.value = 0;
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  /**
   * Execute all cloud render passes.
   * After this returns:
   *   - `this.cloudShadowTexture` is the shadow factor texture (feed into LightingEffectV2)
   *   - `this.cloudTopTexture`    is the RGBA cloud-top texture (blit after lighting)
   *
   * @param {THREE.WebGLRenderer} renderer
   */
  render(renderer) {
    if (!this._initialized || !this.params.enabled) return;

    renderer.getDrawingBufferSize(this._tempSize);
    const fullW = Math.max(1, this._tempSize.x);
    const fullH = Math.max(1, this._tempSize.y);
    this._ensureRenderTargets(fullW, fullH);

    const prevTarget = renderer.getRenderTarget();

    try {
      const ws = this._getWeatherState();
      if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover) || this._needsNeutralClear) {
        this._renderNeutral(renderer);
        this._needsNeutralClear = false;
        return;
      }

      // ── Blocker pass: collect overhead tiles → blockerRT ────────────
      // Sprites currently visible in the bus scene that are overhead tiles
      // become the cloud-shadow blocker. Floor isolation is free because
      // FloorRenderBus already hides tiles on non-visible floors.
      this._renderBlockerMask(renderer);

      const du = this._densityMat.uniforms;
      const su = this._shadowMat.uniforms;

      // ── Pass 1a: Overscanned density for shadow offset+blur ──────────
      du.uClipToScene.value   = 0;
      du.uParallaxScale.value = 0;
      du.uCompositeMode.value = 0;

      // Temporarily widen view bounds to the pre-computed overscanned region
      const prevMinX = du.uViewBoundsMin.value.x;
      const prevMinY = du.uViewBoundsMin.value.y;
      const prevMaxX = du.uViewBoundsMax.value.x;
      const prevMaxY = du.uViewBoundsMax.value.y;
      if (su.uDensityBoundsMin) du.uViewBoundsMin.value.copy(su.uDensityBoundsMin.value);
      if (su.uDensityBoundsMax) du.uViewBoundsMax.value.copy(su.uDensityBoundsMax.value);

      this._quad.material = this._densityMat;
      renderer.setRenderTarget(this._shadowDensityRT);
      renderer.setClearColor(0x000000, 1); renderer.clear();
      renderer.render(this._quadScene, this._quadCam);

      // Restore normal view bounds for subsequent passes
      du.uViewBoundsMin.value.set(prevMinX, prevMinY);
      du.uViewBoundsMax.value.set(prevMaxX, prevMaxY);

      // ── Pass 1b: Normal-bounds density (cloud tops + other consumers) ─
      this._quad.material = this._densityMat;
      renderer.setRenderTarget(this._densityRT);
      renderer.setClearColor(0x000000, 1); renderer.clear();
      renderer.render(this._quadScene, this._quadCam);

      // ── Pass 2a: Raw shadow (no outdoors mask) — indoor consumers ────
      {
        const prevHasMask = su.uHasOutdoorsMask.value;
        const prevMaskTex = su.tOutdoorsMask.value;
        su.uDensityMode.value    = 0;
        su.uHasOutdoorsMask.value = 0;
        su.tOutdoorsMask.value   = null;
        su.tCloudDensity.value   = this._shadowDensityRT.texture;
        su.tBlockerMask.value    = this._blockerRT?.texture ?? null;
        su.uHasBlockerMask.value = this._blockerRT ? 1 : 0;
        this._quad.material = this._shadowMat;
        renderer.setRenderTarget(this._shadowRawRT);
        renderer.setClearColor(0xffffff, 1); renderer.clear();
        renderer.render(this._quadScene, this._quadCam);
        su.uHasOutdoorsMask.value = prevHasMask;
        su.tOutdoorsMask.value    = prevMaskTex;
      }

      // ── Pass 2b: Outdoors-masked shadow (fed into LightingEffectV2) ───
      su.uDensityMode.value    = 0;
      su.tCloudDensity.value   = this._shadowDensityRT.texture;
      su.tBlockerMask.value    = this._blockerRT?.texture ?? null;
      su.uHasBlockerMask.value = this._blockerRT ? 1 : 0;
      this._quad.material = this._shadowMat;
      renderer.setRenderTarget(this._shadowRT);
      renderer.setClearColor(0xffffff, 1); renderer.clear();
      renderer.render(this._quadScene, this._quadCam);

      // ── Pass 3: Parallaxed multi-layer density for cloud tops ─────────
      if (this._topDensityRT) {
        du.uClipToScene.value   = 1;
        du.uParallaxScale.value = 1;
        du.uCompositeMode.value = 1;
        this._quad.material = this._densityMat;
        renderer.setRenderTarget(this._topDensityRT);
        renderer.setClearColor(0x000000, 1); renderer.clear();
        renderer.render(this._quadScene, this._quadCam);
        this._cloudTopDensityValid = true;
      }

      // ── Pass 4: Cloud-top RGBA ─────────────────────────────────────────
      if (this._cloudTopRT && this._cloudTopMat) {
        const usePacked = this._cloudTopDensityValid && !!this._topDensityRT;
        this._cloudTopMat.uniforms.uDensityMode.value  = usePacked ? 1 : 0;
        this._cloudTopMat.uniforms.tCloudDensity.value = usePacked
          ? this._topDensityRT.texture
          : this._densityRT.texture;
        this._cloudTopMat.uniforms.tBlockerMask.value    = this._blockerRT?.texture ?? null;
        this._cloudTopMat.uniforms.uHasBlockerMask.value = this._blockerRT ? 1 : 0;
        this._quad.material = this._cloudTopMat;
        renderer.setRenderTarget(this._cloudTopRT);
        renderer.setClearColor(0x000000, 0); renderer.clear();
        renderer.render(this._quadScene, this._quadCam);
      }

    } finally {
      renderer.setRenderTarget(prevTarget);
    }
  }

  /**
   * Blit cloud tops (alpha-over) onto an existing render target.
   * Call this after LightingEffectV2 has written its output.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget} outputRT
   */
  blitCloudTops(renderer, outputRT) {
    if (!this._initialized || !this._cloudTopRT || !this._cloudTopBlitMat) return;
    const ws = this._getWeatherState();
    if (!ws.weatherEnabled || this._isCoverZero(ws.cloudCover)) return;
    if (this.params.cloudTopOpacity <= 0) return;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    try {
      this._cloudTopBlitMat.uniforms.tCloudTop.value = this._cloudTopRT.texture;
      renderer.setRenderTarget(outputRT);
      renderer.autoClear = false; // alpha-over without clearing
      renderer.render(this._blitScene, this._blitCam);
    } finally {
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  // ── Blocker mask ───────────────────────────────────────────────────────────

  /**
   * Render the overhead-tile blocker mask for the current frame.
   *
   * Traverses the FloorRenderBus scene and isolates sprites that should block
   * cloud shadow (userData.isOverhead || userData.cloudShadowBlocker).
   * All other sprites are temporarily hidden. The blocker is rendered with
   * the main camera so world-space position matches the shadow RT exactly.
   *
   * @param {THREE.WebGLRenderer} renderer
   * @private
   */
  _renderBlockerMask(renderer) {
    if (!this._busScene || !this._mainCamera || !this._blockerRT) return;

    const overrideObjs = this._blockerOverrideObjs;
    const overrideVis  = this._blockerOverrideVis;
    let count = 0;

    // Walk bus scene — hide non-blocker objects, record state to restore
    this._busScene.traverse((obj) => {
      if (!obj.isMesh && !obj.isSprite) return;
      const isBlocker = obj.userData?.isOverhead || obj.userData?.cloudShadowBlocker;
      if (!isBlocker && obj.visible) {
        // Pool expansion: grow arrays on demand (no GC after warm-up)
        if (count >= overrideObjs.length) {
          overrideObjs.push(null);
          overrideVis.push(false);
        }
        overrideObjs[count] = obj;
        overrideVis[count]  = true;
        obj.visible = false;
        count++;
      }
    });
    this._blockerOverrideCount = count;

    const prevTarget    = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = this._mainCamera.layers.mask;
    try {
      this._mainCamera.layers.enableAll();
      renderer.setRenderTarget(this._blockerRT);
      renderer.autoClear = true;
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this._busScene, this._mainCamera);
    } finally {
      // Restore visibility
      for (let i = 0; i < count; i++) overrideObjs[i].visible = overrideVis[i];
      this._mainCamera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevTarget);
    }
  }

  // ── Neutral clear (no clouds) ──────────────────────────────────────────────

  /** @private */
  _renderNeutral(renderer) {
    const rt = (target, r, g, b, a) => {
      renderer.setRenderTarget(target);
      renderer.setClearColor(r * 0xffffff | 0, a);
      renderer.clear();
    };
    // Shadow = white (fully lit), density/tops = black transparent
    if (this._shadowRT)        { renderer.setRenderTarget(this._shadowRT);    renderer.setClearColor(0xffffff, 1); renderer.clear(); }
    if (this._shadowRawRT)     { renderer.setRenderTarget(this._shadowRawRT); renderer.setClearColor(0xffffff, 1); renderer.clear(); }
    if (this._densityRT)       { renderer.setRenderTarget(this._densityRT);   renderer.setClearColor(0x000000, 1); renderer.clear(); }
    if (this._shadowDensityRT) { renderer.setRenderTarget(this._shadowDensityRT); renderer.setClearColor(0x000000, 1); renderer.clear(); }
    if (this._topDensityRT)    { renderer.setRenderTarget(this._topDensityRT); renderer.setClearColor(0x000000, 1); renderer.clear(); }
    if (this._cloudTopRT)      { renderer.setRenderTarget(this._cloudTopRT);  renderer.setClearColor(0x000000, 0); renderer.clear(); }
    void rt; // suppress unused warning
  }

  // ── Render target management ───────────────────────────────────────────────

  /** @private */
  _ensureRenderTargets(fullW, fullH) {
    const THREE = window.THREE;
    if (!THREE) return;

    const scale = Math.max(0.1, Math.min(1.0, this.params.internalResolutionScale ?? 0.5));
    const iW = Math.max(1, Math.round(fullW * scale));
    const iH = Math.max(1, Math.round(fullH * scale));

    if (iW === this._lastInternalW && iH === this._lastInternalH &&
        fullW === this._lastFullW   && fullH === this._lastFullH) return;

    this._lastFullW = fullW; this._lastFullH = fullH;
    this._lastInternalW = iW; this._lastInternalH = iH;

    const opts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
    };
    const make = (existing) => {
      if (existing) { existing.setSize(iW, iH); return existing; }
      return new THREE.WebGLRenderTarget(iW, iH, { ...opts });
    };
    this._shadowDensityRT = make(this._shadowDensityRT);
    this._densityRT       = make(this._densityRT);
    this._topDensityRT    = make(this._topDensityRT);
    this._shadowRT        = make(this._shadowRT);
    this._shadowRawRT     = make(this._shadowRawRT);
    this._cloudTopRT      = make(this._cloudTopRT);
    this._blockerRT       = make(this._blockerRT);
    this._cloudTopDensityValid = false;

    // Update texel-size uniforms
    if (this._shadowMat?.uniforms?.uTexelSize)   this._shadowMat.uniforms.uTexelSize.value.set(1 / iW, 1 / iH);
    if (this._cloudTopMat?.uniforms?.uTexelSize) this._cloudTopMat.uniforms.uTexelSize.value.set(1 / iW, 1 / iH);
    if (this._densityMat?.uniforms?.uResolution) this._densityMat.uniforms.uResolution.value.set(iW, iH);
  }

  onResize(w, h) { this._ensureRenderTargets(Math.max(1, w), Math.max(1, h)); }

  onFloorChange() { /* bus visibility is handled by FloorRenderBus; no extra work needed */ }

  // ── Static schema (mirrors V1 CloudEffect.getControlSchema exactly) ───────

  /**
   * Tweakpane control schema for CloudEffectV2.
   * Param names are identical to V1 CloudEffect so the same UI registration
   * code and _propagateToV2 mirroring can drive both systems.
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'cloud-generation',  label: 'Cloud Generation',       type: 'inline', parameters: ['noiseScale', 'noiseDetail', 'cloudSharpness', 'noiseTimeSpeed'] },
        { name: 'domain-warping',    label: 'Domain Warping (Wisps)', type: 'inline', separator: false, parameters: ['domainWarpEnabled', 'domainWarpStrength', 'domainWarpScale', 'domainWarpSpeed', 'domainWarpTimeOffsetY'] },
        { name: 'shadow-settings',   label: 'Cloud Shadows',          type: 'inline', separator: true,  parameters: ['shadowOpacity', 'shadowSoftness', 'shadowOffsetScale', 'minShadowBrightness'] },
        { name: 'cloud-tops',        label: 'Cloud Tops (Zoom)',      type: 'inline', separator: true,  parameters: ['cloudTopMode', 'cloudTopOpacity', 'cloudTopFadeStart', 'cloudTopFadeEnd', 'cloudBrightness'] },
        { name: 'cloud-top-shading', label: 'Cloud Top Shading',      type: 'inline', separator: false, parameters: ['cloudTopShadingEnabled', 'cloudTopShadingStrength', 'cloudTopNormalStrength', 'cloudTopAOIntensity', 'cloudTopEdgeHighlight'] },
        { name: 'cloud-top-peaks',   label: 'Cloud Top Peaks',        type: 'inline', separator: false, parameters: ['cloudTopPeakDetailEnabled', 'cloudTopPeakDetailStrength', 'cloudTopPeakDetailScale', 'cloudTopPeakDetailSpeed', 'cloudTopPeakDetailStart', 'cloudTopPeakDetailEnd'] },
        { name: 'cloud-top-composite', label: 'Cloud Top Composite',  type: 'inline', separator: false, parameters: ['cloudTopSoftKnee'] },
        { name: 'wind',              label: 'Wind & Drift',           type: 'inline', separator: true,  parameters: ['windInfluence', 'driftSpeed', 'minDriftSpeed', 'driftResponsiveness', 'driftMaxSpeed'] },
        { name: 'layer-base',        label: 'Cloud Layers (Base)',    type: 'inline', separator: true,  parameters: ['layerParallaxBase'] },
        { name: 'layer-1', label: 'Layer 1', type: 'folder', expanded: false, separator: false, parameters: ['layer1Enabled', 'layer1Opacity', 'layer1Scale', 'layer1Coverage', 'layer1ParallaxMult', 'layer1SpeedMult', 'layer1DirDeg'] },
        { name: 'layer-2', label: 'Layer 2', type: 'folder', expanded: false, separator: false, parameters: ['layer2Enabled', 'layer2Opacity', 'layer2Scale', 'layer2Coverage', 'layer2ParallaxMult', 'layer2SpeedMult', 'layer2DirDeg'] },
        { name: 'layer-3', label: 'Layer 3 (Main)', type: 'folder', expanded: false, separator: false, parameters: ['layer3Enabled', 'layer3Opacity', 'layer3Scale', 'layer3Coverage', 'layer3ParallaxMult', 'layer3SpeedMult', 'layer3DirDeg'] },
        { name: 'layer-4', label: 'Layer 4', type: 'folder', expanded: false, separator: false, parameters: ['layer4Enabled', 'layer4Opacity', 'layer4Scale', 'layer4Coverage', 'layer4ParallaxMult', 'layer4SpeedMult', 'layer4DirDeg'] },
        { name: 'layer-5', label: 'Layer 5', type: 'folder', expanded: false, separator: false, parameters: ['layer5Enabled', 'layer5Opacity', 'layer5Scale', 'layer5Coverage', 'layer5ParallaxMult', 'layer5SpeedMult', 'layer5DirDeg'] },
      ],
      parameters: {
        noiseScale:           { type: 'slider', label: 'Cloud Scale',       min: 0.5,  max: 8.0,  step: 0.1,   default: 0.5   },
        noiseDetail:          { type: 'slider', label: 'Detail (Octaves)',   min: 1,    max: 6,    step: 1,     default: 4     },
        cloudSharpness:       { type: 'slider', label: 'Edge Sharpness',    min: 0.0,  max: 1.0,  step: 0.01,  default: 0.0   },
        noiseTimeSpeed:       { type: 'slider', label: 'Internal Motion',   min: 0.0,  max: 0.05, step: 0.001, default: 0.011 },
        domainWarpEnabled:    { type: 'boolean',label: 'Enabled',                                              default: true  },
        domainWarpStrength:   { type: 'slider', label: 'Strength',          min: 0.0,  max: 0.5,  step: 0.005, default: 0.005 },
        domainWarpScale:      { type: 'slider', label: 'Warp Scale',        min: 0.25, max: 10.0, step: 0.05,  default: 1.05  },
        domainWarpSpeed:      { type: 'slider', label: 'Warp Speed',        min: 0.0,  max: 0.5,  step: 0.005, default: 0.115 },
        domainWarpTimeOffsetY:{ type: 'slider', label: 'Y Offset',          min: 0.0,  max: 10.0, step: 0.1,   default: 10.0  },
        shadowOpacity:        { type: 'slider', label: 'Shadow Darkness',   min: 0.0,  max: 1.0,  step: 0.01,  default: 0.7   },
        shadowSoftness:       { type: 'slider', label: 'Shadow Softness',   min: 0.5,  max: 10.0, step: 0.1,   default: 0.9   },
        shadowOffsetScale:    { type: 'slider', label: 'Shadow Offset',     min: 0.0,  max: 0.3,  step: 0.01,  default: 0.3   },
        minShadowBrightness:  { type: 'slider', label: 'Min Brightness',    min: 0.0,  max: 0.5,  step: 0.01,  default: 0.0   },
        cloudTopMode:         { type: 'list',   label: 'Cloud Top Mode',    options: { 'Outdoors Only': 'outdoorsOnly', 'Above Everything (Fade Mask)': 'aboveEverything' }, default: 'aboveEverything' },
        cloudTopOpacity:      { type: 'slider', label: 'Cloud Top Opacity', min: 0.0,  max: 1.0,  step: 0.01,  default: 1.0   },
        cloudTopFadeStart:    { type: 'slider', label: 'Fade Start Zoom',   min: 0.1,  max: 1.0,  step: 0.01,  default: 0.24  },
        cloudTopFadeEnd:      { type: 'slider', label: 'Fade End Zoom',     min: 0.1,  max: 1.0,  step: 0.01,  default: 0.39  },
        cloudBrightness:      { type: 'slider', label: 'Cloud Brightness',  min: 0.8,  max: 1.5,  step: 0.01,  default: 1.01  },
        cloudTopShadingEnabled:    { type: 'boolean', label: 'Shading Enabled',   default: true  },
        cloudTopShadingStrength:   { type: 'slider',  label: 'Shading Strength',  min: 0.0, max: 1.0, step: 0.01, default: 0.99 },
        cloudTopNormalStrength:    { type: 'slider',  label: 'Normal Strength',   min: 0.0, max: 2.0, step: 0.01, default: 0.96 },
        cloudTopAOIntensity:       { type: 'slider',  label: 'AO Intensity',      min: 0.0, max: 5.0, step: 0.1,  default: 2.0  },
        cloudTopEdgeHighlight:     { type: 'slider',  label: 'Edge Highlight',    min: 0.0, max: 1.0, step: 0.01, default: 0.0  },
        cloudTopPeakDetailEnabled: { type: 'boolean', label: 'Peak Detail',       default: false },
        cloudTopPeakDetailStrength:{ type: 'slider',  label: 'Peak Strength',     min: 0.0, max: 1.0, step: 0.01, default: 0.32 },
        cloudTopPeakDetailScale:   { type: 'slider',  label: 'Peak Scale',        min: 10,  max: 200, step: 1,    default: 92.5 },
        cloudTopPeakDetailSpeed:   { type: 'slider',  label: 'Peak Speed',        min: 0.0, max: 0.5, step: 0.01, default: 0.08 },
        cloudTopPeakDetailStart:   { type: 'slider',  label: 'Peak Start',        min: 0.0, max: 1.0, step: 0.01, default: 0.14 },
        cloudTopPeakDetailEnd:     { type: 'slider',  label: 'Peak End',          min: 0.0, max: 1.0, step: 0.01, default: 0.82 },
        cloudTopSoftKnee:     { type: 'slider', label: 'Composite Soft Knee', min: 0.0, max: 5.0, step: 0.1,   default: 1.8   },
        windInfluence:        { type: 'slider', label: 'Wind Influence',    min: 0.0,  max: 2.0,  step: 0.01,  default: 1.33  },
        driftSpeed:           { type: 'slider', label: 'Drift Speed',       min: 0.0,  max: 0.1,  step: 0.001, default: 0.01  },
        minDriftSpeed:        { type: 'slider', label: 'Min Drift Speed',   min: 0.0,  max: 0.05, step: 0.001, default: 0.002 },
        driftResponsiveness:  { type: 'slider', label: 'Responsiveness',    min: 0.0,  max: 1.0,  step: 0.01,  default: 0.4   },
        driftMaxSpeed:        { type: 'slider', label: 'Max Speed',         min: 0.0,  max: 2.0,  step: 0.01,  default: 0.5   },
        layerParallaxBase:    { type: 'slider', label: 'Parallax Base',     min: 0.0,  max: 3.0,  step: 0.1,   default: 1.0   },
        layer1Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer1Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.35 }, layer1Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.33 }, layer1Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 1.34 }, layer1ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 0 }, layer1SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 0.99 }, layer1DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: -1.7 },
        layer2Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer2Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.70 }, layer2Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.57 }, layer2Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 1.22 }, layer2ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 0 }, layer2SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 1.07 }, layer2DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: -0.86 },
        layer3Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer3Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.19 }, layer3Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.90 }, layer3Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 3.00 }, layer3ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 0 }, layer3SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 0.94 }, layer3DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: 0.0 },
        layer4Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer4Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.17 }, layer4Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.46 }, layer4Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 1.72 }, layer4ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 0 }, layer4SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 0.94 }, layer4DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: 0.86 },
        layer5Enabled:  { type: 'boolean', label: 'Enabled', default: true  }, layer5Opacity:  { type: 'slider', label: 'Opacity',   min: 0, max: 1, step: 0.01, default: 0.13 }, layer5Coverage: { type: 'slider', label: 'Coverage',  min: 0, max: 1, step: 0.01, default: 0.62 }, layer5Scale:    { type: 'slider', label: 'Scale',     min: 0.5, max: 5, step: 0.05, default: 1.52 }, layer5ParallaxMult: { type: 'slider', label: 'Parallax', min: 0, max: 2, step: 0.05, default: 0 }, layer5SpeedMult: { type: 'slider', label: 'Speed',    min: 0, max: 3, step: 0.01, default: 1.07 }, layer5DirDeg: { type: 'slider', label: 'Direction°', min: -180, max: 180, step: 0.1, default: -0.6 },
      },
    };
  }

  // ── Accessors (used by FloorCompositor / LightingEffectV2) ────────────────

  /** @type {THREE.Texture|null} Shadow factor texture — bind into LightingEffectV2 */
  get cloudShadowTexture() { return this._shadowRT?.texture ?? null; }

  /** @type {THREE.Texture|null} Raw shadow (no outdoors mask) — for indoor consumers */
  get cloudShadowRawTexture() { return this._shadowRawRT?.texture ?? null; }

  /** @type {THREE.Texture|null} Cloud density — for other consumers */
  get cloudDensityTexture() { return this._densityRT?.texture ?? null; }

  // ── Private helpers ────────────────────────────────────────────────────────

  /** @private */
  _getWeatherState() {
    // Default to params.cloudCover so V2 mode (where WeatherController is not
    // initialized and currentState.cloudCover stays at 0) still renders clouds.
    // Mirrors V1 CloudEffect._getEffectiveWeatherState() which uses the same fallback.
    let cloudCover = this.params.cloudCover ?? 0.5;
    let windSpeed  = 0.07;
    let windDirX   = 1.0;
    let windDirY   = 0.0;
    try {
      if (weatherController) {
        const s = (typeof weatherController.getCurrentState === 'function')
          ? weatherController.getCurrentState()
          : weatherController.currentState;
        // Only read WeatherController state when it has actually been initialized
        // (weatherController.initialize() was awaited). In V2 mode that call is
        // skipped, so initialized===false and currentState is at constructor
        // defaults (cloudCover=0). Overriding params.cloudCover with that 0
        // would suppress all clouds and shadows in V2.
        const wcInitialized = weatherController.initialized === true;
        if (s && wcInitialized) {
          if (typeof s.cloudCover === 'number') cloudCover = s.cloudCover;
          if (typeof s.windSpeed  === 'number') windSpeed  = s.windSpeed;
          if (s.windDirection) {
            windDirX = s.windDirection.x ?? windDirX;
            windDirY = s.windDirection.y ?? windDirY;
          }
        }
      }
    } catch (_) {}

    const normalized = Math.max(0, Math.min(1, Number(cloudCover) || 0));
    return {
      // weatherEnabled mirrors V1: only false if the effect itself is disabled.
      // WeatherController being uninitialized does not disable clouds.
      weatherEnabled: this.enabled !== false,
      cloudCover: normalized,
      windDirX,
      windDirY,
      windSpeed,
    };
  }

  /** @private */
  _isCoverZero(cover) { return (cover ?? 0) < this._cloudCoverEpsilon; }

  /** @private */
  _getZoom() {
    const sc = window.MapShine?.sceneComposer;
    if (sc?.currentZoom !== undefined) return sc.currentZoom;
    if (!this._mainCamera) return 1;
    if (this._mainCamera.isOrthographicCamera) return this._mainCamera.zoom;
    const z = this._mainCamera.position.z;
    return z > 0.1 ? 10000 / z : 1;
  }

  /** @private */
  _smoothstep(edge0, edge1, x) {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 + 1e-8)));
    return t * t * (3 - 2 * t);
  }

  /** @private */
  _calcSunDir() {
    let hour = 12;
    try { if (typeof weatherController?.timeOfDay === 'number') hour = weatherController.timeOfDay; } catch (_) {}
    const t = ((hour % 24) + 24) % 24 / 24;
    const az = (t - 0.5) * Math.PI;
    this._sunDir.set(-Math.sin(az), Math.cos(az) * 0.3);
  }

  /** @private */
  _calcTimeOfDayTint() {
    if (!this._tintResult) return null;
    let hour = 12;
    try { if (typeof weatherController?.timeOfDay === 'number') hour = weatherController.timeOfDay; } catch (_) {}
    hour = ((hour % 24) + 24) % 24;
    const t = this._tintResult;
    if      (hour < 5)  t.copy(this._tintNight);
    else if (hour < 6)  t.lerpVectors(this._tintNight,   this._tintSunrise, hour - 5);
    else if (hour < 7)  t.lerpVectors(this._tintSunrise, this._tintDay,     hour - 6);
    else if (hour < 17) t.copy(this._tintDay);
    else if (hour < 18) t.lerpVectors(this._tintDay,     this._tintSunset,  hour - 17);
    else if (hour < 19) t.lerpVectors(this._tintSunset,  this._tintNight,   hour - 18);
    else                t.copy(this._tintNight);
    return t;
  }

  // ── Shader material factories ──────────────────────────────────────────────

  /** @private */
  _createDensityMaterial() {
    const THREE = window.THREE;
    this._densityMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime:                 { value: 0 },
        uCloudCover:           { value: 0.5 },
        uNoiseScale:           { value: 0.5 },
        uNoiseDetail:          { value: 4 },
        uCloudSharpness:       { value: 0 },
        uNoiseTimeSpeed:       { value: 0.011 },
        uDomainWarpEnabled:    { value: 1 },
        uDomainWarpStrength:   { value: 0.005 },
        uDomainWarpScale:      { value: 1.05 },
        uDomainWarpSpeed:      { value: 0.115 },
        uDomainWarpTimeOffsetY:{ value: 10 },
        uParallaxScale:        { value: 0 },
        uCompositeMode:        { value: 0 },
        uCompositeSoftKnee:    { value: 1.8 },
        uClipToScene:          { value: 0 },
        uResolution:           { value: new THREE.Vector2(1, 1) },
        uSceneOrigin:          { value: new THREE.Vector2(0, 0) },
        uSceneSize:            { value: new THREE.Vector2(4000, 3000) },
        uViewBoundsMin:        { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax:        { value: new THREE.Vector2(4000, 3000) },
        // vec2[5] uploaded as flat Float32Array
        uLayerWindOffsets:     { value: new Float32Array(10) },
        uLayerParallax:        { value: new Float32Array(5) },
        uLayerCoverMult:       { value: new Float32Array(5) },
        uLayerNoiseScaleMult:  { value: new Float32Array(5) },
        uLayerWeight:          { value: new Float32Array(5) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        uniform float uTime;
        uniform float uCloudCover;
        uniform float uNoiseScale;
        uniform float uNoiseDetail;
        uniform float uCloudSharpness;
        uniform float uNoiseTimeSpeed;
        uniform float uDomainWarpEnabled;
        uniform float uDomainWarpStrength;
        uniform float uDomainWarpScale;
        uniform float uDomainWarpSpeed;
        uniform float uDomainWarpTimeOffsetY;
        uniform float uParallaxScale;
        uniform float uCompositeMode;
        uniform float uCompositeSoftKnee;
        uniform float uClipToScene;
        uniform vec2  uResolution;
        uniform vec2  uSceneOrigin;
        uniform vec2  uSceneSize;
        uniform vec2  uViewBoundsMin;
        uniform vec2  uViewBoundsMax;
        uniform vec2  uLayerWindOffsets[5];
        uniform float uLayerParallax[5];
        uniform float uLayerCoverMult[5];
        uniform float uLayerNoiseScaleMult[5];
        uniform float uLayerWeight[5];
        varying vec2 vUv;

        // Simplex 2D noise
        vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x,289.0); }
        float snoise(vec2 v) {
          const vec4 C = vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
          vec2 i = floor(v + dot(v,C.yy));
          vec2 x0 = v - i + dot(i,C.xx);
          vec2 i1 = (x0.x > x0.y) ? vec2(1.0,0.0) : vec2(0.0,1.0);
          vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
          i = mod(i,289.0);
          vec3 p = permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
          vec3 m = max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);
          m=m*m; m=m*m;
          vec3 x=2.0*fract(p*C.www)-1.0;
          vec3 h=abs(x)-0.5;
          vec3 ox=floor(x+0.5); vec3 a0=x-ox;
          m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
          vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
          return 130.0*dot(m,g);
        }
        float fbm(vec2 p, int octaves) {
          float v=0.0,a=0.5,f=1.0,mv=0.0;
          for(int i=0;i<6;i++){
            if(i>=octaves) break;
            v+=a*snoise(p*f); mv+=a; a*=0.5; f*=2.0;
          }
          return v/mv;
        }
        float sampleLayer(vec2 baseWorld, vec2 camPinned, int li, int octaves) {
          float par = uLayerParallax[li] * uParallaxScale;
          vec2 lp = mix(baseWorld, camPinned, par);
          float w = max(uSceneSize.x,1.0); float h = max(uSceneSize.y,1.0); float s=min(w,h);
          vec2 aspect = vec2(w/s,h/s);
          vec2 uv = ((lp - uSceneOrigin) / uSceneSize) * aspect;
          uv += uLayerWindOffsets[li] * aspect;
          float t = uTime * uDomainWarpSpeed;
          vec2 warpUV = uv * uDomainWarpScale;
          vec2 warp = vec2(snoise(warpUV+vec2(t,0.0)),snoise(warpUV+vec2(0.0,t+uDomainWarpTimeOffsetY)));
          warp *= step(0.5,uDomainWarpEnabled) * uDomainWarpStrength;
          vec2 noiseUV = uv * (uNoiseScale * uLayerNoiseScaleMult[li]) + warp;
          float noise = fbm(noiseUV*4.0+vec2(uTime*uNoiseTimeSpeed),octaves)*0.5+0.5;
          float cover = clamp(uCloudCover*uLayerCoverMult[li],0.0,1.0);
          float thr = 1.0-cover;
          float cloud = smoothstep(thr-0.1,thr+0.1,noise);
          cloud = mix(cloud,step(thr,noise),uCloudSharpness);
          return clamp(cloud*uLayerWeight[li],0.0,1.0);
        }
        void main() {
          vec2 viewSize = uViewBoundsMax - uViewBoundsMin;
          vec2 baseWorld = mix(uViewBoundsMin, uViewBoundsMax, vUv);
          if (uClipToScene > 0.5) {
            vec2 sMax = uSceneOrigin + uSceneSize;
            if (baseWorld.x < uSceneOrigin.x || baseWorld.y < uSceneOrigin.y ||
                baseWorld.x > sMax.x         || baseWorld.y > sMax.y) {
              gl_FragColor = vec4(0.0); return;
            }
          }
          vec2 camPinned = (uSceneOrigin+0.5*uSceneSize)+(vUv-0.5)*viewSize;
          int octaves = int(uNoiseDetail);
          float l0=sampleLayer(baseWorld,camPinned,0,octaves);
          float l1=sampleLayer(baseWorld,camPinned,1,octaves);
          float l2=sampleLayer(baseWorld,camPinned,2,octaves);
          float l3=sampleLayer(baseWorld,camPinned,3,octaves);
          float l4=sampleLayer(baseWorld,camPinned,4,octaves);
          if (uCompositeMode < 0.5) {
            // Union blend (shadow mode)
            float inv=(1.0-l0)*(1.0-l1)*(1.0-l2)*(1.0-l3)*(1.0-l4);
            float c=clamp(1.0-inv,0.0,1.0);
            gl_FragColor=vec4(c,c,c,1.0);
          } else {
            // Packed mode (cloud-top): R=mid, G=inner, B=outer, A=composite
            float x=(l0+l1+l2+l3+l4)/2.0;
            float k=max(0.0,uCompositeSoftKnee);
            float c= k>1e-5 ? clamp(1.0-exp(-k*max(0.0,x)),0.0,1.0) : clamp(x,0.0,1.0);
            gl_FragColor=vec4(l2,max(l1,l3),max(l0,l4),c);
          }
        }
      `,
      depthWrite: false, depthTest: false,
    });
    this._densityMat.toneMapped = false;
  }

  /** @private */
  _createShadowMaterial() {
    const THREE = window.THREE;
    this._shadowMat = new THREE.ShaderMaterial({
      uniforms: {
        tCloudDensity:      { value: null },
        uDensityMode:       { value: 0 },
        tOutdoorsMask:      { value: null },
        uHasOutdoorsMask:   { value: 0 },
        tBlockerMask:       { value: null },
        uHasBlockerMask:    { value: 0 },
        uShadowOpacity:     { value: 0.7 },
        uShadowSoftness:    { value: 0.9 },
        uTexelSize:         { value: new THREE.Vector2(1/512, 1/512) },
        uZoom:              { value: 1 },
        uMinBrightness:     { value: 0 },
        uShadowOffsetWorld: { value: new THREE.Vector2(0, 0) },
        uViewBoundsMin:     { value: new THREE.Vector2(0, 0) },
        uViewBoundsMax:     { value: new THREE.Vector2(4000, 3000) },
        uSceneOrigin:       { value: new THREE.Vector2(0, 0) },
        uSceneSize:         { value: new THREE.Vector2(4000, 3000) },
        uDensityBoundsMin:  { value: new THREE.Vector2(0, 0) },
        uDensityBoundsMax:  { value: new THREE.Vector2(4000, 3000) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tCloudDensity;
        uniform float uDensityMode;
        uniform sampler2D tOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform sampler2D tBlockerMask;
        uniform float uHasBlockerMask;
        uniform float uShadowOpacity;
        uniform float uShadowSoftness;
        uniform vec2  uTexelSize;
        uniform float uZoom;
        uniform float uMinBrightness;
        uniform vec2  uShadowOffsetWorld;
        uniform vec2  uViewBoundsMin;
        uniform vec2  uViewBoundsMax;
        uniform vec2  uSceneOrigin;
        uniform vec2  uSceneSize;
        uniform vec2  uDensityBoundsMin;
        uniform vec2  uDensityBoundsMax;
        varying vec2 vUv;

        float readDensity(vec2 uv) {
          vec4 t = texture2D(tCloudDensity, uv);
          return (uDensityMode < 0.5) ? t.r : t.a;
        }

        void main() {
          vec2 baseWorld = mix(uViewBoundsMin, uViewBoundsMax, vUv);
          vec2 sMax = uSceneOrigin + uSceneSize;
          if (baseWorld.x < uSceneOrigin.x || baseWorld.y < uSceneOrigin.y ||
              baseWorld.x > sMax.x || baseWorld.y > sMax.y) {
            gl_FragColor = vec4(1.0); return;
          }

          // Sample density at sun-offset world position
          vec2 shadowWorld = baseWorld + uShadowOffsetWorld;
          vec2 densSize = max(uDensityBoundsMax - uDensityBoundsMin, vec2(1e-3));
          vec2 shadowUV = clamp((shadowWorld - uDensityBoundsMin) / densSize, vec2(0.0), vec2(1.0));

          // 3x3 blur kernel weighted by softness
          float blurPx = uShadowSoftness * 20.0 * uZoom;
          vec2 stepUv = uTexelSize * blurPx;
          float accum = 0.0; float wsum = 0.0;
          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              float w = (dx == 0 && dy == 0) ? 2.0 : 1.0;
              vec2 s = clamp(shadowUV + vec2(float(dx),float(dy))*stepUv, vec2(0.0), vec2(1.0));
              accum += readDensity(s) * w; wsum += w;
            }
          }
          float density = accum / max(wsum, 0.001);
          float factor = max(1.0 - density * uShadowOpacity, uMinBrightness);

          // Outdoors mask: shadow only falls outdoors
          if (uHasOutdoorsMask > 0.5) {
            float outdoors = texture2D(tOutdoorsMask, vUv).r;
            factor = mix(1.0, factor, outdoors);
          }

          // Blocker mask: overhead tiles cancel shadow (rooftops stay bright)
          if (uHasBlockerMask > 0.5) {
            float b = texture2D(tBlockerMask, vUv).a;
            factor = mix(factor, 1.0, clamp(b, 0.0, 1.0));
          }

          gl_FragColor = vec4(factor, factor, factor, 1.0);
        }
      `,
      depthWrite: false, depthTest: false,
    });
    this._shadowMat.toneMapped = false;
  }

  /** @private */
  _createCloudTopMaterial() {
    const THREE = window.THREE;
    this._cloudTopMat = new THREE.ShaderMaterial({
      uniforms: {
        tCloudDensity:         { value: null },
        uDensityMode:          { value: 0 },
        uTime:                 { value: 0 },
        tOutdoorsMask:         { value: null },
        uHasOutdoorsMask:      { value: 0 },
        uOutdoorsMaskStrength: { value: 1 },
        tBlockerMask:          { value: null },
        uHasBlockerMask:       { value: 0 },
        uCloudTopOpacity:      { value: 1 },
        uNormalizedZoom:       { value: 1 },
        uFadeStart:            { value: 0.24 },
        uFadeEnd:              { value: 0.39 },
        uCloudColor:           { value: new THREE.Vector3(1, 1, 1) },
        uSkyTint:              { value: new THREE.Vector3(0.7, 0.8, 1) },
        uTimeOfDayTint:        { value: new THREE.Vector3(1, 1, 1) },
        uTexelSize:            { value: new THREE.Vector2(1/512, 1/512) },
        uSunDir:               { value: new THREE.Vector2(0, 1) },
        uCloudBrightness:      { value: 1 },
        uShadingEnabled:       { value: 1 },
        uShadingStrength:      { value: 0.99 },
        uNormalStrength:       { value: 0.96 },
        uAOIntensity:          { value: 2 },
        uEdgeHighlight:        { value: 0 },
        uPeakDetailEnabled:    { value: 0 },
        uPeakDetailStrength:   { value: 0.32 },
        uPeakDetailScale:      { value: 92.5 },
        uPeakDetailSpeed:      { value: 0.08 },
        uPeakDetailStart:      { value: 0.14 },
        uPeakDetailEnd:        { value: 0.82 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tCloudDensity;
        uniform float uDensityMode;
        uniform float uTime;
        uniform sampler2D tOutdoorsMask;
        uniform float uHasOutdoorsMask;
        uniform float uOutdoorsMaskStrength;
        uniform sampler2D tBlockerMask;
        uniform float uHasBlockerMask;
        uniform float uCloudTopOpacity;
        uniform float uNormalizedZoom;
        uniform float uFadeStart;
        uniform float uFadeEnd;
        uniform vec3  uCloudColor;
        uniform vec3  uSkyTint;
        uniform vec3  uTimeOfDayTint;
        uniform vec2  uTexelSize;
        uniform vec2  uSunDir;
        uniform float uCloudBrightness;
        uniform float uShadingEnabled;
        uniform float uShadingStrength;
        uniform float uNormalStrength;
        uniform float uAOIntensity;
        uniform float uEdgeHighlight;
        uniform float uPeakDetailEnabled;
        uniform float uPeakDetailStrength;
        uniform float uPeakDetailScale;
        uniform float uPeakDetailSpeed;
        uniform float uPeakDetailStart;
        uniform float uPeakDetailEnd;
        varying vec2 vUv;

        float hash21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
        float noise2D(vec2 p){
          vec2 i=floor(p); vec2 f=fract(p);
          float a=hash21(i),b=hash21(i+vec2(1,0)),c=hash21(i+vec2(0,1)),d=hash21(i+vec2(1,1));
          vec2 u=f*f*(3.0-2.0*f);
          return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
        }
        float fbm2D(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){v+=a*noise2D(p);p*=2.02;a*=0.5;} return v; }

        float readDensity(vec2 uv) {
          vec4 t = texture2D(tCloudDensity, uv);
          float d = (uDensityMode < 0.5) ? t.r : t.a;
          if (uPeakDetailEnabled > 0.5) {
            float pm = smoothstep(uPeakDetailStart, uPeakDetailEnd, d);
            float n = fbm2D(uv*uPeakDetailScale+vec2(uTime*uPeakDetailSpeed))*2.0-1.0;
            d = clamp(d + n*uPeakDetailStrength*pm, 0.0, 1.0);
          }
          return d;
        }

        vec3 shadeCloud(vec2 uv, float density, vec3 base) {
          float dN=readDensity(uv+vec2(0.0, uTexelSize.y));
          float dS=readDensity(uv+vec2(0.0,-uTexelSize.y));
          float dE=readDensity(uv+vec2( uTexelSize.x,0.0));
          float dW=readDensity(uv+vec2(-uTexelSize.x,0.0));
          vec2 grad=vec2(dE-dW,dN-dS);
          vec3 n=normalize(vec3(-grad.x*4.0*uNormalStrength,-grad.y*4.0*uNormalStrength,1.0));
          vec3 l=normalize(vec3(uSunDir.x,uSunDir.y,0.35));
          float ndotl=clamp(dot(n,l),0.0,1.0);
          float shade=mix(0.65,1.3,ndotl);
          shade=mix(1.0,shade,clamp(uShadingStrength,0.0,2.0));
          float avgL=0.25*(dN+dS+dE+dW);
          float dN2=readDensity(uv+vec2(0.0, uTexelSize.y*6.0));
          float dS2=readDensity(uv+vec2(0.0,-uTexelSize.y*6.0));
          float dE2=readDensity(uv+vec2( uTexelSize.x*6.0,0.0));
          float dW2=readDensity(uv+vec2(-uTexelSize.x*6.0,0.0));
          float avgW=0.25*(dN2+dS2+dE2+dW2);
          float cavity=max(0.0,0.55*(avgL-density)+0.45*(avgW-density));
          float ao=1.0-clamp(uAOIntensity/2.0,0.0,1.0)*smoothstep(0.0,0.05,cavity)*0.9;
          ao=clamp(ao,0.45,1.10);
          float gMag=length(grad);
          float facing=gMag>1e-5 ? clamp(dot(normalize(grad),normalize(uSunDir)),0.0,1.0) : 0.0;
          float edge=smoothstep(0.03,0.12,gMag)*facing*0.25*uEdgeHighlight;
          return base*shade*ao+edge;
        }

        void main() {
          float density = readDensity(vUv);
          vec4 densTex  = texture2D(tCloudDensity, vUv);
          float zoomFade = 1.0 - smoothstep(uFadeStart, uFadeEnd, uNormalizedZoom);
          float alpha = smoothstep(0.2, 0.6, density) * zoomFade * uCloudTopOpacity;

          float dMid   = (uDensityMode < 0.5) ? density : densTex.r;
          float dInner = (uDensityMode < 0.5) ? density : densTex.g;
          float dOuter = (uDensityMode < 0.5) ? density : densTex.b;

          vec3 base = mix(uSkyTint, uCloudColor, density*0.5+0.5);
          float sum = max(dMid+dInner+dOuter, 1e-3);
          vec3 layered = (base*1.05*dMid + base*0.97*dInner + base*0.90*dOuter) / sum;
          vec3 color = layered * uTimeOfDayTint * uCloudBrightness;
          if (uShadingEnabled > 0.5) color = shadeCloud(vUv, density, color);

          if (uHasOutdoorsMask > 0.5) {
            float o = texture2D(tOutdoorsMask, vUv).r;
            alpha *= mix(1.0, o, clamp(uOutdoorsMaskStrength, 0.0, 1.0));
          }
          if (uHasBlockerMask > 0.5) {
            float b = max(max(texture2D(tBlockerMask,vUv).r, texture2D(tBlockerMask,vUv).g),
                          max(texture2D(tBlockerMask,vUv).b, texture2D(tBlockerMask,vUv).a));
            alpha *= (1.0 - step(0.01, b));
          }
          if (alpha < 0.001) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.NormalBlending,
    });
    this._cloudTopMat.toneMapped = false;
  }

  // ── Dispose ────────────────────────────────────────────────────────────────

  dispose() {
    const rts = [
      '_shadowDensityRT', '_densityRT', '_topDensityRT',
      '_shadowRT', '_shadowRawRT', '_cloudTopRT', '_blockerRT',
    ];
    for (const k of rts) { try { this[k]?.dispose(); } catch (_) {} this[k] = null; }

    const mats = ['_densityMat', '_shadowMat', '_cloudTopMat', '_cloudTopBlitMat'];
    for (const k of mats) { try { this[k]?.dispose(); } catch (_) {} this[k] = null; }

    try { this._quad?.geometry?.dispose(); } catch (_) {}
    try { this._blitQuad?.geometry?.dispose(); } catch (_) {}
    this._quad = null; this._blitQuad = null;
    this._quadScene = null; this._blitScene = null;

    this._initialized = false;
    log.info('CloudEffectV2 disposed');
  }
}
