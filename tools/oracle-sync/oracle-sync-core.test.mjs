/**
 * Tests for tools/oracle-sync/oracle-sync-core.mjs — the rules that keep the
 * server copy of the module loadable (what is synced, what is refused, what
 * order things go in, what counts as "verified").
 *
 * @module tools/oracle-sync/oracle-sync-core.test
 */

import {
  assertSafeRelPath,
  dependenciesOf,
  diffManifests,
  extractRelativeImports,
  formatBytes,
  orderForUpload,
  parseSha256Lines,
  preflightText,
  resolveRelativeImport,
  shouldSync,
  stripJsComments,
} from './oracle-sync-core.mjs';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

export function run(t) {
  const { ok } = t;

  // ── shouldSync: only the installed module, never repo tooling ────────────
  ok('shouldSync: source under src/ syncs', shouldSync('src/boot.js'));
  ok('shouldSync: module.json syncs', shouldSync('module.json'));
  ok('shouldSync: backslash paths are normalised', shouldSync('src\\effects\\clouds\\clouds.js'));
  ok(
    'shouldSync: unit tests under src/ still sync (mirrors the existing server copy)',
    shouldSync('src/core/__tests__/run-tests.mjs')
  );
  ok('shouldSync: .git never syncs', !shouldSync('.git/config'));
  ok('shouldSync: node_modules never syncs', !shouldSync('node_modules/three/package.json'));
  ok('shouldSync: tools/ never syncs (this very tool stays local)', !shouldSync('tools/oracle-sync/oracle-sync.mjs'));
  ok(
    'shouldSync: the connection config is not under a sync root, so it cannot leak',
    !shouldSync('tools/oracle-sync/oracle-sync.config.json')
  );
  ok('shouldSync: the gitignored torture fixture stays local', !shouldSync('assets/torture/world.json'));
  ok(
    'shouldSync: the gitignored webgpu build intermediate stays local',
    !shouldSync('src/vendor/three/.webgpu-entry.js')
  );
  ok(
    'shouldSync: editor swap / temp / Thumbs.db junk is skipped',
    ['src/a.js~', 'src/a.js.swp', 'src/a.tmp', 'assets/Thumbs.db', 'src/.#a.js'].every((p) => !shouldSync(p))
  );
  ok(
    'shouldSync: parent-directory escapes are refused',
    !shouldSync('src/../.git/config') && !shouldSync('../outside.js')
  );
  ok('shouldSync: empty / absolute paths are refused', !shouldSync('') && !shouldSync('/etc/passwd'));

  // ── assertSafeRelPath: nothing that can escape a single-quoted remote path ──
  ok(
    'assertSafeRelPath: ordinary path passes through',
    assertSafeRelPath('src/effects/lighting/point-light-pool.js') === 'src/effects/lighting/point-light-pool.js'
  );
  ok(
    'assertSafeRelPath: spaces are fine (they are quoted)',
    assertSafeRelPath('assets/my map/a b.webp') === 'assets/my map/a b.webp'
  );
  ok(
    'assertSafeRelPath: refuses a single quote',
    throws(() => assertSafeRelPath("src/a'b.js"))
  );
  ok(
    'assertSafeRelPath: refuses $ and backtick',
    throws(() => assertSafeRelPath('src/$(rm -rf).js')) && throws(() => assertSafeRelPath('src/`x`.js'))
  );
  ok(
    'assertSafeRelPath: refuses .. and leading / and leading -',
    throws(() => assertSafeRelPath('src/../x')) &&
      throws(() => assertSafeRelPath('/x')) &&
      throws(() => assertSafeRelPath('-rf'))
  );
  ok(
    'assertSafeRelPath: refuses a control character',
    throws(() => assertSafeRelPath('src/a\nb.js'))
  );

  // ── diffManifests ───────────────────────────────────────────────────────
  {
    const local = new Map([
      ['src/a.js', HASH_A],
      ['src/b.js', HASH_A],
      ['src/new.js', HASH_A],
    ]);
    const remote = new Map([
      ['src/a.js', HASH_A],
      ['src/b.js', HASH_B],
      ['src/gone.js', HASH_A],
    ]);
    const d = diffManifests(local, remote);
    ok('diffManifests: identical file is "same"', d.same.length === 1 && d.same[0] === 'src/a.js');
    ok('diffManifests: differing hash is "changed"', d.changed.length === 1 && d.changed[0] === 'src/b.js');
    ok('diffManifests: file only local is "added"', d.added.length === 1 && d.added[0] === 'src/new.js');
    ok(
      'diffManifests: file only remote is reported, never scheduled for deletion',
      d.onlyRemote.length === 1 && d.onlyRemote[0] === 'src/gone.js'
    );
  }

  // ── parseSha256Lines ────────────────────────────────────────────────────
  {
    const m = parseSha256Lines(`${HASH_A}  ./src/a.js\r\n${HASH_B} *src/b b.js\nnot a hash line\n`);
    ok('parseSha256Lines: strips the ./ prefix', m.get('src/a.js') === HASH_A);
    ok('parseSha256Lines: binary-mode marker and spaces in names are handled', m.get('src/b b.js') === HASH_B);
    ok('parseSha256Lines: junk lines are ignored', m.size === 2);
  }

  // ── orderForUpload: module.json last ────────────────────────────────────
  ok(
    'orderForUpload: module.json goes LAST so the manifest never names a file that has not arrived',
    orderForUpload(['module.json', 'src/z.js', 'src/a.js']).at(-1) === 'module.json'
  );
  ok(
    'orderForUpload: everything else is sorted',
    orderForUpload(['src/z.js', 'src/a.js']).join() === 'src/a.js,src/z.js'
  );

  // ── import extraction (the "pushed a file that imports a missing file" guard) ──
  {
    const src = [
      "import a from './a.js';",
      "import { b } from '../b.js';",
      "export { c } from './sub/c.js';",
      "export * from './d.js';",
      "import './side-effect.js';",
      "const lazy = await import('./lazy.js');",
      "import three from 'three';",
      "import url from 'https://cdn.example.com/x.js';",
    ].join('\n');
    const found = extractRelativeImports(src);
    ok(
      'extractRelativeImports: finds static, re-export, side-effect and dynamic relative imports',
      ['./a.js', '../b.js', './sub/c.js', './d.js', './side-effect.js', './lazy.js'].every((s) => found.includes(s))
    );
    ok('extractRelativeImports: ignores bare and absolute specifiers', !found.includes('three') && found.length === 6);
    ok(
      'extractRelativeImports: an import quoted in a comment is not an import',
      extractRelativeImports("/* import x from './fake.js' */\n// import y from './fake2.js'\nexport const z = 1;")
        .length === 0
    );
    ok(
      'stripJsComments: keeps a URL in a string (http://) intact',
      stripJsComments("const u = 'http://x.y/z'; // note").includes("'http://x.y/z'")
    );
    ok(
      'resolveRelativeImport: ./ and ../ resolve against the importing file',
      resolveRelativeImport('src/effects/lighting/pool.js', '../clouds/c.js') === 'src/effects/clouds/c.js' &&
        resolveRelativeImport('src/boot.js', './core/x.js') === 'src/core/x.js'
    );
  }

  // ── preflightText ───────────────────────────────────────────────────────
  {
    const present = new Set(['src/a.js', 'styles/module.css', 'languages/en.json', 'src/boot.js']);
    const exists = (r) => present.has(r);
    ok(
      'preflightText: a JS file whose imports all exist passes',
      preflightText('src/boot.js', "import './a.js';", exists).length === 0
    );
    const missing = preflightText('src/boot.js', "import './gone.js';", exists);
    ok(
      'preflightText: a missing import is refused and names the target',
      missing.length === 1 && missing[0].includes('src/gone.js')
    );
    ok(
      'preflightText: invalid JSON is refused',
      preflightText('data/x.json', '{ nope', exists)[0].includes('not valid JSON')
    );
    const manifest = JSON.stringify({
      esmodules: ['src/boot.js'],
      styles: ['styles/module.css', 'styles/missing.css'],
      languages: [{ path: 'languages/en.json' }],
    });
    const mp = preflightText('module.json', manifest, exists);
    ok(
      'preflightText: module.json naming a file that does not exist is refused (the Blank Inheritance outage)',
      mp.length === 1 && mp[0].includes('styles/missing.css')
    );
    ok(
      'dependenciesOf: module.json lists esmodules, styles and language files',
      dependenciesOf('module.json', manifest).length === 4
    );
    ok('dependenciesOf: a CSS/asset file has no dependencies', dependenciesOf('styles/module.css', 'a{}').length === 0);
  }

  ok('formatBytes: human readable', formatBytes(512) === '512 B' && formatBytes(4 * 1024 * 1024) === '4.0 MB');
}
