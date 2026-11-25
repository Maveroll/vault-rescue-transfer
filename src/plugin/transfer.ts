import path from 'node:path';
import { createReadStream } from 'node:fs';
import { CHUNK_SIZE, PROTOCOL, request, type Message, type Reply } from '../shared/protocol';
import { scan, digest, sameInventory } from './export';

export async function sendSnapshot(options: {
  source: string; relay: string; code: string; exclude: string[]; signal?: AbortSignal;
  progress?: (message: string) => void;
}): Promise<string> {
  const match = /^([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(options.code.trim());
  if (!match) throw new Error('Неверный код подключения. Скопируйте его целиком из окна приёмника.');
  const [, id, key] = match;
  const send = async (message: Message) => {
    const reply = await request<Reply>(options.relay, `/sessions/${id}/send`, key, message, options.signal);
    if (!reply.ok) throw new Error(`Приёмник: ${reply.error ?? 'ошибка'}`);
    return reply;
  };
  try {
  const inventory = await scan(options.source, new Set(options.exclude), options.signal);
  const records: { path: string; sha256: string }[] = [];
  await send({ type: 'start', protocol: PROTOCOL, name: path.basename(options.source), excluded: options.exclude, reuse: true });
  let bytes = 0;
  for (const entry of inventory) {
    options.signal?.throwIfAborted();
    if (entry.directory) { await send({ type: 'directory', path: entry.path }); continue; }
    options.progress?.(`Отправка ${records.length + 1}: ${entry.path}`);
    const original = path.join(options.source, entry.path);
    const sha256 = await digest(original, options.signal);
    const ready = await send({ type: 'file', path: entry.path, size: entry.size, sha256 });
    if (ready.skip) {
      options.progress?.(`Уже получен и проверен: ${entry.path}`);
    } else {
      for await (const chunk of createReadStream(original, { highWaterMark: CHUNK_SIZE, signal: options.signal })) {
        await send({ type: 'chunk', data: (chunk as Buffer).toString('base64') });
      }
      await send({ type: 'end-file' });
    }
    records.push({ path: entry.path, sha256 });
    bytes += entry.size;
  }
  options.progress?.('Проверка неизменности исходного хранилища…');
  for (const record of records) if (await digest(path.join(options.source, record.path), options.signal) !== record.sha256) {
    throw new Error(`Исходник изменился: ${record.path}. Снимок не завершён.`);
  }
  if (!sameInventory(inventory, await scan(options.source, new Set(options.exclude), options.signal))) {
    throw new Error('Исходное хранилище изменилось. Снимок не завершён.');
  }
  const reply = await send({ type: 'finish', files: records.length, bytes });
  return reply.directory ?? 'Проверено на принимающем компьютере.';
  } catch (error) {
    await request(options.relay, `/sessions/${id}/cancel`, key, {}).catch(() => {});
    throw error;
  }
}
