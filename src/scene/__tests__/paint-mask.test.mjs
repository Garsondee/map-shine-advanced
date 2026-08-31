/**
 * paint-mask.js — the pure painted-mask model, brush, codec, persistence.
 * Cross-checks the brush against mask-derive's OWN sampler so paint and read
 * can never disagree about where a world point lands (the anti-Y-flip guard).
 */
import {
  createPaintLayer,
  stampBrushWorld,
  rasterizePolygon,
  rasterizeStrokedLine,
  isPaintLayerEmpty,
  encodePaintLayer,
  decodePaintLayer,
  encodedByteEstimate,
  serializePaintedMasks,
  hydratePaintedMasks,
  sampleMaskGridWorld,
  PAINT_EMBED_BYTE_BUDGET,
  PAINT_GRID_MAX_DIM,
} from '../paint-mask.js';
import { setLogSink, setLogLevel, LogLevel } from '../../core/log.js';

const RECT = { x: 0, y: 0, width: 1000, height: 800 };
const CENTER = { x: 500, y: 400 };

const dataEqual = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** A MaskGrid built by hand, so a test can pin an EXACT grid size (the codec
 *  reads only `spec.w/h` and `data`) — `createPaintLayer` derives its size from
 *  a rect and cannot land on, say, exactly 65,536 texels. */
const gridOf = (w, h, fill = 0) => ({
  spec: { x: 0, y: 0, width: w, height: h, w, h, texelW: 1, texelH: 1 },
  data: new Uint8Array(w * h).fill(fill),
});

