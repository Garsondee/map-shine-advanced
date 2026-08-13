/** FIRST-FLOOR `_Fire` MASK BYTE-SWAP — decisive live verification (2026-08-13).
 *
 * THE TEST: `mythica-machina-mansion-First-Floor_Fire.webp` was replaced
 * (Copy-Item -Force) with an exact byte-for-byte copy of
 * `mythica-machina-mansion-Ground_Fire.webp` — the SAME file that reliably
 * yields 5 fires on Ground floor (console: "painted region on floor 0
 * yielded 5 fire(s)"). Confirmed on disk before this run:
 *   First-Floor_Fire.webp (current) sha256 18ecfb06b1050f03d6e283d561a318e0916b344ae8db0ae57531b35b986902f5, 259840 bytes
 *   Ground_Fire.webp             sha256 18ecfb06b1050f03d6e283d561a318e0916b344ae8db0ae57531b35b986902f5, 259840 bytes  (IDENTICAL)
 *   First-Floor_Fire.webp.bak    sha256 3f5d1e30782dda3dd4f64f93a2826b92bc7c7dfaed74f6e5ce94c2a5157d8082, 426706 bytes (the ORIGINAL, different)
 *
 * If floor 1 now ALSO yields 5 fires: content/size was the whole story.
 * If floor 1 STILL yields 0 despite byte-identical content to a file proven
 * to work on Ground: that is a real per-floor code bug, and this script
 * gathers live evidence toward WHY (mask-authority report, and — critically
 * — what bytes the browser/server actually exchanged for this URL, since a
 * persistent Chrome profile could in principle serve a stale cached response
 * for a URL it fetched before the swap).
 *
 * GENUINE FRESH LOAD, deliberately: a brand-new persistent-context page,
 * `page.goto` from scratch, real login — never a floor switch reused inside
 * an already-loaded session — because mask discovery
 * (mask-discovery.js#discoverAuthoredMasks) and mip-pyramid page ingest
 * (mask-authority.js#ingestDecodedPage, coarsest mip only) both run during
 * the scene's OWN load phase, not guaranteed to re-run on a mere
 * canvas.scene.view() call. The persistent Chrome profile (BC/GPU texture
 * cache) is reused on purpose — only the in-page JS session must be fresh.
 *
 * NETWORK EVIDENCE, two independent angles:
 *   1. PASSIVE — every response whose URL matches `_Fire.webp`, captured
 *      with actual body bytes + sha256, i.e. what the running app itself
 *      received (cache or network, doesn't matter — this is ground truth for
 *      what MSA decoded).
 *   2. ACTIVE — once we see the app's own request URL for the First-Floor
 *      mask, a plain Node-side `fetch` (a wholly separate HTTP client that
 *      never touches Chrome's disk cache) of that exact URL, to answer "what
 *      does the SERVER return right now" independent of any browser caching.
 *
 * boot.js's fireMaskCache/fireSpawnCache (~line 2455-2492) are closure-local
 * `let` bindings re-initialized to {floorIndex:null, signature:0, version:-1}
 * every time boot.js's setup runs — i.e. every fresh page load. A stale
 * in-memory cache surviving a genuine reload is structurally impossible; the
 * only cache that could survive a reload is the BROWSER's, which the network
 * evidence above checks directly.
 */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { chromium } from '@playwright/test';
import { FoundryLauncher } from '../../playwright/foundry-launcher.js';
import {
  bestEffortLogin,
  waitForGameReady,
  waitForCanvasReady,
  waitForMapShineReady,
  unpauseIfPaused,
  waitForSceneSettled,
} from '../../playwright/map-shine-utils.js';

const LABEL = 'fire-swap';
const PROFILE_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'chrome-profile');
process.env.FOUNDRY_USER_NAME = process.env.FOUNDRY_USER_NAME || 'Bench';
const OUT_DIR = path.join(process.cwd(), 'tests', 'playwright-artifacts', 'look');
const resultPath = path.join(OUT_DIR, `${LABEL}-result.json`);
const FLOOR_CHANGE_SETTLE_BUFFER_MS = 15000; // mirrors perf-run-full's own margin, boot.js

fs.mkdirSync(OUT_DIR, { recursive: true });

