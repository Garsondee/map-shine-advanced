/**
 * THE WEATHER MANAGER — env's weather owner (docs/planning/Weather-Manager.md).
 *
 * What is proven here:
 *   - the ease is monotone, cannot overshoot, and actually ARRIVES;
 *   - `tau` is direction-dependent, so building differs from clearing;
 *   - LAW 5: a clear director sky is byte-identical to no weather at all;
 *   - `hasOwner` distinguishes "clear sky" from "nobody wired the manager";
 *   - version bumps on INTENT, never on eased motion;
 *   - `almanac` is refused rather than silently accepted (slice 1 scope).
 */
import {
  createWeatherManager,
  easeToward,
  tauForDuration,
  clampAxis,
  WEATHER_AXES,
  WEATHER_AXIS_NAMES,
  WEATHER_MODES,
  TRANSITION_SPEEDS,
} from '../weather.js';
import { DEFAULT_WEATHER } from '../environment.js';

/** Run `seconds` of ticks at a fixed step. Returns the values seen, in order. */
function runFor(mgr, seconds, stepSec = 1 / 60, axis = 'cloudCover01') {
  const seen = [];
  const steps = Math.round(seconds / stepSec);
  for (let i = 0; i < steps; i++) {
    seen.push(mgr.tick(stepSec).state[axis]);
  }
  return seen;
}

