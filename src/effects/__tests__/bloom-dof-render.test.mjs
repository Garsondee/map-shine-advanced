/**
 * THE TSL GRAPHS ACTUALLY CONSTRUCT, IN NODE — AT BOTH TIER SIZES.
 *
 * `keyhole-tsl-constructs-in-node`: a builder can ship a live startup crash
 * behind thousands of green assertions if nothing ever CALLS it. Neither
 * `buildBloomMaterials` nor `buildDofMaterials` had ANY Node coverage before
 * 2026-08-30 — a real gap this file closes, for the same reason
 * `fluid-sim-render.test.mjs` closed the identical gap for fluid's own
 * builders a few hours earlier the same day.
 *
 * Why this matters MORE than usual for these two specifically: until
 * 2026-08-30, `buildDofMaterials` was called EXACTLY ONCE per session, at
 * viewer construction, always with the same mip count. A live profile change
 * now calls it a SECOND time, mid-session, with a DIFFERENT mip count
 * (`vt-pan-viewer.js#rebuildDofForTier`) — a code path that could not have
 * been exercised even by hand-testing before this fix existed. `mipCount`
 * drives a genuinely different compiled shader each time (a longer/shorter
 * unrolled `select()` cascade, per that file's own "no runtime array
 * indexing" header) — this test proves BOTH shapes actually compile, not
 * just the one that shipped originally.
 */
import * as THREE from '../../vendor/three/three.webgpu.js';
import { buildBloomMaterials } from '../bloom-render.js';
import { buildDofMaterials } from '../depth-of-field-render.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

export function run(t) {
  const { ok } = t;

  // ── buildBloomMaterials ───────────────────────────────────────────────────
  {
    let built = null;
    let buildError = null;
    try {
      built = buildBloomMaterials({
        THREE,
        litTexture: stubTexture(),
        coreTexture: stubTexture(),
        atmoTexture: stubTexture(),
      });
    } catch (err) {
      buildError = err;
    }
    ok(
      `buildBloomMaterials CONSTRUCTS without throwing (${buildError ? buildError.message : 'clean'})`,
      buildError === null
    );
    if (built) {
      ok('it returns the composite material', built.compositeMaterial?.isNodeMaterial);
      ok(
        'it returns the bright/downsample/upsample materials',
        built.brightMaterial?.isNodeMaterial && built.upsampleMaterial?.isNodeMaterial
      );
      // THE LIVE TIER SEAM (2026-08-30) — `atmoTexNode` is what
      // `vt-pan-viewer.js#runPostBloomPass` re-points on a live tier change,
      // never a material rebuild (see bloom-render.js's own header on this
      // field for why bloom's composite can do this and DoF's cannot). A
      // silent regression here (the field renamed, or dropped) would leave
      // bloom looking correct on every FRESH scene load — only a live,
      // mid-session profile change would ever show it, exactly the failure
      // shape `feedback_instruments_must_not_lie` warns against.
      ok(
        'it exposes atmoTexNode with a settable .value — the live tier re-point seam',
        !!built.atmoTexNode && 'value' in built.atmoTexNode
      );
      const before = built.atmoTexNode.value;
      const other = stubTexture();
      built.atmoTexNode.value = other;
      ok('…and re-pointing it actually takes', built.atmoTexNode.value === other && built.atmoTexNode.value !== before);
    }
  }

  // ── buildDofMaterials — the CHEAP tier (2 mips) ──────────────────────────
  {
    let built = null;
    let buildError = null;
    try {
      built = buildDofMaterials({
        THREE,
        depthColorTexture: stubTexture(),
        mipTextures: [stubTexture(), stubTexture()],
      });
    } catch (err) {
      buildError = err;
    }
    ok(
      `buildDofMaterials CONSTRUCTS at the CHEAP (2-mip) tier without throwing (${buildError ? buildError.message : 'clean'})`,
      buildError === null
    );
    if (built) {
      ok('the cheap tier returns a real composite material', built.compositeMaterial?.isNodeMaterial);
      ok('…and a real downsample material', built.downsampleMaterial?.isNodeMaterial);
    }
  }

  // ── buildDofMaterials — the FULL tier (4 mips) ───────────────────────────
  // The tier the effect always shipped at, pre-2026-08-30 — proven here
  // alongside the cheap tier so a future edit cannot fix one shape while
  // silently breaking the other.
  {
    let built = null;
    let buildError = null;
    try {
      built = buildDofMaterials({
        THREE,
        depthColorTexture: stubTexture(),
        mipTextures: [stubTexture(), stubTexture(), stubTexture(), stubTexture()],
      });
    } catch (err) {
      buildError = err;
    }
    ok(
      `buildDofMaterials CONSTRUCTS at the FULL (4-mip) tier without throwing (${buildError ? buildError.message : 'clean'})`,
      buildError === null
    );
    if (built) {
      ok('the full tier returns a real composite material', built.compositeMaterial?.isNodeMaterial);
      ok('…and a real downsample material', built.downsampleMaterial?.isNodeMaterial);
    }
  }
}
