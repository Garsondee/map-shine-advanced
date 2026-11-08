---
sources: src/effects/grade/grade.js (exposure, exposureInside, exposureOutside, lightLevel), Remote Mix tab Night fader (boot.js weatherBoard.onNightDarknessCommit), src/effects/lighting/ambience-filter.js (scene Environment base/dark), src/foundry/scene-environment.js (readSceneAuthoredDarkness)
---
Players can't make out the room. Start with the first button, and press it again if you need more.

### Brighten everything

[[do: brighten, darken]]

Each press is one small step. Pressing **Darker** steps back the same amount.

### Only the rooms, or only outside

Map Shine knows which parts of the map have a roof over them. Brighten just one side and keep the mood of the other.

[[do: brighten-inside, brighten-outside]]

### Make the light stronger

If the room is dark because the light feels weak, strengthen the light instead of brightening the whole picture. This strengthens every light, the sun and the lamps alike, but places no light reaches stay dark.

[[do: lamps-up, lamps-down]]

### At night

Night darkness is its own fader. Lift it a little and the moon does more of the work.

[[do: night-lighter, night-darker]]

Is the art itself dim at night, not just the light? Foundry's scene settings have **Environment → Darkness → Luminosity**, which darkens the map as night falls (Foundry's default is -0.25). Map Shine follows it, as Foundry does. Raise it towards 0.

### Dark even at noon

Check the scene's **Darkness Level** in Foundry's scene settings. Map Shine follows it as Foundry does: the scene is never brighter than that level, whatever the clock says. Set it to 0 to let Map Shine's clock decide day and night on its own.

> [!note] Dark on one player's screen only? Their monitor or Foundry's own brightness setting may differ. Ask them to open **Performance & Graphics** from the scene controls on the left.

Want it to stay like this for every session? It already does. These changes are saved with the scene.
