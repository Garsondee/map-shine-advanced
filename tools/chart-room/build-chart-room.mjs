/**
 * THE CHART ROOM — the whole module at a glance, DERIVED not modelled.
 *
 * ## Why this file is allowed to exist at all
 *
 * `docs/planning/Health.md` is an autopsy of V2's 4,505-line health system, and
 * its verdict is the law this generator is written under:
 *
 *   > V2's health system was a hand-drawn copy of the module's structure, kept
 *   > beside the real thing, and it drifted.
 *   > The rule: health may not contain a model of the system. It may only read
 *   > the declarations. If health needs a fact the declarations do not carry,
 *   > that is a gap in the DECLARATIONS — fix it there.
 *
 * A project dashboard that hand-lists every system and its status is that exact
 * mistake one level up, so this file lists NOTHING. The census comes from
 * `src/graph/passes.js` (Health.md: "the pass list IS the census"), the effects
 * come from `src/effects/index.js` — the zone's own declared door — filtered by
 * the project's own `validateEffectManifest`, and the pillar grades are parsed
 * out of the V4-Testament's own headings.
 *
 * THREE hand-written files carry what no declaration can, each with a single
 * author and a single job — conflating any two of them would let one act stand
 * in for a different one it is not:
 *   - `judgements.json` — effort/value, proposed by me, confirmed by Ingram.
 *   - `workitems.json` — a checklist FOR one requested feature, authored and
 *     ticked by me as work lands (the-covenant's own `[ ]`→`[x]`+evidence
 *     pattern, one level below "holy", applied per-feature).
 *   - `grades.json` — the S–F verdict on a FINISHED feature, written ONLY by
 *     Ingram, on his own eyes on a real scene (the-covenant's own
 *     "no self-grading" rule: I may never write my own guess in here).
 * None carries status, a title, or a list of systems — each evaluator refuses
 * those keys, and refuses a `ref` that does not resolve, so no ledger can
 * outlive the thing it describes. `src/graph/pass-health.js` is the precedent:
 * its tests assert the SHAPE "so a model cannot creep back in without a red
 * test."
 *
 * ## Measure / evaluate split
 *
 * Everything below is a pure function over data plus one `main()` that touches
 * disk — the same split `verify-structure.mjs` uses for its uniform ratchet, and
 * for the same reason: the test drives the pure half with data and never needs a
 * filesystem or a GPU.
 *
 * Output is HTML rather than this repo's usual markdown report because the
 * deliverable is a webpage the author opens; the line-building idiom is
 * `tools/trace-analyze.mjs`'s (`const L = []; L.push(…); L.join('\n')`).
 *
 * @module tools/chart-room/build-chart-room
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { walkSources, buildSurvey, deriveZoneEffectIds, zoneOf, findGaps } from './survey.mjs';

// fileURLToPath, not URL.pathname — the repo path contains spaces, which
// pathname percent-encodes into %20 and fs then cannot find. Same comment sits
// on verify-structure.mjs and harvest-params.mjs for the same reason.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = fileURLToPath(new URL('.', import.meta.url));
const JUDGEMENTS_FILE = join(HERE, 'judgements.json');
const WORKITEMS_FILE = join(HERE, 'workitems.json');
const GRADES_FILE = join(HERE, 'grades.json');
const CONFIRMATIONS_FILE = join(HERE, 'confirmations.json');
const OUT_FILE = join(HERE, 'index.html');
const ARTIFACT_FILE = join(HERE, 'chart-room.artifact.html');
const TESTAMENT_FILE = join(ROOT, 'docs', 'holy', 'V4-Testament.md');
const BUG_TRACKER_FILE = join(ROOT, 'docs', 'planning', 'Bug-Tracker.md');
const HOLY_DIR = join(ROOT, 'docs', 'holy');
const PLANNING_DIR = join(ROOT, 'docs', 'planning');
const PERF_REPORTS_DIR = join(ROOT, 'docs', 'planning', 'perf-reports');

// ── THE PILLAR GRADE SCALE ──────────────────────────────────────────────────
// V4-Testament Book II's own words, quoted verbatim from its legend:
//   AHEAD (better than V2 already) · PAR (about the same) · TUNE (works, needs
//   tuning rounds) · PRIMITIVE (far from done) · MISSING (not in V3 yet)
// The numbers are the only invented part, and they are deliberately blunt:
// PAR scores 1.0 because "about the same as V2" IS parity — the target of the
// whole exercise — not 90% of it.
export const PILLAR_GRADES = Object.freeze({
  AHEAD: 1.0,
  PAR: 1.0,
  TUNE: 0.7,
  PRIMITIVE: 0.3,
  MISSING: 0.0,
});

/** Pillars whose gap is a deliberate design choice, not a shortfall. */
// Pillar 11 (Vision & Fog) stays Foundry's BY DESIGN — Roadmap-to-Parity.md §0
// calls it "the correct default, not a gap". Counting it as 0% missing would
// understate parity by punishing a decision the project made on purpose, so it
// is reported BOTH ways and never silently folded in.
export const BY_DESIGN_PILLARS = Object.freeze([11]);

export const EFFORTS = Object.freeze(['quick', 'moderate', 'hard', 'epic']);
export const VALUES = Object.freeze(['essential', 'strong', 'nice', 'cut']);
export const VALUE_BY = Object.freeze(['claude', 'ingram']);

/**
 * Keys a judgement may NEVER carry, because each is derived elsewhere and a
 * second copy is the drift this whole file exists to avoid.
 */
export const FORBIDDEN_JUDGEMENT_KEYS = Object.freeze([
  'status',
  'title',
  'name',
  'systems',
  'progress',
  'state',
  'tiers',
  'done',
]);

const REF_NAMESPACES = Object.freeze(['pass', 'effect', 'pillar', 'v2', 'rung']);

// ── THE GRADE SCALE — Ingram's own, only Ingram's own ───────────────────────
// His words: S = "essentially perfect, no room for growth or improvement";
// A+ = "basically finished too, good for situations where we might add
// something eventually but it becomes very low priority"; and, describing
// water as a whole, "a solid C — got some nice stuff happening but it's not
// complete yet." B/D/F are MY interpolation between those three fixed points,
// not his words — flagged here so a wrong guess is easy to correct rather
// than silently treated as settled.
export const GRADES = Object.freeze(['S', 'A+', 'A', 'B', 'C', 'D', 'F']);
/** Ordinal only, for sorting/colour — not a percentage, not a score to average. */
export const GRADE_RANK = Object.freeze(Object.fromEntries(GRADES.map((g, i) => [g, GRADES.length - i])));
export const GRADED_BY = Object.freeze(['ingram']);

/** Keys derived elsewhere — a grade may only hold the verdict and its provenance. */
export const FORBIDDEN_GRADE_KEYS = Object.freeze(['checklist', 'state', 'done', 'status', 'effort', 'value']);
/** Keys a workitem may never carry — the grade lives in grades.json, not here. */
export const FORBIDDEN_WORKITEM_KEYS = Object.freeze(['grade', 'gradedBy', 'gradedAt']);
/** Keys a confirmation may never carry — same boundary as a grade, narrower content. */
export const FORBIDDEN_CONFIRMATION_KEYS = Object.freeze([
  'grade',
  'gradedBy',
  'gradedAt',
  'checklist',
  'state',
  'status',
  'effort',
  'value',
]);

// A status cell/line carries OTHER backtick-quoted text too — doc filenames in
// a `**Docs:**` field, code identifiers in the prose (`_Water`, `placementKey`,
// `Keyhole.md` all appear on real status lines in this file). Matching every
// backtick span picks those up as bogus "statuses"; anchoring the match to
// start with one of the four vocabulary words is what keeps it to the real
// value while still allowing "BUILT (unverified)" and "BUILT (verified
// engaged)"'s own trailing parenthetical through.
const STATUS_TOKEN_RE = /`((?:OPEN|BUILT|LIVE|CLOSED)\b[^`]*)`/gi;

// ── PARSE: the pillar grades, out of the Testament's own headings ────────────

/**
 * Read Book II's pillar grades from `V4-Testament.md`.
 *
 * The grade lives in the `###` heading itself, in several shapes that are all in
 * live use: `— AHEAD`, `— AHEAD→TUNE`, `— PRIMITIVE/MISSING`, `— PAR, engine
 * partly designed`, `— MISSING + A KNOWN LEAK`, and (pillars 4 and 5) the grade
 * BEFORE a trailing author quote. Italic parentheticals are stripped first so a
 * quoted word can never be mistaken for a grade — pillar 4's own quote runs off
 * the end of the line unclosed, hence the second, greedier strip.
 *
 * @param {string} text - the raw Testament markdown.
 * @returns {Array<{n: number, name: string, grades: string[], score: number, byDesign: boolean}>}
 */
export function parsePillars(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^###\s+Pillar\s+(\d+)\s*—\s*(.*)$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    // Strip closed `*(…)*` asides, then any unclosed one running to EOL.
    const bare = m[2].replace(/\*\([^)]*\)\*/g, ' ').replace(/\*\(.*$/, ' ');
    const grades = [];
    for (const g of Object.keys(PILLAR_GRADES)) {
      if (new RegExp(`\\b${g}\\b`).test(bare.toUpperCase())) grades.push(g);
    }
    const name = bare.split('—')[0].trim().replace(/\s+/g, ' ');
    const score = grades.length ? grades.reduce((a, g) => a + PILLAR_GRADES[g], 0) / grades.length : 0;
    out.push({ n, name, grades, score, byDesign: BY_DESIGN_PILLARS.includes(n) });
  }
  return out.sort((a, b) => a.n - b.n);
}

// ── MEASURE: the three completion numbers ───────────────────────────────────

/**
 * V2 parity as the pillars themselves grade it — the headline number, because it
 * is a considered per-subsystem judgement rather than a count of anything.
 *
 * @param {ReturnType<typeof parsePillars>} pillars
 */
export function scorePillars(pillars) {
  const all = pillars.length ? pillars.reduce((a, p) => a + p.score, 0) / pillars.length : 0;
  const counted = pillars.filter((p) => !p.byDesign);
  const exByDesign = counted.length ? counted.reduce((a, p) => a + p.score, 0) / counted.length : 0;
  return { pct: all * 100, pctExByDesign: exByDesign * 100, n: pillars.length, nCounted: counted.length };
}

/**
 * V2 parity as pass coverage: every pass declares `absorbs[]` — the exact V2
 * classes whose job it takes over — so the share of V2's system inventory
 * covered by a pass that actually runs is a real, machine-checked number.
 *
 * ⚠️ `live` does NOT mean complete. Every live pass in `passes.js` carries a
 * hand-written caveat in its own `note`, several saying so outright. This
 * function reports coverage, never completeness, and the page prints the caveat.
 *
 * @param {Array<{id: string, status: string, absorbs?: string[]}>} passes
 */
export function measurePassCoverage(passes) {
  const byStatus = { live: 0, seam: 0, future: 0 };
  let absorbsTotal = 0;
  let absorbsLive = 0;
  const stranded = [];
  for (const p of passes) {
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    const n = (p.absorbs ?? []).length;
    absorbsTotal += n;
    if (p.status === 'live') absorbsLive += n;
    else if (n > 0) stranded.push({ id: p.id, status: p.status, count: n, absorbs: p.absorbs ?? [] });
  }
  stranded.sort((a, b) => b.count - a.count);
  return {
    total: passes.length,
    byStatus,
    absorbsTotal,
    absorbsLive,
    pct: absorbsTotal ? (absorbsLive / absorbsTotal) * 100 : 0,
    passPct: passes.length ? (byStatus.live / passes.length) * 100 : 0,
    stranded,
  };
}

/**
 * V4 SCOPE — built rungs against built + deferred, per effect.
 *
 * Deliberately NOT reported as V2 parity: `deferredRungs` records the intended
 * V4 ceiling, and much of it (water's sim rungs, specular's island look) is
 * ground V2 never covered. Measuring parity against an ambition V2 never had
 * would report the project as further behind the harder it aims.
 *
 * @param {Array<object>} manifests
 */
export function measureEffectRungs(manifests) {
  const rows = manifests
    .map((m) => {
      const built = (m.tiers ?? []).length;
      const deferred = (m.deferredRungs ?? []).length;
      return {
        id: m.id,
        title: m.title ?? m.id,
        built,
        deferred,
        pct: built + deferred ? (built / (built + deferred)) * 100 : 0,
        visualWeight: m.visualWeight ?? 0,
        enabledFromProfile: m.enabledFromProfile,
        coverage: m.readiness?.coverage ?? 'none',
        firstRunWork: m.readiness?.firstRunWork === true,
        paint: m.authoring?.paint ? [].concat(m.authoring.paint) : [],
        deferredNames: (m.deferredRungs ?? []).map((d) => d.name),
      };
    })
    .sort((a, b) => b.visualWeight - a.visualWeight || a.id.localeCompare(b.id));
  const built = rows.reduce((a, r) => a + r.built, 0);
  const deferred = rows.reduce((a, r) => a + r.deferred, 0);
  return { rows, built, deferred, pct: built + deferred ? (built / (built + deferred)) * 100 : 0 };
}

/**
 * Every RUNG of every effect as an addressable thing — `rung:<effectId>:<name>`
 * for both a BUILT tier and a DEFERRED one. This is what makes "click water,
 * click refraction" a real address rather than a UI-only concept: the ref is
 * the exact string `water.js`'s own `deferredRungs[].name` already carries.
 *
 * @param {Array<object>} manifests
 * @returns {Array<{ref: string, effectId: string, effectTitle: string, name: string, built: boolean, note: string}>}
 */
export function describeRungs(manifests) {
  const out = [];
  for (const m of manifests) {
    for (const t of m.tiers ?? []) {
      out.push({
        ref: `rung:${m.id}:${t.name ?? `tier${t.n}`}`,
        effectId: m.id,
        effectTitle: m.title ?? m.id,
        name: t.name ?? `tier${t.n}`,
        built: true,
        note: t.adds ?? '',
      });
    }
    for (const d of m.deferredRungs ?? []) {
      out.push({
        ref: `rung:${m.id}:${d.name}`,
        effectId: m.id,
        effectTitle: m.title ?? m.id,
        name: d.name,
        built: false,
        note: d.note ?? '',
      });
    }
  }
  return out;
}

// ── EVALUATE: the three hand-written files ──────────────────────────────────

