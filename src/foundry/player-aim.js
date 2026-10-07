/**
 * PLAYER AIM — THE PURE HALF of "a carried light follows its bearer's cursor"
 * (mythica-machina-press#77): a flashlight is pointed at it, a torch held out to it. The live half — Foundry's pointer,
 * the module socket, a timer — is `player-aim-channel.js`; everything here is a
 * total function or a small state machine over plain numbers, so the rules that
 * decide what a client SENDS and what a client SHOWS are Node-tested instead of
 * hoped for.
 *
 * WHY THIS EXISTS. V2's flashlight ran off a window `pointermove` and was local
 * to its bearer: nobody else at the table ever saw the beam move. V3 draws every
 * carried light on EVERY client from synced Token data, and its only direction
 * input was `TokenDocument.rotation` — 0° (north) for any token that has not
 * been dragged. The cursor exists on exactly one client, so its angle has to
 * travel. An ephemeral module-socket message was chosen (2026-10-07) over:
 *   - writing the angle into `TokenDocument.rotation` — a database write ~10x a
 *     second per aimer that also spins the token's own artwork to face the
 *     cursor; and
 *   - leaving each client its own aim — everyone else keeps seeing a north beam.
 * The message costs no writes, leaves the token art alone, and every receiver
 * falls back to the stored rotation whenever no fresh aim exists.
 *
 * ANGLES use `TokenDocument.rotation`'s own convention — degrees, 0 = up (world
 * −Y, canvas Y grows downward), increasing clockwise — i.e. the convention
 * `effects/lighting/player-light-geometry.js#tokenRotationToForwardVector`
 * already turns into a beam direction. An aim is therefore a drop-in for the
 * rotation it overrides; nothing converts between two conventions on the way to
 * the shader. (`player-aim.test.mjs` locks the two together.)
 *
 * WHAT TRAVELS is one angle per aiming token — plus, for a held torch, one
 * reach (px from the token, already clamped to the leash and the walls by the
 * owner's client) — not a cursor position: a remote client has no use for the
 * cursor beyond where the light ends up, and that is all it is sent.
 *
 * WHY IT IS SHAPED THIS WAY:
 *   - SEND POLICY (`createAimSendPolicy`) is rate-capped at Foundry's own cursor
 *     cadence (`Canvas#throttleOnMouseMove` is 100 ms), ignores sub-visible
 *     wobble, always sends the SETTLED final angle once a sweep stops, and
 *     repeats the current angle every couple of seconds — so a client that
 *     reloads mid-session, or missed a (volatile) message, converges without a
 *     "please resend" round trip.
 *   - RECEIVE SIDE (`createRemoteAimStore`) smooths the 10 Hz stream into the
 *     60 fps frame with a frame-rate-independent exponential ease along the
 *     SHORT arc (359° → 1° is a 2° turn, not a 358° spin), and lets an entry
 *     expire — a bearer who left the table must not freeze a beam in place
 *     forever; the stored rotation takes over again.
 *   - NOTHING here reads a clock: every function that cares about time is handed
 *     `nowMs` (`time/one-clock`, tools/verify-structure.mjs).
 *
 * @module foundry/player-aim
 */

/**
 * The carried-light modes the bearer's cursor steers. Kept as this zone's own
 * copy rather than imported from `effects/lighting/player-light-geometry.js` (a
 * leaf adapter imports nothing above itself, and `player-light-mode.js` already
 * sets the precedent of a per-zone mode list); `player-aim.test.mjs` fails if it
 * ever disagrees with the presets marked `aimed` there.
 */
export const PLAYER_AIM_MODES = Object.freeze(['flashlight', 'torch']);

/**
 * The subset that carries a REACH besides its bearing (the `d` on the wire).
 * For a torch it is how far from the bearer the light is held; for a flashlight
 * it is how far away the cursor is, which sets how long the beam is.
 */
export const PLAYER_AIM_REACH_MODES = Object.freeze(['torch', 'flashlight']);

/**
 * The subset whose light is HELD OUT at the cursor — displaced from its
 * bearer by the reach — rather than just pointed at it: a torch sits at the end
 * of an arm. (A flashlight stays in its bearer's hand; its reach only sets how
 * far the beam throws.)
 */
