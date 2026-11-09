import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import type { WorkspaceEvent } from '../src/shared/types';
import { TicketFiles } from '../src/main/files';

const controls = vi.hoisted(() => ({ noLoad: false, missing: false, noList: false, listFail: false }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (_command: string, _args: readonly string[], options: SpawnOptions) => actual.spawn(
      controls.missing ? path.join(process.cwd(), 'missing-synthetic-copilot.exe') : process.execPath,
      controls.missing ? [] : [path.join(process.cwd(), 'tests', 'fixtures', 'fake-cli.mjs')],
      { ...options, shell: false, env: {
        ...options.env,        FAKE_CLI_NO_LOAD: controls.noLoad ? '1' : '0',
        FAKE_CLI_NO_LIST: controls.noList ? '1' : '0',
        FAKE_CLI_LIST_FAIL: controls.listFail ? '1' : '0',
      } },
    ),
  };
});
import { existsSync } from 'node:fs';
import { CopilotSessions, CLI_ARGS, cliEnvironment, cliCommand } from '../src/main/sessions';

const sandboxes: string[] = [];
const managers: CopilotSessions[] = [];
const fileManagers: TicketFiles[] = [];
async function harness() {
  const root = await mkdtemp(path.join(tmpdir(), 'supp-ai-sessions-'));
  sandboxes.push(root);
  const ticketRoot = path.join(root, 'tickets');
  for (const name of ['ticket_A', 'ticket_B']) {
    const directory = path.join(ticketRoot, name);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'main.md'), '# Main');
    await writeFile(path.join(directory, 'second.md'), '# Second');
  }
  const files = new TicketFiles(path.join(root, 'data'), vi.fn());
  fileManagers.push(files);
  await files.setRoot(ticketRoot);
  const events: WorkspaceEvent[] = [];
  const sessions = new CopilotSessions(files, (event) => events.push(event));
  managers.push(sessions);
  await sessions.initialize();
  return { root, files, sessions, events, a: files.tickets[0], b: files.tickets[1] };
}
async function seedSession(h: { root: string; a: { id: string; root: string } }, sessionId: string): Promise<void> {
  const home = path.join(h.root, 'data', 'tickets', h.a.id, 'copilot');
  await mkdir(home, { recursive: true });
  const store = path.join(home, 'fake-sessions.json');
  let sessions: Record<string, unknown> = {};
  try { sessions = JSON.parse(await readFile(store, 'utf8')) as Record<string, unknown>; } catch { /* new store */ }
  sessions[sessionId] = {
    cwd: h.a.root,
    history: [{ role: 'user', text: 'replayed-marker' }, { role: 'agent', text: 'replayed reply' }],
    title: 'External session',
    updatedAt: new Date().toISOString(),
  };
  await writeFile(store, JSON.stringify(sessions));
}

afterEach(async () => {  await Promise.all(managers.splice(0).map((manager) => manager.close()));
  await Promise.all(fileManagers.splice(0).map((manager) => manager.close()));
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  controls.noLoad = false;
  controls.missing = false;
  controls.noList = false;
  controls.listFail = false;
});

