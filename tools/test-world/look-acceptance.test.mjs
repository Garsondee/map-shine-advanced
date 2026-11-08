// Node tests for tools/test-world/look-acceptance.mjs judgeCase (mmp-ilo.3). Run by tools/run-tests.mjs.
import { judgeCase, judgeDisplay, pictureStats } from './look-acceptance.mjs';

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
  // The finished picture (mmp-ilo.3, 2026-11-08).
  const pic = { clippedPct: 0.5, crushedPct: 2, p5: 20, p95: 180 };
  const glare = { glowEnergy: 0.1, glareFraction: 0.17, glareGain: 1 };
  ok('display: a balanced picture passes', judgeDisplay(pic, glare).pass);
  ok('display: a grey-veiled picture fails as flat', !judgeDisplay({ ...pic, p5: 60, p95: 85 }, glare).pass);
  ok('display: blown highlights fail', !judgeDisplay({ ...pic, clippedPct: 5 }, glare).pass);
  ok('display: a glare veil over the budget fails', !judgeDisplay(pic, { ...glare, glowEnergy: 1 }).pass);
  ok('display: the budget gain counts', judgeDisplay(pic, { ...glare, glowEnergy: 1, glareGain: 0.1 }).pass);
  const img = {
    width: 2,
    height: 2,
    data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 128, 128, 128, 255]),
  };
  const st = pictureStats(img);
  ok('display: picture stats count clipped and crushed pixels', st.clippedPct === 25 && st.crushedPct === 25);
}
