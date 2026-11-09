/**
 * THE GROUND MIST (mmp-63o.1) — the plain-JS halves: the density curve the shader mirrors, the soft wall gate, and
 * the subsystem's promise that fog does not hide behind the clear-day early-out.
 *
 * ⚠️ The picture itself is TSL and is judged in `tools/shader-lab/mist-lab.html` (Docklands, densities, hours).
 */
import {
  mistAlpha,
  mistCoverThreshold,
  mistHazeDepth,
  MIST_MAX_ALPHA,
  MIST_WIND_THIN_FLOOR,
  MIST_CALM_DRIFT_PX_PER_SEC,
  MIST_WIND_DRIFT_PX_PER_SEC,
} from '../ground-mist-field.js';
import { buildMistGateGrid } from '../ground-mist-gate.js';
import { MIST_ILLUM_GAMMA } from '../ground-mist-render.js';
import { createPrecipitationSubsystem } from '../precip-subsystem.js';

export function run(t) {
  const { ok } = t;

  // ── LIT LIKE THE GROUND (mmp-78u.34.8) ──
  // The ground is `painted × illum` in GAMMA space, so its LINEAR light falls as illum^2.2. The mist used illum
  // linearly: equal at noon, 4x too bright at midnight (luma ~45 -> ~180 under the Fog mood on the lab rig).
  {
    const groundLinear = (illum) => Math.pow(0.502 * illum, 2.2) / Math.pow(0.502, 2.2); // relative to illum 1
    const mistLinear = (illum) => Math.pow(illum, MIST_ILLUM_GAMMA);
    for (const illum of [0.264, 0.33, 0.6, 0.933]) {
      ok(
        `the mist's light follows the ground's at illum ${illum}`,
        Math.abs(mistLinear(illum) / groundLinear(illum) - 1) < 0.02
      );
    }
  }

  // ── THE DENSITY CURVE ──
  ok(
    'density 0 draws nothing at any field value',
    [0, 0.5, 1].every((f) => mistAlpha(f, 0) === 0)
  );
  {
    const ds = [0.1, 0.3, 0.5, 0.7, 0.9, 1];
    const at = (f) => ds.map((d) => mistAlpha(f, d));
    const rising = (xs) => xs.every((v, i) => i === 0 || v >= xs[i - 1]);
    ok('more density is never less fog (bank, average and gap)', rising(at(0.8)) && rising(at(0.5)) && rising(at(0.2)));
  }
  ok(
    'never opaque: even the thickest bank at full density stays under the ceiling (tokens stay readable)',
    mistAlpha(1, 1) <= MIST_MAX_ALPHA && MIST_MAX_ALPHA < 0.9
  );
  ok('a bank is thicker than a gap at the same density', mistAlpha(0.8, 0.6) > mistAlpha(0.3, 0.6) * 2);
  ok('light fog is patchy: a gap at 20% is nearly clear', mistAlpha(0.35, 0.2) < 0.03);
  ok('the Fog mood (0.7) is real fog in a bank', mistAlpha(0.7, 0.7) > 0.35);
  ok('the threshold falls as density rises', mistCoverThreshold(0.2) > mistCoverThreshold(0.7));
  ok('no haze floor at 0, some at 1', mistHazeDepth(0) === 0 && mistHazeDepth(1) > 0);
  ok(
    'wind thins the mist but never clears it',
    mistAlpha(0.7, 0.7, 1) < mistAlpha(0.7, 0.7, 0) && mistAlpha(0.7, 0.7, 1) > 0 && MIST_WIND_THIN_FLOOR > 0
  );
  ok('mist drifts even in a calm, faster in wind', MIST_CALM_DRIFT_PX_PER_SEC > 0 && MIST_WIND_DRIFT_PX_PER_SEC > 0);

  // ── THE SOFT WALL GATE ──
  {
    // 200×100 gate over 2000×1000 world px: outdoors (255) on the left half, indoors (0) on the right.
    const w = 200;
    const h = 100;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) rgba[(y * w + x) * 4] = 255;
    const rect = { minX: 0, minY: 0, maxX: 2000, maxY: 1000 };
    const g = buildMistGateGrid(rgba, w, h, rect, 180);
    ok('builds a coarse grid', g && g.w < w && g.h < h && g.data.length === g.w * g.h * 4);
    const at = (worldX) => {
      const gx = Math.min(g.w - 1, Math.floor(((worldX - g.rect.minX) / (g.rect.maxX - g.rect.minX)) * g.w));
      return g.data[(Math.floor(g.h / 2) * g.w + gx) * 4] / 255;
    };
    ok('deep outdoors stays fully open', at(300) > 0.97);
    ok('deep indoors stays fully closed', at(1700) < 0.03);
    ok('it ramps across the wall (about half on the line)', at(1000) > 0.25 && at(1000) < 0.75);
    ok('the ramp is soft: still not full a little way out from the wall', at(950) < 0.97 && at(950) > at(1050));
    ok(
      'the rect it reports covers the source rect',
      g.rect.maxX >= rect.maxX - 1e-6 && g.rect.maxY >= rect.maxY - 1e-6
    );
    ok('unusable input is null, not a throw', buildMistGateGrid(null, 0, 0, rect, 180) === null);
  }

  // ── THE SUBSYSTEM: FOG IS NOT GATED ON PRECIPITATION ──
  {
    let state = { enabled: true, weather: { precip01: 0, fogDensity01: 0.7 }, sceneBounds: null };
    const sub = createPrecipitationSubsystem({ THREE: {}, getPrecipRenderState: () => state });
    let threw = false;
    try {
      sub.sync(null, 1 / 60, 0, null);
      state = { ...state, enabled: false };
      sub.sync(null, 1 / 60, 16, null);
    } catch (e) {
      threw = e;
    }
    ok(`fog at precip 0 with no scene bounds yet waits, never throws (${threw})`, threw === false);
    ok(
      'the status names the mist and why it is not built yet',
      sub.getStatus().groundMist?.built === false && typeof sub.getStatus().groundMist.reason === 'string'
    );
    ok('nothing to draw without a quad', sub.scenes.length === 0);
  }
}
