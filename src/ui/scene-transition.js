/**
 * @fileoverview ui/scene-transition.js — ONE transition for every cut: the first load, a scene
 * change and a floor change (author, 2026-10-26).
 *
 * ============================================================================
 * WHAT THE AUTHOR ASKED FOR
 * ============================================================================
 * "MSA [should] enforce a single transition type between all loading, scene changes and floor
 * changes … fade to black from the loading screen and then fade into the correct scene fully
 * rendered … a small number of subtle and elegant ways to cut … floor changes … quicker,
 * first loading and scene changes … much longer … read from the Foundry VTT system's own
 * transition system … make it easy to set a default … AND [let] the GM … setup a more dramatic
 * or unusual transition and make that happen the next time a scene change happens."
 * Her answers to the plan: floors default to a quick fade through black; a scene's own Foundry
 * transition overrides the MSA default but NOT an armed override; the armed override applies to
 * the next scene change only.
 *
 * ============================================================================
 * TWO HALVES
 * ============================================================================
 *  - {@link planTransition} — PURE. Decides what this cut looks like: armed override, else the
 *    scene's own Foundry setting, else the GM's default style at the moment's pace. Node-tested.
 *  - {@link createTransitionDirector} — the DOM. A veil (a colour, or a still frame) above the map
 *    and below every UI: Foundry's own interface (z 60+), MSA's rooms (z 100) and the loading
 *    curtain (z 100000) all stay on top of it, so a transition never hides the GM's tools.
 *    It COVERS before the view changes and REVEALS once the new view is fully rendered; when
 *    that happens is the loading code's decision, never this file's.
 *
 * Foundry's own effects (swirl, dots, glitch …) only see Foundry's PIXI layer, and MSA draws on
 * its own canvas underneath — the reason Foundry's snapshot used to come out grey. So an effect
 * of that kind is played by the caller-supplied `playFoundry` on a COMBINED still (MSA's frame
 * plus Foundry's layer, {@link composeFrame}); this file only sequences it.
 *
 * @module ui/scene-transition
 */

/** Pace multiplies every duration. */
export const TRANSITION_PACES = Object.freeze({
  brisk: { label: 'Brisk', scale: 0.6 },
  measured: { label: 'Measured', scale: 1 },
  slow: { label: 'Slow', scale: 1.6 },
});

/**
 * THE PRESETS — what the GM picks from, ordered QUICK AND SIMPLE → LONG AND DRAMATIC (author,
 * 2026-10-26: "at least four options from quick and simple to longer and more dramatic"). Each one
 * says what a load, a scene change and a floor change look like, so a dramatic preset never makes
 * EVERY floor change a spectacle: floors stay brisk in all of them. Times are at Measured pace.
 *
 * A moment is `{kind, outMs, inMs}`; `kind: 'foundry'` also names a `foundryType` from Foundry's
 * catalogue and a `fallback` fade for tables where that effect is not installed.
 */
