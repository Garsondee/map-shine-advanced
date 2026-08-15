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

/**
 * Bumped when the report's shape changes, so a pasted dump names its own era.
 * v2 (2026-08-15, same day): added `attribution` — the first live pair showed
 * the zones explaining only ~17% of the upper-floor frame, which no field in v1
 * could say — plus `vram`, `wholeImage`, frame-gap percentiles, and the fixed
 * `floors` section (v1 called `.find` on the wrapper object, not its array).
 * v3 (2026-08-15, same day again): v2's own half-resolution A/B proved the
 * upper floor RESOLUTION-bound, which pointed at the one GPU consumer no MSA
 * zone can see — Foundry's own PIXI context, still re-rendering the whole map
 * into a canvas-sized cache texture every frame. Added the `foundryCanvas`
 * census + its verdict, and pixel-rate normalisation so two captures at
 * different canvas sizes can be compared at all.
 */
export const RECKONING_REPORT_VERSION = 3;

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

/** Percentile of an unsorted numeric array. null on empty — never lies as 0. */
export function percentileOf(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const s = samples.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return r4(s[i]);
}

/** Zone-id prefixes that are OUTER brackets — they never nest inside another zone. */
const OUTER_CPU_PREFIXES = ['pass.', 'tick.', 'sims.', 'residency.', 'depth.'];

/**
 * THE ATTRIBUTION MATH — the question that matters most and that the first
 * version of this report could not ask: **how much of the frame do the
 * instruments actually explain?**
 *
 * The 2026-08-15 live pair answered it brutally: on the upper floor the measured
 * GPU passes summed to ~11 ms of a ~61 ms frame. A cost with no zone is a cost
 * nobody can fix, and every ranked-zone table silently presents itself as if it
 * covered the frame. This makes the unexplained remainder a first-class number.
 *
 * Also flags the **refresh cap**: a floor sitting exactly on 8.33/16.67 ms with
 * a small GPU sum is vsync-limited, so its frame time is a CEILING on its real
 * speed — every ratio measured against it is a LOWER BOUND, not the true cost.
 *
 * @param {{frames?: number, durationMs?: number, rows?: Array<object>, gapSamples?: number[]|null}} zones
 * @param {{megapixels?: number|null}} [opts] - canvas size, for the pixel-rate
 *   fields. The 2026-08-15 half-resolution A/B is why these exist: comparing two
 *   captures at different canvas sizes is meaningless without normalising, and
 *   `msPerMegapixel` is what makes "is this resolution-bound?" answerable from
 *   two dumps instead of arguable.
 * @returns {object|null}
 */
