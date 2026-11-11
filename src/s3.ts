// Client for R2's S3 API. It only ever sees ciphertext: encryption happens one
// layer up, in encrypted-remote.ts. The HTTP transport is passed in, so the
// plugin can use Obsidian's requestUrl (not subject to CORS) and tests can use
// fetch against a real S3-compatible server.
import { RawStore } from "./encrypted-remote";
import { parseErrorXml, parseListXml, stripEtag } from "./s3xml";
import { Credentials, canonicalQuery, encodeKeyPath, sha256Hex, signRequest } from "./sigv4";
import { PreconditionFailedError, RemoteEntry } from "./sync";

export interface R2Config {
  /** Account ID, or a full endpoint URL. */
  endpoint: string;
  bucket: string;
  /** Key prefix inside the bucket ("" for the bucket root). */
  prefix: string;
  credentials: Credentials;
  /** Signing region. R2 uses "auto"; other S3-compatible servers may differ. */
  region?: string;
  /** Objects per list request (the server default is 1000). */
  pageSize?: number;
}

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ArrayBuffer;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer;
}

/** Performs one request and resolves for any HTTP status. */
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export function resolveEndpoint(endpoint: string): string {
  const e = endpoint.trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(e)) return e;
  return `https://${e}.r2.cloudflarestorage.com`;
}

export function normalizePrefix(prefix: string): string {
  const p = prefix.trim().replace(/^\/+|\/+$/g, "");
  return p ? p + "/" : "";
}

const EMPTY_HASH = sha256Hex("");

const text = (res: HttpResponse) => Buffer.from(res.body).toString("utf8");

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === name) return headers[k];
  }
  return undefined;
}

export class R2Store implements RawStore {
  private readonly base: URL;
  private readonly prefix: string;

  constructor(
    private readonly config: R2Config,
    private readonly http: HttpClient,
  ) {
    this.base = new URL(resolveEndpoint(config.endpoint));
    this.prefix = normalizePrefix(config.prefix);
  }

  private async request(
    method: string,
    key: string | null,
    opts: {
      query?: Record<string, string>;
      body?: ArrayBuffer;
      unsigned?: Record<string, string>;
      allow404?: boolean;
    } = {},
  ) {
    const path =
      `/${encodeKeyPath(this.config.bucket)}` + (key === null ? "" : `/${encodeKeyPath(this.prefix + key)}`);
    const query = canonicalQuery(opts.query ?? {});
    const payloadHash = opts.body ? sha256Hex(new Uint8Array(opts.body)) : EMPTY_HASH;
    const headers = signRequest({
      method,
      host: this.base.host,
      path,
      query,
      payloadHash,
      credentials: this.config.credentials,
      region: this.config.region ?? "auto",
    });
    if (opts.body) headers["content-type"] = "application/octet-stream";
    const res = await this.http({
      url: `${this.base.origin}${path}${query ? "?" + query : ""}`,
      method,
      headers: { ...headers, ...opts.unsigned },
      body: opts.body,
    });
    if (res.status === 412 && key !== null) throw new PreconditionFailedError(key);
    if (res.status === 404 && opts.allow404) return null;
    if (res.status >= 300) {
      const detail = parseErrorXml(text(res));
      throw new Error(`R2 ${method} failed: HTTP ${res.status}${detail ? ` ${detail}` : ""}`);
    }
    return res;
  }

  async list(prefix: string): Promise<Map<string, RemoteEntry>> {
    const out = new Map<string, RemoteEntry>();
    const full = this.prefix + prefix;
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2" };
      if (full) query["prefix"] = full;
      if (this.config.pageSize) query["max-keys"] = String(this.config.pageSize);
      if (token) query["continuation-token"] = token;
      const res = await this.request("GET", null, { query });
      const page = parseListXml(text(res!));
      for (const o of page.objects) {
        if (!o.key.startsWith(full)) continue;
        out.set(o.key.slice(this.prefix.length), { etag: o.etag, size: o.size });
      }
      token = page.nextToken;
    } while (token);
    return out;
  }

  /** Cheap request used by the settings tab to check the connection. */
  async ping(): Promise<void> {
    await this.request("GET", null, { query: { "list-type": "2", "max-keys": "1" } });
  }

  async get(key: string) {
    const res = await this.request("GET", key, { allow404: true });
    if (!res) return null;
    return { data: res.body, etag: stripEtag(header(res.headers, "etag") ?? "") };
  }

  async put(
    key: string,
    data: ArrayBuffer,
    opts: { ifMatch?: string; ifNoneMatch?: boolean },
  ): Promise<string> {
    const unsigned: Record<string, string> = {};
    if (opts.ifMatch) unsigned["If-Match"] = `"${opts.ifMatch}"`;
    else if (opts.ifNoneMatch) unsigned["If-None-Match"] = "*";
    const res = await this.request("PUT", key, { body: data, unsigned });
    const etag = header(res!.headers, "etag");
    if (!etag) throw new Error("R2 PUT: response had no ETag");
    return stripEtag(etag);
  }

  async delete(key: string, opts: { ifMatch?: string } = {}): Promise<void> {
    if (opts.ifMatch) {
      // R2's DeleteObject takes no conditions, so look first. This narrows the
      // window in which another device's upload could be deleted from the whole
      // length of a sync pass to the gap between these two requests.
      const head = await this.request("HEAD", key, { allow404: true });
      if (!head) return; // already gone
      if (stripEtag(header(head.headers, "etag") ?? "") !== opts.ifMatch)
        throw new PreconditionFailedError(key);
    }
    await this.request("DELETE", key);
  }
}
