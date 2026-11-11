// Checks on the encryption itself: that the format is what the README says
// (verified with an independent decryptor), that any modification is detected,
// and that a hostile bucket cannot make a device accept or reveal anything.
import assert from "node:assert/strict";
import { createHmac, scryptSync, webcrypto } from "node:crypto";
import { test } from "node:test";
import { utf8 } from "../src/bytes";
import { Cipher, DEFAULT_KDF, KdfParams, assertSaneKdf } from "../src/cipher";
import { DATA_PREFIX, META_KEY, RemoteMeta, WrongPasswordError } from "../src/encrypted-remote";
import { Device, MemoryStore, buf, pair, str } from "./fakes";

const KDF: KdfParams = { name: "scrypt", N: 32768, r: 8, p: 1 };
const SALT = Buffer.from("fedcba9876543210");
const cipher = () => Cipher.derive("pässword", SALT, KDF);

/** Keys derived straight from the documented recipe, without the plugin's code. */
const independentKeys = (password: string) => {
  const okm = scryptSync(password.normalize("NFKC"), SALT, 96, { N: KDF.N, r: 8, p: 1, maxmem: 2 ** 27 });
  return { content: okm.subarray(0, 32), name: okm.subarray(32, 64), nameMac: okm.subarray(64, 96) };
};

const gcmDecrypt = async (key: Buffer, nonce: Buffer, body: Buffer, aad?: Buffer) => {
  const k = await webcrypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
  return Buffer.from(
    await webcrypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad ?? Buffer.alloc(0), tagLength: 128 },
      k,
      body,
    ),
  );
};

test("the format matches its specification (independent decryptor)", async () => {
  const c = await cipher();
  const keys = independentKeys("pässword");

  const name = c.encryptName("日記/2026-11-11.md");
  const rawName = Buffer.from(name, "base64url");
  const path = await gcmDecrypt(keys.name, rawName.subarray(0, 12), rawName.subarray(12));
  assert.equal(path.toString("utf8"), "日記/2026-11-11.md");
  assert.ok(
    createHmac("sha256", keys.nameMac).update(path).digest().subarray(0, 12).equals(rawName.subarray(0, 12)),
  );

  const enc = Buffer.from(c.encryptContent(buf("hello, vault"), 1_762_850_000_123, name));
  assert.equal(enc.subarray(0, 5).toString("latin1"), "R2V2\u0001");
  const aad = Buffer.concat([enc.subarray(0, 5), Buffer.from(name, "utf8")]);
  const plain = await gcmDecrypt(keys.content, enc.subarray(5, 17), enc.subarray(17), aad);
  assert.equal(plain.readBigUInt64BE(0), 1_762_850_000_123n);
  assert.equal(plain.subarray(8).toString("utf8"), "hello, vault");
  // 5 header + 12 nonce + 8 mtime + 16 tag: the only thing size reveals is size.
  assert.equal(enc.length, "hello, vault".length + 41);
});

test("the three keys are distinct", () => {
  const k = independentKeys("pässword");
  assert.ok(!k.content.equals(k.name) && !k.name.equals(k.nameMac) && !k.content.equals(k.nameMac));
});

test("flipping any single bit of a ciphertext is detected", async () => {
  const c = await cipher();
  const enc = Buffer.from(c.encryptContent(buf("attack at dawn"), 42, "obj"));
  for (let i = 0; i < enc.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      const t = Buffer.from(enc);
      t[i] ^= 1 << bit;
      assert.throws(() => c.decryptContent(utf8ab(t), "obj"), `byte ${i} bit ${bit}`);
    }
  }
});

test("truncating or extending a ciphertext is detected", async () => {
  const c = await cipher();
  const enc = Buffer.from(c.encryptContent(buf("attack at dawn"), 42, "obj"));
  for (let len = 0; len < enc.length; len++) {
    assert.throws(() => c.decryptContent(utf8ab(enc.subarray(0, len)), "obj"), `length ${len}`);
  }
  assert.throws(() => c.decryptContent(utf8ab(Buffer.concat([enc, Buffer.from([0])])), "obj"));
});

