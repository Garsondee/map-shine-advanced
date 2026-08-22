/**
 * SYNC FROM ARTIFACT — read back what Ingram actually did on the live page.
 *
 * The Chart Room's `artifact` capability journals his clicks and typing into
 * the SERVED document, but nothing pushes them to a running Claude session
 * (see the `.syncnote` callout on the page itself, and the code comment on
 * `noteBox()` in `build-chart-room.mjs` — both say so plainly). This is the
 * other half of that loop: given a raw HTML snapshot of the published
 * artifact — get one via WebFetch on the artifact URL, which for a real
 * `claude.ai/code/artifact/<uuid>` link returns the actual markup, not a
 * summarized rewrite, and saves it to a local file — extract every grade
 * radio, confirm checkbox, and note he left, and report what changed against
 * the checked-in `grades.json`/`confirmations.json`.
 *
 * Deliberately conservative about what it writes, matching *"you can only
 * confirm that you built something, I am the only one capable of confirming
 * if it really landed"*:
 * - A checked grade radio or confirm checkbox is UNAMBIGUOUS — exactly what
 *   he clicked, nothing to interpret — so `--write` applies these directly.
 *   This is transcribing his own edit, not authoring content on his behalf.
 * - Free-text note bodies are NEVER auto-filed anywhere. Deciding whether a
 *   note becomes a new work item, amends an existing one, or is just
 *   something to read and act on by hand needs judgement a regex does not
 *   have. They are always printed, never written.
 *
 * NOT wired to run automatically (feedback_no_wasteful_background_tasks) — a
 * manual step: fetch the artifact, save its HTML, run this against the save.
 *
 * Usage: node tools/chart-room/sync-from-artifact.mjs <path-to-saved-html> [--write]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const GRADES_FILE = join(HERE, 'grades.json');
const CONFIRMATIONS_FILE = join(HERE, 'confirmations.json');

function decodeAttr(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Every CHECKED grade radio in the page. `gradePicker()` emits one
 * `<input type="radio" name="grade-<ref>" value="<letter>">` per grade letter
 * and puts ` checked` on at most one of them, so this can only ever match the
 * single currently-selected letter for a given ref — an unchecked option
 * carries no `checked` token and never matches.
 *
 * @param {string} html
 * @returns {Array<{ref: string, grade: string}>}
 */
export function extractCheckedGrades(html) {
  const out = [];
  const re = /name="grade-([^"]+)"\s+value="([^"]+)"\s+checked/g;
  let m;
  while ((m = re.exec(html))) out.push({ ref: decodeAttr(m[1]), grade: decodeAttr(m[2]) });
  return out;
}

/**
 * Every CHECKED confirm-working / confirm-wrong checkbox — `confirmPicker()`
 * emits both as independent checkboxes on the same ref, so they are read
 * independently and merged by ref.
 *
 * @param {string} html
 * @returns {Array<{ref: string, seenWorking: boolean, wrong: boolean}>}
 */
export function extractConfirmations(html) {
  const byRef = new Map();
  const seenRe = /data-confirm-seen="([^"]+)"([^>]*)>/g;
  const wrongRe = /data-confirm-wrong="([^"]+)"([^>]*)>/g;
  let m;
  while ((m = seenRe.exec(html))) {
    const ref = decodeAttr(m[1]);
    if (/\bchecked\b/.test(m[2])) byRef.set(ref, { ...(byRef.get(ref) ?? {}), seenWorking: true });
  }
  while ((m = wrongRe.exec(html))) {
    const ref = decodeAttr(m[1]);
    if (/\bchecked\b/.test(m[2])) byRef.set(ref, { ...(byRef.get(ref) ?? {}), wrong: true });
  }
  return [...byRef.entries()].map(([ref, v]) => ({
    ref,
    seenWorking: v.seenWorking === true,
    wrong: v.wrong === true,
  }));
}

/**
 * Every note box that actually has text in it. An empty `contenteditable`
 * (never typed into, showing only its `data-placeholder` via CSS) has no
 * inner text to match, so it is silently skipped — there is nothing to sync.
 *
 * @param {string} html
 * @returns {Array<{ref: string, text: string}>}
 */
export function extractNotes(html) {
  const out = [];
  const re = /<p class="notein" contenteditable="true" data-block="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(html))) {
    const text = decodeAttr(m[2].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
    if (text) out.push({ ref: decodeAttr(m[1]), text });
  }
  return out;
}

