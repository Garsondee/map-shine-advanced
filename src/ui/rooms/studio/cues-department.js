/**
 * ui/rooms/studio/cues-department.js — THE CUES DEPARTMENT (U3, docs/holy/
 * UI-Testament.md §5.4): capture-first authoring. A big Capture button, the
 * stack as reorderable cards (name · fade time · curve · what it touches),
 * a validity badge per cue, test-fire with an instant revert. Ported layout
 * from the mock's `#cueBuild`/`.cueitem` (tools/ui-mock/index.html) — see
 * Petition P15 for exactly what changed in the port.
 *
 * ⚠️ NAME COMES FROM A NATIVE `prompt()`, NOT A NEW LANTERN DIALOG. The
 * mock's own Capture button never actually asks for a name at all — its
 * `.cname` is static, unwired text (a real gap in the mock itself, not
 * something this file is simplifying away). "Capture-then-name" (§4.3)
 * reads as ONE gesture, so this asks immediately, inline, rather than
 * inventing a rename affordance that doesn't exist anywhere yet. A
 * cancelled/empty prompt still captures, under a clock-stamped default
 * name — a one-click "capture the moment" action must never dead-end.
 *
 * ⚠️ CURVE IS DISPLAY-ONLY THIS ROUND. The mock's own per-cue `<select>`
 * (labelled fade time) has no `onchange` handler wired anywhere in the
 * mock either — decorative there. This file's OWN fade-time select IS
 * wired for real (`ctx.updateCueFadeMs`); curve is shown as a small badge
 * next to it, matching §5.4's "name · fade time · curve · what it
 * touches" as a set of DISPLAYED properties — editing curve per cue is a
 * real, scoped follow-up, not built this round. Deleting a cue is also
 * not built this round (not part of §9's own U3 checklist wording).
 *
 * @module ui/rooms/studio/cues-department
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';

/** The Remote's own TEMPO list (fade-time.js), duplicated as plain data
 * here rather than imported — this file needs {label, ms} pairs for a
 * native <select>, not a DOM control. */
const TEMPO_OPTIONS = Object.freeze([
  { label: '10s', ms: 10000 },
  { label: '30s', ms: 30000 },
  { label: '1m', ms: 60000 },
  { label: '5m', ms: 300000 },
  { label: '20m', ms: 1200000 },
  { label: '1h', ms: 3600000 },
]);

/** fade key's own axis suffix -> icon name, for the "what it touches"
 * glyph row. Anything not listed here (a future non-weather fade source)
 * shows no glyph rather than guessing at one. */
const AXIS_ICON = Object.freeze({ cloudCover01: 'cloud', precip01: 'rain' });

function longestOverMs(cue) {
  return Math.max(...Object.values(cue.targets).map((t) => t.overMs));
}

function nearestTempoLabel(ms) {
  let best = TEMPO_OPTIONS[0];
  for (const opt of TEMPO_OPTIONS) if (Math.abs(opt.ms - ms) < Math.abs(best.ms - ms)) best = opt;
  return best.label;
}

function styledButton(html, { gold = false } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.innerHTML = html;
  Object.assign(b.style, {
    padding: '6px 12px',
    borderRadius: '8px',
    border: gold ? '1px solid var(--shine)' : '1px solid var(--line)',
    background: gold ? 'color-mix(in oklab, var(--shine) 20%, var(--bg2))' : 'var(--bg2)',
    color: gold ? 'var(--shine)' : 'var(--ink1)',
    fontSize: '.74rem',
    fontWeight: '600',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    flex: 'none',
  });
  return b;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   listCues: () => Array<object>,
 *   captureCue: (name: string) => Promise<{ok: boolean, reason: string|null, cue: object|null}>,
 *   updateCueFadeMs: (id: string, overMs: number) => {ok: boolean, reason: string|null},
 *   moveCueOrder: (id: string, direction: -1|1) => {ok: boolean, reason: string|null},
 *   testFireCue: (id: string) => {ok: boolean, reason: string|null},
 *   revertCueTest: () => {ok: boolean, reason: string|null},
 *   isCueTestActive: () => boolean,
 *   validateCue: (cue: object) => {ok: boolean, errors: string[]},
 * }} ctx
 * @returns {string} department subtitle.
 */
