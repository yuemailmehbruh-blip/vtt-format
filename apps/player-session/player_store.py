"""Player-side local store (GM Session Player 0.7.0).

Everything lives in the player's data dir so sheets work offline:
  config.json                          player id (stable), name, GM address, join code,
                                       per-campaign secrets, clock state
  campaigns/<campaign_id>/sheets/<id>.json
      {"template": {...read-only sheet layout from the GM...},
       "registers": {key: {"v", "t", "o"}}, "log": [...unacked local changes...],
       "seq": n, "gm_ack": highest GM log seq applied, "full_ack": id|null}

Local edits become field-level log entries stamped with this player's hybrid
logical clock; see gm-session/sync_core.py for the protocol and conflict rule.
"""

from __future__ import annotations

import os
import re
import secrets
import sys
import threading
from pathlib import Path

_HERE = Path(__file__).resolve().parent
for cand in (_HERE.parent / "gm-session", _HERE / "gm-session"):
    if (cand / "sync_core.py").is_file() and str(cand) not in sys.path:
        sys.path.insert(0, str(cand))
import sync_core as sc  # noqa: E402

ACTOR_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")


def default_data_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
        return base / "GM Session Player"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share") / "gm-session-player"


class PlayerStore:
    def __init__(self, data_dir: Path) -> None:
        self.dir = Path(data_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        cfg = sc.load_json(self.dir / "config.json", {})
        if not (isinstance(cfg.get("player_id"), str) and sc.PLAYER_ID_RE.match(cfg["player_id"])):
            cfg["player_id"] = secrets.token_hex(16)  # stable identity across restarts
        cfg.setdefault("name", "")
        cfg.setdefault("gm", "")
        cfg.setdefault("join_code", "")
        cfg.setdefault("secrets", {})
        cfg.setdefault("campaign_id", None)
        cfg.setdefault("campaign_name", "")
        clk = cfg.get("clock") or {}
        self.cfg = cfg
        self.clock = sc.HLC("p" + cfg["player_id"][:16], clk.get("l", 0), clk.get("c", 0))
        self.save_config()

    # ------------------------------------------------------------ config
    @property
    def player_id(self) -> str:
        return self.cfg["player_id"]

    def save_config(self) -> None:
        with self.lock:
            self.cfg["clock"] = self.clock.state()
            sc.save_json(self.dir / "config.json", self.cfg)

    def secret_for(self, cid: str | None) -> str | None:
        return self.cfg["secrets"].get(cid) if cid else None

    # ------------------------------------------------------------ sheets
    def _sheets_dir(self, cid: str | None = None) -> Path | None:
        cid = cid or self.cfg.get("campaign_id")
        if not cid or not re.fullmatch(r"[a-f0-9]{16,64}", cid):
            return None
        return self.dir / "campaigns" / cid / "sheets"

    def _sheet_path(self, aid: str) -> Path | None:
        d = self._sheets_dir()
        if d is None or not ACTOR_ID_RE.match(aid or ""):
            return None
        return d / f"{aid}.json"

    def load_sheet(self, aid: str) -> dict | None:
        p = self._sheet_path(aid)
        if p is None or not p.is_file():
            return None
        st = sc.load_json(p, {})
        base = sc.new_state()
        base.update(st)
        base.setdefault("gm_ack", 0)
        base.setdefault("full_ack", None)
        base.setdefault("template", {})
        return base

    def save_sheet(self, aid: str, st: dict) -> None:
        p = self._sheet_path(aid)
        if p is not None:
            sc.save_json(p, st)

    def sheet_ids(self) -> list[str]:
        d = self._sheets_dir()
        if d is None or not d.is_dir():
            return []
        return sorted(p.stem for p in d.glob("*.json") if ACTOR_ID_RE.match(p.stem))

    def list_sheets(self) -> list[dict]:
        out = []
        for aid in self.sheet_ids():
            st = self.load_sheet(aid) or {}
            regs = st.get("registers", {})
            out.append({"id": aid, "name": (regs.get("name") or {}).get("v") or aid,
                        "pending": len(st.get("log", []))})
        return out

    def sheet_payload(self, aid: str) -> dict | None:
        """Shape of the GM's GET /api/sheet/<id>, so the shared sheet.js renders it."""
        st = self.load_sheet(aid)
        if st is None:
            return None
        vals = sc.values_of(st)
        tpl = st.get("template") or {}
        return {
            "actor_id": aid,
            "name": vals.get("name") or aid,
            "path": "synced from the GM",
            "text": vals.get("notes") or "",
            "appearance": tpl.get("appearance") or {"size_tiles": 1},
            "sheet_id": tpl.get("sheet_id"),
            "fields": {k[7:]: v for k, v in vals.items() if k.startswith("fields.")},
            "schema": tpl.get("schema") or {"fields": {}},
            "layout": tpl.get("layout") or {"widgets": []},
            "graph": tpl.get("graph") or {"nodes": [], "edges": []},
            "player_mode": True,
            "pending": len(st.get("log", [])),
        }

    def rev(self, aid: str) -> str:
        p = self._sheet_path(aid)
        try:
            s = p.stat() if p else None
            return f"{s.st_mtime_ns}:{s.st_size}" if s else "-"
        except OSError:
            return "-"

    def list_sheet_sig(self) -> list:
        return [(x["id"], x["name"]) for x in self.list_sheets()]

    # ------------------------------------------------------------ 0.7.1 map view + chat cache
    def _camp_dir(self) -> Path | None:
        d = self._sheets_dir()
        return d.parent if d is not None else None

    def save_view(self, view: dict) -> None:
        d = self._camp_dir()
        if d is not None:
            sc.save_json(d / "view.json", view)

    def load_view(self) -> dict:
        d = self._camp_dir()
        v = sc.load_json(d / "view.json", {}) if d is not None else {}
        v.setdefault("scene", None)
        v.setdefault("tokens", [])
        v.setdefault("actors", {})
        return v

    def _asset_path(self, h: str) -> Path | None:
        if not re.fullmatch(r"[A-Za-z0-9_.-]{8,128}", h or ""):
            return None
        return self.dir / "assets" / h

    def has_asset(self, h: str) -> bool:
        p = self._asset_path(h)
        return bool(p and p.is_file())

    def save_asset(self, h: str, data: bytes) -> None:
        p = self._asset_path(h)
        if p is None or not isinstance(data, (bytes, bytearray)):
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_bytes(data)
        tmp.replace(p)

    def asset_bytes(self, h: str) -> bytes | None:
        p = self._asset_path(h)
        return p.read_bytes() if p and p.is_file() else None

    def load_chat(self) -> dict:
        d = self._camp_dir()
        c = sc.load_json(d / "chat.json", {}) if d is not None else {}
        c.setdefault("epoch", None)
        c.setdefault("seq", 0)
        c.setdefault("entries", [])
        return c

    def merge_chat(self, d: dict, replace: bool) -> None:
        with self.lock:
            cur = {"epoch": d.get("epoch"), "seq": 0, "entries": []} if replace else self.load_chat()
            if d.get("epoch") and cur.get("epoch") not in (None, d.get("epoch")) and not replace:
                cur = {"epoch": d.get("epoch"), "seq": 0, "entries": []}
            seen = {e.get("seq") for e in cur["entries"]}
            for e in d.get("entries") or []:
                if isinstance(e, dict) and isinstance(e.get("seq"), int) and e["seq"] not in seen:
                    cur["entries"].append(e)
                    seen.add(e["seq"])
            cur["entries"].sort(key=lambda e: e["seq"])
            cur["entries"] = cur["entries"][-500:]
            cur["seq"] = max([cur.get("seq") or 0] + [e["seq"] for e in cur["entries"]])
            if d.get("epoch"):
                cur["epoch"] = d["epoch"]
            dd = self._camp_dir()
            if dd is not None:
                sc.save_json(dd / "chat.json", cur)

    def local_edit(self, aid: str, values: dict) -> dict:
        """Edits from the player's sheet window → registers + change log."""
        with self.lock:
            st = self.load_sheet(aid)
            if st is None:
                raise LookupError("sheet not found")
            n = 0
            for k, v in values.items():
                if not sc.valid_key(k) or not sc.player_may_write(k):
                    raise sc.SyncError(f"cannot change {k}")
                sc.check_value(k, v)
                if sc.record_local(st, k, v, self.clock.now(), self.player_id):
                    n += 1
            self.save_sheet(aid, st)
            self.save_config()
            return {"changed": n, "pending": len(st["log"])}

    # ------------------------------------------------------------ sync plumbing
    def apply_snapshot(self, snap: dict) -> None:
        """First download (or re-download) of an assigned sheet from the GM."""
        aid = snap["actor_id"]
        with self.lock:
            old = self.load_sheet(aid)
            st = sc.new_state()
            st.update({"gm_ack": int(snap.get("max_seq", 0)), "full_ack": None, "template": snap.get("template") or {}})
            for k, r in (snap.get("registers") or {}).items():
                if sc.valid_key(k):
                    self.clock.recv(r["t"])
                    st["registers"][k] = {"v": r.get("v"), "t": r["t"], "o": "gm"}
            if old:  # keep unsynced local edits; they still win if newer
                st["seq"] = old.get("seq", 0)
                for e in old.get("log", []):
                    reg = st["registers"].get(e["k"])
                    if reg is None or e["t"] > reg["t"]:
                        st["registers"][e["k"]] = {"v": e["v"], "t": e["t"], "o": self.player_id}
                        st["log"].append(e)
            self.save_sheet(aid, st)
            self.save_config()

    def build_sync_request(self, assigned: list[str]) -> dict:
        with self.lock:
            sheets = {}
            for aid in assigned:
                st = self.load_sheet(aid)
                if st is None:
                    continue
                sheets[aid] = {
                    "changes": [{"seq": e["seq"], "k": e["k"], "v": e["v"], "t": e["t"]} for e in st["log"]],
                    "ack": int(st.get("gm_ack", 0)),
                    "full_ack": st.get("full_ack"),
                    "template_hash": (st.get("template") or {}).get("template_hash"),
                }
            return {"sheets": sheets}

    def apply_sync_response(self, resp: dict) -> dict:
        stats = {"received": 0, "applied": 0, "trimmed": 0, "full": []}
        with self.lock:
            for aid, r in (resp.get("sheets") or {}).items():
                st = self.load_sheet(aid)
                if st is None or not isinstance(r, dict):
                    continue
                stats["trimmed"] += sc.trim_acked(st, int(r.get("ack", 0)))
                if isinstance(r.get("full"), dict):
                    # GM → player full sync: GM copy replaces ours (GM confirmed it)
                    st["registers"] = {}
                    for k, reg in (r["full"].get("registers") or {}).items():
                        if sc.valid_key(k):
                            self.clock.recv(reg["t"])
                            st["registers"][k] = {"v": reg.get("v"), "t": reg["t"], "o": "gm"}
                    st["log"] = []
                    st["full_ack"] = r["full"].get("id")
                    stats["full"].append(aid)
                else:
                    for ch in r.get("changes") or []:
                        if not sc.valid_key(ch.get("k")):
                            continue
                        stats["received"] += 1
                        self.clock.recv(ch["t"])
                        if sc.apply_remote(st, ch, "gm"):
                            stats["applied"] += 1
                if isinstance(r.get("template"), dict):
                    st["template"] = r["template"]
                st["gm_ack"] = max(int(st.get("gm_ack", 0)), int(r.get("max_seq", 0)))
                self.save_sheet(aid, st)
            self.save_config()
        return stats

    def full_values(self, aid: str) -> dict:
        st = self.load_sheet(aid)
        if st is None:
            raise LookupError("sheet not found")
        return {k: v for k, v in sc.values_of(st).items() if sc.player_may_write(k)}

    def after_full_push(self, aid: str) -> None:
        with self.lock:
            st = self.load_sheet(aid)
            if st is not None:
                st["log"] = []  # everything was just sent in full
                self.save_sheet(aid, st)

    def archive_unassigned(self, assigned: set[str]) -> list[str]:
        """Sheets the GM no longer assigns move to campaigns/<cid>/unassigned/."""
        gone = []
        d = self._sheets_dir()
        if d is None:
            return gone
        for aid in self.sheet_ids():
            if aid not in assigned:
                dest = d.parent / "unassigned" / f"{aid}.json"
                dest.parent.mkdir(parents=True, exist_ok=True)
                (d / f"{aid}.json").replace(dest)
                gone.append(aid)
        return gone
