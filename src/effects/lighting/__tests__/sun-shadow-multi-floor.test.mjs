/**
 * MULTI-FLOOR SUN SHADOWS, pinned (2026-08-02).
 *
 * Author, live, on the real Town River Bridge map, after the alpha-slot fix
 * landed: *"when I'm on the middle floor and I'm looking down through a gap
 * in the map I can't see the shadow of the ground floor... when I go up to
 * [the roof] floor I can see shadows which should only be visible on the
 * ground floor. Occlusion of floors below isn't working correctly."*
 *
 * Root cause: this subsystem baked exactly ONE floor's shadow field at a time
 * (`maybeBake(floorIndex)`, called once per frame with `view.floorIndex` —
 * the UI's "current floor", not "every floor Foundry is drawing"), and
 * `environmental-light.js`'s per-fragment floor gate (2026-07-28) correctly
 * REFUSED to apply that one field to any OTHER floor's content — which starved
 * every other floor of shadows entirely. Foundry v14 natively composites
 * several floors in one frame (`scene.levels`, gaps and all), so this was
 * always going to show exactly the two symptoms reported.
 *
 * The fix has two halves, each tested here at the level that does NOT need a
 * real THREE/GPU (`environmental-light.test.mjs`'s own header states the
 * house rule this file follows: the TSL graph itself is browser-only, not a
 * mocked THREE — CONVENTIONS.md §4):
 *
 *   1. `assignFloorSlotIndex` — pure slot-assignment bookkeeping
 *      (`sun-shadow-subsystem.js`), no THREE at all.
 *   2. A CPU-twin proof of `environmental-light.js#blendSunVisibilityAcrossFloors`'s
 *      ARITHMETIC (never `select()` — `feedback_tsl_select_chain_strands_vars`),
 *      reimplemented in plain JS numbers and checked against the properties the
 *      real TSL formula must have: N=1 collapses to the pre-multi-floor
 *      `mix(1, sunVis, weight)`, floors are mutually exclusive, and an
 *      unmatched fragment defaults to fully lit.
 */
import * as THREE from '../../../vendor/three/three.webgpu.js';
import { assignFloorSlotIndex } from '../sun-shadow-subsystem.js';
import { blendSunVisibilityAcrossFloors } from '../environmental-light.js';

/**
 * Plain-number reimplementation of `blendSunVisibilityAcrossFloors`'s formula
 * — see that function's own header in environmental-light.js for the TSL
 * original. Ported line-for-line, arithmetic operator for arithmetic
 * operator, so a mismatch here is a mismatch there.
 * @param {number} attrFloorIndex01
 * @param {Array<{sunVis:number, floorIndex01:number}>} slots
 */
