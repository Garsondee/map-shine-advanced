/**
 * @fileoverview V2 Fluid Effect — per-tile fluid overlays driven by _Fluid masks.
 *
 * V2 architecture:
 * - Per-tile (and background) overlay meshes registered into FloorRenderBus.
 * - Floor isolation is handled via FloorRenderBus.setVisibleFloors().
 * - No reliance on V1 TileEffectBindingManager or EffectMaskRegistry.
 *
 * Note: V1 FluidEffect integrates with DepthPassManager and LightingEffect roof alpha.
 * V2 currently does not provide those resources. The shader uniforms remain present,
 * but are left disabled (uDepthEnabled=0, uHasRoofAlphaMap=0) so the effect still
 * renders correctly.
 */

import { createLogger } from '../../core/log.js';
import { probeMaskFile } from '../../assets/loader.js';
import { tileHasLevelsRange, readTileLevelsFlags } from '../../foundry/levels-scene-flags.js';

const log = createLogger('FluidEffectV2');

const GROUND_Z = 1000;
const FLUID_Z_OFFSET = -0.05; // under albedo tile, within same floor band

export class FluidEffectV2 {
  /**
   * @param {import('../FloorRenderBus.js').FloorRenderBus} renderBus
   */
  constructor(renderBus) {
    /** @type {import('../FloorRenderBus.js').FloorRenderBus} */
    this._renderBus = renderBus;

    /** @type {boolean} */
    this._enabled = true;

    /** @type {boolean} */
    this._initialized = false;

    /**
     * Overlay entries keyed by tileId.
     * @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, floorIndex: number}>}
     */
    this._overlays = new Map();

    /** @type {THREE.TextureLoader|null} */
    this._loader = null;

    /** @type {THREE.Vector2|null} */
    this._screenSize = null;

    // Match V1 defaults for visual parity.
    this.params = {
      intensity: 1.0,
      opacity: 1.0,

      maskThresholdLo: 0.0,
      maskThresholdHi: 1.0,

      colorA: '#ffffff',
      colorB: '#ffffff',
      ageGamma: 1.0,

      flowMode: 1.0,
      flowSpeed: 0.21,
      pulseFrequency: 9.8,
      pulseStrength: 1.0,
      slugWidth: 0.58,
      edgeSoftness: 0.095,

      noiseScale: 6.0,
      noiseStrength: 0.0,
      bubbleScale: 18.0,
      bubbleStrength: 0.0,

      edgeNoiseScale: 0.5,
      edgeNoiseAmp: 0.0,

      meniscusStrength: 0.0,

      causticEnabled: false,
      causticStrength: 0.65,
      causticScale: 12.0,

      foamStrength: 0.0,
      foamScale: 30.0,
      foamWidth: 0.15,
      foamTint: 0.15,
      foamTrailStrength: 0.15,
      edgeFoamStrength: 0.2,
      foamDensity: 0.5,
      foamFrothiness: 0.3,

      iridescenceStrength: 3.0,
      rgbShift: 3.45,

      iriSpeed: 0.5,
      iriScale: 2.3,
      iriFresnel: 0.24,
      iriBreakup: 0.12,
      iriFlowAdvect: 0.81,
      iriSpectralSpread: 0.71,
      iriThicknessContrast: 0.2,
      iriSwirlScale: 2.3,
      iriSwirlSpeed: 0.165,
      iriDetailScale: 21.0,
      iriDetailWeight: 0.63,
      iriSaturation: 1.52,

      churnEnabled: false,
      churnStrength: 0.062,
      churnScale: 2.0,
      churnSpeed: 1.0,
      churnOctaves: 0.75,
      churnFlowBias: 0.21,

      hdrBoostEnabled: true,
      hdrBoostStrength: 3.75,
      hdrBoostPulseSpeed: 1.15,
      hdrBoostEdge: 0.3,
      hdrBoostCenter: 1.0,

      poolStart: 0.16,
      poolEnd: 0.16,
      poolSoftness: 0.2,

      roofOcclusionEnabled: true,
      roofAlphaThreshold: 0.1,
    };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    for (const entry of this._overlays.values()) {
      entry.mesh.visible = this._enabled;
    }
  }

