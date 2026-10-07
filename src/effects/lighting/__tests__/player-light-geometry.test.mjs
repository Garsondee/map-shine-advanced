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
  resolveBeamDirection,
  resolveLightPosition,
  resolveBeamReach01,
  resolveTorchBurn01,
  resolveTorchEmberMix01,
  mixTowardEmberHex,
  PLAYER_TORCH_OUT_BELOW_BURN01,
  PLAYER_LIGHT_HELD_MODES,
  PLAYER_LIGHT_AIMED_MODES,
  tokenRotationToForwardVector,
} from '../player-light-geometry.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

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
  // tokenRotationToForwardVector
  // ======================================================================
  {
    const up = tokenRotationToForwardVector(0);
    ok('0° is "up" — (0,-1), canvas Y grows downward', near(up.x, 0) && near(up.y, -1));
    const east = tokenRotationToForwardVector(90);
    ok('90° is "east" — (1,0), clockwise from up', near(east.x, 1, 1e-9) && near(east.y, 0, 1e-9));
    const south = tokenRotationToForwardVector(180);
    ok('180° is "down" — (0,1)', near(south.x, 0, 1e-9) && near(south.y, 1, 1e-9));
    const west = tokenRotationToForwardVector(270);
    ok('270° is "west" — (-1,0)', near(west.x, -1, 1e-9) && near(west.y, 0, 1e-9));
    const wrapped = tokenRotationToForwardVector(450); // 450 === 90 (mod 360)
    ok('rotation wraps correctly past 360°', near(wrapped.x, east.x, 1e-9) && near(wrapped.y, east.y, 1e-9));
    ok(
      'every direction is genuinely unit-length',
      [0, 37, 90, 123, 200, 359].every((d) => {
        const v = tokenRotationToForwardVector(d);
        return near(Math.hypot(v.x, v.y), 1, 1e-9);
      })
    );
    ok(
      'lockRotation forces "up" regardless of the stored rotation',
      (() => {
        const v = tokenRotationToForwardVector(123, true);
        return near(v.x, 0, 1e-9) && near(v.y, -1, 1e-9);
      })()
    );
    ok(
      'a non-finite rotation reads as 0° ("up"), never NaN',
      (() => {
        const v = tokenRotationToForwardVector(NaN);
        return near(v.x, 0, 1e-9) && near(v.y, -1, 1e-9);
      })()
    );
  }

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
    ok('flashlight: has NO animation (a plain, steady pool)', src.animation?.type === null);
    ok('flashlight: reaches further than torch', src.radius > 220);
    ok(
      "flashlight: falloffModel is 'beam' (Stage 2a — a real SDF cone, not an omni pool)",
      src.falloffModel === 'beam'
    );
    ok('flashlight: carries a beamDirection unit vector', !!src.beamDirection);
    ok(
      'flashlight: the beamDirection is genuinely unit-length',
      near(Math.hypot(src.beamDirection.x, src.beamDirection.y), 1, 1e-6)
    );
    ok(
      'flashlight: carries all seven beamShape fields',
      !!src.beamShape &&
        [
          'nearHalfWidth01',
          'farHalfWidth01',
          'edgeSoftness01',
          'lengthFalloffExponent',
          'coreIntensity',
          'midIntensity',
          'rimIntensity',
        ].every((k) => Number.isFinite(src.beamShape[k]))
    );
  }
  {
    // torch stays a plain omni pool — no beam fields at all.
    const snap = { tokenId: 'tok2b', x: 0, y: 0, elevation: 0, mode: 'torch' };
    const src = buildOnePlayerLightSource(snap, ALLOW_ALL);
    ok("torch: falloffModel stays 'inverseSquare' (not a beam)", src.falloffModel === 'inverseSquare');
    ok('torch: beamDirection is null', src.beamDirection === null);
    ok('torch: beamShape is null', src.beamShape === null);
  }
  {
    // A flashlight's beam direction tracks the bearer's own live rotation.
    const facingEast = buildOnePlayerLightSource(
      { tokenId: 'r1', x: 0, y: 0, mode: 'flashlight', rotation: 90 },
      ALLOW_ALL
    );
    ok(
      'rotation 90° (east, per the standard compass-bearing convention) points the beam +X',
      near(facingEast.beamDirection.x, 1, 1e-6) && near(facingEast.beamDirection.y, 0, 1e-6)
    );
    const facingNorth = buildOnePlayerLightSource(
      { tokenId: 'r2', x: 0, y: 0, mode: 'flashlight', rotation: 0 },
      ALLOW_ALL
    );
    ok(
      'rotation 0° (north/up) points the beam -Y (canvas Y grows downward)',
      near(facingNorth.beamDirection.x, 0, 1e-6) && near(facingNorth.beamDirection.y, -1, 1e-6)
    );
    const locked = buildOnePlayerLightSource(
      { tokenId: 'r3', x: 0, y: 0, mode: 'flashlight', rotation: 180, lockRotation: true },
      ALLOW_ALL
    );
    ok(
      'lockRotation forces the VISUAL facing to 0° regardless of the stored rotation value',
      near(locked.beamDirection.x, 0, 1e-6) && near(locked.beamDirection.y, -1, 1e-6)
    );
  }

  // ======================================================================
  // a live aim (the bearer's cursor, local or relayed) outranks the stored rotation
  // ======================================================================
  {
    const aimedEast = buildOnePlayerLightSource(
      { tokenId: 'a1', x: 0, y: 0, mode: 'flashlight', rotation: 0, aimAngleDeg: 90 },
      ALLOW_ALL
    );
    ok(
      'an aim of 90° points the beam +X even though the token itself faces north',
      near(aimedEast.beamDirection.x, 1, 1e-6) && near(aimedEast.beamDirection.y, 0, 1e-6)
    );
    const aimedLocked = buildOnePlayerLightSource(
      { tokenId: 'a2', x: 0, y: 0, mode: 'flashlight', rotation: 0, lockRotation: true, aimAngleDeg: 180 },
      ALLOW_ALL
    );
    ok(
      'lockRotation pins the token artwork, not the bearer’s aim: an aim of 180° still points the beam south',
      near(aimedLocked.beamDirection.x, 0, 1e-6) && near(aimedLocked.beamDirection.y, 1, 1e-6)
    );
    const aimedDiagonal = buildOnePlayerLightSource(
      { tokenId: 'a3', x: 0, y: 0, mode: 'flashlight', aimAngleDeg: 225 },
      ALLOW_ALL
    );
    ok(
      'an aim of 225° points the beam south-west',
      near(aimedDiagonal.beamDirection.x, -Math.SQRT1_2, 1e-6) &&
        near(aimedDiagonal.beamDirection.y, Math.SQRT1_2, 1e-6)
    );
    const aimedZero = buildOnePlayerLightSource(
      { tokenId: 'a4', x: 0, y: 0, mode: 'flashlight', rotation: 90, aimAngleDeg: 0 },
      ALLOW_ALL
    );
    ok(
      'an aim of exactly 0° (north) is a real aim, not “no aim”',
      near(aimedZero.beamDirection.x, 0, 1e-6) && near(aimedZero.beamDirection.y, -1, 1e-6)
    );
    ok(
      'every unusable aim falls back to the stored rotation',
      [null, undefined, NaN, '90', Infinity].every((aimAngleDeg) => {
        const d = resolveBeamDirection({ aimAngleDeg, rotation: 90 });
        return near(d.x, 1, 1e-6) && near(d.y, 0, 1e-6);
      })
    );
    ok(
      'resolveBeamDirection with nothing at all is total and points north',
      (() => {
        const d = resolveBeamDirection();
        return near(d.x, 0, 1e-6) && near(d.y, -1, 1e-6);
      })()
    );
    const torchAimed = buildOnePlayerLightSource(
      { tokenId: 'a5', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90 },
      ALLOW_ALL
    );
    ok('a torch ignores an aim — it has no beam to point', torchAimed.beamDirection === null);
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
  // a torch that gutters: dimmer and smaller, then out
  // ======================================================================
  {
    ok('burn: no burn known is burning', resolveTorchBurn01({}) === 1 && resolveTorchBurn01(undefined) === 1);
    ok(
      'burn: a real burn is read, clamped to 0..1',
      resolveTorchBurn01({ burn01: 0.4 }) === 0.4 &&
        resolveTorchBurn01({ burn01: 7 }) === 1 &&
        resolveTorchBurn01({ burn01: -2 }) === 0
    );
    ok(
      'burn: junk is burning, never NaN',
      resolveTorchBurn01({ burn01: NaN }) === 1 && resolveTorchBurn01({ burn01: 'low' }) === 1
    );
    ok(
      'only the torch is held (can gutter)',
      PLAYER_LIGHT_HELD_MODES.length === 1 && PLAYER_LIGHT_HELD_MODES[0] === 'torch'
    );

    const full = buildOnePlayerLightSource({ tokenId: 'g', x: 0, y: 0, mode: 'torch' }, ALLOW_ALL);
    const same = buildOnePlayerLightSource({ tokenId: 'g', x: 0, y: 0, mode: 'torch', burn01: 1 }, ALLOW_ALL);
    ok(
      'burn: a full-burn torch is exactly the torch it always was',
      same.radius === full.radius && same.alpha01 === full.alpha01
    );
    const half = buildOnePlayerLightSource({ tokenId: 'g', x: 0, y: 0, mode: 'torch', burn01: 0.5 }, ALLOW_ALL);
    ok('burn: a guttering torch is dimmer', near(half.alpha01, full.alpha01 * 0.5));
    ok('burn: …and lights less ground, but not none', half.radius < full.radius && half.radius > full.radius * 0.1);
    ok('burn: …its fallback polygon shrinks with it', Math.abs(half.shapePoints[0] - 0) < full.shapePoints[0] - 0);
    ok(
      'burn: a torch about to go out is faint on every axis (nothing pops when it goes)',
      (() => {
        const dying = buildOnePlayerLightSource(
          { tokenId: 'g', x: 0, y: 0, mode: 'torch', burn01: PLAYER_TORCH_OUT_BELOW_BURN01 + 0.001 },
          ALLOW_ALL
        );
        return dying.alpha01 < full.alpha01 * 0.04 && dying.radius < full.radius * 0.2;
      })()
    );
    ok(
      'burn: out is no light at all',
      buildOnePlayerLightSource({ tokenId: 'g', x: 0, y: 0, mode: 'torch', burn01: 0 }, ALLOW_ALL) === null &&
        buildOnePlayerLightSource(
          { tokenId: 'g', x: 0, y: 0, mode: 'torch', burn01: PLAYER_TORCH_OUT_BELOW_BURN01 - 0.001 },
          ALLOW_ALL
        ) === null
    );
    const beam = buildOnePlayerLightSource({ tokenId: 'g', x: 0, y: 0, mode: 'flashlight', burn01: 0 }, ALLOW_ALL);
    ok('burn: a flashlight has no burn — it ignores one', beam !== null && beam.alpha01 > 0);
  }

  // ======================================================================
  // a dying torch reddens
  // ======================================================================
  {
    ok(
      'ember: no shift at full burn or while merely dimmed',
      resolveTorchEmberMix01(1) === 0 && resolveTorchEmberMix01(0.7) === 0
    );
    ok('ember: fully red at the point it goes out', near(resolveTorchEmberMix01(PLAYER_TORCH_OUT_BELOW_BURN01), 1));
    ok(
      'ember: shifts steadily between',
      resolveTorchEmberMix01(0.5) > resolveTorchEmberMix01(0.6) &&
        resolveTorchEmberMix01(0.2) > resolveTorchEmberMix01(0.5)
    );
    ok('ember: never out of range', resolveTorchEmberMix01(-3) === 1 && resolveTorchEmberMix01(9) === 0);
    ok('ember: a zero blend is the colour it started as', mixTowardEmberHex('#ff9a42', 0) === '#ff9a42');
    ok('ember: a full blend is the coal red', mixTowardEmberHex('#ff9a42', 1) === '#c7301a');
    const mid = mixTowardEmberHex('#ffaa00', 0.5);
    ok(
      'ember: a half blend is between, redder than amber',
      mid > '#c7301a' && mid < '#ffaa00' && parseInt(mid.slice(3, 5), 16) < 0xaa
    );

    const full = buildOnePlayerLightSource({ tokenId: 'e', x: 0, y: 0, mode: 'torch' }, ALLOW_ALL);
    const same = buildOnePlayerLightSource({ tokenId: 'e', x: 0, y: 0, mode: 'torch', burn01: 0.9 }, ALLOW_ALL);
    ok(
      'ember: a torch that is only a little dim keeps its exact colour',
      same.color.every((c, i) => c === full.color[i])
    );
    const dying = buildOnePlayerLightSource({ tokenId: 'e', x: 0, y: 0, mode: 'torch', burn01: 0.1 }, ALLOW_ALL);
    ok(
      'ember: a dying torch’s light is redder — less green and blue, red kept',
      dying.color[1] < full.color[1] && dying.color[2] < full.color[2] && dying.color[0] > 0.7
    );
    const flash = buildOnePlayerLightSource({ tokenId: 'e', x: 0, y: 0, mode: 'flashlight', burn01: 0.1 }, ALLOW_ALL);
    const flashNormal = buildOnePlayerLightSource({ tokenId: 'e', x: 0, y: 0, mode: 'flashlight' }, ALLOW_ALL);
    ok(
      'ember: a flashlight never reddens',
      flash.color.every((c, i) => c === flashNormal.color[i])
    );
  }

  // ======================================================================
  // how long the beam is drawn: as far as the cursor, between a floor and its full throw
  // ======================================================================
  {
    ok('reach: half the throw away is half the beam', near(resolveBeamReach01(310, 620, 0.2), 0.5));
    ok('reach: past the throw is the full beam', resolveBeamReach01(5000, 620, 0.2) === 1);
    ok('reach: right at the feet is the floor, not nothing', resolveBeamReach01(0, 620, 0.2) === 0.2);
    ok(
      'reach: unknown is the full beam',
      [undefined, null, NaN, 'far'].every((r) => resolveBeamReach01(r, 620, 0.2) === 1) &&
        resolveBeamReach01(100, 0, 0.2) === 1
    );

    const full = buildOnePlayerLightSource(
      { tokenId: 'b1', x: 0, y: 0, mode: 'flashlight', aimAngleDeg: 90 },
      ALLOW_ALL
    );
    ok(
      'beam: with no reach it is the full beam and a unit vector',
      full.beamReach01 === 1 && near(Math.hypot(full.beamDirection.x, full.beamDirection.y), 1)
    );
    const half = buildOnePlayerLightSource(
      { tokenId: 'b2', x: 0, y: 0, mode: 'flashlight', aimAngleDeg: 90, reachPx: 310 },
      ALLOW_ALL
    );
    ok(
      'beam: a half-length beam has a direction twice as long…',
      near(half.beamDirection.x, 2) && near(half.beamDirection.y, 0, 1e-9)
    );
    ok('beam: …still pointing the same way', Math.sign(half.beamDirection.x) === Math.sign(full.beamDirection.x));
    ok('beam: …and reports the fraction it was drawn at', near(half.beamReach01, 0.5));
    ok('beam: its mesh radius (the wall-clip cost) is untouched by the beam length', half.radius === full.radius);
    const diag = buildOnePlayerLightSource(
      { tokenId: 'b3', x: 0, y: 0, mode: 'flashlight', aimAngleDeg: 225, reachPx: 124 },
      ALLOW_ALL
    );
    const diagDeg = ((Math.atan2(diag.beamDirection.x, -diag.beamDirection.y) * 180) / Math.PI + 360) % 360;
    ok(
      'beam: a shortened diagonal beam keeps its bearing (the direction is the aim, the length the reach)',
      near(diagDeg, 225, 1e-6)
    );
    ok(
      'beam: a torch has no beam reach',
      buildOnePlayerLightSource({ tokenId: 't', x: 0, y: 0, mode: 'torch', reachPx: 50 }, ALLOW_ALL).beamReach01 ===
        null
    );
  }

  // ======================================================================
  // a held light sits where its bearer holds it, not on the token
  // ======================================================================
  {
    const p = resolveLightPosition({ x: 100, y: 200, offsetX: 30, offsetY: -40 });
    ok('position: the token centre plus the held displacement', p.x === 130 && p.y === 160);
    const bare = resolveLightPosition({ x: 100, y: 200 });
    ok('position: no displacement is the token centre, exactly as before', bare.x === 100 && bare.y === 200);
    ok(
      'position: an unusable displacement is ignored, not propagated as NaN',
      (() => {
        const q = resolveLightPosition({ x: 5, y: 6, offsetX: NaN, offsetY: 'far' });
        return q.x === 5 && q.y === 6;
      })()
    );
    ok(
      'position: a missing token position stays non-finite, so the builder refuses it',
      Number.isNaN(resolveLightPosition({}).x)
    );

    const held = buildOnePlayerLightSource(
      { tokenId: 'h1', x: 100, y: 100, mode: 'torch', offsetX: 300, offsetY: 0 },
      ALLOW_ALL
    );
    ok('a torch held 300 px east is a light at x=400', held.x === 400 && held.y === 100);
    ok(
      'the wall-clip fallback polygon is centred on the HELD position, not the token',
      near((held.shapePoints[0] + held.shapePoints[32]) / 2, 400, 1e-6)
    );
    const still = buildOnePlayerLightSource({ tokenId: 'h1', x: 100, y: 100, mode: 'torch' }, ALLOW_ALL);
    const moving = buildOnePlayerLightSource(
      { tokenId: 'h1', x: 100, y: 100, mode: 'torch', offsetX: 217, offsetY: -63 },
      ALLOW_ALL
    );
    ok(
      'a torch swinging under the cursor keeps its flicker seed (it is the TOKEN’s, not the light’s)',
      still.animation.seed === moving.animation.seed
    );
    const flash = buildOnePlayerLightSource(
      { tokenId: 'h2', x: 100, y: 100, mode: 'flashlight', offsetX: 50, offsetY: 50 },
      ALLOW_ALL
    );
    ok('an offset on a non-torch light is still just a position (the channel never sets one)', flash.x === 150);
    ok(
      'the aimed modes are the torch and the flashlight',
      PLAYER_LIGHT_AIMED_MODES.length === 2 &&
        PLAYER_LIGHT_AIMED_MODES.includes('torch') &&
        PLAYER_LIGHT_AIMED_MODES.includes('flashlight')
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
