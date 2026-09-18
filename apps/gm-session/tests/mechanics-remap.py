#!/usr/bin/env python3
"""Remap + duplicate-name reject for mechanics library import."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server_lib import entry_names_in_nodes, remap_mechanic_subgraph, safe_mechanic_name


def main() -> None:
    assert safe_mechanic_name("attack")
    assert safe_mechanic_name("my_fn-2")
    assert not safe_mechanic_name("../x")
    assert not safe_mechanic_name("a b")
    assert not safe_mechanic_name("a.b")

    nodes = [
        {"id": "e1", "kind": "entry", "name": "attack", "x": 0, "y": 0},
        {"id": "r1", "kind": "roll", "sides": 20, "x": 100, "y": 0},
    ]
    edges = [{"id": "w1", "from": "e1", "to": "r1", "toPort": 0}]
    collapsed = [{"id": "c1", "name": "attack", "nodeIds": ["e1", "r1"], "x": 0, "y": 0}]

    n2, e2, c2, id_map = remap_mechanic_subgraph(nodes, edges, collapsed)
    assert len(n2) == 2 and len(e2) == 1 and len(c2) == 1
    assert set(id_map.keys()) == {"e1", "r1"}
    assert n2[0]["id"] != "e1" and n2[1]["id"] != "r1"
    assert e2[0]["from"] == id_map["e1"] and e2[0]["to"] == id_map["r1"]
    assert e2[0]["id"] != "w1"
    # entry name preserved
    entry = next(n for n in n2 if n["kind"] == "entry")
    assert entry["name"] == "attack"
    assert set(c2[0]["nodeIds"]) == {id_map["e1"], id_map["r1"]}

    # second remap yields different ids (no collision with first)
    n3, e3, c3, id_map2 = remap_mechanic_subgraph(nodes, edges, collapsed)
    assert set(x["id"] for x in n2).isdisjoint(set(x["id"] for x in n3))

    existing = [{"id": "x", "kind": "entry", "name": "attack"}]
    assert "attack" in entry_names_in_nodes(existing)
    assert "attack" not in entry_names_in_nodes([{"id": "x", "kind": "roll"}])

    print("mechanics-remap: ok")


if __name__ == "__main__":
    main()
