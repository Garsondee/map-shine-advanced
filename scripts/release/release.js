const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');
const readline = require('readline');

function parseArgs(argv) {
  const args = { force: false, keepStaging: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--version' || a === '-v') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error(`${a} requires a value (example: --version 0.1.4)`);
      }
      args.version = next;
      i++;
      continue;
    }
    if (a === '--force' || a === '-f') {
      args.force = true;
      continue;
    }
    if (a === '--keepStaging') {
      args.keepStaging = true;
      continue;
    }
    if (a === '--help' || a === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

function isValidVersion(v) {
  if (typeof v !== 'string') return false;
  return /^\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?$/.test(v);
}

async function pathExists(p) {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(p) {
  await fs.promises.mkdir(p, { recursive: true });
}

async function copyDir(src, dest) {
  await ensureDir(dest);
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isSymbolicLink()) {
      const link = await fs.promises.readlink(srcPath);
      await fs.promises.symlink(link, destPath);
    } else {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

function psQuote(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function runPowerShell(command) {
  const result = childProcess.spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { stdio: 'inherit' }
  );

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PowerShell failed with exit code ${result.status}`);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function printUsage() {
  console.log('Usage:');
  console.log('  node scripts/release/release.js --version <x.y.z> [--force] [--keepStaging]');
  console.log('  node scripts/release/release.js  (prompts for version)');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    process.exit(0);
  }

  if (!args.version) {
    if (!process.stdin.isTTY) {
      printUsage();
      throw new Error('No --version provided and stdin is not interactive.');
    }
    const input = (await prompt('Release version (e.g. 0.1.4): ')).trim();
    args.version = input;
  }

  if (!isValidVersion(args.version)) {
    throw new Error(`Invalid version: ${args.version}`);
  }

  const repoRoot = path.resolve(__dirname, '../..');
  const moduleJsonPath = path.join(repoRoot, 'module.json');
  const readmePath = path.join(repoRoot, 'README.md');

  const requiredDirs = ['scripts', 'styles', 'languages'].map((d) => path.join(repoRoot, d));
  for (const d of requiredDirs) {
    if (!(await pathExists(d))) throw new Error(`Missing required directory: ${d}`);
  }
  if (!(await pathExists(moduleJsonPath))) throw new Error(`Missing file: ${moduleJsonPath}`);
  if (!(await pathExists(readmePath))) throw new Error(`Missing file: ${readmePath}`);

  const moduleJsonRaw = await fs.promises.readFile(moduleJsonPath, 'utf8');
  const moduleData = JSON.parse(moduleJsonRaw);

  moduleData.version = args.version;
  if (typeof moduleData.url === 'string' && moduleData.url.length > 0) {
    const baseUrl = moduleData.url.replace(/\/+$/, '');
    moduleData.manifest = `${baseUrl}/releases/download/${args.version}/module.json`;
    moduleData.download = `${baseUrl}/releases/download/${args.version}/module.zip`;
  }

  await fs.promises.writeFile(moduleJsonPath, JSON.stringify(moduleData, null, 2) + '\n', 'utf8');

  const releaseDir = path.join(repoRoot, 'dist', 'releases', args.version);
  const zipPath = path.join(releaseDir, 'module.zip');
  const moduleJsonCopyPath = path.join(releaseDir, 'module.json');
  const checksumsPath = path.join(releaseDir, 'checksums.txt');
  const stagingDir = path.join(releaseDir, '_staging');

  if (await pathExists(releaseDir)) {
    if (!args.force) {
      throw new Error(`Release directory already exists: ${releaseDir} (use --force to overwrite)`);
    }
    await fs.promises.rm(releaseDir, { recursive: true, force: true });
  }

  await ensureDir(stagingDir);

  await fs.promises.copyFile(moduleJsonPath, path.join(stagingDir, 'module.json'));
  await fs.promises.copyFile(readmePath, path.join(stagingDir, 'README.md'));
  await copyDir(path.join(repoRoot, 'scripts'), path.join(stagingDir, 'scripts'));
  await copyDir(path.join(repoRoot, 'styles'), path.join(stagingDir, 'styles'));
  await copyDir(path.join(repoRoot, 'languages'), path.join(stagingDir, 'languages'));

  const compressCmd = `Compress-Archive -Path (Join-Path ${psQuote(stagingDir)} '*') -DestinationPath ${psQuote(zipPath)} -Force`;
  runPowerShell(compressCmd);

  await fs.promises.copyFile(moduleJsonPath, moduleJsonCopyPath);

  const zipHash = sha256File(zipPath);
  const checksumsText = `sha256  module.zip  ${zipHash}\n`;
  await fs.promises.writeFile(checksumsPath, checksumsText, 'utf8');

  if (!args.keepStaging) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  }

  console.log('Release created:');
  console.log(`- ${zipPath}`);
  console.log(`- ${moduleJsonCopyPath}`);
  console.log(`- ${checksumsPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
