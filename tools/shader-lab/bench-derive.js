/**
 * SHADER LAB — THE DERIVATION BENCH (rung 2, second half).
 *
 * ============================================================================
 * THIS IS THE GAP THE SUN-SHADOW DOUBLE-SHADOW ESCAPED THROUGH
 * ============================================================================
 * `docs/planning/Sun-Shadows-Redesign.md`, "What the lab was missing", names it
 * exactly: the CPU twin matched the GPU shader decimal-for-decimal in the lab
 * while the live scene still showed a double shadow, because the lab
 * *rasterized its own synthetic caster packing directly* and never ran
 *
 *   real multi-floor mask sets → real derivation → the caster field
 *
 * `bench-fixture.js` closed the first arrow (real files through the real
 * loader). This closes the second: it calls the REAL `deriveFloorProducts` and
 * `rasterizeAuthored` (`src/scene/mask-derive.js`, unmodified) over a REAL
 * three-floor item set, and reports the per-floor bands, the caster channels,
 * and the completeness record the production path itself produces.
 *
 * ============================================================================
 * WHY THE ART, NOT JUST THE MASKS
 * ============================================================================
 * The author's steer was "real masks, not pretty pictures", and the masks are
 * the point — but the derivation's coverage input is genuinely **art alpha**
 * (`DeriveItemInput.alpha`, "art opacity at the pack's coarsest mip"), not a
 * mask. Substituting a mask for it would be inventing the producer's shape,
 * which is the one thing this bench exists to stop doing.
 *
 * So the art IS loaded — at `ART_ALPHA_SCALE`, a deliberately coarse fraction.
 * That is not a shortcut around the 8 MB files: production feeds this the VT
 * pack's COARSEST MIP, so a small decode is the faithful input, not a cheap
 * stand-in for a big one.
 *
 * ============================================================================
 * THE HEADLINE CHECK
 * ============================================================================
 * **Nothing is above the top floor.** `coverAbove` and `skyReach` for the Roof
 * must be empty, while the Underground's must not be — an ordering fact that no
 * single-floor bench can even ask, and precisely the axis a double shadow lives
 * on. It is falsified by a wrong `ownerFloorIndex`, an off-by-one band, a
 * swapped floor order, or a ceiling/bottom elevation mix-up.
 *
 * @module tools/shader-lab/bench-derive
 */
import { loadMaskImageTexture } from '../../src/vt/mask-image.js';
import {
  computeMaskGridSpec,
  deriveFloorProducts,
  rasterizeAuthored,
  maskGridMean,
  sampleMaskGridWorld,
  MASK_GRID_MAX_DIM,
} from '../../src/scene/mask-derive.js';
import { MASK_KINDS } from '../../src/scene/mask-catalog.js';
import FIXTURE, { WORLD_RECT, DERIVE } from './fixtures/tower-bridge.js';
import { check, evaluate, registerBench, saveCanvasPng } from './contract.js';

/**
 * Fraction of native the ART is decoded at to produce its alpha ContentGrid.
 * 10650 × 0.0625 ≈ 666 px — the same order as the VT pack's coarsest mip and
 * comfortably above the ≤512 derivation grid it feeds, so the grid is never
 * starved by its own input.
 */
const ART_ALPHA_SCALE = 0.0625;

/** The catalog's own absent value for a kind — read, never restated. */
function absentValueFor(kindId) {
  const kind = MASK_KINDS.find((k) => k.id === kindId);
  if (!kind) throw new Error(`no such mask kind '${kindId}' in mask-catalog.js`);
  return kind.absentValue;
}

/** Whole-world placement: this map's art covers the full rect, centred. */
function wholeWorldPlacement() {
  return {
    x: (WORLD_RECT.minX + WORLD_RECT.maxX) / 2,
    y: (WORLD_RECT.minY + WORLD_RECT.maxY) / 2,
    width: WORLD_RECT.maxX - WORLD_RECT.minX,
    height: WORLD_RECT.maxY - WORLD_RECT.minY,
    anchorX: 0.5,
    anchorY: 0.5,
    rotation: 0,
  };
}

/**
 * Crop a `ContentGrid` to a UV sub-rect, returning both the cropped content
 * and the world placement it should be drawn at.
 *
 * ⚠️ THE TWO MUST CHANGE TOGETHER. `worldToItemUv` maps an item's placement
 * rect onto its content's full 0..1 UV range, so handing a cropped placement a
 * full-canvas content squeezes the image into the crop instead of positioning
 * it. This exists because that mistake silently produces a *plausible* picture.
 *
 * @param {{w:number,h:number,data:Uint8Array}} content
 * @param {{minU:number,minV:number,maxU:number,maxV:number}} bounds
 * @returns {{content: object, placement: object}}
 */
function cropContentToBounds(content, bounds) {
  const x0 = Math.max(0, Math.floor(bounds.minU * content.w));
  const x1 = Math.min(content.w, Math.ceil(bounds.maxU * content.w));
  const y0 = Math.max(0, Math.floor(bounds.minV * content.h));
  const y1 = Math.min(content.h, Math.ceil(bounds.maxV * content.h));
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data[y * w + x] = content.data[(y0 + y) * content.w + (x0 + x)];
  }
  const worldW = WORLD_RECT.maxX - WORLD_RECT.minX;
  const worldH = WORLD_RECT.maxY - WORLD_RECT.minY;
  const placement = {
    x: WORLD_RECT.minX + ((bounds.minU + bounds.maxU) / 2) * worldW,
    y: WORLD_RECT.minY + ((bounds.minV + bounds.maxV) / 2) * worldH,
    width: (bounds.maxU - bounds.minU) * worldW,
    height: (bounds.maxV - bounds.minV) * worldH,
    anchorX: 0.5,
    anchorY: 0.5,
    rotation: 0,
  };
  return { content: { w, h, data }, placement };
}

