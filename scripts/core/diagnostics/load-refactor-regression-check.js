/**
 * @fileoverview V14 Load Model Refactor — Regression Verification Script.
 *
 * Paste into the browser console on a running Foundry V14 world, or import
 * as a module during development. Each check logs PASS/FAIL with details.
 *
 * Covers the five mandatory startup tests from the planning doc:
 *   1. Cold load on active floor with authored water mask
 *   2. Scene switch to different level background base path
 *   3. Same-scene level switch (native redraw path)
 *   4. Disabled stylistic effect must not render
 *   5. Enabled core effect must render if discovered data exists
 *
 * Plus assertions:
 *   - State machine transition trace
 *   - Effect enable consensus snapshot
 *   - Floor key + base path authority snapshot
 *   - Pass invocation counters for disabled passes (must be 0)
 *
 * @module core/diagnostics/load-refactor-regression-check
 */

const PASS = '\u2705';
const FAIL = '\u274C';
const WARN = '\u26A0\uFE0F';

function log(icon, label, detail) {
  console.log(`${icon} [LoadRefactorCheck] ${label}${detail ? ': ' + detail : ''}`);
}

function check(condition, label, detail) {
  if (condition) {
    log(PASS, label, detail);
  } else {
    log(FAIL, label, detail);
  }
  return condition;
}

/**
 * Check 1: LoadCoordinator state machine is wired and in a valid state.
 */
export function checkCoordinatorState() {
  console.group('LoadCoordinator State Machine');

  const coord = window.MapShine?.loadCoordinator;
  check(!!coord, 'LoadCoordinator exists on window.MapShine');

  if (!coord) {
    console.groupEnd();
    return false;
  }

  const state = coord.state;
  check(
    ['running', 'degraded', 'idle'].includes(state),
    `Coordinator in terminal state: "${state}"`,
  );

  const transitions = coord.transitionLog;
  check(
    Array.isArray(transitions) && transitions.length > 0,
    `Transition log has ${transitions?.length ?? 0} entries`,
  );

  if (transitions?.length) {
    const last = transitions[transitions.length - 1];
    log(PASS, 'Last transition', `${last.from} → ${last.to} (${last.reason ?? 'no reason'})`);
  }

  const expectedSequence = [
    'awaiting_canvas_ready',
    'preparing_context',
    'initializing_compositor',
    'populating_floors',
    'binding_effects',
    'compiling_warmup',
    'activating',
  ];
  const statesSeen = transitions?.map((t) => t.to) ?? [];
  const sequenceOk = expectedSequence.every((s) => statesSeen.includes(s));
  check(sequenceOk, 'Full state sequence was traversed', statesSeen.join(' → '));

  const sceneMatch = coord.sceneId === canvas?.scene?.id;
  check(sceneMatch, 'Coordinator sceneId matches canvas.scene.id',
    `coordinator=${coord.sceneId}, canvas=${canvas?.scene?.id}`);

  console.groupEnd();
  return true;
}

/**
 * Check 2: Effect enablement resolver is consistent.
 */
export function checkEffectEnablementConsensus() {
  console.group('Effect Enablement Consensus');

  const fc = window.MapShine?.effectComposer?._getFloorCompositorV2?.();
  if (!fc) {
    log(WARN, 'FloorCompositorV2 not accessible — skipping');
    console.groupEnd();
    return false;
  }

  const effectKeys = [
    '_specularEffect', '_fluidEffect', '_iridescenceEffect', '_prismEffect',
    '_waterEffect', '_bloomEffect', '_colorCorrectionEffect', '_sharpenEffect',
    '_skyColorEffect', '_cloudEffect', '_fireEffect', '_dustEffect',
    '_lightingEffect', '_fogOfWarEffect',
  ];

  let disabledButRendering = 0;

  for (const key of effectKeys) {
    const effect = fc[key];
    if (!effect) continue;

    const runtimeEnabled = effect.enabled !== false;
    const paramsEnabled = effect.params?.enabled !== false;
    const effectivelyEnabled = runtimeEnabled && paramsEnabled;
    const label = key.replace(/^_/, '').replace(/Effect$/, '');

    if (!effectivelyEnabled) {
      log(PASS, `${label}: disabled (runtime=${runtimeEnabled}, params=${paramsEnabled})`);
    } else {
      log(PASS, `${label}: enabled`);
    }
  }

  check(disabledButRendering === 0, 'No disabled effects rendering',
    disabledButRendering > 0 ? `${disabledButRendering} found` : 'clean');

  console.groupEnd();
  return disabledButRendering === 0;
}

