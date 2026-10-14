/**
 * water-surface-rebuild.test.mjs — A FLOOR WITH NO WATER MUST NOT REBUILD ITS
 * WATER MATERIALS, AND A FLOOR THAT GAINS WATER MUST REBUILD EXACTLY ONCE.
 *
 * ============================================================================
 * WHY THIS EXISTS (2026-10-14, perf trace of a scene with NO water)
 * ============================================================================
 * `buildWaterSurfaceMaterial` was showing up in the frame loop of a scene that
 * has no water anywhere: `sync()` → `buildSurfaceForTier` → the builder, every
 * frame. The mechanism:
 *
 *   1. The builder clamps the requested tier to 0 whenever `bodyTexture` is
 *      null (every rung >= 1 reads it unconditionally).
 *   2. A floor with no water never bakes a body pack, so `bodyTexture` is null
 *      FOREVER and the compiled tier is 0 forever.
 *   3. `sync()` compared the REQUESTED tier (1 at `low`, 2 at `performance`,
 *      4 at `quality` — every profile except `standard`) against the compiled
 *      0, saw a mismatch on every frame, and rebuilt all of the floor's
 *      materials — per floor, per frame, for nothing.
 *
 * The same bookkeeping had a second, quieter face: `builtForTier` was SEEDED
 * with the default tier (3) while the construction-time build had already
 * compiled at 0, so at the `standard` profile (resolved tier 3 === the seed)
 * `sync()` saw "nothing to do" and a floor that LATER gained water kept its
 * tier-0 materials, with `getStatus().perfTier` still claiming 3. (Reproduced
 * in Node before the fix: `waveNormal: false` — no sun/sky lobe — beside
 * `perfTier: 3`.)
 *
 * The real `createWaterSurfaceSubsystem` is constructed here against stubbed
 * seams (the same approach `specular-surface-subsystem.test.mjs` takes), so
 * these assertions exercise the actual `sync()` rather than a model of it.
 *
 * WHAT THIS DOES NOT PROVE: nothing about frame time in a browser — only that
 * the rebuild count is right. The graph is built, never compiled or drawn.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { buildWorldSpaceOutdoorsGate } from '../../lighting/environmental-light.js';
import { createWaterSurfaceSubsystem } from '../water-surface-subsystem.js';
import { buildWaterSurfaceMaterial, resolveWaterBuildTier, WATER_DEFAULT_TIER } from '../water-render.js';

const RECT = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
const VIEW = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };

/** A 1×1 texture — enough for a node to reference; never sampled here. */
function stubTexture() {
  const tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.needsUpdate = true;
  return tex;
}

/** `buildWaterSurfaceMaterial`'s own args, shaped as `buildSurfaceForTier` supplies them. */
function builderArgs(overrides = {}) {
  const { uniform, vec4, float } = THREE.TSL;
  return {
    THREE,
    maskTexture: stubTexture(),
    maskRect: RECT,
    bodyTexture: stubTexture(),
    bodyRect: RECT,
    capturedTexture: stubTexture(),
    capturedRect: RECT,
    capturedTexSize: { width: 512, height: 512 },
    timeMsNode: uniform(float(0)),
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    uOutdoorsRect: uniform(vec4(0, 0, 1000, 1000)),
    outdoorsTexNode: THREE.TSL.texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    ...overrides,
  };
}

/**
 * The real subsystem with every seam stubbed. `giveWater()` is the one thing
 * that changes between "a floor with no water" and "a floor whose body pack
 * just finished its first bake": the body texture appears and the bake
 * generation moves, exactly the two things `water-body-subsystem.js` does.
 * @param {number} perfTier
 */
