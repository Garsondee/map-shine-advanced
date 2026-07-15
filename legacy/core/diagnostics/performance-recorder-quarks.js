/**
 * @fileoverview three.quarks particle inventory helpers for Performance Recorder.
 * Live + session-aggregated snapshots (not per-frame timelines).
 *
 * @module core/diagnostics/performance-recorder-quarks
 */

import { resolveQuarkLabel, resolveQuarkSource } from '../quark-diagnostics.js';
import { resolveFloorCompositor } from './performance-recorder-weather-window.js';

/** Default compositor frame interval between particle samples (~4 Hz @ 60 fps). */
export const QUARKS_SAMPLE_INTERVAL_FRAMES = 15;

/** Max ranked system rows in summary JSON / markdown. */
export const SUMMARY_QUARKS_TOP_SYSTEMS_CAP = 15;

/** Max per-source group rows in summary JSON. */
export const SUMMARY_QUARKS_SOURCE_GROUPS_CAP = 8;

/** Max system peak rows tracked for a session. */
const SESSION_SYSTEM_PEAKS_CAP = 20;

/**
 * @param {number} n
 * @returns {number}
 */
function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * @param {number[]} arr
 * @param {number} p
 * @returns {number}
 */
function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * @param {number[]} values
 * @returns {{ min: number, max: number, avg: number, p95: number }}
 */
function summarizeValues(values) {
  const arr = (values ?? []).filter((v) => Number.isFinite(v));
  if (arr.length === 0) {
    return { min: 0, max: 0, avg: 0, p95: 0 };
  }
  const sum = arr.reduce((s, v) => s + v, 0);
  return {
    min: round2(Math.min(...arr)),
    max: round2(Math.max(...arr)),
    avg: round2(sum / arr.length),
    p95: round2(percentile(arr, 0.95)),
  };
}

/**
 * @param {import('../../particles/WeatherParticles.js').WeatherParticles|null|undefined} wp
 * @returns {Map<object, string>}
 */
function buildWeatherSystemIdentityMap(wp) {
  /** @type {Map<object, string>} */
  const map = new Map();
  if (!wp) return map;
  const add = (key, sys) => {
    if (sys) map.set(sys, key);
  };
  add('rain', wp.rainSystem);
  add('roofDrip', wp.roofDripSystem);
  add('snow', wp.snowSystem);
  add('ash', wp.ashSystem);
  add('ashEmber', wp.ashEmberSystem);
  add('splash', wp.splashSystem);
  if (wp.splashSystems?.length) {
    let i = 0;
    for (const sys of wp.splashSystems) add(`splash[${i++}]`, sys);
  }
  add('rainImpactSplash', wp._rainImpactSplashSystem);
  if (wp._waterHitSplashSystems?.length) {
    let i = 0;
    for (const entry of wp._waterHitSplashSystems) add(`waterHitSplash[${i++}]`, entry?.system);
  }
  add('foam', wp._foamSystem);
  add('foamFleck', wp._foamFleckSystem);
  return map;
}

/**
 * @param {import('../../libs/three.quarks.module.js').BatchedRenderer|null|undefined} br
 * @param {{ prefix?: string, groupByPrefix?: boolean, filter?: (ps: object) => boolean, identityLabelMap?: Map<object, string> }} [options]
 * @returns {object|null}
 */
