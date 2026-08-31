/**
 * ui/rooms/remote/astrolabe-dial.js — THE REMOTE'S HERO DIAL, matching the
 * approved mock for real (2026-08-18 fix; docs/holy/UI-Testament.md §4.1).
 *
 * ============================================================================
 * WHY THIS FILE EXISTS — THE GAP IT CLOSES
 * ============================================================================
 *
 * U2 re-homed `ui/astrolabe.js#createAstrolabe()` into the Remote's dial slot
 * on the premise that it was "already live, already wired... the least-new-
 * code highest-payoff item" (Petition P11) — true of its DATA wiring
 * (day-clock, wind, weather archetypes), false of its VISUAL DESIGN.
 * `createAstrolabe()` was built for `docs/planning/Control-Panel.md`'s older
 * "Bridge" doctrine: a flat SVG ring with no sky illustration, PLUS a bundled
 * legacy control block (wind/cloud/sky-light/atmosphere sliders, a 13-button
 * weather shelf, a mode `<select>`, a folded tuning drawer) that the LANTERN
 * redesign already re-built separately as `weather-board.js`. Re-homing it
 * unchanged meant the Remote showed a ~550×430px stack of two overlapping,
 * unstyled control surfaces where the mock shows a clean 340×340 instrument.
 * Author's own report, verbatim: "the astrolabe looks completely different...
 * the CSS and layout are not the same yet."
 *
 * This file is the REAL re-skin: the mock's actual ring (a static conic-
 * gradient colour wheel + a rotating handle, not per-band SVG arcs), its
 * actual landscape scene (multi-keyframe sky gradient, an orbiting sun/moon
 * with glow, a rotating star field, terrain silhouettes), and its actual
 * sizing — reproduced from `tools/ui-mock/index.html`'s own CSS/SVG/JS,
 * not reinterpreted. Where the mock hand-tuned exact colours and curves
 * (already author-approved across many logged rounds — see that file's own
 * round-6/8/11 comments), those are ported VERBATIM rather than rederived
 * through `world/sun.js`'s differently-calibrated elevation model: matching
 * the approved art exactly is the whole point of this fix, and a "close but
 * independently re-tuned" version risks becoming a SECOND mismatch.
 *
 * `ui/astrolabe.js` itself was UNTOUCHED at the time (the old debug panel
 * still used `createAstrolabe()` as its own separate surface) — since
 * deleted whole (UI parity plan, phase 7b) once that panel went too.
 * `hourToDialDeg`/`formatClock`/`compassLabel`/`TIME_STOPS`, reused from it
 * even then (pure geometry/formatting, already correct, already tested),
 * now live in `ui/astrolabe-geometry.js`, extracted at that same deletion
 * so this file's own import kept working with a real module behind it.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY NOT PORTED THIS ROUND — named, not silently dropped
 * ============================================================================
 *
 *   - The scene's animated weather overlays (scrolling rain/snow/ash streaks,
 *     a fog haze rect). Real follow-up work, not attempted here — the
 *     primary visual-identity gap was the ring/scene/sizing mismatch, not
 *     these secondary weather flourishes.
 *   - Cloud SHAPE variation (the mock's three hand-placed blob paths whose
 *     shape read differently per `cloudType01`). Cloud OPACITY still
 *     responds to real cover; shape stays fixed.
 *   - Real lunar phase. `world/calendar/moon.js#moonPhaseAt` exists and is
 *     real, but wiring it needs the Almanac's own live moon config, which
 *     this pass does not reach for. `moonAge` defaults to a fixed 0.4
 *     (a waxing gibbous, visually pleasant) rather than pretending to read
 *     a phase nothing here computes — a real, named follow-up.
 *   - Wind's mock-only "auto-drift" (`tickWindDrift`, a decorative simulated
 *     wander with no real engine behind it in the mock either — it exists
 *     purely so the mock's own demo never looks frozen). The real wind
 *     direction only changes the way it always has: the compass popover, or
 *     a live door/gust impulse.
 *
 * @module ui/rooms/remote/astrolabe-dial
 */

import { hourToDialDeg, formatClock, compassLabel, TIME_STOPS } from '../../astrolabe-geometry.js';

// ---- geometry, ported verbatim from the mock's own #astro/.rimArt rules ---

