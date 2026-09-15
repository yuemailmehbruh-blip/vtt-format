# vtt-format

Greenfield scaffold for a **native listen-server VTT**: campaign map layout + content-addressed asset library.

This repo is **format + tooling only**. No listen server, renderer, AI, or game client.

## Folder layout

```
vtt-format/
├── packages/campaign-format/   # hash-and-store + validate-campaign (Python)
└── examples/sample-campaign/   # reference campaign tree
    ├── build/                  # Editor output (compiled sheets, rules, manifest)
    ├── world/                  # Prep output (scenes, actors, journals, assets)
    ├── state/                  # GM-owned runtime (fog, combat, chat, autosave)
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
| **Live session state** | `state/` | GM / play runtime |

Assets are **content-addressed**: files live at `world/assets/by-hash/<sha256-hex>`. Logical names (`maps/docks-bg`) map to hashes in `world/assets/index.yaml`. Scenes reference hashes, never mutable paths.

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
3. Set `id`, `name`, `grid`, `background` (sha256 hex), `walls`, `doors`, `lights`, `spawns`.
4. Reference only hashes that exist under `world/assets/by-hash/`.
5. Run validate (below).

See `examples/sample-campaign/FORMAT.md` for the full scene schema.

## Four subsystems (later)

| Subsystem | Writes | Play calls AI? |
|-----------|--------|----------------|
| **Editor** | `build/` | No |
| **Prep** | `world/` | No |
| **Play** (listen server + client) | `state/` | **Never** — play never calls AI |
| **AI assist** (optional, offline) | scratch only | Out of band; not in the play path |

Sheets are **declarative YAML + closed formulas** (no arbitrary code). Content is addressed by hash.

## Validate

```bash
cd packages/campaign-format
python -m campaign_format.validate_campaign \
  --campaign ../../examples/sample-campaign
```

Checks: required dirs, sheet YAML parse, actor fields ⊆ sheet fields, scene asset hashes present, `build/manifest.json` hashes match build files.

## Non-goals (this scaffold)

- No listen server / netcode
- No renderer / Godot / Electron
- No AI / provider SDKs
- No game client

## License

Scaffold for inspection and zipping; treat as yours.
