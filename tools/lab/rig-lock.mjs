#!/usr/bin/env node
/**
 * tools/lab/rig-lock.mjs — one owner at a time for the lab rig (mmp-78u).
 *
 * WHY: the lab rig is ONE Foundry server with ONE GM client, and a client views one scene at a
 * time. Time of day, weather, forceEffect, camera and scene views all act on whatever that client
 * shows, so two agents driving it at once corrupt each other's readings (and a second Foundry per
 * agent doubles the GPU load and drifts out of step). Every command that touches the rig runs
 * under this lock; others wait their turn.
 *
 *   node tools/lab/rig-lock.mjs status
 *   node tools/lab/rig-lock.mjs exec --owner <name> [--wait-min 30] -- <command...>
 *   node tools/lab/rig-lock.mjs release --force          (clear a lock left by a dead process)
 *
 * The lock is a file (tools/lab/out/rig.lock) created atomically ('wx'). It is stale when its
 * process is gone or it is older than its TTL (default 45 min); a stale lock is taken over.
 * lab.mjs seed/look take it themselves (withRigLock), so a bare `lab.mjs look` is safe too.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOCK_FILE = path.join(HERE, 'out', 'rig.lock');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function stale(lock) {
  if (!lock) return true;
  if (!alive(lock.pid)) return true;
  return Date.now() - lock.since > (lock.ttlMs ?? 45 * 60000);
}

/** Try once. Returns true if we now hold the lock. */
export function tryAcquire(owner, ttlMs = 45 * 60000) {
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  const body = JSON.stringify({ owner, pid: process.pid, since: Date.now(), ttlMs });
  try {
    fs.writeFileSync(LOCK_FILE, body, { flag: 'wx' });
    return true;
  } catch {
    const cur = readLock();
    if (cur && cur.pid === process.pid) return true; // re-entrant within one process
    if (stale(cur)) {
      try {
        fs.unlinkSync(LOCK_FILE);
      } catch {
        // someone else took it over first
      }
      try {
        fs.writeFileSync(LOCK_FILE, body, { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

export function release() {
  const cur = readLock();
  if (cur && cur.pid === process.pid) fs.unlinkSync(LOCK_FILE);
}

/** Run `fn` holding the lock; waits up to waitMin minutes for it. */
export async function withRigLock(owner, fn, { waitMin = 30 } = {}) {
  const reentrant = readLock()?.pid === process.pid; // an outer call in this process already holds it
  const t0 = Date.now();
  let told = false;
  while (!tryAcquire(owner)) {
    if (!told) {
      const cur = readLock();
      console.error(
        `[rig-lock] waiting: rig held by ${cur?.owner} (pid ${cur?.pid}) since ${new Date(cur?.since).toISOString()}`
      );
      told = true;
    }
    if (Date.now() - t0 > waitMin * 60000) throw new Error(`[rig-lock] gave up after ${waitMin} min`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  try {
    return await fn();
  } finally {
    if (!reentrant) release();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  const opt = (k, d) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
  };
  if (mode === 'status') {
    const cur = readLock();
    console.log(
      JSON.stringify(
        cur ? { ...cur, stale: stale(cur), ageMin: +((Date.now() - cur.since) / 60000).toFixed(1) } : { free: true }
      )
    );
    return;
  }
  if (mode === 'release') {
    if (argv.includes('--force') && fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
    else release();
    console.log('released');
    return;
  }
  if (mode === 'exec') {
    const sep = argv.indexOf('--');
    if (sep < 0) throw new Error('exec needs -- <command...>');
    const owner = opt('owner', 'anon');
    const [cmd, ...args] = argv.slice(sep + 1);
    const status = await withRigLock(
      owner,
      async () => spawnSync(cmd, args, { stdio: 'inherit', shell: false }).status ?? 1,
      { waitMin: Number(opt('wait-min', 30)) }
    );
    process.exit(status);
  }
  console.error('usage: rig-lock.mjs status | exec --owner <name> -- <cmd...> | release [--force]');
  process.exit(2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