/**
 * Resolve and police `judgements.json`.
 *
 * Every `ref` must be `<namespace>:<id>` and must resolve against DERIVED data —
 * a pass id, an effect id, a pillar number, or a V2 class named in some pass's
 * own `absorbs[]`. An unresolvable ref is an error, not a warning: that is what
 * stops the ledger outliving the thing it describes, the way
 * `structure-exceptions.json`'s expiry stops debt becoming permanent by being
 * forgotten.
 *
 * Namespacing is not decoration. The ladder letters in this project collide
 * three ways each — `S` is Book I's stages AND water's S0–S8 AND `DEFERRED-S1a`;
 * `R` is the Reckoning's phases AND its census rows AND the shared verification
 * rung AND Clouds' representation options; `P` is precipitation's slices AND two
 * incompatible petition formats. A bare id would be genuinely ambiguous.
 *
 * @param {Array<object>} judgements - the parsed ledger.
 * @param {{passes: Set<string>, effects: Set<string>, pillars: Set<string>, v2: Set<string>}} known
 * @returns {{ok: boolean, errors: string[], resolved: Array<object>}}
 */
export function evaluateJudgements(judgements, known) {
  const errors = [];
  const resolved = [];
  if (!Array.isArray(judgements)) {
    return { ok: false, errors: ['judgements.json must be an array'], resolved };
  }
  const seen = new Set();
  judgements.forEach((j, i) => {
    const at = `judgements[${i}]`;
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const k of FORBIDDEN_JUDGEMENT_KEYS) {
      if (k in j) {
        errors.push(
          `${at} carries '${k}', which is DERIVED elsewhere (passes.js / the manifests / the Testament). ` +
            'A judgement may only hold what no declaration can: effort, value, and what done-enough means.'
        );
      }
    }
    const ref = j.ref;
    if (typeof ref !== 'string' || !/^[a-z0-9]+:.+$/.test(ref)) {
      errors.push(`${at}.ref ${JSON.stringify(ref)} must be '<${REF_NAMESPACES.join('|')}>:<id>'`);
      return;
    }
    if (seen.has(ref)) errors.push(`${at}.ref '${ref}' is judged twice`);
    seen.add(ref);
    const [ns, ...rest] = ref.split(':');
    const id = rest.join(':');
    const table = { pass: known.passes, effect: known.effects, pillar: known.pillars, v2: known.v2, rung: known.rungs }[
      ns
    ];
    if (!table) {
      errors.push(`${at}.ref namespace '${ns}' is unknown — use one of: ${REF_NAMESPACES.join(', ')}`);
      return;
    }
    if (!table.has(id)) {
      errors.push(
        `${at}.ref '${ref}' does not resolve — no ${ns} with id '${id}' exists. Either it was renamed or it was ` +
          'never there; a ledger entry may not outlive the thing it describes.'
      );
      return;
    }
    if (!EFFORTS.includes(j.effort)) {
      errors.push(`${at}.effort ${JSON.stringify(j.effort)} must be one of: ${EFFORTS.join(', ')}`);
    }
    if (!VALUES.includes(j.value)) {
      errors.push(`${at}.value ${JSON.stringify(j.value)} must be one of: ${VALUES.join(', ')}`);
    }
    if (!VALUE_BY.includes(j.valueBy)) {
      errors.push(
        `${at}.valueBy ${JSON.stringify(j.valueBy)} must be one of: ${VALUE_BY.join(', ')} — a value the author ` +
          'has not actually confirmed must say so, or a guess reads as a decision.'
      );
    }
    if (typeof j.backOnItsLegs !== 'string' || j.backOnItsLegs.length < 10) {
      errors.push(
        `${at}.backOnItsLegs must be a real sentence — the honest minimum bar for this to count as done, so ` +
          '"chase features only as far as I need to" has something to check against.'
      );
    }
    resolved.push({ ...j, ns, id });
  });
  return { ok: errors.length === 0, errors, resolved };
}

/**
 * `grades.json` — THE ONE VERDICT ONLY THE AUTHOR MAY WRITE.
 *
 * Everything else in this file is derived or is my own proposal, flagged as
 * such. A grade is neither: it is Ingram's own confirmed judgement on a real
 * scene ("water as a whole… a solid C"), the same authority level as `LIVE` in
 * the Bug Tracker's own vocabulary ("only they can promote to this"). So this
 * validator is stricter than `evaluateJudgements` in exactly one way —
 * `gradedBy` must be `'ingram'`, never `'claude'` — because there is no
 * legitimate "proposed grade" the way there is a proposed effort/value.
 *
 * Same anti-outlive-its-subject rule as everywhere else: `ref` must resolve
 * against real declared things (an effect, or a specific built rung — grading
 * something that does not exist yet is not a grade, it is a wish).
 *
 * @param {Array<object>} grades
 * @param {{effects: Set<string>, rungs: Set<string>, builtRungs: Set<string>}} known
 * @returns {{ok: boolean, errors: string[], resolved: Array<object>}}
 */
export function evaluateGrades(grades, known) {
  const errors = [];
  const resolved = [];
  if (!Array.isArray(grades)) return { ok: false, errors: ['grades.json must be an array'], resolved };
  const seen = new Set();
  grades.forEach((g, i) => {
    const at = `grades[${i}]`;
    if (!g || typeof g !== 'object' || Array.isArray(g)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const k of FORBIDDEN_GRADE_KEYS) {
      if (k in g) errors.push(`${at} carries '${k}', which belongs in judgements.json or workitems.json, not here.`);
    }
    const ref = g.ref;
    if (typeof ref !== 'string' || !/^(effect|rung):.+$/.test(ref)) {
      errors.push(
        `${at}.ref ${JSON.stringify(ref)} must be 'effect:<id>' or 'rung:<effectId>:<name>' — only a real, built thing can be graded.`
      );
      return;
    }
    if (seen.has(ref)) errors.push(`${at}.ref '${ref}' is graded twice — one entry per thing.`);
    seen.add(ref);
    const isEffect = ref.startsWith('effect:');
    const id = ref.slice(ref.indexOf(':') + 1);
    const table = isEffect ? known.effects : known.builtRungs;
    if (!table.has(id)) {
      errors.push(
        `${at}.ref '${ref}' does not resolve against a BUILT thing — either it was never built, it was renamed, ` +
          'or (for a rung) it is still deferred. A grade cannot outlive, or precede, the thing it is about.'
      );
      return;
    }
    if (!GRADES.includes(g.grade)) {
      errors.push(`${at}.grade ${JSON.stringify(g.grade)} must be one of: ${GRADES.join(', ')}`);
    }
    if (!GRADED_BY.includes(g.gradedBy)) {
      errors.push(`${at}.gradedBy ${JSON.stringify(g.gradedBy)} must be 'ingram' — nobody else's verdict counts here.`);
    }
    if (typeof g.gradedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(g.gradedAt)) {
      errors.push(`${at}.gradedAt must be a YYYY-MM-DD date — when the verdict was actually given.`);
    }
    resolved.push({ ...g, isEffect, id });
  });
  return { ok: errors.length === 0, errors, resolved };
}

/**
 * `confirmations.json` — the narrower, binary verdict underneath a grade:
 * *"You can only confirm that you built something, I am the only one capable
 * of confirming if it really landed."* A grade is a quality judgement on
 * something already known to work; this is the prerequisite check — has
 * Ingram actually watched this run on a real scene, at all — recorded
 * separately so he can tick "seen working" the moment he confirms it, before
 * (or instead of) settling on a letter grade.
 *
 * Same ref/authority rules as `grades.json` (only a BUILT effect or rung can
 * be confirmed — nothing to watch run otherwise), and the same
 * anti-self-grading boundary: `checklist`/`state`/`effort`/`value` belong to
 * `workitems.json`, a grade letter belongs to `grades.json`, not here.
 *
 * @param {Array<object>} confirmations
 * @param {{effects: Set<string>, builtRungs: Set<string>}} known
 * @returns {{ok: boolean, errors: string[], resolved: Array<object>}}
 */
export function evaluateConfirmations(confirmations, known) {
  const errors = [];
  const resolved = [];
  if (!Array.isArray(confirmations)) {
    return { ok: false, errors: ['confirmations.json must be an array'], resolved };
  }
  const seen = new Set();
  confirmations.forEach((c, i) => {
    const at = `confirmations[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const k of FORBIDDEN_CONFIRMATION_KEYS) {
      if (k in c) errors.push(`${at} carries '${k}', which belongs in grades.json or workitems.json, not here.`);
    }
    const ref = c.ref;
    if (typeof ref !== 'string' || !/^(effect|rung):.+$/.test(ref)) {
      errors.push(`${at}.ref ${JSON.stringify(ref)} must be 'effect:<id>' or 'rung:<effectId>:<name>'.`);
      return;
    }
    if (seen.has(ref)) errors.push(`${at}.ref '${ref}' is confirmed twice — one entry per thing.`);
    seen.add(ref);
    const isEffect = ref.startsWith('effect:');
    const id = ref.slice(ref.indexOf(':') + 1);
    const table = isEffect ? known.effects : known.builtRungs;
    if (!table.has(id)) {
      errors.push(
        `${at}.ref '${ref}' does not resolve against a BUILT thing — there is nothing on a real scene yet to have ` +
          'watched run.'
      );
      return;
    }
    if (typeof c.seenWorking !== 'boolean' || typeof c.wrong !== 'boolean') {
      errors.push(`${at}.seenWorking and .wrong must both be booleans.`);
    }
    if (c.seenWorking === true && c.wrong === true) {
      errors.push(`${at} claims BOTH seen-working and wrong — pick one; they contradict each other.`);
    }
    if (c.seenWorking !== true && c.wrong !== true) {
      errors.push(`${at} sets neither seenWorking nor wrong — an unconfirmed entry records nothing, remove it.`);
    }
    if (typeof c.confirmedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.confirmedAt)) {
      errors.push(`${at}.confirmedAt must be a YYYY-MM-DD date — when the verdict was actually given.`);
    }
    resolved.push({ ...c, isEffect, id });
  });
  return { ok: errors.length === 0, errors, resolved };
}

/**
 * `workitems.json` — a checklist-driven request, the shape the author asked
 * for directly: *"I should be able to click on water and then click on
 * 'refraction'… type a note… You would start by adding a checklist of work
 * that needs to be done… tick things off as you go through… inform me once
 * you've finished."*
 *
 * The checklist is MINE to author and tick — same authority split as the
 * Testament's own `[ ]`→`[x]`+evidence convention (`the-covenant`), applied
 * per-feature instead of per-holy-document. `grade`/`gradedBy` are explicitly
 * FORBIDDEN here (see `FORBIDDEN_WORKITEM_KEYS`) because the verdict on
 * finished work is a completely separate act, by a completely different
 * author, recorded in `grades.json` — conflating the two would let me grade my
 * own homework, exactly what `the-covenant`'s "no self-grading" rule forbids.
 *
 * @param {Array<object>} items
 * @param {{passes: Set<string>, effects: Set<string>, pillars: Set<string>, rungs: Set<string>}} known
 * @returns {{ok: boolean, errors: string[], resolved: Array<object>}}
 */
export function evaluateWorkItems(items, known) {
  const errors = [];
  const resolved = [];
  if (!Array.isArray(items)) return { ok: false, errors: ['workitems.json must be an array'], resolved };
  const seen = new Set();
  items.forEach((w, i) => {
    const at = `workitems[${i}]`;
    if (!w || typeof w !== 'object' || Array.isArray(w)) {
      errors.push(`${at} must be an object`);
      return;
    }
    for (const k of FORBIDDEN_WORKITEM_KEYS) {
      if (k in w) errors.push(`${at} carries '${k}' — the verdict belongs in grades.json, authored only by Ingram.`);
    }
    const ref = w.ref;
    if (typeof ref !== 'string' || !/^(pass|effect|pillar|rung):.+$/.test(ref)) {
      errors.push(`${at}.ref ${JSON.stringify(ref)} must be namespaced (pass:/effect:/pillar:/rung:).`);
      return;
    }
    if (seen.has(ref)) errors.push(`${at}.ref '${ref}' has two work items — merge them into one checklist.`);
    seen.add(ref);
    const [ns, ...rest] = ref.split(':');
    const id = rest.join(':');
    const table = { pass: known.passes, effect: known.effects, pillar: known.pillars, rung: known.rungs }[ns];
    if (!table?.has(id)) {
      errors.push(`${at}.ref '${ref}' does not resolve — nothing declared with that id exists.`);
      return;
    }
    if (typeof w.ask !== 'string' || w.ask.length < 10) {
      errors.push(`${at}.ask must be a real sentence — what was actually requested, close to Ingram's own words.`);
    }
    if (typeof w.requestedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(w.requestedAt)) {
      errors.push(`${at}.requestedAt must be a YYYY-MM-DD date.`);
    }
    if (!Array.isArray(w.checklist)) {
      errors.push(`${at}.checklist must be an array (may be empty: requested, not yet broken down into steps).`);
    } else {
      w.checklist.forEach((c, ci) => {
        if (!c || typeof c.text !== 'string' || c.text.length < 3 || typeof c.done !== 'boolean') {
          errors.push(`${at}.checklist[${ci}] must be {text: string, done: boolean}`);
        }
      });
    }
    resolved.push({ ...w, ns, id });
  });
  return { ok: errors.length === 0, errors, resolved };
}

/**
 * The state of one work item — DERIVED from its checklist, never stored, so it
 * can never disagree with the checklist it describes.
 *
 * @param {{checklist?: Array<{done: boolean}>}} item
 * @returns {'requested'|'planned'|'in-progress'|'awaiting-eyes'}
 */
export function deriveWorkItemState(item) {
  const list = item.checklist ?? [];
  if (list.length === 0) return 'requested';
  const done = list.filter((c) => c.done).length;
  if (done === 0) return 'planned';
  if (done < list.length) return 'in-progress';
  return 'awaiting-eyes';
}

/**
 * Sort judged work into the four buckets the author asked for by name:
 * what could be done quickly, what is hard, what we do not want, and what has
 * not been placed yet.
 *
 * @param {Array<object>} resolved
 */
export function triage(resolved) {
  const worth = (v) => v === 'essential' || v === 'strong';
  const cheap = (e) => e === 'quick' || e === 'moderate';
  return {
    easyWins: resolved.filter((j) => worth(j.value) && cheap(j.effort)),
    grind: resolved.filter((j) => worth(j.value) && !cheap(j.effort)),
    cutList: resolved.filter((j) => j.value === 'cut'),
    pile: resolved.filter((j) => j.value === 'nice'),
    unconfirmed: resolved.filter((j) => j.valueBy !== 'ingram'),
  };
}

