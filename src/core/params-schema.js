/**
 * THE PARAMS CONTRACT — what a knob IS, and the write-path check V2 never had.
 *
 * ============================================================================
 * THE DISEASE THIS CURES (docs/planning/Params.md)
 * ============================================================================
 *
 * V2 declared `static getControlSchema()` in 48 effect files — types, ranges,
 * steps, defaults, and help text in the author's own voice. It was then ignored
 * by all three parties who needed it:
 *
 *   - tweakpane-manager.js (11,157 lines): 0 uses — hand-wrote every folder.
 *   - The effect's OWN write path, in the SAME FILE, inches below the schema:
 *
 *       applyParamChange(paramId, value) {
 *         if (!hasOwnProperty(this.params, paramId)) return;  // silent skip
 *         this.params[paramId] = value;   // any type, any range, no clamp
 *       }
 *
 *   - control-state-sanitize.js (333 lines): 0 uses — hand-wrote the
 *     constraints A THIRD TIME (finite01, finiteDeg, hardcoded valid sets) to
 *     repair values at the DISK boundary "so Tweakpane bindings do not throw".
 *
 * A repair shop at the disk boundary is a confession that the front door has no
 * lock. This module is the lock: validation happens at the WRITE, so nothing
 * invalid can be stored, so nothing needs repairing on load.
 *
 * THE FOUR CONCERNS, SPLIT (Params.md §2). V2's schema conflated the CONTRACT
 * (type/min/max/step/default — the effect's truth, forever) with PRESENTATION
 * (label/help — the UI's, per renderer), VIEW STATE (`expanded`/`advanced` — the
 * user's, per session) and UI MECHANICS (`throttle`, authored 333 times on
 * PARAMETERS — a value's definition knowing about event timing). Because they
 * were one object, nothing could consume just the part it needed, so everyone
 * rebuilt the part they needed. Here, only contract + presentation live in the
 * declaration; view state and throttle are the renderer's business and are
 * REJECTED here (see `validateParamsSchema`).
 *
 * @module core/params-schema
 */

/**
 * The canonical type vocabulary. Nine precise types replacing eleven fuzzy ones:
 * V2 had `checkbox` AND `boolean`; `list` AND `dropdown` AND `select` — the same
 * concept under three names, because no canonical vocabulary existed. And
 * `slider` (1,513 uses) is a WIDGET, not a type — precisely the conflation this
 * split exists to end. A float is a float; whether it gets a slider is the
 * renderer's decision, made once in a type→widget table.
 */
export const PARAM_TYPES = Object.freeze(['float', 'int', 'bool', 'color', 'enum', 'vec2', 'vec3', 'curve', 'action']);

/** Fields that are the RENDERER's or the USER's, never the contract's. */
const FORBIDDEN_IN_CONTRACT = Object.freeze(['throttle', 'expanded', 'advanced', 'folder', 'widget']);

/** @typedef {{type: string, default?: unknown, min?: number, max?: number, step?: number, values?: string[], label?: string, help?: string}} ParamDecl */

/**
 * Validate an effect's params declaration. Pure; Node-testable today, months
 * before any renderer exists — a bad param is a red test, not a value
 * discovered wrong in play six months later (which is how V2's silent
 * `applyParamChange` skip behaved).
 *
 * @param {Record<string, ParamDecl>} schema
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateParamsSchema(schema) {
  const errors = [];
  const fail = (m) => errors.push(m);

  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, errors: ['params schema must be an object keyed by param id'] };
  }

  for (const [key, d] of Object.entries(schema)) {
    if (!d || typeof d !== 'object') {
      fail(`${key}: declaration must be an object`);
      continue;
    }

    if (!PARAM_TYPES.includes(d.type)) {
      fail(`${key}: type '${d.type}' is not one of: ${PARAM_TYPES.join(', ')}`);
      continue;
    }

    // The four-concerns split, enforced at the only moment it is cheap:
    // authoring time. V2 put `throttle` on 333 PARAMETERS.
    for (const f of FORBIDDEN_IN_CONTRACT) {
      if (f in d) {
        fail(
          `${key}: '${f}' is renderer/view state, not part of the contract — it belongs to the ` +
            'UI layer (Params.md §2). A value definition must not know about widgets or event timing.'
        );
      }
    }

    // Presentation that ships with the contract: a label is required because a
    // generated UI has nothing else to show, and V2's help text is the single
    // most valuable non-shader artifact it produced. `help` is optional but
    // strongly wanted — it becomes free tooltips in every surface.
    if (typeof d.label !== 'string' || d.label.length === 0) {
      fail(`${key}: needs a human label (the UI is GENERATED — there is no hand-written folder to name it)`);
    }

    if (d.type === 'action') continue; // a button: no value, no range, no default

    if (!('default' in d)) {
      fail(`${key}: needs a default — persistence stores only what DIFFERS from it (Params.md §3.4)`);
      continue;
    }

    const range = describeRange(d);
    if (range) fail(`${key}: ${range}`);

    // NOTE the `clamped` check. validateParamValue CLAMPS out-of-range numbers,
    // which is right for the write path (honour the author's intent, visibly) —
    // but a DECLARATION whose own default needs clamping is self-inconsistent,
    // and that is an authoring bug to catch in a test, not a runtime nicety.
    // (My own test caught this: `default: 5` on a 0..1 param passed silently.)
    const v = validateParamValue(d, d.default);
    if (!v.ok) fail(`${key}: its own default is invalid — ${v.error}`);
    else if (v.clamped)
      fail(`${key}: default ${JSON.stringify(d.default)} is outside its own declared range [${d.min}, ${d.max}]`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Is this declaration's range coherent? Returns an error string, or null.
 * @param {ParamDecl} d
 * @returns {string|null}
 */
