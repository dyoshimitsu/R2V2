// The remote as the sync engine sees it: plain paths and contents in, while
// the bucket underneath only ever holds ciphertext.
import { randomBytes } from "crypto";
import { utf8 } from "./bytes";
import { t } from "./i18n";
import { Cipher, DEFAULT_KDF, KdfParams, assertSaneKdf } from "./cipher";
import { PreconditionFailedError, PutOptions, Remote, RemoteEntry } from "./sync";

const CHECK_TEXT = "r2v2-password-check";

export const META_KEY = "r2v2.json";
export const DATA_PREFIX = "data/";

/** Stored unencrypted next to the data; holds nothing secret. */
export interface RemoteMeta {
  version: 1;
  kdf: KdfParams;
  /** base64 */
  salt: string;
  /** An encrypted constant, used to tell a wrong password from a right one. */
  check: string;
}

export class WrongPasswordError extends Error {
  constructor() {
    super(t("err_wrong_password"));
    this.name = "WrongPasswordError";
  }
}

/** Plain object storage, with keys relative to the configured prefix. */
export interface RawStore {
  list(prefix: string): Promise<Map<string, RemoteEntry>>;
  /** Resolves to null when the object does not exist. */
  get(key: string): Promise<{ data: ArrayBuffer; etag: string } | null>;
  put(key: string, data: ArrayBuffer, opts: { ifMatch?: string; ifNoneMatch?: boolean }): Promise<string>;
  /** With `ifMatch`, deletes only if the object still has that ETag (else PreconditionFailedError). */
  delete(key: string, opts?: { ifMatch?: string }): Promise<void>;
}

/** Read the remote's key-derivation parameters; null if it was never initialised. */
export async function readMeta(store: RawStore): Promise<RemoteMeta | null> {
  const existing = await store.get(META_KEY);
  if (!existing) return null;
  let meta: RemoteMeta;
  try {
    meta = JSON.parse(Buffer.from(existing.data).toString("utf8")) as RemoteMeta;
  } catch {
    throw new Error(t("err_meta_unreadable", { file: META_KEY }));
  }
  if (meta?.version !== 1 || typeof meta.salt !== "string" || typeof meta.check !== "string") {
    throw new Error(t("err_meta_format", { file: META_KEY }));
  }
  assertSaneKdf(meta.kdf);
  return meta;
}

/**
 * A decrypted name is about to become a path in the vault. Only someone with
 * the key could have produced it, but a path that climbs out of the vault or
 * that Obsidian would rewrite is still never something to act on.
 */
export function isSafePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** A Remote whose contents, paths and mtimes are encrypted before they leave. */
export class EncryptedRemote implements Remote {
  /** Objects under data/ that this password could not decrypt, as of the last list(). */
  foreign = 0;

  private constructor(
    private readonly store: RawStore,
    private readonly cipher: Cipher,
    /** Changes whenever the remote is re-initialised. */
    readonly id: string,
  ) {}

  /**
   * `cache` lets the caller keep the derived key between syncs: scrypt is
   * deliberately slow, and the result only depends on password and salt.
   */
  static async open(
    store: RawStore,
    password: string,
    cache?: { key: string; cipher: Cipher } | null,
  ): Promise<{ remote: EncryptedRemote; cache: { key: string; cipher: Cipher } }> {
    if (!password) throw new Error(t("err_no_password"));

    const derive = async (salt: string, kdf: KdfParams) => {
      const key = JSON.stringify([password, salt, kdf]);
      const cipher =
        cache?.key === key ? cache.cipher : await Cipher.derive(password, Buffer.from(salt, "base64"), kdf);
      return { key, cipher };
    };

    let meta = await readMeta(store);
    if (!meta) {
      // First device: pick the salt every later device will derive its keys from.
      const salt = randomBytes(16).toString("base64");
      const derived = await derive(salt, DEFAULT_KDF);
      const fresh: RemoteMeta = {
        version: 1,
        kdf: DEFAULT_KDF,
        salt,
        check: derived.cipher.encryptName(CHECK_TEXT),
      };
      try {
        await store.put(META_KEY, utf8(JSON.stringify(fresh, null, 2)), { ifNoneMatch: true });
        return { remote: new EncryptedRemote(store, derived.cipher, salt), cache: derived };
      } catch (e) {
        if (!(e instanceof PreconditionFailedError)) throw e;
        // Another device initialised the remote in the meantime; use what it wrote.
        meta = await readMeta(store);
        if (!meta) throw e;
      }
    }

    const derived = await derive(meta.salt, meta.kdf);
    if (derived.cipher.decryptName(meta.check) !== CHECK_TEXT) throw new WrongPasswordError();
    return { remote: new EncryptedRemote(store, derived.cipher, meta.salt), cache: derived };
  }

  private objectKey(path: string): string {
    return DATA_PREFIX + this.cipher.encryptName(path);
  }

  async list(): Promise<Map<string, RemoteEntry>> {
    const raw = await this.store.list(DATA_PREFIX);
    const out = new Map<string, RemoteEntry>();
    let foreign = 0;
    for (const [key, entry] of raw) {
      const path = this.cipher.decryptName(key.slice(DATA_PREFIX.length));
      if (path === null || !isSafePath(path)) foreign++;
      else out.set(path, entry);
    }
    this.foreign = foreign;
    return out;
  }

  async get(path: string) {
    const key = this.objectKey(path);
    const obj = await this.store.get(key);
    if (!obj) throw new Error(t("err_remote_missing", { path }));
    const plain = this.cipher.decryptContent(obj.data, key);
    return { data: plain.data, etag: obj.etag, mtime: plain.mtime || undefined };
  }

  async put(path: string, data: ArrayBuffer, opts: PutOptions): Promise<string> {
    const key = this.objectKey(path);
    try {
      return await this.store.put(key, this.cipher.encryptContent(data, opts.mtime ?? 0, key), {
        ifMatch: opts.ifMatch,
        ifNoneMatch: opts.ifNoneMatch,
      });
    } catch (e) {
      if (e instanceof PreconditionFailedError) throw new PreconditionFailedError(path);
      throw e;
    }
  }

  async delete(path: string, expectedEtag?: string): Promise<void> {
    try {
      await this.store.delete(this.objectKey(path), { ifMatch: expectedEtag });
    } catch (e) {
      if (e instanceof PreconditionFailedError) throw new PreconditionFailedError(path);
      throw e;
    }
  }
}
