/**
 * THE CHART ROOM's own gate.
 *
 * Two jobs, and the second matters more than the first:
 *
 * 1. The arithmetic is right — parity is computed from `PASSES` and the
 *    manifests, and a hand-computed figure agrees with it.
 * 2. **A MODEL CANNOT CREEP BACK IN.** `docs/planning/Health.md`'s whole verdict
 *    on V2's 4,505-line health system is that it was "a hand-drawn copy of the
 *    module's structure, kept beside the real thing, and it drifted".
 *    `src/graph/pass-health.js` answered that with tests asserting the SHAPE — no
 *    hardcoded effect names, no private fields — "so a model cannot creep back in
 *    without a red test". The `forbids a …` cases below are this file's version
 *    of that, and they are the reason it exists.
 *
 * House style: the PRIMARY assertions run against the REAL tree (the real
 * `PASSES`, the real manifests, the real `judgements.json`), matching
 * `tools/reachability.test.mjs` and `verify-structure.test.mjs`. Synthetic data
 * is used only where a failure mode cannot be produced by real, healthy data —
 * a broken ledger entry, a renamed ref.
 */

import {
  parsePillars,
  scorePillars,
  measurePassCoverage,
  measureEffectRungs,
  describeRungs,
  evaluateJudgements,
  evaluateGrades,
  evaluateWorkItems,
  deriveWorkItemState,
  derivePerfByEffect,
  triage,
  findBlindSpots,
  findResolvedSinceJudged,
  parseBugTracker,
  bugTrackerFindings,
  parseHolyDocActivity,
  findNothingBuiltContradiction,
  renderHtml,
  computeFingerprint,
  extractFingerprint,
  gitLastTouchedAll,
  themeBlocks,
  escapeHtml,
  warmNeutrals,
  PILLAR_GRADES,
  FORBIDDEN_JUDGEMENT_KEYS,
  GRADES,
  GRADED_BY,
  FORBIDDEN_GRADE_KEYS,
  FORBIDDEN_WORKITEM_KEYS,
  EFFORTS,
  VALUES,
} from './build-chart-room.mjs';
// `survey.mjs` is tested from THIS file rather than a sibling suite of its own:
// `tools/run-tests.mjs`'s dispatch list is hand-maintained (its own header calls
// that out as the one place rule 1 is broken), so a second registration is a
// second chance to forget one. One suite, both modules.
import {
  walkSources,
  describeModule,
  zoneOf,
  signalsForZone,
  deriveZoneEffectIds,
  buildSurvey,
  findGaps,
} from './survey.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { PASSES } from '../../src/graph/passes.js';
import { EFFECT_ZONING } from '../../src/diag/perf-zones.js';
import * as effectsDoor from '../../src/effects/index.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const HERE = fileURLToPath(new URL('.', import.meta.url));

/** Defaults for the fields every renderHtml() test call needs but rarely varies. */
const baseModel = (over) => ({
  generatedAt: '2026-01-01',
  tokensCss: ':root{--bg0:#000}',
  bugs: { openBugs: [], indexOnly: [], bodyOnly: [], nonCanonical: [], totalIndexed: 0, totalInBody: 0 },
  holyActivity: [],
  nothingBuiltDrift: [],
  survey: { zones: [], totalLines: 0, totalFiles: 0, describedFiles: 0, warnCount: 0, watchCount: 0 },
  gaps: [],
  doneSince: [],
  rungs: [],
  grades: [],
  workitems: [],
  perf: { byEffect: {}, capturedAt: null, msaVersion: null },
  ...over,
});

const MANIFESTS = Object.values(effectsDoor).filter(
  (v) => v && typeof v === 'object' && !Array.isArray(v) && effectsDoor.validateEffectManifest(v).ok
);

const okJudgement = (over) => ({
  ref: 'pass:post.grade',
  effort: 'hard',
  value: 'essential',
  valueBy: 'claude',
  backOnItsLegs: 'One graded image rather than a stack.',
  ...over,
});

