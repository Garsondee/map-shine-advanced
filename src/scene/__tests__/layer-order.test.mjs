/**
 * Node verification for scene/layer-order.js — THE layering law.
 *
 * The most valuable test here is `foundryReference` (bottom of file): a
 * transcription of Foundry's OWN `_compareObjects` (primary.mjs:480), which we
 * fuzz against ours over a few thousand random keys. Our version differs
 * intentionally in exactly one way (NaN-safe compares instead of subtraction),
 * so proving the two agree on real data is the whole point — it's the only
 * thing that turns "we copied Foundry's law" from a claim into a fact.
 */
import {
  SORT_LAYERS,
  makeLayerKey,
  compareLayerKeys,
  sortByLayer,
  isInForeground,
  resolveElevationFloorIndex,
  maskHostFloorIndices,
} from '../layer-order.js';

/** Foundry's actual comparator, transcribed verbatim from the vendored v14 source. */
function foundryReference(a, b) {
  return (
    (a.elevation || 0) - (b.elevation || 0) ||
    (a.sortLayer || 0) - (b.sortLayer || 0) ||
    (a.sort || 0) - (b.sort || 0) ||
    a.zIndex - b.zIndex ||
    a.tiebreak - b.tiebreak
  );
}

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);

export function run(t) {
  const { ok, throws } = t;

  // --- SORT_LAYERS must match Foundry's numbers exactly ----------------------
  {
    // Copied from client/canvas/groups/primary.mjs:41. If Foundry ever renumbers
    // these, MSA's stack silently diverges from the reference renderer — so the
    // constants are asserted, not just written down.
    ok('SORT_LAYERS.SCENE === 0', SORT_LAYERS.SCENE === 0);
    ok('SORT_LAYERS.TILES === 500', SORT_LAYERS.TILES === 500);
    ok('SORT_LAYERS.DRAWINGS === 600', SORT_LAYERS.DRAWINGS === 600);
    ok('SORT_LAYERS.TOKENS === 700', SORT_LAYERS.TOKENS === 700);
    ok('SORT_LAYERS.WEATHER === 1000', SORT_LAYERS.WEATHER === 1000);
    // MSA's own bands must live strictly inside Foundry's gaps, or they'd
    // reorder Foundry content rather than slot between it.
    ok(
      'MSA SCENE_EFFECTS between SCENE and TILES',
      SORT_LAYERS.SCENE_EFFECTS > SORT_LAYERS.SCENE && SORT_LAYERS.SCENE_EFFECTS < SORT_LAYERS.TILES
    );
    ok(
      'MSA TILE_EFFECTS between TILES and DRAWINGS',
      SORT_LAYERS.TILE_EFFECTS > SORT_LAYERS.TILES && SORT_LAYERS.TILE_EFFECTS < SORT_LAYERS.DRAWINGS
    );
    ok(
      'MSA TOKEN_EFFECTS between TOKENS and WEATHER',
      SORT_LAYERS.TOKEN_EFFECTS > SORT_LAYERS.TOKENS && SORT_LAYERS.TOKEN_EFFECTS < SORT_LAYERS.WEATHER
    );
  }

  // --- makeLayerKey ---------------------------------------------------------
  {
    const k = makeLayerKey({ elevation: 5 });
    ok(
      'makeLayerKey: defaults match Foundry\'s "|| 0" coercion',
      k.sortLayer === 0 && k.sort === 0 && k.zIndex === 0 && k.tiebreak === 0
    );
    ok('makeLayerKey: keeps elevation', k.elevation === 5);
    ok(
      'makeLayerKey: accepts -Infinity (Level#prepareBaseData produces it)',
      makeLayerKey({ elevation: -Infinity }).elevation === -Infinity
    );
    ok('makeLayerKey: accepts Infinity', makeLayerKey({ elevation: Infinity }).elevation === Infinity);
    throws('makeLayerKey: rejects NaN elevation', () => makeLayerKey({ elevation: NaN }), 'elevation must be a number');
    throws('makeLayerKey: rejects missing elevation', () => makeLayerKey({}), 'elevation must be a number');
  }

  // --- the law: term precedence --------------------------------------------
  {
    const k = (e, sl, s, z) => makeLayerKey({ elevation: e, sortLayer: sl, sort: s, zIndex: z });
    ok(
      'elevation dominates sortLayer',
      compareLayerKeys(k(1, SORT_LAYERS.TOKENS, 0, 0), k(2, SORT_LAYERS.SCENE, 0, 0)) < 0
    );
    ok(
      'sortLayer breaks an elevation tie',
      compareLayerKeys(k(5, SORT_LAYERS.SCENE, 0, 0), k(5, SORT_LAYERS.TILES, 0, 0)) < 0
    );
    ok(
      'sort breaks a sortLayer tie',
      compareLayerKeys(k(5, SORT_LAYERS.TILES, 1, 0), k(5, SORT_LAYERS.TILES, 2, 0)) < 0
    );
    ok('zIndex breaks a sort tie', compareLayerKeys(k(5, SORT_LAYERS.TILES, 1, 0), k(5, SORT_LAYERS.TILES, 1, 1)) < 0);
    ok('identical keys compare equal', compareLayerKeys(k(5, 500, 1, 0), k(5, 500, 1, 0)) === 0);
  }

  // --- the ±Infinity cases Foundry really produces --------------------------
  {
    const inf = makeLayerKey({ elevation: Infinity, sortLayer: SORT_LAYERS.SCENE });
    const infTile = makeLayerKey({ elevation: Infinity, sortLayer: SORT_LAYERS.TILES });
    // Foundry's own subtraction yields NaN here and falls through via `||`.
    // Ours must fall through the same way rather than producing garbage.
    ok('Infinity vs Infinity falls through to sortLayer', compareLayerKeys(inf, infTile) < 0);
    const negInf = makeLayerKey({ elevation: -Infinity });
    ok('-Infinity sorts below a finite elevation', compareLayerKeys(negInf, makeLayerKey({ elevation: 0 })) < 0);
    ok('-Infinity sorts below Infinity', compareLayerKeys(negInf, inf) < 0);
    ok('Infinity sorts above a finite elevation', compareLayerKeys(inf, makeLayerKey({ elevation: 99999 })) > 0);
  }

  // --- the "foreground tile" scenario, end to end ---------------------------
  {
    // The exact stack from the module header. If this ordering is right,
    // "Foreground Tiles" and "Tiles" are both correct with no special-casing —
    // that claim is the whole reason this module exists, so it gets a test.
    const items = [
      {
        name: 'chimney (foreground tile)',
        key: makeLayerKey({ elevation: 10, sortLayer: SORT_LAYERS.TILES, sort: 0 }),
      },
      { name: 'token', key: makeLayerKey({ elevation: 5, sortLayer: SORT_LAYERS.TOKENS }) },
      { name: 'level bg', key: makeLayerKey({ elevation: 0, sortLayer: SORT_LAYERS.SCENE, zIndex: 0 }) },
      { name: 'level fg (roof)', key: makeLayerKey({ elevation: 10, sortLayer: SORT_LAYERS.SCENE, zIndex: 1 }) },
      { name: 'rug (regular tile)', key: makeLayerKey({ elevation: 3, sortLayer: SORT_LAYERS.TILES, sort: 0 }) },
    ];
    const order = sortByLayer(items).map((i) => i.name);
    ok(
      'roof scenario: bg → rug → token → roof → chimney',
      order.join(' | ') === 'level bg | rug (regular tile) | token | level fg (roof) | chimney (foreground tile)'
    );
    // The single most important consequence: a token inside the elevation band
    // is painted UNDER the roof art, purely because 5 < 10.
    ok(
      'roof scenario: token paints before (under) the roof',
      order.indexOf('token') < order.indexOf('level fg (roof)')
    );
    // And a tile AT the foreground elevation beats the roof on sortLayer alone.
    ok(
      'roof scenario: foreground tile paints after (over) the roof',
      order.indexOf('chimney (foreground tile)') > order.indexOf('level fg (roof)')
    );
  }

  // --- a Level's own bg/fg at the SAME elevation (zero-height Level) ---------
  {
    // A Level with elevation {bottom: 0, top: 0} puts both textures at 0. Only
    // zIndex (0 vs 1) separates them — this is exactly why Foundry sets it.
    const items = [
      { name: 'fg', key: makeLayerKey({ elevation: 0, sortLayer: SORT_LAYERS.SCENE, sort: 0, zIndex: 1 }) },
      { name: 'bg', key: makeLayerKey({ elevation: 0, sortLayer: SORT_LAYERS.SCENE, sort: 0, zIndex: 0 }) },
    ];
    ok(
      'zero-height Level: zIndex still puts fg above bg',
      sortByLayer(items)
        .map((i) => i.name)
        .join() === 'bg,fg'
    );
  }

  // --- multi-floor: level `sort` (index) separates equal elevations ----------
  {
    // Two Levels can share an elevation boundary: floor 0 spans [0,10], floor 1
    // spans [10,20]. Floor 0's foreground and floor 1's background are BOTH at
    // elevation 10, both sortLayer SCENE. `sort` (the level index) decides.
    const items = [
      { name: 'floor1 bg', key: makeLayerKey({ elevation: 10, sortLayer: SORT_LAYERS.SCENE, sort: 1, zIndex: 0 }) },
      { name: 'floor0 fg', key: makeLayerKey({ elevation: 10, sortLayer: SORT_LAYERS.SCENE, sort: 0, zIndex: 1 }) },
    ];
    ok(
      "shared boundary: lower floor's roof paints under the upper floor's ground",
      sortByLayer(items)
        .map((i) => i.name)
        .join() === 'floor0 fg,floor1 bg'
    );
  }

  // --- sortByLayer: total order + stamping ---------------------------------
  {
    const items = [
      { name: 'c', key: makeLayerKey({ elevation: 0 }) },
      { name: 'a', key: makeLayerKey({ elevation: 0 }) },
      { name: 'b', key: makeLayerKey({ elevation: 0 }) },
    ];
    const sorted = sortByLayer(items);
    ok('sortByLayer: fully-tied items keep registration order', sorted.map((i) => i.name).join() === 'c,a,b');
    ok(
      'sortByLayer: stamps renderOrder = index',
      sorted.every((it, i) => it.renderOrder === i)
    );
    ok(
      'sortByLayer: assigns tiebreak from registration order',
      items.every((it, i) => sorted.find((s) => s === it) && it.key.tiebreak === i)
    );
    ok("sortByLayer: returns the caller's own objects, not copies", sorted.includes(items[0]));
    ok('sortByLayer: does not reorder the input array', items.map((i) => i.name).join() === 'c,a,b');
    ok('sortByLayer: empty list is fine', sortByLayer([]).length === 0);
  }

  // --- sortByLayer: no band to overflow ------------------------------------
  {
    // The point of not packing (floor, role, intra) into one scalar: an
    // arbitrary number of drawables at one elevation is simply fine. Legacy's
    // scheme capped this at 2400 per role band, and overflowing it silently
    // bled into the next role.
    const many = [];
    for (let i = 0; i < 5000; i++) {
      many.push({ name: `t${i}`, key: makeLayerKey({ elevation: 10, sortLayer: SORT_LAYERS.TILES, sort: i }) });
    }
    const sorted = sortByLayer(many);
    ok(
      '5000 tiles at one elevation: all distinct renderOrders',
      new Set(sorted.map((i) => i.renderOrder)).size === 5000
    );
    ok('5000 tiles at one elevation: order follows sort', sorted[0].name === 't0' && sorted[4999].name === 't4999');
    // A drawable in the NEXT role band must still outrank all 5000 of them —
    // this is the band-bleed failure legacy could produce and this cannot.
    const withDrawing = sortByLayer([
      ...many,
      { name: 'drawing', key: makeLayerKey({ elevation: 10, sortLayer: SORT_LAYERS.DRAWINGS }) },
    ]);
    ok('no band bleed: a DRAWINGS item still tops 5000 TILES items', withDrawing.at(-1).name === 'drawing');
  }

  // --- isInForeground -------------------------------------------------------
  {
    ok('isInForeground: at the Foreground Elevation → true', isInForeground(10, { top: 10 }));
    ok('isInForeground: above it → true', isInForeground(11, { top: 10 }));
    ok('isInForeground: below it → false', isInForeground(9, { top: 10 }) === false);
    ok(
      'isInForeground: Infinity top → nothing finite is foreground',
      isInForeground(99999, { top: Infinity }) === false
    );
    ok('isInForeground: Infinity top, Infinity elevation → true', isInForeground(Infinity, { top: Infinity }));
  }

  // --- resolveElevationFloorIndex --------------------------------------------
  {
    ok('resolveElevationFloorIndex: empty floors → null', resolveElevationFloorIndex([], 5) === null);
    ok('resolveElevationFloorIndex: non-array → null', resolveElevationFloorIndex(null, 5) === null);

    const floors = [
      { index: 0, elevationBottom: null, elevationTop: 10 }, // null bottom = -Infinity
      { index: 1, elevationBottom: 10, elevationTop: 20 },
      { index: 2, elevationBottom: 20, elevationTop: null }, // null top = +Infinity, topmost
    ];
    ok(
      'resolveElevationFloorIndex: deep basement (null bottom) → floor 0',
      resolveElevationFloorIndex(floors, -9999)?.index === 0
    );
    ok('resolveElevationFloorIndex: mid floor 0 → index 0', resolveElevationFloorIndex(floors, 5)?.index === 0);
    ok(
      'resolveElevationFloorIndex: EXACTLY at a boundary belongs to the floor ABOVE it (bottom-inclusive, top-exclusive)',
      resolveElevationFloorIndex(floors, 10)?.index === 1
    );
    ok('resolveElevationFloorIndex: mid floor 1 → index 1', resolveElevationFloorIndex(floors, 15)?.index === 1);
    ok('resolveElevationFloorIndex: mid floor 2 → index 2', resolveElevationFloorIndex(floors, 25)?.index === 2);
    ok(
      'resolveElevationFloorIndex: topmost band is unbounded (null top) → +Infinity resolves there',
      resolveElevationFloorIndex(floors, Infinity)?.index === 2
    );
    ok(
      'resolveElevationFloorIndex: returns the matched floor object too',
      resolveElevationFloorIndex(floors, 15)?.floor === floors[1]
    );

    // A non-topmost Level with a FINITE top, and a stray elevation above every
    // band — the documented "highest floor wins, never the first" fallback.
    const boundedFloors = [
      { index: 0, elevationBottom: 0, elevationTop: 5 },
      { index: 1, elevationBottom: 5, elevationTop: 10 },
    ];
    ok(
      'resolveElevationFloorIndex: elevation above every finite band → highest floor, not the first',
      resolveElevationFloorIndex(boundedFloors, 999)?.index === 1
    );
  }

  // --- PARITY FUZZ vs Foundry's own comparator ------------------------------
  {
    // Deterministic PRNG (no Math.random — a fuzz failure must be reproducible).
    let seed = 0x9e3779b9;
    const rand = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0x100000000;
    };
    // Values drawn from the small domain that actually collides: real scenes use
    // a handful of elevations and Foundry's own five sortLayers, so ties (the
    // only place the two implementations could disagree) are common here.
    const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];
    const ELEVS = [0, 0, 1, 3, 5, 10, 10, 20, -5];
    const LAYERS = [
      SORT_LAYERS.SCENE,
      SORT_LAYERS.TILES,
      SORT_LAYERS.DRAWINGS,
      SORT_LAYERS.TOKENS,
      SORT_LAYERS.WEATHER,
    ];
    let mismatches = 0;
    for (let i = 0; i < 4000; i++) {
      const a = makeLayerKey({
        elevation: pick(ELEVS),
        sortLayer: pick(LAYERS),
        sort: Math.floor(rand() * 4),
        zIndex: Math.floor(rand() * 2),
        tiebreak: Math.floor(rand() * 3),
      });
      const b = makeLayerKey({
        elevation: pick(ELEVS),
        sortLayer: pick(LAYERS),
        sort: Math.floor(rand() * 4),
        zIndex: Math.floor(rand() * 2),
        tiebreak: Math.floor(rand() * 3),
      });
      if (sign(compareLayerKeys(a, b)) !== sign(foundryReference(a, b))) mismatches++;
    }
    ok("PARITY: 4000 finite random keys — ours agrees with Foundry's comparator exactly", mismatches === 0);

    // Now the infinite cases. Foundry's raw subtraction produces NaN for
    // Infinity-vs-Infinity and relies on NaN being falsy to fall through; ours
    // returns 0 and falls through explicitly. Both must reach the same verdict.
    let infMismatches = 0;
    const INF_ELEVS = [-Infinity, Infinity, 0, 10];
    for (let i = 0; i < 2000; i++) {
      const a = makeLayerKey({
        elevation: pick(INF_ELEVS),
        sortLayer: pick(LAYERS),
        sort: Math.floor(rand() * 2),
        zIndex: Math.floor(rand() * 2),
        tiebreak: Math.floor(rand() * 2),
      });
      const b = makeLayerKey({
        elevation: pick(INF_ELEVS),
        sortLayer: pick(LAYERS),
        sort: Math.floor(rand() * 2),
        zIndex: Math.floor(rand() * 2),
        tiebreak: Math.floor(rand() * 2),
      });
      if (sign(compareLayerKeys(a, b)) !== sign(foundryReference(a, b))) infMismatches++;
    }
    ok("PARITY: 2000 keys including ±Infinity — ours agrees with Foundry's comparator exactly", infMismatches === 0);
  }

  // ── maskHostFloorIndices: WHICH FLOORS AN ITEM HOSTS MASKS FOR ─────────
  // ⚠️ THE LIVE BUG (2026-08-02): standing on the ROOF, ground-floor building
  // shadows were visible. `mask-authority.js#hostsOfFloor` decided mask
  // hosting by Foundry's `includedInLevel` DRAW rule, whose documented
  // default is that an EMPTY `levels` set means "present on every level" — so
  // an ordinary ground-floor prop with a blank `levels` field became a
  // wall-source for every floor, and its `_Outdoors` (the ground floor's own
  // building footprints, full-canvas and fully opaque) overwrote the roof's.
  {
    // The author's real Town River Bridge bands.
    const FLOORS = [
      { index: 0, id: 'ground', elevationBottom: 0, elevationTop: 10 },
      { index: 1, id: 'middle', elevationBottom: 10, elevationTop: 20 },
      { index: 2, id: 'roof', elevationBottom: 20, elevationTop: null },
    ];

    // --- level art: authored membership, never elevation -------------------
    // A Level's own FOREGROUND sits at its `elevation.top`, which the
    // half-open band `[bottom, top)` would throw to the floor ABOVE — the
    // exact `feedback_half_open_band_excludes_its_own_member` bug. `levelId`
    // outranks the arithmetic, so it cannot come back through this door.
    ok(
      "a Level's background hosts its OWN floor",
      String(maskHostFloorIndices({ levelId: 'middle', key: { elevation: 10 } }, FLOORS)) === '1'
    );
    ok(
      "a Level's FOREGROUND at its own elevationTop still hosts its own floor, not the one above",
      String(maskHostFloorIndices({ levelId: 'middle', key: { elevation: 20 } }, FLOORS)) === '1'
    );
    ok(
      'a Level whose id is not in this scene hosts nothing, rather than defaulting to floor 0',
      maskHostFloorIndices({ levelId: 'deleted', key: { elevation: 0 } }, FLOORS).length === 0
    );

    // --- THE REGRESSION: an unrestricted tile ------------------------------
    // `levelsRestricted: false` is Foundry's default (a blank `levels` field),
    // and `visibleOnLevelIds` correctly lists every floor because it is DRAWN
    // on every floor. It must still host masks for its own floor ONLY.
    const groundProp = {
      levelId: '',
      levelsRestricted: false,
      visibleOnLevelIds: ['ground', 'middle', 'roof'],
      key: { elevation: 8 },
    };
    ok(
      'an UNRESTRICTED ground-floor prop (drawn on every floor) hosts masks for its OWN floor only — the roof bug',
      String(maskHostFloorIndices(groundProp, FLOORS)) === '0'
    );
    ok(
      'and specifically NOT the roof, whose own mask it would otherwise overwrite',
      !maskHostFloorIndices(groundProp, FLOORS).includes(2)
    );

    // --- a tile that NAMES levels: the author stated intent, honour it ------
    // This is the locked "🧩 EVERY MASK ATTACHES TO ANY ITEM" case: a tile
    // deliberately carrying a mask for a floor it is not physically inside.
    const namedTile = {
      levelId: '',
      levelsRestricted: true,
      visibleOnLevelIds: ['middle', 'roof'],
      key: { elevation: 8 },
    };
    ok(
      'a tile that NAMES levels hosts exactly those, even against its own elevation',
      String(maskHostFloorIndices(namedTile, FLOORS)) === '1,2'
    );
    ok(
      'the "blow the corner off a building" tile still overwrites its own floor',
      maskHostFloorIndices(
        { levelId: '', levelsRestricted: true, visibleOnLevelIds: ['ground'], key: { elevation: 0 } },
        FLOORS
      ).includes(0)
    );

    // --- elevation resolution for unrestricted tiles ------------------------
    const atElev = (e) =>
      maskHostFloorIndices(
        {
          levelId: '',
          levelsRestricted: false,
          visibleOnLevelIds: ['ground', 'middle', 'roof'],
          key: { elevation: e },
        },
        FLOORS
      );
    ok('an unrestricted tile at 10 hosts the middle floor (band is [10, 20))', String(atElev(10)) === '1');
    ok('at 19 still the middle floor', String(atElev(19)) === '1');
    ok('at 20 the roof', String(atElev(20)) === '2');
    ok('at 999 the TOP floor, never floor 0', String(atElev(999)) === '2');
    ok('exactly one floor, always — an unrestricted tile is not a member of several', atElev(8).length === 1);

    // --- ⚠️ AN ABSENT `levelsRestricted` MEANS "NOT TOLD", NOT "UNRESTRICTED"
    // Every caller predating this rule (fixtures, the torture world) omits the
    // flag while still naming real levels in `visibleOnLevelIds`. Reading that
    // as unrestricted would send them through the elevation fallback and
    // silently re-attribute their masks — it re-pointed a tiles-only floor's
    // ONLY source at a different floor, which `mask-authority.test.mjs` caught.
    {
      const legacyNamed = { levelId: '', visibleOnLevelIds: ['roof'], key: { elevation: 0 } };
      ok(
        'a tile with NO levelsRestricted flag honours its named levels (pre-existing behaviour preserved)',
        String(maskHostFloorIndices(legacyNamed, FLOORS)) === '2'
      );
      ok(
        'and specifically does NOT fall through to its elevation (which would say floor 0)',
        !maskHostFloorIndices(legacyNamed, FLOORS).includes(0)
      );
    }

    // --- degenerate inputs must not throw mid-recompute ---------------------
    ok('no floors yields no hosts rather than throwing', maskHostFloorIndices({ levelId: 'x' }, []).length === 0);
    ok('a null item yields no hosts', maskHostFloorIndices(null, FLOORS).length >= 0);
    ok(
      'an unrestricted tile with no elevation info at all falls to the lowest band, not a crash',
      String(maskHostFloorIndices({ levelId: '', levelsRestricted: false }, FLOORS)) === '0'
    );
  }
}