/**
 * THE ANTI-DRIFT CHECK — the reason this ledger cannot quietly rot.
 *
 * `evaluateJudgements` only proves a `ref` still points at something real. It
 * says nothing about whether that something is still UNFINISHED — a judgement
 * written against `pass:post.grade` while it was a seam is silently wrong the
 * day that pass ships, and nothing before this function would ever notice: the
 * ref still resolves, `triage()` only sorts by effort/value, so a finished pass
 * would sit in "The Grind" forever describing work that no longer exists.
 *
 * This closes it the same way everything else here is checked: by asking the
 * SAME derived data the judgement was written against, never a second stored
 * flag that could itself go stale. A pass judgement is done when the pass is
 * `live`. An effect judgement is done when nothing is left in its
 * `deferredRungs`. A pillar judgement is done when its own grade reads AHEAD or
 * PAR.
 *
 * ⚠️ `v2:` judgements are DELIBERATELY NEVER auto-resolved, and this was found
 * the hard way, not reasoned out in advance: `light.accumulate` is `live` and
 * its own `absorbs[]` lists `PlayerLightEffectV2` — but that pass's own long
 * `note` documents ambient/point-light/coloration/darkness in detail and never
 * mentions a carried light, because none exists (confirmed by a direct
 * code-reading investigation: zero player-light rendering anywhere in `src/`).
 * `absorbs[]` is prose typed when a pass was SCOPED, describing intent, never
 * re-verified per class as work actually landed — so "some live pass claims to
 * absorb this" is not evidence a specific V2 class's job was replaced. Trusting
 * it here would have made this very check the thing that introduced a false
 * "done" signal, in the one system whose entire purpose is not doing that.
 *
 * @param {Array<object>} resolved - judgements with `ns`/`id` from evaluateJudgements.
 * @param {{passes: Array<object>, effects: Array<object>, pillars: Array<object>}} ctx
 * @returns {{stillOpen: Array<object>, doneSince: Array<object>}}
 */
export function findResolvedSinceJudged(resolved, ctx) {
  const { passes, effects, pillars } = ctx;
  const passById = new Map(passes.map((p) => [p.id, p]));
  const effectById = new Map(effects.map((e) => [e.id, e]));
  const pillarByN = new Map(pillars.map((p) => [String(p.n), p]));

  const doneNow = (j) => {
    if (j.ns === 'pass') return passById.get(j.id)?.status === 'live';
    if (j.ns === 'effect') return (effectById.get(j.id)?.deferred ?? 1) === 0;
    if (j.ns === 'pillar') return (pillarByN.get(j.id)?.score ?? 0) >= 1;
    return false; // v2: — see the warning above; never auto-resolved
  };

  const stillOpen = [];
  const doneSince = [];
  for (const j of resolved) (doneNow(j) ? doneSince : stillOpen).push(j);
  return { stillOpen, doneSince };
}

/**
 * Everything the page can be asked about but has NOT been given — named on the
 * page itself rather than quietly omitted. An instrument that shows only what it
 * happens to know reads as completeness (`feedback_instruments_must_not_lie`).
 *
 * @param {{passes: Array<object>, effects: Array<object>, resolved: Array<object>}} a
 */
export function findBlindSpots({ passes, effects, resolved }) {
  const judged = new Set(resolved.map((j) => j.ref));
  const out = [];
  for (const p of passes) {
    if (p.status !== 'live' && !judged.has(`pass:${p.id}`)) {
      out.push({ ref: `pass:${p.id}`, why: `pass is '${p.status}' and carries no effort/value judgement` });
    }
  }
  for (const e of effects) {
    if (e.deferred > 0 && !judged.has(`effect:${e.id}`)) {
      out.push({ ref: `effect:${e.id}`, why: `${e.deferred} deferred rung(s), no effort/value judgement` });
    }
  }
  return out;
}

// ── PARSE: real performance data, per effect ─────────────────────────────────

/**
 * Per-effect measured cost, straight out of a real `perf-report.js` capture
 * (`docs/planning/perf-reports/*.json`, `report.effects[]`). Real numbers when
 * they exist; `null`/`'unmeasured'` when they honestly do not — this project's
 * own perf-report format already carries that distinction (`declared.verdict`),
 * so this is a re-shaping, not a new judgement.
 *
 * Deliberately keyed by effect id only — the report has no per-RUNG breakdown,
 * so a rung's own perf entry is always absent, never guessed at from the
 * effect total.
 *
 * @param {object|null} report - a parsed perf-report JSON, or null if none exists.
 * @returns {{byEffect: Record<string, object>, capturedAt: string|null, msaVersion: string|null}}
 */
export function derivePerfByEffect(report) {
  const byEffect = {};
  for (const e of report?.effects ?? []) {
    byEffect[e.id] = {
      enabled: e.enabled === true,
      costMs: typeof e.costMs === 'number' ? e.costMs : null,
      verdict: e.declared?.verdict ?? 'unmeasured',
      coverage: e.zoneCoverage ?? 'none',
    };
  }
  return {
    byEffect,
    capturedAt: typeof report?.generatedAt === 'string' ? report.generatedAt.slice(0, 10) : null,
    msaVersion: report?.msaVersion ?? null,
  };
}

// ── PARSE: the Bug Tracker — the project's own "critical items" register ────

/**
 * Read `docs/planning/Bug-Tracker.md` into its two independently-maintained
 * halves: the summary INDEX table, and the numbered `## N. Title` entries. They
 * are supposed to agree; nothing enforces that they do, so a later function
 * diffs them rather than trusting either alone.
 *
 * The canonical status words are parsed out of the doc's OWN `## Status
 * vocabulary` table rather than hardcoded — if the author ever adds a fifth
 * word, this follows for free instead of silently flagging it as foreign.
 *
 * @param {string} text
 * @returns {{
 *   canonicalStatuses: string[],
 *   index: Array<{id: number, flagged: boolean, title: string, subsystem: string, statuses: string[]}>,
 *   body: Array<{ids: number[], title: string, statuses: string[]}>,
 * }}
 */
export function parseBugTracker(text) {
  const lines = String(text).split(/\r?\n/);

  const canonicalStatuses = [];
  let inVocab = false;
  for (const line of lines) {
    if (/^##\s+Status vocabulary\s*$/.test(line)) {
      inVocab = true;
      continue;
    }
    if (inVocab && /^##\s+/.test(line)) break;
    if (inVocab) {
      const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
      if (m) canonicalStatuses.push(m[1]);
    }
  }

  const index = [];
  let inIndex = false;
  for (const line of lines) {
    if (/^##\s+Index\s*$/.test(line)) {
      inIndex = true;
      continue;
    }
    if (inIndex && /^##\s+/.test(line)) break;
    if (!inIndex) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6) continue; // '', id, title, subsystem, status, '' at minimum
    const [, idCell, title, subsystem, status] = cells;
    if (!idCell || /^-+$/.test(idCell) || idCell === '#') continue; // header/separator rows
    const idNum = Number(idCell.replace(/\*/g, ''));
    if (!Number.isFinite(idNum)) continue;
    index.push({
      id: idNum,
      flagged: idCell.includes('**'),
      title: title.replace(/\*\*/g, ''),
      subsystem,
      statuses: [...status.matchAll(STATUS_TOKEN_RE)].map((m) => m[1]),
    });
  }

  const body = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(\d+)(?:[–-](\d+))?\.\s+(.+)$/.exec(lines[i]);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    const ids = [];
    for (let id = lo; id <= hi; id++) ids.push(id);
    // The status line always sits within the next few lines in this doc's own
    // layout — bounded look-ahead so a later, unrelated bug's status can never
    // be picked up by mistake.
    let statusLine = '';
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (/^##\s+/.test(lines[j])) break;
      if (/\*\*Status:\*\*/.test(lines[j])) {
        statusLine = lines[j];
        break;
      }
    }
    body.push({ ids, title: m[3].trim(), statuses: [...statusLine.matchAll(STATUS_TOKEN_RE)].map((mm) => mm[1]) });
  }

  return { canonicalStatuses, index, body };
}

/**
 * Everything worth knowing about the Bug Tracker beyond "here are 29 rows":
 * which bugs are OPEN (the actual critical-items list), and where the index
 * and the body — two hand-maintained halves of the same file — disagree.
 *
 * @param {ReturnType<typeof parseBugTracker>} parsed
 */
export function bugTrackerFindings(parsed) {
  const { canonicalStatuses, index, body } = parsed;
  const canonical = new Set(canonicalStatuses);
  const indexIds = new Set(index.map((r) => r.id));
  const bodyIds = new Set(body.flatMap((r) => r.ids));

  const indexOnly = [...indexIds].filter((id) => !bodyIds.has(id)).sort((a, b) => a - b);
  const bodyOnly = [...bodyIds].filter((id) => !indexIds.has(id)).sort((a, b) => a - b);

  const nonCanonical = [];
  for (const r of index) {
    for (const s of r.statuses) if (!canonical.has(s)) nonCanonical.push({ where: `#${r.id} (index)`, status: s });
  }
  for (const r of body) {
    for (const s of r.statuses) {
      if (!canonical.has(s)) nonCanonical.push({ where: `#${r.ids.join('-')} (body)`, status: s });
    }
  }

  // The index row's FIRST status token is the one the author actually reads as
  // the headline (body status lines can be more granular/split — e.g. bug 13's
  // "OPEN (layering) ... the stale-flag half is BUILT (unverified)").
  const openBugs = index
    .filter((r) => r.statuses[0] === 'OPEN')
    .map((r) => ({ id: r.id, title: r.title, subsystem: r.subsystem, flagged: r.flagged, statuses: r.statuses }))
    .sort((a, b) => Number(b.flagged) - Number(a.flagged) || a.id - b.id);

  return { indexOnly, bodyOnly, nonCanonical, openBugs, totalIndexed: index.length, totalInBody: bodyIds.size };
}

// ── PARSE: a holy doc's raw activity — shown, not verdict-ed ────────────────

/**
 * Raw checkbox/countersign/petition counts for one `docs/holy/*.md` file.
 *
 * Deliberately returns COUNTS, not a computed "this doc is stale" verdict.
 * Research into this project's own docs found real, sizeable drift (the UI
 * Testament shows 45 items as `[ ]` while its own 35 petitions record most of
 * that work as shipped) — but the honest boundary between "genuinely not
 * started" and "checklist fell behind the petitions" needs section-level
 * context (which stage a petition belongs to) that a whole-file count cannot
 * safely infer. Surfacing the raw numbers side by side lets a reader draw that
 * conclusion themselves rather than trusting a heuristic that could be wrong
 * in either direction.
 *
 * @param {string} text
 */
export function parseHolyDocActivity(text) {
  const count = (re) => (String(text).match(re) || []).length;
  return {
    open: count(/^\s*-\s\[ \]/gm),
    done: count(/^\s*-\s\[x\]/gm),
    countersigned: count(/^\s*-\s+✠/gm),
    reopened: count(/^\s*-\s+⚑/gm),
    petitions: count(/^\*\*P-?\d+/gm),
  };
}

// ── FIND: a doc contradicting its own header ─────────────────────────────────

/**
 * A generic, reusable check — NOT a hardcoded list of "the six drifts we found
 * once". Any `docs/planning/*.md` file whose own header claims nothing is
 * built, while its own body records a `BUILT (unverified)` or `LIVE` item, is
 * flagged. This is exactly the shape `Precipitation.md` was caught in
 * (`**DESIGN ONLY. NOTHING BUILT.**` at the top, `↳ BUILT (unverified)` three
 * times further down) — but the check runs on every planning doc, every build,
 * so the NEXT doc that drifts this way is caught too, not just this one.
 *
 * @param {Array<{path: string, text: string}>} files
 */
export function findNothingBuiltContradiction(files) {
  const out = [];
  for (const { path, text } of files) {
    const head = String(text).slice(0, 1500);
    const claimMatch = /(DESIGN ONLY\.?\s*NOTHING BUILT\.?|NOTHING (?:IS )?BUILT)/i.exec(head);
    if (!claimMatch) continue;
    const built = [...String(text).matchAll(/`(BUILT \(unverified\)|LIVE)`/g)];
    if (built.length > 0) {
      out.push({ path, claim: claimMatch[0].trim(), builtCount: built.length });
    }
  }
  return out;
}

// ── RENDER ──────────────────────────────────────────────────────────────────

/**
 * Exported so the test can assert against the SAME transform the renderer uses.
 * A test that reimplements escaping tests its own copy — and this one already
 * disagreed once, over the apostrophe in "The Author's Toolkit".
 */
export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const esc = escapeHtml;

const pct1 = (n) => `${n.toFixed(1)}%`;

/** A theme-aware SVG donut. No library, no dependency, scales with the card. */
function gauge(pct, tone) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const on = (Math.max(0, Math.min(100, pct)) / 100) * c;
  return [
    `<svg class="gauge" viewBox="0 0 128 128" role="img" aria-label="${pct1(pct)}">`,
    `<circle cx="64" cy="64" r="${r}" class="gtrack"/>`,
    `<circle cx="64" cy="64" r="${r}" class="gfill ${tone}" stroke-dasharray="${on.toFixed(2)} ${(c - on).toFixed(2)}"/>`,
    `<text x="64" y="60" class="gnum">${pct.toFixed(0)}<tspan class="gpc">%</tspan></text>`,
    `</svg>`,
  ].join('');
}

function chip(text, cls) {
  return `<span class="chip ${cls ?? ''}">${esc(text)}</span>`;
}

/**
 * THE CHART ROOM'S OWN GROUND — LANTERN, warmed.
 *
 * LANTERN's neutrals are a cold blue-black (`--bg0: #14161d`), which is right
 * for chrome that sits over a moody map and wrong for a room someone works in
 * all day. The author's own brief: *"make the UI warmer and more friendly, this
 * might be where I start to live."*
 *
 * So this overrides the NEUTRAL RAMP ONLY — grounds, inks, rules — and inherits
 * everything that carries meaning: `--shine` (already a warm gold),
 * `--ok`/`--warn`/`--fail`, the seven category hues, every shape and motion
 * token. A semantic colour still means exactly what it means everywhere else in
 * the project, and if LANTERN retunes one, this page follows.
 *
 * The divergence is deliberate and bounded: `tools/ui-mock` and
 * `tools/widget-gallery` use LANTERN unmodified because they are PREVIEWING the
 * module's own interface and must not lie about it. The Chart Room previews
 * nothing — it is a workshop, and a workshop may have its own light.
 *
 * @param {'dark'|'light'} theme
 * @returns {Record<string,string>}
 */
export function warmNeutrals(theme) {
  return theme === 'light'
    ? {
        // Parchment rather than paper — the same luminance steps LANTERN's own
        // light theme uses, rotated toward amber.
        '--bg0': '#efe9de',
        '--bg1': '#f8f4ec',
        '--bg2': '#fffdf9',
        '--bg3': '#f1eae0',
        '--line': 'rgba(74,58,36,.13)',
        '--line-strong': 'rgba(74,58,36,.26)',
        '--ink0': '#241d14',
        '--ink1': '#564b3c',
        // Darkened from a first pass at #7a6f5f, which measured 4.07:1 on the
        // page ground — under AA. The contrast gate below caught it; the colour
        // moved rather than the bar.
        '--ink2': '#6b5f4d',
        '--glass': 'rgba(248,244,236,.92)',
      }
    : {
        '--bg0': '#16130f',
        '--bg1': '#1d1915',
        '--bg2': '#26201a',
        '--bg3': '#302921',
        '--line': 'rgba(235,220,195,.11)',
        '--line-strong': 'rgba(235,220,195,.20)',
        '--ink0': '#f3eee5',
        '--ink1': '#c0b5a4',
        // Lifted from #8d8375, which cleared AA on the page ground but fell to
        // 4.32:1 on the lightest card surface (--bg2) that muted text also sits on.
        '--ink2': '#978d7e',
        '--glass': 'rgba(29,25,21,.88)',
      };
}

