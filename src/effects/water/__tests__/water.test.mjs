/**
 * water.test.mjs — the water declaration is a valid, registrable effect.
 * Registration MACHINERY is proven in effect-registration.test.mjs; this
 * pins water's own shape and that it flows through the one door.
 *
 * WATER_PARAMS grows one TIER at a time, never ahead of the code that reads
 * it — see water.js's own header. It was deliberately EMPTY through phases
 * 1-2 (params/no-dead-controls would have failed the build otherwise), gained
 * tier 0's three in phase 3, tier 1's three in phase 4, tier 2's four the same
 * session, and tier 3's four (sunGlint, skySheen, glossiness, viewerHeight).
 */
import { validateParamsSchema } from '../../../core/params-schema.js';
import { validateDialsSchema } from '../../../core/dials-schema.js';
import { validateEffectManifest } from '../../effect-manifest.js';
import { createEffectRegistry } from '../../registry.js';
import { resolveEffectEnabled } from '../../effect-cascade.js';
import { WATER, WATER_PARAMS, WATER_DIALS, WATER_PRESETS, waterPreset } from '../water.js';
import {
  WATER_BANK_INFLUENCE,
  WATER_TIER2_FLOW_ANGLE_DEG,
  WATER_CAUSTICS_SHARPNESS,
  WATER_CAUSTICS_SCALE,
  WATER_CAUSTICS_NETTING,
  WATER_CAUSTICS_WAVE_WARP_STRENGTH,
  WATER_CAUSTICS_WAVE_WARP_CELLS,
  WATER_CAUSTICS_GROWTH_STRENGTH,
  WATER_CAUSTICS_GROWTH_CELLS,
  WATER_CAUSTICS_GROWTH_FREQ,
  WATER_CAUSTICS_GROWTH_TIME_SCALE,
  WATER_CAUSTICS_EVOLVE_SPEED,
  WATER_CAUSTICS_JUNCTION_FRACTION,
  WATER_CAUSTICS_LINE_FLOOR,
  WATER_CAUSTICS_SPECULAR_INFLUENCE,
} from '../water-field.js';
import { WATER_TIER3_SHADOW_RESPONSE, WATER_TIER3_GLOSSINESS, WATER_MIN_ROUGHNESS } from '../water-light.js';
import { WATER_TIER4_SWASH_FOAM, WATER_TIER4_BREAK_FOAM, WATER_TIER4_CAUSTICS } from '../water-render.js';

