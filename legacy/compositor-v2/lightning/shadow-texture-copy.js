/**
 * @fileoverview GPU copy / mix helpers for lightning shadow bake caches.
 */

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Texture|null} src
 * @param {THREE.WebGLRenderTarget} dst
 * @param {{ copyMaterial: THREE.ShaderMaterial, scene: THREE.Scene, quad: THREE.Mesh }} ctx
 */
export function copyTextureToTarget(renderer, src, dst, ctx) {
  const THREE = window.THREE;
  if (!THREE || !renderer || !src || !dst || !ctx?.copyMaterial) return;
  const prev = renderer.getRenderTarget();
  ctx.copyMaterial.uniforms.tMap.value = src;
  ctx.copyMaterial.uniforms.uMix.value = 0.0;
  ctx.quad.material = ctx.copyMaterial;
  renderer.setRenderTarget(dst);
  renderer.render(ctx.scene, ctx._camera ?? ctx.camera);
  renderer.setRenderTarget(prev);
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Texture|null} live
 * @param {THREE.Texture|null} lightning
 * @param {number} mix01
 * @param {THREE.WebGLRenderTarget} dst
 * @param {{ mixMaterial: THREE.ShaderMaterial, scene: THREE.Scene, quad: THREE.Mesh, camera: THREE.Camera }} ctx
 */
export function mixLitFactorTextures(renderer, live, lightning, mix01, dst, ctx) {
  const THREE = window.THREE;
  if (!THREE || !renderer || !dst || !ctx?.mixMaterial) return;
  const m = Math.max(0, Math.min(1, Number(mix01) || 0));
  if (!lightning || m <= 0.0001) {
    if (live) copyTextureToTarget(renderer, live, dst, ctx);
    return;
  }
  const prev = renderer.getRenderTarget();
  const u = ctx.mixMaterial.uniforms;
  u.tLive.value = live ?? lightning;
  u.tLightning.value = lightning;
  u.uMix.value = m;
  u.uHasLive.value = live ? 1.0 : 0.0;
  ctx.quad.material = ctx.mixMaterial;
  renderer.setRenderTarget(dst);
  renderer.render(ctx.scene, ctx.camera);
  renderer.setRenderTarget(prev);
}

/**
 * @returns {{ scene: THREE.Scene, camera: THREE.Camera, quad: THREE.Mesh, copyMaterial: THREE.ShaderMaterial, mixMaterial: THREE.ShaderMaterial }|null}
 */
export function createShadowTextureBlitContext() {
  const THREE = window.THREE;
  if (!THREE) return null;
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const copyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tMap: { value: null },
      uMix: { value: 0.0 },
    },
    vertexShader: /* glsl */`
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      uniform sampler2D tMap;
      varying vec2 vUv;
      void main() {
        float v = clamp(texture2D(tMap, vUv).r, 0.0, 1.0);
        gl_FragColor = vec4(v, v, v, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  copyMaterial.toneMapped = false;
  const mixMaterial = new THREE.ShaderMaterial({
    uniforms: {
      tLive: { value: null },
      tLightning: { value: null },
      uMix: { value: 0.0 },
      uHasLive: { value: 1.0 },
    },
    vertexShader: copyMaterial.vertexShader,
    fragmentShader: /* glsl */`
      uniform sampler2D tLive;
      uniform sampler2D tLightning;
      uniform float uMix;
      uniform float uHasLive;
      varying vec2 vUv;
      void main() {
        float liveV = (uHasLive > 0.5)
          ? clamp(texture2D(tLive, vUv).r, 0.0, 1.0)
          : 1.0;
        float boltV = clamp(texture2D(tLightning, vUv).r, 0.0, 1.0);
        float v = mix(liveV, boltV, clamp(uMix, 0.0, 1.0));
        gl_FragColor = vec4(v, v, v, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  mixMaterial.toneMapped = false;
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copyMaterial);
  quad.frustumCulled = false;
  scene.add(quad);
  return { scene, camera, quad, copyMaterial, mixMaterial };
}

/**
 * @param {number} w
 * @param {number} h
 * @param {string} [name]
 * @returns {THREE.WebGLRenderTarget|null}
 */
export function allocLitFactorTarget(w, h, name = 'LightningShadowCache') {
  const THREE = window.THREE;
  if (!THREE) return null;
  const rw = Math.max(2, Math.floor(w || 2));
  const rh = Math.max(2, Math.floor(h || 2));
  const rt = new THREE.WebGLRenderTarget(rw, rh, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.name = name;
  rt.texture.flipY = false;
  return rt;
}
