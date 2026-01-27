/**
 * @fileoverview Unreal Bloom Post-Processing Effect
 * Wraps Three.js UnrealBloomPass for high-quality bloom
 * @module effects/BloomEffect
 */

import { EffectBase, RenderLayers } from './EffectComposer.js';
import { createLogger } from '../core/log.js';
import { FoundryFogBridge } from '../vision/FoundryFogBridge.js';

const log = createLogger('BloomEffect');

// Pre-allocated NDC corner coordinates for frustum intersection (avoids per-frame allocations)
const _ndcCorners = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1]
];

export class BloomEffect extends EffectBase {
  constructor() {
    super('bloom', RenderLayers.POST_PROCESSING, 'medium');
    
    // Render BEFORE Color Correction (which is 100)
    // Scene -> Bloom -> ToneMapping -> Screen
    this.priority = 50; 
    this.alwaysRender = false;
    
    // Internal pass
    this.pass = null;
    
    // State
    this.renderToScreen = false;
    this.readBuffer = null;
    this.writeBuffer = null;
    
    this.params = {
      enabled: true,
      strength: 0.59,
      radius: 0.54,
      threshold: 0.95,
      tintColor: { r: 1, g: 1, b: 1 },
      // Controls how the bloom layer blends over the base scene
      blendOpacity: 1.0,
      blendMode: 'add' // 'add', 'screen', 'soft'
    };

    this._tintColorVec = null;
    this._lastTintR = null;
    this._lastTintG = null;
    this._lastTintB = null;

    this.fogBridge = null;

    this._viewBounds = null;

    this._tempNdc = null;
    this._tempWorld = null;
    this._tempDir = null;

    this._bloomTarget = null;

    this._maskedInputTarget = null;
    this._maskMaterial = null;
    this._maskScene = null;
    this._maskCamera = null;
    this._maskQuad = null;

    this._compositeMaterial = null;
  }

