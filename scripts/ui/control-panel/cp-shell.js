/**
 * @fileoverview Native shell helpers for the GM Control Panel (no Tweakpane).
 * @module ui/control-panel/cp-shell
 */

/**
 * @param {HTMLElement} container
 */
export function createControlPanelShell(container) {
  container.classList.add('msa-cp');
  container.innerHTML = '';

  const wand = document.createElement('div');
  wand.className = 'msa-cp__wand';

  const headBlock = document.createElement('div');
  headBlock.className = 'msa-cp__head-block';

  const headGlass = document.createElement('div');
  headGlass.className = 'msa-cp__head-glass';

  const headChrome = document.createElement('div');
  headChrome.className = 'msa-cp__head-chrome';
  headChrome.dataset.msCpDrag = '1';

  const topTitle = document.createElement('span');
  topTitle.className = 'msa-cp__top-title';
  topTitle.textContent = 'Map Shine';

  const modeBar = document.createElement('div');
  modeBar.className = 'msa-cp__mode-bar';

  const minimizeSlot = document.createElement('div');
  minimizeSlot.className = 'msa-cp__minimize-slot';

  headChrome.appendChild(topTitle);
  headChrome.appendChild(modeBar);
  headChrome.appendChild(minimizeSlot);

  const zoneDial = document.createElement('div');
  zoneDial.className = 'msa-cp__zone msa-cp__zone--dial msa-cp-dial-assembly';
  zoneDial.dataset.zone = 'dial';

  const weatherStatusStrip = document.createElement('div');
  weatherStatusStrip.className = 'msa-cp__weather-status';
  weatherStatusStrip.dataset.zone = 'weatherStatus';

  headGlass.appendChild(headChrome);
  headGlass.appendChild(zoneDial);
  headGlass.appendChild(weatherStatusStrip);
  headBlock.appendChild(headGlass);

  const zoneMacro = document.createElement('div');
  zoneMacro.className = 'msa-cp__zone msa-cp__zone--macro';
  zoneMacro.dataset.zone = 'macro';
  zoneMacro.hidden = true;

  const body = document.createElement('div');
  body.className = 'remote-body msa-cp__body';

  const stickControls = document.createElement('div');
  stickControls.className = 'msa-cp__stick-controls';
  body.appendChild(stickControls);

  const zoneMixer = document.createElement('div');
  zoneMixer.className = 'msa-cp__zone msa-cp__zone--mixer';
  zoneMixer.dataset.zone = 'mixer';
  body.appendChild(zoneMixer);

  const strikeZone = document.createElement('div');
  strikeZone.className = 'msa-cp__zone msa-cp__zone--strikes';
  strikeZone.dataset.zone = 'strikes';
  body.appendChild(strikeZone);

  const tileMotionStrip = document.createElement('div');
  tileMotionStrip.className = 'msa-cp__tile-motion-strip';
  tileMotionStrip.dataset.zone = 'tileMotionStrip';
  body.appendChild(tileMotionStrip);

  const advancedToggle = document.createElement('button');
  advancedToggle.type = 'button';
  advancedToggle.className = 'msa-cp__advanced-toggle';
  advancedToggle.textContent = '+ Advanced Settings';
  body.appendChild(advancedToggle);

  const advancedDrawer = document.createElement('div');
  advancedDrawer.className = 'msa-cp__advanced-drawer';
  advancedDrawer.hidden = true;

  const zoneAdvanced = document.createElement('div');
  zoneAdvanced.className = 'msa-cp__zone msa-cp__zone--advanced';
  zoneAdvanced.dataset.zone = 'advanced';
  advancedDrawer.appendChild(zoneAdvanced);

  wand.appendChild(headBlock);
  wand.appendChild(body);
  wand.appendChild(advancedDrawer);
  container.appendChild(wand);

  advancedToggle.addEventListener('click', () => {
    const open = advancedDrawer.hidden;
    advancedDrawer.hidden = !open;
    advancedToggle.textContent = open ? '− Advanced Settings' : '+ Advanced Settings';
    advancedToggle.classList.toggle('is-open', open);
    advancedDrawer.classList.toggle('is-open', open);
  });

  return {
    root: container,
    wand,
    header: headChrome,
    topBar: headChrome,
    crown: headChrome,
    headBlock,
    headGlass,
    headChrome,
    minimizeSlot,
    modeBar,
    body,
    stickControls,
    strikeZone,
    weatherStatusStrip,
    tileMotionStrip,
    advancedToggle,
    advancedDrawer,
    zones: {
      macro: zoneMacro,
      dial: zoneDial,
      weatherStatus: weatherStatusStrip,
      mixer: zoneMixer,
      strikes: strikeZone,
      tileMotionStrip,
      advanced: zoneAdvanced,
    },
  };
}

