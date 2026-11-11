// End-to-end encryption layer. Everything that reaches the bucket — file
// contents, file paths and modification times — goes through here first.
//
//   key derivation : scrypt(password, salt) -> content key | name key | name MAC key
//   content        : "R2V2" 0x01 | nonce(12) | AES-256-GCM(mtime(8) | data) | tag(16)
//                    with the encrypted object name as associated data
//   names          : base64url( siv(12) | AES-256-GCM(path) | tag(16) ),
//                    siv = HMAC-SHA256(name MAC key, path)[0..12]  (deterministic)
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { PreconditionFailedError, PutOptions, Remote, RemoteEntry } from "./sync";

const MAGIC = Buffer.from([0x52, 0x32, 0x56, 0x32, 0x01]); // "R2V2" + format version
const NONCE_LEN = 12;
const TAG_LEN = 16;
const CHECK_TEXT = "r2v2-password-check";

export const META_KEY = "r2v2.json";
export const DATA_PREFIX = "data/";

export interface KdfParams {
  name: "scrypt";
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_KDF: KdfParams = { name: "scrypt", N: 32768, r: 8, p: 1 };

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
    super("パスワードが違います(リモートは別のパスワードで暗号化されています)");
    this.name = "WrongPasswordError";
  }
}

export class Cipher {
  private constructor(
    private readonly contentKey: Buffer,
    private readonly nameKey: Buffer,
    private readonly nameMacKey: Buffer,
  ) {}

  static derive(password: string, salt: Buffer, kdf: KdfParams = DEFAULT_KDF): Promise<Cipher> {
    return new Promise((resolve, reject) => {
      scrypt(
        password.normalize("NFKC"),
        salt,
        96,
        { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r },
        (err, key) => {
          if (err) return reject(err);
          resolve(new Cipher(key.subarray(0, 32), key.subarray(32, 64), key.subarray(64, 96)));
        },
      );
    });
  }

  encryptName(path: string): string {
    const plain = Buffer.from(path, "utf8");
    const siv = createHmac("sha256", this.nameMacKey).update(plain).digest().subarray(0, NONCE_LEN);
    const c = createCipheriv("aes-256-gcm", this.nameKey, siv);
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([siv, body, c.getAuthTag()]).toString("base64url");
  }

  /** Returns null for anything this key did not produce. */
  decryptName(name: string): string | null {
    try {
      const raw = Buffer.from(name, "base64url");
      if (raw.length < NONCE_LEN + TAG_LEN) return null;
      const d = createDecipheriv("aes-256-gcm", this.nameKey, raw.subarray(0, NONCE_LEN));
      d.setAuthTag(raw.subarray(raw.length - TAG_LEN));
      const plain = Buffer.concat([d.update(raw.subarray(NONCE_LEN, raw.length - TAG_LEN)), d.final()]);
      const siv = createHmac("sha256", this.nameMacKey).update(plain).digest().subarray(0, NONCE_LEN);
      if (!timingSafeEqual(siv, raw.subarray(0, NONCE_LEN))) return null;
      return plain.toString("utf8");
    } catch {
      return null;
    }
  }

