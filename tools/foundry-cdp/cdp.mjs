#!/usr/bin/env node
/**
 * tools/foundry-cdp/cdp.mjs — drive any running Foundry client from a shell (mmp-f0k.1).
 *
 * WHY: investigating MSA used to mean clicking around a browser pane and reading
 * screenshots, one client at a time. Every question worth asking ("what does the
 * scene-settled report say", "what did the console print during the load", "show me
 * the canvas now") is a line of JS in the page. This tool runs that line from Bash,
 * against a NAMED client, so investigations are scriptable, repeatable and can run
 * against several clients (GM + players) side by side.
 *
 * A client is a Chrome started with a DevTools port, logged into a Foundry world.
 * Its name, port, URL and user live in tools/foundry-cdp/clients.json (git-ignored).
 * Chrome is spawned DETACHED, so `boot` returns and the browser keeps running.
 *
 *   node tools/foundry-cdp/cdp.mjs boot     --name gm --url http://localhost:30070 --port 9370
 *                                            [--user Gamemaster] [--password X] [--width 1600 --height 900]
 *                                            [--headless]  (new headless + WebGPU flags)
 *   node tools/foundry-cdp/cdp.mjs clients                     list clients, alive or not
 *   node tools/foundry-cdp/cdp.mjs eval     --name gm --code "game.scenes.viewed.name"
 *   node tools/foundry-cdp/cdp.mjs eval     --name gm --file script.js [--args '{"a":1}']
 *                                            (a file is the BODY of an async function; `args` is in scope;
 *                                             `--file -` reads it from stdin. A lint-safe page script, one
 *                                             top-level `async function name(args)`, is called for you:
 *                                             see `withPageEntryCall`)
 *   node tools/foundry-cdp/cdp.mjs settle   --name gm [--timeout 300]   wait for MSA's scene-settled report
 *   node tools/foundry-cdp/cdp.mjs report   --name gm --id scene-settled   run any MapShine.debug report/action
 *   node tools/foundry-cdp/cdp.mjs shot     --name gm --out shot.png [--full] [--clean]  (--clean hides Foundry UI)
 *   node tools/foundry-cdp/cdp.mjs console  --name gm --seconds 30 [--out log.txt]   stream console + page errors
 *   node tools/foundry-cdp/cdp.mjs reload   --name gm [--settle]
 *   node tools/foundry-cdp/cdp.mjs close    --name gm
 *
 * `--port N` works anywhere instead of `--name` (e.g. an existing rig's Chrome).
 * Output is JSON on stdout so other scripts can parse it; diagnostics go to stderr.
 *
 * It never touches the live Oracle world unless you point it there yourself.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', '..', 'package.json'));
const { chromium } = require('playwright');

const REGISTRY = path.join(HERE, 'clients.json');
const PROFILES = path.join(HERE, '.profiles');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
].filter(Boolean);

// ---------------------------------------------------------------- argument parsing (pure, exported for tests)

/** @param {string[]} argv @returns {{mode:string, opts:Record<string,string|boolean>}} */
export function parseArgs(argv) {
  const mode = argv[0] ?? 'help';
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return { mode, opts };
}

/**
 * Resolve which DevTools port a command targets: an explicit --port wins, then the
 * named client in the registry. Throws a readable error rather than guessing.
 * @param {Record<string, any>} opts @param {Record<string, any>} registry @returns {number}
 */
export function resolvePort(opts, registry) {
  if (opts.port !== undefined && opts.port !== true) {
    const p = Number(opts.port);
    if (!Number.isInteger(p) || p <= 0) throw new Error(`--port must be a positive integer, got ${opts.port}`);
    return p;
  }
  const name = typeof opts.name === 'string' ? opts.name : null;
  if (!name) throw new Error('say which client: --name <client> or --port <devtools port>');
  const entry = registry[name];
  if (!entry) throw new Error(`no client named "${name}" (known: ${Object.keys(registry).join(', ') || 'none'})`);
  return entry.port;
}

/**
 * Wrap a page-script body into an async function expression the page can run.
 * A bare expression (no `return`, single line, no `;`) is returned as its value,
 * so `--code "game.user.name"` just works.
 * @param {string} body @returns {string}
 */
export function wrapScript(body, { expression = false } = {}) {
  const trimmed = body.trim();
  // `--code` is ONE expression (an IIFE with `;` and `return` inside included) unless it starts
  // with `return`; a file/stdin body is a function body unless it is a bare one-liner.
  const startsWithReturn = /^return\b/.test(trimmed);
  const isExpression = expression
    ? !startsWithReturn
    : !/\breturn\b/.test(trimmed) && !trimmed.includes(';') && !trimmed.includes('\n');
  const inner = isExpression ? `return (${trimmed});` : trimmed;
  return `async (args) => { ${inner} }`;
}

