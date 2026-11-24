import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PROTOCOL } from '../shared/protocol';

function authorized(req: IncomingMessage, secret: string): boolean {
  const actual = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function json(res: ServerResponse, code: number, value: unknown): void {
  if (!res.destroyed && !res.writableEnded) {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
    res.end(JSON.stringify(value));
  }
}
async function body(req: IncomingMessage, limit = 300_000): Promise<any> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
interface Pending { id: string; message: unknown; ready: boolean; response: ServerResponse; delivered: boolean; timer: NodeJS.Timeout }
interface Connection {
  senderKey: string; receiverKey: string; touched: number;
  pending?: Pending; poll?: ServerResponse; pollTimer?: NodeJS.Timeout;
}

export function createRelay(adminKey: string) {
  if (adminKey.length < 32) throw new Error('RELAY_KEY must have at least 32 characters');
  const sessions = new Map<string, Connection>();
  const close = (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.pending?.timer);
    clearTimeout(session.pollTimer);
    if (session.pending) json(session.pending.response, 410, { error: 'Session closed' });
    if (session.poll) json(session.poll, 410, { error: 'Session closed' });
  };
  const deliver = (session: Connection) => {
    if (!session.poll || !session.pending || !session.pending.ready || session.pending.delivered) return;
    clearTimeout(session.pollTimer);
    session.pending.delivered = true;
    json(session.poll, 200, { id: session.pending.id, message: session.pending.message });
    session.poll = undefined;
  };
  const server = createServer(async (req, res) => {
    try {
      const route = (req.url ?? '').split('?')[0];
      if (req.method === 'OPTIONS') { json(res, 200, {}); return; }
      if (route === '/health' && req.method === 'GET') { json(res, 200, { protocol: PROTOCOL, status: 'ok' }); return; }
      if (route === '/sessions' && req.method === 'POST') {
        if (!authorized(req, adminKey)) { json(res, 401, {}); return; }
        if (sessions.size >= 8) { json(res, 429, {}); return; }
        const id = randomBytes(16).toString('hex');
        const senderKey = randomBytes(32).toString('hex');
        const receiverKey = randomBytes(32).toString('hex');
        sessions.set(id, { senderKey, receiverKey, touched: Date.now() });
        json(res, 200, { id, senderKey, receiverKey, protocol: PROTOCOL }); return;
      }
      const match = /^\/sessions\/([a-f0-9]{32})(?:\/(send|poll|ack|cancel))?$/.exec(route);
      if (!match) { json(res, 404, {}); return; }
      const [, id, action] = match;
      const session = sessions.get(id);
      if (!session) { json(res, 410, {}); return; }
      if (!authorized(req, action === 'send' || action === 'cancel' ? session.senderKey : session.receiverKey)) { json(res, 401, {}); return; }
      session.touched = Date.now();
      if (!action && req.method === 'DELETE') { close(id); json(res, 200, {}); return; }
      if (action === 'cancel' && req.method === 'POST') { close(id); json(res, 200, {}); return; }
      if (action === 'poll' && req.method === 'GET') {
        if (session.poll || session.pending?.delivered) { json(res, 409, {}); return; }
        session.poll = res;
        session.pollTimer = setTimeout(() => { if (session.poll === res) { session.poll = undefined; json(res, 200, { idle: true }); } }, 20_000);
        res.on('close', () => { if (session.poll === res) { clearTimeout(session.pollTimer); session.poll = undefined; } });
        deliver(session); return;
      }
      if (action === 'send' && req.method === 'POST') {
        if (session.pending) { json(res, 409, {}); return; }
        // Reserve before reading body: simultaneous requests cannot overwrite each other.
        const pending: Pending = { id: randomBytes(16).toString('hex'), message: null, ready: false, response: res, delivered: false,
          timer: setTimeout(() => close(id), 150_000) };
        session.pending = pending;
        res.on('close', () => { if (!res.writableEnded && session.pending === pending) close(id); });
        try { pending.message = await body(req); pending.ready = true; }
        catch { close(id); json(res, 400, {}); return; }
        if (sessions.has(id)) deliver(session);
        return;
      }
      if (action === 'ack' && req.method === 'POST') {
        const ack = await body(req, 8192);
        if (!session.pending || !session.pending.delivered || ack.id !== session.pending.id || typeof ack.reply?.ok !== 'boolean') {
          json(res, 409, {}); return;
        }
        const pending = session.pending;
        clearTimeout(pending.timer);
        session.pending = undefined;
        json(pending.response, 200, ack.reply);
        json(res, 200, {}); return;
      }
      json(res, 405, {});
    } catch { json(res, 400, { error: 'Invalid request' }); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  const cleanup = setInterval(() => {
    for (const [id, session] of sessions) if (Date.now() - session.touched > 15 * 60_000) close(id);
  }, 30_000);
  cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); for (const id of sessions.keys()) close(id); });
  return server;
}