export function summarizeAttribution(zones, opts = {}) {
  if (!zones || !(zones.frames > 0) || !(zones.durationMs > 0)) return null;
  const rows = Array.isArray(zones.rows) ? zones.rows : [];
  const frameMsAvg = zones.durationMs / zones.frames;

  let gpuSum = 0;
  let cpuOuterSum = 0;
  const gpuBlindZones = [];
  for (const r of rows) {
    if (Number.isFinite(r.gpuMsPerFrame)) gpuSum += r.gpuMsPerFrame;
    if (OUTER_CPU_PREFIXES.some((p) => r.id.startsWith(p)) && Number.isFinite(r.cpuMsPerFrame)) {
      cpuOuterSum += r.cpuMsPerFrame;
    }
    // A zone that ISSUES GPU WORK but reports no GPU number means its timestamp
    // never resolved — the ranked table under-reports it rather than saying so.
    // Matched by what the zone DOES (draw/blit/prepass), not by its prefix: a
    // `*Sync` zone legitimately has no GPU time and must not be flagged.
    // (First cut tested `id.includes('raw') === false` to exclude a case that
    // does not exist — and silently excluded every zone with "draw" in its name,
    // which is all of them. Caught by the test pinned to the real dump.)
    if (/draw|blit|prepass/i.test(r.id)) {
      if (!Number.isFinite(r.gpuMsPerFrame) && Number.isFinite(r.cpuMsPerFrame) && r.cpuMsPerFrame > 0) {
        gpuBlindZones.push(r.id);
      }
    }
  }
  gpuSum = r4(gpuSum);
  cpuOuterSum = r4(cpuOuterSum);
  // The frame is (roughly) max(CPU, GPU) plus whatever neither bracket saw.
  const explained = Math.max(gpuSum, cpuOuterSum);
  const unaccountedMs = r4(Math.max(0, frameMsAvg - explained));

  const fps = r4(1000 / frameMsAvg);
  // Refresh-cap detection: within 4% of a common panel rate AND the GPU sum is
  // well under the frame budget ⇒ we are waiting on the display, not the work.
  const capCandidate = [60, 90, 120, 144, 165, 240].find((hz) => Math.abs(fps - hz) / hz < 0.04);
  const refreshCapped = !!capCandidate && gpuSum < frameMsAvg * 0.6;

  const megapixels = Number.isFinite(opts?.megapixels) && opts.megapixels > 0 ? r4(opts.megapixels) : null;

  return {
    frames: zones.frames,
    frameMsAvg: r4(frameMsAvg),
    fps,
    megapixels,
    // Normalised cost — the ONLY honest way to compare captures taken at
    // different canvas sizes. If this holds roughly constant across a
    // resolution change, the frame is resolution-bound.
    frameMsPerMegapixel: megapixels ? r4(frameMsAvg / megapixels) : null,
    gpuZoneMsPerMegapixel: megapixels ? r4(gpuSum / megapixels) : null,
    gpuZoneSumMsPerFrame: gpuSum,
    cpuOuterZoneSumMsPerFrame: cpuOuterSum,
    unaccountedMsPerFrame: unaccountedMs,
    unaccountedPct: r4((unaccountedMs / frameMsAvg) * 100),
    explainedPct: r4((explained / frameMsAvg) * 100),
    refreshCapped,
    refreshCapHz: refreshCapped ? capCandidate : null,
    gpuBlindZones,
    frameGapMs: Array.isArray(zones.gapSamples)
      ? {
          p50: percentileOf(zones.gapSamples, 0.5),
          p95: percentileOf(zones.gapSamples, 0.95),
          max: percentileOf(zones.gapSamples, 1),
          count: zones.gapSamples.length,
        }
      : null,
    note:
      'gpuZoneSum is the sum of per-pass GPU timestamps (nested brackets may overlap slightly). ' +
      'unaccounted = frame time minus the larger of the CPU-outer and GPU sums: work no zone measured.',
  };
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
  const { census = null, earlyZ = null, zones = null, suspects = null, attribution = null, errors = [] } = sections;
  const foundryCanvas = sections.foundryCanvas ?? null;
  const out = [];

  // THE SECOND RENDERER (2026-08-15) — the leading explanation for a large
  // unmeasured remainder. `canvas.primary.renderable === true` means Foundry's
  // PIXI context re-renders every map object into a canvas-resolution render
  // texture EVERY FRAME, on its own ticker, in its own GL context. MSA cannot
  // see one microsecond of it, no effect toggle reaches it, it scales with
  // resolution, and it scales with floor (an upper floor makes more of
  // Foundry's own objects renderable). Deliberate since 2026-08-13 to keep
  // Foundry's fog shader fed (Bug #18) — with the cost never measured.
  if (foundryCanvas?.primaryRenderable === true) {
    const mpx = foundryCanvas.primaryCacheTexture?.mpx ?? null;
    out.push(
      `🔴 FOUNDRY IS STILL RENDERING THE MAP TOO — \`canvas.primary.renderable\` is true, so PIXI re-renders ` +
        `${foundryCanvas.primaryChildrenRenderable ?? '?'} of ${foundryCanvas.primaryChildren ?? '?'} primary objects into a ` +
        `${mpx ?? '?'} Mpx cache texture EVERY FRAME, in Foundry's own GL context. Invisible to every zone here, ` +
        'immune to every effect toggle, and it scales with BOTH resolution and floor. Deliberate (Bug #18, the fog ' +
        'shader reads that cache) but never measured. Console A/B: `canvas.primary.renderable = false` for a few ' +
        'seconds and re-press — fog goes stale meanwhile, and it is reversible with `= true`.'
    );
  }
  const floorIndex = census?.view?.floorIndex ?? sections.floors?.viewed ?? null;

  if (!census && !earlyZ) {
    out.push('🔴 Viewer sections missing entirely — is the MSA viewer running on this scene?');
  }

  // ATTRIBUTION FIRST — a ranked zone table that explains 17% of the frame will
  // still look authoritative, and did (2026-08-15). Say the remainder out loud
  // before any zone gets blamed for anything.
  if (attribution) {
    if (attribution.unaccountedPct >= 40) {
      out.push(
        `🔴 ${attribution.unaccountedPct}% OF THE FRAME IS UNMEASURED — ${attribution.unaccountedMsPerFrame} ms of ` +
          `${attribution.frameMsAvg} ms sits outside every zone (GPU passes sum to ` +
          `${attribution.gpuZoneSumMsPerFrame} ms, outer CPU to ${attribution.cpuOuterZoneSumMsPerFrame} ms). ` +
          'Do NOT blame any zone in the table below until this remainder is named: candidates are work between ' +
          'passes (texture uploads, mip generation, pipeline compiles), driver-level VRAM paging, Foundry/PIXI ' +
          'still rendering underneath, or GPU stalls no pass timestamp covers.'
      );
    } else if (attribution.unaccountedPct >= 20) {
      out.push(
        `🟠 ${attribution.unaccountedPct}% of the frame (${attribution.unaccountedMsPerFrame} ms) is outside every ` +
          'measured zone — the ranked table below is incomplete by that much.'
      );
    }
    if (attribution.refreshCapped) {
      out.push(
        `🟠 This floor is REFRESH-CAPPED at ~${attribution.refreshCapHz} Hz (${attribution.frameMsAvg} ms/frame with ` +
          `only ${attribution.gpuZoneSumMsPerFrame} ms of GPU work) — its frame time is a CEILING, not its cost. ` +
          'Every ground-vs-upper ratio measured against it is a LOWER BOUND on the real gap.'
      );
    }
    if (attribution.gpuBlindZones.length > 0) {
      out.push(
        `🟠 ${attribution.gpuBlindZones.length} draw zone(s) reported CPU time but NO GPU timestamp ` +
          `(${attribution.gpuBlindZones.slice(0, 6).join(', ')}${attribution.gpuBlindZones.length > 6 ? ', …' : ''}) — ` +
          'their GPU cost is missing from the table, not zero.'
      );
    }
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
  const { identity, floors, census, earlyZ, effects, suspects, zones, vram, wholeImage, multiFloorRanked } = sections;
  const foundryCanvas = sections.foundryCanvas ?? null;
  const errors = sections.errors ?? [];
  // Derived here, not by the caller: the attribution math must exist for every
  // dump that has a profiler window, and a caller that forgets it would silently
  // ship the exact blind spot this field was added to close.
  const px = census?.canvasPx ?? null;
  const attribution = summarizeAttribution(zones, {
    megapixels: px?.w > 0 && px?.h > 0 ? (px.w * px.h) / 1e6 : null,
  });
  return {
    report: 'reckoning-report',
    version: RECKONING_REPORT_VERSION,
    generatedAt: generatedAt ?? null,
    readMe:
      'THE RECKONING REPORT (temporary — docs/holy/V4-Reckoning.md). Verdicts first, then attribution ' +
      '(how much of the frame the zones actually explain), then raw sections. ' +
      'Press on BOTH floors from the same camera position and paste both dumps.',
    verdicts: computeReckoningVerdicts({
      identity,
      floors,
      census,
      earlyZ,
      effects,
      suspects,
      zones,
      attribution,
      foundryCanvas,
      errors,
    }),
    attribution,
    foundryCanvas,
    identity: identity ?? null,
    floors: floors ?? null,
    census: census ?? null,
    earlyZ: earlyZ ?? null,
    effects: effects ?? null,
    suspects: suspects ?? null,
    vram: vram ?? null,
    wholeImage: wholeImage ?? null,
    zones: zones ?? null,
    multiFloorRanked: multiFloorRanked ?? null,
    errors,
  };
}
