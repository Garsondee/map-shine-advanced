/**
 * THE TRANSIENT SIM — Wind.md Tier 2: "doors opening causing movement... an
 * emergent draft, ~1 second, then gone." Everything in this file is PURE
 * (no THREE, no Foundry, no TSL) — the same split Tier 1's `wind-bake.js`
 * established: grid/vector math is Node-tested here; the GPU port that
 * actually runs per-frame lives in `world/wind-sim-gpu.js` (TSL, browser-
 * verified only, CONVENTIONS §4).
 *
 * ============================================================================
 * WHY A CPU REFERENCE STEP EXISTS AT ALL, GIVEN THE REAL SIM RUNS ON GPU
 * ============================================================================
 * Tier 1's own load-bearing lesson (`world/wind-bake.js`'s header): a
 * plausible-looking relaxation can Node-test green on hand-derived assertions
 * and still be structurally wrong — the bug was only caught by printing REAL
 * NUMBERS from a throwaway debug script and reading them. That lesson applies
 * doubly hard here, because the GPU port (TSL, ping-ponged render targets)
 * cannot be Node-tested or even print-debugged without a live Foundry
 * session, and this session has none. `stepWindSimReference` below (composed
 * from four separately-testable stage functions, mirroring Wind.md §3's own
 * ADVECT/SPLAT/RELAX/DISSIPATE order exactly) is therefore not a toy: it is
 * the verified SPEC the TSL port is a direct, line-by-line translation of.
 * Where the two must ever be compared, this is the one that was actually
 * run, with real printed numbers, in this session (see wind-sim.test.mjs).
 *
 * ============================================================================
 * WHY RELAX HERE IS DELIBERATELY NARROWER THAN TIER 1'S BAKE USED TO BE
 * ============================================================================
 * ⚠ STALE AS OF 2026-07-22 (THE RETHINK, docs/planning/Wind-Rethink.md) —
 * Tier 1's `bakeWindStructure` (referenced throughout this section) is
 * DELETED; `D_rest` no longer exists, and `world/wind-field.js#sampleWind`'s
 * `bakedField` texture now always carries ZERO in the R/G channels this
 * file's own advect pass (`world/wind-sim-gpu.js`) reads as `restD`. This
 * whole file (D_live, the transient door-gust sim) was explicitly OUT OF
 * SCOPE for the rethink and is UNCHANGED — it still compiles and runs — but
 * the paragraph below's claim that "the redirect-toward-a-gap job is already
 * solved before this file's relax ever runs" is no longer true: there is no
 * more D_rest doing that job. A puff now advects along `A + D_live` only,
 * with no steady structure bending it around corners first. This may or may
 * not visibly matter (D_live is a brief, local transient, not the ambient
 * flow), but it is an honest gap, not a verified-fine one — if Tier 2 is
 * ever revisited, start here.
 *
 * Tier 1's `bakeWindStructure` (now deleted) proved that a DIRECT two-axis
 * velocity relaxation cannot REDIRECT flow toward a distant gap — only a
 * coupled scalar-potential relaxation can, because vx/vy never exchange
 * information under a per-axis reflect. That is a real, permanent finding,
 * but it applied to a DIFFERENT job than this file's relax step performs.
 * Tier 1's bake computed `D_rest` — the map's STEADY, converged structure,
 * which genuinely bent a breeze around a corner and funnelled it through a
 * doorway over many cells. This file's `D_live` is a decaying TRANSIENT that
 * — BEFORE the rethink — rode on top of an already-correct `D_rest`
 * (advection here always transports along the TOTAL field `A + D_rest +
 * D_live`, per Wind.md §3's own "disturbances ride the total wind" rule).
 * What is left for D_live's own relax is a much narrower, purely LOCAL job:
 * stop a puff's own velocity from visibly pointing INTO an adjacent solid
 * cell during its brief life (free-slip — Wind.md §4: "air slides
 * frictionlessly along walls"). A per-axis into-wall cancellation is
 * exactly adequate for that narrower job — it is Tier 1's FIRST (rejected)
 * approach, reused deliberately, for a genuinely different, smaller problem
 * than the one it failed at. The
 * bounded neighbour-blend on top exists only so a handful of iterations can
 * spread that local correction to the immediately adjacent cells too (a
 * puff is a few cells wide, not a point) — it is NOT attempting Tier 1's
 * global propagation, and `relaxWindField`'s own tests assert the LOCAL
 * damping claim only, never a redirect-toward-a-distant-gap claim.
 *
 * @module world/wind-sim
 */

