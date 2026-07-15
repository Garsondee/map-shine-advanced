/**
 * Node verification for foundry/active-scene-source.js (Keyhole Stage 2B).
 * Fully pure — every exported function takes the scene document as a plain
 * parameter rather than reaching into `canvas` itself, so it's testable with
 * plain mock objects, no DOM/Foundry globals required.
 */
import { isImageUrl, resolveAssetUrl, getActiveSceneBackground, getActiveSceneFloors } from '../active-scene-source.js';

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
}
