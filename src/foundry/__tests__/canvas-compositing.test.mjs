/**
 * Node verification for foundry/canvas-compositing.js — THE INTERFACE SEAM.
 *
 * Only `decideArtSuppression` is testable here, and it is the piece worth
 * testing: it encodes the safety slide. Everything else in that module reads
 * live PIXI/Foundry state and is verified by the `interface-seam` debug report
 * in-browser instead (same split as decode-pool.js's browser-only paths).
 *
 * WHAT THIS SUITE IS REALLY DEFENDING, and it is not a hypothetical: suppressing
 * Foundry's art while its canvas is still opaque produces the ONE state worse
 * than doing nothing — no art from either renderer, selection borders floating
 * over a void. Every assertion below is a variant of "when in doubt, leave
 * Foundry rendering."
 */
import { decideArtSuppression, MSA_OWNED_GROUPS } from '../canvas-compositing.js';

const HEALTHY = { contextAlpha: true, clearAlpha: 0, environmentPresent: true };

export async function run(t) {
  // ---- the happy path -------------------------------------------------
  {
    const d = decideArtSuppression(HEALTHY);
    t.ok('transparent context + zero clear alpha + environment => suppress', d.suppress === true);
    t.ok('happy path is coded ok', d.code === 'ok');
  }

  // ---- the context attribute: unrecoverable, and must be treated as such
  {
    const d = decideArtSuppression({ ...HEALTHY, contextAlpha: false });
    t.ok('GL context alpha:false => REFUSE', d.suppress === false);
    t.ok('context-opaque is named', d.code === 'context-opaque');
    // The reason must point at the actual fix (register canvasConfig earlier),
    // not merely report the symptom. A refusal nobody can act on is a dead end.
    t.ok('context-opaque reason names canvasConfig', /canvasConfig/.test(d.reason));
  }

  // ---- UNKNOWN IS NOT OK. "Could not measure" must never be read as "fine",
  // and the safe direction on an unknown is always: leave Foundry rendering.
  {
    const dNull = decideArtSuppression({ ...HEALTHY, contextAlpha: null });
    t.ok('contextAlpha null => REFUSE (unknown is not permission)', dNull.suppress === false);
    t.ok('contextAlpha null is coded distinctly from a real false', dNull.code === 'context-alpha-unknown');

    const dUndef = decideArtSuppression({ clearAlpha: 0, environmentPresent: true });
    t.ok('contextAlpha absent entirely => REFUSE', dUndef.suppress === false);
    t.ok('absent contextAlpha codes as unknown', dUndef.code === 'context-alpha-unknown');
  }
  {
    const d = decideArtSuppression({ ...HEALTHY, clearAlpha: null });
    t.ok('clearAlpha null => REFUSE', d.suppress === false);
    t.ok('clearAlpha null coded distinctly', d.code === 'clear-alpha-unknown');
  }

  // A real measured false and an unmeasurable null must NEVER collapse to the
  // same code — that conflation is the exact failure feedback_instruments_must_
  // _not_lie exists for. Both refuse; they refuse for different, nameable reasons.
  {
    const measured = decideArtSuppression({ ...HEALTHY, contextAlpha: false });
    const unmeasured = decideArtSuppression({ ...HEALTHY, contextAlpha: null });
    t.ok(
      'a measured-false and an unmeasured-null are distinguishable',
      measured.code !== unmeasured.code && measured.suppress === false && unmeasured.suppress === false
    );
  }

  // ---- the clobber trap: Foundry resets background alpha to 1 on every
  // environment colour change (environment.mjs:179 -> PIXI normalize() forces
  // a=1). If the re-assert did not fire, we must NOT suppress.
  {
    const d = decideArtSuppression({ ...HEALTHY, clearAlpha: 1 });
    t.ok('clearAlpha 1 (Foundry clobbered it) => REFUSE', d.suppress === false);
    t.ok('clobbered alpha is named', d.code === 'clear-alpha-opaque');
    t.ok('clobber reason cites the real source line', /environment\.mjs:179/.test(d.reason));
  }
  {
    // Partial transparency is still transparency-broken for our purposes: any
    // non-zero clear alpha means PIXI paints over MSA.
    const d = decideArtSuppression({ ...HEALTHY, clearAlpha: 0.5 });
    t.ok('a partial clearAlpha still refuses', d.suppress === false && d.code === 'clear-alpha-opaque');
  }

  // ---- no scene drawn yet: refuse, but this one is benign, not a fault.
  {
    const d = decideArtSuppression({ ...HEALTHY, environmentPresent: false });
    t.ok('no canvas.environment => REFUSE', d.suppress === false);
    t.ok('missing environment is coded benignly', d.code === 'no-environment');
  }

  // ---- ordering: the UNRECOVERABLE fact must win the report. If the context is
  // opaque, saying "clear alpha is wrong" sends the reader to fix the fixable
  // thing while the real cause (too late to ever fix this session) goes unsaid.
  {
    const d = decideArtSuppression({ contextAlpha: false, clearAlpha: 1, environmentPresent: false });
    t.ok('with everything wrong, the context attribute is reported first', d.code === 'context-opaque');
  }

  // ---- every refusal is actionable: a code and a non-empty reason, always.
  {
    const cases = [
      { contextAlpha: null, clearAlpha: 0, environmentPresent: true },
      { contextAlpha: false, clearAlpha: 0, environmentPresent: true },
      { contextAlpha: true, clearAlpha: null, environmentPresent: true },
      { contextAlpha: true, clearAlpha: 1, environmentPresent: true },
      { contextAlpha: true, clearAlpha: 0, environmentPresent: false },
    ];
    const allNamed = cases.every((c) => {
      const d = decideArtSuppression(c);
      return d.suppress === false && typeof d.code === 'string' && d.code.length > 0 && d.reason.length > 20;
    });
    t.ok('every refusal carries a code AND a real reason', allNamed);

    const codes = new Set(cases.map((c) => decideArtSuppression(c).code));
    t.ok('every refusal reason is distinct (no collapsed diagnoses)', codes.size === cases.length);
  }

  // ---- DEFAULT-DENY, proven rather than assumed. This is the whole safety
  // slide in one assertion: the ONLY input that suppresses is the fully-verified
  // one. Anything else — any combination, any unknown — leaves Foundry drawing.
  {
    const values = {
      contextAlpha: [true, false, null, undefined],
      clearAlpha: [0, 1, 0.5, null, undefined],
      environmentPresent: [true, false],
    };
    let suppressCount = 0;
    let total = 0;
    for (const ca of values.contextAlpha) {
      for (const cl of values.clearAlpha) {
        for (const ep of values.environmentPresent) {
          total++;
          if (decideArtSuppression({ contextAlpha: ca, clearAlpha: cl, environmentPresent: ep }).suppress) {
            suppressCount++;
            // and it had better be exactly the healthy one
            t.ok('the only suppressing input is the fully-verified one', ca === true && cl === 0 && ep === true);
          }
        }
      }
    }
    t.ok(`exactly 1 of ${total} fact combinations suppresses`, suppressCount === 1);
  }

  // ---- the seam's scope, pinned. `visibility` (fog/vision) is deliberately NOT
  // ours yet — the author's direction is that MSA takes it EVENTUALLY
  // (keyhole-vision-fog-direction). If someone adds it here, that is a real
  // architectural decision and it should not happen by a quiet edit.
  {
    t.ok('MSA owns exactly primary + effects', MSA_OWNED_GROUPS.length === 2);
    t.ok('MSA owns primary', MSA_OWNED_GROUPS.includes('primary'));
    t.ok('MSA owns effects', MSA_OWNED_GROUPS.includes('effects'));
    t.ok('MSA does NOT own visibility (fog/vision stays with PIXI for now)', !MSA_OWNED_GROUPS.includes('visibility'));
    t.ok('MSA does NOT own interface — that is the whole point of the seam', !MSA_OWNED_GROUPS.includes('interface'));
    t.ok('the owned-group list is frozen', Object.isFrozen(MSA_OWNED_GROUPS));
  }
}
