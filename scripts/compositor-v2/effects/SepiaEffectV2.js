import { createLogger } from '../../core/log.js';

const log = createLogger('SepiaEffectV2');

/**
 * SepiaEffectV2 - Sepia tone effect
 * 
 * Archetype: C (Post-Processing Effect)
 * Classic sepia tone color grading effect.
 * Disabled by default - users opt in via control panel.
 */
export class SepiaEffectV2 {
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
        title: 'Sepia tone',
        summary: [
          'Warm brown photo grade by mixing the scene toward a classic sepia transform (photographic-style matrix).',
          'Stylistic only — no masks. One fullscreen post pass on the composited image.',
          'Performance: very cheap (single pass, simple shader).',
          'Persistence: settings save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          Strength: 'Blend between the original image and full sepia (0 = original, 1 = full sepia).',
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
          tooltip: 'How much sepia is mixed in (0 leaves the image unchanged).',
        },
      },
      presets: {
        Soft: { strength: 0.35 },
        Balanced: { strength: 0.65 },
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
          vec3 color = base.rgb;
          
          // Standard sepia matrix
          vec3 sepia;
          sepia.r = dot(color, vec3(0.393, 0.769, 0.189));
          sepia.g = dot(color, vec3(0.349, 0.686, 0.168));
          sepia.b = dot(color, vec3(0.272, 0.534, 0.131));
          
          color = mix(color, sepia, uStrength);
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
