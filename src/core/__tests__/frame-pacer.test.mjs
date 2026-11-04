/**
 * Node verification for core/frame-pacer.js — driven by a simulated display: rAF
 * ticks on a fixed refresh, a drawn frame keeps the main thread busy for `cost`
 * refreshes (the next tick arrives that much later), a skipped frame is free.
 */
import { createFramePacer, PACER_RETRY_AFTER } from '../frame-pacer.js';

const REFRESH = 1000 / 144;

/**
 * Run `frames` ticks. `costOf(i)` = refreshes the i-th DRAWN frame occupies.
 * Returns the drawn timestamps.
 */
function simulate(pacer, frames, costOf, start = 1000) {
  let t = start;
  const drawn = [];
  for (let i = 0; i < frames; i++) {
    const yes = pacer.decide(t);
    if (yes) {
      drawn.push(t);
      t += costOf(drawn.length - 1) * REFRESH;
    } else t += REFRESH;
  }
  return { drawn, end: t };
}

const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);

export function run(t) {
  const { ok } = t;

  // ---- off: every frame, but it learns the refresh ---------------------------
  {
    const p = createFramePacer();
    const { drawn } = simulate(p, 200, () => 1);
    ok('off draws every frame', drawn.length === 200);
    ok('learns the refresh period from rAF intervals', Math.abs(p.status().refreshMs - REFRESH) < 0.01);
    ok('off is not pacing', p.isPacing() === false);
  }

  // ---- the same timestamp gets the same answer (shared by two renderers) -----
  {
    const p = createFramePacer({ mode: 2 });
    simulate(p, 50, () => 1);
    const t0 = 99999;
    const a = p.decide(t0);
    const b = p.decide(t0);
    const c = p.decide(t0);
    ok('same t -> same decision (Foundry canvas and MSA agree)', a === b && b === c);
  }

  // ---- fixed divisor: perfectly even cadence ---------------------------------
  {
    const p = createFramePacer();
    simulate(p, 60, () => 1); // learn the refresh
    p.setMode(2);
    const { drawn } = simulate(p, 200, () => 1, 50000);
    const g = gaps(drawn);
    ok(
      'divisor 2 draws every 2nd refresh',
      g.every((x) => Math.abs(x - 2 * REFRESH) < 1e-6)
    );
    ok('divisor 2 is pacing', p.isPacing());
  }
  {
    // Frames that cost 1.5 refreshes unpaced land on 1/2/1/2... refreshes: uneven.
    const p = createFramePacer();
    const { drawn } = simulate(p, 200, (i) => (i % 2 ? 2 : 1));
    const uneven = new Set(gaps(drawn).map((x) => Math.round(x / REFRESH))).size;
    p.setMode(2);
    const r = simulate(p, 200, (i) => (i % 2 ? 2 : 1), 50000);
    // (the first few drawn frames include the refresh probe's skips)
    const even = new Set(gaps(r.drawn.slice(10)).map((x) => Math.round(x / REFRESH))).size;
    ok('unpaced 1-2 refresh frames give two different on-screen times', uneven === 2);
    ok('paced at 2 they all get the same on-screen time', even === 1);
  }

  // ---- auto: seeded from unpaced costs, then adapts ---------------------------
  {
    const p = createFramePacer();
    simulate(p, 120, () => 3); // unpaced, every frame costs 3 refreshes
    p.setMode('auto');
    ok('auto probes before choosing (the refresh it learned unpaced was 3x too long)', p.status().probing);
    simulate(p, 30, () => 3, 50000);
    ok('the probe finds the real refresh period', Math.abs(p.status().refreshMs - REFRESH) < 0.01);
    ok('auto starts at the typical unpaced cost (3 refreshes)', p.status().divisor === 3);
    const { drawn } = simulate(p, 600, () => 3, 60000);
    const off = gaps(drawn).filter((x) => Math.abs(x - 3 * REFRESH) > 1e-6).length;
    // At most one frame shown a refresh longer: the periodic refresh re-probe.
    ok('auto at 3 holds an even 3-refresh cadence (one re-probe frame allowed)', off <= 1);
    ok('...and keeps the real refresh period while paced', Math.abs(p.status().refreshMs - REFRESH) < 0.01);
  }
  {
    // Seeded at 2, but frames really need 3: raises.
    const p = createFramePacer();
    simulate(p, 120, () => 2);
    p.setMode('auto');
    simulate(p, 20, () => 2, 40000);
    ok('auto seeded at 2', p.status().divisor === 2);
    simulate(p, 400, () => 3, 50000);
    ok('auto raises to 3 when a fifth of frames overrun 2', p.status().divisor === 3);
  }
  {
    // One hitch is not a trend: a rare overrun does not raise.
    const p = createFramePacer();
    simulate(p, 120, () => 2);
    p.setMode('auto');
    simulate(p, 20, () => 2, 40000);
    simulate(p, 400, (i) => (i % 25 === 0 ? 3 : 2), 50000);
    ok('a 4% overrun rate does not raise the divisor', p.status().divisor === 2);
  }
  {
    // Seeded at 3, frames are really 1 refresh: lowers, one step at a time.
    const p = createFramePacer();
    simulate(p, 120, () => 3);
    p.setMode('auto');
    simulate(p, 2000, () => 1, 50000);
    ok('auto lowers when frames fit well inside fewer refreshes', p.status().divisor === 1);
  }
  {
    // A lower divisor that fails is blocked from retrying for a long time.
    const p = createFramePacer();
    simulate(p, 120, () => 3);
    p.setMode('auto');
    // Paced at 3 frames look cheap (cost 2) -> lowers to 2; at 2 they really cost 3.
    let atTwo = false;
    const machine = () => {
      const d = p.status().divisor;
      if (d === 2) atTwo = true;
      return d === 3 ? 2 : 3;
    };
    simulate(p, 3000, machine, 50000);
    const s = p.status();
    ok('tried the lower divisor once', atTwo);
    ok('went back to 3 after it failed', s.divisor === 3);
    ok('the failed divisor is blocked from an immediate retry', s.lowerBlockedFor > PACER_RETRY_AFTER / 2);
    ok('the block names the divisor that failed', s.blockedDivisor === 2);
  }
  {
    // The block covers only the divisor that failed: a burst that pushes 3 -> 4
    // must still come back down to 3 (measured live: stuck at 4 for minutes).
    const p = createFramePacer();
    simulate(p, 120, () => 3);
    p.setMode('auto');
    let phase = 'cheapAt3';
    let tried2 = false;
    const machine = () => {
      const d = p.status().divisor;
      if (phase === 'cheapAt3') {
        if (d === 2) tried2 = true;
        if (tried2 && d === 3) phase = 'burst';
        return d === 2 ? 3 : 2; // 2 fails, 3 holds
      }
      if (phase === 'burst') {
        if (d === 4) phase = 'calm';
        return 4;
      }
      return d === 2 ? 3 : 2;
    };
    simulate(p, 6000, machine, 50000);
    ok(
      'after a burst raised it to 4, it comes back to 3 while 2 stays blocked',
      phase === 'calm' && p.status().divisor === 3
    );
  }

  // ---- what the governor reads ------------------------------------------------
  {
    const p = createFramePacer();
    simulate(p, 100, () => 1);
    p.setMode(3);
    simulate(p, 100, () => 2, 50000);
    ok('lastCostMs is the drawn frame cost, not the paced gap', Math.abs(p.lastCostMs() - 2 * REFRESH) < 1e-6);
  }
  {
    const p = createFramePacer({ mode: 2 });
    ok('a non-finite timestamp is always drawn (never stalls a manual render)', p.decide(NaN) === true);
    ok("an unknown mode string falls back to 'off'", p.setMode('sideways') === 'off');
    ok("'2' from the settings select is divisor 2", p.setMode('2') === 2);
  }
}
