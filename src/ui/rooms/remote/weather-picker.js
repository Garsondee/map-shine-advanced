/**
 * ui/rooms/remote/weather-picker.js — the Moods/Climates "Browse" overlay
 * (2026-08-18 fix; author's own screenshot comparison: "Climate buttons need
 * to be better organised. We need the extra opening room of climate
 * choices."). Mock precedent: `tools/ui-mock/index.html`'s `#wxPicker` —
 * `weather-board.js`'s chip row shows a small curated favourites subset
 * (see its own `FAVOURITE_ARCHETYPE_IDS`/`FAVOURITE_BIOME_IDS`), this
 * overlay is the "opening room" for everything else.
 *
 * ⚠️ NOT A 1:1 PORT OF THE MOCK'S OWN PICKER — the mock's catalog was
 * `FACETS` (6 channel-facet partial presets) + `WX_NAMED_ALL` (named
 * full-scene presets) for Direct, `CLIMATES_ALL` for Drift, 67 items total.
 * That facet-preset dimension was never built into `world/` — grepped, zero
 * hits (same finding Petition P11/U2 already made for the Remote's channel
 * faders: `WEATHER_AXES`' own `consumerStatus` never named a facet catalog
 * as `'live'`). What's real today is exactly `WEATHER_ARCHETYPES` (16,
 * Direct) and `WEATHER_BIOMES` (10, Drift) — this overlay searches THOSE,
 * honestly smaller than the mock's own catalog, not padded out to match it.
 * Results render FLAT, no group headers — the mock grouped by facet, but no
 * real facet axis exists to group real archetypes/biomes by; inventing one
 * here would be a second, UI-only taxonomy with nothing behind it.
 *
 * @module ui/rooms/remote/weather-picker
 */

import { WEATHER_ARCHETYPES, WEATHER_BIOMES } from '../../../world/index.js';
import { buildSearchOverlay } from '../../widgets/search-overlay.js';

/**
 * The full catalog for the given weather mode, in one flat searchable shape.
 * @param {'director'|'almanac'} mode
 * @returns {Array<{id: string, label: string, icon: string, sub: string}>}
 */
export function buildWeatherIndex(mode) {
  if (mode === 'almanac') {
    // Biomes carry no icon field today (weather-board.js's own chip() for
    // biomes never rendered one either — matching that, not inventing one).
    return WEATHER_BIOMES.map((b) => ({ id: b.id, label: b.label, icon: '', sub: b.blurb ?? '' }));
  }
  return WEATHER_ARCHETYPES.map((a) => ({ id: a.id, label: a.label, icon: a.icon, sub: a.blurb ?? '' }));
}

/**
 * @param {object} opts
 * @param {() => 'director'|'almanac'} opts.getWeatherMode
 * @param {(id: string) => void} opts.onPickArchetype - Direct mode's own hit.
 * @param {(id: string) => void} opts.onPickBiome - Drift mode's own hit.
 * @returns {{open: (q?: string) => void, close: () => void}}
 */
export function installWeatherPicker({ getWeatherMode, onPickArchetype, onPickBiome }) {
  function drawHits(q, results) {
    results.innerHTML = '';
    const mode = getWeatherMode();
    const index = buildWeatherIndex(mode);
    const ql = q.trim().toLowerCase();
    const hits = !ql ? index : index.filter((h) => (h.label + ' ' + h.sub).toLowerCase().includes(ql));
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'hit';
      empty.textContent = 'Nothing under that name.';
      results.append(empty);
      return;
    }
    hits.forEach((h, i) => {
      const btn = document.createElement('button');
      btn.className = 'hit' + (i === 0 ? ' sel' : '');
      btn.innerHTML = `<span class="dot" style="--acc:var(--shine)"></span>${h.icon ? `<span>${h.icon}</span>` : ''}<span class="htext"><b>${h.label}</b><span class="sub">${h.sub}</span></span>`;
      btn.addEventListener('click', () => {
        overlay.close();
        if (mode === 'almanac') onPickBiome(h.id);
        else onPickArchetype(h.id);
      });
      results.append(btn);
    });
  }

  const overlay = buildSearchOverlay({
    ariaLabel: 'Browse weather',
    // Placeholder swaps with mode on every open — set fresh there rather
    // than fixed here, same reasoning weather-board.js's own moodsTitle
    // swap already established (Direct/Drift are different vocabularies).
    placeholder: 'Search weather…',
    onQuery: drawHits,
  });
  document.body.appendChild(overlay.root);
  const input = overlay.root.querySelector('input');

  return {
    open(q = '') {
      input.placeholder = getWeatherMode() === 'almanac' ? 'Search climates…' : 'Search weather…';
      overlay.open(q);
    },
    close: overlay.close,
  };
}
