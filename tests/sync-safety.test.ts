// The properties a synchronizer has to keep (after Pierce & Vouillon's Unison
// specification): never overwrite a change the user made, never invent one, and
// bring both sides together wherever that is possible. The first part tests
// specific hazards; the second throws random histories at three devices.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isSafePath } from "../src/encrypted-remote";
import { ConflictAction, SyncOptions, SyncState, runSync } from "../src/sync";
import { MemoryFs, MemoryStore, PlainRemote, buf, str } from "./fakes";

class Device {
  fs = new MemoryFs();
  state: SyncState = { remoteId: "t", files: {} };
  remote: PlainRemote;

  constructor(store: MemoryStore) {
    this.remote = new PlainRemote(store);
  }

  sync(opts: SyncOptions = {}) {
    return runSync(this.fs, this.remote, this.state, opts);
  }
}

const devices = (n = 2) => {
  const store = new MemoryStore();
  return { store, all: Array.from({ length: n }, () => new Device(store)) };
};

// --- change detection ----------------------------------------------------------

test("an edit that leaves mtime and size unchanged right after a sync is still noticed", async () => {
  const { all } = devices();
  const [a, b] = all;
  a.fs.set("n.md", "aaaa");
  const mtime = a.fs.files.get("n.md")!.mtime;
  // The sync happens within moments of the save.
  await a.sync({ now: () => new Date(mtime + 500) });
  await b.sync();

  a.fs.files.set("n.md", { data: buf("bbbb"), mtime }); // same size, same timestamp
  const s = await a.sync({ now: () => new Date(mtime + 60_000) });
  assert.equal(s.uploaded, 1);
  await b.sync();
  assert.equal(b.fs.text("n.md"), "bbbb");
});

test("a file touched without being changed is not uploaded again", async () => {
  const { store, all } = devices();
  const [a] = all;
  a.fs.set("n.md", "same");
  await a.sync();
  const puts = store.puts;

  a.fs.files.get("n.md")!.mtime += 3_600_000; // e.g. copied, restored or checked out again
  const s = await a.sync();
  assert.equal(s.uploaded, 0);
  assert.equal(store.puts, puts);
  assert.equal(a.state.files["n.md"].mtime, a.fs.files.get("n.md")!.mtime);
});

test("touching a file on one device does not turn a remote edit into a conflict", async () => {
  const { all } = devices();
  const [a, b] = all;
  a.fs.set("n.md", "v1");
  await a.sync();
  await b.sync();

  b.fs.files.get("n.md")!.mtime += 3_600_000;
  a.fs.set("n.md", "v2");
  await a.sync();
  const s = await b.sync();
  assert.equal(s.conflicts.length, 0);
  assert.equal(s.downloaded, 1);
  assert.equal(b.fs.text("n.md"), "v2");
});

test("an edit made the instant a download lands is not mistaken for the downloaded version", async () => {
  const { all } = devices();
  const [a, b] = all;
  a.fs.set("n.md", "from a");
  await a.sync();

  // The user types into the file between our write and our look at the result.
  const write = b.fs.write.bind(b.fs);
  b.fs.write = async (path, data, mtime) => {
    await write(path, data, mtime);
    b.fs.set(path, "typed on b");
    return (await b.fs.stat(path))!;
  };
  const recordedAt = () => new Date(b.fs.files.get("n.md")!.mtime + 10);
  await b.sync({ now: recordedAt });
  b.fs.write = write;

  const s = await b.sync();
  assert.equal(s.uploaded, 1);
  await a.sync();
  assert.equal(a.fs.text("n.md"), "typed on b");
});

// --- deletions -------------------------------------------------------------------

test("a deletion does not remove a version another device uploaded meanwhile", async () => {
  const { store, all } = devices();
  const [a, b] = all;
  a.fs.set("n.md", "v1");
  await a.sync();
  await b.sync();

  a.fs.files.delete("n.md");
  b.fs.set("n.md", "v2 from b");
  const list = a.remote.list.bind(a.remote);
  a.remote.list = async () => {
    const listed = await list();
    await b.sync(); // b uploads after a has looked
    return listed;
  };
  const s = await a.sync();
  a.remote.list = list;
  assert.equal(s.deletedRemote, 0);
  assert.equal(s.skipped, 1);
  assert.equal(store.objects.size, 1);

  await a.sync();
  assert.equal(a.fs.text("n.md"), "v2 from b");
  await b.sync();
  assert.equal(b.fs.text("n.md"), "v2 from b");
});