// ── Tuned by eye, same posture as WIND_SPACE_FREQ etc in wind-field.js ──────
export const WIND_SIM_DEFAULT_DECAY_PER_SECOND = 0.35; // D_live's magnitude at t+1s ≈ 35% of t (a physical RATE, not a per-tick factor — see dissipateWindField's own header for why that distinction is load-bearing)
export const WIND_SIM_DEFAULT_RELAX_ITERATIONS = 4; // a fixed per-tick budget, not a rate — see this file's header
export const WIND_SIM_RELAX_BLEND = 0.25; // how far each iteration blends toward the wall-respecting neighbour average
export const WIND_SIM_ENERGY_FLOOR_FRACTION = 0.015; // refreeze once remaining energy < 1.5% of a unit impulse's peak
export const WIND_SIM_MAX_ACTIVE_IMPULSES = 4; // fixed GPU slot count — bounded, cheap, no dynamic array upload
export const WIND_SIM_SPLAT_FOLLOW_RATE_PER_SECOND = 25; // exponential approach rate — see splatWindField's own header

export const DOOR_IMPULSE_GAIN = 1.6; // a sudden opening briefly overshoots the eventual steady flow — a look-cheat, not measured
export const DOOR_IMPULSE_LIFETIME_MS = 900; // Wind.md §4's own "~1 second, then gone" target for the INJECTION envelope (the resulting D_live persists a bit longer — see computeThawWindowMs)
export const DOOR_IMPULSE_ATTACK_FRACTION = 0.12; // a door swings open fast — most of lifetimeMs is the decay tail, not the attack
export const DOOR_IMPULSE_MIN_RADIUS_PX = 60; // a floor under a very short door segment's own half-length

const NEIGHBORS = Object.freeze([
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]);

function idx(cols, col, row) {
  return row * cols + col;
}
function inBounds(cols, rows, col, row) {
  return col >= 0 && col < cols && row >= 0 && row < rows;
}
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
function smoothstep01(t) {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
}

// ============================================================================
// ONE-SHOT ENVELOPE + THAW-WINDOW MATH
// ============================================================================

/**
 * A one-shot contributor's own gain, 0..1, over its lifetime — a fast
 * ATTACK (a door swings open quickly) into a slower ease-OUT decay,
 * evaluated from absolute time so it is frame-rate independent by
 * construction (no per-tick accumulation to get wrong).
 *
 * @param {object} args
 * @param {number} args.startMs @param {number} args.lifetimeMs @param {number} args.nowMs
 * @param {number} [args.attackFraction] - fraction of lifetimeMs spent rising (0..1).
 * @returns {number} 0 before start and after start+lifetimeMs, else 0..1.
 */
export function computeOneShotGain01({ startMs, lifetimeMs, nowMs, attackFraction = DOOR_IMPULSE_ATTACK_FRACTION }) {
  const life = Number.isFinite(lifetimeMs) && lifetimeMs > 0 ? lifetimeMs : 0;
  if (life <= 0 || !Number.isFinite(startMs) || !Number.isFinite(nowMs)) return 0;
  const t = (nowMs - startMs) / life;
  if (t < 0 || t > 1) return 0;
  const attack = clamp01(attackFraction);
  if (attack <= 0) return 1 - smoothstep01(t);
  if (t <= attack) return smoothstep01(t / attack);
  return 1 - smoothstep01((t - attack) / Math.max(1e-6, 1 - attack));
}

/**
 * How many ticks of decay a unit-magnitude field needs before it falls below
 * `energyFloorFraction` of its start — the closed form of
 * `decayThisTick^N <= floor`, where `decayThisTick` is decay already
 * converted to a per-tick factor at some reference rate (see
 * {@link computeThawWindowMs}, which does that conversion; this function
 * stays in plain "factor per step" terms so it is independently testable).
 *
 * @param {object} args
 * @param {number} args.decayPerStep - 0..1, exclusive of 1 (1 never decays).
 * @param {number} args.energyFloorFraction - 0..1, exclusive of 0.
 * @returns {number} integer ticks, >= 0.
 */