export function run(t) {
  const { ok, throws } = t;

  // --- the declaration validates ------------------------------------------
  ok('WATER_PARAMS is a valid params schema', validateParamsSchema(WATER_PARAMS).ok);
  ok('WATER is a valid manifest', validateEffectManifest(WATER).ok);
  // U6's real half of the `dials/valid-reference` wall (core/dials-schema.
  // test.mjs carries the synthetic-fixture half) — every WATER_DIALS `drives`
  // target must exist in WATER_PARAMS, in range, non-angle. A future edit
  // narrowing e.g. `chop`'s max below the Shine dial's `to[1]=1.1` fails
  // HERE, not silently in a live card.
  {
    const dialsResult = validateDialsSchema(WATER_DIALS, WATER_PARAMS);
    ok(`WATER_DIALS validates against WATER_PARAMS (${dialsResult.errors.join('; ')})`, dialsResult.ok);
    ok(
      // ⚠️ RAISED 5 → 6 (2026-08-27, round 6) — a deliberate exception to
      // U6's own "five dials" curation cap, not a silent creep: the author
      // was explicitly offered "replace an existing dial" and "ROH only"
      // as alternatives and chose "add a sixth" for Caustics. See
      // `WATER_DIALS.caustics`'s own doc for the full reasoning.
      'WATER_DIALS declares between 3 and 6 dials (U6 exit gate, +1 author-approved exception)',
      Object.keys(WATER_DIALS).length >= 3 && Object.keys(WATER_DIALS).length <= 6
    );
  }
  ok("the effect's id is water", WATER.id === 'water');
  ok(
    'water does not flash (a11y photosensitive false) — tier 0 has no flicker at all',
    WATER.a11y.photosensitive === false
  );

  // --- default ON: tier 0 is a mask read + a tint, nearly free ------------
  ok('gated to low → on even at Low', WATER.enabledFromProfile === 'low');
  ok('resolves ON at Low by default', resolveEffectEnabled(WATER, { profile: 'low' }) === true);
  ok('resolves ON at Standard by default', resolveEffectEnabled(WATER, { profile: 'standard' }) === true);
  ok(
    'a player can still turn it OFF (final say)',
    resolveEffectEnabled(WATER, { profile: 'low', playerEnable: 'off' }) === false
  );

  // --- the ladder: BUILT rungs in `tiers`, the rest honestly deferred -----
  // The counts are asserted RELATIVE to each other rather than pinned to
  // literals: this block previously hardcoded "exactly one rung" and "8
  // deferred", which is the correct invariant expressed in a way that has to
  // be edited every time a rung actually lands. What matters is that the two
  // together always describe the whole 9-rung ladder with nothing claimed
  // twice and nothing dropped — that holds at every phase.
  ok(
    'every built rung is numbered contiguously from 0',
    WATER.tiers.every((t, i) => t.n === i)
  );
  ok(
    'built + deferred always account for the whole 0-8 ladder, no gaps, no double-claims',
    WATER.tiers.length + WATER.deferredRungs.length === 9
  );
  ok('tier 0 is the admission price, C4', WATER.tiers[0].cost.class === 'C4');
  ok(
    'every built rung carries a cost class and a one-line adds',
    WATER.tiers.every((t) => typeof t.cost?.class === 'string' && typeof t.adds === 'string' && t.adds.length > 0)
  );
  // Tier 1 is the first rung of the C1→C8 staircase proper (Effects.md §4):
  // tier 0's class is the admission price and is exempt from monotonicity.
  ok(
    'tier 1, once built, is C1 — the staircase starts cheap',
    WATER.tiers[1] === undefined || WATER.tiers[1].cost.class === 'C1'
  );
  ok(
    'tier 2, once built, is C2 — the next rung of the staircase',
    WATER.tiers[2] === undefined || WATER.tiers[2].cost.class === 'C2'
  );
  ok(
    'tier 3, once built, is C3 — light is real now (2026-07-26)',
    WATER.tiers[3] === undefined || WATER.tiers[3].cost.class === 'C3'
  );
  ok(
    "deferredRungs entries are named, not built (no n, no cost — bloom.js's own shape)",
    WATER.deferredRungs.every((r) => typeof r.name === 'string' && typeof r.note === 'string' && r.n === undefined)
  );

  // --- tier 4 (shore), landed 2026-08-16 — asserted unconditionally, not
  // "if built" like tiers 1-3 above, because it now genuinely is.
  ok('tier 4 exists and is numbered correctly', WATER.tiers[4]?.n === 4);
  ok("tier 4 is named 'shore', matching Water.md §6", WATER.tiers[4]?.name === 'shore');
  ok('tier 4 is C4 — the staircase continues past tier 3s C3', WATER.tiers[4]?.cost.class === 'C4');
  ok(
    "tier 4 is the FIRST rung to buy quality/extreme a water of their own — standard's own ceiling is tier 3",
    WATER.tiers[4]?.fromProfile === 'quality' && WATER.tiers[3]?.fromProfile === 'standard'
  );
  ok(
    "deferredRungs no longer lists 'shore' now that it is built — one entry, one place",
    !WATER.deferredRungs.some((r) => r.name === 'shore')
  );

  // --- it flows through the ONE door (the velocity test in miniature) -----
  {
    const reg = createEffectRegistry();
    let applied = null;
    const id = reg.register(WATER, (r) => {
      applied = r;
    });
    ok('register returns the water id', id === 'water');
    const resolved = reg.resolveAndApply('water', { profile: 'standard' });
    ok('resolveAndApply drives the water apply', applied !== null && applied.enabled === true);
    // Phase 3 gave water its first real params (tier 0's three), so this
    // asserts the DEFAULTS flow through the cascade rather than the schema
    // being empty — which is what it checked while the schema deliberately
    // was (see water.js's header on why params arrive with their consumer).
    ok(
      'resolved params carry every schema default',
      Object.keys(resolved.params).length === Object.keys(WATER_PARAMS).length
    );
    ok(
      '...including the tint, decoded later by the registration seam',
      resolved.params.tint === WATER_PARAMS.tint.default
    );
    ok(
      '...and the shoreline threshold that antialiases the edge',
      resolved.params.shorelineDepth === WATER_PARAMS.shorelineDepth.default
    );
    throws('a duplicate water registration throws', () => reg.register(WATER, () => {}), 'already registered');
  }

  // --- tier 2: the bank influence must stay BOUNDED BY THE CELL, not the clock
  // The shipped bug (2026-07-26) scaled a per-pixel direction by elapsed TIME:
  // `drift = flowDir · speed · t`. Around a convex feature the shore tangent
  // fans out, so neighbouring pixels held directions differing by a fraction of
  // a degree — harmless until multiplied by an unbounded amplifier, at which
  // point they sampled noise thousands of px apart and the surface tore into a
  // fan of rays off every dock and wall, worsening the longer the scene ran.
  // A fraction-of-a-cell bound is the property that makes that impossible, so
  // it is asserted rather than left to the constant's docstring.
  ok(
    'the bank warp is a FRACTION of one noise cell (a value ≥ 1 can shear the surface)',
    WATER_BANK_INFLUENCE > 0 && WATER_BANK_INFLUENCE < 1
  );

  // --- the flow direction is an ANGLE, and its default agrees with the code
  // TWO PLACES STORE EACH OF THESE, which is the drift `chop`/`glossiness`
  // already have pins for and which specular shipped for real once
  // (`SPECULAR_DEFAULT_SHIMMER_GAIN`). A schema default that disagrees with the
  // render module's constant means the panel opens showing one number while the
  // shader runs another — silent, and only visible as "the slider does nothing
  // until I touch it".
  ok(
    'flow direction is declared as an `angle`, so it wraps instead of clamping',
    WATER_PARAMS.flowAngleDeg.type === 'angle'
  );
  ok(
    "...and an angle declares no min/max — its range is the circle (see params-schema's own rule)",
    !('min' in WATER_PARAMS.flowAngleDeg) && !('max' in WATER_PARAMS.flowAngleDeg)
  );
  ok(
    'the schema default and WATER_TIER2_FLOW_ANGLE_DEG are the SAME heading',
    WATER_PARAMS.flowAngleDeg.default === WATER_TIER2_FLOW_ANGLE_DEG
  );
  ok(
    'the shadow response default matches WATER_TIER3_SHADOW_RESPONSE',
    WATER_PARAMS.shadowResponse.default === WATER_TIER3_SHADOW_RESPONSE
  );
  ok(
    'shadows fully defeat the glint OUT OF THE BOX — the author asked for the physics, not an option',
    WATER_PARAMS.shadowResponse.default === 1
  );
  // The help text is what an author reads instead of this file. If it stops
  // naming the compass, the control silently becomes "some number of degrees
  // from somewhere", which is exactly the state the old `flowAngleDeg` was in.
  ok(
    'the flow-direction help still explains the compass and which way north is',
    /compass/i.test(WATER_PARAMS.flowAngleDeg.help) && /north/i.test(WATER_PARAMS.flowAngleDeg.help)
  );

  // --- tier 4's two params exist, are the right type, and agree with the
  // render module's own defaults — the identical drift check every other
  // tier-4-and-below param above already has.
  ok(
    'swashFoam is declared as a plain float, 0..1',
    WATER_PARAMS.swashFoam.type === 'float' && WATER_PARAMS.swashFoam.min === 0 && WATER_PARAMS.swashFoam.max === 1
  );
  ok(
    'swashFoam schema default matches WATER_TIER4_SWASH_FOAM (water-render.js)',
    WATER_PARAMS.swashFoam.default === WATER_TIER4_SWASH_FOAM
  );
  ok(
    'breakFoam is declared as a plain float, 0..1',
    WATER_PARAMS.breakFoam.type === 'float' && WATER_PARAMS.breakFoam.min === 0 && WATER_PARAMS.breakFoam.max === 1
  );
  ok(
    'breakFoam schema default matches WATER_TIER4_BREAK_FOAM (water-render.js)',
    WATER_PARAMS.breakFoam.default === WATER_TIER4_BREAK_FOAM
  );
  // The author named this one directly (*"the shoreline and break near obstacles
  // foam"*) and it is the term that reads as a river FLOWING rather than as a
  // pond with an outline, so it ships on at a strength you can actually see.
  ok('break foam is on by default and clearly visible, not a token amount', WATER_PARAMS.breakFoam.default >= 0.5);
  // Its help must say the flow drives it: at flow speed 0 it silently does
  // nothing, and an author would reasonably read that as a broken slider.
  ok('the break-foam help warns that it follows the flow direction', /flow/i.test(WATER_PARAMS.breakFoam.help));
  ok(
    'caustics is declared as a plain float, 0..1',
    WATER_PARAMS.caustics.type === 'float' && WATER_PARAMS.caustics.min === 0 && WATER_PARAMS.caustics.max === 1
  );
  // ⚠️ THE `=== 1` HALF IS GONE (2026-08-17). It asserted the shipped default
  // was the FULLY-calibrated gain — true when written, and an over-reach: the
  // gain is an author-facing multiplier layered ON TOP of the calibrated
  // `WATER_CAUSTICS_K` precisely so a scene can pull the effect back without
  // retuning the physics underneath (see that constant's own doc). The author
  // set 0.33 on their own river, which is the control being used exactly as
  // designed. What still MUST hold — and is the only thing this ever needed to
  // defend — is that the two storage sites agree.
  ok(
    'caustics schema default matches WATER_TIER4_CAUSTICS (water-render.js) — one number, two homes',
    WATER_PARAMS.caustics.default === WATER_TIER4_CAUSTICS
  );
  ok(
    '...and the gain stays inside its own declared range, so the calibrated K is never scaled past it',
    WATER_TIER4_CAUSTICS >= WATER_PARAMS.caustics.min && WATER_TIER4_CAUSTICS <= WATER_PARAMS.caustics.max
  );
  // === CAUSTICS' OWN LOOK CONTROLS (2026-08-27) — same "one number, two
  // homes" discipline as `caustics` itself, just against water-field.js
  // instead of water-render.js (that is where these three constants live —
  // see WATER_CAUSTICS_SHARPNESS's own doc for why). ===
  for (const [key, constant, name] of [
    ['causticSharpness', WATER_CAUSTICS_SHARPNESS, 'WATER_CAUSTICS_SHARPNESS'],
    ['causticScale', WATER_CAUSTICS_SCALE, 'WATER_CAUSTICS_SCALE'],
    ['causticNetting', WATER_CAUSTICS_NETTING, 'WATER_CAUSTICS_NETTING'],
    // === round 6 (2026-08-27) — the rest of caustics' mechanics, promoted
    // to live wide-range sliders on the author's own "give me plenty of
    // controls" request. Same one-number-two-homes discipline. ===
    ['causticWaveWarp', WATER_CAUSTICS_WAVE_WARP_STRENGTH, 'WATER_CAUSTICS_WAVE_WARP_STRENGTH'],
    ['causticWaveWarpCap', WATER_CAUSTICS_WAVE_WARP_CELLS, 'WATER_CAUSTICS_WAVE_WARP_CELLS'],
    ['causticGrowth', WATER_CAUSTICS_GROWTH_STRENGTH, 'WATER_CAUSTICS_GROWTH_STRENGTH'],
    ['causticGrowthCap', WATER_CAUSTICS_GROWTH_CELLS, 'WATER_CAUSTICS_GROWTH_CELLS'],
    ['causticGrowthScale', WATER_CAUSTICS_GROWTH_FREQ, 'WATER_CAUSTICS_GROWTH_FREQ'],
    ['causticGrowthSpeed', WATER_CAUSTICS_GROWTH_TIME_SCALE, 'WATER_CAUSTICS_GROWTH_TIME_SCALE'],
    ['causticEvolveSpeed', WATER_CAUSTICS_EVOLVE_SPEED, 'WATER_CAUSTICS_EVOLVE_SPEED'],
    ['causticJunctionWidth', WATER_CAUSTICS_JUNCTION_FRACTION, 'WATER_CAUSTICS_JUNCTION_FRACTION'],
    ['causticLineFloor', WATER_CAUSTICS_LINE_FLOOR, 'WATER_CAUSTICS_LINE_FLOOR'],
    // === round 7 (2026-08-27) — the caustic-specular A/B test. ===
    ['causticSpecularInfluence', WATER_CAUSTICS_SPECULAR_INFLUENCE, 'WATER_CAUSTICS_SPECULAR_INFLUENCE'],
  ]) {
    ok(`${key} is declared as a plain float`, WATER_PARAMS[key].type === 'float');
    ok(
      `${key} schema default matches ${name} (water-field.js) — one number, two homes`,
      WATER_PARAMS[key].default === constant
    );
    ok(
      `${key}'s default stays inside its own declared range`,
      constant >= WATER_PARAMS[key].min && constant <= WATER_PARAMS[key].max
    );
    ok(`${key} is categorised under Light, beside caustics itself`, WATER_PARAMS[key].category === 'Light');
    ok(
      `${key} has real help text, not a placeholder`,
      typeof WATER_PARAMS[key].help === 'string' && WATER_PARAMS[key].help.length > 20
    );
  }
  // === 🎨 NAMED PRESETS ====================================================
  // A preset is raw param data with no schema behind it, which makes it the
  // easiest thing in this effect to rot silently: rename a param, retype one,
  // tighten a range, and the preset keeps "working" while quietly writing a key
  // nothing reads or a value the shader clamps. `setWater` rejects an unknown
  // key at runtime with a console error — invisible in a screenshot, which is
  // how the author would meet it. These assertions are the build-time wall.
  {
    const names = Object.keys(WATER_PRESETS);
    ok('there is at least one named preset', names.length > 0);

    for (const name of names) {
      const preset = WATER_PRESETS[name];
      const keys = Object.keys(preset);

      const unknown = keys.filter((k) => !Object.prototype.hasOwnProperty.call(WATER_PARAMS, k));
      ok(
        `preset '${name}': every key is a real WATER_PARAMS key${unknown.length ? ` (unknown: ${unknown})` : ''}`,
        unknown.length === 0
      );

      // COMPLETE, not a diff — see WATER_PRESETS' own header for why a partial
      // preset would silently change meaning every time a default moved.
      const missing = Object.keys(WATER_PARAMS).filter((k) => !(k in preset));
      ok(
        `preset '${name}': covers EVERY param, so it is an anchor not a diff${missing.length ? ` (missing: ${missing})` : ''}`,
        missing.length === 0
      );

      const badType = keys.filter((k) => {
        const decl = WATER_PARAMS[k];
        if (decl.type === 'color') return typeof preset[k] !== 'string';
        return typeof preset[k] !== 'number' || !Number.isFinite(preset[k]);
      });
      ok(
        `preset '${name}': every value has its param's own type${badType.length ? ` (wrong: ${badType})` : ''}`,
        badType.length === 0
      );

      // ⚠️ IN RANGE, because out-of-range is the failure that does NOT throw:
      // the schema clamps on write, so a preset storing 1.4 for a 0..1 param
      // applies as 1 and the author sees a look nobody authored.
      const outOfRange = keys.filter((k) => {
        const decl = WATER_PARAMS[k];
        if (typeof preset[k] !== 'number') return false;
        if (decl.min !== undefined && preset[k] < decl.min) return true;
        if (decl.max !== undefined && preset[k] > decl.max) return true;
        return false;
      });
      ok(
        `preset '${name}': every value is inside its param's declared range${outOfRange.length ? ` (out: ${outOfRange})` : ''}`,
        outOfRange.length === 0
      );
    }

    ok(
      'waterPreset returns a COPY, so a caller cannot mutate the frozen table',
      waterPreset(names[0]) !== WATER_PRESETS[names[0]]
    );
    ok('...with the same contents', waterPreset(names[0]).opacity === WATER_PRESETS[names[0]].opacity);
    ok('an unknown preset name returns null, never a silent defaults fallback', waterPreset('no-such-preset') === null);

    // The author's approved look is currently ALSO the shipped defaults. That
    // is true today and deliberately not asserted as a permanent fact — the
    // whole reason the preset exists is to outlive the next default change.
    ok(
      "the author's own river preset is present under its documented name",
      Object.prototype.hasOwnProperty.call(WATER_PRESETS, 'pollutedTownRiver')
    );
  }

  // === 🪞 THE GLOSSINESS CEILING IS THE ROUGHNESS FLOOR ====================
  // `roughness = clamp(1 − glossiness, WATER_MIN_ROUGHNESS, 1)`, so any
  // glossiness above `1 − WATER_MIN_ROUGHNESS` is indistinguishable from it.
  // The schema's max is that value, typed out because this module imports
  // nothing; this is the pin that stops the two drifting (2026-08-17).
  ok(
    'the glossiness ceiling equals 1 − WATER_MIN_ROUGHNESS — no inert top to the slider',
    Math.abs(WATER_PARAMS.glossiness.max - (1 - WATER_MIN_ROUGHNESS)) < 1e-9
  );
  ok('the glossiness code constant IS the schema default', WATER_PARAMS.glossiness.default === WATER_TIER3_GLOSSINESS);
}
