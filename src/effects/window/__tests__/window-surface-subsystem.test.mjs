/**
 * window-surface-subsystem.test.mjs — THE DEBUG SWAP, AND THE VISIBILITY
 * DEADLOCK IT CAN CAUSE.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * `specular-surface-subsystem.test.mjs`'s own header names the failure mode
 * this guards against: `refreshVisibility` hiding the wrong mesh on a debug
 * channel, so `hasContent()` reports false, so the pass early-returns and
 * EVERY channel reads black — including the ones that are fine. A diagnostic
 * that cannot distinguish "the term is zero" from "I did not run" is worse
 * than none (`feedback_instruments_must_not_lie`), and this effect family has
 * already shipped invisible three times in this codebase with every other
 * test green.
 *
 * The subsystem takes THREE INJECTED and every seam as a closure, so it is
 * constructible in Node exactly as `window-render.test.mjs` proved the
 * builder is.
 *
 * WHAT THIS DOES NOT PROVE: nothing about what any channel LOOKS like, and
 * nothing about whether the numbers inside it are right. It proves the mesh,
 * the material and the pass's own early-return agree about when something is
 * on screen.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { createWindowSurfaceSubsystem } from '../window-surface-subsystem.js';

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.needsUpdate = true;
  return t;
}

/**
 * The subsystem with every seam stubbed, shaped exactly as `vt-pan-viewer.js`
 * supplies them — so a change to that call site this harness does not follow
 * shows up here rather than on the author's screen.
 * @param {object} [state] - the mutable render state the seam returns.
 * @returns {object}
 */
function makeSubsystem(state) {
  const { uniform, vec4 } = THREE.TSL;
  return createWindowSurfaceSubsystem({
    THREE,
    getWindowMaskUrl: () => 'stub://floor0_Window.webp',
    getWindowMaskRect: () => ({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }),
    // Resolves immediately, with SOMETHING painted — the case where the mesh
    // is supposed to become visible. `painted: 'NOTHING PAINTED'` is its own
    // branch and keeps it hidden by design, not by failure.
    loadMaskImage: async () => ({
      texture: stubTexture(),
      contentBounds: { minU: 0.1, minV: 0.1, maxU: 0.9, maxV: 0.9 },
      data: new Uint8Array(4 * 4 * 4).fill(200),
      width: 4,
      height: 4,
      nativeWidth: 8,
      nativeHeight: 8,
      bytes: 256,
    }),
    createMaskTexture: (data, w, h) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.needsUpdate = true;
      return t;
    },
    attrTexture: stubTexture(),
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    cloudFactorNode: null,
    getWindowRenderState: () => state,
  });
}

/** The subsystem's meshes — one, ADDITIVE only.
 * @param {object} sub @returns {object[]} */
function meshesOf(sub) {
  return sub.scene.children.filter((c) => c.isMesh);
}

