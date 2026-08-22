/**
 * THE SURVEY — the codebase as blocks, derived from the code itself.
 *
 * The Chart Room's other half answers "how far through are we". This answers
 * "what IS there, how big is it, what does it do, and what looks wrong" — the
 * map you look at before deciding where to work.
 *
 * ## Same law as everything else here: derive, never model
 *
 * `docs/planning/Health.md`: *"health may not contain a model of the system. It
 * may only read the declarations."* So there is no hand-written list of files,
 * no hand-written descriptions, and no hand-written "this one is slow":
 *
 * - **The block list** is a directory walk. A new file appears by existing.
 * - **Block size** is its real line count.
 * - **The plain-English label** is the file's OWN module header, first sentence.
 *   Where that reads badly the fix is to improve the header — which helps
 *   every reader of that file, not just this page. That is Health.md's rule
 *   applied literally: a gap in the description is a gap in the DECLARATION.
 * - **Warning lights** come from signals the project already computes about
 *   itself (`diag/perf-zones.js`'s own `EFFECT_ZONING.coverage`,
 *   `tools/uniform-budgets.json`, the size ratchet's own history) — never from
 *   a hunch typed into a config file.
 *
 * A signal here is deliberately "worth a look", not "this is slow". Only a real
 * measurement (`tools/trace-analyze.mjs`, the perf report) can say slow, and
 * `feedback_instruments_must_not_lie` is why this module never pretends
 * otherwise: `kind: 'unmeasured'` says we cannot see it, which is a different
 * and often more useful statement than "it is expensive".
 *
 * @module tools/chart-room/survey
 */

// Only the directory walk touches disk here; every other function takes its
// text as an argument so the suite can drive it without a filesystem.
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Files this survey deliberately ignores, and why each one is not an omission:
 * `__tests__` are the proof of the code rather than the code, `vendor/` is
 * third-party (79k lines of bundled THREE that would dwarf every real block and
 * teach nothing), and non-`.js` needs no explaining.
 */
const SKIP_DIRS = Object.freeze(['__tests__', 'vendor', 'node_modules']);

/** A file at or above this many lines is flagged as hard to hold in one head. */
// Not an invented number: `keyhole-god-object-forming` names vt-pan-viewer.js as
// the project's own worst case, and `docs/planning/Skeleton.md`'s size doctrine
// is what the (since-removed) file-size ratchet enforced. 800 is the point where
// this repo's own files stop being one idea and start being several.
export const BIG_FILE_LINES = 800;

/** And at this size it is a named architectural problem, not just a large file. */
export const GOD_OBJECT_LINES = 4000;

/**
 * Walk a directory tree and return every `.js` file's repo-relative path.
 * Sorted, so output is deterministic and a diff of two runs is readable.
 *
 * @param {string} root - absolute repo root.
 * @param {string} dir - absolute directory to walk.
 * @returns {string[]} repo-relative paths, POSIX separators.
 */
export function walkSources(root, dir) {
  const out = [];
  const visit = (abs) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.includes(e.name)) continue;
        visit(join(abs, e.name));
      } else if (e.isFile() && e.name.endsWith('.js')) {
        out.push(relative(root, join(abs, e.name)).split(sep).join('/'));
      }
    }
  };
  visit(dir);
  return out.sort();
}

/**
 * Pull a plain-English description out of a module's own JSDoc header.
 *
 * Every file in this repo opens with a `/** … *\/` block, and its first
 * sentences are usually already written for a human ("WATER'S SURFACE — the TSL
 * material tier 0 draws"). This strips the comment furniture, drops JSDoc tags
 * and code-fence noise, and returns the first real prose.
 *
 * Returns `null` rather than a placeholder when there is nothing usable — the
 * page shows that honestly instead of inventing a description, and a blank is a
 * visible prompt to go write one.
 *
 * @param {string} text - the file's full source.
 * @param {number} [maxChars]
 * @returns {string|null}
 */
export function describeModule(text, maxChars = 260) {
  const m = /^\s*\/\*\*([\s\S]*?)\*\//.exec(String(text));
  if (!m) return null;
  const lines = m[1]
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trimEnd())
    // `@module`, `@param`, `@fileoverview` etc. are machine furniture. Keep the
    // text AFTER `@fileoverview` though — several older files put their real
    // one-line summary there rather than on a bare first line.
    .map((l) => l.replace(/^@fileoverview\s*/, ''))
    .filter((l) => !/^@\w+/.test(l))
    .filter((l) => !/^[=–—-]{4,}$/.test(l.trim()));
  const prose = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!prose) return null;
  if (prose.length <= maxChars) return prose;
  // Prefer cutting at a sentence end so the label never stops mid-clause.
  const cut = prose.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(' — '));
  return (lastStop > maxChars * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim() + '…';
}

