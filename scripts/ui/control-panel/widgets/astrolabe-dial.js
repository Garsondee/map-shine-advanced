/**
 * @fileoverview Combined Time + Wind "Astrolabe" hero dial (concentric rings).
 * @module ui/control-panel/widgets/astrolabe-dial
 */

import { todHourToOrbitAngleDeg } from '../../../core/tod-anchor-spec.js';

export const GUSTINESS_LABELS = Object.freeze(['calm', 'light', 'moderate', 'strong', 'extreme']);
export const GUSTINESS_DISPLAY = Object.freeze({
  calm: 'Calm',
  light: 'Light',
  moderate: 'Mod',
  strong: 'Strong',
  extreme: 'Extreme',
});

/** Eight time stops evenly around the outer track. */
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

/** Default hint when nothing is hovered (three lines). */
export const CONTEXT_HINT_IDLE = Object.freeze([
  'Hover a control for help',
  'Sliders: drag track up/down to adjust',
  'Environment Fade on: dashed previews · dial = time & wind',
]);

/** Convert pointer-on-disc degrees (0 = up) to WeatherController wind degrees. */
function pointerDegToWindDeg(pointerDeg) {
  return (pointerDeg - 90 + 360) % 360;
}

/** Convert WeatherController wind degrees to wind-sock visual rotation. */
function windDegToVisualDeg(windDeg) {
  return (90 + Number(windDeg) + 360) % 360;
}

/**
 * @param {number} hour24
 */
