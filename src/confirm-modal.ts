import { App, Modal, Setting } from "obsidian";
import { t } from "./i18n";

/** A yes/no dialog; closing it any other way counts as "no". */
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
      .addButton((b) => b.setButtonText(t("cancel")).onClick(() => this.finish(false)))
      .addButton((b) =>
        b
          .setButtonText(this.confirmLabel)
          .setDestructive()
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
