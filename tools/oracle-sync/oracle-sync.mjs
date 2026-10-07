/**
 * Keeps this repo's Foundry module folder and the Oracle server's copy in
 * step: verified, atomic, one-way (local -> server).
 *
 *   node tools/oracle-sync/oracle-sync.mjs status        # compare, send nothing
 *   node tools/oracle-sync/oracle-sync.mjs push          # send what differs, verify
 *   node tools/oracle-sync/oracle-sync.mjs push --dry-run
 *   node tools/oracle-sync/oracle-sync.mjs watch         # push now, then on every local save
 *   node tools/oracle-sync/oracle-sync.mjs info          # how to reach the server (for other sessions)
 *   node tools/oracle-sync/oracle-sync.mjs exec "<cmd>"  # run one command on the server
 *
 * Connection details (host, user, key, pinned host-key fingerprint) live in
 * `oracle-sync.config.json` beside this file — GITIGNORED, because this repo is
 * public. `oracle-sync.config.example.json` shows the shape.
 *
 * WHAT IT GUARANTEES
 *  - Verified: after every upload both sides are re-hashed (SHA-256) and any
 *    mismatch fails the run. "The copy exited 0" is never taken as proof.
 *  - Atomic per file: files land in a staging dir on the server and are
 *    `mv`-ed into place, so Foundry (and a connected player) can never fetch a
 *    half-written file.
 *  - Never a broken module: before anything is sent, changed JS/JSON is
 *    checked (JS parses, relative imports exist, module.json names only files
 *    that exist). A failing file blocks the whole push, not just itself —
 *    pushing a subset is how Blank Inheritance once broke its live server.
 *    module.json is always uploaded last.
 *  - Never deletes: a file removed locally is REPORTED, not removed remotely.
 *  - One connection per phase (psftp batch), not one per file.
 *
 * Only this file touches PuTTY, the network or the disk; the rules live in
 * oracle-sync-core.mjs and are unit-tested.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { unlinkSync, watch } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  SYNC_ROOTS,
  assertSafeRelPath,
  dependenciesOf,
  diffManifests,
  formatBytes,
  formatProblems,
  normalizeRel,
  orderForUpload,
  parseSha256Lines,
  preflightText,
  shouldSync,
} from './oracle-sync-core.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const CONFIG_PATH = path.join(here, 'oracle-sync.config.json');
const LOCK_PATH = path.join(here, 'oracle-sync.watch.lock');
const DEBOUNCE_MS = 1500;

// ── config ──────────────────────────────────────────────────────────────────

async function loadConfig() {
  let raw;
  try {
    raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(
      `Cannot read ${CONFIG_PATH} (${err.code ?? err.message}).\n` +
        `Copy oracle-sync.config.example.json to oracle-sync.config.json and fill it in.`
    );
  }
  const need = ['host', 'user', 'hostKey', 'remoteModuleDir'];
  const missing = need.filter((k) => !raw[k]);
  if (missing.length) throw new Error(`oracle-sync.config.json is missing: ${missing.join(', ')}`);
  const puttyDir = raw.puttyDir ?? 'C:\\Program Files\\PuTTY';
  const keyPath = raw.keyPath ? path.resolve(repoRoot, raw.keyPath) : path.resolve(repoRoot, '..', 'SSH.ppk');
  const cfg = {
    host: raw.host,
    user: raw.user,
    port: raw.port ?? 22,
    hostKey: raw.hostKey,
    keyPath,
    remoteModuleDir: raw.remoteModuleDir.replace(/\/+$/, ''),
    remoteStagingDir: (raw.remoteStagingDir ?? '/home/ubuntu/foundrydata/.msa-upload-staging').replace(/\/+$/, ''),
    plink: path.join(puttyDir, 'plink.exe'),
    psftp: path.join(puttyDir, 'psftp.exe'),
  };
  // Both remote paths get single-quoted into shell scripts and the staging one is `rm -rf`-ed:
  // refuse anything that is not an absolute, quote-free path of the expected shape.
  for (const [name, dir, suffix] of [
    ['remoteModuleDir', cfg.remoteModuleDir, '/modules/map-shine-advanced'],
    ['remoteStagingDir', cfg.remoteStagingDir, '.msa-upload-staging'],
  ]) {
    if (!dir.startsWith('/') || /['"`$\\]|\.\./.test(dir) || !dir.endsWith(suffix)) {
      throw new Error(`oracle-sync.config.json: ${name} "${dir}" must be absolute, quote-free and end in "${suffix}"`);
    }
  }
  return cfg;
}

// ── PuTTY wrappers (execFile + argument arrays: no shell, nothing to mis-quote) ──

function sshArgs(cfg) {
  return ['-batch', '-hostkey', cfg.hostKey, '-i', cfg.keyPath, '-P', String(cfg.port)];
}

/** Run a shell script on the server (written to a temp file, sent with plink -m). */
async function runRemoteScript(cfg, script) {
  const dir = await mkdtemp(path.join(tmpdir(), 'oracle-sync-'));
  const file = path.join(dir, 'script.sh');
  try {
    await writeFile(file, script.replace(/\r\n/g, '\n'), 'utf8');
    const { stdout } = await execFileAsync(
      cfg.plink,
      ['-ssh', ...sshArgs(cfg), '-m', file, `${cfg.user}@${cfg.host}`],
      { maxBuffer: 256 * 1024 * 1024 }
    );
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** sha256 of the named repo-relative files as they exist on the server. */
async function remoteHashes(cfg, rels) {
  if (!rels.length) return new Map();
  const quoted = rels.map((r) => `'${assertSafeRelPath(r)}'`);
  // Chunked only to keep each generated line sane; they all go in ONE script/connection.
  const lines = [`cd '${cfg.remoteModuleDir}' || exit 1`];
  for (let i = 0; i < quoted.length; i += 50) {
    lines.push(`sha256sum -- ${quoted.slice(i, i + 50).join(' ')} 2>/dev/null || true`);
  }
  return parseSha256Lines(await runRemoteScript(cfg, lines.join('\n')));
}

/** sha256 of EVERY file under the sync roots on the server (for `status`/initial compare). */
async function remoteManifest(cfg) {
  const roots = SYNC_ROOTS.map((r) => `'${r}'`).join(' ');
  const script = [
    `cd '${cfg.remoteModuleDir}' || exit 1`,
    `find ${roots} -type f -print0 2>/dev/null | xargs -0 -r sha256sum --`,
  ].join('\n');
  const all = parseSha256Lines(await runRemoteScript(cfg, script));
  // Apply the same filter the local side uses, so server-only junk/excluded files
  // do not show up as "only on the server".
  return new Map([...all].filter(([rel]) => shouldSync(rel)));
}

// ── local side ──────────────────────────────────────────────────────────────

async function walk(dirAbs, relBase, out) {
  let entries;
  try {
    entries = await readdir(dirAbs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    if (e.isDirectory()) await walk(path.join(dirAbs, e.name), rel, out);
    else if (e.isFile() && shouldSync(rel)) out.push(rel);
  }
}

async function hashFile(rel) {
  return createHash('sha256')
    .update(await readFile(path.join(repoRoot, rel)))
    .digest('hex');
}

async function localManifest() {
  const files = [];
  for (const root of SYNC_ROOTS) {
    const abs = path.join(repoRoot, root);
    const s = await stat(abs).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) await walk(abs, root, files);
    else if (shouldSync(root)) files.push(root);
  }
  const map = new Map();
  for (const rel of files.sort()) map.set(rel, await hashFile(rel));
  return map;
}

async function existsLocal(rel) {
  return (await stat(path.join(repoRoot, rel)).catch(() => null)) !== null;
}

// ── preflight ───────────────────────────────────────────────────────────────

/** @returns {Promise<Map<string,string[]>>} file -> problems, only files with problems */
async function preflight(rels) {
  const failures = new Map();
  for (const rel of rels) {
    if (!/\.(json|m?js)$/.test(rel)) continue;
    const text = await readFile(path.join(repoRoot, rel), 'utf8');
    // The core is I/O-free: ask the disk about exactly the files this one depends on, then hand it the answers.
    const present = new Set();
    for (const { target } of dependenciesOf(rel, text)) if (await existsLocal(target)) present.add(target);
    const problems = preflightText(rel, text, (r) => present.has(r));
    if (/\.m?js$/.test(rel)) {
      try {
        await execFileAsync(process.execPath, ['--check', path.join(repoRoot, rel)]);
      } catch (err) {
        const msg =
          String(err.stderr ?? err.message)
            .split('\n')
            .find((l) => /Error/.test(l)) ?? 'syntax error';
        problems.push(`${rel}: does not parse (${msg.trim()})`);
      }
    }
    if (problems.length) failures.set(rel, problems);
  }
  return failures;
}

// ── push ────────────────────────────────────────────────────────────────────

function stamp() {
  return new Date().toLocaleTimeString('en-GB');
}
const log = (...a) => console.log(`[${stamp()}]`, ...a);

/**
 * Upload exactly `rels` (already filtered/ordered), verify, report.
 * @returns {Promise<{ok: boolean, sent: number, bytes: number}>}
 */
async function uploadAndVerify(cfg, rels) {
  const ordered = orderForUpload(rels).map(assertSafeRelPath);
  const sizes = new Map();
  for (const rel of ordered) sizes.set(rel, (await stat(path.join(repoRoot, rel))).size);
  const bytes = [...sizes.values()].reduce((a, b) => a + b, 0);

  // 1. Fresh staging dir + every destination dir, one connection.
  const dirs = new Set();
  for (const rel of ordered) {
    dirs.add(path.posix.dirname(`${cfg.remoteStagingDir}/${rel}`));
    dirs.add(path.posix.dirname(`${cfg.remoteModuleDir}/${rel}`));
  }
  await runRemoteScript(
    cfg,
    [`rm -rf '${cfg.remoteStagingDir}'`, ...[...dirs].sort().map((d) => `mkdir -p '${d}'`)].join('\n')
  );

  // 2. Upload everything into staging, ONE psftp connection (file-by-file `put`, never a recursive copy).
  const dir = await mkdtemp(path.join(tmpdir(), 'oracle-sync-'));
  try {
    const batch = path.join(dir, 'put.batch');
    const lines = [`lcd "${repoRoot}"`];
    for (const rel of ordered) lines.push(`put "${rel.replace(/\//g, '\\')}" "${cfg.remoteStagingDir}/${rel}"`);
    await writeFile(batch, lines.join('\n') + '\n', 'utf8');
    await execFileAsync(cfg.psftp, [...sshArgs(cfg), '-b', batch, `${cfg.user}@${cfg.host}`], {
      maxBuffer: 256 * 1024 * 1024,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  // 3. Atomic move into place (module.json last — it is last in `ordered`), then re-hash the destinations.
  const moves = ordered.map((rel) => `mv -f -- '${cfg.remoteStagingDir}/${rel}' '${cfg.remoteModuleDir}/${rel}'`);
  const script = [
    'set -e',
    ...moves,
    `rm -rf '${cfg.remoteStagingDir}'`,
    `cd '${cfg.remoteModuleDir}'`,
    'set +e',
    ...Array.from(
      { length: Math.ceil(ordered.length / 50) },
      (_, i) =>
        `sha256sum -- ${ordered
          .slice(i * 50, i * 50 + 50)
          .map((r) => `'${r}'`)
          .join(' ')}`
    ),
  ].join('\n');
  const remote = parseSha256Lines(await runRemoteScript(cfg, script));

  let bad = 0;
  for (const rel of ordered) {
    const want = await hashFile(rel);
    if (remote.get(rel) !== want) {
      bad++;
      log(
        `  ✗ VERIFY FAILED ${rel} (server ${remote.get(rel)?.slice(0, 12) ?? 'missing'} ≠ local ${want.slice(0, 12)})`
      );
    }
  }
  return { ok: bad === 0, sent: ordered.length, bytes };
}

async function compare(cfg) {
  const [local, remote] = await Promise.all([localManifest(), remoteManifest(cfg)]);
  return { local, remote, diff: diffManifests(local, remote) };
}

function printDiff(diff, local) {
  const show = (title, list) => {
    if (!list.length) return;
    console.log(`  ${title} (${list.length}):`);
    for (const r of list.slice(0, 15)) console.log(`    ${r}`);
    if (list.length > 15) console.log(`    … and ${list.length - 15} more`);
  };
  console.log(`  identical: ${diff.same.length} / ${local.size} local files`);
  show('changed locally, differs on server', diff.changed);
  show('new locally, missing on server', diff.added);
  show('on the server only (NOT deleted — see --prune note in README)', diff.onlyRemote);
}

async function pushDiff(cfg, { dryRun = false, noPreflight = false } = {}) {
  const t0 = Date.now();
  const { local, diff } = await compare(cfg);
  const toSend = orderForUpload([...diff.changed, ...diff.added]);
  log(`compared ${local.size} local files with the server in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  printDiff(diff, local);
  if (!toSend.length) {
    log('✓ server is already up to date');
    return true;
  }
  if (dryRun) {
    log(`dry run: would send ${toSend.length} file(s); nothing sent`);
    return true;
  }
  if (!noPreflight) {
    const failures = await preflight(toSend);
    if (failures.size) {
      console.error(
        `\n✗ PREFLIGHT FAILED — nothing was sent (a partial push could break the module):\n${formatProblems(failures)}\n`
      );
      return false;
    }
  }
  log(`uploading ${toSend.length} file(s)…`);
  const res = await uploadAndVerify(cfg, toSend);
  if (res.ok) {
    log(
      `✓ ${res.sent} file(s), ${formatBytes(res.bytes)} uploaded and verified by SHA-256 in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    log('  Reload Foundry in the browser (F5) to pick up the new code.');
  } else {
    log('✗ upload finished but verification FAILED — see lines above; re-run `push`.');
  }
  return res.ok;
}

// ── watch ───────────────────────────────────────────────────────────────────

/**
 * Single-instance guard: a heartbeat file, not a bare PID (a PID recycled by an
 * unrelated process after a crash would otherwise lock the watcher out forever).
 * Fresh = touched within the last 90s; the watcher rewrites it every 30s.
 * @returns {Promise<{pid: number, since: string}|null>} the live watcher, if any
 */
async function liveWatcher() {
  try {
    const [s, text] = await Promise.all([stat(LOCK_PATH), readFile(LOCK_PATH, 'utf8')]);
    if (Date.now() - s.mtimeMs > 90_000) return null;
    const { pid, since } = JSON.parse(text);
    return { pid, since };
  } catch {
    return null;
  }
}

async function watchMode(cfg, flags) {
  const other = await liveWatcher();
  if (other && other.pid !== process.pid) {
    log(`a watcher is already running (pid ${other.pid}, since ${other.since}) — not starting a second one.`);
    return;
  }
  const since = new Date().toISOString();
  const beat = () => writeFile(LOCK_PATH, JSON.stringify({ pid: process.pid, since }), 'utf8').catch(() => {});
  await beat();
  setInterval(beat, 30_000).unref();
  const release = () => {
    try {
      unlinkSync(LOCK_PATH);
    } catch {
      /* already gone */
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));

  if (!flags.noInitial) await pushDiff(cfg, flags).catch((err) => log('initial push failed:', err.message));
  const pending = new Set();
  let timer = null;
  let running = false;
  let again = false;

  const flush = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    let inFlight = [];
    try {
      do {
        again = false;
        const rels = [...pending].filter((r) => shouldSync(r));
        inFlight = rels;
        pending.clear();
        // Only files that still exist; a local delete is reported, never mirrored.
        const present = [];
        for (const r of rels) {
          const s = await stat(path.join(repoRoot, r)).catch(() => null);
          if (!s) log(`  (deleted locally, left on the server: ${r})`);
          // A DIRECTORY is not a file: on Windows, a recursive watch also reports the PARENT directory when a file
          // inside it is replaced by a temp-write + rename (which is how editors and Claude Code save). Hashing it
          // threw EISDIR, the batch was re-queued with the directory still in it, and the watcher sat in an endless
          // retry loop that never uploaded anything (2026-10-07).
          else if (s.isFile()) present.push(r);
        }
        if (!present.length) continue;
        // Hash-compare first so a save that did not change content (formatters, touch) sends nothing.
        const serverHashes = await remoteHashes(cfg, present);
        const dirty = [];
        for (const r of present) if (serverHashes.get(r) !== (await hashFile(r))) dirty.push(r);
        if (!dirty.length) continue;
        log(
          `change detected: ${dirty.length} file(s) — ${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}`
        );
        if (!flags.noPreflight) {
          const failures = await preflight(dirty);
          if (failures.size) {
            console.error(
              `✗ NOT uploaded (preflight):\n${formatProblems(failures)}\n  Fix and save again — it will retry.`
            );
            for (const r of dirty) pending.add(r); // keep them queued for the next save
            continue;
          }
        }
        const res = await uploadAndVerify(cfg, dirty);
        log(
          res.ok
            ? `✓ synced ${res.sent} file(s), ${formatBytes(res.bytes)} (verified)`
            : '✗ verification failed; will retry on next save'
        );
        if (!res.ok) for (const r of dirty) pending.add(r);
      } while (again);
    } catch (err) {
      // A network blip must not silently drop the batch: re-queue it and try again shortly.
      log('✗ sync error (will retry in 15s):', err.message.split('\n')[0]);
      for (const r of inFlight) pending.add(r);
      setTimeout(flush, 15_000);
    } finally {
      running = false;
    }
  };

  const schedule = (rel) => {
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  };

  // Watch only the sync roots (never .git / node_modules), each recursively; module.json is a lone file in the repo root.
  for (const root of SYNC_ROOTS) {
    const abs = path.join(repoRoot, root);
    const s = await stat(abs).catch(() => null);
    if (!s?.isDirectory()) continue;
    watch(abs, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = normalizeRel(`${root}/${filename}`);
      if (shouldSync(rel)) schedule(rel);
    });
  }
  watch(repoRoot, (_event, filename) => {
    if (filename === 'module.json') schedule('module.json');
  });
  log(`watching ${repoRoot} → ${cfg.user}@${cfg.host}:${cfg.remoteModuleDir}`);
  log('Ctrl+C to stop. Saves are batched for 1.5s, verified, then moved into place atomically.');
  await new Promise(() => {}); // run until killed
}

// ── info / exec / main ──────────────────────────────────────────────────────

async function printInfo(cfg) {
  const key = cfg.keyPath;
  const w = await liveWatcher();
  console.log(`Oracle server (Foundry host)
  auto-sync       ${w ? `RUNNING (watcher pid ${w.pid}, since ${w.since}) — every local save is uploaded` : 'NOT running — start it: node tools/oracle-sync/oracle-sync.mjs watch'}
  host            ${cfg.host}   port ${cfg.port}   user ${cfg.user}
  key             ${key}   (PuTTY .ppk, no passphrase)
  host-key (pin)  ${cfg.hostKey}   (ssh-ed25519)
  module folder   ${cfg.remoteModuleDir}
  staging folder  ${cfg.remoteStagingDir}

Run a command:
  "${cfg.plink}" -ssh -batch -hostkey ${cfg.hostKey} -i "${key}" ${cfg.user}@${cfg.host} "<command>"
  (or: node tools/oracle-sync/oracle-sync.mjs exec "<command>")
Foundry service:   sudo systemctl status|restart foundryvtt     (passwordless sudo is enabled)
Do NOT use Windows' bundled ssh.exe — its old KEX list cannot negotiate with this server; use PuTTY's plink/pscp/psftp.`);
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const flags = {
    dryRun: rest.includes('--dry-run'),
    noPreflight: rest.includes('--no-preflight'),
    noInitial: rest.includes('--no-initial'),
  };
  if (command === 'help' || command === '--help') {
    console.log(
      'usage: oracle-sync.mjs <status|push|watch|info|exec "<cmd>"> [--dry-run] [--no-preflight] [--no-initial]'
    );
    return 0;
  }
  const cfg = await loadConfig();
  if (command === 'info') {
    await printInfo(cfg);
    return 0;
  }
  if (command === 'exec') {
    const cmd = rest.filter((a) => !a.startsWith('--')).join(' ');
    if (!cmd) throw new Error('exec needs a command');
    process.stdout.write(await runRemoteScript(cfg, cmd));
    return 0;
  }
  if (command === 'status') {
    const { local, diff } = await compare(cfg);
    printDiff(diff, local);
    const drift = diff.changed.length + diff.added.length;
    console.log(drift ? `\n${drift} file(s) need pushing.` : '\n✓ server matches local.');
    return drift ? 1 : 0;
  }
  if (command === 'push') return (await pushDiff(cfg, flags)) ? 0 : 1;
  if (command === 'watch') {
    await watchMode(cfg, flags);
    return 0;
  }
  throw new Error(`unknown command "${command}"`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`✗ ${err.message}`);
    process.exit(2);
  }
);
