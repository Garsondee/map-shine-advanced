/**
 * Pure logic for tools/oracle-sync — no network, no filesystem, no child
 * processes, so every rule here is unit-tested (oracle-sync-core.test.mjs).
 * The CLI (oracle-sync.mjs) is the only file that touches PuTTY or the disk.
 *
 * The rules were not invented here: they are the lessons the sibling Blank
 * Inheritance project's own module-sync learned the hard way (its README,
 * "Why one command"): never push a subset that leaves module.json naming a
 * file the server lacks, upload file by file rather than a recursive copy,
 * and never trust "the copy exited 0" — re-hash both sides.
 *
 * @module tools/oracle-sync/oracle-sync-core
 */

/** Top-level entries of the repo that make up the installed module. Everything
 * else (.git, node_modules, tools, tests, docs, perf traces) stays local. */
export const SYNC_ROOTS = ['module.json', 'languages', 'styles', 'templates', 'assets', 'data', 'src'];

/** Local-only even though they sit under a sync root: `assets/torture/` is the
 * regenerable keyhole fixture (gitignored), `.webgpu-entry.js` is a build
 * intermediate (gitignored). */
const EXCLUDED_PREFIXES = ['assets/torture/'];
const EXCLUDED_FILES = new Set(['src/vendor/three/.webgpu-entry.js']);
const JUNK_NAME = /(^(Thumbs\.db|desktop\.ini|\.DS_Store)$)|(~$)|(\.(tmp|swp|swo|bak)$)|(^~\$)|(^\.#)/i;

/** Forward-slash, no leading "./". */
export function normalizeRel(rel) {
  return String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Does this repo-relative path belong on the server?
 * @param {string} rel
 */
export function shouldSync(rel) {
  const p = normalizeRel(rel);
  if (!p || p.startsWith('/') || p.split('/').includes('..')) return false;
  const root = p.split('/')[0];
  if (!SYNC_ROOTS.includes(root)) return false;
  if (EXCLUDED_FILES.has(p)) return false;
  if (EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix))) return false;
  const name = p.slice(p.lastIndexOf('/') + 1);
  return !JUNK_NAME.test(name);
}

/**
 * Every path that reaches a remote shell is wrapped in single quotes, so a
 * path that could break out of them is refused rather than escaped.
 * @param {string} rel
 */
export function assertSafeRelPath(rel) {
  const p = normalizeRel(rel);
  // eslint-disable-next-line no-control-regex
  if (!p || /['"`$\\\u0000-\u001f]/.test(p) || p.startsWith('/') || p.startsWith('-') || p.split('/').includes('..')) {
    throw new Error(`Refusing an unsafe path: ${JSON.stringify(rel)}`);
  }
  return p;
}

/**
 * Same Map shape on both sides: repo-relative posix path -> sha256 hex.
 * @param {Map<string,string>} local
 * @param {Map<string,string>} remote
 */
export function diffManifests(local, remote) {
  const added = [];
  const changed = [];
  const same = [];
  for (const [rel, hash] of local) {
    if (!remote.has(rel)) added.push(rel);
    else if (remote.get(rel) !== hash) changed.push(rel);
    else same.push(rel);
  }
  const onlyRemote = [...remote.keys()].filter((rel) => !local.has(rel));
  for (const list of [added, changed, same, onlyRemote]) list.sort();
  return { added, changed, same, onlyRemote };
}

/** `sha256sum` output ("<64 hex>  <path>" per line, optional "./" prefix) -> Map. */
export function parseSha256Lines(text) {
  const out = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (m) out.set(normalizeRel(m[2]), m[1]);
  }
  return out;
}

/**
 * Upload order: module.json LAST. Foundry reads the manifest to decide what to
 * load, so it must never name a file that has not arrived yet.
 * @param {string[]} paths
 */
export function orderForUpload(paths) {
  const rest = paths.filter((p) => p !== 'module.json').sort();
  return paths.includes('module.json') ? [...rest, 'module.json'] : rest;
}

/** Strip block and line comments so an `import` shown in a doc comment is not
 * mistaken for a real one. Deliberately crude: it only has to avoid FALSE
 * "missing import" refusals, never to parse JavaScript. */
export function stripJsComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

/**
 * Relative module specifiers a JS file imports/re-exports/dynamically imports.
 * Bare specifiers ("three") and absolute URLs are ignored — only the
 * `./` / `../` ones can name a file this tool is responsible for.
 * @param {string} source
 * @returns {string[]}
 */
export function extractRelativeImports(source) {
  const code = stripJsComments(source);
  const found = new Set();
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
    /\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) found.add(m[1].replace(/[?#].*$/, ''));
  }
  return [...found];
}

/** Resolve `spec` (relative) against the directory of `fromRel` -> repo-relative posix path. */
export function resolveRelativeImport(fromRel, spec) {
  const parts = normalizeRel(fromRel).split('/');
  parts.pop();
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * The files `text` needs to exist for it to load: what module.json names, or
 * what a JS file imports relatively. Split from {@link preflightText} so the
 * CLI can ask the filesystem about exactly these (the core stays I/O-free).
 * An unparseable module.json has no dependencies — preflightText reports it.
 *
 * @param {string} rel - repo-relative path
 * @param {string} text - its local contents
 * @returns {Array<{target: string, why: string}>}
 */
export function dependenciesOf(rel, text) {
  const p = normalizeRel(rel);
  if (p === 'module.json') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return [
      ...(parsed.esmodules ?? []),
      ...(parsed.scripts ?? []),
      ...(parsed.styles ?? []),
      ...(parsed.languages ?? []).map((l) => l?.path),
    ]
      .filter(Boolean)
      .map((file) => ({ target: normalizeRel(file), why: `module.json names "${file}"` }));
  }
  if (/\.m?js$/.test(p)) {
    return extractRelativeImports(text).map((spec) => ({
      target: resolveRelativeImport(p, spec),
      why: `${p} imports "${spec}"`,
    }));
  }
  return [];
}

/**
 * What stops a file from loading, checked WITHOUT running anything — the same
 * gate-before-upload idea as Blank Inheritance's preflight. (The CLI adds a
 * `node --check` syntax pass for JS on top; that needs a process, so it is not here.)
 *
 * @param {string} rel - repo-relative path being uploaded
 * @param {string} text - its local contents
 * @param {(rel: string) => boolean} existsLocal - does this repo-relative file exist locally?
 * @returns {string[]} problems (empty = fine)
 */
export function preflightText(rel, text, existsLocal) {
  const p = normalizeRel(rel);
  if (p.endsWith('.json')) {
    try {
      JSON.parse(text);
    } catch (err) {
      return [`${p}: not valid JSON (${err.message})`];
    }
  }
  return dependenciesOf(p, text)
    .filter((d) => !existsLocal(d.target))
    .map((d) => `${d.why}, but ${d.target} does not exist locally`);
}

/**
 * Turn `Map<file, problems[]>` into one readable block.
 * @param {Map<string, string[]>} problemsByFile
 */
export function formatProblems(problemsByFile) {
  const lines = [];
  for (const problems of problemsByFile.values()) for (const p of problems) lines.push(`  ✗ ${p}`);
  return lines.join('\n');
}

/** "1.2 MB" style size for log lines. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
