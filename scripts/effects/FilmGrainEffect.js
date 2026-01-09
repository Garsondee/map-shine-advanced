import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';

const log = createLogger('FilmGrainEffect');

export class FilmGrainEffect extends EffectBase {
  constructor() {
    super('filmGrain', RenderLayers.POST_PROCESSING, 'low');

    this.enabled = false;

    this.priority = 110;
    this.alwaysRender = false;

    this.quadScene = null;
    this.quadCamera = null;
    this.mesh = null;
    this.material = null;

    this._readBuffer = null;
    this._writeBuffer = null;
    this._inputTexture = null;

    this._tempResolution = null;

    this.params = {
      enabled: false,
      intensity: 0.12,
      grayscale: false,
      scale: 1.0,
      speed: 1.0
    };
  }

  static getControlSchema() {
    return {
      enabled: false,
      groups: [
        {
          name: 'filmGrain',
          label: 'Film Grain',
          type: 'inline',
          parameters: ['intensity', 'scale', 'speed', 'grayscale']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: false, hidden: true },
        intensity: { type: 'slider', min: 0.0, max: 1.0, step: 0.01, default: 0.12 },
        scale: { type: 'slider', min: 0.25, max: 6.0, step: 0.05, default: 1.0 },
        speed: { type: 'slider', min: 0.0, max: 4.0, step: 0.05, default: 1.0 },
        grayscale: { type: 'boolean', default: false }
      },
      presets: {
        Off: { intensity: 0.0, scale: 1.0, speed: 1.0, grayscale: false },
        Subtle: { intensity: 0.08, scale: 1.0, speed: 1.0, grayscale: false },
        Cinematic: { intensity: 0.18, scale: 1.4, speed: 1.2, grayscale: false },
        Noir: { intensity: 0.22, scale: 1.2, speed: 1.0, grayscale: true }
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

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0.0 },
        uIntensity: { value: this.params.intensity },
        uGrayscale: { value: this.params.grayscale ? 1.0 : 0.0 },
        uScale: { value: this.params.scale },
        uSpeed: { value: this.params.speed },
        uResolution: { value: this._tempResolution }
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>

        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uIntensity;
        uniform float uGrayscale;
        uniform float uScale;
        uniform float uSpeed;
        uniform vec2 uResolution;

        varying vec2 vUv;

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);

          vec2 px = vUv * uResolution;
          float t = uTime * uSpeed;
          float n = rand(fract(px * uScale * 0.01 + vec2(t, t * 1.37)));

          vec3 noisy = base.rgb + base.rgb * clamp(0.1 + n, 0.0, 1.0);
          vec3 color = mix(base.rgb, noisy, uIntensity);

          if (uGrayscale > 0.5) {
            float l = luminance(color);
            color = vec3(l);
          }

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

    if (timeInfo && typeof timeInfo.elapsed === 'number') {
      u.uTime.value = timeInfo.elapsed;
    }

    u.uIntensity.value = p.intensity;
    u.uGrayscale.value = p.grayscale ? 1.0 : 0.0;
    u.uScale.value = p.scale;
    u.uSpeed.value = p.speed;
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
      if (this.material.uniforms.uResolution) {
        this.material.uniforms.uResolution.value.set(w, h);
      }
    }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.quadScene, this.quadCamera);
    renderer.autoClear = prevAutoClear;
  }
}
