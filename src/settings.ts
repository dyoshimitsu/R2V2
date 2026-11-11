import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type R2V2Plugin from "./main";
import { ConflictAction } from "./sync";

export interface R2V2Settings {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  prefix: string;
  password: string;

  syncOnStartup: boolean;
  /** Minutes between automatic syncs; 0 disables. */
  intervalMinutes: number;
  /** Seconds to wait after the last edit before syncing; 0 disables. */
  syncOnSaveSeconds: number;

  conflictAction: ConflictAction;
  protectPercent: number;
  syncConfigDir: boolean;
  /** One glob per line. */
  ignorePaths: string;
  /** Skip files larger than this many MB; 0 means no limit. */
  maxFileSizeMB: number;
  concurrency: number;
}

export const DEFAULT_SETTINGS: R2V2Settings = {
  endpoint: "",
  accessKeyId: "",
  secretAccessKey: "",
  bucket: "",
  prefix: "",
  password: "",
  syncOnStartup: true,
  intervalMinutes: 5,
  syncOnSaveSeconds: 30,
  conflictAction: "keep_both",
  protectPercent: 50,
  syncConfigDir: false,
  ignorePaths: "",
  maxFileSizeMB: 100,
  concurrency: 4,
};

export function missingSettings(s: R2V2Settings): string[] {
  const missing: string[] = [];
  if (!s.endpoint.trim()) missing.push("アカウント ID");
  if (!s.accessKeyId.trim()) missing.push("アクセスキー ID");
  if (!s.secretAccessKey.trim()) missing.push("シークレットアクセスキー");
  if (!s.bucket.trim()) missing.push("バケット名");
  if (!s.password) missing.push("暗号化パスワード");
  return missing;
}

export class ConfirmModal extends Modal {
  private resolved = false;

  constructor(
    app: App,
    private readonly title: string,
    private readonly lines: string[],
    private readonly confirmLabel: string,
    private readonly resolve: (ok: boolean) => void,
  ) {
    super(app);
  }

  static ask(app: App, title: string, lines: string[], confirmLabel: string): Promise<boolean> {
    return new Promise((resolve) => new ConfirmModal(app, title, lines, confirmLabel, resolve).open());
  }

  onOpen(): void {
    this.titleEl.setText(this.title);
    for (const line of this.lines) this.contentEl.createEl("p", { text: line });
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("中止").onClick(() => this.finish(false)))
      .addButton((b) =>
        b
          .setButtonText(this.confirmLabel)
          .setWarning()
          .onClick(() => this.finish(true)),
      );
  }

  private finish(ok: boolean): void {
    this.resolved = true;
    this.resolve(ok);
    this.close();
  }

  onClose(): void {
    if (!this.resolved) this.resolve(false);
    this.contentEl.empty();
  }
}