/** The rimArt SVG's own coordinate space (tools/ui-mock/index.html's `viewBox="0 0 244 244"`). */
const RIM_FACE = 244;
const RIM_C = RIM_FACE / 2;
/** Scene SVG's own space (`viewBox="0 0 160 160"`). */
const SCENE_FACE = 160;
const SCENE_HORIZON_Y = 100;
const SCENE_CX = 80;
const SCENE_ORBIT_R = 62;

/**
 * Place a celestial body for a given hour on its horizon-centred arc.
 * h=6 rises at the left edge, h=12 crests at the top, h=18 sets at the right.
 * Ported verbatim from the mock's own `orbitXY`.
 * @param {number} hour
 * @returns {{x: number, y: number, elev: number}} elev > 0 is above the horizon.
 */
export function orbitXY(hour) {
  const th = ((hour - 6) / 24) * 2 * Math.PI;
  return {
    x: SCENE_CX - SCENE_ORBIT_R * Math.cos(th),
    y: SCENE_HORIZON_Y - SCENE_ORBIT_R * Math.sin(th),
    elev: Math.sin(th),
  };
}

/** Sky keyframes: [hour, top, mid, bottom] RGB triples. Ported verbatim from the mock's `SKY_KEYS`. */
const SKY_KEYS = Object.freeze([
  [0, [7, 12, 34], [12, 19, 48], [20, 28, 62]],
  [5, [10, 17, 48], [26, 35, 80], [58, 58, 98]],
  [6.5, [29, 43, 92], [106, 90, 134], [232, 160, 94]],
  [8, [47, 95, 158], [111, 159, 208], [188, 216, 238]],
  [12, [42, 111, 188], [99, 163, 216], [168, 205, 234]],
  [16, [47, 111, 180], [120, 168, 212], [203, 216, 230]],
  [18, [42, 76, 140], [160, 106, 122], [240, 160, 90]],
  [19.5, [20, 32, 74], [70, 50, 94], [176, 96, 62]],
  [21, [10, 17, 48], [20, 28, 62], [34, 40, 76]],
  [24, [7, 12, 34], [12, 19, 48], [20, 28, 62]],
]);

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
/** @param {[number,number,number]} c */
export const rgb = (c) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

/**
 * The sky gradient's three stop colours for a given hour. Ported verbatim
 * from the mock's own `skyFor` — 10 hand-placed keyframes, RGB-lerped
 * between whichever two straddle the given hour.
 * @param {number} h
 * @returns {{top: [number,number,number], mid: [number,number,number], bot: [number,number,number]}}
 */
export function skyFor(h) {
  const hour = ((h % 24) + 24) % 24;
  let a = SKY_KEYS[0];
  let b = SKY_KEYS[SKY_KEYS.length - 1];
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    if (hour >= SKY_KEYS[i][0] && hour <= SKY_KEYS[i + 1][0]) {
      a = SKY_KEYS[i];
      b = SKY_KEYS[i + 1];
      break;
    }
  }
  const t = (hour - a[0]) / Math.max(b[0] - a[0], 0.0001);
  return { top: mix3(a[1], b[1], t), mid: mix3(a[2], b[2], t), bot: mix3(a[3], b[3], t) };
}

/** Terrain palettes, night→day. Ported verbatim from the mock's own `TERRAIN`. */
const TERRAIN = Object.freeze({
  mtnFar: { night: [13, 20, 40], day: [104, 126, 158] },
  hillNear: { night: [10, 16, 32], day: [74, 106, 82] },
  treeG: { night: [6, 10, 20], day: [41, 66, 47] },
  ground: { night: [8, 13, 24], day: [86, 114, 70] },
});
const WARM = Object.freeze([244, 168, 96]);

/**
 * One terrain layer's colour for the given day/golden-hour factors. Ported
 * verbatim from the mock's own per-layer loop inside `renderScene`.
 * @param {'mtnFar'|'hillNear'|'treeG'|'ground'} key
 * @param {number} day01 @param {number} golden01
 * @returns {[number,number,number]}
 */
export function terrainColorFor(key, day01, golden01) {
  const pal = TERRAIN[key];
  let c = mix3(pal.night, pal.day, day01);
  c = mix3(c, WARM, golden01 * 0.34 * day01);
  return c;
}

