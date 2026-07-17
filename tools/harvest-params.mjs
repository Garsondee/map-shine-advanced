/**
 * THE PARAMS HARVEST — extract V2's 47 `getControlSchema()` bodies into real
 * `core/params-schema.js` declarations, before Stage 7 deletes `legacy/`.
 *
 * ============================================================================
 * WHY THIS EXISTS (docs/planning/Params.md §4, §6 build order item 2)
 * ============================================================================
 *
 * `core/params-schema.js`'s contract was designed and Node-tested against a
 * sample of one effect, then validated against the REAL field vocabulary of
 * all 47 schemas (Params.md §3.6) — three gaps found and fixed there. This
 * script is the harvest itself: what Params.md §4 calls "irreplaceable" —
 * 47 effects' worth of types, ranges, tuned defaults, and help text **in the
 * author's own voice** ("World scale: how large world-space shimmer patterns
 * are — higher = bigger, calmer glint clusters"). None of it is design work;
 * it is GENERATION from real source, which is why it is a script and not
 * 47 hand-authored files (Skeleton.md §0 law 2 — generate, never hand-write,
 * applied to the harvest itself).
 *
 * Measured before writing this (2026-07-17): 47 files, 11,922 lines of
 * `getControlSchema()` body, ~1,850 individual param declarations. Manual
 * transcription at that scale is where transcription errors live; extraction
 * + a mechanical transform table, validated against `validateParamsSchema`
 * for every single output, is the only way to do this faithfully.
 *
 * ============================================================================
 * THE REAL FIELD VOCABULARY (surveyed before writing the transform table)
 * ============================================================================
 *
 * Per-param `type` values found in the wild, and what they become:
 *   slider            → 'float' or 'int' (int iff min/max/step/default are ALL
 *                        integers AND step is a whole number ≥ 1 — sliders are
 *                        overwhelmingly float; this only fires for genuine
 *                        integer controls, e.g. a particle count)
 *   boolean, checkbox  → 'bool'
 *   color              → 'color', with REQUIRED space: colorType==='float' ?
 *                        'linear' : 'srgb' (Params.md §3.6 finding #1)
 *   list, dropdown,
 *   select             → 'enum'. `options` is a LABEL→VALUE map object here
 *                        (e.g. { 'Coal Bed': 'coal' }), not an array — found by
 *                        inspecting real data before writing this, not assumed.
 *                        `values` becomes Object.values(options); the labels
 *                        are preserved too (see valueLabels below), because
 *                        losing "Coal Bed" for "coal" is exactly the kind of
 *                        loss Params.md §4 calls irreplaceable.
 *   string             → readonly:true → EXCLUDED (a status readout, not a
 *                        param — Params.md §3.6 finding #2); has `options` →
 *                        'enum' (finding #3's "*Selection" case); else 'text'.
 *   gradient           → 'curve' (colour-over-life control points {t,r,g,b};
 *                        `curve`'s own validator only checks "array, length
 *                        >= 2" — point SHAPE is the consumer's business, so a
 *                        gradient's richer points pass unmodified)
 *   button             → 'action'
 *   folder, inline      → NOT param types at all. Confirmed by inspecting real
 *                        data: both appear ONLY inside `groups: [...]` array
 *                        entries as UI layout metadata (which folder a param
 *                        lives in, expanded/advanced/separator hints) — never
 *                        as a real parameter's own `type`. Preserved as
 *                        `groups` sibling data, never merged into a param
 *                        declaration (params/no-ui-in-contract's whole point).
 *
 * Dropped per param (UI/view-state, forbidden in the contract — Params.md §2,
 * `FORBIDDEN_IN_CONTRACT`): `hidden`, `presetApplyDefaults`, `advanced`,
 * `expanded`, `throttle`, `folder`, `widget`, `colorType` (replaced by `space`).
 *
 * ============================================================================
 * SAFE EXTRACTION — this is real, uncontrolled V2 source, not trusted data
 * ============================================================================
 *
 * Each schema body is (1) located by brace-matching from
 * `static getControlSchema() {`, (2) reduced to its `return <expr>;`, then
 * (3) evaluated as DATA ONLY inside `node:vm`, with no globals, no `require`,
 * no filesystem, no network — these are meant to be pure object literals, and
 * a schema that turns out not to be (a getter with side effects, a computed
 * property calling into `this`) is a bug in this SCRIPT to catch loudly, not
 * a reason to broaden what gets executed.
 *
 * Some schemas reference file-level constants the class body doesn't inline
 * (e.g. `options: easingOptions`). Resolved by an ITERATIVE retry: eval, catch
 * the ReferenceError, locate `const <name> = ...`/`function <name>(...)` for
 * that exact identifier earlier in the SAME source file, splice its source in
 * ahead of the schema, retry — up to a bounded number of rounds. A schema that
 * still won't resolve is reported and skipped, never guessed at.
 *
 * Usage: `node tools/harvest-params.mjs` (regenerates every file under
 * `src/effects/params-harvest/`), then `npm run format` — the generator's
 * `JSON.stringify(..., null, 2)` output is valid but not Prettier-shaped, so
 * every re-run needs one format pass before `npm run verify` is clean.
 * `src/effects/params-harvest-health.js` is hand-written and lives OUTSIDE
 * this directory on purpose (see its own header) — nothing here should ever
 * write there.
 *
 * @module tools/harvest-params
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { RULES } from './verify-structure.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LEGACY = join(ROOT, 'legacy');
const OUT_DIR = join(ROOT, 'src', 'effects', 'params-harvest');

/**
 * Found live, the FIRST time this harvest ran against real data: LightingEffectV2's
 * `dynamicLightShadowOverrideStrength` is the exact fossil `shadow/no-lift-no-combine`
 * (tools/verify-structure.mjs) exists to forbid — V2's "lift" that un-darkens shadows
 * near lights, the wrong-noun disease Light-and-Shadow.md's whole redesign replaces
 * with "every light carries its own visibility term". `npm run verify` correctly
 * rejected it once harvested verbatim.
 *
 * The fix is NOT to widen that wall's allow-list (reopening exactly the relapse path
 * it exists to close) and NOT to silently rename/drop it from the archive (this
 * harvest's whole point is faithful preservation — editing it defeats that). Instead:
 * exclude it from the DECLARED schema, honestly, the same way a status readout or a
 * locked/deprecated param is excluded — reported by name in the generated file's
 * header, not silently vanished. And rather than hand-listing fossil names here
 * (which would drift from the wall the moment someone extends it), the exclusion
 * criterion IS the wall's own pattern, imported directly: whatever
 * `shadow/no-lift-no-combine` forbids in the codebase is, by definition, not
 * something this harvest should carry into a schema declaration either.
 */
