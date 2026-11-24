import { Notice, Plugin } from 'obsidian';
import { TransferSettingTab, validateRelayUrl, type TransferSettings } from './settings';

export default class VaultRescueTransferPlugin extends Plugin {
  settings: TransferSettings = { relayUrl: '' };

  async onload(): Promise<void> {
    try {
      const saved: unknown = await this.loadData();
      if (saved && typeof saved === 'object' && 'relayUrl' in saved && typeof saved.relayUrl === 'string') {
        this.settings.relayUrl = saved.relayUrl;
      }
    } catch {
      new Notice('Vault Rescue Transfer: не удалось прочитать настройки. Укажите адрес заново.');
    }
    this.addSettingTab(new TransferSettingTab(this.app, this));
    this.addCommand({
      id: 'check-readiness',
      name: 'Проверить готовность',
      callback: () => this.checkReadiness(),
    });
  }

  async saveRelayUrl(relayUrl: string): Promise<void> {
    const next = { relayUrl };
    await this.saveData(next);
    this.settings = next;
  }

  checkReadiness(): void {
    const error = validateRelayUrl(this.settings.relayUrl);
    new Notice(error ?? 'Адрес имеет корректный формат. Связь с сервером не проверена; передача файлов ещё не реализована.', 8000);
  }
}
