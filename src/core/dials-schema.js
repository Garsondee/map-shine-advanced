/**
 * THE DIALS CONTRACT — a macro control, "the authored FOH v2" (docs/holy/
 * UI-Testament.md §5.2, §9, U6; docs/planning/Effects-UI.md §3). A dial is
 * NOT a param wearing a nicer label: it is a named, plain-language slider
 * with its own `[range]`/`default`, driving ONE OR MORE real params through
 * a per-target curve into a `to` window that must lie inside that param's
 * own declared `[min,max]`. Moving a dial writes through the exact same
 * `validateParamValue` path any ROH control does — "a dial is a computed
 * multi-write, not a new storage location" (Effects-UI.md §3.1).
 *
 * ============================================================================
 * WHY ONLY `float`/`int` CAN BE DRIVE TARGETS (v1)
 * ============================================================================
 *
 * A `drives` entry is a `to: [min, max]` window a dial's [0,1] position gets
 * lerped across — that only means something for a continuous numeric value.
 * `angle` is the sharpest case: `params-schema.js#PARAM_TYPES`'s own doc is
 * explicit that an angle declares NO min/max ("the range IS 0..360 by
 * definition; declaring it would invite a partial range that cannot be
 * cyclic") because an out-of-range write must WRAP, never clamp — there is
 * no wrap-aware `to` shape today. But the same problem applies to every
 * OTHER non-numeric type too: a `color` param has no min/max to check
 * against either (it declares `space`), so without an explicit type gate a
 * `to: [0,1]` window would validate against nothing, and `resolveDialDrives`
 * would happily write a raw float into a colour picker's storage slot.
 * `bool`/`enum`/`text`/`vec2`/`vec3`/`curve`/`action` all fail the identical
 * way. So the gate is POSITIVE (only `float`/`int` accepted), not a
 * blocklist that has to remember every unsafe type as one is added. Water's
 * own `flowAngleDeg` (one of its six current `fohKeys`) is the concrete case
 * this excludes today — it stays a raw ROH/fohKeys control, never a dial
 * target, until a cyclic `to` shape is designed on purpose.
 *
 * ============================================================================
 * WHY THIS FILE TAKES THE PARAMS SCHEMA DIRECTLY, NOT AN INJECTED RESOLVER
 * ============================================================================
 *
 * `core/cues-schema.js#validateCue` takes a `resolveType` FUNCTION because a
 * cue's targets can name ANY live fade key across every effect and axis —
 * something only the runtime fade-source registry knows. A dial's `drives`
 * keys are scoped to ONE effect's own params schema, already in the
 * caller's hand (the same object `fohKeys`/`rohGroups` already consume) —
 * no cross-effect registry is needed, so the simpler two-argument shape
 * (`rohGroups(schema, fohKeys)`'s own shape) is the honest fit, not cues'
 * injection machinery.
 *
 * ============================================================================
 * `dials/valid-reference` — THE WALL (docs/holy/UI-Testament.md §10)
 * ============================================================================
 *
 * Same kind of wall `cues-schema.test.mjs` already enforces for cues: not a
 * `tools/verify-structure.mjs` regex (that tool "has no import graph, only
 * regex over text" — it cannot cross-reference two schemas' real data), but
 * a Node test that calls `validateDialsSchema` against every effect's real
 * dials schema and fails the suite the moment a `drives` target goes stale
 * (a param renamed, a range narrowed under an already-authored `to` window).
 * `core/__tests__/dials-schema.test.mjs` IS this wall, exercised on every
 * `node tools/run-tests.mjs` run exactly like every other Node-test wall.
 *
 * @module core/dials-schema
 */

/** The closed curve vocabulary a `drives` entry may declare. */
export const DIAL_CURVES = Object.freeze(['linear', 'ease-in', 'ease-out', 'smoothstep']);

/**
 * Hard ceiling (Effects-UI.md §3.2): "3-6 dials per effect, hard ceiling" —
 * a strip that needs a seventh dial has stopped being a curated FOH strip.
 */
export const MAX_DIALS_PER_EFFECT = 6;

/** [0,1] -> [0,1], monotonic non-decreasing — the shaping the dial's raw
 * [0,1] position gets pushed through before landing in a drive's `to` window. */
