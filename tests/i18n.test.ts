import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { setLanguage, t } from "../src/i18n";

afterEach(() => setLanguage("en"));

test("English is the default and the fallback", () => {
  assert.equal(t("cmd_sync_now"), "Sync now");
  setLanguage("fr");
  assert.equal(t("cmd_sync_now"), "Sync now");
});

test("Japanese is used for ja, with or without a region", () => {
  setLanguage("ja");
  assert.equal(t("cmd_sync_now"), "今すぐ同期");
  setLanguage("ja-JP");
  assert.equal(t("cmd_sync_now"), "今すぐ同期");
});

test("placeholders are filled, and unknown ones are left visible", () => {
  assert.equal(t("status_progress", { done: 3, total: 10 }), "Syncing… 3/10");
  assert.equal(t("status_progress", { done: 3 }), "Syncing… 3/{total}");
  setLanguage("ja");
  assert.equal(t("large_body1", { changes: 5, deletions: 2, total: 40 }).includes("40 件のうち 5 件"), true);
});

test("both languages use the same placeholders for every text", async () => {
  const source = await import("node:fs").then((fs) => fs.readFileSync("src/i18n.ts", "utf8"));
  const block = (name: string) => {
    const start = source.indexOf(name);
    return source.slice(start, source.indexOf("\n};", start));
  };
  const placeholders = (text: string) => {
    const out = new Map<string, string>();
    // key: "..." possibly on the following line
    for (const m of text.matchAll(/^\s{2}(\w+):\s*\n?\s*"((?:[^"\\]|\\.)*)"/gm)) {
      out.set(
        m[1],
        [...m[2].matchAll(/\{(\w+)\}/g)]
          .map((p) => p[1])
          .sort()
          .join(","),
      );
    }
    return out;
  };
  const en = placeholders(block("const en = {"));
  const ja = placeholders(block("const ja: Record<TextKey, string> = {"));
  assert.ok(en.size > 80);
  assert.deepEqual([...ja.keys()].sort(), [...en.keys()].sort());
  for (const [key, vars] of en) assert.equal(ja.get(key), vars, key);
});
