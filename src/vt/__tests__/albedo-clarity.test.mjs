/**
 * Node tests for vt/albedo-clarity.js — the state/schema half only.
 * `buildAlbedoClarityNode`/`buildFlatAlbedoNode` build a real TSL graph and
 * have no Node test surface, same as every other shader-building function in
 * this codebase (vt-pan-viewer.js's own convention — see
 * `docs/planning/Performance-Audit-2026-08.md`'s note on this exact pair).
 */
import { validateParamsSchema } from '../../core/params-schema.js';
import {
  ALBEDO_CLARITY_PARAMS,
  setAlbedoClarity,
  getAlbedoClarity,
  resetAlbedoClarity,
  isAlbedoClarityEnabled,
} from '../albedo-clarity.js';

export function run(t) {
  const { ok } = t;

  // ==========================================================================
  // THE SCHEMA IS WELL-FORMED — the same check params/no-dead-controls'
  // sibling wall (structure) does not cover: type/range/default coherence.
  // ==========================================================================
  {
    const res = validateParamsSchema(ALBEDO_CLARITY_PARAMS);
    ok(`ALBEDO_CLARITY_PARAMS validates (${res.errors.join(' | ')})`, res.ok);
    ok('has exactly the six documented knobs, no more, no less', Object.keys(ALBEDO_CLARITY_PARAMS).length === 6);
    ok(
      "enabled is NOT a schema param — it is the card's own toggle, matching Grade",
      !('enabled' in ALBEDO_CLARITY_PARAMS)
    );
    ok('sharpness is categorised Look (the one FOH-worthy knob)', ALBEDO_CLARITY_PARAMS.sharpness.category === 'Look');
    for (const key of ['gateLo', 'gateHi', 'farLo', 'farHi', 'farFloor']) {
      ok(`${key} is categorised Technical`, ALBEDO_CLARITY_PARAMS[key].category === 'Technical');
    }
  }

  // ==========================================================================
  // setAlbedoClarity / getAlbedoClarity — the live-tuning contract
  // ==========================================================================
  {
    resetAlbedoClarity();
    ok('default sharpness is 0.22 (the shipped value)', getAlbedoClarity().sharpness === 0.22);
    ok("ships enabled, per this project's default-on-new-features rule", getAlbedoClarity().enabled === true);
    ok('isAlbedoClarityEnabled() agrees', isAlbedoClarityEnabled() === true);

    setAlbedoClarity({ sharpness: 0.35 });
    ok('sharpness updates', getAlbedoClarity().sharpness === 0.35);
    ok('unrelated fields are untouched by a partial update', getAlbedoClarity().gateLo === 1.0);

    // Clamping — mirrors ALBEDO_CLARITY_PARAMS' own declared ranges exactly,
    // so a slider can never reach a value the setter would silently clamp
    // out from under it (the schema test above pins the range side of that
    // promise; this pins the setter side).
    setAlbedoClarity({ sharpness: 999 });
    ok('sharpness clamps to its max (0.5)', getAlbedoClarity().sharpness === 0.5);
    setAlbedoClarity({ sharpness: -5 });
    ok('sharpness clamps to its min (0)', getAlbedoClarity().sharpness === 0);
    setAlbedoClarity({ farFloor: 5 });
    ok('farFloor clamps to its max (1)', getAlbedoClarity().farFloor === 1);

    // Ramp ordering — a smoothstep with hi <= lo is a hard step (pops on
    // zoom rather than fading), so the setter must keep both pairs ordered
    // whichever end the caller moved.
    resetAlbedoClarity();
    setAlbedoClarity({ gateHi: 0.5 }); // below the default gateLo (1.0)
    ok(
      "gateHi cannot be pushed at/below gateLo — it drags gateLo's own value",
      getAlbedoClarity().gateHi > getAlbedoClarity().gateLo
    );
    resetAlbedoClarity();
    setAlbedoClarity({ farHi: 2 }); // below the default farLo (6.0)
    ok('farHi cannot be pushed at/below farLo', getAlbedoClarity().farHi > getAlbedoClarity().farLo);
  }

  // ==========================================================================
  // enabled — the disable switch's persistent half
  // ==========================================================================
  {
    resetAlbedoClarity();
    setAlbedoClarity({ sharpness: 0.4 });
    setAlbedoClarity({ enabled: false });
    ok('enabled turns off', getAlbedoClarity().enabled === false);
    ok('isAlbedoClarityEnabled() agrees', isAlbedoClarityEnabled() === false);
    ok(
      '...WITHOUT destroying the stored sharpness — re-enabling must restore it exactly',
      getAlbedoClarity().sharpness === 0.4
    );
    setAlbedoClarity({ enabled: true });
    ok(
      're-enabling restores visibility with the same stored sharpness',
      getAlbedoClarity().enabled === true && getAlbedoClarity().sharpness === 0.4
    );
  }

  // ==========================================================================
  // resetAlbedoClarity — the way back from a tuning session gone wrong
  // ==========================================================================
  {
    setAlbedoClarity({ sharpness: 0.01, gateLo: 3, enabled: false });
    resetAlbedoClarity();
    const d = getAlbedoClarity();
    ok('reset restores the shipped sharpness', d.sharpness === 0.22);
    ok('reset restores the shipped gateLo', d.gateLo === 1.0);
    ok('reset restores enabled:true, even from a disabled state', d.enabled === true);
  }

  // Leave global state at the shipped default for whichever suite runs next
  // in the same process — module-level state outlives this function.
  resetAlbedoClarity();
}
