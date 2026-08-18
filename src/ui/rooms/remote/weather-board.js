/**
 * ui/rooms/remote/weather-board.js — THE WEATHER BOARD (Testament §4.1's own
 * row): a `Direct | Drift` mode toggle over one grammar, mood chips (Direct)
 * or climate chips (Drift), and channel faders for whichever axes are
 * actually live. U2 checkpoint 3.
 *
 * ⚠️ NAMING: the persisted value is `weatherMode: 'director'|'almanac'`
 * (`world/weather.js#WEATHER_MODES`, unrelated to the Testament's OWN later
 * cutscene "Director", U9) — this file writes and reads that real value but
 * LABELS its own toggle "Direct"/"Drift", exactly the discipline the plan
 * flagged before U2 started ("the mock already dodges this correctly").
 *
 * ⚠️ ONLY `cloudCover01` and `precip01` GET FADERS — `WEATHER_AXES`' own
 * `consumerStatus` names exactly these two (plus `temperature01`, which has
 * no dedicated mock-named channel and stays on the astrolabe's own tuning
 * drawer for now) as `'live'`; `cloudType01`/`cloudAltitudePx`/
 * `cloudScalePx` are `'pending'` and are not rendered at all here — Law 5,
 * `tools/verify-structure.mjs#ui/no-dead-axis` holds the line structurally.
 * The mock's own 7-channel list (rain/clouds/fog/wind/freeze/bolt/ash) is
 * NOT reproduced whole: fog/freeze/ash have no live axis, lightning is an
 * impulse (not a fade channel, U7's job), and wind already has a real,
 * dedicated control on the astrolabe itself (`ui/astrolabe.js`'s own
 * arrow+slider) — a second wind fader here would be the exact "two controls,
 * one value" mirror this codebase's own Environment.md §2.4 warns against.
 *
 * ⚠️ MOOD-CHIP FADES ARE THIS CHECKPOINT'S FIRST REAL FADE ENGINE CONSUMER.
 * A chip click does NOT snap — it starts a real `mergeFadeState` fade toward
 * the archetype's own declared axis values, eased over the Remote's current
 * Fade Time. While in flight, the sky's own `weatherArchetype` reads
 * `'custom'` (the SAME "a hand-moved value is not the row it drifted from"
 * rule the astrolabe's Cloud slider already establishes) — it only becomes
 * the new archetype's real id once the fade actually arrives. See
 * `installWeatherFadePump` (boot.js) for the per-tick half of this; this
 * file only ever calls `ctx.fadeToArchetype`, never touches timing itself.
 *
 * @module ui/rooms/remote/weather-board
 */

// THROUGH THE DOOR (world/index.js), never world/weather-data.js or
// world/weather-biomes.js directly — the same door ui/astrolabe.js's own
// horizon shelf and biome picker already use for these identical two tables
// (zones/one-door, tools/verify-structure.mjs).
import { WEATHER_ARCHETYPES, WEATHER_BIOMES } from '../../../world/index.js';
import { buildParamControl } from '../../widgets/param-control.js';
import { createFadeTimeControl } from './fade-time.js';

/** The two, and only two, live-today channels. Adding a third is a schema
 * change in world/weather.js (flip consumerStatus, wire a real consumer)
 * BEFORE it is a UI change here — never the other way round. */
const LIVE_CHANNELS = Object.freeze([
  { axis: 'cloudCover01', label: 'Clouds', help: 'How much sky is covered.' },
  { axis: 'precip01', label: 'Rain', help: 'How hard it is coming down.' },
]);

function chip(text, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-wx-chip';
  btn.textContent = text;
  if (title) btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * The [min, max] a channel can wander to inside a climate — DERIVED from the
 * biome's own real `archetypeWeights` (every archetype it can visit with
 * non-zero weight), not an invented static bracket. Real data, not a mock
 * fixture standing in for it.
 * @param {object} biome @param {string} axisName @returns {[number, number]|null}
 */
function driftBracket(biome, axisName) {
  const weights = biome?.archetypeWeights ?? {};
  const values = Object.keys(weights)
    .filter((id) => weights[id] > 0)
    .map((id) => WEATHER_ARCHETYPES.find((a) => a.id === id)?.axes?.[axisName])
    .filter((v) => Number.isFinite(v));
  if (values.length === 0) return null;
  return [Math.min(...values), Math.max(...values)];
}

