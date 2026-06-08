/**
 * @fileoverview Foundry client/world settings for Tweakpane UI state.
 * Kept separate from tweakpane-manager.js so init can register settings without
 * loading the full UI module graph (avoids circular-import races at startup).
 * @module ui/register-ui-settings
 */

import { createLogger } from '../core/log.js';

const log = createLogger('UI');

/**
 * Register UI settings with Foundry.
 * Should be called during the `init` hook.
 * @public
 */
export function registerUISettings() {
  game.settings.register('map-shine-advanced', 'ui-state', {
    name: 'UI State',
    hint: 'Stores UI panel position, scale, and accordion states',
    scope: 'client',
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register('map-shine-advanced', 'texture-manager-state', {
    name: 'Texture Manager State',
    scope: 'client',
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register('map-shine-advanced', 'effect-stack-state', {
    name: 'Effect Stack State',
    scope: 'client',
    config: false,
    type: Object,
    default: {}
  });

  game.settings.register('map-shine-advanced', 'rope-default-textures', {
    name: 'Rope Default Textures',
    scope: 'world',
    config: false,
    type: Object,
    default: {
      ropeTexturePath: 'modules/map-shine-advanced/assets/rope.webp',
      chainTexturePath: 'modules/map-shine-advanced/assets/rope.webp'
    }
  });

  game.settings.register('map-shine-advanced', 'rope-default-behavior', {
    name: 'Rope Default Behavior',
    scope: 'world',
    config: false,
    type: Object,
    default: {
      rope: {
        segmentLength: 12,
        damping: 0.98,
        windForce: 1.2,
        springConstant: 0.6,
        tapering: 0.55,
        width: 22,
        uvRepeatWorld: 64,
        ropeEndStiffness: 0.25
      },
      chain: {
        segmentLength: 22,
        damping: 0.92,
        windForce: 0.25,
        springConstant: 1.0,
        tapering: 0.15,
        width: 18,
        uvRepeatWorld: 48,
        ropeEndStiffness: 0.5
      },
      _lastRopeType: 'chain'
    }
  });

  log.info('UI settings registered');
}
