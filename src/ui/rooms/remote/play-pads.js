/**
 * ui/rooms/remote/play-pads.js — THE EFFECT PADS on the Play tab (2026-11-01
 * redesign): Strike, Gust, and the next-scene transition, as big labelled pads.
 *
 * These were 26px unlabelled icons in the corners of the dial — the most playful
 * one-shots on the panel were the hardest things on it to find. A pad is the
 * right shape for a one-shot: you hit it, it answers (a press, a flash), done.
 *
 * Impulses that are still `status:'planned'` (Thunder, until there is audio) are
 * not drawn at all: a GM's panel shows what works.
 *
 * @module ui/rooms/remote/play-pads
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';
import { renderTransitionArm } from './transition-board.js';
import { replayClass } from '../room-style.js';

/**
 * @param {HTMLElement} container
 * @param {{impulses?: Array<import('../../../core/impulse-schema.js').ImpulseDecl>,
 *   transitionBoard?: object, onStatus: (text: string) => void, onFlash?: () => void}} ctx
 * @returns {{refresh: () => void}}
 */
export function renderPlayPads(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-pads-wrap';
  const row = document.createElement('div');
  row.className = 'msa-pads';
  const popHost = document.createElement('div');
  wrap.append(row, popHost);
  container.appendChild(wrap);

  for (const decl of (ctx.impulses ?? []).filter((d) => d.status !== 'planned')) {
    const pad = document.createElement('button');
    pad.type = 'button';
    pad.className = 'msa-pad';
    pad.title = `${decl.label} — fires once, for everyone at the table.`;
    pad.innerHTML = `<span class="msa-pad-ico">${iconMarkup(decl.icon)}</span><span class="msa-pad-label">${decl.label}</span>`;
    pad.addEventListener('click', () => {
      const result = decl.fire?.();
      replayClass(pad, 'msa-pad-hit');
      if (decl.icon === 'bolt') ctx.onFlash?.();
      ctx.onStatus(result && typeof result.message === 'string' ? result.message : '');
    });
    pad.addEventListener('animationend', () => pad.classList.remove('msa-pad-hit'));
    row.appendChild(pad);
  }

  const arm = ctx.transitionBoard ? renderTransitionArm(row, popHost, ctx.transitionBoard) : null;
  return {
    refresh() {
      arm?.refresh();
    },
  };
}
