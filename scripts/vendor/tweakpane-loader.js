/**
 * @fileoverview Tweakpane loader - imports ES module and exposes globally
 * @module vendor/tweakpane-loader
 */

console.log('Map Shine Advanced | Tweakpane Loader | LOADER EXECUTING');

try {
  const TweakpaneModule = await import('./tweakpane.js');
  console.log('Map Shine Advanced | Tweakpane Loader | Module imported successfully:', Object.keys(TweakpaneModule));

  // Expose Tweakpane globally for non-module code
  window.Tweakpane = TweakpaneModule;

  console.log('Map Shine Advanced | Tweakpane Loader | Exposed to window.Tweakpane');
  console.log('Map Shine Advanced | Tweakpane Loader | window.Tweakpane.Pane available:', typeof window.Tweakpane.Pane);
} catch (error) {
  console.error('Map Shine Advanced | Tweakpane Loader | FAILED TO IMPORT:', error);
  // Create a minimal fallback so the UI manager doesn't hang
  window.Tweakpane = null;
}
