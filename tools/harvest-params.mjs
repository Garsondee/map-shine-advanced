/**
 * THE V2 EFFECT-PARAMS HARVEST — a REFERENCE for rebuilding, not a schema.
 *
 * ============================================================================
 * WHAT THIS IS, AND THE CORRECTION THAT SHAPED IT (2026-07-17)
 * ============================================================================
 *
 * `legacy/` holds 45 `static getControlSchema()` bodies: ~2,200 authored
 * controls, and — in 17 of them — the author's OWN PROSE explaining what each
 * effect and knob is for. Stage 7 deletes `legacy/`. This script rescues that
 * into `docs/reference/v2-effect-params/` before it goes.
 *
 * **It emits MARKDOWN, deliberately. It used to emit a params-schema-shaped
 * `.js` tree, and that was wrong twice over — the author caught both:**
 *
 * 1. **The values do not survive the rewrite.** `docs/planning/Params.md` §4
 *    claims "every tuned default... `intensity: 1.23` is not a number, it is
 *    taste. The values are the product." That is over-stated, and the author
 *    said so plainly: *"every single effect is going to be rewritten from
 *    scratch... in modern TSL so it's very likely that even using the exact
 *    same settings wouldn't give us the result we want."* Correct — 1.23 was
 *    taste expressed THROUGH V2's specific GLSL math, and that math is being
 *    deleted. The number is not portable. What IS portable is the INTENT:
 *    which knobs existed, what they were for, what they were called.
 *    So: *"only really useful as a reference to the sort of features I'd like
 *    to see eventually."* This script emits exactly that.
 *
 * 2. **The first version harvested the worthless half and binned the
 *    priceless half.** It extracted `help.summary`/`help.glossary` — the
 *    author's own voice, which Params.md §4 itself calls "above all...
 *    Irreplaceable" — into a variable and never wrote it out, while
 *    faithfully preserving the numbers that don't transfer. Exactly inverted.
 *    The prose is now the FIRST thing on every page.
 *
 * A third mistake, worth recording because it is this repo's own disease: the
 * generated tree was originally written into `src/effects/params-harvest/`
 * and imported from `boot.js`, shipping 601K of V2 schemas to every player
 * for data no V3 code read. Why? Because the `graph/reachable-from-boot`
 * ratchet — added two commits earlier, by this same session — flagged the
 * files as unreachable, and wiring them into `boot.js` made the number go
 * down. **A metric was built and then the architecture was bent to satisfy
 * it.** The wall was right; overriding it by making the wrong thing reachable
 * was not. Reference data belongs in `docs/`, and now lives there.
 *
 * ============================================================================
 * WHAT IT PRESERVES
 * ============================================================================
 *
 *   - `help.title` / `help.summary` / `help.glossary` — the author's voice.
 *   - Every control: label, V2 type, range, default, tooltip — as AUTHORED.
 *     No type mapping. The old transform layer (slider→float, colour-space
 *     inference, enum remapping) is deleted: it existed to produce a
 *     `validateParamsSchema`-conformant declaration, and that is not what this
 *     artifact is. A reference should show what V2 actually had.
 *   - The author's own GROUPING (Look / Shimmer / Layer 1…) — good IA, and a
 *     record of which knobs they thought belonged together.
 *   - Authored preset NAMES.
 *   - Cross-reference to the V3 pass that replaces each effect, derived from
 *     `src/graph/passes.js`'s `absorbs` lists — so the index answers the
 *     question a future session actually has ("I'm building post.grade; what
 *     did the 13 effects it replaces do?"), and surfaces any effect NO pass
 *     claims, which is a real gap in the 48→~12 accounting.
 *   - Flags on each control that matters: status readouts, frozen
 *     (`min === max`) deprecated knobs, and shadow-lift fossils (matched via
 *     `shadow/no-lift-no-combine`'s OWN pattern, imported from
 *     verify-structure.mjs so the two can never drift) marked
 *     **do not rebuild**.
 *
 * ============================================================================
 * SAFE EXTRACTION — real, uncontrolled V2 source, not trusted data
 * ============================================================================
 *
 * Each schema body is brace-matched out of `static getControlSchema() {` and
 * evaluated as DATA ONLY inside `node:vm` — no globals, no require, no fs, no
 * network. Free variables are resolved iteratively against the owning file
 * then the whole `legacy/` tree, ordered by a real topological sort. Five real
 * extraction bugs were found and fixed against real data doing this; the
 * comments on each function record which.
 *
 * Usage: `node tools/harvest-params.mjs` — regenerates
 * `docs/reference/v2-effect-params/`. Output is markdown, so no `npm run
 * format` pass is needed and nothing it writes is linted, tested, or shipped.
 *
 * @module tools/harvest-params
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { RULES } from './verify-structure.mjs';
import { PASSES } from '../src/graph/passes.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LEGACY = join(ROOT, 'legacy');
const OUT_DIR = join(ROOT, 'docs', 'reference', 'v2-effect-params');

/**
 * `LightingEffectV2.dynamicLightShadowOverrideStrength` is the exact fossil
 * `shadow/no-lift-no-combine` (tools/verify-structure.mjs) exists to forbid — V2's
 * "lift" that un-darkens shadows near lights, the wrong-noun disease
 * Light-and-Shadow.md's whole redesign replaces with "every light carries its own
 * visibility term". Found when the old .js-emitting version of this harvest wrote it
 * into `src/` verbatim and `npm run verify` correctly went red.
 *
 * In a markdown reference there is nothing to reject — a reference SHOULD record what
 * V2 had, fossils included; that is the point of a reference. So it is not excluded
 * here, it is **flagged**: the control's row is annotated "do not rebuild", so the
 * next session designing `light.visibility` sees the warning next to the knob rather
 * than rediscovering the trap. The match uses the wall's OWN pattern, imported
 * directly, so the reference and the wall can never disagree about what a fossil is.
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

// ---------------------------------------------------------------------------
// 4. HARVEST one effect — the RAW authored schema, untransformed.
// ---------------------------------------------------------------------------

/**
 * Harvest one effect's authored schema, as V2 wrote it. No type mapping, no
 * normalisation — see this file's header for why the transform layer was
 * deleted. Throws only for something that makes the WHOLE effect
 * unresolvable (surfaced in the run summary, never silently skipped).
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
    // `return getSpecularControlSchema();` — the real body lives in a SIBLING
    // file, found by its exported function name.
    const dir = file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')));
    let found = null;
    for (const cand of allFiles(dir).filter((f) => f !== file)) {
      const candSrc = readFileSync(cand, 'utf8');
      if (new RegExp(`function\\s+${delegate[1]}\\s*\\(`).test(candSrc)) {
        found = { path: cand, src: candSrc };
        break;
      }
    }
    if (!found) throw new Error(`${className}: delegate '${delegate[1]}' not found beside ${file}`);
    const fnBody = findMethodBody(found.src, new RegExp(`function\\s+${delegate[1]}\\s*\\(\\s*\\)`));
    if (!fnBody) throw new Error(`${className}: could not locate delegate function body`);
    evalBodySrc = found.src.slice(fnBody.bodyStart, fnBody.bodyEnd);
    evalSrc = found.src;
  }

  const raw = safeEvalFunctionBody(evalBodySrc, evalSrc, legacyFiles, className);
  if (!raw || typeof raw !== 'object') throw new Error(`${className}: schema did not evaluate to an object`);

  const params = raw.parameters && typeof raw.parameters === 'object' ? raw.parameters : {};
  return {
    className,
    slug: slugify(className),
    file: relative(ROOT, file).split('\\').join('/'),
    help: raw.help ?? null, // THE point of this harvest — see the header.
    groups: Array.isArray(raw.groups) ? raw.groups : [],
    params,
    presets: raw.presets && typeof raw.presets === 'object' ? Object.keys(raw.presets) : [],
    paramCount: Object.keys(params).length,
  };
}

// ---------------------------------------------------------------------------
// 5. RENDER the reference documents.
// ---------------------------------------------------------------------------

/** V2 class name -> the V3 pass(es) that declare it in `absorbs`. */
function buildAbsorbIndex() {
  const index = new Map();
  for (const p of PASSES) {
    for (const a of p.absorbs) {
      // `absorbs` entries carry qualifiers: 'FireEffectV2(sim)', 'WeatherParticles(draw)'.
      const bare = a.replace(/\(.*\)$/, '').trim();
      if (!index.has(bare)) index.set(bare, []);
      index.get(bare).push(p.id + (a.includes('(') ? ` ${a.slice(a.indexOf('('))}` : ''));
    }
  }
  return index;
}

