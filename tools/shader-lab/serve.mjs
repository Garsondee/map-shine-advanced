/**
 * Shader Lab's static file server — no dependency, repo-root-relative, so the
 * page can import BOTH `/src/vendor/three/three.webgpu.js` (the vendored
 * WebGPU+TSL bundle) AND real `/src/effects/**` modules directly, unmodified.
 * `docs/planning/Shader-Lab.md` has the full design.
 *
 * ============================================================================
 * IT SERVES THREE THINGS, NOT ONE (2026-08-01, the Proving Ground plan)
 * ============================================================================
 * 1. **Static files** — the page, `/src/**`, and now `/example_map/**`, so a
 *    bench can `fetch()` a REAL authored mask through the REAL loader
 *    (`vt/mask-image.js`) instead of a synthetic DataTexture that is correct by
 *    construction and therefore cannot reproduce an authoring bug.
 * 2. **`GET /__lab/provenance`** — git SHA, branch, and the hash of every dirty
 *    file. A run report without this is unattributable: the author live-edits
 *    while agents work (`feedback_git_staging_hazard`), so "which code produced
 *    this number" is a question only the server can answer, and only at the
 *    moment the run happens.
 * 3. **`POST /__lab/artifact`** — the browser cannot write to disk, so evidence
 *    (report JSON, frame PNGs, generated WGSL) is POSTed back here and landed
 *    under `tools/shader-lab/runs/<runId>/`. Without this the lab can only ever
 *    tell one agent one number, once — nothing accumulates, nothing is
 *    reviewable, and nothing can be diffed against a golden later.
 *
 * ⚠️ DEV-ONLY, LOCALHOST-ONLY. It writes files where the browser asks it to.
 * Both path components are sanitised to `[A-Za-z0-9._-]` and re-checked against
 * the runs root after resolution, because "the only client is our own page" is
 * exactly the assumption that makes a traversal bug ship.
 *
 * Run: node tools/shader-lab/serve.mjs
 */
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = normalize(join(here, '..', '..'));
const runsRoot = normalize(join(here, 'runs'));
// `PORT` as well as the tool's own variable: the harness assigns a free port
// through `PORT` when two sessions want the lab at once, and a hardcoded 8934
// makes the second one simply fail to start.
const port = Number(process.env.SHADER_LAB_PORT || process.env.PORT || 8934);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  // ⚠️ THE IMAGE TYPES ARE LOAD-BEARING, NOT POLISH. `loadMaskImageTexture`
  // does `fetch → .blob() → createImageBitmap(blob)`, and `createImageBitmap`
  // decides how to decode from the BLOB'S MIME TYPE. Served as
  // `application/octet-stream` the decode throws, the real loader catches it,
  // logs, and returns `null` — which the bench would then have to report as
  // "no high-res mask" for a file that is present and perfectly valid.
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/** Anything that is not a safe single path segment. */
const UNSAFE_SEGMENT = /[^A-Za-z0-9._-]/;

/** @param {string} v @returns {boolean} */
function isSafeSegment(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 128 && !UNSAFE_SEGMENT.test(v) && v !== '.' && v !== '..';
}

/**
 * Run a git command, returning '' rather than throwing — provenance is
 * best-effort metadata and must never be the reason a run fails to record.
 * @param {string[]} args @returns {string}
 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10000 }).trim();
  } catch {
    return '';
  }
}

/**
 * THE PROVENANCE BLOCK. `git status --porcelain` names the dirty files; each
 * one is hashed so a report can be tied to the EXACT bytes that produced it.
 * A SHA alone is not enough when the tree is dirty, and this tree is always
 * dirty — that is the working condition, not an exception.
 * @returns {Promise<object>}
 */
async function buildProvenance() {
  const sha = git(['rev-parse', 'HEAD']);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelain = git(['status', '--porcelain']);
  const dirty = [];
  for (const line of porcelain.split('\n')) {
    const path = line.slice(3).trim();
    if (!path || path.endsWith('/')) continue;
    let hash = null;
    let bytes = null;
    try {
      const buf = await readFile(join(root, path));
      hash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
      bytes = buf.length;
    } catch {
      // Deleted, unreadable, or a directory rename — recorded as present-but-
      // unhashable rather than dropped, so the list still names it.
    }
    dirty.push({ status: line.slice(0, 2).trim(), path, hash, bytes });
  }
  let three = null;
  try {
    three = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).dependencies?.three ?? null;
  } catch {
    three = null;
  }
  return {
    gitSha: sha || null,
    gitBranch: branch || null,
    dirtyCount: dirty.length,
    dirty,
    threeVersion: three,
    serverTimeIso: new Date().toISOString(),
    repoRoot: root,
  };
}

/** @param {import('node:http').IncomingMessage} req @returns {Promise<Buffer>} */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      // 64 MB — a full-frame PNG at production drawing-buffer size is a few MB;
      // anything past this is a bug, not an artifact.
      if (total > 64 * 1024 * 1024) {
        reject(new Error('artifact too large (>64MB)'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/__lab/provenance') {
      const body = JSON.stringify(await buildProvenance(), null, 2);
      res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      res.end(body);
      return;
    }

    if (pathname === '/__lab/artifact' && req.method === 'POST') {
      const runId = url.searchParams.get('run');
      const file = url.searchParams.get('file');
      if (!isSafeSegment(runId) || !isSafeSegment(file)) {
        res.writeHead(400, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: 'run and file must each be a single [A-Za-z0-9._-] segment' }));
        return;
      }
      const target = normalize(join(runsRoot, runId, file));
      // Re-checked AFTER resolution, not merely validated before it.
      if (!target.startsWith(runsRoot)) {
        res.writeHead(403, { 'Content-Type': MIME['.json'] });
        res.end(JSON.stringify({ ok: false, error: 'resolved outside runs root' }));
        return;
      }
      const body = await readBody(req);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      res.writeHead(200, { 'Content-Type': MIME['.json'] });
      res.end(JSON.stringify({ ok: true, path: target, bytes: body.length }));
      return;
    }

    if (pathname === '/') pathname = '/tools/shader-lab/index.html';
    const filePath = normalize(join(root, pathname));
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('forbidden: outside repo root');
      return;
    }
    const data = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      // The page's own modules are edited constantly while a session runs;
      // a cached `lab.js` is the "stale code served to BOTH viewers" trap the
      // design doc warns about under `force: true`.
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(404);
    res.end(`not found: ${err.message}`);
  }
});

server.listen(port, () => {
  console.log(`Shader Lab serving ${root} at http://localhost:${port}/`);
  console.log(`  provenance: http://localhost:${port}/__lab/provenance`);
  console.log(`  artifacts -> ${runsRoot}`);
});