test("an emptied bucket is not taken as an instruction to delete the vault", async () => {
  const { store, all } = devices();
  const [a] = all;
  for (let i = 0; i < 5; i++) a.fs.set(`f${i}.md`, `${i}`);
  await a.sync();

  store.objects.clear();
  const s = await a.sync();
  assert.equal(s.aborted, true);
  assert.equal(a.fs.paths().length, 5);
  assert.deepEqual(a.fs.trashed, []);
});

test("an empty local vault is not taken as an instruction to delete the bucket", async () => {
  const { store, all } = devices();
  const [a] = all;
  for (let i = 0; i < 5; i++) a.fs.set(`f${i}.md`, `${i}`);
  await a.sync();

  a.fs.files.clear(); // e.g. the folder is on a drive that is not mounted
  const s = await a.sync();
  assert.equal(s.aborted, true);
  assert.equal(store.objects.size, 5);

  const confirmed = await a.sync({ confirmLargeChange: async () => true });
  assert.equal(confirmed.deletedRemote, 5);
});

test("deleting the last files of a tiny vault needs no confirmation", async () => {
  const { store, all } = devices();
  const [a] = all;
  a.fs.set("one.md", "1");
  a.fs.set("two.md", "2");
  await a.sync();
  a.fs.files.clear();
  const s = await a.sync();
  assert.equal(s.deletedRemote, 2);
  assert.equal(store.objects.size, 0);
});

// --- conflict copies ---------------------------------------------------------------

test("a conflict copy never takes a name that is already in use", async () => {
  const { all } = devices(3);
  const [a, b, c] = all;
  const at = () => new Date(2026, 10, 11, 9, 0, 0);
  a.fs.set("n.md", "base");
  await a.sync();
  await b.sync();
  await c.sync();

  // b loses a conflict and uploads its copy.
  a.fs.set("n.md", "from a");
  b.fs.set("n.md", "from b");
  await a.sync();
  await b.sync({ now: at });
  await b.sync();

  // c, in the same second, also has a conflict on n.md, and already holds an
  // unsynced file under the very name the copy would get.
  c.fs.set("n.md", "from c");
  c.fs.set("n (conflict 20261111-090000).md", "c's own file");
  const s = await c.sync({ now: at });
  assert.equal(s.errors.length, 0);
  const contents = c.fs.paths().map((p) => c.fs.text(p));
  for (const kept of ["from a", "from b", "from c", "c's own file"]) assert.ok(contents.includes(kept), kept);
});

// --- names -----------------------------------------------------------------------

test("names differing only in case are left alone on a case-insensitive device", async () => {
  const { store, all } = devices();
  const [linux, mac] = all;
  linux.fs.set("Note.md", "upper");
  linux.fs.set("note.md", "lower");
  linux.fs.set("other.md", "fine");
  await linux.sync();

  mac.fs.foldsCase = true;
  for (let pass = 0; pass < 3; pass++) {
    const s = await mac.sync();
    assert.equal(s.errors.length, 2);
    assert.equal(s.deletedRemote + s.deletedLocal, 0);
  }
  assert.deepEqual(mac.fs.paths(), ["other.md"]);
  assert.equal(store.objects.size, 3);

  await linux.sync();
  assert.deepEqual(linux.fs.paths(), ["Note.md", "note.md", "other.md"]);
});

test("only paths that stay inside the vault are accepted from the remote", () => {
  for (const ok of ["a.md", "dir/a.md", "日記/2026-11-11.md", "a..b/c", ".hidden/x", "a b/c (1).md"]) {
    assert.ok(isSafePath(ok), ok);
  }
  for (const bad of [
    "",
    "/abs.md",
    "../up.md",
    "a/../../up.md",
    "a//b.md",
    "a/./b.md",
    "a/",
    "a\\b.md",
    "a\0b",
  ]) {
    assert.ok(!isSafePath(bad), JSON.stringify(bad));
  }
});

// --- interruption ------------------------------------------------------------------

