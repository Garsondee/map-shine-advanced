/**
 * Node verification for effects/wind-trails.js — the declaration, and the two
 * builders that turn its params into the ribbon engine's construction shape and
 * its live `setLook` payload. The look itself is browser-verified.
 */
import {
  WIND_TRAILS,
  WIND_TRAILS_PARAMS,
  buildWindTrailsSystem,
  windTrailsLook,
  windTrailsMeshSegments,
} from '../wind-trails.js';
import { validateEffectManifest } from '../effect-manifest.js';
import { validateParamsSchema } from '../../core/params-schema.js';
import { validateParticleSystem } from '../particles/particle-system-schema.js';

export function run(t) {
  const { ok } = t;

  {
    const r = validateEffectManifest(WIND_TRAILS);
    ok(`manifest validates (${r.errors.join('; ')})`, r.ok === true);
  }
  ok('params schema validates', validateParamsSchema(WIND_TRAILS_PARAMS).ok === true);
  ok(
    'on by default at every profile (there is nothing to show without wind)',
    WIND_TRAILS.enabledFromProfile === 'low'
  );

  const sys = buildWindTrailsSystem({});
  {
    const r = validateParticleSystem(sys);
    ok(`the built particle system validates (${r.ok ? '' : r.errors.join('; ')})`, r.ok === true);
  }
  // The author's brief, as checkable claims.
  // The author set her own default life (2.5 s, 2026-10-27) — the slider's own ceiling.
  ok('default life is within the slider range', sys.params.lifeMs <= WIND_TRAILS_PARAMS.lifeSec.max * 1000);
  ok('⭐ "tapered fat lines" — the spindle profile', sys.params.profile === 'spindle');
  ok('⭐ "which swirl" — a positive curl by default', sys.params.swirl > 0);
  ok(
    '⭐ "white" — white by default, composited normally so it reads on a bright map',
    sys.params.colorRGB.every((c) => c === 1) && sys.params.blending === 'normal'
  );
  ok('a calm shows nothing (no minimum population)', sys.params.minTrails === 0);
  ok('maxTrails fits the arena', sys.params.maxTrails <= sys.params.capacity);
  ok('the m/s gate is a real band', sys.params.gateHiMps > sys.params.gateLoMps && sys.params.gateLoMps >= 0);
  ok(
    'length is seconds of path on a fixed clock',
    Math.abs(sys.params.segmentSec * sys.params.segments - WIND_TRAILS_PARAMS.lengthSec.default) < 1e-9
  );
  ok('fade windows never overlap', sys.params.fadeMs * 2 <= sys.params.lifeMs);

  // Smoothness scales with the graphics profile: more points, never fewer.
  {
    const order = ['low', 'performance', 'standard', 'quality', 'extreme'];
    const counts = order.map((p) => windTrailsMeshSegments(p));
    ok(
      'line points never decrease as the profile rises',
      counts.every((n, i) => i === 0 || n > counts[i - 1])
    );
    ok('extreme draws far more points than standard', counts[4] >= counts[2] * 4);
    ok('an unknown profile reads as standard', windTrailsMeshSegments('bogus') === windTrailsMeshSegments('standard'));
    ok('standard is unchanged from the old fixed 64', windTrailsMeshSegments('standard') === 64);
    const ext = buildWindTrailsSystem({}, 'extreme');
    ok('the profile reaches the engine', ext.params.meshSegments === windTrailsMeshSegments('extreme'));
    ok('the history ring is independent of the profile', ext.params.segments === sys.params.segments);
    ok(`extreme system validates`, validateParticleSystem(ext).ok === true);
  }

  // Params flow through both builders.
  const custom = { lifeSec: 1, swirl: 1.2, minSpeedMps: 12, color: '#ff8000', widthPx: 30 };
  const sys2 = buildWindTrailsSystem(custom);
  ok('lifetime reaches the engine', sys2.params.lifeMs === 1000);
  ok('swirl reaches the engine', sys2.params.swirl === 1.2);
  ok('the m/s threshold reaches the gate', sys2.params.gateLoMps === 12);
  ok('colour is parsed from #rrggbb', Math.abs(sys2.params.colorRGB[1] - 128 / 255) < 1e-9);
  const look = windTrailsLook(custom);
  ok(
    'setLook carries every live control',
    [
      'density',
      'widthPx',
      'opacity',
      'swirl',
      'swirlVariation',
      'sizeVariation',
      'lifeSec',
      'lengthSec',
      'minSpeedMps',
      'colorRGB',
    ].every((k) => k in look)
  );
  ok(
    '⭐ the 2026-10-31 sliders reach the engine',
    sys.params.swirlVariation === WIND_TRAILS_PARAMS.swirlVariation.default &&
      sys.params.sizeVariation === WIND_TRAILS_PARAMS.sizeVariation.default
  );
  // The author's 2026-10-31 defaults, pasted from her card.
  {
    const want = { density: 0.35, widthPx: 8, lengthSec: 0.2, swirl: 1.2, opacity: 0.5, lifeSec: 1.55, minSpeedMps: 5, color: '#ffffff' };
    const bad = Object.entries(want).filter(([k, x]) => WIND_TRAILS_PARAMS[k].default !== x);
    ok(`the author's 2026-10-31 defaults (${bad.map(([k]) => k).join(', ') || 'all match'})`, bad.length === 0);
  }
  ok('setLook falls back to defaults', windTrailsLook({}).density === WIND_TRAILS_PARAMS.density.default);
  ok(
    'a malformed colour falls back to white, never NaN',
    windTrailsLook({ color: 'blue' }).colorRGB.every((c) => c === 1)
  );
}