export function run(t) {
  // --- model -------------------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    t.ok('createPaintLayer: PAINT_GRID_MAX_DIM on the long side', layer.spec.w === PAINT_GRID_MAX_DIM);
    t.ok(
      'createPaintLayer: shorter side scaled by aspect',
      layer.spec.h === Math.round((800 * PAINT_GRID_MAX_DIM) / 1000)
    );
    t.ok('createPaintLayer: starts empty', isPaintLayerEmpty(layer));
  }

  // --- brush, cross-checked through the authority's OWN reader ------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 255, hardness: 0.5 });
    t.ok('stamp: not empty after painting', !isPaintLayerEmpty(layer));
    t.ok(
      'stamp: centre reads full through sampleMaskGridWorld',
      sampleMaskGridWorld(layer, CENTER.x, CENTER.y) === 255
    );

    const rim = sampleMaskGridWorld(layer, CENTER.x + 90, CENTER.y); // d≈0.9 of the radius
    t.ok('stamp: rim is softer than centre', rim > 0 && rim < 255);

    t.ok('stamp: outside the radius is untouched', sampleMaskGridWorld(layer, CENTER.x, CENTER.y + 160) === 0);
    t.ok('stamp: a point off the grid samples null, never a guess', sampleMaskGridWorld(layer, -50, -50) === null);
  }

  // --- round brush stays round on a non-square grid -----------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 120, { value: 255, hardness: 1 });
    // equal WORLD distance along x and y must give the same painted state,
    // even though texelW !== texelH — the per-axis normalisation is what buys this.
    const alongX = sampleMaskGridWorld(layer, CENTER.x + 60, CENTER.y);
    const alongY = sampleMaskGridWorld(layer, CENTER.x, CENTER.y + 60);
    t.ok('round brush: equal world distance paints equally on both axes', alongX === 255 && alongY === 255);
    t.ok(
      'round brush: just outside the radius is clean on both axes',
      sampleMaskGridWorld(layer, CENTER.x + 130, CENTER.y) === 0
    );
  }

  // --- erase --------------------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 255, hardness: 1 });
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 255, hardness: 1, mode: 'erase' });
    t.ok('erase: removes what was painted', sampleMaskGridWorld(layer, CENTER.x, CENTER.y) === 0);
  }

  // --- add (airbrush) builds up and clamps --------------------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 90, hardness: 1, mode: 'add' });
    const once = sampleMaskGridWorld(layer, CENTER.x, CENTER.y);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 90, hardness: 1, mode: 'add' });
    t.ok('add: a second dab builds up past the first', sampleMaskGridWorld(layer, CENTER.x, CENTER.y) > once);
    for (let k = 0; k < 6; k++)
      stampBrushWorld(layer, CENTER.x, CENTER.y, 100, { value: 90, hardness: 1, mode: 'add' });
    t.ok('add: build-up clamps at 255', sampleMaskGridWorld(layer, CENTER.x, CENTER.y) === 255);
  }

  // --- polygon fill: the vector == mask unification -----------------------
  {
    const layer = createPaintLayer(RECT);
    rasterizePolygon(
      layer,
      [
        { x: 400, y: 300 },
        { x: 600, y: 300 },
        { x: 600, y: 500 },
        { x: 400, y: 500 },
      ],
      { value: 255 }
    );
    t.ok('polygon: interior fills, read through the authority sampler', sampleMaskGridWorld(layer, 500, 400) === 255);
    t.ok('polygon: exterior is clean', sampleMaskGridWorld(layer, 200, 200) === 0);
  }

  // --- polygon with a hole (even-odd; a hole needs no special-casing) ------
  {
    const layer = createPaintLayer(RECT);
    const outer = [
      { x: 300, y: 200 },
      { x: 700, y: 200 },
      { x: 700, y: 600 },
      { x: 300, y: 600 },
    ];
    const hole = [
      { x: 450, y: 350 },
      { x: 550, y: 350 },
      { x: 550, y: 450 },
      { x: 450, y: 450 },
    ];
    rasterizePolygon(layer, outer, { value: 255, holes: [hole] });
    t.ok('polygon hole: the ring is filled', sampleMaskGridWorld(layer, 350, 250) === 255);
    t.ok('polygon hole: inside the hole is NOT filled', sampleMaskGridWorld(layer, 500, 400) === 0);
  }

  // --- polygon erase punches a hole into a fill ---------------------------
  {
    const layer = createPaintLayer(RECT);
    rasterizePolygon(
      layer,
      [
        { x: 300, y: 300 },
        { x: 700, y: 300 },
        { x: 700, y: 500 },
        { x: 300, y: 500 },
      ],
      { value: 255 }
    );
    rasterizePolygon(
      layer,
      [
        { x: 450, y: 350 },
        { x: 550, y: 350 },
        { x: 550, y: 450 },
        { x: 450, y: 450 },
      ],
      { value: 255, mode: 'erase' }
    );
    t.ok('polygon erase: the erased sub-region is clear', sampleMaskGridWorld(layer, 500, 400) === 0);
    t.ok('polygon erase: the rest of the fill survives', sampleMaskGridWorld(layer, 350, 400) === 255);
  }

  // --- stroked line: "draw a line == paint a line" ------------------------
  {
    const layer = createPaintLayer(RECT);
    rasterizeStrokedLine(
      layer,
      [
        { x: 200, y: 400 },
        { x: 800, y: 400 },
      ],
      40, // width -> radius 20
      { value: 255 }
    );
    t.ok('line: the stroke centre is painted', sampleMaskGridWorld(layer, 500, 400) === 255);
    t.ok('line: within the width is painted', sampleMaskGridWorld(layer, 500, 415) > 0);
    t.ok('line: beyond the width is clean', sampleMaskGridWorld(layer, 500, 480) === 0);
    t.ok('line: the endpoint is painted (round cap)', sampleMaskGridWorld(layer, 800, 400) === 255);
  }

  // --- codec round-trip ---------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, CENTER.x, CENTER.y, 130, { value: 200, hardness: 0.4 });
    stampBrushWorld(layer, 200, 200, 60, { value: 255, hardness: 0.7 });
    const encoded = encodePaintLayer(layer);
    const { layer: back, dimensionsMatch } = decodePaintLayer(encoded, RECT);
    t.ok('codec: round-trips byte-for-byte', dataEqual(layer.data, back.data));
    t.ok('codec: dimensions match the same scene rect', dimensionsMatch === true);
  }

  // --- a genuinely SPARSE mask (a small brush on a REAL-scale scene, not a
  //     big brush on a tiny test rect) stays well under the embed budget ---
  {
    // 12,000-wide is the real scene scale used elsewhere in this project. A
    // radius-130 stroke on it is a small, localized dab (~2% of grid width at
    // PAINT_GRID_MAX_DIM) -- the actual "sparse" case PAINT_EMBED_BYTE_BUDGET
    // exists to distinguish from a mask detailed enough to want Mode B.
    const bigRect = { x: 0, y: 0, width: 12000, height: 8000 };
    const layer = createPaintLayer(bigRect);
    stampBrushWorld(layer, 6000, 4000, 130, { value: 200, hardness: 0.4 });
    stampBrushWorld(layer, 2000, 2000, 60, { value: 255, hardness: 0.7 });
    const encoded = encodePaintLayer(layer);
    t.ok('codec: a sparse mask is well under the embed budget', encodedByteEstimate(encoded) < PAINT_EMBED_BYTE_BUDGET);
  }

  // --- a resized scene is REPORTED, not silently stretched ----------------
  {
    const layer = createPaintLayer(RECT); // PAINT_GRID_MAX_DIM x (aspect-scaled)
    stampBrushWorld(layer, CENTER.x, CENTER.y, 80, { value: 255 });
    const encoded = encodePaintLayer(layer);
    // A genuinely different aspect ratio -> a different h at the SAME maxDim.
    const { dimensionsMatch } = decodePaintLayer(encoded, { x: 0, y: 0, width: 800, height: 800 });
    t.ok('codec: a resolution change is reported as a mismatch', dimensionsMatch === false);
  }

  // --- maxDim is honoured, and MUST be threaded consistently through decode
  //     (the real bug fixed 2026-07-20: decodePaintLayer used to ignore its
  //     caller's maxDim entirely and always compare against mask-derive's
  //     unrelated 512 default, so bumping PAINT_GRID_MAX_DIM alone would have
  //     made EVERY ordinary reload report a false "scene resized") ----------
  {
    const layer = createPaintLayer(RECT, 256);
    t.ok('createPaintLayer: an explicit maxDim overrides the default', layer.spec.w === 256);
    const encoded = encodePaintLayer(layer);
    const matching = decodePaintLayer(encoded, RECT, 256);
    t.ok('decodePaintLayer: the SAME maxDim as encoding reports a match', matching.dimensionsMatch === true);
    const defaulted = decodePaintLayer(encoded, RECT); // maxDim defaults to PAINT_GRID_MAX_DIM, NOT 256
    t.ok(
      'decodePaintLayer: a DIFFERENT maxDim than encoding correctly reports a mismatch (not silently wrong)',
      defaulted.dimensionsMatch === false
    );
  }

  // --- persistence: only-painted-stored, round-trip -----------------------
  {
    const fire = createPaintLayer(RECT);
    stampBrushWorld(fire, CENTER.x, CENTER.y, 100, { value: 255 });
    const dust = createPaintLayer(RECT); // never painted

    const payload = serializePaintedMasks({ 'fire::0': fire, 'dust::0': dust });
    t.ok('serialize: keeps a painted mask', !!payload['fire::0']);
    t.ok('serialize: drops an unpainted mask (store only what differs)', !('dust::0' in payload));

    const { layers, mismatched, rejected } = hydratePaintedMasks(payload, RECT);
    t.ok('hydrate: brings the painted mask back', !!layers['fire::0']);
    t.ok('hydrate: no false mismatches on the same rect', mismatched.length === 0);
    t.ok('hydrate: round-trips the painted data', dataEqual(fire.data, layers['fire::0'].data));
    t.ok('hydrate: a clean payload rejects nothing (an empty list means "I looked")', rejected.length === 0);
  }

  // --- CORRUPT PERSISTED PAYLOADS ARE REJECTED, NEVER THROWN --------------
  //     `{w,h,rle}` comes back out of a FOUNDRY SCENE FLAG, so it may have been
  //     hand-edited, half-written, or round-tripped through a scene export.
  //     Before validation, every shape below threw — `new Uint8Array(-4)` and
  //     `new Uint8Array(1e10)` ("Invalid typed array length"), a missing `rle`
  //     ("Cannot read properties of undefined (reading 'length')") — and the
  //     throw escaped hydratePaintedMasks, escaped
  //     ui/paint-mode.js#hydrateFromScene(), and landed in boot.js's canvasReady
  //     OUTER catch, aborting sky resolve, fade/cue load, the anchor import and
  //     the viewer itself. One corrupt byte in one optional flag took down the
  //     whole scene bring-up and blamed the viewer for it.
  {
    const captured = [];
    setLogSink((entry) => captured.push(entry));
    setLogLevel(LogLevel.ERROR); // every drop below is deliberate — keep them out of the suite's own output
    try {
      const shapes = {
        'no-rle::0': { w: 4, h: 4 }, // rle missing entirely
        'rle-string::0': { w: 4, h: 4, rle: 'not an array' },
        'rle-object::0': { w: 4, h: 4, rle: { 0: 255, 1: 16 } }, // array-ish, still not an array
        'negative-w::0': { w: -1, h: 4, rle: [255, 4] },
        'giant::0': { w: 100000, h: 100000, rle: [255, 4] }, // a 10-billion-texel allocation
        'over-ceiling::0': { w: PAINT_GRID_MAX_DIM + 1, h: 4, rle: [255, 4] }, // just past the real ceiling
        'zero-dims::0': { w: 0, h: 0, rle: [] }, // never threw — produced texelW:Infinity, every sample null
        'fractional-w::0': { w: 4.5, h: 4, rle: [255, 4] },
        'nan-w::0': { w: NaN, h: 4, rle: [255, 4] },
        'infinite-h::0': { w: 4, h: Infinity, rle: [255, 4] },
        'string-w::0': { w: '4', h: 4, rle: [255, 4] }, // a JSON round trip that stringified the numbers
        'entry-null::0': null,
        'entry-string::0': 'corrupted',
        'entry-array::0': [255, 16],
      };
      for (const [key, enc] of Object.entries(shapes)) {
        let out = null;
        let threw = false;
        try {
          out = decodePaintLayer(enc, RECT);
        } catch (err) {
          threw = true;
          captured.push({ level: 'test', message: `decode threw for ${key}: ${err?.message}` });
        }
        t.ok(
          `decode: "${key}" is rejected with a reason, never thrown`,
          !threw && out?.layer === null && typeof out?.rejected === 'string' && out.rejected.length > 0
        );
      }

      // THE POINT OF PER-KEY VALIDATION: a neighbour in the SAME flag survives.
      const fire = createPaintLayer(RECT);
      stampBrushWorld(fire, CENTER.x, CENTER.y, 100, { value: 255 });
      const fireEnc = encodePaintLayer(fire);
      const mixed = {
        'broken::0': { w: 4, h: 4 }, // no rle
        'fire::0': fireEnc, // the one the author actually painted
        'worse::1': { w: -1, h: 4, rle: [255, 4] },
        'degenerate::2': { w: 0, h: 0, rle: [] },
      };
      let hydrated = null;
      let hydrateThrew = false;
      try {
        hydrated = hydratePaintedMasks(mixed, RECT);
      } catch (err) {
        hydrateThrew = true;
        captured.push({ level: 'test', message: `hydrate threw: ${err?.message}` });
      }
      t.ok('hydrate: three corrupt entries never throw', !hydrateThrew);
      t.ok(
        'hydrate: the VALID neighbour in the same flag still loads, byte-for-byte',
        dataEqual(fire.data, hydrated?.layers?.['fire::0']?.data)
      );
      t.ok(
        'hydrate: rejected keys are simply ABSENT, not present-and-broken',
        !!hydrated &&
          !('broken::0' in hydrated.layers) &&
          !('worse::1' in hydrated.layers) &&
          !('degenerate::2' in hydrated.layers)
      );
      t.ok(
        'hydrate: every rejection is reported BY NAME (never a silent vanish)',
        (hydrated?.rejected ?? [])
          .map((r) => r.key)
          .sort()
          .join('|') === 'broken::0|degenerate::2|worse::1'
      );
      t.ok(
        'hydrate: every rejection carries a WHY, not just a which',
        (hydrated?.rejected ?? []).every((r) => typeof r.reason === 'string' && r.reason.length > 0)
      );
      t.ok('hydrate: a rejection is NOT smuggled through as a resolution mismatch', hydrated?.mismatched.length === 0);
      t.ok(
        'hydrate: each drop goes through the log door, naming the key',
        ['broken::0', 'worse::1', 'degenerate::2'].every((key) =>
          captured.some((e) => e.level === 'warn' && e.message.includes(key))
        )
      );

      // The FLAG ITSELF corrupt (not a key->payload map at all). A scene with
      // NO painted masks is the overwhelmingly common case and must stay
      // silent — "absent" is not "rejected", and conflating them would make
      // the rejection list cry wolf on every unpainted scene ever loaded.
      const nullFlag = hydratePaintedMasks(null, RECT);
      t.ok(
        'hydrate: a null flag is the ordinary "nothing painted" case, not a rejection',
        Object.keys(nullFlag.layers).length === 0 && nullFlag.rejected.length === 0
      );
      const undefinedFlag = hydratePaintedMasks(undefined, RECT);
      t.ok(
        'hydrate: an undefined flag is likewise not a rejection',
        Object.keys(undefinedFlag.layers).length === 0 && undefinedFlag.rejected.length === 0
      );
      let stringFlag = null;
      let stringFlagThrew = false;
      try {
        stringFlag = hydratePaintedMasks('corrupted-flag', RECT);
      } catch (err) {
        stringFlagThrew = true;
        captured.push({ level: 'test', message: `string flag threw: ${err?.message}` });
      }
      t.ok(
        'hydrate: a flag that is a bare STRING is one rejection, not one-per-character',
        !stringFlagThrew && Object.keys(stringFlag.layers).length === 0 && stringFlag.rejected.length === 1
      );
    } finally {
      setLogSink(null);
      setLogLevel(LogLevel.INFO);
    }
  }

  // --- CODEC EDGE CASES, PINNED ------------------------------------------
  //     The RLE round trip was verified correct at every edge below by hand
  //     (2026-08-31) and NONE of it was in the suite — so a future change to
  //     the run-length cap or the rasterizer could silently regress it. These
  //     are regression stakes, not new behaviour.
  {
    const roundTrips = (grid) => {
      const enc = encodePaintLayer(grid);
      const { layer: back, rejected } = decodePaintLayer(enc); // no sceneRect: the spec is synthesized from w/h
      return rejected === null && dataEqual(grid.data, back.data);
    };

    const allZero = gridOf(64, 64, 0);
    t.ok('codec edge: an all-ZERO grid round-trips byte-for-byte', roundTrips(allZero));
    t.ok('codec edge: an all-zero grid is a single run', encodePaintLayer(allZero).rle.join(',') === '0,4096');

    const allFull = gridOf(64, 64, 255);
    t.ok('codec edge: an all-255 grid round-trips byte-for-byte', roundTrips(allFull));
    t.ok('codec edge: an all-255 grid is a single run', encodePaintLayer(allFull).rle.join(',') === '255,4096');

    const oneTexel = gridOf(64, 64, 0);
    oneTexel.data[35 * 64 + 17] = 200;
    t.ok('codec edge: a SINGLE painted texel round-trips byte-for-byte', roundTrips(oneTexel));
    t.ok('codec edge: a single texel is three runs (zeros, it, zeros)', encodePaintLayer(oneTexel).rle.length === 6);

    // THE RUN-LENGTH CAP. `encodePaintLayer` stops a run at 65535 so the pair
    // stays a 16-bit-representable number. 255*257 is EXACTLY 65535 and
    // 256*256 is EXACTLY 65536 — the two sides of that boundary, tested as
    // such rather than approached from a comfortable distance.
    const exactlyCap = gridOf(255, 257, 7); // 65,535 texels
    t.ok('codec edge: a run of exactly 65535 stays ONE pair', encodePaintLayer(exactlyCap).rle.join(',') === '7,65535');
    t.ok('codec edge: a run of exactly 65535 round-trips byte-for-byte', roundTrips(exactlyCap));

    const oneOverCap = gridOf(256, 256, 7); // 65,536 texels — one past the cap
    t.ok(
      'codec edge: a run of 65536 SPLITS into 65535 + 1, never overflows',
      encodePaintLayer(oneOverCap).rle.join(',') === '7,65535,7,1'
    );
    t.ok('codec edge: a run one past the cap round-trips byte-for-byte', roundTrips(oneOverCap));

    const changeAtCap = gridOf(256, 256, 7);
    changeAtCap.data[65535] = 9; // the value changes on the exact texel the cap lands on
    t.ok(
      'codec edge: a value change ON the cap boundary is not swallowed',
      encodePaintLayer(changeAtCap).rle.join(',') === '7,65535,9,1'
    );
    t.ok('codec edge: a value change on the cap boundary round-trips', roundTrips(changeAtCap));
  }

  // --- brush strokes at every rect CORNER and EDGE survive the round trip --
  //     Clamping at the rect boundary is a spec.w/spec.h edge condition,
  //     independent of resolution, so a modest maxDim keeps eight full
  //     encode+decode round trips cheap.
  {
    const MAXDIM = 512;
    const probes = [
      ['top-left corner', RECT.x, RECT.y],
      ['top-right corner', RECT.x + RECT.width, RECT.y],
      ['bottom-left corner', RECT.x, RECT.y + RECT.height],
      ['bottom-right corner', RECT.x + RECT.width, RECT.y + RECT.height],
      ['top edge', RECT.x + RECT.width / 2, RECT.y],
      ['bottom edge', RECT.x + RECT.width / 2, RECT.y + RECT.height],
      ['left edge', RECT.x, RECT.y + RECT.height / 2],
      ['right edge', RECT.x + RECT.width, RECT.y + RECT.height / 2],
    ];
    for (const [where, wx, wy] of probes) {
      const layer = createPaintLayer(RECT, MAXDIM);
      stampBrushWorld(layer, wx, wy, 40, { value: 255, hardness: 0.6 });
      t.ok(`codec edge: a stroke at the ${where} actually painted something`, !isPaintLayerEmpty(layer));
      const { layer: back, rejected } = decodePaintLayer(encodePaintLayer(layer), RECT, MAXDIM);
      t.ok(
        `codec edge: a stroke at the ${where} round-trips byte-for-byte`,
        rejected === null && dataEqual(layer.data, back.data)
      );
    }
  }

  // --- guards -------------------------------------------------------------
  {
    const layer = createPaintLayer(RECT);
    stampBrushWorld(layer, 5, 5, 30, { value: 255 }); // near the corner — clamps, does not throw
    t.ok('stamp: near-edge brush clamps without throwing', !isPaintLayerEmpty(layer));
    // Behaviour CHANGED by the coverage-floor fix below: a zero radius used
    // to be a true no-op (safe, but also the exact bug — see the next block).
    // It must still never crash, and must now RELIABLY paint the nearest
    // texel instead of silently doing nothing.
    stampBrushWorld(layer, CENTER.x, CENTER.y, 0, { value: 255 });
    t.ok(
      'stamp: a zero/tiny radius does not crash AND reliably paints the nearest texel',
      sampleMaskGridWorld(layer, CENTER.x, CENTER.y) > 0
    );
  }

  // --- THE COVERAGE-FLOOR BUG (2026-07-20): below ~0.71 texels of radius, a
  //     stamp's success used to depend on a coin-flip of sub-texel alignment
  //     — the exact mechanism behind "a dragged line breaks into dots" and
  //     "the smallest brush sometimes does nothing". Test several
  //     deliberately AWKWARD sub-texel offsets (not just one lucky centred
  //     alignment), on a real scene scale, and prove every one now paints. -
  {
    const bigRect = { x: 0, y: 0, width: 12000, height: 8000 }; // the real scene scale the bug was reported on
    const texelW = createPaintLayer(bigRect).spec.texelW; // ~5.86
    const tinyRadius = texelW * 0.3; // well under the old ~0.71-texel failure threshold
    for (const frac of [0, 0.25, 0.5, 0.75, 0.9]) {
      const layer = createPaintLayer(bigRect);
      const px = 6000 + frac * texelW; // deliberately NOT texel-centre-aligned
      stampBrushWorld(layer, px, 4000, tinyRadius, { value: 255, hardness: 1 });
      t.ok(`stamp: a tiny brush paints reliably at sub-texel offset ${frac}`, !isPaintLayerEmpty(layer));
    }
  }
}
