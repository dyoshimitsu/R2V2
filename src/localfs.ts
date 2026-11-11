// The vault as the sync engine sees it.
import { App, normalizePath } from "obsidian";
import { t } from "./i18n";
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

  // Files the vault knows about go through the Vault API, which keeps
  // Obsidian's own cache in step. The config folder is invisible to it, so
  // only those files fall back to the adapter.

  read(path: string): Promise<ArrayBuffer> {
    const target = this.real(path);
    const file = this.app.vault.getFileByPath(target);
    return file ? this.app.vault.readBinary(file) : this.app.vault.adapter.readBinary(target);
  }

  async write(path: string, data: ArrayBuffer, mtime?: number): Promise<LocalEntry> {
    const { vault } = this.app;
    const target = normalizePath(this.real(path));
    const options = mtime ? { mtime } : undefined;
    const file = vault.getFileByPath(target);
    if (file) {
      await vault.modifyBinary(file, data, options);
    } else if (this.isHidden(target)) {
      await this.mkdirp(parentOf(target), (dir) => vault.adapter.mkdir(dir));
      await vault.adapter.writeBinary(target, data, options);
    } else {
      await this.mkdirp(parentOf(target), (dir) => vault.createFolder(dir));
      try {
        await vault.createBinary(target, data, options);
      } catch (e) {
        // On disk but not indexed yet (e.g. created a moment ago): overwrite in place.
        if (!(await vault.adapter.exists(target))) throw e;
        await vault.adapter.writeBinary(target, data, options);
      }
    }
    const st = await vault.adapter.stat(target);
    if (!st) throw new Error(t("err_write_unverified", { path }));
    return { mtime: st.mtime, size: st.size };
  }

  private isHidden(path: string): boolean {
    const config = this.app.vault.configDir;
    return path === config || path.startsWith(config + "/");
  }

  private async mkdirp(dir: string, mkdir: (dir: string) => Promise<unknown>): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!dir || (await adapter.exists(dir))) return;
    await this.mkdirp(parentOf(dir), mkdir);
    try {
      await mkdir(dir);
    } catch (e) {
      if (!(await adapter.exists(dir))) throw e; // lost a race with a parallel write: fine
    }
  }

  async trash(path: string): Promise<void> {
    const target = this.real(path);
    const file = this.app.vault.getFileByPath(target);
    if (file) {
      // Honors the user's "Deleted files" preference.
      await this.app.fileManager.trashFile(file);
      return;
    }
    const adapter = this.app.vault.adapter;
    if (!(await adapter.trashSystem(target))) await adapter.trashLocal(target);
  }

  async rename(from: string, to: string): Promise<void> {
    const target = this.real(from);
    const file = this.app.vault.getFileByPath(target);
    // Vault.rename, not FileManager.renameFile: links must keep pointing at the original path.
    if (file) await this.app.vault.rename(file, normalizePath(to));
    else await this.app.vault.adapter.rename(target, normalizePath(to));
  }
}

const parentOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf("/")));
