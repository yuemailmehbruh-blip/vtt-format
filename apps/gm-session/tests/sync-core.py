#!/usr/bin/env python3
"""0.7.0 unit tests for the player sync core: hybrid logical clock, per-sheet change
log, last-writer-wins merge, offline queue, ack trimming, full sync both directions.
Uses sync_core directly, then PlayerHub (GM side) + PlayerStore (player side)
in-process without HTTP."""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))
sys.path.insert(0, str(APP.parent / "player-session"))
import yaml  # noqa: E402

import sync_core as sc  # noqa: E402
from player_store import PlayerStore  # noqa: E402
from server_lib import create_server  # noqa: E402

SAMPLE = APP.parents[1] / "examples" / "sample-campaign"


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


class FakeTime:
    def __init__(self, t):
        self.t = t

    def __call__(self):
        return self.t


def test_hlc():
    ft = FakeTime(1_000_000)
    a = sc.HLC("a", physical=ft)
    s1, s2 = a.now(), a.now()
    check(s1 < s2, "HLC: stamps from one node strictly increase with a frozen clock")
    ft.t = 999_000  # wall clock goes backwards
    s3 = a.now()
    check(s3 > s2, "HLC: wall clock moving backwards does not make stamps go back")
    # receiving from a node whose clock is ahead
    b = sc.HLC("b", physical=FakeTime(5_000_000))
    rb = b.now()
    s4 = a.recv(rb)
    check(s4 > rb and a.now() > rb, "HLC: after recv, local stamps order after the remote one (causality)")
    check(sc.parse_stamp(s4)[0] == 5_000_000, "HLC: logical time jumps to the remote physical time, counter carries order")
    check(sorted([s3, s1, s4, s2]) == [s1, s2, s3, s4], "HLC: string order == stamp order (fixed-width)")
    for bad in ("x", "1.2.a", 5, "0000000000001.00000.bad node"):
        try:
            sc.parse_stamp(bad)
            check(False, f"bad stamp {bad!r} rejected")
        except sc.SyncError:
            pass
    check(True, "HLC: malformed stamps are rejected")


def test_log_and_merge():
    ft = FakeTime(1000)
    ca, cb = sc.HLC("gm", physical=ft), sc.HLC("p1", physical=ft)
    A, B = sc.new_state(), sc.new_state()
    sc.record_local(A, "fields.hp", 10, ca.now(), "gm")
    sc.record_local(A, "fields.hp", 11, ca.now(), "gm")
    sc.record_local(A, "fields.ac", 15, ca.now(), "gm")
    check([e["k"] for e in A["log"]] == ["fields.hp", "fields.ac"] and A["log"][0]["v"] == 11,
          "log: repeated edits of one field compact to the newest entry")
    check(sc.record_local(A, "fields.ac", 15, ca.now(), "gm") is None, "log: unchanged value is not logged")
    # conflict: both edit hp; B later in HLC order
    ta = ca.now()
    ft.t = 2000
    tb = cb.now()
    for order in ("A-then-B", "B-then-A"):
        X = sc.new_state()
        chs = [{"k": "fields.hp", "v": "A", "t": ta}, {"k": "fields.hp", "v": "B", "t": tb}]
        if order == "B-then-A":
            chs.reverse()
        for ch in chs:
            sc.apply_remote(X, ch, "x")
        check(X["registers"]["fields.hp"]["v"] == "B", f"LWW: newer HLC stamp wins regardless of arrival order ({order})")
    # remote win drops a superseded pending local entry
    sc.record_local(B, "fields.hp", 99, cb.now(), "p1")
    newer = {"k": "fields.hp", "v": 5, "t": sc.make_stamp(9999, 0, "gm")}
    check(sc.apply_remote(B, newer, "gm") and not B["log"], "merge: a newer remote write supersedes the queued local edit")
    older = {"k": "fields.hp", "v": 1, "t": sc.make_stamp(1, 0, "gm")}
    check(not sc.apply_remote(B, older, "gm") and B["registers"]["fields.hp"]["v"] == 5, "merge: an older remote write loses")
    # ack trimming
    S = sc.new_state()
    for i in range(5):
        sc.record_local(S, f"fields.f{i}", i, ca.now(), "gm")
    check(sc.trim_acked(S, 3) == 3 and [e["seq"] for e in S["log"]] == [4, 5], "ack: trim drops entries with seq <= ack")
    check([c["seq"] for c in sc.pending_since(S, 4)] == [5], "pending_since returns only unacknowledged entries")
    # validation
    for bad, why in (([{"k": "name", "v": "x", "t": ta, "seq": 1}], "player cannot write name"),
                     ([{"k": "fields.bad key", "v": 1, "t": ta, "seq": 1}], "bad field id"),
                     ([{"k": "fields.hp", "v": 1, "t": "nope", "seq": 1}], "bad stamp"),
                     ([{"k": "fields.hp", "v": "x" * 100_000, "t": ta, "seq": 1}], "value too large"),
                     ("notalist", "not a list")):
        try:
            sc.validate_changes(bad, writer="player")
            check(False, f"validate rejects: {why}")
        except sc.SyncError:
            check(True, f"validate rejects: {why}")


