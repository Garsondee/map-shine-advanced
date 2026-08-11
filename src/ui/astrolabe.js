/**
 * THE ASTROLABE — the Bridge's hero dial (docs/planning/Control-Panel.md §4.1).
 * One control that sets the MOOD of the world: time of day on the outer ring,
 * wind direction on the inner arrow, wind strength on a slider beneath.
 *
 * ============================================================================
 * WHAT CHANGED FROM V2'S DIAL, AND WHY
 * ============================================================================
 *
 * V2's version (`legacy/ui/control-panel/widgets/astrolabe-dial.js`, 723 lines)
 * was genuinely lovely and is the reason this exists at all. Three deliberate
 * departures, all author-directed:
 *
 *   1. **An arrow, not a windsock.** A sock reads as decoration; an arrow reads
 *      as a direction.
 *   2. **Strength is a slider, not a drag-distance.** V2 encoded wind speed in
 *      how far you dragged the sock outward, which meant one gesture carried
 *      two values and neither could be set precisely. Two axes, two controls.
 *   3. **The ring is DERIVED, not hand-placed.** V2 drew eight hand-positioned
 *      hour stops over a fixed decorative gradient. Here the coloured arcs come
 *      from `world/sun.js#phaseBoundaryHours` — they ARE the sun model, so a
 *      band edge can never drift from where dusk actually is. That is the whole
 *      anti-V2 move: V2's anchors and V2's sun were two sources that agreed
 *      only by coincidence.
 *
 * ============================================================================
 * NO DEAD AXES (Control-Panel.md §4.1: "a ring may only exist if it drives
 * something live")
 * ============================================================================
 *
 * Every control here drives a live engine today: the ring drives
 * `world/day-clock.js` (and through it the sun, every shadow, the ambient
 * palette and scene darkness); the arrow and slider drive the wind field's
 * ambient term and its rebake. Nothing is drawn that does not move something.
 *
 * ============================================================================
 * PLAIN DOM, ON PURPOSE
 * ============================================================================
 *
 * Same posture as `diag/effect-controls.js`: Tweakpane is not vendored, the
 * `ui/no-handwritten-controls` tripwire matches only literal Tweakpane call
 * patterns, and every other control surface in this project is built this way.
 * Swapping in a real renderer later changes THIS file, not the day clock.
 *
 * This module is a VIEW. It owns no time, no wind and no state beyond what it
 * is drawing; every gesture calls a handler the caller supplied, and every
 * repaint comes from `update(state)` with values the caller read back from the
 * engines. A dial that kept its own copy of the hour would be the 939th
 * parameter mirror (Environment.md §2.4).
 *
 * @module ui/astrolabe
 */

/** Ring geometry, in the dial's own 0..300 coordinate space. */
const FACE = 300;
/** The dial's rendered size in CSS px — 236 until the 2026-07-27 Bridge
 * compaction. Geometry is all in FACE space, so this is a display scale only. */
const DIAL_PX = 200;
const C = FACE / 2;
const R_OUTER = 146;
const R_INNER = 104;

/** Colour per sky phase — the dial's own vocabulary for `SKY_PHASES`. */
const PHASE_COLORS = Object.freeze({
  night: '#0d1220',
  astronomical: '#151d33',
  nautical: '#22304f',
  civil: '#3a5a86',
  golden: '#d68a3c',
  day: '#f2c94c',
});

const TEXT = '#dcecff';
const MUTED = '#8fa3c4';
const CYAN = '143,214,255';

/** The clickable time stops. Labels are the author's own from V2's dial. */
const TIME_STOPS = Object.freeze([
  { hour: 0, label: 'Midnight' },
  { hour: 3, label: 'Pre-dawn' },
  { hour: 6, label: 'Dawn' },
  { hour: 9, label: 'Morning' },
  { hour: 12, label: 'Noon' },
  { hour: 15, label: 'Afternoon' },
  { hour: 18, label: 'Dusk' },
  { hour: 21, label: 'Night' },
]);

/** Rate presets, in game-hours per real minute. 0 is the default (frozen). */
export const TIME_RATE_STEPS = Object.freeze([0, 0.25, 1, 4, 12, 24]);

