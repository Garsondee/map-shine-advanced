#!/usr/bin/env node
/**
 * Preset Insight Analyzer — compare scene presets locally (no Foundry).
 *
 * Usage:
 *   node scripts/tools/preset-insight.mjs --all
 *   node scripts/tools/preset-insight.mjs --compare furnace-forge,the-mad-scientists-lair
 *   node scripts/tools/preset-insight.mjs --all --out docs/reports/insight.md --json docs/reports/insight.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildSchemaRegistry } from './preset-insight/lib/schema-registry.mjs';
import { flattenPreset, loadPresetsFromDir } from './preset-insight/lib/flatten-preset.mjs';
import { classifyPresetValues } from './preset-insight/lib/edge-classifier.mjs';
import {
  computeLightDarkBalance,
  opposingDeltasVsReference,
} from './preset-insight/lib/light-dark-balance.mjs';
import { diffPresets } from './preset-insight/lib/compare.mjs';
import { runHeuristics } from './preset-insight/lib/heuristics.mjs';
import { computeNeutralScore, summarizeCalibrationReport } from './preset-insight/lib/neutral-score.mjs';
import { formatMarkdownReport, formatJsonReport } from './preset-insight/lib/report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PRESETS_DIR = path.join(REPO_ROOT, 'data', 'presets');

function printHelp() {
  console.log(`Map Shine Preset Insight Analyzer

Options:
  --all                     Analyze every preset in data/presets/
  --compare id1,id2,...     Analyze listed preset ids (comma-separated)
  --reference <id>          Reference preset for diffs (default: baseline)
  --neutral-score           Include neutral calibration scoring section
  --calibration-report <p>  Merge a color-calibration JSON report summary
  --presets-dir <path>      Override presets directory
  --out <file.md>           Write Markdown report to file
  --json <file.json>        Write JSON report to file
  -h, --help                Show this help
`);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const opts = {
    all: false,
    compare: null,
    reference: 'baseline',
    neutralScore: false,
    calibrationReportPath: null,
    calibrationReport: null,
    presetsDir: PRESETS_DIR,
    out: null,
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--compare') opts.compare = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--reference') opts.reference = argv[++i] ?? 'baseline';
    else if (a === '--neutral-score') opts.neutralScore = true;
    else if (a === '--calibration-report') opts.calibrationReportPath = argv[++i] ?? null;
    else if (a === '--presets-dir') opts.presetsDir = path.resolve(argv[++i] ?? PRESETS_DIR);
    else if (a === '--out') opts.out = argv[++i] ?? null;
    else if (a === '--json') opts.json = argv[++i] ?? null;
    else if (a === '-h' || a === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  return opts;
}

/**
 * @param {object[]} rawPresets
 * @param {string[]} ids
 */
function selectPresets(rawPresets, ids) {
  const byId = new Map(rawPresets.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) {
    console.error(`Unknown preset id(s): ${missing.join(', ')}`);
    console.error(`Available: ${[...byId.keys()].join(', ')}`);
    process.exit(1);
  }
  return ids.map((id) => byId.get(id));
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.calibrationReportPath) {
    try {
      const raw = fs.readFileSync(path.resolve(opts.calibrationReportPath), 'utf8');
      opts.calibrationReport = JSON.parse(raw);
    } catch (e) {
      console.error(`[preset-insight] Failed reading calibration report: ${e?.message ?? e}`);
      process.exit(1);
    }
  }

  if (!opts.all && !opts.compare?.length) {
    printHelp();
    process.exit(1);
  }

  const rawPresets = loadPresetsFromDir(opts.presetsDir);
  let selected;
  if (opts.all) {
    selected = rawPresets.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  } else {
    const ids = [...new Set(opts.compare)];
    if (!ids.includes(opts.reference) && opts.reference) ids.unshift(opts.reference);
    selected = selectPresets(rawPresets, ids);
  }

  const refPreset = selected.find((p) => p.id === opts.reference) ?? selected[0];
  if (!refPreset) {
    console.error('No presets to analyze.');
    process.exit(1);
  }

  console.error('[preset-insight] Building schema registry…');
  const registry = await buildSchemaRegistry();
  console.error(`[preset-insight] Registry entries: ${registry.size}`);

  const flattened = selected.map((p) => flattenPreset(p));
  const refFlat = flattened.find((f) => f.id === refPreset.id)?.flat;

  const analyzed = flattened.map((fp) => {
    const classified = classifyPresetValues(registry, fp.flat);
    const lightDark = computeLightDarkBalance(classified.entries);
    const refEntry = flattened.find((f) => f.id === refPreset.id);
    const opposingDeltas =
      fp.id !== refPreset.id && refEntry
        ? opposingDeltasVsReference(classified.entries, classifyPresetValues(registry, refEntry.flat).entries)
        : null;
    const diff =
      fp.id !== refPreset.id && refFlat ? diffPresets(fp.flat, refFlat, registry) : null;
    const neutralScore = opts.neutralScore ? computeNeutralScore(fp.flat, registry) : null;

    return {
      id: fp.id,
      name: fp.name,
      edgeStats: {
        totals: classified.totals,
        byEffect: classified.byEffect,
        schemaGaps: classified.schemaGaps,
      },
      lightDark,
      opposingDeltas,
      neutralScore,
      diff,
      classified,
    };
  });

  const heuristics = runHeuristics(
    analyzed.map((a) => ({ id: a.id, classified: a.classified })),
    registry,
  );

  const cohort = analyzed.map((a) => ({
    id: a.id,
    bounded: a.edgeStats.totals.bounded,
    nearMin10: a.edgeStats.totals.nearMin10,
    nearMax10: a.edgeStats.totals.nearMax10,
    atMin: a.edgeStats.totals.atMin,
    atMax: a.edgeStats.totals.atMax,
    lightMean: a.lightDark.means.light,
    darkMean: a.lightDark.means.dark,
    tensionIndex: a.lightDark.tensionIndex,
  }));

  const DIFF_JSON_CAP = 80;
  const presetsOut = analyzed.map(({ classified, diff, ...rest }) => {
    if (!diff) return { ...rest, diff: null };
    const changes = diff.changes.slice(0, DIFF_JSON_CAP);
    return {
      ...rest,
      diff: {
        ...diff,
        changes,
        changesTotal: diff.changes.length,
        changesTruncated: diff.changes.length > DIFF_JSON_CAP,
      },
    };
  });

  const analysis = {
    meta: {
      generatedAt: new Date().toISOString(),
      toolVersion: '1.0.0',
      registrySize: registry.size,
      presetsDir: opts.presetsDir,
      neutralScoreEnabled: opts.neutralScore,
    },
    reference: { id: refPreset.id, name: refPreset.name },
    presets: presetsOut,
    heuristics,
    cohort,
    calibrationReport: summarizeCalibrationReport(opts.calibrationReport),
  };

  const md = formatMarkdownReport(analysis);
  const json = formatJsonReport(analysis);

  if (opts.out) {
    fs.mkdirSync(path.dirname(opts.out), { recursive: true });
    fs.writeFileSync(opts.out, md, 'utf8');
    console.error(`[preset-insight] Wrote Markdown: ${opts.out}`);
  } else {
    console.log(md);
  }

  if (opts.json) {
    fs.mkdirSync(path.dirname(opts.json), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify(json, null, 2), 'utf8');
    console.error(`[preset-insight] Wrote JSON: ${opts.json}`);
  }
}

main().catch((err) => {
  console.error('[preset-insight] Fatal:', err);
  process.exit(1);
});
