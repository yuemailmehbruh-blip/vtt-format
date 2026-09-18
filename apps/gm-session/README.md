# GM Session (offline)

Local, offline **DM session** foundation: tile-grid map canvas, library sidebar of campaign actors/sheets, and drag-to-place white-circle tokens.

No AI, no listen-server / multiplayer, no Prep/Editor apps — just the play-side map + library loop against a campaign folder on disk.

## Requirements

- Python 3.10+
- PyYAML (`pip install -r ../../packages/campaign-format/requirements.txt`)
- **Desktop app:** `pywebview` (`pip install pywebview`) — Edge WebView2 on Windows
- **Browser debug only:** `serve.py` (no sheet windows)

Version is in `VERSION` (currently **0.6.5**).

## Run — desktop app (recommended)

From the **repo root** (`vtt-format/`):

```bash
pip install -r packages/campaign-format/requirements.txt
pip install pywebview
python apps/gm-session/desktop_app.py --skip-update
```

Opens a **pywebview** window titled “GM Session” (not Chrome / the system browser). Character sheets open as **additional desktop windows** via `window.pywebview.api.open_sheet(actor_id)`. Rolls open via `window.pywebview.api.open_rolls()` (single reusable window). Sheet builder opens via `window.pywebview.api.open_sheet_builder(sheet_id?)` (~1100×720).

| Flag | Default | Meaning |
|------|---------|---------|
| `--campaign` | beside-exe `campaign/` or sample | Campaign root with `world/` + `state/` |
| `--scene` | `docks` | Initial scene id |
| `--host` | `127.0.0.1` | Bind address |
| `--port` | `8765` | Bind port |
| `--skip-update` | off | Skip GitHub Releases update check |

Closing the main window stops the local HTTP server and exits (sheet, Rolls, and Sheet builder windows are closed too). Closing a sheet window only closes that sheet. Re-clicking the same actor focuses the existing sheet window. Re-clicking **Rolls** / **Sheet builder** focuses the existing window.

## Run — browser debug (`serve.py`)

```bash
python apps/gm-session/serve.py
```

