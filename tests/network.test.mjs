import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const root = path.resolve('test-results');
let api;
before(async () => {
  await fs.mkdir(root, { recursive: true });
  const outfile = path.join(root, 'network.cjs');
  await build({ stdin: { contents: `export {createRelay} from './src/relay/server'; export {receiveSnapshot} from './src/receiver/client'; export {sendSnapshot} from './src/plugin/transfer'; export {SnapshotReceiver} from './src/receiver/storage';`, resolveDir: process.cwd() }, outfile, bundle: true, platform: 'node', format: 'cjs' });
  api = createRequire(import.meta.url)(outfile);
});
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(root, 'network-'));
  const source = path.join(directory, 'source');
  const destination = path.join(directory, 'snapshots');
  await fs.mkdir(path.join(source, '.obsidian'), { recursive: true });
  await fs.mkdir(path.join(source, 'Пустая папка'));
  await fs.writeFile(path.join(source, '.obsidian', 'config.json'), '{}');
  await fs.writeFile(path.join(source, 'note.md'), '# Hello');
  await fs.writeFile(path.join(source, 'empty'), '');
  await fs.writeFile(path.join(source, 'binary.dat'), Buffer.alloc(800_000, 231));
  const adminKey = 'a'.repeat(64);
  const server = api.createRelay(adminKey);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const relay = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  t.after(() => { controller.abort(); server.closeAllConnections(); server.close(); });
  let ready;
  const code = new Promise(resolve => { ready = resolve; });
  const received = api.receiveSnapshot({ relay, adminKey, destination, signal: controller.signal, onReady: ready });
  // Capture failures immediately so forced disconnect tests never create unhandled rejections.
  const outcome = received.then(directory => ({ directory }), error => ({ error }));
  return { source, destination, relay, adminKey, server, code: await code, outcome };
}
test('full HTTP relay transfer verifies binary chunks, empty files, hidden files and directories', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const directory = await api.sendSnapshot({ source: f.source, relay: f.relay, code: f.code, exclude: [] });
  assert.equal((await f.outcome).directory, directory);
  const report = JSON.parse(await fs.readFile(path.join(directory, 'snapshot.json'), 'utf8'));
  assert.equal(report.status, 'verified');
  assert.equal(report.totalFiles, 4);
  assert.equal((await fs.stat(path.join(directory, 'vault', 'Пустая папка'))).isDirectory(), true);
  for (const record of report.files) assert.deepEqual(await fs.readFile(path.join(directory, 'vault', record.path)), await fs.readFile(path.join(f.source, record.path)));
});
test('sender cancellation closes session and leaves a failed snapshot', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  await assert.rejects(api.sendSnapshot({ source: f.source, relay: f.relay, code: f.code, exclude: [], signal: controller.signal,
    progress() { controller.abort(); } }));
  assert.ok((await f.outcome).error);
  const [name] = await fs.readdir(f.destination);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination, name, 'snapshot.json'))).status, 'failed');
});
test('relay interruption cannot produce a verified snapshot', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(api.sendSnapshot({ source: f.source, relay: f.relay, code: f.code, exclude: [],
    progress() { f.server.closeAllConnections(); f.server.close(); } }));
  assert.ok((await f.outcome).error);
  const [name] = await fs.readdir(f.destination);
  assert.notEqual(JSON.parse(await fs.readFile(path.join(f.destination, name, 'snapshot.json'))).status, 'verified');
});
test('source changes at final verification are rejected', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await assert.rejects(api.sendSnapshot({ source: f.source, relay: f.relay, code: f.code, exclude: [],
    progress(message) { if (message.startsWith('Проверка')) createRequire(import.meta.url)('node:fs').writeFileSync(path.join(f.source, 'note.md'), 'changed'); } }), /изменил/);
  assert.ok((await f.outcome).error);
});
test('session creation requires the server key', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.relay}/sessions`, { method: 'POST' });
  assert.equal(response.status, 401);
  const bad = await fetch(`${f.relay}/sessions/${f.code.split('.')[0]}/send`, { method: 'POST', headers: { Authorization: 'Bearer wrong' }, body: '{}' });
  assert.equal(bad.status, 401);
});
test('receiver rejects traversal, case collisions, malformed and corrupt chunks', async () => {
  const directory = await fs.mkdtemp(path.join(root, 'storage-'));
  for (const filename of ['../escape', 'C:/escape', 'a\\b', 'file:stream', 'CON', '/root']) {
    const receiver = new api.SnapshotReceiver(directory);
    await receiver.accept({ type: 'start', protocol: 1, name: 'test', excluded: [] });
    await assert.rejects(receiver.accept({ type: 'directory', path: filename }));
    await receiver.fail(new Error('test rejection'));
  }
  const receiver = new api.SnapshotReceiver(directory);
  await receiver.accept({ type: 'start', protocol: 1, name: 'test', excluded: [] });
  await receiver.accept({ type: 'directory', path: 'Folder' });
  await assert.rejects(receiver.accept({ type: 'directory', path: 'folder' }), /collision/);
  const sha256 = createHash('sha256').update('correct').digest('hex');
  await receiver.accept({ type: 'file', path: 'file', size: 7, sha256 });
  await assert.rejects(receiver.accept({ type: 'chunk', data: '!bad!' }), /Invalid/);
  await receiver.accept({ type: 'chunk', data: Buffer.from('corrupt').toString('base64') });
  await assert.rejects(receiver.accept({ type: 'end-file' }), /mismatch/);
  await receiver.fail(new Error('corrupt'));
  assert.equal(JSON.parse(await fs.readFile(path.join(receiver.directory, 'snapshot.json'))).status, 'failed');
});

test('resume reuses complete files from a failed transfer and retransmits changed files', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let sent = 0;
  await assert.rejects(api.sendSnapshot({ source: f.source, relay: f.relay, code: f.code, exclude: [], signal: controller.signal,
    progress(message) { if (message.startsWith('Отправка') && ++sent === 4) controller.abort(); } }));
  await f.outcome;
  const [old] = await fs.readdir(f.destination);
  const oldReport = JSON.parse(await fs.readFile(path.join(f.destination, old, 'snapshot.json')));
  assert.equal(oldReport.totalFiles, 3);
  await fs.writeFile(path.join(f.source, 'empty'), 'changed');
  await fs.unlink(path.join(f.source, 'note.md'));
  let ready;
  const code = new Promise(resolve => { ready = resolve; });
  const received = api.receiveSnapshot({ relay: f.relay, adminKey: f.adminKey, destination: f.destination, onReady: ready });
  const outcome = received.then(directory => ({ directory }), error => ({ error }));
  const messages = [];
  const directory = await api.sendSnapshot({ source: f.source, relay: f.relay, code: await code, exclude: [], progress: m => messages.push(m) });
  assert.equal((await outcome).directory, directory);
  assert.equal(messages.filter(m => m.startsWith('Уже получен')).length, 2);
  assert.equal(await fs.readFile(path.join(directory, 'vault', 'empty'), 'utf8'), 'changed');
  await assert.rejects(fs.stat(path.join(directory, 'vault', 'note.md')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'snapshot.json'))).status, 'verified');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.destination, old, 'snapshot.json'))).status, 'failed');
});

test('reuse verifies disk bytes, supports old reports, and rejects symlinks', async () => {
  const destination = await fs.mkdtemp(path.join(root, 'reuse-'));
  const old = path.join(destination, 'old');
  await fs.mkdir(path.join(old, 'vault'), { recursive: true });
  await fs.writeFile(path.join(old, 'snapshot.json'), JSON.stringify({ formatVersion: 1, source: 'test', status: 'failed' }));
  await fs.writeFile(path.join(old, 'vault', 'good'), 'ok');
  await fs.writeFile(path.join(old, 'vault', 'bad'), 'no');
  const receiver = new api.SnapshotReceiver(destination);
  await receiver.accept({ type: 'start', protocol: 1, name: 'test', excluded: [], reuse: true });
  const sha256 = createHash('sha256').update('ok').digest('hex');
  assert.equal((await receiver.accept({ type: 'file', path: 'good', size: 2, sha256 })).skip, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(receiver.directory, 'snapshot.json'))).totalFiles, 1);
  assert.equal((await receiver.accept({ type: 'file', path: 'bad', size: 2, sha256 })).skip, undefined);
  await receiver.fail(new Error('interrupted'));
  const outside = await fs.mkdtemp(path.join(root, 'outside-'));
  await fs.writeFile(path.join(outside, 'secret'), 'ok');
  await fs.symlink(outside, path.join(old, 'vault', 'linked'), 'junction');
  const next = new api.SnapshotReceiver(destination);
  await next.accept({ type: 'start', protocol: 1, name: 'test', excluded: [], reuse: true });
  await next.accept({ type: 'directory', path: 'linked' });
  assert.equal((await next.accept({ type: 'file', path: 'linked/secret', size: 2, sha256 })).skip, undefined);
  await next.fail(new Error('done'));
});

test('relay replays unacknowledged delivery and accepts repeated acknowledgements', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const session = await (await fetch(`${f.relay}/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${f.adminKey}` } })).json();
  const url = `${f.relay}/sessions/${session.id}`;
  const headers = { Authorization: `Bearer ${session.receiverKey}`, 'Content-Type': 'application/json' };
  const sent = fetch(`${url}/send`, { method: 'POST', headers: { Authorization: `Bearer ${session.senderKey}` }, body: JSON.stringify({ type: 'finish' }) });
  const first = await (await fetch(`${url}/poll`, { headers })).json();
  const replay = await (await fetch(`${url}/poll`, { headers })).json();
  assert.deepEqual(replay, first);
  const ack = { method: 'POST', headers, body: JSON.stringify({ id: first.id, reply: { ok: true } }) };
  assert.equal((await fetch(`${url}/ack`, ack)).status, 200);
  assert.equal((await fetch(`${url}/ack`, ack)).status, 200);
  assert.equal((await sent).status, 200);
});

test('receiver tolerates lost poll and ack responses without duplicate writes', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const realFetch = globalThis.fetch;
  let lostPoll = false, lostAck = false;
  globalThis.fetch = async (url, options) => {
    const response = await realFetch(url, options);
    if (String(url).endsWith('/poll') && !lostPoll) { lostPoll = true; await response.text(); throw new TypeError('simulated lost response'); }
    if (String(url).endsWith('/ack') && !lostAck) { lostAck = true; await response.text(); throw new TypeError('simulated lost acknowledgement'); }
    return response;
  };
  try {
    const directory = await api.sendSnapshot({ source: f.source, relay: f.relay, code: f.code, exclude: [] });
    assert.equal((await f.outcome).directory, directory);
    assert.ok(lostPoll && lostAck);
    assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'snapshot.json'))).totalFiles, 4);
  } finally { globalThis.fetch = realFetch; }
});
