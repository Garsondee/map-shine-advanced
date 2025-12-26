// Paste this in the browser console (F12) to log current zoom when you press any key.
// Then take screenshots at "good zoomed in", "bad middle zoom", and "good zoomed out".
// The console will print the zoom values so you can share them with me.

document.addEventListener('keydown', () => {
  const zoom = window.MapShine?.sceneComposer?.currentZoom ?? 'unknown';
  console.log('Current zoom:', zoom);
});
