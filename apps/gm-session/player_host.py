"""GM side of the player session (0.7.0).

* ``PlayerHub``   — campaign-bound logic: player registry + assignments
  (``world/players.yaml``), per-sheet sync state (``state/sync/<actor>.json``),
  the GM clock (``state/sync/_clock.json``), and reading/writing the synced values
  of an actor (fields in ``world/actors/<id>.yaml``, notes in its sheet text file).
* ``PlayerHandler`` — HTTP handler for the *player listener* (default 0.0.0.0:8766).
  It only knows ``/player/api/*``; it is a different class and port from the GM UI
  server (127.0.0.1:8765), so nothing a player sends can reach a GM endpoint.
  Every sheet operation checks that the sheet is assigned to the authenticated
  player; players authenticate with the secret issued at join (stored hashed).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

import yaml

import sync_core as sc

PLAYERS_FILE = "players.yaml"
ACTOR_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
MAX_BODY = 1_000_000
ONLINE_WINDOW_S = 8.0
PLAYERS_HEADER = (
    "# GM Session players (0.7.0): who joined this campaign and which characters\n"
    "# they receive. secret_sha256 authenticates the player app; forget a player to\n"
    "# let them re-join. assignments: character id -> list of player ids.\n"
)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def lan_addresses() -> list[str]:
    ips: set[str] = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ip for ip in ips if not ip.startswith("127."))


class PlayerHub:
    def __init__(self, campaign_root: Path, sheet_payload=None) -> None:
        self.root = Path(campaign_root)
        self._lock = threading.RLock()
        self._sheet_payload = sheet_payload  # callable(actor_id) -> (status, dict)
        self.presence: dict[str, dict] = {}  # player_id -> {last_seen, last_sync}
        clk = sc.load_json(self._sync_dir() / "_clock.json", {})
        self.clock = sc.HLC(sc.GM_NODE, clk.get("l", 0), clk.get("c", 0))
        self.hosting = {"enabled": False, "host": None, "port": None, "error": None}

    # ------------------------------------------------------------ files
    def _sync_dir(self) -> Path:
        return self.root / "state" / "sync"

    def _players_path(self) -> Path:
        return self.root / "world" / PLAYERS_FILE

    def _actor_path(self, aid: str) -> Path:
        return self.root / "world" / "actors" / f"{aid}.yaml"

    def _save_clock(self) -> None:
        sc.save_json(self._sync_dir() / "_clock.json", self.clock.state())

    def load_players(self) -> dict:
        try:
            raw = yaml.safe_load(self._players_path().read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            raw = None
        raw = raw if isinstance(raw, dict) else {}
        players = raw.get("players") if isinstance(raw.get("players"), dict) else {}
        players = {
            str(pid): p for pid, p in players.items()
            if sc.PLAYER_ID_RE.match(str(pid)) and isinstance(p, dict)
        }
        assigns_raw = raw.get("assignments") if isinstance(raw.get("assignments"), dict) else {}
        assigns: dict[str, list[str]] = {}
        for aid, pids in assigns_raw.items():
            aid = str(aid)
            if not ACTOR_ID_RE.match(aid) or not self._actor_path(aid).is_file():
                continue  # deleted characters drop out
            if isinstance(pids, list):
                keep = [str(p) for p in pids if str(p) in players]
                if keep:
                    assigns[aid] = sorted(set(keep))
        cid = raw.get("campaign_id")
        if not (isinstance(cid, str) and re.fullmatch(r"[a-f0-9]{16,64}", cid)):
            cid = None
        return {
            "campaign_id": cid,
            "join_code": str(raw.get("join_code") or ""),
            "players": players,
            "assignments": assigns,
        }

    def save_players(self, data: dict) -> None:
        out = {
            "campaign_id": data["campaign_id"],
            "join_code": data.get("join_code") or "",
            "players": data["players"],
            "assignments": data["assignments"],
        }
        p = self._players_path()
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(PLAYERS_HEADER + yaml.safe_dump(out, sort_keys=False, allow_unicode=True), encoding="utf-8")
        tmp.replace(p)

    def campaign_id(self) -> str:
        with self._lock:
            data = self.load_players()
            if not data["campaign_id"]:
                data["campaign_id"] = secrets.token_hex(12)
                self.save_players(data)
            return data["campaign_id"]

    def campaign_name(self) -> str:
        return self.root.name

    # ------------------------------------------------------------ actor values
    def read_values(self, aid: str) -> dict | None:
        try:
            actor = yaml.safe_load(self._actor_path(aid).read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            return None
        if not isinstance(actor, dict):
            return None
        vals = {"name": str(actor.get("name") or aid)}
        fields = actor.get("fields") if isinstance(actor.get("fields"), dict) else {}
        for fid, v in fields.items():
            if sc.FIELD_ID_RE.match(str(fid)):
                vals[f"fields.{fid}"] = v
        notes_p = self._notes_path(aid, actor)
        try:
            vals["notes"] = notes_p.read_text(encoding="utf-8") if notes_p and notes_p.is_file() else ""
        except OSError:
            vals["notes"] = ""
        return vals

    def _notes_path(self, aid: str, actor: dict) -> Path | None:
        rel = actor.get("sheet_doc") if isinstance(actor.get("sheet_doc"), str) else f"world/actors/{aid}.sheet.txt"
        p = (self.root / rel).resolve()
        try:
            p.relative_to(self.root.resolve())
        except ValueError:
            return None
        return p

    def write_values(self, aid: str, values: dict) -> None:
        """Write synced keys into the actor file / notes (fields merged)."""
        if not values:
            return
        path = self._actor_path(aid)
        actor = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        fields = actor.get("fields") if isinstance(actor.get("fields"), dict) else {}
        fields = dict(fields)
        changed_actor = False
        for k, v in values.items():
            if k.startswith("fields."):
                fields[k[7:]] = v
                changed_actor = True
            elif k == "name":
                actor["name"] = v
                changed_actor = True
        if changed_actor:
            actor["fields"] = fields
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(yaml.safe_dump(actor, sort_keys=False, default_flow_style=False, allow_unicode=True), encoding="utf-8")
            tmp.replace(path)
        if "notes" in values:
            np = self._notes_path(aid, actor)
            if np is not None:
                np.parent.mkdir(parents=True, exist_ok=True)
                np.write_text(values["notes"], encoding="utf-8")

    # ------------------------------------------------------------ sync state
    def _state_path(self, aid: str) -> Path:
        return self._sync_dir() / f"{aid}.json"

    def _load_state(self, aid: str) -> dict:
        st = sc.load_json(self._state_path(aid), {})
        base = sc.new_state()
        base.update({k: st[k] for k in ("registers", "log", "seq") if k in st})
        base["acks"] = st.get("acks") if isinstance(st.get("acks"), dict) else {}
        base["full_pending"] = st.get("full_pending") if isinstance(st.get("full_pending"), dict) else {}
        return base

    def _save_state(self, aid: str, st: dict) -> None:
        sc.save_json(self._state_path(aid), st)

    def scan(self, aid: str, st: dict) -> int:
        """Turn GM-side edits (sheet window, file edits, rename…) into log entries by
        diffing the actor's current values against the last synced registers."""
        vals = self.read_values(aid)
        if vals is None:
            return 0
        n = 0
        for k, v in vals.items():
            if not sc.valid_key(k):
                continue
            reg = st["registers"].get(k)
            if reg is None or not sc.same(reg.get("v"), v):
                if sc.record_local(st, k, v, self.clock.now(), sc.GM_NODE):
                    n += 1
        if n:
            self._save_clock()
        return n

    def _trim(self, aid: str, st: dict) -> None:
        pids = self.load_players()["assignments"].get(aid, [])
        acks = {p: s for p, s in st["acks"].items() if p in pids}
        st["acks"] = acks
        if acks and len(acks) == len(pids):
            sc.trim_acked(st, min(acks.values()))

    # ------------------------------------------------------------ players
    def assigned_to(self, pid: str) -> list[str]:
        a = self.load_players()["assignments"]
        return sorted(aid for aid, pids in a.items() if pid in pids)

    def authenticate(self, pid, secret) -> bool:
        if not (isinstance(pid, str) and sc.PLAYER_ID_RE.match(pid) and isinstance(secret, str)):
            return False
        p = self.load_players()["players"].get(pid)
        return bool(p) and hmac.compare_digest(str(p.get("secret_sha256", "")), _sha(secret))

    def join(self, pid, name, join_code, secret=None) -> dict:
        if not (isinstance(pid, str) and sc.PLAYER_ID_RE.match(pid)):
            raise sc.SyncError("invalid player id")
        name = str(name or "").strip()[:60]
        if not name:
            raise sc.SyncError("display name required")
        with self._lock:
            data = self.load_players()
            code = data.get("join_code") or ""
            if code and not hmac.compare_digest(code, str(join_code or "")):
                raise PermissionError("wrong join code")
            existing = data["players"].get(pid)
            if existing:
                if not (isinstance(secret, str) and hmac.compare_digest(str(existing.get("secret_sha256", "")), _sha(secret))):
                    raise PermissionError("this player id is already registered; ask the GM to forget the player to re-join")
                existing["name"] = name
                issued = None
            else:
                issued = secrets.token_urlsafe(24)
                data["players"][pid] = {"name": name, "secret_sha256": _sha(issued), "joined": _now_iso()}
            if not data["campaign_id"]:
                data["campaign_id"] = secrets.token_hex(12)
            self.save_players(data)
            self.touch(pid)
            return {"ok": True, "player_id": pid, "secret": issued, "campaign_id": data["campaign_id"],
                    "campaign_name": self.campaign_name(), "assigned": self.assigned_summary(pid)}

    def assigned_summary(self, pid: str) -> list[dict]:
        out = []
        for aid in self.assigned_to(pid):
            vals = self.read_values(aid) or {}
            out.append({"id": aid, "name": vals.get("name", aid)})
        return out

    def touch(self, pid: str, synced: bool = False) -> None:
        p = self.presence.setdefault(pid, {"last_seen": 0.0, "last_sync": None})
        p["last_seen"] = time.time()
        if synced:
            p["last_sync"] = time.time()

    # ------------------------------------------------------------ player ops
    def template_of(self, payload: dict) -> dict:
        tpl = {
            "sheet_id": payload.get("sheet_id"),
            "schema": payload.get("schema") or {},
            "layout": payload.get("layout") or {},
            "graph": payload.get("graph") or {},
            "path": payload.get("path"),
            "appearance": {"size_tiles": (payload.get("appearance") or {}).get("size_tiles", 1)},
        }
        tpl["template_hash"] = hashlib.sha256(sc.canon(tpl).encode()).hexdigest()[:16]
        return tpl

    def sheet_snapshot(self, pid: str, aid: str) -> dict:
        """Full bundle for a player: read-only template + values + stamps."""
        if aid not in self.assigned_to(pid):
            raise PermissionError("sheet not assigned to you")
        status, payload = self._sheet_payload(aid)
        if status != 200:
            raise LookupError(payload.get("error", "sheet unavailable"))
        with self._lock:
            st = self._load_state(aid)
            self.scan(aid, st)
            st["acks"][pid] = st["seq"]
            st["full_pending"].pop(pid, None)
            self._save_state(aid, st)
            regs = {k: {"v": r["v"], "t": r["t"]} for k, r in st["registers"].items()}
        return {"actor_id": aid, "template": self.template_of(payload), "registers": regs, "max_seq": st["seq"]}

    def sync(self, pid: str, body: dict) -> dict:
        """One sync round for a player. body = {"sheets": {aid: {"changes": [...],
        "ack": int, "full_ack": str|None, "template_hash": str|None}}}."""
        sheets_in = body.get("sheets") if isinstance(body.get("sheets"), dict) else {}
        if len(sheets_in) > 200:
            raise sc.SyncError("too many sheets")
        assigned = set(self.assigned_to(pid))
        # validate everything before applying anything
        cleaned: dict[str, tuple[list, int, str | None, str | None]] = {}
        for aid, s in sheets_in.items():
            if not isinstance(s, dict) or not ACTOR_ID_RE.match(str(aid)):
                raise sc.SyncError("bad sheet entry")
            if aid not in assigned:
                continue  # unassigned (or never assigned): ignored, reported below
            ack = s.get("ack", 0)
            if not isinstance(ack, int) or isinstance(ack, bool) or ack < 0:
                raise sc.SyncError("ack must be a non-negative integer")
            cleaned[aid] = (
                sc.validate_changes(s.get("changes") or [], writer="player"),
                ack,
                s.get("full_ack") if isinstance(s.get("full_ack"), str) else None,
                s.get("template_hash") if isinstance(s.get("template_hash"), str) else None,
            )
        out_sheets = {}
        for aid, (changes, ack, full_ack, tpl_hash) in cleaned.items():
            out_sheets[aid] = self._sync_sheet(pid, aid, changes, ack, full_ack, tpl_hash)
        self.touch(pid, synced=True)
        return {
            "ok": True,
            "campaign_id": self.campaign_id(),
            "server_time": int(time.time() * 1000),
            "assigned": self.assigned_summary(pid),
            "ignored": sorted(str(a) for a in sheets_in if a not in assigned),
            "sheets": out_sheets,
        }

    def _sync_sheet(self, pid, aid, changes, ack, full_ack, tpl_hash) -> dict:
        with self._lock:
            st = self._load_state(aid)
            self.scan(aid, st)
            wins: dict = {}
            max_in = 0
            now_phys = self.clock.physical()
            for ch in changes:
                max_in = max(max_in, ch["seq"])
                t = ch["t"]
                if sc.parse_stamp(t)[0] > now_phys + sc.MAX_DRIFT_MS:
                    t = self.clock.now()  # clock far ahead: don't let it win forever
                else:
                    self.clock.recv(t)
                if sc.apply_remote(st, {"k": ch["k"], "v": ch["v"], "t": t}, pid, relog=True):
                    wins[ch["k"]] = ch["v"]
            if wins:
                self.write_values(aid, wins)
            self._save_clock()
            pending = st["full_pending"].get(pid)
            if pending and full_ack == pending:
                st["full_pending"].pop(pid, None)
                pending = None
            resp: dict = {"ack": max_in, "max_seq": st["seq"], "applied": len(wins)}
            if pending:
                resp["full"] = {
                    "id": pending,
                    "registers": {k: {"v": r["v"], "t": r["t"]} for k, r in st["registers"].items()},
                }
                st["acks"][pid] = st["seq"]
            else:
                resp["changes"] = sc.pending_since(st, ack, exclude_origin=pid)
                st["acks"][pid] = max(int(st["acks"].get(pid, 0)), ack)
            self._trim(aid, st)
            self._save_state(aid, st)
        if tpl_hash is not None and self._sheet_payload:
            status, payload = self._sheet_payload(aid)
            if status == 200:
                tpl = self.template_of(payload)
                if tpl["template_hash"] != tpl_hash:
                    resp["template"] = tpl
        return resp

    def full_from_player(self, pid: str, aid: str, values) -> dict:
        """Player → GM full sync: the player's copy overwrites the GM copy for every
        player-writable key it sends (newest stamps, so it wins everywhere)."""
        if aid not in self.assigned_to(pid):
            raise PermissionError("sheet not assigned to you")
        if not isinstance(values, dict) or len(values) > sc.MAX_CHANGES_PER_SHEET:
            raise sc.SyncError("values must be an object")
        for k, v in values.items():
            if not sc.valid_key(k) or not sc.player_may_write(k):
                raise sc.SyncError(f"players cannot change {k}")
            sc.check_value(k, v)
        with self._lock:
            st = self._load_state(aid)
            self.scan(aid, st)
            changed = {}
            for k, v in values.items():
                reg = st["registers"].get(k)
                if reg is not None and sc.same(reg.get("v"), v):
                    continue
                t = self.clock.now()
                st["registers"][k] = {"v": v, "t": t, "o": pid}
                sc._append(st, k, v, t, pid)
                changed[k] = v
            self.write_values(aid, changed)
            self._save_clock()
            st["acks"][pid] = st["seq"]
            self._trim(aid, st)
            self._save_state(aid, st)
        self.touch(pid, synced=True)
        return {"ok": True, "applied": len(changed), "max_seq": st["seq"]}

    # ------------------------------------------------------------ GM ops
    def gm_status(self) -> dict:
        data = self.load_players()
        now = time.time()
        players = []
        for pid, p in data["players"].items():
            pres = self.presence.get(pid, {})
            players.append({
                "id": pid,
                "name": p.get("name") or pid[:8],
                "joined": p.get("joined"),
                "online": now - pres.get("last_seen", 0) < ONLINE_WINDOW_S,
                "last_seen": pres.get("last_seen"),
                "last_sync": pres.get("last_sync"),
                "sheets": [a for a, pids in data["assignments"].items() if pid in pids],
            })
        players.sort(key=lambda x: x["name"].lower())
        return {
            "hosting": {**self.hosting, "addresses": lan_addresses()},
            "campaign_id": data["campaign_id"],
            "join_code_set": bool(data.get("join_code")),
            "join_code": data.get("join_code") or "",
            "players": players,
            "assignments": data["assignments"],
        }

    def gm_assign(self, aid: str, pids) -> list[str]:
        if not (isinstance(aid, str) and ACTOR_ID_RE.match(aid) and self._actor_path(aid).is_file()):
            raise sc.SyncError("unknown character")
        if not isinstance(pids, list) or not all(isinstance(p, str) for p in pids):
            raise sc.SyncError("players must be a list of player ids")
        with self._lock:
            data = self.load_players()
            unknown = [p for p in pids if p not in data["players"]]
            if unknown:
                raise sc.SyncError(f"unknown player: {unknown[0]}")
            if pids:
                data["assignments"][aid] = sorted(set(pids))
            else:
                data["assignments"].pop(aid, None)
            if not data["campaign_id"]:
                data["campaign_id"] = secrets.token_hex(12)
            self.save_players(data)
            return data["assignments"].get(aid, [])

    def gm_set_join_code(self, code) -> None:
        code = str(code or "").strip()
        if len(code) > 64:
            raise sc.SyncError("join code too long")
        with self._lock:
            data = self.load_players()
            data["join_code"] = code
            if not data["campaign_id"]:
                data["campaign_id"] = secrets.token_hex(12)
            self.save_players(data)

    def gm_forget(self, pid: str) -> None:
        with self._lock:
            data = self.load_players()
            if pid not in data["players"]:
                raise LookupError("unknown player")
            data["players"].pop(pid)
            for aid in list(data["assignments"]):
                data["assignments"][aid] = [p for p in data["assignments"][aid] if p != pid]
                if not data["assignments"][aid]:
                    data["assignments"].pop(aid)
            self.save_players(data)
            self.presence.pop(pid, None)

    def gm_full_to_player(self, aid: str, pid: str) -> str:
        """GM → player full sync: next sync the player's copy is replaced by the GM's."""
        if pid not in self.load_players()["assignments"].get(aid, []):
            raise sc.SyncError("that character is not assigned to that player")
        with self._lock:
            st = self._load_state(aid)
            self.scan(aid, st)
            fid = secrets.token_hex(8)
            st["full_pending"][pid] = fid
            self._save_state(aid, st)
            return fid


