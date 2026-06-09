/**
 * @fileoverview Live diagnostics dialog for Contextual Scene Grade.
 * @module ui/context-grade-debug-dialog
 */

/** @type {Dialog|null} */
let _liveDialog = null;
/** @type {number|null} */
let _liveTimer = null;

/**
 * @returns {import('../core/context-grade/ContextualSceneGradeManager.js').ContextualSceneGradeManager|null}
 */
function resolveManager() {
  return window.MapShine?.contextualSceneGradeManager
    ?? window.MapShine?.floorCompositorV2?._contextualSceneGradeManager
    ?? null;
}

/**
 * @param {object|null} mgr
 * @returns {string}
 */
export function formatContextGradeDiagnosticReport(mgr) {
  if (!mgr || typeof mgr.getDiagnostics !== 'function') {
    return 'Contextual Scene Grade manager is not available.\n\nOpen a scene with Map Shine V2 active and ensure the canvas has finished loading.';
  }
  const d = mgr.getDiagnostics();
  const lines = [];

  lines.push('=== Contextual Scene Grade — Live Diagnostics ===');
  lines.push(`Updated: ${new Date().toLocaleTimeString()}`);
  lines.push('');

  lines.push('[ Effect ]');
  lines.push(`  UI enabled:        ${d.effectEnabled}`);
  lines.push(`  CC overlay active: ${d.contextGradeActive}`);
  lines.push(`  External drive:    ${d.externalDrive} (probing paused during camera path fades)`);
  lines.push('');

  lines.push('[ Subject token ]');
  lines.push(`  Resolved id:       ${d.subjectTokenId || '(none)'}`);
  lines.push(`  Token name:        ${d.subjectTokenName || '(none)'}`);
  lines.push(`  User can probe:    ${d.subjectTokenAllowed}`);
  lines.push(`  Controlled count:  ${d.controlledCount}`);
  lines.push(`  Token animating:   ${d.tokenAnimating}`);
  lines.push(`  Pathfinding move:  ${d.pathfindingActive}`);
  lines.push('');

  lines.push('[ Probe position ]');
  lines.push(`  Foundry center:    ${d.foundryCenter ?? '(unknown)'}`);
  lines.push(`  Floor index:       ${d.floorIndex}`);
  lines.push(`  Move since probe:  ${d.moveSinceProbePx}`);
  lines.push(`  Move gate (px):    ${d.moveGatePx}`);
  lines.push(`  Probe timer:       ${d.probeTimerSec}s / ${d.probeIntervalSec}s`);
  lines.push(`  Last probe age:    ${d.lastProbeAgeSec}s`);
  lines.push(`  Last probe reason: ${d.lastProbeReason || '—'}`);
  lines.push(`  Mask probe status: ${d.maskProbeStatus}`);
  lines.push('');

  lines.push('[ Context dimensions ]');
  const keyLines = String(d.contextKey ?? '—').split('\n').filter((l) => l.length > 0);
  lines.push('  Context key:');
  if (keyLines.length) {
    for (const kl of keyLines) lines.push(`    · ${kl}`);
  } else {
    lines.push('    · —');
  }
  lines.push(`  Env sky:             ${d.envSkyCondition ?? '—'} · ${d.envDayPhase ?? '—'} · ${d.envDarknessMood ?? '—'}`);
  if (d.dimensions) {
    lines.push(`  Outdoor sky:       ${d.dimensions.outdoorSky ?? '—'}`);
    lines.push(`  Cloud shadow:      ${d.dimensions.cloudShadow ?? '—'} (sample ${d.cloudShadowSample ?? '—'})`);
    lines.push(`  Canopy:            ${d.dimensions.canopy ?? '—'} (sky reach ${d.skyReachSample ?? '—'})`);
    lines.push(`  Interior light:    ${d.dimensions.interiorLight ?? '—'} (window ${d.windowLit ? 'lit' : 'no'})`);
    lines.push(`  Cover shadow:      ${d.dimensions.coverShadow ?? '—'} (building ${d.buildingShadowLit ?? '—'}, painted ${d.paintedShadowLit ?? '—'}, tree ${d.treeShadowLit ?? '—'})`);
  }
  lines.push(`  Token outdoor bias:  ${d.tokenOutdoorBias ?? '—'}`);
  lines.push(`  Eye adaptation:      ${d.eyeAdaptationWeight != null ? `${Math.round(d.eyeAdaptationWeight * 100)}% offset` : '—'}`);
  lines.push(`  Sky reach status:    ${d.skyReachStatus ?? '—'}`);
  lines.push(`  Cloud shadow status: ${d.cloudShadowStatus ?? '—'}`);
  lines.push(`  Window lit status:   ${d.windowLitStatus ?? '—'}`);
  lines.push(`  Building shadow:     ${d.buildingShadowStatus ?? '—'}`);
  lines.push(`  Painted shadow:      ${d.paintedShadowStatus ?? '—'}`);
  lines.push(`  Tree shadow:         ${d.treeShadowStatus ?? '—'}`);
  lines.push('');

  lines.push('[ Indoor / Outdoor ]');
  lines.push(`  Raw outdoors sample: ${d.outdoorsSample ?? '—'}  (1=outdoor, 0=indoor)`);
  lines.push(`  Classified:          ${d.classifiedState}`);
  lines.push(`  Target state:        ${d.targetState}`);
  lines.push(`  Transition:          ${d.transitionLabel}`);
  lines.push(`  Thresholds:          outdoor ≥ ${d.outdoorThresholdHigh}, indoor ≤ ${d.indoorThresholdLow}`);
  lines.push('');

  lines.push('[ Applied CC overlay ]');
  lines.push(`  exposure:          ${d.applied.exposure}`);
  lines.push(`  saturation:        ${d.applied.saturation}`);
  lines.push(`  brightness:        ${d.applied.brightness}`);
  lines.push(`  contrast:          ${d.applied.contrast}`);
  lines.push(`  vignetteStrength:  ${d.applied.vignetteStrength}`);
  lines.push('');

  lines.push('[ CC runtime (ColorCorrectionEffectV2) ]');
  lines.push(`  contextGradeEnabled: ${d.cc.contextGradeEnabled}`);
  lines.push(`  contextExposure:     ${d.cc.contextExposure}`);
  lines.push(`  contextSaturation:   ${d.cc.contextSaturation}`);
  lines.push(`  contextVignette:     ${d.cc.contextVignetteStrength}`);
  lines.push(`  spatialEnabled:    ${d.cc.contextSpatialEnabled}`);
  lines.push(`  spatialStrength:   ${d.cc.contextSpatialStrength}`);
  lines.push(`  tokenOutdoorBias:  ${d.cc.contextTokenOutdoorBias}`);
  lines.push(`  treeDappleEnabled: ${d.cc.contextTreeDappleEnabled}`);
  lines.push(`  treeDappleStrength:${d.cc.contextTreeDappleStrength}`);
  lines.push('');

  if (Array.isArray(d.blockers) && d.blockers.length > 0) {
    lines.push('[ Blockers / hints ]');
    for (const b of d.blockers) lines.push(`  • ${b}`);
    lines.push('');
  }

  lines.push('[ Quick checks ]');
  lines.push('  • Outdoors sample "—" → _Outdoors mask missing or not synced for this floor.');
  lines.push('  • subject id "(none)" → select a token you own (controlled).');
  lines.push('  • CC overlay active "no" → enable effect + select subject token.');
  lines.push('  • Raw sample stuck ~1.0 indoors → check _Outdoors art (dark = indoor).');

  return lines.join('\n');
}

