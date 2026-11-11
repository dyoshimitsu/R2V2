import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_PREFIX, META_KEY, WrongPasswordError } from "../src/encrypted-remote";
import { Device, MemoryStore, pair } from "./fakes";

test("nothing readable reaches the bucket", async () => {
  const { store, a } = pair();
  a.fs.set("secret-folder/secret-note.md", "TOP SECRET CONTENT");
  await a.sync();
  for (const [key, obj] of store.objects) {
    assert.ok(!key.includes("secret"), key);
    if (key === META_KEY) continue;
    assert.ok(key.startsWith(DATA_PREFIX));
    assert.ok(!Buffer.from(obj.data).includes(Buffer.from("SECRET")));
  }
  assert.equal(store.objects.size, 2);
});

test("a wrong password is rejected before anything is touched", async () => {
  const store = new MemoryStore();
  const a = new Device(store);
  a.fs.set("a.md", "1");
  await a.sync();
  const intruder = new Device(store, "wrong");
  intruder.fs.set("b.md", "2");
  await assert.rejects(() => intruder.sync(), WrongPasswordError);
  assert.equal(store.objects.size, 2);
  assert.deepEqual(intruder.fs.paths(), ["b.md"]);
});

test("two devices initialising at once agree on one salt", async () => {
  const { store, a, b } = pair();
  a.fs.set("a.md", "from a");
  b.fs.set("b.md", "from b");
  // B finds no metadata, then A initialises the remote before B can write its own.
  const realGet = store.get.bind(store);
  let first = true;
  store.get = async (key) => {
    if (key === META_KEY && first) {
      first = false;
      const seen = await realGet(key);
      await a.sync();
      return seen;
    }
    return realGet(key);
  };
  await b.sync();
  await a.sync();
  assert.deepEqual(a.fs.paths(), ["a.md", "b.md"]);
  assert.deepEqual(b.fs.paths(), ["a.md", "b.md"]);
});