function formatClockTime(hour24) {
  const h = Math.floor((((Number(hour24) % 24) + 24) % 24));
  const m = Math.floor((hour24 % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * @param {number} hour24
 */
function hourPeriodLabel(hour24) {
  const h = ((Number(hour24) % 24) + 24) % 24;
  let best = TIME_STOPS[0];
  let bestDist = Infinity;
  for (const stop of TIME_STOPS) {
    let dist = Math.abs(stop.hour - h);
    if (dist > 12) dist = 24 - dist;
    if (dist < bestDist) {
      bestDist = dist;
      best = stop;
    }
  }
  return best.label;
}

/**
 * @param {HTMLElement} faceEl
 * @param {number} clientX
 * @param {number} clientY
 */
function hourAtFacePointer(faceEl, clientX, clientY) {
  const rect = faceEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = clientX - cx;
  const dy = clientY - cy;
  let angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  if (angle < 0) angle += 360;
  return (((angle / 360) * 24) + 12) % 24;
}

/**
 * @param {number} deg
 */
function windCompassLabel(deg) {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const norm = ((Number(deg) % 360) + 360) % 360;
  return labels[Math.round(norm / 45) % 8];
}

/**
 * @param {number} directionDeg
 * @param {number} proposedMS
 * @param {boolean} [dragging]
 * @param {number} [currentMS]
 * @returns {string[]}
 */
function formatWindSockHint(directionDeg, proposedMS, dragging = false, currentMS = proposedMS) {
  const dir = Math.round(((Number(directionDeg) % 360) + 360) % 360);
  const proposed = Math.round(Number(proposedMS) || 0);
  const current = Math.round(Number(currentMS) || 0);
  if (dragging) {
    const speedLine = proposed !== current
      ? `Setting speed: ${proposed} m/s (was ${current} m/s)`
      : `Setting speed: ${proposed} m/s`;
    return [
      speedLine,
      `Direction: ${dir}° ${windCompassLabel(dir)}`,
      'Pull toward center = slower · away from center = faster.',
    ];
  }
  return [
    `Wind speed: ${current} m/s`,
    `Direction: ${dir}° ${windCompassLabel(dir)}`,
    'Drag sock: aim = direction · pull length = speed.',
  ];
}

/**
 * @param {number} directionDeg
 * @param {number} speedMS
 * @param {boolean} [dragging]
 * @param {number} [proposedMS]
 * @returns {string[]}
 */
function formatWindDiscHint(directionDeg, speedMS, dragging = false, proposedMS = speedMS) {
  const dir = Math.round(((Number(directionDeg) % 360) + 360) % 360);
  const current = Math.round(Number(speedMS) || 0);
  const proposed = Math.round(Number(proposedMS) || 0);
  if (dragging) {
    return formatWindSockHint(dir, proposed, true, current);
  }
  return [
    `Wind direction: ${dir}° ${windCompassLabel(dir)}`,
    `Speed: ${current} m/s — change by dragging sock length`,
    'Drag inner disc or sock · distance from center sets speed.',
  ];
}

/**
 * @param {number} hour24
 * @param {boolean} [dragging]
 * @returns {string[]}
 */
function formatTimeRingHint(hour24, dragging = false) {
  const period = hourPeriodLabel(hour24);
  return [
    `Time of Day — ${formatClockTime(hour24)} · ${period}`,
    dragging ? 'Setting time…' : 'Drag the outer ring to change time',
    'Top: Noon · Right: Dusk · Bottom: Midnight · Left: Dawn',
  ];
}

const WIND_ARROW_SVG = `<svg class="msa-cp-astrolabe__wind-arrow-svg" viewBox="0 0 48 200" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="msa-cp-astrolabe__wind-arrow-pole" d="M24 194 L24 28" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round"/>
  <path class="msa-cp-astrolabe__wind-arrow-sock" d="M24 28 C42 42 46 58 38 74 C30 88 24 94 24 94 C24 94 18 88 10 74 C2 58 6 42 24 28 Z" fill="currentColor" opacity="0.94"/>
  <path class="msa-cp-astrolabe__wind-arrow-stripe" d="M24 36 C34 48 36 62 28 76" fill="none" stroke="rgba(0,0,0,0.38)" stroke-width="2.5" stroke-linecap="round"/>
  <path class="msa-cp-astrolabe__wind-arrow-stripe" d="M24 46 C30 56 31 66 26 76" fill="none" stroke="rgba(255,255,255,0.24)" stroke-width="2" stroke-linecap="round"/>
  <circle class="msa-cp-astrolabe__wind-arrow-hub" cx="24" cy="22" r="6.5" fill="currentColor"/>
</svg>`;

/**
 * Fixed day/night ring: bright top (noon/day), dark bottom (midnight/night).
 * 12:00 at top; conic from 180deg puts 0% at bottom.
 */
export function timePhaseGradient(_hour) {
  void _hour;
  const midnight = '#0f1525';
  const night = '#1a2035';
  const twilight = '#2d4a7a';
  const dusk = '#e67e22';
  const noon = '#f1c40f';
  const dawn = '#e8954a';
  return `conic-gradient(from 180deg,
    ${midnight} 0deg,
    ${night} 42deg,
    ${twilight} 84deg,
    ${dawn} 126deg,
    ${noon} 180deg,
    ${dawn} 234deg,
    ${twilight} 276deg,
    ${night} 318deg,
    ${midnight} 360deg)`;
}

/**
 * @param {number} hour
 * @returns {string}
 */
function timeHandleIcon(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  return h >= 6 && h < 18 ? '☀️' : '🌙';
}

/** Ring-gradient contrast bucket for time-stop styling. */
function timeStopRingPhase(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h >= 10 && h < 14) return 'day-bright';
  if (h >= 7 && h < 17) return 'day';
  if (h >= 5 && h < 8) return 'dawn';
  if (h >= 16 && h < 20) return 'dusk';
  return 'night';
}

/**
 * @param {number} center
 * @param {number} radius
 * @param {number} angleDeg
 */
function polarPos(center, radius, angleDeg) {
  const angleRad = (angleDeg * Math.PI) / 180;
  return {
    x: center + Math.cos(angleRad) * radius,
    y: center + Math.sin(angleRad) * radius,
  };
}

/**
 * @param {{
 *   faceSize?: number,
 *   maxSpeedMS?: number,
 *   onTimeStopClick: (hour: number) => void,
 *   onSpeedChange: (ms: number, last: boolean) => void,
 *   onDirectionChange: (deg: number, last: boolean) => void,
 *   onWindDragChange?: (dragging: boolean) => void,
 *   onContextHint?: (text: string[] | null) => void,
 * }} opts
 */
export function createAstrolabeDial(opts) {
  const FACE_SIZE = Number(opts.faceSize) || 300;
  const CENTER = FACE_SIZE / 2;
  const scale = FACE_SIZE / 300;
  const R_OUTER = CENTER - 4 * scale;
  const R_WIND = CENTER * 0.48;
  const STOP_R = R_OUTER - 2 * scale;
  const INNER_SIZE = Math.round(R_WIND * 2);
  const INNER_CENTER = INNER_SIZE / 2;
  const WIND_MAX_R = INNER_CENTER - 26;
  const RING_INNER_R = R_OUTER * 0.36;
  const RING_OUTER_R = R_OUTER;
  const WIND_SOCK_REACH = RING_INNER_R + (RING_OUTER_R - RING_INNER_R) * 0.48;

  const container = document.createElement('div');
  container.className = 'msa-cp-astrolabe hero-dial-container';

  const heroWrap = document.createElement('div');
  heroWrap.className = 'msa-cp-astrolabe__hero hero-dial-container';

  const timePill = document.createElement('div');
  timePill.className = 'msa-cp-astrolabe__time-pill';
  timePill.textContent = '12:00';

  const face = document.createElement('div');
  face.className = 'msa-cp-astrolabe__face';
  face.style.width = `${FACE_SIZE}px`;
  face.style.height = `${FACE_SIZE}px`;

  const phaseRing = document.createElement('div');
  phaseRing.className = 'msa-cp-astrolabe__phase';

  const ring = document.createElement('div');
  ring.className = 'msa-cp-astrolabe__ring';

  const handHub = document.createElement('div');
  handHub.className = 'msa-cp-astrolabe__handle-hub';

  const hand = document.createElement('div');
  hand.className = 'msa-cp-astrolabe__handle';
  hand.textContent = '☀️';
  handHub.appendChild(hand);

  const targetHandHub = document.createElement('div');
  targetHandHub.className = 'msa-cp-astrolabe__handle-hub msa-cp-astrolabe__handle-hub--target';
  targetHandHub.style.display = 'none';

  const targetHand = document.createElement('div');
  targetHand.className = 'msa-cp-astrolabe__handle msa-cp-astrolabe__handle--target';
  targetHandHub.appendChild(targetHand);

  const timeStopLayer = document.createElement('div');
  timeStopLayer.className = 'msa-cp-astrolabe__time-stops';

  for (const stop of TIME_STOPS) {
    const tick = document.createElement('button');
    tick.type = 'button';
    tick.className = 'msa-cp-astrolabe__time-stop';
    tick.title = stop.label;
    tick.dataset.hour = String(stop.hour);
    tick.dataset.ringPhase = timeStopRingPhase(stop.hour);

    const tickMark = document.createElement('span');
    tickMark.className = 'msa-cp-astrolabe__time-stop-mark';
    tick.appendChild(tickMark);

    const angleDeg = todHourToOrbitAngleDeg(stop.hour);
    const { x, y } = polarPos(CENTER, STOP_R, angleDeg);
    tick.style.left = `${x}px`;
    tick.style.top = `${y}px`;
    tick.style.transform = `translate(-50%, -50%) rotate(${angleDeg + 270}deg)`;

    tick.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onTimeStopClick(stop.hour);
    });
    tick.addEventListener('pointerenter', () => {
      setDialHint([
        `Time Stop — ${stop.label}`,
        `Jump to ${formatClockTime(stop.hour)}`,
        'Click to snap time (respects Environment Fade)',
      ]);
    });
    timeStopLayer.appendChild(tick);
  }

  const windInner = document.createElement('div');
  windInner.className = 'msa-cp-astrolabe__wind-inner';
  windInner.style.width = `${INNER_SIZE}px`;
  windInner.style.height = `${INNER_SIZE}px`;

  const windDisc = document.createElement('div');
  windDisc.className = 'msa-cp-astrolabe__wind-disc';

  const windArrowWrap = document.createElement('div');
  windArrowWrap.className = 'msa-cp-astrolabe__wind-arrow-wrap';
  windArrowWrap.innerHTML = WIND_ARROW_SVG;

  const windArrowTarget = document.createElement('div');
  windArrowTarget.className = 'msa-cp-astrolabe__wind-arrow-wrap msa-cp-astrolabe__wind-arrow-wrap--target';
  windArrowTarget.innerHTML = WIND_ARROW_SVG;
  windArrowTarget.hidden = true;

  windDisc.appendChild(windArrowTarget);
  windDisc.appendChild(windArrowWrap);
  windInner.appendChild(windDisc);

  face.appendChild(phaseRing);
  face.appendChild(ring);
  face.appendChild(timeStopLayer);
  face.appendChild(windInner);
  face.appendChild(timePill);
  face.appendChild(targetHandHub);
  face.appendChild(handHub);

  heroWrap.appendChild(face);
  container.appendChild(heroWrap);

  phaseRing.style.background = timePhaseGradient(12);

  const maxSpeed = opts.maxSpeedMS ?? 78;
  let windDragging = false;
  let speedMS = 0;
  let directionDeg = 180;
  let gustiness = 'moderate';
  let liveSpeedMS = null;
  let gustPulse = 0;

  const setDialHint = (text) => {
    try {
      opts.onContextHint?.(text ?? null);
    } catch (_) {}
  };

  const clearDialHint = () => setDialHint(null);

  const applyWindVisuals = () => {
    const setNorm = Math.max(0, Math.min(1, speedMS / maxSpeed));
    const liveNorm = Number.isFinite(liveSpeedMS)
      ? Math.max(0, Math.min(1, liveSpeedMS / maxSpeed))
      : setNorm;
    const displayNorm = Math.max(setNorm, liveNorm);
    const minH = Math.round(WIND_SOCK_REACH * 0.82);
    const maxH = Math.round(WIND_SOCK_REACH * 1.12);
    const arrowH = minH + displayNorm * (maxH - minH);

    windArrowWrap.style.transform = `translate(-50%, -100%) rotate(${windDegToVisualDeg(directionDeg)}deg)`;
    windArrowWrap.style.setProperty('--wind-arrow-height', `${arrowH}px`);

    const surge = Number.isFinite(liveSpeedMS) && Math.abs(liveSpeedMS - speedMS) > 2.5;
    const gustLevel = GUSTINESS_LABELS.indexOf(gustiness);
    windArrowWrap.dataset.heat = displayNorm < 0.35 ? 'low' : displayNorm < 0.65 ? 'mid' : 'high';
    windArrowWrap.dataset.gust = gustLevel >= 3 ? 'high' : gustLevel >= 2 ? 'mid' : 'low';
    windArrowWrap.classList.toggle('is-surging', surge);
    windArrowWrap.classList.toggle('is-gusting', gustPulse > 0.35 || surge);
  };

  const applyWindTargetVisuals = (targetDir, targetSpeedMS) => {
    if (!Number.isFinite(Number(targetDir)) || !Number.isFinite(Number(targetSpeedMS))) {
      windArrowTarget.hidden = true;
      return;
    }
    const norm = Math.max(0, Math.min(1, Number(targetSpeedMS) / maxSpeed));
    const minH = Math.round(WIND_SOCK_REACH * 0.82);
    const maxH = Math.round(WIND_SOCK_REACH * 1.12);
    const arrowH = minH + norm * (maxH - minH);
    windArrowTarget.style.transform = `translate(-50%, -100%) rotate(${windDegToVisualDeg(Number(targetDir))}deg)`;
    windArrowTarget.style.setProperty('--wind-arrow-height', `${arrowH}px`);
    windArrowTarget.hidden = false;
  };

  const clearWindTargetPreview = () => {
    windArrowTarget.hidden = true;
  };

  const updateWindFromPointer = (clientX, clientY, last) => {
    const rect = windDisc.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const norm = Math.max(0, Math.min(1, dist / WIND_MAX_R));
    let pointerDeg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (pointerDeg < 0) pointerDeg += 360;
    const angle = pointerDegToWindDeg(pointerDeg);
    const newSpeed = norm * maxSpeed;
    const prevSpeed = speedMS;

    if (windDragging) {
      setDialHint(formatWindSockHint(angle, newSpeed, true, prevSpeed));
    }

    if (Math.abs(newSpeed - speedMS) > 0.05) {
      speedMS = newSpeed;
      opts.onSpeedChange(speedMS, last);
    }
    if (Math.abs(angle - directionDeg) > 0.5) {
      directionDeg = angle;
      opts.onDirectionChange(directionDeg, last);
    }
    applyWindVisuals();
  };

  let windCaptureEl = null;

  const onWindDocMove = (e) => {
    if (!windDragging) return;
    updateWindFromPointer(e.clientX, e.clientY, false);
  };

  const endWindPointer = (e) => {
    if (!windDragging) return;
    windDragging = false;
    windCaptureEl = null;
    opts.onWindDragChange?.(false);
    if (e?.clientX != null && e?.clientY != null) {
      updateWindFromPointer(e.clientX, e.clientY, true);
    } else {
      opts.onSpeedChange(speedMS, true);
      opts.onDirectionChange(directionDeg, true);
    }
    document.removeEventListener('pointermove', onWindDocMove, true);
    document.removeEventListener('pointerup', endWindPointer, true);
    document.removeEventListener('pointercancel', endWindPointer, true);
    setDialHint(formatWindSockHint(directionDeg, speedMS, false));
  };

  const onWindPointerDown = (e) => {
    windDragging = true;
    windCaptureEl = /** @type {HTMLElement} */ (e.currentTarget);
    opts.onWindDragChange?.(true);
    try { windCaptureEl.setPointerCapture(e.pointerId); } catch (_) {}
    updateWindFromPointer(e.clientX, e.clientY, false);
    document.addEventListener('pointermove', onWindDocMove, true);
    document.addEventListener('pointerup', endWindPointer, true);
    document.addEventListener('pointercancel', endWindPointer, true);
    e.preventDefault();
    e.stopPropagation();
  };

  const hitTestWindSock = (clientX, clientY) => {
    const rect = windArrowWrap.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const padX = 24;
    const padTop = 28;
    const padBottom = 12;
    return clientX >= rect.left - padX
      && clientX <= rect.right + padX
      && clientY >= rect.top - padTop
      && clientY <= rect.bottom + padBottom;
  };

  const beginWindPointerAt = (clientX, clientY) => {
    if (windDragging) return;
    windDragging = true;
    opts.onWindDragChange?.(true);
    updateWindFromPointer(clientX, clientY, false);
    document.addEventListener('pointermove', onWindDocMove, true);
    document.addEventListener('pointerup', endWindPointer, true);
    document.addEventListener('pointercancel', endWindPointer, true);
  };

  const stopTimeBubble = (e) => e.stopPropagation();
  const windTargets = [windDisc, windArrowWrap];
  for (const el of windTargets) {
    el.addEventListener('mousedown', stopTimeBubble);
    el.addEventListener('touchstart', stopTimeBubble);
    el.addEventListener('pointerdown', onWindPointerDown);
    el.addEventListener('pointermove', (e) => {
      if (!windDragging || windCaptureEl !== el) return;
      updateWindFromPointer(e.clientX, e.clientY, false);
    });
    el.addEventListener('pointerup', (e) => {
      if (windCaptureEl !== el) return;
      endWindPointer(e);
    });
    el.addEventListener('pointercancel', () => {
      if (windCaptureEl !== el) return;
      endWindPointer(null);
    });
    el.addEventListener('pointerenter', () => {
      if (el === windArrowWrap) {
        setDialHint(formatWindSockHint(directionDeg, speedMS, false));
      } else {
        setDialHint(formatWindDiscHint(directionDeg, speedMS, false));
      }
    });
  }

  timePill.addEventListener('pointerenter', () => {
    setDialHint([
      `Current Time — ${timePill.textContent}`,
      'Digital readout over the wind disc',
      'Drag the outer ring to change time of day',
    ]);
  });

  handHub.addEventListener('pointerenter', () => {
    setDialHint([
      'Time Handle',
      'Drag the outer ring to set time of day',
      'Top: Noon · Bottom: Midnight',
    ]);
  });

  const onFacePointerMove = (e) => {
    if (windDragging) return;
    if (e.target?.closest?.('.msa-cp-astrolabe__wind-disc, .msa-cp-astrolabe__wind-arrow-wrap, .msa-cp-astrolabe__time-stop')) {
      return;
    }
    if (hitTestWindSock(e.clientX, e.clientY)) {
      setDialHint(formatWindSockHint(directionDeg, speedMS, false));
      return;
    }
    setDialHint(formatTimeRingHint(hourAtFacePointer(face, e.clientX, e.clientY), false));
  };

  face.addEventListener('pointermove', onFacePointerMove);
  container.addEventListener('pointerleave', clearDialHint);

  const mirror = ({ speedMS: s, directionDeg: d, gustiness: g, liveSpeedMS: live, gustPulse: pulse }) => {
    if (Number.isFinite(s)) speedMS = s;
    if (Number.isFinite(d)) directionDeg = d;
    if (g && GUSTINESS_LABELS.includes(g)) gustiness = g;
    if (live === null || live === undefined) liveSpeedMS = null;
    else if (Number.isFinite(live)) liveSpeedMS = live;
    if (Number.isFinite(pulse)) gustPulse = pulse;
    applyWindVisuals();
  };

  const setGustiness = (g) => {
    gustiness = g;
    applyWindVisuals();
  };

  const setDigitalTime = (text) => {
    timePill.textContent = text;
  };

  const updateTimeVisuals = (hour) => {
    const icon = timeHandleIcon(hour);
    hand.textContent = icon;
    handHub.dataset.phase = icon.includes('☀') ? 'day' : 'night';
  };

  applyWindVisuals();

  const elements = {
    face,
    phaseRing,
    hand,
    handHub,
    targetHand,
    targetHandHub,
    digital: timePill,
    windDisc,
    windArrowWrap,
    windArrowTarget,
  };

  return {
    container,
    elements,
    mirror,
    setGustiness,
    setDigitalTime,
    updateTimeVisuals,
    hitTestWindSock,
    beginWindPointerAt,
    setWindTargetPreview: applyWindTargetVisuals,
    clearWindTargetPreview,
    formatTimeRingHint,
    formatWindSockHint,
    formatWindDiscHint,
  };
}
