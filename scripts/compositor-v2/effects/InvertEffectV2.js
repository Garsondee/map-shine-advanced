import { createLogger } from '../../core/log.js';

const log = createLogger('InvertEffectV2');

/**
 * InvertEffectV2 - Color inversion effect
 * 
 * Archetype: C (Post-Processing Effect)
 * Simple color inversion post-processing effect.
 * Disabled by default - users opt in via control panel.
 */
export class InvertEffectV2 {
  constructor() {
    this._enabled = false;
    this._initialized = false;

    this._quadScene = null;
    this._quadCamera = null;
    this._mesh = null;
    this._material = null;

    this.params = {
      enabled: false,
      strength: 1.0
    };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
  }

  static getControlSchema() {
    return {
      enabled: false,
      help: {
        title: 'Color invert',
        summary: [
          'Blends each pixel toward its photographic inverse (1 − RGB) for negative / sci-fi / puzzle-map looks.',
          'Stylistic only — no masks. One fullscreen post pass on the composited image.',
          'Performance: very cheap (single pass, simple shader).',
          'Persistence: settings save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          Strength: 'Blend between the original image and full inversion (0 = original, 1 = full invert).',
        },
      },
      groups: [
        {
          name: 'look',
          label: 'Look',
          type: 'folder',
          expanded: true,
          parameters: ['strength'],
        },
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },
        strength: {
          type: 'slider',
          label: 'Strength',
          min: 0.0,
          max: 1.0,
          step: 0.01,
          default: 1.0,
          tooltip: 'How much inversion is mixed in (0 leaves the image unchanged).',
        },
      },
      presets: {
        Partial: { strength: 0.35 },
        Half: { strength: 0.5 },
        Full: { strength: 1.0 },
      },
    };
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available');
      return;
    }

    this._quadScene = new THREE.Scene();
    this._quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uStrength: { value: this.params.strength }
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uStrength;
        varying vec2 vUv;

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec3 inverted = vec3(1.0) - base.rgb;
          vec3 color = mix(base.rgb, inverted, uStrength);
          gl_FragColor = vec4(color, base.a);
        }
      `,
      depthWrite: false,
      depthTest: false,
      toneMapped: false
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    this._mesh = new THREE.Mesh(geometry, this._material);
    this._quadScene.add(this._mesh);

    this._initialized = true;
  }

  update(timeInfo) {
    if (!this._initialized || !this._material) return;
    this._material.uniforms.uStrength.value = this.params.strength;
  }

  render(renderer, camera, inputRT, outputRT) {
    if (!this._enabled || !this._initialized || !this._material) return false;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    this._material.uniforms.tDiffuse.value = inputRT.texture;

    renderer.setRenderTarget(outputRT);
    renderer.autoClear = false;
    renderer.render(this._quadScene, this._quadCamera);

    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);

    return true;
  }

  onResize(width, height) {
    // No internal RTs to resize
  }

  dispose() {
    if (this._material) {
      this._material.dispose();
      this._material = null;
    }
    if (this._mesh) {
      if (this._mesh.geometry) this._mesh.geometry.dispose();
      this._mesh = null;
    }
    this._quadScene = null;
    this._quadCamera = null;
    this._initialized = false;
  }
}
