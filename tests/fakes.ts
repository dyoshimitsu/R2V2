import { createHash } from "crypto";
import { Cipher } from "../src/cipher";
import { EncryptedRemote, RawStore } from "../src/encrypted-remote";
import {
  LocalEntry,
  LocalFs,
  PreconditionFailedError,
  RemoteEntry,
  SyncOptions,
  SyncState,
  runSync,
} from "../src/sync";

export const buf = (s: string): ArrayBuffer => {
  const b = Buffer.from(s, "utf8");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
export const str = (b: ArrayBuffer): string => Buffer.from(b).toString("utf8");

/** In-memory bucket with S3-like ETags and conditional writes. */
export class MemoryStore implements RawStore {
  objects = new Map<string, { data: ArrayBuffer; etag: string }>();
  puts = 0;
  gets = 0;

  async list(prefix: string): Promise<Map<string, RemoteEntry>> {
    const out = new Map<string, RemoteEntry>();
    for (const [k, v] of this.objects) {
      if (k.startsWith(prefix)) out.set(k, { etag: v.etag, size: v.data.byteLength });
    }
    return out;
  }

  async get(key: string) {
    this.gets++;
    return this.objects.get(key) ?? null;
  }

  async put(
    key: string,
    data: ArrayBuffer,
    opts: { ifMatch?: string; ifNoneMatch?: boolean },
  ): Promise<string> {
    const cur = this.objects.get(key);
    if (opts.ifMatch && cur?.etag !== opts.ifMatch) throw new PreconditionFailedError(key);
    if (!opts.ifMatch && opts.ifNoneMatch && cur) throw new PreconditionFailedError(key);
    const etag = createHash("md5").update(new Uint8Array(data)).digest("hex");
    this.objects.set(key, { data, etag });
    this.puts++;
    return etag;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

/** In-memory vault. */
export class MemoryFs implements LocalFs {
  files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  trashed: string[] = [];
  private clock = 1_700_000_000_000;

  set(path: string, content: string): void {
    this.clock += 1000;
    this.files.set(path, { data: buf(content), mtime: this.clock });
  }

  text(path: string): string | undefined {
    const f = this.files.get(path);
    return f ? str(f.data) : undefined;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  async list(): Promise<Map<string, LocalEntry>> {
    const out = new Map<string, LocalEntry>();
    for (const [k, v] of this.files) out.set(k, { mtime: v.mtime, size: v.data.byteLength });
    return out;
  }

  async stat(path: string): Promise<LocalEntry | null> {
    const f = this.files.get(path);
    return f ? { mtime: f.mtime, size: f.data.byteLength } : null;
  }

  async read(path: string): Promise<ArrayBuffer> {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT ${path}`);
    return f.data;
  }

  async write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalEntry> {
    this.clock += 1000;
    const m = mtime ?? this.clock;
    this.files.set(path, { data, mtime: m });
    return { mtime: m, size: data.byteLength };
  }

  async trash(path: string): Promise<void> {
    this.files.delete(path);
    this.trashed.push(path);
  }

  async rename(from: string, to: string): Promise<void> {
    const f = this.files.get(from);
    if (!f) throw new Error(`ENOENT ${from}`);
    this.files.delete(from);
    this.files.set(to, f);
  }
}

/** One machine: its own vault and sync record, sharing a bucket with others. */
export class Device {
  fs = new MemoryFs();
  state: SyncState = { remoteId: "test", files: {} };
  private cache: { key: string; cipher: Cipher } | null = null;

  constructor(
    readonly store: MemoryStore,
    private readonly password = "correct horse",
  ) {}

  async sync(opts: SyncOptions = {}) {
    const opened = await EncryptedRemote.open(this.store, this.password, this.cache);
    this.cache = opened.cache;
    return runSync(this.fs, opened.remote, this.state, opts);
  }
}

export const pair = () => {
  const store = new MemoryStore();
  return { store, a: new Device(store), b: new Device(store) };
};
