import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('FluidEffect');

export class FluidEffect extends EffectBase {
  constructor() {
    super('fluid', RenderLayers.SURFACE_EFFECTS, 'low');

    this.priority = 12;
    this.alwaysRender = false;

    this._enabled = true;

    /** @type {THREE.Scene|null} */
    this._scene = null;

    /** @type {Map<string, {mesh: THREE.Mesh, material: THREE.ShaderMaterial, sprite: THREE.Sprite, maskTexture: THREE.Texture}>} */
    this._tileOverlays = new Map();

    /** @type {Set<THREE.ShaderMaterial>} */
    this._materials = new Set();

    /** @type {THREE.Texture|null} */
    this._roofAlphaMap = null;

    /** @type {{x:number,y:number}|null} */
    this._screenSize = null;

    this.params = {
      intensity: 1.0,
      opacity: 0.7,

      maskThresholdLo: 0.05,
      maskThresholdHi: 0.2,

      // Hex strings for Tweakpane color picker compatibility
      colorA: '#26a6ff',
      colorB: '#a60dff',
      ageGamma: 1.0,

      // 0 = ping-pong (oscillates back and forth), 1 = directional (constant travel young→old)
      flowMode: 1.0,
      flowSpeed: 0.35,
      pulseFrequency: 3.0,
      pulseStrength: 0.7,
      slugWidth: 0.4,
      edgeSoftness: 0.02,

      noiseScale: 6.0,
      noiseStrength: 0.25,
      bubbleScale: 18.0,
      bubbleStrength: 0.12,

      // Edge noise clips the lateral pipe boundary for organic edges
      edgeNoiseScale: 4.0,
      edgeNoiseAmp: 0.08,

      // Meniscus bright rim at liquid-pipe boundary
      meniscusStrength: 0.3,

      // Caustics (underwater light pattern, optional)
      causticEnabled: false,
      causticStrength: 0.3,
      causticScale: 12.0,

      // Foam system
      foamStrength: 0.3,
      foamScale: 30.0,
      foamWidth: 0.15,
      foamTint: 0.15,
      foamTrailStrength: 0.15,
      edgeFoamStrength: 0.2,
      foamDensity: 0.5,
      foamFrothiness: 0.3,

      // Chromatic / colour effects
      iridescenceStrength: 0.0,
      rgbShift: 0.0,

      // --- Advanced Iridescence (thin-film interference) ---
      iriSpeed: 0.5,
      iriScale: 3.0,
      iriFresnel: 0.6,
      iriBreakup: 0.3,
      iriFlowAdvect: 0.5,
      iriSpectralSpread: 0.4,
      iriThicknessContrast: 1.2,
      iriSwirlScale: 1.5,
      iriSwirlSpeed: 0.08,
      iriDetailScale: 8.0,
      iriDetailWeight: 0.2,
      iriSaturation: 1.0,

      // --- UV Distortion / Churn ---
      churnEnabled: true,
      churnStrength: 0.015,
      churnScale: 4.0,
      churnSpeed: 0.2,
      churnOctaves: 0.4,
      churnFlowBias: 0.3,

      // --- HDR Bloom Boost ---
      hdrBoostEnabled: false,
      hdrBoostStrength: 1.5,
      hdrBoostPulseSpeed: 1.0,
      hdrBoostEdge: 0.3,
      hdrBoostCenter: 0.2,

      // Pool zones — always-on fluid at pipe start/end (no slug gaps)
      poolStart: 0.0,
      poolEnd: 0.0,
      poolSoftness: 0.05,

      // Roof handling
      roofOcclusionEnabled: true,
      roofAlphaThreshold: 0.1
    };
  }

