/**
 * ui/scene-transition.js — the pure planner (what each cut looks like) and the environment-safety
 * guarantee (no `document` under Node: the DOM half must not throw). The veil's timing and the
 * Foundry-effect sequencing need a real browser and are verified live, the split every `ui/`
 * module here draws.
 *
 * Defended, from the author's own answers (2026-10-26): floors default to a QUICK fade through
 * black; loads and scene changes are long; a scene's own Foundry setting beats the MSA default
 * but never an armed override; an armed override applies to scene changes only.
 */
import {
  planTransition,
  createTransitionDirector,
  composeFrame,
  MOMENT_TIMINGS,
  DRAMATIC_TRANSITIONS,
  REDUCED_MOTION_MAX_MS,
  OVERRIDE_DURATION_MAX_MS,
  TRANSITION_PRESETS,
  TRANSITION_PRESET_IDS,
  DEFAULT_PRESET,
  summarisePreset,
} from '../scene-transition.js';
import { describeEffectSettings, GLOBAL_SETTING_KEYS } from '../../effects/effect-settings.js';

const FOUNDRY = ['fade', 'swirl', 'dots', 'glitch'];

export async function run(t) {
  const { ok } = t;

  // ---- the default -----------------------------------------------------------
  const floor = planTransition({ moment: 'floor' });
  ok('a floor change defaults to a fade through black', floor.kind === 'fade' && floor.color === '#000000');
  ok('…and a QUICK one: 0.25 s out, 0.35 s in', floor.outMs === 250 && floor.inMs === 350);
  ok('…from the default, not some override', floor.source === 'default');
  const scene = planTransition({ moment: 'scene' });
  ok(
    'a scene change defaults to a LONG fade through black',
    scene.kind === 'fade' && scene.outMs === 1200 && scene.inMs === 1600
  );
  ok('a first load uses the same long fade', planTransition({ moment: 'load' }).inMs === MOMENT_TIMINGS.load.fade.inMs);
  ok(
    'a floor is always quicker than a scene, whatever the style',
    MOMENT_TIMINGS.floor.dissolve.inMs < MOMENT_TIMINGS.scene.dissolve.inMs
  );

  // ---- the preset list (author, 2026-10-26: at least four, quick and simple -> long and dramatic) ----
  ok('there are at least four presets', TRANSITION_PRESET_IDS.length >= 4);
  ok(
    'the default preset exists and is the Cinematic fade',
    DEFAULT_PRESET === 'cinematic' && !!TRANSITION_PRESETS.cinematic
  );
  const sceneLength = (id) => summarisePreset(id).sceneMs;
  const listed = TRANSITION_PRESET_IDS.map(sceneLength);
  ok(
    'the list runs quick to dramatic: scene length never shrinks down the list',
    listed.every((ms, i) => i === 0 || ms >= listed[i - 1])
  );
  ok('…starting instant and ending long', listed[0] === 0 && listed[listed.length - 1] >= 4000);
  ok(
    'every preset names a label, a hint and all three moments',
    TRANSITION_PRESET_IDS.every((id) => {
      const q = TRANSITION_PRESETS[id];
      return q.label && q.hint && q.moments.load && q.moments.scene && q.moments.floor;
    })
  );
  ok(
    'a floor is never slower than a scene in ANY preset (dramatic never makes every floor a spectacle)',
    TRANSITION_PRESET_IDS.every((id) => summarisePreset(id).floorMs <= summarisePreset(id).sceneMs)
  );
  ok(
    '…and no floor change takes over a second at Measured pace',
    TRANSITION_PRESET_IDS.every((id) => summarisePreset(id).floorMs <= 1000)
  );
  for (const id of TRANSITION_PRESET_IDS) {
    for (const moment of ['load', 'scene', 'floor']) {
      const plan = planTransition({ moment, preset: id });
      if (!['cut', 'fade', 'dissolve', 'foundry'].includes(plan.kind) || plan.source !== 'default') {
        ok('preset ' + id + ' / ' + moment + ' plans cleanly', false);
      }
    }
  }
  ok('every preset plans cleanly at every moment', true);
  ok(
    "Pace scales the list's own summary",
    summarisePreset('cinematic', 'slow').sceneMs > summarisePreset('cinematic', 'brisk').sceneMs
  );
  ok('an unknown preset id is the default', planTransition({ moment: 'scene', preset: 'nope' }).inMs === 1600);
  const grandScene = planTransition({ moment: 'scene', preset: 'grand', foundryTypes: ['holeSwirl'] });
  ok(
    "Grand entrance plays Foundry's own swirl on a scene change",
    grandScene.kind === 'foundry' && grandScene.foundryType === 'holeSwirl'
  );
  const grandLoad = planTransition({ moment: 'load', preset: 'grand', foundryTypes: ['holeSwirl'] });
  ok('…and on a first load', grandLoad.kind === 'foundry');
  ok(
    '…but a floor change stays a brisk fade',
    planTransition({ moment: 'floor', preset: 'grand', foundryTypes: ['holeSwirl'] }).kind === 'fade'
  );
  const grandNoFoundry = planTransition({ moment: 'scene', preset: 'grand', foundryTypes: [] });
  ok(
    '…and where Foundry lacks the swirl it is a long fade instead',
    grandNoFoundry.kind === 'fade' && grandNoFoundry.foundryType === null && grandNoFoundry.inMs === 3500
  );

  // ---- pace and style ----------------------------------------------------------
  ok(
    'Slow stretches every duration',
    planTransition({ moment: 'scene', pace: 'slow' }).inMs === Math.round(1600 * 1.6)
  );
  ok('Brisk shortens it', planTransition({ moment: 'floor', pace: 'brisk' }).outMs === Math.round(250 * 0.6));
  ok('an unknown pace is Measured', planTransition({ moment: 'scene', pace: 'warp' }).inMs === 1600);
  const cut = planTransition({ moment: 'scene', preset: 'cut' });
  ok('Cut means nothing in between', cut.kind === 'cut' && cut.outMs === 0 && cut.inMs === 0);
  const dissolve = planTransition({ moment: 'floor', preset: 'dissolve' });
  ok('Dissolve has no dimming half', dissolve.kind === 'dissolve' && dissolve.outMs === 0 && dissolve.inMs === 450);

  // ---- the Foundry settings dialog lists the SAME presets, in the same order ----
  const presetSetting = describeEffectSettings([]).find((d) => d.key === GLOBAL_SETTING_KEYS.transitionPreset);
  ok(
    "the setting's choices are exactly the presets, quick to dramatic",
    Object.keys(presetSetting?.choices ?? {}).join() === TRANSITION_PRESET_IDS.join()
  );
  ok(
    '…with the same labels',
    TRANSITION_PRESET_IDS.every((id) => presetSetting.choices[id] === TRANSITION_PRESETS[id].label)
  );
  ok('…and the same default', presetSetting?.default === DEFAULT_PRESET);

  // ---- the scene's own Foundry setting -------------------------------------------
  const swirl = { type: 'swirl', durationMs: 2000, activeOnly: false, sceneActive: false };
  const fromScene = planTransition({ moment: 'scene', sceneTransition: swirl, foundryTypes: FOUNDRY });
  ok(
    'a scene with its own Foundry transition plays it',
    fromScene.kind === 'foundry' && fromScene.foundryType === 'swirl'
  );
  ok('…for the duration the scene asked for', fromScene.inMs === 2000 && fromScene.source === 'scene');
  ok(
    '…on a first load into that scene too',
    planTransition({ moment: 'load', sceneTransition: swirl, foundryTypes: FOUNDRY }).foundryType === 'swirl'
  );
  ok(
    '…but never on a floor change (Foundry does not either)',
    planTransition({ moment: 'floor', sceneTransition: swirl, foundryTypes: FOUNDRY }).kind === 'fade'
  );
  ok(
    'a scene with NO transition set uses the MSA default',
    planTransition({ moment: 'scene', sceneTransition: { type: null }, foundryTypes: FOUNDRY }).source === 'default'
  );
  const fadeScene = planTransition({
    moment: 'scene',
    sceneTransition: { type: 'fade', durationMs: 900 },
    foundryTypes: FOUNDRY,
  });
  ok(
    'Foundry\'s own "fade" (a cross-fade) plays as MSA\'s dissolve',
    fadeScene.kind === 'dissolve' && fadeScene.inMs === 900
  );
  const activeOnly = { type: 'dots', durationMs: 1500, activeOnly: true, sceneActive: false };
  ok(
    '"active only" is honoured: not active, not played',
    planTransition({ moment: 'scene', sceneTransition: activeOnly, foundryTypes: FOUNDRY }).source === 'default'
  );
  ok(
    '…active, played',
    planTransition({ moment: 'scene', sceneTransition: { ...activeOnly, sceneActive: true }, foundryTypes: FOUNDRY })
      .foundryType === 'dots'
  );
  ok(
    'a type no longer in the catalogue (module removed) falls back to the default',
    planTransition({ moment: 'scene', sceneTransition: { type: 'gone' }, foundryTypes: FOUNDRY }).source === 'default'
  );

  // ---- the armed override --------------------------------------------------------
  const armed = planTransition({
    moment: 'scene',
    override: { type: 'dipWhite', durationMs: 4000 },
    sceneTransition: swirl,
    foundryTypes: FOUNDRY,
  });
  ok(
    'an armed override beats the scene setting (the author: "not a specific moment transition")',
    armed.source === 'override'
  );
  ok('…dip to white is a white fade', armed.kind === 'fade' && armed.color === '#ffffff');
  ok('…spread over the duration the GM chose', armed.outMs + armed.inMs === 4000);
  ok(
    '…and keeps its own out/in balance',
    armed.outMs / armed.inMs === DRAMATIC_TRANSITIONS.dipWhite.outMs / DRAMATIC_TRANSITIONS.dipWhite.inMs
  );
  ok(
    'an armed override never applies to a floor change',
    planTransition({ moment: 'floor', override: { type: 'dipWhite' } }).source === 'default'
  );
  const armedFoundry = planTransition({
    moment: 'scene',
    override: { type: 'glitch', durationMs: 3000 },
    foundryTypes: FOUNDRY,
  });
  ok(
    'a Foundry effect can be armed',
    armedFoundry.kind === 'foundry' && armedFoundry.foundryType === 'glitch' && armedFoundry.inMs === 3000
  );
  ok(
    "an armed duration is clamped to Foundry's own range",
    planTransition({ moment: 'scene', override: { type: 'glitch', durationMs: 999999 }, foundryTypes: FOUNDRY })
      .inMs === OVERRIDE_DURATION_MAX_MS
  );
  ok(
    'an armed type nobody knows is ignored',
    planTransition({ moment: 'scene', override: { type: '???' } }).source === 'default'
  );

  // ---- reduced motion ------------------------------------------------------------
  const calm = planTransition({
    moment: 'scene',
    reducedMotion: true,
    override: { type: 'glitch' },
    foundryTypes: FOUNDRY,
  });
  ok('reduced motion turns a moving effect into a fade', calm.kind === 'fade' && calm.foundryType === null);
  ok('…no longer than a blink', calm.outMs <= REDUCED_MOTION_MAX_MS && calm.inMs <= REDUCED_MOTION_MAX_MS);
  ok('…and never a white flash', calm.color === '#000000');
  ok('a cut stays a cut', planTransition({ moment: 'scene', preset: 'cut', reducedMotion: true }).kind === 'cut');

  // ---- Node safety ----------------------------------------------------------------
  ok(
    'composeFrame without a document is null, never a throw',
    composeFrame([null], { width: 10, height: 10 }) === null
  );
  const d = createTransitionDirector({ resolveHost: () => null });
  let threw = false;
  try {
    await d.cover(planTransition({ moment: 'floor' }));
    await d.reveal();
    d.abort('test');
  } catch (_) {
    threw = true;
  }
  ok('the director runs without a DOM and never throws', threw === false && d.isCovering() === false);
  ok('…and counts what it was asked to do', d.getStatus().covers === 1 && d.getStatus().reveals === 1);
}
