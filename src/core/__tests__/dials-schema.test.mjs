/**
 * THE DIALS CONTRACT — verification (docs/holy/UI-Testament.md §9, U6). This
 * suite IS the `dials/valid-reference` wall's own half for dials (cues-
 * schema.test.mjs already carries the cue half) — every sabotage case below
 * is a dial shape that must fail validation, not a hypothetical.
 */
import {
  validateDialsSchema,
  resolveDialDrives,
  dialPositionFromParams,
  DIAL_CURVES,
  MAX_DIALS_PER_EFFECT,
} from '../dials-schema.js';

/** A small, realistic params schema — one of each relevant type. */
const PARAMS = {
  depth: { type: 'float', min: 0, max: 1, default: 0.5 },
  pollution: { type: 'float', min: 0, max: 1, default: 0 },
  opacity: { type: 'float', min: 0, max: 1, default: 1 },
  glossiness: { type: 'float', min: 0, max: 4, default: 1 },
  flowAngleDeg: { type: 'angle', default: 0 },
  enabled: { type: 'bool', default: true },
  tint: { type: 'color', space: 'srgb', default: '#173d47' },
};

function dial(overrides = {}) {
  return {
    label: 'Murkiness',
    help: 'How deep and dirty the water reads.',
    range: [0, 1],
    default: 0.4,
    drives: { depth: { to: [0.1, 0.9], curve: 'linear' } },
    ...overrides,
  };
}

