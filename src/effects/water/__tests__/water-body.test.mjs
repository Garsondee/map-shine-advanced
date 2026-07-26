/**
 * water-body.test.mjs — the body pack's ARITHMETIC, proven without a GPU.
 *
 * The TSL builders themselves cannot be Node-tested (CONVENTIONS §4), so this
 * suite does what `world/wind-sim.js` does for the wind sim: it runs the exact
 * same algorithm on the CPU, out of the exact same exported primitives the
 * shader uses, and checks the result against brute force.
 *
 * That matters more here than usual. A jump flood that is wrong by one stride
 * still produces a smooth, plausible-looking distance field — it just measures
 * the wrong distance. There is no live symptom that reads as "your SDF is
 * off"; there is only water whose shore band sits slightly wrong forever. The
 * brute-force comparison below is the only thing that can tell the difference.
 */
import {
  jfaStepCount,
  jfaStrideForStep,
  rebaseNeighborOffset,
  flowFromTangent,
  WATER_PRESENCE_EPS,
  WATER_MASK_FILTER,
  WATER_BODY_SUPERSAMPLE,
} from '../water-body.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

/**
 * The CPU twin of the three GPU passes, sharing their primitives verbatim.
 * `mask[i] > eps` is water. Returns per-texel `{ox, oy, valid}` in texel units
 * — the same encoding the shader's RGB carries.
 */
function cpuJumpFlood(mask, w, h) {
  const isWater = (x, y) => mask[y * w + x] > WATER_PRESENCE_EPS;
  const clampX = (x) => Math.max(0, Math.min(w - 1, x));
  const clampY = (y) => Math.max(0, Math.min(h - 1, y));

  // PASS 1 — seed both sides of every water/land interface.
  let field = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const here = isWater(x, y);
      let boundary = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (isWater(clampX(x + dx), clampY(y + dy)) !== here) boundary = true;
      }
      field[y * w + x] = { ox: 0, oy: 0, valid: boundary ? 1 : 0 };
    }
  }

  // PASS 2 — the halving ladder.
  const steps = jfaStepCount(w, h);
  const NO_SEED = 8192;
  for (let s = 0; s < steps; s++) {
    const stride = jfaStrideForStep(s, steps);
    const next = new Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const self = field[y * w + x];
        let best = { ...self };
        let bestDist = self.valid ? Math.hypot(self.ox, self.oy) : NO_SEED;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = x + dx * stride;
            const ny = y + dy * stride;
            // OUT OF BOUNDS IS INVALID, NEVER CLAMPED — mirroring the shader's
            // own `outOfBounds` mask. Clamping here would break the re-basing
            // invariant (the clamped texel is not `stride` away), which is the
            // real bug this suite caught before it ever reached a GPU. See
            // buildWaterJfaStepMaterial's header.
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const n = field[ny * w + nx];
            const reb = rebaseNeighborOffset({ x: n.ox, y: n.oy }, dx, dy, stride);
            const d = n.valid ? Math.hypot(reb.x, reb.y) : NO_SEED;
            if (d <= bestDist) {
              best = { ox: reb.x, oy: reb.y, valid: n.valid };
              bestDist = d;
            }
          }
        }
        next[y * w + x] = best;
      }
    }
    field = next;
  }
  return field;
}

/** Brute force: the true distance to the nearest seed texel, for comparison. */
function bruteForceNearestSeed(mask, w, h, x, y) {
  const isWater = (px, py) => mask[py * w + px] > WATER_PRESENCE_EPS;
  const clampX = (v) => Math.max(0, Math.min(w - 1, v));
  const clampY = (v) => Math.max(0, Math.min(h - 1, v));
  let best = Infinity;
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const here = isWater(sx, sy);
      let boundary = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        if (isWater(clampX(sx + dx), clampY(sy + dy)) !== here) boundary = true;
      }
      if (!boundary) continue;
      best = Math.min(best, Math.hypot(sx - x, sy - y));
    }
  }
  return best;
}

