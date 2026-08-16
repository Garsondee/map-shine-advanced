/**
 * THE ALMANAC'S WALK, end to end through the manager
 * (docs/planning/Weather-Manager.md §5.2-§5.4).
 *
 * `weather.test.mjs` covers the ease engine and Director mode; `weather-data`/
 * `weather-biomes`/`weather-rng` cover their own tables and primitives in
 * isolation. This file is the integration: does `tick()` actually walk the
 * graph, do pins actually protect an axis, is the forecast actually free, and
 * — the two properties that matter most for "a realistic set of states" —
 * does a long run stay ON the graph and roughly match its own occupancy table.
 */
import { createWeatherManager, WEATHER_AXES } from '../weather.js';
import { WEATHER_BIOMES, biomeNodeIds } from '../weather-biomes.js';

const DESERT = WEATHER_BIOMES.find((b) => b.id === 'desert');
const TEMPERATE = WEATHER_BIOMES.find((b) => b.id === 'temperate-coast');

/** Advance `mgr` by `hours` of game time in `stepHours`-sized chunks. */
function walkHours(mgr, hours, stepHours = 0.25, hourOfDay = 12) {
  const steps = Math.round(hours / stepHours);
  for (let i = 0; i < steps; i++) {
    mgr.tick(1 / 60, { dtGameHours: stepHours, hour: hourOfDay });
  }
}

