import assert from "node:assert/strict";
import { test } from "node:test";
import { Cipher, KdfParams } from "../src/cipher";
import { buf, str } from "./fakes";

const FAST: KdfParams = { name: "scrypt", N: 32768, r: 8, p: 1 };
const SALT = Buffer.from("0123456789abcdef");

test("content round-trips and is bound to its object name", async () => {
  const c = await Cipher.derive("pw", SALT, FAST);
  const enc = c.encryptContent(buf("hello"), 1234567890123, "name-1");
  assert.ok(!Buffer.from(enc).includes(Buffer.from("hello")));
  const dec = c.decryptContent(enc, "name-1");
  assert.equal(str(dec.data), "hello");
  assert.equal(dec.mtime, 1234567890123);
  assert.throws(() => c.decryptContent(enc, "name-2")); // moved to another key
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 20] ^= 1;
  assert.throws(() => c.decryptContent(tampered.buffer.slice(0) as ArrayBuffer, "name-1"));
  assert.equal(str(c.decryptContent(c.encryptContent(buf(""), 5, "n"), "n").data), "");
});

test("names are deterministic, opaque and unreadable with another key", async () => {
  const c = await Cipher.derive("pw", SALT, FAST);
  const other = await Cipher.derive("pw2", SALT, FAST);
  const path = "日記/2026-11-11 メモ.md";
  const enc = c.encryptName(path);
  assert.equal(enc, c.encryptName(path));
  assert.match(enc, /^[A-Za-z0-9_-]+$/);
  assert.equal(c.decryptName(enc), path);
  assert.equal(other.decryptName(enc), null);
  assert.equal(c.decryptName("not-ours"), null);
});