  /**
   * Get Tweakpane UI control schema.
   * @returns {Object}
   * @public
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'appearance',
          label: 'Appearance',
          type: 'inline',
          parameters: ['intensity', 'opacity', 'colorA', 'colorB', 'ageGamma']
        },
        {
          name: 'masking',
          label: 'Mask Thresholds',
          type: 'folder',
          expanded: false,
          parameters: ['maskThresholdLo', 'maskThresholdHi']
        },
        {
          name: 'motion',
          label: 'Flow & Motion',
          type: 'folder',
          expanded: false,
          parameters: ['flowMode', 'flowSpeed', 'pulseFrequency', 'pulseStrength', 'slugWidth', 'edgeSoftness']
        },
        {
          name: 'detail',
          label: 'Noise & Bubbles',
          type: 'folder',
          expanded: false,
          parameters: ['noiseScale', 'noiseStrength', 'bubbleScale', 'bubbleStrength']
        },
        {
          name: 'edges',
          label: 'Edge Effects',
          type: 'folder',
          expanded: false,
          parameters: ['edgeNoiseScale', 'edgeNoiseAmp', 'meniscusStrength']
        },
        {
          name: 'foam',
          label: 'Foam',
          type: 'folder',
          expanded: false,
          parameters: ['foamStrength', 'foamScale', 'foamWidth', 'foamTint', 'foamTrailStrength', 'edgeFoamStrength', 'foamDensity', 'foamFrothiness']
        },
        {
          name: 'surface',
          label: 'Surface Effects',
          type: 'folder',
          expanded: false,
          parameters: ['causticEnabled', 'causticStrength', 'causticScale', 'rgbShift']
        },
        {
          name: 'iridescence',
          label: 'Iridescence',
          type: 'folder',
          expanded: false,
          parameters: [
            'iridescenceStrength', 'iriSpeed', 'iriScale', 'iriFresnel',
            'iriBreakup', 'iriFlowAdvect', 'iriSpectralSpread',
            'iriThicknessContrast', 'iriSwirlScale', 'iriSwirlSpeed',
            'iriDetailScale', 'iriDetailWeight', 'iriSaturation'
          ]
        },
        {
          name: 'churn',
          label: 'Churn & Distortion',
          type: 'folder',
          expanded: false,
          parameters: ['churnEnabled', 'churnStrength', 'churnScale', 'churnSpeed', 'churnOctaves', 'churnFlowBias']
        },
        {
          name: 'hdrBoost',
          label: 'HDR / Bloom Boost',
          type: 'folder',
          expanded: false,
          parameters: ['hdrBoostEnabled', 'hdrBoostStrength', 'hdrBoostPulseSpeed', 'hdrBoostEdge', 'hdrBoostCenter']
        },
        {
          name: 'pools',
          label: 'Endpoint Pools',
          type: 'folder',
          expanded: false,
          parameters: ['poolStart', 'poolEnd', 'poolSoftness']
        },
        {
          name: 'roof',
          label: 'Roof Occlusion',
          type: 'folder',
          expanded: false,
          parameters: ['roofOcclusionEnabled', 'roofAlphaThreshold']
        }
      ],
      parameters: {
        intensity:          { type: 'slider', label: 'Intensity',          min: 0,   max: 3,    step: 0.01, default: 1.0 },
        opacity:            { type: 'slider', label: 'Opacity',            min: 0,   max: 1,    step: 0.01, default: 0.7 },
        colorA:             { type: 'color',  label: 'Color A (Young)',    default: '#26a6ff' },
        colorB:             { type: 'color',  label: 'Color B (Old)',      default: '#a60dff' },
        ageGamma:           { type: 'slider', label: 'Age Gamma',          min: 0.1, max: 4,    step: 0.01, default: 1.0 },

        maskThresholdLo:    { type: 'slider', label: 'Low Threshold',      min: 0,   max: 0.5,  step: 0.001, default: 0.05 },
        maskThresholdHi:    { type: 'slider', label: 'High Threshold',     min: 0,   max: 1,    step: 0.01,  default: 0.2 },

        flowMode:           { type: 'slider', label: 'Flow Mode (0=Ping-Pong, 1=Directional)', min: 0, max: 1, step: 1, default: 1.0 },
        flowSpeed:          { type: 'slider', label: 'Flow Speed',         min: 0,   max: 2,    step: 0.01, default: 0.35 },
        pulseFrequency:     { type: 'slider', label: 'Slug Count',         min: 0.5, max: 20,   step: 0.1,  default: 3.0 },
        pulseStrength:      { type: 'slider', label: 'Gap Transparency',   min: 0,   max: 1,    step: 0.01, default: 0.7 },
        slugWidth:          { type: 'slider', label: 'Slug Width',         min: 0.05, max: 0.95, step: 0.01, default: 0.4 },
        edgeSoftness:       { type: 'slider', label: 'Edge Softness',      min: 0.005, max: 0.2, step: 0.005, default: 0.02 },

        noiseScale:         { type: 'slider', label: 'Noise Scale',        min: 0.5, max: 30,   step: 0.1,  default: 6.0 },
        noiseStrength:      { type: 'slider', label: 'Noise Strength',     min: 0,   max: 1,    step: 0.01, default: 0.25 },
        bubbleScale:        { type: 'slider', label: 'Bubble Scale',       min: 1,   max: 60,   step: 0.5,  default: 18.0 },
        bubbleStrength:     { type: 'slider', label: 'Bubble Strength',    min: 0,   max: 0.5,  step: 0.01, default: 0.12 },

        edgeNoiseScale:     { type: 'slider', label: 'Edge Noise Scale',   min: 0.5, max: 20,   step: 0.1,  default: 4.0 },
        edgeNoiseAmp:       { type: 'slider', label: 'Edge Noise Amp',     min: 0,   max: 0.3,  step: 0.005, default: 0.08 },
        meniscusStrength:   { type: 'slider', label: 'Meniscus Strength',  min: 0,   max: 1,    step: 0.01, default: 0.3 },
        foamStrength:       { type: 'slider', label: 'Foam Strength',      min: 0,   max: 1,    step: 0.01, default: 0.3 },
        foamScale:          { type: 'slider', label: 'Foam Scale',         min: 5,   max: 80,   step: 0.5,  default: 30.0 },
        foamWidth:          { type: 'slider', label: 'Foam Width',         min: 0.02, max: 0.5,  step: 0.01, default: 0.15 },
        foamTint:           { type: 'slider', label: 'Foam Tint',          min: 0,   max: 1,    step: 0.01, default: 0.15 },
        foamTrailStrength:  { type: 'slider', label: 'Trailing Foam',      min: 0,   max: 1,    step: 0.01, default: 0.15 },
        edgeFoamStrength:   { type: 'slider', label: 'Edge Foam',          min: 0,   max: 1,    step: 0.01, default: 0.2 },
        foamDensity:        { type: 'slider', label: 'Foam Density',       min: 0,   max: 1,    step: 0.01, default: 0.5 },
        foamFrothiness:     { type: 'slider', label: 'Foam Frothiness',    min: 0,   max: 1,    step: 0.01, default: 0.3 },

        causticEnabled:     { type: 'boolean', label: 'Caustics Enabled',  default: false },
        causticStrength:    { type: 'slider', label: 'Caustic Strength',   min: 0,   max: 2,    step: 0.01, default: 0.3 },
        causticScale:       { type: 'slider', label: 'Caustic Scale',      min: 1,   max: 60,   step: 0.5,  default: 12.0 },
        iridescenceStrength: { type: 'slider', label: 'Strength',            min: 0,   max: 3,    step: 0.01, default: 0.0 },
        iriSpeed:            { type: 'slider', label: 'Animation Speed',    min: 0,   max: 3,    step: 0.01, default: 0.5 },
        iriScale:            { type: 'slider', label: 'Film Scale',         min: 0.5, max: 15,   step: 0.1,  default: 3.0 },
        iriFresnel:          { type: 'slider', label: 'Edge Enhancement',   min: 0,   max: 1,    step: 0.01, default: 0.6 },
        iriBreakup:          { type: 'slider', label: 'Patchiness',         min: 0,   max: 1,    step: 0.01, default: 0.3 },
        iriFlowAdvect:       { type: 'slider', label: 'Flow Advection',     min: 0,   max: 1,    step: 0.01, default: 0.5 },
        iriSpectralSpread:   { type: 'slider', label: 'Spectral Spread',    min: 0,   max: 1,    step: 0.01, default: 0.4 },
        iriThicknessContrast:{ type: 'slider', label: 'Thickness Contrast', min: 0.2, max: 3,    step: 0.01, default: 1.2 },
        iriSwirlScale:       { type: 'slider', label: 'Swirl Scale',        min: 0.5, max: 8,    step: 0.1,  default: 1.5 },
        iriSwirlSpeed:       { type: 'slider', label: 'Swirl Speed',        min: 0,   max: 0.5,  step: 0.005, default: 0.08 },
        iriDetailScale:      { type: 'slider', label: 'Detail Scale',       min: 1,   max: 30,   step: 0.5,  default: 8.0 },
        iriDetailWeight:     { type: 'slider', label: 'Detail Weight',      min: 0,   max: 1,    step: 0.01, default: 0.2 },
        iriSaturation:       { type: 'slider', label: 'Color Saturation',   min: 0,   max: 2,    step: 0.01, default: 1.0 },

        rgbShift:           { type: 'slider', label: 'RGB Shift',          min: 0,   max: 10,   step: 0.05, default: 0.0 },

        churnEnabled:       { type: 'boolean', label: 'Enable Churn',      default: true },
        churnStrength:      { type: 'slider', label: 'Distortion Amount',  min: 0,   max: 0.08, step: 0.001, default: 0.015 },
        churnScale:         { type: 'slider', label: 'Churn Scale',        min: 0.5, max: 15,   step: 0.1,  default: 4.0 },
        churnSpeed:         { type: 'slider', label: 'Churn Speed',        min: 0,   max: 1,    step: 0.01, default: 0.2 },
        churnOctaves:       { type: 'slider', label: 'Detail (Octave Mix)',min: 0,   max: 1,    step: 0.01, default: 0.4 },
        churnFlowBias:      { type: 'slider', label: 'Flow Bias',          min: 0,   max: 1,    step: 0.01, default: 0.3 },

        hdrBoostEnabled:    { type: 'boolean', label: 'Enable HDR Boost',  default: false },
        hdrBoostStrength:   { type: 'slider', label: 'Boost Intensity',    min: 0,   max: 5,    step: 0.05, default: 1.5 },
        hdrBoostPulseSpeed: { type: 'slider', label: 'Pulse Speed',        min: 0,   max: 5,    step: 0.05, default: 1.0 },
        hdrBoostEdge:       { type: 'slider', label: 'Edge Glow',          min: 0,   max: 1,    step: 0.01, default: 0.3 },
        hdrBoostCenter:     { type: 'slider', label: 'Center Glow',        min: 0,   max: 1,    step: 0.01, default: 0.2 },

        poolStart:    { type: 'slider', label: 'Start Pool',     min: 0, max: 0.5, step: 0.01, default: 0.0 },
        poolEnd:      { type: 'slider', label: 'End Pool',       min: 0, max: 0.5, step: 0.01, default: 0.0 },
        poolSoftness: { type: 'slider', label: 'Pool Softness',  min: 0.005, max: 0.2, step: 0.005, default: 0.05 },

        roofOcclusionEnabled: { type: 'boolean', label: 'Enable Roof Occlusion', default: true },
        roofAlphaThreshold:   { type: 'slider',  label: 'Roof Alpha Threshold',  min: 0, max: 1, step: 0.01, default: 0.1 }
      },
      presets: {
        'Default (Lab Pipes)': {
          intensity: 1.0, opacity: 0.7,
          colorA: '#26a6ff', colorB: '#a60dff', ageGamma: 1.0,
          flowMode: 1.0, flowSpeed: 0.35, pulseFrequency: 3.0, pulseStrength: 0.7,
          slugWidth: 0.4, edgeSoftness: 0.02,
          noiseScale: 6.0, noiseStrength: 0.25, bubbleScale: 18.0, bubbleStrength: 0.12,
          edgeNoiseScale: 4.0, edgeNoiseAmp: 0.08, meniscusStrength: 0.3, foamStrength: 0.3,
          foamScale: 30.0, foamWidth: 0.15, foamTint: 0.15, foamTrailStrength: 0.15,
          edgeFoamStrength: 0.2, foamDensity: 0.5, foamFrothiness: 0.3,
          causticEnabled: false, causticStrength: 0.3, causticScale: 12.0,
          iridescenceStrength: 0.0, rgbShift: 0.0,
          iriSpeed: 0.5, iriScale: 3.0, iriFresnel: 0.6, iriBreakup: 0.3,
          iriFlowAdvect: 0.5, iriSpectralSpread: 0.4, iriThicknessContrast: 1.2,
          iriSwirlScale: 1.5, iriSwirlSpeed: 0.08, iriDetailScale: 8.0, iriDetailWeight: 0.2, iriSaturation: 1.0,
          churnEnabled: true, churnStrength: 0.015, churnScale: 4.0, churnSpeed: 0.2, churnOctaves: 0.4, churnFlowBias: 0.3,
          hdrBoostEnabled: false, hdrBoostStrength: 1.5, hdrBoostPulseSpeed: 1.0, hdrBoostEdge: 0.3, hdrBoostCenter: 0.2,
          poolStart: 0.0, poolEnd: 0.0, poolSoftness: 0.05
        },
        'Toxic Sludge': {
          intensity: 1.2, opacity: 0.85,
          colorA: '#33ff22', colorB: '#889900', ageGamma: 0.6,
          flowMode: 1.0, flowSpeed: 0.15, pulseFrequency: 2.0, pulseStrength: 0.5,
          slugWidth: 0.5, edgeSoftness: 0.04,
          noiseScale: 4.0, noiseStrength: 0.4, bubbleScale: 12.0, bubbleStrength: 0.3,
          edgeNoiseScale: 3.0, edgeNoiseAmp: 0.12, meniscusStrength: 0.15, foamStrength: 0.5,
          foamScale: 22.0, foamWidth: 0.2, foamTint: 0.35, foamTrailStrength: 0.3,
          edgeFoamStrength: 0.35, foamDensity: 0.6, foamFrothiness: 0.5,
          causticEnabled: false, causticStrength: 0.0, causticScale: 12.0,
          iridescenceStrength: 0.8, rgbShift: 0.0,
          iriSpeed: 0.3, iriScale: 2.5, iriFresnel: 0.8, iriBreakup: 0.6,
          iriFlowAdvect: 0.3, iriSpectralSpread: 0.6, iriThicknessContrast: 1.5,
          iriSwirlScale: 2.0, iriSwirlSpeed: 0.04, iriDetailScale: 6.0, iriDetailWeight: 0.3, iriSaturation: 0.7,
          churnEnabled: true, churnStrength: 0.02, churnScale: 3.0, churnSpeed: 0.1, churnOctaves: 0.5, churnFlowBias: 0.2,
          hdrBoostEnabled: false, hdrBoostStrength: 0.8, hdrBoostPulseSpeed: 0.5, hdrBoostEdge: 0.2, hdrBoostCenter: 0.1,
          poolStart: 0.0, poolEnd: 0.0, poolSoftness: 0.05
        },
        'Lava': {
          intensity: 1.5, opacity: 0.9,
          colorA: '#ff4400', colorB: '#ffcc00', ageGamma: 1.5,
          flowMode: 1.0, flowSpeed: 0.08, pulseFrequency: 1.5, pulseStrength: 0.5,
          slugWidth: 0.6, edgeSoftness: 0.08,
          noiseScale: 3.0, noiseStrength: 0.5, bubbleScale: 8.0, bubbleStrength: 0.2,
          edgeNoiseScale: 2.5, edgeNoiseAmp: 0.1, meniscusStrength: 0.5, foamStrength: 0.1,
          foamScale: 15.0, foamWidth: 0.25, foamTint: 0.5, foamTrailStrength: 0.05,
          edgeFoamStrength: 0.4, foamDensity: 0.7, foamFrothiness: 0.1,
          causticEnabled: false, causticStrength: 0.0, causticScale: 12.0,
          iridescenceStrength: 0.0, rgbShift: 0.0,
          iriSpeed: 0.2, iriScale: 2.0, iriFresnel: 0.3, iriBreakup: 0.1,
          iriFlowAdvect: 0.7, iriSpectralSpread: 0.2, iriThicknessContrast: 0.8,
          iriSwirlScale: 1.0, iriSwirlSpeed: 0.03, iriDetailScale: 5.0, iriDetailWeight: 0.1, iriSaturation: 0.5,
          churnEnabled: true, churnStrength: 0.025, churnScale: 2.5, churnSpeed: 0.08, churnOctaves: 0.6, churnFlowBias: 0.5,
          hdrBoostEnabled: true, hdrBoostStrength: 2.0, hdrBoostPulseSpeed: 0.3, hdrBoostEdge: 0.5, hdrBoostCenter: 0.6,
          poolStart: 0.0, poolEnd: 0.0, poolSoftness: 0.05
        },
        'Blood': {
          intensity: 0.8, opacity: 0.75,
          colorA: '#880000', colorB: '#440011', ageGamma: 0.8,
          flowMode: 0.0, flowSpeed: 0.12, pulseFrequency: 2.0, pulseStrength: 0.4,
          slugWidth: 0.35, edgeSoftness: 0.03,
          noiseScale: 5.0, noiseStrength: 0.2, bubbleScale: 20.0, bubbleStrength: 0.08,
          edgeNoiseScale: 5.0, edgeNoiseAmp: 0.06, meniscusStrength: 0.2, foamStrength: 0.15,
          foamScale: 25.0, foamWidth: 0.1, foamTint: 0.3, foamTrailStrength: 0.1,
          edgeFoamStrength: 0.15, foamDensity: 0.4, foamFrothiness: 0.2,
          causticEnabled: false, causticStrength: 0.0, causticScale: 12.0,
          iridescenceStrength: 0.0, rgbShift: 0.0,
          iriSpeed: 0.3, iriScale: 3.0, iriFresnel: 0.5, iriBreakup: 0.2,
          iriFlowAdvect: 0.4, iriSpectralSpread: 0.3, iriThicknessContrast: 1.0,
          iriSwirlScale: 1.5, iriSwirlSpeed: 0.06, iriDetailScale: 8.0, iriDetailWeight: 0.15, iriSaturation: 0.8,
          churnEnabled: true, churnStrength: 0.01, churnScale: 5.0, churnSpeed: 0.15, churnOctaves: 0.3, churnFlowBias: 0.2,
          hdrBoostEnabled: false, hdrBoostStrength: 1.0, hdrBoostPulseSpeed: 0.5, hdrBoostEdge: 0.2, hdrBoostCenter: 0.1,
          poolStart: 0.0, poolEnd: 0.0, poolSoftness: 0.05
        },
        'Arcane Coolant': {
          intensity: 1.3, opacity: 0.8,
          colorA: '#00ffcc', colorB: '#8800ff', ageGamma: 0.8,
          flowMode: 1.0, flowSpeed: 0.4, pulseFrequency: 4.0, pulseStrength: 0.8,
          slugWidth: 0.35, edgeSoftness: 0.015,
          noiseScale: 8.0, noiseStrength: 0.3, bubbleScale: 22.0, bubbleStrength: 0.2,
          edgeNoiseScale: 6.0, edgeNoiseAmp: 0.1, meniscusStrength: 0.5, foamStrength: 0.4,
          foamScale: 35.0, foamWidth: 0.18, foamTint: 0.2, foamTrailStrength: 0.25,
          edgeFoamStrength: 0.3, foamDensity: 0.5, foamFrothiness: 0.4,
          causticEnabled: true, causticStrength: 0.8, causticScale: 15.0,
          iridescenceStrength: 2.0, rgbShift: 3.0,
          iriSpeed: 0.8, iriScale: 4.0, iriFresnel: 0.7, iriBreakup: 0.15,
          iriFlowAdvect: 0.6, iriSpectralSpread: 0.7, iriThicknessContrast: 1.5,
          iriSwirlScale: 2.5, iriSwirlSpeed: 0.12, iriDetailScale: 10.0, iriDetailWeight: 0.35, iriSaturation: 1.4,
          churnEnabled: true, churnStrength: 0.02, churnScale: 5.0, churnSpeed: 0.3, churnOctaves: 0.5, churnFlowBias: 0.4,
          hdrBoostEnabled: true, hdrBoostStrength: 2.5, hdrBoostPulseSpeed: 1.5, hdrBoostEdge: 0.5, hdrBoostCenter: 0.4,
          poolStart: 0.0, poolEnd: 0.0, poolSoftness: 0.05
        }
      }
    };
  }

  get enabled() {
    return this._enabled;
  }

  set enabled(v) {
    this._enabled = !!v;
    const overlays = this._tileOverlays;
    if (!overlays || typeof overlays.values !== 'function') return;
    for (const data of overlays.values()) {
      if (data?.mesh) data.mesh.visible = this._enabled;
    }
  }

  initialize(renderer, scene, camera) {
    this._scene = scene;
  }

  /**
   * TileBindableEffect interface: load the per-tile fluid mask texture.
   * Called by TileEffectBindingManager before bindTileSprite().
   * Returns null when no _Fluid mask exists for this tile (binding is skipped).
   *
   * @param {object} tileDoc - Foundry TileDocument
   * @returns {Promise<THREE.Texture|null>}
   */
  async loadTileMask(tileDoc) {
    const tileManager = window.MapShine?.tileManager;
    if (!tileManager) return null;
    try {
      const tex = await tileManager.loadTileFluidMaskTexture(tileDoc);
      return tex || null;
    } catch (_) {
      return null;
    }
  }

