/**
 * The shared room kit and the Remote / Player / tile-motion stylesheets built on it,
 * checked mechanically — the same idea as studio-style.test.mjs, now for every room.
 *
 * A stylesheet regresses silently: someone adds a quick `transition: all .3s ease-in`, or
 * a `:hover` rule outside the touch gate, and nothing fails — the panel just feels a little
 * worse and, on a touch screen, sticks in hover states. These assertions turn the rules the
 * 2026-10-18 polish passes were built on into red tests ("a comment cannot fail a build;
 * this file can"), and run the SAME battery over all four room sheets, so a rule one room
 * keeps cannot quietly stop being true of another.
 *
 * What it cannot do is prove the sheet looks right under Foundry — that is
 * tools/preview-shared/control-audit.js, run live in the harness with `?foundry=`.
 */
import {
  uiKitCss,
  uiKitHoverCss,
  wxChipCss,
  wxChipHoverCss,
  replayClass,
  BASE_PRESSABLES,
  MOTION_KEYFRAMES,
} from '../rooms/room-style.js';
import { pressModelCss, HOVER_GATE } from '../widgets/press-model.js';
import { studioCss } from '../rooms/studio/studio-style.js';
import {
  remoteCss,
  tileMotionCss,
  REMOTE_PRESSABLES,
  REMOTE_TOOLTIP_SCOPE,
  REMOTE_ROOM_ID,
} from '../rooms/remote/remote-style.js';
import { playerCss, PLAYER_TOOLTIP_SCOPE } from '../rooms/player-style.js';

/** Every `transition` / `animation` declaration's value. */
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

/** CSS with its comments removed — so a rule's own explanation cannot trip a check on the rule. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * The design rules every room sheet must obey. `label` names the sheet in a failure.
 * @param {{ok: (name: string, cond: unknown) => void}} t
 * @param {string} css
 * @param {string} label
 */
