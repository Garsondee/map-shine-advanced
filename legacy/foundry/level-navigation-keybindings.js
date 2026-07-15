/**
 * @fileoverview Foundry keybinding registration for level navigation.
 */

import { createLogger } from '../core/log.js';

const log = createLogger('LevelNavigationKeybindings');

const LEVEL_STEP_ACTIONS = [
  {
    actionId: 'level-step-down',
    name: 'Level Navigator: Step Down',
    hint: 'Step one level down. If Follow Token mode is active, this switches to Manual first.',
    defaultKey: 'BracketLeft',
    delta: -1,
    reason: 'keybinding-step-down',
  },
  {
    actionId: 'level-step-up',
    name: 'Level Navigator: Step Up',
    hint: 'Step one level up. If Follow Token mode is active, this switches to Manual first.',
    defaultKey: 'BracketRight',
    delta: 1,
    reason: 'keybinding-step-up',
  },
];

function isEditableTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""], .tox, .editor');
}

function _resolveEventFromBindingContext(context) {
  if (!context) return null;
  if (context instanceof KeyboardEvent) return context;
  if (context?.event instanceof KeyboardEvent) return context.event;
  return null;
}

function _stepLevel(delta, reason, context) {
  const event = _resolveEventFromBindingContext(context);
  if (event?.defaultPrevented) return false;
  if (event && (event.ctrlKey || event.metaKey || event.altKey)) return false;
  if (isEditableTarget(event?.target)) return false;

  const controller = window.MapShine?.levelNavigationController;
  if (!controller?.stepLevel) return false;

  if (controller.getLockMode?.() === 'follow-controlled-token') {
    controller.setLockMode?.('manual', { emit: false, reason: `${reason}-manual` });
  }

  controller.stepLevel(delta, { reason });

  event?.preventDefault?.();
  event?.stopPropagation?.();
  event?.stopImmediatePropagation?.();

  return true;
}

/**
 * Register user-rebindable level stepping keybindings.
 * @param {string} moduleId
 */
export function registerLevelNavigationKeybindings(moduleId = 'map-shine-advanced') {
  const keybindingsApi = game?.keybindings;
  if (!keybindingsApi?.register) {
    log.warn('Cannot register level navigation keybindings: game.keybindings API unavailable');
    return;
  }

  for (const action of LEVEL_STEP_ACTIONS) {
    keybindingsApi.register(moduleId, action.actionId, {
      name: action.name,
      hint: action.hint,
      editable: [{ key: action.defaultKey }],
      restricted: false,
      onDown: (context) => _stepLevel(action.delta, action.reason, context),
    });
  }

  log.info('Registered level navigation keybindings');
}
