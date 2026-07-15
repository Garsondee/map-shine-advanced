/**
 * @fileoverview Shared helpers for Three-based control gizmos (icons, radius visuals).
 *
 * Centralizing these materials avoids shader drift and inconsistent styling across
 * light/sound/notes/template editor affordances.
 */

/**
 * Factory for common control-gizmo materials.
 */
export class ControlGizmoFactory {
  /**
   * Create an outlined billboard icon shader material.
   *
   * @param {THREE.Texture|null} texture
   * @param {{outlineColor?: number, outlineWidth?: number}} [options]
   * @returns {THREE.ShaderMaterial}
   */
  static createOutlinedSpriteMaterial(texture = null, options = {}) {
    const THREE = window.THREE;
    const outlineColor = Number(options.outlineColor ?? 0x222222);
    const outlineWidth = Number(options.outlineWidth ?? 0.08);

    return new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        outlineColor: { value: new THREE.Color(outlineColor) },
        outlineWidth: { value: Number.isFinite(outlineWidth) ? outlineWidth : 0.08 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec2 scale = vec2(
            length(modelMatrix[0].xyz),
            length(modelMatrix[1].xyz)
          );
          mvPosition.xy += position.xy * scale;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform vec3 outlineColor;
        uniform float outlineWidth;
        varying vec2 vUv;

        void main() {
          vec4 texColor = texture2D(map, vUv);
          float alpha = texColor.a;

          float outlineAlpha = 0.0;
          float step = outlineWidth;
          for (float x = -1.0; x <= 1.0; x += 1.0) {
            for (float y = -1.0; y <= 1.0; y += 1.0) {
              if (x == 0.0 && y == 0.0) continue;
              vec2 offset = vec2(x, y) * step;
              float neighborAlpha = texture2D(map, vUv + offset).a;
              outlineAlpha = max(outlineAlpha, neighborAlpha);
            }
          }

          float outline = clamp(outlineAlpha - alpha, 0.0, 1.0);
          vec3 finalColor = mix(texColor.rgb, outlineColor, outline * 0.9);
          float finalAlpha = max(alpha, outline * 0.85);

          gl_FragColor = vec4(finalColor, finalAlpha);
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false
    });
  }

  /**
   * Create a neutral fill material used for editor radius footprints.
   *
   * @param {{color?: number, opacity?: number}} [options]
   * @returns {THREE.MeshBasicMaterial}
   */
  static createRadiusFillMaterial(options = {}) {
    const THREE = window.THREE;
    const material = new THREE.MeshBasicMaterial({
      color: Number(options.color ?? 0xffffff),
      transparent: true,
      opacity: Number(options.opacity ?? 0),
      depthTest: false,
      depthWrite: false
    });
    material.toneMapped = false;
    return material;
  }

  /**
   * Create a standard line material for editor radius rings.
   *
   * @param {{color?: number, opacity?: number}} [options]
   * @returns {THREE.LineBasicMaterial}
   */
  static createRadiusBorderMaterial(options = {}) {
    const THREE = window.THREE;
    const material = new THREE.LineBasicMaterial({
      color: Number(options.color ?? 0xffffff),
      transparent: true,
      opacity: Number(options.opacity ?? 0.35),
      depthTest: false,
      depthWrite: false
    });
    material.toneMapped = false;
    return material;
  }
}
