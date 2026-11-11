// Runs the real client against a real S3-compatible endpoint: an emulator in
// CI, or R2 itself when credentials are provided. Skipped unless configured:
//
//   R2V2_TEST_ENDPOINT           endpoint URL, or a Cloudflare account ID
//   R2V2_TEST_BUCKET
//   R2V2_TEST_ACCESS_KEY_ID
//   R2V2_TEST_SECRET_ACCESS_KEY
//   R2V2_TEST_REGION             optional, default "auto"
//   R2V2_TEST_CREATE_BUCKET=1    optional, create the bucket first (emulators)
//   R2V2_TEST_REQUIRED=1         optional, fail instead of skipping when unset
//
// Everything is written under a random prefix and removed afterwards.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { utf8 } from "../../src/bytes";
import { DATA_PREFIX, EncryptedRemote, META_KEY, WrongPasswordError } from "../../src/encrypted-remote";
import { HttpClient, R2Config, R2Store, resolveEndpoint } from "../../src/s3";
import { sha256Hex, signRequest } from "../../src/sigv4";
import { PreconditionFailedError, SyncState, runSync } from "../../src/sync";
import { MemoryFs, str } from "../fakes";

const env = process.env;
const configured =
  !!env.R2V2_TEST_ENDPOINT &&
  !!env.R2V2_TEST_BUCKET &&
  !!env.R2V2_TEST_ACCESS_KEY_ID &&
  !!env.R2V2_TEST_SECRET_ACCESS_KEY;
// CI sets this so that a missing configuration fails instead of passing by skipping.
if (!configured && env.R2V2_TEST_REQUIRED === "1") throw new Error("R2V2_TEST_* is not set");
const skip = configured ? false : "R2V2_TEST_* is not set";

const fetchHttp: HttpClient = async ({ url, method, headers, body }) => {
  const res = await fetch(url, { method, headers, body });
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((value, name) => (responseHeaders[name] = value));
  return { status: res.status, headers: responseHeaders, body: await res.arrayBuffer() };
};

const runPrefix = `r2v2-test/${randomBytes(6).toString("hex")}`;
const config = (prefix: string, extra: Partial<R2Config> = {}): R2Config => ({
  endpoint: env.R2V2_TEST_ENDPOINT!,
  bucket: env.R2V2_TEST_BUCKET!,
  prefix: `${runPrefix}/${prefix}`,
  credentials: {
    accessKeyId: env.R2V2_TEST_ACCESS_KEY_ID!,
    secretAccessKey: env.R2V2_TEST_SECRET_ACCESS_KEY!,
  },
  region: env.R2V2_TEST_REGION || "auto",
  ...extra,
});
const store = (prefix: string, extra: Partial<R2Config> = {}) =>
  new R2Store(config(prefix, extra), fetchHttp);

before(async () => {
  if (!configured || env.R2V2_TEST_CREATE_BUCKET !== "1") return;
  const base = new URL(resolveEndpoint(env.R2V2_TEST_ENDPOINT!));
  const path = `/${env.R2V2_TEST_BUCKET}`;
  const headers = signRequest({
    method: "PUT",
    host: base.host,
    path,
    query: "",
    payloadHash: sha256Hex(""),
    credentials: config("").credentials,
    region: env.R2V2_TEST_REGION || "auto",
  });
  const res = await fetch(`${base.origin}${path}`, { method: "PUT", headers });
  // 409: the bucket is already there, which is all we need.
  if (!res.ok && res.status !== 409) throw new Error(`create bucket: HTTP ${res.status} ${await res.text()}`);
});

after(async () => {
  if (!configured) return;
  const all = store("");
  for (const key of (await all.list("")).keys()) await all.delete(key);
});

test("objects round-trip, including awkward key names", { skip }, async () => {
  const s = store("roundtrip");
  const keys = ["plain", "with space/and+plus", "日本語/メモ (1)!.md", "sym/a&b=c?d#e%f*'~", "dots/a..b/.c"];
  for (const key of keys) {
    const etag = await s.put(key, utf8(`content of ${key}`), {});
    const got = await s.get(key);
    assert.ok(got, key);
    assert.equal(str(got.data), `content of ${key}`);
    assert.equal(got.etag, etag);
  }
  const listed = await s.list("");
  assert.deepEqual([...listed.keys()].sort(), [...keys].sort());
  for (const key of keys) assert.equal(listed.get(key)!.size, Buffer.byteLength(`content of ${key}`));

  assert.equal(await s.get("missing"), null);
  await s.delete("plain");
  assert.equal(await s.get("plain"), null);
  await s.delete("plain"); // deleting what is not there is not an error
});

