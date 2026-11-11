import { createHash } from "crypto";
import { Cipher } from "../src/cipher";
import { EncryptedRemote, RawStore } from "../src/encrypted-remote";
import {
  LocalEntry,
  LocalFs,
  PreconditionFailedError,
  PutOptions,
  Remote,
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

  async delete(key: string, opts: { ifMatch?: string } = {}): Promise<void> {
    const cur = this.objects.get(key);
    if (opts.ifMatch && cur && cur.etag !== opts.ifMatch) throw new PreconditionFailedError(key);
    this.objects.delete(key);
  }
}

/** In-memory vault. */
export class MemoryFs implements LocalFs {
  files = new Map<string, { data: ArrayBuffer; mtime: number }>();
  trashed: string[] = [];
  /** Set to make this vault behave like one on a case-insensitive file system. */
  foldsCase = false;

  async caseInsensitive(): Promise<boolean> {
    return this.foldsCase;
  }
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
    if (this.files.has(to)) throw new Error(`EEXIST ${to}`);
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

/** The bucket without the encryption layer: enough to exercise the sync engine quickly. */
export class PlainRemote implements Remote {
  private mtimes = new Map<string, number>();

  constructor(readonly store: MemoryStore) {}

  list() {
    return this.store.list("");
  }

  async get(key: string) {
    const obj = await this.store.get(key);
    if (!obj) throw new Error(`not found: ${key}`);
    return { ...obj, mtime: this.mtimes.get(key) };
  }

  async put(key: string, data: ArrayBuffer, opts: PutOptions): Promise<string> {
    const etag = await this.store.put(key, data, opts);
    if (opts.mtime) this.mtimes.set(key, opts.mtime);
    return etag;
  }

  delete(key: string, expectedEtag?: string) {
    return this.store.delete(key, { ifMatch: expectedEtag });
  }
}
