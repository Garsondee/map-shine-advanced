# Pan smoothness — measuring how evenly the camera moves

Built 2026-11-04, when the author saw live pans (and her own screen recordings) move
"not quite smoothly" while still frames looked fine.

```
node tools/video-capture/record.mjs boot --url http://localhost:30060 --cdp 9360 --width 1920 --height 1080
node tools/pan-smoothness/measure.mjs --mode drag --effects off --smooth off --runs 3
node tools/pan-smoothness/measure.mjs --mode drag --effects on  --smooth on --pacing auto --runs 3
```

`measure.mjs` drives a real pan in a private Foundry (right-drag through Chrome's own
input pipeline, a held arrow key with Windows-rate auto-repeat, or an "ideal" camera
set once per frame from the frame's own time) and records, on every frame the screen
shows, the camera Foundry handed MSA. It reads on Foundry's ticker AFTER Foundry's own
camera updates — where MSA reads it — not in a plain rAF callback (that runs before
the ticker and sees every ticker-driven move a frame late). Options: `--effects off`
(every MSA effect forced off for the run), `--smooth on|off` (`MapShine.setSmoothPan`),
`--pacing off|auto|1..4` (`MapShine.setFramePacing`), `--profile x.cpuprofile`
(V8 profile of the last run + top self-time list), `--out r.json` (+ per-run rows).

Reported: `stepCvPct` (spread of each frame's camera step around its due step, 0 =
perfect), `holds` (frames the camera froze mid-pan), `doubles` (catch-up jumps),
`wobblePx` (screen px off a straight line through time), `frameMs` (drawn-frame
interval mean / spread / worst).

## What it found (Big Bank, 144 Hz, 1920x1080)

| | step spread | frozen / jump frames | wobble |
|---|---|---|---|
| Drag, Foundry as it is (effects on) | 105-110% | 40 / 38-41 | 16-18 px |
| Drag, smooth pan | 19% | 0 / 0 | 3.1-3.3 px |
| Drag, smooth pan + Even pacing (auto, 3 refreshes) | 8-11% | 0 / 0 | 1.9-2.4 px |
| Held arrow key, Foundry (effects on) | 60-66% | 7 / 13-23 | 7.6-9.7 px |
| Held arrow key, glide | 0.5-0.9% (+ Even) | 0 / 0 | 0.3-0.45 px |

Three causes, in order of size:

1. **Foundry's drag throttle** (`MouseInteractionManager#handlePointerMove`) compares a
   whole-millisecond `Date.now()` step with the last tick's length and throws the move
   away if it is shorter: a third of a fast drag's frames, camera frozen then doubled.
   Fixed in `src/foundry/smooth-pan.js` (the board's manager only).
2. **Held arrow keys** start a new 100 ms ease-in-out `animatePan` on every key repeat,
   so the camera speeds up and slows down ~30 times a second. Replaced (after the
   first, unchanged one-grid step) by a constant-speed glide on Foundry's ticker.
3. **Uneven frame pacing.** When MSA cannot draw every refresh, frames stay on screen
   for 1, 2 or 3 refreshes in no pattern; even camera motion lands on screen unevenly.
   `src/core/frame-pacer.js` + the client setting *Map Shine — Frame pacing* (default
   Off): draw on every Nth refresh, Foundry's canvas gated on the same frames.

With all effects off the picture is the same (causes 1 and 2 do not depend on load;
3 shrinks as frames get cheaper). The CPU profile of a pan is flat — no single
function to blame; the main thread is ~98% busy, 44% of it in the browser's own
native work (WebGPU submission, compositing).
