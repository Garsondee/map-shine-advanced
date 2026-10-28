/**
 * crash-guard.test.mjs — the storage-facing half of the crash ladder
 * (2026-10-27, epic mmp-fpu). Fake storage, fake clock, fake timers: no
 * browser, and no real waiting.
 */
import { CRASH_GUARD_KEY, createCrashGuard } from '../crash-guard.js';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, STABLE_AFTER_MS } from '../../core/safe-mode.js';

function rig({ storage: given, startMs = 5_000_000 } = {}) {
  const data = new Map();
  const storage =
    given === undefined
      ? {
          getItem: (k) => (data.has(k) ? data.get(k) : null),
          setItem: (k, v) => void data.set(k, String(v)),
          removeItem: (k) => void data.delete(k),
        }
      : given;
  let nowMs = startMs;
  const timers = new Map();
  let nextId = 1;
  const listeners = new Map();
  const win = { addEventListener: (type, fn) => listeners.set(type, fn) };
  const deps = {
    storage,
    now: () => nowMs,
    setTimer: (fn, ms) => (timers.set(nextId, { fn, ms, every: true }), nextId++),
    clearTimer: (h) => timers.delete(h),
    setOnce: (fn, ms) => (timers.set(nextId, { fn, ms, every: false }), nextId++),
    clearOnce: (h) => timers.delete(h),
    win,
  };
  const guard = createCrashGuard(deps);
  const stored = () => {
    const text = storage?.getItem?.(CRASH_GUARD_KEY);
    return text ? JSON.parse(text) : null;
  };
  return {
    guard,
    data,
    stored,
    listeners,
    timers,
    advance: (ms) => void (nowMs += ms),
    /** Fire every timer whose period/delay is <= ms (heartbeats and one-shots). */
    fire: (ms) => {
      for (const [id, tm] of [...timers]) {
        if (tm.ms <= ms) {
          if (!tm.every) timers.delete(id);
          tm.fn();
        }
      }
    },
    /** A second page load against the same storage, on the same clock. */
    reload: () => rig({ storage, startMs: nowMs }).guard,
    storage,
  };
}

