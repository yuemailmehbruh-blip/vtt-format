#!/usr/bin/env python3
"""0.7.1 Copy join IP: address ranking (most likely LAN first, virtual adapters last,
loopback/link-local skipped), /api/players exposes ranked addresses, and the
/api/clipboard fallback only accepts host:port text from the same origin."""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(APP))

import clipboard_os  # noqa: E402
import net_addrs  # noqa: E402
from server_lib import create_server  # noqa: E402

SAMPLE = APP.parents[1] / "examples" / "sample-campaign"


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("ok -", msg)


def req(method, url, body=None, headers=None):
    r = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method)
    r.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def test_rank():
    typical_windows = [
        {"ip": "172.24.16.1", "iface": "vEthernet (WSL)", "desc": "Hyper-V Virtual Ethernet Adapter", "virtual": True},
        {"ip": "192.168.56.1", "iface": "Ethernet 3", "desc": "VirtualBox Host-Only Ethernet Adapter"},
        {"ip": "100.88.1.7", "iface": "Tailscale", "desc": "Tailscale Tunnel"},
        {"ip": "10.0.0.23", "iface": "Wi-Fi", "default_route": True, "metric": 50},
        {"ip": "192.168.4.227", "iface": "Ethernet", "default_route": True, "metric": 25},
        {"ip": "127.0.0.1", "iface": "Loopback Pseudo-Interface 1"},
        {"ip": "169.254.10.2", "iface": "Ethernet 2"},
    ]
    r = net_addrs.rank(typical_windows)
    ips = [a["ip"] for a in r]
    check(ips[:2] == ["192.168.4.227", "10.0.0.23"], "private + default route first, lower route metric wins the tie")
    check(set(ips[2:]) == {"172.24.16.1", "192.168.56.1", "100.88.1.7"} and all(a["kind"] == "virtual" for a in r[2:]),
          "WSL/Hyper-V, VirtualBox and Tailscale ranked last as virtual")
    check("127.0.0.1" not in ips and "169.254.10.2" not in ips, "loopback and link-local skipped")
    r = net_addrs.rank([{"ip": "192.168.1.9", "iface": "Ethernet"}, {"ip": "10.1.1.1", "iface": "Ethernet 2"}], outbound="10.1.1.1")
    check(r[0]["ip"] == "10.1.1.1", "no route info: the OS outbound address wins the tie")
    r = net_addrs.rank([{"ip": "81.2.69.160", "iface": "Ethernet", "default_route": True}, {"ip": "192.168.0.10", "iface": "Wi-Fi"}])
    check(r[0]["ip"] == "192.168.0.10" and r[1]["kind"] == "other", "private range beats a public address")
    r = net_addrs.rank([{"ip": "192.168.0.10", "iface": "a"}, {"ip": "192.168.0.10", "iface": "b", "default_route": True}, {"ip": "nope"}])
    check(len(r) == 1 and r[0]["default_route"], "duplicates merged (best entry kept), junk ignored")
    for name in ("vEthernet (Default Switch)", "VMware Network Adapter VMnet8", "ZeroTier One", "docker0", "WireGuard Tunnel", "veth12ab"):
        check(net_addrs.is_virtual(name), f"virtual adapter recognised: {name}")
    for name in ("Ethernet", "Wi-Fi", "enp0s3", "wlan0", "Local Area Connection"):
        check(not net_addrs.is_virtual(name), f"real adapter not flagged: {name}")
    live = net_addrs.join_addresses(force=True)
    check(isinstance(live, list) and all("ip" in a and a["kind"] in ("lan", "other", "virtual") for a in live),
          f"live discovery works on this machine: {[a['ip'] for a in live]}")


def test_endpoints():
    copied = []
    clipboard_os.set_text = lambda t: copied.append(t) or True  # server_lib calls clipboard_os.set_text
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "camp"
        shutil.copytree(SAMPLE, root)
        server, gm = create_server(root, host="127.0.0.1", port=0, quiet=True, player_host="127.0.0.1", player_port=0)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        H = server.RequestHandlerClass
        try:
            st, d = req("GET", gm + "/api/players")
            h = d["hosting"]
            check(st == 200 and h["enabled"] and isinstance(h["address_info"], list), "/api/players returns ranked address_info")
            check(h["addresses"] == [a["ip"] for a in h["address_info"]], "addresses list follows the same ranking")
            st, d = req("POST", gm + "/api/clipboard", {"text": "192.168.4.227:8766"})
            check(st == 200 and d["ok"] and copied == ["192.168.4.227:8766"], "clipboard fallback copies exactly ip:port")
            for bad in ("rm -rf /; echo", "a" * 200, "", "line1\nline2", 5):
                st, _ = req("POST", gm + "/api/clipboard", {"text": bad})
                check(st == 400, f"clipboard fallback refuses non-address text: {str(bad)[:20]!r}")
            st, _ = req("POST", gm + "/api/clipboard", {"text": "1.2.3.4:5"}, {"Origin": "http://evil.example"})
            check(st == 403, "clipboard fallback refuses cross-site requests")
            P = f"http://127.0.0.1:{H.player_server.server_address[1]}"
            st, _ = req("POST", P + "/api/clipboard", {"text": "1.2.3.4:5"})
            check(st == 404, "clipboard endpoint is not on the player port")
            check(len(copied) == 1, "nothing else reached the clipboard")
        finally:
            server.shutdown(); server.server_close()
            H.player_server.shutdown(); H.player_server.server_close()


if __name__ == "__main__":
    test_rank()
    test_endpoints()
    print("join-addresses: all ok")
