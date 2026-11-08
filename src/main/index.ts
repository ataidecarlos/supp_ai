import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Result, WorkspaceEvent, WorkspaceSnapshot } from '../shared/types';
import { atomicJson, optionalJson, TicketFiles, WorkspaceError } from './files';
import { CopilotSessions } from './sessions';

protocol.registerSchemesAsPrivileged([{ scheme: 'support-file', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.SUPPORT_DATA_DIR) app.setPath('userData', process.env.SUPPORT_DATA_DIR);

let window: BrowserWindow;
let files: TicketFiles;
let sessions: CopilotSessions;
let shuttingDown = false;
let startupError: string | null = null;
let quitApproved = false;
let closing = false;
let flushRequest: { id: string; resolve: (success: boolean) => void } | null = null;

function text(value: unknown, max = 100_000): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new WorkspaceError('INPUT', 'Invalid application request.');
  return value;
}

function snapshot(): WorkspaceSnapshot {
  if (startupError) throw new WorkspaceError('STARTUP', startupError);
  return { root: files.root, tickets: files.tickets, sessions: sessions.all() };
}

function emit(event: WorkspaceEvent): void {
  if (window && !window.isDestroyed()) window.webContents.send('workspace:event', event);
}

function handle<T>(name: string, callback: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(`workspace:${name}`, async (event, ...args: unknown[]): Promise<Result<T>> => {
    try {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new WorkspaceError('IPC', 'Untrusted application frame.');
      return { ok: true, value: await callback(...args) };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof WorkspaceError ? error.code : 'IO',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function confirmExternal(target: string): Promise<boolean> {
  const answer = await dialog.showMessageBox(window, {
    type: 'warning', title: 'Open external source?',
    message: 'This opens a source outside the app.',
    detail: `${target}\n\nOnly open attachments and sources you trust.`,
    buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0,
  });
  return answer.response === 1;
}

function installHandlers(): void {
  handle('snapshot', snapshot);
  handle('flushed', (id, success) => {
    if (!flushRequest || text(id, 100) !== flushRequest.id || typeof success !== 'boolean') throw new WorkspaceError('INPUT', 'Invalid save acknowledgement.');
    flushRequest.resolve(success);
  });
  handle('choose-root', async () => {
    if (sessions.active()) throw new WorkspaceError('BUSY', 'Stop running tickets before changing the tickets root.');
    const chosen = await dialog.showOpenDialog(window, { title: 'Choose the folder containing ticket folders', properties: ['openDirectory'] });
    if (chosen.canceled) return null;
    await sessions.close();
    await files.setRoot(chosen.filePaths[0]);
    await sessions.initialize();
    startupError = null;
    await atomicJson(path.join(files.dataDir, 'settings.json'), { root: files.root });
    return snapshot();
  });
  handle('files', (id) => { const ticketId = text(id, 100); files.watch(ticketId); return files.list(ticketId); });
  handle('main-file', async (id, file) => { await files.setMainFile(text(id, 100), text(file, 4096)); return snapshot(); });
  handle('read', (id, file) => files.read(text(id, 100), text(file, 4096)));
  handle('save', (id, file, content, version) => files.save(text(id, 100), text(file, 4096), text(content, 2 * 1024 * 1024), text(version, 100)));
  handle('discard-draft', (id, file) => files.discardDraft(text(id, 100), text(file, 4096)));
  handle('import', async (id) => {
    const ticketId = text(id, 100);
    files.ticket(ticketId);
    const chosen = await dialog.showOpenDialog(window, { title: 'Import evidence into this ticket', properties: ['openFile', 'multiSelections'] });
    const imported: string[] = [];
    if (chosen.canceled) return imported;
    for (const source of chosen.filePaths) {
      const destination = await files.resolve(ticketId, path.basename(source), true);
      let overwrite = false;
      try {
        await stat(destination);
        const answer = await dialog.showMessageBox(window, {
          type: 'warning', message: `Replace ${path.basename(source)} in ${files.ticket(ticketId).name}?`,
          detail: 'The existing evidence file will be overwritten.', buttons: ['Skip', 'Replace'], defaultId: 0, cancelId: 0,
        });
        if (answer.response !== 1) continue;
        overwrite = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      imported.push(await files.importFile(ticketId, source, overwrite));
    }
    return imported;
  });
  handle('external', async (id, target) => {
    const ticket = files.ticket(text(id, 100));
    const value = text(target, 4096);
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      if (url.username || url.password) throw new WorkspaceError('URL', 'URLs containing embedded credentials are not supported.');
      if (await confirmExternal(url.href)) await shell.openExternal(url.href);
    } else {
      if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !path.isAbsolute(value)) throw new WorkspaceError('URL', 'Only HTTP/HTTPS links and file paths are supported.');
      const resolved = path.resolve(ticket.root, value.split('#')[0]);
      if (['.exe', '.com', '.cmd', '.bat', '.ps1', '.vbs', '.js', '.msi', '.lnk', '.scr'].includes(path.extname(resolved).toLowerCase())) {
        throw new WorkspaceError('FILE', 'Executable attachments cannot be launched from this app.');
      }
      await stat(resolved);
      if (await confirmExternal(resolved)) {
        const error = await shell.openPath(resolved);
        if (error) throw new WorkspaceError('EXTERNAL', error);
      }
    }
  });
  handle('send', (id, prompt) => sessions.send(text(id, 100), text(prompt)));
  handle('stop', (id) => sessions.stop(text(id, 100)));
  handle('new', (id) => sessions.newConversation(text(id, 100)));
  handle('conversation', (id, conversation) => sessions.selectConversation(text(id, 100), text(conversation, 100)));
  handle('approve', (id, approval, option) => sessions.approve(text(id, 100), text(approval, 100), option === null ? null : text(option, 100)));
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1480, height: 960, minWidth: 980, minHeight: 680, backgroundColor: '#f5f6f8',
    title: 'Support Workspace', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.on('close', (event) => {
    if (!shuttingDown) { event.preventDefault(); app.quit(); }
  });
  if (process.env.SUPPORT_DEV_URL) {
    const url = new URL(process.env.SUPPORT_DEV_URL);
    if (url.hostname !== 'localhost' || url.protocol !== 'http:') throw new WorkspaceError('DEV', 'Development URL must be localhost HTTP.');
    await window.loadURL(url.href);
  } else await window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  files = new TicketFiles(app.getPath('userData'), emit);
  sessions = new CopilotSessions(files, emit);
  try {
    const stored = await optionalJson(path.join(files.dataDir, 'settings.json'));
    let root = process.env.SUPPORT_TICKETS_ROOT;
    if (!root && stored !== null) {
      if (typeof stored !== 'object' || !('root' in stored) || typeof stored.root !== 'string') throw new WorkspaceError('STATE', 'Saved ticket-root settings are invalid.');
      root = stored.root;
    }
    if (!root && !app.isPackaged) {
      const candidate = path.join(process.cwd(), 'tickets');
      try { if ((await stat(candidate)).isDirectory()) root = candidate; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    if (root) { await files.setRoot(root); await sessions.initialize(); }
  } catch (error) { startupError = error instanceof Error ? error.message : String(error); }
  protocol.handle('support-file', async (request) => {
    try {
      const url = new URL(request.url);
      const file = await files.resolve(url.hostname, url.searchParams.get('path') ?? '');
      const type = new Map([
        ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
        ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
      ]).get(path.extname(file).toLowerCase());
      if (!type || (await stat(file)).size > 10 * 1024 * 1024) throw new WorkspaceError('IMAGE', 'Unsupported or oversized image.');
      return new Response(await readFile(file), { headers: { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) {
      emit({ type: 'error', message: `Image could not be loaded: ${error instanceof Error ? error.message : String(error)}` });
      return new Response('Image unavailable', { status: 403 });
    }
  });
  installHandlers();
  await createWindow();
}).catch((error: unknown) => {
  dialog.showErrorBox('Support Workspace could not start', error instanceof Error ? error.message : String(error));
  app.exit(1);
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  if (closing) return;
  if (sessions?.active() && !quitApproved) {
    const response = dialog.showMessageBoxSync(window, {
      type: 'warning', message: 'Tickets are still running.',
      detail: 'Exit stops app-owned Copilot processes. Completed changes remain; conversations can be resumed next time.',
      buttons: ['Keep working', 'Exit and stop agents'], defaultId: 0, cancelId: 0,
    });
    if (response !== 1) return;
  }
  quitApproved = true;
  closing = true;
  const flushed = new Promise<boolean>((resolve) => {
    const id = randomUUID();
    flushRequest = { id, resolve };
    emit({ type: 'flush', requestId: id });
  });
  const timeout = setTimeout(() => flushRequest?.resolve(false), 15_000);
  void flushed.then(async (success) => {
    clearTimeout(timeout);
    flushRequest = null;
    if (!success) throw new WorkspaceError('SAVE', 'Resolve the editor save or conflict before exiting. Your workspace remains open.');
    await sessions?.close();
    await files?.close();
    shuttingDown = true;
    app.quit();
  }).catch((error: unknown) => {
    closing = false;
    shuttingDown = false;
    quitApproved = false;
    dialog.showErrorBox('Could not safely exit', error instanceof Error ? error.message : String(error));
  });
});
app.on('window-all-closed', () => app.quit());
