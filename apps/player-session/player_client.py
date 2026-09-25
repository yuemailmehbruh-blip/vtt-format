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
LIVE_WAIT_S = 20.0  # long-poll window for map/chat pushes from the GM
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # LAN: never via a proxy


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
        # 0.7.1 live map + chat (long-poll against the GM; local UI long-polls us)
        self.live = {"map_rev": None, "scene_id": None, "chat_seq": None, "chat_epoch": None,
                     "state": "idle", "last_event": None, "error": None}
        self.cond = threading.Condition()
        self.local_rev = 0
        self._live_thread: threading.Thread | None = None
        self._live_gen = 0

    # ------------------------------------------------------------ 0.7.1 live
    def _bump(self) -> None:
        with self.cond:
            self.local_rev += 1
            self.cond.notify_all()

    def wait_local(self, since: int, timeout: float) -> int:
        deadline = time.time() + max(0.0, min(timeout, 25.0))
        with self.cond:
            while self.local_rev == since:
                left = deadline - time.time()
                if left <= 0:
                    break
                self.cond.wait(left)
            return self.local_rev

    def _fetch_view(self) -> None:
        view = self._req("GET", "view", timeout=10)
        for h in view.get("assets") or []:
            if not self.store.has_asset(h):
                self.store.save_asset(h, self._req("GET", f"asset/{h}", timeout=30, raw=True))
        self.store.save_view(view)
        self.live["map_rev"] = view.get("rev")
        self.live["scene_id"] = (view.get("scene") or {}).get("id")

    def _fetch_chat(self, epoch_changed: bool) -> None:
        local = self.store.load_chat()
        after = 0 if epoch_changed or local.get("epoch") != self.live.get("chat_epoch") else int(local.get("seq") or 0)
        d = self._req("GET", f"chat?after={after}", timeout=10)
        self.store.merge_chat(d, replace=(after == 0))
        self.live["chat_seq"] = d.get("seq")
        self.live["chat_epoch"] = d.get("epoch")

    def live_once(self, wait: float = LIVE_WAIT_S) -> bool:
        """One long-poll round: wait for a GM change, then pull what changed."""
        if not self.store.cfg.get("gm") or not self.store.secret_for(self.store.cfg.get("campaign_id")):
            return False
        lv = self.live
        q = []
        if lv["map_rev"] is not None:
            q.append(f"map={lv['map_rev']}")
        if lv["chat_seq"] is not None:
            q.append(f"chat={lv['chat_seq']}")
        if lv["chat_epoch"]:
            q.append(f"epoch={lv['chat_epoch']}")
        q.append(f"timeout={wait if (lv['map_rev'] is not None and lv['chat_seq'] is not None) else 0}")
        st = self._req("GET", "wait?" + "&".join(q), timeout=wait + 10)
        changed = False
        if st.get("map_rev") != lv["map_rev"]:
            self._fetch_view()
            changed = True
        if st.get("chat_seq") != lv["chat_seq"] or st.get("chat_epoch") != lv["chat_epoch"]:
            self._fetch_chat(st.get("chat_epoch") != lv["chat_epoch"])
            changed = True
        lv.update(state="live", error=None)
        if changed:
            lv["last_event"] = time.time()
            self._bump()
        return True

    def _live_loop(self, gen: int) -> None:
        backoff = 1.0
        while not self._stop.is_set() and gen == self._live_gen:
            try:
                if self.live_once():
                    backoff = 1.0
                    continue
                time.sleep(0.5)
            except GMError as exc:
                if exc.status == 401:
                    self.status["need_rejoin"] = True
                self.live.update(state="offline", error=str(exc))
                self._bump()
                time.sleep(backoff)
                backoff = min(backoff * 2, 5.0)
            except (urllib.error.URLError, OSError, ValueError) as exc:
                self.live.update(state="offline", error=f"{type(exc).__name__}: {exc}")
                self._bump()
                time.sleep(backoff)
                backoff = min(backoff * 2, 5.0)

    def start_live(self) -> None:
        self._live_gen += 1
        self.live.update(map_rev=None, chat_seq=None, chat_epoch=None)
        self._live_thread = threading.Thread(target=self._live_loop, args=(self._live_gen,), name="player-live", daemon=True)
        self._live_thread.start()

    def move_token(self, body: dict) -> dict:
        """Own token moved in the player window → GM (validated + snapped there)."""
        out = self._req("POST", "token-move", body)
        tok = out.get("token") or {}
        with self.store.lock:
            view = self.store.load_view()
            for t in view.get("tokens") or []:
                if t.get("id") == tok.get("id"):
                    t["x"], t["y"] = tok.get("x"), tok.get("y")
            self.store.save_view(view)
        self._bump()
        return out

    def post_chat(self, body: dict) -> dict:
        """Player message/roll → GM immediately (the GM stamps sender + time)."""
        out = self._req("POST", "chat", body)
        entry = out.get("entry")
        if isinstance(entry, dict):
            self.store.merge_chat({"epoch": self.live.get("chat_epoch"), "seq": entry.get("seq"), "entries": [entry]}, replace=False)
            self._bump()
        return out

    # ------------------------------------------------------------ http
    def _req(self, method: str, path: str, body=None, auth=True, timeout: float = TIMEOUT_S, raw: bool = False):
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
            with _OPENER.open(r, timeout=timeout) as resp:
                data = resp.read()
                return data if raw else json.loads(data.decode("utf-8") or "{}")
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
            self.store.cfg.update({"gm": gm, "last_gm": gm, "name": name, "join_code": join_code or ""})
            self.store.save_config()
        self.status.update({"state": "connecting", "last_error": None})
        self.rounds = 0
        self.live.update(map_rev=None, chat_seq=None, chat_epoch=None, state="idle")
        self.wake()
        self._bump()

    def disconnect(self) -> None:
        with self.store.lock:
            self.store.cfg["gm"] = ""
            self.store.save_config()
        self.status.update({"state": "not-configured", "last_error": None})
        self.live.update(state="idle")
        self._bump()

    def assigned(self) -> list[dict]:
        return list(self._assigned)

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="player-sync", daemon=True)
            self._thread.start()
            self.start_live()

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
        before = (self.status.get("state"), tuple(self.store.list_sheet_sig()))
        ok = self._sync_once_inner()
        if (self.status.get("state"), tuple(self.store.list_sheet_sig())) != before:
            self._bump()  # connection state or sheet list changed → UI refresh
        return ok

    def _sync_once_inner(self) -> bool:
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
