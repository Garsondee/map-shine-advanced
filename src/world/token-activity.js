/**
 * TOKEN ACTIVITY — a position snapshot becomes MOTION.
 *
 * Pure; Node-tested; no Foundry, no GPU. `foundry/token-activity.js` hands
 * back WHERE tokens are, right now; this compares that against where they
 * were LAST CALL and says which ones are actually walking, and how fast.
 * Everything downstream — the mantle's trample stamps, a critter's startle —
 * reads this, never Foundry's token list directly (`foundry/adapter-only`,
 * `zones/one-door`): a token position is a fact about Foundry, but "is it
 * moving" is a derived fact about the WORLD, same layering `world/sun.js` is
 * a pure function of the day clock rather than every consumer re-deriving
 * dawn from the hour itself.
 *
 * ⚠️ NO VELOCITY VECTOR, ONLY SPEED. Nothing downstream needs heading yet —
 * the mantle stamps where a token IS, not where it is going, and a critter's
 * startle cares about distance, not approach angle. A direction can be added
 * the day a consumer actually reads one; adding it speculatively now would
 * be exactly the "a float is a float" discipline's opposite (declare the
 * axis a consumer needs, not the axis a producer could technically supply).
 *
 * @module world/token-activity
 */

/**
 * Below this, a token reads as STILL rather than walking — floating-point
 * drift in a live PlaceableObject's `.center` (sub-pixel across two reads of
 * an object nobody moved) must not register as motion, or a stamp queue
 * would repaint every idle token's square forever. Far below any real walk:
 * Foundry's shortest useful step (one small-grid square) covers this many
 * pixels in well under a tenth of a second.
 */
export const MOVING_THRESHOLD_PX_PER_SEC = 2;

/** How many trample stamps one mantle step accepts — `mantle-runtime.js`'s own small, fixed uniform array
 * (`MAX_TRAMPLE_STAMPS`); kept here too so a caller can size its cap WITHOUT importing a GPU-adjacent
 * module into a pure one (`zones/one-door` — `effects/` is a different zone than `world/`). The two
 * constants are asserted equal in `__tests__/token-activity.test.mjs`. */
export const MAX_TRAMPLE_STAMPS = 16;

/**
 * @typedef {object} TokenMotion
 * @property {string} id
 * @property {number} x @property {number} y
 * @property {number} elevation @property {number} disposition @property {boolean} hidden
 * @property {number} radiusPx
 * @property {number} speedPxPerSec - 0 on a token's first-ever sample (no previous position to diff).
 * @property {boolean} isMoving
 */

/**
 * Diff this frame's token points against the last frame's, by id.
 *
 * @param {Map<string, {x: number, y: number}>} prevById - what `nextById` returned last call; an
 *   empty/missing Map reads as "every token is new" (speed 0, not moving — the honest answer, since
 *   there is nothing to diff against).
 * @param {Array<import('../foundry/token-activity.js').TokenPoint>} points - this frame's snapshot
 *   (`foundry/token-activity.js#collectActiveTokenPoints`).
 * @param {number} dtSec - seconds since `prevById` was captured. A paused game or a dropped frame with
 *   `dtSec <= 0` reads every token as still, never as infinitely fast.
 * @returns {{motion: TokenMotion[], nextById: Map<string, {x: number, y: number}>}}
 */
export function deriveTokenMotion(prevById, points, dtSec) {
  const prev = prevById instanceof Map ? prevById : new Map();
  const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
  const nextById = new Map();

  const motion = (Array.isArray(points) ? points : []).map((p) => {
    const was = prev.get(p.id);
    let speedPxPerSec = 0;
    if (was && dt > 0) {
      const dx = p.x - was.x;
      const dy = p.y - was.y;
      speedPxPerSec = Math.sqrt(dx * dx + dy * dy) / dt;
    }
    nextById.set(p.id, { x: p.x, y: p.y });
    return { ...p, speedPxPerSec, isMoving: speedPxPerSec > MOVING_THRESHOLD_PX_PER_SEC };
  });

  return { motion, nextById };
}

/**
 * Which moving tokens should stamp the mantle's `trample01` channel this step — the CPU-side queue
 * `docs/planning/Precipitation.md` §5.2 named and never built (*"token movement stamps `trample01`...
 * along the motion segment... positions from the token layer MSA already reads"*).
 *
 * ⚠️ ONLY `isMoving` TOKENS CONTRIBUTE. A token standing still does not keep re-stamping its own square —
 * that would read as the print getting deeper forever rather than as a footprint, and it is also exactly
 * backwards from `mantle-model.js`'s own healing promise ("fresh snow buries footprints... the mantle
 * HEALS"): a print should fade once nothing is actively making it, whether the token left or just stopped.
 *
 * @param {TokenMotion[]} motion
 * @param {object} [p]
 * @param {number} [p.radiusScale=1] - multiplies each token's own `radiusPx` (0 reads as a small fixed
 *   footprint — a body with no measurable size still leaves a print).
 * @param {number} [p.strength=1] - 0..~2, how deep one step's stamp digs into `trample01`.
 * @param {number} [p.maxStamps=MAX_TRAMPLE_STAMPS] - the uniform array's real capacity.
 * @returns {{stamps: Array<{x: number, y: number, radiusPx: number, strength: number}>, droppedCount: number}}
 */
export function buildTrampleStamps(motion, { radiusScale = 1, strength = 1, maxStamps = MAX_TRAMPLE_STAMPS } = {}) {
  const scale = Number.isFinite(radiusScale) && radiusScale > 0 ? radiusScale : 1;
  const amount = Number.isFinite(strength) && strength > 0 ? strength : 0;
  const cap = Number.isFinite(maxStamps) && maxStamps > 0 ? Math.floor(maxStamps) : MAX_TRAMPLE_STAMPS;

  const moving = (Array.isArray(motion) ? motion : []).filter((m) => m.isMoving);
  const stamps = moving.slice(0, cap).map((m) => ({
    x: m.x,
    y: m.y,
    radiusPx: Math.max(8, (m.radiusPx || 0) * scale),
    strength: amount,
  }));

  return { stamps, droppedCount: Math.max(0, moving.length - stamps.length) };
}