export const PLAYER_AIM_HELD_MODES = Object.freeze(['torch']);

/**
 * A flashlight's reach is the cursor's distance, capped here so a cursor
 * wandering further out stops generating traffic once the beam has reached its
 * full length. Must stay above the flashlight preset's `radiusPx` (a cross-zone
 * test holds it there) — a cap below that would shorten the beam's full throw.
 */
export const AIM_FLASHLIGHT_REACH_CAP_PX = 1000;

/** How far from its bearer a torch may be held, in grid squares (V2: 10 units x 3 = 30 ft at 5 ft/square). */
export const AIM_TORCH_LEASH_SQUARES = 6;
/** A torch held against a wall stops this far short of it, so its flame never sits inside the wall (V2: 12 px). */
export const AIM_TORCH_WALL_MARGIN_PX = 12;
/**
 * Drag the cursor further than the leash and the torch GUTTERS: from the leash
 * out to this many grid squares beyond it, its burn falls from full to nothing
 * (V2: a 7 x 3 = 21 ft fade band, ~4 squares; a little tighter here).
 */
export const AIM_TORCH_FADE_SQUARES = 3;
/**
 * Once out, a torch only relights when the cursor TOUCHES its bearer: within the
 * bearer's own radius plus this margin (V2: `torchReigniteRequiresTouch`).
 */
export const AIM_TORCH_TOUCH_MARGIN_PX = 12;
/** A change in burn smaller than this many percent is not worth a message. */
export const AIM_SEND_MIN_BURN_DELTA_PCT = 3;

/**
 * A held torch is not held perfectly still: a hand tremor of this many px (V2's
 * `wanderPixels` was 28, which on a 100 px grid read as a drunk; this is a
 * tremor). Quantized to `AIM_TORCH_WANDER_STEP_PX` because the light's wall-clip
 * cache is keyed on its EXACT position — unquantized wander would miss it, and
 * re-sweep the walls, every single frame for every torch, even a still one.
 */
export const AIM_TORCH_WANDER_PX = 5;
export const AIM_TORCH_WANDER_STEP_PX = 2;

/** The torch lags the cursor slightly — an arm, not a laser pointer (V2 sprang it). */
export const AIM_TORCH_EASE_TAU_MS = 90;

/** The `type` this feature's messages carry on the shared module socket. */
export const AIM_MESSAGE_TYPE = 'playerAim';

/**
 * A cursor closer to the token's centre than this gives no usable direction —
 * the angle swings wildly for a pixel of mouse travel — so the last real aim is
 * held instead. World pixels; small enough that aiming at the token's own edge
 * still registers.
 */
export const AIM_MIN_DISTANCE_PX = 8;

/** Wire precision: tenths of a degree (0.1° is ~1 px at the end of a 620 px beam). */
const ANGLE_STEPS_PER_DEG = 10;

/** Ids are 16 characters in Foundry; this only exists to refuse absurd input. */
const MAX_ID_LENGTH = 64;

export const AIM_SEND_MIN_INTERVAL_MS = 100;
export const AIM_SEND_MIN_DELTA_DEG = 0.75;
/** A reach change smaller than this is not worth a message (a torch's light radius is hundreds of px). */
export const AIM_SEND_MIN_REACH_DELTA_PX = 4;
/** Refuse an absurd reach off the wire; a leash is a handful of grid squares. */
export const AIM_MAX_REACH_PX = 20000;
export const AIM_SEND_SETTLE_MS = 250;
export const AIM_SEND_KEEPALIVE_MS = 2500;
/** Longer than the keepalive by a wide margin, so one lost message never expires an aim. */
export const AIM_STALE_MS = 8000;
export const AIM_SMOOTHING_TAU_MS = 70;
export const AIM_MAX_REMOTE_ENTRIES = 64;

// ---------------------------------------------------------------------------
// Angle maths
// ---------------------------------------------------------------------------

/**
 * @param {number} deg - any finite angle.
 * @returns {number} the same angle in [0, 360).
 */
export function normalizeAngleDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/**
 * The signed turn that takes `fromDeg` to `toDeg` the SHORT way round.
 * @returns {number} in (−180, 180]
 */
export function shortestAngleDeltaDeg(fromDeg, toDeg) {
  const d = normalizeAngleDeg(toDeg - fromDeg);
  return d > 180 ? d - 360 : d;
}

