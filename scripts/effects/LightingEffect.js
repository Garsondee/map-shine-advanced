/**
 * @fileoverview Lighting Effect
 * Implements dynamic lighting for the scene base plane.
 * Replaces Foundry's PIXI lighting with a multipass Three.js approach.
 * @module effects/LightingEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { ThreeLightSource } from './ThreeLightSource.js'; // Import the class above

const log = createLogger('LightingEffect');

export class LightingEffect extends EffectBase {
  constructor() {
    super('lighting', RenderLayers.POST_PROCESSING, 'low');
    
    this.priority = 1; 
    
    // UI Parameters matching Foundry VTT + Custom Tweaks
    this.params = {
      enabled: true,
      globalIllumination: 1.0, // Multiplier for ambient
      exposure: 0.0,
      saturation: 1.0,
      contrast: 1.0,
      darknessLevel: 0.0, // Read-only mostly, synced from canvas
    };

    this.lights = new Map(); // Map<id, ThreeLightSource>
    
    // THREE resources
    this.lightScene = null;  // Scene for Light Accumulation
    this.lightTarget = null; // Buffer for Light Accumulation
    this.quadScene = null;   // Scene for Final Composite
    this.quadCamera = null;
    this.compositeMaterial = null;
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
           name: 'correction',
           label: 'Color Correction',
           type: 'inline',
           parameters: ['exposure', 'saturation', 'contrast']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIllumination: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.0 },
        exposure: { type: 'slider', min: -1, max: 1, step: 0.1, default: 0.0 },
        saturation: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.0 },
        contrast: { type: 'slider', min: 0.5, max: 1.5, step: 0.05, default: 1.0 },
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    this.renderer = renderer;
    this.mainCamera = camera;

    // 1. Light Accumulation Setup
    this.lightScene = new THREE.Scene();
    // Use black background for additive light accumulation
    this.lightScene.background = new THREE.Color(0x000000); 

    // 2. Final Composite Quad
    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    // The Composite Shader (Combines Diffuse + Light + Color Correction)
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, // Base Scene
        tLight: { value: null },   // Accumulated HDR Light
        uDarknessLevel: { value: 0.0 },
        uAmbientBrightest: { value: new THREE.Color(1,1,1) },
        uAmbientDarkness: { value: new THREE.Color(0.1, 0.1, 0.2) },
        
        // Post-process settings
        uExposure: { value: 0.0 },
        uSaturation: { value: 1.0 },
        uContrast: { value: 1.0 }
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
        uniform float uDarknessLevel;
        uniform vec3 uAmbientBrightest;
        uniform vec3 uAmbientDarkness;
        
        uniform float uExposure;
        uniform float uSaturation;
        uniform float uContrast;
        
        varying vec2 vUv;

        vec3 adjustSaturation(vec3 color, float value) {
          vec3 gray = vec3(dot(color, vec3(0.2126, 0.7152, 0.0722)));
          return mix(gray, color, value);
        }

        void main() {
          vec4 baseColor = texture2D(tDiffuse, vUv);
          vec4 lightSample = texture2D(tLight, vUv); // HDR light buffer
          
          // 1. Determine Ambient Light
          vec3 ambient = mix(uAmbientBrightest, uAmbientDarkness, uDarknessLevel);
          
          // 2. Combine Ambient with Accumulated Lights
          vec3 totalIllumination = ambient + lightSample.rgb;
          
          // 3. Apply to Base Texture (Multiply)
          vec3 finalRGB = baseColor.rgb * totalIllumination;

          // --- POST PROCESSING ---

          // Exposure
          finalRGB *= pow(2.0, uExposure);

          // Contrast
          finalRGB = (finalRGB - 0.5) * uContrast + 0.5;

          // Saturation
          finalRGB = adjustSaturation(finalRGB, uSaturation);

          gl_FragColor = vec4(finalRGB, baseColor.a);
        }
      `
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.compositeMaterial);
    this.quadScene.add(quad);

    // Hooks to Foundry
    Hooks.on('createAmbientLight', (doc) => this.onLightUpdate(doc));
    Hooks.on('updateAmbientLight', (doc) => this.onLightUpdate(doc));
    Hooks.on('deleteAmbientLight', (doc) => this.onLightDelete(doc));
    
    // Initial Load
    this.syncAllLights();
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (this.lightTarget) this.lightTarget.dispose();
    this.lightTarget = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType // HDR capable
    });
  }

  // Kept for API compatibility with canvas-replacement, but unused in the
  // current screen-space post-process implementation.
  setBaseMesh(_mesh) {
    // No-op: Lighting is computed in screen space from tDiffuse and tLight.
  }

  syncAllLights() {
    if (!canvas.lighting) return;
    this.lights.forEach(l => l.dispose());
    this.lights.clear();
    canvas.lighting.placeables.forEach(p => this.onLightUpdate(p.document));
  }

  onLightUpdate(doc) {
    if (this.lights.has(doc.id)) {
      this.lights.get(doc.id).updateData(doc);
    } else {
      const source = new ThreeLightSource(doc);
      this.lights.set(doc.id, source);
      if (source.mesh) this.lightScene.add(source.mesh);
    }
  }

  onLightDelete(doc) {
    if (this.lights.has(doc.id)) {
      const source = this.lights.get(doc.id);
      if (source.mesh) this.lightScene.remove(source.mesh);
      source.dispose();
      this.lights.delete(doc.id);
    }
  }

  update(timeInfo) {
    if (!this.enabled) return;

    const dt = timeInfo && typeof timeInfo.delta === 'number' ? timeInfo.delta : 0;

    // Sync Environment Data
    if (canvas.scene && canvas.environment) {
      this.params.darknessLevel = canvas.environment.darknessLevel;
      // Sync ambient colors if available
      if (canvas.environment.colors) {
         // Copy colors to uniforms...
      }
    }

    // Update Animations for all lights
    this.lights.forEach(light => {
      light.updateAnimation(dt, this.params.darknessLevel);
    });

    // Update Composite Uniforms
    const u = this.compositeMaterial.uniforms;
    u.uDarknessLevel.value = this.params.darknessLevel;
    u.uExposure.value = this.params.exposure;
    u.uSaturation.value = this.params.saturation;
    u.uContrast.value = this.params.contrast;
  }

  render(renderer, scene, camera) {
    if (!this.enabled) return;

    const THREE = window.THREE;

    // Ensure we have a light accumulation target that matches the current
    // drawing buffer size. This avoids a black screen if onResize has not
    // been called yet.
    const size = new THREE.Vector2();
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

    // 1. Accumulate Lights into lightTarget
    const oldTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.lightTarget);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();

    if (this.lightScene && this.mainCamera) {
      renderer.render(this.lightScene, this.mainCamera);
    }

    // 2. Composite: use lightTarget as tLight, base scene texture comes from
    // EffectComposer via setInputTexture(tDiffuse).
    this.compositeMaterial.uniforms.tLight.value = this.lightTarget.texture;

    renderer.setRenderTarget(oldTarget);
    renderer.render(this.quadScene, this.quadCamera);
  }

  setInputTexture(texture) {
    if (this.compositeMaterial) {
      this.compositeMaterial.uniforms.tDiffuse.value = texture;
    }
  }
}