export const TRANSITION_PRESETS = Object.freeze({
  cut: {
    label: 'Cut',
    hint: 'Instant. Nothing in between.',
    moments: {
      load: { kind: 'cut', outMs: 0, inMs: 0 },
      scene: { kind: 'cut', outMs: 0, inMs: 0 },
      floor: { kind: 'cut', outMs: 0, inMs: 0 },
    },
  },
  quick: {
    label: 'Quick fade',
    hint: 'A short dip through black. Out of the way.',
    moments: {
      load: { kind: 'fade', outMs: 400, inMs: 600 },
      scene: { kind: 'fade', outMs: 400, inMs: 600 },
      floor: { kind: 'fade', outMs: 120, inMs: 180 },
    },
  },
  soft: {
    label: 'Soft fade',
    hint: 'A gentle fade through black.',
    moments: {
      load: { kind: 'fade', outMs: 800, inMs: 1100 },
      scene: { kind: 'fade', outMs: 800, inMs: 1100 },
      floor: { kind: 'fade', outMs: 200, inMs: 280 },
    },
  },
  dissolve: {
    label: 'Slow dissolve',
    hint: 'One scene melts into the next. No black.',
    moments: {
      load: { kind: 'dissolve', outMs: 0, inMs: 2500 },
      scene: { kind: 'dissolve', outMs: 0, inMs: 2500 },
      floor: { kind: 'dissolve', outMs: 0, inMs: 450 },
    },
  },
  cinematic: {
    label: 'Cinematic',
    hint: 'A slow fade through black, then the scene rises, fully rendered.',
    moments: {
      load: { kind: 'fade', outMs: 1200, inMs: 1600 },
      scene: { kind: 'fade', outMs: 1200, inMs: 1600 },
      floor: { kind: 'fade', outMs: 250, inMs: 350 },
    },
  },
  dramatic: {
    label: 'Dramatic',
    hint: 'A long, deliberate fade to black and back.',
    moments: {
      load: { kind: 'fade', outMs: 2500, inMs: 3500 },
      scene: { kind: 'fade', outMs: 2500, inMs: 3500 },
      floor: { kind: 'fade', outMs: 400, inMs: 600 },
    },
  },
  grand: {
    label: 'Grand entrance',
    hint: 'A swirling reveal for scenes and loads (a long fade where Foundry lacks it). Floors stay brisk. The longest of all.',
    moments: {
      load: {
        kind: 'foundry',
        foundryType: 'holeSwirl',
        outMs: 2000,
        inMs: 4500,
        fallback: { kind: 'fade', outMs: 2500, inMs: 3500 },
      },
      scene: {
        kind: 'foundry',
        foundryType: 'holeSwirl',
        outMs: 2000,
        inMs: 4500,
        fallback: { kind: 'fade', outMs: 2500, inMs: 3500 },
      },
      floor: { kind: 'fade', outMs: 400, inMs: 600 },
    },
  },
});

/** The preset a fresh world starts on. */
export const DEFAULT_PRESET = 'cinematic';

/** Preset ids, quick to dramatic. */
export const TRANSITION_PRESET_IDS = Object.freeze(Object.keys(TRANSITION_PRESETS));

/**
 * How long a preset takes at a pace, for the Remote to show next to its name.
 * @param {string} presetId @param {string} [pace]
 * @returns {{sceneMs: number, floorMs: number}}
 */
export function summarisePreset(presetId, pace = 'measured') {
  const preset = TRANSITION_PRESETS[presetId] ?? TRANSITION_PRESETS[DEFAULT_PRESET];
  const scale = TRANSITION_PACES[pace]?.scale ?? 1;
  const total = (m) => Math.round((m.outMs + m.inMs) * scale);
  return { sceneMs: total(preset.moments.scene), floorMs: total(preset.moments.floor) };
}

/**
 * Base timings at Measured pace (ms) for a Foundry effect played from the armed override or a scene's
 * own setting (a preset carries its own, above). `outMs` is the dimming half, `inMs` the rising half. Floors
 * are quick by design (the author: "floor changes opt usually for quicker transitions"); loads and
 * scene changes are long ("first loading and scene changes can default to much longer").
 */
export const MOMENT_TIMINGS = Object.freeze({
  load: { fade: { outMs: 1200, inMs: 1600 }, dissolve: { outMs: 0, inMs: 1500 } },
  scene: { fade: { outMs: 1200, inMs: 1600 }, dissolve: { outMs: 0, inMs: 1500 } },
  floor: { fade: { outMs: 250, inMs: 350 }, dissolve: { outMs: 0, inMs: 350 } },
});

/** MSA's own dramatic choices for the armed override (Foundry's catalogue is offered beside them). */
export const DRAMATIC_TRANSITIONS = Object.freeze({
  longFade: { label: 'Long fade to black', kind: 'fade', color: '#000000', outMs: 2500, inMs: 3500 },
  dipWhite: { label: 'Dip to white', kind: 'fade', color: '#ffffff', outMs: 1500, inMs: 2500 },
  slowDissolve: { label: 'Slow dissolve', kind: 'dissolve', color: '#000000', outMs: 0, inMs: 4000 },
});

/** Reduced motion: every transition becomes a short fade (or stays a cut). */
export const REDUCED_MOTION_MAX_MS = 200;
/** Foundry's own bounds for a scene transition's duration (`common/documents/scene.mjs`). */
export const OVERRIDE_DURATION_MIN_MS = 500;
export const OVERRIDE_DURATION_MAX_MS = 10000;
/** The longest a cover may stay up waiting for a reveal before it lifts by itself. */
export const MAX_HOLD_MS = Object.freeze({ load: 180000, scene: 180000, floor: 20000 });

