/**
 * tools/lab/interiors-check.mjs — `lab.mjs check --family interiors`: measure every claim in
 * interiors-claims.mjs on Lab · Interiors & Regions (mmp-78u, family 1).
 *
 * The walls runner probes one lighting state; this family needs many (the clock, the moon, clouds, rain,
 * scene darkness, Global Illumination, the Night fader, other floors, a forced strike, a Region edit, the
 * Region darkness override). So the run is a loop over CONDITIONS: set one condition on the lab scene, let
 * it settle (MSA's ready signal, then two probe reads that agree, FRICTION #14), and for each probe group
 * the claims need under it: pan, settle, take a clean screenshot, probe ALL the group's points in ONE
 * MapShine.probe call (plus Foundry's own darkness at the three floor elevations). Off-screen points are
 * kept as off-screen and make a claim SKIP (FRICTION #19).
 *
 * SAFETY. Everything the run changes is put back in a `finally` (FRICTION #30): the lab scene's sky and
 * wind flags, its environment (darkness, Global Illumination), the Night fader, transient effect
 * overrides, the Region edit, the Measure view, the viewed scene, and MSA's Region darkness override
 * (a WORLD setting, ON by default, that rewrites the lab's authored Region modes on view; the run turns it
 * off on the private rig only — it refuses on any host but localhost — and repairs the lab Regions from
 * the spec, then restores the setting while viewing another scene so the repaired Regions stay as built).
 *
 * Output: tools/lab/out/check-interiors.json (one block per view; the raw probe data is kept so
 * `--offline` can re-judge corrected claims), a console table, and for every failing claim a clean shot
 * of each (condition, group) it read: tools/lab/out/shots/discrepancies/<claim>--<cond>--<group>[--measure].png.
 *
 * The caller (lab.mjs) holds the rig lock for the whole run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { INTERIORS_IDS } from './interiors-spec.mjs';
import { IDS } from './lab-spec.mjs';
import {
  INTERIORS_CLAIMS,
  interiorsPlan,
  evaluateInteriorsClaims,
  claimSourceCounts,
  specRegionBehaviours,
} from './interiors-claims.mjs';
import { MEASURE_OFF } from './lab-look.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));
const OUT_JSON = path.join(HERE, 'out', 'check-interiors.json');
const SHOT_DIR = path.join(HERE, 'out', 'shots', 'discrepancies');
const TMP_DIR = path.join(HERE, 'out', 'shots', 'interiors-tmp');
const HIDE_UI =
  '#interface, #pause, #notifications, #tooltip, #msa-remote, [id^=msa-studio], .app, .application, .window-app, [data-msa-probe-overlay] { visibility: hidden !important; }';
const NS = 'map-shine-advanced';
const LEVEL_IDS = Object.freeze({
  basement: INTERIORS_IDS.levelBasement,
  ground: INTERIORS_IDS.levelGround,
  upper: INTERIORS_IDS.levelUpper,
});
/** Effects the conditions may force; always released at the end. */
const CONDITION_FORCES = Object.freeze(['sunShadows']);

function cdpPort(name) {
  const reg = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'foundry-cdp', 'clients.json'), 'utf8'));
  if (!reg[name]) throw new Error(`no cdp client named ${name}`);
  return reg[name].port;
}

// ------------------------------------------------------------------------------------------- page side
// Each function below runs IN the Foundry page (page.evaluate serialises it): no closures, one argument.

/** What the run will change, as it is now. */
async function pageSnapshot({ sceneId, ns }) {
  const s = game.scenes.get(sceneId);
  if (!s) throw new Error(`no scene ${sceneId}: seed the lab first`);
  const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
  return {
    host: globalThis.location.hostname,
    viewedScene: canvas.scene?.id ?? null,
    viewedLevel: canvas.level?.id ?? null,
    sky: clone(s.getFlag(ns, 'sky')),
    wind: clone(s.getFlag(ns, 'wind')),
    env: { darknessLevel: s._source.environment.darknessLevel, globalLight: clone(s._source.environment.globalLight) },
    realism: MapShine.getDarknessRealism(),
    paused: game.paused,
    override: {
      enabled: game.settings.get(ns, 'regionDarknessOverrideEnabled'),
      value: game.settings.get(ns, 'regionDarknessOverrideValue'),
    },
  };
}

