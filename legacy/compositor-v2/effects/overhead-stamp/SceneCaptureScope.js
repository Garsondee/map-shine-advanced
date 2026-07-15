/**
 * @fileoverview Guaranteed restoration of scene mutations during capture passes.
 */

export class SceneCaptureScope {
  constructor() {
    /** @type {Array<{ object: import('three').Object3D, visible: boolean }>} */
    this._visibility = [];
    /** @type {Array<{ object: import('three').Object3D, opacity: number }>} */
    this._opacity = [];
    /** @type {Array<{ uniform: { value: unknown }, value: unknown }>} */
    this._uniforms = [];
    /** @type {Array<{ object: import('three').Object3D, layersMask: number }>} */
    this._layers = [];
  }

  /** @param {import('three').Object3D} object */
  pushVisibility(object, visible) {
    if (!object || typeof object.visible !== 'boolean') return;
    this._visibility.push({ object, visible: object.visible });
    object.visible = visible;
  }

  /** @param {import('three').Object3D} object @param {number} opacity */
  pushOpacity(object, opacity) {
    const mat = object?.material;
    if (!mat || typeof mat.opacity !== 'number') return;
    this._opacity.push({ object, opacity: mat.opacity });
    mat.opacity = opacity;
  }

  /** @param {{ value: unknown }} uniform @param {unknown} value */
  pushUniform(uniform, value) {
    if (!uniform || typeof uniform.value === 'undefined') return;
    this._uniforms.push({ uniform, value: uniform.value });
    uniform.value = value;
  }

  /** @param {import('three').Layers} layers @param {number} mask */
  pushLayersMask(layers, mask) {
    if (!layers) return;
    this._layers.push({ object: layers, layersMask: layers.mask });
    layers.mask = mask;
  }

  restore() {
    for (let i = this._uniforms.length - 1; i >= 0; i--) {
      const e = this._uniforms[i];
      if (e?.uniform) e.uniform.value = e.value;
    }
    for (let i = this._opacity.length - 1; i >= 0; i--) {
      const e = this._opacity[i];
      if (e?.object?.material) e.object.material.opacity = e.opacity;
    }
    for (let i = this._visibility.length - 1; i >= 0; i--) {
      const e = this._visibility[i];
      if (e?.object) e.object.visible = e.visible;
    }
    for (let i = this._layers.length - 1; i >= 0; i--) {
      const e = this._layers[i];
      if (e?.object) e.object.mask = e.layersMask;
    }
    this._visibility.length = 0;
    this._opacity.length = 0;
    this._uniforms.length = 0;
    this._layers.length = 0;
  }
}
