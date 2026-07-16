/**
 * Node verification for foundry/scene-layers.js — Scene documents -> keyed draw items.
 *
 * The centrepiece is the "cabin" fixture near the bottom: a realistic two-floor
 * scene with a rug, a roof tile and a chimney, run end-to-end through collection
 * AND the real sort law. If that stack comes out in the right order, "Foreground
 * Tiles" and "Tiles" are both correct — which is the whole point of the exercise.
 */
import {
  normalizeTint,
  sortedLevels,
  levelElevation,
  isLevelVisible,
  includedInLevel,
  collectLevelTextures,
  collectTiles,
  collectSceneLayers,
  computeItemPlacement,
} from '../scene-layers.js';
import { sortByLayer, SORT_LAYERS } from '../../scene/layer-order.js';
import { OCCLUSION_MODES } from '../../scene/occlusion.js';

/** A Level shaped like the real document (post-prepareBaseData). */
const mkLevel = (id, sort, bottom, top, extra = {}) => ({
  id,
  name: `Level ${id}`,
  sort,
  elevation: { bottom, top },
  background: { src: `${id}-bg.webp`, tint: '#ffffff', alphaThreshold: 0.75 },
  foreground: { src: null },
  textures: {},
  visibility: { levels: new Set() },
  ...extra,
});

const mkTile = (id, elevation, sort, extra = {}) => ({
  id,
  elevation,
  sort,
  x: 100,
  y: 100,
  width: 200,
  height: 100,
  rotation: 0,
  alpha: 1,
  hidden: false,
  levels: new Set(),
  texture: { src: `${id}.webp`, anchorX: 0.5, anchorY: 0.5, fit: 'fill', scaleX: 1, scaleY: 1, alphaThreshold: 0.75 },
  occlusion: { modes: new Set(), alpha: 0 },
  restrictions: { light: false, weather: false },
  ...extra,
});

