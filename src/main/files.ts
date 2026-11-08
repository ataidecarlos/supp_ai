import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { FileDocument, Ticket, TicketFile, WorkspaceEvent } from '../shared/types';

export class WorkspaceError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

export function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function revision(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function optionalJson(file: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(file, 'utf8')) as unknown; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw new WorkspaceError('STATE', `Cannot read saved app state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}

export class TicketFiles {
  root: string | null = null;
  tickets: Ticket[] = [];
  private watchers = new Map<string, FSWatcher>();
  private locks = new Map<string, Promise<void>>();
  private agentWrites = new Map<string, number>();
  private emit: (event: WorkspaceEvent) => void;
  readonly dataDir: string;

  constructor(dataDir: string, emit: (event: WorkspaceEvent) => void) {
    this.dataDir = dataDir;
    this.emit = emit;
  }

  async setRoot(root: string): Promise<void> {
    const canonical = await realpath(root);
    if (!(await stat(canonical)).isDirectory()) throw new WorkspaceError('ROOT', 'Select a directory containing ticket folders.');
    const tickets: Ticket[] = [];
    for (const entry of await readdir(canonical, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
      const ticketRoot = await realpath(path.join(canonical, entry.name));
      if (!inside(canonical, ticketRoot)) continue;
      const children = await readdir(ticketRoot, { withFileTypes: true });
      const markdown = children.filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.md')).map((item) => item.name);
      const numericId = entry.name.match(/(\d+)$/)?.[1];
      const matching = markdown.filter((file) => file === `${entry.name}.md` || (numericId && file === `${numericId}.md`));
      const candidates = matching.length ? matching : markdown;
      const id = createHash('sha256').update(process.platform === 'win32' ? ticketRoot.toLowerCase() : ticketRoot).digest('hex').slice(0, 24);
      const saved = await optionalJson(path.join(this.dataDir, 'tickets', id, 'ticket.json'));
      let mainFile = matching.length === 1 ? matching[0] : null;
      if (saved !== null) {
        if (typeof saved !== 'object' || !('mainFile' in saved) || typeof saved.mainFile !== 'string') throw new WorkspaceError('STATE', `Saved summary selection for ${entry.name} is invalid.`);
        if (markdown.includes(saved.mainFile)) mainFile = saved.mainFile;
      }
      tickets.push({
        id,
        name: entry.name,
        root: ticketRoot,
        mainFile,
        mainCandidates: candidates,
      });
    }
    await this.close();
    this.root = canonical;
    this.tickets = tickets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  ticket(id: string): Ticket {
    const ticket = this.tickets.find((item) => item.id === id);
    if (!ticket) throw new WorkspaceError('TICKET', 'Unknown ticket. Reload the ticket folder.');
    return ticket;
  }

  async setMainFile(id: string, relative: string): Promise<void> {
    const target = await this.resolve(id, relative);
    if (path.dirname(target) !== this.ticket(id).root || !target.toLowerCase().endsWith('.md') || !(await stat(target)).isFile()) {
      throw new WorkspaceError('FILE', 'Choose a Markdown summary in the ticket folder.');
    }
    await atomicJson(path.join(this.dataDir, 'tickets', id, 'ticket.json'), { mainFile: relative });
    this.ticket(id).mainFile = relative;
  }

  async resolve(id: string, relative: string, allowNew = false): Promise<string> {
    const ticket = this.ticket(id);
    if (!relative || relative.includes('\0') || relative.includes(':') || path.isAbsolute(relative)) throw new WorkspaceError('PATH', 'Use a ticket-relative file path.');
    const target = path.resolve(ticket.root, relative);
    if (!inside(ticket.root, target) || target === ticket.root) throw new WorkspaceError('PATH', 'The file is outside this ticket.');
    let canonical: string;
    try { canonical = await realpath(target); }
    catch (error) {
      if (!allowNew || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      let ancestor = path.dirname(target);
      while (true) {
        try {
          const existing = await realpath(ancestor);
          if (!(await stat(existing)).isDirectory()) throw new WorkspaceError('PATH', 'The file parent is not a directory.');
          canonical = path.resolve(existing, path.relative(ancestor, target));
          break;
        } catch (ancestorError) {
          if (!(ancestorError instanceof Error && 'code' in ancestorError && ancestorError.code === 'ENOENT') || ancestor === path.dirname(ancestor)) throw ancestorError;
          ancestor = path.dirname(ancestor);
        }
      }
    }
    if (!inside(ticket.root, canonical)) throw new WorkspaceError('PATH', 'A link or junction points outside this ticket.');
    return canonical;
  }

  async localAgentPath(id: string, target: string): Promise<string> {
    const ticket = this.ticket(id);
    const relative = path.relative(ticket.root, path.resolve(ticket.root, target));
    return this.resolve(id, relative, true);
  }

  async list(id: string): Promise<TicketFile[]> {
    const ticket = this.ticket(id);
    const files: TicketFile[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const absolute = path.join(directory, entry.name);
        if (!inside(ticket.root, await realpath(absolute))) continue;
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) {
          if (files.length >= 5000) throw new WorkspaceError('LIMIT', 'This ticket exceeds the 5,000-file viewer limit.');
          files.push({ path: path.relative(ticket.root, absolute), size: (await stat(absolute)).size });
        }
      }
    };
    await visit(ticket.root);
    return files.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }

  async read(id: string, relative: string): Promise<FileDocument> {
    const target = await this.resolve(id, relative);
    const info = await stat(target);
    if (!info.isFile()) throw new WorkspaceError('FILE', 'The selected path is not a regular file.');
    const extension = path.extname(target).toLowerCase();
    const image = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(extension);
    const document: FileDocument = { path: relative, kind: 'unsupported', content: '', revision: '', size: info.size };
    if (info.size > (image ? 10 : 2) * 1024 * 1024) return document;
    const content = await readFile(target);
    document.revision = revision(content);
    if (image) {
      document.kind = 'image';
      document.imageUrl = `support-file://${id}/?path=${encodeURIComponent(relative)}`;
    } else if (!content.includes(0) && ['.md', '.markdown', '.txt', '.log', '.json', '.jsonl', '.csv', '.yaml', '.yml', '.xml', '.ini', '.conf', '.sql', '.ts', '.js', '.py', ''].includes(extension)) {
      document.kind = extension === '.md' || extension === '.markdown' ? 'markdown' : 'text';
      document.content = content.toString('utf8');
      if (document.kind === 'markdown') {
        const draft = await optionalJson(path.join(this.dataDir, 'tickets', id, 'drafts', `${revision(Buffer.from(relative))}.json`));
        if (draft !== null) {
          if (typeof draft !== 'object' || !('content' in draft) || !('expectedRevision' in draft) ||
            typeof draft.content !== 'string' || typeof draft.expectedRevision !== 'string') {
            throw new WorkspaceError('STATE', 'The recovered editor draft is invalid. It has not been overwritten.');
          }
          document.recoveredDraft = { content: draft.content, expectedRevision: draft.expectedRevision };
        }
      }
    }
    return document;
  }

  async acquire(target: string): Promise<() => void> {
    const previous = this.locks.get(target) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.locks.set(target, tail);
    await previous;
    return () => {
      release();
      if (this.locks.get(target) === tail) this.locks.delete(target);
    };
  }

  async beginAgentEdit(id: string, paths: string[], expected: Map<string, string>): Promise<() => void> {
    const targets = [...new Set(await Promise.all(paths.map((file) => this.localAgentPath(id, file))))].sort();
    const releases: (() => void)[] = [];
    try {
      for (const target of targets) {
        if (this.agentWrites.has(target)) throw new WorkspaceError('BUSY', 'Another agent operation is modifying this file. The overlapping edit was denied.');
        this.agentWrites.set(target, (this.agentWrites.get(target) ?? 0) + 1);
        releases.push(() => {
          const count = (this.agentWrites.get(target) ?? 1) - 1;
          if (count) this.agentWrites.set(target, count); else this.agentWrites.delete(target);
        });
        releases.push(await this.acquire(target));
        const readRevision = expected.get(target);
        if (readRevision && revision(await readFile(target)) !== readRevision) {
          throw new WorkspaceError('CONFLICT', 'The file changed after Copilot read it. Its edit was denied; ask it to reread the file.');
        }
        try {
          const before = await readFile(target);
          await atomicJson(path.join(this.dataDir, 'tickets', id, 'recovery', `${revision(Buffer.from(path.relative(this.ticket(id).root, target)))}.json`), {
            path: path.relative(this.ticket(id).root, target), content: before.toString('utf8'), revision: revision(before),
          });
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
      }
      return () => { for (const release of releases.reverse()) release(); };
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
  }

  async save(id: string, relative: string, content: string, expectedRevision: string): Promise<FileDocument> {
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new WorkspaceError('LIMIT', 'Markdown editing is limited to 2 MiB.');
    const target = await this.resolve(id, relative);
    if (!['.md', '.markdown'].includes(path.extname(target).toLowerCase())) throw new WorkspaceError('FILE', 'Only Markdown files can be edited.');
    const recovery = path.join(this.dataDir, 'tickets', id, 'drafts', `${revision(Buffer.from(relative))}.json`);
    await atomicJson(recovery, { path: relative, content, expectedRevision, savedAt: new Date().toISOString() });
    if (this.agentWrites.has(target)) throw new WorkspaceError('BUSY', 'Copilot is modifying this file. Your draft is preserved; saving is paused.');
    const release = await this.acquire(target);
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      const old = await readFile(target);
      if (revision(old) !== expectedRevision) throw new WorkspaceError('CONFLICT', 'The file changed on disk. Choose a version before saving.');
      await atomicJson(path.join(this.dataDir, 'tickets', id, 'recovery', `${revision(Buffer.from(relative))}.json`), {
        path: relative, content: old.toString('utf8'), revision: expectedRevision,
      });
      const handle = await open(temporary, 'wx', (await stat(target)).mode);
      try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      if (revision(await readFile(target)) !== expectedRevision) throw new WorkspaceError('CONFLICT', 'The file changed while saving. Your draft is preserved.');
      await rename(temporary, target);
      await unlink(recovery);
      this.emit({ type: 'files', ticketId: id, path: relative });
      return this.read(id, relative);
    } finally {
      release();
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async importFile(id: string, source: string, overwrite: boolean): Promise<string> {
    const relative = path.basename(source);
    const target = await this.resolve(id, relative, true);
    if (target === await realpath(source)) throw new WorkspaceError('IMPORT', 'This file is already in the ticket.');
    if (this.agentWrites.has(target)) throw new WorkspaceError('BUSY', 'Copilot is editing the destination. Try importing later.');
    const release = await this.acquire(target);
    try { await copyFile(source, target, overwrite ? 0 : constants.COPYFILE_EXCL); }
    finally { release(); }
    this.emit({ type: 'files', ticketId: id, path: relative });
    return relative;
  }

  async discardDraft(id: string, relative: string): Promise<void> {
    await this.resolve(id, relative);
    await unlink(path.join(this.dataDir, 'tickets', id, 'drafts', `${revision(Buffer.from(relative))}.json`))
      .catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }

  watch(id: string): void {
    const ticket = this.ticket(id);
    if (this.watchers.has(id)) return;
    const watcher = chokidar.watch(ticket.root, {
      ignoreInitial: true, followSymlinks: false, ignored: /(^|[\\/])\./,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    watcher.on('all', (_event, target) => this.emit({ type: 'files', ticketId: id, path: path.relative(ticket.root, target) }));
    watcher.on('error', (error) => this.emit({ type: 'error', message: `Ticket watcher failed: ${String(error)}` }));
    this.watchers.set(id, watcher);
  }

  async close(): Promise<void> {
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.close()));
    this.watchers.clear();
  }
}
