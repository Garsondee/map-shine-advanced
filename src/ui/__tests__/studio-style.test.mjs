/**
 * studio-style.js — the Studio's design rules, checked mechanically.
 *
 * A stylesheet is easy to regress silently: someone adds a quick
 * `transition: all .3s ease-in`, or a `:hover` rule outside the touch gate, and
 * nothing fails — the panel just feels a little worse and, on a touch screen,
 * sticks in hover states. These assertions turn the rules the polish pass
 * (2026-10-18) was built on into red tests, in the same spirit as the repo's
 * structure tripwires: "a comment cannot fail a build; this file can."
 *
 * The motion rules are Emil Kowalski's design-engineering rules (see the header
 * of studio-style.js): never `transition: all`, never ease-in on UI, UI
 * durations under 300ms, nothing scales from 0, press feedback on every
 * pressable thing, hover only where hover exists.
 */
import { studioCss, POPOUT_CLASS } from '../rooms/studio/studio-style.js';

const ROOM = 'msa-studio';
const ACCENTS = ['--shine', '--c-particles', '--c-atmos', '--c-post', '--c-system'];

/** Every `prop: value` run for `transition` / `animation` declarations. */
function motionDeclarations(css) {
  return [...css.matchAll(/(?:^|[;{\s])(transition|animation)\s*:\s*([^;}]+)/g)].map((m) => ({
    prop: m[1],
    value: m[2].trim(),
  }));
}

/** The longest duration (ms) mentioned in a transition/animation value. */
function longestDurationMs(value) {
  let longest = 0;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
    const ms = m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
    longest = Math.max(longest, ms);
  }
  return longest;
}

export function run(t) {
  const { ok } = t;
  const css = studioCss(ROOM, ACCENTS);

  ok('the stylesheet is a non-trivial string', typeof css === 'string' && css.length > 5000);
  ok(
    'braces balance (a missing } silently swallows every rule after it)',
    css.split('{').length === css.split('}').length
  );
  ok(
    'the pop-out class is exported and its rules are present',
    POPOUT_CLASS === 'msa-studio-pop' && css.includes(`.${POPOUT_CLASS}{`)
  );

  // ---- motion ----------------------------------------------------------------
  const motion = motionDeclarations(css);
  ok('the sheet declares transitions and animations at all (the extraction found them)', motion.length >= 15);
  ok(
    'NEVER `transition: all` — name the properties that move',
    !motion.some((m) => m.prop === 'transition' && /(^|[\s,])all([\s,]|$)/.test(m.value))
  );
  ok(
    'NEVER ease-in on UI (it delays the exact moment the user is watching); ease-in-out is allowed',
    !motion.some((m) => /\bease-in\b(?!-out)/.test(m.value))
  );
  ok(
    'every UI duration is 300ms or less',
    motion.every((m) => longestDurationMs(m.value) <= 300)
  );
  ok(
    'every transition/animation that names a curve uses a token or a plain ease — no hand-typed cubic-bezier scattered through the sheet',
    !/cubic-bezier\(/.test(css)
  );
  ok(
    'nothing scales from 0 — entrances start at .96–.985 plus opacity',
    !/scale\(\s*0(\.0+)?\s*\)/.test(css) &&
      /@keyframes msaRoomIn\{from\{opacity:0; transform:translateY\(8px\) scale\(\.985\)\}\}/.test(css)
  );
  ok(
    'the copy-icon cross-fade starts from .25, not 0 (a blurred shrink, never a pop from nothing)',
    css.includes('transform:scale(.25); filter:blur(4px)')
  );

  // ---- press feedback --------------------------------------------------------
  const press = css.match(/:active:not\(:disabled\)[^{]*\{transform:scale\(([\d.]+)\)\}/);
  ok('every pressable thing has an :active press response', press !== null);
  ok(
    '...a subtle one (.95 – .98), per the press-feedback rule',
    press !== null && Number(press[1]) >= 0.95 && Number(press[1]) <= 0.98
  );
  for (const kind of ['.msa-btn', '.hbtn', '.msa-chip', '.msa-tile', '.msa-switch', '.msa-badge--action']) {
    ok(
      `${kind} is in the press group (reset + focus ring + press)`,
      css.includes(`${kind},`) || css.includes(`${kind})`)
    );
  }
  ok('the department rail is in the press group too', css.includes('.rail button:active:not(:disabled)'));

  // ---- hover only where hover exists -------------------------------------------
  const gate = '@media (hover:hover) and (pointer:fine){';
  const at = css.indexOf(gate);
  ok('there is a (hover:hover) and (pointer:fine) gate', at > 0);
  ok(
    'EVERY :hover rule lives inside that gate — nothing sticks on a touch screen',
    at > 0 && !css.slice(0, at).includes(':hover')
  );
  ok('...and the gate is not empty', at > 0 && css.slice(at).includes(':hover'));

  // ---- keyboard focus ------------------------------------------------------------
  ok(
    'pressables get a :focus-visible ring (and never a mouse-click glow)',
    css.includes(':focus-visible{outline:2px solid var(--shine)')
  );
  ok(
    'fields show focus on their WRAPPER (a ring around the pill), not the inner input',
    css.includes('#studioSearchBox:focus-within') && css.includes('.msa-field:focus-within')
  );

  // ---- winning back Foundry's global button rules --------------------------------
  ok(
    "Foundry's `height:2em` is overridden (the cause of the circular enable switch)",
    /height:auto; min-height:0/.test(css)
  );
  ok('the switch is a real 30×18 pill', /\.msa-switch\{[^}]*width:30px; height:18px/.test(css));
  ok('hbtn is exactly 24×24 again', /\.hbtn\{width:24px; height:24px/.test(css));
  ok("dropdowns do not inherit Foundry's `width:100%`", /\.msa-select[^{]*\{\s*width:auto/.test(css));
  ok(
    'the h2 serif face is pinned back to the LANTERN face',
    /\.depthead h2\{font:650 \.95rem\/1\.2 var\(--font\)/.test(css)
  );

  // ---- the rail ----------------------------------------------------------------------
  for (const v of ACCENTS) {
    ok(`rail accent rules exist for ${v}`, css.includes(`.rail button[data-acc="${v}"]::before{background:var(${v})}`));
  }
  ok(
    'the rail bar exists on every button and scales in on the pressed one (no layout maths)',
    css.includes('.rail button[aria-pressed="true"]::before{opacity:1; transform:scaleY(1)}')
  );

  // ---- no accidental leftovers --------------------------------------------------------
  ok('no placeholder/junk selectors slipped in', !/mythica-machina-press-\d+-anchor/.test(css));
  ok(
    'a different room id changes every selector (nothing is hard-coded to msa-studio)',
    studioCss('other-room', []).includes('#other-room{') && !studioCss('other-room', []).includes('#msa-studio')
  );
}
