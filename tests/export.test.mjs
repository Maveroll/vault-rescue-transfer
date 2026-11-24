import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as sync from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = path.resolve('test-results');
let createSnapshot;
before(async () => {
  await fs.mkdir(root, { recursive: true });
  const compiled = path.join(root, 'export.cjs');
  await build({ entryPoints: ['src/plugin/export.ts'], outfile: compiled, bundle: true, platform: 'node', format: 'cjs' });
  ({ createSnapshot } = createRequire(import.meta.url)(compiled));
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(root, 'case-'));
  const source = path.join(directory, 'source');
  const destination = path.join(directory, 'snapshots');
  await fs.mkdir(path.join(source, '.obsidian'), { recursive: true });
  await fs.mkdir(path.join(source, 'Пустая папка'));
  await fs.writeFile(path.join(source, 'Заметка.md'), '# Проверка\n');
  await fs.writeFile(path.join(source, 'attachment.bin'), Buffer.from([0, 255, 1, 128]));
  await fs.writeFile(path.join(source, 'empty.md'), '');
  await fs.writeFile(path.join(source, '.obsidian', 'config.json'), '{}');
  await fs.writeFile(path.join(source, '.obsidian', 'workspace.json'), '{}');
  return { source, destination, exclude: ['.obsidian/workspace.json'] };
}
const readReport = async (directory) => JSON.parse(await fs.readFile(path.join(directory, 'snapshot.json'), 'utf8'));

test('preserves binary, Unicode, empty files/directories and hidden config; repeat creates a new snapshot', async () => {
  const options = await fixture();
  const first = await createSnapshot(options);
  assert.equal(first.files, 4);
  const report = await readReport(first.directory);
  assert.equal(report.status, 'verified');
  assert.deepEqual(report.excluded, options.exclude);
  for (const record of report.files) {
    assert.deepEqual(await fs.readFile(path.join(first.directory, 'vault', record.path)), await fs.readFile(path.join(options.source, record.path)));
    assert.match(record.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal((await fs.stat(path.join(first.directory, 'vault', 'Пустая папка'))).isDirectory(), true);
  await assert.rejects(fs.stat(path.join(first.directory, 'vault', '.obsidian/workspace.json')), { code: 'ENOENT' });
  const second = await createSnapshot(options);
  assert.notEqual(first.directory, second.directory);
  assert.equal((await readReport(first.directory)).status, 'verified');
});

test('rejects a destination nested in the source before creating it', async () => {
  const options = await fixture();
  const destination = path.join(options.source, 'new', 'snapshots');
  await assert.rejects(createSnapshot({ ...options, destination }), /внутри/);
  await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
});

test('cancellation keeps a non-verified report and a fresh retry succeeds', async () => {
  const options = await fixture();
  const controller = new AbortController();
  await assert.rejects(createSnapshot({ ...options, signal: controller.signal,
    progress(message) { if (message.startsWith('Копирование 2/')) controller.abort(); },
  }));
  const [failed] = await fs.readdir(options.destination);
  const report = await readReport(path.join(options.destination, failed));
  assert.equal(report.status, 'cancelled');
  const retry = await createSnapshot(options);
  assert.equal((await readReport(retry.directory)).status, 'verified');
});

test('source modification prevents verified status', async () => {
  const options = await fixture();
  await assert.rejects(createSnapshot({ ...options, progress(message) {
    if (message.startsWith('Проверка исходников')) sync.writeFileSync(path.join(options.source, 'Заметка.md'), 'changed');
  } }), /изменил/);
  const [failed] = await fs.readdir(options.destination);
  assert.equal((await readReport(path.join(options.destination, failed))).status, 'failed');
});

test('destination corruption is caught by final verification', async () => {
  const options = await fixture();
  await assert.rejects(createSnapshot({ ...options, progress(message) {
    if (message.startsWith('Проверка исходников')) {
      const [snapshot] = sync.readdirSync(options.destination);
      sync.writeFileSync(path.join(options.destination, snapshot, 'vault', 'attachment.bin'), 'corrupt');
    }
  } }), /повреждена/);
});

test('directory junctions cannot route the destination into the source', async () => {
  const options = await fixture();
  const alias = path.join(path.dirname(options.source), 'alias');
  await fs.symlink(options.source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSnapshot({ ...options, destination: path.join(alias, 'snapshots') }), /внутрь/);
  await assert.rejects(fs.stat(path.join(options.source, 'snapshots')), { code: 'ENOENT' });
});

test('source links are rejected rather than followed or silently skipped', async () => {
  const options = await fixture();
  const external = path.join(path.dirname(options.source), 'external');
  await fs.mkdir(external);
  await fs.symlink(external, path.join(options.source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createSnapshot(options), /ссылка/);
});
