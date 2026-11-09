/**
 * tools/lab/lab-check.mjs — `lab.mjs check --family walls`: measure every claim in walls-claims.mjs (mmp-78u).
 *
 * The "expectations first" loop as one command. For every Lab · Walls & Windows cell a claim needs:
 * pan to it (scale ~0.8 keeps all its points on screen), wait for MSA's ready signal, probe ALL the
 * cell's named points in ONE MapShine.probe call, keep only on-screen reads (off-screen probe buffers are
 * garbage, FRICTION #19). Then evaluate every claim, write tools/lab/out/check-walls.json (one block per
 * view, the other view's block kept), print a short table, and save a clean screenshot of each FAILING
 * cell as tools/lab/out/shots/discrepancies/<claimId>--<wall>-<light>[--measure].png.
 *
 * Views: `shipped` clears any leftover Measure overrides first; `measure` switches off the post effects
 * (lab-look MEASURE_OFF) with the mmp-78u.7 viewport nudge, and restores them after unless --keep.
 *
 * The caller (lab.mjs) holds the rig lock for the whole run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { WALLS_IDS } from './walls-spec.mjs';
import { WALLS_CLAIMS, wallsCheckCells, evaluateWallsClaims, claimSourceCounts } from './walls-claims.mjs';
import { MEASURE_OFF } from './lab-look.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const OUT_JSON = path.join(HERE, 'out', 'check-walls.json');
const SHOT_DIR = path.join(HERE, 'out', 'shots', 'discrepancies');
const HIDE_UI =
  '#interface, #pause, #notifications, #tooltip, #msa-remote, [id^=msa-studio], .app, .application, .window-app, [data-msa-probe-overlay] { visibility: hidden !important; }';

function cdpPort(name) {
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'foundry-cdp', 'clients.json'), 'utf8'));
  if (!reg[name]) throw new Error(`no cdp client named ${name}`);
  return reg[name].port;
}

/** In-page: pan to a cell, wait for ready, probe its points once, return trimmed rows. */
async function probeCell(page, cell, { scale, settleMs }) {
  return page.evaluate(
    async ({ cx, cy, pts, scale, settleMs }) => {
      const d = canvas.dimensions;
      await canvas.animatePan({ x: d.sceneX + cx, y: d.sceneY + cy, scale, duration: 0 });
      await new Promise((r) => setTimeout(r, settleMs));
      const t0 = Date.now();
      while (Date.now() - t0 < 120000 && !globalThis.MapShine?.getSceneReady?.()?.ready) {
        await new Promise((r) => setTimeout(r, 300));
      }
      const r = await MapShine.probe(pts.map((p) => ({ name: p.name, x: p.x + d.sceneX, y: p.y + d.sceneY })));
      const f4 = (a) => (Array.isArray(a) ? a.slice(0, 3).map((v) => Number(Number(v).toFixed(4))) : null);
      return {
        settled: r.settled,
        verdict: r.verdict,
        rows: r.results.map((x) => ({
          name: x.name,
          onScreen: x.onScreen,
          albedo: f4(x.albedo),
          illum: f4(x.illum),
          lit: f4(x.lit),
          coloration: f4(x.coloration),
          presented: x.presented ? x.presented.slice(0, 3) : null,
          drift: x.drift ? { maxAbs: x.drift.maxAbs, verdict: x.drift.verdict } : null,
          outdoors01: x.outdoors01,
          foundry: x.foundry
            ? {
                darkness: x.foundry.darkness,
                regions: (x.foundry.regions ?? []).map((g) => g.behaviors.join('+')),
                lights: (x.foundry.lights ?? []).map((l) => ({ id: l.id, kind: l.kind, dist: l.dist })),
              }
            : null,
        })),
      };
    },
    { cx: cell.cx, cy: cell.cy, pts: cell.pts, scale, settleMs }
  );
}

async function setView(page, view, waitMs) {
  await page.evaluate(
    async ({ sceneId, levelId, off, measure }) => {
      if (canvas.scene?.id !== sceneId || canvas.level?.id !== levelId) {
        await game.scenes.get(sceneId).view({ level: levelId });
        await new Promise((r) => setTimeout(r, 5000));
      }
      for (const id of off) MapShine.forceEffect(id, measure ? false : null);
      // MSA's grid off hands the lines back to Foundry's own mesh: hide that too in Measure view.
      const gm = canvas.interface?.grid?.mesh;
      if (gm && measure) gm.visible = false;
    },
    { sceneId: WALLS_IDS.scene, levelId: WALLS_IDS.level, off: MEASURE_OFF, measure: view === 'measure' }
  );
  // mmp-78u.7 workaround: nudge the viewport so present rebinds to the live lit target.
  const vp =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight })));
  await page.setViewportSize({ width: vp.width - 2, height: vp.height });
  await page.waitForTimeout(500);
  await page.setViewportSize(vp);
  await page.waitForTimeout(waitMs);
  await page.evaluate(async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 120000 && !globalThis.MapShine?.getSceneReady?.()?.ready) {
      await new Promise((r) => setTimeout(r, 500));
    }
  });
}

