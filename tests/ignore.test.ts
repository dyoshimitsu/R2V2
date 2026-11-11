import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIgnore, globToRegExp } from "../src/ignore";

test("ignore globs", () => {
  assert.ok(globToRegExp("private").test("private/a/b.md"));
  assert.ok(!globToRegExp("private").test("private2/a.md"));
  assert.ok(globToRegExp("**/*.tmp").test("a/b/c.tmp"));
  assert.ok(globToRegExp("*.tmp").test("c.tmp"));
  assert.ok(!globToRegExp("*.tmp").test("a/c.tmp"));
  assert.ok(globToRegExp("notes/draft-*").test("notes/draft-1.md"));
});

test("pattern lists skip blank lines and match any pattern", () => {
  const ignored = compileIgnore("private\n\n  **/*.tmp  \n");
  assert.ok(ignored("private/a.md"));
  assert.ok(ignored("x/y.tmp"));
  assert.ok(!ignored("notes/a.md"));
  assert.ok(!compileIgnore("")("anything"));
});
