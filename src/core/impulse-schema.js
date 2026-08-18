/**
 * THE IMPULSE CONTRACT — a one-shot, effect-declared trigger (docs/holy/
 * UI-Testament.md §4.4, U7). "An effect may declare impulses at
 * registration: `{ id, label, icon, fire() }` — strike lightning, roll
 * thunder, gust the wind, flare the fire." Instant by nature — impulses
 * ignore Fade Time entirely (§4.1's own grammar table row), unlike every
 * other Remote control.
 *
 * ============================================================================
 * WHY THIS REUSES `core/params-schema.js#PARAM_STATUS`, NOT A SECOND ENUM
 * ============================================================================
 *
 * An impulse's readiness is the exact same `'live'|'planned'` question a
 * param's is — "does clicking this currently do anything" — the same
 * control-readiness convention U0 established, applied to a button instead
 * of a slider. A second, differently-named vocabulary for the identical
 * concept is exactly the kind of drift this project's own doctrine warns
 * against elsewhere (one canonical list, many consumers).
 *
 * ============================================================================
 * WHY THERE IS NO SEPARATE "REMOTE ROW" SELECTION HERE
 * ============================================================================
 *
 * §4.4 calls the Remote's row "curated... a scene-level pick, not a
 * scroll" — implying a real picker UI for WHICH registered impulses show on
 * the Remote when there are more than fit in one row. With exactly the
 * three impulses this project registers today (Strike, Thunder, Gust),
 * showing all of them on the Remote already satisfies "curated to a single
 * row" — there is nothing to pick FROM yet. `validateImpulseList` still
 * enforces the invariants a future curation UI would need (no duplicate
 * ids) so this file is ready for that follow-up without needing to be
 * rewritten, but the actual scene-flag-driven picker is real, scoped,
 * deferred work, not silently invented ahead of having a second impulse
 * that couldn't fit.
 *
 * @module core/impulse-schema
 */

import { PARAM_STATUS } from './params-schema.js';

/** @typedef {{id: string, label: string, icon: string, fire?: () => void, status?: 'live'|'planned', plannedReason?: string}} ImpulseDecl */

/**
 * Validate one impulse declaration. Pure; Node-testable exactly like
 * `validateParamsSchema`/`validateDialsSchema`.
 * @param {ImpulseDecl} decl
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateImpulseDecl(decl) {
  if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
    return { ok: false, errors: ['an impulse declaration must be an object'] };
  }
  const errors = [];
  const fail = (m) => errors.push(m);

  if (typeof decl.id !== 'string' || decl.id.length === 0) fail('needs a stable, non-empty id');
  if (typeof decl.label !== 'string' || decl.label.length === 0) {
    fail('needs a human label — the Remote/Studio have nothing else to show');
  }
  if (typeof decl.icon !== 'string' || decl.icon.length === 0) fail('needs an icon name');

  const status = decl.status ?? 'live';
  if (!PARAM_STATUS.includes(status)) {
    fail(`status '${status}' is not one of: ${PARAM_STATUS.join(', ')}`);
  } else if (status === 'planned') {
    if (typeof decl.plannedReason !== 'string' || decl.plannedReason.length === 0) {
      fail("status:'planned' needs a plannedReason — a dashed chip with no explanation reads as broken, not honest");
    }
  } else if (typeof decl.fire !== 'function') {
    fail('a live (non-planned) impulse needs a fire() function — nothing else can make the button do anything');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a whole list of impulses — every declaration's own check, plus
 * the one list-level invariant a single declaration can't see: no two
 * impulses sharing an id (mirrors `validateCueStack`'s identical shape).
 * @param {ImpulseDecl[]} impulses
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateImpulseList(impulses) {
  if (!Array.isArray(impulses)) return { ok: false, errors: ['impulses must be an array'] };

  const errors = [];
  const seenIds = new Set();
  for (const decl of impulses) {
    const result = validateImpulseDecl(decl);
    if (!result.ok) {
      const label = typeof decl?.id === 'string' && decl.id.length > 0 ? decl.id : '(no id)';
      for (const e of result.errors) errors.push(`${label}: ${e}`);
      continue;
    }
    if (seenIds.has(decl.id)) errors.push(`${decl.id}: duplicate id — two impulses cannot share one`);
    seenIds.add(decl.id);
  }
  return { ok: errors.length === 0, errors };
}
