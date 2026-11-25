import { PROTOCOL, request, type Message, type Session } from '../shared/protocol';
import { SnapshotReceiver } from './storage';

export async function receiveSnapshot(options: {
  relay: string; adminKey: string; destination: string; signal?: AbortSignal;
  onReady: (code: string) => void; progress?: (message: string) => void;
}): Promise<string> {
  const session = await request<Session>(options.relay, '/sessions', options.adminKey, {}, options.signal);
  if (session.protocol !== PROTOCOL) throw new Error('Incompatible relay protocol');
  const storage = new SnapshotReceiver(options.destination);
  options.onReady(`${session.id}.${session.senderKey}`);
  let lastMessage = Date.now();
  try {
    while (true) {
      const response = await request<{ idle?: boolean; id: string; message: Message }>(options.relay,
        `/sessions/${session.id}/poll`, session.receiverKey, undefined, options.signal, undefined, true);
      if (response.idle) {
        if (Date.now() - lastMessage > 15 * 60_000) throw new Error('Нет данных от отправителя 15 минут. Запустите приёмник заново.');
        continue;
      }
      lastMessage = Date.now();
      try {
        const reply = await storage.accept(response.message);
        await request(options.relay, `/sessions/${session.id}/ack`, session.receiverKey, { id: response.id, reply }, options.signal, undefined, true);
        if (response.message.type === 'end-file') options.progress?.('Файл получен и проверен.');
        if (reply.directory) return reply.directory;
      } catch (error) {
        await storage.fail(error);
        await request(options.relay, `/sessions/${session.id}/ack`, session.receiverKey,
          { id: response.id, reply: { ok: false, error: error instanceof Error ? error.message : String(error) } }, options.signal).catch(() => {});
        throw error;
      }
    }
  } catch (error) { await storage.fail(error); throw error; }
  finally { await request(options.relay, `/sessions/${session.id}`, session.receiverKey, undefined, undefined, 'DELETE').catch(() => {}); }
}
