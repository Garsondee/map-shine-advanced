/**
 * water-body-subsystem.test.mjs — the orchestration logic, with a fake
 * allocator and a fake render pass, same reasoning as
 * `water-sim-subsystem.test.mjs`'s own header: everything GPU-touching is
 * injected (`allocator`, `renderWaterPass`, `createWaterMaskTexture`), so
 * the control-flow question this file exists to pin — does `maybeBake`
 * actually RETRY a declined bake, or does it get stuck — is testable
 * without a real device.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS NOW, NOT EARLIER
 * ============================================================================
 * Live-reported 2026-08-23: water rendered on nothing, on two different
 * maps, no console errors. `maybeBake`'s own `unchanged` gate (checked
 * against `bakedVersion`/`bakedFloor`/`bakedOverride`) was being stamped
 * to "current" UNCONDITIONALLY, before `uploadMask` was even attempted —
 * so the very first poll of any session, which races ahead of
 * `water-surface-subsystem.js#ensureMaskImage`'s own async fetch almost
 * every time, declined ONCE and then, because the stamp already matched,
 * the `unchanged` gate silently swallowed every later poll for the rest
 * of the session. The fetch finishing was never itself a "mask authority
 * version" change, so nothing ever re-tripped the gate. Fixed by moving
 * the stamp to only the two TERMINAL outcomes (no water in this scene;
 * a completed bake) — never the "not ready yet" decline. This file's own
 * `retries a declined bake` block below is the permanent guard.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { createWaterBodySubsystem, deriveBodyPresenceThreshold } from '../water-body-subsystem.js';
import { WATER_PRESENCE_EPS } from '../water-body.js';
import { WATER_PRESENCE_EDGE1 } from '../water-render.js';

function fakeAllocator() {
  let created = 0;
  let disposed = 0;
  return {
    create(name, describe) {
      created++;
      return { name, describe, texture: { name }, dispose() {} };
    },
    dispose(rt) {
      if (rt) disposed++;
    },
    get created() {
      return created;
    },
    get disposed() {
      return disposed;
    },
  };
}

function fakeRenderPass() {
  let calls = 0;
  return {
    run(target, quad) {
      calls++;
      if (!target || !quad) throw new Error(`renderWaterPass call #${calls} got a missing target/quad`);
    },
    get calls() {
      return calls;
    },
  };
}

/** A minimal, structurally-valid `MaskGrid` — `uploadMask` only needs real
 * shapes here, not real water content (it returns `ok: true` even when the
 * scanned AABB is empty — see that function's own `waterTexels: 'none'`
 * branch). One non-zero byte is included anyway so the AABB scan has a real
 * answer to give, closer to what `uploadMask` sees on an actual map. */
function fakeMaskGrid(w = 4, h = 4) {
  const data = new Uint8Array(w * h);
  data[0] = 255;
  return {
    grid: {
      spec: { w, h, x: 0, y: 0, width: w * 10, height: h * 10, texelW: 10, texelH: 10 },
      data,
    },
  };
}

function buildHarness({ maskTextureAvailable = true, getWaterRenderState } = {}) {
  const allocator = fakeAllocator();
  const pass = fakeRenderPass();
  let fullResTexture = maskTextureAvailable ? { name: 'full-res-mask', isTextureNode: false } : null;
  const subsystem = createWaterBodySubsystem({
    THREE,
    allocator,
    getWaterMaskGrid: () => fakeMaskGrid(),
    getFloorsWithWater: () => [0],
    getMaskAuthorityVersion: () => 1,
    renderWaterPass: (t, q) => pass.run(t, q),
    createWaterMaskTexture: (data, w, h, filter) => {
      const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.needsUpdate = true;
      t.__filter = filter;
      return t;
    },
    waterSurface: { getFullResMaskTexture: () => fullResTexture },
    getWaterRenderState,
  });
  return {
    subsystem,
    allocator,
    pass,
    setFullResTexture(t) {
      fullResTexture = t;
    },
  };
}