/**
 * A LINT-SAFE PAGE SCRIPT (`tools/lab/*-page.js`, the weather lab's scripts) is one top-level
 * `async function <name>(args) { ... }`: `npm run lint` lints tools/, and a body ending in a top-level `return` is a
 * parse error there. Run as an `eval --file` body it would only define the function, so the call is appended here:
 * `return await <name>(args);`. A body with a top-level `return` of its own (a classic body, or a driver that
 * appended the call itself) is left alone, and so is any other file.
 * @param {string} body @returns {string}
 */
export function withPageEntryCall(body) {
  if (/^return\b/m.test(body)) return body;
  const m = /^async function ([A-Za-z_$][\w$]*)\s*\(\s*args\s*\)/m.exec(body);
  return m ? `${body}\nreturn await ${m[1]}(args);\n` : body;
}

/**
 * MapShine.debug.runReport returns report bodies as pretty-printed JSON STRINGS
 * (that is what the debug panel shows). Accept a string, an object, or a
 * `{value}` wrapper and hand back a plain object, or null.
 * @param {unknown} raw @returns {Record<string, any>|null}
 */
export function parseReport(raw) {
  let v = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v && typeof v === 'object' ? v : null;
}

/** Chrome flags for a client; headless adds the new-headless mode and keeps WebGPU on. */
export function chromeArgs({ port, profile, width, height, headless, url }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-features=CalculateNativeWinOcclusion',
    '--enable-unsafe-webgpu',
    `--window-size=${width},${height}`,
  ];
  if (headless) args.push('--headless=new', '--enable-gpu', '--ignore-gpu-blocklist');
  args.push(url);
  return args;
}

// ---------------------------------------------------------------- registry

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  } catch {
    return {};
  }
}
function writeRegistry(reg) {
  fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');
}

const err = (...a) => console.error('[foundry-cdp]', ...a);
const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- connection

async function connect(port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = pages.find((p) => p.url().includes('/game')) ?? pages[0];
  if (!page) throw new Error(`no page open on port ${port}`);
  return { browser, page };
}

async function withPage(opts, fn) {
  const port = resolvePort(opts, readRegistry());
  const { browser, page } = await connect(port);
  try {
    return await fn(page, port);
  } finally {
    // Disconnect only: the browser keeps running for the next command.
    await browser.close().catch(() => {});
  }
}

async function runInPage(page, body, args, { expression = false } = {}) {
  return page.evaluate(
    async ({ src, a }) => {
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${src});`)();
      const value = await fn(a);
      try {
        return { ok: true, value: JSON.parse(JSON.stringify(value ?? null)) };
      } catch {
        return { ok: true, value: String(value) };
      }
    },
    { src: wrapScript(body, { expression }), a: args }
  );
}

async function waitSettled(page, timeoutSec) {
  const t0 = Date.now();
  let last = null;
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    last = await page
      .evaluate(async () => {
        const dbg = globalThis.MapShine?.debug;
        if (!dbg?.runReport) return { available: false };
        const r = await dbg.runReport('scene-settled');
        return { available: true, report: JSON.parse(JSON.stringify(r ?? null)) };
      })
      .catch((e) => ({ available: false, error: String(e) }));
    const rep = parseReport(last?.report);
    if (rep && (rep.settled === true || rep.isSettled === true)) {
      return { settled: true, seconds: (Date.now() - t0) / 1000, report: rep };
    }
    await sleep(1000);
  }
  return { settled: false, seconds: (Date.now() - t0) / 1000, report: last };
}

// ---------------------------------------------------------------- commands

async function boot(opts) {
  const name = String(opts.name ?? 'gm');
  const port = Number(opts.port ?? 9370);
  const url = String(opts.url ?? 'http://localhost:30070');
  const width = Number(opts.width ?? 1600);
  const height = Number(opts.height ?? 900);
  const user = String(opts.user ?? 'Gamemaster');
  const password = typeof opts.password === 'string' ? opts.password : '';
  const headless = opts.headless === true;
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('Chrome not found; set CHROME_PATH');
  const profile = path.join(PROFILES, name);
  fs.mkdirSync(profile, { recursive: true });
  const child = spawn(chrome, chromeArgs({ port, profile, width, height, headless, url: url + '/join' }), {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  err(`chrome pid ${child.pid} on devtools port ${port} (${headless ? 'headless' : 'windowed'})`);

  // Wait for the DevTools endpoint, then log in.
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await sleep(500);
  }
  if (!browser) throw new Error(`devtools port ${port} never came up`);
  const pages = browser.contexts().flatMap((c) => c.pages());
  const page = pages[0];
  await page.waitForLoadState('domcontentloaded');
  if (page.url().includes('/join')) {
    await page.waitForSelector('select[name=userid], input[name=username]', { timeout: 60000 });
    if (await page.$('select[name=userid]')) {
      const value = await page.$eval(
        'select[name=userid]',
        (sel, u) => [...sel.options].find((o) => o.textContent.trim() === u)?.value ?? null,
        user
      );
      if (!value) throw new Error(`user "${user}" not in this world's join list`);
      await page.selectOption('select[name=userid]', value);
    } else {
      await page.fill('input[name=username]', user);
    }
    if (password) await page.fill('input[name=password]', password);
    await Promise.all([
      page.waitForURL('**/game', { timeout: 120000 }),
      page.click('button[name=join], button[type=submit]'),
    ]);
  }
  await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 300000 });
  const reg = readRegistry();
  reg[name] = { port, url, user, headless, pid: child.pid, bootedAt: new Date().toISOString() };
  writeRegistry(reg);
  await browser.close().catch(() => {});
  out({ booted: name, port, url, user, headless });
}

