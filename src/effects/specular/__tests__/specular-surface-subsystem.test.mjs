/**
 * specular-surface-subsystem.test.mjs — THE DEBUG SWAP, AND THE VISIBILITY
 * DEADLOCK IT CAN CAUSE.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 * `SPECULAR_DEBUG_CHANNELS` was added because this effect failed live four
 * times against a zero-wide instrument. Adding an instrument does not help if
 * the instrument itself can be wrong — and the very first draft of the swap
 * below WAS wrong, in a way that would have shown the author a black screen and
 * let them conclude "every channel is zero":
 *
 *   `refreshVisibility` hid the wrong mesh on a debug channel, and
 *   `hasContent()` reported that mesh's visibility. `runSurfaceResponsePass`
 *   takes a hard JS early-return when `hasContent()` is false, so picking any
 *   channel made the pass stop issuing its draw entirely — and the diagnostic
 *   would have reported "black", which is also its answer for "this term is
 *   zero".
 *
 * A diagnostic that cannot distinguish "the factor is zero" from "I did not
 * run" is worse than none: it does not merely fail to inform, it actively
 * misdirects the next fix. `feedback_instruments_must_not_lie`.
 *
 * The subsystem takes THREE INJECTED and every seam as a closure, so it is
 * constructible in Node exactly as `specular-render.test.mjs` proved the
 * builder is — see that file's header for why "TSL is browser-only" is true of
 * EVALUATING a graph and false of BUILDING one.
 *
 * It also covers the ISLAND PACK, whose failure mode is the same shape: an
 * unbaked pack does not crash and does not look broken, it silently gives every
 * texel the global parallax — V2's one-frame-for-everything, invisible on
 * screen. `status.islandPack.islands` is the only place that shows.
 *
 * WHAT THIS DOES NOT PROVE, said plainly: nothing about what any channel LOOKS
 * like, and nothing about whether the numbers inside it are right. It proves
 * the mesh, the materials, the pack and the pass's own early-return agree about
 * when something is on screen.
 */
import * as THREE from '../../../../src/vendor/three/three.webgpu.js';
import { buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import { createSpecularSurfaceSubsystem } from '../specular-surface-subsystem.js';

/** Two well-separated painted squares, so the island pack has something real
 * to label. @param {number} w @param {number} h @returns {Uint8Array} */
function paintedRgba(w, h) {
  const data = new Uint8Array(w * h * 4);
  const box = (x0, y0, size) => {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const i = (y * w + x) * 4;
        data[i] = 255;
        data[i + 1] = 200;
        data[i + 2] = 80;
        data[i + 3] = 255;
      }
    }
  };
  box(3, 3, 8);
  box(20, 20, 8);
  return data;
}

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
 * @param {{data: Uint8Array, width: number, height: number}} [loaded] - the
 *   mask bytes `loadMaskImage` resolves with. Defaults to the two-object
 *   painted fixture; a caller testing the island pack's OWN edge cases (an
 *   unpainted mask, a too-sparse one) overrides this rather than the mask URL,
 *   since the real seam is one function returning one shape either way.
 * @returns {object}
 */
function makeSubsystem(state, loaded = { data: paintedRgba(32, 32), width: 32, height: 32 }) {
  const { uniform, vec4 } = THREE.TSL;
  return createSpecularSurfaceSubsystem({
    THREE,
    getSpecularMaskUrl: () => 'stub://floor0_Specular.webp',
    getSpecularMaskRect: () => ({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }),
    // Resolves immediately, with SOMETHING painted — the case where the mesh
    // is supposed to become visible. `painted: 'NOTHING PAINTED'` is its own
    // branch and keeps it hidden by design, not by failure.
    loadMaskImage: async () => ({
      texture: stubTexture(),
      contentBounds: { minU: 0.1, minV: 0.1, maxU: 0.9, maxV: 0.9 },
      // REAL BYTES. The island pack is baked from these rather than re-fetched,
      // so a harness that supplied none would exercise the never-baked path and
      // pass every assertion about a feature that had not run.
      data: loaded.data,
      width: loaded.width,
      height: loaded.height,
      nativeWidth: loaded.width * 2,
      nativeHeight: loaded.height * 2,
      bytes: loaded.data.length,
    }),
    createMaskTexture: (data, w, h) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.needsUpdate = true;
      return t;
    },
    // UnsignedByteType, matching the real uploader — see its own header for
    // WHY: the first version used FloatType and the shader read zero out of it
    // live. These Node tests never sample a real pixel, so the mismatch was
    // harmless here specifically, but a stale mock is still worth fixing.
    createPackTexture: (data, w, h) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.needsUpdate = true;
      return t;
    },
    illumTexture: stubTexture(),
    attrTexture: stubTexture(),
    timeMsNode: THREE.TSL.uniform(THREE.TSL.float(0)),
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    uOutdoorsRect: uniform(vec4(0, 0, 1000, 1000)),
    outdoorsTexNode: THREE.TSL.texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    getSpecularRenderState: () => state,
    getSkyHandle: () => null,
  });
}

