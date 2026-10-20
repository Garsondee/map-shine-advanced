/**
 * SHADER LAB — HEADLESS DRIVER. Runs a script inside a lab page on a REAL GPU, from the command line, so an
 * agent (or a person) can iterate on a look without the Claude browser pane being on screen.
 *
 *   1. start the lab:        SHADER_LAB_PORT=8971 node tools/shader-lab/serve.mjs
 *   2. start a Chrome:       chrome --remote-debugging-port=9333 --user-data-dir=<scratch dir> --enable-unsafe-webgpu
 *                            --disable-backgrounding-occluded-windows --disable-renderer-backgrounding
 *                            --disable-features=CalculateNativeWinOcclusion
 *   3. run a script:         node tools/shader-lab/drive.mjs --url http://localhost:8971/tools/shader-lab/fire-billow-lab.html
 *                                 --script my-script.js [--out some/dir] [--reload]
 *
 * The script file is the BODY of an async function evaluated in the page (so `window.fireBillowLab` etc. are in
 * scope, top-level `await` works). Its return value is printed as JSON. If the value has a `files` array
 * (`[{name, dataUrl}]`), each data URL is written under `--out` (default `tools/shader-lab/runs/drive`) and the
 * data URL is dropped from the printed result.
 *
 * Why a driver and not just `lab.run`? The pane the desktop app shows is HIDDEN whenever the session is not on
 * screen (no animation frames, stale screenshots); a real Chrome driven over CDP is not. The labs advance a
 * virtual clock and render on demand, so they run fine headlessly either way.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const url = opt('url');
const scriptPath = opt('script');
const outDir = path.resolve(opt('out', 'tools/shader-lab/runs/drive'));
const cdp = opt('cdp', 'http://127.0.0.1:9333');
const timeoutMs = Number(opt('timeout', 600000));
const waitExpr = opt('wait');
if (!url || !scriptPath) {
  console.error('usage: drive.mjs --url <lab page> --script <file.js> [--out dir] [--reload] [--wait <js expr>] [--cdp url] [--timeout ms]');
  process.exit(2);
}

const browser = await chromium.connectOverCDP(cdp);
const context = browser.contexts()[0] ?? (await browser.newContext());
let page = context.pages().find((p) => p.url().split('?')[0] === url.split('?')[0]);
const fresh = !page;
if (!page) page = await context.newPage();
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('[lab]')) logs.push(`[${m.type()}] ${m.text().slice(0, 500)}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${String(e).slice(0, 800)}`));
await page.bringToFront();
if (fresh || flag('reload') || page.url() !== url) await page.goto(url, { waitUntil: 'load', timeout: 120000 });

if (waitExpr) await page.waitForFunction(waitExpr, null, { timeout: 120000 });
const body = fs.readFileSync(path.resolve(scriptPath), 'utf8');
let result;
try {
  result = await Promise.race([
    page.evaluate(async (src) => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      return await new AsyncFunction(src)();
    }, body),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`script timed out after ${timeoutMs} ms`)), timeoutMs)),
  ]);
} catch (e) {
  console.error('SCRIPT ERROR:', String(e?.message ?? e).slice(0, 2000));
  if (logs.length) console.error(logs.slice(-30).join('\n'));
  await browser.close().catch(() => {});
  process.exit(1);
}

if (result && Array.isArray(result.files)) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of result.files) {
    const m = /^data:[^;]+;base64,(.*)$/.exec(f.dataUrl ?? '');
    if (!m) continue;
    const dest = path.join(outDir, f.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(m[1], 'base64'));
    console.log('wrote', dest);
  }
  result = { ...result, files: result.files.map((f) => f.name) };
}
console.log(JSON.stringify(result, null, 2)?.slice(0, 20000));
if (logs.length) console.log('--- page console ---\n' + logs.slice(-40).join('\n'));
await browser.close().catch(() => {}); // disconnects only; the Chrome keeps running
