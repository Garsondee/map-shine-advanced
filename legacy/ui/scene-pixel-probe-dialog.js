/**
 * @fileoverview Foundry dialog for compressed Scene Pixel Probe results.
 * @module ui/scene-pixel-probe-dialog
 */

/** @type {Dialog|null} */
let _activeDialog = null;

/**
 * @param {string|null|undefined} v
 * @returns {string}
 */
function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {number|null|undefined} n
 * @param {number} [digits=3]
 * @returns {string}
 */
function fmtNum(n, digits = 3) {
  return Number.isFinite(n) ? Number(n).toFixed(digits) : '—';
}

/**
 * @param {string|null|undefined} classification
 * @returns {string}
 */
function outdoorsBadge(classification) {
  const c = classification ?? 'unknown';
  const label = c === 'outdoor' ? 'Outdoor' : (c === 'indoor' ? 'Indoor' : 'Unknown');
  const bg = c === 'outdoor' ? '#2d5a27' : (c === 'indoor' ? '#3a3a5c' : '#4a4a4a');
  return `<span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${bg};color:#fff;font-size:12px;font-weight:600;">${esc(label)}</span>`;
}

/**
 * Build compressed rows for dialog / clipboard summary.
 * @param {object} report
 * @returns {{ scene: object, comparison: object, rows: object[], plainText: string }}
 */
