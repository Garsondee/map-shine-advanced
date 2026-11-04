# Video capture — hitch-free map videos

Renders map showcase videos **offline**, frame by frame, so no hitch, compile
or GC pause can ever reach the video. Built 2026-11-04 for the author's
per-map YouTube videos (4K, 60 fps).

## How it works

- `MapShine.capture` (module side, `src/vt/vt-pan-viewer.js` `captureBegin` /
  `captureFrame` / `captureEnd`) stops the live render loop and puts time on
  the **capture clock** (`src/core/frame-clock.js`). Every sanctioned clock —
  `perfNowMs()`, `wallClockMs()`, the frame clock, tile motion — then reads the
  video's time, which only moves when a frame is drawn.
- Per frame: the tool moves Foundry's camera to where the shot says it is at
  that instant; MSA waits, **without moving time**, until everything the view
  needs is loaded and compiled (and Dynamic Range's meter reading has landed);
  then time steps by exactly 1/fps and the frame is drawn.
- Each shot starts by snapping exposure to the opening view and rolling 1.5 s
  of unrecorded **pre-roll**, so smoke, rain and particles are in their steady
  state when the shot begins.
- The frame goes from the GPU canvas straight into Chrome's hardware H.264
  encoder (WebCodecs); the tool only remuxes the stream into an `.mp4` with
  ffmpeg (no re-encode).

Use a **private** Foundry: capture stops the live loop for whoever is watching.

## Use

```
node tools/video-capture/record.mjs boot --url http://localhost:30060 --cdp 9360
node tools/video-capture/record.mjs run  --plan plan.json --out out/my-map --cdp 9360
```

`boot` opens Chrome at 3840x2160 (device scale 1), logs in as Gamemaster and
stays running; `run` renders every shot in the plan to `<out>/<shot>.mp4` plus
`<shot>.frames.json` (per-frame world time, camera, wait counts). The plan
format is in the header of `record.mjs`. ffmpeg is found in imageio-ffmpeg's
Python package, or pass `--ffmpeg <path>`.

## Making a map video (the workflow, 2026-11-04)

1. `record.mjs survey --out survey.json` — scene rect, levels, backgrounds, lights.
2. Write `plan.json`: shots with `level`, `keys` (t/x/y/scale), `seconds`, `easing`,
   `sunHour` (a number, or `[from, to]` for a time-lapse), `weather` (an archetype, or
   `{from, to}` blended per video frame), `weatherAxes` (per-axis override), `wind`,
   `caption`, `preRollSec`, optional `setup` (page script). Plan-level `titles` and
   `transition`. Keys are pulled in so a frame never films off the map.
3. `python storyboard.py --plan plan.json --survey survey.json --data <Foundry Data> --out storyboard`
   — paths + first/last frames on the albedo, coverage at readable zoom (green/red),
   timeline with sky colour, and an albedo contact sheet of every shot.
4. `record.mjs run --plan plan.json --out render --stills` then `python stills_sheet.py render --plan plan.json`
   — the REAL look (lighting, weather, time of day) of every shot's start/middle/end in
   ~10 s per shot. This is where lighting problems show up, before a long render.
5. `record.mjs run --plan plan.json --out render [--only <shot>]` — the 4K60 shots.
6. `node assemble.mjs --plan plan.json --dir render --out final.mp4` — fades, captions, titles.

Big Bank's plan is in `Mythica Machina Press/map-videos/big-bank/`.

## Measured (Big Bank, RX 6800 XT, 2026-11-04)

- 4 s shot, 3840x2160, native render scale: **~90 ms per frame** (21 s to
  render 4 s), H.264 High 4K60, ~51 Mbps.
- Every frame's world step exactly 1/60 s (dt min/max 0.0166667).
- Freeze test: the same shot with a 500 ms main-thread freeze every 20 frames
  vs a clean run — 0 duplicate frames in either, camera motion differs by at
  most 0.08 px/frame, frame-to-frame pixel difference between the two runs
  0.81 after a freeze vs 0.81 elsewhere (no trace of the freezes).
- The same pan played live in the capture browser: 38-44 fps, frames up to
  76 ms apart, at half internal resolution (render scale "auto").

## Known limits

- Async work that lands on real time, not video time, is only partly fenced:
  the Dynamic Range meter is awaited; fog-memory readback, the rain-field
  worker and other async GPU readbacks are not (no visible effect found on
  Big Bank).
- Tile motion follows video time through `captureDriftMs()`; not yet checked
  on a map with motion tiles.
- Foundry's own canvas (tokens' HUD, door icons) is not in the video — only
  MSA's canvas is captured.
