/**
 * ui/rooms/remote/astrolabe-panel.js — the Remote's hero: the astrolabe dial
 * plus its four corner clusters (Testament §9 UM.2; §4.1's prose still says
 * "wings", but the mock retired that shape in round 8 for four corner
 * clusters sitting in the dial's own empty corners — Petition P5's own
 * design, confirmed still current by this round's mock research; see
 * Petition P11). Building against the MOCK'S shipped shape here, not the
 * Law text's older "wings" wording — the mock is the concrete, author-
 * reviewed source once built (docs/holy/UI-Testament.md §10's own ladder).
 *
 * ⚠️ THIS FILE NEVER IMPORTS `effects/`/`world/` INTERNALS. The astrolabe
 * DIAL itself is boot.js's own second live instance (same real handlers as
 * the existing registerPanel('astrolabe', ...) one) — `mountAstrolabeDial`
 * is the door boot.js hands in, matching `ui/rooms/studio/shell.js`'s own
 * documented reason for never importing `effectRegistry` directly. The
 * corner clusters below DO import straight from `foundry/index.js` — the
 * Almanac Pen (`jumpToHour`/`advanceDays`/`advanceWeeks`/`isPenArmed`) is
 * public UI-facing API, the same door `ui/camera-path-dialog.js` already
 * uses for its own foundry/ calls, not an internal boundary crossing.
 *
 * @module ui/rooms/remote/astrolabe-panel
 */

import { jumpToHour, advanceDays, advanceWeeks, isPenArmed } from '../../../foundry/index.js';
import { iconMarkup } from '../../widgets/icon-sprite.js';

/** Dawn/Noon/Dusk/Midnight — matches the mock's own #jumpPop quick-taps. */
const HOUR_JUMPS = Object.freeze([
  { hour: 6, label: 'Next Dawn' },
  { hour: 12, label: 'Next Noon' },
  { hour: 18, label: 'Next Dusk' },
  { hour: 0, label: 'Next Midnight' },
]);

function cornerBox(cornerClass) {
  const el = document.createElement('div');
  el.className = `msa-corner ${cornerClass}`;
  el.setAttribute('role', 'group');
  return el;
}

function iconBtn(icon, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = title;
  btn.innerHTML = iconMarkup(icon);
  btn.addEventListener('click', onClick);
  return btn;
}

function plannedIconBtn(icon, title, plannedReason, onClick) {
  const btn = iconBtn(icon, `${title} — ${plannedReason}`, onClick);
  btn.classList.add('msa-planned');
  return btn;
}

function ghostSlotBtn(onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-ghost-slot';
  btn.title = 'Reserved for a future quick-access shortcut';
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * TL — time progression: play/pause the flow, a speed picker, and jump
 * shortcuts wired to the REAL Almanac Pen. THE FIRST REAL UI CALLER of
 * jumpToHour/advanceDays/advanceWeeks (foundry/time-authority.js's own
 * header notes zero UI callers existed before this). Every gesture reads
 * `getPosture()` FIRST and explains itself when the Pen is unarmed (Law 5 —
 * "nothing broken is silent") rather than trusting a caller-side check
 * alone; `advance()` itself re-checks regardless, but the UI owes the GM the
 * same honesty the engine enforces.
 * @param {{getPosture: () => string, isFlowPlaying: () => boolean,
 *   onFlowToggle: () => void, onStatus: (text: string) => void}} ctx
 */
function buildCornerTL(ctx) {
  const el = cornerBox('msa-corner-tl');
  const armed = () => isPenArmed(ctx.getPosture());
  const explainUnarmed = () =>
    ctx.onStatus(
      `The Pen is not armed — set the Clock to "Almanac" on the astrolabe below first (posture is currently '${ctx.getPosture()}').`
    );

  // Play/pause IS the rate: this system has no separate boolean — "paused"
  // is TIME_RATE_STEPS' own 0 entry, "playing" is whatever non-zero rate was
  // last set (the existing "Time rate" slider's own model, matched here
  // rather than inventing a second, driftable flow flag).
  const flowBtn = iconBtn('sun', ctx.isFlowPlaying() ? 'Pause time flow' : 'Play time flow', () => {
    if (!armed()) return explainUnarmed();
    ctx.onFlowToggle();
    flowBtn.title = ctx.isFlowPlaying() ? 'Pause time flow' : 'Play time flow';
  });

  const jumpBtn = iconBtn('clock', 'Jump to…', async () => {
    if (!armed()) return explainUnarmed();
    // A minimal inline picker — the mock's #jumpPop is a small flyout; here a
    // native-feeling menu of buttons keeps this file free of a second popover
    // implementation for four choices plus two multi-day jumps.
    const menu = document.createElement('div');
    menu.className = 'msa-jump-menu';
    for (const j of HOUR_JUMPS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = j.label;
      b.addEventListener('click', async () => {
        menu.remove();
        const r = await jumpToHour(j.hour, { posture: ctx.getPosture(), source: 'remote-corner-tl' });
        ctx.onStatus(r.ok ? `Jumped to ${j.label.toLowerCase()}.` : `Jump refused: ${r.reason}`);
      });
      menu.appendChild(b);
    }
    for (const [n, label] of [
      [1, '+1 Day'],
      [7, '+1 Week'],
    ]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', async () => {
        menu.remove();
        const fn = label === '+1 Day' ? advanceDays : advanceWeeks;
        const r = await fn(n, { posture: ctx.getPosture(), source: 'remote-corner-tl' });
        ctx.onStatus(r.ok ? `Advanced ${label}.` : `Advance refused: ${r.reason}`);
      });
      menu.appendChild(b);
    }
    jumpBtn.appendChild(menu);
    const closeOnOutside = (e) => {
      if (!menu.contains(e.target) && e.target !== jumpBtn) {
        menu.remove();
        document.removeEventListener('pointerdown', closeOnOutside, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeOnOutside, true), 0);
  });
  jumpBtn.style.position = 'relative';

  const speedBtn = iconBtn('clock', 'Flow speed', () => {
    // Speed is already a real astrolabe control (the "Time rate" slider in
    // the dial below) — this corner slot mirrors it for reach, not a second
    // source of truth. Clicking scrolls the dial's own rate row into view
    // rather than duplicating the state.
    ctx.onScrollToRateControl?.();
  });

  el.append(flowBtn, speedBtn, jumpBtn);
  return el;
}

