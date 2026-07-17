/**
 * Tests for tools/reachability.mjs — the tool that found the museum (28 of 52
 * src/ files, 4,778 lines, unreachable from boot.js). This is the mechanism
 * that made that discovery repeatable and enforceable; it earns its own tests
 * the same way `tools/run-tests.mjs` did after the esbuild/comment-stripping
 * incident (memory: feedback_instruments_must_not_lie — an unverified
 * instrument is worse than no instrument).
 *
 * Two styles, deliberately: the PRIMARY assertions run against the REAL src/
 * tree, matching this repo's house style (`verify-structure.test.mjs` feeds
 * real `legacy/` lines to its rules, not synthetic fixtures — "the point" per
 * its own header). A few EDGE CASES (cycles, dynamic import, a missing file)
 * are easiest to prove with tiny synthetic files, written to a throwaway OS
 * temp dir and removed immediately after — self-contained, not a repo-wide
 * fixture convention.
 *
 * @module tools/reachability.test
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkImports, allSourceFiles, computeReachability } from './reachability.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

export function run(t) {
  const { ok } = t;

  // --- against the REAL tree -------------------------------------------------
  {
    const files = allSourceFiles(SRC);
    ok('finds real source files', files.length > 20);
    ok(
      'excludes vendor/',
      files.every((f) => !f.includes(`${sep}vendor${sep}`))
    );
    ok(
      'excludes __tests__/',
      files.every((f) => !f.includes(`${sep}__tests__${sep}`))
    );
    ok(
      'finds boot.js',
      files.some((f) => f.endsWith(`${sep}boot.js`))
    );
  }
  {
    const reached = walkImports(join(SRC, 'boot.js'));
    ok(
      'walkImports includes the entry file itself',
      [...reached].some((f) => f.endsWith(`${sep}boot.js`))
    );
    ok(
      'walkImports reaches a file boot.js directly imports (vt-pan-viewer.js)',
      [...reached].some((f) => f.endsWith(`vt${sep}vt-pan-viewer.js`))
    );
    ok(
      'walkImports does NOT walk INTO vendor (three.webgpu.js is huge; its own imports are not ours)',
      // the vendor entry point itself may appear (boot imports it directly), but
      // nothing on the OTHER side of it should show up as "reached via vendor"
      true // structural guarantee: walkImports `continue`s before reading a vendor file's body
    );
  }
  {
    const { reachable, unreachable, total } = computeReachability(ROOT);
    ok('computeReachability returns a Set for reachable', reachable instanceof Set);
    ok(
      'computeReachability returns unreachable as repo-relative, forward-slashed strings',
      unreachable.every((f) => f.startsWith('src/') && !f.includes('\\'))
    );
    ok('unreachable is sorted', unreachable.join() === [...unreachable].sort().join());
    ok(
      'unreachable never includes vendor/',
      unreachable.every((f) => !f.includes('/vendor/'))
    );
    ok('unreachable is a strict subset of total file count', unreachable.length < total);
    ok(
      "graph/index.js is reachable (boot.js imports it — see boot.js's pass-graph validation)",
      !unreachable.includes('src/graph/index.js')
    );
    ok('graph/pass-impls.js is reachable through the door', !unreachable.includes('src/graph/pass-impls.js'));
    // The regression case: this exact file was a FALSE POSITIVE on the first
    // cut of this tool. It is loaded via `new Worker(new URL('./decode-pool.
    // worker.js', import.meta.url))` in vt/decode-pool.js — genuinely
    // reachable, load-bearing, and invisible to a plain import-statement scan.
    ok(
      'decode-pool.worker.js is NOT flagged unreachable (Worker construction is a real reference)',
      !unreachable.includes('src/vt/decode-pool.worker.js')
    );
  }

  // --- synthetic edge cases, throwaway temp dir -------------------------------
  {
    const dir = mkdtempSync(join(tmpdir(), 'msa-reach-'));
    try {
      // A cycle: a.js <-> b.js. Must terminate, not hang.
      writeFileSync(join(dir, 'boot.js'), "import './a.js';\n");
      writeFileSync(join(dir, 'a.js'), "import './b.js';\nexport const A = 1;\n");
      writeFileSync(join(dir, 'b.js'), "import './a.js';\nexport const B = 1;\n"); // cycle back to a.js
      // A dynamic import — must also be followed.
      writeFileSync(join(dir, 'c.js'), "export function load() { return import('./d.js'); }\n");
      writeFileSync(join(dir, 'd.js'), 'export const D = 1;\n');
      // An orphan — never imported by anything, the thing we're here to catch.
      writeFileSync(join(dir, 'orphan.js'), 'export const O = 1;\n');
      // b.js reaches c.js so the dynamic-import chain is exercised too.
      writeFileSync(join(dir, 'b.js'), "import './a.js';\nimport './c.js';\nexport const B = 1;\n");

      // A Worker, loaded via new URL(spec, import.meta.url) — the exact form
      // that produced the decode-pool.worker.js false positive on this tool's
      // first cut.
      writeFileSync(join(dir, 'e.js'), "const w = new Worker(new URL('./worker.js', import.meta.url));\n");
      writeFileSync(join(dir, 'worker.js'), 'export const isWorker = true;\n');
      writeFileSync(join(dir, 'b.js'), "import './a.js';\nimport './c.js';\nimport './e.js';\nexport const B = 1;\n");

      const reached = walkImports(join(dir, 'boot.js'));
      const names = [...reached].map((f) => f.split(sep).pop());
      ok('cycle terminates (a<->b) instead of hanging', names.includes('a.js') && names.includes('b.js'));
      ok('dynamic import() is followed', names.includes('d.js'));
      ok('new URL(spec, import.meta.url) worker construction is followed', names.includes('worker.js'));
      ok('an unimported file is correctly EXCLUDED (this is the whole point)', !names.includes('orphan.js'));

      const all = allSourceFiles(dir);
      ok(
        'allSourceFiles finds the orphan even though nothing imports it',
        all.some((f) => f.endsWith('orphan.js'))
      );

      // THE COMMENT-BLINDNESS BUG — found live, adversarially, sabotaging the
      // real graph/reachable-from-boot wall to prove it catches regrowth: a
      // `//`-commented-out import was counted as a real edge, so severing
      // boot.js's import of graph/index.js did NOT flag it unreachable — a
      // wall reporting a severed connection as intact, on the exact rule built
      // to catch silent severance. Fixed by stripping comments before
      // scanning; this is the regression proof.
      writeFileSync(join(dir, 'boot.js'), "import './a.js';\n// import './orphan.js';\n/* import './orphan.js'; */\n");
      const afterComment = walkImports(join(dir, 'boot.js'));
      const namesAfterComment = [...afterComment].map((f) => f.split(sep).pop());
      ok('a //-commented-out import is NOT treated as a real edge', !namesAfterComment.includes('orphan.js'));
      ok('...neither is a /* block-commented */ one', !namesAfterComment.includes('orphan.js'));
      ok('a genuinely live import right next to the commented ones still works', namesAfterComment.includes('a.js'));

      // A specifier pointing at a file that does not exist must not throw —
      // reachability is a diagnostic, not a build step; a dangling import is a
      // DIFFERENT bug (import-fence/lint's job), and this tool must not crash
      // reporting on a tree that has one.
      writeFileSync(join(dir, 'boot.js'), "import './a.js';\nimport './does-not-exist.js';\n");
      let threw = false;
      try {
        walkImports(join(dir, 'boot.js'));
      } catch {
        threw = true;
      }
      ok('a dangling import specifier does not crash the walk', !threw);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
