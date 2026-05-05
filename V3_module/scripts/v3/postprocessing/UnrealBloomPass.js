/**
 * @fileoverview Three.js r170 `UnrealBloomPass` + minimal `Pass` / `FullScreenQuad`
 * adapted from `examples/jsm/postprocessing` — imports core from
 * `../../vendor/three.module.js` because the vendored bundle omits postprocessing.
 *
 * Differences from stock `FullScreenQuad.dispose()`:
 *   Uses a **per-instance** `PlaneGeometry(2,2)` so disposing one pass does not
 *   dispose a module-singleton triangle mesh (stock `Pass.js` shares geometry
 *   across all quads, which breaks a second `UnrealBloomPass` after the first
 *   `dispose()` — relevant for V3 remount cycles).
 *
 * `LuminosityHighPassShader` uses an inlined luminance (stock shader calls
 * `luminance()` which relies on shader chunks not injected for plain
 * `ShaderMaterial` in all paths).
 *
 * @see https://github.com/mrdoob/three.js/blob/r170/examples/jsm/postprocessing/UnrealBloomPass.js
 * @module v3/postprocessing/UnrealBloomPass
 */

import * as THREE from "../../vendor/three.module.js";

class Pass {
  constructor() {
    this.isPass = true;
    this.enabled = true;
    this.needsSwap = true;
    this.clear = false;
    this.renderToScreen = false;
  }
  setSize() {}
  render() {
    console.error("THREE.Pass: .render() must be implemented in derived pass.");
  }
  dispose() {}
}

const _fsqCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

class FullScreenQuad {
  /**
   * @param {THREE.Material|null} material
   */
  constructor(material) {
    const geo = new THREE.PlaneGeometry(2, 2);
    /** @private */
    this._geometry = geo;
    this._mesh = new THREE.Mesh(geo, material);
    this._mesh.frustumCulled = false;
  }