// Ground truth, computed from disk right before this run (see header).
const KNOWN_HASHES = {
  currentFirstFloorFire: { sha256: '18ecfb06b1050f03d6e283d561a318e0916b344ae8db0ae57531b35b986902f5', size: 259840 },
  groundFire: { sha256: '18ecfb06b1050f03d6e283d561a318e0916b344ae8db0ae57531b35b986902f5', size: 259840 },
  originalFirstFloorFireBak: { sha256: '3f5d1e30782dda3dd4f64f93a2826b92bc7c7dfaed74f6e5ce94c2a5157d8082', size: 426706 },
};

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1920, height: 1080 },
  args: ['--no-first-run', '--no-default-browser-check'],
});
const page = context.pages()[0] || (await context.newPage());

const consoleLines = [];
page.on('console', (m) => {
  const entry = { type: m.type(), text: m.text().slice(0, 500), at: Date.now() };
  consoleLines.push(entry);
  Promise.all(m.args().map((a) => a.jsonValue().catch(() => '<unserializable>')))
    .then((args) => {
      entry.args = args;
    })
    .catch(() => {});
});
page.on('pageerror', (e) => consoleLines.push({ type: 'pageerror', text: String(e).slice(0, 500), at: Date.now() }));

// PASSIVE network evidence — every response touching a `_Fire.webp` URL.
const fireMaskResponses = [];
page.on('response', (res) => {
  const url = res.url();
  if (!/_Fire\.webp/i.test(url)) return;
  const status = res.status();
  const headers = res.headers();
  const rec = {
    url,
    status,
    contentLength: headers['content-length'] ?? null,
    contentRange: headers['content-range'] ?? null,
    etag: headers['etag'] ?? null,
    lastModified: headers['last-modified'] ?? null,
    cacheControl: headers['cache-control'] ?? null,
    age: headers['age'] ?? null,
    at: Date.now(),
  };
  fireMaskResponses.push(rec);
  res
    .body()
    .then((buf) => {
      rec.bodyBytes = buf.length;
      rec.sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    })
    .catch((e) => {
      rec.bodyError = String(e?.message ?? e);
    });
});

const launcher = new FoundryLauncher({ headless: true });
await launcher.start();

const state = { label: LABEL, startedAt: new Date().toISOString(), knownHashes: KNOWN_HASHES };
function save() {
  fs.writeFileSync(
    resultPath,
    JSON.stringify(
      {
        ...state,
        fireConsoleLines: consoleLines.filter((l) => /fire/i.test(l.text)).slice(0, 300),
        consoleErrors: consoleLines.filter((l) => l.type === 'error' || l.type === 'pageerror').slice(0, 60),
        totalConsoleLines: consoleLines.length,
        fireMaskResponses,
      },
      null,
      2
    )
  );
}

async function waitForMapArtLoaded(timeoutMs) {
  const start = Date.now();
  for (;;) {
    const st = await page.evaluate(async () => {
      try {
        const raw = await window.MapShine?.debug?.runReport?.('loading-screen-state');
        const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return {
          showing: r?.showing !== false,
          complete: r?.current?.complete === true,
          error: r?.current?.error ?? null,
          phase: (r?.currentPhases || []).filter((p) => p.endMs === null).map((p) => p.phase)[0] ?? null,
        };
      } catch (e) {
        return { showing: true, error: null };
      }
    });
    if (st?.error) throw new Error(`MSA reported a load error: ${JSON.stringify(st.error)}`);
    if (st && (st.complete || !st.showing)) return st;
    if (Date.now() - start > timeoutMs)
      throw new Error(`Map art did not finish loading after ${Math.round((Date.now() - start) / 1000)}s (phase=${st?.phase})`);
    await page.waitForTimeout(1000);
  }
}

async function getSceneState() {
  return page.evaluate(() => ({
    msaVersion: window.MapShine?.version ?? null,
    sceneName: window.canvas?.scene?.name ?? null,
    viewedLevelId: window.canvas?.level?.id ?? null,
    viewedLevelName: window.canvas?.level?.name ?? null,
    levels:
      (window.canvas?.scene?.levels ?? []).map?.((l) => ({
        id: l.id,
        name: l.name,
        bottom: l.elevation?.bottom ?? null,
        top: l.elevation?.top ?? null,
        background: l.background?.src ?? null,
      })) ?? null,
  }));
}