/**
 * Hour → the angle on the dial, in SVG degrees (0 = up, clockwise).
 * Midnight at the bottom, noon at the top — V2's own orientation, kept because
 * "the sun is at the top when it is overhead" is the whole readability of it.
 * @param {number} hour @returns {number}
 */
export function hourToDialDeg(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  return (h / 24) * 360 + 180;
}

/**
 * The inverse — a dial angle back to an hour. Used by the ring drag.
 * @param {number} deg @returns {number} 0..24
 */
export function dialDegToHour(deg) {
  const d = (((Number(deg) - 180) % 360) + 360) % 360;
  return (d / 360) * 24;
}

/** @param {number} hour24 @returns {string} `HH:MM` */
export function formatClock(hour24) {
  const h = ((Number(hour24) % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** @param {number} deg @returns {string} */
export function compassLabel(deg) {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return labels[Math.round((((Number(deg) % 360) + 360) % 360) / 45) % 8];
}

/**
 * The SVG path for one ring arc between two hours. Exported for its own test:
 * an arc that silently degenerates is invisible, and an invisible band is
 * indistinguishable from a band that was never computed.
 * @param {number} startHour @param {number} endHour
 * @param {number} rOuter @param {number} rInner
 * @returns {string}
 */
export function ringArcPath(startHour, endHour, rOuter = R_OUTER, rInner = R_INNER) {
  // A band that wraps midnight arrives as start > end; adding a day makes the
  // sweep positive without the caller having to split it into two arcs.
  const span = endHour > startHour ? endHour - startHour : endHour + 24 - startHour;
  const a0 = hourToDialDeg(startHour);
  const a1 = a0 + (span / 24) * 360;
  const large = span > 12 ? 1 : 0;
  const p = (deg, r) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [C + Math.cos(rad) * r, C + Math.sin(rad) * r];
  };
  const [x0o, y0o] = p(a0, rOuter);
  const [x1o, y1o] = p(a1, rOuter);
  const [x1i, y1i] = p(a1, rInner);
  const [x0i, y0i] = p(a0, rInner);
  return (
    `M ${x0o.toFixed(2)} ${y0o.toFixed(2)} ` +
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1o.toFixed(2)} ${y1o.toFixed(2)} ` +
    `L ${x1i.toFixed(2)} ${y1i.toFixed(2)} ` +
    `A ${rInner} ${rInner} 0 ${large} 0 ${x0i.toFixed(2)} ${y0i.toFixed(2)} Z`
  );
}

function styled(tag, style) {
  const el = document.createElement(tag);
  Object.assign(el.style, style);
  return el;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/**
 * Build the astrolabe.
 *
 * @param {object} opts
 * @param {Array<{key: string, startHour: number, endHour: number}>} opts.phaseBands -
 *   from `world/sun.js#phaseBoundaryHours`. Passed IN rather than imported so
 *   this stays a view with no opinion about the sun, and so `ui/` never reaches
 *   across into `world/` internals.
 * @param {(hour: number, committed: boolean) => void} opts.onTimeChange - ring drag.
 * @param {(hour: number) => void} opts.onTimeStop - a time-stop button (sweeps).
 * @param {(deg: number, committed: boolean) => void} opts.onWindDirectionChange
 * @param {(speed01: number, committed: boolean) => void} opts.onWindSpeedChange
 * @param {(hoursPerMinute: number) => void} opts.onTimeRateChange
 * @param {(mode: string) => void} opts.onTimeModeChange
 * @returns {{root: HTMLElement, update: (state: object) => void}}
 */
export function createAstrolabe(opts) {
  const root = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: '8px',
    padding: '4px 2px 2px',
    font: '10.5px/1.35 Signika, sans-serif',
    color: TEXT,
  });

  // ---- the dial ------------------------------------------------------------
  const dialWrap = styled('div', { position: 'relative', flex: '0 0 auto', touchAction: 'none' });
  const svg = svgEl('svg', { viewBox: `0 0 ${FACE} ${FACE}`, width: DIAL_PX, height: DIAL_PX });
  svg.style.display = 'block';
  svg.style.cursor = 'pointer';
  dialWrap.appendChild(svg);

  // (a) the phase ring — one arc per band, coloured by phase. THE SUN MODEL,
  // drawn. Never a decorative gradient that merely resembles one.
  const ringGroup = svgEl('g');
  for (const band of opts.phaseBands ?? []) {
    ringGroup.appendChild(
      svgEl('path', {
        d: ringArcPath(band.startHour, band.endHour),
        fill: PHASE_COLORS[band.key] ?? '#25304a',
        stroke: 'rgba(0,0,0,0.35)',
        'stroke-width': 0.5,
      })
    );
  }
  svg.appendChild(ringGroup);

  // (b) time stops — small ticks with a generous invisible hit target, because
  // an 8px tick is not a click target (feedback_debug_ui_one_action_one_control:
  // one action, one control, and it has to be hittable).
  const stopGroup = svgEl('g');
  for (const stop of TIME_STOPS) {
    const deg = hourToDialDeg(stop.hour);
    const rad = ((deg - 90) * Math.PI) / 180;
    const cx = C + Math.cos(rad) * ((R_OUTER + R_INNER) / 2);
    const cy = C + Math.sin(rad) * ((R_OUTER + R_INNER) / 2);
    const hit = svgEl('circle', { cx, cy, r: 13, fill: 'transparent', style: 'cursor:pointer' });
    hit.appendChild(svgEl('title')).textContent = `${stop.label} — ${formatClock(stop.hour)}`;
    const tick = svgEl('circle', { cx, cy, r: 2.6, fill: 'rgba(255,255,255,0.55)' });
    hit.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      opts.onTimeStop?.(stop.hour);
    });
    stopGroup.append(tick, hit);
  }
  svg.appendChild(stopGroup);

  // (c) the sun/moon handle riding the ring
  const handle = svgEl('circle', { r: 9, fill: `rgb(${CYAN})`, stroke: '#0b1220', 'stroke-width': 2 });
  svg.appendChild(handle);

  // (d) the wind arrow, centred
  const arrow = svgEl('g');
  arrow.appendChild(
    svgEl('path', {
      d: 'M 0 -46 L 11 -20 L 4 -20 L 4 40 L -4 40 L -4 -20 L -11 -20 Z',
      fill: `rgb(${CYAN})`,
      stroke: '#0b1220',
      'stroke-width': 1.5,
      'stroke-linejoin': 'round',
    })
  );
  const arrowPivot = svgEl('g', { transform: `translate(${C} ${C})` });
  arrowPivot.appendChild(arrow);
  arrowPivot.style.cursor = 'grab';
  svg.appendChild(arrowPivot);

  // (e) the readout
  const readout = styled('div', {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: 'translate(-50%, 30px)',
    textAlign: 'center',
    pointerEvents: 'none',
    textShadow: '0 1px 3px rgba(0,0,0,0.9)',
  });
  const clockText = styled('div', { fontSize: '19px', fontWeight: '600', fontVariantNumeric: 'tabular-nums' });
  const phaseText = styled('div', { fontSize: '9.5px', color: MUTED, letterSpacing: '0.6px' });
  readout.append(clockText, phaseText);
  dialWrap.appendChild(readout);

  // THE TOP BLOCK — dial left, the two mid-session sliders stacked to its right.
  // Compacted 2026-07-27 (author: "the bridge part is nice but it's a poor use of
  // vertical space at the moment... compressed is good since eventually there
  // will be a lot more controls here"). The dial stays the hero; what moved is
  // everything that was stacked UNDER it in a single tall column.
  const topRow = styled('div', { display: 'flex', alignItems: 'center', gap: '10px' });
  const liveCol = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    flex: '1 1 auto',
    minWidth: '0',
  });
  topRow.append(dialWrap, liveCol);
  root.appendChild(topRow);

  // ---- the sliders ---------------------------------------------------------
  const windRow = sliderRow('Wind', 0, 1, 0.01, (v, committed) => opts.onWindSpeedChange?.(v, committed));
  const rateRow = sliderRow('Time rate', 0, TIME_RATE_STEPS.length - 1, 1, (v, committed) => {
    if (committed) opts.onTimeRateChange?.(TIME_RATE_STEPS[Math.round(v)] ?? 0);
  });
  // WEATHER — one knob today, and it drives two live systems from the same
  // number: the sky light's colour AND every shadow's softness
  // (`effects/shadow-access.js`) AND the environmental grade's desaturation.
  // V2 gave each of those its own slider and they could disagree about how
  // cloudy it was.
  const cloudRow = sliderRow('Cloud', 0, 1, 0.01, (v, committed) => opts.onCloudChange?.(v, committed));
  // THE SKY LIGHT's own lever. At 0 the outdoor light is a mathematical no-op
  // and the scene renders pixel-identical to Foundry — which is why it is the
  // default and why this control has to exist for anyone to see the feature.
  const skyRow = sliderRow('Sky light', 0, 1, 0.01, (v, committed) => opts.onSkyRealismChange?.(v, committed));
  // THE ENVIRONMENTAL GRADE strength (docs/planning/Grade.md) — the automatic
  // ToD/weather LOOK, and the cloud desaturation the sky light can't do. This
  // is where the "overcast feels grey and subdued" the author wanted lives.
  const atmoRow = sliderRow('Atmosphere', 0, 1, 0.01, (v, committed) => opts.onGradeEnvChange?.(v, committed));

  // THE SPLIT is this project's own FOH test — "would a GM change this
  // mid-session, or only while tuning?" (feedback_foh_roh_must_differ).
  //
  // Beside the dial: WIND, because the arrow is meaningless without a magnitude
  // and the two are one gesture; and CLOUD, because weather changes during play.
  liveCol.append(windRow.el, cloudRow.el);

  // Folded away: sky light, atmosphere, time rate, the clock mode and the sky
  // scope. All set-once tuning.
  const tuning = document.createElement('details');
  Object.assign(tuning.style, {
    border: `1px solid rgba(${CYAN},0.14)`,
    borderRadius: '7px',
    background: `rgba(${CYAN},0.03)`,
  });
  const tuningSummary = styled('summary', {
    cursor: 'pointer',
    listStyle: 'none',
    padding: '4px 8px',
    fontSize: '10px',
    fontWeight: '600',
    color: MUTED,
    userSelect: 'none',
  });
  const tuningBody = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '2px 8px 8px',
  });
  tuning.append(tuningSummary, tuningBody);
  tuningBody.append(skyRow.el, atmoRow.el, rateRow.el);

  /**
   * ⚠️ THE COST OF FOLDING SKY LIGHT AWAY, PAID BACK IN THE SUMMARY.
   *
   * `Sky light` defaults to 0, and at 0 the outdoor light is a mathematical
   * no-op — the scene renders pixel-identical to Foundry. That is exactly why the
   * slider had to exist in the first place: it is the only way anyone discovers
   * the feature. Hiding it behind a disclosure would have quietly undone that, so
   * the disclosure ADVERTISES the one thing hiding it would have cost.
   */
  // DIRTY-CHECKED (2026-08-11, Testament Stage 4) — this used to rewrite
  // innerHTML unconditionally from `update()`, i.e. every render frame the
  // dial is visible, for a string whose only variable is the boolean below.
  // Live-measured cost: 709ms across one 35.6s capture
  // (docs/planning/Trace-Analysis-2026-08-11.md §3). `lastSkyOn` starts
  // `null` so the FIRST call (right below) always renders — only a REPEAT
  // call with an unchanged boolean is skipped.
  let lastSkyOn = null;
  const syncTuningSummary = () => {
    const skyOn = skyRow.value() > 0;
    if (skyOn === lastSkyOn) return;
    lastSkyOn = skyOn;
    tuningSummary.innerHTML =
      '<span class="msa-chev">▸</span> Sky &amp; light' +
      (skyOn ? '' : ' <span style="opacity:.6">· sky light off</span>');
  };
  syncTuningSummary();

  // ---- the mode toggle -----------------------------------------------------
  const modeRow = styled('div', { display: 'flex', alignItems: 'center', gap: '6px' });
  const modeLabel = styled('span', { flex: '0 0 auto', minWidth: '62px', color: MUTED });
  modeLabel.textContent = 'Clock';
  const modeSelect = styled('select', {
    flex: '1',
    background: 'rgba(20,28,44,0.9)',
    color: TEXT,
    border: `1px solid rgba(${CYAN},0.28)`,
    borderRadius: '4px',
    padding: '2px 4px',
    font: 'inherit',
  });
  for (const [value, label] of [
    ['aesthetic', 'Aesthetic — the dial sets the look'],
    ['synced', "Synced — Foundry's world clock drives it"],
  ]) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    modeSelect.appendChild(o);
  }
  modeSelect.addEventListener('change', () => opts.onTimeModeChange?.(modeSelect.value));

  // (The artistic "Look" dropdown that used to sit here retired 2026-07-23: the
  // artistic grade is a first-class effect now, with its own Colour Grade card
  // in the Workshop zone — one home for the look, not a second one on the dial.
  // The astrolabe keeps only the ATMOSPHERE grade, which is "physically present
  // in the world" and belongs beside time + weather.)
  modeRow.append(modeLabel, modeSelect);
  tuningBody.appendChild(modeRow);

  // ── SCOPE: whose sky am I editing? ──────────────────────────────────────
  // Author, 2026-07-23: per world by default, per scene only if you enable it.
  // This checkbox is the ONLY thing that switches scope, and the label below it
  // says out loud which store the controls above are writing to — a control
  // that silently edits a different scope than the user believes is the most
  // expensive kind of UI mistake available here.
  const scopeRow = styled('label', {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    cursor: 'pointer',
    userSelect: 'none',
  });
  const scopeBox = document.createElement('input');
  scopeBox.type = 'checkbox';
  scopeBox.style.accentColor = `rgb(${CYAN})`;
  const scopeText = styled('span', { color: MUTED });
  scopeText.textContent = 'This scene has its own sky';
  scopeBox.addEventListener('change', () => opts.onSceneOverrideChange?.(scopeBox.checked));
  scopeRow.append(scopeBox, scopeText);
  tuningBody.appendChild(scopeRow);
  root.appendChild(tuning);

  // No reserved height: an empty status line was holding 13px open in a panel
  // being compacted, and it is empty in the common case.
  const status = styled('div', { color: MUTED, fontSize: '9.5px' });
  const setStatus = (text) => {
    status.textContent = text ?? '';
    status.style.display = status.textContent ? 'block' : 'none';
  };
  setStatus('');
  root.appendChild(status);

  // ---- gestures ------------------------------------------------------------
  // Time ring and wind arrow share one pointer pipeline, routed by where the
  // press landed: inside the ring band ⇒ time, inside the hub ⇒ wind.
  let drag = null;

  const dialAngleAt = (clientX, clientY) => {
    const r = svg.getBoundingClientRect();
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    return { deg: ((deg % 360) + 360) % 360, dist: Math.hypot(dx, dy) / (r.width / FACE) };
  };

  const onDown = (e) => {
    const { deg, dist } = dialAngleAt(e.clientX, e.clientY);
    if (dist >= R_INNER - 8 && dist <= R_OUTER + 10) {
      if (ringLocked) {
        flashStatus("Synced to Foundry's clock — use Foundry's time controls, or switch to Aesthetic.");
        return;
      }
      drag = 'time';
      opts.onTimeChange?.(dialDegToHour(deg), false);
    } else if (dist < R_INNER - 8) {
      drag = 'wind';
      // The arrow points the way the wind BLOWS TO; the wind field's own
      // `directionDeg` is meteorological (the direction it comes FROM), which
      // is the convention `world/wind-field.js` and the bake already share.
      // Converting here, at the one place a human aims it, keeps that single
      // convention intact everywhere behind the dial.
      opts.onWindDirectionChange?.(visualDegToWindDeg(deg), false);
    }
    if (drag) {
      svg.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    }
  };
  const onMove = (e) => {
    if (!drag) return;
    const { deg } = dialAngleAt(e.clientX, e.clientY);
    if (drag === 'time') opts.onTimeChange?.(dialDegToHour(deg), false);
    else opts.onWindDirectionChange?.(visualDegToWindDeg(deg), false);
  };
  const onUp = (e) => {
    if (!drag) return;
    const { deg } = dialAngleAt(e.clientX, e.clientY);
    if (drag === 'time') opts.onTimeChange?.(dialDegToHour(deg), true);
    else opts.onWindDirectionChange?.(visualDegToWindDeg(deg), true);
    drag = null;
    svg.releasePointerCapture?.(e.pointerId);
  };
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);

  let ringLocked = false;
  let statusTimer = null;
  let stickyStatus = '';
  function flashStatus(text) {
    setStatus(text);
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      setStatus(stickyStatus);
      statusTimer = null;
    }, 4000);
  }

  /**
   * Repaint from the engines' own values. Called every frame by the caller;
   * everything here is a cheap attribute write and guarded against no-op
   * churn where it is not.
   *
   * @param {object} s
   * @param {number} s.todHour
   * @param {string} s.phase - the sun's current section key.
   * @param {boolean} s.rising
   * @param {boolean} s.canSetHour - false in synced mode; the ring goes locked.
   * @param {string} s.mode
   * @param {number} s.rateHoursPerMinute
   * @param {number} s.windDirectionDeg - meteorological (blows FROM).
   * @param {number} s.windSpeed01
   * @param {number} s.timeScale - the pause ramp, 0..1.
   * @param {boolean} s.paused
   */
  function update(s) {
    const deg = hourToDialDeg(s.todHour ?? 12);
    const rad = ((deg - 90) * Math.PI) / 180;
    handle.setAttribute('cx', (C + Math.cos(rad) * ((R_OUTER + R_INNER) / 2)).toFixed(2));
    handle.setAttribute('cy', (C + Math.sin(rad) * ((R_OUTER + R_INNER) / 2)).toFixed(2));

    clockText.textContent = formatClock(s.todHour ?? 12);
    const phaseName = phaseDisplayName(s.phase, s.rising);
    // A readout that looks like a world clock but is not one is a lying
    // instrument. In aesthetic mode it says so, every frame.
    phaseText.textContent = s.mode === 'synced' ? phaseName : `${phaseName} · aesthetic`;

    arrowPivot.setAttribute(
      'transform',
      `translate(${C} ${C}) rotate(${windDegToVisualDeg(s.windDirectionDeg ?? 0).toFixed(1)})`
    );
    const speed = Math.max(0, Math.min(1, s.windSpeed01 ?? 0));
    arrow.setAttribute('transform', `scale(${(0.55 + speed * 0.45).toFixed(3)})`);
    arrow.style.opacity = String(0.35 + speed * 0.65);

    windRow.set(speed);
    cloudRow.set(Math.max(0, Math.min(1, s.cloudCover01 ?? 0)));
    skyRow.set(Math.max(0, Math.min(1, s.skyRealism01 ?? 0)));
    skyRow.setReadout((s.skyRealism01 ?? 0) === 0 ? 'off' : `${Math.round((s.skyRealism01 ?? 0) * 100)}%`);
    syncTuningSummary();
    atmoRow.set(Math.max(0, Math.min(1, s.gradeEnvStrength ?? 0)));
    atmoRow.setReadout((s.gradeEnvStrength ?? 0) === 0 ? 'off' : `${Math.round((s.gradeEnvStrength ?? 0) * 100)}%`);
    rateRow.set(nearestRateIndex(s.rateHoursPerMinute ?? 0));
    rateRow.setReadout(formatRate(s.rateHoursPerMinute ?? 0));
    if (scopeBox.checked !== (s.sceneOverrides === true)) scopeBox.checked = s.sceneOverrides === true;
    scopeText.textContent =
      s.sceneOverrides === true ? 'This scene has its own sky' : 'Using the world sky (shared by every scene)';
    if (modeSelect.value !== s.mode) modeSelect.value = s.mode ?? 'aesthetic';

    ringLocked = s.canSetHour === false;
    svg.style.cursor = ringLocked ? 'not-allowed' : 'pointer';
    ringGroup.style.opacity = ringLocked ? '0.55' : '1';
    rateRow.setDisabled(ringLocked);

    // The pause ramp, shown rather than inferred. A GM who has just hit pause
    // should be able to see the world winding down, and see that it is
    // deliberate — otherwise "everything went sluggish" reads as a bug.
    stickyStatus = s.paused
      ? '⏸ Paused — the world has stopped.'
      : (s.timeScale ?? 1) < 0.995
        ? `⏳ ${Math.round((s.timeScale ?? 1) * 100)}% speed…`
        : ringLocked
          ? "Time follows Foundry's world clock."
          : '';
    if (!statusTimer) setStatus(stickyStatus);
  }

  return { root, update };
}

