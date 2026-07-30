/**
 * effect-tier.test.mjs — THE PERFORMANCE-PROFILE LADDER.
 *
 * `resolveEffectTier` answers "how MUCH of this effect", the half of the
 * performance profile that fourteen manifests declared and NOTHING read until
 * 2026-07-29 (effect-cascade.js#resolveEffectTier's own header for the rot that
 * caused). Pinned here are the three rules it takes from Effects.md rather than
 * invents — tier 0 unconditional, rungs cumulative, explicit settings win — the
 * manifest validator's new checks, and the shipped ladders themselves.
 *
 * The last blocks are the ones that matter most: anti-drift cross-checks tying
 * a fallback constant (the candle's, the vegetation's, the water's) to what
 * the DEFAULT profile actually resolves, so this system cannot silently
 * restyle every existing scene.
 */
import { validateEffectManifest } from '../effect-manifest.js';
import {
  resolveEffectTier,
  resolveEffectEnabled,
  PERFORMANCE_PROFILES,
  DEFAULT_PERFORMANCE_PROFILE,
} from '../effect-cascade.js';
import { candleTierPlan, CANDLE_DEFAULT_TIER } from '../candle-flame-geometry.js';
import { vegetationTierPlan, VEGETATION_DEFAULT_TIER } from '../vegetation-render.js';
import {
  sunShadowTierPlan,
  sunShadowBakeSamples,
  SUN_SHADOW_DEFAULT_TIER,
  SUN_SHADOW_MAX_TIER,
  DEFAULT_LATERAL_TAPS,
} from '../lighting/sun-occlusion.js';
import { UI_WINDOW_SHADOW } from '../ui-window-shadow.js';
import { CANDLE_FLAME } from '../candle-flame.js';
import { SPECULAR } from '../specular/specular.js';
import { WATER } from '../water/water.js';
import { WATER_DEFAULT_TIER } from '../water/water-render.js';
import { FLUID } from '../fluid/fluid.js';
import { BLOOM } from '../bloom.js';
import { VEGETATION } from '../vegetation.js';
import { SUN_SHADOWS } from '../sun-shadows.js';
import { GRADE } from '../grade/grade.js';
import { WINDOW } from '../window/window.js';

/** A 5-rung ladder spread across the profile axis. Rung 0 carries NO
 * `fromProfile` — it is unconditional, and declaring one is a validation error. */
const LADDER = {
  ...UI_WINDOW_SHADOW,
  tiers: [
    { n: 0, cost: { class: 'C0' }, adds: 'floor' },
    { n: 1, fromProfile: 'low', cost: { class: 'C1' }, adds: 'a' },
    { n: 2, fromProfile: 'performance', cost: { class: 'C2' }, adds: 'b' },
    { n: 3, fromProfile: 'standard', cost: { class: 'C2' }, adds: 'c' },
    { n: 4, fromProfile: 'extreme', cost: { class: 'C8' }, adds: 'd' },
  ],
};

