/**
 * Sidebar organization trees (0.6.19): pure operations shared by the GM map
 * view and node tests. A panel tree is an ordered array of nodes:
 *   folder: { folder: "f_<hex>", name, collapsed, children: [...] }
 *   item:   { map|actor|scene: "<id>" }
 * Persisted by the server in world/organization.yaml. No mutation of inputs:
 * every op returns a new tree.
 */
(function (global) {
  "use strict";

  const ITEM_KEY = { maps: "map", actors: "actor", scenes: "scene" };
  const MAX_DEPTH = 16;

  function clone(tree) {
    return JSON.parse(JSON.stringify(tree || []));
  }

  function isFolder(n) {
    return !!(n && typeof n.folder === "string");
  }

  /** Stable ref for a node: "folder:<id>" or "<key>:<id>". */
  function refOf(panel, n) {
    if (isFolder(n)) return `folder:${n.folder}`;
    const key = ITEM_KEY[panel];
    return n && n[key] != null ? `${key}:${n[key]}` : null;
  }

  /** Locate a node by ref → { node, parent (array), index, depth, path } or null. */
  function find(panel, tree, ref) {
    let hit = null;
    (function walk(nodes, depth, path) {
      for (let i = 0; i < nodes.length && !hit; i++) {
        const n = nodes[i];
        if (refOf(panel, n) === ref) {
          hit = { node: n, parent: nodes, index: i, depth, path };
          return;
        }
        if (isFolder(n)) walk(n.children || (n.children = []), depth + 1, path.concat(n.folder));
      }
    })(tree, 0, []);
    return hit;
  }

  function folderDepth(n) {
    if (!isFolder(n)) return 0;
    let d = 0;
    for (const c of n.children || []) d = Math.max(d, folderDepth(c));
    return 1 + d;
  }

  function newFolderId() {
    let s = "";
    for (let i = 0; i < 10; i++) s += Math.floor(Math.random() * 16).toString(16);
    return `f_${s}`;
  }

  /** Add a folder at root or inside parentFolderId (appended). */
  function addFolder(panel, tree, name, parentFolderId, id) {
    const out = clone(tree);
    const node = { folder: id || newFolderId(), name: String(name || "New folder").trim() || "New folder", collapsed: false, children: [] };
    if (parentFolderId) {
      const p = find(panel, out, `folder:${parentFolderId}`);
      if (!p) throw new Error(`folder not found: ${parentFolderId}`);
      if (p.depth + 1 >= MAX_DEPTH) throw new Error("folders nested too deep");
      p.node.children.push(node);
      p.node.collapsed = false;
    } else {
      out.push(node);
    }
    return { tree: out, folder: node };
  }

  /** Delete a folder: its children take its place in the parent (never lost). */
  function deleteFolder(panel, tree, folderId) {
    const out = clone(tree);
    const f = find(panel, out, `folder:${folderId}`);
    if (!f) return out;
    f.parent.splice(f.index, 1, ...(f.node.children || []));
    return out;
  }

  function renameFolder(panel, tree, folderId, name) {
    const out = clone(tree);
    const f = find(panel, out, `folder:${folderId}`);
    const clean = String(name || "").trim();
    if (f && clean) f.node.name = clean;
    return out;
  }

  function setCollapsed(panel, tree, folderId, collapsed) {
    const out = clone(tree);
    const f = find(panel, out, `folder:${folderId}`);
    if (f) f.node.collapsed = !!collapsed;
    return out;
  }

  /**
   * Move node `ref` relative to `targetRef`:
   *   pos "inside" → last child of target folder; "before"/"after" → sibling;
   *   targetRef null → end of root.
   * Refuses (returns null) moving a folder into itself/descendant or past depth.
   */
  function move(panel, tree, ref, targetRef, pos) {
    if (ref === targetRef) return null;
    const out = clone(tree);
    const src = find(panel, out, ref);
    if (!src) return null;
    if (targetRef) {
      const tgt0 = find(panel, out, targetRef);
      if (!tgt0) return null;
      if (isFolder(src.node) && tgt0.path.includes(src.node.folder)) return null;
      if (pos === "inside" && !isFolder(tgt0.node)) pos = "after";
      const newDepth = (pos === "inside" ? tgt0.depth + 1 : tgt0.depth) + folderDepth(src.node);
      if (newDepth > MAX_DEPTH) return null;
    }
    src.parent.splice(src.index, 1);
    if (!targetRef) {
      out.push(src.node);
      return out;
    }
    const tgt = find(panel, out, targetRef);
    if (pos === "inside") {
      tgt.node.children = tgt.node.children || [];
      tgt.node.children.push(src.node);
      tgt.node.collapsed = false;
    } else {
      tgt.parent.splice(pos === "before" ? tgt.index : tgt.index + 1, 0, src.node);
    }
    return out;
  }

  /** Flatten to visible rows for rendering: [{node, depth, ref}] honoring collapse. */
  function rows(panel, tree) {
    const out = [];
    (function walk(nodes, depth) {
      for (const n of nodes || []) {
        out.push({ node: n, depth, ref: refOf(panel, n) });
        if (isFolder(n) && !n.collapsed) walk(n.children, depth + 1);
      }
    })(tree, 0);
    return out;
  }

  /** All item ids in tree order (for tests / fallbacks). */
  function itemIds(panel, tree) {
    const key = ITEM_KEY[panel];
    const ids = [];
    (function walk(nodes) {
      for (const n of nodes || []) {
        if (isFolder(n)) walk(n.children);
        else if (n && n[key] != null) ids.push(n[key]);
      }
    })(tree);
    return ids;
  }

  /** Append items missing from tree (e.g. created elsewhere) at root. */
  function reconcile(panel, tree, ids) {
    const key = ITEM_KEY[panel];
    const out = clone(tree);
    const have = new Set(itemIds(panel, out));
    for (const id of ids || []) if (!have.has(id)) out.push({ [key]: id });
    return out;
  }

  const api = {
    ITEM_KEY,
    MAX_DEPTH,
    isFolder,
    refOf,
    find,
    addFolder,
    deleteFolder,
    renameFolder,
    setCollapsed,
    move,
    rows,
    itemIds,
    reconcile,
    newFolderId,
  };
  global.OrgTree = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
