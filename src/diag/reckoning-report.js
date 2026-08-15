/**
 * THE RECKONING REPORT — ⚖️ TEMPORARY instrument for `docs/holy/V4-Reckoning.md`.
 *
 * One button, one paste: everything the Reckoning campaign needs to convict the
 * upper-floor cost mystery, aggregated from instruments that already exist and
 * shaped so the FIRST lines are verdicts a human can read without decoding JSON.
 * Registered by boot.js as the debug-panel action `reckoning-report`; the panel's
 * own machinery copies the result to the clipboard (that is the panel's design —
 * see debug-panel.js's header), so this module never touches the DOM.
 *
 * Why it exists (author measurement, 2026-08-15): with EVERY effect disabled the
 * ground floor runs ~120 fps and the upper floor ~20 fps — so the floor-scaled
 * cost lives in code no effect toggle reaches (the depth-authority pass, the
 * early-Z prepass, the world draw, the per-frame CPU body). This report captures
 * the observables that separate the candidate mechanisms (Reckoning SEEDED LEADS
 * SL-1..SL-15), most importantly:
 *   - is the S1a per-cell split ENGAGED on this machine right now, or starved
 *     (`noMinGrid` — a stale pre-v10 compression cache re-creates Bug #20's 10×
 *     depth cost with the fix present in the code);
 *   - a ~2.5 s armed profiler window of per-zone CPU/GPU cost on THIS floor;
 *   - the floor composition (visible floors, item counts, split-material counts).
 *
 * TEMPORARY: delete this module + its boot registration when the Reckoning's R4
 * gates close (the campaign doc is the authority). Its pure logic is Node-tested
 * (`__tests__/reckoning-report.test.mjs`) because the verdict thresholds are the
 * part that must not lie; the live gather in boot.js is per-section fail-soft.
 *
 * @module diag/reckoning-report
 */

/** Bumped when the report's shape changes, so a pasted dump names its own era. */
export const RECKONING_REPORT_VERSION = 1;

/** Round to 4 decimal places — zone ms at 120fps needs the tail digits. */
function r4(x) {
  return Math.round(x * 10000) / 10000;
}

/**
 * Flatten a frame-profiler snapshot's `zoneStats` into paste-friendly rows,
 * per-frame normalized, sorted by GPU cost then CPU cost (GPU-ms is the
 * project's currency; fps is directional only).
 *
 * @param {Array<object>|null|undefined} zoneStats - `profiler.snapshot().zoneStats`.
 * @param {number} frames - the window's frame count (denominator; ≤0 → rows null).
 * @returns {Array<object>} sorted rows; empty array on unusable input.
 */
export function summarizeZoneRows(zoneStats, frames) {
  if (!Array.isArray(zoneStats) || !(frames > 0)) return [];
  const rows = [];
  for (const z of zoneStats) {
    if (!z || typeof z.id !== 'string') continue;
    const cpu = z.cpu ?? null;
    const gpu = z.gpu ?? null;
    rows.push({
      id: z.id,
      cpuMsPerFrame: cpu ? r4(cpu.sumMs / frames) : null,
      cpuMaxMs: cpu ? r4(cpu.maxMs) : null,
      // Occurrence count over the window — an absent/low count IS a measurement
      // (it names which branch ran), never "no data".
      count: cpu?.count ?? gpu?.count ?? 0,
      gpuMsPerFrame: gpu ? r4(gpu.sumMs / frames) : null,
      gpuMaxMs: gpu ? r4(gpu.maxMs) : null,
      drawCallsPerFrame: z.drawCalls ? r4(z.drawCalls.sum / frames) : null,
      trianglesPerFrame: z.triangles ? Math.round(z.triangles.sum / frames) : null,
      ...(z.unbalanced > 0 ? { unbalanced: z.unbalanced } : {}),
    });
  }
  rows.sort(
    (a, b) => (b.gpuMsPerFrame ?? 0) - (a.gpuMsPerFrame ?? 0) || (b.cpuMsPerFrame ?? 0) - (a.cpuMsPerFrame ?? 0)
  );
  return rows;
}

/**
 * The report's brain: turn the gathered sections into ranked human verdicts.
 * Every rule is null-tolerant — a missing section yields at most an ℹ️ note,
 * never a throw (the button must produce SOMETHING useful on a half-broken
 * session; that is the point of pressing it).
 *
 * Severity: 🔴 = a mechanism that can carry the upper-floor multiplier by
 * itself · 🟠 = the numbers in this dump need a caveat · 🟡 = known secondary
 * suspect present · ℹ️ = context.
 *
 * @param {object} sections - `{identity, floors, census, earlyZ, effects, suspects, zones, errors}`.
 * @returns {string[]}
 */
