/**
 * Markdown and JSON report formatters.
 */

/**
 * @param {object} analysis
 * @returns {string}
 */
export function formatMarkdownReport(analysis) {
  const lines = [];
  const { meta, reference, presets, heuristics, cohort } = analysis;

  lines.push('# Map Shine Preset Insight Report', '');
  lines.push(`Generated: ${meta.generatedAt}`);
  lines.push(`Reference preset: **${reference.id}** (${reference.name})`);
  lines.push(`Compared: ${presets.map((p) => p.id).join(', ')}`, '');
  if (analysis.calibrationReport) {
    const cr = analysis.calibrationReport;
    lines.push(`Calibration report merged: patches=${cr.patchCount}, busMeanΔ=${fmt(cr.busMeanDelta)}, finalMeanΔ=${fmt(cr.finalMeanDelta)}`, '');
  }

  lines.push('## Executive summary', '');
  if (heuristics.length) {
    for (const f of heuristics.slice(0, 8)) {
      lines.push(`- **[${f.severity}]** ${f.message}`);
    }
  } else {
    lines.push('- No high-priority heuristic flags in this cohort.');
  }
  lines.push('');

  lines.push('## Cohort overview', '');
  lines.push('| Preset | Bounded numeric | Near min 10% | Near max 10% | At min | At max | Light mean | Dark mean | Tension |');
  lines.push('|--------|-----------------|--------------|--------------|--------|--------|------------|-----------|---------|');
  for (const row of cohort) {
    lines.push(
      `| ${row.id} | ${row.bounded} | ${row.nearMin10} | ${row.nearMax10} | ${row.atMin} | ${row.atMax} | ${fmt(row.lightMean)} | ${fmt(row.darkMean)} | ${fmt(row.tensionIndex)} |`,
    );
  }
  lines.push('');

  for (const preset of presets) {
    lines.push(`## ${preset.name} (\`${preset.id}\`)`, '');

    lines.push('### Edge bands (schema-bounded numerics)', '');
    const t = preset.edgeStats.totals;
    lines.push(
      `- Bounded: ${t.bounded} / ${t.numeric} numeric keys`,
    );
    lines.push(
      `- Within 10% of min: ${t.nearMin10}; within 10% of max: ${t.nearMax10}`,
    );
    lines.push(
      `- Within 25% of min: ${t.nearMin25}; within 25% of max: ${t.nearMax25}`,
    );
    lines.push(`- At min: ${t.atMin}; at max: ${t.atMax}`, '');

    if (preset.edgeStats.byEffect?.length) {
      lines.push('**By effect (top rail pressure):**', '');
      const sorted = [...preset.edgeStats.byEffect]
        .filter((e) => e.bounded >= 3)
        .sort((a, b) => b.nearMax25 + b.nearMin25 - (a.nearMax25 + a.nearMin25))
        .slice(0, 10);
      for (const e of sorted) {
        lines.push(
          `- \`${e.effectId}\`: ${e.bounded} bounded — min25=${e.nearMin25}, max25=${e.nearMax25}, atMin=${e.atMin}, atMax=${e.atMax}`,
        );
      }
      lines.push('');
    }

    lines.push('### Light vs Dark balance', '');
    const ld = preset.lightDark;
    lines.push(
      `- Tagged: light=${ld.counts.light}, dark=${ld.counts.dark}, neutral=${ld.counts.neutral}, unknown=${ld.counts.unknown}`,
    );
    lines.push(
      `- Mean normalized: light=${fmt(ld.means.light)}, dark=${fmt(ld.means.dark)}, tension (light−dark)=${fmt(ld.tensionIndex)}`,
    );
    lines.push(
      `- Top 25% rails: light ${ld.lightRailPct.toFixed(1)}%, dark ${ld.darkRailPct.toFixed(1)}%${ld.bothArmiesAtRails ? ' — **both armies at rails**' : ''}`,
    );
    for (const n of ld.narratives) lines.push(`- ${n}`);
    lines.push('');

    if (preset.neutralScore) {
      lines.push('### Neutral calibration score', '');
      lines.push(`- Score: ${fmt(preset.neutralScore.score)} / 100 across ${preset.neutralScore.considered} target controls`);
      for (const d of preset.neutralScore.topDeviations.slice(0, 8)) {
        lines.push(`- \`${d.path}\`: target=${fmtVal(d.target)} current=${fmtVal(d.value)} (err ${fmt(d.normalizedError)})`);
      }
      lines.push('');
    }

    if (preset.id !== reference.id && preset.opposingDeltas) {
      lines.push(`### vs \`${reference.id}\` — opposing light/dark deltas`, '');
      appendDeltaList(lines, 'Light increased', preset.opposingDeltas.lightIncreased);
      appendDeltaList(lines, 'Dark increased', preset.opposingDeltas.darkIncreased);
      lines.push('');
    }

    if (preset.diff && preset.id !== reference.id) {
      lines.push(`### Diff vs \`${reference.id}\` (top changes)`, '');
      if (preset.diff.enabledToggles?.length) {
        lines.push('**Effect enabled toggles:**', '');
        for (const e of preset.diff.enabledToggles.slice(0, 15)) {
          lines.push(`- \`${e.path}\`: ${e.reference} → ${e.target}`);
        }
        lines.push('');
      }
      for (const c of preset.diff.changes.slice(0, 25)) {
        const rd = c.relativeDelta != null ? ` (Δ ${(c.relativeDelta * 100).toFixed(0)}% of range)` : '';
        lines.push(`- \`${c.path}\`${rd}: ${fmtVal(c.reference)} → ${fmtVal(c.target)}`);
      }
      lines.push('');
    }

    const gaps = preset.edgeStats.schemaGaps;
    if (gaps.outOfRange.length || gaps.unbounded.length) {
      lines.push('### Schema gaps', '');
      if (gaps.outOfRange.length) {
        lines.push(`- Out of range: ${gaps.outOfRange.length} (first: ${gaps.outOfRange.slice(0, 3).map((x) => x.path).join(', ')})`);
      }
      if (gaps.unbounded.length) {
        lines.push(`- Unbounded in schema: ${gaps.unbounded.length}`);
      }
      if (gaps.orphan.length) {
        lines.push(`- Orphan numeric keys: ${gaps.orphan.length}`);
      }
      lines.push('');
    }
  }

  lines.push('## Heuristic findings (full)', '');
  if (!heuristics.length) lines.push('- None');
  else {
    for (const f of heuristics) {
      lines.push(`- **[${f.severity}]** \`${f.code}\`: ${f.message}`);
    }
  }
  lines.push('');
  if (analysis.calibrationReport?.nudges?.length) {
    lines.push('## Imported calibration nudges', '');
    for (const n of analysis.calibrationReport.nudges) lines.push(`- ${n}`);
    lines.push('');
  }
  lines.push('---', '*Baseline is a starting point, not gospel — use disagreements with other good presets to evolve baseline.*');

  return lines.join('\n');
}

/**
 * @param {object} analysis
 * @returns {object}
 */
export function formatJsonReport(analysis) {
  return analysis;
}

function fmt(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(3);
}

function fmtVal(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(4);
  return String(v);
}

/**
 * @param {string[]} lines
 * @param {string} title
 * @param {Array<{ path: string, delta: number, label?: string }>} items
 */
function appendDeltaList(lines, title, items) {
  if (!items?.length) return;
  lines.push(`**${title}:**`, '');
  for (const d of items.slice(0, 8)) {
    const lab = d.label ? ` (${d.label})` : '';
    lines.push(`- \`${d.path}\`${lab}: Δnorm ${(d.delta * 100).toFixed(1)}%`);
  }
}
