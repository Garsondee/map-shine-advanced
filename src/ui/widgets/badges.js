/**
 * ui/widgets/badges.js — the small card-header status glyphs the Component
 * Canon (docs/holy/UI-Testament.md §8) lists as new: scope glyph, tier chip,
 * health badge. Extracted as their own module (not folded into param-
 * control.js) because none of them render a PARAM — they describe the
 * EFFECT the card belongs to.
 *
 * ⚠️ ONLY THE TIER CHIP IS LIVE DATA TODAY. `resolveAndApply`'s
 * `perfTier`/`maxPerfTier`/`perfTierSource` are real (effects/effect-
 * cascade.js#resolveEffectTier) — this is genuinely "the tier the profile
 * cascade resolved," not yet "the tier the governor chose" (effect-
 * manifest.js's own header still calls the governor "(future)"); the chip's
 * label says the former.
 *
 * `scopeGlyph` and `healthBadge` are built as REAL, reusable widgets — but
 * every card mounts them `status:'planned'` for now, because what they would
 * show does not exist yet: a full scene/world/client scope per param (only
 * a world/client duality exists today, for an effect's own enable state,
 * not "where does the Studio believe THIS param lives") and the U6 read-
 * tracking proxy behind the health count. Building the chrome now and
 * wiring it later (once true) is cheaper than reworking card layout twice,
 * and it is the same convention the rest of the canon already uses for an
 * honestly-not-yet-real control.
 *
 * @module ui/widgets/badges
 */

import { iconMarkup } from './icon-sprite.js';

const MUTED = 'var(--ink2, #8fa3c4)';
const FAIL = 'var(--fail, #ef6d5a)';

function chip(text, opts = {}) {
  const el = document.createElement('span');
  Object.assign(el.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    padding: '1px 6px',
    borderRadius: '999px',
    fontSize: '9px',
    lineHeight: '1.6',
    border: `1px solid ${opts.planned ? FAIL : 'var(--line, rgba(196,208,232,.13))'}`,
    borderStyle: opts.planned ? 'dashed' : 'solid',
    color: opts.planned ? FAIL : MUTED,
    flex: '0 0 auto',
  });
  el.innerHTML = text;
  if (opts.title) el.title = opts.title;
  return el;
}

/**
 * The tier chip — "T{tier}", real data.
 * @param {{tier: number, maxTier?: number, source?: string}} readout
 * @returns {HTMLElement}
 */
export function tierChip({ tier, maxTier, source }) {
  const el = chip(`T${tier}`);
  const bits = [`Tier the profile cascade resolved: T${tier}`];
  if (Number.isFinite(maxTier) && maxTier !== tier) bits.push(`capped from a declared max of T${maxTier}`);
  if (source) bits.push(`source: ${source}`);
  el.title = bits.join(' — ');
  return el;
}

/**
 * The scope glyph — planned chrome for U1 (see module doc). `plannedReason`
 * is required so a future caller can't accidentally ship this silently
 * un-real; matches the `status:'planned'` contract's own requirement.
 * @param {{plannedReason: string}} args
 * @returns {HTMLElement}
 */
export function scopeGlyph({ plannedReason }) {
  const el = chip(`${iconMarkup('map', 'style="width:9px;height:9px"')} ?`, { planned: true, title: plannedReason });
  return el;
}

/**
 * The health badge — planned chrome for U1; the real signal is U6's
 * read-tracking proxy (declared − read).
 * @param {{plannedReason: string}} args
 * @returns {HTMLElement}
 */
export function healthBadge({ plannedReason }) {
  return chip(`${iconMarkup('health', 'style="width:9px;height:9px"')} ?`, { planned: true, title: plannedReason });
}
