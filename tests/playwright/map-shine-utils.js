async function waitForCanvasReady(page, timeoutMs = 120000) {
  const start = Date.now();
  let lastLog = start;

  while (true) {
    const st = await page.evaluate(() => {
      try {
        return {
          ok: !!window.canvas?.ready,
          hasJoin: !!document.querySelector('form#join-game-form, form#join'),
          url: window.location?.href || ''
        };
      } catch (_) {
        return { ok: false, hasJoin: false, url: '' };
      }
    });
    if (st && st.ok) return;

    const now = Date.now();
    if (now - start > timeoutMs) {
      throw new Error(`Timed out waiting for canvas.ready after ${Math.round((now - start) / 1000)}s`);
    }

    if (now - lastLog > 5000) {
      const elapsed = ((now - start) / 1000).toFixed(1);
      try {
        console.log(`[perf] waiting for canvas.ready... ${elapsed}s join=${!!st?.hasJoin} url=${st?.url || ''}`);
      } catch (_) {}
      lastLog = now;
    }

    await page.waitForTimeout(250);
  }
}

async function ensureActiveScene(page, timeoutMs = 60000) {
  const start = Date.now();
  let lastLog = start;

  while (true) {
    const st = await page.evaluate(async () => {
      try {
        const g = window.game;
        if (!g || g.ready !== true) {
          return { ok: false, reason: 'game-not-ready', ready: g?.ready === true };
        }

        const scenes = g.scenes;
        const active = scenes?.active || null;
        const count = Array.isArray(scenes?.contents) ? scenes.contents.length : (typeof scenes?.size === 'number' ? scenes.size : null);

        if (active) {
          return { ok: true, activated: false, activeId: active.id || null, sceneCount: count };
        }

        const list = Array.isArray(scenes?.contents) ? scenes.contents : [];
        const first = list && list.length ? list[0] : null;
        if (!first) {
          return { ok: false, reason: 'no-scenes', activeId: null, sceneCount: count };
        }

        if (typeof first.activate === 'function') {
          await first.activate();
        }

        return { ok: !!(g.scenes?.active), activated: true, activeId: g.scenes?.active?.id || null, sceneCount: count };
      } catch (e) {
        return { ok: false, reason: String(e?.message || e), ready: false };
      }
    });

    if (st?.ok) return;

    const now = Date.now();
    if (now - start > timeoutMs) {
      throw new Error(`Timed out ensuring active scene after ${Math.round((now - start) / 1000)}s (${st ? JSON.stringify(st) : ''})`);
    }

    if (now - lastLog > 5000) {
      const elapsed = ((now - start) / 1000).toFixed(1);
      try {
        console.log(`[perf] ensuring active scene... ${elapsed}s ${st ? JSON.stringify(st) : ''}`);
      } catch (_) {
      }
      lastLog = now;
    }

    await page.waitForTimeout(250);
  }
}

async function waitForMapShineReady(page, timeoutMs = 180000) {
  const requirePerf = process.env.PERF_REQUIRE_MAPSHINE_PERF === 'true';
  const start = Date.now();
  let lastLog = start;
  let warnedNoPerf = false;

  while (true) {
    const state = await page.evaluate(() => {
      try {
        return {
          gameReady: window.game?.ready === true,
          mapShineInitialized: !!window.MapShine?.initialized,
          hasCanvasMapShine: !!window.canvas?.mapShine,
          hasRenderLoop: !!window.canvas?.mapShine?.renderLoop,
          hasGetFps: typeof window.canvas?.mapShine?.renderLoop?.getFPS === 'function',
          hasPerf: !!window.MapShine?.perf,
          hasExportAllJson: typeof window.MapShine?.perf?.exportAllJson === 'function',
          hasDebug: !!window.MapShine?.debug,
          hasJoin: !!document.querySelector('form#join-game-form, form#join'),
          url: window.location?.href || ''
        };
      } catch (_) {
        return null;
      }
    });

    const baseOk = (
      state &&
      state.gameReady &&
      state.mapShineInitialized &&
      state.hasCanvasMapShine &&
      state.hasRenderLoop &&
      state.hasGetFps
    );

    const perfOk = !!(state && state.hasPerf && state.hasExportAllJson);

    if (baseOk && (perfOk || !requirePerf)) {
      if (!perfOk && !warnedNoPerf) {
        warnedNoPerf = true;
        try {
          console.log('[perf] warning: MapShine ready but MapShine.perf.exportAllJson is missing; continuing without MapShine profiler export');
        } catch (_) {
        }
      }
      return;
    }

    if (
      state &&
      state.gameReady &&
      !state.hasJoin &&
      !state.hasCanvasMapShine &&
      (Date.now() - start) > 30000
    ) {
      throw new Error('MapShine never attached to canvas (canvas.mapShine missing). This usually means the active scene is not enabled for Map Shine Advanced.');
    }

    const now = Date.now();
    if (now - start > timeoutMs) {
      throw new Error(`Timed out waiting for MapShine ready after ${Math.round((now - start) / 1000)}s`);
    }

    if (now - lastLog > 5000) {
      const elapsed = ((now - start) / 1000).toFixed(1);
      try {
        console.log(`[perf] waiting for MapShine ready... ${elapsed}s requirePerf=${requirePerf} ${state ? JSON.stringify(state) : ''}`);
      } catch (_) {
      }
      lastLog = now;
    }

    await page.waitForTimeout(250);
  }
}