export function computeDecayTailTicks({ decayPerStep, energyFloorFraction }) {
  const d = Number(decayPerStep);
  const floor = Number(energyFloorFraction);
  if (!(d > 0 && d < 1) || !(floor > 0 && floor < 1)) return 0;
  return Math.max(0, Math.ceil(Math.log(floor) / Math.log(d)));
}

/**
 * The full THAW window for a single impulse: the injection envelope's own
 * `lifetimeMs` (D_live is still being ADDED to during this span) plus a
 * decay TAIL long enough for whatever peaked during injection to fall below
 * the energy floor. Deliberately generous, not tight: `feedback_
 * instruments_must_not_lie` — refreezing while a puff is still visibly
 * moving is a worse failure than ticking a handful of extra, cheap frames.
 *
 * @param {object} args
 * @param {number} args.lifetimeMs
 * @param {number} args.decayPerSecond - see {@link dissipateWindField}'s header.
 * @param {number} [args.tickHz=60] - reference rate for the tail's OWN tick
 *   count; the tail itself is returned in ms, so the caller's actual (variable)
 *   tick rate does not need to match this — it only sets how finely the tail
 *   is discretised, and a coarser/finer choice moves the result by a fraction
 *   of one tick's worth of ms, never materially.
 * @param {number} [args.energyFloorFraction]
 * @returns {number} milliseconds.
 */
export function computeThawWindowMs({
  lifetimeMs,
  decayPerSecond,
  tickHz = 60,
  energyFloorFraction = WIND_SIM_ENERGY_FLOOR_FRACTION,
}) {
  const life = Number.isFinite(lifetimeMs) && lifetimeMs > 0 ? lifetimeMs : 0;
  const hz = Number.isFinite(tickHz) && tickHz > 0 ? tickHz : 60;
  const decayPerStep = Math.pow(clamp01(decayPerSecond), 1 / hz);
  const tailTicks = computeDecayTailTicks({ decayPerStep, energyFloorFraction });
  return life + (tailTicks / hz) * 1000;
}

// ============================================================================
// DOOR IMPULSE — Wind.md §4's recipe, as a validated WindContributor
// ============================================================================

/**
 * A door swinging open → a `WindContributor` (kind:'impulse', mode:'oneShot')
 * that lets the CURRENT ambient briefly punch through the doorway faster
 * than Tier 1's own rebake would settle to on its own.
 *
 * THE DIRECTION, DERIVED RATHER THAN GUESSED: the wall segment has two
 * possible perpendiculars: which one is "through the doorway, into the
 * room" depends on geometry this function does not have (which side is
 * "inside"). Rather than guess, the impulse vector is the AMBIENT'S OWN
 * component along ONE canonical perpendicular — `normal · ambient`, scaled
 * back onto `normal` itself. This self-corrects: if the true through-flow is
 * along `-normal`, the dot product is already negative, so the scaled
 * result points along `-normal` on its own, no branch needed. A doorway in
 * a wall that runs PARALLEL to the current wind (so neither perpendicular
 * carries much ambient) correctly gets a near-zero impulse — a door in a
 * calm room, or one the wind can't see, shouldn't gust. A WINDLESS scene
 * (ambient speed 0) gets exactly zero impulse, which is the correct,
 * emergent answer, not a special case: opening a door lets the SAME wind
 * that's already blowing everywhere else through a little faster, and if
 * there is no wind, there is nothing to let through.
 *
 * @param {{x1:number,y1:number,x2:number,y2:number}} wallSegment - world px.
 * @param {object} opts
 * @param {number} opts.ambientX @param {number} opts.ambientY - world-space
 *   ambient flow vector (`world/wind-bake.js#ambientVectorFromWind`'s output
 *   — already FROM→flow corrected, do not re-derive that here).
 * @param {string} opts.id - stable contributor id (e.g. `door:<wallId>:<startMs>`).
 * @param {number} opts.nowMs - becomes the contributor's `startMs`.
 * @param {number} [opts.gain]
 * @param {number} [opts.lifetimeMs]
 * @param {number} [opts.minRadiusPx]
 * @returns {import('./wind-field.js').WindContributor|null} null for a
 *   degenerate (zero-length) segment — never a NaN-carrying contributor.
 */
