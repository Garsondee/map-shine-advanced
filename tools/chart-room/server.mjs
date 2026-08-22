/**
 * THE CHART ROOM — LOCAL SERVER, the real "press a button and it syncs."
 *
 * The author's own words, 2026-08-22: *"I make my changes, I grade, I make
 * comments, I hit sync to save everything AND THEN I send you a message here
 * to wake you up."* The published claude.ai Artifact has no capability that
 * lets a page push a notification into a running Claude session — checked
 * directly against the runtime contract, twice, earlier the same day — so
 * every edit made there is a write nobody reads until someone goes looking.
 *
 * This sidesteps that entirely by not going through the platform at all.
 * `/api/sync` writes DIRECTLY into the same `grades.json`/`confirmations.json`
 * /`notes.json` `build-chart-room.mjs` already reads — no platform capability
 * to trust, no HTML to scrape back out. The workflow this exists for: edit
 * here, hit Sync, then say so in chat. Reading the result is then just
 * reading the same three files this whole tool has trusted all along.
 *
 * DEV-ONLY, LOCALHOST-ONLY (matches `shader-lab/serve.mjs`'s own posture,
 * `docs/planning/Shader-Lab.md`) — it writes real project files on request,
 * which is exactly what "the only client is our own page" assumptions get
 * wrong if this ever listened on anything but 127.0.0.1. Not started
 * automatically by anything (feedback_no_wasteful_background_tasks) — the
 * author starts it when he wants to use it: `node tools/chart-room/server.mjs`.
 *
 * Run: node tools/chart-room/server.mjs
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  buildChartRoomModel,
  renderHtml,
  evaluateGrades,
  evaluateConfirmations,
  evaluateNotes,
} from './build-chart-room.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const GRADES_FILE = join(HERE, 'grades.json');
const CONFIRMATIONS_FILE = join(HERE, 'confirmations.json');
const NOTES_FILE = join(HERE, 'notes.json');
const OUT_FILE = join(HERE, 'index.html');
// `PORT` as well as the tool's own variable, same reason shader-lab's serve.mjs
// gives: the harness can hand out a free port when something else already
// holds the default, rather than this simply failing to start.
const port = Number(process.env.CHART_ROOM_PORT || process.env.PORT || 8935);

function readJsonFile(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Merge incoming grade upserts onto the current ledger and validate the
 * WHOLE resulting array through the SAME `evaluateGrades` the CLI build and
 * the test suite both use — a bad write here fails exactly the same way a
 * bad hand-edit of `grades.json` would, never a separate, looser check.
 * `gradedBy` is always `'ingram'`: only a real click through this server's
 * own page reaches this function, so there is no other author it could be.
 *
 * @param {Array<object>} current
 * @param {Array<{ref: string, grade: string}>} incoming
 * @param {object} known
 * @param {string} dateStr
 * @returns {{ok: boolean, errors: string[], merged: Array<object>}}
 */
export function mergeGrades(current, incoming, known, dateStr) {
  const byRef = new Map(current.map((g) => [g.ref, g]));
  for (const { ref, grade } of incoming) {
    byRef.set(ref, { ...(byRef.get(ref) ?? {}), ref, grade, gradedBy: 'ingram', gradedAt: dateStr });
  }
  const merged = [...byRef.values()];
  const verdict = evaluateGrades(merged, known);
  return { ok: verdict.ok, errors: verdict.errors, merged };
}

/** Same shape as {@link mergeGrades}, for `confirmations.json`. */
export function mergeConfirmations(current, incoming, known, dateStr) {
  const byRef = new Map(current.map((c) => [c.ref, c]));
  for (const { ref, seenWorking, wrong } of incoming) {
    byRef.set(ref, {
      ...(byRef.get(ref) ?? {}),
      ref,
      seenWorking: !!seenWorking,
      wrong: !!wrong,
      confirmedAt: dateStr,
    });
  }
  const merged = [...byRef.values()];
  const verdict = evaluateConfirmations(merged, known);
  return { ok: verdict.ok, errors: verdict.errors, merged };
}