const BLACK = '#000000';
const clampMs = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));

/**
 * What this cut looks like.
 *
 * @param {object} args
 * @param {'load'|'scene'|'floor'} args.moment
 * @param {string} [args.preset] - a {@link TRANSITION_PRESETS} id (the GM's default)
 * @param {string} [args.pace] - a {@link TRANSITION_PACES} id
 * @param {boolean} [args.reducedMotion]
 * @param {{type: string|null, durationMs?: number|null, activeOnly?: boolean, sceneActive?: boolean}|null} [args.sceneTransition]
 *   the scene's own Foundry setting (Configure Scene → transition); `type: null` = not set
 * @param {{type: string, durationMs?: number}|null} [args.override] - the GM's armed override
 * @param {string[]} [args.foundryTypes] - ids in Foundry's catalogue (`CONFIG.Canvas.sceneTransitions`)
 * @returns {{kind: 'cut'|'fade'|'dissolve'|'foundry', foundryType: string|null, color: string,
 *   outMs: number, inMs: number, source: 'override'|'scene'|'default', moment: string}}
 */
export function planTransition({
  moment,
  preset = DEFAULT_PRESET,
  pace = 'measured',
  reducedMotion = false,
  sceneTransition = null,
  override = null,
  foundryTypes = [],
}) {
  const m = MOMENT_TIMINGS[moment] ? moment : 'scene';
  const isFoundryType = (t) => typeof t === 'string' && foundryTypes.includes(t);
  let plan = null;

  // 1. THE ARMED OVERRIDE — a scene change (or a load into one) only, per the author.
  if (!plan && override && m !== 'floor') {
    const durationMs = Number.isFinite(override.durationMs)
      ? clampMs(override.durationMs, OVERRIDE_DURATION_MIN_MS, OVERRIDE_DURATION_MAX_MS)
      : null;
    const own = DRAMATIC_TRANSITIONS[override.type];
    if (own) {
      const total = own.outMs + own.inMs;
      const scale = durationMs !== null && total > 0 ? durationMs / total : 1;
      plan = {
        kind: own.kind,
        foundryType: null,
        color: own.color,
        outMs: Math.round(own.outMs * scale),
        inMs: Math.round(own.inMs * scale),
        source: 'override',
      };
    } else if (isFoundryType(override.type)) {
      plan = {
        kind: 'foundry',
        foundryType: override.type,
        color: BLACK,
        outMs: MOMENT_TIMINGS[m].fade.outMs,
        inMs: durationMs ?? 1500,
        source: 'override',
      };
    }
  }

  // 2. THE SCENE'S OWN FOUNDRY SETTING — beats the MSA default, never an armed override. Foundry
  // itself only plays it on a scene change, so floors ignore it the same way.
  const st = sceneTransition;
  if (!plan && st?.type && m !== 'floor' && (!st.activeOnly || st.sceneActive === true)) {
    const durationMs = Number.isFinite(st.durationMs)
      ? clampMs(st.durationMs, OVERRIDE_DURATION_MIN_MS, OVERRIDE_DURATION_MAX_MS)
      : 1500;
    if (st.type === 'fade') {
      // Foundry's "fade" is a cross-fade of the two views, which is MSA's dissolve.
      plan = { kind: 'dissolve', foundryType: null, color: BLACK, outMs: 0, inMs: durationMs, source: 'scene' };
    } else if (isFoundryType(st.type)) {
      plan = {
        kind: 'foundry',
        foundryType: st.type,
        color: BLACK,
        outMs: MOMENT_TIMINGS[m].fade.outMs,
        inMs: durationMs,
        source: 'scene',
      };
    }
    // An unknown type (a module that added it was removed) falls through to the default.
  }

  // 3. THE GM'S DEFAULT PRESET, at this moment's pace.
  if (!plan) {
    let moment = (TRANSITION_PRESETS[preset] ?? TRANSITION_PRESETS[DEFAULT_PRESET]).moments[m];
    // A Foundry effect this table does not have (a module removed) plays the preset's own fallback.
    if (moment.kind === 'foundry' && !isFoundryType(moment.foundryType)) moment = moment.fallback;
    const scale = TRANSITION_PACES[pace]?.scale ?? 1;
    plan = {
      kind: moment.kind,
      foundryType: moment.kind === 'foundry' ? moment.foundryType : null,
      color: BLACK,
      outMs: Math.round(moment.outMs * scale),
      inMs: Math.round(moment.inMs * scale),
      source: 'default',
    };
  }

  // Reduced motion: no moving effect, and nothing longer than a blink.
  if (reducedMotion && plan.kind !== 'cut') {
    plan = {
      ...plan,
      kind: plan.kind === 'foundry' ? 'fade' : plan.kind,
      foundryType: null,
      color: BLACK,
      outMs: Math.min(plan.outMs, REDUCED_MOTION_MAX_MS),
      inMs: Math.min(plan.inMs, REDUCED_MOTION_MAX_MS),
    };
  }
  return { ...plan, moment: m };
}

