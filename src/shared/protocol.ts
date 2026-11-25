export const PROTOCOL = 1;
export const CHUNK_SIZE = 192 * 1024;
export type Message =
  | { type: 'start'; protocol: number; name: string; excluded: string[]; reuse?: boolean }
  | { type: 'directory'; path: string }
  | { type: 'file'; path: string; size: number; sha256: string }
  | { type: 'chunk'; data: string }
  | { type: 'end-file' }
  | { type: 'finish'; files: number; bytes: number };
export interface Reply { ok: boolean; error?: string; directory?: string; skip?: boolean }
export interface Session { id: string; senderKey: string; receiverKey: string; protocol: number }

export function relayAddress(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Адрес сервера не должен содержать пароль, параметры или фрагмент.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Нужен HTTPS-адрес (HTTP разрешён только для локальных тестов).');
  }
  return url.href.replace(/\/$/, '');
}

export async function request<T>(base: string, route: string, key: string, body?: unknown, signal?: AbortSignal, method?: string, retry = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await requestOnce<T>(base, route, key, body, signal, method); }
    catch (error) {
      if (!retry || attempt >= 3 || signal?.aborted || !(error instanceof TypeError || error instanceof DOMException
        || error instanceof Error && /HTTP (502|503|504)\b/.test(error.message))) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      signal?.throwIfAborted();
    }
  }
}

async function requestOnce<T>(base: string, route: string, key: string, body?: unknown, signal?: AbortSignal, method?: string): Promise<T> {
  const timeout = AbortSignal.timeout(180_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${relayAddress(base)}${route}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: combined,
  });
  if (!response.ok) {
    const reason = response.status === 410 ? 'Сеанс закрыт. Запустите приёмник и повторите отправку с новым кодом; проверенные файлы будут использованы повторно.'
      : response.status === 403 ? 'Доступ запрещён сервером или промежуточным узлом. Это не сообщение об истечении кода.'
      : response.status === 401 ? 'Неверный ключ или код подключения.' : 'Ошибка сервера при передаче.';
    throw new Error(`Сервер: HTTP ${response.status}. ${reason}`);
  }
  return await response.json() as T;
}
