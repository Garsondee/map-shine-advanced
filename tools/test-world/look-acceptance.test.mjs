// Node tests for tools/test-world/look-acceptance.mjs judgeCase (mmp-ilo.3). Run by tools/run-tests.mjs.
import { judgeCase } from './look-acceptance.mjs';

export function run(t) {
  const { ok } = t;
  const good = { evMedian: -2, overWhiteShare: 0.01, crushedShare: 0 };
  ok('judge: a balanced noon frame passes', judgeCase(good, 'noon').pass);
  ok('judge: too dark at noon fails', !judgeCase({ ...good, evMedian: -6 }, 'noon').pass);
  ok('judge: too bright at night fails', !judgeCase({ ...good, evMedian: -1 }, 'night').pass);
  ok('judge: blown frame fails', !judgeCase({ ...good, overWhiteShare: 0.1 }, 'noon').pass);
  ok('judge: crushed frame fails', !judgeCase({ ...good, crushedShare: 0.5 }, 'night').pass);
  ok(
    'judge: missing reading fails with a reason',
    judgeCase({ evMedian: null }, 'dusk').reasons[0] === 'no meter reading'
  );
  ok(
    'judge: a dark but sane night passes',
    judgeCase({ evMedian: -6, overWhiteShare: 0, crushedShare: 0.1 }, 'night').pass
  );
}
