/**
 * MASK DISCOVERY — finds which authored mask FILES exist for each floor's
 * background art, per the catalog's suffix convention (`path/base.webp` →
 * `path/base_Outdoors.webp` …). The result feeds the mask authority
 * (`scene/mask-authority.js#setDiscovery`); nothing else consumes it.
 *
 * ============================================================================
 * DISCOVERY STRATEGY (and the V2 scars it is shaped by)
 * ============================================================================
 *
 * 1. DIRECTORY LISTING FIRST. One `FilePicker.browse()` per unique art
 *    directory (cached per run) yields EXACT knowledge of what exists — zero
 *    speculative requests, zero 404 console spam. V2's loader probed URLs
 *    blind and grew three layers of negative-cache/diagnostic maps to contain
 *    the fallout (`legacy/assets/loader.js`: `_probeMaskNegativeCache`,
 *    `_failedMaskUrlCache`, `_missingMaskDiagnostics`) — the listing approach
 *    makes that entire apparatus unnecessary.
 *
 * 2. BOUNDED PROBING as the announced fallback. Listing legitimately fails:
 *    players without the FILES_BROWSE permission, absolute URLs into hosts
 *    FilePicker cannot browse (The Forge's asset CDN), S3 configs. Then each
 *    candidate URL (suffix × a SHORT extension-preference list) gets one
 *    ranged GET (`bytes=0-0` — same technique `decode-pool.js`'s dimension
 *    probe already uses); ok/206 = exists. Probes are counted and reported —
 *    a session that probed is VISIBLY a session that could not list, never
 *    silently the same thing (instruments must not lie).
 *
 * Whatever the method, the result records HOW each floor was discovered and
 * every failure along the way, so "no masks found" and "could not look" are
 * different, inspectable outcomes in the mask-authority report.
 *
 * Pure matching/candidate logic is exported for Node tests; all IO
 * (FilePicker, fetch) is injectable and defaults to the real thing.
 *
 * @module foundry/mask-discovery
 */

import { MASK_KINDS } from '../scene/index.js';

/** Extension preference when several sibling files could satisfy one kind —
 * the art's own extension first (authors overwhelmingly keep one format per
 * map), then the historical V2 bundle order. */
const EXTENSION_PREFERENCE = ['webp', 'png', 'jpg', 'jpeg'];

/** Extensions probed blind per candidate suffix when listing is unavailable —
 * deliberately SHORTER than EXTENSION_PREFERENCE: every entry here is a
 * speculative network request on a floor with no mask of that kind. */
const PROBE_EXTENSIONS = ['webp', 'png'];

/**
 * @typedef {object} MaskDiscoveryResult
 * @property {Map<string, Map<string, string>>} byLevelId - levelId -> (kindId -> URL).
 * @property {'listing'|'probe'|'mixed'|'none'} method - how the run discovered overall.
 * @property {Array<{levelId:string, method:string, found:number, aliasesUsed:string[]}>} perFloor
 * @property {Array<{levelId:string, stage:string, detail:string}>} failures
 * @property {number} probesAttempted
 */

/**
 * Split an art URL/path into directory, base name and extension.
 * Pure. Query strings survive on the DIRECTORY side of probing only via
 * candidate reconstruction — the suffix inserts before the extension.
 * @param {string} url
 * @returns {{dir:string, base:string, ext:string}|null} null if it has no extension.
 */
export function splitArtUrl(url) {
  const clean = String(url ?? '').split('?')[0];
  const slash = clean.lastIndexOf('/');
  const dir = slash >= 0 ? clean.slice(0, slash) : '';
  const file = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = file.lastIndexOf('.');
  if (dot <= 0) return null;
  return { dir, base: file.slice(0, dot), ext: file.slice(dot + 1).toLowerCase() };
}

/**
 * Match one floor's mask files against a directory listing. Pure.
 *
 * Comparison is on DECODED basenames, case-insensitively — Foundry data paths
 * are URL-encoded in listings (`my%20map.webp`) and Windows-hosted servers
 * serve case-insensitively, so a case-exact compare would manufacture
 * "missing" masks that a fetch would happily find.
 *
 * @param {string[]} listedFiles - full paths as `FilePicker.browse().files` returns them.
 * @param {string} artBase - the art file's base name (no extension).
 * @param {string} artExt - the art file's extension (preferred on ties).
 * @returns {{found: Map<string, string>, aliasesUsed: string[]}} kindId -> the LISTED path (still encoded, fetchable as returned).
 */
export function matchMaskFiles(listedFiles, artBase, artExt) {
  const byBasename = new Map(); // decoded lowercase basename -> listed path
  for (const path of listedFiles ?? []) {
    const clean = String(path).split('?')[0];
    const name = clean.slice(clean.lastIndexOf('/') + 1);
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch (_) {
      // Not valid percent-encoding — compare the raw name instead.
    }
    byBasename.set(decoded.toLowerCase(), path);
  }

  const extRank = (ext) => {
    if (ext === artExt) return -1;
    const i = EXTENSION_PREFERENCE.indexOf(ext);
    return i === -1 ? EXTENSION_PREFERENCE.length : i;
  };

  const found = new Map();
  const aliasesUsed = [];
  for (const kind of MASK_KINDS) {
    let best = null; // {path, suffixRank, extRank}
    for (let s = 0; s < kind.suffixes.length; s++) {
      const wantPrefix = `${artBase}${kind.suffixes[s]}.`.toLowerCase();
      for (const [basename, path] of byBasename) {
        if (!basename.startsWith(wantPrefix)) continue;
        const ext = basename.slice(wantPrefix.length);
        if (!EXTENSION_PREFERENCE.includes(ext)) continue;
        const candidate = { path, suffixRank: s, extRank: extRank(ext) };
        if (
          !best ||
          candidate.suffixRank < best.suffixRank ||
          (candidate.suffixRank === best.suffixRank && candidate.extRank < best.extRank)
        ) {
          best = candidate;
        }
      }
    }
    if (best) {
      found.set(kind.id, best.path);
      if (best.suffixRank > 0) aliasesUsed.push(`${kind.id}←${kind.suffixes[best.suffixRank]}`);
    }
  }
  return { found, aliasesUsed };
}

