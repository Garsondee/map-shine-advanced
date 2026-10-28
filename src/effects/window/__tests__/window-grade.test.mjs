/**
 * Node verification for effects/window/window-grade.js — the Window card's CC
 * dials mapped onto the ONE grade primitive (grade/one-stack).
 */
import { windowColorParams, WINDOW_COLOR_DEFAULTS } from '../window-grade.js';
import { applyGrade, IDENTITY_GRADE } from '../../grade/grade-ops.js';
import { WINDOW_PARAMS } from '../window.js';

const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

export function run(t) {
  const { ok } = t;
  const id = windowColorParams({});
  const c = [0.6, 0.3, 0.1];
  const out = applyGrade(c, { ...IDENTITY_GRADE, ...id });
  ok(
    '⭐ the CC at its defaults is the identity grade',
    out.every((v, i) => near(v, c[i]))
  );
  ok('the colour filter is the grade gain', windowColorParams({ filter: [1, 0.5, 0.25] }).gain[1] === 0.5);
  ok(
    'gamma is per-channel and floored',
    windowColorParams({ gamma: 0 }).gamma.every((g) => g === 0.05)
  );
  ok('malformed dials fall back to identity', windowColorParams({ exposure: NaN, filter: 'red' }).exposure === 0);
  ok(
    'every cc* param defaults to the identity',
    WINDOW_PARAMS.ccExposure.default === WINDOW_COLOR_DEFAULTS.exposure &&
      WINDOW_PARAMS.ccContrast.default === WINDOW_COLOR_DEFAULTS.contrast &&
      WINDOW_PARAMS.ccSaturation.default === WINDOW_COLOR_DEFAULTS.saturation &&
      WINDOW_PARAMS.ccGamma.default === WINDOW_COLOR_DEFAULTS.gamma &&
      WINDOW_PARAMS.ccColorFilter.default === '#ffffff'
  );
  ok('the CC is the LAST section on the card', Object.values(WINDOW_PARAMS).at(-1).category === 'Colour');
  ok(
    'the rain-wave controls have their own section',
    Object.values(WINDOW_PARAMS).filter((p) => p.category === 'Rain waves').length >= 8
  );
}
