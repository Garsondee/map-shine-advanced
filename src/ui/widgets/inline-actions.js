/**
 * ui/widgets/inline-actions.js — the two things the Studio used to ask the
 * browser's native dialogs to do, done in place instead:
 *
 *  - CONFIRM a destructive click → {@link buildArmButton}: the first click arms
 *    the button (it relabels and turns red), a second click within a few
 *    seconds fires, anything else disarms. The same two-click confirm the
 *    Remote's Safety button already uses (`rooms/remote/shell.js#
 *    dangerFooterBtn`), so the two rooms agree on what "are you sure" looks like.
 *  - ASK FOR A NAME → {@link buildNameComposer}: a one-line field with Save and
 *    Cancel that opens where the click happened, replacing `window.prompt`.
 *
 * WHY NOT `window.prompt/confirm/alert`. They block the whole tab — and in a
 * game whose canvas is a live WebGPU renderer that means every frame stops
 * dead behind a grey OS dialog that ignores the theme — and they pull the GM's
 * eye off the panel they were working in. In-place is both faster to answer
 * and does not freeze the table's map while you decide.
 *
 * The timing/validation rules are pure and tested in Node
 * ({@link createArmMachine}, {@link normalizeName}); the DOM builders are
 * verified live in the studio-preview harness.
 *
 * @module ui/widgets/inline-actions
 */

import { iconMarkup } from './icon-sprite.js';
import { setTip } from './tooltip.js';

/** How long an armed button waits for its second click. */
export const ARM_MS = 4000;

/**
 * The arm → confirm state machine, free of the DOM.
 * @param {{armMs?: number, onArm?: () => void, onDisarm?: () => void,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (h: any) => void}} [deps]
 * @returns {{press: (needsConfirm?: boolean) => boolean, disarm: () => void, isArmed: () => boolean}}
 *   `press()` returns `true` exactly when this press CONFIRMS (fires the action).
 *   `press(false)` is for an action that only SOMETIMES needs asking about (replace
 *   what is there, versus fill an empty list): while disarmed it fires at once and
 *   never arms; an already-armed button still takes its second press as the confirm.
 */
export function createArmMachine({
  armMs = ARM_MS,
  onArm = () => {},
  onDisarm = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
} = {}) {
  let armed = false;
  let timer = null;
  function disarm() {
    if (!armed) return;
    armed = false;
    if (timer !== null) clearTimer(timer);
    timer = null;
    onDisarm();
  }
  return {
    press(needsConfirm = true) {
      if (!armed) {
        if (!needsConfirm) return true;
        armed = true;
        onArm();
        timer = setTimer(disarm, armMs);
        return false;
      }
      disarm();
      return true;
    },
    disarm,
    isArmed: () => armed,
  };
}

/**
 * Trim a typed name and apply the empty-name policy.
 * @param {string} raw
 * @param {{allowEmpty?: boolean, fallback?: string}} [opts] `allowEmpty` +
 *   `fallback` — an empty entry becomes the fallback instead of being refused
 *   (the cue capture's "one-click capture must never dead-end" rule).
 * @returns {{ok: true, name: string} | {ok: false}}
 */
export function normalizeName(raw, { allowEmpty = false, fallback = '' } = {}) {
  const name = String(raw ?? '').trim();
  if (name.length > 0) return { ok: true, name };
  if (allowEmpty) return { ok: true, name: fallback };
  return { ok: false };
}

function labelled(icon, text) {
  const frag = document.createDocumentFragment();
  if (icon) {
    const holder = document.createElement('span');
    holder.className = 'msa-btn-ico';
    holder.innerHTML = iconMarkup(icon);
    frag.append(holder);
  }
  if (text) {
    const span = document.createElement('span');
    span.textContent = text;
    frag.append(span);
  }
  return frag;
}

/**
 * A button that needs two clicks to fire. Icon-only while idle (if `label` is
 * omitted), growing a short red label while armed so the second click is never
 * a surprise.
 * @param {{icon?: string, label?: string, armedLabel?: string|(() => string), title?: string,
 *   armedTitle?: string|(() => string), className?: string, onConfirm: () => void,
 *   needsConfirm?: () => boolean}} opts
 *   `armedLabel`/`armedTitle` may be functions, read at the moment the button arms
 *   ("Replace 3 keyframes?" — the count is only known then). `needsConfirm` is asked
 *   on each press of a disarmed button: false fires `onConfirm` straight away, so an
 *   action that is only destructive sometimes (replacing keyframes that exist) asks
 *   only then.
 * @returns {HTMLButtonElement}
 */
export function buildArmButton({
  icon,
  label = '',
  armedLabel = 'Click again to confirm',
  title = '',
  armedTitle = 'Click again within a few seconds to confirm',
  className = 'msa-btn msa-btn--sm',
  onConfirm,
  needsConfirm = () => true,
}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  const read = (v) => (typeof v === 'function' ? v() : v);
  const paint = (armed) => {
    btn.replaceChildren(labelled(icon, armed ? read(armedLabel) : label));
    // `setTip`, not `.title =`: once the themed tooltip has taken a hover over,
    // the text lives in `data-tip`, and a plain `title` would bring the native one back.
    setTip(btn, armed ? read(armedTitle) : title);
    btn.classList.toggle('is-armed', armed);
    btn.setAttribute('aria-live', 'polite');
  };
  const machine = createArmMachine({ onArm: () => paint(true), onDisarm: () => paint(false) });
  paint(false);
  btn.addEventListener('click', () => {
    if (machine.press(needsConfirm())) onConfirm();
  });
  // Clicking elsewhere (focus moves away) cancels, so a half-forgotten armed
  // button does not sit there red and loaded.
  btn.addEventListener('blur', () => machine.disarm());
  return btn;
}

/**
 * A one-line "name this" field with Save / Cancel.
 * @param {{initial?: string, placeholder?: string, ariaLabel?: string, submitLabel?: string,
 *   allowEmpty?: boolean, fallback?: string,
 *   onSubmit: (name: string) => void, onCancel?: () => void}} opts
 * @returns {{el: HTMLElement, focus: () => void}} call `focus()` AFTER the
 *   element is in the document (it selects the prefilled text).
 */
export function buildNameComposer({
  initial = '',
  placeholder = 'Name',
  ariaLabel = 'Name',
  submitLabel = 'Save',
  allowEmpty = false,
  fallback = '',
  onSubmit,
  onCancel,
}) {
  const el = document.createElement('div');
  el.className = 'msa-compose';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'msa-input';
  input.value = initial;
  input.placeholder = placeholder;
  input.setAttribute('aria-label', ariaLabel);
  input.autocomplete = 'off';
  input.spellcheck = false;

  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'msa-btn msa-btn--gold msa-btn--sm';
  submit.textContent = submitLabel;

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'hbtn';
  cancel.title = 'Cancel';
  cancel.setAttribute('aria-label', 'Cancel');
  cancel.innerHTML = iconMarkup('x');

  const commit = () => {
    const result = normalizeName(input.value, { allowEmpty, fallback });
    if (!result.ok) {
      // Refuse an empty name in place: flag the field and keep it open. The
      // attribute is cleared on the next keystroke.
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    onSubmit(result.name);
  };
  submit.addEventListener('click', commit);
  cancel.addEventListener('click', () => onCancel?.());
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel?.();
    }
  });

  el.append(input, submit, cancel);
  return {
    el,
    focus() {
      input.focus();
      input.select();
    },
  };
}