test("binary content survives byte for byte", { skip }, async () => {
  const s = store("binary");
  const data = randomBytes(300_000);
  await s.put(
    "blob",
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    {},
  );
  assert.ok(Buffer.from((await s.get("blob"))!.data).equals(data));
});

test("the ETag changes with the content and matches across put, get and list", { skip }, async () => {
  const s = store("etag");
  const e1 = await s.put("k", utf8("one"), {});
  const e2 = await s.put("k", utf8("two"), {});
  assert.notEqual(e1, e2);
  assert.equal((await s.list("")).get("k")!.etag, e2);
  assert.equal((await s.get("k"))!.etag, e2);
});

test("conditional writes refuse to overwrite what changed", { skip }, async () => {
  const s = store("conditional");
  const e1 = await s.put("k", utf8("one"), { ifNoneMatch: true });
  await assert.rejects(() => s.put("k", utf8("again"), { ifNoneMatch: true }), PreconditionFailedError);
  assert.equal(str((await s.get("k"))!.data), "one");

  const e2 = await s.put("k", utf8("two"), { ifMatch: e1 });
  await assert.rejects(() => s.put("k", utf8("stale"), { ifMatch: e1 }), PreconditionFailedError);
  assert.equal(str((await s.get("k"))!.data), "two");
  assert.equal((await s.get("k"))!.etag, e2);
});

test("listing follows pagination and stays inside its prefix", { skip }, async () => {
  const s = store("paging", { pageSize: 2 });
  for (let i = 0; i < 5; i++) await s.put(`data/${i}`, utf8(`${i}`), {});
  await s.put("other/x", utf8("x"), {});
  await store("paging-neighbour").put("data/y", utf8("y"), {});
  assert.deepEqual(
    [...(await s.list("data/")).keys()].sort(),
    [0, 1, 2, 3, 4].map((i) => `data/${i}`),
  );
  assert.equal((await s.list("")).size, 6);
});

test("a wrong secret is rejected", { skip }, async () => {
  const bad = new R2Store(
    { ...config("auth"), credentials: { ...config("auth").credentials, secretAccessKey: "wrong-secret" } },
    fetchHttp,
  );
  await assert.rejects(() => bad.list(""), /HTTP 403/);
});

test("two devices sync through the bucket, and the bucket holds only ciphertext", { skip }, async () => {
  const s = store("vault");
  const device = () => ({ fs: new MemoryFs(), state: { remoteId: "it", files: {} } as SyncState });
  const a = device();
  const b = device();
  const sync = async (d: ReturnType<typeof device>, password = "integration password") => {
    const { remote } = await EncryptedRemote.open(s, password);
    return runSync(d.fs, remote, d.state);
  };

  a.fs.set("日記/secret-note.md", "TOP SECRET CONTENT");
  a.fs.set("img.bin", "\u0000\u0001\u0002");
  assert.equal((await sync(a)).uploaded, 2);
  assert.equal((await sync(b)).downloaded, 2);
  assert.equal(b.fs.text("日記/secret-note.md"), "TOP SECRET CONTENT");

  const raw = await s.list("");
  assert.equal(raw.size, 3);
  for (const key of raw.keys()) {
    assert.ok(key === META_KEY || key.startsWith(DATA_PREFIX), key);
    assert.ok(!key.includes("secret") && !key.includes("日記"), key);
    const body = Buffer.from((await s.get(key))!.data);
    assert.ok(!body.includes(Buffer.from("SECRET")));
  }

  b.fs.set("日記/secret-note.md", "edited on b");
  a.fs.files.delete("img.bin");
  await sync(b);
  const sa = await sync(a);
  assert.equal(sa.downloaded, 1);
  assert.equal(sa.deletedRemote, 1);
  assert.equal(a.fs.text("日記/secret-note.md"), "edited on b");
  assert.equal((await sync(b)).deletedLocal, 1);

  a.fs.set("日記/secret-note.md", "from a");
  b.fs.set("日記/secret-note.md", "from b");
  await sync(a);
  assert.equal((await sync(b)).conflicts.length, 1);
  assert.equal(b.fs.text("日記/secret-note.md"), "from a");

  await assert.rejects(() => sync(device(), "another password"), WrongPasswordError);
});
