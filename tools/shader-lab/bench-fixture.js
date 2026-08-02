/**
 * SHADER LAB — THE FIXTURE BENCH (rung 2: REAL INGEST).
 *
 * ============================================================================
 * WHAT THIS BENCH IS FOR
 * ============================================================================
 * Every other bench in this lab hands its shader inputs that are **correct by
 * construction** — a `DataTexture` painted by a `sampleField` function written
 * in the same file that consumes it. That is precisely why they cannot catch an
 * ingest bug: there is no ingest.
 *
 * This bench removes the synthetic step. It calls the REAL
 * `loadMaskImageTexture` (`src/vt/mask-image.js`, unmodified) on the REAL
 * authored files of a REAL three-floor map, and reports what actually comes
 * back — dimensions, channel layout, painted bounds, polarity, per-floor
 * differences. It is the first rung at which the lab can be wrong in the way
 * Foundry is wrong.
 *
 * ============================================================================
 * WHAT IT DELIBERATELY DOES *NOT* CLAIM
 * ============================================================================
 * Loading a mask correctly is not the same as DERIVING from it correctly, and
 * neither is the same as COMPOSITING it correctly. This bench stops at ingest:
 *
 * - It does **not** run `mask-derive.js`'s coarse grid, the mask authority's
 *   multi-host composition, or `bakeCasterTexture`. Those need the VT ingest
 *   and the authority wired up; they are the second half of rung 2.
 * - It does **not** prove orientation end-to-end. `flipY:false` means row 0 is
 *   the image's top row, but confirming that a given world Y samples the row an
 *   author *intended* needs either an authored ground truth (see
 *   `FIXTURE.authored`, deliberately empty) or a real composite to look at.
 *   The orientation check therefore reports **UNMEASURED**, with a note, rather
 *   than quietly passing on a self-consistent tautology.
 *
 * Saying so in the report is the point. `feedback_instruments_must_not_lie`:
 * "could not measure" is a third answer, and a rig that lacks it will always
 * find a way to call an unmeasured thing green.
 *
 * @module tools/shader-lab/bench-fixture
 */
import { loadMaskImageTexture, maskImageTargetSize, MASK_CONTENT_EMPTY_BYTE } from '../../src/vt/mask-image.js';
import FIXTURE, { EXPLORE_SCALE, NATIVE, PRODUCTION_SCALE } from './fixtures/tower-bridge.js';
import { check, evaluate, registerBench, saveCanvasPng } from './contract.js';

/** Byte at or above which an `_Outdoors` texel counts as OUTDOORS. The catalog
 * says white = outdoors, black = indoors; the midpoint is the only
 * defensible split for a two-polarity question, and nothing finer is claimed. */
const OUTDOORS_BRIGHT_BYTE = 128;

/**
 * Per-kind production upload scale.
 * @param {string} kind @returns {number}
 */
function productionScaleFor(kind) {
  return PRODUCTION_SCALE[kind] ?? PRODUCTION_SCALE._default;
}

/**
 * Statistics over a decoded mask buffer. Computed from the SAME `data` array
 * the texture wraps (the loader returns it precisely so a CPU consumer need not
 * decode twice), so these numbers describe the exact bytes the GPU samples.
 *
 * @param {Uint8Array} data @param {'r'|'rgb'} channels @param {number} w @param {number} h
 * @returns {object}
 */