/**
 * Candidate URLs to PROBE for one kind when no listing is available. Pure,
 * deliberately short (each is a speculative request): every suffix (canon +
 * aliases) × the art's own extension first, then PROBE_EXTENSIONS.
 * @param {{dir:string, base:string, ext:string}} art
 * @param {import('../scene/mask-catalog.js').MaskKind} kind
 * @returns {string[]}
 */
export function candidateUrls(art, kind) {
  const exts = [art.ext, ...PROBE_EXTENSIONS.filter((e) => e !== art.ext)];
  const prefix = art.dir ? `${art.dir}/` : '';
  const out = [];
  for (const suffix of kind.suffixes) {
    for (const ext of exts) out.push(`${prefix}${art.base}${suffix}.${ext}`);
  }
  return out;
}

/** True for URLs FilePicker cannot browse (absolute http(s) — Forge CDNs, S3 links). @param {string} url */
export function isAbsoluteUrl(url) {
  return /^https?:\/\//i.test(url ?? '');
}

/** The real directory lister: one FilePicker browse of the 'data' source.
 * Returns the listed file paths, or null when browsing is unavailable/denied
 * (the caller records why and falls back to probing). */
async function defaultListDirectory(dir) {
  const FilePickerNS = globalThis.foundry?.applications?.apps?.FilePicker;
  const impl = FilePickerNS?.implementation ?? FilePickerNS;
  if (typeof impl?.browse !== 'function') return null;
  const result = await impl.browse('data', dir || '.');
  return Array.isArray(result?.files) ? result.files : [];
}

/** The real existence probe: a 1-byte ranged GET (the decode-pool dimension-
 * probe technique). ok or 206 = the file exists. */
async function defaultProbeUrl(url) {
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  return res.ok || res.status === 206;
}

/**
 * Discover authored masks for every floor of a scene.
 *
 * @param {object} args
 * @param {Array<{index:number, id:string, url:string}>} args.floors -
 *   `getActiveSceneFloors().floors` (the RESOLVED background art URLs).
 * @param {(dir:string) => Promise<string[]|null>} [args.listDirectory] - injected for tests.
 * @param {(url:string) => Promise<boolean>} [args.probeUrl] - injected for tests.
 * @returns {Promise<MaskDiscoveryResult>}
 */
export async function discoverAuthoredMasks({
  floors,
  listDirectory = defaultListDirectory,
  probeUrl = defaultProbeUrl,
}) {
  const byLevelId = new Map();
  const perFloor = [];
  const failures = [];
  let probesAttempted = 0;
  const listingCache = new Map(); // dir -> string[]|null (one browse per directory per run)
  const probeMemo = new Map(); // url -> boolean (a run never probes one URL twice)

  for (const floor of floors ?? []) {
    const art = splitArtUrl(floor.url);
    if (!art) {
      failures.push({ levelId: floor.id, stage: 'parse', detail: `unparseable art URL "${floor.url}"` });
      perFloor.push({ levelId: floor.id, method: 'none', found: 0, aliasesUsed: [] });
      continue;
    }

    let found = null;
    let aliasesUsed = [];
    let method = 'none';

    if (!isAbsoluteUrl(floor.url)) {
      if (!listingCache.has(art.dir)) {
        try {
          listingCache.set(art.dir, await listDirectory(art.dir));
        } catch (err) {
          listingCache.set(art.dir, null);
          failures.push({ levelId: floor.id, stage: 'listing', detail: String(err?.message || err) });
        }
      }
      const listed = listingCache.get(art.dir);
      if (listed) {
        const match = matchMaskFiles(listed, art.base, art.ext);
        found = match.found;
        aliasesUsed = match.aliasesUsed;
        method = 'listing';
      } else if (!failures.some((f) => f.levelId === floor.id && f.stage === 'listing')) {
        failures.push({ levelId: floor.id, stage: 'listing', detail: 'FilePicker browse unavailable or denied' });
      }
    }

    if (!found) {
      // PROBE fallback — bounded, memoized, counted. First hit per kind wins
      // (candidates are already in preference order).
      found = new Map();
      method = 'probe';
      for (const kind of MASK_KINDS) {
        for (const url of candidateUrls(art, kind)) {
          let exists = probeMemo.get(url);
          if (exists === undefined) {
            probesAttempted++;
            try {
              exists = await probeUrl(url);
            } catch (err) {
              exists = false;
              failures.push({ levelId: floor.id, stage: 'probe', detail: `${url}: ${String(err?.message || err)}` });
            }
            probeMemo.set(url, exists);
          }
          if (exists) {
            found.set(kind.id, url);
            const suffixRank = kind.suffixes.findIndex((s) => url.includes(`${art.base}${s}.`));
            if (suffixRank > 0) aliasesUsed.push(`${kind.id}←${kind.suffixes[suffixRank]}`);
            break;
          }
        }
      }
    }

    if (found.size > 0) byLevelId.set(floor.id, found);
    perFloor.push({ levelId: floor.id, method, found: found.size, aliasesUsed });
  }

  const methods = new Set(perFloor.map((f) => f.method).filter((m) => m !== 'none'));
  const method = methods.size === 0 ? 'none' : methods.size === 1 ? [...methods][0] : 'mixed';
  return { byLevelId, method, perFloor, failures, probesAttempted };
}
