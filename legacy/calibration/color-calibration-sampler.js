/**
 * @fileoverview In-Foundry color-chart calibration: sample RTs vs known patch sRGB.
 * @module calibration/color-calibration-sampler
 */

import { createLogger } from '../core/log.js';
import * as sceneSettings from '../settings/scene-settings.js';
import {
  ACTIVE_PRESET_FLAG_KEY,
  applyPresetToScene,
  getActivePresetId,
  loadBuiltInPresets,
} from '../ui/scene-presets.js';
import {
  isHalfFloatRt,
  readRtRegionToSrgb8,
  readRtPixelSrgb,
  resolveSceneRectInRtPixels,
} from '../utils/rt-pixel-readback.js';

const log = createLogger('ColorCalibration');

export const CHART_SPEC_URL_V1 = 'modules/map-shine-advanced/data/calibration/chart-spec-v1.json';
export const CHART_SPEC_URL_V2 = 'modules/map-shine-advanced/data/calibration/chart-spec-v2.json';

const DEFAULT_TAPS = ['busAlbedo', 'lit', 'preGrade', 'final'];

/** Yield to the browser between heavy GPU readback phases (avoids tab freeze). */
function yieldToMain() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 */
function deltaRgb(a, b) {
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}

/**
 * @param {[number, number, number]} d
 */
function deltaRgbLen(d) {
  return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
}

/**
 * @returns {Promise<object>}
 */
export function getChartSpecUrl(mode = 'v1') {
  return mode === 'v2' ? CHART_SPEC_URL_V2 : CHART_SPEC_URL_V1;
}

