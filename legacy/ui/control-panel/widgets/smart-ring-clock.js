/**
 * @fileoverview Smart Ring clock — compact time director with phase gradient.
 * @module ui/control-panel/widgets/smart-ring-clock
 */

import { todHourToOrbitAngleDeg } from '../../../core/tod-anchor-spec.js';

/** Primary track anchors (4). */
const PRIMARY_ANCHOR_ICONS = Object.freeze({
  Dawn: '🌅',
  Noon: '☀️',
  Dusk: '🌇',
  Midnight: '🌙',
});

/**
 * Compute conic gradient stops for time-of-day phase ring.
 * @param {number} hour 0-24
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
 * @param {{ faceSize?: number, anchors: Array<{ label: string, hour: number, clockHint?: string }>, onAnchorClick: (hour: number)=>void }} opts
 * @returns {{ container: HTMLElement, elements: { hand: HTMLElement, targetHand: HTMLElement, digital: HTMLElement, face: HTMLElement, ring: HTMLElement, phaseRing: HTMLElement } }}
 */
export function createSmartRingClock(opts) {
  const FACE_SIZE = Number(opts.faceSize) || 120;
  const CENTER = FACE_SIZE / 2;
  const scale = FACE_SIZE / 120;
  const TRACK_R = 52 * scale;

  const container = document.createElement('div');
  container.className = 'msa-cp-smart-ring';

  const face = document.createElement('div');
  face.className = 'msa-cp-smart-ring__face';
  face.style.width = `${FACE_SIZE}px`;
  face.style.height = `${FACE_SIZE}px`;

  const phaseRing = document.createElement('div');
  phaseRing.className = 'msa-cp-smart-ring__phase';

  const ring = document.createElement('div');
  ring.className = 'msa-cp-smart-ring__ring';

  const hub = document.createElement('div');
  hub.className = 'msa-cp-smart-ring__hub';

  const digital = document.createElement('div');
  digital.className = 'msa-cp-smart-ring__digital';
  digital.textContent = '12:00';

  const hand = document.createElement('div');
  hand.className = 'msa-cp-smart-ring__hand';

  const targetHand = document.createElement('div');
  targetHand.className = 'msa-cp-smart-ring__hand msa-cp-smart-ring__hand--target';
  targetHand.style.display = 'none';

  hub.appendChild(digital);

  face.appendChild(phaseRing);
  face.appendChild(ring);
  face.appendChild(hand);
  face.appendChild(targetHand);
  face.appendChild(hub);

  const trackLayer = document.createElement('div');
  trackLayer.className = 'msa-cp-smart-ring__track-btns';

  for (const anchor of opts.anchors) {
    const icon = PRIMARY_ANCHOR_ICONS[anchor.label] || '●';
    if (!PRIMARY_ANCHOR_ICONS[anchor.label]) continue;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msa-cp-smart-ring__track-btn';
    btn.textContent = icon;
    btn.title = `${anchor.label} (${anchor.clockHint || ''})`;

    const angleDeg = todHourToOrbitAngleDeg(anchor.hour);
    const angleRad = (angleDeg * Math.PI) / 180;
    const x = CENTER + Math.cos(angleRad) * TRACK_R;
    const y = CENTER + Math.sin(angleRad) * TRACK_R;
    btn.style.left = `${x}px`;
    btn.style.top = `${y}px`;

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onAnchorClick(anchor.hour);
    });
    trackLayer.appendChild(btn);
  }

  face.appendChild(trackLayer);
  container.appendChild(face);

  const elements = { hand, targetHand, digital, face, ring, phaseRing, hub };

  return { container, elements };
}

/**
 * @param {HTMLElement} phaseRing
 * @param {number} hour
 */
export function updatePhaseRing(phaseRing, hour) {
  if (!phaseRing) return;
  phaseRing.style.background = timePhaseGradient(hour);
}