  // ── UI schema (moved from V1 FluidEffect) ────────────────────────────────

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        { name: 'appearance', label: 'Appearance', type: 'inline', parameters: ['intensity', 'opacity', 'colorA', 'colorB', 'ageGamma'] },
        { name: 'masking', label: 'Mask Thresholds', type: 'folder', expanded: false, parameters: ['maskThresholdLo', 'maskThresholdHi'] },
        { name: 'motion', label: 'Flow & Motion', type: 'folder', expanded: false, parameters: ['flowMode', 'flowSpeed', 'pulseFrequency', 'pulseStrength', 'slugWidth', 'edgeSoftness'] },
        { name: 'detail', label: 'Noise & Bubbles', type: 'folder', expanded: false, parameters: ['noiseScale', 'noiseStrength', 'bubbleScale', 'bubbleStrength'] },
        { name: 'edges', label: 'Edge Effects', type: 'folder', expanded: false, parameters: ['edgeNoiseScale', 'edgeNoiseAmp', 'meniscusStrength'] },
        { name: 'foam', label: 'Foam', type: 'folder', expanded: false, parameters: ['foamStrength', 'foamScale', 'foamWidth', 'foamTint', 'foamTrailStrength', 'edgeFoamStrength', 'foamDensity', 'foamFrothiness'] },
        { name: 'surface', label: 'Surface Effects', type: 'folder', expanded: false, parameters: ['causticEnabled', 'causticStrength', 'causticScale', 'rgbShift'] },
        { name: 'iridescence', label: 'Iridescence', type: 'folder', expanded: false, parameters: ['iridescenceStrength', 'iriSpeed', 'iriScale', 'iriFresnel', 'iriBreakup', 'iriFlowAdvect', 'iriSpectralSpread', 'iriThicknessContrast', 'iriSwirlScale', 'iriSwirlSpeed', 'iriDetailScale', 'iriDetailWeight', 'iriSaturation'] },
        { name: 'churn', label: 'Churn & Distortion', type: 'folder', expanded: false, parameters: ['churnEnabled', 'churnStrength', 'churnScale', 'churnSpeed', 'churnOctaves', 'churnFlowBias'] },
        { name: 'hdrBoost', label: 'HDR / Bloom Boost', type: 'folder', expanded: false, parameters: ['hdrBoostEnabled', 'hdrBoostStrength', 'hdrBoostPulseSpeed', 'hdrBoostEdge', 'hdrBoostCenter'] },
        { name: 'pools', label: 'Endpoint Pools', type: 'folder', expanded: false, parameters: ['poolStart', 'poolEnd', 'poolSoftness'] },
        { name: 'roof', label: 'Roof Occlusion', type: 'folder', expanded: false, parameters: ['roofOcclusionEnabled', 'roofAlphaThreshold'] }
      ],
      parameters: {
        intensity:          { type: 'slider', label: 'Intensity',          min: 0,   max: 3,    step: 0.01, default: 1.0 },
        opacity:            { type: 'slider', label: 'Opacity',            min: 0,   max: 1,    step: 0.01, default: 1.0 },
        colorA:             { type: 'color',  label: 'Color A (Young)',    default: '#ffffff' },
        colorB:             { type: 'color',  label: 'Color B (Old)',      default: '#ffffff' },
        ageGamma:           { type: 'slider', label: 'Age Gamma',          min: 0.1, max: 4,    step: 0.01, default: 1.0 },
        maskThresholdLo:    { type: 'slider', label: 'Low Threshold',      min: 0,   max: 0.5,  step: 0.001, default: 0.0 },
        maskThresholdHi:    { type: 'slider', label: 'High Threshold',     min: 0,   max: 1,    step: 0.01,  default: 1.0 },
        flowMode:           { type: 'slider', label: 'Flow Mode (0=Ping-Pong, 1=Directional)', min: 0, max: 1, step: 1, default: 1.0 },
        flowSpeed:          { type: 'slider', label: 'Flow Speed',         min: 0,   max: 2,    step: 0.01, default: 0.21 },
        pulseFrequency:     { type: 'slider', label: 'Slug Count',         min: 0.5, max: 20,   step: 0.1,  default: 9.8 },
        pulseStrength:      { type: 'slider', label: 'Gap Transparency',   min: 0,   max: 1,    step: 0.01, default: 1.0 },
        slugWidth:          { type: 'slider', label: 'Slug Width',         min: 0.05, max: 0.95, step: 0.01, default: 0.58 },
        edgeSoftness:       { type: 'slider', label: 'Edge Softness',      min: 0.005, max: 0.2, step: 0.005, default: 0.095 },
        noiseScale:         { type: 'slider', label: 'Noise Scale',        min: 0.5, max: 30,   step: 0.1,  default: 6.0 },
        noiseStrength:      { type: 'slider', label: 'Noise Strength',     min: 0,   max: 1,    step: 0.01, default: 0.0 },
        bubbleScale:        { type: 'slider', label: 'Bubble Scale',       min: 1,   max: 60,   step: 0.5,  default: 18.0 },
        bubbleStrength:     { type: 'slider', label: 'Bubble Strength',    min: 0,   max: 0.5,  step: 0.01, default: 0.0 },
        edgeNoiseScale:     { type: 'slider', label: 'Edge Noise Scale',   min: 0.5, max: 20,   step: 0.1,  default: 0.5 },
        edgeNoiseAmp:       { type: 'slider', label: 'Edge Noise Amp',     min: 0,   max: 0.3,  step: 0.005, default: 0.0 },
        meniscusStrength:   { type: 'slider', label: 'Meniscus Strength',  min: 0,   max: 1,    step: 0.01, default: 0.0 },
        foamStrength:       { type: 'slider', label: 'Foam Strength',      min: 0,   max: 1,    step: 0.01, default: 0.0 },
        foamScale:          { type: 'slider', label: 'Foam Scale',         min: 5,   max: 80,   step: 0.5,  default: 30.0 },
        foamWidth:          { type: 'slider', label: 'Foam Width',         min: 0.02, max: 0.5,  step: 0.01, default: 0.15 },
        foamTint:           { type: 'slider', label: 'Foam Tint',          min: 0,   max: 1,    step: 0.01, default: 0.15 },
        foamTrailStrength:  { type: 'slider', label: 'Trailing Foam',      min: 0,   max: 1,    step: 0.01, default: 0.15 },
        edgeFoamStrength:   { type: 'slider', label: 'Edge Foam',          min: 0,   max: 1,    step: 0.01, default: 0.2 },
        foamDensity:        { type: 'slider', label: 'Foam Density',       min: 0,   max: 1,    step: 0.01, default: 0.5 },
        foamFrothiness:     { type: 'slider', label: 'Foam Frothiness',    min: 0,   max: 1,    step: 0.01, default: 0.3 },
        causticEnabled:     { type: 'boolean', label: 'Caustics Enabled',  default: false },
        causticStrength:    { type: 'slider', label: 'Caustic Strength',   min: 0,   max: 2,    step: 0.01, default: 0.65 },
        causticScale:       { type: 'slider', label: 'Caustic Scale',      min: 1,   max: 60,   step: 0.5,  default: 12.0 },
        iridescenceStrength: { type: 'slider', label: 'Strength',          min: 0,   max: 3,    step: 0.01, default: 3.0 },
        iriSpeed:           { type: 'slider', label: 'Animation Speed',    min: 0,   max: 3,    step: 0.01, default: 0.5 },
        iriScale:           { type: 'slider', label: 'Film Scale',         min: 0.5, max: 15,   step: 0.1,  default: 2.3 },
        iriFresnel:         { type: 'slider', label: 'Edge Enhancement',   min: 0,   max: 1,    step: 0.01, default: 0.24 },
        iriBreakup:         { type: 'slider', label: 'Patchiness',         min: 0,   max: 1,    step: 0.01, default: 0.12 },
        iriFlowAdvect:      { type: 'slider', label: 'Flow Advection',     min: 0,   max: 1,    step: 0.01, default: 0.81 },
        iriSpectralSpread:  { type: 'slider', label: 'Spectral Spread',    min: 0,   max: 1,    step: 0.01, default: 0.71 },
        iriThicknessContrast: { type: 'slider', label: 'Thickness Contrast', min: 0.2, max: 3,  step: 0.01, default: 0.2 },
        iriSwirlScale:      { type: 'slider', label: 'Swirl Scale',        min: 0.5, max: 8,    step: 0.1,  default: 2.3 },
        iriSwirlSpeed:      { type: 'slider', label: 'Swirl Speed',        min: 0,   max: 0.5,  step: 0.005, default: 0.165 },
        iriDetailScale:     { type: 'slider', label: 'Detail Scale',       min: 1,   max: 30,   step: 0.5,  default: 21.0 },
        iriDetailWeight:    { type: 'slider', label: 'Detail Weight',      min: 0,   max: 1,    step: 0.01, default: 0.63 },
        iriSaturation:      { type: 'slider', label: 'Color Saturation',   min: 0,   max: 2,    step: 0.01, default: 1.52 },
        rgbShift:           { type: 'slider', label: 'RGB Shift',          min: 0,   max: 10,   step: 0.05, default: 3.45 },
        churnEnabled:       { type: 'boolean', label: 'Enable Churn',      default: false },
        churnStrength:      { type: 'slider', label: 'Distortion Amount',  min: 0,   max: 0.08, step: 0.001, default: 0.062 },
        churnScale:         { type: 'slider', label: 'Churn Scale',        min: 0.5, max: 15,   step: 0.1,  default: 2.0 },
        churnSpeed:         { type: 'slider', label: 'Churn Speed',        min: 0,   max: 1,    step: 0.01, default: 1.0 },
        churnOctaves:       { type: 'slider', label: 'Detail (Octave Mix)', min: 0,  max: 1,    step: 0.01, default: 0.75 },
        churnFlowBias:      { type: 'slider', label: 'Flow Bias',          min: 0,   max: 1,    step: 0.01, default: 0.21 },
        hdrBoostEnabled:    { type: 'boolean', label: 'Enable HDR Boost',  default: true },
        hdrBoostStrength:   { type: 'slider', label: 'Boost Intensity',    min: 0,   max: 5,    step: 0.05, default: 3.75 },
        hdrBoostPulseSpeed: { type: 'slider', label: 'Pulse Speed',        min: 0,   max: 5,    step: 0.05, default: 1.15 },
        hdrBoostEdge:       { type: 'slider', label: 'Edge Glow',          min: 0,   max: 1,    step: 0.01, default: 0.3 },
        hdrBoostCenter:     { type: 'slider', label: 'Center Glow',        min: 0,   max: 1,    step: 0.01, default: 1.0 },
        poolStart:          { type: 'slider', label: 'Start Pool',         min: 0,   max: 0.5,  step: 0.01, default: 0.16 },
        poolEnd:            { type: 'slider', label: 'End Pool',           min: 0,   max: 0.5,  step: 0.01, default: 0.16 },
        poolSoftness:       { type: 'slider', label: 'Pool Softness',      min: 0.005, max: 0.2, step: 0.005, default: 0.2 },
        roofOcclusionEnabled: { type: 'boolean', label: 'Enable Roof Occlusion', default: true },
        roofAlphaThreshold:   { type: 'slider', label: 'Roof Alpha Threshold', min: 0, max: 1, step: 0.01, default: 0.1 }
      }
    };
  }

  initialize() {
    if (this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) { log.warn('initialize: THREE not available'); return; }

    this._loader = new THREE.TextureLoader();
    this._screenSize = new THREE.Vector2(1, 1);
    this._initialized = true;
    log.info('FluidEffectV2 initialized');
  }

  clear() {
    for (const [tileId, entry] of this._overlays) {
      this._renderBus.removeEffectOverlay(`${tileId}_fluid`);
      try { entry.material.dispose(); } catch (_) {}
      try { entry.mesh.geometry?.dispose?.(); } catch (_) {}

      // Dispose the mask texture we loaded.
      try {
        const tex = entry.material.uniforms?.tFluidMask?.value;
        tex?.dispose?.();
      } catch (_) {}
    }
    this._overlays.clear();
  }

  dispose() {
    this.clear();
    this._loader = null;
    this._initialized = false;
    log.info('FluidEffectV2 disposed');
  }

  /**
   * @param {object} foundrySceneData
   */
  async populate(foundrySceneData) {
    if (!this._initialized) return;
    this.clear();

    const THREE = window.THREE;
    const floors = window.MapShine?.floorStack?.getFloors() ?? [];
    const worldH = foundrySceneData?.height ?? 0;

    let overlayCount = 0;

    // Background image (uses bus key '__bg_image__')
    const bgSrc = canvas?.scene?.background?.src ?? '';
    if (bgSrc) {
      const bgBase = this._basePathNoExt(bgSrc);
      const mask = await probeMaskFile(bgBase, '_Fluid');
      if (mask?.path) {
        const sceneW = foundrySceneData?.sceneWidth ?? foundrySceneData?.width ?? 0;
        const sceneH = foundrySceneData?.sceneHeight ?? foundrySceneData?.height ?? 0;
        const sceneX = foundrySceneData?.sceneX ?? 0;
        const sceneY = foundrySceneData?.sceneY ?? 0;
        const centerX = sceneX + sceneW / 2;
        const centerY = worldH - (sceneY + sceneH / 2);
        const z = (GROUND_Z - 1) + FLUID_Z_OFFSET;

        this._createOverlay('__bg_image__', 0, {
          maskUrl: mask.path,
          centerX, centerY, z,
          tileW: sceneW,
          tileH: sceneH,
          rotation: 0,
          isOverhead: false,
        });
        overlayCount++;
      }
    }

    // Placed tiles
    const tileDocs = canvas?.scene?.tiles?.contents ?? [];
    for (const tileDoc of tileDocs) {
      const src = tileDoc?.texture?.src ?? tileDoc?.img ?? '';
      if (!src) continue;
      const tileId = tileDoc?.id ?? tileDoc?._id;
      if (!tileId) continue;

      const basePath = this._basePathNoExt(src);
      const mask = await probeMaskFile(basePath, '_Fluid');
      if (!mask?.path) continue;

      const floorIndex = this._resolveFloorIndex(tileDoc, floors);

      const tileW = tileDoc.width ?? 0;
      const tileH = tileDoc.height ?? 0;
      const centerX = (tileDoc.x ?? 0) + tileW / 2;
      const centerY = worldH - ((tileDoc.y ?? 0) + tileH / 2);
      const rotation = typeof tileDoc.rotation === 'number'
        ? (tileDoc.rotation * Math.PI) / 180 : 0;

      const z = (GROUND_Z + floorIndex) + FLUID_Z_OFFSET;

      this._createOverlay(tileId, floorIndex, {
        maskUrl: mask.path,
        centerX, centerY, z,
        tileW, tileH,
        rotation,
        isOverhead: !!tileDoc?.overhead,
      });
      overlayCount++;
    }

    log.info(`FluidEffectV2 populated: ${overlayCount} overlay(s)`);
  }

  /**
   * @param {{ elapsed: number, delta: number }} timeInfo
   */
  update(timeInfo) {
    if (!this._initialized) return;
    const THREE = window.THREE;
    if (!THREE) return;

    // Screen size: used by shader for gl_FragCoord UV mapping (depth/roof paths).
    // In V2 we keep depth/roof disabled, but still provide a sane size.
    try {
      const fc = window.MapShine?.effectComposer?._floorCompositorV2;
      const renderer = fc?.renderer;
      if (renderer?.getDrawingBufferSize) {
        const size = renderer.getDrawingBufferSize(this._screenSize);
        if (size?.x > 0 && size?.y > 0) {
          this._screenSize.set(size.x, size.y);
        }
      }
    } catch (_) {}

    for (const { mesh, material } of this._overlays.values()) {
      const u = material.uniforms;
      if (!u) continue;

      u.uTime.value = timeInfo.elapsed;

      u.uIntensity.value = this.params.intensity;
      u.uOpacity.value = this.params.opacity;

      const maskLo = Math.max(0, Math.min(1, this.params.maskThresholdLo));
      const maskHi = Math.max(maskLo + 0.0001, Math.min(1, this.params.maskThresholdHi));
      u.uMaskThresholdLo.value = maskLo;
      u.uMaskThresholdHi.value = maskHi;

      try { u.uColorA.value.set(this.params.colorA); } catch (_) {}
      try { u.uColorB.value.set(this.params.colorB); } catch (_) {}
      u.uAgeGamma.value = this.params.ageGamma;

      u.uFlowMode.value = this.params.flowMode;
      u.uFlowSpeed.value = this.params.flowSpeed;
      u.uPulseFrequency.value = this.params.pulseFrequency;
      u.uPulseStrength.value = this.params.pulseStrength;
      u.uSlugWidth.value = this.params.slugWidth;
      u.uEdgeSoftness.value = this.params.edgeSoftness;

      u.uNoiseScale.value = this.params.noiseScale;
      u.uNoiseStrength.value = this.params.noiseStrength;
      u.uBubbleScale.value = this.params.bubbleScale;
      u.uBubbleStrength.value = this.params.bubbleStrength;

      u.uEdgeNoiseScale.value = this.params.edgeNoiseScale;
      u.uEdgeNoiseAmp.value = this.params.edgeNoiseAmp;
      u.uMeniscusStrength.value = this.params.meniscusStrength;

      u.uFoamStrength.value = this.params.foamStrength;
      u.uFoamScale.value = this.params.foamScale;
      u.uFoamWidth.value = this.params.foamWidth;
      u.uFoamTint.value = this.params.foamTint;
      u.uFoamTrailStrength.value = this.params.foamTrailStrength;
      u.uEdgeFoamStrength.value = this.params.edgeFoamStrength;
      u.uFoamDensity.value = this.params.foamDensity;
      u.uFoamFrothiness.value = this.params.foamFrothiness;

      u.uCausticEnabled.value = this.params.causticEnabled ? 1.0 : 0.0;
      u.uCausticStrength.value = this.params.causticStrength;
      u.uCausticScale.value = this.params.causticScale;

      u.uIridescenceStrength.value = this.params.iridescenceStrength;
      u.uRgbShift.value = this.params.rgbShift;

      u.uIriSpeed.value = this.params.iriSpeed;
      u.uIriScale.value = this.params.iriScale;
      u.uIriFresnel.value = this.params.iriFresnel;
      u.uIriBreakup.value = this.params.iriBreakup;
      u.uIriFlowAdvect.value = this.params.iriFlowAdvect;
      u.uIriSpectralSpread.value = this.params.iriSpectralSpread;
      u.uIriThicknessContrast.value = this.params.iriThicknessContrast;
      u.uIriSwirlScale.value = this.params.iriSwirlScale;
      u.uIriSwirlSpeed.value = this.params.iriSwirlSpeed;
      u.uIriDetailScale.value = this.params.iriDetailScale;
      u.uIriDetailWeight.value = this.params.iriDetailWeight;
      u.uIriSaturation.value = this.params.iriSaturation;

      u.uChurnEnabled.value = this.params.churnEnabled ? 1.0 : 0.0;
      u.uChurnStrength.value = this.params.churnStrength;
      u.uChurnScale.value = this.params.churnScale;
      u.uChurnSpeed.value = this.params.churnSpeed;
      u.uChurnOctaves.value = this.params.churnOctaves;
      u.uChurnFlowBias.value = this.params.churnFlowBias;

      u.uHdrBoostEnabled.value = this.params.hdrBoostEnabled ? 1.0 : 0.0;
      u.uHdrBoostStrength.value = this.params.hdrBoostStrength;
      u.uHdrBoostPulseSpeed.value = this.params.hdrBoostPulseSpeed;
      u.uHdrBoostEdge.value = this.params.hdrBoostEdge;
      u.uHdrBoostCenter.value = this.params.hdrBoostCenter;

      u.uPoolStart.value = this.params.poolStart;
      u.uPoolEnd.value = this.params.poolEnd;
      u.uPoolSoftness.value = this.params.poolSoftness;

      if (u.uScreenSize?.value) {
        u.uScreenSize.value.copy(this._screenSize);
      }

      // V2: no roof alpha map and no depth texture.
      u.uHasRoofAlphaMap.value = 0.0;
      u.uRoofAlphaMap.value = null;
      u.uRoofOcclusionEnabled.value = 0.0;
      u.uRoofAlphaThreshold.value = this.params.roofAlphaThreshold;

      u.uDepthEnabled.value = 0.0;
      u.uDepthTexture.value = null;

      mesh.visible = this._enabled;
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _basePathNoExt(src) {
    const s = String(src ?? '');
    const dot = s.lastIndexOf('.');
    return dot > 0 ? s.substring(0, dot) : s;
  }

  _resolveFloorIndex(tileDoc, floors) {
    if (!floors || floors.length <= 1) return 0;

    if (tileHasLevelsRange(tileDoc)) {
      const flags = readTileLevelsFlags(tileDoc);
      const tileBottom = Number(flags.rangeBottom);
      const tileTop = Number(flags.rangeTop);
      const tileMid = (tileBottom + tileTop) / 2;

      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileMid >= f.elevationMin && tileMid <= f.elevationMax) return i;
      }
      for (let i = 0; i < floors.length; i++) {
        const f = floors[i];
        if (tileBottom <= f.elevationMax && f.elevationMin <= tileTop) return i;
      }
    }

    const elev = Number.isFinite(Number(tileDoc?.elevation)) ? Number(tileDoc.elevation) : 0;
    for (let i = 0; i < floors.length; i++) {
      const f = floors[i];
      if (elev >= f.elevationMin && elev <= f.elevationMax) return i;
    }
    return 0;
  }

  _createOverlay(tileId, floorIndex, opts) {
    const THREE = window.THREE;
    const { maskUrl, centerX, centerY, z, tileW, tileH, rotation, isOverhead } = opts;
    const baseEntry = this._renderBus?._tiles?.get?.(tileId);
    const canAttachToTileRoot = !!baseEntry && !String(tileId).startsWith('__');

    const material = this._createMaterial();
    const geometry = new THREE.PlaneGeometry(tileW, tileH);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `FluidV2_${tileId}`;
    mesh.frustumCulled = false;
    if (canAttachToTileRoot) {
      // Tile-attached overlays must use local tile-root space.
      mesh.position.set(0, 0, FLUID_Z_OFFSET);
      mesh.rotation.z = 0;
    } else {
      mesh.position.set(centerX, centerY, z);
      mesh.rotation.z = rotation;
    }
    // Keep overlays in the normal bus layer and opt overhead-tile fluids into
    // ROOF_LAYER so OverheadShadowsEffectV2's fluid capture pass can see them.
    mesh.layers.set(0);
    if (isOverhead) mesh.layers.enable(20);

    // Keep renderOrder under the base tile if present.
    try {
      const baseOrder = Number(baseEntry?.mesh?.renderOrder);
      if (Number.isFinite(baseOrder)) {
        mesh.renderOrder = baseOrder - 1;
      }
    } catch (_) {}

    let attached = false;
    if (canAttachToTileRoot && typeof this._renderBus?.addTileAttachedOverlay === 'function') {
      attached = this._renderBus.addTileAttachedOverlay(tileId, `${tileId}_fluid`, mesh, floorIndex) === true;
    }
    if (!attached) {
      this._renderBus.addEffectOverlay(`${tileId}_fluid`, mesh, floorIndex);
    }
    this._overlays.set(tileId, { mesh, material, floorIndex });

    // Load mask texture.
    this._loader.load(maskUrl, (tex) => {
      tex.flipY = true;
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;

      const entry = this._overlays.get(tileId);
      if (!entry) {
        tex.dispose();
        return;
      }

      entry.material.uniforms.tFluidMask.value = tex;
      // Update texel size for finite differences.
      const w = tex.image?.width || 512;
      const h = tex.image?.height || 512;
      entry.material.uniforms.uTexelSize.value.set(1.0 / Math.max(1, w), 1.0 / Math.max(1, h));
    }, undefined, (err) => {
      log.warn(`FluidEffectV2: failed to load mask for ${tileId}: ${maskUrl}`, err);
    });
  }

  _createMaterial() {
    const THREE = window.THREE;

    // Shader is copied from V1 FluidEffect._createMaterial with minimal changes.
    // We keep roof/depth uniforms but they are disabled in update().
    const material = new THREE.ShaderMaterial({
      uniforms: {
        tFluidMask: { value: null },

        uTime: { value: 0.0 },

        uIntensity: { value: this.params.intensity },
        uOpacity: { value: this.params.opacity },

        uMaskThresholdLo: { value: this.params.maskThresholdLo },
        uMaskThresholdHi: { value: this.params.maskThresholdHi },

        uColorA: { value: new THREE.Color(this.params.colorA) },
        uColorB: { value: new THREE.Color(this.params.colorB) },

        uTexelSize: { value: new THREE.Vector2(1.0 / 512.0, 1.0 / 512.0) },
        uAgeGamma: { value: this.params.ageGamma },

        uFlowMode: { value: this.params.flowMode },
        uFlowSpeed: { value: this.params.flowSpeed },
        uPulseFrequency: { value: this.params.pulseFrequency },
        uPulseStrength: { value: this.params.pulseStrength },
        uSlugWidth: { value: this.params.slugWidth },
        uEdgeSoftness: { value: this.params.edgeSoftness },

        uNoiseScale: { value: this.params.noiseScale },
        uNoiseStrength: { value: this.params.noiseStrength },
        uBubbleScale: { value: this.params.bubbleScale },
        uBubbleStrength: { value: this.params.bubbleStrength },

        uEdgeNoiseScale: { value: this.params.edgeNoiseScale },
        uEdgeNoiseAmp: { value: this.params.edgeNoiseAmp },
        uMeniscusStrength: { value: this.params.meniscusStrength },
        uFoamStrength: { value: this.params.foamStrength },
        uFoamScale: { value: this.params.foamScale },
        uFoamWidth: { value: this.params.foamWidth },
        uFoamTint: { value: this.params.foamTint },
        uFoamTrailStrength: { value: this.params.foamTrailStrength },
        uEdgeFoamStrength: { value: this.params.edgeFoamStrength },
        uFoamDensity: { value: this.params.foamDensity },
        uFoamFrothiness: { value: this.params.foamFrothiness },

        uCausticEnabled: { value: this.params.causticEnabled ? 1.0 : 0.0 },
        uCausticStrength: { value: this.params.causticStrength },
        uCausticScale: { value: this.params.causticScale },
        uIridescenceStrength: { value: this.params.iridescenceStrength },
        uRgbShift: { value: this.params.rgbShift },

        uIriSpeed: { value: this.params.iriSpeed },
        uIriScale: { value: this.params.iriScale },
        uIriFresnel: { value: this.params.iriFresnel },
        uIriBreakup: { value: this.params.iriBreakup },
        uIriFlowAdvect: { value: this.params.iriFlowAdvect },
        uIriSpectralSpread: { value: this.params.iriSpectralSpread },
        uIriThicknessContrast: { value: this.params.iriThicknessContrast },
        uIriSwirlScale: { value: this.params.iriSwirlScale },
        uIriSwirlSpeed: { value: this.params.iriSwirlSpeed },
        uIriDetailScale: { value: this.params.iriDetailScale },
        uIriDetailWeight: { value: this.params.iriDetailWeight },
        uIriSaturation: { value: this.params.iriSaturation },

        uChurnEnabled: { value: this.params.churnEnabled ? 1.0 : 0.0 },
        uChurnStrength: { value: this.params.churnStrength },
        uChurnScale: { value: this.params.churnScale },
        uChurnSpeed: { value: this.params.churnSpeed },
        uChurnOctaves: { value: this.params.churnOctaves },
        uChurnFlowBias: { value: this.params.churnFlowBias },

        uHdrBoostEnabled: { value: this.params.hdrBoostEnabled ? 1.0 : 0.0 },
        uHdrBoostStrength: { value: this.params.hdrBoostStrength },
        uHdrBoostPulseSpeed: { value: this.params.hdrBoostPulseSpeed },
        uHdrBoostEdge: { value: this.params.hdrBoostEdge },
        uHdrBoostCenter: { value: this.params.hdrBoostCenter },

        uRoofAlphaMap: { value: null },
        uHasRoofAlphaMap: { value: 0.0 },
        uRoofOcclusionEnabled: { value: 0.0 },
        uRoofAlphaThreshold: { value: this.params.roofAlphaThreshold },
        uScreenSize: { value: new THREE.Vector2(1, 1) },

        uPoolStart: { value: this.params.poolStart },
        uPoolEnd: { value: this.params.poolEnd },
        uPoolSoftness: { value: this.params.poolSoftness },

        uTileOpacity: { value: 1.0 },

        uDepthTexture: { value: null },
        uDepthEnabled: { value: 0.0 },
        uDepthCameraNear: { value: 800.0 },
        uDepthCameraFar: { value: 1200.0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        varying float vLinearDepth;
        void main() {
          vUv = uv;
          vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
          vLinearDepth = -mvPos.z;
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tFluidMask;
        uniform float uTime;

        uniform float uIntensity;
        uniform float uOpacity;

        uniform float uMaskThresholdLo;
        uniform float uMaskThresholdHi;

        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform float uAgeGamma;

        uniform float uFlowMode;
        uniform float uFlowSpeed;
        uniform float uPulseFrequency;
        uniform float uPulseStrength;
        uniform float uSlugWidth;
        uniform float uEdgeSoftness;

        uniform float uNoiseScale;
        uniform float uNoiseStrength;
        uniform float uBubbleScale;
        uniform float uBubbleStrength;

        uniform float uEdgeNoiseScale;
        uniform float uEdgeNoiseAmp;
        uniform float uMeniscusStrength;
        uniform float uFoamStrength;
        uniform float uFoamScale;
        uniform float uFoamWidth;
        uniform float uFoamTint;
        uniform float uFoamTrailStrength;
        uniform float uEdgeFoamStrength;
        uniform float uFoamDensity;
        uniform float uFoamFrothiness;

        uniform float uCausticEnabled;
        uniform float uCausticStrength;
        uniform float uCausticScale;
        uniform float uIridescenceStrength;
        uniform float uRgbShift;

        uniform float uIriSpeed;
        uniform float uIriScale;
        uniform float uIriFresnel;
        uniform float uIriBreakup;
        uniform float uIriFlowAdvect;
        uniform float uIriSpectralSpread;
        uniform float uIriThicknessContrast;
        uniform float uIriSwirlScale;
        uniform float uIriSwirlSpeed;
        uniform float uIriDetailScale;
        uniform float uIriDetailWeight;
        uniform float uIriSaturation;

        uniform float uChurnEnabled;
        uniform float uChurnStrength;
        uniform float uChurnScale;
        uniform float uChurnSpeed;
        uniform float uChurnOctaves;
        uniform float uChurnFlowBias;

        uniform float uHdrBoostEnabled;
        uniform float uHdrBoostStrength;
        uniform float uHdrBoostPulseSpeed;
        uniform float uHdrBoostEdge;
        uniform float uHdrBoostCenter;

        uniform vec2 uTexelSize;

        uniform sampler2D uRoofAlphaMap;
        uniform float uHasRoofAlphaMap;
        uniform float uRoofOcclusionEnabled;
        uniform float uRoofAlphaThreshold;
        uniform vec2 uScreenSize;

        uniform float uPoolStart;
        uniform float uPoolEnd;
        uniform float uPoolSoftness;

        uniform float uTileOpacity;

        uniform sampler2D uDepthTexture;
        uniform float uDepthEnabled;
        uniform float uDepthCameraNear;
        uniform float uDepthCameraFar;

        varying vec2 vUv;
        varying float vLinearDepth;

        float msa_linearizeDepth(float d) {
          float z_ndc = d * 2.0 - 1.0;
          return (2.0 * uDepthCameraNear * uDepthCameraFar) /
                 (uDepthCameraFar + uDepthCameraNear - z_ndc * (uDepthCameraFar - uDepthCameraNear));
        }

        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 345.45));
          p += dot(p, p + 34.345);
          return fract(p.x * p.y);
        }

        vec2 hash22(vec2 p) {
          p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
          return fract(sin(p) * 43758.5453);
        }

        float noise2(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash21(i);
          float b = hash21(i + vec2(1.0, 0.0));
          float c = hash21(i + vec2(0.0, 1.0));
          float d = hash21(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(a, b, u.x) + (c - a) * u.y * (1.0 - u.x) + (d - b) * u.x * u.y;
        }

        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 3; i++) {
            v += a * noise2(p);
            p *= 2.01;
            a *= 0.5;
          }
          return v;
        }

        float causticsPattern(vec2 uv, float time, float scale) {
          vec2 p = uv * scale;
          float t = time;
          float n1 = fbm(p + vec2(t * 0.12, -t * 0.09)) - 0.5;
          float n2 = fbm(p * 1.7 + vec2(-t * 0.08, t * 0.11)) - 0.5;
          float n = 0.6 * n1 + 0.4 * n2;
          float nn = clamp(0.5 + n, 0.0, 1.0);
          float ridge = 1.0 - abs(2.0 * nn - 1.0);
          return smoothstep(0.55, 0.9, ridge);
        }

        vec2 computeChurn(vec2 uv, float time) {
          float ct = time * uChurnSpeed;
          vec2 cUv = uv * uChurnScale;
          float cx = fbm(cUv + vec2(ct * 0.7, -ct * 0.5 + 77.7)) - 0.5;
          float cy = fbm(cUv + vec2(-ct * 0.6, ct * 0.8 + 33.3)) - 0.5;

          vec2 cUv2 = uv * uChurnScale * 2.7 + vec2(ct * 0.3, ct * 0.4);
          float cx2 = (noise2(cUv2) - 0.5) * 0.6;
          float cy2 = (noise2(cUv2 + vec2(55.5, 88.8)) - 0.5) * 0.6;
          cx = mix(cx, cx + cx2, uChurnOctaves);
          cy = mix(cy, cy + cy2, uChurnOctaves);

          float bias = uChurnFlowBias;
          vec2 flowBias = vec2(0.707, 0.707);
          cx += bias * flowBias.x * sin(ct * 1.5 + uv.x * 6.0) * 0.3;
          cy += bias * flowBias.y * cos(ct * 1.2 + uv.y * 6.0) * 0.3;

          return vec2(cx, cy) * uChurnStrength;
        }

        vec3 computeIridescence(vec2 uv, float age, float mask, float time, float thickNoise) {
          float st = time * uIriSwirlSpeed;
          vec2 swirlUv = uv * uIriSwirlScale + vec2(st * 0.9, -st * 0.7);
          float swirlField = fbm(swirlUv);

          vec2 detailUv = uv * uIriDetailScale + vec2(-time * uIriSpeed * 0.3, time * uIriSpeed * 0.2);
          float detailField = noise2(detailUv);

          float thickness = mix(swirlField, swirlField + (detailField - 0.5) * 0.5, uIriDetailWeight);
          thickness += age * uIriFlowAdvect * 2.0;
          thickness += time * uIriSpeed * 0.15;
          thickness += thickNoise * 0.3;
          thickness = (thickness - 0.5) * uIriThicknessContrast + 0.5;

          float phase = thickness * 6.2831 * uIriScale;

          float spread = 1.0 + uIriSpectralSpread * 2.0;
          float phaseR = phase;
          float phaseG = phase + 2.094 * spread;
          float phaseB = phase + 4.189 * spread;

          vec3 rainbow = vec3(
            sin(phaseR) * 0.5 + 0.5,
            sin(phaseG) * 0.5 + 0.5,
            sin(phaseB) * 0.5 + 0.5
          );

          float lum = dot(rainbow, vec3(0.299, 0.587, 0.114));
          rainbow = mix(vec3(lum), rainbow, uIriSaturation);

          float edgeFactor = pow(1.0 - clamp(mask, 0.0, 1.0), 2.0);
          float fresnelMix = mix(1.0, 1.0 + edgeFactor * 3.0, uIriFresnel);

          float patchNoise = noise2(uv * 15.0 + vec2(time * 0.08, -time * 0.06));
          float patchMask = smoothstep(uIriBreakup, uIriBreakup + 0.3, patchNoise);

          return rainbow * fresnelMix * patchMask;
        }

        void main() {
          vec2 baseUv = vUv;
          vec2 churnOffset = vec2(0.0);
          if (uChurnEnabled > 0.5 && uChurnStrength > 0.0001) {
            churnOffset = computeChurn(vUv, uTime);
          }

          vec2 jitteredUv = baseUv + (hash22(baseUv * 500.0) - 0.5) * uTexelSize * 0.2;
          vec4 m = texture2D(tFluidMask, jitteredUv);

          float luma = dot(m.rgb, vec3(0.299, 0.587, 0.114));
          float coverage = m.a * luma;

          float baseMask = smoothstep(uMaskThresholdLo, uMaskThresholdHi, coverage);
          float edgeNoiseRaw = (fbm(baseUv * uEdgeNoiseScale + vec2(uTime * 0.05, -uTime * 0.03)) - 0.5) * uEdgeNoiseAmp;
          float edgeNoiseWeight = 1.0 - abs(baseMask * 2.0 - 1.0);
          float edgeNoise = edgeNoiseRaw * edgeNoiseWeight;
          float maskLo = clamp(uMaskThresholdLo + edgeNoise, 0.0, 1.0);
          float maskHi = clamp(uMaskThresholdHi + edgeNoise, maskLo + 0.0001, 1.0);
          float mask = smoothstep(maskLo, maskHi, coverage);
          if (mask <= 0.001) discard;

          float age = clamp(1.0 - (m.g + m.b) * 0.5, 0.0, 1.0);
          float ageShaped = pow(age, max(0.001, uAgeGamma));

          vec2 gOffset = uTexelSize * 12.0;
          vec4 mR = texture2D(tFluidMask, baseUv + vec2(gOffset.x, 0.0));
          vec4 mL = texture2D(tFluidMask, baseUv - vec2(gOffset.x, 0.0));
          vec4 mU = texture2D(tFluidMask, baseUv + vec2(0.0, gOffset.y));
          vec4 mD = texture2D(tFluidMask, baseUv - vec2(0.0, gOffset.y));

          float ageR = 1.0 - (mR.g + mR.b) * 0.5;
          float ageL = 1.0 - (mL.g + mL.b) * 0.5;
          float ageU = 1.0 - (mU.g + mU.b) * 0.5;
          float ageD = 1.0 - (mD.g + mD.b) * 0.5;

          vec2 grad = vec2(ageR - ageL, ageU - ageD);
          float glen = length(grad);
          vec2 flowDir = (glen > 0.005) ? (grad / glen) : vec2(1.0, 0.0);
          vec2 perp = vec2(-flowDir.y, flowDir.x);
          float isFlowing = smoothstep(0.01, 0.04, glen);

          float t = uTime * uFlowSpeed;
          float flowOffset;
          if (uFlowMode < 0.5) {
            flowOffset = abs(fract(t * 0.5) * 2.0 - 1.0);
          } else {
            flowOffset = t;
          }

          float slugCount = max(1.0, uPulseFrequency);
          float softness = max(0.005, uEdgeSoftness);
          float slugW = clamp(uSlugWidth, 0.05, 0.95);

          float rawPhase = age * slugCount - flowOffset;
          float slugPhase = fract(rawPhase);

          float slugPhaseGrad = fwidth(rawPhase);
          float adaptiveSoftness = clamp(slugPhaseGrad * 5.0, softness, 0.05);

          float noiseAmp = min(0.15, slugW * 0.35);
          vec2 noiseBase = baseUv * uNoiseScale + vec2(t * 0.15, -t * 0.08);
          float noiseLead  = (fbm(noiseBase) - 0.5) * noiseAmp;
          float noiseTrail = (fbm(noiseBase + vec2(17.3, 31.7)) - 0.5) * noiseAmp;

          float leadBound = noiseLead;
          float trailBound = slugW + noiseTrail;
          float slugMask = smoothstep(leadBound, leadBound + adaptiveSoftness, slugPhase)
                         * (1.0 - smoothstep(trailBound - adaptiveSoftness, trailBound, slugPhase));

          float slugAlpha = mix(1.0, slugMask, uPulseStrength);
          float effectSlugMask = mix(1.0, slugMask, isFlowing);

          float boundarySoft = max(0.002, adaptiveSoftness);
          float dLead = abs(slugPhase - leadBound);
          float dTrail = abs(slugPhase - trailBound);
          float slugBoundary = 1.0 - smoothstep(boundarySoft * 0.5, boundarySoft * 4.0, min(dLead, dTrail));
          float pipeBoundary = 1.0 - smoothstep(0.08, 0.35, mask);
          float churnBoundaryMask = clamp(max(slugBoundary, pipeBoundary * 0.5) * effectSlugMask, 0.0, 1.0);
          vec2 detailUv = mix(baseUv, clamp(baseUv + churnOffset, vec2(0.0), vec2(1.0)), churnBoundaryMask);

          vec2 safeTexel = max(uTexelSize, vec2(1e-5));
          vec2 churnPixels = (detailUv - baseUv) / safeTexel;
          float flowDisplacementPx = dot(churnPixels, flowDir);
          float phaseWarp = clamp(flowDisplacementPx * 0.02, -0.35, 0.35) * churnBoundaryMask;
          slugPhase = fract(rawPhase + phaseWarp);

          noiseBase = detailUv * uNoiseScale + vec2(t * 0.15, -t * 0.08);
          noiseLead  = (fbm(noiseBase) - 0.5) * noiseAmp;
          noiseTrail = (fbm(noiseBase + vec2(17.3, 31.7)) - 0.5) * noiseAmp;

          leadBound = noiseLead;
          trailBound = slugW + noiseTrail;
          slugMask = smoothstep(leadBound, leadBound + adaptiveSoftness, slugPhase)
                   * (1.0 - smoothstep(trailBound - adaptiveSoftness, trailBound, slugPhase));

          slugAlpha = mix(1.0, slugMask, uPulseStrength);
          effectSlugMask = mix(1.0, slugMask, isFlowing);

          if (uPoolStart > 0.001) {
            float poolStartFade = 1.0 - smoothstep(uPoolStart - uPoolSoftness, uPoolStart + uPoolSoftness, age);
            slugAlpha = mix(slugAlpha, 1.0, poolStartFade);
            effectSlugMask = mix(effectSlugMask, 1.0, poolStartFade);
          }
          if (uPoolEnd > 0.001) {
            float poolEndEdge = 1.0 - uPoolEnd;
            float poolEndFade = smoothstep(poolEndEdge - uPoolSoftness, poolEndEdge + uPoolSoftness, age);
            slugAlpha = mix(slugAlpha, 1.0, poolEndFade);
            effectSlugMask = mix(effectSlugMask, 1.0, poolEndFade);
          }

          vec2 swirlCoord = detailUv * 2.0 + vec2(t * 0.07, t * 0.05);
          float swirlNoise = fbm(swirlCoord);
          float colorShift = smoothstep(0.3, 0.7, swirlNoise) * uNoiseStrength;
          float ageSwirled = clamp(ageShaped + (colorShift - 0.5) * 0.4, 0.0, 1.0);
          vec3 baseColor = mix(uColorA, uColorB, ageSwirled);

          vec2 thickCoord = detailUv * uNoiseScale + vec2(t * 0.12, -t * 0.07);
          float thickNoise = fbm(thickCoord);
          float depthFactor = mix(1.0, 0.7 + thickNoise * 0.6, uNoiseStrength);

          vec2 surfCoord = detailUv * uNoiseScale * 3.0 + vec2(-t * 0.1, t * 0.08);
          float surfNoise = noise2(surfCoord);
          float surfDetail = mix(1.0, 0.9 + surfNoise * 0.2, uNoiseStrength * 0.5);

          float noiseAlpha = mix(1.0, 0.85 + thickNoise * 0.3, uNoiseStrength * 0.3);

          vec2 bubUv = detailUv * uBubbleScale;
          vec2 bCellId = floor(bubUv);
          vec2 bCellFrac = fract(bubUv);
          float totalBubble = 0.0;

          for (int dy = -1; dy <= 1; dy++) {
            for (int dx = -1; dx <= 1; dx++) {
              vec2 neighbor = vec2(float(dx), float(dy));
              vec2 cid = bCellId + neighbor;

              vec2 rnd = hash22(cid);
              float birthPhase = hash21(cid * 7.13);
              float exists = step(0.55, hash21(cid * 3.77));

              float cycleLen = 1.5 + rnd.x * 2.0;
              float life = fract((uTime + birthPhase * cycleLen) / cycleLen);
              float envelope = smoothstep(0.0, 0.2, life) * (1.0 - smoothstep(0.7, 1.0, life));

              vec2 drift = vec2(t * 0.12, t * 0.08) * isFlowing + vec2(-life * 0.1, life * 0.12) * isFlowing;
              vec2 bubPos = fract(rnd * 0.7 + 0.15 + drift);

              float dist = length(bCellFrac - neighbor - bubPos);
              float radius = (0.04 + rnd.y * 0.08) * envelope;

              float bub = (1.0 - smoothstep(radius * 0.3, radius, dist)) * exists * envelope;
              totalBubble += bub;
            }
          }
          float bubbles = clamp(totalBubble, 0.0, 1.0) * uBubbleStrength * effectSlugMask;

          float meniscusDist = smoothstep(0.0, 0.15, mask);
          float meniscus = pow(1.0 - meniscusDist, 8.0) * uMeniscusStrength * effectSlugMask;

          float caustic = 0.0;
          if (uCausticEnabled > 0.5) {
            caustic = causticsPattern(detailUv, uTime, uCausticScale) * uCausticStrength * effectSlugMask;
          }

          vec2 foamDrift = vec2(t * 0.8, -t * 0.5) + vec2(t * 0.3, t * 0.15) * isFlowing;

          float foamNoiseLarge = fbm(detailUv * uFoamScale * 0.5 + foamDrift * 0.7);
          float foamNoiseDetail = noise2(detailUv * uFoamScale * 2.0 + foamDrift * 1.3);
          float foamNoiseCombined = foamNoiseLarge * 0.65 + foamNoiseDetail * 0.35;

          float leadFoamZone = 1.0 - smoothstep(0.0, max(0.02, uFoamWidth), slugPhase);

          float denseThresh = mix(0.3, 0.7, uFoamDensity);
          float denseFoam = smoothstep(denseThresh, denseThresh + 0.15, foamNoiseCombined);
          float sparseFoam = foamNoiseCombined * uFoamFrothiness * 0.6;

          float foamLifeNoise = noise2(detailUv * uFoamScale * 0.25 + vec2(uTime * 0.15, -uTime * 0.1));
          float foamEnvelope = smoothstep(0.25, 0.55, foamLifeNoise);

          float leadFoam = leadFoamZone * (denseFoam * 0.8 + sparseFoam) * uFoamStrength * foamEnvelope;

          float trailStart = trailBound - uFoamWidth * 0.6;
          float trailEnd = trailBound + uFoamWidth * 0.4;
          float trailFoamZone = smoothstep(trailStart, trailBound, slugPhase)
                               * (1.0 - smoothstep(trailBound, trailEnd, slugPhase));
          float trailFoam = trailFoamZone * foamNoiseCombined * uFoamTrailStrength * foamEnvelope * 0.7;

          float edgeFoamBand = step(0.001, mask) * (1.0 - smoothstep(0.0, 0.15, mask));
          float edgeFoam = edgeFoamBand * foamNoiseCombined * uEdgeFoamStrength;

          float foamFlowGate = mix(0.15, 1.0, isFlowing);
          float totalFoam = clamp(leadFoam + trailFoam + edgeFoam, 0.0, 1.0) * effectSlugMask * foamFlowGate;

          float foamBright = 0.6 + 0.4 * noise2(detailUv * uFoamScale * 0.4 + vec2(t * 0.12, -t * 0.08));
          vec3 foamColor = mix(vec3(1.0), clamp(baseColor * 1.6, 0.0, 1.0), uFoamTint) * foamBright;

          vec3 col = baseColor * depthFactor * surfDetail;
          col += vec3(meniscus);
          col += vec3(caustic);
          col = mix(col, foamColor, totalFoam);
          col += vec3(bubbles);

          if (uIridescenceStrength > 0.001) {
            vec3 iriColor = computeIridescence(detailUv, age, mask, uTime, thickNoise);
            col = mix(col, col * iriColor * 2.0, uIridescenceStrength * 0.5);
          }

          if (uRgbShift > 0.001) {
            float shiftLen = uRgbShift * 0.015;
            vec2 shiftDir = vec2(shiftLen, shiftLen * 0.5);
            vec4 mSR = texture2D(tFluidMask, detailUv + shiftDir);
            vec4 mSB = texture2D(tFluidMask, detailUv - shiftDir);
            float covR = mSR.a * dot(mSR.rgb, vec3(0.299, 0.587, 0.114));
            float covB = mSB.a * dot(mSB.rgb, vec3(0.299, 0.587, 0.114));
            float maskR = smoothstep(uMaskThresholdLo + edgeNoise, uMaskThresholdHi + edgeNoise, covR);
            float maskB = smoothstep(uMaskThresholdLo + edgeNoise, uMaskThresholdHi + edgeNoise, covB);
            float safeInv = 1.0 / max(mask, 0.01);
            col.r *= mix(1.0, min(1.0, maskR * safeInv), 0.7);
            col.b *= mix(1.0, min(1.0, maskB * safeInv), 0.7);
          }

          if (uHdrBoostEnabled > 0.5 && uHdrBoostStrength > 0.001) {
            float pulse = sin(uTime * uHdrBoostPulseSpeed * 1.5) * 0.3 + 0.7;
            float shimmer = sin(uTime * uHdrBoostPulseSpeed * 4.7 + age * 12.0) * 0.15 + 0.85;
            float hotNoise = fbm(detailUv * 5.0 + vec2(uTime * 0.1, -uTime * 0.07));

            float edgeGlow = pow(1.0 - clamp(mask, 0.0, 1.0), 3.0) * uHdrBoostEdge;
            float centerGlow = clamp(mask, 0.0, 1.0) * hotNoise * uHdrBoostCenter;

            float boostAmount = (edgeGlow + centerGlow) * uHdrBoostStrength * pulse * shimmer;
            col += col * boostAmount;
          }

          if (uDepthEnabled > 0.5) {
            vec2 depthUv = gl_FragCoord.xy / max(vec2(1.0), uScreenSize);
            float storedDepth = texture2D(uDepthTexture, depthUv).r;
            if (storedDepth < 0.9999) {
              float storedLinear = msa_linearizeDepth(storedDepth);
              if (storedLinear < vLinearDepth - 0.0005) discard;
            }
          }

          if (uRoofOcclusionEnabled > 0.5 && uHasRoofAlphaMap > 0.5) {
            vec2 suv = gl_FragCoord.xy / max(vec2(1.0), uScreenSize);
            float roofA = texture2D(uRoofAlphaMap, suv).a;
            if (roofA > uRoofAlphaThreshold) {
              discard;
            }
          }

          float alpha = clamp(uOpacity * mask * uIntensity * slugAlpha * noiseAlpha * uTileOpacity, 0.0, 1.0);
          gl_FragColor = vec4(col, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      extensions: { derivatives: true },
    });

    return material;
  }
}