export function run(t) {
  // ---- the axis table itself -------------------------------------------------
  {
    t.ok('four cloud axes ship in slice 1', WEATHER_AXIS_NAMES.length === 4);
    t.ok(
      'every axis declares a full spec',
      WEATHER_AXIS_NAMES.every((n) => {
        const s = WEATHER_AXES[n];
        return (
          Number.isFinite(s.min) &&
          Number.isFinite(s.max) &&
          Number.isFinite(s.fallback) &&
          s.durationUpSec > 0 &&
          s.durationDownSec > 0 &&
          s.epsilon > 0
        );
      })
    );
    // ⚠️ THE RETUNE GUARD (author-instructed, 2026-08-16). The first cut stored
    // exponential TIME CONSTANTS in these fields while the doc's numbers read as
    // durations, so a cover change took ~6 minutes to look done. These bounds
    // are not style — they are the difference between a control that responds
    // and one a GM reports as broken. Anything slower than a minute-and-a-half
    // to LOOK done should be a deliberate, argued change, not a drift.
    t.ok(
      'no axis takes longer than 90s to look done at brisk',
      WEATHER_AXIS_NAMES.every((n) => WEATHER_AXES[n].durationUpSec <= 90 && WEATHER_AXES[n].durationDownSec <= 90)
    );
    t.ok(
      'cover — the one axis with live consumers — lands inside a scene beat',
      WEATHER_AXES.cloudCover01.durationUpSec <= 60
    );
    t.ok(
      'every axis still builds faster than (or as fast as) it clears',
      WEATHER_AXIS_NAMES.every((n) => WEATHER_AXES[n].durationUpSec <= WEATHER_AXES[n].durationDownSec)
    );
    t.ok(
      'epsilons are PERCEPTUAL: a unit axis snaps below 8-bit resolution',
      WEATHER_AXES.cloudCover01.epsilon <= 1 / 255 && WEATHER_AXES.cloudCover01.epsilon > 0
    );
    t.ok(
      'every axis declares its consumer status (the unconsumed-API rule, machine-readable)',
      WEATHER_AXIS_NAMES.every((n) => ['live', 'pending'].includes(WEATHER_AXES[n].consumerStatus))
    );
    t.ok(
      'every fallback is inside its own declared range',
      WEATHER_AXIS_NAMES.every((n) => {
        const s = WEATHER_AXES[n];
        return s.fallback >= s.min && s.fallback <= s.max;
      })
    );
    t.ok('the axis table is frozen', Object.isFrozen(WEATHER_AXES) && Object.isFrozen(WEATHER_AXES.cloudCover01));
  }

  // ---- ⭐ LAW 5: manager-on + director + clear === no weather at all ----------
  // The single assertion the "default ON" claim rests on. If this fails, turning
  // the manager on silently changes how every existing scene renders.
  {
    const mgr = createWeatherManager();
    const w = mgr.toSnapshotWeather();
    const mismatched = WEATHER_AXIS_NAMES.filter((n) => w[n] !== DEFAULT_WEATHER[n]);
    t.ok(`LAW 5: a fresh director manager matches DEFAULT_WEATHER on every axis`, mismatched.length === 0);
    t.ok('LAW 5: ...including the preset label', w.preset === DEFAULT_WEATHER.preset);
    t.ok('cloudCover01 default is 0 — three shipped consumers read it', w.cloudCover01 === 0);
  }

  // ---- hasOwner: the seam contract -------------------------------------------
  {
    const mgr = createWeatherManager();
    t.ok('a manager-fed weather block declares hasOwner', mgr.toSnapshotWeather().hasOwner === true);
    t.ok('DEFAULT_WEATHER does NOT — nobody wrote it', DEFAULT_WEATHER.hasOwner === false);
    t.ok(
      'the two are otherwise identical, which is exactly why hasOwner has to exist',
      mgr.toSnapshotWeather().cloudCover01 === DEFAULT_WEATHER.cloudCover01
    );
  }

  // ---- the ease: monotone, no overshoot, arrives ------------------------------
  {
    const mgr = createWeatherManager();
    mgr.setTargets({ cloudCover01: 1 });
    const seen = runFor(mgr, 60);

    t.ok(
      'ease is strictly monotone toward the target',
      seen.every((v, i) => i === 0 || v >= seen[i - 1])
    );
    t.ok(
      'ease NEVER overshoots',
      seen.every((v) => v <= 1)
    );
    t.ok('ease actually moves', seen[seen.length - 1] > 0.2);
  }

  // ---- ⭐ DURATION MEANS WHAT IT SAYS -------------------------------------------
  // The assertion the whole retune rests on: a declared `durationUpSec` of 45
  // must actually produce a sky that LOOKS overcast 45 seconds later. When these
  // fields held raw time constants, 45 would have meant ~29% — which is what
  // made the control feel broken.
  {
    const mgr = createWeatherManager();
    mgr.setTargets({ cloudCover01: 1 });
    const atDuration = runFor(mgr, WEATHER_AXES.cloudCover01.durationUpSec).pop();
    t.ok(
      'at the declared duration the transition is ~95% done (visually finished)',
      atDuration > 0.93 && atDuration < 0.97
    );

    // Half way through it should be well past half — an exponential front-loads,
    // which is what makes weather read as "arriving" rather than "sliding".
    const mgr2 = createWeatherManager();
    mgr2.setTargets({ cloudCover01: 1 });
    const atHalf = runFor(mgr2, WEATHER_AXES.cloudCover01.durationUpSec / 2).pop();
    t.ok('the curve front-loads (past 3/4 at the half-way mark)', atHalf > 0.75);

    t.ok('tauForDuration is the one conversion, and it is duration/3', tauForDuration(90) === 30);
    t.ok('a zero duration means snap, not divide-by-zero', tauForDuration(0) === 0);
  }

  // ---- it ARRIVES, and in a time a human would tolerate ------------------------
  {
    const mgr = createWeatherManager();
    mgr.setTargets({ cloudCover01: 1 });
    // Find the frame it genuinely settles on, rather than asserting against an
    // arbitrary long horizon — the number itself is the thing under test.
    let elapsed = 0;
    const step = 1 / 60;
    while (mgr.read().settling && elapsed < 600) {
      mgr.tick(step);
      elapsed += step;
    }
    const r = mgr.read();
    t.ok('an exponential with an arrival epsilon reaches its target exactly', r.state.cloudCover01 === 1);
    t.ok('...and settling goes false, so a gated consumer cannot hang forever', r.settling === false);
    // Pre-retune this took ~18 real minutes. The bound is the regression guard.
    t.ok(`⭐ full settle is under two minutes (measured ${elapsed.toFixed(1)}s)`, elapsed < 120);
  }

  // ---- direction-dependent duration -------------------------------------------
  {
    const up = createWeatherManager();
    up.setTargets({ cloudCover01: 1 });
    const rise = runFor(up, 60).pop();

    const down = createWeatherManager({ initial: { cloudCover01: 1 } });
    down.setTargets({ cloudCover01: 0 });
    const fall = 1 - runFor(down, 60).pop();

    t.ok('skies BUILD faster than they clear (tauUp 120 < tauDown 150)', rise > fall);
  }

  // ---- transition speed ---------------------------------------------------------
  {
    const instant = createWeatherManager({ transitionSpeed: 'instant' });
    instant.setTargets({ cloudCover01: 1 });
    instant.tick(1 / 60);
    t.ok('`instant` lands in ONE tick — a genuine snap, not a small tau', instant.read().state.cloudCover01 === 1);

    const brisk = createWeatherManager({ transitionSpeed: 'brisk' });
    const realistic = createWeatherManager({ transitionSpeed: 'realistic' });
    brisk.setTargets({ cloudCover01: 1 });
    realistic.setTargets({ cloudCover01: 1 });
    const b = runFor(brisk, 60).pop();
    const r = runFor(realistic, 60).pop();
    t.ok('`realistic` is slower than `brisk` (x3 on every tau)', r < b);
    t.ok(
      'an unknown speed name falls back to brisk',
      createWeatherManager({ transitionSpeed: 'nope' }).read().transitionSpeed === 'brisk'
    );
    t.ok(
      'the speed table is a closed list',
      Object.hasOwn(TRANSITION_SPEEDS, 'brisk') && TRANSITION_SPEEDS.instant === 0
    );
  }

  // ---- frame-rate independence -------------------------------------------------
  // The same wall-clock elapsed time must land in the same place regardless of
  // how it was chopped up, or weather would run at a different speed on a fast
  // machine than a slow one.
  {
    const fast = createWeatherManager();
    const slow = createWeatherManager();
    fast.setTargets({ cloudCover01: 1 });
    slow.setTargets({ cloudCover01: 1 });
    const a = runFor(fast, 60, 1 / 240).pop();
    const b = runFor(slow, 60, 1 / 30).pop();
    t.ok('60s at 240fps and 60s at 30fps agree to 3 decimals', Math.abs(a - b) < 1e-3);
  }

  // ---- tick hygiene -------------------------------------------------------------
  {
    const mgr = createWeatherManager();
    mgr.setTargets({ cloudCover01: 1 });
    const before = mgr.read().state.cloudCover01;
    mgr.tick(0);
    mgr.tick(-5);
    mgr.tick(Number.NaN);
    mgr.tick(undefined);
    t.ok('a zero/negative/NaN/absent delta advances nothing', mgr.read().state.cloudCover01 === before);
  }

  // ---- jumpTo: scene load, no ease ---------------------------------------------
  {
    const mgr = createWeatherManager();
    const r = mgr.jumpTo({ cloudCover01: 0.8, cloudAltitudePx: 3000 });
    t.ok('jumpTo lands the state immediately', r.state.cloudCover01 === 0.8);
    t.ok('...and the target with it, so nothing eases back', r.targets.cloudCover01 === 0.8);
    t.ok('...on every axis given', r.state.cloudAltitudePx === 3000);
    t.ok('...and reports settled', r.settling === false);
  }

  // ---- setTargets: clamping, closed list, honest rejection ----------------------
  {
    const mgr = createWeatherManager();
    const res = mgr.setTargets({ cloudCover01: 5, notAnAxis: 1, cloudType01: -3 });
    t.ok('out-of-range values clamp to the axis range', mgr.read().targets.cloudCover01 === 1);
    t.ok('...at the low end too', mgr.read().targets.cloudType01 === 0);
    t.ok('an unknown axis name is REPORTED, not silently dropped', res.rejected.includes('notAnAxis'));
    t.ok('...and the real axes still applied', res.applied.includes('cloudCover01'));

    const junk = createWeatherManager();
    junk.setTargets({ cloudCover01: 'overcast please' });
    t.ok('a non-numeric value falls back to the axis default, not NaN', junk.read().targets.cloudCover01 === 0);

    const partial = createWeatherManager({ initial: { cloudCover01: 'broken', cloudAltitudePx: 2200 } });
    t.ok(
      'one corrupt stored field cannot discard the rest of an authored sky',
      partial.read().state.cloudCover01 === 0 && partial.read().state.cloudAltitudePx === 2200
    );
  }

  // ---- version semantics: intent, not motion ------------------------------------
  {
    const mgr = createWeatherManager();
    const v0 = mgr.read().version;
    mgr.setTargets({ cloudCover01: 1 });
    const v1 = mgr.read().version;
    t.ok('a target change bumps the version', v1 === v0 + 1);

    runFor(mgr, 30);
    t.ok('⭐ easing does NOT bump it — a cache key must survive the transition', mgr.read().version === v1);

    mgr.setTargets({ cloudCover01: 1 });
    t.ok('re-setting the SAME target is not a change', mgr.read().version === v1);

    mgr.applyArchetype('overcast');
    t.ok('applying an archetype bumps it', mgr.read().version === v1 + 1);
    t.ok('...and the label reaches the snapshot', mgr.toSnapshotWeather().preset === 'overcast');
    t.ok('ownerVersion mirrors it', mgr.toSnapshotWeather().ownerVersion === mgr.read().version);
  }

  // ---- LAW 1 / slice-1 scope: almanac is refused, loudly -------------------------
  {
    const mgr = createWeatherManager();
    t.ok(
      'both modes are named in the closed list',
      WEATHER_MODES.includes('director') && WEATHER_MODES.includes('almanac')
    );
    t.ok('setMode(almanac) is REFUSED while the walk is unbuilt', mgr.setMode('almanac') === false);
    t.ok('...and the mode genuinely did not change', mgr.read().mode === 'director');
    t.ok('setMode(director) is accepted', mgr.setMode('director') === true);
    t.ok(
      'an unknown mode falls back to director rather than inventing a third',
      createWeatherManager({ mode: 'chaos' }).read().mode === 'director'
    );
    t.ok('the status report says the walk is not built', mgr.getStatus().almanacBuilt === false);
  }

  // ---- freezing: nobody scribbles on the manager's state -------------------------
  {
    const mgr = createWeatherManager();
    const r = mgr.read();
    t.ok('read() is frozen', Object.isFrozen(r));
    t.ok('...including both halves', Object.isFrozen(r.state) && Object.isFrozen(r.targets));
    t.ok('toSnapshotWeather() is frozen', Object.isFrozen(mgr.toSnapshotWeather()));
    t.ok('getStatus() is frozen', Object.isFrozen(mgr.getStatus()));

    // A caller mutating the returned copy must not reach the manager's own state.
    const copy = { ...r.state };
    copy.cloudCover01 = 0.99;
    t.ok('the returned state is a COPY, not the live object', mgr.read().state.cloudCover01 === 0);
  }

  // ---- read() exposes intent AND reality separately -------------------------------
  // The UI shows the target (so a slider responds instantly); consumers read the
  // state (so the sky eases). Conflating them is how a control feels broken.
  {
    const mgr = createWeatherManager();
    mgr.setTargets({ cloudCover01: 1 });
    mgr.tick(1 / 60);
    const r = mgr.read();
    t.ok('target is the GM intent, immediately', r.targets.cloudCover01 === 1);
    t.ok('state is where the sky actually is, still climbing', r.state.cloudCover01 > 0 && r.state.cloudCover01 < 1);
    t.ok('settling reports the difference', r.settling === true);
    t.ok(
      'the snapshot carries the EASED value, not the target',
      mgr.toSnapshotWeather().cloudCover01 === r.state.cloudCover01
    );
  }

  // ---- destructured methods still work (no `this` dependency) ---------------------
  {
    const mgr = createWeatherManager();
    const { tick, setTargets, read } = mgr;
    setTargets({ cloudCover01: 1 });
    tick(1 / 60);
    t.ok('tick/setTargets/read survive being destructured off the manager', read().state.cloudCover01 > 0);
  }

  // ---- easeToward, directly --------------------------------------------------------
  {
    t.ok('tau <= 0 snaps', easeToward(0, 1, 0, 0.016, 1e-4) === 1);
    t.ok('a non-positive dt does nothing', easeToward(0.5, 1, 10, 0, 1e-4) === 0.5);
    t.ok(
      'a step lands strictly between current and target',
      (() => {
        const v = easeToward(0, 1, 10, 1, 1e-4);
        return v > 0 && v < 1;
      })()
    );
    t.ok('within epsilon snaps exactly', easeToward(0.99999, 1, 10, 1, 1e-3) === 1);
    t.ok(
      'it works downward too',
      (() => {
        const v = easeToward(1, 0, 10, 1, 1e-4);
        return v < 1 && v > 0;
      })()
    );
  }

  // ---- clampAxis ---------------------------------------------------------------------
  {
    t.ok('clamps to the declared max', clampAxis('cloudAltitudePx', 999999) === WEATHER_AXES.cloudAltitudePx.max);
    t.ok('clamps to the declared min', clampAxis('cloudAltitudePx', -10) === WEATHER_AXES.cloudAltitudePx.min);
    t.ok('an unknown axis returns 0 rather than throwing', clampAxis('nope', 1) === 0);
    t.ok(
      'undefined falls back to the axis default',
      clampAxis('cloudType01', undefined) === WEATHER_AXES.cloudType01.fallback
    );
  }
}
