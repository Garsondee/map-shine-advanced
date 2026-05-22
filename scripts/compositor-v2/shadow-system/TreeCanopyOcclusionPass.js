/**
 * @fileoverview Renders live tree canopy alpha into a screen-space RT so lower
 * vegetation (e.g. bush ground shadows) can be masked where trees occlude.
 */

export class TreeCanopyOcclusionPass {
  constructor() {
    /** @type {THREE.WebGLRenderTarget|null} */
    this._target = null;
    /** @type {THREE.Scene|null} */
    this._scene = null;
    /** @type {THREE.Mesh|null} */
    this._clone = null;
  }

  get texture() {
    return this._target?.texture ?? null;
  }

  get width() {
    return this._target?.width ?? 0;
  }

  get height() {
    return this._target?.height ?? 0;
  }

  initialize() {
    const THREE = window.THREE;
    if (!THREE || this._scene) return;
    this._scene = new THREE.Scene();
    this._clone = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial(),
    );
    this._clone.frustumCulled = false;
  }

  onResize(width, height) {
    const THREE = window.THREE;
    if (!THREE) return;
    const rw = Math.max(2, Math.floor(Number(width) || 2));
    const rh = Math.max(2, Math.floor(Number(height) || 2));
    if (!this._target) {
      this._target = new THREE.WebGLRenderTarget(rw, rh, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
      });
      this._target.texture.name = 'MapShineTreeCanopyOcclusion';
      this._target.texture.flipY = false;
    } else {
      this._target.setSize(rw, rh);
    }
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Camera} camera
   * @param {Iterable<{mesh: THREE.Mesh, material?: THREE.Material}>} canopyEntries
   */
  render(renderer, camera, canopyEntries) {
    const THREE = window.THREE;
    if (!renderer || !camera || !this._target || !this._scene || !this._clone) return;

    const entries = Array.isArray(canopyEntries) ? canopyEntries : [...(canopyEntries ?? [])];
    const prevRt = renderer.getRenderTarget();
    const prevAutoClear = renderer.autoClear;
    const prevLayerMask = camera.layers.mask;

    try {
      camera.layers.mask = 0;
      for (let i = 0; i <= 21; i++) camera.layers.enable(i);

      renderer.setRenderTarget(this._target);
      renderer.setClearColor(0x000000, 0.0);
      renderer.clear(true, true, true);
      renderer.autoClear = false;

      if (entries.length === 0) return;

      for (const entry of entries) {
        const mesh = entry?.mesh;
        if (!mesh?.visible) continue;
        const drawMaterial = entry?.material ?? mesh.material;
        if (!drawMaterial) continue;

        this._clone.geometry = mesh.geometry;
        this._clone.material = drawMaterial;
        this._clone.position.copy(mesh.position);
        this._clone.rotation.copy(mesh.rotation);
        this._clone.scale.copy(mesh.scale);
        this._clone.updateMatrixWorld(true);

        this._scene.add(this._clone);
        renderer.render(this._scene, camera);
        this._scene.remove(this._clone);
      }
    } finally {
      camera.layers.mask = prevLayerMask;
      renderer.autoClear = prevAutoClear;
      renderer.setRenderTarget(prevRt);
    }
  }

  dispose() {
    try { this._target?.dispose?.(); } catch (_) {}
    this._target = null;
    this._scene = null;
    this._clone = null;
  }
}
