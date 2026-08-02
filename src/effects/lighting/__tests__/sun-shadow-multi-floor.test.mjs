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
import { assignFloorSlotIndex, SUN_SHADOW_LAYER_STRENGTH } from '../sun-shadow-subsystem.js';
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

  // ── assignFloorSlotIndex: SLOT INDEX *IS* FLOOR INDEX ────────────────
  // ⚠️ REWRITTEN 2026-08-02, from a first-come allocator. THE CASCADE wires
  // slot N's bake material to read slot N-1's render target at CONSTRUCTION
  // time, so "the slot below me holds the floor below me" must be
  // structurally true. First-come made it an unenforced invariant that one
  // reordered caller loop would break — and a wrong cascade renders as a
  // plausible shadow, not as a crash.
  {
    const map = new Map();
    ok('floor 0 takes slot 0', assignFloorSlotIndex(map, 0, 6) === 0);
    ok('floor 2 takes slot 2, NOT the next free one', assignFloorSlotIndex(map, 2, 6) === 2);
    ok('floor 1 still takes slot 1 even though it was asked for last', assignFloorSlotIndex(map, 1, 6) === 1);
    ok('re-asking is stable', assignFloorSlotIndex(map, 2, 6) === 2);
    ok('and the map records which floors were actually asked for', map.size === 3);

    // THE PROPERTY THE CASCADE DEPENDS ON, stated directly: for any floor N
    // above the ground, the slot below it belongs to floor N-1.
    ok(
      'for every floor, slot(N) - 1 === slot(N-1) — the cascade chain, by construction',
      [1, 2, 3, 4, 5].every((n) => assignFloorSlotIndex(map, n, 6) - 1 === assignFloorSlotIndex(map, n - 1, 6))
    );
  }

  // ── the cap, and what falls outside it ────────────────────────────────
  {
    const map = new Map();
    ok('a floor at the cap boundary is refused', assignFloorSlotIndex(map, 6, 6) === -1);
    ok('and is NOT recorded as claiming anything', !map.has(6));
    ok('a floor well past the cap is refused too', assignFloorSlotIndex(map, 99, 6) === -1);
    ok('floors below the cap are unaffected by a refused one', assignFloorSlotIndex(map, 5, 6) === 5);
    ok('a 1-slot pool takes only floor 0', assignFloorSlotIndex(new Map(), 0, 1) === 0);
    ok('and refuses floor 1', assignFloorSlotIndex(new Map(), 1, 1) === -1);

    // Degenerate inputs must be refused, not silently coerced into slot 0 —
    // a NaN floor index landing on the ground floor's slot would overwrite the
    // one field every other floor cascades from.
    ok('a negative floor index is refused', assignFloorSlotIndex(new Map(), -1, 6) === -1);
    ok('a non-integer floor index is refused', assignFloorSlotIndex(new Map(), 1.5, 6) === -1);
    ok('NaN is refused', assignFloorSlotIndex(new Map(), NaN, 6) === -1);
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

  // ── THE CASCADE (2026-08-02) ──────────────────────────────────────────
  // Author: *"If a shadow looks great on the ground floor I want to be able to
  // see that same shadow through any holes in the middle or upper or ANY floor
  // above that floor... Lots of maps involve large open spaces with no
  // pixels/fully transparent, holes in the scene which allow the camera to
  // peer down to lower floors."*
  //
  // The model: you see whatever surface is actually visible at this pixel,
  // carrying THAT surface's shadow. `layer-smear-render.js` ends with
  // `mix(lowerField, ownVis, blockage)` where blockage is the layer texture's
  // A channel = the LOWER floor's `coverAbove`. Twinned here in plain numbers.
  {
    const cascade = (lower, own, blockage01) => lower * (1 - blockage01) + own * blockage01;

    // The author's own two live probe points, as the acceptance criteria.
    // Point 1: standing on the roof over the bridge — the middle floor is
    // solidly between, so the ground floor's shadow must NOT show.
    ok(
      'BLOCKED (point 1: bridge between roof and ground) shows this floor`s own answer, not the one below',
      Math.abs(cascade(0.1 /* ground is deep in shadow */, 1 /* roof is clear */, 1) - 1) < 1e-9
    );
    // Point 3: open water, nothing between — the ground floor's shadow must
    // come through exactly as it looks on the ground floor.
    ok(
      'OPEN (point 3: open water) shows the floor below`s shadow unchanged',
      Math.abs(cascade(0.1, 1, 0) - 0.1) < 1e-9
    );

    // A half-open walkway half-reveals what is under it — a gradient, never a
    // threshold, or every railing would pop between two states.
    ok('half-blocked blends the two', Math.abs(cascade(0.2, 1.0, 0.5) - 0.6) < 1e-9);

    // ⚠️ THE BOTTOM FLOOR MUST BE UNTOUCHED. Floor 0 has no lower field, and
    // its packed blockage is 255 (fully blocked) — so even if the cascade were
    // wired up on it, the arithmetic returns its own answer exactly.
    ok(
      'blockage 1 is a provable identity for ANY lower value',
      [0, 0.37, 1].every((l) => cascade(l, 0.42, 1) === 0.42)
    );

    // The recursion lives in the BAKE ORDER, not the shader: floor 2's "lower"
    // input is floor 1's ALREADY-cascaded field, so a hole through two floors
    // reaches the ground. Composed here to prove the chain, not just one link.
    const groundShadow = 0.1;
    const floor1Cascaded = cascade(groundShadow, 1, 0); // floor 1 is open over the ground
    const floor2Cascaded = cascade(floor1Cascaded, 1, 0); // floor 2 is open over floor 1
    ok(
      'a hole through TWO floors reaches the ground floor`s shadow, unchanged',
      Math.abs(floor2Cascaded - groundShadow) < 1e-9
    );
    // ...and one solid floor anywhere in the chain stops it.
    const floor1Solid = cascade(groundShadow, 1, 1);
    ok('one solid floor in the chain stops the cascade dead', Math.abs(cascade(floor1Solid, 1, 0) - 1) < 1e-9);
  }

  // ── A IS NO LONGER A SILHOUETTE CHANNEL, AND LAYER 3 MUST STAY INERT ──
  // The cascade spends the layer texture's documented-empty 4th slot. The
  // march still READS A as `cov[3]`, so this is safe ONLY while layer 3's
  // strength is exactly 0 — `occ[3] × 0` contributes a transmittance factor of
  // 1 by arithmetic, not by a branch. Giving layer 3 a real strength would
  // silently turn the blockage grid into a fourth caster silhouette.
  {
    ok(
      `SUN_SHADOW_LAYER_STRENGTH[3] is exactly 0, so the A channel cannot cast (is ${SUN_SHADOW_LAYER_STRENGTH[3]})`,
      SUN_SHADOW_LAYER_STRENGTH[3] === 0
    );
  }
}
