/**
 * specular.test.mjs — the specular declaration is a valid, registrable effect.
 *
 * Registration MACHINERY is proven in effect-registration.test.mjs; this pins
 * specular's own shape, that it flows through the one door, and the two claims
 * its header makes that are checkable as data: that the ladder is complete
 * (built + deferred = the whole design, nothing claimed twice, nothing dropped)
 * and that every rung named in `docs/planning/Specular.md` §6 is accounted for.
 */
import { validateParamsSchema } from '../../../core/params-schema.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { createEffectRegistry } from '../../registry.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import {
  SPECULAR,
  SPECULAR_PARAMS,
  SPECULAR_LAYER_PARAMS,
  SPECULAR_DEBUG_CHANNELS,
  SPECULAR_DEBUG_BOOST,
} from '../specular.js';
import {
  SPECULAR_DEFAULT_SHIMMER_GAIN,
  SPECULAR_DEFAULT_SATURATION,
  SPECULAR_DEFAULT_STRENGTH,
  SPECULAR_DEFAULT_PATTERN_SCALE_PX,
  SPECULAR_DEFAULT_PARALLAX_STRENGTH,
  SPECULAR_DEFAULT_ISLAND_SPREAD,
  SPECULAR_DEFAULT_DRIFT_SPEED,
  SPECULAR_DEFAULT_PULSE,
  SPECULAR_DEFAULT_SUN_BIAS,
} from '../specular-render.js';
import {
  SPECULAR_SHEEN_CEILING,
  SPECULAR_GLINT_CEILING,
  SPECULAR_INCIDENT_STEEPNESS,
  SPECULAR_INCIDENT_KNEE,
} from '../specular-pattern.js';

