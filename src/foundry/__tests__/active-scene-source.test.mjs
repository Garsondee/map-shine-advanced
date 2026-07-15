/**
 * Node verification for foundry/active-scene-source.js (Keyhole Stage 2B).
 * Fully pure — every exported function takes the scene document as a plain
 * parameter rather than reaching into `canvas` itself, so it's testable with
 * plain mock objects, no DOM/Foundry globals required.
 */
import {
  isImageUrl,
  resolveAssetUrl,
  getActiveSceneBackground,
  getActiveSceneFloors,
  computeVisibleFloorIndices,
} from '../active-scene-source.js';

export function run(t) {
  const { ok } = t;

  // --- isImageUrl -----------------------------------------------------------
  {
    ok("isImageUrl: accepts webp (Foundry's common map format)", isImageUrl('worlds/x/map.webp'));
    ok('isImageUrl: accepts png/jpg/jpeg', isImageUrl('a.png') && isImageUrl('a.jpg') && isImageUrl('a.jpeg'));
    ok('isImageUrl: accepts a querystring suffix (cache-busting)', isImageUrl('a.webp?v=123'));
    ok('isImageUrl: is case-insensitive', isImageUrl('a.WEBP'));
    ok('isImageUrl: rejects mp4 (a real Foundry video-background extension)', !isImageUrl('a.mp4'));
    ok('isImageUrl: rejects webm', !isImageUrl('a.webm'));
    ok('isImageUrl: rejects no extension / empty / null', !isImageUrl('noext') && !isImageUrl('') && !isImageUrl(null));
  }

  // --- resolveAssetUrl --------------------------------------------------------
  {
    ok(
      'resolveAssetUrl: uses the injected getRouteFn when provided',
      resolveAssetUrl('worlds/x/map.webp', (p) => `/prefix/${p}`) === '/prefix/worlds/x/map.webp'
    );
    ok(
      'resolveAssetUrl: falls back to the raw path when no getRouteFn is available (no foundry global under Node)',
      resolveAssetUrl('worlds/x/map.webp') === 'worlds/x/map.webp'
    );
    ok(
      'resolveAssetUrl: a throwing getRouteFn falls back to the raw path rather than propagating',
      resolveAssetUrl('worlds/x/map.webp', () => {
        throw new Error('boom');
      }) === 'worlds/x/map.webp'
    );
  }

  // --- getActiveSceneBackground: no scene ------------------------------------
  {
    const res = getActiveSceneBackground(null);
    ok('getActiveSceneBackground: null scene is a clean {ok:false}, not a throw', res.ok === false);
    ok('getActiveSceneBackground: null-scene error mentions "no active scene"', /no active scene/i.test(res.error));
  }

  // --- getActiveSceneBackground: scene with no background set ----------------
  {
    const res = getActiveSceneBackground({ name: 'Empty Scene', background: { src: null } });
    ok('getActiveSceneBackground: missing background.src is {ok:false}', res.ok === false);
    ok('getActiveSceneBackground: error names the scene', res.error.includes('Empty Scene'));
  }

  // --- getActiveSceneBackground: video background is rejected loudly ---------
  {
    const res = getActiveSceneBackground({ name: 'Animated Tavern', background: { src: 'worlds/x/tavern.webm' } });
    ok('getActiveSceneBackground: video background is {ok:false}, not silently mis-decoded', res.ok === false);
    ok('getActiveSceneBackground: video-background error explains why', /video/i.test(res.error));
  }

  // --- getActiveSceneBackground: the real success path ------------------------
  {
    const res = getActiveSceneBackground(
      { name: 'The Sunken Temple', background: { src: 'worlds/x/temple.webp' } },
      (p) => `/game/${p}` // injected route resolver, proves it's actually threaded through
    );
    ok('getActiveSceneBackground: valid image background is {ok:true}', res.ok === true);
    ok(
      'getActiveSceneBackground: url is resolved via the injected getRouteFn',
      res.url === '/game/worlds/x/temple.webp'
    );
    ok('getActiveSceneBackground: name is passed through', res.name === 'The Sunken Temple');
  }

  // --- getActiveSceneFloors: no scene -----------------------------------------
  {
    const res = getActiveSceneFloors(null);
    ok('getActiveSceneFloors: null scene is a clean {ok:false}, not a throw', res.ok === false);
  }

  // --- getActiveSceneFloors: the primary path -- native scene.levels, SORTED
  // by elevation.bottom ascending, NOT array/creation order -------------------
  {
    // Deliberately created/array-ordered as Attic, Basement, Ground -- proves
    // sorting is by elevation, not by scene.levels' iteration order (which
    // scene.firstLevel's own doc comment explicitly warns is creation order).
    const sceneDoc = {
      name: 'The Old Manor',
      levels: [
        { name: 'Attic', elevation: { bottom: 20 }, background: { src: 'manor/attic.webp' } },
        { name: 'Basement', elevation: { bottom: -10 }, background: { src: 'manor/basement.webp' } },
        { name: 'Ground', elevation: { bottom: 0 }, background: { src: 'manor/ground.webp' } },
      ],
    };
    const res = getActiveSceneFloors(sceneDoc);
    ok('getActiveSceneFloors: multi-level scene is {ok:true}', res.ok === true);
    ok('getActiveSceneFloors: all 3 levels with backgrounds are included', res.floors.length === 3);
    ok(
      'getActiveSceneFloors: sorted bottom-to-top by elevation (Basement, Ground, Attic) -- NOT array order',
      res.floors[0].name === 'Basement' && res.floors[1].name === 'Ground' && res.floors[2].name === 'Attic'
    );
    ok(
      'getActiveSceneFloors: index is reassigned to the SORTED position (0,1,2), not original array index',
      res.floors[0].index === 0 && res.floors[1].index === 1 && res.floors[2].index === 2
    );
    ok('getActiveSceneFloors: elevationBottom is passed through', res.floors[0].elevationBottom === -10);
    ok('getActiveSceneFloors: nothing skipped in the clean case', res.skipped.length === 0);
  }

  // --- getActiveSceneFloors: carries id + visibilityLevelIds (the raw
  // material computeVisibleFloorIndices needs) --------------------------------
  {
    const sceneDoc = {
      name: 'Visibility Test',
      levels: [
        {
          _id: 'ground-id',
          id: 'ground-id',
          name: 'Ground',
          elevation: { bottom: 0 },
          background: { src: 'x/ground.webp' },
          visibility: { levels: new Set(['basement-id']) },
        },
        {
          _id: 'basement-id',
          id: 'basement-id',
          name: 'Basement',
          elevation: { bottom: -10 },
          background: { src: 'x/basement.webp' },
          visibility: { levels: new Set() },
        },
      ],
    };
    const res = getActiveSceneFloors(sceneDoc);
    const ground = res.floors.find((f) => f.name === 'Ground');
    ok('getActiveSceneFloors: id is passed through from the Level document', ground.id === 'ground-id');
    ok(
      "getActiveSceneFloors: visibilityLevelIds is a plain array from the Level's visibility.levels Set",
      Array.isArray(ground.visibilityLevelIds) && ground.visibilityLevelIds.includes('basement-id')
    );
  }

  // --- getActiveSceneFloors: tolerates a real Foundry EmbeddedCollection shape
  // (a Map-like with .values(), not a plain array) -----------------------------
  {
    const mapLike = new Map([
      ['id1', { name: 'Only Floor', elevation: { bottom: 0 }, background: { src: 'x/floor.webp' } }],
    ]);
    const res = getActiveSceneFloors({ name: 'Single Level Scene', levels: mapLike });
    ok('getActiveSceneFloors: Map-like .values() collection works (real EmbeddedCollection shape)', res.ok === true);
    ok('getActiveSceneFloors: the single level is floor 0', res.floors.length === 1 && res.floors[0].index === 0);
  }

  // --- getActiveSceneFloors: a Level with no background is silently skipped
  // (legitimate -- e.g. a lighting-only Level), NOT an error and NOT in skipped[] --
  {
    const sceneDoc = {
      name: 'Mixed Scene',
      levels: [
        { name: 'Lighting Only', elevation: { bottom: 0 }, background: { src: null } },
        { name: 'Real Floor', elevation: { bottom: 10 }, background: { src: 'x/floor.webp' } },
      ],
    };
    const res = getActiveSceneFloors(sceneDoc);
    ok('getActiveSceneFloors: a backgroundless Level is excluded from floors', res.floors.length === 1);
    ok('getActiveSceneFloors: the remaining floor is the real one', res.floors[0].name === 'Real Floor');
    ok(
      'getActiveSceneFloors: a backgroundless Level is NOT reported as skipped (not an error condition)',
      res.skipped.length === 0
    );
  }

  // --- getActiveSceneFloors: a video-background Level is skipped AND reported
  // (Doctrine #1 -- no silent drops), while the scene still succeeds overall --
  {
    const sceneDoc = {
      name: 'Animated Hall',
      levels: [
        { name: 'Animated Floor', elevation: { bottom: 0 }, background: { src: 'x/anim.webm' } },
        { name: 'Static Floor', elevation: { bottom: 10 }, background: { src: 'x/static.webp' } },
      ],
    };
    const res = getActiveSceneFloors(sceneDoc);
    ok(
      'getActiveSceneFloors: scene still succeeds via its other, usable floor',
      res.ok === true && res.floors.length === 1
    );
    ok('getActiveSceneFloors: the video-background level is reported in skipped[]', res.skipped.length === 1);
    ok(
      'getActiveSceneFloors: skipped entry names the level + explains why',
      res.skipped[0].name === 'Animated Floor' && /video/i.test(res.skipped[0].reason)
    );
  }

  // --- getActiveSceneFloors: no usable Level art -> falls back to the legacy
  // scene.background (deprecated getter, still a real single floor 0) ---------
  {
    const sceneDoc = { name: 'Unmigrated Scene', levels: [], background: { src: 'x/legacy-bg.webp' } };
    const res = getActiveSceneFloors(sceneDoc);
    ok('getActiveSceneFloors: empty levels falls back to legacy background', res.ok === true);
    ok('getActiveSceneFloors: fallback is a single floor 0', res.floors.length === 1 && res.floors[0].index === 0);
    ok(
      'getActiveSceneFloors: fallback floor has no elevation (not from a Level)',
      res.floors[0].elevationBottom === null
    );
  }

  // --- getActiveSceneFloors: no levels AND no legacy background -> a real,
  // honest failure (not a silent empty success) --------------------------------
  {
    const res = getActiveSceneFloors({ name: 'Totally Empty Scene', levels: [], background: { src: null } });
    ok('getActiveSceneFloors: no art anywhere is {ok:false}', res.ok === false);
    ok('getActiveSceneFloors: error names the scene', res.error.includes('Totally Empty Scene'));
  }

  // --- computeVisibleFloorIndices: replicates Foundry's REAL algorithm -------
  // (client/documents/scene.mjs#_configureLevelTextures + level.mjs#isVisible)

  // No visibility.levels configured at all -> ONLY the viewed floor shows.
  // This is the author-reported bug's exact scenario if a GM never set up
  // visibility (real Foundry shows just the one floor too -- NOT "always show
  // the floor below" by default).
  {
    const floors = [
      { index: 0, id: 'a', visibilityLevelIds: [] },
      { index: 1, id: 'b', visibilityLevelIds: [] },
    ];
    ok(
      'computeVisibleFloorIndices: no visibility configured -> only the viewed floor',
      JSON.stringify(computeVisibleFloorIndices(floors, 1)) === JSON.stringify([1])
    );
  }

  // The setting the user pointed at: floor 1 explicitly lists floor 0 as
  // visible -> both render when floor 1 is viewed (the hole-revealing case).
  {
    const floors = [
      { index: 0, id: 'basement', visibilityLevelIds: [] },
      { index: 1, id: 'ground', visibilityLevelIds: ['basement'] },
      { index: 2, id: 'attic', visibilityLevelIds: [] },
    ];
    ok(
      'computeVisibleFloorIndices: viewed floor + the one it lists as visible',
      JSON.stringify(computeVisibleFloorIndices(floors, 1)) === JSON.stringify([0, 1])
    );
    ok(
      'computeVisibleFloorIndices: attic is NOT included (ground did not list it)',
      !computeVisibleFloorIndices(floors, 1).includes(2)
    );
  }

  // NOT symmetric: basement listing ground as visible does NOT mean ground
  // shows basement -- matches Level#isVisible's one-directional .has() check
  // exactly (viewedLevel.visibility.levels.has(this.id), never the reverse).
  {
    const floors = [
      { index: 0, id: 'basement', visibilityLevelIds: ['ground'] }, // basement -> ground, one-way
      { index: 1, id: 'ground', visibilityLevelIds: [] },
    ];
    ok(
      'computeVisibleFloorIndices: visibility is NOT symmetric (viewing ground does not pull in basement)',
      JSON.stringify(computeVisibleFloorIndices(floors, 1)) === JSON.stringify([1])
    );
    ok(
      'computeVisibleFloorIndices: but viewing basement DOES pull in ground (the one-way direction that was set)',
      JSON.stringify(computeVisibleFloorIndices(floors, 0)) === JSON.stringify([0, 1])
    );
  }

  // Result is always sorted ascending (== elevation order, since
  // getActiveSceneFloors already sorts by elevation.bottom before assigning
  // index) regardless of visibilityLevelIds' own order or floors' array order.
  {
    const floors = [
      { index: 2, id: 'top', visibilityLevelIds: ['bottom', 'mid'] },
      { index: 0, id: 'bottom', visibilityLevelIds: [] },
      { index: 1, id: 'mid', visibilityLevelIds: [] },
    ];
    ok(
      'computeVisibleFloorIndices: result is sorted ascending regardless of input order',
      JSON.stringify(computeVisibleFloorIndices(floors, 2)) === JSON.stringify([0, 1, 2])
    );
  }

  // A viewedIndex that doesn't exist in floors[] returns an empty list rather
  // than throwing (defensive -- the viewer should never call this with a bad
  // index, but a clean empty result is safer than a crash if it ever does).
  {
    const floors = [{ index: 0, id: 'a', visibilityLevelIds: [] }];
    ok(
      'computeVisibleFloorIndices: unknown viewedIndex is a clean empty array, not a throw',
      computeVisibleFloorIndices(floors, 99).length === 0
    );
  }
}