/** Override OFF (private rig only) and the lab Regions repaired to the spec. Returns what it did. */
async function pageOverrideOffAndRepair({ sceneId, ns, spec }) {
  const host = globalThis.location.hostname;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    throw new Error(`refusing to change the Region darkness override on ${host} (private rig only)`);
  }
  let switched = false;
  if (game.settings.get(ns, 'regionDarknessOverrideEnabled')) {
    await game.settings.set(ns, 'regionDarknessOverrideEnabled', false);
    switched = true;
  }
  const s = game.scenes.get(sceneId);
  let repaired = 0;
  for (const region of s.regions) {
    const key = String(region.flags?.[ns]?.lab ?? '').replace(/^region:/, '');
    const want = spec[key];
    if (!want) continue;
    const have = [...region.behaviors];
    const updates = [];
    want.forEach((w, i) => {
      const b = have[i];
      if (!b || b.type !== w.type || w.type !== 'adjustDarknessLevel') return;
      const stashed = b.getFlag(ns, 'regionDarknessOverrideOriginal') !== undefined;
      if (b.system.mode !== w.mode || Math.abs(b.system.modifier - w.modifier) > 1e-6 || stashed) {
        updates.push({
          _id: b.id,
          'system.mode': w.mode,
          'system.modifier': w.modifier,
          [`flags.${ns}.-=regionDarknessOverrideOriginal`]: null,
        });
      }
    });
    if (updates.length) {
      await region.updateEmbeddedDocuments('RegionBehavior', updates);
      repaired += updates.length;
    }
  }
  return { switched, repaired };
}

/** Put the Region darkness override back as it was (call while viewing ANOTHER scene). */
async function pageOverrideRestore({ ns, enabled }) {
  if (game.settings.get(ns, 'regionDarknessOverrideEnabled') !== enabled) {
    await game.settings.set(ns, 'regionDarknessOverrideEnabled', enabled);
  }
  return game.settings.get(ns, 'regionDarknessOverrideEnabled');
}

/** View a scene + level and wait for MSA's ready signal. */
async function pageView({ sceneId, levelId }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (canvas.scene?.id !== sceneId || (levelId && canvas.level?.id !== levelId)) {
    await game.scenes.get(sceneId).view(levelId ? { level: levelId } : {});
    await sleep(5000);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 180000 && !MapShine.getSceneReady?.()?.ready) await sleep(500);
  return { scene: canvas.scene?.id, level: canvas.level?.id, ready: MapShine.getSceneReady?.()?.ready };
}

/** Set one condition on the lab scene, from the snapshot `base` (so conditions never stack). */
async function pageApplyCondition({ sceneId, ns, cond, base, forces }) {
  const s = game.scenes.get(sceneId);
  // scene environment: darkness + Global Illumination (document update; lab scene only)
  const patch = {};
  const wantDark = cond.env?.darknessLevel ?? base.env.darknessLevel;
  if (s._source.environment.darknessLevel !== wantDark) patch['environment.darknessLevel'] = wantDark;
  const wantGi = cond.env?.globalLight ? { ...base.env.globalLight, ...cond.env.globalLight } : base.env.globalLight;
  if (JSON.stringify(s._source.environment.globalLight) !== JSON.stringify(wantGi))
    patch['environment.globalLight'] = wantGi;
  if (Object.keys(patch).length) await s.update(patch);
  // sky (hour + weather + moon) and wind: the lab scene's own flags, then snap the weather
  const sky = { ...(base.sky ?? {}), ...(cond.sky ?? {}), todHour: cond.hour };
  await s.setFlag(ns, 'sky', sky);
  const wind = { ...(base.wind ?? {}), ...(cond.wind ?? {}) };
  if (cond.wind) wind.scale = 'linear70';
  if (JSON.stringify(s.getFlag(ns, 'wind')) !== JSON.stringify(wind)) {
    await s.unsetFlag(ns, 'wind');
    await s.setFlag(ns, 'wind', wind);
  }
  MapShine.setWeatherTargets?.(
    { cloudCover01: sky.cloudCover01 ?? 0, precip01: sky.precip01 ?? 0 },
    { immediate: true }
  );
  MapShine.setTimeOfDay(cond.hour, 0);
  MapShine.setDarknessRealism(cond.realism ?? base.realism);
  for (const id of forces) MapShine.forceEffect(id, cond.force && id in cond.force ? cond.force[id] : null);
  // MSA runs every world motion on ONE pausing clock (clouds drift, rain falls, the storm steps only while
  // Foundry is unpaused; FRICTION #37). A `live` condition unpauses THIS client only (no broadcast, so the
  // server's pause state is untouched); every other condition runs as the world was.
  const wantPaused = cond.live ? false : base.paused;
  if (game.paused !== wantPaused) game.togglePause(wantPaused);
  return {
    hour: cond.hour,
    paused: game.paused,
    sky: { cloud: sky.cloudCover01, precip: sky.precip01, moon: sky.moonlight01 },
  };
}

