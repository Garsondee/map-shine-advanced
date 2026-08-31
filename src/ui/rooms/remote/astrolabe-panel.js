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
import { buildImpulseButton } from '../../widgets/impulse-button.js';
import { TIME_RATE_STEPS } from '../../astrolabe-geometry.js';

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

function ghostSlotBtn(onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-ghost-slot';
  btn.title = 'Reserved for a future quick-access shortcut';
  btn.addEventListener('click', onClick);
  return btn;
}

/** Non-zero steps only — 0 is "paused," owned entirely by the play/pause
 * toggle below, matching TIME_RATE_STEPS' own "0 = paused" convention. */
const FLOW_SPEED_STEPS = TIME_RATE_STEPS.filter((s) => s > 0);

/** world/day-clock.js's own three postures (ALMANAC_POSTURES) — labels
 * shortened from the old astrolabe.js's own <select> option text for a
 * compact pill, tooltips keep the full wording. */
const CLOCK_MODES = Object.freeze([
  {
    value: 'aesthetic',
    label: 'Aesthetic',
    title: 'Aesthetic — the dial sets the look; Play and Speed drive it directly.',
  },
  { value: 'follow', label: 'Follow', title: "Follow — Foundry's own world clock drives it." },
  {
    value: 'almanac',
    label: 'Almanac',
    title: 'Almanac — Foundry’s clock drives it, and the GM can advance it with Jump.',
  },
]);

/**
 * The Clock-mode control (2026-08-18 fix — gap-audit against the old
 * astrolabe.js's own real `modeSelect`, which the new Remote never ported
 * at all: `getPosture` was read-only everywhere in `ui/rooms/remote/`). A
 * 3-way segmented pill, matching the Direct/Drift precedent already
 * established in `weather-board.js` rather than the old system's native
 * `<select>` — one real vocabulary (`world/day-clock.js`'s own three
 * postures), a new LANTERN presentation. Sits ABOVE the dial, not folded
 * into a drawer: almost everything else in this corner cluster (flow/speed
 * below, Jump-to) depends on which mode is active, so it needs to be seen
 * first.
 * @param {{getPosture: () => string, onSetMode?: (mode: string) => void}} ctx
 * @returns {{el: HTMLElement, sync: () => void}}
 */
