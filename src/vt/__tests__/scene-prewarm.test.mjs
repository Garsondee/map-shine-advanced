/**
 * Node verification for vt/scene-prewarm.js — warming the persistent art cache
 * for a scene nobody is viewing yet (loading audit, 2026-10-25).
 *
 * Defended: only art that actually goes through BC compression is requested, each
 * file once, at the BACKGROUND priority (never ahead of what the current scene is
 * drawing), with a true progress count, honouring cancel, and never holding the
 * compressed blocks.
 */
import { planArtPrewarm, prewarmArtCompression, COMPRESSED_ART_KINDS } from '../scene-prewarm.js';
import { PRIORITY_BACKGROUND } from '../compressed-textures.js';

export async function run(t) {
  const { ok } = t;

  ok(
    'tokens are not compressed whole-image art',
    !COMPRESSED_ART_KINDS.includes('token') &&
      COMPRESSED_ART_KINDS.includes('levelBackground') &&
      COMPRESSED_ART_KINDS.includes('levelForeground') &&
      COMPRESSED_ART_KINDS.includes('tile')
  );

  const items = [
    { kind: 'levelBackground', src: 'a.webp' },
    { kind: 'token', src: 'tok.webp' },
    { kind: 'tile', src: 'b.webp' },
    { kind: 'levelBackground', src: 'a.webp' }, // two floors sharing one file
    { kind: 'levelForeground', src: 'roof.webp' },
    { kind: 'tile', src: '' },
    { kind: 'tile' },
    null,
  ];
  const plan = planArtPrewarm(items);
  ok('the plan holds each art file once, in draw-list order', plan.join() === 'a.webp,b.webp,roof.webp');
  ok('tokens, blanks and junk entries are skipped', !plan.includes('tok.webp') && plan.length === 3);
  ok('no items => an empty plan', planArtPrewarm(undefined).length === 0);

  // ── the runner ────────────────────────────────────────────────────────────────
  {
    const calls = [];
    const progress = [];
    const outcomes = { 'a.webp': { cached: true }, 'b.webp': { cached: false }, 'roof.webp': null };
    const r = await prewarmArtCompression(plan, {
      request: async (src, opts) => {
        calls.push({ src, priority: opts.priority });
        return outcomes[src];
      },
      onProgress: (p) => progress.push(`${p.done}/${p.total}`),
    });
    ok(
      'every file is requested at the BACKGROUND priority',
      calls.length === 3 && calls.every((c) => c.priority === PRIORITY_BACKGROUND)
    );
    ok('…in plan order', calls.map((c) => c.src).join() === plan.join());
    ok('progress is a true count: 0/3, 1/3, 2/3, 3/3', progress.join() === '0/3,1/3,2/3,3/3');
    ok(
      'hits, fresh encodes and unavailable are tallied separately',
      r.cachedHits === 1 && r.fresh === 1 && r.unavailable === 1 && r.requested === 3
    );
    ok('not cancelled', r.cancelled === false);
  }

  // ── cancel is honoured between files ─────────────────────────────────────────
  {
    let n = 0;
    const r = await prewarmArtCompression(plan, {
      request: async () => ({ cached: true }),
      isCancelled: () => n++ >= 1,
    });
    ok('cancel stops before the next file', r.cancelled === true && r.requested === 1);
  }

  // ── nothing to do ────────────────────────────────────────────────────────────
  {
    const progress = [];
    const r = await prewarmArtCompression([], { request: async () => null, onProgress: (p) => progress.push(p) });
    ok(
      'an empty list finishes at once, reporting 0/0 once',
      r.requested === 0 && progress.length === 1 && progress[0].total === 0
    );
  }
}
