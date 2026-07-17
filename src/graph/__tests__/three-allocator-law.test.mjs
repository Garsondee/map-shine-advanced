/**
 * Node verification for the Keyhole law (Keyhole.md §4.6, §0's "one law"):
 * nothing is ever allocated at world resolution. This is the Stage 1 gate's
 * "allocator throws on a deliberately-planted world-res alloc (negative test)".
 */
import { ThreeAllocator, LAW_MAX_WORLD_RES_DIM } from '../three-allocator.js';
import { makeTHREE } from './three-allocator.test.mjs';

export function run(t) {
  const { ok, throws } = t;

  ok('law: cap is 2048 per Keyhole.md §4.6', LAW_MAX_WORLD_RES_DIM === 2048);

  // --- THE LAW MUST BE REACHABLE ------------------------------------------
  // Added 2026-07-17 after finding the law was BROKEN AT FIRST TOUCH for its
  // entire life, with every test below green. The allocator defaulted its THREE
  // namespace to `window.THREE` — a global this codebase never sets — so the
  // first session ever to call the law would have got "window.THREE
  // unavailable". Nothing caught it because EVERY test injects { THREE: T } and
  // no test ever exercised the default. A green suite around an unreachable
  // front door is exactly `feedback_instruments_must_not_lie`.
  //
  // The fix is enforcement by absence (Skeleton.md §1, L0): THREE is required,
  // there is no global to go stale. These assert the door is honest — it must
  // refuse LOUDLY and say what to do, because a wall that fails confusingly is a
  // wall that gets routed around (Skeleton.md §0 law 2).
  {
    throws(
      'law: refuses to construct without THREE (no stale global fallback)',
      () => new ThreeAllocator(),
      'required'
    );
    throws('law: an empty options object is not enough either', () => new ThreeAllocator({}), 'required');

    let msg = '';
    try {
      new ThreeAllocator();
    } catch (err) {
      msg = String(err.message);
    }
    ok('law: the refusal names the FIX (hand in the namespace), not just the problem', /import \* as THREE/.test(msg));
    ok('law: ...and says why there is no fallback (a global can go stale)', /stale/.test(msg));
    ok('law: ...and cites the doc that owns it', /Keyhole\.md §4\.6/.test(msg));
    ok('law: the dead global is named so a search for it lands here', /window\.THREE/.test(msg));
  }

  // The negative test: a deliberately-planted world-res allocation (an 8250px
  // mask bake, exactly the crash-report evidence size from Forward+.md §13).
  {
    const T = makeTHREE();
    const alloc = new ThreeAllocator({ THREE: T });
    throws(
      'law: throws on an 8250px world-res mask bake',
      () => alloc.create('plantedWorldResMask', { resolvedW: 8250, resolvedH: 8250 }),
      'Keyhole law'
    );
  }

  // Boundary: exactly at the cap must NOT throw (off-by-one safety).
  {
    const T = makeTHREE();
    const alloc = new ThreeAllocator({ THREE: T });
    let threw = false;
    try {
      alloc.create('atCap', { resolvedW: LAW_MAX_WORLD_RES_DIM, resolvedH: LAW_MAX_WORLD_RES_DIM });
    } catch (_) {
      threw = true;
    }
    ok('law: exactly at cap does not throw', threw === false);
  }

  // One pixel over on either axis must throw.
  {
    const T = makeTHREE();
    const alloc = new ThreeAllocator({ THREE: T });
    throws(
      'law: one px over width throws',
      () => alloc.create('overW', { resolvedW: LAW_MAX_WORLD_RES_DIM + 1, resolvedH: 512 }),
      'Keyhole law'
    );
    throws(
      'law: one px over height throws',
      () => alloc.create('overH', { resolvedW: 512, resolvedH: LAW_MAX_WORLD_RES_DIM + 1 }),
      'Keyhole law'
    );
  }

  // The explicit, rare opt-in (present-chain native upscale / fog exploration)
  // must be honored — but ONLY when the descriptor sets it, never by name.
  {
    const T = makeTHREE();
    const alloc = new ThreeAllocator({ THREE: T });
    let threw = false;
    try {
      alloc.create('present', { resolvedW: 3840, resolvedH: 2160, allowWorldScale: true });
    } catch (_) {
      threw = true;
    }
    ok('law: allowWorldScale:true is honored for a real 4K present target', threw === false);

    throws(
      'law: a target NAMED "present" without the flag still throws (no name-string whitelist)',
      () => alloc.create('present', { resolvedW: 3840, resolvedH: 2160 }),
      'Keyhole law'
    );
  }

  // resize() must also enforce — a resize storm can't smuggle a world-res
  // target past the law that create() already checked.
  {
    const T = makeTHREE();
    const alloc = new ThreeAllocator({ THREE: T });
    const rt = alloc.create('resizable', { resolvedW: 512, resolvedH: 512 });
    throws('law: resize() to world-res throws too', () => alloc.resize(rt, 9000, 9000), 'Keyhole law');
    ok(
      'law: resize() to a legit small size still works',
      (() => {
        alloc.resize(rt, 1024, 768);
        return rt.width === 1024 && rt.height === 768;
      })()
    );
  }
}
