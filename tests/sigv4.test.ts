import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalQuery, encodeKeyPath, signRequest } from "../src/sigv4";

test("SigV4 matches the AWS documentation example (GET object)", () => {
  const headers = signRequest({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    query: "",
    headers: { Range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    credentials: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    },
    region: "us-east-1",
    date: new Date(Date.UTC(2013, 4, 24, 0, 0, 0)),
  });
  assert.match(
    headers["authorization"],
    /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/,
  );
  assert.match(headers["authorization"], /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,/);
});

test("keys and queries are encoded the way S3 canonicalises them", () => {
  assert.equal(
    encodeKeyPath("a b/日本語/(x)!*'.md"),
    "a%20b/%E6%97%A5%E6%9C%AC%E8%AA%9E/%28x%29%21%2A%27.md",
  );
  assert.equal(
    canonicalQuery({ prefix: "v/data/", "list-type": "2", "continuation-token": "a+b=" }),
    "continuation-token=a%2Bb%3D&list-type=2&prefix=v%2Fdata%2F",
  );
});
