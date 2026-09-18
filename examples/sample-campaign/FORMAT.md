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
    - uid: string                   # unique widget key (box/circle; optional on legacy)
      id: string                    # box/circle: display caption + macro [x] arg; button: unique key
      shape: box|circle|button
      label: string                 # box/circle: automation/schema field key; button: title
      field: <field_name>           # box/circle: alias of label (legacy / backward compat)
      value_mode: create|receive    # box/circle only (default: receive if field has formula else create)
      mode: trigger|toggle          # button
      function_id: string           # trigger → named graph entry; toggle → field name to flip 0/1
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
  collapsed:                         # optional; builder UI-only compress groups
    - { id, name, nodeIds: [string], x, y, w?, h? }
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
  "graph": { "nodes": [ {"id":"…","kind":"entry","name":"attack"}, {"id":"…","kind":"roll","sides":20} ], "edges": [], "collapsed": [] }
}
```

**Compile** writes/updates `build/sheets/<sheetId>.yaml` (fields + closed formulas + `layout` + `graph`; permissions stub preserved). Session sheets load layout widgets and run named functions from `graph` entry nodes.

Closed formula language (field-output graph → string): field names, number literals, `+` `-` `*` `/`, comparisons (`==` `!=` `<` `>` `<=` `>=`), parentheses, `floor(…)`, and call-forms `if(…)` / `and(…)` / `or(…)` / `not(…)`. Precedence: unary → `*` `/` → `+` `-` → comparisons; `and`/`or`/`not`/`if` are functions only. **Roll** / **entry** nodes are runtime-only (button functions) and must not feed formula field outputs. Cycles are rejected.

**Toggle proficiency pattern:** layout button `mode: toggle` + `function_id: atk_prof` flips actor field `atk_prof` between 0 and 1 (no graph entry→output required for the toggle itself). Skill formulas use `if(atk_prof, PB, 0)` or `atk_prof * PB`; expertise: `if(expertise, PB*2, if(prof, PB, 0))`. Trigger buttons still run named automations via `evaluateNamedFunction`.

**Session Mechanics tab:** the play sheet lists named `entry`/`function` nodes from that actor’s sheet graph (not campaign-wide). **Trigger** runs `evaluateNamedFunction`; **Toggle** flips field `name` 0/1 (does not invoke the graph even if an entry with that name exists).

**Builder compress:** `graph.collapsed` is UI metadata (`id`, `name`, `nodeIds`, geometry). Compress accepts any ≥1-node selection; the user names the block in the Automations props panel (prefill = exactly one named Function entry in selection/ancestors). Expand/Delete unchanged. Flat `nodes`/`edges` remain the source of truth for runtime evaluation.

**Formula macros vs function templates:**
- **Formula macro** — a collapsed group whose members include **no** `entry`/`function` node. Display `name` need not contain `[x]`. Internal field names may use `[x]` (e.g. source `[x]`, output `[x]_mod`). On Compile (`compileGraph`), for each such group, each output-role field template is matched against existing sheet field ids by substituting `[x]`→ID (example: template `[x]_mod` + field `STR_mod` → ID=`STR`). The member subgraph is compiled to a closed formula with all `[x]` replaced by that ID and written to `fields[F].formula` (non-editable). Invalid IDs are skipped; two macros claiming the same field id is an error.
- **Function template** — entry/function name contains `[x]` (runtime instantiate; see below). Compress name for those blocks can be any user-typed label (often the entry name via prefill).

**Display widgets (box/circle) — ID vs Label, Create vs Receive (0.6.13):**
- **ID** (`id`) — short identity shown as the caption on the session sheet and builder display canvas. Also the macro argument `[x]` when resolving receive values.
- **Label** (`label`) — automation / schema field key (field nodes, formulas, macros, `saveFields`). `field` is kept as an alias of `label` on save for backward compatibility. Legacy widgets with only `field` migrate to `label = field` and `id = field` (generated widget uids move to `uid`).
- **Buttons** keep existing `label` (title) + `function_id`; do not use create/receive.
- **`value_mode`:** `create` | `receive` (default: receive if the label field has a formula, else create).
  - **Create value** — session: editable number bound to `label`; compile ensures `fields[label]` as integer, editable, no formula (source variable).
  - **Receive value** — session: read-only calculated display. Resolve order: (1) `liveValues[label]` / schema formula for `label`; (2) else treat **ID** as macro `[x]`: expand formula macros with `[x]`→`id`; if an output name equals `label`, or `label` is empty/`=== id` and the macro has a primary output (prefer `{id}_mod`), evaluate that formula against the current env.
- **Example:** create box ID=`STR` Label=`STR`; receive box ID=`STR` Label=`STR_mod` → edits `STR`, shows `STR_mod` (from formula or `ability_mod` macro). Receive with ID=`STR` Label=`STR` shows the derived mod when STR itself is create-only.
- On **Compile / save**: create widgets `ensureField(label)` without formula; receive widgets ensure label (and display id as source); then `compileGraph` so macros bind to receive field keys.


**Parameterized `[x]` templates (v1):** an entry name may include exactly one literal `[x]` (e.g. `check_[x]`). Field names on that subgraph may also use `[x]` (e.g. `[x]_PROF`). A trigger button’s `function_id` is either the concrete form `check_ATK` or the bracket form `check_[ATK]` — ID must match `[A-Za-z_][A-Za-z0-9_]*`. Matching: exact entry name first; else templates whose `prefix[x]suffix` fits the call; if several match, prefer the longest template name; still tied → error. Exact call of a template name (still containing `[x]`) errors — buttons must supply the ID. Evaluation clones the reachable subgraph (forward + ancestors), replaces every literal `[x]` in string node props (except `id`), then runs as a normal function. Compress/Publish keep template names unchanged. Automations: **Delete** / **Backspace** (when not typing in an input) deletes the graph selection like the toolbar Delete button.


## Mechanics library (campaign)

Shared named functions live under:

```
editor-scratch/mechanics/<safe_name>.json
```

`safe_name` matches sheet id rules: `A-Za-z0-9_-` only.

Shape:

```json
{
  "name": "attack",
  "nodes": [ /* deep-copied subgraph; entry keeps name */ ],
  "edges": [ /* remapped ids */ ],
  "collapsed": []  // optional UI collapse for the block
}
```

**Publish** (Sheet builder → Automations → **Publish to library**): selection must resolve to exactly one named Function entry (same rules as Compress). Exports forward-reachable nodes from the entry plus incoming ancestors (same closure as runtime), remaps ids, and PUTs the document.

**Import** (play sheet Mechanics tab → **Import…**): POST `/api/sheet-builder/<sheet_id>/import-mechanic` with `{ "name": "attack" }`. Remaps ids into the sheet builder scratch (and updates `build/sheets/<id>.yaml` graph in place when present) so Mechanics lists the entry without a manual Compile. Duplicate entry name → HTTP 409.

APIs: `GET/PUT/DELETE /api/mechanics[/<name>]`, `POST /api/sheet-builder/<sheet_id>/import-mechanic`.

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