describe('ticket-bound ACP conversations', () => {
  it('streams separate sessions while another ticket remains working', async () => {
    const h = await harness();
    const pending = h.sessions.send(h.a.id, '[DELAY] alpha-marker');
    await vi.waitFor(() => expect(h.sessions.state(h.a.id).messages.some((message) => message.text.includes('alpha-marker'))).toBe(true));
    await h.sessions.send(h.b.id, 'beta-marker');
    expect(h.sessions.state(h.a.id).activity).toBe('running');
    expect(h.sessions.state(h.a.id).messages.some((message) => message.text.includes('beta-marker'))).toBe(false);
    expect(h.sessions.state(h.b.id).messages.some((message) => message.text.includes('alpha-marker'))).toBe(false);
    await h.sessions.stop(h.a.id);
    await pending;
    expect(h.sessions.state(h.a.id).activity).toBe('idle');
  });

  it('restores history without duplicating replay and preserves old conversations', async () => {
    const h = await harness();
    await h.sessions.send(h.a.id, 'history-marker');
    const old = h.sessions.state(h.a.id).currentId!;
    const messages = structuredClone(h.sessions.state(h.a.id).messages);
    await h.sessions.newConversation(h.a.id);
    expect(h.sessions.state(h.a.id).conversations).toHaveLength(2);
    await h.sessions.close();
    managers.splice(managers.indexOf(h.sessions), 1);
    const restored = new CopilotSessions(h.files, vi.fn());
    managers.push(restored);
    await restored.initialize();
    await restored.selectConversation(h.a.id, old);
    expect(restored.state(h.a.id).messages).toEqual(messages);
    await restored.send(h.a.id, 'after-restart');
    expect(restored.state(h.a.id).messages.filter((message) => message.role === 'user')).toHaveLength(2);
    expect(restored.state(h.a.id).messages.filter((message) => message.role === 'agent')).toHaveLength(2);
  });

  it('keeps external approvals ticket-scoped and rejects invalid choices', async () => {
    const h = await harness();
    const turn = h.sessions.send(h.a.id, '[EXTERNAL]');
    await vi.waitFor(() => expect(h.sessions.state(h.a.id).approvals).toHaveLength(1));
    const approval = h.sessions.state(h.a.id).approvals[0];
    expect(h.sessions.state(h.b.id).approvals).toHaveLength(0);
    await expect(h.sessions.approve(h.b.id, approval.id, 'allow_once')).rejects.toMatchObject({ code: 'APPROVAL' });
    await expect(h.sessions.approve(h.a.id, approval.id, 'always')).rejects.toMatchObject({ code: 'APPROVAL' });
    await h.sessions.approve(h.a.id, approval.id, 'reject_once');
    await turn;
    expect(h.sessions.state(h.a.id).messages.at(-1)?.text).toContain('reject_once');
  });

  it('automatically approves local multi-file edits and releases every lease', async () => {
    const h = await harness();
    const turn = h.sessions.send(h.a.id, '[EDIT]');
    await vi.waitFor(() => expect(h.sessions.state(h.a.id).tools.some((tool) => tool.status === 'in_progress')).toBe(true));
    const document = await h.files.read(h.a.id, 'main.md');
    await expect(h.files.save(h.a.id, 'main.md', '# Human draft', document.revision)).rejects.toMatchObject({ code: 'BUSY' });
    await turn;
    expect(h.sessions.state(h.a.id).approvals).toHaveLength(0);
    for (const file of ['main.md', 'second.md']) {
      const current = await h.files.read(h.a.id, file);
      expect(current.content).toContain('Agent changed');
      await expect(h.files.save(h.a.id, file, '# Human final', current.revision)).resolves.toMatchObject({ content: '# Human final' });
    }
  });

  it('surfaces missing CLI and unsupported restore capability', async () => {
    const h = await harness();
    controls.missing = true;
    await expect(h.sessions.send(h.a.id, 'hello')).rejects.toThrow();
    expect(h.sessions.state(h.a.id).activity).toBe('failed');
    controls.missing = false;
    controls.noLoad = true;
    await expect(h.sessions.send(h.b.id, 'hello')).rejects.toMatchObject({ code: 'CAPABILITY' });
  });

  it('settles a crashed subprocess rather than leaving the ticket working', async () => {
    const h = await harness();
    await expect(h.sessions.send(h.a.id, '[FAIL]')).rejects.toThrow();
    expect(h.sessions.state(h.a.id).activity).toBe('failed');
  });

  it('honors Stop while the ticket connection is still starting', async () => {
    const h = await harness();
    const turn = h.sessions.send(h.a.id, 'do-not-send');
    await h.sessions.stop(h.a.id);
    await turn;
    expect(h.sessions.state(h.a.id).activity).toBe('idle');
    expect(h.sessions.state(h.a.id).messages.some((message) => message.role === 'user')).toBe(false);
  });

  it('uses ticket-specific homes and never grants all permissions', () => {
    expect(CLI_ARGS).toContain('--no-custom-instructions');
    expect(CLI_ARGS).toContain('--disable-builtin-mcps');
    expect(CLI_ARGS).not.toContain('--allow-all');
    expect(cliEnvironment('C:\\synthetic\\ticket-home').COPILOT_HOME).toBe('C:\\synthetic\\ticket-home');
    expect(cliEnvironment('C:\\synthetic\\ticket-home').COPILOT_ALLOW_ALL).toBe('false');
  });

  it('prefers an explicit CLI path and otherwise names a launchable command', () => {
    const saved = process.env.COPILOT_CLI_PATH;
    try {
      process.env.COPILOT_CLI_PATH = 'C:\\custom\\copilot.exe';
      expect(cliCommand()).toBe('C:\\custom\\copilot.exe');
      delete process.env.COPILOT_CLI_PATH;
      const resolved = cliCommand();
      expect(resolved).not.toContain('.cmd');
      if (process.platform === 'win32' && existsSync(resolved)) expect(resolved.endsWith('.exe')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.COPILOT_CLI_PATH;
      else process.env.COPILOT_CLI_PATH = saved;
    }
  });

  it('discovers only sessions whose working directory is this ticket', async () => {
    const h = await harness();
    await h.sessions.send(h.a.id, 'alpha');
    await h.sessions.send(h.b.id, 'beta');
    const found = await h.sessions.discover(h.a.id);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBeTruthy();
  });

  it('returns no sessions when the CLI cannot list them', async () => {
    controls.noList = true;
    const h = await harness();
    await expect(h.sessions.discover(h.a.id)).resolves.toEqual([]);
  });

  it('reports a listing failure instead of failing the ticket', async () => {
    controls.listFail = true;
    const h = await harness();
    await expect(h.sessions.discover(h.a.id)).rejects.toMatchObject({ code: 'CLI' });
    expect(h.sessions.state(h.a.id).activity).toBe('idle');
  });

  it('attaches a discovered session and shows its transcript once', async () => {
    const h = await harness();
    await seedSession(h, 'external-1');
    const found = await h.sessions.discover(h.a.id);
    expect(found).toHaveLength(1);
    const before = h.sessions.state(h.a.id).conversations.length;
    await h.sessions.attach(h.a.id, 'external-1');
    expect(h.sessions.state(h.a.id).conversations).toHaveLength(before + 1);
    expect(h.sessions.state(h.a.id).messages.map((message) => message.text).join(' ')).toContain('replayed-marker');
    const replayed = h.sessions.state(h.a.id).messages.length;
    const markers = h.sessions.state(h.a.id).messages.filter((message) => message.text.includes('replayed-marker')).length;
    await h.sessions.send(h.a.id, 'after-attach');
    expect(h.sessions.state(h.a.id).messages.filter((message) => message.text.includes('replayed-marker'))).toHaveLength(markers);
    expect(h.sessions.state(h.a.id).messages).toHaveLength(replayed + 2);
  });

  it('rejects ids that were not discovered and sessions already attached', async () => {
    const h = await harness();
    await expect(h.sessions.attach(h.a.id, 'made-up')).rejects.toMatchObject({ code: 'SESSION' });
    await h.sessions.send(h.a.id, 'first');
    const [summary] = await h.sessions.discover(h.a.id);
    await expect(h.sessions.attach(h.a.id, summary.sessionId)).rejects.toMatchObject({ code: 'SESSION' });
  });

  it('rejects a corrupt conversation title in saved history', async () => {
    const h = await harness();
    await h.sessions.send(h.a.id, 'title-marker');
    await h.sessions.close();
    const historyFile = path.join(h.root, 'data', 'tickets', h.a.id, 'history.json');
    const stored = JSON.parse(await readFile(historyFile, 'utf8')) as { conversations: { title?: unknown }[] };
    stored.conversations[0].title = 5;
    await writeFile(historyFile, JSON.stringify(stored));
    const restored = new CopilotSessions(h.files, vi.fn());
    managers.push(restored);
    await expect(restored.initialize()).rejects.toMatchObject({ code: 'STATE' });
  });

  it('is busy-safe while another attach is starting', async () => {
    const h = await harness();
    seedSession(h, 'external-2');
    const turn = h.sessions.send(h.a.id, '[DELAY] busy');
    await vi.waitFor(() => expect(h.sessions.state(h.a.id).activity).toBe('running'));
    await expect(h.sessions.attach(h.a.id, 'anything')).rejects.toMatchObject({ code: 'BUSY' });
    await h.sessions.stop(h.a.id);
    await turn;
  });

  it('rolls back a failed attach', async () => {
    const h = await harness();
    seedSession(h, 'vanishing');
    const [summary] = await h.sessions.discover(h.a.id);
    const previous = h.sessions.state(h.a.id).currentId;
    const conversations = h.sessions.state(h.a.id).conversations.length;
    await rm(path.join(h.root, 'data', 'tickets', h.a.id, 'copilot', 'fake-sessions.json'), { force: true });
    await expect(h.sessions.attach(h.a.id, summary.sessionId)).rejects.toBeTruthy();
    expect(h.sessions.state(h.a.id).conversations).toHaveLength(conversations);
    expect(h.sessions.state(h.a.id).currentId).toBe(previous);
  });
});
