/**
 * THE PERFTIER ROUND-TRIP GUARD — any effect with more than one tier must
 * carry its resolved `perfTier` from the cascade resolver through to
 * `getRenderState()`, or a live profile change silently never reaches the
 * render seam.
 *
 * This is the exact bug specular, window, fluid, bloom AND depth-of-field
 * all shipped with, unnoticed (see docs/planning/Effect-Tier-Gradient-
 * Audit-2026-08-29.md, actions #1/#3/#7, round 2): `resolved.perfTier` was
 * computed by the cascade, even stored onto the registration's internal
 * `readout`, but `getRenderState()` never spread it back out — so the
 * surface subsystem always rebuilt at the effect's own DEFAULT_TIER
 * regardless of what profile the player had actually selected.
 *
 * `maxPerfTier`/`perfTierSource` are DELIBERATELY NOT asserted here even
 * though every readout below carries them too: every FOH/ROH card (boot.js,
 * e.g. `getReadout: () => specular.getReadout()`) reads those two off
 * `getReadout()`, not `getRenderState()` — confirmed across water/specular/
 * fluid and every inline effect in boot.js. Only `perfTier` is a
 * `getRenderState()` contract; the other two belong to the UI-badge
 * accessor and asserting them here would be testing a shape this seam was
 * never meant to have.
 *
 * TWO INDEPENDENT SHAPES OF COVERAGE, because two different code shapes
 * carry this same risk:
 *
 * 1. THE DEDICATED-FACTORY EFFECTS (water/specular/window/fluid) — this test
 *    exercises the REAL registration factories against a stub
 *    `effectRegistry`, not a hand-written fixture of what a readout SHOULD
 *    contain — the original bug survived for weeks specifically because
 *    nothing ever invoked the actual `apply` callback each factory hands to
 *    `register()`.
 * 2. THE INLINE EFFECTS (bloom/depth-of-field/sun-shadows/candle/lightning/
 *    fire/vegetation/precipitation) — these register inside `boot.js`'s
 *    `install()` closure, which needs a live Foundry `game` global this
 *    project's Node harness never constructs, so there is no factory to
 *    import here the way REGISTRATIONS below has one. `boot.js` itself now
 *    builds each of these 8 effects' `xReadout`/`getXRenderState()` by
 *    DELEGATING to `effect-readout.js`'s two pure functions
 *    (`buildCascadeReadout`/`projectCascadeRenderState`) instead of hand-
 *    typing the same object literal 8 times — this section tests THOSE
 *    functions directly. This is a narrower guarantee than section 1's (it
 *    proves the shared projection is correct, not that any specific inline
 *    effect's `getXRenderState` still calls it — that delegation is one
 *    conspicuous line, not a silently-droppable object-literal field, so
 *    manual review is enough for the residual risk) — see effect-readout.js
 *    own header for the full reasoning.
 *
 * FLUID WAS EXCLUDED from section 1 until 2026-08-30 (`fluid-registration.js
 * #getRenderState()` did not return `perfTier`, and the ladder itself was
 * blocked on a design decision — see docs/planning/Effect-Tier-Gradient-
 * Audit-2026-08-29.md, ranked action #7's full account, and Ingram's own
 * resolving instruction quoted there: "fluid should be visible in some way
 * at the lowest setting but we need minimal cost to do that"). Both the
 * design blocker and the transit-loss bug are now fixed the same way
 * specular/window's were — fluid is back in REGISTRATIONS below like every
 * other tiered effect with a dedicated registration file.
 */
import { createSpecularRegistration } from '../specular/specular-registration.js';
import { SPECULAR } from '../specular/specular.js';
import { createWindowRegistration } from '../window/window-registration.js';
import { WINDOW } from '../window/window.js';
import { createWaterRegistration } from '../water/water-registration.js';
import { WATER } from '../water/water.js';
import { createFluidRegistration } from '../fluid/fluid-registration.js';
import { FLUID } from '../fluid/fluid.js';
import { buildCascadeReadout, projectCascadeRenderState } from '../effect-readout.js';

const REGISTRATIONS = [
  { name: 'specular', manifest: SPECULAR, create: createSpecularRegistration },
  { name: 'window', manifest: WINDOW, create: createWindowRegistration },
  { name: 'water', manifest: WATER, create: createWaterRegistration },
  { name: 'fluid', manifest: FLUID, create: createFluidRegistration },
];

/** The 8 inline effects `effect-readout.js`'s pure functions now cover — see
 * this file's own header, section 2. Listed here (not just implied) so a
 * future reader can cross-check it against `boot.js`'s own `EFFECT_REAPPLIERS`
 * without re-deriving which effects register inline. */
const INLINE_EFFECTS_COVERED = Object.freeze([
  'bloom',
  'depthOfField',
  'sunShadows',
  'candleFlame',
  'lightning',
  'fire',
  'vegetation',
  'precipitation',
]);