function buildClockModeRow(ctx) {
  const el = document.createElement('div');
  el.className = 'msa-clock-mode';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Clock mode');
  const buttons = CLOCK_MODES.map((m) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = m.label;
    btn.title = m.title;
    btn.addEventListener('click', () => {
      ctx.onSetMode?.(m.value);
      sync();
    });
    el.appendChild(btn);
    return btn;
  });
  function sync() {
    const posture = ctx.getPosture();
    for (const [i, m] of CLOCK_MODES.entries()) {
      buttons[i].setAttribute('aria-pressed', String(m.value === posture));
    }
  }
  sync();
  return { el, sync };
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
 *
 * Matches the mock's own three TL tabs exactly (icon play/pause, a "×N" TEXT
 * badge — not a fourth icon — for speed, calendar for jump) rather than the
 * three generic icon buttons this corner shipped with originally (2026-08-18
 * fix, same author report as astrolabe-dial.js's own header: "the buttons
 * around the astrolabe are wrongly positioned"). The speed badge was ALSO a
 * silently-dead control before this fix — `ctx.onScrollToRateControl` was
 * referenced here but never once supplied by boot.js, so every click did
 * nothing (`feedback_unconsumed_api_rots_silently`'s exact shape, caught by
 * grepping for the callback's only other use before assuming it worked).
 * Rebuilt as a real popover over the same TIME_RATE_STEPS the old debug
 * panel's own rate slider already uses, wired to the SAME `editSky` path via
 * `ctx.onSetFlowRate` — one real vocabulary, not a second invented one.
 * @param {{getPosture: () => string, isFlowPlaying: () => boolean,
 *   onFlowToggle: () => void, getFlowRate?: () => number,
 *   onSetFlowRate?: (rate: number) => void, onStatus: (text: string) => void}} ctx
 */
function buildCornerTL(ctx) {
  const el = cornerBox('msa-corner-tl');
  const armed = () => isPenArmed(ctx.getPosture());
  const explainUnarmed = () =>
    ctx.onStatus(
      `The Pen is not armed — set the Clock to "Almanac" above first (posture is currently '${ctx.getPosture()}').`
    );
  // ⚠️⚠️ 2026-08-18 fix — Play/pause and Speed drive `rateHoursPerMinute`,
  // which `world/day-clock.js` only actually USES in 'aesthetic' mode
  // (its own rate branch and `canSetHour` both gate on
  // `currentMode==='aesthetic'`) — a DIFFERENT posture than Jump-to's own
  // `isPenArmed()`/'almanac' requirement below. Gating flow/speed on
  // `isPenArmed()` (this corner's own first build) meant both were
  // non-functional in EVERY reachable state: blocked in Aesthetic (the
  // default) by a check that doesn't apply to them, inert-even-if-reachable
  // in Almanac (where rate drives nothing). Confirmed by reading
  // day-clock.js directly during a full old-vs-new gap audit, not assumed
  // from the old panel's own different gate.
  const aestheticActive = () => ctx.getPosture() === 'aesthetic';
  const explainNotAesthetic = () =>
    ctx.onStatus(
      `Time flow only runs in Aesthetic mode — the Clock above is set to '${ctx.getPosture()}'. Switch it to Aesthetic first.`
    );

  // Play/pause IS the rate: this system has no separate boolean — "paused"
  // is TIME_RATE_STEPS' own 0 entry, "playing" is whatever non-zero rate was
  // last set (the existing "Time rate" slider's own model, matched here
  // rather than inventing a second, driftable flow flag).
  const flowBtn = iconBtn(
    ctx.isFlowPlaying() ? 'pause' : 'play',
    ctx.isFlowPlaying() ? 'Pause time flow' : 'Play time flow',
    () => {
      if (!aestheticActive()) return explainNotAesthetic();
      ctx.onFlowToggle();
      syncFlowBtn();
    }
  );
  flowBtn.setAttribute('aria-pressed', String(ctx.isFlowPlaying()));
  function syncFlowBtn() {
    const playing = ctx.isFlowPlaying();
    flowBtn.innerHTML = iconMarkup(playing ? 'pause' : 'play');
    flowBtn.title = playing ? 'Pause time flow' : 'Play time flow';
    flowBtn.setAttribute('aria-pressed', String(playing));
  }

  const speedBtn = document.createElement('button');
  speedBtn.type = 'button';
  speedBtn.className = 'msa-corner-txt';
  speedBtn.title = 'Time speed — how fast the world clock runs';
  speedBtn.style.position = 'relative';
  function syncSpeedBtn() {
    const rate = ctx.getFlowRate?.() ?? 0;
    speedBtn.textContent = `×${rate > 0 ? rate : FLOW_SPEED_STEPS[0]}`;
  }
  speedBtn.addEventListener('click', () => {
    if (!aestheticActive()) return explainNotAesthetic();
    const current = ctx.getFlowRate?.() ?? 0;
    const menu = document.createElement('div');
    menu.className = 'msa-jump-menu';
    for (const step of FLOW_SPEED_STEPS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `×${step}`;
      b.setAttribute('aria-pressed', String(step === current));
      b.addEventListener('click', (e) => {
        // Without this, the click bubbles from b -> menu -> speedBtn, and
        // speedBtn's OWN listener (below) re-opens a fresh menu right after
        // this one is removed — a real bug, caught live (a stray menu <div>
        // still attached to speedBtn's children after picking a speed),
        // not assumed safe just because menu.remove() "looked" sufficient.
        e.stopPropagation();
        menu.remove();
        ctx.onSetFlowRate?.(step);
        syncSpeedBtn();
        syncFlowBtn();
      });
      menu.appendChild(b);
    }
    speedBtn.appendChild(menu);
    const closeOnOutside = (e) => {
      if (!menu.contains(e.target) && e.target !== speedBtn) {
        menu.remove();
        document.removeEventListener('pointerdown', closeOnOutside, true);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', closeOnOutside, true), 0);
  });
  syncSpeedBtn();

  const jumpBtn = iconBtn('calendar', 'Jump to…', async () => {
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
      // stopPropagation, same reason as the speed popover's own item
      // handler above: unguarded, this click bubbles to jumpBtn's own
      // listener and silently reopens a fresh menu right after this one is
      // removed (a real, pre-existing bug this same fix closes here too).
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
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
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
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

  el.append(flowBtn, speedBtn, jumpBtn);
  return {
    el,
    sync: () => {
      syncFlowBtn();
      syncSpeedBtn();
    },
  };
}

/**
 * TR — Impulses. U7 (docs/holy/UI-Testament.md §9): renders whatever
 * `ctx.impulses` declares — Law 1 ("every control is a generated
 * projection of a declaration"), so this corner never hand-lists Strike/
 * Thunder/Gust by name and cannot silently miss a future fourth impulse.
 * An empty/absent list renders the corner empty rather than inventing
 * placeholder chrome — Law 5's "nothing to show" case.
 * @param {Array<import('../../../core/impulse-schema.js').ImpulseDecl>} impulses
 * @param {(text: string) => void} onStatus
 */
function buildCornerTR(impulses, onStatus) {
  const el = cornerBox('msa-corner-tr');
  el.setAttribute('aria-label', 'Impulses');
  for (const decl of impulses ?? []) el.append(buildImpulseButton(decl, { onStatus }));
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

/** BR — Tile Motion (2026-08-27: `foundry/tile-motion-runtime.js` shipped
 * the same session this corner's own old "no src/ runtime yet" stub was
 * written against, making that reason stale within the day) plus two more
 * open slots. Opens `ui/rooms/remote/tile-motion-panel.js` — the SAME
 * consolidated panel Studio's Scene department "Open" button and the
 * Lab's own 'tile-motion-open' action both reach, never a second
 * implementation living behind this corner specifically. */
function buildCornerBR(onStatus, onOpenTileMotion) {
  const el = cornerBox('msa-corner-br');
  el.append(
    iconBtn('play', 'Tile motion', () => onOpenTileMotion?.()),
    ghostSlotBtn(() => onStatus('Reserved for a future quick-access shortcut.')),
    ghostSlotBtn(() => onStatus('Reserved for a future quick-access shortcut.'))
  );
  return el;
}

/**
 * @param {HTMLElement} container
 * @param {{mountAstrolabeDial: (el: HTMLElement, dialCtx: {onLockedAttempt: () => void, onWindClick?: () => void}) => void,
 *   getPosture: () => string,
 *   onSetMode?: (mode: string) => void, isFlowPlaying: () => boolean,
 *   onFlowToggle: () => void, getFlowRate?: () => number,
 *   onSetFlowRate?: (rate: number) => void,
 *   onWindClick?: () => void, onOpenTileMotion?: () => void,
 *   impulses?: Array<import('../../../core/impulse-schema.js').ImpulseDecl>}} ctx
 * @returns {{syncFlowState: () => void}} `syncFlowState` re-reads
 *   `getPosture`/`isFlowPlaying`/`getFlowRate` and repaints the Clock-mode
 *   row AND the TL corner — boot.js's own `pumpAstrolabe` calls this every
 *   tick, the same "never polls on its own, it's told" shape
 *   `shell.js#refreshWeatherBoard`/`refreshCueDeck` already use, so nothing
 *   here can go stale when state changes from elsewhere (the old panel's
 *   own controls, another connected client).
 */
export function renderAstrolabePanel(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-astro-wrap';

  const statusLine = document.createElement('div');
  statusLine.className = 'msa-astro-status';
  const onStatus = (text) => {
    statusLine.textContent = text ?? '';
  };
  // The ring's own lock explanation (2026-08-18 fix, gap-audit Gap 12) —
  // same underlying gate as buildCornerTL's own `explainNotAesthetic`
  // (`canSetHour`/rate both key off `currentMode==='aesthetic'`,
  // day-clock.js), worded for a drag/key attempt rather than a flow toggle
  // since the two land on genuinely different verbs ("set the hour" vs.
  // "run"). Kept as its own small closure rather than shared with
  // buildCornerTL's copy — the wording is deliberately different, and
  // sharing it would leave one of the two contexts saying the wrong verb.
  const explainRingLocked = () =>
    onStatus(
      `The dial is locked to Foundry's own clock — set the Clock above to Aesthetic to drag it directly (currently '${ctx.getPosture()}').`
    );

  const clockMode = buildClockModeRow(ctx);

  const dialHost = document.createElement('div');
  dialHost.className = 'msa-astro-dial-host';
  const cornerTL = buildCornerTL({ ...ctx, onStatus });
  dialHost.append(
    cornerTL.el,
    buildCornerTR(ctx.impulses, onStatus),
    buildCornerBL(onStatus),
    buildCornerBR(onStatus, ctx.onOpenTileMotion)
  );

  const dialSlot = document.createElement('div');
  dialSlot.className = 'msa-astro-dial-slot';
  // onWindClick (UI parity plan, phase 6a) — straight pass-through, same
  // shape as onLockedAttempt just above: this file has no opinion about
  // the gesture, it just forwards ctx's own handler to the dial that
  // actually renders the clickable surface for it. onTimeStop needs no
  // equivalent forwarding — boot.js's own mountAstrolabeDial wires the
  // real engine call directly (see its own comment), matching
  // onTimeChange's identical precedent two lines above it there.
  ctx.mountAstrolabeDial(dialSlot, {
    onLockedAttempt: explainRingLocked,
    onWindClick: ctx.onWindClick,
  });
  dialHost.appendChild(dialSlot);

  wrap.append(clockMode.el, dialHost, statusLine);
  container.appendChild(wrap);

  return {
    syncFlowState: () => {
      clockMode.sync();
      cornerTL.sync();
    },
  };
}
