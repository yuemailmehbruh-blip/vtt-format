# Campaign format

Schemas and lock protocol for this sample campaign tree.

## Layout roles

| Path | Owner | Purpose |
|------|-------|---------|
| `build/` | Editor | Compiled sheets, ruleset stubs, bindings, `manifest.json` |
| `world/` | Prep | Scenes, actors, journals, encounters, content-addressed assets |
| `state/` | GM / play | Fog, combat, chat-log, autosave — runtime only |
| `prep-scratch/` | Prep | WIP; not loaded by play |
| `editor-scratch/` | Editor | WIP; not loaded by play |

Play **never** calls AI. Sheets are declarative YAML + closed formulas.

## Sheet schema

```yaml
id: string              # sheet id (filename stem should match)
name: string
permissions:
  notes: string         # human-readable permission notes
fields:
  <field_name>:
    type: string|integer|boolean|text|number
    visibility: player_visible|gm_only|…
    editable: player_editable|gm|false
    default: <optional>
    formula: "<closed expression>"   # optional; read-only computed field
    notes: string                    # optional
```

**Closed formulas:** only named fields and a fixed operator set (e.g. `floor`, `+`, `-`, `*`, `/`, parentheses). No function imports, no I/O.

**Actors** (`world/actors/*.yaml`) reference `sheet: <id>` and may only set keys under `fields` that exist on that sheet.

## Scene schema

```yaml
id: string
name: string
grid:
  size: number          # pixels per cell (or abstract units)
  units: string         # e.g. ft
  type: square|hex
background: <sha256 hex>
layers:
  - id: string
    type: map|tokens|…
    asset: <sha256 hex> # optional
walls:
  - {x1, y1, x2, y2}
doors:
  - {x1, y1, x2, y2, open?: bool, locked?: bool}
lights:
  - {x, y, radius, bright}
spawns:
  - {id, x, y, label?}
tokens: []              # optional placed tokens
```

Asset references are **sha256 hex** of files in `world/assets/by-hash/`. Logical names live only in `world/assets/index.yaml`.

## Manifest (`build/manifest.json`)

```json
{
  "format_version": "0.1.0",
  "compiler_version": "0.1.0",
  "build_id": "<opaque id>",
  "files": {
    "<path relative to build/>": "<sha256 hex>"
  }
}
```

Validators re-hash listed files and require a match.

## Lock protocol (`campaign.lock`)

See `campaign.lock.example`. Modes: `play` | `prep` | `edit`. Exclusive write ownership:

- **play** → `state/`
- **prep** → `world/`
- **edit** → `build/`

Incompatible writers must refuse until the lock is released.
