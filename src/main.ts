import { Notice, Plugin, debounce } from "obsidian";
import { Cipher, EncryptedRemote, META_KEY } from "./crypto";
import { VaultFs } from "./localfs";
import { R2Store, normalizePrefix, resolveEndpoint } from "./s3";
import { globToRegExp } from "./s3core";
import { ConfirmModal, DEFAULT_SETTINGS, R2V2SettingTab, R2V2Settings, missingSettings } from "./settings";
import { SyncState, SyncSummary, runSync } from "./sync";

const STATE_FILE = "sync-state.json";

export default class R2V2Plugin extends Plugin {
  settings: R2V2Settings = DEFAULT_SETTINGS;

  private syncing = false;
  private quietUntil = 0;
  private statusEl: HTMLElement | null = null;
  private intervalId: number | null = null;
  private keyCache: { key: string; cipher: Cipher } | null = null;
  private scheduleSaveSync: ReturnType<typeof debounce> | null = null;

  async onload(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.statusEl = this.addStatusBarItem();
    this.setStatus("待機中");

    this.addRibbonIcon("refresh-cw", "R2V2: 今すぐ同期", () => void this.sync(true));
    this.addCommand({ id: "sync-now", name: "今すぐ同期", callback: () => void this.sync(true) });
    this.addSettingTab(new R2V2SettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      // Registered only now, so the vault's initial load does not count as edits.
      const onChange = () => {
        if (this.syncing || Date.now() < this.quietUntil) return; // our own writes
        this.scheduleSaveSync?.();
      };
      this.registerEvent(this.app.vault.on("modify", onChange));
      this.registerEvent(this.app.vault.on("create", onChange));
      this.registerEvent(this.app.vault.on("delete", onChange));
      this.registerEvent(this.app.vault.on("rename", onChange));

      this.applyTimers();
      if (this.settings.syncOnStartup && missingSettings(this.settings).length === 0) {
        window.setTimeout(() => void this.sync(false), 3000);
      }
    });
  }

  onunload(): void {
    this.scheduleSaveSync?.cancel();
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.applyTimers();
  }

  private applyTimers(): void {
    if (this.intervalId !== null) window.clearInterval(this.intervalId);
    this.intervalId = null;
    if (this.settings.intervalMinutes > 0) {
      this.intervalId = window.setInterval(() => void this.sync(false), this.settings.intervalMinutes * 60_000);
    }

    this.scheduleSaveSync?.cancel();
    this.scheduleSaveSync =
      this.settings.syncOnSaveSeconds > 0
        ? debounce(() => void this.sync(false), this.settings.syncOnSaveSeconds * 1000, true)
        : null;
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(`R2V2: ${text}`);
  }

  private store(): R2Store {
    const s = this.settings;
    return new R2Store({
      endpoint: s.endpoint,
      bucket: s.bucket.trim(),
      prefix: s.prefix,
      credentials: { accessKeyId: s.accessKeyId.trim(), secretAccessKey: s.secretAccessKey.trim() },
    });
  }

  private statePath(): string {
    return `${this.manifest.dir}/${STATE_FILE}`;
  }

  private async loadState(remoteId: string): Promise<SyncState> {
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.statePath())) {
        const state = JSON.parse(await adapter.read(this.statePath())) as SyncState;
        // A record made against another bucket, prefix or key says nothing
        // about this one; starting empty makes the pass a deletion-free merge.
        if (state.remoteId === remoteId && state.files) return state;
      }
    } catch (e) {
      console.warn("R2V2: sync state unreadable, starting fresh", e);
    }
    return { remoteId, files: {} };
  }

  private async saveState(state: SyncState): Promise<void> {
    await this.app.vault.adapter.write(this.statePath(), JSON.stringify(state));
  }

  async resetState(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(this.statePath())) await adapter.remove(this.statePath());
  }

  /** Paths that never sync, whatever the settings say. */
  private alwaysSkip = (path: string): boolean => {
    const config = this.app.vault.configDir;
    const own = this.manifest.dir ?? `${config}/plugins/${this.manifest.id}`;
    if (path === own || path.startsWith(own + "/")) return true; // holds credentials and per-device state
    if (path === `${config}/workspace.json` || path === `${config}/workspace-mobile.json`) return true;
    return path.split("/").some((seg) => seg === "node_modules" || seg === ".git" || seg === ".DS_Store");
  };

  private includeFilter(): (key: string, size: number) => boolean {
    const s = this.settings;
    const config = this.app.vault.configDir;
    const ignores = s.ignorePaths
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map(globToRegExp);
    const maxBytes = s.maxFileSizeMB > 0 ? s.maxFileSizeMB * 1024 * 1024 : Infinity;
    return (key, size) => {
      if (this.alwaysSkip(key)) return false;
      if (!s.syncConfigDir && (key === config || key.startsWith(config + "/"))) return false;
      if (size > maxBytes) return false;
      return !ignores.some((re) => re.test(key));
    };
  }

  async testConnection(): Promise<string> {
    const missing = missingSettings(this.settings).filter((m) => m !== "暗号化パスワード");
    if (missing.length) throw new Error(`未設定: ${missing.join("、")}`);
    const store = this.store();
    await store.ping();
    if (!(await store.get(META_KEY))) {
      return "R2V2: 接続できました。リモートは未初期化で、最初の同期で暗号化の設定が作られます。";
    }
    if (!this.settings.password) return "R2V2: 接続できました。暗号化パスワードが未設定です。";
    const opened = await EncryptedRemote.open(store, this.settings.password, this.keyCache);
    this.keyCache = opened.cache;
    return "R2V2: 接続できました。パスワードも一致しています。";
  }

  async sync(manual: boolean): Promise<void> {
    if (this.syncing) {
      if (manual) new Notice("R2V2: 同期中です");
      return;
    }
    const missing = missingSettings(this.settings);
    if (missing.length) {
      this.setStatus("未設定");
      if (manual) new Notice(`R2V2: 設定が足りません — ${missing.join("、")}`);
      return;
    }

    this.syncing = true;
    this.scheduleSaveSync?.cancel();
    this.setStatus("同期中…");
    let state: SyncState | null = null;
    try {
      const s = this.settings;
      const opened = await EncryptedRemote.open(this.store(), s.password, this.keyCache);
      this.keyCache = opened.cache;
      const remote = opened.remote;

      const remoteId = [resolveEndpoint(s.endpoint), s.bucket.trim(), normalizePrefix(s.prefix), remote.id].join("|");
      state = await this.loadState(remoteId);
      const local = new VaultFs(this.app, { syncConfigDir: s.syncConfigDir, alwaysSkip: this.alwaysSkip });

      const summary = await runSync(local, remote, state, {
        include: this.includeFilter(),
        conflictAction: s.conflictAction,
        protectPercent: s.protectPercent,
        concurrency: s.concurrency,
        onProgress: (done, total) => this.setStatus(`同期中… ${done}/${total}`),
        confirmLargeChange: ({ changes, deletions, total }) =>
          ConfirmModal.ask(
            this.app,
            "R2V2: 大量の変更を検出しました",
            [
              `同期済み ${total} 件のうち ${changes} 件を上書きまたは削除しようとしています(うち削除 ${deletions} 件)。`,
              "同期先の設定を変えた覚えがない場合や、心当たりがない場合は中止してください。削除されるローカルのファイルはゴミ箱に移されます。",
            ],
            "このまま同期する",
          ),
      });
      this.report(summary, remote.foreign, manual);
    } catch (e) {
      console.error("R2V2: sync failed", e);
      this.setStatus("エラー");
      new Notice(`R2V2: 同期に失敗しました — ${e instanceof Error ? e.message : String(e)}`, 10000);
    } finally {
      // Persist whatever did succeed, so a failed pass is not repeated wholesale.
      if (state) {
        try {
          await this.saveState(state);
        } catch (e) {
          console.error("R2V2: could not save sync state", e);
        }
      }
      this.quietUntil = Date.now() + 2000;
      this.syncing = false;
    }
  }

  private report(summary: SyncSummary, foreign: number, manual: boolean): void {
    if (summary.aborted) {
      this.setStatus("中止");
      new Notice("R2V2: 同期を中止しました。何も変更していません。");
      return;
    }
    const parts: string[] = [];
    if (summary.uploaded) parts.push(`↑${summary.uploaded}`);
    if (summary.downloaded) parts.push(`↓${summary.downloaded}`);
    if (summary.deletedLocal + summary.deletedRemote) parts.push(`削除 ${summary.deletedLocal + summary.deletedRemote}`);
    if (summary.conflicts.length) parts.push(`競合 ${summary.conflicts.length}`);
    if (summary.errors.length) parts.push(`失敗 ${summary.errors.length}`);
    const detail = parts.length ? parts.join(" ") : "変更なし";
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    this.setStatus(summary.errors.length ? `一部失敗 ${time}` : `同期済み ${time}`);

    if (summary.errors.length) {
      console.error("R2V2: sync errors", summary.errors);
      const first = summary.errors[0];
      new Notice(
        `R2V2: ${summary.errors.length} 件が同期できませんでした(${first.key}: ${first.message})。詳細は開発者コンソールにあります。`,
        10000,
      );
    }
    if (summary.conflicts.length) {
      new Notice(
        `R2V2: ${summary.conflicts.length} 件が競合しました。手元の版を別名で残しています:\n${summary.conflicts.slice(0, 5).join("\n")}`,
        15000,
      );
    }
    if (foreign && manual) {
      new Notice(`R2V2: このパスワードで復号できないオブジェクトが ${foreign} 件あり、無視しました。`, 8000);
    }
    if (manual && !summary.errors.length) new Notice(`R2V2: 同期しました(${detail})`);
  }
}
