import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type VaultRescueTransferPlugin from './main';

export interface TransferSettings {
  relayUrl: string;
  snapshotFolder: string;
}

export function validateRelayUrl(value: string): string | null {
  if (!value.trim()) return 'Укажите адрес ретранслятора в настройках плагина.';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return 'Адрес должен начинаться с https://.';
    if (url.username || url.password || url.search || url.hash) {
      return 'Адрес не должен содержать пароль, параметры запроса или фрагмент.';
    }
    return null;
  } catch {
    return 'Введите корректный HTTPS-адрес ретранслятора.';
  }
}

export class TransferSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: VaultRescueTransferPlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl('p', {
      text: 'Локальный снимок и передача на другой компьютер через ретранслятор с проверкой SHA-256. Обе стороны должны оставаться включёнными.',
    });
    let folder = this.plugin.settings.snapshotFolder;
    new Setting(this.containerEl)
      .setName('Папка снимков')
      .setDesc('Абсолютный путь вне исходного хранилища. Каждый экспорт создаёт новый каталог.')
      .addText((text) => text.setValue(folder).onChange((value) => { folder = value.trim(); }))
      .addButton((button) => button.setButtonText('Сохранить').onClick(async () => {
        try { await this.plugin.saveSnapshotFolder(folder); new Notice('Папка снимков сохранена.'); }
        catch { new Notice('Не удалось сохранить папку снимков.'); }
      }));
    new Setting(this.containerEl)
      .setName('Локальный экспорт')
      .setDesc('Используется сохранённый путь. Закрытие окна экспорта отменяет операцию.')
      .addButton((button) => button.setButtonText('Создать снимок').onClick(() => this.plugin.openSnapshotDialog()));
    let draft = this.plugin.settings.relayUrl;
    new Setting(this.containerEl)
      .setName('Передача на компьютер')
      .setDesc('Сначала сохраните адрес сервера ниже. Код подключения выдаёт приёмник на компьютере.')
      .addButton(button => button.setButtonText('Отправить снимок').onClick(() => this.plugin.openSendDialog()));
    new Setting(this.containerEl)
      .setName('Адрес ретранслятора')
      .setDesc('Сохраняется в настройках этого хранилища. Не добавляйте код подключения в адрес.')
      .addText((text) => text
        .setPlaceholder('https://relay.example.com')
        .setValue(draft)
        .onChange((value) => { draft = value.trim(); }))
      .addButton((button) => button.setButtonText('Сохранить').onClick(async () => {
        const error = draft ? validateRelayUrl(draft) : null;
        if (error) { new Notice(error); return; }
        try {
          await this.plugin.saveRelayUrl(draft);
          new Notice('Адрес сохранён.');
        } catch {
          new Notice('Не удалось сохранить настройки. Повторите попытку.');
        }
      }));
    new Setting(this.containerEl)
      .setName('Проверка готовности')
      .setDesc('Проверяет только сохранённый адрес. Соединение с сервером не устанавливается.')
      .addButton((button) => button.setButtonText('Проверить').onClick(() => this.plugin.checkReadiness()));
  }
}
