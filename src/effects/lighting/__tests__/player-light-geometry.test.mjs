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
  hasCarriedLightAim,
  resolveBeamDirection,
  resolveLightPosition,
  resolveFlashlightRimPx,
  resolveBeamReach01,
  resolveTorchBurn01,
  resolveTorchEmberMix01,
  mixTowardEmberHex,
  PLAYER_TORCH_OUT_BELOW_BURN01,
  PLAYER_LIGHT_HELD_MODES,
  PLAYER_LIGHT_AIMED_MODES,
  tokenRotationToForwardVector,
} from '../player-light-geometry.js';
// The pool's own luminosity/exposure remap, so "a quarter as bright" can be
// asserted as the real number the shader multiplies by, not a bare constant.
import { computeExposure } from '../point-light-illumination.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
/** Two lights carrying the same colour: a 3-vector, element for element. */
const sameRgb = (a, b) => a.length === b.length && a.every((v, i) => near(v, b[i]));

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
    const snap = { tokenId: 'tok1', x: 100, y: 200, elevation: 0, mode: 'torch', aimAngleDeg: 90 };
    const src = buildOnePlayerLightSource(snap, ALLOW_ALL);
    ok('torch, allowed: produces a descriptor', !!src);
    ok('torch: sourceId is stable and keyed on the token', src.sourceId === 'playerLight:tok1');
    ok('torch: carries the token position', src.x === 100 && src.y === 200);
    ok('torch: throws a useful multi-grid point light', src.radius >= 680);
    ok('torch: has a flat shapePoints polygon', Array.isArray(src.shapePoints) && src.shapePoints.length > 0);
    ok('torch: is animated (candleFlicker)', src.animation?.type === 'candleFlicker');
    ok(
      'torch: has no wind fields (Stage 1 simplification)',
      src.windExposure === undefined && src.windResponse === undefined
    );
  }
  {
    const snap = { tokenId: 'tok2', x: 0, y: 0, elevation: 10, mode: 'flashlight', aimAngleDeg: 90 };
    const src = buildOnePlayerLightSource(snap, ALLOW_ALL);
    ok('flashlight, allowed: produces a descriptor', !!src);
    ok('flashlight: carries elevation through', src.elevation === 10);
    ok('flashlight: has NO animation (a plain, steady pool)', src.animation?.type === null);
    ok('flashlight: reaches further than the torch', src.radius > 690);
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
    ok(
      'flashlight: uses a narrower, more realistic far-end cone',
      src.beamShape.farHalfWidth01 <= 0.2 && src.beamShape.nearHalfWidth01 < src.beamShape.farHalfWidth01
    );
  }
  {
    // torch stays a plain omni pool — no beam fields at all.
    const snap = { tokenId: 'tok2b', x: 0, y: 0, elevation: 0, mode: 'torch', aimAngleDeg: 90 };
    const src = buildOnePlayerLightSource(snap, ALLOW_ALL);
    ok("torch: falloffModel stays 'inverseSquare' (not a beam)", src.falloffModel === 'inverseSquare');
    ok('torch: beamDirection is null', src.beamDirection === null);
    ok('torch: beamShape is null', src.beamShape === null);
  }
  // ======================================================================
  // NO AIM IS NO LIGHT (2026-10-15) — the author's own rule: "as soon as I
  // deselect the token the flashlight points north… as a GM the flashlight
  // should turn off and for the players it should always follow their cursor IF
  // that token is owned by them with full control."
  // ======================================================================
  {
    ok(
      'flashlight: no aim at all → no source, whatever the token faces',
      buildOnePlayerLightSource({ tokenId: 'r1', x: 0, y: 0, mode: 'flashlight' }, ALLOW_ALL) === null
    );
    ok(
      'flashlight: a stored rotation is NOT an aim — the north-pointing fallback is gone',
      buildOnePlayerLightSource(
        { tokenId: 'r2', x: 0, y: 0, mode: 'flashlight', rotation: 90, lockRotation: false },
        ALLOW_ALL
      ) === null
    );
    ok(
      'torch: no aim either — one nobody is holding out is no light',
      buildOnePlayerLightSource({ tokenId: 'r3', x: 0, y: 0, mode: 'torch' }, ALLOW_ALL) === null
    );
    ok(
      'every unusable aim counts as no aim',
      [undefined, null, NaN, '90', Infinity].every(
        (aimAngleDeg) =>
          buildOnePlayerLightSource({ tokenId: 'r4', x: 0, y: 0, mode: 'flashlight', aimAngleDeg }, ALLOW_ALL) === null
      )
    );
    ok(
      'hasCarriedLightAim is the one rule, and a 0° aim is a REAL aim',
      hasCarriedLightAim({ aimAngleDeg: 0 }) === true &&
        hasCarriedLightAim({ aimAngleDeg: NaN }) === false &&
        hasCarriedLightAim({}) === false &&
        hasCarriedLightAim(undefined) === false
    );
    ok(
      'resolveBeamDirection is null with no aim, never a silent north',
      resolveBeamDirection() === null && resolveBeamDirection({ aimAngleDeg: null }) === null
    );
    ok(
      'resolveBeamDirection turns a real aim into a unit vector',
      (() => {
        const d = resolveBeamDirection({ aimAngleDeg: 90 });
        return near(d.x, 1, 1e-6) && near(d.y, 0, 1e-6);
      })()
    );
  }

  // ======================================================================
  // a live aim (the bearer's cursor, local or relayed) IS the beam's direction
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
      'the aim IS the beam direction — a token’s stored facing is never consulted',
      (() => {
        const d = resolveBeamDirection({ aimAngleDeg: 90, rotation: 200, lockRotation: true });
        return near(d.x, 1, 1e-6) && near(d.y, 0, 1e-6);
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
    const snap = { tokenId: 'tok4', x: 5, y: 5, elevation: 0, mode: 'torch', aimAngleDeg: 90 };
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

    const full = buildOnePlayerLightSource({ tokenId: 'g', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90 }, ALLOW_ALL);
    const same = buildOnePlayerLightSource(
      { tokenId: 'g', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90, burn01: 1 },
      ALLOW_ALL
    );
    ok(
      'burn: a full-burn torch is exactly the torch it always was',
      same.radius === full.radius && same.alpha01 === full.alpha01
    );
    const half = buildOnePlayerLightSource(
      { tokenId: 'g', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90, burn01: 0.5 },
      ALLOW_ALL
    );
    ok('burn: a guttering torch is dimmer', near(half.alpha01, full.alpha01 * 0.5));
    ok('burn: …and lights less ground, but not none', half.radius < full.radius && half.radius > full.radius * 0.1);
    ok('burn: …its fallback polygon shrinks with it', Math.abs(half.shapePoints[0] - 0) < full.shapePoints[0] - 0);
    ok(
      'burn: a torch about to go out is faint on every axis (nothing pops when it goes)',
      (() => {
        const dying = buildOnePlayerLightSource(
          { tokenId: 'g', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90, burn01: PLAYER_TORCH_OUT_BELOW_BURN01 + 0.001 },
          ALLOW_ALL
        );
        return dying.alpha01 < full.alpha01 * 0.04 && dying.radius < full.radius * 0.2;
      })()
    );
    ok(
      'burn: out is no light at all',
      buildOnePlayerLightSource({ tokenId: 'g', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90, burn01: 0 }, ALLOW_ALL) ===
        null &&
        buildOnePlayerLightSource(
          { tokenId: 'g', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90, burn01: PLAYER_TORCH_OUT_BELOW_BURN01 - 0.001 },
          ALLOW_ALL
        ) === null
    );
    const beam = buildOnePlayerLightSource(
      { tokenId: 'g', x: 0, y: 0, mode: 'flashlight', aimAngleDeg: 90, burn01: 0 },
      ALLOW_ALL
    );
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

    const full = buildOnePlayerLightSource({ tokenId: 'e', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90 }, ALLOW_ALL);
    const same = buildOnePlayerLightSource(
      { tokenId: 'e', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90, burn01: 0.9 },
      ALLOW_ALL
    );
    ok(
      'ember: a torch that is only a little dim keeps its exact colour',
      same.color.every((c, i) => c === full.color[i])
    );
    const dying = buildOnePlayerLightSource(
      { tokenId: 'e', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90, burn01: 0.1 },
      ALLOW_ALL
    );
    ok(
      'ember: a dying torch’s light is redder — less green and blue, red kept',
      dying.color[1] < full.color[1] && dying.color[2] < full.color[2] && dying.color[0] > 0.7
    );
    const flash = buildOnePlayerLightSource(
      { tokenId: 'e', x: 0, y: 0, mode: 'flashlight', aimAngleDeg: 90, burn01: 0.1 },
      ALLOW_ALL
    );
    const flashNormal = buildOnePlayerLightSource(
      { tokenId: 'e', x: 0, y: 0, mode: 'flashlight', aimAngleDeg: 90 },
      ALLOW_ALL
    );
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
    ok(
      'reach: the SHIPPED floor is only a numerical one — a cursor on the bearer draws a 0.02 beam, not a 0.2 one',
      buildOnePlayerLightSource(
        { tokenId: 'b0', x: 0, y: 0, mode: 'flashlight', aimAngleDeg: 90, reachPx: 0 },
        ALLOW_ALL
      ).beamReach01 <= 0.03
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
      // Half of the flashlight preset's own throw (820), not a magic number.
      { tokenId: 'b2', x: 0, y: 0, mode: 'flashlight', aimAngleDeg: 90, reachPx: 410 },
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
      buildOnePlayerLightSource({ tokenId: 't', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90, reachPx: 50 }, ALLOW_ALL)
        .beamReach01 === null
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
      { tokenId: 'h1', x: 100, y: 100, mode: 'torch', aimAngleDeg: 90, offsetX: 300, offsetY: 0 },
      ALLOW_ALL
    );
    ok('a torch held 300 px east is a light at x=400', held.x === 400 && held.y === 100);
    ok(
      'the wall-clip fallback polygon is centred on the HELD position, not the token',
      near((held.shapePoints[0] + held.shapePoints[32]) / 2, 400, 1e-6)
    );
    const still = buildOnePlayerLightSource(
      { tokenId: 'h1', x: 100, y: 100, mode: 'torch', aimAngleDeg: 90 },
      ALLOW_ALL
    );
    const moving = buildOnePlayerLightSource(
      { tokenId: 'h1', x: 100, y: 100, mode: 'torch', aimAngleDeg: 90, offsetX: 217, offsetY: -63 },
      ALLOW_ALL
    );
    ok(
      'a torch swinging under the cursor keeps its flicker seed (it is the TOKEN’s, not the light’s)',
      still.animation.seed === moving.animation.seed
    );
    const flash = buildOnePlayerLightSource(
      { tokenId: 'h2', x: 100, y: 100, mode: 'flashlight', aimAngleDeg: 90, offsetX: 50, offsetY: 50 },
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
      { tokenId: 'a', x: 0, y: 0, elevation: 0, mode: 'torch', aimAngleDeg: 0 },
      { tokenId: 'b', x: 10, y: 10, elevation: 0, mode: 'flashlight', aimAngleDeg: 0 },
      { tokenId: 'c', x: 20, y: 20, elevation: 0, mode: 'nightVision' }, // filtered out
      { tokenId: 'd', x: 30, y: 30, elevation: 0, mode: null }, // filtered out
      { tokenId: 'e', x: 40, y: 40, elevation: 0, mode: 'flashlight' }, // chosen, but nobody is steering it → filtered out
    ];
    const out = buildPlayerLightSources(snaps, ALLOW_ALL);
    ok("torch plus a flashlight beam, its cookie spot and that spot's bounce produce four sources", out.length === 4);
    ok(
      'and a flashlight nobody is steering produces NONE of its three',
      !out.some((s) => String(s.sourceId).includes(':e'))
    );
    ok(
      'order is preserved (torch, flashlight beam, flashlight cookie spot, bounced fill)',
      out[0].sourceId === 'playerLight:a' &&
        out[1].sourceId === 'playerLight:b' &&
        out[2].sourceId === 'playerLightEndpoint:b' &&
        out[3].sourceId === 'playerLightBounce:b'
    );
    ok('the flashlight endpoint requests the bundled cookie projection', out[2].cookiePattern === 'flashlight');
    ok(
      'the flashlight endpoint descriptor carries its oval footprint',
      out[2].ellipseAlongPx >= out[2].radius && Number.isFinite(out[2].ellipseAngleRad)
    );
    // ======================================================================
    // THE BOUNCED FILL (2026-10-15, the author's own ask) — a THIRD light at
    // the cookie, much larger but far dimmer and steeper, standing in for the
    // light that spot throws back into the room.
    // ======================================================================
    {
      const beam = out[1];
      const spot = out[2];
      const bounce = out[3];
      ok(
        'the bounce sits exactly on the cookie spot it comes off (same point, same floor)',
        near(bounce.x, spot.x) && near(bounce.y, spot.y) && bounce.elevation === spot.elevation
      );
      ok(
        "the bounce is MUCH wider than the cookie it comes from — on BOTH the spot's thin axis and its long one",
        bounce.radius > spot.ellipseAlongPx * 2 && bounce.radius > spot.radius * 3
      );
      ok(
        'the bounce is a plain circle: no oval footprint and no cookie — it is the fill, not a gobo',
        bounce.ellipseAlongPx === undefined &&
          bounce.ellipseAngleRad === undefined &&
          bounce.cookiePattern === undefined
      );
      ok(
        'the bounce uses the ONE falloff model whose attenuation slider does anything, at a high setting — the pool keeps its radius but falls away from the cookie instead of painting a flat disc',
        bounce.falloffModel === 'foundry' && bounce.attenuation01 >= 0.8
      );
      ok(
        'the bounce puts out about a QUARTER of a default-luminosity light (exposure is luminosity*2-1, so 0.1 reads as 0.2×)',
        near(1 + computeExposure(bounce.luminosity01), 0.2, 0.06)
      );
      ok(
        'the bounce is genuinely DIMMER than the spot it comes from — lower luminosity AND less coloured glow',
        bounce.luminosity01 < spot.luminosity01 && bounce.alpha01 < spot.alpha01 && bounce.alpha01 > 0
      );
      ok(
        "the bounce keeps most of its pool in the scene's own DIM ambient band (a low ratio), not its bright one",
        bounce.ratio < spot.ratio
      );
      ok(
        "the beam, the cookie spot and the bounced fill are all ONE colour — the flashlight's own preset hex",
        sameRgb(beam.color, spot.color) && sameRgb(spot.color, bounce.color)
      );
      ok(
        'and that colour is WARM (red over blue) but only very slightly — an old incandescent torch, not an amber flame',
        bounce.color[0] > bounce.color[2] && bounce.color[0] - bounce.color[2] < 0.25
      );
      ok(
        'the bounce is a real light the pool can draw (shape polygon + colour + elevation)',
        bounce.shapePoints.length === 64 && Number.isFinite(bounce.radius) && bounce.hasColor === true
      );
    }
  }
  ok('a non-array input is total, not a throw', buildPlayerLightSources(null, ALLOW_ALL).length === 0);
  ok(
    'an empty permissions object allows nothing (fail-closed, never fail-open)',
    buildPlayerLightSources([{ tokenId: 'x', x: 0, y: 0, mode: 'torch', aimAngleDeg: 90 }], {}).length === 0
  );

  // Two tokens at the SAME position get different seeds only if their ids
  // differ in a way the seed function can see — the seed is POSITION-derived
  // (matching candle/fire's own precedent), so this asserts the derivation is
  // deterministic (same input, same output) rather than random.
  {
    const snap = { tokenId: 'same', x: 42, y: 42, elevation: 0, mode: 'torch', aimAngleDeg: 90 };
    const a = buildOnePlayerLightSource(snap, ALLOW_ALL);
    const b = buildOnePlayerLightSource(snap, ALLOW_ALL);
    ok('the seed is deterministic for the same position', a.animation.seed === b.animation.seed);
  }
  // A flashlight starts on the rim of the circle its token occupies, along its beam.
  {
    const flash = (extra) =>
      buildOnePlayerLightSource(
        { tokenId: 'f', x: 1000, y: 1000, elevation: 0, mode: 'flashlight', ...extra },
        ALLOW_ALL
      );
    const east = flash({ aimAngleDeg: 90, radiusPx: 50 });
    ok('rim: aimed east the light is 50 px east of the token centre', near(east.x, 1050) && near(east.y, 1000));
    const north = flash({ aimAngleDeg: 0, radiusPx: 50 });
    ok('rim: aimed north it is 50 px north', near(north.x, 1000) && near(north.y, 950));
    ok(
      'rim: the shape polygon is built around the rim point, not the token centre',
      near(east.shapePoints[0], 1050 + east.radius) && near(east.shapePoints[1], 1000)
    );
    ok(
      'rim: a wall-safe rimPx wins over the plain radius',
      near(flash({ aimAngleDeg: 90, radiusPx: 50, rimPx: 20 }).x, 1020)
    );
    ok(
      'rim: a negative rimPx is floored at the centre',
      near(flash({ aimAngleDeg: 90, radiusPx: 50, rimPx: -9 }).x, 1000)
    );
    const noRadius = flash({ aimAngleDeg: 90 });
    ok(
      'rim: a token with no known size keeps the light at its centre (as before)',
      near(noRadius.x, 1000) && near(noRadius.y, 1000)
    );
    ok(
      'rim: with no aim there is no source at all — so no rim to work out either',
      flash({ rotation: 180, radiusPx: 50 }) === null
    );

    // The cursor is 400 px east of the centre; the beam starts 50 px out, so it needs only 350 px.
    const aimed = flash({ aimAngleDeg: 90, radiusPx: 50, reachPx: 400 });
    ok(
      'rim: the beam is measured from the rim, so it ends at the cursor',
      near(aimed.x + aimed.beamReach01 * 820, 1400)
    );
    ok(
      'cookie endpoint lands at the cursor',
      near(aimed.flashlightEndpoint.x, 1400) && near(aimed.flashlightEndpoint.y, 1000)
    );
    ok(
      'cookie is as wide as the beam arc there and squashed into an oval along the beam',
      // cone half-width at t = 350/820 is 0.02 + 0.15·(350/820) ≈ 0.084 → ~69 px
      aimed.flashlightEndpoint.radiusPx > 60 &&
        aimed.flashlightEndpoint.radiusPx < 80 &&
        aimed.flashlightEndpoint.alongPx > aimed.flashlightEndpoint.radiusPx &&
        near(aimed.flashlightEndpoint.angleRad, 0)
    );
    const close = flash({ aimAngleDeg: 90, radiusPx: 50, reachPx: 30 });
    ok(
      'rim: a cursor inside the rim draws the beam at the numerical floor only — the patch of ground comes from the cookie’s own minimum radius, not from drawn length',
      close.beamReach01 <= 0.03 && near(close.flashlightEndpoint.radiusPx, 26)
    );
    ok(
      'cookie gets smaller as the aim point comes closer to the token',
      close.flashlightEndpoint.radiusPx < aimed.flashlightEndpoint.radiusPx &&
        close.flashlightEndpoint.alongPx < aimed.flashlightEndpoint.alongPx
    );
    ok(
      'cookie: it lands exactly where the beam’s own arc stops, at any bearing — the two cannot drift apart',
      (() => {
        const diag = flash({ aimAngleDeg: 225, radiusPx: 50, reachPx: 500 });
        const unit = resolveBeamDirection({ aimAngleDeg: 225 });
        return (
          near(diag.flashlightEndpoint.x, diag.x + unit.x * diag.beamReach01 * 820, 1e-6) &&
          near(diag.flashlightEndpoint.y, diag.y + unit.y * diag.beamReach01 * 820, 1e-6)
        );
      })()
    );
    ok(
      'cookie: and it reports that same reach back for its own shading',
      near(aimed.flashlightEndpoint.reach01, 350 / 820) && near(close.flashlightEndpoint.reach01, 0.02)
    );
    const torch = buildOnePlayerLightSource(
      { tokenId: 't', x: 1000, y: 1000, elevation: 0, mode: 'torch', aimAngleDeg: 90, radiusPx: 50 },
      ALLOW_ALL
    );
    ok(
      'rim: a torch is not placed on the rim (it is held out toward the cursor)',
      near(torch.x, 1000) && near(torch.y, 1000)
    );
    ok(
      'bounce: the fill grows with how far the beam lands, and never leaves the spot it came off',
      aimed.flashlightBounce.radiusPx > close.flashlightBounce.radiusPx &&
        near(aimed.flashlightBounce.x, aimed.flashlightEndpoint.x) &&
        near(aimed.flashlightBounce.y, aimed.flashlightEndpoint.y)
    );
    ok(
      'bounce: a torch gets none — it is already an omni pool, and it has no cookie to bounce off',
      torch.flashlightBounce === null
    );
  }
  ok(
    'resolveFlashlightRimPx: nothing known is the centre',
    resolveFlashlightRimPx({}) === 0 && resolveFlashlightRimPx() === 0
  );

  // ======================================================================
  // the cookie's OWN shading softens and dims the further out it lands
  // (2026-10-15: "make the cookie become more blurred as it goes further away
  // and have it become less bright as it reaches away from the token")
  // ======================================================================
  {
    const spotFor = (reachPx) => {
      const out = buildPlayerLightSources(
        [{ tokenId: 's', x: 0, y: 0, elevation: 0, mode: 'flashlight', aimAngleDeg: 90, reachPx }],
        ALLOW_ALL
      );
      return out.find((s) => s.sourceId === 'playerLightEndpoint:s');
    };
    const nearSpot = spotFor(0);
    const farSpot = spotFor(900);
    ok(
      'cookie shading: it is on the ONE falloff model whose attenuation slider is the blur',
      nearSpot.falloffModel === 'foundry' && farSpot.falloffModel === 'foundry'
    );
    ok(
      'cookie shading: at distance it blurs — a higher attenuation, a longer fade to the rim',
      farSpot.attenuation01 > nearSpot.attenuation01
    );
    ok(
      'cookie shading: …and dims — both its illumination and its coloured glow fall away',
      farSpot.luminosity01 < nearSpot.luminosity01 && farSpot.alpha01 < nearSpot.alpha01
    );
    ok(
      'cookie shading: both ends are still a real light (nothing zeroed, nothing blown past 1)',
      [nearSpot, farSpot].every(
        (s) =>
          s.luminosity01 > 0 &&
          s.luminosity01 <= 1 &&
          s.alpha01 > 0 &&
          s.alpha01 <= 1 &&
          s.attenuation01 > 0 &&
          s.attenuation01 < 1
      )
    );
  }
}