export const DIAL_CURVE_FNS = Object.freeze({
  linear: (t) => t,
  'ease-in': (t) => t * t,
  'ease-out': (t) => t * (2 - t),
  smoothstep: (t) => t * t * (3 - 2 * t),
});

/** @typedef {{to: [number, number], curve: 'linear'|'ease-in'|'ease-out'|'smoothstep'}} DialDrive */
/** @typedef {{label: string, help?: string, range: [number, number], default: number, drives: Record<string, DialDrive>}} DialDecl */

/**
 * Validate an effect's dials declaration against that SAME effect's own
 * params schema. Pure; Node-testable exactly like `validateParamsSchema`.
 *
 * `dialsSchema` absent/null/undefined is a legal, common case — an effect
 * with no authored dials keeps `fohKeys` as its FOH strip (U6's checklist:
 * "FOH strips render authored dials where declared, `fohKeys` remains the
 * fallback") — so this returns `{ok:true}` rather than failing on nothing.
 *
 * @param {Record<string, DialDecl>|null|undefined} dialsSchema
 * @param {Record<string, object>} paramsSchema - the effect's OWN params
 *   schema (e.g. `WATER_PARAMS`), keyed exactly like `core/params-schema.js`
 *   itself keys a params schema — the id IS the object key, never a `.id` field.
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateDialsSchema(dialsSchema, paramsSchema) {
  if (dialsSchema === null || dialsSchema === undefined) return { ok: true, errors: [] };
  if (typeof dialsSchema !== 'object' || Array.isArray(dialsSchema)) {
    return { ok: false, errors: ['dials schema must be an object keyed by dial id, or null/undefined for none'] };
  }

  const errors = [];
  const fail = (id, m) => errors.push(`${id}: ${m}`);

  const ids = Object.keys(dialsSchema);
  if (ids.length > MAX_DIALS_PER_EFFECT) {
    errors.push(
      `dials: ${ids.length} declared, ${MAX_DIALS_PER_EFFECT} is the hard ceiling (Effects-UI.md §3.2) — ` +
        'a strip that needs more has stopped being a curated FOH strip'
    );
  }

  for (const [id, decl] of Object.entries(dialsSchema)) {
    if (!decl || typeof decl !== 'object' || Array.isArray(decl)) {
      fail(id, 'declaration must be an object');
      continue;
    }
    if (typeof decl.label !== 'string' || decl.label.length === 0) {
      fail(id, "needs a plain-language label — the FOH strip has nothing else to show ('R:0.62' is not a label)");
    }
    const hasRange = Array.isArray(decl.range) && decl.range.length === 2 && decl.range.every(Number.isFinite);
    if (!hasRange || !(decl.range[0] < decl.range[1])) {
      fail(id, 'range must be [min, max] with min < max');
    }
    if (
      !Number.isFinite(decl.default) ||
      (hasRange && (decl.default < decl.range[0] || decl.default > decl.range[1]))
    ) {
      fail(id, 'default must be a finite number within range');
    }

    const drives = decl.drives && typeof decl.drives === 'object' && !Array.isArray(decl.drives) ? decl.drives : null;
    const driveKeys = drives ? Object.keys(drives) : [];
    if (driveKeys.length === 0) {
      fail(id, 'needs at least one drives entry — a dial that moves nothing is not a dial');
      continue;
    }

    for (const paramKey of driveKeys) {
      const drive = drives[paramKey];
      const paramDecl = paramsSchema?.[paramKey];
      if (!paramDecl) {
        fail(id, `drives '${paramKey}', which this effect's params schema does not declare`);
        continue;
      }
      if (paramDecl.type !== 'float' && paramDecl.type !== 'int') {
        const why =
          paramDecl.type === 'angle'
            ? 'angle wraps rather than clamps, so it has no fixed [min,max] a to window can target'
            : `a '${paramDecl.type}' param has no continuous numeric range a to window can lerp across`;
        fail(id, `drives '${paramKey}', a '${paramDecl.type}' param — ${why}. Not a supported dial target yet.`);
        continue;
      }
      if (!drive || typeof drive !== 'object' || Array.isArray(drive)) {
        fail(id, `drives '${paramKey}': entry must be an object`);
        continue;
      }
      if (!DIAL_CURVES.includes(drive.curve)) {
        fail(id, `drives '${paramKey}': curve '${drive.curve}' is not one of: ${DIAL_CURVES.join(', ')}`);
      }
      const hasTo = Array.isArray(drive.to) && drive.to.length === 2 && drive.to.every(Number.isFinite);
      if (!hasTo) {
        fail(id, `drives '${paramKey}': to must be [min, max]`);
        continue;
      }
      const [dMin, dMax] = drive.to;
      if (dMin > dMax) fail(id, `drives '${paramKey}': to[0]=${dMin} is greater than to[1]=${dMax}`);
      if (typeof paramDecl.min === 'number' && dMin < paramDecl.min) {
        fail(id, `drives '${paramKey}': to[0]=${dMin} is below the param's own declared min=${paramDecl.min}`);
      }
      if (typeof paramDecl.max === 'number' && dMax > paramDecl.max) {
        fail(id, `drives '${paramKey}': to[1]=${dMax} is above the param's own declared max=${paramDecl.max}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Bisection inverse of a monotonic [0,1]->[0,1] curve — one implementation
 * for all four `DIAL_CURVE_FNS` rather than four hand-derived closed-form
 * inverses (smoothstep's cubic has no clean one). 22 iterations resolves
 * `t` to better than 1e-6, far past what a slider's own pixel resolution
 * could ever show, at a cost of 22 comparisons — irrelevant next to a DOM
 * rebuild.
 * @param {(t: number) => number} curveFn
 * @param {number} y - target output, expected in [0,1]
 * @returns {number} t in [0,1] such that curveFn(t) ~= y
 */