/**
 * THE WRITE-BACK CONTROL — the whole point of the blocks view.
 *
 * On the published live doc, everything in here is a real shared edit: the
 * runtime captures `contenteditable` typing and checkbox state by design, so
 * what the author writes is SAVED into the document without a save button, an
 * API call, or a round trip through a file.
 *
 * ⚠️ Saved is not the same as noticed. Nothing here pushes a live
 * notification to a running Claude session — I only see a note when I next
 * open or re-fetch the page. The one thing on this artifact that DOES notify
 * me live is the platform's own Comments feature (mention @claude in a
 * thread), which is separate page chrome this generator does not render — see
 * the `.syncnote` callout near the top of the page for the honest version of
 * this, aimed at the reader rather than at me.
 *
 * Two deliberate choices:
 * - `contenteditable` on a bare `<p>`, NOT a `<textarea>` — the runtime's own
 *   contract says textarea and select VALUES are not captured, so a textarea
 *   here would look like it worked and silently lose every word.
 * - The `<p>` holds text and nothing else. Text mixed with child elements
 *   cannot be saved, so the label and the hint live OUTSIDE it.
 *
 * `data-block` is the stable address: it is how a note typed on this page is
 * matched back to the thing it is about when the document is read.
 *
 * @param {string} id - the block's stable id (a zone name, file path, or gap id).
 * @param {string} placeholder
 * @param {{withTicks?: boolean}} [opts] - `withTicks: false` for a ref that
 *   already carries the dedicated, always-visible `confirmPicker` next to its
 *   grade — an effect or a built rung. Two "have you seen this working?"
 *   checkboxes for the SAME ref, one folded in here and one sitting next to
 *   the grade, would be two places to disagree with itself.
 */
export function noteBox(id, placeholder, opts = {}) {
  const { withTicks = true } = opts;
  // FOLDED AWAY BY DEFAULT, and `<details>` is the mechanism for a specific
  // reason: the live-doc contract lists `open` on `<details>` among the handful
  // of things that stay the viewer's own and are never journaled. So the fold
  // costs no JS, cannot leak one person's browsing into the shared document,
  // and removes 437 permanently-open input boxes from the page — which was the
  // single loudest thing about the first draft.
  return [
    `<details class="note">`,
    `<summary class="notetab">Leave a note</summary>`,
    `<div class="notebody">`,
    `<p class="notein" contenteditable="true" data-block="${esc(id)}" data-placeholder="${esc(placeholder)}"></p>`,
    withTicks
      ? `<div class="ticks">` +
        `<label class="tick"><input type="checkbox" data-seen="${esc(id)}"><span>I've seen this working</span></label>` +
        `<label class="tick bad"><input type="checkbox" data-wrong="${esc(id)}"><span>Something's wrong</span></label>` +
        `</div>`
      : '',
    `</div></details>`,
  ].join('');
}

function signalDot(s) {
  return `<span class="dot ${s.severity}" title="${esc(s.why)}">${esc(s.kind.replace(/-/g, ' '))}</span>`;
}

/**
 * How much of the mosaic a zone claims. Three tiers, not four: the first draft's
 * fourth tier was the same width as the third at half the height, which read as
 * noise rather than as "smaller", and its tiles were too short to show any
 * description at all — a block whose whole job is to explain itself, unable to.
 */
function spanFor(lines, total) {
  const share = total ? lines / total : 0;
  if (share >= 0.1) return 'sp-xl';
  if (share >= 0.04) return 'sp-lg';
  return 'sp-sm';
}

/**
 * @param {object} z - one survey zone.
 * @param {number} total - survey.totalLines, for sizing.
 * @param {{rungsByEffect: Map<string,Array>, workitemByRef: Map<string,object>, gradeByRef: Map<string,object>, perfByEffect: Record<string,object>, perfCapturedAt: string|null}} ctx
 */
function zoneBlock(z, total, ctx) {
  const L = [];
  const tone = z.warnCount ? 'warn' : z.watchCount ? 'watch' : 'ok';
  // `<details>` rather than a click handler: no JS, and `open` is one of the
  // states the live-doc contract keeps view-local by definition — nothing to
  // wire up for the drill-down to work.
  L.push(`<details class="zone ${spanFor(z.lines, total)} t-${tone}">`);
  L.push(`<summary class="zhead">`);
  L.push(`<div class="zrow"><h3>${esc(z.name)}</h3>`);
  L.push(`<span class="kindtag">${z.effectId ? 'effect' : 'engine'}</span>`);
  const effectGrade = z.effectId ? ctx.gradeByRef.get(`effect:${z.effectId}`) : null;
  if (effectGrade) L.push(gradeChip(effectGrade.grade));
  L.push(`</div>`);
  L.push(
    `<p class="zmeta">${z.lines.toLocaleString()} lines · ${z.fileCount} file${z.fileCount === 1 ? '' : 's'}` +
      (z.lastTouched ? ` · ${esc(z.lastTouched)}` : '') +
      `</p>`
  );
  // The plain-English line: the LARGEST file's own header, because in every zone
  // here the biggest module is the one that names what the zone is for.
  const lead = z.files[0];
  if (lead?.summary) L.push(`<p class="zblurb">${esc(lead.summary)}</p>`);
  const perf = z.effectId ? ctx.perfByEffect[z.effectId] : undefined;
  const flags = [
    ...z.zoneSignals.map(signalDot),
    z.warnCount ? `<span class="dot warn">${z.warnCount}</span>` : '',
    z.watchCount ? `<span class="dot watch">${z.watchCount}</span>` : '',
    z.effectId ? perfChip(perf, ctx.perfCapturedAt) : '',
  ].filter(Boolean);
  L.push(`<div class="zfoot">${flags.join('')}<span class="chev">open</span></div>`);
  L.push(`</summary>`);

  L.push(`<div class="zbody">`);

  // Grading and the rung/feature ladder live in the dedicated EFFECTS section
  // now, addressed by `effect:<id>`/`rung:<id>:<name>` directly rather than
  // routed through a zone match — a zone is a fact about a DIRECTORY, and 9 of
  // 15 effects are root-level files with no directory of their own, so tying
  // grading to zone membership left them permanently ungradeable. A zone note
  // stays here for code-structure concerns (this directory, these files), a
  // different question from "is this effect any good".
  if (z.effectId) L.push(`<p class="zblurb">Grade this effect and its features under Effects, above.</p>`);
  L.push(noteBox(`zone:${z.name}`, `What should change about ${z.effectId ? 'this directory' : 'this area'}?`));

  L.push(`<ol class="files">`);
  for (const f of z.files) {
    L.push(`<li class="file${f.signals.length ? ' flagged' : ''}">`);
    L.push(
      `<div class="frow"><code>${esc(f.path.replace(/^src\//, ''))}</code>` +
        `<span class="flines">${f.lines.toLocaleString()}</span></div>`
    );
    if (f.summary) L.push(`<p class="fsum">${esc(f.summary)}</p>`);
    if (f.signals.length) L.push(`<div class="zfoot">${f.signals.map(signalDot).join('')}</div>`);
    L.push(noteBox(`file:${f.path}`, 'Note about this file'));
    L.push(`</li>`);
  }
  L.push(`</ol></div></details>`);
  return L.join('');
}

/**
 * ONE EFFECT, addressable regardless of whether it owns a directory of its
 * own — the direct fix for *"this needs to be for all effects and even all
 * parts of all effects"*. Iterates `measureEffectRungs`'s own rows, which
 * cover every manifest the effects door discovers (15, currently), so a 16th
 * effect needs no edit here — same discovery rule as everywhere else on this
 * page.
 *
 * @param {object} e - one row of `measureEffectRungs(manifests).rows`.
 * @param {{rungsByEffect: Map<string,Array>, workitemByRef: Map<string,object>, gradeByRef: Map<string,object>, confirmByRef: Map<string,object>, perfByEffect: Record<string,object>, perfCapturedAt: string|null}} ctx
 */
function effectCard(e, ctx) {
  const grade = ctx.gradeByRef.get(`effect:${e.id}`);
  const confirm = ctx.confirmByRef.get(`effect:${e.id}`);
  const rungs = ctx.rungsByEffect.get(e.id) ?? [];
  const built = rungs.filter((r) => r.built);
  const deferred = rungs.filter((r) => !r.built);
  const perf = ctx.perfByEffect[e.id];
  // Tone the tile by the grade, if one exists — an ungraded effect gets the
  // neutral border every closed tile starts with, not a false "ok".
  const tone = grade ? gradeTone(grade.grade) : '';
  const L = [`<details class="zone sp-sm${tone ? ` t-${tone}` : ''}">`];
  L.push(`<summary class="zhead">`);
  L.push(`<div class="zrow"><h3>${esc(e.title)}</h3><span class="kindtag">${esc(e.id)}</span></div>`);
  L.push(`<p class="zmeta">${e.built} built · ${e.deferred} deferred rung${e.deferred === 1 ? '' : 's'}</p>`);
  const flags = [grade ? gradeChip(grade.grade) : '', perfChip(perf, ctx.perfCapturedAt)].filter(Boolean);
  L.push(`<div class="zfoot">${flags.join('')}<span class="chev">open</span></div>`);
  L.push(`</summary>`);

  L.push(`<div class="zbody">`);
  L.push(`<div class="effecthead">`);
  L.push(`<div class="gradewrap"><span class="glabel">Grade the effect as a whole</span>`);
  L.push(gradePicker(`effect:${e.id}`, grade?.grade ?? null));
  L.push(confirmPicker(`effect:${e.id}`, confirm));
  L.push(`</div>`);
  L.push(noteBox(`effect:${e.id}`, 'What should change about this effect as a whole?', { withTicks: false }));
  L.push(`</div>`);
  if (rungs.length) {
    L.push(`<h4 class="fsub">Features <span class="count">${rungs.length}</span></h4>`);
    L.push(`<div class="rungs">`);
    for (const r of [...built, ...deferred]) {
      L.push(
        rungBlock(r, {
          workitem: ctx.workitemByRef.get(r.ref),
          grade: ctx.gradeByRef.get(r.ref),
          confirm: ctx.confirmByRef.get(r.ref),
        })
      );
    }
    L.push(`</div>`);
  }
  L.push(`</div></details>`);
  return L.join('');
}

function gapBlock(g) {
  return [
    `<article class="gap k-${g.kind}">`,
    `<div class="grow"><code>${esc(g.label)}</code>`,
    g.weight > 1 ? `<span class="gw">${g.weight} V2 systems</span>` : '',
    `</div>`,
    `<p class="gwhy">${esc(g.why)}</p>`,
    g.detail ? `<p class="fsum">${esc(g.detail.slice(0, 200))}</p>` : '',
    noteBox(`gap:${g.id}`, 'Want this? Say what it should do.'),
    `</article>`,
  ].join('');
}

/** 'A+' is not a legal bare CSS class token — the + needs escaping everywhere or nowhere. */
function gradeSlug(g) {
  return g.replace('+', 'p');
}

/**
 * Colour tier for a grade. My own mapping, not the author's words — flagged so
 * it is easy to correct rather than mistaken for something he specified. S/A+/A
 * read as healthy, B/C as worth watching (matches his own "solid C… nice stuff
 * happening but not complete"), D/F as a real problem.
 */
function gradeTone(g) {
  if (['S', 'A+', 'A'].includes(g)) return 'ok';
  if (['B', 'C'].includes(g)) return 'watch';
  return 'warn';
}

function gradeChip(g) {
  return `<span class="gradechip gr-${gradeSlug(g)} t-${gradeTone(g)}" title="Graded by Ingram">${esc(g)}</span>`;
}

/**
 * A row of radio buttons, one per grade. `checked` state on a radio input is
 * captured by the live-doc runtime exactly like a checkbox's — a click here
 * reaches me as a real document edit, same mechanism as everything else on
 * this page, nothing new to build for it to work.
 *
 * `name` alone (`grade-<ref>`) is the address I read back later; no separate
 * `data-*` attribute needed on top of it.
 *
 * @param {string} ref - 'effect:water' or 'rung:water:refraction'.
 * @param {string|null} current - the currently-recorded grade, if any.
 */
export function gradePicker(ref, current) {
  const opts = GRADES.map(
    (g) =>
      `<label class="gopt gr-${gradeSlug(g)}"><input type="radio" name="grade-${esc(ref)}" value="${esc(g)}"${
        g === current ? ' checked' : ''
      }><span>${esc(g)}</span></label>`
  ).join('');
  return `<div class="gradepick" role="radiogroup" aria-label="Grade ${esc(ref)}">${opts}</div>`;
}

/**
 * THE AUTHORITY LINE, as a control: *"You can only confirm that you built
 * something, I am the only one capable of confirming if it really landed."*
 * A grade is a quality verdict; this is the narrower, binary one underneath
 * it — has Ingram actually watched this run in a real scene at all — and it
 * sits directly beside the grade picker rather than folded inside a note, so
 * it is never mistaken for a lower-stakes "I glanced at the code" checkbox.
 *
 * Two checkboxes, not one three-state control: "not yet looked at", "seen
 * working", and "seen, and it's wrong" are three real states, and a single
 * checkbox can only ever hold two.
 *
 * @param {string} ref - 'effect:water' or 'rung:water:refraction'.
 * @param {{seenWorking?: boolean, wrong?: boolean}|null} current
 */
export function confirmPicker(ref, current) {
  const seen = current?.seenWorking === true;
  const wrong = current?.wrong === true;
  return (
    `<div class="ticks confirmwrap">` +
    `<label class="tick"><input type="checkbox" data-confirm-seen="${esc(ref)}"${seen ? ' checked' : ''}>` +
    `<span>✓ Live confirmed working</span></label>` +
    `<label class="tick bad"><input type="checkbox" data-confirm-wrong="${esc(ref)}"${wrong ? ' checked' : ''}>` +
    `<span>✕ Not working</span></label>` +
    `</div>`
  );
}

const WORKITEM_STATE_LABEL = Object.freeze({
  requested: 'Requested — checklist not written yet',
  planned: 'Planned — checklist ready, work not started',
  'in-progress': 'In progress',
  'awaiting-eyes': 'Checklist complete — awaiting your eyes on a real scene',
});