export function doorwayImpulseFromWallSegment(
  wallSegment,
  {
    ambientX = 0,
    ambientY = 0,
    id,
    nowMs,
    gain = DOOR_IMPULSE_GAIN,
    lifetimeMs = DOOR_IMPULSE_LIFETIME_MS,
    minRadiusPx = DOOR_IMPULSE_MIN_RADIUS_PX,
  } = {}
) {
  const { x1, y1, x2, y2 } = wallSegment ?? {};
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  if (len <= 1e-6) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Canonical perpendicular (rotate +90°); the projection below picks the
  // correct SIGN automatically — see this function's own header.
  const nx = -uy;
  const ny = ux;
  const through = (Number(ambientX) || 0) * nx + (Number(ambientY) || 0) * ny;
  const vx = nx * through * gain;
  const vy = ny * through * gain;
  return {
    id: typeof id === 'string' && id.length > 0 ? id : `door:${x1},${y1}-${x2},${y2}:${nowMs}`,
    kind: 'impulse',
    shape: 'segment',
    at: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 },
    radius: Math.max(minRadiusPx, len / 2),
    impulse: { x: vx, y: vy },
    strength: 1,
    mode: 'oneShot',
    startMs: Number.isFinite(nowMs) ? nowMs : 0,
    lifetimeMs,
    easing: 'ease-out',
  };
}

/**
 * Reduce a list of `WindContributor` (mode:'oneShot') into a BOUNDED,
 * GPU-ready slot array — Wind.md §5's "only one-shots are registered
 * explicitly... a small queue... drained each tick", made concrete. Expired
 * contributors (past `startMs+lifetimeMs`) are dropped; over capacity, the
 * strongest CURRENT contributions win (never a silent FIFO drop of the very
 * gust the caller just asked to see — `no silent caps`: `droppedCount` says
 * how many were left out).
 *
 * @param {import('./wind-field.js').WindContributor[]} contributors
 * @param {number} nowMs
 * @param {number} [maxSlots]
 * @returns {{slots: Array<{x:number,y:number,vx:number,vy:number,radius:number,gain:number}>, droppedCount: number}}
 */
export function gatherActiveImpulseSlots(contributors, nowMs, maxSlots = WIND_SIM_MAX_ACTIVE_IMPULSES) {
  const list = Array.isArray(contributors) ? contributors : [];
  const cap = Number.isFinite(maxSlots) && maxSlots > 0 ? Math.floor(maxSlots) : WIND_SIM_MAX_ACTIVE_IMPULSES;
  const live = [];
  for (const c of list) {
    if (!c || c.mode !== 'oneShot') continue;
    const gain = computeOneShotGain01({ startMs: c.startMs, lifetimeMs: c.lifetimeMs, nowMs });
    if (gain <= 0) continue;
    const at = c.at;
    const impulse = c.impulse;
    if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    if (!impulse || !Number.isFinite(impulse.x) || !Number.isFinite(impulse.y)) continue;
    const strength = Number.isFinite(c.strength) ? c.strength : 1;
    live.push({
      x: at.x,
      y: at.y,
      vx: impulse.x * strength,
      vy: impulse.y * strength,
      radius: Number.isFinite(c.radius) && c.radius > 0 ? c.radius : DOOR_IMPULSE_MIN_RADIUS_PX,
      gain,
    });
  }
  live.sort((a, b) => b.gain * Math.hypot(b.vx, b.vy) - a.gain * Math.hypot(a.vx, a.vy));
  const slots = live.slice(0, cap);
  return { slots, droppedCount: Math.max(0, live.length - slots.length) };
}

// ============================================================================
// THE FOUR STAGES — Wind.md §3, in order. Each is independently pure and
// independently testable; `stepWindSimReference` composes them unfused (the
// TSL port fuses advect+dissipate as a documented, behaviour-preserving
// optimisation — see wind-sim-gpu.js).
// ============================================================================

