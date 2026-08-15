/**
 * reckoning-report.test.mjs — the Reckoning Report's pure brain. The verdict
 * thresholds are the part that must not lie (an instrument that mislabels
 * "split starved" vs "split engaged" would aim the whole campaign at the wrong
 * code), and the zone-row math is what the author pastes back for analysis —
 * both are plain data-in/data-out, so they test under Node. The live gather
 * (boot.js) is browser-verified by pressing the button.
 */
import {
  RECKONING_REPORT_VERSION,
  summarizeZoneRows,
  computeReckoningVerdicts,
  assembleReckoningReport,
} from '../reckoning-report.js';

export async function run(t) {
  const { ok } = t;

  // --- summarizeZoneRows -----------------------------------------------------
  {
    const rows = summarizeZoneRows(
      [
        {
          id: 'geometry.worldDraw',
          cpu: { sumMs: 10, count: 100, maxMs: 0.5 },
          gpu: { sumMs: 890, count: 100, maxMs: 12 },
        },
        { id: 'tick.camera', cpu: { sumMs: 20, count: 100, maxMs: 1 }, gpu: null },
        {
          id: 'geometry.depthDraw',
          cpu: { sumMs: 5, count: 100, maxMs: 0.2 },
          gpu: { sumMs: 900, count: 100, maxMs: 9.7 },
        },
      ],
      100
    );
    ok(
      'rows sorted by GPU ms/frame descending',
      rows[0].id === 'geometry.depthDraw' && rows[1].id === 'geometry.worldDraw'
    );
    ok('per-frame math: 890ms over 100 frames = 8.9', rows[1].gpuMsPerFrame === 8.9);
    ok('CPU-only zone keeps null gpu, sorts last', rows[2].id === 'tick.camera' && rows[2].gpuMsPerFrame === null);
    ok('occurrence count carried', rows[0].count === 100);
    ok(
      'empty/invalid input → empty array, never throws',
      summarizeZoneRows(null, 100).length === 0 && summarizeZoneRows([], 0).length === 0
    );
  }

  // --- computeReckoningVerdicts: the starved case (Bug #20 re-created) -------
  {
    const verdicts = computeReckoningVerdicts({
      census: {
        view: { floorIndex: 1 },
        canvasPx: { w: 3840, h: 1906 },
        depthProxySplitMaterials: 0,
        prepassSplitMaterials: 0,
        itemStatesSize: 4,
        drawListSize: 4,
        windowSurfacesAlive: 1,
      },
      earlyZ: {
        earlyZComposition: true,
        s1aBlockedNoMinGrid: 3,
        splitDeclinedBy: { noMinGrid: 3 },
        tiles: { interior: 0, split: 0, passthrough: 4, legacy: 0 },
      },
      zones: { frames: 150, gpuSupported: true },
      errors: [],
    });
    ok(
      'starved cache → 🔴 SPLIT STARVED verdict',
      verdicts.some((v) => v.includes('SPLIT STARVED') && v.startsWith('🔴'))
    );
    ok(
      'upper floor with zero early-Z tiles → 🔴 no-early-Z verdict',
      verdicts.some((v) => v.includes('NO tile on this upper floor'))
    );
    ok('healthy window/resolution/frames → no 🟠 caveats', !verdicts.some((v) => v.startsWith('🟠')));
  }

  // --- the engaged/clean case ------------------------------------------------
  {
    const verdicts = computeReckoningVerdicts({
      census: {
        view: { floorIndex: 1 },
        canvasPx: { w: 3840, h: 1906 },
        depthProxySplitMaterials: 4,
        prepassSplitMaterials: 4,
        itemStatesSize: 4,
        drawListSize: 4,
        windowSurfacesAlive: 1,
      },
      earlyZ: {
        earlyZComposition: true,
        s1aBlockedNoMinGrid: 0,
        splitDeclinedBy: {},
        tiles: { interior: 2, split: 4, passthrough: 1, legacy: 0 },
      },
      zones: { frames: 150, gpuSupported: true },
      suspects: { dofEnabled: false },
      errors: [],
    });
    ok('engaged split → no 🔴 verdicts at all', !verdicts.some((v) => v.startsWith('🔴')));
    ok('always closes with the both-floors instruction', verdicts[verdicts.length - 1].includes('BOTH floors'));
  }

  // --- depth-side disengagement + caveats ------------------------------------
  {
    const verdicts = computeReckoningVerdicts({
      census: {
        view: { floorIndex: 1 },
        canvasPx: { w: 1920, h: 1080 },
        depthProxySplitMaterials: 0,
        prepassSplitMaterials: 0,
        itemStatesSize: 40,
        drawListSize: 4,
        windowSurfacesAlive: 3,
      },
      earlyZ: {
        earlyZComposition: true,
        s1aBlockedNoMinGrid: 0,
        splitDeclinedBy: {},
        tiles: { interior: 0, split: 4, passthrough: 0, legacy: 0 },
      },
      zones: { frames: 4, gpuSupported: false },
      suspects: { dofEnabled: true },
      errors: ['zones: arm blocked'],
    });
    ok(
      'split colour + single-material proxies → 🔴 depth-side verdict',
      verdicts.some((v) => v.includes('depth-side S1a fix'))
    );
    ok(
      '1920-wide canvas → 🟠 resolution caveat',
      verdicts.some((v) => v.includes('resolution mismatch'))
    );
    ok(
      'tiny window → 🟠 frames caveat',
      verdicts.some((v) => v.includes('only 4 frame(s)'))
    );
    ok(
      'no GPU timing → 🟠 CPU-only caveat',
      verdicts.some((v) => v.includes('CPU-only'))
    );
    ok(
      'DoF on upper floor → 🟡 SL-2 note',
      verdicts.some((v) => v.includes('SL-2'))
    );
    ok(
      '3 window scenes → 🟡 SL-3 note',
      verdicts.some((v) => v.includes('SL-3'))
    );
    ok(
      'itemStates 40 vs draw list 4 → 🟡 SL-7 note',
      verdicts.some((v) => v.includes('SL-7'))
    );
    ok(
      'gather errors surfaced as ℹ️',
      verdicts.some((v) => v.includes('section(s) failed'))
    );
  }

  // --- raw fallback + silent quota -------------------------------------------
  {
    const verdicts = computeReckoningVerdicts({
      census: {
        view: { floorIndex: 1 },
        canvasPx: { w: 3840, h: 1906 },
        itemStatesSize: 4,
        drawListSize: 4,
        windowSurfacesAlive: 1,
      },
      earlyZ: {
        earlyZComposition: true,
        s1aBlockedNoMinGrid: 0,
        splitDeclinedBy: {},
        refusedBy: { noAlphaStats: 2, interior: 1 },
        tiles: { interior: 1, split: 0, passthrough: 2, legacy: 0 },
      },
      suspects: { compressedWorker: { requests: 5, cached: 0, bc1: 1, bc7: 4, failed: 0 } },
      zones: { frames: 150, gpuSupported: true },
      errors: [],
    });
    ok(
      'noAlphaStats tiles → 🔴 raw-fallback verdict',
      verdicts.some((v) => v.includes('RAW-DECODE FALLBACK') && v.includes('2 tile(s)'))
    );
    ok(
      'fresh encodes with zero cache hits → 🟠 quota-suspect verdict',
      verdicts.some((v) => v.includes('ZERO hits'))
    );
    const warmVerdicts = computeReckoningVerdicts({
      suspects: { compressedWorker: { requests: 5, cached: 5, bc1: 0, bc7: 0 } },
      zones: { frames: 150, gpuSupported: true },
      errors: [],
    });
    ok('warm cache → no quota verdict', !warmVerdicts.some((v) => v.includes('ZERO hits')));
  }

  // --- the starved verdict names the true mechanism, not the dead hypothesis --
  {
    const verdicts = computeReckoningVerdicts({
      earlyZ: { earlyZComposition: true, s1aBlockedNoMinGrid: 3, splitDeclinedBy: { noMinGrid: 3 }, tiles: {} },
      errors: [],
    });
    const starved = verdicts.find((v) => v.includes('SPLIT STARVED'));
    ok(
      'starved verdict blames the arrival chain, not the version cache',
      !!starved && starved.includes('NOT a stale version cache')
    );
  }

  // --- null tolerance + earlyZ flag off --------------------------------------
  {
    const empty = computeReckoningVerdicts({});
    ok(
      'all sections missing → viewer-missing verdict, no throw',
      empty.some((v) => v.includes('sections missing'))
    );
    const flagOff = computeReckoningVerdicts({
      earlyZ: { earlyZComposition: false },
      census: { view: { floorIndex: 0 } },
    });
    ok(
      'flag off → 🔴 bypass verdict',
      flagOff.some((v) => v.includes('earlyZComposition is OFF'))
    );
  }

  // --- assembleReckoningReport ----------------------------------------------
  {
    const rep = assembleReckoningReport({ generatedAt: '2026-08-15T00:00:00Z', sections: { errors: [] } });
    ok('report id + version stamped', rep.report === 'reckoning-report' && rep.version === RECKONING_REPORT_VERSION);
    const keys = Object.keys(rep);
    ok(
      'verdicts come before every raw section',
      keys.indexOf('verdicts') < keys.indexOf('census') && keys.indexOf('verdicts') < keys.indexOf('zones')
    );
    ok(
      'missing sections land as null, never undefined-holes',
      rep.census === null && rep.zones === null && rep.identity === null
    );
  }
}
