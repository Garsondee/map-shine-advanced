/**
 * CRITTER TOKENS — how a nearby token disturbs a swarm.
 *
 * Pure; Node-tested; no THREE, no GPU. Mirrors `critter-weather.js`'s shape and its reason: a
 * fly/firefly's reaction to "something big just walked up" is the same KIND of external-world
 * signal as "it started raining" — computed once a frame from `world/token-activity.js`'s own
 * live snapshot, by `critter-subsystem.js`, and handed to the brain kernels as uniforms they read
 * directly. The difference from weather is that THIS signal is not uniform across the zone (a
 * token is five lengths from one agent and five hundred from another), so unlike `weatherDrive`'s
 * four eased scalars, what travels to the GPU is raw POSITIONS — the per-agent distance math
 * happens once per agent, in the kernel, exactly the "a few many-input slots, JS-unrolled" shape
 * `mantle-runtime.js#setStamps` already uses for the identical reason (and the identical reason
 * `smelly-flies.js`'s own long-standing "startle" idea named: *"a small list of token positions...
 * the kernel already has the takeoff transition; what it lacks is a disturbance source"*).
 *
 * ⚠️ MAGGOTS DO NOT READ THIS. They live IN the thing being eaten and crawl at a few pixels a
 * second; a maggot does not take off ahead of a footstep, it is stepped on. Scoped to flies and
 * fireflies only — see `critter-subsystem.js`'s own call site.
 *
 * @module effects/critters/critter-token
 */

/** How many nearby tokens reach the GPU — a fixed, JS-unrolled set of uniforms (`critter-uniforms.js`'s
 * `tokenPos0`..`tokenPos{N-1}`), never a `uniformArray` + `Loop` (see `mantle-runtime.js`'s own note on
 * why that combination is live-confirmed broken on this renderer). Most scenes have far fewer tokens
 * than this near any one swarm; the ones that don't still only miss the FARTHEST excess movers. */
export const TOKEN_SLOTS = 8;

/** The sentinel an empty slot holds: a position so far outside any real map that it can never be the
 * nearest token to a real agent. Plain, not NaN/Infinity — a brain kernel's `length(s.P - slot)` stays
 * finite and simply loses every comparison, no special-case needed at the call site. */
export const TOKEN_SLOT_FAR = -1e7;

/**
 * The up-to-`maxCount` tokens nearest `center` (a zone's own home/centroid), nearest first, padded
 * with the far sentinel. A token farther from every agent in the zone than the startle radius
 * contributes nothing once it reaches the kernel anyway, so picking by distance-to-centre rather than
 * arbitrary array order is what keeps a crowded scene's SLOT budget spent on the tokens that could
 * plausibly matter to THIS swarm, not whichever eight happened to be enumerated first.
 *
 * @param {Array<{x: number, y: number, hidden?: boolean}>} points - `foundry/token-activity.js#TokenPoint[]`.
 * @param {{x: number, y: number}} center
 * @param {number} [maxCount]
 * @returns {Array<{x: number, y: number}>} exactly `maxCount` entries, always.
 */
export function nearestTokenSlots(points, center, maxCount = TOKEN_SLOTS) {
  const cx = Number.isFinite(center?.x) ? center.x : 0;
  const cy = Number.isFinite(center?.y) ? center.y : 0;
  const cap = Number.isFinite(maxCount) && maxCount > 0 ? Math.floor(maxCount) : TOKEN_SLOTS;

  const ranked = (Array.isArray(points) ? points : [])
    .filter((p) => p && !p.hidden && Number.isFinite(p.x) && Number.isFinite(p.y))
    .map((p) => ({ x: p.x, y: p.y, d2: (p.x - cx) ** 2 + (p.y - cy) ** 2 }))
    .sort((a, b) => a.d2 - b.d2)
    .slice(0, cap);

  const slots = [];
  for (let i = 0; i < cap; i++) {
    const r = ranked[i];
    slots.push(r ? { x: r.x, y: r.y } : { x: TOKEN_SLOT_FAR, y: TOKEN_SLOT_FAR });
  }
  return slots;
}

/** Every param id {@link nearestTokenSlots}'s CALLERS consume (the response/radius pair declared per
 * effect by `critter-params.js#tokenParams`) — listed here for the same self-documenting reason
 * `critter-weather.js#WEATHER_DRIVE_PARAMS` lists its own: a reader can see the whole contract in
 * one place without grepping three species files. */
export const TOKEN_STARTLE_PARAMS = Object.freeze(['tokenStartleResponse', 'tokenStartleRadius']);
