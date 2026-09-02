/**
 * @fileoverview foundry/tile-video.js — hands a video Tile's own `<video>`
 * element to Foundry's REAL `game.video` singleton (`VideoHelper`,
 * `client/helpers/media/video-helper.mjs`) so it plays under the exact same
 * first-user-gesture gate every native Foundry video tile already uses.
 *
 * WHY REUSE `game.video` RATHER THAN BUILD A SECOND GESTURE-LOCK
 * (mythica-machina-press#430) — verified against the real v14 source, not
 * assumed. `VideoHelper#play(video, {playing, loop, offset, volume})`
 * operates on ANY `HTMLVideoElement`:
 *
 *     async play(video, {playing=true, loop=true, offset, volume}={}) {
 *       video.loop = loop;
 *       offset ??= video.currentTime;
 *       if (volume !== undefined) video.volume = volume;
 *       if (!playing) return video.pause();
 *       if (this.locked) return this.pending.add([video, offset]);
 *       video.currentTime = Math.clamp(offset, 0, video.duration);
 *       return video.play();
 *     }
 *
 * — nothing PIXI-specific in it at all; it reads/writes plain
 * `HTMLVideoElement` properties and calls plain `HTMLVideoElement` methods.
 * `game.video.locked` starts `true` and only flips to `false` on the FIRST
 * `contextmenu`/`auxclick`/`pointerdown`/`pointerup`/`keydown` observed
 * ANYWHERE on the page (`VideoHelper#awaitFirstGesture`, listening on
 * `document`) — a call made while still locked is queued in
 * `game.video.pending` and replayed automatically the instant that first
 * gesture fires (`#onFirstGesture`). `awaitFirstGesture()` is called once,
 * unconditionally, during Foundry's OWN client boot (`client/game.mjs:2161`,
 * `game.video.awaitFirstGesture()`) — MSA never needs to call it itself;
 * that listener is already armed on `document` regardless of whether MSA or
 * native PIXI is doing the rendering, since MSA only replaces canvas
 * rendering, not the rest of the Foundry client.
 *
 * An MSA-owned `<video>` element (built fresh in `vt-pan-viewer.js`'s
 * whole-image video path — MSA's rendering has taken over this Tile's
 * pixels, so there is no PIXI-owned element left to reuse even if one still
 * exists underneath) handed to `game.video.play()` gets the IDENTICAL
 * browser-autoplay-safe behavior a native Foundry Tile's own video gets, for
 * free: no second gesture listener, no second lock flag, no risk of MSA's
 * own lock ever disagreeing with Foundry's about whether a gesture has
 * happened yet.
 *
 * PLAYBACK CONFIG SHAPE mirrors `Tile#_refreshVideo()` exactly
 * (`client/canvas/placeables/tile.mjs`):
 *
 *     const playOptions = {...this.document.video, volume: this.volume};
 *     playOptions.playing = (this.#hudVideoOptions.playVideo ?? playOptions.autoplay);
 *     game.video.play(video, playOptions);
 *
 * where `Tile#volume` is `document.video.volume *
 * game.settings.get("core", "globalAmbientVolume")`. `document.video` is
 * `TileDocument`'s own schema field (`common/documents/tile.mjs:63-67`):
 *
 *     video: new fields.SchemaField({
 *       loop: new fields.BooleanField({initial: true}),
 *       autoplay: new fields.BooleanField({initial: true}),
 *       volume: new fields.AlphaField({initial: 0, step: 0.01})
 *     })
 *
 * Note the DEFAULT is SILENT (`volume: 0`), not `autoplay: false` and not
 * `<video muted>` — a fresh Tile plays automatically but inaudibly until a
 * GM raises its own volume slider. This mirrors that exactly (see
 * `playTileVideo`'s own `volume` computation below) rather than picking a
 * different, more familiar-looking default.
 *
 * `#hudVideoOptions` (the GM's Tile-HUD manual play/pause/scrub controls)
 * is DELIBERATELY not replicated here — see mythica-machina-press#430's own
 * "explicitly out of scope" note: MSA has taken over this Tile's rendering,
 * so Foundry's native HUD no longer has an element it can reach at all.
 * `playTileVideo` therefore always reads `document.video.autoplay` as the
 * sole `playing` input, matching a Tile that has never had its HUD touched
 * (the common case), rather than trying to forward a control surface this
 * pass does not wire up.
 *
 * DELIBERATELY TILE-ONLY — Level background/foreground video plays through
 * a materially different, simpler call
 * (`client/canvas/groups/primary.mjs#drawLevelTexture`:
 * `game.video.play(video, {volume: game.settings.get("core",
 * "globalAmbientVolume")})`, no per-document loop/autoplay config at all —
 * `BaseLevel`'s schema, `common/documents/level.mjs`, has no `video` field
 * whatsoever). Out of scope for this pass — see
 * `active-scene-source.js`'s own "STILL DELIBERATELY NOT BUILT" note.
 *
 * @module foundry/tile-video
 */

/**
 * Hand a Tile's video element to the real `game.video` singleton so it
 * plays under Foundry's own first-gesture gate, at the Tile document's own
 * configured loop/autoplay/volume — see this file's header for the full
 * mechanism and citations.
 *
 * Safe to call before `game.video` exists (a headless/Node test context, or
 * a very early boot race): returns `false` rather than throwing, matching
 * this adapter layer's own established tolerance for a not-yet-ready
 * Foundry global (compare `resolveAssetUrl`'s `typeof fn === 'function'`
 * guard, `active-scene-source.js`).
 *
 * @param {HTMLVideoElement} video - MSA's OWN video element (the
 *   `THREE.VideoTexture` source), built by `vt-pan-viewer.js`'s whole-image
 *   video path.
 * @param {object|null} tileDoc - the Tile document
 *   (`item._placement.tileDoc` from `scene-layers.js#collectTiles`). A
 *   missing/`null` doc plays at the schema defaults (`loop: true,
 *   autoplay: true, volume: 0`) rather than throwing.
 * @returns {boolean} true if the call reached `game.video`, false if the
 *   Foundry global wasn't available to call it on.
 */
export function playTileVideo(video, tileDoc) {
  const gv = globalThis.game?.video;
  if (!gv || typeof gv.play !== 'function') return false;
  const cfg = tileDoc?.video ?? {};
  // `game.settings.get("core", "globalAmbientVolume")` — read defensively:
  // this file runs inside `src/foundry/`, the one place allowed to touch
  // `game.*` (`foundry/adapter-only`), but a settings key can still be
  // unregistered this early in a boot race or absent entirely in a Node/
  // test context, and `Tile#volume`'s own multiplication has no such guard
  // because real Foundry never calls it before settings are registered.
  let globalVolume = 1;
  try {
    const fromSettings = globalThis.game?.settings?.get?.('core', 'globalAmbientVolume');
    if (typeof fromSettings === 'number' && Number.isFinite(fromSettings)) globalVolume = fromSettings;
  } catch (_) {
    // Not registered / not a real Foundry session — 1 (i.e. "don't
    // attenuate") matches this setting's own registered default.
  }
  const ownVolume = typeof cfg.volume === 'number' ? cfg.volume : 0;
  gv.play(video, {
    playing: cfg.autoplay ?? true,
    loop: cfg.loop ?? true,
    volume: ownVolume * globalVolume,
  });
  return true;
}
