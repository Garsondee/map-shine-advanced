/**
 * ui/rooms/remote/tile-motion-panel.js — THE TILE MOTION PANEL (2026-08-27,
 * author live-testing round: "we need a proper button with a different icon
 * which opens up a dedicated UI... concise... which can be moved around and
 * minimised").
 *
 * REPLACES TWO PRIOR SURFACES, NOT A THIRD ONE ADDED ALONGSIDE THEM:
 *   - `ui/rooms/remote/tile-motion-popover.js` (deleted) — the Remote's own
 *     header-button popover, LANTERN-styled but fixed-position, no drag, no
 *     minimize. Its field-building logic is what this file is actually
 *     built from (every `numberInput`/`selectInput`/motion-type/pivot/
 *     texture-motion/transport section below is that file's own code,
 *     unchanged in substance — only the shell around it is new).
 *   - `ui/tile-motion-dialog.js` (deleted) — the OLDER dialog Studio's own
 *     Scene department "Open" button targeted, hardcoded hex colours, no
 *     LANTERN tokens, no drag, no minimize. Genuinely the same fields as
 *     the popover, hand-duplicated — exactly the kind of two-parallel-UIs
 *     drift this project's own doctrine warns against (Environment.md
 *     §2.4). One real implementation now; the Scene department's "Open"
 *     button and this file's own entry point both open THIS panel.
 *
 * A REAL ROOM SHELL, not a popover — draggable (`ui/widgets/draggable.js`,
 * the same shared implementation Remote/Studio/Player already use) and
 * minimizable (the identical `[data-minimized]` CSS contract those three
 * rooms already have), because a control surface an author reaches for
 * repeatedly across a session — arm a tile, watch it, tweak it, glance
 * away — earns the same "always reachable, never in the way" treatment
 * the Remote itself gets, not a one-shot form.
 *
 * Opened from the astrolabe's own BR corner (`astrolabe-panel.js`), which
 * used to carry a dead `status:'planned'` stub citing "Motion Tiles has no
 * src/ runtime yet" — stale as of TODAY (`foundry/tile-motion-runtime.js`
 * shipped this same session) — never from a Remote header icon.
 *
 * @module ui/rooms/remote/tile-motion-panel
 */

import {
  getTileMotionTileList,
  getTileMotionConfig,
  getTileMotionRestPose,
  getTileMotionRuntimeStatus,
  setTileMotionConfig,
  getTileMotionTransportState,
  startTileMotion,
  stopTileMotion,
  pauseTileMotion,
  resumeTileMotion,
  resetTileMotionPhase,
  setTileMotionSpeedPercent,
  setTileMotionTimeFactorPercent,
  setTileMotionAutoPlayEnabled,
  tileMotionWorldPointToLocalPivot,
  activateTileMotionNativeTool,
  watchTileMotionSelection,
  TILE_MOTION_ROTATION_EASING_TYPES,
} from '../../../foundry/index.js';
import { pickVtPanViewerWorldPoint } from '../../../vt/index.js';
import { installTokens } from '../../tokens.js';
import { installIconSprite, iconMarkup } from '../../widgets/icon-sprite.js';
import { makeDraggable } from '../../widgets/draggable.js';
import { buildParamControl } from '../../widgets/param-control.js';

const ROOM_ID = 'msa-tile-motion';
const STYLE_ID = 'msa-tile-motion-style';

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
#${ROOM_ID}{position:fixed; top:80px; right:440px; width:320px; max-height:80vh;
  background:var(--glass); backdrop-filter:blur(var(--glass-blur)); border:1px solid var(--line);
  border-radius:var(--r-room); box-shadow:var(--shadow3); display:flex; flex-direction:column;
  overflow:hidden; z-index:400; font:11px/1.4 var(--font); color:var(--ink0)}
#${ROOM_ID}[data-minimized="true"] .msa-tm-body{display:none}
#${ROOM_ID} .msa-tm-head{display:flex; align-items:center; gap:8px; padding:8px 12px;
  border-bottom:1px solid var(--line); flex:none; cursor:grab; user-select:none}
#${ROOM_ID} .msa-tm-head:active{cursor:grabbing}
#${ROOM_ID} .msa-tm-title{font-weight:700; font-size:.8rem; display:flex; gap:6px; align-items:center; color:var(--ink0)}
#${ROOM_ID} .msa-tm-title .ico{color:var(--shine)}
#${ROOM_ID} .msa-tm-spacer{flex:1}
#${ROOM_ID} .msa-tm-hbtn{width:22px; height:22px; display:grid; place-items:center; border-radius:5px;
  color:var(--ink2); background:none; border:none; cursor:pointer; pointer-events:auto}
