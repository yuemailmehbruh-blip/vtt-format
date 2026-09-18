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
layout:                              # optional; from sheet builder (session visual sheet)
  widgets:
    - id: string
      shape: box|circle|button
      field: <field_name>           # box/circle
      label: string                 # button caption
      mode: trigger|toggle          # button
      function_id: string           # button → named graph entry
      x: number
      y: number
      w: number
      h: number
graph:                               # optional; automation + named functions
  nodes:
    - id: string
      kind: field|const|op|roll|entry
      # field: name + role source|output
      # const: value
      # op: +|-|*|/|floor|==|!=|<|>|<=|>=|and|or|not|if
      # roll: sides (default 20) — runtime sample
      # entry: name (function_id entry point)
      x: number
      y: number
  edges:
    - { id, from, to, toPort }
```

**Closed formulas:** only named fields and a fixed operator set (e.g. `floor`, `+`, `-`, `*`, `/`, comparisons `== != < > <= >=`, call-forms `if(a,b,c)` / `and` / `or` / `not`, parentheses). No function imports, no I/O. Truthiness: nonzero finite → true; 0/NaN/nonfinite → false.

**Actors** (`world/actors/*.yaml`) reference `sheet: <id>` and may only set keys under `fields` that exist on that sheet.

## Sheet builder (editor scratch)

WIP sheet-builder projects live under:

```
editor-scratch/sheets/<sheetId>.builder.json
```

Shape (v1):

```json
{
  "sheet_id": "player",
  "name": "Player Character",
  "fields": { "STR": {"type":"integer","default":10}, "STR_mod": {"type":"integer","formula":"floor((STR - 10) / 2)"} },
  "layout": { "widgets": [ {"id":"…","shape":"button","label":"Attack","mode":"trigger","function_id":"attack","x":0,"y":0,"w":88,"h":44} ] },
  "graph": { "nodes": [ {"id":"…","kind":"entry","name":"attack"}, {"id":"…","kind":"roll","sides":20} ], "edges": [] }
}
```

**Compile** writes/updates `build/sheets/<sheetId>.yaml` (fields + closed formulas + `layout` + `graph`; permissions stub preserved). Session sheets load layout widgets and run named functions from `graph` entry nodes.

Closed formula language (field-output graph → string): field names, number literals, `+` `-` `*` `/`, comparisons (`==` `!=` `<` `>` `<=` `>=`), parentheses, `floor(…)`, and call-forms `if(…)` / `and(…)` / `or(…)` / `not(…)`. Precedence: unary → `*` `/` → `+` `-` → comparisons; `and`/`or`/`not`/`if` are functions only. **Roll** / **entry** nodes are runtime-only (button functions) and must not feed formula field outputs. Cycles are rejected.

**Toggle proficiency pattern:** wire entry → field output so the button persists 0/1. Toggle **on** runs the function with `entryValue: 1`; **off** still runs with `entryValue: 0` (clears the field). Skill checks use `if(ath_prof, PB, 0)` or `ath_prof * PB`; expertise: `if(expertise, PB*2, if(prof, PB, 0))`.


## Scene schema

```yaml
id: string
name: string
grid:
  size: number          # pixels per cell (or abstract units)
  units: string         # e.g. ft
  type: square|hex
background: <sha256 hex>   # legacy; used as bottom map layer if no type:map layers
layers:
  - id: string
    type: map            # map image layer (list order = bottom → top)
    name: string
    asset: <sha256 hex>
    visible: true
    x: 0                 # optional offset
    y: 0
    # w/h optional; if missing, use image natural size (tiny placeholders stretch)
  - id: tokens
    type: tokens         # optional metadata only — does NOT control draw order
walls:
  - {x1, y1, x2, y2}
doors:
  - {x1, y1, x2, y2, open?: bool, locked?: bool}
lights:
  - {x, y, radius, bright}
spawns:
  - {id, x, y, label?}
tokens: []              # optional placed tokens (schema placeholder)
```

Asset references are **sha256 hex** of files in `world/assets/by-hash/`. Logical names live only in `world/assets/index.yaml`.

### Fixed draw order (GM Session)

YAML `layers` entries of `type: tokens` (or similar) are **not** used for z-order.
The play view renderer always draws:

1. **Map image layers** (`type: map`, list order = bottom → top; visibility per layer)
2. **Grid overlay** — togglable in the UI
3. **Tokens** — white circles from `state/tokens/`
4. **Additions** — stub (`drawOverlayAdditions()`); empty for now
5. **Layer edit chrome** — selection/handles when editing a map layer (edit UI only)

Play view **does not** draw walls, doors, lights, or spawns (YAML fields may remain unused). Sidebar map-layer list is reversed vs array order (top of list = topmost / end of array).

UI prefs (grid / snap) live under `state/ui/<scene-id>.json`.

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

## Human sheet documents (session library)

Actor YAML may reference a human-facing sheet document:

```yaml
id: dock-tough
sheet: npc
sheet_doc: world/actors/dock-tough.sheet.txt
name: Dock Tough
fields: { … }
```

- `sheet` — schema id under `build/sheets/<id>.yaml` (validated; actor `fields` ⊆ sheet fields)
- `sheet_doc` — campaign-relative path to a blank/placeholder text document opened in the GM Session library panel

Default convention when omitted: `world/actors/<actor-id>.sheet.txt`.

## Placed tokens (play / GM session)

Runtime token placements for a scene are stored under:

```
state/tokens/<scene-id>.json
```

Play owns `state/`; Prep-owned `world/scenes/*.yaml` may keep `tokens: []` as a schema placeholder. The offline GM Session app reads/writes only `state/tokens/`.