export function run(t) {
  const { ok } = t;
  const at = (profile) => resolveEffectTier(LADDER, { profile }).tier;

  // --- the ladder responds to the profile, monotonically -------------------
  ok('low buys rung 1', at('low') === 1);
  ok('performance buys rung 2', at('performance') === 2);
  ok('standard buys rung 3', at('standard') === 3);
  ok('quality holds at rung 3 (nothing declares itself for quality)', at('quality') === 3);
  ok('extreme buys the top rung', at('extreme') === 4);
  ok(
    'the resolved rung never goes DOWN as the profile goes up',
    PERFORMANCE_PROFILES.every((p, i) => i === 0 || at(p) >= at(PERFORMANCE_PROFILES[i - 1]))
  );

  // --- rule 1: tier 0 is unconditional (Effects.md §6 step 2 / Law 1) ------
  const EXPENSIVE = {
    ...UI_WINDOW_SHADOW,
    tiers: [
      { n: 0, cost: { class: 'C0' }, adds: 'floor' },
      { n: 1, fromProfile: 'extreme', cost: { class: 'C8' }, adds: 'pricey' },
    ],
  };
  ok(
    'the weakest profile still gets tier 0 — the floor is never gated away',
    resolveEffectTier(EXPENSIVE, { profile: 'low' }).tier === 0
  );
  ok(
    'and `source` says it came from the floor, not from a purchase',
    resolveEffectTier(EXPENSIVE, { profile: 'low' }).source === 'floor'
  );
  ok(
    'a tier-0-only ladder resolves to 0 even at the TOP profile (nothing to spend on)',
    resolveEffectTier(
      { ...UI_WINDOW_SHADOW, tiers: [{ n: 0, cost: { class: 'C0' }, adds: 'x' }] },
      { profile: 'extreme' }
    ).tier === 0
  );

  // --- rule 2: CONTIGUITY — rungs are cumulative, never a menu -------------
  // A mis-declared ladder where rung 2 is affordable but rung 1 is not. Rung 2
  // must NOT be selected: Effects.md §2 forbids a rung depending on one above
  // it, so "2 without 1" is a state no builder was written to render. The
  // resolver degrades to a rung that EXISTS instead of compiling a combination
  // nobody has ever drawn.
  const DIPPED = {
    ...UI_WINDOW_SHADOW,
    tiers: [
      { n: 0, cost: { class: 'C0' }, adds: 'floor' },
      { n: 1, fromProfile: 'extreme', cost: { class: 'C1' }, adds: 'gap' },
      { n: 2, fromProfile: 'low', cost: { class: 'C2' }, adds: 'stranded' },
    ],
  };
  ok(
    'an unaffordable rung STOPS the climb — a higher affordable rung is not skipped to',
    resolveEffectTier(DIPPED, { profile: 'standard' }).tier === 0
  );
  ok(
    'and the validator rejects that ladder rather than leaving it to the resolver',
    !validateEffectManifest(DIPPED).ok
  );

  // --- rule 3: an explicit setting beats the profile, and is clamped -------
  ok(
    'an override beats the profile (Effects.md Law 5)',
    resolveEffectTier(LADDER, { profile: 'low', tierOverride: 4 }).tier === 4
  );
  ok(
    'an override is LABELLED, not passed off as the profile',
    resolveEffectTier(LADDER, { profile: 'low', tierOverride: 4 }).source === 'override'
  );
  ok(
    'an override above the ladder clamps to the top rung, never off the end',
    resolveEffectTier(LADDER, { profile: 'low', tierOverride: 99 }).tier === 4
  );
  ok(
    'a negative override clamps to the floor',
    resolveEffectTier(LADDER, { profile: 'extreme', tierOverride: -3 }).tier === 0
  );
  ok(
    'override 0 is honoured — 0 is a real pin, not "absent"',
    resolveEffectTier(LADDER, { profile: 'extreme', tierOverride: 0 }).tier === 0
  );
  ok(
    'a non-numeric override is ignored, falling back to the profile',
    resolveEffectTier(LADDER, { profile: 'extreme', tierOverride: 'yes' }).tier === 4
  );

  // --- total: a malformed ladder degrades, never throws into a frame -------
  ok('no tiers at all → tier 0, no throw', resolveEffectTier({}, { profile: 'extreme' }).tier === 0);
  ok('a null manifest → tier 0, no throw', resolveEffectTier(null).tier === 0);
  ok(
    'an unknown profile falls back to the default, not to nothing',
    resolveEffectTier(LADDER, { profile: 'ludicrous' }).tier === at(DEFAULT_PERFORMANCE_PROFILE)
  );
  ok(
    'maxTier reports the ladder height so a UI can say "3 of 4"',
    resolveEffectTier(LADDER, { profile: 'low' }).maxTier === 4
  );

  // An UNDECLARED rung must not be FREE — the weakest machine must never be
  // handed an undeclared rung by accident. Belt to the validator's braces.
  const UNDECLARED = {
    ...UI_WINDOW_SHADOW,
    tiers: [
      { n: 0, cost: { class: 'C0' }, adds: 'floor' },
      { n: 1, cost: { class: 'C8' }, adds: 'forgot to declare' },
    ],
  };
  ok(
    'a rung with no fromProfile is treated as extreme-only, NOT as free',
    resolveEffectTier(UNDECLARED, { profile: 'quality' }).tier === 0
  );
  ok('…and the validator rejects it outright, so it never ships', !validateEffectManifest(UNDECLARED).ok);

  // --- the validator's own new rules ---------------------------------------
  ok(
    'declaring fromProfile on tier 0 is rejected — the resolver ignores it, so it is an unkept promise',
    !validateEffectManifest({
      ...UI_WINDOW_SHADOW,
      tiers: [{ n: 0, fromProfile: 'low', cost: { class: 'C0' }, adds: 'floor' }],
    }).ok
  );
  ok(
    'an unrecognised fromProfile is rejected',
    !validateEffectManifest({
      ...UI_WINDOW_SHADOW,
      tiers: [
        { n: 0, cost: { class: 'C0' }, adds: 'floor' },
        { n: 1, fromProfile: 'ludicrous', cost: { class: 'C1' }, adds: 'a' },
      ],
    }).ok
  );
  ok('a well-formed ladder passes', validateEffectManifest(LADDER).ok);

  // --- the REAL shipped manifests, not just fixtures ------------------------
  for (const m of [CANDLE_FLAME, WATER, SPECULAR, FLUID, BLOOM, VEGETATION, SUN_SHADOWS, GRADE, WINDOW]) {
    ok(`the shipped '${m.id}' manifest declares a well-formed ladder`, validateEffectManifest(m).ok === true);
  }
  ok(
    'every shipped effect still resolves on the weakest profile (nothing is gated to nothing)',
    [CANDLE_FLAME, WATER, SPECULAR, FLUID, BLOOM].every((m) => resolveEffectTier(m, { profile: 'low' }).tier >= 0)
  );
  ok(
    'the candle ladder actually MOVES across the profile axis — the entire point',
    resolveEffectTier(CANDLE_FLAME, { profile: 'low' }).tier <
      resolveEffectTier(CANDLE_FLAME, { profile: 'extreme' }).tier
  );

  // === 🔒 THE ANTI-DRIFT CROSS-CHECK ======================================
  // `CANDLE_DEFAULT_TIER` exists so an unwired caller sees TODAY'S look rather
  // than the cheapest one. That is only honest while it equals what the DEFAULT
  // profile actually resolves to — retune a rung's `fromProfile` without this
  // test and the constant silently starts pointing at a different look than the
  // ladder does, which is two authorities on one number
  // (feedback_shared_field_two_meanings_two_registries wearing a new hat).
  ok(
    'the candle fallback tier IS what the default profile resolves to — no second authority',
    resolveEffectTier(CANDLE_FLAME, { profile: DEFAULT_PERFORMANCE_PROFILE }).tier === CANDLE_DEFAULT_TIER
  );
  const shipped = candleTierPlan(CANDLE_DEFAULT_TIER);
  ok(
    'the default rung reproduces the SHIPPED look exactly (flame 2 / lavish light / cluster 0.5)',
    shipped.flameQuality === 2 && shipped.lightQuality === 2 && shipped.clusterFactor === 0.5
  );
  ok(
    'an absent tier falls back to that same rung, so an unwired caller sees no change',
    candleTierPlan(undefined).clusterFactor === shipped.clusterFactor
  );
  ok(
    'a LOWER profile genuinely merges candle lights harder — the measured 13ms lever',
    candleTierPlan(resolveEffectTier(CANDLE_FLAME, { profile: 'low' }).tier).clusterFactor > shipped.clusterFactor
  );
  ok(
    'and the top profile splits them finer than today',
    candleTierPlan(resolveEffectTier(CANDLE_FLAME, { profile: 'extreme' }).tier).clusterFactor < shipped.clusterFactor
  );
  ok(
    'cluster factor is monotonic down the ladder — a better machine never merges MORE',
    [0, 1, 2, 3, 4].every((n) => n === 0 || candleTierPlan(n).clusterFactor <= candleTierPlan(n - 1).clusterFactor)
  );
  ok(
    'flame and light quality are monotonic too — a better machine never gets a plainer look',
    [0, 1, 2, 3, 4].every(
      (n) =>
        n === 0 ||
        (candleTierPlan(n).flameQuality >= candleTierPlan(n - 1).flameQuality &&
          candleTierPlan(n).lightQuality >= candleTierPlan(n - 1).lightQuality)
    )
  );
  ok(
    'a wildly out-of-range tier clamps into the ladder rather than returning undefined',
    candleTierPlan(999).clusterFactor === candleTierPlan(4).clusterFactor
  );

  // === 🔒 THE VEGETATION ANTI-DRIFT CROSS-CHECK ===========================
  // Same shape as the candle cross-check above, for the ladder built
  // 2026-07-29 so the leaf-flutter shimmer and the ground shadow's smear
  // quality both follow the performance profile instead of running
  // full-strength on every machine regardless of setting.
  ok('low buys flutter only — the coarsest real rung', resolveEffectTier(VEGETATION, { profile: 'low' }).tier === 1);
  ok(
    'performance additionally buys the ground shadow, at reduced quality',
    resolveEffectTier(VEGETATION, { profile: 'performance' }).tier === 2
  );
  ok(
    'the vegetation fallback tier IS what the default profile resolves to — no second authority',
    resolveEffectTier(VEGETATION, { profile: DEFAULT_PERFORMANCE_PROFILE }).tier === VEGETATION_DEFAULT_TIER
  );
  const vegShipped = vegetationTierPlan(VEGETATION_DEFAULT_TIER);
  ok(
    'the default rung reproduces the SHIPPED look exactly (flutter on, shadow on, the original 6-station smear)',
    vegShipped.flutterEnabled === true && vegShipped.shadowEnabled === true && vegShipped.shadowSmearTaps === 6
  );
  ok(
    'an absent tier falls back to that same rung, so an unwired caller sees no change',
    vegetationTierPlan(undefined).shadowSmearTaps === vegShipped.shadowSmearTaps
  );
  ok(
    'the floor tier (0) has neither flutter nor a shadow — the coarse pin, never a static decal but never ' +
      "either of the effect's two expensive parts",
    vegetationTierPlan(0).flutterEnabled === false && vegetationTierPlan(0).shadowEnabled === false
  );
  ok(
    'quality genuinely resolves ABOVE what standard ships — a finer shadow smear than today',
    vegetationTierPlan(resolveEffectTier(VEGETATION, { profile: 'quality' }).tier).shadowSmearTaps >
      vegShipped.shadowSmearTaps
  );
  ok(
    'extreme is the reserved top rung — the finest smear this effect draws, and where the next ' +
      'extreme-only addition plugs in',
    resolveEffectTier(VEGETATION, { profile: 'extreme' }).tier === 5 &&
      vegetationTierPlan(5).shadowSmearTaps > vegetationTierPlan(4).shadowSmearTaps
  );
  ok(
    'shadow smear taps are monotonic down the ladder — a better machine never gets a coarser shadow',
    [0, 1, 2, 3, 4, 5].every(
      (n) => n === 0 || vegetationTierPlan(n).shadowSmearTaps >= vegetationTierPlan(n - 1).shadowSmearTaps
    )
  );
  ok(
    'flutter, once bought at low, is never taken away by a HIGHER tier (Effects.md Law 2 — monotonic)',
    [1, 2, 3, 4, 5].every((n) => vegetationTierPlan(n).flutterEnabled === true)
  );
  ok(
    'a wildly out-of-range tier clamps into the ladder rather than returning undefined',
    vegetationTierPlan(999).shadowSmearTaps === vegetationTierPlan(5).shadowSmearTaps
  );
  ok(
    'a negative tier clamps to the floor',
    vegetationTierPlan(-3).flutterEnabled === false && vegetationTierPlan(-3).shadowEnabled === false
  );

  // === 🔒 THE WATER ANTI-DRIFT CROSS-CHECK ================================
  // Same reasoning as the candle/vegetation blocks above. Water has no
  // separate `xTierPlan` pure function — the tier gate lives directly in the
  // TSL builder (`water-render.js#buildWaterSurfaceMaterial`'s `if (activeTier
  // >= N)` blocks), which is browser-only and verified live per this
  // project's own testing convention (`water.test.mjs`'s header) — so what
  // CAN be pinned here is the resolver-side contract: which profile buys
  // which rung, and that the fallback constant tracks it.
  ok(
    'the water fallback tier IS what the default profile resolves to — no second authority',
    resolveEffectTier(WATER, { profile: DEFAULT_PERFORMANCE_PROFILE }).tier === WATER_DEFAULT_TIER
  );
  ok(
    'low buys tier 1 (volume) — the first real rung above the coarse pin',
    resolveEffectTier(WATER, { profile: 'low' }).tier === 1
  );
  ok('performance additionally buys tier 2 (motion)', resolveEffectTier(WATER, { profile: 'performance' }).tier === 2);
  ok(
    "water's ladder tops out at tier 3 (standard) today — quality and extreme buy nothing more YET, which " +
      "is exactly where Water.md's deferred rungs 4-8 (shore/refraction/reflection/sim/spray) land once built",
    resolveEffectTier(WATER, { profile: 'quality' }).tier === WATER_DEFAULT_TIER &&
      resolveEffectTier(WATER, { profile: 'extreme' }).tier === WATER_DEFAULT_TIER
  );
  ok(
    'a low-profile machine genuinely gets a CHEAPER water than the default (fewer rungs bought)',
    resolveEffectTier(WATER, { profile: 'low' }).tier < WATER_DEFAULT_TIER
  );

  // === 🔒 THE SUN-SHADOW ANTI-DRIFT CROSS-CHECK ===========================
  // Building + overhead + sky-reach, built 2026-07-29 (author: "get every
  // performance tier to line up with these shadow effects… the lowest should
  // turn shadows off and remove the performance cost… extreme should increase
  // resolutions and make it look nicer").
  //
  // ⚠️ TWO SEPARATE MECHANISMS, ASSERTED SEPARATELY, because conflating them
  // is the whole trap. `enabledFromProfile` answers WHETHER (and is what turns
  // `low` off); the tier ladder answers HOW MUCH (and never resolves to
  // "nothing", so a player who forces the effect on below `performance` gets
  // the coarse march rather than a switch that does nothing).
  const sunEnabledAt = (profile) =>
    resolveEffectEnabled(SUN_SHADOWS, { profile, gmEnable: 'auto', playerEnable: 'auto' });
  ok('THE LOW PROFILE TURNS SUN SHADOWS OFF ENTIRELY — the author`s first ask', sunEnabledAt('low') === false);
  ok(
    '...and every profile above it leaves them on',
    ['performance', 'standard', 'quality', 'extreme'].every((p) => sunEnabledAt(p) === true)
  );
  ok(
    'a player can still force them ON at `low` — the profile is a default, never a lock',
    resolveEffectEnabled(SUN_SHADOWS, { profile: 'low', playerEnable: 'on' }) === true
  );
  ok(
    '...and what that player gets is a REAL shadow (the coarse pin), not an on-switch that draws nothing',
    sunShadowTierPlan(resolveEffectTier(SUN_SHADOWS, { profile: 'low' }).tier).marchSteps > 0
  );

  // The ladder itself: one rung per profile from `performance` up.
  ok('performance buys the coarse pin (tier 0)', resolveEffectTier(SUN_SHADOWS, { profile: 'performance' }).tier === 0);
  ok('standard buys tier 1', resolveEffectTier(SUN_SHADOWS, { profile: 'standard' }).tier === 1);
  ok('quality buys tier 2', resolveEffectTier(SUN_SHADOWS, { profile: 'quality' }).tier === 2);
  ok('extreme buys the top rung', resolveEffectTier(SUN_SHADOWS, { profile: 'extreme' }).tier === 3);
  ok(
    'the ladder`s height matches the plan table — one prose rung per arithmetic rung, no orphan on either side',
    resolveEffectTier(SUN_SHADOWS, { profile: 'extreme' }).maxTier === SUN_SHADOW_MAX_TIER
  );
  ok(
    'the sun-shadow fallback tier IS what the default profile resolves to — no second authority',
    resolveEffectTier(SUN_SHADOWS, { profile: DEFAULT_PERFORMANCE_PROFILE }).tier === SUN_SHADOW_DEFAULT_TIER
  );

  // 🔒 THE "DO NOT RESTYLE EVERY EXISTING SCENE" PIN. These four numbers ARE
  // the shipped 2026-07-28 look; the ladder was built around them, not over
  // them. If a rung is ever retuned and this block goes red, the fix is to
  // move the rung back — not to update the numbers here.
  const sunShipped = sunShadowTierPlan(SUN_SHADOW_DEFAULT_TIER);
  ok(
    'the default rung reproduces TODAY exactly — 1024² field, 24 march steps, a 3-tap cone, re-marched every 0.5°',
    sunShipped.fieldDim === 1024 &&
      sunShipped.marchSteps === 24 &&
      sunShipped.lateralTaps === 3 &&
      sunShipped.quantizeDeg === 0.5
  );
  ok(
    'the default rung`s SILHOUETTE resolution is the shared 512 grid too — casterGridDim is a SEPARATE axis ' +
      'from fieldDim (2026-07-30), and standard must not raise it past what every other consumer already budgets for',
    sunShipped.casterGridDim === 512
  );
  ok(
    'and the cone`s shipped width is the shader builder`s OWN default, so an unwired build matches the ladder',
    sunShipped.lateralTaps === DEFAULT_LATERAL_TAPS
  );
  ok(
    'an absent tier falls back to that same rung, so an unwired caller sees no change',
    sunShadowTierPlan(undefined).fieldDim === sunShipped.fieldDim &&
      sunShadowTierPlan(undefined).marchSteps === sunShipped.marchSteps
  );

  // MONOTONICITY on all four axes — a better machine never gets a coarser
  // field, a shorter march, a narrower cone, or a poppier sun.
  const sunRungs = [0, 1, 2, 3].map(sunShadowTierPlan);
  ok(
    'field resolution never DROPS as the ladder climbs',
    sunRungs.every((p, i) => i === 0 || p.fieldDim >= sunRungs[i - 1].fieldDim)
  );
  ok(
    'the CASTER SILHOUETTE resolution never drops either, and strictly climbs past standard — the ' +
      'author`s "extreme should increase resolutions" ask, on the axis that actually sharpens a silhouette ' +
      '(fieldDim alone never could — see casterGridDim`s own doc in sun-occlusion.js)',
    sunRungs.every((p, i) => i === 0 || p.casterGridDim >= sunRungs[i - 1].casterGridDim) &&
      sunRungs[2].casterGridDim > sunRungs[1].casterGridDim &&
      sunRungs[3].casterGridDim > sunRungs[2].casterGridDim
  );
  ok(
    'march steps strictly increase — every rung buys a finer march, none is a re-label',
    sunRungs.every((p, i) => i === 0 || p.marchSteps > sunRungs[i - 1].marchSteps)
  );
  ok(
    'the cone strictly widens — the axis the author actually notices (pixel-perfect silhouette edges)',
    sunRungs.every((p, i) => i === 0 || p.lateralTaps > sunRungs[i - 1].lateralTaps)
  );
  ok(
    'the sun-motion threshold never gets COARSER — a better machine never gets poppier shadows',
    sunRungs.every((p, i) => i === 0 || p.quantizeDeg <= sunRungs[i - 1].quantizeDeg)
  );
  ok(
    'every rung marches an ODD number of lateral taps, so the cone keeps a CENTRE ray — an even count ' +
      'would sample only off-axis and shift the whole shadow sideways',
    sunRungs.every((p) => p.lateralTaps % 2 === 1)
  );

  // THE COST GRADIENT, in the only unit this system honestly has (bake texture
  // samples — the bakes have never fired inside a profiling window, so there is
  // no measured ms for any rung and inventing one would be an instrument that
  // lies).
  const sunSamples = sunRungs.map(sunShadowBakeSamples);
  const shippedSamples = sunShadowBakeSamples(sunShipped);
  ok(
    'bake cost is strictly monotonic up the ladder',
    sunSamples.every((s, i) => i === 0 || s > sunSamples[i - 1])
  );
  ok(
    'the coarse pin is DRAMATICALLY cheaper than today — a real saving, not a token one (>10× less)',
    sunSamples[0] * 10 < shippedSamples
  );
  ok(
    'quality costs more than standard but stays inside 3× — a bake is a HITCH, not a frame cost',
    sunSamples[2] > shippedSamples && sunSamples[2] < shippedSamples * 3
  );
  ok(
    'extreme is the dearest rung and still bounded at 5× the shipped bake — the ceiling is what a player ' +
      'will tolerate as a stutter a few times a minute, not what a GPU can survive',
    sunSamples[3] > sunSamples[2] && sunSamples[3] <= shippedSamples * 5
  );
  ok(
    'no rung asks for a field above the Keyhole 2048 world-res cap (three-allocator.js would throw at ' +
      'allocation time, mid-frame, on the profile change that bought it)',
    sunRungs.every((p) => p.fieldDim <= 2048)
  );
  ok(
    'the caster grid stays under the SAME 2048 cap too — it is a second, independent allocation ' +
      '(mask-derive.js#deriveFloorProducts`s casterGridSpec), not exempt from the ceiling that governs everything else',
    sunRungs.every((p) => p.casterGridDim <= 2048)
  );

  // TOTALITY — same posture as every other plan in this file.
  ok(
    'a wildly out-of-range tier clamps into the ladder rather than returning undefined',
    sunShadowTierPlan(999).fieldDim === sunRungs[3].fieldDim &&
      sunShadowTierPlan(999).casterGridDim === sunRungs[3].casterGridDim
  );
  ok(
    'a negative tier clamps to the coarse pin',
    sunShadowTierPlan(-3).fieldDim === sunRungs[0].fieldDim &&
      sunShadowTierPlan(-3).casterGridDim === sunRungs[0].casterGridDim
  );
  ok(
    'a malformed plan costs zero samples rather than NaN — a status report must never print NaN',
    sunShadowBakeSamples(null) === 0 && sunShadowBakeSamples({ fieldDim: 8 }) === 0
  );
}
