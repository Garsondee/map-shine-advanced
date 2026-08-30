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
  resolvePostUpscaleSharpenStrength,
  setPostUpscaleSharpenStrength,
  getPostUpscaleSharpenStrength,
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
    setAlbedoClarity({ farHi: 2 }); // below the default farLo (2.5)
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

  // ==========================================================================
  // resolvePostUpscaleSharpenStrength — internalScale -> sharpen strength
  // ==========================================================================
  {
    ok(
      'scale 1.0 (native) resolves to EXACTLY 0 — the free path must cost nothing',
      resolvePostUpscaleSharpenStrength(1.0) === 0
    );
    ok(
      'a hair below 1.0 still snaps to 0 (the >=0.9995 identity guard)',
      resolvePostUpscaleSharpenStrength(0.9997) === 0
    );
    ok(
      'scale 0.5 (the ladder floor) resolves to the full maxStrength (0.12)',
      Math.abs(resolvePostUpscaleSharpenStrength(0.5) - 0.12) < 1e-9
    );
    const mid = resolvePostUpscaleSharpenStrength(0.75); // halfway between 1.0 and 0.5
    ok('a mid-ladder scale resolves to roughly half of maxStrength (linear ramp)', Math.abs(mid - 0.06) < 1e-9);
    ok(
      'strictly monotonic: a lower scale never resolves to a LOWER strength',
      resolvePostUpscaleSharpenStrength(0.6) >= resolvePostUpscaleSharpenStrength(0.8)
    );
    ok(
      'a scale ABOVE 1 (should never happen, but) clamps rather than going negative-strength',
      resolvePostUpscaleSharpenStrength(1.5) === 0
    );
    ok(
      'a scale BELOW the ladder floor clamps to the floor’s own strength, not beyond it',
      resolvePostUpscaleSharpenStrength(0.1) === resolvePostUpscaleSharpenStrength(0.5)
    );
    ok('garbage input (NaN) resolves to 0, the native-path-safe answer', resolvePostUpscaleSharpenStrength(NaN) === 0);
    ok('missing input resolves to 0', resolvePostUpscaleSharpenStrength(undefined) === 0);
  }

  // ==========================================================================
  // setPostUpscaleSharpenStrength / getPostUpscaleSharpenStrength
  // ==========================================================================
  {
    setPostUpscaleSharpenStrength(0);
    ok('starts/resets at 0', getPostUpscaleSharpenStrength() === 0);
    setPostUpscaleSharpenStrength(0.05);
    ok('a value inside range is stored exactly', getPostUpscaleSharpenStrength() === 0.05);
    setPostUpscaleSharpenStrength(999);
    ok(
      'clamps to maxStrength (0.12), never a player-facing sharpness-scale number',
      getPostUpscaleSharpenStrength() === 0.12
    );
    setPostUpscaleSharpenStrength(-5);
    ok('clamps to 0, never negative', getPostUpscaleSharpenStrength() === 0);
    setPostUpscaleSharpenStrength(NaN);
    ok('garbage input stores as 0, not NaN', getPostUpscaleSharpenStrength() === 0);
    // Leave it at 0 (the native-path default) for whichever suite runs next.
    setPostUpscaleSharpenStrength(0);
  }

  // Leave global state at the shipped default for whichever suite runs next
  // in the same process — module-level state outlives this function.
  resetAlbedoClarity();
}