async function unpauseIfPaused(page) {
  const st0 = await page.evaluate(() => {
    try {
      return {
        paused: window.game?.paused === true,
        hasTogglePause: typeof window.game?.togglePause === 'function',
        togglePauseArity: typeof window.game?.togglePause === 'function' ? window.game.togglePause.length : null,
        userId: window.game?.user?.id || null,
        isGM: window.game?.user?.isGM === true
      };
    } catch (_) {
      return { paused: false, hasTogglePause: false, togglePauseArity: null, userId: null, isGM: false };
    }
  });

  try {
    console.log(`[perf] unpause: initial paused=${!!st0?.paused} togglePause=${!!st0?.hasTogglePause} arity=${st0?.togglePauseArity} userId=${st0?.userId || ''} isGM=${!!st0?.isGM}`);
  } catch (_) {
  }

  if (!st0?.paused) return;

  const attempt = await page.evaluate(async () => {
    try {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const g = window.game;
      if (!g || typeof g.togglePause !== 'function') return { ok: false, via: 'no-api', paused: g?.paused === true };

      for (let i = 0; i < 10; i++) {
        try {
          if (g.paused === false) return { ok: true, via: 'already', paused: false };
          try {
            g.togglePause(false, { broadcast: true });
          } catch (_) {
            try { g.togglePause(); } catch (_) {}
          }

          if (g.paused === true && g.user?.isGM && g.socket?.emit) {
            try { g.socket.emit('pause', false, { broadcast: true }); } catch (_) {}
          }
        } catch (_) {
        }
        await sleep(250);
      }

      await sleep(500);

      return { ok: g.paused === false, via: 'togglePause', paused: g.paused === true };
    } catch (_) {
      return { ok: false, via: 'error', paused: true };
    }
  });

  try {
    console.log(`[perf] unpause: after api via=${attempt?.via} paused=${!!attempt?.paused}`);
  } catch (_) {
  }

  let stillPaused = await page.evaluate(() => {
    try { return window.game?.paused === true; } catch (_) { return false; }
  });

  if (stillPaused) {
    try {
      await page.mouse.click(10, 10);
    } catch (_) {
    }

    try {
      await page.keyboard.press('Space');
      await page.waitForTimeout(250);
      await page.keyboard.press('Space');
      await page.waitForTimeout(500);
    } catch (_) {
    }

    if (stillPaused) {
      try {
        stillPaused = await page.evaluate(async () => {
          try {
            const g = window.game;
            if (!g || typeof g.togglePause !== 'function') return g?.paused === true;
            try {
              g.togglePause(false, { broadcast: true });
            } catch (_) {
              try { g.togglePause(); } catch (_) {}
            }

            if (g.paused === true && g.user?.isGM && g.socket?.emit) {
              try { g.socket.emit('pause', false, { broadcast: true }); } catch (_) {}
            }
            return g.paused === true;
          } catch (_) {
            return true;
          }
        });
      } catch (_) {
      }
    }

    stillPaused = await page.evaluate(() => {
      try { return window.game?.paused === true; } catch (_) { return false; }
    });

    try {
      console.log(`[perf] unpause: after keyboard paused=${!!stillPaused}`);
    } catch (_) {
    }
  }

  if (stillPaused) {
    const who = await page.evaluate(() => {
      try {
        return {
          paused: window.game?.paused === true,
          userId: window.game?.user?.id || null,
          userName: window.game?.user?.name || null,
          isGM: window.game?.user?.isGM === true
        };
      } catch (_) {
        return { paused: true, userId: null, userName: null, isGM: false };
      }
    });

    const suffix = who && who.isGM === false
      ? ` (logged in as non-GM userId=${who.userId || ''} name=${who.userName || ''}; GM is required to broadcast unpause)`
      : ` (userId=${who?.userId || ''} name=${who?.userName || ''} isGM=${!!who?.isGM})`;

    throw new Error(`Failed to unpause game${suffix}`);
  }
}