export function renderCuesDepartment(container, ctx) {
  function render() {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', flexDirection: 'column', gap: '10px', maxWidth: '760px' });

    const captureBtn = styledButton(`${iconMarkup('camera')} Capture current look as a cue`, { gold: true });
    captureBtn.style.alignSelf = 'flex-start';
    captureBtn.addEventListener('click', async () => {
      const stamp = new Date().toLocaleTimeString();
      const typed = window.prompt('Name this cue:', `Captured — ${stamp}`);
      const name = typed && typed.trim().length > 0 ? typed.trim() : `Captured — ${stamp}`;
      await ctx.captureCue(name);
      render();
    });
    wrap.append(captureBtn);

    // A test preview survives a department switch (boot.js's own per-frame
    // pump keeps running regardless of which Studio tab is showing) — so
    // this is re-derived from the engine on every render, never tracked as
    // this file's own local state, and stays correct even after navigating
    // away and back mid-test.
    if (ctx.isCueTestActive?.()) {
      const strip = document.createElement('div');
      Object.assign(strip.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        background: 'var(--bg2)',
        border: '1px solid var(--shine)',
        borderRadius: '8px',
        padding: '6px 10px',
        fontSize: '.72rem',
        color: 'var(--ink1)',
      });
      strip.append(document.createTextNode('🔬 A cue test is live on this client only —'));
      const revertBtn = styledButton('↺ Revert now');
      revertBtn.addEventListener('click', () => {
        ctx.revertCueTest();
        render();
      });
      strip.append(revertBtn);
      wrap.append(strip);
    }

    const cues = ctx.listCues();
    if (cues.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:var(--ink2); font-size:.8rem; padding:20px 4px';
      empty.textContent = 'No cues staged yet — capture the world exactly as it is right now to start the stack.';
      wrap.append(empty);
    }

    cues.forEach((cue, i) => {
      const item = document.createElement('div');
      Object.assign(item.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: 'var(--bg1)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-card, 10px)',
        padding: '8px 12px',
      });

      const order = document.createElement('span');
      Object.assign(order.style, { display: 'flex', flexDirection: 'column', gap: '1px', flex: 'none' });
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.title = 'Move up';
      upBtn.textContent = '▲';
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.title = 'Move down';
      downBtn.textContent = '▼';
      for (const b of [upBtn, downBtn]) {
        Object.assign(b.style, {
          width: '18px',
          height: '14px',
          display: 'grid',
          placeItems: 'center',
          background: 'none',
          border: 'none',
          color: 'var(--ink2)',
          cursor: 'pointer',
          fontSize: '.6rem',
          lineHeight: '1',
        });
      }
      upBtn.addEventListener('click', () => {
        ctx.moveCueOrder(cue.id, -1);
        render();
      });
      downBtn.addEventListener('click', () => {
        ctx.moveCueOrder(cue.id, 1);
        render();
      });
      order.append(upBtn, downBtn);

      const cnum = document.createElement('span');
      cnum.textContent = String(i + 1);
      Object.assign(cnum.style, {
        width: '26px',
        height: '26px',
        borderRadius: '50%',
        background: 'var(--bg2)',
        display: 'grid',
        placeItems: 'center',
        fontSize: '.72rem',
        color: 'var(--ink2)',
        flex: 'none',
      });

      const info = document.createElement('span');
      Object.assign(info.style, { flex: '1', minWidth: '0' });
      const nameEl = document.createElement('span');
      nameEl.textContent = cue.name;
      Object.assign(nameEl.style, {
        fontWeight: '600',
        fontSize: '.8rem',
        display: 'block',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      });
      const glyphs = document.createElement('span');
      Object.assign(glyphs.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        color: 'var(--ink2)',
        marginTop: '2px',
      });
      const glyphIcons = Object.keys(cue.targets)
        .map((key) => AXIS_ICON[key.includes('.') ? key.slice(key.indexOf('.') + 1) : key])
        .filter(Boolean)
        .map((icon) => iconMarkup(icon))
        .join('');
      glyphs.innerHTML = glyphIcons;
      const check = ctx.validateCue(cue);
      if (!check.ok) {
        const badge = document.createElement('span');
        badge.textContent = '⚠';
        badge.title = check.errors.join('; ');
        Object.assign(badge.style, { color: 'var(--fail)', fontSize: '.78rem' });
        glyphs.append(badge);
      }
      info.append(nameEl, glyphs);

      const fadeSelect = document.createElement('select');
      Object.assign(fadeSelect.style, {
        background: 'var(--bg2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-ctl, 6px)',
        padding: '4px 8px',
        color: 'var(--ink0)',
        fontSize: '.72rem',
        flex: 'none',
      });
      fadeSelect.title = 'Fade time';
      const currentLabel = nearestTempoLabel(longestOverMs(cue));
      for (const opt of TEMPO_OPTIONS) {
        const o = document.createElement('option');
        o.value = String(opt.ms);
        o.textContent = opt.label;
        o.selected = opt.label === currentLabel;
        fadeSelect.append(o);
      }
      fadeSelect.addEventListener('change', () => {
        ctx.updateCueFadeMs(cue.id, Number(fadeSelect.value));
        render();
      });

      const curveBadge = document.createElement('span');
      const curves = [...new Set(Object.values(cue.targets).map((t) => t.curve))];
      curveBadge.textContent = curves.length === 1 ? curves[0] : 'mixed';
      curveBadge.title = 'Curve — editing this per cue is a real follow-up, not built this round.';
      Object.assign(curveBadge.style, { fontSize: '.66rem', color: 'var(--ink2)', flex: 'none' });

      const testBtn = styledButton('Test');
      testBtn.title = 'Fire this cue now to check it — never persisted, never seen by anyone else.';
      testBtn.addEventListener('click', () => {
        ctx.testFireCue(cue.id);
        render();
      });

      item.append(order, cnum, info, fadeSelect, curveBadge, testBtn);
      wrap.append(item);
    });

    container.innerHTML = '';
    container.append(wrap);
  }

  render();
  return 'captured moments with a fade time — fired from the Remote with GO';
}