/**
 * ADVECT — `D*(x) = D(x - W(x)*dt)`, W = ambient + D_rest + D_live(self), the
 * transport velocity riding the TOTAL field (Wind.md §3: "disturbances ride
 * the total wind"). Grid coordinates throughout; `cellSize` converts a
 * world-px velocity into cells/sec so callers never have to pre-scale.
 *
 * `solid`, if passed, is enforced DEFENSIVELY here too (not just by
 * `relaxWindField`): a solid cell always reads exactly (0,0), full stop,
 * regardless of what `relaxIterations` a caller later chooses (including
 * 0 — WIND_PARAMS' own documented "reflect-only" rung). Without this, a
 * `relaxIterations:0` composed step would let a solid cell's own advected
 * sample of a nearby open cell's velocity stand unzeroed — every OTHER
 * stage in this file already maintains this invariant independently
 * (`splatWindField` never writes into a solid cell; `relaxWindField` always
 * zeroes one, even at its own iterations=0 — see that function's header),
 * so advect keeping a silent exception was the one real gap.
 *
 * @param {object} args
 * @param {Float32Array} args.vx @param {Float32Array} args.vy - D_live, current.
 * @param {number} args.cols @param {number} args.rows
 * @param {Uint8Array} [args.solid] - omitted = no cell is treated as solid here.
 * @param {Float32Array} [args.restVx] @param {Float32Array} [args.restVy] -
 *   D_rest (Tier 1's baked deviation), same shape; omitted = zero everywhere.
 * @param {number} [args.ambientX] @param {number} [args.ambientY] - world px/s.
 * @param {number} args.dt - seconds.
 * @param {number} [args.cellSize] - world px per cell (default 1 = args are
 *   already in cells/sec, the convenient default for tests).
 * @returns {{vx: Float32Array, vy: Float32Array}}
 */
export function advectWindField({
  vx,
  vy,
  cols,
  rows,
  solid = null,
  restVx = null,
  restVy = null,
  ambientX = 0,
  ambientY = 0,
  dt,
  cellSize = 1,
}) {
  const c = Math.max(0, Math.floor(cols) || 0);
  const r = Math.max(0, Math.floor(rows) || 0);
  const n = c * r;
  const outX = new Float32Array(n);
  const outY = new Float32Array(n);
  const size = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 1;
  const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  const sample = (field, bx, by) => bilinearSample(field, c, r, bx, by);
  for (let row = 0; row < r; row++) {
    for (let col = 0; col < c; col++) {
      const i = idx(c, col, row);
      if (solid && solid[i]) {
        outX[i] = 0;
        outY[i] = 0;
        continue;
      }
      const rvx = restVx ? restVx[i] : 0;
      const rvy = restVy ? restVy[i] : 0;
      const wx = ambientX + rvx + vx[i];
      const wy = ambientY + rvy + vy[i];
      const bx = col - (wx * step) / size;
      const by = row - (wy * step) / size;
      outX[i] = sample(vx, bx, by);
      outY[i] = sample(vy, bx, by);
    }
  }
  return { vx: outX, vy: outY };
}

/** Bilinear-sample a grid field at continuous (x,y) cell coordinates, clamped
 * to the grid edge (never wraps, never reads out of bounds). */