test("a ciphertext is only valid under the object name it was written for", async () => {
  const c = await cipher();
  const enc = c.encryptContent(buf("x"), 1, "name-a");
  assert.throws(() => c.decryptContent(enc, "name-b"));
  assert.throws(() => c.decryptContent(enc, ""));
  assert.equal(str(c.decryptContent(enc, "name-a").data), "x");
});

test("changing any character of an encrypted name is detected", async () => {
  const c = await cipher();
  const name = c.encryptName("notes/a.md");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < name.length; i++) {
    for (const ch of alphabet) {
      if (ch === name[i]) continue;
      const forged = name.slice(0, i) + ch + name.slice(i + 1);
      // The final character may carry unused bits, so the bytes can be unchanged.
      if (Buffer.from(forged, "base64url").equals(Buffer.from(name, "base64url"))) continue;
      assert.equal(c.decryptName(forged), null, `position ${i} -> ${ch}`);
    }
  }
  assert.equal(c.decryptName(name.slice(0, -4)), null);
  assert.equal(c.decryptName(""), null);
});

test("nonces never repeat and equal plaintexts give unrelated ciphertexts", async () => {
  const c = await cipher();
  const nonces = new Set<string>();
  const bodies = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const enc = Buffer.from(c.encryptContent(buf("same content"), 1, "obj"));
    nonces.add(enc.subarray(5, 17).toString("hex"));
    bodies.add(enc.subarray(17).toString("hex"));
  }
  assert.equal(nonces.size, 5000);
  assert.equal(bodies.size, 5000);
});

test("names differ per path, per password and per salt", async () => {
  const c = await cipher();
  const names = new Set<string>();
  for (let i = 0; i < 2000; i++) names.add(c.encryptName(`notes/${i}.md`));
  assert.equal(names.size, 2000);
  const prefixes = new Set([...names].map((n) => n.slice(0, 8)));
  assert.ok(prefixes.size > 1990); // a shared folder leaves no shared prefix

  const otherSalt = await Cipher.derive("pässword", Buffer.from("0000000000000000"), KDF);
  const otherPassword = await Cipher.derive("password", SALT, KDF);
  assert.notEqual(otherSalt.encryptName("a.md"), c.encryptName("a.md"));
  assert.notEqual(otherPassword.encryptName("a.md"), c.encryptName("a.md"));
  assert.equal(otherSalt.decryptName(c.encryptName("a.md")), null);
});

test("a password typed on macOS and on Linux derives the same key", async () => {
  const composed = await Cipher.derive("pässword", SALT, KDF); // ä as one code point
  const decomposed = await Cipher.derive("pässword", SALT, KDF); // a + combining diaeresis
  assert.equal(decomposed.decryptName(composed.encryptName("a.md")), "a.md");
});

test("weak, malformed or absurd key-derivation parameters are refused", async () => {
  assertSaneKdf(DEFAULT_KDF);
  assert.equal(DEFAULT_KDF.N, 2 ** 17);
  const bad: unknown[] = [
    { name: "scrypt", N: 1024, r: 8, p: 1 },
    { name: "scrypt", N: 16384, r: 8, p: 1 },
    { name: "scrypt", N: 100000, r: 8, p: 1 },
    { name: "scrypt", N: 2 ** 24, r: 8, p: 1 },
    { name: "scrypt", N: 32768, r: 1, p: 1 },
    { name: "scrypt", N: 32768, r: 8, p: 0 },
    { name: "scrypt", N: "32768", r: 8, p: 1 },
    { name: "pbkdf2", N: 32768, r: 8, p: 1 },
    null,
    {},
  ];
  for (const kdf of bad) assert.throws(() => assertSaneKdf(kdf), JSON.stringify(kdf));
  assert.throws(() => Cipher.derive("", SALT, KDF));
  assert.throws(() => Cipher.derive("pw", Buffer.from("short"), KDF));
});

// --- a hostile or broken bucket ------------------------------------------------

const utf8ab = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const dataKeys = (store: MemoryStore) => [...store.objects.keys()].filter((k) => k.startsWith(DATA_PREFIX));