/**
 * @param {HTMLElement} container
 * @param {{
 *   getWeatherMode: () => 'director'|'almanac',
 *   onWeatherModeChange: (mode: 'director'|'almanac') => void,
 *   getWeatherBiome: () => string|null,
 *   onWeatherBiomeChange: (id: string|null) => void,
 *   getWeatherArchetype: () => string,
 *   fadeToArchetype: (archetypeId: string, overMs: number) => void,
 *   getAxisValue: (axisName: string) => number,
 *   onAxisCommit: (axisName: string, value: number) => void,
 * }} ctx
 * @returns {{ getFadeOverMs: () => number, refresh: () => void }}
 */
export function renderWeatherBoard(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-wx-board';

  const modeRow = document.createElement('div');
  modeRow.className = 'msa-wx-modeseg';
  modeRow.setAttribute('role', 'group');
  modeRow.setAttribute('aria-label', 'Weather steering mode');
  const directBtn = document.createElement('button');
  directBtn.type = 'button';
  directBtn.textContent = 'Direct';
  directBtn.title = 'You choose the sky — mood chips are destinations, faders are trims.';
  const driftBtn = document.createElement('button');
  driftBtn.type = 'button';
  driftBtn.textContent = 'Drift';
  driftBtn.title = 'You set a climate — the sky wanders inside it on its own.';
  modeRow.append(directBtn, driftBtn);

  const chipRow = document.createElement('div');
  chipRow.className = 'msa-wx-chips';
  const fadeTime = createFadeTimeControl();
  const faderHost = document.createElement('div');
  faderHost.className = 'msa-wx-faders';

  wrap.append(modeRow, chipRow, fadeTime.root, faderHost);
  container.appendChild(wrap);

  function paintMode() {
    const mode = ctx.getWeatherMode();
    directBtn.setAttribute('aria-pressed', String(mode !== 'almanac'));
    driftBtn.setAttribute('aria-pressed', String(mode === 'almanac'));
  }
  directBtn.addEventListener('click', () => {
    ctx.onWeatherModeChange('director');
    paintMode();
    renderChips();
  });
  driftBtn.addEventListener('click', () => {
    ctx.onWeatherModeChange('almanac');
    paintMode();
    renderChips();
  });

  function renderChips() {
    chipRow.innerHTML = '';
    const mode = ctx.getWeatherMode();
    if (mode === 'almanac') {
      const activeBiome = ctx.getWeatherBiome();
      for (const biome of WEATHER_BIOMES) {
        const btn = chip(biome.label, biome.blurb, () => {
          ctx.onWeatherBiomeChange(biome.id);
          renderChips();
          renderFaders();
        });
        btn.setAttribute('aria-pressed', String(biome.id === activeBiome));
        chipRow.appendChild(btn);
      }
    } else {
      const activeArchetype = ctx.getWeatherArchetype();
      for (const archetype of WEATHER_ARCHETYPES) {
        const btn = chip(`${archetype.icon} ${archetype.label}`, archetype.blurb, () => {
          ctx.fadeToArchetype(archetype.id, fadeTime.getOverMs());
          // Re-paint NOW, not just on arrival: the sky is already 'custom'
          // the instant the fade starts (fadeToArchetype's own doc), so the
          // OLD chip must un-light immediately — leaving it lit would claim
          // an authored look that stopped being true the moment this fired.
          // The NEW chip does NOT light here (that would claim an arrival
          // that hasn't happened) — it lights only once boot.js's own pump
          // calls refreshWeatherBoard() on actual completion.
          renderChips();
        });
        btn.setAttribute('aria-pressed', String(archetype.id === activeArchetype));
        chipRow.appendChild(btn);
      }
    }
  }

  function renderFaders() {
    faderHost.innerHTML = '';
    const mode = ctx.getWeatherMode();
    const biome = mode === 'almanac' ? WEATHER_BIOMES.find((b) => b.id === ctx.getWeatherBiome()) : null;
    for (const channel of LIVE_CHANNELS) {
      const decl = { type: 'float', min: 0, max: 1, step: 0.01, default: 0, label: channel.label, help: channel.help };
      const row = buildParamControl(channel.axis, decl, {
        value: ctx.getAxisValue(channel.axis),
        onChange: (v) => ctx.onAxisCommit(channel.axis, v),
      });
      if (biome) {
        const bracket = driftBracket(biome, channel.axis);
        if (bracket) {
          const note = document.createElement('span');
          note.className = 'msa-wx-bracket';
          note.textContent = `range ${bracket[0].toFixed(2)}–${bracket[1].toFixed(2)}`;
          note.title = `${biome.label} can wander this ${channel.label.toLowerCase()} range on its own in Drift mode.`;
          row.appendChild(note);
        }
      }
      faderHost.appendChild(row);
    }
  }

  paintMode();
  renderChips();
  renderFaders();

  return {
    getFadeOverMs: fadeTime.getOverMs,
    refresh() {
      paintMode();
      renderChips();
      renderFaders();
    },
  };
}
