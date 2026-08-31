/**
 * sun-shadow-subsystem.test.mjs — the bake-throttle's own control-flow proof,
 * mirroring `water-body-subsystem.test.mjs`'s own header reasoning exactly:
 * everything GPU-touching is injected (`allocator`, `renderSunShadowPass`,
 * `createCasterTexture`), so the question this file exists to pin — does the
 * throttle actually defer a pending change and retry it, or does it get
 * stuck, or does it fire on every burst tick regardless — is testable
 * without a real device.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS NOW (2026-08-25)
 * ============================================================================
 * §5.8 of the 2026-08 perf audit named this subsystem's own `maybeBake`
 * alongside water's: BOTH read mask-authority's ONE shared `productsVersion`
 * counter, and BOTH re-ran their full (expensive) bake on every distinct
 * value the counter took, with no wall-clock debounce — so dragging a slider
 * with nothing to do with sun-shadows (wall height, a Tile field, a water
 * mask brushstroke) still forced a full repack + 4 MB upload + GPU march on
 * every tick of the drag, PER RESIDENT FLOOR SLOT. Fixed the same way water
 * was: an optional `nowMs` throttles the actual bake, never the cheap version
 * check — see `sun-shadow-subsystem.js#SUN_SHADOW_BAKE_THROTTLE_MS` for the
 * full mechanism.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { createSunShadowSubsystem } from '../sun-shadow-subsystem.js';

function fakeAllocator() {
  let created = 0;
  let disposed = 0;
  return {
    create(name, describe) {
      created++;
      return { name, describe, texture: { name }, setSize() {}, dispose() {} };
    },
    resize(handle, w, h) {
      handle?.setSize?.(w, h);
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
      if (!target || !quad) throw new Error(`renderSunShadowPass call #${calls} got a missing target/quad`);
    },
    get calls() {
      return calls;
    },
  };
}

/** A minimal, structurally-valid MaskGrid — `{spec, data}`, the SAME shape
 * `caster-pack.test.mjs#grid` builds, duplicated rather than imported for the
 * same reason every effects-zone test file duplicates its own tiny fixtures
 * (`water-body-subsystem.js`'s own header states the house convention: no
 * reaching into a sibling for four lines of arithmetic). */
function grid(w = 4, h = 4, worldW = 1000, worldH = 1000, fill = 0) {
  const data = new Uint8Array(w * h);
  if (fill) data.fill(fill);
  return { spec: { x: 0, y: 0, width: worldW, height: worldH, w, h, texelW: worldW / w, texelH: worldH / h }, data };
}

/** A structurally-valid caster height field, for ANY floor index — real
 * shapes, not real content (`uploadMask`'s own `fakeMaskGrid` sibling in
 * water's test file does the identical thing), so `bakeLayerTexture` actually
 * succeeds (`ok: true`) and the chain it triggers — nulling `bakedSun`, which
 * forces the next `sunNeedsRebake` read true — is exercised for real rather
 * than short-circuited by a declined bake. */
function fakeCasterHeightField() {
  return {
    channels: { coverOverhead: grid(4, 4) },
    outdoors: grid(4, 4, 1000, 1000, 200),
    coverAbove: null,
    outdoorsLedger: null,
    completeness: null,
  };
}

function buildHarness({ getMaskAuthorityVersion = () => 1, getSunShadowRenderState, atmosphere } = {}) {
  const allocator = fakeAllocator();
  const pass = fakeRenderPass();
  const sun = { azimuthDeg: 200, elevationDeg: 40, strengthMul: 1, softnessMul: 1, ...atmosphere };
  const defaultState = { enabled: true, params: {} };
  const subsystem = createSunShadowSubsystem({
    THREE,
    allocator,
    dimensions: { sceneRect: { x: 0, y: 0, width: 1000, height: 1000 } },
    getCasterHeightField: () => fakeCasterHeightField(),
    getSunShadowRenderState: getSunShadowRenderState ?? (() => defaultState),
    getMaskAuthorityVersion,
    getShadowHandle: () => ({ atmosphere: sun }),
    getEnvLight: () => ({ setSunShadowRect() {}, setSunShadowFloorIndex() {}, uViewRect: null }),
    renderSunShadowPass: (t, q) => pass.run(t, q),
    createCasterTexture: (data, w, h) => {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.needsUpdate = true;
      return tex;
    },
  });
  return { subsystem, allocator, pass };
}

