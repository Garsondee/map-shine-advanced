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
  summarizeAttribution,
  percentileOf,
} from '../reckoning-report.js';

export async function run(t) {
  const { ok } = t;

  // --- percentileOf ----------------------------------------------------------
  {
    ok('empty → null, never lies as 0', percentileOf([], 0.5) === null && percentileOf(null, 0.5) === null);
    ok('p50 of a spread', percentileOf([8, 8, 8, 8, 80], 0.5) === 8);
    ok('p100 catches the tail', percentileOf([8, 8, 8, 8, 80], 1) === 80);
  }

  // --- summarizeAttribution: THE REAL 2026-08-15 UPPER-FLOOR DUMP ------------
  // Pinned against the author's own capture: 29 frames / 1784.4 ms with the GPU
  // passes summing to ~10.7 ms. The instrument must say "83% unmeasured" out
  // loud — the v1 report had no field that could, and that silence is the whole
  // reason this function exists.
  {
    const attr = summarizeAttribution({
      frames: 29,
      durationMs: 1784.4,
      rows: [
        { id: 'geometry.worldDraw', cpuMsPerFrame: 0.1828, gpuMsPerFrame: 2.922 },
        { id: 'geometry.earlyZPrepass', cpuMsPerFrame: 0.169, gpuMsPerFrame: 1.8147 },
        { id: 'present.blit', cpuMsPerFrame: 0.1414, gpuMsPerFrame: 1.4508 },
        { id: 'light.drawIllum', cpuMsPerFrame: 0.1207, gpuMsPerFrame: 1.3898 },
        { id: 'geometry.depthDraw', cpuMsPerFrame: 0.2138, gpuMsPerFrame: 1.322 },
        { id: 'light.drawComposite', cpuMsPerFrame: 0.031, gpuMsPerFrame: 1.0712 },
        { id: 'light.drawRegions', cpuMsPerFrame: 0.131, gpuMsPerFrame: 0.7277 },
        { id: 'pass.geometry.world', cpuMsPerFrame: 1.6, gpuMsPerFrame: null },
        { id: 'pass.light.accumulate', cpuMsPerFrame: 0.9069, gpuMsPerFrame: null },
        { id: 'light.drawWindowLight', cpuMsPerFrame: 0.0414, gpuMsPerFrame: null },
      ],
      gapSamples: [61, 62, 60, 61, 210],
    });
    ok('frame time from the real dump ≈ 61.5ms', Math.abs(attr.frameMsAvg - 61.53) < 0.05);
    ok('fps ≈ 16', Math.abs(attr.fps - 16.25) < 0.2);
    ok('GPU zones sum to ~10.7ms', Math.abs(attr.gpuZoneSumMsPerFrame - 10.6982) < 0.001);
    ok('the unmeasured remainder is named, ~50.8ms', Math.abs(attr.unaccountedMsPerFrame - 50.83) < 0.05);
    ok('and as a percentage: >80%', attr.unaccountedPct > 80);
    ok('16fps is NOT flagged as refresh-capped', attr.refreshCapped === false);
    ok(
      'a CPU-costed draw zone with no GPU timestamp is flagged blind',
      attr.gpuBlindZones.includes('light.drawWindowLight')
    );
    ok('pass.* wrappers are not counted as GPU-blind', !attr.gpuBlindZones.some((z) => z.startsWith('pass.')));
    ok('frame-gap percentiles carry the stall tail', attr.frameGapMs.p50 === 61 && attr.frameGapMs.max === 210);
  }

  // --- summarizeAttribution: THE REAL GROUND-FLOOR DUMP (refresh-capped) -----
  {
    const attr = summarizeAttribution({
      frames: 291,
      durationMs: 2424.6,
      rows: [
        { id: 'present.blit', cpuMsPerFrame: 0.1533, gpuMsPerFrame: 0.8029 },
        { id: 'geometry.worldDraw', cpuMsPerFrame: 0.1096, gpuMsPerFrame: 0.715 },
        { id: 'light.drawComposite', cpuMsPerFrame: 0.0567, gpuMsPerFrame: 0.4022 },
        { id: 'geometry.depthDraw', cpuMsPerFrame: 0.1368, gpuMsPerFrame: 0.0901 },
        { id: 'pass.geometry.world', cpuMsPerFrame: 1.8643, gpuMsPerFrame: null },
      ],
      gapSamples: null,
    });
    ok('ground floor ≈ 8.33ms/frame', Math.abs(attr.frameMsAvg - 8.332) < 0.01);
    ok('REFRESH-CAPPED detected at 120Hz', attr.refreshCapped === true && attr.refreshCapHz === 120);
    ok('null gapSamples → null block, not a fake zero', attr.frameGapMs === null);
    ok(
      'no window → null attribution, never a throw',
      summarizeAttribution(null) === null && summarizeAttribution({ frames: 0, durationMs: 0 }) === null
    );
  }

  // --- the attribution verdicts ---------------------------------------------
  {
    const loud = computeReckoningVerdicts({
      // A healthy census + earlyZ so nothing else claims the top slot: the
      // attribution verdict must OUTRANK every zone-level finding, because a
      // zone table that explains 17% of the frame must not be acted on first.
      census: { view: { floorIndex: 1 }, canvasPx: { w: 3840, h: 1906 }, itemStatesSize: 4, drawListSize: 4 },
      earlyZ: { earlyZComposition: true, tiles: { interior: 2, split: 2 }, splitDeclinedBy: {}, refusedBy: {} },
      attribution: {
        unaccountedPct: 82.6,
        unaccountedMsPerFrame: 50.83,
        frameMsAvg: 61.53,
        gpuZoneSumMsPerFrame: 10.7,
        cpuOuterZoneSumMsPerFrame: 2.5,
        refreshCapped: false,
        refreshCapHz: null,
        gpuBlindZones: ['light.drawWindowLight'],
      },
      errors: [],
    });
    ok('≥40% unmeasured → 🔴 leading verdict', loud[0].includes('UNMEASURED') && loud[0].startsWith('🔴'));
    ok(
      'the verdict forbids blaming a zone prematurely',
      loud.some((v) => v.includes('Do NOT blame any zone'))
    );
    ok(
      'blind GPU zones surfaced',
      loud.some((v) => v.includes('NO GPU timestamp'))
    );

    const capped = computeReckoningVerdicts({
      attribution: {
        unaccountedPct: 10,
        unaccountedMsPerFrame: 0.8,
        frameMsAvg: 8.33,
        gpuZoneSumMsPerFrame: 3.0,
        cpuOuterZoneSumMsPerFrame: 2.1,
        refreshCapped: true,
        refreshCapHz: 120,
        gpuBlindZones: [],
      },
      errors: [],
    });
    ok(
      'refresh cap → 🟠 lower-bound warning',
      capped.some((v) => v.includes('REFRESH-CAPPED') && v.includes('LOWER BOUND'))
    );
    ok(
      '10% unmeasured → no unmeasured verdict at all',
      !capped.some((v) => v.includes('UNMEASURED') || v.includes('outside every'))
    );
  }

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
      'verdicts + attribution come before every raw section',
      keys.indexOf('verdicts') < keys.indexOf('census') && keys.indexOf('attribution') < keys.indexOf('zones')
    );
    ok(
      'missing sections land as null, never undefined-holes',
      rep.census === null && rep.zones === null && rep.identity === null && rep.vram === null && rep.wholeImage === null
    );
    // Attribution is DERIVED here, not passed in: a caller that forgot it would
    // ship the exact blind spot the field exists to close.
    const withZones = assembleReckoningReport({
      generatedAt: 'x',
      sections: {
        zones: {
          frames: 10,
          durationMs: 610,
          rows: [{ id: 'geometry.worldDraw', cpuMsPerFrame: 0.1, gpuMsPerFrame: 2 }],
        },
      },
    });
    ok(
      'attribution is derived from zones automatically',
      withZones.attribution !== null && withZones.attribution.frames === 10
    );
    ok(
      'and its verdict reaches the top-level list',
      withZones.verdicts.some((v) => v.includes('UNMEASURED'))
    );
  }
}
