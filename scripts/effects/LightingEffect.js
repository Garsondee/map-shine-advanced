/**
 * @fileoverview Lighting Effect
 * Implements dynamic lighting for the scene base plane and ground tiles
 * Uses Foundry VTT light source data to render lights in Three.js
 * @module effects/LightingEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import Coordinates from '../utils/coordinates.js';

const log = createLogger('LightingEffect');

export class LightingEffect extends EffectBase {
  constructor() {
    super('lighting', RenderLayers.SURFACE_EFFECTS, 'low'); // Render with surface effects for now
    
    this.priority = 10; // Base lighting
    this.alwaysRender = true;

    // Lighting parameters
    this.params = {
      enabled: true,
      globalIntensity: 1.0,
      ambientColor: { r: 0.1, g: 0.1, b: 0.1 } // Base ambient level
    };

    // Resources
    this.lights = new Map(); // Map<id, {data, uniformIndex}>
    this.maxLights = 64; // Maximum number of dynamic lights supported in shader
    
    // Mesh references (to apply lighting to)
    this.targets = new Set();
    
    // Material/Shader management
    this.uniforms = null;
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
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        globalIntensity: { type: 'slider', min: 0, max: 2, step: 0.1, default: 1.0 },
        ambientColor: { type: 'color', default: { r: 0.1, g: 0.1, b: 0.1 } }
      }
    };
  }

  /**
   * Initialize the effect
   */
  initialize(renderer, scene, camera) {
    log.info('Initializing LightingEffect');
    this.scene = scene;
    this.renderer = renderer;

    // Listen for light updates
    this.hookIdCreate = Hooks.on('createAmbientLight', (doc) => this.onLightCreated(doc));
    this.hookIdUpdate = Hooks.on('updateAmbientLight', (doc, changes) => this.onLightUpdated(doc, changes));
    this.hookIdDelete = Hooks.on('deleteAmbientLight', (doc) => this.onLightDeleted(doc));

    // Initial sync
    this.syncAllLights();
  }

  /**
   * Set the base mesh to apply lighting to (usually the base plane)
   * This effect modifies the material of the target mesh(es) or adds an overlay
   * For this implementation, we'll use an overlay mesh with additive blending
   * to paint light onto the scene without replacing the base materials complex PBR.
   */
  setBaseMesh(mesh) {
    if (!mesh) return;
    
    // We will create a "Lighting Plane" that sits just above the base plane
    // and renders the accumulated light. This avoids hacking the PBR shader for now.
    // In a full deferred renderer, we'd do this differently.
    const geometry = mesh.geometry.clone();
    const material = this.createLightingMaterial();
    
    this.lightingMesh = new window.THREE.Mesh(geometry, material);
    this.lightingMesh.name = 'LightingOverlay';
    
    // Copy transform from base mesh
    this.lightingMesh.position.copy(mesh.position);
    this.lightingMesh.position.z += 0.1; // Slight offset
    this.lightingMesh.rotation.copy(mesh.rotation);
    this.lightingMesh.scale.copy(mesh.scale);
    
    this.scene.add(this.lightingMesh);
    this.targets.add(this.lightingMesh);
    
    this.updateLightUniforms();
  }

  createLightingMaterial() {
    const THREE = window.THREE;
    
    // Uniforms for N lights
    this.uniforms = {
      ambientColor: { value: new THREE.Color(0.1, 0.1, 0.1) },
      globalIntensity: { value: 1.0 },
      // Foundry scene darkness (0 = fully lit, 1 = max darkness)
      uDarknessLevel: { value: 0.0 },
      numLights: { value: 0 },
      lightPosition: { value: new Float32Array(this.maxLights * 3) }, // x,y,z flat array
      lightColor: { value: new Float32Array(this.maxLights * 3) },    // r,g,b flat array
      lightConfig: { value: new Float32Array(this.maxLights * 4) }    // radius, dim, attenuation, type
    };

    const vertexShader = `
      varying vec2 vUv;
      varying vec3 vWorldPosition;
      
      void main() {
        vUv = uv;
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `;

    const fragmentShader = `
      uniform vec3 ambientColor;
      uniform float globalIntensity;
      // Foundry scene darkness (0 = light, 1 = dark; 1 ~= 75% darkening)
      uniform float uDarknessLevel;
      uniform int numLights;
      uniform vec3 lightPosition[${this.maxLights}];
      uniform vec3 lightColor[${this.maxLights}];
      uniform vec4 lightConfig[${this.maxLights}]; // radius, dim, attenuation, unused
      
      varying vec3 vWorldPosition;
      
      void main() {
        // Use Foundry darkness only as a subtle modifier for dynamic lights.
        // Do NOT darken the whole scene again here, since the base canvas and
        // other effects already apply the scene darkness. That would double-darken.
        float clampedDarkness = clamp(uDarknessLevel, 0.0, 1.0);

        // Base multiplier for Multiply blending: always 1.0 so the overlay does
        // not globally dim the scene. Darkness is handled by Foundry itself.
        float baseBrightness = 1.0;
        vec3 totalLight = vec3(baseBrightness) * globalIntensity;
        
        for (int i = 0; i < ${this.maxLights}; i++) {
          if (i >= numLights) break;
          
          vec3 lPos = lightPosition[i];
          vec3 lColor = lightColor[i];
          float radius = lightConfig[i].x;
          float dim = lightConfig[i].y;
          float attenuation = lightConfig[i].z;
          
          float dist = distance(vWorldPosition.xy, lPos.xy);
          
          if (dist < radius) {
            // Normalized distance
            float d = dist / radius;
            
            // Simple falloff
            // Attenuation controls how sharp the falloff is
            float falloff = 1.0 - smoothstep(dim/radius, 1.0, d);
            
            // Apply attenuation factor
            // Foundry attenuation: 0 = no falloff (linear?), 1 = sharp falloff
            // We'll mix between linear and squared falloff
            float linear = 1.0 - d;
            float squared = 1.0 - d * d;
            float lightIntensity = mix(linear, squared, attenuation) * falloff;

            // Let dynamic lights respond a bit to darkness without crushing them.
            // At darkness 0 -> factor 1.0, at darkness 1 -> factor ~0.7
            float dynamicBrightness = 1.0 - 0.3 * clampedDarkness;
            totalLight += lColor * lightIntensity * dynamicBrightness;
          }
        }
        
        // Output with additive blending (we want to add light to the scene)
        // But since this is an overlay, we need to output alpha?
        // Actually, we want to MULTIPLY the underlying texture by this light?
        // Or ADD light? Standard rendering is Diffuse * Light.
        // Since we can't easily access the underlying texture here without huge changes,
        // We will make this an ADDITIVE light layer for "Colored Light" and rely on 
        // base texture for ambient.
        // Wait, standard lighting logic: (Ambient + Dynamic) * Diffuse.
        // If we render this on top with Multiply, we darken the scene where there is no light.
        // That creates shadows/darkness!
        
        // Let's try: BlendMode Multiply. Initialize with white.
        // Areas with no light -> Ambient Color (dark).
        // Areas with light -> Add to Ambient.
        
        gl_FragColor = vec4(totalLight, 1.0);
      }
    `;

    return new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: vertexShader,
      fragmentShader: fragmentShader,
      transparent: true,
      blending: THREE.MultiplyBlending, // Multiply to tint/darken the underlying scene
      depthWrite: false,
      depthTest: true // Respect depth so we don't light through things? Actually map is flat.
    });
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
    const colorInt = config.color;
    if (colorInt !== null && colorInt !== undefined) {
      r = ((colorInt >> 16) & 0xff) / 255;
      g = ((colorInt >> 8) & 0xff) / 255;
      b = (colorInt & 0xff) / 255;
    }
    
    // Extract intensity/brightness
    const intensity = config.luminosity ?? 0.5;
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
      const dimPx = l.dim * pixelsPerUnit;
      
      this.uniforms.lightConfig.value[i4] = radiusPx;
      this.uniforms.lightConfig.value[i4 + 1] = dimPx;
      this.uniforms.lightConfig.value[i4 + 2] = l.attenuation;
      this.uniforms.lightConfig.value[i4 + 3] = 0;
    }
  }

  update(timeInfo) {
    if (!this.enabled) {
      if (this.lightingMesh) this.lightingMesh.visible = false;
      return;
    }
    if (this.lightingMesh) this.lightingMesh.visible = true;
    
    if (this.uniforms) {
      const p = this.params;
      this.uniforms.globalIntensity.value = p.globalIntensity;
      this.uniforms.ambientColor.value.setRGB(p.ambientColor.r, p.ambientColor.g, p.ambientColor.b);
      // Drive darkness from Foundry scene environment if available
      try {
        if (typeof canvas !== 'undefined' && canvas?.scene?.environment?.darknessLevel !== undefined) {
          this.uniforms.uDarknessLevel.value = canvas.scene.environment.darknessLevel;
        }
      } catch (e) {
        // If canvas is not ready or throws, keep previous value
      }
    }
  }

  dispose() {
    Hooks.off('createAmbientLight', this.hookIdCreate);
    Hooks.off('updateAmbientLight', this.hookIdUpdate);
    Hooks.off('deleteAmbientLight', this.hookIdDelete);
    
    if (this.lightingMesh) {
      this.scene.remove(this.lightingMesh);
      this.lightingMesh.geometry.dispose();
      this.lightingMesh.material.dispose();
    }
  }
}
