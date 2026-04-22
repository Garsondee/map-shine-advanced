/**
 * Metadata-only stack findings (Phase 1 — no GPU readback).
 *
 * @module core/diagnostics/RenderStackRules
 */

/**
 * @param {object} stack - result of captureRenderStack()
 * @returns {object[]}
 */
export function evaluateRenderStackFindings(stack) {
  const findings = [];
  if (!stack || !stack.windowLightMeta) return findings;

  const wl = stack.windowLightMeta;
  const bus = stack.busMeta;
  const rt = stack.runtime || {};

  findings.push({
    ruleId: 'stack:windowLightNotBelowBusAlbedo',
    severity: 'info',
    message:
      'WindowLightEffectV2 contributes inside LightingEffectV2 (lightRT), not as geometry under bus albedo. Final lit pixels use albedo × illumination.',
    evidence: { composeNote: wl.composeNote },
  });

  if (wl.sortObjects === true) {
    findings.push({
      ruleId: 'stack:windowSceneSortObjectsTrue',
      severity: 'warn',
      message:
        'WindowLightScene has sortObjects=true — transparent additive overlays may reorder by camera distance each frame; upper/lower floor stacks can flicker or fight.',
      evidence: { sortObjects: wl.sortObjects },
    });
  } else if (wl.sortObjects === false) {
    findings.push({
      ruleId: 'stack:windowSceneSortStable',
      severity: 'info',
      message: 'WindowLightScene.sortObjects=false — draw order follows scene graph + renderOrder (recommended).',
      evidence: { sortObjects: wl.sortObjects },
    });
  }

  const floors = Object.keys(wl.byFloor || {}).sort((a, b) => {
    const na = Number(String(a).replace(/^floor:/, '')) || 0;
    const nb = Number(String(b).replace(/^floor:/, '')) || 0;
    return na - nb;
  });
  if (floors.length >= 2) {
    let prevMax = -Infinity;
    let monotonic = true;
    for (const k of floors) {
      const b = wl.byFloor[k];
      if (b.count > 0 && b.minRenderOrder < prevMax) monotonic = false;
      prevMax = Math.max(prevMax, b.maxRenderOrder);
    }
    if (!monotonic) {
      findings.push({
        ruleId: 'stack:windowRenderOrderNonMonotonic',
        severity: 'warn',
        message: 'Window overlay renderOrder ranges overlap across floors — stacked footprints may blend in wrong order.',
        evidence: { byFloor: wl.byFloor },
      });
    }
  }

  const active = Number(rt.activeFloor ?? 0);
  const key = `floor:${active}`;
  const cur = wl.byFloor?.[key];
  if (cur && cur.count > 0 && cur.visibleCount === 0) {
    findings.push({
      ruleId: 'stack:windowOverlaysHiddenForActiveFloor',
      severity: 'warn',
      message: `Active floor ${active} has window overlays but none are visible (check onFloorChange / maxFloor).`,
      evidence: { activeFloor: active, byFloor: wl.byFloor },
    });
  }

  const inv = Array.isArray(wl.overlayList) ? wl.overlayList : [];
  const tileRows = inv.filter((o) => o?.tileId && o.tileId !== '__bg_image__');
  if (active >= 1 && tileRows.length > 0) {
    const onActive = tileRows.filter((o) => Number(o.floorIndex) === active);
    if (onActive.length === 0) {
      findings.push({
        ruleId: 'stack:windowLightUpperFloorOverlayGap',
        severity: 'warn',
        message:
          `Active floor is ${active} but no window-light tile overlays report floorIndex ${active} — check Levels tile floor classification vs window overlay rebuild.`,
        evidence: { activeFloor: active, tileOverlayCount: tileRows.length, overlaySample: tileRows.slice(0, 8) },
      });
    }
  }
  if (active >= 1 && tileRows.length >= 2) {
    const allZero = tileRows.every((o) => Number(o.floorIndex) === 0);
    if (allZero) {
      findings.push({
        ruleId: 'stack:windowLightAllOverlaysFloor0',
        severity: 'info',
        message:
          'All window-light tile overlays are classified as floor 0 while a higher floor is active — upper-floor glow may be missing or mis-layered.',
        evidence: { activeFloor: active, tileOverlayCount: tileRows.length },
      });
    }
  }

  if (bus?.floorDepthBlurPath) {
    findings.push({
      ruleId: 'stack:floorDepthBlurActive',
      severity: 'info',
      message: 'FloorDepthBlurEffect path is active — below-active floors are blurred into sceneRT before lighting; can change perceived sharpness vs raw bus.',
      evidence: { visibleMaxFloorIndex: bus.visibleMaxFloorIndex },
    });
  }

  return findings;
}