export function inspectBatchedRenderer(br, options = {}) {
  if (!br) return null;
  const map = br.systemToBatchIndex;
  if (!map || typeof map.forEach !== 'function') {
    return {
      batchCount: br.batches?.length ?? 0,
      systemCount: 0,
      particles: 0,
      visibleParticles: 0,
      culledSystems: 0,
      systems: [],
      groups: [],
    };
  }

  /** @type {object[]} */
  const systems = [];
  /** @type {Map<string, { label: string, systems: number, particles: number, visibleParticles: number, culledSystems: number }>} */
  const groupMap = new Map();
  let index = 0;
  let particles = 0;
  let visibleParticles = 0;
  let culledSystems = 0;

  for (const [ps] of map.entries()) {
    if (!ps) continue;
    if (typeof options.filter === 'function' && !options.filter(ps)) continue;
    const count = Number(ps.particleNum) || 0;
    const emitter = ps.emitter;
    const ud = emitter?.userData ?? {};
    const visible = emitter?.visible !== false;
    const culled = ud._msCulled === true;
    let label = resolveQuarkLabel(ps, index);
    const identityLabel = options.identityLabelMap?.get?.(ps);
    if (identityLabel && label.startsWith('system#')) {
      label = identityLabel;
    }
    const cap = Number(ps._msParticleCap) || null;
    const emission = Number(ps.emissionOverTime?.value);
    const groupLabel = options.groupByPrefix && options.prefix
      ? `${options.prefix}/${label}`
      : label;

    particles += count;
    if (visible) visibleParticles += count;
    if (culled) culledSystems += 1;

    systems.push({
      label,
      particles: count,
      cap,
      visible,
      culled,
      emission: Number.isFinite(emission) ? round2(emission) : null,
    });

    const groupKey = options.prefix ? `${options.prefix}:${label}` : label;
    let group = groupMap.get(groupKey);
    if (!group) {
      group = {
        label: groupLabel,
        systems: 0,
        particles: 0,
        visibleParticles: 0,
        culledSystems: 0,
      };
      groupMap.set(groupKey, group);
    }
    group.systems += 1;
    group.particles += count;
    if (visible) group.visibleParticles += count;
    if (culled) group.culledSystems += 1;

    index += 1;
  }

  systems.sort((a, b) => b.particles - a.particles);
  const groups = [...groupMap.values()].sort((a, b) => b.particles - a.particles);

  return {
    batchCount: br.batches?.length ?? 0,
    systemCount: systems.length,
    particles,
    visibleParticles,
    culledSystems,
    systems,
    groups,
  };
}

/**
 * @param {object[]} systems
 * @param {number} totalParticles
 * @returns {object[]}
 */
function attachSharePct(systems, totalParticles) {
  const denom = totalParticles > 0 ? totalParticles : 1;
  return (systems ?? []).map((row) => ({
    ...row,
    sharePct: round2(((Number(row.particles) || 0) / denom) * 100),
  }));
}

/**
 * @param {object} row
 * @param {import('../../libs/three.quarks.module.js').BatchedRenderer|null|undefined} br
 * @param {object} [meta]
 * @returns {object}
 */
function buildSourceRow(row, br, meta = null, inspectOptions = {}) {
  const inspected = inspectBatchedRenderer(br, { prefix: row.id, groupByPrefix: true, ...inspectOptions }) ?? {
    batchCount: 0,
    systemCount: 0,
    particles: 0,
    visibleParticles: 0,
    culledSystems: 0,
    systems: [],
    groups: [],
  };
  return {
    id: row.id,
    label: row.label,
    enabled: row.enabled !== false,
    batchRenderers: 1,
    batchCount: inspected.batchCount,
    systems: inspected.systemCount,
    particles: inspected.particles,
    visibleParticles: inspected.visibleParticles,
    culledSystems: inspected.culledSystems,
    meta: meta ?? row.meta ?? null,
    groups: inspected.groups,
    topSystems: inspected.systems.slice(0, 12),
  };
}

/**
 * @param {object[]} sources
 * @param {Set<object>} seenRenderers
 * @param {import('../../libs/three.quarks.module.js').BatchedRenderer|null|undefined} br
 * @param {object[]} partitions
 */
function addPartitionedBatchSources(sources, seenRenderers, br, partitions) {
  if (!br || seenRenderers.has(br)) return;
  seenRenderers.add(br);
  for (const part of partitions) {
    const inspected = inspectBatchedRenderer(br, {
      prefix: part.id,
      groupByPrefix: true,
      filter: typeof part.filter === 'function'
        ? part.filter
        : (ps) => resolveQuarkSource(ps) === part.source,
      identityLabelMap: part.identityLabelMap ?? null,
    }) ?? {
      batchCount: 0,
      systemCount: 0,
      particles: 0,
      visibleParticles: 0,
      culledSystems: 0,
      systems: [],
      groups: [],
    };
    if (part.skipIfEmpty && (inspected.systemCount ?? 0) === 0) continue;
    sources.push({
      id: part.id,
      label: part.label,
      enabled: part.enabled !== false,
      batchRenderers: 1,
      batchCount: inspected.batchCount,
      systems: inspected.systemCount,
      particles: inspected.particles,
      visibleParticles: inspected.visibleParticles,
      culledSystems: inspected.culledSystems,
      meta: part.meta ?? null,
      groups: inspected.groups,
      topSystems: inspected.systems.slice(0, 12),
      sharedBatchRenderer: true,
    });
  }
}

/**
 * Collect live three.quarks inventory from active compositor effects.
 * @returns {object}
 */