const md = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');

/** One param, as V2 authored it — for the reference table. */
function describeParam(id, p) {
  if (!p || typeof p !== 'object') return null;
  const type = p.type ?? '(inferred)';
  let range = '';
  if (p.min !== undefined || p.max !== undefined) range = `${p.min ?? '?'} … ${p.max ?? '?'}`;
  if (p.options) {
    const labels = Array.isArray(p.options) ? p.options : Object.keys(p.options);
    range = labels.join(' / ');
  }
  let def = p.default;
  if (def && typeof def === 'object') def = Array.isArray(def) ? `(${def.length} points)` : JSON.stringify(def);
  const notes = [];
  if (p.readonly) notes.push('**readout, not a knob**');
  if (p.hidden) notes.push('hidden');
  if (p.min !== undefined && p.min === p.max) notes.push('**frozen (min===max)**');
  if (SHADOW_LIFT_RULE?.pattern.test(id)) {
    notes.push('**shadow-lift fossil — do not rebuild** (`shadow/no-lift-no-combine`)');
  }
  return {
    id,
    label: p.label ?? id,
    type,
    range,
    def: def === undefined ? '' : String(def),
    tooltip: p.tooltip ?? p.description ?? '',
    notes: notes.join(', '),
  };
}

const DO_NOT_PORT =
  '> **Reference only — do not port these values.** Every effect is being rebuilt from scratch in TSL; ' +
  "the numbers below were tuned against V2's GLSL math, which is being deleted, so the same settings would " +
  'not give the same result. What survives the rewrite is the INTENT: which knobs existed, what they were ' +
  'for, and what they were called. That is what this page is for.';

