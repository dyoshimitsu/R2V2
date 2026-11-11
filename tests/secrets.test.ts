import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretStore, migrateSecrets } from "../src/secrets";

const memoryStore = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  const store: SecretStore = {
    getSecret: (id) => values.get(id) ?? null,
    setSecret: (id, secret) => void values.set(id, secret),
  };
  return { store, values };
};

test("plaintext secrets move out of data.json", () => {
  const { store, values } = memoryStore();
  const data: Record<string, unknown> = { bucket: "b", secretAccessKey: "s3cr3t", password: "hunter2 " };
  assert.equal(migrateSecrets(data, store), true);
  assert.deepEqual(data, {
    bucket: "b",
    secretAccessKeySecret: "r2v2-secret-access-key",
    passwordSecret: "r2v2-encryption-password",
  });
  assert.equal(values.get("r2v2-secret-access-key"), "s3cr3t");
  assert.equal(values.get("r2v2-encryption-password"), "hunter2 ");
  assert.ok(!JSON.stringify(data).includes("s3cr3t") && !JSON.stringify(data).includes("hunter2"));
});

test("settings that are already migrated are left alone", () => {
  const { store, values } = memoryStore({ mine: "x" });
  const data: Record<string, unknown> = { passwordSecret: "mine", secretAccessKeySecret: "" };
  assert.equal(migrateSecrets(data, store), false);
  assert.deepEqual(data, { passwordSecret: "mine", secretAccessKeySecret: "" });
  assert.equal(values.size, 1);
});

test("empty legacy fields are dropped without creating secrets", () => {
  const { store, values } = memoryStore();
  const data: Record<string, unknown> = { secretAccessKey: "", password: "" };
  assert.equal(migrateSecrets(data, store), true);
  assert.deepEqual(data, {});
  assert.equal(values.size, 0);
});

test("a name already used for a different secret is not overwritten", () => {
  const { store, values } = memoryStore({ "r2v2-encryption-password": "someone else's" });
  const data: Record<string, unknown> = { password: "mine" };
  migrateSecrets(data, store);
  assert.equal(data.passwordSecret, "r2v2-encryption-password-2");
  assert.equal(values.get("r2v2-encryption-password"), "someone else's");
  assert.equal(values.get("r2v2-encryption-password-2"), "mine");
});

test("a name already holding the same value is reused", () => {
  const { store, values } = memoryStore({ "r2v2-encryption-password": "mine" });
  const data: Record<string, unknown> = { password: "mine" };
  migrateSecrets(data, store);
  assert.equal(data.passwordSecret, "r2v2-encryption-password");
  assert.equal(values.size, 1);
});

test("an explicit choice wins over a leftover plaintext value", () => {
  const { store, values } = memoryStore({ chosen: "new" });
  const data: Record<string, unknown> = { password: "old", passwordSecret: "chosen" };
  assert.equal(migrateSecrets(data, store), true);
  assert.deepEqual(data, { passwordSecret: "chosen" });
  assert.equal(values.size, 1);
});
