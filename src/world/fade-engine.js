/**
 * THE FADE ENGINE — time as a first-class value (docs/holy/UI-Testament.md
 * §4.2). U2, checkpoint 2.
 *
 * ============================================================================
 * "ANY CONFIGURATION TO ANY OTHER" — WHY THIS IS ONE FLAT MAP, NOT
 * channels{}/params{} (a deliberate departure from the Testament's own sketch)
 * ============================================================================
 *
 * §4.2's record example splits `channels` (world weather axes) from `params`
 * (effect values) into two maps on one record. Building it, that split adds
 * friction for no real gain: a "configuration" the author asked this engine
 * to support — fade from ANY snapshot of the world to ANY other — does not
 * care whether a given knob happens to live on a world axis or an effect;
 * both are just a named VALUE with a TYPE. So this module works over ONE
 * flat map, `Record<string, FadeEntry>`, keyed by a namespaced string
 * (`'water.depth'`, `'weather.cloudCover01'`, `'sky.todHour'`) — the
 * namespace is resolved by fade-registry.js, this file never looks at it.
 * Flagged for the author's countersign in Petition P12, not silently
 * substituted for the written Law.
 *
 * ============================================================================
 * "AUTOMATICALLY EXPANDS AS WE ADD MORE EFFECTS" — WHERE THAT PROPERTY
 * ACTUALLY LIVES
 * ============================================================================
 *
 * NOT here. This file has zero knowledge of effects, water, weather, or
 * Foundry — it knows five value TYPES it can smoothly blend between (see
 * `FADEABLE_TYPES`) and does per-type interpolation on request. The
 * auto-expansion property lives in `fade-registry.js`: every effect ALREADY
 * declares its params against `core/params-schema.js#PARAM_TYPES` for its
 * Studio card (`ui/rooms/studio/shell.js#registerEffectCard`'s
 * `{schema, getValue, onChange}`) — `fade-registry.js#schemaFadeSource` wraps
 * that EXACT triple into a fade source with no new per-effect surface. A
 * 16th effect becomes fadeable the moment it gets a Studio card, which it
 * already needs for its OWN sake. Adding a new value TYPE (rare — the last
 * one, `angle`, landed 2026-08-16 for water's flow direction) is the only
 * thing that touches THIS file; adding a new EFFECT never does.
 *
 * ============================================================================
 * THE LAWS THIS FILE IMPLEMENTS (§4.2, restated as code)
 * ============================================================================
 *
 *   - **One writer, many derivers.** Every function below is PURE: given the
 *     same `(state, nowMs)`, every client computes the identical eased
 *     value. `foundry/fade-persistence.js` is the one writer (a scene flag);
 *     nothing here talks to Foundry at all.
 *   - **Reload survival, for free, by construction.** `startedAtMs` is a
 *     WALL-CLOCK timestamp baked into each entry; `computeEasedValue` is a
 *     pure function of `(entry, nowMs)` with no other state to lose. There is
 *     no separate "resume" step to forget to call — see this file's own test
 *     suite's "reload mid-fade" case, which proves it by calling nothing
 *     BETWEEN two `computeEasedValue` calls at different `nowMs`.
 *   - **Replace, don't queue.** `mergeFadeState` — starting a new fade on a
 *     key captures that key's CURRENT eased value as the new `from`; keys
 *     outside the patch are carried over untouched (disjoint fades coexist).
 *   - **Cut and snap.** `cancelEntry` (hold at the live value) and
 *     `snapEntry` (jump straight to `to`) — the Now Playing ring's own two
 *     handles.
 *   - **Pure core, thin shell.** Curve math, merge, resume and expiry are
 *     here, Node-tested. DOM and scene flags are `fade-persistence.js`.
 *
 * @module world/fade-engine
 */

import { FADEABLE_PARAM_TYPES, isFadeableParamType, FADE_CURVES } from '../core/params-schema.js';

/**
 * Re-exported under this module's own established names (this file's every
 * existing consumer — `fade-registry.js`, its own test suite, `world/
 * index.js`, boot.js — already imports `FADEABLE_TYPES`/`isFadeableType`/
 * `CURVES` from HERE) — the canonical declarations moved to
 * `core/params-schema.js` so `core/cues-schema.js` (U3) can use the
 * identical fadeability/curve answers without `core/` ever importing
 * `world/` (confirmed empirically: no `core/` file does, anywhere in this
 * codebase — `world/` depends on `core/`, never the reverse). One true
 * list each, two consumers, never two copies free to drift apart.
 * @type {readonly string[]}
 */
export const FADEABLE_TYPES = FADEABLE_PARAM_TYPES;
export const isFadeableType = isFadeableParamType;
/** @type {readonly string[]} */
export const CURVES = FADE_CURVES;