#${ROOM_ID} .msa-tm-hbtn:hover{background:var(--bg3); color:var(--ink0)}
#${ROOM_ID} .msa-tm-hbtn.msa-minimized svg{transform-box:fill-box; transform-origin:center; transform:rotate(-90deg)}
#${ROOM_ID} .msa-tm-body{overflow-y:auto; padding:10px 12px}
#${ROOM_ID} .msa-tm-row{display:flex; align-items:center; gap:6px; margin-bottom:6px; flex-wrap:wrap; pointer-events:auto}
#${ROOM_ID} .msa-tm-row label{font-size:.68rem; color:var(--ink2)}
#${ROOM_ID} h4{margin:10px 0 6px; font-size:.68rem; color:var(--ink2); text-transform:uppercase;
  letter-spacing:.05em; border-top:1px solid var(--line); padding-top:8px}
#${ROOM_ID} input[type=number]{width:64px; background:var(--bg2); color:var(--ink0); border:1px solid var(--line);
  border-radius:4px; padding:2px 4px; font:inherit; pointer-events:auto}
#${ROOM_ID} select{background:var(--bg2); color:var(--ink0); border:1px solid var(--line); border-radius:4px;
  padding:2px 4px; font:inherit; max-width:200px; pointer-events:auto}
#${ROOM_ID} button.msa-tm-ghost{background:var(--bg3); color:var(--ink1); border:1px solid var(--line);
  border-radius:6px; padding:3px 8px; cursor:pointer; font-size:.72rem; pointer-events:auto}
