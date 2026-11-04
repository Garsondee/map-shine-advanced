/**
 * present-lens-registration.test.mjs — every screen-position read in the present goes through the lens warp.
 *
 * The present runs AFTER `post.lens`, so the picture it samples has already been moved by the barrel warp, while
 * every other screen buffer (scene.illum, the lamp glow, `_Outdoors`, the fog) still describes the UNWARPED frame.
 * Read at the plain screen uv they talk about a different spot from the colour they are applied to, worst at the
 * edges of the frame (grade-present.js, "THE LENS WARP").
 *
 * 2026-11-04, the author on the Big Bank: "strange highlights/lines in gold and yellow ... They don't align with
 * the map properly ... most obvious near the edges of the camera". The Dynamic Range camera (eaa2c511) read
 * scene.illum and the lamp glow at the plain uv. The lamp glow carries the art's own ink lines, and the camera
 * counts it as light, so every ink line came back as a punched-up bright twin up to ~17 px from the real line
 * (measured on the rig at the left edge, 1600 px frame, distortion -0.1).
 *
 * The guard: build the real present with Dynamic Range + lamp glow + the lens warp compiled, run its fragment
 * function, and require every texture read of illum / lamp glow to take its uv from the lens's own guard
 * (which only the warp calls).
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildGradePresentMaterial } from '../grade-present.js';
import { createDynamicRangeUniforms } from '../../dynamic-range-render.js';

function stubTexture(name) {
  const tex = new THREE.DataTexture(new Uint8Array([0, 128, 128, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.name = name;
  tex.needsUpdate = true;
  return tex;
}

/** Every node reachable from `root` through plain object properties and arrays. */
function collectNodes(root) {
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n !== 'object' || seen.has(n)) continue;
    seen.add(n);
    for (const k of Object.keys(n)) {
      if (k === 'value' || k === 'parent' || k === 'material') continue;
      const v = n[k];
      if (Array.isArray(v)) for (const e of v) stack.push(e);
      else if (v && typeof v === 'object' && (v.isNode || Array.isArray(v))) stack.push(v);
    }
  }
  return [...seen].filter((n) => n?.isNode);
}

/** Does `node`'s uv come from one of the warped nodes (directly or through any expression above it)? */
function fedBy(node, warped) {
  return collectNodes(node).some((n) => warped.has(n));
}

export function run(t) {
  const { ok } = t;
  const TSL = THREE.TSL;
  const { uniform, vec4, texture } = TSL;
  const illum = stubTexture('illum');
  const glow = stubTexture('lampGlow');
  const warped = new Set();
  const gp = buildGradePresentMaterial({
    THREE,
    litTexture: stubTexture('lit'),
    outdoorsTexNode: texture(stubTexture('outdoors')),
    uViewRect: uniform(vec4(0, 0, 1920, 1080)),
    uOutdoorsRect: uniform(vec4(0, 0, 1920, 1080)),
    lampGlowTexture: glow,
    illumTexture: illum,
    dynamicRangeUniforms: createDynamicRangeUniforms(THREE),
    lensUvGuard: (plain, w) => {
      warped.add(w);
      return w;
    },
  });
  gp.setLensWarp(true, -0.1);
  gp.flushRebuild?.();

  // The fragment is an Fn call: its body builds the graph only when called. Run it inside a throwaway build stack
  // so the reads it makes are real nodes we can look at.
  const frag = gp.material.fragmentNode;
  const roots = [frag];
  try {
    const fnNode = frag?.shaderNode ?? frag?.callNode?.shaderNode;
    if (fnNode?.jsFunc) roots.push(fnNode.jsFunc({}));
  } catch {
    /* the walk below still sees whatever was built eagerly */
  }
  const nodes = roots.flatMap((r) => collectNodes(r));
  const reads = (tex) => nodes.filter((n) => n.isTextureNode && n.value === tex && n.uvNode);

  const illumReads = reads(illum);
  const glowReads = reads(glow);
  ok(`the walk finds Dynamic Range's scene.illum read (${illumReads.length})`, illumReads.length > 0);
  ok(`the walk finds the lamp-glow reads (${glowReads.length})`, glowReads.length > 0);
  ok('the lens guard was asked for warped uvs', warped.size > 0);
  const stray = [...illumReads, ...glowReads].filter((n) => !fedBy(n.uvNode, warped));
  ok(
    `⭐ every illum / lamp-glow read in the present is at the lens-warped uv (${stray.length} at the plain uv)`,
    stray.length === 0
  );
}