async function getReport(id) {
  return page.evaluate(async (reportId) => {
    try {
      const r = await window.MapShine?.debug?.runReport?.(reportId);
      return typeof r === 'string' ? JSON.parse(r) : r;
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }, id);
}

const shot = (name) =>
  page.screenshot({ path: path.join(OUT_DIR, `${LABEL}-${name}.png`) }).catch((e) => {
    consoleLines.push({ type: 'screenshot-failed', text: `${name}: ${String(e)}`, at: Date.now() });
  });

function extractYieldLine(text) {
  const m = /painted region on floor (\d+) yielded (\d+) fire\(s\)/.exec(text);
  if (!m) return null;
  return { floorIndex: Number(m[1]), count: Number(m[2]) };
}

try {
  console.log(`[${LABEL}] goto ${launcher.getBaseUrl()}`);
  await page.goto(launcher.getBaseUrl(), { waitUntil: 'domcontentloaded' });
  await bestEffortLogin(page);
  await waitForGameReady(page);
  await waitForCanvasReady(page);
  await waitForMapShineReady(page);
  await unpauseIfPaused(page);

  const gpu = await page.evaluate(async () => {
    if (typeof navigator.gpu === 'undefined') return { hasGpu: false };
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return { hasGpu: true, adapter: false };
    return { hasGpu: true, adapter: true, vendor: a.info?.vendor ?? null, architecture: a.info?.architecture ?? null };
  });
  state.gpu = gpu;
  console.log(`[${LABEL}] gpu:`, JSON.stringify(gpu));
  save();

  console.log(`[${LABEL}] waiting for map art to finish loading (cold BC compression can be ~50s)...`);
  const loadState = await waitForMapArtLoaded(600000);
  state.mapArtLoadMs = loadState.elapsedMs ?? null;
  console.log(`[${LABEL}] map art loaded`);

  await waitForSceneSettled(page, { label: 'ground initial', timeoutMs: 300000 });
  await page.waitForTimeout(10000); // residency / effect warm-up dwell

  state.sceneStateGround = await getSceneState();
  state.maskAuthorityBeforeSwitch = await getReport('mask-authority');
  console.log(`[${LABEL}] initial (Ground) viewedLevel=${state.sceneStateGround.viewedLevelName}`);
  save();

  const groundFloor0Lines = consoleLines.filter((l) => extractYieldLine(l.text)?.floorIndex === 0);
  console.log(`[${LABEL}] floor-0 (Ground) yield lines so far: ${groundFloor0Lines.length}`, groundFloor0Lines.map((l) => l.text));

  // ---- THE FLOOR SWITCH — Foundry's own native, public API -----------------
  const levels = state.sceneStateGround.levels ?? [];
  console.log(`[${LABEL}] levels on this scene:`, JSON.stringify(levels));
  const firstFloor =
    levels.find((l) => /first/i.test(l.name || '')) ?? levels.find((l) => l.id !== state.sceneStateGround.viewedLevelId);
  if (!firstFloor) throw new Error(`Could not identify a "First Floor" level among: ${JSON.stringify(levels)}`);
  state.firstFloorLevel = firstFloor;
  console.log(`[${LABEL}] switching to level id=${firstFloor.id} name="${firstFloor.name}" via canvas.scene.view()...`);

  const switchResult = await page.evaluate(async (levelId) => {
    await window.canvas.scene.view({ level: levelId });
    return { viewedLevelId: window.canvas?.level?.id ?? null, viewedLevelName: window.canvas?.level?.name ?? null };
  }, firstFloor.id);
  console.log(`[${LABEL}] switch call returned:`, JSON.stringify(switchResult));
  state.switchResult = switchResult;
  save();

  await waitForSceneSettled(page, { label: 'first-floor switch', timeoutMs: 300000 });
  console.log(`[${LABEL}] settled — waiting an additional ${FLOOR_CHANGE_SETTLE_BUFFER_MS}ms floor-change buffer...`);
  await page.waitForTimeout(FLOOR_CHANGE_SETTLE_BUFFER_MS);

  state.sceneStateFirstFloor = await getSceneState();
  state.maskAuthorityAfterSwitch = await getReport('mask-authority');
  console.log(`[${LABEL}] now viewing: ${state.sceneStateFirstFloor.viewedLevelName}`);
  save();

  // ---- THE CRUX LINE --------------------------------------------------------
  const floor1Lines = consoleLines.filter((l) => extractYieldLine(l.text)?.floorIndex === 1 && /fire\(s\)/.test(l.text));
  const floor1SpawnLines = consoleLines.filter(
    (l) => l.text.includes('spawn point') && /painted region on floor 1/.test(l.text)
  );
  console.log(`[${LABEL}] floor-1 fire yield lines:`, JSON.stringify(floor1Lines.map((l) => l.text)));
  console.log(`[${LABEL}] floor-1 spawn-point yield lines:`, JSON.stringify(floor1SpawnLines.map((l) => l.text)));

  const lastFloor1Line = floor1Lines[floor1Lines.length - 1] ?? null;
  const yieldInfo = lastFloor1Line ? extractYieldLine(lastFloor1Line.text) : null;
  const fireCount = yieldInfo?.count ?? null;
  const firePositions = Array.isArray(lastFloor1Line?.args?.[1]) ? lastFloor1Line.args[1] : [];

  state.floor1FireCount = fireCount;
  state.floor1FirePositions = firePositions;
  state.floor1RawLine = lastFloor1Line?.text ?? null;
  console.log(`[${LABEL}] *** FLOOR 1 FIRE COUNT: ${fireCount === null ? 'NO LINE SEEN' : fireCount} ***`);
  save();

  await shot('first-floor-overview');

  // ---- ACTIVE server-truth check: plain Node fetch, bypasses Chrome cache --
  // Reuse the exact URL the app itself requested (from the passive listener)
  // so there is zero risk of us constructing the wrong path by hand.
  await page.waitForTimeout(1000); // let in-flight response bodies resolve
  const appRequestedUrl = fireMaskResponses.find((r) => /first-floor.*_fire\.webp/i.test(r.url))?.url ?? null;
  state.appRequestedFirstFloorFireUrl = appRequestedUrl;
  if (appRequestedUrl) {
    try {
      const directRes = await fetch(appRequestedUrl, { cache: 'no-store' });
      const directBuf = Buffer.from(await directRes.arrayBuffer());
      state.directServerFetch = {
        url: appRequestedUrl,
        status: directRes.status,
        bodyBytes: directBuf.length,
        sha256: crypto.createHash('sha256').update(directBuf).digest('hex'),
        matchesCurrentFirstFloorFile: crypto.createHash('sha256').update(directBuf).digest('hex') === KNOWN_HASHES.currentFirstFloorFire.sha256,
        headers: Object.fromEntries(directRes.headers.entries()),
      };
      console.log(`[${LABEL}] direct Node-side fetch of ${appRequestedUrl}:`, JSON.stringify(state.directServerFetch, null, 2));
    } catch (e) {
      state.directServerFetch = { url: appRequestedUrl, error: String(e?.message ?? e) };
    }
  } else {
    console.warn(`[${LABEL}] WARNING: never observed a network response for the First-Floor _Fire.webp URL — see fireMaskResponses in the result file for everything that WAS observed.`);
  }
  save();

  // ---- Screenshot at the fire location ---------------------------------------
  if (fireCount > 0 && firePositions.length) {
    const target = firePositions[0];
    console.log(`[${LABEL}] panning to extracted fire #0 at (${target.x},${target.y})...`);
    await page.evaluate((p) => window.canvas.animatePan({ x: p.x, y: p.y, scale: 2.5, duration: 400 }), target);
    await page.waitForTimeout(1500);
    await shot('first-floor-fire-closeup');
    await page.evaluate((p) => window.canvas.animatePan({ x: p.x, y: p.y, scale: 1.0, duration: 300 }), target);
    await page.waitForTimeout(1000);
    await shot('first-floor-fire-closeup-wide');
  } else {
    // Still 0 (or no line) — pan to where Ground's blob #0 world coords would
    // place a fire (7816,5848 — console-confirmed on Ground earlier this same
    // run), since the swapped content is byte-identical and should occupy the
    // same pixel coordinates if extraction ran on it at all.
    console.log(`[${LABEL}] fireCount=${fireCount}; panning to Ground's known blob-0 world coords (7816,5848) on First Floor for documentation...`);
    await page.evaluate(() => window.canvas.animatePan({ x: 7816, y: 5848, scale: 2.5, duration: 400 }));
    await page.waitForTimeout(1500);
    await shot('first-floor-still-zero-at-ground-coords');
  }

  state.ok = true;
  console.log(`[${LABEL}] DONE.`);
} catch (e) {
  console.error(`[${LABEL}] run stopped early:`, e);
  state.error = String(e?.stack || e?.message || e);
} finally {
  await page.waitForTimeout(500).catch(() => {});
  save();
  await context.close().catch(() => {});
  await launcher.stop();
  console.log(`[${LABEL}] wrote ${resultPath}`);
}
