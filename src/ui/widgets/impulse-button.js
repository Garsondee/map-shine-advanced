/**
 * ui/widgets/impulse-button.js — ONE impulse button (U7, docs/holy/
 * UI-Testament.md §4.4): "{ id, label, icon, fire() } — strike lightning,
 * roll thunder, gust the wind." Shared between the Remote's curated TR
 * corner and the Studio's full list — the SAME declaration renders
 * identically in both (Law 1: "every control is a generated projection of
 * a declaration"), never a second hand-built button for either host.
 *
 * ============================================================================
 * THE SUPPRESSION BADGE STAYS `status:'planned'` — RESEARCHED, NOT ASSUMED
 * ============================================================================
 *
 * §4.4: "The Remote shows a small badge on flash-class impulses when any
 * connected client suppresses them." Confirmed before building (2026-08-18):
 * no socket channel is open anywhere in this codebase (`module.json`
 * permits one, none exists), and `reducePhotosensitiveEffects` is a
 * `scope:'client'` Foundry setting — invisible to any OTHER client's
 * `game.settings.get()` by construction, not just by this project's own
 * choice. A truthful cross-client count needs new plumbing (a socket
 * broadcast, or each client mirroring its own setting onto its own User
 * document via `setFlag` for others to aggregate) — real, scoped, un-built
 * work, not something this widget can fake with a static number. A
 * flash-class impulse (`decl.flashClass === true`) gets a small, honestly
 * `planned` glyph instead of a lying count.
 *
 * Suppression ITSELF — the actual flash not reaching a photosensitive
 * client — needs no new work here: `effect-cascade.js#resolveEffectEnabled`
 * step 4 already force-disables any `a11y.photosensitive:true` effect
 * (lightning's own manifest flag) on a client with the setting on, so a
 * click on Strike is already inert there whether or not this widget knows
 * it. This widget's own gap is narrower than "does suppression work" — it
 * is only "can the GM SEE that it worked."
 *
 * @module ui/widgets/impulse-button
 */

import { iconMarkup } from './icon-sprite.js';

/**
 * @param {import('../../core/impulse-schema.js').ImpulseDecl & {flashClass?: boolean}} decl
 * @param {{onStatus?: (text: string) => void, showLabel?: boolean}} [handlers]
 *   `showLabel` (default false): the Remote's corner is icon-only (compact,
 *   four slots to a corner); the Studio's full list passes `true` — same
 *   declaration, same click behaviour, a wider presentation because Studio
 *   has the room and "full list" implies more than a glyph.
 * @returns {HTMLElement}
 */
export function buildImpulseButton(decl, { onStatus, showLabel = false } = {}) {
  const wrap = document.createElement('span');
  wrap.style.cssText = 'position:relative; display:inline-flex';
  wrap.dataset.msaImpulse = decl.id;

  const planned = decl.status === 'planned';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = planned ? `${decl.label} — ${decl.plannedReason}` : decl.label;
  if (showLabel) {
    Object.assign(btn.style, { display: 'inline-flex', alignItems: 'center', gap: '6px' });
    btn.innerHTML = `${iconMarkup(decl.icon)}<span>${decl.label}</span>`;
  } else {
    btn.innerHTML = iconMarkup(decl.icon);
  }
  if (planned) btn.classList.add('msa-planned');
  btn.addEventListener('click', () => {
    if (planned) {
      onStatus?.(decl.plannedReason);
      return;
    }
    const result = decl.fire();
    if (result && typeof result.message === 'string') onStatus?.(result.message);
  });
  wrap.append(btn);

  if (decl.flashClass) {
    const badge = document.createElement('span');
    badge.className = 'msa-planned';
    badge.textContent = '◇';
    badge.title =
      'Suppression badge: whether any connected client has "reduce photosensitive effects" on ' +
      'is not yet visible cross-client (needs a real socket/user-flag broadcast — not built). ' +
      'The flash itself is already suppressed on that client either way.';
    Object.assign(badge.style, {
      position: 'absolute',
      top: '-4px',
      right: '-4px',
      fontSize: '8px',
      lineHeight: '1',
      color: 'var(--fail, #ef6d5a)',
      background: 'var(--bg1, #191c25)',
      borderRadius: '50%',
      width: '11px',
      height: '11px',
      display: 'grid',
      placeItems: 'center',
      pointerEvents: 'none',
    });
    wrap.append(badge);
  }

  return wrap;
}
