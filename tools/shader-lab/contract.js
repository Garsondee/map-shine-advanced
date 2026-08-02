/**
 * SHADER LAB — THE AGENT CONTRACT.
 *
 * ============================================================================
 * WHY A CONTRACT AND NOT JUST MORE API SURFACE
 * ============================================================================
 * Every bench so far grew its own ad-hoc shape (`window.shaderLab`,
 * `window.specularBench`, the lightning driver's own object), each learned by
 * reading its source. That is fine for one author with the whole file in
 * context and hopeless for a fleet: a fresh agent burns its first several
 * thousand tokens rediscovering what `gateLadder()` returns, and two agents
 * reporting "it works" mean two different things by it.
 *
 * This module is the ONE door. A bench REGISTERS itself; agents call
 * `lab.describe()` to learn what exists and `lab.run(...)` to execute a
 * scenario and get a structured verdict back. The report shape is fixed here,
 * so a report is comparable across benches, across agents, and across time.
 *
 * ============================================================================
 * THE THREE RULES THIS ENCODES
 * ============================================================================
 * 1. **`UNMEASURED` IS NOT `FAIL`, AND NEITHER IS IT `PASS`.** A check that
 *    could not be evaluated says so in its own status. `feedback_instruments_
 *    must_not_lie` was written after ratchets printed "tightened" while writing
 *    nothing; the same failure in a test rig would be a green suite that tested
 *    nothing. Any check whose predicate throws, or whose input was absent,
 *    lands here — never silently as a pass.
 *
 * 2. **A FAILED CALIBRATION POISONS THE WHOLE REPORT.** Benches calibrate
 *    orientation empirically (`feedback_y_flip_recurring_risk`). If that
 *    calibration failed, every coordinate-dependent number afterwards is
 *    suspect, so the report carries `calibration: 'FAILED'` at the top level
 *    and `ok` is false regardless of how many checks passed.
 *
 * 3. **EVIDENCE OR IT DIDN'T HAPPEN.** Every run fetches provenance from the
 *    server (git SHA + the hash of every dirty file) and can persist itself to
 *    `tools/shader-lab/runs/<runId>/`. The author live-edits while agents work,
 *    so a number without the bytes that produced it is unattributable.
 *
 * @module tools/shader-lab/contract
 */

/** @typedef {'pass'|'fail'|'UNMEASURED'} CheckStatus */

/**
 * Registered benches, by name. A bench is `{ name, title, rung, describe(),
 * scenarios: Map<string, scenario>, runScenario(scenario, ctx) }`.
 * @type {Map<string, object>}
 */
const benches = new Map();

/** Monotonic counter so two runs in the same second cannot collide. */
let runSeq = 0;

/**
 * A stable, filesystem-safe run id. Deliberately NOT `Date.now()` alone: two
 * agents starting together would produce the same stamp, and the server
 * sanitises to a single path segment anyway.
 * @param {string} label @returns {string}
 */
export function makeRunId(label) {
  const iso = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const safeLabel = String(label || 'run')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 48);
  runSeq += 1;
  return `${iso}-${String(runSeq).padStart(3, '0')}-${safeLabel}`;
}

/**
 * Build one check result. `measured` and `expected` are recorded even on a
 * pass, because the next reader's question is usually "by how much" rather
 * than "did it".
 *
 * @param {object} a
 * @param {string} a.id
 * @param {CheckStatus} a.status
 * @param {*} [a.measured] @param {*} [a.expected] @param {string} [a.note]
 * @returns {object}
 */
export function check({ id, status, measured, expected, note }) {
  return { id, status, measured: measured ?? null, expected: expected ?? null, note: note ?? null };
}

/**
 * Evaluate a predicate into a check, converting a THROW into `UNMEASURED`
 * rather than into a failure. A predicate that blew up did not observe a wrong
 * value — it observed nothing, and reporting that as `fail` invents evidence.
 *
 * @param {string} id @param {() => {ok: boolean, measured?: *, expected?: *, note?: string}} fn
 * @returns {object}
 */
export function evaluate(id, fn) {
  try {
    const r = fn();
    if (r === undefined || r === null) {
      return check({ id, status: 'UNMEASURED', note: 'predicate returned nothing' });
    }
    return check({
      id,
      status: r.ok ? 'pass' : 'fail',
      measured: r.measured,
      expected: r.expected,
      note: r.note,
    });
  } catch (err) {
    return check({ id, status: 'UNMEASURED', note: `predicate threw: ${err?.message ?? err}` });
  }
}