export function computeReckoningVerdicts(sections = {}) {
  const { census = null, earlyZ = null, zones = null, suspects = null, errors = [] } = sections;
  const out = [];
  const floorIndex = census?.view?.floorIndex ?? sections.floors?.viewed ?? null;

  if (!census && !earlyZ) {
    out.push('🔴 Viewer sections missing entirely — is the MSA viewer running on this scene?');
  }

  if (earlyZ && earlyZ.earlyZComposition === false) {
    out.push(
      '🔴 earlyZComposition is OFF — every tile is painter-blended with the discard-based reject; ' +
        'the whole S1/S1a machinery is bypassed. Turn it on before reading any other number.'
    );
  }

  // THE STARVATION TEST (Reckoning SL-1 / Bug-Tracker #20): the S1a split needs
  // the per-texel min-alpha grid. NOTE (survey 2026-08-15): a stale-VERSION
  // cache serving grid-less records is structurally IMPOSSIBLE — the version is
  // part of the cache KEY (`bc:v10:${src}`, bc-compress.worker.js), so an old
  // record is unaddressable and a miss always recompresses WITH the grid. If
  // this fires, the grid genuinely never reached the tile at mesh time — the
  // arrival/re-mesh chain (the Bug #20 timing-bug class) broke again, or the
  // item never went through compression at all (see the raw-fallback verdict).
  const starvedTiles = Math.max(earlyZ?.s1aBlockedNoMinGrid ?? 0, earlyZ?.splitDeclinedBy?.noMinGrid ?? 0);
  if (starvedTiles > 0) {
    out.push(
      `🔴 SPLIT STARVED: ${starvedTiles} alpha-refused tile(s) have NO min-alpha grid at mesh time — the ` +
        'grid-arrival/re-mesh chain broke (NOT a stale version cache; that is key-versioned and impossible). ' +
        "Those tiles pay Bug #20's full discard cost in the depth pass + early-Z prepass."
    );
  }

  // THE RAW-FALLBACK TEST: a tile whose compression attempt failed (worker
  // blocked/CSP/error) has no alphaStats AT ALL — it can never take any early-Z
  // path and never even appears in splitDeclinedBy. Full blended+discard cost
  // in all three geometry passes, with a completely different root cause.
  const rawTiles = earlyZ?.refusedBy?.noAlphaStats ?? 0;
  if (rawTiles > 0) {
    out.push(
      `🔴 RAW-DECODE FALLBACK: ${rawTiles} tile(s) have no alphaStats — the compression worker never produced ` +
        'a record for them (blocked/failed/fell back). Every such tile is full-footprint blended+discard in all ' +
        'three geometry passes. Check suspects.compressedWorker for failed/unavailable counts.'
    );
  }

  // THE SILENT-QUOTA TEST (survey 2026-08-15): cachePut swallows
  // QuotaExceededError silently (bc-compress.worker.js), so an over-quota origin
  // re-encodes every asset every session with no diagnostic — presents as "the
  // module got slow to load", plus background CPU while playing. Fresh encodes
  // with zero cache hits on a world this browser has loaded before is the
  // signature.
  const cw = suspects?.compressedWorker ?? null;
  if (cw && (cw.requests ?? 0) > 0 && (cw.cached ?? 0) === 0 && (cw.bc1 ?? 0) + (cw.bc7 ?? 0) > 0) {
    out.push(
      `🟠 Compression cache produced ZERO hits this session (${(cw.bc1 ?? 0) + (cw.bc7 ?? 0)} fresh encodes). ` +
        'Normal on a first-ever load of this world in this browser; on a RE-visited world it means cache writes are ' +
        'failing silently (quota) and every session re-encodes everything.'
    );
  }

  if (earlyZ?.tiles && floorIndex != null && floorIndex > 0) {
    const t = earlyZ.tiles;
    if ((t.split ?? 0) === 0 && (t.interior ?? 0) === 0 && (t.passthrough ?? 0) + (t.legacy ?? 0) > 0) {
      out.push(
        '🔴 NO tile on this upper floor takes ANY early-Z path (zero interior, zero split) — every layer is ' +
          'full-footprint blended+discard in all three geometry passes. This is the Bug #20 cost shape, live.'
      );
    }
    if ((t.legacy ?? 0) > 0 && earlyZ.earlyZComposition === true) {
      out.push(
        `🟠 ${t.legacy} tile(s) sit in 'legacy' state while the flag is ON — a state that should not exist; note it.`
      );
    }
  }

  // Depth-side engagement (commit 94362d5): a split COLOUR tile whose depth
  // proxy/prepass twin is still a single material means the depth-side half of
  // the fix is absent or disengaged — the two 9.5×/9.8× zones would stay hot.
  if (census && earlyZ && (earlyZ.tiles?.split ?? 0) > 0) {
    if ((census.depthProxySplitMaterials ?? 0) === 0) {
      out.push(
        '🔴 Colour tiles are split but ZERO depth proxies carry a material array — the depth-side S1a fix ' +
          '(94362d5) is not engaged. Either this build predates it or the proxy rebuild dropped the split.'
      );
    } else if ((census.prepassSplitMaterials ?? 0) === 0) {
      out.push('🟠 Depth proxies are split but the prepass twins are not — the two should always match (94362d5).');
    }
  }

  if (census?.canvasPx && census.canvasPx.w > 0 && census.canvasPx.w < 3000) {
    out.push(
      `🟠 Canvas is ${census.canvasPx.w}×${census.canvasPx.h} device px — NOT the reference 3840-wide setup. ` +
        'The known intermittent resolution mismatch may be active; do not compare these ms against reference captures.'
    );
  }

  if (zones) {
    if ((zones.frames ?? 0) < 30) {
      out.push(
        `🟠 Profiler window closed with only ${zones.frames ?? 0} frame(s) — treat zone numbers as directional. ` +
          'If an arm error is listed under errors, close the Live zone ranking panel (it owns the profiler) and re-run.'
      );
    }
    if (zones.gpuSupported === false) {
      out.push('🟠 GPU zone timing unavailable on this session — zone rows are CPU-only; GPU cost is unattributed.');
    }
  } else {
    out.push('🟠 No profiler window captured (see errors) — this dump has state but no fresh timings.');
  }

  if (suspects?.dofEnabled === true && floorIndex != null && floorIndex > 0) {
    out.push(
      '🟡 DoF is enabled on an upper floor — the upper-floor-only pass (SL-2) is in these numbers; toggle it for its share.'
    );
  }
  if ((census?.windowSurfacesAlive ?? 0) > 1) {
    out.push(
      `🟡 ${census.windowSurfacesAlive} window-light scenes alive — the per-visible-floor sync+render loop (SL-3).`
    );
  }
  if (census && (census.itemStatesSize ?? 0) > 1.5 * Math.max(1, census.drawListSize ?? 0)) {
    out.push(
      `🟡 itemStates holds ${census.itemStatesSize} items vs a draw list of ${census.drawListSize} — the never-reaped ` +
        'growth (SL-7): four per-frame CPU sweeps walk all of it.'
    );
  }

  if (Array.isArray(errors) && errors.length > 0) {
    out.push(`ℹ️ ${errors.length} section(s) failed to gather — see \`errors\`; the rest of the dump is still valid.`);
  }
  out.push('ℹ️ Capture this on BOTH floors (ground, then upper, same camera spot) and paste both dumps together.');
  return out;
}

/**
 * Assemble the final report object. Pure — boot injects the clock string and the
 * gathered sections; the debug panel JSON-stringifies whatever this returns.
 *
 * @param {{generatedAt: string, sections: object}} args
 * @returns {object}
 */
export function assembleReckoningReport({ generatedAt, sections = {} } = {}) {
  const { identity, floors, census, earlyZ, effects, suspects, zones, multiFloorRanked, errors = [] } = sections;
  return {
    report: 'reckoning-report',
    version: RECKONING_REPORT_VERSION,
    generatedAt: generatedAt ?? null,
    readMe:
      'THE RECKONING REPORT (temporary — docs/holy/V4-Reckoning.md). Verdicts first, raw sections after. ' +
      'Press on BOTH floors from the same camera position and paste both dumps.',
    verdicts: computeReckoningVerdicts({ identity, floors, census, earlyZ, effects, suspects, zones, errors }),
    identity: identity ?? null,
    floors: floors ?? null,
    census: census ?? null,
    earlyZ: earlyZ ?? null,
    effects: effects ?? null,
    suspects: suspects ?? null,
    zones: zones ?? null,
    multiFloorRanked: multiFloorRanked ?? null,
    errors,
  };
}
