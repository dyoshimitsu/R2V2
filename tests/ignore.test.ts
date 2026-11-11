import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIgnore, globToRegExp, withDefaultIgnores } from "../src/ignore";

test("a name without a slash matches at any depth", () => {
  for (const path of [
    ".git/config",
    "sub/.git/HEAD",
    "a/b/node_modules/x/index.js",
    ".DS_Store",
    "img/.DS_Store",
  ]) {
    assert.ok(compileIgnore(".git\nnode_modules\n.DS_Store")(path), path);
  }
  assert.ok(globToRegExp("*.tmp").test("c.tmp"));
  assert.ok(globToRegExp("*.tmp").test("a/b/c.tmp"));
  assert.ok(globToRegExp("private").test("private/a/b.md"));
  assert.ok(globToRegExp("private").test("work/private/a.md"));
  assert.ok(!globToRegExp("private").test("private2/a.md"));
  assert.ok(!globToRegExp(".git").test(".github/workflows/ci.yml"));
  assert.ok(!globToRegExp(".git").test("notes/.gitignore"));
});

test("a path with a slash is relative to the vault root", () => {
  assert.ok(globToRegExp("notes/draft-*").test("notes/draft-1.md"));
  assert.ok(!globToRegExp("notes/draft-*").test("archive/notes/draft-1.md"));
  assert.ok(globToRegExp("/todo.md").test("todo.md"));
  assert.ok(!globToRegExp("/todo.md").test("work/todo.md"));
  assert.ok(globToRegExp("**/*.tmp").test("a/b/c.tmp"));
  assert.ok(globToRegExp(".obsidian/workspace.json").test(".obsidian/workspace.json"));
  assert.ok(!globToRegExp(".obsidian/workspace.json").test(".obsidian/workspaces.json"));
});

test("the defaults keep tooling folders and per-device layout out of the sync", () => {
  const ignored = compileIgnore(withDefaultIgnores("", ".obsidian"));
  for (const path of [
    ".git/objects/ab/cdef",
    ".obsidian/plugins/some-plugin/.git/HEAD",
    ".obsidian/plugins/some-plugin/node_modules/x/index.js",
    ".trash/old.md",
    "attachments/.DS_Store",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
  ]) {
    assert.ok(ignored(path), path);
  }
  for (const path of [
    "notes/a.md",
    ".obsidian/app.json",
    ".obsidian/plugins/some-plugin/main.js",
    ".obsidian/hotkeys.json",
  ]) {
    assert.ok(!ignored(path), path);
  }
});

test("defaults are added without disturbing existing patterns, and only once each", () => {
  const merged = withDefaultIgnores("private\n.git\n", ".config");
  assert.deepEqual(merged.split("\n"), [
    "private",
    ".git",
    ".trash",
    "node_modules",
    ".DS_Store",
    ".config/workspace.json",
    ".config/workspace-mobile.json",
  ]);
  assert.equal(withDefaultIgnores(merged, ".config"), merged);
});

test("pattern lists skip blank lines and match any pattern", () => {
  const ignored = compileIgnore("private\n\n  **/*.tmp  \n");
  assert.ok(ignored("private/a.md"));
  assert.ok(ignored("x/y.tmp"));
  assert.ok(!ignored("notes/a.md"));
  assert.ok(!compileIgnore("")("anything"));
});