export function buildScenePixelProbeSummary(report) {
  const scene = report?.scene ?? {};
  const comparison = report?.comparison ?? {};
  const points = Array.isArray(report?.points) ? report.points : [];

  /** @type {object[]} */
  const rows = points.map((pt) => {
    const loc = pt.location ?? {};
    const od = pt.outdoors ?? {};
    const preL = pt.grade?.preGradeHdr?.luma;
    const attr = pt.attribution?.dominant ?? '—';
    const lights = pt.lighting?.foundry?.affectingAtProbe ?? [];
    const lightIds = lights.map((l) => l.id).filter(Boolean).slice(0, 3).join(', ') || '—';
    const topContrib = pt.contributors?.[0];
    const topTile = pt.tiles?.hits?.[0];
    const wl = pt.windowLight?.summary ?? {};
    return {
      label: pt.label ?? '?',
      worldX: loc.worldX,
      worldY: loc.worldY,
      floorIndex: loc.activeFloorIndex,
      outdoorsClassification: od.classification ?? 'unknown',
      effectiveOutdoorStrength: od.effectiveOutdoorStrength,
      effectiveIndoorWeight: od.effectiveIndoorWeight,
      gpuMaskStrength: od.gpuMaskStrength,
      gpuMaskAlpha: od.gpuMaskAlpha,
      maskHasAuthoring: od.maskHasAuthoring,
      preGradeLuma: preL,
      attribution: attr,
      foundryLights: lightIds,
      waterInside: pt.water?.inside,
      topContributor: topContrib ? `${topContrib.id} (${fmtNum(topContrib.luma)})` : '—',
      anomalies: pt.anomalies ?? [],
      topTile: topTile ? `${topTile.id ?? topTile.name ?? 'tile'} …${topTile.textureSrc ?? ''}` : null,
      outdoorsNotes: od.notes ?? [],
      windowLightVerdict: wl.verdict ?? '—',
      windowLightRtLuma: wl.rtLuma,
      windowLightRtMaxLuma: wl.rtMaxLuma,
      windowLightRtMaxAt: wl.rtMaxAt,
      windowLightRenderDiag: wl.renderDiagnostics ?? null,
      windowLightPipeline: wl.pipelineAnalysis ?? wl.summary?.pipelineAnalysis ?? null,
      windowLightBlitDiscard: wl.summary?.blitDiscardReason ?? wl.pipelineAnalysis?.blitSimulation?.discardReason ?? null,
      windowLightBlitEstLuma: wl.summary?.blitEstimatedLuma ?? wl.pipelineAnalysis?.blitSimulation?.estimatedOutputLuma ?? null,
      windowLightRtAtClick: wl.summary?.rtAtClick ?? wl.renderDiagnostics?.rtAtClick ?? null,
      windowLightInteriorExposure: wl.summary?.interiorGradeExposure ?? null,
      windowLightBlockers: wl.blockers ?? [],
      windowLightPrimaryOverlay: wl.primaryOverlay ?? null,
      windowLightHints: wl.hints ?? [],
    };
  });

  const lines = [];
  lines.push(`Scene Pixel Probe — ${scene.name ?? 'scene'} (schema v${report?.schemaVersion ?? '?'})`);
  lines.push(`Hour: ${scene.hour ?? '—'} | Active floor: ${scene.activeFloorIndex ?? '—'} | Visible: [${(scene.visibleFloorIndices ?? []).join(', ')}]`);
  const ranked = comparison.rankedByPreGradeLuma ?? [];
  if (ranked.length) lines.push(`Pre-grade luma rank: ${ranked.join(' > ')}`);
  for (const h of comparison.hypotheses ?? []) lines.push(`• ${h}`);
  lines.push('');
  for (const r of rows) {
    lines.push(`[${r.label}] (${fmtNum(r.worldX, 0)}, ${fmtNum(r.worldY, 0)}) floor ${r.floorIndex ?? '—'}`);
    lines.push(`  Outdoors: ${r.outdoorsClassification} (CC outdoor=${fmtNum(r.effectiveOutdoorStrength)}, indoor=${fmtNum(r.effectiveIndoorWeight)}, GPU R=${fmtNum(r.gpuMaskStrength)} α=${fmtNum(r.gpuMaskAlpha)})`);
    lines.push(`  Pre-grade luma: ${fmtNum(r.preGradeLuma)} | Attribution: ${r.attribution}`);
    lines.push(`  Window light: ${r.windowLightVerdict} | RT luma: ${fmtNum(r.windowLightRtLuma)} | RT max: ${fmtNum(r.windowLightRtMaxLuma)} | Blockers: ${(r.windowLightBlockers?.length ? r.windowLightBlockers.join(', ') : '—')}`);
    if (r.windowLightRtMaxAt && (r.windowLightRtMaxLuma ?? 0) > 0.002) {
      lines.push(`  Window RT peak at u=${fmtNum(r.windowLightRtMaxAt.u)}, v=${fmtNum(r.windowLightRtMaxAt.v)}`);
    }
    const rd = r.windowLightRenderDiag;
    if (rd) {
      const ld = rd.lastDrawStats ?? {};
      const drawPath = (ld.bgMaskBlit ?? 0) > 0 ? `blit×${ld.bgMaskBlit}`
        : ld.bgPerspective ? 'perspective3d'
          : ld.bgOrtho ? 'ortho'
            : (ld.bgFullscreen ?? 0) > 0 ? `fullscreen×${ld.bgFullscreen}`
              : ld.skipReason ? `skipped(${ld.skipReason})` : 'none';
      lines.push(`  Window draw: ${rd.visibleOverlayMeshes ?? '?'}/${rd.totalOverlays ?? '?'} visible, ${rd.maskReadyOverlays ?? '?'} mask-ready, cam=${rd.cameraType ?? '?'}, path=${drawPath}`);
      const snap = rd.uniformSnapshot;
      if (snap?.uSceneOrigin) {
        lines.push(`  Scene bounds: origin=(${fmtNum(snap.uSceneOrigin.x, 0)},${fmtNum(snap.uSceneOrigin.y, 0)}) size=(${fmtNum(snap.uSceneSize?.x, 0)}×${fmtNum(snap.uSceneSize?.y, 0)}) blitShared=${snap.blitSharesSceneUniforms ? 'yes' : 'NO'}`);
      }
      if (r.windowLightRtAtClick) {
        lines.push(`  Window RT@click: luma=${fmtNum(r.windowLightRtAtClick.luma)} rgb=(${fmtNum(r.windowLightRtAtClick.r)},${fmtNum(r.windowLightRtAtClick.g)},${fmtNum(r.windowLightRtAtClick.b)})`);
      }
      if (r.windowLightBlitDiscard) {
        lines.push(`  Blit CPU replay: discard=${r.windowLightBlitDiscard} estLuma=${fmtNum(r.windowLightBlitEstLuma)}`);
      } else if (r.windowLightBlitEstLuma != null) {
        lines.push(`  Blit CPU replay: estLuma=${fmtNum(r.windowLightBlitEstLuma)} (no discard)`);
      }
      const pa = r.windowLightPipeline;
      if (pa?.sceneUvConsistency?.mismatch) {
        lines.push(`  Scene UV mismatch: screen vs world Δu=${fmtNum(pa.sceneUvConsistency.deltaU)} Δv=${fmtNum(pa.sceneUvConsistency.deltaV)}`);
      }
      if (r.windowLightInteriorExposure != null) {
        lines.push(`  Interior CC exposure: ${fmtNum(r.windowLightInteriorExposure)} (crushes final grade even if RT has energy)`);
      }
    }
    if (r.windowLightPrimaryOverlay) {
      const po = r.windowLightPrimaryOverlay;
      lines.push(`  Window overlay: ${po.tileId ?? '?'} f${po.floorIndex ?? '?'} emit=${po.wouldEmit ? 'yes' : 'no'} maskL=${fmtNum(po.maskLuma)} α=${fmtNum(po.maskAlpha)}`);
    }
    for (const h of r.windowLightHints ?? []) lines.push(`  Window hint: ${h}`);
    lines.push(`  Foundry lights: ${r.foundryLights} | Water: ${fmtNum(r.waterInside)} | Top: ${r.topContributor}`);
    if (r.anomalies?.length) lines.push(`  Anomalies: ${r.anomalies.join(', ')}`);
    if (r.outdoorsNotes?.length) lines.push(`  Outdoors notes: ${r.outdoorsNotes.join(', ')}`);
    lines.push('');
  }

  return {
    scene,
    comparison,
    rows,
    plainText: lines.join('\n').trim(),
  };
}