const SHADOW_LIFT_RULE = RULES.find((r) => r.id === 'shadow/no-lift-no-combine');
// Real, measured depth (2026-07-17): BushEffectV2/TreeEffectV2's `groups`
// pull in a genuine chain 12+ deep (mask-status -> effect-mask-registry ->
// per-effect vegetation shadow/lightning schemas -> ... -> the leaf constant).
// Every round in that chain resolved successfully when traced by hand — it is
// deep, not broken. Generous headroom rather than a tight cap that reads a
// legitimate deep chain as a failure.
const MAX_RESOLVE_ROUNDS = 60;

// ---------------------------------------------------------------------------
// 1. FIND every file that defines a real static getControlSchema().
// ---------------------------------------------------------------------------

function allFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) allFiles(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Brace-match from just after `{` to find a balanced body's end index. */
function matchBrace(src, openIndex) {
  let depth = 1;
  let i = openIndex + 1;
  while (depth > 0 && i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return i; // index just past the matching close brace
}

/**
 * @param {string} src
 * @returns {{bodyStart: number, bodyEnd: number}|null} the method body's span
 *   (between its outer braces), or null if not found.
 */
function findMethodBody(src, methodPattern) {
  const m = methodPattern.exec(src);
  if (!m) return null;
  // Skip the PARAMETER LIST before hunting for the body's opening brace.
  // Found live: `function makeTextureOptions(names, { includeNone = false,
  // includeAuto = true } = {}) {` — a destructured-default parameter carries
  // its OWN `{`, and `indexOf('{', ...)` from just past the function name
  // grabbed that one instead of the real body, truncating everything into a
  // syntactically broken fragment ("Unexpected token 'const'" downstream,
  // once the mangled text was spliced into an eval prelude). If the match
  // ends mid-parameter-list (an open, unclosed `(`), paren-balance it first.
  let searchFrom = m.index + m[0].length - 1;
  if (src[searchFrom] === '(') {
    let depth = 1;
    let i = searchFrom + 1;
    while (depth > 0 && i < src.length) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    searchFrom = i;
  }
  const openIdx = src.indexOf('{', searchFrom);
  if (openIdx === -1) return null;
  const end = matchBrace(src, openIdx);
  return { bodyStart: openIdx + 1, bodyEnd: end - 1 };
}

// ---------------------------------------------------------------------------
// 2. RESOLVE a schema expression's free variables against its own file.
// ---------------------------------------------------------------------------

/** Find `const NAME = ...;` / `function NAME(...) {...}` / `let NAME = ...;` for an exact identifier in `src`. */
function findDeclarationIn(src, name) {
  const patterns = [
    new RegExp(`\\bexport\\s+const\\s+${name}\\s*=`),
    new RegExp(`\\bconst\\s+${name}\\s*=`),
    new RegExp(`\\blet\\s+${name}\\s*=`),
    new RegExp(`\\bexport\\s+function\\s+${name}\\s*\\(`),
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`),
  ];
  for (const pat of patterns) {
    const m = pat.exec(src);
    if (!m) continue;
    if (pat.source.includes('function')) {
      const body = findMethodBody(src, pat);
      if (!body) continue;
      return src.slice(m.index, body.bodyEnd + 1).replace(/^export\s+/, '') + '\n';
    }
    // const/let: find the statement's terminating semicolon at depth 0,
    // tolerating nested {}/[]/() in the initializer.
    let i = m.index + m[0].length;
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if ('{[('.includes(c)) depth++;
      else if ('}])'.includes(c)) depth--;
      else if (c === ';' && depth === 0) {
        i++;
        break;
      }
      i++;
    }
    return src.slice(m.index, i).replace(/^export\s+/, '') + '\n';
  }
  return null;
}

/**
 * A few schemas build their `groups` array by CALLING a shared UI helper
 * (`createMaskStatusSchemaGroup(s)`, `legacy/ui/effect-mask-status.js`) that
 * itself pulls in further dependencies (`getMaskStatusTemplate`, ...) — real
 * code, but its OWN return value is confirmed (read its source) to always be
 * `{ ..., parameters: [] }`: it is GROUP LAYOUT METADATA, never a source of
 * real params. `groups` is carried as informational sibling data in this
 * harvest and never validated by `validateParamsSchema` — so a faithful stub
 * (same shape, empty parameters) is exactly as useful as the real function
 * here, and avoids pulling an unrelated dependency graph into this script's
 * trust boundary for data this harvest does not use.
 */
const STUBBED_HELPERS = {
  createMaskStatusSchemaGroup: `function createMaskStatusSchemaGroup(maskId) { return { name: 'mask-status-' + maskId, type: 'mask-status', parameters: [] }; }\n`,
  createMaskStatusSchemaGroups: `function createMaskStatusSchemaGroups(maskIds) { return (maskIds || []).map((id) => ({ name: 'mask-status-' + id, type: 'mask-status', parameters: [] })); }\n`,
};

/**
 * A schema that self-references its OWN class — `WeatherLightningEffectV2.
 * createDefaultParams()`, found live — cannot be resolved by finding "a
 * declaration" the normal way; the whole class would have to be inlined,
 * dragging in Foundry/THREE/rendering code no isolated eval should touch.
 * Instead, synthesize a minimal stub exposing ONLY the static methods the
 * schema body actually calls as `ClassName.method(...)`, each extracted
 * verbatim (real code, just lifted out of the class body it lives in — the
 * confirmed case, `createDefaultParams()`, is a pure literal-returning
 * static method with no further `this`/class references).
 */
function buildSelfClassStub(className, fileSrc, bodySrc) {
  const calls = new Set();
  const callRe = new RegExp(`\\b${className}\\.(\\w+)\\s*\\(`, 'g');
  let m;
  while ((m = callRe.exec(bodySrc))) calls.add(m[1]);
  if (calls.size === 0) return null;

  const methodTexts = [];
  for (const method of calls) {
    const body = findMethodBody(fileSrc, new RegExp(`\\bstatic\\s+${method}\\s*\\(\\s*\\)`));
    if (!body) return null; // partial stub would be worse than none — surface the real error
    methodTexts.push(`${method}() { ${fileSrc.slice(body.bodyStart, body.bodyEnd)} }`);
  }
  return `const ${className} = { ${methodTexts.join(', ')} };\n`;
}

/**
 * Locate NAME's declaration: same file first, then EVERY other file under
 * legacy/ (a real cross-module import, e.g. `TWILIGHT_AMBIENT_DEFAULTS` from
 * `ambient-compose-cpu.js` — a genuine data constant that DOES matter for
 * real default values, unlike the stubbed UI helpers above).
 */
function findDeclarationAnywhere(name, fileSrc, legacyFiles, className, bodySrc) {
  if (STUBBED_HELPERS[name]) return STUBBED_HELPERS[name];
  if (name === className) {
    const selfStub = buildSelfClassStub(className, fileSrc, bodySrc);
    if (selfStub) return selfStub;
  }
  const local = findDeclarationIn(fileSrc, name);
  if (local) return local;
  for (const f of legacyFiles) {
    const src = readFileSync(f, 'utf8');
    const found = findDeclarationIn(src, name);
    if (found) return found;
  }
  return null;
}

/**
 * Evaluate a method BODY (every statement, ending in `return <expr>;`) as
 * pure data. Deliberately the WHOLE body, not just the return expression —
 * several real schemas build local consts (`const timelineGroups = [];`)
 * before returning, and extracting only "the text after the word return"
 * broke on those (found live: "Unexpected token 'return'"/"';'" on the first
 * run against real data). Free variables are resolved iteratively against the
 * owning file, then the whole legacy/ tree. Throws with a clear reason if
 * unresolvable within MAX_RESOLVE_ROUNDS — never silently guesses.
 */
/**
 * Order a set of injected declarations so every one comes AFTER everything it
 * references — a real topological sort, not a heuristic.
 *
 * Found live (BushEffectV2/TreeEffectV2, a 15-round chain): simple "prepend
 * the newest" ordering — which correctly fixed a straight linear chain
 * (ColorCorrectionEffectV2's DEFAULT_TOD_ANCHORS -> makeTodAnchor ->
 * makeTodGrade) — breaks the moment ONE declaration has TWO dependencies
 * discovered in DIFFERENT rounds: `VEGETATION_CLUMP_FIELD_CONTROL_SCHEMA`
 * needs both `CLUMP_ID_DEBUG_MODE` (found round 12) AND
 * `CLUMP_ID_DEBUG_DROPDOWN_OPTIONS` (found round 13) — and
 * DROPDOWN_OPTIONS's OWN declaration ALSO references CLUMP_ID_DEBUG_MODE.
 * Prepending round 13's find pushed it in FRONT of round 12's, so
 * DROPDOWN_OPTIONS ran before CLUMP_ID_DEBUG_MODE existed — a `const` TDZ
 * error ("Cannot access ... before initialization"), not a plain
 * ReferenceError, so the retry loop's name-match stopped firing and the
 * chain silently could not converge. A real topo sort has no such blind spot
 * — declaration ORDER never depends on DISCOVERY order.
 *
 * @param {Map<string, string>} declarations - name -> its declaration text
 * @returns {string} declarations concatenated in dependency-safe order
 */
function topoSortDeclarations(declarations) {
  const names = [...declarations.keys()];
  const visited = new Set();
  const visiting = new Set();
  const out = [];

  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`circular dependency involving '${name}'`);
    visiting.add(name);
    const text = declarations.get(name);
    for (const other of names) {
      if (other === name) continue;
      if (new RegExp(`\\b${other}\\b`).test(text)) visit(other);
    }
    visiting.delete(name);
    visited.add(name);
    out.push(name);
  }
  for (const name of names) visit(name);
  return out.map((n) => declarations.get(n)).join('');
}

function safeEvalFunctionBody(bodySrc, fileSrc, legacyFiles, className) {
  const declarations = new Map();
  for (let round = 0; round < MAX_RESOLVE_ROUNDS; round++) {
    const prelude = topoSortDeclarations(declarations);
    try {
      const context = vm.createContext({});
      const script = new vm.Script(`(function(){ ${prelude}\n${bodySrc}\n})()`);
      return script.runInContext(context, { timeout: 2000 });
    } catch (err) {
      const m = /^(\w+) is not defined$/.exec(err.message);
      if (!m || declarations.has(m[1])) throw err; // unresolvable, or a real bug — surface it
      const decl = findDeclarationAnywhere(m[1], fileSrc, legacyFiles, className, bodySrc);
      if (!decl)
        throw new Error(`could not locate a declaration for '${m[1]}' anywhere under legacy/ (${err.message})`);
      declarations.set(m[1], decl); // ORDER decided fresh next round by topoSortDeclarations, not insertion order
    }
  }
  throw new Error(`exceeded ${MAX_RESOLVE_ROUNDS} dependency-resolution rounds`);
}

// ---------------------------------------------------------------------------
// 3. TRANSFORM a raw V2 param declaration into the new PARAM_TYPES contract.
// ---------------------------------------------------------------------------

const isIntLike = (n) => Number.isFinite(n) && Number.isInteger(n);

/**
 * @param {string} id
 * @param {object} raw - the V2 param object
 * @returns {{decl: object|null, excludedAsReadout: boolean, excludedAsLocked: boolean, excludedAsSupersededFossil: boolean, reason: string|null}}
 */
export function transformParam(id, raw) {
  const none = { excludedAsReadout: false, excludedAsLocked: false, excludedAsSupersededFossil: false };
  if (!raw || typeof raw !== 'object') return { decl: null, ...none, reason: 'not an object' };

  // A superseded V2 mechanism (see this file's header note on
  // dynamicLightShadowOverrideStrength) — checked FIRST, ahead of every other
  // rule, using the wall's OWN pattern rather than a hand-kept name list.
  if (SHADOW_LIFT_RULE && SHADOW_LIFT_RULE.pattern.test(id)) {
    return { decl: null, ...none, excludedAsSupersededFossil: true, reason: null };
  }

  // Finding #2 (Params.md §3.6): readonly is a status readout, not a param.
  if (raw.readonly === true) return { decl: null, ...none, excludedAsReadout: true, reason: null };

  const help = raw.tooltip ?? raw.help ?? raw.description;
  const base = { label: raw.label ?? id };
  if (typeof help === 'string' && help.length > 0) base.help = help;

  // A SECOND real convention, found live (legacy/core/WeatherController.js,
  // legacy/scene/grid-renderer.js): `type` is OMITTED entirely and the
  // consuming UI inferred it from which OTHER fields were present — `options`
  // implies a select, a boolean `default` implies a checkbox, numeric
  // min/max/step/default implies a slider. Same inference here, done once,
  // rather than propagating "type is optional" into the new contract (where
  // `type` is REQUIRED — validateParamsSchema rejects its absence outright).
  let effectiveType = raw.type;
  if (effectiveType === undefined) {
    if (raw.options) effectiveType = 'select';
    else if (typeof raw.default === 'boolean') effectiveType = 'boolean';
    else if ([raw.default, raw.min, raw.max, raw.step].some((x) => typeof x === 'number')) effectiveType = 'slider';
    else if (typeof raw.default === 'string') effectiveType = 'string';
  }

  const ok = (decl) => ({ decl, ...none, reason: null });
  const skip = (reason) => ({ decl: null, ...none, reason });
  const locked = () => ({ decl: null, ...none, excludedAsLocked: true, reason: null });

  /**
   * Build an enum's {values, valueLabels} from a raw V2 `options` map
   * (label -> value, e.g. `{ 'Coal Bed': 'coal' }` — real data, surveyed
   * 2026-07-17; sometimes a flat array too) and remap `rawDefault` into
   * VALUE space if it was authored in LABEL space instead.
   *
   * Found live (ContextualSceneGradeEffectV2's 4 easing params): the schema
   * declared `options: { '': '(global)', linear: 'linear', ... }` — an empty
   * LABEL for the "(global)" VALUE — and then set `default: ''`, i.e. the
   * LABEL, not any value the enum actually declares. `values` never contains
   * `''`; it contains `'(global)'`. A real V2 authoring inconsistency
   * (validateParamsSchema's own "a declaration whose own default needs
   * clamping is self-inconsistent" check exists for exactly this shape,
   * just for numbers) — remapped here rather than silently kept broken or
   * silently discarded.
   */
  function buildEnum(opts, rawDefault) {
    const entries = Array.isArray(opts) ? opts.map((v) => [String(v), v]) : Object.entries(opts);
    const values = entries.map(([, v]) => v);
    const valueLabels = Object.fromEntries(entries.map(([label, v]) => [String(v), label]));
    let def = rawDefault ?? values[0];
    if (!values.includes(def)) {
      const byLabel = entries.find(([label]) => label === String(rawDefault));
      def = byLabel ? byLabel[1] : values[0];
    }
    return { values, valueLabels, default: def };
  }

  switch (effectiveType) {
    case 'slider': {
      // A zero-width range (min === max) is not a tunable contract — it can
      // never actually vary. Found live (LightingEffectV2.composeToneExposure,
      // min:1 max:1): the source literally marks it `hidden: true` with
      // tooltip "Deprecated: forced to 1.0." — a locked, retired control kept
      // only for back-compat. Distinct from `readonly` (a computed DISPLAY
      // value) — this is a real writable param that authoring chose to
      // freeze, so it gets its own excluded bucket rather than being
      // mislabeled a "status readout" in the harvest report.
      if (raw.min !== undefined && raw.max !== undefined && Number(raw.min) === Number(raw.max)) return locked();
      const nums = [raw.min, raw.max, raw.step, raw.default].filter((x) => x !== undefined);
      const type =
        nums.length > 0 && nums.every(isIntLike) && Number.isFinite(raw.step) && raw.step >= 1 ? 'int' : 'float';
      return ok({
        type,
        default: Number(raw.default ?? 0),
        min: Number(raw.min ?? 0),
        max: Number(raw.max ?? 1),
        ...(raw.step !== undefined ? { step: Number(raw.step) } : {}),
        ...base,
      });
    }
    case 'boolean':
    case 'checkbox':
      return ok({ type: 'bool', default: Boolean(raw.default), ...base });
    case 'color': {
      const space = raw.colorType === 'float' ? 'linear' : 'srgb';
      let hex = raw.default;
      if (hex && typeof hex === 'object' && 'r' in hex) {
        // A {r,g,b} 0..1 object, harvested to the ONE storage shape (#rrggbb).
        const c = (x) =>
          Math.round(Math.min(1, Math.max(0, Number(x) || 0)) * 255)
            .toString(16)
            .padStart(2, '0');
        hex = `#${c(hex.r)}${c(hex.g)}${c(hex.b)}`;
      }
      if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) hex = '#ffffff';
      return ok({ type: 'color', default: hex.toLowerCase(), space, ...base });
    }
    case 'list':
    case 'dropdown':
    case 'select': {
      if (!raw.options) return skip('enum-like param with no options');
      const { values, valueLabels, default: def } = buildEnum(raw.options, raw.default);
      return ok({ type: 'enum', default: def, values, valueLabels, ...base });
    }
    case 'string': {
      if (raw.options) {
        const { values, valueLabels, default: def } = buildEnum(raw.options, raw.default);
        return ok({ type: 'enum', default: def, values, valueLabels, ...base });
      }
      return ok({ type: 'text', default: String(raw.default ?? ''), ...base });
    }
    case 'gradient':
      if (!Array.isArray(raw.default) || raw.default.length < 2)
        return skip('gradient default has fewer than 2 control points');
      return ok({ type: 'curve', default: raw.default, ...base });
    case 'button':
      return ok({ type: 'action', ...base });
    default:
      return skip(
        `unhandled V2 type '${raw.type}' (inferred '${effectiveType}') — fields present: ${Object.keys(raw).join(',')}`
      );
  }
}