def actor_fields(root, aid):
    return yaml.safe_load((root / f"world/actors/{aid}.yaml").read_text())["fields"]


def set_gm_field(root, aid, fid, v):
    p = root / f"world/actors/{aid}.yaml"
    d = yaml.safe_load(p.read_text())
    d["fields"][fid] = v
    p.write_text(yaml.safe_dump(d, sort_keys=False))


def test_hub_store():
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "camp"
        shutil.copytree(SAMPLE, root)
        server, _ = create_server(root, host="127.0.0.1", port=0, quiet=True)
        hub = server.RequestHandlerClass.player_hub
        try:
            stores = [PlayerStore(Path(tmp) / f"p{i}") for i in (1, 2)]
            for i, st in enumerate(stores):
                out = hub.join(st.player_id, f"Player {i + 1}", "")
                st.cfg["secrets"][out["campaign_id"]] = out["secret"]
                st.cfg["campaign_id"] = out["campaign_id"]
            p1, p2 = stores
            check(PlayerStore(Path(tmp) / "p1").player_id == p1.player_id, "player id is stable across restarts (config.json)")
            hub.gm_assign("party-fighter", [p1.player_id, p2.player_id])
            for st in stores:
                for a in hub.assigned_to(st.player_id):
                    st.apply_snapshot(hub.sheet_snapshot(st.player_id, a))
            check(p1.sheet_ids() == ["party-fighter"], "player receives only assigned sheets")
            check(p1.sheet_payload("party-fighter")["fields"]["hp_current"] == 20, "snapshot carries field values")

            def rnd(st):
                req = st.build_sync_request(hub.assigned_to(st.player_id))
                return st.apply_sync_response(hub.sync(st.player_id, req))

            # player edit → GM → other player
            p1.local_edit("party-fighter", {"fields.hp_current": 13})
            check(len(p1.load_sheet("party-fighter")["log"]) == 1, "player edit queued in its change log")
            req = p1.build_sync_request(["party-fighter"])
            check(len(req["sheets"]["party-fighter"]["changes"]) == 1, "sync request carries only the delta (1 change), not the sheet")
            rnd(p1)
            check(actor_fields(root, "party-fighter")["hp_current"] == 13, "GM actor file updated from player delta")
            check(not p1.load_sheet("party-fighter")["log"], "player log trimmed after GM ack")
            rnd(p2)
            check(p2.sheet_payload("party-fighter")["fields"]["hp_current"] == 13, "second assigned player receives the change via the GM")
            rnd(p1)
            gst = hub._load_state("party-fighter")
            check(len(gst["log"]) == 1, "GM keeps the entry while one assigned player has not acked it yet")
            rnd(p2)
            gst = hub._load_state("party-fighter")
            check(not gst["log"], "GM log trimmed once every assigned player acked")

            # GM edit → players
            set_gm_field(root, "party-fighter", "hp_max", 25)
            s = rnd(p1)
            check(p1.sheet_payload("party-fighter")["fields"]["hp_max"] == 25 and s["applied"] == 1, "GM file edit reaches player as a delta")
            rnd(p2); rnd(p1)

            # offline queue: several edits while offline, go across on next sync
            p1.local_edit("party-fighter", {"fields.STR": 17})
            p1.local_edit("party-fighter", {"fields.STR": 18})
            p1.local_edit("party-fighter", {"notes": "offline note"})
            log = p1.load_sheet("party-fighter")["log"]
            check(len(log) == 2, "offline edits queue (compacted per field: STR x2 + notes = 2 entries)")
            rnd(p1)
            f = actor_fields(root, "party-fighter")
            check(f["STR"] == 18, "queued offline edit applied on reconnect")
            check((root / "world/actors/party-fighter.sheet.txt").read_text() == "offline note", "notes synced into the sheet doc")
            rnd(p2); rnd(p1)

            # conflict: GM edits DEX first, player edits DEX later (both unsynced) → player wins
            set_gm_field(root, "party-fighter", "DEX", 1)
            hub.scan("party-fighter", st_ := hub._load_state("party-fighter")); hub._save_state("party-fighter", st_)
            import time as _t; _t.sleep(0.01)
            p1.local_edit("party-fighter", {"fields.DEX": 2})
            rnd(p1)
            check(actor_fields(root, "party-fighter")["DEX"] == 2 and p1.sheet_payload("party-fighter")["fields"]["DEX"] == 2,
                  "conflict: later player edit beats earlier GM edit on both sides")
            rnd(p2)
            check(p2.sheet_payload("party-fighter")["fields"]["DEX"] == 2, "conflict winner propagates to the other player")
            # reverse: player edits first (offline), GM edits later → GM wins
            p1.local_edit("party-fighter", {"fields.WIS": 3})
            _t.sleep(0.01)
            set_gm_field(root, "party-fighter", "WIS", 4)
            hub.scan("party-fighter", st_ := hub._load_state("party-fighter")); hub._save_state("party-fighter", st_)
            rnd(p1)
            check(actor_fields(root, "party-fighter")["WIS"] == 4 and p1.sheet_payload("party-fighter")["fields"]["WIS"] == 4,
                  "conflict: later GM edit beats earlier offline player edit on both sides")
            rnd(p2); rnd(p1)

            # full sync player → GM
            p1.local_edit("party-fighter", {"fields.CHA": 7})
            vals = p1.full_values("party-fighter")
            check("name" not in vals, "player full sync never includes GM-only keys (name)")
            set_gm_field(root, "party-fighter", "INT", 99)  # GM divergence gets overwritten
            hub.full_from_player(p1.player_id, "party-fighter", vals)
            p1.after_full_push("party-fighter")
            f = actor_fields(root, "party-fighter")
            check(f["CHA"] == 7 and f["INT"] == 10, "full sync player→GM overwrites the GM copy (INT back to player's 10)")
            rnd(p2)
            check(p2.sheet_payload("party-fighter")["fields"]["INT"] == 10, "player full sync propagates to other assigned players")
            rnd(p1)

            # full sync GM → player
            p1.local_edit("party-fighter", {"fields.AC": 1})  # unsent local edit gets discarded
            set_gm_field(root, "party-fighter", "AC", 19)
            hub.gm_full_to_player("party-fighter", p1.player_id)
            s = rnd(p1)
            sh = p1.load_sheet("party-fighter")
            check(s["full"] == ["party-fighter"] and sc.values_of(sh)["fields.AC"] == 19 and not sh["log"],
                  "full sync GM→player replaces the player copy and clears its pending log")
            rnd(p1)
            check(actor_fields(root, "party-fighter")["AC"] == 19, "discarded player edit does not come back to the GM")
            check(hub._load_state("party-fighter")["full_pending"] == {}, "full sync acknowledged → no longer pending")

            # unassign → archived on player
            hub.gm_assign("party-fighter", [p2.player_id])
            got = p1.archive_unassigned(set(hub.assigned_to(p1.player_id)))
            check(got == ["party-fighter"] and p1.sheet_ids() == [], "unassigned sheet leaves the player's active list (archived)")
        finally:
            server.server_close()


def main():
    test_hlc()
    test_log_and_merge()
    test_hub_store()
    print("sync-core: all ok")


if __name__ == "__main__":
    main()