  /**
   * TileBindableEffect interface: skip roof tiles (they never get fluid overlays).
   * @param {object} tileDoc
   * @returns {boolean}
   */
  shouldBindTile(tileDoc) {
    // Roof tiles are identified at sprite-ready time via userData.isWeatherRoof,
    // but we can also skip tiles that have no texture src at all.
    return !!(tileDoc?.texture?.src || tileDoc?.id);
  }

  /**
   * Bind a per-tile fluid overlay.
   * @param {object} tileDoc
   * @param {THREE.Sprite} sprite
   * @param {THREE.Texture} fluidMaskTexture
   */
  bindTileSprite(tileDoc, sprite, fluidMaskTexture) {
    const tileId = tileDoc?.id;
    const THREE = window.THREE;
    if (!tileId || !THREE || !this._scene || !sprite || !fluidMaskTexture) return;

    // If roof tile, never bind.
    if (sprite?.userData?.isWeatherRoof) {
      this.unbindTileSprite(tileId);
      return;
    }

    // Rebind if already exists.
    this.unbindTileSprite(tileId);

    const material = this._createMaterial(fluidMaskTexture);
    this._materials.add(material);

    const geom = new THREE.PlaneGeometry(1, 1, 1, 1);
    const mesh = new THREE.Mesh(geom, material);
    mesh.matrixAutoUpdate = false;

    // Render under the tile. For bypass tiles renderOrder=1000; we still want under.
    const baseOrder = (typeof sprite.renderOrder === 'number') ? sprite.renderOrder : 0;
    mesh.renderOrder = baseOrder - 1;

    this._syncMeshToSprite(mesh, sprite);

    // Initial visibility
    mesh.visible = !!(this._enabled && sprite.visible);

    this._scene.add(mesh);

    this._tileOverlays.set(tileId, { mesh, material, sprite, maskTexture: fluidMaskTexture });
  }