# ---------------------------------------------------------------- HTTP listener

class PlayerHandler(BaseHTTPRequestHandler):
    """Player-facing API. Only /player/api/* exists here."""

    hub: PlayerHub = None  # type: ignore[assignment]
    version: str = "0.0.0"
    quiet = True
    server_version = "GMSessionPlayerHost/1"

    def log_message(self, fmt, *args):  # noqa: D401
        if not self.quiet:
            super().log_message(fmt, *args)

    def _send(self, code: int, obj) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # player went away mid-response; it re-sends (idempotent by stamp)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise OverflowError
        raw = self.rfile.read(n) if n else b"{}"
        body = json.loads(raw.decode("utf-8") or "{}")
        if not isinstance(body, dict):
            raise sc.SyncError("body must be an object")
        return body

    def _auth(self) -> str | None:
        pid = self.headers.get("X-Player-Id")
        secret = self.headers.get("X-Player-Secret")
        if self.hub.authenticate(pid, secret):
            self.hub.touch(pid)
            return pid
        self._send(401, {"error": "unknown player or bad secret — join first"})
        return None

    def _route(self, method: str) -> None:
        path = unquote(urlparse(self.path).path)
        if not path.startswith("/player/api/"):
            self._send(404, {"error": "not found"})
            return
        sub = path[len("/player/api/"):].strip("/")
        try:
            if method == "GET" and sub == "hello":
                data = self.hub.load_players()
                self._send(200, {"app": "gm-session", "version": self.version,
                                 "campaign_id": self.hub.campaign_id(),
                                 "campaign_name": self.hub.campaign_name(),
                                 "join_code_required": bool(data.get("join_code"))})
                return
            if method == "POST" and sub == "join":
                body = self._body()
                out = self.hub.join(body.get("player_id"), body.get("name"), body.get("join_code"),
                                    self.headers.get("X-Player-Secret"))
                self._send(200, out)
                return
            pid = self._auth()
            if pid is None:
                return
            if method == "GET" and sub == "sheets":
                self._send(200, {"assigned": self.hub.assigned_summary(pid)})
            elif method == "GET" and sub.startswith("sheet/"):
                aid = sub[len("sheet/"):]
                if not ACTOR_ID_RE.match(aid):
                    self._send(400, {"error": "invalid sheet id"})
                    return
                self._send(200, self.hub.sheet_snapshot(pid, aid))
            elif method == "POST" and sub == "sync":
                self._send(200, self.hub.sync(pid, self._body()))
            elif method == "POST" and sub.startswith("fullsync/"):
                aid = sub[len("fullsync/"):]
                if not ACTOR_ID_RE.match(aid):
                    self._send(400, {"error": "invalid sheet id"})
                    return
                self._send(200, self.hub.full_from_player(pid, aid, self._body().get("values")))
            else:
                self._send(404, {"error": "not found"})
        except OverflowError:
            self._send(413, {"error": "request too large"})
        except PermissionError as exc:
            self._send(403, {"error": str(exc)})
        except LookupError as exc:
            self._send(404, {"error": str(exc)})
        except (sc.SyncError, ValueError) as exc:
            self._send(400, {"error": str(exc)})

    def do_GET(self):  # noqa: N802
        self._route("GET")

    def do_POST(self):  # noqa: N802
        self._route("POST")

    def do_PUT(self):  # noqa: N802
        self._send(404, {"error": "not found"})

    do_DELETE = do_PUT
    do_PATCH = do_PUT


def start_player_listener(hub: PlayerHub, host: str, port: int, version: str, quiet: bool = True):
    """Bind the player listener and serve it on a daemon thread. Returns the server
    (or None when the port cannot be bound — the GM app keeps working)."""
    handler = type("BoundPlayerHandler", (PlayerHandler,), {"hub": hub, "version": version, "quiet": quiet})
    try:
        srv = ThreadingHTTPServer((host, port), handler)
    except OSError as exc:
        hub.hosting = {"enabled": False, "host": host, "port": port, "error": str(exc)}
        return None
    srv.daemon_threads = True
    hub.hosting = {"enabled": True, "host": host, "port": srv.server_address[1], "error": None}
    threading.Thread(target=srv.serve_forever, name="gm-player-host", daemon=True, kwargs={"poll_interval": 0.5}).start()
    return srv