function makeFloor(perfTier) {
  const { uniform, vec4, float } = THREE.TSL;
  const scene = new THREE.Scene();
  let bodyTexture = null;
  const waterBody = {
    get texture() {
      return bodyTexture;
    },
    getRect: () => ({ ...RECT }),
    getGridSize: () => [8, 8],
    getWaterBounds: () => (bodyTexture ? { minX: 100, minY: 100, maxX: 400, maxY: 400 } : null),
    bakeGeneration: 0,
  };
  const state = { enabled: true, params: {}, debugChannel: 0, perfTier };
  const sub = createWaterSurfaceSubsystem({
    THREE,
    scene,
    waterBody,
    getWaterMaskUrl: () => null,
    createMaskTexture: (data, w, h) => {
      const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      tex.needsUpdate = true;
      return tex;
    },
    loadMaskImage: async () => null,
    getWaterRenderState: () => state,
    timeMsNode: uniform(float(0)),
    uViewRect: uniform(vec4(0, 0, 1000, 1000)),
    uOutdoorsRect: uniform(vec4(0, 0, 1000, 1000)),
    outdoorsTexNode: THREE.TSL.texture(stubTexture()),
    buildOutdoorsGate: buildWorldSpaceOutdoorsGate,
    getSkyHandle: () => null,
  });
  const meshes = scene.children.filter((c) => c.isMesh);
  let seen = meshes.map((m) => m.material);
  return {
    sub,
    state,
    giveWater() {
      bodyTexture = stubTexture();
      waterBody.bakeGeneration++;
    },
    /** Run `n` frames; returns how many of them swapped in new materials. */
    syncFrames(n) {
      let swaps = 0;
      for (let i = 0; i < n; i++) {
        sub.sync(0, VIEW);
        const now = meshes.map((m) => m.material);
        if (now.some((m, k) => m !== seen[k])) swaps++;
        seen = now;
      }
      return swaps;
    },
  };
}

