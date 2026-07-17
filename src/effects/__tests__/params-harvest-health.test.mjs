/**
 * Node verification for effects/params-harvest/health.js — the harvest, RE-
 * CHECKED, not just generated and trusted once. Re-validates all 45 harvested
 * effects' schemas against the REAL `validateParamsSchema` every run, so a
 * future edit to `core/params-schema.js`'s contract (a new forbidden field, a
 * stricter range rule) that the harvest quietly stops satisfying goes red
 * here — not discovered by re-running a generator script nobody remembered
 * to re-run.
 */
import { checkParamsHarvest } from '../index.js';

export function run(t) {
  const { ok } = t;

  const report = checkParamsHarvest();

  ok('the harvest produced effects', report.effectCount > 0);
  // 45 is the real, measured count (2026-07-17) of getControlSchema()
  // DEFINITIONS in legacy/ — not references/calls to it. A drop below this
  // means the harvest regenerated smaller (a real regression); growth is fine
  // (V2 gaining an effect, or a future re-harvest finding more).
  ok(`all 45 real V2 schemas are present (found ${report.effectCount})`, report.effectCount >= 45);
  ok(`a substantial param count survived harvest (found ${report.paramCount})`, report.paramCount > 2000);

  ok(
    `EVERY harvested schema validates against the real contract (${report.perEffect.filter((e) => !e.ok).length} failing)`,
    report.ok
  );
  if (!report.ok) {
    for (const e of report.perEffect.filter((x) => !x.ok)) {
      console.error(`  FAILING: ${e.className} (${e.sourceFile}): ${e.errors.join(' | ')}`);
    }
  }

  // Spot-check specific, real facts a silent regression could break —
  // matching this session's own lesson (feedback_walls_must_be_passable_and_wired):
  // a check that only ever passes proves nothing was looked at.
  const byClass = Object.fromEntries(report.perEffect.map((e) => [e.className, e]));
  ok(
    'AsciiEffectV2 harvested (a real, well-populated schema)',
    !!byClass.AsciiEffectV2 && byClass.AsciiEffectV2.paramCount > 10
  );
  ok('WeatherLightningEffectV2 harvested (the self-class-reference case)', !!byClass.WeatherLightningEffectV2);
  ok('BushEffectV2 harvested (the 15-round dependency-chain case)', !!byClass.BushEffectV2);
  ok(
    'ContextualSceneGradeEffectV2 harvested (the label-space-default remap case)',
    !!byClass.ContextualSceneGradeEffectV2
  );
}
