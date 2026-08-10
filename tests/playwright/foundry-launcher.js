const childProcess = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          res.resume();
          resolve(res.statusCode && (res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 401));
        });
        req.on('error', reject);
        req.setTimeout(3000, () => {
          req.destroy(new Error('timeout'));
        });
      });
      if (ok) return true;
    } catch (_) {
    }

    await sleep(250);
  }
  return false;
}

function pushLogLine(buf, s, maxChars) {
  if (!s) return;
  buf.push(s);
  let total = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    total += buf[i].length;
    if (total > maxChars) {
      buf.splice(0, i);
      break;
    }
  }
}

function safeStat(p) {
  try {
    return fs.statSync(p);
  } catch (_) {
    return null;
  }
}

function isDirectory(p) {
  const st = safeStat(p);
  return !!st && st.isDirectory();
}

function isFile(p) {
  const st = safeStat(p);
  return !!st && st.isFile();
}

function firstExistingFile(paths) {
  for (const p of paths) {
    if (p && isFile(p)) return p;
  }
  return '';
}

function normalizeFsPath(p) {
  if (!p || typeof p !== 'string') return '';
  const trimmed = p.trim();
  if (!trimmed) return '';
  return path.normalize(trimmed.replace(/\\/g, path.sep).replace(/\//g, path.sep));
}

function listWorldEntries(worldsDir) {
  const names = fs.readdirSync(worldsDir).filter((n) => isDirectory(path.join(worldsDir, n)));
  const out = [];
  for (const name of names) {
    const dir = path.join(worldsDir, name);
    const wj = path.join(dir, 'world.json');
    if (!isFile(wj)) continue;
    const st = safeStat(wj) || safeStat(dir);
    out.push({ name, mtimeMs: st ? st.mtimeMs : 0 });
  }
  return out;
}

function firstExistingDir(paths) {
  for (const p of paths) {
    if (p && isDirectory(p)) return p;
  }
  return '';
}

function getCandidateFoundryRoots() {
  const out = [];
  if (process.env.FOUNDRY_INSTALL_DIR) out.push(process.env.FOUNDRY_INSTALL_DIR);
  if (process.env.FOUNDRY_APP_DIR) out.push(process.env.FOUNDRY_APP_DIR);

  // The repo-local install (2026-08-10) — checked BEFORE the machine-wide ones so a
  // checkout that ships its own Foundry is self-contained and does not silently bench
  // against whatever version happens to be installed system-wide.
  out.push(path.join(process.cwd(), 'FoundryVTT', 'Foundry Virtual Tabletop'));
  out.push(path.join(process.cwd(), 'FoundryVTT'));

  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || '';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || '';

  if (localAppData) {
    out.push(path.join(localAppData, 'FoundryVTT'));
    out.push(path.join(localAppData, 'Foundry Virtual Tabletop'));
  }

  if (programFiles) {
    out.push(path.join(programFiles, 'Foundry Virtual Tabletop'));
    out.push(path.join(programFiles, 'FoundryVTT'));
    out.push(path.join(programFiles, 'Foundry'));
  }

  if (programFilesX86) {
    out.push(path.join(programFilesX86, 'Foundry Virtual Tabletop'));
    out.push(path.join(programFilesX86, 'FoundryVTT'));
    out.push(path.join(programFilesX86, 'Foundry'));
  }

  return out;
}

function discoverFoundryMain() {
  const direct = process.env.FOUNDRY_PATH || '';
  if (direct && isFile(direct)) return direct;

  const attempted = [];
  const roots = getCandidateFoundryRoots();
  for (const root of roots) {
    if (!root) continue;
    const candidates = [
      root,
      path.join(root, 'main.js'),
      path.join(root, 'resources', 'app', 'main.js'),
      path.join(root, 'resources', 'app', 'main.cjs'),
      path.join(root, 'resources', 'app', 'main.mjs')
    ];
    for (const c of candidates) attempted.push(c);
    const hit = firstExistingFile(candidates);
    if (hit) return hit;
  }

  const err = new Error('Unable to locate Foundry main.js. Set FOUNDRY_PATH to the Foundry main.js entrypoint.');
  err.attempted = attempted;
  throw err;
}

/**
 * Locate the Foundry Electron binary, whose BUNDLED Node is what actually runs the server.
 *
 * Foundry v14 requires Node >= 24 (`resources/app/package.json` → `release.node_version`).
 * The system Node may be older — it was 18 on the reference machine — so spawning
 * `process.execPath` fails outright with "requires Node.js version 24 or greater". The
 * Electron binary carries its own Node 24 and can be driven as a plain interpreter via
 * `ELECTRON_RUN_AS_NODE=1`, which removes the separate-Node-install requirement entirely.
 *
 * @returns {string} path to the Electron executable, or '' when only a bare Node install exists.
 */
function discoverElectronExe() {
  const direct = process.env.FOUNDRY_ELECTRON_EXE || '';
  if (direct && isFile(direct)) return direct;

  const names = ['Foundry Virtual Tabletop.exe', 'FoundryVTT.exe', 'foundryvtt'];
  for (const root of getCandidateFoundryRoots()) {
    if (!root) continue;
    for (const n of names) {
      const p = path.join(root, n);
      if (isFile(p)) return p;
    }
  }
  return '';
}

/** @returns {string} the `resources/app` directory implied by a discovered main.js/main.mjs path. */
function appDirFromMain(mainPath) {
  return mainPath ? path.dirname(mainPath) : '';
}

function readOptionsJsonFromRoot(rootDir) {
  if (!rootDir) return null;

  const candidateFiles = [
    path.join(rootDir, 'Config', 'options.json'),
    path.join(rootDir, 'Data', 'Config', 'options.json')
  ];

  for (const f of candidateFiles) {
    if (!isFile(f)) continue;
    try {
      const raw = fs.readFileSync(f, 'utf-8');
      const json = (() => {
        try {
          return JSON.parse(raw);
        } catch (_) {
          const noBlock = raw.replace(/\/\*[\s\S]*?\*\//g, '');
          const noLine = noBlock.replace(/^\s*\/\/.*$/gm, '');
          const noTrailingCommas = noLine.replace(/,\s*([}\]])/g, '$1');
          return JSON.parse(noTrailingCommas);
        }
      })();
      if (json && typeof json === 'object') return json;
    } catch (_) {
    }
  }

  return null;
}

function discoverDataPath() {
  const direct = process.env.FOUNDRY_DATA_PATH || '';
  if (direct && isDirectory(direct)) return direct;

  const localAppData = process.env.LOCALAPPDATA || '';
  const appData = process.env.APPDATA || '';

  const candidates = [];
  if (localAppData) candidates.push(path.join(localAppData, 'FoundryVTT'));
  if (appData) candidates.push(path.join(appData, 'FoundryVTT'));

  for (const root of candidates) {
    if (!root || !isDirectory(root)) continue;
    const options = readOptionsJsonFromRoot(root);
    const fromOptions = options && typeof options.dataPath === 'string' ? normalizeFsPath(options.dataPath) : '';
    if (fromOptions && isDirectory(fromOptions)) return fromOptions;
  }

  return firstExistingDir(candidates);
}

function readOptionsWorld(dataPath) {
  if (!dataPath) return '';

  const options = readOptionsJsonFromRoot(dataPath);
  if (options && typeof options.world === 'string' && options.world) return options.world;
  return '';
}

function discoverWorld(dataPath) {
  if (!dataPath) return '';

  const worldsDirs = [
    path.join(dataPath, 'Data', 'worlds'),
    path.join(dataPath, 'data', 'worlds'),
    path.join(dataPath, 'worlds')
  ];

  for (const worldsDir of worldsDirs) {
    if (!isDirectory(worldsDir)) continue;
    try {
      const entries = listWorldEntries(worldsDir);
      if (entries.length === 1) return entries[0].name;
      if (entries.length > 1) {
        entries.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
        return entries[0].name;
      }
    } catch (_) {
    }
  }

  return '';
}

class FoundryLauncher {
  constructor(options = {}) {
    this.foundryPath = options.foundryPath || process.env.FOUNDRY_PATH || '';
    this.dataPath = options.dataPath || process.env.FOUNDRY_DATA_PATH || '';
    this.world = options.world || process.env.FOUNDRY_WORLD || '';
    this.port = Number(options.port || process.env.FOUNDRY_PORT || 30000);
    if (typeof options.headless === 'boolean') {
      this.headless = options.headless;
    } else if (typeof process.env.FOUNDRY_HEADLESS === 'string') {
      this.headless = process.env.FOUNDRY_HEADLESS === 'true';
    } else {
      this.headless = false;
    }

    this.proc = null;
    /** True when we reused a server someone else started; `stop()` must then leave it running. */
    this.attached = false;
    this.serverStartTs = 0;
    this.serverReadyTs = 0;

    this._stdout = [];
    this._stderr = [];
  }

  getBaseUrl() {
    return `http://localhost:${this.port}`;
  }

  async start() {
    // ATTACH MODE (2026-08-10). A Foundry already serving this port is used as-is rather
    // than fought over: Foundry takes an exclusive lock on its data directory, so a second
    // server on the same dataPath cannot start ("already locked by another process"). The
    // author routinely has their own Foundry open, and a bench run must not require them to
    // close it. `stop()` leaves an attached server alone — we did not start it.
    if (process.env.FOUNDRY_BASE_URL) {
      const url = process.env.FOUNDRY_BASE_URL.replace(/\/+$/, '');
      const m = /:(\d+)$/.exec(url);
      if (m) this.port = Number(m[1]);
      this.attached = true;
    } else if (await waitForServer(this.getBaseUrl(), 1500)) {
      this.attached = true;
    }

    if (this.attached) {
      this.serverStartTs = this.serverReadyTs = Date.now();
      return true;
    }

    if (!this.dataPath) {
      this.dataPath = discoverDataPath();
    }
    if (!this.foundryPath) {
      try {
        this.foundryPath = discoverFoundryMain();
      } catch (e) {
        const extra = e && e.attempted ? `\nTried:\n${e.attempted.map((p) => `- ${p}`).join('\n')}` : '';
        throw new Error(`${e.message}${extra}`);
      }
    }
    if (!this.world) {
      const fromOptions = readOptionsWorld(this.dataPath);
      this.world = fromOptions || discoverWorld(this.dataPath);
    }

    if (!this.world) {
      const hint = this.dataPath ? ` (dataPath=${this.dataPath})` : '';
      const checked = this.dataPath
        ? [path.join(this.dataPath, 'Data', 'worlds'), path.join(this.dataPath, 'data', 'worlds'), path.join(this.dataPath, 'worlds')]
        : [];
      const extra = checked.length ? `\nChecked:\n${checked.map((p) => `- ${p}`).join('\n')}` : '';
      throw new Error(`FOUNDRY_WORLD is required${hint}. Set FOUNDRY_WORLD or ensure options.json has a world or a world folder contains world.json.${extra}`);
    }

    // Prefer the Electron binary's bundled Node (see discoverElectronExe). It is launched
    // through `tools/foundry-server-boot.mjs`, which hides `process.versions.electron` —
    // without that, Foundry sees an Electron runtime, tries to open a desktop window, and
    // dies on `app.setUserTasks` because `app` does not exist in run-as-node mode. Note
    // `--headless` does NOT prevent that; nothing reads it before the window is built.
    const electronExe = discoverElectronExe();
    const bootShim = path.join(process.cwd(), 'tools', 'foundry-server-boot.mjs');
    const useElectron = !!electronExe && isFile(bootShim);

    const interpreter = useElectron ? electronExe : process.execPath;
    const args = useElectron
      ? [bootShim, `--foundry-app=${appDirFromMain(this.foundryPath)}`]
      : [this.foundryPath];

    if (this.headless) args.push('--headless');
    args.push(`--world=${this.world}`, `--port=${this.port}`);
    if (this.dataPath) args.push(`--dataPath=${this.dataPath}`);

    this.serverStartTs = Date.now();
    this.proc = childProcess.spawn(interpreter, args, {
      stdio: 'pipe',
      windowsHide: this.headless ? true : false,
      env: useElectron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    });

    this._stdout = [];
    this._stderr = [];

    const maxLogChars = Number(process.env.FOUNDRY_LOG_CHARS || 20000);
    const echo = process.env.FOUNDRY_LOG_ECHO === 'true';
    this.proc.stdout.on('data', (b) => {
      try {
        const s = String(b);
        pushLogLine(this._stdout, s, maxLogChars);
        if (echo) {
          try { process.stdout.write(s); } catch (_) {}
        }
      } catch (_) {
      }
    });
    this.proc.stderr.on('data', (b) => {
      try {
        const s = String(b);
        pushLogLine(this._stderr, s, maxLogChars);
        if (echo) {
          try { process.stderr.write(s); } catch (_) {}
        }
      } catch (_) {
      }
    });

    const exitPromise = new Promise((resolve) => {
      this.proc.once('exit', (code, signal) => resolve({ code, signal }));
    });

    const readyTimeoutMs = Number(process.env.FOUNDRY_READY_TIMEOUT_MS || 180000);

    const outcome = await Promise.race([
      waitForServer(this.getBaseUrl(), readyTimeoutMs).then((ok) => ({ ok })),
      exitPromise.then((r) => ({ exited: true, ...r }))
    ]);

    if (!outcome || outcome.exited || !outcome.ok) {
      const baseUrl = this.getBaseUrl();
      const header = [
        `Foundry failed to start or become ready on ${baseUrl}`,
        `interpreter: ${interpreter}${useElectron ? ' (Electron bundled Node, ELECTRON_RUN_AS_NODE=1)' : ''}`,
        `foundryPath: ${this.foundryPath}`,
        `dataPath: ${this.dataPath || '(none)'}`,
        `world: ${this.world}`,
        `port: ${this.port}`,
        `headless: ${this.headless}`,
        `args: ${args.join(' ')}`
      ].join('\n');

      const exitInfo = outcome && outcome.exited ? `\nexit: code=${outcome.code} signal=${outcome.signal}` : '';
      const stdout = this._stdout.length ? `\n\nstdout:\n${this._stdout.join('')}` : '';
      const stderr = this._stderr.length ? `\n\nstderr:\n${this._stderr.join('')}` : '';

      const combined = `${stdout}\n${stderr}`;
      const lockHint = (combined.includes('acquireLockFile') || combined.toLowerCase().includes('lock file'))
        ? `\n\nHint: Foundry could not acquire its data directory lock. Another Foundry instance is likely already running using the same dataPath (${this.dataPath || '(unknown)'}).\n- Close any running Foundry VTT instances and re-run, or\n- Set FOUNDRY_BASE_URL to attach Playwright to an already-running server instead of launching a new one.`
        : '';

      await this.stop();
      throw new Error(`${header}${exitInfo}${stdout}${stderr}${lockHint}`);
    }

    this.serverReadyTs = Date.now();
    return true;
  }

  async stop() {
    // Never kill a server we merely attached to — it is someone else's process (very likely
    // the author's own open Foundry) and tearing it down would be a surprising side effect.
    if (this.attached) {
      this.attached = false;
      return;
    }
    if (!this.proc) return;

    const p = this.proc;
    this.proc = null;

    try {
      p.kill();
    } catch (_) {
      try {
        p.kill('SIGTERM');
      } catch (_) {
      }
    }

    const exited = await Promise.race([
      new Promise((resolve) => p.once('exit', () => resolve(true))),
      sleep(5000).then(() => false)
    ]);

    if (!exited) {
      if (process.platform === 'win32' && p.pid) {
        try {
          childProcess.spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch (_) {
        }
      } else {
        try {
          p.kill('SIGKILL');
        } catch (_) {
        }
      }
    }
  }
}

module.exports = { FoundryLauncher };