export function run(t) {
  const { ok } = t;
  const noRoute = (p) => p; // identity getRoute for tests

  // --- normalizeTint --------------------------------------------------------
  {
    ok('tint: "#ff8800" -> 0xff8800', normalizeTint('#ff8800') === 0xff8800);
    ok('tint: number passes through', normalizeTint(0x123456) === 0x123456);
    ok('tint: null -> white default', normalizeTint(null) === 0xffffff);
    ok('tint: garbage -> fallback', normalizeTint('nonsense') === 0xffffff);
    // Foundry's Color is a Number subclass.
    ok('tint: object with valueOf() (Foundry Color)', normalizeTint({ valueOf: () => 0xabcdef }) === 0xabcdef);
  }

  // --- sortedLevels: index comes from `sort`, NOT elevation ----------------
  {
    // The divergence that would have been shipped silently. Level "a" is HIGHER
    // in elevation but LOWER in sort. Foundry's index follows sort.
    const scene = { levels: [mkLevel('a', 0, 100, 200), mkLevel('b', 1, 0, 100)] };
    const sorted = sortedLevels(scene);
    ok('sortedLevels: ordered by level.sort, not elevation', sorted.map((s) => s.level.id).join() === 'a,b');
    ok('sortedLevels: index follows sort order', sorted[0].index === 0 && sorted[1].index === 1);
    // When Foundry has already assigned `index`, prefer it verbatim.
    const withIndex = {
      levels: [
        { ...mkLevel('x', 5, 0, 10), index: 1 },
        { ...mkLevel('y', 9, 0, 10), index: 0 },
      ],
    };
    ok(
      "sortedLevels: uses Foundry's own level.index when present",
      sortedLevels(withIndex)
        .map((s) => s.level.id)
        .join() === 'y,x'
    );
    ok('sortedLevels: empty scene is fine', sortedLevels({}).length === 0 && sortedLevels(null).length === 0);
  }

  // --- levelElevation: null -> ±Infinity ----------------------------------
  {
    // Level#prepareBaseData: bottom ??= -Infinity, top ??= Infinity. A null
    // bottom means "extends down forever", NOT zero.
    ok(
      'levelElevation: null bottom -> -Infinity',
      levelElevation({ elevation: { bottom: null, top: 10 } }).bottom === -Infinity
    );
    ok(
      'levelElevation: null top -> Infinity',
      levelElevation({ elevation: { bottom: 0, top: null } }).top === Infinity
    );
    ok(
      'levelElevation: missing elevation entirely -> ±Infinity',
      levelElevation({}).bottom === -Infinity && levelElevation({}).top === Infinity
    );
    ok('levelElevation: real values pass through', levelElevation({ elevation: { bottom: 0, top: 20 } }).top === 20);
  }

  // --- isLevelVisible: Foundry's one-directional rule ----------------------
  {
    const a = mkLevel('a', 0, 0, 10);
    const b = mkLevel('b', 1, 10, 20);
    ok('isVisible: the viewed level sees itself', isLevelVisible(a, a));
    ok('isVisible: NOT visible by default (no visibility.levels configured)', isLevelVisible(b, a) === false);
    // Viewing `a`, which lists `b`.
    const aSeesB = { ...a, visibility: { levels: new Set(['b']) } };
    ok('isVisible: viewed level listing b -> b is visible', isLevelVisible(b, aSeesB));
    // NOT symmetric — b listing a does not make b visible from a.
    const bSeesA = { ...b, visibility: { levels: new Set(['a']) } };
    ok('isVisible: NOT symmetric (b listing a does not make b visible from a)', isLevelVisible(bSeesA, a) === false);
    ok('isVisible: null viewed -> false', isLevelVisible(a, null) === false);
  }

  // --- includedInLevel: EMPTY SET MEANS ALL --------------------------------
  {
    // The single most misreadable line in Foundry's level model.
    ok('includedInLevel: EMPTY levels set -> on EVERY level', includedInLevel({ levels: new Set() }, 'anything'));
    ok('includedInLevel: no levels field at all -> on every level', includedInLevel({}, 'anything'));
    ok('includedInLevel: explicit membership', includedInLevel({ levels: new Set(['a']) }, 'a'));
    ok('includedInLevel: explicit non-membership', includedInLevel({ levels: new Set(['a']) }, 'b') === false);
    ok('includedInLevel: array form (test mocks)', includedInLevel({ levels: ['a'] }, 'a'));
  }

  // --- collectLevelTextures: bg and fg get DIFFERENT elevations ------------
  {
    const level = mkLevel('a', 0, 0, 10, { foreground: { src: 'a-fg.webp', tint: '#ffffff', alphaThreshold: 0.5 } });
    const { items } = collectLevelTextures({ levels: [level] }, { viewedLevelId: 'a', getRouteFn: noRoute });
    ok('level art: emits background + foreground', items.length === 2);
    const bg = items.find((i) => i.kind === 'levelBackground');
    const fg = items.find((i) => i.kind === 'levelForeground');
    // THE mechanism: the roof is at the TOP of the band, the ground at the bottom.
    ok('level art: background at elevation.bottom (0)', bg.key.elevation === 0);
    ok('level art: foreground at elevation.top (10) — NOT the same as bg', fg.key.elevation === 10);
    ok(
      'level art: both are sortLayer SCENE',
      bg.key.sortLayer === SORT_LAYERS.SCENE && fg.key.sortLayer === SORT_LAYERS.SCENE
    );
    ok('level art: zIndex separates them (bg 0, fg 1)', bg.key.zIndex === 0 && fg.key.zIndex === 1);
    ok('level art: sort is the level index', bg.key.sort === 0 && fg.key.sort === 0);
    ok('level art: ids are stable and distinct', bg.id === 'level:a:background' && fg.id === 'level:a:foreground');
    ok(
      'level art: background restricts light+weather, foreground does not',
      bg.restrictsLight && bg.restrictsWeather && !fg.restrictsLight
    );
    ok('level art: alphaThreshold read per-texture', fg.alphaThreshold === 0.5);
  }

  // --- collectLevelTextures: visibility gating -----------------------------
  {
    const a = mkLevel('a', 0, 0, 10);
    const b = mkLevel('b', 1, 10, 20);
    const onlyA = collectLevelTextures({ levels: [a, b] }, { viewedLevelId: 'a', getRouteFn: noRoute });
    ok(
      'visibility: an unlisted other level contributes nothing',
      onlyA.items.every((i) => i.levelId === 'a')
    );
    // Now let a see b.
    const aSeesB = { ...a, visibility: { levels: new Set(['b']) } };
    const both = collectLevelTextures({ levels: [aSeesB, b] }, { viewedLevelId: 'a', getRouteFn: noRoute });
    ok(
      'visibility: a listed level contributes its art',
      both.items.some((i) => i.levelId === 'b')
    );
    // b's background is ABOVE a's bottom -> isUpper -> SURFACE occlusion.
    const bBg = both.items.find((i) => i.levelId === 'b');
    ok('visibility: upper level art is flagged isUpper', bBg.isUpper === true);
    ok('visibility: upper level art defaults to SURFACE occlusion', bBg.occlusion.modes === OCCLUSION_MODES.SURFACE);
    const aBg = both.items.find((i) => i.levelId === 'a' && i.kind === 'levelBackground');
    ok("visibility: the viewed level's own art is never isUpper", aBg.isUpper === false && aBg.occlusion.modes === 0);
    ok(
      'visibility: no viewed level -> nothing at all',
      collectLevelTextures({ levels: [a] }, { viewedLevelId: 'nope' }).items.length === 0
    );
  }

  // --- collectLevelTextures: video art is reported, not silently dropped ----
  {
    const level = mkLevel('a', 0, 0, 10, { background: { src: 'a-bg.webm', tint: '#ffffff' } });
    const { items, skipped } = collectLevelTextures({ levels: [level] }, { viewedLevelId: 'a', getRouteFn: noRoute });
    ok('video level art: skipped', items.length === 0);
    ok(
      'video level art: reported with a reason',
      skipped.length === 1 && skipped[0].reason.includes('not a still image')
    );
    // A srcless level is legitimate, not an error.
    const srcless = mkLevel('b', 0, 0, 10, { background: { src: null } });
    ok(
      'srcless level: silently contributes nothing (legitimate)',
      collectLevelTextures({ levels: [srcless] }, { viewedLevelId: 'b' }).skipped.length === 0
    );
  }

  // --- collectTiles: elevation is the ONLY thing that makes a roof ---------
  {
    const rug = mkTile('rug', 3, 0);
    const chimney = mkTile('chimney', 10, 0);
    const { items } = collectTiles({ tiles: [rug, chimney] }, { visibleLevelIds: ['a'], getRouteFn: noRoute });
    ok('tiles: both emitted', items.length === 2);
    ok(
      'tiles: sortLayer is TILES for both',
      items.every((i) => i.key.sortLayer === SORT_LAYERS.TILES)
    );
    // There is no isForeground field, because Foundry has no such field.
    ok('tiles: key elevation is the document elevation', items.find((i) => i.id === 'tile:rug').key.elevation === 3);
    ok(
      'tiles: the "foreground tile" is just a higher elevation',
      items.find((i) => i.id === 'tile:chimney').key.elevation === 10
    );
    ok('tiles: sort carries through', items[0].key.sort === 0);
  }

  // --- collectTiles: the `levels` dropdown gates visibility ---------------
  {
    const onA = mkTile('onA', 5, 0, { levels: new Set(['a']) });
    const onB = mkTile('onB', 5, 0, { levels: new Set(['b']) });
    const everywhere = mkTile('everywhere', 5, 0, { levels: new Set() });
    const scene = { tiles: [onA, onB, everywhere] };

    const viewingA = collectTiles(scene, { visibleLevelIds: ['a'], getRouteFn: noRoute });
    ok(
      'tile levels: only a-tiles + the everywhere tile on floor a',
      viewingA.items
        .map((i) => i.id)
        .sort()
        .join() === 'tile:everywhere,tile:onA'
    );

    // MSA's divergence: both floors visible -> both floors' tiles.
    const bothVisible = collectTiles(scene, { visibleLevelIds: ['a', 'b'], getRouteFn: noRoute });
    ok('tile levels: both floors visible -> every tile appears', bothVisible.items.length === 3);
    // ...and each appears EXACTLY ONCE, despite the empty-set tile matching both.
    ok(
      'tile levels: the all-levels tile is emitted ONCE, not once per level',
      bothVisible.items.filter((i) => i.id === 'tile:everywhere').length === 1
    );
    ok(
      'tile levels: records which visible levels included it',
      bothVisible.items.find((i) => i.id === 'tile:everywhere').visibleOnLevelIds.join() === 'a,b'
    );
    ok(
      'tile levels: a tile on no visible level is dropped',
      collectTiles(scene, { visibleLevelIds: ['c'] }).items.length === 1
    );
  }

  // --- collectTiles: occlusion modes -------------------------------------
  {
    const roof = mkTile('roof', 10, 0, {
      occlusion: { modes: new Set([OCCLUSION_MODES.RADIAL, OCCLUSION_MODES.VISION]), alpha: 0.2 },
    });
    const { items } = collectTiles({ tiles: [roof] }, { visibleLevelIds: ['a'], getRouteFn: noRoute });
    ok("tiles: occlusion modes are OR'd into a bitfield (RADIAL|VISION = 12)", items[0].occlusion.modes === 12);
    ok('tiles: occlusion alpha carries through', items[0].occlusion.alpha === 0.2);
    const plain = collectTiles({ tiles: [mkTile('plain', 0, 0)] }, { visibleLevelIds: ['a'] });
    ok('tiles: no modes -> NONE', plain.items[0].occlusion.modes === 0);
  }

  // --- collectTiles: hidden + restrictions -------------------------------
  {
    const hidden = mkTile('h', 0, 0, { hidden: true });
    const gm = collectTiles({ tiles: [hidden] }, { visibleLevelIds: ['a'], isGM: true });
    ok('hidden tile: the GM sees it', gm.items.length === 1);
    ok("hidden tile: dimmed to 0.5 for the GM (Foundry's own _refreshState)", gm.items[0].alpha === 0.5);
    const player = collectTiles({ tiles: [hidden] }, { visibleLevelIds: ['a'], isGM: false });
    ok('hidden tile: a player does not', player.items.length === 0);

    const restricting = mkTile('r', 0, 0, { restrictions: { light: true, weather: true } });
    const res = collectTiles({ tiles: [restricting] }, { visibleLevelIds: ['a'] });
    ok('tiles: restrictions carry through', res.items[0].restrictsLight && res.items[0].restrictsWeather);

    // A srcless tile is legitimate; a video tile is reported.
    ok(
      'tiles: srcless is skipped silently',
      collectTiles({ tiles: [mkTile('n', 0, 0, { texture: { src: null } })] }, { visibleLevelIds: ['a'] }).items
        .length === 0
    );
    const video = collectTiles(
      { tiles: [mkTile('v', 0, 0, { texture: { src: 'v.webm' } })] },
      { visibleLevelIds: ['a'] }
    );
    ok('tiles: video is reported, not silently dropped', video.items.length === 0 && video.skipped.length === 1);
  }

  // --- THE CABIN: a realistic two-floor scene, collected AND sorted --------
  {
    // Ground floor [0,10] with a roof image; upstairs [10,20]. Viewing the ground
    // floor, which is configured to also show upstairs.
    const ground = mkLevel('ground', 0, 0, 10, {
      visibility: { levels: new Set(['upper']) },
      foreground: { src: 'ground-roof.webp', tint: '#ffffff' },
    });
    const upper = mkLevel('upper', 1, 10, 20);
    const scene = {
      width: 4000,
      height: 3000,
      padding: 0.25,
      grid: { size: 100 },
      levels: [ground, upper],
      tiles: [
        mkTile('rug', 3, 0), // on the ground floor, under everything
        mkTile('chimney', 10, 0), // AT the foreground elevation -> a "foreground tile"
        mkTile('bed', 12, 0, { levels: new Set(['upper']) }), // upstairs furniture
      ],
    };

    const { items, dimensions } = collectSceneLayers(scene, {
      viewedLevelId: 'ground',
      visibleLevelIds: ['ground', 'upper'],
      getRouteFn: noRoute,
    });
    const order = sortByLayer(items).map((i) => i.id);

    // The full stack, bottom to top, with each item's (elevation, sortLayer, sort, zIndex):
    //   level:ground:background  (0,   0,   0, 0)
    //   tile:rug                 (3,   500, 0, 0)
    //   level:ground:foreground  (10,  0,   0, 1)   ← the roof
    //   level:upper:background   (10,  0,   1, 0)   ← upstairs floor, same elevation
    //   tile:chimney             (10,  500, 0, 0)   ← "foreground tile"
    //   tile:bed                 (12,  500, 0, 0)
    ok('cabin: ground background is at the bottom', order[0] === 'level:ground:background');
    ok('cabin: the rug sits on the ground floor above its background', order[1] === 'tile:rug');

    // THREE items collide at elevation 10, and the tie-break order is worth
    // spelling out because it is NOT the intuitive one. `sortLayer` outranks
    // `sort`, so ALL level art at a shared elevation paints below ANY tile at
    // that elevation:
    //   - ground roof before upstairs floor : both SCENE, so `sort` (level index) decides, 0 < 1.
    //   - chimney above BOTH               : SCENE(0) < TILES(500) beats any `sort`.
    // The chimney therefore pokes above the upstairs floor rather than being
    // buried by it — which is Foundry's own behavior, and incidentally what a
    // chimney should do.
    ok(
      'cabin: at elevation 10 — roof → upstairs floor → chimney (sortLayer outranks sort)',
      order.slice(2, 5).join(' | ') === 'level:ground:foreground | level:upper:background | tile:chimney'
    );
    ok('cabin: upstairs furniture tops the stack', order[5] === 'tile:bed');
    ok('cabin: nothing else crept in', order.length === 6);

    // MSA's divergence, stated as a test: upstairs furniture is drawn even though
    // upstairs is not the VIEWED level. Real Foundry would omit `tile:bed`.
    ok('cabin: MSA divergence — a non-viewed but VISIBLE floor contributes its tiles', order.includes('tile:bed'));

    // The ground roof must paint above the rug and below the chimney.
    ok('cabin: the roof covers the rug', order.indexOf('level:ground:foreground') > order.indexOf('tile:rug'));
    ok(
      'cabin: the chimney sits on top of the roof',
      order.indexOf('tile:chimney') > order.indexOf('level:ground:foreground')
    );

    // Placement resolves against the padded canvas, not the raw image.
    const bg = items.find((i) => i.id === 'level:ground:background');
    const placement = computeItemPlacement(bg, { width: 4000, height: 3000 }, dimensions);
    ok(
      'cabin: level art is centred on the INSET sceneRect (padding respected)',
      placement.x === 3000 && placement.y === 2300
    );
    const rugItem = items.find((i) => i.id === 'tile:rug');
    const rugPlacement = computeItemPlacement(rugItem, { width: 200, height: 100 }, dimensions);
    ok('cabin: a tile is placed at its own canvas-space x,y', rugPlacement.x === 100 && rugPlacement.y === 100);
  }

  // --- collectSceneLayers: defaults ---------------------------------------
  {
    const scene = { levels: [mkLevel('a', 0, 0, 10)], tiles: [mkTile('t', 5, 0)] };
    const res = collectSceneLayers(scene, { viewedLevelId: 'a', getRouteFn: noRoute });
    ok('collect: visibleLevelIds defaults to just the viewed level', res.items.length === 2);
    ok('collect: returns scene dimensions alongside', res.dimensions.width > 0);
    ok('collect: empty scene is fine', collectSceneLayers({}, {}).items.length === 0);
  }
}