/** Change one lab Region's first darkness modifier (IR-60). Returns the old value. */
async function pageEditRegion({ sceneId, ns, key, modifier }) {
  const s = game.scenes.get(sceneId);
  const region = s.regions.find((r) => r.flags?.[ns]?.lab === `region:${key}`);
  const b = region ? [...region.behaviors].find((x) => x.type === 'adjustDarknessLevel') : null;
  if (!b) throw new Error(`no darkness behaviour on lab Region ${key}`);
  const old = b.system.modifier;
  await region.updateEmbeddedDocuments('RegionBehavior', [{ _id: b.id, 'system.modifier': modifier }]);
  return old;
}

/** Switch the override ON while viewing the lab scene (IR-63) and report what it wrote. */
async function pageOverrideOn({ sceneId, ns }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await game.settings.set(ns, 'regionDarknessOverrideEnabled', true);
  await sleep(4000);
  const s = game.scenes.get(sceneId);
  const docs = {};
  for (const r of s.regions) {
    const key = String(r.flags?.[ns]?.lab ?? '').replace(/^region:/, '');
    const b = [...r.behaviors].find((x) => x.type === 'adjustDarknessLevel');
    if (key && b) docs[key] = `${b.system.mode} ${b.system.modifier}`;
  }
  return { value: Number(game.settings.get(ns, 'regionDarknessOverrideValue')), docs };
}

/**
 * Pan to a group, settle, optionally strike, and probe its points. Returns trimmed rows keyed by point
 * name, with per-group facts in `env` on every row.
 */
