#!/usr/bin/env node
/**
 * Control wiring audit — find likely disconnected Tweakpane params (Foundry-free).
 *
 * Usage:
 *   node scripts/tools/audit-control-wiring.mjs
 *   npm run audit:controls
 *   npm run audit:controls -- --min-score 30 --effect fire-sparks
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runControlWiringAudit } from './control-wiring-audit-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const out = {
    outJson: path.join(REPO_ROOT, 'docs', 'reports', 'control-wiring-audit.json'),
    outMd: path.join(REPO_ROOT, 'docs', 'reports', 'control-wiring-audit.md'),
    minScore: 30,
    effect: null,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out-json' && argv[i + 1]) { out.outJson = path.resolve(REPO_ROOT, argv[++i]); continue; }
    if (a === '--out-md' && argv[i + 1]) { out.outMd = path.resolve(REPO_ROOT, argv[++i]); continue; }
    if (a === '--min-score' && argv[i + 1]) { out.minScore = Number(argv[++i]); continue; }
    if (a === '--effect' && argv[i + 1]) { out.effect = argv[++i]; continue; }
  }
  return out;
}

/**
 * @param {object} report
 * @param {number} minScore
 */
function renderMarkdown(report, minScore) {
  const lines = [];
  lines.push('# Control Wiring Audit');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('Heuristic static analysis — manual follow-up required. False positives are expected for dynamic access, cross-file bridges, and weather/controlState paths.');
  lines.push('');
  lines.push('**Out of scope:** manual controls in `tweakpane-manager.js`, GPU/visual verification, Foundry runtime.');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Params scanned: **${report.totalParamsScanned}** across **${report.totalEffects}** schema units`);
  lines.push(`- High confidence (≥60): **${report.bucketCounts.high}**`);
  lines.push(`- Medium (30–59): **${report.bucketCounts.medium}**`);
  lines.push(`- Low (10–29): **${report.bucketCounts.low}**`);
  lines.push(`- Info (<10): **${report.bucketCounts.info}**`);
  lines.push(`- Report threshold: score ≥ **${minScore}**`);
  lines.push('');

  if (report.warnings?.length) {
    lines.push('## Extraction warnings');
    lines.push('');
    for (const w of report.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  const byBucket = {
    high: report.findings.filter((f) => f.bucket === 'high'),
    medium: report.findings.filter((f) => f.bucket === 'medium'),
    low: report.findings.filter((f) => f.bucket === 'low'),
  };

  for (const [title, items] of [
    ['High confidence — check first', byBucket.high],
    ['Medium confidence', byBucket.medium],
    ['Low confidence', byBucket.low],
  ]) {
    lines.push(`## ${title}`);
    lines.push('');
    if (!items.length) {
      lines.push('_None at this threshold._');
      lines.push('');
      continue;
    }
    for (const f of items) {
      const flags = f.signals.join(', ');
      lines.push(`### \`${f.effectId}.${f.paramId}\` — score ${f.score}`);
      lines.push('');
      lines.push(`- **Label:** ${f.label}`);
      if (f.hidden) lines.push('- **Hidden in schema**');
      lines.push(`- **Signals:** ${flags}`);
      lines.push(`- **Schema:** \`${f.schemaFile}\``);
      lines.push(`- **Impl:** \`${f.implFile}\``);
      lines.push('');
    }
  }

  if (report.reverseOrphans?.length) {
    lines.push('## Reverse orphans (runtime params not in schema)');
    lines.push('');
    const grouped = new Map();
    for (const r of report.reverseOrphans) {
      if (!grouped.has(r.effectId)) grouped.set(r.effectId, []);
      grouped.get(r.effectId).push(r.paramId);
    }
    for (const [eid, keys] of [...grouped.entries()].sort()) {
      lines.push(`- **${eid}:** ${keys.join(', ')}`);
    }
    lines.push('');
  }

  lines.push('## Scoring reference');
  lines.push('');
  lines.push('| Signal | Score impact |');
  lines.push('|--------|--------------|');
  lines.push('| NOT_IN_RUNTIME_PARAMS | +40 |');
  lines.push('| ZERO_CODE_REFS | +35 |');
  lines.push('| NOT_IN_UI_GROUP | +10 |');
  lines.push('| UI_BRIDGE_WIRED | −45 |');
  lines.push('| RUNTIME_RESOLVED | −35 |');
  lines.push('| PREFIX_WIRED | −20 |');
  lines.push('| SHADER_REF | −15 |');
  lines.push('| HIDDEN | −30 |');
  lines.push('| MARKED_UNUSED | −40 |');
  lines.push('');

  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const report = await runControlWiringAudit({
    minScore: args.minScore,
    effectFilter: args.effect,
  });

  fs.mkdirSync(path.dirname(args.outJson), { recursive: true });
  fs.writeFileSync(args.outJson, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(args.outMd, renderMarkdown(report, args.minScore), 'utf8');

  console.log(`Wrote ${args.outMd}`);
  console.log(`Wrote ${args.outJson}`);
  console.log(`Scanned ${report.totalParamsScanned} params; high=${report.bucketCounts.high} medium=${report.bucketCounts.medium}`);

  if (report.bucketCounts.high > 0) {
    console.log('\nTop high-confidence suspects:');
    for (const f of report.findings.filter((x) => x.bucket === 'high').slice(0, 10)) {
      console.log(`  ${f.effectId}.${f.paramId} (${f.score}) — ${f.signals.join(', ')}`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