  /**
   * Unbind/remove a per-tile overlay.
   * @param {string} tileId
   */
  unbindTileSprite(tileId) {
    const data = this._tileOverlays.get(tileId);
    if (!data) return;

    try {
      if (data.mesh && this._scene) this._scene.remove(data.mesh);
    } catch (_) {
    }

    try {
      data.mesh?.geometry?.dispose?.();
    } catch (_) {
    }

    try {
      if (data.material) {
        this._materials.delete(data.material);
        data.material.dispose?.();
      }
    } catch (_) {
    }

    this._tileOverlays.delete(tileId);
  }

  /**
   * Keep an existing overlay glued to its sprite.
   * @param {string} tileId
   * @param {THREE.Sprite} sprite
   */
  syncTileSpriteTransform(tileId, sprite) {
    const data = this._tileOverlays.get(tileId);
    if (!data?.mesh || !sprite) return;

    // If tile became a roof tile, remove overlay.
    if (sprite?.userData?.isWeatherRoof) {
      this.unbindTileSprite(tileId);
      return;
    }

    data.sprite = sprite;
    this._syncMeshToSprite(data.mesh, sprite);

    // Keep renderOrder under tile.
    const baseOrder = (typeof sprite.renderOrder === 'number') ? sprite.renderOrder : 0;
    data.mesh.renderOrder = baseOrder - 1;
  }

  /**
   * Keep visibility in sync with the owning tile.
   * @param {string} tileId
   * @param {THREE.Sprite} sprite
   */
  syncTileSpriteVisibility(tileId, sprite) {
    const data = this._tileOverlays.get(tileId);
    if (!data?.mesh) return;

    const vis = !!(this._enabled && sprite?.visible);
    data.mesh.visible = vis;
  }

  setRoofAlphaMap(tex) {
    this._roofAlphaMap = tex || null;
    for (const mat of this._materials) {
      if (mat?.uniforms?.uRoofAlphaMap) {
        mat.uniforms.uRoofAlphaMap.value = this._roofAlphaMap;
        mat.uniforms.uHasRoofAlphaMap.value = this._roofAlphaMap ? 1.0 : 0.0;
      }
    }
  }