/** The checklist itself — READ-ONLY here. I tick items by editing the source file and regenerating, the same way any other derived fact on this page changes; nobody ticks these by clicking in the browser. */
function checklistView(item) {
  const state = deriveWorkItemState(item);
  const list = item.checklist ?? [];
  const L = [`<div class="checklist"><p class="wistate st-${state}">${esc(WORKITEM_STATE_LABEL[state])}</p>`];
  if (item.ask) L.push(`<p class="fsum"><em>Asked:</em> ${esc(item.ask)}</p>`);
  if (list.length) {
    L.push('<ul class="steps">');
    for (const c of list) L.push(`<li class="${c.done ? 'done' : ''}">${c.done ? '✓' : '○'} ${esc(c.text)}</li>`);
    L.push('</ul>');
  }
  L.push('</div>');
  return L.join('');
}

/**
 * One feature — a built tier or a deferred rung — as an addressable block:
 * grade (built only), checklist (if a work item was requested), and a note box
 * to ask for it. This is the literal answer to "click water, click refraction,
 * type a note."
 *
 * @param {{ref: string, name: string, built: boolean, note: string}} r
 * @param {{workitem?: object, grade?: object, confirm?: object}} ctx
 */
function rungBlock(r, ctx) {
  const L = [`<div class="rung${r.built ? ' built' : ''}">`];
  L.push(
    `<div class="rrow"><code>${esc(r.name)}</code>${chip(r.built ? 'built' : 'not built', r.built ? 's-live' : 's-deferred')}` +
      (ctx.grade ? gradeChip(ctx.grade.grade) : '') +
      `</div>`
  );
  if (r.note) L.push(`<p class="fsum">${esc(r.note.slice(0, 220))}${r.note.length > 220 ? '…' : ''}</p>`);
  if (ctx.workitem) L.push(checklistView(ctx.workitem));
  if (r.built) {
    L.push(gradePicker(r.ref, ctx.grade?.grade ?? null));
    L.push(confirmPicker(r.ref, ctx.confirm ?? null));
  }
  L.push(
    noteBox(r.ref, ctx.workitem ? "Add to what's already asked for" : `Want ${r.name}? Say what it should do.`, {
      withTicks: !r.built,
    })
  );
  L.push('</div>');
  return L.join('');
}

/**
 * The one honest performance line an effect can carry: a real number from a
 * real capture, dated, or a plain statement that none exists — never a guess
 * standing in for either.
 */
function perfChip(perf, capturedAt) {
  if (!perf)
    return `<span class="dot" title="No entry for this effect in the last perf capture at all.">perf n/a</span>`;
  if (!perf.enabled) {
    return `<span class="dot" title="Disabled in the scene that was captured, so its real cost wasn't exercised.">perf: off when captured</span>`;
  }
  if (perf.costMs == null) {
    return `<span class="dot watch" title="Declared but not cleanly measured this run — zone coverage was '${esc(perf.coverage)}'.">perf: unmeasured</span>`;
  }
  const tone = perf.verdict === 'over' ? 'warn' : perf.verdict === 'under' ? 'ok' : '';
  return `<span class="dot ${tone}" title="Measured ${esc(capturedAt ?? 'date unknown')}: ${perf.costMs}ms/frame, ${esc(perf.verdict)} its own declared budget. This is one capture, not a live reading.">perf ${perf.costMs}ms (${esc(capturedAt ?? '?')})</span>`;
}

function bugCard(b) {
  return [
    `<article class="jcard bugcard${b.flagged ? ' flagged' : ''}">`,
    `<header><code>#${b.id}</code>${b.statuses.map((s) => chip(s, 's-' + s.split(' ')[0])).join('')}</header>`,
    `<p class="legs">${esc(b.title)}</p>`,
    `<p class="note">${esc(b.subsystem)}</p>`,
    `</article>`,
  ].join('');
}

function judgementCard(j, label) {
  const bar = j.valueBy === 'ingram' ? '' : ' unconfirmed';
  return [
    `<article class="jcard${bar}">`,
    `<header><code>${esc(j.ref)}</code>${chip(j.effort, 'e-' + j.effort)}${chip(j.value, 'v-' + j.value)}</header>`,
    j.backOnItsLegs ? `<p class="legs">${esc(j.backOnItsLegs)}</p>` : '',
    j.note ? `<p class="note">${esc(j.note)}</p>` : '',
    j.valueBy !== 'ingram' ? `<p class="pending">◇ value proposed, not yet your call</p>` : '',
    label ? `<p class="note">${esc(label)}</p>` : '',
    `</article>`,
  ].join('');
}

/**
 * The LANTERN palette re-expressed for a host that owns the `<html>` element.
 *
 * `src/ui/tokens.js` scopes its colours to `html[data-theme="…"]`, which is right
 * inside Foundry (the module sets the attribute itself) and wrong anywhere the
 * attribute may be absent — with no `data-theme`, NO colour token is defined at
 * all and the page renders unstyled. So the tokens are re-emitted here against
 * the three states a hosted page actually sees: none stamped (follow the OS),
 * `data-theme="dark"`, `data-theme="light"`.
 *
 * Dark-first, because that is what LANTERN is and what a map renderer's own
 * tooling should look like: bare `:root` carries the DARK palette, and light is
 * the override. Values come from `getThemeTokens` — read, never re-typed, so the
 * two cannot drift.
 *
 * @param {(theme: string) => Record<string, string>} getThemeTokens
 * @param {string} sharedCss - tokensCSS() output, for the shape/motion half.
 */
export function themeBlocks(getThemeTokens, sharedCss) {
  const decl = (t) =>
    Object.entries({ ...getThemeTokens(t), ...warmNeutrals(t) })
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
  const dark = decl('dark');
  const light = decl('light');
  // `getThemeTokens` already merges the shared shape/motion tokens into each
  // theme, so tokensCSS()'s own `:root` and `html[data-theme=…]` token rules
  // would be duplicates here — and worse, the `html[…]` ones would still match
  // if the HOST stamps a theme, leaving two rules claiming the same variables.
  // Strip them and keep only the utility rules (.ico, .num, :focus-visible,
  // reduce-motion), which have no theme-scoped twin.
  const utilities = String(sharedCss)
    .replace(/:root\{[^}]*\}/g, '')
    .replace(/html\[data-theme="[a-z]+"\]\{[^}]*\}/g, '')
    .trim();
  return [
    utilities,
    `:root{${dark}}`,
    // An explicit dark choice must beat a light OS, and vice versa — so the
    // media query is guarded, and both attribute states are stated outright.
    `@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){${light}}}`,
    `:root[data-theme="light"]{${light}}`,
    `:root[data-theme="dark"]{${dark}}`,
  ].join('\n');
}

/**
 * THE FRESHNESS STAMP — the answer to "can this be ignored or grow stale."
 *
 * A dashboard that only says WHEN it was generated is honest but useless for
 * catching drift: a date doesn't tell you whether anything has actually
 * changed since. This hashes every field of the model that actually reaches
 * the page — every derived number, every judgement note, every survey block —
 * into one short id. Two builds from identical underlying reality produce the
 * identical fingerprint; ANY drift (a pass ships, a bug closes, a note gets
 * edited) changes it. That is what lets "is this page stale" be answered by
 * comparing two short strings instead of re-deriving the whole page by eye.
 *
 * Deliberately excludes `tokensCss`, `generatedAt` and `mode` — presentation
 * and metadata, not content. Excluding `mode` is itself load-bearing: the
 * standalone and hosted builds render the SAME data through two different
 * shells, so they get the SAME fingerprint, which is what lets the checked-in
 * `index.html` and the published artifact be compared against each other, not
 * only against source.
 *
 * @param {object} model
 * @returns {string} a 12-hex-char id.
 */
export function computeFingerprint(model) {
  const { generatedAt: _generatedAt, tokensCss: _tokensCss, mode: _mode, ...content } = model;
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
      return out;
    }
    return v;
  };
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(content)))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Read the fingerprint back out of a previously-rendered page. The other half
 * of `computeFingerprint` — together they are the whole freshness check: build
 * fresh, extract stored, compare.
 *
 * @param {string} html
 * @returns {string|null}
 */
export function extractFingerprint(html) {
  return /<!-- chart-room-fingerprint: ([0-9a-f]{12}) -->/.exec(String(html))?.[1] ?? null;
}

/**
 * Build the page. Pure: every fact arrives in `model`, including the timestamp —
 * `Date.now()` in here would make the output untestable and churn the
 * checked-in file on every run.
 *
 * `mode: 'artifact'` emits body content only (no doctype/html/head/body), for a
 * host that supplies its own document shell.
 *
 * @param {object} model
 * @returns {string}
 */