/**
 * @param {HTMLElement} parent
 * @param {{ id: string, title: string, tagKey?: string, expanded?: boolean, collapsible?: boolean }} spec
 */
export function createSection(parent, spec) {
  const section = document.createElement('section');
  section.className = 'msa-cp-section';
  section.dataset.sectionId = spec.id;

  const header = document.createElement('button');
  header.type = 'button';
  header.className = 'msa-cp-section__header';
  header.setAttribute('aria-expanded', spec.expanded !== false ? 'true' : 'false');

  const titleSpan = document.createElement('span');
  titleSpan.className = 'msa-cp-section__title';
  titleSpan.textContent = spec.title;

  const tag = document.createElement('span');
  tag.className = `msa-cp-section__tag map-shine-folder-tag map-shine-folder-tag-${spec.tagKey || spec.id}`;
  tag.style.display = 'none';

  header.appendChild(titleSpan);
  if (spec.tagKey) header.appendChild(tag);

  const body = document.createElement('div');
  body.className = 'msa-cp-section__body';
  if (spec.expanded === false) body.hidden = true;

  const collapsible = spec.collapsible !== false;
  if (collapsible) {
    header.addEventListener('click', () => {
      const next = body.hidden;
      body.hidden = !next;
      header.setAttribute('aria-expanded', next ? 'true' : 'false');
      section.classList.toggle('is-collapsed', !next);
    });
  } else {
    header.disabled = true;
    header.classList.add('msa-cp-section__header--static');
  }

  section.appendChild(header);
  section.appendChild(body);
  parent.appendChild(section);

  const setExpanded = (v) => {
    body.hidden = !v;
    header.setAttribute('aria-expanded', v ? 'true' : 'false');
    section.classList.toggle('is-collapsed', !v);
  };

  return { section, header, body, tag: spec.tagKey ? tag : null, setExpanded };
}

/**
 * @param {string} label
 * @param {() => void} onClick
 * @param {{ danger?: boolean, className?: string }} [opts]
 */
export function createCpButton(label, onClick, opts = {}) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = ['msa-cp-btn', opts.className].filter(Boolean).join(' ');
  if (opts.danger) btn.classList.add('msa-cp-btn--danger');
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Compact [ − ] value [ + ] stepper row.
 */
export function createStepperControl(spec) {
  const row = document.createElement('div');
  row.className = 'msa-cp-stepper';
  if (spec.title) row.title = spec.title;

  const lblWrap = document.createElement('span');
  lblWrap.className = 'msa-cp-stepper__label-wrap';

  const lbl = document.createElement('span');
  lbl.className = 'msa-cp-stepper__label';
  lbl.textContent = spec.label;

  lblWrap.appendChild(lbl);
  if (spec.hint) {
    const hint = document.createElement('span');
    hint.className = 'msa-cp-stepper__hint';
    hint.textContent = spec.hint;
    lblWrap.appendChild(hint);
  }

  const minus = document.createElement('button');
  minus.type = 'button';
  minus.className = 'msa-cp-stepper__btn';
  minus.textContent = '−';

  const readout = document.createElement('span');
  readout.className = 'msa-cp-stepper__value';

  const plus = document.createElement('button');
  plus.type = 'button';
  plus.className = 'msa-cp-stepper__btn';
  plus.textContent = '+';

  let value = spec.value;
  const fmt = spec.format || ((v) => String(v));

  const clamp = (v) => Math.max(spec.min, Math.min(spec.max, v));
  const render = () => { readout.textContent = fmt(value); };
  const commit = (last) => {
    value = clamp(value);
    render();
    spec.onChange(value, last);
  };

  minus.addEventListener('click', () => {
    value = clamp(value - spec.step);
    commit(true);
  });
  plus.addEventListener('click', () => {
    value = clamp(value + spec.step);
    commit(true);
  });

  row.appendChild(lblWrap);
  row.appendChild(minus);
  row.appendChild(readout);
  row.appendChild(plus);
  render();

  const mirror = (v) => {
    if (!Number.isFinite(v)) return;
    value = clamp(v);
    render();
  };

  return { row, mirror };
}

