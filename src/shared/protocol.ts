export const PROTOCOL = 1;
export const CHUNK_SIZE = 192 * 1024;
export type Message =
  | { type: 'start'; protocol: number; name: string; excluded: string[] }
  | { type: 'directory'; path: string }
  | { type: 'file'; path: string; size: number; sha256: string }
  | { type: 'chunk'; data: string }
  | { type: 'end-file' }
  | { type: 'finish'; files: number; bytes: number };
export interface Reply { ok: boolean; error?: string; directory?: string }
export interface Session { id: string; senderKey: string; receiverKey: string; protocol: number }

export function relayAddress(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('Адрес сервера не должен содержать пароль, параметры или фрагмент.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Нужен HTTPS-адрес (HTTP разрешён только для локальных тестов).');
  }
  return url.href.replace(/\/$/, '');
}

export async function request<T>(base: string, route: string, key: string, body?: unknown, signal?: AbortSignal, method?: string): Promise<T> {
  const timeout = AbortSignal.timeout(180_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${relayAddress(base)}${route}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: combined,
  });
  if (!response.ok) throw new Error(`Сервер: HTTP ${response.status}. Сеанс мог завершиться; запустите приёмник заново.`);
  return await response.json() as T;
}
