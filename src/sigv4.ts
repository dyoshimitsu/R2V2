// AWS Signature Version 4 request signing, as used by the S3 API of R2.
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
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
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