export function collectQuarksLiveSnapshot() {
  const fc = resolveFloorCompositor();
  /** @type {Set<object>} */
  const seenRenderers = new Set();
  /** @type {object[]} */
  const sources = [];

  const addSource = (row, br, meta = null) => {
    if (!br || seenRenderers.has(br)) return;
    seenRenderers.add(br);
    sources.push(buildSourceRow(row, br, meta));
  };

  try {
    const weather = fc?._weatherParticles;
    const weatherIdentityMap = buildWeatherSystemIdentityMap(weather?._weatherParticles);
    let weatherMeta = null;
    try {
      weatherMeta = weather?.getPerformanceSnapshot?.() ?? null;
    } catch (_) {}
    addPartitionedBatchSources(sources, seenRenderers, weather?._batchRenderer, [
      {
        id: 'weather',
        label: 'Weather particles',
        source: 'weather',
        enabled: weather?.enabled !== false,
        meta: weatherMeta,
        identityLabelMap: weatherIdentityMap,
        filter: (ps) => resolveQuarkSource(ps) === 'weather' || weatherIdentityMap.has(ps),
      },
      {
        id: 'smellyFlies',
        label: 'Smelly flies',
        source: 'smellyFlies',
        enabled: fc?._smellyFliesEffect?.enabled !== false,
        filter: (ps) => resolveQuarkSource(ps) === 'smellyFlies',
      },
      {
        id: 'sharedBatchOther',
        label: 'Shared batch (unlabeled)',
        source: 'unknown',
        skipIfEmpty: true,
        filter: (ps) => {
          if (resolveQuarkSource(ps) === 'smellyFlies') return false;
          if (resolveQuarkSource(ps) === 'weather' || weatherIdentityMap.has(ps)) return false;
          return true;
        },
      },
    ]);
  } catch (_) {}

  try {
    const dust = fc?._dustEffect;
    addSource(
      { id: 'dust', label: 'Dust motes', enabled: dust?.enabled !== false && dust?.params?.enabled !== false },
      dust?._batchRenderer,
    );
  } catch (_) {}

  try {
    const ash = fc?._ashDisturbanceEffect;
    addSource(
      { id: 'ashDisturbance', label: 'Ash disturbance', enabled: ash?.enabled !== false },
      ash?._batchRenderer,
    );
  } catch (_) {}

  try {
    const torch = fc?._playerLightEffect;
    addSource(
      { id: 'playerLightTorch', label: 'Player torch', enabled: torch?.enabled !== false },
      torch?._torchBatchRenderer,
    );
  } catch (_) {}

  try {
    const fire = fc?._fireEffect;
    const floorStates = fire?._floorStates;
    if (floorStates && typeof floorStates.forEach === 'function') {
      /** @type {object[]} */
      const floors = [];
      for (const [floorIndex, state] of floorStates.entries()) {
        const br = state?.batchRenderer;
        if (!br || seenRenderers.has(br)) continue;
        seenRenderers.add(br);
        const inspected = inspectBatchedRenderer(br, { prefix: `fire/f${floorIndex}`, groupByPrefix: true })
          ?? { batchCount: 0, systemCount: 0, particles: 0, visibleParticles: 0, culledSystems: 0, systems: [], groups: [] };
        floors.push({
          floor: Number(floorIndex) || 0,
          batchCount: inspected.batchCount,
          systems: inspected.systemCount,
          particles: inspected.particles,
          visibleParticles: inspected.visibleParticles,
          culledSystems: inspected.culledSystems,
          groups: {
            fire: state?.systems?.length ?? 0,
            ember: state?.emberSystems?.length ?? 0,
            smoke: state?.smokeSystems?.length ?? 0,
          },
          topSystems: inspected.systems.slice(0, 8),
        });
      }
      if (floors.length > 0) {
        const totals = floors.reduce((acc, f) => {
          acc.batchRenderers += 1;
          acc.systems += f.systems;
          acc.particles += f.particles;
          acc.visibleParticles += f.visibleParticles;
          acc.culledSystems += f.culledSystems;
          acc.batchCount += f.batchCount;
          return acc;
        }, {
          batchRenderers: 0,
          systems: 0,
          particles: 0,
          visibleParticles: 0,
          culledSystems: 0,
          batchCount: 0,
        });
        sources.push({
          id: 'fire',
          label: 'Fire',
          enabled: fire?.enabled !== false,
          ...totals,
          meta: { activeFloors: floors.length },
          floors,
          groups: floors.flatMap((f) => (f.topSystems ?? []).map((s) => ({
            label: `f${f.floor}/${s.label}`,
            systems: 1,
            particles: s.particles,
            visibleParticles: s.visible ? s.particles : 0,
            culledSystems: s.culled ? 1 : 0,
          }))).sort((a, b) => b.particles - a.particles).slice(0, 12),
          topSystems: floors.flatMap((f) => (f.topSystems ?? []).map((s) => ({
            ...s,
            label: `f${f.floor}/${s.label}`,
          }))).sort((a, b) => b.particles - a.particles).slice(0, 12),
        });
      }
    }
  } catch (_) {}

  try {
    const splash = fc?._waterSplashesEffect;
    const floorStates = splash?._floorStates;
    if (floorStates && typeof floorStates.forEach === 'function') {
      /** @type {object[]} */
      const floors = [];
      for (const [floorIndex, state] of floorStates.entries()) {
        const br = state?.batchRenderer;
        if (!br || seenRenderers.has(br)) continue;
        seenRenderers.add(br);
        const inspected = inspectBatchedRenderer(br, { prefix: `splashes/f${floorIndex}`, groupByPrefix: true })
          ?? { batchCount: 0, systemCount: 0, particles: 0, visibleParticles: 0, culledSystems: 0, systems: [], groups: [] };
        floors.push({
          floor: Number(floorIndex) || 0,
          batchCount: inspected.batchCount,
          systems: inspected.systemCount,
          particles: inspected.particles,
          visibleParticles: inspected.visibleParticles,
          culledSystems: inspected.culledSystems,
          groups: {
            foam: state?.foamSystems?.length ?? 0,
            splash: state?.splashSystems?.length ?? 0,
            foam2: state?.foamSystems2?.length ?? 0,
            splash2: state?.splashSystems2?.length ?? 0,
          },
          topSystems: inspected.systems.slice(0, 8),
        });
      }
      if (floors.length > 0) {
        const totals = floors.reduce((acc, f) => {
          acc.batchRenderers += 1;
          acc.systems += f.systems;
          acc.particles += f.particles;
          acc.visibleParticles += f.visibleParticles;
          acc.culledSystems += f.culledSystems;
          acc.batchCount += f.batchCount;
          return acc;
        }, {
          batchRenderers: 0,
          systems: 0,
          particles: 0,
          visibleParticles: 0,
          culledSystems: 0,
          batchCount: 0,
        });
        sources.push({
          id: 'waterSplashes',
          label: 'Water splashes & bubbles',
          enabled: splash?.enabled !== false,
          ...totals,
          meta: { activeFloors: floors.length },
          floors,
          groups: floors.flatMap((f) => (f.topSystems ?? []).map((s) => ({
            label: `f${f.floor}/${s.label}`,
            systems: 1,
            particles: s.particles,
            visibleParticles: s.visible ? s.particles : 0,
            culledSystems: s.culled ? 1 : 0,
          }))).sort((a, b) => b.particles - a.particles).slice(0, 12),
          topSystems: floors.flatMap((f) => (f.topSystems ?? []).map((s) => ({
            ...s,
            label: `f${f.floor}/${s.label}`,
          }))).sort((a, b) => b.particles - a.particles).slice(0, 12),
        });
      }
    }
  } catch (_) {}

  const totals = sources.reduce((acc, src) => {
    acc.batchRenderers += src.batchRenderers ?? (src.floors ? src.floors.length : 1);
    acc.systems += src.systems ?? 0;
    acc.particles += src.particles ?? 0;
    acc.visibleParticles += src.visibleParticles ?? 0;
    acc.culledSystems += src.culledSystems ?? 0;
    acc.batchCount += src.batchCount ?? 0;
    return acc;
  }, {
    batchRenderers: 0,
    systems: 0,
    particles: 0,
    visibleParticles: 0,
    culledSystems: 0,
    batchCount: 0,
  });

  /** @type {object[]} */
  const topSystems = [];
  for (const src of sources) {
    for (const sys of src.topSystems ?? []) {
      topSystems.push({
        source: src.id,
        sourceLabel: src.label,
        label: sys.label,
        particles: sys.particles ?? 0,
        cap: sys.cap ?? null,
        visible: sys.visible !== false,
        culled: sys.culled === true,
      });
    }
  }
  topSystems.sort((a, b) => b.particles - a.particles);

  return {
    capturedAtMs: performance.now(),
    totals,
    sources: sources.sort((a, b) => (b.particles ?? 0) - (a.particles ?? 0)),
    topSystems: attachSharePct(topSystems, totals.particles).slice(0, SUMMARY_QUARKS_TOP_SYSTEMS_CAP),
  };
}

