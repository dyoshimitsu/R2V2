// Pure helpers for talking to an S3-compatible API (no Obsidian imports, so
// they can be unit-tested under plain Node).
import { createHash, createHmac } from "crypto";

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Percent-encode everything except the RFC 3986 unreserved characters. */
export function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Encode an object key for use as a URL path, keeping "/" separators. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(encodeRfc3986).join("/");
}

/** Build a canonical (sorted, encoded) query string. */
export function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(params[k])}`)
    .join("&");
}

export interface SignInput {
  method: string;
  host: string;
  /** Already-encoded path, starting with "/". */
  path: string;
  /** Already-canonical query string (no leading "?"). */
  query: string;
  /** Extra headers to sign (e.g. x-amz-meta-*). */
  headers?: Record<string, string>;
  payloadHash: string;
  credentials: Credentials;
  region: string;
  service?: string;
  date?: Date;
}

/**
 * AWS Signature Version 4. Returns the headers to send (everything that was
 * signed except `host`, plus `authorization`).
 */
export function signRequest(input: SignInput): Record<string, string> {
  const service = input.service ?? "s3";
  const amzDate = (input.date ?? new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  }
  headers["x-amz-content-sha256"] = input.payloadHash;
  headers["x-amz-date"] = amzDate;

  const toSign: Record<string, string> = { ...headers, host: input.host };
  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names.map((n) => `${n}:${toSign[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
  let key = hmac("AWS4" + input.credentials.secretAccessKey, day);
  key = hmac(key, input.region);
  key = hmac(key, service);
  key = hmac(key, "aws4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    switch (e) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return String.fromCodePoint(code);
  });
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]) : undefined;
}

export function stripEtag(etag: string): string {
  return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
}

export interface ListedObject {
  key: string;
  etag: string;
  size: number;
}

export interface ListPage {
  objects: ListedObject[];
  nextToken?: string;
}

/** Parse a ListObjectsV2 response body. */
export function parseListXml(xml: string): ListPage {
  const objects: ListedObject[] = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const key = tag(m[1], "Key");
    if (key === undefined) continue;
    objects.push({
      key,
      etag: stripEtag(tag(m[1], "ETag") ?? ""),
      size: Number(tag(m[1], "Size") ?? 0),
    });
  }
  const truncated = tag(xml, "IsTruncated") === "true";
  return { objects, nextToken: truncated ? tag(xml, "NextContinuationToken") : undefined };
}

/** Extract `<Code>: <Message>` from an S3 error body, if present. */
export function parseErrorXml(xml: string): string {
  const code = tag(xml, "Code");
  const message = tag(xml, "Message");
  return [code, message].filter(Boolean).join(": ");
}

/**
 * Simple glob matcher for exclude patterns. `*` matches within a path
 * segment, `**` matches across segments. A pattern also matches everything
 * beneath a matching folder.
 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.trim().replace(/^\/+|\/+$/g, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}(/.*)?$`);
}