/** @returns {Promise<object|null>} */
async function fetchProvenance() {
  try {
    const res = await fetch('/__lab/provenance', { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * POST one artifact to the server, which lands it under
 * `tools/shader-lab/runs/<runId>/<file>`.
 * @param {string} runId @param {string} file @param {BodyInit} body
 * @returns {Promise<object|null>}
 */
export async function saveArtifact(runId, file, body) {
  try {
    const res = await fetch(`/__lab/artifact?run=${encodeURIComponent(runId)}&file=${encodeURIComponent(file)}`, {
      method: 'POST',
      body,
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * Serialise a canvas to PNG and persist it. Returns the artifact name, or null
 * if the canvas could not be encoded (which is reported, never swallowed).
 * @param {string} runId @param {string} file @param {HTMLCanvasElement} canvas
 * @returns {Promise<string|null>}
 */
export async function saveCanvasPng(runId, file, canvas) {
  if (!canvas) return null;
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  const r = await saveArtifact(runId, file, blob);
  return r?.ok ? file : null;
}

/**
 * Register a bench with the contract. Called by each bench module at load.
 * @param {object} bench
 */
export function registerBench(bench) {
  if (!bench?.name) throw new Error('registerBench: a bench needs a name');
  benches.set(bench.name, bench);
}

/**
 * WHAT EXISTS — the question an agent asks first, so it never has to read lab
 * source to find out. Cheap, synchronous, no rendering.
 * @returns {object}
 */
export function describe() {
  return {
    contractVersion: 1,
    benches: [...benches.values()].map((b) => ({
      name: b.name,
      title: b.title ?? b.name,
      rung: b.rung ?? null,
      summary: b.summary ?? null,
      scenarios: [...(b.scenarios?.keys?.() ?? [])],
      params: b.params ?? null,
      checks: b.checkIds ?? null,
      ready: Boolean(b.ready?.() ?? true),
    })),
    notes: [
      'run(benchName, scenarioName, opts) executes one scenario and returns a report.',
      'A check status is pass | fail | UNMEASURED. UNMEASURED never means pass.',
      'report.ok is true only when there are zero fail, zero UNMEASURED, and calibration is OK.',
    ],
  };
}

/**
 * EXECUTE ONE SCENARIO AND REPORT.
 *
 * @param {string} benchName
 * @param {string} scenarioName
 * @param {object} [opts]
 * @param {boolean} [opts.persist] - write report + artifacts to `runs/`. Default true.
 * @param {string} [opts.label]
 * @param {object} [opts.params] - scenario parameter overrides.
 * @returns {Promise<object>} the report
 */
export async function run(benchName, scenarioName, opts = {}) {
  const startedMs = performance.now();
  const bench = benches.get(benchName);
  const runId = makeRunId(opts.label ?? `${benchName}-${scenarioName}`);

  if (!bench) {
    return {
      ok: false,
      runId,
      error: `no such bench '${benchName}'`,
      availableBenches: [...benches.keys()],
    };
  }
  const scenario = bench.scenarios?.get?.(scenarioName);
  if (!scenario) {
    return {
      ok: false,
      runId,
      bench: benchName,
      error: `no such scenario '${scenarioName}' on bench '${benchName}'`,
      availableScenarios: [...(bench.scenarios?.keys?.() ?? [])],
    };
  }

  let result = null;
  let thrown = null;
  try {
    result = await bench.runScenario(scenario, { runId, params: opts.params ?? {} });
  } catch (err) {
    thrown = `${err?.message ?? err}\n${err?.stack ?? ''}`;
  }

  const checks = result?.checks ?? [];
  const failed = checks.filter((c) => c.status === 'fail');
  const unmeasured = checks.filter((c) => c.status === 'UNMEASURED');
  // Rule 2: a bench whose own orientation calibration failed cannot be trusted
  // about anything positional, so the whole report is not-ok even if every
  // check passed.
  const calibration = result?.calibration ?? 'OK';

  const report = {
    ok: !thrown && failed.length === 0 && unmeasured.length === 0 && calibration === 'OK',
    runId,
    bench: benchName,
    scenario: scenarioName,
    rung: bench.rung ?? null,
    calibration,
    error: thrown,
    summary: {
      total: checks.length,
      pass: checks.filter((c) => c.status === 'pass').length,
      fail: failed.length,
      UNMEASURED: unmeasured.length,
    },
    checks,
    inputs: result?.inputs ?? null,
    stats: result?.stats ?? null,
    artifacts: result?.artifacts ?? [],
    timing: { totalMs: Math.round(performance.now() - startedMs), ...(result?.timing ?? {}) },
    provenance: await fetchProvenance(),
    userAgent: navigator.userAgent,
  };

  if (opts.persist !== false) {
    const saved = await saveArtifact(runId, 'report.json', JSON.stringify(report, null, 2));
    report.persistedTo = saved?.ok ? saved.path : null;
    if (!saved?.ok) report.persistError = saved?.error ?? 'unknown';
  }
  return report;
}

/** Install the one global door. */
export function installContract() {
  const api = { describe, run, registerBench, saveArtifact, saveCanvasPng, makeRunId, check, evaluate, benches };
  window.lab = api;
  return api;
}
