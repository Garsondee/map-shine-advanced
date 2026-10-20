/**
 * fire-billow-state.test.mjs — THE LONG LIFE OF A FIRE.
 *
 * Rain puts an outdoor fire out, the coals smoulder, the ash goes cold, and after a long dry spell it relights, very slowly:
 *
 *     burning -> out -> dead -> rekindle -> burning
 *
 * That is STATE (rain from ten minutes ago is why a fire is out now), so it is pinned here as a time series, in the author's
 * own terms: it must take a real downpour to put a fire out, a drizzle must not; a put-out fire must stay out for a LONG
 * time and only come back while it is dry; an indoor fire must never be touched; an immune one must never go out.
 */
import { stepFireLife, newFireLife, createFireLifeBook, FIRE_LIFE } from '../fire-billow-state.js';

/**
 * Step a life through `seconds` of constant weather at `dt`. `stepFireLife` clamps its own dt to 0.25 s (a hidden tab must
 * not jump a fire a minute ahead), so a test that stepped by more would silently run slow: refuse it.
 */
function advance(state, seconds, w, life, dt = 0.25) {
  if (dt > 0.25)
    throw new Error(
      'advance: dt must be <= 0.25 s (stepFireLife clamps it, and the test would run slower than it says)'
    );
  const n = Math.round(seconds / dt);
  let t = 0;
  const phases = [];
  for (let i = 0; i < n; i++) {
    t += dt;
    stepFireLife(state, dt, { ...w, timeSec: t }, life);
    if (phases.at(-1) !== state.phase) phases.push(state.phase);
  }
  return phases;
}

