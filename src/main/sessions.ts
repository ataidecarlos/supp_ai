import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type { Approval, Conversation, SessionSummary, TicketSession, ToolActivity, WorkspaceEvent } from '../shared/types';
import { atomicJson, optionalJson, revision, TicketFiles, WorkspaceError } from './files';

interface PendingApproval {
  resolve: (response: acp.RequestPermissionResponse) => void;
  choices: Set<string>;
}

interface Runtime {
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  sessionId?: string;
  loading: boolean;
  stopping: boolean;
  canList?: boolean;
  capturing?: { bytes: number };
  agentMessage?: string;
  reads: Map<string, string>;
  leases: Map<string, () => void>;
  leasePaths: Map<string, Set<string>>;
  editQueue: Promise<void>;
  pending: Map<string, PendingApproval>;
  readPending: Promise<void>;
  cancelTimer?: ReturnType<typeof setTimeout>;
  cancelRequested: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// The capability is advertised top-level by the RFD and under agentCapabilities by the SDK types.
function canListSessions(response: acp.InitializeResponse): boolean {
  const agent = response.agentCapabilities as (acp.AgentCapabilities & { sessionCapabilities?: acp.SessionCapabilities }) | undefined;
  const top = response as acp.InitializeResponse & { sessionCapabilities?: acp.SessionCapabilities };
  return Boolean(agent?.sessionCapabilities?.list ?? top.sessionCapabilities?.list);
}

function conversation(value: unknown): value is Conversation {
  return record(value) && typeof value.id === 'string' && typeof value.createdAt === 'string' &&
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    (value.title === undefined || typeof value.title === 'string') && Array.isArray(value.messages) &&
    value.messages.every((message: unknown) => record(message) && typeof message.id === 'string' &&
      ['user', 'agent', 'notice'].includes(String(message.role)) && typeof message.text === 'string');
}

export function cliEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, COPILOT_HOME: home, COPILOT_ALLOW_ALL: 'false', COPILOT_AUTO_UPDATE: 'false' };
  delete env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS;
  // BYOK provider settings are the user's own configuration for the installed CLI.
  return env;
}

export const CLI_ARGS = [
  '--acp', '--stdio', '--disable-builtin-mcps', '--disallow-temp-dir',
  '--no-custom-instructions', '--no-auto-update', '--dynamic-retrieval', 'skills=off',
];

export function cliCommand(): string {
  const configured = process.env.COPILOT_CLI_PATH;
  if (configured) return configured;
  if (process.platform === 'win32') {
    // npm's copilot.cmd shim cannot be spawned directly; prefer the packaged executable.
    const packaged = process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@github', 'copilot', 'node_modules', '@github', `copilot-win32-${process.arch}`, 'copilot.exe');
    if (packaged && existsSync(packaged)) return packaged;
  }
  return 'copilot';
}

export class CopilotSessions {
  private states = new Map<string, TicketSession>();
  private runtimes = new Map<string, Runtime>();
  private discovered = new Map<string, SessionSummary[]>();
  private persistence = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private cancellations = new Set<string>();
  private files: TicketFiles;
  private emit: (event: WorkspaceEvent) => void;

  constructor(files: TicketFiles, emit: (event: WorkspaceEvent) => void) { this.files = files; this.emit = emit; }

  async initialize(): Promise<void> {
    this.states.clear();
    for (const ticket of this.files.tickets) {
      const stored = await optionalJson(this.historyPath(ticket.id));
      if (stored !== null && (!record(stored) || !Array.isArray(stored.conversations) ||
        !stored.conversations.every(conversation) || (stored.currentId !== null && typeof stored.currentId !== 'string'))) {
        throw new WorkspaceError('STATE', `Saved conversation state for ${ticket.name} is invalid. It has not been overwritten.`);
      }
      const histories: Conversation[] = stored !== null && record(stored) && Array.isArray(stored.conversations)
        ? stored.conversations.filter(conversation) : [];
      const currentId = stored !== null && record(stored) && typeof stored.currentId === 'string' ? stored.currentId : null;
      if (currentId && !histories.some((item) => item.id === currentId)) throw new WorkspaceError('STATE', `Missing saved conversation for ${ticket.name}.`);
      this.states.set(ticket.id, {
        ticketId: ticket.id, activity: 'idle', conversations: histories, currentId,
        messages: histories.find((item) => item.id === currentId)?.messages ?? [],
        tools: [], approvals: [], error: null,
      });
    }
  }

