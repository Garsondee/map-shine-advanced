/**
 * Node tests for vt/motion-tile-shadow.js — the settings schema and the pure maths (heights from elevation and
 * sort, the window's throw, offset and blur). The TSL materials have no Node surface (token-grounding's
 * convention); they were checked on the private rig against the Wizard's Lair orrery.
 */
import { validateParamsSchema } from '../../core/params-schema.js';
import { resolveRoomLook, resolveRoomSunFrame } from '../../effects/index.js';
import {
  MOTION_TILE_SHADOW_PARAMS,
  MOTION_TILE_SHADOW_DEFAULTS,
  setMotionTileShadows,
  getMotionTileShadows,
  resetMotionTileShadows,
  isMotionTileShadowOn,
  resolveCasterHeights,
  resolveWindowThrow,
  resolveCasterShadow,
} from '../motion-tile-shadow.js';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

export function run(t) {
  const { ok } = t;

  {
    const res = validateParamsSchema(MOTION_TILE_SHADOW_PARAMS);
    ok(`MOTION_TILE_SHADOW_PARAMS validates (${res.errors.join(' | ')})`, res.ok);
    for (const [key, decl] of Object.entries(MOTION_TILE_SHADOW_PARAMS)) {
      ok(`schema default for ${key} is the module default`, decl.default === MOTION_TILE_SHADOW_DEFAULTS[key]);
    }
  }

  // SETTINGS: clamped, toggled, reset.
  {
    resetMotionTileShadows();
    setMotionTileShadows({ darkness: 7, skylight: -1, heightScale: 99 });
    const s = getMotionTileShadows();
    ok('darkness clamps to 1', s.darkness === 1);
    ok('skylight clamps to 0', s.skylight === 0);
    ok('heightScale clamps to 4', s.heightScale === 4);
    setMotionTileShadows({ darkness: 0, skylight: 0 });
    ok('both strengths 0 = nothing to draw', isMotionTileShadowOn() === false);
    setMotionTileShadows({ darkness: 0.5, enabled: false });
    ok('disabled = nothing to draw', isMotionTileShadowOn() === false);
    resetMotionTileShadows();
    ok(
      'reset restores the defaults and switches it on',
      isMotionTileShadowOn() && getMotionTileShadows().darkness === MOTION_TILE_SHADOW_DEFAULTS.darkness
    );
  }

  // HEIGHTS: sort RANK, not the raw sort number; elevation lifts; an override wins.
  {
    const settings = { baseHeightPx: 30, layerStepPx: 10, heightScale: 1 };
    // The Wizard's Lair shape: one elevation, sorts 1, 15, 999 — three even steps, not a 998-step cliff.
    const h = resolveCasterHeights(
      [
        { id: 'arm', elevation: 0, sort: 1 },
        { id: 'arm2', elevation: 0, sort: 1 },
        { id: 'moon', elevation: 0, sort: 15 },
        { id: 'sun', elevation: 0, sort: 999 },
      ],
      { pxPerElevationUnit: 30 },
      settings
    );
    ok('lowest sort sits at the base height', h.get('arm') === 30);
    ok('equal sorts share a height', h.get('arm2') === 30);
    ok('next sort is one step up', h.get('moon') === 40);
    ok('a huge sort number is still just the next step', h.get('sun') === 50);

    const e = resolveCasterHeights(
      [
        { id: 'floor', elevation: 0, sort: 5 },
        { id: 'hanging', elevation: 2, sort: 5 },
      ],
      { pxPerElevationUnit: 30 },
      settings
    );
    ok('elevation lifts a caster by elevation x px per unit', e.get('hanging') === 30 + 2 * 30);
    ok('rank is counted per elevation', e.get('floor') === 30);

    const o = resolveCasterHeights(
      [{ id: 'x', elevation: 0, sort: 0, heightPx: 200 }],
      {},
      { ...settings, heightScale: 2 }
    );
    ok('a per-tile height overrides, and the height scale still applies', o.get('x') === 400);
    const z = resolveCasterHeights([{ id: 'x', elevation: 0, sort: 0, heightPx: 0 }], {}, settings);
    ok('a per-tile height of 0 means automatic', z.get('x') === 30);
  }

  // THE THROW IS THE WINDOW'S OWN: same direction, scaled by height over the window's throw height.
  {
    const sun = { elevationDeg: 35, azimuthDeg: 250, dayFactor01: 1 };
    const params = { sunThrowHeightPx: 120, sunMaxDriftPx: 400, sunDrift: 1 };
    const frame = resolveRoomSunFrame(sun, resolveRoomLook(params));
    const thr = resolveWindowThrow(sun, params);
    ok('throw equals the window beam frame', near(thr.throwX, frame.throwX) && near(thr.throwY, frame.throwY));
    const s = resolveCasterShadow(120, thr, MOTION_TILE_SHADOW_DEFAULTS);
    ok(
      'a caster at the window throw height lands exactly where the beam drifts',
      near(s.offsetX, frame.throwX) && near(s.offsetY, frame.throwY)
    );
    const half = resolveCasterShadow(60, thr, MOTION_TILE_SHADOW_DEFAULTS);
    ok(
      'half the height, half the throw, same direction',
      near(half.offsetX * 2, s.offsetX) && near(half.offsetY * 2, s.offsetY)
    );

    const later = resolveWindowThrow({ ...sun, azimuthDeg: 270 }, params);
    const beamTurn = Math.atan2(later.throwY, later.throwX) - Math.atan2(thr.throwY, thr.throwX);
    const s2 = resolveCasterShadow(80, later, MOTION_TILE_SHADOW_DEFAULTS);
    const s1 = resolveCasterShadow(80, thr, MOTION_TILE_SHADOW_DEFAULTS);
    const shadowTurn = Math.atan2(s2.offsetY, s2.offsetX) - Math.atan2(s1.offsetY, s1.offsetX);
    ok('as the sun moves the shadow turns exactly as far as the beam (same rate)', near(beamTurn, shadowTurn, 1e-9));

    const still = resolveWindowThrow(sun, { ...params, sunDrift: 0 });
    const s0 = resolveCasterShadow(150, still, MOTION_TILE_SHADOW_DEFAULTS);
    ok('a window set not to drift leaves the shadow straight under its caster', s0.offsetX === 0 && s0.offsetY === 0);

    const night = resolveWindowThrow({ ...sun, dayFactor01: 0 }, params);
    const sn = resolveCasterShadow(150, night, MOTION_TILE_SHADOW_DEFAULTS);
    ok('at night nothing is thrown (the beam does not move either)', near(sn.offsetX, 0) && near(sn.offsetY, 0));
  }

  // SOFTNESS grows with height.
  {
    const thr = { throwX: 0, throwY: 0, throwHeightPx: 120 };
    const low = resolveCasterShadow(30, thr, MOTION_TILE_SHADOW_DEFAULTS);
    const high = resolveCasterShadow(200, thr, MOTION_TILE_SHADOW_DEFAULTS);
    ok('a higher caster gets a softer shadow', high.blurPx > low.blurPx);
    ok(
      'blur = base + height x per-px',
      near(high.blurPx, MOTION_TILE_SHADOW_DEFAULTS.blurBasePx + 200 * MOTION_TILE_SHADOW_DEFAULTS.blurPerPx)
    );
  }
}