#${ROOM_ID} button.msa-tm-ghost:hover{border-color:var(--shine-glow); color:var(--ink0)}
#${ROOM_ID} button.msa-tm-ghost:disabled{opacity:.5; cursor:default}
#${ROOM_ID} .msa-tm-status{font-size:.68rem; color:var(--ink2); margin:4px 0}
`.trim();
  document.head.appendChild(el);
}

function row(...children) {
  const el = document.createElement('div');
  el.className = 'msa-tm-row';
  el.append(...children);
  return el;
}

function label(text) {
  const el = document.createElement('label');
  el.textContent = text;
  return el;
}

function fieldRow(labelText, inputEl, title) {
  const r = row(label(labelText), inputEl);
  if (title) r.title = title;
  return r;
}

function sectionHeading(text) {
  const h = document.createElement('h4');
  h.textContent = text;
  return h;
}

function numberInput(value, step, onChange, opts = {}) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = String(step ?? 1);
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  input.value = String(value);
  input.addEventListener('change', () => onChange(Number(input.value)));
  return input;
}

function selectInput(options, current, onChange) {
  const select = document.createElement('select');
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value ?? opt;
    o.textContent = opt.label ?? opt;
    if ((opt.value ?? opt) === current) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function ghostButton(text, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msa-tm-ghost';
  btn.textContent = text;
  if (title) btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * Install the tile-motion panel, once.
 * @returns {{open: () => void, close: () => void, toggle: () => void, isOpen: () => boolean}}
 */
export function installTileMotionPanel() {
  installTokens();
  installIconSprite();
  injectStyle();
  const existing = document.getElementById(ROOM_ID);
  if (existing) return existing._msaController;

  let selectedTileId = '';
  let minimized = false;
  let unwatchSelection = null;
  let pollTimer = null;

  const room = document.createElement('section');
  room.id = ROOM_ID;
  room.setAttribute('aria-label', 'Tile Motion');
  room.hidden = true;

  const head = document.createElement('header');
  head.className = 'msa-tm-head';
  const title = document.createElement('span');
  title.className = 'msa-tm-title';
  title.innerHTML = `${iconMarkup('play')}Tile Motion`;
  const spacer = document.createElement('span');
  spacer.className = 'msa-tm-spacer';
  const minimizeBtn = document.createElement('button');
  minimizeBtn.type = 'button';
  minimizeBtn.className = 'msa-tm-hbtn';
  minimizeBtn.title = 'Minimize';
  minimizeBtn.innerHTML = iconMarkup('chev');
  minimizeBtn.addEventListener('click', () => controller.toggleMinimize());
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'msa-tm-hbtn';
  closeBtn.title = 'Close';
  closeBtn.innerHTML = iconMarkup('x');
  closeBtn.addEventListener('click', () => controller.close());
  head.append(title, spacer, minimizeBtn, closeBtn);

  const body = document.createElement('div');
  body.className = 'msa-tm-body';
  const statusEl = document.createElement('div');
  statusEl.className = 'msa-tm-status';
  const setStatus = (text) => (statusEl.textContent = text ?? '');

  async function patchSelectedTile(patch) {
    if (!selectedTileId) return;
    const result = await setTileMotionConfig(selectedTileId, patch);
    if (!result.ok) setStatus(`Save failed: ${result.reason}`);
    render();
  }

  function buildTileSelector() {
    const wrap = document.createElement('div');
    const list = getTileMotionTileList();
    const select = selectInput(
      [{ value: '', label: list.length ? 'Choose a tile…' : 'No tiles on this scene' }, ...list],
      selectedTileId,
      (v) => {
        selectedTileId = v;
        render();
      }
    );
    select.style.width = '100%';
    wrap.appendChild(select);
    if (selectedTileId) {
      const status = getTileMotionRuntimeStatus(selectedTileId);
      const statusLine = document.createElement('div');
      statusLine.className = 'msa-tm-status';
      statusLine.textContent = `Status: ${status.label}`;
      wrap.appendChild(statusLine);
    }
    return wrap;
  }

  function buildMotionTypeFields(config) {
    const wrap = document.createElement('div');
    const m = config.motion;
    wrap.appendChild(
      fieldRow(
        'motion type',
        selectInput(
          [
            { value: 'rotation', label: 'Rotation' },
            { value: 'orbit', label: 'Orbit' },
            { value: 'pingPong', label: 'Ping-pong' },
            { value: 'sine', label: 'Sine (bob/wobble)' },
          ],
          m.type,
          (v) => patchSelectedTile({ motion: { type: v } })
        )
      )
    );
    if (m.type === 'orbit' || m.type === 'pingPong') {
      wrap.appendChild(
        fieldRow(
          'loop mode',
          selectInput(
            [
              { value: 'loop', label: 'Loop (continuous)' },
              { value: 'pingPong', label: 'Ping-pong (swing back)' },
            ],
            m.loopMode,
            (v) => patchSelectedTile({ motion: { loopMode: v } })
          )
        )
      );
    }
    wrap.appendChild(
      fieldRow(
        'speed (deg/sec)',
        numberInput(m.speed, 1, (v) => patchSelectedTile({ motion: { speed: v } })),
        'Also drives orbit/ping-pong/sine timing, not just rotation angle'
      )
    );
    wrap.appendChild(
      fieldRow(
        'phase (deg)',
        numberInput(m.phase, 1, (v) => patchSelectedTile({ motion: { phase: v } }))
      )
    );

    // ⚠️ ROTATION-ONLY (2026-08-27 fix, live V2-vs-V4 gap research this
    // session): `foundry/tile-motion.js#resolveSineDelta` never reads
    // rotationEasing/easeStrength/clockwork* — verified directly (it
    // computes purely from phase/speed/amplitude/pivot). The ported field
    // set showed this whole block for 'sine' too, a real dead-control bug
    // inherited from the two now-deleted duplicate dialogs, not something
    // V2 itself did (V2's own dialog correctly hid these for sine).
    if (m.type === 'rotation') {
      wrap.appendChild(
        fieldRow(
          'rotation easing',
          selectInput(TILE_MOTION_ROTATION_EASING_TYPES, m.rotationEasing, (v) =>
            patchSelectedTile({ motion: { rotationEasing: v } })
          )
        )
      );
      wrap.appendChild(
        fieldRow(
          'ease strength',
          numberInput(m.easeStrength, 0.05, (v) => patchSelectedTile({ motion: { easeStrength: v } }), {
            min: 0,
            max: 1,
          })
        )
      );
      // ⚠️ JANK IS UNIVERSAL, STEPS/HOLD ARE CLOCKWORK-ONLY — a SECOND real
      // bug the same research found: `computeRotationProgress01` reads
      // `motion.clockworkJank` and applies `applyJankWarp01` UNCONDITIONALLY,
      // before branching on which easing is selected (verified directly,
      // tile-motion.js:345-358) — every rotation easing is affected by jank,
      // not just the two clockwork variants. `clockworkSteps`/`clockworkHold`
      // really are clockwork-only (only `computeClockworkProgress01` reads
      // them). The old gate hid jank from every non-clockwork easing, making
      // a real, live engine input unreachable from any UI.
      const isClockwork = m.rotationEasing === 'clockwork' || m.rotationEasing === 'clockwork-chaos';
      if (isClockwork) {
        wrap.appendChild(
          fieldRow(
            'clockwork steps',
            numberInput(m.clockworkSteps, 1, (v) => patchSelectedTile({ motion: { clockworkSteps: v } }), {
              min: 1,
              max: 48,
            })
          )
        );
        wrap.appendChild(
          fieldRow(
            'clockwork hold',
            numberInput(m.clockworkHold, 0.05, (v) => patchSelectedTile({ motion: { clockworkHold: v } }), {
              min: 0,
              max: 0.95,
            })
          )
        );
      }
      wrap.appendChild(
        fieldRow(
          'jank',
          numberInput(m.clockworkJank, 0.05, (v) => patchSelectedTile({ motion: { clockworkJank: v } }), {
            min: 0,
            max: 1,
          }),
          'Affects every rotation easing, not just clockwork'
        )
      );
    }
    if (m.type === 'orbit') {
      wrap.appendChild(
        fieldRow(
          'radius (px)',
          numberInput(m.radius, 5, (v) => patchSelectedTile({ motion: { radius: v } }), { min: 0 })
        )
      );
    }
    if (m.type === 'pingPong') {
      wrap.appendChild(
        fieldRow(
          'point A x',
          numberInput(m.pointA.x, 5, (v) => patchSelectedTile({ motion: { pointA: { x: v } } }))
        )
      );
      wrap.appendChild(
        fieldRow(
          'point A y',
          numberInput(m.pointA.y, 5, (v) => patchSelectedTile({ motion: { pointA: { y: v } } }))
        )
      );
      wrap.appendChild(
        fieldRow(
          'point B x',
          numberInput(m.pointB.x, 5, (v) => patchSelectedTile({ motion: { pointB: { x: v } } }))
        )
      );
      wrap.appendChild(
        fieldRow(
          'point B y',
          numberInput(m.pointB.y, 5, (v) => patchSelectedTile({ motion: { pointB: { y: v } } }))
        )
      );
    }
    if (m.type === 'sine') {
      wrap.appendChild(
        fieldRow(
          'amplitude X (px)',
          numberInput(m.amplitudeX, 5, (v) => patchSelectedTile({ motion: { amplitudeX: v } }))
        )
      );
      wrap.appendChild(
        fieldRow(
          'amplitude Y (px)',
          numberInput(m.amplitudeY, 5, (v) => patchSelectedTile({ motion: { amplitudeY: v } }))
        )
      );
      wrap.appendChild(
        fieldRow(
          'amplitude rot (deg)',
          numberInput(m.amplitudeRot, 5, (v) => patchSelectedTile({ motion: { amplitudeRot: v } }))
        )
      );
    }
    return wrap;
  }

  function buildPivotSection(config) {
    const wrap = document.createElement('div');
    wrap.appendChild(sectionHeading('Pivot'));
    wrap.appendChild(
      fieldRow(
        'pivot x',
        numberInput(config.pivot.x, 5, (v) => patchSelectedTile({ pivot: { x: v } }))
      )
    );
    wrap.appendChild(
      fieldRow(
        'pivot y',
        numberInput(config.pivot.y, 5, (v) => patchSelectedTile({ pivot: { y: v } }))
      )
    );
    // A schema-shaped bool (ui/canon-only): through buildParamControl, not
    // a hand-rolled `input.type='checkbox'` — the same door every other
    // room's own bool fields already go through.
    wrap.appendChild(
      buildParamControl(
        'pivotSnapToGrid',
        { type: 'bool', label: 'snap to grid' },
        { value: config.pivot.snapToGrid, onChange: (v) => patchSelectedTile({ pivot: { snapToGrid: v } }) }
      )
    );

    const centerBtn = ghostButton('Set Pivot = Center', "Resets to (0,0) — the tile's own anchor point", () =>
      patchSelectedTile({ pivot: { x: 0, y: 0 } })
    );
    const pickBtn = ghostButton(
      'Pick Pivot on Canvas',
      'Click anywhere on the map to set the pivot there',
      async () => {
        pickBtn.disabled = true;
        setStatus('Click on the canvas to set the pivot…');
        try {
          const world = await pickVtPanViewerWorldPoint();
          if (!world) return setStatus('Pivot pick timed out or the viewer is not running.');
          const restPose = getTileMotionRestPose(selectedTileId);
          if (!restPose) return setStatus('Could not read this tile’s placement — is it still on the scene?');
          const local = tileMotionWorldPointToLocalPivot(world, restPose);
          await patchSelectedTile({ pivot: { x: local.x, y: local.y } });
        } finally {
          pickBtn.disabled = false;
          setStatus('');
        }
      }
    );
    wrap.appendChild(row(centerBtn, pickBtn));

    const parentOptions = [
      { value: '', label: '(none)' },
      ...getTileMotionTileList().filter((t) => t.id !== selectedTileId),
    ];
    wrap.appendChild(
      fieldRow(
        'parent tile',
        selectInput(parentOptions, config.parentId ?? '', (v) => patchSelectedTile({ parentId: v || null })),
        "Inherit another tile's position + rotation before applying this one's own motion on top"
      )
    );
    return wrap;
  }

  function buildTextureMotionSection(config) {
    const wrap = document.createElement('div');
    wrap.appendChild(sectionHeading('Texture Motion'));
    const tm = config.textureMotion;
    wrap.appendChild(
      fieldRow(
        'scroll U /sec',
        numberInput(tm.scrollU, 0.05, (v) => patchSelectedTile({ textureMotion: { scrollU: v } }))
      )
    );
    wrap.appendChild(
      fieldRow(
        'scroll V /sec',
        numberInput(tm.scrollV, 0.05, (v) => patchSelectedTile({ textureMotion: { scrollV: v } }))
      )
    );
    wrap.appendChild(
      fieldRow(
        'rotate (deg/sec)',
        numberInput(tm.rotateSpeed, 1, (v) => patchSelectedTile({ textureMotion: { rotateSpeed: v } }))
      )
    );
    wrap.appendChild(
      fieldRow(
        'pivot U',
        numberInput(tm.pivotU, 0.05, (v) => patchSelectedTile({ textureMotion: { pivotU: v } }), { min: 0, max: 1 })
      )
    );
    wrap.appendChild(
      fieldRow(
        'pivot V',
        numberInput(tm.pivotV, 0.05, (v) => patchSelectedTile({ textureMotion: { pivotV: v } }), { min: 0, max: 1 })
      )
    );
    return wrap;
  }

  function buildSelectedTileForm() {
    const wrap = document.createElement('div');
    if (!selectedTileId) return wrap;
    const config = getTileMotionConfig(selectedTileId);
    wrap.appendChild(
      buildParamControl(
        'tileMotionEnabled',
        { type: 'bool', label: 'enabled' },
        { value: config.enabled, onChange: (v) => patchSelectedTile({ enabled: v }) }
      )
    );
    wrap.appendChild(
      fieldRow(
        'mode',
        selectInput(
          [
            { value: 'transform', label: 'Transform (move/rotate)' },
            { value: 'texture', label: 'Texture (scroll/spin the art)' },
          ],
          config.mode,
          (v) => patchSelectedTile({ mode: v })
        )
      )
    );
    if (config.mode === 'texture') {
      wrap.appendChild(buildTextureMotionSection(config));
    } else {
      wrap.appendChild(sectionHeading('Motion'));
      wrap.appendChild(buildMotionTypeFields(config));
      wrap.appendChild(buildPivotSection(config));
    }
    wrap.appendChild(buildRenderingSection(config));
    return wrap;
  }

  // shadowProjectionEnabled/renderAboveTokens (2026-08-27 fix, live V2-vs-V4
  // gap research this session) — both real, normalized fields in
  // TileMotionConfig (foundry/tile-motion.js:91-92, 115-116) with NO UI
  // anywhere before this: not in either of the two now-deleted duplicate
  // dialogs, and V2 had both (legacy/ui/tile-motion-dialog.js). Applies
  // regardless of transform/texture mode, so it sits after both, not
  // nested inside either mode's own section.
  function buildRenderingSection(config) {
    const wrap = document.createElement('div');
    wrap.appendChild(sectionHeading('Rendering'));
    wrap.appendChild(
      buildParamControl(
        'tileMotionShadowProjection',
        { type: 'bool', label: 'shadow projection', help: 'Cast this tile’s own shadow as it moves.' },
        {
          value: config.shadowProjectionEnabled,
          onChange: (v) => patchSelectedTile({ shadowProjectionEnabled: v }),
        }
      )
    );
    wrap.appendChild(
      buildParamControl(
        'tileMotionRenderAboveTokens',
        { type: 'bool', label: 'render above tokens' },
        { value: config.renderAboveTokens, onChange: (v) => patchSelectedTile({ renderAboveTokens: v }) }
      )
    );
    return wrap;
  }

  function buildTransportSection() {
    const wrap = document.createElement('div');
    wrap.appendChild(sectionHeading('Global Transport'));
    const transport = getTileMotionTransportState();
    const stateLine = document.createElement('div');
    stateLine.className = 'msa-tm-status';
    stateLine.textContent = transport.playing ? (transport.paused ? 'Paused' : 'Playing') : 'Stopped';
    wrap.appendChild(stateLine);

    const act = (fn) => async () => {
      const result = await fn();
      if (result && result.ok === false) setStatus(`Failed: ${result.reason}`);
      render();
    };
    wrap.appendChild(
      row(
        ghostButton('▶ Start', 'Restarts phase at 0', act(startTileMotion)),
        ghostButton(
          transport.paused ? '⏵ Resume' : '⏸ Pause',
          null,
          act(() => (transport.paused ? resumeTileMotion() : pauseTileMotion()))
        ),
        ghostButton('■ Stop', null, act(stopTileMotion)),
        ghostButton('↺ Reset Phase', null, act(resetTileMotionPhase))
      )
    );
    wrap.appendChild(
      fieldRow(
        'speed %',
        numberInput(transport.speedPercent, 10, (v) => setTileMotionSpeedPercent(v).then(render), { min: 0, max: 400 })
      )
    );
    wrap.appendChild(
      fieldRow(
        'time factor %',
        numberInput(transport.timeFactorPercent, 10, (v) => setTileMotionTimeFactorPercent(v).then(render), {
          min: 0,
          max: 200,
        })
      )
    );
    wrap.appendChild(
      buildParamControl(
        'tileMotionAutoplay',
        { type: 'bool', label: 'autoplay on scene load' },
        { value: transport.autoPlayEnabled, onChange: (v) => setTileMotionAutoPlayEnabled(v).then(render) }
      )
    );
    return wrap;
  }

  function render() {
    body.innerHTML = '';
    body.appendChild(buildTileSelector());
    body.appendChild(buildSelectedTileForm());
    body.appendChild(buildTransportSection());
    body.appendChild(statusEl);
  }

  room.append(head, body);
  document.body.appendChild(room);
  makeDraggable(head, room);

  const controller = {
    open() {
      room.hidden = false;
      activateTileMotionNativeTool();
      // Pre-select the first tile if nothing is selected yet (2026-08-27
      // fix, author: "when initially loading the tile motion sub-UI it
      // appears in a smaller form and then when I do something with it
      // suddenly the whole host of options appears"). Root cause: with no
      // tile selected, buildSelectedTileForm() returns an empty div (only
      // the tile picker + Global Transport render) — a genuinely smaller
      // panel, not a rendering glitch — until watchTileMotionSelection's own
      // 'controlTile' hook fires from a canvas click and the full Motion/
      // Pivot/Rendering sections suddenly appear. watchTileMotionSelection
      // only reacts to a NEW selection event (Hooks.on('controlTile', ...)),
      // it never fires proactively with whatever is already selected on
      // subscribe, so setting selectedTileId here is safe: nothing further
      // down will race it back to empty. Keeps the panel's own size
      // constant across the common case instead of jarringly growing.
      if (!selectedTileId) {
        const list = getTileMotionTileList();
        if (list.length) selectedTileId = list[0].id;
      }
      if (!unwatchSelection) {
        unwatchSelection = watchTileMotionSelection((tileId) => {
          if (room.hidden) return;
          selectedTileId = tileId;
          render();
        });
      }
      if (!pollTimer) pollTimer = setInterval(render, 1000);
      render();
    },
    close() {
      room.hidden = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      unwatchSelection?.();
      unwatchSelection = null;
    },
    toggle() {
      if (room.hidden) controller.open();
      else controller.close();
    },
    toggleMinimize() {
      minimized = !minimized;
      room.dataset.minimized = String(minimized);
      minimizeBtn.classList.toggle('msa-minimized', minimized);
      minimizeBtn.title = minimized ? 'Expand' : 'Minimize';
    },
    isOpen: () => !room.hidden,
  };
  room._msaController = controller;
  return controller;
}
