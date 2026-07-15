#!/usr/bin/env node
/**
 * Legacy wrapper — use `npm run audit:controls` for full reports.
 * Run: node scripts/tools/audit-tweakpane-schema-refs.mjs
 */
import { runControlWiringAudit } from './control-wiring-audit-lib.mjs';

const report = await runControlWiringAudit({ minScore: 10 });

for (const f of report.allFindings) {
  const zeroRef = f.signals.includes('ZERO_CODE_REFS');
  const notInGroup = f.signals.includes('NOT_IN_UI_GROUP');
  const notInParams = f.signals.includes('NOT_IN_RUNTIME_PARAMS');
  if (!zeroRef && !notInGroup && !notInParams) continue;

  console.log(`\n## ${f.implFile} :: ${f.effectId}.${f.paramId} (score ${f.score})`);
  if (notInGroup) console.log(`  NOT_IN_ANY_GROUP`);
  if (zeroRef) console.log(`  ZERO_REFS_OUTSIDE_SCHEMA_METHODS`);
  if (notInParams) console.log(`  NOT_IN_RUNTIME_PARAMS`);
}

console.log(`\n---\n${report.totalParamsScanned} params scanned. For full report: npm run audit:controls`);

if (report.bucketCounts.high > 0) process.exitCode = 1;
