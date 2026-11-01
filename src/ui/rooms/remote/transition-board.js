/**
 * ui/rooms/remote/transition-board.js — TRANSITIONS (author, 2026-10-26), GM-only.
 *
 * Two halves, matching how the author wants to use it — "set and forget the default whilst
 * retaining the power to override and play out unusual transitions when they want to" — and,
 * since the Remote's 2026-11-01 redesign, living in two different tabs:
 *
 *  1. THE DEFAULT ({@link renderTransitionDefaults}, Prep tab) — one style and a pace. It plays
 *     at every load, scene change and floor change, for everyone; floors play it quicker
 *     (`ui/scene-transition.js#MOMENT_TIMINGS`). Set once, so it lives with the other set-once
 *     settings; the timings are in each chip's tooltip rather than printed on every row.
 *  2. THE NEXT SCENE CHANGE ({@link renderTransitionArm}, Play tab) — a pad. Pick something
 *     dramatic (MSA's own, or any effect in Foundry's own catalogue), a duration, Arm it; it
 *     plays once, for the table, on the next scene change, then disarms itself. The pad glows
 *     and names what is armed, so the GM can see it from across the table.
 *
 * @module ui/rooms/remote/transition-board
 */

import {
  TRANSITION_PRESETS,
  TRANSITION_PRESET_IDS,
  TRANSITION_PACES,
  summarisePreset,
} from '../../scene-transition.js';
import { iconMarkup } from '../../widgets/icon-sprite.js';
import { setTip } from '../../widgets/tooltip.js';

/** Durations offered for an armed override (ms). */
export const OVERRIDE_DURATIONS_MS = Object.freeze([1500, 3000, 5000]);

function chip(text, title, pressed, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-wx-chip';
  btn.textContent = text;
  if (title) btn.title = title;
  btn.setAttribute('aria-pressed', String(pressed));
  btn.addEventListener('click', onClick);
  return btn;
}

/** "3 s", "1.5 s". */
export function formatSeconds(ms) {
  const s = Math.round((Number(ms) || 0) / 100) / 10;
  return `${s} s`;
}

/**
 * The status line for an armed override.
 * @param {{type?: string, durationMs?: number}|null} override
 * @param {Array<{id: string, label: string}>} choices
 */
export function describeOverride(override, choices) {
  if (!override?.type) return 'Nothing armed — the default plays.';
  const label = choices.find((c) => c.id === override.type)?.label ?? override.type;
  const when = Number.isFinite(override.durationMs) ? `, ${formatSeconds(override.durationMs)}` : '';
  return `Armed: ${label}${when}. Plays once on the next scene change.`;
}

/**
 * Prep: the default every cut plays, and its pace.
 * @param {HTMLElement} container
 * @param {{getDefaults: () => {preset: string, pace: string}, onSetPreset: (id: string) => void,
 *   onSetPace: (id: string) => void}} ctx
 * @returns {{refresh: () => void}}
 */
export function renderTransitionDefaults(container, ctx) {
  const presetGrid = document.createElement('div');
  presetGrid.className = 'msa-wx-chips msa-chip-grid';
  const paceRow = document.createElement('div');
  paceRow.className = 'msa-seg-row';
  paceRow.setAttribute('role', 'group');
  paceRow.setAttribute('aria-label', 'Transition pace');
  container.append(presetGrid, paceRow);

  function paint() {
    const { preset, pace } = ctx.getDefaults();
    presetGrid.replaceChildren(
      ...TRANSITION_PRESET_IDS.map((id) => {
        const p = TRANSITION_PRESETS[id];
        const { sceneMs, floorMs } = summarisePreset(id, pace);
        const timing =
          sceneMs === 0 ? 'Instant.' : `Scenes ${formatSeconds(sceneMs)}, floors ${formatSeconds(floorMs)}.`;
        return chip(p.label, `${p.hint} ${timing}`, id === preset, () => {
          ctx.onSetPreset(id);
          paint();
        });
      })
    );
    paceRow.replaceChildren(
      ...Object.entries(TRANSITION_PACES).map(([id, p]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'msa-seg';
        b.textContent = p.label;
        b.title = `Every duration × ${p.scale}.`;
        b.setAttribute('aria-pressed', String(id === pace));
        b.addEventListener('click', () => {
          ctx.onSetPace(id);
          paint();
        });
        return b;
      })
    );
  }
  paint();
  return { refresh: paint };
}

