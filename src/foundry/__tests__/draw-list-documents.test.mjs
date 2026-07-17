/**
 * Node verification: DO THE COLLECTORS DECLARE EVERY DOCUMENT TYPE THEY READ?
 *
 * ============================================================================
 * WHY THIS SUITE EXISTS — a real bug, not a hypothetical
 * ============================================================================
 *
 * Author, 2026-07-17: *"I can move a tile and it's clearly moving the document
 * but it's not currently updating the tile's position when I release it, again
 * it only updates the tile when I pan or zoom and it leaves a version of the
 * tile behind."*
 *
 * `buildItems` is `collectSceneLayers` + `collectTokens`. `collectSceneLayers`
 * READS Tile documents. But boot.js watched only `['createToken','updateToken',
 * 'deleteToken']` — a list typed out by hand, in a different file, from memory.
 * So a moved tile kept its MSA art at the old position while Foundry's interface
 * chrome moved correctly: the "version left behind" was our stale art beside
 * Foundry's correctly-moved selection frame. **Nothing was broken. The renderer
 * was simply never told.**
 *
 * ============================================================================
 * WHY IT IS A PROXY AND NOT A LIST COMPARISON
 * ============================================================================
 *
 * The obvious test — `ok(SCENE_LAYER_DOCUMENTS.includes('Tile'))` — is WORTHLESS.
 * It restates the hand-kept list in a second place and passes forever, including
 * on the exact day someone teaches `collectSceneLayers` to read Drawings and
 * forgets to declare it. That is the same list drifting from the same subject,
 * with a green tick over it. This repo has a name for that shape: a check that
 * cannot fail the failure it exists to catch (`feedback_walls_must_be_passable_
 * and_wired`).
 *
 * So: hand the collector a scene whose collections are RECORDING PROXIES, and
 * assert that what it actually touched is what it declared. The subject of the
 * test is the collector's real behaviour, so the test tracks the code rather
 * than the code's description of itself. Add a document read without declaring
 * it and this goes red naming the type.
 *
 * The one thing it CANNOT prove is that boot.js registers hooks for the union —
 * that is DOM/Foundry wiring. `refreshVtPanViewerItems`' `documentSync` counters
 * are the live half of the same question.
 */
import { collectSceneLayers, SCENE_LAYER_DOCUMENTS } from '../scene-layers.js';
import { collectTokens, TOKEN_DOCUMENTS } from '../scene-tokens.js';

/**
 * Every embedded collection a Scene exposes that could plausibly feed a draw
 * list, mapped to the document type whose CRUD hooks Foundry fires for it
 * (`Hooks.callAll(`update${type}`)` — client-backend.mjs:327).
 *
 * Deliberately WIDER than what is read today: an entry here that a collector
 * never touches costs nothing, but a collector touching something absent from
 * this map would go unnoticed — so the unknown-key guard below closes that.
 */
const SCENE_COLLECTIONS = Object.freeze({
  levels: 'Level',
  tiles: 'Tile',
  tokens: 'Token',
  drawings: 'Drawing',
  walls: 'Wall',
  lights: 'AmbientLight',
  sounds: 'AmbientSound',
  templates: 'MeasuredTemplate',
  notes: 'Note',
  regions: 'Region',
});

const mkLevel = (id, sort, bottom, top) => ({
  id,
  name: `Level ${id}`,
  sort,
  elevation: { bottom, top },
  background: { src: `${id}-bg.webp`, tint: '#ffffff', alphaThreshold: 0.75 },
  foreground: { src: null },
  textures: {},
  visibility: { levels: new Set() },
});

const mkTile = (id, elevation) => ({
  id,
  elevation,
  sort: 0,
  x: 100,
  y: 100,
  width: 200,
  height: 200,
  rotation: 0,
  hidden: false,
  texture: { src: `${id}.webp`, anchorX: 0.5, anchorY: 0.5, fit: 'fill' },
  levels: new Set(),
  occlusion: { modes: new Set() },
});

const mkToken = (id) => ({
  id,
  x: 300,
  y: 300,
  width: 1,
  height: 1,
  rotation: 0,
  hidden: false,
  level: 'ground',
  texture: { src: `${id}.webp`, anchorX: 0.5, anchorY: 0.5 },
});