/**
 * Round to the wire precision, then re-normalize (359.96 rounds to 360, which is 0).
 * @param {number} deg
 * @returns {number} in [0, 360), a multiple of 0.1 — or NaN for a non-finite input.
 */
export function quantizeAimAngleDeg(deg) {
  return normalizeAngleDeg(Math.round(deg * ANGLE_STEPS_PER_DEG) / ANGLE_STEPS_PER_DEG);
}

/**
 * The compass bearing from `from` to `to`, in `TokenDocument.rotation`'s
 * convention (0 = up, clockwise): `atan2(dx, −dy)`, because canvas Y grows
 * downward — straight up is dy < 0, which must read as 0°.
 *
 * @param {{x: number, y: number}|null|undefined} from - e.g. a token's centre.
 * @param {{x: number, y: number}|null|undefined} to - e.g. the cursor in world space.
 * @param {number} [minDistancePx]
 * @returns {number|null} degrees in [0, 360), or `null` when there is no usable
 *   direction (a missing/non-finite point, or `to` within `minDistancePx` of `from`).
 */
export function aimAngleDegFromPoints(from, to, minDistancePx = AIM_MIN_DISTANCE_PX) {
  // Number.isFinite, not Number(): `Number(null)` is 0, which would read a
  // half-built point as the origin.
  const fx = from?.x;
  const fy = from?.y;
  const tx = to?.x;
  const ty = to?.y;
  if (!Number.isFinite(fx) || !Number.isFinite(fy) || !Number.isFinite(tx) || !Number.isFinite(ty)) return null;
  const dx = tx - fx;
  const dy = ty - fy;
  if (Math.hypot(dx, dy) < minDistancePx) return null;
  return normalizeAngleDeg(Math.atan2(dx, -dy) * (180 / Math.PI));
}

/**
 * One step of a frame-rate-independent exponential ease from `currentDeg`
 * toward `targetDeg` along the short arc.
 * @param {number} currentDeg
 * @param {number} targetDeg
 * @param {number} dtMs - time since the previous step; 0 (or negative) changes nothing.
 * @param {number} tauMs - the ease's time constant; ≤ 0 means "no smoothing, jump".
 * @returns {number} in [0, 360)
 */
export function smoothAngleDeg(currentDeg, targetDeg, dtMs, tauMs) {
  if (!(dtMs > 0)) return normalizeAngleDeg(currentDeg);
  if (!(tauMs > 0)) return normalizeAngleDeg(targetDeg);
  const k = 1 - Math.exp(-dtMs / tauMs);
  return normalizeAngleDeg(currentDeg + shortestAngleDeltaDeg(currentDeg, targetDeg) * k);
}

/**
 * One step of the same exponential ease for a plain number (a torch's reach).
 * @returns {number}
 */
export function smoothScalar(current, target, dtMs, tauMs) {
  if (!(dtMs > 0)) return current;
  if (!(tauMs > 0)) return target;
  return current + (target - current) * (1 - Math.exp(-dtMs / tauMs));
}

/**
 * How far from its bearer a held torch sits: as far as the cursor, but never
 * past the leash, and never closer to a wall than `marginPx`.
 *
 * @param {{cursorDistancePx: number, leashPx: number, wallHitDistancePx?: number|null, marginPx?: number}} args
 *   `wallHitDistancePx` is how far along the bearer→cursor ray the first
 *   blocking wall is, or `null` if the way is clear.
 * @returns {number} px, ≥ 0.
 */
export function clampTorchReachPx({
  cursorDistancePx,
  leashPx,
  wallHitDistancePx = null,
  marginPx = AIM_TORCH_WALL_MARGIN_PX,
}) {
  let reach = Math.min(cursorDistancePx, leashPx);
  if (Number.isFinite(wallHitDistancePx)) reach = Math.min(reach, wallHitDistancePx - marginPx);
  return Number.isFinite(reach) ? Math.max(0, reach) : 0;
}

/**
 * The displacement `reachPx` along a bearing, in canvas pixels (Y down).
 * @returns {{x: number, y: number}}
 */
export function offsetFromAim(angleDeg, reachPx) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: Math.sin(rad) * reachPx, y: -Math.cos(rad) * reachPx };
}

