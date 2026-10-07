/**
 * PLAYER AIM — THE PURE HALF of "a carried flashlight points where its bearer's
 * cursor points" (mythica-machina-press#77). The live half — Foundry's pointer,
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
 * WHAT TRAVELS is one angle per aiming token, not a cursor position: a remote
 * client has no use for the cursor beyond its direction from the token, and the
 * beam already shows exactly that much.
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
 * The carried-light modes whose light has a direction the bearer can aim. Kept
 * as this zone's own copy rather than imported from `effects/lighting/player-
 * light-geometry.js` (a leaf adapter imports nothing above itself, and
 * `player-light-mode.js` already sets the precedent of a per-zone mode list);
 * `player-aim.test.mjs` fails if it ever disagrees with the presets that carry a
 * `beam` falloff.
 */
export const PLAYER_AIM_MODES = Object.freeze(['flashlight']);

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

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

/**
 * @param {{tokenId: string, angleDeg: number, userId: string}} fields
 * @returns {{type: string, tokenId: string, userId: string, a: number}|null} the
 *   socket payload, or `null` if any field is unusable (nothing half-valid is sent).
 */
export function encodeAimMessage({ tokenId, angleDeg, userId } = {}) {
  if (!isId(tokenId) || !isId(userId) || !Number.isFinite(angleDeg)) return null;
  return { type: AIM_MESSAGE_TYPE, tokenId, userId, a: quantizeAimAngleDeg(angleDeg) };
}

/**
 * The receiving half of {@link encodeAimMessage}. The module socket is shared
 * with other features (`impulse-broadcast.js`), so anything that is not this
 * feature's own message — or is malformed — decodes to `null`.
 * @param {*} msg
 * @returns {{tokenId: string, userId: string, angleDeg: number}|null}
 */
export function decodeAimMessage(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== AIM_MESSAGE_TYPE) return null;
  if (!isId(msg.tokenId) || !isId(msg.userId)) return null;
  if (typeof msg.a !== 'number' || !Number.isFinite(msg.a)) return null;
  return { tokenId: msg.tokenId, userId: msg.userId, angleDeg: normalizeAngleDeg(msg.a) };
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
 *   3. the angle moved at least `minDeltaDeg`;
 *   4. it moved by any amount and `settleMs` has passed (the FINAL angle of a
 *      sweep always lands exactly, not up to `minDeltaDeg` short);
 *   5. `keepaliveMs` has passed (late joiners and dropped volatile messages).
 *
 * @param {{minIntervalMs?: number, minDeltaDeg?: number, settleMs?: number, keepaliveMs?: number}} [options]
 */
export function createAimSendPolicy({
  minIntervalMs = AIM_SEND_MIN_INTERVAL_MS,
  minDeltaDeg = AIM_SEND_MIN_DELTA_DEG,
  settleMs = AIM_SEND_SETTLE_MS,
  keepaliveMs = AIM_SEND_KEEPALIVE_MS,
} = {}) {
  let tokenId = null;
  let lastSentDeg = null;
  let lastSentMs = 0;
  return {
    /**
     * @param {string} id - the aiming token.
     * @param {number} angleDeg - its current aim.
     * @param {number} nowMs
     * @returns {number|null} the (wire-quantized) angle to send now, or `null` to stay quiet.
     */
    decide(id, angleDeg, nowMs) {
      if (id !== tokenId) {
        tokenId = id;
        lastSentDeg = null;
      }
      if (!Number.isFinite(angleDeg) || !Number.isFinite(nowMs)) return null;
      const angle = quantizeAimAngleDeg(angleDeg);
      let send = lastSentDeg === null;
      if (!send) {
        const sinceMs = nowMs - lastSentMs;
        if (sinceMs < minIntervalMs) return null;
        const deltaDeg = Math.abs(shortestAngleDeltaDeg(lastSentDeg, angle));
        send = deltaDeg >= minDeltaDeg || (deltaDeg > 0 && sinceMs >= settleMs) || sinceMs >= keepaliveMs;
      }
      if (!send) return null;
      lastSentDeg = angle;
      lastSentMs = nowMs;
      return angle;
    },
    /** Forget what was sent, so the next `decide` sends immediately. */
    reset() {
      tokenId = null;
      lastSentDeg = null;
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
  /** @type {Map<string, {targetDeg: number, currentDeg: number, receivedMs: number, sampledMs: number}>} */
  const entries = new Map();

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
     * @returns {boolean} whether it was stored (false for an unusable id/angle/time).
     */
    receive(tokenId, angleDeg, nowMs) {
      if (!isId(tokenId) || !Number.isFinite(angleDeg) || !Number.isFinite(nowMs)) return false;
      const targetDeg = normalizeAngleDeg(angleDeg);
      const existing = entries.get(tokenId);
      if (existing && nowMs - existing.receivedMs <= staleMs) {
        existing.currentDeg = smoothAngleDeg(
          existing.currentDeg,
          existing.targetDeg,
          nowMs - existing.sampledMs,
          tauMs
        );
        existing.sampledMs = nowMs;
        existing.targetDeg = targetDeg;
        existing.receivedMs = nowMs;
        return true;
      }
      if (!existing && entries.size >= maxEntries) evictOldest();
      entries.set(tokenId, { targetDeg, currentDeg: targetDeg, receivedMs: nowMs, sampledMs: nowMs });
      return true;
    },
    /**
     * @param {string} tokenId
     * @param {number} nowMs
     * @returns {number|null} the smoothed angle to draw, or `null` if there is no fresh aim.
     */
    sample(tokenId, nowMs) {
      const e = entries.get(tokenId);
      if (!e) return null;
      if (nowMs - e.receivedMs > staleMs) {
        entries.delete(tokenId);
        return null;
      }
      e.currentDeg = smoothAngleDeg(e.currentDeg, e.targetDeg, nowMs - e.sampledMs, tauMs);
      e.sampledMs = nowMs;
      return e.currentDeg;
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
