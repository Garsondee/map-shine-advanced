/**
 * Node tests for vt/render-scale-policy.js — the present/internal resolution
 * combining formula. Pure arithmetic; no THREE, no Foundry, no mocks.
 */
import {
  resolvePresentPixelRatio,
  resolveInternalScale,
  RENDER_SCALE_TIER_TARGET_FPS,
  resolveRenderScaleFrameBudgetMs,
} from '../render-scale-policy.js';

const LADDER = [1.0, 0.85, 0.7, 0.6, 0.5];

export function run(t) {
  const { ok } = t;

  // resolvePresentPixelRatio — the safety-ceiling half.
  {
    ok('mirrors Foundry when under the ceiling', resolvePresentPixelRatio(1.0, 1.5) === 1.0);
    ok('mirrors Foundry exactly at the ceiling', resolvePresentPixelRatio(1.5, 1.5) === 1.5);
    ok('CEILING WINS — never exceeds it regardless of Foundry', resolvePresentPixelRatio(4, 1.5) === 1.5);
    ok(
      'a deliberately LOWER Foundry value is still respected (ceiling, not a floor)',
      resolvePresentPixelRatio(0.75, 1.5) === 0.75
    );
    ok(
      'missing/garbage Foundry value falls back to 1, not the ceiling',
      resolvePresentPixelRatio(undefined, 1.5) === 1
    );
    ok('NaN falls back to 1', resolvePresentPixelRatio(NaN, 1.5) === 1);
    ok('zero falls back to 1', resolvePresentPixelRatio(0, 1.5) === 1);
    ok('negative falls back to 1', resolvePresentPixelRatio(-2, 1.5) === 1);
    ok('a garbage ceiling itself falls back to 1 (never silently uncapped)', resolvePresentPixelRatio(4, NaN) === 1);
  }

  // resolveInternalScale — the governor/fixed-rung half.
  {
    ok('auto follows the governor', resolveInternalScale('auto', 0.7, LADDER) === 0.7);
    ok('auto at scale 1 stays 1', resolveInternalScale('auto', 1, LADDER) === 1);
    ok('auto with a garbage governor scale falls back to 1', resolveInternalScale('auto', NaN, LADDER) === 1);
    ok(
      'auto with a governor scale above 1 falls back to 1 (never magnify)',
      resolveInternalScale('auto', 1.2, LADDER) === 1
    );
    ok('a fixed rung on the real ladder is honored exactly', resolveInternalScale('0.6', 1, LADDER) === 0.6);
    ok('a fixed rung makes the governor fully irrelevant', resolveInternalScale('0.5', 0.85, LADDER) === 0.5);
    ok('a value NOT on the ladder is rejected, not trusted', resolveInternalScale('0.33', 1, LADDER) === 1);
    ok('a non-numeric setting string is rejected', resolveInternalScale('bogus', 1, LADDER) === 1);
    ok('an empty ladder rejects every fixed choice', resolveInternalScale('0.5', 1, []) === 1);
  }

  // resolveInternalScale — fixed SUPERSAMPLE choices (2026-08-30, Stage 4).
  // vt-pan-viewer.js's own call site unions SUPERSAMPLE_CHOICES with
  // SCALE_LADDER for the `allowedScales` argument — this is that widened
  // list, built the same way, not SCALE_LADDER alone.
  {
    const WIDENED = [1.5, 1.25, ...LADDER];
    ok(
      'a fixed 1.5 supersample on the widened list is honored exactly',
      resolveInternalScale('1.5', 1, WIDENED) === 1.5
    );
    ok('a fixed 1.25 supersample is honored exactly', resolveInternalScale('1.25', 0.7, WIDENED) === 1.25);
    ok(
      'a fixed supersample choice makes the governor fully irrelevant, same as any other fixed choice',
      resolveInternalScale('1.5', 0.5, WIDENED) === 1.5
    );
    ok(
      'a supersample value NOT on the widened list is still rejected, not trusted',
      resolveInternalScale('1.75', 1, WIDENED) === 1
    );
    ok(
      'a supersample choice against the UNWIDENED ladder alone is rejected (never silently honored)',
      resolveInternalScale('1.5', 1, LADDER) === 1
    );
  }

  // RENDER_SCALE_TIER_TARGET_FPS / resolveRenderScaleFrameBudgetMs (2026-08-27)
  // — tier-coupled Auto budgets.
  {
    const TIERS = ['low', 'performance', 'standard', 'quality', 'extreme'];
    ok(
      'covers exactly the five real performance-profile tiers, no more, no less',
      Object.keys(RENDER_SCALE_TIER_TARGET_FPS).length === 5 && TIERS.every((t) => t in RENDER_SCALE_TIER_TARGET_FPS)
    );
    ok(
      'every target fps is a positive finite number',
      TIERS.every((t) => Number.isFinite(RENDER_SCALE_TIER_TARGET_FPS[t]) && RENDER_SCALE_TIER_TARGET_FPS[t] > 0)
    );
    ok(
      'MONOTONIC: a higher tier never asks for a HIGHER target fps than a lower one — ' +
        'the whole point is fidelity tiers get MORE budget room, not less',
      TIERS.every((t, i) => i === 0 || RENDER_SCALE_TIER_TARGET_FPS[t] <= RENDER_SCALE_TIER_TARGET_FPS[TIERS[i - 1]])
    );
    ok(
      "extreme's target sits ABOVE its own measured native cost (~32ms/~31fps, " +
        'Performance-Ceiling-Analysis-2026-08-26.md) — Auto must not fight a normal extreme frame',
      resolveRenderScaleFrameBudgetMs('extreme') > 32
    );

    for (const tier of TIERS) {
      ok(
        `resolveRenderScaleFrameBudgetMs('${tier}') matches 1000/fps exactly`,
        Math.abs(resolveRenderScaleFrameBudgetMs(tier) - 1000 / RENDER_SCALE_TIER_TARGET_FPS[tier]) < 1e-9
      );
    }
    ok(
      'an unrecognised profile resolves to standard — same fallback profileRank itself promises',
      resolveRenderScaleFrameBudgetMs('bogus-tier') === resolveRenderScaleFrameBudgetMs('standard')
    );
    ok(
      'a missing profile resolves to standard',
      resolveRenderScaleFrameBudgetMs(undefined) === resolveRenderScaleFrameBudgetMs('standard')
    );
    ok(
      'low asks for the tightest budget (most willing to downscale) of all five tiers',
      TIERS.every((t) => resolveRenderScaleFrameBudgetMs('low') <= resolveRenderScaleFrameBudgetMs(t))
    );
    ok(
      'extreme asks for the most generous budget (least willing to downscale) of all five tiers',
      TIERS.every((t) => resolveRenderScaleFrameBudgetMs('extreme') >= resolveRenderScaleFrameBudgetMs(t))
    );
  }
}
