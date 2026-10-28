/**
 * ui/rooms/remote/transition-board.js — THE TRANSITIONS BOARD (author, 2026-10-26), GM-only.
 *
 * Two halves, matching how the author wants to use it — "set and forget the default whilst
 * retaining the power to override and play out unusual transitions when they want to":
 *
 *  1. DEFAULT — one style (Fade through black, Dissolve, Cut) and a pace (Brisk, Measured, Slow).
 *     It plays at every load, scene change and floor change, for everyone; floors play it quicker
 *     (`ui/scene-transition.js#MOMENT_TIMINGS`).
 *  2. NEXT SCENE CHANGE — pick something dramatic (MSA's own, or any effect in Foundry's own
 *     catalogue, module-added ones included), a duration, and Arm it. It plays once, for the
 *     table, on the next scene change, then disarms itself.
 *
 * Mirrors `player-light-board.js`'s shape — a `renderX(container, ctx)` export, the same
 * `aria-pressed` chip idiom — rather than inventing a second control language.
 *
 * @module ui/rooms/remote/transition-board
 */

import {
  TRANSITION_PRESETS,
  TRANSITION_PRESET_IDS,
  TRANSITION_PACES,
  summarisePreset,
} from '../../scene-transition.js';

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

function blockLabel(text, { spaced = false } = {}) {
  const label = document.createElement('div');
  label.className = 'msa-wx-blocklabel';
  if (spaced) label.style.marginTop = '10px'; // the two halves of the board read as two
  const span = document.createElement('span');
  span.textContent = text;
  label.appendChild(span);
  return label;
}

function hintLine(text) {
  const hint = document.createElement('div');
  hint.className = 'msa-wx-hint msa-wx-hint--block';
  hint.textContent = text;
  return hint;
}

/** "3 s", "1.5 s". */
export function formatSeconds(ms) {
  const s = Math.round((Number(ms) || 0) / 100) / 10;
  return `${s} s`;
}

/**
 * What the status line says about the armed override.
 * @param {{type: string, durationMs?: number}|null} override
 * @param {Array<{id: string, label: string}>} choices
 */
export function describeOverride(override, choices) {
  if (!override?.type) return 'Nothing armed — the default plays.';
  const label = choices.find((c) => c.id === override.type)?.label ?? override.type;
  const when = Number.isFinite(override.durationMs) ? `, ${formatSeconds(override.durationMs)}` : '';
  return `Armed: ${label}${when}. Plays once on the next scene change.`;
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   getDefaults: () => {preset: string, pace: string},
 *   onSetPreset: (id: string) => void,
 *   onSetPace: (id: string) => void,
 *   listOverrideChoices: () => Array<{id: string, label: string, group: 'msa'|'foundry'}>,
 *   getOverride: () => ({type: string, durationMs?: number}|null),
 *   onArm: (o: {type: string, durationMs: number}) => void,
 *   onDisarm: () => void,
 * }} ctx
 * @returns {{refresh: () => void}}
 */
export function renderTransitionBoard(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-wx-board';

  // The preset list: one full-width row each, quick at the top, dramatic at the bottom.
  const presetList = document.createElement('div');
  presetList.style.cssText = 'display:flex;flex-direction:column;gap:4px;';
  const paceRow = document.createElement('div');
  paceRow.className = 'msa-wx-chips';

  const pickRow = document.createElement('div');
  pickRow.className = 'msa-wx-chips';
  const select = document.createElement('select');
  select.className = 'msa-select';
  select.title = 'The transition to play on the next scene change.';
  pickRow.appendChild(select);
  const durationRow = document.createElement('div');
  durationRow.className = 'msa-wx-chips';
  const armRow = document.createElement('div');
  armRow.className = 'msa-wx-chips';
  const status = hintLine('');

  wrap.append(
    blockLabel('Transitions'),
    hintLine('Every load, scene change and floor change plays this. Floors play it quicker.'),
    presetList,
    paceRow,
    blockLabel('Next scene change', { spaced: true }),
    hintLine('Arm something dramatic. It plays once, for everyone, then the default returns.'),
    pickRow,
    durationRow,
    armRow,
    status
  );
  container.appendChild(wrap);

  // What the GM is about to arm (not yet armed): kept here so a refresh does not reset it.
  let draftType = null;
  let draftDurationMs = OVERRIDE_DURATIONS_MS[1];

  function renderDefaults() {
    const { preset, pace } = ctx.getDefaults();
    presetList.replaceChildren(
      ...TRANSITION_PRESET_IDS.map((id) => {
        const p = TRANSITION_PRESETS[id];
        const { sceneMs, floorMs } = summarisePreset(id, pace);
        const row = chip('', p.hint, id === preset, () => {
          ctx.onSetPreset(id);
          renderDefaults();
        });
        row.style.cssText =
          'display:flex;justify-content:space-between;align-items:baseline;width:100%;text-align:left;';
        const name = document.createElement('span');
        name.textContent = p.label;
        const timing = document.createElement('span');
        timing.style.cssText = 'opacity:0.6;font-size:11px;';
        timing.textContent =
          sceneMs === 0 ? 'instant' : `scene ${formatSeconds(sceneMs)} · floor ${formatSeconds(floorMs)}`;
        row.append(name, timing);
        return row;
      })
    );
    paceRow.replaceChildren(
      ...Object.entries(TRANSITION_PACES).map(([id, p]) =>
        chip(p.label, `Every duration × ${p.scale}.`, id === pace, () => {
          ctx.onSetPace(id);
          renderDefaults();
        })
      )
    );
  }

  function renderOverride() {
    const choices = ctx.listOverrideChoices();
    const armed = ctx.getOverride();
    if (draftType === null || !choices.some((c) => c.id === draftType))
      draftType = armed?.type ?? choices[0]?.id ?? null;

    select.replaceChildren();
    for (const [group, title] of [
      ['msa', 'Map Shine'],
      ['foundry', 'Foundry VTT'],
    ]) {
      const inGroup = choices.filter((c) => c.group === group);
      if (inGroup.length === 0) continue;
      const og = document.createElement('optgroup');
      og.label = title;
      for (const c of inGroup) og.appendChild(new Option(c.label, c.id, false, c.id === draftType));
      select.appendChild(og);
    }
    select.onchange = () => {
      draftType = select.value;
    };

    durationRow.replaceChildren(
      ...OVERRIDE_DURATIONS_MS.map((ms) =>
        chip(formatSeconds(ms), `Play it over ${formatSeconds(ms)}.`, ms === draftDurationMs, () => {
          draftDurationMs = ms;
          renderOverride();
        })
      )
    );

    const armBtn = chip(armed ? 'Re-arm' : 'Arm', 'Play this on the next scene change.', false, () => {
      if (!draftType) return;
      ctx.onArm({ type: draftType, durationMs: draftDurationMs });
      renderOverride();
    });
    const parts = [armBtn];
    if (armed) {
      parts.push(
        chip('Disarm', 'Go back to the default for the next scene change.', false, () => {
          ctx.onDisarm();
          renderOverride();
        })
      );
    }
    armRow.replaceChildren(...parts);
    status.textContent = describeOverride(armed, choices);
  }

  function refresh() {
    renderDefaults();
    renderOverride();
  }
  refresh();
  return { refresh };
}