  encryptContent(data: ArrayBuffer, mtime: number, aad: string): ArrayBuffer {
    const nonce = randomBytes(NONCE_LEN);
    const c = createCipheriv("aes-256-gcm", this.contentKey, nonce);
    c.setAAD(Buffer.from(aad, "utf8"));
    const head = Buffer.alloc(8);
    head.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(mtime))));
    const out = Buffer.concat([
      MAGIC,
      nonce,
      c.update(head),
      c.update(new Uint8Array(data)),
      c.final(),
      c.getAuthTag(),
    ]);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  }

  decryptContent(data: ArrayBuffer, aad: string): { data: ArrayBuffer; mtime: number } {
    const raw = Buffer.from(data);
    const min = MAGIC.length + NONCE_LEN + 8 + TAG_LEN;
    if (raw.length < min || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error("R2V2 形式の暗号化データではありません");
    }
    const nonce = raw.subarray(MAGIC.length, MAGIC.length + NONCE_LEN);
    const d = createDecipheriv("aes-256-gcm", this.contentKey, nonce);
    d.setAAD(Buffer.from(aad, "utf8"));
    d.setAuthTag(raw.subarray(raw.length - TAG_LEN));
    let plain: Buffer;
    try {
      plain = Buffer.concat([d.update(raw.subarray(MAGIC.length + NONCE_LEN, raw.length - TAG_LEN)), d.final()]);
    } catch {
      throw new Error("復号に失敗しました(データが壊れているか、改ざんされています)");
    }
    const body = plain.subarray(8);
    return {
      mtime: Number(plain.readBigUInt64BE(0)),
      data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    };
  }
}

/** Plain object storage, with keys relative to the configured prefix. */
export interface RawStore {
  list(prefix: string): Promise<Map<string, RemoteEntry>>;
  /** Resolves to null when the object does not exist. */
  get(key: string): Promise<{ data: ArrayBuffer; etag: string } | null>;
  put(key: string, data: ArrayBuffer, opts: { ifMatch?: string; ifNoneMatch?: boolean }): Promise<string>;
  delete(key: string): Promise<void>;
}

const toArrayBuffer = (s: string): ArrayBuffer => {
  const b = Buffer.from(s, "utf8");
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

/**
 * Read the remote's key-derivation parameters, creating them on first use.
 * The salt is shared by every device, so they all derive the same keys from
 * the same password.
 */
export async function loadOrCreateMeta(store: RawStore): Promise<RemoteMeta & { created: boolean }> {
  const existing = await store.get(META_KEY);
  if (!existing) {
    return { version: 1, kdf: DEFAULT_KDF, salt: randomBytes(16).toString("base64"), check: "", created: true };
  }
  const meta = JSON.parse(Buffer.from(existing.data).toString("utf8")) as RemoteMeta;
  if (meta.version !== 1 || meta.kdf?.name !== "scrypt" || !meta.salt || !meta.check) {
    throw new Error(`${META_KEY} の形式を解釈できません(より新しい版で作られた可能性があります)`);
  }
  return { ...meta, created: false };
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
    if (!password) throw new Error("暗号化パスワードが設定されていません");

    for (let attempt = 0; ; attempt++) {
      const meta = await loadOrCreateMeta(store);
      const cacheKey = JSON.stringify([password, meta.salt, meta.kdf]);
      const cipher =
        cache?.key === cacheKey
          ? cache.cipher
          : await Cipher.derive(password, Buffer.from(meta.salt, "base64"), meta.kdf);

      if (meta.created) {
        const body: RemoteMeta = {
          version: 1,
          kdf: meta.kdf,
          salt: meta.salt,
          check: cipher.encryptName(CHECK_TEXT),
        };
        try {
          await store.put(META_KEY, toArrayBuffer(JSON.stringify(body, null, 2)), { ifNoneMatch: true });
        } catch (e) {
          // Another device initialised the remote first; use what it wrote.
          if (e instanceof PreconditionFailedError && attempt === 0) continue;
          throw e;
        }
      } else if (cipher.decryptName(meta.check) !== CHECK_TEXT) {
        throw new WrongPasswordError();
      }
      return { remote: new EncryptedRemote(store, cipher, meta.salt), cache: { key: cacheKey, cipher } };
    }
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
      if (path === null) foreign++;
      else out.set(path, entry);
    }
    this.foreign = foreign;
    return out;
  }

  async get(path: string) {
    const key = this.objectKey(path);
    const obj = await this.store.get(key);
    if (!obj) throw new Error(`リモートにありません: ${path}`);
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

  async delete(path: string): Promise<void> {
    await this.store.delete(this.objectKey(path));
  }
}
