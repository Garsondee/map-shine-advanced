/**
 * ui/rooms/studio/cues-department.js — THE CUES DEPARTMENT (U3, docs/holy/
 * UI-Testament.md §5.4): capture-first authoring. A big Capture button, the
 * stack as reorderable cards (name · fade time · curve · what it touches),
 * a validity badge per cue, test-fire with an instant revert. Ported layout
 * from the mock's `#cueBuild`/`.cueitem` (tools/ui-mock/index.html) — see
 * Petition P15 for exactly what changed in the port.
 *
 * ⚠️ NAMING IS INLINE, NOT A NATIVE `prompt()` (changed 2026-10-18). The mock's
 * own Capture button never actually asks for a name at all — its `.cname` is
 * static, unwired text (a real gap in the mock itself). "Capture-then-name"
 * (§4.3) reads as ONE gesture, so Capture opens a one-line name field right
 * where the button was, pre-filled with a clock-stamped default and selected —
 * type to replace it, or just press Enter. A cancelled/empty entry still
 * captures under the default name: a one-click "capture the moment" action
 * must never dead-end. (The old native `prompt()` froze the whole tab — and
 * the live map with it — behind a grey OS dialog that ignored the theme.)
 * Deleting is a two-click confirm on the button itself, and every refusal the
 * engine returns (a test already running, a bad fade time, a failed capture)
 * now shows as a line of text instead of vanishing.
 *
 * ⚠️ CURVE IS DISPLAY-ONLY THIS ROUND. The mock's own per-cue `<select>`
 * (labelled fade time) has no `onchange` handler wired anywhere in the
 * mock either — decorative there. This file's OWN fade-time select IS
 * wired for real (`ctx.updateCueFadeMs`); curve is shown as a small badge
 * next to it, matching §5.4's "name · fade time · curve · what it
 * touches" as a set of DISPLAYED properties — editing curve per cue is a
 * real, scoped follow-up, not built this round.
 *
 * @module ui/rooms/studio/cues-department
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';
import { buildImpulseButton } from '../../widgets/impulse-button.js';
import { buildArmButton, buildNameComposer } from '../../widgets/inline-actions.js';

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

/** Tiny element factory. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A `.msa-btn`, optionally with a leading icon. */
function button(label, { icon, gold = false, small = false, title } = {}) {
  const b = el('button', `msa-btn${gold ? ' msa-btn--gold' : ''}${small ? ' msa-btn--sm' : ''}`);
  b.type = 'button';
  if (icon) b.insertAdjacentHTML('beforeend', iconMarkup(icon));
  b.append(document.createTextNode(label));
  if (title) b.title = title;
  return b;
}

/** A `.hbtn` icon-only button with an accessible name. */
function iconButton(icon, title, extraClass = '') {
  const b = el('button', `hbtn${extraClass ? ` ${extraClass}` : ''}`);
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = iconMarkup(icon);
  return b;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   listCues: () => Array<object>,
 *   captureCue: (name: string) => Promise<{ok: boolean, reason: string|null, cue: object|null}>,
 *   updateCueFadeMs: (id: string, overMs: number) => {ok: boolean, reason: string|null},
 *   moveCueOrder: (id: string, direction: -1|1) => {ok: boolean, reason: string|null},
 *   deleteCue?: (id: string) => {ok: boolean, reason: string|null},
 *   testFireCue: (id: string) => {ok: boolean, reason: string|null},
 *   revertCueTest: () => {ok: boolean, reason: string|null},
 *   isCueTestActive: () => boolean,
 *   validateCue: (cue: object) => {ok: boolean, errors: string[]},
 *   impulses?: Array<import('../../../core/impulse-schema.js').ImpulseDecl>,
 * }} ctx
 * @returns {string} department subtitle.
 */
