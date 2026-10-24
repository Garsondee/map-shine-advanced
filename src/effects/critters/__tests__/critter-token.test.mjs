/**
 * `nearestTokenSlots` turns a live token snapshot into the fixed-size, distance-ranked slot list
 * the GPU uniforms carry. Pure — no THREE, no GPU.
 */
import { nearestTokenSlots, TOKEN_SLOTS, TOKEN_SLOT_FAR } from '../critter-token.js';

const tok = (x, y, extra = {}) => ({ x, y, elevation: 0, disposition: 0, hidden: false, radiusPx: 20, ...extra });

export function run(t) {
  // ---- empty input: every slot is the far sentinel, never undefined/NaN -----------------------
  {
    const slots = nearestTokenSlots([], { x: 0, y: 0 });
    t.ok('always returns exactly TOKEN_SLOTS entries', slots.length === TOKEN_SLOTS);
    t.ok(
      'every empty slot is the far sentinel',
      slots.every((s) => s.x === TOKEN_SLOT_FAR && s.y === TOKEN_SLOT_FAR)
    );
  }

  // ---- nearest-first ordering -------------------------------------------------------------------
  {
    const points = [tok(500, 0), tok(50, 0), tok(200, 0)];
    const slots = nearestTokenSlots(points, { x: 0, y: 0 });
    t.ok('the closest token fills slot 0', slots[0].x === 50);
    t.ok('then the next closest', slots[1].x === 200);
    t.ok('then the farthest', slots[2].x === 500);
    t.ok('remaining slots are the far sentinel', slots[3].x === TOKEN_SLOT_FAR);
  }

  // ---- hidden tokens never occupy a slot ---------------------------------------------------------
  {
    const points = [tok(10, 0, { hidden: true }), tok(400, 0)];
    const slots = nearestTokenSlots(points, { x: 0, y: 0 });
    t.ok('a hidden token (even though nearer) is excluded', slots[0].x === 400);
  }

  // ---- more tokens than slots: only the nearest maxCount survive, farthest dropped --------------
  {
    const points = Array.from({ length: TOKEN_SLOTS + 4 }, (_, i) => tok(i * 10, 0));
    const slots = nearestTokenSlots(points, { x: 0, y: 0 });
    t.ok('capped at TOKEN_SLOTS', slots.length === TOKEN_SLOTS);
    t.ok(
      'the nearest ones win (farthest dropped, not an arbitrary subset)',
      slots[0].x === 0 && slots[TOKEN_SLOTS - 1].x === (TOKEN_SLOTS - 1) * 10
    );
  }

  // ---- distance is measured from the supplied centre, not always the origin ----------------------
  {
    const points = [tok(100, 100), tok(0, 0)];
    const slots = nearestTokenSlots(points, { x: 100, y: 100 });
    t.ok('the token AT the centre wins, not the one at the origin', slots[0].x === 100 && slots[0].y === 100);
  }

  // ---- malformed points are skipped rather than corrupting the slot list -------------------------
  {
    const points = [null, { x: NaN, y: 0 }, tok(5, 5), undefined];
    const slots = nearestTokenSlots(points, { x: 0, y: 0 });
    t.ok('garbage entries are filtered, the one real point still lands', slots[0].x === 5 && slots[0].y === 5);
  }

  // ---- a custom maxCount is honoured --------------------------------------------------------------
  {
    const points = [tok(1, 0), tok(2, 0), tok(3, 0)];
    const slots = nearestTokenSlots(points, { x: 0, y: 0 }, 2);
    t.ok('maxCount shrinks the slot list', slots.length === 2);
  }
}
