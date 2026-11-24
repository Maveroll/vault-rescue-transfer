import { FileSystemAdapter, Modal, Notice, Platform, Plugin, Setting } from 'obsidian';
import { TransferSettingTab, validateRelayUrl, type TransferSettings } from './settings';
import { createSnapshot } from './export';
import { sendSnapshot } from './transfer';

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
      id: 'send-snapshot',
      name: 'Отправить снимок на компьютер',
      callback: () => this.openSendDialog(),
    });
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

  openSendDialog(): void {
    if (this.exportController) { new Notice('Экспорт уже выполняется.'); return; }
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) { new Notice('Эта версия отправителя работает на компьютере.'); return; }
    const error = validateRelayUrl(this.settings.relayUrl);
    if (error) { new Notice(error); return; }
    const relay = this.settings.relayUrl;
    const source = adapter.getBasePath();
    const modal = new Modal(this.app);
    modal.titleEl.setText('Отправить снимок на компьютер');
    modal.contentEl.createEl('p', { text: `Хранилище: ${this.app.vault.getName()}\nСервер: ${relay}` });
    modal.contentEl.createEl('p', { text: 'Запустите приёмник на другом компьютере и вставьте его код. Остановите синхронизацию и редактирование. Отправляются все файлы, кроме workspace.json и workspace-mobile.json в папке настроек. Код действует на один сеанс и не сохраняется. Закрытие окна отменяет отправку.' });
    let code = '';
    let controller: AbortController | undefined;
    new Setting(modal.contentEl).setName('Код подключения').addText(text => text.onChange(value => { code = value.trim(); }));
    const status = modal.contentEl.createEl('p');
    modal.onClose = () => controller?.abort();
    new Setting(modal.contentEl).addButton(button => button.setButtonText('Отправить').setCta().onClick(async () => {
      if (this.exportController) { new Notice('Экспорт уже выполняется.'); return; }
      if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(code)) { new Notice('Вставьте полный код из приёмника.'); return; }
      controller = new AbortController();
      this.exportController = controller;
      button.setDisabled(true);
      try {
        const directory = await sendSnapshot({ source, relay, code, signal: controller.signal,
          exclude: [`${this.app.vault.configDir}/workspace.json`, `${this.app.vault.configDir}/workspace-mobile.json`],
          progress: message => status.setText(message),
        });
        status.setText(`Приёмник подтвердил проверенный снимок:\n${directory}`);
        new Notice('Снимок передан и проверен на компьютере.', 8000);
      } catch (error) {
        status.setText(`Передача не завершена: ${error instanceof Error ? error.message : String(error)}\nДля повторной попытки запустите приёмник заново и получите новый код.`);
      } finally { this.exportController = undefined; controller = undefined; code = ''; }
    })).addButton(button => button.setButtonText('Закрыть / отменить').onClick(() => modal.close()));
    modal.open();
  }

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
    new Notice(error ?? 'Адрес имеет корректный формат. Для отправки запустите приёмник и используйте команду «Отправить снимок на компьютер». Эта проверка не устанавливает соединение.', 8000);
  }
}
