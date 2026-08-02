/**
 * lightning-subsystem.test.mjs — THE TIER GATES + forceStrike(), driven
 * through the REAL `sync()` entry point with a REAL THREE (same doctrine as
 * `lighting/__tests__/sun-occlusion-render.test.mjs`: TSL graphs construct
 * fine in plain Node, so there is no reason to fake THREE here when the real
 * module proves the whole path — schedule → spawn → material/geometry build —
 * actually runs clean, not just the pure math in isolation).
 *
 * WHAT THIS FILE EXISTS FOR: the tier-ladder gating bug (branching/flash ran
 * unconditionally off raw param values, with nothing reading `perfTier` at
 * all) had NO test watching it before the fix — every other lightning suite
 * calls `generateBurst`/`computeOutsideFlashSignal` directly, bypassing
 * `lightning-subsystem.js` entirely, so a regression here would pass every
 * other suite silently. `forceStrike()` gets the same treatment since the
 * Shader Lab driver and boot.js's debug action both depend on its exact
 * fast-forward contract.
 *
 * The origin-flash light's OWN tier-3 gate lives in `point-light-pool.js`,
 * which has no Node test at all (it imports `foundry/index.js` directly, not
 * injected — a much bigger, browser-only integration surface, matching every
 * other render/integration module's boundary in this codebase). That gate is
 * left to live Shader Lab / Foundry verification, not faked here.
 */
import * as THREE from '../../vendor/three/three.webgpu.js';
import { createLightningSubsystem } from '../lightning-subsystem.js';
import { LIGHTNING_PARAMS } from '../lightning.js';

/** The REAL production defaults, read from the schema itself — never a
 * hand-copied snapshot that can quietly drift from effects/lightning.js. */
const DEFAULT_PARAMS = Object.freeze(
  Object.fromEntries(Object.entries(LIGHTNING_PARAMS).map(([k, v]) => [k, v.default]))
);

function makeAnchors(linkId = 'bolt-1') {
  return [
    { id: 'a-start', x: 0, y: 0, params: { role: 'start', linkId, intensity: 1 } },
    { id: 'a-end', x: 500, y: 0, params: { role: 'end', linkId, intensity: 1 } },
  ];
}

/** A fresh subsystem + its own mutable render-state (so a test can flip
 * `state.perfTier` mid-run and have the very next sync() see it, mirroring
 * how boot.js's real getLightningRenderState reads live settings). */
function makeSubsystem(overrides = {}) {
  const uGlobalTimeMs = THREE.TSL.uniform(THREE.TSL.float(0));
  const state = { enabled: true, params: DEFAULT_PARAMS, perfTier: 0, anchors: makeAnchors(), ...overrides };
  const sub = createLightningSubsystem({ THREE, uGlobalTimeMs, getLightningRenderState: () => state });
  return { sub, state };
}

export function run(t) {
  const { ok } = t;

  // ── forceStrike() ─────────────────────────────────────────────────────
  {
    const { sub } = makeSubsystem();
    let threw = false;
    try {
      sub.forceStrike();
    } catch {
      threw = true;
    }
    ok('forceStrike is a safe no-op with no tracked schedules yet (nothing has synced)', !threw);

    sub.sync(0); // establishes the source's schedule; its first burst is staggered into the future
    ok(
      'nothing has spawned yet on the very first sync (V2s own staggered first-burst delay)',
      sub.activeStrands().length === 0
    );

    sub.forceStrike();
    sub.sync(1);
    ok('forceStrike makes the very next sync() spawn immediately', sub.activeStrands().length > 0);
  }

  // ── TIER 0 ('strike'): branching forced off, regardless of branchChance/branchMax ──
  {
    const { sub } = makeSubsystem({ perfTier: 0 });
    sub.sync(0);
    sub.forceStrike();
    sub.sync(1);
    const strands = sub.activeStrands();
    ok(
      'tier 0 spawned a main strand',
      strands.some((s) => !s.isBranch)
    );
    ok(
      'tier 0 (below branching) produces NO branches even at the default branchChance=1/branchMax=6',
      strands.every((s) => !s.isBranch)
    );
  }

  // ── TIER 1+ ('branching'): branches allowed ─────────────────────────────
  {
    const { sub } = makeSubsystem({ perfTier: 1 });
    sub.sync(0);
    sub.forceStrike();
    sub.sync(1);
    const strands = sub.activeStrands();
    ok(
      'tier 1+ produces at least one branch at the default branchChance=1/branchMax=6 (deterministic: randFloat()<1 always holds)',
      strands.some((s) => s.isBranch)
    );
  }

  // ── TIER <2: the outside flash signal stays silent through a connect ────
  {
    const { sub } = makeSubsystem({ perfTier: 1 });
    sub.sync(0);
    sub.forceStrike();
    sub.sync(1); // spawns the burst at spawnMs=1
    // leaderFrac is randomized within [0.12, 0.20] of strikeDurationMs=1000ms
    // (generateBurst's own band around leaderFraction's default 0.15), so
    // +300ms is comfortably past the leader phase for every possible draw.
    sub.sync(1 + 300);
    sub.sync(1 + 320);
    ok(
      'below tier 2 (flash), the outside flash signal stays at 0 through a connect — never silently computed for nobody',
      sub.outsideFlash01() === 0
    );
  }

  // ── TIER 2+ ('flash'): the outside flash signal responds to a connect ───
  {
    const { sub } = makeSubsystem({ perfTier: 2 });
    sub.sync(0);
    sub.forceStrike();
    sub.sync(1);
    // The connect-triggering sync itself reads 0 (computeOutsideFlashSignal's
    // own attack-start behaviour: dtMs===0 the instant flashStartMs is set) —
    // a LATER sync within the attack ramp is what actually shows the flash.
    sub.sync(1 + 300);
    sub.sync(1 + 320);
    ok('tier 2+ reports a nonzero outside flash signal after a connect', sub.outsideFlash01() > 0);
  }

  // ── A live tier drop mid-session silences the signal the very next sync ──
  {
    const { sub, state } = makeSubsystem({ perfTier: 2 });
    sub.sync(0);
    sub.forceStrike();
    sub.sync(1);
    sub.sync(1 + 300);
    sub.sync(1 + 320);
    ok('sanity check: the signal is nonzero before the tier drop', sub.outsideFlash01() > 0);

    state.perfTier = 1;
    sub.sync(1 + 340);
    ok(
      'dropping below tier 2 mid-session silences the signal on the very next sync, not next burst',
      sub.outsideFlash01() === 0
    );
  }
}
