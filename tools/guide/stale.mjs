#!/usr/bin/env node
/**
 * tools/guide/stale.mjs — which guide pictures may be out of date (mmp-0mv.24).
 *
 *   node tools/guide/stale.mjs            list pictures whose effect code changed since they were shot
 *   node tools/guide/stale.mjs --accept   record the current code as matching (after a re-shoot,
 *                                         or after checking the pictures still look right)
 *   node tools/guide/stale.mjs --accept id,id
 *
 * Each shot in guide/shots.json names the code its look depends on (`sources`: files or folders
 * under the module). guide/shots.lock.json keeps a fingerprint of that code from when the picture
 * was last shot or checked. A changed fingerprint means "look again": re-shoot with
 * tools/guide/shoot.mjs + crop.py, or --accept if the picture is still right.
 *
 * Deliberately a warning, not a build failure: a shader tweak should not block a push, but it
 * must be visible (the drift test prints the count).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(REPO, 'guide', 'shots.json');
const LOCK = path.join(REPO, 'guide', 'shots.lock.json');

function walk(abs, out) {
  const st = fs.statSync(abs, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isFile()) {
    out.push(abs);
    return;
  }
  for (const name of fs.readdirSync(abs).sort()) {
    if (name === '__tests__' || name.startsWith('.')) continue;
    walk(path.join(abs, name), out);
  }
}

/** Fingerprint of everything a shot's look depends on (line endings ignored). */
export function fingerprint(sources, repo = REPO) {
  const files = [];
  for (const s of sources ?? []) walk(path.join(repo, s), files);
  const h = createHash('sha256');
  for (const f of files) {
    h.update(path.relative(repo, f).replace(/\\/g, '/'));
    h.update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
  }
  return files.length ? h.digest('hex').slice(0, 16) : null;
}

export function readLock(file = LOCK) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/** @returns {Array<{id: string, status: 'ok'|'stale'|'unrecorded'|'no-sources'}>} */
export function staleReport(shots, lock, repo = REPO) {
  return shots.map((s) => {
    if (!s.sources?.length) return { id: s.id, status: 'no-sources' };
    const now = fingerprint(s.sources, repo);
    const was = lock[s.id]?.fingerprint;
    if (!was) return { id: s.id, status: 'unrecorded', now };
    return { id: s.id, status: was === now ? 'ok' : 'stale', now };
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const shots = JSON.parse(fs.readFileSync(SHOTS, 'utf8')).shots;
  const lock = readLock();
  const i = process.argv.indexOf('--accept');
  if (i >= 0) {
    const only =
      process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? new Set(process.argv[i + 1].split(',')) : null;
    for (const s of shots) {
      if (only && !only.has(s.id)) continue;
      const fp = fingerprint(s.sources);
      if (fp) lock[s.id] = { fingerprint: fp, accepted: new Date().toISOString().slice(0, 10) };
    }
    fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2) + '\n');
    console.log(`recorded ${only ? only.size : shots.length} shot(s) in guide/shots.lock.json`);
  } else {
    const rows = staleReport(shots, lock);
    const stale = rows.filter((r) => r.status === 'stale' || r.status === 'unrecorded');
    for (const r of rows) console.log(`${r.status.padEnd(11)} ${r.id}`);
    console.log(
      stale.length
        ? `\n${stale.length} picture(s) may be out of date: re-shoot (tools/guide/shoot.mjs + crop.py) or --accept.`
        : '\nAll guide pictures match their code.'
    );
  }
}