/** Same shape again, for `notes.json` — an empty/whitespace-only text is skipped, not written as a blank note. */
export function mergeNotes(current, incoming, dateStr) {
  const byRef = new Map(current.map((n) => [n.ref, n]));
  for (const { ref, text } of incoming) {
    if (typeof text === 'string' && text.trim()) byRef.set(ref, { ref, text: text.trim(), updatedAt: dateStr });
  }
  const merged = [...byRef.values()];
  const verdict = evaluateNotes(merged);
  return { ok: verdict.ok, errors: verdict.errors, merged };
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<Buffer>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      // A page's worth of grades/confirmations/notes is a few KB at most;
      // anything past this is a bug, not a real sync payload.
      if (total > 2 * 1024 * 1024) {
        reject(new Error('sync payload too large (>2MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Guarded behind `startServer()` (called only when this file is run
// directly, same pattern `build-chart-room.mjs`'s own `main()` uses) so that
// IMPORTING `mergeGrades`/`mergeConfirmations`/`mergeNotes` for testing never
// has the side effect of opening a real listening socket.
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);

      if (url.pathname === '/' && req.method === 'GET') {
        // Regenerated on EVERY request, never cached — the whole point is
        // that what he sees always reflects the current grades.json/
        // confirmations.json/notes.json AND the current source tree, not a
        // stale snapshot.
        const { model } = await buildChartRoomModel();
        const html = renderHtml({ ...model, mode: 'server' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (url.pathname === '/api/sync' && req.method === 'POST') {
        let payload;
        try {
          payload = JSON.parse((await readBody(req)).toString('utf8'));
        } catch (e) {
          sendJson(res, 400, { ok: false, errors: [`malformed JSON body: ${e.message}`] });
          return;
        }
        const { known } = await buildChartRoomModel();
        const dateStr = today();

        const gradesResult = mergeGrades(readJsonFile(GRADES_FILE), payload.grades ?? [], known, dateStr);
        const confirmationsResult = mergeConfirmations(
          readJsonFile(CONFIRMATIONS_FILE),
          payload.confirmations ?? [],
          known,
          dateStr
        );
        const notesResult = mergeNotes(readJsonFile(NOTES_FILE), payload.notes ?? [], dateStr);

        const errors = [
          ...gradesResult.errors.map((e) => `grades: ${e}`),
          ...confirmationsResult.errors.map((e) => `confirmations: ${e}`),
          ...notesResult.errors.map((e) => `notes: ${e}`),
        ];
        if (errors.length) {
          sendJson(res, 422, { ok: false, errors });
          return;
        }

        writeFileSync(GRADES_FILE, JSON.stringify(gradesResult.merged, null, 2) + '\n');
        writeFileSync(CONFIRMATIONS_FILE, JSON.stringify(confirmationsResult.merged, null, 2) + '\n');
        writeFileSync(NOTES_FILE, JSON.stringify(notesResult.merged, null, 2) + '\n');

        // Regenerate the checked-in standalone page too, so `--check`/`npm
        // test` never reports it stale relative to a sync that just landed,
        // and so opening index.html directly (no server) also shows it.
        const { model: freshModel } = await buildChartRoomModel();
        writeFileSync(OUT_FILE, renderHtml(freshModel));

        const receipt = {
          grades: (payload.grades ?? []).length,
          confirmations: (payload.confirmations ?? []).length,
          notes: (payload.notes ?? []).length,
        };
        console.log(
          `sync: ${receipt.grades} grade(s), ${receipt.confirmations} confirmation(s), ${receipt.notes} note(s)`
        );
        sendJson(res, 200, { ok: true, receipt });
        return;
      }

      sendJson(res, 404, { ok: false, errors: ['not found'] });
    } catch (err) {
      sendJson(res, 500, { ok: false, errors: [err.message] });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`Chart Room live server: http://127.0.0.1:${port}/`);
    console.log('  Edit grades/confirmations/notes there, hit Sync, then tell Claude you synced.');
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) startServer();