function bilinearSample(field, cols, rows, x, y) {
  if (cols <= 0 || rows <= 0) return 0;
  const cx = Math.min(Math.max(x, 0), cols - 1);
  const cy = Math.min(Math.max(y, 0), rows - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, cols - 1);
  const y1 = Math.min(y0 + 1, rows - 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const v00 = field[idx(cols, x0, y0)];
  const v10 = field[idx(cols, x1, y0)];
  const v01 = field[idx(cols, x0, y1)];
  const v11 = field[idx(cols, x1, y1)];
  const a = v00 + (v10 - v00) * tx;
  const b = v01 + (v11 - v01) * tx;
  return a + (b - a) * ty;
}

/**
 * SPLAT — each active slot pulls the cells it reaches toward its own target
 * contribution via a bounded exponential follow (`1 - exp(-rate*dt)`), NOT
 * an unbounded `+=`. An additive accumulator would scale with CALL FREQUENCY
 * (more ticks/sec at a higher frame rate = more additions over the same
 * wall-clock span = a frame-rate-dependent magnitude — exactly the class of
 * bug `core/frame-clock.js` exists to prevent elsewhere); a bounded follow
 * converges toward the SAME target regardless of how many ticks it takes to
 * get there. Cells outside every slot's radius are left byte-identical —
 * this function must never quietly damp a puff that is still propagating
 * away from where it was splatted (that is `relaxWindField`/
 * `dissipateWindField`'s job, not this one's).
 *
 * @param {object} args
 * @param {Float32Array} args.vx @param {Float32Array} args.vy
 * @param {number} args.cols @param {number} args.rows
 * @param {Uint8Array} args.solid
 * @param {Array<{x:number,y:number,vx:number,vy:number,radius:number,gain:number}>} args.slots -
 *   world px position/radius, world-px/s vector, 0..1 gain (from
 *   {@link gatherActiveImpulseSlots}).
 * @param {number} args.dt - seconds.
 * @param {number} args.originX @param {number} args.originY @param {number} args.cellSize -
 *   world→cell conversion (the SAME grid spec `sampleWind`'s bakedField uses).
 * @param {number} [args.followRatePerSecond]
 * @returns {{vx: Float32Array, vy: Float32Array}}
 */
export function splatWindField({
  vx,
  vy,
  cols,
  rows,
  solid,
  slots,
  dt,
  originX = 0,
  originY = 0,
  cellSize = 1,
  followRatePerSecond = WIND_SIM_SPLAT_FOLLOW_RATE_PER_SECOND,
}) {
  const c = Math.max(0, Math.floor(cols) || 0);
  const r = Math.max(0, Math.floor(rows) || 0);
  const outX = Float32Array.from(vx);
  const outY = Float32Array.from(vy);
  const list = Array.isArray(slots) ? slots : [];
  if (list.length === 0) return { vx: outX, vy: outY };
  const size = Number.isFinite(cellSize) && cellSize > 0 ? cellSize : 1;
  const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  const blend = 1 - Math.exp(-Math.max(0, followRatePerSecond) * step);
  for (const slot of list) {
    const scol = (slot.x - originX) / size;
    const srow = (slot.y - originY) / size;
    const rCells = Math.max(1e-3, slot.radius / size);
    const colLo = Math.max(0, Math.floor(scol - rCells));
    const colHi = Math.min(c - 1, Math.ceil(scol + rCells));
    const rowLo = Math.max(0, Math.floor(srow - rCells));
    const rowHi = Math.min(r - 1, Math.ceil(srow + rCells));
    for (let row = rowLo; row <= rowHi; row++) {
      for (let col = colLo; col <= colHi; col++) {
        const i = idx(c, col, row);
        if (solid && solid[i]) continue;
        const dx = col - scol;
        const dy = row - srow;
        const dist = Math.hypot(dx, dy);
        if (dist > rCells) continue;
        const w = 1 - dist / rCells;
        const falloff = w * w * (3 - 2 * w); // smoothstep-shaped edge
        const targetX = slot.vx * falloff * slot.gain;
        const targetY = slot.vy * falloff * slot.gain;
        outX[i] += (targetX - outX[i]) * blend;
        outY[i] += (targetY - outY[i]) * blend;
      }
    }
  }
  return { vx: outX, vy: outY };
}

/**
 * RELAX — see this file's header for why a per-axis into-wall cancellation
 * is the right tool HERE (a local, free-slip damping job) even though Tier
 * 1 proved the same shape wrong for a DIFFERENT, global-redirect job. Each
 * iteration: cancel the velocity component pointing into any solid
 * neighbour, then blend a little toward the (wall-respecting) neighbour
 * average. Off-grid neighbours read as a fixed ZERO deviation (not a wall,
 * not an echo of self) — the correct Dirichlet boundary for a field that
 * represents "how far from ambient", which is by definition zero beyond
 * whatever was ever baked/splatted.
 *
 * @param {object} args
 * @param {Float32Array} args.vx @param {Float32Array} args.vy
 * @param {number} args.cols @param {number} args.rows
 * @param {Uint8Array} args.solid
 * @param {number} [args.iterations]
 * @param {number} [args.blend] - 0..1, how far each iteration moves toward the neighbour average.
 * @returns {{vx: Float32Array, vy: Float32Array}}
 */
export function relaxWindField({
  vx,
  vy,
  cols,
  rows,
  solid,
  iterations = WIND_SIM_DEFAULT_RELAX_ITERATIONS,
  blend = WIND_SIM_RELAX_BLEND,
}) {
  const c = Math.max(0, Math.floor(cols) || 0);
  const r = Math.max(0, Math.floor(rows) || 0);
  const n = c * r;
  const mask = solid instanceof Uint8Array && solid.length === n ? solid : new Uint8Array(n);
  let curX = Float32Array.from(vx);
  let curY = Float32Array.from(vy);
  const iters = Math.max(0, Math.floor(iterations) || 0);
  const b = clamp01(blend);
  for (let iter = 0; iter < iters; iter++) {
    const nextX = new Float32Array(n);
    const nextY = new Float32Array(n);
    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        const i = idx(c, col, row);
        if (mask[i]) {
          nextX[i] = 0;
          nextY[i] = 0;
          continue;
        }
        let vX = curX[i];
        let vY = curY[i];
        let sumX = 0;
        let sumY = 0;
        for (const [dx, dy] of NEIGHBORS) {
          const ncol = col + dx;
          const nrow = row + dy;
          if (!inBounds(c, r, ncol, nrow)) {
            sumX += 0; // off-grid: fixed-zero Dirichlet edge — see this fn's own header
            sumY += 0;
            continue;
          }
          const ni = idx(c, ncol, nrow);
          if (mask[ni]) {
            // Cancel the component pointing INTO this solid neighbour
            // (free-slip: the tangential component survives untouched).
            const into = vX * dx + vY * dy;
            if (into > 0) {
              vX -= into * dx;
              vY -= into * dy;
            }
            sumX += vX;
            sumY += vY;
          } else {
            sumX += curX[ni];
            sumY += curY[ni];
          }
        }
        const avgX = sumX / NEIGHBORS.length;
        const avgY = sumY / NEIGHBORS.length;
        nextX[i] = vX + (avgX - vX) * b;
        nextY[i] = vY + (avgY - vY) * b;
      }
    }
    curX = nextX;
    curY = nextY;
  }
  // Defensive, unconditional: a solid cell reads exactly (0,0) even at
  // iterations:0 (a documented, legitimate "reflect-only... off" rung per
  // WIND_PARAMS — the loop above never runs, so it never gets the chance to
  // zero anything). Idempotent when the loop already did this.
  if (iters === 0) {
    for (let i = 0; i < n; i++) {
      if (mask[i]) {
        curX[i] = 0;
        curY[i] = 0;
      }
    }
  }
  return { vx: curX, vy: curY };
}

