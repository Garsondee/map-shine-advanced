/**
 * ui/widgets/badges.js — the small card-header status glyphs the Component
 * Canon (docs/holy/UI-Testament.md §8) lists as new: scope glyph, tier chip,
 * health badge. Extracted as their own module (not folded into param-
 * control.js) because none of them render a PARAM — they describe the
 * EFFECT the card belongs to.
 *
 * `scopeGlyph` GAINED REAL DATA AT mythica-machina-press#389 (2026-09-09) —
 * `core/params-schema.js#PARAM_SCOPE`'s declared `scope: 'scene'|'client'`
 * field. Reports `scene` (everything syncs) or `mixed` (N controls stay
 * client-only); never `world` — that scope does not exist in this codebase
 * yet (#11's own still-open question). A card whose model has no `schema`
 * (should not happen — every card sets one) falls back to the original
 * dashed `planned` chip. `tierChip` was already live before this
 * (`resolveAndApply`'s `perfTier`/`maxPerfTier`/`perfTierSource`, effects/
 * effect-cascade.js#resolveEffectTier).
 *
 * `healthBadge` GAINED REAL DATA AT U6 (2026-08-18) — `diag/param-read-
 * health.js`'s `declared`/`read` counts. A caller that has them passes
 * `{declared, read, onClick}`; a caller that does not (any effect not yet
 * wired to the read-tracking proxy) passes `{plannedReason}` and gets the
 * exact same dashed, muted chip this widget always rendered — the fallback
 * this module's own header used to describe as the ONLY path is now real,
 * not deleted.
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
 * The scope glyph — real as of mythica-machina-press#389's declared `scope`
 * field (`core/params-schema.js#PARAM_SCOPE`), same "real when the caller
 * has the data, planned fallback otherwise" split `healthBadge` already
 * uses below. Every card's `model.schema` is the SAME schema object already
 * driving its FOH/ROH controls (every effect card sets it, hand-written or
 * `registerSimpleEffectCard`-built alike) — no per-effect wiring needed to
 * make this real everywhere at once, the same "N+1 is free" property
 * mythica-machina-press#180 already proved for fade sources.
 *
 * Only ever reports `scene`/`mixed` today, never `world` — this codebase
 * has no world-scoped effect-param layer yet (mythica-machina-press#11's
 * own still-open question), and a glyph claiming a scope that does not
 * exist would be exactly the kind of lying instrument this project's own
 * doctrine rejects elsewhere.
 * @param {{schema?: Record<string, {scope?: string}>, plannedReason?: string}} args
 * @returns {HTMLElement}
 */
export function scopeGlyph({ schema, plannedReason } = {}) {
  if (!schema || typeof schema !== 'object') {
    return chip(`${iconMarkup('map', 'style="width:9px;height:9px"')} ?`, { planned: true, title: plannedReason });
  }
  const clientOnly = Object.keys(schema).filter((k) => schema[k]?.scope === 'client');
  if (clientOnly.length === 0) {
    return chip(`${iconMarkup('map', 'style="width:9px;height:9px"')} scene`, {
      title: 'Every control here is an authored look, synced to every player.',
    });
  }
  return chip(`${iconMarkup('map', 'style="width:9px;height:9px"')} mixed`, {
    title: `Synced to every player, except ${clientOnly.length} control${clientOnly.length === 1 ? '' : 's'} that stay on this client only: ${clientOnly.join(', ')}.`,
  });
}

/**
 * The health badge — "declared − read" (U6, `diag/param-read-health.js`).
 *
 * Real when the caller has `declared`/`read` counts (an effect wired to the
 * read-tracking proxy, e.g. water's `getRenderState()`); falls back to the
 * original dashed `status:'planned'` chip when it does not (an effect not
 * yet wired — most of them, today). The two states use visually DIFFERENT
 * language on purpose: `planned` is the dashed `--fail` chip every other
 * not-yet-real control already uses; a live badge with orphaned params uses
 * `--warn` instead — "some controls haven't been observed read yet" is an
 * investigate-if-curious signal, not the same claim as "this doesn't work".
 *
 * @param {{declared?: number, read?: number, onClick?: () => void, plannedReason?: string}} args
 * @returns {HTMLElement}
 */
export function healthBadge({ declared, read, onClick, plannedReason } = {}) {
  if (typeof declared !== 'number' || typeof read !== 'number') {
    return chip(`${iconMarkup('health', 'style="width:9px;height:9px"')} ?`, { planned: true, title: plannedReason });
  }
  const orphaned = Math.max(0, declared - read);
  const el = chip(`${iconMarkup('health', 'style="width:9px;height:9px"')} ${read}/${declared}`);
  if (orphaned > 0) {
    el.style.borderColor = 'var(--warn, #e0a940)';
    el.style.color = 'var(--warn, #e0a940)';
  }
  el.title =
    orphaned > 0
      ? `${read} of ${declared} params observed reaching the renderer this session — ${orphaned} not yet observed ` +
        '(may be a genuinely orphaned control, or simply not exercised yet). Click for the full Control Health report.'
      : `${read} of ${declared} params observed reaching the renderer this session — every declared param has been read.`;
  if (typeof onClick === 'function') {
    el.style.cursor = 'pointer';
    el.addEventListener('click', onClick);
  }
  return el;
}