/** Only what actually changed — a re-sync of an untouched page reports nothing. */
export function diffGrades(extracted, currentGrades, today) {
  const byRef = new Map(currentGrades.map((g) => [g.ref, g]));
  const changed = [];
  for (const { ref, grade } of extracted) {
    const cur = byRef.get(ref);
    if (!cur || cur.grade !== grade) {
      changed.push({ ref, grade, was: cur?.grade ?? null, gradedBy: 'ingram', gradedAt: today });
    }
  }
  return changed;
}

/** Both boxes unchecked is "not confirmed yet", not a change worth recording. */
export function diffConfirmations(extracted, currentConfirmations, today) {
  const byRef = new Map(currentConfirmations.map((c) => [c.ref, c]));
  const changed = [];
  for (const { ref, seenWorking, wrong } of extracted) {
    if (!seenWorking && !wrong) continue;
    const cur = byRef.get(ref);
    if (!cur || cur.seenWorking !== seenWorking || cur.wrong !== wrong) {
      changed.push({ ref, seenWorking, wrong, confirmedAt: today });
    }
  }
  return changed;
}

function applyGradeChanges(currentGrades, gradeChanges) {
  const byRef = new Map(currentGrades.map((g) => [g.ref, g]));
  for (const c of gradeChanges) {
    byRef.set(c.ref, {
      ...(byRef.get(c.ref) ?? {}),
      ref: c.ref,
      grade: c.grade,
      gradedBy: 'ingram',
      gradedAt: c.gradedAt,
    });
  }
  return [...byRef.values()];
}

function applyConfirmationChanges(currentConfirmations, confirmChanges) {
  const byRef = new Map(currentConfirmations.map((c) => [c.ref, c]));
  for (const c of confirmChanges) {
    byRef.set(c.ref, {
      ...(byRef.get(c.ref) ?? {}),
      ref: c.ref,
      seenWorking: c.seenWorking,
      wrong: c.wrong,
      confirmedAt: c.confirmedAt,
    });
  }
  return [...byRef.values()];
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const htmlPath = args.find((a) => !a.startsWith('--'));
  if (!htmlPath) {
    console.error('Usage: node tools/chart-room/sync-from-artifact.mjs <path-to-saved-html> [--write]');
    console.error('Get <path-to-saved-html> by asking Claude to WebFetch the published artifact URL.');
    process.exitCode = 1;
    return;
  }
  const html = readFileSync(htmlPath, 'utf8');
  const today = new Date().toISOString().slice(0, 10);

  const currentGrades = JSON.parse(readFileSync(GRADES_FILE, 'utf8'));
  const currentConfirmations = JSON.parse(readFileSync(CONFIRMATIONS_FILE, 'utf8'));

  const gradeChanges = diffGrades(extractCheckedGrades(html), currentGrades, today);
  const confirmChanges = diffConfirmations(extractConfirmations(html), currentConfirmations, today);
  const notes = extractNotes(html);

  console.log(`sync-from-artifact ← ${htmlPath}`);
  if (gradeChanges.length) {
    console.log(`  ${gradeChanges.length} grade change(s):`);
    for (const c of gradeChanges) console.log(`    ${c.ref}: ${c.was ?? '(none)'} -> ${c.grade}`);
  } else {
    console.log('  no grade changes');
  }
  if (confirmChanges.length) {
    console.log(`  ${confirmChanges.length} confirmation change(s):`);
    for (const c of confirmChanges) console.log(`    ${c.ref}: seenWorking=${c.seenWorking} wrong=${c.wrong}`);
  } else {
    console.log('  no confirmation changes');
  }
  if (notes.length) {
    console.log(`  ${notes.length} note(s) with text — read these and file them by hand, never auto-applied:`);
    for (const n of notes) console.log(`    [${n.ref}] ${n.text.slice(0, 200)}`);
  } else {
    console.log('  no note text found');
  }

  if (write && (gradeChanges.length || confirmChanges.length)) {
    if (gradeChanges.length) {
      writeFileSync(GRADES_FILE, JSON.stringify(applyGradeChanges(currentGrades, gradeChanges), null, 2) + '\n');
      console.log(`  wrote ${gradeChanges.length} grade change(s) to grades.json`);
    }
    if (confirmChanges.length) {
      writeFileSync(
        CONFIRMATIONS_FILE,
        JSON.stringify(applyConfirmationChanges(currentConfirmations, confirmChanges), null, 2) + '\n'
      );
      console.log(`  wrote ${confirmChanges.length} confirmation change(s) to confirmations.json`);
    }
    console.log(
      '  now run: node tools/chart-room/build-chart-room.mjs && node tools/chart-room/build-chart-room.mjs --check'
    );
  } else if (!write && (gradeChanges.length || confirmChanges.length)) {
    console.log('  (dry run — pass --write to apply these)');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