export function run(t) {
  const { ok } = t;

  // ── A FIRST LOAD ─────────────────────────────────────────────────────────
  {
    const r = rig();
    const d = r.guard.start({ mode: 'auto', build: 'b1', scene: 'mansion' });
    ok('first load: full quality', d.level === 0 && d.profile.name === 'full' && d.message === '');
    ok(
      'it records `booting` before anything else happens',
      r.stored()?.state === 'booting' && r.stored()?.scene === 'mansion'
    );
    ok(
      'and starts a heartbeat',
      [...r.timers.values()].some((x) => x.every && x.ms === HEARTBEAT_INTERVAL_MS)
    );
    r.advance(1500);
    r.fire(HEARTBEAT_INTERVAL_MS);
    ok('the heartbeat refreshes the record', r.stored()?.heartbeatAt === 5_001_500);
    ok('a clean unload handler is installed', typeof r.listeners.get('pagehide') === 'function');
  }

  // ── SURVIVING MAKES IT STABLE ────────────────────────────────────────────
  {
    const r = rig();
    r.guard.start({ build: 'b1' });
    r.guard.armStable();
    ok('stable is armed, not immediate', r.stored()?.state === 'booting');
    r.advance(STABLE_AFTER_MS);
    r.fire(STABLE_AFTER_MS);
    ok('after the quiet period the load is stable', r.stored()?.state === 'stable' && r.stored()?.consecutive === 0);
    ok('the heartbeat stops once stable', ![...r.timers.values()].some((x) => x.every));
  }

  // ── A LOSS CLIMBS THE LADDER ON THE NEXT LOAD, WITH THE EVIDENCE ─────────
  {
    const r = rig();
    r.guard.start({ build: 'b1' });
    r.guard.noteCompileStart('c1', 'candle-light:merged', 120_000);
    r.guard.noteCompileStart('c2', 'vegetation:tree', 30_000);
    ok('a compile is written to storage BEFORE it can hang the GPU', r.stored()?.inFlight.length === 2);
    ok('the biggest shader is listed first', r.stored()?.inFlight[0].label === 'candle-light:merged');
    r.guard.noteCompileEnd('c2');
    ok('a finished compile leaves the list', r.stored()?.inFlight.length === 1);
    r.guard.recordLoss({ message: 'A valid external Instance reference no longer exists.', reason: 'unknown' });
    ok(
      'the loss is persisted with what was compiling',
      r.stored()?.state === 'lost' && r.stored()?.lastLoss?.inFlight[0].label === 'candle-light:merged'
    );
    r.advance(1000);
    const next = r.reload().start({ build: 'b1' });
    ok('the next load starts one rung higher', next.level === 1 && next.profile.candleMemory === false);
    ok('it explains itself', /graphics card stopped responding/.test(next.message));
    ok('and carries the evidence', next.evidence?.inFlight[0]?.label === 'candle-light:merged');
  }

  // ── A LATE "STABLE" TIMER CANNOT HIDE A LOSS ─────────────────────────────
  {
    const r = rig();
    r.guard.start({ build: 'b1' });
    r.guard.armStable();
    r.guard.recordLoss({ message: 'lost' });
    r.advance(STABLE_AFTER_MS);
    r.fire(STABLE_AFTER_MS);
    ok('the stable timer was cancelled by the loss', r.stored()?.state === 'lost');
  }

  // ── A CLEAN RELOAD IS NOT A CRASH ────────────────────────────────────────
  {
    const r = rig();
    r.guard.start({ build: 'b1' });
    r.listeners.get('pagehide')();
    ok('pagehide mid-boot is recorded as `interrupted`', r.stored()?.state === 'interrupted');
    r.advance(HEARTBEAT_STALE_MS * 5);
    ok('...and the next load does not climb', r.reload().start({ build: 'b1' }).level === 0);
  }

  // ── A TAB THAT VANISHED IS A CRASH ───────────────────────────────────────
  {
    const r = rig();
    r.guard.start({ build: 'b1' }); // never stable, never unloaded: the tab died
    r.advance(HEARTBEAT_STALE_MS + 500);
    ok('(sanity) the record the dead tab left was `booting`', r.stored()?.state === 'booting');
    const next = r.reload().start({ build: 'b1' });
    ok('a booting record with a silent heartbeat climbs the ladder', next.level === 1 && next.reason === 'crash');
  }

  // ── THE LAST RUNG IS A SETTLED FACT, NOT A BOOT ──────────────────────────
  {
    const r = rig();
    for (let i = 0; i < 3; i++) {
      r.guard.start({ build: 'b1' });
      r.guard.recordLoss({ message: 'lost' });
    }
    const last = r.reload().start({ build: 'b1' });
    ok('three losses reach the foundry rung', last.level === 3 && !last.profile.startMsa);
    ok('MSA is not started, so there is no heartbeat to go stale', ![...r.timers.values()].some((x) => x.every));
    ok(
      'the rung is recorded as settled so the next boot carries it',
      r.stored()?.state === 'stable' && r.stored()?.level === 3
    );
    r.advance(HEARTBEAT_STALE_MS * 10);
    ok('and does not climb past the top on the following boot', r.reload().start({ build: 'b1' }).level === 3);
  }

  // ── THE PLAYER'S ESCAPE HATCHES ──────────────────────────────────────────
  {
    const r = rig();
    r.guard.start({ build: 'b1' });
    r.guard.recordLoss({ message: 'lost' });
    ok('mode=off ignores the record', r.reload().start({ mode: 'off', build: 'b1' }).level === 0);
    r.guard.reset();
    ok(
      'reset forgets everything',
      r.data.has(CRASH_GUARD_KEY) === false && r.reload().start({ build: 'b1' }).level === 0
    );
  }

  // ── STORAGE THAT MISBEHAVES NEVER BREAKS THE BOOT ────────────────────────
  {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const r = rig({ storage: throwing });
    let threw = false;
    let d;
    try {
      d = r.guard.start({ build: 'b1' });
      r.guard.noteCompileStart('x', 'thing', 10);
      r.guard.noteCompileEnd('x');
      r.guard.armStable();
      r.guard.recordLoss({ message: 'lost' });
      r.guard.reset();
      r.guard.status();
    } catch (_) {
      threw = true;
    }
    ok('a store that throws on every call never throws out of the guard', !threw && d?.level === 0);
    const none = rig({ storage: null });
    let threw2 = false;
    try {
      none.guard.start({ build: 'b1' });
      none.guard.recordLoss({ message: 'x' });
    } catch (_) {
      threw2 = true;
    }
    ok('no storage at all degrades to "no memory"', !threw2);
    const corrupt = rig();
    corrupt.data.set(CRASH_GUARD_KEY, '{not json');
    ok('a corrupt record reads as a clean first run', corrupt.reload().start({ build: 'b1' }).level === 0);
  }

  // ── WHAT THE CONSOLE SEES ────────────────────────────────────────────────
  {
    const r = rig();
    r.guard.start({ build: 'b1' });
    r.guard.noteCompileStart('a', 'one', 5);
    const s = r.guard.status();
    ok(
      'status reports the record, the decision and what is compiling',
      s.record.state === 'booting' && s.decision?.level === 0 && s.inFlight[0].label === 'one'
    );
  }
}
