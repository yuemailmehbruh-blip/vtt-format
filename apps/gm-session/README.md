# GM Session (offline)

Local, offline **DM session** foundation: tile-grid map canvas, library sidebar of campaign actors/sheets, and drag-to-place white-circle tokens.

No AI, no listen-server / multiplayer, no Prep/Editor apps — just the play-side map + library loop against a campaign folder on disk.

## Requirements

- Python 3.10+
- PyYAML (`pip install -r ../../packages/campaign-format/requirements.txt`)
- **Desktop app:** `pywebview` (`pip install pywebview`) — Edge WebView2 on Windows
- **Browser debug only:** `serve.py` (no sheet windows)

Version is in `VERSION` (currently **0.6.16**).

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
| GET | `/api/mechanics` | List campaign mechanics library (`editor-scratch/mechanics/*.json`) |
| GET | `/api/mechanics/<name>` | Load one mechanic JSON |
| PUT | `/api/mechanics/<name>` | Save/overwrite mechanic (body.name must match) |
| DELETE | `/api/mechanics/<name>` | Remove mechanic from library |
| POST | `/api/sheet-builder/<id>/import-mechanic` | Import library mechanic onto sheet (remap ids; 409 if name exists) |
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

## 0.7.2 — Updates never touch campaign data; shared Rolls & Chat with modifiers; players add their characters, select any token

- **Campaign data is never reset by an update.** Up to 0.7.1 the campaign lived in `{app}\campaign` and the installer seeded the sample campaign into it on *every* install with `onlyifdoesntexist`: it never overwrote an existing file, but it re-created every sample file the GM had deleted (the `docks` scene, sample actors, `state/tokens`/`state/ui` files, `build/sheets/npc.yaml`, `editor-scratch/sheets/player.builder.json` — a re-seeded builder scratch file wins over the campaign's compiled sheet in the builder, so the campaign's sheet template could look reset). With `{app}\campaign` missing the app silently edited the bundled sample inside `{app}\_internal`, which every install replaces. Now:
  - The campaign lives in **`%LOCALAPPDATA%\GM Session\campaign`** (outside anything the installer/uninstaller owns). On the first 0.7.2 start the old `{app}\campaign` is **copied** there once (copy to a temp folder, every file hash-verified, then renamed; a record is written to `%LOCALAPPDATA%\GM Session\moved-from-install-folder.json`). The old folder is never modified or deleted and stays as a fallback. Idempotent: once the new campaign exists it is used as is. `--campaign <path>` still overrides.
  - The installer installs **no** campaign files and has no `[InstallDelete]`/`[UninstallDelete]` entries. The bundled sample is only copied to create a brand-new campaign when none exists anywhere; it is never merged into an existing one.
  - **`campaign-schema.json`** (campaign root) records the campaign format version (now 2). Migrations run once, in order, only when the recorded version is lower, and must be additive (keep every user value, back up what they rewrite; the 0.6.19 maps/scenes split is migration 1). Missing marker = pre-0.7.2 (the idempotent migrations run once, then the marker is written). An unreadable marker or one from a newer app means no migration runs and nothing is rewritten.
  - **Parse failures never cause a rewrite**: an unreadable `state/tokens/<scene>.json` is reported and token saves are refused (409) until it is fixed; an unreadable `world/players.yaml` is never overwritten (player changes are refused); unreadable `state/ui` prefs are copied aside (`*.unreadable-<time>`) before being replaced; unreadable scenes are skipped by migrations. Token saves keep token keys the client doesn't know (forward-compatible).
  - The campaign's own sheet templates (`build/sheets/*.yaml`, `editor-scratch/sheets/*.builder.json`) are part of the campaign; the shipped default template is only used for a brand-new sheet id.
  - Forgetting a player also drops its sync bookkeeping (acks/pending full syncs in `state/sync`).
  - Regression test `tests/upgrade-preservation.py`: a populated 0.7.1-shaped campaign (maps, scenes, tokens, actors with custom values + notes, custom sheet template + builder scratch, a 2nd custom sheet, folders, players, chat, sync state, deleted sample items) and a 0.6.x-shaped campaign go through the 0.7.2 first start + every read endpoint; byte-for-byte preservation (0.6.x scenes: every key kept, image layers/grid moved to the map, byte-exact backups).