Open the printed URL (e.g. [http://127.0.0.1:8765/?scene=docks](http://127.0.0.1:8765/?scene=docks)). Sheets **do not** pop out in the browser; the status line explains that the desktop app is required.

## UI

- **Header** — scene name + “GM Session (offline)” + **Grid** / **Snap to grid** + **Center|Corner** snap target / **Nametags** toggles (independent; default grid/snap/nametags ON, snap target **Center**; persisted in `state/ui/<scene-id>.json` as `showGrid`, `snapToGrid`, `snapTarget`, `showNametags`)
- **Left library** — Characters/Actors from `world/actors/*.yaml`; Scenes from `world/scenes/`; **Map layers** list
  - Entries with a human sheet file show a **sheet** badge
  - **Click** an actor → open its sheet window (**Sheet** tab = `.sheet.txt`; **Appearance** tab = token size in tiles + stubs for graphic/auras)
  - **Drag** an actor onto the map → place a white circle token labeled with initials + name; diameter = actor `appearance.size_tiles` (default 1); snaps per Center/Corner mode when Snap is on
  - **Map layers** — eye, **Edit**, reorder ↑ bring forward / ↓ send back, delete; list shows topmost first (array stays bottom→top); **Add layer** uploads png/jpg/webp/gif into `world/assets/by-hash/` and appends as new topmost. **Has grid** (beside Add layer): when checked, stage 1 is the 0.5.3 full-image printed-line comb fit, then a light 0.5.5-era center 3×3 sanity check (peakMed 1.08 / threshFrac 0.22 / 3-of-4 lines). If stage 1 is null or fails sanity, stage 2 runs 0.5.5 (center ROI + half-pitch + looser gate) with 0.5.12 pieces kept inside stage 2 only (`minP` floor 14, multi-candidate lags, 3-of-4). Stage 1 keeps classic `minP` floor 20. If both fail, import at natural size (0,0). Otherwise scale 1 printed cell = 1 map cell, align lines, crop to whole squares. When unchecked, import at natural size at (0,0). Map images draw fully opaque.
  - **Edit mode** (one layer at a time) — drag to move, corner/edge handles to resize (aspect locked). **Scale** opens a dialog for width/height in tiles; **Flip H** / **Flip V** / **Rotate** transform the layer. **Snap layers** (sidebar) snaps position/size to grid on release (not while dragging), independent of token snap.
- **Token snap** — free movement while dragging; on pointerup, if Snap to grid is ON, snap by mode: **Center** → cell centers (`floor(x/g)*g + g/2`); **Corner** → grid intersections (`round(x/g)*g`). Library drop / place uses the same mode. Mode is a segmented control next to Snap to grid; persisted as `snapTarget` (`"center"` | `"corner"`).
- **Canvas draw order** — map images → grid (if on) → tokens → additions stub → layer edit chrome (play view does not draw walls/doors/lights/spawns)
- **Token select** — click a token to select (accent ring); click empty map (without much drag) clears selection; double-click token opens that actor’s sheet; library “active” follows the selected token’s actor
- **Token size** — circle diameter in tiles (`size_tiles`); world radius = `(size_tiles * gridSize) / 2`. Canonical value on actor YAML `appearance.size_tiles`; copied onto tokens when placed; Appearance save updates all tokens for that actor on the current scene
- **Pan / zoom** — drag empty map to pan, wheel to zoom, double-click empty map to fit. Hit-test: edit handles/body → tokens → pan
- **Rolls** — bottom-right button over the map (Update app stays bottom-left). Opens a **pop-out window** (like sheets) with **Dice roll** (uniform 1–x), **Bell curve sample** (Normal μ,σ rounded), and session roll history (newest at bottom, auto-scroll; Clear; shared via `localStorage` key `gm-session-roll-history` + `BroadcastChannel('gm-session-roll')` / pywebview `session_roll`). Desktop: `open_rolls()`; browser `serve.py` falls back to `window.open('/rolls.html')`.
- **Update app** — fixed button bottom-left of the canvas; upgrades the installed program (not the map). Looks on GitHub Releases for a Setup.exe, downloads it, runs the installer, quits, then relaunches. Status text under the button tracks that. Browser `serve.py` has no updater API.

## Auto-update

On launch (unless `--skip-update`), the desktop app checks GitHub Releases for [`yuemailmehbruh-blip/vtt-format`](https://github.com/yuemailmehbruh-blip/vtt-format) and may show a confirm dialog if a *newer* version exists. The in-session **Update app** button **always** downloads and silently installs the latest Setup.exe (then relaunches), even when the local version already matches the release tag — it never reports “Up to date”.

1. `GET /repos/.../releases/latest` (then `/releases` if that has no Setup.exe)
2. Download the installer via the GitHub **API asset URL** (`Accept: application/octet-stream`). Auth is sent only to `api.github.com` — not to the S3 redirect (that 400s).
3. Write `%LOCALAPPDATA%\GM Session\install_update.ps1` and spawn it: wait for `GM Session.exe` to exit, run Inno `/SILENT /NORESTART /FORCECLOSEAPPLICATIONS`, then start the installed exe again (helper logs to `update.log`).
4. Quit the current app so files can be replaced.
5. Progress is written under the button and to `%LOCALAPPDATA%\GM Session\update.log`.

Launch-time still skips when already up to date. **Update app** never skips on version equality.

**0.5.6:** Update button always reinstalls; token draw/hit radius tracks the map grid (`≈0.45 × gridSize` in world, times zoom on screen).

Auth (for private repos): `GM_SESSION_GH_TOKEN` / `GITHUB_TOKEN`, `%LOCALAPPDATA%\GM Session\github_token.txt`, or GitHub CLI `hosts.yml`. Unauthenticated `/releases/latest` 404s on a private repo; the UI then says to put a token in that file. Failures are shown under **Update app**, not swallowed.

Publish after a Windows build:

```bash
gh release create v0.5.1 packaging/windows/output/GM-Session-Setup.exe \
  --title "GM Session 0.5.1" \
  --notes "Nametags toggle, opaque map layers, Has-grid import fit."
```

(`build.ps1` prints the exact command for the current `VERSION`.)

## Disk layout (sheets & tokens)

| Concern | Path | Who writes |
|---------|------|------------|
| Sheet **schemas** (YAML) | `build/sheets/*.yaml` | Editor / Sheet builder compile |
| Sheet builder WIP | `editor-scratch/sheets/<id>.builder.json` | Sheet builder (not play) |
| Actor instances (incl. `appearance.size_tiles`) | `world/actors/<id>.yaml` | Prep / GM Appearance save |
| Human sheet docs (blank `.txt` for now) | `world/actors/<id>.sheet.txt` (via actor `sheet_doc`) | Prep / GM session save |
| Placed tokens (session) | `state/tokens/<scene-id>.json` | GM Session (play) |
| UI prefs (grid/snap/snapTarget/nametags/snapLayers) | `state/ui/<scene-id>.json` | GM Session (play) |

Sample actors with sheet docs:

- `world/actors/dock-tough.yaml` + `dock-tough.sheet.txt`
- `world/actors/party-fighter.yaml` + `party-fighter.sheet.txt`
- `world/actors/blank-npc.yaml` + `blank-npc.sheet.txt`

Token file shape:

```json
{
  "scene": "docks",
  "tokens": [
    {
      "id": "dock-tough-…",
      "actor_id": "dock-tough",
      "name": "Dock Tough",
      "label": "DT",
      "x": 210,
      "y": 280,
      "size_tiles": 1
    }
  ]
}
```

Tokens reload from `state/tokens/` on refresh. Scene YAML may still declare `tokens: []` as a schema placeholder; **runtime placements live under `state/`** so play does not rewrite Prep-owned scene files.

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | App UI |
| GET | `/sheet.html` | Sheet pop-out UI (desktop window) |
| GET | `/sheet.js` | Sheet pop-out script |
| GET | `/rolls.html` | Rolls pop-out UI (desktop window) |
| GET | `/rolls.js` | Rolls pop-out script |
| GET | `/sheet-builder.html` | Sheet builder pop-out UI |
| GET | `/sheet-builder.js` | Sheet builder script |
| GET | `/api/sheet-builder` | List sheet ids (`build/sheets` + scratch) |
| GET | `/api/sheet-builder/<id>` | Load builder JSON (scratch or seed from YAML) |
| PUT | `/api/sheet-builder/<id>` | Save builder JSON → `editor-scratch/sheets/` |
| POST | `/api/sheet-builder/<id>/compile` | Compile → `build/sheets/<id>.yaml` |
| GET | `/api/library` | Actors + scenes for the sidebar |
| GET | `/api/scene/<id>` | Scene YAML as JSON |
| PUT | `/api/scene/<id>/layers` | Body `{"layers":[…]}` → rewrite only the `layers` key |
| POST | `/api/assets` | Raw image body + `Content-Type` + optional `X-Asset-Name` → hash into `world/assets/` |
| GET | `/api/sheet/<actor_id>` | Sheet text + path + `appearance` (from actor YAML) |
| PUT | `/api/sheet/<actor_id>` | Body `{"text":"…"}` → write `.sheet.txt` |
| PUT | `/api/actor/<actor_id>/appearance` | Body `{"appearance":{"size_tiles":N}}` → merge into actor YAML |
| GET | `/api/tokens/<scene_id>` | Placed tokens JSON (includes `size_tiles`) |
| PUT | `/api/tokens/<scene_id>` | Body `{"tokens":[…]}` → write `state/tokens/<id>.json` |
| GET | `/api/ui/<scene_id>` | UI prefs (`showGrid`, `snapToGrid`, `snapTarget`, `showNametags`, `snapLayers`) |
| PUT | `/api/ui/<scene_id>` | Persist UI prefs to `state/ui/<id>.json` |
| GET | `/assets/<sha256>` | Content-addressed asset |

## Relation to `apps/grid-viewer`

`grid-viewer` remains a minimal map-only preview. **GM Session is the primary play entry** for this scaffold.

## Windows desktop / installer

See `packaging/windows/` (PyInstaller + Inno Setup + pywebview). Entry point: `desktop_app.py`; shared HTTP APIs in `server_lib.py`; updater in `updater.py`.

## 0.5.7

- Has-grid: stronger doubled-pitch detection (mid-line sweep) and promote a bold every-5th major grid (e.g. Yester Hill 50ft squares) when present.

## 0.5.8

- Has-grid: require any 3×3 of cells on the lattice (full image), not only a center 3×3.

## 0.5.9

- Has-grid rolled back to the 0.5.3 printed-line comb fit (before center 3×3 / half-pitch / major-5th experiments). Update app and grid-locked tokens unchanged.

## 0.5.10

- Has-grid: stage 1 is the full-image 0.5.3 comb fit; stage 2 (center ROI + required center 3×3) runs only if stage 1 finds nothing. No half-tiling.
- Map layer list shows size in tiles under the name.
- Resize mode radios removed (aspect locked). Scale / Flip H / Flip V / Rotate buttons added.

## 0.5.11

- Has-grid: two-stage finder is now real **0.5.4 → 0.5.5** (center ROI + strict center 3×3, then half-pitch / looser 3×3 fallback). Drops the 0.5.10 stage-1 full-image 0.5.3 comb fit that could lock a wrong pitch and skip stage 2.
- Scale button: add the missing `#layer-scale-dialog` with horizontal/vertical tile inputs (CSS/JS were present in 0.5.10; markup was not).

## 0.5.12

- Has-grid: `minP` floor 20→14; multi-candidate lags (primary, other axis, 2×) so subharmonic autocorr peaks cannot block the true cell; stage 2 accepts 3-of-4 center comb lines (chat-sized Jahaka / water-center maps). Still 0.5.4→0.5.5 staging — not 0.5.8.

## 0.5.13

- Has-grid: two-stage is now **0.5.3 → 0.5.5** (not 0.5.4→0.5.5). Stage 1 = full-image 0.5.3 comb fit + light lattice sanity (0.5.5-era center 3×3, 3-of-4 / 1.08 / 0.22) so a wrong non-null pitch (Jahaka) cannot block stage 2. Stage 2 keeps 0.5.12 pieces (`minP` 14, multi-cand, 3-of-4, maybeHalve). Not 0.5.7/0.5.8.

## 0.5.14

- **Token selection** — click to select with accent ring; empty-map click clears; double-click opens sheet; library active follows selected actor.
- **Token size** — diameter in tiles (`size_tiles`, default 1); radius = `(size_tiles * gridSize) / 2` (replaces hard-coded 0.45). Stored on actor `appearance` and on each token; Appearance tab Save updates all tokens for that actor on the current scene.
- **Sheet Appearance tab** — Sheet | Appearance; token size input + stub sections (token graphic, auras). Map updates live via pywebview `appearance_saved` bridge and `BroadcastChannel('gm-session-appearance')`.
- **Dice tools** — header strip: uniform roll 1–x; bell-curve Normal(μ, σ) sample rounded to nearest integer.
- **Migration** — missing `size_tiles` → 1 (slightly larger than the old 0.9×grid diameter; acceptable).

## 0.5.15

- **Corner snapping** — Snap to grid keeps the checkbox; add **Center** | **Corner** segmented control (persisted `snapTarget`). Corner snaps token centers to grid intersections (`round(x/g)*g`); Center keeps cell centers.
- **Roll dock** — header dice strip removed. Bottom-right **Rolls** menu (Dice roll / Bell curve sample) with session roll history panel above it; Update app remains bottom-left.

## 0.5.16

- **Rolls pop-out** — bottom-right **Rolls** button opens a dedicated window (`rolls.html` / `open_rolls()`), matching character sheets. Inline popover/history chrome removed from the map; dice, bell sample, and history live in the pop-out.

## 0.5.17

- **Map chrome clicks** — `#update-bar` / `#roll-dock` sit above the canvas but viewport `pointerdown`/`dblclick` ignored `event.target`, so button clicks bubbled into pan and blank-space `fitToView`. Early-out via `isMapChrome()` plus `stopPropagation` on the bars; `pointer-events: auto` on both docks.

## 0.6.0

- **Sheet builder** — new pop-out window (`sheet-builder.html` / `open_sheet_builder`): display canvas (box/circle field widgets) + automation flowchart (closed ops only). Persist `editor-scratch/sheets/<id>.builder.json`; compile into `build/sheets/<id>.yaml` (optional `layout:` for future play renderer).
- **Out of scope (this release)** — full play-time rendered sheet replacing `.sheet.txt`; text widgets / images / auras; undo stack beyond basic; multi-page sheets.

## 0.6.1

- **Live sheet layout** — character sheet window shows builder widgets (box/circle/button) with live values; closed formulas (`floor`, `+−*/`) evaluate client-side; editable numbers PUT `/api/actor/{id}/fields`.
- **Roll buttons** — display tool **Add button** (`shape: button`, `action: {type:roll, sides:N}`); click rolls and toasts the result.
- **Field id text box** — builder display/graph props use a single text input for field id (no example dropdown); new widgets/nodes start with empty field.
- **GET `/api/sheet/{actor}`** also returns `sheet_id`, actor `fields`, schema fields/formulas, and `layout.widgets` (build yaml, editor-scratch fallback).

## 0.6.5

- **Builder formula preview** — display canvas widgets bound to formula fields show the evaluated default (e.g. `STR_mod` with `STR=10` → `0`) via `SheetRuntime.evalClosedFormula` + `previewFieldValues()`, not the literal `ƒ`. Props panel still shows the formula text.

## 0.6.4

- **Send to chat** — terminal graph node `send_to_chat` (palette **Send to chat**): one input, no output. Runtime returns `messages`; session history only via these nodes (rolls no longer auto-`publishRoll`). Sample Attack: `entry attack` → `roll d20` → `send_to_chat`.
- **Automations zoom/pan** — `#graph-svg` mirrors display: `#graph-root` translate/scale (`graphView`), wheel zoom, Zoom +/−/Reset, pan with middle-mouse / Space+drag / empty-space Select. Independent of `displayView`.

## 0.6.3

- **Builder zoom/pan** — display canvas: wheel zoom toward cursor; Zoom + / − / Reset; pan with middle-mouse, Space+drag, or empty-space drag (Select). Session-only (not saved).
- **Session fit-to-view** — character sheet sets SVG `viewBox` to the widget bounding box (padding) on load/resize; optional wheel zoom + Space/middle-mouse pan afterward.
- **Buttons → functions** — `shape: button` uses `mode: trigger|toggle` + `function_id` (named automation). Removed frontend `action: {type:roll, sides}`. Props: label, mode, function id; subtitle shows mode + function.
- **Automations Roll + Function** — graph nodes `kind: roll` (sides) and `kind: entry` (name). Runtime (`sheet-runtime.js`) resolves button `function_id` → entry, evaluates reachable DAG; rolls publish via `publishRoll`. Toggle: on runs function, off does not; pressed style in-session.
- **Sample** — Attack button `function_id: attack` → entry `attack` → roll d20; compile writes `graph` into `build/sheets/*.yaml`.

## 0.6.2

- **Sheet rolls → Rolls history** — layout button rolls publish to the Rolls pop-out session history (`Actor: Button` + `dN` detail) via shared `gm-session-roll` BroadcastChannel, `localStorage` (`gm-session-roll-history`), and desktop `session_roll` → `window.__gmAppendRoll`. History hydrates on Rolls reopen; Clear clears storage too. Sheet toast unchanged.

