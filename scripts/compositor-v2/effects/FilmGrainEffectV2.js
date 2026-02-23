/**
 * @fileoverview FilmGrainEffectV2 — V2 screen-space film grain post-processing pass.
 *
 * Adds animated noise grain to the final image for a cinematic look.
 * Disabled by default — optional artistic effect.
 *
 * @module compositor-v2/effects/FilmGrainEffectV2
 */

import { createLogger } from '../../core/log.js';

const log = createLogger('FilmGrainEffectV2');

export class FilmGrainEffectV2 {
  constructor() {
    this._initialized = false;

    this.params = {
      enabled: false,
      intensity: 0.12,
      grayscale: false,
      scale: 1.0,
      speed: 1.0,
    };

    /** @type {THREE.Scene|null} */
    this._composeScene = null;
    /** @type {THREE.OrthographicCamera|null} */
    this._composeCamera = null;
    /** @type {THREE.ShaderMaterial|null} */
    this._composeMaterial = null;
    /** @type {THREE.Mesh|null} */
    this._composeQuad = null;
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE) return;

    this._composeScene = new THREE.Scene();
    this._composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    this._composeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse:     { value: null },
        uTime:        { value: 0.0 },
        uIntensity:   { value: 0.12 },
        uGrayscale:   { value: 0.0 },
        uScale:       { value: 1.0 },
        uSpeed:       { value: 1.0 },
        uResolution:  { value: new THREE.Vector2(1, 1) },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uIntensity;
        uniform float uGrayscale;
        uniform float uScale;
        uniform float uSpeed;
        uniform vec2 uResolution;
        varying vec2 vUv;

        // Inline rand (from Three.js common chunk)
        float rand(vec2 co) {
          return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
        }

        float luminance(vec3 c) {
          return dot(c, vec3(0.2126, 0.7152, 0.0722));
        }

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
      depthTest: false,
      depthWrite: false,
    });
    this._composeMaterial.toneMapped = false;

    this._composeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      this._composeMaterial
    );
    this._composeQuad.frustumCulled = false;
    this._composeScene.add(this._composeQuad);

    this._initialized = true;
    log.info('FilmGrainEffectV2 initialized');
  }

  update(timeInfo) {
    if (!this._initialized || !this._composeMaterial) return;
    if (!this.params.enabled) return;

    const u = this._composeMaterial.uniforms;
    u.uTime.value = timeInfo.elapsed;
    u.uIntensity.value = this.params.intensity;
    u.uGrayscale.value = this.params.grayscale ? 1.0 : 0.0;
    u.uScale.value = this.params.scale;
    u.uSpeed.value = this.params.speed;
  }

  render(renderer, inputRT, outputRT) {
    if (!this._initialized || !this._composeMaterial || !inputRT) return;
    if (!this.params.enabled) return;

    this._composeMaterial.uniforms.tDiffuse.value = inputRT.texture;
    this._composeMaterial.uniforms.uResolution.value.set(inputRT.width, inputRT.height);

    const prevTarget = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    renderer.setRenderTarget(outputRT);
    renderer.autoClear = true;
    renderer.render(this._composeScene, this._composeCamera);
    renderer.autoClear = prevAutoClear;
    renderer.setRenderTarget(prevTarget);
  }

  dispose() {
    try { this._composeMaterial?.dispose(); } catch (_) {}
    try { this._composeQuad?.geometry?.dispose(); } catch (_) {}
    this._composeScene = null;
    this._composeCamera = null;
    this._composeMaterial = null;
    this._composeQuad = null;
    this._initialized = false;
    log.info('FilmGrainEffectV2 disposed');
  }
}
