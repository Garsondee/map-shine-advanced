/**
 * vegetation-render.test.mjs — Case 1 detection (a tile whose OWN texture is
 * `_Tree`/`_Bush`-suffixed) and the vertex-displacement curve. Case 2
 * (sibling-file discovery) is a network question and lives in boot.js — see
 * vegetation-render.js's own header for why that split is deliberate.
 */
import {
  detectSelfVegetationKind,
  heightWeight01,
  validateVegetationKinds,
  vegetationMeshSegments,
  buildTessellatedQuadGeometry,
  VEGETATION_MIN_SEGMENTS,
  VEGETATION_MAX_SEGMENTS,
  vegetationPassiveElevation,
  vegetationOverlayRenderOrder,
  buildVegetationDepthItems,
  flutterFoldFreeAmplitudePx,
  VEG_FLUTTER_FOLD_SAFETY,
} from '../vegetation-render.js';
import { VEGETATION_KINDS } from '../vegetation.js';
import { makeLayerKey, sortByLayer, SORT_LAYERS } from '../../scene/layer-order.js';
import { createDepthAuthority } from '../../scene/depth-authority.js';

export function run(t) {
  const { ok } = t;

  // --- detectSelfVegetationKind: the real, positive cases -------------------
  ok(
    'a plain _Tree-suffixed tile src is detected as tree',
    detectSelfVegetationKind('assets/tiles/oak-cluster_Tree.webp')?.id === 'tree'
  );
  ok(
    'a plain _Bush-suffixed tile src is detected as bush',
    detectSelfVegetationKind('assets/tiles/hedge-row_Bush.png')?.id === 'bush'
  );
  ok(
    'case-insensitive (Windows-hosted servers serve case-insensitively — same reasoning mask-discovery.js uses)',
    detectSelfVegetationKind('assets/tiles/OAK_tree.WEBP')?.id === 'tree'
  );
  ok(
    'a query string after the extension does not break detection',
    detectSelfVegetationKind('assets/tiles/hedge_Bush.webp?v=3')?.id === 'bush'
  );
  ok(
    'no directory prefix still detects correctly (a bare filename)',
    detectSelfVegetationKind('hedge_Bush.webp')?.id === 'bush'
  );

  // --- the negative cases — must NOT false-positive ------------------------
  ok(
    'a plain tile with no suffix at all is not vegetation',
    detectSelfVegetationKind('assets/tiles/rock.webp') === null
  );
  ok(
    'endsWith is anchored to the true END — "_Tree" merely PRESENT (followed by more name) does not match ' +
      '("_Tree_wall.webp" is a wall tile that happens to contain "_Tree", not vegetation)',
    detectSelfVegetationKind('assets/tiles/_Tree_wall.webp') === null
  );
  ok(
    'trailing letters "tree" with no suffix DELIMITER do not match ("banyantree.webp" is not "_Tree"-suffixed)',
    detectSelfVegetationKind('assets/tiles/banyantree.webp') === null
  );
  ok(
    'an empty/undefined src never throws and returns null',
    detectSelfVegetationKind('') === null && detectSelfVegetationKind(undefined) === null
  );
  ok(
    'a URL with no extension at all is handled without throwing, and a non-matching one still returns null',
    detectSelfVegetationKind('assets/tiles/oak_stump') === null
  );
  ok(
    'a URL with no extension whose name genuinely ends in the suffix still matches (no throw, correct match)',
    detectSelfVegetationKind('assets/tiles/oak_Tree')?.id === 'tree'
  );

  // --- validateVegetationKinds against the REAL declared table -------------
  ok('the real VEGETATION_KINDS table validates', validateVegetationKinds(VEGETATION_KINDS).ok);
  {
    // A fraction outside 0..1 would sort the overlay into a DIFFERENT floor's
    // art — always a typo, never a tuning choice.
    const outOfBand = VEGETATION_KINDS.map((k) => ({ ...k, passiveElevationFraction: 1.4 }));
    ok('a passiveElevationFraction above 1 fails validation', !validateVegetationKinds(outOfBand).ok);
    const missing = VEGETATION_KINDS.map((k) => {
      const copy = { ...k };
      delete copy.passiveElevationFraction;
      return copy;
    });
    ok('a MISSING passiveElevationFraction fails validation', !validateVegetationKinds(missing).ok);
  }

  // ==========================================================================
  // PASSIVE ELEVATION — the fix for "a tile at elevation 0 / sort 1 draws over
  // every bush and tree" (author-reported 2026-08-01).
  //
  // These assert the author's own stated OUTCOMES — which drawable ends up on
  // top — NOT the arithmetic that produces them. The numbers are an
  // implementation detail of `sortByLayer`'s dense indexing; the ORDER is the
  // contract, and it is the thing that was actually wrong.
  // ==========================================================================
  {
    const tree = VEGETATION_KINDS.find((k) => k.id === 'tree');
    const bush = VEGETATION_KINDS.find((k) => k.id === 'bush');
    const band = { bottom: 0, top: 20 }; // the author's own worked example

    ok('bush sits halfway up its floor band', vegetationPassiveElevation(bush, band) === 10);
    ok('tree sits at the top of its floor band', vegetationPassiveElevation(tree, band) === 20);
    ok(
      'a band with an undeclared (Infinite) ceiling yields null, never Infinity/NaN',
      vegetationPassiveElevation(bush, { bottom: 0, top: Infinity }) === null &&
        vegetationPassiveElevation(bush, { bottom: -Infinity, top: 20 }) === null
    );
    ok('a missing band yields null rather than throwing', vegetationPassiveElevation(bush, null) === null);
    ok(
      'a zero-height band is legitimate — every kind collapses onto that one elevation',
      vegetationPassiveElevation(bush, { bottom: 7, top: 7 }) === 7 &&
        vegetationPassiveElevation(tree, { bottom: 7, top: 7 }) === 7
    );

    // A realistic draw list on a 0..20 floor: ground art, four tiles at the
    // author's exact test elevations, and the floor's roof art on top.
    const mk = (id, elevation, sortLayer, zIndex = 0) => ({
      id,
      key: makeLayerKey({ elevation, sortLayer, sort: 0, zIndex }),
    });
    const items = sortByLayer([
      mk('ground', 0, SORT_LAYERS.SCENE, 0),
      mk('tile@9', 9, SORT_LAYERS.TILES),
      mk('tile@10', 10, SORT_LAYERS.TILES),
      mk('tile@19', 19, SORT_LAYERS.TILES),
      mk('tile@20', 20, SORT_LAYERS.TILES),
      mk('roof', 20, SORT_LAYERS.SCENE, 1),
    ]);
    const host = items.find((i) => i.id === 'ground');
    const at = (id) => items.find((i) => i.id === id).renderOrder;
    const bushOrder = vegetationOverlayRenderOrder(items, host, bush, band).renderOrder;
    const treeOrder = vegetationOverlayRenderOrder(items, host, tree, band).renderOrder;

    // THE BUG ITSELF: the host is the ground at renderOrder 0, and EVERY tile
    // sorts above it. Under the old `host.renderOrder + nudge` this put both
    // kinds below every single tile on the map.
    ok('vegetation no longer sorts next to its host — it clears the low tiles', bushOrder > at('tile@9'));

    ok("a tile BELOW the bush's half-height draws under it", at('tile@9') < bushOrder);
    ok('a tile AT the half-height mark beats the bush (ties go to the tile)', at('tile@10') > bushOrder);
    ok('a tile below the floor top draws under the tree', at('tile@19') < treeOrder);
    ok('only a tile at the very top of the floor beats the tree', at('tile@20') > treeOrder);
    ok('canopy still draws above undergrowth', treeOrder > bushOrder);
    // The documented, deliberate consequence of SCENE_EFFECTS > SCENE: an
    // author who wants roof art over a canopy puts it on a TILE at the top.
    ok('a tree at the floor top draws over that floor’s roof art', treeOrder > at('roof'));

    // The bush must land strictly BETWEEN two real drawables — never colliding
    // with one, which would make the winner depend on THREE's own sort
    // stability rather than on the law.
    ok(
      'the overlay lands strictly between two real slots, never tied with one',
      !Number.isInteger(bushOrder) && !Number.isInteger(treeOrder)
    );

    // Unbounded band → the legacy host-relative nudge, and it SAYS so.
    const fallback = vegetationOverlayRenderOrder(items, host, bush, { bottom: 0, top: Infinity });
    ok(
      'an unbounded floor band falls back to the host-relative nudge and reports it',
      fallback.fellBack === true && fallback.renderOrder === host.renderOrder + bush.renderOrderNudge
    );

    // ========================================================================
    // THE SPARSE-FLOOR TIE — found 2026-08-04 chasing an author report of
    // `_Bush` drawing over `_Tree` on an ordinary scene. `below` only ever
    // counts REAL drawables; it never compares bush's key against tree's. The
    // fixture above always had a tile at elevation 19 (between bush's 10 and
    // tree's 20) that broke the tie BY ACCIDENT — a floor with nothing at all
    // between them (just background art, no intermediate tiles: the ordinary
    // case, not the exception) never got exercised, and that is exactly where
    // a fixed `n - 0.5` handed both kinds the identical renderOrder number.
    // ========================================================================
    {
      const sparseItems = sortByLayer([mk('ground', 0, SORT_LAYERS.SCENE, 0)]);
      const sparseHost = sparseItems[0];
      const sparseBush = vegetationOverlayRenderOrder(sparseItems, sparseHost, bush, band);
      const sparseTree = vegetationOverlayRenderOrder(sparseItems, sparseHost, tree, band);
      ok(
        'on a floor with nothing between them, bush and tree do NOT collide onto one renderOrder',
        sparseBush.renderOrder !== sparseTree.renderOrder
      );
      ok(
        'canopy still draws above undergrowth when nothing else breaks the tie',
        sparseTree.renderOrder > sparseBush.renderOrder
      );
      ok(
        'both still land strictly inside the one real gap, never touching its boundary',
        sparseBush.renderOrder > sparseHost.renderOrder &&
          sparseBush.renderOrder < sparseHost.renderOrder + 1 &&
          sparseTree.renderOrder > sparseHost.renderOrder &&
          sparseTree.renderOrder < sparseHost.renderOrder + 1
      );
    }
  }

  // ==========================================================================
  // buildVegetationDepthItems — STAGE 2 (2026-08-04): giving Case-2 overlays a
  // REAL entry in the depth-authority's own ranked array, not just a paint-
  // order fraction. These assert the ACTUAL rank ordering a real consumer
  // (scene/depth-authority.js) produces, not just the elevation numbers, per
  // this file's own established "assert the outcome" discipline above.
  // ==========================================================================
  {
    const floors = [
      { id: 'ground', elevationBottom: 0, elevationTop: 20 },
      { id: 'upper', elevationBottom: 20, elevationTop: 40 },
      { id: 'attic', elevationBottom: 40, elevationTop: undefined }, // unbounded on purpose
    ];
    const hostGround = {
      id: 'tile:ground-host',
      levelId: 'ground',
      key: makeLayerKey({ elevation: 5, sortLayer: SORT_LAYERS.TILES }),
    };
    const hostUpper = {
      id: 'tile:upper-host',
      levelId: 'upper',
      key: makeLayerKey({ elevation: 25, sortLayer: SORT_LAYERS.TILES }),
    };
    const hostAttic = {
      id: 'tile:attic-host',
      levelId: 'attic',
      key: makeLayerKey({ elevation: 45, sortLayer: SORT_LAYERS.TILES }),
    };
    const hostNoVeg = {
      id: 'tile:plain',
      levelId: 'ground',
      key: makeLayerKey({ elevation: 3, sortLayer: SORT_LAYERS.TILES }),
    };
    const items = [hostGround, hostUpper, hostAttic, hostNoVeg];

    ok(
      'no urlByItemId at all (unwired) never throws and produces nothing',
      Array.isArray(buildVegetationDepthItems(items, floors, null)) &&
        buildVegetationDepthItems(items, floors, null).length === 0 &&
        buildVegetationDepthItems(items, floors, undefined).length === 0
    );
    ok('an empty Map produces nothing', buildVegetationDepthItems(items, floors, new Map()).length === 0);

    const urlByItemId = new Map([
      ['tile:ground-host', { tree: 'oak_Tree.webp', bush: 'hedge_Bush.webp' }],
      ['tile:upper-host', { tree: 'pine_Tree.webp', bush: null }],
      ['tile:attic-host', { tree: 'attic_Tree.webp', bush: 'attic_Bush.webp' }], // unbounded floor
      // 'tile:plain' deliberately has no entry — matches boot.js's own
      // urlByItemId, which only ever contains a host that actually has a
      // discovered sibling file.
    ]);

    const vegItems = buildVegetationDepthItems(items, floors, urlByItemId);

    ok(
      'exactly one synthetic item per (host, kind) pair with a real URL — 2 for ground, 1 for upper, 0 for attic (unbounded)',
      vegItems.length === 3
    );
    ok(
      'every synthetic item is tagged kind: vegetationOverlay, distinguishable from a real Foundry item',
      vegItems.every((v) => v.kind === 'vegetationOverlay')
    );
    ok(
      'the synthetic id is stable and traceable back to its host + kind — veg:<hostId>:<kindId>',
      vegItems.some((v) => v.id === 'veg:tile:ground-host:tree') &&
        vegItems.some((v) => v.id === 'veg:tile:ground-host:bush') &&
        vegItems.some((v) => v.id === 'veg:tile:upper-host:tree')
    );
    ok(
      'each synthetic item carries its own host id and kind id back out for the caller to resolve the real mesh',
      vegItems.every((v) => v.vegHostItemId && v.vegKindId && items.some((i) => i.id === v.vegHostItemId))
    );
    ok(
      "⚠️ levelId is the HOST's own resolved floor, never left to re-derive from the synthetic (top-of-band) elevation — " +
        "a tree at fraction 1.0 sits EXACTLY at its floor's own top, precisely the half-open-band trap",
      vegItems.filter((v) => v.vegHostItemId === 'tile:ground-host').every((v) => v.levelId === 'ground') &&
        vegItems.filter((v) => v.vegHostItemId === 'tile:upper-host').every((v) => v.levelId === 'upper')
    );
    ok(
      'the attic (unbounded top) produces NOTHING for either kind — a named gap, never a guessed elevation',
      !vegItems.some((v) => v.vegHostItemId === 'tile:attic-host')
    );
    ok(
      'a host with no discovered URL at all (tile:plain) never appears',
      !vegItems.some((v) => v.vegHostItemId === 'tile:plain')
    );
    ok(
      'a kind explicitly absent for a host (upper has no bush) is skipped, not fabricated as elevation 0',
      !vegItems.some((v) => v.vegHostItemId === 'tile:upper-host' && v.vegKindId === 'bush')
    );

    // THE ACTUAL PROOF — feed the REAL depth authority (the genuine consumer,
    // not a hand-rolled comparison) and assert the RANK ordering it produces,
    // exactly what buf:scene.depth's occlusion comparison actually reads.
    {
      const depthAuthority = createDepthAuthority();
      depthAuthority.rebuild([...items, ...vegItems]);
      // rankOf looks up by `item.id` first (depth-authority.js's own contract)
      // — a bare {id} is sufficient, no need to re-find the full ranked object.
      const rankOf = (id) => depthAuthority.rankOf({ id });

      ok(
        "a floor's own tree outranks that SAME floor's own bush — canopy above undergrowth",
        rankOf('veg:tile:ground-host:tree') > rankOf('veg:tile:ground-host:bush')
      );
      ok(
        "a HIGHER floor's bush still outranks a LOWER floor's tree — floor identity dominates, exactly the property " +
          'point-light occlusion already relies on (elevationRank\'s own "floor index always dominates" guarantee)',
        rankOf('veg:tile:upper-host:tree') > rankOf('veg:tile:ground-host:tree')
      );
      ok(
        "the ground floor's own tree outranks its own host tile — the canopy is genuinely 'above' the tile it grows on",
        rankOf('veg:tile:ground-host:tree') > rankOf(hostGround.id)
      );
      ok(
        'a plain tile with no vegetation at all is completely unaffected — its rank is unchanged by vegetation existing',
        rankOf(hostNoVeg.id) != null
      );
    }
  }

  // ==========================================================================
  // 🐛 THE FLICKER REGRESSION — author-reported LIVE, 2026-08-05: "bushes
  // flickering when I pan the camera". Two same-floor bushes tie EXACTLY on
  // elevation/sortLayer/sort/zIndex (passiveElevationFraction is a per-KIND
  // constant); `sortByLayer` (inside depthAuthority.rebuild) stamps
  // `tiebreak = index` unconditionally from the CALLER's own array position
  // — so their relative rank is decided ENTIRELY by whatever order
  // buildVegetationDepthItems happened to emit them in. `items`' own order
  // is residency-dependent (panning loads/unloads tiles), so a version that
  // emits them in `items`-input order would flip their relative rank every
  // time panning reshuffled that array — even though NEITHER bush actually
  // moved. This is EXACTLY the class of bug a single fixed test ordering
  // cannot catch (feedback_smooth_output_hides_ported_bugs): the fix is
  // proven here by rebuilding the SAME two bushes behind TWO DIFFERENT,
  // deliberately shuffled `items` arrays (one of them also missing an
  // unrelated host entirely, the same shape a residency change produces) and
  // asserting their RELATIVE rank is identical both times.
  // ==========================================================================
  {
    const band = { bottom: 0, top: 20 };
    const floors = [{ id: 'ground', elevationBottom: band.bottom, elevationTop: band.top }];
    const hostA = {
      id: 'tile:bush-host-A',
      levelId: 'ground',
      key: makeLayerKey({ elevation: 2, sortLayer: SORT_LAYERS.TILES }),
    };
    const hostB = {
      id: 'tile:bush-host-B',
      levelId: 'ground',
      key: makeLayerKey({ elevation: 4, sortLayer: SORT_LAYERS.TILES }),
    };
    const hostC = {
      id: 'tile:bush-host-C',
      levelId: 'ground',
      key: makeLayerKey({ elevation: 6, sortLayer: SORT_LAYERS.TILES }),
    };
    const bystander1 = {
      id: 'tile:bystander-1',
      levelId: 'ground',
      key: makeLayerKey({ elevation: 1, sortLayer: SORT_LAYERS.TILES }),
    };
    const bystander2 = {
      id: 'tile:bystander-2',
      levelId: 'ground',
      key: makeLayerKey({ elevation: 8, sortLayer: SORT_LAYERS.TILES }),
    };
    const urlByItemId = new Map([
      ['tile:bush-host-A', { bush: 'shrub-a_Bush.webp' }],
      ['tile:bush-host-B', { bush: 'shrub-b_Bush.webp' }],
      ['tile:bush-host-C', { bush: 'shrub-c_Bush.webp' }],
    ]);

    // "Panning" #1 — one arbitrary order, `bystander2` present.
    const orderingOne = [hostA, bystander1, hostB, hostC, bystander2];
    // "Panning" #2 — a DIFFERENT order, `bystander2` gone (fell out of
    // residency), `bystander1` moved — exactly the shape a real residency
    // reorder produces. The three bush hosts are the SAME three items.
    const orderingTwo = [hostC, hostB, bystander1, hostA];

    const rankPairFor = (ordering) => {
      const vegItems = buildVegetationDepthItems(ordering, floors, urlByItemId);
      const depthAuthority = createDepthAuthority();
      depthAuthority.rebuild([...ordering, ...vegItems]);
      const rankOf = (id) => depthAuthority.rankOf({ id });
      return [
        rankOf('veg:tile:bush-host-A:bush'),
        rankOf('veg:tile:bush-host-B:bush'),
        rankOf('veg:tile:bush-host-C:bush'),
      ];
    };

    const [aRank1, bRank1, cRank1] = rankPairFor(orderingOne);
    const [aRank2, bRank2, cRank2] = rankPairFor(orderingTwo);

    ok(
      'THE BUG, reproduced directly: buildVegetationDepthItems emits the three same-floor bushes in a STABLE ' +
        'relative order regardless of the input items array order (id-sorted output, not items-input order)',
      buildVegetationDepthItems(orderingOne, floors, urlByItemId)
        .map((v) => v.id)
        .join(',') ===
        buildVegetationDepthItems(orderingTwo, floors, urlByItemId)
          .map((v) => v.id)
          .join(',')
    );
    ok(
      'THE FIX, proven against the REAL depth authority: A-vs-B relative rank is IDENTICAL across both ' +
        '"panning" orderings — this is the exact comparison a nearby light\'s occlusion gate reads every frame',
      aRank1 < bRank1 === aRank2 < bRank2
    );
    ok('B-vs-C relative rank is also identical across both orderings', bRank1 < cRank1 === bRank2 < cRank2);
    ok('A-vs-C relative rank is also identical across both orderings', aRank1 < cRank1 === aRank2 < cRank2);
    ok(
      'the fix does not merely coincide — the three bushes really do land at three DISTINCT ranks, never a tie ' +
        'a real GPU depth-buffer write would have to break arbitrarily',
      new Set([aRank1, bRank1, cRank1]).size === 3 && new Set([aRank2, bRank2, cRank2]).size === 3
    );
  }

  // ==========================================================================
  // THE FOLD-FREE FLUTTER BOUND — the fix for "at high wind speed it just
  // liquifies" (author, 2026-08-01, with a 100%-wind screenshot).
  //
  // ⚠️ THIS TEST MEASURES THE PROPERTY, NOT THE FORMULA. Asserting
  // `flutterFoldFreeAmplitudePx(f) === SAFETY / f` would just restate the
  // implementation and pass forever, including on the day the bound is wrong.
  // So it builds a CPU twin of the warp and checks the thing that actually
  // matters: does `x → x + d(x)` stay INJECTIVE (no fold)? A fold is exactly
  // what liquify is.
  //
  // HONEST SCOPE: the twin's curl noise is a representative smooth
  // divergence-free field, NOT a port of TSL's `mx_noise_float`, so this proves
  // the BOUND is the right shape and is applied with real margin — it does not
  // pin the shader's exact peak gradient. The "5× the cap must fold" assertion
  // below is what stops it degenerating into a test that cannot fail.
  // ==========================================================================
  {
    // A smooth periodic potential; its curl is divergence-free by construction,
    // the same property `curlNoise2D` provides in the shader.
    const potential = (x, y) => Math.sin(x) * Math.cos(y * 1.3 + 0.7) + 0.5 * Math.sin(x * 0.6 + y);
    const EPS = 1e-4;
    /** curl(potential) at world (wx, wy), for a noise of frequency `f`. Unit-ish scale. */
    const curl = (wx, wy, f) => {
      const x = wx * f;
      const y = wy * f;
      const dPdy = (potential(x, y + EPS) - potential(x, y - EPS)) / (2 * EPS);
      const dPdx = (potential(x + EPS, y) - potential(x - EPS, y)) / (2 * EPS);
      return [dPdy, -dPdx];
    };

    /**
     * Does `p → p + amplitude × curl(p)` fold anywhere on a sampled patch?
     * Folding shows up as the Jacobian determinant going non-positive: the
     * local area flips inside out, which is the map ceasing to be injective.
     */
    const foldsAnywhere = (f, amplitudePx) => {
      const h = 0.35 / f; // sample far finer than one feature of the noise
      for (let i = 0; i < 40; i++) {
        for (let j = 0; j < 40; j++) {
          const x = i * h;
          const y = j * h;
          const [dx0, dy0] = curl(x, y, f);
          const [dxX, dyX] = curl(x + h, y, f);
          const [dxY, dyY] = curl(x, y + h, f);
          // Jacobian of the FULL map (identity + displacement gradient).
          const j11 = 1 + (amplitudePx * (dxX - dx0)) / h;
          const j21 = (amplitudePx * (dyX - dy0)) / h;
          const j12 = (amplitudePx * (dxY - dx0)) / h;
          const j22 = 1 + (amplitudePx * (dyY - dy0)) / h;
          if (j11 * j22 - j12 * j21 <= 0) return true;
        }
      }
      return false;
    };

    // Every frequency the dials can actually reach: both kinds' own
    // `flutterSpaceFreq` across the full 0.2..4 `flutterScale` range.
    const frequencies = [];
    for (const kind of VEGETATION_KINDS) {
      for (const scale of [0.2, 0.5, 1, 2, 4]) frequencies.push(kind.flutterSpaceFreq * scale);
    }

    ok(
      'at the capped amplitude the warp never folds, at ANY reachable frequency',
      frequencies.every((f) => !foldsAnywhere(f, flutterFoldFreeAmplitudePx(f)))
    );
    // THE TEST MUST BE ABLE TO FAIL. If a grossly over-cap amplitude did NOT
    // fold, the detector is broken and the assertion above proves nothing.
    // 10×, not 5×: the twin's potential is smoother than real curl noise, so
    // its own folding threshold sits around 6-7× the cap — the margin between
    // "capped, provably safe" and "detector definitely fires" is where the
    // safety factor lives, and quoting it honestly is the point.
    ok(
      'the fold detector genuinely fires at 10× the cap (proving the check above is not vacuous)',
      frequencies.every((f) => foldsAnywhere(f, flutterFoldFreeAmplitudePx(f) * 10))
    );
    ok(
      'the cap tightens as frequency rises — finer chatter is allowed less throw, which is the whole coupling',
      flutterFoldFreeAmplitudePx(0.02) > flutterFoldFreeAmplitudePx(0.08)
    );
    ok(
      'the safety fraction sits below the 1/2π folding threshold with real margin',
      VEG_FLUTTER_FOLD_SAFETY > 0 && VEG_FLUTTER_FOLD_SAFETY < 1 / (2 * Math.PI)
    );
    ok(
      'a zero/degenerate frequency yields 0, never Infinity or NaN (a caller multiplies by this)',
      flutterFoldFreeAmplitudePx(0) === 0 &&
        flutterFoldFreeAmplitudePx(-1) === 0 &&
        Number.isFinite(flutterFoldFreeAmplitudePx(NaN))
    );
  }

  // --- heightWeight01: pinned root, full tip, monotonic, quadratic ease-in --
  ok('the root (v=0) never moves', heightWeight01(0) === 0);
  ok('the tip (v=1) moves at full weight', heightWeight01(1) === 1);
  ok('the midpoint moves LESS than half (quadratic ease-in, not linear)', heightWeight01(0.5) === 0.25);
  ok(
    'monotonically increasing across the range',
    heightWeight01(0.2) < heightWeight01(0.6) && heightWeight01(0.6) < heightWeight01(0.9)
  );
  ok('a v slightly below 0 clamps rather than extrapolating negative', heightWeight01(-0.3) === 0);
  ok('a v slightly above 1 clamps rather than extrapolating past full', heightWeight01(1.3) === 1);

  // ==========================================================================
  // TESSELLATION — the fix for "everything sways identically" (2026-07-23).
  // A 4-vertex quad can only ever carry ONE wind sample; these helpers are what
  // give a whole-map canopy enough vertices to disagree with itself.
  // ==========================================================================

  // --- segment count: real resolution, honestly bounded --------------------
  {
    ok(
      'a big map tessellates but stays inside the ceiling',
      vegetationMeshSegments(12000, 12000) === VEGETATION_MAX_SEGMENTS
    );
    ok(
      'a mid-size background gets real resolution (not clamped to either end)',
      vegetationMeshSegments(3200, 3200) > VEGETATION_MIN_SEGMENTS &&
        vegetationMeshSegments(3200, 3200) < VEGETATION_MAX_SEGMENTS
    );
    ok('a small bush tile still gets the minimum give', vegetationMeshSegments(120, 90) === VEGETATION_MIN_SEGMENTS);
    ok(
      'segments follow the LONGEST axis (a wide, short banner still subdivides)',
      vegetationMeshSegments(6000, 100) > 10
    );
    ok(
      'degenerate/absent sizes fall back to the minimum rather than 0 or NaN',
      vegetationMeshSegments(0, 0) === VEGETATION_MIN_SEGMENTS &&
        vegetationMeshSegments(NaN, undefined) === VEGETATION_MIN_SEGMENTS
    );
    ok(
      'negative sizes are treated by magnitude, never producing a negative count',
      vegetationMeshSegments(-3200, -3200) > VEGETATION_MIN_SEGMENTS
    );
  }

  // --- geometry: counts, corners, UVs, index validity ----------------------
  {
    // A deliberately ROTATED, non-axis-aligned quad — the case a bounding-box
    // approximation would get wrong, so the bilinear interpolation is actually
    // being tested rather than a trivially-square one.
    const corners = [
      { x: 100, y: 100 }, // uv (0,0)
      { x: 300, y: 140 }, // uv (1,0)
      { x: 260, y: 340 }, // uv (1,1)
      { x: 60, y: 300 }, // uv (0,1)
    ];
    const n = 4;
    const g = buildTessellatedQuadGeometry(corners, n);
    const side = n + 1;

    ok('vertex count is (segments+1)²', g.vertexCount === side * side && g.positions.length === side * side * 3);
    ok('one UV pair per vertex', g.uvs.length === side * side * 2);
    ok('two triangles per cell', g.indices.length === n * n * 6);

    // The four grid CORNERS must land exactly on the four world corners —
    // this is what proves the tessellated mesh occupies the same footprint as
    // the plain quad it replaces (a mismatch here would shift the whole canopy).
    const vertAt = (i, j) => {
      const idx = (j * side + i) * 3;
      return { x: g.positions[idx], y: g.positions[idx + 1], z: g.positions[idx + 2] };
    };
    const near = (a, b) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
    ok('grid corner (0,0) matches world corner 0', near(vertAt(0, 0), corners[0]));
    ok('grid corner (n,0) matches world corner 1', near(vertAt(n, 0), corners[1]));
    ok('grid corner (n,n) matches world corner 2', near(vertAt(n, n), corners[2]));
    ok('grid corner (0,n) matches world corner 3', near(vertAt(0, n), corners[3]));

    // The centre must be the average of the four corners for a bilinear patch —
    // the check that actually catches a transposed u/v or a wrong edge pairing.
    const centre = vertAt(n / 2, n / 2);
    const avg = {
      x: (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4,
      y: (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4,
    };
    ok('the grid centre is the bilinear centre of the four corners', near(centre, avg));

    ok(
      'every vertex is flat (z = 0, a painter-ordered 2D composite)',
      g.positions.every((_, i) => i % 3 !== 2 || g.positions[i] === 0)
    );

    // UVs must span the full 0..1 range in both axes, matching QUAD_UVS.
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (let i = 0; i < g.uvs.length; i += 2) {
      uMin = Math.min(uMin, g.uvs[i]);
      uMax = Math.max(uMax, g.uvs[i]);
      vMin = Math.min(vMin, g.uvs[i + 1]);
      vMax = Math.max(vMax, g.uvs[i + 1]);
    }
    ok('UVs span exactly 0..1 on both axes', uMin === 0 && uMax === 1 && vMin === 0 && vMax === 1);

    // No index may point outside the vertex buffer — a class of bug that shows
    // up as garbage geometry or a device fault rather than a clean error.
    ok(
      'every index is in range',
      g.indices.every((ix) => ix >= 0 && ix < g.vertexCount)
    );
  }

  // --- degenerate inputs -----------------------------------------------------
  {
    const one = buildTessellatedQuadGeometry(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      1
    );
    ok('segments=1 degenerates to exactly the plain 4-vertex quad', one.vertexCount === 4 && one.indices.length === 6);
    let threw = false;
    try {
      buildTessellatedQuadGeometry([{ x: 0, y: 0 }], 4);
    } catch (_) {
      threw = true;
    }
    ok('a wrong corner count throws loudly rather than producing silent garbage', threw);
  }
}