export async function loadChartSpec(mode = 'v1') {
  const res = await fetch(getChartSpecUrl(mode), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load chart spec (${res.status})`);
  return res.json();
}

/**
 * @param {object} [options]
 * @returns {Promise<object|null>}
 */
export async function loadChartSpecCached(options = {}) {
  const ms = globalThis.MapShine ?? {};
  const mode = options.mode === 'v2' ? 'v2' : 'v1';
  ms.__calibrationChartSpecs ??= {};
  if (!options.force && ms.__calibrationChartSpecs[mode]) return ms.__calibrationChartSpecs[mode];
  const spec = await loadChartSpec(mode);
  ms.__calibrationChartSpecs[mode] = spec;
  return spec;
}

/**
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget} rt
 * @param {number} u 0–1 across RT width (scene-rect normalized)
 * @param {number} v 0–1 from top (image space)
 * @returns {{ srgb: [number, number, number], rgba: number[] }|null}
 */
function mapUvToRectPixel(rt, rect, u, v) {
  const w = rt.width | 0;
  const h = rt.height | 0;
  if (rect && rect.w > 0 && rect.h > 0) {
    const px = Math.max(0, Math.min(w - 1, Math.floor(rect.x + u * rect.w)));
    const pyGl = Math.max(0, Math.min(h - 1, Math.floor(rect.y + (1 - v) * rect.h)));
    return { px, pyGl };
  }
  const px = Math.max(0, Math.min(w - 1, Math.floor(u * w)));
  const pyGl = Math.max(0, Math.min(h - 1, Math.floor((1 - v) * h)));
  return { px, pyGl };
}

export function sampleRtNorm(renderer, rt, u, v, sceneRectOverride = null) {
  if (!renderer?.readRenderTargetPixels || !rt || !(rt.width > 0) || !(rt.height > 0)) {
    return null;
  }
  const { px, pyGl } = mapUvToRectPixel(rt, sceneRectOverride, u, v);
  return readRtPixelSrgb(renderer, rt, px, pyGl);
}

/**
 * @param {object} patch
 * @returns {Array<{ u: number, v: number }>}
 */
function patchSampleUVs(patch) {
  const r = patch.rectNorm;
  const cx = r.x + r.w * 0.5;
  const cy = r.y + r.h * 0.5;
  const inset = 0.22;
  return [
    { u: cx, v: cy },
    { u: r.x + r.w * inset, v: r.y + r.h * inset },
    { u: r.x + r.w * (1 - inset), v: r.y + r.h * inset },
    { u: r.x + r.w * inset, v: r.y + r.h * (1 - inset) },
    { u: r.x + r.w * (1 - inset), v: r.y + r.h * (1 - inset) },
  ];
}

/**
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget} rt
 * @param {object} patch
 */
function samplePatchMedian(renderer, rt, patch, sceneRectOverride = null) {
  const samples = patchSampleUVs(patch).map((uv) => sampleRtNorm(renderer, rt, uv.u, uv.v, sceneRectOverride));
  const valid = samples.filter(Boolean);
  if (!valid.length) return null;
  const med = [0, 0, 0];
  for (const ch of [0, 1, 2]) {
    const vals = valid.map((s) => s.srgb[ch]).sort((a, b) => a - b);
    med[ch] = vals[Math.floor(vals.length / 2)];
  }
  return { srgb: med, sampleCount: valid.length };
}

/**
 * Detect chart border inside a candidate scene rect by looking for strong
 * white horizontal/vertical border lines from the generated chart PNG.
 *
 * @param {import('three').WebGLRenderer} renderer
 * @param {import('three').WebGLRenderTarget|null} rt
 * @param {{x:number,y:number,w:number,h:number}|null} sceneRect
 * @returns {{x:number,y:number,w:number,h:number,source:string}|null}
 */
function detectChartRectFromWhiteBorder(renderer, rt, sceneRect) {
  if (!renderer || !rt || !sceneRect?.w || !sceneRect?.h) return null;
  const x0 = Math.max(0, Math.floor(sceneRect.x));
  const y0 = Math.max(0, Math.floor(sceneRect.y));
  const w = Math.max(1, Math.floor(sceneRect.w));
  const h = Math.max(1, Math.floor(sceneRect.h));
  const pixels = readRtRegionToSrgb8(renderer, rt, x0, y0, w, h);
  if (!pixels) return null;

  const colCounts = new Uint32Array(w);
  const rowCounts = new Uint32Array(h);
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * 4;
    for (let x = 0; x < w; x++) {
      const i = rowBase + x * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const maxCh = Math.max(r, g, b);
      const minCh = Math.min(r, g, b);
      const isWhite = r >= 235 && g >= 235 && b >= 235 && (maxCh - minCh) <= 18;
      if (!isWhite) continue;
      colCounts[x] += 1;
      rowCounts[y] += 1;
    }
  }

  const colThresh = Math.max(8, Math.floor(h * 0.35));
  const rowThresh = Math.max(8, Math.floor(w * 0.35));
  let left = -1;
  let right = -1;
  let top = -1;
  let bottom = -1;
  for (let x = 0; x < w; x++) {
    if (colCounts[x] >= colThresh) {
      left = x;
      break;
    }
  }
  for (let x = w - 1; x >= 0; x--) {
    if (colCounts[x] >= colThresh) {
      right = x;
      break;
    }
  }
  for (let y = 0; y < h; y++) {
    if (rowCounts[y] >= rowThresh) {
      top = y;
      break;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    if (rowCounts[y] >= rowThresh) {
      bottom = y;
      break;
    }
  }
  if (left < 0 || right < 0 || top < 0 || bottom < 0) return null;
  if ((right - left) < 64 || (bottom - top) < 64) return null;

  return {
    x: x0 + left + 1,
    y: y0 + top + 1,
    w: Math.max(1, right - left - 1),
    h: Math.max(1, bottom - top - 1),
    source: 'detectedWhiteBorder',
  };
}

function clampRectToRt(rt, rect) {
  const rw = Math.max(1, rt?.width | 0);
  const rh = Math.max(1, rt?.height | 0);
  const x = Math.max(0, Math.min(rw - 1, Math.floor(rect.x)));
  const y = Math.max(0, Math.min(rh - 1, Math.floor(rect.y)));
  const maxW = Math.max(1, rw - x);
  const maxH = Math.max(1, rh - y);
  const w = Math.max(1, Math.min(maxW, Math.floor(rect.w)));
  const h = Math.max(1, Math.min(maxH, Math.floor(rect.h)));
  return { x, y, w, h, source: rect.source ?? 'unknown' };
}

function sampleAnchorColor(renderer, rt, rect, patch) {
  const r = patch?.rectNorm;
  if (!r) return null;
  const u = r.x + r.w * 0.5;
  const v = r.y + r.h * 0.5;
  const { px, pyGl } = mapUvToRectPixel(rt, rect, u, v);
  const p = readRtPixelSrgb(renderer, rt, px, pyGl);
  return p?.srgb ?? null;
}

/** Mean bus Δ on red/green/blue anchors — lower is better mapping. */
function scorePrimaryBusAnchors(renderer, rt, rect, specPatches) {
  const anchorIds = ['red', 'green', 'blue'];
  const deltas = [];
  for (const id of anchorIds) {
    const patch = specPatches.find((p) => p.id === id);
    if (!patch) continue;
    const measured = sampleAnchorColor(renderer, rt, rect, patch);
    if (!measured) continue;
    deltas.push(deltaRgbLen(deltaRgb(patch.srgb, measured)));
  }
  if (!deltas.length) return Number.POSITIVE_INFINITY;
  return mean(deltas);
}

function evalRectFit(renderer, rt, rect, specPatches) {
  const anchorIds = ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'neutral_0', 'neutral_255'];
  const anchors = anchorIds
    .map((id) => specPatches.find((p) => p.id === id))
    .filter(Boolean);
  if (!anchors.length) return { score: Number.POSITIVE_INFINITY, uniqueCount: 0, meanDelta: Number.POSITIVE_INFINITY };

  const deltas = [];
  const quant = [];
  for (const p of anchors) {
    const measured = sampleAnchorColor(renderer, rt, rect, p);
    if (!measured) continue;
    const d = deltaRgbLen(deltaRgb(p.srgb, measured));
    deltas.push(d);
    quant.push(
      `${Math.floor(measured[0] / 16)},${Math.floor(measured[1] / 16)},${Math.floor(measured[2] / 16)}`,
    );
  }
  if (!deltas.length) return { score: Number.POSITIVE_INFINITY, uniqueCount: 0, meanDelta: Number.POSITIVE_INFINITY };
  const meanDelta = mean(deltas);
  const uniqueCount = new Set(quant).size;
  const score = meanDelta + Math.max(0, 8 - uniqueCount) * 35;
  return { score, uniqueCount, meanDelta };
}

function decodeMarkerCode(rgb) {
  if (!Array.isArray(rgb)) return 0;
  const bit0 = rgb[0] >= 140 ? 1 : 0;
  const bit1 = rgb[1] >= 140 ? 1 : 0;
  const bit2 = rgb[2] >= 140 ? 1 : 0;
  return bit0 | (bit1 << 1) | (bit2 << 2);
}

function sampleCellMarker(renderer, rt, chartRect, cell) {
  const rr = cell?.rectNorm;
  const sp = cell?.sampleNorm;
  if (!rr || !sp) return null;
  const at = (pt) => sampleRtNorm(
    renderer,
    rt,
    rr.x + rr.w * pt.u,
    rr.y + rr.h * pt.v,
    chartRect,
  )?.srgb ?? null;
  const center = at(sp.center);
  const tl = at(sp.tl);
  const tr = at(sp.tr);
  const bl = at(sp.bl);
  const br = at(sp.br);
  if (!center || !tl || !tr || !bl || !br) return null;
  return { center, tl, tr, bl, br };
}

/** Center-only fit (one GPU read per sampled cell) — used during alignment search. */
function evalRectFitV2Coarse(renderer, rt, rect, spec, sampleStride = null) {
  const cells = Array.isArray(spec?.cells) ? spec.cells : [];
  if (!cells.length) {
    return { score: Number.POSITIVE_INFINITY, uniqueCount: 0, meanDelta: Number.POSITIVE_INFINITY, markerHitRate: 0 };
  }
  const stride = sampleStride ?? Math.max(1, Math.floor(cells.length / 14));
  const deltas = [];
  const quant = [];
  for (let i = 0; i < cells.length; i += stride) {
    const cell = cells[i];
    const rr = cell?.rectNorm;
    const sp = cell?.sampleNorm?.center;
    if (!rr || !sp) continue;
    const measured = sampleRtNorm(
      renderer,
      rt,
      rr.x + rr.w * sp.u,
      rr.y + rr.h * sp.v,
      rect,
    )?.srgb;
    if (!measured) continue;
    deltas.push(deltaRgbLen(deltaRgb(cell.srgb, measured)));
    quant.push(
      `${Math.floor(measured[0] / 16)},${Math.floor(measured[1] / 16)},${Math.floor(measured[2] / 16)}`,
    );
  }
  if (!deltas.length) {
    return { score: Number.POSITIVE_INFINITY, uniqueCount: 0, meanDelta: Number.POSITIVE_INFINITY, markerHitRate: 0 };
  }
  const meanDelta = mean(deltas);
  const uniqueCount = new Set(quant).size;
  const score = meanDelta + Math.max(0, 8 - uniqueCount) * 18;
  return { score, uniqueCount, meanDelta, markerHitRate: 0 };
}

/** Marker-corner verification — run once on the winning rect only. */
function evalRectFitV2Markers(renderer, rt, rect, spec) {
  const cells = Array.isArray(spec?.cells) ? spec.cells : [];
  if (!cells.length) return { markerHitRate: 0 };
  const stride = Math.max(1, Math.floor(cells.length / 28));
  let markerHits = 0;
  let markerTotal = 0;
  for (let i = 0; i < cells.length; i += stride) {
    const cell = cells[i];
    const m = sampleCellMarker(renderer, rt, rect, cell);
    if (!m) continue;
    markerTotal += 4;
    if (decodeMarkerCode(m.tl) === (cell.marker.rowCode & 0x7)) markerHits += 1;
    if (decodeMarkerCode(m.tr) === (cell.marker.colCode & 0x7)) markerHits += 1;
    if (decodeMarkerCode(m.bl) === ((cell.marker.rowCode ^ cell.marker.colCode) & 0x7)) markerHits += 1;
    if (decodeMarkerCode(m.br) === ((cell.marker.rowCode + cell.marker.colCode) & 0x7)) markerHits += 1;
  }
  return { markerHitRate: markerTotal > 0 ? markerHits / markerTotal : 0 };
}

async function solveAlignedChartRectV2(renderer, rt, baseRect, spec) {
  if (!renderer || !rt || !baseRect) return null;
  const cx = baseRect.x + baseRect.w * 0.5;
  const cy = baseRect.y + baseRect.h * 0.5;

  const coarseScales = [0.92, 1.0, 1.08];
  const coarseOffsets = [-0.12, -0.06, 0, 0.06, 0.12];
  let best = null;
  let iter = 0;

  for (const scale of coarseScales) {
    const sw = baseRect.w * scale;
    const sh = baseRect.h * scale;
    for (const dx of coarseOffsets) {
      for (const dy of coarseOffsets) {
        iter += 1;
        if (iter % 20 === 0) await yieldToMain();
        const rect = clampRectToRt(rt, {
          x: cx - sw * 0.5 + dx * baseRect.w,
          y: cy - sh * 0.5 + dy * baseRect.h,
          w: sw,
          h: sh,
          source: baseRect.source,
        });
        const fit = evalRectFitV2Coarse(renderer, rt, rect, spec);
        if (!best || fit.score < best.score) {
          best = { rect, ...fit, _scale: scale, _dx: dx, _dy: dy };
        }
      }
    }
  }

  if (!best) return null;

  const refineScales = [best._scale - 0.04, best._scale, best._scale + 0.04].filter((s) => s > 0.5 && s < 1.5);
  const refineOffsets = [-0.03, 0, 0.03];
  for (const scale of refineScales) {
    const sw = baseRect.w * scale;
    const sh = baseRect.h * scale;
    for (const dx of refineOffsets) {
      for (const dy of refineOffsets) {
        iter += 1;
        if (iter % 12 === 0) await yieldToMain();
        const rect = clampRectToRt(rt, {
          x: cx - sw * 0.5 + (best._dx + dx) * baseRect.w,
          y: cy - sh * 0.5 + (best._dy + dy) * baseRect.h,
          w: sw,
          h: sh,
          source: baseRect.source,
        });
        const fit = evalRectFitV2Coarse(renderer, rt, rect, spec, 2);
        if (fit.score < best.score) {
          best = { rect, ...fit, _scale: scale, _dx: best._dx + dx, _dy: best._dy + dy };
        }
      }
    }
  }

  const markers = evalRectFitV2Markers(renderer, rt, best.rect, spec);
  const { _scale, _dx, _dy, ...rest } = best;
  return { ...rest, markerHitRate: markers.markerHitRate };
}

async function solveAlignedChartRectAsync(renderer, rt, baseRect, specPatches) {
  if (!renderer || !rt || !baseRect) return null;
  const dxs = [-0.12, -0.06, 0, 0.06, 0.12];
  const dys = [-0.12, -0.06, 0, 0.06, 0.12];
  const scales = [0.9, 1.0, 1.1];
  const cx = baseRect.x + baseRect.w * 0.5;
  const cy = baseRect.y + baseRect.h * 0.5;

  let best = null;
  let iter = 0;
  for (const sx of scales) {
    for (const sy of scales) {
      const sw = baseRect.w * sx;
      const sh = baseRect.h * sy;
      for (const dx of dxs) {
        for (const dy of dys) {
          iter += 1;
          if (iter % 25 === 0) await yieldToMain();
          const rect = clampRectToRt(rt, {
            x: cx - sw * 0.5 + dx * baseRect.w,
            y: cy - sh * 0.5 + dy * baseRect.h,
            w: sw,
            h: sh,
            source: baseRect.source,
          });
          const fit = evalRectFit(renderer, rt, rect, specPatches);
          if (!best || fit.score < best.score) best = { rect, ...fit };
        }
      }
    }
  }
  return best;
}

/**
 * @param {string[]} taps
 * @returns {Record<string, import('three').WebGLRenderTarget|null>}
 */
function resolveTapRts(taps) {
  const ms = globalThis.MapShine ?? {};
  const diag = ms.__v2PerLevelDiag ?? null;
  const fc = ms.floorCompositorV2 ?? ms.effectComposer?._floorCompositorV2 ?? null;
  const levelIdx = 0;
  const out = {};

  for (const tap of taps) {
    switch (tap) {
      case 'busAlbedo':
        out.busAlbedo = diag?.levelSceneRTs?.[levelIdx] ?? null;
        break;
      case 'lit':
        out.lit = diag?.levelLitRTs?.[levelIdx] ?? null;
        break;
      case 'preGrade':
        out.preGrade = diag?.hdrScenePreGradeRT ?? fc?._hdrScenePreGradeRT ?? null;
        break;
      case 'final':
        out.final = diag?.mergedFinalRT ?? fc?._postA ?? diag?.levelFinalRTs?.[levelIdx] ?? null;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * @param {object} report
 * @returns {Record<string, number|null>}
 */
function buildTapMeanDeltas(report) {
  const taps = report.meta?.taps ?? [];
  const out = {};
  for (const tap of taps) {
    out[tap] = mean(
      report.patches.map((p) => p.taps?.[tap]?.deltaLen).filter((n) => Number.isFinite(n)),
    );
  }
  return out;
}

/**
 * Per-patch lift from bus → final (how much the grade stack moves each swatch).
 *
 * @param {object} report
 * @returns {object|null}
 */
function buildPipelineDrift(report) {
  const tapMeans = buildTapMeanDeltas(report);
  const busMean = tapMeans.busAlbedo;
  const finalMean = tapMeans.final;
  const litMean = tapMeans.lit;
  const preMean = tapMeans.preGrade;

  const lifts = report.patches
    .map((p) => {
      const bus = p.taps?.busAlbedo?.deltaLen;
      const fin = p.taps?.final?.deltaLen;
      if (!Number.isFinite(bus) || !Number.isFinite(fin)) return null;
      return { id: p.id, lift: fin - bus };
    })
    .filter(Boolean);

  const maxLift = lifts.length
    ? lifts.reduce((best, cur) => (cur.lift > best.lift ? cur : best), lifts[0])
    : null;

  const clipped = report.patches.filter((p) => {
    const fin = p.taps?.final?.srgb;
    const exp = p.expectedSrgb;
    if (!fin || !exp) return false;
    const maxOut = Math.max(fin[0], fin[1], fin[2]);
    const maxExp = Math.max(exp[0], exp[1], exp[2]);
    return maxOut >= 248 && maxExp <= 235;
  });

  return {
    tapMeanDelta: tapMeans,
    busToLit: Number.isFinite(busMean) && Number.isFinite(litMean) ? litMean - busMean : null,
    busToFinal: Number.isFinite(busMean) && Number.isFinite(finalMean) ? finalMean - busMean : null,
    litToPreGrade: Number.isFinite(litMean) && Number.isFinite(preMean) ? preMean - litMean : null,
    preGradeToFinal: Number.isFinite(preMean) && Number.isFinite(finalMean) ? finalMean - preMean : null,
    maxFinalLiftPatch: maxLift,
    finalClippedPrimaries: clipped.map((p) => p.id),
  };
}

/**
 * @param {object} report
 * @returns {string[]}
 */
function buildNudges(report) {
  const nudges = [];
  if (report.meta?.readbackWarning) {
    nudges.push(report.meta.readbackWarning);
    return nudges;
  }

  const drift = report.pipelineDrift ?? buildPipelineDrift(report);
  const bus = (id) => report.patches.find((p) => p.id === id)?.taps?.busAlbedo;
  const fin = (id) => report.patches.find((p) => p.id === id)?.taps?.final;
  const neutralId = report.patches.some((p) => p.id === 'neutral_128') ? 'neutral_128' : 'neutral_26';

  if (Number.isFinite(drift.busToFinal) && drift.busToFinal > 25) {
    nudges.push(
      `Grade stack adds ~${drift.busToFinal.toFixed(0)} mean Δ vs chart on final (bus was ~${(drift.tapMeanDelta.busAlbedo ?? 0).toFixed(0)}). Review saturation/exposure/golden-hour boosts if primaries clip.`,
    );
  }

  if (drift.finalClippedPrimaries?.length) {
    nudges.push(
      `Final output clips on: ${drift.finalClippedPrimaries.join(', ')} — soften grade extremes (masterGamma, saturation, goldenStrength) while keeping mood.`,
    );
  }

  if (drift.maxFinalLiftPatch && drift.maxFinalLiftPatch.lift > 40) {
    nudges.push(
      `Largest bus→final shift on "${drift.maxFinalLiftPatch.id}" (+${drift.maxFinalLiftPatch.lift.toFixed(0)} Δ). Tune grade for that hue family first.`,
    );
  }

  const midBus = bus(neutralId);
  const midFin = fin(neutralId);
  if (midBus?.deltaLen > 8) {
    const d = midBus.delta;
    if (d[0] > 4 && d[1] > 4 && d[2] > 4) {
      nudges.push('Mid grey bright on bus — lighting/ambient or exposure may be high before grade.');
    } else if (d[0] < -4 && d[1] < -4 && d[2] < -4) {
      nudges.push('Mid grey dark on bus — raise ambient or reduce crushing (interiorDarkness, fog).');
    }
  }

  if (midFin && midBus && midFin.deltaLen > midBus.deltaLen + 15) {
    nudges.push('Neutral grey shifts more in final than bus — grade (temperature, saturation, masterGamma) is the main lever.');
  }

  const preset = report.meta?.activePresetId;
  if (preset) {
    nudges.push(`Measured under preset "${preset}" — deltas describe your current artistic stack, not a 1:1 chart match.`);
  } else {
    nudges.push('No active preset flag on scene — report reflects saved scene/world settings as loaded.');
  }

  if (!nudges.length) {
    nudges.push('Pipeline deltas recorded — compare tap means in aggregates.pipelineDrift to rebalance without chasing 1:1 chart match.');
  }
  return nudges;
}

/**
 * Wait for canvas redraw + a few frames so RTs match applied settings.
 *
 * @param {object} [options]
 * @param {number} [options.minMs]
 * @param {number} [options.frames]
 */
export async function waitForCalibrationReady(options = {}) {
  const minMs = Number.isFinite(options.minMs) ? options.minMs : 500;
  const frames = Number.isFinite(options.frames) ? options.frames : 3;
  const ms = globalThis.MapShine ?? {};
  try {
    ms.renderLoop?.requestContinuousRender?.(minMs + 300);
  } catch (_) {}
  await yieldToMain();
  for (let i = 0; i < frames; i++) {
    await new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(resolve);
      else setTimeout(resolve, 16);
    });
  }
  await new Promise((resolve) => setTimeout(resolve, minMs));
}

/**
 * One-button workflow: optional preset → wait for stable RTs → scan → export.
 *
 * @param {object} [options]
 * @param {'v1'|'v2'} [options.mode]
 * @param {boolean} [options.applyNeutralPreset] Apply calibration-neutral first (causes scene redraw)
 * @param {boolean} [options.download]
 * @param {'json'|'md'|'both'} [options.downloadFormat]
 * @param {string[]} [options.taps]
 * @param {number} [options.waitAfterApplyMs]
 * @returns {Promise<object>}
 */
export async function runCalibrationWorkflow(options = {}) {
  const mode = options.mode === 'v2' ? 'v2' : 'v1';
  const applyNeutralPreset = options.applyNeutralPreset === true;
  const download = options.download !== false;
  const scene = globalThis.game?.scenes?.viewed ?? globalThis.canvas?.scene ?? null;
  if (!scene) throw new Error('No viewed scene for calibration workflow');

  let presetApplied = null;
  if (applyNeutralPreset) {
    const presets = await loadBuiltInPresets({ force: true });
    const preset = presets.find((p) => p.id === 'calibration-neutral');
    if (!preset) throw new Error('calibration-neutral preset not found');
    const ok = await applyPresetToScene(scene, preset);
    if (!ok) throw new Error('Failed to apply calibration-neutral preset');
    presetApplied = 'calibration-neutral';
    await waitForCalibrationReady({
      minMs: Number.isFinite(options.waitAfterApplyMs) ? options.waitAfterApplyMs : 1400,
    });
  } else {
    await waitForCalibrationReady({ minMs: 450 });
  }

  const report = await runColorCalibration({
    mode,
    taps: options.taps,
    download,
    downloadFormat: options.downloadFormat ?? 'both',
    tryBorderDetect: options.tryBorderDetect,
  });

  report.meta.workflow = {
    applyNeutralPreset,
    presetApplied,
    verifiedActivePresetId: getActivePresetId(scene),
  };

  return report;
}

/**
 * @param {object} report
 * @returns {string}
 */
export function formatCalibrationMarkdown(report) {
  const lines = [];
  lines.push('# Map Shine Color Calibration Report', '');
  lines.push(`Generated: ${report.meta.generatedAt}`);
  lines.push(`Scene: ${report.meta.sceneName ?? '—'}`);
  lines.push(`Preset: ${report.meta.activePresetId ?? '—'}`);
  lines.push(`Taps: ${report.meta.taps.join(', ')}`, '');

  lines.push('## Suggested nudges', '');
  for (const n of report.nudges) lines.push(`- ${n}`);
  lines.push('');

  const greyPatches = report.patches.filter((p) => p.group?.includes('grey'));
  if (greyPatches.length) {
    lines.push('## Neutral / warm / cool greys (busAlbedo)', '');
    lines.push('| Patch | Expected | Measured | Δ |');
    lines.push('|-------|----------|----------|---|');
    for (const p of greyPatches) {
      const m = p.taps?.busAlbedo;
      if (!m) continue;
      lines.push(
        `| ${p.id} | ${p.expectedSrgb.join(',')} | ${m.srgb.join(',')} | ${m.delta.join(',')} (${m.deltaLen.toFixed(1)}) |`,
      );
    }
    lines.push('');
  }

  lines.push('## Worst patches (busAlbedo Δ)', '');
  const worst = [...report.patches]
    .filter((p) => p.taps?.busAlbedo)
    .sort((a, b) => b.taps.busAlbedo.deltaLen - a.taps.busAlbedo.deltaLen)
    .slice(0, 12);
  for (const p of worst) {
    const t = p.taps.busAlbedo;
    lines.push(`- \`${p.id}\`: expected [${p.expectedSrgb}] → [${t.srgb}] Δlen=${t.deltaLen.toFixed(1)}`);
  }
  lines.push('');

  lines.push('## Grade chain (50% grey patch)', '');
  const g = report.patches.find((p) => p.id === 'neutral_128');
  if (g) {
    for (const tap of report.meta.taps) {
      const t = g.taps?.[tap];
      if (t) lines.push(`- **${tap}**: [${t.srgb}] Δlen=${t.deltaLen.toFixed(1)}`);
    }
  }

  if (report.pipelineDrift) {
    const d = report.pipelineDrift;
    lines.push('', '## Pipeline drift (vs chart, current look)', '');
    for (const [tap, val] of Object.entries(d.tapMeanDelta ?? {})) {
      if (Number.isFinite(val)) lines.push(`- **${tap}** mean Δ: ${val.toFixed(1)}`);
    }
    if (Number.isFinite(d.busToFinal)) {
      lines.push(`- **bus → final** mean lift: +${d.busToFinal.toFixed(1)}`);
    }
    if (d.finalClippedPrimaries?.length) {
      lines.push(`- **clipped on final**: ${d.finalClippedPrimaries.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * @param {object} report
 * @param {'json'|'md'} format
 * @param {string} [basename]
 */
export function downloadCalibrationReport(report, format = 'json', basename = 'msa-calibration-report') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `${basename}-${stamp}.${format === 'md' ? 'md' : 'json'}`;
  const text = format === 'md' ? formatCalibrationMarkdown(report) : JSON.stringify(report, null, 2);
  const blob = new Blob([text], { type: format === 'md' ? 'text/markdown' : 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
}

/**
 * @param {object} [options]
 * @param {string[]} [options.taps]
 * @param {boolean} [options.download]
 * @param {'json'|'md'|'both'} [options.downloadFormat]
 * @returns {Promise<object>}
 */
export async function runColorCalibration(options = {}) {
  const ms = globalThis.MapShine ?? {};
  const renderer = ms.renderer ?? null;
  if (!renderer) throw new Error('Map Shine renderer not ready');

  const taps = options.taps?.length ? options.taps : DEFAULT_TAPS;
  const mode = options.mode === 'v2' ? 'v2' : 'v1';
  const tryBorderDetect = options.tryBorderDetect === true;

  try {
    ms.renderLoop?.requestContinuousRender?.(400);
  } catch (_) {}

  const spec = await loadChartSpecCached({ ...options, mode });
  await yieldToMain();

  const tapRts = resolveTapRts(taps);
  const anchorRt = tapRts.busAlbedo ?? tapRts.final ?? null;
  if (!anchorRt) throw new Error('Calibration: no busAlbedo/final RT available — open a scene with Map Shine rendering');

  const sceneRectFoundry = resolveSceneRectInRtPixels(renderer, anchorRt, { preferFoundrySceneRect: true });
  const sceneRectScissor = resolveSceneRectInRtPixels(renderer, anchorRt, { preferFoundrySceneRect: false });

  /** v2 skips full-RT border readback (was freezing the tab on large scenes). */
  const candidateRects = mode === 'v2'
    ? [sceneRectFoundry, sceneRectScissor].filter(Boolean)
    : (() => {
      const list = [sceneRectFoundry, sceneRectScissor].filter(Boolean);
      if (tryBorderDetect) {
        list.push(
          detectChartRectFromWhiteBorder(renderer, anchorRt, sceneRectFoundry),
          detectChartRectFromWhiteBorder(renderer, anchorRt, sceneRectScissor),
        );
      }
      return list;
    })();

  const dedup = [];
  const seen = new Set();
  for (const c of candidateRects) {
    if (!c) continue;
    const clamped = clampRectToRt(anchorRt, c);
    const key = `${clamped.x}:${clamped.y}:${clamped.w}:${clamped.h}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(clamped);
  }

  const alignments = [];
  for (let i = 0; i < dedup.length; i++) {
    const c = dedup[i];
    const fit = mode === 'v2'
      ? await solveAlignedChartRectV2(renderer, anchorRt, c, spec)
      : await solveAlignedChartRectAsync(renderer, anchorRt, c, spec.patches ?? []);
    if (fit) alignments.push(fit);
    if (i < dedup.length - 1) await yieldToMain();
  }
  if (mode === 'v1' && alignments.length > 1) {
    const specPatches = spec.patches ?? [];
    for (const a of alignments) {
      a.primaryBusMean = scorePrimaryBusAnchors(renderer, anchorRt, a.rect, specPatches);
    }
    alignments.sort((a, b) => {
      const pb = (a.primaryBusMean ?? 999) - (b.primaryBusMean ?? 999);
      if (Math.abs(pb) > 3) return pb;
      return a.score - b.score;
    });
  } else {
    alignments.sort((a, b) => a.score - b.score);
  }
  const bestAlignment = alignments[0] ?? null;
  const chartRectPx = bestAlignment
    ? { ...bestAlignment.rect, source: `aligned(${bestAlignment.rect.source})` }
    : (sceneRectFoundry ?? sceneRectScissor);
  const sceneRectPx = sceneRectFoundry ?? sceneRectScissor ?? null;

  const scene = globalThis.canvas?.scene;
  const settings = scene ? sceneSettings.getSceneSettings(scene) : null;
  const activePresetId = getActivePresetId(scene) ?? scene?.getFlag?.('map-shine-advanced', ACTIVE_PRESET_FLAG_KEY) ?? null;
  const cc = settings?.mapMaker?.effects?.colorCorrection ?? null;
  const lighting = settings?.mapMaker?.effects?.lighting ?? null;

  let patches = [];
  if (mode === 'v2') {
    const byColor = new Map();
    const cells = spec.cells ?? [];
    let cellIdx = 0;
    for (const cell of cells) {
      cellIdx += 1;
      if (cellIdx % 24 === 0) await yieldToMain();
      if (!byColor.has(cell.colorId)) {
        byColor.set(cell.colorId, {
          id: cell.colorId,
          label: cell.colorId,
          group: 'tiled_primary',
          expectedSrgb: cell.srgb,
          _tapSamples: {},
          taps: {},
        });
      }
      const entry = byColor.get(cell.colorId);
      const sp = cell.sampleNorm?.center ?? { u: 0.5, v: 0.5 };
      for (const tap of taps) {
        const rt = tapRts[tap];
        if (!rt) continue;
        const s = sampleRtNorm(
          renderer,
          rt,
          cell.rectNorm.x + cell.rectNorm.w * sp.u,
          cell.rectNorm.y + cell.rectNorm.h * sp.v,
          chartRectPx,
        );
        if (!s) continue;
        entry._tapSamples[tap] ??= [];
        entry._tapSamples[tap].push(s.srgb);
      }
    }
    patches = [...byColor.values()].map((entry) => {
      for (const tap of taps) {
        const samples = entry._tapSamples[tap] ?? [];
        if (!samples.length) {
          entry.taps[tap] = null;
          continue;
        }
        const med = [0, 0, 0];
        for (const ch of [0, 1, 2]) {
          const vals = samples.map((s) => s[ch]).sort((a, b) => a - b);
          med[ch] = vals[Math.floor(vals.length / 2)];
        }
        const delta = deltaRgb(entry.expectedSrgb, med);
        entry.taps[tap] = {
          srgb: med,
          delta,
          deltaLen: deltaRgbLen(delta),
          sampleCount: samples.length,
        };
      }
      const bus = entry.taps.busAlbedo;
      if (bus) entry.deltaLen = bus.deltaLen;
      delete entry._tapSamples;
      return entry;
    });
  } else {
    const specPatches = spec.patches ?? [];
    for (let pi = 0; pi < specPatches.length; pi++) {
      if (pi % 8 === 0) await yieldToMain();
      const patch = specPatches[pi];
      const expectedSrgb = patch.srgb;
      const entry = {
        id: patch.id,
        label: patch.label,
        group: patch.group,
        expectedSrgb,
        taps: {},
      };
      for (const tap of taps) {
        const rt = tapRts[tap];
        if (!rt) {
          entry.taps[tap] = null;
          continue;
        }
        const measured = samplePatchMedian(renderer, rt, patch, chartRectPx);
        if (!measured) {
          entry.taps[tap] = null;
          continue;
        }
        const delta = deltaRgb(expectedSrgb, measured.srgb);
        entry.taps[tap] = {
          srgb: measured.srgb,
          delta,
          deltaLen: deltaRgbLen(delta),
          sampleCount: measured.sampleCount,
        };
      }
      const bus = entry.taps.busAlbedo;
      if (bus) entry.deltaLen = bus.deltaLen;
      patches.push(entry);
    }
  }

  try {
    ms.renderLoop?.clearContinuousRender?.();
  } catch (_) {}

  const busRts = Object.values(tapRts).filter(Boolean);
  const rtTypes = [...new Set(busRts.map((rt) => (isHalfFloatRt(rt) ? 'HalfFloat' : 'UnsignedByte')))];
  const blackPatches = patches.filter((p) => {
    const s = p.taps?.busAlbedo?.srgb;
    return s && s[0] === 0 && s[1] === 0 && s[2] === 0 && p.id !== 'neutral_0';
  });
  const keyPatchIds = mode === 'v2'
    ? ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'neutral_26', 'neutral_230']
    : ['red', 'green', 'blue', 'cyan', 'magenta', 'yellow', 'neutral_0', 'neutral_255'];
  const keyPatchBus = keyPatchIds
    .map((id) => patches.find((p) => p.id === id)?.taps?.busAlbedo)
    .filter(Boolean);
  const keyPatchColors = keyPatchBus.map((t) => t.srgb.join(','));
  const uniqueKeyColorCount = new Set(keyPatchColors).size;
  const primaryIds = ['red', 'green', 'blue'];
  const primaryBusColors = primaryIds
    .map((id) => patches.find((p) => p.id === id)?.taps?.busAlbedo?.srgb)
    .filter(Array.isArray);
  const uniquePrimaryBus = new Set(primaryBusColors.map((rgb) => rgb.join(','))).size;
  const busMeanForPreflight = mean(
    patches.map((p) => p.taps?.busAlbedo?.deltaLen).filter((n) => Number.isFinite(n)),
  );
  const mappingLikelyFailed = primaryBusColors.length >= 3
    && (uniquePrimaryBus < 3 || (Number.isFinite(busMeanForPreflight) && busMeanForPreflight > 35));
  const spatialSamplingWarning = mappingLikelyFailed
    ? `Sampler preflight: bus primaries look collapsed or mis-mapped (unique=${uniquePrimaryBus}, mean Δ≈${busMeanForPreflight?.toFixed?.(0) ?? '?'}). Do not use this report for tuning.`
    : null;

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      chartSpecVersion: spec.version,
      mode,
      sceneName: scene?.name ?? null,
      sceneId: scene?.id ?? null,
      activePresetId: activePresetId ?? null,
      taps,
      chartSpecUrl: getChartSpecUrl(mode),
      rtTypes,
      sceneRectPx: sceneRectPx ?? null,
      chartRectPx: chartRectPx ?? null,
      alignment: bestAlignment
        ? {
            score: bestAlignment.score,
            meanDelta: bestAlignment.meanDelta,
            uniqueCount: bestAlignment.uniqueCount,
            markerHitRate: bestAlignment.markerHitRate ?? null,
            primaryBusMean: bestAlignment.primaryBusMean ?? null,
          }
        : null,
      keyPatchUniqueColorCount: uniqueKeyColorCount,
      readbackWarning:
        blackPatches.length > patches.length * 0.5
          ? 'Sampler preflight: most patches read [0,0,0]. If you see the chart on screen, reload the module and re-scan (HalfFloat readback fix). Do not tune grade from this report.'
          : spatialSamplingWarning,
    },
    snapshot: {
      colorCorrection: cc ? { ...cc } : null,
      lighting: lighting ? { ...lighting } : null,
    },
    aggregates: {
      busAlbedoMeanDelta: mean(
        patches.map((p) => p.taps?.busAlbedo?.deltaLen).filter((n) => Number.isFinite(n)),
      ),
      finalMeanDelta: mean(
        patches.map((p) => p.taps?.final?.deltaLen).filter((n) => Number.isFinite(n)),
      ),
      tapMeanDelta: buildTapMeanDeltas({ meta: { taps }, patches }),
    },
    patches,
    nudges: [],
    pipelineDrift: null,
  };

  report.pipelineDrift = buildPipelineDrift(report);
  report.nudges = buildNudges(report);

  ms.__lastCalibrationReport = report;

  if (options.download) {
    const fmt = options.downloadFormat ?? 'json';
    if (fmt === 'both' || fmt === 'json') downloadCalibrationReport(report, 'json');
    if (fmt === 'both' || fmt === 'md') downloadCalibrationReport(report, 'md');
  }

  try {
    console.log('[ColorCalibration]', report);
  } catch (_) {}

  return report;
}

/**
 * @param {number[]} vals
 */
function mean(vals) {
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

export function getChartSpecPathHint(mode = 'v1') {
  return getChartSpecUrl(mode);
}
