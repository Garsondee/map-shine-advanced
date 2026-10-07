# oracle-sync

One-way, verified sync of this repo's Foundry module (`module.json`, `src/`,
`assets/`, `data/`, `languages/`, `styles/`, `templates/`) to the Foundry server's
`Data/modules/map-shine-advanced/` folder. Windows + PuTTY; no npm dependencies.

```
node tools/oracle-sync/oracle-sync.mjs status          # compare, send nothing (exit 1 if drift)
node tools/oracle-sync/oracle-sync.mjs push            # send what differs, verify by SHA-256
node tools/oracle-sync/oracle-sync.mjs push --dry-run
node tools/oracle-sync/oracle-sync.mjs watch           # push now, then on every local save
node tools/oracle-sync/oracle-sync.mjs info            # connection details + whether the watcher runs
node tools/oracle-sync/oracle-sync.mjs exec "<cmd>"    # run one shell command on the server
```

After a push, **reload Foundry in the browser (F5)**. Only a change to `module.json`'s
file lists needs a world relaunch (`exec "sudo systemctl restart foundryvtt"` restarts the service).

## Setup (once per machine)

The connection details are **not in this repo** — it is public.
Copy `oracle-sync.config.example.json` to `oracle-sync.config.json` (gitignored) and fill in
the host, user, pinned host-key fingerprint, and key path. Needs PuTTY's `plink.exe` and
`psftp.exe` (default `C:\Program Files\PuTTY`) and a `.ppk` key.

Use PuTTY's tools, not Windows' bundled `ssh.exe`: the old OpenSSH build cannot negotiate a
key exchange with an Ubuntu 24.04 server.

## What it guarantees

| Rule | Why |
| --- | --- |
| **Verified** — both sides are re-hashed after every upload | "the copy exited 0" is not proof (a recursive `pscp` once silently left stale files) |
| **Atomic per file** — upload to a staging folder, then `mv` into place | a connected player can never fetch a half-written file |
| **Preflight, whole batch** — JS must parse, relative imports and everything `module.json` names must exist, JSON must parse | a module Foundry cannot load breaks every macro at the next launch. One failing file blocks the **whole** batch, because a subset can leave a good file importing a bad one |
| **`module.json` uploaded last** | the manifest never names a file that has not arrived |
| **Never deletes** — a file removed locally is reported, not removed remotely | deleting something that turns out to matter is worse than a stale file |
| **Pinned host key** (`-hostkey`) | no trust-on-first-use prompt, and no silent switch to a different machine |
| One connection per phase (psftp batch), not one per file | a 50-file push takes ~8 s |

`assets/torture/` (regenerable fixture) and `src/vendor/three/.webgpu-entry.js` (build output) are
never synced. Everything else under the sync roots is, including `__tests__` folders, matching
what was already on the server.

## Watch mode

`watch` pushes whatever differs on start, then watches the sync roots; saves are batched for
1.5 s, hash-compared with the server (a save that changes nothing sends nothing), preflighted,
uploaded and verified. A failed preflight keeps the files queued and says why; a network error
retries after 15 s. Only one watcher runs at a time (heartbeat lock file); its log is
`oracle-sync.log`.

Start it hidden (PowerShell):

```powershell
Start-Process node -ArgumentList 'tools/oracle-sync/oracle-sync.mjs','watch' -WorkingDirectory . `
  -WindowStyle Hidden -RedirectStandardOutput tools/oracle-sync/oracle-sync.log `
  -RedirectStandardError tools/oracle-sync/oracle-sync.err.log
```

Stop it: end the `node.exe` whose command line contains `oracle-sync.mjs watch`.

## Files

- `oracle-sync-core.mjs` — pure rules (what syncs, path safety, diffing, import/manifest checks). Unit-tested in `oracle-sync-core.test.mjs`, wired into `npm test`.
- `oracle-sync.mjs` — the CLI; the only file that touches PuTTY, the network or the disk.

Design lineage: the rules are the lessons of the sibling *Blank Inheritance* project's
`tools/module-sync` (verified pushes, file-by-file upload, never push a subset).
