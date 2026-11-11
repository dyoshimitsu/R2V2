import assert from "node:assert/strict";
import { test } from "node:test";
import { EncryptedRemote } from "../src/encrypted-remote";
import { Action, assessRisk, conflictPath, planSync, runSync } from "../src/sync";
import { pair } from "./fakes";

test("planner covers the three-way matrix", () => {
  const L = { mtime: 1, size: 1 };
  const R = { etag: "e", size: 1 };
  const B = { mtime: 1, size: 1, etag: "e" };
  const plan = (l: boolean | "mod", r: boolean | "mod", b: boolean) =>
    planSync(
      new Map(l ? [["k", l === "mod" ? { mtime: 2, size: 1 } : L]] : []),
      new Map(r ? [["k", r === "mod" ? { etag: "e2", size: 1 } : R]] : []),
      b ? { k: B } : {},
    )[0]?.type;

  assert.equal(plan(true, true, true), undefined);
  assert.equal(plan(true, false, false), "upload");
  assert.equal(plan(false, true, false), "download");
  assert.equal(plan(true, true, false), "conflict");
  assert.equal(plan("mod", true, true), "upload");
  assert.equal(plan(true, "mod", true), "download");
  assert.equal(plan("mod", "mod", true), "conflict");
  assert.equal(plan(false, true, true), "deleteRemote");
  assert.equal(plan(true, false, true), "deleteLocal");
  assert.equal(plan(false, "mod", true), "download"); // edit beats delete
  assert.equal(plan("mod", false, true), "upload");
  assert.equal(plan(false, false, true), "forget");
});

test("risk counts overwrites and deletions, not new files", () => {
  const L = { mtime: 1, size: 1 };
  const R = { etag: "e", size: 1 };
  const actions: Action[] = [
    { type: "upload", key: "new", local: L },
    { type: "download", key: "new2", remote: R },
    { type: "upload", key: "edit", local: L, remote: R },
    { type: "download", key: "edit2", local: L, remote: R },
    { type: "conflict", key: "c", local: L, remote: R },
    { type: "deleteLocal", key: "d", local: L },
    { type: "deleteRemote", key: "d2", remote: R },
    { type: "forget", key: "f" },
  ];
  assert.deepEqual(assessRisk(actions, 40), { changes: 5, deletions: 2, total: 40 });
});

test("conflict copy names", () => {
  const d = new Date(2026, 10, 11, 13, 45, 0);
  assert.equal(conflictPath("a/b.md", d), "a/b (conflict 20261111-134500).md");
  assert.equal(conflictPath("a.b/noext", d), "a.b/noext (conflict 20261111-134500)");
  assert.equal(conflictPath(".hidden", d), ".hidden (conflict 20261111-134500)");
  assert.equal(conflictPath("a/b.md", d, 2), "a/b (conflict 20261111-134500-2).md");
});

test("create, edit and delete propagate between two devices", async () => {
  const { a, b } = pair();
  a.fs.set("notes/one.md", "v1");
  a.fs.set("img.png", "\u0000binary");
  assert.equal((await a.sync()).uploaded, 2);

  assert.equal((await b.sync()).downloaded, 2);
  assert.equal(b.fs.text("notes/one.md"), "v1");
  // mtime travels with the file
  assert.equal(b.fs.files.get("notes/one.md")!.mtime, a.fs.files.get("notes/one.md")!.mtime);

  b.fs.set("notes/one.md", "v2");
  assert.equal((await b.sync()).uploaded, 1);
  assert.equal((await a.sync()).downloaded, 1);
  assert.equal(a.fs.text("notes/one.md"), "v2");

  a.fs.files.delete("img.png");
  assert.equal((await a.sync()).deletedRemote, 1);
  assert.equal((await b.sync()).deletedLocal, 1);
  assert.deepEqual(b.fs.paths(), ["notes/one.md"]);
  assert.deepEqual(b.fs.trashed, ["img.png"]);

  // A settled pair does nothing.
  for (const d of [a, b]) {
    const s = await d.sync();
    assert.deepEqual(
      [s.uploaded, s.downloaded, s.deletedLocal, s.deletedRemote, s.conflicts.length, s.errors.length],
      [0, 0, 0, 0, 0, 0],
    );
  }
});