/**
 * Sun/moon day/night/golden factors for a given orbital elevation. Ported
 * verbatim from the mock's own inline formulas in `renderScene`.
 * @param {number} elev -1..1 (orbitXY's own `elev`)
 * @returns {{day01: number, night01: number, golden01: number}}
 */
export function elevationFactors(elev) {
  return {
    day01: clamp((elev + 0.18) / 0.55, 0, 1),
    night01: 1 - clamp((elev + 0.12) / 0.18, 0, 1),
    golden01: clamp(1 - Math.abs(elev) / 0.28, 0, 1),
  };
}

/** Fixed star field points (in scene space) — ported verbatim, never randomised
 * so the layout never twinkles into a different shape frame to frame. */
const STAR_POINTS = Object.freeze([
  [18, 26], [34, 14], [52, 30], [68, 18], [86, 25], [103, 13], [119, 29], [136, 20],
  [27, 44], [59, 50], [92, 44], [126, 48], [44, 62], [110, 64], [75, 8], [150, 36],
]); // prettier-ignore

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

let uid = 0;
/** Per-instance unique id suffix — two dials (old panel + Remote) must never
 * share one `<mask id>`/`<gradient id>`, or the second instance's SVG
 * `url(#id)` references resolve to the FIRST instance's element. */
function nextUid() {
  uid += 1;
  return `msa-astro-${uid}`;
}

/**
 * Build the Remote's hero dial. A VIEW, same posture as `ui/astrolabe.js`'s
 * own doc: owns no time/wind/weather state, every repaint comes from
 * `update(state)`, every gesture calls a handler the caller supplied.
 *
 * @param {object} opts
 * @param {(hour: number, committed: boolean) => void} opts.onTimeChange - ring drag.
 * @param {(hour: number) => void} [opts.onTimeStop] - a time-stop dot on the
 *   ring (UI parity plan, phase 6b) — sweeps immediately, same shape as
 *   `ui/astrolabe.js`'s own `onTimeStop`, gated by the SAME `locked` this
 *   dial's own drag gesture already respects.
 * @param {() => void} [opts.onDateClick]
 * @param {() => void} [opts.onWindClick] - opens the compass popover.
 * @param {() => void} [opts.onLockedAttempt] - fired when a drag/key gesture
 *   is attempted while `canSetHour` is false (see `update`'s own doc) instead
 *   of being silently swallowed — Law 5, matching `ui/astrolabe.js`'s own
 *   `flashStatus` on a locked-ring press.
 * @returns {{root: HTMLElement, update: (state: {
 *   hour: number, phase?: string, dateText?: string,
 *   windDirectionDeg?: number, windSpeed01?: number, cloudCover01?: number,
 *   canSetHour?: boolean,
 * }) => void}}
 */
