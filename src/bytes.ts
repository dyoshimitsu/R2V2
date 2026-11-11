// Buffer <-> ArrayBuffer conversions. A Node Buffer may be a view into a
// larger pooled allocation, so its bytes have to be copied out.

import { createHash } from "crypto";

export function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

export function utf8(text: string): ArrayBuffer {
  return toArrayBuffer(Buffer.from(text, "utf8"));
}

export function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  return a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
}

/** SHA-256 of file content, as recorded in the sync state. */
export function contentHash(data: ArrayBuffer): string {
  return createHash("sha256").update(new Uint8Array(data)).digest("hex");
}
