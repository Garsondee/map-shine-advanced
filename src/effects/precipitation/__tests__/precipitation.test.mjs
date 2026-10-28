/**
 * Node verification for effects/precipitation/precipitation.js — the
 * declaration. Mirrors fire.test.mjs's own job now that PRECIPITATION_PARAMS
 * is no longer empty (2026-09-04, live author request for a real weather-
 * appearance control panel): prove the manifest and schema are well-formed
 * as DATA, that every param lands in a category the ROH renderer actually
 * recognises (`feedback_category_string_must_be_in_closed_list` — a category
 * missing from `CATEGORY_ORDER` silently sweeps its params into 'Technical',
 * no error, no warning), and that every default survives its own declared
 * range unclamped.
 */
import { PRECIPITATION, PRECIPITATION_PARAMS } from '../precipitation.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { validateParamsSchema, validateParamValue } from '../../../core/params-schema.js';
import { CATEGORY_ORDER } from '../../../diag/effect-controls.js';
import { precipTierPlan } from '../precip-species.js';
import { createPrecipitationSubsystem, warmWeatherFor } from '../precip-subsystem.js';

export function run(t) {
  const { ok } = t;

  {
    const r = validateEffectManifest(PRECIPITATION);
    ok(`manifest validates (${r.errors.join('; ')})`, r.ok === true);
  }
  {
    const r = validateParamsSchema(PRECIPITATION_PARAMS);
    ok(`params schema validates (${r.errors.join('; ')})`, r.ok === true);
  }
  ok(
    'PRECIPITATION_PARAMS now has real weather-appearance controls, not the deliberately-empty placeholder',
    Object.keys(PRECIPITATION_PARAMS).length > 0
  );
  {
    // ⚠️ THE SAME CLOSED-LIST TRAP FIRE'S OWN TEST GUARDS AGAINST — a category
    // absent from `CATEGORY_ORDER` (ui/widgets/param-groups.js) is not an
    // error anywhere; it just quietly renders under 'Technical' instead.
    const unknown = Object.entries(PRECIPITATION_PARAMS)
      .filter(([, decl]) => !CATEGORY_ORDER.includes(decl.category))
      .map(([key, decl]) => `${key}=${decl.category}`);
    ok(`every param category is in the closed list (${JSON.stringify(unknown)})`, unknown.length === 0);
  }
  {
    // Every param needs a label AND a help string — the FOH/ROH card is
    // generated from this and nothing else, so a missing one ships blank.
    const missing = Object.entries(PRECIPITATION_PARAMS)
      .filter(([, d]) => !d.label || !d.help)
      .map(([k]) => k);
    ok(`every param has a label and help (${JSON.stringify(missing)})`, missing.length === 0);
  }
  {
    // A default that gets CLAMPED by its own declared range is a schema-
    // authoring bug `validateParamsSchema` already catches — restated here,
    // per-param, so a future retune that breaks one range names WHICH key.
    const clamped = Object.entries(PRECIPITATION_PARAMS)
      .filter(([, d]) => validateParamValue(d, d.default).clamped)
      .map(([k]) => k);
    ok(`no default is silently clamped by its own range (${JSON.stringify(clamped)})`, clamped.length === 0);
  }
  {
    // ⭐ THE ONE DELIBERATE DEVIATION FROM THE ENGINE'S OWN PRE-EXISTING
    // DEFAULT — every other param's `default` below is copied from what
    // `precip-subsystem.js`'s sub-engines already hardcode, so a fresh
    // session needs no "push defaults on boot" step; this is the one the
    // author asked to change ("lower their opacity by a lot"), tuned down
    // from the engine's own 0.75 across more than one live pass.
    ok(
      'splashAlphaScale`s default was lowered from the engine`s own 0.75',
      PRECIPITATION_PARAMS.splashAlphaScale.default === 0.29
    );
  }
  ok('the manifest points at that same schema object', PRECIPITATION.params === PRECIPITATION_PARAMS);

  ok('id is the stable camelCase registry key', PRECIPITATION.id === 'precipitation');
  ok(
    'on by default at every profile — formalises, does not change, today`s hardcoded enabled:true',
    PRECIPITATION.enabledFromProfile === 'low'
  );
  ok('tier 0 is declared — a manifest without one is malformed', PRECIPITATION.tiers[0]?.n === 0);
  ok('the ladder is exactly 3 rungs, matching PRECIP_TIER_SCALES', PRECIPITATION.tiers.length === 3);
  ok(
    'rungs are contiguous 0..2',
    PRECIPITATION.tiers.every((t, i) => t.n === i)
  );
  ok('tier 1 is bought at performance', PRECIPITATION.tiers[1]?.fromProfile === 'performance');
  ok('tier 2 is bought at standard — the DEFAULT profile', PRECIPITATION.tiers[2]?.fromProfile === 'standard');

  ok(
    'every deferred rung carries a note explaining what it buys',
    PRECIPITATION.deferredRungs.every((r) => typeof r.note === 'string' && r.note.length > 40)
  );

  ok('the declaration is frozen', Object.isFrozen(PRECIPITATION) && Object.isFrozen(PRECIPITATION_PARAMS));

  // ── THE LADDER AND THE MANIFEST NEVER DISAGREE ───────────────────────────
  // `precipTierPlan` and the manifest's own tier count are two independently
  // hand-typed things (3 tiers vs. a 3-element PRECIP_TIER_SCALES array) —
  // this is the cross-check that catches them drifting apart.
  ok(
    'precipTierPlan resolves exactly as many rungs as the manifest declares',
    precipTierPlan(PRECIPITATION.tiers.length).tier === PRECIPITATION.tiers.length - 1
  );
  ok('tier 0`s scale matches the manifest`s own "40%" claim', precipTierPlan(0).tierScale === 0.4);
  ok('tier 2 (standard, the ceiling) matches the manifest`s own "100%" claim', precipTierPlan(2).tierScale === 1.0);

  // ── THE LOAD-TIME WARM-UP's SEAMS (2026-10-28) ───────────────────────────
  // A forced storm is a COPY laid over the real sky: it must cross every response threshold (veil 0.5, fog 0.7,
  // torrent 0.75) and must never write into the snapshot, whose weather is frozen.
  {
    const sky = Object.freeze({ cloudCover01: 0.4, temperature01: 0.6, precip01: 0, precipKind: 'rain' });
    const stormy = warmWeatherFor(sky, 'snow');
    ok('a warm storm is full strength (every threshold crossed)', stormy.precip01 === 1);
    ok('...of the asked kind, unmixed', stormy.precipKind === 'snow' && stormy.precipMixWeight === 0);
    ok(
      '...over the real sky (cloud and temperature kept)',
      stormy.cloudCover01 === 0.4 && stormy.temperature01 === 0.6
    );
    ok('...and the frozen snapshot is untouched', sky.precip01 === 0 && sky.precipKind === 'rain');
    ok('an absent sky still yields a storm', warmWeatherFor(undefined, 'rain').precip01 === 1);
  }
  {
    let state = { enabled: true, weather: { precip01: 0 } };
    const sub = createPrecipitationSubsystem({ THREE: {}, getPrecipRenderState: () => state });
    const kinds = sub.warmUpKinds();
    ok('every kind a GM can reach is warmed, rain first', kinds[0] === 'rain' && kinds.includes('snow'));
    ok(
      'only built species are warmed (sleet and embers are not rows of their own)',
      !kinds.includes('sleet') && !kinds.includes('embers')
    );
    state = { enabled: false, weather: {} };
    ok(
      'a disabled effect warms nothing (a low profile pays nothing for weather it will not draw)',
      sub.warmUpKinds().length === 0
    );
    state = null;
    ok('no render state yet (cold load, before the first env snapshot) warms nothing', sub.warmUpKinds().length === 0);
    // A warm frame with nothing to warm against must be a clean no-op, and `endWarm` callable regardless.
    let threw = false;
    try {
      sub.sync(null, 1 / 60, 0, null, null, null, { kind: 'rain' });
      sub.endWarm();
      sub.endWarm();
    } catch {
      threw = true;
    }
    ok('a warm frame with no render state, and endWarm twice, are harmless', !threw && sub.scenes.length === 0);
  }
}
