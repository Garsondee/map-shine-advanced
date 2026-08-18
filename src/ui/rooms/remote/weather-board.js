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
import { iconMarkup } from '../../widgets/icon-sprite.js';

/**
 * The mock's own ".blocklabel" — icon + title + an optional right-aligned
 * hint (2026-08-18 fix; author report: "Fade time isn't added yet" and
 * "lots of UI elements aren't in place yet"). `titleEl` is handed in rather
 * than built here so callers needing a LIVE title (Moods/Climates swapping
 * with mode) can keep their own reference to update later.
 * @param {string} icon @param {HTMLElement} titleEl @param {HTMLElement} [trailingEl]
 */
function blockLabel(icon, titleEl, trailingEl) {
  const label = document.createElement('div');
  label.className = 'msa-wx-blocklabel';
  const iconSpan = document.createElement('span');
  iconSpan.className = 'ico';
  iconSpan.innerHTML = iconMarkup(icon);
  label.append(iconSpan, titleEl);
  if (trailingEl) label.appendChild(trailingEl);
  return label;
}

/** The two, and only two, live-today WEATHER channels (their own commit
 * path, `ctx.onAxisCommit`, also stamps `weatherArchetype:'custom'` — right
 * for these, wrong for the two env channels below). Adding a third is a
 * schema change in world/weather.js (flip consumerStatus, wire a real
 * consumer) BEFORE it is a UI change here — never the other way round. */
const LIVE_CHANNELS = Object.freeze([
  { axis: 'cloudCover01', label: 'Clouds', help: 'How much sky is covered.' },
  { axis: 'precip01', label: 'Rain', help: 'How hard it is coming down.' },
]);

/** Sky Light + Atmosphere (2026-08-18 fix — gap-audit against the old
 * astrolabe.js's own tuning-drawer sliders, entirely missing from the new
 * Remote before this). NOT weather axes — no archetype/biome relationship,
 * so each gets its own `ctx` getter/commit pair rather than folding into
 * `LIVE_CHANNELS`/`onAxisCommit` above. */
const ENV_CHANNELS = Object.freeze([
  {
    key: 'skyRealism',
    label: 'Sky light',
    help: 'How much the sky itself lights the scene.',
    getValue: 'getSkyRealism',
    onCommit: 'onSkyRealismCommit',
  },
  {
    key: 'atmosphere',
    label: 'Atmosphere',
    help: 'Environmental colour-grade strength.',
    getValue: 'getGradeEnvStrength',
    onCommit: 'onGradeEnvStrengthCommit',
  },
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
 *   getWeatherVolatility?: () => number, onWeatherVolatilityCommit?: (v: number) => void,
 *   getSkyRealism?: () => number, onSkyRealismCommit?: (v: number) => void,
 *   getGradeEnvStrength?: () => number, onGradeEnvStrengthCommit?: (v: number) => void,
 *   getSceneOverride?: () => boolean, onSceneOverrideCommit?: (enabled: boolean) => void,
 * }} ctx
 * @returns {{ getFadeOverMs: () => number, refresh: () => void }}
 */
