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
