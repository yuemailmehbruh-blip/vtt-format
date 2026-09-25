/**
 * 0.6.19: pure sidebar tree ops (org-tree.js): folders add/rename/delete
 * (contents move up), collapse, drag moves (before/after/inside/root), cycle
 * and depth guards, rows honoring collapse, reconcile.
 * Run: node apps/gm-session/tests/org-tree.mjs
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import vm from "vm";
import assert from "assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sandbox = { console, Math, JSON, Error, Set, Object, Array, String };
sandbox.globalThis = sandbox;
vm.runInNewContext(readFileSync(join(__dirname, "..", "org-tree.js"), "utf8"), sandbox);
const OT = sandbox.OrgTree;
const P = "actors";
const plain = (x) => JSON.parse(JSON.stringify(x));
let n = 0;
const ok = (msg) => { n++; console.log("ok -", msg); };

let tree = [{ actor: "a" }, { actor: "b" }, { actor: "c" }];
const frozen = JSON.stringify(tree);

// addFolder
let r = OT.addFolder(P, tree, "Heroes", null, "f_hero0001");
tree = r.tree;
assert.equal(JSON.stringify([{ actor: "a" }, { actor: "b" }, { actor: "c" }]), frozen);
assert.deepEqual(plain(tree[3]), { folder: "f_hero0001", name: "Heroes", collapsed: false, children: [] });
ok("addFolder appends at root, inputs not mutated");
assert.match(OT.newFolderId(), /^f_[0-9a-f]{10}$/);
ok("folder ids match server pattern");

// move inside / before / after / root
tree = OT.move(P, tree, "actor:a", "folder:f_hero0001", "inside");
assert.deepEqual(plain(OT.itemIds(P, tree)), ["b", "c", "a"]);
assert.deepEqual(plain(tree[2].children), [{ actor: "a" }]);
ok("move item inside folder");
tree = OT.move(P, tree, "actor:c", "actor:a", "before");
assert.deepEqual(plain(tree[1].children), [{ actor: "c" }, { actor: "a" }]);
ok("move item before an item inside a folder");
tree = OT.move(P, tree, "actor:b", "actor:a", "after");
assert.deepEqual(plain(OT.itemIds(P, tree)), ["c", "a", "b"]);
ok("move after");
tree = OT.move(P, tree, "actor:c", null, "after");
assert.deepEqual(plain(tree[tree.length - 1]), { actor: "c" });
ok("drop on empty space → end of root");
const onItemInside = OT.move(P, tree, "actor:c", "actor:a", "inside");
assert.equal(OT.find(P, onItemInside, "actor:c").parent, OT.find(P, onItemInside, "actor:a").parent);
ok("'inside' on an item degrades to after (items are not containers)");

// nested folders + cycle guard + folder move
r = OT.addFolder(P, tree, "Sub", "f_hero0001", "f_sub00001");
tree = r.tree;
assert.equal(OT.find(P, tree, "folder:f_sub00001").depth, 1);
ok("nested folder");
assert.equal(OT.move(P, tree, "folder:f_hero0001", "folder:f_sub00001", "inside"), null);
assert.equal(OT.move(P, tree, "folder:f_hero0001", "folder:f_hero0001", "inside"), null);
ok("folder cannot move into itself or a descendant");
tree = OT.move(P, tree, "folder:f_sub00001", "actor:c", "before");
assert.equal(OT.find(P, tree, "folder:f_sub00001").depth, 0);
ok("folder moves out to root");
tree = OT.move(P, tree, "actor:c", "folder:f_sub00001", "inside");

// collapse + rows
tree = OT.setCollapsed(P, tree, "f_hero0001", true);
const refs = OT.rows(P, tree).map((x) => x.ref);
assert.deepEqual(plain(refs), ["folder:f_hero0001", "folder:f_sub00001", "actor:c"]);
ok("rows hide children of collapsed folders");
tree = OT.setCollapsed(P, tree, "f_hero0001", false);
assert.equal(OT.rows(P, tree).length, 5);
assert.deepEqual(plain(OT.rows(P, tree).map((x) => x.depth)), [0, 1, 1, 0, 1]);
ok("expanded rows carry depth");

// rename
tree = OT.renameFolder(P, tree, "f_hero0001", "  Party  ");
assert.equal(OT.find(P, tree, "folder:f_hero0001").node.name, "Party");
assert.equal(OT.find(P, OT.renameFolder(P, tree, "f_hero0001", "  "), "folder:f_hero0001").node.name, "Party");
ok("renameFolder trims, ignores blank");

// delete folder → children spliced into parent at its position
const before = OT.itemIds(P, tree).slice().sort();
tree = OT.addFolder(P, tree, "Inner", "f_hero0001", "f_inner001").tree;
tree = OT.move(P, tree, "actor:a", "folder:f_inner001", "inside");
tree = OT.deleteFolder(P, tree, "f_hero0001");
assert.deepEqual(plain(OT.itemIds(P, tree).slice().sort()), plain(before));
assert.deepEqual(plain(tree.map((x) => x.folder || x.actor)), ["b", "f_inner001", "f_sub00001"]);
assert.deepEqual(plain(tree[1].children), [{ actor: "a" }]);
ok("deleteFolder moves contents (incl. subfolders) up, loses nothing");

// depth guard
let deep = [];
let parent = null;
for (let i = 0; i < OT.MAX_DEPTH; i++) {
  const res = OT.addFolder(P, deep, "d", parent, `f_deep${String(i).padStart(4, "0")}`);
  deep = res.tree;
  parent = res.folder.folder;
}
assert.throws(() => OT.addFolder(P, deep, "x", parent));
ok("addFolder refuses nesting past MAX_DEPTH");
deep = OT.addFolder(P, deep, "top", null, "f_top00001").tree;
deep = OT.addFolder(P, deep, "kid", "f_top00001", "f_kid00001").tree;
assert.equal(OT.move(P, deep, "folder:f_top00001", `folder:${parent}`, "inside"), null);
ok("move refuses a subtree that would exceed MAX_DEPTH");

// reconcile + other panels
const rec = OT.reconcile("scenes", [{ scene: "x" }], ["x", "y"]);
assert.deepEqual(plain(rec), [{ scene: "x" }, { scene: "y" }]);
ok("reconcile appends missing items");
assert.equal(OT.refOf("maps", { map: "m1" }), "map:m1");
ok("refs per panel");
console.log(`org-tree: ${n} passed`);
