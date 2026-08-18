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
 *
 * HARVEST FINDING (2026-07-17) — V2's 17 `type: 'string'` params split cleanly
 * into three groups, and the split validates this vocabulary:
 *   - 11 were `status*` with `readonly: true` — STATUS READOUTS, not params at
 *     all (see validateParamsSchema; this is why diagnostics wrote params).
 *   - 4 were `*Selection` with an `options` array — an ENUM wearing a string
 *     costume. `string + options` IS `enum`.
 *   - 1 (`audioStrikePath`, a file path) was a genuine free-text value → `text`.
 * So exactly one of the seventeen needed a string type, and it is a path.
 *
 * ⚠️ `angle` IS A VALUE TYPE, NOT A WIDGET REQUEST (added 2026-08-16, water's
 * flow direction). The rule above — "a float is a float; whether it gets a
 * slider is the renderer's decision" — is exactly why this is a TYPE and not a
 * `widget: 'compass'` field on a float (`widget` is in FORBIDDEN_IN_CONTRACT and
 * stays there). What makes an angle a different KIND of value is arithmetic, not
 * appearance: **it is CYCLIC**. 359 and 1 are two degrees apart, so an
 * out-of-range write must WRAP, never clamp — a float param clamps 370 to its
 * max, which silently turns "ten degrees past north" into "west", and it clamps
 * −5 to 0 rather than to 355. No min/max is declared (the range IS 0..360 by
 * definition; declaring it would invite a partial range that cannot be cyclic).
 * The renderer's freedom is untouched: a compass dial is one way to draw an
 * angle, a numeric spinner is another, and this declaration asks for neither.
 */
export const PARAM_TYPES = Object.freeze([
  'float',
  'int',
  'bool',
  'color',
  'enum',
  'text',
  'vec2',
  'vec3',
  'curve',
  'action',
  'angle',
]);

/**
 * Colour spaces a `color` param may declare. REQUIRED on every colour, because
 * V2 implied it through two storage shapes (30 hex vs 9 `colorType:'float'`)
 * and an implied colour space is a bug waiting for a shader.
 *  - 'srgb'   an author-picked tint, as seen in a colour picker. Decode before use.
 *  - 'linear' a value fed straight to shader maths. Never decode.
 */
export const COLOR_SPACES = Object.freeze(['srgb', 'linear']);

/** Fields that are the RENDERER's or the USER's, never the contract's. */
const FORBIDDEN_IN_CONTRACT = Object.freeze(['throttle', 'expanded', 'advanced', 'folder', 'widget', 'colorType']);

/**
 * The control-readiness vocabulary (docs/holy/UI-Testament.md, U0). `live` is
 * the default and the overwhelming majority — most params ARE wired. `planned`
 * is a day-one, hand-authored admission that this specific control has no
 * effect yet, so the migration to the LANTERN UI can ship every room at once
 * without silently pretending an unwired knob works (the author's own ask:
 * "mark them... with a tooltip explaining that these features aren't ready to
 * be hooked up yet"). This is deliberately NOT in `FORBIDDEN_IN_CONTRACT`: "does
 * writing this value currently do anything" is a fact about the value, the same
 * category as `default`/`min`/`max`, not a renderer/view-state concern like
 * `throttle` or `expanded`.
 *
 * This is a DIFFERENT signal from Testament U6's later `ctx.params` read-
 * tracking proxy: that one is an automated, ongoing detector for a control
 * that quietly stopped being read; this one is a manual, day-one admission
 * made at authoring time. Neither should auto-flip the other.
 */
export const PARAM_STATUS = Object.freeze(['live', 'planned']);

