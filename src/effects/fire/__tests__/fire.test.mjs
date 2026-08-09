/**
 * fire.test.mjs — THE DECLARATION, checked against the REAL validators.
 *
 * A manifest is data nothing executes, which is exactly the shape that rots
 * without anyone noticing. `candle-flame.js`'s own header records the outcome:
 * it declared ONE rung and filed `animated-flicker` under `deferredRungs` as
 * NOT BUILT, and both had been false for weeks — the manifest described an
 * effect that no longer existed (`feedback_unconsumed_api_rots_silently`).
 *
 * So this runs the shipped `validateEffectManifest` and `validateParamsSchema`
 * over the real FIRE declaration rather than eyeballing it, and — the part that
 * matters most — ties `FIRE_DEFAULT_TIER` to what the DEFAULT performance
 * profile actually resolves the real ladder to, so re-tuning a rung's
 * `fromProfile` cannot leave the fallback constant behind pointing at a
 * different look.
 */
import { validateEffectManifest } from '../../effect-manifest.js';
import { validateParamsSchema, validateParamValue } from '../../../core/params-schema.js';
import { resolveEffectTier, resolveEffectEnabled, DEFAULT_PERFORMANCE_PROFILE } from '../../effect-cascade.js';
import { CATEGORY_ORDER } from '../../../diag/effect-controls.js';
import { FIRE, FIRE_PARAMS } from '../fire.js';
import { fireTierPlan, FIRE_DEFAULT_TIER } from '../fire-geometry.js';

export function run(t) {
  {
    const res = validateEffectManifest(FIRE);
    t.ok(`the manifest validates (${JSON.stringify(res.errors ?? [])})`, res.ok === true);
  }

  {
    const res = validateParamsSchema(FIRE_PARAMS);
    t.ok(`the params schema validates (${JSON.stringify(res.errors ?? [])})`, res.ok === true);
  }

  {
    // ⚠️ A CATEGORY NOT IN `CATEGORY_ORDER` SILENTLY FALLS TO 'Technical'
    // (effect-controls.js:34) — no error, no warning, the control just turns up
    // in the wrong place. Three effects lost their groups that way, which is
    // exactly the closed-list check `feedback_category_string_must_be_in_closed_list`
    // exists for.
    const unknown = Object.entries(FIRE_PARAMS)
      .filter(([, decl]) => !CATEGORY_ORDER.includes(decl.category))
      .map(([key, decl]) => `${key}=${decl.category}`);
    t.ok(`every param category is in the closed list (${JSON.stringify(unknown)})`, unknown.length === 0);
  }

  {
    // Every param needs a label and a help string — the FOH/ROH card is
    // generated from this and nothing else, so a missing one ships as a blank.
    const missing = Object.entries(FIRE_PARAMS)
      .filter(([, d]) => !d.label || !d.help)
      .map(([k]) => k);
    t.ok(`every param has a label and help (${JSON.stringify(missing)})`, missing.length === 0);
  }

  {
    // Every default must survive its own declaration — a default outside its
    // own range is an error the schema validator catches, but a default that
    // merely gets CLAMPED is a silent difference between "what the manifest
    // says" and "what a fresh install gets".
    const clamped = Object.entries(FIRE_PARAMS)
      .map(([k, d]) => [k, validateParamValue(d, d.default)])
      .filter(([, r]) => !r.ok || r.clamped)
      .map(([k]) => k);
    t.ok(`no default is rejected or clamped (${JSON.stringify(clamped)})`, clamped.length === 0);
  }

  {
    // ⚠️ THE ANTI-DRIFT CROSS-CHECK, and the reason this file exists.
    // `FIRE_DEFAULT_TIER` is what a malformed or absent tier falls back to. It
    // must equal what the DEFAULT profile resolves the REAL ladder to, or the
    // fallback silently shows a different fire than the one everybody gets.
    const resolved = resolveEffectTier(FIRE, { profile: DEFAULT_PERFORMANCE_PROFILE });
    t.ok(
      `FIRE_DEFAULT_TIER (${FIRE_DEFAULT_TIER}) equals what '${DEFAULT_PERFORMANCE_PROFILE}' resolves to (${resolved.tier})`,
      resolved.tier === FIRE_DEFAULT_TIER
    );
    t.ok('the default tier draws smoke', fireTierPlan(resolved.tier).smoke === true);
  }

  {
    // The ladder and the tier-plan table must agree about how many rungs exist,
    // or a profile can resolve to a tier the arithmetic has no entry for.
    const topTier = FIRE.tiers.length - 1;
    t.ok('the top declared rung has a plan', fireTierPlan(topTier) !== fireTierPlan(topTier + 1) || topTier === 5);
    t.ok(
      'every declared rung resolves to a distinct-or-valid plan',
      FIRE.tiers.every((r) => fireTierPlan(r.n) != null)
    );
  }

  {
    // Rungs must be cumulative and affordable in order — the cascade's own
    // rule, checked here against the shipped ladder rather than a synthetic one.
    const profiles = ['low', 'performance', 'standard', 'quality', 'extreme'];
    const tiers = profiles.map((p) => resolveEffectTier(FIRE, { profile: p }).tier);
    let monotonic = true;
    for (let i = 1; i < tiers.length; i++) if (tiers[i] < tiers[i - 1]) monotonic = false;
    t.ok(`tier rises monotonically with profile (${JSON.stringify(tiers)})`, monotonic);
    t.ok('even the lowest profile gets a fire', tiers[0] >= 0);
  }

  {
    // ⚠️ FIRE IS PHOTOSENSITIVE AND MUST DECLARE IT. A large fire pulses its
    // whole cast light at a real vortex-shedding frequency — near 1.5 Hz at
    // campfire scale, across a significant fraction of the screen. That is
    // squarely what the accessibility hard-off exists for, and it is not a
    // judgement this effect makes for its viewer.
    t.ok('fire declares itself photosensitive', FIRE.a11y.photosensitive === true);
    t.ok(
      'the accessibility hard-off actually disables it',
      resolveEffectEnabled(FIRE, { profile: 'extreme', reducePhotosensitive: true }) === false
    );
    t.ok(
      '...and it is on otherwise',
      resolveEffectEnabled(FIRE, { profile: 'standard', reducePhotosensitive: false }) === true
    );
  }

  {
    // The paint authoring hook is what puts fire's ＋ button in the UI, and it
    // must name the mask kind the catalog actually declares.
    t.ok('fire declares its paint authoring kind', FIRE.authoring?.paint === 'fire');
    t.ok('the effect id matches what the anchor catalog will bind to', FIRE.id === 'fire');
  }

  {
    // Deferred rungs are the honest half of the manifest. An empty list here
    // would be a claim that fire is finished, which it is not.
    t.ok('deferred rungs are recorded', Array.isArray(FIRE.deferredRungs) && FIRE.deferredRungs.length > 0);
    t.ok(
      'every deferred rung says WHY it is deferred',
      FIRE.deferredRungs.every((r) => typeof r.note === 'string' && r.note.length > 40)
    );
  }
}