async function pageProbeGroup({ g, scale, settleMs, mode, extra, forces, measure }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // forceEffect overrides are dropped by ANY later re-resolve of the effect (a view, a setting, a weather
  // fade, a Look; manager note 2026-11-09), so the Measure view and the condition's own forced effects are
  // re-asserted right before every probe read, never trusted from the start of the run.
  const reassert = () => {
    for (const [id, v] of Object.entries(forces ?? {})) MapShine.forceEffect(id, v);
    const gm = canvas.interface?.grid?.mesh;
    if (gm && measure) gm.visible = false;
  };
  const probe = (pts, opts) => {
    reassert();
    return MapShine.probe(pts, opts);
  };
  const d = canvas.dimensions;
  await canvas.animatePan({ x: d.sceneX + g.cx, y: d.sceneY + g.cy, scale: scale ?? g.scale, duration: 0 });
  reassert();
  await sleep(settleMs);
  // Moving clouds, rain and a strike may keep the scene from reading "quiet" (a precaution, not measured), so
  // MSA's ready signal is capped short in the live modes; everywhere else it is waited for in full.
  const readyCap = mode === 'samples' || mode === 'series' || mode === 'strike' ? 8000 : 120000;
  const t0 = Date.now();
  while (Date.now() - t0 < readyCap && !MapShine.getSceneReady?.()?.ready) await sleep(300);
  // The probe reads the buffers at the wrong pixel when the render-scale governor is below 1 (mmp-78u.41):
  // wait up to 30 s for full resolution; a row still read below it is recorded and SKIPped by the claims.
  const rs = () => MapShine.getRenderScaleState?.()?.resolvedInternalScale ?? 1;
  const t1 = Date.now();
  while (rs() < 1 && Date.now() - t1 < 30000) await sleep(500);
  const world = g.pts.map((p) => ({ name: p.name, x: p.x + d.sceneX, y: p.y + d.sceneY }));
  const f4 = (a) => (Array.isArray(a) ? a.slice(0, 3).map((v) => Number(Number(v).toFixed(4))) : null);
  const fd = (p, e) => {
    try {
      return Number(canvas.effects.getDarknessLevel({ x: p.x, y: p.y, elevation: e }).toFixed(4));
    } catch {
      return null;
    }
  };
  const trim = (x, i) => ({
    name: x.name,
    onScreen: x.onScreen,
    // probe v2.2 (mmp-78u.26): a buffer the probe could not read is named here instead of throwing
    readErrors: x.readErrors ?? null,
    floorIndex: x.floorIndex,
    outdoors01: x.outdoors01,
    albedo: f4(x.albedo),
    illum: f4(x.illum),
    lit: f4(x.lit),
    coloration: f4(x.coloration),
    presented: x.presented ? x.presented.slice(0, 3) : null,
    // Probe v2.1 judges drift on luma; the worst single channel rides along.
    drift: x.drift
      ? { lumaDrift: x.drift.lumaDrift, channelMaxAbs: x.drift.channelMaxAbs, verdict: x.drift.verdict }
      : null,
    fd: { b: fd(world[i], -19), g: fd(world[i], 1), u: fd(world[i], 21) },
    foundry: x.foundry
      ? {
          darkness: x.foundry.darkness,
          regions: (x.foundry.regions ?? []).map((r) => `${r.name}: ${r.behaviors.join('+')}`),
          // Probe v2.1: `lights` holds light emitters only; MSA's vision-only sources, Foundry's global light and
          // darkness sources are `otherSources` (kind msaVision / globalLight / darkness).
          lights: (x.foundry.lights ?? []).map((l) => ({ id: l.id, kind: l.kind, dist: l.dist })),
          otherSources: (x.foundry.otherSources ?? []).map((s) => ({ id: s.id, kind: s.kind, dist: s.dist })),
        }
      : null,
  });
  // Stable: two reads >= 1.2 s apart whose on-screen illum agree within 0.004 (the sun ease, FRICTION #14).
  // A 'prompt' read (IR-60: does an edit land within 2 s?) takes the first settled frame as it is.
  let first = await probe(world);
  for (let k = 0; k < 10 && mode !== 'prompt'; k++) {
    await sleep(1200);
    const again = await probe(world);
    const moved = again.results.some((r, i) => {
      if (!r.onScreen || !Array.isArray(r.illum) || !Array.isArray(first.results[i]?.illum)) return false;
      return r.illum.some((v, c) => Math.abs(v - first.results[i].illum[c]) > 0.004);
    });
    first = again;
    if (!moved || mode === 'samples' || mode === 'series') break;
  }
  // Sanity gate: buffers that disagree with the screen at many points (drift 'suspect') were seen once right
  // after Region documents changed (FRICTION #34); read again once before believing them.
  const suspects = (r) => r.results.filter((x) => x.onScreen && x.drift?.verdict === 'suspect').length;
  let reread = false;
  if (mode !== 'prompt' && suspects(first) > 0.25 * first.results.length) {
    await sleep(2500);
    first = await probe(world);
    reread = true;
  }
  const base = first.results.map(trim);
  const series = Array.from({ length: base.length }, () => []);
  const push = (r) =>
    r.results.forEach((x, i) =>
      series[i].push({ illum: f4(x.illum), presented: x.presented ? x.presented.slice(0, 3) : null })
    );
  if (mode === 'samples') {
    push(first);
    for (let k = 1; k < extra.samples; k++) {
      await sleep(extra.intervalMs);
      push(await probe(world));
    }
  } else if (mode === 'series') {
    for (let k = 0; k < extra.series; k++) push(await probe(world, { stable: false }));
  } else if (mode === 'strike') {
    const p = world.find((w) => w.name === extra.point);
    MapShine.strikeLightning?.({ x: p.x, y: p.y });
    for (let k = 0; k < extra.reads; k++) {
      const r = await probe(world, { stable: false, presented: false });
      push(r);
      // the storm's own account of this frame's flash, beside the buffers it should have lit
      const flash = MapShine.getStormLightning?.()?.frame?.flash01 ?? null;
      series.forEach((s) => (s[s.length - 1].flash = flash));
      await sleep(60);
    }
  }
  const gls = canvas.environment?.globalLightSource;
  let giOwned = null;
  let regionField = null;
  try {
    // eslint-disable-next-line import/no-unresolved -- served by Foundry from the module folder, in the page
    const m = await import('/modules/map-shine-advanced/src/vt/index.js');
    const diag = m.getVtPanViewerDiagnostics?.();
    giOwned = diag?.envSnapshot?.globalLightSystemOwned ?? null;
    const f = diag?.regionDarkness?.field;
    if (f)
      regionField = { texelPx: f.texelPx, bakes: f.bakes, retries: f.retries, stale: f.stale, shapes: f.shapesDrawn };
  } catch {
    giOwned = null;
  }
  const env = {
    realism: MapShine.getDarknessRealism(),
    darkness: canvas.environment?.darknessLevel ?? null,
    giActive: gls?.active ?? null,
    giWindow: gls?.data?.darkness ? { min: gls.data.darkness.min, max: gls.data.darkness.max } : null,
    giOwned,
    level: canvas.level?.name ?? null,
    scale: canvas.stage?.scale?.x ?? null,
    // The render scale the probe's reads USED (probe v2.2 context.renderScale; the live setting as a fallback).
    // Since v2.2 the buffer reads are right at any scale (mmp-78u.41); presented bytes below 1 still pass
    // through the upscale + sharpen, so the claims keep skipping rows read below native.
    renderScale: first.context?.renderScale?.scale ?? MapShine.getRenderScaleState?.()?.resolvedInternalScale ?? null,
    regionField,
    suspectDrift: suspects(first),
    reread,
    ...(extra.env ?? {}),
  };
  const rows = {};
  base.forEach((r, i) => {
    rows[r.name] = { ...r, env, ...(series[i].length ? { series: series[i] } : {}) };
  });
  return { settled: first.settled, verdict: first.verdict, rows };
}