/** The subsystem's meshes — one, since the multiply pass was removed.
 * @param {object} sub @returns {object[]} */
function meshesOf(sub) {
  return sub.scene.children.filter((c) => c.isMesh);
}

const VIEW_RECT = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };

/** @param {{ok: Function}} t */
export async function run(t) {
  const { ok } = t;

  const state = { enabled: true, params: {}, debugChannel: 0 };
  const sub = makeSubsystem(state);
  const meshes = meshesOf(sub);
  const mesh = meshes[0];

  // ONE mesh. The diffuse knock-down that used to draw beside it is gone: V2
  // had no such pass and looked right without one, and a second mesh is a
  // second way to half-fail.
  ok('the subsystem builds exactly ONE mesh in its own scene', meshes.length === 1);
  ok('it starts hidden — the mask has not landed yet', !mesh.visible);
  ok('…and hasContent() agrees, so the pass early-returns', sub.hasContent() === false);

  // Let the mask load settle. The subsystem loads on the first `sync`, and its
  // own `.then` is a microtask, so a couple of ticks is enough — no timers.
  sub.sync(0, VIEW_RECT);
  await Promise.resolve();
  await Promise.resolve();

  ok('once the mask lands the mesh is visible', mesh.visible === true);
  ok('…and hasContent() says the pass has work to do', sub.hasContent() === true);
  // Identified by BLEND rather than by object identity, because blend is the
  // difference that matters on screen: the shine ADDS (One/One), the diagnostic
  // REPLACES (One/Zero). A swap that got the material right and the blend wrong
  // would draw the diagnostic additively over the lit map, and "black" would
  // come back as "unchanged" — unreadable.
  ok('the mesh carries the ADDITIVE shine material by default', mesh.material.blendDst === THREE.OneFactor);
  ok('the reported debug channel is 0 — the effect as it ships', sub.getStatus().debugChannel === 0);

  // ── THE ISLAND PACK — the capability V2 never had ───────────────────────
  const status = sub.getStatus();
  ok('the island pack baked', !!status.islandPack && status.islandPack !== 'not baked');
  // ⚠️ THE ASSERTION THAT MATTERS. An unbaked or empty pack does not crash and
  // does not look broken: every texel falls back to the GLOBAL parallax, which
  // is exactly V2's one-frame-for-everything and is invisible on screen. This
  // number is the only way a silent degrade is ever noticed.
  ok('…and found the two painted objects as separate islands', status.islandPack.islands === 2);
  ok('…and labelled real texels', status.islandPack.labelledTexels > 0);
  ok('…and reports the label grid it used, so a coarse pack is visible', typeof status.islandPack.grid === 'string');
  // ⚠️ CHANNEL 6's OWN DIAGNOSTIC, MIRRORED IN THE REPORT — a real bake with
  // real islands must push status 2 (the hue-per-island picture), never the
  // magenta "never baked" or amber "baked empty" diagnostic colours. Wrong
  // here means the shader is about to show a false failure on a working pack.
  ok('the bake reports status 2 — real islands, not a diagnostic colour', status.islandBakeStatus === 2);

  // ── COVERAGE — the number the 2026-07-28 perf audit needs ────────────────
  // This pass costs ~3 ms and its per-pixel shader is genuinely heavy (a 27-cell
  // 3D Worley plus a 3D Perlin plus three shimmer layers), so TOTAL cost is
  // decided by covered pixels. `cropWasteRatio` is what distinguishes "the AABB
  // is tight and the shader is the problem" from "the AABB is loose and most
  // shaded pixels have presence 0" — two cases that look identical from the
  // cost alone and need opposite fixes.
  //
  // ⚠️ Pinned against the REAL producer because the first cut of this read
  // `islandInfo.w`/`.h`, which DO NOT EXIST — the pack reports `grid` as a
  // formatted string, so it would have silently returned null forever
  // (`feedback_read_the_producer_never_invent_its_shape`).
  ok(
    'the raw grid dimensions are exposed, not just the display string',
    status.islandPack.gridW > 0 && status.islandPack.gridH > 0
  );
  ok(
    '...and agree with the formatted grid',
    `${status.islandPack.gridW}x${status.islandPack.gridH}` === status.islandPack.grid
  );

  const cov = status.coverage;
  ok('coverage is reported', !!cov);
  ok('paintedFraction is a real fraction, not null', cov.paintedFraction > 0 && cov.paintedFraction <= 1);
  ok('aabbFractionOfItem is a real fraction, not null', cov.aabbFractionOfItem > 0 && cov.aabbFractionOfItem <= 1);
  // Two small objects in a large mask: the AABB spanning both MUST cover more
  // of the item than the paint itself does, so the waste ratio exceeds 1. That
  // is the whole signal — a ratio of 1 would mean the crop is perfectly tight.
  ok('the AABB covers at least as much as the paint (ratio >= 1)', cov.cropWasteRatio >= 1);
  ok(
    '...and the ratio is the quotient of the two reported fractions',
    Math.abs(cov.cropWasteRatio - cov.aabbFractionOfItem / cov.paintedFraction) < 0.15
  );
  ok('the note explains which way to read it', cov.note.includes('per-island'));

  // ── THE PER-ISLAND ESTIMATE, THREADED END TO END (2026-07-28 audit) ───────
  // `paintedRgba` is two solid, well-separated 8x8 boxes (64 true texels each)
  // on a 32x32 grid — no gaps, no clustering merge (they are 10 texels apart,
  // cluster radius is 3). Each box's own true-paint bounding box is exactly
  // itself, so the estimate should land very close to (64+64)/(32*32) = 0.125 —
  // proving `pack.estimatedPerIslandGridFraction` (specular-islands.js) reaches
  // `getStatus().coverage` (specular-surface-subsystem.js) through BOTH hops
  // (islandInfo, then the coverage closure) rather than getting dropped or
  // recomputed wrong at either seam.
  ok('estimatedPerIslandFractionOfItem is reported', cov.estimatedPerIslandFractionOfItem !== null);
  ok(
    '...and matches the hand-computed value for two solid separated boxes (128/1024 = 0.125)',
    Math.abs(cov.estimatedPerIslandFractionOfItem - 0.125) < 0.02
  );
  ok(
    'estimatedIslandWinRatio is reported and is a real ratio, not null',
    cov.estimatedIslandWinRatio !== null && cov.estimatedIslandWinRatio > 0
  );
  ok(
    '...and is exactly aabbFractionOfItem over the per-island estimate',
    Math.abs(cov.estimatedIslandWinRatio - cov.aabbFractionOfItem / cov.estimatedPerIslandFractionOfItem) < 0.15
  );

  // An unbaked pack must report null, never a fabricated 0 — "we have not
  // measured coverage" and "there is no metal" are different facts. The mask
  // load is async, so a subsystem read before it resolves is deterministically
  // pre-bake.
  const unbaked = makeSubsystem({}).getStatus();
  ok('an unbaked pack reports null coverage, never a fabricated 0', unbaked.coverage.paintedFraction === null);
  ok('...and null waste ratio too', unbaked.coverage.cropWasteRatio === null);
  ok('...and null for both new per-island fields too', unbaked.coverage.estimatedPerIslandFractionOfItem === null);
  ok('...the win ratio too — nothing to divide by yet', unbaked.coverage.estimatedIslandWinRatio === null);

  // A mask with real presence but NOTHING that clusters past the size floor
  // (every speck isolated, far below `SPECULAR_MIN_ISLAND_TEXELS` even alone)
  // must report status 1 — AMBER, a data fact, never magenta ("never baked").
  const nothingSurvives = makeSubsystem(
    { enabled: true, params: {}, debugChannel: 0 },
    { data: new Uint8Array(32 * 32 * 4), width: 32, height: 32 } // present but unpainted
  );
  nothingSurvives.sync(0, VIEW_RECT);
  await Promise.resolve();
  await Promise.resolve();
  ok('an unpainted mask still bakes (status 1, not stuck at 0)', nothingSurvives.getStatus().islandBakeStatus === 1);
  ok('…reporting zero islands, not a failure', nothingSurvives.getStatus().islandPack.islands === 0);
  nothingSurvives.dispose();

  // ── PICKING A CHANNEL ───────────────────────────────────────────────────
  const litMaterial = mesh.material;
  state.debugChannel = 4;
  sub.sync(0, VIEW_RECT);

  ok('picking a channel swaps the mesh onto a DIFFERENT material', mesh.material !== litMaterial);
  ok(
    '…and that material REPLACES rather than adds, so black reads as black',
    mesh.material.blendDst === THREE.ZeroFactor
  );
  // ⚠️ THE ASSERTION THIS FILE WAS WRITTEN FOR. `runSurfaceResponsePass` takes a
  // hard JS early-return on `!hasContent()`, so a false here means the pass
  // never draws and EVERY channel reads black — including the ones that are
  // fine. A diagnostic that cannot distinguish "the term is zero" from "I did
  // not run" is worse than none (`feedback_instruments_must_not_lie`).
  ok('the mesh stays visible on a channel — the pass must not early-return', mesh.visible === true);
  ok('hasContent() STILL true on a channel', sub.hasContent() === true);
  ok('getStatus() reports the channel, so it cannot be silently left on', sub.getStatus().debugChannel === 4);

  // ── BACK TO THE EFFECT ──────────────────────────────────────────────────
  state.debugChannel = 0;
  sub.sync(0, VIEW_RECT);
  ok('returning to 0 restores the additive shine material', mesh.material === litMaterial);
  ok('…and reports channel 0 again', sub.getStatus().debugChannel === 0);

  // ── DISABLED BEATS DEBUGGING ────────────────────────────────────────────
  // A picked channel must not resurrect an effect the author turned OFF, or
  // "off" stops meaning off the moment anyone opens the picker.
  state.enabled = false;
  state.debugChannel = 7;
  sub.sync(0, VIEW_RECT);
  ok('a disabled effect draws nothing even on a debug channel', mesh.visible === false);
  ok('…and hasContent() lets the pass skip entirely', sub.hasContent() === false);

  // ── PER-LAYER PARAMS REACH THE MATERIAL ─────────────────────────────────
  // The layers travel on the render state as an ARRAY, separately from the flat
  // param schema. A subsystem that read `state.params` only would leave all
  // twenty-four layer controls dead while every panel slider moved — which is
  // `feedback_seam_default_hides_unwired` exactly.
  const layered = makeSubsystem({
    enabled: true,
    params: {},
    debugChannel: 0,
    layers: [{ streak: 0.2 }, { density: 20 }, { parallaxDepth: -2 }],
  });
  let layerError = null;
  try {
    layered.sync(0, VIEW_RECT);
    await Promise.resolve();
    await Promise.resolve();
  } catch (err) {
    layerError = err;
  }
  ok(`per-layer params apply without throwing (${layerError ? layerError.message : 'clean'})`, layerError === null);

  // ── AN UNWIRED SEAM STILL RENDERS THE EFFECT ────────────────────────────
  // The viewer's own default is `{enabled: true, params: {}}` with NO
  // `debugChannel` and no `layers`. An `undefined` there must read as 0 and as
  // an empty list, never as NaN and never as a diagnostic mode.
  const unwired = makeSubsystem({ enabled: true, params: {} });
  unwired.sync(0, VIEW_RECT);
  await Promise.resolve();
  await Promise.resolve();
  ok('a render state with no debugChannel reads as 0, never NaN', unwired.getStatus().debugChannel === 0);
  ok('…and draws the effect', meshesOf(unwired)[0].visible === true);

  // ── THE COORDINATE TWIN ─────────────────────────────────────────────────
  // The mask lookup is now `uv()` remapped by these four numbers and nothing
  // else, so if the effect ever reads black again while the mask channel shows
  // art, this is the only suspect left — and it is four printable numbers.
  const m = unwired.getStatus().mapping;
  ok('getStatus() carries the coordinate twin', !!m);
  ok('the crop mask-UV extent is computed and reported', !!unwired.getStatus().maskUvBounds);
  const b = unwired.getStatus().maskUvBounds;
  const cb = unwired.getStatus().contentBoundsUv;
  // Wider than the painted content, because `toWorldBounds` adds the AABB pad —
  // handing the shader unpadded bounds would sample the mask slightly zoomed
  // in, shifting every glint by a few world px.
  ok('the bounds carry the AABB pad', b.minU < cb.minU && b.maxU > cb.maxU);
  // ⚠️ AND STAY INSIDE THE FILE. `uv()` cannot exceed 0..1, so these bounds are
  // the ONLY remaining way the mask sample could leave the texture — the exact
  // failure the world-space remap they replaced was measured committing.
  ok(
    'the bounds stay inside the file, so the sample can never leave the texture',
    b.minU >= 0 && b.minV >= 0 && b.maxU <= 1 && b.maxV <= 1
  );

  // ── SWITCHING TO A FLOOR WITH NO MASK CLEARS THE STALE QUAD ─────────────
  // Live bug, 2026-08-03: the author clicked three genuinely-metal, genuinely
  // on-screen spots and cranked strength to full with no visible change. The
  // channel probe showed `mask`/`strength`/`presence`/`tint` all healthy and
  // varying, but `floorGate`'s R channel (`floorMatch`) read exactly 0 at
  // every point while its B channel (`backgroundVisible`) read exactly 1 —
  // i.e. the pixel was genuinely plain, unoccluded Level background art, just
  // not the SAME floor this subsystem's single quad was tracking. Root cause:
  // `ensureMaskImage` only called `setFloorIndex` inside a NEW mask's load
  // callback, so a floor with no `_Specular` of its own left the PREVIOUS
  // floor's quad fully visible, still sampling real paint (floors share the
  // same x,y footprint), gated by a floor index that no longer matches
  // `buf:scene.attr` at those pixels — invisible no matter what `strength` is.
  // Only floor 0 has an authored `_Specular` file — every other floor genuinely
  // has none, mirroring the live report exactly (not a floor that HAS one but
  // is momentarily unavailable).
  const flip = createSpecularSurfaceSubsystem({
    THREE,
    getSpecularMaskUrl: (floorIndex) => (floorIndex === 0 ? 'stub://floor0_Specular.webp' : null),
    getSpecularMaskRect: () => ({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }),
    loadMaskImage: async () => ({
      texture: stubTexture(),
      contentBounds: { minU: 0.1, minV: 0.1, maxU: 0.9, maxV: 0.9 },
      data: paintedRgba(32, 32),
      width: 32,
      height: 32,
      nativeWidth: 64,
      nativeHeight: 64,
      bytes: 32 * 32 * 4,
    }),
    createMaskTexture: (data, w, h) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.needsUpdate = true;
      return t;
    },
    createPackTexture: (data, w, h) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.needsUpdate = true;
      return t;
    },
    illumTexture: stubTexture(),
    attrTexture: stubTexture(),
    timeMsNode: THREE.TSL.uniform(THREE.TSL.float(0)),
    uViewRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 1000, 1000)),
    uOutdoorsRect: THREE.TSL.uniform(THREE.TSL.vec4(0, 0, 1000, 1000)),
    outdoorsTexNode: THREE.TSL.texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    getSpecularRenderState: () => ({ enabled: true, params: {}, debugChannel: 0 }),
    getSkyHandle: () => null,
  });
  const flipMesh = meshesOf(flip)[0];

  flip.sync(0, VIEW_RECT);
  await Promise.resolve();
  await Promise.resolve();
  ok('floor 0 has a mask — the quad becomes visible', flipMesh.visible === true);
  ok('…and getStatus reports floor 0 loaded', flip.getStatus().floor === 0);

  // Move to a floor with NO specular of its own.
  flip.sync(1, VIEW_RECT);
  ok(
    'a floor with no mask of its own HIDES the mesh, rather than leaving floor 0’s quad up',
    flipMesh.visible === false
  );
  ok('…hasContent() agrees, so the pass early-returns', flip.hasContent() === false);
  ok('…and the stale bounds are actually cleared, not just hidden', flip.getStatus().bounds === null);

  // Moving back to floor 0 reloads it correctly rather than short-circuiting
  // on a stale `loadedUrl === url` check (the guard now only applies once a
  // URL is confirmed non-null).
  flip.sync(0, VIEW_RECT);
  await Promise.resolve();
  await Promise.resolve();
  ok('switching back to floor 0 reloads and shows it again', flipMesh.visible === true);
  ok('…and getStatus reports floor 0 again', flip.getStatus().floor === 0);

  flip.dispose();
  sub.dispose();
  unwired.dispose();
  layered.dispose();
}