/**
 * @param {object} summary
 * @returns {string}
 */
function buildDialogHtml(summary) {
  const { scene, comparison, rows } = summary;
  const hypotheses = comparison.hypotheses ?? [];
  const ranked = comparison.rankedByPreGradeLuma ?? [];

  let html = `
<div class="ms-scene-pixel-probe-dialog" style="font-size:13px;line-height:1.45;max-height:70vh;overflow:auto;">
  <p style="margin:0 0 8px;"><strong>${esc(scene.name ?? 'Scene')}</strong>
    — hour ${esc(scene.hour)} · floor ${esc(scene.activeFloorIndex)}
    · visible [${esc((scene.visibleFloorIndices ?? []).join(', '))}]</p>`;

  if (ranked.length) {
    html += `<p style="margin:0 0 8px;"><strong>Pre-grade luma:</strong> ${esc(ranked.join(' → '))}</p>`;
  }
  if (hypotheses.length) {
    html += '<ul style="margin:0 0 12px 18px;">';
    for (const h of hypotheses) html += `<li>${esc(h)}</li>`;
    html += '</ul>';
  }

  html += `<table style="width:100%;border-collapse:collapse;margin-bottom:12px;font-size:12px;">
    <thead><tr style="text-align:left;border-bottom:1px solid var(--color-border-light-tertiary,#666);">
      <th style="padding:4px 6px;">Pt</th>
      <th style="padding:4px 6px;">World</th>
      <th style="padding:4px 6px;">Fl</th>
      <th style="padding:4px 6px;">_Outdoors</th>
      <th style="padding:4px 6px;">CC out / in</th>
      <th style="padding:4px 6px;">GPU R·α</th>
      <th style="padding:4px 6px;">Mask</th>
      <th style="padding:4px 6px;">Pre luma</th>
      <th style="padding:4px 6px;">Win light</th>
    </tr></thead><tbody>`;

  for (const r of rows) {
    const maskAuth = r.maskHasAuthoring === true ? 'yes' : (r.maskHasAuthoring === false ? 'no' : '—');
    html += `<tr style="border-bottom:1px solid var(--color-border-light-tertiary,#444);">
      <td style="padding:4px 6px;"><strong>${esc(r.label)}</strong></td>
      <td style="padding:4px 6px;">${fmtNum(r.worldX, 0)}, ${fmtNum(r.worldY, 0)}</td>
      <td style="padding:4px 6px;">${esc(r.floorIndex)}</td>
      <td style="padding:4px 6px;">${outdoorsBadge(r.outdoorsClassification)}</td>
      <td style="padding:4px 6px;">${fmtNum(r.effectiveOutdoorStrength)} / ${fmtNum(r.effectiveIndoorWeight)}</td>
      <td style="padding:4px 6px;">${fmtNum(r.gpuMaskStrength)} · ${fmtNum(r.gpuMaskAlpha)}</td>
      <td style="padding:4px 6px;">${esc(maskAuth)}</td>
      <td style="padding:4px 6px;">${fmtNum(r.preGradeLuma)}</td>
      <td style="padding:4px 6px;" title="${esc((r.windowLightBlockers ?? []).join(', '))}">${esc(r.windowLightVerdict)} · ${fmtNum(r.windowLightRtLuma)} / max ${fmtNum(r.windowLightRtMaxLuma)}</td>
    </tr>`;
  }
  html += '</tbody></table>';

  for (const r of rows) {
    html += `<details style="margin-bottom:6px;">
      <summary style="cursor:pointer;"><strong>${esc(r.label)}</strong> — ${esc(r.attribution)} · win: ${esc(r.windowLightVerdict)} · lights: ${esc(r.foundryLights)}</summary>
      <div style="padding:6px 0 6px 12px;font-size:12px;">
        <div>Top contributor: ${esc(r.topContributor)}</div>
        <div>Window light RT luma: ${fmtNum(r.windowLightRtLuma)} | RT max (grid): ${fmtNum(r.windowLightRtMaxLuma)} | Verdict: ${esc(r.windowLightVerdict)}</div>`;
    if (r.windowLightRenderDiag) {
      const d = r.windowLightRenderDiag;
      html += `<div>Draw path: ${d.visibleOverlayMeshes ?? '?'}/${d.totalOverlays ?? '?'} meshes visible, ${d.maskReadyOverlays ?? '?'} mask-ready, ${d.rtWidth ?? '?'}×${d.rtHeight ?? '?'} RT, cam=${esc(d.cameraType ?? '?')}</div>`;
    }
    if (r.windowLightBlockers?.length) {
      html += `<div>Window blockers: ${esc(r.windowLightBlockers.join(', '))}</div>`;
    }
    if (r.windowLightPrimaryOverlay) {
      const po = r.windowLightPrimaryOverlay;
      html += `<div>Primary overlay: ${esc(po.tileId)} (floor ${esc(po.floorIndex)}) — wouldEmit=${po.wouldEmit ? 'yes' : 'no'}, mask luma=${fmtNum(po.maskLuma)}, α=${fmtNum(po.maskAlpha)}</div>`;
    }
    for (const h of r.windowLightHints ?? []) {
      html += `<div>Window hint: ${esc(h)}</div>`;
    }
    html += `<div>Water inside: ${fmtNum(r.waterInside)}</div>`;
    if (r.topTile) html += `<div>Top tile: ${esc(r.topTile)}</div>`;
    if (r.anomalies?.length) html += `<div>Anomalies: ${esc(r.anomalies.join(', '))}</div>`;
    if (r.outdoorsNotes?.length) html += `<div>Outdoors notes: ${esc(r.outdoorsNotes.join(', '))}</div>`;
    html += '</div></details>';
  }

  html += '</div>';
  return html;
}

