/**
 * THE FADE ENGINE — pure-core verification (docs/holy/UI-Testament.md §4.2,
 * U2 checkpoint 2). "reload mid-fade" and "merge" cases are the Testament's
 * own explicit ask (§9's U2 checklist).
 */
import {
  FADEABLE_TYPES,
  CURVES,
  isFadeableType,
  shapeProgress,
  rawProgress,
  progressOf,
  isEntryExpired,
  computeEasedValue,
  mergeFadeState,
  pruneExpired,
  cancelEntry,
  snapEntry,
  deriveAllValues,
} from '../fade-engine.js';
import { PARAM_TYPES } from '../../core/params-schema.js';

/** @param {Partial<import('../fade-engine.js').FadeEntry>} overrides */
function entry(overrides = {}) {
  return {
    from: 0,
    to: 1,
    type: 'float',
    startedAtMs: 1000,
    overMs: 1000,
    curve: 'linear',
    ...overrides,
  };
}

export function run(t) {
  // ---- curves ----------------------------------------------------------
  {
    for (const curve of CURVES) {
      t.ok(`${curve}: starts at 0`, shapeProgress(curve, 0) === 0);
      t.ok(`${curve}: ends at 1`, shapeProgress(curve, 1) === 1);
    }
    t.ok('linear is identity', shapeProgress('linear', 0.37) === 0.37);
    t.ok('smoothstep at .5 is exactly .5 (symmetric)', shapeProgress('smoothstep', 0.5) === 0.5);
    t.ok('ease at .5 is exactly .5 (symmetric cosine)', Math.abs(shapeProgress('ease', 0.5) - 0.5) < 1e-9);
    t.ok('smoothstep eases in: below linear near 0', shapeProgress('smoothstep', 0.1) < 0.1);
    t.ok('smoothstep eases out: above linear near 1', shapeProgress('smoothstep', 0.9) > 0.9);
    t.ok('hold-snap: 0 mid-window', shapeProgress('hold-snap', 0.99) === 0);
    t.ok('hold-snap: 1 only at completion', shapeProgress('hold-snap', 1) === 1);
    t.ok('unrecognized curve falls back to linear, not a throw', shapeProgress('nonsense', 0.4) === 0.4);
    t.ok('progress clamps below 0', shapeProgress('linear', -5) === 0);
    t.ok('progress clamps above 1', shapeProgress('linear', 5) === 1);
  }

  // ---- rawProgress / isEntryExpired -------------------------------------
  {
    const e = entry({ startedAtMs: 1000, overMs: 1000 });
    t.ok('before start: raw progress is 0', rawProgress(e, 1000) === 0);
    t.ok('before start (earlier nowMs): still clamps to 0, never negative', rawProgress(e, 500) === 0);
    t.ok('halfway: raw progress is .5', rawProgress(e, 1500) === 0.5);
    t.ok('exactly at overMs: raw progress is 1', rawProgress(e, 2000) === 1);
    t.ok('well past overMs: raw progress clamps to 1', rawProgress(e, 9000) === 1);
    t.ok('not expired mid-window', !isEntryExpired(e, 1500));
    t.ok('expired at the boundary', isEntryExpired(e, 2000));

    const eased = entry({ startedAtMs: 1000, overMs: 1000, curve: 'smoothstep' });
    t.ok(
      "progressOf applies the entry's own curve to its raw progress",
      progressOf(eased, 1500) === shapeProgress('smoothstep', 0.5)
    );
    t.ok('progressOf on a linear entry matches raw progress exactly', progressOf(e, 1300) === rawProgress(e, 1300));

    const cut = entry({ overMs: 0 });
    t.ok('overMs:0 is an instant cut — raw progress is 1 immediately', rawProgress(cut, cut.startedAtMs) === 1);
    t.ok('overMs:0 is expired immediately', isEntryExpired(cut, cut.startedAtMs));
  }

  // ---- per-type interpolation --------------------------------------------
  {
    t.ok('float lerps linearly', computeEasedValue(entry({ from: 0, to: 10, type: 'float' }), 1500) === 5);
    t.ok(
      'int lerps then rounds',
      computeEasedValue(entry({ from: 0, to: 3, type: 'int', overMs: 1000 }), 1000 + 333) === 1
    );

    // Angle: shortest arc, 350 -> 10 sweeps FORWARD through 0/360 (a 20°
    // journey), never backward through 180 (a 340° journey).
    const angleMid = computeEasedValue(entry({ from: 350, to: 10, type: 'angle' }), 1500);
    t.ok(`angle 350->10 halfway lands near 0/360, not near 180 (got ${angleMid})`, angleMid < 10 || angleMid > 350);
    t.ok('angle result always in [0, 360)', angleMid >= 0 && angleMid < 360);
    t.ok(
      'angle straightforward case (no wrap needed) lerps normally',
      computeEasedValue(entry({ from: 10, to: 50, type: 'angle' }), 1500) === 30
    );
    t.ok(
      'angle wraps a negative-from correctly (350 stored as -10 style input)',
      Math.abs(computeEasedValue(entry({ from: -10, to: 10, type: 'angle' }), 2000) - 10) < 1e-9
    );

    t.ok(
      // Math.round(127.5) === 128 (JS rounds half-up) — #808080, not #7f7f7f.
      'color lerps per-channel',
      computeEasedValue(entry({ from: '#000000', to: '#ffffff', type: 'color' }), 1500) === '#808080'
    );
    t.ok(
      'color at t=0 is exactly from',
      computeEasedValue(entry({ from: '#123456', to: '#abcdef', type: 'color' }), 1000) === '#123456'
    );
    t.ok(
      'malformed color holds from, then snaps to at completion',
      computeEasedValue(entry({ from: 'not-a-color', to: '#ffffff', type: 'color' }), 1500) === 'not-a-color' &&
        computeEasedValue(entry({ from: 'not-a-color', to: '#ffffff', type: 'color' }), 2000) === '#ffffff'
    );

    t.ok(
      'vec2 lerps per-component',
      JSON.stringify(computeEasedValue(entry({ from: [0, 10], to: [10, 20], type: 'vec2' }), 1500)) === '[5,15]'
    );
    t.ok(
      'vec3 lerps per-component',
      JSON.stringify(computeEasedValue(entry({ from: [0, 0, 0], to: [2, 4, 6], type: 'vec3' }), 1500)) === '[1,2,3]'
    );

    // Discrete: hold from, snap to `to` only once fully complete.
    t.ok(
      'bool holds from mid-window',
      computeEasedValue(entry({ from: false, to: true, type: 'bool' }), 1500) === false
    );
    t.ok(
      'bool snaps to `to` at completion',
      computeEasedValue(entry({ from: false, to: true, type: 'bool' }), 2000) === true
    );
    t.ok(
      'enum holds from mid-window',
      computeEasedValue(entry({ from: 'clear', to: 'storm', type: 'enum' }), 1999) === 'clear'
    );
    t.ok(
      'enum snaps to `to` at completion',
      computeEasedValue(entry({ from: 'clear', to: 'storm', type: 'enum' }), 2000) === 'storm'
    );

    t.ok(
      'unrecognized type degrades to hold-then-snap, never throws',
      computeEasedValue(entry({ from: 'a', to: 'b', type: 'made-up-type' }), 1500) === 'a' &&
        computeEasedValue(entry({ from: 'a', to: 'b', type: 'made-up-type' }), 2000) === 'b'
    );
  }

  // ---- FADEABLE_TYPES / isFadeableType covers every PARAM_TYPES entry ----
  {
    const nonFadeable = ['text', 'curve', 'action'];
    for (const type of PARAM_TYPES) {
      const expected = !nonFadeable.includes(type);
      t.ok(`isFadeableType('${type}') === ${expected}`, isFadeableType(type) === expected);
    }
    const coveredTypes = new Set([...FADEABLE_TYPES, ...nonFadeable]);
    t.ok(
      'FADEABLE_TYPES + the 3 excluded types account for every PARAM_TYPES entry (no type silently unhandled)',
      PARAM_TYPES.every((t2) => coveredTypes.has(t2))
    );
  }

  // ---- RELOAD MID-FADE — pure re-derivation, no state to lose ------------
  {
    // Simulate a page reload: build the entry ONCE (as if just read back from
    // a scene flag), then call computeEasedValue at a LATER nowMs with
    // NOTHING in between — no "resume" call, no intermediate ticks. If this
    // is truly pure, the answer is identical to having ticked continuously.
    const record = entry({ from: 0.2, to: 0.9, type: 'float', startedAtMs: 5000, overMs: 60000, curve: 'linear' });
    const afterReloadAt42Pct = computeEasedValue(record, 5000 + 60000 * 0.42);
    const expected = 0.2 + (0.9 - 0.2) * 0.42;
    t.ok(
      `reload mid-fade: resumes exactly where wall-clock math says (got ${afterReloadAt42Pct}, expected ${expected})`,
      Math.abs(afterReloadAt42Pct - expected) < 1e-9
    );
    // Past the window entirely (a long-offline reload) — lands on `to`, not
    // stuck mid-fade forever and not an error. Epsilon, not strict equality:
    // 0.2 + (0.9-0.2)*1 is 0.8999999999999999 in IEEE-754 float math, a fact
    // about the arithmetic, not a bug in it.
    t.ok(
      'reload long after the window closed: derives straight to `to`',
      Math.abs(computeEasedValue(record, 5000 + 60000 * 50) - 0.9) < 1e-9
    );
  }

  // ---- mergeFadeState — replace-don't-queue, disjoint coexistence --------
  {
    const empty = {};
    const first = mergeFadeState(
      empty,
      {
        id: 'g1',
        label: 'Dusk falls',
        targets: { 'weather.cloudCover01': { to: 0.9, type: 'float', overMs: 1000, curve: 'linear', from: 0.1 } },
      },
      1000
    );
    t.ok('fresh key uses the caller-supplied live fallback as `from`', first['weather.cloudCover01'].from === 0.1);
    t.ok('fresh key targets the requested `to`', first['weather.cloudCover01'].to === 0.9);
    t.ok('mergeFadeState does not mutate the input map', empty['weather.cloudCover01'] === undefined);

    // Interrupt the SAME key mid-fade with a new target — must capture the
    // CURRENT eased value (not the original `from`, not a raw live re-read).
    const midwayEased = computeEasedValue(first['weather.cloudCover01'], 1500); // 0.1 + (0.9-0.1)*0.5 = 0.5
    const second = mergeFadeState(
      first,
      {
        id: 'g2',
        label: 'Clearing',
        targets: {
          'weather.cloudCover01': {
            to: 0.0,
            type: 'float',
            overMs: 500,
            curve: 'linear',
            from: 999 /* must be ignored */,
          },
        },
      },
      1500
    );
    t.ok(
      `replace-don't-queue: new fade's \`from\` is the CURRENT eased value (${midwayEased}), not the caller fallback`,
      second['weather.cloudCover01'].from === midwayEased
    );
    t.ok("the interrupting fade's own `to` wins", second['weather.cloudCover01'].to === 0.0);
    t.ok('the interrupting fade restarts its own clock at nowMs', second['weather.cloudCover01'].startedAtMs === 1500);

    // Disjoint channel: fading a DIFFERENT key leaves this one untouched.
    const third = mergeFadeState(
      second,
      { targets: { 'water.depth': { to: 0.8, type: 'float', overMs: 2000, curve: 'ease', from: 0.5 } } },
      1600
    );
    t.ok(
      'disjoint fades coexist: the untouched key is byte-identical',
      third['weather.cloudCover01'] === second['weather.cloudCover01']
    );
    t.ok('the new disjoint key lands correctly', third['water.depth'].to === 0.8);

    const bogusCurveResult = mergeFadeState(
      {},
      { targets: { x: { to: 1, type: 'float', overMs: 100, curve: 'bogus', from: 0 } } },
      0
    );
    t.ok(
      'an invalid curve name falls back to linear rather than corrupting the record',
      bogusCurveResult.x.curve === 'linear'
    );

    const negativeOverMsResult = mergeFadeState(
      {},
      { targets: { x: { to: 1, type: 'float', overMs: -500, curve: 'linear', from: 0 } } },
      0
    );
    t.ok(
      'a negative overMs clamps to 0 (an instant cut), never a negative window',
      negativeOverMsResult.x.overMs === 0
    );
  }

  // ---- pruneExpired / cancelEntry / snapEntry / deriveAllValues ----------
  {
    const state = {
      done: entry({ startedAtMs: 0, overMs: 100 }), // expired well before nowMs=1000
      running: entry({ startedAtMs: 900, overMs: 1000 }), // still going at nowMs=1000
    };
    const pruned = pruneExpired(state, 1000);
    t.ok('pruneExpired drops the finished entry', !('done' in pruned));
    t.ok('pruneExpired keeps the still-running entry', 'running' in pruned);
    t.ok('pruneExpired does not mutate the input', 'done' in state);

    const cancelled = cancelEntry(state, 'running', 950);
    const heldValue = computeEasedValue(state.running, 950);
    t.ok(
      'cancelEntry holds at the eased value from the moment of cancellation',
      cancelled.running.from === heldValue && cancelled.running.to === heldValue
    );
    t.ok('cancelEntry is immediately expired (overMs:0)', isEntryExpired(cancelled.running, 950));
    t.ok('cancelEntry on an absent key is a safe no-op', cancelEntry(state, 'nope', 950) === state);

    const snapped = snapEntry(state, 'running', 950);
    t.ok('snapEntry jumps straight to `to`', computeEasedValue(snapped.running, 950) === snapped.running.to);
    t.ok('snapEntry on an absent key is a safe no-op', snapEntry(state, 'nope', 950) === state);

    const derived = deriveAllValues({ a: entry({ from: 0, to: 10, overMs: 1000, startedAtMs: 0 }) }, 500);
    t.ok('deriveAllValues returns a plain key->value map', derived.a === 5);
  }
}
