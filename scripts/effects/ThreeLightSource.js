/**
 * @fileoverview ThreeLightSource
 * Replicates Foundry VTT's PointLightSource logic in Three.js
 */
import Coordinates from '../utils/coordinates.js';

class SmoothNoise {
  constructor() { this.value = 0; this.target = 0; }
  update() { 
    this.target = Math.random(); 
    this.value += (this.target - this.value) * 0.1; 
    return this.value; 
  }
}

export class ThreeLightSource {
  constructor(document) {
    this.id = document.id;
    this.document = document;
    this.mesh = null;
    this.material = null;
    
    this.animation = {
      type: document.config.animation?.type || null,
      speed: document.config.animation?.speed || 5,
      intensity: document.config.animation?.intensity || 5,
      time: 0,
      noise: new SmoothNoise()
    };

    /**
     * Track whether we are currently using a simple circular geometry
     * fallback instead of the wall-clipped LOS polygon. This can happen
     * if the LightSource LOS has not been initialized yet at the moment
     * this ThreeLightSource is constructed. We will attempt to upgrade
     * to the proper LOS polygon lazily in updateAnimation().
     * @type {boolean}
     */
    this._usingCircleFallback = false;

    this.init();
  }

  init() {
    const THREE = window.THREE;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color() },
        uRadius: { value: 0 },       // Max radius (dim)
        uBrightRadius: { value: 0 }, // Core radius (bright)
        uAlpha: { value: 0.5 },
        uAttenuation: { value: 0.5 },
        uTime: { value: 0 },
        uIntensity: { value: 1.0 },
        uBrightness: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vPos;
        void main() {
          vPos = position.xy; 
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vPos;
        uniform vec3 uColor;
        uniform float uRadius;
        uniform float uBrightRadius;
        uniform float uAlpha;
        uniform float uAttenuation;
        uniform float uIntensity;
        uniform float uBrightness;

        void main() {
          float dist = length(vPos);
          // Normalized distance [0..1]
          float r = dist / uRadius; 
          
          if (r >= 1.0) discard;

          // uAttenuation acts as a "Softness" factor [0..1]
          // 0.0 = Hard Edges (Plateaus)
          // 1.0 = Soft Edges (Linear Gradients)
          float softness = uAttenuation; 

          // 1. OUTER CIRCLE (Dim Radius)
          // At softness 0: Hard cut at r=1.0
          // At softness 1: Fades linearly from center (r=0) to edge (r=1)
          float outerStart = 1.0 - softness;
          float outerEnd = 1.0 + 0.0001; // Epsilon to avoid div/0
          float outerAlpha = 1.0 - smoothstep(outerStart, outerEnd, r);

          // 2. INNER CIRCLE (Bright Radius)
          // This adds the "core" brightness.
          // Normalized Bright Radius
          float b = uBrightRadius / uRadius;
          
          // Interpolate the transition window based on softness
          // Softness expands the gradient outward from the bright radius border
          float innerStart = b * (1.0 - softness);
          float innerEnd = b + (softness * (1.0 - b)) + 0.0001;
          
          float innerAlpha = 1.0 - smoothstep(innerStart, innerEnd, r);

          // 3. COMPOSITION
          // Foundry lights are essentially stacked layers.
          // Base Dim Layer = 0.5 intensity.
          // Bright Boost Layer = 0.5 intensity.
          // Total Center Intensity = 1.0.
          float intensity = (0.5 * outerAlpha) + (0.5 * innerAlpha);

          // Final Alpha calculation
          float alpha = intensity * uAlpha * uIntensity;

          // Additive Output
          gl_FragColor = vec4(uColor * uBrightness, alpha);
        }
      `,
      transparent: true,
      // Standard additive: SrcAlpha * color + 1 * dest
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneFactor,
      depthWrite: false,
      depthTest: false,
    });

    this.updateData(this.document, true);
  }

  /**
   * Get the ground plane Z position from SceneComposer.
   * Lights should be positioned at this Z level (plus a small offset).
   * @returns {number} Ground Z position (default 1000)
   * @private
   */
  _getGroundZ() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer && typeof sceneComposer.groundZ === 'number') {
      return sceneComposer.groundZ;
    }
    return 1000; // Default ground plane Z
  }

  updateData(doc, forceRebuild = false) {
    this.document = doc;
    const config = doc.config;
    const THREE = window.THREE;

    // 1. Color Parsing
    const c = new THREE.Color(1, 1, 1);
    const colorInput = config.color;

    if (colorInput) {
      if (typeof colorInput === 'string') c.set(colorInput);
      else if (typeof colorInput === 'number') c.setHex(colorInput);
      else if (typeof colorInput === 'object' && colorInput.r !== undefined) c.copy(colorInput);
    }
    
    // Slight saturation boost
    const hsl = {};
    c.getHSL(hsl);
    if (hsl.s > 0) {
      c.setHSL(hsl.h, Math.min(1.0, hsl.s * 1.1), hsl.l);
    }
    this.material.uniforms.uColor.value.copy(c);

    // 2. Brightness / intensity logic
    const luminosity = config.luminosity ?? 0.5;
    const satBonus = (hsl.s > 0.2) ? 1.0 : 0.0;
    this.material.uniforms.uBrightness.value = 1.5 + (luminosity * 2.0) + satBonus;

    // 3. Geometry
    const dim = config.dim || 0;
    const bright = config.bright || 0;
    const radius = Math.max(dim, bright);
    
    const d = canvas.dimensions;
    const pxPerUnit = d.size / d.distance;
    const rPx = radius * pxPerUnit;
    const brightPx = bright * pxPerUnit;

    this.material.uniforms.uRadius.value = rPx;
    this.material.uniforms.uBrightRadius.value = brightPx;
    this.material.uniforms.uAlpha.value = config.alpha ?? 0.5;

    // --- FOUNDRY ATTENUATION MATH ---
    // Maps user input [0,1] to a non-linear shader curve [0,1]
    const rawAttenuation = config.attenuation ?? 0.5;
    const computedAttenuation = (Math.cos(Math.PI * Math.pow(rawAttenuation, 1.5)) - 1) / -2;
    this.material.uniforms.uAttenuation.value = computedAttenuation;

    // 4. Position
    // Light meshes must be at the ground plane Z level (plus small offset)
    // to align with the base plane after the camera/ground refactor.
    const worldPos = Coordinates.toWorld(doc.x, doc.y);
    const groundZ = this._getGroundZ();
    const lightZ = groundZ + 0.1; // Slightly above ground plane

    if (forceRebuild || !this.mesh) {
      this.rebuildGeometry(worldPos.x, worldPos.y, rPx, lightZ);
    } else {
      this.mesh.position.set(worldPos.x, worldPos.y, lightZ);
    }
  }

  rebuildGeometry(worldX, worldY, radiusPx, lightZ) {
    const THREE = window.THREE;
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.removeFromParent();
    }

    let geometry;
    let shapePoints = null;

    try {
      const placeable = canvas.lighting?.get(this.id);
      if (placeable && placeable.source) {
        // Prefer the LOS polygon, which is already clipped by walls.
        const poly = placeable.source.los || placeable.source.shape;
        const points = poly?.points;
        if (points && points.length >= 6) {
          shapePoints = [];
          for (let i = 0; i < points.length; i += 2) {
            const v = Coordinates.toWorld(points[i], points[i + 1]);
            // Convert to local space around the light center
            shapePoints.push(new THREE.Vector2(v.x - worldX, v.y - worldY));
          }
        }
      }
    } catch (e) { }

    if (shapePoints && shapePoints.length > 2) {
      const shape = new THREE.Shape(shapePoints);
      geometry = new THREE.ShapeGeometry(shape);
      this._usingCircleFallback = false;
    } else {
      // Circle Fallback - bumped segments to 128 for smoother large radii
      geometry = new THREE.CircleGeometry(radiusPx, 128);
      this._usingCircleFallback = true;
    }

    this.mesh = new THREE.Mesh(geometry, this.material);
    // Position at ground plane Z level (passed from updateData)
    this.mesh.position.set(worldX, worldY, lightZ);
    
    // Ensure render order is handled correctly if needed
    this.mesh.renderOrder = 100;
  }

  updateAnimation(dt, globalDarkness) {
    this.animation.time += dt * 0.001;
    this.material.uniforms.uTime.value = this.animation.time;

    const type = this.document.config.animation?.type;
    const speed = this.document.config.animation?.speed || 5;
    const intensity = this.document.config.animation?.intensity || 5;

    if (type === "torch") {
      const n = this.animation.noise.update() * (intensity / 10);
      this.material.uniforms.uIntensity.value = 0.85 + n;
    } else if (type === "pulse") {
      const s = Math.sin(this.animation.time * speed) * 0.5 + 0.5;
      this.material.uniforms.uIntensity.value = 0.7 + (s * 0.3);
    } else {
      this.material.uniforms.uIntensity.value = 1.0;
    }

    // If we had to fall back to a simple circle because the LOS polygon
    // was not yet available when this light was created, try to upgrade
    // lazily once the LOS data exists. This ensures lights respect walls
    // even if Foundry computes LOS after our initial sync.
    if (this._usingCircleFallback) {
      try {
        const placeable = canvas.lighting?.get(this.id);
        const poly = placeable?.source?.los;
        const points = poly?.points;
        if (points && points.length >= 6) {
          const d = canvas.dimensions;
          const config = this.document.config;
          const dim = config.dim || 0;
          const bright = config.bright || 0;
          const radius = Math.max(dim, bright);
          const pxPerUnit = d.size / d.distance;
          const rPx = radius * pxPerUnit;

          const worldPos = Coordinates.toWorld(this.document.x, this.document.y);
          const groundZ = this._getGroundZ();
          const lightZ = groundZ + 0.1;

          this.rebuildGeometry(worldPos.x, worldPos.y, rPx, lightZ);
        }
      } catch (e) {
        // Swallow and try again on a later frame if needed.
      }
    }
  }

  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.material.dispose();
    }
  }
}