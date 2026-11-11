import { Notice, Plugin, debounce, getLanguage, requestUrl } from "obsidian";
import { Cipher } from "./cipher";
import { ConfirmModal } from "./confirm-modal";
import { EncryptedRemote, readMeta } from "./encrypted-remote";
import { setLanguage, t } from "./i18n";
import { compileIgnore } from "./ignore";
import { VaultFs } from "./localfs";
import { HttpClient, R2Store, normalizePrefix, resolveEndpoint } from "./s3";
import { migrateSecrets } from "./secrets";
import {
  DEFAULT_SETTINGS,
  R2V2SettingTab,
  R2V2Settings,
  ResolvedSecrets,
  fieldLabel,
  missingSettings,
} from "./settings";
import { SyncState, SyncSummary, runSync } from "./sync";

const STATE_FILE = "sync-state.json";

/** Obsidian's requestUrl goes through the main process, so CORS does not apply. */
const obsidianHttp: HttpClient = async ({ url, method, headers, body }) => {
  const { "content-type": contentType, ...rest } = headers;
  const res = await requestUrl({ url, method, headers: rest, body, contentType, throw: false });
  return { status: res.status, headers: res.headers, body: res.arrayBuffer };
};

export default class R2V2Plugin extends Plugin {
  settings: R2V2Settings = DEFAULT_SETTINGS;

  private syncing = false;
  private quietUntil = 0;
  private warnedMissingDir = false;
  private statusEl: HTMLElement | null = null;
  private intervalId: number | null = null;
  private keyCache: { key: string; cipher: Cipher } | null = null;
  private scheduleSaveSync: ReturnType<typeof debounce> | null = null;