/** A scene whose every collection records the fact that it was touched. */
function makeRecordingScene(touched) {
  const contents = {
    levels: [mkLevel('ground', 0, 0, 10)],
    tiles: [mkTile('rug', 0)],
    tokens: [mkToken('hero')],
    drawings: [],
    walls: [],
    lights: [],
    sounds: [],
    templates: [],
    notes: [],
    regions: [],
  };
  const scene = {
    id: 'scene1',
    name: 'Recording Scene',
    width: 1000,
    height: 1000,
    padding: 0,
    grid: { size: 100 },
    background: { src: null },
    _view: 'ground',
  };
  for (const key of Object.keys(SCENE_COLLECTIONS)) {
    Object.defineProperty(scene, key, {
      get() {
        touched.add(key);
        return contents[key];
      },
      enumerable: true,
    });
  }
  return scene;
}

const noRoute = (p) => p;

export async function run(t) {
  // ---- collectSceneLayers: what it TOUCHES is what it DECLARES -------------
  {
    const touched = new Set();
    const scene = makeRecordingScene(touched);
    collectSceneLayers(scene, {
      viewedLevelId: 'ground',
      visibleLevelIds: ['ground'],
      isGM: true,
      getRouteFn: noRoute,
    });

    // Guard the guard: if the collector touched NOTHING, the proxy is not
    // wired and every assertion below would pass vacuously. This is the
    // difference between "declared correctly" and "I did not look".
    t.ok('collectSceneLayers touched at least one scene collection', touched.size > 0);

    const readTypes = [...touched].map((k) => SCENE_COLLECTIONS[k]);
    const unknown = [...touched].filter((k) => !SCENE_COLLECTIONS[k]);
    t.ok(`collectSceneLayers touched only known collections (saw: ${[...touched].join()})`, unknown.length === 0);

    const declared = new Set(SCENE_LAYER_DOCUMENTS);
    const undeclared = readTypes.filter((type) => !declared.has(type));
    t.ok(
      `collectSceneLayers declares every document it reads (undeclared: ${undeclared.join() || 'none'})`,
      undeclared.length === 0
    );

    // And the other direction: a declaration for something never read is dead
    // weight that makes the renderer redraw for nothing.
    const read = new Set(readTypes);
    const overDeclared = [...declared].filter((type) => !read.has(type));
    t.ok(
      `collectSceneLayers declares nothing it does not read (extra: ${overDeclared.join() || 'none'})`,
      overDeclared.length === 0
    );

    // THE REGRESSION, named. Tile is the type that was read-but-unwatched.
    t.ok('collectSceneLayers reads Tile (the 2026-07-17 bug)', read.has('Tile'));
    t.ok('collectSceneLayers reads Level', read.has('Level'));
  }

  // ---- collectTokens ------------------------------------------------------
  {
    const touched = new Set();
    const scene = makeRecordingScene(touched);
    collectTokens(scene, {
      visibleLevelIds: ['ground'],
      knownLevelIds: ['ground'],
      viewedLevelId: 'ground',
      isGM: true,
      getRouteFn: noRoute,
    });

    t.ok('collectTokens touched at least one scene collection', touched.size > 0);

    const readTypes = [...touched].map((k) => SCENE_COLLECTIONS[k]);
    const declared = new Set(TOKEN_DOCUMENTS);
    const undeclared = readTypes.filter((type) => !declared.has(type));
    t.ok(
      `collectTokens declares every document it reads (undeclared: ${undeclared.join() || 'none'})`,
      undeclared.length === 0
    );
    t.ok('collectTokens reads Token', new Set(readTypes).has('Token'));
  }

  // ---- the union boot.js derives its hooks from ----------------------------
  {
    const union = [...SCENE_LAYER_DOCUMENTS, ...TOKEN_DOCUMENTS];
    t.ok('the draw-list document union has no duplicates', new Set(union).size === union.length);
    t.ok('both declarations are frozen', Object.isFrozen(SCENE_LAYER_DOCUMENTS) && Object.isFrozen(TOKEN_DOCUMENTS));
    // Every declared name must be a real Foundry documentName, because it is
    // interpolated straight into a hook name (`update${type}`). A typo here is
    // a hook that silently never fires — the failure mode being fixed, wearing
    // a different hat.
    const known = new Set(Object.values(SCENE_COLLECTIONS));
    t.ok(
      'every declared type is a real Foundry documentName',
      union.every((type) => known.has(type))
    );
  }
}