/** Non-linear environment fade stops: index 0 = instant, 1 = 10s, 20 = 30 min. */
export const FADE_TIME_STOP_MINUTES = Object.freeze((() => {
  const stops = [0, 10 / 60];
  for (let i = 1; i <= 18; i++) {
    const t = i / 18;
    const sec = 10 + (1800 - 10) * Math.pow(t, 1.65);
    stops.push(sec / 60);
  }
  stops.push(30);
  return stops;
})());

/**
 * @param {number} minutes
 * @returns {number}
 */
export function fadeMinutesToStopIndex(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 0;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < FADE_TIME_STOP_MINUTES.length; i++) {
    const d = Math.abs(FADE_TIME_STOP_MINUTES[i] - m);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * @param {number} index
 * @returns {number}
 */
export function fadeStopIndexToMinutes(index) {
  const i = Math.max(0, Math.min(FADE_TIME_STOP_MINUTES.length - 1, Math.round(Number(index) || 0)));
  return FADE_TIME_STOP_MINUTES[i];
}

/**
 * @param {number} minutes
 * @returns {string}
 */
export function formatFadeMinutes(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0) return 'Instant';
  if (m < 1) {
    const sec = Math.round(m * 60);
    return sec <= 1 ? '1s' : `${sec}s`;
  }
  if (Math.abs(m - Math.round(m)) < 0.05) return `${Math.round(m)} min`;
  return `${m.toFixed(1)} min`;
}

/**
 * Slider row for environment fade duration (instant → 10s → … → 30 min).
 */
export function createFadeTimeSlider(spec) {
  const row = document.createElement('div');
  row.className = 'msa-cp-fade-slider';
  if (spec.title) row.title = spec.title;

  const lblWrap = document.createElement('span');
  lblWrap.className = 'msa-cp-fade-slider__label-wrap';

  const lbl = document.createElement('span');
  lbl.className = 'msa-cp-fade-slider__label';
  lbl.textContent = spec.label;

  lblWrap.appendChild(lbl);
  if (spec.hint) {
    const hint = document.createElement('span');
    hint.className = 'msa-cp-fade-slider__hint';
    hint.textContent = spec.hint;
    lblWrap.appendChild(hint);
  }

  const readout = document.createElement('span');
  readout.className = 'msa-cp-fade-slider__value';

  const trackWrap = document.createElement('div');
  trackWrap.className = 'msa-cp-fade-slider__track-wrap';

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'msa-cp-fade-slider__range';
  input.min = '0';
  input.max = String(FADE_TIME_STOP_MINUTES.length - 1);
  input.step = '1';

  const ends = document.createElement('div');
  ends.className = 'msa-cp-fade-slider__ends';
  ends.innerHTML = '<span>Instant</span><span>30 min</span>';

  trackWrap.appendChild(input);
  trackWrap.appendChild(ends);

  let stopIndex = fadeMinutesToStopIndex(spec.value);

  const render = () => {
    input.value = String(stopIndex);
    readout.textContent = formatFadeMinutes(fadeStopIndexToMinutes(stopIndex));
  };

  const commit = (last) => {
    stopIndex = Math.max(0, Math.min(FADE_TIME_STOP_MINUTES.length - 1, stopIndex));
    render();
    spec.onChange(fadeStopIndexToMinutes(stopIndex), last);
  };

  input.addEventListener('input', () => {
    stopIndex = Number(input.value) || 0;
    render();
    spec.onChange(fadeStopIndexToMinutes(stopIndex), false);
  });
  input.addEventListener('change', () => {
    stopIndex = Number(input.value) || 0;
    commit(true);
  });

  row.appendChild(lblWrap);
  row.appendChild(readout);
  row.appendChild(trackWrap);
  render();

  const mirror = (minutes) => {
    stopIndex = fadeMinutesToStopIndex(minutes);
    render();
  };

  return { row, mirror, input, readout };
}