/**
 * @returns {object}
 */
export function createQuarksSessionAccumulator() {
  return {
    sampleIntervalFrames: QUARKS_SAMPLE_INTERVAL_FRAMES,
    samples: 0,
    totalParticleSamples: [],
    totalSystemSamples: [],
    bySource: new Map(),
    systemPeaks: new Map(),
    peak: null,
  };
}

/**
 * @param {object} acc
 */
export function resetQuarksSession(acc) {
  if (!acc) return;
  acc.samples = 0;
  acc.totalParticleSamples.length = 0;
  acc.totalSystemSamples.length = 0;
  acc.bySource.clear();
  acc.systemPeaks.clear();
  acc.peak = null;
}

/**
 * @param {object} acc
 * @param {string} sourceId
 * @returns {object}
 */
function getSourceAccumulator(acc, sourceId) {
  let row = acc.bySource.get(sourceId);
  if (!row) {
    row = {
      particleSamples: [],
      systemSamples: [],
    };
    acc.bySource.set(sourceId, row);
  }
  return row;
}

/**
 * @param {object} acc
 * @param {object} live
 * @param {{ frameSeq?: number, tMs?: number }} [frameMeta]
 */
export function sampleQuarksSession(acc, live, frameMeta = {}) {
  if (!acc || !live?.sources?.length) return;

  acc.samples += 1;
  const totalParticles = Number(live.totals?.particles) || 0;
  const totalSystems = Number(live.totals?.systems) || 0;
  acc.totalParticleSamples.push(totalParticles);
  acc.totalSystemSamples.push(totalSystems);

  for (const src of live.sources) {
    const sourceAcc = getSourceAccumulator(acc, src.id);
    sourceAcc.particleSamples.push(Number(src.particles) || 0);
    sourceAcc.systemSamples.push(Number(src.systems) || 0);

    for (const sys of src.topSystems ?? []) {
      const key = `${src.id}/${sys.label}`;
      const count = Number(sys.particles) || 0;
      let peak = acc.systemPeaks.get(key);
      if (!peak) {
        peak = {
          source: src.id,
          sourceLabel: src.label,
          label: sys.label,
          maxParticles: count,
          sumParticles: count,
          samples: 1,
        };
        acc.systemPeaks.set(key, peak);
      } else {
        peak.maxParticles = Math.max(peak.maxParticles, count);
        peak.sumParticles += count;
        peak.samples += 1;
      }
    }
  }

  if (!acc.peak || totalParticles >= (acc.peak.particles ?? 0)) {
    acc.peak = {
      particles: totalParticles,
      systems: totalSystems,
      frameSeq: frameMeta.frameSeq ?? null,
      tMs: frameMeta.tMs ?? null,
      topSystems: (live.topSystems ?? []).slice(0, SUMMARY_QUARKS_TOP_SYSTEMS_CAP),
    };
  }
}