  async onload(): Promise<void> {
    setLanguage(getLanguage());
    const data = ((await this.loadData()) ?? {}) as Record<string, unknown>;
    // Earlier versions kept the secret key and password in data.json itself.
    const migrated = migrateSecrets(data, this.app.secretStorage);
    this.settings = { ...DEFAULT_SETTINGS, ...(data as Partial<R2V2Settings>) };
    if (migrated) await this.saveData(this.settings);

    this.statusEl = this.addStatusBarItem();
    this.setStatus(t("status_idle"));

    this.addRibbonIcon("refresh-cw", t("ribbon_sync_now"), () => void this.sync(true));
    this.addCommand({ id: "sync-now", name: t("cmd_sync_now"), callback: () => void this.sync(true) });
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
      if (this.settings.syncOnStartup && missingSettings(this.settings, this.secrets()).length === 0) {
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
      this.intervalId = window.setInterval(
        () => void this.sync(false),
        this.settings.intervalMinutes * 60_000,
      );
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

  /** Read at the moment of use, so a secret edited in Obsidian's settings takes effect at once. */
  private secrets(): ResolvedSecrets {
    const get = (name: string) => (name ? (this.app.secretStorage.getSecret(name) ?? "") : "");
    return {
      secretAccessKey: get(this.settings.secretAccessKeySecret).trim(),
      password: get(this.settings.passwordSecret),
    };
  }

  private store(): R2Store {
    const s = this.settings;
    return new R2Store(
      {
        endpoint: s.endpoint,
        bucket: s.bucket.trim(),
        prefix: s.prefix,
        credentials: { accessKeyId: s.accessKeyId.trim(), secretAccessKey: this.secrets().secretAccessKey },
      },
      obsidianHttp,
    );
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
    const ignored = compileIgnore(s.ignorePaths);
    const maxBytes = s.maxFileSizeMB > 0 ? s.maxFileSizeMB * 1024 * 1024 : Infinity;
    return (key, size) => {
      if (this.alwaysSkip(key)) return false;
      if (!s.syncConfigDir && (key === config || key.startsWith(config + "/"))) return false;
      if (size > maxBytes) return false;
      return !ignored(key);
    };
  }

  async testConnection(): Promise<string> {
    const secrets = this.secrets();
    const missing = missingSettings(this.settings, secrets).filter((m) => m !== "password");
    if (missing.length)
      throw new Error(t("test_missing", { fields: missing.map(fieldLabel).join(t("list_separator")) }));
    const store = this.store();
    await store.ping();
    if (!(await readMeta(store))) {
      return t("test_ok_uninitialised");
    }
    if (!secrets.password) return t("test_ok_no_password");
    const opened = await EncryptedRemote.open(store, secrets.password, this.keyCache);
    this.keyCache = opened.cache;
    return t("test_ok");
  }

  async sync(manual: boolean): Promise<void> {
    if (this.syncing) {
      if (manual) new Notice(t("already_syncing"));
      return;
    }
    const secrets = this.secrets();
    const missing = missingSettings(this.settings, secrets);
    if (missing.length) {
      this.setStatus(t("status_unconfigured"));
      if (manual)
        new Notice(t("missing_settings", { fields: missing.map(fieldLabel).join(t("list_separator")) }));
      return;
    }

    // The sync record lives in the plugin's folder. If the folder is gone (renamed or
    // removed while Obsidian was running), every pass would look like a first sync:
    // deletions would be undone and edits would turn into conflicts.
    if (!this.manifest.dir || !(await this.app.vault.adapter.exists(this.manifest.dir))) {
      this.setStatus(t("status_error"));
      if (manual || !this.warnedMissingDir) new Notice(t("plugin_dir_missing"), 15000);
      this.warnedMissingDir = true;
      return;
    }

    this.syncing = true;
    this.scheduleSaveSync?.cancel();
    this.setStatus(t("status_syncing"));
    let state: SyncState | null = null;
    try {
      const s = this.settings;
      const opened = await EncryptedRemote.open(this.store(), secrets.password, this.keyCache);
      this.keyCache = opened.cache;
      const remote = opened.remote;

      const remoteId = [
        resolveEndpoint(s.endpoint),
        s.bucket.trim(),
        normalizePrefix(s.prefix),
        remote.id,
      ].join("|");
      state = await this.loadState(remoteId);
      const local = new VaultFs(this.app, { syncConfigDir: s.syncConfigDir, alwaysSkip: this.alwaysSkip });

      const summary = await runSync(local, remote, state, {
        include: this.includeFilter(),
        conflictAction: s.conflictAction,
        protectPercent: s.protectPercent,
        concurrency: s.concurrency,
        onProgress: (done, total) => this.setStatus(t("status_progress", { done, total })),
        confirmLargeChange: ({ changes, deletions, total }) =>
          ConfirmModal.ask(
            this.app,
            t("large_title"),
            [t("large_body1", { changes, deletions, total }), t("large_body2")],
            t("large_confirm"),
          ),
      });
      this.report(summary, remote.foreign, manual);
    } catch (e) {
      console.error("R2V2: sync failed", e);
      this.setStatus(t("status_error"));
      new Notice(t("sync_failed", { message: e instanceof Error ? e.message : String(e) }), 10000);
    } finally {
      // Persist whatever did succeed, so a failed pass is not repeated wholesale.
      if (state) {
        try {
          await this.saveState(state);
        } catch (e) {
          // Without the record the next pass cannot tell deletions from new files.
          console.error("R2V2: could not save sync state", e);
          this.setStatus(t("status_error"));
          new Notice(t("state_save_failed"), 15000);
        }
      }
      this.quietUntil = Date.now() + 2000;
      this.syncing = false;
    }
  }

  private report(summary: SyncSummary, foreign: number, manual: boolean): void {
    if (summary.aborted) {
      this.setStatus(t("status_aborted"));
      new Notice(t("sync_aborted"));
      return;
    }
    const parts: string[] = [];
    if (summary.uploaded) parts.push(`↑${summary.uploaded}`);
    if (summary.downloaded) parts.push(`↓${summary.downloaded}`);
    if (summary.deletedLocal + summary.deletedRemote)
      parts.push(t("part_deleted", { n: summary.deletedLocal + summary.deletedRemote }));
    if (summary.conflicts.length) parts.push(t("part_conflicts", { n: summary.conflicts.length }));
    if (summary.errors.length) parts.push(t("part_failed", { n: summary.errors.length }));
    const detail = parts.length ? parts.join(" ") : t("no_changes");
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    this.setStatus(summary.errors.length ? t("status_partial", { time }) : t("status_synced", { time }));

    if (summary.errors.length) {
      console.error("R2V2: sync errors", summary.errors);
      const first = summary.errors[0];
      new Notice(
        t("errors_notice", { n: summary.errors.length, key: first.key, message: first.message }),
        10000,
      );
    }
    if (summary.conflicts.length) {
      new Notice(
        t("conflicts_notice", {
          n: summary.conflicts.length,
          list: summary.conflicts.slice(0, 5).join("\n"),
        }),
        15000,
      );
    }
    if (foreign && manual) {
      new Notice(t("foreign_notice", { n: foreign }), 8000);
    }
    if (manual && !summary.errors.length) new Notice(t("sync_done", { detail }));
  }
}
