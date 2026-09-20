/**
 * Node verification for effects/lighting/player-light-geometry.js. All pure —
 * no THREE, no Foundry: every function here is a total function over plain
 * numbers/strings, so the "which token gets a light, and what does it look
 * like" decision carries a real suite instead of a hope.
 */
import {
  buildOnePlayerLightSource,
  buildPlayerLightSources,
  PLAYER_LIGHT_RENDERED_MODES,
} from '../player-light-geometry.js';

const ALLOW_ALL = {
  modes: {
    torch: true,
    flashlight: true,
    nightVision: true,
    lowLight: true,
    infravision: true,
    activeInfravision: true,
  },
};

export function run(t) {
  const { ok } = t;

  ok('exactly torch + flashlight are Stage-1-rendered', new Set(PLAYER_LIGHT_RENDERED_MODES).size === 2);
  ok('torch is one of the rendered modes', PLAYER_LIGHT_RENDERED_MODES.includes('torch'));
  ok('flashlight is one of the rendered modes', PLAYER_LIGHT_RENDERED_MODES.includes('flashlight'));

  // ======================================================================
  // buildOnePlayerLightSource
  // ======================================================================
  {
    const snap = { tokenId: 'tok1', x: 100, y: 200, elevation: 0, mode: 'torch' };
    const src = buildOnePlayerLightSource(snap, ALLOW_ALL);
    ok('torch, allowed: produces a descriptor', !!src);
    ok('torch: sourceId is stable and keyed on the token', src.sourceId === 'playerLight:tok1');
    ok('torch: carries the token position', src.x === 100 && src.y === 200);
    ok('torch: has a positive radius', src.radius > 0);
    ok('torch: has a flat shapePoints polygon', Array.isArray(src.shapePoints) && src.shapePoints.length > 0);
    ok('torch: is animated (candleFlicker)', src.animation?.type === 'candleFlicker');
    ok(
      'torch: has no wind fields (Stage 1 simplification)',
      src.windExposure === undefined && src.windResponse === undefined
    );
  }
  {
    const snap = { tokenId: 'tok2', x: 0, y: 0, elevation: 10, mode: 'flashlight' };
    const src = buildOnePlayerLightSource(snap, ALLOW_ALL);
    ok('flashlight, allowed: produces a descriptor', !!src);
    ok('flashlight: carries elevation through', src.elevation === 10);
    ok('flashlight: has NO animation (a plain, steady pool)', src.animation === null);
    ok('flashlight: reaches further than torch', src.radius > 220);
  }
  {
    // A vision-mode pick — real, selectable, but Stage 1 renders nothing for it.
    const snap = { tokenId: 'tok3', x: 5, y: 5, elevation: 0, mode: 'nightVision' };
    ok(
      'a vision-mode token produces no descriptor (Stage 1 has no render for it)',
      buildOnePlayerLightSource(snap, ALLOW_ALL) === null
    );
  }
  {
    // GM has disallowed this mode on this scene.
    const disallow = { modes: { ...ALLOW_ALL.modes, torch: false } };
    const snap = { tokenId: 'tok4', x: 5, y: 5, elevation: 0, mode: 'torch' };
    ok(
      'a disallowed mode produces no descriptor, even with a real render',
      buildOnePlayerLightSource(snap, disallow) === null
    );
  }
  {
    ok(
      'a null mode produces no descriptor',
      buildOnePlayerLightSource({ tokenId: 't', x: 0, y: 0, mode: null }, ALLOW_ALL) === null
    );
    ok(
      'a non-finite position produces no descriptor',
      buildOnePlayerLightSource({ tokenId: 't', x: NaN, y: 0, mode: 'torch' }, ALLOW_ALL) === null
    );
  }

  // ======================================================================
  // buildPlayerLightSources — the batch wrapper
  // ======================================================================
  {
    const snaps = [
      { tokenId: 'a', x: 0, y: 0, elevation: 0, mode: 'torch' },
      { tokenId: 'b', x: 10, y: 10, elevation: 0, mode: 'flashlight' },
      { tokenId: 'c', x: 20, y: 20, elevation: 0, mode: 'nightVision' }, // filtered out
      { tokenId: 'd', x: 30, y: 30, elevation: 0, mode: null }, // filtered out
    ];
    const out = buildPlayerLightSources(snaps, ALLOW_ALL);
    ok('only the two Stage-1-rendered, allowed tokens produce a light', out.length === 2);
    ok(
      'order is preserved (torch then flashlight)',
      out[0].sourceId === 'playerLight:a' && out[1].sourceId === 'playerLight:b'
    );
  }
  ok('a non-array input is total, not a throw', buildPlayerLightSources(null, ALLOW_ALL).length === 0);
  ok(
    'an empty permissions object allows nothing (fail-closed, never fail-open)',
    buildPlayerLightSources([{ tokenId: 'x', x: 0, y: 0, mode: 'torch' }], {}).length === 0
  );

  // Two tokens at the SAME position get different seeds only if their ids
  // differ in a way the seed function can see — the seed is POSITION-derived
  // (matching candle/fire's own precedent), so this asserts the derivation is
  // deterministic (same input, same output) rather than random.
  {
    const snap = { tokenId: 'same', x: 42, y: 42, elevation: 0, mode: 'torch' };
    const a = buildOnePlayerLightSource(snap, ALLOW_ALL);
    const b = buildOnePlayerLightSource(snap, ALLOW_ALL);
    ok('the seed is deterministic for the same position', a.animation.seed === b.animation.seed);
  }
}
