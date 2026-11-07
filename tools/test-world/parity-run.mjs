#!/usr/bin/env node
/**
 * tools/test-world/parity-run.mjs — the multi-client parity harness (mmp-f0k.3, feeds mmp-463.2).
 *
 * Several Foundry clients (a GM and players, booted with tools/foundry-cdp) look at the same
 * scene. For each step of a scenario this script waits for every client to settle, takes each
 * client's MapShine.test.digest() and a clean screenshot, and compares the digests.
 *
 * A mismatch is re-checked for a grace period before it counts: a client that joined late is
 * still EASING toward the shared weather targets (the weather manager eases with tau ~20 s), and
 * that is not a desync. A difference that survives the grace period is reported with its path
 * and every client's value.
 *
 *   node tools/test-world/parity-run.mjs --clients gm,p1,p2 [--scenario basic] [--out <dir>] [--grace 60]
 *
 * Scenarios are small lists of GM actions (below). The GM is always the FIRST client named.
 * Writes <out>/report.json, <out>/<step>-<client>.png and prints a one-line verdict per step.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareDigests } from '../../src/diag/state-digest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error('[parity]', ...a);

/**
 * A scenario is a list of steps; each step's `gm` is a page script run on the GM client
 * (async function body) before the clients are compared. Kept small and readable on purpose.
 */
export const SCENARIOS = {
  basic: [
    { name: '01-as-loaded', gm: '' },
    {
      name: '02-weather-overcast',
      gm: "MapShine.fadeWeatherToArchetype('overcast', 0);",
    },
    { name: '03-wind-strong', gm: 'await MapShine.setWind({ directionDeg: 45, speed01: 0.7 });' },
    {
      name: '04-time-dusk',
      gm: 'await game.time.advance(6 * 3600);',
    },
    {
      name: '05-weather-clear',
      gm: "MapShine.fadeWeatherToArchetype('clear', 0); await MapShine.setWind({ speed01: 0 });",
    },
  ],
};

function readRegistry() {
  return JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'foundry-cdp', 'clients.json'), 'utf8'));
}

async function attach(name, port) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url().includes('/game'));
  if (!page) throw new Error(`${name}: no /game page on port ${port}`);
  return { name, browser, page };
}

async function waitSettled(client, timeoutSec = 240) {
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < timeoutSec) {
    const ok = await client.page
      .evaluate(async () => {
        const r = await globalThis.MapShine?.debug?.runReport?.('scene-settled');
        const v = typeof r === 'string' ? JSON.parse(r) : r;
        return v?.settled === true;
      })
      .catch(() => false);
    if (ok) return true;
    await sleep(1000);
  }
  return false;
}

const digestOf = (client) => client.page.evaluate(() => globalThis.MapShine.test.digest());

async function shot(client, file) {
  const style = await client.page.addStyleTag({
    content:
      '#interface, #pause, #notifications, #tooltip, #msa-remote, .app, .application, .window-app { visibility: hidden !important; }',
  });
  await client.page.screenshot({ path: file });
  await style.evaluate((el) => el.remove());
}

async function main() {
  const names = String(opt('clients', 'gm,p1,p2')).split(',');
  const scenario = SCENARIOS[opt('scenario', 'basic')];
  if (!scenario) throw new Error(`unknown scenario; known: ${Object.keys(SCENARIOS).join(', ')}`);
  const grace = Number(opt('grace', 90));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = opt('out', path.join(REPO, 'tests', 'playwright-artifacts', 'parity', stamp));
  fs.mkdirSync(out, { recursive: true });
  const reg = readRegistry();
  const clients = [];
  for (const n of names) {
    if (!reg[n]) throw new Error(`client "${n}" not in tools/foundry-cdp/clients.json; boot it first`);
    clients.push(await attach(n, reg[n].port));
  }
  const [gm] = clients;
  const report = { startedAt: new Date().toISOString(), clients: names, steps: [] };
  try {
    for (const step of scenario) {
      if (step.gm) {
        await gm.page.evaluate(
          // eslint-disable-next-line no-new-func
          (src) => new Function(`return (async () => { ${src} })();`)(),
          step.gm
        );
      }
      await sleep(1500);
      for (const c of clients) await waitSettled(c);
      let cmp = null;
      let digests = null;
      const t0 = Date.now();
      do {
        digests = {};
        for (const c of clients) digests[c.name] = await digestOf(c);
        cmp = compareDigests(digests);
        if (cmp.match) break;
        await sleep(3000);
      } while ((Date.now() - t0) / 1000 < grace);
      for (const c of clients) await shot(c, path.join(out, `${step.name}-${c.name}.png`));
      const row = {
        step: step.name,
        match: cmp.match,
        secondsToMatch: cmp.match ? Math.round((Date.now() - t0) / 1000) : null,
        hashes: Object.fromEntries(Object.entries(digests).map(([k, v]) => [k, v.hash])),
        differences: cmp.differences,
      };
      report.steps.push(row);
      log(`${step.name}: ${cmp.match ? 'MATCH' : `MISMATCH (${cmp.differences.map((d) => d.path).join(', ')})`}`);
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    for (const c of clients) await c.browser.close().catch(() => {});
  }
  process.stdout.write(
    JSON.stringify({ out, steps: report.steps.map((s) => ({ step: s.step, match: s.match })) }, null, 2) + '\n'
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    log(e?.message ?? e);
    process.exit(1);
  });
}