/**
 * DISSIPATE — a continuous per-SECOND decay rate converted to this tick's
 * own factor via `dt`, never a bare per-tick multiplier (see
 * `WIND_SIM_DEFAULT_DECAY_PER_SECOND`'s own doc: a per-tick constant would
 * make real-time decay speed depend on frame rate, the exact bug class
 * `core/frame-clock.js` exists to prevent elsewhere in this codebase).
 *
 * @param {object} args
 * @param {Float32Array} args.vx @param {Float32Array} args.vy
 * @param {number} args.dt - seconds.
 * @param {number} [args.decayPerSecond] - 0..1, the fraction of magnitude
 *   that survives ONE FULL SECOND of decay.
 * @returns {{vx: Float32Array, vy: Float32Array}}
 */
export function dissipateWindField({ vx, vy, dt, decayPerSecond = WIND_SIM_DEFAULT_DECAY_PER_SECOND }) {
  const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  const factor = Math.pow(clamp01(decayPerSecond), step);
  const outX = new Float32Array(vx.length);
  const outY = new Float32Array(vy.length);
  for (let i = 0; i < vx.length; i++) {
    outX[i] = vx[i] * factor;
    outY[i] = vy[i] * factor;
  }
  return { vx: outX, vy: outY };
}

/**
 * The composed reference tick, Wind.md §3's order exactly: ADVECT → SPLAT →
 * RELAX → DISSIPATE. This is the SPEC the TSL port matches (see this file's
 * own header) — kept unfused (unlike the shader, which fuses advect+
 * dissipate as a documented optimisation) so each stage's own test can
 * attribute a result to exactly one function.
 *
 * @param {object} args - the union of every stage function's own args above,
 *   plus `slots` (raw, gain/expiry NOT yet applied — pass
 *   {@link gatherActiveImpulseSlots}'s output's `.slots`).
 * @returns {{vx: Float32Array, vy: Float32Array}}
 */
export function stepWindSimReference(args) {
  const advected = advectWindField(args);
  const splatted = splatWindField({ ...args, vx: advected.vx, vy: advected.vy });
  const relaxed = relaxWindField({ ...args, vx: splatted.vx, vy: splatted.vy });
  return dissipateWindField({ ...args, vx: relaxed.vx, vy: relaxed.vy });
}