/**
 * @param {object|null|undefined} acc
 * @returns {object|null}
 */
export function finalizeQuarksSession(acc) {
  if (!acc || acc.samples <= 0) return null;

  /** @type {Record<string, object>} */
  const bySource = {};
  for (const [sourceId, row] of acc.bySource.entries()) {
    bySource[sourceId] = {
      particles: summarizeValues(row.particleSamples),
      systems: summarizeValues(row.systemSamples),
    };
  }

  const systemPeaks = [...acc.systemPeaks.values()]
    .map((row) => ({
      source: row.source,
      sourceLabel: row.sourceLabel,
      label: row.label,
      maxParticles: row.maxParticles,
      avgParticles: round2(row.sumParticles / Math.max(1, row.samples)),
      samples: row.samples,
    }))
    .sort((a, b) => b.maxParticles - a.maxParticles)
    .slice(0, SESSION_SYSTEM_PEAKS_CAP);

  return {
    sampleIntervalFrames: acc.sampleIntervalFrames,
    samples: acc.samples,
    totals: {
      particles: summarizeValues(acc.totalParticleSamples),
      systems: summarizeValues(acc.totalSystemSamples),
    },
    bySource,
    peak: acc.peak,
    systemPeaks,
  };
}

/**
 * @param {{ live?: object|null, session?: object|null }} params
 * @returns {object|null}
 */