/**
 * The zone a path belongs to — `src/effects/water/x.js` → `effects/water`,
 * `src/vt/y.js` → `vt`, `src/boot.js` → `(root)`.
 *
 * Two levels deep under `effects/` only, because that is where this project's
 * real subsystem boundaries live (`effects/water`, `effects/lighting`); one
 * level everywhere else, matching the zone names `tools/verify-structure.mjs`'s
 * own `zones/one-door` rule already polices.
 *
 * @param {string} relPath
 */
export function zoneOf(relPath) {
  const parts = String(relPath).split('/');
  if (parts[0] !== 'src') return parts.slice(0, -1).join('/') || '(root)';
  if (parts.length <= 2) return '(root)';
  if (parts[1] === 'effects' && parts.length > 3) return `effects/${parts[2]}`;
  return parts[1];
}

/**
 * Derived, investigable warning signals for one file.
 *
 * Each carries a `kind` (what sort of concern), a `why` in plain English, and
 * `severity` — `watch` (worth a look) or `warn` (a named problem). Nothing here
 * claims a measurement it does not have.
 *
 * @param {{path: string, lines: number, zone: string}} file
 * @param {{uniformBudgets?: Record<string, number>, uniformCap?: number}} ctx
 */
export function signalsForFile(file, ctx = {}) {
  const out = [];
  const { uniformBudgets = {}, uniformCap = 40 } = ctx;

  if (file.lines >= GOD_OBJECT_LINES) {
    out.push({
      kind: 'god-object',
      severity: 'warn',
      why: `${file.lines.toLocaleString()} lines — past the point anyone can hold it in one head, and the project already names this shape as its own worst architectural habit.`,
    });
  } else if (file.lines >= BIG_FILE_LINES) {
    out.push({
      kind: 'large-file',
      severity: 'watch',
      why: `${file.lines.toLocaleString()} lines — large enough that it probably holds more than one idea.`,
    });
  }

  // Registered uniform debt: the file crossed the per-file uniform cap and the
  // overrun was WRITTEN DOWN rather than fixed. That is a sanctioned decision,
  // not a failure — so it is a 'watch', and the number says how far over.
  const budget = uniformBudgets[file.path];
  if (Number.isFinite(budget) && budget > uniformCap) {
    out.push({
      kind: 'uniform-debt',
      severity: 'watch',
      why: `${budget} uniform calls against a soft cap of ${uniformCap} — registered debt, so a known and accepted cost rather than a surprise.`,
    });
  }

  return out;
}

/**
 * Signals that are true of a WHOLE ZONE rather than any one file in it.
 *
 * Perf-zone coverage is the case that forced this split: it is a fact about an
 * effect, and attaching it to each of `effects/water`'s 18 files reported the
 * same single concern eighteen times — an instrument inflating its own findings,
 * which is the exact dishonesty `feedback_instruments_must_not_lie` names.
 *
 * `EFFECT_ZONING`'s own comments record that `window` and `fire` once owned real
 * GPU zones with NO entry at all and silently read as fully covered; its header
 * calls that *"a live instance of feedback_instruments_must_not_lie, not a
 * hypothetical"*. So a missing or partial entry is exactly the case where "we
 * cannot see this" has to be said out loud rather than defaulted away.
 *
 * @param {{name: string, effectId: string|null}} zone
 * @param {{effectZoning?: Record<string, object>}} ctx
 */
export function signalsForZone(zone, ctx = {}) {
  const { effectZoning = {} } = ctx;
  if (!zone.effectId) return [];
  const z = effectZoning[zone.effectId];
  if (!z) {
    return [
      {
        kind: 'unmeasured',
        severity: 'warn',
        why: `No perf-zone entry at all for '${zone.effectId}' — its cost is invisible to the perf report, so nobody can say whether it is expensive.`,
      },
    ];
  }
  if (z.coverage === 'none') {
    return [
      {
        kind: 'unmeasured',
        severity: 'warn',
        why: `Perf zoning declares coverage 'none' — this effect's cost is not separately measurable. ${z.why ?? ''}`.trim(),
      },
    ];
  }
  if (z.coverage === 'partial') {
    return [
      {
        kind: 'partly-measured',
        severity: 'watch',
        why: `Perf zoning is partial — some cost is measured, some is not. ${z.why ?? ''}`.trim(),
      },
    ];
  }
  return [];
}

/**
 * Which zones ARE an effect, derived rather than listed: `effects/water` is the
 * `water` effect because a manifest with `id: 'water'` exists. `effects/lighting`
 * maps to nothing, correctly — no manifest claims that id, it is shared
 * machinery several effects use.
 *
 * Deriving this rather than hand-writing the pairs is the difference between a
 * map that follows a rename and one that silently stops matching.
 *
 * @param {string[]} zoneNames
 * @param {Array<{id: string}>} manifests
 * @returns {Record<string, string>}
 */
