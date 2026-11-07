# What may differ between players (mmp-463.1)

The multiplayer parity suite (`parity-run.mjs`) compares every client's `MapShine.test.digest()`.
This page is the contract it checks against: everything in **Must match** is in the digest's
`shared` block and its hash; everything in **May differ** is either in `perClient` or not in the
digest at all. Written 2026-11-07; change it when a new kind of state is added.

## Must match on every client

| What | Digest field | Why it must match |
|---|---|---|
| Scene and level being shown | `sceneId`, `levelId` | Everyone is at the same place. (A player viewing another scene is a GM choice and a separate case.) |
| World time, pause | `worldTime`, `paused` | Foundry syncs it; MSA's sun follows it. |
| Time of day and sun | `todHour`, `sun.azimuthDeg`, `sun.elevationDeg` | Shadows, golden hour and window light must agree. |
| Scene darkness | `darkness` | Foundry's own darkness, folded once in `world/environment.js`. |
| Weather mode, preset, targets and eased state | `weather.*` | The GM's sky. Eased values may lag on a late joiner for up to the ease time (tau ~20 s): the harness waits a grace period. |
| Wind direction, speed, gustiness | `wind.*` | Saved to scene flags by `MapShine.setWind`. |
| Light documents | `lights[]` | Positions, radii, colours, animation types. |
| Effects the GM switched on or off | `effectsEnabled` | World settings (`<effect>.gmEnable`). |
| Look | `look` | When Looks expose a current id. |

## May differ (by design)

| What | Where | Why |
|---|---|---|
| User, GM or player | `perClient.user`, `perClient.isGM` | Identity. |
| What a token can see | not in the digest | Vision, fog of war and explored areas are per user (Foundry's own rule). Screenshots differ here; the digest does not. |
| Camera position and zoom | `perClient.camera` | Each player pans independently. |
| Performance profile and render scale | `perClient.profile`, `perClient.renderScale` | Hardware differs; effects may run at a lower tier. |
| Photosensitive and other accessibility locks | not in the digest | A player's own safety settings (lightning flashes, strobing lights). |
| A player's own effect override (`<effect>.playerEnable`) | not in the digest | A client setting, by design. |
| Cloud positions (drift) | `perClient.cloudDrift` | Ingram's ruling 2026-09-06: clouds are only an effect; each client drifts its own deck, so cloud shadows can sit in different places for different players (measured 2026-11-07). Decision bead to revisit. |
| Particle positions, grain, per-frame noise | not in the digest | Random per client; the look is the same, the dots are not. |
| UI panels (Remote, Studio, sidebars) | not in the digest | GM-only UI. |

## Known gap found while writing this (2026-11-07)

`MapShine.setWeatherArchetype(...)` is a LOCAL console lever: it is never saved or broadcast, so
players never see it. Scripts and tests must use `MapShine.fadeWeatherToArchetype(id, ms)` (the
Remote's own synced path). Found by the first parity run.
