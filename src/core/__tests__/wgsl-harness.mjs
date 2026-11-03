/**
 * BUILD REAL WGSL IN NODE, NO GPU (2026-11-03, epic mmp-8gf.1). three's own `WGSLNodeBuilder` only needs a
 * renderer stand-in rich enough to answer its questions; this is that stand-in (first written for
 * `effects/critters/__tests__/critter-consumption.test.mjs`) plus the two calls a size test needs. The text it
 * returns is what three hands `createShaderModule`, so its LENGTH is the real cost of a shader. It is not
 * validated here (no Tint in Node): a shader-lab or real load does that.
 */
import * as THREE from '../../vendor/three/three.webgpu.js';

/** @param {Array<*>} [captured] - compute nodes passed to `renderer.compute` land here. */
export function fakeRenderer(captured = []) {
  return {
    compute(node) {
      captured.push(node);
    },
    getRenderTarget() {
      return null;
    },
    contextNode: THREE.TSL.context({}),
    library: new THREE.StandardNodeLibrary(),
    _currentRenderContext: null,
    coordinateSystem: THREE.WebGPUCoordinateSystem,
    outputColorSpace: THREE.SRGBColorSpace,
    toneMapping: THREE.NoToneMapping,
    backend: {
      compatibilityMode: false,
      isWebGPUBackend: true,
      trackTimestamp: false,
      utils: {
        getTextureSampleData: () => ({ samples: 1, primarySamples: 1, isMSAA: false }),
        getTextureFormatGPU: () => 'rgba8unorm',
      },
      hasFeature: () => true,
      device: { limits: {} },
    },
    nodes: null,
    samples: 1,
    hasFeature() {
      return false;
    },
    getMRT() {
      return null;
    },
    getOutputRenderTarget() {
      return null;
    },
    getOutputBufferType() {
      return THREE.HalfFloatType;
    },
    getColorBufferType() {
      return THREE.HalfFloatType;
    },
    isOutputTarget: false,
  };
}

/** WGSL of a compute node. @returns {string} */
export function computeWgsl(node, renderer = fakeRenderer()) {
  const b = new THREE.WGSLNodeBuilder(node, renderer);
  b.build();
  return b.computeShader;
}

/**
 * WGSL of a material (or a bare fragment node, wrapped in a NodeMaterial) drawn on a quad.
 * @returns {{vertex: string, fragment: string}}
 */
export function materialWgsl(materialOrNode, renderer = fakeRenderer()) {
  let material = materialOrNode?.isMaterial ? materialOrNode : null;
  if (!material) {
    material = new THREE.NodeMaterial();
    material.fragmentNode = materialOrNode;
  }
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  const scene = new THREE.Scene();
  scene.add(mesh);
  const b = new THREE.WGSLNodeBuilder(mesh, renderer);
  b.scene = scene;
  b.material = material;
  b.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  b.context.material = material;
  b.lightsNode = null;
  b.environmentNode = null;
  b.fogNode = null;
  b.clippingContext = null;
  b.build();
  return { vertex: b.vertexShader, fragment: b.fragmentShader };
}

/** A 2x2 data texture, for builders that need a real one. */
export function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array(16), 2, 2, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

/** `fn name (` declarations in a WGSL text. */
export function wgslFunctionNames(code) {
  return [...code.matchAll(/^fn ([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]);
}