  /**
   * Get UI control schema
   */
  static getControlSchema() {
    return {
      enabled: true,
      groups: [
        {
          name: 'bloom',
          label: 'Bloom Settings',
          type: 'inline',
          parameters: ['strength', 'radius', 'threshold', 'tintColor', 'blendOpacity', 'blendMode']
        }
      ],
      parameters: {
        enabled: { type: 'boolean', default: true, hidden: true },
        strength: { type: 'slider', min: 0, max: 3, step: 0.01, default: 0.59 },
        radius: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.54 },
        threshold: { type: 'slider', min: 0, max: 1, step: 0.01, default: 0.95 },
        tintColor: { type: 'color', default: { r: 1, g: 1, b: 1 } },
        blendOpacity: { type: 'slider', min: 0, max: 1, step: 0.01, default: 1.0 },
        // Tweakpane expects an options map: label -> value
        blendMode: {
          type: 'select',
          options: {
            'Additive': 'add',
            'Screen': 'screen',
            'Soft Light': 'soft'
          },
          default: 'add'
        }
      },
      presets: {
        'Subtle': { strength: 0.8, radius: 0.2, threshold: 0.9 },
        'Strong': { strength: 2.0, radius: 0.8, threshold: 0.7 },
        'Dreamy': { strength: 1.5, radius: 1.0, threshold: 0.6 },
        'Neon': { strength: 2.5, radius: 0.3, threshold: 0.2 }
      }
    };
  }

  /**
   * Initialize the effect
   */
  initialize(renderer, scene, camera) {
    log.info('Initializing BloomEffect (UnrealBloomPass)');
    
    const THREE = window.THREE;
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    
    // Create the pass
    this.pass = new THREE.UnrealBloomPass(
      size,
      this.params.strength,
      this.params.radius,
      this.params.threshold
    );

    this.fogBridge = new FoundryFogBridge(renderer);
    this.fogBridge.initialize();

    this._viewBounds = new THREE.Vector4(0, 0, 1, 1);

    if (this.pass?.blendMaterial?.uniforms && this.pass?.blendMaterial?.fragmentShader) {
      const u = this.pass.blendMaterial.uniforms;

      if (!u.tVision) u.tVision = { value: null };
      if (!u.uMaskEnabled) u.uMaskEnabled = { value: 1.0 };
      if (!u.uVisionThreshold) u.uVisionThreshold = { value: 0.1 };

      // Softness is specified in *pixels* and converted to UV using uVisionTexelSize.
      // This keeps the edge stable across resolution changes.
      if (!u.uVisionSoftnessPx) u.uVisionSoftnessPx = { value: 2.0 };

      u.uVisionSoftnessPx.value = 4.0;

      // Mapping uniforms for screenUv -> Foundry coords -> sceneUv
      if (!u.uViewBounds) u.uViewBounds = { value: this._viewBounds };
      if (!u.uSceneDimensions) u.uSceneDimensions = { value: new THREE.Vector2(1.0, 1.0) };
      if (!u.uSceneRect) u.uSceneRect = { value: new THREE.Vector4(0.0, 0.0, 1.0, 1.0) };
      if (!u.uHasSceneRect) u.uHasSceneRect = { value: 0.0 };
      if (!u.uVisionTexelSize) u.uVisionTexelSize = { value: new THREE.Vector2(1.0, 1.0) };

      this.pass.blendMaterial.fragmentShader = `
        uniform float opacity;
        uniform sampler2D tDiffuse;
        uniform sampler2D tVision;
        uniform float uMaskEnabled;
        uniform float uVisionThreshold;
        uniform float uVisionSoftnessPx;

        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;
        uniform vec2 uVisionTexelSize;
        varying vec2 vUv;

        vec2 screenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          float foundryX = threeX;
          float foundryY = uSceneDimensions.y - threeY;
          return vec2(foundryX, foundryY);
        }

        vec2 foundryToSceneUv(vec2 foundryPos) {
          vec2 sceneOrigin = uSceneRect.xy;
          vec2 sceneSize = uSceneRect.zw;
          return (foundryPos - sceneOrigin) / sceneSize;
        }

        float sampleBlur4(sampler2D tex, vec2 uv, vec2 texel) {
          float c = texture2D(tex, uv).r;
          float l = texture2D(tex, uv + vec2(-texel.x, 0.0)).r;
          float r = texture2D(tex, uv + vec2(texel.x, 0.0)).r;
          float d = texture2D(tex, uv + vec2(0.0, -texel.y)).r;
          float u = texture2D(tex, uv + vec2(0.0, texel.y)).r;
          return (c * 4.0 + l + r + d + u) / 8.0;
        }

        void main() {
          vec4 texel = texture2D( tDiffuse, vUv );

          float visible = 1.0;
          if (uMaskEnabled > 0.5) {
            // Prefer world/scene-space sampling when scene rect is available.
            vec2 uv = vUv;
            if (uHasSceneRect > 0.5) {
              vec2 foundryPos = screenUvToFoundry(vUv);
              uv = foundryToSceneUv(foundryPos);
              uv = clamp(uv, vec2(0.0), vec2(1.0));
            }

            // WorldSpaceFogEffect vision target is rendered in Foundry coords (Y-down),
            // so when sampling it from a standard UV (Y-up) we need to flip Y.
            vec2 visionUv = vec2(uv.x, 1.0 - uv.y);
            float vision = sampleBlur4(tVision, visionUv, uVisionTexelSize);
            float softness = max(uVisionTexelSize.x, uVisionTexelSize.y) * uVisionSoftnessPx;
            visible = smoothstep(uVisionThreshold - softness, uVisionThreshold + softness, vision);
          }

          gl_FragColor = opacity * texel * visible;
        }
      `;
      this.pass.blendMaterial.needsUpdate = true;
    }
    
    // Initialize bloom tint colors
    this.updateTintColor();

    // Create helper for copying buffer (fix for UnrealBloomPass writing to input)
    this.copyScene = new THREE.Scene();
    this.copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.copyMaterial = new THREE.MeshBasicMaterial({ map: null });
    this.copyQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMaterial);
    this.copyScene.add(this.copyQuad);

    // Masking material: zeros padded region outside canvas.dimensions.sceneRect.
    // This prevents bloom from being generated by (or bleeding from) pixels in padding.
    this._maskScene = new THREE.Scene();
    this._maskCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._maskMaterial = new THREE.ShaderMaterial({
      transparent: false,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        uViewBounds: { value: this._viewBounds },
        uSceneDimensions: { value: new THREE.Vector2(1.0, 1.0) },
        uSceneRect: { value: new THREE.Vector4(0.0, 0.0, 1.0, 1.0) },
        uHasSceneRect: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;
        varying vec2 vUv;

        vec2 screenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          float foundryX = threeX;
          float foundryY = uSceneDimensions.y - threeY;
          return vec2(foundryX, foundryY);
        }

        vec2 foundryToSceneUv(vec2 foundryPos) {
          vec2 sceneOrigin = uSceneRect.xy;
          vec2 sceneSize = uSceneRect.zw;
          return (foundryPos - sceneOrigin) / sceneSize;
        }

        void main() {
          vec4 c = texture2D(tDiffuse, vUv);
          if (uHasSceneRect > 0.5) {
            vec2 foundryPos = screenUvToFoundry(vUv);
            vec2 sceneUv = foundryToSceneUv(foundryPos);
            float inX = step(0.0, sceneUv.x) * step(sceneUv.x, 1.0);
            float inY = step(0.0, sceneUv.y) * step(sceneUv.y, 1.0);
            float m = inX * inY;
            c *= m;
          }
          gl_FragColor = c;
        }
      `
    });
    this._maskQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._maskMaterial);
    this._maskScene.add(this._maskQuad);

    // Additive composite material for bloom overlay (clipped to scene rect)
    this._compositeMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        tBloom: { value: null },
        opacity: { value: 1.0 },
        uViewBounds: { value: this._viewBounds },
        uSceneDimensions: { value: new THREE.Vector2(1.0, 1.0) },
        uSceneRect: { value: new THREE.Vector4(0.0, 0.0, 1.0, 1.0) },
        uHasSceneRect: { value: 0.0 }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D tBloom;
        uniform float opacity;
        uniform vec4 uViewBounds;
        uniform vec2 uSceneDimensions;
        uniform vec4 uSceneRect;
        uniform float uHasSceneRect;
        varying vec2 vUv;

        vec2 screenUvToFoundry(vec2 screenUv) {
          float threeX = mix(uViewBounds.x, uViewBounds.z, screenUv.x);
          float threeY = mix(uViewBounds.y, uViewBounds.w, screenUv.y);
          float foundryX = threeX;
          float foundryY = uSceneDimensions.y - threeY;
          return vec2(foundryX, foundryY);
        }

        vec2 foundryToSceneUv(vec2 foundryPos) {
          vec2 sceneOrigin = uSceneRect.xy;
          vec2 sceneSize = uSceneRect.zw;
          return (foundryPos - sceneOrigin) / sceneSize;
        }

        void main() {
          vec4 b = texture2D(tBloom, vUv);
          float m = 1.0;
          if (uHasSceneRect > 0.5) {
            vec2 foundryPos = screenUvToFoundry(vUv);
            vec2 sceneUv = foundryToSceneUv(foundryPos);
            float inX = step(0.0, sceneUv.x) * step(sceneUv.x, 1.0);
            float inY = step(0.0, sceneUv.y) * step(sceneUv.y, 1.0);
            m = inX * inY;
          }
          gl_FragColor = vec4(b.rgb * opacity * m, b.a * opacity * m);
        }
      `
    });
    this.bloomCompositeQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._compositeMaterial);
    this.bloomCompositeScene = new THREE.Scene();
    this.bloomCompositeScene.add(this.bloomCompositeQuad);

    // Dedicated output for bloom so we never sample from the same RT we are writing to.
    // This avoids undefined behavior that can manifest as a black screen.
    try {
      if (!this._bloomTarget) {
        this._bloomTarget = new THREE.WebGLRenderTarget(size.width, size.height, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.FloatType,
          depthBuffer: false,
          stencilBuffer: false
        });
      } else {
        this._bloomTarget.setSize(size.width, size.height);
      }

      if (!this._maskedInputTarget) {
        this._maskedInputTarget = new THREE.WebGLRenderTarget(size.width, size.height, {
          minFilter: THREE.LinearFilter,
          magFilter: THREE.LinearFilter,
          format: THREE.RGBAFormat,
          type: THREE.FloatType,
          depthBuffer: false,
          stencilBuffer: false
        });
      } else {
        this._maskedInputTarget.setSize(size.width, size.height);
      }
    } catch (_) {
    }
  }

  /**
   * Update parameters
   */
  update(timeInfo) {
    if (!this.pass) return;
    
    const p = this.params;
    
    this.pass.strength = p.strength;
    this.pass.radius = p.radius;
    this.pass.threshold = p.threshold;
    
    // Update blend material so we can control how the bloom glows over the scene
    if (this.pass.blendMaterial) {
      const THREE = window.THREE;
      // Our vendored UnrealBloomPass uses CopyShader uniforms for opacity.
      // Setting a non-uniform property can be ignored depending on the material type.
      try {
        const u = this.pass?.copyUniforms || this.pass?.blendMaterial?.uniforms;
        if (u?.opacity?.value !== undefined) u.opacity.value = p.blendOpacity;
      } catch (_) {
      }
      
      let targetBlending = THREE.AdditiveBlending;
      if (p.blendMode === 'screen') {
        // Screen-style bloom: in this custom Three build we approximate
        // "screen" using standard additive blending. This keeps the
        // mode functional without relying on undefined enums.
        targetBlending = THREE.AdditiveBlending;
      } else if (p.blendMode === 'soft') {
        // Soft light-style bloom: also approximated via additive
        // blending for compatibility with the available blending
        // constants.
        targetBlending = THREE.AdditiveBlending;
      }
      if (this.pass.blendMaterial.blending !== targetBlending) {
        this.pass.blendMaterial.blending = targetBlending;
        this.pass.blendMaterial.needsUpdate = true;
      }
    }
    
    const tc = p.tintColor;
    if (tc.r !== this._lastTintR || tc.g !== this._lastTintG || tc.b !== this._lastTintB) {
      this.updateTintColor();
      this._lastTintR = tc.r;
      this._lastTintG = tc.g;
      this._lastTintB = tc.b;
    }
  }
  
  updateTintColor() {
      if (!this.pass) return;

      const THREE = window.THREE;
      if (!THREE) return;

      if (!this._tintColorVec) this._tintColorVec = new THREE.Vector3();
      
      // Update all mips with the tint color
      const color = this._tintColorVec.set(
          this.params.tintColor.r, 
          this.params.tintColor.g, 
          this.params.tintColor.b
      );
      
      const tintColors = this.pass.bloomTintColors;
      if (tintColors) {
          for (let i = 0; i < tintColors.length; i++) {
              tintColors[i].copy(color);
          }
      }
  }

  /**
   * Set input texture (Not strictly used by UnrealBloomPass as it needs full buffers)
   */
  setInputTexture(texture) {
    // No-op, we use setBuffers
  }
  
  /**
   * Configure render destination
   */
  setRenderToScreen(toScreen) {
    this.renderToScreen = toScreen;
    if (this.pass) {
      this.pass.renderToScreen = toScreen;
    }
  }
  
  /**
   * Configure buffers (called by EffectComposer)
   */
  setBuffers(read, write) {
    this.readBuffer = read;
    this.writeBuffer = write;
  }

  /**
   * Render the effect
   */
  render(renderer, scene, camera) {
    if (!renderer || !this.readBuffer) return;

    // Ensure we never black-hole the post chain.
    const passthrough = () => {
      if (this.renderToScreen || !this.writeBuffer) {
        this.copyMaterial.map = this.readBuffer.texture;
        renderer.setRenderTarget(null);
        renderer.clear();
        renderer.render(this.copyScene, this.copyCamera);
        return;
      }
      this.copyMaterial.map = this.readBuffer.texture;
      renderer.setRenderTarget(this.writeBuffer);
      renderer.clear();
      renderer.render(this.copyScene, this.copyCamera);
    };

    // PERFORMANCE: UnrealBloomPass is expensive (multiple full-screen mips).
    // If bloom is effectively disabled, skip the entire pass and just blit the input.
    // This preserves the post chain and avoids extra mask/composite passes.
    const p = this.params;
    // IMPORTANT: Even if the effect is disabled (this.enabled = false), we must still
    // write something to the output buffer. EffectComposer clears the current output
    // target before calling effect.render(), so returning early would produce a black
    // frame and break the entire post-processing chain.
    if (!this.enabled || !p?.enabled || !(p.strength > 1e-6) || !(p.blendOpacity > 1e-6)) {
      passthrough();
      return;
    }

    if (!this.pass) {
      passthrough();
      return;
    }

    if (!this._maskedInputTarget || !this._maskMaterial) {
      // Without the masked input pre-pass we can leak bloom into padding.
      // Fail safe by passing through.
      passthrough();
      return;
    }

    // Cache rect presence separately from bloom's internal uHasSceneRect (which is currently
    // overloaded to mean "vision texture supports scene rect mapping").
    let _sceneRectAvailable = false;
    let _sceneRectX = 0;
    let _sceneRectY = 0;
    let _sceneRectW = 1;
    let _sceneRectH = 1;

    try {
      const THREE = window.THREE;
      const u = this.pass?.blendMaterial?.uniforms;

      // Default mapping inputs
      if (u?.uSceneDimensions) {
        const d = canvas?.dimensions;
        if (d && typeof d.width === 'number' && typeof d.height === 'number') {
          u.uSceneDimensions.value.set(d.width, d.height);
        }
      }
      if (u?.uSceneRect && u?.uHasSceneRect) {
        const rect = canvas?.dimensions?.sceneRect;
        if (rect && typeof rect.x === 'number' && typeof rect.y === 'number') {
          _sceneRectAvailable = true;
          _sceneRectX = rect.x;
          _sceneRectY = rect.y;
          _sceneRectW = rect.width || 1;
          _sceneRectH = rect.height || 1;
          u.uSceneRect.value.set(_sceneRectX, _sceneRectY, _sceneRectW, _sceneRectH);
          u.uHasSceneRect.value = 1.0;
        } else {
          u.uHasSceneRect.value = 0.0;
        }
      }
      if (u?.uViewBounds && camera) {
        if (camera.isOrthographicCamera) {
          const camPos = camera.position;
          const minX = camPos.x + camera.left / camera.zoom;
          const maxX = camPos.x + camera.right / camera.zoom;
          const minY = camPos.y + camera.bottom / camera.zoom;
          const maxY = camPos.y + camera.top / camera.zoom;
          u.uViewBounds.value.set(minX, minY, maxX, maxY);
        } else if (camera.isPerspectiveCamera && THREE) {
          const groundZ = window.MapShine?.sceneComposer?.groundZ ?? 0;

          if (!this._tempNdc) this._tempNdc = new THREE.Vector3();
          if (!this._tempWorld) this._tempWorld = new THREE.Vector3();
          if (!this._tempDir) this._tempDir = new THREE.Vector3();

          const origin = camera.position;
          const ndc = this._tempNdc;
          const world = this._tempWorld;
          const dir = this._tempDir;

          let minX = Infinity;
          let minY = Infinity;
          let maxX = -Infinity;
          let maxY = -Infinity;

          for (let i = 0; i < _ndcCorners.length; i++) {
            const cx = _ndcCorners[i][0];
            const cy = _ndcCorners[i][1];

            ndc.set(cx, cy, 0.5);
            world.copy(ndc).unproject(camera);

            dir.subVectors(world, origin).normalize();
            const dz = dir.z;
            if (Math.abs(dz) < 1e-6) continue;

            const t = (groundZ - origin.z) / dz;
            if (!Number.isFinite(t) || t <= 0) continue;

            const ix = origin.x + dir.x * t;
            const iy = origin.y + dir.y * t;

            if (ix < minX) minX = ix;
            if (iy < minY) minY = iy;
            if (ix > maxX) maxX = ix;
            if (iy > maxY) maxY = iy;
          }

          if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
            u.uViewBounds.value.set(minX, minY, maxX, maxY);
          }
        }
      }

      // Keep mask/composite mapping uniforms in sync with bloom view bounds/dimensions,
      // but use the *actual* sceneRect presence (padding exclusion) regardless of the
      // vision mapping decision made below.
      try {
        if (this._maskMaterial?.uniforms?.uSceneDimensions && u?.uSceneDimensions) {
          this._maskMaterial.uniforms.uSceneDimensions.value.copy(u.uSceneDimensions.value);
        }
        if (this._maskMaterial?.uniforms?.uSceneRect && u?.uSceneRect) {
          this._maskMaterial.uniforms.uSceneRect.value.set(_sceneRectX, _sceneRectY, _sceneRectW, _sceneRectH);
        }
        if (this._maskMaterial?.uniforms?.uHasSceneRect && u?.uHasSceneRect) {
          this._maskMaterial.uniforms.uHasSceneRect.value = _sceneRectAvailable ? 1.0 : 0.0;
        }
        if (this._maskMaterial?.uniforms?.uViewBounds && u?.uViewBounds) {
          this._maskMaterial.uniforms.uViewBounds.value.copy(u.uViewBounds.value);
        }

        if (this._compositeMaterial?.uniforms?.uSceneDimensions && u?.uSceneDimensions) {
          this._compositeMaterial.uniforms.uSceneDimensions.value.copy(u.uSceneDimensions.value);
        }
        if (this._compositeMaterial?.uniforms?.uSceneRect && u?.uSceneRect) {
          this._compositeMaterial.uniforms.uSceneRect.value.set(_sceneRectX, _sceneRectY, _sceneRectW, _sceneRectH);
        }
        if (this._compositeMaterial?.uniforms?.uHasSceneRect && u?.uHasSceneRect) {
          this._compositeMaterial.uniforms.uHasSceneRect.value = _sceneRectAvailable ? 1.0 : 0.0;
        }
        if (this._compositeMaterial?.uniforms?.uViewBounds && u?.uViewBounds) {
          this._compositeMaterial.uniforms.uViewBounds.value.copy(u.uViewBounds.value);
        }
      } catch (_) {
      }

      // Prefer WorldSpaceFogEffect's self-maintained vision RT when available.
      let visionTex = null;
      const fog = window.MapShine?.fogEffect;
      const fogVisionTex = fog?.visionRenderTarget?.texture;
      if (fogVisionTex) {
        visionTex = fogVisionTex;
      } else {
        this.fogBridge?.sync?.();
        visionTex = this.fogBridge?.getVisionTexture?.();
      }

      if (u?.tVision) {
        u.tVision.value = visionTex;
      }

      if (u?.uMaskEnabled) {
        // TEMP: disable vision masking while we validate bloom pipeline.
        // A bad/black vision texture would otherwise zero the entire frame.
        u.uMaskEnabled.value = 0.0;
      }

      // If we're using the fog RT (scene-space), enable scene-rect mapping.
      // If we're using Foundry's vision texture (screen-space), we should skip mapping.
      if (u?.uHasSceneRect) {
        u.uHasSceneRect.value = (visionTex === fogVisionTex && u.uHasSceneRect.value > 0.5) ? 1.0 : 0.0;
      }

      if (u?.uVisionTexelSize) {
        const iw = visionTex?.image?.width;
        const ih = visionTex?.image?.height;
        const w = (typeof iw === 'number' && iw > 0) ? iw : 1;
        const h = (typeof ih === 'number' && ih > 0) ? ih : 1;
        u.uVisionTexelSize.value.set(1.0 / w, 1.0 / h);
      }
    } catch (_) {
    }

    // Pre-pass: write masked scene into _maskedInputTarget so bloom never samples padded region.
    try {
      if (this._maskMaterial?.uniforms?.tDiffuse) this._maskMaterial.uniforms.tDiffuse.value = this.readBuffer.texture;
      renderer.setRenderTarget(this._maskedInputTarget);
      renderer.clear();
      renderer.render(this._maskScene, this._maskCamera);
    } catch (_) {
      passthrough();
      return;
    }
    
    // We pass a dummy deltaTime because UnrealBloomPass doesn't strictly use it for animation
    // (unless it was doing something time-based which it isn't).
    // The 'maskActive' param is also usually false for full screen post.
    
    // IMPORTANT:
    // Our vendored UnrealBloomPass writes its final blend into the *readBuffer* render target
    // (see three.custom.js UnrealBloomPass.render: it setsRenderTarget(readBuffer)).
    // To make bloom work without patching the vendor file, we run the pass with readBuffer
    // pointing at our masked scene target.
    try {
      this.pass.render(
        renderer,
        null,
        this._maskedInputTarget,
        0.01,
        false
      );
    } catch (_) {
      passthrough();
      return;
    }

    // Copy the final (masked scene + bloom) forward into the post chain output.
    const outTarget = (this.renderToScreen || !this.writeBuffer) ? null : this.writeBuffer;
    try {
      this.copyMaterial.map = this._maskedInputTarget.texture;
      renderer.setRenderTarget(outTarget);
      renderer.clear();
      renderer.render(this.copyScene, this.copyCamera);
    } catch (_) {
      passthrough();
    }
  }
  
  /**
   * Handle resize
   */
  onResize(width, height) {
    if (this.pass) {
      this.pass.setSize(width, height);
    }

    try {
      if (this._bloomTarget && (this._bloomTarget.width !== width || this._bloomTarget.height !== height)) {
        this._bloomTarget.setSize(width, height);
      }

      if (this._maskedInputTarget && (this._maskedInputTarget.width !== width || this._maskedInputTarget.height !== height)) {
        this._maskedInputTarget.setSize(width, height);
      }
    } catch (_) {
    }
  }

  /**
   * Dispose resources
   */
  dispose() {
    if (this.pass) {
      this.pass.dispose();
      this.pass = null;
    }
    if (this.fogBridge) {
      this.fogBridge.dispose();
      this.fogBridge = null;
    }
    if (this.copyMaterial) {
        this.copyMaterial.dispose();
    }
    if (this.copyQuad) {
        this.copyQuad.geometry.dispose();
    }

    if (this._maskMaterial) {
      this._maskMaterial.dispose();
      this._maskMaterial = null;
    }

    if (this.bloomCompositeQuad) {
      this.bloomCompositeQuad.geometry.dispose();
    }

    if (this._compositeMaterial) {
      this._compositeMaterial.dispose();
      this._compositeMaterial = null;
    }

    if (this._bloomTarget) {
      this._bloomTarget.dispose();
      this._bloomTarget = null;
    }

    if (this._maskedInputTarget) {
      this._maskedInputTarget.dispose();
      this._maskedInputTarget = null;
    }
  }
}
