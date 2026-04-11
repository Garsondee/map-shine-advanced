import { createLogger } from '../../core/log.js';

const log = createLogger('DotScreenEffectV2');

/**
 * DotScreenEffectV2 - Artistic dot-screen halftone filter
 * 
 * Archetype: C (Post-Processing Effect)
 * Converts the scene into a dot-screen pattern (newspaper/comic book style).
 * Disabled by default - users opt in via control panel.
 */
export class DotScreenEffectV2 {
  constructor() {
    this._enabled = false;
    this._initialized = false;

    this._quadScene = null;
    this._quadCamera = null;
    this._mesh = null;
    this._material = null;

    this._tempResolution = null;
    this._centerVec = null;

    this.params = {
      enabled: false,
      strength: 0.85,
      scale: 1.6,
      angle: 1.57,
      centerX: 0.5,
      centerY: 0.5
    };
  }

  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
  }

  static getControlSchema() {
    const centerDefault = { centerX: 0.5, centerY: 0.5 };

    return {
      enabled: false,
      help: {
        title: 'Dot screen (halftone)',
        summary: [
          'Stylized halftone: the image is mixed with a rotated sine grid so bright areas read as a dot pattern (print / comic look).',
          'Purely artistic — no masks. Runs as fullscreen post-processing on the composited frame.',
          'Performance: single fullscreen pass; typically inexpensive.',
          'Persistence: settings save with the scene (not World Based).',
        ].join('\n\n'),
        glossary: {
          Strength: 'Blend between the original image and the dot pattern (0 = original only).',
          Scale: 'Dot density / fineness; higher values pack more pattern into the frame.',
          Angle: 'Grid rotation in radians (0 to ~2π).',
          'Center X / Y': 'Pattern origin in normalized UV (0–1), relative to the render.',
        },
      },
      groups: [
        {
          name: 'look',
          label: 'Look',
          type: 'folder',
          expanded: true,
          parameters: ['strength', 'scale', 'angle'],
        },
        {
          name: 'center',
          label: 'Center',
          type: 'folder',
          expanded: false,
          parameters: ['centerX', 'centerY'],
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
          default: 0.85,
          tooltip: 'How much of the dot pattern is mixed in (0 = bypass).',
        },
        scale: {
          type: 'slider',
          label: 'Scale',
          min: 0.1,
          max: 10.0,
          step: 0.05,
          default: 1.6,
          tooltip: 'Fineness of the dot grid (higher = smaller / denser dots).',
        },
        angle: {
          type: 'slider',
          label: 'Angle (rad)',
          min: 0.0,
          max: 6.283185307179586,
          step: 0.01,
          default: 1.57,
          tooltip: 'Rotation of the halftone grid in radians.',
        },
        centerX: {
          type: 'slider',
          label: 'Center X',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.5,
          tooltip: 'Horizontal pattern origin in UV space (0 = left, 1 = right).',
        },
        centerY: {
          type: 'slider',
          label: 'Center Y',
          min: 0.0,
          max: 1.0,
          step: 0.001,
          default: 0.5,
          tooltip: 'Vertical pattern origin in UV space (0 = bottom, 1 = top).',
        },
      },
      presets: {
        Subtle: {
          strength: 0.35,
          scale: 1.8,
          angle: 1.57,
          ...centerDefault,
        },
        Classic: {
          strength: 0.85,
          scale: 1.6,
          angle: 1.57,
          ...centerDefault,
        },
        Diagonal: {
          strength: 0.85,
          scale: 1.6,
          angle: 0.785,
          ...centerDefault,
        },
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

    this._tempResolution = new THREE.Vector2(1, 1);
    this._centerVec = new THREE.Vector2(this.params.centerX, this.params.centerY);

    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tSize: { value: this._tempResolution },
        center: { value: this._centerVec },
        angle: { value: this.params.angle },
        scale: { value: this.params.scale },
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
        uniform vec2 center;
        uniform float angle;
        uniform float scale;
        uniform vec2 tSize;
        uniform float uStrength;
        uniform sampler2D tDiffuse;
        varying vec2 vUv;

        float pattern() {
          float s = sin(angle), c = cos(angle);
          vec2 tex = vUv * tSize - center * tSize;
          vec2 point = vec2(c * tex.x - s * tex.y, s * tex.x + c * tex.y) * scale;
          return (sin(point.x) * sin(point.y)) * 4.0;
        }

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          float average = (base.r + base.g + base.b) / 3.0;
          vec3 dots = vec3(average * 10.0 - 5.0 + pattern());
          vec3 color = mix(base.rgb, dots, clamp(uStrength, 0.0, 1.0));
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

    const u = this._material.uniforms;
    const p = this.params;

    u.uStrength.value = p.strength;
    u.scale.value = p.scale;
    u.angle.value = p.angle;

    if (this._centerVec) {
      this._centerVec.set(p.centerX, p.centerY);
    }
  }

  render(renderer, camera, inputRT, outputRT) {
    if (!this._enabled || !this._initialized || !this._material) return false;

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;

    this._material.uniforms.tDiffuse.value = inputRT.texture;

    if (this._tempResolution) {
      renderer.getDrawingBufferSize(this._tempResolution);
      const w = Math.max(1, this._tempResolution.x);
      const h = Math.max(1, this._tempResolution.y);
      if (this._material.uniforms.tSize) {
        this._material.uniforms.tSize.value.set(w, h);
      }
    }

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
    this._tempResolution = null;
    this._centerVec = null;
    this._initialized = false;
  }
}
