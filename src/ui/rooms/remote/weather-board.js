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
 * ⚠️ ONLY `cloudCover01`, `precip01`, AND (2026-08-18) `temperature01` GET
 * FADERS — `WEATHER_AXES`' own `consumerStatus` names exactly these three
 * as `'live'`; `cloudType01`/`cloudAltitudePx`/`cloudScalePx` are still
 * honestly `'pending'` (re-checked fresh, `world/cloud-field.js` still does
 * not exist) and are not rendered at all here — Law 5,
 * `tools/verify-structure.mjs#ui/no-dead-axis` holds the line structurally.
 * The mock's own 7-channel list (rain/clouds/fog/wind/freeze/bolt/ash) is
 * NOT reproduced whole: fog/freeze/ash have no live axis, lightning is an
 * impulse (not a fade channel, U7's job). Wind STRENGTH, unlike those three,
 * IS a channel here (2026-08-27 fix, author: "wind speed should be one of
 * the vertical sliders") — this reverses an earlier call on this exact
 * question: `ui/astrolabe.js`'s OLD dial had its own always-visible wind
 * arrow+slider built into the ring, so a second fader here really would have
 * been the "two controls, one value" mirror Environment.md §2.4 warns
 * against. The NEW dial (`astrolabe-dial.js`) has no such built-in slider —
 * wind edit lives only behind a popover the pill must be clicked to open
 * (`ui/rooms/remote/wind-popover.js`) — so the old reasoning no longer
 * describes this codebase's actual shape. Direction stays popover-only (an
 * angle has no vertical-fader equivalent); strength moves here AND out of
 * the popover (wind-popover.js's own header explains that half), so there is
 * still exactly one editable home for each, never two.
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
import { buildVerticalFader } from '../../widgets/vertical-fader.js';
import { createFadeTimeControl } from './fade-time.js';
import { iconMarkup } from '../../widgets/icon-sprite.js';
import { installWeatherPicker, buildWeatherIndex } from './weather-picker.js';

/**
 * THE FAVOURITES CURATION (2026-08-18 fix; author's own screenshot
 * comparison: "Climate buttons need to be better organised. We need the
 * extra opening room of climate choices."). `WEATHER_ARCHETYPES`/
 * `WEATHER_BIOMES` carry no favourite/featured flag — there is no data-level
 * source of truth to derive this split from, so this is a WORKER-TIER
 * judgment call, named as one rather than presented as derived, and worth
 * the author's countersign if the read is wrong (same posture Petition P19
 * already took for water's own FOH dial curation).
 *
 * Direct: 8 of 16, spanning the severity gradient `WEATHER_ARCHETYPES`' own
 * shelf order already encodes (clear → thickening → raining → extreme) —
 * clear/fair/overcast/fog/rain/snow/gale/storm reads as "the greatest hits"
 * rather than an arbitrary slice. The remaining 8 (thinner-cloud variants,
 * blends, disaster-specific rows) are exactly as real, just one click
 * further away via Browse.
 */
export const FAVOURITE_ARCHETYPE_IDS = Object.freeze([
  'clear',
  'fair-cumulus',
  'overcast',
  'fog',
  'steady-rain',
  'snow',
  'gale',
  'thunderstorm',
]);

/**
 * Drift: 6 of 10 — the biomes that read as useful in almost any campaign
 * (temperate coast/plains/desert/tundra/monsoon/mountain), leaving the four
 * more setting-specific ones (Moorland Mire, Volcanic Waste, Feywild Glade,
 * Shadowfell Verge) for Browse, which fits their own flavour: reach for them
 * when a scene specifically calls for the unusual, not by default.
 */
export const FAVOURITE_BIOME_IDS = Object.freeze([
  'temperate-coast',
  'continental-plains',
  'desert',
  'boreal-tundra',
  'tropical-monsoon',
  'high-mountain',
]);

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

/** Sky Light + Atmosphere + Temperature — each gets its own `ctx` getter/
 * commit pair rather than folding into `LIVE_CHANNELS`/`onAxisCommit`
 * above, for two DIFFERENT reasons that land on the same shape:
 *   - Sky Light/Atmosphere (2026-08-18 fix — gap-audit against the old
 *     astrolabe.js's own tuning-drawer sliders) aren't weather axes at
 *     all — no archetype/biome relationship to stamp `'custom'` against.
 *   - Temperature (2026-08-18 fix — author pressing again on "still
 *     missing sliders"; `WEATHER_AXES.temperature01` re-checked fresh,
 *     confirmed `consumerStatus:'live'`) genuinely IS a weather axis, but
 *     `ARCHETYPE_OWNED_AXES` deliberately excludes it ("a sky is not a
 *     climate") — `LIVE_CHANNELS`' own `onAxisCommit` stamping
 *     `weatherArchetype:'custom'` on every commit would be WRONG here,
 *     wrongly un-lighting the active mood chip over an edit that has
 *     nothing to do with it.
 */
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
  {
    key: 'temperature',
    label: 'Temperature',
    help: 'Cold to hot — also decides whether precipitation falls as rain or snow.',
    getValue: 'getTemperature',
    onCommit: 'onTemperatureCommit',
  },
  {
    key: 'windSpeed',
    label: 'Wind',
    help: 'How hard the wind blows. Direction is set from the astrolabe’s own wind pill.',
    getValue: 'getWindSpeed01',
    onCommit: 'onWindSpeed01Commit',
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
 *   getCloudPinned?: () => boolean, onUnpinCloudCover?: () => void,
 *   getForecast?: () => {archetypeId: string, atGameHoursFromNow: number}|null,
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
  // Browse (2026-08-18 fix) — the mock's own #wxBrowseBtn: icon + "Browse" +
  // a live count of the FULL catalog, opening weather-picker.js's overlay.
  // Mock places it beside the mode toggle in the same header row, not its
  // own row — matched here via a small wrapper `headerRight`, since
  // blockLabel() only takes one trailing element.
  const browseBtn = document.createElement('button');
  browseBtn.type = 'button';
  browseBtn.className = 'msa-wx-browse';
  browseBtn.innerHTML = `${iconMarkup('search')}<span>Browse</span><span class="msa-wx-browse-count"></span>`;
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
  const headerRight = document.createElement('div');
  headerRight.className = 'msa-wx-header-right';
  headerRight.append(browseBtn, modeRow);
  const chipRow = document.createElement('div');
  chipRow.className = 'msa-wx-chips';
  // Pace (2026-08-18 fix) — the old astrolabe.js's own weatherVolatility
  // slider, which sat right beside its Climate select in the tuning
  // drawer. Meaningless in Direct mode (nothing is walking on its own to
  // pace), so it only renders in Drift, same conditional shape
  // renderFaders() already uses for the drift-bracket notes.
  const paceHost = document.createElement('div');
  // The Almanac forecast (2026-08-18 fix — gap-audit against the old
  // astrolabe.js's own real `forecastRow`/`surpriseRow`, which never made it
  // into the new Remote at all). Real data: `weather.forecast()`
  // (world/weather.js) already projects the walk forward for free by
  // cloning the live RNG, and `vt-pan-viewer.js`'s own `getTimeDialState()`
  // already surfaces `.transitions[0]` as `weatherForecastNext` — boot.js's
  // `ctx.getForecast()` just reads that existing door, no new engine work.
  // Drift-mode-only, same gate as Pace just below: `forecast()`'s own FIRST
  // check is `currentMode !== 'almanac'`, so the value is already always
  // null outside Drift — this file's gate matches the data's own truth,
  // not just a cosmetic mirror of it.
  const forecastHost = document.createElement('div');
  const moodsBlock = document.createElement('div');
  moodsBlock.append(blockLabel('cloud', moodsTitle, headerRight), chipRow, forecastHost, paceHost);

  // THE BROWSE OVERLAY — one instance per board, built here (not threaded
  // through ctx) same as fadeTime just above: a sibling-imported sub-widget
  // this file owns outright, not a boot.js-owned engine mount point (that
  // distinction is astrolabe-panel.js's own, for its DIAL specifically —
  // weather-board.js already reaches world/index.js directly for the same
  // two tables this picker searches).
  const weatherPicker = installWeatherPicker({
    getWeatherMode: ctx.getWeatherMode,
    onPickArchetype: (id) => {
      ctx.fadeToArchetype(id, fadeTime.getOverMs());
      renderChips();
    },
    onPickBiome: (id) => {
      ctx.onWeatherBiomeChange(id);
      renderChips();
      renderFaders();
      renderForecast();
    },
  });
  browseBtn.addEventListener('click', () => weatherPicker.open());
  function syncBrowseBtn() {
    const mode = ctx.getWeatherMode();
    const total = buildWeatherIndex(mode).length;
    browseBtn.querySelector('.msa-wx-browse-count').textContent = String(total);
    browseBtn.title = `Browse all ${total} ${mode === 'almanac' ? 'climates' : 'weather types'}`;
  }

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
    renderForecast();
    renderPace();
    syncBrowseBtn();
    // 2026-08-18 fix, caught live while testing the cloud-pin glyph: neither
    // mode button ever called renderFaders(), so the pin glyph (Almanac-only)
    // and the drift-bracket note (also Almanac-only, driftBracket()) both
    // stayed however they last were until some OTHER trigger rebuilt the
    // fader rows — a biome-chip click already does this (see renderChips'
    // own biome handler above), the mode toggle itself just never did.
    renderFaders();
  });
  driftBtn.addEventListener('click', () => {
    ctx.onWeatherModeChange('almanac');
    paintMode();
    renderChips();
    renderForecast();
    renderPace();
    syncBrowseBtn();
    renderFaders();
  });

  function renderChips() {
    chipRow.innerHTML = '';
    const mode = ctx.getWeatherMode();
    if (mode === 'almanac') {
      const activeBiome = ctx.getWeatherBiome();
      // FAVOURITE_BIOME_IDS' own order (declared above), not WEATHER_BIOMES'
      // — the shelf order is a UI-layer curation choice, decoupled from the
      // data table's own order.
      const favourites = FAVOURITE_BIOME_IDS.map((id) => WEATHER_BIOMES.find((b) => b.id === id)).filter(Boolean);
      for (const biome of favourites) {
        const btn = chip(biome.label, biome.blurb, () => {
          ctx.onWeatherBiomeChange(biome.id);
          renderChips();
          renderFaders();
          // 2026-08-18 fix, caught live testing the forecast port: the ONLY
          // thing that flips weather.forecast() from unavailable ("no biome
          // selected") to available is exactly this click, and neither
          // biome-pick site here previously repainted anything forecast-
          // shaped -- same missed-call-site shape P27 already found for
          // Direct/Drift's own renderFaders() (this file's own comment on
          // that fix, a few lines up, predates this one).
          renderForecast();
        });
        btn.setAttribute('aria-pressed', String(biome.id === activeBiome));
        chipRow.appendChild(btn);
      }
    } else {
      const activeArchetype = ctx.getWeatherArchetype();
      // Which chip (if any) a fade is currently heading toward (2026-08-18
      // fix — author report: "mood buttons don't work yet"). Root cause:
      // `weatherArchetype` flips to 'custom' the INSTANT a fade starts, so
      // `archetype.id === activeArchetype` reads false for every chip
      // including the one just clicked — the whole row visibly goes dark
      // for the entire fade, no sign the click landed. `data-pending`
      // fixes that honestly: it names the TARGET without claiming arrival
      // (aria-pressed stays reserved for "this is what the sky IS").
      const fadingId = ctx.getFadingArchetypeId?.() ?? null;
      const favourites = FAVOURITE_ARCHETYPE_IDS.map((id) => WEATHER_ARCHETYPES.find((a) => a.id === id)).filter(
        Boolean
      );
      for (const archetype of favourites) {
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
        if (archetype.id === fadingId) btn.dataset.pending = 'true';
        chipRow.appendChild(btn);
      }
    }
  }

  function renderFaders() {
    faderHost.innerHTML = '';
    const mode = ctx.getWeatherMode();
    const biome = mode === 'almanac' ? WEATHER_BIOMES.find((b) => b.id === ctx.getWeatherBiome()) : null;
    // THE FADER RACK (2026-08-19 fix — author, verbatim: "Ideally the
    // vertical sliders would appear soon"). LIVE_CHANNELS + ENV_CHANNELS
    // render as a horizontal row of buildVerticalFader's own mixing-board
    // faders instead of buildParamControl's stacked horizontal rows — the
    // Scene-override checkbox below stays a normal row on purpose (it is a
    // bool, not a slider, and forcing it into fader shape would be exactly
    // the kind of control that represents nothing physical the Testament's
    // own widget-canon discipline warns against).
    const rack = document.createElement('div');
    rack.className = 'msa-wx-fader-rack';
    for (const channel of LIVE_CHANNELS) {
      const decl = { type: 'float', min: 0, max: 1, step: 0.01, default: 0, label: channel.label, help: channel.help };
      const fader = buildVerticalFader(channel.axis, decl, {
        value: ctx.getAxisValue(channel.axis),
        onChange: (v) => ctx.onAxisCommit(channel.axis, v),
      });
      if (biome) {
        const bracket = driftBracket(biome, channel.axis);
        if (bracket) {
          const note = document.createElement('span');
          note.className = 'msa-wx-bracket';
          note.textContent = `${bracket[0].toFixed(2)}–${bracket[1].toFixed(2)}`;
          note.title = `${biome.label} can wander this ${channel.label.toLowerCase()} range on its own in Drift mode.`;
          fader.appendChild(note);
        }
      }
      // THE CLOUD PIN GLYPH (2026-08-18 fix — gap-audit against the old
      // astrolabe.js's own Cloud row, astrolabe.js:358-373). The only axis
      // the Almanac can pin today (weather.js's own `pinnedAxes`) — visible
      // only in Drift mode while genuinely pinned, same two facts astrolabe.js
      // keys off, so it can't say "pinned" when Direct mode makes the concept
      // meaningless. Same `fader.appendChild` shape as the drift-bracket
      // note just above, not a new attachment mechanism.
      if (mode === 'almanac' && channel.axis === 'cloudCover01' && ctx.getCloudPinned?.()) {
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'msa-wx-pin';
        pin.textContent = '📌';
        pin.title = 'Pinned — the Almanac will not change this. Click to release.';
        pin.addEventListener('click', () => ctx.onUnpinCloudCover?.());
        fader.appendChild(pin);
      }
      rack.appendChild(fader);
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
      rack.appendChild(buildVerticalFader(channel.key, decl, { value: getValue(), onChange: (v) => onCommit?.(v) }));
    }
    faderHost.appendChild(rack);
    // Scene override — copy rewritten 2026-08-18 (author, verbatim: "'This
    // scene has it's own sky' is... esoteric. What the hell do you mean by
    // that?"). The control is real and needed (MSA sky settings live at
    // the WORLD level by default, shared by every scene — this is the one
    // switch that lets a specific scene, e.g. "the volcano lair," pin its
    // own weather independent of whatever the world is doing elsewhere);
    // the old label named the STATE without ever naming the CONSEQUENCE of
    // flipping it, which is what actually needed explaining. Real bool
    // param via the SAME buildParamControl door every other row here uses.
    if (typeof ctx.getSceneOverride === 'function') {
      faderHost.appendChild(
        buildParamControl(
          'sceneOverride',
          {
            type: 'bool',
            label: 'Scene overrides the world sky',
            help: 'On: changes you make here only affect this scene. Off: they change the shared sky every scene uses by default.',
          },
          { value: ctx.getSceneOverride(), onChange: (v) => ctx.onSceneOverrideCommit?.(v) }
        )
      );
    }
  }

  // ⚠️ LOCAL, SESSION-ONLY UI STATE, ported verbatim from the old astrolabe.js's
  // own reasoning: whether a GM wants foreknowledge is a personal reading
  // preference for a control they're looking at right now, not a fact about
  // the SCENE the way the weather itself is. Never persisted, never routed
  // through ctx — resets harmlessly to "visible" every load.
  let surpriseMe = false;

  /** The Almanac forecast row + "surprise me" toggle, own function for the
   * same reason as renderPace just below (gated on mode alone). Faithful
   * port of the old astrolabe.js's own `paintForecast` wording — see that
   * file for the two collapsed cases (`forecast()` returns the identical
   * `null` for "genuinely steady" and for "not available at all," e.g. no
   * biome chosen yet; the old panel never distinguished them either, so
   * this doesn't invent a distinction the underlying data can't back). */
  function renderForecast() {
    forecastHost.innerHTML = '';
    if (ctx.getWeatherMode() !== 'almanac' || typeof ctx.getForecast !== 'function') return;
    const text = document.createElement('div');
    text.className = 'msa-wx-forecast-text';
    if (surpriseMe) {
      text.textContent = '🎲 —';
    } else {
      const next = ctx.getForecast();
      if (!next) {
        text.textContent = 'Forecast: steady for now';
      } else {
        const archetype = WEATHER_ARCHETYPES.find((a) => a.id === next.archetypeId);
        const label = archetype ? `${archetype.icon} ${archetype.label}` : next.archetypeId;
        const h = next.atGameHoursFromNow;
        const eta = h < 1 ? `~${Math.max(1, Math.round(h * 60))}m` : `~${h < 10 ? h.toFixed(1) : Math.round(h)}h`;
        text.textContent = `Forecast: → ${label} in ${eta}`;
      }
    }
    forecastHost.appendChild(text);
    // Through the SAME buildParamControl door every bool row in this file
    // already uses (Scene override, above) — ui/canon-only's own ratchet
    // (tools/verify-structure.mjs) counts every hand-rolled `input.type=
    // 'checkbox'` outside it, and "surprise me" is not exempt just because
    // it's client-only UI state rather than a schema value: the wall's own
    // carve-out is for one-off UI CHOICES (a filter, a preset picker), and
    // this is a persistent-looking toggle a GM revisits every session. Its
    // own row() is already a full-width flex row (see param-control.js) —
    // stacked as its own line below the text rather than forced inline
    // beside it, the same shape every other control in this file already
    // uses, not a special case fought into a tighter space.
    forecastHost.appendChild(
      buildParamControl(
        'weatherForecastSurpriseMe',
        { type: 'bool', label: 'Surprise me', help: 'Hide the forecast text — walk the climate blind.' },
        {
          value: surpriseMe,
          onChange: (v) => {
            surpriseMe = v;
            renderForecast();
          },
        }
      )
    );
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
  renderForecast();
  renderPace();
  syncBrowseBtn();

  return {
    getFadeOverMs: fadeTime.getOverMs,
    refresh() {
      paintMode();
      renderChips();
      renderFaders();
      renderForecast();
      renderPace();
      syncBrowseBtn();
    },
  };
}