async function waitForGameReady(page, timeoutMs = 90000) {
  const start = Date.now();
  let lastLog = start;

  while (true) {
    const st = await page.evaluate(() => {
      try {
        return {
          ok: window.game?.ready === true,
          hasJoin: !!document.querySelector('form#join-game-form, form#join'),
          url: window.location?.href || ''
        };
      } catch (_) {
        return { ok: false, hasJoin: false, url: '' };
      }
    });

    if (st && st.ok) return;

    const now = Date.now();
    if (now - start > timeoutMs) {
      throw new Error(`Timed out waiting for game.ready after ${Math.round((now - start) / 1000)}s`);
    }

    if (now - lastLog > 5000) {
      const elapsed = ((now - start) / 1000).toFixed(1);
      try {
        console.log(`[perf] waiting for game.ready... ${elapsed}s join=${!!st?.hasJoin} url=${st?.url || ''}`);
      } catch (_) {}
      lastLog = now;
    }

    await page.waitForTimeout(250);
  }
}

async function bestEffortLogin(page) {
  const password = process.env.FOUNDRY_PASSWORD || '';
  const userId = process.env.FOUNDRY_USER_ID || '';
  const userName = process.env.FOUNDRY_USER_NAME || '';

  const visibleJoin = await page.waitForSelector('form#join-game-form, form#join', { timeout: 15000, state: 'visible' }).catch(() => null);
  if (!visibleJoin) {
    try { console.log('[perf] login: no join form visible'); } catch (_) {}
    return;
  }

  const hasJoinGameForm = await page.locator('form#join-game-form').count();
  const joinSelector = hasJoinGameForm ? 'form#join-game-form' : 'form#join';
  const joinForm = page.locator(joinSelector);
  const hasJoin = await joinForm.count();
  if (!hasJoin) {
    try { console.log('[perf] login: join form disappeared'); } catch (_) {}
    return;
  }

  try { console.log(`[perf] login: join form visible selector=${joinSelector}`); } catch (_) {}

  const userSelect = joinForm.locator('select[name="userid"], select#userid');
  const userInput = joinForm.locator('input[name="userid"], input#userid');

  if (await userSelect.count()) {
      if (userId) {
        try { await userSelect.selectOption(userId); } catch (_) {}
      } else if (userName) {
        try {
          const options = await userSelect.locator('option').all();
          let chosen = '';
          for (const opt of options) {
            const value = (await opt.getAttribute('value')) || '';
            if (!value) continue;
            const label = ((await opt.textContent()) || '').trim();
            if (label && label.toLowerCase().includes(userName.toLowerCase())) {
              chosen = value;
              break;
            }
          }
          if (chosen) {
            await userSelect.selectOption(chosen);
          } else {
            await userSelect.selectOption({ label: userName });
          }
        } catch (_) {}
      } else {
        try {
          const options = await userSelect.locator('option').all();
          for (const opt of options) {
            const value = (await opt.getAttribute('value')) || '';
            if (value) {
              await userSelect.selectOption(value);
              break;
            }
          }
        } catch (_) {
        }
      }

      try {
        const selectedValue = await userSelect.inputValue();
        const selectedLabel = await userSelect.locator(`option[value="${selectedValue}"]`).textContent().catch(() => null);
        console.log(`[perf] login: selected user value=${selectedValue} label=${(selectedLabel || '').trim()}`);
      } catch (_) {
      }
  } else if (await userInput.count()) {
    if (userId) {
      try { await userInput.fill(userId); } catch (_) {}
    } else if (userName) {
      try { await userInput.fill(userName); } catch (_) {}
    }
  } else {
    throw new Error('No userid selector found on join form');
  }

  const pw = joinForm.locator('input[name="password"]');
  if (await pw.count()) {
    try { await pw.fill(password); } catch (_) {}
  }

  const joinBtn = page.locator(`${joinSelector} button[name="join"], ${joinSelector} button#join, ${joinSelector} button[type="submit"], ${joinSelector} button`);
  const btnToClick = (await joinBtn.count()) ? joinBtn.first() : null;
  if (!btnToClick) throw new Error('No join button found on join form');

  await Promise.all([
    page.waitForLoadState('domcontentloaded').catch(() => {}),
    btnToClick.click()
  ]).catch(() => {});

  await page.waitForFunction(() => {
    try {
      const join = document.querySelector('form#join-game-form, form#join');
      if (!join) return true;
      return !!window.game?.user;
    } catch (_) {
      return false;
    }
  }, { timeout: 90000 });

  try {
    const who = await page.evaluate(() => {
      try {
        return {
          url: window.location?.href || '',
          userId: window.game?.user?.id || null,
          userName: window.game?.user?.name || null,
          isGM: window.game?.user?.isGM === true,
          paused: window.game?.paused === true
        };
      } catch (_) {
        return null;
      }
    });
    console.log(`[perf] login: post-join ${who ? JSON.stringify(who) : ''}`);
  } catch (_) {
  }

  const stillHasJoin = await joinForm.count();
  if (stillHasJoin) throw new Error('Login did not complete (still on join screen)');
}

module.exports = {
  waitForCanvasReady,
  waitForMapShineReady,
  unpauseIfPaused,
  bestEffortLogin,
  waitForGameReady,
  ensureActiveScene
};
