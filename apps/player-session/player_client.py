"""Sync loop for GM Session Player: every 2 s send unacknowledged local changes to
the GM and apply the GM's changes (see gm-session/sync_core.py)."""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request

from player_store import PlayerStore, sc

SYNC_INTERVAL_S = 2.0
TIMEOUT_S = 5.0


class GMError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def normalize_address(addr: str) -> str:
    a = (addr or "").strip().rstrip("/")
    a = re.sub(r"^https?://", "", a)
    if not a:
        raise ValueError("GM address required (host:port)")
    if ":" not in a:
        a += ":8766"
    host, _, port = a.rpartition(":")
    if not host or not port.isdigit() or not (0 < int(port) < 65536):
        raise ValueError("GM address must look like 192.168.1.20:8766")
    return f"{host}:{port}"


class SyncClient:
    def __init__(self, store: PlayerStore) -> None:
        self.store = store
        self.status = {"state": "not-configured", "last_sync": None, "last_error": None,
                       "last_attempt": None, "last_stats": None}
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._thread: threading.Thread | None = None
        self._assigned: list[dict] = []
        self.rounds = 0

    # ------------------------------------------------------------ http
    def _req(self, method: str, path: str, body=None, auth=True):
        gm = self.store.cfg.get("gm")
        url = f"http://{gm}/player/api/{path}"
        data = None if body is None else json.dumps(body).encode("utf-8")
        r = urllib.request.Request(url, data=data, method=method)
        r.add_header("Content-Type", "application/json")
        r.add_header("X-Player-Id", self.store.player_id)
        sec = self.store.secret_for(self.store.cfg.get("campaign_id"))
        if auth and sec:
            r.add_header("X-Player-Secret", sec)
        try:
            with urllib.request.urlopen(r, timeout=TIMEOUT_S) as resp:
                return json.loads(resp.read().decode("utf-8") or "{}")
        except urllib.error.HTTPError as e:
            try:
                msg = json.loads(e.read().decode("utf-8") or "{}").get("error") or str(e)
            except ValueError:
                msg = str(e)
            raise GMError(e.code, msg) from e

    # ------------------------------------------------------------ public
    def configure(self, gm: str, name: str, join_code: str = "") -> None:
        gm = normalize_address(gm)
        name = (name or "").strip()[:60]
        if not name:
            raise ValueError("display name required")
        with self.store.lock:
            if gm != self.store.cfg.get("gm"):
                self.store.cfg["campaign_id"] = None  # new GM → learn its campaign on join
            self.store.cfg.update({"gm": gm, "name": name, "join_code": join_code or ""})
            self.store.save_config()
        self.status.update({"state": "connecting", "last_error": None})
        self.rounds = 0
        self.wake()

    def disconnect(self) -> None:
        with self.store.lock:
            self.store.cfg["gm"] = ""
            self.store.save_config()
        self.status.update({"state": "not-configured", "last_error": None})

    def assigned(self) -> list[dict]:
        return list(self._assigned)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="player-sync", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()

    def wake(self) -> None:
        self._wake.set()

    def full_push(self, aid: str) -> dict:
        """Player → GM full sync (overwrites the GM copy of this sheet)."""
        vals = self.store.full_values(aid)
        out = self._req("POST", f"fullsync/{aid}", {"values": vals})
        self.store.after_full_push(aid)
        self.wake()
        return out

    # ------------------------------------------------------------ loop
    def _loop(self) -> None:
        while not self._stop.is_set():
            if self.store.cfg.get("gm"):
                self.sync_once()
            self._wake.wait(SYNC_INTERVAL_S)
            self._wake.clear()

    def _ensure_joined(self) -> None:
        hello = self._req("GET", "hello", auth=False)
        cid = hello.get("campaign_id")
        cfg = self.store.cfg
        if cid != cfg.get("campaign_id"):
            cfg["campaign_id"] = cid
            cfg["campaign_name"] = hello.get("campaign_name") or ""
        if not self.store.secret_for(cid) or self.status.get("need_rejoin"):
            out = self._req("POST", "join", {"player_id": self.store.player_id, "name": cfg.get("name"),
                                             "join_code": cfg.get("join_code")}, auth=bool(self.store.secret_for(cid)))
            if out.get("secret"):
                cfg["secrets"][cid] = out["secret"]
            self.status["need_rejoin"] = False
        self.store.save_config()

    def sync_once(self) -> bool:
        self.status["last_attempt"] = time.time()
        try:
            if not self.store.cfg.get("campaign_id") or not self.store.secret_for(self.store.cfg.get("campaign_id")):
                self._ensure_joined()
            elif self.rounds == 0 or self.status.get("need_rejoin"):
                self._ensure_joined()  # refresh name on the GM once per run / after 401
            # download sheets assigned since last round
            local = set(self.store.sheet_ids())
            for a in self._assigned:
                if a["id"] not in local:
                    self.store.apply_snapshot(self._req("GET", f"sheet/{a['id']}"))
            req = self.store.build_sync_request([a["id"] for a in self._assigned] or self.store.sheet_ids())
            resp = self._req("POST", "sync", req)
            stats = self.store.apply_sync_response(resp)
            self._assigned = resp.get("assigned") or []
            ids = {a["id"] for a in self._assigned}
            new = [a["id"] for a in self._assigned if a["id"] not in set(self.store.sheet_ids())]
            for aid in new:
                self.store.apply_snapshot(self._req("GET", f"sheet/{aid}"))
            self.store.archive_unassigned(ids)
            self.rounds += 1
            self.status.update({"state": "connected", "last_sync": time.time(), "last_error": None,
                                "last_stats": stats, "campaign_name": self.store.cfg.get("campaign_name")})
            return True
        except GMError as exc:
            if exc.status == 401:
                self.status["need_rejoin"] = True
            self.status.update({"state": "error" if exc.status in (401, 403) else "offline", "last_error": str(exc)})
        except (urllib.error.URLError, OSError, ValueError, KeyError, sc.SyncError) as exc:
            self.status.update({"state": "offline", "last_error": f"{type(exc).__name__}: {exc}"})
        return False
