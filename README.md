# vtt-format

Greenfield scaffold for a **native listen-server VTT**: campaign map layout + content-addressed asset library.

This repo is **format + tooling + offline GM Session foundation**. No listen server, AI, or multiplayer yet.

## Folder layout

```
vtt-format/
├── apps/gm-session/            # offline DM session (map + library + tokens)  ← primary
├── apps/grid-viewer/           # minimal tile-grid map preview only
├── packages/campaign-format/   # hash-and-store + validate-campaign (Python)
└── examples/sample-campaign/   # reference campaign tree
    ├── build/                  # Editor output (compiled sheets, rules, manifest)
    ├── world/                  # Prep output (scenes, actors, journals, assets)
    ├── state/                  # GM-owned runtime (fog, combat, chat, tokens, autosave)
    ├── prep-scratch/           # Prep WIP (not play)
    ├── editor-scratch/         # Editor WIP (not play)
    ├── campaign.lock.example   # play | prep | edit lock protocol
    └── FORMAT.md               # scene + sheet schemas, lock notes
```

### Map vs library

| Concern | Location | Who writes |
|---------|----------|------------|
| **Map / world content** | `world/` — scenes, actors, encounters, journals | Prep |
| **Asset library** | `world/assets/by-hash/` + `index.yaml` | Prep / Editor via hash-and-store |
| **Compiled rules & sheets** | `build/` | Editor |
| **Human sheet docs** | `world/actors/<id>.sheet.txt` (via actor `sheet_doc`) | Prep / GM Session |
| **Live session state** | `state/` — including placed tokens under `state/tokens/` | GM / play runtime |

Assets are **content-addressed**: files live at `world/assets/by-hash/<sha256-hex>`. Logical names (`maps/docks-bg`) map to hashes in `world/assets/index.yaml`. Scenes reference hashes, never mutable paths.

## GM Session (offline DM foundation)

Desktop app (**pywebview**): editable map layers + grid/snap toggles + library sidebar + drag-to-place tokens + **Update app** (upgrades the installed program). Sheets open as separate desktop windows. Blank sheet docs live under the campaign path.

```bash
pip install -r packages/campaign-format/requirements.txt
pip install pywebview
python apps/gm-session/desktop_app.py --skip-update
```

Browser debug only (`serve.py` — no sheet pop-outs):

```bash
python apps/gm-session/serve.py
# open http://127.0.0.1:8765/?scene=docks
```

- Library lists actors from `world/actors/` (sample: dock-tough, party-fighter, blank-npc)
- Each actor has a human sheet at `world/actors/<id>.sheet.txt`
- Drag an actor onto the map → white circle token (`size_tiles` diameter); placements persist in `state/tokens/<scene>.json`
- Click an actor → sheet window (desktop app) with **Sheet** + **Appearance** tabs; Save writes `.sheet.txt` / actor appearance
- Select tokens on the map; header dice tools (1–x and bell-curve sample)
- Auto-update on launch via GitHub Releases (`GM-Session-Setup.exe`); see `apps/gm-session/README.md`
- Play view draws map layers + grid + tokens only (walls/doors/lights/spawns are not rendered)

See `apps/gm-session/README.md` for API, controls, and disk paths.


## Windows installer

Double-click install on Windows 10/11 (no system browser):

1. On a Windows build machine, run `packaging/windows/build.ps1` (needs Python + pywebview; Inno Setup 6 for the Setup.exe).
2. Transfer `packaging/windows/output/GM-Session-Setup.exe` to the target PC.
3. Double-click **GM-Session-Setup.exe**, then launch **GM Session** from the Start Menu.
4. Publish for auto-update: `gh release create v0.5.0 packaging/windows/output/GM-Session-Setup.exe`

The installer places an editable `campaign\` folder next to the app (sample campaign). See `packaging/windows/README.md` for details.

## How to add an asset

```bash
cd packages/campaign-format
pip install -r requirements.txt   # PyYAML

# Store a file into a campaign's library and update index.yaml
python -m campaign_format.hash_and_store \
  --campaign ../../examples/sample-campaign \
  --file /path/to/image.png \
  --name maps/my-bg
```

This copies the file to `world/assets/by-hash/<sha256>`, upserts `name -> hash` in `index.yaml`, and prints the hash.

## How to add a scene

1. Place any background (or other) assets with `hash-and-store`.
2. Copy `world/scenes/docks.yaml` as a template.
3. Set `id`, `name`, `grid`, `layers` (`type: map` + asset hash; legacy `background` still works), `walls`, `doors`, `lights`, `spawns`.
4. Reference only hashes that exist under `world/assets/by-hash/`.
5. Run validate (below).

See `examples/sample-campaign/FORMAT.md` for the full scene schema.

## Four subsystems

| Subsystem | Writes | Play calls AI? |
|-----------|--------|----------------|
| **Editor** | `build/` | No |
| **Prep** | `world/` | No |
| **Play** (listen server + client; offline GM Session today) | `state/` | **Never** — play never calls AI |
| **AI assist** (optional, offline) | scratch only | Out of band; not in the play path |

Sheets are **declarative YAML + closed formulas** (no arbitrary code) under `build/sheets/`. Human-facing sheet documents for the session library live beside actors under `world/actors/`. Content-addressed assets use hashes.

## Validate

```bash
cd packages/campaign-format
python -m campaign_format.validate_campaign \
  --campaign ../../examples/sample-campaign
```

Checks: required dirs, sheet YAML parse, actor fields ⊆ sheet fields, scene asset hashes present, `build/manifest.json` hashes match build files.

## Grid viewer (map-only preview)

Minimal browser preview for a scene tile grid (walls / doors / lights / spawns). Prefer **GM Session** for the DM workflow.

```bash
python apps/grid-viewer/serve.py
# open http://127.0.0.1:8765/?scene=docks
```

## Non-goals (this scaffold)

- No listen server / netcode / multiplayer
- No fog of war, dice, player client, or fancy art
- No AI / provider SDKs
- No Electron / Node packaging (Windows uses PyInstaller + Inno; elsewhere `serve.py`)

## License

Scaffold for inspection and zipping; treat as yours.
