/**
 * @fileoverview Scene controls UI integration
 * Adds Map Shine controls to Foundry's scene control palette
 * @module foundry/scene-controls
 */

import { createLogger } from '../core/log.js';

const log = createLogger('SceneControls');

/**
 * Open the Map Shine diagnostic dialog programmatically
 * @public
 */
export function openDiagnosticPanel() {
  try {
    showDiagnosticDialog();
  } catch (e) {
    log.error('Failed to open diagnostic panel:', e);
  }
}

/**
 * Show diagnostic information dialog
 * @private
 */
function showDiagnosticDialog() {
  const mapShine = window.MapShine;
  const scene = canvas?.scene;
  
  // Gather diagnostic info
  const info = {
    moduleInitialized: mapShine?.initialized || false,
    rendererType: mapShine?.rendererType || 'none',
    gpuTier: mapShine?.capabilities?.tier || 'unknown',
    sceneEnabled: scene ? (scene.getFlag('map-shine-advanced', 'enabled') || false) : false,
    sceneBackground: scene?.background?.src || 'none',
    threeJsLoaded: !!window.THREE,
    canvasReady: !!canvas?.ready
  };

  // Get asset bundle info if available
  let assetInfo = 'N/A';
  if (canvas?.mapShine?.sceneComposer?.currentBundle) {
    const bundle = canvas.mapShine.sceneComposer.currentBundle;
    assetInfo = `
      <li><strong>Base Path:</strong> ${bundle.basePath}</li>
      <li><strong>Masks Found:</strong> ${bundle.masks.length}</li>
      <li><strong>Mask Types:</strong> ${bundle.masks.map(m => m.id).join(', ') || 'none'}</li>
    `;
  }

  const content = `
    <h2>Map Shine Advanced - Diagnostic Info</h2>
    <hr>
    <h3>Module Status</h3>
    <ul>
      <li><strong>Initialized:</strong> ${info.moduleInitialized ? '✓ Yes' : '✗ No'}</li>
      <li><strong>Renderer:</strong> ${info.rendererType}</li>
      <li><strong>GPU Tier:</strong> ${info.gpuTier}</li>
      <li><strong>three.js Loaded:</strong> ${info.threeJsLoaded ? '✓ Yes' : '✗ No'}</li>
    </ul>
    <hr>
    <h3>Current Scene</h3>
    <ul>
      <li><strong>Scene Name:</strong> ${scene?.name || 'None'}</li>
      <li><strong>Map Shine Enabled:</strong> ${info.sceneEnabled ? '✓ Yes' : '✗ No'}</li>
      <li><strong>Background Image:</strong> ${info.sceneBackground}</li>
      <li><strong>Canvas Ready:</strong> ${info.canvasReady ? '✓ Yes' : '✗ No'}</li>
    </ul>
    <hr>
    <h3>Asset Loading</h3>
    <ul>
      ${assetInfo}
    </ul>
    <hr>
    <p><strong>Console Commands:</strong></p>
    <pre style="background: #f5f5f5; padding: 10px; margin: 5px 0; overflow-x: auto;">` +
`// Full diagnostic check
(() => {
  const ms = MapShine;
  const rl = ms?.renderLoop;
  const sc = ms?.sceneComposer;
  return {
    renderLoopExists: !!rl,
    renderLoopRunning: rl?.running(),
    frameCount: rl?.getFrameCount() || 0,
    fps: rl?.getFPS() || 0,
    sceneChildren: sc?.scene?.children?.length || 0,
    basePlanePresent: !!sc?.basePlaneMesh,
    cameraPosition: [
      sc?.camera?.position?.x,
      sc?.camera?.position?.y,
      sc?.camera?.position?.z
    ]
  };
})()

// Check canvas rendering
(() => {
  const c = document.getElementById('map-shine-canvas');
  const ctx = c?.getContext('webgl2') || c?.getContext('webgl');
  return {
    exists: !!c,
    size: \`\${c?.width}x\${c?.height}\`,
    hasWebGL: !!ctx,
    clearColor: ctx?.getParameter(ctx.COLOR_CLEAR_VALUE)
  };
})()

// Force a test render
(() => {
  MapShine.renderer?.render(
    MapShine.sceneComposer?.scene,
    MapShine.sceneComposer?.camera
  );
  return 'Test render triggered';
})()` +
`</pre>
  `;

  new Dialog({
    title: 'Map Shine Advanced - Diagnostic Information',
    content: content,
    buttons: {
      copy: {
        icon: '<i class="fas fa-clipboard"></i>',
        label: 'Copy to Console',
        callback: () => {
          console.log('=== Map Shine Diagnostic Info ===');
          console.log('Module:', info);
          console.log('MapShine State:', mapShine);
          console.log('Scene:', scene);
          console.log('================================');
          ui.notifications.info('Diagnostic info logged to console');
        }
      },
      close: {
        icon: '<i class="fas fa-times"></i>',
        label: 'Close'
      }
    },
    default: 'close'
  }, {
    width: 600
  }).render(true);

  log.info('Diagnostic dialog shown');
}

/**
 * Toggle Map Shine effects on/off
 * @param {boolean} enabled - Whether effects should be enabled
 * @private
 */
function toggleEffects(enabled) {
  const scene = canvas?.scene;
  if (!scene) {
    ui.notifications.warn('No active scene');
    return;
  }

  // Toggle the scene flag
  scene.setFlag('map-shine-advanced', 'enabled', enabled);
  
  if (enabled) {
    ui.notifications.info('Map Shine effects enabled - reload scene to see changes');
    log.info('Effects enabled for scene:', scene.name);
  } else {
    ui.notifications.info('Map Shine effects disabled - reload scene to see changes');
    log.info('Effects disabled for scene:', scene.name);
  }
}