function describeRange(d) {
  if (d.type === 'float' || d.type === 'int') {
    if (!Number.isFinite(d.min) || !Number.isFinite(d.max)) return 'numeric params need finite min and max';
    if (d.min >= d.max) return `min (${d.min}) must be below max (${d.max})`;
    if ('step' in d && !(Number.isFinite(d.step) && d.step > 0)) return 'step must be a positive number';
    if (d.type === 'int' && 'step' in d && !Number.isInteger(d.step)) return 'an int param needs an integer step';
  }
  if (d.type === 'enum') {
    if (!Array.isArray(d.values) || d.values.length === 0) return 'enum needs a non-empty `values` array';
    if (new Set(d.values).size !== d.values.length) return 'enum `values` must be unique';
  }
  return null;
}

/**
 * THE WRITE-PATH CHECK — the nine lines V2 never wrote.
 *
 * The policy, and each clause is a V2 corpse:
 *   - unknown key   → error. V2 silently RETURNED, so a typo'd param id did
 *                     nothing, forever, and the caller was never told.
 *   - wrong type    → error. A colour where a float goes is a BUG, not
 *                     something to coerce. Coercion is how the sanitizer was born.
 *   - out of range  → CLAMP, and say so. The author's intent (louder!) is
 *                     honoured, but the clamp is visible, never silent.
 *   - otherwise     → the value, ready to commit.
 *
 * @param {ParamDecl} decl
 * @param {unknown} value
 * @returns {{ok: boolean, value?: unknown, clamped?: boolean, error?: string}}
 */
export function validateParamValue(decl, value) {
  if (!decl || !PARAM_TYPES.includes(decl.type)) return { ok: false, error: 'no such param (unknown or undeclared)' };

  switch (decl.type) {
    case 'float':
    case 'int': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: `expected a finite number, got ${JSON.stringify(value)}` };
      if (decl.type === 'int' && !Number.isInteger(n)) {
        return { ok: false, error: `expected an integer, got ${n}` };
      }
      const lo = decl.min ?? -Infinity;
      const hi = decl.max ?? Infinity;
      const clampedValue = Math.min(hi, Math.max(lo, n));
      return { ok: true, value: clampedValue, clamped: clampedValue !== n };
    }
    case 'bool':
      if (typeof value !== 'boolean') return { ok: false, error: `expected a boolean, got ${JSON.stringify(value)}` };
      return { ok: true, value };
    case 'enum':
      if (!decl.values?.includes(value)) {
        return { ok: false, error: `expected one of [${decl.values?.join(', ')}], got ${JSON.stringify(value)}` };
      }
      return { ok: true, value };
    case 'color':
      if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
        return { ok: false, error: `expected a #rrggbb colour, got ${JSON.stringify(value)}` };
      }
      return { ok: true, value: value.toLowerCase() };
    case 'vec2':
    case 'vec3': {
      const n = decl.type === 'vec2' ? 2 : 3;
      if (!Array.isArray(value) || value.length !== n || !value.every((x) => Number.isFinite(Number(x)))) {
        return { ok: false, error: `expected ${n} finite numbers, got ${JSON.stringify(value)}` };
      }
      return { ok: true, value: value.map(Number) };
    }
    case 'curve':
      if (!Array.isArray(value) || value.length < 2) return { ok: false, error: 'a curve needs at least two points' };
      return { ok: true, value };
    case 'action':
      return { ok: false, error: 'an action has no value to set — it is invoked, not assigned' };
    default:
      return { ok: false, error: `unhandled type '${decl.type}'` };
  }
}

/**
 * The values that actually need storing: ONLY those differing from their
 * declared default (Params.md §3.4).
 *
 * Three properties fall out for free, all of which V2 lacked by storing the
 * whole blob: a scene flag shrinks to the handful of knobs actually touched;
 * adding a param with a sensible default CANNOT break an old scene (absent =
 * default); and the default lives in exactly ONE place, so a stored value can
 * never silently mean "same as the old default" after a retune.
 *
 * @param {Record<string, ParamDecl>} schema
 * @param {Record<string, unknown>} values
 * @returns {Record<string, unknown>}
 */
export function serializeParams(schema, values) {
  const out = {};
  for (const [key, d] of Object.entries(schema ?? {})) {
    if (d?.type === 'action' || !(key in (values ?? {}))) continue;
    const v = values[key];
    if (JSON.stringify(v) !== JSON.stringify(d.default)) out[key] = v;
  }
  return out;
}

/**
 * Rehydrate: declared defaults, overlaid with stored values, each validated on
 * the way in. An invalid stored value falls back to the default and is
 * REPORTED — never silently coerced (that was the sanitizer's job, and the
 * sanitizer could only guess because it never read the schema).
 *
 * @param {Record<string, ParamDecl>} schema
 * @param {Record<string, unknown>} stored
 * @returns {{values: Record<string, unknown>, rejected: {key: string, reason: string}[]}}
 */
export function hydrateParams(schema, stored) {
  const values = {};
  const rejected = [];
  for (const [key, d] of Object.entries(schema ?? {})) {
    if (d?.type === 'action') continue;
    values[key] = d.default;
    if (!(key in (stored ?? {}))) continue;
    const r = validateParamValue(d, stored[key]);
    if (r.ok) values[key] = r.value;
    else rejected.push({ key, reason: r.error });
  }
  for (const key of Object.keys(stored ?? {})) {
    if (!(key in (schema ?? {}))) rejected.push({ key, reason: 'no such param in this schema (renamed or removed?)' });
  }
  return { values, rejected };
}
