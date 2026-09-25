"""0.7.1: which address should players type? Enumerate this computer's IPv4
addresses and rank them, most likely LAN address first.

Ranking (lower is better):
  0  private range (10/8, 172.16/12, 192.168/16) on an interface with a default route
  1  private range without a default route
  2  other non-private address (public, CGNAT 100.64/10 ...)
  +10 virtual adapter (vEthernet / Hyper-V / WSL / VirtualBox / VMware / Tailscale /
      ZeroTier / Docker / WireGuard / TAP / Hamachi ...) when identifiable
Ties: lower default-route metric, then the address the OS would use for outbound
traffic, then numeric order. Loopback (127/8) and link-local (169.254/16) are skipped.

Discovery: Windows → one hidden PowerShell call (Get-NetIPAddress / Get-NetRoute /
Get-NetAdapter, JSON); Linux → `ip -j`; fallback anywhere → UDP-connect trick +
getaddrinfo. Results are cached (30 s) because PowerShell takes ~1 s.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import time

VIRTUAL_RE = re.compile(
    r"vethernet|hyper-v|wsl|virtualbox|vbox|vmware|vmnet|tailscale|zerotier|docker|"
    r"wireguard|wintun|tap-|tap\b|tun\d|\btun\b|hamachi|npcap|loopback|virtual|"
    r"virbr|^br-|^veth|^docker|^lxc|^cni|^flannel|^utun|parallels|vpn",
    re.IGNORECASE,
)
CGNAT = ipaddress.ip_network("100.64.0.0/10")
RFC1918 = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))

_cache: dict = {"t": 0.0, "v": None}
_lock = threading.Lock()
CACHE_S = 30.0


def outbound_ip() -> str | None:
    """Address the OS picks for LAN/Internet traffic (no packet is sent)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
        finally:
            s.close()
    except OSError:
        return None


def is_virtual(*names: str | None) -> bool:
    return any(n and VIRTUAL_RE.search(n) for n in names)


def rank(candidates: list[dict], outbound: str | None = None) -> list[dict]:
    """candidates: [{ip, iface?, desc?, default_route?: bool, metric?: int}] → ranked,
    de-duplicated list of {ip, iface, kind: lan|other|virtual, score}."""
    best: dict[str, dict] = {}
    for c in candidates:
        try:
            ip = ipaddress.IPv4Address(str(c.get("ip", "")).strip())
        except ValueError:
            continue
        if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
            continue
        virtual = bool(c.get("virtual")) or is_virtual(c.get("iface"), c.get("desc"))
        private = any(ip in n for n in RFC1918)
        if ip in CGNAT:
            virtual = True  # 100.64/10: Tailscale-style overlay, not the LAN
        score = (0 if c.get("default_route") else 1) if private else 2
        if virtual:
            score += 10
        metric = c.get("metric")
        metric = int(metric) if isinstance(metric, (int, float)) else 100000
        key = (score, metric, 0 if str(ip) == outbound else 1, int(ip))
        entry = {
            "ip": str(ip),
            "iface": c.get("iface") or c.get("desc") or "",
            "kind": "virtual" if virtual else ("lan" if private else "other"),
            "default_route": bool(c.get("default_route")),
            "_key": key,
        }
        if str(ip) not in best or key < best[str(ip)]["_key"]:
            best[str(ip)] = entry
    out = sorted(best.values(), key=lambda e: e["_key"])
    for e in out:
        e.pop("_key")
    return out


# ------------------------------------------------------------------ discovery

_PS = r"""
$ErrorActionPreference='SilentlyContinue'
$a = @(Get-NetIPAddress -AddressFamily IPv4 | Select-Object IPAddress,InterfaceIndex,InterfaceAlias)
$r = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' | Select-Object InterfaceIndex,RouteMetric,InterfaceMetric)
$n = @(Get-NetAdapter -IncludeHidden | Select-Object ifIndex,InterfaceDescription,Virtual,Status)
@{a=$a; r=$r; n=$n} | ConvertTo-Json -Depth 4 -Compress
"""


def _windows() -> list[dict]:
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    out = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", _PS],
        capture_output=True, text=True, timeout=15, creationflags=flags,
    ).stdout
    data = json.loads(out or "{}")
    as_list = lambda v: v if isinstance(v, list) else ([v] if v else [])  # noqa: E731
    routes: dict[int, int] = {}
    for r in as_list(data.get("r")):
        idx = r.get("InterfaceIndex")
        m = int(r.get("RouteMetric") or 0) + int(r.get("InterfaceMetric") or 0)
        if idx is not None and (idx not in routes or m < routes[idx]):
            routes[idx] = m
    adapters = {n.get("ifIndex"): n for n in as_list(data.get("n"))}
    cands = []
    for a in as_list(data.get("a")):
        idx = a.get("InterfaceIndex")
        ad = adapters.get(idx) or {}
        cands.append({
            "ip": a.get("IPAddress"),
            "iface": a.get("InterfaceAlias"),
            "desc": ad.get("InterfaceDescription"),
            "virtual": bool(ad.get("Virtual")) if ad else False,
            "default_route": idx in routes,
            "metric": routes.get(idx),
        })
    return cands


def _linux() -> list[dict]:
    ip = shutil.which("ip")
    if not ip:
        return []
    addrs = json.loads(subprocess.run([ip, "-j", "-4", "addr"], capture_output=True, text=True, timeout=5).stdout or "[]")
    routes = json.loads(subprocess.run([ip, "-j", "-4", "route", "show", "default"], capture_output=True, text=True, timeout=5).stdout or "[]")
    rmetric: dict[str, int] = {}
    for r in routes:
        dev = r.get("dev")
        if dev:
            rmetric[dev] = min(rmetric.get(dev, 1 << 30), int(r.get("metric") or 0))
    cands = []
    for link in addrs:
        dev = link.get("ifname")
        for ai in link.get("addr_info") or []:
            if ai.get("family") == "inet":
                cands.append({"ip": ai.get("local"), "iface": dev, "default_route": dev in rmetric, "metric": rmetric.get(dev)})
    return cands


def _fallback() -> list[dict]:
    cands = []
    ob = outbound_ip()
    if ob:
        cands.append({"ip": ob, "default_route": True, "metric": 0})
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            cands.append({"ip": info[4][0]})
    except OSError:
        pass
    return cands


def discover() -> list[dict]:
    cands: list[dict] = []
    try:
        if os.name == "nt":
            cands = _windows()
        elif os.uname().sysname == "Linux":
            cands = _linux()
    except Exception:  # noqa: BLE001 - never break the Players dialog
        cands = []
    ob = outbound_ip()
    if not cands:
        cands = _fallback()
    elif ob and not any(c.get("ip") == ob for c in cands):
        cands.append({"ip": ob, "default_route": True})
    return rank(cands, ob)


def join_addresses(force: bool = False) -> list[dict]:
    with _lock:
        if not force and _cache["v"] is not None and time.time() - _cache["t"] < CACHE_S:
            return _cache["v"]
    v = discover()
    with _lock:
        _cache.update(t=time.time(), v=v)
    return v


def warm() -> None:
    """Fill the cache in the background at startup (PowerShell is slow)."""
    threading.Thread(target=join_addresses, name="net-addrs", daemon=True).start()
