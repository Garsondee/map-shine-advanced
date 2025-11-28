/**
 * @fileoverview Lighting Effect
 * Implements dynamic lighting for the scene base plane and ground tiles
 * Uses Foundry VTT light source data to render lights in Three.js
 * @module effects/LightingEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';
import { weatherController } from '../core/WeatherController.js';

const log = createLogger('LightingEffect');

export class LightingEffect extends EffectBase {
  constructor() {
    super('lighting', RenderLayers.POST_PROCESSING, 'low');
    
    this.priority = 1; // Render immediately after base scene (before Bloom/ColorCorrection)
    this.alwaysRender = true;

    // Lighting parameters (UI-facing).
    this.params = {
      enabled: true,
      globalIntensity: 1.0,
      ambientColor: { r: 0.00, g: 0.00, b: 0.00 },
      
      // Advanced Scene Lighting Controls
      darknessBoost: 20.0,   // Multiplier for lights when in darkness
      ambientMix: 1.0,      // How much ambient color tints the lights
      lightSaturation: 1.0, // Saturation of the lights themselves
      contrast: 1.0,        // Contrast of the light map
      correction: 0.50,     // Final brightness multiplier for the light map
      coreBoost: 3.0,       // Extra boost for the inner bright core of lights
      falloffSoftness: 1.0  // Exponent on falloff curve ( <1 = softer, >1 = harder )
    };

    // Resources
    this.lights = new Map(); // Map<id, {data, uniformIndex}>
    this.maxLights = 64; // Maximum number of dynamic lights supported in shader
    
    // Internal scene for full-screen quad rendering
    this.quadScene = null;
    this.quadCamera = null;
    this.mesh = null;
    
    // Material/Shader management
    this.uniforms = null;
    
    // Roof Occlusion
    // PREFERRED PATTERN (for lighting vs. overhead tiles):
    // - Overhead tiles are rendered once into a dedicated "roof alpha" render
    //   target (screen-space RGBA, Layer 20 only).
    // - The _Outdoors mask from WeatherController (uRoofMap) is used to decide
    //   whether a light source is "indoor" (dark) or "outdoor" (bright).
    // - In the lighting shader we:
    //     * Reconstruct world-space XY for each shaded pixel from the camera
    //       view bounds.
    //     * Sample uRoofAlphaMap at the current pixel to get the composite roof
    //       opacity above the scene (opaque, semi-transparent, or fully hidden).
    //     * For each light, sample uRoofMap at the light's position to decide
    //       if it is indoors.
    //     * If a light is indoors, attenuate its contribution by (1 - roofAlpha)
    //       so opaque roof pixels block it completely, semi-transparent parts
    //       leak light, and hidden roofs allow full contribution.
    // - This keeps lighting behavior consistent with particle occlusion (rain,
    //   fire, etc.) while giving per-pixel control over how much light can pass
    //   through roofs.
    // New roof-aware lighting features should follow this pattern instead of
    // trying to cull lights on the CPU.
    this.roofAlphaTarget = null;
    this.ROOF_LAYER = 20;
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'lighting',
          label: 'Global Lighting',
          type: 'inline',
          parameters: ['globalIntensity', 'ambientColor']
        },
        {
          name: 'scene_lighting',
          label: 'Scene Lighting Adjustments',
          type: 'folder',
          expanded: true,
          parameters: [
            'darknessBoost',
            'ambientMix',
            'lightSaturation',
            'contrast',
            'correction',
            'coreBoost',
            'falloffSoftness'
          ]
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIntensity: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.0, label: 'Global Brightness' },
        ambientColor: { type: 'color', default: { r: 0.02, g: 0.02, b: 0.02 } },
        
        // New Controls
        darknessBoost: { type: 'slider', min: 1.0, max: 20.0, step: 0.1, default: 1.8, label: 'Darkness Punch' },
        ambientMix: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.0, label: 'Ambient Tint Mix' },
        lightSaturation: { type: 'slider', min: 0.0, max: 2.0, step: 0.1, default: 0.5, label: 'Light Saturation' },
        contrast: { type: 'slider', min: 0.5, max: 2.0, step: 0.01, default: 1.0, label: 'Light Map Contrast' },
        correction: { type: 'slider', min: 0.5, max: 2.0, step: 0.01, default: 1.26, label: 'Final Boost' },
        coreBoost: { type: 'slider', min: 0.0, max: 3.0, step: 0.05, default: 1.5, label: 'Core Boost' },
        falloffSoftness: { type: 'slider', min: 0.25, max: 4.0, step: 0.05, default: 4.0, label: 'Attenuation Softness' }
      }
    };
  }

  /**
   * Initialize the effect
   */
  initialize(renderer, scene, camera) {
    log.info('Initializing LightingEffect (Post-Process)');
    this.renderer = renderer;

    const THREE = window.THREE;

    // 1. Create internal scene for quad rendering
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // 2. Create Lighting Material
    this.material = this.createLightingMaterial();

    // 3. Create Quad
    const geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.quadScene.add(this.mesh);

    // Listen for light updates
    this.hookIdCreate = Hooks.on('createAmbientLight', (doc) => this.onLightCreated(doc));
    this.hookIdUpdate = Hooks.on('updateAmbientLight', (doc, changes) => this.onLightUpdated(doc, changes));
    this.hookIdDelete = Hooks.on('deleteAmbientLight', (doc) => this.onLightDeleted(doc));

    // Initial sync
    this.syncAllLights();
  }

  onResize(width, height) {
    if (this.roofAlphaTarget) {
      this.roofAlphaTarget.setSize(width, height);
    }
  }

  /**
   * Set the base mesh (Legacy - no longer needed for Post-Process, but kept for API compatibility if called)
   */
  setBaseMesh(mesh) {
    // No-op for screen-space lighting
  }

  createLightingMaterial() {
    const THREE = window.THREE;
    
    // Uniforms for N lights + Scene Context
    // NOTE: Roof occlusion uniforms mirror the shared _Outdoors pattern used
    // by WeatherParticles / FireSparksEffect, but here we:
    //   - Use uRoofMap + uSceneBounds to classify lights as indoor/outdoor.
    //   - Use uRoofAlphaMap (screen-space pass of overhead tiles) to compute
    //     how much roof opacity sits above each shaded pixel.
    // This combination lets us do per-pixel, per-light indoor lighting that
    // respects semi-transparent and hidden roofs.
    this.uniforms = {
      tDiffuse: { value: null }, // Input scene texture
      uViewOffset: { value: new THREE.Vector2() }, // Camera World Pos (Bottom-Left)
      uViewSize: { value: new THREE.Vector2() },   // Camera World View Size
      
      // Roof Occlusion Uniforms
      // uRoofMap       : World-space _Outdoors mask (dark = indoors, bright = outdoors)
      // uRoofAlphaMap  : Screen-space alpha of overhead tiles (Layer 20 pre-pass)
      // uSceneBounds   : (sceneX, sceneY, sceneWidth, sceneHeight) for mapping
      //                  world XY into 0..1 UVs when sampling uRoofMap.
      // uHasRoofMap    : Simple 0/1 gate so we can disable the mask entirely
      //                  when no _Outdoors texture is present.
      uRoofMap: { value: null },      // _Outdoors mask
      uRoofAlphaMap: { value: null }, // Real-time overhead tile alpha
      uSceneBounds: { value: new THREE.Vector4(0,0,1,1) }, // Scene bounds for UV mapping
      uHasRoofMap: { value: 0.0 },
      
      // Base ambient contribution
      ambientColor: { value: new THREE.Color(0.02, 0.02, 0.02) },
      globalIntensity: { value: 1.0 },
      uDarknessLevel: { value: 0.0 },
      
      // Advanced Tuning Uniforms
      uDarknessBoost: { value: 1.8 },
      uAmbientMix: { value: 0.0 },
      uLightSaturation: { value: 0.5 },
      uContrast: { value: 1.0 },
      uCorrection: { value: 1.26 },
      uCoreBoost: { value: 1.5 },
      uFalloffSoftness: { value: 4.0 },
      
      // Foundry ambient environment colors
      uAmbientDaylight: { value: new THREE.Color(1.0, 1.0, 1.0) },
      uAmbientDarkness: { value: new THREE.Color(0.14, 0.14, 0.28) },
      uAmbientBrightest: { value: new THREE.Color(1.0, 1.0, 1.0) },
      
      numLights: { value: 0 },
      lightPosition: { value: new Float32Array(this.maxLights * 3) }, // x,y,z flat array
      lightColor: { value: new Float32Array(this.maxLights * 3) },    // r,g,b flat array
      lightConfig: { value: new Float32Array(this.maxLights * 4) }    // radius, dim, attenuation, type
    };

    const vertexShader = `
      varying vec2 vUv;
      
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 1.0);
      }
    `;

    const fragmentShader = `
      #include <common>
      #include <dithering_pars_fragment>

      uniform sampler2D tDiffuse;
      uniform vec2 uViewOffset;
      uniform vec2 uViewSize;
      
      uniform sampler2D uRoofMap;
      uniform sampler2D uRoofAlphaMap;
      uniform vec4 uSceneBounds;
      uniform float uHasRoofMap;
      
      uniform vec3 ambientColor;
      uniform float globalIntensity;
      uniform float uDarknessLevel;
      
      uniform float uDarknessBoost;
      uniform float uAmbientMix;
      uniform float uLightSaturation;
      uniform float uContrast;
      uniform float uCorrection;
      uniform float uCoreBoost;
      uniform float uFalloffSoftness;
      
      uniform vec3 uAmbientDaylight;
      uniform vec3 uAmbientDarkness;
      uniform vec3 uAmbientBrightest;
      
      uniform int numLights;
      uniform vec3 lightPosition[${this.maxLights}];
      uniform vec3 lightColor[${this.maxLights}];
      uniform vec4 lightConfig[${this.maxLights}]; // radius, dim, attenuation, unused
      
      varying vec2 vUv;
      
      // Saturation helper
      vec3 adjustSaturation(vec3 color, float saturation) {
        float gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
        return mix(vec3(gray), color, saturation);
      }
      
      void main() {
        // Sample Base Color (Albedo)
        vec4 baseTexel = texture2D(tDiffuse, vUv);
        vec3 baseColor = baseTexel.rgb;
        
        // Reconstruct World Position
        // Simple linear mapping from UV to View Bounds
        vec2 worldPos = uViewOffset + (vUv * uViewSize);
        
        // ---------------------------------------------------------
        // Lighting Calculation (Foundry-like)
        // ---------------------------------------------------------

        float clampedDarkness = clamp(uDarknessLevel, 0.0, 1.0);
        vec3 ambientTint = mix(uAmbientDaylight, uAmbientDarkness, clampedDarkness);

        // Accumulate Dynamic Lights
        // We start at 0.0 because the Base Color already contains the ambient light.
        vec3 totalLight = vec3(0.0);
        
        // Pre-sample roof alpha at this pixel (Screen Space)
        // This is the composite opacity of all overhead tiles rendered in the
        // Roof Alpha Pass (see render()).
        float roofAlpha = texture2D(uRoofAlphaMap, vUv).a;
        
        for (int i = 0; i < ${this.maxLights}; i++) {
          if (i >= numLights) break;
          
          vec3 lPos = lightPosition[i];
          
          // Check if this light is Indoors (under a roof)
          // We sample the uRoofMap at the light's world position. Dark
          // (_Outdoors < 0.5) = Indoors, Bright (>= 0.5) = Outdoors.
          float isIndoor = 0.0;
          if (uHasRoofMap > 0.5) {
             // Map World Pos -> UV in the shared _Outdoors mask
             vec2 lUV = vec2(
               (lPos.x - uSceneBounds.x) / uSceneBounds.z,
               1.0 - (lPos.y - uSceneBounds.y) / uSceneBounds.w
             );
             // Sample bounds check
             if (lUV.x >= 0.0 && lUV.x <= 1.0 && lUV.y >= 0.0 && lUV.y <= 1.0) {
                // Dark (0) = Indoors, Bright (1) = Outdoors
                float outdoorVal = texture2D(uRoofMap, lUV).r;
                if (outdoorVal < 0.5) isIndoor = 1.0;
             } else {
                // Light is outside the scene bounds -> assume Outdoors
                isIndoor = 0.0;
             }
          }
          
          vec3 lColor = lightColor[i];
          float radius = lightConfig[i].x;
          float dim = lightConfig[i].y;
          float attenuation = lightConfig[i].z;
          
          float dist = distance(worldPos, lPos.xy);
          
          if (dist < radius) {
            float d = dist / radius;
            
            // Foundry Falloff
            float inner = (radius > 0.0) ? clamp(dim / radius, 0.0, 0.99) : 0.0;
            float falloff = 1.0 - smoothstep(inner, 1.0, d);
            
            float linear = 1.0 - d;
            float squared = 1.0 - d * d;
            float lightIntensity = mix(linear, squared, attenuation) * falloff;

            // Core Brightness Boost: amplify contribution near the center
            if (uCoreBoost > 0.0 && inner > 0.0) {
              float coreT = 1.0 - clamp(d / inner, 0.0, 1.0);
              float coreFactor = 1.0 + uCoreBoost * coreT * coreT;
              lightIntensity *= coreFactor;
            }
            
            // Dynamic Brightness Boost
            // As darkness increases, we need to boost the light multiplier significantly
            // because the base texture we are multiplying against is getting darker.
            float dynamicBoost = mix(1.0, uDarknessBoost, clampedDarkness);
            
            // Apply light saturation adjustment
            vec3 satColor = adjustSaturation(lColor, uLightSaturation);
            
            // Mix with ambient tint
            vec3 tintedLightColor = satColor * mix(vec3(1.0), ambientTint, uAmbientMix);

            // Apply Roof Occlusion for Indoor Lights
            // PREFERRED PATTERN (Lighting + Roofs):
            // - Light classification uses the world-space _Outdoors mask.
            // - Occlusion strength comes from the screen-space roof alpha.
            //   * roofAlpha = 1.0 (Opaque roof)     -> 100% blocked
            //   * roofAlpha = 0.0 (Hidden / no roof)-> 0% blocked
            //   * roofAlpha = 0.5 (Semi-transparent)-> 50% blocked
            // - Outdoor lights ignore roofAlpha entirely so roofs can still be
            //   lit from above by sun/moon or other external sources.
            if (isIndoor > 0.5) {
               float occlusion = roofAlpha;
               lightIntensity *= (1.0 - occlusion);
            }

            totalLight += tintedLightColor * lightIntensity * dynamicBoost;
          }
        }
        
        // Apply Light Map Contrast
        if (uContrast != 1.0) {
           totalLight = (totalLight - 0.5) * uContrast + 0.5;
           totalLight = max(vec3(0.0), totalLight); // Prevent negatives
        }

        // Apply Attenuation Softness (exponent on final falloff)
        if (uFalloffSoftness != 1.0) {
          vec3 eps = vec3(1e-4);
          totalLight = pow(max(totalLight, eps), vec3(uFalloffSoftness));
        }
        
        // Tone Mapping for the Light Map itself to prevent nuclear burnout
        // but allow it to go > 1.0 for the "punch".
        totalLight = totalLight / (vec3(1.0) + totalLight * 0.1);
        
        // Apply Final Correction Boost
        totalLight *= uCorrection;
        
        // Final Composition: "Adaptive Luminance" logic
        // The Base Color is already lit by Ambient.
        // We want to ADD the Dynamic Light contribution, but modulated by the Base Color (Texture).
        // Final = Base + (Base * Light)
        vec3 finalColor = baseColor + (baseColor * totalLight);
        
        gl_FragColor = vec4(finalColor, baseTexel.a);
      }
    `;

    return new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
      depthWrite: false,
      depthTest: false
    });
  }
  
  setInputTexture(texture) {
    if (this.material) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  render(renderer, scene, camera) {
    if (!this.enabled || !this.material || !this.material.uniforms.tDiffuse.value) return;

    const THREE = window.THREE;

    // -------------------------------------------------------
    // Roof Alpha Pass
    // Render overhead tiles (Layer 20) to an off-screen target
    // so we can sample their opacity in the lighting shader.
    // -------------------------------------------------------
    if (!this.roofAlphaTarget) {
      const size = new THREE.Vector2();
      renderer.getSize(size);
      this.roofAlphaTarget = new THREE.WebGLRenderTarget(size.x, size.y, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType
      });
    }
    
    // Save state
    const oldTarget = renderer.getRenderTarget();
    const oldClearAlpha = renderer.getClearAlpha();
    const oldClearColor = new THREE.Color();
    renderer.getClearColor(oldClearColor);
    
    // Setup Roof Pass
    renderer.setRenderTarget(this.roofAlphaTarget);
    renderer.setClearColor(0x000000, 0.0); // Transparent background
    renderer.clear();
    
    // Switch Camera Layers
    // We only want to see the ROOF_LAYER (20).
    // Standard layer (0) should be hidden for this pass.
    camera.layers.disable(0); 
    camera.layers.enable(this.ROOF_LAYER); 
    
    // Render Roofs
    renderer.render(scene, camera);
    
    // Restore Camera Layers
    camera.layers.disable(this.ROOF_LAYER);
    camera.layers.enable(0); 
    
    // Restore Renderer State
    renderer.setRenderTarget(oldTarget);
    renderer.setClearColor(oldClearColor, oldClearAlpha);
    
    // Bind Roof Alpha Map to Lighting Shader
    this.material.uniforms.uRoofAlphaMap.value = this.roofAlphaTarget.texture;

    // -------------------------------------------------------
    // Main Lighting Pass
    // -------------------------------------------------------

    // Calculate View Bounds for World Position Reconstruction
    if (camera && camera.isPerspectiveCamera) {
      // Calculate visible height at Z=0 (Ground Plane)
      // camera.position.z is height above ground (assuming ground is 0)
      // fov is vertical FOV in degrees
      const dist = Math.max(1, camera.position.z);
      const vFOV = THREE.MathUtils.degToRad(camera.fov);
      const visibleHeight = 2 * Math.tan(vFOV / 2) * dist;
      const visibleWidth = visibleHeight * camera.aspect;
      
      // Camera Position is center of view
      // Top-Left of view (which maps to UV 0,1? No, UV 0,0 is Bottom-Left in Three GLSL)
      // Bottom-Left World Pos:
      const cx = camera.position.x;
      const cy = camera.position.y;
      
      const left = cx - visibleWidth / 2;
      const bottom = cy - visibleHeight / 2;
      
      this.material.uniforms.uViewOffset.value.set(left, bottom);
      this.material.uniforms.uViewSize.value.set(visibleWidth, visibleHeight);
    }

    // Render Quad
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCamera);
    renderer.autoClear = oldAutoClear;
  }

  syncAllLights() {
    if (!canvas.lighting) return;
    
    this.lights.clear();
    
    // Get all ambient lights
    const lights = canvas.lighting.placeables;
    lights.forEach(light => {
      this.addLight(light.document);
    });
    
    this.updateLightUniforms();
  }

  addLight(doc) {
    if (this.lights.size >= this.maxLights) return;
    if (this.lights.has(doc.id)) return;
    
    const config = doc.config;
    if (!config) return;
    
    // Extract color
    let r = 1, g = 1, b = 1;
    const colorInput = config.color;
    
    if (colorInput) {
        try {
            // Handle Foundry Color object, hex string, or integer
            if (typeof colorInput === 'object' && colorInput.rgb) {
                r = colorInput.rgb[0];
                g = colorInput.rgb[1];
                b = colorInput.rgb[2];
            } else {
                // Fallback to Foundry's Color helper if available, otherwise robust parse
                const c = (typeof foundry !== 'undefined' && foundry.utils?.Color) 
                    ? foundry.utils.Color.from(colorInput)
                    : new THREE.Color(colorInput);
                    
                r = c.r;
                g = c.g;
                b = c.b;
            }
        } catch (e) {
            // Fallback to simple integer parsing if all else fails
            if (typeof colorInput === 'number') {
                r = ((colorInput >> 16) & 0xff) / 255;
                g = ((colorInput >> 8) & 0xff) / 255;
                b = (colorInput & 0xff) / 255;
            }
        }
    }
    
    // Extract intensity/brightness
    // Foundry luminosity: 0 = off, 0.5 = normal, 1 = bright
    // We map 0.5 -> 1.0 intensity.
    const luminosity = config.luminosity ?? 0.5;
    const intensity = luminosity * 2.0; 
    
    const dim = config.dim || 0;
    const bright = config.bright || 0;
    const radius = Math.max(dim, bright);
    
    if (radius === 0) return;
    
    // World position
    const worldPos = Coordinates.toWorld(doc.x, doc.y);
    
    this.lights.set(doc.id, {
      position: worldPos,
      color: { r: r * intensity, g: g * intensity, b: b * intensity }, // Scale color by intensity
      radius: radius,
      dim: dim,
      bright: bright,
      attenuation: config.attenuation ?? 0.5
    });
  }

  removeLight(id) {
    if (this.lights.delete(id)) {
      this.updateLightUniforms();
    }
  }

  onLightCreated(doc) {
    this.addLight(doc);
    this.updateLightUniforms();
  }

  onLightUpdated(doc, changes) {
    this.removeLight(doc.id);
    this.addLight(doc);
    this.updateLightUniforms();
  }

  onLightDeleted(doc) {
    this.removeLight(doc.id);
  }

  updateLightUniforms() {
    if (!this.uniforms) return;
    
    const lightsArray = Array.from(this.lights.values());
    const num = lightsArray.length;
    
    this.uniforms.numLights.value = num;
    
    // Update arrays
    // Float32Array doesn't have .set for objects, need manual fill
    for (let i = 0; i < num; i++) {
      const l = lightsArray[i];
      const i3 = i * 3;
      const i4 = i * 4;
      
      // Position
      this.uniforms.lightPosition.value[i3] = l.position.x;
      this.uniforms.lightPosition.value[i3 + 1] = l.position.y;
      this.uniforms.lightPosition.value[i3 + 2] = 0; // Z
      
      // Color
      this.uniforms.lightColor.value[i3] = l.color.r;
      this.uniforms.lightColor.value[i3 + 1] = l.color.g;
      this.uniforms.lightColor.value[i3 + 2] = l.color.b;
      
      // Config
      // Need to convert radius from grid units/pixels?
      // Foundry radius is in distance units (e.g. feet), usually need canvas.dimensions.distance conversion
      // But config.dim/bright on the document are usually in distance units?
      // Let's check how Lensflare did it.
      // Actually lensflare used bright/dim ratio.
      // We need pixel radius.
      
      // Canvas conversion
      const pixelsPerUnit = canvas.dimensions.size / canvas.dimensions.distance;
      const radiusPx = l.radius * pixelsPerUnit;
      const brightPx = l.bright * pixelsPerUnit;
      
      this.uniforms.lightConfig.value[i4] = radiusPx;
      this.uniforms.lightConfig.value[i4 + 1] = brightPx;
      this.uniforms.lightConfig.value[i4 + 2] = l.attenuation;
      this.uniforms.lightConfig.value[i4 + 3] = 0;
    }
  }

  update(timeInfo) {
    // If the effect is disabled, hide (or eventually dispose) the overlay mesh
    // but keep the light data around so a later re-enable is cheap.
    if (!this.enabled) {
      if (this.lightingMesh) this.lightingMesh.visible = false;
      return;
    }

    if (this.lightingMesh) {
      this.lightingMesh.visible = true;
    }

    if (this.uniforms) {
      const u = this.uniforms;
      const p = this.params || {};

      // Clamp UI/scene-driven parameters into a conservative range so Three.js
      // lighting stays in line with Foundry's native look even if older
      // scenes have very bright saved values.
      const rawGI = (typeof p.globalIntensity === 'number') ? p.globalIntensity : 0.8;
      const clampedGI = Math.max(0.1, Math.min(rawGI, 0.9));
      u.globalIntensity.value = clampedGI;

      // Update Roof Uniforms
      if (weatherController && weatherController.roofMap) {
        u.uRoofMap.value = weatherController.roofMap;
        u.uHasRoofMap.value = 1.0;
      } else {
        u.uRoofMap.value = null;
        u.uHasRoofMap.value = 0.0;
      }

      if (canvas && canvas.dimensions) {
        const d = canvas.dimensions;
        u.uSceneBounds.value.set(d.sceneX, d.sceneY, d.sceneWidth, d.sceneHeight);
      }

      const ac = p.ambientColor || { r: 0.02, g: 0.02, b: 0.02 };
      const ar = Math.max(0.0, Math.min(ac.r ?? 0.02, 0.06));
      const ag = Math.max(0.0, Math.min(ac.g ?? 0.02, 0.06));
      const ab = Math.max(0.0, Math.min(ac.b ?? 0.02, 0.06));
      u.ambientColor.value.setRGB(ar, ag, ab);

      // Sync Advanced Controls
      if (typeof p.darknessBoost === 'number') u.uDarknessBoost.value = p.darknessBoost;
      if (typeof p.ambientMix === 'number') u.uAmbientMix.value = p.ambientMix;
      if (typeof p.lightSaturation === 'number') u.uLightSaturation.value = p.lightSaturation;
      if (typeof p.contrast === 'number') u.uContrast.value = p.contrast;
      if (typeof p.correction === 'number') u.uCorrection.value = p.correction;
      if (typeof p.coreBoost === 'number') u.uCoreBoost.value = p.coreBoost;
      if (typeof p.falloffSoftness === 'number') u.uFalloffSoftness.value = p.falloffSoftness;

      // Drive darkness and ambient environment colors from Foundry's canvas
      // when available so lighting tracks the same environment used by PIXI.
      try {
        const scene = canvas?.scene;
        const env = canvas?.environment;
        if (scene?.environment?.darknessLevel !== undefined) {
          u.uDarknessLevel.value = scene.environment.darknessLevel;
        }

        const colors = env?.colors;
        if (colors) {
          const applyColor = (src, targetColor) => {
            if (!src || !targetColor) return;
            let r = 1, g = 1, b = 1;
            try {
              if (Array.isArray(src)) {
                r = src[0] ?? 1; g = src[1] ?? 1; b = src[2] ?? 1;
              } else if (typeof src.r === 'number' && typeof src.g === 'number' && typeof src.b === 'number') {
                r = src.r; g = src.g; b = src.b;
              } else if (typeof src.toArray === 'function') {
                const arr = src.toArray();
                r = arr[0] ?? 1; g = arr[1] ?? 1; b = arr[2] ?? 1;
              }
            } catch (e) {
              // Keep defaults on failure.
            }
            targetColor.setRGB(r, g, b);
          };

          applyColor(colors.ambientDaylight,  u.uAmbientDaylight.value);
          applyColor(colors.ambientDarkness,  u.uAmbientDarkness.value);
          applyColor(colors.ambientBrightest, u.uAmbientBrightest.value);
        }
      } catch (e) {
        // If canvas or environment are not ready, keep previous values.
      }
    }
  }
}
