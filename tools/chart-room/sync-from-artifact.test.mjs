/**
 * Round-trips the sync script's extractors against markup built by the REAL
 * `gradePicker`/`confirmPicker`/`noteBox` — never hand-typed HTML — so a
 * future change to any of their shapes breaks this test loudly instead of
 * leaving the sync script silently blind to a real edit.
 *
 * No real edited-artifact HTML exists yet to test against (nobody has
 * clicked anything on an authenticated live view from this tool's own
 * checks) — this suite is synthetic snippets ONLY, flagged as such rather
 * than pretending otherwise. The first real sync, once Ingram actually uses
 * the controls, is the true end-to-end proof.
 */
import { gradePicker, confirmPicker, noteBox } from './build-chart-room.mjs';
import {
  extractCheckedGrades,
  extractConfirmations,
  extractNotes,
  diffGrades,
  diffConfirmations,
} from './sync-from-artifact.mjs';

export function run(t) {
  const { ok } = t;

  // ── grades ───────────────────────────────────────────────────────────────
  ok('an ungraded ref yields no checked grade', extractCheckedGrades(gradePicker('effect:water', null)).length === 0);
  ok(
    'a graded ref yields exactly its own checked grade',
    (() => {
      const found = extractCheckedGrades(gradePicker('effect:water', 'C'));
      return found.length === 1 && found[0].ref === 'effect:water' && found[0].grade === 'C';
    })()
  );
  ok(
    'every legal grade round-trips, one at a time',
    ['S', 'A+', 'A', 'B', 'C', 'D', 'F'].every((g) => {
      const found = extractCheckedGrades(gradePicker('rung:water:placement', g));
      return found.length === 1 && found[0].grade === g;
    })
  );
  ok(
    'two different refs on the same page are told apart',
    (() => {
      const html = gradePicker('effect:water', 'C') + gradePicker('effect:fire', 'A');
      const found = extractCheckedGrades(html);
      return (
        found.length === 2 &&
        found.some((f) => f.ref === 'effect:water' && f.grade === 'C') &&
        found.some((f) => f.ref === 'effect:fire' && f.grade === 'A')
      );
    })()
  );

  // ── confirmations ────────────────────────────────────────────────────────
  ok('an unconfirmed ref yields nothing', extractConfirmations(confirmPicker('effect:water', null)).length === 0);
  ok(
    'seenWorking alone extracts as seenWorking:true, wrong:false',
    (() => {
      const found = extractConfirmations(confirmPicker('effect:water', { seenWorking: true, wrong: false }));
      return found.length === 1 && found[0].seenWorking === true && found[0].wrong === false;
    })()
  );
  ok(
    'wrong alone extracts as wrong:true, seenWorking:false',
    (() => {
      const found = extractConfirmations(confirmPicker('effect:water', { seenWorking: false, wrong: true }));
      return found.length === 1 && found[0].seenWorking === false && found[0].wrong === true;
    })()
  );

  // ── notes ────────────────────────────────────────────────────────────────
  ok(
    'an empty note box (never typed into) yields no note',
    extractNotes(noteBox('zone:water', 'placeholder text')).length === 0
  );
  ok(
    'the placeholder text alone is never mistaken for a real note — data-placeholder is an attribute, not content',
    extractNotes(noteBox('zone:water', 'Something the author never typed')).length === 0
  );
  ok(
    'real typed text inside the contenteditable is extracted against its own ref',
    (() => {
      const html = noteBox('rung:water:refraction', 'placeholder').replace(
        '<p class="notein" contenteditable="true" data-block="rung:water:refraction" data-placeholder="placeholder"></p>',
        '<p class="notein" contenteditable="true" data-block="rung:water:refraction" data-placeholder="placeholder">Push this forward please.</p>'
      );
      const found = extractNotes(html);
      return (
        found.length === 1 && found[0].ref === 'rung:water:refraction' && found[0].text === 'Push this forward please.'
      );
    })()
  );
  ok(
    'a note typed across multiple lines (browser <br> line breaks) is joined with real newlines, tags stripped',
    (() => {
      const html = noteBox('zone:water', 'placeholder').replace(
        '<p class="notein" contenteditable="true" data-block="zone:water" data-placeholder="placeholder"></p>',
        '<p class="notein" contenteditable="true" data-block="zone:water" data-placeholder="placeholder">Line one<br>Line two</p>'
      );
      const found = extractNotes(html);
      return found.length === 1 && found[0].text === 'Line one\nLine two';
    })()
  );

  // ── diffing — only what actually changed ────────────────────────────────
  ok(
    'diffGrades reports nothing when the extracted grade matches what is already recorded',
    diffGrades([{ ref: 'effect:water', grade: 'C' }], [{ ref: 'effect:water', grade: 'C' }], '2026-08-22').length === 0
  );
  ok(
    'diffGrades reports a change when the extracted grade differs, carrying the old value as `was`',
    (() => {
      const d = diffGrades([{ ref: 'effect:water', grade: 'B' }], [{ ref: 'effect:water', grade: 'C' }], '2026-08-22');
      return d.length === 1 && d[0].grade === 'B' && d[0].was === 'C' && d[0].gradedBy === 'ingram';
    })()
  );
  ok(
    'diffGrades reports a brand-new grade with was:null',
    diffGrades([{ ref: 'effect:fire', grade: 'A' }], [], '2026-08-22')[0]?.was === null
  );
  ok(
    'diffConfirmations ignores a both-unchecked extraction — nothing was actually confirmed',
    diffConfirmations([{ ref: 'effect:water', seenWorking: false, wrong: false }], [], '2026-08-22').length === 0
  );
  ok(
    'diffConfirmations reports nothing when the extracted state matches what is already recorded',
    diffConfirmations(
      [{ ref: 'effect:water', seenWorking: true, wrong: false }],
      [{ ref: 'effect:water', seenWorking: true, wrong: false, confirmedAt: '2026-08-01' }],
      '2026-08-22'
    ).length === 0
  );
  ok(
    'diffConfirmations reports a real flip from confirmed-working to confirmed-wrong',
    (() => {
      const d = diffConfirmations(
        [{ ref: 'effect:water', seenWorking: false, wrong: true }],
        [{ ref: 'effect:water', seenWorking: true, wrong: false, confirmedAt: '2026-08-01' }],
        '2026-08-22'
      );
      return d.length === 1 && d[0].wrong === true && d[0].confirmedAt === '2026-08-22';
    })()
  );
}
