/**
 * Node verification for foundry/smooth-pan.js — the pure parts (glide maths,
 * key direction, the drag-throttle defeat). The Foundry wiring is proven live by
 * tools/pan-smoothness/measure.mjs.
 */
import { glideStep, panKeyDirection, unthrottleDrag, KEY_GLIDE_MAX_DT_SEC } from '../smooth-pan.js';

const D = { UP: 'up', LEFT: 'left', DOWN: 'down', RIGHT: 'right', ASCEND: 'ascend', DESCEND: 'descend' };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  // ---- glide: frame-rate independent ------------------------------------------
  {
    const target = { x: 1000, y: -500 };
    const one = glideStep({ x: 0, y: 0 }, target, 0.02);
    const h1 = glideStep({ x: 0, y: 0 }, target, 0.01);
    const h2 = glideStep(h1.v, target, 0.01);
    ok('two 10 ms steps travel exactly as far as one 20 ms step', near(h1.dx + h2.dx, one.dx, 1e-9) && near(h1.dy + h2.dy, one.dy, 1e-9));
    ok('...and end at the same speed', near(h2.v.x, one.v.x, 1e-9) && near(h2.v.y, one.v.y, 1e-9));
    // 7/14/21 ms frames (an uneven 144 Hz cadence) vs even 14 ms frames over the same time
    let v = { x: 0, y: 0 };
    let uneven = 0;
    for (const ms of [7, 14, 21, 7, 14, 21, 7, 14, 21, 14]) {
      const s = glideStep(v, target, ms / 1000);
      v = s.v;
      uneven += s.dx;
    }
    v = { x: 0, y: 0 };
    let even = 0;
    for (let i = 0; i < 10; i++) {
      const s = glideStep(v, target, 0.014);
      v = s.v;
      even += s.dx;
    }
    ok('an uneven frame cadence lands where an even one does', near(uneven, even, 1e-6));
  }
  {
    let v = { x: 0, y: 0 };
    for (let i = 0; i < 200; i++) v = glideStep(v, { x: 800, y: 0 }, 1 / 144).v;
    ok('a held key reaches its target speed', near(v.x, 800, 1e-3));
    for (let i = 0; i < 200; i++) v = glideStep(v, { x: 0, y: 0 }, 1 / 144).v;
    ok('releasing eases back to rest', Math.abs(v.x) < 1e-3);
  }
  {
    const s = glideStep({ x: 0, y: 0 }, { x: 1000, y: 0 }, 5);
    const cap = glideStep({ x: 0, y: 0 }, { x: 1000, y: 0 }, KEY_GLIDE_MAX_DT_SEC);
    ok('a stalled tick integrates at most the max step (no flinging)', near(s.dx, cap.dx));
    const z = glideStep({ x: 5, y: 5 }, { x: 0, y: 0 }, 0);
    ok('a zero-time tick does not move', z.dx === 0 && z.dy === 0);
  }

  // ---- key direction (Foundry's own sums) ---------------------------------------
  ok('right', JSON.stringify(panKeyDirection(['right'], D)) === JSON.stringify({ x: 1, y: 0, zoom: false }));
  ok('up+left diagonal', JSON.stringify(panKeyDirection(new Set(['up', 'left']), D)) === JSON.stringify({ x: -1, y: -1, zoom: false }));
  ok('left+right cancel', panKeyDirection(['left', 'right'], D).x === 0);
  ok('ascend/descend hand the key back to Foundry (zoom)', panKeyDirection(['up', 'ascend'], D).zoom === true);

  // ---- the drag throttle --------------------------------------------------------
  {
    const mgr = { dragTime: 0 };
    const restore = unthrottleDrag(mgr);
    // Foundry: if ((now - this.dragTime) < this.#app.ticker.elapsedMS) return;
    const throttled = (now, elapsed) => now - mgr.dragTime < elapsed;
    ok('never throttles a 6 ms step against a 6.9 ms tick', !throttled(1006, 6.9));
    mgr.dragTime = 1006; // Foundry's own write after an accepted move
    ok("Foundry's write is ignored", !throttled(1007, 16.7));
    ok('applying twice is a no-op', unthrottleDrag(mgr) === null);
    restore();
    ok('restore puts the plain value back', mgr.dragTime === 0 && throttled(10, 16.7));
  }
  ok('no manager -> nothing to do', unthrottleDrag(null) === null);
}