/** A small, stable hash of a string to [0, 1) — one per (token, salt), for phases. */
function hash01(text, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

/**
 * The tremor of a hand holding a torch: a smooth, bounded, deterministic wander
 * around where the torch is held, a pure function of the wall clock and the
 * token id — so every client computes the SAME wander for the same moment and
 * nothing about it crosses the network. Two sines per axis at unrelated rates
 * (~1-3 Hz) read as organic rather than as an orbit; the phases come from the
 * token id, so two bearers' torches never wander in step.
 *
 * @param {string} tokenId
 * @param {number} wallMs - wall-clock milliseconds (`core/frame-clock.js#wallClockMs`).
 * @param {number} [amplitudePx]
 * @param {number} [stepPx] - the grid the result is snapped to (see AIM_TORCH_WANDER_PX).
 * @returns {{x: number, y: number}} never beyond ±amplitude (plus half a step).
 */
export function torchWanderOffset(
  tokenId,
  wallMs,
  amplitudePx = AIM_TORCH_WANDER_PX,
  stepPx = AIM_TORCH_WANDER_STEP_PX
) {
  if (!(amplitudePx > 0) || !Number.isFinite(wallMs)) return { x: 0, y: 0 };
  const t = wallMs / 1000;
  const id = String(tokenId ?? '');
  const tau = Math.PI * 2;
  const wave = (rateA, rateB, salt) =>
    0.65 * Math.sin(tau * (rateA * t + hash01(id, salt))) + 0.35 * Math.sin(tau * (rateB * t + hash01(id, salt + 1)));
  const snap = (v) => (stepPx > 0 ? Math.round(v / stepPx) * stepPx : v);
  return { x: snap(amplitudePx * wave(1.1, 2.7, 11)), y: snap(amplitudePx * wave(0.9, 3.1, 31)) };
}

/**
 * How brightly a torch burns for a cursor `cursorDistancePx` from its bearer:
 * full inside the leash, falling linearly to nothing `fadeBandPx` beyond it.
 * @returns {number} 0..1
 */
export function torchBurnTarget01({ cursorDistancePx, leashPx, fadeBandPx }) {
  if (!Number.isFinite(cursorDistancePx) || !(fadeBandPx > 0)) return 1;
  if (cursorDistancePx <= leashPx) return 1;
  return Math.max(0, 1 - (cursorDistancePx - leashPx) / fadeBandPx);
}

/**
 * A bearer's torch burn, with the one piece of memory it needs: once the cursor
 * has been dragged so far that the torch is OUT, it STAYS out — pulling the
 * cursor back inside the leash does not relight it; only touching the bearer
 * does (`touchPx`). Keyed by token id, so a different token never inherits a
 * snuffed torch.
 */
export function createTorchBurn() {
  let heldTokenId = null;
  let out = false;
  return {
    /**
     * @param {string} tokenId
     * @param {{cursorDistancePx: number, leashPx: number, fadeBandPx: number, touchPx: number}} args
     * @returns {number} 0..1 — 0 while out.
     */
    update(tokenId, { cursorDistancePx, leashPx, fadeBandPx, touchPx }) {
      if (tokenId !== heldTokenId) {
        heldTokenId = tokenId;
        out = false;
      }
      if (out) {
        if (!(cursorDistancePx <= touchPx)) return 0;
        out = false; // touched: relit
      }
      const burn = torchBurnTarget01({ cursorDistancePx, leashPx, fadeBandPx });
      if (burn <= 0) {
        out = true;
        return 0;
      }
      return burn;
    },
    /** Is this torch snuffed right now? */
    get isOut() {
      return out;
    },
    reset() {
      heldTokenId = null;
      out = false;
    },
  };
}

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * @param {{tokenId: string, angleDeg: number, userId: string}} fields
 * @returns {{type: string, tokenId: string, userId: string, a: number}|null} the
 *   socket payload, or `null` if any field is unusable (nothing half-valid is sent).
 */
export function encodeAimMessage({ tokenId, angleDeg, userId, reachPx, burn01 } = {}) {
  if (!isId(tokenId) || !isId(userId) || !Number.isFinite(angleDeg)) return null;
  const msg = { type: AIM_MESSAGE_TYPE, tokenId, userId, a: quantizeAimAngleDeg(angleDeg) };
  // `d` only when there is a reach to carry (a held torch): a flashlight's message stays as small as before,
  // and a receiver that predates it simply ignores the extra field.
  if (Number.isFinite(reachPx) && reachPx >= 0) msg.d = Math.min(AIM_MAX_REACH_PX, Math.round(reachPx));
  // `b`: a torch's burn as a whole percent, only when it is not at full (a missing `b` reads as burning).
  if (Number.isFinite(burn01) && burn01 < 1) msg.b = Math.max(0, Math.round(burn01 * 100));
  return msg;
}

/**
 * The receiving half of {@link encodeAimMessage}. The module socket is shared
 * with other features (`impulse-broadcast.js`), so anything that is not this
 * feature's own message — or is malformed — decodes to `null`.
 * @param {*} msg
 * @returns {{tokenId: string, userId: string, angleDeg: number, reachPx: number|null, burn01: number|null}|null}
 *   `reachPx` is `null` when the message carries none (or an unusable one — a
 *   bad reach never costs the good angle next to it).
 */
export function decodeAimMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== AIM_MESSAGE_TYPE) return null;
  if (!isId(msg.tokenId) || !isId(msg.userId)) return null;
  if (typeof msg.a !== 'number' || !Number.isFinite(msg.a)) return null;
  const reachPx =
    typeof msg.d === 'number' && Number.isFinite(msg.d) && msg.d >= 0 ? Math.min(AIM_MAX_REACH_PX, msg.d) : null;
  const burn01 = typeof msg.b === 'number' && Number.isFinite(msg.b) ? Math.min(1, Math.max(0, msg.b / 100)) : null;
  return { tokenId: msg.tokenId, userId: msg.userId, angleDeg: normalizeAngleDeg(msg.a), reachPx, burn01 };
}