export function buildAstrolabeDial(opts = {}) {
  const ns = nextUid();
  const root = styled('div', { position: 'relative', width: '340px', height: '340px', flex: '0 0 auto' });
  root.className = 'msa-astro-dial';
  // Set by `update()`, read by the drag-gesture block below — both live in
  // this same function's scope, so no indirection is needed to share it.
  let locked = false;

  // ---- the ring: a static conic-gradient colour wheel + a rotating handle --
  const ring = styled('div', { position: 'absolute', inset: '0', borderRadius: '50%' });
  ring.className = 'msa-astro-ring';
  ring.setAttribute('role', 'slider');
  ring.setAttribute('aria-label', 'Time of day');
  ring.setAttribute('aria-valuemin', '0');
  ring.setAttribute('aria-valuemax', '24');
  ring.tabIndex = 0;
  ring.title = 'Drag the rim to set the hour';
  root.appendChild(ring);

  const rimArt = svgEl('svg', { viewBox: `0 0 ${RIM_FACE} ${RIM_FACE}`, 'aria-hidden': 'true' });
  rimArt.classList.add('msa-astro-rimart');

  // ---- the 24 hour ticks, now clickable (UI parity plan, phase 6b, round 2)
  // Author feedback on the first attempt (8 separate dots at their own
  // radius): they visually clashed with the NOON/MIDNIGHT/DAWN/DUSK labels,
  // and "we already have lines, let's make those lines clickable" — so
  // instead of a second overlay, this tick loop IS the time-stop surface
  // now: all 24 hours, not just 8, each with a generous invisible hit-line
  // laid directly over its own visible tick.
  //
  // ⚠️ THE ANGLE INDEX `i` IS NOT THE HOUR. `i` is a purely decorative,
  // evenly-spaced 24-gridline index (i=0 at the top, clockwise) — it only
  // happens to coincide with hour 12 (noon) at the top because that is
  // where BOTH this loop's own i=0 AND `hourToDialDeg(12)`'s real rotation
  // land, by construction of the "noon is up" convention, not by i being an
  // hour number. Derived by hand, then checked against all four labels
  // before trusting it: hourToDialDeg(hour) ≡ i's own angle (mod 360) ⇒
  // hour = (i + 12) % 24 — confirmed i=0→12 (top/NOON), i=6→18 (right/DUSK),
  // i=12→0 (bottom/MIDNIGHT), i=18→6 (left/DAWN), each checked against
  // where that label actually sits. Using `i` itself as the hour (the
  // tempting, wrong shortcut) would put every tick's real time 12 hours
  // from where it visually points.
  const tickG = svgEl('g');
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * 2 * Math.PI;
    const hour = (i + 12) % 24;
    const major = i % 6 === 0;
    const r1 = major ? 108 : 113;
    const r2 = 121;
    const x1 = (RIM_C + r1 * Math.sin(a)).toFixed(2);
    const y1 = (RIM_C - r1 * Math.cos(a)).toFixed(2);
    const x2 = (RIM_C + r2 * Math.sin(a)).toFixed(2);
    const y2 = (RIM_C - r2 * Math.cos(a)).toFixed(2);
    tickG.appendChild(svgEl('line', { class: major ? 'major' : '', x1, y1, x2, y2 }));
    // A fat, invisible stroke over the SAME two points — 15° apart at this
    // radius leaves ample clearance between neighbours (checked: real-pixel
    // arc spacing comfortably exceeds the hit stroke's own width).
    const hit = svgEl('line', { class: 'msa-astro-timestop-hit', x1, y1, x2, y2 });
    const named = TIME_STOPS.find((s) => s.hour === hour);
    const title = svgEl('title');
    title.textContent = named ? `${named.label} — ${formatClock(hour)}` : formatClock(hour);
    hit.appendChild(title);
    hit.addEventListener('pointerdown', (e) => {
      e.stopPropagation(); // never start a ring-drag underneath a time-stop click
      if (locked) {
        opts.onLockedAttempt?.();
        return;
      }
      opts.onTimeStop?.(hour);
    });
    tickG.appendChild(hit);
  }
  rimArt.appendChild(tickG);
  const label = (x, y, text) => {
    const t = svgEl('text', { x, y });
    t.textContent = text;
    return t;
  };
  rimArt.append(label(122, 32, 'NOON'), label(122, 212, 'MIDNIGHT'), label(32, 122, 'DAWN'), label(212, 122, 'DUSK'));

  const handleG = svgEl('g', { class: 'msa-astro-handle' });
  handleG.appendChild(svgEl('rect', { x: 116.5, y: 3.5, width: 11, height: 10.5, rx: 5.5 }));
  rimArt.appendChild(handleG);
  root.appendChild(rimArt);

  // ---- the scene: sky gradient, orbiting sun/moon, stars, terrain ----------
  const skyGradId = `${ns}-sky`;
  const sunOuterId = `${ns}-sunOuter`;
  const sunInnerId = `${ns}-sunInner`;
  const moonGlowId = `${ns}-moonGlow`;
  const moonClipId = `${ns}-moonClip`;
  const skyMaskId = `${ns}-skyMask`;

  const scene = styled('div', { position: 'absolute', inset: '90px', borderRadius: '50%', overflow: 'hidden' });
  scene.className = 'msa-astro-scene';
  const sceneSvg = svgEl('svg', {
    viewBox: `0 0 ${SCENE_FACE} ${SCENE_FACE}`,
    'aria-hidden': 'true',
    preserveAspectRatio: 'xMidYMid slice',
  });

  const TERRAIN_PATHS = Object.freeze({
    mtnFar:
      'M0 99 L15 78 L27 89 L41 70 L57 87 L71 76 L86 91 L99 72 L113 87 L127 80 L141 93 L153 84 L160 95 L160 160 L0 160 Z',
    hillNear: 'M0 108 Q26 97 52 105 Q80 113 108 103 Q134 94 160 106 L160 160 L0 160 Z',
    ground: 'M0 116 Q80 111 160 118 L160 160 L0 160 Z',
  });

  const defs = svgEl('defs');
  const skyGrad = svgEl('linearGradient', { id: skyGradId, x1: 0, y1: 0, x2: 0, y2: 1 });
  const skyTop = svgEl('stop', { offset: 0, 'stop-color': '#2a6fbc' });
  const skyMid = svgEl('stop', { offset: 0.62, 'stop-color': '#63a3d8' });
  const skyBot = svgEl('stop', { offset: 1, 'stop-color': '#a8cdea' });
  skyGrad.append(skyTop, skyMid, skyBot);
  const sunGlowOuter = svgEl('radialGradient', { id: sunOuterId });
  sunGlowOuter.innerHTML =
    '<stop offset="0" stop-color="rgba(255,224,140,.4)"/><stop offset="1" stop-color="rgba(255,190,90,0)"/>';
  const sunGlowInner = svgEl('radialGradient', { id: sunInnerId });
  sunGlowInner.innerHTML =
    '<stop offset="0" stop-color="rgba(255,246,208,.9)"/><stop offset="1" stop-color="rgba(255,214,120,0)"/>';
  const moonGlow = svgEl('radialGradient', { id: moonGlowId });
  moonGlow.innerHTML =
    '<stop offset="0" stop-color="rgba(210,225,255,.42)"/><stop offset="1" stop-color="rgba(190,210,255,0)"/>';
  const moonClip = svgEl('clipPath', { id: moonClipId });
  moonClip.appendChild(svgEl('circle', { r: 5.4 }));
  // THE SUN GUARANTEE's mask (feedback_svg_mask_on_transformed_element_trap):
  // the sky region, i.e. everything EXCEPT the terrain silhouette — same two
  // paths as #mtnFar/#hillNear above. userSpaceOnUse + an explicit region
  // pins the mask's coordinate window to the scene's own fixed space,
  // independent of whatever element it ends up applied to.
  const skyMask = svgEl('mask', { id: skyMaskId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 160, height: 160 });
  skyMask.appendChild(svgEl('rect', { width: 160, height: 160, fill: '#fff' }));
  skyMask.appendChild(svgEl('path', { fill: '#000', d: TERRAIN_PATHS.mtnFar }));
  skyMask.appendChild(svgEl('path', { fill: '#000', d: TERRAIN_PATHS.hillNear }));
  defs.append(skyGrad, sunGlowOuter, sunGlowInner, moonGlow, moonClip, skyMask);
  sceneSvg.appendChild(defs);

  sceneSvg.appendChild(svgEl('rect', { width: 160, height: 160, fill: `url(#${skyGradId})` }));
  const starG = svgEl('g', { opacity: 0 });
  for (const [x, y] of STAR_POINTS) starG.appendChild(svgEl('circle', { cx: x, cy: y, r: 0.9, fill: '#fff' }));
  sceneSvg.appendChild(starG);
  const sunG = svgEl('g');
  sunG.innerHTML = `<circle r="24" fill="url(#${sunOuterId})"/><circle r="13" fill="url(#${sunInnerId})"/><circle r="8.5" fill="#fff6d8"/>`;
  sceneSvg.appendChild(sunG);
  const moonG = svgEl('g');
  const moonShade = svgEl('circle', {
    id: `${ns}-moonShade`,
    r: 5.4,
    fill: '#0b1024',
    'clip-path': `url(#${moonClipId})`,
  });
  moonG.innerHTML = `<circle r="13" fill="url(#${moonGlowId})"/><circle r="5.4" fill="#e9efff"/>`;
  moonG.appendChild(moonShade);
  sceneSvg.appendChild(moonG);
  const cloudG = svgEl('g', { opacity: 0, fill: '#fff' });
  cloudG.innerHTML =
    '<path d="M18 46q5-9 14-6 4-8 13-5 7 1 8 8 8 0 8 6H14q-1-3 4-3Z"/>' +
    '<path d="M92 33q4-8 12-5 4-7 12-4 6 1 7 7 7 0 7 6H88q-1-3 4-4Z"/>' +
    '<path d="M52 66q4-6 10-4 3-6 10-3 5 1 6 6 6 0 6 5H49q-1-3 3-4Z"/>';
  sceneSvg.appendChild(cloudG);
  const mtnFar = svgEl('path', { d: TERRAIN_PATHS.mtnFar });
  const hillNear = svgEl('path', { d: TERRAIN_PATHS.hillNear });
  const treeG = svgEl('g');
  treeG.innerHTML =
    '<path d="M22 112 l5-13 5 13 Z"/><path d="M30 115 l4-10 4 10 Z"/>' +
    '<path d="M124 108 l5-12 5 12 Z"/><path d="M132 111 l4-9 4 9 Z"/>';
  const ground = svgEl('path', { d: TERRAIN_PATHS.ground });
  sceneSvg.append(mtnFar, hillNear, treeG, ground);
  scene.appendChild(sceneSvg);
  root.appendChild(scene);

  // ---- sceneText: clock/phase pill (top) + date/wind pills (bottom) -------
  const sceneText = styled('div', {
    position: 'absolute',
    inset: '90px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'space-between',
    textAlign: 'center',
    pointerEvents: 'none',
  });
  sceneText.className = 'msa-astro-scenetext';
  const clockPill = styled('div', { pointerEvents: 'auto' });
  clockPill.className = 'msa-astro-clockpill';
  const clockTime = styled('span', {});
  clockTime.className = 'msa-astro-time';
  const clockPhase = styled('span', {});
  clockPhase.className = 'msa-astro-phase';
  clockPill.append(clockTime, clockPhase);
  const lowerRow = styled('div', {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    pointerEvents: 'auto',
  });
  const dateBtn = styled('button', {});
  dateBtn.type = 'button';
  dateBtn.className = 'msa-astro-pill';
  dateBtn.title = 'Change the date';
  const dateText = document.createElement('span');
  dateBtn.appendChild(dateText);
  dateBtn.addEventListener('click', () => opts.onDateClick?.());
  const windBtn = styled('button', {});
  windBtn.type = 'button';
  windBtn.className = 'msa-astro-pill';
  windBtn.title = 'Wind direction — click to set it manually';
  const windDirText = document.createElement('span');
  windBtn.appendChild(windDirText);
  windBtn.addEventListener('click', () => opts.onWindClick?.());
  lowerRow.append(dateBtn, windBtn);
  sceneText.append(clockPill, lowerRow);
  // NOT appended here (2026-08-18 fix — author: "Sun is in front of the
  // pill and time text") — sceneTopper below is a SIBLING absolute layer
  // painted for the sun/moon to stay visible over the TERRAIN, and DOM
  // order (not z-index) decides paint order between same-stacking-context
  // absolute siblings here. Appending sceneText before topper put the sun's
  // own guarantee layer on top of the clock pill too, an overlap the mask
  // (clipped to sky-minus-terrain) has no knowledge of and can't prevent.
  // sceneText goes on AFTER topper instead, so the pill always wins.

  // ---- sceneTopper: the sun/moon guarantee — never covered by chrome ------
  const topper = svgEl('svg', {
    viewBox: `0 0 ${SCENE_FACE} ${SCENE_FACE}`,
    'aria-hidden': 'true',
    preserveAspectRatio: 'xMidYMid slice',
  });
  topper.classList.add('msa-astro-scenetopper');
  // The mask sits on this STATIC wrapper `<g>`, never on the moving sunTopG/
  // moonTopG themselves (feedback_svg_mask_on_transformed_element_trap) — a
  // mask on an element that ALSO carries its own transform re-anchors the
  // mask's userSpaceOnUse region to THAT element's own moving coordinate
  // space instead of the scene's fixed one.
  const maskedG = svgEl('g', { mask: `url(#${skyMaskId})` });
  const sunTopG = svgEl('g');
  sunTopG.innerHTML = `<circle r="24" fill="url(#${sunOuterId})"/><circle r="13" fill="url(#${sunInnerId})"/><circle r="8.5" fill="#fff6d8"/>`;
  const moonTopG = svgEl('g');
  moonTopG.innerHTML = `<circle r="13" fill="url(#${moonGlowId})"/><circle r="5.4" fill="#e9efff"/>`;
  maskedG.append(sunTopG, moonTopG);
  topper.appendChild(maskedG);
  root.appendChild(topper);
  root.appendChild(sceneText);

  // ---- drag-to-set-hour on the ring -----------------------------------------
  // `locked` mirrors ui/astrolabe.js's own `ringLocked` (2026-08-18 fix —
  // gap-audit Gap 12: this ring never carried a lock at all, so a drag in
  // Follow/Almanac mode silently persisted a `todHour` the engines then
  // ignored — `boot.js#applyLookToEngines` only applies `todHour` at all
  // in `sky.mode === 'aesthetic'`, but `editSky`'s own merge has no such
  // guard, so the stored hour drifted from what the GM actually saw with no
  // visible sign anything was wrong, confirmed by reading day-clock.js's
  // `setHour`/`applyLookToEngines` directly rather than assumed from the old
  // panel's own, differently-shaped lock). Gated at gesture-START only, same
  // fidelity as the old file's own `onDown` check — not re-polled mid-drag.
  {
    let dragging = false;
    const move = (e) => {
      if (!dragging) return;
      const r = ring.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      const hour = ((deg / 360) * 24 + 12) % 24;
      opts.onTimeChange?.(hour, false);
    };
    ring.addEventListener('pointerdown', (e) => {
      if (locked) {
        opts.onLockedAttempt?.();
        return;
      }
      // PAINT FIRST, CAPTURE SECOND, AND THE CAPTURE IS ALLOWED TO FAIL — the
      // same documented trap `param-control.js#buildCompassRow` already
      // guards against (2026-08-16 finding, that file's own header): a real
      // browser can throw `NotFoundError` from `setPointerCapture` when the
      // pointer id is no longer active by the time this handler runs. The
      // ORIGINAL order here (capture, then move) let that throw abort the
      // handler AFTER `dragging=true` but BEFORE `move(e)` recorded a real
      // position — leaving `dragging` stuck true with no capture and no
      // pointermove/pointerup ever reliably reaching this element again,
      // which reads exactly as "drag, release, and the ring goes dead."
      dragging = true;
      move(e);
      try {
        ring.setPointerCapture(e.pointerId);
      } catch (_) {
        /* no capture: a drag that leaves the ring's own hit-area simply
           stops tracking, which is a degraded control, not a stuck one */
      }
    });
    ring.addEventListener('pointermove', move);
    ring.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      const r = ring.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2);
      const dy = e.clientY - (r.top + r.height / 2);
      const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
      opts.onTimeChange?.(((deg / 360) * 24 + 12) % 24, true);
    });
    // Without this, a cancelled gesture (OS/browser interrupts the pointer —
    // an alt-tab, a system dialog, a touch cancel) leaves `dragging` stuck
    // `true` forever with no capture, since only `pointerup` was ever
    // handled — a real robustness gap alongside the setPointerCapture fix
    // just above, same failure family (a drag that starts but never
    // cleanly ends). Resets state WITHOUT committing — a cancel means
    // "abort," not "confirm whatever the last known position was."
    ring.addEventListener('pointercancel', (e) => {
      dragging = false;
      try {
        ring.releasePointerCapture(e.pointerId);
      } catch (_) {
        /* capture already gone — releasing twice is not worth surfacing */
      }
    });
    ring.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      if (locked) {
        opts.onLockedAttempt?.();
        return;
      }
      const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -0.25 : 0.25;
      const current = Number(ring.getAttribute('aria-valuenow') ?? 12);
      opts.onTimeChange?.((current + dir + 24) % 24, true);
    });
  }

  // A fixed lunar phase — no real Almanac wiring reaches this file yet (see
  // this module's own header for why). 0.4 is a pleasant waxing gibbous.
  const MOON_AGE = 0.4;

  /**
   * @param {{hour: number, phase?: string, dateText?: string,
   *   windDirectionDeg?: number, windSpeed01?: number, cloudCover01?: number,
   *   canSetHour?: boolean}} [state]
   */
  function update(state = {}) {
    const hour = Number.isFinite(state.hour) ? state.hour : 12;
    ring.setAttribute('aria-valuenow', hour.toFixed(1));
    handleG.setAttribute('transform', `rotate(${hourToDialDeg(hour)} ${RIM_C} ${RIM_C})`);

    // Fails OPEN, same as ui/astrolabe.js's own `s.canSetHour === false`
    // check — an absent field (an older/thinner caller, a not-yet-ready
    // frame) must never read as "locked," or the ring would freeze for a
    // reason nobody asked for (feedback_gate_polarity_must_fail_open).
    locked = state.canSetHour === false;
    ring.style.cursor = locked ? 'not-allowed' : 'pointer';
    ring.setAttribute('aria-disabled', String(locked));
    rimArt.style.opacity = locked ? '0.55' : '1';

    const sky = skyFor(hour);
    skyTop.setAttribute('stop-color', rgb(sky.top));
    skyMid.setAttribute('stop-color', rgb(sky.mid));
    skyBot.setAttribute('stop-color', rgb(sky.bot));

    const cloudCover01 = clamp(state.cloudCover01 ?? 0, 0, 1);
    const cloudDamp = 1 - cloudCover01 * 0.72;

    const sun = orbitXY(hour);
    const { day01, night01, golden01 } = elevationFactors(sun.elev);
    const sunOpacity = (clamp((sun.elev + 0.22) * 6, 0, 1) * cloudDamp).toFixed(2);
    sunG.setAttribute('transform', `translate(${sun.x.toFixed(2)} ${sun.y.toFixed(2)})`);
    sunG.setAttribute('opacity', sunOpacity);
    sunTopG.setAttribute('transform', sunG.getAttribute('transform'));
    sunTopG.setAttribute('opacity', sunOpacity);

    const moonHour = (hour + MOON_AGE * 24) % 24;
    const mo = orbitXY(moonHour);
    const moonOpacity = (clamp((mo.elev + 0.18) * 5, 0, 1) * (0.35 + 0.65 * night01) * cloudDamp).toFixed(2);
    moonG.setAttribute('transform', `translate(${mo.x.toFixed(2)} ${mo.y.toFixed(2)})`);
    moonG.setAttribute('opacity', moonOpacity);
    moonTopG.setAttribute('transform', moonG.getAttribute('transform'));
    moonTopG.setAttribute('opacity', moonOpacity);
    const illum = (1 - Math.cos(MOON_AGE * 2 * Math.PI)) / 2;
    moonShade.setAttribute('cx', (11 * illum * (MOON_AGE < 0.5 ? 1 : -1)).toFixed(2));
    moonShade.setAttribute('fill', rgb(mix3(sky.top, sky.mid, 0.5)));

    starG.setAttribute('opacity', (night01 * 0.9 * cloudDamp).toFixed(2));
    starG.setAttribute('transform', `rotate(${(hour * 15).toFixed(1)} ${SCENE_CX} ${SCENE_HORIZON_Y})`);

    cloudG.setAttribute('opacity', (cloudCover01 * 0.85).toFixed(2));
    cloudG.setAttribute('fill', rgb(mix3(mix3(sky.mid, [255, 255, 255], 0.55), WARM, golden01 * 0.4)));

    mtnFar.setAttribute('fill', rgb(terrainColorFor('mtnFar', day01, golden01)));
    hillNear.setAttribute('fill', rgb(terrainColorFor('hillNear', day01, golden01)));
    ground.setAttribute('fill', rgb(terrainColorFor('ground', day01, golden01)));
    treeG.setAttribute('fill', rgb(terrainColorFor('treeG', day01, golden01)));

    clockTime.textContent = formatClock(hour);
    clockPhase.textContent = (state.phase ?? '').toUpperCase();
    dateText.textContent = state.dateText ?? '—';
    const dir = Number.isFinite(state.windDirectionDeg) ? state.windDirectionDeg : 0;
    // Speed was accepted in this function's own JSDoc but never actually
    // read here (2026-08-18 fix; gap-audit against the old astrolabe.js's
    // real wind slider) — arrived every tick, silently dropped. Matches the
    // old panel's own "wind-panel" status format exactly (boot.js), not a
    // new convention.
    const speed01 = Number.isFinite(state.windSpeed01) ? state.windSpeed01 : 0;
    windDirText.textContent = speed01 > 0 ? `${compassLabel(dir)} · ${Math.round(speed01 * 100)}%` : 'calm';
  }

  return { root, update };
}
