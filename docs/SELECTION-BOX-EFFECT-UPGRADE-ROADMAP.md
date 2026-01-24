# Selection Box Effect: Upgrade Roadmap

This document tracks aesthetic, functional, and technical upgrade ideas for `SelectionBoxEffect`.

## Module A: Border & Stroke Esthetics

Focus on the immediate visual definition of the selection area.

- [ ] Electric Arc Border: Replace the solid line with a jagged, lightning-like SVG path that jitters rapidly.
- [ ] Gradient Stroke: Apply an SVG linear gradient to the stroke that rotates over time (e.g., Cyan to Magenta loop).
- [ ] "Tech" Brackets: Instead of a full box, only render the four corners with thick, L-shaped brackets.
- [ ] Reticle Crosshairs: Add faint crosshair lines extending from the center of the selection box to the edges of the screen.
- [ ] Hand-Drawn Sketch: Use feTurbulence or multiple offset stroke paths to make the box look like a pencil sketch on paper.
- [ ] Double Offset Border: Render two borders—one solid, one dashed—offset by a few pixels, animating in opposite directions.
- [ ] Neon Bloom: Increase the glow intensity significantly and add a white core to the stroke to simulate a neon tube.
- [ ] Chromatic Aberration Stroke: Render three strokes (R, G, B) slightly offset from each other; increase the offset based on drag speed.
- [ ] Rope/Chain Pattern: Use a complex SVG pattern along the path to simulate a chain or rope enclosing the units.

## Module B: Fill & Interior Shaders

Focus on what happens inside the box.

- [ ] Glassmorphism (Backdrop Filter): Apply `backdrop-filter: blur(4px)` to the overlay (if supported) to blur the game world inside the selection.
- [ ] Scanline Sweep: An animated horizontal bar that scans up and down within the box selection.
- [ ] Hexagonal Forcefield: A honeycomb pattern that fades in and out, shifting intensity as the box grows.
- [ ] Heat Haze Distortion: Use a WebGL refractor shader in the background to warp the ground terrain inside the selection box.
- [ ] Radar Sweep: A radial gradient that spins around the center of the box (sonar style).
- [ ] Vignette Interior: Darken the edges inside the box slightly to draw focus to the center.
- [ ] Pixelation Filter: Block-out/pixelate the rendering of the scene strictly inside the selection rectangle.
- [ ] Data Rain: Faint binary numbers or matrix-style characters falling vertically within the selection bounds.

## Module C: Quark Particle Integration

Leveraging the particle engine to add "juice".

- [ ] Cursor Sparkles: Emit small sparks from the mouse cursor position as it drags the box.
- [ ] Corner Emitters: Attach particle emitters to the four corners of the box, leaving a trail of "dust" or "energy" as the box expands.
- [ ] Implosion Effect: Upon releasing the mouse (completing selection), trigger a particle burst that sucks inward toward the center of the selected group.
- [ ] Ground Scorch: Leave temporary darkened particle decals on the terrain along the perimeter of the drag.
- [ ] Selection "Links": Draw particle lines connecting the selection box center to every valid unit captured inside.
- [ ] Rising Bubbles: If the theme allows, emit slow-moving bubbles or floating shapes from the area covered by the selection.
- [ ] Static Discharge: Random lightning-bolt particles zapping between the corners of the box.

## Module D: World-Space & 3D Projections

Enhancing the connection between the 2D UI and the 3D scene.

- [ ] Volumetric Prism: Instead of a flat shadow, render a semi-transparent 3D cube or prism that rises from the ground to a fixed height.
- [ ] Terrain Contour Mapping: Use a shader on the shadow mesh that projects grid lines which conform to the height/slope of the terrain (like a topographic map).
- [ ] Spotlight Projection: Instead of a shadow, cast a bright spotlight from the camera onto the terrain within the selection bounds.
- [ ] Wall Projection: Render vertical "laser walls" rising from the selection perimeter, fading out at the top.
- [ ] Grass Interaction: Use the shadow mesh position to push vertex-displaced grass or foliage away from the selection area.
- [ ] Grid Snapping Visuals: If the game uses a grid, highlight the specific grid cells fully contained within the box rather than the smooth box itself.

## Module E: Animation Dynamics

Improving the "feel" and physics of the interaction.

- [ ] Elastic Drag: Make the visual box slightly "lag" behind the mouse cursor using spring physics, then snap to the cursor when stopped.
- [ ] Impact Ripple: When the user clicks to start dragging, spawn a shockwave ripple effect on the screen or ground.
- [ ] Release Snap: Flash the box white or gold for one frame when the mouse is released to confirm visual capture.
- [ ] Pulse-on-Capture: Trigger a rapid pulse animation specifically when a new unit enters the selection bounds during the drag.
- [ ] Dash Speed Velocity: Scale the speed of the "marching ants" animation based on how large the selection box is (faster = larger).
- [ ] Heartbeat: Scale the selection box opacity up and down rhythmically (breathing effect) if the user holds the drag for a long time.

## Module F: UI & Information Feedback

Making the box smarter and more informative.

- [ ] Unit Counter: Display a dynamic number in the center or corner of the box showing `[ 12 Units ]` currently selected.
- [ ] Resource Sum: If selecting resource nodes, sum up the total value (e.g., `500 Gold`) and display it next to the cursor.
- [ ] Team Color Coding: Change the color of the box dynamically based on the faction of units being selected (e.g., Green for allies, Red for enemies).
- [ ] Smart Label Positioning: Ensure the label (width × height) never goes off-screen by clamping it to the viewport edges.
- [ ] Exclusion Mode: If the user holds Shift or Ctrl, change the box style to "destructive" (Red, jagged lines) to indicate deselection.
- [ ] Formation Preview: Project 'ghost' dots on the ground showing where the selected units will move if a command were issued immediately.

## Module G: Audio & Haptics (Vibes)

Multisensory feedback.

- [ ] Dynamic Hum: Play a low synthesizer hum that rises in pitch as the selection box area gets larger.
- [ ] Click & Release SFX: Distinct "tech click" sound on mouse down, and a "confirmation chime" on mouse up.
- [ ] Capture Tick: Play a very faint "tick" sound every time a unit is added to the selection array during the drag.
- [ ] Haptic Feedback: If on a supported device (gamepad/mobile), vibrate slightly when the selection box crosses over a unit.

## Module H: Technical Optimizations & Refactoring

Housekeeping for the new features.

- [ ] Shader Uniform Pooling: Ensure the shadow mesh shares uniforms with other UI elements to reduce draw calls.
- [ ] Instanced Rendering: If using 3D corners or wall segments, use `InstancedMesh` rather than creating new geometries.
- [ ] DOM Reduction: Move the label from a DOM node to a text texture on the 3D plane to reduce HTML overhead.
- [ ] CSS Hardware Acceleration: Ensure `will-change: transform, opacity` is set on the overlay elements to prevent repaints.