export function buildQuarksPerfSection(params = {}) {
  const live = params.live ?? collectQuarksLiveSnapshot();
  const session = params.session ?? null;
  if (!live?.sources?.length && !session) return null;

  return {
    note:
      'Live three.quarks inventory at export/stop time plus session aggregates sampled every '
      + `${QUARKS_SAMPLE_INTERVAL_FRAMES} compositor frames. Smelly flies share the weather `
      + 'BatchedRenderer but are reported under smellyFlies. Use topSystems/sharePct to spot one emitter dominating particle count.',
    live,
    session,
  };
}

/**
 * @param {object} section
 * @returns {object|null}
 */
export function buildSummaryQuarksSection(section) {
  if (!section) return null;
  const live = section.live ?? null;
  const session = section.session ?? null;

  /** @type {Record<string, unknown>} */
  const out = {
    note: section.note ?? null,
  };

  if (live) {
    out.live = {
      totals: live.totals ?? null,
      sources: (live.sources ?? []).map((src) => ({
        id: src.id,
        label: src.label,
        enabled: src.enabled,
        systems: src.systems ?? 0,
        particles: src.particles ?? 0,
        visibleParticles: src.visibleParticles ?? 0,
        culledSystems: src.culledSystems ?? 0,
        meta: src.meta ?? null,
        groups: (src.groups ?? []).slice(0, SUMMARY_QUARKS_SOURCE_GROUPS_CAP),
        topSystems: (src.topSystems ?? []).slice(0, 6),
        floors: src.floors
          ? src.floors.map((f) => ({
            floor: f.floor,
            systems: f.systems,
            particles: f.particles,
            groups: f.groups,
          }))
          : undefined,
      })),
      topSystems: (live.topSystems ?? []).slice(0, SUMMARY_QUARKS_TOP_SYSTEMS_CAP),
    };
  }

  if (session) {
    out.session = {
      sampleIntervalFrames: session.sampleIntervalFrames,
      samples: session.samples,
      totals: session.totals ?? null,
      bySource: session.bySource ?? null,
      peak: session.peak ?? null,
      systemPeaks: (session.systemPeaks ?? []).slice(0, SUMMARY_QUARKS_TOP_SYSTEMS_CAP),
    };
  }

  return out;
}

/**
 * @param {object|null|undefined} section
 * @returns {string[]}
 */
export function formatQuarksMarkdown(section) {
  if (!section?.live && !section?.session) return [];

  const lines = [];
  lines.push('## Quarks particles');
  lines.push('');

  const live = section.live;
  if (live?.totals) {
    const t = live.totals;
    lines.push(
      `- Live inventory: **${t.particles ?? 0}** particles across **${t.systems ?? 0}** systems `
      + `(**${t.visibleParticles ?? 0}** visible, **${t.culledSystems ?? 0}** culled systems, `
      + `${t.batchRenderers ?? 0} batch renderer(s))`,
    );
    const sources = live.sources ?? [];
    if (sources.length) {
      const srcParts = sources.slice(0, 6).map((s) =>
        `${s.label} ${s.particles ?? 0}`,
      ).join(' · ');
      lines.push(`- By source: ${srcParts}`);
    }
    const top = live.topSystems ?? [];
    if (top.length) {
      lines.push('- Top systems now:');
      for (const row of top.slice(0, 8)) {
        const cap = row.cap != null ? ` / cap ${row.cap}` : '';
        lines.push(
          `  - **${row.sourceLabel ?? row.source}/${row.label}** — ${row.particles ?? 0} `
          + `(${row.sharePct ?? 0}%${cap})`,
        );
      }
    }
    lines.push('');
  }

  const session = section.session;
  if (session?.samples > 0) {
    const totals = session.totals?.particles ?? {};
    lines.push(
      `- Session samples: **${session.samples}** (every ${session.sampleIntervalFrames ?? '?'} frames) · `
      + `particles min **${totals.min ?? 0}** / avg **${totals.avg ?? 0}** / p95 **${totals.p95 ?? 0}** / max **${totals.max ?? 0}**`,
    );
    const peak = session.peak;
    if (peak?.particles > 0) {
      lines.push(
        `- Peak frame: **${peak.particles}** particles @ ${peak.tMs != null ? `${(peak.tMs / 1000).toFixed(2)}s` : '?'}`,
      );
    }
    const peaks = session.systemPeaks ?? [];
    if (peaks.length) {
      lines.push('- Highest system peaks:');
      for (const row of peaks.slice(0, 8)) {
        lines.push(
          `  - **${row.sourceLabel}/${row.label}** max **${row.maxParticles}** avg **${row.avgParticles}**`,
        );
      }
    }
    lines.push('');
  }

  return lines;
}