/** Measure the painted AABB of a ContentGrid, in its own UV space. */
function contentBoundsOf(content, emptyByte = 1) {
  let minX = content.w;
  let minY = content.h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < content.h; y++) {
    for (let x = 0; x < content.w; x++) {
      if (content.data[y * content.w + x] > emptyByte) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return {
    minU: minX / content.w,
    minV: minY / content.h,
    maxU: (maxX + 1) / content.w,
    maxV: (maxY + 1) / content.h,
  };
}

/**
 * ⚠️ `JSON.stringify(Infinity)` IS `null`, AND THAT IS AN INSTRUMENT LYING.
 *
 * A rooftop level's ceiling is genuinely `+Infinity` (author-given). Written
 * straight into `report.json` it comes back as `null`, which a later reader
 * would reasonably parse as "no value recorded" rather than "unbounded" — two
 * very different facts, one of which is a missing measurement. Every elevation
 * that reaches a report goes through here instead (`feedback_instruments_must_
 * not_lie`, applied to the reporting layer rather than the measurement).
 *
 * @param {number} v @returns {number|string}
 */
function reportElevation(v) {
  if (Number.isFinite(v)) return v;
  if (v === Number.POSITIVE_INFINITY) return 'Infinity (no ceiling declared)';
  if (v === Number.NEGATIVE_INFINITY) return '-Infinity';
  return 'unknown';
}

/** Fraction of a grid's bytes at or above `byte`. */
function fractionAtLeast(grid, byte) {
  let n = 0;
  for (let i = 0; i < grid.data.length; i++) if (grid.data[i] >= byte) n++;
  return n / grid.data.length;
}

/** Largest byte in a grid — "is this channel empty" without averaging it away. */
function maxByte(grid) {
  let m = 0;
  for (let i = 0; i < grid.data.length; i++) if (grid.data[i] > m) m = grid.data[i];
  return m;
}

/**
 * @param {object} args @param {*} args.THREE @param {(m:string)=>void} args.log
 * @returns {object}
 */
export function createDeriveBench({ THREE, log }) {
  /** Decoded content grids, keyed `${file}@${scale}@${channel}`. */
  const cache = new Map();
  let lastProducts = null;
  let lastGridSpec = null;

  /**
   * Decode one file and extract ONE channel into a `ContentGrid`
   * (`{w,h,data}`, row 0 = image top) — the shape `mask-derive.js` declares.
   * @param {string} url @param {number} scale @param {'alpha'|'r'} channel
   * @returns {Promise<object|null>}
   */
  async function loadContent(url, scale, channel) {
    const key = `${url}@${scale}@${channel}`;
    if (cache.has(key)) return cache.get(key);
    // 'rgb' for alpha (we need the 4th byte); 'r' is one byte per texel and is
    // exactly what a gray mask carries.
    const wantRgba = channel === 'alpha';
    const t0 = performance.now();
    const res = await loadMaskImageTexture({ url, THREE, scale, channels: wantRgba ? 'rgb' : 'r' });
    if (!res) {
      log?.(`DERIVE: failed to load ${url}`);
      return null;
    }
    const texels = res.width * res.height;
    const data = new Uint8Array(texels);
    if (wantRgba) {
      for (let i = 0; i < texels; i++) data[i] = res.data[i * 4 + 3];
    } else {
      data.set(res.data.subarray(0, texels));
    }
    // The texture itself is not wanted here — only the CPU bytes — and holding
    // it would leak a GPU allocation per decode.
    res.texture?.dispose?.();
    const content = { w: res.width, h: res.height, data };
    cache.set(key, content);
    log?.(
      `DERIVE: ${url.split('/').pop()} [${channel}] ${res.width}x${res.height} in ${Math.round(performance.now() - t0)}ms`
    );
    return content;
  }

  /**
   * Build the REAL item set: one level BACKGROUND per floor at its band bottom,
   * plus one level FOREGROUND (the `_Overhead` art) where the fixture has one,
   * at its band top.
   *
   * ⚠️ `ownerFloorIndex` is set on every one of these and that is load-bearing,
   * not decoration: for a LEVEL's own art it OUTRANKS elevation in the
   * "is it above me" test, and the 2026-07-26 sky-reach fix exists because
   * elevation alone silently dropped every upper-floor background the moment
   * two bands failed to abut exactly.
   */
  async function buildItems(overheadHostType = 'levelForeground') {
    const items = [];
    const placement = wholeWorldPlacement();
    for (const floor of FIXTURE.floors) {
      const bg = FIXTURE.artLayers.find((a) => a.floorId === floor.id && a.role === 'background');
      if (bg) {
        const alpha = await loadContent(`${FIXTURE.dir}/${bg.file}`, ART_ALPHA_SCALE, 'alpha');
        items.push({
          id: `${floor.id}-background`,
          elevation: floor.elevation.bottom,
          hidden: false,
          placement,
          alpha,
          ownerFloorIndex: floor.index,
          visibleFloorIndices: null,
        });
      }
      const fg = FIXTURE.artLayers.find((a) => a.floorId === floor.id && a.role === 'overhead');
      if (fg) {
        const alpha = await loadContent(`${FIXTURE.dir}/${fg.file}`, ART_ALPHA_SCALE, 'alpha');
        // ⚠️ THE HOST TYPE IS THE WHOLE QUESTION (author-ruled: "I use tiles or
        // the foreground image for that scene's level"). Both are real, and the
        // derivation bands them differently — see `OVERHEAD_HOST_TYPES` in the
        // fixture for the table. Modelling only the first left the OVERHEAD
        // caster band permanently empty.
        const asTile = overheadHostType === 'tile';
        // ⚠️ AN UNBOUNDED BAND HAS NO "top − 1". The rooftop level's ceiling is
        // `+Infinity` (author-given), and `Infinity − 1` is still `Infinity` —
        // which would hand the derivation a nonsense elevation and, worse, one
        // that reads as plausible. For an unbounded floor the only meaningful
        // "raised above this floor" is measured from its BOTTOM.
        const bandTop = floor.elevation.top;
        const bounded = Number.isFinite(bandTop);
        // A level FOREGROUND sits AT its band's top (the derivation's own
        // documented case: "the floor's OWN roof art sits exactly AT the
        // ceiling"). A TILE must sit strictly INSIDE the band to read as
        // overhead (`elevation > bottom && elevation < ceiling`), so the
        // author's "highest element on that floor" becomes ceiling − 1.
        // Neither rule has a meaning on an unbounded floor, so both fall back
        // to one step above the band's bottom rather than propagating Infinity.
        const foregroundElevation = bounded ? bandTop : floor.elevation.bottom + 1;
        const tileElevation = bounded ? bandTop - 1 : floor.elevation.bottom + 1;
        items.push({
          id: `${floor.id}-overhead`,
          elevation: asTile ? tileElevation : foregroundElevation,
          hidden: false,
          placement,
          alpha,
          ownerFloorIndex: asTile ? null : floor.index,
          visibleFloorIndices: asTile ? [floor.index] : null,
        });
      }
    }
    return items;
  }

  /** Floors in the shape `deriveFloorProducts` declares. */
  function buildFloors() {
    return FIXTURE.floors.map((f) => ({
      index: f.index,
      ceilingElevation: f.elevation.top,
      bottomElevation: f.elevation.bottom,
      // Real authored `_Outdoors` per floor, as a rasterizeAuthored source list.
      outdoors: [],
    }));
  }

  /**
   * Run the REAL derivation. Returns `{products, gridSpec, items, floors}`.
   * @param {object} [opts] @param {number} [opts.gridMaxDim] @param {number} [opts.casterGridDim]
   */
  async function derive(opts = {}) {
    const rect = {
      x: WORLD_RECT.minX,
      y: WORLD_RECT.minY,
      width: WORLD_RECT.maxX - WORLD_RECT.minX,
      height: WORLD_RECT.maxY - WORLD_RECT.minY,
    };
    const gridSpec = computeMaskGridSpec(rect, opts.gridMaxDim ?? MASK_GRID_MAX_DIM);
    const casterGridSpec = opts.casterGridDim ? computeMaskGridSpec(rect, opts.casterGridDim) : null;

    const items = await buildItems(opts.overheadHostType ?? 'levelForeground');
    const floors = buildFloors();

    // THE AUTHORED OUTDOORS, through the REAL rasterizer. Each floor's own
    // `_Outdoors` file becomes a source; `rasterizeAuthored` overwrites in
    // ascending draw order and leaves the catalog's absent value everywhere no
    // source reaches.
    const placement = wholeWorldPlacement();
    const outdoorsAbsent = absentValueFor('outdoors');
    for (const floor of floors) {
      const fx = FIXTURE.floors.find((f) => f.index === floor.index);
      const entry = FIXTURE.maskFiles.find((e) => e.floorId === fx.id && e.kind === 'outdoors');
      if (!entry) continue;
      const content = await loadContent(entry.url, ART_ALPHA_SCALE, 'r');
      if (!content) continue;
      // ⚠️ THE MASK'S OWN ALPHA RIDES ALONGSIDE ITS `r` CHANNEL — production
      // parity, and it was MISSING here until 2026-08-02.
      // `mask-authority.js#ingestDecodedPage` extracts both from one decoded
      // page and `rasterizeAuthored` composites source-over
      // (`compositeItemOverwrite`'s own header has the author's ruling:
      // *"Transparent means unpainted... Transparent also means not inside a
      // building"*). This bench built its sources with `content` ALONE, so
      // `source.alpha` was `undefined` and the composite silently fell back
      // to fully-opaque — writing a transparent texel's `r` of 0 as a real,
      // shadow-casting WALL. The lab therefore never once exercised the alpha
      // fix it was supposed to be validating, and showed phantom building
      // shadows off every unpainted edge while production (correctly) did
      // not. Same class as the `casterGridDim` divergence one commit earlier:
      // a bench that builds its own inputs differently from production is
      // measuring a different picture (feedback_instruments_must_not_lie).
      const alpha = await loadContent(entry.url, ART_ALPHA_SCALE, 'alpha');
      const sources = [{ placement, content, alpha }];
      // ⚠️ THE SECOND HOST, off by default because the author's ruling is that
      // overhead content should resolve against the floor's OWN mask
      // (`OUTDOORS_RESOLUTION_RULING`). Turning it on appends the overhead
      // item's own `_Outdoors` as a LATER source, which `rasterizeAuthored`
      // overwrites with inside its footprint — the whole point of the
      // `overhead-outdoors-composition` scenario is to show what that costs.
      if (opts.includeOverheadOutdoors) {
        const extra = FIXTURE.nonMaskFiles.find(
          (f) => f.floorId === fx.id && f.kind === 'outdoors' && f.layer === 'overhead'
        );
        if (extra) {
          const oc = await loadContent(`${FIXTURE.dir}/${extra.file}`, ART_ALPHA_SCALE, 'r');
          if (oc) {
            // ⚠️ PLACEMENT DECIDES EVERYTHING HERE. The file is full-canvas but
            // its painted content is not (97.9% transparent padding), so:
            //   'fullCanvas' — the level FOREGROUND case: the host really is
            //     the whole scene rect, so the overwrite covers the whole map
            //     and the padding lands as authored "indoors".
            //   'contentBounds' — the TILE case: a tile sized to its own art,
            //     so the overwrite is confined to where the art actually is.
            // Modelling only one would have made this scenario's headline
            // number an artefact of an undeclared assumption.
            if (opts.overheadOutdoorsPlacement === 'contentBounds') {
              const b = contentBoundsOf(oc);
              if (b) {
                const cropped = cropContentToBounds(oc, b);
                sources.push({ placement: cropped.placement, content: cropped.content });
              }
            } else {
              sources.push({ placement, content: oc });
            }
          }
        }
      }
      floor.outdoors = sources;
    }

    const products = deriveFloorProducts({
      gridSpec,
      items,
      floors,
      outdoorsAbsentValue: outdoorsAbsent,
      casterHeights: DERIVE.casterHeights,
      casterGridSpec,
    });
    lastProducts = products;
    lastGridSpec = gridSpec;
    return { products, gridSpec, casterGridSpec, items, floors, outdoorsAbsent };
  }

  /**
   * Paint one grid to the derive canvas, nearest-expanded to fill the width.
   *
   * ⚠️ A `MaskGrid` is `{spec, data}` — its dimensions live on `.spec.w/.h`. A
   * `ContentGrid` is `{w, h, data}`. Two neighbouring types in one module with
   * different shapes; the first version of this bench read `grid.w` on a
   * MaskGrid, got `undefined`, and died in `new ImageData`. Hence `gridDims`,
   * which handles either and is the ONLY place this bench asks for a size.
   */
  function gridDims(grid) {
    if (!grid) return null;
    if (grid.spec) return { w: grid.spec.w, h: grid.spec.h };
    if (Number.isFinite(grid.w) && Number.isFinite(grid.h)) return { w: grid.w, h: grid.h };
    return null;
  }

  function paintGrid(grid, label) {
    const canvas = document.getElementById('deriveView');
    const dims = gridDims(grid);
    if (!canvas || !dims || !(dims.w > 0 && dims.h > 0)) return;
    const outW = canvas.width;
    const outH = Math.max(1, Math.round((outW * dims.h) / dims.w));
    if (canvas.height !== outH) canvas.height = outH;
    const out = new Uint8ClampedArray(outW * outH * 4);
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(dims.h - 1, Math.floor((y * dims.h) / outH));
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(dims.w - 1, Math.floor((x * dims.w) / outW));
        const v = grid.data[sy * dims.w + sx];
        const o = (y * outW + x) * 4;
        out[o] = v;
        out[o + 1] = v;
        out[o + 2] = v;
        out[o + 3] = 255;
      }
    }
    canvas.getContext('2d').putImageData(new ImageData(out, outW, outH), 0, 0);
    const el = document.getElementById('deriveLegend');
    if (el) {
      // `maskGridMean` returns 0..1, not a byte — reported as both so neither
      // reading can be mistaken for the other.
      const mean01 = maskGridMean(grid);
      el.textContent = `${label}\ngrid ${dims.w}x${dims.h}  mean=${mean01.toFixed(4)} (${Math.round(mean01 * 255)}/255)  max=${maxByte(grid)}`;
    }
  }

  // -------------------------------------------------------------------------
  // Scenarios
  // -------------------------------------------------------------------------
  const scenarios = new Map();

  scenarios.set('multi-floor-bands', {
    name: 'multi-floor-bands',
    summary:
      'THE headline scenario. Runs the real deriveFloorProducts over all three floors and asserts the ' +
      'ordering facts a single-floor bench cannot ask — above all, that NOTHING is above the top floor.',
    async run() {
      const { products, gridSpec, items } = await derive();
      const checks = [];
      const perFloor = [];

      for (const p of products) {
        const fx = FIXTURE.floors.find((f) => f.index === p.index);
        const coverMax = maxByte(p.coverAbove);
        const skyMax = maxByte(p.skyReach);
        const casterMax = maxByte(p.casterHeight);
        perFloor.push({
          floor: fx.id,
          index: p.index,
          coverAboveMean: Number(maskGridMean(p.coverAbove).toFixed(2)),
          coverAboveMax: coverMax,
          skyReachMean: Number(maskGridMean(p.skyReach).toFixed(2)),
          skyReachMax: skyMax,
          casterHeightMax: casterMax,
          maxCasterHeightPx: p.completeness.maxCasterHeightPx,
          bottomElevation: reportElevation(p.completeness.bottomElevation),
          ceilingElevation: reportElevation(p.completeness.ceilingElevation),
          outdoorsSource: p.completeness.outdoorsSource,
          skyReachItemIds: p.completeness.skyReachItemIds,
          overheadItemIds: p.completeness.overheadItemIds,
          missingItemIds: p.completeness.missingItemIds,
        });

        // Completeness first: a missing item makes every band number below it a
        // measurement of an incomplete set rather than a fact about the map.
        checks.push(
          evaluate(`no-missing-art:${fx.id}`, () => ({
            ok: p.completeness.missingItemIds.length === 0,
            measured: p.completeness.missingItemIds,
            expected: '[]',
            note: 'a null alpha never guesses coverage — it lands here instead',
          }))
        );
        checks.push(
          evaluate(`outdoors-is-authored:${fx.id}`, () => ({
            ok: p.completeness.outdoorsSource === 'authored',
            measured: p.completeness.outdoorsSource,
            expected: 'authored',
            note: "'default' would mean the real _Outdoors file never reached rasterizeAuthored",
          }))
        );
      }

      const top = products.find((p) => p.index === Math.max(...FIXTURE.floors.map((f) => f.index)));
      const bottom = products.find((p) => p.index === Math.min(...FIXTURE.floors.map((f) => f.index)));

      // ⚠️ THE HEADLINE. Nothing is above the top floor.
      //
      // `coverAbove` ONLY. The first version of this check also demanded
      // `skyReach === 0` and failed — correctly, because it was wrong:
      // `skyReach = outdoors × (1 − coverAbove)` (mask-catalog.js's own
      // definition of the kind). With nothing above it, the top floor's
      // sky-reach IS its outdoors mask, which is the opposite of zero. Two
      // adjacent products answering two different questions
      // ("is something above me" vs "can I see sky"), and the catalog warns
      // about exactly this confusion in `coverAbove`'s own doc.
      checks.push(
        evaluate('nothing-above-top-floor', () => ({
          ok: maxByte(top.coverAbove) === 0,
          measured: `coverAboveMax=${maxByte(top.coverAbove)}`,
          expected: '0',
          note: 'falsified by a wrong ownerFloorIndex, an off-by-one band, or a swapped floor order',
        }))
      );
      // The consequence of that, checked against an AUTHOR-RATIFIED number
      // rather than against the implementation: with cover = 0 the identity
      // collapses to skyReach = outdoors, so the top floor's sky-reach
      // fraction must land on its ratified outdoors fraction. Any cover
      // leaking onto the top floor drags this DOWN, and nothing else can.
      checks.push(
        evaluate('top-floor-skyreach-equals-its-outdoors', () => {
          const fx = FIXTURE.floors.find((f) => f.index === top.index);
          const skyFrac = fractionAtLeast(top.skyReach, 128);
          return {
            ok: Math.abs(skyFrac - fx.outdoorsFraction) <= DERIVE.outdoorsFractionTolerance,
            measured: Number(skyFrac.toFixed(4)),
            expected: `${fx.outdoorsFraction} ±${DERIVE.outdoorsFractionTolerance} (the ratified outdoors fraction)`,
            note: 'nothing above the top floor ⇒ skyReach collapses to outdoors; cover leaking in lowers this',
          };
        })
      );
      // And the mirror: every floor that DOES have something above it must see
      // less sky than it has open ground. Ordering, not arithmetic.
      for (const p of products.filter((x) => x.index !== top.index)) {
        const fx = FIXTURE.floors.find((f) => f.index === p.index);
        checks.push(
          evaluate(`covered-floor-sees-less-sky-than-outdoors:${fx.id}`, () => {
            const skyFrac = fractionAtLeast(p.skyReach, 128);
            return {
              ok: skyFrac < fx.outdoorsFraction,
              measured: `skyReach=${skyFrac.toFixed(4)} vs outdoors=${fx.outdoorsFraction}`,
              expected: 'strictly less',
              note: 'a floor with art above it cannot see as much sky as it has open ground',
            };
          })
        );
      }
      checks.push(
        evaluate('bottom-floor-has-cover-above', () => ({
          ok: maxByte(bottom.coverAbove) > 0,
          measured: `coverAboveMax=${maxByte(bottom.coverAbove)}, mean=${maskGridMean(bottom.coverAbove).toFixed(2)}`,
          expected: '> 0',
          note: 'two whole floors of art sit above the underground; zero here means the band test never fired',
        }))
      );
      checks.push(
        evaluate('cover-above-decreases-with-height', () => {
          const means = products
            .slice()
            .sort((a, b) => a.index - b.index)
            .map((p) => maskGridMean(p.coverAbove));
          let monotonic = true;
          for (let i = 1; i < means.length; i++) if (means[i] > means[i - 1] + 1e-6) monotonic = false;
          return {
            ok: monotonic,
            measured: means.map((m) => Number(m.toFixed(2))),
            expected: 'non-increasing from bottom floor to top',
            note: 'each floor up has strictly fewer floors above it, so its cover cannot grow',
          };
        })
      );
      // ⚠️ THE UNBOUNDED BAND (author-given: rooftops are "40 - infinity").
      // `+Infinity` is a real, distinct path — `deriveFloorProducts` documents
      // it as "no ceiling declared: nothing counts as above, and the report
      // says so rather than inventing a number". Two things must hold, and the
      // second is the one that matters: the completeness record has to carry
      // the infinity through honestly instead of normalising it to a number,
      // because a fabricated ceiling is indistinguishable from a real one
      // downstream.
      const unbounded = products.filter((p) => !Number.isFinite(p.completeness.ceilingElevation));
      checks.push(
        evaluate('unbounded-ceiling-survives-derivation', () => ({
          ok: unbounded.length === 1 && unbounded[0].index === top.index,
          measured: products.map((p) => `${p.index}:${p.completeness.ceilingElevation}`),
          expected: 'exactly the top floor reports a non-finite ceiling',
          note: 'a ceiling silently replaced by a finite number would look identical to a declared one',
        }))
      );
      checks.push(
        evaluate('unbounded-floor-still-derives-a-real-gate', () => {
          const p = unbounded[0];
          if (!p) return { ok: false, measured: 'no unbounded floor', expected: 'one' };
          const frac = fractionAtLeast(p.outdoors, 128);
          return {
            ok: frac > 0 && frac < 1,
            measured: Number(frac.toFixed(4)),
            expected: 'strictly between 0 and 1',
            note: 'an infinite ceiling must not blank the floor — its outdoors gate is still real work',
          };
        })
      );
      checks.push(
        evaluate('every-item-classified', () => {
          const banded = new Set(
            products.flatMap((p) => [...p.completeness.skyReachItemIds, ...p.completeness.overheadItemIds])
          );
          return {
            ok: banded.size > 0,
            measured: `${banded.size} of ${items.length} items landed in a caster band somewhere`,
            expected: '> 0',
            note: 'zero would mean the whole item set was classified as ground and nothing casts',
          };
        })
      );

      paintGrid(bottom.coverAbove, 'coverAbove — UNDERGROUND (everything above it)');
      return {
        checks,
        inputs: {
          gridSpec: { w: gridSpec.w, h: gridSpec.h },
          artAlphaScale: ART_ALPHA_SCALE,
          items: items.map((i) => ({ id: i.id, elevation: i.elevation, ownerFloorIndex: i.ownerFloorIndex })),
          casterHeights: DERIVE.casterHeights,
        },
        stats: { perFloor },
      };
    },
  });

  scenarios.set('derived-vs-ingested-outdoors', {
    name: 'derived-vs-ingested-outdoors',
    summary:
      'Ties rung 2a to rung 2b: the outdoors grid that rasterizeAuthored produces at 512 must agree with ' +
      "the same file's full-resolution ingest. Catches a placement/UV or overwrite bug in the rasterizer.",
    async run() {
      const { products } = await derive();
      const checks = [];
      const rows = [];
      for (const p of products) {
        const fx = FIXTURE.floors.find((f) => f.index === p.index);
        const derivedBright = fractionAtLeast(p.outdoors, 128);
        const expected = fx.outdoorsFraction;
        rows.push({ floor: fx.id, derivedBright: Number(derivedBright.toFixed(4)), ratified: expected });
        checks.push(
          evaluate(`derived-outdoors-matches-ratified:${fx.id}`, () => ({
            // Looser than the ingest check's ±0.02: this grid is a 512-texel
            // resample of a 10650px source through a different code path, so a
            // little more drift is honest rather than a failure.
            ok: Math.abs(derivedBright - expected) <= DERIVE.outdoorsFractionTolerance,
            measured: Number(derivedBright.toFixed(4)),
            expected: `${expected} ±${DERIVE.outdoorsFractionTolerance}`,
            note: 'the derived grid and the ingested file describe the same painting; a UV/placement bug separates them',
          }))
        );
      }
      // A world-space spot check through the REAL sampler, at the map centre.
      const mid = products.find((p) => p.index === 1);
      checks.push(
        evaluate('world-sampler-returns-a-value', () => {
          const v = sampleMaskGridWorld(
            mid.outdoors,
            (WORLD_RECT.minX + WORLD_RECT.maxX) / 2,
            (WORLD_RECT.minY + WORLD_RECT.maxY) / 2
          );
          return {
            ok: v !== null && v !== undefined,
            measured: v,
            expected: 'a byte, not null',
            note: 'sampleMaskGridWorld is what every caster bake reads the gate with',
          };
        })
      );
      paintGrid(mid.outdoors, 'outdoors — MIDDLE, via the real rasterizeAuthored');
      return { checks, inputs: { tolerance: DERIVE.outdoorsFractionTolerance }, stats: { rows } };
    },
  });

  scenarios.set('caster-grid-dim-independence', {
    name: 'caster-grid-dim-independence',
    summary:
      'The 2026-07-30 corruption bug, as a regression scenario: the caster channels rasterize at ' +
      'casterGridDim while the outdoors gate stays at 512. Raising one must not shear the other.',
    async run(ctx) {
      const dims = ctx.params.casterGridDims ?? [512, 768, 1024];
      const checks = [];
      const rows = [];
      for (const dim of dims) {
        const { products } = await derive({ casterGridDim: dim });
        const p = products.find((x) => x.index === 0);
        const cov = fractionAtLeast(p.casterChannels.coverSkyReach, 128);
        rows.push({
          casterGridDim: dim,
          casterGrid: `${gridDims(p.casterHeight).w}x${gridDims(p.casterHeight).h}`,
          outdoorsGrid: `${gridDims(p.outdoors).w}x${gridDims(p.outdoors).h}`,
          coverSkyReachFraction: Number(cov.toFixed(4)),
          casterHeightMax: maxByte(p.casterHeight),
        });
        checks.push(
          evaluate(`caster-grid-sized:${dim}`, () => ({
            ok: Math.max(gridDims(p.casterHeight).w, gridDims(p.casterHeight).h) === dim,
            measured: `${gridDims(p.casterHeight).w}x${gridDims(p.casterHeight).h}`,
            expected: `long side ${dim}`,
            note: 'the caster channels follow casterGridDim independently of the shared 512 grid',
          }))
        );
        checks.push(
          evaluate(`outdoors-stays-512:${dim}`, () => ({
            ok: Math.max(gridDims(p.outdoors).w, gridDims(p.outdoors).h) === MASK_GRID_MAX_DIM,
            measured: `${gridDims(p.outdoors).w}x${gridDims(p.outdoors).h}`,
            expected: `long side ${MASK_GRID_MAX_DIM}`,
            note: 'the shared grid must NOT follow casterGridDim — that coupling is what sheared rows',
          }))
        );
      }
      // ⚠️ PROVE THE DETECTOR IS NOT VACUOUS.
      //
      // Everything above passes on the FIXED code, which on its own says
      // nothing — a check that has never fired is not known to work
      // (`feedback_instruments_must_not_lie`, and the vegetation Jacobian
      // test's own "prove it fires at 10× the cap" discipline).
      //
      // Rather than revert the fix in `src/` (never, in the author's working
      // tree), this reproduces the 2026-07-30 mechanism HERE, on the real
      // grids: read the 512-stride outdoors gate with the CASTER grid's own
      // flat index, exactly as the buggy loop did, and compare against the
      // world-sampled read that replaced it. If those two agree, this whole
      // scenario is measuring nothing and should be deleted.
      const { products: p1024 } = await derive({ casterGridDim: 1024 });
      const probe = p1024.find((x) => x.index === 0);
      const gate = probe.outdoors;
      const casterDims = gridDims(probe.casterHeight);
      const gateDims = gridDims(gate);
      let agreeBuggy = 0;
      let agreeWorld = 0;
      let n = 0;
      for (let gy = 0; gy < casterDims.h; gy += 3) {
        const wy = probe.casterHeight.spec.y + (gy + 0.5) * probe.casterHeight.spec.texelH;
        for (let gx = 0; gx < casterDims.w; gx += 3) {
          const wx = probe.casterHeight.spec.x + (gx + 0.5) * probe.casterHeight.spec.texelW;
          const flat = gate.data[gy * casterDims.w + gx]; // THE BUG: wrong stride
          const world = sampleMaskGridWorld(gate, wx, wy); // THE FIX
          if ((flat ?? 0) >= 128) agreeBuggy++;
          if ((world ?? 255) >= 128) agreeWorld++;
          n++;
        }
      }
      const buggyFrac = agreeBuggy / n;
      const worldFrac = agreeWorld / n;
      checks.push(
        evaluate('detector-is-not-vacuous', () => ({
          ok: Math.abs(buggyFrac - worldFrac) > DERIVE.casterDimCoverageSpreadMax,
          measured: `flatIndexRead=${buggyFrac.toFixed(4)} vs worldSampled=${worldFrac.toFixed(4)}`,
          expected: `differing by more than ${DERIVE.casterDimCoverageSpreadMax}`,
          note:
            'reproduces the 2026-07-30 stride mismatch on the real gate grid. If these AGREE, the ' +
            'stability check above cannot detect the bug it exists for.',
        }))
      );
      rows.push({ vacuityProbe: { casterGrid: casterDims, gateGrid: gateDims, buggyFrac, worldFrac } });

      // The real regression test: coverage must be stable across resolutions.
      // A row-stride mismatch shows up as the fraction jumping between dims.
      const fracs = rows.filter((r) => r.coverSkyReachFraction !== undefined).map((r) => r.coverSkyReachFraction);
      const spread = Math.max(...fracs) - Math.min(...fracs);
      checks.push(
        evaluate('coverage-stable-across-caster-dims', () => ({
          ok: spread <= DERIVE.casterDimCoverageSpreadMax,
          measured: Number(spread.toFixed(4)),
          expected: `<= ${DERIVE.casterDimCoverageSpreadMax}`,
          note:
            "the 2026-07-30 bug read a 512-stride buffer with the caster grid's stride: at 1024 every row " +
            'doubled, at 768 it sheared. Both move this number a long way.',
        }))
      );
      return { checks, inputs: { dims }, stats: { rows } };
    },
  });

  scenarios.set('overhead-host-type', {
    name: 'overhead-host-type',
    summary:
      'AUTHOR-RULED: overhead art is hosted by a TILE or by the level FOREGROUND, and the author uses ' +
      'both. Runs the derivation once per host type and asserts they band differently — the tile path ' +
      'is the only thing that ever fills the OVERHEAD caster band.',
    async run() {
      const checks = [];
      const byType = {};
      for (const hostType of FIXTURE.overheadHostTypes) {
        const { products } = await derive({ overheadHostType: hostType });
        byType[hostType] = products.map((p) => {
          const fx = FIXTURE.floors.find((f) => f.index === p.index);
          return {
            floor: fx.id,
            overheadItemIds: p.completeness.overheadItemIds,
            skyReachItemIds: p.completeness.skyReachItemIds,
            coverOverheadMax: maxByte(p.casterChannels.coverOverhead),
            casterOverheadMax: maxByte(p.casterChannels.overhead),
            bands: p.completeness.itemBands.filter((b) => b.id.endsWith('-overhead')).map((b) => `${b.id}:${b.band}`),
          };
        });
      }

      // A level's own art is NEVER overhead — the derivation says so explicitly
      // ("a level's OWN art is never an overhead protrusion"). So this host type
      // must leave the overhead band empty on every floor.
      checks.push(
        evaluate('levelForeground-never-fills-overhead-band', () => {
          const anyOverhead = byType.levelForeground.some((r) => r.overheadItemIds.length > 0);
          return {
            ok: !anyOverhead,
            measured: byType.levelForeground.map((r) => `${r.floor}:[${r.overheadItemIds}]`),
            expected: 'empty on every floor',
            note: 'mask-derive.js gates isOverhead on owner === null; level art is above or it is ground',
          };
        })
      );
      // ...and the tile host is what actually exercises that band.
      checks.push(
        evaluate('tile-host-fills-overhead-band', () => {
          const filled = byType.tile.filter((r) => r.overheadItemIds.length > 0);
          return {
            ok: filled.length > 0,
            measured: byType.tile.map((r) => `${r.floor}:[${r.overheadItemIds}]`),
            expected: 'at least one floor with an overhead item',
            note: 'if this is empty, the OVERHEAD caster band is dead code as far as this lab is concerned',
          };
        })
      );
      checks.push(
        evaluate('tile-host-produces-overhead-coverage', () => {
          const m = Math.max(...byType.tile.map((r) => r.coverOverheadMax));
          return {
            ok: m > 0,
            measured: m,
            expected: '> 0',
            note: 'coverOverhead is gated to EXTERIOR texels only, so zero here would also mean the gate ate it',
          };
        })
      );
      // Both host types still agree about the floors BELOW — an overhead item
      // is above them either way, and nothing about the host changes that.
      checks.push(
        evaluate('both-hosts-agree-below', () => {
          const a = byType.levelForeground.find((r) => r.floor === 'underground').skyReachItemIds.length;
          const b = byType.tile.find((r) => r.floor === 'underground').skyReachItemIds.length;
          return {
            ok: a === b,
            measured: `levelForeground=${a} tile=${b}`,
            expected: 'equal',
            note: 'the host type decides the OWN-floor band, never whether the thing is above a lower floor',
          };
        })
      );
      return { checks, inputs: { hostTypes: FIXTURE.overheadHostTypes }, stats: byType };
    },
  });

  scenarios.set('overhead-outdoors-composition', {
    name: 'overhead-outdoors-composition',
    summary:
      "AUTHOR'S OPEN QUESTION: overhead content should ideally resolve against the FLOOR's own _Outdoors. " +
      'This measures what a per-overhead-item _Outdoors would change if it were discovered as a second ' +
      'host — the real rasterizeAuthored overwrite, on the real files. Reports the delta; asserts nothing ' +
      'about which is right.',
    async run() {
      const fx = FIXTURE.floors.find((f) => f.id === 'middle');
      const single = await derive({ overheadHostType: 'tile', includeOverheadOutdoors: false });
      const a = single.products.find((p) => p.index === fx.index).outdoors;
      const aFrac = fractionAtLeast(a, 128);

      /** Diff the composited gate against the floor-mask-only baseline. */
      const diffAgainstBaseline = (grid) => {
        let changed = 0;
        let toIndoors = 0;
        let toOutdoors = 0;
        for (let i = 0; i < a.data.length; i++) {
          if (a.data[i] === grid.data[i]) continue;
          changed++;
          if (a.data[i] >= 128 && grid.data[i] < 128) toIndoors++;
          else if (a.data[i] < 128 && grid.data[i] >= 128) toOutdoors++;
        }
        return {
          changedFraction: Number((changed / a.data.length).toFixed(4)),
          flippedToIndoors: toIndoors,
          flippedToOutdoors: toOutdoors,
          outdoorsFraction: Number(fractionAtLeast(grid, 128).toFixed(4)),
        };
      };

      const variants = {};
      let lastGrid = null;
      for (const placementMode of ['fullCanvas', 'contentBounds']) {
        const run = await derive({
          overheadHostType: 'tile',
          includeOverheadOutdoors: true,
          overheadOutdoorsPlacement: placementMode,
        });
        const g = run.products.find((p) => p.index === fx.index).outdoors;
        variants[placementMode] = diffAgainstBaseline(g);
        lastGrid = g;
      }

      paintGrid(lastGrid, "outdoors — MIDDLE, overhead item's own _Outdoors composited (tile-sized placement)");
      return {
        checks: [
          evaluate('floor-only-matches-ratified', () => ({
            ok: Math.abs(aFrac - fx.outdoorsFraction) <= DERIVE.outdoorsFractionTolerance,
            measured: Number(aFrac.toFixed(4)),
            expected: `${fx.outdoorsFraction} ±${DERIVE.outdoorsFractionTolerance}`,
            note: "the author's PREFERRED path (floor mask only) must still land on the ratified fraction",
          })),
          // ⚠️ This one IS assertable, because it is not a matter of taste: a
          // full-canvas host's mask is mostly transparent PADDING, and an
          // unconditional overwrite cannot tell padding from authored indoors.
          // If that ever stops destroying the floor gate, either the overwrite
          // semantics or these files changed, and both are worth knowing.
          evaluate('full-canvas-second-host-destroys-the-floor-gate', () => ({
            ok: variants.fullCanvas.outdoorsFraction < aFrac / 2,
            measured: `${aFrac.toFixed(4)} -> ${variants.fullCanvas.outdoorsFraction}`,
            expected: 'less than half the floor-only fraction',
            note:
              'compositeItemOverwrite writes at EVERY texel in the placement, including where the content is ' +
              "black. A full-canvas host whose art covers 2% of the file therefore paints 98% 'indoors'.",
          })),
          check({
            id: 'second-host-delta',
            status: 'UNMEASURED',
            measured: { floorOnly: Number(aFrac.toFixed(4)), ...variants },
            expected: "an author ruling on whether a per-item mask should overwrite the floor's",
            note:
              'REPORTED, NOT JUDGED. Placement decides the answer: as a full-canvas level foreground the ' +
              'second mask wipes the gate; as a tile sized to its own art the damage is confined to the ' +
              "tile's footprint. The author's stated ideal (one _Outdoors per floor) avoids both.",
          }),
        ],
        inputs: { floor: 'middle', ruling: FIXTURE.outdoorsResolutionRuling, baselineFraction: aFrac },
        stats: { floorOnly: aFrac, variants },
      };
    },
  });

  /** @param {object} scenario @param {object} ctx */
  async function runScenario(scenario, ctx) {
    const result = await scenario.run(ctx);
    const canvas = document.getElementById('deriveView');
    const artifacts = [];
    if (canvas && canvas.width > 0) {
      const saved = await saveCanvasPng(ctx.runId, 'grid.png', canvas);
      if (saved) artifacts.push(saved);
    }
    return { ...result, artifacts };
  }

  registerBench({
    name: 'derive',
    title: 'Derivation — real mask sets through the real deriveFloorProducts',
    rung: 2,
    summary:
      'Runs scene/mask-derive.js#deriveFloorProducts + rasterizeAuthored over the real three-floor ' +
      'Tower Bridge set. This is the stage the live double-shadow escaped through.',
    scenarios,
    params: { casterGridDims: 'number[] for caster-grid-dim-independence (default [512,768,1024])' },
    checkIds: [
      'nothing-above-top-floor',
      'bottom-floor-has-cover-above',
      'cover-above-decreases-with-height',
      'no-missing-art:*',
      'outdoors-is-authored:*',
      'derived-outdoors-matches-ratified:*',
      'caster-grid-sized:* / outdoors-stays-512:*',
      'coverage-stable-across-caster-dims',
    ],
    ready: () => true,
    runScenario,
  });

  return {
    derive,
    buildItems,
    buildFloors,
    paintGrid,
    scenarios,
    getProducts: () => lastProducts,
    getGridSpec: () => lastGridSpec,
    releaseAll: () => {
      cache.clear();
      log?.('DERIVE: released cached content grids');
    },
  };
}