  dispose() {
    try {
      this._geometry?.dispose();
    } catch (_) {}
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   */
  render(renderer) {
    renderer.render(this._mesh, _fsqCamera);
  }

  get material() {
    return this._mesh.material;
  }

  /** @param {THREE.Material|null} value */
  set material(value) {
    this._mesh.material = value;
  }
}

const CopyShader = {
  name: "CopyShader",
  uniforms: {
    tDiffuse: { value: null },
    opacity: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float opacity;
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      gl_FragColor = opacity * texel;
    }
  `,
};

const LuminosityHighPassShader = {
  name: "LuminosityHighPassShader",
  shaderID: "luminosityHighPass",
  uniforms: {
    tDiffuse: { value: null },
    luminosityThreshold: { value: 1.0 },
    smoothWidth: { value: 1.0 },
    defaultColor: { value: new THREE.Color(0x000000) },
    defaultOpacity: { value: 0.0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 defaultColor;
    uniform float defaultOpacity;
    uniform float luminosityThreshold;
    uniform float smoothWidth;
    varying vec2 vUv;

    float lumaThree(const in vec3 rgb) {
      const vec3 weights = vec3(0.2126729, 0.7151522, 0.0721750);
      return dot(weights, rgb);
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      float v = lumaThree(texel.xyz);
      vec4 outputColor = vec4(defaultColor.rgb, defaultOpacity);
      float alpha = smoothstep(luminosityThreshold, luminosityThreshold + smoothWidth, v);
      gl_FragColor = mix(outputColor, texel, alpha);
    }
  `,
};

/**
 * Unreal-style bloom (mip blur chain). API matches three.js r170
 * `examples/jsm/postprocessing/UnrealBloomPass.js`.
 */
export class UnrealBloomPass extends Pass {
  /**
   * @param {THREE.Vector2} resolution
   * @param {number} [strength]
   * @param {number} [radius]
   * @param {number} [threshold]
   */
  constructor(resolution, strength, radius, threshold) {
    super();
    this.strength = strength !== undefined ? strength : 1;
    this.radius = radius;
    this.threshold = threshold;
    this.resolution =
      resolution !== undefined
        ? new THREE.Vector2(resolution.x, resolution.y)
        : new THREE.Vector2(256, 256);
    this.clearColor = new THREE.Color(0, 0, 0);

    /** @type {THREE.WebGLRenderTarget[]} */
    this.renderTargetsHorizontal = [];
    /** @type {THREE.WebGLRenderTarget[]} */
    this.renderTargetsVertical = [];
    this.nMips = 5;
    let resx = Math.round(this.resolution.x / 2);
    let resy = Math.round(this.resolution.y / 2);

    this.renderTargetBright = new THREE.WebGLRenderTarget(resx, resy, {
      type: THREE.HalfFloatType,
    });
    this.renderTargetBright.texture.name = "UnrealBloomPass.bright";
    this.renderTargetBright.texture.generateMipmaps = false;

    for (let i = 0; i < this.nMips; i++) {
      const renderTargetHorizontal = new THREE.WebGLRenderTarget(resx, resy, {
        type: THREE.HalfFloatType,
      });
      renderTargetHorizontal.texture.name = "UnrealBloomPass.h" + i;
      renderTargetHorizontal.texture.generateMipmaps = false;
      this.renderTargetsHorizontal.push(renderTargetHorizontal);

      const renderTargetVertical = new THREE.WebGLRenderTarget(resx, resy, {
        type: THREE.HalfFloatType,
      });
      renderTargetVertical.texture.name = "UnrealBloomPass.v" + i;
      renderTargetVertical.texture.generateMipmaps = false;
      this.renderTargetsVertical.push(renderTargetVertical);

      resx = Math.round(resx / 2);
      resy = Math.round(resy / 2);
    }

    const highPassShader = LuminosityHighPassShader;
    this.highPassUniforms = THREE.UniformsUtils.clone(highPassShader.uniforms);
    this.highPassUniforms.luminosityThreshold.value = threshold;
    this.highPassUniforms.smoothWidth.value = 0.01;
    this.materialHighPassFilter = new THREE.ShaderMaterial({
      uniforms: this.highPassUniforms,
      vertexShader: highPassShader.vertexShader,
      fragmentShader: highPassShader.fragmentShader,
    });

    this.separableBlurMaterials = [];
    const kernelSizeArray = [3, 5, 7, 9, 11];
    resx = Math.round(this.resolution.x / 2);
    resy = Math.round(this.resolution.y / 2);
    for (let i = 0; i < this.nMips; i++) {
      this.separableBlurMaterials.push(this.getSeperableBlurMaterial(kernelSizeArray[i]));
      this.separableBlurMaterials[i].uniforms.invSize.value = new THREE.Vector2(1 / resx, 1 / resy);
      resx = Math.round(resx / 2);
      resy = Math.round(resy / 2);
    }

    this.compositeMaterial = this.getCompositeMaterial(this.nMips);
    this.compositeMaterial.uniforms.blurTexture1.value = this.renderTargetsVertical[0].texture;
    this.compositeMaterial.uniforms.blurTexture2.value = this.renderTargetsVertical[1].texture;
    this.compositeMaterial.uniforms.blurTexture3.value = this.renderTargetsVertical[2].texture;
    this.compositeMaterial.uniforms.blurTexture4.value = this.renderTargetsVertical[3].texture;
    this.compositeMaterial.uniforms.blurTexture5.value = this.renderTargetsVertical[4].texture;
    this.compositeMaterial.uniforms.bloomStrength.value = strength;
    this.compositeMaterial.uniforms.bloomRadius.value = 0.1;
    const bloomFactors = [1.0, 0.8, 0.6, 0.4, 0.2];
    this.compositeMaterial.uniforms.bloomFactors.value = bloomFactors;
    this.bloomTintColors = [
      new THREE.Vector3(1, 1, 1),
      new THREE.Vector3(1, 1, 1),
      new THREE.Vector3(1, 1, 1),
      new THREE.Vector3(1, 1, 1),
      new THREE.Vector3(1, 1, 1),
    ];
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors;

    const copyShader = CopyShader;
    this.copyUniforms = THREE.UniformsUtils.clone(copyShader.uniforms);
    this.blendMaterial = new THREE.ShaderMaterial({
      uniforms: this.copyUniforms,
      vertexShader: copyShader.vertexShader,
      fragmentShader: copyShader.fragmentShader,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });

    this.enabled = true;
    this.needsSwap = false;
    this._oldClearColor = new THREE.Color();
    this.oldClearAlpha = 1;
    this.basic = new THREE.MeshBasicMaterial();
    this.fsQuad = new FullScreenQuad(null);
  }