export function renderHtml(model) {
  const {
    generatedAt,
    tokensCss,
    pillars,
    pillarScore,
    passCov,
    effects,
    tri,
    blind,
    ledgerErrors,
    bugs,
    holyActivity,
    nothingBuiltDrift,
    survey,
    gaps,
    doneSince,
    rungs,
    grades,
    workitems,
    confirmations,
    perf,
  } = model;
  const artifact = model.mode === 'artifact';
  const gradeByRef = new Map(grades.map((g) => [g.ref, g]));
  const workitemByRef = new Map(workitems.map((w) => [w.ref, w]));
  const confirmByRef = new Map(confirmations.map((c) => [c.ref, c]));
  const rungsByEffect = new Map();
  for (const r of rungs) {
    if (!rungsByEffect.has(r.effectId)) rungsByEffect.set(r.effectId, []);
    rungsByEffect.get(r.effectId).push(r);
  }
  const effectCtx = {
    rungsByEffect,
    workitemByRef,
    gradeByRef,
    confirmByRef,
    perfByEffect: perf.byEffect,
    perfCapturedAt: perf.capturedAt,
  };
  const zoneCtx = {
    rungsByEffect,
    workitemByRef,
    gradeByRef,
    perfByEffect: perf.byEffect,
    perfCapturedAt: perf.capturedAt,
  };
  // Computed ONCE, from THIS exact model, so the number embedded in the page
  // and the number a checker recomputes from the same data can never disagree
  // by construction — there is no second code path that could drift from this
  // one.
  const fingerprint = computeFingerprint(model);
  const L = [];
  const p = (...s) => L.push(...s);

  if (!artifact) {
    p('<!doctype html>');
    p('<html lang="en" data-theme="dark">');
    p('<head>');
    p('<meta charset="utf-8">');
    p('<meta name="viewport" content="width=device-width, initial-scale=1">');
  }
  p('<title>The Chart Room</title>');
  // Machine-extractable regardless of mode — a plain HTML comment survives
  // being embedded in someone else's <body>, unlike a <meta> tag, which a
  // stricter host could relocate or drop.
  p(`<!-- chart-room-fingerprint: ${fingerprint} -->`);
  p(`<style>${tokensCss}</style>`);
  p(`<style>${PAGE_CSS}</style>`);
  if (!artifact) {
    p('</head>');
    p('<body>');
  }

  // ── header ────────────────────────────────────────────────────────────────
  // ONE continuous document, not four hidden views behind a tab switcher — the
  // author's own ask: "let's make everything into a single interface." The nav
  // below is plain anchor links (native browser scroll, zero JS, zero
  // per-viewer state to manage) rather than show/hide state, which also
  // sidesteps the live-doc trap the old tab mechanism existed to avoid in the
  // first place: there is no view state left that COULD leak into the shared
  // document, because there is no longer a view to switch.
  p('<header class="top">');
  p('<div class="brand"><span class="lamp"></span><h1>The Chart Room</h1></div>');
  p(
    `<div class="meta">Map Shine Advanced · generated ${esc(generatedAt)} · ` +
      `<span class="fp" title="A hash of everything derived on this page. Two builds of the same reality produce the same fingerprint — ask me to compare this against a fresh run if you doubt it.">fp ${fingerprint}</span></div>`
  );
  p('<nav class="jump">');
  p('<a href="#effects">Effects</a>');
  p('<a href="#module">Module</a>');
  p('<a href="#worth-doing">Worth doing</a>');
  p(
    `<a href="#critical">Critical${bugs.openBugs.length ? ` <span class="tabbadge">${bugs.openBugs.length}</span>` : ''}</a>`
  );
  p('<a href="#signals">Signals</a>');
  p('</nav>');
  p('</header>');

  if (ledgerErrors.length) {
    p('<section class="alarm"><h2>A ledger is broken</h2><ul>');
    for (const e of ledgerErrors) p(`<li>${esc(e)}</li>`);
    p('</ul></section>');
  }

  p('<main>');

  // Honest, not aspirational: notes/grades typed here are SAVED into this
  // document, but nothing on the page pushes a live notification — I only see
  // them when I next open or re-fetch it. Comments (mention @claude) is the
  // one thing that actually reaches me right away; it is platform chrome, not
  // something this generator renders, hence the plain-English pointer rather
  // than a fake "Sync" button that couldn't do what its name promised.
  p(
    '<p class="syncnote">📝 Notes and grades below save to this page automatically, but nothing here pings me the ' +
      'moment you leave one — I read them next time I open it. For something you want acted on now, use this ' +
      "page's <b>Comments</b> and mention <b>@claude</b> — that reaches me live.</p>"
  );

  // ── GAUGES — the strategic view, before the detail ────────────────────────
  p('<section class="gauges">');
  p('<div class="gcard hero">');
  p('<h2>V2 parity</h2><p class="sub">as the 13 pillars grade themselves</p>');
  p(gauge(pillarScore.pct, 'gold'));
  p(
    `<p class="reading">${pct1(pillarScore.pctExByDesign)} if Vision &amp; Fog is excluded — it stays Foundry's ` +
      'by design, not by shortfall.</p>'
  );
  p('<details><summary>Show the workings</summary><table class="work">');
  p('<tr><th>Pillar</th><th>Grade</th><th>Score</th></tr>');
  for (const pl of pillars) {
    p(
      `<tr${pl.byDesign ? ' class="bydesign"' : ''}><td>${pl.n}. ${esc(pl.name)}</td>` +
        `<td>${pl.grades.map((g) => chip(g, 'g-' + g)).join('')}</td><td class="num">${pl.score.toFixed(2)}</td></tr>`
    );
  }
  p('</table>');
  p(
    '<p class="fine">Grades are the Testament\'s own, parsed from its Book II headings — a different scale from the ' +
      'S–F grades below, which are yours alone. The numbers behind THIS scale ' +
      `(${Object.entries(PILLAR_GRADES)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}) are the only invented part.</p>`
  );
  p('</details></div>');

  p('<div class="gcard">');
  p('<h2>V2 coverage</h2><p class="sub">V2 systems absorbed by a pass that runs</p>');
  p(gauge(passCov.pct, 'blue'));
  p(
    `<p class="reading">${passCov.absorbsLive} of ${passCov.absorbsTotal} V2 classes · ` +
      `${passCov.byStatus.live}/${passCov.total} passes live (${pct1(passCov.passPct)})</p>`
  );
  p('<details><summary>Why these two numbers differ</summary>');
  p(
    `<p class="fine">Counting passes gives ${pct1(passCov.passPct)}; counting the V2 systems they absorb gives ` +
      `${pct1(passCov.pct)}. Nothing here means "complete" — every live pass carries its own written caveat.</p>`
  );
  p('<table class="work"><tr><th>Not live</th><th>V2 systems stranded</th></tr>');
  for (const s of passCov.stranded) {
    p(
      `<tr><td><code>${esc(s.id)}</code> ${chip(s.status, 's-' + s.status)}</td>` +
        `<td class="num">${s.count}</td></tr>` +
        `<tr class="sub-row"><td colspan="2">${esc(s.absorbs.join(' · '))}</td></tr>`
    );
  }
  p('</table></details></div>');

  p('<div class="gcard">');
  p('<h2>V4 scope</h2><p class="sub">rungs built vs the intended ceiling</p>');
  p(gauge(effects.pct, 'violet'));
  p(
    `<p class="reading">${effects.built} built · ${effects.deferred} deferred, across ${effects.rows.length} effects</p>`
  );
  p('<details><summary>Why this is not the parity number</summary>');
  p(
    '<p class="fine"><code>deferredRungs</code> records the V4 ceiling, some of which V2 never had. Measured as ' +
      'parity it would report the project as further behind the higher it aims.</p></details></div>'
  );
  p('</section>');

  // ── DONE SINCE JUDGED — the anti-drift check, made visible ────────────────
  if (doneSince.length) {
    p('<section class="strip resolved"><h2>Done since judged <span class="count">' + doneSince.length + '</span></h2>');
    p('<p class="sub">Open work when written; the underlying pass/effect/pillar has since moved on its own.</p>');
    p('<div class="cards">');
    for (const j of doneSince) p(judgementCard(j, '✓ resolved — this note is now history, not a task'));
    p('</div></section>');
  }

  // ── EFFECTS — every effect, addressable regardless of directory shape ─────
  // "This needs to be for all effects and even all parts of all effects" —
  // every row `measureEffectRungs` discovers gets its own card here, whether
  // or not it owns a directory a zone can key off. Ordered by visualWeight,
  // same as the gauge's own "what to defend first" logic.
  p('<section id="effects" class="strip">');
  p(`<h2>Effects <span class="count">${effects.rows.length}</span></h2>`);
  p(
    '<p class="sub">Grade any effect, or any of its built features, and mark whether you\'ve actually watched it ' +
      'run on a real scene — the grade is a quality call, the confirm buttons are the narrower "I saw this ' +
      'happen" one underneath it. Click a card open for its checklist and its own note.</p>'
  );
  p('<div class="mosaic">');
  for (const e of effects.rows) p(effectCard(e, effectCtx));
  p('</div>');
  p('</section>');

  // ── MODULE — the project as it lives, click in, grade what's done ─────────
  p('<section id="module" class="strip">');
  p('<div class="figures">');
  p(`<div class="fig"><b>${survey.totalLines.toLocaleString()}</b><span>lines of code</span></div>`);
  p(`<div class="fig"><b>${survey.totalFiles}</b><span>files, all self-describing</span></div>`);
  p(`<div class="fig"><b>${survey.zones.length}</b><span>areas</span></div>`);
  p(
    `<div class="fig${survey.warnCount ? ' hot' : ''}"><b>${survey.warnCount}</b><span>worth a proper look</span></div>`
  );
  p('</div>');
  p(
    `<p class="lede">Each block is an area of the module, sized by how much code is in it — click one open for ` +
      `its files and a note about the directory itself. Grading and features live under Effects, above; this is ` +
      `the code, not the feature list. Every description is the file's <em>own</em> header, never written here.</p>`
  );
  p('<div class="legend">');
  p('<span class="key"><i class="sw ok"></i>nothing flagged</span>');
  p('<span class="key"><i class="sw watch"></i>worth watching</span>');
  p('<span class="key"><i class="sw warn"></i>a named problem</span>');
  p('<span class="key"><i class="sw dash"></i>a gap — wanted, not built</span>');
  p('</div>');

  p('<div class="mosaic">');
  for (const z of survey.zones) p(zoneBlock(z, survey.totalLines, zoneCtx));
  p('</div>');

  // Only PASS-kind gaps stay flat here — a RUNG gap now lives inside its own
  // effect's block above, addressable and gradeable in place, not duplicated
  // in a second list nothing else points back to.
  const gapPasses = gaps.filter((g) => g.kind === 'pass');
  p(`<h3 class="gsub">Pipeline gaps <span class="count">${gapPasses.length}</span></h3>`);
  p(
    '<p class="sub">Whole passes declared in <code>src/graph/passes.js</code> and not running — cross-cutting ' +
      "stages, not one effect's own feature, which is why they sit here instead of inside a block.</p>"
  );
  p('<div class="gaps">');
  for (const g of gapPasses) p(gapBlock(g));
  p('</div>');
  p('</section>');

  // ── critical: the author's own open bug list ─────────────────────────────
  // This is the "critical items" half of the original ask, kept structurally
  // separate from the milestone/wishlist triage below — a bug is a defect on a
  // real scene, not a feature to size and schedule.
  p('<section class="strip" id="critical">');
  p(`<h2>Critical <span class="count">${bugs.openBugs.length}</span></h2>`);
  p(
    '<p class="sub">Open items from <code>docs/planning/Bug-Tracker.md</code> — defects the author reported on a ' +
      "real scene, not yet fixed. Parsed from the doc's own index table, every generation.</p>"
  );
  p('<div class="cards">');
  if (!bugs.openBugs.length) p('<p class="empty">Nothing open.</p>');
  for (const b of bugs.openBugs) p(bugCard(b));
  p('</div></section>');

  // ── WORTH DOING — strategic effort/value calls: passes, pillars, whole V2
  // classes that have no single effect-zone home. Rung-level requests now live
  // inside their own block above; this is the coarser, cross-cutting layer.
  p('<section id="worth-doing" class="strip">');
  p(
    '<h2>Worth doing <span class="count">' +
      (tri.easyWins.length + tri.grind.length + tri.cutList.length + tri.pile.length) +
      '</span></h2>'
  );
  p(
    '<p class="sub">Effort/value calls on passes, whole effects, pillars and V2 classes — the strategic layer ' +
      'above individual features. Mine to propose, yours to confirm (dashed border = not yet your call).</p>'
  );
  const strip = (id, title, blurb, items) => {
    p(`<h3 class="gsub" id="${id}">${esc(title)} <span class="count">${items.length}</span></h3>`);
    p(`<p class="sub">${blurb}</p>`);
    p('<div class="cards">');
    if (!items.length) p('<p class="empty">Nothing here yet.</p>');
    for (const j of items) p(judgementCard(j));
    p('</div>');
  };
  strip('easy', 'Easy wins', 'Worth having, and not expensive. Start here.', tri.easyWins);
  strip('grind', 'The grind', 'Worth having, and genuinely hard. Sized honestly, not hidden.', tri.grind);
  strip('cut', 'The cut list', 'Proposed for dropping — V2 had it, and we may simply not want it.', tri.cutList);
  strip('pile', 'The pile', 'Real, but nobody is waiting for it.', tri.pile);

  p(`<h3 class="gsub">Not yet placed <span class="count">${blind.length}</span></h3>`);
  p(
    '<p class="sub">Unfinished work carrying no effort/value call — shown rather than omitted so the page cannot ' +
      'read as complete when it is not.</p>'
  );
  p('<ul class="blind">');
  for (const b of blind) p(`<li><code>${esc(b.ref)}</code> — ${esc(b.why)}</li>`);
  if (!blind.length) p('<li class="empty">Everything unfinished has been placed.</li>');
  p('</ul>');
  p('</section>');

  // ── SIGNALS ───────────────────────────────────────────────────────────────
  // Where the docs disagree with THEMSELVES, and how much recorded activity a
  // holy doc's petitions carry against what its own checklist shows — surfaced,
  // never resolved on the author's behalf. A plain anchor target, not its own
  // strip — the two real sections below (Drift, Holy doc activity) are.
  p('<div id="signals">');

  p(
    '<section class="strip"><h2>Drift <span class="count">' +
      (bugs.indexOnly.length + bugs.bodyOnly.length + bugs.nonCanonical.length + nothingBuiltDrift.length) +
      '</span></h2>'
  );
  p(
    '<p class="sub">Structural disagreements found by DIFFING two halves of the same doc against each other — ' +
      'never a hardcoded list of "the drifts I found once". A doc that drifts a new way in the future is caught ' +
      'the same way this one was.</p>'
  );
  p('<div class="cards">');
  let anyDrift = false;
  if (bugs.indexOnly.length) {
    anyDrift = true;
    p(
      `<article class="jcard drift"><header>${chip('bug tracker', 'v-essential')}</header>` +
        `<p class="legs">Bug(s) ${bugs.indexOnly.map((n) => '#' + n).join(', ')} appear in the Index table but have ` +
        `no numbered entry in the body.</p></article>`
    );
  }
  if (bugs.bodyOnly.length) {
    anyDrift = true;
    p(
      `<article class="jcard drift"><header>${chip('bug tracker', 'v-essential')}</header>` +
        `<p class="legs">Bug(s) ${bugs.bodyOnly.map((n) => '#' + n).join(', ')} have a numbered entry in the body ` +
        `but are missing from the Index table — invisible to anyone reading the summary alone.</p></article>`
    );
  }
  for (const nc of bugs.nonCanonical) {
    anyDrift = true;
    p(
      `<article class="jcard drift"><header>${chip('vocabulary', 'v-strong')}</header>` +
        `<p class="legs">${esc(nc.where)} uses status <code>${esc(nc.status)}</code>, which is not one of the ` +
        `doc's own declared vocabulary words.</p></article>`
    );
  }
  for (const d of nothingBuiltDrift) {
    anyDrift = true;
    p(
      `<article class="jcard drift"><header>${chip('header vs body', 'v-strong')}</header>` +
        `<p class="legs"><code>${esc(d.path)}</code> — header says "${esc(d.claim)}", but the body records ` +
        `${d.builtCount} \`BUILT\`/\`LIVE\` item(s).</p></article>`
    );
  }
  if (!anyDrift) p('<p class="empty">None found this run.</p>');
  p('</div></section>');

  p('<section class="strip"><h2>Holy doc activity <span class="count">' + holyActivity.length + '</span></h2>');
  p(
    '<p class="sub">Raw counts, not a verdict — a doc with many petitions and few checked boxes may mean the ' +
      'checklist fell behind, or may mean the petitions cover a different section. Shown so you can judge it, ' +
      'not so the page can.</p>'
  );
  p(
    '<table class="work"><tr><th>Doc</th><th>Open</th><th>Done</th><th>✠</th><th>⚑</th><th>Petitions</th><th>Last touched</th></tr>'
  );
  for (const h of holyActivity) {
    p(
      `<tr><td><code>${esc(h.name)}</code></td><td class="num">${h.open}</td><td class="num">${h.done}</td>` +
        `<td class="num">${h.countersigned}</td><td class="num">${h.reopened}</td><td class="num">${h.petitions}</td>` +
        `<td class="num">${esc(h.lastTouched ?? '—')}</td></tr>`
    );
  }
  p('</table></section>');
  p('</div>');

  p('</main>');

  p('<footer class="foot">');
  p(
    'Derived from <code>src/graph/passes.js</code>, the effect manifests, <code>docs/holy/V4-Testament.md</code>, ' +
      '<code>docs/planning/Bug-Tracker.md</code>, the last perf capture, and every doc under <code>docs/holy/</code> ' +
      'and <code>docs/planning/</code>. Three hand-written files carry what nothing else can: ' +
      '<code>judgements.json</code> (effort/value, proposed by me), <code>workitems.json</code> (checklists, ' +
      'authored and ticked by me), <code>grades.json</code> (the S–F verdict, written only by you). ' +
      'Regenerate with <code>node tools/chart-room/build-chart-room.mjs</code>, check freshness with ' +
      '<code>--check</code>.'
  );
  p('</footer>');

  const js = artifact ? ARTIFACT_JS : PAGE_JS;
  if (js) p(`<script>${js}</script>`);
  if (!artifact) p('</body></html>');
  return L.join('\n');
}

/**
 * ⚠️ THIS PAGE HAS NO SCRIPTED UI STATE AT ALL — AND THAT IS THE POINT.
 *
 * The old multi-tab draft needed a `data-local-*` attribute + a click handler
 * to switch views without leaking one viewer's navigation into the shared live
 * doc (any DOM change a gesture makes, including a toggled class, is journaled
 * and broadcast to every other view). Restructuring into ONE continuous
 * document with plain anchor links (`<a href="#module">`) removed the need for
 * that mechanism entirely — there is no view state left to manage, local or
 * shared, because there is no longer a view to switch.
 *
 * What remains per-viewer by the CONTRACT rather than by any script here:
 * `open` on every `<details>` (zone drill-down, the note fold) and `checked`
 * on nothing that isn't a real grade/verdict input — those two rules are what
 * let this file stay empty on the artifact build.
 */
const SHARED_JS = ``;

/** The hosted build never stamps a theme — it inherits the viewer's, and needs no script of its own. */
const ARTIFACT_JS = SHARED_JS;

/** Standalone only needs a default theme stamp; there is nothing else left to wire up. */
const PAGE_JS = `document.documentElement.dataset.theme ||= 'dark';`;

const PAGE_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg0);color:var(--ink0);font:14px/1.55 var(--font)}
code{font-family:var(--mono);font-size:.92em;color:var(--ink1)}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:.2px;text-wrap:balance}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:var(--sp4);flex-wrap:wrap;
  padding:var(--sp4) var(--sp5);background:var(--glass);backdrop-filter:blur(var(--glass-blur));
  border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:var(--sp2)}
.brand h1{font-size:var(--t1);font-weight:500;letter-spacing:.3px}
.lamp{width:12px;height:12px;border-radius:50%;background:var(--shine);box-shadow:0 0 12px var(--shine-glow)}
.meta{color:var(--ink2);font-size:12px}
.fp{font-family:var(--mono);cursor:help;border-bottom:1px dotted var(--line-strong)}
/* ONE continuous document — plain anchor links, no view state, nothing to
   toggle. The anchors just scroll main into view; the "single interface" ask
   needed no CSS. */
.jump{margin-left:auto;display:flex;gap:var(--sp4)}
.jump a{color:var(--ink1);font-size:var(--t3);text-decoration:none;border-bottom:1px solid transparent;
  transition:color var(--t-micro) var(--ease),border-color var(--t-micro) var(--ease)}
.jump a:hover{color:var(--shine);border-bottom-color:var(--shine)}
main{padding:0 var(--sp5) var(--sp5);max-width:1280px;margin:0 auto}
.alarm{margin:var(--sp4) var(--sp5);padding:var(--sp3) var(--sp4);border:1px solid var(--fail);
  border-left-width:4px;border-radius:var(--r-card);background:color-mix(in oklab,var(--fail) 10%,transparent)}
.alarm h2{color:var(--fail);font-size:15px;margin-bottom:var(--sp2)}
.syncnote{margin:0 0 var(--sp4);padding:var(--sp3) var(--sp4);border:1px solid var(--line);
  border-left:3px solid var(--info);border-radius:var(--r-card);background:var(--bg1);
  color:var(--ink1);font-size:var(--t3);line-height:1.6}