/** Undo every condition change: environment, sky, wind, weather, hour, Night fader, forced effects. */
async function pageRestore({ sceneId, ns, base, forces }) {
  const s = game.scenes.get(sceneId);
  const patch = {};
  if (s._source.environment.darknessLevel !== base.env.darknessLevel)
    patch['environment.darknessLevel'] = base.env.darknessLevel;
  if (JSON.stringify(s._source.environment.globalLight) !== JSON.stringify(base.env.globalLight))
    patch['environment.globalLight'] = base.env.globalLight;
  if (Object.keys(patch).length) await s.update(patch);
  if (base.sky) {
    await s.unsetFlag(ns, 'sky');
    await s.setFlag(ns, 'sky', base.sky);
  }
  if (base.wind) {
    await s.unsetFlag(ns, 'wind');
    await s.setFlag(ns, 'wind', base.wind);
  }
  MapShine.setWeatherTargets?.(
    { cloudCover01: base.sky?.cloudCover01 ?? 0, precip01: base.sky?.precip01 ?? 0 },
    { immediate: true }
  );
  if (canvas.scene?.id === sceneId) MapShine.setTimeOfDay(base.sky?.todHour ?? 12, 0);
  MapShine.setDarknessRealism(base.realism);
  for (const id of forces) MapShine.forceEffect(id, null);
  if (typeof base.paused === 'boolean' && game.paused !== base.paused) game.togglePause(base.paused);
  return { hour: base.sky?.todHour ?? 12, darkness: s._source.environment.darknessLevel, paused: game.paused };
}

// ------------------------------------------------------------------------------------------- node side
async function setMeasure(page, measure, waitMs) {
  await page.evaluate(
    ({ off, measure }) => {
      for (const id of off) MapShine.forceEffect(id, measure ? false : null);
      // MSA's grid off hands the lines back to Foundry's own mesh (FRICTION #13): hide it in Measure view
      // and put back whatever it was afterwards (never force it on in the shipped view).
      const gm = canvas.interface?.grid?.mesh;
      if (gm && measure) {
        if (globalThis.__msaLabGridWas === undefined) globalThis.__msaLabGridWas = gm.visible;
        gm.visible = false;
      } else if (gm && globalThis.__msaLabGridWas !== undefined) {
        gm.visible = globalThis.__msaLabGridWas;
        delete globalThis.__msaLabGridWas;
      }
    },
    { off: MEASURE_OFF, measure }
  );
  // the nudge is the Lens-off workaround (mmp-78u.7); the shipped view never forces Lens off
  if (measure) await nudge(page);
  await page.waitForTimeout(waitMs);
}

/** mmp-78u.7 workaround: nudge the viewport so present rebinds to the live lit target. */
async function nudge(page) {
  const vp =
    page.viewportSize() ??
    (await page.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight })));
  await page.setViewportSize({ width: vp.width - 2, height: vp.height });
  await page.waitForTimeout(400);
  await page.setViewportSize(vp);
  await page.waitForTimeout(600);
}

async function shoot(page, file) {
  const style = await page.addStyleTag({ content: HIDE_UI });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  await style.evaluate((el) => el.remove());
}

const tmpShot = (view, cond, group) => path.join(TMP_DIR, view, `${cond}--${group}.png`);
const failShot = (id, cond, group, view) =>
  path.join(SHOT_DIR, `${id}--${cond}--${group.replace(/[@/]/g, '-')}${view === 'measure' ? '--measure' : ''}.png`);

function summarise(claims, results) {
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
  return summary;
}
const totals = (claims, results) => ({
  claims: claims.length,
  instances: results.length,
  pass: results.filter((r) => r.pass === true).length,
  fail: results.filter((r) => r.pass === false).length,
  skip: results.filter((r) => r.pass === null).length,
});

