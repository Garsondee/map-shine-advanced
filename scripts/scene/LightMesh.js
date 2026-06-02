import {
  DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT,
  MSA_LIGHT_RADIANCE_GLSL,
  POINT_LIGHT_FALLOFF_GLSL,
  POINT_LIGHT_WALL_VERTEX_EDGE_MIN,
  applyPointLightBufferBlending,
  applyPointLightFalloffUniforms,
  computePointLightFadeWidth,
  computePointLightGeomScale,
  applyFalloffAttenuationUniforms,
  createPointLightFalloffUniforms,
  glowShaderAttenuationFromEdgeSoftness,
} from './point-light-falloff.js';

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
   * @param {'smooth'|'inverseSquare'} [options.falloffProfile] - Legacy alias; unified power-law is always used.
   * @param {number} [options.falloffExponent] - Core tightness (2 ≈ inverse-square feel). Default 2.
   * @param {boolean} [options.achromaticRgb] - When true, RGB is forced to neutral white while alpha
   *   keeps full HDR punch. Use for darkness-cancel pools that must not pick up compose coloration
   *   or Color Correction timeline channel tints (alpha still drives direct illumination).
   * @param {number} [options.rgbGain] - Legacy multiplier on rgb and alpha together. Keep at 1.
   * @param {number} [options.edgeSoftness] - Fraction of outer radius (0–0.5) faded at the rim.
   *   Prevents a hard circular cutoff in the light buffer.
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
    this.edgeSoftness = Number.isFinite(Number(options.edgeSoftness))
      ? Math.max(0, Math.min(1.0, Number(options.edgeSoftness)))
      : 0.12;
    this.attenuation = typeof options.attenuation === 'number'
      ? options.attenuation
      : glowShaderAttenuationFromEdgeSoftness(this.edgeSoftness);
    this.falloffProfile = 'inverseSquare';
    this.falloffExponent = typeof options.falloffExponent === 'number' && options.falloffExponent > 0
      ? options.falloffExponent
      : DEFAULT_POINT_LIGHT_FALLOFF_EXPONENT;
    this.achromaticRgb = options.achromaticRgb === true;
    this.rgbGain = Number.isFinite(Number(options.rgbGain)) && Number(options.rgbGain) > 0
      ? Number(options.rgbGain)
      : 1.0;
    this._lastEffectiveRim = this._getEffectiveRimSoftness();

    /** @type {THREE.Mesh} */
    this.mesh = null;
    /** @type {boolean} */
    this._usesCircleFallback = false;
    /** @type {number[]|null} Unexpanded wall-clip polygon (for rim rebuild). */
    this._baseWorldPoints = null;

    // Basic additive radial falloff material.
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(this.color.r, this.color.g, this.color.b) },
        uInnerRadius: { value: this.innerRadiusPx },
        uOuterRadius: { value: this.outerRadiusPx },
        uGeomRadius: { value: this._computeGeomRadius() },
        // Scene-driven per-radius boosts for bright vs dim regions.
        uBrightRadiusBoost: { value: 3.0 },
        uDimRadiusBoost:    { value: 2.6 },
        // Per-radius contrast (exponents for core/halo masks).
        uCoreContrast: { value: 1.0 },
        uHaloContrast: { value: 1.0 },
        uAttenuation: { value: this.attenuation },
        uFoundryAttenuation: { value: this.attenuation },
        uFalloffAttBlend: { value: this.attenuation },
        uFalloffExponent: { value: this.falloffExponent },
        /** HDR scale for rgb + alpha (compose reads alpha for darkness punch / direct light). */
        uEmissionGain: { value: 0.0 },
        /** 1 = neutral white RGB (alpha unchanged) — bypasses chromatic compose coloration. */
        uAchromaticRgb: { value: this.achromaticRgb ? 1.0 : 0.0 },
        /** RGB-only boost (alpha unchanged). */
        uRgbGain: { value: this.rgbGain },
        /** Rim fade width as a fraction of outer radius (0 = hard edge). */
        uEdgeSoftness: { value: this.edgeSoftness },
        ...createPointLightFalloffUniforms(window.THREE),
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
        uniform float uGeomRadius;
        uniform float uAttenuation;
        uniform float uFalloffExponent;
        uniform float uEmissionGain;
        uniform float uAchromaticRgb;
        uniform float uRgbGain;
        uniform float uEdgeSoftness;
        ${POINT_LIGHT_FALLOFF_GLSL}
        ${MSA_LIGHT_RADIANCE_GLSL}
        void main() {
          float dist = length(vLocalPos);
          float outerR = max(uOuterRadius, 1e-4);
          float d = dist / outerR;

          float att = clamp(uAttenuation, 0.0, 1.0);
          float b = clamp(uInnerRadius / outerR, 0.0, 1.0);
          float cover = msaPointLightFalloff(
            d, b, att, uEdgeSoftness, uFalloffExponent, 0.5, 0.5
          );

          // Feather through geometry pad beyond photometric radius (mesh extends past outerR).
          float geomR = max(uGeomRadius, outerR);
          float dGeom = dist / geomR;
          float photFrac = outerR / geomR;
          float fadeBand = msaPointLightFadeWidth(uEdgeSoftness, uFalloffExponent);
          cover *= 1.0 - smoothstep(photFrac * 0.12, 1.35, dGeom);

          float gain = max(uEmissionGain, 0.0);
          float rgbGain = max(uRgbGain, 0.0);
          float mag = cover * gain * rgbGain;
          float srcMx = max(max(uColor.r, uColor.g), uColor.b);
          vec3 lampCol = (srcMx > 1e-4) ? (uColor / srcMx) : vec3(1.0);
          float gel = (uAchromaticRgb > 0.5) ? 0.0 : 1.0;

          float edgeFade = 1.0 - smoothstep(
            1.0 - max(0.06, fadeBand * 1.35),
            1.05 + fadeBand * 0.10,
            d
          );
          mag *= edgeFade;
          vec3 chromaSig = msaLightChromaSignal(lampCol, gel, mag);
          if (mag <= 0.000001) discard;
          gl_FragColor = vec4(chromaSig, mag);
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });

    applyPointLightBufferBlending(this.material);
    applyPointLightFalloffUniforms(this.material.uniforms);
    this.material.toneMapped = false;
    if (options.worldPoints?.length) {
      this._buildMeshFromWorldPoints(options.worldPoints);
    } else {
      this._buildFallbackCircle();
    }
  }

  /** @private Effective rim softness for geometry expansion (matches fragment shader). */
  _getEffectiveRimSoftness() {
    return computePointLightFadeWidth({
      attenuation: this.attenuation,
      edgeSoftness: this.edgeSoftness,
      falloffExponent: this.falloffExponent,
    });
  }

  /** @private */
  _computeGeomRadius() {
    return Math.max(1, this.outerRadiusPx * computePointLightGeomScale(this._getEffectiveRimSoftness()));
  }

  /** @private */
  _syncRadiusUniforms() {
    if (!this.material?.uniforms) return;
    this.material.uniforms.uOuterRadius.value = this.outerRadiusPx;
    this.material.uniforms.uInnerRadius.value = this.innerRadiusPx;
    if (this.material.uniforms.uGeomRadius) {
      this.material.uniforms.uGeomRadius.value = this._computeGeomRadius();
    }
  }

  /** @private */
  _rebuildCircleGeometryIfNeeded() {
    if (!this._usesCircleFallback || !this.mesh) return;
    const THREE = window.THREE;
    if (!THREE) return;
    const geomRadius = this._computeGeomRadius();
    const geometry = new THREE.CircleGeometry(geomRadius, 128);
    this.mesh.geometry.dispose();
    this.mesh.geometry = geometry;
  }

  /**
   * Update polygon geometry from world-space points [x0,y0,x1,y1,...].
   * If the polygon is degenerate, we fall back to a simple circle.
   * @param {Array<number>} worldPoints
   */
  updatePolygon(worldPoints) {
    if (!worldPoints || worldPoints.length < 6) {
      this._baseWorldPoints = null;
      this._buildFallbackCircle();
      return;
    }
    this._buildMeshFromWorldPoints(worldPoints, true);
  }

  /**
   * Radially expand wall-clip vertices so fragment rim fade (d > 1) has geometry.
   * @param {Array<number>} worldPoints
   * @returns {Array<number>}
   * @private
   */
  _expandWorldPointsForSoftRim(worldPoints) {
    // Wall-clipped polygons must not radially expand — expansion pushes rim through occluders.
    if (this._baseWorldPoints?.length >= 6) return worldPoints;

    const fadeWidth = this._getEffectiveRimSoftness();
    if (!worldPoints?.length || fadeWidth < 0.0001) return worldPoints;

    const cx = this.center.x;
    const cy = this.center.y;
    const outerR = Math.max(this.outerRadiusPx, 1e-4);
    const rimScale = computePointLightGeomScale(fadeWidth);
    const out = new Array(worldPoints.length);

    for (let i = 0; i < worldPoints.length; i += 2) {
      const wx = worldPoints[i];
      const wy = worldPoints[i + 1];
      const lx = wx - cx;
      const ly = wy - cy;
      const len = Math.hypot(lx, ly);
      if (len < 1e-4) {
        out[i] = wx;
        out[i + 1] = wy;
        continue;
      }
      const edgeW = Math.min(1.0, len / outerR);
      // Wall-clipped vertices well inside the nominal radius must not expand through occluders.
      // Open-circle rim vertices (edgeW >= ~0.88) still need pad for fragment rim fade.
      if (edgeW < POINT_LIGHT_WALL_VERTEX_EDGE_MIN) {
        out[i] = wx;
        out[i + 1] = wy;
        continue;
      }
      const rimT = Math.max(0, Math.min(1,
        (edgeW - POINT_LIGHT_WALL_VERTEX_EDGE_MIN) / Math.max(1e-4, 1.0 - POINT_LIGHT_WALL_VERTEX_EDGE_MIN)
      ));
      const scale = 1.0 + (rimScale - 1.0) * rimT;
      out[i] = cx + lx * scale;
      out[i + 1] = cy + ly * scale;
    }
    return out;
  }

  /**
   * Internal: build mesh geometry from world-space polygon points.
   * @param {Array<number>} worldPoints
   * @param {boolean} [storeBase=true] - Cache unexpanded points for rim rebuilds.
   */
  _buildMeshFromWorldPoints(worldPoints, storeBase = true) {
    const THREE = window.THREE;
    this._usesCircleFallback = false;

    if (storeBase && worldPoints?.length >= 6) {
      this._baseWorldPoints = worldPoints.slice();
    }
    const buildPoints = this._expandWorldPointsForSoftRim(
      this._baseWorldPoints ?? worldPoints
    );

    // Compute local-space polygon around origin, with mesh positioned at center.
    const shape = new THREE.Shape();

    for (let i = 0; i < buildPoints.length; i += 2) {
      const wx = buildPoints[i];
      const wy = buildPoints[i + 1];
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
    this._usesCircleFallback = true;
    this._baseWorldPoints = null;
    const geomRadius = this._computeGeomRadius();
    const geometry = new THREE.CircleGeometry(geomRadius, 128);

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
    this._syncRadiusUniforms();
    const b = this.outerRadiusPx > 0 ? Math.min(1, this.innerRadiusPx / this.outerRadiusPx) : 1;
    applyFalloffAttenuationUniforms(this.material.uniforms, this.attenuation, 1.0, b);
    const newRim = this._getEffectiveRimSoftness();
    const rimChanged = Math.abs(newRim - (this._lastEffectiveRim ?? -1)) > 0.004;
    this._lastEffectiveRim = newRim;
    if (rimChanged) {
      if (this._usesCircleFallback) {
        this._rebuildCircleGeometryIfNeeded();
      } else if (this._baseWorldPoints?.length >= 6) {
        this._buildMeshFromWorldPoints(this._baseWorldPoints, false);
      }
    }
    if (this.material.uniforms.uFalloffExponent) {
      this.material.uniforms.uFalloffExponent.value = this.falloffExponent;
    }
  }

  /**
   * @param {'smooth'|'inverseSquare'} profile
   */
  /** @deprecated Unified power-law falloff is always active; kept for call-site compatibility. */
  setFalloffProfile(_profile) {
    this.falloffProfile = 'inverseSquare';
  }

  /**
   * @param {number} exponent - Sharpness for inverseSquare profile (2 ≈ physical 1/r²).
   */
  setFalloffExponent(exponent) {
    const exp = Number.isFinite(exponent) && exponent > 0 ? exponent : 2.0;
    this.falloffExponent = exp;
    if (this.material?.uniforms?.uFalloffExponent) {
      this.material.uniforms.uFalloffExponent.value = exp;
    }
    const prevRim = this._lastEffectiveRim;
    this._lastEffectiveRim = this._getEffectiveRimSoftness();
    if (Math.abs((prevRim ?? -1) - this._lastEffectiveRim) > 0.004) {
      this._syncRadiusUniforms();
      if (this._usesCircleFallback) {
        this._rebuildCircleGeometryIfNeeded();
      } else if (this._baseWorldPoints?.length >= 6) {
        this._buildMeshFromWorldPoints(this._baseWorldPoints, false);
      }
    }
  }

  /**
   * HDR emission multiplier (rgb + alpha). Compose uses alpha for darkness punch.
   * @param {number} gain
   */
  setEmissionGain(gain) {
    const g = Number.isFinite(gain) ? Math.max(0, gain) : 0;
    if (this.material?.uniforms?.uEmissionGain) {
      this.material.uniforms.uEmissionGain.value = g;
    }
    if (this.mesh) {
      this.mesh.visible = g > 1e-4;
    }
  }

  /**
   * Force neutral white RGB output (alpha unchanged). See {@link constructor} `achromaticRgb`.
   * @param {boolean} enabled
   */
  setAchromaticRgb(enabled) {
    this.achromaticRgb = !!enabled;
    if (this.material?.uniforms?.uAchromaticRgb) {
      this.material.uniforms.uAchromaticRgb.value = this.achromaticRgb ? 1.0 : 0.0;
    }
  }

  /**
   * @param {number} gain - Legacy multiplier on rgb + alpha together.
   */
  setRgbGain(gain) {
    const g = Number.isFinite(gain) && gain > 0 ? gain : 1.0;
    this.rgbGain = g;
    if (this.material?.uniforms?.uRgbGain) {
      this.material.uniforms.uRgbGain.value = g;
    }
  }

  /**
   * Runtime photometric outer radius (px). Updates falloff uniforms; circle meshes rebuild geometry.
   * @param {number} outerRadiusPx
   */
  setOuterRadiusPx(outerRadiusPx) {
    const outerR = Math.max(1, Number(outerRadiusPx) || 1);
    if (Math.abs(outerR - this.outerRadiusPx) < 0.5) return;
    this.outerRadiusPx = outerR;
    this.innerRadiusPx = Math.min(this.innerRadiusPx, this.outerRadiusPx);
    this._syncRadiusUniforms();
    if (this._usesCircleFallback) {
      this._rebuildCircleGeometryIfNeeded();
    }
  }

  /**
   * Runtime bright-core radius (px), clamped to outer radius.
   * @param {number} innerRadiusPx
   */
  setInnerRadiusPx(innerRadiusPx) {
    const innerR = Math.max(1, Math.min(Number(innerRadiusPx) || 1, this.outerRadiusPx));
    if (Math.abs(innerR - this.innerRadiusPx) < 0.5) return;
    this.innerRadiusPx = innerR;
    this._syncRadiusUniforms();
  }

  /** @private Rebuild geometry when rim/attenuation changes. */
  _rebuildGeometryForRimChange() {
    this._syncRadiusUniforms();
    if (this._usesCircleFallback) {
      this._rebuildCircleGeometryIfNeeded();
    } else if (this._baseWorldPoints?.length >= 6) {
      this._buildMeshFromWorldPoints(this._baseWorldPoints, false);
    }
  }

  /**
   * @param {number} attenuation - Shader softness 0..1 (stay below 1 for glow sliders).
   */
  setAttenuation(attenuation) {
    const a = Math.max(0, Math.min(1, Number(attenuation) || 0));
    this.attenuation = a;
    const b = this.outerRadiusPx > 0 ? Math.min(1, this.innerRadiusPx / this.outerRadiusPx) : 1;
    applyFalloffAttenuationUniforms(this.material?.uniforms, a, 1.0, b);
    const prevRim = this._lastEffectiveRim;
    this._lastEffectiveRim = this._getEffectiveRimSoftness();
    if (Math.abs((prevRim ?? -1) - this._lastEffectiveRim) > 0.004) {
      this._rebuildGeometryForRimChange();
    }
  }

  /**
   * @param {number} softness - Rim fade as fraction of outer radius (0–0.75).
   */
  setEdgeSoftness(softness) {
    const s = Number.isFinite(softness) ? Math.max(0, Math.min(0.75, softness)) : 0.12;
    this.edgeSoftness = s;
    if (this.material?.uniforms?.uEdgeSoftness) {
      this.material.uniforms.uEdgeSoftness.value = s;
    }
    this.setAttenuation(glowShaderAttenuationFromEdgeSoftness(s));
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