.syncnote b{color:var(--ink0);font-weight:600}
.gauges{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:var(--sp4);margin-bottom:var(--sp5)}
.gcard{border:1px solid var(--line);border-radius:var(--r-card);background:var(--bg1);padding:var(--sp4);
  box-shadow:var(--shadow1)}
.gcard.hero{border-color:var(--shine);box-shadow:var(--shadow2)}
.gcard h2{font-size:15px}
.sub{color:var(--ink2);font-size:12px;margin:2px 0 var(--sp3)}
.gauge{display:block;width:132px;height:132px;margin:0 auto var(--sp2)}
.gtrack{fill:none;stroke:var(--bg3);stroke-width:11}
.gfill{fill:none;stroke-width:11;stroke-linecap:round;transform:rotate(-90deg);transform-origin:64px 64px}
.gfill.gold{stroke:var(--shine)}.gfill.blue{stroke:var(--c-atmos)}.gfill.violet{stroke:var(--c-surface)}
.gnum{fill:var(--ink0);font:600 30px/1 var(--font);text-anchor:middle}
.gpc{font-size:15px;fill:var(--ink2)}
.reading{margin:0;color:var(--ink1);font-size:12.5px;text-align:center}
details{margin-top:var(--sp3);border-top:1px solid var(--line);padding-top:var(--sp2)}
summary{cursor:pointer;color:var(--ink2);font-size:12px}
summary:hover{color:var(--shine)}
.work{width:100%;border-collapse:collapse;margin-top:var(--sp2);font-size:12px}
.work th{text-align:left;color:var(--ink2);font-weight:500;padding:4px 6px;border-bottom:1px solid var(--line)}
.work td{padding:4px 6px;border-bottom:1px solid var(--line);vertical-align:top}
.work .num{text-align:right;font-family:var(--mono);color:var(--ink1)}
.work tr.bydesign td{opacity:.55}
.work tr.sub-row td{color:var(--ink2);font-size:11px;padding-top:0;border-bottom:1px solid var(--line)}
.fine{color:var(--ink2);font-size:11.5px;margin:var(--sp2) 0 0}
.strip{margin-bottom:var(--sp5)}
.strip h2{font-size:16px;display:flex;align-items:center;gap:var(--sp2)}
.count{font:500 11px/1 var(--mono);color:var(--ink2);border:1px solid var(--line);border-radius:99px;padding:3px 8px}
.cards,.grid{display:grid;gap:var(--sp3)}
.cards{grid-template-columns:repeat(auto-fill,minmax(310px,1fr))}
.grid{grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.jcard,.ecard{border:1px solid var(--line);border-radius:var(--r-card);background:var(--bg1);padding:var(--sp3)}
.jcard.unconfirmed{border-style:dashed}
.resolved .jcard{border-color:color-mix(in oklab,var(--ok) 40%,var(--line));opacity:.82}
.resolved .jcard .note{color:var(--ok)}
.jcard header,.ecard header{display:flex;align-items:center;gap:var(--sp2);flex-wrap:wrap;margin-bottom:var(--sp2)}
.ecard h3{font-size:13.5px}
.ecard header code{margin-left:auto;color:var(--ink2);font-size:11px}
.legs{margin:0 0 var(--sp1);font-size:12.5px;color:var(--ink0)}
.note{margin:0;font-size:12px;color:var(--ink1)}
.pending{margin:var(--sp2) 0 0;font-size:11px;color:var(--warn)}
.chip{display:inline-block;font:500 10.5px/1 var(--font);text-transform:uppercase;letter-spacing:.4px;
  padding:4px 8px;border-radius:99px;border:1px solid var(--line);color:var(--ink1)}
.chips{margin:var(--sp2) 0 0;display:flex;gap:4px;flex-wrap:wrap}
.e-quick,.e-moderate{border-color:var(--ok);color:var(--ok)}
.e-hard,.e-epic{border-color:var(--warn);color:var(--warn)}
.v-essential{border-color:var(--fail);color:var(--fail)}
.v-strong{border-color:var(--shine);color:var(--shine)}
.v-cut{border-color:var(--ink2);color:var(--ink2);text-decoration:line-through}
.s-live,.g-AHEAD,.g-PAR,.s-LIVE,.s-CLOSED{border-color:var(--ok);color:var(--ok)}
.s-seam,.g-TUNE,.s-BUILT{border-color:var(--warn);color:var(--warn)}
.s-future,.g-MISSING,.g-PRIMITIVE,.s-OPEN{border-color:var(--fail);color:var(--fail)}
.r-full{border-color:var(--ok);color:var(--ok)}
.r-partial{border-color:var(--warn);color:var(--warn)}
.bar{height:6px;border-radius:99px;background:var(--bg3);overflow:hidden;margin:var(--sp2) 0}
.bar span{display:block;height:100%;background:var(--shine);border-radius:99px}
.ecard .reading{text-align:left}
.ecard .reading .num{float:right;font-family:var(--mono);color:var(--ink2)}
.blind{margin:0;padding-left:var(--sp4);color:var(--ink1);font-size:12.5px;columns:2;column-gap:var(--sp5)}
.blind li{margin-bottom:4px;break-inside:avoid}
.empty{color:var(--ink2);font-size:12px;font-style:italic}
/* A count, not an alarm — a solid red pill on a jump link shouts at you every
   time you look at the page, which is not what eight known, tracked bugs
   deserve. (The Board kanban this once lived on is gone — its own status is
   visible in-place now: on the stranded-pass table, on Pipeline gaps, and on
   every rung's own built/not-built chip.) */
.tabbadge{font:600 var(--t5)/1 var(--mono);background:color-mix(in oklab,var(--fail) 22%,transparent);
  color:var(--fail);border-radius:99px;padding:3px 7px;margin-left:5px}
.strip h2{font-size:var(--t2)}
.sub{font-size:var(--t4);line-height:1.6}
/* ── A REAL TYPE SCALE ────────────────────────────────────────────────────
   The first draft had TEN distinct font sizes and no scale, which reads as
   noise rather than hierarchy. Five steps, and weight/colour carry the rest. */
:root{--t1:19px;--t2:15px;--t3:13px;--t4:11.5px;--t5:10px}
/* ── THE OPENER: orientation before detail ────────────────────────────────── */
.opener{margin-bottom:var(--sp5)}
.figures{display:flex;gap:var(--sp5);flex-wrap:wrap;margin-bottom:var(--sp4)}
.fig{display:flex;flex-direction:column;gap:2px}
.fig b{font:600 26px/1 var(--font);color:var(--ink0);font-variant-numeric:tabular-nums}
.fig span{font-size:var(--t4);color:var(--ink2)}
.fig.hot b{color:var(--fail)}
.lede{margin:0 0 var(--sp3);max-width:62ch;font-size:var(--t3);line-height:1.65;color:var(--ink1)}
.legend{display:flex;gap:var(--sp4);flex-wrap:wrap}
.key{display:flex;align-items:center;gap:6px;font-size:var(--t4);color:var(--ink2)}
.sw{width:10px;height:10px;border-radius:3px;flex:none}
.sw.ok{background:var(--ok)}.sw.watch{background:var(--warn)}.sw.warn{background:var(--fail)}
.sw.dash{border:1px dashed var(--line-strong);border-radius:3px}
/* ── THE MOSAIC: block area ≈ code volume ─────────────────────────────────── */
.mosaic{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));grid-auto-rows:auto;
  gap:var(--sp3);margin-bottom:var(--sp5);align-items:start}
/* No outline on a closed tile — the ground does the separating. A card only
   grows a border when it is open and genuinely a container. */
.zone{background:var(--bg1);border-radius:var(--r-card);border:1px solid transparent;
  border-left:3px solid var(--line-strong);overflow:hidden;
  transition:background var(--t-micro) var(--ease),border-color var(--t-micro) var(--ease)}
.sp-xl{grid-column:span 3}
.sp-lg{grid-column:span 2}
.sp-sm{grid-column:span 1}
.t-ok{border-left-color:color-mix(in oklab,var(--ok) 55%,transparent)}
.t-watch{border-left-color:var(--warn)}
.t-warn{border-left-color:var(--fail)}
.zone:hover{background:var(--bg2)}
.zone[open]{grid-column:1/-1;background:var(--bg1);border-color:var(--line);box-shadow:var(--shadow2)}
.zhead{padding:var(--sp4);cursor:pointer;list-style:none;display:block}
.zhead::-webkit-details-marker{display:none}
.zrow{display:flex;align-items:baseline;gap:var(--sp2)}
.zone h3{font:600 var(--t2)/1.2 var(--mono);color:var(--ink0);letter-spacing:0}
.kindtag{margin-left:auto;font:500 var(--t5)/1 var(--font);text-transform:uppercase;letter-spacing:.6px;
  color:var(--ink2)}
