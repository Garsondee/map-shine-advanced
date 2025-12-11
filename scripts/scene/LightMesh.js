/**
 * @fileoverview LightMesh - helper for rendering a single ambient light as a polygonal mesh.
 *
 * This class is intentionally lightweight and stateless with respect to Foundry.
 * It expects all positions in **Three.js world space** (Bottom-Left origin, Y-Up)
 * and works purely with THREE primitives.
 *
 * Geometry Strategy:
 * - We receive polygon vertices in world space (already wall-clipped by Foundry's
 *   PointSourcePolygon).
 * - We compute the light center in world space and build a local-space Shape
 *   around the origin so that the mesh can sit at `center` with small local
 *   coordinates. This keeps precision reasonable for large scenes.
 * - Triangulation is handled by `THREE.ShapeGeometry`.
 *
 * Shading Strategy (v1):
 * - The material is an additive ShaderMaterial that renders a simple radial
 *   falloff from the center out to a provided `radiusPx`.
 * - Walls are respected because the polygon itself is already clipped by
 *   Foundry; we do not raycast inside the shader.
 * - Roof handling (Outdoors mask, roof alpha) is left to the higher-level
 *   LightingEffect for now.
 */

export class LightMesh {
  /**
   * Get the ground plane Z position from SceneComposer.
   * Light meshes should be positioned at this Z level.
   * @returns {number} Ground Z position (default 1000)
   * @private
   * @static
   */
  static _getGroundZ() {
    const sceneComposer = window.MapShine?.sceneComposer;
    if (sceneComposer && typeof sceneComposer.groundZ === 'number') {
      return sceneComposer.groundZ;
    }
    return 1000; // Default ground plane Z
  }

