/**
 * @fileoverview Extract a single channel from a packed RGBA RT into a legacy single-channel view RT.
 */

export class ChannelExtractPass {
  constructor() {
    this._scene = null;
    this._camera = null;
    this._quad = null;
    this._material = null;
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE || this._scene) return;
    this._scene = new THREE.Scene();
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._material = new THREE.ShaderMaterial({
      uniforms: {
        tPacked: { value: null },
        uChannel: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D tPacked;
        uniform float uChannel;
        varying vec2 vUv;
        void main() {
          vec4 c = texture2D(tPacked, vUv);
          float ch = 0.0;
          if (uChannel < 0.5) ch = c.r;
          else if (uChannel < 1.5) ch = c.g;
          else if (uChannel < 2.5) ch = c.b;
          else ch = c.a;
          gl_FragColor = vec4(ch, ch, ch, ch);
        }
      `,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NoBlending,
    });
    this._material.toneMapped = false;
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._material);
    this._quad.frustumCulled = false;
    this._scene.add(this._quad);
  }

  /**
   * @param {import('three').WebGLRenderer} renderer
   * @param {import('three').Texture} packedTex
   * @param {import('three').WebGLRenderTarget} outTarget
   * @param {0|1|2|3} channel
   */
  extract(renderer, packedTex, outTarget, channel = 0) {
    if (!renderer || !packedTex || !outTarget) return;
    this.initialize();
    const prev = renderer.getRenderTarget();
    try {
      this._material.uniforms.tPacked.value = packedTex;
      this._material.uniforms.uChannel.value = channel;
      renderer.setRenderTarget(outTarget);
      renderer.clear();
      renderer.render(this._scene, this._camera);
    } finally {
      renderer.setRenderTarget(prev);
    }
  }

  dispose() {
    try { this._material?.dispose?.(); } catch (_) { /* dispose */ }
    try { this._quad?.geometry?.dispose?.(); } catch (_) { /* dispose */ }
    this._material = null;
    this._quad = null;
    this._scene = null;
    this._camera = null;
  }
}
