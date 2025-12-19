---
trigger: always_on
---

MapShine coordinates:
- Foundry docs use top-left origin, Y-down. Three world uses bottom-left origin, Y-up.
- Convert via Coordinates.toWorld(x,y) => (x, canvas.dimensions.height - y). Inverse via Coordinates.toFoundry.
- Tokens/tiles docs are top-left anchored: place meshes at doc center (x+width/2, y+height/2) then invert Y.
 
Scene mapping:
- Distinguish canvas.dimensions (includes padding) vs canvas.dimensions.sceneRect (actual map).
- For world→mask UV, use uSceneBounds=(sceneX,sceneY,sceneW,sceneH) and flip V: v=1-(y-sceneY)/sceneH.
- For screen-space post FX, reconstruct world XY using uViewBounds=(minX,minY,maxX,maxY): threeXY=mix(bounds, vUv). Convert to Foundry with foundryY=uSceneDimensions.y-threeY.
 
Masks:
- Outdoors/roof map (_Outdoors) is world-space sampled using uSceneBounds + Y flip.
- Roof alpha target is screen-space sampled in screen UV (vUv or gl_FragCoord/uScreenSize). Don’t mix them.
 
Stability:
- Any “length” offsets in post shaders must be in pixels then multiplied by uTexelSize to be resolution/aspect independent.
- For perspective camera zoom, use sceneComposer.currentZoom (FOV-based), not camera.zoom.
 
Layering:
- Use small Z offsets from groundZ + elevation and renderOrder; disable depth only when the layer is intended as an overlay above roofs.