- **Player Rolls & Chat = the GM's Rolls & Chat window** — one shared component (`rolls-chat.js` + `rolls-chat.css`) mounted by the GM pop-out (`rolls.html`) and by the player's sidebar, so markup, styles and behaviour are identical (dice 1–N, bell curve, session chat, message box). Only **Clear** stays GM-only. The GM pop-out's title bar now reads "Rolls & Chat" (and the map button "🎲 Rolls & Chat").
- **Constant modifier on rolls (GM and players)** — the Dice and Bell curve rollers each have a `+` box (any integer, negative subtracts). Posted as e.g. `1d20 + 3 → 17 (14 + 3 = 17)`. Sheet-triggered rolls are unchanged (they carry their own formula).
- **Players add their characters to the map** — drag one of your characters from the Characters sidebar onto the map, or select it and press **Add to map** (view centre). Validated on the GM (`POST /player/api/token-place`): only characters assigned to you, only the GM's current scene, finite coordinates, snapped with the GM's setting, ≤6 per 10 s. If the character already has a token in that scene it is moved (drag) or selected and centred (button) — never duplicated. Pushed live to the GM and other players.
- **Players can select any token** — click any token to highlight it; the top bar shows its name and size ("view only" for tokens that aren't yours). Other tokens still can't be moved (dragging pans) and double-clicking them opens nothing.

## 0.7.1 — Player map, shared chat, player token moves, Copy join IP

- **Player app: Join window → session window** — GM Session Player opens a small Join window (address, name, join code; remembers the last address/name). On a successful join it closes and the player session window opens. **Leave** returns to the Join window.
- **Player session window = the GM window in player mode** — same `index.html`/`session.js` rendering (no fork), served by the player app with `GM_PLAYER_MODE`. Shows the GM's **active scene** (the scene open in the GM map window): map layers with scale/flip/rotate, grid, tokens with images/crops, labels and auras. Free local pan/zoom (fit-to-view on first load); never synced to the GM's view. No fog of war; walls/doors/lights and other GM data are not sent. Sidebar: **Characters** (only your assigned sheets; double-click opens the sheet with the 0.7.0 delta sync; **Full Sync → GM**), then **Rolls & Chat**. Connection status and last sync in the top bar.
- **Players move their own tokens** — a player can drag tokens whose character is assigned to them (dashed outline + move cursor; other tokens are look-only). Snapped with the GM's snap setting for that scene. Sent to the GM (`POST /player/api/token-move`, player auth), validated there (token exists in the active scene, owned via assignment, finite coordinates within ±1,000,000, ≤20 moves / 5 s), written to `state/tokens/<scene>.json`, and pushed to the GM map window and every player. Last move received wins. The GM map window now saves only the tokens it changed (merge save), so a player's move made meanwhile is never overwritten by a stale GM copy.
- **Live map push** — the GM keeps a player view of the active scene (`live_session.py`), rebuilt when the scene/map/tokens/actor files change (file watcher every 0.25 s) and on player moves; a revision counter wakes long-polls on the player port (`/player/api/wait`). Players fetch the view and map images by hash (only assets the view references; cached locally). The GM map window long-polls `/api/live` to show player moves.
- **Shared session chat** — one authoritative log on the GM, `state/chat/session.jsonl` (sender name/id/role, kind message|roll, text or roll label/result/detail, server timestamp, sequence id). Players post from the sidebar (message box + dice roller) and from sheet buttons/automations; the GM's **Rolls & Chat** window (formerly Rolls) shows the same log, with a message box, and its dice/bell rolls and GM sheet rolls go into it. Pushed via the same long-poll (measured 3–20 ms on localhost). Validated at the boundary: player auth, 500-char messages, roll label/detail/result limits, 8 posts / 10 s per player; always rendered as text (no HTML). **Clear** moves the log to the campaign trash. Player rolls are computed on the player's computer (trust-based).
- **Security** — all new player endpoints live only on the player port and require the player id + secret; no GM API is reachable there. Only data needed to draw the scene is exposed (layers, grid, tokens, token actors' name/appearance/aura values).

- **Copy join IP** — compact button in the top bar (next to **Players**) copies the most likely join address as exactly `ip:port` (e.g. `192.168.4.227:8766`) with a brief "Copied ✓".
- **Players dialog** lists every non-loopback IPv4 address with its own **Copy** button, most likely LAN address first (tagged "most likely"). Ranking: private range (10/8, 172.16/12, 192.168/16) on an adapter with a default route → other private → non-private; virtual adapters (vEthernet/Hyper-V/WSL, VirtualBox, VMware, Tailscale/100.64/10, ZeroTier, Docker, WireGuard/TAP…) are labelled and ranked last; loopback/link-local skipped (`net_addrs.py`; Windows uses Get-NetIPAddress/Get-NetRoute/Get-NetAdapter, cached 30 s).
- **Clipboard that works in the desktop app** — tries the webview clipboard, then the desktop bridge (`copy_text` → Windows clipboard API), then a local `POST /api/clipboard` (GM server only, same-origin, accepts only `host:port`-shaped text), then legacy copy.
- **Tests** — `tests/join-addresses.py` (ranking, virtual-adapter detection, `/api/players` address order, clipboard endpoint validation); `tests/live-session.py` (chat validation, log/epochs, long-poll wake, snap parity); `tests/live-integration.py` (real GM + two real player processes: map push, asset fetch, scene switch, token-move ownership/snap/bounds/merge, chat round trips and boundary, player-port isolation).

## 0.7.0 — GM Session Player

- **New app: GM Session Player** (`apps/player-session/`, installer `GM-Session-Player-Setup.exe`, own install dir + Start menu entry, same version). Players enter the GM's address (`host:port`) and a display name, receive the characters the GM assigns them, and edit them with the same sheet renderer/runtime as the GM (buttons, automations and rolls run locally). Sheets are stored in `%LOCALAPPDATA%\GM Session Player` so they open and edit offline.
- **GM hosting** — GM Session now also listens for players on `0.0.0.0:8766` (a separate listener that only serves `/player/api/*`; the GM UI/API stays on loopback `127.0.0.1:8765`). Flags: `--player-port`, `--player-host`, `--no-players`. The installer adds an inbound firewall rule for TCP 8766 when run elevated; otherwise Windows asks once ("allow on private networks" → Allow).
- **Players button** (top bar) — shows who is online and the last sync time, the address players connect to, an optional **join code**, and **Forget** per player.
- **Assign to player…** (character right-click menu) — tick known players; assigned characters show a 👤 badge with the player names. Per player: **Send full sheet…** (confirm) replaces that player's copy with yours. Assignments persist in `world/players.yaml`.
- **Sync every 2 s, delta-based** — each side keeps a per-sheet change log of field-level changes `{key, value, HLC stamp, origin}`; each round sends only unacknowledged entries and acks trim the logs. Same-field conflicts: the newer edit by hybrid logical clock wins (not wall-clock). Synced: every sheet field value and the notes text (both ways), the character name (GM → player). Not synced: appearance/token image, the sheet layout itself (sent read-only to the player and refreshed when it changes), rolls/chat.
- **Offline** — player edits queue in the local log (also across restarts) and go across on the next successful sync.
- **Full Sync** — player app: **Full Sync → GM** (confirm) overwrites the GM copy of that sheet; GM: **Send full sheet…** overwrites the player copy.
- **Security boundary** — players authenticate with a per-player secret issued at join (only its SHA-256 is stored); every request is checked against the assignment list; only `fields.*` and `notes` are player-writable; malformed input is rejected as a whole (400), unassigned sheets 403, bodies over 1 MB 413. GM endpoints are not served on the player port at all. Traffic is plain HTTP on your LAN (no TLS).
- **GM sheet window** refreshes live (2 s) when a player changes a value.
- **Tests** — `tests/sync-core.py` (clock, log, merge, conflicts both orders, offline queue, ack trimming, full sync both ways), `tests/player-integration.py` (real GM server + real player process over HTTP), `tests/player-boundary.py` (403/401/404/400/413 boundary).

## 0.6.20

- **Select, then act** — single click selects any sidebar row (map, character, scene, folder) with a clear highlight (accent fill + left bar); one selection at a time across the three panels. **Double-click a character to open its sheet**, double-click a scene to open it; maps and folders keep double-click / F2 rename. Folders collapse from their caret/icon (or Enter); Enter also opens the selected character/scene.
- **Delete key** — deletes the selected sidebar item. Characters, maps and scenes ask first in an in-app dialog (no browser popup) that says what will happen; folders delete immediately and their contents move up one level (as before). Delete is ignored while typing, and it follows the region you last clicked: after clicking the map it removes the selected token/layer as before; after clicking the sidebar it acts on the sidebar selection.
- **Deletes go to the campaign trash** — files are moved, never hard-deleted, to `state/trash/<time>-<kind>-<id>/files/<original path>` with a `manifest.yaml` (what moved, side effects, how to restore). Deleting a *character* moves its actor + sheet files and removes its tokens from every scene (saved in the manifest per scene) and closes its sheet window; deleting a *map* sets `map: null` on scenes that used it (they keep grid, walls, tokens); deleting a *scene* moves it with its per-scene state (tokens, view settings, …) and the map view switches to the first remaining scene, or an empty "No scene" state. `DELETE /api/actor|map|scene/<id>`.
- **Character rename moved to the sheet** — sheet → **Appearance → Name** (Enter or Rename). Same effect as 0.6.19: id unchanged; name, `fields.name` (if it matched), derived token names/labels on every scene, the sheet window title and the sidebar all update live. Characters are no longer renamed from the sidebar (F2 there points you to the sheet).
- **Tests** — `tests/sidebar-delete.py` (trash layout, byte-identical preservation, token removal on every scene, map detach keeps grid, scene state moved, 404/traversal).

## 0.6.19

- **Three sidebar panels** — the GM window's sidebar is now **Maps**, **Characters** and **Scenes**, each with its own header (caret / title click collapses or expands it). Panel collapse is a GM UI pref saved in `state/ui.json` (`sidebarCollapsed`), so it survives restarts. The Maps panel also holds the existing layer tools as **Scene map layers** (the image layers of the map the current scene uses).
- **Maps are first-class** — a *map* is a reusable image stack + grid in `world/maps/<id>.yaml` (`{id, name, grid, layers:[{id, name, asset, visible, x, y, w?, h?, flipX?, flipY?, rotation?}]}`). A *scene* (`world/scenes/<id>.yaml`) references one with `map: <id>` (or `map: null`) and keeps walls/doors/lights/spawns and non-image layers; tokens stay in `state/tokens/<scene>.json`. Several scenes can share a map; editing a layer edits the map (and every scene using it). `GET /api/scene/<id>` returns the resolved view (map grid + layers), so the canvas code is unchanged; `PUT /api/scene/<id>/layers` writes image layers into the map (a map-less scene gets one created on its first layer).
- **Load-time migration** — on start, each legacy scene (no `map:` key) is split into scene + map, reproducing exactly what the old view showed (typed map layers, or the `background` fallback as "Base map"), and gets `map:` pointing at it. The original scene file is copied first to `state/migrations/0.6.19/scenes/<id>.yaml`; nothing is deleted; token/actor/ui files are not touched; a second run is a no-op; errors never block startup. Report at `GET /api/migration`.
- **Folders** — every panel has **+ Folder**; folders nest (max 16 deep), collapse/expand (state saved), rename, and **Delete folder** moves its contents up one level (never deletes items). Drag items and folders onto a folder (into it), above/below a row (reorder) or onto empty space (top level); a folder can't be dropped into itself. Stored as commented YAML in `world/organization.yaml` (`maps` / `actors` / `scenes` trees); the server validates every write (`PUT /api/organization/<panel>`: ids, duplicates, names, depth) and re-adds any item missing from the tree, so sorting can never lose an item. Hand-edits are read leniently; an unreadable file is kept as `organization.unreadable-<time>.yaml` before being rewritten.
- **Create** — **+ Map** imports an image through the existing import flow (honors **Has grid** grid-fit) into a new map; **+ Char** creates a blank character (player sheet); **+ Scene** creates an empty scene. New items land in the selected folder and open straight into rename. Map right-click: **Use in current scene**, **New scene with this map**; scene right-click: **Detach map**. APIs: `POST /api/maps`, `POST /api/actors`, `POST /api/scenes`, `PUT /api/scene/<id>/map`.
- **Rename** — double-click, **F2**, or right-click → Rename on any map, character, scene or folder (Enter saves, Esc cancels). Ids never change; names are display only. Renaming a character updates its sheet `fields.name` (if it matched), token name/label on every scene where they were derived from the old name (custom token names are left alone), the open sheet window title, and the library. `POST /api/organization/rename`.
- **Kept** — click a character to open its sheet and drag it onto the map to place a token, as before. No player-visibility data is stored yet (player session comes later).
- **Tests** — `tests/campaign-model.py` (migration: background-only, user-like deleted-layer case, typed layers with transforms, id collisions, map-less scenes, backups, idempotency, untouched actors/tokens; organization validation/reconcile; create/rename/scene-map endpoints; token label follow), `tests/org-tree.mjs` (folder add/rename/delete-keeps-contents, moves, cycle/depth guards, collapse rows).

## 0.6.18

- **Token image import + crop** — sheet window → Appearance → **Import image** (png/jpg/webp/gif). The file is copied into the campaign (`POST /api/assets` → `world/assets/by-hash/<sha256>`, named `tokens/<actor>/<file>` in `world/assets/index.yaml`), never linked to the original path. A crop window shows the token frame (circle, its real tiles-across) over the image: drag to pan, wheel / − + to zoom, **Fit** (cover), snaps **Center** (both axes) and **Left / Right / Top / Bottom** (one axis; the other is kept), plus the map layers' **Scale (H/V tiles) / Flip H / Flip V / Rotate**. **Save** stores the transform, not baked pixels: `appearance.image = {asset, name, crop: {x, y, w, h, flipX, flipY, rotation}}` in the actor YAML, in *frame units* (token bbox = 0..1) so it holds at every zoom and token size. **Edit crop** reopens it; **Remove image** restores the white circle. Per actor: every token of that actor shows it.
- **Shared transforms** — new `image-xform.js` (`ImageXform`) holds the draw/flip/rotate/scale-to-tiles logic the map layer controls used inline; map layers and token crops both use it.
- **Auras / emanations** — Appearance → **Add emanation** (max 3; button disables at 3), each with On toggle, color picker (distinct defaults), opacity slider 0–100%, Remove. Stored as `appearance.auras = [{slot, color, opacity, enabled}]`. Radius is the sheet field `AURA1_RADIUS` / `AURA2_RADIUS` / `AURA3_RADIUS`, in grid squares beyond the token's edge (0 = no ring). The fields read as 0 until set and work like any field in Automations (Field nodes, formulas, `+=`/`-=`, `[x]` macros like `bump_[x]` → `[x]_RADIUS`, buttons/toggles); the Appearance radius box writes the same field. The sheet publishes changes live to the map (BroadcastChannel / pywebview `aura_fields_changed`). Map draws filled circles under tokens with a stronger edge, sized with `scene.grid.size` (map layer scaling doesn't change the grid pitch). Logic in `token-auras.js`.
- **Default player-sheet template** — new sheets (builder opens an id with no YAML/scratch) start from the bundled `defaults/player-sheet.builder.json` (fallback `defaults/player-sheet.yaml`), a snapshot of the GM's player sheet; `_source: "template"`, and the legacy STR→STR_mod sample is no longer injected. Existing sheets are unchanged.
- **Packaging** — `build.ps1` passes `apps/gm-session/VERSION` to ISCC (`/DMyAppVersion=…`, `#ifndef` in `gm-session.iss`) so Windows' installed-apps list shows the real version; pip/PyInstaller run with `ErrorActionPreference=Continue` plus explicit `$LASTEXITCODE` checks. The installer now seeds `{app}\campaign` with `onlyifdoesntexist uninsneveruninstall`, so updates no longer overwrite a GM's sheets/actors/scenes with the sample campaign. (0.7.2: seeding removed entirely; the campaign moved to `%LOCALAPPDATA%\GM Session\campaign`.)
- **Compat** — old saves without `image` / `auras` / `AURA*` fields load unchanged; token state files are unchanged (appearance lives on the actor).
- **Tests** — `tests/token-crop-auras.mjs` (crop snaps/zoom/scale/flip/rotate round-trip, aura max 3, automation → renderer radius, template compiles alongside aura automations), `tests/token-appearance-api.py` (asset copy, appearance persistence/sanitize, remove image, old-save compat, template for new sheets, existing sheets untouched).

## 0.6.17

- **Round op** — new one-input `round` node in the Automations palette (next to `floor`). Selecting it shows a **Mode** dropdown in the props bar (same `<select>` pattern as a Field's Role): **Up (ceil)**, **Down (floor)**, **Nearest (.5 rounds up)**. Stored as `mode: up|down|nearest` on the node (missing/unknown → `nearest`, so old sheets load unchanged). Node title shows `round↑` / `round↓` / `round`.
- **Nearest** is `Math.floor(x + 0.5)`: 2.5 → 3, -2.5 → -2, -2.6 → -3.
- **Closed formulas** gain `ceil(x)` and `round(x)`; compile emits `ceil(…)` / `floor(…)` / `round(…)` per mode, so formula fields, `[x]` formula macros, and the builder/sheet live previews all evaluate it. Send-arithmetic-to-chat shows `round↑(…)`, `round↓(…)`, `round(…)`.
- **Tests** — `tests/round-op.mjs` (all modes × positives/negatives/.5/integers, macro, downstream op, chat text, legacy default).

## 0.6.16

- **Dual-value boxes** — when a widget has distinct input/output IDs with an output formula, the sheet shows **only** the resolved display value until you click it; then a base number editor appears (bound to `input_id`, prefilled with `baseVal`, never the failed display `0`). Blur/Enter saves via `saveFields` and returns to output-only.
- **Delete key** — Sheet builder Display pane: Delete/Backspace removes the selected widget (graph selection still preferred when both active). Session map: Delete/Backspace removes the selected token (persisted), or if no token but a layer is in Edit, runs the existing delete-layer confirm. Ignored while typing in inputs.
- **Infer grid from walls** — new sidebar button next to Has-grid / Add layer. Detects long dark/high-contrast wall-like segments on the editing (or top visible) map layer, collapses double-line wall pairs to centerlines, and applies pitch/phase when **>50%** of wall length aligns to a candidate square grid (reuses Has-grid `gridFitImage` alignment). Status reports pitch and match %; failure clears with an explanation. Existing Has-grid printed-line detection unchanged.
- **Resource adjust ops** — new binary `+=` / `-=` in the Automations palette (same as `+`/`−` at runtime: `(a,b)→a±b`). Compile expands them to `+`/`−` for closed-formula compatibility. Pattern: Field HP → Const 1 → `-=` → Output HP on a trigger.
- **Tests** — `+=`/`-=` in `evaluate-logic-ops.mjs`; synthetic wall-grid scoring in `infer-grid-from-walls.mjs`.

## 0.6.15

- **Live macro [x] bind** — `resolveWidgetValue` / `widgetHasOutputValue` derive macro IDs via `bindMacroId` on formula-macro output templates (not raw `input_id`), so `STAT_STR_base` no longer expands as `[x]`.
- **recomputeLive compiles graph** — merges `compileGraph` formulas (prefer compiled) so macros apply when schema formulas are missing/stale.
- **Editable bases protected** — dual widgets (`input_id !== output_id`) never put `input_id` in the formulas map (stops short `STAT_[x]` from stealing the base).
- **Single-input paint** — box/circle editable inputs use `baseVal`, not `displayVal`.

## 0.6.14

- **Label + Input/Output IDs** — box/circle: **Label** (sheet caption), **Input ID** (editable base field), **Output ID** (automation/display field). Sheet shows Label; automations use the IDs. `field` aliases `input_id`.
- **No Create/Receive** — every box/circle is dual-value. Display = resolved `output_id` when a formula/macro defines it, else fall back to `input_id`.
- **Session UX** — calculated primary + compact base editor when output is active; single editable when not.
- **Migrate** — `migrateDisplayWidget` maps 0.6.13 id/label/value_mode and legacy `field` into the new shape; strips `value_mode`.
- **Compile** — `syncLayoutFields` ensures both IDs in the field set for macro bind (e.g. STR + STR_mod).
- **Tests** — migrate + display fallback in `tests/display-widget-id-label.mjs`.


## 0.6.13

- **ID + Label** — box/circle props: **ID** (session caption / macro `[x]` argument) and **Label** (automation/schema key). Legacy `field` migrates to both; `field` remains an alias of `label`. Unique widget key is `uid` (so two widgets can share display ID `STR`). Buttons unchanged (`label` + `function_id`).
- **Label / Input ID / Output ID** — sheet caption vs editable base vs automation display key. Display falls back to input when output has no formula/macro.
- **Compile** — `syncLayoutFields` ensures input+output fields then `compileGraph`; session uses `resolveWidgetValue` (output-or-input fallback).
- **Tests** — `tests/display-widget-id-label.mjs`.

## 0.6.12

- **Compress naming** — Automations **Compress** accepts any selection of ≥1 nodes (no required Function entry). Props panel shows a name textbox (prefill = exactly one named entry in selection/ancestors, else empty); confirm with non-empty name → `graph.collapsed[].name` on the purple block. Expand/Delete unchanged.
- **Formula macros** — a collapsed group with **no** `entry`/`function` member is a formula macro. On `compileGraph`, output fields whose names contain `[x]` bind against existing `doc.fields` keys (`[x]_mod` + `STR_mod` → ID=`STR`), substitute `[x]`→ID in the member subgraph, and write closed formulas (non-editable). Display name need not include `[x]`. Two macros claiming the same field → clear error. Runtime `[x]` **function** templates (entry names) unchanged.
- **Tests** — `tests/compile-formula-macros.mjs`.

## 0.6.11

- **Delete / Backspace** — in Automations (not while typing in an input/textarea/select), deletes the current graph selection the same way as the Delete toolbar button (selected nodes, selected compressed block, or selected edge).
- **`[x]` template functions** — entry/function names and field names may include the literal token `[x]` (exactly one `[x]` in the entry name for matching). Button `function_id` `check_ATK` or `check_[ATK]` instantiates template `check_[x]`: runtime clones the reachable subgraph, replaces `[x]` in string node properties, then evaluates. Exact Trigger of a template name without an ID errors clearly. Prefer longest template name when multiple match.
- **Builder / Mechanics** — Compress/Publish keep template names; graph props hint notes `[x]` instantiation; Mechanics lists templates (marked) but Trigger without a concrete ID fails by design.
- **Tests** — `tests/evaluate-templates.mjs`.

## 0.6.10

- **Toggle → field flip** — layout `mode: toggle` and Mechanics **Toggle** flip actor field named by `function_id` / row name between **0** and **1** (persist via `saveFields`, recompute formulas, refresh UI). Pressed state comes from the field value. Does **not** call `evaluateNamedFunction`.
- **Trigger unchanged** — still runs the named automation.
- **Docs** — proficiency = toggle `function_id: atk_prof` + `if(atk_prof, …)`; no entry→output for the toggle itself.
- **Send arithmetic active path** — `include_arithmetic` detail formats only the taken arithmetic (`if` unwraps to the chosen branch; compare/and/or/not → bare 1/0), not the full logic tree.

## 0.6.9

- **Mechanics library** — campaign `editor-scratch/mechanics/<name>.json`; Sheet builder **Publish to library** exports a named Function (runtime closure) via PUT `/api/mechanics/<name>`.
- **Import on sheet** — Mechanics tab **Import…** lists library names not already on the sheet; POST `/api/sheet-builder/<sheet_id>/import-mechanic` remaps ids into builder scratch and updates `build/sheets/<id>.yaml` graph in place (no manual Compile). Duplicate entry name → 409.
- **Tests** — `tests/mechanics-remap.py`, `tests/mechanics-import-api.py`.

## 0.6.8

- **Mechanics tab** — character sheet window: Sheet | Mechanics | Appearance. Lists this sheet’s named graph entry/function nodes; Trigger calls `runNamedFunction`. (As of 0.6.10, Toggle flips field `name` 0/1 instead of running the function.)
- **Compress / Expand** — Automations multi-select (Shift/Ctrl-click); **Compress** folds any ≥1-node selection into a UI-only `graph.collapsed` block after you name it in the props panel (flat nodes/edges unchanged for runtime); **Expand** / double-click restores; Delete on a block removes members + record. Persisted in builder JSON. No-entry collapses are **formula macros** (see 0.6.12).

## 0.6.7

- **Logic ops** — graph/runtime ops `==` `!=` `<` `>` `<=` `>=` `and` `or` `not` `if` (results 1/0; truthiness = nonzero finite). Closed formulas gain the same call-forms and comparison operators (comparisons bind after `+−`).
- **Toggle entryValue** — `evaluateNamedFunction(..., { entryValue })` (default 1). Toggle **off** still runs the function with `entryValue: 0` so entry→field-output clears proficiency. Wire entry → output field for 0/1 persistence; skill rolls use `if` / `*`.
- **Tests** — `tests/evaluate-logic-ops.mjs` (compare/and/or/not/if, entryValue writes, closed formulas).

## 0.6.6

- **Ancestor reachability** — `evaluateNamedFunction` expands the forward-reachable set by walking incoming edges until closed, so source fields/consts wired into ops (e.g. `entry→roll→+←STR`) evaluate before the op. Kahn topo runs on the expanded set.
- **Send arithmetic to chat** — `send_to_chat` / `chat` prop `include_arithmetic` (UI: **Send arithmetic to chat**, default false). When true, message `detail` is an equation from the **active arithmetic path** of the input (`15 (d20) + 10 (STR) = 25`; `if` unwraps to the taken branch — see 0.6.10). When false, correct summed value still sends; detail stays roll-only as before.
- **Self-check** — `tests/evaluate-reachability.mjs` asserts the STR+d20 repro.

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

