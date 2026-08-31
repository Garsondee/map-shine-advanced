/**
 * tile-motion-runtime.test.mjs — the LIVE half's no-Foundry guard clauses,
 * same posture as scene-doors.test.mjs: Node genuinely has neither `canvas`
 * nor `Hooks` nor `game`, so every "no active scene / not in Foundry" path is
 * exercised for real here. Actual document reads/writes/hook behavior are
 * browser-verified (this module's own header explains why: persistence
 * needs a live Tile/Scene document, which Node cannot fabricate honestly).
 */
import {
  readTileMotionConfigRaw,
  writeTileMotionConfig,
  readTransportStateRaw,
  writeTransportState,
  watchTransportState,
  watchTileMotionConfigs,
  initializeTileMotionRuntime,
  disposeTileMotionRuntime,
  resolveTileMotionFrame,
  setTileEditSuppressed,
  getTileMotionTileList,
  getTileMotionConfig,
  getTileMotionTransportState,
  getTileMotionRuntimeStatus,
  getTileMotionSummary,
  setTileMotionConfig,
  startTileMotion,
  stopTileMotion,
  pauseTileMotion,
  resumeTileMotion,
  resetTileMotionPhase,
  setTileMotionSpeedPercent,
  setTileMotionTimeFactorPercent,
  setTileMotionAutoPlayEnabled,
} from '../tile-motion-runtime.js';

export async function run(t) {
  const { ok } = t;

  ok('readTileMotionConfigRaw(null) never throws, returns null', readTileMotionConfigRaw(null) === null);
  ok('readTransportStateRaw() with no canvas returns null, not throw', readTransportStateRaw() === null);

  const writeTileResult = await writeTileMotionConfig('nope', {});
  ok(
    'writeTileMotionConfig with no active scene reports ok:false with a reason',
    writeTileResult.ok === false && typeof writeTileResult.reason === 'string'
  );

  const writeTransportResult = await writeTransportState({});
  ok(
    'writeTransportState with no active scene reports ok:false with a reason',
    writeTransportResult.ok === false && typeof writeTransportResult.reason === 'string'
  );

  const unwatch1 = watchTransportState(() => {});
  ok('watchTransportState with no Hooks global returns a callable no-op unsubscribe', typeof unwatch1 === 'function');
  unwatch1();

  const unwatch2 = watchTileMotionConfigs(() => {});
  ok(
    'watchTileMotionConfigs with no Hooks global returns a callable no-op unsubscribe',
    typeof unwatch2 === 'function'
  );
  unwatch2();

  ok(
    'initializeTileMotionRuntime does not throw with no Foundry environment',
    (() => {
      initializeTileMotionRuntime();
      return true;
    })()
  );

  ok(
    'getTileMotionTileList with no scene returns an empty array, not throw',
    Array.isArray(getTileMotionTileList()) && getTileMotionTileList().length === 0
  );

  const defaultCfg = getTileMotionConfig('missing-tile');
  ok(
    'getTileMotionConfig for an unknown tile returns a valid normalized default',
    defaultCfg.enabled === false && defaultCfg.mode === 'transform'
  );

  const transport = getTileMotionTransportState();
  ok(
    'getTileMotionTransportState returns a valid normalized transport',
    transport.playing === false && transport.speedPercent === 100
  );

  const status = getTileMotionRuntimeStatus('missing-tile');
  ok("an unconfigured tile's status is 'disabled'", status.status === 'disabled');
  ok("getTileMotionRuntimeStatus('') is 'unknown', not a throw", getTileMotionRuntimeStatus('').status === 'unknown');

  const summary = getTileMotionSummary();
  ok(
    'getTileMotionSummary on an empty scene reports zero tiles',
    summary.totalTileCount === 0 && summary.enabledCount === 0
  );

  ok('resolveTileMotionFrame returns an empty Map with nothing configured', resolveTileMotionFrame().size === 0);

  ok(
    'setTileEditSuppressed does not throw either way',
    (() => {
      setTileEditSuppressed(true);
      setTileEditSuppressed(false);
      return true;
    })()
  );

  // Every mutation is GM-permission-gated; with no `game` global at all,
  // every one of them must degrade cleanly, never throw. `pause`/`resume`
  // short-circuit to ok:true BEFORE the permission check when they're
  // already a no-op (not playing / not paused) — everything else must hit
  // the gate and report ok:false.
  const gatedMutations = [
    ['setTileMotionConfig', () => setTileMotionConfig('x', { enabled: true })],
    ['startTileMotion', () => startTileMotion()],
    ['stopTileMotion', () => stopTileMotion()],
    ['resetTileMotionPhase', () => resetTileMotionPhase()],
    ['setTileMotionSpeedPercent', () => setTileMotionSpeedPercent(200)],
    ['setTileMotionTimeFactorPercent', () => setTileMotionTimeFactorPercent(150)],
    ['setTileMotionAutoPlayEnabled', () => setTileMotionAutoPlayEnabled(false)],
  ];
  for (const [name, fn] of gatedMutations) {
    const result = await fn();
    ok(`${name} with no Foundry environment reports ok:false rather than throwing`, result?.ok === false);
  }
  ok(
    'pauseTileMotion on already-stopped playback is a harmless no-op (ok:true)',
    (await pauseTileMotion())?.ok === true
  );
  ok(
    'resumeTileMotion on already-stopped playback is a harmless no-op (ok:true)',
    (await resumeTileMotion())?.ok === true
  );

  ok(
    'disposeTileMotionRuntime does not throw',
    (() => {
      disposeTileMotionRuntime();
      return true;
    })()
  );
}
