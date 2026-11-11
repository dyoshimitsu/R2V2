// The R2 secret key and the encryption password live in Obsidian's secret
// storage. The plugin's data.json only holds the names they are stored under.

/** The part of Obsidian's SecretStorage this plugin uses. */
export interface SecretStore {
  getSecret(id: string): string | null;
  setSecret(id: string, secret: string): void;
}

/** Legacy plaintext field in data.json -> the field holding the secret's name, and its default name. */
const LEGACY = [
  { plain: "secretAccessKey", ref: "secretAccessKeySecret", id: "r2v2-secret-access-key" },
  { plain: "password", ref: "passwordSecret", id: "r2v2-encryption-password" },
] as const;

/**
 * Move secrets that an earlier version wrote into data.json over to the
 * secret storage. Returns true if `data` changed and must be saved, so the
 * plaintext copies disappear from disk.
 */
export function migrateSecrets(data: Record<string, unknown>, store: SecretStore): boolean {
  let changed = false;
  for (const { plain, ref, id } of LEGACY) {
    if (!(plain in data)) continue;
    const value = data[plain];
    if (typeof value === "string" && value !== "" && !data[ref]) {
      data[ref] = storeUnder(store, id, value);
    }
    delete data[plain];
    changed = true;
  }
  return changed;
}

/** Store `value`, without overwriting a different secret that already uses the name. */
function storeUnder(store: SecretStore, base: string, value: string): string {
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    const existing = store.getSecret(id);
    if (existing === value) return id;
    if (existing === null) {
      store.setSecret(id, value);
      return id;
    }
  }
}
