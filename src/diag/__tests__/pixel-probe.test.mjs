/**
 * Node verification for diag/pixel-probe.js — the half-float readback decoder, and probe v2 / v2.1's
 * pure helpers (drift verdict, gamma gain, row builder, exposure summary, context).
 */
import {
  halfFloatBitsToFloat32,
  decodeHalfFloatRgba,
  decodeByteRgba,
  diffProbeBuffers,
  srgbEncode,
  srgbEncodeUnclamped,
  linearToSrgbByte,
  expectedScreenBytes,
  decodeCanvasPixel,
  REC709_LUMA,
  luma709,
  judgePresentedDrift,
  gammaGain,
  GAIN_MIN_ALBEDO_SRGB,
  buffersAgree,
  compactMaskStack,
  buildProbeRow,
  summarizeExposure,
  EXPOSURE_SETTLED_STOPS,
  buildProbeContext,
} from '../pixel-probe.js';

const near = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

export function run(t) {
  const { ok } = t;

  // ---- REAL, OBSERVED data (2026-07-19) — the exact bit pattern
  // MapShine.sampleIllumPixel returned live, and the resultColor
  // region-darkness.js computed for that same region/pixel. This is a
  // regression anchor, not a synthetic case: if this ever stops matching,
  // either the decoder or the readback path broke. -----------------------
  ok(
    'the live-observed DARKEN-region bit pattern (14780) decodes to ~0.7173 (region-darkness.js resultColor)',
    near(halfFloatBitsToFloat32(14780), 0.7172549019607843, 0.002)
  );
  ok('the live-observed alpha bit pattern (15360) decodes to exactly 1.0', halfFloatBitsToFloat32(15360) === 1);

  // ---- known IEEE-754 binary16 reference values --------------------------
  ok('0x0000 decodes to 0', halfFloatBitsToFloat32(0x0000) === 0);
  ok('0x3c00 decodes to 1.0', halfFloatBitsToFloat32(0x3c00) === 1);
  ok('0xbc00 decodes to -1.0', halfFloatBitsToFloat32(0xbc00) === -1);
  ok('0x4000 decodes to 2.0', halfFloatBitsToFloat32(0x4000) === 2);
  ok('0x3800 decodes to 0.5', halfFloatBitsToFloat32(0x3800) === 0.5);
  ok('0x7c00 (max exponent, zero mantissa) decodes to +Infinity', halfFloatBitsToFloat32(0x7c00) === Infinity);
  ok(
    '0xfc00 (max exponent, sign set, zero mantissa) decodes to -Infinity',
    halfFloatBitsToFloat32(0xfc00) === -Infinity
  );
  ok('0x7e00 (max exponent, nonzero mantissa) decodes to NaN', Number.isNaN(halfFloatBitsToFloat32(0x7e00)));
  ok(
    'a subnormal bit pattern decodes to a tiny positive number, not NaN/Infinity',
    (() => {
      const v = halfFloatBitsToFloat32(0x0001);
      return Number.isFinite(v) && v > 0 && v < 1e-4;
    })()
  );
  ok(
    'a value beyond 16 bits is masked down, never throws or reads a sign bit that is not really set',
    (() => {
      // 0x1_3c00 (bit 16 set + 0x3c00) must decode identically to 0x3c00.
      return halfFloatBitsToFloat32(0x13c00) === halfFloatBitsToFloat32(0x3c00);
    })()
  );

  // ---- decodeHalfFloatRgba -------------------------------------------------
  ok(
    'decodes a real 4-element RGBA readback into normal 0..1-ish numbers',
    (() => {
      const [r, g, b, a] = decodeHalfFloatRgba([14780, 14780, 14780, 15360]);
      return near(r, 0.7173, 0.002) && near(g, 0.7173, 0.002) && near(b, 0.7173, 0.002) && a === 1;
    })()
  );
  ok(
    'null/undefined input reads as null, never throws',
    decodeHalfFloatRgba(null) === null && decodeHalfFloatRgba(undefined) === null
  );
  ok('a too-short array reads as null', decodeHalfFloatRgba([1, 2, 3]) === null);

  // ---- decodeByteRgba (occlusion.mask, UnsignedByteType — a different GPU
  // format than illum/lit/albedo/coloration, so a separate decode path) ----
  ok(
    "Foundry's occlusion clear colour [0,1,1,1] round-trips through its own byte encoding " +
      "([0,255,255,255]) back to [0,1,1,1] exactly (describeOcclusionMask's own documented clear value)",
    (() => {
      const [r, g, b, a] = decodeByteRgba([0, 255, 255, 255]);
      return r === 0 && g === 1 && b === 1 && a === 1;
    })()
  );
  ok(
    'a mid-range byte (128) decodes to ~0.502, not 0.5 (integer byte quantization, not a float shortcut)',
    near(decodeByteRgba([128, 128, 128, 128])[0], 128 / 255, 1e-9)
  );
  ok(
    'values are masked to 8 bits, never read a value above 1.0',
    decodeByteRgba([300, 0, 0, 0])[0] === (300 & 0xff) / 255
  );
  ok(
    'null/undefined input reads as null, never throws',
    decodeByteRgba(null) === null && decodeByteRgba(undefined) === null
  );
  ok('a too-short array reads as null', decodeByteRgba([1, 2, 3]) === null);

  // ---- diffProbeBuffers — the by-hand "point A vs point B" comparison,
  // automated -----------------------------------------------------------
  const bufA = {
    illum: { rgba: [0.717, 0.717, 0.717, 1] },
    lit: { rgba: [0.5, 0.5, 0.5, 1] },
  };
  const bufB = {
    illum: { rgba: [0.934, 0.934, 0.934, 1] },
    lit: { rgba: [0.5, 0.5, 0.5, 1] },
  };
  ok(
    'flags the exact live-observed region-boundary jump (0.717 -> 0.934) as the biggest, in the illum buffer',
    (() => {
      const d = diffProbeBuffers(bufA, bufB);
      return (
        d.biggestJump.buffer === 'illum' && d.biggestJump.channel === 'r' && near(d.biggestJump.absValue, 0.217, 0.001)
      );
    })()
  );
  ok(
    'an identical buffer contributes zero delta and is never picked as the biggest jump',
    diffProbeBuffers(bufA, bufB).perBuffer.lit.every((v) => v === 0)
  );
  ok(
    'a buffer missing from one side is skipped, not thrown on',
    diffProbeBuffers({ illum: { rgba: [0, 0, 0, 1] } }, { illum: { rgba: [1, 1, 1, 1] } }, {}).perBuffer.illum !==
      undefined
  );
  ok(
    'either side missing reads as null, never throws',
    diffProbeBuffers(null, bufB) === null && diffProbeBuffers(bufA, null) === null
  );
  ok(
    'two buffers sharing no keys read as null',
    diffProbeBuffers({ a: { rgba: [0, 0, 0, 0] } }, { b: { rgba: [0, 0, 0, 0] } }) === null
  );

  // ---- PROBE v2 (2026-11-08, mmp-78u.12), anchored on numbers the MSA Lab measured. ----
  ok('sRGB encode: 0 -> 0, 1 -> 1', srgbEncode(0) === 0 && near(srgbEncode(1), 1));
  ok('linear 0.2195 (sRGB 129 floor) encodes back to byte 129', linearToSrgbByte(0.2195) === 129);
  ok('lab Measure-view lit 0.184 encodes to 119 (screen read 116: a -3 tone curve)', linearToSrgbByte(0.184) === 119);
  ok(
    'bgra canvas bytes are swapped to rgb',
    JSON.stringify(decodeCanvasPixel([10, 20, 30, 255], 'bgra8unorm')) === '[30,20,10,255]'
  );
  ok(
    'rgba canvas bytes pass through',
    JSON.stringify(decodeCanvasPixel([10, 20, 30, 255], 'rgba8unorm')) === '[10,20,30,255]'
  );
  ok('a short canvas read is null', decodeCanvasPixel([1, 2], 'rgba8unorm') === null);
  {
    // Healthy: lab noon, Measure view, floor 128 — lit 0.184 (encodes 119) presented as 116.
    const healthy = judgePresentedDrift({ lit: [0.184, 0.189, 0.204], presented: [116, 117, 122, 255] });
    ok(
      'healthy present (lab noon, -3 tone) is ok, on luma (-3.0) and per channel',
      healthy.verdict === 'ok' && healthy.lumaDrift === -3 && healthy.channelMaxAbs <= 4
    );
    ok(
      'the expected bytes and per-channel drift stay in the report (lab noon: 119/120/125, all -3)',
      JSON.stringify(healthy.expected) === '[119,120,125]' && healthy.drift.every((d) => d === -3)
    );
    // The Lens freeze (mmp-78u.7): black wedge step, lit 0, screen showed ~98.
    const frozen = judgePresentedDrift({ lit: [0, 0, 0], presented: [98, 99, 103, 255] });
    ok(
      'the Lens-freeze reading is suspect (luma +99.1; worst channel 103 kept as channelMaxAbs)',
      frozen.verdict === 'suspect' && frozen.lumaDrift === 99.1 && frozen.channelMaxAbs === 103
    );
    ok("v2's maxAbs is renamed channelMaxAbs, not kept twice", !('maxAbs' in frozen));
    // As shipped noon pulls 128 down ~20 (DR/grade): noticeable, not alarming.
    const shipped = judgePresentedDrift({ lit: [0.184, 0.189, 0.204], presented: [106, 106, 107, 255] });
    ok('as-shipped -13..-18 drift stays ok (luma -14.1)', shipped.verdict === 'ok' && shipped.lumaDrift === -14.1);
    ok('a missing side gives null', judgePresentedDrift({ lit: null, presented: [1, 2, 3] }) === null);
    ok(
      'a short presented triple gives null',
      judgePresentedDrift({ lit: [0.1, 0.1, 0.1], presented: [1, 2] }) === null
    );

    // v2.1: SATURATION IS NOT A DRIFT. A saturated cyan whose red the present pulls 43 -> 2 (the lab's cyan
    // chip) while green/blue barely move: 41 levels on one channel used to read 'check'; its brightness
    // moved 6.9 levels of luma, so it is ok. (G/B values illustrative; the 43 -> 2 red is the lab's.)
    const cyanLit = [0.02416, 0.55201, 0.57758]; // encodes to [43, 196, 200]
    const cyan = judgePresentedDrift({ lit: cyanLit, presented: [2, 198, 205, 255] });
    ok('the cyan chip encodes to the expected 43/196/200', JSON.stringify(cyan.expected) === '[43,196,200]');
    ok(
      'a saturated colour losing 41 levels of red with its brightness held is ok on luma (-6.9), not check',
      cyan.channelMaxAbs === 41 && cyan.lumaDrift === -6.9 && cyan.verdict === 'ok'
    );
    // Brightness changes are still caught, with the thresholds unchanged.
    const brighter = judgePresentedDrift({ lit: [0.184, 0.184, 0.184], presented: [159, 159, 159, 255] });
    ok('a grey lifted 40 levels is check (luma +40)', brighter.verdict === 'check' && brighter.lumaDrift === 40);
    const darker = judgePresentedDrift({ lit: [0.184, 0.184, 0.184], presented: [55, 55, 55, 255] });
    ok('a grey dropped 64 levels is suspect (the 64 boundary is suspect)', darker.verdict === 'suspect');
    ok(
      'thresholds still take an override (luma 40 >= 30 check, < 50 suspect)',
      judgePresentedDrift({ lit: [0.184, 0.184, 0.184], presented: [159, 159, 159] }, { check: 30, suspect: 50 })
        .verdict === 'check'
    );
    ok(
      'lumaDrift comes from the unrounded lumas (cyan: 156.8 - 163.8 reads -6.9, not -7.0)',
      cyan.lumaExpected === 163.8 && cyan.lumaPresented === 156.8
    );
  }

  // ---- PROBE v2.1 primitives -------------------------------------------------------------------
  ok(
    'Rec.709 luma weights sum to 1, so a grey keeps its level',
    near(REC709_LUMA[0] + REC709_LUMA[1] + REC709_LUMA[2], 1, 1e-12) && near(luma709([128, 128, 128]), 128, 1e-9)
  );
  ok('luma of a short triple is null', luma709([1, 2]) === null && luma709(null) === null);
  ok(
    'expectedScreen is OETF(lit) bytes per channel, null for a missing lit',
    JSON.stringify(expectedScreenBytes([0.184, 0.189, 0.204, 1])) === '[119,120,125]' &&
      expectedScreenBytes(null) === null &&
      expectedScreenBytes([0.1]) === null
  );
  ok(
    'the unclamped encode agrees with srgbEncode inside 0..1',
    [0, 0.002, 0.0031308, 0.05, 0.184, 0.5, 1].every((v) => near(srgbEncodeUnclamped(v), srgbEncode(v), 1e-12))
  );
  ok(
    'past 1 the unclamped encode keeps rising (lit 1.0664 -> 1.0286) where srgbEncode stops at 1',
    near(srgbEncodeUnclamped(1.0664), 1.0286, 1e-4) && near(srgbEncode(1.0664), 1, 1e-12)
  );
  ok(
    'the unclamped encode floors negatives and junk at 0',
    srgbEncodeUnclamped(-1) === 0 && srgbEncodeUnclamped('x') === 0
  );
  {
    // Noon daylight, no lamp: lit = EOTF(OETF(0.22) x illum) — the lab's noon illum 0.922/0.933/0.966. The
    // gain is exactly the daylight multiplier (the round trip is exact).
    const eotf = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const noonIllum = [0.922, 0.933, 0.966];
    const noonLit = noonIllum.map((il) => eotf(srgbEncode(0.22) * il));
    const g = gammaGain(noonLit, [0.22, 0.22, 0.22]);
    ok(
      'noon daylight: gain = the daylight multiplier exactly (0.922 / 0.933 / 0.966)',
      g.every((v, i) => near(v, noonIllum[i], 1e-4))
    );
    ok(
      'that noon lit is the lab-measured 0.184/0.189/0.204 (the composite law, from the other side)',
      near(noonLit[0], 0.184, 0.001) && near(noonLit[1], 0.189, 0.001) && near(noonLit[2], 0.204, 0.001)
    );
    // A REAL lab reading (check-walls.json, shipped view, cell normal/lampNear, point 'lit': a lamp 75 px
    // away under a 0.9-darkness Region). gain = illum + coloration / OETF(albedo) per the composite law.
    const albedo = [0.2303, 0.2235, 0.2303];
    const illum = [1, 1, 1];
    const coloration = [0.5117, 0.4358, 0.3213];
    const lit = [1.0664, 0.8809, 0.6709];
    const lamp = gammaGain(lit, albedo);
    const law = albedo.map((a, i) => illum[i] + coloration[i] / srgbEncode(a));
    ok(
      'a real lamp-lit reading: gain matches illum + coloration / OETF(albedo) within 0.002 (1.989/1.854/1.621)',
      lamp.every((v, i) => near(v, law[i], 0.002))
    );
    ok(
      'its red (lit 1.0664, past 1) is NOT capped at 1/OETF(albedo) = 1.934, as a clamped encode would be',
      lamp[0] > 1 / srgbEncode(albedo[0]) + 0.03
    );
    ok(
      'gain carries 4 decimals',
      lamp.every((v) => Number.isFinite(v) && near(v * 1e4, Math.round(v * 1e4), 1e-6))
    );
    const black = gammaGain([0.01, 0.2, 0.2], [0.0001, 0.2, 0.2]);
    ok(
      `art at or below ${GAIN_MIN_ALBEDO_SRGB} in gamma reads null on that channel only (black art: no ratio)`,
      black[0] === null && near(black[1], 1, 1e-4) && near(black[2], 1, 1e-4)
    );
    ok('a missing lit or albedo gives null', gammaGain(null, albedo) === null && gammaGain(lit, [0.2]) === null);
  }
  {
    // buildProbeRow: one v2.1 row from a sample.
    const buffers = {
      illum: { rgba: [0.922, 0.933, 0.966, 1] },
      lit: { rgba: [0.184, 0.189, 0.204, 1] },
      albedo: { rgba: [0.22, 0.22, 0.22, 1] },
      coloration: { rgba: [0, 0, 0, 1] },
      occlusion: { rgba: [0, 1, 1, 1] },
      attr: { rgba: [2 / 255, 1, 0, 1] },
    };
    const items = [{ id: 'tile1' }];
    // FRICTION #19: an off-screen point's sample still carried buffers read at the CLAMPED edge pixel.
    const off = buildProbeRow(
      { worldX: -500, worldY: 10, pixel: { x: 0, y: 5 }, onScreen: false, buffers, itemsAtPoint: items },
      { name: 'far', presented: [10, 10, 10, 255] }
    );
    ok(
      'an off-screen row nulls every buffer-derived field (even if a clamped edge read came back)',
      off.albedo === null &&
        off.illum === null &&
        off.lit === null &&
        off.coloration === null &&
        off.presented === null &&
        off.drift === null &&
        off.gain === null &&
        off.expectedScreen === null &&
        off.floorIndex === null &&
        off.outdoors01 === null
    );
    ok(
      "an off-screen row keeps onScreen:false, says reason 'off-screen', and drops the clamped pixel",
      off.onScreen === false && off.reason === 'off-screen' && off.pixel === null
    );
    ok(
      'an off-screen row keeps its name, world point and the CPU itemsAtPoint',
      off.name === 'far' && off.worldX === -500 && off.worldY === 10 && off.itemsAtPoint === items
    );
    ok(
      "a sample's own reason ('no view') is kept",
      buildProbeRow({ worldX: 1, worldY: 2, onScreen: false, buffers: null, reason: 'no view' }).reason === 'no view'
    );
    const on = buildProbeRow(
      { worldX: 100, worldY: 200, pixel: { x: 50, y: 60 }, onScreen: true, buffers, itemsAtPoint: items },
      { name: 'floor', presented: [116, 117, 122, 255] }
    );
    ok(
      'an on-screen row decodes floor and outdoors from attr',
      on.floorIndex === 2 && on.outdoors01 === 1 && on.reason === null && on.pixel.x === 50
    );
    ok(
      'an on-screen row carries 3-channel buffers, gain, expectedScreen and presented',
      on.lit.length === 3 &&
        on.albedo.length === 3 &&
        on.gain.length === 3 &&
        JSON.stringify(on.expectedScreen) === '[119,120,125]' &&
        JSON.stringify(on.presented) === '[116,117,122]'
    );
    ok(
      'the row drift is the luma verdict, and expectedScreen equals drift.expected',
      on.drift.verdict === 'ok' && JSON.stringify(on.drift.expected) === JSON.stringify(on.expectedScreen)
    );
    const noPres = buildProbeRow({ worldX: 1, worldY: 1, pixel: { x: 1, y: 1 }, onScreen: true, buffers });
    ok(
      'no presented read: presented and drift null, the buffers and gain still there',
      noPres.presented === null && noPres.drift === null && noPres.gain !== null
    );
    ok(
      'the row keys are the documented v2.1 shape, in order',
      Object.keys(on).join(',') ===
        'name,worldX,worldY,pixel,onScreen,reason,floorIndex,outdoors01,albedo,illum,lit,coloration,gain,' +
          'expectedScreen,presented,drift,itemsAtPoint'
    );
    ok('a null sample never throws and reads off-screen', buildProbeRow(null).onScreen === false);
  }
  {
    // summarizeExposure: the viewer's getDynamicRangeInfo() copy, shapes as stepDynamicRange leaves them.
    ok('no info (no viewer) gives null', summarizeExposure(null) === null);
    ok('a skipped info gives null', summarizeExposure({ skipped: true, reason: 'viewer not started' }) === null);
    const off = summarizeExposure({ on: false, curve: null, gated: null, logIllum: -1, ev: 0.7 });
    ok(
      "Dynamic Range off: state 'off', no exposure figures (a stale dr.ev is not reported)",
      off.enabled === false && off.state === 'off' && off.ev === null && off.multiplier === null
    );
    const waiting = summarizeExposure({ on: true, curve: null, gated: null, logIllum: 0, applied: { on: 0, ev: 0 } });
    ok("enabled with no meter reading yet: state 'waiting'", waiting.state === 'waiting' && waiting.ev === null);
    const base = {
      on: true,
      curve: { ev: 0.5 },
      ev: 0.5,
      logIllum: -1.2,
      gated: -1.2,
      gate: { t: 10, holdUntil: 0 },
      applied: { on: 1, ev: 0.5 },
    };
    const settled = summarizeExposure(base);
    ok(
      "on and at its target: state 'settled', ev 0.5, multiplier 2^0.5",
      settled.state === 'settled' && settled.ev === 0.5 && near(settled.multiplier, Math.SQRT2, 1e-4)
    );
    ok(
      'the metered light and its target ride along (log2)',
      settled.meteredLog2 === -1.2 && settled.targetLog2 === -1.2 && settled.held === false
    );
    const adapting = summarizeExposure({ ...base, gated: -1.2 + 4 * EXPOSURE_SETTLED_STOPS });
    ok("more than EXPOSURE_SETTLED_STOPS from its target: state 'adapting'", adapting.state === 'adapting');
    const nearly = summarizeExposure({ ...base, gated: -1.2 + EXPOSURE_SETTLED_STOPS / 2 });
    ok('within EXPOSURE_SETTLED_STOPS counts as settled', nearly.state === 'settled');
    ok(
      'holdExposure in force reads held',
      summarizeExposure({ ...base, gate: { t: 10, holdUntil: 12 } }).held === true
    );
    ok(
      'ev is the live uniform the present applies when the info carries it',
      summarizeExposure({ ...base, curve: { ev: 0.4 }, applied: { on: 1, ev: 0.25 } }).ev === 0.25
    );
    ok('a non-object info gives null, never throws', summarizeExposure('x') === null);
  }
  {
    // buildProbeContext: the state a reading was taken in.
    const at = new Date(Date.UTC(2026, 10, 9, 1, 2, 3));
    const ctx = buildProbeContext({
      camera: { x: 4500.04, y: 3375.06, scale: 0.80004, source: 'viewer' },
      dynamicRange: { on: true, curve: { ev: 1 }, logIllum: -2, gated: -2, applied: { on: 1, ev: 1 } },
      forced: [
        { id: 'bloom', enabled: false },
        { id: 'grade', enabled: false },
        { id: 'grid', enabled: true },
      ],
      todHour: 12.0004,
      sceneId: 'lab0000000000001',
      levelId: 'lvl0000000000001',
      at,
    });
    ok(
      'context keys are the documented shape, in order',
      Object.keys(ctx).join(',') === 'camera,exposure,forcedEffects,todHour,sceneId,levelId,at,errors'
    );
    ok(
      'camera is rounded (x/y 0.1 px, scale 4 decimals) and says where it came from',
      ctx.camera.x === 4500 && ctx.camera.y === 3375.1 && ctx.camera.scale === 0.8 && ctx.camera.source === 'viewer'
    );
    ok('exposure is the summary', ctx.exposure.state === 'settled' && ctx.exposure.multiplier === 2);
    ok(
      'forced effects split into on / off',
      JSON.stringify(ctx.forcedEffects) === JSON.stringify({ on: ['grid'], off: ['bloom', 'grade'] })
    );
    ok(
      'hour, scene, level, time and no errors',
      ctx.todHour === 12 &&
        ctx.sceneId === 'lab0000000000001' &&
        ctx.levelId === 'lvl0000000000001' &&
        ctx.at === '2026-11-09T01:02:03.000Z' &&
        ctx.errors.length === 0
    );
    const empty = buildProbeContext();
    ok(
      'with nothing known every field is null (forcedEffects null = not available), errors empty',
      empty.camera === null &&
        empty.exposure === null &&
        empty.forcedEffects === null &&
        empty.todHour === null &&
        empty.sceneId === null &&
        empty.levelId === null &&
        Array.isArray(empty.errors) &&
        empty.errors.length === 0
    );
    ok('at defaults to now, as an ISO time', typeof empty.at === 'string' && Number.isFinite(Date.parse(empty.at)));
    ok(
      'an empty forced ledger is {on:[], off:[]}',
      JSON.stringify(buildProbeContext({ forced: [] }).forcedEffects) === '{"on":[],"off":[]}'
    );
    const junk = buildProbeContext({
      camera: { x: NaN, y: 1, scale: 1 },
      dynamicRange: 'nope',
      forced: [null, { id: 3 }, { id: 'x', enabled: 'yes' }],
      todHour: 'noon',
      sceneId: 42,
      levelId: '',
      at: 'not a time',
      errors: ['exposure: boom'],
    });
    ok(
      'malformed parts read as null, never throw; errors pass through',
      junk.camera === null &&
        junk.exposure === null &&
        junk.todHour === null &&
        junk.sceneId === null &&
        junk.levelId === null &&
        junk.at === null &&
        junk.errors[0] === 'exposure: boom' &&
        JSON.stringify(junk.forcedEffects) === '{"on":[],"off":[]}'
    );
    ok(
      'a zero or negative scale is not a camera',
      buildProbeContext({ camera: { x: 1, y: 1, scale: 0 } }).camera === null
    );
    ok('a non-object parts argument never throws', buildProbeContext(null).camera === null);
  }
  {
    const A = {
      illum: { rgba: [0.922, 0.933, 0.966, 1] },
      lit: { rgba: [0.184, 0.189, 0.204, 1] },
      albedo: { rgba: [0.22, 0.22, 0.22, 1] },
    };
    const B = {
      illum: { rgba: [0.922, 0.933, 0.966, 1] },
      lit: { rgba: [0.488, 0.4, 0.4, 1] },
      albedo: { rgba: [0.22, 0.22, 0.22, 1] },
    };
    ok('identical reads agree', buffersAgree(A, A));
    ok('a mid-rebuild garbage read (lit 0.488 vs 0.184) does not agree', !buffersAgree(A, B));
    ok('a missing buffer never agrees', !buffersAgree(A, { illum: A.illum }));
  }
  {
    const stack = {
      floors: [
        {
          floorIndex: 0,
          name: 'Basement',
          masks: { outdoors: { compositedByte: 0, sourceCount: 1 } },
          derived: { coverAbove: 255 },
        },
        {
          floorIndex: 1,
          name: 'Ground',
          masks: { outdoors: { compositedByte: 255, sourceCount: 1 }, fire: { compositedByte: null, sourceCount: 0 } },
          derived: { coverAbove: 0, skyReach: 0, casterHeight: 32 },
        },
      ],
    };
    const c = compactMaskStack(stack, 1);
    ok('compact mask stack picks the asked floor', c.floor === 'Ground' && c.masks.outdoors === 255);
    ok('kinds with no source are left out', !('fire' in c.masks));
    ok('derived products ride along', c.derived.casterHeight === 32);
    ok('no stack gives null', compactMaskStack(null, 0) === null);
  }
}