/**
 * TR — Impulses (Strike/Thunder/Gust). `status:'planned'` chrome this
 * checkpoint, on purpose: the mock already wired these to mock-only
 * animations, but the plan for this migration explicitly stages REAL
 * impulse wiring (effects/lightning.js, wind's ambient term) as U7's job,
 * not U2's — see Petition P11. Marked, not silently built early.
 */
function buildCornerTR(onStatus) {
  const el = cornerBox('msa-corner-tr');
  el.setAttribute('aria-label', 'Impulses');
  const reason = 'Impulses fire for real in a later stage (U7) — this is chrome, not a working button yet.';
  el.append(
    plannedIconBtn('bolt', 'Strike', reason, () => onStatus(reason)),
    plannedIconBtn('cloud', 'Thunder', reason, () => onStatus(reason)),
    plannedIconBtn('wind', 'Gust', reason, () => onStatus(reason))
  );
  return el;
}

/** BL — three genuinely open slots, matching the mock exactly: real,
 * focusable, honest about being unassigned rather than disabled. */
function buildCornerBL(onStatus) {
  const el = cornerBox('msa-corner-bl');
  for (let i = 0; i < 3; i++) {
    el.appendChild(ghostSlotBtn(() => onStatus('Reserved for a future quick-access shortcut.')));
  }
  return el;
}

/** BR — one motion-tiles global transport toggle (planned: no src/ runtime
 * exists for Motion Tiles yet, same honest gap the Studio's SCENE
 * department already names) plus two more open slots. */
function buildCornerBR(onStatus) {
  const el = cornerBox('msa-corner-br');
  const reason = 'Motion Tiles has no src/ runtime yet (V2-only) — this toggle is chrome, not a working transport.';
  el.append(
    plannedIconBtn('gear', 'Play/pause motion tiles', reason, () => onStatus(reason)),
    ghostSlotBtn(() => onStatus('Reserved for a future quick-access shortcut.')),
    ghostSlotBtn(() => onStatus('Reserved for a future quick-access shortcut.'))
  );
  return el;
}

/**
 * @param {HTMLElement} container
 * @param {{mountAstrolabeDial: (el: HTMLElement) => void, getPosture: () => string,
 *   isFlowPlaying: () => boolean, onFlowToggle: () => void}} ctx
 */
export function renderAstrolabePanel(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-astro-wrap';

  const statusLine = document.createElement('div');
  statusLine.className = 'msa-astro-status';
  const onStatus = (text) => {
    statusLine.textContent = text ?? '';
  };

  const dialHost = document.createElement('div');
  dialHost.className = 'msa-astro-dial-host';
  dialHost.append(
    buildCornerTL({ ...ctx, onStatus }),
    buildCornerTR(onStatus),
    buildCornerBL(onStatus),
    buildCornerBR(onStatus)
  );

  const dialSlot = document.createElement('div');
  dialSlot.className = 'msa-astro-dial-slot';
  ctx.mountAstrolabeDial(dialSlot);
  dialHost.appendChild(dialSlot);

  wrap.append(dialHost, statusLine);
  container.appendChild(wrap);
}