function inverseCurve(curveFn, y) {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (curveFn(mid) < y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Resolve a dial's current position into the params it drives, pure.
 * `value` outside `decl.range` is CLAMPED (a dial has no cyclic case to
 * wrap, unlike an angle param) — a slightly-off caller lands on a safe edge
 * value rather than a value outside every drive's own promised `to` window.
 *
 * @param {DialDecl} decl
 * @param {number} value - the dial's raw position, in `decl.range` units.
 * @returns {Record<string, number>} paramKey -> the value to write.
 */
export function resolveDialDrives(decl, value) {
  const [lo, hi] = decl.range;
  const clamped = Math.min(hi, Math.max(lo, Number.isFinite(value) ? value : decl.default));
  const t = hi > lo ? (clamped - lo) / (hi - lo) : 0;
  const out = {};
  for (const [paramKey, drive] of Object.entries(decl.drives ?? {})) {
    const curveFn = DIAL_CURVE_FNS[drive.curve] ?? DIAL_CURVE_FNS.linear;
    const shaped = curveFn(t);
    const [dMin, dMax] = drive.to;
    out[paramKey] = dMin + shaped * (dMax - dMin);
  }
  return out;
}

/**
 * The inverse of {@link resolveDialDrives}: given the CURRENT live param
 * values, estimate where the dial's own slider should sit. There is no
 * ground truth "dial value" stored anywhere — a dial is a computed
 * multi-write, not a second value the effect holds — so this is a genuine
 * approximation, not a lookup. It reads only the FIRST-declared drive
 * (object key order, per `Object.entries`) as the position-defining param;
 * with multiple drives, hand-tuning a NON-primary one via ROH independently
 * of the rest will show a dial position that is exactly true for the
 * primary drive and only approximately representative of the others. That
 * is the honest, deterministic choice — stated here rather than left for a
 * reader to discover by surprise.
 *
 * @param {DialDecl} decl
 * @param {Record<string, unknown>} paramValues - e.g. the effect's live
 *   resolved params (`getValue`-shaped: current values, not defaults).
 * @returns {number} an estimated position in `decl.range` units.
 */
export function dialPositionFromParams(decl, paramValues) {
  const driveEntries = Object.entries(decl.drives ?? {});
  if (driveEntries.length === 0) return decl.default;
  const [primaryKey, primaryDrive] = driveEntries[0];
  const raw = paramValues?.[primaryKey];
  if (!Number.isFinite(raw)) return decl.default;
  const [dMin, dMax] = primaryDrive.to;
  const shapedRaw = dMax > dMin ? (raw - dMin) / (dMax - dMin) : 0;
  const shaped = Math.min(1, Math.max(0, shapedRaw));
  const curveFn = DIAL_CURVE_FNS[primaryDrive.curve] ?? DIAL_CURVE_FNS.linear;
  const t = inverseCurve(curveFn, shaped);
  const [lo, hi] = decl.range;
  return lo + t * (hi - lo);
}