  _isIndoorShadowModeEnabled() {
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      return !!(overhead?.enabled && overhead?.params?.indoorShadowEnabled);
    } catch (_) {
      return false;
    }
  }

  update(timeInfo) {
    const THREE = window.THREE;
    if (!THREE) return;

    // Opportunistically pull roof alpha from LightingEffect.
    try {
      const le = window.MapShine?.lightingEffect;
      const next = le?.roofAlphaTarget?.texture || le?.roofAlphaTarget || null;
      if (next && next !== this._roofAlphaMap) {
        this.setRoofAlphaMap(next);
      }

      // Screen size for roof alpha sampling.
      const w = le?.roofAlphaTarget?.width;
      const h = le?.roofAlphaTarget?.height;
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        if (!this._screenSize) this._screenSize = { x: w, y: h };
        else {
          this._screenSize.x = w;
          this._screenSize.y = h;
        }
      }
    } catch (_) {
    }

    if (!this._screenSize) {
      this._screenSize = { x: window.innerWidth || 1, y: window.innerHeight || 1 };
    }

    const indoorShadowMode = this._isIndoorShadowModeEnabled();
    const effectiveRoofOcclusionEnabled = !!(this.params.roofOcclusionEnabled && !indoorShadowMode);

    for (const data of this._tileOverlays.values()) {
      const m = data?.material;
      const u = m?.uniforms;
      if (!u) continue;

      u.uTime.value = timeInfo.elapsed;
      u.uIntensity.value = this.params.intensity;
      u.uOpacity.value = this.params.opacity;

      // Keep thresholds ordered and bounded so smoothstep cannot enter
      // undefined/reversed ranges that can create mask artifacts.
      const maskLo = Math.max(0, Math.min(1, this.params.maskThresholdLo));
      const maskHi = Math.max(maskLo + 0.0001, Math.min(1, this.params.maskThresholdHi));
      u.uMaskThresholdLo.value = maskLo;
      u.uMaskThresholdHi.value = maskHi;

      // Colors are stored as hex strings for Tweakpane; convert to THREE.Color.
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

      // Advanced iridescence
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

      // Churn / distortion
      u.uChurnEnabled.value = this.params.churnEnabled ? 1.0 : 0.0;
      u.uChurnStrength.value = this.params.churnStrength;
      u.uChurnScale.value = this.params.churnScale;
      u.uChurnSpeed.value = this.params.churnSpeed;
      u.uChurnOctaves.value = this.params.churnOctaves;
      u.uChurnFlowBias.value = this.params.churnFlowBias;

      // HDR bloom boost
      u.uHdrBoostEnabled.value = this.params.hdrBoostEnabled ? 1.0 : 0.0;
      u.uHdrBoostStrength.value = this.params.hdrBoostStrength;
      u.uHdrBoostPulseSpeed.value = this.params.hdrBoostPulseSpeed;
      u.uHdrBoostEdge.value = this.params.hdrBoostEdge;
      u.uHdrBoostCenter.value = this.params.hdrBoostCenter;

      u.uRoofOcclusionEnabled.value = effectiveRoofOcclusionEnabled ? 1.0 : 0.0;
      u.uRoofAlphaThreshold.value = this.params.roofAlphaThreshold;

      u.uPoolStart.value = this.params.poolStart;
      u.uPoolEnd.value = this.params.poolEnd;
      u.uPoolSoftness.value = this.params.poolSoftness;

      if (u.uScreenSize) {
        u.uScreenSize.value.set(this._screenSize.x, this._screenSize.y);
      }

      // Depth pass texture binding for shader-based tile occlusion.
      const dpm = window.MapShine?.depthPassManager;
      const depthTex = (dpm && dpm.isEnabled()) ? dpm.getDepthTexture() : null;
      if (u.uDepthEnabled) u.uDepthEnabled.value = depthTex ? 1.0 : 0.0;
      if (u.uDepthTexture) u.uDepthTexture.value = depthTex;
      if (depthTex && dpm) {
        if (u.uDepthCameraNear) u.uDepthCameraNear.value = dpm.getDepthNear();
        if (u.uDepthCameraFar) u.uDepthCameraFar.value = dpm.getDepthFar();
      }

      // Mirror the owning tile sprite's material opacity so the fluid fades
      // in lockstep with overhead tile hover-hide / occlusion animations.
      if (u.uTileOpacity) {
        let spriteOpacity = 1.0;
        try {
          const o = data.sprite?.material?.opacity;
          if (typeof o === 'number' && Number.isFinite(o)) spriteOpacity = o;
        } catch (_) {}
        u.uTileOpacity.value = spriteOpacity;

        // Also keep mesh visibility in sync: hide entirely when sprite is
        // fully faded so we skip the fragment shader entirely.
        data.mesh.visible = !!(this._enabled && data.sprite?.visible && spriteOpacity > 0.005);
      }
    }
  }

  dispose() {
    for (const tileId of Array.from(this._tileOverlays.keys())) {
      this.unbindTileSprite(tileId);
    }
    this._materials.clear();
    this._scene = null;
  }

  /**
   * Sync overlay mesh transform, visibility, opacity, layers, and renderOrder
   * to the owning tile sprite. Mirrors SpecularEffect._syncTileOverlayTransform.
   */
  _syncMeshToSprite(mesh, sprite) {
    try {
      // Ensure sprite world matrix is current before copying.
      sprite.updateMatrixWorld?.(true);
    } catch (_) {
    }
    try {
      mesh.matrix.copy(sprite.matrixWorld);
      mesh.matrixWorldNeedsUpdate = true;
    } catch (_) {
    }

    // Mirror visibility — respect opacity-based hover-hide (sprite.visible stays
    // true but opacity drops to 0 during hover-hide on overhead tiles).
    let spriteOpacity = 1.0;
    try {
      const o = sprite?.material?.opacity;
      if (typeof o === 'number' && Number.isFinite(o)) spriteOpacity = o;
    } catch (_) {
    }
    mesh.visible = !!(this._enabled && sprite.visible && spriteOpacity > 0.01);

    // Keep renderOrder just under the tile sprite.
    try {
      mesh.renderOrder = (typeof sprite.renderOrder === 'number') ? (sprite.renderOrder - 1) : mesh.renderOrder;
    } catch (_) {
    }

    // Keep layer mask in sync so the overlay renders in the same passes.
    try {
      mesh.layers.mask = sprite.layers.mask;
    } catch (_) {
    }
  }

  _createMaterial(fluidMaskTexture) {
    const THREE = window.THREE;

    // Data mask texture: force bilinear filtering so finite-difference
    // gradient math sees smooth slopes instead of 8-bit staircases.
    try {
      fluidMaskTexture.flipY = true;
      fluidMaskTexture.minFilter = THREE.LinearFilter;
      fluidMaskTexture.magFilter = THREE.LinearFilter;
      fluidMaskTexture.wrapS = THREE.ClampToEdgeWrapping;
      fluidMaskTexture.wrapT = THREE.ClampToEdgeWrapping;
      fluidMaskTexture.generateMipmaps = false;
      fluidMaskTexture.needsUpdate = true;
    } catch (_) {
    }

    const material = new THREE.ShaderMaterial({
      uniforms: {
        tFluidMask: { value: fluidMaskTexture },

        uTime: { value: 0.0 },

        uIntensity: { value: this.params.intensity },
        uOpacity: { value: this.params.opacity },

        uMaskThresholdLo: { value: this.params.maskThresholdLo },
        uMaskThresholdHi: { value: this.params.maskThresholdHi },

        uColorA: { value: new THREE.Color(this.params.colorA) },
        uColorB: { value: new THREE.Color(this.params.colorB) },

        // Texel size for UV-space finite differences (world-stable gradient).
        uTexelSize: { value: new THREE.Vector2(1.0 / Math.max(1, fluidMaskTexture.image?.width || 512), 1.0 / Math.max(1, fluidMaskTexture.image?.height || 512)) },
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

        // Advanced iridescence (thin-film interference)
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

        // UV distortion / churn
        uChurnEnabled: { value: this.params.churnEnabled ? 1.0 : 0.0 },
        uChurnStrength: { value: this.params.churnStrength },
        uChurnScale: { value: this.params.churnScale },
        uChurnSpeed: { value: this.params.churnSpeed },
        uChurnOctaves: { value: this.params.churnOctaves },
        uChurnFlowBias: { value: this.params.churnFlowBias },

        // HDR bloom boost
        uHdrBoostEnabled: { value: this.params.hdrBoostEnabled ? 1.0 : 0.0 },
        uHdrBoostStrength: { value: this.params.hdrBoostStrength },
        uHdrBoostPulseSpeed: { value: this.params.hdrBoostPulseSpeed },
        uHdrBoostEdge: { value: this.params.hdrBoostEdge },
        uHdrBoostCenter: { value: this.params.hdrBoostCenter },

        // Roof alpha occlusion (screen space)
        uRoofAlphaMap: { value: this._roofAlphaMap },
        uHasRoofAlphaMap: { value: this._roofAlphaMap ? 1.0 : 0.0 },
        uRoofOcclusionEnabled: { value: (this.params.roofOcclusionEnabled && !this._isIndoorShadowModeEnabled()) ? 1.0 : 0.0 },
        uRoofAlphaThreshold: { value: this.params.roofAlphaThreshold },
        uScreenSize: { value: new THREE.Vector2(window.innerWidth || 1, window.innerHeight || 1) },

        // Endpoint pool zones — always-on fluid at pipe start/end
        uPoolStart: { value: this.params.poolStart },
        uPoolEnd: { value: this.params.poolEnd },
        uPoolSoftness: { value: this.params.poolSoftness },

        // Per-tile opacity: mirrors the owning sprite's material.opacity so
        // the fluid fades in sync with overhead tile hover-hide / occlusion.
        uTileOpacity: { value: 1.0 },

        // Depth pass integration: occludes fluid where a closer surface exists.
        // Uses the tight depth camera (groundDist±200) for ~40 ULPs/sort step.
        uDepthTexture: { value: null },
        uDepthEnabled: { value: 0.0 },
        uDepthCameraNear: { value: 800.0 },
        uDepthCameraFar: { value: 1200.0 }
      },
      vertexShader: `
varying vec2 vUv;
varying float vLinearDepth;

void main() {
  vUv = uv;
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vLinearDepth = -mvPos.z; // Eye-space distance (positive, full float32 precision)
  gl_Position = projectionMatrix * mvPos;
}
      `.trim(),
      fragmentShader: `
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

// Advanced iridescence (thin-film interference)
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

// UV distortion / churn
uniform float uChurnEnabled;
uniform float uChurnStrength;
uniform float uChurnScale;
uniform float uChurnSpeed;
uniform float uChurnOctaves;
uniform float uChurnFlowBias;

// HDR bloom boost
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

// Depth pass integration
uniform sampler2D uDepthTexture;
uniform float uDepthEnabled;
uniform float uDepthCameraNear;
uniform float uDepthCameraFar;

varying vec2 vUv;
varying float vLinearDepth;

// Linearize perspective device depth [0,1] → eye-space distance.
// Uses the tight depth camera's near/far (NOT main camera).
float msa_linearizeDepth(float d) {
  float z_ndc = d * 2.0 - 1.0;
  return (2.0 * uDepthCameraNear * uDepthCameraFar) /
         (uDepthCameraFar + uDepthCameraNear - z_ndc * (uDepthCameraFar - uDepthCameraNear));
}

// --- Noise utilities ---

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

// Caustic pattern: two offset FBM layers → ridged transform → thin filaments.
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

// ---- Churn: compute a UV distortion offset from layered noise ----
// Returns a 2D displacement in UV space. The distortion is masked so it
// can't push samples outside the fluid boundary (handled by the caller).
vec2 computeChurn(vec2 uv, float time) {
  float ct = time * uChurnSpeed;

  // Primary large-scale swirl
  vec2 cUv = uv * uChurnScale;
  float cx = fbm(cUv + vec2(ct * 0.7, -ct * 0.5 + 77.7)) - 0.5;
  float cy = fbm(cUv + vec2(-ct * 0.6, ct * 0.8 + 33.3)) - 0.5;

  // Secondary fine detail layer, blended by uChurnOctaves
  vec2 cUv2 = uv * uChurnScale * 2.7 + vec2(ct * 0.3, ct * 0.4);
  float cx2 = (noise2(cUv2) - 0.5) * 0.6;
  float cy2 = (noise2(cUv2 + vec2(55.5, 88.8)) - 0.5) * 0.6;
  cx = mix(cx, cx + cx2, uChurnOctaves);
  cy = mix(cy, cy + cy2, uChurnOctaves);

  // Bias the distortion along the dominant flow direction (constant direction
  // to avoid blocky per-pixel artifacts — uses a fixed diagonal that roughly
  // approximates "along the pipe")
  float bias = uChurnFlowBias;
  vec2 flowBias = vec2(0.707, 0.707); // 45° diagonal, stable across pixels
  cx += bias * flowBias.x * sin(ct * 1.5 + uv.x * 6.0) * 0.3;
  cy += bias * flowBias.y * cos(ct * 1.2 + uv.y * 6.0) * 0.3;

  return vec2(cx, cy) * uChurnStrength;
}

// ---- Thin-film iridescence: simulates oil-slick / soap-bubble spectral colour ----
// Returns an additive RGB colour to composite onto the base fluid.
vec3 computeIridescence(vec2 uv, float age, float mask, float time, float thickNoise) {
  // Build a spatially-varying "film thickness" field from layered noise.
  // Large swirls give slow-drifting colour pools; detail adds micro-variation.
  float st = time * uIriSwirlSpeed;
  vec2 swirlUv = uv * uIriSwirlScale + vec2(st * 0.9, -st * 0.7);
  float swirlField = fbm(swirlUv);

  vec2 detailUv = uv * uIriDetailScale + vec2(-time * uIriSpeed * 0.3, time * uIriSpeed * 0.2);
  float detailField = noise2(detailUv);

  // Combine: swirl is the primary structure, detail adds fine texture
  float thickness = mix(swirlField, swirlField + (detailField - 0.5) * 0.5, uIriDetailWeight);

  // Flow advection: shift thickness along the age gradient so colour
  // pools travel with the liquid instead of sitting in place
  thickness += age * uIriFlowAdvect * 2.0;

  // Add temporal animation so the whole pattern evolves
  thickness += time * uIriSpeed * 0.15;

  // Existing thickNoise from the fluid body adds further organic variation
  thickness += thickNoise * 0.3;

  // Apply contrast to control how distinct the colour bands are
  thickness = (thickness - 0.5) * uIriThicknessContrast + 0.5;

  // Convert thickness to spectral phase. The base multiplier (TAU * scale)
  // controls how many colour bands fit across the thickness range.
  float phase = thickness * 6.2831 * uIriScale;

  // Spectral decomposition: each RGB channel represents a different "wavelength".
  // uIriSpectralSpread controls the phase offset between channels — small values
  // give near-monochrome shimmer, large values give full rainbow.
  float spread = 1.0 + uIriSpectralSpread * 2.0; // 1.0–3.0 range
  float phaseR = phase;
  float phaseG = phase + 2.094 * spread; // 120° × spread
  float phaseB = phase + 4.189 * spread; // 240° × spread

  vec3 rainbow = vec3(
    sin(phaseR) * 0.5 + 0.5,
    sin(phaseG) * 0.5 + 0.5,
    sin(phaseB) * 0.5 + 0.5
  );

  // Saturation control: lerp between greyscale luminance and full colour
  float lum = dot(rainbow, vec3(0.299, 0.587, 0.114));
  rainbow = mix(vec3(lum), rainbow, uIriSaturation);

  // Fresnel-like edge enhancement: iridescence is stronger near pipe edges
  // where the liquid surface curves (meniscus / surface tension)
  float edgeFactor = pow(1.0 - clamp(mask, 0.0, 1.0), 2.0);
  float fresnelMix = mix(1.0, 1.0 + edgeFactor * 3.0, uIriFresnel);

  // Breakup: noise-gated patchiness so iridescence forms discrete islands
  // like oil on water rather than appearing uniformly everywhere
  float patchNoise = noise2(uv * 15.0 + vec2(time * 0.08, -time * 0.06));
  float patchMask = smoothstep(uIriBreakup, uIriBreakup + 0.3, patchNoise);
  // When breakup is 0 patchMask is ~1.0 everywhere (uniform iridescence)
  // When breakup is high, only bright noise peaks show through

  return rainbow * fresnelMix * patchMask;
}

void main() {
  // ======================================================================
  // [0] CHURN DISTORTION PREP
  // IMPORTANT: keep mask/alpha confinement on original UVs so fluid never
  // escapes the authored _Fluid mask. Distortion is applied later only to
  // interior/detail sampling and only near dynamic boundaries.
  // ======================================================================
  vec2 baseUv = vUv;
  vec2 churnOffset = vec2(0.0);
  if (uChurnEnabled > 0.5 && uChurnStrength > 0.0001) {
    churnOffset = computeChurn(vUv, uTime);
  }

  // Sub-texel UV jitter to break alignment with texture grid / compression macroblocks.
  vec2 jitteredUv = baseUv + (hash22(baseUv * 500.0) - 0.5) * uTexelSize * 0.2;
  vec4 m = texture2D(tFluidMask, jitteredUv);

  // Coverage from alpha * luminance
  float luma = dot(m.rgb, vec3(0.299, 0.587, 0.114));
  float coverage = m.a * luma;

  // [1] NOISE-CLIPPED EDGES: inject noise into mask threshold for organic pipe boundary.
  // Critical: only apply threshold jitter near the *existing* mask boundary.
  // If noise is applied everywhere, negative threshold shifts can create false
  // positives in zero-coverage regions (visible "leaks" outside the _Fluid mask).
  float baseMask = smoothstep(uMaskThresholdLo, uMaskThresholdHi, coverage);
  float edgeNoiseRaw = (fbm(baseUv * uEdgeNoiseScale + vec2(uTime * 0.05, -uTime * 0.03)) - 0.5) * uEdgeNoiseAmp;
  float edgeNoiseWeight = 1.0 - abs(baseMask * 2.0 - 1.0);
  float edgeNoise = edgeNoiseRaw * edgeNoiseWeight;
  float maskLo = clamp(uMaskThresholdLo + edgeNoise, 0.0, 1.0);
  float maskHi = clamp(uMaskThresholdHi + edgeNoise, maskLo + 0.0001, 1.0);
  float mask = smoothstep(maskLo, maskHi, coverage);
  if (mask <= 0.001) discard;

  // ---- Age: white(1,1,1) = young(0), red(1,0,0) = old(1) ----
  // Red channel is always ~1.0 in both white and red pixels.
  // True age is encoded in the DECAY of green + blue channels.
  float age = clamp(1.0 - (m.g + m.b) * 0.5, 0.0, 1.0);
  float ageShaped = pow(age, max(0.001, uAgeGamma));

  // ---- Flow direction from corrected age gradient (finite differences) ----
  // Sample 12 texels apart so the gradient isn't crushed on high-res masks
  vec2 gOffset = uTexelSize * 12.0;
  vec4 mR = texture2D(tFluidMask, baseUv + vec2(gOffset.x, 0.0));
  vec4 mL = texture2D(tFluidMask, baseUv - vec2(gOffset.x, 0.0));
  vec4 mU = texture2D(tFluidMask, baseUv + vec2(0.0, gOffset.y));
  vec4 mD = texture2D(tFluidMask, baseUv - vec2(0.0, gOffset.y));

  float ageR = 1.0 - (mR.g + mR.b) * 0.5;
  float ageL = 1.0 - (mL.g + mL.b) * 0.5;
  float ageU = 1.0 - (mU.g + mU.b) * 0.5;
  float ageD = 1.0 - (mD.g + mD.b) * 0.5;

  // No * 0.5 — keep full magnitude so gradient isn't crushed on large textures
  vec2 grad = vec2(ageR - ageL, ageU - ageD);
  float glen = length(grad);
  // Threshold must exceed 8-bit quantization noise (~0.002-0.01 for uniform areas)
  vec2 flowDir = (glen > 0.005) ? (grad / glen) : vec2(1.0, 0.0);
  vec2 perp = vec2(-flowDir.y, flowDir.x);
  // Smooth gate: 0 in reservoirs / gradual gradients, 1 in pipes with clear gradient.
  float isFlowing = smoothstep(0.01, 0.04, glen);

  // ---- Flow animation ----
  float t = uTime * uFlowSpeed;
  float flowOffset;
  if (uFlowMode < 0.5) {
    // Ping-pong: triangle wave oscillation (0->1->0->1...)
    flowOffset = abs(fract(t * 0.5) * 2.0 - 1.0);
  } else {
    // Directional: constant travel from young end to old end, wrapping
    flowOffset = t;
  }

  // ---- Slug pattern: distinct liquid chunks with transparent gaps ----
  float slugCount = max(1.0, uPulseFrequency);
  float softness = max(0.005, uEdgeSoftness);
  float slugW = clamp(uSlugWidth, 0.05, 0.95);

  // Phase within each slug cell [0, 1) — scrolls with flowOffset
  float rawPhase = age * slugCount - flowOffset;
  float slugPhase = fract(rawPhase);

  // Adaptive softness: fwidth(rawPhase) gives screen-space phase change per pixel.
  float slugPhaseGrad = fwidth(rawPhase);
  float adaptiveSoftness = clamp(slugPhaseGrad * 5.0, softness, 0.05);

  // Noise displacement for organic slug boundaries (pass 1, undistorted)
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

  // Distortion mask: strongest at slug edges (lead/trail) and somewhat on
  // pipe boundary. This keeps churn localized and prevents body drift.
  float boundarySoft = max(0.002, adaptiveSoftness);
  float dLead = abs(slugPhase - leadBound);
  float dTrail = abs(slugPhase - trailBound);
  float slugBoundary = 1.0 - smoothstep(boundarySoft * 0.5, boundarySoft * 4.0, min(dLead, dTrail));
  float pipeBoundary = 1.0 - smoothstep(0.08, 0.35, mask);
  float churnBoundaryMask = clamp(max(slugBoundary, pipeBoundary * 0.5) * effectSlugMask, 0.0, 1.0);
  vec2 detailUv = mix(baseUv, clamp(baseUv + churnOffset, vec2(0.0), vec2(1.0)), churnBoundaryMask);

  // Pass 2 (distorted): move the slug silhouette itself by perturbing phase and
  // boundary noise in churned UV space. Final alpha remains clipped by mask
  // from the original UV, so fluid cannot leave the authored _Fluid region.
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

  // Endpoint pool zones (applied after final slug distortion)
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

  // [2] MULTI-OCTAVE INTERNAL NOISE (color swirl + depth + surface detail)

  // A) Large-scale colour swirl
  vec2 swirlCoord = detailUv * 2.0 + vec2(t * 0.07, t * 0.05);
  float swirlNoise = fbm(swirlCoord);
  float colorShift = smoothstep(0.3, 0.7, swirlNoise) * uNoiseStrength;
  float ageSwirled = clamp(ageShaped + (colorShift - 0.5) * 0.4, 0.0, 1.0);
  vec3 baseColor = mix(uColorA, uColorB, ageSwirled);

  // B) Medium-scale depth/opacity variation
  vec2 thickCoord = detailUv * uNoiseScale + vec2(t * 0.12, -t * 0.07);
  float thickNoise = fbm(thickCoord);
  float depthFactor = mix(1.0, 0.7 + thickNoise * 0.6, uNoiseStrength);

  // C) Fine surface texture
  vec2 surfCoord = detailUv * uNoiseScale * 3.0 + vec2(-t * 0.1, t * 0.08);
  float surfNoise = noise2(surfCoord);
  float surfDetail = mix(1.0, 0.9 + surfNoise * 0.2, uNoiseStrength * 0.5);

  float noiseAlpha = mix(1.0, 0.85 + thickNoise * 0.3, uNoiseStrength * 0.3);

  // [3] FIZZING BUBBLES WITH LIFECYCLE
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

  // [4] MENISCUS — bright rim at liquid-pipe boundary
  float meniscusDist = smoothstep(0.0, 0.15, mask);
  float meniscus = pow(1.0 - meniscusDist, 8.0) * uMeniscusStrength * effectSlugMask;

  // [5] CAUSTICS — optional swimming light filaments
  float caustic = 0.0;
  if (uCausticEnabled > 0.5) {
    caustic = causticsPattern(detailUv, uTime, uCausticScale) * uCausticStrength * effectSlugMask;
  }

  // [6] PREMIUM FOAM SYSTEM

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

  // ---- Color compositing ----
  vec3 col = baseColor * depthFactor * surfDetail;

  // Meniscus (additive bright rim)
  col += vec3(meniscus);

  // Caustics (additive light filaments)
  col += vec3(caustic);

  // Foam (tinted, multi-layered)
  col = mix(col, foamColor, totalFoam);

  // Bubble highlights (additive white)
  col += vec3(bubbles);

  // ======================================================================
  // [7] ADVANCED IRIDESCENCE — thin-film interference simulation
  // Replaces the old simple sine-wave rainbow with a multi-layered system:
  //   - Spatially-varying "film thickness" from layered noise (swirl + detail)
  //   - Flow advection so colour pools travel with the liquid
  //   - Fresnel edge enhancement (stronger at pipe walls / meniscus)
  //   - Noise-gated patchiness for oil-slick island patterns
  //   - Tunable spectral spread controlling rainbow width
  //   - Per-channel saturation control
  // ======================================================================
  if (uIridescenceStrength > 0.001) {
    vec3 iriColor = computeIridescence(detailUv, age, mask, uTime, thickNoise);

    // Composite: multiply the base colour by the iridescent rainbow (×2 to keep
    // brightness since rainbow oscillates around 0.5). The strength uniform
    // controls the blend from original colour to iridescent colour.
    col = mix(col, col * iriColor * 2.0, uIridescenceStrength * 0.5);
  }

  // [8] RGB SHIFT — chromatic aberration on the mask for prismatic edge fringing
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

  // ======================================================================
  // [9] HDR BLOOM BOOST — push parts of the fluid above 1.0 so they
  // catch the post-processing bloom pass. Uses spatial noise + pulsing
  // to create organic hot-spots rather than a flat intensity boost.
  // Edge and center glow are independently controllable.
  // ======================================================================
  if (uHdrBoostEnabled > 0.5 && uHdrBoostStrength > 0.001) {
    // Pulsating envelope: slow sine modulation so the glow breathes
    float pulse = sin(uTime * uHdrBoostPulseSpeed * 1.5) * 0.3 + 0.7;
    // Secondary faster shimmer for sparkle
    float shimmer = sin(uTime * uHdrBoostPulseSpeed * 4.7 + age * 12.0) * 0.15 + 0.85;

    // Spatial variation: noise-based hot-spots that drift with the fluid
    float hotNoise = fbm(detailUv * 5.0 + vec2(uTime * 0.1, -uTime * 0.07));

    // Edge glow: strongest at pipe boundaries (meniscus region)
    float edgeGlow = pow(1.0 - clamp(mask, 0.0, 1.0), 3.0) * uHdrBoostEdge;

    // Center glow: strongest in the liquid interior, modulated by noise
    float centerGlow = clamp(mask, 0.0, 1.0) * hotNoise * uHdrBoostCenter;

    // Combine and scale by the main boost strength + pulse envelope
    float boostAmount = (edgeGlow + centerGlow) * uHdrBoostStrength * pulse * shimmer;

    // Apply: push colour above 1.0 (HDR). The bloom pass will pick up
    // anything above the bloom threshold and create the glow halo.
    col += col * boostAmount;
  }

  // ---- Depth pass occlusion ----
  // Discard fluid where a closer surface exists in the depth texture.
  // Tolerance 0.0005: passes same-tile, rejects adjacent sort keys.
  if (uDepthEnabled > 0.5) {
    vec2 depthUv = gl_FragCoord.xy / max(vec2(1.0), uScreenSize);
    float storedDepth = texture2D(uDepthTexture, depthUv).r;
    if (storedDepth < 0.9999) {
      float storedLinear = msa_linearizeDepth(storedDepth);
      if (storedLinear < vLinearDepth - 0.0005) discard;
    }
  }

  // ---- Roof alpha occlusion (screen-space) ----
  if (uRoofOcclusionEnabled > 0.5 && uHasRoofAlphaMap > 0.5) {
    vec2 suv = gl_FragCoord.xy / max(vec2(1.0), uScreenSize);
    float roofA = texture2D(uRoofAlphaMap, suv).a;
    if (roofA > uRoofAlphaThreshold) {
      discard;
    }
  }

  // Final alpha: mask * slug gaps * noise thickness * user controls * tile opacity
  float alpha = clamp(uOpacity * mask * uIntensity * slugAlpha * noiseAlpha * uTileOpacity, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
      `.trim(),
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      extensions: { derivatives: true }
    });

    return material;
  }
}