test("progress is saved during a long pass, and a pass cut short is finished by the next one", async () => {
  const { all } = devices();
  const [a, b] = all;
  for (let i = 0; i < 60; i++) a.fs.set(`f${i}.md`, `${i}`);
  let checkpoints = 0;
  await a.sync({ onCheckpoint: async () => void checkpoints++ });
  assert.ok(checkpoints >= 2);

  // b is killed partway: files are on disk, the record of them is not.
  const saved: SyncState = { remoteId: "t", files: {} };
  await b.sync({
    onCheckpoint: async () => {
      if (Object.keys(saved.files).length === 0) saved.files = { ...b.state.files };
    },
  });
  assert.ok(Object.keys(saved.files).length > 0 && Object.keys(saved.files).length < 60);
  b.state = saved;
  const s = await b.sync();
  assert.equal(s.conflicts.length, 0);
  assert.equal(s.errors.length, 0);
  assert.equal(s.uploaded + s.deletedLocal + s.deletedRemote, 0);
  assert.equal(b.fs.paths().length, 60);
});

// --- random histories ----------------------------------------------------------------

const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

// R2V2_SEEDS=5000 npm test widens the search.
const SEEDS = Number(process.env.R2V2_SEEDS) || 300;

const randomHistories = async (conflictAction: ConflictAction, checkLoss: boolean) => {
  const paths = ["a.md", "b.md", "dir/c.md", "dir/d.md", "e.md"];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = prng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    const { store, all } = devices(3);

    const written = new Set<string>(); // every content a user ever typed
    const superseded = new Set<string>(); // replaced or deleted by the user who had it
    const propagated = new Set<string>(); // reached the bucket at some point
    const put = store.put.bind(store);
    store.put = async (key, data, opts) => {
      const etag = await put(key, data, opts);
      propagated.add(str(data));
      return etag;
    };
    const fail = (message: string) => assert.fail(`seed ${seed}: ${message}`);

    for (let step = 0; step < 60; step++) {
      const d = pick(all);
      const r = rand();
      if (r < 0.45) {
        const path = pick(paths);
        const before = d.fs.text(path);
        if (before !== undefined) superseded.add(before);
        const content = `s${seed}-${step}`;
        d.fs.set(path, content);
        written.add(content);
      } else if (r < 0.6) {
        const existing = d.fs.paths();
        if (existing.length) {
          const path = pick(existing);
          superseded.add(d.fs.text(path)!);
          d.fs.files.delete(path);
        }
      } else {
        const s = await d.sync({ conflictAction, confirmLargeChange: async () => true });
        if (s.errors.length) fail(`sync error ${JSON.stringify(s.errors)}`);
      }
    }

    // Let everything settle.
    let quiet = false;
    for (let round = 0; round < 12 && !quiet; round++) {
      quiet = true;
      for (const d of all) {
        const s = await d.sync({ conflictAction, confirmLargeChange: async () => true });
        if (s.errors.length) fail(`sync error ${JSON.stringify(s.errors)}`);
        if (s.uploaded + s.downloaded + s.deletedLocal + s.deletedRemote + s.conflicts.length + s.skipped)
          quiet = false;
      }
    }
    if (!quiet) fail("did not settle");

    const snapshot = (d: Device) => JSON.stringify(d.fs.paths().map((p) => [p, d.fs.text(p)]));
    if (snapshot(all[1]) !== snapshot(all[0]) || snapshot(all[2]) !== snapshot(all[0])) {
      fail(`devices differ:\n${all.map(snapshot).join("\n")}`);
    }
    if (store.objects.size !== all[0].fs.paths().length) fail("bucket and vaults differ");

    if (!checkLoss) continue;
    const surviving = new Set(all[0].fs.paths().map((p) => all[0].fs.text(p)!));
    for (const content of written) {
      if (!surviving.has(content) && !superseded.has(content) && !propagated.has(content)) {
        fail(`"${content}" was destroyed without ever being synced or replaced by its author`);
      }
    }
  }
};

test("random histories on three devices converge and never lose an unsynced edit", () =>
  randomHistories("keep_both", true));

// Keeping the newer version discards the older one by design, so only convergence is checked.
test("random histories converge when conflicts keep the newer version", () =>
  randomHistories("keep_newer", false));
