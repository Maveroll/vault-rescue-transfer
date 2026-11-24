import { FileSystemAdapter, Modal, Notice, Platform, Plugin, Setting } from 'obsidian';
import { TransferSettingTab, validateRelayUrl, type TransferSettings } from './settings';
import { createSnapshot } from './export';

export default class VaultRescueTransferPlugin extends Plugin {
  settings: TransferSettings = { relayUrl: '', snapshotFolder: '' };
  private exportController?: AbortController;

  async onload(): Promise<void> {
    try {
      const saved: unknown = await this.loadData();
      if (saved && typeof saved === 'object' && 'relayUrl' in saved && typeof saved.relayUrl === 'string') {
        this.settings.relayUrl = saved.relayUrl;
      }
      if (saved && typeof saved === 'object' && 'snapshotFolder' in saved && typeof saved.snapshotFolder === 'string') {
        this.settings.snapshotFolder = saved.snapshotFolder;
      }
    } catch {
      new Notice('Vault Rescue Transfer: не удалось прочитать настройки. Укажите адрес заново.');
    }
    this.addSettingTab(new TransferSettingTab(this.app, this));
    this.addCommand({
      id: 'create-local-snapshot',
      name: 'Создать локальный снимок',
      callback: () => this.openSnapshotDialog(),
    });
    this.addCommand({
      id: 'check-readiness',
      name: 'Проверить готовность',
      callback: () => this.checkReadiness(),
    });
  }

  async saveRelayUrl(relayUrl: string): Promise<void> {
    const next = { ...this.settings, relayUrl };
    await this.saveData(next);
    this.settings = next;
  }

  async saveSnapshotFolder(snapshotFolder: string): Promise<void> {
    const next = { ...this.settings, snapshotFolder };
    await this.saveData(next);
    this.settings = next;
  }

  onunload(): void { this.exportController?.abort(); }

  openSnapshotDialog(): void {
    if (this.exportController) { new Notice('Экспорт уже выполняется.'); return; }
    const adapter = this.app.vault.adapter;
    if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) {
      new Notice('Локальный экспорт доступен только на компьютере.'); return;
    }
    if (!this.settings.snapshotFolder) { new Notice('Укажите папку снимков в настройках.'); return; }
    const source = adapter.getBasePath();
    const destination = this.settings.snapshotFolder;
    const configDir = this.app.vault.configDir;
    const modal = new Modal(this.app);
    modal.titleEl.setText('Создать локальный снимок');
    modal.contentEl.createEl('p', { text: `Источник: ${source}` });
    modal.contentEl.createEl('p', { text: `Папка снимков: ${destination}` });
    modal.contentEl.createEl('p', { text: 'Приостановите синхронизацию и редактирование до завершения. Включаются вложения и скрытые файлы. Исключаются только workspace.json и workspace-mobile.json из папки настроек: Obsidian меняет их во время работы.' });
    const status = modal.contentEl.createEl('p', { text: 'Для запуска нажмите «Создать снимок».' });
    let controller: AbortController | undefined;
    modal.onClose = () => controller?.abort();
    new Setting(modal.contentEl)
      .addButton((button) => button.setButtonText('Создать снимок').setCta().onClick(async () => {
        if (this.exportController) { new Notice('Экспорт уже выполняется.'); return; }
        controller = new AbortController();
        this.exportController = controller;
        button.setDisabled(true);
        let lastUpdate = 0;
        try {
          const result = await createSnapshot({
            source, destination, signal: controller.signal,
            exclude: [`${configDir}/workspace.json`, `${configDir}/workspace-mobile.json`],
            progress: (message) => {
              if (Date.now() - lastUpdate > 100) { status.setText(message); lastUpdate = Date.now(); }
            },
          });
          status.setText(`Проверено: ${result.files} файлов, ${result.bytes} байт.\n${result.directory}\nХранилище находится в подпапке vault, отчёт — snapshot.json.`);
          new Notice('Снимок создан и проверен по SHA-256.', 8000);
        } catch (error) {
          status.setText(error instanceof Error ? error.message : String(error));
          new Notice('Снимок не завершён. Подробности в окне экспорта и отчёте.', 8000);
        } finally {
          this.exportController = undefined;
          controller = undefined;
        }
      }))
      .addButton((button) => button.setButtonText('Закрыть / отменить').onClick(() => modal.close()));
    modal.open();
  }

  checkReadiness(): void {
    const error = validateRelayUrl(this.settings.relayUrl);
    new Notice(error ?? 'Адрес имеет корректный формат. Связь с сервером не проверена; передача через сервер ещё не реализована.', 8000);
  }
}