// ---------------------------------------------------------------------------
// 4. DRIVE the harvest across all 47 files.
// ---------------------------------------------------------------------------

const METHOD_PATTERN = /static\s+getControlSchema\s*\(\s*\)\s*\{/;
const DELEGATE_PATTERN = /return\s+(get\w+ControlSchema)\s*\(\s*\)\s*;/;

function slugify(className) {
  return className
    .replace(/V2$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * The class OWNING a given source position — the nearest real `class NAME {`
 * (or `class NAME extends X {`) opening BEFORE it, not just the first class
 * declaration in the file. Found live: a naive `/class\s+(\w+)/` picked up
 * "class with" out of an English sentence in a JSDoc comment on one file,
 * naming an effect "with". Anchored to require a capitalized identifier
 * immediately followed by `{` or `extends`, which prose does not produce.
 */
function ownerClassName(src, beforeIndex) {
  const CLASS_RE = /\bclass\s+([A-Z]\w*)\s*(?:extends\s+\w+\s*)?\{/g;
  let m;
  let last = null;
  while ((m = CLASS_RE.exec(src)) && m.index < beforeIndex) last = m[1];
  return last;
}

/** @returns {{className: string, file: string}[]} */
function discoverSchemaFiles() {
  const out = [];
  for (const file of allFiles(LEGACY)) {
    const src = readFileSync(file, 'utf8');
    const m = METHOD_PATTERN.exec(src);
    if (!m) continue;
    const className = ownerClassName(src, m.index) ?? file.split(/[\\/]/).pop().replace(/\.js$/, '');
    out.push({ className, file });
  }
  return out.sort((a, b) => a.className.localeCompare(b.className));
}

/**
 * Harvest one effect. Returns a report; never throws for a single bad param —
 * only for something that makes the WHOLE effect unresolvable (surfaced, not
 * silently skipped from the run's summary).
 */
export function harvestOne({ className, file }, legacyFiles) {
  const src = readFileSync(file, 'utf8');
  const body = findMethodBody(src, METHOD_PATTERN);
  if (!body) throw new Error(`${className}: could not locate getControlSchema() body`);
  const bodySrc = src.slice(body.bodyStart, body.bodyEnd);

  const delegate = DELEGATE_PATTERN.exec(bodySrc);
  let evalBodySrc = bodySrc;
  let evalSrc = src;
  if (delegate) {
    // The 3-file pattern: `return getSpecularControlSchema();` — the real
    // body lives in a SIBLING file, found by its exported function name.
    const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
    const candidates = allFiles(dir).filter((f) => f !== file);
    let found = null;
    for (const cand of candidates) {
      const candSrc = readFileSync(cand, 'utf8');
      if (new RegExp(`function\\s+${delegate[1]}\\s*\\(`).test(candSrc)) {
        found = { path: cand, src: candSrc };
        break;
      }
    }
    if (!found) throw new Error(`${className}: delegate '${delegate[1]}' not found in sibling files of ${file}`);
    const fnBody = findMethodBody(found.src, new RegExp(`function\\s+${delegate[1]}\\s*\\(\\s*\\)`));
    if (!fnBody) throw new Error(`${className}: could not locate delegate function body`);
    evalBodySrc = found.src.slice(fnBody.bodyStart, fnBody.bodyEnd);
    evalSrc = found.src;
  }

  // Eval the WHOLE body — not just the return expression. Real schemas build
  // local consts before returning (found live: `const timelineGroups = [];`
  // ahead of `return {...}` broke a naive "everything after the word return"
  // extraction). A function body naturally supports that.
  const raw = safeEvalFunctionBody(evalBodySrc, evalSrc, legacyFiles, className);
  if (!raw || typeof raw !== 'object') throw new Error(`${className}: schema did not evaluate to an object`);

  const rawParams = raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : raw;
  const schema = {};
  const excludedReadouts = [];
  const excludedLocked = [];
  const excludedFossils = [];
  const skipped = [];
  for (const [id, rawParam] of Object.entries(rawParams)) {
    if (id === 'parameters' || id === 'groups' || id === 'help' || id === 'presets' || id === 'presetApplyDefaults')
      continue;
    const { decl, excludedAsReadout, excludedAsLocked, excludedAsSupersededFossil, reason } = transformParam(
      id,
      rawParam
    );
    if (excludedAsSupersededFossil) excludedFossils.push(id);
    else if (excludedAsReadout) excludedReadouts.push(id);
    else if (excludedAsLocked) excludedLocked.push(id);
    else if (decl) schema[id] = decl;
    else skipped.push({ id, reason });
  }

  // GROUPS is informational sibling data (never validated), but a superseded
  // fossil's id lingering in a group's membership list — after the real
  // declaration is gone — would be its own small dishonesty. Strip it there
  // too. readouts/locked stay listed in groups on purpose: those genuinely
  // existed as UI controls, just not ones this contract stores.
  const excludedFossilSet = new Set(excludedFossils);
  const groups = (Array.isArray(raw.groups) ? raw.groups : []).map((g) =>
    Array.isArray(g?.parameters) ? { ...g, parameters: g.parameters.filter((p) => !excludedFossilSet.has(p)) } : g
  );

  return {
    className,
    slug: slugify(className),
    file: relative(ROOT, file).split('\\').join('/'),
    schema,
    groups,
    help: raw.help ?? null,
    excludedReadouts,
    excludedLocked,
    excludedFossils,
    skipped,
    paramCount: Object.keys(schema).length,
  };
}

function main() {
  const targets = discoverSchemaFiles();
  const legacyFiles = allFiles(LEGACY);
  console.log(`Found ${targets.length} getControlSchema() definitions.\n`);

  mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  const failures = [];

  for (const t of targets) {
    try {
      results.push(harvestOne(t, legacyFiles));
    } catch (err) {
      failures.push({ className: t.className, file: t.file, error: err.message });
    }
  }

  for (const r of results) {
    const lines = [];
    lines.push('/**');
    lines.push(` * MACHINE-HARVESTED from ${r.file} (V2 class ${r.className}), 2026-07-17.`);
    lines.push(' * Generated by tools/harvest-params.mjs — see that file for the transform rules.');
    lines.push(' * Do not hand-edit the `SCHEMA`/`GROUPS` exports; re-run the harvest instead.');
    if (r.excludedReadouts.length) {
      lines.push(` *`);
      lines.push(` * Excluded as STATUS READOUTS, not params (Params.md §3.6 finding #2):`);
      lines.push(` *   ${r.excludedReadouts.join(', ')}`);
    }
    if (r.excludedLocked.length) {
      lines.push(` *`);
      lines.push(` * Excluded as LOCKED/DEPRECATED (numeric range with min === max — a real`);
      lines.push(` * writable param the source froze, e.g. "forced to 1.0", not a readout):`);
      lines.push(` *   ${r.excludedLocked.join(', ')}`);
    }
    if (r.excludedFossils.length) {
      lines.push(` *`);
      lines.push(` * Excluded as SUPERSEDED FOSSILS — matches tools/verify-structure.mjs's`);
      lines.push(` * shadow/no-lift-no-combine wall (docs/planning/Light-and-Shadow.md): V2's`);
      lines.push(` * "lift" workaround for the wrong-noun shadow model, replaced by every light`);
      lines.push(` * carrying its own visibility term. Not harvested on purpose, not a gap:`);
      lines.push(` *   ${r.excludedFossils.join(', ')}`);
    }
    if (r.skipped.length) {
      lines.push(` *`);
      lines.push(` * NEEDS MANUAL REVIEW — could not transform automatically:`);
      for (const s of r.skipped) lines.push(` *   ${s.id}: ${s.reason}`);
    }
    lines.push(' */');
    lines.push(`export const SOURCE_CLASS = ${JSON.stringify(r.className)};`);
    lines.push(`export const SOURCE_FILE = ${JSON.stringify(r.file)};`);
    lines.push(`export const GROUPS = ${JSON.stringify(r.groups, null, 2)};`);
    lines.push(`export const SCHEMA = ${JSON.stringify(r.schema, null, 2)};`);
    lines.push('');
    writeFileSync(join(OUT_DIR, `${r.slug}.js`), lines.join('\n'));
  }

  // The manifest — discovered, not hand-listed (tools/run-tests.mjs's own
  // lesson: a hand-kept list is the thing that drifts).
  const manifestLines = [
    '/**',
    " * THE HARVEST MANIFEST — every effect this session's harvest produced.",
    ' * Generated by tools/harvest-params.mjs. Re-run the harvest to regenerate.',
    ' */',
  ];
  for (const r of results) manifestLines.push(`export * as ${r.className} from './${r.slug}.js';`);
  writeFileSync(join(OUT_DIR, 'manifest.js'), manifestLines.join('\n') + '\n');

  console.log(`Harvested ${results.length} effects, ${results.reduce((n, r) => n + r.paramCount, 0)} params total.`);
  const totalReadouts = results.reduce((n, r) => n + r.excludedReadouts.length, 0);
  const totalLocked = results.reduce((n, r) => n + r.excludedLocked.length, 0);
  const totalFossils = results.reduce((n, r) => n + r.excludedFossils.length, 0);
  const totalSkipped = results.reduce((n, r) => n + r.skipped.length, 0);
  if (totalReadouts) console.log(`Excluded ${totalReadouts} status readouts (correct, not a gap).`);
  if (totalLocked) console.log(`Excluded ${totalLocked} locked/deprecated params (min === max — correct, not a gap).`);
  if (totalFossils)
    console.log(
      `Excluded ${totalFossils} superseded shadow-lift fossils (matches shadow/no-lift-no-combine — correct, not a gap).`
    );
  if (totalSkipped) {
    console.log(`\n⚠ ${totalSkipped} params need manual review:`);
    for (const r of results) for (const s of r.skipped) console.log(`  ${r.className}.${s.id}: ${s.reason}`);
  }
  if (failures.length) {
    console.log(`\n❌ ${failures.length} effects FAILED entirely:`);
    for (const f of failures) console.log(`  ${f.className} (${f.file}): ${f.error}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