.zmeta{margin:6px 0 var(--sp3);color:var(--ink2);font-size:var(--t4);font-variant-numeric:tabular-nums}
.zblurb{margin:0;color:var(--ink1);font-size:var(--t4);line-height:1.6;
  display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.sp-xl .zblurb{-webkit-line-clamp:3}
.zone[open] .zblurb{-webkit-line-clamp:unset;display:block}
.zfoot{margin-top:var(--sp3);display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.chev{margin-left:auto;font-size:var(--t5);color:var(--ink2);text-transform:uppercase;letter-spacing:.6px}
.zone[open] .chev::after{content:' ▲'}
.zone:not([open]) .chev::after{content:' ▼'}
.dot{font:500 var(--t5)/1 var(--font);letter-spacing:.3px;padding:4px 8px;border-radius:99px;
  background:var(--bg3);color:var(--ink2);cursor:help}
.dot.watch{background:color-mix(in oklab,var(--warn) 18%,transparent);color:var(--warn)}
.dot.warn{background:color-mix(in oklab,var(--fail) 18%,transparent);color:var(--fail)}
.zbody{padding:0 var(--sp4) var(--sp4);border-top:1px solid var(--line)}
/* Files: a list with a rule, not 18 nested boxes. */
.files{list-style:none;margin:var(--sp3) 0 0;padding:0;display:grid;
  grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:0 var(--sp5)}
.file{padding:var(--sp3) 0 var(--sp3) var(--sp3);border-left:2px solid var(--line);
  border-bottom:1px solid var(--line)}
.file.flagged{border-left-color:var(--warn)}
.frow{display:flex;gap:var(--sp2);align-items:baseline}
.frow code{font-size:var(--t4);color:var(--ink0)}
.flines{margin-left:auto;font:var(--t5) var(--mono);color:var(--ink2);font-variant-numeric:tabular-nums}
.fsum{margin:5px 0 0;color:var(--ink2);font-size:var(--t4);line-height:1.55}
/* ── THE WRITE-BACK CONTROL — folded until wanted ─────────────────────────── */
.note{margin-top:var(--sp2);border:none;padding:0;font-size:var(--t4)}
.notetab{list-style:none;cursor:pointer;font:500 var(--t5)/1 var(--font);text-transform:uppercase;
  letter-spacing:.6px;color:var(--ink2);padding:5px 0;display:inline-block;
  border-bottom:1px dotted transparent;transition:color var(--t-micro) var(--ease)}
.notetab::-webkit-details-marker{display:none}
.notetab::before{content:'✎ '}
.notetab:hover{color:var(--shine);border-bottom-color:var(--shine)}
.note[open] .notetab{color:var(--shine)}
.notebody{padding-top:6px}
.notein{margin:0;min-height:52px;padding:9px 11px;border:1px solid var(--line-strong);
  border-radius:var(--r-ctl);font-size:var(--t3);line-height:1.6;color:var(--ink0);background:var(--bg0);
  outline:none}
.notein:focus{border-color:var(--shine);box-shadow:0 0 0 3px var(--shine-soft)}
.notein:empty::before{content:attr(data-placeholder);color:var(--ink2)}
.ticks{display:flex;gap:var(--sp4);flex-wrap:wrap;margin-top:var(--sp2)}
.tick{font-size:var(--t4);color:var(--ink1);display:flex;align-items:center;gap:6px;cursor:pointer}
.tick input{accent-color:var(--ok);margin:0;width:14px;height:14px}
.tick.bad input{accent-color:var(--fail)}
/* ── GAPS: dashed, quiet, grouped by kind ─────────────────────────────────── */
.gapsec .sub{max-width:62ch}
.gsub{font-size:var(--t3);color:var(--ink2);text-transform:uppercase;letter-spacing:.7px;
  margin:var(--sp5) 0 var(--sp3);display:flex;align-items:center;gap:var(--sp2)}
.gaps{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:var(--sp3)}
.gaps.tight{grid-template-columns:repeat(auto-fill,minmax(260px,1fr))}
.gap{border:1px dashed var(--line-strong);border-radius:var(--r-card);background:transparent;
  padding:var(--sp3) var(--sp4)}
.grow{display:flex;gap:var(--sp2);align-items:baseline}
.grow code{font-size:var(--t4);color:var(--ink1)}
.gw{margin-left:auto;font:var(--t5) var(--mono);color:var(--fail);white-space:nowrap}
.gwhy{margin:6px 0 0;font-size:var(--t4);line-height:1.55;color:var(--ink1)}
.gap .fsum{margin-top:5px}
.s-deferred{border-color:var(--ink2);color:var(--ink2)}
/* ── FEATURES: grade, checklist, one rung at a time ───────────────────────── */
.effecthead{border-bottom:1px solid var(--line);padding-bottom:var(--sp3);margin-bottom:var(--sp3)}
.gradewrap{display:flex;align-items:center;gap:var(--sp3);flex-wrap:wrap;margin-bottom:var(--sp2)}
.glabel{font-size:var(--t4);color:var(--ink2)}
.gradechip{font:600 var(--t5)/1 var(--mono);padding:4px 8px;border-radius:99px;border:1px solid}
.gr-S,.gr-Ap,.gr-A{border-color:var(--ok);color:var(--ok)}
.gr-B,.gr-C{border-color:var(--warn);color:var(--warn)}
.gr-D,.gr-F{border-color:var(--fail);color:var(--fail)}
/* Radio inputs styled as a compact letter-grade strip — the checked state on
   one of these is captured by the live-doc runtime exactly like a checkbox
   is, so a click here is a real edit reaching me with no extra mechanism. */
.gradepick{display:inline-flex;gap:2px;border:1px solid var(--line);border-radius:99px;padding:2px}
.gopt{position:relative;display:flex}
.gopt input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.gopt span{font:600 var(--t5)/1 var(--mono);padding:5px 8px;border-radius:99px;color:var(--ink2);
  transition:background var(--t-micro) var(--ease),color var(--t-micro) var(--ease)}
.gopt:hover span{color:var(--ink0)}
.gopt input:checked+span{background:var(--shine-soft);color:var(--shine)}
/* THE CONFIRM CONTROL — sits beside the grade, never folded into a note: "I
   built it" (mine) and "it really landed" (his, and only his) are different
   claims and read as visually different weight — plain checkboxes, not a
   pill strip, so they never look like a second grade. */
.confirmwrap{margin-top:0}
.fsub{font-size:var(--t3);color:var(--ink1);text-transform:uppercase;letter-spacing:.6px;
  margin:var(--sp4) 0 var(--sp2);display:flex;align-items:center;gap:var(--sp2)}
.rungs{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:var(--sp3);margin-bottom:var(--sp2)}
.rung{border:1px solid var(--line);border-radius:var(--r-card);background:var(--bg0);padding:var(--sp3)}
.rung.built{border-color:var(--line-strong)}
.rrow{display:flex;align-items:center;gap:var(--sp2);flex-wrap:wrap;margin-bottom:6px}
.rrow code{font-size:var(--t4);color:var(--ink0)}
.checklist{margin:var(--sp2) 0;padding:var(--sp2) var(--sp3);background:var(--bg1);border-radius:var(--r-ctl)}
.wistate{margin:0 0 4px;font:600 var(--t5)/1 var(--font);text-transform:uppercase;letter-spacing:.5px}
.st-requested{color:var(--ink2)}
.st-planned{color:var(--info)}
.st-in-progress{color:var(--warn)}
.st-awaiting-eyes{color:var(--shine)}
.steps{margin:4px 0 0;padding:0;list-style:none;font-size:var(--t4);color:var(--ink1)}
.steps li{padding:2px 0}
.steps li.done{color:var(--ink2);text-decoration:line-through}
/* Real numbers, honestly dated — never a live reading, said outright in the title tooltip. */
.dot[title^="Measured"],.dot[title^="Declared"]{cursor:help}
.bugcard.flagged{border-color:var(--fail)}
.jcard.drift{border-color:var(--warn)}
.jcard.drift .legs code{color:var(--warn)}
.foot{max-width:1280px;margin:0 auto;padding:var(--sp4) var(--sp5) var(--sp5);color:var(--ink2);
  font-size:11.5px;border-top:1px solid var(--line)}
/* LAST, deliberately: .count and .gnum both set the \`font:\` SHORTHAND, which
   resets font-variant-numeric to normal. Declared earlier this rule silently
   loses the cascade — it did, and only a computed-style read caught it. */
.num,.count,.gnum,.reading,.work td{font-variant-numeric:tabular-nums}
@media (max-width:720px){main{padding:0 var(--sp3) var(--sp3)}.blind{columns:1}}
`;

// ── MAIN ────────────────────────────────────────────────────────────────────

/**
 * Last-commit date for MANY paths in one `git log` walk.
 *
 * The obvious implementation — `git log -1` per file — is 340 process spawns
 * and seconds of wall clock for data a single reverse-chronological walk
 * already carries: the FIRST time a path appears in that walk is its last
 * commit. Files git has never seen (new, untracked) simply stay absent, and the
 * page shows no date rather than a wrong one.
 *
 * @param {string[]} paths - repo-relative, POSIX separators.
 * @returns {Record<string, string>} path → YYYY-MM-DD
 */
export function gitLastTouchedAll(paths) {
  const want = new Set(paths);
  const out = {};
  try {
    const log = execFileSync('git', ['log', '--format=%cs', '--name-only', '--no-merges', '-n', '400'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    let date = null;
    for (const line of log.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
        date = t;
        continue;
      }
      if (date && want.has(t) && !(t in out)) out[t] = date;
    }
  } catch {
    // No git, a shallow clone, or a detached worktree — the page just shows no
    // dates. A dashboard that cannot read history should say nothing about it.
  }
  return out;
}

async function main() {
  const { PASSES } = await import(new URL('../../src/graph/passes.js', import.meta.url).href);
  const effectsDoor = await import(new URL('../../src/effects/index.js', import.meta.url).href);
  const { tokensCSS, getThemeTokens } = await import(new URL('../../src/ui/tokens.js', import.meta.url).href);
  const { validateEffectManifest } = effectsDoor;

  // DISCOVERY, NEVER A LIST (tools/run-tests.mjs's own rule 1): every export of
  // the effects zone door that the project's OWN validator accepts is an effect.
  // Adding a 16th effect needs no edit here.
  const manifests = Object.values(effectsDoor).filter(
    (v) => v && typeof v === 'object' && !Array.isArray(v) && validateEffectManifest(v).ok
  );

  const pillars = parsePillars(readFileSync(TESTAMENT_FILE, 'utf8'));
  const pillarScore = scorePillars(pillars);
  const passCov = measurePassCoverage(PASSES);
  const effects = measureEffectRungs(manifests);

  const rungs = describeRungs(manifests);
  const known = {
    passes: new Set(PASSES.map((x) => x.id)),
    effects: new Set(manifests.map((m) => m.id)),
    pillars: new Set(pillars.map((x) => String(x.n))),
    v2: new Set(PASSES.flatMap((x) => x.absorbs ?? [])),
    rungs: new Set(rungs.map((r) => `${r.effectId}:${r.name}`)),
    builtRungs: new Set(rungs.filter((r) => r.built).map((r) => `${r.effectId}:${r.name}`)),
  };
  const ledger = JSON.parse(readFileSync(JUDGEMENTS_FILE, 'utf8'));
  const verdict = evaluateJudgements(ledger, known);
  const workitemsRaw = existsSync(WORKITEMS_FILE) ? JSON.parse(readFileSync(WORKITEMS_FILE, 'utf8')) : [];
  const workitemsVerdict = evaluateWorkItems(workitemsRaw, known);
  const gradesRaw = existsSync(GRADES_FILE) ? JSON.parse(readFileSync(GRADES_FILE, 'utf8')) : [];
  const gradesVerdict = evaluateGrades(gradesRaw, known);
  const confirmationsRaw = existsSync(CONFIRMATIONS_FILE) ? JSON.parse(readFileSync(CONFIRMATIONS_FILE, 'utf8')) : [];
  const confirmationsVerdict = evaluateConfirmations(confirmationsRaw, known);
  const ledgerErrorsAll = [
    ...verdict.errors.map((e) => `judgements.json: ${e}`),
    ...workitemsVerdict.errors.map((e) => `workitems.json: ${e}`),
    ...gradesVerdict.errors.map((e) => `grades.json: ${e}`),
    ...confirmationsVerdict.errors.map((e) => `confirmations.json: ${e}`),
  ];

  // THE LATEST PERF CAPTURE — whichever dated file sorts last. Never a live
  // reading (this project has no continuous perf pipeline); dated honestly on
  // the page so nobody mistakes a 2026-08-13 baseline for this morning's build.
  let perf = { byEffect: {}, capturedAt: null, msaVersion: null };
  if (existsSync(PERF_REPORTS_DIR)) {
    const jsonReports = readdirSync(PERF_REPORTS_DIR, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name)
      .sort();
    const latest = jsonReports.at(-1);
    if (latest) perf = derivePerfByEffect(JSON.parse(readFileSync(join(PERF_REPORTS_DIR, latest), 'utf8')));
  }
  // THE ANTI-DRIFT CHECK, run before triage sees anything: a judgement whose
  // subject is already done is retired into `doneSince`, never sorted into
  // Easy Wins / Grind / Cut List as if it were still open work.
  const { stillOpen, doneSince } = findResolvedSinceJudged(verdict.resolved, {
    passes: PASSES,
    effects: effects.rows,
    pillars,
  });
  const tri = triage(stillOpen);
  const blind = findBlindSpots({ passes: PASSES, effects: effects.rows, resolved: verdict.resolved });

  const bugsParsed = parseBugTracker(readFileSync(BUG_TRACKER_FILE, 'utf8'));
  const bugs = bugTrackerFindings(bugsParsed);

  const holyFiles = readdirSync(HOLY_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name)
    .sort();
  // One batched git-log walk, same reason and same helper as the survey's own
  // 340 files: N one-shot `git log -1` spawns is real, avoidable wall-clock —
  // and using the SAME exported helper here is what let a test reconstructing
  // this exact model catch that this field was missing in the first place.
  const holyTouched = gitLastTouchedAll(holyFiles.map((name) => `docs/holy/${name}`));
  const holyActivity = holyFiles.map((name) => ({
    name,
    ...parseHolyDocActivity(readFileSync(join(HOLY_DIR, name), 'utf8')),
    lastTouched: holyTouched[`docs/holy/${name}`] ?? null,
  }));

  // THE SURVEY — the codebase as blocks. Git dates come from ONE `git log` over
  // the whole tree rather than one process per file: 340 spawns would dominate
  // this tool's runtime for data that is identical either way.
  const srcPaths = walkSources(ROOT, join(ROOT, 'src'));
  const zoneNames = [...new Set(srcPaths.map(zoneOf))];
  const zoneEffectIds = deriveZoneEffectIds(zoneNames, manifests);
  const { EFFECT_ZONING } = await import(new URL('../../src/diag/perf-zones.js', import.meta.url).href);
  const survey = buildSurvey({
    paths: srcPaths,
    read: (p) => readFileSync(join(ROOT, p), 'utf8'),
    uniformBudgets: JSON.parse(readFileSync(join(ROOT, 'tools', 'uniform-budgets.json'), 'utf8')),
    effectZoning: EFFECT_ZONING,
    zoneEffectIds,
    lastTouched: gitLastTouchedAll(srcPaths),
  });
  const gaps = findGaps(PASSES, manifests);

  const planningFiles = readdirSync(PLANNING_DIR, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => ({ path: `docs/planning/${d.name}`, text: readFileSync(join(PLANNING_DIR, d.name), 'utf8') }));
  const nothingBuiltDrift = findNothingBuiltContradiction(planningFiles);

  // The standalone build stamps `data-theme` itself, so LANTERN's own theme
  // blocks apply and the warm ramp layers on top. BOTH themes get it — warming
  // only dark would leave anyone who switches to light looking at LANTERN's
  // cold parchment under warm-tuned component styling.
  const warmStamp = (t) =>
    `html[data-theme="${t}"]{${Object.entries(warmNeutrals(t))
      .map(([k, v]) => `${k}:${v}`)
      .join(';')}}`;
  const model = {
    generatedAt: new Date().toISOString().slice(0, 10),
    tokensCss: `${tokensCSS()}\n${warmStamp('dark')}\n${warmStamp('light')}`,
    pillars,
    pillarScore,
    passes: PASSES,
    passCov,
    effects,
    tri,
    blind,
    ledgerErrors: ledgerErrorsAll,
    bugs,
    holyActivity,
    nothingBuiltDrift,
    survey,
    gaps,
    doneSince,
    rungs,
    grades: gradesVerdict.resolved,
    workitems: workitemsVerdict.resolved,
    confirmations: confirmationsVerdict.resolved,
    perf,
  };
  // `--check`: THE STANDALONE FRESHNESS GATE — the mechanism the author asked
  // for directly ("worth a mechanism… otherwise it's useless outdated
  // artwork"). Answers exactly one question, fast, without pulling in the
  // 11,000-assertion suite: does the checked-in page still match what the real
  // codebase would produce right now? Never writes; a stale page stays exactly
  // as stale as it was until someone runs the plain (write) form.
  //
  // This is deliberately a LOCAL, on-demand check — no new CI infrastructure,
  // no git hook, no background watcher (feedback_no_wasteful_background_tasks)
  // — because those are bigger, repo-wide decisions than "does this one file
  // match its own inputs," worth the author's own call rather than assumed.
  if (process.argv.includes('--check')) {
    const fresh = computeFingerprint(model);
    const onDiskHtml = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : null;
    const stored = onDiskHtml ? extractFingerprint(onDiskHtml) : null;
    if (!onDiskHtml) {
      console.error(`chart-room --check: ${OUT_FILE} does not exist yet — run without --check to generate it.`);
      process.exitCode = 1;
    } else if (!stored) {
      console.error(`chart-room --check: STALE — the checked-in page predates the fingerprint mechanism itself.`);
      process.exitCode = 1;
    } else if (stored !== fresh) {
      console.error(`chart-room --check: STALE — checked-in fp ${stored}, current source would build fp ${fresh}.`);
      console.error(`  Run 'node tools/chart-room/build-chart-room.mjs' to regenerate, then republish the artifact.`);
      process.exitCode = 1;
    } else {
      console.log(`chart-room --check: FRESH (fp ${fresh}) — matches current source exactly.`);
    }
    return;
  }

  writeFileSync(OUT_FILE, renderHtml(model));
  // The hosted twin: same content, no document shell, and a palette that
  // resolves in all three of a viewer's theme states rather than relying on an
  // attribute only Foundry sets.
  writeFileSync(
    ARTIFACT_FILE,
    renderHtml({ ...model, mode: 'artifact', tokensCss: themeBlocks(getThemeTokens, tokensCSS()) })
  );

  console.log(`chart-room → ${OUT_FILE}`);
  console.log(`  fingerprint: ${computeFingerprint(model)}`);
  console.log(`  V2 parity (pillars)  ${pct1(pillarScore.pct)}  (${pct1(pillarScore.pctExByDesign)} ex-by-design)`);
  console.log(`  V2 coverage (absorbs) ${pct1(passCov.pct)}  — ${passCov.absorbsLive}/${passCov.absorbsTotal} classes`);
  console.log(`  V4 scope (rungs)      ${pct1(effects.pct)}  — ${effects.built} built / ${effects.deferred} deferred`);
  console.log(
    `  judgements: ${verdict.resolved.length} resolved, ${verdict.errors.length} error(s), ` +
      `${doneSince.length} done since judged`
  );
  console.log(`  not yet placed: ${blind.length}`);
  console.log(
    `  survey: ${survey.totalFiles} files / ${survey.totalLines.toLocaleString()} lines in ${survey.zones.length} zones` +
      ` — ${survey.warnCount} warn, ${survey.watchCount} watch`
  );
  console.log(`  gaps: ${gaps.length} (${gaps.filter((g) => g.kind === 'pass').length} passes)`);
  console.log(`  critical (open bugs): ${bugs.openBugs.length} of ${bugs.totalIndexed} indexed`);
  const driftCount = bugs.indexOnly.length + bugs.bodyOnly.length + bugs.nonCanonical.length + nothingBuiltDrift.length;
  console.log(`  drift found: ${driftCount}`);
  console.log(
    `  rungs: ${rungs.length} addressable (${rungs.filter((r) => r.built).length} built) · ` +
      `workitems: ${workitemsVerdict.resolved.length} · grades: ${gradesVerdict.resolved.length} · ` +
      `confirmations: ${confirmationsVerdict.resolved.length}` +
      (perf.capturedAt ? ` · perf captured ${perf.capturedAt}` : ' · no perf capture found')
  );
  for (const e of ledgerErrorsAll) console.error(`  ERROR ${e}`);
  if (ledgerErrorsAll.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
