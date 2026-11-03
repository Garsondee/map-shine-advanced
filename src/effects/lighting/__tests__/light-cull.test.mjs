/**
 * light-cull.test.mjs — the off-screen cull of the per-light meshes (frame-rate round, 2026-11-02).
 *
 * `lightFootprintTouchesView` decides, from a mesh's FINAL transform, whether its footprint can reach the view. The
 * property that matters is one-sided: it may keep a light it could have dropped, never drop one that shows. So the
 * checks are (1) the exact edges, (2) a brute-force sweep that places the real unit-radius footprint polygon (rotated,
 * scaled, translated exactly as three would) and asserts no vertex inside the view ever sits behind a "false", and
 * (3) the wiring: the pool only culls a light that has already drawn once, and honours the kill switch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { lightFootprintTouchesView, LIGHT_CULL_MARGIN_PX, LIGHT_CULL_RADIUS_SLACK } from '../point-light-pool.js';

const mesh = (x, y, sx, sy = sx) => ({ position: { x, y }, scale: { x: sx, y: sy } });
const view = { x: 1000, y: 1000, z: 2000, w: 1800 };

/** A deterministic PRNG so the sweep is repeatable. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function run(t) {
  const { ok } = t;

  ok('a light inside the view is kept', lightFootprintTouchesView(mesh(1500, 1400, 200), view));
  ok('a light far left of the view is dropped', !lightFootprintTouchesView(mesh(100, 1400, 200), view));
  ok('a light far right of the view is dropped', !lightFootprintTouchesView(mesh(3500, 1400, 200), view));
  ok('a light far above the view is dropped', !lightFootprintTouchesView(mesh(1500, -500, 200), view));
  ok('a light far below the view is dropped', !lightFootprintTouchesView(mesh(1500, 4000, 200), view));

  const reach = 200 * LIGHT_CULL_RADIUS_SLACK + LIGHT_CULL_MARGIN_PX;
  ok(
    'a light whose reach just crosses the left edge is kept',
    lightFootprintTouchesView(mesh(1000 - reach + 1, 1400, 200), view)
  );
  ok(
    'a light whose reach just misses the left edge is dropped',
    !lightFootprintTouchesView(mesh(1000 - reach - 1, 1400, 200), view)
  );
  ok(
    'a light whose reach just crosses the bottom edge is kept',
    lightFootprintTouchesView(mesh(1500, 1800 + reach - 1, 200), view)
  );
  ok(
    'a light whose reach just misses the bottom edge is dropped',
    !lightFootprintTouchesView(mesh(1500, 1800 + reach + 1, 200), view)
  );

  // An oval (the flashlight's cookie) is bounded by its LONG axis, in either orientation.
  ok('an oval is bounded by its long axis (x long)', lightFootprintTouchesView(mesh(700, 1400, 600, 60), view));
  ok('an oval is bounded by its long axis (y long)', lightFootprintTouchesView(mesh(1500, 700, 60, 600), view));
  ok('a large light well outside is still dropped', !lightFootprintTouchesView(mesh(-4000, 1400, 600), view));
  ok('a huge light covering the whole view is kept', lightFootprintTouchesView(mesh(1500, 1400, 5000), view));

  // One-sided safety: scatter a unit-radius polygon (every vertex on or inside the unit circle) through the real
  // transform (scale, then rotate about the position, then translate) and demand that whenever ANY vertex lands inside
  // the view, the test says "touches".
  const rand = rng(7);
  let sampled = 0;
  let inView = 0;
  let violations = 0;
  for (let i = 0; i < 4000; i++) {
    const sx = 20 + rand() * 600;
    const sy = rand() < 0.3 ? 20 + rand() * 600 : sx;
    const x = -800 + rand() * 4600;
    const y = -800 + rand() * 4000;
    const rot = rand() * Math.PI * 2;
    const m = mesh(x, y, sx, sy);
    const touches = lightFootprintTouchesView(m, view);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    for (let k = 0; k < 24; k++) {
      const a = rand() * Math.PI * 2;
      const rr = Math.sqrt(rand());
      const lx = Math.cos(a) * rr * sx;
      const ly = Math.sin(a) * rr * sy;
      const wx = x + lx * c - ly * s;
      const wy = y + lx * s + ly * c;
      sampled++;
      if (wx >= view.x && wx <= view.z && wy >= view.y && wy <= view.w) {
        inView++;
        if (!touches) violations++;
      }
    }
  }
  ok(`the sweep reached the view often enough to mean something (${inView} of ${sampled} vertices)`, inView > 3000);
  ok(`no vertex that lands inside the view is ever culled (${violations} violations)`, violations === 0);

  // Wiring, read from the source (the pool builds real three meshes, so it is not constructed in Node).
  const src = readFileSync(fileURLToPath(new URL('../point-light-pool.js', import.meta.url)), 'utf8');
  ok(
    'a light is only dropped after it has drawn once',
    /entry\.hasDrawn === true &&\s*!lightFootprintTouchesView/.test(src)
  );
  ok(
    'the first frame of a light always draws (hasDrawn is set when it is not culled)',
    /else \{\s*entry\.hasDrawn = true;/.test(src)
  );
  ok('an unsized view means draw everything', /cullRect\.z > cullRect\.x && cullRect\.w > cullRect\.y/.test(src));
  ok("the kill switch is localStorage 'msa.lightCull' = '0'", /getItem\('msa\.lightCull'\) !== '0'/.test(src));
  ok(
    'the cull hides BOTH meshes of the entry',
    /entry\.mesh\.visible = false;\s*entry\.colorationMesh\.visible = false;\s*lightCullReadout\.culled/.test(src)
  );

  // The light geometry buffers must not be DYNAMIC: three's WebGPU backend re-sends a dynamic attribute on every render
  // call (`Attributes.update`, `usage === DynamicDrawUsage`), which made a still scene upload ~146 vertex buffers a frame.
  // Both writers flag `needsUpdate` when they rewrite, so static usage uploads exactly when something changed.
  const batchSrc = readFileSync(fileURLToPath(new URL('../point-light-batch-mesh.js', import.meta.url)), 'utf8');
  ok('the per-light pool sets no dynamic usage on its buffers', !/setUsage\(\s*THREE\.DynamicDrawUsage/.test(src));
  ok('the batch buckets set no dynamic usage on their buffers', !/setUsage\(\s*THREE\.DynamicDrawUsage/.test(batchSrc));
  ok(
    'the pool flags needsUpdate when it rewrites a fan and its penumbra buffer',
    /entry\.positionAttribute\.needsUpdate = true;/.test(src) && /entry\.penBuffer\.needsUpdate = true;/.test(src)
  );
  ok(
    'the bucket flags needsUpdate on a geometry or value write',
    /geometry\.attributes\[name\]\.needsUpdate = true;/.test(batchSrc)
  );
  ok(
    'the bucket skips re-triangulating a member that has not moved',
    /prev\.vertexCount !== undefined &&\s*!placementChanged\(m\.sourceId, m\)/.test(batchSrc)
  );
}
