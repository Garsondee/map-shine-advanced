/**
 * The compute spike's VERDICT is pure and Node-tested — the GPU dispatch it
 * judges is browser-only, but an instrument that miscalls its own result is worse
 * than none (memory: feedback_instruments_must_not_lie). These prove it tells
 * "compute worked" apart from "never wrote" apart from "ran wrong".
 */
import { classifySpikeResult, expectedSpikeValue, SPIKE_COUNT } from '../compute-spike.js';

const correct = (n) => Array.from({ length: n }, (_, i) => expectedSpikeValue(i));

export function run(t) {
  // ---- the formula is non-trivial (not identity, not zero) -----------------
  t.ok('expectedSpikeValue(0) is 1, not 0 — zero can never look like success', expectedSpikeValue(0) === 1);
  t.ok('expectedSpikeValue is i*2+1', expectedSpikeValue(5) === 11 && expectedSpikeValue(7) === 15);
  t.ok('SPIKE_COUNT is a sane small count', SPIKE_COUNT > 0 && SPIKE_COUNT <= 64);

  // ---- success is only success when EVERY slot is right --------------------
  {
    const r = classifySpikeResult(correct(SPIKE_COUNT), SPIKE_COUNT);
    t.ok('all-correct values verdict is compute-works', r.ok === true && r.verdict === 'compute-works');
  }

  // ---- a kernel that never ran (all zero) is NOT "wrong maths" -------------
  {
    const r = classifySpikeResult(new Array(SPIKE_COUNT).fill(0), SPIKE_COUNT);
    t.ok('all-zero is flagged no-write, not compute-works', r.ok === false && r.verdict === 'no-write');
  }

  // ---- ran, but wrong: distinct from no-write, and it shows a sample -------
  {
    const vals = correct(SPIKE_COUNT);
    vals[3] = 999; // one slot off
    const r = classifySpikeResult(vals, SPIKE_COUNT);
    t.ok('one wrong slot is wrong-values (kernel ran, result off)', r.ok === false && r.verdict === 'wrong-values');
    t.ok(
      'wrong-values carries a sample naming the offending slot',
      Array.isArray(r.sample) && r.sample[0].slot === 3 && r.sample[0].got === 999
    );
  }

  // ---- a partial pattern (stride/padding) is wrong-values, not no-write ----
  {
    // e.g. only every 4th slot written — reads as "ran but off", which is the
    // honest read (it did run), and the sample reveals the stride.
    const vals = new Array(SPIKE_COUNT).fill(0);
    vals[0] = expectedSpikeValue(0);
    const r = classifySpikeResult(vals, SPIKE_COUNT);
    t.ok('a partial write is wrong-values (some non-zero), not no-write', r.verdict === 'wrong-values');
  }

  // ---- unreadable is its own verdict, never mistaken for a value result ----
  {
    t.ok('a short read is unreadable', classifySpikeResult([1, 3], SPIKE_COUNT).verdict === 'unreadable');
    t.ok('a non-array is unreadable', classifySpikeResult(null, SPIKE_COUNT).verdict === 'unreadable');
  }
}