export function run(t) {
  // ---- the happy path -------------------------------------------------------
  {
    const r = validateDialsSchema({ murkiness: dial() }, PARAMS);
    t.ok('a well-formed single-drive dial passes', r.ok);
    t.ok('a passing schema has no errors', r.errors.length === 0);

    const multi = validateDialsSchema(
      {
        murkiness: dial({
          drives: {
            depth: { to: [0.1, 0.9], curve: 'linear' },
            pollution: { to: [0, 0.6], curve: 'ease-in' },
          },
        }),
      },
      PARAMS
    );
    t.ok('a dial may drive multiple params at once', multi.ok);

    for (const curve of DIAL_CURVES) {
      const r2 = validateDialsSchema({ x: dial({ drives: { depth: { to: [0, 1], curve } } }) }, PARAMS);
      t.ok(`curve '${curve}' is accepted`, r2.ok);
    }
  }

  // ---- null/undefined/absent dials schema is LEGAL (fohKeys is the fallback) -
  {
    t.ok('undefined dials schema is ok (no dials declared)', validateDialsSchema(undefined, PARAMS).ok);
    t.ok('null dials schema is ok (no dials declared)', validateDialsSchema(null, PARAMS).ok);
  }

  // ---- structural rejection ---------------------------------------------
  {
    t.ok('a string is rejected, not thrown on', !validateDialsSchema('nope', PARAMS).ok);
    t.ok('an array is rejected (not a plain object)', !validateDialsSchema([], PARAMS).ok);
  }

  // ---- SABOTAGE: the ceiling ----------------------------------------------
  {
    const tooMany = {};
    for (let i = 0; i < MAX_DIALS_PER_EFFECT + 1; i++) tooMany[`d${i}`] = dial();
    const r = validateDialsSchema(tooMany, PARAMS);
    t.ok(`> ${MAX_DIALS_PER_EFFECT} dials is rejected (Effects-UI.md §3.2's hard ceiling)`, !r.ok);

    const exact = {};
    for (let i = 0; i < MAX_DIALS_PER_EFFECT; i++) exact[`d${i}`] = dial();
    t.ok(`exactly ${MAX_DIALS_PER_EFFECT} dials is allowed`, validateDialsSchema(exact, PARAMS).ok);
  }

  // ---- SABOTAGE: missing label/range/default ------------------------------
  {
    t.ok('missing label fails', !validateDialsSchema({ x: dial({ label: '' }) }, PARAMS).ok);
    t.ok('missing range fails', !validateDialsSchema({ x: dial({ range: undefined }) }, PARAMS).ok);
    t.ok('inverted range (min >= max) fails', !validateDialsSchema({ x: dial({ range: [1, 0] }) }, PARAMS).ok);
    t.ok('default outside range fails', !validateDialsSchema({ x: dial({ default: 5 }) }, PARAMS).ok);
  }

  // ---- SABOTAGE: no drives at all ------------------------------------------
  {
    const r = validateDialsSchema({ x: dial({ drives: {} }) }, PARAMS);
    t.ok('a dial with zero drives fails — "a dial that moves nothing is not a dial"', !r.ok);
  }

  // ---- SABOTAGE: drives target that does not exist in the params schema ---
  {
    const r = validateDialsSchema({ x: dial({ drives: { madeUpParam: { to: [0, 1], curve: 'linear' } } }) }, PARAMS);
    t.ok('a drives target absent from the params schema fails', !r.ok);
    t.ok(
      'the error names the offending key',
      r.errors.some((e) => e.includes('madeUpParam'))
    );
  }

  // ---- SABOTAGE: drives target is an angle param ---------------------------
  {
    const r = validateDialsSchema({ x: dial({ drives: { flowAngleDeg: { to: [0, 360], curve: 'linear' } } }) }, PARAMS);
    t.ok('an angle param cannot be a drive target (no fixed range to clamp into)', !r.ok);
    t.ok(
      'the error explains why (angle)',
      r.errors.some((e) => e.toLowerCase().includes('angle'))
    );
  }

  // ---- SABOTAGE: drives target is a non-numeric type (color/bool/etc) -----
  {
    const colorTarget = validateDialsSchema({ x: dial({ drives: { tint: { to: [0, 1], curve: 'linear' } } }) }, PARAMS);
    t.ok('a color param cannot be a drive target — it has no min/max a to window could check', !colorTarget.ok);

    const boolTarget = validateDialsSchema(
      { x: dial({ drives: { enabled: { to: [0, 1], curve: 'linear' } } }) },
      PARAMS
    );
    t.ok('a bool param cannot be a drive target', !boolTarget.ok);
  }

  // ---- SABOTAGE: bad curve name --------------------------------------------
  {
    const r = validateDialsSchema({ x: dial({ drives: { depth: { to: [0, 1], curve: 'bounce' } } }) }, PARAMS);
    t.ok('an unknown curve name fails', !r.ok);
  }

  // ---- SABOTAGE: to escapes the param's own declared range -----------------
  {
    const below = validateDialsSchema({ x: dial({ drives: { depth: { to: [-0.5, 0.5], curve: 'linear' } } }) }, PARAMS);
    t.ok("to[0] below the param's own min fails", !below.ok);

    const above = validateDialsSchema(
      { x: dial({ drives: { glossiness: { to: [0, 10], curve: 'linear' } } }) },
      PARAMS
    );
    t.ok("to[1] above the param's own max fails", !above.ok);

    const inverted = validateDialsSchema(
      { x: dial({ drives: { depth: { to: [0.9, 0.1], curve: 'linear' } } }) },
      PARAMS
    );
    t.ok('to[0] > to[1] fails', !inverted.ok);
  }

  // ---- resolveDialDrives: forward mapping, all four curves -----------------
  {
    const d = dial({ range: [0, 10], default: 0, drives: { depth: { to: [0, 1], curve: 'linear' } } });
    t.ok('linear at range min maps to to[0]', resolveDialDrives(d, 0).depth === 0);
    t.ok('linear at range max maps to to[1]', resolveDialDrives(d, 10).depth === 1);
    t.ok('linear at range midpoint maps to the midpoint', Math.abs(resolveDialDrives(d, 5).depth - 0.5) < 1e-9);

    const clampLow = resolveDialDrives(d, -100);
    t.ok('a value below range clamps to range min, not extrapolated', clampLow.depth === 0);
    const clampHigh = resolveDialDrives(d, 1000);
    t.ok('a value above range clamps to range max, not extrapolated', clampHigh.depth === 1);

    for (const curve of DIAL_CURVES) {
      const cd = dial({ range: [0, 1], drives: { depth: { to: [0, 1], curve } } });
      const at0 = resolveDialDrives(cd, 0).depth;
      const at1 = resolveDialDrives(cd, 1).depth;
      t.ok(`${curve}: position 0 drives to[0]`, Math.abs(at0 - 0) < 1e-9);
      t.ok(`${curve}: position 1 drives to[1]`, Math.abs(at1 - 1) < 1e-9);
    }

    const multi = dial({
      range: [0, 1],
      drives: {
        depth: { to: [0, 1], curve: 'linear' },
        pollution: { to: [0, 0.5], curve: 'linear' },
      },
    });
    const out = resolveDialDrives(multi, 1);
    t.ok('a multi-drive dial writes every driven param on one move', out.depth === 1 && out.pollution === 0.5);
  }

  // ---- dialPositionFromParams: inverse round-trips for every curve --------
  {
    for (const curve of DIAL_CURVES) {
      const d = dial({ range: [0, 1], drives: { depth: { to: [0.2, 0.8], curve } } });
      for (const probe of [0, 0.25, 0.5, 0.75, 1]) {
        const driven = resolveDialDrives(d, probe);
        const recovered = dialPositionFromParams(d, driven);
        t.ok(
          `${curve}: position ${probe} round-trips through resolve->inverse within tolerance`,
          Math.abs(recovered - probe) < 1e-4
        );
      }
    }

    const d = dial({ range: [0, 1], default: 0.4, drives: { depth: { to: [0, 1], curve: 'linear' } } });
    t.ok('a param value that is not finite falls back to the dial default', dialPositionFromParams(d, {}) === 0.4);
    t.ok(
      'a dial with no drives at all falls back to its default',
      dialPositionFromParams({ ...d, drives: {} }, { depth: 0.5 }) === 0.4
    );

    const multi = dial({
      range: [0, 1],
      drives: {
        depth: { to: [0, 1], curve: 'linear' },
        pollution: { to: [0, 1], curve: 'linear' },
      },
    });
    t.ok(
      'position is read from the FIRST-declared drive only (depth here, not pollution)',
      Math.abs(dialPositionFromParams(multi, { depth: 0.3, pollution: 0.9 }) - 0.3) < 1e-6
    );
  }
}
