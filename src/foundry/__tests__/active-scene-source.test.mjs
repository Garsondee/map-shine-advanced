/**
 * Node verification for foundry/active-scene-source.js (Keyhole Stage 2B).
 * Fully pure — `getActiveSceneBackground` takes the scene document as a plain
 * parameter rather than reaching into `canvas` itself, so it's testable with
 * plain mock objects, no DOM/Foundry globals required.
 */
import { isImageUrl, resolveAssetUrl, getActiveSceneBackground } from '../active-scene-source.js';

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
}
