import {
  normalizeKeyframe,
  normalizeCameraPath,
  buildCameraTimeline,
  totalTimelineDurationMs,
  buildTrapezoidalEasing,
  resolveEasingFn,
  computeTransitionDistanceRatio,
  resolveCameraPathViewport,
  generateKeyframePreset,
  CAMERA_PATH_PRESETS,
  LONG_JUMP_FADE_RATIO,
  FADE_CUT_HOLD_MS,
  SHOT_CUT_HOLD_MS,
  INTRO_HOLD_MS,
  DEFAULT_SETTINGS,
} from '../camera-path.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  // ---- normalizeKeyframe ----------------------------------------------------
  ok(
    'valid keyframe passes through',
    (() => {
      const kf = normalizeKeyframe({ x: 10, y: 20, scale: 1.5, holdMs: 500 });
      return kf && kf.x === 10 && kf.y === 20 && kf.scale === 1.5 && kf.holdMs === 500;
    })()
  );
  ok('missing x/y is rejected (no place to point the camera)', normalizeKeyframe({ scale: 1 }) === null);
  ok('non-finite x/y is rejected', normalizeKeyframe({ x: NaN, y: 0, scale: 1 }) === null);
  ok('missing scale defaults to 1', normalizeKeyframe({ x: 0, y: 0 }).scale === 1);
  ok('missing holdMs defaults to 0', normalizeKeyframe({ x: 0, y: 0 }).holdMs === 0);
  ok('negative holdMs clamps to 0', normalizeKeyframe({ x: 0, y: 0, holdMs: -500 }).holdMs === 0);
  ok('absurd holdMs clamps to the 10-minute cap', normalizeKeyframe({ x: 0, y: 0, holdMs: 1e9 }).holdMs === 600_000);
  ok('zero/negative scale clamps to the floor, never 0', normalizeKeyframe({ x: 0, y: 0, scale: -3 }).scale === 0.01);

  // ---- normalizeCameraPath --------------------------------------------------
  ok(
    'undefined input is a valid empty path, not a throw',
    (() => {
      const p = normalizeCameraPath(undefined);
      return Array.isArray(p.keyframes) && p.keyframes.length === 0 && p.settings.sweepMs === DEFAULT_SETTINGS.sweepMs;
    })()
  );
  ok(
    'a malformed keyframe is dropped, valid ones survive',
    (() => {
      const p = normalizeCameraPath({ keyframes: [{ x: 0, y: 0 }, { garbage: true }, { x: 5, y: 5 }] });
      return p.keyframes.length === 2;
    })()
  );
  ok(
    'settings pass through when valid',
    (() => {
      const p = normalizeCameraPath({ settings: { sweepMs: 2000, easing: 'linear', hideUi: false } });
      return p.settings.sweepMs === 2000 && p.settings.easing === 'linear' && p.settings.hideUi === false;
    })()
  );
  ok(
    "an unrecognized easing string falls back to the default ('cosine')",
    (() => {
      const p = normalizeCameraPath({ settings: { easing: 'bogus' } });
      return p.settings.easing === 'cosine';
    })()
  );

  // ---- buildCameraTimeline ---------------------------------------------------
  ok(
    'zero keyframes -> zero segments',
    buildCameraTimeline({ keyframes: [], settings: DEFAULT_SETTINGS }).length === 0
  );
  ok(
    'one keyframe with no hold -> zero segments (nothing to sweep or hold)',
    (() => {
      const segs = buildCameraTimeline({
        keyframes: [{ x: 0, y: 0, scale: 1, holdMs: 0 }],
        settings: DEFAULT_SETTINGS,
      });
      return segs.length === 0;
    })()
  );
  ok(
    'one keyframe WITH a hold -> a single hold segment (a still shot)',
    (() => {
      const segs = buildCameraTimeline({
        keyframes: [{ x: 0, y: 0, scale: 1, holdMs: 1000 }],
        settings: DEFAULT_SETTINGS,
      });
      return segs.length === 1 && segs[0].type === 'hold' && segs[0].durationMs === 1000;
    })()
  );
  ok(
    'two keyframes, no holds -> exactly one sweep',
    (() => {
      const segs = buildCameraTimeline({
        keyframes: [
          { x: 0, y: 0, scale: 1, holdMs: 0 },
          { x: 100, y: 100, scale: 2, holdMs: 0 },
        ],
        settings: DEFAULT_SETTINGS,
      });
      return (
        segs.length === 1 &&
        segs[0].type === 'sweep' &&
        segs[0].from.x === 0 &&
        segs[0].to.x === 100 &&
        segs[0].to.scale === 2
      );
    })()
  );
  ok(
    'three keyframes with a middle hold -> sweep, hold, sweep, in order',
    (() => {
      const segs = buildCameraTimeline({
        keyframes: [
          { x: 0, y: 0, scale: 1, holdMs: 0 },
          { x: 10, y: 10, scale: 1, holdMs: 2000 },
          { x: 20, y: 20, scale: 1, holdMs: 0 },
        ],
        settings: DEFAULT_SETTINGS,
      });
      return (
        segs.length === 3 &&
        segs[0].type === 'sweep' &&
        segs[1].type === 'hold' &&
        segs[1].durationMs === 2000 &&
        segs[2].type === 'sweep'
      );
    })()
  );
  ok(
    'a leading hold on keyframe 0 comes first',
    (() => {
      const segs = buildCameraTimeline({
        keyframes: [
          { x: 0, y: 0, scale: 1, holdMs: 1500 },
          { x: 10, y: 10, scale: 1, holdMs: 0 },
        ],
        settings: DEFAULT_SETTINGS,
      });
      return segs.length === 2 && segs[0].type === 'hold' && segs[1].type === 'sweep';
    })()
  );
  ok(
    'totalTimelineDurationMs sums every segment',
    (() => {
      const segs = buildCameraTimeline({
        keyframes: [
          { x: 0, y: 0, scale: 1, holdMs: 1000 },
          { x: 10, y: 10, scale: 1, holdMs: 500 },
        ],
        settings: { ...DEFAULT_SETTINGS, sweepMs: 3000 },
      });
      return totalTimelineDurationMs(segs) === 1000 + 3000 + 500;
    })()
  );

  // ---- buildTrapezoidalEasing ------------------------------------------------
  ok('trapezoidal easing starts at exactly 0', near(buildTrapezoidalEasing(10000)(0), 0));
  ok('trapezoidal easing ends at exactly 1', near(buildTrapezoidalEasing(10000)(1), 1));
  ok('trapezoidal easing is symmetric around the midpoint (0.5 -> 0.5)', near(buildTrapezoidalEasing(10000)(0.5), 0.5));
  ok(
    'trapezoidal easing is monotonically non-decreasing',
    (() => {
      const fn = buildTrapezoidalEasing(8000);
      let prev = -Infinity;
      for (let i = 0; i <= 20; i++) {
        const v = fn(i / 20);
        if (v < prev - 1e-9) return false;
        prev = v;
      }
      return true;
    })()
  );
  ok(
    'a duration shorter than 2x the accel time still starts at 0 and ends at 1 (degenerate pure ramp)',
    (() => {
      const fn = buildTrapezoidalEasing(1000); // accelMs=3000 > durationMs/2 -> f clamps to 0.5
      return near(fn(0), 0) && near(fn(1), 1) && near(fn(0.5), 0.5);
    })()
  );
  ok(
    'a very long duration approaches linear (negligible accel fraction)',
    (() => {
      const fn = buildTrapezoidalEasing(3_000_000); // f = 3000/3e6 = 0.001, nearly linear
      return near(fn(0.5), 0.5, 0.01);
    })()
  );

  // ---- resolveEasingFn --------------------------------------------------------
  ok(
    'resolveEasingFn("cosine", ...) defers to Foundry\'s own default (undefined)',
    resolveEasingFn('cosine', 4000) === undefined
  );
  ok('resolveEasingFn(unrecognized, ...) also defers to undefined', resolveEasingFn('nonsense', 4000) === undefined);
  ok(
    'resolveEasingFn("linear", ...) is the identity function',
    (() => {
      const fn = resolveEasingFn('linear', 4000);
      return typeof fn === 'function' && fn(0.37) === 0.37;
    })()
  );
  ok(
    'resolveEasingFn("trapezoidal", ...) returns a real easing function',
    (() => {
      const fn = resolveEasingFn('trapezoidal', 4000);
      return typeof fn === 'function' && near(fn(0), 0) && near(fn(1), 1);
    })()
  );

  // ---- normalizeCameraPath: the new settings fields --------------------------
  ok(
    'letterbox/longJumpFadeCut/darknessRamp all default sanely on empty input',
    (() => {
      const p = normalizeCameraPath(undefined);
      return (
        p.settings.letterbox === false &&
        p.settings.longJumpFadeCut === true &&
        p.settings.darknessRamp.enabled === false &&
        p.settings.darknessRamp.start01 === 0 &&
        p.settings.darknessRamp.end01 === 1
      );
    })()
  );
  ok(
    'letterbox/darknessRamp pass through when authored',
    (() => {
      const p = normalizeCameraPath({
        settings: {
          letterbox: true,
          longJumpFadeCut: false,
          darknessRamp: { enabled: true, start01: 0.1, end01: 0.9 },
        },
      });
      return (
        p.settings.letterbox === true &&
        p.settings.longJumpFadeCut === false &&
        p.settings.darknessRamp.enabled === true &&
        near(p.settings.darknessRamp.start01, 0.1) &&
        near(p.settings.darknessRamp.end01, 0.9)
      );
    })()
  );
  ok(
    'darknessRamp start01/end01 clamp into [0,1]',
    (() => {
      const p = normalizeCameraPath({ settings: { darknessRamp: { start01: -5, end01: 50 } } });
      return p.settings.darknessRamp.start01 === 0 && p.settings.darknessRamp.end01 === 1;
    })()
  );

  // ---- computeTransitionDistanceRatio -----------------------------------------
  ok(
    'zero distance -> zero ratio',
    computeTransitionDistanceRatio({ x: 0, y: 0 }, { x: 0, y: 0 }, { width: 1000, height: 1000 }) === 0
  );
  ok(
    'a pan across the full width of a square map -> ratio 1',
    near(computeTransitionDistanceRatio({ x: 0, y: 0 }, { x: 1000, y: 0 }, { width: 1000, height: 1000 }), 1)
  );
  ok(
    'ratio is scale-independent — uses the LONGEST map axis',
    near(computeTransitionDistanceRatio({ x: 0, y: 0 }, { x: 500, y: 0 }, { width: 1000, height: 5000 }), 0.1)
  );

  // ---- buildCameraTimeline: the long-jump fade-cut heuristic ------------------
  ok(
    'without mapDims, every gap is a plain sweep (backward compatible)',
    (() => {
      const segs = buildCameraTimeline({
        keyframes: [
          { x: 0, y: 0, scale: 1, holdMs: 0 },
          { x: 100000, y: 0, scale: 1, holdMs: 0 },
        ],
        settings: DEFAULT_SETTINGS,
      });
      return segs.length === 1 && segs[0].type === 'sweep';
    })()
  );
  ok(
    'a jump exceeding the ratio threshold becomes a fadecut, not a sweep',
    (() => {
      const segs = buildCameraTimeline(
        {
          keyframes: [
            { x: 0, y: 0, scale: 1, holdMs: 0 },
            { x: 900, y: 0, scale: 1, holdMs: 0 }, // 0.9 of map size > 0.33 threshold
          ],
          settings: DEFAULT_SETTINGS,
        },
        { width: 1000, height: 1000 }
      );
      return (
        segs.length === 1 && segs[0].type === 'fadecut' && segs[0].to.x === 900 && segs[0].holdMs === FADE_CUT_HOLD_MS
      );
    })()
  );
  ok(
    'a short jump stays a sweep even with mapDims present',
    (() => {
      const segs = buildCameraTimeline(
        {
          keyframes: [
            { x: 0, y: 0, scale: 1, holdMs: 0 },
            { x: 50, y: 0, scale: 1, holdMs: 0 }, // 0.05 of map size, well under threshold
          ],
          settings: DEFAULT_SETTINGS,
        },
        { width: 1000, height: 1000 }
      );
      return segs.length === 1 && segs[0].type === 'sweep';
    })()
  );
  ok(
    'longJumpFadeCut:false disables the heuristic even on a huge jump',
    (() => {
      const segs = buildCameraTimeline(
        {
          keyframes: [
            { x: 0, y: 0, scale: 1, holdMs: 0 },
            { x: 900, y: 0, scale: 1, holdMs: 0 },
          ],
          settings: { ...DEFAULT_SETTINGS, longJumpFadeCut: false },
        },
        { width: 1000, height: 1000 }
      );
      return segs.length === 1 && segs[0].type === 'sweep';
    })()
  );
  ok(`LONG_JUMP_FADE_RATIO is V2's own 0.33`, near(LONG_JUMP_FADE_RATIO, 0.33));

  // ---- totalTimelineDurationMs: fadecut counts BOTH fade halves --------------
  ok(
    'a fadecut segment contributes 2x its holdMs to the total',
    (() => {
      const segs = [{ type: 'fadecut', to: { x: 0, y: 0, scale: 1 }, holdMs: 500 }];
      return totalTimelineDurationMs(segs) === 1000;
    })()
  );

  // ---- resolveCameraPathViewport -----------------------------------------------
  ok(
    'no letterbox -> full viewport, unchanged',
    (() => {
      const v = resolveCameraPathViewport(1920, 1080, false);
      return v.width === 1920 && v.height === 1080;
    })()
  );
  ok(
    'letterbox enabled shrinks the usable HEIGHT only (bars are horizontal bands)',
    (() => {
      const v = resolveCameraPathViewport(1920, 1080, true);
      return v.width === 1920 && v.height < 1080 && v.height === 1080 * (1 - 0.12);
    })()
  );

  // ---- generateKeyframePreset --------------------------------------------------
  const SQUARE_DIMS = { sceneX: 0, sceneY: 0, sceneWidth: 4000, sceneHeight: 4000 };
  ok(
    'unrecognized preset id returns null',
    generateKeyframePreset('bogus', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }) === null
  );
  ok(
    'zero-area dims returns null, never NaN keyframes',
    (() => {
      return (
        generateKeyframePreset('full', { dims: { sceneWidth: 0, sceneHeight: 0 }, screenW: 1920, screenH: 1080 }) ===
        null
      );
    })()
  );
  for (const preset of CAMERA_PATH_PRESETS) {
    ok(
      `preset "${preset.id}" generates at least 2 finite keyframes`,
      (() => {
        const result = generateKeyframePreset(preset.id, { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 });
        if (!result || result.keyframes.length < 2) return false;
        return result.keyframes.every(
          (kf) => Number.isFinite(kf.x) && Number.isFinite(kf.y) && Number.isFinite(kf.scale) && kf.scale > 0
        );
      })()
    );
  }
  ok(
    'the "full" preset generates exactly 8 keyframes (the 4-stage cinematic)',
    (() => {
      const result = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 });
      return result.keyframes.length === 8;
    })()
  );
  ok(
    's_to_n and n_to_s are exact reverses of each other',
    (() => {
      const s2n = generateKeyframePreset('s_to_n', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      const n2s = generateKeyframePreset('n_to_s', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      return s2n[0].y === n2s[1].y && s2n[1].y === n2s[0].y;
    })()
  );

  // ---- sw_to_ne / ne_to_sw — rapid-diagonal-stress-2026-08-12 --------------
  ok(
    'sw_to_ne and ne_to_sw are exact reverses of each other',
    (() => {
      const sw2ne = generateKeyframePreset('sw_to_ne', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      const ne2sw = generateKeyframePreset('ne_to_sw', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      return (
        sw2ne[0].x === ne2sw[1].x && sw2ne[0].y === ne2sw[1].y && sw2ne[1].x === ne2sw[0].x && sw2ne[1].y === ne2sw[0].y
      );
    })()
  );
  ok(
    // Y increases SOUTH (feedback_y_flip_recurring_risk) — southwest must be
    // the LARGER y (further south) and the SMALLER x (further west); the
    // second keyframe (northeast) is the opposite on both axes. A flipped
    // axis here would silently sweep SE->NW or NW->SE instead, covering the
    // wrong diagonal while still "looking like" a corner-to-corner move.
    'sw_to_ne genuinely starts SOUTH-WEST (larger y, smaller x) and ends NORTH-EAST (smaller y, larger x)',
    (() => {
      const [sw, ne] = generateKeyframePreset('sw_to_ne', {
        dims: SQUARE_DIMS,
        screenW: 1920,
        screenH: 1080,
      }).keyframes;
      return sw.y > ne.y && sw.x < ne.x;
    })()
  );
  ok(
    'the diagonal preset also suggests longJumpFadeCut:false — it is the LONGEST possible pair on the map',
    generateKeyframePreset('sw_to_ne', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).suggestedLongJumpFadeCut ===
      false
  );
  ok(
    "every preset suggests V2's own 15s-per-leg pacing",
    (() => {
      const result = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 });
      return result.suggestedSweepMs === 15000;
    })()
  );

  // ---- cutBefore / the 'cut' segment type — V2's real 4-independent-shots behaviour ----
  ok(
    'normalizeKeyframe reads cutBefore, defaults false',
    normalizeKeyframe({ x: 0, y: 0 }).cutBefore === false &&
      normalizeKeyframe({ x: 0, y: 0, cutBefore: true }).cutBefore === true
  );
  ok(
    'a keyframe with cutBefore becomes a "cut" segment, not a "sweep"',
    (() => {
      const segs = buildCameraTimeline({
        keyframes: [
          { x: 0, y: 0, scale: 1, holdMs: 0, cutBefore: false },
          { x: 500, y: 500, scale: 1, holdMs: 0, cutBefore: true },
        ],
        settings: DEFAULT_SETTINGS,
      });
      return segs.length === 1 && segs[0].type === 'cut' && segs[0].to.x === 500 && segs[0].holdMs === SHOT_CUT_HOLD_MS;
    })()
  );
  ok(
    'cutBefore takes priority over the long-jump fadecut heuristic on the SAME gap',
    (() => {
      const segs = buildCameraTimeline(
        {
          keyframes: [
            { x: 0, y: 0, scale: 1, holdMs: 0, cutBefore: false },
            { x: 900, y: 0, scale: 1, holdMs: 0, cutBefore: true }, // would ALSO qualify as a long jump
          ],
          settings: DEFAULT_SETTINGS,
        },
        { width: 1000, height: 1000 }
      );
      return segs.length === 1 && segs[0].type === 'cut';
    })()
  );
  ok(
    'a "cut" segment contributes exactly its own holdMs to the total (not doubled like fadecut)',
    (() => {
      const segs = [{ type: 'cut', to: { x: 0, y: 0, scale: 1 }, holdMs: 800 }];
      return totalTimelineDurationMs(segs) === 800;
    })()
  );
  ok(`SHOT_CUT_HOLD_MS is V2's own 800ms segmentHoldMs`, SHOT_CUT_HOLD_MS === 800);
  ok(
    `INTRO_HOLD_MS is a one-second beat on black ("pause for a second", 2026-07-29 author spec)`,
    INTRO_HOLD_MS === 1000
  );

  // ---- the 'full' preset's shot structure — the actual bug report -----------
  ok(
    'the "full" preset marks keyframes C/E/G (indices 2,4,6) as cutBefore — the 4 independent shots',
    (() => {
      const result = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 });
      const kfs = result.keyframes;
      return (
        kfs[0].cutBefore === false && // A
        kfs[1].cutBefore === false && // B — shot 1 (A->B) is a plain sweep
        kfs[2].cutBefore === true && // C — shot 2 starts
        kfs[3].cutBefore === false && // D
        kfs[4].cutBefore === true && // E — shot 3 starts
        kfs[5].cutBefore === false && // F
        kfs[6].cutBefore === true && // G — shot 4 starts
        kfs[7].cutBefore === false // H
      );
    })()
  );
  ok(
    'the "full" preset\'s west-edge shot runs south (bottom) to north (top)',
    (() => {
      const kfs = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      return kfs[2].y > kfs[3].y; // C (bottom, larger y) -> D (top, smaller y)
    })()
  );
  ok(
    'the "full" preset\'s east-edge shot runs south (bottom) to north (top) — SAME direction as the west edge ' +
      '(2026-07-29 author spec: "we do the same to the right side", not V2\'s mirrored north->south)',
    (() => {
      const kfs = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      return kfs[4].y > kfs[5].y; // E (bottom, larger y) -> F (top, smaller y)
    })()
  );
  ok(
    'the "full" preset\'s shot-4 cut (G) lands exactly back on shot-1\'s zoom-in (B) — "cut to the middle of the ' +
      'map again", the SAME middle, before zooming back out',
    (() => {
      const kfs = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      return kfs[1].x === kfs[6].x && kfs[1].y === kfs[6].y && kfs[1].scale === kfs[6].scale;
    })()
  );
  ok(
    'the "full" preset\'s edge-sweep zoom frames roughly 50% of the map\'s WIDTH (author: "see roughly 50% of ' +
      'the map based on zoom") — the west edge sits a quarter of the way in from the scene\'s left border',
    (() => {
      // viewW=1920, sceneWidth=4000 -> sweepZoom = 1920/2000 = 0.96 ->
      // visibleWidth = 1920/0.96 = 2000 (exactly half of 4000) -> xL = 0 + 1000.
      const kfs = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      return near(kfs[2].x, 1000, 1) && near(kfs[4].x, 3000, 1); // C (west) and E (east)
    })()
  );
  ok(
    'the "full" preset\'s shot-1 zoom-in (B) and the edge sweeps (C-F) all share ONE consistent ~50% zoom level',
    (() => {
      const kfs = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      const [b, c, d, e, f] = [kfs[1], kfs[2], kfs[3], kfs[4], kfs[5]];
      return b.scale === c.scale && c.scale === d.scale && d.scale === e.scale && e.scale === f.scale;
    })()
  );
  ok(
    'the "full" preset produces exactly 4 shots: 1 sweep, cut, 1 sweep, cut, 1 sweep, cut, 1 sweep',
    (() => {
      const kfs = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      const segs = buildCameraTimeline({ keyframes: kfs, settings: DEFAULT_SETTINGS });
      const types = segs.map((s) => s.type);
      return types.join(',') === 'sweep,cut,sweep,cut,sweep,cut,sweep';
    })()
  );

  // ---- REGRESSION: every preset must suggest longJumpFadeCut:false --------
  // (2026-07-21 live bug: "the north south sweeps don't work, it just
  // immediately swaps" — every preset's points are deliberately far apart by
  // design, so the long-jump heuristic — meant for an ACCIDENTAL far-apart
  // pair — must not run on them at all, or it silently swaps the intended
  // sweep for a fade-cut. The real player always passes real mapDims, so a
  // test that omits mapDims (like the one above) cannot catch this.)
  for (const preset of CAMERA_PATH_PRESETS) {
    ok(
      `preset "${preset.id}" suggests longJumpFadeCut:false`,
      generateKeyframePreset(preset.id, { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 })
        .suggestedLongJumpFadeCut === false
    );
  }
  ok(
    'REGRESSION FIX (2026-07-29, 3rd occurrence — "the two side north-south sweeps aren\'t working, they cut to ' +
      'position instead of moving"): even with the DEFAULT settings (longJumpFadeCut:true) and REAL mapDims — ' +
      'matching a stale saved path or any caller that never reads suggestedLongJumpFadeCut — the "full" preset\'s ' +
      'edge sweeps (shots 2 and 3) now correctly stay smooth sweeps, because each one immediately follows a ' +
      'cutBefore keyframe (a shot that hard-cuts in is structurally immune to the long-jump heuristic now, not ' +
      'just by convention)',
    (() => {
      const kfs = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      const segs = buildCameraTimeline({ keyframes: kfs, settings: DEFAULT_SETTINGS }, { width: 4000, height: 4000 });
      const types = segs.map((s) => s.type);
      // shot 2 (index 2, C->D) and shot 3 (index 4, E->F) span most of the
      // map's height -> would have fired the long-jump heuristic under the
      // OLD rules -> must now stay 'sweep', not 'fadecut'.
      return types[2] === 'sweep' && types[4] === 'sweep';
    })()
  );
  ok(
    'the from.cutBefore exemption does NOT blanket-disable the long-jump heuristic for gaps that never followed a ' +
      'hard cut — a genuinely accidental huge pan between two plain (non-cutBefore) keyframes still fadecuts',
    (() => {
      const segs = buildCameraTimeline(
        {
          keyframes: [
            { x: 0, y: 0, scale: 1, holdMs: 0, cutBefore: false },
            { x: 900, y: 0, scale: 1, holdMs: 0, cutBefore: false },
          ],
          settings: DEFAULT_SETTINGS,
        },
        { width: 1000, height: 1000 }
      );
      return segs.length === 1 && segs[0].type === 'fadecut';
    })()
  );
  ok(
    "with the preset's OWN suggested settings (longJumpFadeCut:false), those same shots ALSO correctly stay smooth " +
      'sweeps (belt-and-suspenders with the from.cutBefore exemption above)',
    (() => {
      const result = generateKeyframePreset('full', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 });
      const settings = { ...DEFAULT_SETTINGS, longJumpFadeCut: result.suggestedLongJumpFadeCut };
      const segs = buildCameraTimeline({ keyframes: result.keyframes, settings }, { width: 4000, height: 4000 });
      const types = segs.map((s) => s.type);
      return types.join(',') === 'sweep,cut,sweep,cut,sweep,cut,sweep';
    })()
  );

  // ---- REGRESSION: the perf-benchmark N→S route (2026-07-28 live bug) -------
  // The SAME bug class as the 2026-07-21 'full'-preset regression above, hit
  // again by NEW code that consumed this module without re-checking its own
  // rule: "boot.js perf-benchmark: the camera didn't start at the north, it
  // just moved down and to the right and finished" — a north-to-south sweep
  // spans nearly the map's full height, so with the DEFAULT settings (which
  // boot.js built from scratch instead of reading `suggestedLongJumpFadeCut`
  // off the preset, per feedback_read_the_producer_never_invent_its_shape)
  // the ENTIRE 60-second sweep silently became a ~1-second fadecut: fade to
  // black, INSTANT SNAP straight to the south end (skipping the north start),
  // fade back in. This block proves the failure mode AND the fix, end to end
  // through the real pure functions, so a future caller of `generateKeyframePreset`
  // that forgets this cannot ship unnoticed.
  ok(
    "REGRESSION: n_to_s with DEFAULT settings and REAL map dims — what boot.js's first version actually built — " +
      'wrongly becomes a fadecut, proving the live symptom',
    (() => {
      const kfs = generateKeyframePreset('n_to_s', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 }).keyframes;
      const segs = buildCameraTimeline(
        { keyframes: kfs, settings: { ...DEFAULT_SETTINGS, sweepMs: 60000, easing: 'linear' } },
        { width: 4000, height: 4000 }
      );
      // A single fadecut segment, not a sweep — this IS "moved briefly, then
      // finished" instead of a 60-second traverse.
      return segs.length === 1 && segs[0].type === 'fadecut';
    })()
  );
  ok(
    "REGRESSION FIX: n_to_s with the preset's OWN suggested longJumpFadeCut is a real 60s sweep, start to finish",
    (() => {
      const result = generateKeyframePreset('n_to_s', { dims: SQUARE_DIMS, screenW: 1920, screenH: 1080 });
      const segs = buildCameraTimeline(
        {
          keyframes: result.keyframes,
          settings: {
            ...DEFAULT_SETTINGS,
            sweepMs: 60000,
            easing: 'linear',
            longJumpFadeCut: result.suggestedLongJumpFadeCut,
          },
        },
        { width: 4000, height: 4000 }
      );
      return (
        segs.length === 1 &&
        segs[0].type === 'sweep' &&
        segs[0].durationMs === 60000 &&
        // north (smaller y) -> south (larger y), matching the label.
        segs[0].from.y < segs[0].to.y
      );
    })()
  );
}
