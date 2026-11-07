#!/usr/bin/env node
/**
 * tools/test-world/make-test-world.mjs — build a private test rig and seed the MSA
 * Test World into it (mmp-f0k.4).
 *
 *   node tools/test-world/make-test-world.mjs rig  --from <existing rig dataPath> --to <new dataPath>
 *        [--port 30070] [--world map-development-world-2]
 *        Copies Config (licence) and the world, links every module/system/asset folder as a
 *        junction, and links map-shine-advanced to THIS checkout. Never touches the source rig
 *        or any live server.
 *   node tools/test-world/make-test-world.mjs seed --port <GM devtools port>
 *        With a GM client logged in (tools/foundry-cdp), creates or updates the test users and
 *        test scenes from fixture.mjs. Idempotent: documents are keyed by flags['map-shine-advanced'].testFixtureId.
 *   node tools/test-world/make-test-world.mjs neutral --port <GM devtools port> [--effects off|keep] [--weather clear|keep]
 *        Puts the rig into a clean state for lighting/parity captures: clear sky, no rain, no wind,
 *        and (with --effects off) every MSA effect's GM switch set to Off. The previous switch values
 *        are saved to tools/test-world/.neutral-restore.json; `restore --port N` puts them back.
 *   node tools/test-world/make-test-world.mjs start --to <dataPath> [--port 30070] [--world ...]
 *        Prints the command that starts that rig's Foundry server (run it in the background).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_USERS, blankScene, lightMatrix, TEST_MAP_SCENES, FLAT_GREY_SRC } from './fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(REPO, 'package.json'));

const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const out = (v) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');

function linkTarget(p) {
  try {
    return fs.readlinkSync(p);
  } catch {
    return p;
  }
}

function junction(target, at) {
  if (fs.existsSync(at)) return false;
  fs.symlinkSync(target, at, 'junction');
  return true;
}

function rig() {
  const from = opt('from');
  const to = opt('to');
  const port = Number(opt('port', 30070));
  const world = opt('world', 'map-development-world-2');
  if (!from || !to) throw new Error('rig needs --from <existing rig dataPath> and --to <new dataPath>');
  for (const d of ['Config', 'Data/modules', 'Data/systems', 'Data/worlds', 'Logs']) {
    fs.mkdirSync(path.join(to, d), { recursive: true });
  }
  fs.copyFileSync(path.join(from, 'Config', 'license.json'), path.join(to, 'Config', 'license.json'));
  const options = JSON.parse(fs.readFileSync(path.join(from, 'Config', 'options.json'), 'utf8'));
  options.dataPath = to.replaceAll('\\', '/');
  options.port = port;
  fs.writeFileSync(path.join(to, 'Config', 'options.json'), JSON.stringify(options, null, 2));
  let linked = 0;
  for (const kind of ['modules', 'systems']) {
    for (const name of fs.readdirSync(path.join(from, 'Data', kind))) {
      const src = path.join(from, 'Data', kind, name);
      if (!fs.statSync(src).isDirectory()) continue;
      const target = kind === 'modules' && name === 'map-shine-advanced' ? REPO : linkTarget(src);
      if (junction(target, path.join(to, 'Data', kind, name))) linked++;
    }
  }
  if (fs.existsSync(path.join(from, 'Data', 'assets'))) {
    junction(linkTarget(path.join(from, 'Data', 'assets')), path.join(to, 'Data', 'assets'));
  }
  const worldDst = path.join(to, 'Data', 'worlds', world);
  if (!fs.existsSync(worldDst)) {
    fs.cpSync(path.join(from, 'Data', 'worlds', world), worldDst, {
      recursive: true,
      filter: (src) => !src.endsWith('LOCK'),
    });
  }
  out({ rig: to, port, world, linked, msa: REPO });
}

function start() {
  const to = opt('to');
  const port = Number(opt('port', 30070));
  const world = opt('world', 'map-development-world-2');
  const fv = path.resolve(REPO, '..', 'foundryvttsourcecode_v14', 'Foundry Virtual Tabletop');
  out({
    command:
      `ELECTRON_RUN_AS_NODE=1 "${fv}/Foundry Virtual Tabletop.exe" tools/foundry-server-boot.mjs ` +
      `--foundry-app="${fv}/resources/app" --dataPath="${to}" --port=${port} --noupnp --world=${world}`,
  });
}

/** The in-page seeding script (runs as the GM). Pure data arrives as `args`. */
async function seedInPage(args) {
  const flagOf = (d) => d.flags?.['map-shine-advanced']?.testFixtureId;
  const report = { users: [], scenes: [], missingMaps: [] };
  for (const u of args.users) {
    const existing = game.users.find((x) => x.name === u.name);
    if (existing) {
      await existing.update({ role: u.role, password: u.password });
      report.users.push(`${u.name} updated`);
    } else {
      await CONFIG.User.documentClass.create({ name: u.name, role: u.role, password: u.password });
      report.users.push(`${u.name} created`);
    }
  }
  const upsertScene = async (data) => {
    const id = data.flags['map-shine-advanced'].testFixtureId;
    let scene = game.scenes.find((s) => flagOf(s) === id);
    if (scene) await scene.update(data);
    else scene = await Scene.create(data);
    // Foundry v14 keeps floor art on the scene's Level, not the scene: give the first
    // Level the fixture's flat grey floor so MSA has art to render.
    const level = scene.levels?.contents?.[0];
    if (level && level.background?.src !== args.floorSrc) await level.update({ background: { src: args.floorSrc } });
    return scene;
  };
  const blank = await upsertScene(args.blank);
  report.scenes.push({ name: blank.name, id: blank.id });
  const animationTypes = Object.keys(CONFIG.Canvas.lightAnimations ?? {});
  const lm = await upsertScene(args.matrixScene);
  // Replace the matrix's lights and labels wholesale (they are fixture-owned).
  const oldLights = lm.lights.filter((l) => flagOf(l)).map((l) => l.id);
  if (oldLights.length) await lm.deleteEmbeddedDocuments('AmbientLight', oldLights);
  const oldDrawings = lm.drawings.filter((d) => flagOf(d)).map((d) => d.id);
  if (oldDrawings.length) await lm.deleteEmbeddedDocuments('Drawing', oldDrawings);
  await lm.createEmbeddedDocuments('AmbientLight', args.lights);
  await lm.createEmbeddedDocuments('Drawing', args.labels);
  report.scenes.push({ name: lm.name, id: lm.id, lights: args.lights.length, animationTypes });
  for (const name of args.mapScenes) if (!game.scenes.getName(name)) report.missingMaps.push(name);
  return report;
}