/** @param {number} t @returns {number} */
function clamp01(t) {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * `'ease'` is Foundry's own default cosine ease
 * (`CanvasAnimation.easeInOutCosine`, already this codebase's convention —
 * see `foundry/camera-path.js#resolveEasingFn`), not reinvented here.
 * `'smoothstep'` is the classic 3t²−2t³ polynomial — visually close to
 * `'ease'` but a distinct curve, so the two options in the Testament's own
 * enum are actually different shapes, not the same formula twice.
 * `'hold-snap'`: 0 for the whole window, 1 only once it fully closes — a
 * fade that waits, then cuts, rather than a continuous blend.
 */
const CURVE_FNS = Object.freeze({
  linear: (t) => t,
  ease: (t) => 0.5 - 0.5 * Math.cos(t * Math.PI),
  smoothstep: (t) => t * t * (3 - 2 * t),
  'hold-snap': (t) => (t >= 1 ? 1 : 0),
});

/**
 * @param {string} curve @param {number} t01
 * @returns {number} unrecognized curves fall back to linear rather than
 *   throwing — a stale/foreign curve name in a synced record must not stop
 *   every OTHER client from deriving a value.
 */
export function shapeProgress(curve, t01) {
  const fn = CURVE_FNS[curve] ?? CURVE_FNS.linear;
  return fn(clamp01(t01));
}

/**
 * @typedef {object} FadeEntry
 * @property {*} from
 * @property {*} to
 * @property {string} type - one of {@link FADEABLE_TYPES}.
 * @property {number} startedAtMs - WALL CLOCK (never the sim clock — the
 *   throttle-latch scar this codebase already carries a named memory for).
 * @property {number} overMs - 0 = an instant cut.
 * @property {string} curve - one of {@link CURVES}.
 * @property {string} [id] - group tag: several entries started by the same
 *   gesture ("Dusk falls") share one id, so cancel/snap can act on the whole
 *   group. Optional — an ad-hoc single-key fade needs none.
 * @property {string} [label] - shown on the Now Playing ring's hover.
 */

/**
 * Raw (uneased) progress through the fade's WALL-CLOCK window — 0 before it
 * starts, 1 once `overMs` has fully elapsed. This is what `isEntryExpired`
 * and pruning use; `progressOf` below is what interpolation uses.
 * @param {FadeEntry} entry @param {number} nowMs @returns {number} 0..1
 */
export function rawProgress(entry, nowMs) {
  if (!(entry.overMs > 0)) return 1; // overMs:0 — an instant cut, always "arrived"
  return clamp01((nowMs - entry.startedAtMs) / entry.overMs);
}

/** @param {FadeEntry} entry @param {number} nowMs @returns {number} 0..1, curve-shaped */
export function progressOf(entry, nowMs) {
  return shapeProgress(entry.curve, rawProgress(entry, nowMs));
}

/** @param {FadeEntry} entry @param {number} nowMs @returns {boolean} */
export function isEntryExpired(entry, nowMs) {
  return rawProgress(entry, nowMs) >= 1;
}

// ============================================================================
// PER-TYPE INTERPOLATION — the dispatch a new EFFECT never has to touch.
// ============================================================================

/** @param {number} a @param {number} b @param {number} t @returns {number} */
function lerpNum(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Shortest-arc blend for a cyclic 0..360 value — 350 → 10 sweeps FORWARD
 * through 360/0 (a 20° arc), never backward through 180 (a 340° arc). Same
 * "signed shortest delta, then wrap the result" shape
 * `core/params-schema.js`'s own angle WRAP uses for a single write, applied
 * here to a continuous blend across the whole window instead.
 * @param {number} a @param {number} b @param {number} t @returns {number} 0..360
 */
function lerpAngle(a, b, t) {
  const delta = ((((b - a + 540) % 360) + 360) % 360) - 180;
  return (((a + delta * t) % 360) + 360) % 360;
}

/** @param {string} hex @returns {{r:number,g:number,b:number}|null} */
function parseHex6(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex ?? '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Per-channel sRGB byte lerp — a simple, honest blend for a UI-level fade,
 * not a colour-managed one; a genuinely perceptual ramp is a future
 * refinement, not something to silently claim here.
 * @param {string} a @param {string} b @param {number} t @returns {string} `#rrggbb` */
function lerpColorHex(a, b, t) {
  const pa = parseHex6(a);
  const pb = parseHex6(b);
  if (!pa || !pb) return t >= 1 ? b : a; // malformed hex: hold, then snap — never throw mid-fade
  const round = (x) => Math.max(0, Math.min(255, Math.round(x)));
  const byte = (av, bv) =>
    round(lerpNum(av, bv, t))
      .toString(16)
      .padStart(2, '0');
  return `#${byte(pa.r, pb.r)}${byte(pa.g, pb.g)}${byte(pa.b, pb.b)}`;
}

/** @param {number[]} a @param {number[]} b @param {number} t @returns {number[]} */
function lerpVec(a, b, t) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return t >= 1 ? b : a;
  return a.map((av, i) => lerpNum(av, Number(b[i]), t));
}

/**
 * DISCRETE types have no partial state — `bool`/`enum` hold their `from`
 * value for the entire window and flip to `to` only once it fully closes.
 * The curve still shapes the progress RING (so a Now Playing display keeps
 * moving smoothly), it just never expresses a half-flipped boolean.
 * @param {*} a @param {*} b @param {number} t @returns {*}
 */
function snapAtCompletion(a, b, t) {
  return t >= 1 ? b : a;
}

const INTERPOLATORS = Object.freeze({
  float: (a, b, t) => lerpNum(a, b, t),
  int: (a, b, t) => Math.round(lerpNum(a, b, t)),
  angle: (a, b, t) => lerpAngle(a, b, t),
  color: (a, b, t) => lerpColorHex(a, b, t),
  vec2: (a, b, t) => lerpVec(a, b, t),
  vec3: (a, b, t) => lerpVec(a, b, t),
  bool: snapAtCompletion,
  enum: snapAtCompletion,
});

/**
 * The eased value of ONE entry, at `nowMs`. PURE, and everything it needs is
 * ON the entry — this is the literal implementation of "one writer, many
 * derivers": any client holding the same entry computes the same value.
 * @param {FadeEntry} entry @param {number} nowMs @returns {*}
 */
export function computeEasedValue(entry, nowMs) {
  const t = progressOf(entry, nowMs);
  const fn = INTERPOLATORS[entry.type];
  // An unrecognised type (a future PARAM_TYPES addition this file has not
  // learned yet, or a corrupted record) degrades to hold-then-snap rather
  // than throwing — a client one version behind must still derive SOMETHING
  // usable, per this project's own fail-open doctrine.
  if (!fn) return snapAtCompletion(entry.from, entry.to, t);
  return fn(entry.from, entry.to, t);
}

// ============================================================================
// BATCH OPERATIONS — "any configuration to any other", as data.
// ============================================================================

/**
 * @typedef {object} FadeTargetRequest
 * @property {*} to
 * @property {string} type
 * @property {number} overMs
 * @property {string} curve
 * @property {*} from - the CALLER's live-read fallback, used only when there
 *   is no already-running entry for this key to capture an eased value from.
 *   Reading "the current live value of X" is I/O; this module stays pure by
 *   requiring the caller to have already done that read.
 */

/**
 * THE REPLACE-DON'T-QUEUE LAW, as one pure function. A "fade to configuration
 * C" is just: call this once with every key in C as a target.
 *
 * @param {Record<string, FadeEntry>} currentState
 * @param {{id?: string, label?: string, targets: Record<string, FadeTargetRequest>}} patch
 * @param {number} nowMs
 * @returns {Record<string, FadeEntry>} a NEW map — never mutates `currentState`.
 */
export function mergeFadeState(currentState, patch, nowMs) {
  const next = { ...currentState };
  for (const [key, req] of Object.entries(patch?.targets ?? {})) {
    const running = currentState[key];
    // The heart of "replace, don't queue": interrupt smoothly from wherever
    // this key ACTUALLY is right now, not from its long-since-passed original
    // `from` and not from a jarring jump to the live value.
    const from = running ? computeEasedValue(running, nowMs) : req.from;
    next[key] = {
      from,
      to: req.to,
      type: req.type,
      startedAtMs: nowMs,
      overMs: Math.max(0, Number(req.overMs) || 0),
      curve: CURVES.includes(req.curve) ? req.curve : 'linear',
      id: patch?.id,
      label: patch?.label,
    };
  }
  return next;
}

/**
 * Drop every fully-expired entry. Pure housekeeping, safe on any cadence — a
 * client that skips a prune cycle just derives from a slightly larger (still
 * correct) map; nothing depends on pruning having happened.
 * @param {Record<string, FadeEntry>} state @param {number} nowMs
 * @returns {Record<string, FadeEntry>}
 */
export function pruneExpired(state, nowMs) {
  const next = {};
  for (const [key, entry] of Object.entries(state ?? {})) {
    if (!isEntryExpired(entry, nowMs)) next[key] = entry;
  }
  return next;
}

/**
 * CANCEL: hold at the current eased value forever — an instant zero-length
 * fade from "here" to "here". No-op if the key isn't running.
 * @param {Record<string, FadeEntry>} state @param {string} key @param {number} nowMs
 * @returns {Record<string, FadeEntry>}
 */
export function cancelEntry(state, key, nowMs) {
  const entry = state?.[key];
  if (!entry) return state;
  const held = computeEasedValue(entry, nowMs);
  return { ...state, [key]: { ...entry, from: held, to: held, startedAtMs: nowMs, overMs: 0 } };
}

/**
 * SNAP: jump straight to `to`, ending the fade immediately. No-op if the key
 * isn't running.
 * @param {Record<string, FadeEntry>} state @param {string} key @param {number} nowMs
 * @returns {Record<string, FadeEntry>}
 */
export function snapEntry(state, key, nowMs) {
  const entry = state?.[key];
  if (!entry) return state;
  return { ...state, [key]: { ...entry, from: entry.to, startedAtMs: nowMs, overMs: 0 } };
}

/**
 * Every currently-live value in the state, derived at `nowMs` — what a
 * renderer actually reads each frame.
 * @param {Record<string, FadeEntry>} state @param {number} nowMs
 * @returns {Record<string, *>}
 */
export function deriveAllValues(state, nowMs) {
  const out = {};
  for (const [key, entry] of Object.entries(state ?? {})) out[key] = computeEasedValue(entry, nowMs);
  return out;
}
