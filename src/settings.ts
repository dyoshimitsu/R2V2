import { App, Notice, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { TextKey, t } from "./i18n";
import type R2V2Plugin from "./main";
import { ConflictAction } from "./sync";

export interface R2V2Settings {
  endpoint: string;
  accessKeyId: string;
  /** Name of the secret (in Obsidian's secret storage) holding the R2 secret access key. */
  secretAccessKeySecret: string;
  bucket: string;
  prefix: string;
  /** Name of the secret holding the encryption password. */
  passwordSecret: string;

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
  secretAccessKeySecret: "",
  bucket: "",
  prefix: "",
  passwordSecret: "",
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

/** Secret values, resolved from the secret storage at the moment they are needed. */
export interface ResolvedSecrets {
  secretAccessKey: string;
  password: string;
}

export type RequiredField = "endpoint" | "accessKeyId" | "secretAccessKey" | "bucket" | "password";

export const fieldLabel = (field: RequiredField): string => t(`field_${field}` as TextKey);

/** Which of the settings a sync cannot do without are still empty. */
export function missingSettings(s: R2V2Settings, secrets: ResolvedSecrets): RequiredField[] {
  const missing: RequiredField[] = [];
  if (!s.endpoint.trim()) missing.push("endpoint");
  if (!s.accessKeyId.trim()) missing.push("accessKeyId");
  if (!secrets.secretAccessKey) missing.push("secretAccessKey");
  if (!s.bucket.trim()) missing.push("bucket");
  if (!secrets.password) missing.push("password");
  return missing;
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
      key: "endpoint" | "accessKeyId" | "bucket" | "prefix",
      opts: { placeholder?: string } = {},
    ) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => {
          t.setPlaceholder(opts.placeholder ?? "")
            .setValue(s[key])
            .onChange(async (v) => {
              s[key] = v.trim();
              await this.plugin.saveSettings();
            });
        });

    // The value goes into Obsidian's secret storage; the settings only keep its name.
    const secret = (name: string, desc: string, key: "secretAccessKeySecret" | "passwordSecret") =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addComponent((el) =>
          new SecretComponent(this.app, el).setValue(s[key]).onChange(async (v) => {
            s[key] = v ?? "";
            await this.plugin.saveSettings();
          }),
        );

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
    text(t("field_endpoint"), t("desc_endpoint"), "endpoint", {
      placeholder: "0123456789abcdef…",
    });
    text(t("field_accessKeyId"), t("desc_accessKeyId"), "accessKeyId");
    secret(t("field_secretAccessKey"), t("desc_secretAccessKey"), "secretAccessKeySecret");
    text(t("field_bucket"), t("desc_bucket"), "bucket");
    text(t("field_prefix"), t("desc_prefix"), "prefix", {
      placeholder: "my-vault",
    });
    new Setting(containerEl)
      .setName(t("test_name"))
      .setDesc(t("test_desc"))
      .addButton((b) =>
        b.setButtonText(t("test_button")).onClick(async () => {
          b.setDisabled(true);
          try {
            new Notice(await this.plugin.testConnection());
          } catch (e) {
            new Notice(t("test_failed", { message: e instanceof Error ? e.message : String(e) }), 10000);
          } finally {
            b.setDisabled(false);
          }
        }),
      );

    new Setting(containerEl).setName(t("heading_encryption")).setHeading();
    secret(t("field_password"), t("desc_password"), "passwordSecret");

    new Setting(containerEl).setName(t("heading_timing")).setHeading();
    new Setting(containerEl)
      .setName(t("startup_name"))
      .setDesc(t("startup_desc"))
      .addToggle((t) =>
        t.setValue(s.syncOnStartup).onChange(async (v) => {
          s.syncOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );
    num(t("interval_name"), t("interval_desc"), "intervalMinutes", 0, 1440);
    num(t("onsave_name"), t("onsave_desc"), "syncOnSaveSeconds", 0, 3600);

    new Setting(containerEl).setName(t("heading_behavior")).setHeading();
    new Setting(containerEl)
      .setName(t("conflict_name"))
      .setDesc(t("conflict_desc"))
      .addDropdown((d) =>
        d
          .addOption("keep_both", t("conflict_keep_both"))
          .addOption("keep_newer", t("conflict_keep_newer"))
          .setValue(s.conflictAction)
          .onChange(async (v) => {
            s.conflictAction = v as ConflictAction;
            await this.plugin.saveSettings();
          }),
      );
    num(t("protect_name"), t("protect_desc"), "protectPercent", 1, 100);
    new Setting(containerEl)
      .setName(t("config_name"))
      .setDesc(t("config_desc", { dir: this.app.vault.configDir }))
      .addToggle((t) =>
        t.setValue(s.syncConfigDir).onChange(async (v) => {
          s.syncConfigDir = v;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName(t("ignore_name"))
      .setDesc(t("ignore_desc"))
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.setPlaceholder("private\n**/*.tmp")
          .setValue(s.ignorePaths)
          .onChange(async (v) => {
            s.ignorePaths = v;
            await this.plugin.saveSettings();
          });
      });
    num(t("maxsize_name"), t("maxsize_desc"), "maxFileSizeMB", 0, 5000);
    num(t("concurrency_name"), t("concurrency_desc"), "concurrency", 1, 16);

    new Setting(containerEl).setName(t("heading_maintenance")).setHeading();
    new Setting(containerEl)
      .setName(t("reset_name"))
      .setDesc(t("reset_desc"))
      .addButton((b) =>
        b.setButtonText(t("reset_button")).onClick(async () => {
          await this.plugin.resetState();
          new Notice(t("reset_done"));
        }),
      );
  }
}