  /**
   * @param {THREE.Vector2} centerWorld - Light origin in world space (x,y).
   * @param {number} outerRadiusPx - Max (dim) radius in pixels (Three world units).
   * @param {{r:number,g:number,b:number}} color - Linear RGB color (0..1).
   * @param {Object} [options]
   * @param {number} [options.innerRadiusPx] - Bright radius in pixels. Defaults to 0.5 * outerRadiusPx.
   * @param {Array<number>} [options.worldPoints] - Optional initial polygon points as [x0,y0,x1,y1,...] in world space.
   */
  constructor(centerWorld, outerRadiusPx, color, options = {}) {
    const THREE = window.THREE;

    this.center = centerWorld.clone();
    this.outerRadiusPx = Math.max(1, outerRadiusPx || 1);
    this.innerRadiusPx = Math.max(
      1,
      typeof options.innerRadiusPx === 'number' && options.innerRadiusPx > 0
        ? Math.min(options.innerRadiusPx, this.outerRadiusPx)
        : this.outerRadiusPx * 0.5
    );
    this.color = { r: color?.r ?? 1, g: color?.g ?? 1, b: color?.b ?? 1 };
    this.attenuation = typeof options.attenuation === 'number' ? options.attenuation : 0.5;

    /** @type {THREE.Mesh} */
    this.mesh = null;

    // Basic additive radial falloff material.
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(this.color.r, this.color.g, this.color.b) },
        uInnerRadius: { value: this.innerRadiusPx },
        uOuterRadius: { value: this.outerRadiusPx },
        // Scene-driven per-radius boosts for bright vs dim regions.
        uBrightRadiusBoost: { value: 3.0 },
        uDimRadiusBoost:    { value: 2.6 },
        // Per-radius contrast (exponents for core/halo masks).
        uCoreContrast: { value: 1.0 },
        uHaloContrast: { value: 1.0 },
        uAttenuation: { value: this.attenuation },
        // Global softness multiplier driven by LightingEffect.falloffSoftness
        // (0.25 = hardest, 4.0 = softest in the UI). 1.0 is neutral.
        uGlobalSoftness: { value: 1.0 },
        // Normalized fade controls (0..1)
        // Bright fade is inside the bright radius: fractions of inner radius.
        uBrightFadeStart: { value: 0.8 },
        uBrightFadeEnd:   { value: 1.0 },
        // Dim fade is between bright and dim radii: 0 = at bright radius, 1 = at dim.
        uDimFadeStart:    { value: 0.2 },
        uDimFadeEnd:      { value: 1.0 }
      },
      vertexShader: `
        varying vec2 vLocalPos;
        void main() {
          // Local XY in world units around the mesh origin
          vLocalPos = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vLocalPos;
        uniform vec3 uColor;
        uniform float uInnerRadius;
        uniform float uOuterRadius;
        uniform float uAttenuation;
        void main() {
          float dist = length(vLocalPos);
          if (dist >= uOuterRadius) discard;

          // Normalize distance so 0 = center, 1 = dim edge.
          float d = dist / max(uOuterRadius, 1e-4);

          // Bright radius ratio: where the inner (bright) circle ends.
          float brightRatio = clamp(uInnerRadius / max(uOuterRadius, 1e-4), 0.0, 1.0);

          // Attenuation drives edge hardness for BOTH radii, matching Foundry.
          float att = clamp(uAttenuation, 0.0, 1.0);
          float hardness = mix(0.05, 1.0, att);

          // Dim falloff: outer halo from center (0) to dim edge (1).
          float dimFalloff = 1.0 - smoothstep(1.0 - hardness, 1.0, d);

          // Bright falloff: remap so bright edge is treated as 1.0.
          float brightDist = d / max(0.001, brightRatio);
          float brightFalloff = 1.0 - smoothstep(1.0 - hardness, 1.0, brightDist);

          // Combine bright + dim contributions and clamp.
          float finalIntensity = clamp(dimFalloff + brightFalloff, 0.0, 1.0);

          gl_FragColor = vec4(uColor * finalIntensity, finalIntensity);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending
    });

    // Optional initial polygon.
    if (options.worldPoints?.length) {
      this._buildMeshFromWorldPoints(options.worldPoints);
    } else {
      this._buildFallbackCircle();
    }
  }

  /**
   * Update polygon geometry from world-space points [x0,y0,x1,y1,...].
   * If the polygon is degenerate, we fall back to a simple circle.
   * @param {Array<number>} worldPoints
   */
  updatePolygon(worldPoints) {
    if (!worldPoints || worldPoints.length < 6) {
      this._buildFallbackCircle();
      return;
    }
    this._buildMeshFromWorldPoints(worldPoints);
  }

  /**
   * Internal: build mesh geometry from world-space polygon points.
   * @param {Array<number>} worldPoints
   */
  _buildMeshFromWorldPoints(worldPoints) {
    const THREE = window.THREE;

    // Compute local-space polygon around origin, with mesh positioned at center.
    const shape = new THREE.Shape();

    for (let i = 0; i < worldPoints.length; i += 2) {
      const wx = worldPoints[i];
      const wy = worldPoints[i + 1];
      const lx = wx - this.center.x;
      const ly = wy - this.center.y;

      if (i === 0) shape.moveTo(lx, ly);
      else shape.lineTo(lx, ly);
    }

    const geometry = new THREE.ShapeGeometry(shape);

    // Position at ground plane Z level (plus small offset)
    const lightZ = LightMesh._getGroundZ() + 0.1;

    if (!this.mesh) {
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.mesh.position.set(this.center.x, this.center.y, lightZ);
    } else {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
      this.mesh.position.set(this.center.x, this.center.y, lightZ);
    }
  }

  /**
   * Internal: fallback circular mesh when polygon is unavailable.
   */
  _buildFallbackCircle() {
    const THREE = window.THREE;
    const segments = 32;
    const geometry = new THREE.CircleGeometry(this.outerRadiusPx, segments);

    // Position at ground plane Z level (plus small offset)
    const lightZ = LightMesh._getGroundZ() + 0.1;

    if (!this.mesh) {
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.mesh.position.set(this.center.x, this.center.y, lightZ);
    } else {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
      this.mesh.position.set(this.center.x, this.center.y, lightZ);
    }
  }

  /**
   * Update color and radius uniforms.
   * @param {{r:number,g:number,b:number}} color
   * @param {number} outerRadiusPx
   * @param {number} [innerRadiusPx]
   */
  updateAppearance(color, outerRadiusPx, innerRadiusPx) {
    this.color = { r: color?.r ?? 1, g: color?.g ?? 1, b: color?.b ?? 1 };
    this.outerRadiusPx = Math.max(1, outerRadiusPx || 1);
    this.innerRadiusPx = Math.max(
      1,
      typeof innerRadiusPx === 'number' && innerRadiusPx > 0
        ? Math.min(innerRadiusPx, this.outerRadiusPx)
        : this.outerRadiusPx * 0.5
    );

    this.material.uniforms.uColor.value.setRGB(this.color.r, this.color.g, this.color.b);
    this.material.uniforms.uOuterRadius.value = this.outerRadiusPx;
    this.material.uniforms.uInnerRadius.value = this.innerRadiusPx;
    this.material.uniforms.uAttenuation.value = this.attenuation;
  }

  /** Dispose geometry and material. */
  dispose() {
    if (this.mesh) {
      if (this.mesh.geometry) this.mesh.geometry.dispose();
      if (this.mesh.material) this.mesh.material.dispose();
    }
  }
}

export default LightMesh;
