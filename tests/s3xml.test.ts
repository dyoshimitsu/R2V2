import assert from "node:assert/strict";
import { test } from "node:test";
import { parseErrorXml, parseListXml } from "../src/s3xml";

test("ListObjectsV2 XML is parsed, including entities and pagination", () => {
  const xml =
    `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>` +
    `<Contents><Key>data/a&amp;b</Key><ETag>&quot;abc&quot;</ETag><Size>12</Size></Contents>` +
    `<Contents><Key>data/c</Key><ETag>"def"</ETag><Size>0</Size></Contents>` +
    `<NextContinuationToken>tok==</NextContinuationToken></ListBucketResult>`;
  assert.deepEqual(parseListXml(xml), {
    objects: [
      { key: "data/a&b", etag: "abc", size: 12 },
      { key: "data/c", etag: "def", size: 0 },
    ],
    nextToken: "tok==",
  });
});

test("error bodies are summarised", () => {
  assert.equal(
    parseErrorXml("<Error><Code>NoSuchBucket</Code><Message>The bucket does not exist</Message></Error>"),
    "NoSuchBucket: The bucket does not exist",
  );
  assert.equal(parseErrorXml("not xml"), "");
});