export function run(t) {
  const { ok } = t;

  // ── THE CLAMP RULE, AS A PURE FUNCTION ──────────────────────────────────
  ok(
    'no body pack clamps every tier to 0',
    [0, 1, 2, 3, 4, 5].every(
      (n) => resolveWaterBuildTier({ tier: n, hasBodyTexture: false, hasCapturedTexture: true }) === 0
    )
  );
  ok(
    'with a body pack, tiers 0-4 pass through',
    [0, 1, 2, 3, 4].every(
      (n) => resolveWaterBuildTier({ tier: n, hasBodyTexture: true, hasCapturedTexture: false }) === n
    )
  );
  ok(
    'tier 5 needs the captured texture, else it falls back to 4 (not 0)',
    resolveWaterBuildTier({ tier: 5, hasBodyTexture: true, hasCapturedTexture: false }) === 4 &&
      resolveWaterBuildTier({ tier: 5, hasBodyTexture: true, hasCapturedTexture: true }) === 5
  );
  ok(
    'a non-finite tier falls back to the default; negative and fractional tiers coerce like the builder',
    resolveWaterBuildTier({ tier: NaN, hasBodyTexture: true, hasCapturedTexture: true }) === WATER_DEFAULT_TIER &&
      resolveWaterBuildTier({ tier: -2, hasBodyTexture: true, hasCapturedTexture: true }) === 0 &&
      resolveWaterBuildTier({ tier: 2.9, hasBodyTexture: true, hasCapturedTexture: true }) === 2
  );

  // ── THE HELPER CANNOT DRIFT FROM THE BUILDER ────────────────────────────
  // `sync()` predicts what a rebuild compiles at with the helper; if the
  // builder ever clamped on a rule the helper did not know, `sync()` would be
  // back to rebuilding on a mismatch it can never close. So prove they agree
  // over every combination, against the REAL builder.
  {
    let disagreements = 0;
    let built = 0;
    for (const tier of [0, 1, 2, 3, 4, 5]) {
      for (const hasBody of [false, true]) {
        for (const hasCaptured of [false, true]) {
          const b = buildWaterSurfaceMaterial(
            builderArgs({
              tier,
              bodyTexture: hasBody ? stubTexture() : null,
              capturedTexture: hasCaptured ? stubTexture() : null,
            })
          );
          built++;
          const predicted = resolveWaterBuildTier({ tier, hasBodyTexture: hasBody, hasCapturedTexture: hasCaptured });
          if (b.tier !== predicted) disagreements++;
        }
      }
    }
    ok(
      `resolveWaterBuildTier agrees with buildWaterSurfaceMaterial's own tier across all ${built} inputs`,
      disagreements === 0
    );
  }

  // ── A FLOOR WITH NO WATER NEVER REBUILDS ────────────────────────────────
  // 30 frames at every resolved tier. Before the fix tiers 1, 2 and 4 swapped
  // the materials on 30/30 frames (tier 3 happened to equal the seed).
  for (const tier of [0, 1, 2, 3, 4]) {
    const floor = makeFloor(tier);
    const swaps = floor.syncFrames(30);
    ok(`no water, resolved tier ${tier}: the materials are never rebuilt (${swaps}/30 frames swapped)`, swaps === 0);
  }

  // ── …AND REPORTS ITSELF HONESTLY ────────────────────────────────────────
  {
    const floor = makeFloor(4);
    floor.syncFrames(3);
    const st = floor.sub.getStatus();
    ok('a no-water floor compiled tier 0', st.perfTier === 0);
    ok('…while still reporting what the cascade resolved', st.resolvedTier === 4);
    ok('…and says why they differ', typeof st.tierClamp === 'string' && st.tierClamp.length > 0);
    ok(
      'inertControls blames the missing water body, not the profile',
      typeof st.inertControls === 'string' && st.inertControls.includes('no baked water body')
    );
  }

  // ── A FLOOR THAT GAINS WATER REBUILDS EXACTLY ONCE, AT THE REAL TIER ────
  // Tier 3 is the case the seeded `builtForTier` used to hide: the resolved
  // tier equals the seed, so nothing ever fired and the floor kept tier 0.
  for (const tier of [1, 2, 3, 4]) {
    const floor = makeFloor(tier);
    const before = floor.syncFrames(5);
    floor.giveWater();
    const arrival = floor.syncFrames(1);
    const after = floor.syncFrames(25);
    const st = floor.sub.getStatus();
    ok(`water arrives, resolved tier ${tier}: idle before it (${before} swaps)`, before === 0);
    ok(`water arrives, resolved tier ${tier}: rebuilt on the very frame the body pack lands`, arrival === 1);
    ok(`water arrives, resolved tier ${tier}: then stable (${after} swaps in the next 25 frames)`, after === 0);
    ok(
      `water arrives, resolved tier ${tier}: compiled at the real tier (reports ${st.perfTier})`,
      st.perfTier === tier
    );
    ok(`water arrives, resolved tier ${tier}: no clamp reported once it has water`, st.tierClamp === null);
    if (tier >= 3) {
      ok(
        `water arrives, resolved tier ${tier}: the tier-3 sun/sky lobe really compiled (waveNormal ${st.waveNormal})`,
        st.waveNormal === true
      );
    }
  }

  // ── A GENUINE TIER CHANGE STILL REBUILDS — ONCE ─────────────────────────
  {
    const floor = makeFloor(4);
    floor.syncFrames(2);
    floor.giveWater();
    floor.syncFrames(3);
    floor.state.perfTier = 2; // the author drops the performance profile
    const change = floor.syncFrames(1);
    const settled = floor.syncFrames(10);
    ok('a profile change on a floor with water rebuilds once', change === 1);
    ok('…then settles', settled === 0);
    ok('…at the new tier', floor.sub.getStatus().perfTier === 2);
  }

  // ── A TIER CHANGE ON A WATERLESS FLOOR COSTS NOTHING ────────────────────
  // Every request clamps to the same tier 0, so there is nothing to rebuild.
  {
    const floor = makeFloor(2);
    floor.syncFrames(3);
    floor.state.perfTier = 4;
    const swaps = floor.syncFrames(10);
    ok(`a profile change on a no-water floor swaps nothing (${swaps} swaps)`, swaps === 0);
    ok('…but the status follows the new request', floor.sub.getStatus().resolvedTier === 4);
  }
}
