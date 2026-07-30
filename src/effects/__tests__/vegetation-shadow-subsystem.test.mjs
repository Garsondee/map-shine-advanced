/**
 * vegetation-shadow-subsystem.test.mjs — the pad constant and `syncUniforms`'s
 * "is this shadow worth drawing" verdict.
 *
 * Why the verdict has a test at all: a zero-strength vegetation shadow used to
 * still rasterise a quad padded to ~1.29x its item's area and pay all 15
 * texture fetches per fragment to output `vec4(0,0,0,0)`. Not drawing it is
 * free and invisible — but ONLY if the decision reads the EFFECTIVE strength
 * (post shadow-handle) rather than the raw param, and only if the uniforms are
 * still synced on the frames it says "no" so the shadow comes back correct the
 * instant strength returns. Both are asserted below.
 *
 * See docs/planning/Performance-Insights.md §4.
 */
import {
  createVegetationShadowSubsystem,
  vegetationShadowPadPx,
  VEG_SHADOW_SMEAR_TAPS,
} from '../vegetation-shadow-subsystem.js';
import { VEGETATION_KINDS } from '../vegetation.js';

/** A uniform bag shaped like the one `buildVegetationMaterial` returns. */
function fakeShadowUniforms() {
  const vec2 = () => ({
    x: 0,
    y: 0,
    set(x, y) {
      this.x = x;
      this.y = y;
    },
  });
  return {
    uShadowSmearUv: { value: vec2() },
    uShadowSmearTaper: { value: -1 },
    uShadowPenumbraUv: { value: vec2() },
    uShadowStrength: { value: -1 },
    uShadowSmearLod: { value: -1 },
    artTexelsPerWorldPx: 1,
  };
}

/** The subsystem with every injected dep faked; only `syncUniforms` is exercised. */
function makeSubsystem({ castStrength }) {
  return createVegetationShadowSubsystem({
    THREE: {},
    scene: { add() {} },
    dimensions: { sceneRect: { x: 0, y: 0, width: 4000, height: 4000 } },
    getShadowHandle: () => ({
      atmosphere: { elevationDeg: 45 },
      forCaster: () => ({ offsetX: 40, offsetY: 25, offsetPx: 47, penumbraPx: 6, strength01: castStrength }),
    }),
    setTileGeometry() {},
    buildVegetationMaterial: () => ({}),
  });
}

const PLACEMENT = { x: 2000, y: 2000, width: 4000, height: 4000 };
/** `edgeFadeWidthPx: 0` makes the map-edge ramp an exact no-op (bandPx 0 → 1). */
const PARAMS = { shadowStrength: 0.45, edgeFadeWidthPx: 0 };
const TREE = VEGETATION_KINDS.find((k) => k.id === 'tree');