function statsOf(data, channels, w, h) {
  const rgb = channels === 'rgb';
  const texels = w * h;
  let sum = 0;
  let min = 255;
  let max = 0;
  let bright = 0;
  let empty = 0;
  let maxChannelDelta = 0;
  // 16-bucket histogram — enough to see "two polarities" vs "one flat value"
  // without shipping 256 numbers into every report.
  const histogram = new Array(16).fill(0);

  for (let i = 0; i < texels; i++) {
    let v;
    if (rgb) {
      const s = i * 4;
      const r = data[s];
      const g = data[s + 1];
      const b = data[s + 2];
      // Presence by MAX of RGB, matching the loader's own bounds rule — a
      // blue-painted object has r = 0 and measuring by red erases it.
      v = Math.max(r, g, b);
      const d = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
      if (d > maxChannelDelta) maxChannelDelta = d;
    } else {
      v = data[i];
    }
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v >= OUTDOORS_BRIGHT_BYTE) bright++;
    if (v <= MASK_CONTENT_EMPTY_BYTE) empty++;
    histogram[v >> 4]++;
  }
  return {
    texels,
    meanByte: Number((sum / texels).toFixed(2)),
    minByte: min,
    maxByte: max,
    brightFraction: Number((bright / texels).toFixed(4)),
    emptyFraction: Number((empty / texels).toFixed(4)),
    maxChannelDelta: rgb ? maxChannelDelta : null,
    histogram,
  };
}

/**
 * Box-downsample a decoded mask into an RGBA image for display. Masks are
 * ~10k px wide and the canvas is not; a nearest-neighbour decimation of a
 * high-frequency silhouette would alias thin trim out of existence and make the
 * picture lie about the very detail this fixture exists to provide.
 *
 * @param {Uint8Array} data @param {'r'|'rgb'} channels
 * @param {number} w @param {number} h @param {number} outW @param {number} outH
 * @returns {Uint8ClampedArray}
 */
function downsampleToRgba(data, channels, w, h, outW, outH) {
  const rgb = channels === 'rgb';
  const out = new Uint8ClampedArray(outW * outH * 4);
  const sx = w / outW;
  const sy = h / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * sy);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((oy + 1) * sy)));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * sx);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((ox + 1) * sx)));
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * w + x;
          if (rgb) {
            const s = i * 4;
            ar += data[s];
            ag += data[s + 1];
            ab += data[s + 2];
          } else {
            const v = data[i];
            ar += v;
            ag += v;
            ab += v;
          }
          n++;
        }
      }
      const o = (oy * outW + ox) * 4;
      out[o] = ar / n;
      out[o + 1] = ag / n;
      out[o + 2] = ab / n;
      out[o + 3] = 255;
    }
  }
  return out;
}

/**
 * Build the fixture bench.
 * @param {object} args @param {*} args.THREE @param {(m:string)=>void} args.log
 * @returns {object}
 */