  dispose() {
    for (let i = 0; i < this.renderTargetsHorizontal.length; i++) {
      this.renderTargetsHorizontal[i].dispose();
    }
    for (let i = 0; i < this.renderTargetsVertical.length; i++) {
      this.renderTargetsVertical[i].dispose();
    }
    this.renderTargetBright.dispose();
    for (let i = 0; i < this.separableBlurMaterials.length; i++) {
      this.separableBlurMaterials[i].dispose();
    }
    this.compositeMaterial.dispose();
    this.blendMaterial.dispose();
    this.basic.dispose();
    this.fsQuad.dispose();
  }

  /**
   * @param {number} width
   * @param {number} height
   */
  setSize(width, height) {
    let resx = Math.round(width / 2);
    let resy = Math.round(height / 2);
    this.renderTargetBright.setSize(resx, resy);
    for (let i = 0; i < this.nMips; i++) {
      this.renderTargetsHorizontal[i].setSize(resx, resy);
      this.renderTargetsVertical[i].setSize(resx, resy);
      this.separableBlurMaterials[i].uniforms.invSize.value = new THREE.Vector2(1 / resx, 1 / resy);
      resx = Math.round(resx / 2);
      resy = Math.round(resy / 2);
    }
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.WebGLRenderTarget|null} writeBuffer
   * @param {THREE.WebGLRenderTarget} readBuffer
   * @param {number} _deltaTime
   * @param {boolean} maskActive
   */
  render(renderer, writeBuffer, readBuffer, _deltaTime, maskActive) {
    renderer.getClearColor(this._oldClearColor);
    this.oldClearAlpha = renderer.getClearAlpha();
    const oldAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setClearColor(this.clearColor, 0);
    if (maskActive) renderer.state.buffers.stencil.setTest(false);

    if (this.renderToScreen) {
      this.fsQuad.material = this.basic;
      this.basic.map = readBuffer.texture;
      renderer.setRenderTarget(null);
      renderer.clear();
      this.fsQuad.render(renderer);
    }

    this.highPassUniforms.tDiffuse.value = readBuffer.texture;
    this.highPassUniforms.luminosityThreshold.value = this.threshold;
    this.fsQuad.material = this.materialHighPassFilter;
    renderer.setRenderTarget(this.renderTargetBright);
    renderer.clear();
    this.fsQuad.render(renderer);

    let inputRenderTarget = this.renderTargetBright;
    for (let i = 0; i < this.nMips; i++) {
      this.fsQuad.material = this.separableBlurMaterials[i];
      this.separableBlurMaterials[i].uniforms.colorTexture.value = inputRenderTarget.texture;
      this.separableBlurMaterials[i].uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      renderer.setRenderTarget(this.renderTargetsHorizontal[i]);
      renderer.clear();
      this.fsQuad.render(renderer);
      this.separableBlurMaterials[i].uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture;
      this.separableBlurMaterials[i].uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      renderer.setRenderTarget(this.renderTargetsVertical[i]);
      renderer.clear();
      this.fsQuad.render(renderer);
      inputRenderTarget = this.renderTargetsVertical[i];
    }

    this.fsQuad.material = this.compositeMaterial;
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength;
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius;
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors;
    renderer.setRenderTarget(this.renderTargetsHorizontal[0]);
    renderer.clear();
    this.fsQuad.render(renderer);

    this.fsQuad.material = this.blendMaterial;
    this.copyUniforms.tDiffuse.value = this.renderTargetsHorizontal[0].texture;
    if (maskActive) renderer.state.buffers.stencil.setTest(true);
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
      this.fsQuad.render(renderer);
    } else {
      renderer.setRenderTarget(readBuffer);
      this.fsQuad.render(renderer);
    }

