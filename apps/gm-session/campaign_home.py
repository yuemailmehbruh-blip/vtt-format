"""Where the GM's campaign lives, and the explicit, run-once campaign schema (0.7.2+).

Why this exists
---------------
Up to 0.7.1 the campaign lived in ``{app}\\campaign`` (the install folder) and the
installer "seeded" the sample campaign into it on every install/update with
``onlyifdoesntexist``. That never overwrote an existing file, but it re-created every
sample file the GM had deleted (the ``docks`` scene, sample actors, token/ui files,
``build/sheets/npc.yaml``, ``editor-scratch/sheets/player.builder.json``...). A re-seeded
builder scratch file takes precedence over the campaign's compiled sheet in the
builder, so an update could make a campaign's sheet template look reset. When
``{app}\\campaign`` was missing, the app also silently fell back to editing the bundled
sample inside ``{app}\\_internal`` - which every install replaces.

0.7.2:

* The campaign lives in the per-user data folder (``%LOCALAPPDATA%\\GM Session\\campaign``
  on Windows), outside anything an installer or uninstaller owns.
* First start of 0.7.2 copies the old ``{app}\\campaign`` there once (copy to a temp
  folder, verify every file, then rename). The old folder is never modified or deleted
  and stays as a fallback. Idempotent: once the new campaign exists it is used as is.
* The bundled sample is only ever *copied* to create a brand-new campaign when none
  exists anywhere; it is never edited in place and never merged into an existing one.
* ``campaign-schema.json`` (campaign root) records the campaign format version.
  Migrations run once, in order, only when the recorded version is lower; each one
  must be additive (keep every user value, back up any file it rewrites). A missing
  marker means "pre-0.7.2" (idempotent migrations run once, then the marker is
  written). An unreadable marker, or one from a newer app, means no migration runs
  and nothing is rewritten.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import sys
import time
from pathlib import Path

logger = logging.getLogger("gm_session.campaign")

APP_DIR_NAME = "GM Session"
SCHEMA_FILE = "campaign-schema.json"
CURRENT_SCHEMA = 2
MIGRATION_RECORD = "moved-from-install-folder.json"


# --------------------------------------------------------------------- location

def user_data_dir() -> Path:
    """Per-user data folder for GM Session (override: GM_SESSION_DATA_DIR)."""
    env = os.environ.get("GM_SESSION_DATA_DIR")
    if env:
        return Path(env)
    if sys.platform.startswith("win"):
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_DIR_NAME
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "gm-session"


def is_campaign(p: Path) -> bool:
    return (Path(p) / "world" / "scenes").is_dir()


def _file_digests(root: Path) -> dict[str, str]:
    out = {}
    for p in sorted(Path(root).rglob("*")):
        if p.is_file():
            out[p.relative_to(root).as_posix()] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def copy_campaign_verified(src: Path, dest: Path) -> dict:
    """Copy ``src`` to ``dest`` via a temp sibling folder; verify every file's hash
    before the final rename. ``dest`` must not exist. ``src`` is only read."""
    src, dest = Path(src), Path(dest)
    if dest.exists():
        raise FileExistsError(str(dest))
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + f".partial-{os.getpid()}")
    if tmp.exists():
        shutil.rmtree(tmp)
    shutil.copytree(src, tmp, copy_function=shutil.copy2)
    want, got = _file_digests(src), _file_digests(tmp)
    if want != got:
        shutil.rmtree(tmp, ignore_errors=True)
        missing = sorted(set(want) ^ set(got)) + sorted(k for k in want if k in got and want[k] != got[k])
        raise OSError(f"campaign copy verification failed ({len(missing)} files differ): {missing[:5]}")
    tmp.replace(dest)
    return {"files": len(want)}


def _cleanup_partials(data: Path) -> None:
    for p in data.glob("campaign.partial-*"):
        shutil.rmtree(p, ignore_errors=True)


def locate_campaign(
    explicit: Path | None,
    *,
    legacy_dirs: list[Path],
    sample: Path | None,
    data_dir: Path | None = None,
) -> tuple[Path, dict]:
    """Return (campaign root, info). Order:

    1. ``explicit`` (``--campaign``): used as is.
    2. ``<data>/campaign`` if it is a campaign.
    3. First legacy folder (``{app}\\campaign``) that is a campaign: copied once to
       ``<data>/campaign`` (verified), old folder left untouched. If the copy fails the
       legacy folder is used in place for this run (nothing lost; retried next start).
    4. A new campaign copied from the bundled ``sample``.
    """
    if explicit is not None:
        return Path(explicit).resolve(), {"source": "explicit"}
    data = Path(data_dir) if data_dir is not None else user_data_dir()
    dest = data / "campaign"
    if is_campaign(dest):
        return dest.resolve(), {"source": "data"}
    if data.is_dir():
        _cleanup_partials(data)
    if dest.exists() and any(dest.iterdir()):
        # Something is there but it is not a campaign: never write over it.
        for legacy in legacy_dirs:
            if is_campaign(legacy):
                logger.warning("%s exists but is not a campaign; using %s in place", dest, legacy)
                return Path(legacy).resolve(), {"source": "legacy-in-place", "reason": "data folder not a campaign"}
        raise FileNotFoundError(f"{dest} exists but is not a campaign (missing world/scenes)")
    if dest.exists():
        dest.rmdir()  # empty folder
    for legacy in legacy_dirs:
        legacy = Path(legacy)
        if not is_campaign(legacy):
            continue
        try:
            stats = copy_campaign_verified(legacy, dest)
        except OSError as exc:
            logger.warning("could not copy %s to %s (%s); using it in place", legacy, dest, exc)
            return legacy.resolve(), {"source": "legacy-in-place", "reason": str(exc)}
        record = {
            "from": str(legacy.resolve()),
            "to": str(dest.resolve()),
            "files": stats["files"],
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "note": "The old folder was copied, not moved; it was left untouched as a fallback.",
        }
        try:
            (data / MIGRATION_RECORD).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        except OSError:
            pass
        return dest.resolve(), {"source": "moved", **record}
    if sample is not None and is_campaign(sample):
        copy_campaign_verified(sample, dest)
        return dest.resolve(), {"source": "new-from-sample"}
    raise FileNotFoundError(f"No campaign found (looked in {dest} and {', '.join(map(str, legacy_dirs))})")


# ------------------------------------------------------------------------ schema

def read_schema(root: Path) -> tuple[int | None, str | None]:
    """(schema version or None if no marker, error text if the marker is unreadable)."""
    p = Path(root) / SCHEMA_FILE
    if not p.exists():
        return None, None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        v = data.get("schema")
        if isinstance(v, bool) or not isinstance(v, int) or v < 0:
            raise ValueError("schema must be a non-negative integer")
        return v, None
    except (OSError, ValueError, AttributeError) as exc:
        return None, f"{SCHEMA_FILE} unreadable: {exc}"


def _write_schema(root: Path, version: int, history: list, app_version: str) -> None:
    p = Path(root) / SCHEMA_FILE
    doc = {
        "schema": version,
        "note": "GM Session campaign format version. Migrations run once when this is lower "
                "than the app's; they only add/convert data and back up what they rewrite.",
        "written_by": app_version,
        "history": history[-50:],
    }
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)


def _history(root: Path) -> list:
    try:
        h = json.loads((Path(root) / SCHEMA_FILE).read_text(encoding="utf-8")).get("history")
        return h if isinstance(h, list) else []
    except (OSError, ValueError, AttributeError):
        return []


def _step_maps_split(root: Path) -> dict:
    import campaign_model as cm

    return cm.migrate_campaign(root)


def _step_marker(root: Path) -> dict:
    return {"note": "schema marker introduced; no data changes"}


# (target version, name, function). Every step: additive, idempotent, backs up rewrites.
MIGRATIONS = [
    (1, "0.6.19 maps/scenes split + organization.yaml", _step_maps_split),
    (2, "0.7.2 schema marker", _step_marker),
]


def migrate(root: Path, app_version: str = "0.0.0") -> dict:
    """Run pending migrations once. Never raises (the app must start)."""
    root = Path(root)
    current, err = read_schema(root)
    report: dict = {"from": current, "to": current, "ran": [], "skipped": None}
    if err:
        report["skipped"] = err + " - no migrations run, file left as is"
        logger.error(report["skipped"])
        return report
    if current is not None and current > CURRENT_SCHEMA:
        report["skipped"] = f"campaign schema {current} is newer than this app ({CURRENT_SCHEMA}); no migrations run"
        logger.warning(report["skipped"])
        return report
    start = current if current is not None else 0
    history = _history(root)
    reached = start
    for target, name, fn in MIGRATIONS:
        if target <= start:
            continue
        try:
            result = fn(root)
        except Exception as exc:  # noqa: BLE001
            report["error"] = f"migration {target} ({name}) failed: {exc}"
            logger.error(report["error"])
            break
        errors = [s for s in (result or {}).get("scenes", []) if isinstance(s, dict) and s.get("error")]
        report["ran"].append({"to": target, "name": name, "result": result})
        if errors:
            report["error"] = f"migration {target} ({name}) had errors; will retry next start"
            logger.error("%s: %s", report["error"], errors)
            break
        reached = target
        history.append({"to": target, "name": name, "app": app_version, "at": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    if reached != current:
        try:
            _write_schema(root, reached, history, app_version)
        except OSError as exc:
            report["error"] = f"could not write {SCHEMA_FILE}: {exc}"
    report["to"] = reached
    # 0.6.19-compatible summary (the /api/migration consumers read "scenes")
    report["scenes"] = [e for r in report["ran"] for e in ((r.get("result") or {}).get("scenes") or [])]
    return report
