/**
 * THE TSL GRAPHS ARE ACTUALLY CONSTRUCTED, IN NODE.
 *
 * `keyhole-tsl-constructs-in-node`: a builder can ship a live startup crash
 * (a temporal-dead-zone `ReferenceError`, a typo'd TSL destructure) behind
 * thousands of green assertions if none of them ever CALLS it.
 * `src/vendor/three/three.webgpu.js` imports cleanly under plain Node, so
 * there is no excuse for either of fluid's TSL builders to go uncalled here.
 * This proves the graphs SURVIVE BEING BUILT — nothing about WGSL/GLSL
 * codegen, nothing about what either looks like on screen.
 *
 * Both builders in this file were written AFTER `fluid-render.js` shipped
 * without this check even once (a real gap in Phase 3/4) — closing it for
 * both at once rather than leaving the older one uncovered.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { buildFluidAdvectMaterial } from '../fluid-sim.js';
import { buildFluidSurfaceMaterials } from '../fluid-render.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture(format = THREE.RGBAFormat, type = THREE.UnsignedByteType, data = new Uint8Array([0, 0, 0, 255])) {
  const t = new THREE.DataTexture(data, 1, 1, format, type);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const { ok } = t;

  // ── buildFluidAdvectMaterial ─────────────────────────────────────────────
  {
    let built = null;
    let buildError = null;
    try {
      built = buildFluidAdvectMaterial({
        THREE,
        prevStateTexture: stubTexture(THREE.RGBAFormat, THREE.FloatType, new Float32Array([0, 0, 0, 1])),
        profileTexture: stubTexture(THREE.RGBAFormat, THREE.FloatType, new Float32Array([10, 0, 0, 1])),
        pumpTexture: stubTexture(THREE.RGBAFormat, THREE.FloatType, new Float32Array([1000, 1, 500, 1])),
      });
    } catch (err) {
      buildError = err;
    }
    ok(
      `buildFluidAdvectMaterial CONSTRUCTS without throwing (${buildError ? buildError.message : 'clean'})`,
      buildError === null
    );
    if (built) {
      ok('it returns a real NodeMaterial', built.material.isNodeMaterial);
      ok('it carries a fragmentNode (a QuadMesh pass, not a scene material)', !!built.material.fragmentNode);
      ok('it returns a QuadMesh', !!built.quad);
      ok(
        'prevTexNodes names EXACTLY the one backtrace sample',
        Array.isArray(built.prevTexNodes) && built.prevTexNodes.length === 1
      );
      ok('uDtSec is exposed for the per-tick re-point', !!built.uDtSec);
      ok('uDtSec starts at 0 (never ticks until the caller sets it)', built.uDtSec.value === 0);
    }
  }

  // ── buildFluidSurfaceMaterials — closing the gap this file's header names ──
  {
    let built = null;
    let buildError = null;
    try {
      built = buildFluidSurfaceMaterials({
        THREE,
        maskTexture: stubTexture(),
        packTexture: stubTexture(THREE.RGBAFormat, THREE.FloatType, new Float32Array([0, 0, 0, 0])),
        // R = φ, matching `fluid-sim.js`'s own state texture shape — a real
        // stub, not `undefined`: `texture(undefined, uv)` does not throw at
        // construction either (TSL stores whatever it is given), so passing
        // undefined here would let a broken dependent read report "clean"
        // (`feedback_instruments_must_not_lie`). A real DataTexture is the
        // only way this test can tell the two apart.
        stateTexture: stubTexture(THREE.RGBAFormat, THREE.FloatType, new Float32Array([1, 0, 0, 1])),
        tubeCount: 3,
        timeMsNode: THREE.TSL.float(0),
      });
    } catch (err) {
      buildError = err;
    }
    ok(
      `buildFluidSurfaceMaterials CONSTRUCTS without throwing (${buildError ? buildError.message : 'clean'})`,
      buildError === null
    );
    if (built) {
      ok('it returns the ABSORB material', built.absorbMaterial?.isNodeMaterial);
      ok('it returns the EMIT material', built.emitMaterial?.isNodeMaterial);
      ok('both carry a colorNode', !!built.absorbMaterial.colorNode && !!built.emitMaterial.colorNode);

      // ── THE BLEND CONTRACT — the two-blend split, checked structurally ────
      ok(
        'absorb is Zero·src + SrcColor·dst (a genuine multiply)',
        built.absorbMaterial.blendSrc === THREE.ZeroFactor && built.absorbMaterial.blendDst === THREE.SrcColorFactor
      );
      ok(
        'emit is One·src + One·dst (a genuine add)',
        built.emitMaterial.blendSrc === THREE.OneFactor && built.emitMaterial.blendDst === THREE.OneFactor
      );
      ok(
        'both leave destination alpha alone (Zero·src + One·dst is the identity)',
        built.absorbMaterial.blendSrcAlpha === THREE.ZeroFactor &&
          built.absorbMaterial.blendDstAlpha === THREE.OneFactor &&
          built.emitMaterial.blendSrcAlpha === THREE.ZeroFactor &&
          built.emitMaterial.blendDstAlpha === THREE.OneFactor
      );
      ok(
        'both use CustomBlending, not a coarse preset (explicit factors, matching water-render.js)',
        built.absorbMaterial.blending === THREE.CustomBlending && built.emitMaterial.blending === THREE.CustomBlending
      );
      ok(
        'neither depth-tests — the painter contract is renderOrder, not the depth buffer',
        built.absorbMaterial.depthTest === false && built.emitMaterial.depthTest === false
      );
      ok(
        'both are DoubleSide (feedback_doubleside_invisible_to_status_reports)',
        built.absorbMaterial.side === THREE.DoubleSide && built.emitMaterial.side === THREE.DoubleSide
      );

      // ── THE MRT KEY — must be the literal string 'attr', not 'gAttr' ──────
      // This shipped WRONG for one round (see fluid-render.js's own header):
      // a wrong key is silently skipped by MRTNode, no error, no effect. The
      // only way to catch it without a live GPU is to read the built node's
      // OWN declared keys back out.
      const absorbKeys = Object.keys(built.absorbMaterial.mrtNode?.outputNodes ?? {});
      const emitKeys = Object.keys(built.emitMaterial.mrtNode?.outputNodes ?? {});
      ok(`absorb's mrtNode uses the key 'attr' (got: ${absorbKeys.join(',')})`, absorbKeys.includes('attr'));
      ok(`emit's mrtNode uses the key 'attr' (got: ${emitKeys.join(',')})`, emitKeys.includes('attr'));
      ok('neither uses the wrong key `gAttr`', !absorbKeys.includes('gAttr') && !emitKeys.includes('gAttr'));

      // ONE uniforms object for both materials — not `absorbUniforms` /
      // `emitUniforms` — is what makes a single param-sync write in
      // `fluid-surface-subsystem.js` reach both passes. `uTint` is read by
      // BOTH colorNodes (the absorb hue and the emit tint); `uOpacity`
      // likewise (both the optical depth and the radiance term).
      ok('exactly one uniforms set is returned, not per-material copies', !built.absorbUniforms && !built.emitUniforms);
      ok('uTint is present exactly once, shared by construction', !!built.uniforms.uTint);
      ok('uOpacity is present exactly once, shared by construction', !!built.uniforms.uOpacity);

      // ── THE DEPENDENT READ — φ comes from the SIM now, not a scroll ───────
      // `stateTexNode` is the one piece of evidence (short of a live GPU) that
      // the dependent read was actually built rather than skipped: a builder
      // that silently ignored `stateTexture` would still pass every assertion
      // above.
      ok(
        'it returns stateTexNodes — proof the dependent read was actually built',
        Array.isArray(built.stateTexNodes) && built.stateTexNodes.length > 0
      );
      ok(
        'stateTexNodes names EXACTLY two samples — fill AND the meniscus`s fillAhead, both re-pointable',
        Array.isArray(built.stateTexNodes) && built.stateTexNodes.length === 2
      );
      ok(
        'the retired analytic-scroll uniforms are GONE, not dangling (params/no-dead-controls)',
        !built.uniforms.uSpeedPx && !built.uniforms.uSlugCount && !built.uniforms.uSlugWidth
      );

      // ── TIER 5: STRUCTURE — the noise fetch actually runs ─────────────────
      // Constructs cleanly only if `mx_fractal_noise_vec3` is a real export on
      // this vendored TSL (confirmed already by water/wind/specular's own
      // usage) AND τ's own formula type-checks against the vec3/float nodes
      // it is built from — a typo in either would have thrown before reaching
      // this line, not silently produced a wrong picture.
      ok('uFlowSpeed is exposed — τ`s own drift rate follows the live speed control', !!built.uniforms.uFlowSpeed);
      ok('uStructure is exposed — the marbling/grain strength control', !!built.uniforms.uStructure);
    }
  }
}
