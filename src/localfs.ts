// The vault as the sync engine sees it.
import { App, TFile, normalizePath } from "obsidian";
import { LocalEntry, LocalFs } from "./sync";

export interface LocalFsOptions {
  /** Also sync the config folder (.obsidian). */
  syncConfigDir: boolean;
  /** Paths that never leave this device (this plugin's own folder, etc). */
  alwaysSkip: (path: string) => boolean;
}

export class VaultFs implements LocalFs {
  /** NFC path -> the path as it is actually spelled on this disk. */
  private actual = new Map<string, string>();

  constructor(
    private readonly app: App,
    private readonly opts: LocalFsOptions,
  ) {}

  private real(path: string): string {
    return this.actual.get(path) ?? path;
  }

  async list(): Promise<Map<string, LocalEntry>> {
    const out = new Map<string, LocalEntry>();
    this.actual.clear();
    const add = (path: string, entry: LocalEntry) => {
      if (this.opts.alwaysSkip(path)) return;
      // macOS and Linux may spell the same name with different Unicode
      // normalization; NFC is the form shared between devices.
      const key = path.normalize("NFC");
      if (key !== path) this.actual.set(key, path);
      out.set(key, entry);
    };

    for (const f of this.app.vault.getFiles()) {
      add(f.path, { mtime: f.stat.mtime, size: f.stat.size });
    }

    if (this.opts.syncConfigDir) {
      // The config folder is hidden from the vault index, so walk it directly.
      const adapter = this.app.vault.adapter;
      const walk = async (dir: string): Promise<void> => {
        const listed = await adapter.list(dir);
        for (const file of listed.files) {
          const st = await adapter.stat(file);
          if (st?.type === "file") add(file, { mtime: st.mtime, size: st.size });
        }
        for (const folder of listed.folders) {
          if (!this.opts.alwaysSkip(folder)) await walk(folder);
        }
      };
      if (await adapter.exists(this.app.vault.configDir)) await walk(this.app.vault.configDir);
    }
    return out;
  }

  async stat(path: string): Promise<LocalEntry | null> {
    const st = await this.app.vault.adapter.stat(this.real(path));
    return st?.type === "file" ? { mtime: st.mtime, size: st.size } : null;
  }

  read(path: string): Promise<ArrayBuffer> {
    return this.app.vault.adapter.readBinary(this.real(path));
  }

  async write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalEntry> {
    const adapter = this.app.vault.adapter;
    const target = normalizePath(this.real(path));
    const slash = target.lastIndexOf("/");
    if (slash > 0) await this.mkdirp(target.slice(0, slash));
    await adapter.writeBinary(target, data, mtime ? { mtime } : undefined);
    const st = await adapter.stat(target);
    if (!st) throw new Error(`書き込み後に確認できません: ${path}`);
    return { mtime: st.mtime, size: st.size };
  }

  private async mkdirp(dir: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(dir)) return;
    const slash = dir.lastIndexOf("/");
    if (slash > 0) await this.mkdirp(dir.slice(0, slash));
    try {
      await adapter.mkdir(dir);
    } catch (e) {
      if (!(await adapter.exists(dir))) throw e; // lost a race with a parallel write: fine
    }
  }

  async trash(path: string): Promise<void> {
    const target = this.real(path);
    const file = this.app.vault.getAbstractFileByPath(target);
    if (file instanceof TFile) {
      // Honors the user's "Deleted files" preference.
      await this.app.fileManager.trashFile(file);
      return;
    }
    const adapter = this.app.vault.adapter;
    if (!(await adapter.trashSystem(target))) await adapter.trashLocal(target);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.app.vault.adapter.rename(this.real(from), to);
  }
}
