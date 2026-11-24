import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type VaultRescueTransferPlugin from './main';

export interface TransferSettings {
  relayUrl: string;
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
      text: 'Предварительная версия: доступны настройки и локальная проверка. Передача файлов ещё не реализована.',
    });
    let draft = this.plugin.settings.relayUrl;
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
