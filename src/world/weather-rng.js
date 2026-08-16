/**
 * THE ALMANAC'S DICE — a seeded, deterministic PRNG (docs/planning/Weather-Manager.md §5.4).
 *
 * ============================================================================
 * WHY THIS EXISTS: "same seed + same clock path ⇒ same weather"
 * ============================================================================
 *
 * `Math.random()` cannot give that property — it cannot be seeded, cannot be
 * snapshotted, and cannot be replayed. Two things the Almanac needs it for:
 *
 *   1. **The forecast is free.** "Running the walk ahead without applying it"
 *      (§5.4, and `astrolabe.js`'s Horizon forecast strip) means cloning the
 *      walk's random state and simulating forward on the CLONE — the live
 *      manager is never touched. That requires the generator's entire state to
 *      be one small, copyable value, which `Math.random()`'s is not.
 *   2. **A reproducible bug report.** "The sky did something weird at hour 14
 *      with seed 8829102" has to mean something concrete a future session can
 *      replay exactly — `Math.random()` cannot promise that either.
 *
 * Not cryptographic, and does not need to be — this is weather for a tabletop
 * map, not a security boundary. mulberry32 is chosen for being small (one
 * 32-bit integer of state), fast, and well-characterised for exactly this
 * "good enough for games, not for keys" tier.
 *
 * ============================================================================
 * THE STATE IS THE WHOLE POINT
 * ============================================================================
 *
 * `next()` mutates `state` in place and returns a float in `[0, 1)`.
 * `getState()`/`fromState()` are the snapshot/restore pair the forecast is
 * built on: `fromState(rng.getState())` produces an INDEPENDENT generator that
 * will draw the identical sequence the original would have, from this point
 * forward, without the original ever advancing. Two objects, one trajectory,
 * until one of them actually calls `next()`.
 *
 * Pure. No `Math.random`, no `Date.now`, no global state — every value comes
 * from an argument and every generator is its own closure.
 *
 * @module world/weather-rng
 */

/**
 * Fold arbitrary parts (strings, numbers) into one 32-bit unsigned seed.
 *
 * FNV-1a, chosen for the same reason as the generator itself: small, fast,
 * good enough avalanche behaviour that two similar scene names or two
 * consecutive epoch indices do not produce visibly-related seeds.
 *
 * @param {...(string|number)} parts
 * @returns {number} a 32-bit unsigned integer.
 */
export function hashSeed(...parts) {
  let h = 0x811c9dc5; // FNV offset basis
  const s = parts.map((p) => String(p)).join('');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime multiply, done as shifts/adds so it stays inside int32 math
    // (Math.imul would also work; this avoids the dependency for a tiny loop).
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

/**
 * Create a generator seeded from `seed` (coerced to a 32-bit unsigned int via
 * {@link hashSeed} if it is not already a finite number).
 * @param {number|string} seed
 * @returns {{next: () => number, getState: () => number}}
 */
export function createRng(seed) {
  const s = Number.isFinite(seed) ? seed >>> 0 : hashSeed(seed);
  return fromState(s);
}

/**
 * Resume a generator from a previously captured state — the forecast's entire
 * mechanism. `state` should be a value {@link createRng} or a prior
 * `getState()` produced; anything else is coerced the same way `createRng`
 * coerces a fresh seed, so a corrupt persisted value degrades to "a new seed"
 * rather than throwing mid-frame.
 * @param {number} state
 * @returns {{next: () => number, getState: () => number}}
 */
export function fromState(state) {
  let a = Number.isFinite(state) ? state >>> 0 : hashSeed(state);
  return {
    /** @returns {number} a float in [0, 1). */
    next() {
      // mulberry32 — public domain, widely used, one line worth citing in
      // full since every implementation online is this same nine-line body.
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** @returns {number} the raw 32-bit state, for snapshotting. */
    getState() {
      return a >>> 0;
    },
  };
}

/**
 * Sample a triangular distribution — the natural fit for `{min, mean, max}`
 * dwell data (a mode is not exactly a mean, but this project's data uses
 * "mean" as the plain-language label for the row's most-likely value, and the
 * inverse-CDF method below treats it as the distribution's mode).
 *
 * Standard inverse-CDF construction: below the mode, the CDF is
 * `(x-min)²/((max-min)(mode-min))`; above it, the mirror image. Degenerates
 * gracefully rather than dividing by zero — a row with `min === max` (a fixed
 * dwell) or `mode` sitting outside `[min, max]` (bad authored data) both
 * return a sane number instead of `NaN` leaking into a game-hours delta.
 *
 * @param {{next: () => number}} rng
 * @param {number} min @param {number} mode @param {number} max
 * @returns {number}
 */
export function triangular(rng, min, mode, max) {
  const lo = Number.isFinite(min) ? min : 0;
  // ⚠️ "max is missing/NaN" and "max legitimately equals min" must resolve
  // differently — collapsing both into "bump hi up by one" (an earlier draft
  // of this function did exactly that) silently turns every FIXED dwell
  // (min===mode===max, a deliberate "always exactly N hours" row) into a
  // fake 1-unit-wide range instead of the constant it was authored as.
  let hi = Number.isFinite(max) ? max : lo;
  if (hi < lo) hi = lo; // inverted/corrupt data still returns something sane
  if (hi === lo) return lo; // degenerate: a fixed value, not a range
  const m = Number.isFinite(mode) ? Math.min(hi, Math.max(lo, mode)) : (lo + hi) / 2;
  const u = rng.next();
  const c = (m - lo) / (hi - lo);
  if (u < c) return lo + Math.sqrt(u * (hi - lo) * (m - lo));
  return hi - Math.sqrt((1 - u) * (hi - lo) * (hi - m));
}

/**
 * Weighted choice among `items`, using `weightFn(item) => number` (negative
 * or non-finite weights treated as 0 — a bad weight excludes an item rather
 * than corrupting the draw).
 *
 * Returns `null` on an empty list or when every weight is zero, so the ONLY
 * question the walk needs to ask its caller ("is there anywhere to go from
 * here") is answerable without a sentinel item or a thrown error
 * (`feedback_gate_polarity_must_fail_open`'s posture — a biome whose current
 * archetype has no live edges must not crash the frame, the walk should just
 * hold where it is).
 *
 * @template T
 * @param {{next: () => number}} rng
 * @param {T[]} items
 * @param {(item: T) => number} weightFn
 * @returns {T|null}
 */
export function weightedPick(rng, items, weightFn) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const weights = items.map((it) => {
    const w = Number(weightFn(it));
    return Number.isFinite(w) && w > 0 ? w : 0;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let roll = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  // Floating-point fallthrough (roll landed exactly on the boundary of the
  // last item) — the last item, never a null the caller has to special-case
  // for a real, positive-weight list.
  return items[items.length - 1];
}