export class R2V2SettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: R2V2Plugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    const text = (
      name: string,
      desc: string,
      key: "endpoint" | "accessKeyId" | "secretAccessKey" | "bucket" | "prefix" | "password",
      opts: { secret?: boolean; placeholder?: string } = {},
    ) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          if (opts.secret) t.inputEl.type = "password";
          t.setPlaceholder(opts.placeholder ?? "")
            .setValue(s[key])
            .onChange(async (v) => {
              s[key] = opts.secret ? v : v.trim();
              await this.plugin.saveSettings();
            });
        });

    const num = (
      name: string,
      desc: string,
      key: "intervalMinutes" | "syncOnSaveSeconds" | "protectPercent" | "maxFileSizeMB" | "concurrency",
      min: number,
      max: number,
    ) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.inputEl.type = "number";
          t.setValue(String(s[key])).onChange(async (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return;
            s[key] = Math.min(max, Math.max(min, Math.floor(n)));
            await this.plugin.saveSettings();
          });
        });

    new Setting(containerEl).setName("Cloudflare R2").setHeading();
    text("アカウント ID", "Cloudflare のアカウント ID。S3 API のエンドポイント URL をそのまま入れてもよい。", "endpoint", {
      placeholder: "0123456789abcdef…",
    });
    text("アクセスキー ID", "R2 API トークンのアクセスキー ID。", "accessKeyId");
    text("シークレットアクセスキー", "R2 API トークンのシークレット。", "secretAccessKey", { secret: true });
    text("バケット名", "同期先のバケット。", "bucket");
    text("プレフィックス", "バケット内の置き場所。複数の vault を 1 つのバケットに置くときに分ける。空ならバケット直下。", "prefix", {
      placeholder: "my-vault",
    });
    new Setting(containerEl)
      .setName("接続テスト")
      .setDesc("認証情報とパスワードで R2 に接続できるか確かめる。")
      .addButton((b) =>
        b.setButtonText("テスト").onClick(async () => {
          b.setDisabled(true);
          try {
            new Notice(await this.plugin.testConnection());
          } catch (e) {
            new Notice(`R2V2: 接続できません — ${e instanceof Error ? e.message : String(e)}`, 10000);
          } finally {
            b.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl).setName("暗号化").setHeading();
    text(
      "暗号化パスワード",
      "必須。ファイルの内容・パス・更新時刻はこのパスワードから導いた鍵で暗号化してから送る。同期する全ての端末で同じものを入れる。忘れるとリモートのデータは復号できない。",
      "password",
      { secret: true },
    );

    new Setting(containerEl).setName("同期のタイミング").setHeading();
    new Setting(containerEl)
      .setName("起動時に同期")
      .setDesc("Obsidian の起動直後に 1 回同期する。")
      .addToggle((t) =>
        t.setValue(s.syncOnStartup).onChange(async (v) => {
          s.syncOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );
    num("定期同期の間隔(分)", "0 で無効。", "intervalMinutes", 0, 1440);
    num("編集後の同期(秒)", "最後の編集からこの秒数だけ静かになったら同期する。0 で無効。", "syncOnSaveSeconds", 0, 3600);

    new Setting(containerEl).setName("同期の挙動").setHeading();
    new Setting(containerEl)
      .setName("競合したとき")
      .setDesc("同じファイルが両方の端末で変更されていた場合の扱い。")
      .addDropdown((d) =>
        d
          .addOption("keep_both", "両方残す(手元の版を conflict コピーにする)")
          .addOption("keep_newer", "更新時刻が新しい方を残す")
          .setValue(s.conflictAction)
          .onChange(async (v) => {
            s.conflictAction = v as ConflictAction;
            await this.plugin.saveSettings();
          }),
      );
    num(
      "大量変更の確認(%)",
      "1 回の同期で、同期済みファイルのうちこの割合を超えて上書き・削除しようとしたら、実行前に確認する。",
      "protectPercent",
      1,
      100,
    );
    new Setting(containerEl)
      .setName("設定フォルダも同期")
      .setDesc(
        `${this.app.vault.configDir} (プラグイン、テーマ、ホットキーなど)も同期する。ワークスペースの状態とこのプラグイン自身の設定は対象外。受け取った設定の反映には Obsidian の再読み込みが要る。`,
      )
      .addToggle((t) =>
        t.setValue(s.syncConfigDir).onChange(async (v) => {
          s.syncConfigDir = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("同期しないパス")
      .setDesc("1 行に 1 つ。* はフォルダ内、** はフォルダをまたいで一致する。フォルダを書けば配下すべてが対象。")
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.setPlaceholder("private\n**/*.tmp")
          .setValue(s.ignorePaths)
          .onChange(async (v) => {
            s.ignorePaths = v;
            await this.plugin.saveSettings();
          });
      });
    num("ファイルサイズ上限(MB)", "これより大きいファイルは同期しない。0 で無制限。", "maxFileSizeMB", 0, 5000);
    num("同時転送数", "並行して転送するファイルの数。", "concurrency", 1, 16);

    new Setting(containerEl).setName("保守").setHeading();
    new Setting(containerEl)
      .setName("同期状態をリセット")
      .setDesc(
        "この端末が覚えている前回同期の記録を捨てる。次回は初回同期として扱われ、何も削除されず、両側のファイルが突き合わされる。",
      )
      .addButton((b) =>
        b.setButtonText("リセット").onClick(async () => {
          await this.plugin.resetState();
          new Notice("R2V2: 同期状態をリセットしました");
        }),
      );
  }
}
