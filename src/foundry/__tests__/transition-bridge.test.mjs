/**
 * foundry/transition-bridge.js — the parts that are plain data: reading Foundry's catalogue and a
 * scene's own transition setting. Playing an effect needs Foundry's PIXI canvas and is verified live.
 */
import {
  listFoundryTransitions,
  readSceneTransition,
  colorToNumber,
  playFoundryTransition,
  captureFoundryLayer,
  setFoundryTransitionLock,
} from '../transition-bridge.js';

export async function run(t) {
  const { ok } = t;

  const config = {
    Canvas: {
      sceneTransitions: {
        fade: { id: 'fade', label: 'SCENE.Transition.Types.fade', defaultDuration: 1500 },
        swirl: { id: 'swirl', label: 'SCENE.Transition.Types.swirl', defaultDuration: 2000 },
        moduleOne: { id: 'moduleOne', label: 'Module effect' },
      },
    },
  };
  const list = listFoundryTransitions(config, (k) => (k === 'SCENE.Transition.Types.swirl' ? 'Swirl' : null));
  ok(
    'every catalogue entry is listed, a module-added one included',
    list.map((e) => e.id).join() === 'fade,swirl,moduleOne'
  );
  ok('labels are localised where Foundry has a translation', list[1].label === 'Swirl');
  ok('…and fall back to the id, never to a raw i18n key', list[0].label === 'fade');
  ok('…or to a module label that is already plain text', list[2].label === 'Module effect');
  ok(
    'default durations come from Foundry, 1.5 s when a type gives none',
    list[1].defaultDurationMs === 2000 && list[2].defaultDurationMs === 1500
  );
  ok('no CONFIG means an empty list, not a throw', listFoundryTransitions(undefined).length === 0);

  const st = readSceneTransition({ active: true, transition: { type: 'dots', duration: 2500, activeOnly: true } });
  ok(
    "a scene's own setting is read as-is",
    st.type === 'dots' && st.durationMs === 2500 && st.activeOnly === true && st.sceneActive === true
  );
  ok(
    'an unset type is null ("the GM did not choose one")',
    readSceneTransition({ transition: { type: null, duration: 1500 } }).type === null
  );
  ok('no scene means no setting', readSceneTransition(null) === null);

  ok('colours convert for a PIXI tint', colorToNumber('#ffffff') === 0xffffff && colorToNumber('#000000') === 0);
  ok('…anything odd is black', colorToNumber('white') === 0 && colorToNumber(undefined) === 0);

  ok(
    'with no Foundry canvas, an effect reports it could not play',
    (await playFoundryTransition({ to: null, type: 'swirl', durationMs: 100 })) === false
  );
  ok('…capturing its layer gives null', captureFoundryLayer() === null);
  ok('…and the lock reports nothing to lock', setFoundryTransitionLock(true) === false);
}