export function createFixtureBench({ THREE, log }) {
  const state = {
    floorId: 'middle',
    kind: 'outdoors',
    scale: EXPLORE_SCALE,
    lastKey: null,
  };

  /** Decoded masks this session, keyed `${file}@${scale}@${channels}`. */
  const cache = new Map();
  /** Total uploaded bytes currently held, so the bench can report its own cost. */
  let heldBytes = 0;

  /** @param {string} floorId @param {string} kind @returns {object|null} */
  function entryFor(floorId, kind) {
    return FIXTURE.maskFiles.find((e) => e.floorId === floorId && e.kind === kind) ?? null;
  }

  /**
   * Load one mask through the REAL loader. `channelsOverride` exists for one
   * legitimate diagnostic: a `gray` kind ships as `'r'` in production, so
   * verifying the catalog's own R≈G≈B contract requires deliberately asking
   * for `'rgb'`. Any report using it says so.
   *
   * @param {object} entry @param {number} scale @param {'r'|'rgb'} [channelsOverride]
   * @returns {Promise<object|null>}
   */
  async function loadOne(entry, scale, channelsOverride) {
    const channels = channelsOverride ?? entry.channels;
    const key = `${entry.file}@${scale}@${channels}`;
    if (cache.has(key)) return cache.get(key);

    const t0 = performance.now();
    const result = await loadMaskImageTexture({ url: entry.url, THREE, scale, channels });
    const loadMs = Math.round(performance.now() - t0);
    if (!result) {
      log?.(`FIXTURE: loader returned null for ${entry.file} — see console for the logged reason`);
      return null;
    }
    const t1 = performance.now();
    const stats = statsOf(result.data, channels, result.width, result.height);
    const statsMs = Math.round(performance.now() - t1);

    const record = { entry, channels, scale, result, stats, loadMs, statsMs, key };
    cache.set(key, record);
    heldBytes += result.bytes;
    state.lastKey = key;
    log?.(
      `FIXTURE ${entry.file} @${scale} '${channels}': ${result.nativeWidth}x${result.nativeHeight} -> ` +
        `${result.width}x${result.height}, ${(result.bytes / 1048576).toFixed(1)}MB, ` +
        `mean=${stats.meanByte} bright=${(stats.brightFraction * 100).toFixed(1)}% in ${loadMs}ms`
    );
    return record;
  }

  /** Free every decoded mask — a scale-1 sweep holds hundreds of MB. */
  function releaseAll() {
    for (const rec of cache.values()) rec.result.texture?.dispose?.();
    cache.clear();
    heldBytes = 0;
    log?.('FIXTURE: released all decoded masks');
  }

  /**
   * Sample the real mask at a WORLD point. This is the call an authored
   * expectation will eventually be checked with — "the bridge deck at (x,y) is
   * outdoors" becomes one of these.
   * @param {object} rec @param {number} wx @param {number} wy
   */
  function sampleWorld(rec, wx, wy) {
    const r = FIXTURE.worldRect;
    const u = (wx - r.minX) / (r.maxX - r.minX);
    // v=0 is the image's TOP row (`flipY:false`), and the fixture declares the
    // world rect with minY at that top row. Stated here because every new
    // mapping is a fresh chance to be upside-down.
    const v = (wy - r.minY) / (r.maxY - r.minY);
    const x = Math.max(0, Math.min(rec.result.width - 1, Math.round(u * (rec.result.width - 1))));
    const y = Math.max(0, Math.min(rec.result.height - 1, Math.round(v * (rec.result.height - 1))));
    const i = y * rec.result.width + x;
    if (rec.channels === 'rgb') {
      const s = i * 4;
      return { x, y, r: rec.result.data[s], g: rec.result.data[s + 1], b: rec.result.data[s + 2], a: rec.result.data[s + 3] };
    }
    return { x, y, r: rec.result.data[i], g: null, b: null, a: null };
  }

  /** Paint a loaded mask to the bench canvas. */
  function paint(rec) {
    const canvas = document.getElementById('fixtureView');
    if (!canvas || !rec) return;
    const outW = canvas.width;
    const outH = Math.max(1, Math.round((outW * rec.result.height) / rec.result.width));
    if (canvas.height !== outH) canvas.height = outH;
    const rgba = downsampleToRgba(rec.result.data, rec.channels, rec.result.width, rec.result.height, outW, outH);
    canvas.getContext('2d').putImageData(new ImageData(rgba, outW, outH), 0, 0);
  }

  function setLegend(rec, extra = '') {
    const el = document.getElementById('fixtureLegend');
    if (!el) return;
    if (!rec) {
      el.textContent = 'no mask loaded';
      return;
    }
    const s = rec.stats;
    el.textContent =
      `${rec.entry.file}\n` +
      `floor=${rec.entry.floorId}  kind=${rec.entry.kind}  channels='${rec.channels}'  scale=${rec.scale}` +
      `${rec.scale !== productionScaleFor(rec.entry.kind) ? ` (production=${productionScaleFor(rec.entry.kind)})` : ' (PRODUCTION SCALE)'}\n` +
      `native ${rec.result.nativeWidth}x${rec.result.nativeHeight} -> uploaded ${rec.result.width}x${rec.result.height}  ` +
      `${(rec.result.bytes / 1048576).toFixed(1)}MB  load ${rec.loadMs}ms\n` +
      `mean=${s.meanByte} min=${s.minByte} max=${s.maxByte} bright=${(s.brightFraction * 100).toFixed(1)}% ` +
      `empty=${(s.emptyFraction * 100).toFixed(1)}%${s.maxChannelDelta !== null ? ` maxChannelDelta=${s.maxChannelDelta}` : ''}\n` +
      `contentBounds=${rec.result.contentBounds ? JSON.stringify(Object.fromEntries(Object.entries(rec.result.contentBounds).map(([k, v]) => [k, Number(v.toFixed(4))]))) : 'null (nothing painted)'}` +
      (extra ? `\n${extra}` : '');
  }

  // -------------------------------------------------------------------------
  // Checks — each one states what it measured, and refuses to guess.
  // -------------------------------------------------------------------------

  /** @param {object} rec @returns {object[]} */
  function structuralChecks(rec) {
    return [
      evaluate(`native-dimensions:${rec.entry.file}`, () => ({
        ok: rec.result.nativeWidth === NATIVE.width && rec.result.nativeHeight === NATIVE.height,
        measured: `${rec.result.nativeWidth}x${rec.result.nativeHeight}`,
        expected: `${NATIVE.width}x${NATIVE.height}`,
        note: 'native size read by the loader must match the WebP header',
      })),
      evaluate(`upload-size-matches-scale:${rec.entry.file}`, () => {
        // The REAL exported sizing function, not a re-derivation of it.
        const want = maskImageTargetSize(rec.result.nativeWidth, rec.result.nativeHeight, rec.scale);
        return {
          ok: rec.result.width === want.width && rec.result.height === want.height,
          measured: `${rec.result.width}x${rec.result.height}`,
          expected: `${want.width}x${want.height}`,
          note: 'uploaded size must equal maskImageTargetSize() at this scale',
        };
      }),
    ];
  }

  /** The `required: true` contract, and the "a flat mask is a broken mask" rule. */
  function outdoorsChecks(rec, floor) {
    const s = rec.stats;
    const out = [
      evaluate(`outdoors-content-bounds:${floor.id}`, () => ({
        ok: rec.result.contentBounds !== null,
        measured: rec.result.contentBounds ? 'present' : 'null',
        expected: 'present',
        note: 'a required mask with nothing painted would crop every consumer to nothing',
      })),
      evaluate(`outdoors-both-polarities:${floor.id}`, () => {
        const hasDark = s.minByte <= OUTDOORS_BRIGHT_BYTE;
        const hasBright = s.maxByte >= OUTDOORS_BRIGHT_BYTE;
        return {
          ok: hasDark && hasBright,
          measured: `min=${s.minByte} max=${s.maxByte}`,
          expected: `spanning ${OUTDOORS_BRIGHT_BYTE}`,
          note: 'an _Outdoors that is entirely one polarity is not gating anything',
        };
      }),
    ];
    // BIMODALITY — what a hand-painted binary mask actually promises, and what
    // replaced this fixture's first (wrong) per-floor polarity guess. See
    // `FIXTURE.invariant.bimodalExtremeFractionMin` for that whole story.
    out.push(
      evaluate(`outdoors-bimodal:${floor.id}`, () => {
        const extremes = (s.histogram[0] + s.histogram[15]) / s.texels;
        return {
          ok: extremes >= FIXTURE.invariant.bimodalExtremeFractionMin,
          measured: Number(extremes.toFixed(4)),
          expected: `>= ${FIXTURE.invariant.bimodalExtremeFractionMin}`,
          note: 'a smeared decode, wrong colour space or bad resize filter all show up as mass leaving the extremes',
        };
      })
    );
    // ✅ RATIFIED BY THE AUTHOR 2026-08-01, so this is a real assertion now.
    // Tolerance derived from measured cross-scale drift, not guessed — see
    // `FIXTURE.invariant.outdoorsFractionTolerance`.
    const tol = FIXTURE.invariant.outdoorsFractionTolerance;
    out.push(
      floor.outdoorsFraction === undefined
        ? check({
            id: `floor-outdoors-fraction:${floor.id}`,
            status: 'UNMEASURED',
            measured: s.brightFraction,
            expected: 'author to ratify',
            note: 'no ratified fraction for this floor yet',
          })
        : evaluate(`floor-outdoors-fraction:${floor.id}`, () => ({
            ok: Math.abs(s.brightFraction - floor.outdoorsFraction) <= tol,
            measured: s.brightFraction,
            expected: `${floor.outdoorsFraction} ±${tol}`,
            note: 'author-ratified coverage; an inverted decode or swapped file moves this far past tolerance',
          }))
    );
    return out;
  }

  /**
   * A coarse 16×8 mean-byte signature of a decoded mask — enough to tell two
   * different images apart, far too coarse to be confused with a golden.
   * @param {object} rec @returns {number[]}
   */
  function signatureOf(rec) {
    const { width, height, data } = rec.result;
    const stride = rec.channels === 'rgb' ? 4 : 1;
    const cols = 16;
    const rows = 8;
    const sig = [];
    for (let ry = 0; ry < rows; ry++) {
      for (let rx = 0; rx < cols; rx++) {
        const x0 = Math.floor((rx * width) / cols);
        const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * width) / cols));
        const y0 = Math.floor((ry * height) / rows);
        const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * height) / rows));
        let sum = 0;
        let n = 0;
        // Sub-sampled: a full walk of 3 M texels × 128 cells is pointless for a
        // "are these the same picture" question.
        const stepX = Math.max(1, (x1 - x0) >> 3);
        const stepY = Math.max(1, (y1 - y0) >> 3);
        for (let y = y0; y < y1; y += stepY) {
          for (let x = x0; x < x1; x += stepX) {
            sum += data[(y * width + x) * stride];
            n++;
          }
        }
        sig.push(sum / Math.max(1, n));
      }
    }
    return sig;
  }

  /** Mean absolute difference between two signatures, in bytes. */
  function signatureDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  /**
   * ⚠️ THE HONEST GAP. Orientation cannot be established at this rung, and the
   * authored ground-truth list is empty on purpose. Both report UNMEASURED.
   */
  function orientationChecks(rec) {
    const topHalf = [];
    const bottomHalf = [];
    const { width, height, data } = rec.result;
    const stride = rec.channels === 'rgb' ? 4 : 1;
    // Coarse row sampling — an observation for the author to judge against the
    // real map, not a pass/fail claim.
    for (let y = 0; y < height; y += Math.max(1, height >> 6)) {
      let sum = 0;
      let n = 0;
      for (let x = 0; x < width; x += Math.max(1, width >> 6)) {
        sum += data[(y * width + x) * stride];
        n++;
      }
      (y < height / 2 ? topHalf : bottomHalf).push(sum / n);
    }
    const mean = (a) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0);
    return [
      check({
        id: `orientation:${rec.entry.file}`,
        status: 'UNMEASURED',
        measured: `topHalfMean=${mean(topHalf).toFixed(1)} bottomHalfMean=${mean(bottomHalf).toFixed(1)}`,
        expected: 'an authored ground truth, or a real composite to compare against',
        note:
          'flipY:false puts image row 0 at world minY, but nothing here can confirm the author INTENDED ' +
          'that row there. Fill FIXTURE.authored, or judge it at rung 3. Not a failure — an unmeasured axis.',
      }),
      FIXTURE.authored.length === 0
        ? check({
            id: 'authored-world-points',
            status: 'UNMEASURED',
            measured: '0 authored points',
            expected: 'author-supplied {world, floorId, kind, expect} entries',
            note: 'FIXTURE.authored is empty by design — a measurement blessed as an expectation passes forever, including when wrong.',
          })
        : check({ id: 'authored-world-points', status: 'pass', measured: FIXTURE.authored.length }),
    ];
  }

  // -------------------------------------------------------------------------
  // Scenarios
  // -------------------------------------------------------------------------
  const scenarios = new Map();

  scenarios.set('outdoors-all-floors', {
    name: 'outdoors-all-floors',
    summary:
      'Load every floor\'s real _Outdoors through the real loader and assert the per-floor polarity ' +
      'invariant. THE verticality scenario: underground enclosed, roof open, middle mixed.',
    async run(ctx) {
      const scale = ctx.params.scale ?? state.scale;
      const checks = [];
      const perFloor = [];
      let lastRec = null;
      for (const floor of FIXTURE.floors) {
        const entry = entryFor(floor.id, 'outdoors');
        if (!entry) {
          checks.push(
            check({
              id: `outdoors-present:${floor.id}`,
              status: 'fail',
              measured: 'absent',
              expected: 'an _Outdoors file',
              note: 'outdoors is required:true in mask-catalog.js — a floor without one throws in production',
            })
          );
          continue;
        }
        const rec = await loadOne(entry, scale);
        if (!rec) {
          checks.push(
            check({
              id: `outdoors-load:${floor.id}`,
              status: 'fail',
              measured: 'loader returned null',
              expected: 'a decoded mask',
              note: 'real loader failure — check the served MIME type and the console log',
            })
          );
          continue;
        }
        lastRec = rec;
        checks.push(...structuralChecks(rec), ...outdoorsChecks(rec, floor));
        perFloor.push({
          floor: floor.id,
          file: entry.file,
          uploaded: `${rec.result.width}x${rec.result.height}`,
          megabytes: Number((rec.result.bytes / 1048576).toFixed(2)),
          loadMs: rec.loadMs,
          ...rec.stats,
          histogram: undefined,
        });
      }
      // CROSS-FLOOR DIFFERENCE — every per-file check above passes happily when
      // all three floors resolved to the SAME file, because each file is
      // individually perfect. Only comparing them catches that.
      const sigs = FIXTURE.floors
        .map((f) => {
          const e = entryFor(f.id, 'outdoors');
          const rec = e && cache.get(`${e.file}@${scale}@r`);
          return rec ? { id: f.id, sig: signatureOf(rec) } : null;
        })
        .filter(Boolean);
      for (let i = 0; i < sigs.length; i++) {
        for (let j = i + 1; j < sigs.length; j++) {
          const d = signatureDistance(sigs[i].sig, sigs[j].sig);
          checks.push(
            evaluate(`floors-differ:${sigs[i].id}-vs-${sigs[j].id}`, () => ({
              ok: d >= FIXTURE.invariant.floorsMustDifferMeanByte,
              measured: Number(d.toFixed(2)),
              expected: `>= ${FIXTURE.invariant.floorsMustDifferMeanByte} mean byte difference`,
              note: 'two floors resolving to the same file would pass every per-file check',
            }))
          );
        }
      }

      if (lastRec) {
        checks.push(...orientationChecks(lastRec));
        paint(lastRec);
        setLegend(lastRec, `scenario=outdoors-all-floors (showing last loaded)`);
      }
      return {
        checks,
        inputs: { scale, floors: FIXTURE.floors.map((f) => f.id), kind: 'outdoors' },
        stats: { perFloor, heldMegabytes: Number((heldBytes / 1048576).toFixed(2)) },
      };
    },
  });

  scenarios.set('gray-channel-contract', {
    name: 'gray-channel-contract',
    summary:
      "Load each gray-declared kind deliberately as 'rgb' and assert R≈G≈B. The catalog says these are " +
      'greyscale; if one is secretly colour, every consumer reading a single packChannel is losing data.',
    async run(ctx) {
      const scale = ctx.params.scale ?? state.scale;
      const floorId = ctx.params.floorId ?? 'underground';
      const checks = [];
      const rows = [];
      for (const kind of FIXTURE.invariant.grayKinds) {
        const entry = entryFor(floorId, kind);
        if (!entry) continue;
        // DELIBERATE override — production ships these as 'r'. Stated in the report.
        const rec = await loadOne(entry, scale, 'rgb');
        if (!rec) {
          checks.push(check({ id: `gray-load:${kind}`, status: 'fail', measured: 'null', expected: 'decoded' }));
          continue;
        }
        checks.push(
          evaluate(`gray-contract:${kind}`, () => ({
            ok: rec.stats.maxChannelDelta <= FIXTURE.invariant.grayChannelToleranceByte,
            measured: rec.stats.maxChannelDelta,
            expected: `<= ${FIXTURE.invariant.grayChannelToleranceByte}`,
            note: `mask-catalog declares '${kind}' as channels:'gray'`,
          }))
        );
        rows.push({ kind, file: entry.file, maxChannelDelta: rec.stats.maxChannelDelta, mean: rec.stats.meanByte });
      }
      return {
        checks,
        inputs: { scale, floorId, channelsOverride: 'rgb', note: "production ships these kinds as 'r'" },
        stats: { rows },
      };
    },
  });

  scenarios.set('specular-is-colour', {
    name: 'specular-is-colour',
    summary:
      'Load the real _Specular at its REAL production scale (0.5) as rgb, and assert it is genuinely ' +
      'coloured — the kind whose R-alone read would report blue steel as absent.',
    async run(ctx) {
      const entry = entryFor('underground', 'specular');
      if (!entry) {
        return { checks: [check({ id: 'specular-present', status: 'fail', measured: 'absent', expected: 'a file' })] };
      }
      const scale = ctx.params.scale ?? productionScaleFor('specular');
      const rec = await loadOne(entry, scale);
      if (!rec) {
        return { checks: [check({ id: 'specular-load', status: 'fail', measured: 'null', expected: 'decoded' })] };
      }
      paint(rec);
      setLegend(rec, 'scenario=specular-is-colour');
      return {
        checks: [
          ...structuralChecks(rec),
          evaluate('specular-has-colour', () => ({
            ok: rec.stats.maxChannelDelta > FIXTURE.invariant.grayChannelToleranceByte,
            measured: rec.stats.maxChannelDelta,
            expected: `> ${FIXTURE.invariant.grayChannelToleranceByte}`,
            note: 'HUE=F0, SAT=metalness, VALUE=smoothness — a flat grey _Specular would mean the hue axis is unused',
          })),
          // ✅ AUTHOR-RATIFIED BAND, 2026-08-01: "usually less than 15% of the
          // total space but you should expect less on most maps at varying
          // degrees." So: something must be painted (an empty mask and a broken
          // shader are indistinguishable from the far end of the pipeline —
          // shine's own history) and it must not blanket the map.
          evaluate('specular-coverage-in-band', () => {
            const painted = 1 - rec.stats.emptyFraction;
            return {
              ok:
                painted >= FIXTURE.invariant.specularPaintedFractionMin &&
                painted <= FIXTURE.invariant.specularPaintedFractionMax,
              measured: Number(painted.toFixed(5)),
              expected: `${FIXTURE.invariant.specularPaintedFractionMin}..${FIXTURE.invariant.specularPaintedFractionMax}`,
              note: 'sparse is normal and expected; empty is not, and neither is map-wide',
            };
          }),
          evaluate('specular-content-bounds', () => ({
            ok: rec.result.contentBounds !== null,
            measured: rec.result.contentBounds ? 'present' : 'null',
            expected: 'present',
            note: 'bounds are measured by MAX of RGB precisely so blue metal is not cropped away',
          })),
          evaluate('specular-production-scale', () => ({
            ok: scale === productionScaleFor('specular'),
            measured: scale,
            expected: productionScaleFor('specular'),
            note: 'SPECULAR_MASK_IMAGE_SCALE is a real per-kind fork; testing at another scale tests a config production never runs',
          })),
        ],
        inputs: { scale, file: entry.file, channels: 'rgb' },
        stats: { ...rec.stats, histogram: undefined, loadMs: rec.loadMs },
      };
    },
  });

  scenarios.set('production-scale-outdoors', {
    name: 'production-scale-outdoors',
    summary:
      'ONE mask at scale 1 — the true production regime (52.7 M texels, ~53 MB uploaded). Slow and heavy ' +
      'on purpose: this is the rung-4 regime question asked at rung 2, for one file.',
    async run(ctx) {
      const floorId = ctx.params.floorId ?? 'middle';
      const entry = entryFor(floorId, 'outdoors');
      const rec = await loadOne(entry, 1);
      if (!rec) {
        return { checks: [check({ id: 'load', status: 'fail', measured: 'null', expected: 'decoded' })] };
      }
      paint(rec);
      setLegend(rec, 'scenario=production-scale-outdoors (SCALE 1)');
      return {
        checks: [
          ...structuralChecks(rec),
          evaluate('full-native-resolution', () => ({
            ok: rec.result.width === NATIVE.width && rec.result.height === NATIVE.height,
            measured: `${rec.result.width}x${rec.result.height}`,
            expected: `${NATIVE.width}x${NATIVE.height}`,
            note: 'at scale 1 and MASK_IMAGE_MAX_DIM 16384 a 10650px mask must upload at full native size',
          })),
        ],
        inputs: { scale: 1, file: entry.file },
        stats: { ...rec.stats, histogram: undefined, loadMs: rec.loadMs, statsMs: rec.statsMs },
      };
    },
  });

  scenarios.set('non-mask-files', {
    name: 'non-mask-files',
    summary:
      'The two files in this set that are NOT plain floor masks (_Overhead_Outdoors, _WaterHard). Records ' +
      'them so discovery can later be asserted against them; no kind should silently claim _WaterHard.',
    async run() {
      // ✅ BOTH OF THESE ARE NOW COVERED — in NODE, not here, which is the right
      // place for them: `matchMaskFiles` is a pure exported function, so the
      // question "would discovery adopt this file" needs no GPU, no fetch and
      // no browser. `src/foundry/__tests__/mask-discovery.test.mjs` pins the
      // art-variant fallback, the exact-base-wins rule, and (2026-08-01) that a
      // `_WaterHard` art variant can never be adopted as the `_Water` mask.
      //
      // Recorded as passes with an explicit pointer rather than deleted: this
      // scenario's job is to keep the odd files in the map folder VISIBLE, and
      // a bench that quietly stopped mentioning them would be less useful, not
      // more.
      return {
        checks: FIXTURE.nonMaskFiles.map((f) =>
          check({
            id: `non-mask-recorded:${f.file}`,
            status: f.coveredBy ? 'pass' : 'UNMEASURED',
            measured: f.coveredBy ? `covered by ${f.coveredBy}` : 'recorded, not yet asserted',
            expected: f.coveredBy ? 'a Node test asserting discovery behaviour' : 'a discovery run to assert against',
            note: f.why,
          })
        ),
        inputs: { files: FIXTURE.nonMaskFiles.map((f) => ({ file: f.file, role: f.role ?? f.layer ?? null })) },
        stats: null,
      };
    },
  });

  /** @param {object} scenario @param {object} ctx */
  async function runScenario(scenario, ctx) {
    const result = await scenario.run(ctx);
    const canvas = document.getElementById('fixtureView');
    const artifacts = [];
    if (canvas && canvas.width > 0) {
      const saved = await saveCanvasPng(ctx.runId, 'mask.png', canvas);
      if (saved) artifacts.push(saved);
    }
    return { ...result, artifacts: [...(result.artifacts ?? []), ...artifacts] };
  }

  registerBench({
    name: 'fixture',
    title: 'Fixture ingest — real masks through the real loader',
    rung: 2,
    summary:
      'Runs src/vt/mask-image.js#loadMaskImageTexture against the real Tower Bridge mask set (3 floors, ' +
      '10650x4950). Ingest only — no derivation, no composite, orientation deliberately UNMEASURED.',
    scenarios,
    params: {
      scale: `number, default ${EXPLORE_SCALE} (production is 1, or 0.5 for specular)`,
      floorId: 'underground | middle | roof',
    },
    checkIds: [
      'native-dimensions',
      'upload-size-matches-scale',
      'outdoors-content-bounds',
      'outdoors-both-polarities',
      'floor-polarity-*',
      'gray-contract:*',
      'specular-has-colour',
      'orientation (always UNMEASURED at this rung)',
      'authored-world-points (UNMEASURED until FIXTURE.authored is filled)',
    ],
    ready: () => true,
    runScenario,
  });

  return {
    state,
    FIXTURE,
    loadOne,
    entryFor,
    sampleWorld,
    paint,
    setLegend,
    releaseAll,
    scenarios,
    getHeldMegabytes: () => Number((heldBytes / 1048576).toFixed(2)),
    getCacheKeys: () => [...cache.keys()],
    getRecord: (key) => cache.get(key ?? state.lastKey) ?? null,
  };
}