export async function checkInteriors({
  name,
  view = 'shipped',
  settleMs = 1200,
  waitMs = 6000,
  only = null,
  conditions = null,
  groups = null,
  merge = false,
  shots = true,
  keep = false,
  log = (s) => console.error(s),
}) {
  if (!name) throw new Error('check needs --name <cdp client>');
  if (merge && !conditions) throw new Error('--merge needs --conditions (the conditions to re-measure)');
  if (!['shipped', 'measure'].includes(view)) throw new Error(`unknown view ${view}`);
  const claims = INTERIORS_CLAIMS.filter((c) => !only || only.includes(c.id)).filter(
    (c) => !c.views || c.views.includes(view)
  );
  const plan = interiorsPlan(claims, { conditions, groups });
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort(name)}`);
  const t0 = Date.now();
  const sceneId = INTERIORS_IDS.scene;
  let page = null;
  let base = null;
  let measureOn = false;
  let edited = null;
  const D = {};
  const meta = {};
  try {
    page = browser
      .contexts()
      .flatMap((x) => x.pages())
      .find((p) => p.url().includes('/game'));
    if (!page) throw new Error('no /game page');
    base = await page.evaluate(pageSnapshot, { sceneId, ns: NS });
    if (!['localhost', '127.0.0.1'].includes(base.host))
      throw new Error(`refusing to run on ${base.host}: private rig only`);
    const repair = await page.evaluate(pageOverrideOffAndRepair, { sceneId, ns: NS, spec: specRegionBehaviours() });
    log(
      `[check] override was ${base.override.enabled ? 'ON' : 'off'} (${base.override.value}); repaired ${repair.repaired} behaviours`
    );
    meta.override = { ...base.override, repaired: repair.repaired };
    meta.realism = base.realism;
    await page.evaluate(pageView, { sceneId, levelId: LEVEL_IDS.ground });
    if (repair.repaired > 0 && base.viewedScene === sceneId) {
      // Region documents changed under a live view: redraw so every buffer starts clean (FRICTION #34).
      await page.evaluate(async () => {
        await canvas.draw();
        const t0 = Date.now();
        while (Date.now() - t0 < 180000 && !MapShine.getSceneReady?.()?.ready)
          await new Promise((r) => setTimeout(r, 500));
      });
    }
    await setMeasure(page, view === 'measure', waitMs);
    measureOn = view === 'measure';
    fs.rmSync(path.join(TMP_DIR, view), { recursive: true, force: true });

    for (const { cond, groups: gs } of plan) {
      try {
        await runCondition(cond, gs);
      } catch (err) {
        // a condition that cannot be set is recorded and skipped (its claims SKIP), never the end of the run
        log(`[check] ${cond.key}: FAILED (${String(err.message).split('\n')[0]})`);
        (meta.errors ??= []).push({ cond: cond.key, error: String(err.message).split('\n')[0] });
      }
    }
  } finally {
    await cleanup();
  }

  async function runCondition(cond, gs) {
    const tc = Date.now();
    if (!cond.external) await page.evaluate(pageView, { sceneId, levelId: LEVEL_IDS[cond.level ?? 'ground'] });
    const applied = await page.evaluate(pageApplyCondition, {
      sceneId,
      ns: NS,
      cond,
      base,
      forces: CONDITION_FORCES,
    });
    // let flag echoes, the darkness publish (250 ms) and Foundry's Region meshes land before any read;
    // weather conditions ask for longer (rain spawns over seconds)
    await page.waitForTimeout(cond.settleMs ?? 3000);
    let extraEnv = {};
    if (cond.edit) {
      const old = await page.evaluate(pageEditRegion, {
        sceneId,
        ns: NS,
        key: cond.edit.region,
        modifier: cond.edit.modifier,
      });
      edited = { key: cond.edit.region, old };
      await page.waitForTimeout(cond.edit.waitMs);
    }
    if (cond.override) {
      const on = await page.evaluate(pageOverrideOn, { sceneId, ns: NS });
      extraEnv = { overrideValue: on.value, overrideDocs: on.docs };
    }
    D[cond.key] = {};
    for (const g of gs) {
      if (g.sceneId) await page.evaluate(pageView, { sceneId: g.sceneId, levelId: g.levelId });
      const mode = cond.samples
        ? 'samples'
        : cond.series
          ? 'series'
          : cond.strike && cond.strike.group === g.key
            ? 'strike'
            : cond.edit
              ? 'prompt'
              : null;
      const extra = {
        samples: cond.samples,
        intervalMs: cond.intervalMs,
        series: cond.series,
        point: cond.strike?.point,
        reads: cond.strike?.reads,
        env: extraEnv,
      };
      // Measure view and the condition's forced effects are re-asserted in the page before every read;
      // the mmp-78u.7 viewport nudge goes before every group (manager note 2026-11-09: overrides drop
      // on any re-resolve, so a run-start Measure view is not trusted).
      const forces = {
        ...(view === 'measure' ? Object.fromEntries(MEASURE_OFF.map((id) => [id, false])) : {}),
        ...(cond.force ?? {}),
      };
      if (view === 'measure') await nudge(page);
      // the edit is read promptly (IR-60 is about promptness): no extra settle before the probe
      const args = {
        g,
        scale: g.scale,
        settleMs: cond.edit ? 0 : settleMs,
        mode,
        extra,
        forces,
        measure: view === 'measure',
      };
      // MapShine.probe once THREW (a render target without a texture, right after 13 Region rewrites under a
      // live view; FRICTION #42): retry once, then record the error and carry on, so one bad read can never
      // lose a whole run's data again.
      let r = null;
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        try {
          r = await page.evaluate(pageProbeGroup, args);
        } catch (err) {
          log(
            `[check] ${cond.key}/${g.key}: probe failed (${String(err.message).split('\n')[0]})${attempt ? '' : ', retrying'}`
          );
          if (!attempt) await page.waitForTimeout(3000);
          else (meta.errors ??= []).push({ cond: cond.key, group: g.key, error: String(err.message).split('\n')[0] });
        }
      }
      if (!r) continue;
      if (shots) await shoot(page, tmpShot(view, cond.key, g.key));
      D[cond.key][g.key] = r.rows;
      const off = Object.values(r.rows).filter((x) => !x.onScreen).length;
      if (off) log(`[check] ${cond.key}/${g.key}: ${off} point(s) off-screen`);
    }
    if (cond.edit && edited) {
      await page.evaluate(pageEditRegion, { sceneId, ns: NS, key: edited.key, modifier: edited.old });
      edited = null;
    }
    if (cond.override) {
      const again = await page.evaluate(pageOverrideOffAndRepair, {
        sceneId,
        ns: NS,
        spec: specRegionBehaviours(),
      });
      log(`[check] override measured; switched back off, repaired ${again.repaired}`);
    }
    if (cond.external) await page.evaluate(pageView, { sceneId, levelId: LEVEL_IDS.ground });
    meta[cond.key] = { applied, seconds: Math.round((Date.now() - tc) / 1000) };
    log(`[check] ${cond.key}: ${gs.length} group(s) in ${meta[cond.key].seconds} s`);
  }

  /** Put everything back, crash or not (FRICTION #30). */
  async function cleanup() {
    if (page) {
      const safe = async (what, fn) => {
        try {
          await fn();
        } catch (err) {
          log(`[check] could not restore ${what}: ${err.message}`);
        }
      };
      if (edited)
        await safe('the Region edit', () =>
          page.evaluate(pageEditRegion, { sceneId, ns: NS, key: edited.key, modifier: edited.old })
        );
      if (base) {
        await safe('the lab scene view', () => page.evaluate(pageView, { sceneId, levelId: LEVEL_IDS.ground }));
        await safe('the lab scene state', () =>
          page.evaluate(pageRestore, { sceneId, ns: NS, base, forces: CONDITION_FORCES })
        );
        if (measureOn && !keep) await safe('the Measure view', () => setMeasure(page, false, 1500));
        // Back to the scene that was viewed before (Lab · Effects if that was this one), THEN the override,
        // so switching it back on never rewrites the repaired lab Regions.
        const back = base.viewedScene && base.viewedScene !== sceneId ? base.viewedScene : IDS.effectsScene;
        const backLevel = base.viewedScene === back ? base.viewedLevel : null;
        await safe('the viewed scene', () => page.evaluate(pageView, { sceneId: back, levelId: backLevel }));
        await safe('the Region darkness override', () =>
          page.evaluate(pageOverrideRestore, { ns: NS, enabled: base.override.enabled })
        );
      }
    }
    await browser.close().catch(() => {});
  }

  let file = { family: 'interiors', views: {} };
  try {
    file = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
  } catch {
    // first run
  }
  // --merge: the conditions just measured replace the same conditions in the last FULL run of this view, and
  // every claim is judged again on the merged data (re-measure one condition after a fix without redoing all).
  const prevFull = merge ? file.views?.[view] : null;
  if (merge && !prevFull?.data) throw new Error(`--merge: no full ${view} run in ${OUT_JSON} to merge into`);
  const evalClaims = merge ? INTERIORS_CLAIMS.filter((c) => !c.views || c.views.includes(view)) : claims;
  const data = merge ? { ...prevFull.data } : D;
  if (merge) for (const [cond, groupsRead] of Object.entries(D)) data[cond] = { ...(data[cond] ?? {}), ...groupsRead };
  const results = evaluateInteriorsClaims(data, view, evalClaims);
  // Screenshots: every (condition, group) a failing claim read; stale shots of this view removed first
  // (a merge only replaces the shots of the conditions it re-measured).
  const suffix = view === 'measure' ? '--measure.png' : '.png';
  if (fs.existsSync(SHOT_DIR) && !merge) {
    for (const f of fs.readdirSync(SHOT_DIR)) {
      if (!f.startsWith('IR-')) continue;
      const isMeasure = f.endsWith('--measure.png');
      if ((view === 'measure') === isMeasure && f.endsWith(suffix) && !only && !conditions && !groups)
        fs.unlinkSync(path.join(SHOT_DIR, f));
    }
  }
  for (const r of results) {
    r.shots = [];
    for (const ref of r.refs) {
      const [cond, group] = ref.split('|');
      const dst = failShot(r.id, cond, group, view);
      const src = tmpShot(view, cond, group);
      if (r.pass === false && shots && fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      } else if (r.pass === true && fs.existsSync(dst)) {
        fs.unlinkSync(dst); // passes now: its old discrepancy shot goes (a SKIP keeps it)
      }
      if (r.pass === false && fs.existsSync(dst)) r.shots.push(path.relative(REPO, dst));
    }
  }
  fs.rmSync(path.join(TMP_DIR, view), { recursive: true, force: true });

  if (merge) {
    const block = {
      ...prevFull,
      mergedAt: new Date().toISOString(),
      merged: [...(prevFull.merged ?? []), { conditions: Object.keys(D), at: new Date().toISOString() }],
      meta: { ...(prevFull.meta ?? {}), ...meta },
      sources: claimSourceCounts(evalClaims),
      totals: totals(evalClaims, results),
      summary: summarise(evalClaims, results),
      results,
      claims: evalClaims.map(({ check: _check, needs: _needs, ...m }) => m),
      data,
    };
    file.updated = block.mergedAt;
    file.views = { ...(file.views ?? {}), [view]: block };
    fs.writeFileSync(OUT_JSON, JSON.stringify(file, null, 1));
    return { family: 'interiors', view: `${view}, merged ${Object.keys(D).join(',')}`, file: OUT_JSON, block };
  }

  const block = {
    at: new Date().toISOString(),
    seconds: Math.round((Date.now() - t0) / 1000),
    settings: { settleMs, only, conditions, groups },
    meta,
    sources: claimSourceCounts(claims),
    totals: totals(claims, results),
    summary: summarise(claims, results),
    results,
    claims: claims.map(({ check: _check, needs: _needs, ...m }) => m),
    data: D,
  };
  file.updated = block.at;
  const slot = only || conditions || groups ? `${view}-partial` : view;
  file.views = { ...(file.views ?? {}), [slot]: block };
  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(file, null, 1));
  return { family: 'interiors', view, file: OUT_JSON, block };
}

/** Re-judge the claims on the probe data saved by the last run of `view` (no rig): for correcting a claim. */
export function recheckInteriorsOffline({ view = 'shipped', only = null } = {}) {
  const file = JSON.parse(fs.readFileSync(OUT_JSON, 'utf8'));
  const prev = file.views?.[view];
  if (!prev?.data) throw new Error(`no saved ${view} run in ${OUT_JSON}`);
  const claims = INTERIORS_CLAIMS.filter((c) => !only || only.includes(c.id)).filter(
    (c) => !c.views || c.views.includes(view)
  );
  const results = evaluateInteriorsClaims(prev.data, view, claims).map((r) => ({
    ...r,
    shots: r.pass === false ? ((prev.results ?? []).find((p) => p.id === r.id)?.shots ?? []) : [],
  }));
  const block = {
    ...prev,
    rejudgedAt: new Date().toISOString(),
    sources: claimSourceCounts(claims),
    totals: totals(claims, results),
    summary: summarise(claims, results),
    results,
    claims: claims.map(({ check: _check, needs: _needs, ...m }) => m),
  };
  if (!only) {
    file.views[view] = block;
    file.updated = block.rejudgedAt;
    fs.writeFileSync(OUT_JSON, JSON.stringify(file, null, 1));
  }
  return { family: 'interiors', view: `${view}, re-judged offline`, file: OUT_JSON, block };
}