export function run(t) {
  const { ok } = t;

  // --- the drawable verdict ------------------------------------------------
  {
    const sub = makeSubsystem({ castStrength: 0.45 });
    const uni = fakeShadowUniforms();
    ok(
      'syncUniforms returns true when the effective strength is above zero',
      sub.syncUniforms(uni, TREE, PLACEMENT, PARAMS) === true
    );
    ok('...and it wrote the strength through', uni.uShadowStrength.value === 0.45);
  }
  {
    const sub = makeSubsystem({ castStrength: 0 });
    ok(
      'syncUniforms returns false when the effective strength is exactly zero',
      sub.syncUniforms(fakeShadowUniforms(), TREE, PLACEMENT, PARAMS) === false
    );
  }
  {
    const sub = makeSubsystem({ castStrength: 0.45 });
    ok(
      'a missing uniform bag returns false rather than undefined',
      sub.syncUniforms(null, TREE, PLACEMENT, PARAMS) === false
    );
  }

  // THE ONE THAT MATTERS: the verdict must read the shadow handle's EFFECTIVE
  // strength, not `params.shadowStrength`. A handle that zeroes strength (night,
  // or any future per-caster cutoff) then stops costing fill for free — and if
  // this ever regresses to reading the raw param, the saving silently vanishes
  // while every test that only checks the on/off slider still passes.
  {
    const sub = makeSubsystem({ castStrength: 0 });
    ok(
      'a handle that zeroes strength wins over a high raw shadowStrength param',
      sub.syncUniforms(fakeShadowUniforms(), TREE, { ...PLACEMENT }, { shadowStrength: 1, edgeFadeWidthPx: 0 }) ===
        false
    );
  }

  // --- a "no" must NOT skip the sync --------------------------------------
  // Visibility is decided every frame but the uniforms are what make the shadow
  // correct the frame strength returns. If a false verdict early-returned before
  // writing them, raising the slider would show a stale shadow until the next
  // pan — the exact residency-lag bug this subsystem's own header records.
  {
    const sub = makeSubsystem({ castStrength: 0 });
    const uni = fakeShadowUniforms();
    sub.syncUniforms(uni, TREE, PLACEMENT, PARAMS);
    ok(
      'a false verdict still wrote the smear vector',
      uni.uShadowSmearUv.value.x === 40 / 4000 && uni.uShadowSmearUv.value.y === 25 / 4000
    );
    ok('a false verdict still wrote the taper', uni.uShadowSmearTaper.value >= 0);
    ok('a false verdict still wrote the penumbra', uni.uShadowPenumbraUv.value.x === 6 / 4000);
    ok('a false verdict still wrote the smear LOD', uni.uShadowSmearLod.value >= 0);
  }

  // --- the pad is what makes the shadow expensive, so pin its shape ---------
  {
    const treePad = vegetationShadowPadPx(TREE);
    const bushPad = vegetationShadowPadPx(VEGETATION_KINDS.find((k) => k.id === 'bush'));
    ok('a tree pads further than a bush (throw scales with declared height)', treePad > bushPad);
    ok('the tree pad stays under the hard 320px ceiling', treePad <= 320);
    ok('an unknown kind pads by a finite amount rather than NaN', Number.isFinite(vegetationShadowPadPx(undefined)));
    ok('the smear tap count is the shared constant the material builds against', VEG_SHADOW_SMEAR_TAPS === 6);
  }

  // ==========================================================================
  // THE PERFORMANCE-TIER TAP COUNT (2026-07-29) — a resolved tier can build a
  // DIFFERENT smear-station count (vegetation-render.js#vegetationTierPlan)
  // than this module's own default. `syncUniforms`'s gap/LOD math MUST read
  // whatever count the shader actually unrolled, stashed on the SAME uniform
  // bag as `smearTaps` — never silently re-assume `VEG_SHADOW_SMEAR_TAPS`, or
  // the ladder-fix's "consecutive stations overlap" guarantee breaks for
  // every tier except `standard`.
  // ==========================================================================
  {
    const sub = makeSubsystem({ castStrength: 0.45 });

    const withoutOverride = fakeShadowUniforms();
    sub.syncUniforms(withoutOverride, TREE, PLACEMENT, PARAMS);

    const atTheDefault = fakeShadowUniforms();
    atTheDefault.smearTaps = VEG_SHADOW_SMEAR_TAPS;
    sub.syncUniforms(atTheDefault, TREE, PLACEMENT, PARAMS);

    ok(
      'an explicit smearTaps equal to the constant reproduces the no-override result exactly',
      atTheDefault.uShadowSmearLod.value === withoutOverride.uShadowSmearLod.value
    );

    const coarser = fakeShadowUniforms();
    coarser.smearTaps = 3; // performance tier's cheap 3-station smear
    sub.syncUniforms(coarser, TREE, PLACEMENT, PARAMS);
    ok(
      'FEWER stations widen the gap between them, so the LOD reads coarser (higher)',
      coarser.uShadowSmearLod.value > withoutOverride.uShadowSmearLod.value
    );

    const finer = fakeShadowUniforms();
    finer.smearTaps = 12; // extreme tier's finest smear
    sub.syncUniforms(finer, TREE, PLACEMENT, PARAMS);
    ok(
      'MORE stations narrow the gap between them, so the LOD reads finer (lower)',
      finer.uShadowSmearLod.value < withoutOverride.uShadowSmearLod.value
    );

    // The exact formula this is standing in for (module header's own doc):
    // gapTexels = (throw / stationCount) * artTexelsPerWorldPx; LOD = log2(gap),
    // clamped to [0, 5]. Pinned once, numerically, so a future refactor of the
    // clamp/log cannot silently change this without a red test.
    const expectedLod = Math.max(0, Math.min(5, Math.log2((47 / 3) * 1)));
    ok('the coarse-tier LOD matches the documented formula exactly', coarser.uShadowSmearLod.value === expectedLod);
  }
}
