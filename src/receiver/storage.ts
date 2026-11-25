import * as fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { CHUNK_SIZE, PROTOCOL, type Message, type Reply } from '../shared/protocol';
import { digest } from '../plugin/export';

export class SnapshotReceiver {
  directory = '';
  private payload = '';
  private names = new Set<string>();
  private directories = new Set(['']);
  private reuseRoots: string[] = [];
  private active?: { handle: FileHandle; temporary: string; path: string; size: number; received: number; sha256: string; hash: Hash };
  private report = { formatVersion: 1, status: 'incomplete', source: '', startedAt: '', finishedAt: '',
    excluded: [] as string[], totalFiles: 0, totalBytes: 0, files: [] as { path: string; size: number; sha256: string }[],
    directories: [] as string[], error: '' };
  constructor(private destination: string) {}
  private async findReusable(base: string, source: string): Promise<void> {
    for (const entry of await fs.readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const folder = path.join(base, entry.name);
      try {
        const metadata = path.join(folder, 'snapshot.json');
        const stat = await fs.lstat(metadata);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) continue;
        const report = JSON.parse(await fs.readFile(metadata, 'utf8'));
        if (report.formatVersion === 1 && report.source === source) this.reuseRoots.push(folder);
      } catch { /* An unreadable or unfinished report is not a reusable snapshot. */ }
    }
  }
  private async reuseFile(relative: string, size: number, sha256: string): Promise<boolean> {
    for (const folder of this.reuseRoots) {
      let candidate = folder;
      try {
        // Check every component: old snapshots must not redirect reads through junctions/symlinks.
        const parts = ['vault', ...relative.split('/')];
        for (let i = 0; i < parts.length; i++) {
          candidate = path.join(candidate, parts[i]);
          const stat = await fs.lstat(candidate);
          if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.size !== size)) {
            throw new Error('Not a reusable regular file');
          }
        }
        if (await digest(candidate) !== sha256) continue;
      } catch { continue; }
      const temporary = path.join(this.directory, `.partial-${randomUUID()}`);
      try {
        await fs.copyFile(candidate, temporary, fs.constants.COPYFILE_EXCL);
        if ((await fs.stat(temporary)).size !== size || await digest(temporary) !== sha256) continue;
        await fs.rename(temporary, path.join(this.payload, relative));
        await this.recordFile(relative, size, sha256);
        return true;
      } finally { await fs.unlink(temporary).catch(() => {}); }
    }
    return false;
  }
  private async recordFile(relative: string, size: number, sha256: string) {
    this.report.files.push({ path: relative, size, sha256 });
    this.report.totalFiles++;
    this.report.totalBytes += size;
    // Persist after each complete file, including when the process subsequently crashes.
    await this.save();
  }
  private async save() {
    const target = path.join(this.directory, 'snapshot.json');
    await fs.writeFile(`${target}.tmp`, JSON.stringify(this.report, null, 2));
    await fs.rename(`${target}.tmp`, target);
  }
  private validateName(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 1024) throw new Error('Invalid file path');
    for (const part of value.split('/')) {
      if (!part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error('Unsupported file name');
    }
    const key = value.normalize('NFC').toLowerCase();
    if (this.names.has(key) || this.names.size >= 100_000) throw new Error('Duplicate path, case collision, or too many entries');
    const parent = value.includes('/') ? value.slice(0, value.lastIndexOf('/')) : '';
    if (!this.directories.has(parent)) throw new Error('Parent directory was not declared');
    this.names.add(key);
    return value;
  }
  async accept(message: Message): Promise<Reply> {
    if (!message || typeof message !== 'object') throw new Error('Invalid message');
    if (message.type === 'start') {
      if (this.directory || message.protocol !== PROTOCOL) throw new Error('Already started or incompatible protocol');
      if (typeof message.name !== 'string' || !message.name || message.name.length > 200 || !Array.isArray(message.excluded)
        || message.excluded.length > 100 || message.excluded.some(x => typeof x !== 'string' || x.length > 1024)) throw new Error('Invalid snapshot metadata');
      if (!path.isAbsolute(this.destination)) throw new Error('Destination must be an absolute path');
      await fs.mkdir(this.destination, { recursive: true });
      const base = await fs.realpath(this.destination);
      if (message.reuse === true) await this.findReusable(base, message.name);
      const label = message.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 60);
      this.directory = path.join(base, `${label}_${new Date().toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`);
      await fs.mkdir(this.directory);
      this.payload = path.join(this.directory, 'vault');
      await fs.mkdir(this.payload);
      this.report.source = message.name;
      this.report.startedAt = new Date().toISOString();
      this.report.excluded = message.excluded;
      await this.save();
      return { ok: true };
    }
    if (!this.directory || this.report.status !== 'incomplete') throw new Error('Snapshot is not active');
    if (this.active && message.type !== 'chunk' && message.type !== 'end-file') throw new Error('File is not finished');
    switch (message.type) {
      case 'directory': {
        const relative = this.validateName(message.path);
        await fs.mkdir(path.join(this.payload, relative));
        this.directories.add(relative);
        this.report.directories.push(relative);
        return { ok: true };
      }
      case 'file': {
        const relative = this.validateName(message.path);
        if (!Number.isSafeInteger(message.size) || message.size < 0 || message.size > 2 * 1024 ** 4
          || typeof message.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(message.sha256)) throw new Error('Invalid file metadata');
        const disk = await fs.statfs(this.directory);
        if (disk.bavail * disk.bsize < message.size + 16 * 1024 * 1024) throw new Error('Insufficient disk space');
        if (await this.reuseFile(relative, message.size, message.sha256)) return { ok: true, skip: true };
        const temporary = path.join(this.directory, `.partial-${randomUUID()}`);
        this.active = { handle: await fs.open(temporary, 'wx'), temporary, path: relative,
          size: message.size, received: 0, sha256: message.sha256, hash: createHash('sha256') };
        return { ok: true };
      }
      case 'chunk': {
        if (!this.active || typeof message.data !== 'string' || message.data.length > CHUNK_SIZE * 4 / 3 + 4
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)) throw new Error('Invalid chunk');
        const chunk = Buffer.from(message.data, 'base64');
        if (!chunk.length || this.active.received + chunk.length > this.active.size) throw new Error('Unexpected file length');
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await this.active.handle.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error('Write made no progress');
          offset += bytesWritten;
        }
        this.active.hash.update(chunk);
        this.active.received += chunk.length;
        return { ok: true };
      }
      case 'end-file': {
        const file = this.active;
        if (!file) throw new Error('No active file');
        await file.handle.sync();
        await file.handle.close();
        if (file.received !== file.size || file.hash.digest('hex') !== file.sha256 || await digest(file.temporary) !== file.sha256) {
          throw new Error('File size or SHA-256 mismatch');
        }
        await fs.rename(file.temporary, path.join(this.payload, file.path));
        this.active = undefined;
        await this.recordFile(file.path, file.size, file.sha256);
        return { ok: true };
      }
      case 'finish': {
        if (message.files !== this.report.totalFiles || message.bytes !== this.report.totalBytes) throw new Error('Inventory count mismatch');
        this.report.status = 'verified';
        this.report.finishedAt = new Date().toISOString();
        await this.save();
        return { ok: true, directory: this.directory };
      }
      default: throw new Error('Unknown message');
    }
  }
  async fail(error: unknown): Promise<void> {
    if (this.active) { await this.active.handle.close().catch(() => {}); this.active = undefined; }
    if (!this.directory || this.report.status === 'verified') return;
    this.report.status = 'failed';
    this.report.error = error instanceof Error ? error.message : String(error);
    this.report.finishedAt = new Date().toISOString();
    await this.save().catch(() => {});
  }
}