/**
 * Draw several layers (bottom first) into one canvas of the given size, each stretched to fill
 * it — MSA's frame, then Foundry's layer on top. Null layers are skipped. `null` if nothing drew.
 * @param {Array<CanvasImageSource|null|undefined>} layers
 * @param {{width: number, height: number}} size
 * @returns {HTMLCanvasElement|null}
 */
export function composeFrame(layers, { width, height }) {
  if (typeof document === 'undefined') return null;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  let drew = false;
  for (const layer of layers) {
    if (!layer) continue;
    ctx.drawImage(layer, 0, 0, w, h);
    drew = true;
  }
  return drew ? out : null;
}

const VEIL_ID = 'msa-scene-veil';
/** Above the map (#board, the MSA canvas at 5), below Foundry's interface and every MSA room. */
const VEIL_Z = '50';
const EASE = 'cubic-bezier(0.45, 0, 0.55, 1)';

/**
 * @param {object} deps
 * @param {() => HTMLElement} deps.resolveHost - where the veil lives (the loading curtain's own host)
 * @param {() => Promise<HTMLCanvasElement|null>} [deps.captureFrame] - the combined still
 * @param {(a: {to: HTMLCanvasElement, type: string, durationMs: number, color: string, onCovered: () => void}) => Promise<boolean>} [deps.playFoundry]
 * @param {{warn?: Function, info?: Function}} [deps.log]
 * @returns {{
 *   cover: (plan: object) => Promise<void>,
 *   reveal: () => Promise<void>,
 *   revealFromCurtain: (plan: object, endCurtain: (fadeMs: number) => Promise<void>|void) => Promise<void>,
 *   abort: (why?: string) => void,
 *   isCovering: () => boolean,
 *   getStatus: () => object,
 * }}
 */
