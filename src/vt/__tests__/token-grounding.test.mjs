/**
 * Node tests for vt/token-grounding.js — the state/schema and the detail cap.
 * `buildTokenArtNode` builds a real TSL graph and has no Node surface (same
 * convention as albedo-clarity.test.mjs); `detailCapScale` is its stage-A term.
 */
import { validateParamsSchema } from '../../core/params-schema.js';
import {
  TOKEN_GROUNDING_PARAMS,
  setTokenGrounding,
  getTokenGrounding,
  resetTokenGrounding,
  setTokenGroundingGroundDensity,
  detailCapScale,
} from '../token-grounding.js';

export function run(t) {
  const { ok } = t;

  {
    const res = validateParamsSchema(TOKEN_GROUNDING_PARAMS);
    ok(`TOKEN_GROUNDING_PARAMS validates (${res.errors.join(' | ')})`, res.ok);
  }

  // ==========================================================================
  // DETAIL CAP: engages only once one capped texel spans more than a screen
  // pixel (>1); at or below 1 the plain one-pixel supersample is used.
  // ==========================================================================
  {
    // Map at 1 texel/world px, detail 1.5 -> cap 1.5 texels/world px.
    ok('at 1:1 zoom the cap is not reached', detailCapScale(1.5, 1) <= 1);
    ok(
      'at 1.5 screen px per world px (1x on a HiDPI screen) it is exactly reached',
      Math.abs(detailCapScale(1.5, 1 / 1.5) - 1) < 1e-9
    );
    ok('zoomed out it does nothing', detailCapScale(1.5, 4) < 1);
    ok('zoomed in 3x the token is held to the cap (2 px per texel)', Math.abs(detailCapScale(1.5, 1 / 3) - 2) < 1e-9);
    ok('a coarser floor caps sooner', detailCapScale(0.5 * 1.5, 1) > detailCapScale(1.5, 1));
  }

  // ==========================================================================
  // STATE.
  // ==========================================================================
  {
    resetTokenGrounding();
    ok(
      'detail is clamped to its schema max',
      setTokenGrounding({ detail: 99 }).detail === TOKEN_GROUNDING_PARAMS.detail.max
    );
    ok(
      'detail is clamped to its schema min',
      setTokenGrounding({ detail: 0 }).detail === TOKEN_GROUNDING_PARAMS.detail.min
    );
    setTokenGroundingGroundDensity(0.5);
    ok('floor density is stored', getTokenGrounding().groundTexelsPerWorldPx === 0.5);
    setTokenGroundingGroundDensity(-1);
    setTokenGroundingGroundDensity(Number.NaN);
    ok('a bad floor density is ignored', getTokenGrounding().groundTexelsPerWorldPx === 0.5);
    setTokenGroundingGroundDensity(1);
    resetTokenGrounding();
    ok('reset restores the default detail', getTokenGrounding().detail === TOKEN_GROUNDING_PARAMS.detail.default);
    ok('reset leaves it enabled', getTokenGrounding().enabled === true);
  }
}
