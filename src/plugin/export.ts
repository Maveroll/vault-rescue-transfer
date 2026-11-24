import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

interface Entry { path: string; size: number; mtimeMs: number; ctimeMs: number; directory: boolean }
interface FileRecord { path: string; size: number; sha256: string }
export interface ExportOptions {
  source: string;
  destination: string;
  exclude?: string[];
  signal?: AbortSignal;
  progress?: (message: string) => void;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Экспорт отменён.');
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function scan(root: string, excluded: Set<string>, signal?: AbortSignal): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function walk(relative: string): Promise<void> {
    for (const name of (await fs.readdir(path.join(root, relative))).sort()) {
      check(signal);
      const item = relative ? `${relative}/${name}` : name;
      if (excluded.has(item)) continue;
      const stat = await fs.lstat(path.join(root, item));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
        throw new Error(`Неподдерживаемая ссылка или специальный файл: ${item}`);
      }
      entries.push({ path: item, size: stat.isDirectory() ? 0 : stat.size,
        mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, directory: stat.isDirectory() });
      if (stat.isDirectory()) await walk(item);
    }
  }
  await walk('');
  return entries;
}

function sameInventory(a: Entry[], b: Entry[]): boolean {
  // Directory timestamps can change because excluded workspace files are updated.
  const stable = (entries: Entry[]) => entries.map((e) => e.directory
    ? { path: e.path, directory: true }
    : e);
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

async function digest(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) {
    check(signal);
    hash.update(chunk);
  }
  return hash.digest('hex');
}

export async function createSnapshot(options: ExportOptions): Promise<{ directory: string; files: number; bytes: number }> {
  const { signal, progress = () => {} } = options;
  check(signal);
  if (!path.isAbsolute(options.destination)) throw new Error('Укажите абсолютный путь папки снимков.');
  const source = await fs.realpath(options.source);
  const requestedDestination = path.resolve(options.destination);
  if (inside(source, requestedDestination)) throw new Error('Папка снимков не должна находиться внутри исходного хранилища.');
  // Resolve the nearest existing ancestor before creating directories, including junctions.
  let ancestor = requestedDestination;
  const missing: string[] = [];
  while (true) {
    try { ancestor = await fs.realpath(ancestor); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
  if (inside(source, path.join(ancestor, ...missing))) throw new Error('Папка снимков через ссылку ведёт внутрь исходного хранилища.');
  await fs.mkdir(requestedDestination, { recursive: true });
  const destination = await fs.realpath(requestedDestination);
  if (inside(source, destination)) throw new Error('Папка снимков находится внутри исходного хранилища.');
  progress('Составление описи…');
  const excluded = new Set(options.exclude ?? []);
  const inventory = await scan(source, excluded, signal);
  const files = inventory.filter((entry) => !entry.directory);
  const bytes = files.reduce((total, entry) => total + entry.size, 0);
  if (typeof fs.statfs === 'function') {
    const disk = await fs.statfs(destination);
    if (disk.bavail * disk.bsize < bytes + 16 * 1024 * 1024) throw new Error('Недостаточно свободного места для снимка.');
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = path.basename(source).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60);
  const directory = path.join(destination, `${label}_${timestamp}_${randomUUID().slice(0, 8)}`);
  await fs.mkdir(directory); // Never reuse a previous snapshot.
  const payload = path.join(directory, 'vault');
  const reportPath = path.join(directory, 'snapshot.json');
  const report = {
    formatVersion: 1, status: 'incomplete', source, startedAt: new Date().toISOString(),
    finishedAt: '', excluded: [...excluded], totalFiles: files.length, totalBytes: bytes,
    files: [] as FileRecord[], directories: inventory.filter((e) => e.directory).map((e) => e.path), error: '',
  };
  const writeReport = async () => {
    const temporary = `${reportPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(report, null, 2), 'utf8');
    await fs.rename(temporary, reportPath);
  };
  try {
    await writeReport();
    await fs.mkdir(payload);
    for (const entry of inventory) {
      check(signal);
      const target = path.join(payload, entry.path);
      if (entry.directory) { await fs.mkdir(target); continue; }
      progress(`Копирование ${report.files.length + 1}/${files.length}: ${entry.path}`);
      const original = path.join(source, entry.path);
      const before = await fs.lstat(original);
      if (!before.isFile() || before.isSymbolicLink() || before.size !== entry.size || before.mtimeMs !== entry.mtimeMs || before.ctimeMs !== entry.ctimeMs) {
        throw new Error(`Исходник изменился: ${entry.path}`);
      }
      const hash = createHash('sha256');
      // A random temporary file at snapshot root cannot collide with vault file names.
      const partial = path.join(directory, `.partial-${randomUUID()}`);
      await pipeline(createReadStream(original), new Transform({
        transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); },
      }), createWriteStream(partial, { flags: 'wx' }), { signal });
      const sha256 = hash.digest('hex');
      if ((await fs.stat(partial)).size !== entry.size || await digest(partial, signal) !== sha256) {
        throw new Error(`Проверка копии не пройдена: ${entry.path}`);
      }
      await fs.rename(partial, target);
      report.files.push({ path: entry.path, size: entry.size, sha256 });
    }
    progress('Проверка исходников и готовой копии…');
    if (!sameInventory(inventory, await scan(source, excluded, signal))) throw new Error('Состав или состояние исходного хранилища изменились во время экспорта.');
    for (const record of report.files) {
      check(signal);
      if (await digest(path.join(source, record.path), signal) !== record.sha256) throw new Error(`Исходник изменился: ${record.path}`);
      if (await digest(path.join(payload, record.path), signal) !== record.sha256) throw new Error(`Копия повреждена: ${record.path}`);
    }
    if (!sameInventory(inventory, await scan(source, excluded, signal))) throw new Error('Исходное хранилище изменилось во время проверки.');
    check(signal);
    report.status = 'verified';
    report.finishedAt = new Date().toISOString();
    await writeReport();
    return { directory, files: files.length, bytes };
  } catch (error) {
    report.status = signal?.aborted ? 'cancelled' : 'failed';
    report.error = error instanceof Error ? error.message : String(error);
    report.finishedAt = new Date().toISOString();
    try { await writeReport(); } catch { /* Initial incomplete report remains if the disk is unavailable. */ }
    throw new Error(`${report.error}\nНезавершённый снимок: ${directory}`);
  }
}
