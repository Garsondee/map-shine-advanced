/**
 * ui/rooms/remote/readiness-card.js — THE SCENE READINESS CARD (MSA Ready,
 * 2026-11-01). Sits above the Remote's tabs, on every tab, whenever the scene is
 * not ready for Map Shine — and is gone the moment it is.
 *
 * Author: *"We need the MSA remote to load up automatically and show information
 * if the scene isn't currently MSA ready and provide an interface to quickly help
 * them do the correct steps to get their map up and running with MSA."*
 *
 * One row per floor that needs something, each with the two ways to fix it:
 * PAINT IT (the painter opens on that floor's `_Outdoors`, Rectangle tool and
 * whole-grid snap ready, Start from walls one click away) and IMPORT A FILE (a
 * mask made in any other program, checked, renamed and placed beside the map).
 * "Not now" snoozes the auto-open for this scene; "Check again" re-reads the
 * map's folder.
 *
 * The model is `scene/scene-readiness.js` (Node-tested); this file only draws it.
 *
 * @module ui/rooms/remote/readiness-card
 */

import { iconMarkup } from '../../widgets/icon-sprite.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function btn(label, className, onClick, title) {
  const b = el('button', className, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

/**
 * @param {HTMLElement} host - the empty slot above the tabs.
 * @returns {{render: (readiness: object|null, actions: object) => void}}
 *   `actions`: { onPaint(floorIndex), onImport(floorIndex), onSnooze(), onRecheck(),
 *   requiredSuffix: string }
 */
export function createReadinessCard(host) {
  host.className = 'msa-ready';
  host.hidden = true;

  function render(readiness, actions = {}) {
    host.replaceChildren();
    const show = !!readiness?.checked && !readiness.ready;
    host.hidden = !show;
    if (!show) return;

    const head = el('div', 'msa-ready-head');
    head.innerHTML = `${iconMarkup('warn')}<span></span>`;
    head.lastChild.textContent = readiness.headline;
    host.append(head);

    const suffix = actions.requiredSuffix ?? '';
    host.append(
      el(
        'div',
        'msa-hint',
        `Map Shine reads the ${suffix} mask to tell indoors (black) from outdoors (white). Rain, wind, ` +
          'sun shadows and daylight stop at the walls because of it. Without it they are switched off on that floor.'
      )
    );

    const list = el('div', 'msa-ready-rows');
    for (const f of readiness.floors) {
      const row = el('div', 'msa-ready-row');
      row.dataset.status = f.status;
      const text = el('div', 'msa-ready-text');
      text.append(el('span', 'msa-ready-name', f.name), el('span', 'msa-ready-detail', f.detail));
      row.append(text);
      if (f.status !== 'ready') {
        const acts = el('div', 'msa-ready-acts');
        acts.append(
          btn(
            'Paint it',
            'msa-btn msa-btn--sm msa-btn--gold',
            () => actions.onPaint?.(f.index),
            `Open the painter on ${f.name}'s ${suffix}: draw the buildings as indoors with the Rectangle tool, or start from Foundry's walls.`
          ),
          btn(
            'Import a file',
            'msa-btn msa-btn--sm',
            () => actions.onImport?.(f.index),
            `Pick a ${suffix} mask you made in another program — Map Shine checks it fits, renames it and puts it beside the map.`
          )
        );
        row.append(acts);
      }
      list.append(row);
    }
    host.append(list);

    const foot = el('div', 'msa-ready-foot');
    foot.append(
      btn(
        'Check again',
        'msa-btn msa-btn--sm',
        () => actions.onRecheck?.(),
        "Look in the map's folder again (after you added a file yourself)."
      ),
      btn(
        'Not now for this scene',
        'msa-btn msa-btn--sm',
        () => actions.onSnooze?.(),
        "Stop opening the Remote for this scene's missing masks. The card still shows here."
      )
    );
    host.append(foot);
  }

  return { render };
}