export function deriveZoneEffectIds(zoneNames, manifests) {
  const ids = new Set(manifests.map((m) => m.id));
  const out = {};
  for (const name of zoneNames) {
    const leaf = name.split('/').pop();
    if (name.startsWith('effects/') && ids.has(leaf)) out[name] = leaf;
  }
  return out;
}

/**
 * Build the whole survey: every source file as a block, grouped into zones.
 *
 * Pure over its inputs (the file list and a reader function) so the test can
 * drive it with synthetic files and never touch a real tree — the same
 * measure/evaluate split the rest of this tool follows.
 *
 * @param {object} a
 * @param {string[]} a.paths - repo-relative source paths.
 * @param {(p: string) => string} a.read - returns a file's full text.
 * @param {Record<string, number>} [a.uniformBudgets]
 * @param {number} [a.uniformCap]
 * @param {Record<string, object>} [a.effectZoning]
 * @param {Record<string, string>} [a.zoneEffectIds] - zone name → effect id, for zones that ARE an effect.
 * @param {Record<string, string>} [a.lastTouched] - repo-relative path → YYYY-MM-DD.
 */
export function buildSurvey({
  paths,
  read,
  uniformBudgets = {},
  uniformCap = 40,
  effectZoning = {},
  zoneEffectIds = {},
  lastTouched = {},
}) {
  const files = paths.map((path) => {
    const text = read(path);
    const lines = String(text).split('\n').length;
    const zone = zoneOf(path);
    const base = { path, lines, zone, summary: describeModule(text), lastTouched: lastTouched[path] ?? null };
    return { ...base, signals: signalsForFile(base, { uniformBudgets, uniformCap }) };
  });

  const byZone = new Map();
  for (const f of files) {
    if (!byZone.has(f.zone)) byZone.set(f.zone, []);
    byZone.get(f.zone).push(f);
  }

  const zones = [...byZone.entries()]
    .map(([name, zoneFiles]) => {
      const sorted = [...zoneFiles].sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
      const lines = sorted.reduce((a, f) => a + f.lines, 0);
      const effectId = zoneEffectIds[name] ?? null;
      const zoneSignals = signalsForZone({ name, effectId }, { effectZoning });
      const signals = [...zoneSignals, ...sorted.flatMap((f) => f.signals)];
      return {
        name,
        effectId,
        files: sorted,
        lines,
        fileCount: sorted.length,
        zoneSignals,
        warnCount: signals.filter((s) => s.severity === 'warn').length,
        watchCount: signals.filter((s) => s.severity === 'watch').length,
        // Newest commit anywhere in the zone — "when was this last worked on".
        lastTouched:
          sorted
            .map((f) => f.lastTouched)
            .filter(Boolean)
            .sort()
            .pop() ?? null,
      };
    })
    .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));

  const totalLines = files.reduce((a, f) => a + f.lines, 0);
  return {
    zones,
    totalLines,
    totalFiles: files.length,
    describedFiles: files.filter((f) => f.summary).length,
    warnCount: zones.reduce((a, z) => a + z.warnCount, 0),
    watchCount: zones.reduce((a, z) => a + z.watchCount, 0),
  };
}

/**
 * GAPS — declared intent with no code behind it yet, as blocks that can sit
 * beside the real ones. The author's own framing: *"show the gaps missing that
 * could be effects that we know we want but haven't got yet."*
 *
 * Every gap here is something the codebase ITSELF declares it wants: a pass
 * that is `seam`/`future`, or a `deferredRungs` entry on a real manifest. There
 * is no wishlist file feeding this — an idea nobody has declared anywhere is
 * not yet a gap, it is an idea (`docs/holy/Idea-Notebook.md` is its home).
 *
 * @param {Array<object>} passes - PASSES from src/graph/passes.js.
 * @param {Array<object>} manifests - the discovered effect manifests.
 */
export function findGaps(passes, manifests) {
  const gaps = [];
  for (const p of passes) {
    if (p.status === 'live') continue;
    gaps.push({
      kind: 'pass',
      id: p.id,
      label: p.id,
      status: p.status,
      weight: (p.absorbs ?? []).length,
      why:
        p.status === 'future'
          ? 'Declared in the pass graph, not wired into the frame at all yet.'
          : 'A wired seam: the door exists and throws, so the shape of the work is known.',
      detail: p.note ?? '',
      absorbs: p.absorbs ?? [],
    });
  }
  for (const m of manifests) {
    for (const d of m.deferredRungs ?? []) {
      gaps.push({
        kind: 'rung',
        id: `${m.id}:${d.name}`,
        label: `${m.title ?? m.id} · ${d.name}`,
        status: 'deferred',
        weight: 1,
        why: 'A rung this effect declares it wants, recorded and not built.',
        detail: d.note ?? '',
        absorbs: [],
      });
    }
  }
  return gaps.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
}
