/**
 * Node verification for the cloud deck's drift (world/cloud-field.js, mmp-63o.31): a late frame
 * may not leap the deck, and a change of wind ramps the drift speed instead of snapping it.
 */
import {
  cloudDriftStep,
  easeCloudDriftSpeed,
  CLOUD_DRIFT_MAX_STEP_SEC,
  CLOUD_DRIFT_SPEED_TAU_SEC,
} from '../cloud-field.js';

const recipe = { driftMul: 1, turnover: 1 };
const step = (dtSec, speed) =>
  cloudDriftStep({ dtSec, windDirX: 1, windDirY: 0, windSpeedPxPerSec: speed, scalePx: 1000, recipe });

export function run(t) {
  const { ok } = t;

  ok('drift: normal frame moves speed x dt', Math.abs(step(1 / 60, 600).dx - 10) < 1e-9);
  ok(
    'drift: a 2 s stall advances at most the cap (no leap)',
    Math.abs(step(2, 1000).dx - 1000 * CLOUD_DRIFT_MAX_STEP_SEC) < 1e-9
  );
  ok('drift: cap is a tenth of a second', CLOUD_DRIFT_MAX_STEP_SEC === 0.1);
  ok('drift: zero/negative dt moves nothing', step(0, 1000).dx === 0 && step(-1, 1000).dx === 0);

  ok('ease: first frame starts at the target', easeCloudDriftSpeed(null, 500, 1 / 60) === 500);
  const one = easeCloudDriftSpeed(0, 500, 1 / 60);
  ok('ease: one frame moves only a little toward a new target', one > 0 && one < 10);
  let v = 0;
  for (let i = 0; i < 60 * CLOUD_DRIFT_SPEED_TAU_SEC; i++) v = easeCloudDriftSpeed(v, 500, 1 / 60);
  ok('ease: after one time constant it is ~63% of the way', Math.abs(v / 500 - (1 - Math.exp(-1))) < 0.01);
  ok('ease: a single late frame cannot finish the ease', easeCloudDriftSpeed(0, 500, 5) < 500 * 0.05);
  ok('ease: NaN target reads as zero', easeCloudDriftSpeed(100, NaN, 1) < 100);
}
