---
trigger: always_on
---

Particle systems from luminance masks:
When creating any new mask-driven particle system (fire, smoke, water, etc.), first look at 
FireSparksEffect
 + the particle vertex shader. Always use the Lookup Map technique:

CPU: scan the _X mask once, collect bright pixels as normalized UVs + brightness, pack them into a THREE.DataTexture (position map).
GPU: sample this position map (uXPositionMap) in the vertex shader to place particles; never do per-frame rejection sampling against the mask._