  all(): TicketSession[] { return [...this.states.values()].map((state) => structuredClone(state)); }
  active(): boolean { return this.all().some((state) => ['starting', 'running', 'approval'].includes(state.activity)); }

  state(id: string): TicketSession {
    this.files.ticket(id);
    const state = this.states.get(id);
    if (!state) throw new WorkspaceError('SESSION', 'Ticket sessions are not initialized.');
    return state;
  }

  private historyPath(id: string): string { return path.join(this.files.dataDir, 'tickets', id, 'history.json'); }
  private publish(id: string): void { this.emit({ type: 'session', state: structuredClone(this.state(id)) }); }

  private notice(id: string, text: string): void {
    this.state(id).messages.push({ id: randomUUID(), role: 'notice', text });
    this.publish(id);
    this.schedulePersist(id);
  }

  private persist(id: string): Promise<void> {
    const state = this.state(id);
    const snapshot = structuredClone({ conversations: state.conversations, currentId: state.currentId });
    const previous = this.persistence.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => atomicJson(this.historyPath(id), snapshot));
    this.persistence.set(id, next);
    return next;
  }

  private schedulePersist(id: string): void {
    if (this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      void this.persist(id).catch((error: unknown) => {
        this.state(id).error = `Conversation saving failed: ${error instanceof Error ? error.message : String(error)}`;
        this.publish(id);
      });
    }, 250));
  }

  private createConversation(id: string): Conversation {
    const state = this.state(id);
    const current: Conversation = { id: randomUUID(), createdAt: new Date().toISOString(), messages: [] };
    state.conversations.push(current);
    state.currentId = current.id;
    state.messages = current.messages;
    state.tools = [];
    state.error = null;
    return current;
  }

  async newConversation(id: string): Promise<void> {
    const state = this.state(id);
    if (['starting', 'running', 'approval'].includes(state.activity)) throw new WorkspaceError('BUSY', 'Stop the active turn before starting a new conversation.');
    await this.destroy(id);
    this.createConversation(id);
    state.activity = 'idle';
    await this.persist(id);
    this.publish(id);
  }

  async selectConversation(id: string, conversationId: string): Promise<void> {
    const state = this.state(id);
    if (['starting', 'running', 'approval'].includes(state.activity)) throw new WorkspaceError('BUSY', 'Stop the active turn before changing conversations.');
    const selected = state.conversations.find((item) => item.id === conversationId);
    if (!selected) throw new WorkspaceError('SESSION', 'Unknown conversation.');
    await this.destroy(id);
    state.currentId = selected.id;
    state.messages = selected.messages;
    state.tools = [];
    state.error = null;
    state.activity = 'idle';
    await this.persist(id);
    this.publish(id);
  }

  async discover(id: string): Promise<SessionSummary[]> {
    const ticket = this.files.ticket(id);
    const runtime = this.runtimes.get(id);
    try {
      const found = runtime?.sessionId
        ? (runtime.canList ? await this.listing(runtime.connection, ticket.root) : [])
        : await this.probe(id, ticket.root);
      this.discovered.set(id, found);
      return found;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError('CLI', `Cannot list Copilot sessions: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async listing(connection: acp.ClientConnection, cwd: string): Promise<SessionSummary[]> {
    const found: SessionSummary[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const response = await connection.agent.request('session/list', cursor ? { cwd, cursor } : { cwd });
      for (const info of response.sessions) {
        if (!samePath(info.cwd, cwd)) continue;
        found.push({ sessionId: info.sessionId, title: info.title ?? null, updatedAt: info.updatedAt ?? null });
      }
      cursor = response.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return found.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  private async probe(id: string, cwd: string): Promise<SessionSummary[]> {
    const home = path.join(this.files.dataDir, 'tickets', id, 'copilot');
    await mkdir(home, { recursive: true });
    const child = spawn(cliCommand(), CLI_ARGS, {
      cwd, env: cliEnvironment(home), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const connection = new acp.ClientApp().connect(acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      { maxMessageBytes: 8 * 1024 * 1024 },
    ));
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-1000); });
    const failure = new Promise<never>((_resolve, reject) => {
      child.on('error', (error) => reject(new WorkspaceError('CLI', `Cannot start GitHub Copilot CLI: ${error.message}. Install it and run copilot login.`)));
      child.on('exit', (code) => reject(new WorkspaceError('CLI', `Copilot CLI exited (${code ?? 'unknown'}) while listing sessions. ${stderr}`)));
    });
    failure.catch(() => undefined);
    try {
      const initialized = await Promise.race([connection.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'support-workspace', version: '0.1.0' },
      }), failure]);
      if (!canListSessions(initialized)) return [];
      return await Promise.race([this.listing(connection, cwd), failure]);
    } finally {
      connection.close();
      child.stdin.end();
      child.kill();
    }
  }

  async attach(id: string, sessionId: string): Promise<void> {
    const state = this.state(id);
    if (['starting', 'running', 'approval'].includes(state.activity)) throw new WorkspaceError('BUSY', 'Stop the active turn before attaching a session.');
    const summary = this.discovered.get(id)?.find((item) => item.sessionId === sessionId);
    if (!summary) throw new WorkspaceError('SESSION', 'Find this ticket\'s Copilot sessions again before attaching.');
    if (state.conversations.some((item) => item.sessionId === sessionId)) throw new WorkspaceError('SESSION', 'That session is already attached to this ticket.');
    const previous = { currentId: state.currentId, messages: state.messages, tools: state.tools, error: state.error };
    state.activity = 'starting';
    this.publish(id);
    await this.destroy(id);
    const current: Conversation = {
      id: randomUUID(), createdAt: summary.updatedAt ?? new Date().toISOString(),
      title: summary.title ?? undefined, sessionId, messages: [],
    };
    state.conversations.push(current);
    state.currentId = current.id;
    state.messages = current.messages;
    state.tools = [];
    state.error = null;
    this.publish(id);
    try {
      await this.connect(id, current);
      state.activity = 'idle';
      await this.persist(id);
      this.publish(id);
    } catch (error) {
      state.conversations = state.conversations.filter((item) => item.id !== current.id);
      state.currentId = previous.currentId;
      state.messages = previous.messages;
      state.tools = previous.tools;
      state.error = previous.error;
      state.activity = 'idle';
      await this.persist(id);
      this.publish(id);
      throw error;
    }
  }

  private capture(id: string, runtime: Runtime, update: acp.SessionNotification['update']): void {
    if (update.sessionUpdate !== 'agent_message_chunk' && update.sessionUpdate !== 'user_message_chunk') return;
    if (update.content.type !== 'text' || !update.content.text) return;
    const capturing = runtime.capturing!;
    const state = this.state(id);
    const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'agent';
    const last = state.messages.at(-1);
    if (last?.role === role) last.text += update.content.text;
    else state.messages.push({ id: randomUUID(), role, text: update.content.text });
    capturing.bytes += Buffer.byteLength(update.content.text);
    if (capturing.bytes > 1024 * 1024) {
      runtime.capturing = undefined;
      this.notice(id, 'The attached session transcript was truncated at 1 MiB.');
    } else this.schedulePersist(id);
    this.publish(id);
  }

  private async connect(id: string, current: Conversation): Promise<Runtime> {
    const existing = this.runtimes.get(id);
    if (existing?.sessionId) return existing;
    const ticket = this.files.ticket(id);
    const home = path.join(this.files.dataDir, 'tickets', id, 'copilot');
    await mkdir(home, { recursive: true });
    const child = spawn(cliCommand(), CLI_ARGS, {
      cwd: ticket.root, env: cliEnvironment(home), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    const client = new acp.ClientApp()
      .onRequest('session/request_permission', (context) => this.permission(id, context.params))
      .onNotification('session/update', (context) => this.update(id, context.params));
    const connection = client.connect(acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      { maxMessageBytes: 8 * 1024 * 1024 },
    ));
    const runtime: Runtime = {
      child, connection, loading: false, stopping: false,
      reads: new Map(), leases: new Map(), leasePaths: new Map(), editQueue: Promise.resolve(),
      pending: new Map(), readPending: Promise.resolve(), cancelRequested: false,
    };
    this.runtimes.set(id, runtime);
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-3000); });
    child.on('error', (error) => connection.close(new WorkspaceError('CLI', `Cannot start GitHub Copilot CLI: ${error.message}. Install it and run copilot login.`)));
    child.on('exit', (code) => {
      if (runtime.cancelTimer) clearTimeout(runtime.cancelTimer);
      connection.close(new WorkspaceError('CLI', `Copilot CLI exited (${code ?? 'unknown'}). ${stderr}`));
      for (const release of runtime.leases.values()) release();
      runtime.leases.clear();
      runtime.leasePaths.clear();
      for (const approval of runtime.pending.values()) approval.resolve({ outcome: { outcome: 'cancelled' } });
      runtime.pending.clear();
      if (this.runtimes.get(id) === runtime && !runtime.stopping) {
        const state = this.state(id);
        state.activity = 'failed';
        state.error = `Copilot CLI exited unexpectedly (${code ?? 'unknown'}). ${stderr || 'Check CLI installation and authentication.'}`;
        state.approvals = [];
        this.runtimes.delete(id);
        this.publish(id);
      }
    });
    const timeout = setTimeout(() => {
      connection.close(new WorkspaceError('TIMEOUT', 'Copilot did not initialize within 60 seconds.'));
      child.kill();
    }, 60_000);
    try {
      const initialized = await connection.agent.request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: 'support-workspace', version: '0.1.0' },
      });
      if (!initialized.agentCapabilities?.loadSession) throw new WorkspaceError('CAPABILITY', 'This Copilot CLI cannot restore ACP sessions. Update the CLI before using this app.');
      runtime.canList = canListSessions(initialized);
      if (current.sessionId) {
        runtime.loading = true;
        runtime.sessionId = current.sessionId;
        // A conversation with no transcript is a fresh attach: capture the replay.
        runtime.capturing = current.messages.length ? undefined : { bytes: 0 };
        await connection.agent.request('session/load', { sessionId: current.sessionId, cwd: ticket.root, mcpServers: [] });
        runtime.loading = false;
        runtime.capturing = undefined;
        runtime.agentMessage = undefined;
      } else {
        const session = await connection.agent.request('session/new', { cwd: ticket.root, mcpServers: [] });
        current.sessionId = session.sessionId;
        runtime.sessionId = session.sessionId;
      }
      await this.persist(id);
      return runtime;
    } catch (error) {
      await this.destroy(id);
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async send(id: string, text: string): Promise<void> {
    const state = this.state(id);
    if (!text.trim() || text.length > 100_000) throw new WorkspaceError('PROMPT', 'Enter a message of at most 100,000 characters.');
    if (['starting', 'running', 'approval'].includes(state.activity)) throw new WorkspaceError('BUSY', 'This ticket already has an active turn.');
    state.activity = 'starting';
    this.cancellations.delete(id);
    state.error = null;
    state.tools = [];
    const current = state.conversations.find((item) => item.id === state.currentId) ?? this.createConversation(id);
    this.files.watch(id);
    this.publish(id);
    let activeRuntime: Runtime | undefined;
    try {
      const runtime = await this.connect(id, current);
      activeRuntime = runtime;
      if (runtime.stopping || this.cancellations.has(id)) {
        await this.destroy(id);
        state.activity = 'idle';
        this.publish(id);
        return;
      }
      current.messages.push({ id: randomUUID(), role: 'user', text });
      await this.persist(id);
      runtime.agentMessage = undefined;
      runtime.reads.clear();
      runtime.cancelRequested = false;
      state.activity = 'running';
      this.publish(id);
      const result = await runtime.connection.agent.request('session/prompt', {
        sessionId: runtime.sessionId!,
        prompt: [{ type: 'text', text: `Support ticket workspace: ${this.files.ticket(id).root}\nMain summary: ${this.files.ticket(id).mainFile ?? 'Select the ticket summary explicitly.'}\nUse only this ticket's evidence unless an external operation is explicitly approved. Keep findings grounded in the files. Reread files before editing if they may have changed. Do not access other support tickets automatically.\n\n${text}` }],
      });
      state.activity = result.stopReason === 'cancelled' ? 'idle' : 'completed';
      if (result.stopReason !== 'end_turn' && result.stopReason !== 'cancelled') this.notice(id, `Copilot stopped: ${result.stopReason}`);
      await this.persist(id);
      this.publish(id);
    } catch (error) {
      if (this.cancellations.has(id) || activeRuntime?.cancelRequested || activeRuntime?.stopping) {
        state.activity = 'idle';
        state.error = null;
        this.publish(id);
        return;
      }
      state.activity = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      this.publish(id);
      await this.destroy(id);
      throw error;
    } finally {
      const runtime = this.runtimes.get(id);
      if (runtime) {
        if (runtime.cancelTimer) { clearTimeout(runtime.cancelTimer); runtime.cancelTimer = undefined; }
        for (const release of runtime.leases.values()) release();
        runtime.leases.clear();
        runtime.leasePaths.clear();
      }
      for (const tool of state.tools) if (tool.status === 'pending' || tool.status === 'in_progress') tool.status = 'interrupted';
      this.publish(id);
    }
  }

  private update(id: string, params: acp.SessionNotification): void {
    const runtime = this.runtimes.get(id);
    if (!runtime || (runtime.sessionId && params.sessionId !== runtime.sessionId)) return;
    if (runtime.loading) {
      if (runtime.capturing) this.capture(id, runtime, params.update);
      return;
    }
    const state = this.state(id);
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      let message = state.messages.find((item) => item.id === runtime.agentMessage);
      if (!message) {
        message = { id: randomUUID(), role: 'agent', text: '' };
        runtime.agentMessage = message.id;
        state.messages.push(message);
      }
      message.text += update.content.text;
      this.schedulePersist(id);
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      const previous = state.tools.find((tool) => tool.id === update.toolCallId);
      const tool: ToolActivity = {
        id: update.toolCallId, title: update.title ?? previous?.title ?? 'Copilot operation',
        kind: update.kind ?? previous?.kind ?? 'other',
        status: update.status ?? previous?.status ?? 'pending',
        paths: update.locations?.map((location) => location.path) ?? previous?.paths ?? [],
      };
      if (previous) Object.assign(previous, tool); else state.tools.push(tool);
      if (tool.status === 'completed' || tool.status === 'failed') {
        runtime.leases.get(tool.id)?.();
        runtime.leases.delete(tool.id);
        runtime.leasePaths.delete(tool.id);
        if (tool.kind === 'read' && tool.status === 'completed') {
          for (const file of tool.paths) {
            runtime.readPending = runtime.readPending.then(() => this.files.localAgentPath(id, file)).then(async (target) => {
              runtime.reads.set(target, revision(await readFile(target)));
            }).catch((error: unknown) => {
              if (error instanceof WorkspaceError && error.code === 'PATH') return;
              this.notice(id, `Cannot track read revision for ${file}: ${error instanceof Error ? error.message : String(error)}`);
            });
          }
        }
      }
    }
    this.publish(id);
  }

  private async permission(id: string, params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const runtime = this.runtimes.get(id);
    if (!runtime || runtime.stopping || (runtime.sessionId && params.sessionId !== runtime.sessionId)) return { outcome: { outcome: 'cancelled' } };
    await runtime.readPending;
    const paths = params.toolCall.locations?.map((location) => location.path) ?? [];
    const allowOnce = params.options.find((option) => option.kind === 'allow_once');
    if (allowOnce && paths.length && (params.toolCall.kind === 'edit' || params.toolCall.kind === 'read')) {
      let local = true;
      for (const target of paths) {
        try { await this.files.localAgentPath(id, target); }
        catch (error) {
          if (error instanceof WorkspaceError && error.code === 'PATH') local = false;
          else if (error instanceof Error && 'code' in error && error.code === 'ENOENT') local = false;
          else throw error;
        }
      }
      if (local) {
        if (params.toolCall.kind === 'edit') {
          try {
            const task = runtime.editQueue.then(async () => {
              const toolId = params.toolCall.toolCallId;
              const held = runtime.leasePaths.get(toolId) ?? new Set<string>();
              const canonical = await Promise.all(paths.map((target) => this.files.localAgentPath(id, target)));
              const added = canonical.filter((target) => !held.has(target));
              if (added.length) {
                const release = await this.files.beginAgentEdit(id, added, runtime.reads);
                const previous = runtime.leases.get(toolId);
                runtime.leases.set(toolId, () => { release(); previous?.(); });
                for (const target of added) held.add(target);
                runtime.leasePaths.set(toolId, held);
              }
            });
            runtime.editQueue = task.catch(() => undefined);
            await task;
          } catch (error) {
            this.notice(id, `Automatic edit blocked: ${error instanceof Error ? error.message : String(error)}`);
            return { outcome: { outcome: 'cancelled' } };
          }
          this.upsertPermissionTool(id, params);
        }
        return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
      }
    }
    const approval: Approval = {
      id: randomUUID(),
      title: params.toolCall.title ?? 'External or unclassified operation',
      detail: typeof params.toolCall.rawInput === 'string' ? params.toolCall.rawInput : JSON.stringify(params.toolCall.rawInput ?? {}, null, 2),
      paths,
      options: params.options.filter((option) => option.kind === 'allow_once' || option.kind === 'reject_once')
        .map((option) => ({ id: option.optionId, name: option.name })),
    };
    if (!approval.options.length) {
      this.notice(id, 'Copilot requested a permission without a one-time choice. It was denied; broad grants are not supported.');
      return { outcome: { outcome: 'cancelled' } };
    }
    this.state(id).approvals.push(approval);
    this.state(id).activity = 'approval';
    this.publish(id);
    return new Promise((resolve) => runtime.pending.set(approval.id, { resolve, choices: new Set(approval.options.map((option) => option.id)) }));
  }

  private upsertPermissionTool(id: string, params: acp.RequestPermissionRequest): void {
    const state = this.state(id);
    const existing = state.tools.find((tool) => tool.id === params.toolCall.toolCallId);
    const tool: ToolActivity = {
      id: params.toolCall.toolCallId, title: params.toolCall.title ?? 'Editing file',
      kind: 'edit', status: 'in_progress', paths: params.toolCall.locations?.map((location) => location.path) ?? [],
    };
    if (existing) Object.assign(existing, tool); else state.tools.push(tool);
    this.publish(id);
  }

  async approve(id: string, approvalId: string, optionId: string | null): Promise<void> {
    const runtime = this.runtimes.get(id);
    const pending = runtime?.pending.get(approvalId);
    if (!pending) throw new WorkspaceError('APPROVAL', 'This permission request is no longer active.');
    if (optionId !== null && !pending.choices.has(optionId)) throw new WorkspaceError('APPROVAL', 'Invalid permission choice.');
    runtime!.pending.delete(approvalId);
    this.state(id).approvals = this.state(id).approvals.filter((item) => item.id !== approvalId);
    this.state(id).activity = this.state(id).approvals.length ? 'approval' : 'running';
    pending.resolve({ outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } });
    this.publish(id);
  }

  async stop(id: string): Promise<void> {
    this.state(id);
    this.cancellations.add(id);
    const runtime = this.runtimes.get(id);
    if (!runtime) { this.notice(id, 'Stop requested.'); return; }
    runtime.cancelRequested = true;
    for (const pending of runtime.pending.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
    runtime.pending.clear();
    this.state(id).approvals = [];
    if (runtime.sessionId) await runtime.connection.agent.notify('session/cancel', { sessionId: runtime.sessionId });
    else { await this.destroy(id); this.state(id).activity = 'idle'; }
    if (runtime.sessionId) runtime.cancelTimer = setTimeout(() => {
      void this.destroy(id).then(() => {
        this.state(id).activity = 'idle';
        this.notice(id, 'Copilot did not stop cooperatively; its ticket process was terminated.');
      }).catch((error: unknown) => { this.state(id).error = String(error); this.publish(id); });
    }, 10_000);
    this.notice(id, 'Stop requested. Operations already completed are not undone.');
  }

  async destroy(id: string): Promise<void> {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    runtime.stopping = true;
    this.runtimes.delete(id);
    for (const pending of runtime.pending.values()) pending.resolve({ outcome: { outcome: 'cancelled' } });
    runtime.connection.close();
    runtime.child.stdin.end();
    const exited = new Promise<void>((resolve) => {
      if (!runtime.child.pid || runtime.child.exitCode !== null || runtime.child.signalCode !== null) resolve();
      else runtime.child.once('exit', () => resolve());
      runtime.child.once('error', () => resolve());
    });
    runtime.child.kill();
    await exited;
    for (const release of runtime.leases.values()) release();
    runtime.leases.clear();
    runtime.leasePaths.clear();
    this.state(id).approvals = [];
  }

  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.all([...this.runtimes.keys()].map((id) => this.destroy(id)));
    await Promise.all([...this.states.keys()].map((id) => this.persist(id)));
  }
}
