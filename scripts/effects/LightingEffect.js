/**
 * @fileoverview Lighting Effect
 * Implements dynamic lighting for the scene base plane.
 * Replaces Foundry's PIXI lighting with a multipass Three.js approach.
 * @module effects/LightingEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { weatherController } from '../core/WeatherController.js';

import { ThreeLightSource } from './ThreeLightSource.js'; // Import the class above
import { ThreeDarknessSource } from './ThreeDarknessSource.js';
import { ROPE_MASK_LAYER } from './EffectComposer.js';

const log = createLogger('LightingEffect');

// TEMPORARY KILL-SWITCH: Disable lighting effect for perf testing.
// Set to true to skip all lighting passes and render scene directly.
// Currently FALSE so normal rendering works while we profile other systems.
const DISABLE_LIGHTING_EFFECT = false;

export class LightingEffect extends EffectBase {
  constructor() {
    super('lighting', RenderLayers.POST_PROCESSING, 'low');
    
    this.priority = 1; 
    
    // UI Parameters matching Foundry VTT + Custom Tweaks
    // NOTE: LightingEffect now ONLY handles lighting math (ambient + dynamic lights).
    // All tone mapping, exposure, contrast, saturation is handled by ColorCorrectionEffect.
    // See docs/CONTRAST-DARKNESS-ANALYSIS.md for rationale.
    this.params = {
      enabled: true,
      globalIllumination: 2.0, // Multiplier for ambient
      lightIntensity: 0.5, // Master multiplier for dynamic lights
      colorationStrength: 3.0,
      darknessEffect: 0.65, // Scales Foundry's darknessLevel
      darknessLevel: 0.0, // Read-only mostly, synced from canvas

      // Outdoor brightness control: adjusts outdoor areas relative to darkness level
      // At darkness 0: outdoors *= outdoorBrightness (boost daylight)
      // At darkness 1: outdoors *= (2.0 - outdoorBrightness) (dim night)
      outdoorBrightness: 1.0, // 1.0 = no change, 2.0 = double brightness at day

      lightningOutsideEnabled: true,
      lightningOutsideGain: 1.25,

      lightningOutsideShadowEnabled: true,
      lightningOutsideShadowStrength: 0.75,
      lightningOutsideShadowRadiusPx: 520.0,
      lightningOutsideShadowEdgeGain: 6.0,
      lightningOutsideShadowInvert: false,

      wallInsetPx: 6.0,

      negativeDarknessStrength: 1.0, // Controls subtractive darkness strength
      darknessPunchGain: 2.0,

      debugShowLightBuffer: undefined,
      debugLightBufferExposure: undefined,
      debugShowDarknessBuffer: undefined,
      debugShowRopeMask: undefined,
    };

    this.lights = new Map(); 
    this.darknessSources = new Map(); 
    
    this.lightScene = null;     
    this.darknessScene = null;  
    this.darknessTarget = null; 
    this.roofAlphaTarget = null; 
    this.weatherRoofAlphaTarget = null;
    this.ropeMaskTarget = null;
    this.tokenMaskTarget = null;
    this.masksTarget = null;
    this._quadMesh = null;

    this.outdoorsMask = null;
    this.outdoorsScene = null;
    this.outdoorsMesh = null;
    this.outdoorsMaterial = null;
    this.outdoorsTarget = null;
    
    this._effectiveDarkness = null;
    
    this._tempSize = null; 

    this._baseMesh = null;

    this._publishedRoofAlphaTex = null;
    this._publishedWeatherRoofAlphaTex = null;
    this._publishedOutdoorsTex = null;
    this._publishedRopeMaskTex = null;
    this._publishedTokenMaskTex = null;
    
    this._transparentTex = null;

    this._masksPackScene = null;
    this._masksPackCamera = null;
    this._masksPackMesh = null;
    this._masksPackMaterial = null;
  }

  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'illumination',
          label: 'Global Illumination',
          type: 'inline',
          parameters: ['globalIllumination', 'lightIntensity', 'colorationStrength']
        },
        {
          name: 'occlusion',
          label: 'Occlusion',
          type: 'inline',
          parameters: ['wallInsetPx']
        },
        {
          name: 'darkness',
          label: 'Darkness Response',
          type: 'inline',
          parameters: ['darknessEffect', 'outdoorBrightness', 'negativeDarknessStrength', 'darknessPunchGain']
        },
        {
          name: 'lightning',
          label: 'Lightning (Outside)',
          type: 'inline',
          parameters: [
            'lightningOutsideEnabled',
            'lightningOutsideGain',
            'lightningOutsideShadowEnabled',
            'lightningOutsideShadowStrength',
            'lightningOutsideShadowRadiusPx',
            'lightningOutsideShadowEdgeGain',
            'lightningOutsideShadowInvert'
          ]
        },
        {
          name: 'debug',
          label: 'Debug',
          type: 'folder',
          expanded: false,
          parameters: ['debugShowLightBuffer', 'debugLightBufferExposure', 'debugShowDarknessBuffer', 'debugShowRopeMask']
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIllumination: { type: 'slider', min: 0, max: 2, step: 0.1, default: 2.0 },
        lightIntensity: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.5, label: 'Light Intensity' },
        colorationStrength: { type: 'slider', min: 0, max: 500, step: 0.05, default: 3.0, label: 'Coloration Strength' },
        wallInsetPx: { type: 'slider', min: 0, max: 40, step: 0.5, default: 6.0, label: 'Wall Inset (px)' },
        darknessEffect: { type: 'slider', min: 0, max: 2, step: 0.05, default: 0.65, label: 'Darkness Effect' },
        outdoorBrightness: { type: 'slider', min: 0.5, max: 2.5, step: 0.05, default: 1.0, label: 'Outdoor Brightness' },
        lightningOutsideEnabled: { type: 'boolean', default: true, label: 'Enabled' },
        lightningOutsideGain: { type: 'slider', min: 0, max: 3, step: 0.05, default: 1.25, label: 'Flash Gain' },
        lightningOutsideShadowEnabled: { type: 'boolean', default: true, label: 'Edge Shadows' },
        lightningOutsideShadowStrength: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.75, label: 'Shadow Strength' },
        lightningOutsideShadowRadiusPx: { type: 'slider', min: 0, max: 2500, step: 10, default: 520.0, label: 'Shadow Radius (px)' },
        lightningOutsideShadowEdgeGain: { type: 'slider', min: 0, max: 25, step: 0.25, default: 6.0, label: 'Edge Gain' },
        lightningOutsideShadowInvert: { type: 'boolean', default: false, label: 'Invert Side' },
        negativeDarknessStrength: { type: 'slider', min: 0, max: 3, step: 0.1, default: 1.0, label: 'Negative Darkness Strength' },
        darknessPunchGain: { type: 'slider', min: 0, max: 10, step: 0.1, default: 2.0, label: 'Darkness Punch Gain' },
        debugShowLightBuffer: { type: 'boolean', default: false },
        debugLightBufferExposure: { type: 'number', default: 1.0 },
        debugShowDarknessBuffer: { type: 'boolean', default: false },
        debugShowRopeMask: { type: 'boolean', default: false },
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    this.renderer = renderer;
    this.mainCamera = camera;

    if (!this._transparentTex) {
      const data = new Uint8Array([0, 0, 0, 0]);
      this._transparentTex = new THREE.DataTexture(data, 1, 1);
      this._transparentTex.needsUpdate = true;
    }

    this.lightScene = new THREE.Scene();
    this.lightScene.background = new THREE.Color(0x000000); 

    this.darknessScene = new THREE.Scene();
    this.darknessScene.background = new THREE.Color(0x000000);

    this.outdoorsScene = new THREE.Scene();

    this._rebuildOutdoorsProjection();

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._masksPackScene = new THREE.Scene();
    this._masksPackCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._masksPackMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tRoofAlpha: { value: null },
        tRopeMask: { value: null },
        tOutdoorsMask: { value: null },
        tTokenMask: { value: null },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tRoofAlpha;
        uniform sampler2D tRopeMask;
        uniform sampler2D tOutdoorsMask;
        uniform sampler2D tTokenMask;
        varying vec2 vUv;

        void main() {
          float roofA = texture2D(tRoofAlpha, vUv).a;
          float ropeA = texture2D(tRopeMask, vUv).a;
          float outdoorsR = texture2D(tOutdoorsMask, vUv).r;
          float tokenA = texture2D(tTokenMask, vUv).a;
          gl_FragColor = vec4(outdoorsR, ropeA, tokenA, roofA);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, 
        tLight: { value: null },   
        tDarkness: { value: null }, 
        tMasks: { value: null },
        tWindowLight: { value: null },
        tOverheadShadow: { value: null }, 
        tBuildingShadow: { value: null }, 
        tBushShadow: { value: null }, 
        tTreeShadow: { value: null }, 
        tCloudShadow: { value: null }, 
        tCloudTop: { value: null }, 
        uHasWindowLight: { value: 0.0 },
        uRopeWindowLightBoost: { value: 0.0 },
        uDarknessLevel: { value: 0.0 },
        uAmbientBrightest: { value: new THREE.Color(1,1,1) },
        uAmbientDarkness: { value: new THREE.Color(0.1, 0.1, 0.2) },
        uGlobalIllumination: { value: 1.0 },
        uLightIntensity: { value: 1.0 },
        uColorationStrength: { value: 1.35 },
        uOverheadShadowOpacity: { value: 0.0 },
        uOverheadShadowAffectsLights: { value: 0.75 },
        uBuildingShadowOpacity: { value: 0.0 },
        uBushShadowOpacity: { value: 0.0 },
        uTreeShadowOpacity: { value: 0.0 },
        uTreeSelfShadowStrength: { value: 1.0 },
        uCloudShadowOpacity: { value: 0.0 },
        uShadowSunDir: { value: new THREE.Vector2(0, 1) },
        uShadowZoom: { value: 1.0 },
        uBushShadowLength: { value: 0.04 },
        uTreeShadowLength: { value: 0.08 },
        uCompositeTexelSize: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        uViewportHeight: { value: 1024.0 },
        uOutdoorBrightness: { value: 1.5 },
        uLightningFlash01: { value: 0.0 },
        uLightningOutsideGain: { value: 1.25 },
        uLightningStrikeUv: { value: new THREE.Vector2(0.5, 0.5) },
        uLightningStrikeDir: { value: new THREE.Vector2(0.0, -1.0) },
        uLightningShadowEnabled: { value: 1.0 },
        uLightningShadowStrength: { value: 0.75 },
        uLightningShadowRadiusPx: { value: 520.0 },
        uLightningShadowEdgeGain: { value: 6.0 },
        uLightningShadowInvert: { value: 0.0 },
        uNegativeDarknessStrength: { value: 1.0 },
        uDarknessPunchGain: { value: 2.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform sampler2D tLight;
        uniform sampler2D tDarkness;
        uniform sampler2D tMasks;
        uniform sampler2D tWindowLight;
        uniform sampler2D tOverheadShadow;
        uniform sampler2D tBuildingShadow;
        uniform sampler2D tBushShadow;
        uniform sampler2D tTreeShadow;
        uniform sampler2D tCloudShadow;
        uniform sampler2D tCloudTop;
        uniform float uHasWindowLight;
        uniform float uRopeWindowLightBoost;
        uniform float uDarknessLevel;
        uniform vec3 uAmbientBrightest;
        uniform vec3 uAmbientDarkness;
        uniform float uGlobalIllumination;
        uniform float uLightIntensity;
        uniform float uColorationStrength;
        uniform float uOverheadShadowOpacity;
        uniform float uOverheadShadowAffectsLights;
        uniform float uBuildingShadowOpacity;
        uniform float uBushShadowOpacity;
        uniform float uTreeShadowOpacity;
        uniform float uTreeSelfShadowStrength;
        uniform float uCloudShadowOpacity;
        uniform vec2  uShadowSunDir;
        uniform float uShadowZoom;
        uniform float uBushShadowLength;
        uniform float uTreeShadowLength;
        uniform vec2  uCompositeTexelSize;
        uniform float uViewportHeight;
        uniform float uOutdoorBrightness;
        uniform float uLightningFlash01;
        uniform float uLightningOutsideGain;
        uniform vec2  uLightningStrikeUv;
        uniform vec2  uLightningStrikeDir;
        uniform float uLightningShadowEnabled;
        uniform float uLightningShadowStrength;
        uniform float uLightningShadowRadiusPx;
        uniform float uLightningShadowEdgeGain;
        uniform float uLightningShadowInvert;
        uniform float uNegativeDarknessStrength;
        uniform float uDarknessPunchGain;
        varying vec2 vUv;

        float perceivedBrightness(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

        float msSaturate(float x) { return clamp(x, 0.0, 1.0); }

        void main() {
          vec4 baseColor = texture2D(tDiffuse, vUv);
          vec4 lightSample = texture2D(tLight, vUv);
          float darknessMask = clamp(texture2D(tDarkness, vUv).r, 0.0, 1.0);

          vec4 masks = texture2D(tMasks, vUv);
          float outdoorStrengthBase = clamp(masks.r, 0.0, 1.0);
          float ropeMask = clamp(masks.g, 0.0, 1.0);
          float tokenMask = clamp(masks.b, 0.0, 1.0);
          float roofAlphaRaw = clamp(masks.a, 0.0, 1.0);

          float master = max(uLightIntensity, 0.0);
          float baseDarknessLevel = clamp(uDarknessLevel, 0.0, 1.0);
          vec3 ambientDay = uAmbientBrightest * max(uGlobalIllumination, 0.0);
          vec3 ambientNight = uAmbientDarkness * max(uGlobalIllumination, 0.0);
          vec3 ambient = mix(ambientDay, ambientNight, baseDarknessLevel);

          float roofAlpha = roofAlphaRaw * (1.0 - ropeMask);
          float lightVisibility = 1.0 - roofAlpha;

          float shadowTex = texture2D(tOverheadShadow, vUv).r;
          float shadowOpacity = clamp(uOverheadShadowOpacity, 0.0, 1.0);
          float rawShadowFactor = mix(1.0, shadowTex, shadowOpacity);

          float buildingTex = texture2D(tBuildingShadow, vUv).r;
          float buildingOpacity = clamp(uBuildingShadowOpacity, 0.0, 1.0);
          float rawBuildingFactor = mix(1.0, buildingTex, buildingOpacity);

          vec2 bushDir = normalize(uShadowSunDir);
          float bushPixelLen = uBushShadowLength * max(uViewportHeight, 1.0) * max(uShadowZoom, 0.0001);
          vec2 bushOffsetUv = bushDir * bushPixelLen * uCompositeTexelSize;
          float bushTex = texture2D(tBushShadow, vUv + bushOffsetUv).r;
          float bushOpacity = clamp(uBushShadowOpacity, 0.0, 1.0);
          float rawBushFactor = mix(1.0, bushTex, bushOpacity);

          float treePixelLen = uTreeShadowLength * max(uViewportHeight, 1.0) * max(uShadowZoom, 0.0001);
          vec2 treeOffsetUv = bushDir * treePixelLen * uCompositeTexelSize;
          float treeTex = texture2D(tTreeShadow, vUv + treeOffsetUv).r;
          float treeOpacity = clamp(uTreeShadowOpacity, 0.0, 1.0);
          float rawTreeFactor = mix(1.0, treeTex, treeOpacity);

          float cloudTex = texture2D(tCloudShadow, vUv).r;
          float cloudOpacity = clamp(uCloudShadowOpacity, 0.0, 1.0);
          float cloudFactor = mix(1.0, cloudTex, cloudOpacity);

          float shadowFactor = mix(rawShadowFactor, 1.0, roofAlphaRaw);
          float buildingFactor = mix(rawBuildingFactor, 1.0, roofAlphaRaw);
          float bushFactor = mix(rawBushFactor, 1.0, roofAlphaRaw);
          float treeFactor = rawTreeFactor;

          float outdoorStrength = max(outdoorStrengthBase, roofAlphaRaw);
          shadowFactor = mix(1.0, shadowFactor, outdoorStrength);
          buildingFactor = mix(1.0, buildingFactor, outdoorStrength);
          bushFactor = mix(1.0, bushFactor, outdoorStrength);
          treeFactor = mix(1.0, treeFactor, outdoorStrength);

          float combinedShadowFactor = shadowFactor * buildingFactor * bushFactor * treeFactor * cloudFactor;

          float kd = clamp(uOverheadShadowAffectsLights, 0.0, 1.0);
          vec3 shadedAmbient = ambient * combinedShadowFactor;

          vec3 baseLights = lightSample.rgb * lightVisibility * (1.0 - ropeMask);
          bool badLight = (baseLights.r != baseLights.r) || (baseLights.g != baseLights.g) || (baseLights.b != baseLights.b);
          if (badLight) {
            baseLights = vec3(0.0);
          }

          vec3 shadedLights = mix(baseLights, baseLights * combinedShadowFactor, kd);

          vec3 windowLightIllum = vec3(0.0);
          if (uHasWindowLight > 0.5) {
            windowLightIllum = texture2D(tWindowLight, vUv).rgb;
          }

          vec3 safeLights = max(shadedLights, vec3(0.0));
          float lightI = max(max(safeLights.r, safeLights.g), safeLights.b);

          vec3 totalIllumination = shadedAmbient + vec3(lightI) * master;

          float dMask = clamp(darknessMask, 0.0, 1.0);
          float lightTermI = max(lightI * master, 0.0);
          float punch = 1.0 - exp(-lightTermI * max(uDarknessPunchGain, 0.0));

          float localDarknessLevel = clamp(baseDarknessLevel * (1.0 - punch * max(uNegativeDarknessStrength, 0.0)), 0.0, 1.0);
          vec3 shadedAmbientPunched = mix(ambientDay, ambientNight, localDarknessLevel) * combinedShadowFactor;

          // Treat window light as an ambient-like illumination term, shaded by the
          // same overhead/bush/tree/building/cloud factors.
          shadedAmbientPunched += windowLightIllum * combinedShadowFactor;

          float punchedMask = clamp(dMask - punch * max(uNegativeDarknessStrength, 0.0), 0.0, 1.0);

          vec3 ambientAfterDark = shadedAmbientPunched * (1.0 - punchedMask);
          totalIllumination = ambientAfterDark + vec3(lightI) * master;

          bool badIllum = (totalIllumination.r != totalIllumination.r) ||
                          (totalIllumination.g != totalIllumination.g) ||
                          (totalIllumination.b != totalIllumination.b);
          if (badIllum) {
            totalIllumination = ambient;
          }

          vec3 minIllum = mix(ambientDay, ambientNight, localDarknessLevel) * 0.1;
          totalIllumination = max(totalIllumination, minIllum);

          vec3 litColor = baseColor.rgb * totalIllumination;

          float reflection = perceivedBrightness(baseColor.rgb);
          vec3 coloration = safeLights * master * reflection * max(uColorationStrength, 0.0);
          litColor += coloration;

          // Optional rope boost: apply window lighting as illumination (albedo * light)
          // instead of additive-on-top, to preserve saturation.
          if (uHasWindowLight > 0.5 && uRopeWindowLightBoost > 0.0001 && ropeMask > 0.001) {
            float ropeLuma = perceivedBrightness(baseColor.rgb);
            float ropeGate = smoothstep(0.25, 0.6, ropeLuma);
            vec3 ropeWindowIllum = windowLightIllum * max(uRopeWindowLightBoost, 0.0) * ropeMask * ropeGate;
            litColor += baseColor.rgb * ropeWindowIllum;
          }

          float dayBoost = uOutdoorBrightness;
          float nightDim = clamp(2.0 - uOutdoorBrightness, 0.0, 1.0);
          float outdoorMultiplier = mix(dayBoost, nightDim, uDarknessLevel);

          float flash01 = msSaturate(uLightningFlash01);
          float flashGain = max(uLightningOutsideGain, 0.0);

          float shadow = 0.0;
          if (flash01 > 0.0001 && uLightningShadowEnabled > 0.5) {
            vec2 ts = max(uCompositeTexelSize, vec2(1.0 / 4096.0));
            vec2 suv = clamp(uLightningStrikeUv, vec2(0.001), vec2(0.999));

            float sx1 = texture2D(tMasks, clamp(suv + vec2(ts.x, 0.0), vec2(0.001), vec2(0.999))).r;
            float sx0 = texture2D(tMasks, clamp(suv - vec2(ts.x, 0.0), vec2(0.001), vec2(0.999))).r;
            float sy1 = texture2D(tMasks, clamp(suv + vec2(0.0, ts.y), vec2(0.001), vec2(0.999))).r;
            float sy0 = texture2D(tMasks, clamp(suv - vec2(0.0, ts.y), vec2(0.001), vec2(0.999))).r;

            vec2 grad = vec2(sx1 - sx0, sy1 - sy0);
            float gl2 = dot(grad, grad);
            vec2 edgeN = (gl2 > 1e-6) ? (grad * inversesqrt(gl2)) : vec2(0.0, 1.0);

            vec2 dir = uLightningStrikeDir;
            float dl2 = dot(dir, dir);
            dir = (dl2 > 1e-6) ? (dir * inversesqrt(dl2)) : vec2(0.0, -1.0);

            float sideSign = (dot(edgeN, dir) >= 0.0) ? 1.0 : -1.0;
            sideSign = mix(sideSign, -sideSign, step(0.5, uLightningShadowInvert));

            float plane = sideSign * dot(edgeN, (vUv - suv));
            float halfPlane = step(0.0, plane);

            float edgeStrength = msSaturate(sqrt(gl2) * max(uLightningShadowEdgeGain, 0.0));

            vec2 dv = (vUv - suv);
            float distPx = length(dv / ts);
            float radius = max(uLightningShadowRadiusPx, 0.0);
            float distFactor = (radius > 0.5) ? (1.0 - smoothstep(0.0, radius, distPx)) : 1.0;

            shadow = halfPlane * edgeStrength * distFactor * msSaturate(uLightningShadowStrength);
          }

          outdoorMultiplier *= (1.0 + flash01 * flashGain * (1.0 - shadow));
          float finalMultiplier = mix(1.0, outdoorMultiplier, outdoorStrength);
          litColor *= finalMultiplier;

          vec4 cloudTop = texture2D(tCloudTop, vUv);
          vec3 cloudRgb = cloudTop.rgb;
          float cloudDark = mix(1.0, 0.25, clamp(uDarknessLevel, 0.0, 1.0));

          float cloudOutdoorMult = mix(1.0, outdoorMultiplier, outdoorStrength);
          cloudRgb *= cloudOutdoorMult;

          cloudRgb *= cloudDark;
          cloudRgb *= (1.0 - min(punchedMask * 2.0, 1.0));
          litColor = mix(litColor, cloudRgb, cloudTop.a);

          gl_FragColor = vec4(litColor, baseColor.a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });

    this.debugLightBufferMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tLight: { value: null },
        uExposure: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tLight;
        uniform float uExposure;
        varying vec2 vUv;

        vec3 reinhard(vec3 c) {
          return c / (c + 1.0);
        }

        void main() {
          vec3 c = texture2D(tLight, vUv).rgb * max(uExposure, 0.0);
          c = reinhard(max(c, vec3(0.0)));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });
    this.debugLightBufferMaterial.toneMapped = false;

    this.debugRopeMaskMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tRopeMask: { value: null },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tRopeMask;
        varying vec2 vUv;
        void main() {
          float m = texture2D(tRopeMask, vUv).a;
          gl_FragColor = vec4(m, m, m, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });
    this.debugRopeMaskMaterial.toneMapped = false;

    this.debugDarknessBufferMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDarkness: { value: null },
        uStrength: { value: 1.0 },
        tLight: { value: null },
        uGain: { value: 2.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDarkness;
        uniform float uStrength;
        uniform sampler2D tLight;
        uniform float uGain;
        varying vec2 vUv;

        void main() {
          float d = texture2D(tDarkness, vUv).r;
          vec3 lrgb = texture2D(tLight, vUv).rgb;
          float li = max(max(lrgb.r, lrgb.g), lrgb.b);
          float punch = 1.0 - exp(-max(li, 0.0) * max(uGain, 0.0));
          float punched = clamp(d - punch * max(uStrength, 0.0), 0.0, 1.0);
          // Diagnostic view:
          // R: final punched mask
          // G: original darkness mask
          // B: punch amount (from light buffer)
          gl_FragColor = vec4(punched, d, punch, 1.0);
        }
      `,
      depthWrite: false,
      depthTest: false,
      transparent: false,
    });
    this.debugDarknessBufferMaterial.toneMapped = false;

    this._quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.quadScene.add(this._quadMesh);

    this._masksPackMesh = new THREE.Mesh(this._quadMesh.geometry, this._masksPackMaterial);
    this._masksPackScene.add(this._masksPackMesh);

    // Hooks to Foundry
    Hooks.on('createAmbientLight', (doc) => this.onLightUpdate(doc));
    Hooks.on('updateAmbientLight', (doc, changes) => this.onLightUpdate(doc, changes));
    Hooks.on('deleteAmbientLight', (doc) => this.onLightDelete(doc));
    
    // Listen for lightingRefresh to rebuild any lights that were created before
    // Foundry computed their LOS polygons (fixes lights extending through walls
    // on initial creation/paste).
    Hooks.on('lightingRefresh', () => this.onLightingRefresh());
    
    // Initial Load
    this.syncAllLights();
  }

  _rebuildOutdoorsProjection() {
    const THREE = window.THREE;
    if (!THREE) return;

    if (this.outdoorsMesh && this.outdoorsScene) {
      this.outdoorsScene.remove(this.outdoorsMesh);
    }
    this.outdoorsMesh = null;
    this.outdoorsMaterial = null;

    if (!this.outdoorsScene || !this.outdoorsMask || !this._baseMesh) {
      return;
    }

    this.outdoorsMaterial = new THREE.MeshBasicMaterial({
      map: this.outdoorsMask,
      transparent: false,
      depthWrite: false,
      depthTest: false
    });

    this.outdoorsMesh = new THREE.Mesh(this._baseMesh.geometry, this.outdoorsMaterial);
    this.outdoorsMesh.position.copy(this._baseMesh.position);
    this.outdoorsMesh.rotation.copy(this._baseMesh.rotation);
    this.outdoorsMesh.scale.copy(this._baseMesh.scale);

    this.outdoorsScene.add(this.outdoorsMesh);
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (this.lightTarget) this.lightTarget.dispose();
    if (this.darknessTarget) this.darknessTarget.dispose();
    this.lightTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType // HDR capable
    });
  }

  setBaseMesh(baseMesh, assetBundle) {
    const THREE = window.THREE;
    if (!assetBundle || !assetBundle.masks) return;

    this._baseMesh = baseMesh;

    const outdoorsData = assetBundle.masks.find(m => m.id === 'outdoors');

    this.outdoorsMask = outdoorsData?.texture || null;

    this._rebuildOutdoorsProjection();
  }

  syncAllLights() {
    if (!canvas.lighting) return;
    this.lights.forEach(l => l.dispose());
    this.lights.clear();
    this.darknessSources.forEach(d => d.dispose());
    this.darknessSources.clear();
    canvas.lighting.placeables.forEach(p => this.onLightUpdate(p.document));
  }

  /**
   * Called when Foundry finishes computing LOS polygons for all lights.
   * Rebuilds any lights that were created before their LOS was available.
   */
  onLightingRefresh() {
    if (!canvas.lighting) return;

    this.lights.forEach((source) => {
      if (!source) return;
      if (!source._usingCircleFallback) return;

      try {
        // Force geometry rebuild now that LOS should be available.
        source.updateData(source.document, true);

        // Ensure the mesh is attached to the light scene.
        if (source.mesh && this.lightScene && !source.mesh.parent) {
          this.lightScene.add(source.mesh);
        }
      } catch (e) {
      }
    });
  }

  _mergeLightDocChanges(doc, changes) {
    if (!doc || !changes || typeof changes !== 'object') return doc;

    let base;
    try {
      base = (typeof doc.toObject === 'function') ? doc.toObject() : doc;
    } catch (_) {
      base = doc;
    }

    let expandedChanges = changes;
    try {
      const hasDotKeys = Object.keys(changes).some((k) => k.includes('.'));
      if (hasDotKeys && foundry?.utils?.expandObject) {
        expandedChanges = foundry.utils.expandObject(changes);
      }
    } catch (_) {
      expandedChanges = changes;
    }

    try {
      if (foundry?.utils?.mergeObject) {
        return foundry.utils.mergeObject(base, expandedChanges, {
          inplace: false,
          overwrite: true,
          recursive: true,
          insertKeys: true,
          insertValues: true
        });
      }
    } catch (_) {
    }

    const merged = { ...base, ...expandedChanges };
    if (base?.config || expandedChanges?.config) {
      merged.config = { ...(base?.config ?? {}), ...(expandedChanges?.config ?? {}) };
    }
    return merged;
  }

  onLightUpdate(doc, changes) {
    const targetDoc = this._mergeLightDocChanges(doc, changes);
    const isNegative = (targetDoc?.config?.negative === true) || (targetDoc?.negative === true);
    if (isNegative) {
      if (this.darknessSources.has(targetDoc.id)) {
        this.darknessSources.get(targetDoc.id).updateData(targetDoc);
      } else {
        const source = new ThreeDarknessSource(targetDoc);
        source.init();

        this.darknessSources.set(targetDoc.id, source);
        if (source.mesh && this.darknessScene) this.darknessScene.add(source.mesh);
      }

      if (this.lights.has(targetDoc.id)) {
        const source = this.lights.get(targetDoc.id);
        if (source?.mesh) this.lightScene?.remove(source.mesh);
        source?.dispose();
        this.lights.delete(targetDoc.id);
      }
      return;
    }

    if (this.darknessSources.has(targetDoc.id)) {
      const ds = this.darknessSources.get(targetDoc.id);
      if (ds?.mesh && this.darknessScene) this.darknessScene.remove(ds.mesh);
      ds?.dispose();
      this.darknessSources.delete(targetDoc.id);
    }

    if (this.lights.has(targetDoc.id)) {
      this.lights.get(targetDoc.id).updateData(targetDoc);
    } else {
      const source = new ThreeLightSource(targetDoc);
      source.init();
      this.lights.set(targetDoc.id, source);
      if (source.mesh) this.lightScene.add(source.mesh);
    }
  }

  onLightDelete(doc) {
    if (this.darknessSources.has(doc.id)) {
      const source = this.darknessSources.get(doc.id);
      if (source.mesh && this.darknessScene) this.darknessScene.remove(source.mesh);
      source.dispose();
      this.darknessSources.delete(doc.id);
    }

    if (this.lights.has(doc.id)) {
      const source = this.lights.get(doc.id);
      if (source.mesh) this.lightScene.remove(source.mesh);
      source.dispose();
      this.lights.delete(doc.id);
    }
  }

  getEffectiveDarkness() {
    let d = this.params?.darknessLevel;
    try {
      const env = canvas?.environment;
      if (env && typeof env.darknessLevel === 'number') {
        d = env.darknessLevel;
      }
    } catch (e) {
    }

    d = (typeof d === 'number' && isFinite(d)) ? d : 0.0;
    const scale = (typeof this.params?.darknessEffect === 'number' && isFinite(this.params.darknessEffect))
      ? this.params.darknessEffect
      : 1.0;

    const eff = Math.max(0.0, Math.min(1.0, d * scale));
    this._effectiveDarkness = eff;
    return eff;
  }

  update(timeInfo) {
    if (DISABLE_LIGHTING_EFFECT) return;
    if (!this.enabled) return;

    const THREE = window.THREE;

    const setThreeColorLoose = (target, input, fallback = 0xffffff) => {
      try {
        if (!target) return;
        if (input && typeof input === 'object' && 'r' in input && 'g' in input && 'b' in input) {
          target.set(input.r, input.g, input.b);
          return;
        }
        if (typeof input === 'string' || typeof input === 'number') {
          target.set(input);
          return;
        }
        target.set(fallback);
      } catch (e) {
        try {
          target.set(fallback);
        } catch (e2) {}
      }
    };

    // Sync Environment Data
    if (canvas.scene && canvas.environment) {
      this.params.darknessLevel = canvas.environment.darknessLevel;
      // (Ambient colors sync omitted here to keep this patch focused.)
    }

    // Update Animations for all lights
    this.lights.forEach(light => {
      light.updateAnimation(timeInfo, this.params.darknessLevel);
    });

    // Update Animations for all darkness sources
    this.darknessSources.forEach(ds => {
      ds.updateAnimation(timeInfo);
    });

    // Update Composite Uniforms
    const u = this.compositeMaterial.uniforms;
    u.uDarknessLevel.value = this.getEffectiveDarkness();
    u.uGlobalIllumination.value = this.params.globalIllumination;
    u.uLightIntensity.value = this.params.lightIntensity;
    u.uColorationStrength.value = this.params.colorationStrength;
    u.uOutdoorBrightness.value = this.params.outdoorBrightness;
    u.uNegativeDarknessStrength.value = this.params.negativeDarknessStrength;

    // Lightning outside flash (published by LightningEffect)
    try {
      const env = window.MapShine?.environment;
      const flash01 = (env && typeof env.lightningFlash01 === 'number' && Number.isFinite(env.lightningFlash01))
        ? Math.max(0.0, Math.min(1.0, env.lightningFlash01))
        : 0.0;

      const strikeUv = (env && env.lightningStrikeUv && typeof env.lightningStrikeUv === 'object')
        ? env.lightningStrikeUv
        : null;
      const strikeDir = (env && env.lightningStrikeDir && typeof env.lightningStrikeDir === 'object')
        ? env.lightningStrikeDir
        : null;

      const enabled = !!this.params.lightningOutsideEnabled;
      const gain = (typeof this.params.lightningOutsideGain === 'number' && Number.isFinite(this.params.lightningOutsideGain))
        ? Math.max(0.0, this.params.lightningOutsideGain)
        : 0.0;

      const shadowEnabled = !!this.params.lightningOutsideShadowEnabled;
      const shadowStrength = (typeof this.params.lightningOutsideShadowStrength === 'number' && Number.isFinite(this.params.lightningOutsideShadowStrength))
        ? Math.max(0.0, Math.min(1.0, this.params.lightningOutsideShadowStrength))
        : 0.0;
      const shadowRadiusPx = (typeof this.params.lightningOutsideShadowRadiusPx === 'number' && Number.isFinite(this.params.lightningOutsideShadowRadiusPx))
        ? Math.max(0.0, this.params.lightningOutsideShadowRadiusPx)
        : 0.0;
      const shadowEdgeGain = (typeof this.params.lightningOutsideShadowEdgeGain === 'number' && Number.isFinite(this.params.lightningOutsideShadowEdgeGain))
        ? Math.max(0.0, this.params.lightningOutsideShadowEdgeGain)
        : 0.0;
      const shadowInvert = !!this.params.lightningOutsideShadowInvert;

      if (u.uLightningFlash01) u.uLightningFlash01.value = enabled ? flash01 : 0.0;
      if (u.uLightningOutsideGain) u.uLightningOutsideGain.value = enabled ? gain : 0.0;

      if (u.uLightningStrikeUv?.value && strikeUv && typeof strikeUv.x === 'number' && typeof strikeUv.y === 'number') {
        u.uLightningStrikeUv.value.set(strikeUv.x, strikeUv.y);
      }

      if (u.uLightningStrikeDir?.value && strikeDir && typeof strikeDir.x === 'number' && typeof strikeDir.y === 'number') {
        u.uLightningStrikeDir.value.set(strikeDir.x, strikeDir.y);
      }

      if (u.uLightningShadowEnabled) u.uLightningShadowEnabled.value = (enabled && shadowEnabled) ? 1.0 : 0.0;
      if (u.uLightningShadowStrength) u.uLightningShadowStrength.value = shadowStrength;
      if (u.uLightningShadowRadiusPx) u.uLightningShadowRadiusPx.value = shadowRadiusPx;
      if (u.uLightningShadowEdgeGain) u.uLightningShadowEdgeGain.value = shadowEdgeGain;
      if (u.uLightningShadowInvert) u.uLightningShadowInvert.value = shadowInvert ? 1.0 : 0.0;
    } catch (e) {
      if (u.uLightningFlash01) u.uLightningFlash01.value = 0.0;
      if (u.uLightningOutsideGain) u.uLightningOutsideGain.value = 0.0;

      if (u.uLightningShadowEnabled) u.uLightningShadowEnabled.value = 0.0;
      if (u.uLightningShadowStrength) u.uLightningShadowStrength.value = 0.0;
      if (u.uLightningShadowRadiusPx) u.uLightningShadowRadiusPx.value = 0.0;
      if (u.uLightningShadowEdgeGain) u.uLightningShadowEdgeGain.value = 0.0;
      if (u.uLightningShadowInvert) u.uLightningShadowInvert.value = 0.0;
    }

    if (u.uDarknessPunchGain) {
      u.uDarknessPunchGain.value = this.params.darknessPunchGain;
    }

    if (this.debugDarknessBufferMaterial?.uniforms?.uStrength) {
      this.debugDarknessBufferMaterial.uniforms.uStrength.value = this.params.negativeDarknessStrength;
    }

    if (this.debugDarknessBufferMaterial?.uniforms?.uGain) {
      this.debugDarknessBufferMaterial.uniforms.uGain.value = this.params.darknessPunchGain;
    }

    try {
      const env = canvas?.environment;
      const setThreeColor = (target, src, def) => {
        try {
          if (!src) { target.set(def); return; }
          if (src instanceof THREE.Color) { target.copy(src); return; }
          if (src.rgb) { target.setRGB(src.rgb[0], src.rgb[1], src.rgb[2]); return; }
          if (Array.isArray(src)) { target.setRGB(src[0], src[1], src[2]); return; }
          target.set(src);
        } catch (e) {
          target.set(def);
        }
      };

      if (THREE && env?.colors && u.uAmbientBrightest?.value && u.uAmbientDarkness?.value) {
        setThreeColor(u.uAmbientBrightest.value, env.colors.ambientDaylight, 0xffffff);
        setThreeColor(u.uAmbientDarkness.value, env.colors.ambientDarkness, 0x242448);
      }
    } catch (e) {
    }

    // Drive overhead shadow uniforms from OverheadShadowsEffect (if present).
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      if (overhead && overhead.params && overhead.enabled && overhead.shadowTarget) {
        u.uOverheadShadowOpacity.value = overhead.params.opacity ?? 0.0;
        u.uOverheadShadowAffectsLights.value = overhead.params.affectsLights ?? 0.75;
      } else {
        // No active overhead shadows; disable effect in shader.
        u.uOverheadShadowOpacity.value = 0.0;
      }
    } catch (e) {
      u.uOverheadShadowOpacity.value = 0.0;
    }

    // Drive building shadow opacity from BuildingShadowsEffect (if present).
    try {
      const building = window.MapShine?.buildingShadowsEffect;
      if (building && building.params && building.enabled && building.shadowTarget) {
        const baseOpacity = building.params.opacity ?? 0.0;
        const ti = (typeof building.timeIntensity === 'number')
          ? THREE.MathUtils.clamp(building.timeIntensity, 0.0, 1.0)
          : 1.0;
        u.uBuildingShadowOpacity.value = baseOpacity * ti;
      } else {
        u.uBuildingShadowOpacity.value = 0.0;
      }
    } catch (e) {
      u.uBuildingShadowOpacity.value = 0.0;
    }

    // Drive bush shadow opacity and length from BushEffect (if present).
    try {
      const bush = window.MapShine?.bushEffect;
      if (bush && bush.params && bush.enabled && bush.shadowTarget) {
        const baseOpacity = bush.params.shadowOpacity ?? 0.0;
        u.uBushShadowOpacity.value = baseOpacity;
        if (typeof bush.params.shadowLength === 'number') {
          u.uBushShadowLength.value = bush.params.shadowLength;
        }
      } else {
        u.uBushShadowOpacity.value = 0.0;
      }
    } catch (e) {
      u.uBushShadowOpacity.value = 0.0;
    }

    // Drive tree shadow opacity, length, and self-shadow behavior from TreeEffect (if present).
    try {
      const tree = window.MapShine?.treeEffect;
      if (tree && tree.params && tree.enabled && tree.shadowTarget) {
        const baseOpacity = tree.params.shadowOpacity ?? 0.0;
        u.uTreeShadowOpacity.value = baseOpacity;
        if (typeof tree.params.shadowLength === 'number') {
          u.uTreeShadowLength.value = tree.params.shadowLength;
        }

        let selfStrength = 1.0;
        if (typeof tree.getHoverFade === 'function') {
          const f = tree.getHoverFade();
          if (typeof f === 'number' && isFinite(f)) {
            selfStrength = Math.max(0.0, Math.min(1.0, f));
          }
        }
        u.uTreeSelfShadowStrength.value = selfStrength;
      } else {
        u.uTreeShadowOpacity.value = 0.0;
        u.uTreeSelfShadowStrength.value = 1.0;
      }
    } catch (e) {
      u.uTreeShadowOpacity.value = 0.0;
      u.uTreeSelfShadowStrength.value = 1.0;
    }

    // --- Shared sun/zoom data for screen-space shadows (overhead, building, bush) ---
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      const THREE = window.THREE;

      if (overhead && overhead.sunDir && THREE) {
        u.uShadowSunDir.value.copy(overhead.sunDir);
      } else if (weatherController && THREE) {
        // Fallback: recompute sunDir from WeatherController.timeOfDay and
        // overhead sunLatitude, mirroring OverheadShadowsEffect logic.
        let hour = 12.0;
        try {
          if (typeof weatherController.timeOfDay === 'number') {
            hour = weatherController.timeOfDay;
          }
        } catch (e) {}

        const t = (hour % 24.0) / 24.0;
        const azimuth = (t - 0.5) * Math.PI;
        const lat = (overhead && overhead.params && typeof overhead.params.sunLatitude === 'number')
          ? THREE.MathUtils.clamp(overhead.params.sunLatitude, 0.0, 1.0)
          : 0.5;
        const x = -Math.sin(azimuth);
        const y = Math.cos(azimuth) * lat;
        u.uShadowSunDir.value.set(x, y);
      }

      // Zoom factor - works with both OrthographicCamera and PerspectiveCamera
      if (this.mainCamera) {
        u.uShadowZoom.value = this._getEffectiveZoom();
      }
    } catch (e) {
      // keep previous values
    }
  }

  render(renderer, scene, camera) {
    if (DISABLE_LIGHTING_EFFECT) return;
    if (!this.enabled) return;

    const THREE = window.THREE;

    // Ensure we have a light accumulation target that matches the current
    // drawing buffer size. This avoids a black screen if onResize has not
    // been called yet.
    // PERFORMANCE: Reuse Vector2 instead of allocating every frame
    if (!this._tempSize) this._tempSize = new THREE.Vector2();
    const size = this._tempSize;
    renderer.getDrawingBufferSize(size);

    if (!this.lightTarget) {
      this.lightTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType // HDR capable
      });
    } else if (this.lightTarget.width !== size.x || this.lightTarget.height !== size.y) {
      this.lightTarget.setSize(size.x, size.y);
    }

    if (!this.darknessTarget) {
      this.darknessTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.darknessTarget.width !== size.x || this.darknessTarget.height !== size.y) {
      this.darknessTarget.setSize(size.x, size.y);
    }

    if (!this.roofAlphaTarget) {
      this.roofAlphaTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.roofAlphaTarget.width !== size.x || this.roofAlphaTarget.height !== size.y) {
      this.roofAlphaTarget.setSize(size.x, size.y);
    }

    if (!this.weatherRoofAlphaTarget) {
      this.weatherRoofAlphaTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.weatherRoofAlphaTarget.width !== size.x || this.weatherRoofAlphaTarget.height !== size.y) {
      this.weatherRoofAlphaTarget.setSize(size.x, size.y);
    }

    if (!this.ropeMaskTarget) {
      this.ropeMaskTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.ropeMaskTarget.width !== size.x || this.ropeMaskTarget.height !== size.y) {
      this.ropeMaskTarget.setSize(size.x, size.y);
    }

    if (!this.tokenMaskTarget) {
      this.tokenMaskTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.tokenMaskTarget.width !== size.x || this.tokenMaskTarget.height !== size.y) {
      this.tokenMaskTarget.setSize(size.x, size.y);
    }

    if (!this.masksTarget) {
      this.masksTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    } else if (this.masksTarget.width !== size.x || this.masksTarget.height !== size.y) {
      this.masksTarget.setSize(size.x, size.y);
    }

    const hasOutdoorsProjection = !!(this.outdoorsScene && this.outdoorsMesh && this.outdoorsMask);
    if (hasOutdoorsProjection) {
      if (!this.outdoorsTarget) {
        this.outdoorsTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.UnsignedByteType
        });
      } else if (this.outdoorsTarget.width !== size.x || this.outdoorsTarget.height !== size.y) {
        this.outdoorsTarget.setSize(size.x, size.y);
      }
    }

    try {
      const mm = window.MapShine?.maskManager;
      if (mm) {
        const roofTex = this.roofAlphaTarget?.texture;
        if (roofTex && roofTex !== this._publishedRoofAlphaTex) {
          this._publishedRoofAlphaTex = roofTex;
          mm.setTexture('roofAlpha.screen', roofTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.roofAlphaTarget?.width ?? null,
            height: this.roofAlphaTarget?.height ?? null
          });
        }

        const weatherRoofTex = this.weatherRoofAlphaTarget?.texture;
        if (weatherRoofTex && weatherRoofTex !== this._publishedWeatherRoofAlphaTex) {
          this._publishedWeatherRoofAlphaTex = weatherRoofTex;
          mm.setTexture('weatherRoofAlpha.screen', weatherRoofTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.weatherRoofAlphaTarget?.width ?? null,
            height: this.weatherRoofAlphaTarget?.height ?? null
          });
        }

        const ropeMaskTex = this.ropeMaskTarget?.texture;
        if (ropeMaskTex && ropeMaskTex !== this._publishedRopeMaskTex) {
          this._publishedRopeMaskTex = ropeMaskTex;
          mm.setTexture('ropeMask.screen', ropeMaskTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.ropeMaskTarget?.width ?? null,
            height: this.ropeMaskTarget?.height ?? null
          });
        }

        const tokenMaskTex = this.tokenMaskTarget?.texture;
        if (tokenMaskTex && tokenMaskTex !== this._publishedTokenMaskTex) {
          this._publishedTokenMaskTex = tokenMaskTex;
          mm.setTexture('tokenMask.screen', tokenMaskTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'a',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.tokenMaskTarget?.width ?? null,
            height: this.tokenMaskTarget?.height ?? null
          });
        }

        const outdoorsTex = this.outdoorsTarget?.texture;
        if (outdoorsTex && outdoorsTex !== this._publishedOutdoorsTex) {
          this._publishedOutdoorsTex = outdoorsTex;
          mm.setTexture('outdoors.screen', outdoorsTex, {
            space: 'screenUv',
            source: 'renderTarget',
            channels: 'r',
            uvFlipY: false,
            lifecycle: 'dynamicPerFrame',
            width: this.outdoorsTarget?.width ?? null,
            height: this.outdoorsTarget?.height ?? null
          });
        }
      }
    } catch (e) {
    }

    const ROOF_LAYER = 20;
    const WEATHER_ROOF_LAYER = 21;
    const TOKEN_MASK_LAYER = 26;
    const previousLayersMask = this.mainCamera.layers.mask;
    const previousTarget = renderer.getRenderTarget();

    this.mainCamera.layers.set(ROOF_LAYER);
    renderer.setRenderTarget(this.roofAlphaTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, this.mainCamera);

    this.mainCamera.layers.set(WEATHER_ROOF_LAYER);
    renderer.setRenderTarget(this.weatherRoofAlphaTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, this.mainCamera);

    this.mainCamera.layers.set(ROPE_MASK_LAYER);
    renderer.setRenderTarget(this.ropeMaskTarget);
    renderer.setClearColor(0x000000, 0);

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clear(true, true, true);

    renderer.render(scene, this.mainCamera);
    renderer.autoClear = prevAutoClear;

    this.mainCamera.layers.set(TOKEN_MASK_LAYER);
    renderer.setRenderTarget(this.tokenMaskTarget);
    renderer.setClearColor(0x000000, 0);

    const prevAutoClear2 = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clear(true, true, true);

    const _tmpEnabledTokenMaskLayer = this._tmpEnabledTokenMaskLayer || (this._tmpEnabledTokenMaskLayer = []);
    _tmpEnabledTokenMaskLayer.length = 0;

    try {
      const tokenManager = window.MapShine?.tokenManager;
      const tokenSprites = tokenManager?.tokenSprites;
      if (tokenSprites && typeof tokenSprites.values === 'function') {
        const tokenLayerMask = (1 << TOKEN_MASK_LAYER);
        for (const data of tokenSprites.values()) {
          const sprite = data?.sprite;
          if (!sprite?.layers) continue;
          const had = (sprite.layers.mask & tokenLayerMask) !== 0;
          if (!had) {
            sprite.layers.enable(TOKEN_MASK_LAYER);
            _tmpEnabledTokenMaskLayer.push(sprite);
          }
        }
      }

      const gl = renderer.getContext();
      const prevMask2 = gl.getParameter(gl.COLOR_WRITEMASK);
      try {
        gl.colorMask(false, false, false, false);
        renderer.render(scene, this.mainCamera);
      } finally {
        gl.colorMask(prevMask2[0], prevMask2[1], prevMask2[2], prevMask2[3]);
      }
    } catch (e) {
    } finally {
      try {
        for (let i = 0; i < _tmpEnabledTokenMaskLayer.length; i++) {
          _tmpEnabledTokenMaskLayer[i].layers.disable(TOKEN_MASK_LAYER);
        }
      } catch (e) {
      }
    }

    renderer.clear(true, false, false);
    renderer.render(scene, this.mainCamera);
    renderer.autoClear = prevAutoClear2;

    this.mainCamera.layers.mask = previousLayersMask;
    renderer.setRenderTarget(previousTarget);

    // into outdoorsTarget using the main camera. This produces a
    // screen-aligned outdoors factor we can safely sample with vUv in
    // the composite shader without introducing world-space pinning
    // errors.
    if (hasOutdoorsProjection && this.outdoorsTarget) {
      const prevTarget2 = renderer.getRenderTarget();
      renderer.setRenderTarget(this.outdoorsTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this.outdoorsScene, this.mainCamera);
      renderer.setRenderTarget(prevTarget2);
    }

    // 0.75 Pack single-channel masks into a single RGBA texture to reduce
    // sampler pressure in the composite shader.
    if (this.masksTarget && this._masksPackScene && this._masksPackCamera && this._masksPackMaterial) {
      const prevTargetPack = renderer.getRenderTarget();
      this._masksPackMaterial.uniforms.tRoofAlpha.value = this.roofAlphaTarget?.texture ?? this._transparentTex;
      this._masksPackMaterial.uniforms.tRopeMask.value = this.ropeMaskTarget?.texture ?? this._transparentTex;
      this._masksPackMaterial.uniforms.tTokenMask.value = this.tokenMaskTarget?.texture ?? this._transparentTex;
      this._masksPackMaterial.uniforms.tOutdoorsMask.value = (hasOutdoorsProjection && this.outdoorsTarget?.texture)
        ? this.outdoorsTarget.texture
        : this._transparentTex;

      renderer.setRenderTarget(this.masksTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(this._masksPackScene, this._masksPackCamera);
      renderer.setRenderTarget(prevTargetPack);
    }

    // 1. Accumulate Lights into lightTarget
    const oldTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.lightTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();

    if (this.lightScene && this.mainCamera) {
      const prevMask = this.mainCamera.layers.mask;
      try {
        // Render all light meshes regardless of layer configuration.
        this.mainCamera.layers.enableAll();
        renderer.render(this.lightScene, this.mainCamera);
      } finally {
        this.mainCamera.layers.mask = prevMask;
      }
    }

    // 1.5 Accumulate Darkness into darknessTarget
    renderer.setRenderTarget(this.darknessTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    if (this.darknessScene && this.mainCamera) {
      const prevMask2 = this.mainCamera.layers.mask;
      try {
        this.mainCamera.layers.enableAll();
        renderer.render(this.darknessScene, this.mainCamera);
      } finally {
        this.mainCamera.layers.mask = prevMask2;
      }
    }

    // 2. Composite: use lightTarget as tLight and roofAlphaTarget as tRoofAlpha.
    // Base scene texture comes from EffectComposer via setInputTexture(tDiffuse).
    const cu = this.compositeMaterial.uniforms;
    cu.tLight.value = this.lightTarget.texture;
    cu.tDarkness.value = this.darknessTarget.texture;
    cu.tMasks.value = this.masksTarget?.texture ?? this._transparentTex;
    cu.uViewportHeight.value = size.y;
    if (cu.uCompositeTexelSize?.value) {
      cu.uCompositeTexelSize.value.set(1 / Math.max(1, size.x), 1 / Math.max(1, size.y));
    }

    try {
      const wle = window.MapShine?.windowLightEffect;
      const tex = (wle && typeof wle.getLightTexture === 'function') ? wle.getLightTexture() : (wle?.lightTarget?.texture ?? null);
      cu.tWindowLight.value = tex || this._transparentTex;
      cu.uHasWindowLight.value = tex ? 1.0 : 0.0;
    } catch (_) {
      cu.tWindowLight.value = this._transparentTex;
      cu.uHasWindowLight.value = 0.0;
    }

    try {
      const ui = window.MapShine?.uiManager;
      const rb = ui?.ropeBehaviorDefaults;
      const ropeBoost = (rb && rb.rope && Number.isFinite(rb.rope.windowLightBoost)) ? rb.rope.windowLightBoost : 0.0;
      const chainBoost = (rb && rb.chain && Number.isFinite(rb.chain.windowLightBoost)) ? rb.chain.windowLightBoost : 0.0;
      cu.uRopeWindowLightBoost.value = Math.max(0.0, Math.max(ropeBoost, chainBoost));
    } catch (_) {
      cu.uRopeWindowLightBoost.value = 0.0;
    }

    // Bind overhead shadow texture if available.
    try {
      const overhead = window.MapShine?.overheadShadowsEffect;
      cu.tOverheadShadow.value = (overhead && overhead.shadowTarget)
        ? overhead.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tOverheadShadow.value = null;
    }

    // Bind building shadow texture if available.
    try {
      const building = window.MapShine?.buildingShadowsEffect;
      cu.tBuildingShadow.value = (building && building.shadowTarget)
        ? building.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tBuildingShadow.value = null;
    }

    // Bind bush shadow texture if available.
    try {
      const bush = window.MapShine?.bushEffect;
      cu.tBushShadow.value = (bush && bush.shadowTarget)
        ? bush.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tBushShadow.value = null;
    }

    // Bind tree shadow texture if available.
    try {
      const tree = window.MapShine?.treeEffect;
      cu.tTreeShadow.value = (tree && tree.shadowTarget)
        ? tree.shadowTarget.texture
        : null;
    } catch (e) {
      cu.tTreeShadow.value = null;
    }

    // Bind cloud shadow and cloud top textures if available.
    try {
      const cloud = window.MapShine?.cloudEffect;
      cu.tCloudShadow.value = (cloud && cloud.cloudShadowTarget)
        ? cloud.cloudShadowTarget.texture
        : null;
      cu.tCloudTop.value = this._transparentTex;
      // Drive cloud shadow opacity from CloudEffect params
      cu.uCloudShadowOpacity.value = (cloud && cloud.enabled && cloud.params)
        ? (cloud.params.shadowOpacity ?? 0.0)
        : 0.0;
    } catch (e) {
      cu.tCloudShadow.value = null;
      cu.tCloudTop.value = this._transparentTex;
      cu.uCloudShadowOpacity.value = 0.0;
    }

    renderer.setRenderTarget(oldTarget);

    if (this.params?.debugShowRopeMask && this._quadMesh && this.debugRopeMaskMaterial) {
      this.debugRopeMaskMaterial.uniforms.tRopeMask.value = this.ropeMaskTarget?.texture ?? null;
      this._quadMesh.material = this.debugRopeMaskMaterial;
    } else if (this.params?.debugShowLightBuffer && this._quadMesh && this.debugLightBufferMaterial) {
      this.debugLightBufferMaterial.uniforms.tLight.value = this.lightTarget.texture;
      this.debugLightBufferMaterial.uniforms.uExposure.value = this.params.debugLightBufferExposure ?? 1.0;
      this._quadMesh.material = this.debugLightBufferMaterial;
    } else if (this.params?.debugShowDarknessBuffer && this._quadMesh && this.debugDarknessBufferMaterial) {
      this.debugDarknessBufferMaterial.uniforms.tDarkness.value = this.darknessTarget.texture;
      this.debugDarknessBufferMaterial.uniforms.uStrength.value = this.params.negativeDarknessStrength ?? 1.0;
      this.debugDarknessBufferMaterial.uniforms.tLight.value = this.lightTarget.texture;
      this.debugDarknessBufferMaterial.uniforms.uGain.value = this.params.darknessPunchGain ?? 2.0;
      this._quadMesh.material = this.debugDarknessBufferMaterial;
    } else if (this._quadMesh) {
      this._quadMesh.material = this.compositeMaterial;
    }

    renderer.render(this.quadScene, this.quadCamera);
  }

  setInputTexture(texture) {
    if (this.compositeMaterial) {
      this.compositeMaterial.uniforms.tDiffuse.value = texture;
    }
  }
}