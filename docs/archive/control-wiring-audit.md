# Control Wiring Audit

Static, Foundry-free heuristic that estimates which Tweakpane parameters may be **disconnected** from runtime effect code. Use it to prioritize manual review — not as a definitive truth source.

## Run

```bash
npm run audit:controls
```

Outputs:

- `docs/reports/control-wiring-audit.md` — human triage report
- `docs/reports/control-wiring-audit.json` — machine-readable full results

### Options

```bash
npm run audit:controls -- --min-score 30
npm run audit:controls -- --effect fire-sparks
npm run audit:controls -- --out-json path/to/out.json --out-md path/to/out.md
```

Exit code `1` when any **high** confidence findings exist (score ≥ 60).

## How to read scores

Each parameter gets signals and a **confidence score** (0–100):

| Bucket     | Score | Meaning                                          |
| ---------- | ----- | ------------------------------------------------ |
| **high**   | ≥ 60  | Likely disconnected — check first                |
| **medium** | 30–59 | Partial signals — worth a look                   |
| **low**    | 10–29 | Weak signals                                     |
| **info**   | < 10  | Hidden, readonly, buttons, or heavily downgraded |

### Signals

| Signal                     | Meaning                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `NOT_IN_RUNTIME_PARAMS`    | Schema key missing from `this.params = { ... }` — `FloorCompositor.applyParam` won't persist it   |
| `ZERO_CODE_REFS`           | Key not referenced in effect file + co-located shader imports (after stripping schema methods)    |
| `NOT_IN_UI_GROUP`          | Not listed in any `groups[].parameters` — may not appear in the panel                             |
| `UI_BRIDGE_WIRED`          | Handled in `canvas-replacement.js` weather callback (or similar bridge)                           |
| `RUNTIME_RESOLVED`         | Found in `this.params`, spread defaults, `createDefaultParams()`, `this.settings`, or tuning bags |
| `PREFIX_WIRED`             | Matched via `paramId.startsWith('foo')` or explicit param key set in source                       |
| `SHADER_REF`               | Referenced in imported `*-shader.js` sibling                                                      |
| `HIDDEN` / `MARKED_UNUSED` | Intentionally deprecated controls — score reduced                                                 |

## Known false positives

- **Weather** (`WeatherController`) — params may live outside `this.params`; expect high scores until wired to the correct storage pattern.
- **Prefix families** — `coalBed*` params may show `PREFIX_WIRED` even when not in `this.params`.
- **Cross-file bridges** — weather param bridge, controlState, stylistic effect gates.
- **Manual panel controls** — Sun & Shadows, DSN/Sequencer, dev tools built directly in `tweakpane-manager.js` are **not** scanned in v1.

## Related tools

| Script                                               | Purpose                                     |
| ---------------------------------------------------- | ------------------------------------------- |
| `npm run audit:controls`                             | **Wiring audit** (this doc)                 |
| `node scripts/tools/audit-tweakpane-controls.mjs`    | Full control **inventory** report           |
| `node scripts/tools/audit-tweakpane-schema-refs.mjs` | Legacy console summary (wraps wiring audit) |
| `npm run preset:insight`                             | Preset value analysis vs schema bounds      |

## Implementation

- Entry: [`scripts/tools/audit-control-wiring.mjs`](../scripts/tools/audit-control-wiring.mjs)
- Library: [`scripts/tools/control-wiring-audit-lib.mjs`](../scripts/tools/control-wiring-audit-lib.mjs)
- Parsers: [`scripts/tools/preset-insight/lib/schema-parse-utils.mjs`](../scripts/tools/preset-insight/lib/schema-parse-utils.mjs)
