/**
 * @fileoverview Radial wind compass widget (speed + direction + gustiness).
 * @module ui/control-panel/widgets/wind-compass
 */

const GUSTINESS_LABELS = Object.freeze(['calm', 'light', 'moderate', 'strong', 'extreme']);
const GUSTINESS_DISPLAY = Object.freeze({
  calm: 'Calm',
  light: 'Light',
  moderate: 'Mod',
  strong: 'Strong',
  extreme: 'Extreme',
});

/**
 * @param {HTMLElement} container
 * @param {{ maxSpeedMS?: number, onSpeedChange: (ms: number, last: boolean)=>void, onDirectionChange: (deg: number, last: boolean)=>void, onGustinessCycle: ()=>void, onInteractionEnd?: ()=>void }} opts
 */
export function createWindCompass(container, opts) {
  const maxSpeed = opts.maxSpeedMS ?? 78;
  const size = 100;
  const center = size / 2;
  const maxRadius = 38;

  const wrap = document.createElement('div');
  wrap.className = 'msa-cp-wind-compass';
  wrap.style.width = `${size}px`;
  wrap.style.height = `${size}px`;
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Wind compass');

  const face = document.createElement('div');
  face.className = 'msa-cp-wind-compass__face';

  const ring = document.createElement('div');
  ring.className = 'msa-cp-wind-compass__ring';

  const node = document.createElement('div');
  node.className = 'msa-cp-wind-compass__node';
  node.setAttribute('role', 'slider');
  node.tabIndex = 0;

  const hub = document.createElement('button');
  hub.type = 'button';
  hub.className = 'msa-cp-wind-compass__hub';
  hub.title = 'Click to cycle gustiness';

  const gustLabel = document.createElement('span');
  gustLabel.className = 'msa-cp-wind-compass__gust';
  hub.appendChild(gustLabel);

  const speedReadout = document.createElement('span');
  speedReadout.className = 'msa-cp-wind-compass__speed-readout';

  face.appendChild(ring);
  face.appendChild(node);
  face.appendChild(hub);
  wrap.appendChild(face);
  wrap.appendChild(speedReadout);
  container.appendChild(wrap);

  let dragging = false;
  let speedMS = 0;
  let directionDeg = 180;
  let gustiness = 'moderate';

  const applyNodePosition = () => {
    const norm = Math.max(0, Math.min(1, speedMS / maxSpeed));
    const r = norm * maxRadius;
    const rad = ((directionDeg - 90) * Math.PI) / 180;
    const x = center + Math.cos(rad) * r;
    const y = center + Math.sin(rad) * r;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    node.setAttribute('aria-valuenow', String(Math.round(speedMS)));

    const heat = norm;
    if (heat < 0.35) node.dataset.heat = 'low';
    else if (heat < 0.65) node.dataset.heat = 'mid';
    else node.dataset.heat = 'high';

    speedReadout.textContent = `${Math.round(speedMS)} m/s · ${Math.round(directionDeg)}°`;
    gustLabel.textContent = GUSTINESS_DISPLAY[gustiness] || gustiness;
  };

  const updateFromPointer = (clientX, clientY, last) => {
    const rect = face.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const norm = Math.max(0, Math.min(1, dist / maxRadius));
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
    if (angle < 0) angle += 360;

    const newSpeed = norm * maxSpeed;
    const newDir = angle;

    if (Math.abs(newSpeed - speedMS) > 0.05) {
      speedMS = newSpeed;
      opts.onSpeedChange(speedMS, last);
    }
    if (Math.abs(newDir - directionDeg) > 0.5) {
      directionDeg = newDir;
      opts.onDirectionChange(directionDeg, last);
    }
    applyNodePosition();
  };

  const onPointerDown = (e) => {
    if (e.target === hub) return;
    dragging = true;
    face.setPointerCapture(e.pointerId);
    updateFromPointer(e.clientX, e.clientY, false);
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    updateFromPointer(e.clientX, e.clientY, false);
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try { face.releasePointerCapture(e.pointerId); } catch (_) {}
    updateFromPointer(e.clientX, e.clientY, true);
    opts.onInteractionEnd?.();
  };

  face.addEventListener('pointerdown', onPointerDown);
  face.addEventListener('pointermove', onPointerMove);
  face.addEventListener('pointerup', onPointerUp);
  face.addEventListener('pointercancel', onPointerUp);

  hub.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onGustinessCycle();
  });

  node.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const delta = e.key === 'ArrowLeft' ? -5 : 5;
      directionDeg = ((directionDeg + delta) % 360 + 360) % 360;
      opts.onDirectionChange(directionDeg, true);
      applyNodePosition();
      e.preventDefault();
    } else if (e.key === '+' || e.key === '=') {
      speedMS = Math.min(maxSpeed, speedMS + 2);
      opts.onSpeedChange(speedMS, true);
      applyNodePosition();
    } else if (e.key === '-') {
      speedMS = Math.max(0, speedMS - 2);
      opts.onSpeedChange(speedMS, true);
      applyNodePosition();
    }
  });

  const mirror = ({ speedMS: s, directionDeg: d, gustiness: g }) => {
    if (Number.isFinite(s)) speedMS = s;
    if (Number.isFinite(d)) directionDeg = d;
    if (g && GUSTINESS_LABELS.includes(g)) gustiness = g;
    applyNodePosition();
  };

  const setGustiness = (g) => {
    gustiness = g;
    applyNodePosition();
  };

  applyNodePosition();

  return { wrap, mirror, setGustiness, cycleGustiness: () => {
    const idx = GUSTINESS_LABELS.indexOf(gustiness);
    const next = GUSTINESS_LABELS[(idx + 1) % GUSTINESS_LABELS.length];
    gustiness = next;
    applyNodePosition();
    return next;
  } };
}