test("a modified object is reported and never written to the vault", async () => {
  const { store, a, b } = pair();
  a.fs.set("note.md", "original");
  await a.sync();
  const key = dataKeys(store)[0];
  const obj = store.objects.get(key)!;
  const forged = Buffer.from(obj.data);
  forged[forged.length - 1] ^= 1;
  store.objects.set(key, { data: utf8ab(forged), etag: "forged" });

  const s = await b.sync();
  assert.equal(s.errors.length, 1);
  assert.equal(s.downloaded, 0);
  assert.deepEqual(b.fs.paths(), []);

  // The device that already has the file keeps its copy too.
  const sa = await a.sync();
  assert.equal(sa.errors.length, 1);
  assert.equal(a.fs.text("note.md"), "original");
});

test("objects swapped between two paths are rejected", async () => {
  const { store, a, b } = pair();
  a.fs.set("public.md", "harmless");
  a.fs.set("private.md", "sensitive");
  await a.sync();
  const [k1, k2] = dataKeys(store);
  const o1 = store.objects.get(k1)!;
  const o2 = store.objects.get(k2)!;
  store.objects.set(k1, o2);
  store.objects.set(k2, o1);

  const s = await b.sync();
  assert.equal(s.errors.length, 2);
  assert.deepEqual(b.fs.paths(), []);
});

test("planted objects with unreadable names are ignored", async () => {
  const { store, a, b } = pair();
  a.fs.set("note.md", "real");
  await a.sync();
  store.objects.set(DATA_PREFIX + "bm90LW91cnM", { data: buf("junk"), etag: "x" });
  store.objects.set(DATA_PREFIX + "../../etc/passwd", { data: buf("junk"), etag: "y" });
  const s = await b.sync();
  assert.equal(s.errors.length, 0);
  assert.deepEqual(b.fs.paths(), ["note.md"]);
});

test("a downgraded r2v2.json stops the sync before anything is sent", async () => {
  const { store, a } = pair();
  a.fs.set("note.md", "one");
  await a.sync();
  const meta = JSON.parse(str(store.objects.get(META_KEY)!.data)) as RemoteMeta;
  const weak = { ...meta, kdf: { ...meta.kdf, N: 2 } };
  store.objects.set(META_KEY, { data: utf8(JSON.stringify(weak)), etag: "weak" });

  const puts = store.puts;
  a.fs.set("second.md", "two");
  await assert.rejects(() => a.sync(), /鍵導出パラメータ/);
  assert.equal(store.puts, puts);
});

test("a replaced r2v2.json cannot make a device encrypt under someone else's key", async () => {
  const { store, a } = pair();
  a.fs.set("note.md", "one");
  await a.sync();

  // The attacker initialises a bucket of their own and transplants its metadata.
  const attackerStore = new MemoryStore();
  await new Device(attackerStore, "attacker password").sync();
  store.objects.set(META_KEY, attackerStore.objects.get(META_KEY)!);

  const puts = store.puts;
  a.fs.set("second.md", "two");
  await assert.rejects(() => a.sync(), WrongPasswordError);
  assert.equal(store.puts, puts);
  assert.deepEqual(a.fs.paths(), ["note.md", "second.md"]);
});

test("the bucket never holds a plaintext path, content or timestamp", async () => {
  const { store, a } = pair();
  const secrets = ["Projects", "salary-negotiation", "CONFIDENTIAL-BODY-TEXT", "転職"];
  a.fs.set("Projects/salary-negotiation.md", "CONFIDENTIAL-BODY-TEXT ".repeat(50));
  a.fs.set("転職/メモ.md", "CONFIDENTIAL-BODY-TEXT");
  await a.sync();
  const mtime = Buffer.alloc(8);
  mtime.writeBigUInt64BE(BigInt(a.fs.files.get("転職/メモ.md")!.mtime));

  for (const [key, obj] of store.objects) {
    const body = Buffer.from(obj.data);
    for (const secret of secrets) {
      assert.ok(!key.includes(secret), `${secret} in key`);
      assert.ok(!body.includes(Buffer.from(secret, "utf8")), `${secret} in body of ${key}`);
    }
    if (key !== META_KEY) assert.ok(!body.includes(mtime), "mtime in clear");
  }
  // The metadata file holds parameters only.
  const meta = JSON.parse(str(store.objects.get(META_KEY)!.data));
  assert.deepEqual(Object.keys(meta).sort(), ["check", "kdf", "salt", "version"]);
  assert.equal(Buffer.from(meta.salt, "base64").length, 16);
});