/**
 * Play: the "next scene change" pad and its picker.
 * @param {HTMLElement} padHost - where the pad button goes (the pads row)
 * @param {HTMLElement} popHost - where the picker unfolds (under the pads row)
 * @param {{listOverrideChoices: () => Array<{id: string, label: string, group: string}>,
 *   getOverride: () => {type?: string, durationMs?: number}|null,
 *   onArm: (v: {type: string, durationMs: number}) => void, onDisarm: () => void}} ctx
 * @returns {{refresh: () => void}}
 */
export function renderTransitionArm(padHost, popHost, ctx) {
  const pad = document.createElement('button');
  pad.type = 'button';
  pad.className = 'msa-pad';
  pad.setAttribute('aria-expanded', 'false');
  const padIcon = document.createElement('span');
  padIcon.className = 'msa-pad-ico';
  padIcon.innerHTML = iconMarkup('clap');
  const padLabel = document.createElement('span');
  padLabel.className = 'msa-pad-label';
  pad.append(padIcon, padLabel);
  padHost.appendChild(pad);

  const pop = document.createElement('div');
  pop.className = 'msa-arm-pop';
  pop.hidden = true;
  popHost.appendChild(pop);

  let draftType = null;
  let draftDurationMs = OVERRIDE_DURATIONS_MS[1];

  function paintPad() {
    const armed = ctx.getOverride();
    const choices = ctx.listOverrideChoices();
    const label = armed?.type ? (choices.find((c) => c.id === armed.type)?.label ?? armed.type) : null;
    padLabel.textContent = label ? `Armed: ${label}` : 'Next scene';
    pad.dataset.armed = String(Boolean(label));
    setTip(pad, describeOverride(armed, choices) + ' Click to choose.');
  }

  function paintPop() {
    const choices = ctx.listOverrideChoices();
    const armed = ctx.getOverride();
    if (draftType === null || !choices.some((c) => c.id === draftType))
      draftType = armed?.type ?? choices[0]?.id ?? null;
    const head = document.createElement('div');
    head.className = 'msa-hint';
    head.textContent = 'Plays once, for everyone, on the next scene change. Then the default returns.';
    const grid = document.createElement('div');
    grid.className = 'msa-wx-chips msa-chip-grid';
    for (const c of choices.filter((x) => x.group === 'msa')) {
      grid.appendChild(
        chip(c.label, 'Map Shine transition', c.id === draftType, () => {
          draftType = c.id;
          paintPop();
        })
      );
    }
    const foundry = choices.filter((x) => x.group === 'foundry');
    const parts = [head, grid];
    if (foundry.length > 0) {
      const sel = document.createElement('select');
      sel.className = 'msa-select';
      sel.title = "One of Foundry's own transitions (module-added ones included).";
      sel.append(new Option('Foundry transitions…', ''));
      for (const c of foundry) sel.append(new Option(c.label, c.id, false, c.id === draftType));
      sel.addEventListener('change', () => {
        if (sel.value) {
          draftType = sel.value;
          paintPop();
        }
      });
      parts.push(sel);
    }
    const durations = document.createElement('div');
    durations.className = 'msa-seg-row';
    for (const ms of OVERRIDE_DURATIONS_MS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msa-seg';
      b.textContent = formatSeconds(ms);
      b.setAttribute('aria-pressed', String(ms === draftDurationMs));
      b.addEventListener('click', () => {
        draftDurationMs = ms;
        paintPop();
      });
      durations.appendChild(b);
    }
    const actions = document.createElement('div');
    actions.className = 'msa-look-form-row';
    if (armed?.type) {
      const disarm = document.createElement('button');
      disarm.type = 'button';
      disarm.className = 'msa-btn';
      disarm.textContent = 'Disarm';
      disarm.addEventListener('click', () => {
        ctx.onDisarm();
        close();
      });
      actions.appendChild(disarm);
    }
    const arm = document.createElement('button');
    arm.type = 'button';
    arm.className = 'msa-btn msa-btn--gold';
    arm.textContent = armed?.type ? 'Re-arm' : 'Arm';
    arm.disabled = !draftType;
    arm.addEventListener('click', () => {
      if (!draftType) return;
      ctx.onArm({ type: draftType, durationMs: draftDurationMs });
      close();
    });
    actions.appendChild(arm);
    parts.push(durations, actions);
    pop.replaceChildren(...parts);
  }

  function close() {
    pop.hidden = true;
    pad.setAttribute('aria-expanded', 'false');
  }

  pad.addEventListener('click', () => {
    if (!pop.hidden) return close();
    paintPop();
    pop.hidden = false;
    pad.setAttribute('aria-expanded', 'true');
  });

  paintPad();
  return {
    refresh() {
      paintPad();
      if (!pop.hidden) paintPop();
    },
  };
}