export function run(t) {
  const { ok } = t;

  // ── discovery, not a list ────────────────────────────────────────────────
  ok('discovers every effect manifest through the effects door', MANIFESTS.length >= 15);
  ok(
    'every discovered manifest has a camelCase id and a tier ladder',
    MANIFESTS.every((m) => /^[a-z][a-zA-Z0-9]*$/.test(m.id) && Array.isArray(m.tiers) && m.tiers.length > 0)
  );

  // ── pillars ──────────────────────────────────────────────────────────────
  const pillars = parsePillars(readFileSync(join(ROOT, 'docs', 'holy', 'V4-Testament.md'), 'utf8'));
  ok('parses all 13 Book II pillars out of the Testament', pillars.length === 13);
  ok(
    'pillars are numbered 1..13 in order',
    pillars.every((p, i) => p.n === i + 1)
  );
  ok(
    'every pillar carries at least one grade — a heading rename would otherwise score 0 silently',
    pillars.every((p) => p.grades.length > 0)
  );
  ok(
    'every parsed grade is one of the five the Testament defines',
    pillars.every((p) => p.grades.every((g) => g in PILLAR_GRADES))
  );
  ok('pillar names survive the aside-stripping', pillars[0].name.length > 0 && !pillars[0].name.includes('*'));

  // Compound grades average, rather than taking whichever was written first.
  const compound = pillars.find((p) => p.grades.length > 1);
  ok('a compound grade (AHEAD→TUNE, PRIMITIVE/MISSING) averages its two halves', compound !== undefined);
  if (compound) {
    const want = compound.grades.reduce((a, g) => a + PILLAR_GRADES[g], 0) / compound.grades.length;
    ok('  …and the average is arithmetically right', Math.abs(compound.score - want) < 1e-9);
  }

  const score = scorePillars(pillars);
  const handScore = (pillars.reduce((a, p) => a + p.score, 0) / pillars.length) * 100;
  ok('pillar parity matches a hand-computed mean', Math.abs(score.pct - handScore) < 1e-9);
  ok('pillar parity is a real percentage', score.pct > 0 && score.pct <= 100);
  ok(
    'excluding the by-design pillar can only raise the score (it is the lowest-graded)',
    score.pctExByDesign >= score.pct
  );
  ok('the by-design exclusion drops exactly one pillar', score.nCounted === score.n - 1);

  // ── pass coverage ────────────────────────────────────────────────────────
  const cov = measurePassCoverage(PASSES);
  const handTotal = PASSES.reduce((a, p) => a + (p.absorbs ?? []).length, 0);
  const handLive = PASSES.filter((p) => p.status === 'live').reduce((a, p) => a + (p.absorbs ?? []).length, 0);
  ok('absorb totals match a hand count over PASSES', cov.absorbsTotal === handTotal && cov.absorbsLive === handLive);
  ok(
    'every pass is counted under exactly one status',
    Object.values(cov.byStatus).reduce((a, b) => a + b, 0) === PASSES.length
  );
  ok('coverage percentage matches its own inputs', Math.abs(cov.pct - (handLive / handTotal) * 100) < 1e-9);
  ok(
    'stranded list holds only non-live passes that absorb something',
    cov.stranded.every((s) => s.status !== 'live' && s.count > 0)
  );
  ok(
    'stranded list is ordered heaviest-first — the point is which gap is big',
    cov.stranded.every((s, i, a) => i === 0 || a[i - 1].count >= s.count)
  );

  // The two numbers are ALLOWED to disagree; that disagreement is a finding the
  // page prints. What must never happen is one being silently derived from the
  // other, which would make the cross-check worthless.
  ok('pass-count and absorb-weighted coverage are computed independently', cov.passPct !== cov.pct);

  // ── effect rungs ─────────────────────────────────────────────────────────
  const rungs = measureEffectRungs(MANIFESTS);
  ok('rung measurement covers every discovered manifest', rungs.rows.length === MANIFESTS.length);
  ok('built rungs match the manifests hand-summed', rungs.built === MANIFESTS.reduce((a, m) => a + m.tiers.length, 0));
  ok(
    'deferred rungs match the manifests hand-summed',
    rungs.deferred === MANIFESTS.reduce((a, m) => a + (m.deferredRungs ?? []).length, 0)
  );
  ok(
    'scope percentage matches its own inputs',
    Math.abs(rungs.pct - (rungs.built / (rungs.built + rungs.deferred)) * 100) < 1e-9
  );
  ok(
    'effects are ordered by visual weight — what to defend first, first',
    rungs.rows.every((r, i, a) => i === 0 || a[i - 1].visualWeight >= r.visualWeight)
  );

  // ── addressable rungs — "click water, click refraction" ────────────────────
  const describedRungs = describeRungs(MANIFESTS);
  ok(
    'every built tier and every deferred rung of every manifest is addressable',
    describedRungs.length === MANIFESTS.reduce((a, m) => a + (m.tiers ?? []).length + (m.deferredRungs ?? []).length, 0)
  );
  ok(
    'a rung ref is rung:<effectId>:<name> — the literal address the click-through needs',
    describedRungs.every((r) => r.ref === `rung:${r.effectId}:${r.name}`)
  );
  ok(
    'built and deferred rungs are told apart',
    describedRungs.some((r) => r.built) && describedRungs.some((r) => !r.built)
  );

  // ── the ledger: refs must resolve ────────────────────────────────────────
  const known = {
    passes: new Set(PASSES.map((x) => x.id)),
    effects: new Set(MANIFESTS.map((m) => m.id)),
    pillars: new Set(pillars.map((x) => String(x.n))),
    v2: new Set(PASSES.flatMap((x) => x.absorbs ?? [])),
    rungs: new Set(describedRungs.map((r) => `${r.effectId}:${r.name}`)),
    builtRungs: new Set(describedRungs.filter((r) => r.built).map((r) => `${r.effectId}:${r.name}`)),
  };
  const real = JSON.parse(readFileSync(join(HERE, 'judgements.json'), 'utf8'));
  const verdict = evaluateJudgements(real, known);
  ok(`the real judgements.json resolves clean (${verdict.errors.join(' | ')})`, verdict.ok);
  ok('…and actually resolved something', verdict.resolved.length > 0);

  ok(
    'refuses a ref that does not resolve — the ledger may not outlive what it describes',
    !evaluateJudgements([okJudgement({ ref: 'pass:no.such.pass' })], known).ok
  );
  ok('refuses an unknown namespace', !evaluateJudgements([okJudgement({ ref: 'sprint:3' })], known).ok);
  ok(
    'refuses a bare, un-namespaced id — S/R/P collide three ways each in this project',
    !evaluateJudgements([okJudgement({ ref: 'S3' })], known).ok
  );
  ok('refuses the same ref judged twice', !evaluateJudgements([okJudgement({}), okJudgement({})], known).ok);
  ok(
    'accepts a v2: ref naming a class some pass absorbs',
    evaluateJudgements([okJudgement({ ref: 'v2:LensEffectV2' })], known).ok
  );
  ok('accepts a pillar: ref', evaluateJudgements([okJudgement({ ref: 'pillar:5' })], known).ok);

  // ── the ledger: SHAPE — a model may not creep back in ────────────────────
  for (const key of FORBIDDEN_JUDGEMENT_KEYS) {
    ok(
      `forbids a '${key}' field on a judgement — that fact is DERIVED, and a second copy is the drift Health.md autopsied`,
      !evaluateJudgements([okJudgement({ [key]: 'anything' })], known).ok
    );
  }
  ok(
    'the real ledger carries no derived key at all',
    real.every((j) => FORBIDDEN_JUDGEMENT_KEYS.every((k) => !(k in j)))
  );

  // ── the ledger: the judgement fields themselves ──────────────────────────
  ok('refuses an unknown effort', !evaluateJudgements([okJudgement({ effort: 'smallish' })], known).ok);
  ok('refuses an unknown value', !evaluateJudgements([okJudgement({ value: 'maybe' })], known).ok);
  ok(
    'refuses an unattributed value — a guess must not read as your decision',
    !evaluateJudgements([okJudgement({ valueBy: undefined })], known).ok
  );
  ok('refuses a missing done-enough line', !evaluateJudgements([okJudgement({ backOnItsLegs: 'x' })], known).ok);
  ok(
    'every legal effort is accepted',
    EFFORTS.every((e) => evaluateJudgements([okJudgement({ effort: e })], known).ok)
  );
  ok(
    'every legal value is accepted',
    VALUES.every((v) => evaluateJudgements([okJudgement({ value: v })], known).ok)
  );
  ok(
    'reports every problem at once, not just the first',
    evaluateJudgements([okJudgement({ effort: 'x', value: 'y' })], known).errors.length >= 2
  );

  // ── grades.json — the one verdict only Ingram may write ─────────────────────
  const okGrade = (over) => ({
    ref: 'effect:water',
    grade: 'C',
    gradedBy: 'ingram',
    gradedAt: '2026-08-22',
    note: 'test grade',
    ...over,
  });
  const realGrades = JSON.parse(readFileSync(join(HERE, 'grades.json'), 'utf8'));
  const gradesVerdict = evaluateGrades(realGrades, known);
  ok(`the real grades.json resolves clean (${gradesVerdict.errors.join(' | ')})`, gradesVerdict.ok);
  ok(
    "water's own real grade, in the author's own words, is on the record",
    realGrades.some((g) => g.ref === 'effect:water' && g.grade === 'C' && g.gradedBy === 'ingram')
  );
  ok('refuses a ref that is not effect: or rung:', !evaluateGrades([okGrade({ ref: 'pass:post.grade' })], known).ok);
  ok(
    'refuses a rung ref that is still deferred — cannot grade what is not built',
    !evaluateGrades(
      [
        okGrade({
          ref: `rung:${describedRungs.find((r) => !r.built).effectId}:${describedRungs.find((r) => !r.built).name}`,
        }),
      ],
      known
    ).ok
  );
  ok(
    'accepts a rung ref that is actually built',
    evaluateGrades(
      [
        okGrade({
          ref: `rung:${describedRungs.find((r) => r.built).effectId}:${describedRungs.find((r) => r.built).name}`,
        }),
      ],
      known
    ).ok
  );
  ok('refuses an unknown grade letter', !evaluateGrades([okGrade({ grade: 'B+' })], known).ok);
  ok(
    'every legal grade is accepted',
    GRADES.every((g) => evaluateGrades([okGrade({ grade: g })], known).ok)
  );
  ok(
    "refuses gradedBy other than 'ingram' — nobody else's verdict counts",
    !evaluateGrades([okGrade({ gradedBy: 'claude' })], known).ok
  );
  ok('every entry in GRADED_BY is exactly the one name expected', GRADED_BY.length === 1 && GRADED_BY[0] === 'ingram');
  ok('refuses a malformed gradedAt', !evaluateGrades([okGrade({ gradedAt: 'yesterday' })], known).ok);
  ok('refuses the same ref graded twice', !evaluateGrades([okGrade({}), okGrade({})], known).ok);
  for (const key of FORBIDDEN_GRADE_KEYS) {
    ok(
      `forbids a '${key}' field on a grade — that belongs in judgements.json or workitems.json, not here`,
      !evaluateGrades([okGrade({ [key]: 'anything' })], known).ok
    );
  }

  // ── workitems.json — the checklist Claude authors and ticks ─────────────────
  const someRung = describedRungs[0];
  const okWorkitem = (over) => ({
    ref: someRung.ref,
    ask: 'Push this feature forward — a stand-in ask for the shape tests below.',
    requestedAt: '2026-08-22',
    checklist: [],
    ...over,
  });
  const realWorkitems = JSON.parse(readFileSync(join(HERE, 'workitems.json'), 'utf8'));
  const workitemsVerdict = evaluateWorkItems(realWorkitems, known);
  ok(`the real workitems.json resolves clean (${workitemsVerdict.errors.join(' | ')})`, workitemsVerdict.ok);
  ok(
    'refuses a ref namespace workitems does not allow (v2:)',
    !evaluateWorkItems([okWorkitem({ ref: 'v2:LensEffectV2' })], known).ok
  );
  ok(
    'refuses a ref that does not resolve',
    !evaluateWorkItems([okWorkitem({ ref: 'effect:no.such.effect' })], known).ok
  );
  ok('refuses a one-word ask', !evaluateWorkItems([okWorkitem({ ask: 'x' })], known).ok);
  ok('refuses a malformed requestedAt', !evaluateWorkItems([okWorkitem({ requestedAt: 'soon' })], known).ok);
  ok('refuses a non-array checklist', !evaluateWorkItems([okWorkitem({ checklist: 'todo' })], known).ok);
  ok(
    'refuses a checklist step missing text or done',
    !evaluateWorkItems([okWorkitem({ checklist: [{ text: 'a step' }] })], known).ok
  );
  ok('refuses the same ref requested twice', !evaluateWorkItems([okWorkitem({}), okWorkitem({})], known).ok);
  for (const key of FORBIDDEN_WORKITEM_KEYS) {
    ok(
      `forbids a '${key}' field on a work item — the verdict belongs in grades.json, authored only by Ingram`,
      !evaluateWorkItems([okWorkitem({ [key]: 'anything' })], known).ok
    );
  }
  ok('an empty checklist derives to requested', deriveWorkItemState({ checklist: [] }) === 'requested');
  ok(
    'a checklist with nothing ticked derives to planned',
    deriveWorkItemState({ checklist: [{ text: 'a', done: false }] }) === 'planned'
  );
  ok(
    'a partially-ticked checklist derives to in-progress',
    deriveWorkItemState({
      checklist: [
        { text: 'a', done: true },
        { text: 'b', done: false },
      ],
    }) === 'in-progress'
  );
  ok(
    'a fully-ticked checklist derives to awaiting-eyes — only Ingram can promote past this',
    deriveWorkItemState({ checklist: [{ text: 'a', done: true }] }) === 'awaiting-eyes'
  );

  // ── perf — the real, dated baseline capture ──────────────────────────────
  const perfDir = join(ROOT, 'docs', 'planning', 'perf-reports');
  const perfFiles = readdirSync(perfDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.json'))
    .map((d) => d.name)
    .sort();
  ok('at least one dated perf report exists to pull from', perfFiles.length > 0);
  const latestPerfFile = perfFiles.at(-1);
  const perfReport = JSON.parse(readFileSync(join(perfDir, latestPerfFile), 'utf8'));
  const perf = derivePerfByEffect(perfReport);
  ok(
    'perf is dated — a stale reading must never pass as fresh silently',
    typeof perf.capturedAt === 'string' && perf.capturedAt.length > 0
  );
  ok(
    'every measured effect in the report is keyed by id',
    (perfReport.effects ?? []).every((e) => perf.byEffect[e.id] !== undefined)
  );
  ok(
    "water's real perf entry is honestly 'unmeasured', not fabricated",
    perf.byEffect.water === undefined ||
      perf.byEffect.water.verdict === 'unmeasured' ||
      typeof perf.byEffect.water.costMs === 'number'
  );

  // ── THE ANTI-DRIFT CHECK — a judgement must not outlive what it describes ──
  // The gap this closes: `triage()` only sorts by effort/value, so a judgement
  // written against a seam pass would sit in "The Grind" forever even after
  // that pass ships — the ref still resolves (evaluateJudgements is satisfied),
  // but the CONTENT is now describing something that already happened.
  const resCtx = { passes: PASSES, effects: rungs.rows, pillars };
  // `findResolvedSinceJudged` reads `.ns`/`.id`, which only `evaluateJudgements`
  // attaches (it splits `.ref` apart) — a raw `okJudgement(...)` object doesn't
  // carry them, so every synthetic case below is run through the real
  // resolver first rather than handed to findResolvedSinceJudged directly.
  const resolveOf = (over) => evaluateJudgements([okJudgement(over)], known).resolved;
  const { stillOpen, doneSince } = findResolvedSinceJudged(verdict.resolved, resCtx);
  ok(
    'every judgement lands in exactly one of open or done — none vanish, none duplicate',
    stillOpen.length + doneSince.length === verdict.resolved.length
  );
  ok(
    'nothing judged against the real ledger claims to be done for a reason that is false',
    doneSince.every((j) => {
      if (j.ns === 'pass') return PASSES.find((p) => p.id === j.id)?.status === 'live';
      if (j.ns === 'effect') return rungs.rows.find((e) => e.id === j.id)?.deferred === 0;
      if (j.ns === 'pillar') return (pillars.find((p) => String(p.n) === j.id)?.score ?? 0) >= 1;
      if (j.ns === 'v2') return PASSES.some((p) => p.status === 'live' && (p.absorbs ?? []).includes(j.id));
      return false;
    })
  );

  // Real data alone can't prove the detector actually FIRES (nothing currently
  // judged happens to be done) — so prove it fires with a synthetic case built
  // from a genuinely live pass, and prove it does NOT fire for a seam.
  const aLivePass = PASSES.find((p) => p.status === 'live');
  const aSeamPass = PASSES.find((p) => p.status !== 'live');
  const synthCheck = findResolvedSinceJudged(
    [...resolveOf({ ref: `pass:${aLivePass.id}` }), ...resolveOf({ ref: `pass:${aSeamPass.id}` })],
    resCtx
  );
  ok(
    'a judgement against an ALREADY-LIVE pass is caught as done, not left open',
    synthCheck.doneSince.some((j) => j.id === aLivePass.id) && !synthCheck.stillOpen.some((j) => j.id === aLivePass.id)
  );
  ok(
    'a judgement against a genuine seam stays open',
    synthCheck.stillOpen.some((j) => j.id === aSeamPass.id) && !synthCheck.doneSince.some((j) => j.id === aSeamPass.id)
  );
  const anEffectWithGaps = rungs.rows.find((e) => e.deferred > 0);
  ok(
    'an effect judgement stays open while ANY rung remains deferred',
    findResolvedSinceJudged(resolveOf({ ref: `effect:${anEffectWithGaps.id}` }), resCtx).stillOpen.length === 1
  );
  const aByDesignPillar = pillars.find((p) => p.byDesign);
  const aWeakPillar = pillars.find((p) => p.score < 1 && !p.byDesign);
  ok(
    'a pillar already graded AHEAD/PAR (score 1) reads as done',
    findResolvedSinceJudged(resolveOf({ ref: `pillar:${aByDesignPillar.n}` }), resCtx).doneSince.length ===
      (aByDesignPillar.score >= 1 ? 1 : 0)
  );
  ok(
    'a pillar still below TUNE/PRIMITIVE/MISSING stays open',
    findResolvedSinceJudged(resolveOf({ ref: `pillar:${aWeakPillar.n}` }), resCtx).stillOpen.length === 1
  );
  // v2: refs are deliberately NEVER auto-resolved — found the hard way:
  // light.accumulate is live and its own absorbs[] names PlayerLightEffectV2,
  // but that pass's own note never mentions a carried light because none
  // exists. absorbs[] is design-time prose, not per-class verified fact.
  ok(
    'a v2: judgement stays open even when SOME live pass claims to absorb it — absorbs[] is prose, not proof',
    findResolvedSinceJudged(resolveOf({ ref: 'v2:PlayerLightEffectV2' }), resCtx).stillOpen.length === 1
  );

  // ── triage — sees ONLY still-open work, never anything already resolved ──
  const tri = triage(stillOpen);
  ok(
    'easy wins are all worth having and all cheap',
    tri.easyWins.every((j) => ['essential', 'strong'].includes(j.value) && ['quick', 'moderate'].includes(j.effort))
  );
  ok(
    'the grind is all worth having and none of it cheap',
    tri.grind.every((j) => ['essential', 'strong'].includes(j.value) && ['hard', 'epic'].includes(j.effort))
  );
  ok(
    'the cut list is exactly the cut-valued items',
    tri.cutList.every((j) => j.value === 'cut')
  );
  ok(
    'easy wins and the grind never overlap',
    tri.easyWins.every((j) => !tri.grind.includes(j))
  );
  ok(
    'every judgement lands in exactly one of the four value buckets',
    verdict.resolved.length === tri.easyWins.length + tri.grind.length + tri.cutList.length + tri.pile.length
  );
  ok(
    'unconfirmed holds everything the author has not personally graded',
    tri.unconfirmed.every((j) => j.valueBy !== 'ingram')
  );

  // ── blind spots ──────────────────────────────────────────────────────────
  const blind = findBlindSpots({ passes: PASSES, effects: rungs.rows, resolved: verdict.resolved });
  const judgedRefs = new Set(verdict.resolved.map((j) => j.ref));
  ok(
    'nothing already judged is reported as unplaced',
    blind.every((b) => !judgedRefs.has(b.ref))
  );
  ok(
    'no live pass is reported as unplaced — only unfinished work needs a call',
    blind.every((b) => !b.ref.startsWith('pass:') || PASSES.find((p) => `pass:${p.id}` === b.ref)?.status !== 'live')
  );

  // ── bug tracker: index vs body reconciliation ─────────────────────────────
  const bugTrackerText = readFileSync(join(ROOT, 'docs', 'planning', 'Bug-Tracker.md'), 'utf8');
  const btParsed = parseBugTracker(bugTrackerText);
  ok("reads the doc's own status vocabulary rather than hardcoding it", btParsed.canonicalStatuses.length === 4);
  ok(
    "canonical vocabulary matches the doc's own words",
    ['OPEN', 'BUILT (unverified)', 'LIVE', 'CLOSED'].every((w) => btParsed.canonicalStatuses.includes(w))
  );
  ok('parses real index rows', btParsed.index.length > 20);
  ok('parses real body entries', btParsed.body.length > 15);
  ok(
    'a bug range header (## 24–27. …) expands to every id it covers',
    btParsed.body.some((b) => b.ids.length > 1)
  );
  ok(
    'every index row has a numeric id',
    btParsed.index.every((r) => Number.isFinite(r.id))
  );
  ok(
    'the status-token pattern ignores incidental backtick spans on the same line — doc filenames, code identifiers',
    btParsed.body.flatMap((b) => b.statuses).every((s) => /^(OPEN|BUILT|LIVE|CLOSED)\b/.test(s))
  );

  const btFindings = bugTrackerFindings(btParsed);
  ok('finds the real, known drift: bug #6 has a body entry but no index row', btFindings.bodyOnly.includes(6));
  ok(
    'open bugs are drawn from the index, never the body alone',
    btFindings.openBugs.every((b) => btParsed.index.some((r) => r.id === b.id))
  );
  ok(
    "every reported open bug's FIRST index status is genuinely OPEN",
    btFindings.openBugs.every((b) => b.statuses[0] === 'OPEN')
  );
  ok(
    'open-bug count is smaller than the full index — most bugs here are not open',
    btFindings.openBugs.length < btFindings.totalIndexed
  );
  ok(
    'non-canonical statuses are real status-shaped words, never a filename or identifier that merely sat on the same line',
    btFindings.nonCanonical.every((n) => /^(OPEN|BUILT|LIVE|CLOSED)\b/.test(n.status))
  );

  // Synthetic edge case: a doc where index and body fully disagree, proving
  // the diff direction (not just "it found the one drift the real file has").
  const syntheticBt = bugTrackerFindings(
    parseBugTracker(
      '## Status vocabulary\n\n| Status | Means |\n| --- | --- |\n| `OPEN` | x |\n\n## Index\n\n| # | Bug | Subsystem | Status |\n| --- | --- | --- | --- |\n| 1 | only in index | x | `OPEN` |\n\n## 2. only in body\n\n**Status:** `OPEN`\n'
    )
  );
  ok('detects an index row with no matching body entry', syntheticBt.indexOnly.includes(1));
  ok('detects a body entry with no matching index row', syntheticBt.bodyOnly.includes(2));

  // ── holy doc activity: raw counts, not a verdict ──────────────────────────
  const uiTestamentText = readFileSync(join(ROOT, 'docs', 'holy', 'UI-Testament.md'), 'utf8');
  const uiActivity = parseHolyDocActivity(uiTestamentText);
  ok('counts real open checkboxes in the UI Testament', uiActivity.open > 0);
  ok('counts real petitions in the UI Testament', uiActivity.petitions > 0);
  ok(
    'a doc with heavy petition activity is NOT silently hidden by a low done-count — both numbers are just returned',
    uiActivity.petitions > uiActivity.countersigned
  );
  const emptyActivity = parseHolyDocActivity('# nothing here\njust prose, no lists\n');
  ok(
    'a doc with no checklist at all reads as all zeros, not an error',
    Object.values(emptyActivity).every((n) => n === 0)
  );

  // ── the "nothing built" contradiction scan ────────────────────────────────
  const planningFiles = readdirSync(join(ROOT, 'docs', 'planning'), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => ({
      path: `docs/planning/${d.name}`,
      text: readFileSync(join(ROOT, 'docs', 'planning', d.name), 'utf8'),
    }));
  const nbDrift = findNothingBuiltContradiction(planningFiles);
  ok(
    'finds Precipitation.md contradicting its own "DESIGN ONLY. NOTHING BUILT." header',
    nbDrift.some((d) => d.path.endsWith('Precipitation.md'))
  );
  ok(
    'every reported contradiction actually contains at least one BUILT/LIVE citation',
    nbDrift.every((d) => d.builtCount > 0)
  );
  ok(
    'a doc that only claims nothing built, and truly has nothing built, is not flagged',
    findNothingBuiltContradiction([{ path: 'x.md', text: 'DESIGN ONLY. NOTHING BUILT.\n\nJust prose, no code.' }])
      .length === 0
  );
  ok(
    'a doc with BUILT items but no such header claim is not flagged',
    findNothingBuiltContradiction([{ path: 'x.md', text: 'Status: `BUILT (unverified)` — real progress.' }]).length ===
      0
  );

  // ── the survey: blocks derived from the tree, never listed ───────────────
  const srcPaths = walkSources(ROOT, join(ROOT, 'src'));
  ok('walks a real source tree', srcPaths.length > 200);
  ok(
    'excludes tests and vendor — the code, not its proof or its dependencies',
    srcPaths.every((p) => !p.includes('__tests__') && !p.includes('vendor/'))
  );
  ok(
    'every walked path is a repo-relative .js file with POSIX separators',
    srcPaths.every((p) => p.startsWith('src/') && p.endsWith('.js') && !p.includes('\\'))
  );
  ok(
    'the walk is sorted, so two runs diff cleanly',
    srcPaths.every((p, i, arr) => i === 0 || arr[i - 1] <= p)
  );

  ok('zoneOf splits effects two levels deep', zoneOf('src/effects/water/water-render.js') === 'effects/water');
  ok('zoneOf splits everything else one level', zoneOf('src/vt/vt-pan-viewer.js') === 'vt');
  ok('zoneOf puts a root file in its own zone', zoneOf('src/boot.js') === '(root)');

  ok(
    'describeModule pulls real prose out of a real header',
    (describeModule(readFileSync(join(ROOT, 'src/effects/water/water-render.js'), 'utf8')) ?? '').includes('WATER')
  );
  ok(
    'describeModule strips JSDoc tag lines',
    !(describeModule('/**\n * Real prose here.\n * @module x/y\n */') ?? '').includes('@module')
  );
  ok(
    'describeModule keeps the text after @fileoverview rather than dropping the line',
    (describeModule('/**\n * @fileoverview the real summary\n */') ?? '').includes('the real summary')
  );
  ok(
    'describeModule returns null when there is nothing usable, never a placeholder',
    describeModule('const x = 1;') === null
  );
  ok(
    'describeModule truncates with an ellipsis rather than mid-word forever',
    (describeModule('/**\n * ' + 'word '.repeat(200) + '\n */', 80) ?? '').endsWith('…')
  );

  const effZoning = EFFECT_ZONING;
  const zoneNames = [...new Set(srcPaths.map(zoneOf))];
  const zoneEffectIds = deriveZoneEffectIds(zoneNames, MANIFESTS);
  ok('derives effects/water → the water effect', zoneEffectIds['effects/water'] === 'water');
  ok(
    'derives NO effect for effects/lighting — shared machinery, not an effect',
    !('effects/lighting' in zoneEffectIds)
  );
  ok(
    'every derived pairing names a real manifest id',
    Object.values(zoneEffectIds).every((id) => MANIFESTS.some((m) => m.id === id))
  );
  // Only an effect with ITS OWN zone gets an effecthead/rungs block on the
  // page — that is what the assertion two lines up already proves for
  // effects/lighting. An effect sharing a folder with others (grade's own
  // rungs aside, most of lighting/particles/vision/window's residents) has no
  // addressable UI surface yet; the render-back checks below only cover the
  // ones that do, rather than silently assuming universal coverage.
  const effectsWithOwnZone = new Set(Object.values(zoneEffectIds));

  // lastTouched MUST be included here — its absence is exactly what first
  // broke the freshness gate below: without it, this reconstruction produced
  // a DIFFERENT model than main() actually builds, so the fingerprints could
  // never agree even on an untouched tree. Caught by the gate it was meant to
  // protect, the first time it ran for real.
  const surveyed = buildSurvey({
    paths: srcPaths,
    read: (p) => readFileSync(join(ROOT, p), 'utf8'),
    uniformBudgets: JSON.parse(readFileSync(join(ROOT, 'tools', 'uniform-budgets.json'), 'utf8')),
    effectZoning: effZoning,
    zoneEffectIds,
    lastTouched: gitLastTouchedAll(srcPaths),
  });
  ok('surveys every walked file', surveyed.totalFiles === srcPaths.length);
  ok('zone line counts sum to the total', surveyed.zones.reduce((a, z) => a + z.lines, 0) === surveyed.totalLines);
  ok(
    'zones are ordered biggest-first — the mosaic reads by weight',
    surveyed.zones.every((z, i, arr) => i === 0 || arr[i - 1].lines >= z.lines)
  );
  ok(
    'files within a zone are ordered biggest-first too',
    surveyed.zones.every((z) => z.files.every((f, i, arr) => i === 0 || arr[i - 1].lines >= f.lines))
  );
  ok(
    'the real tree is fully self-describing — every file yielded prose from its own header',
    surveyed.describedFiles === surveyed.totalFiles
  );
  ok(
    'flags the known god-object',
    surveyed.zones.some((z) =>
      z.files.some((f) => f.path.endsWith('vt-pan-viewer.js') && f.signals.some((s) => s.kind === 'god-object'))
    )
  );

  // A perf-coverage concern belongs to the EFFECT, not to each of its files —
  // attaching it per-file reported one concern 18 times for water.
  const water = surveyed.zones.find((z) => z.name === 'effects/water');
  ok('a zone-level perf signal is recorded once on the zone', water.zoneSignals.length >= 1);
  ok(
    'and never duplicated onto every file in that zone',
    water.files.every((f) => !f.signals.some((s) => s.kind === 'partly-measured' || s.kind === 'unmeasured'))
  );

  ok(
    'a zone whose effect has no perf-zone entry at all is a warning, not silence',
    signalsForZone({ name: 'effects/ghost', effectId: 'ghost' }, { effectZoning: {} })[0]?.kind === 'unmeasured'
  );
  ok(
    'full perf coverage produces no signal',
    signalsForZone({ name: 'effects/x', effectId: 'x' }, { effectZoning: { x: { coverage: 'full' } } }).length === 0
  );
  ok(
    'a zone that is not an effect is never flagged unmeasured',
    signalsForZone({ name: 'vt', effectId: null }, { effectZoning: {} }).length === 0
  );

  // ── gaps ─────────────────────────────────────────────────────────────────
  const foundGaps = findGaps(PASSES, MANIFESTS);
  ok(
    'every non-live pass becomes a gap',
    foundGaps.filter((g) => g.kind === 'pass').length === PASSES.filter((p) => p.status !== 'live').length
  );
  ok(
    'no live pass is ever a gap',
    foundGaps.every((g) => g.kind !== 'pass' || PASSES.find((p) => p.id === g.id)?.status !== 'live')
  );
  ok(
    'every deferred rung on every manifest becomes a gap',
    foundGaps.filter((g) => g.kind === 'rung').length ===
      MANIFESTS.reduce((a, m) => a + (m.deferredRungs ?? []).length, 0)
  );
  ok(
    'gaps are ordered by how much V2 surface they strand',
    foundGaps.every((g, i, arr) => i === 0 || arr[i - 1].weight >= g.weight)
  );
  ok('the heaviest gap is post.grade — the 14-class blocker', foundGaps[0].id === 'post.grade');

  // ── render ───────────────────────────────────────────────────────────────
  const html = renderHtml(
    baseModel({
      pillars,
      pillarScore: score,
      passes: PASSES,
      passCov: cov,
      effects: rungs,
      tri,
      blind,
      ledgerErrors: [],
      bugs: btFindings,
      survey: surveyed,
      gaps: foundGaps,
      doneSince,
      rungs: describedRungs,
      grades: gradesVerdict.resolved,
      workitems: workitemsVerdict.resolved,
      perf,
    })
  );
  ok('renders a complete document', html.startsWith('<!doctype html>') && html.trimEnd().endsWith('</html>'));
  ok(
    'is ONE continuous document with anchor sections, not several hidden views — the single-interface ask',
    ['module', 'worth-doing', 'critical', 'signals'].every((id) => html.includes(`id="${id}"`)) &&
      !html.includes('id="board"') &&
      !html.includes('id="overview"')
  );
  ok(
    'the jump nav is plain anchor links, not buttons needing a click handler',
    /<nav class="jump">(?:\s*<a href="#[^"]+">.*?<\/a>){4}\s*<\/nav>/s.test(html)
  );

  // ── LIVE-DOC SAFETY — the rules that make the write-back work ────────────
  // On the published page the markup IS the shared document. These pin the
  // three contract rules that are silent-failure-shaped if broken: a textarea
  // would swallow every word typed into it, a class-toggling gesture would
  // publish one viewer's navigation to everyone, and a note holding child
  // elements cannot be saved at all.
  ok(
    'no <textarea> anywhere — the runtime does not capture textarea values, so one would silently lose every note',
    !/<textarea/i.test(html)
  );
  ok(
    'notes are contenteditable elements with a stable data-block address',
    /<p class="notein" contenteditable="true" data-block="[^"]+"/.test(html)
  );
  ok(
    'verdict controls are real checkboxes, whose state the runtime does capture',
    html.includes('type="checkbox" data-seen=')
  );
  ok(
    'no scripted view-switching remains — anchor links need none, so nothing writes a data-local-* view attribute',
    !html.includes('dataset.localView') && !html.includes("classList.toggle('on'")
  );
  // Drill-down and the note fold are BOTH `<details>`: the contract lists `open`
  // on `<details>` among the states that stay the viewer's own, so this needs no
  // JS and cannot leak one person's browsing into everyone's document.
  ok('zones fold with <details>, not a scripted class or attribute', /<details class="zone /.test(html));
  ok('notes fold with <details> too', /<details class="note">/.test(html));
  ok(
    'the only scripted behaviour left is tab switching — folding costs no JS at all',
    !html.includes('dataset.localOpen') && !html.includes('data-zone-toggle')
  );
  ok(
    'a note is never open by default — 437 permanently-visible inputs was the first draft’s loudest fault',
    !/<details class="note" open/.test(html)
  );
  const gapPassesOnly = foundGaps.filter((g) => g.kind === 'pass');
  const rungsInZonedEffects = describedRungs.filter((r) => effectsWithOwnZone.has(r.effectId));
  ok(
    'every zone, every pass-gap, and every rung of a zoned effect can be written back to',
    surveyed.zones.every((z) => html.includes(`data-block="zone:${z.name}"`)) &&
      gapPassesOnly.every((g) => html.includes(`data-block="gap:${escapeHtml(g.id)}"`)) &&
      rungsInZonedEffects.every((r) => html.includes(`data-block="${escapeHtml(r.ref)}"`))
  );
  ok(
    'every surveyed file carries its own note box',
    surveyed.zones.every((z) => z.files.every((f) => html.includes(`data-block="file:${f.path}"`)))
  );
  ok('block sizing is emitted as a span class, so area tracks code volume', /class="zone sp-(xl|lg|sm)/.test(html));
  ok('the biggest zone claims the widest tier', html.includes('<details class="zone sp-xl'));
  ok(
    'the opener states the orienting figures before any detail',
    /class="figures"/.test(html) && html.includes(surveyed.totalLines.toLocaleString())
  );
  ok('a legend explains what the marks mean', /class="legend"/.test(html) && html.includes('a named problem'));

  // ── the warm ground ──────────────────────────────────────────────────────
  const wDark = warmNeutrals('dark');
  const wLight = warmNeutrals('light');
  ok('both themes get their own warm neutral ramp', wDark['--bg0'] !== wLight['--bg0']);
  ok(
    'ONLY neutrals are overridden — every semantic colour still comes from LANTERN',
    ['--ok', '--warn', '--fail', '--shine', '--c-atmos', '--info'].every((k) => !(k in wDark) && !(k in wLight))
  );
  const warmed = themeBlocks(() => ({ '--bg0': '#000000', '--ok': '#00ff00' }), '');
  ok('the warm ramp layers OVER the real token set, never instead of it', warmed.includes('--ok:#00ff00'));
  ok('…and wins for the one neutral it overrides', warmed.includes(`--bg0:${wDark['--bg0']}`));

  // LANTERN gates its own palette on measured WCAG contrast (`ui/__tests__/
  // tokens.test.mjs`). Overriding its neutrals without carrying that gate over
  // would quietly opt this page out of the one check that made the originals
  // trustworthy — so the warm ramp is measured too, on the same bars.
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const f = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const theme of ['dark', 'light']) {
    const w = warmNeutrals(theme);
    for (const ground of ['--bg0', '--bg1', '--bg2']) {
      ok(
        `${theme}: body text (--ink0) clears WCAG AA on ${ground} (${contrast(w['--ink0'], w[ground]).toFixed(2)}:1)`,
        contrast(w['--ink0'], w[ground]) >= 4.5
      );
      ok(
        `${theme}: secondary text (--ink1) clears WCAG AA on ${ground} (${contrast(w['--ink1'], w[ground]).toFixed(2)}:1)`,
        contrast(w['--ink1'], w[ground]) >= 4.5
      );
      ok(
        `${theme}: muted text (--ink2) clears WCAG AA on ${ground} (${contrast(w['--ink2'], w[ground]).toFixed(2)}:1)`,
        contrast(w['--ink2'], w[ground]) >= 4.5
      );
    }
  }
  ok('is self-contained — no external stylesheet, script or image', !/<(link|img)\b|<script[^>]+src=/i.test(html));
  // A regression pin: a stray backtick pair typed into a CSS *comment* inside
  // PAGE_CSS's own template literal once closed that literal early. The rest
  // of the string became `TemplateLiteral < main > TemplateLiteral2` — valid
  // JS, coerced through Function#toString and NaN, silently collapsing the
  // WHOLE stylesheet to the boolean `false`. No test caught it because every
  // other CSS-related assertion here checks class attributes on elements, not
  // the actual <style> tag content — the page still had the right markup, it
  // just had no styling at all. Caught only by a live author report ("the UI
  // looks really messed up") and a computed-style check in the browser.
  const styleTagBodies = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  ok('emits exactly two <style> tags — the tokens and the page CSS', styleTagBodies.length === 2);
  ok(
    'neither <style> tag ever collapses to a stray boolean/primitive — a real CSS block, every time',
    styleTagBodies.every((s) => !/^(true|false|undefined|null|NaN|\d+)$/.test(s.trim()))
  );
  // Only the SECOND tag (PAGE_CSS, the module-level constant) is checked for
  // real bulk — the first tag is `tokensCss`, which in this test fixture is
  // deliberately a tiny stand-in (`:root{--bg0:#000}`), not the real ~4KB
  // token sheet main() actually loads.
  ok('the page CSS tag is a real, substantial stylesheet, not a truncated fragment', styleTagBodies[1].length > 1000);
  ok(
    'the page stylesheet actually styles body and main, not just :root tokens',
    /body\{[^}]*background:var\(--bg0\)/.test(html) && /main\{[^}]*max-width:1280px/.test(html)
  );
  ok(
    'the real, currently-open bugs are named on the page',
    btFindings.openBugs.every((b) => html.includes(`#${b.id}`))
  );
  ok('the real bug-tracker drift (missing #6) is named on the page', html.includes('#6'));
  ok(
    'names every pillar it scored',
    pillars.every((p) => html.includes(escapeHtml(p.name)))
  );
  ok(
    'names every effect that owns its own zone — each carries its own effect-level grade control',
    rungs.rows.filter((r) => effectsWithOwnZone.has(r.id)).every((r) => html.includes(`name="grade-effect:${r.id}"`))
  );
  ok(
    'escapes markup rather than emitting it raw',
    renderHtml(
      baseModel({
        generatedAt: '<script>x</script>',
        pillars: [],
        pillarScore: score,
        passes: [],
        passCov: cov,
        effects: { rows: [], built: 0, deferred: 0, pct: 0 },
        tri,
        blind: [],
        ledgerErrors: [],
      })
    ).includes('&lt;script&gt;')
  );
  ok(
    'a broken ledger is shown on the page, not swallowed',
    renderHtml(
      baseModel({
        pillars,
        pillarScore: score,
        passes: PASSES,
        passCov: cov,
        effects: rungs,
        tri,
        blind,
        ledgerErrors: ['something is wrong'],
      })
    ).includes('something is wrong')
  );
  ok(
    'critical bugs render even when everything else about the ledger is empty',
    renderHtml(
      baseModel({
        pillars: [],
        pillarScore: score,
        passes: [],
        passCov: cov,
        effects: { rows: [], built: 0, deferred: 0, pct: 0 },
        tri,
        blind: [],
        ledgerErrors: [],
        bugs: btFindings,
      })
    ).includes(`#${btFindings.openBugs[0]?.id}`)
  );

  ok(
    'the "Done since judged" section is absent when nothing has resolved — a real 0, not an empty shell',
    !renderHtml(
      baseModel({
        pillars,
        pillarScore: score,
        passes: PASSES,
        passCov: cov,
        effects: rungs,
        tri,
        blind,
        ledgerErrors: [],
        doneSince: [],
      })
    ).includes('Done since judged')
  );
  const fakeDone = resolveOf({ ref: `pass:${aLivePass.id}` });
  const doneHtml = renderHtml(
    baseModel({
      pillars,
      pillarScore: score,
      passes: PASSES,
      passCov: cov,
      effects: rungs,
      tri,
      blind,
      ledgerErrors: [],
      doneSince: fakeDone,
    })
  );
  ok('the section appears once something actually resolves', doneHtml.includes('Done since judged'));
  ok('and names the specific resolved item, not just a count', doneHtml.includes(`>pass:${escapeHtml(aLivePass.id)}<`));
  ok(
    'marking a card resolved never silently drops its own written note',
    doneHtml.includes(escapeHtml(fakeDone[0].backOnItsLegs))
  );

  // ── the hosted build: three theme states, no document shell ──────────────
  // The classic unreadable-artifact bug is a colour whose ONLY definition sits
  // behind a media query or a [data-theme] stamp — in the un-stamped state (the
  // default for most viewers) it never applies, and the page renders one theme's
  // text on the other theme's ground.
  // The probe token is a SEMANTIC one (`--ok`), not a neutral: the warm ramp
  // deliberately overrides every neutral, so probing `--bg0` here would only
  // ever re-test the override. `--ok` proves the underlying palette flows all
  // the way through to each of the three theme states.
  const fakeTokens = (t) =>
    t === 'dark' ? { '--ok': '#0d0', '--ink0': '#eee' } : { '--ok': '#080', '--ink0': '#111' };
  const tb = themeBlocks(
    fakeTokens,
    ':root{--sp1:4px}\nhtml[data-theme="dark"]{--bg0:#111}\n:focus-visible{outline:2px}'
  );
  ok('bare :root carries a full palette — the un-stamped viewer is the common case', /:root\{[^}]*--ok:#0d0/.test(tb));
  ok(
    'the light override is guarded so an explicit dark choice still wins',
    tb.includes('@media (prefers-color-scheme: light){:root:not([data-theme="dark"])')
  );
  ok('an explicit light stamp is honoured', /:root\[data-theme="light"\]\{[^}]*--ok:#080/.test(tb));
  ok('an explicit dark stamp is honoured', /:root\[data-theme="dark"\]\{[^}]*--ok:#0d0/.test(tb));
  ok(
    'and each of the three states also carries the warm ground, not just the accents',
    (tb.match(new RegExp(`--bg0:${warmNeutrals('dark')['--bg0']}`, 'g')) ?? []).length >= 2
  );
  ok(
    'the source tokens’ own html[data-theme] rules are stripped, not left to double up',
    !tb.includes('html[data-theme')
  );
  ok('non-token utility rules survive the strip', tb.includes(':focus-visible'));

  const artifactHtml = renderHtml(
    baseModel({
      tokensCss: tb,
      pillars,
      pillarScore: score,
      passes: PASSES,
      passCov: cov,
      effects: rungs,
      tri,
      blind,
      ledgerErrors: [],
      bugs: btFindings,
      mode: 'artifact',
    })
  );
  ok('artifact mode emits no document shell — the host supplies one', !/<!doctype|<html|<body/i.test(artifactHtml));
  ok('artifact mode still names the page', artifactHtml.includes('<title>The Chart Room</title>'));
  ok('artifact mode never stamps a theme — it inherits the viewer’s', !artifactHtml.includes('dataset.theme'));
  ok('artifact mode is still self-contained', !/<(link|img)\b|<script[^>]+src=/i.test(artifactHtml));
  ok(
    'artifact and standalone carry the same content',
    artifactHtml.includes('Easy wins') && html.includes('Easy wins')
  );
  ok(
    'artifact mode also gets a real page stylesheet, not a collapsed primitive',
    [...artifactHtml.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1])[1]?.length > 1000
  );

  // ── THE FRESHNESS GATE — the author's own ask: "worth a mechanism… it's
  // either a control panel or a useless piece of outdated artwork." ─────────
  // One authoritative check replaces guessing which of dozens of numbers might
  // have drifted: rebuild the EXACT model `main()` builds, hash it the same
  // way the page itself does, and demand the checked-in file's own embedded
  // fingerprint agrees. This is what makes `npm test`/`npm run verify` — the
  // gate this project already requires green before any commit — the thing
  // that makes staleness impossible to miss, not just theoretically detectable.
  // Found via the freshness gate itself, the first time it ran for real: this
  // reconstruction disagreed with main()'s own until `lastTouched` was added
  // here too — proof the gate catches a real mismatch, not just a contrived one.
  const holyFileNames = readdirSync(join(ROOT, 'docs', 'holy'), { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.md'))
    .map((d) => d.name)
    .sort();
  const holyTouched = gitLastTouchedAll(holyFileNames.map((name) => `docs/holy/${name}`));
  const holyActivity = holyFileNames.map((name) => ({
    name,
    ...parseHolyDocActivity(readFileSync(join(ROOT, 'docs', 'holy', name), 'utf8')),
    lastTouched: holyTouched[`docs/holy/${name}`] ?? null,
  }));
  const ledgerErrorsAll = [
    ...verdict.errors.map((e) => `judgements.json: ${e}`),
    ...workitemsVerdict.errors.map((e) => `workitems.json: ${e}`),
    ...gradesVerdict.errors.map((e) => `grades.json: ${e}`),
  ];
  const fullModel = {
    pillars,
    pillarScore: score,
    passes: PASSES,
    passCov: cov,
    effects: rungs,
    tri,
    blind,
    ledgerErrors: ledgerErrorsAll,
    bugs: btFindings,
    holyActivity,
    nothingBuiltDrift: nbDrift,
    survey: surveyed,
    gaps: foundGaps,
    doneSince,
    rungs: describedRungs,
    grades: gradesVerdict.resolved,
    workitems: workitemsVerdict.resolved,
    perf,
  };
  const freshFingerprint = computeFingerprint(fullModel);
  ok(
    'computeFingerprint is deterministic — the same reality hashes to the same id twice',
    computeFingerprint(fullModel) === freshFingerprint
  );
  ok(
    'the fingerprint changes when a judgement note is edited — content drift is content drift, not just numbers',
    computeFingerprint({ ...fullModel, doneSince: [...doneSince, { ref: 'x:y', note: 'new' }] }) !== freshFingerprint
  );
  ok(
    'presentation fields (generatedAt/tokensCss/mode) do NOT affect the fingerprint — only content does',
    computeFingerprint({ ...fullModel, generatedAt: '1999-01-01', tokensCss: 'anything', mode: 'artifact' }) ===
      freshFingerprint
  );

  // A checked-in page that no longer matches its own inputs is exactly the
  // "instrument that lies" this project keeps paying for.
  const onDisk = readFileSync(join(HERE, 'index.html'), 'utf8');
  const onDiskFingerprint = extractFingerprint(onDisk);
  ok('the checked-in page carries a real, well-formed fingerprint', /^[0-9a-f]{12}$/.test(onDiskFingerprint ?? ''));
  ok(
    `the checked-in page's OWN fingerprint matches what current source would build right now ` +
      `(disk: ${onDiskFingerprint}, fresh: ${freshFingerprint}) — if this fails, run ` +
      `'node tools/chart-room/build-chart-room.mjs' and republish`,
    onDiskFingerprint === freshFingerprint
  );
  ok(
    'the local build and the hosted artifact build carry the SAME fingerprint for the same data',
    computeFingerprint({ ...fullModel, mode: 'artifact' }) === freshFingerprint
  );

  // Still worth keeping a couple of human-readable checks alongside the hash —
  // if the fingerprint ever fails, these say WHAT drifted without anyone
  // having to regenerate and diff by hand first.
  ok(
    'the checked-in page reports the same parity figure the code computes',
    onDisk.includes(`>${score.pct.toFixed(0)}<`)
  );
  ok(
    'the checked-in page carries a grade control for every effect that owns its own zone',
    rungs.rows.filter((r) => effectsWithOwnZone.has(r.id)).every((r) => onDisk.includes(`name="grade-effect:${r.id}"`))
  );
  ok(
    'the checked-in page carries the same open-bug count the code computes right now',
    onDisk.includes(`Critical <span class="count">${btFindings.openBugs.length}</span>`)
  );

  // ── --check mode itself: proves the CLI freshness gate agrees with the test
  // — robust to either verdict, since a FRESH run exits 0 (execFileSync
  // returns normally) but a STALE one exits 1 (execFileSync throws, with the
  // message still on stdout/stderr) — exactly the state this whole mechanism
  // exists to make loud rather than swallow.
  let checkOut;
  try {
    checkOut = execFileSync(process.execPath, [join(HERE, 'build-chart-room.mjs'), '--check'], { encoding: 'utf8' });
  } catch (e) {
    checkOut = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  ok(
    '`--check` reports FRESH on the real, currently-committed tree — same verdict as the test above',
    /FRESH/.test(checkOut) === (onDiskFingerprint === freshFingerprint)
  );
  ok(
    '`--check` never writes — a stale page stays exactly as stale as it was',
    readFileSync(join(HERE, 'index.html'), 'utf8') === onDisk
  );
}