async function seed() {
  const port = Number(opt('port'));
  if (!port) throw new Error('seed needs --port <GM devtools port>');
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('/game'));
    if (!page) throw new Error('no logged-in /game page on that port');
    const animationTypes = await page.evaluate(() => Object.keys(CONFIG.Canvas.lightAnimations ?? {}));
    const m = lightMatrix(animationTypes);
    const report = await page.evaluate(seedInPage, {
      users: TEST_USERS,
      blank: blankScene(),
      matrixScene: m.scene,
      lights: m.lights,
      labels: m.labels,
      mapScenes: TEST_MAP_SCENES,
      floorSrc: FLAT_GREY_SRC,
    });
    out(report);
  } finally {
    await browser.close().catch(() => {});
  }
}

const RESTORE_FILE = path.join(HERE, '.neutral-restore.json');

async function withGmPage(fn) {
  const port = Number(opt('port'));
  if (!port) throw new Error('needs --port <GM devtools port>');
  const { chromium } = require('playwright');
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  try {
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('/game'));
    if (!page) throw new Error('no logged-in /game page on that port');
    return await fn(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function neutral() {
  const effects = opt('effects', 'keep');
  const weather = opt('weather', 'clear');
  const res = await withGmPage((page) =>
    page.evaluate(
      async ({ effects, weather }) => {
        const keys = [...game.settings.settings.keys()].filter(
          (k) => k.startsWith('map-shine-advanced.') && k.endsWith('.gmEnable')
        );
        const before = {};
        for (const k of keys) before[k] = game.settings.get(...k.split(/\.(.+)/).slice(0, 2));
        if (effects === 'off') {
          for (const k of keys) await game.settings.set(...k.split(/\.(.+)/).slice(0, 2), 'off');
        }
        if (weather === 'clear') {
          MapShine.fadeWeatherToArchetype?.('clear', 0);
          await MapShine.setWeatherTargets?.({ precip01: 0 });
          await MapShine.setWind?.({ speed01: 0 });
        }
        return { before, effectsSwitched: effects === 'off' ? keys.length : 0, weather };
      },
      { effects, weather }
    )
  );
  if (effects === 'off' && !fs.existsSync(RESTORE_FILE))
    fs.writeFileSync(RESTORE_FILE, JSON.stringify(res.before, null, 2));
  out({
    effectsSwitched: res.effectsSwitched,
    weather: res.weather,
    restoreFile: effects === 'off' ? RESTORE_FILE : null,
  });
}

async function restore() {
  if (!fs.existsSync(RESTORE_FILE)) throw new Error('nothing to restore');
  const before = JSON.parse(fs.readFileSync(RESTORE_FILE, 'utf8'));
  await withGmPage((page) =>
    page.evaluate(async (before) => {
      for (const [k, v] of Object.entries(before)) await game.settings.set(...k.split(/\.(.+)/).slice(0, 2), v);
    }, before)
  );
  fs.unlinkSync(RESTORE_FILE);
  out({ restored: Object.keys(before).length });
}

const COMMANDS = { rig, seed, start, neutral, restore };
if (!COMMANDS[mode]) {
  process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0] + '*/\n');
  process.exit(mode ? 2 : 0);
}
Promise.resolve(COMMANDS[mode]()).catch((e) => {
  console.error('[test-world]', e?.message ?? e);
  process.exit(1);
});