/** @param {string} phase @param {boolean} rising @returns {string} */
function phaseDisplayName(phase, rising) {
  const names = {
    night: 'Night',
    astronomical: rising ? 'Astronomical dawn' : 'Astronomical dusk',
    nautical: rising ? 'Nautical dawn' : 'Nautical dusk',
    civil: rising ? 'Blue hour (dawn)' : 'Blue hour (dusk)',
    golden: rising ? 'Golden hour (dawn)' : 'Golden hour (dusk)',
    day: 'Day',
  };
  return names[phase] ?? 'Day';
}

/**
 * Meteorological degrees (the direction wind comes FROM) → the arrow's own
 * rotation (it points where the wind GOES). One conversion, one place; see the
 * pointer handler's own note.
 * @param {number} windDeg @returns {number}
 */
export function windDegToVisualDeg(windDeg) {
  return ((((Number(windDeg) || 0) + 180) % 360) + 360) % 360;
}

/** The inverse. @param {number} visualDeg @returns {number} */
export function visualDegToWindDeg(visualDeg) {
  return ((((Number(visualDeg) || 0) + 180) % 360) + 360) % 360;
}

/** @param {number} hoursPerMinute @returns {number} index into TIME_RATE_STEPS */
export function nearestRateIndex(hoursPerMinute) {
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < TIME_RATE_STEPS.length; i++) {
    const gap = Math.abs(TIME_RATE_STEPS[i] - (Number(hoursPerMinute) || 0));
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

/** @param {number} hoursPerMinute @returns {string} */
export function formatRate(hoursPerMinute) {
  const r = Number(hoursPerMinute) || 0;
  if (r === 0) return 'frozen';
  // How long one game-day takes in real minutes — far more legible to a GM than
  // "0.25 h/min", which nobody can turn into a session length in their head.
  const minutesPerDay = 24 / r;
  if (minutesPerDay >= 90) return `${(minutesPerDay / 60).toFixed(1)} h/day`;
  if (minutesPerDay >= 1.5) return `${Math.round(minutesPerDay)} min/day`;
  return `${Math.round(minutesPerDay * 60)} s/day`;
}

/**
 * A labelled horizontal slider with a live readout. Commits on release, mirrors
 * on drag — the same input/change split `diag/effect-controls.js` uses, so a
 * drag never spams a write per pixel.
 */
function sliderRow(label, min, max, step, onChange) {
  const el = styled('div', { display: 'flex', alignItems: 'center', gap: '6px' });
  const name = styled('span', { flex: '0 0 auto', minWidth: '62px', color: MUTED });
  name.textContent = label;
  const input = styled('input', { flex: '1', accentColor: `rgb(${CYAN})` });
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  const out = styled('span', {
    minWidth: '54px',
    textAlign: 'right',
    color: MUTED,
    fontVariantNumeric: 'tabular-nums',
  });
  let dragging = false;
  let readoutOverride = null;
  const paint = () => {
    out.textContent = readoutOverride ?? (step < 1 ? `${Math.round(Number(input.value) * 100)}%` : input.value);
  };
  input.addEventListener('pointerdown', () => {
    dragging = true;
  });
  input.addEventListener('input', () => {
    paint();
    onChange(Number(input.value), false);
  });
  input.addEventListener('change', () => {
    dragging = false;
    onChange(Number(input.value), true);
  });
  el.append(name, input, out);
  return {
    el,
    /** The knob's live value — read by the Sky & light summary so a folded-away
     * control can still advertise that it is at its no-op default. */
    value: () => Number(input.value),
    /** Mirror the engine's value — ignored mid-drag so the knob never fights
     * the finger holding it (the classic two-way-binding stutter). */
    set(v) {
      if (dragging) return;
      const next = String(v);
      if (input.value !== next) {
        input.value = next;
        paint();
      }
    },
    setReadout(text) {
      readoutOverride = text;
      if (!dragging) paint();
    },
    setDisabled(disabled) {
      input.disabled = !!disabled;
      el.style.opacity = disabled ? '0.45' : '1';
    },
  };
}