function renderEffectDoc(r, absorbIndex) {
  const L = [];
  const passes = absorbIndex.get(r.className) ?? [];
  const title = r.help?.title || r.className;

  L.push(`# ${title}`);
  L.push('');
  L.push(`**V2 class:** \`${r.className}\` · **Source:** \`${r.file}\``);
  L.push('');
  const rebuiltAs = passes.length
    ? passes.map((p) => `\`${p}\``).join(', ')
    : '**no V3 pass claims this** — either a deliberate drop, or a gap in `passes.js`’s `absorbs` accounting';
  L.push(`**Rebuilt in V3 as:** ${rebuiltAs}`);
  L.push('');
  L.push(DO_NOT_PORT);
  L.push('');

  if (r.help?.summary) {
    L.push("## What it did, in the author's words");
    L.push('');
    L.push(String(r.help.summary));
    L.push('');
  }

  if (r.help?.glossary && Object.keys(r.help.glossary).length) {
    L.push("## The knobs, in the author's words");
    L.push('');
    for (const [k, v] of Object.entries(r.help.glossary)) L.push(`- **${k}** — ${v}`);
    L.push('');
  }

  if (r.presets.length) {
    L.push('## Authored presets');
    L.push('');
    L.push(r.presets.map((p) => `\`${p}\``).join(' · '));
    L.push('');
  }

  const byId = new Map();
  for (const [id, p] of Object.entries(r.params)) {
    const d = describeParam(id, p);
    if (d) byId.set(id, d);
  }

  const HEAD = ['| Control | id | Type | Range | Default | Notes |', '|---|---|---|---|---|---|'];
  const row = (d) => `| ${md(d.label)} | \`${d.id}\` | ${md(d.type)} | ${md(d.range)} | ${md(d.def)} | ${d.notes} |`;
  const tip = (d) => (d.tooltip ? `| | | | | | _${md(d.tooltip)}_ |` : null);

  const grouped = new Set();
  const realGroups = r.groups.filter((g) => Array.isArray(g?.parameters) && g.parameters.length);
  if (realGroups.length) {
    L.push('## Controls, grouped as the author grouped them');
    L.push('');
    for (const g of realGroups) {
      const rows = g.parameters.map((id) => byId.get(id)).filter(Boolean);
      if (!rows.length) continue;
      L.push(`### ${g.label ?? g.name}${g.advanced ? ' _(advanced)_' : ''}`);
      L.push('');
      L.push(...HEAD);
      for (const d of rows) {
        grouped.add(d.id);
        L.push(row(d));
        const t = tip(d);
        if (t) L.push(t);
      }
      L.push('');
    }
  }

  const ungrouped = [...byId.values()].filter((d) => !grouped.has(d.id));
  if (ungrouped.length) {
    L.push(realGroups.length ? '### Ungrouped' : '## Controls');
    L.push('');
    L.push(...HEAD);
    for (const d of ungrouped) {
      L.push(row(d));
      const t = tip(d);
      if (t) L.push(t);
    }
    L.push('');
  }

  return L.join('\n');
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

  const absorbIndex = buildAbsorbIndex();
  for (const r of results) writeFileSync(join(OUT_DIR, `${r.slug}.md`), renderEffectDoc(r, absorbIndex));

  // The index, grouped BY V3 PASS — the question a future session actually
  // asks is "I'm building post.grade; what did the 13 effects it replaces
  // do?", not "tell me about AsciiEffectV2".
  const byPass = new Map();
  const orphans = [];
  for (const r of results) {
    const passes = absorbIndex.get(r.className);
    if (!passes?.length) orphans.push(r);
    else {
      for (const p of passes) {
        const key = p.split(' ')[0];
        if (!byPass.has(key)) byPass.set(key, []);
        byPass.get(key).push(r);
      }
    }
  }

  const withProse = results.filter((r) => r.help?.summary || r.help?.glossary).length;
  const totalParams = results.reduce((n, r) => n + r.paramCount, 0);

  const I = [];
  I.push('# V2 effect parameters — a reference, not a schema');
  I.push('');
  I.push(
    `Machine-harvested from \`legacy/\` by \`tools/harvest-params.mjs\` on 2026-07-17: **${results.length} effects, ` +
      `${totalParams} controls, ${withProse} carrying the author's own prose.**`
  );
  I.push('');
  I.push(
    '> **Do not port these values.** Every effect is being rebuilt from scratch in TSL (author, 2026-07-17: ' +
      '*"it\'s very likely that even using the exact same settings wouldn\'t give us the result we want"*). ' +
      "These numbers were tuned against V2's GLSL math, which is being deleted with `legacy/` at Stage 7. " +
      'What survives a rewrite is **which knobs existed, what they were for, and what they were called** — a ' +
      "feature wishlist and a design vocabulary, in the author's own voice. That is the whole value here."
  );
  I.push('');
  I.push('## By the V3 pass that replaces them');
  I.push('');
  I.push("Cross-referenced against `src/graph/passes.js`'s `absorbs` declarations.");
  I.push('');
  for (const [pass, rs] of [...byPass.entries()].sort()) {
    I.push(`### \`${pass}\``);
    I.push('');
    for (const r of rs.sort((a, b) => a.className.localeCompare(b.className))) {
      I.push(`- [${r.help?.title || r.className}](${r.slug}.md) — \`${r.className}\`, ${r.paramCount} controls`);
    }
    I.push('');
  }
  if (orphans.length) {
    I.push('### Claimed by no V3 pass');
    I.push('');
    I.push("Either a deliberate drop, or a gap in `passes.js`'s absorb accounting — worth a look before Stage 7.");
    I.push('');
    for (const r of orphans) {
      I.push(`- [${r.help?.title || r.className}](${r.slug}.md) — \`${r.className}\`, ${r.paramCount} controls`);
    }
    I.push('');
  }
  writeFileSync(join(OUT_DIR, 'README.md'), I.join('\n'));

  const rel = relative(ROOT, OUT_DIR).split('\\').join('/');
  console.log(`Wrote ${results.length} reference docs + an index to ${rel}/`);
  console.log(`  ${totalParams} controls documented`);
  console.log(`  ${withProse} effects carry the author's own summary/glossary prose (the irreplaceable part)`);
  console.log(`  ${orphans.length} effects are claimed by NO V3 pass (see the index's warning section)`);
  if (failures.length) {
    console.log(`\n${failures.length} effects FAILED entirely:`);
    for (const f of failures) console.log(`  ${f.className} (${f.file}): ${f.error}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