function stubDeps() {
  return {
    deriveEffectLayers: () => ({}),
    readSetting: () => undefined,
    writeSetting: () => Promise.resolve(),
    moduleId: 'test-module',
    effectEnableKey: () => 'test-key',
    log: { error() {} },
  };
}

export function run(t) {
  for (const { name, manifest, create } of REGISTRATIONS) {
    // A manifest with only tier 0 has nothing to lose in transit — not this
    // guard's concern (this is why aperture-gobo, the other dedicated
    // registration file, never needs to appear in REGISTRATIONS at all).
    if (!Array.isArray(manifest.tiers) || manifest.tiers.length <= 1) continue;

    let capturedApply = null;
    const stubRegistry = {
      register(_manifest, apply) {
        capturedApply = apply;
      },
      resolveAndApply() {},
    };

    const registration = create({ effectRegistry: stubRegistry, ...stubDeps() });

    t.ok(
      `${name}: registration calls effectRegistry.register() with an apply callback`,
      typeof capturedApply === 'function'
    );
    if (typeof capturedApply !== 'function') continue;

    // A distinctive, unmistakable value — the highest rung the manifest
    // declares — so a bug that returns undefined, 0, or some OTHER field's
    // value cannot accidentally pass.
    const sentinelTier = manifest.tiers.length - 1;
    capturedApply({
      enabled: true,
      params: {},
      perfTier: sentinelTier,
      maxPerfTier: sentinelTier,
      perfTierSource: 'profile',
    });

    const state = registration.getRenderState();
    t.ok(
      `${name}: getRenderState().perfTier survives the round trip from the resolved tier — the exact bug specular and window both had before 2026-08-29`,
      state.perfTier === sentinelTier
    );
  }

  // === SECTION 2 — THE INLINE EFFECTS' SHARED PROJECTION ===================
  // See this file's own header for why these two pure functions, not a
  // factory, are the right unit here. `${INLINE_EFFECTS_COVERED.length}`
  // effects share this exact code path in boot.js today; testing the shared
  // function once covers all of them at once — the same reasoning
  // `feedback_no_size_ratchet`-adjacent: one tested seam beats 8 untested
  // copies of the identical shape.
  t.ok(
    `${INLINE_EFFECTS_COVERED.length} inline effects are declared as covered by this section`,
    INLINE_EFFECTS_COVERED.length === 8
  );

  {
    // A distinctive, unmistakable sentinel per field — chosen so a bug that
    // swaps two fields, or returns some OTHER value entirely, cannot
    // accidentally pass by coincidence.
    const resolved = { enabled: true, params: { look: 'x' }, perfTier: 4, maxPerfTier: 5, perfTierSource: 'profile' };
    const readout = buildCascadeReadout(resolved);

    t.ok('buildCascadeReadout carries enabled through', readout.enabled === true);
    t.ok(
      'buildCascadeReadout carries params through (same reference, never cloned)',
      readout.params === resolved.params
    );
    t.ok(
      'buildCascadeReadout carries perfTier through — the exact field bloom/DoF/specular/window/fluid all silently dropped before 2026-08-29/30',
      readout.perfTier === 4
    );
    t.ok('buildCascadeReadout carries maxPerfTier through (the UI badge`s own need)', readout.maxPerfTier === 5);
    t.ok('buildCascadeReadout carries perfTierSource through', readout.perfTierSource === 'profile');

    const state = projectCascadeRenderState(readout);
    t.ok(
      'projectCascadeRenderState carries perfTier all the way to the render seam`s own shape — the FULL round trip, resolved → readout → getRenderState()',
      state.perfTier === 4
    );
    t.ok('…and enabled', state.enabled === true);
    t.ok('…and params', state.params === resolved.params);
    t.ok(
      'projectCascadeRenderState does NOT carry maxPerfTier/perfTierSource — that would be testing a shape getRenderState() was never meant to have',
      !('maxPerfTier' in state) && !('perfTierSource' in state)
    );
  }

  // A missing perfTier (a 1-tier effect, or a pre-resolve readout) must
  // project to `undefined`, never throw and never silently coerce to 0 —
  // 0 is a REAL, valid tier (the floor), and a caller that cannot tell
  // "unresolved" from "resolved to the floor" would misreport an unwired
  // seam as a working one at its cheapest setting.
  t.ok(
    'an absent perfTier projects to undefined, never 0 or a throw',
    projectCascadeRenderState(buildCascadeReadout({ enabled: true, params: {} })).perfTier === undefined
  );

  t.ok(
    'params defaults to {} when the readout itself never resolved (pre-resolve seed shape)',
    (() => {
      const s = projectCascadeRenderState({ enabled: true, params: null });
      return s.params && typeof s.params === 'object' && Object.keys(s.params).length === 0;
    })()
  );
}