/**
 * @param {Record<string, string>} options label -> value
 * @param {string} current
 * @param {(value: string) => void} onChange
 */
export function createSegmentedControl(options, current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'msa-cp-segmented';

  const entries = Object.entries(options);
  const buttons = [];

  for (const [label, value] of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msa-cp-segmented__btn';
    btn.textContent = label;
    btn.dataset.value = value;
    btn.classList.toggle('is-active', value === current);
    btn.addEventListener('click', () => {
      for (const b of buttons) b.classList.toggle('is-active', b === btn);
      onChange(value);
    });
    buttons.push(btn);
    wrap.appendChild(btn);
  }

  const mirror = (value) => {
    for (const b of buttons) b.classList.toggle('is-active', b.dataset.value === value);
  };

  return { wrap, mirror };
}

/**
 * @param {{ type: 'range'|'number'|'select'|'toggle', label?: string, target: object, key: string, min?: number, max?: number, step?: number, options?: Record<string,string>, onChange?: (v: unknown, last?: boolean)=>void, disabled?: boolean }} spec
 */
export function createNativeControl(spec) {
  const row = document.createElement('div');
  row.className = 'msa-cp-control';

  if (spec.label) {
    const lbl = document.createElement('label');
    lbl.className = 'msa-cp-control__label';
    lbl.textContent = spec.label;
    row.appendChild(lbl);
  }

  let input;
  const mirror = () => {
    const v = spec.target[spec.key];
    if (!input) return;
    if (spec.type === 'toggle') {
      input.checked = !!v;
    } else if (spec.type === 'select') {
      input.value = String(v ?? '');
    } else {
      input.value = String(v ?? '');
    }
  };

  if (spec.type === 'toggle') {
    input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'msa-cp-control__toggle';
    input.checked = !!spec.target[spec.key];
    input.disabled = !!spec.disabled;
    input.addEventListener('change', () => {
      spec.target[spec.key] = input.checked;
      spec.onChange?.(input.checked, true);
    });
  } else if (spec.type === 'select') {
    input = document.createElement('select');
    input.className = 'msa-cp-control__select';
    for (const [label, value] of Object.entries(spec.options || {})) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      input.appendChild(opt);
    }
    input.value = String(spec.target[spec.key] ?? '');
    input.disabled = !!spec.disabled;
    input.addEventListener('change', () => {
      spec.target[spec.key] = input.value;
      spec.onChange?.(input.value, true);
    });
  } else {
    input = document.createElement('input');
    input.type = spec.type === 'number' ? 'number' : 'range';
    input.className = spec.type === 'range' ? 'msa-cp-control__range' : 'msa-cp-control__number';
    if (Number.isFinite(spec.min)) input.min = String(spec.min);
    if (Number.isFinite(spec.max)) input.max = String(spec.max);
    if (Number.isFinite(spec.step)) input.step = String(spec.step);
    input.value = String(spec.target[spec.key] ?? '');
    input.disabled = !!spec.disabled;

    const emit = (last) => {
      const raw = spec.type === 'range' ? input.valueAsNumber : parseFloat(input.value);
      if (!Number.isFinite(raw)) return;
      spec.target[spec.key] = raw;
      spec.onChange?.(raw, last);
    };

    input.addEventListener('input', () => emit(false));
    input.addEventListener('change', () => emit(true));
  }

  row.appendChild(input);
  return { row, input, mirror };
}

/** Trigger panel clunk micro-interaction. */
export function triggerPanelClunk(container) {
  if (!container) return;
  container.classList.add('msa-cp--clunk');
  window.setTimeout(() => container.classList.remove('msa-cp--clunk'), 50);
}

/** Open the advanced settings drawer programmatically. */
export function openAdvancedDrawer(shell) {
  if (!shell?.advancedDrawer || !shell?.advancedToggle) return;
  shell.advancedDrawer.hidden = false;
  shell.advancedDrawer.classList.add('is-open');
  shell.advancedToggle.textContent = '− Advanced Settings';
  shell.advancedToggle.classList.add('is-open');
}