test("concurrent edits keep both versions", async () => {
  const { a, b } = pair();
  a.fs.set("n.md", "base");
  await a.sync();
  await b.sync();

  a.fs.set("n.md", "from A");
  b.fs.set("n.md", "from B");
  await a.sync();
  const s = await b.sync({ now: () => new Date(2026, 10, 11, 9, 0, 0) });
  assert.deepEqual(s.conflicts, ["n (conflict 20261111-090000).md"]);
  assert.equal(b.fs.text("n.md"), "from A");
  assert.equal(b.fs.text("n (conflict 20261111-090000).md"), "from B");

  await b.sync(); // uploads the conflict copy
  await a.sync();
  assert.equal(a.fs.text("n (conflict 20261111-090000).md"), "from B");
  assert.equal(a.fs.text("n.md"), "from A");
});

test("keep_newer resolves a conflict toward the later edit", async () => {
  const { a, b } = pair();
  a.fs.set("n.md", "base");
  await a.sync();
  await b.sync();

  a.fs.set("n.md", "older");
  await a.sync();
  b.fs.set("n.md", "newer");
  b.fs.files.get("n.md")!.mtime = a.fs.files.get("n.md")!.mtime + 5000;
  const s = await b.sync({ conflictAction: "keep_newer" });
  assert.equal(s.conflicts.length, 0);
  assert.equal(s.uploaded, 1);
  await a.sync();
  assert.equal(a.fs.text("n.md"), "newer");
});

test("first sync of two identical copies is not a conflict", async () => {
  const { store, a, b } = pair();
  a.fs.set("same.md", "identical");
  b.fs.set("same.md", "identical");
  await a.sync();
  const puts = store.puts;
  const s = await b.sync();
  assert.equal(s.conflicts.length, 0);
  assert.equal(store.puts, puts);
  assert.deepEqual(b.fs.paths(), ["same.md"]);
});

test("an edit survives a delete on the other device", async () => {
  const { a, b } = pair();
  a.fs.set("n.md", "base");
  await a.sync();
  await b.sync();
  a.fs.files.delete("n.md");
  await a.sync();
  b.fs.set("n.md", "edited");
  assert.equal((await b.sync()).uploaded, 1);
  await a.sync();
  assert.equal(a.fs.text("n.md"), "edited");
});

test("a large wave of changes needs confirmation, and aborting changes nothing", async () => {
  const { store, a, b } = pair();
  for (let i = 0; i < 20; i++) a.fs.set(`f${i}.md`, `${i}`);
  await a.sync();
  await b.sync();

  for (let i = 0; i < 15; i++) a.fs.files.delete(`f${i}.md`);
  const before = store.objects.size;
  const refused = await a.sync();
  assert.equal(refused.aborted, true);
  assert.equal(store.objects.size, before);

  let asked: unknown = null;
  const ok = await a.sync({
    confirmLargeChange: async (info) => {
      asked = info;
      return true;
    },
  });
  assert.deepEqual(asked, { changes: 15, deletions: 15, total: 20 });
  assert.equal(ok.deletedRemote, 15);
});

test("excluded paths are left alone on both sides", async () => {
  const { a, b } = pair();
  const include = (k: string) => !k.startsWith("private/");
  a.fs.set("private/x.md", "mine");
  a.fs.set("pub.md", "shared");
  await a.sync({ include });
  await b.sync({ include });
  assert.deepEqual(b.fs.paths(), ["pub.md"]);

  // B syncs everything; A still excludes the folder and must neither fetch nor delete it.
  b.fs.set("private/y.md", "b's");
  await b.sync();
  const s = await a.sync({ include });
  assert.equal(s.downloaded + s.deletedLocal + s.deletedRemote, 0);
  assert.deepEqual(a.fs.paths(), ["private/x.md", "pub.md"]);
});

test("a lost upload race is retried as a conflict, not overwritten", async () => {
  const { a, b } = pair();
  a.fs.set("n.md", "base");
  await a.sync();
  await b.sync();

  b.fs.set("n.md", "from B");
  a.fs.set("n.md", "from A");
  // A lists the remote, then B uploads before A does.
  const opened = await EncryptedRemote.open(a.store, "correct horse");
  const remote = opened.remote;
  const originalList = remote.list.bind(remote);
  remote.list = async () => {
    const listed = await originalList();
    await b.sync();
    return listed;
  };
  const s = await runSync(a.fs, remote, a.state);
  assert.equal(s.uploaded, 0);
  assert.equal(s.skipped, 1);
  const again = await a.sync();
  assert.equal(again.conflicts.length, 1);
  assert.equal(a.fs.text("n.md"), "from B");
});
