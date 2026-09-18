/**
 * Node verification for effects/lens.js — the declaration.
 *
 * Mirrors fluid.test.mjs/water.test.mjs's job: prove the manifest and schema
 * are well-formed as DATA, and pin the SHAPE so a key cannot be added without
 * someone noticing it needs a consumer (`params/no-dead-controls`).
 */
import { LENS, LENS_PARAMS, LENS_PRESETS, lensPreset, LENS_OVERLAY_CATALOG } from '../lens.js';
import { validateEffectManifest } from '../effect-manifest.js';
import { validateParamsSchema } from '../../core/params-schema.js';
import { resolveEffectEnabled } from '../effect-cascade.js';

export function run(t) {
  const { ok } = t;

  {
    const r = validateEffectManifest(LENS);
    ok(`manifest validates (${r.errors.join('; ')})`, r.ok === true);
  }
  {
    const r = validateParamsSchema(LENS_PARAMS);
    ok('params schema validates', r.ok === true);
  }

  ok(
    'every param declares a category so the ROH card can group it',
    Object.values(LENS_PARAMS).every((p) => typeof p.category === 'string' && p.category.length > 0)
  );
  ok(
    'every param declares plain-language help (Effects-UI.md)',
    Object.values(LENS_PARAMS).every((p) => typeof p.help === 'string' && p.help.length > 30)
  );
  ok('the manifest points at that same schema object', LENS.params === LENS_PARAMS);
  ok(
    'no rung is both a built tier and a deferred one',
    !LENS.deferredRungs.some((r) => LENS.tiers.some((t2) => t2.name === r.name))
  );

  ok('id is the stable camelCase registry key', LENS.id === 'lens');
  ok('a mood tool is defended mid-weight, not first or last', LENS.visualWeight > 0.2 && LENS.visualWeight < 0.5);
  // ⚠️ CHANGED 2026-09-16, mythica-machina-press#556 — deliberately the
  // OPPOSITE pin from bloom/depth-of-field's own "on by default at every
  // profile" block (effect-registration.test.mjs). Author, direct
  // instruction: lens "needs to be fine tuned and off by default." This pin
  // exists (same file header's own words) so a FUTURE accidental change back
  // toward "on by default" gets caught, not so this one is permanent —
  // update it again only alongside another deliberate author decision.
  ok(
    'off by default (author instruction) — not on at any profile short of extreme',
    LENS.enabledFromProfile === 'extreme'
  );
  ok('resolves OFF at standard, the default profile', resolveEffectEnabled(LENS, { profile: 'standard' }) === false);
  ok(
    'resolves OFF at quality too — extreme is the floor',
    resolveEffectEnabled(LENS, { profile: 'quality' }) === false
  );
  ok('resolves ON at extreme, the ceiling', resolveEffectEnabled(LENS, { profile: 'extreme' }) === true);
  ok(
    'a GM can still opt a scene in at any profile (the Studio effect switch)',
    resolveEffectEnabled(LENS, { profile: 'standard', gmEnable: 'on' }) === true
  );
  ok('tier 0 is declared — a manifest without one is malformed', LENS.tiers[0]?.n === 0);
  ok('tiers 0-3 are real code', LENS.tiers.length === 4);
  ok(
    'the ladder is named in build order',
    LENS.tiers.map((t2) => t2.name).join() === 'optics,motion,light-burn,overlay'
  );
  ok('no tier still claims to be unbuilt', !LENS.tiers.some((t2) => /NOT BUILT/.test(t2.adds)));
  ok(
    'cost class is non-decreasing across rungs 1..N (Law 3 — tier 0 exempt)',
    (() => {
      const order = ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
      for (let i = 2; i < LENS.tiers.length; i++) {
        if (order.indexOf(LENS.tiers[i].cost.class) < order.indexOf(LENS.tiers[i - 1].cost.class)) return false;
      }
      return true;
    })()
  );

  // The overlay-catalog gap this used to record is now tier 3 (built,
  // above) — nothing left to defer (lens.js's own header has the "basic v1
  // vs V2" scope split for what tier 3 does and does not attempt).
  ok('nothing left deferred — the overlay catalog shipped as tier 3', LENS.deferredRungs.length === 0);
  ok(
    'every deferred rung (there are none today) would still need a note explaining what it buys',
    LENS.deferredRungs.every((r) => typeof r.note === 'string' && r.note.length > 40)
  );

  // ── Tier 3: the overlay catalog (basic v1, mythica-machina-press#57) ─────
  ok(
    'overlay is off by default, matching every other opt-in sub-feature',
    LENS_PARAMS.overlayEnabled.default === false
  );
  ok(
    'the crossfade can never (by declared range) outlast a very short cycle',
    LENS_PARAMS.overlayCrossfadeSeconds.min <= LENS_PARAMS.overlayCycleSeconds.min
  );
  ok(
    'LENS_OVERLAY_CATALOG lists the real 13-image library, once each',
    Array.isArray(LENS_OVERLAY_CATALOG) &&
      LENS_OVERLAY_CATALOG.length === 13 &&
      new Set(LENS_OVERLAY_CATALOG).size === 13 &&
      LENS_OVERLAY_CATALOG.every((f) => typeof f === 'string' && /\.jpe?g$/i.test(f))
  );
  ok('the overlay catalog is frozen', Object.isFrozen(LENS_OVERLAY_CATALOG));

  ok('the declaration is frozen', Object.isFrozen(LENS) && Object.isFrozen(LENS_PARAMS));

  // ── Presets ────────────────────────────────────────────────────────────
  ok('LENS_PRESETS is a real (if currently empty-of-named-looks) table', typeof LENS_PRESETS === 'object');
  ok(
    'lensPreset always returns a FULL params object, even for an unknown name',
    Object.keys(lensPreset('does-not-exist')).length === Object.keys(LENS_PARAMS).length
  );
  ok(
    "lensPreset('none') is exactly the schema defaults",
    Object.entries(lensPreset('none')).every(([k, v]) => v === LENS_PARAMS[k].default)
  );
}
