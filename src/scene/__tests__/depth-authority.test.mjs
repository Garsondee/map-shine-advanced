/**
 * Node verification for scene/depth-authority.js — the depth-buffer
 * redesign's stage-1 pure module (docs/planning/Depth-Buffer.md).
 *
 * The most valuable test here is `bisectRankMatchesBruteForce`: a linear-scan
 * reference implementation of the same "last item at-or-before this key"
 * search, fuzzed against the real binary search over many random item sets
 * and query elevations. Same discipline `layer-order.test.mjs`'s own
 * `foundryReference` fuzz already uses for `compareLayerKeys` — a binary
 * search with a hand-derived tie rule is exactly the kind of "looks right,
 * subtly isn't" code a smooth-looking single example cannot be trusted to
 * validate (`feedback_smooth_output_hides_ported_bugs`).
 */
import { createDepthAuthority, BELOW_EVERYTHING } from '../depth-authority.js';
import { compareLayerKeys, makeLayerKey } from '../layer-order.js';

/** @param {number} elevation @param {object} [overrides] */
function item(elevation, overrides = {}) {
  return {
    id: overrides.id,
    floorIndex: overrides.floorIndex,
    key: makeLayerKey({
      elevation,
      sortLayer: overrides.sortLayer ?? 0,
      sort: overrides.sort ?? 0,
      zIndex: overrides.zIndex ?? 0,
    }),
  };
}

/**
 * Brute-force reference for `rankOfKey`/`rankOfElevation`'s search — see this
 * file's own header. Takes the MAXIMUM `renderOrder` (rank) among every item
 * whose key compares at-or-before `queryKey`, scanning in WHATEVER order the
 * caller's array happens to be in — deliberately NOT assumed pre-sorted, so
 * this is a genuine independent check rather than one that only works
 * because its input already agrees with the code under test. Each item must
 * already carry a `renderOrder` (i.e. the SAME array `depth.rebuild()` was
 * called on, which stamps it in place).
 */
function referenceRank(itemsWithRenderOrder, queryKey) {
  let best = BELOW_EVERYTHING;
  for (const it of itemsWithRenderOrder) {
    if (compareLayerKeys(it.key, queryKey) <= 0 && it.renderOrder > best) best = it.renderOrder;
  }
  return best;
}