async function clients() {
  const reg = readRegistry();
  const rows = [];
  for (const [name, c] of Object.entries(reg)) {
    let alive = false;
    try {
      const res = await fetch(`http://127.0.0.1:${c.port}/json/version`, { signal: AbortSignal.timeout(1500) });
      alive = res.ok;
    } catch {
      alive = false;
    }
    rows.push({ name, ...c, alive });
  }
  out(rows);
}

async function evalCmd(opts) {
  const body =
    opts.file === '-' || opts.stdin === true
      ? fs.readFileSync(0, 'utf8') // `--file -` reads the script from stdin (heredocs)
      : typeof opts.file === 'string'
        ? fs.readFileSync(opts.file, 'utf8')
        : String(opts.code ?? '');
  if (!body.trim()) throw new Error('give --code "<js>" or --file script.js');
  const args = typeof opts.args === 'string' ? JSON.parse(opts.args) : {};
  const isCode = typeof opts.code === 'string' && opts.file === undefined;
  await withPage(opts, async (page) => {
    // a file or stdin body that is one lint-safe page function gets its call (see `withPageEntryCall`)
    const res = await runInPage(page, isCode ? body : withPageEntryCall(body), args, { expression: isCode });
    out(res.value);
  });
}

async function settle(opts) {
  await withPage(opts, async (page) => out(await waitSettled(page, Number(opts.timeout ?? 300))));
}

async function report(opts) {
  if (typeof opts.id !== 'string') throw new Error('give --id <report or action id>');
  await withPage(opts, async (page) => {
    const res = await runInPage(page, 'return await MapShine.debug.runReport(args.id);', { id: opts.id });
    out(parseReport(res.value) ?? res.value);
  });
}

async function shot(opts) {
  const file = String(opts.out ?? 'shot.png');
  await withPage(opts, async (page) => {
    // --clean: hide Foundry's UI (sidebars, hotbar, MSA panels, pause banner) for
    // beauty shots and before/after pairs; restored straight after the capture.
    const style = opts.clean
      ? await page.addStyleTag({
          content:
            '#interface, #pause, #notifications, #tooltip, #msa-remote, [id^=msa-studio], .app, .application, .window-app { visibility: hidden !important; }',
        })
      : null;
    await page.screenshot({ path: file, fullPage: opts.full === true });
    if (style) await style.evaluate((el) => el.remove());
    out({ saved: path.resolve(file) });
  });
}

async function consoleCmd(opts) {
  const seconds = Number(opts.seconds ?? 30);
  const file = typeof opts.out === 'string' ? opts.out : null;
  const sink = file ? fs.createWriteStream(file, { flags: 'a' }) : null;
  await withPage(opts, async (page) => {
    const write = (line) => {
      const stamped = `${new Date().toISOString()} ${line}`;
      if (sink) sink.write(stamped + '\n');
      else process.stdout.write(stamped + '\n');
    };
    page.on('console', (m) => write(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => write(`[pageerror] ${String(e)}`));
    await sleep(seconds * 1000);
  });
  if (sink) sink.end();
}

async function reload(opts) {
  await withPage(opts, async (page) => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 300000 });
    out(opts.settle ? await waitSettled(page, Number(opts.timeout ?? 300)) : { reloaded: true });
  });
}

async function close(opts) {
  const reg = readRegistry();
  const port = resolvePort(opts, reg);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const session = await browser.newBrowserCDPSession();
  await session.send('Browser.close').catch(() => {});
  if (typeof opts.name === 'string') {
    delete reg[opts.name];
    writeRegistry(reg);
  }
  out({ closed: port });
}

const COMMANDS = { boot, clients, eval: evalCmd, settle, report, shot, console: consoleCmd, reload, close };

async function main() {
  const { mode, opts } = parseArgs(process.argv.slice(2));
  const cmd = COMMANDS[mode];
  if (!cmd) {
    const doc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0];
    process.stdout.write(doc.replace(/^\/\*\*|^ \* ?/gm, '') + '\n');
    process.exit(mode === 'help' ? 0 : 2);
  }
  await cmd(opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    err(e?.message ?? String(e));
    process.exit(1);
  });
}
