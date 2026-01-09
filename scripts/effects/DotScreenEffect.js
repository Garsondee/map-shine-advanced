import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('DotScreenEffect');

export class DotScreenEffect extends EffectBase {
  constructor() {
    super('dotScreen', RenderLayers.POST_PROCESSING, 'low');

    this.enabled = false;

    this.priority = 120;
    this.alwaysRender = false;

    this.quadScene = null;
    this.quadCamera = null;
    this.mesh = null;
    this.material = null;

    this._readBuffer = null;
    this._writeBuffer = null;
    this._inputTexture = null;

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

  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'dotScreen',
          label: 'Dot Screen',
          type: 'inline',
          parameters: ['strength', 'scale', 'angle']
        },
        {
          name: 'center',
          label: 'Center',
          type: 'inline',
          parameters: ['centerX', 'centerY']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },
        strength: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.85 },
        scale: { type: 'slider', min: 0.1, max: 10.0, step: 0.05, default: 1.6 },
        angle: { type: 'slider', min: 0.0, max: 6.283185307179586, step: 0.01, default: 1.57 },
        centerX: { type: 'slider', min: 0.0, max: 1.0, step: 0.001, default: 0.5 },
        centerY: { type: 'slider', min: 0.0, max: 1.0, step: 0.001, default: 0.5 }
      },
      presets: {
        Off: { strength: 0.0, scale: 1.6, angle: 1.57, centerX: 0.5, centerY: 0.5 },
        Subtle: { strength: 0.35, scale: 1.8, angle: 1.57, centerX: 0.5, centerY: 0.5 },
        Classic: { strength: 0.85, scale: 1.6, angle: 1.57, centerX: 0.5, centerY: 0.5 },
        Diagonal: { strength: 0.85, scale: 1.6, angle: 0.785, centerX: 0.5, centerY: 0.5 }
      }
    };
  }

  initialize(renderer, scene, camera) {
    const THREE = window.THREE;
    if (!THREE) {
      log.error('THREE not available');
      return;
    }

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._tempResolution = new THREE.Vector2(1, 1);
    this._centerVec = new THREE.Vector2(this.params.centerX, this.params.centerY);

    this.material = new THREE.ShaderMaterial({
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
      depthTest: false
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.quadScene.add(this.mesh);
  }

  setInputTexture(texture) {
    this._inputTexture = texture;
    if (this.material?.uniforms?.tDiffuse) {
      this.material.uniforms.tDiffuse.value = texture;
    }
  }

  setBuffers(readBuffer, writeBuffer) {
    this._readBuffer = readBuffer;
    this._writeBuffer = writeBuffer;
  }

  update(timeInfo) {
    if (!this.material) return;

    const u = this.material.uniforms;
    const p = this.params;

    u.uStrength.value = p.strength;
    u.scale.value = p.scale;
    u.angle.value = p.angle;

    if (this._centerVec) {
      this._centerVec.set(p.centerX, p.centerY);
    }
  }

  render(renderer, scene, camera) {
    if (!this.material) return;

    const inputTexture =
      this.material.uniforms?.tDiffuse?.value ||
      this._readBuffer?.texture ||
      this._inputTexture;

    if (inputTexture) {
      this.material.uniforms.tDiffuse.value = inputTexture;
    }

    if (this._tempResolution) {
      renderer.getDrawingBufferSize(this._tempResolution);
      const w = Math.max(1, this._tempResolution.x);
      const h = Math.max(1, this._tempResolution.y);
      if (this.material.uniforms.tSize) {
        this.material.uniforms.tSize.value.set(w, h);
      }
    }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCamera);
    renderer.autoClear = prevAutoClear;
  }
}