/**
 * Close any open probe dialog.
 */
export function closeScenePixelProbeDialog() {
  if (_activeDialog) {
    try { _activeDialog.close(); } catch (_) {}
    _activeDialog = null;
  }
}

/**
 * @param {object} report
 * @returns {Dialog|null}
 */
export function showScenePixelProbeDialog(report) {
  if (!report?.points?.length) return null;
  closeScenePixelProbeDialog();

  const summary = buildScenePixelProbeSummary(report);
  const content = buildDialogHtml(summary);

  const dialog = new Dialog({
    title: 'Scene Pixel Probe',
    content,
    buttons: {
      copyJson: {
        icon: '<i class="fas fa-code"></i>',
        label: 'Copy JSON',
        callback: async () => {
          const { copyScenePixelProbeReport } = await import('../utils/scene-pixel-probe.js');
          const ok = await copyScenePixelProbeReport();
          if (ok) globalThis.ui?.notifications?.info?.('Probe JSON copied to clipboard');
          else globalThis.ui?.notifications?.warn?.('Could not copy JSON');
          return false;
        },
      },
      copySummary: {
        icon: '<i class="fas fa-copy"></i>',
        label: 'Copy summary',
        callback: async () => {
          try {
            await globalThis.navigator.clipboard.writeText(summary.plainText);
            globalThis.ui?.notifications?.info?.('Probe summary copied to clipboard');
          } catch (_) {
            globalThis.ui?.notifications?.warn?.('Could not copy summary');
          }
          return false;
        },
      },
      close: {
        icon: '<i class="fas fa-times"></i>',
        label: 'Close',
      },
    },
    default: 'close',
    close: () => {
      if (_activeDialog === dialog) _activeDialog = null;
    },
  });

  _activeDialog = dialog;
  dialog.render(true);
  return dialog;
}

/**
 * @returns {Dialog|null}
 */
export function showLastScenePixelProbeDialog() {
  const report = globalThis.MapShine?.__lastScenePixelProbeReport ?? null;
  if (!report) {
    globalThis.ui?.notifications?.warn?.('No pixel probe report yet — run Pixel Probe first.');
    return null;
  }
  return showScenePixelProbeDialog(report);
}