export function run(t) {
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  // ── A NEW FIRE BURNS; WEATHER IT CANNOT FEEL DOES NOTHING ────────────────────────────────────────────────────
  {
    const s = newFireLife();
    t.ok(
      'a new fire is burning, dry, at full vitality and full coals',
      s.phase === 'burning' && s.wet === 0 && s.vitality === 1 && s.coal === 1
    );
    advance(s, 600, { rain01: 0 });
    t.ok('ten dry minutes change nothing', s.phase === 'burning' && s.vitality === 1 && s.wet === 0);
    // an indoor fire: rain01 is the SKY-gated number, so it is 0 whatever the weather outside
    const indoor = newFireLife();
    advance(indoor, 3600, { rain01: 0 });
    t.ok(
      'an indoor fire (no sky, so no rain reaches it) burns for an hour untouched',
      indoor.phase === 'burning' && indoor.vitality === 1
    );
  }

  // ── A DRIZZLE SHRINKS THE FLAME WHILE IT LASTS AND IT RECOVERS; IT DOES NOT PUT IT OUT ─────────────────────────
  {
    const s = newFireLife();
    advance(s, 40, { rain01: 0.3 });
    t.ok(
      `a light drizzle wets the fire but nowhere near out (wet ${s.wet.toFixed(2)})`,
      s.phase === 'burning' && s.wet > 0.2 && s.wet < 0.5
    );
    advance(s, 600, { rain01: 0 });
    t.ok(
      'and once it stops the fire dries and is back to full',
      s.phase === 'burning' && s.wet === 0 && s.vitality > 0.97
    );
    // a few drops never wet it at all: the fire dries as fast as they land (the break-even is about 11% rain)
    const drops = newFireLife();
    advance(drops, 600, { rain01: 0.08 });
    t.ok(
      'a few drops (8% rain) never wet a fire at all: it dries as fast as they land',
      drops.wet === 0 && drops.vitality === 1
    );
    // but a steady light rain does get there in the end: this is "rain strongly affects outdoor flames"
    const steady = newFireLife();
    const steadyPhases = advance(steady, 400, { rain01: 0.3 });
    t.ok(
      `a steady light rain (30%) puts a fire out in the end (${steadyPhases.join(' -> ')})`,
      steadyPhases.includes('out')
    );
  }

  // ── A DOWNPOUR SOAKS IT AND PUTS IT OUT, IN ORDER ──────────────────────────────────────────────────────────────
  {
    const s = newFireLife();
    const phases = advance(s, FIRE_LIFE.douseSec * 3, { rain01: 1 });
    t.ok(`sustained heavy rain puts a fire out (${phases.join(' -> ')})`, phases.includes('out') && s.vitality === 0);
    t.ok(
      'the flame goes down well before the fire is out: vitality is falling while it is still "burning"',
      (() => {
        const probe = newFireLife();
        let sawDimBurning = false;
        for (let i = 0; i < 4000; i++) {
          stepFireLife(probe, 0.25, { rain01: 1 });
          if (probe.phase === 'burning' && probe.vitality < 0.5) sawDimBurning = true;
        }
        return sawDimBurning;
      })()
    );
    // it takes LONGER at half the rain (the douse time is for full rain)
    const timeToOut = (rain) => {
      const p = newFireLife();
      let sec = 0;
      while (p.phase === 'burning' && sec < 4000) {
        stepFireLife(p, 0.25, { rain01: rain });
        sec += 0.25;
      }
      return sec;
    };
    const full = timeToOut(1);
    const half = timeToOut(0.5);
    t.ok(
      `half the rain takes about twice as long (${full.toFixed(0)} s vs ${half.toFixed(0)} s)`,
      half > full * 1.7 && half < full * 2.6
    );
    t.ok(
      `full rain puts it out in about the douse time (${full.toFixed(0)} s vs ${FIRE_LIFE.douseSec} s)`,
      full > FIRE_LIFE.douseSec * 0.9 && full < FIRE_LIFE.douseSec * 2.6
    );
  }

  // ── THE AUTHOR'S DIALS: rain response scales it; an immune fire never goes out ─────────────────────────────────
  {
    const fast = newFireLife();
    const slow = newFireLife();
    advance(fast, 30, { rain01: 0.6, rainResponse: 2 });
    advance(slow, 30, { rain01: 0.6, rainResponse: 0.5 });
    t.ok('"Rain response" scales how fast rain soaks a fire', fast.wet > slow.wet * 3);
    const deaf = newFireLife();
    advance(deaf, 600, { rain01: 1, rainResponse: 0 });
    t.ok('rain response 0 makes the fire deaf to rain', deaf.phase === 'burning' && deaf.wet === 0);
    const immune = newFireLife();
    const phases = advance(immune, 1800, { rain01: 1, snuffable: false });
    t.ok(
      `a fire that cannot be snuffed never goes out, and keeps a floor of flame (${immune.vitality.toFixed(2)})`,
      !phases.includes('out') && immune.vitality >= FIRE_LIFE.immuneFloor - 1e-9
    );
    const custom = newFireLife();
    advance(custom, 20, { rain01: 1 }, { douseSec: 5 });
    t.ok('the douse time is an author dial', custom.phase === 'out' || custom.vitality < 0.1);
  }

  // ── PUT OUT: THE COALS SMOULDER, RAIN HISSES THEM OUT FASTER, THE ASH GOES COLD ────────────────────────────────
  {
    // soak a fire until it goes out, and look at what is left the moment it does
    const putOut = (rain = 1) => {
      const s = newFireLife();
      for (let i = 0; i < 4000 && s.phase === 'burning'; i++) stepFireLife(s, 0.25, { rain01: rain });
      return s;
    };
    const s = putOut();
    t.ok(
      'the moment the rain puts a fire out the flame is gone but the coals are still hot',
      s.phase === 'out' && s.vitality === 0 && s.coal > 0.9
    );
    // dry weather: the coals fade over the smoulder time. Rain hisses them out up to 4x faster.
    const dry = putOut();
    const wet = putOut();
    const dry0 = dry.coal;
    const wet0 = wet.coal;
    advance(dry, 20, { rain01: 0 });
    advance(wet, 20, { rain01: 1 });
    const dryLoss = dry0 - dry.coal;
    const wetLoss = wet0 - wet.coal;
    t.ok(
      `rain hisses the coals out faster (${wetLoss.toFixed(3)} vs ${dryLoss.toFixed(3)} lost in 20 s)`,
      dryLoss > 0.05 && wetLoss > dryLoss * 3
    );
    const phases = advance(dry, FIRE_LIFE.smoulderSec * 2, { rain01: 0 });
    t.ok(
      'the coals cool to cold ash over the smoulder time',
      phases.includes('dead') && dry.coal === 0 && dry.vitality === 0
    );
    t.ok(
      'and a fire the rain keeps hissing is dead in well under half the smoulder time',
      (() => {
        const w = putOut();
        let sec = 0;
        while (w.phase === 'out' && sec < 1000) {
          stepFireLife(w, 0.25, { rain01: 1 });
          sec += 0.25;
        }
        return sec < FIRE_LIFE.smoulderSec * 0.5;
      })()
    );
  }

  // ── A FIRE THAT WAS ONLY ALMOST OUT CATCHES AGAIN; ONE THAT WAS SOAKED STAYS OUT ──────────────────────────────
  {
    // knocked right down by a short, hard burst, then the rain stops: the wood is still hot
    const near_ = newFireLife();
    near_.wet = 0.9;
    near_.vitality = 0.05;
    advance(near_, 300, { rain01: 0 });
    t.ok(
      'a fire that was nearly out (never soaked through) recovers once the rain stops',
      near_.phase === 'burning' && near_.vitality > 0.95
    );
    // soaked and out: the wood is wet through, so even in dry weather it does NOT catch again at once
    const soaked = newFireLife();
    advance(soaked, 150, { rain01: 1 });
    const phases = advance(soaked, 400, { rain01: 0 });
    t.ok(
      `a fire the rain put out stays out through the dry spell that follows (${phases.join(' -> ')})`,
      !phases.includes('burning') || phases.indexOf('dead') < phases.indexOf('burning')
    );
  }

  // ── DEAD: A LONG TIME, COUNTED ONLY WHILE IT IS DRY ────────────────────────────────────────────────────────────
  {
    const s = newFireLife();
    s.phase = 'dead';
    s.wet = 0;
    s.coal = 0;
    s.vitality = 0;
    s.clock = 0;
    advance(s, FIRE_LIFE.rekindleDelaySec * 0.9, { rain01: 0 });
    t.ok(
      'a dead fire is still dead at 90% of the relight delay',
      s.phase === 'dead' && s.vitality === 0 && s.coal === 0
    );
    // rain resets the wait
    advance(s, 60, { rain01: 0.6 });
    t.ok('rain on a dead fire resets the wait', s.phase === 'dead' && s.clock < 1);
    advance(s, FIRE_LIFE.rekindleDelaySec * 0.9, { rain01: 0 });
    t.ok('and it is still dead 90% of a delay later (the wet fire has to dry first)', s.phase === 'dead');
    const phases = advance(s, FIRE_LIFE.rekindleDelaySec * 0.5, { rain01: 0 });
    t.ok('after a full dry delay it starts to come back', phases.includes('rekindle'));
  }

  // ── THE COMEBACK IS SLOW: GLINTS, THEN THE COALS, THEN THE FLAME COUGHS UP ────────────────────────────────────
  {
    const s = newFireLife();
    s.phase = 'rekindle';
    s.vitality = 0;
    s.coal = 0;
    s.wet = 0;
    s.clock = 0;
    const R = FIRE_LIFE.rekindleRampSec;
    const sample = (frac) => {
      advance(s, R * frac, { rain01: 0, seed: 5 });
      return { coal: s.coal, v: s.vitality, phase: s.phase };
    };
    const early = sample(0.15);
    const mid = sample(0.35);
    const late = sample(0.4);
    t.ok(
      `early in the comeback only the coals stir; there is no flame yet (coal ${early.coal.toFixed(2)}, flame ${early.v.toFixed(2)})`,
      early.v < 0.05 && early.coal > 0 && early.coal < 0.8
    );
    t.ok('the coals come up before the flame does', mid.coal > early.coal && mid.v < mid.coal);
    t.ok('late in the comeback the flame is climbing', late.v > mid.v || late.phase === 'rekindle');
    const done = sample(0.5);
    t.ok('the comeback ends with a burning fire', done.phase === 'burning');
    // rain during the comeback relapses it
    const r2 = newFireLife();
    r2.phase = 'rekindle';
    r2.coal = 0.4;
    r2.vitality = 0.1;
    r2.wet = 0;
    r2.clock = 10;
    advance(r2, 5, { rain01: 0.8 });
    t.ok('rain during the comeback puts it back out', r2.phase === 'out' || r2.phase === 'dead');
  }

  // ── ROBUSTNESS ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const s = newFireLife();
    stepFireLife(s, 60, { rain01: 1 }); // a hidden tab hands the frame a minute
    t.ok('a huge dt is clamped (a hidden tab must not jump a fire a minute ahead)', s.wet < 0.05);
    stepFireLife(s, NaN, { rain01: NaN, rainResponse: NaN });
    stepFireLife(s, -5, {});
    t.ok('NaN and negative inputs never poison the state', [s.wet, s.vitality, s.coal, s.clock].every(Number.isFinite));
    const a = newFireLife();
    const b = newFireLife();
    advance(a, 400, { rain01: 0.7, seed: 3 });
    advance(b, 400, { rain01: 0.7, seed: 3 });
    t.ok('the life is deterministic', near(a.wet, b.wet, 1e-12) && a.phase === b.phase && near(a.coal, b.coal, 1e-12));
  }

  // ── THE BOOK ──────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const book = createFireLifeBook();
    t.ok('an empty book has no lives', book.size() === 0 && book.get('x') === undefined);
    book.step('a', 0.25, { rain01: 1 });
    book.step('b', 0.25, { rain01: 0 });
    t.ok('each fire id gets its own life', book.size() === 2 && book.get('a').wet > 0 && book.get('b').wet === 0);
    book.set('a', { vitality: 0.3, phase: 'out' });
    t.ok(
      'a life can be forced (the lab, tests, a future "light this fire" action)',
      book.get('a').vitality === 0.3 && book.get('a').phase === 'out'
    );
    book.set('new', { coal: 0.5 });
    t.ok(
      'forcing an unknown id creates it burning',
      book.get('new').phase === 'burning' && book.get('new').coal === 0.5
    );
    // what getFireStatus() shows, so a fire's fate can be read live in the real viewer
    const snap = book.snapshot();
    t.ok(
      'the snapshot lists every life as plain rounded numbers',
      snap.length === 3 &&
        snap.every((s) => typeof s.id === 'string' && typeof s.phase === 'string') &&
        snap.find((s) => s.id === 'a').vitality === 0.3 &&
        snap.every((s) =>
          [s.wet, s.vitality, s.coal].every(
            (v) => Number.isFinite(v) && Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6
          )
        )
    );
    t.ok('and is capped', book.snapshot(2).length === 2 && book.snapshot(0).length === 0);
    book.reset();
    t.ok('reset forgets everything', book.size() === 0 && book.snapshot().length === 0);
  }

  // ── A GALE PUTS A FIRE OUT, AND RAIN IN A GALE FASTER (2026-10-20, round 3) ──────────────────────────────────────
  {
    const secondsToOut = (w, cap = 900) => {
      const s = newFireLife();
      for (let t = 0; t < cap; t += 0.25) {
        stepFireLife(s, 0.25, w);
        if (s.phase === 'out') return t;
      }
      return Infinity;
    };
    const wind = secondsToOut({ wind01: 1 });
    const rain = secondsToOut({ rain01: 1 });
    const both = secondsToOut({ rain01: 1, wind01: 1 });
    t.ok(
      `a hurricane on an exposed fire puts it out (${wind.toFixed(0)} s), about as fast as steady rain does (${rain.toFixed(0)} s)`,
      Number.isFinite(wind) && wind < 3 * FIRE_LIFE.douseSec && Math.abs(wind - rain) < 2 * FIRE_LIFE.douseSec
    );
    t.ok(
      `rain driven by a gale puts it out much faster (${both.toFixed(0)} s)`,
      both < 0.6 * rain && both < 0.6 * wind
    );
    t.ok(
      'no wind and no rain never does',
      secondsToOut({}, 600) === Infinity && secondsToOut({ wind01: 0 }, 600) === Infinity
    );
    t.ok(
      'a fire that cannot be snuffed is not put out by wind',
      secondsToOut({ wind01: 1, snuffable: false }, 600) === Infinity
    );
    const s = newFireLife();
    for (let i = 0; i < 4 * 200; i++) stepFireLife(s, 0.25, { wind01: 1 });
    for (let i = 0; i < 4 * 60; i++) stepFireLife(s, 0.25, { wind01: 0 });
    t.ok(
      'and it stays out once the wind drops (a gale-snuffed fire is out, it does not flare back at once)',
      s.phase !== 'burning'
    );
  }

  // ── RAIN HISSES THE COALS OUT IN SECONDS (round 5) ───────────────────────────────────────────────────────────────
  {
    const coalGone = (rain) => {
      const s = newFireLife();
      s.phase = 'out';
      s.vitality = 0;
      s.coal = 1;
      let i = 0;
      for (; i < 4 * 400 && s.phase === 'out'; i++) stepFireLife(s, 0.25, { rain01: rain });
      return i * 0.25;
    };
    const rained = coalGone(1);
    t.ok(`full rain puts the coals out within ~6 s (${rained.toFixed(1)} s)`, rained < 6);
    t.ok(
      `a drizzle is slower but still far faster than dry air (${coalGone(0.15).toFixed(0)} s)`,
      coalGone(0.15) < 0.25 * FIRE_LIFE.smoulderSec
    );
  }
}
