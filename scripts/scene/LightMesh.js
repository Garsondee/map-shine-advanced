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
   * @param {THREE.Vector2} centerWorld - Light origin in world space (x,y).
   * @param {number} radiusPx - Bright or max radius in pixels (Three world units).
   * @param {{r:number,g:number,b:number}} color - Linear RGB color (0..1).
   * @param {Object} [options]
   * @param {Array<number>} [options.worldPoints] - Optional initial polygon points as [x0,y0,x1,y1,...] in world space.
   */
  constructor(centerWorld, radiusPx, color, options = {}) {
    const THREE = window.THREE;

    this.center = centerWorld.clone();
    this.radiusPx = Math.max(1, radiusPx || 1);
    this.color = { r: color?.r ?? 1, g: color?.g ?? 1, b: color?.b ?? 1 };

    /** @type {THREE.Mesh} */
    this.mesh = null;

    // Basic additive radial falloff material.
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(this.color.r, this.color.g, this.color.b) },
        uRadius: { value: this.radiusPx }
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
        uniform float uRadius;

        void main() {
          float dist = length(vLocalPos);
          if (dist >= uRadius) discard;

          // Smooth falloff similar to Foundry: inner bright core then soft dim.
          float d = dist / uRadius;
          float inner = 0.5; // fraction of radius that is "bright"
          float falloff = 1.0 - smoothstep(inner, 1.0, d);

          // Simple quadratic falloff for a bit of punch
          float intensity = pow(max(0.0, falloff), 2.0);

          gl_FragColor = vec4(uColor * intensity, intensity);
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

    if (!this.mesh) {
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.mesh.position.set(this.center.x, this.center.y, 0);
    } else {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
      this.mesh.position.set(this.center.x, this.center.y, 0);
    }
  }

  /**
   * Internal: fallback circular mesh when polygon is unavailable.
   */
  _buildFallbackCircle() {
    const THREE = window.THREE;
    const segments = 32;
    const geometry = new THREE.CircleGeometry(this.radiusPx, segments);

    if (!this.mesh) {
      this.mesh = new THREE.Mesh(geometry, this.material);
      this.mesh.position.set(this.center.x, this.center.y, 0);
    } else {
      this.mesh.geometry.dispose();
      this.mesh.geometry = geometry;
      this.mesh.position.set(this.center.x, this.center.y, 0);
    }
  }

  /**
   * Update color and radius uniforms.
   * @param {{r:number,g:number,b:number}} color
   * @param {number} radiusPx
   */
  updateAppearance(color, radiusPx) {
    this.color = { r: color?.r ?? 1, g: color?.g ?? 1, b: color?.b ?? 1 };
    this.radiusPx = Math.max(1, radiusPx || 1);

    this.material.uniforms.uColor.value.setRGB(this.color.r, this.color.g, this.color.b);
    this.material.uniforms.uRadius.value = this.radiusPx;
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
