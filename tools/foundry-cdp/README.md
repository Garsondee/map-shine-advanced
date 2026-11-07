# foundry-cdp: drive Foundry clients from the shell

`cdp.mjs` attaches to Chrome over the DevTools protocol and runs commands against a
logged-in Foundry client by name. Built 2026-11-07 (mmp-f0k.1) so investigations,
captures and multi-client tests are scripts instead of clicks.

## Quick start (private rig)

```bash
node tools/foundry-cdp/cdp.mjs boot --name gm --url http://localhost:30070 --port 9370
node tools/foundry-cdp/cdp.mjs settle --name gm
node tools/foundry-cdp/cdp.mjs eval --name gm --code "game.scenes.viewed.name"
node tools/foundry-cdp/cdp.mjs shot --name gm --clean --out bigbank.png
node tools/foundry-cdp/cdp.mjs report --name gm --id scene-settled
node tools/foundry-cdp/cdp.mjs console --name gm --seconds 20 --out load.log
```

Multi-line scripts: `--file script.js`, or `--file -` with a heredoc. A file is the body of
an async function with `args` (from `--args '{"k":1}'`) in scope; a single bare expression
is returned as its value. Output is JSON on stdout.

`shot --clean` hides Foundry's UI and the MSA Remote/Studio for beauty shots and
before/after pairs.

## Clients

`boot` spawns Chrome detached (its own profile under `.profiles/<name>`, git-ignored) and
records the client in `clients.json` (git-ignored). `clients` lists them with liveness;
`close` shuts one down. `--port N` targets any Chrome with a DevTools port instead of a
name (for example an older rig).

## Traps

- MSA debug reports come back as JSON strings; `report` and `settle` parse them.
- `/dev/stdin` does not exist on Windows: use `--file -`.
- Point it at the live Oracle world only on purpose.
