/**
 * Node tests for vt/render-scale-policy.js — the present/internal resolution
 * combining formula. Pure arithmetic; no THREE, no Foundry, no mocks.
 */
import { resolvePresentPixelRatio, resolveInternalScale } from '../render-scale-policy.js';

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
}
