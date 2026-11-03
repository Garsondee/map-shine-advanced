/**
 * FIRE — WHAT A VIEWED FLOOR CAN SEE OF THE FLOORS BELOW IT (2026-11-03).
 *
 * A painted `_Fire` region belongs to the floor whose art carries it, and the fire sources, the ember spawn cloud and
 * the flame's mask clip are all read from ONE grid per viewed floor. So a fire painted on the middle floor of the Town
 * River Bridge burned while you stood on the middle floor and vanished the moment you climbed to the roof, even though
 * the roof looks straight down onto it. (The ground-floor fire DID show from above, but only by accident: a tile named
 * on all three Levels hosts that floor's paint for every one of them. A fire on a floor with no such tile had no way in.)
 *
 * The rule: a viewer standing on floor F sees a lower floor L's fire wherever the art between them does not cover it.
 * `coverAbove` of L is exactly that art ("upper-floor grounds, this floor's own roof art, overhead tiles"), so the
 * fire L contributes at a texel is `fire × (1 − coverAbove)`. The viewed floor's own paint is never dimmed, and the
 * result is a plain grid, so every downstream reader (extraction, spawn cloud, mask clip, label grid) works unchanged.
 *
 * Pure over `MaskGrid`s, no THREE, Node-tested.
 */

/** Two grids are cell-for-cell comparable only when their specs agree on every field that places a cell. */
function sameSpec(a, b) {
  return (
    !!a &&
    !!b &&
    a.w === b.w &&
    a.h === b.h &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

/**
 * @param {{spec: object, data: Uint8Array}|null} own - the viewed floor's own `_Fire` grid.
 * @param {Array<{fire: {spec: object, data: Uint8Array}|null, cover: {spec: object, data: Uint8Array}|null}>} lowers -
 *   every floor below the viewed one: its `_Fire` grid and its `coverAbove` grid. A floor with no fire paint, or whose
 *   cover is unavailable (we cannot prove its fire is in view), contributes nothing.
 * @returns {{grid: {spec: object, data: Uint8Array}|null, contributors: number}} `grid` IS `own` (same object) when
 *   no lower floor adds a single lit texel, so callers keep their identity-keyed caches.
 */
export function unionVisibleFireGrid(own, lowers) {
  let out = null;
  let contributors = 0;
  for (const { fire, cover } of lowers ?? []) {
    if (!fire?.data || !cover?.data || !sameSpec(fire.spec, cover.spec)) continue;
    if (own && !sameSpec(own.spec, fire.spec)) continue;
    const n = fire.data.length;
    if (cover.data.length !== n) continue;
    let added = false;
    for (let i = 0; i < n; i++) {
      const f = fire.data[i];
      if (f === 0) continue;
      const v = Math.round((f * (255 - cover.data[i])) / 255);
      if (v === 0) continue;
      if (!out) {
        out = { spec: fire.spec, data: own?.data ? Uint8Array.from(own.data) : new Uint8Array(n) };
      }
      if (v > out.data[i]) {
        out.data[i] = v;
        added = true;
      }
    }
    if (added) contributors++;
  }
  return { grid: contributors > 0 ? out : own, contributors };
}