export function run(t) {
  const { ok } = t;

  // ══ construction is clean — six slots, built eagerly (§5), none claimed ═
  {
    const { subsystem, pass } = buildHarness();
    ok('six slots are built eagerly (§5)', subsystem.fields.length === 6);
    ok('no renders happen at construction — only maybeBake triggers a march', pass.calls === 0);
    const status = subsystem.getStatus();
    ok('slotsTotal reports the cap', status.slotsTotal === 6);
    ok('nothing is claimed before the first maybeBake', status.slotsUsed === 0 && status.floors.length === 0);
  }

  // ══ THE BAKE ITSELF IS THROTTLED, NOT THE VERSION CHECK (2026-08-25) — a
  // burst of mask-authority version bumps landing faster than the throttle
  // window (e.g. dragging ANY slider that bumps the shared counter, not just
  // a sun-shadow one — see `SUN_SHADOW_BAKE_THROTTLE_MS`'s own doc) must not
  // pay for a full repack+upload+march on every single poll, but must never
  // lose the pending change either ═══════════════════════════════════════
  {
    let version = 1;
    const { subsystem, pass } = buildHarness({ getMaskAuthorityVersion: () => version });

    subsystem.maybeBake(0, 1000);
    const rendersAfterFirst = pass.calls;
    ok('first timed bake is never throttled and runs a real GPU march', rendersAfterFirst > 0);
    ok(
      'the first bake does not report itself as throttled',
      !String(subsystem.getStatus().floors[0]?.lastBake?.reason ?? '').includes('throttled')
    );

    // A real version bump (the shared mask-authority counter — could just as
    // easily be an unrelated wall-height drag) lands 50ms later — well inside
    // the 150ms window.
    version = 2;
    subsystem.maybeBake(0, 1050);
    ok('a real change inside the throttle window does not bake immediately', pass.calls === rendersAfterFirst);
    ok(
      'the throttled poll names itself, not a generic skip',
      String(subsystem.getStatus().floors[0]?.lastBake?.reason ?? '').includes('throttled')
    );

    // Still inside the window on a later poll — must keep declining, not get
    // stuck reporting the same stale state forever.
    subsystem.maybeBake(0, 1100);
    ok('still inside the window on a later poll keeps declining', pass.calls === rendersAfterFirst);

    // Past the window — the SAME pending version bump must now bake for real,
    // with no further change needed to "notice" it again.
    subsystem.maybeBake(0, 1200);
    ok('past the throttle window, the deferred change finally bakes', pass.calls > rendersAfterFirst);
    ok(
      'the deferred bake no longer reports itself as throttled',
      !String(subsystem.getStatus().floors[0]?.lastBake?.reason ?? '').includes('throttled')
    );

    // One more poll, everything now unchanged — must NOT re-bake (the gate's
    // own positive case: once genuinely caught up, a quiet poll costs a
    // handful of comparisons, not a second march).
    const rendersAfterCatchUp = pass.calls;
    subsystem.maybeBake(0, 1250);
    ok('unchanged after the deferred bake correctly skips re-baking', pass.calls === rendersAfterCatchUp);
  }

  // ══ `nowMs` IS OPTIONAL — every caller that predates the throttle must see
  // byte-identical behaviour to before it existed ═══════════════════════════
  {
    let version = 1;
    const { subsystem, pass } = buildHarness({ getMaskAuthorityVersion: () => version });

    subsystem.maybeBake(0); // no nowMs at all
    const rendersAfterFirst = pass.calls;
    ok('no nowMs: first bake still runs a real march', rendersAfterFirst > 0);

    version = 2;
    subsystem.maybeBake(0); // immediately again — inside any real throttle window
    ok(
      'no nowMs: a real change bakes immediately, exactly like before the throttle existed',
      pass.calls > rendersAfterFirst
    );
  }

  // ══ THE OFF PATH IS NEVER THROTTLED — already the cheap collapsed path
  // (§4: a single 1×1 draw per "off" spell), not the one this throttle
  // exists to protect ═══════════════════════════════════════════════════════
  {
    const { subsystem, pass } = buildHarness({ getSunShadowRenderState: () => ({ enabled: false, params: {} }) });

    subsystem.maybeBake(0, 1000);
    const rendersAfterOff = pass.calls;
    ok('disabled: collapses to one 1×1 bake, not a real march', rendersAfterOff > 0);

    // Immediately again, well inside any throttle window — the "off" path
    // must still be a provable no-op on the second call, guarded by
    // `offFieldWritten`, never by the wall clock.
    subsystem.maybeBake(0, 1010);
    ok('disabled: a second immediate poll does not re-bake', pass.calls === rendersAfterOff);
  }
}