function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

// ---------------------------------------------------------------------------
// The bearer's own aim
// ---------------------------------------------------------------------------

/**
 * Turns "where is the cursor relative to my token" into an angle, and HOLDS the
 * last real one while the cursor has no usable direction (it sits on the token
 * itself, or has not been seen yet) — a beam that snapped back to north every
 * time the mouse crossed the token would be worse than the bug being fixed.
 * Keyed by token id: a different token must never inherit another's held angle.
 *
 * @param {{minDistancePx?: number}} [options]
 */
export function createLocalAimTracker({ minDistancePx = AIM_MIN_DISTANCE_PX } = {}) {
  let heldTokenId = null;
  let heldDeg = null;
  return {
    /**
     * @param {string} tokenId
     * @param {{x: number, y: number}} from - the token's centre.
     * @param {{x: number, y: number}|null} cursor - the cursor in world space, or `null` if unknown.
     * @returns {number|null} the current aim, or `null` if this token has never had one.
     */
    update(tokenId, from, cursor) {
      if (tokenId !== heldTokenId) {
        heldTokenId = tokenId;
        heldDeg = null;
      }
      const angle = aimAngleDegFromPoints(from, cursor, minDistancePx);
      if (angle !== null) heldDeg = angle;
      return heldDeg;
    },
    reset() {
      heldTokenId = null;
      heldDeg = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Outbound policy
// ---------------------------------------------------------------------------

/**
 * Decides, once per sender tick, whether the bearer's current aim goes on the
 * wire. Sends when, in order of precedence:
 *   1. nothing has been sent for this token yet;
 *   2. — never sooner than `minIntervalMs` after the previous send, whatever else is true —
 *   3. the angle moved at least `minDeltaDeg`, or the reach (a held torch's
 *      distance from its bearer; `null` for a flashlight) moved at least
 *      `minReachDeltaPx`;
 *   4. either moved by any amount and `settleMs` has passed (the FINAL aim of a
 *      sweep always lands exactly, not up to the dead band short);
 *   5. `keepaliveMs` has passed (late joiners and dropped volatile messages).
 * A reach appearing or disappearing counts as a big move.
 *
 * @param {{minIntervalMs?: number, minDeltaDeg?: number, minReachDeltaPx?: number, settleMs?: number, keepaliveMs?: number}} [options]
 */
export function createAimSendPolicy({
  minIntervalMs = AIM_SEND_MIN_INTERVAL_MS,
  minDeltaDeg = AIM_SEND_MIN_DELTA_DEG,
  minReachDeltaPx = AIM_SEND_MIN_REACH_DELTA_PX,
  minBurnDeltaPct = AIM_SEND_MIN_BURN_DELTA_PCT,
  settleMs = AIM_SEND_SETTLE_MS,
  keepaliveMs = AIM_SEND_KEEPALIVE_MS,
} = {}) {
  let tokenId = null;
  let lastSentDeg = null;
  let lastSentReach = null;
  let lastSentBurn = null;
  let lastSentMs = 0;
  return {
    /**
     * @param {string} id - the aiming token.
     * @param {number} angleDeg - its current aim.
     * @param {number} nowMs
     * @param {number|null} [reachPx] - its current reach, if it has one.
     * @param {number|null} [burn01] - a torch's current burn (1 = full), if it has one.
     * @returns {number|null} the (wire-quantized) angle to send now, or `null` to stay quiet.
     *   The caller sends its own current reach and burn alongside; this only decides WHEN.
     */
    decide(id, angleDeg, nowMs, reachPx = null, burn01 = null) {
      if (id !== tokenId) {
        tokenId = id;
        lastSentDeg = null;
        lastSentReach = null;
        lastSentBurn = null;
      }
      if (!Number.isFinite(angleDeg) || !Number.isFinite(nowMs)) return null;
      const angle = quantizeAimAngleDeg(angleDeg);
      const reach = Number.isFinite(reachPx) ? Math.round(reachPx) : null;
      const burn = Number.isFinite(burn01) ? Math.round(Math.min(1, Math.max(0, burn01)) * 100) : null;
      let send = lastSentDeg === null;
      if (!send) {
        const sinceMs = nowMs - lastSentMs;
        if (sinceMs < minIntervalMs) return null;
        const deltaDeg = Math.abs(shortestAngleDeltaDeg(lastSentDeg, angle));
        let deltaReach = 0;
        if (reach !== lastSentReach) {
          deltaReach = reach === null || lastSentReach === null ? Infinity : Math.abs(reach - lastSentReach);
        }
        let deltaBurn = 0;
        if (burn !== lastSentBurn) {
          deltaBurn = burn === null || lastSentBurn === null ? Infinity : Math.abs(burn - lastSentBurn);
        }
        const moved = deltaDeg >= minDeltaDeg || deltaReach >= minReachDeltaPx || deltaBurn >= minBurnDeltaPct;
        const changed = deltaDeg > 0 || deltaReach > 0 || deltaBurn > 0;
        send = moved || (changed && sinceMs >= settleMs) || sinceMs >= keepaliveMs;
      }
      if (!send) return null;
      lastSentDeg = angle;
      lastSentReach = reach;
      lastSentBurn = burn;
      lastSentMs = nowMs;
      return angle;
    },
    /** Forget what was sent, so the next `decide` sends immediately. */
    reset() {
      tokenId = null;
      lastSentDeg = null;
      lastSentReach = null;
      lastSentBurn = null;
    },
  };
}

// ---------------------------------------------------------------------------
// What other bearers are aiming at
// ---------------------------------------------------------------------------

/**
 * The latest aim heard for each remote token, smoothed for display.
 *
 * `receive` snaps a NEW (or long-dead) entry straight to its target — there is
 * nothing sensible to swing from. For a live entry it first advances the ease
 * up to the message's own arrival time using the OLD target, and only then
 * retargets: a new target must steer from the moment it arrives, never
 * retroactively across time that already passed, or the displayed angle would
 * depend on how often the renderer happened to sample. `sample` (once per frame
 * per token) advances the ease the rest of the way to `nowMs`.
 *
 * An entry not refreshed within `staleMs` is gone: `sample` returns `null` and
 * the caller falls back to the token's stored rotation.
 *
 * @param {{staleMs?: number, tauMs?: number, maxEntries?: number}} [options]
 */
export function createRemoteAimStore({
  staleMs = AIM_STALE_MS,
  tauMs = AIM_SMOOTHING_TAU_MS,
  maxEntries = AIM_MAX_REMOTE_ENTRIES,
} = {}) {
  /** @type {Map<string, {targetDeg: number, currentDeg: number, targetReach: number|null, currentReach: number|null, targetBurn: number|null, currentBurn: number|null, receivedMs: number, sampledMs: number}>} */
  const entries = new Map();

  /** Advance one entry's displayed angle and reach to `nowMs`, toward the targets in force. */
  function advance(e, nowMs) {
    const dtMs = nowMs - e.sampledMs;
    e.currentDeg = smoothAngleDeg(e.currentDeg, e.targetDeg, dtMs, tauMs);
    e.currentReach =
      e.targetReach === null || e.currentReach === null
        ? e.targetReach
        : smoothScalar(e.currentReach, e.targetReach, dtMs, tauMs);
    e.currentBurn =
      e.targetBurn === null || e.currentBurn === null
        ? e.targetBurn
        : smoothScalar(e.currentBurn, e.targetBurn, dtMs, tauMs);
    e.sampledMs = nowMs;
  }

  function evictOldest() {
    let oldestId = null;
    let oldestMs = Infinity;
    for (const [id, e] of entries) {
      if (e.receivedMs < oldestMs) {
        oldestMs = e.receivedMs;
        oldestId = id;
      }
    }
    if (oldestId !== null) entries.delete(oldestId);
  }

  return {
    /**
     * @param {string} tokenId
     * @param {number} angleDeg
     * @param {number} nowMs
     * @param {number|null} [reachPx] - a held torch's distance from its bearer; `null` for none.
     * @param {number|null} [burn01] - a torch's burn (1 = full); `null` for none (burning).
     * @returns {boolean} whether it was stored (false for an unusable id/angle/time).
     */
    receive(tokenId, angleDeg, nowMs, reachPx = null, burn01 = null) {
      if (!isId(tokenId) || !Number.isFinite(angleDeg) || !Number.isFinite(nowMs)) return false;
      const targetDeg = normalizeAngleDeg(angleDeg);
      const targetReach = Number.isFinite(reachPx) && reachPx >= 0 ? reachPx : null;
      const targetBurn = Number.isFinite(burn01) ? Math.min(1, Math.max(0, burn01)) : null;
      const existing = entries.get(tokenId);
      if (existing && nowMs - existing.receivedMs <= staleMs) {
        advance(existing, nowMs); // up to NOW, toward the OLD targets — see this factory's header
        existing.targetDeg = targetDeg;
        existing.targetReach = targetReach;
        // A reach that has only just appeared has nothing to ease from: snap to it.
        if (existing.currentReach === null) existing.currentReach = targetReach;
        existing.targetBurn = targetBurn;
        if (existing.currentBurn === null) existing.currentBurn = targetBurn;
        existing.receivedMs = nowMs;
        return true;
      }
      if (!existing && entries.size >= maxEntries) evictOldest();
      entries.set(tokenId, {
        targetDeg,
        currentDeg: targetDeg,
        targetReach,
        currentReach: targetReach,
        targetBurn,
        currentBurn: targetBurn,
        receivedMs: nowMs,
        sampledMs: nowMs,
      });
      return true;
    },
    /**
     * @param {string} tokenId
     * @param {number} nowMs
     * @returns {{angleDeg: number, reachPx: number|null, burn01: number|null}|null} the smoothed aim to
     *   draw, or `null` if there is no fresh one.
     */
    sampleAim(tokenId, nowMs) {
      const e = entries.get(tokenId);
      if (!e) return null;
      if (nowMs - e.receivedMs > staleMs) {
        entries.delete(tokenId);
        return null;
      }
      advance(e, nowMs);
      return { angleDeg: e.currentDeg, reachPx: e.currentReach, burn01: e.currentBurn };
    },
    /**
     * @param {string} tokenId
     * @param {number} nowMs
     * @returns {number|null} the smoothed angle to draw, or `null` if there is no fresh aim.
     */
    sample(tokenId, nowMs) {
      return this.sampleAim(tokenId, nowMs)?.angleDeg ?? null;
    },
    /** Drop every expired entry (bounds memory when tokens vanish without a last message). */
    prune(nowMs) {
      for (const [id, e] of entries) {
        if (nowMs - e.receivedMs > staleMs) entries.delete(id);
      }
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    },
  };
}