export function run(t) {
  const { ok } = t;

  // ══ construction is clean, and the pre-bake state is honest ═════════════
  {
    const { subsystem } = buildHarness();
    ok('texture is null before any bake', subsystem.texture === null);
    ok('bakeGeneration starts at 0', subsystem.bakeGeneration === 0);
    ok('getWaterBounds is null before any bake', subsystem.getWaterBounds() === null);
    const status = subsystem.getStatus();
    ok(
      'getStatus reports zero bakes, zero polls before the first maybeBake call',
      status.bakes === 0 && status.polls === 0
    );
  }

  // ══ THE BUG'S OWN SHAPE — a declined bake retries on every poll, forever,
  // until it succeeds, never getting stuck after exactly one attempt ══════
  {
    const { subsystem, allocator, pass, setFullResTexture } = buildHarness({ maskTextureAvailable: false });

    subsystem.maybeBake(0);
    ok('poll 1: no full-res texture yet, declines rather than baking', subsystem.getStatus().bakes === 0);
    ok(
      'poll 1: the decline names the real reason, not a generic failure',
      String(subsystem.getStatus().lastBake?.reason ?? '').includes('full-resolution mask')
    );
    ok('poll 1: nothing was allocated for a declined bake', allocator.created === 0);
    ok('poll 1: nothing was rendered for a declined bake', pass.calls === 0);

    // THE REGRESSION ITSELF: with the bug, THIS second poll (mask authority
    // version and floor both still unchanged from poll 1) would see
    // `unchanged === true` and return before ever asking `uploadMask`
    // again — `bakes` would stay 0 forever even once the texture arrives,
    // which the THIRD poll below is what actually proves.
    subsystem.maybeBake(0);
    ok(
      'poll 2: still declines (texture still not ready) — same honest reason, not silently different',
      subsystem.getStatus().bakes === 0
    );

    // THE TEXTURE ARRIVES — `water-surface-subsystem.js#ensureMaskImage`'s
    // own async fetch finishing, modelled here as the fake texture becoming
    // available with NO change to mask-authority version, floor, or
    // override (exactly the real live sequence: nothing about the SCENE
    // changed, only time passing let the fetch resolve).
    setFullResTexture({ name: 'full-res-mask-arrived' });

    subsystem.maybeBake(0);
    ok(
      'poll 3: a real texture now exists, and the SAME unchanged mask-authority version does not block the retry',
      subsystem.getStatus().bakes === 1
    );
    ok('poll 3: a real bake actually allocated its targets', allocator.created > 0);
    ok('poll 3: a real bake actually rendered', pass.calls > 0);
    ok('poll 3: texture is now real', subsystem.texture !== null);

    // ONE MORE POLL, everything still unchanged — must NOT bake again
    // (this is the gate's own POSITIVE case: once genuinely baked, a quiet
    // poll costs one integer compare, not a second flood).
    const bakesBefore = subsystem.getStatus().bakes;
    const rendersBefore = pass.calls;
    subsystem.maybeBake(0);
    ok('poll 4: unchanged after a real bake correctly skips re-baking', subsystem.getStatus().bakes === bakesBefore);
    ok('poll 4: unchanged after a real bake renders nothing new', pass.calls === rendersBefore);
  }

  // ══ "NO WATER IN THIS SCENE" IS A STABLE TERMINAL STATE, NOT A RETRY LOOP
  // — the OTHER place this function stamps bakedVersion/bakedFloor/
  // bakedOverride, confirmed still correct after the fix above ═════════════
  {
    const allocator = fakeAllocator();
    const pass = fakeRenderPass();
    const subsystem = createWaterBodySubsystem({
      THREE,
      allocator,
      getWaterMaskGrid: () => fakeMaskGrid(),
      getFloorsWithWater: () => [], // no floor in the scene has water
      getMaskAuthorityVersion: () => 1,
      renderWaterPass: (t, q) => pass.run(t, q),
      createWaterMaskTexture: (data, w, h, filter) => {
        const tx = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
        tx.needsUpdate = true;
        tx.__filter = filter;
        return tx;
      },
      waterSurface: { getFullResMaskTexture: () => ({ name: 'irrelevant — no water to bake' }) },
    });

    subsystem.maybeBake(0);
    subsystem.maybeBake(0);
    subsystem.maybeBake(0);
    const status = subsystem.getStatus();
    ok('no water in the scene: never bakes', status.bakes === 0);
    ok('no water in the scene: never renders', pass.calls === 0);
    ok(
      'no water in the scene: the resolve reason says so plainly',
      String(status.resolve?.reason ?? '').includes('no floor in this scene')
    );
  }

  // ══ `deriveBodyPresenceThreshold` — the soft-mask-bleed fix's own formula
  // (live-reported 2026-08-23: "shore threshold does push some things back,
  // but not everything... foam is appearing far outside the white part of
  // _Water") ═══════════════════════════════════════════════════════════════
  {
    ok(
      'at or below the legacy default, the derived threshold is EXACTLY WATER_PRESENCE_EPS — zero behaviour ' +
        'change for a floor that never touches the newly-raised (a21df2e) upper half of the slider',
      deriveBodyPresenceThreshold(WATER_PRESENCE_EDGE1) === WATER_PRESENCE_EPS &&
        deriveBodyPresenceThreshold(0.1) === WATER_PRESENCE_EPS &&
        deriveBodyPresenceThreshold(0) === WATER_PRESENCE_EPS
    );
    ok(
      'above the legacy default, the derived threshold rises one-for-one with the excess',
      Math.abs(deriveBodyPresenceThreshold(0.9) - (0.9 - WATER_PRESENCE_EDGE1)) < 1e-9
    );
    ok(
      'at the schema max, the derived threshold is meaningfully tighter than the old EPS',
      deriveBodyPresenceThreshold(0.98) > 0.4
    );
    ok(
      'never finite but degenerate input throws or NaNs — falls back to the legacy default',
      deriveBodyPresenceThreshold(undefined) === WATER_PRESENCE_EPS
    );
    ok(
      'monotonic — never DECREASES as shorelineDepth rises',
      deriveBodyPresenceThreshold(0.7) <= deriveBodyPresenceThreshold(0.8)
    );
  }

  // ══ `shorelineDepth` triggers a REBAKE, not just a live uniform poke — the
  // integration half of the same fix: mask/floor/version all unchanged, only
  // the shoreline slider moves, and that alone must still bake again ═══════
  {
    let params = { shorelineDepth: WATER_PRESENCE_EDGE1 };
    const { subsystem, pass } = buildHarness({ getWaterRenderState: () => ({ params }) });

    subsystem.maybeBake(0);
    const bakesAfterFirst = subsystem.getStatus().bakes;
    ok('first bake at the legacy default succeeds', bakesAfterFirst === 1);
    const firstThreshold = subsystem.getStatus().lastBake?.presenceThreshold;
    ok(
      'at the legacy default, the baked threshold IS WATER_PRESENCE_EPS',
      Math.abs(firstThreshold - WATER_PRESENCE_EPS) < 1e-9
    );

    // Poll again, nothing changed at all — must NOT rebake (the existing
    // gate's own positive case, unaffected by this fix).
    const rendersBeforeQuietPoll = pass.calls;
    subsystem.maybeBake(0);
    ok('an unchanged shorelineDepth does not trigger a second bake', subsystem.getStatus().bakes === bakesAfterFirst);
    ok('an unchanged shorelineDepth renders nothing new', pass.calls === rendersBeforeQuietPoll);

    // NOW move only the slider — mask authority version, floor, and override
    // all stay exactly as they were.
    params = { shorelineDepth: 0.9 };
    subsystem.maybeBake(0);
    ok(
      'raising shorelineDepth ALONE triggers a real rebake — this is the actual fix, the mask/floor gate ' +
        'alone would have silently done nothing forever',
      subsystem.getStatus().bakes === bakesAfterFirst + 1
    );
    const secondThreshold = subsystem.getStatus().lastBake?.presenceThreshold;
    ok(
      'the rebake used the NEW derived threshold, tighter than before',
      secondThreshold > firstThreshold && Math.abs(secondThreshold - (0.9 - WATER_PRESENCE_EDGE1)) < 1e-9
    );
  }

  // ══ THE BAKE ITSELF IS THROTTLED, NOT THE POLL (2026-08-25) — a burst of
  // real changes landing faster than BAKE_THROTTLE_MS (e.g. dragging ANY
  // slider that bumps mask-authority's shared version counter, not just a
  // water one — see `lastBakeWallClockMs`'s own doc) must not pay for a full
  // bake on every single poll, but must never lose the change either ═══════
  {
    let params = { shorelineDepth: WATER_PRESENCE_EDGE1 };
    const { subsystem, pass } = buildHarness({ getWaterRenderState: () => ({ params }) });

    subsystem.maybeBake(0, 1000);
    ok('first timed bake is never throttled', subsystem.getStatus().bakes === 1);

    // A real change lands 50ms later — well inside the 150ms window.
    params = { shorelineDepth: 0.6 };
    subsystem.maybeBake(0, 1050);
    ok('a real change inside the throttle window does not bake immediately', subsystem.getStatus().bakes === 1);
    ok(
      'the throttled poll names itself, not a generic skip',
      String(subsystem.getStatus().lastBake?.reason ?? '').includes('throttled')
    );
    const rendersWhileThrottled = pass.calls;

    // Still inside the window — must keep declining, not get stuck.
    subsystem.maybeBake(0, 1100);
    ok('still inside the window on a later poll keeps declining', subsystem.getStatus().bakes === 1);
    ok('nothing rendered while throttled', pass.calls === rendersWhileThrottled);

    // Past the window — the SAME pending change must now bake for real, with
    // no further slider movement needed to "notice" it again.
    subsystem.maybeBake(0, 1200);
    ok('past the throttle window, the deferred change finally bakes', subsystem.getStatus().bakes === 2);
    ok('the deferred bake actually rendered', pass.calls > rendersWhileThrottled);
    const deferredThreshold = subsystem.getStatus().lastBake?.presenceThreshold;
    ok(
      'the deferred bake used the CURRENT value, never a stale snapshot from when it was first deferred',
      Math.abs(deferredThreshold - (0.6 - WATER_PRESENCE_EDGE1)) < 1e-9
    );
  }

  // ══ `nowMs` IS OPTIONAL — every caller that predates the throttle (every
  // OTHER block in this file) must see byte-identical behaviour to before it
  // existed ═════════════════════════════════════════════════════════════════
  {
    let params = { shorelineDepth: WATER_PRESENCE_EDGE1 };
    const { subsystem } = buildHarness({ getWaterRenderState: () => ({ params }) });

    subsystem.maybeBake(0); // no nowMs at all
    ok('no nowMs: first bake still succeeds', subsystem.getStatus().bakes === 1);
    params = { shorelineDepth: 0.6 };
    subsystem.maybeBake(0); // immediately again — inside any real throttle window
    ok(
      'no nowMs: a real change bakes immediately, exactly like before the throttle existed',
      subsystem.getStatus().bakes === 2
    );
  }

  // ══ dispose — the same clean-state contract every sibling subsystem has ══
  {
    const { subsystem, allocator, setFullResTexture } = buildHarness({ maskTextureAvailable: false });
    setFullResTexture({ name: 'full-res-mask' });
    subsystem.maybeBake(0);
    ok('sanity: this harness actually baked before dispose is tested', subsystem.getStatus().bakes === 1);
    subsystem.dispose();
    ok('dispose releases every allocated target', allocator.disposed >= 3); // body + jfa ping + jfa pong
    ok('dispose clears the texture getter', subsystem.texture === null);
    ok(
      'dispose clears the grid size back to the pre-bake placeholder',
      subsystem.getGridSize()[0] === 1 && subsystem.getGridSize()[1] === 1
    );
  }
}