export function renderCuesDepartment(container, ctx) {
  /** A refusal/failure to show once, on the next paint (then it is gone). */
  let flash = null;
  const complain = (res, fallback) => {
    if (res && res.ok === false) flash = { text: res.reason || fallback, tone: 'fail' };
  };

  function render() {
    const wrap = el('div', 'msa-cues');

    // ---- capture: one button that becomes a name field in place --------------
    const captureRow = el('div', 'msa-row-flex');
    const captureBtn = button('Capture current look as a cue', { icon: 'camera', gold: true });
    captureBtn.addEventListener('click', () => {
      const stamp = new Date().toLocaleTimeString();
      const fallback = `Captured — ${stamp}`;
      const composer = buildNameComposer({
        initial: fallback,
        placeholder: 'Cue name',
        ariaLabel: 'Name this cue',
        submitLabel: 'Capture',
        allowEmpty: true,
        fallback,
        onCancel: render,
        onSubmit: async (name) => {
          complain(await ctx.captureCue(name), 'Could not capture the cue.');
          render();
        },
      });
      captureRow.replaceChildren(composer.el);
      composer.focus();
    });
    captureRow.append(captureBtn);
    wrap.append(captureRow);

    // A test preview survives a department switch (boot.js's own per-frame
    // pump keeps running regardless of which Studio tab is showing) — so
    // this is re-derived from the engine on every render, never tracked as
    // this file's own local state, and stays correct even after navigating
    // away and back mid-test.
    if (ctx.isCueTestActive?.()) {
      const strip = el('div', 'msa-testbar');
      strip.insertAdjacentHTML('beforeend', iconMarkup('flask'));
      strip.append(document.createTextNode('A cue test is live on this client only —'));
      const revertBtn = button('Revert now', { icon: 'reset', small: true });
      revertBtn.addEventListener('click', () => {
        complain(ctx.revertCueTest(), 'Could not revert the test.');
        render();
      });
      strip.append(revertBtn);
      wrap.append(strip);
    }

    if (flash) {
      const note = el('p', 'msa-status', flash.text);
      note.dataset.tone = flash.tone;
      note.setAttribute('role', 'status');
      wrap.append(note);
      flash = null;
    }

    const cues = ctx.listCues();
    if (cues.length === 0) {
      wrap.append(
        el('div', 'msa-empty', 'No cues staged yet — capture the world exactly as it is right now to start the stack.')
      );
    }

    cues.forEach((cue, i) => {
      const item = el('div', 'msa-cue');

      const order = el('span', 'msa-cue-order');
      // `.hbtn` (studio-style.js, shared by every icon-only tool in this room)
      // for a real click target — the original 18×14px box, half the room's
      // own header-button size, was a real miss to land a click on. A
      // chevron icon turned a quarter each way, not a ▲/▼ text glyph.
      const upBtn = iconButton('chev', 'Move up', 'msa-cue-up');
      const downBtn = iconButton('chev', 'Move down', 'msa-cue-down');
      upBtn.addEventListener('click', () => {
        ctx.moveCueOrder(cue.id, -1);
        render();
      });
      downBtn.addEventListener('click', () => {
        ctx.moveCueOrder(cue.id, 1);
        render();
      });
      order.append(upBtn, downBtn);

      const cnum = el('span', 'msa-cue-num', String(i + 1));

      const info = el('span', 'msa-cue-info');
      const nameEl = el('span', 'msa-cue-name', cue.name);
      nameEl.dataset.tip = cue.name;
      nameEl.dataset.tipTruncated = '';
      const glyphs = el('span', 'msa-cue-glyphs');
      glyphs.innerHTML = Object.keys(cue.targets)
        .map((key) => AXIS_ICON[key.includes('.') ? key.slice(key.indexOf('.') + 1) : key])
        .filter(Boolean)
        .map((icon) => iconMarkup(icon))
        .join('');
      const check = ctx.validateCue(cue);
      if (!check.ok) {
        const badge = el('span', 'msa-cue-warn');
        badge.innerHTML = iconMarkup('warn');
        badge.title = check.errors.join('; ');
        glyphs.append(badge);
      }
      info.append(nameEl, glyphs);

      const fadeSelect = el('select', 'msa-select');
      fadeSelect.title = 'Fade time';
      fadeSelect.setAttribute('aria-label', `Fade time for ${cue.name}`);
      const currentLabel = nearestTempoLabel(longestOverMs(cue));
      for (const opt of TEMPO_OPTIONS) {
        const o = el('option', '', opt.label);
        o.value = String(opt.ms);
        o.selected = opt.label === currentLabel;
        fadeSelect.append(o);
      }
      fadeSelect.addEventListener('change', () => {
        complain(ctx.updateCueFadeMs(cue.id, Number(fadeSelect.value)), 'Could not change the fade time.');
        render();
      });

      const curveBadge = el('span', 'msa-cue-curve');
      const curves = [...new Set(Object.values(cue.targets).map((t) => t.curve))];
      curveBadge.textContent = curves.length === 1 ? curves[0] : 'mixed';
      curveBadge.title = 'Curve — editing this per cue is a real follow-up, not built this round.';

      const testBtn = button('Test', { icon: 'play', small: true });
      testBtn.title = 'Fire this cue now to check it — never persisted, never seen by anyone else.';
      testBtn.addEventListener('click', () => {
        complain(ctx.testFireCue(cue.id), 'Could not test this cue.');
        render();
      });

      item.append(order, cnum, info, fadeSelect, curveBadge, testBtn);
      if (typeof ctx.deleteCue === 'function') {
        item.append(
          buildArmButton({
            icon: 'trash',
            armedLabel: 'Delete?',
            title: 'Delete this cue from the stack',
            armedTitle: `Click again to delete "${cue.name}"`,
            className: 'hbtn',
            onConfirm: () => {
              complain(ctx.deleteCue(cue.id), 'Could not delete the cue.');
              render();
            },
          })
        );
      }
      wrap.append(item);
    });

    // ---- IMPULSES (U7, §4.4) — the Studio's full list -----------------------
    // A DIFFERENT concept from the cue stack above, sharing this department
    // only because both are "something the GM fires from the Remote" (a
    // worker-tier placement call, not dictated by the Testament — worth the
    // author's own countersign if CUES is the wrong home; see the U7
    // Petition). Cues fade; impulses "ignore Fade Time" by their own
    // definition (§4.1's grammar table) — kept visually separate, never
    // blended into the cue list itself.
    const impulses = ctx.impulses ?? [];
    if (impulses.length > 0) {
      const row = el('div', 'msa-row-flex');
      row.style.flexWrap = 'wrap';
      row.style.gap = '8px';
      const statusEl = el('div', 'msa-status');
      statusEl.setAttribute('role', 'status');
      const onStatus = (text) => {
        statusEl.textContent = text ?? '';
      };
      for (const decl of impulses) row.append(buildImpulseButton(decl, { onStatus, showLabel: true }));
      wrap.append(
        el('div', 'msa-sep'),
        el('div', 'msa-eyebrow', 'IMPULSES — instant, ignore Fade Time'),
        row,
        statusEl
      );
    }

    container.innerHTML = '';
    container.append(wrap);
  }

  render();
  return 'captured moments with a fade time — fired from the Remote with GO';
}