export function run(t) {
  const { ok } = t;

  // --- the declaration validates ------------------------------------------
  ok('SPECULAR_PARAMS is a valid params schema', validateParamsSchema(SPECULAR_PARAMS).ok);
  ok('SPECULAR is a valid manifest', validateEffectManifest(SPECULAR).ok);
  ok("the effect's id is specular", SPECULAR.id === 'specular');
  ok(
    'the shipped rungs do not flash (a11y photosensitive false) — slow drift and camera parallax only',
    SPECULAR.a11y.photosensitive === false
  );

  // --- default ON: inert without a mask, so it cannot surprise a scene ----
  ok('gated to low → on even at Low', SPECULAR.enabledFromProfile === 'low');
  ok('resolves ON at Low by default', resolveEffectEnabled(SPECULAR, { profile: 'low' }) === true);
  ok('resolves ON at Standard by default', resolveEffectEnabled(SPECULAR, { profile: 'standard' }) === true);
  ok(
    'a player can still turn it OFF (final say)',
    resolveEffectEnabled(SPECULAR, { profile: 'low', playerEnable: 'off' }) === false
  );

  // --- the ladder: BUILT rungs in `tiers`, the rest honestly deferred -----
  // Asserted RELATIVE to each other rather than pinned to literals, so a rung
  // actually landing does not force an edit here — what must hold at EVERY
  // phase is that the two lists together describe one whole ladder.
  const built = SPECULAR.tiers.length;
  const deferred = SPECULAR.deferredRungs.length;
  ok('tier 0 exists — the coarse pin (Effects.md Law 1)', SPECULAR.tiers[0]?.n === 0);
  ok('tier 0 is named for what it does, not for a technique', SPECULAR.tiers[0]?.name === 'presence');
  ok('built + deferred describe one whole ladder, nothing dropped', built + deferred === 11);
  const allNames = [...SPECULAR.tiers.map((x) => x.name), ...SPECULAR.deferredRungs.map((x) => x.name)];
  ok('no rung is claimed twice', new Set(allNames).size === allNames.length);
  ok(
    'every deferred rung says what it will add',
    SPECULAR.deferredRungs.every((r) => typeof r.note === 'string')
  );

  // Effects.md Law 3, from tier 1 up — tier 0 is the admission price and is
  // exempt (see effect-manifest.js). The manifest validator proves this
  // generally; this pins the SHAPE the design argues for: the cheap rungs
  // cluster at the bottom and buy most of the look.
  ok('tier 1 is pure ALU (C1) — the shimmer rides tier 0’s fetch', SPECULAR.tiers[1]?.cost.class === 'C1');
  ok('tier 2 is pure ALU too — parallax is an offset, not a fetch', SPECULAR.tiers[2]?.cost.class === 'C1');

  // --- every param is a MATERIAL or WORLD property, per the header --------
  // The V2 corpse this replaces had 30 shimmer sliders, each a property of a
  // noise generator. The count is the claim; assert it stays honest.
  const keys = Object.keys(SPECULAR_PARAMS);
  ok('the whole schema is well under V2’s 61 controls', keys.length + Object.keys(SPECULAR_LAYER_PARAMS).length <= 24);
  ok(
    'every param declares a help string an author can act on',
    keys.every((k) => (SPECULAR_PARAMS[k].help ?? '').length > 40)
  );
  ok(
    'every param declares a category, so the panel groups itself',
    keys.every((k) => typeof SPECULAR_PARAMS[k].category === 'string')
  );
  // The indoor/outdoor split is real and lives in the shader's outdoors gate,
  // but only ONE control is outdoor-specific — because indoors there is simply
  // no sun to be angled against. An "Indoor" category would be an empty group
  // asserting a symmetry that does not exist.
  ok(
    'the outdoor-only control is categorised as such',
    keys.some((k) => SPECULAR_PARAMS[k].category === 'Outdoor')
  );
  ok(
    '…and it is the sun bias, whose help says it does nothing indoors',
    SPECULAR_PARAMS.sunBias.category === 'Outdoor'
  );
  // The escape hatches are real, reachable values rather than prose.
  ok('metal colour can be taken to 0 — a neutral white sheen', SPECULAR_PARAMS.saturation.min === 0);
  ok('…and defaults ON, so a gold mask reads as gold', SPECULAR_PARAMS.saturation.default > 0);
  // ⚠️ ROUND 16 (2026-08-03): the default now sits ABOVE 1, a DELIBERATE
  // oversaturation counteracting the global tonemap's own desaturation —
  // see SPECULAR_DEFAULT_SATURATION's own doc. Pinned against the render
  // module's default the same way shimmerGain already is below, so the two
  // cannot silently drift apart the way `SPECULAR_DEFAULT_SHIMMER_GAIN` vs
  // the OLD schema default once did.
  ok(
    "the schema default sits above 1 — the render module's own oversaturation compensation ships by default",
    SPECULAR_PARAMS.saturation.default > 1
  );
  ok(
    'the schema default and the render module default agree on saturation',
    SPECULAR_PARAMS.saturation.default === SPECULAR_DEFAULT_SATURATION
  );
  ok(
    "the default never exceeds the schema's own declared max — a future max cut must not silently orphan this",
    SPECULAR_DEFAULT_SATURATION <= SPECULAR_PARAMS.saturation.max
  );
  // ⚠️ `islandSpread: 0` is the documented "give me V2 back" setting: every
  // island moves identically, which is exactly what V2 did with its single
  // global pattern frame. It must stay reachable.
  ok('per-object variety can be taken to 0 — V2 parity', SPECULAR_PARAMS.islandSpread.min === 0);
  ok('…and defaults ON, so the new capability is what ships', SPECULAR_PARAMS.islandSpread.default > 0);

  // ── THE LIGHT FLOOR — CORRECTED DOWN TO 0, LIVE FEEDBACK (2026-07-27) ────
  // ⚠️ This used to default ABOVE zero, on the reasoning that a zero floor
  // reproduces the exact "silent precondition" shape that cost this effect
  // four invisible rounds. That reasoning was WRONG: it treated "genuine
  // darkness" and "a broken input" as the same failure, and a floor cannot
  // tell them apart. The live report was metal reading as SELF-ILLUMINATING
  // in dark rooms — "boosting those areas so they become brighter, which
  // isn't physically correct" — which is precisely what a floor on a purely
  // ADDITIVE composite does: it cannot ever compete for darkness, only add
  // light. `buf:scene.illum` already carries point lights and window light
  // (both MAX/ADD-composited into it before this pass runs) and Foundry's own
  // day/night mix outdoors, so real local light already reaches this effect
  // with NO floor at all — the floor was fighting that signal, not protecting it.
  ok('a light floor exists — still an author escape hatch, not gone', !!SPECULAR_PARAMS.lightFloor);
  ok(
    '…but it now defaults to EXACTLY zero, so real darkness reads as real darkness',
    SPECULAR_PARAMS.lightFloor.default === 0
  );
  ok('…raiseable for a stylised "never quite black" look, never required', SPECULAR_PARAMS.lightFloor.max > 0);

  // ⚠️ TWO PLACES STORE THIS SAME NUMBER — the FOH schema default (what a new
  // scene actually ships with) and `specular-render.js`'s own JS default (what
  // a caller gets for free if it never touches this param). Nothing forces
  // them to agree; only a test does. Raised 4→5.5 (2026-07-27) alongside the
  // sheen-ceiling cut — a schema left at the OLD number would silently ship
  // every scene with LESS contrast than the fix intends, green tests and all.
  ok(
    'the schema default and the render module default agree on shimmerGain',
    SPECULAR_PARAMS.shimmerGain.default === SPECULAR_DEFAULT_SHIMMER_GAIN
  );

  // ── ROUND 17 (2026-08-03) — three constants promoted to live params, on
  // direct request for "very high ranges to boost the brightness... lots of
  // controls, I'll fine tune it" after a channel probe suggested the
  // steepening gate (added the previous round) was crushing an ordinarily
  // lit point far more than intended. Same "two places store one number"
  // shape as shimmerGain/saturation above, same reason to pin it.
  ok(
    'sheenCeiling exists, in Response, and agrees with the pattern module default',
    SPECULAR_PARAMS.sheenCeiling.category === 'Response' &&
      SPECULAR_PARAMS.sheenCeiling.default === SPECULAR_SHEEN_CEILING
  );
  ok(
    'glintCeiling exists, in Response, and agrees with the pattern module default',
    SPECULAR_PARAMS.glintCeiling.category === 'Response' &&
      SPECULAR_PARAMS.glintCeiling.default === SPECULAR_GLINT_CEILING
  );
  ok(
    'incidentSteepness exists, in Response, and agrees with the pattern module default',
    SPECULAR_PARAMS.incidentSteepness.category === 'Response' &&
      SPECULAR_PARAMS.incidentSteepness.default === SPECULAR_INCIDENT_STEEPNESS
  );
  ok(
    'incidentKnee exists, in Response, and agrees with the pattern module default',
    SPECULAR_PARAMS.incidentKnee.category === 'Response' &&
      SPECULAR_PARAMS.incidentKnee.default === SPECULAR_INCIDENT_KNEE
  );
  // ⚠️ THE KNEE MUST DEFAULT BELOW 1, AND THAT IS THE WHOLE POINT OF IT.
  // At 1 the curve reaches full shine only where incident luma is 1 — a
  // perfectly white, fully-bright pixel, which nothing in this engine short of
  // direct noon sun produces, so candle- and lamp-lit metal measured
  // algebraically DEAD (bench sweep, 2026-08-09; see SPECULAR_INCIDENT_KNEE's
  // own header for the numbers). A future "tidy-up" that rounds this back to 1
  // would silently restore that bug, so it is pinned rather than left to a
  // comment.
  ok('the knee sits below 1, so real lamps can reach full shine', SPECULAR_PARAMS.incidentKnee.default < 1);
  ok(
    'the knee can still be set to 1 — the documented reproduction of pre-knee behaviour',
    SPECULAR_PARAMS.incidentKnee.max >= 1
  );
  // Headroom the author explicitly asked for — high enough to genuinely
  // "brute-force punch through", not just a token bump.
  ok('shine strength now reaches well past its old ceiling of 3', SPECULAR_PARAMS.strength.max >= 10);
  ok('shimmer contrast now reaches well past its old ceiling of 12', SPECULAR_PARAMS.shimmerGain.max >= 20);
  ok(
    'light response can be pushed below 1 — a deliberate BOOST of dim areas, not just less suppression',
    SPECULAR_PARAMS.incidentSteepness.min < 1
  );
  // `lightFloor` moved category (Look → Response) this round — pin it so a
  // future edit does not silently drift it back without a reason.
  ok(
    'the unlit-shine floor now lives in Response, beside its light-answering siblings',
    SPECULAR_PARAMS.lightFloor.category === 'Response'
  );

  // ── ROUND 18 (2026-08-03) — THE FIRST LIVE-CONFIRMED DEFAULTS. The author
  // dialled every Round 17 control in on a real scene and reported back "we
  // have a basic specular effect working again" — a screenshot of the panel,
  // not a request to try something. These are the values shipped from that
  // confirmation, pinned the same "two places store one number" way as
  // shimmerGain/saturation above — several of these constants had NEVER been
  // pinned before (strength/patternScalePx/parallaxStrength/driftSpeed/
  // islandSpread), because nothing had contested their old, arbitrary
  // defaults enough to justify one. A live-confirmed number is exactly the
  // kind of number worth protecting from silent drift.
  ok(
    'strength: schema and render module agree, and it now defaults to its own max',
    SPECULAR_PARAMS.strength.default === SPECULAR_DEFAULT_STRENGTH && SPECULAR_PARAMS.strength.default === 20
  );
  ok(
    'patternScalePx: schema and render module agree on the live-confirmed (smaller) scale',
    SPECULAR_PARAMS.patternScalePx.default === SPECULAR_DEFAULT_PATTERN_SCALE_PX
  );
  ok(
    'parallaxStrength: schema and render module agree on the live-confirmed value',
    SPECULAR_PARAMS.parallaxStrength.default === SPECULAR_DEFAULT_PARALLAX_STRENGTH
  );
  ok(
    'islandSpread: schema and render module agree, and it now defaults to its own max',
    SPECULAR_PARAMS.islandSpread.default === SPECULAR_DEFAULT_ISLAND_SPREAD &&
      SPECULAR_PARAMS.islandSpread.default === SPECULAR_PARAMS.islandSpread.max
  );
  ok(
    'driftSpeed: schema and render module agree the idle drift is now fully OFF by default',
    SPECULAR_PARAMS.driftSpeed.default === SPECULAR_DEFAULT_DRIFT_SPEED && SPECULAR_PARAMS.driftSpeed.default === 0
  );
  // shimmerGain/saturation/sheenCeiling/glintCeiling/incidentSteepness are
  // already pinned above/earlier by EQUALITY, not by literal — their values
  // change again below (ROUND 21) and flow through those SAME assertions
  // with no test changes, which is the entire point of this pinning shape.
  // (An earlier version of this comment named the Round 18 numbers directly;
  // that list was already stale by Round 19's sheenCeiling revert before
  // anyone touched it again — a literal snapshot in a comment rots exactly
  // like one in an assertion would, it just fails a human reader instead of
  // CI. Read the constants' own current values, never a comment's copy.)

  // ── ROUND 21 (2026-08-05) — SECOND SET OF LIVE-CONFIRMED DEFAULTS. The
  // author dialled the whole panel again on a real scene (a fresh screenshot,
  // not a request to try something) — saturation/shimmerGain/patternScalePx/
  // incidentSteepness/sheenCeiling/glintCeiling/parallaxStrength/pulse/
  // sunBias all moved. The first seven are already covered by the SAME
  // equality pins written for Round 16-18 above; `pulse` and `sunBias` had
  // never been pinned at all until now — closing that gap, not a change
  // these two constants specifically demanded on their own.
  ok(
    'pulse: schema and render module agree on the live-confirmed value',
    SPECULAR_PARAMS.pulse.default === SPECULAR_DEFAULT_PULSE
  );
  ok(
    'sunBias: schema and render module agree on the live-confirmed value',
    SPECULAR_PARAMS.sunBias.default === SPECULAR_DEFAULT_SUN_BIAS
  );
  // ⚠️ THE SHEEN/GLINT INVERSION, STATED SO A FUTURE READER DOES NOT "FIX"
  // IT: sheenCeiling is now exactly 0 (the base shine term is algebraically
  // eliminated, `SPECULAR_SHEEN_CEILING`'s own header has the arithmetic)
  // and glintCeiling is now its schema's own max — every visible highlight
  // comes from the shimmer alone. Pinned as a relationship, not a repeat of
  // the literal-comment mistake just above.
  ok(
    'the sheen ceiling is exactly zero — the base shine term is intentionally eliminated',
    SPECULAR_PARAMS.sheenCeiling.default === 0
  );
  ok(
    'the glint ceiling now defaults to its own schema max, carrying the whole effect alone',
    SPECULAR_PARAMS.glintCeiling.default === SPECULAR_PARAMS.glintCeiling.max
  );

  // --- it registers through the ONE door ----------------------------------
  const registry = createEffectRegistry();
  let applied = null;
  registry.register(SPECULAR, (resolved) => {
    applied = resolved;
  });
  registry.resolveAndApply('specular', { profile: 'standard', paramLayers: [{ strength: 0.5 }] });
  ok('registration + resolve reaches the apply callback', applied !== null);
  ok('…with the effect enabled', applied?.enabled === true);
  ok('…and the override layer winning over the default', applied?.params?.strength === 0.5);
  ok(
    '…while unset params fall back to their declared defaults',
    applied?.params?.driftSpeed === SPECULAR_PARAMS.driftSpeed.default
  );

  // --- THE DEBUG CHANNELS -------------------------------------------------
  // The channel list is shared data: `specular-render.js` builds the shader's
  // selector FROM it (by id, throwing on any id with no node) and `boot.js`
  // builds the picker FROM it. So its SHAPE is what keeps the two honest, and
  // these assertions are what keep the shape honest.
  const ns = SPECULAR_DEBUG_CHANNELS.map((c) => c.n);
  const ids = SPECULAR_DEBUG_CHANNELS.map((c) => c.id);
  ok('there are debug channels at all', SPECULAR_DEBUG_CHANNELS.length > 1);
  ok(
    'channel 0 is off — the effect as it ships',
    SPECULAR_DEBUG_CHANNELS[0]?.n === 0 && SPECULAR_DEBUG_CHANNELS[0]?.id === 'off'
  );
  // Contiguous from 0: the picker sends a NUMBER and the shader compares it
  // against `n`. A gap would be a selectable option that matches no branch and
  // therefore renders the fallback black — the single most misleading thing
  // this instrument could do, since black is also its failure ANSWER.
  ok(
    'the channel numbers are contiguous from 0',
    ns.every((n, i) => n === i)
  );
  ok('every channel number is unique', new Set(ns).size === ns.length);
  ok('every channel id is unique', new Set(ids).size === ids.length);
  ok(
    'every channel carries a label and a reading guide (the guide is the option tooltip)',
    SPECULAR_DEBUG_CHANNELS.every(
      (c) => typeof c.label === 'string' && c.label.length > 0 && typeof c.reads === 'string' && c.reads.length > 0
    )
  );
  // ⚠️ NOT A PARAM, and this is the assertion that keeps it that way. A
  // diagnostic view selector is neither a property of a material nor of the
  // world (this effect's own rule for what earns a control), the FOH/ROH card
  // is GENERATED from the schema, and a GM must never find "show me the raw
  // relief normal" on a slider strip beside Shine strength.
  ok(
    'no channel leaked into SPECULAR_PARAMS as a look control',
    !Object.prototype.hasOwnProperty.call(SPECULAR_PARAMS, 'debugChannel') &&
      !Object.prototype.hasOwnProperty.call(SPECULAR_PARAMS, 'debug')
  );
  // The ladder walks the product left to right, so "the first BLACK one is the
  // culprit" is a true instruction rather than a hopeful one. `quad` must come
  // first: it draws before anything is sampled, so it separates "the mesh is
  // not there" from "a factor is zero" — two different investigations.
  ok('channel 1 is the quad — is the mesh drawing at all, and where', SPECULAR_DEBUG_CHANNELS[1]?.id === 'quad');
  ok('the mask is read before the strength derived from it', ids.indexOf('mask') < ids.indexOf('strength'));
  ok('strength is read before the presence derived from IT', ids.indexOf('strength') < ids.indexOf('presence'));
  ok('the islands are read before the shimmer they steer', ids.indexOf('islands') < ids.indexOf('shimmer'));
  ok('…and their motion sits beside them', ids.indexOf('islandMotion') === ids.indexOf('islands') + 1);
  ok('presence is read before the gates that multiply it', ids.indexOf('presence') < ids.indexOf('floorGate'));
  ok('the gates are read before the shimmer they gate', ids.indexOf('floorGate') < ids.indexOf('shimmer'));
  ok('the shimmer is read before the sheen/glint it feeds', ids.indexOf('shimmer') < ids.indexOf('sheen'));
  // ⚠️ SHEEN BEFORE GLINT, live-diagnosed 2026-07-27: the split exists because
  // one shared ceiling flattened genuine glint peaks to the same modest level
  // as the always-on base, which was the actual "washed out" bug. Sheen is the
  // question "does painted metal read as its own colour at rest"; glint is
  // "do genuine highlights still pop" — two different investigations, and the
  // ordering keeps them from being read as one.
  ok(
    'sheen (the base) is read before glint (the shimmer`s own contribution)',
    ids.indexOf('sheen') < ids.indexOf('glint')
  );
  ok('both feed into final, in order', ids.indexOf('glint') < ids.indexOf('final'));
  ok(
    'the boosted final closes the CHAIN — it only means anything once `final` reads black',
    ids.indexOf('finalBoosted') === ids.indexOf('final') + 1
  );
  ok('the boost is a real amplification, not a no-op', SPECULAR_DEBUG_BOOST > 1);
  // The coordinate probes are a SECOND TIER and must stay AFTER the chain: the
  // whole instruction for using this thing is "the first black channel is the
  // culprit", and that is only true while the chain is an unbroken prefix. A
  // probe spliced into the middle would make a black one look like a verdict
  // about the product when it is a statement about a coordinate.
  const PROBES = ['maskUv', 'patternUv'];
  const chainEnd = ids.indexOf('finalBoosted');
  ok(
    'every coordinate probe exists and sits after the whole chain',
    PROBES.every((p) => ids.indexOf(p) > chainEnd)
  );
  ok(
    'the chain is an unbroken prefix — no probe splices into it',
    ids.slice(0, chainEnd + 1).every((id) => !PROBES.includes(id))
  );
}
