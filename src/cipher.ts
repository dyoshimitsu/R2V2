// The encryption format. Everything that reaches the bucket — file contents,
// file paths and modification times — is transformed here first.
//
//   key derivation : scrypt(password, salt) -> content key | name key | name MAC key
//   content        : "R2V2" 0x01 | nonce(12) | AES-256-GCM(mtime(8) | data) | tag(16)
//                    with the encrypted object name as associated data
//   names          : base64url( siv(12) | AES-256-GCM(path) | tag(16) ),
//                    siv = HMAC-SHA256(name MAC key, path)[0..12]  (deterministic)
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from "crypto";
import { toArrayBuffer } from "./bytes";

const MAGIC = Buffer.from([0x52, 0x32, 0x56, 0x32, 0x01]); // "R2V2" + format version
const NONCE_LEN = 12;
const TAG_LEN = 16;

export interface KdfParams {
  name: "scrypt";
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_KDF: KdfParams = { name: "scrypt", N: 32768, r: 8, p: 1 };

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
    return toArrayBuffer(out);
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
      plain = Buffer.concat([
        d.update(raw.subarray(MAGIC.length + NONCE_LEN, raw.length - TAG_LEN)),
        d.final(),
      ]);
    } catch {
      throw new Error("復号に失敗しました(データが壊れているか、改ざんされています)");
    }
    return { mtime: Number(plain.readBigUInt64BE(0)), data: toArrayBuffer(plain.subarray(8)) };
  }
}
