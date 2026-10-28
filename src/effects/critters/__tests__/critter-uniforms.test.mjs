/**
 * THE LAZY UNIFORM BANK — tested against a stub of the TSL constructors it uses.
 *
 * The bank's one real hazard has already bitten once, in the lab, and is pinned here so it cannot
 * come back: a kernel's body does not run when the kernel is CONSTRUCTED, it runs when the kernel is
 * first BUILT, so the uniforms it reads are created AFTER the first `setParams`. A bank that only
 * touched uniforms that already existed silently dropped those first values — every author setting
 * ignored until they happened to touch a slider.
 */
import { createUniformBank, CRITTER_UNIFORM_DEFAULTS, CRITTER_KIND_DEFAULTS } from '../critter-uniforms.js';

/** The slice of TSL the bank touches, as plain objects that record what they were built from. */
function stubTSL() {
  const vec = (...c) => ({
    isVec: true,
    c,
    set(...v) {
      this.c = v;
    },
  });
  return {
    float: (v) => ({ isConst: true, value: v }),
    vec2: (x, y) => vec(x, y),
    vec3: (x, y, z) => vec(x, y, z),
    // three's `uniform(node)` unwraps a const node's value (or a vector node) into its own `.value`
    uniform: (node) => ({ isUniform: true, value: node.isVec ? vec(...node.c) : node.value }),
  };
}

export function run(t) {
  const bank = createUniformBank(stubTSL());

  // ── creation and defaults ──
  t.ok('nothing exists until something asks for it', bank.names().length === 0);
  const buzz = bank.get('buzz');
  t.ok(
    'the first ask creates the uniform at its default',
    buzz.value === CRITTER_UNIFORM_DEFAULTS.buzz && bank.names().join() === 'buzz'
  );
  t.ok('a second ask returns the SAME node (one uniform per name)', bank.get('buzz') === buzz);
  t.ok(
    'a vector default becomes a vector uniform',
    bank.get('camCentre').value.c.length === 2 && bank.get('tint').value.c.length === 3
  );
  t.throws(
    'an undeclared name throws at build time, naming the table',
    () => bank.get('definitelyNotDeclared'),
    'CRITTER_UNIFORM_DEFAULTS'
  );

  // ── set after create ──
  t.ok('set() updates a live float uniform', bank.set('buzz', 900) === true && buzz.value === 900);
  bank.set('tint', [0.5, 0.25, 1]);
  t.ok('set() updates a live vector in place', bank.get('tint').value.c.join() === '0.5,0.25,1');
  bank.set('buzz', NaN);
  t.ok('a non-finite value is ignored (the last good one stays)', buzz.value === 900);
  bank.set('tint', [1, 2]);
  t.ok('a vector of the wrong length is ignored', bank.get('tint').value.c.join() === '0.5,0.25,1');
  t.ok(
    'set() on an undeclared name reports false and creates nothing',
    bank.set('speedy', 3) === false && !bank.names().includes('speedy')
  );

  // ── THE REGRESSION: values set BEFORE the uniform exists are kept, and applied the moment it does ──
  const early = createUniformBank(stubTSL());
  early.setMany({ tether: 77, tint: [0.1, 0.2, 0.3], speed: 2.5, notAUniformAtAll: 1 });
  t.ok('setMany before any get creates no uniforms (an unread knob costs nothing)', early.names().length === 0);
  t.ok(
    '…and the first get applies what was asked, not the default',
    early.get('tether').value === 77 && early.get('speed').value === 2.5
  );
  t.ok('…including vectors', early.get('tint').value.c.join() === '0.1,0.2,0.3');
  t.ok('a value never asked for stays at its default', early.get('buzz').value === CRITTER_UNIFORM_DEFAULTS.buzz);
  const early2 = createUniformBank(stubTSL());
  early2.set('maxSpeed', 100);
  early2.set('maxSpeed', 450);
  t.ok('the LAST value asked for before creation wins', early2.get('maxSpeed').value === 450);
  const early3 = createUniformBank(stubTSL());
  early3.set('maxSpeed', Infinity);
  early3.set('swarmRadius', 'wide');
  t.ok(
    'garbage before creation never reaches the uniform',
    early3.get('maxSpeed').value === CRITTER_UNIFORM_DEFAULTS.maxSpeed &&
      early3.get('swarmRadius').value === CRITTER_UNIFORM_DEFAULTS.swarmRadius
  );

  // ── kinds differ only where the table says so ──
  const fly = createUniformBank(stubTSL(), { ...CRITTER_UNIFORM_DEFAULTS, ...CRITTER_KIND_DEFAULTS.fly });
  const firefly = createUniformBank(stubTSL(), { ...CRITTER_UNIFORM_DEFAULTS, ...CRITTER_KIND_DEFAULTS.firefly });
  t.ok('a fly is 6 px by default and a firefly 3', fly.get('size').value === 6 && firefly.get('size').value === 3);
  // `speed` stays genuinely universal (every kind's own schema still defaults it to 1, no kind
  // overrides it); `opacity`/`lightInfluence`/`perspective` no longer are — fireflies' own
  // 2026-10-28 retune gave it independently-tuned values the other kinds don't share (see
  // critter-uniforms.js's own firefly kind-defaults block).
  t.ok('speed is still shared', fly.get('speed').value === firefly.get('speed').value);
  t.ok(
    'the per-kind overrides name only uniforms the table declares (no typo can hide in them)',
    Object.values(CRITTER_KIND_DEFAULTS).every((o) => Object.keys(o).every((k) => k in CRITTER_UNIFORM_DEFAULTS))
  );

  // ── the table itself ──
  t.ok(
    'every default is a finite number or a 2/3-vector of them',
    Object.values(CRITTER_UNIFORM_DEFAULTS).every((v) =>
      Array.isArray(v) ? (v.length === 2 || v.length === 3) && v.every(Number.isFinite) : Number.isFinite(v)
    )
  );
  t.ok(
    'the table is frozen (it is the single declaration)',
    Object.isFrozen(CRITTER_UNIFORM_DEFAULTS) && Object.isFrozen(CRITTER_KIND_DEFAULTS)
  );
}