function checkDesignRules({ ok }, css, label) {
  const code = stripComments(css);
  const motion = motionDeclarations(code);
  ok(`${label}: a non-trivial stylesheet`, css.length > 1500);
  ok(
    `${label}: braces balance (a missing } silently swallows every rule after it)`,
    css.split('{').length === css.split('}').length
  );
  ok(
    `${label}: NEVER \`transition: all\` — name the properties that move`,
    !motion.some((m) => m.prop === 'transition' && /(^|[\s,])all([\s,]|$)/.test(m.value))
  );
  ok(
    `${label}: NEVER ease-in on UI (it delays the exact moment the user is watching); ease-in-out is allowed`,
    !motion.some((m) => /\bease-in\b(?!-out)/.test(m.value))
  );
  ok(
    `${label}: every UI duration is 300ms or less`,
    motion.every((m) => longestDurationMs(m.value) <= 300)
  );
  ok(`${label}: no hand-typed cubic-bezier — curves come from the --ease-* tokens`, !/cubic-bezier\(/.test(code));
  ok(`${label}: nothing scales from 0`, !/scale\(\s*0(\.0+)?\s*\)/.test(code));
  ok(
    `${label}: a pressed control scales subtly (.95 – .98)`,
    (() => {
      const m = code.match(/:active:not\(:disabled\)[^{]*\{transform:scale\(([\d.]+)\)\}/);
      return m !== null && Number(m[1]) >= 0.95 && Number(m[1]) <= 0.98;
    })()
  );
  ok(
    `${label}: keyboard focus draws a ring (never a mouse-click glow)`,
    code.includes(':focus-visible{outline:2px solid var(--shine)')
  );
  const at = code.indexOf(`${HOVER_GATE}{`);
  ok(`${label}: there is a (hover:hover) and (pointer:fine) gate`, at > 0);
  ok(
    `${label}: EVERY hover rule lives inside that gate — nothing sticks on a touch screen`,
    at > 0 && !code.slice(0, at).includes(':hover')
  );
  ok(`${label}: ...and the gate is not empty`, at > 0 && code.slice(at).includes(':hover'));
  ok(
    `${label}: Foundry's \`height:2em\`/\`min-height\` on every button is reset (the cause of the circular switch and the 26×28 header buttons)`,
    /height:auto; min-height:0/.test(code)
  );
}

export function run(t) {
  const { ok } = t;

  // ---- the press model, on its own (the scale strip uses it without a room) ---------------------
  {
    const css = pressModelCss(['.a button', '.b']);
    ok(
      'the press model builds every state for EVERY selector given',
      css.includes('.a button, .b{') &&
        css.includes('.a button:focus-visible, .b:focus-visible{outline:2px solid var(--shine)') &&
        css.includes('.a button:active:not(:disabled), .b:active:not(:disabled){transform:scale(.97)}') &&
        css.includes('.a button:disabled, .b:disabled{')
    );
    ok(
      "...and wins back Foundry's button box and its 0.5s transition in one rule",
      css.includes('height:auto; min-height:0') && css.includes('transition:transform 160ms var(--ease-out)')
    );
    ok('the hover gate is the touch-safe one', HOVER_GATE === '@media (hover:hover) and (pointer:fine)');
  }

  // ---- the kit -----------------------------------------------------------------------------------
  {
    const IN = ':is(#room-a, .pop-a)';
    const css = uiKitCss(IN, { pressInside: ['.x-btn'], pressAfter: ['#room-a .rail button'] });
    ok(
      "the kit presses the shared classes AND the room's own (inside the scope, and complete selectors after it)",
      BASE_PRESSABLES.every((c) => css.includes(`${c}`)) &&
        css.includes(`${IN} :is(${[...BASE_PRESSABLES, '.x-btn'].join(', ')})`) &&
        css.includes('#room-a .rail button:focus-visible')
    );
    ok(
      'the kit carries NO hover rule of its own (they live in uiKitHoverCss, inside the gate)',
      !css.includes(':hover')
    );
    const hover = uiKitHoverCss(IN);
    ok(
      'every rule the kit hover function returns is a hover rule',
      hover.includes(':hover') &&
        hover
          .split('\n')
          .filter((l) => l.includes('{'))
          .every((l) => l.includes(':hover'))
    );
    ok(
      'every scope in the kit is the room that was passed in (nothing hard-coded to the Studio)',
      !css.includes('#msa-studio') && !hover.includes('#msa-studio')
    );
    ok(
      'a switch is a real 30×18 pill, a header button 24×24, a select is not full width',
      /\.msa-switch\{[^}]*width:30px; height:18px/.test(css) &&
        /\.hbtn\{width:24px; height:24px/.test(css) &&
        /\.msa-select[^{]*\{\s*width:auto/.test(css)
    );
    checkDesignRules(t, `${css}\n${HOVER_GATE}{\n${hover}\n}`, 'kit');
  }

  // ---- the shared chip ------------------------------------------------------------------------------
  {
    const css = wxChipCss('#r');
    ok(
      'the chip has a lit state and a dashed "heading there" state',
      css.includes('#r .msa-wx-chip[aria-pressed="true"]') &&
        /\[data-pending="true"\][^}]*border-style:dashed/.test(css)
    );
    const hover = wxChipHoverCss('#r');
    ok(
      'a lit chip keeps its look under the pointer: plain hover excludes lit and pending, lit gets its own',
      hover.includes(':not([aria-pressed="true"]):not([data-pending="true"]):hover') &&
        hover.includes('[aria-pressed="true"]:hover')
    );
  }

  // ---- the shared entrance keyframes ---------------------------------------------------------------------
  ok(
    'the entrance keyframes start at .96–.985 plus opacity, never from 0',
    MOTION_KEYFRAMES.includes('@keyframes msaRoomIn{from{opacity:0; transform:translateY(8px) scale(.985)}}') &&
      MOTION_KEYFRAMES.includes('@keyframes msaPopIn{from{opacity:0; transform:scale(.96)}}') &&
      !/scale\(\s*0\s*\)/.test(MOTION_KEYFRAMES)
  );
  {
    const calls = [];
    const el = {
      classList: { add: (c) => calls.push(`add ${c}`), remove: (c) => calls.push(`remove ${c}`) },
      get offsetWidth() {
        calls.push('reflow');
        return 0;
      },
    };
    replayClass(el, 'msa-enter');
    ok(
      'replayClass drops the class, FORCES A REFLOW, then adds it back (without the reflow the second add is a no-op)',
      calls.join('|') === 'remove msa-enter|reflow|add msa-enter'
    );
  }

  // ---- the Remote ---------------------------------------------------------------------------------------------
  {
    const css = remoteCss();
    checkDesignRules(t, css, 'remote');
    ok(
      'every Remote pressable is a SINGLE class (an :is() weighs as its most specific argument, so one `.x button` would outrank every room rule)',
      REMOTE_PRESSABLES.every((p) => /^\.[a-z][a-z0-9-]*$/.test(p))
    );
    const code = stripComments(css);
    const group = code.match(/:is\(#msa-remote, #msa-remote-camera-path, #msa-remote-wind\) :is\(([^)]*)\)\{/);
    ok("the Remote's press group is in the sheet, scoped to the room AND its two popovers", group !== null);
    ok(
      "...and holds the kit's pressables plus every Remote one",
      group !== null &&
        [...BASE_PRESSABLES, ...REMOTE_PRESSABLES].every((p) =>
          group[1]
            .split(',')
            .map((s) => s.trim())
            .includes(p)
        )
    );
    ok(
      'the entrance plays on the CARD, never the room (the room carries the interface scale as an inline transform)',
      code.includes('.msa-remote-card.msa-enter{animation:msaRoomIn 200ms var(--ease-out) both}') &&
        !/#msa-remote\.msa-enter/.test(code)
    );
    ok(
      'a press on a menu row does not scale the corner button the menu hangs from (menus are children of their button)',
      code.includes('.msa-corner-btn:has(> .msa-jump-menu:active){transform:none}')
    );
    ok(
      'the popovers open scaled out of their own corner, and are hidden by an !important [hidden] (Play sets an inline display)',
      code.includes('.msa-pop-enter') &&
        code.includes('#msa-remote-camera-path[hidden]') &&
        code.includes('#msa-remote-wind[hidden]')
    );
    ok(
      "the room root hides with an !important [hidden] (an author `display` outranks the browser's own)",
      code.includes('#msa-remote[hidden]')
    );
    ok(
      "the header icon buttons are 26px (the kit's own is 24)",
      /#msa-remote \.hbtn\{width:26px; height:26px/.test(code)
    );
    ok(
      "the debug strip's accordion chevron is 20×20 again (Foundry's min-height made it 20×28)",
      /\.msa-debug-more\{[^}]*width:20px; height:20px/.test(code)
    );
    ok(
      "the two contained !importants against buildActionButton's inline background are there, and only there",
      /\.msa-debug-btn\{[^}]*background:none !important/.test(code) &&
        /\.msa-debug-btn\[aria-pressed="true"\]\{[^}]*!important\}/.test(code)
    );
    ok(
      "the scrollable regions use the room's thin scrollbar, not Foundry's orange one",
      (code.match(/scrollbar-color:var\(--line-strong\) transparent/g) || []).length >= 3
    );
    ok(
      'the room id and the tooltip scope agree',
      REMOTE_ROOM_ID === 'msa-remote' &&
        REMOTE_TOOLTIP_SCOPE.split(',').length === 3 &&
        REMOTE_TOOLTIP_SCOPE.startsWith('#msa-remote,')
    );
  }

  // ---- the tile-motion panel ---------------------------------------------------------------------------------------
  {
    const css = tileMotionCss();
    checkDesignRules(t, css, 'tile-motion');
    const code = stripComments(css);
    ok(
      "the panel's h4 is pinned back from Foundry's serif face",
      /#msa-tile-motion h4\{[^}]*font:600 \.68rem\/1\.3 var\(--font\)/.test(code)
    );
    ok(
      'the panel root hides with an !important [hidden] and its entrance plays on the panel',
      code.includes('#msa-tile-motion[hidden]{display:none !important}') &&
        code.includes('#msa-tile-motion.msa-enter{animation:msaRoomIn')
    );
    ok(
      'its header buttons are 22px and it presses its thumbnails',
      /#msa-tile-motion \.hbtn\{width:22px; height:22px/.test(code) && code.includes('.msa-tm-thumb')
    );
  }

  // ---- the Player room -----------------------------------------------------------------------------------------------
  {
    const css = playerCss();
    checkDesignRules(t, css, 'player');
    const code = stripComments(css);
    ok(
      "the Player room uses the kit's switch and field skin (its tree is the Studio System department's)",
      code.includes('input.msa-switch-input') && code.includes('.msa-select')
    );
    ok(
      "the Player room's entrance plays on the room itself (it has no scale strip)",
      code.includes('#msa-player.msa-enter{animation:msaRoomIn 200ms var(--ease-out) both}')
    );
    ok(
      "its chips wrap in a row (the Remote's are a 4-column grid)",
      /\.msa-wx-chips\{display:flex; flex-wrap:wrap/.test(code)
    );
    ok(
      'the Player root hides with an !important [hidden]',
      code.includes('#msa-player[hidden]{display:none !important}')
    );
    ok('the tooltip scope is the room', PLAYER_TOOLTIP_SCOPE === '#msa-player');
  }

  // ---- the Studio still obeys the same battery (its output was moved onto the kit, not changed) -------------------------
  checkDesignRules(
    t,
    studioCss('msa-studio', ['--shine', '--c-particles', '--c-atmos', '--c-post', '--c-system']),
    'studio'
  );
}