/** @typedef {{type: string, default?: unknown, min?: number, max?: number, step?: number, values?: string[], label?: string, help?: string, status?: 'live'|'planned', plannedReason?: string}} ParamDecl */

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

    // CONTROL READINESS (U0): `status` is optional and defaults to live, so
    // the overwhelming majority of params say nothing here. When declared, it
    // must be honest and self-consistent — `planned` with no reason is a red
    // badge nobody can explain, and a `plannedReason` left on a param that is
    // actually `live` is a stale claim a future reader has no way to notice.
    if ('status' in d && !PARAM_STATUS.includes(d.status)) {
      fail(`${key}: status '${d.status}' is not one of: ${PARAM_STATUS.join(', ')}`);
    }
    if (d.status === 'planned' && (typeof d.plannedReason !== 'string' || d.plannedReason.length === 0)) {
      fail(`${key}: status 'planned' needs a plannedReason — one sentence on why this control does nothing yet`);
    }
    if ('plannedReason' in d && d.status !== 'planned') {
      fail(
        `${key}: a plannedReason with no status:'planned' is a stale claim — either the control shipped and the reason should go, or the status was never set`
      );
    }

    // A COLOUR MUST DECLARE ITS SPACE. Harvest finding (2026-07-17): V2 had 39
    // colour params in two shapes — 30 hex strings and 9 `colorType: 'float'`
    // {r,g,b} objects — where the shape was silently carrying the colour SPACE
    // ('float' meant "already linear, do not decode"). That is the same class of
    // bug as the washed-out map: colour space is a property of the DATA and must
    // be named, never inferred from a container.
    if (d.type === 'color' && d.space !== 'srgb' && d.space !== 'linear') {
      fail(
        `${key}: a colour must declare its space — { space: 'srgb' } for author-picked tints, ` +
          "{ space: 'linear' } for values fed straight to a shader. V2 implied this via two storage " +
          'shapes and the implication is exactly how colour-space bugs are born.'
      );
    }

    // STATUS READOUTS ARE NOT PARAMS. Harvest finding: V2 had 12 `readonly: true`
    // string "params" (statusSubject, statusProbeAge, statusOutdoorsSample...) —
    // diagnostics rendered THROUGH the params system because it was the only
    // display channel available. That is why HealthEvaluatorService wrote params
    // at all: not malice, a missing concept. A readout is a computed OUTPUT, not
    // a knob; it belongs to the renderer as a derived display, and it must never
    // be storable, persistable, or writable.
    if ('readonly' in d) {
      fail(
        `${key}: 'readonly' means this is a STATUS READOUT, not a param. A readout is a computed ` +
          'output the renderer derives and displays — never a stored value. (Params.md §2: this is ' +
          'why diagnostics ended up mutating product state in V2.)'
      );
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
  // AN ANGLE MAY NOT DECLARE A RANGE. Its range is 0..360 by definition and its
  // out-of-range policy is WRAP, not clamp — a declared `min`/`max` would be a
  // second, disagreeing statement about both. A half-circle "angle" is not an
  // angle; it is a float with a unit, and should say so.
  if (d.type === 'angle' && ('min' in d || 'max' in d)) {
    return 'an angle is cyclic over 0..360 — declaring min/max asks for a clamp it does not have';
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
    case 'angle': {
      // WRAP, NEVER CLAMP — see the `angle` note on PARAM_TYPES. `clamped` stays
      // FALSE even when the value moved, and that is deliberate rather than
      // sloppy: `clamped` means "your intent was reduced to fit", and 370 → 10
      // reduces nothing. It is the same heading. Reporting it as clamped would
      // make `validateParamsSchema` reject a perfectly legal default of 360.
      const n = Number(value);
      if (!Number.isFinite(n))
        return { ok: false, error: `expected a finite number of degrees, got ${JSON.stringify(value)}` };
      // `((n % 360) + 360) % 360` — the second modulo is what makes negatives
      // land in [0,360) instead of (−360,0]; JS's `%` keeps the sign of its left
      // operand, so the naive single modulo turns −5 into −5, not 355.
      return { ok: true, value: ((n % 360) + 360) % 360, clamped: false };
    }
    case 'bool':
      if (typeof value !== 'boolean') return { ok: false, error: `expected a boolean, got ${JSON.stringify(value)}` };
      return { ok: true, value };
    case 'text':
      if (typeof value !== 'string') return { ok: false, error: `expected a string, got ${JSON.stringify(value)}` };
      if (decl.maxLength && value.length > decl.maxLength) {
        return { ok: false, error: `longer than maxLength ${decl.maxLength}` };
      }
      return { ok: true, value };
    case 'enum':
      if (!decl.values?.includes(value)) {
        return { ok: false, error: `expected one of [${decl.values?.join(', ')}], got ${JSON.stringify(value)}` };
      }
      return { ok: true, value };
    case 'color':
      // ONE storage shape (#rrggbb) — the SPACE is declared, never implied by
      // the shape. See the `space` note on PARAM_TYPES: V2 smuggled colour space
      // in as `colorType: 'float'` (9 of 39 colours), i.e. two shapes carrying a
      // meaning neither of them names. Colour-space confusion has already cost
      // this project a full session (reference_tsl_method_chaining_trap's sibling
      // finding: the washed-out map). It gets a name here.
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
