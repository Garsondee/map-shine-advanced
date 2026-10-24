/**
 * `deriveTokenMotion` turns two position snapshots into speed; `buildTrampleStamps` turns moving
 * tokens into the mantle's stamp queue. Both pure — no Foundry, no GPU.
 */
import {
  deriveTokenMotion,
  buildTrampleStamps,
  MOVING_THRESHOLD_PX_PER_SEC,
  MAX_TRAMPLE_STAMPS,
} from '../token-activity.js';

const point = (id, x, y, extra = {}) => ({
  id,
  x,
  y,
  elevation: 0,
  disposition: 0,
  hidden: false,
  radiusPx: 20,
  ...extra,
});

export function run(t) {
  // ---- first sample: nothing to diff against -------------------------------------------------------
  {
    const { motion, nextById } = deriveTokenMotion(new Map(), [point('a', 100, 100)], 0.25);
    t.ok('a token seen for the first time has zero speed', motion[0].speedPxPerSec === 0);
    t.ok('…and reads as not moving', motion[0].isMoving === false);
    t.ok('its position is remembered for next time', nextById.get('a')?.x === 100 && nextById.get('a').y === 100);
  }

  // ---- a real walk -----------------------------------------------------------------------------------
  {
    const prev = new Map([['a', { x: 0, y: 0 }]]);
    // 100px in 0.5s = 200px/s, well above the deadzone.
    const { motion } = deriveTokenMotion(prev, [point('a', 100, 0)], 0.5);
    t.ok('speed is distance / dt', Math.abs(motion[0].speedPxPerSec - 200) < 1e-9);
    t.ok('a real walk reads as moving', motion[0].isMoving === true);
  }

  // ---- sub-pixel jitter must not register as motion -------------------------------------------------
  {
    const prev = new Map([['a', { x: 100, y: 100 }]]);
    const { motion } = deriveTokenMotion(prev, [point('a', 100.01, 100)], 1);
    t.ok('jitter stays under the deadzone', motion[0].speedPxPerSec < MOVING_THRESHOLD_PX_PER_SEC);
    t.ok('…and does not read as moving', motion[0].isMoving === false);
  }

  // ---- a paused game (dtSec === 0) freezes speed, never divides by it -------------------------------
  {
    const prev = new Map([['a', { x: 0, y: 0 }]]);
    const { motion } = deriveTokenMotion(prev, [point('a', 500, 500)], 0);
    t.ok('zero elapsed time reads as zero speed, not Infinity', motion[0].speedPxPerSec === 0);
  }

  // ---- every field on the point survives the diff, not just position --------------------------------
  {
    const { motion } = deriveTokenMotion(new Map(), [point('a', 0, 0, { elevation: 40, hidden: true })], 0.1);
    t.ok('elevation carries through', motion[0].elevation === 40);
    t.ok('hidden carries through', motion[0].hidden === true);
  }

  // ---- buildTrampleStamps: only MOVING tokens contribute ---------------------------------------------
  {
    const motion = [
      { ...point('a', 10, 10), isMoving: true },
      { ...point('b', 20, 20), isMoving: false },
    ];
    const { stamps } = buildTrampleStamps(motion);
    t.ok('a still token leaves no stamp', stamps.length === 1);
    t.ok('the moving token does', stamps[0].x === 10 && stamps[0].y === 10);
  }

  // ---- radius and strength are tunable, and a zero/garbage radius still leaves a real footprint -----
  {
    const motion = [{ ...point('a', 0, 0, { radiusPx: 0 }), isMoving: true }];
    const { stamps } = buildTrampleStamps(motion, { radiusScale: 1, strength: 1.5 });
    t.ok('a zero-radius body still stamps a real (floor) radius', stamps[0].radiusPx >= 8);
    t.ok('strength passes through', stamps[0].strength === 1.5);

    const scaled = buildTrampleStamps([{ ...point('a', 0, 0, { radiusPx: 40 }), isMoving: true }], {
      radiusScale: 2,
    });
    t.ok('radiusScale multiplies the body radius', scaled.stamps[0].radiusPx === 80);
  }

  // ---- the cap matches the GPU side's fixed-size array, and overflow is reported, not swallowed -----
  {
    const many = Array.from({ length: MAX_TRAMPLE_STAMPS + 5 }, (_, i) => ({
      ...point(`t${i}`, i, i),
      isMoving: true,
    }));
    const { stamps, droppedCount } = buildTrampleStamps(many);
    t.ok('stamps never exceed the uniform array capacity', stamps.length === MAX_TRAMPLE_STAMPS);
    t.ok('the overflow is counted, not silently dropped', droppedCount === 5);
  }

  // ---- strength 0 (the GM turned disturbance off) still produces stamps, at zero depth --------------
  {
    const motion = [{ ...point('a', 0, 0), isMoving: true }];
    const { stamps } = buildTrampleStamps(motion, { strength: 0 });
    t.ok('a disabled disturbance still reports a stamp shape, just inert', stamps[0].strength === 0);
  }
}