export function run(t) {
  // ---- setBiome: fail-open, resets the walk's own node/dwell ---------------------
  {
    const mgr = createWeatherManager({ mode: 'almanac' });
    const ok = mgr.setBiome('desert');
    t.ok('a known biome resolves', ok.ok === true && ok.biomeId === 'desert');
    t.ok('...and is reported in getStatus', mgr.getStatus().almanac.biomeId === 'desert');

    const bad = mgr.setBiome('atlantis');
    t.ok('an unknown biome fails open — clears the biome, never storm-locks', bad.ok === false && bad.biomeId === null);
    t.ok('...and the manager genuinely has no biome now', mgr.getStatus().almanac.biomeId === null);

    mgr.setBiome('desert');
    mgr.tick(1 / 60, { dtGameHours: 5, hour: 12 });
    t.ok('the walk actually started (a node was chosen)', mgr.getStatus().almanac.currentNodeId !== null);
    mgr.setBiome(null);
    t.ok('explicitly clearing the biome clears the walk node too', mgr.getStatus().almanac.currentNodeId === null);
  }

  // ---- setVolatility: clamped, sane default ---------------------------------------
  {
    const mgr = createWeatherManager();
    t.ok('default volatility is 1', mgr.getStatus().almanac.volatility === 1);
    t.ok('clamps to the max', mgr.setVolatility(999) === 4);
    t.ok('clamps to the min', mgr.setVolatility(-5) === 0.25);
    t.ok('a garbage value falls back to 1, not NaN', mgr.setVolatility('fast') === 1);
    t.ok('a real value in range passes through', mgr.setVolatility(2) === 2);
  }

  // ---- tick() only walks with EVERYTHING present: mode, biome, dtGameHours -------
  {
    const director = createWeatherManager({ mode: 'director', biome: 'desert' });
    director.tick(1 / 60, { dtGameHours: 100, hour: 12 });
    t.ok(
      'director mode never walks, even with a biome and game-time given',
      director.getStatus().almanac.currentNodeId === null
    );

    const noBiome = createWeatherManager({ mode: 'almanac' });
    noBiome.tick(1 / 60, { dtGameHours: 100, hour: 12 });
    t.ok(
      'almanac mode with NO biome stays idle — a legitimate state, not a bug',
      noBiome.getStatus().almanac.currentNodeId === null
    );

    const noGameTime = createWeatherManager({ mode: 'almanac', biome: 'desert' });
    noGameTime.tick(1 / 60); // no second argument at all
    t.ok(
      'a caller that never passes almanacInputs never advances the walk',
      noGameTime.getStatus().almanac.currentNodeId === null
    );

    const zeroGameTime = createWeatherManager({ mode: 'almanac', biome: 'desert' });
    zeroGameTime.tick(1 / 60, { hour: 12 }); // dtGameHours absent
    t.ok(
      'dtGameHours absent is the same as zero — no advance',
      zeroGameTime.getStatus().almanac.currentNodeId === null
    );

    const real = createWeatherManager({ mode: 'almanac', biome: 'desert' });
    real.tick(1 / 60, { dtGameHours: 1, hour: 12 });
    t.ok(
      '⭐ mode + biome + real game time together actually start the walk',
      real.getStatus().almanac.currentNodeId !== null
    );
  }

  // ---- ⭐ frozen clock => frozen weather (the paused-session guarantee) -----------
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'desert', seed: 'freeze-test' });
    mgr.tick(1 / 60, { dtGameHours: 1, hour: 12 });
    const nodeAfterStart = mgr.getStatus().almanac.currentNodeId;
    const dwellAfterStart = mgr.getStatus().almanac.dwellRemainingHours;
    for (let i = 0; i < 500; i++) mgr.tick(1 / 60, { dtGameHours: 0, hour: 12 }); // paused: real frames, zero game time
    t.ok(
      '500 real-time frames at dtGameHours=0 move the walk NOT AT ALL',
      mgr.getStatus().almanac.currentNodeId === nodeAfterStart &&
        mgr.getStatus().almanac.dwellRemainingHours === dwellAfterStart
    );
  }

  // ---- negative/backward game time still counts DOWN, not up ---------------------
  {
    const fwd = createWeatherManager({ mode: 'almanac', biome: 'desert', seed: 'sign-test' });
    fwd.tick(1 / 60, { dtGameHours: 3, hour: 12 });
    const dwellAfterFwd = fwd.getStatus().almanac.dwellRemainingHours;

    const bwd = createWeatherManager({ mode: 'almanac', biome: 'desert', seed: 'sign-test' });
    bwd.tick(1 / 60, { dtGameHours: 3, hour: 12 }); // same start
    const before = bwd.getStatus().almanac.dwellRemainingHours;
    bwd.tick(1 / 60, { dtGameHours: -1, hour: 12 }); // time running backward
    t.ok(
      'a negative dtGameHours still advances the dwell countdown (by magnitude)',
      bwd.getStatus().almanac.dwellRemainingHours < before
    );
    t.ok(
      '...matching what +1 would have done',
      Math.abs(bwd.getStatus().almanac.dwellRemainingHours - (before - 1)) < 1e-9
    );
    t.ok('(sanity: the forward run actually consumed dwell too)', dwellAfterFwd < FALLBACK_MAX_ANY_DWELL());
  }
  function FALLBACK_MAX_ANY_DWELL() {
    return 100; // generous — no dwell in the table exceeds this
  }

  // ---- ⭐ pins: a GM's hand survives the walk ---------------------------------------
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'desert', seed: 'pin-test' });
    mgr.tick(1 / 60, { dtGameHours: 1, hour: 12 });
    const before = mgr.setTargets({ cloudScalePx: 3333 }); // a value no desert row uses
    t.ok('setTargets in almanac mode pins the touched axis', before.pinnedAxes.includes('cloudScalePx'));
    t.ok('...and it is visible on read()', mgr.read().pinnedAxes.includes('cloudScalePx'));

    // Force many transitions — a pinned axis must survive every one of them.
    walkHours(mgr, 400, 2);
    t.ok('⭐ the pinned axis never moved across 400 game-hours of walking', mgr.read().targets.cloudScalePx === 3333);
    t.ok('...while OTHER axes are free to keep changing', mgr.getStatus().almanac.currentNodeId !== null);

    t.ok('unpinAxis releases it', mgr.unpinAxis('cloudScalePx') === true);
    t.ok('...and it is gone from the pin list', !mgr.read().pinnedAxes.includes('cloudScalePx'));
    t.ok('unpinning something not pinned reports false, not a throw', mgr.unpinAxis('cloudScalePx') === false);
    t.ok('unpinning a fake axis name is safe', mgr.unpinAxis('not-an-axis') === false);

    mgr.setTargets({ cloudCover01: 0.5, cloudType01: 0.5 });
    t.ok('unpinAllAxes releases everything at once', mgr.unpinAllAxes() === 2);
    t.ok('...and reports 0 the second time', mgr.unpinAllAxes() === 0);
    t.ok('...and the read-back list is empty', mgr.read().pinnedAxes.length === 0);

    t.ok(
      'pinAxis pins without touching the value',
      (() => {
        const m2 = createWeatherManager({ mode: 'almanac' });
        const before2 = m2.read().targets.cloudCover01;
        const ok = m2.pinAxis('cloudCover01');
        return (
          ok === true && m2.read().targets.cloudCover01 === before2 && m2.read().pinnedAxes.includes('cloudCover01')
        );
      })()
    );
    t.ok('pinAxis on a fake name returns false', createWeatherManager().pinAxis('nope') === false);
  }

  // ---- applyArchetype in almanac mode: the walk ADOPTS the click ------------------
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'desert', seed: 'adopt-test' });
    mgr.setTargets({ cloudScalePx: 4242 }); // pin something first
    t.ok('a pin exists before the click', mgr.read().pinnedAxes.length > 0);

    const res = mgr.applyArchetype('thunderstorm');
    t.ok('the click succeeds', res.ok === true && res.preset === 'thunderstorm');
    t.ok('⭐ it clears every pin — a full override has nothing left to protect', mgr.read().pinnedAxes.length === 0);
    t.ok('the walk ADOPTS it as the current graph node', mgr.getStatus().almanac.currentNodeId === 'thunderstorm');
    t.ok('...with a freshly drawn dwell', mgr.getStatus().almanac.dwellRemainingHours > 0);

    // A director-mode click must not touch almanac bookkeeping it isn't using.
    const director = createWeatherManager({ mode: 'director' });
    director.applyArchetype('overcast');
    t.ok(
      'director-mode clicks leave almanac.currentNodeId untouched (null)',
      director.getStatus().almanac.currentNodeId === null
    );
  }

  // ---- ⭐ the forecast is free: it never touches live state ------------------------
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'temperate-coast', seed: 'forecast-test' });
    mgr.tick(1 / 60, { dtGameHours: 1, hour: 8 });
    const liveBefore = mgr.getStatus().almanac;

    const f1 = mgr.forecast(48, { hour: 9 });
    t.ok('a real forecast is available', f1.available === true);
    t.ok('...and returns at least one projected transition over 48h', f1.transitions.length > 0);

    const liveAfter = mgr.getStatus().almanac;
    t.ok('⭐ the live node did not move', liveAfter.currentNodeId === liveBefore.currentNodeId);
    t.ok('⭐ the live dwell did not move', liveAfter.dwellRemainingHours === liveBefore.dwellRemainingHours);
    t.ok(
      '⭐ the live seed/rng state did not move (same forecast, called again, is IDENTICAL)',
      JSON.stringify(mgr.forecast(48, { hour: 9 })) === JSON.stringify(f1)
    );

    // Every projected id must be a real, reachable node in the active biome.
    t.ok(
      'every forecast entry names a real archetype in the biome graph',
      f1.transitions.every((tr) => biomeNodeIds(TEMPERATE).includes(tr.archetypeId))
    );
    t.ok(
      'timestamps are non-negative and non-decreasing',
      f1.transitions.every(
        (tr, i) =>
          tr.atGameHoursFromNow >= 0 && (i === 0 || tr.atGameHoursFromNow >= f1.transitions[i - 1].atGameHoursFromNow)
      )
    );
  }

  // ---- forecast: honestly empty, not fabricated ------------------------------------
  {
    const director = createWeatherManager({ mode: 'director', biome: 'desert' });
    const r1 = director.forecast(24);
    t.ok('director mode: unavailable, and says why', r1.available === false && r1.reason === 'not in almanac mode');

    const noBiome = createWeatherManager({ mode: 'almanac' });
    const r2 = noBiome.forecast(24);
    t.ok('no biome: unavailable, and says why', r2.available === false && r2.reason === 'no biome selected');

    const mgr = createWeatherManager({ mode: 'almanac', biome: 'desert' });
    const r3 = mgr.forecast(0);
    t.ok('a zero horizon: unavailable', r3.available === false && r3.reason === 'non-positive horizon');
    const r4 = mgr.forecast(-5);
    t.ok('a negative horizon: unavailable, not a crash', r4.available === false);
  }

  // ---- ⭐⭐ determinism: the WHOLE manager, not just the RNG underneath -------------
  {
    const a = createWeatherManager({ mode: 'almanac', biome: 'tropical-monsoon', seed: 'determinism-42' });
    const b = createWeatherManager({ mode: 'almanac', biome: 'tropical-monsoon', seed: 'determinism-42' });
    const traceA = [];
    const traceB = [];
    for (let i = 0; i < 300; i++) {
      a.tick(1 / 60, { dtGameHours: 0.5, hour: (i * 0.5) % 24 });
      b.tick(1 / 60, { dtGameHours: 0.5, hour: (i * 0.5) % 24 });
      traceA.push(a.getStatus().almanac.currentNodeId);
      traceB.push(b.getStatus().almanac.currentNodeId);
    }
    t.ok(
      'two managers, same seed, same biome, same tick sequence -> IDENTICAL walk trace',
      traceA.every((v, i) => v === traceB[i])
    );
    t.ok('...and the trace is not trivially constant (it actually walked)', new Set(traceA).size > 1);

    const c = createWeatherManager({ mode: 'almanac', biome: 'tropical-monsoon', seed: 'determinism-43' });
    const traceC = [];
    for (let i = 0; i < 300; i++) {
      c.tick(1 / 60, { dtGameHours: 0.5, hour: (i * 0.5) % 24 });
      traceC.push(c.getStatus().almanac.currentNodeId);
    }
    t.ok(
      'a different seed produces a genuinely different trace',
      traceC.some((v, i) => v !== traceA[i])
    );
  }

  // ---- ⭐⭐ a long walk stays ON THE GRAPH — every transition is a real edge --------
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'desert', seed: 'graph-fidelity' });
    const seenTransitions = [];
    let lastNode = null;
    for (let i = 0; i < 4000; i++) {
      mgr.tick(1 / 60, { dtGameHours: 0.25, hour: (i * 0.25) % 24 });
      const node = mgr.getStatus().almanac.currentNodeId;
      if (node !== null && lastNode !== null && node !== lastNode) {
        seenTransitions.push([lastNode, node]);
      }
      lastNode = node;
    }
    t.ok('the walk actually made real transitions over the run', seenTransitions.length > 5);
    t.ok(
      '⭐ every single transition made exists as a real edge in the desert graph',
      seenTransitions.every(([from, to]) => DESERT.transitions.some((e) => e.from === from && e.to === to))
    );
  }

  // ---- occupancy roughly follows archetypeWeights over a long run -----------------
  // Not exact (the graph's own structure biases dwell as much as the starting
  // weights do), but the two heaviest-weighted states should still visibly
  // dominate a long desert run — 'clear' at 0.72 should be the majority state.
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'desert', seed: 'occupancy-check' });
    const counts = {};
    const stepHours = 1;
    const totalSteps = 3000;
    for (let i = 0; i < totalSteps; i++) {
      mgr.tick(1 / 60, { dtGameHours: stepHours, hour: (i * stepHours) % 24 });
      const node = mgr.getStatus().almanac.currentNodeId;
      if (node) counts[node] = (counts[node] ?? 0) + 1;
    }
    const clearShare = (counts.clear ?? 0) / totalSteps;
    t.ok(
      `desert's dominant weighted state ('clear', weight 0.72) is the majority tick-count (got ${(clearShare * 100).toFixed(1)}%)`,
      clearShare > 0.5
    );
  }

  // ---- ⭐ clamps bind everything: shadowfell-verge's gloom floor holds -------------
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'shadowfell-verge', seed: 'gloom-test' });
    walkHours(mgr, 200, 2);
    t.ok(
      'after real walking, cover never dropped below the biome clamp',
      mgr.read().targets.cloudCover01 >= 0.6 - 1e-9
    );

    // Even a GM's OWN direct attempt to force it lower is clamped — "clamps
    // bind everything" includes a stubborn slider, not just the walk's picks.
    mgr.setTargets({ cloudCover01: 0 });
    t.ok('a direct GM slider drag to 0 is clamped up to the biome floor', mgr.read().targets.cloudCover01 === 0.6);

    // The SAME clamp must not leak into a different biome/mode.
    const elsewhere = createWeatherManager({ mode: 'almanac', biome: 'desert' });
    elsewhere.setTargets({ cloudCover01: 0 });
    t.ok('a biome with no clamp on this axis allows 0 normally', elsewhere.read().targets.cloudCover01 === 0);
    const director = createWeatherManager({ mode: 'director' });
    director.setTargets({ cloudCover01: 0 });
    t.ok('director mode never reads a biome clamp at all', director.read().targets.cloudCover01 === 0);
  }

  // ---- setSeed: reseeds future draws without teleporting the current sky ----------
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'tropical-monsoon', seed: 'before' });
    mgr.tick(1 / 60, { dtGameHours: 1, hour: 10 });
    const nodeBeforeReseed = mgr.getStatus().almanac.currentNodeId;
    const dwellBeforeReseed = mgr.getStatus().almanac.dwellRemainingHours;
    mgr.setSeed('after');
    t.ok('reseeding does not itself move the current node', mgr.getStatus().almanac.currentNodeId === nodeBeforeReseed);
    t.ok('...or the current dwell', mgr.getStatus().almanac.dwellRemainingHours === dwellBeforeReseed);
    t.ok('the seed is reported back', mgr.getStatus().almanac.seed === 'after');

    // But it DOES change the future: two managers reseeded to the same new
    // value from different histories should converge on the same future walk
    // from this point, since the RNG (not history) drives the graph search.
    const other = createWeatherManager({ mode: 'almanac', biome: 'tropical-monsoon', seed: 'irrelevant-start' });
    other.tick(1 / 60, { dtGameHours: 7, hour: 3 }); // a totally different history
    other.setSeed('after');
    // Force both onto the SAME current node/dwell so only the RNG differs from here.
    other.applyArchetype(nodeBeforeReseed, { immediate: true });
    mgr.applyArchetype(nodeBeforeReseed, { immediate: true }); // also resets both dwells via the same call
    const traceMgr = [];
    const traceOther = [];
    for (let i = 0; i < 100; i++) {
      mgr.tick(1 / 60, { dtGameHours: 0.5, hour: (i * 0.5) % 24 });
      other.tick(1 / 60, { dtGameHours: 0.5, hour: (i * 0.5) % 24 });
      traceMgr.push(mgr.getStatus().almanac.currentNodeId);
      traceOther.push(other.getStatus().almanac.currentNodeId);
    }
    t.ok(
      'same seed from the same node, different prior histories -> the SAME future',
      traceMgr.every((v, i) => v === traceOther[i])
    );
  }

  // ---- read()/getStatus() report the almanac block honestly -----------------------
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'high-mountain', volatility: 2, seed: 'status-check' });
    const status = mgr.getStatus();
    t.ok('biomeId reported', status.almanac.biomeId === 'high-mountain');
    t.ok('volatility reported', status.almanac.volatility === 2);
    t.ok('seed reported', status.almanac.seed === 'status-check');
    t.ok('a fresh manager has no current node yet (walk not started)', status.almanac.currentNodeId === null);
    t.ok(
      'read() and getStatus() agree on pinned axes',
      JSON.stringify(mgr.read().pinnedAxes) === JSON.stringify(status.almanac.pinnedAxes)
    );
  }

  // ---- toSnapshotWeather is unaffected by almanac internals -----------------------
  // The env snapshot shape must not grow almanac-only fields — consumers read
  // AXES (LAW 2), and diagnostics are a completely separate door (getStatus).
  {
    const mgr = createWeatherManager({ mode: 'almanac', biome: 'desert' });
    mgr.tick(1 / 60, { dtGameHours: 1, hour: 12 });
    const w = mgr.toSnapshotWeather();
    // ⚠️ `precipKind`/`precipMixWeight`/`precipKindAuthored` are DERIVED
    // fields, not almanac internals — they are the one thing consumers cannot
    // compute themselves without re-implementing the sleet band, which is
    // exactly the duplication Weather-Manager.md §2.2's "one derivation, one
    // place" rule forbids. They are listed explicitly rather than the check
    // being loosened to a subset, so this assertion still fails loudly the day
    // an ALMANAC field tries to sneak into the snapshot.
    const expectedKeys = [
      ...Object.keys(WEATHER_AXES),
      'preset',
      'hasOwner',
      'ownerVersion',
      'precipKind',
      'precipMixWeight',
      'precipKindAuthored',
    ];
    t.ok(
      'the snapshot shape is exactly the axes + preset + owner + derived-precip fields, nothing almanac-shaped',
      Object.keys(w).sort().join(',') === expectedKeys.sort().join(',')
    );
  }
}
