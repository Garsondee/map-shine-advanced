/**
 * Tests the server's PURE merge/validate functions only — never spins up a
 * real HTTP server, never touches the real `grades.json`/`confirmations.json`
 * /`notes.json`. Those files are the project's real, checked-in data, and a
 * test that POSTed to a live server would write real test artifacts into
 * them. `mergeGrades`/`mergeConfirmations`/`mergeNotes` take their "current"
 * state as a plain argument specifically so this suite can hand them
 * synthetic data instead — the same measure/evaluate split as the rest of
 * this tool, applied to keep I/O out of the test path entirely.
 *
 * The actual write path (does `/api/sync` really persist to disk, does GET /
 * really reflect it) was verified once, live, against the real files —
 * backed up first, restored after — during this feature's own build. That is
 * not something an automated suite re-proves on every run; it is recorded in
 * project memory instead.
 */
import { mergeGrades, mergeConfirmations, mergeNotes } from './server.mjs';

const KNOWN = {
  effects: new Set(['water', 'fire']),
  builtRungs: new Set(['water:placement', 'water:volume']),
};

export function run(t) {
  const { ok } = t;

  // ── mergeGrades ──────────────────────────────────────────────────────────
  ok(
    'a brand-new grade is added, authored as ingram, dated as given',
    (() => {
      const r = mergeGrades([], [{ ref: 'effect:water', grade: 'B' }], KNOWN, '2026-08-22');
      return (
        r.ok &&
        r.merged.length === 1 &&
        r.merged[0].grade === 'B' &&
        r.merged[0].gradedBy === 'ingram' &&
        r.merged[0].gradedAt === '2026-08-22'
      );
    })()
  );
  ok(
    'an existing grade is overwritten, not duplicated',
    (() => {
      const current = [{ ref: 'effect:water', grade: 'C', gradedBy: 'ingram', gradedAt: '2026-08-01', note: 'old' }];
      const r = mergeGrades(current, [{ ref: 'effect:water', grade: 'A' }], KNOWN, '2026-08-22');
      return r.ok && r.merged.length === 1 && r.merged[0].grade === 'A' && r.merged[0].gradedAt === '2026-08-22';
    })()
  );
  ok(
    'fields not part of the write (like a hand-authored note) survive the merge untouched',
    mergeGrades(
      [{ ref: 'effect:water', grade: 'C', gradedBy: 'ingram', gradedAt: '2026-08-01', note: 'kept' }],
      [{ ref: 'effect:water', grade: 'A' }],
      KNOWN,
      '2026-08-22'
    ).merged[0].note === 'kept'
  );
  ok(
    'an untouched existing grade for a different ref is left exactly as it was',
    (() => {
      const current = [{ ref: 'effect:fire', grade: 'S', gradedBy: 'ingram', gradedAt: '2026-08-01' }];
      const r = mergeGrades(current, [{ ref: 'effect:water', grade: 'A' }], KNOWN, '2026-08-22');
      return r.merged.length === 2 && r.merged.some((g) => g.ref === 'effect:fire' && g.grade === 'S');
    })()
  );
  ok(
    'refuses a grade on a ref that does not resolve — the same rule evaluateGrades enforces everywhere else',
    !mergeGrades([], [{ ref: 'effect:no-such-effect', grade: 'A' }], KNOWN, '2026-08-22').ok
  );
  ok(
    'refuses an illegal grade letter',
    !mergeGrades([], [{ ref: 'effect:water', grade: 'Z' }], KNOWN, '2026-08-22').ok
  );
  ok(
    'refuses grading a rung that is not built',
    !mergeGrades([], [{ ref: 'rung:water:refraction', grade: 'A' }], KNOWN, '2026-08-22').ok
  );
  ok(
    'a bad write in the SAME payload as a good one rejects the WHOLE batch, not a partial write',
    (() => {
      const r = mergeGrades(
        [],
        [
          { ref: 'effect:water', grade: 'A' },
          { ref: 'effect:no-such-effect', grade: 'A' },
        ],
        KNOWN,
        '2026-08-22'
      );
      return !r.ok && r.merged.some((g) => g.ref === 'effect:no-such-effect');
    })()
  );

  // ── mergeConfirmations ───────────────────────────────────────────────────
  ok(
    'a new confirmation is added with the given date',
    (() => {
      const r = mergeConfirmations([], [{ ref: 'effect:water', seenWorking: true, wrong: false }], KNOWN, '2026-08-22');
      return (
        r.ok && r.merged.length === 1 && r.merged[0].seenWorking === true && r.merged[0].confirmedAt === '2026-08-22'
      );
    })()
  );
  ok(
    'non-boolean truthy/falsy input is coerced to a real boolean, never stored as-is',
    mergeConfirmations([], [{ ref: 'effect:water', seenWorking: 1, wrong: 0 }], KNOWN, '2026-08-22').merged[0]
      .seenWorking === true
  );
  ok(
    'refuses confirming something that is not built',
    !mergeConfirmations([], [{ ref: 'rung:water:refraction', seenWorking: true, wrong: false }], KNOWN, '2026-08-22').ok
  );
  ok(
    'an existing confirmation is overwritten in place, not duplicated',
    (() => {
      const current = [{ ref: 'effect:water', seenWorking: true, wrong: false, confirmedAt: '2026-08-01' }];
      const r = mergeConfirmations(
        current,
        [{ ref: 'effect:water', seenWorking: false, wrong: true }],
        KNOWN,
        '2026-08-22'
      );
      return r.merged.length === 1 && r.merged[0].wrong === true && r.merged[0].confirmedAt === '2026-08-22';
    })()
  );

  // ── mergeNotes ───────────────────────────────────────────────────────────
  ok(
    'a real note is added, trimmed, dated',
    (() => {
      const r = mergeNotes([], [{ ref: 'effect:water', text: '  Push this forward.  ' }], '2026-08-22');
      return (
        r.ok &&
        r.merged.length === 1 &&
        r.merged[0].text === 'Push this forward.' &&
        r.merged[0].updatedAt === '2026-08-22'
      );
    })()
  );
  ok(
    'an empty or whitespace-only note is silently skipped, never written as a blank',
    mergeNotes([], [{ ref: 'effect:water', text: '   ' }], '2026-08-22').merged.length === 0
  );
  ok(
    'an existing note is overwritten by a new one on the same ref',
    (() => {
      const current = [{ ref: 'effect:water', text: 'old note', updatedAt: '2026-08-01' }];
      const r = mergeNotes(current, [{ ref: 'effect:water', text: 'new note' }], '2026-08-22');
      return r.merged.length === 1 && r.merged[0].text === 'new note';
    })()
  );
  ok(
    'notes carry no ref-resolution check — a note can address any real namespace, shape only',
    mergeNotes([], [{ ref: 'gap:post.grade', text: 'A real note.' }], '2026-08-22').ok
  );
  ok(
    'refuses an un-namespaced ref even for a note',
    !mergeNotes([], [{ ref: 'water', text: 'A real note.' }], '2026-08-22').ok
  );
}