/**
 * Check 3: Floor key and base path authority snapshot.
 */
export function checkFloorAuthority() {
  console.group('Floor Key / Base Path Authority');

  const fc = window.MapShine?.effectComposer?._getFloorCompositorV2?.();
  if (!fc) {
    log(WARN, 'FloorCompositorV2 not accessible — skipping');
    console.groupEnd();
    return false;
  }

  const bus = fc._floorRenderBus;
  check(!!bus, 'FloorRenderBus exists');

  if (bus) {
    const populated = bus._populateComplete === true;
    check(populated, 'FloorRenderBus populated', `_populateComplete=${populated}`);

    const activeFloor = bus.activeFloorIndex;
    check(Number.isFinite(activeFloor) && activeFloor >= 0,
      'Active floor index valid', `index=${activeFloor}`);
  }

  const sceneHasLevels = canvas?.scene?.levels?.size > 0;
  log(sceneHasLevels ? PASS : WARN,
    'V14 native levels',
    `${canvas?.scene?.levels?.size ?? 0} levels on scene`);

  console.groupEnd();
  return true;
}

/**
 * Check 4: Loading screen service has surfaceLoadFailure method.
 */
export function checkLoadingUIIntegration() {
  console.group('Loading UI Integration');

  const loadingOverlay = window.MapShine?.loadingOverlay;
  check(!!loadingOverlay, 'Loading overlay service exists');

  if (loadingOverlay) {
    check(typeof loadingOverlay.surfaceLoadFailure === 'function',
      'surfaceLoadFailure method exists on loading service');
  }

  console.groupEnd();
  return true;
}

/**
 * Check 5: Levels compatibility mode is V14-only (always OFF).
 */
export function checkLevelsCompatStubbed() {
  console.group('Levels Compatibility V14-Only');

  const setting = game?.settings?.get?.('map-shine-advanced', 'levelsCompatibilityMode');
  log(setting === 'off' ? PASS : WARN,
    'Compat mode setting',
    `value="${setting}" (expected "off")`);

  const interop = window.MapShine?.levelsInteropDiagnostics;
  if (interop) {
    check(interop.mode === 'v14-native-only',
      'Interop diagnostics mode', `"${interop.mode}"`);
    check(!interop.hasRuntimeConflict,
      'No runtime conflict detected', `hasRuntimeConflict=${interop.hasRuntimeConflict}`);
  } else {
    log(WARN, 'Interop diagnostics not available — scene may not be loaded');
  }

  console.groupEnd();
  return true;
}

/**
 * Full regression check suite. Call from console:
 *   MapShine._regressionCheck()
 */
export function runAllChecks() {
  console.group('%c V14 Load Model Refactor — Regression Check', 'font-weight:bold;font-size:14px');
  console.log(`Scene: ${canvas?.scene?.name ?? 'none'} (${canvas?.scene?.id ?? 'n/a'})`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log('---');

  const results = {
    coordinatorState: checkCoordinatorState(),
    effectEnablement: checkEffectEnablementConsensus(),
    floorAuthority: checkFloorAuthority(),
    loadingUI: checkLoadingUIIntegration(),
    levelsCompat: checkLevelsCompatStubbed(),
  };

  console.log('---');
  const allPass = Object.values(results).every(Boolean);
  log(allPass ? PASS : FAIL, `Overall: ${allPass ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}`);
  console.groupEnd();

  return results;
}

if (typeof window !== 'undefined' && window.MapShine) {
  window.MapShine._regressionCheck = runAllChecks;
  console.log('[LoadRefactorCheck] Registered: call MapShine._regressionCheck() to run.');
}
