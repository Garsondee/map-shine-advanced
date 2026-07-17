/**
 * REACHABILITY FROM boot.js — the measurement that found the museum.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * 2026-07-17: went looking for where `graph/passes.js`'s `geometry.world` pass
 * actually lives. It didn't — `src/graph/` (2,225 lines, 195 assertions) had
 * ZERO real importers. Measured across all of `src/`: **28 of 52 files, 4,778
 * lines, were unreachable from `boot.js`** — every wall built, every test
 * green, and none of it load-bearing.
 *
 * That is `EffectComposer`'s signature reforming inside the thing built to
 * prevent it (memory: `v2-postmortem-the-failure-modes` — 5 importers vs the
 * god-object's 92; memory: `feedback_walls_must_be_passable_and_wired`). A
 * zone can have a door, pass every test, and still be a museum if nothing ever
 * walks through the door. Reachability is the check that catches that — the
 * one metric `npm run verify`'s 18 structure walls did not measure, because
 * every one of them asks "is this line ALLOWED here", never "does anything
 * ACTUALLY GET HERE".
 *
 * This module is pure and Node-only: it walks the same static `import`/
 * `import()` graph a bundler would, rooted at `src/boot.js`, and reports what
 * it never reaches. `tools/verify-structure.mjs`'s `graph/reachable-from-boot`
 * rule ratchets the count (shrink-only, same mechanism as the other 7
 * ratchets) — it does not demand zero, because some of the gap is honest
 * ('seam'/'future' work not wired yet); it demands the gap never grows without
 * someone noticing.
 *
 * @module tools/reachability
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * Static import specifiers only — dynamic `require()`/computed paths are out
 * of scope (there are none in src/ today; verify-structure.mjs's own
 * quarantine rule already forbids the CommonJS form). Four forms, in one
 * regex so a single scan catches all of them:
 *   1. `import { X } from '../y.js'`               — group 1
 *   2. `import('../y.js')`                          — group 2 (dynamic)
 *   3. `import '../y.js'`                           — group 3 (bare, side-effect-only)
 *   4. `new URL('../y.worker.js', import.meta.url)` — group 4 (Worker construction)
 * Form 3 was MISSING on the first cut — caught by its own test (a synthetic
 * cycle fixture using the bare form silently reached nothing past boot.js).
 * Form 4 was found the same way, live: `vt/decode-pool.js` loads its worker
 * via `new Worker(new URL('./decode-pool.worker.js', import.meta.url))` — a
 * genuine, load-bearing reference no `import` statement can express, and the
 * FIRST run of this tool reported the worker as dead code. A worker can only
 * be reached this way (a bare specifier string would resolve against the
 * WRONG base at runtime), so this pattern is specifically Worker/lazy-asset
 * construction, not a general escape hatch.
 * Not a tokenizer: a `//`-commented-out reference would false-positive here,
 * same tradeoff verify-structure.mjs makes elsewhere in this repo — errs
 * toward over-counting reachable, never under.
 */
const IMPORT_RE =
  /(?:from\s+['"](\.[^'"]+)['"])|(?:import\(\s*['"](\.[^'"]+)['"])|(?:import\s+['"](\.[^'"]+)['"])|(?:new\s+URL\s*\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\))/g;

/**
 * Strip comments before scanning for imports. FOUND LIVE, adversarially,
 * 2026-07-17: the sabotage test for this exact tool's own ratchet wall
 * commented out `import ... from './graph/index.js'` in boot.js to prove the
 * wall catches real regrowth — and the wall stayed silent, because the regex
 * matched the specifier INSIDE the `//`-commented line just as happily as a
 * live one. A reachability tool that treats a commented-out import as a real
 * edge is worse than no tool: it reports a severed connection as intact,
 * silently, on the exact rule built to catch silent severance.
 *
 * Not a full tokenizer — `//` inside a string literal (e.g. a URL) would
 * over-strip. Same tradeoff `verify-structure.mjs`'s own scanner documents
 * and accepts: false POSITIVE (a real import wrongly ignored, undercounting
 * reachability) is the safe direction for THIS tool, opposite of a structure
 * wall — here, undercounting reachability only makes the ratchet's debt list
 * slightly too long, never silently hides a severed edge the way the
 * uncaught bug did.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Follow every relative import reachable from `entryFile`, depth-first.
 * Vendored code is a dead end on purpose — its own imports are not ours to walk.
 *
 * @param {string} entryFile - absolute path to the root module (src/boot.js)
 * @returns {Set<string>} absolute paths of every file reached, INCLUDING entryFile
 */
export function walkImports(entryFile) {
  const seen = new Set();
  const stack = [resolve(entryFile)];

  while (stack.length) {
    const abs = stack.pop();
    if (seen.has(abs) || !existsSync(abs) || statSync(abs).isDirectory()) continue;
    seen.add(abs);
    if (abs.includes(`${sep}vendor${sep}`)) continue;

    const src = stripComments(readFileSync(abs, 'utf8'));
    let m;
    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(src))) {
      const spec = m[1] || m[2] || m[3] || m[4];
      stack.push(resolve(join(dirname(abs), spec)));
    }
  }
  return seen;
}

/** @returns {string[]} absolute paths of every .js file under `dir`, excluding vendor/ and __tests__/ */
export function allSourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (full.includes(`${sep}vendor${sep}`) || full.includes(`${sep}__tests__${sep}`)) continue;
    if (statSync(full).isDirectory()) allSourceFiles(full, out);
    else if (/\.js$/.test(full)) out.push(full);
  }
  return out;
}

/**
 * @param {string} rootDir - absolute path to the repo root
 * @returns {{reachable: Set<string>, unreachable: string[], total: number}}
 *   `unreachable` is repo-relative, forward-slashed, sorted.
 */
export function computeReachability(rootDir) {
  const src = join(rootDir, 'src');
  const entry = join(src, 'boot.js');
  const reachable = walkImports(entry);
  const all = allSourceFiles(src);
  const unreachable = all
    .filter((f) => !reachable.has(resolve(f)))
    .map((f) => relative(rootDir, f).split(sep).join('/'))
    .sort();
  return { reachable, unreachable, total: all.length };
}