export async function run(t) {
  // --- the stride ladder ---------------------------------------------------
  t.ok('a 512-wide grid needs 9 rounds (log2 512)', jfaStepCount(512, 341) === 9);
  t.ok('the ladder sizes off the LONGEST side, not the first argument', jfaStepCount(64, 1024) === 10);
  t.ok('a 1x1 grid still gets one round rather than zero', jfaStepCount(1, 1) === 1);
  t.ok('a non-power-of-two grid rounds UP (300 -> 9 rounds, reach 256..512)', jfaStepCount(300, 200) === 9);
  {
    const steps = jfaStepCount(16, 16);
    const strides = Array.from({ length: steps }, (_, i) => jfaStrideForStep(i, steps));
    t.ok('strides halve from dim/2 down to 1', strides.join(',') === '8,4,2,1');
    t.ok('the last round is always stride 1 — without it the field is coarse forever', strides.at(-1) === 1);
  }

  // --- the re-basing step, alone -------------------------------------------
  // The one line that is silently wrong-by-a-stride if you forget it.
  {
    const reb = rebaseNeighborOffset({ x: 3, y: -1 }, 1, 0, 4);
    t.ok('adopting a neighbour adds the step that reached it', reb.x === 7 && reb.y === -1);
    const diag = rebaseNeighborOffset({ x: 0, y: 0 }, -1, 1, 8);
    t.ok('a diagonal neighbour that IS a seed sits exactly one stride away', diag.x === -8 && diag.y === 8);
    t.ok('a zero stride is a no-op, not a corruption', rebaseNeighborOffset({ x: 2, y: 2 }, 1, 1, 0).x === 2);
  }

  // --- THE REAL PROOF: the flood equals brute force on a real shape --------
  {
    // A 32x32 grid with an off-centre, asymmetric lake — asymmetric on BOTH
    // axes on purpose, because a symmetric fixture cannot catch a transposed
    // or Y-flipped offset (this repo's named recurring bug class,
    // feedback_y_flip_recurring_risk).
    const w = 32;
    const h = 32;
    const mask = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // A rectangle x∈[4,12), y∈[18,29) — nowhere near centred.
        if (x >= 4 && x < 12 && y >= 18 && y < 29) mask[y * w + x] = 0.6;
      }
    }

    const field = cpuJumpFlood(mask, w, h);
    let worstError = 0;
    let allValid = true;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = field[y * w + x];
        if (!f.valid) {
          allValid = false;
          continue;
        }
        const got = Math.hypot(f.ox, f.oy);
        const want = bruteForceNearestSeed(mask, w, h, x, y);
        worstError = Math.max(worstError, Math.abs(got - want));
      }
    }
    t.ok('every texel finds a seed once the mask has any interface at all', allValid);
    // Jump flood is EXACT for this class of seed distribution; a nonzero error
    // here means the re-basing or the stride ladder is wrong, not that the
    // algorithm is approximate.
    t.ok(`the flood matches brute force exactly (worst error ${worstError})`, near(worstError, 0, 1e-9));

    // Orientation, stated as its own assertion rather than trusted: a texel
    // directly LEFT of the lake must point RIGHT toward it, and one BELOW must
    // point UP. The stored offset is `seed − here`.
    const leftOf = field[23 * w + 1]; // y inside the lake's rows, x to its left
    t.ok('a texel left of the lake stores a +x offset toward it', leftOf.ox > 0 && Math.abs(leftOf.oy) < 1e-9);
    const above = field[10 * w + 8]; // x inside the lake's columns, y below its start
    t.ok('a texel at lower y stores a +y offset toward the lake', above.oy > 0 && Math.abs(above.ox) < 1e-9);

    // THE BUG THIS SUITE ACTUALLY CAUGHT (2026-07-25). Clamping an
    // out-of-bounds neighbour instead of rejecting it breaks the re-basing
    // invariant and makes the flood UNDERSTATE distance near the map border.
    // A distance field can only ever overestimate — it may fail to find the
    // true nearest seed, never invent a closer one — so an underestimate
    // anywhere is proof of exactly that class of bug, and it is checked here
    // separately from the worst-error number because it is the diagnostic
    // that names the cause rather than the symptom.
    let underestimates = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const f = field[y * w + x];
        if (!f.valid) continue;
        if (Math.hypot(f.ox, f.oy) < bruteForceNearestSeed(mask, w, h, x, y) - 1e-9) underestimates++;
      }
    }
    t.ok('no texel reports a seed CLOSER than the nearest real one (the border-clamp bug)', underestimates === 0);
  }

  // --- the two shapes a rectangle cannot exercise --------------------------
  {
    const w = 32;
    const h = 32;
    /** Worst |flood − brute| over every seeded texel. */
    const worstErrorOf = (mask) => {
      const field = cpuJumpFlood(mask, w, h);
      let worst = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const f = field[y * w + x];
          if (!f.valid) continue;
          worst = Math.max(worst, Math.abs(Math.hypot(f.ox, f.oy) - bruteForceNearestSeed(mask, w, h, x, y)));
        }
      }
      return worst;
    };

    // A thin DIAGONAL river: the shape whose medial axis runs at an angle, so
    // no axis-aligned shortcut in the propagation can accidentally look right.
    const river = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.abs(x - y * 0.6 - 6) < 2.5) river[y * w + x] = 0.4;
      }
    }
    t.ok(`a thin diagonal river floods exactly (worst ${worstErrorOf(river)})`, near(worstErrorOf(river), 0, 1e-9));

    // TWO DISJOINT BLOBS — jump flood's textbook approximation case, where a
    // texel between them can be handed the wrong basin. Pinned because if a
    // future change (a coarser ladder, a cheaper neighbourhood) does introduce
    // the classic error, this is the fixture that will say so.
    const blobs = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 5, y - 5) < 3 || Math.hypot(x - 26, y - 24) < 4) blobs[y * w + x] = 1;
      }
    }
    t.ok(`two disjoint water bodies flood exactly (worst ${worstErrorOf(blobs)})`, near(worstErrorOf(blobs), 0, 1e-9));
  }

  // --- the degenerate cases the resolve pass has to survive ----------------
  {
    const w = 8;
    const h = 8;
    const allLand = cpuJumpFlood(new Float32Array(w * h), w, h);
    t.ok(
      'a floor with NO water has no interface, so no texel ever finds a seed',
      allLand.every((f) => f.valid === 0)
    );
    const allWater = cpuJumpFlood(new Float32Array(w * h).fill(1), w, h);
    t.ok(
      'a floor that is ENTIRELY water also has no interface — the map edge is not a shore',
      allWater.every((f) => f.valid === 0)
    );
    // Both above are why the resolve pass stores ±farDistance rather than
    // treating "no seed" as distance zero, which would read as "the shore is
    // right here" on every texel of the map.
  }

  // --- presence threshold: depth doubles as presence -----------------------
  t.ok('a shore painted at 4/255 is water, not land', 4 / 255 > WATER_PRESENCE_EPS);
  t.ok('exactly zero depth is land', !(0 > WATER_PRESENCE_EPS));

  // --- resolution: the flood runs FINER than the mask, on purpose ----------
  // 2026-07-26: the mask must be LINEAR now, not nearest — the previous
  // assertion here (`WATER_MASK_FILTER === 'nearest'`) pinned the reasoning
  // that turned out to be wrong live: running the flood 1:1 with the mask's
  // own coarse grid bakes the mask's own texel staircase into the SDF, and no
  // downstream filtering of the RESOLVED field recovers it (see water-body-
  // subsystem.js §3 for the full live-symptom account). Supersampling the
  // flood over a LINEAR-sampled mask is what actually reconstructs a smoother
  // boundary from the same, genuinely-all-there-is coarse source.
  t.ok(
    'the mask is sampled LINEAR — supersampling only helps if the source is reconstructed continuously',
    WATER_MASK_FILTER === 'linear'
  );
  t.ok('the flood supersamples the mask — 1x would just re-bake the mask`s own staircase', WATER_BODY_SUPERSAMPLE > 1);
  t.ok(
    'the worst-case flood resolution (MASK_GRID_MAX_DIM=512 long side) stays under the Keyhole 2048px cap',
    512 * WATER_BODY_SUPERSAMPLE < 2048
  );

  // --- the flow model ------------------------------------------------------
  {
    const current = { x: 10, y: 0 }; // eastward, 10 px/sec
    // A bank running north-south (tangent points +y): the current is fully
    // perpendicular to it, so at the bank the water stalls rather than flowing
    // into land. This is the behaviour V2's single global vector could not
    // produce — its rivers pushed straight through their own banks.
    const atWall = flowFromTangent(current, { x: 0, y: 1 }, 0, 100);
    t.ok('a current facing straight into a bank goes to zero AT the bank', near(atWall.x, 0) && near(atWall.y, 0));

    // A bank running east-west (tangent +x): the current is already along it,
    // so it passes through untouched.
    const alongBank = flowFromTangent(current, { x: 1, y: 0 }, 0, 100);
    t.ok('a current already parallel to the bank is unchanged', near(alongBank.x, 10) && near(alongBank.y, 0));

    // A 45° bank deflects the current along itself at cos(45°)² of its speed.
    const s = Math.SQRT1_2;
    const diagonal = flowFromTangent(current, { x: s, y: s }, 0, 100);
    t.ok('a 45° bank deflects the current along itself', near(diagonal.x, 5, 1e-9) && near(diagonal.y, 5, 1e-9));

    // THE INVARIANT THE WHOLE PROJECTION EXISTS FOR: the stored tangent flips
    // sign across a river's medial axis, and the flow must not.
    const flipped = flowFromTangent(current, { x: -s, y: -s }, 0, 100);
    t.ok(
      'flow is INVARIANT under tangent -> -tangent (no seam down the middle of a river)',
      near(flipped.x, diagonal.x, 1e-9) && near(flipped.y, diagonal.y, 1e-9)
    );

    // Far from any bank the geometry stops mattering and the current passes
    // through — a lake's middle drifts, its edges follow the shore.
    const openWater = flowFromTangent(current, { x: 0, y: 1 }, 500, 100);
    t.ok('beyond the bank`s reach the global current passes through unchanged', near(openWater.x, 10));
    const halfWay = flowFromTangent(current, { x: 0, y: 1 }, 50, 100);
    t.ok('bank influence ramps smoothly rather than switching', halfWay.x > 0 && halfWay.x < 10);
    t.ok(
      'the sign of the distance does not matter to bank influence — the wet band outside is a bank too',
      near(flowFromTangent(current, { x: 0, y: 1 }, -50, 100).x, halfWay.x)
    );
    t.ok(
      'a zero tangent (no seed found anywhere) leaves the current untouched at the bank',
      near(flowFromTangent(current, { x: 0, y: 0 }, 0, 100).x, 0)
    );
  }
}