async function shootCell(page, cell, file, { scale, settleMs }) {
  await page.evaluate(
    async ({ cx, cy, scale, settleMs }) => {
      const d = canvas.dimensions;
      await canvas.animatePan({ x: d.sceneX + cx, y: d.sceneY + cy, scale, duration: 0 });
      await new Promise((r) => setTimeout(r, settleMs));
      const t0 = Date.now();
      while (Date.now() - t0 < 120000 && !globalThis.MapShine?.getSceneReady?.()?.ready) {
        await new Promise((r) => setTimeout(r, 300));
      }
    },
    { cx: cell.cx, cy: cell.cy, scale, settleMs }
  );
  const style = await page.addStyleTag({ content: HIDE_UI });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  await style.evaluate((el) => el.remove());
}

const shotName = (id, cell, view) =>
  path.join(SHOT_DIR, `${id}--${cell.replace('/', '-')}${view === 'measure' ? '--measure' : ''}.png`);

export async function checkWalls({
  name,
  view = 'shipped',
  scale = 0.8,
  settleMs = 1200,
  waitMs = 6000,
  only = null,
  walls = null,
  lights = null,
  shots = true,
  keep = false,
  log = (s) => console.error(s),
}) {
  if (!name) throw new Error('check needs --name <cdp client>');
  if (!['shipped', 'measure'].includes(view)) throw new Error(`unknown view ${view}`);
  const claims = WALLS_CLAIMS.filter((c) => !only || only.includes(c.id)).filter(
    (c) => !c.views || c.views.includes(view)
  );
  const cells = wallsCheckCells(claims, { walls, lights });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort(name)}`);
  const t0 = Date.now();
  let restorePage = null;
  try {
    const page = browser
      .contexts()
      .flatMap((x) => x.pages())
      .find((p) => p.url().includes('/game'));
    if (!page) throw new Error('no /game page');
    await setView(page, view, waitMs);
    // Measure overrides are restored in the finally below, crash or not (FRICTION #30).
    restorePage = view === 'measure' && !keep ? page : null;

    const data = {};
    const raw = {};
    for (const [i, cell] of cells.entries()) {
      const r = await probeCell(page, cell, { scale, settleMs });
      raw[cell.key] = { settled: r.settled, verdict: r.verdict, rows: r.rows };
      data[cell.key] = Object.fromEntries(r.rows.map((row) => [row.name, row]));
      if (i % 14 === 13) log(`[check] ${i + 1}/${cells.length} cells probed`);
    }
    const results = evaluateWallsClaims(data, view, claims);

    // Screenshots: one clean shot per failing cell, copied under each failing claim's name.
    const failingCells = new Map(); // cell -> [claimIds]
    for (const r of results) {
      if (r.pass !== false) continue;
      const list = r.cells?.length ? r.cells : r.cell.includes('*') ? [] : [r.cell];
      for (const c of list) failingCells.set(c, [...(failingCells.get(c) ?? []), r.id]);
    }
    // Stale shots of instances that now pass (or are no longer failing cells) are removed.
    for (const r of results) {
      const list = r.cells?.length ? r.cells : r.cell.includes('*') ? [] : [r.cell];
      for (const c of list) {
        if ((failingCells.get(c) ?? []).includes(r.id)) continue;
        const f = shotName(r.id, c, view);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      if (r.pass !== false && !r.cell.includes('*')) {
        const f = shotName(r.id, r.cell, view);
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    }
    const shotFiles = {};
    if (shots && failingCells.size) {
      const byKey = Object.fromEntries(cells.map((c) => [c.key, c]));
      for (const [cellKey, ids] of failingCells) {
        const cell = byKey[cellKey];
        if (!cell) continue;
        const first = shotName(ids[0], cellKey, view);
        await shootCell(page, cell, first, { scale, settleMs });
        for (const id of ids.slice(1)) fs.copyFileSync(first, shotName(id, cellKey, view));
        for (const id of ids) (shotFiles[id] ??= []).push(path.relative(REPO, shotName(id, cellKey, view)));
      }
    }

    const summary = {};
    for (const c of claims) {
      const mine = results.filter((r) => r.id === c.id);
      summary[c.id] = {
        source: c.source,
        known: c.known ?? null,
        pass: mine.filter((r) => r.pass === true).length,
        fail: mine.filter((r) => r.pass === false).length,
        skip: mine.filter((r) => r.pass === null).length,
      };
    }
    const block = {
      at: new Date().toISOString(),
      seconds: Math.round((Date.now() - t0) / 1000),
      settings: { scale, settleMs, only, walls, lights },
      sources: claimSourceCounts(claims),
      totals: {
        claims: claims.length,
        instances: results.length,
        pass: results.filter((r) => r.pass === true).length,
        fail: results.filter((r) => r.pass === false).length,
        skip: results.filter((r) => r.pass === null).length,
      },
      summary,
      results: results.map((r) => ({
        ...r,
        shots: (shotFiles[r.id] ?? []).filter((f) => f.includes(r.cell.replace('/', '-'))),
      })),
      claims: claims.map(({ check: _check, ...meta }) => meta),
      cells: raw,
    };
    let file = { family: 'walls', views: {} };
    try {
      file = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
    } catch {
      // first run
    }
    file.updated = block.at;
    // A filtered run (--only/--walls/--lights) never replaces the full run of that view.
    const slot = only || walls || lights ? `${view}-partial` : view;
    file.views = { ...(file.views ?? {}), [slot]: block };
    fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
    fs.writeFileSync(OUT_JSON, JSON.stringify(file, null, 1));
    return { view, file: OUT_JSON, block, shotFiles };
  } finally {
    if (restorePage) {
      await restorePage
        .evaluate((off) => off.forEach((id) => MapShine.forceEffect(id, null)), MEASURE_OFF)
        .catch((err) => log(`[check] could not restore the Measure overrides: ${err.message}`));
    }
    await browser.close().catch(() => {});
  }
}

/**
 * Re-judge the claims on the probe data saved by the last run of `view` (no rig, no shots): for
 * correcting a claim and keeping the evidence it was judged on.
 */
export function recheckWallsOffline({ view = 'shipped', only = null } = {}) {
  const file = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
  const prev = file.views?.[view];
  if (!prev?.cells) throw new Error(`no saved ${view} run in ${OUT_JSON}`);
  const claims = WALLS_CLAIMS.filter((c) => !only || only.includes(c.id)).filter(
    (c) => !c.views || c.views.includes(view)
  );
  const data = Object.fromEntries(
    Object.entries(prev.cells).map(([k, c]) => [k, Object.fromEntries(c.rows.map((r) => [r.name, r]))])
  );
  const results = evaluateWallsClaims(data, view, claims);
  const summary = {};
  for (const c of claims) {
    const mine = results.filter((r) => r.id === c.id);
    summary[c.id] = {
      source: c.source,
      known: c.known ?? null,
      pass: mine.filter((r) => r.pass === true).length,
      fail: mine.filter((r) => r.pass === false).length,
      skip: mine.filter((r) => r.pass === null).length,
    };
  }
  const block = {
    ...prev,
    rejudgedAt: new Date().toISOString(),
    sources: claimSourceCounts(claims),
    totals: {
      claims: claims.length,
      instances: results.length,
      pass: results.filter((r) => r.pass === true).length,
      fail: results.filter((r) => r.pass === false).length,
      skip: results.filter((r) => r.pass === null).length,
    },
    summary,
    // keep the last run's screenshots for instances that still fail (the files are from that run)
    results: results.map((r) => ({
      ...r,
      shots:
        r.pass === false ? ((prev.results ?? []).find((p) => p.id === r.id && p.cell === r.cell)?.shots ?? []) : [],
    })),
    claims: claims.map(({ check: _check, ...meta }) => meta),
  };
  if (!only) {
    file.views[view] = block;
    file.updated = block.rejudgedAt;
    fs.writeFileSync(OUT_JSON, JSON.stringify(file, null, 1));
  }
  return { view: `${view}, re-judged offline`, file: OUT_JSON, block };
}

/** The short console table for a run. */
export function printCheck({ view, file, block }) {
  const rows = Object.entries(block.summary).map(([id, s]) => ({
    claim: id,
    source: s.source,
    pass: s.pass,
    fail: s.fail,
    skip: s.skip,
    known: s.known ?? '',
  }));
  console.log(
    `walls check (${view}): ${block.totals.claims} claims, ${block.totals.instances} instances — ` +
      `${block.totals.pass} pass, ${block.totals.fail} fail, ${block.totals.skip} skip (${block.seconds} s) -> ${file}`
  );
  console.table(rows.filter((r) => r.fail || r.skip));
  for (const r of block.results.filter((x) => x.pass === false)) {
    console.log(`FAIL ${r.id} ${r.cell}${r.known ? ` [known ${r.known}]` : ''}: got ${r.got} | want ${r.want}`);
  }
}