/** @param {{ok: Function}} t */
export async function run(t) {
  const { ok } = t;

  const state = { enabled: true, params: {}, debugChannel: 0 };
  const sub = makeSubsystem(state);
  const meshes = meshesOf(sub);
  const mesh = meshes[0];

  ok('the subsystem builds exactly ONE mesh in its own scene', meshes.length === 1);
  ok('it starts hidden — the mask has not landed yet', !mesh.visible);
  ok('…and hasContent() agrees, so the pass early-returns', sub.hasContent() === false);

  // Let the mask load settle. The subsystem loads on the first `sync`, and
  // its own `.then` is a microtask, so a couple of ticks is enough.
  sub.sync(0);
  await Promise.resolve();
  await Promise.resolve();

  ok('once the mask lands the mesh is visible', mesh.visible === true);
  ok('…and hasContent() says the pass has work to do', sub.hasContent() === true);
  // Identified by BLEND rather than by object identity, because blend is the
  // difference that matters on screen: the cookie ADDS (One/One), the
  // diagnostic REPLACES (One/Zero).
  ok('the mesh carries the ADDITIVE cookie material by default', mesh.material.blendDst === THREE.OneFactor);
  ok('the reported debug channel is 0 — the effect as it ships', sub.getStatus().debugChannel === 0);

  // ── PICKING A CHANNEL ───────────────────────────────────────────────────
  const litMaterial = mesh.material;
  state.debugChannel = 4;
  sub.sync(0);

  ok('picking a channel swaps the mesh onto a DIFFERENT material', mesh.material !== litMaterial);
  ok(
    '…and that material REPLACES rather than adds, so black reads as black',
    mesh.material.blendDst === THREE.ZeroFactor
  );
  // ⚠️ THE ASSERTION THIS FILE WAS WRITTEN FOR.
  ok('the mesh stays visible on a channel — the pass must not early-return', mesh.visible === true);
  ok('hasContent() STILL true on a channel', sub.hasContent() === true);
  ok('getStatus() reports the channel, so it cannot be silently left on', sub.getStatus().debugChannel === 4);

  // ── BACK TO THE EFFECT ──────────────────────────────────────────────────
  state.debugChannel = 0;
  sub.sync(0);
  ok('returning to 0 restores the additive cookie material', mesh.material === litMaterial);
  ok('…and reports channel 0 again', sub.getStatus().debugChannel === 0);

  // ── DISABLED BEATS DEBUGGING ────────────────────────────────────────────
  state.enabled = false;
  state.debugChannel = 7;
  sub.sync(0);
  ok('a disabled effect draws nothing even on a debug channel', mesh.visible === false);
  ok('…and hasContent() lets the pass skip entirely', sub.hasContent() === false);

  // ── AN UNWIRED SEAM STILL RENDERS THE EFFECT ────────────────────────────
  // The viewer's own default is `{enabled: true, params: {}}` with no
  // `debugChannel`. `undefined` there must read as 0, never as NaN and never
  // as a diagnostic mode.
  const unwired = makeSubsystem({ enabled: true, params: {} });
  unwired.sync(0);
  await Promise.resolve();
  await Promise.resolve();
  ok('a render state with no debugChannel reads as 0, never NaN', unwired.getStatus().debugChannel === 0);
  ok('…and draws the effect', meshesOf(unwired)[0].visible === true);

  // ── THE COORDINATE TWIN ──────────────────────────────────────────────────
  const b = unwired.getStatus().maskUvBounds;
  const cb = unwired.getStatus().contentBoundsUv;
  ok('the crop mask-UV extent is computed and reported', !!b);
  // Wider than the painted content, because `toWorldBounds` adds the AABB
  // pad — handing the shader unpadded bounds would sample the mask slightly
  // zoomed in, shifting the cookie's edge by a few world px.
  ok('the bounds carry the AABB pad', b.minU < cb.minU && b.maxU > cb.maxU);
  // ⚠️ AND STAY INSIDE THE FILE. `uv()` cannot exceed 0..1, so these bounds
  // are the ONLY remaining way the mask sample could leave the texture.
  ok(
    'the bounds stay inside the file, so the sample can never leave the texture',
    b.minU >= 0 && b.minV >= 0 && b.maxU <= 1 && b.maxV <= 1
  );

  // ── A FLOOR WITH NO PAINTED WINDOW LIGHT STAYS DARK, NOT INHERITED ──────
  const empty = createWindowSurfaceSubsystem({
    THREE,
    getWindowMaskUrl: () => null,
    getWindowMaskRect: () => null,
    loadMaskImage: async () => null,
    createMaskTexture: (data, w, h) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.needsUpdate = true;
      return t;
    },
    attrTexture: stubTexture(),
    uViewRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 1000, 1000)),
    getWindowRenderState: () => ({ enabled: true, params: {} }),
  });
  empty.sync(0);
  await Promise.resolve();
  ok('a floor with no authored file never becomes visible', meshesOf(empty)[0].visible === false);
  ok('…and hasContent() agrees', empty.hasContent() === false);

  sub.dispose();
  unwired.dispose();
  empty.dispose();
}
