/**
 * shader-budget.test.mjs — A SHADER CANNOT QUIETLY GROW BACK INTO THE ONE THAT KILLED THE GPU
 * (2026-10-27, epic mmp-fpu).
 *
 * ============================================================================
 * THE STORY
 * ============================================================================
 * A cold load of one scene lost the whole GPU device three times in a day. The cause was one candle pipeline:
 * 58,014 characters of generated WGSL that took 19.7 s to compile, synchronously, on the GPU process's main
 * thread — and Chrome kills that thread after ~15 s, taking every WebGL/WebGPU context on the page with it.
 * Nothing in the repository could say how big or how slow a shader was, so every diagnosis was a theory.
 *
 * Shaders and systems keep getting more complex. The fix that lasts is a MEASURING STICK and a LIMIT:
 *
 *   - `tools/shader-lab/cost-probe.js` builds the real production materials and compiles them on the real
 *     compiler (`bench()`), reporting size and cold compile time;
 *   - this file enforces, with NO GPU, the things that DRIVE that time and are countable from the TSL graph:
 *     noise call sites (each is inlined by the driver's compiler — the term that exploded), distinct nodes,
 *     and textures bound;
 *   - `vt/pipeline-governor.js` is the net underneath: whatever grows past `HEAVY_PIPELINE_CHARS` compiles on a
 *     worker thread, flagged or not.
 *
 * ## What a budget can and cannot see
 *
 * The census walks the node graph a builder constructs. A material whose body is inside `Fn(() => …)()` (the
 * precipitation layers, most of water) shows as a handful of nodes, because that body only exists once a
 * renderer's builder runs it — those entries carry `budget: null` and are protected by the deferrable flag below
 * and by the lab bench instead. This file says so rather than pretend a 6-node census is a guarantee.
 *
 * ## The properties
 *
 *   1. every budgeted scenario BUILDS, and stays inside its noise / node / texture budget;
 *   2. a budget is not left far above the truth: a shader that got leaner must tighten its budget (a ratchet),
 *      so the number in the file is always the real ceiling and never a cushion for the next feature;
 *   3. the candle's wind comes from the BAKED field and RECORDED history — it must stay several times cheaper
 *      than the analytic path it replaced (the regression that would silently bring the crash back);
 *   4. every material of a scenario marked `mustBeDeferrable` carries the flag, so no pipeline of it can compile
 *      on the GPU process's main thread;
 *   5. the JSON is complete: a budget with no recorded GPU measurement is a number nobody can interpret.
 */
import { readFileSync } from 'node:fs';
import { censusMaterial } from '../../core/__tests__/tsl-census.mjs';
import { SCENARIOS } from '../../../tools/shader-lab/cost-probe.js';
import { compilePolicyFor } from '../../core/compile-policy.js';

const budgets = JSON.parse(readFileSync(new URL('./shader-budgets.json', import.meta.url), 'utf8'));

/** Every material a scene draws, once each. */
function materialsOf(scene) {
  const out = new Set();
  scene.traverse((o) => {
    if (o.material) for (const m of [].concat(o.material)) out.add(m);
  });
  return [...out];
}

/** The largest census over a scenario's materials: each is its own pipeline, so the worst one is what matters. */
function worstCensus(materials) {
  const worst = { noise: 0, unique: 0, textures: 0 };
  for (const m of materials) {
    const c = censusMaterial(m);
    worst.noise = Math.max(worst.noise, c.noise);
    worst.unique = Math.max(worst.unique, c.unique);
    worst.textures = Math.max(worst.textures, c.textures);
  }
  return worst;
}

export function run(t) {
  const { ok } = t;
  const slack = budgets.limits.budgetSlack;

  ok(
    'the budget file says where its GPU numbers came from',
    typeof budgets.measuredOn?.date === 'string' && /compileAsync/.test(budgets.measuredOn?.method ?? '')
  );
  ok('the per-stage texture limit is the WebGPU default', budgets.limits.maxTexturesPerStage === 16);

  for (const [key, entry] of Object.entries(budgets.scenarios)) {
    const build = SCENARIOS[entry.scenario];
    ok(`${key}: names a scenario the lab can build`, typeof build === 'function');
    if (typeof build !== 'function') continue;

    let scene = null;
    let buildError = null;
    try {
      scene = build(entry.opts ?? {}).scene;
    } catch (err) {
      buildError = err;
    }
    ok(
      `${key}: the real production builder constructs (${buildError ? buildError.message : 'clean'})`,
      buildError === null
    );
    if (!scene) continue;
    const materials = materialsOf(scene);
    ok(`${key}: it draws at least one material`, materials.length > 0);

    // 4. no pipeline of a per-frame effect may compile on the GPU process's main thread
    if (entry.mustBeDeferrable) {
      const unflagged = materials.filter((m) => compilePolicyFor(m, 0).reason !== 'flagged');
      ok(
        `${key}: every material is flagged deferrable (core/compile-policy.js) — ${unflagged.length} are not`,
        unflagged.length === 0
      );
    }

    // 1 + 2. the census budget
    if (entry.budget === null) continue;
    const now = worstCensus(materials);
    const b = entry.budget;
    ok(`${key}: noise call sites ${now.noise} <= budget ${b.noise}`, now.noise <= b.noise);
    ok(`${key}: graph nodes ${now.unique} <= budget ${b.unique}`, now.unique <= b.unique);
    ok(
      `${key}: textures ${now.textures} <= budget ${b.textures} (and the per-stage limit ${budgets.limits.maxTexturesPerStage})`,
      now.textures <= b.textures && now.textures <= budgets.limits.maxTexturesPerStage
    );
    ok(
      `${key}: the budget is a ceiling, not a cushion — nodes ${now.unique} against a budget of ${b.unique} ` +
        `(tighten it to ~${Math.ceil(now.unique * 1.2)} if this fails)`,
      b.unique <= Math.ceil(now.unique * slack)
    );
    ok(
      `${key}: noise budget ${b.noise} is within reach of the real ${now.noise} (tighten it if this fails)`,
      b.noise <= Math.max(now.noise + 4, Math.ceil(now.noise * slack))
    );

    // 5. a budget nobody can interpret is not a budget
    ok(
      `${key}: its budget has a recorded GPU measurement beside it (chars and cold compile ms)`,
      Number.isFinite(entry.measured?.gpu?.chars) && Number.isFinite(entry.measured?.gpu?.coldMs)
    );
  }

  // 3. the baked field + recorded history must stay far cheaper than the analytic wind they replaced
  for (const id of ['candle-flame', 'candle-light-illumination', 'candle-light-coloration']) {
    const shipped = worstCensus(materialsOf(SCENARIOS[id]({ field: true, history: true }).scene));
    const analytic = worstCensus(materialsOf(SCENARIOS[id]({ field: false, history: false }).scene));
    ok(
      `${id}: reading the baked wind field costs at most a third of the analytic noise (${shipped.noise} vs ${analytic.noise}) ` +
        '— if this fails, a consumer is sampling the wind analytically again, which is the crash',
      shipped.noise * 3 <= analytic.noise
    );
    ok(
      `${id}: ...and far fewer nodes (${shipped.unique} vs ${analytic.unique})`,
      shipped.unique * 1.4 <= analytic.unique
    );
  }
}