export function createTransitionDirector({ resolveHost, captureFrame, playFoundry, log } = {}) {
  /** @type {HTMLElement|null} */
  let veil = null;
  let plan = null;
  let safety = null;
  let generation = 0;
  const stats = { covers: 0, reveals: 0, aborts: 0, safetyReveals: 0, last: null };

  const wait = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

  function ensureVeil(color, opacity) {
    if (typeof document === 'undefined') return null;
    if (!veil || !veil.isConnected) {
      veil = document.createElement('div');
      veil.id = VEIL_ID;
      Object.assign(veil.style, {
        position: 'absolute',
        inset: '0',
        zIndex: VEIL_Z,
        pointerEvents: 'none', // a transition must never trap a click
        opacity: '0',
      });
      (resolveHost?.() ?? document.body).appendChild(veil);
    }
    veil.style.transition = 'none';
    veil.style.transform = '';
    veil.style.background = color ?? BLACK;
    veil.style.opacity = String(opacity);
    return veil;
  }

  function showStill(frame) {
    const v = ensureVeil('transparent', 1);
    if (!v) return;
    v.replaceChildren();
    Object.assign(frame.style, { width: '100%', height: '100%', display: 'block' });
    v.appendChild(frame);
  }

  /**
   * @param {number} opacity
   * @param {number} ms
   * @param {number} [scale] - move the veil to this scale about the centre while it fades (a still that
   *   recedes or rises as it dissolves). Only ever used for a captured still, never for a plain colour.
   */
  async function fadeVeilTo(opacity, ms, scale = 1) {
    if (!veil) return;
    void veil.offsetWidth; // commit the start state before the transition is set
    const moving = ms > 0 && Number.isFinite(scale) && scale !== 1;
    veil.style.transformOrigin = '50% 50%';
    veil.style.transition = ms > 0 ? `opacity ${ms}ms ${EASE}${moving ? `, transform ${ms}ms ${EASE}` : ''}` : 'none';
    veil.style.opacity = String(opacity);
    veil.style.transform = moving ? `scale(${scale})` : '';
    if (ms > 0) await wait(ms);
  }

  function clear() {
    if (safety !== null) clearTimeout(safety);
    safety = null;
    veil?.remove();
    veil = null;
    plan = null;
  }

  function armSafety(p) {
    if (safety !== null) clearTimeout(safety);
    const myGen = generation;
    safety = setTimeout(() => {
      if (myGen !== generation || !veil) return;
      stats.safetyReveals++;
      log?.warn?.(`transition: nothing revealed the ${p.moment} change in time — lifting the cover.`);
      clear();
    }, MAX_HOLD_MS[p.moment] ?? MAX_HOLD_MS.scene);
  }

  return {
    /** The first half: dim (or freeze) the current view BEFORE it changes. */
    async cover(p) {
      if (!p) return;
      generation++;
      stats.covers++;
      stats.last = { phase: 'cover', kind: p.kind, source: p.source, moment: p.moment };
      plan = p;
      armSafety(p);
      if (p.kind === 'cut') {
        ensureVeil(p.color, 1); // hides Foundry's redraw; lifted instantly on reveal
        return;
      }
      if (p.kind === 'dissolve') {
        const frame = (await captureFrame?.()) ?? null;
        if (frame) showStill(frame);
        else ensureVeil(BLACK, 1); // no still to dissolve from: hold on black instead
        return;
      }
      ensureVeil(p.color, 0); // fade or a Foundry effect: dim to the colour
      await fadeVeilTo(1, p.outMs);
    },

    /** The second half, for a view with no loading curtain (a floor change): show the new view. */
    async reveal() {
      stats.reveals++;
      if (!plan || !veil) return clear();
      const p = plan;
      const myGen = ++generation;
      stats.last = { phase: 'reveal', kind: p.kind, source: p.source, moment: p.moment };
      if (p.kind !== 'cut') await fadeVeilTo(0, p.inMs, p.kind === 'dissolve' ? p.depthScale : 1);
      if (myGen === generation) clear();
    },

    /**
     * The second half of a load or scene change, which ends with the loading curtain up. The
     * curtain itself becomes part of the transition: it fades to the veil's colour, then the
     * scene rises; or, for a dissolve, it melts straight into the scene.
     */
    async revealFromCurtain(p, endCurtain) {
      const myGen = ++generation;
      plan = p;
      stats.reveals++;
      stats.last = { phase: 'reveal-from-curtain', kind: p.kind, source: p.source, moment: p.moment };
      const end = async (ms) => {
        try {
          await endCurtain?.(ms);
        } catch (err) {
          log?.warn?.('transition: ending the loading curtain threw:', err);
        }
      };
      if (p.kind === 'cut') {
        clear();
        await end(0);
        return;
      }
      if (p.kind === 'dissolve') {
        clear(); // the live scene goes under the curtain at once
        await end(p.inMs);
        return;
      }
      ensureVeil(p.color, 1);
      await end(p.outMs); // the curtain fades out over the colour
      if (myGen !== generation) return;
      if (p.kind === 'foundry' && playFoundry) {
        const to = (await captureFrame?.()) ?? null;
        const played = to
          ? await playFoundry({ to, type: p.foundryType, durationMs: p.inMs, color: p.color, onCovered: () => clear() })
          : false;
        if (played) {
          clear();
          return;
        }
        log?.info?.(`transition: Foundry effect "${p.foundryType}" could not play — fading instead.`);
        ensureVeil(p.color, 1);
      }
      await fadeVeilTo(0, p.inMs);
      if (myGen === generation) clear();
    },

    /** Lift any cover at once (a failed or cancelled change must never leave the screen dark). */
    abort(why) {
      if (!veil) return;
      generation++;
      stats.aborts++;
      stats.last = { phase: 'abort', why: why ?? null };
      clear();
    },

    isCovering: () => !!veil,
    getStatus: () => ({ covering: !!veil, plan, ...stats }),
  };
}
