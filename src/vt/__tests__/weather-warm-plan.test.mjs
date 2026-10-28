/**
 * weather-warm-plan.test.mjs — which weather shaders are compiled behind the loading curtain (2026-10-28).
 *
 * The plan is policy, and the policy has two promises worth pinning: a DISABLED effect is never warmed (a low
 * profile must not pay for weather it will not draw), and the renderer half never lets a real frame run in the
 * middle of a forced gate (a stray `await` there would draw a fake storm to the screen).
 */
import { readFileSync } from 'node:fs';
import { planWeatherWarmUp, formatWeatherWarmDetail } from '../weather-warm-plan.js';

export function run(t) {
  const { ok } = t;

  ok('nothing enabled, nothing planned', planWeatherWarmUp().length === 0);
  ok(
    '...and nothing planned from explicit falsy flags',
    planWeatherWarmUp({ windTrails: false, cloudTops: false }).length === 0
  );

  {
    const plan = planWeatherWarmUp({ precipKinds: ['rain', 'snow'], windTrails: true, cloudTops: true });
    ok('every enabled thing gets a scenario', plan.length === 4);
    ok('precipitation first, in the order given', plan[0].kind === 'rain' && plan[1].kind === 'snow');
    ok('then wind trails, then cloud tops', plan[2].type === 'windTrails' && plan[3].type === 'cloudTops');
    ok('ids are unique', new Set(plan.map((s) => s.id)).size === plan.length);
    ok(
      'rain also draws the world pass (the roof-edge drips live in the world scene)',
      plan[0].passes.join() === 'geometry.world,surface.precipitation'
    );
    ok('snow draws the weather pass alone', plan[1].passes.join() === 'surface.precipitation');
    ok('trails draw the particle pass', plan[2].passes.join() === 'surface.particles');
    ok('cloud tops draw their own pass', plan[3].passes.join() === 'surface.cloudTops');
    ok(
      'every scenario names itself for the loading screen',
      plan.every((s) => formatWeatherWarmDetail(s).includes(s.label))
    );
  }
  {
    const plan = planWeatherWarmUp({ precipKinds: [], windTrails: false, cloudTops: true });
    ok('a disabled effect is not planned', plan.length === 1 && plan[0].type === 'cloudTops');
  }

  // ── THE RENDERER HALF HOLDS ITS ONE SAFETY RULE ──────────────────────────
  // The forced gate is not saved across a frame. `warmWeatherScenario` must stay synchronous end to end.
  {
    const src = readFileSync(new URL('../vt-pan-viewer.js', import.meta.url), 'utf8');
    const start = src.indexOf('function warmWeatherScenario(');
    const end = src.indexOf('function sampleSceneSettle(', start);
    ok('the scenario block is findable in the viewer', start > 0 && end > start);
    const body = src.slice(start, end);
    ok(
      'the scenario block contains no await (a real frame must not run while a gate is forced)',
      !/\bawait\b/.test(body)
    );
    ok('...and is not async', !/async\s+function\s+warmWeatherScenario/.test(src));
    ok('...and never makes compiles synchronous (no governor.blocking)', !/\.blocking\(/.test(body));
    ok('...and every forced gate is restored in a finally', (body.match(/finally\s*\{/g) ?? []).length === 3);
  }
}