function _stopLiveRefresh() {
  if (_liveTimer != null) {
    clearInterval(_liveTimer);
    _liveTimer = null;
  }
}

/**
 * @param {string} taId
 */
function _paintDiagnosticsTextarea(taId) {
  const el = document.getElementById(taId);
  if (!el) return;
  el.value = formatContextGradeDiagnosticReport(resolveManager());
}

/**
 * Open a live-updating diagnostics dialog.
 */
export function openContextGradeDebugDialog() {
  _stopLiveRefresh();

  const taId = `ms-context-grade-diag-${Date.now()}`;
  const content = `
    <p class="notes" style="margin:0 0 8px">
      Live readout of token position, <code>_Outdoors</code> sampling, state machine, and CC overlay.
      Updates while this window is open.
    </p>
    <textarea id="${taId}" readonly spellcheck="false"
      style="width:100%;height:min(480px,62vh);resize:vertical;font-family:monospace;font-size:12px;padding:8px;box-sizing:border-box"></textarea>
  `;

  _liveDialog = new Dialog({
    title: 'Contextual Scene Grade — Diagnostics',
    content,
    buttons: {
      refresh: {
        icon: '<i class="fas fa-sync"></i>',
        label: 'Refresh now',
        callback: () => {
          _paintDiagnosticsTextarea(taId);
          return false;
        },
      },
      close: {
        icon: '<i class="fas fa-times"></i>',
        label: 'Close',
        callback: () => {
          _stopLiveRefresh();
          _liveDialog = null;
          return true;
        },
      },
    },
    default: 'close',
    close: () => {
      _stopLiveRefresh();
      _liveDialog = null;
    },
  }, { width: 560 });

  _liveDialog.render(true);
  _paintDiagnosticsTextarea(taId);
  _liveTimer = setInterval(() => _paintDiagnosticsTextarea(taId), 400);
}
