// Node tests for the pure parts of tools/foundry-cdp/cdp.mjs (mmp-f0k.1).
// Run by tools/run-tests.mjs (in-process `run(t)` suite).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolvePort, wrapScript, withPageEntryCall, chromeArgs, parseReport } from './cdp.mjs';

const LAB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'lab');

const throwsMatching = (fn, re) => {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test(String(e?.message ?? e));
  }
};

export function run(t) {
  const { ok } = t;

  const a = parseArgs(['eval', '--name', 'gm', '--headless', '--code', 'game.user.name']);
  ok('parseArgs: mode', a.mode === 'eval');
  ok('parseArgs: value option', a.opts.name === 'gm' && a.opts.code === 'game.user.name');
  ok('parseArgs: bare flag is true', a.opts.headless === true);
  ok('parseArgs: no mode means help', parseArgs([]).mode === 'help');

  ok(
    'resolvePort: --port wins over --name',
    resolvePort({ port: '9400', name: 'gm' }, { gm: { port: 9370 } }) === 9400
  );
  ok('resolvePort: named client', resolvePort({ name: 'p1' }, { p1: { port: 9371 } }) === 9371);
  ok(
    'resolvePort: unknown client is a readable error',
    throwsMatching(() => resolvePort({ name: 'nope' }, { gm: { port: 1 } }), /no client named "nope"/)
  );
  ok(
    'resolvePort: neither given',
    throwsMatching(() => resolvePort({}, {}), /--name <client> or --port/)
  );
  ok(
    'resolvePort: bad port',
    throwsMatching(() => resolvePort({ port: 'abc' }, {}), /positive integer/)
  );

  ok('wrapScript: bare expression is returned', wrapScript('1 + 2') === 'async (args) => { return (1 + 2); }');
  ok(
    'wrapScript: a body with return stays a body',
    /^async \(args\) => \{ const x/.test(wrapScript('const x = 1;\nreturn x;'))
  );
  ok('wrapScript: multi-statement without return is not wrapped in return', !/return \(/.test(wrapScript('a(); b();')));

  const h = chromeArgs({ port: 9370, profile: 'p', width: 800, height: 600, headless: true, url: 'http://x/join' });
  ok('chromeArgs: devtools port', h.includes('--remote-debugging-port=9370'));
  ok('chromeArgs: WebGPU on', h.includes('--enable-unsafe-webgpu'));
  ok('chromeArgs: headless uses new headless', h.includes('--headless=new'));
  ok('chromeArgs: url last', h.at(-1) === 'http://x/join');
  const w = chromeArgs({ port: 1, profile: 'p', width: 1, height: 1, headless: false, url: 'u' });
  ok('chromeArgs: windowed has no headless flag', !w.some((x) => x.startsWith('--headless')));

  ok(
    'wrapScript: --code IIFE with return inside is still returned',
    wrapScript('(()=>{const a=1; return a})()', { expression: true }).includes('return ((()=>')
  );
  ok(
    'wrapScript: expression flag wraps a semicolon one-liner',
    wrapScript('a(); b()', { expression: true }).includes('return (')
  );
  ok('parseReport: JSON string', parseReport('{"settled":true}')?.settled === true);
  ok('parseReport: object passes through', parseReport({ settled: false })?.settled === false);
  ok('parseReport: value wrapper', parseReport({ value: '{"a":1}' })?.a === 1);
  ok('parseReport: junk is null', parseReport('not json') === null && parseReport(null) === null);

  // ── LINT-SAFE PAGE SCRIPTS: one top-level `async function name(args)`, called for the caller ─────────────────
  const page = '// note\nasync function fooPage(args) {\n  return args.x * 2;\n}\n';
  ok(
    'withPageEntryCall: a page function gets its call appended',
    withPageEntryCall(page).endsWith('\nreturn await fooPage(args);\n')
  );
  ok(
    'withPageEntryCall: a classic body with its own top-level return is left alone',
    withPageEntryCall('const x = 1;\nreturn x;') === 'const x = 1;\nreturn x;'
  );
  const driven = `${page}return await fooPage(args);\n`;
  ok('withPageEntryCall: a driver that appended the call already is left alone', withPageEntryCall(driven) === driven);
  ok(
    'withPageEntryCall: an inner (indented) function or another signature is not an entry',
    withPageEntryCall('const f = 1;\n  async function inner(args) {}\n') ===
      'const f = 1;\n  async function inner(args) {}\n' &&
      withPageEntryCall('async function buildLab(manifest) {}\n') === 'async function buildLab(manifest) {}\n'
  );

  // Every lab page script compiles the way `eval --file` runs it (a syntax check of the real files, no page needed).
  const scripts = fs.readdirSync(LAB).filter((f) => f.endsWith('.js') && f !== 'build-in-foundry.js');
  const broken = [];
  for (const f of scripts) {
    const body = fs.readFileSync(path.join(LAB, f), 'utf8');
    try {
      new Function(`return (${wrapScript(withPageEntryCall(body))});`)();
    } catch (e) {
      broken.push(`${f}: ${e.message}`);
    }
  }
  ok(
    `every tools/lab page script compiles as \`cdp.mjs eval --file\` runs it (${scripts.length} scripts${broken.length ? `; broken: ${broken.join(' | ')}` : ''})`,
    scripts.length > 0 && broken.length === 0
  );
  const uncalled = scripts.filter((f) => {
    const body = fs.readFileSync(path.join(LAB, f), 'utf8');
    return !/^return\b/m.test(withPageEntryCall(body));
  });
  ok(
    `...and every one returns its result: a top-level return or a page function cdp calls (${uncalled.length ? `no result: ${uncalled.join(', ')}` : 'all'})`,
    uncalled.length === 0
  );
}
