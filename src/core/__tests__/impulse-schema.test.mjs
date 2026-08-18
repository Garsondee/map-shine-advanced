/**
 * THE IMPULSE CONTRACT — verification (docs/holy/UI-Testament.md §4.4, U7).
 */
import { validateImpulseDecl, validateImpulseList } from '../impulse-schema.js';

function impulse(overrides = {}) {
  return {
    id: 'strike',
    label: 'Strike',
    icon: 'bolt',
    fire: () => {},
    ...overrides,
  };
}

export function run(t) {
  const { ok } = t;

  // ---- the happy path -------------------------------------------------------
  {
    const r = validateImpulseDecl(impulse());
    ok('a well-formed live impulse passes', r.ok);
    ok('a passing declaration has no errors', r.errors.length === 0);

    const planned = validateImpulseDecl({
      id: 'thunder',
      label: 'Thunder',
      icon: 'cloud',
      status: 'planned',
      plannedReason: 'no audio engine exists yet',
    });
    ok('a well-formed planned impulse passes without a fire() function', planned.ok);

    const explicitLive = validateImpulseDecl(impulse({ status: 'live' }));
    ok('status:"live" stated explicitly is equivalent to the default', explicitLive.ok);
  }

  // ---- structural rejection ---------------------------------------------
  {
    ok('null is rejected, not thrown on', !validateImpulseDecl(null).ok);
    ok('a string is rejected, not thrown on', !validateImpulseDecl('nope').ok);
    ok('an array is rejected (not a plain object)', !validateImpulseDecl([]).ok);
  }

  // ---- SABOTAGE: missing id/label/icon ------------------------------------
  {
    ok('missing id fails', !validateImpulseDecl(impulse({ id: '' })).ok);
    ok('missing label fails', !validateImpulseDecl(impulse({ label: '' })).ok);
    ok('missing icon fails', !validateImpulseDecl(impulse({ icon: '' })).ok);
  }

  // ---- SABOTAGE: a live impulse with no fire() -----------------------------
  {
    const r = validateImpulseDecl({ id: 'x', label: 'X', icon: 'bolt' });
    ok('a live impulse with no fire() fails — nothing would happen on click', !r.ok);
    ok(
      'the error explains why',
      r.errors.some((e) => e.includes('fire'))
    );
  }

  // ---- SABOTAGE: a planned impulse with no plannedReason -------------------
  {
    const r = validateImpulseDecl({ id: 'x', label: 'X', icon: 'bolt', status: 'planned' });
    ok('a planned impulse with no plannedReason fails', !r.ok);
    ok(
      'the error explains why',
      r.errors.some((e) => e.includes('plannedReason'))
    );
  }

  // ---- SABOTAGE: unknown status --------------------------------------------
  {
    const r = validateImpulseDecl(impulse({ status: 'coming-soon' }));
    ok('an unknown status value fails', !r.ok);
  }

  // ---- a planned impulse does NOT need fire() ------------------------------
  {
    const r = validateImpulseDecl({
      id: 'x',
      label: 'X',
      icon: 'bolt',
      status: 'planned',
      plannedReason: 'not built yet',
    });
    ok('planned status legitimately skips the fire() requirement', r.ok);
  }

  // ---- validateImpulseList: the happy path ---------------------------------
  {
    const list = [
      impulse({ id: 'strike' }),
      impulse({ id: 'gust', label: 'Gust', icon: 'wind' }),
      {
        id: 'thunder',
        label: 'Thunder',
        icon: 'cloud',
        status: 'planned',
        plannedReason: 'no audio engine exists yet',
      },
    ];
    const r = validateImpulseList(list);
    ok('a well-formed list of three (two live, one planned) passes', r.ok);
  }

  // ---- validateImpulseList: structural rejection ---------------------------
  {
    ok('a non-array is rejected', !validateImpulseList({}).ok);
    ok('a non-array is rejected (string)', !validateImpulseList('nope').ok);
    ok('an empty list is legal (nothing registered yet is not an error)', validateImpulseList([]).ok);
  }

  // ---- SABOTAGE: duplicate ids ----------------------------------------------
  {
    const r = validateImpulseList([impulse({ id: 'strike' }), impulse({ id: 'strike', label: 'Strike Again' })]);
    ok('two impulses sharing an id fails', !r.ok);
    ok(
      'the error names the offending id',
      r.errors.some((e) => e.includes('strike') && e.includes('duplicate'))
    );
  }

  // ---- one bad declaration is reported without masking the others ---------
  {
    const r = validateImpulseList([impulse({ id: 'strike' }), { id: 'bad', label: '', icon: 'x', fire: () => {} }]);
    ok('a bad declaration inside an otherwise-valid list fails the whole check', !r.ok);
    ok(
      'the error is prefixed with the offending id',
      r.errors.some((e) => e.startsWith('bad:'))
    );
  }
}
