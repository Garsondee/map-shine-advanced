#!/usr/bin/env node
/**
 * Runs tools/shader-lab/rc-lab.html (radiance cascades lab, mmp-ku9.5) in Chrome with WebGPU and saves the
 * report + PNGs to tools/shader-lab/runs/rc-<stamp>/.
 *   node tools/shader-lab/rc-run.mjs [--headed]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, '..', '..', 'package.json'));
const { chromium } = require('playwright');

const headed = process.argv.includes('--headed');
const browser = await chromium.launch({
  channel: 'chrome',
  headless: !headed,
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--allow-file-access-from-files'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[rc] pageerror', String(e)));
page.on('console', (m) => m.type() === 'error' && console.error('[rc]', m.text()));
await page.goto(pathToFileURL(path.join(HERE, 'rc-lab.html')).href);
await page.waitForFunction(() => window.rcReport, null, { timeout: 180000 });
const report = await page.evaluate(() => window.rcReport);
const pngs = await page.evaluate(() => window.rcPng);
const out = path.join(HERE, 'runs', `rc-${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
for (const [k, v] of Object.entries(pngs ?? {}))
  fs.writeFileSync(path.join(out, `${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
console.log(JSON.stringify({ out, ...report }, null, 2));
await browser.close();