function blendSunVisibilityCpuTwin(attrFloorIndex01, slots) {
  const smoothstep01 = (edge0, edge1, x) => {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  let totalWeight = 0;
  let blended = 0;
  for (const slot of slots) {
    const weight = 1 - smoothstep01(0.4 / 255, 0.9 / 255, Math.abs(attrFloorIndex01 - slot.floorIndex01));
    blended += slot.sunVis * weight;
    totalWeight += weight;
  }
  return blended + (1 - totalWeight);
}

export function run(t) {
  const { ok } = t;

  // ── assignFloorSlotIndex: first-come, permanent, capped ──────────────
  {
    const map = new Map();
    const a = assignFloorSlotIndex(map, 2, 6); // roof asked for first, live sequence
    const b = assignFloorSlotIndex(map, 0, 6);
    const c = assignFloorSlotIndex(map, 1, 6);
    ok('the first NEW floor asked for claims slot 0, regardless of its own floorIndex', a === 0);
    ok('the second NEW floor claims slot 1', b === 1);
    ok('the third NEW floor claims slot 2', c === 2);

    // ── RE-ASKING FOR AN ALREADY-CLAIMED FLOOR RETURNS THE SAME SLOT ──
    // This is the property the per-frame bake loop depends on: floor 2 (the
    // roof) is asked for every frame, and it must land in the SAME texture
    // every time or the consumer's per-slot uniforms would be pointing at a
    // moving target.
    ok('re-asking for floor 2 returns its ORIGINAL slot 0, not a new one', assignFloorSlotIndex(map, 2, 6) === 0);
    ok('re-asking for floor 0 returns 1', assignFloorSlotIndex(map, 0, 6) === 1);

    // ── THE CAP IS REAL ──────────────────────────────────────────────
    assignFloorSlotIndex(map, 3, 6);
    assignFloorSlotIndex(map, 4, 6);
    assignFloorSlotIndex(map, 5, 6);
    ok('six floors exactly fill a 6-slot pool', map.size === 6);
    const overflow = assignFloorSlotIndex(map, 6, 6);
    ok(`a 7th NEW floor gets -1, not a 7th slot that does not exist (got ${overflow})`, overflow === -1);
    ok('the overflow floor is NOT recorded as claiming anything', !map.has(6));
    ok(
      'an EXISTING floor can still be re-asked-for even while the pool is full (no accidental eviction)',
      assignFloorSlotIndex(map, 2, 6) === 0
    );
  }

  // ── assignFloorSlotIndex: independent maps never cross-contaminate ────
  {
    const mapA = new Map();
    const mapB = new Map();
    assignFloorSlotIndex(mapA, 0, 6);
    ok(
      'a SEPARATE slotIndexByFloor map (a second subsystem instance) starts fresh',
      assignFloorSlotIndex(mapB, 0, 6) === 0 && mapA !== mapB
    );
  }

  // ── assignFloorSlotIndex: a cap of 1 is a real, usable degenerate case ──
  {
    const map = new Map();
    ok('a 1-slot pool assigns its only slot', assignFloorSlotIndex(map, 5, 1) === 0);
    ok('a second floor against a 1-slot pool overflows immediately', assignFloorSlotIndex(map, 6, 1) === -1);
  }

  // ── THE ARITHMETIC BLEND: N=1 is BYTE-IDENTICAL to the pre-multi-floor
  // formula ─────────────────────────────────────────────────────────────
  // This is the regression guard: the whole point of writing the blend as a
  // weighted sum instead of a select()/branch fold was that it must reduce to
  // exactly `mix(1, sunVis, weight)` when there is only one slot — anything
  // else would mean a single-floor scene's shadows changed shape from this
  // rewrite, which nothing about this fix was supposed to touch.
  {
    const legacyMix = (a, b, t) => a * (1 - t) + b * t;
    const weightOf = (attrIdx, slotIdx) => {
      const t = Math.max(0, Math.min(1, (Math.abs(attrIdx - slotIdx) - 0.4 / 255) / (0.5 / 255)));
      return 1 - t * t * (3 - 2 * t);
    };

    for (const [attrIdx, slotIdx, sunVis] of [
      [0, 0, 0.3],
      [2 / 255, 2 / 255, 0.7],
      [1 / 255, 3 / 255, 0.9], // a genuine MISMATCH — off the one slot
      [5 / 255, 5 / 255, 0],
    ]) {
      const weight = weightOf(attrIdx, slotIdx);
      const legacy = legacyMix(1, sunVis, weight);
      const twin = blendSunVisibilityCpuTwin(attrIdx, [{ sunVis, floorIndex01: slotIdx }]);
      ok(
        `N=1 matches the legacy mix(1, sunVis, weight) formula exactly (attr=${attrIdx.toFixed(3)}, slot=${slotIdx.toFixed(3)}, got ${twin.toFixed(6)} vs ${legacy.toFixed(6)})`,
        Math.abs(twin - legacy) < 1e-9
      );
    }
  }

  // ── THE ARITHMETIC BLEND: an unclaimed slot's -1 sentinel never matches ──
  // The exact mechanism the multi-floor fix depends on: an UNCLAIMED slot's
  // floorIndex01 sits at -1/255, and NO real fragment (attrFloorIndex01 is
  // always a real 0..255/255 byte) can ever read a weight above 0 against it.
  {
    const SENTINEL = -1 / 255;
    for (const realFloor01 of [0, 1 / 255, 2 / 255, 5 / 255, 1]) {
      const result = blendSunVisibilityCpuTwin(realFloor01, [
        { sunVis: 0 /* even if it WOULD read black */, floorIndex01: SENTINEL },
      ]);
      ok(
        `a real fragment (attr=${realFloor01.toFixed(3)}) against an UNCLAIMED slot reads fully lit (got ${result.toFixed(6)}), never the slot's own content`,
        Math.abs(result - 1) < 1e-6
      );
    }
  }

  // ── THE ARITHMETIC BLEND: multiple slots, mutual exclusivity ───────────
  // Three floors' fields, one fragment that belongs to the middle one. Only
  // ITS sunVis may show through; the other two floors' content (deliberately
  // set to the OPPOSITE value, 1, so a leak would be obvious) must not.
  {
    const slots = [
      { sunVis: 1, floorIndex01: 0 / 255 }, // floor 0 — NOT this fragment's floor
      { sunVis: 0.2, floorIndex01: 1 / 255 }, // floor 1 — THIS fragment's floor, in deep shadow
      { sunVis: 1, floorIndex01: 2 / 255 }, // floor 2 — NOT this fragment's floor
    ];
    const result = blendSunVisibilityCpuTwin(1 / 255, slots);
    ok(
      `a fragment on floor 1 reads floor 1's OWN shadow (0.2), not floor 0/2's full light (got ${result.toFixed(4)})`,
      Math.abs(result - 0.2) < 1e-4
    );
  }

  // ── THE ARITHMETIC BLEND: the two reported symptoms, directly ──────────
  {
    // Symptom 1 — "looking through a gap I can't see the floor below's
    // shadow": BEFORE the fix, floor 0 had no slot at all, so a fragment
    // whose OWN floor is 0 would blend against zero slots.
    const noSlotForThisFloor = blendSunVisibilityCpuTwin(0, []);
    ok(
      `BEFORE the fix (no slot for this floor at all) a gap fragment read fully lit — no shadow, ` +
        `the exact reported symptom (got ${noSlotForThisFloor.toFixed(6)})`,
      Math.abs(noSlotForThisFloor - 1) < 1e-9
    );
    // AFTER the fix — the SAME fragment, now WITH its own floor's slot
    // resident and genuinely shadowed — reads that shadow.
    const withSlot = blendSunVisibilityCpuTwin(0, [{ sunVis: 0.1, floorIndex01: 0 }]);
    ok(
      `AFTER the fix the same fragment reads its OWN floor's real shadow (got ${withSlot.toFixed(4)})`,
      Math.abs(withSlot - 0.1) < 1e-4
    );

    // Symptom 2 — "I see shadows which should only be on the ground floor,
    // from the roof": a fragment on floor 2 must NOT read floor 0's shadow,
    // even when floor 0's slot is deeply shadowed and resident.
    const roofFragment = blendSunVisibilityCpuTwin(2 / 255, [{ sunVis: 0.05, floorIndex01: 0 }]);
    ok(
      `a ROOF fragment does not inherit GROUND FLOOR's deep shadow (0.05) — reads fully lit instead (got ${roofFragment.toFixed(6)})`,
      Math.abs(roofFragment - 1) < 1e-6
    );
  }

  // ── THE REAL TSL GRAPH ACTUALLY CONSTRUCTS, IN NODE (`keyhole-tsl-
  // constructs-in-node`, the same doctrine `sun-occlusion-render.test.mjs`
  // and `specular-render.test.mjs` already establish for this codebase) ────
  // WHAT THIS PROVES: `blendSunVisibilityAcrossFloors` builds a real node
  // graph, with the REAL (vendored) THREE.TSL, without throwing, for 0/1/N
  // slots. WHAT IT DOES NOT PROVE: WGSL codegen or the on-screen look — that
  // is the author's own live verification, same as every other TSL export in
  // this directory.
  {
    const { uniform, float } = THREE.TSL;
    const mkSlot = (floorIndex01) => ({ sunVis: float(0.5), floorIndex01: uniform(float(floorIndex01)) });

    let err0 = null;
    try {
      blendSunVisibilityAcrossFloors(THREE.TSL, { attrFloorIndex01: float(0), slots: [] });
    } catch (e) {
      err0 = e;
    }
    ok(`zero slots constructs without throwing (${err0 ? err0.message : 'clean'})`, err0 === null);

    let err1 = null;
    let node1 = null;
    try {
      node1 = blendSunVisibilityAcrossFloors(THREE.TSL, { attrFloorIndex01: float(0), slots: [mkSlot(0)] });
    } catch (e) {
      err1 = e;
    }
    ok(`one slot constructs without throwing (${err1 ? err1.message : 'clean'})`, err1 === null);
    ok('and returns a real node, not null/undefined', !!node1);

    let errN = null;
    try {
      blendSunVisibilityAcrossFloors(THREE.TSL, {
        attrFloorIndex01: float(1 / 255),
        slots: [mkSlot(0), mkSlot(1 / 255), mkSlot(2 / 255), mkSlot(-1 / 255)],
      });
    } catch (e) {
      errN = e;
    }
    ok(
      `four slots (the shape a real 4-resident-floor scene builds) construct without throwing (${errN ? errN.message : 'clean'})`,
      errN === null
    );

    // Every argument this function's own header promises is a real TSL node
    // type, not a plain JS number — a caller passing a raw number (the
    // mistake this catches) would throw INSIDE the arithmetic, not here.
    let wrongShapeErr = null;
    try {
      blendSunVisibilityAcrossFloors(THREE.TSL, { attrFloorIndex01: 0, slots: [{ sunVis: 0.5, floorIndex01: 0 }] });
    } catch (e) {
      wrongShapeErr = e;
    }
    ok(
      'plain JS numbers instead of TSL nodes throw (proves the function is really exercising the TSL API, not just adding JS numbers)',
      wrongShapeErr !== null
    );
  }
}
