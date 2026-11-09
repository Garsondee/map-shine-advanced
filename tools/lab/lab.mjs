#!/usr/bin/env node
/**
 * tools/lab/lab.mjs — drive the MSA Lab (mmp-78u).
 *
 *   node tools/lab/lab.mjs paint  [--out <dir>] [--only interiors] [--art-root <folder holding maps/>]
 *        paint every floor image + mask (python); Lab · Vegetation pastes crops of the author's art
 *   node tools/lab/lab.mjs deploy-rig --rig <dataPath>      copy the painted set into a private rig
 *   node tools/lab/lab.mjs seed   --name <cdp client>       build/replace the lab scenes as GM
 *   node tools/lab/lab.mjs look --name <client> --plot C1 [--level ground] [--view shipped|measure] [--scale 0.45]
 *        one look at one plot: pan, settle, clean shot, probe its named points, print a table
 *   node tools/lab/lab.mjs check --name <client> --family walls|interiors [--view shipped|measure] [--only A03,B02]
 *        [--walls window5,torch] [--lights torch]            (walls)
 *        [--conditions noon,half] [--groups R1,R2] [--merge] (interiors; --merge folds the re-measured
 *        conditions into the last full run of that view and re-judges every claim)
 *        [--no-shots] [--settle 1200] [--scale 0.8] [--keep] [--offline]
 *        (--offline re-judges the claims on the last run's saved probe data: no rig, no lock, no shots)
 *        measure every claim of a family (lab-check.mjs FAMILIES) under the rig lock: out/check-<family>.json,
 *        a console table, and a clean shot per failing cell in out/shots/discrepancies/
 *   node tools/lab/lab.mjs manifest                         print the manifest (debugging)
 *
 * The painted set lives in tools/lab/out/v<N>/ (git-ignored, regenerable). In Foundry it is
 * served from Data/assets/msa-lab/v<N>/ — a new folder per version, so a rebuild never swaps
 * files under someone looking at the old one. Oracle upload is a later command (round 9).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LAB_VERSION } from './lab-spec.mjs';
import { labManifestAll as labManifest, labPaintJobAll as labPaintJob } from './lab-index.mjs';
import { look } from './lab-look.mjs';
import { FAMILIES, printCheck } from './lab-check.mjs';
import { withRigLock } from './rig-lock.mjs';

/** Who holds the rig lock: --owner, else LAB_OWNER, else 'lab.mjs'. */
const OWNER = process.argv.includes('--owner')
  ? process.argv[process.argv.indexOf('--owner') + 1]
  : (process.env.LAB_OWNER ?? 'lab.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const mode = argv[0];
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const version = Number(opt('version', LAB_VERSION));
const outDir = path.resolve(opt('out', path.join(HERE, 'out', `v${version}`)));
const assetDir = opt('asset-dir', `assets/msa-lab/v${version}`);

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

function paint() {
  fs.mkdirSync(outDir, { recursive: true });
  const jobPath = path.join(outDir, 'paint-job.json');
  // --only <text>: paint just the images whose name contains it (e.g. --only interiors); the
  // full set takes minutes at real-map size, and an unchanged scene's files are already there.
  const job = labPaintJob(version);
  const only = opt('only');
  if (only) job.images = job.images.filter((i) => i.name.includes(only));
  if (!job.images.length) throw new Error(`paint: no image name contains '${only}'`);
  // `paste` ops crop the author's own art (Lab · Vegetation). Her maps live in the outer project
  // folder, never in this public repo: --art-root <folder holding maps/>, else MSA_ART_ROOT, else
  // the folder above the repo (true for the main checkout, not for a scratch worktree).
  const artRoot = path.resolve(opt('art-root', process.env.MSA_ART_ROOT ?? path.join(REPO, '..')));
  for (const im of job.images) for (const o of im.ops) if (o.op === 'paste') o.artRoot = artRoot;
  fs.writeFileSync(jobPath, JSON.stringify(job));
  const extra = argv.includes('--lossless-art') ? ['--lossless-art'] : [];
  run('python', ['-I', path.join(HERE, 'paint.py'), jobPath, outDir, ...extra]);
}

function deployRig() {
  const rig = opt('rig');
  if (!rig) throw new Error('deploy-rig needs --rig <dataPath>');
  const dst = path.join(rig, 'Data', ...assetDir.split('/'));
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(outDir)) {
    if (!f.endsWith('.webp') && !f.endsWith('.png')) continue;
    fs.copyFileSync(path.join(outDir, f), path.join(dst, f));
    n++;
  }
  console.log(JSON.stringify({ copied: n, to: dst }));
}

function seed() {
  const name = opt('name');
  if (!name) throw new Error('seed needs --name <cdp client>');
  const builder = fs.readFileSync(path.join(HERE, 'build-in-foundry.js'), 'utf8');
  const manifest = labManifest({ assetDir, version });
  const body = `${builder}\nconst manifest = ${JSON.stringify(manifest)};\nreturn await buildLab(manifest);\n`;
  const tmp = path.join(outDir, 'seed-script.js');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(tmp, body);
  run('node', [path.join(REPO, 'tools', 'foundry-cdp', 'cdp.mjs'), 'eval', '--name', name, '--file', tmp]);
}

const COMMANDS = {
  paint,
  'deploy-rig': deployRig,
  seed: () => withRigLock(OWNER, async () => seed()),
  look: async () => {
    const r = await withRigLock(OWNER, () =>
      look({
        name: opt('name'),
        plot: opt('plot'),
        level: opt('level'),
        view: opt('view', 'shipped'),
        scale: Number(opt('scale', 0.45)),
        waitMs: Number(opt('wait', 6000)),
        keep: argv.includes('--keep'),
      })
    );
    console.log(`${r.plot} on ${r.level} (${r.view}) settled=${r.settled} verdict=${r.verdict} -> ${r.shot}`);
    console.table(r.table);
  },
  check: async () => {
    const family = opt('family', 'walls');
    const fam = FAMILIES[family];
    if (!fam) throw new Error(`check: no family '${family}' (have: ${Object.keys(FAMILIES).join(', ')})`);
    const list = (k) => (opt(k) ? opt(k).split(',') : null);
    if (argv.includes('--offline')) {
      // re-judge the claims on the last run's saved probe data (no rig, no lock)
      printCheck({ family, ...fam.offline({ view: opt('view', 'shipped'), only: list('only') }) });
      return;
    }
    const r = await withRigLock(
      OWNER,
      () =>
        fam.run({
          name: opt('name'),
          view: opt('view', 'shipped'),
          scale: Number(opt('scale', 0.8)),
          settleMs: Number(opt('settle', 1200)),
          waitMs: Number(opt('wait', 6000)),
          only: list('only'),
          walls: list('walls'),
          lights: list('lights'),
          conditions: list('conditions'),
          groups: list('groups'),
          merge: argv.includes('--merge'),
          shots: !argv.includes('--no-shots'),
          keep: argv.includes('--keep'),
        }),
      { waitMin: 60 }
    );
    printCheck({ family, ...r });
  },
  manifest: () => console.log(JSON.stringify(labManifest({ assetDir, version }), null, 2)),
};
if (!COMMANDS[mode]) {
  console.error(`usage: lab.mjs ${Object.keys(COMMANDS).join('|')} [...]`);
  process.exit(2);
}
await COMMANDS[mode]();
