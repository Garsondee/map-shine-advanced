#!/usr/bin/env node
/**
 * tools/lab/lab.mjs — drive the MSA Lab (mmp-78u).
 *
 *   node tools/lab/lab.mjs paint  [--out <dir>]            paint every floor image + mask (python)
 *   node tools/lab/lab.mjs deploy-rig --rig <dataPath>      copy the painted set into a private rig
 *   node tools/lab/lab.mjs seed   --name <cdp client>       build/replace the lab scenes as GM
 *   node tools/lab/lab.mjs look --name <client> --plot C1 [--level ground] [--view shipped|measure] [--scale 0.45]
 *        one look at one plot: pan, settle, clean shot, probe its named points, print a table
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
  fs.writeFileSync(jobPath, JSON.stringify(labPaintJob(version)));
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
  manifest: () => console.log(JSON.stringify(labManifest({ assetDir, version }), null, 2)),
};
if (!COMMANDS[mode]) {
  console.error(`usage: lab.mjs ${Object.keys(COMMANDS).join('|')} [...]`);
  process.exit(2);
}
await COMMANDS[mode]();
