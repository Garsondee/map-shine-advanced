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
 *
 * ⚠️ GROUPED BROWSING + LEFT RAIL (2026-08-27, author live-testing round:
 * "lots of things compressed together, make this UI x2 bigger... a rail of
 * general options on the left which allows you to quickly scroll down the
 * full list to get to specific climates within an overall heading"). Real
 * archetypes/biomes carry no category/facet field (same finding as above —
 * nothing to honestly group by), so `ARCHETYPE_GROUPS`/`BIOME_GROUPS` below
 * are a WORKER-TIER CURATION CALL, named as one — a UI-only bucketing over
 * the real, unordered-by-category id lists, worth the author's countersign
 * if the read is wrong, same posture Petition P19/P26 already took for the
 * favourites split. Grouping only applies while BROWSING (empty query) —
 * an active search still renders the original flat, ungrouped hit list
 * (grouping and free-text ranking don't mix cleanly, and flat-on-search
 * matches every other search surface in this codebase).
 *
 * @module ui/rooms/remote/weather-picker
 */

import { WEATHER_ARCHETYPES, WEATHER_BIOMES } from '../../../world/index.js';
import { buildSearchOverlay } from '../../widgets/search-overlay.js';

/** Direct mode's own severity-gradient shelf order, named into sections —
 * the SAME order `WEATHER_ARCHETYPES` already declares (clear → thickening
 * → raining → extreme), just with section breaks added, never reordered. */
const ARCHETYPE_GROUPS = Object.freeze([
  { id: 'clear-fair', label: 'Clear & Fair', ids: ['clear', 'streaks', 'high-veil', 'fair-cumulus'] },
  { id: 'cloudy', label: 'Cloudy', ids: ['mackerel', 'broken', 'overcast'] },
  { id: 'fog', label: 'Fog & Haze', ids: ['fog'] },
  { id: 'rain', label: 'Rain & Drizzle', ids: ['drizzle', 'steady-rain'] },
  { id: 'winter', label: 'Winter & Ash', ids: ['snow', 'sleet', 'ashfall'] },
  { id: 'severe', label: 'Severe', ids: ['hailstorm', 'gale', 'thunderstorm'] },
]);

/** Drift mode's own 10 biomes, split the same way weather-board.js's own
 * favourites already implicitly did: the 6 "useful in almost any campaign"
 * climates vs. the 4 more setting-specific ones. */
const BIOME_GROUPS = Object.freeze([
  {
    id: 'common',
    label: 'Common Climates',
    ids: ['temperate-coast', 'continental-plains', 'desert', 'tropical-monsoon', 'boreal-tundra', 'high-mountain'],
  },
  {
    id: 'exotic',
    label: 'Setting-Specific',
    ids: ['moorland-mire', 'volcanic-waste', 'feywild-glade', 'shadowfell-verge'],
  },
]);

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

function groupsFor(mode) {
  return mode === 'almanac' ? BIOME_GROUPS : ARCHETYPE_GROUPS;
}

function hitButton(h) {
  const btn = document.createElement('button');
  btn.className = 'hit';
  btn.innerHTML = `<span class="dot" style="--acc:var(--shine)"></span>${h.icon ? `<span>${h.icon}</span>` : ''}<span class="htext"><b>${h.label}</b><span class="sub">${h.sub}</span></span>`;
  return btn;
}

/**
 * @param {object} opts
 * @param {() => 'director'|'almanac'} opts.getWeatherMode
 * @param {(id: string) => void} opts.onPickArchetype - Direct mode's own hit.
 * @param {(id: string) => void} opts.onPickBiome - Drift mode's own hit.
 * @returns {{open: (q?: string) => void, close: () => void}}
 */
export function installWeatherPicker({ getWeatherMode, onPickArchetype, onPickBiome }) {
  function pick(mode, id) {
    overlay.close();
    if (mode === 'almanac') onPickBiome(id);
    else onPickArchetype(id);
  }

  function drawHits(q, results) {
    results.innerHTML = '';
    const mode = getWeatherMode();
    const index = buildWeatherIndex(mode);
    const byId = new Map(index.map((h) => [h.id, h]));
    const ql = q.trim().toLowerCase();

    if (!ql) {
      // BROWSING: grouped, with a real `data-group` heading per section so
      // the overlay's own rail can scroll to it.
      for (const group of groupsFor(mode)) {
        const items = group.ids.map((id) => byId.get(id)).filter(Boolean);
        if (!items.length) continue;
        const head = document.createElement('div');
        head.className = 'grouphead';
        head.dataset.group = group.id;
        head.innerHTML = `<span>${group.label}</span><span class="cnt">${items.length}</span>`;
        results.append(head);
        for (const h of items) {
          const btn = hitButton(h);
          btn.addEventListener('click', () => pick(mode, h.id));
          results.append(btn);
        }
      }
      return;
    }

    // SEARCHING: flat, ranked-by-nothing-fancier-than-substring, same
    // behaviour this overlay always had — grouping and free-text search
    // don't mix cleanly, and this matches every other search surface here.
    const hits = index.filter((h) => (h.label + ' ' + h.sub).toLowerCase().includes(ql));
    if (!hits.length) {
      const empty = document.createElement('div');
      empty.className = 'hit';
      empty.textContent = 'Nothing under that name.';
      results.append(empty);
      return;
    }
    hits.forEach((h, i) => {
      const btn = hitButton(h);
      if (i === 0) btn.classList.add('sel');
      btn.addEventListener('click', () => pick(mode, h.id));
      results.append(btn);
    });
  }

  // The rail's own labels stay Direct's own shelf until open() re-derives
  // them for whichever mode is actually active — same "set fresh on open,
  // not fixed at build time" reasoning the placeholder swap below already
  // established for this exact Direct/Drift split.
  const overlay = buildSearchOverlay({
    ariaLabel: 'Browse weather',
    placeholder: 'Search weather…',
    onQuery: drawHits,
    rail: ARCHETYPE_GROUPS.map((g) => ({ id: g.id, label: g.label })),
  });
  document.body.appendChild(overlay.root);
  const input = overlay.root.querySelector('input');
  const railEl = overlay.root.querySelector('.rail');

  function syncRailForMode() {
    if (!railEl) return;
    const groups = groupsFor(getWeatherMode());
    railEl.innerHTML = groups.map((g) => `<button type="button" data-rail="${g.id}">${g.label}</button>`).join('');
    for (const btn of railEl.querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        overlay.root.querySelector(`[data-group="${btn.dataset.rail}"]`)?.scrollIntoView({ block: 'start' });
        for (const b of railEl.querySelectorAll('button')) b.classList.toggle('active', b === btn);
      });
    }
  }

  return {
    open(q = '') {
      input.placeholder = getWeatherMode() === 'almanac' ? 'Search climates…' : 'Search weather…';
      syncRailForMode();
      overlay.open(q);
    },
    close: overlay.close,
  };
}
