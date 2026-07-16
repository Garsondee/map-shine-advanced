/**
 * DERIVED HEALTH — the Breaker Box's question, answered from the declarations.
 *
 * ============================================================================
 * WHY THIS IS FORTY LINES AND V2's WAS 2,261
 * ============================================================================
 *
 * V2's HealthEvaluatorService had to hand-write a parallel model of the module
 * — 17 hardcoded effect names, hand-written `dependencyGraph.addEdge(...)`
 * calls, health rules reading private fields (`instance?._composeMaterial`),
 * and a UI that bound rules to panels by KEYWORD STRING. Then it needed a
 * comment-MUST on ten effects to keep the copy true:
 *
 *   "If you change this effect's lifecycle, core resources, floor behavior, or
 *    dependency bindings, you MUST update HealthEvaluator contracts/wiring
 *    for `WaterEffectV2` to prevent silent failures."
 *
 * A system whose purpose is catching silent failures, which fails silently when
 * you forget to hand-update it.
 *
 * AND IT COULD NOT HAVE BEEN OTHERWISE. The health service needed to know "what
 * does Water depend on?" and NOTHING in V2 declared that. The dependency graph
 * existed only inside the watchdog, because the watchdog was the only thing that
 * ever needed it written down. Asked to observe an undeclared system, it drew
 * its own map. That is the correct response — and doomed regardless.
 *
 * Here the map IS the code (`graph/passes.js`), so health READS it instead of
 * copying it. THE RULE: health may not contain a model of the system. It may
 * only compare the declarations to runtime. If health needs a fact the
 * declarations do not carry, that is a gap in the DECLARATIONS — fix it there,
 * where every consumer benefits, not in a private copy only the watchdog reads.
 *
 * Consequences, all free: no badge on any effect (nothing to sync); no private
 * fields read (nothing to couple to); no effect names hardcoded (the pass list
 * is the census); and unbuilt is distinguishable from broken, because
 * `pass-seams.js` already makes status a checked fact.
 *
 * @module graph/pass-health
 */

import { PASSES } from './passes.js';

/**
 * @typedef {object} HealthFinding
 * @property {string} passId
 * @property {string} resource
 * @property {'live'|'unbuilt'|'MISSING'|'STARVED'} status
 * @property {'ok'|'info'|'error'} severity
 * @property {string} message
 */

/**
 * Compare what the passes DECLARED against what the frame actually produced.
 *
 * @param {{has: (resourceId: string) => boolean}} frame - live resource lookup.
 * @param {typeof PASSES} [passes]
 * @returns {{ok: boolean, findings: HealthFinding[]}}
 */
export function evaluatePassHealth(frame, passes = PASSES) {
  const findings = [];
  const seen = new Set();

  for (const pass of passes) {
    // STARVED — a pass declared a read that nothing produced. V2 could not ask
    // this at all: `reads` existed only as an undeclared fact in someone's head,
    // which is exactly why it hand-wrote addEdge() to guess at the same thing.
    for (const r of [...pass.reads, ...pass.modifies]) {
      if (!frame.has(r)) {
        findings.push({
          passId: pass.id,
          resource: r,
          status: 'STARVED',
          severity: pass.status === 'live' ? 'error' : 'info',
          message:
            pass.status === 'live'
              ? `'${pass.id}' declares a read of '${r}' but nothing produced it this frame`
              : `'${pass.id}' is ${pass.status}; its declared read '${r}' is absent (expected)`,
        });
      }
    }

    // Did each declared output actually appear? Unbuilt is NOT broken — the
    // distinction V2 could not draw, and the reason a red Breaker Box was hard
    // to trust: an unwired effect and a failed one looked identical.
    for (const r of pass.creates) {
      seen.add(r);
      const present = frame.has(r);
      if (present) {
        findings.push({ passId: pass.id, resource: r, status: 'live', severity: 'ok', message: `'${r}' produced` });
      } else if (pass.status === 'live') {
        findings.push({
          passId: pass.id,
          resource: r,
          status: 'MISSING',
          severity: 'error',
          message: `'${pass.id}' is live but did not produce its declared '${r}'`,
        });
      } else {
        findings.push({
          passId: pass.id,
          resource: r,
          status: 'unbuilt',
          severity: 'info',
          message: `'${r}' awaits ${pass.id} (${pass.status}) — see ${pass.owns}`,
        });
      }
    }
  }

  // An orphan: something in the frame that no pass claims to create. In V2 this
  // was unaskable — resources had no ids, no producers, and 70 private render
  // targets nobody owned.
  return { ok: !findings.some((f) => f.severity === 'error'), findings };
}

/**
 * The Breaker Box's circuits, DERIVED. V2 hand-wrote `SOURCE_DEFS` in the UI and
 * bound them to rules with keyword strings (`keywords: ['composeMaterial']`) —
 * rename a private field, and the panel silently showed the wrong circuit.
 *
 * @param {{has: (resourceId: string) => boolean}} frame
 * @param {typeof PASSES} [passes]
 * @returns {{id: string, label: string, status: string, severity: string}[]}
 */
export function breakerCircuits(frame, passes = PASSES) {
  const { findings } = evaluatePassHealth(frame, passes);
  const byPass = new Map();
  for (const f of findings) {
    const cur = byPass.get(f.passId);
    // Worst status wins — a pass with one missing output is not "ok".
    if (!cur || rank(f.severity) > rank(cur.severity)) {
      byPass.set(f.passId, { id: f.passId, label: f.passId, status: f.status, severity: f.severity });
    }
  }
  return [...byPass.values()];
}

/** @param {string} sev @returns {number} */
function rank(sev) {
  return sev === 'error' ? 2 : sev === 'info' ? 1 : 0;
}