export function renderWeatherBoard(container, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-wx-board';

  // ---- FADE TIME block (2026-08-18 fix) — matches the mock's own DOM
  // order exactly: Fade Time first, THEN Moods, THEN Channels (production
  // had Moods/mode-toggle first, Fade Time second — a real ordering miss,
  // not just a missing label).
  const fadeTitle = document.createElement('span');
  fadeTitle.textContent = 'Fade time';
  const fadeHint = document.createElement('span');
  fadeHint.className = 'msa-wx-hint';
  const fadeTime = createFadeTimeControl();
  function syncFadeHint() {
    const label = fadeTime.getLabel();
    fadeHint.textContent = label === 'Now' ? 'changes cut instantly' : `changes ease over ${label}`;
  }
  syncFadeHint();
  // Delegated, not owned: fade-time.js's own per-button listeners (added
  // during createFadeTimeControl() above, so they run first) already update
  // its internal index before this bubbles here — reading getLabel() after
  // is safe, and fade-time.js stays free of a weather-board-specific hook.
  fadeTime.root.addEventListener('click', syncFadeHint);
  const fadeBlock = document.createElement('div');
  fadeBlock.append(blockLabel('clock', fadeTitle, fadeHint), fadeTime.root);

  // ---- MOODS/CLIMATES block — mode toggle now lives INSIDE the block
  // label's own row (mock: #wxTitle + .modeseg share one line), not as its
  // own separate full-width row above the chips.
  const moodsTitle = document.createElement('span');
  moodsTitle.textContent = 'Moods';
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
  // Pace (2026-08-18 fix) — the old astrolabe.js's own weatherVolatility
  // slider, which sat right beside its Climate select in the tuning
  // drawer. Meaningless in Direct mode (nothing is walking on its own to
  // pace), so it only renders in Drift, same conditional shape
  // renderFaders() already uses for the drift-bracket notes.
  const paceHost = document.createElement('div');
  const moodsBlock = document.createElement('div');
  moodsBlock.append(blockLabel('cloud', moodsTitle, modeRow), chipRow, paceHost);

  // ---- CHANNELS block — label is real regardless of how many of the 7
  // mock channels have live backing today (LIVE_CHANNELS, above): "Channels"
  // names what the section IS, not how many rows happen to be in it.
  const chanTitle = document.createElement('span');
  chanTitle.textContent = 'Channels';
  const faderHost = document.createElement('div');
  faderHost.className = 'msa-wx-faders';
  const chanBlock = document.createElement('div');
  chanBlock.append(blockLabel('gauge', chanTitle), faderHost);

  wrap.append(fadeBlock, moodsBlock, chanBlock);
  container.appendChild(wrap);

  function paintMode() {
    const mode = ctx.getWeatherMode();
    directBtn.setAttribute('aria-pressed', String(mode !== 'almanac'));
    driftBtn.setAttribute('aria-pressed', String(mode === 'almanac'));
    moodsTitle.textContent = mode === 'almanac' ? 'Climates' : 'Moods';
  }
  directBtn.addEventListener('click', () => {
    ctx.onWeatherModeChange('director');
    paintMode();
    renderChips();
    renderPace();
  });
  driftBtn.addEventListener('click', () => {
    ctx.onWeatherModeChange('almanac');
    paintMode();
    renderChips();
    renderPace();
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
    // Sky Light + Atmosphere (2026-08-18 fix) — own commit path per channel
    // (ctx[channel.getValue]/ctx[channel.onCommit]), never ctx.onAxisCommit,
    // since these aren't weather axes and must NOT stamp
    // weatherArchetype:'custom' the way LIVE_CHANNELS' own commit does.
    for (const channel of ENV_CHANNELS) {
      const decl = { type: 'float', min: 0, max: 1, step: 0.01, default: 0, label: channel.label, help: channel.help };
      const getValue = ctx[channel.getValue];
      const onCommit = ctx[channel.onCommit];
      if (typeof getValue !== 'function') continue;
      faderHost.appendChild(
        buildParamControl(channel.key, decl, { value: getValue(), onChange: (v) => onCommit?.(v) })
      );
    }
    // Scene override (2026-08-18 fix) — the old astrolabe.js's own "this
    // scene has its own sky" checkbox. Real bool param via the SAME
    // buildParamControl door every other row here uses, not a hand-built
    // checkbox.
    if (typeof ctx.getSceneOverride === 'function') {
      faderHost.appendChild(
        buildParamControl(
          'sceneOverride',
          { type: 'bool', label: 'This scene has its own sky', help: 'Per-scene sky, not the world default.' },
          { value: ctx.getSceneOverride(), onChange: (v) => ctx.onSceneOverrideCommit?.(v) }
        )
      );
    }
  }

  /** Pace, own function since it's gated on mode alone (unlike renderChips/
   * renderFaders, it never needs to re-run on a chip click). */
  function renderPace() {
    paceHost.innerHTML = '';
    if (ctx.getWeatherMode() !== 'almanac' || typeof ctx.getWeatherVolatility !== 'function') return;
    const decl = {
      type: 'float',
      min: 0.25,
      max: 4,
      step: 0.25,
      default: 1,
      label: 'Pace',
      help: 'How fast the climate wanders on its own in Drift mode.',
    };
    paceHost.appendChild(
      buildParamControl('weatherVolatility', decl, {
        value: ctx.getWeatherVolatility(),
        onChange: (v) => ctx.onWeatherVolatilityCommit?.(v),
      })
    );
  }

  paintMode();
  renderChips();
  renderFaders();
  renderPace();

  return {
    getFadeOverMs: fadeTime.getOverMs,
    refresh() {
      paintMode();
      renderChips();
      renderFaders();
      renderPace();
    },
  };
}