export function run(t) {
  const { ok } = t;

  // --- rebuild + rankOf: basic ordering ------------------------------------
  {
    const depth = createDepthAuthority();
    const a = item(0, { id: 'ground' });
    const b = item(20, { id: 'first' });
    const c = item(40, { id: 'second' });
    // Deliberately handed out of order — rebuild must sort, not trust input order.
    const returned = depth.rebuild([c, a, b]);
    ok('rankOf: lowest elevation gets rank 0', depth.rankOf(a) === 0);
    ok('rankOf: middle elevation gets rank 1', depth.rankOf(b) === 1);
    ok('rankOf: highest elevation gets rank 2', depth.rankOf(c) === 2);
    ok('size: reports the rebuilt count', depth.size === 3);
    ok('maxRank: equals size for a non-empty scene', depth.maxRank === 3);
    // rebuild is a deliberate drop-in replacement for a bare `sortByLayer`
    // call (see its own doc) — a real caller gets paint order AND the rank
    // table from ONE sort, never two.
    ok(
      'rebuild: returns the sorted array itself, a drop-in for sortByLayer',
      returned.map((i) => i.id).join(',') === 'ground,first,second'
    );
  }

  // --- rankOf: unknown item, and lookup-by-id across object identity -------
  {
    const depth = createDepthAuthority();
    const a = item(0, { id: 'ground' });
    depth.rebuild([a]);
    ok('rankOf: an item never rebuilt returns null, not a guess', depth.rankOf(item(5, { id: 'ghost' })) === null);
    ok('rankOf: null input returns null', depth.rankOf(null) === null);
    // A residency pass rebuilding item objects with the SAME id, a DIFFERENT
    // reference — onFluidRenderOrderResolver's own established identity
    // convention (id first, object reference as the id-less fallback).
    const sameIdDifferentObject = { id: 'ground', key: makeLayerKey({ elevation: 999 }) };
    ok(
      'rankOf: resolves by id even when the object reference differs',
      depth.rankOf(sameIdDifferentObject) === depth.rankOf(a)
    );
  }

  // --- rebuild wipes the previous table, not just adds to it ---------------
  {
    const depth = createDepthAuthority();
    const a = item(0, { id: 'a' });
    depth.rebuild([a]);
    ok('rebuild #1: a is ranked', depth.rankOf(a) === 0);
    const b = item(0, { id: 'b' });
    depth.rebuild([b]);
    ok('rebuild #2: a is no longer known — no stale leakage across rebuilds', depth.rankOf(a) === null);
    ok('rebuild #2: b is ranked fresh', depth.rankOf(b) === 0);
  }

  // --- empty scene ----------------------------------------------------------
  {
    const depth = createDepthAuthority();
    depth.rebuild([]);
    ok('empty scene: size is 0', depth.size === 0);
    ok('empty scene: maxRank is 1, never 0 (no div-by-zero downstream)', depth.maxRank === 1);
    ok('empty scene: any elevation reads as below everything', depth.rankOfElevation(50) === BELOW_EVERYTHING);
  }

  // --- THE LOAD-BEARING CASE: a query key TIED on elevation with a real item
  // must read as "at", never "above" — the fix for the exact bug class this
  // module's own header describes (a naive insertion-count coincides with a
  // real item's own rank at the ordinary, not edge, case).
  {
    const depth = createDepthAuthority();
    const ground = item(0, { id: 'ground', floorIndex: 0 });
    const middle = item(20, { id: 'middle', floorIndex: 1 }); // a floor's own background sits at its bottom
    const roof = item(40, { id: 'roof', floorIndex: 2 });
    depth.rebuild([ground, middle, roof]);

    // A light standing EXACTLY at the middle floor's own ground (elevation 20).
    const lightRank = depth.rankOfElevation(20);
    ok('tie: the light´s rank equals the tied real item´s own rank (1), not a synthetic count', lightRank === 1);
    ok(
      'tie: the SAME-elevation floor does NOT read as above the light standing on it',
      depth.rankOf(middle) > lightRank === false
    );
    ok(
      'tie: the floor genuinely ABOVE (roof, elevation 40) DOES read as above',
      depth.rankOf(roof) > lightRank === true
    );
    ok(
      'tie: the floor genuinely BELOW (ground, elevation 0) does NOT read as above',
      depth.rankOf(ground) > lightRank === false
    );

    // A light with NO tie, strictly between two real elevations (25, between
    // middle´s 20 and roof´s 40) — the ordinary case, not just the boundary.
    const midAirRank = depth.rankOfElevation(25);
    ok('no-tie: borrows the rank of the last real item at-or-below it (middle, rank 1)', midAirRank === 1);
    ok('no-tie: roof (genuinely above 25) reads as above', depth.rankOf(roof) > midAirRank === true);
    ok('no-tie: middle (genuinely below 25) does NOT read as above', depth.rankOf(middle) > midAirRank === false);

    // A light below the SCENE's own lowest real item.
    const belowAllRank = depth.rankOfElevation(-1000);
    ok('below everything: resolves to the BELOW_EVERYTHING ordinal', belowAllRank === BELOW_EVERYTHING);
    ok(
      'below everything: EVERY real item reads as above it (degenerate but correct)',
      [ground, middle, roof].every((it) => depth.rankOf(it) > belowAllRank)
    );
  }

  // --- floorOfRank: pure pass-through, never a second floor-index scheme ---
  {
    const depth = createDepthAuthority();
    const ground = item(0, { id: 'ground', floorIndex: 0 });
    const roof = item(40, { id: 'roof', floorIndex: 2 });
    depth.rebuild([ground, roof]);
    ok('floorOfRank: returns the attached floorIndex for a real rank', depth.floorOfRank(0) === 0);
    ok('floorOfRank: returns the attached floorIndex for the top rank', depth.floorOfRank(1) === 2);
    ok('floorOfRank: BELOW_EVERYTHING has no floor', depth.floorOfRank(BELOW_EVERYTHING) === null);
    ok('floorOfRank: an out-of-range rank has no floor', depth.floorOfRank(99) === null);
    ok('floorOfRank: a non-integer rank has no floor', depth.floorOfRank(0.5) === null);

    const depthNoFloors = createDepthAuthority();
    depthNoFloors.rebuild([item(0, { id: 'x' })]); // no floorIndex attached at all
    ok(
      'floorOfRank: an item with no floorIndex attached reads null, not 0 or undefined',
      depthNoFloors.floorOfRank(0) === null
    );
  }

  // --- rankOfKey: sortLayer/sort/zIndex ties within ONE elevation ----------
  {
    const depth = createDepthAuthority();
    // Two items at the SAME elevation, ordinary tile-vs-background tie-break
    // (background sortLayer=0 sorts before tiles sortLayer=500, matching
    // layer-order.js's own SORT_LAYERS numbers).
    const background = item(10, { id: 'bg', sortLayer: 0 });
    const tile = item(10, { id: 'tile', sortLayer: 500 });
    depth.rebuild([background, tile]);
    ok('same-elevation tie: background ranks before the tile', depth.rankOf(background) < depth.rankOf(tile));
    // A query at the exact tied elevation must sort AFTER both (maximal key),
    // so NEITHER same-elevation item reads as above it.
    const queryRank = depth.rankOfElevation(10);
    ok('same-elevation query: ranks with the LAST tied item (tile)', queryRank === depth.rankOf(tile));
  }

  // --- BRUTE-FORCE FUZZ — the real confidence check ------------------------
  {
    let mismatches = 0;
    let ties = 0;
    for (let trial = 0; trial < 500; trial++) {
      const n = 1 + Math.floor(Math.random() * 12);
      const items = [];
      for (let i = 0; i < n; i++) {
        items.push(
          item(Math.floor(Math.random() * 10) - 2, {
            id: `i${i}`,
            sortLayer: [0, 250, 500, 550, 600, 700, 750, 1000][Math.floor(Math.random() * 8)],
            sort: Math.floor(Math.random() * 4),
            zIndex: Math.floor(Math.random() * 2),
          })
        );
      }
      const depth = createDepthAuthority();
      depth.rebuild(items);
      // Rebuild a locally-sorted copy the SAME way, for the reference scan —
      // depth.rebuild mutated `items` in place (tiebreak stamped, renderOrder
      // set), so `items` IS already the sorted/decorated array afterward.
      for (let q = 0; q < 20; q++) {
        const queryElevation = Math.floor(Math.random() * 14) - 3;
        const queryKey = makeLayerKey({
          elevation: queryElevation,
          sortLayer: Infinity,
          sort: Infinity,
          zIndex: Infinity,
          tiebreak: Infinity,
        });
        const viaBisect = depth.rankOfElevation(queryElevation);
        const viaBruteForce = referenceRank(items, queryKey);
        if (viaBisect === viaBruteForce) {
          if (viaBisect !== BELOW_EVERYTHING) ties++;
        } else {
          mismatches++;
        }
      }
    }
    ok(
      `fuzz: 500 trials × 20 queries agree with the brute-force reference exactly (0 mismatches, got ${mismatches})`,
      mismatches === 0
    );
    ok('fuzz: exercised at least one real (non-degenerate) match, not all BELOW_EVERYTHING', ties > 0);
  }
}
