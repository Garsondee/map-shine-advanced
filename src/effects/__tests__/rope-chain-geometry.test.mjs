/**
 * rope-chain-geometry.test.mjs — the PURE half of the rope/chain Phase 1
 * work (mythica-machina-press#1): anchor pairing, the preset table, the
 * static sag, the modal wind-sway math (and its tether-point safety
 * guarantee), the reference spring integrator, the two-probe modal-forcing
 * decomposition, and the batched ribbon vertex-array bake. Mirrors
 * lightning-geometry.test.mjs's own harness and "pin the producer's real
 * shape, not an invented one" discipline.
 */
import {
  groupRopeChainAnchorsIntoSources,
  ROPE_CHAIN_PRESETS,
  parabolicSag,
  modalDisplacement,
  springChase,
  computeModalForcing,
  buildRopeChainRibbonArrays,
} from '../rope-chain-geometry.js';
import { hashStringToSeed } from '../lightning-geometry.js';

function approx(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

export function run(t) {
  const { ok } = t;

  // --- groupRopeChainAnchorsIntoSources -----------------------------------
  {
    const anchors = [
      {
        id: 'r1',
        x: 0,
        y: 0,
        params: {
          role: 'start',
          linkId: 'span-1',
          preset: 'chain',
          sagPx: 55,
          thicknessPx: 12,
          windAffected: 1.4,
          color: '#112233',
        },
        elevation: 3.5,
      },
      { id: 'r2', x: 300, y: 400, params: { role: 'end', linkId: 'span-1' } },
    ];
    const { sources, orphaned } = groupRopeChainAnchorsIntoSources(anchors);
    ok('a matched start+end pair produces exactly one source', sources.length === 1);
    ok('no orphans for a fully matched link', orphaned.length === 0);
    const s = sources[0];
    ok('the source carries the correct endpoint ids', s.startId === 'r1' && s.endId === 'r2');
    ok(
      'the source carries the correct endpoint positions',
      s.startX === 0 && s.startY === 0 && s.endX === 300 && s.endY === 400
    );
    ok('the source seed is derived from its linkId (deterministic)', s.seed === hashStringToSeed('span-1'));
    ok('preset/sagPx/thicknessPx/windAffected/color all come from the START anchor', s.preset === 'chain');
    ok('sagPx from the start anchor', s.sagPx === 55);
    ok('thicknessPx from the start anchor', s.thicknessPx === 12);
    ok('windAffected from the start anchor', s.windAffected === 1.4);
    ok('color from the start anchor', s.color === '#112233');
    ok("elevation comes from the START anchor's own top-level field", s.elevation === 3.5);

    // Defensive defaults — a hand-built fixture (or a start anchor that never
    // set one of these fields) gets the same sane values an author who never
    // touched the corresponding control would get, matching the anchor
    // catalog's own schema defaults, never NaN/undefined.
    const defaultAnchors = [
      { id: 'x1', x: 1, y: 1, params: { role: 'start', linkId: 'span-2' } },
      { id: 'x2', x: 2, y: 2, params: { role: 'end', linkId: 'span-2' } },
    ];
    const withDefaults = groupRopeChainAnchorsIntoSources(defaultAnchors).sources[0];
    ok(
      'absent preset/sagPx/thicknessPx/windAffected/color/elevation default sanely',
      withDefaults.preset === 'rope' &&
        withDefaults.sagPx === 40 &&
        withDefaults.thicknessPx === 20 &&
        withDefaults.windAffected === 1 &&
        withDefaults.color === '#8a8378' &&
        withDefaults.elevation === 0
    );

    const malformed = groupRopeChainAnchorsIntoSources([
      { id: 'm1', x: 0, y: 0, params: { role: 'start', linkId: 'span-3', preset: 'nonsense', color: 'not-a-color' } },
      { id: 'm2', x: 1, y: 1, params: { role: 'end', linkId: 'span-3' } },
    ]).sources[0];
    ok('an invalid preset value falls back to rope, never stored verbatim', malformed.preset === 'rope');
    ok('an invalid colour string falls back to the default tint', malformed.color === '#8a8378');

    // An unmatched single anchor is orphaned, not silently dropped.
    const lonely = groupRopeChainAnchorsIntoSources([
      { id: 's1', x: 5, y: 5, params: { role: 'start', linkId: 'lonely-1' } },
    ]);
    ok('no source is formed from a single unmatched anchor', lonely.sources.length === 0);
    ok(
      'the unmatched anchor is reported orphaned',
      lonely.orphaned.some((o) => o.id === 's1' && o.linkId === 'lonely-1' && o.role === 'start')
    );

    // Two anchors claiming the SAME role for one linkId, with no complete
    // pair to form (no 'end' at all for this link) — both are reported
    // orphaned, never silently overwriting one another.
    const dupRole = groupRopeChainAnchorsIntoSources([
      { id: 'd1', x: 0, y: 0, params: { role: 'start', linkId: 'dup-1' } },
      { id: 'd2', x: 10, y: 10, params: { role: 'start', linkId: 'dup-1' } },
    ]);
    ok('a duplicate role claim with no possible pair forms no source', dupRole.sources.length === 0);
    ok(
      'both anchors claiming the same role are reported orphaned',
      dupRole.orphaned.length === 2 && dupRole.orphaned.every((o) => o.id === 'd1' || o.id === 'd2')
    );

    ok(
      'anchors with no linkId at all are ignored entirely',
      groupRopeChainAnchorsIntoSources([{ id: 'z', x: 0, y: 0, params: {} }]).sources.length === 0
    );
    ok('a non-array input never throws', groupRopeChainAnchorsIntoSources(undefined).sources.length === 0);
  }

  // --- ROPE_CHAIN_PRESETS ---------------------------------------------------
  {
    ok(
      'ROPE_CHAIN_PRESETS declares both rope and chain',
      'rope' in ROPE_CHAIN_PRESETS && 'chain' in ROPE_CHAIN_PRESETS
    );
    ok('ROPE_CHAIN_PRESETS is frozen (data, not mutable state)', Object.isFrozen(ROPE_CHAIN_PRESETS));
    ok(
      'each preset is itself frozen',
      Object.isFrozen(ROPE_CHAIN_PRESETS.rope) && Object.isFrozen(ROPE_CHAIN_PRESETS.chain)
    );
    ok('rope is the wind-coupling baseline (1.0)', ROPE_CHAIN_PRESETS.rope.windCoupling === 1.0);
    ok(
      "chain's windCoupling preserves V2's ~5x-less-wind-affected ratio (1.2/0.25 ≈ 4.8x)",
      approx(ROPE_CHAIN_PRESETS.chain.windCoupling, 1 / (1.2 / 0.25), 0.01)
    );
    ok(
      'taper is ported straight from V2 (rope 0.55, chain 0.15) — a pure shape ratio',
      ROPE_CHAIN_PRESETS.rope.taper === 0.55 && ROPE_CHAIN_PRESETS.chain.taper === 0.15
    );
    ok(
      "chain's modeDamping is higher than rope's (V2's chain settles faster)",
      ROPE_CHAIN_PRESETS.chain.modeDamping > ROPE_CHAIN_PRESETS.rope.modeDamping
    );
    ok(
      "chain's modeStiffness is higher than rope's (a taut chain vs. a slack rope)",
      ROPE_CHAIN_PRESETS.chain.modeStiffness > ROPE_CHAIN_PRESETS.rope.modeStiffness
    );
  }

  // --- parabolicSag ----------------------------------------------------------
  {
    ok('parabolicSag is zero at s=0', parabolicSag(0, 100) === 0);
    ok('parabolicSag is zero at s=1', parabolicSag(1, 100) === 0);
    ok('parabolicSag peaks at exactly sagPx at s=0.5', parabolicSag(0.5, 100) === 100);
    // approx, not === : `4*sagPx*0.3*(1-0.3)` and `4*sagPx*0.7*(1-0.7)` are
    // mathematically identical but accumulate floating-point rounding in a
    // different order (left-to-right: `(4*sagPx*0.3)*0.7` vs.
    // `(4*sagPx*0.7)*0.3`), so bit-exact equality is not guaranteed — only
    // agreement to within float epsilon is.
    ok('parabolicSag is symmetric around s=0.5', approx(parabolicSag(0.3, 77), parabolicSag(0.7, 77)));
    ok('parabolicSag scales linearly with sagPx', approx(parabolicSag(0.25, 200), parabolicSag(0.25, 100) * 2));
  }

  // --- modalDisplacement: THE TETHER-POINT SAFETY GUARANTEE -----------------
  {
    const amplitudeSets = [
      [1],
      [1, -1],
      [1000, -1000, 500],
      [1e6, -5e5, 3e5, -2e5],
      [0.0001, -0.0002],
      [-999999, 123456, -42, 7],
    ];
    for (const amps of amplitudeSets) {
      ok(
        `modalDisplacement is ~0 at s=0 for amplitudes ${JSON.stringify(amps)}`,
        approx(modalDisplacement(0, amps), 0)
      );
      ok(
        `modalDisplacement is ~0 at s=1 for amplitudes ${JSON.stringify(amps)}`,
        approx(modalDisplacement(1, amps), 0)
      );
    }
    // Sanity: away from the tether points, a nonzero amplitude genuinely displaces.
    ok('modalDisplacement is nonzero away from the anchors for a real amplitude', modalDisplacement(0.5, [10]) !== 0);
    ok('an empty amplitude array displaces nothing anywhere', modalDisplacement(0.5, []) === 0);
    ok('a malformed amplitude argument never throws', modalDisplacement(0.5, undefined) === 0);
  }

  // --- springChase -------------------------------------------------------
  {
    // Converges toward target over repeated steps at reasonable stiffness/damping.
    let value = 0;
    let velocity = 0;
    const target = 10;
    const stiffness = 40;
    const damping = 14; // > 2*sqrt(40) ≈ 12.6 — comfortably overdamped, no ringing to wait out
    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) {
      ({ value, velocity } = springChase(value, velocity, target, stiffness, damping, dt));
    }
    ok('springChase converges close to the target after many steps', approx(value, target, 0.05));
    ok('springChase settles (velocity near zero once converged)', approx(velocity, 0, 0.05));

    // Does not diverge for a small, clamped dt across many steps.
    let v2 = 0;
    let vel2 = 0;
    let everFinite = true;
    for (let i = 0; i < 2000; i++) {
      ({ value: v2, velocity: vel2 } = springChase(v2, vel2, target, stiffness, damping, dt));
      if (!Number.isFinite(v2) || !Number.isFinite(vel2)) everFinite = false;
    }
    ok('springChase stays finite (does not diverge) across many small-dt steps', everFinite);

    // A zero dt returns the value/velocity unchanged.
    const unchanged = springChase(5, 2, 100, 50, 10, 0);
    ok('a zero dt leaves value unchanged', unchanged.value === 5);
    ok('a zero dt leaves velocity unchanged', unchanged.velocity === 2);

    // Defensive coercion of non-finite inputs, matching vegetation-render.js's own.
    const safe = springChase(NaN, undefined, 10, 50, 10, 1 / 60);
    ok('non-finite inputs are coerced to 0 rather than propagating NaN', Number.isFinite(safe.value));
  }

  // --- computeModalForcing -------------------------------------------------
  {
    const symmetric = computeModalForcing(5, 5);
    ok('symmetric wind input gives zero mode2Forcing (the S-curve mode)', symmetric.mode2Forcing === 0);
    ok('symmetric wind input gives nonzero mode1Forcing (the fundamental)', symmetric.mode1Forcing === 5);

    const antisymmetric = computeModalForcing(5, -5);
    ok('antisymmetric wind input gives zero mode1Forcing (the fundamental)', antisymmetric.mode1Forcing === 0);
    ok('antisymmetric wind input gives nonzero mode2Forcing (the S-curve mode)', antisymmetric.mode2Forcing === 5);

    const zero = computeModalForcing(0, 0);
    ok('zero wind gives zero forcing on both modes', zero.mode1Forcing === 0 && zero.mode2Forcing === 0);

    const safe = computeModalForcing(NaN, undefined);
    ok(
      'non-finite inputs are coerced to 0 rather than propagating NaN',
      safe.mode1Forcing === 0 && safe.mode2Forcing === 0
    );
  }

  // --- buildRopeChainRibbonArrays ------------------------------------------
  {
    const sources = [
      { startX: 0, startY: 0, endX: 100, endY: 0, sagPx: 20 },
      { startX: 200, startY: 50, endX: 400, endY: 150, sagPx: 60 },
    ];
    const pointsPerSpan = 5;
    const arrays = buildRopeChainRibbonArrays(sources, pointsPerSpan, () => 0);

    ok(
      'vertexCount is 2 verts per point, summed across sources',
      arrays.vertexCount === sources.length * pointsPerSpan * 2
    );
    ok(
      'indexCount is 6 indices per segment, summed across sources',
      arrays.indexCount === sources.length * (pointsPerSpan - 1) * 6
    );
    ok(
      'sourcePointCounts records pointsPerSpan for every source',
      arrays.sourcePointCounts.length === 2 && arrays.sourcePointCounts.every((n) => n === pointsPerSpan)
    );
    ok('positions has 3 floats per vertex', arrays.positions.length === arrays.vertexCount * 3);
    ok('side has 1 float per vertex', arrays.side.length === arrays.vertexCount);

    // First source's first point pair (side -1/+1) sits EXACTLY at its start
    // anchor — sag and modal displacement are both zero at s=0, by construction.
    ok(
      'vertex 0 (side -1) sits exactly at source 0s start anchor',
      arrays.positions[0] === 0 && arrays.positions[1] === 0
    );
    ok(
      'vertex 1 (side +1) sits exactly at source 0s start anchor',
      arrays.positions[3] === 0 && arrays.positions[4] === 0
    );
    ok('the first vertex pair has side -1/+1', arrays.side[0] === -1 && arrays.side[1] === 1);

    // First source's LAST point pair sits exactly at its end anchor.
    const lastPairBase = (pointsPerSpan - 1) * 2; // still within source 0's own vertex range
    ok(
      'the last vertex pair of source 0 sits exactly at its end anchor',
      arrays.positions[lastPairBase * 3 + 0] === 100 &&
        arrays.positions[lastPairBase * 3 + 1] === 0 &&
        arrays.positions[(lastPairBase + 1) * 3 + 0] === 100 &&
        arrays.positions[(lastPairBase + 1) * 3 + 1] === 0
    );

    // Second source starts right after the first source's own vertex block.
    const source1Base = pointsPerSpan * 2;
    ok(
      "source 1's first vertex pair sits exactly at ITS OWN start anchor (200,50), no cross-source bleed",
      arrays.positions[source1Base * 3 + 0] === 200 && arrays.positions[source1Base * 3 + 1] === 50
    );
    const source1LastBase = source1Base + (pointsPerSpan - 1) * 2;
    ok(
      "source 1's last vertex pair sits exactly at ITS OWN end anchor (400,150)",
      arrays.positions[source1LastBase * 3 + 0] === 400 && arrays.positions[source1LastBase * 3 + 1] === 150
    );

    // A nonzero modal-displacement callback moves an interior point, but
    // never the two endpoints (mirrors modalDisplacement's own guarantee,
    // exercised here through the ribbon bake as a whole).
    const swayed = buildRopeChainRibbonArrays([{ startX: 0, startY: 0, endX: 100, endY: 0, sagPx: 0 }], 5, (s) =>
      modalDisplacement(s, [500])
    );
    ok(
      'a live modal callback leaves the start anchor untouched',
      swayed.positions[0] === 0 && swayed.positions[1] === 0
    );
    const sEndBase = 4 * 2; // last of 5 points
    ok(
      'a live modal callback leaves the end anchor untouched',
      swayed.positions[sEndBase * 3 + 0] === 100 && approx(swayed.positions[sEndBase * 3 + 1], 0)
    );
    const midBase = 2 * 2; // the middle point, s=0.5
    ok('a live modal callback DOES move an interior point', Math.abs(swayed.positions[midBase * 3 + 1]) > 1);

    // Degenerate/edge inputs never throw.
    ok(
      'an empty sources array yields zero counts, not a throw',
      buildRopeChainRibbonArrays([], 10, () => 0).vertexCount === 0
    );
    ok(
      'a non-array sources argument never throws',
      buildRopeChainRibbonArrays(undefined, 10, () => 0).vertexCount === 0
    );
    ok(
      'pointsPerSpan below 2 is coerced up rather than producing a degenerate/negative buffer',
      buildRopeChainRibbonArrays([{ startX: 0, startY: 0, endX: 1, endY: 1, sagPx: 0 }], 1, () => 0).vertexCount === 4
    );
  }
}
