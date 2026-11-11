import { App, Notice, PluginSettingTab, SettingDefinitionItem } from "obsidian";
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

type SettingsKey = keyof R2V2Settings;

export class R2V2SettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: R2V2Plugin,
  ) {
    super(app, plugin);
  }

  /** Controls write straight into the plugin's settings; saving also re-arms the sync timers. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    (this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
    await this.plugin.saveSettings();
  }

  getSettingDefinitions(): SettingDefinitionItem<SettingsKey>[] {
    return [
      {
        type: "group",
        heading: "Cloudflare R2",
        items: [
          {
            name: t("field_endpoint"),
            desc: t("desc_endpoint"),
            control: { type: "text", key: "endpoint", placeholder: "0123456789abcdef…" },
          },
          {
            name: t("field_accessKeyId"),
            desc: t("desc_accessKeyId"),
            control: { type: "text", key: "accessKeyId" },
          },
          {
            name: t("field_secretAccessKey"),
            desc: t("desc_secretAccessKey"),
            control: { type: "secret", key: "secretAccessKeySecret" },
          },
          {
            name: t("field_bucket"),
            desc: t("desc_bucket"),
            control: { type: "text", key: "bucket" },
          },
          {
            name: t("field_prefix"),
            desc: t("desc_prefix"),
            control: { type: "text", key: "prefix", placeholder: "my-vault" },
          },
          {
            name: t("test_name"),
            desc: t("test_desc"),
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText(t("test_button")).onClick(async () => {
                  button.setDisabled(true);
                  try {
                    new Notice(await this.plugin.testConnection());
                  } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    new Notice(t("test_failed", { message }), 10000);
                  } finally {
                    button.setDisabled(false);
                  }
                }),
              );
            },
          },
        ],
      },
      {
        type: "group",
        heading: t("heading_encryption"),
        items: [
          {
            name: t("field_password"),
            desc: t("desc_password"),
            control: { type: "secret", key: "passwordSecret" },
          },
        ],
      },
      {
        type: "group",
        heading: t("heading_timing"),
        items: [
          {
            name: t("startup_name"),
            desc: t("startup_desc"),
            control: { type: "toggle", key: "syncOnStartup" },
          },
          {
            name: t("interval_name"),
            desc: t("interval_desc"),
            control: { type: "number", key: "intervalMinutes", min: 0, max: 1440, step: 1 },
          },
          {
            name: t("onsave_name"),
            desc: t("onsave_desc"),
            control: { type: "number", key: "syncOnSaveSeconds", min: 0, max: 3600, step: 1 },
          },
        ],
      },
      {
        type: "group",
        heading: t("heading_behavior"),
        items: [
          {
            name: t("conflict_name"),
            desc: t("conflict_desc"),
            control: {
              type: "dropdown",
              key: "conflictAction",
              defaultValue: "keep_both",
              options: {
                keep_both: t("conflict_keep_both"),
                keep_newer: t("conflict_keep_newer"),
              },
            },
          },
          {
            name: t("protect_name"),
            desc: t("protect_desc"),
            control: { type: "number", key: "protectPercent", min: 1, max: 100, step: 1 },
          },
          {
            name: t("config_name"),
            desc: t("config_desc", { dir: this.app.vault.configDir }),
            control: { type: "toggle", key: "syncConfigDir" },
          },
          {
            name: t("ignore_name"),
            desc: t("ignore_desc"),
            control: { type: "textarea", key: "ignorePaths", rows: 4, placeholder: "private\n**/*.tmp" },
          },
          {
            name: t("maxsize_name"),
            desc: t("maxsize_desc"),
            control: { type: "number", key: "maxFileSizeMB", min: 0, max: 5000, step: 1 },
          },
          {
            name: t("concurrency_name"),
            desc: t("concurrency_desc"),
            control: { type: "number", key: "concurrency", min: 1, max: 16, step: 1 },
          },
        ],
      },
      {
        type: "group",
        heading: t("heading_maintenance"),
        items: [
          {
            name: t("reset_name"),
            desc: t("reset_desc"),
            render: (setting) => {
              setting.addButton((button) =>
                button.setButtonText(t("reset_button")).onClick(async () => {
                  await this.plugin.resetState();
                  new Notice(t("reset_done"));
                }),
              );
            },
          },
        ],
      },
    ];
  }
}
