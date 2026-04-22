/**
 * @fileoverview Shared fullscreen-pass helpers for V3 screen-space effects.
 *
 * A V3 effect chain ({@link V3EffectChain}) is a sequence of fullscreen
 * ping-pong passes over the illuminated scene. Every post effect needs the
 * same boilerplate: an ortho camera, a unit quad, and a render that preserves
 * the caller's renderer state (current RT + `autoClear`).
 *
 * Exports:
 *   - {@link createFullscreenQuad} — scene + camera + mesh for a shader.
 *   - {@link renderFullscreenToTarget} — draw a prebuilt quad to an RT while
 *     preserving `renderer.getRenderTarget()` and `renderer.autoClear`.
 *   - {@link createOpaqueBlitMaterial} — opaque pass-through for the final
 *     write to the default framebuffer (alpha forced to 1, matching the
 *     contract `V3IlluminationPipeline.render` relies on to avoid flicker).
 *
 * See the “Clear policy” note in `V3IlluminationPipeline.render` — fullscreen
 * passes in this codebase must write every pixel and leave `autoClear` alone
 * so Three does not clear the default framebuffer between PIXI and our draw.
 *
 * @module v3/V3FullscreenPass
 */

import * as THREE from "../vendor/three.module.js";

/**
 * @typedef {Object} V3FullscreenQuad
 * @property {THREE.Scene} scene             Scene containing the quad mesh.
 * @property {THREE.OrthographicCamera} camera Camera for the quad scene.
 * @property {THREE.Mesh} mesh               Unit quad mesh using the given material.
 * @property {() => void} dispose            Disposes the mesh geometry (material is caller-owned).
 */

/**
 * Build a fullscreen quad + ortho camera pair around a caller-owned material.
 *
 * The material is **not** disposed by {@link V3FullscreenQuad#dispose} — the
 * effect that created it is responsible for its lifetime. The geometry is
 * owned by the helper.
 *
 * @param {THREE.ShaderMaterial|THREE.RawShaderMaterial|THREE.Material} material
 * @returns {V3FullscreenQuad}
 */
export function createFullscreenQuad(material) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  return {
    scene,
    camera,
    mesh,
    dispose() {
      try { geometry.dispose(); } catch (_) {}
      try { scene.remove(mesh); } catch (_) {}
    },
  };
}

/**
 * Render a prebuilt fullscreen quad to the given target while preserving the
 * renderer's current render target and `autoClear` setting.
 *
 * `autoClear` is forced to `false` for the duration of the draw so the quad
 * write composites with whatever is already in the target (important when the
 * same RT is reused for multi-effect ping-pong — the quad shader is expected
 * to write every pixel opaquely and clearing is redundant / harmful).
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {V3FullscreenQuad} quad
 * @param {THREE.WebGLRenderTarget|null} targetRT `null` = default framebuffer.
 */
export function renderFullscreenToTarget(renderer, quad, targetRT) {
  if (!renderer || !quad) return;
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.setRenderTarget(targetRT ?? null);
  renderer.autoClear = false;
  renderer.render(quad.scene, quad.camera);
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
}

/**
 * Opaque pass-through material: samples `tDiffuse` and writes RGB with
 * `alpha = 1.0`. Used as the final blit from the effect chain's last RT to
 * the default framebuffer, preserving the "opaque lit output" invariant the
 * illumination pipeline relies on to avoid one-frame black flashes when PIXI
 * and Three composite on independent vsyncs.
 *
 * The caller owns the material and must call `.dispose()` when finished.
 *
 * @returns {THREE.ShaderMaterial}
 */
export function createOpaqueBlitMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: null },
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
      varying vec2 vUv;
      void main() {
        vec4 c = texture2D(tDiffuse, vUv);
        gl_FragColor = vec4(c.rgb, 1.0);
      }
    `,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
    transparent: false,
  });
}