    renderer.setClearColor(this._oldClearColor, this.oldClearAlpha);
    renderer.autoClear = oldAutoClear;
  }

  /**
   * @param {number} kernelRadius
   */
  getSeperableBlurMaterial(kernelRadius) {
    const coefficients = [];
    for (let i = 0; i < kernelRadius; i++) {
      coefficients.push(
        (0.39894 * Math.exp(-0.5 * (i * i) / (kernelRadius * kernelRadius))) / kernelRadius,
      );
    }
    return new THREE.ShaderMaterial({
      defines: { KERNEL_RADIUS: kernelRadius },
      uniforms: {
        colorTexture: { value: null },
        invSize: { value: new THREE.Vector2(0.5, 0.5) },
        direction: { value: new THREE.Vector2(0.5, 0.5) },
        gaussianCoefficients: { value: coefficients },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        varying vec2 vUv;
        uniform sampler2D colorTexture;
        uniform vec2 invSize;
        uniform vec2 direction;
        uniform float gaussianCoefficients[KERNEL_RADIUS];
        void main() {
          float weightSum = gaussianCoefficients[0];
          vec3 diffuseSum = texture2D(colorTexture, vUv).rgb * weightSum;
          for (int i = 1; i < KERNEL_RADIUS; i++) {
            float x = float(i);
            float w = gaussianCoefficients[i];
            vec2 uvOffset = direction * invSize * x;
            vec3 sample1 = texture2D(colorTexture, vUv + uvOffset).rgb;
            vec3 sample2 = texture2D(colorTexture, vUv - uvOffset).rgb;
            diffuseSum += (sample1 + sample2) * w;
            weightSum += 2.0 * w;
          }
          gl_FragColor = vec4(diffuseSum / weightSum, 1.0);
        }
      `,
    });
  }

  /**
   * @param {number} nMips
   */
  getCompositeMaterial(nMips) {
    return new THREE.ShaderMaterial({
      defines: { NUM_MIPS: nMips },
      uniforms: {
        blurTexture1: { value: null },
        blurTexture2: { value: null },
        blurTexture3: { value: null },
        blurTexture4: { value: null },
        blurTexture5: { value: null },
        bloomStrength: { value: 1.0 },
        bloomFactors: { value: null },
        bloomTintColors: { value: null },
        bloomRadius: { value: 0.0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        uniform sampler2D blurTexture1;
        uniform sampler2D blurTexture2;
        uniform sampler2D blurTexture3;
        uniform sampler2D blurTexture4;
        uniform sampler2D blurTexture5;
        uniform float bloomStrength;
        uniform float bloomRadius;
        uniform float bloomFactors[NUM_MIPS];
        uniform vec3 bloomTintColors[NUM_MIPS];
        float lerpBloomFactor(const in float factor) {
          float mirrorFactor = 1.2 - factor;
          return mix(factor, mirrorFactor, bloomRadius);
        }
        void main() {
          gl_FragColor = bloomStrength * (
            lerpBloomFactor(bloomFactors[0]) * vec4(bloomTintColors[0], 1.0) * texture2D(blurTexture1, vUv) +
            lerpBloomFactor(bloomFactors[1]) * vec4(bloomTintColors[1], 1.0) * texture2D(blurTexture2, vUv) +
            lerpBloomFactor(bloomFactors[2]) * vec4(bloomTintColors[2], 1.0) * texture2D(blurTexture3, vUv) +
            lerpBloomFactor(bloomFactors[3]) * vec4(bloomTintColors[3], 1.0) * texture2D(blurTexture4, vUv) +
            lerpBloomFactor(bloomFactors[4]) * vec4(bloomTintColors[4], 1.0) * texture2D(blurTexture5, vUv)
          );
        }
      `,
    });
  }
}

UnrealBloomPass.BlurDirectionX = new THREE.Vector2(1.0, 0.0);
UnrealBloomPass.BlurDirectionY = new THREE.Vector2(0.0, 1.0);
