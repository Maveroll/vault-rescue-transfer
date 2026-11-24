import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { receiveSnapshot } from './client';

async function main() {
  const { values } = parseArgs({ options: { relay: { type: 'string' }, destination: { type: 'string' }, 'key-file': { type: 'string' } } });
  if (!values.relay || !values.destination || !values['key-file']) throw new Error('Usage: node receiver.cjs --relay HTTPS_URL --destination ABSOLUTE_PATH --key-file KEY_FILE');
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  const directory = await receiveSnapshot({
    relay: values.relay, destination: values.destination,
    adminKey: (await readFile(values['key-file'], 'utf8')).trim(), signal: controller.signal,
    onReady(code) { console.log(`Код подключения (вставьте в плагин отправителя):\n${code}\nОжидание хранилища. Не закрывайте это окно.`); },
    progress(message) { console.log(message); },
  });
  console.log(`Проверено. Снимок сохранён:\n${directory}`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
