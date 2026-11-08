import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

const home = process.env.COPILOT_HOME;
if (!home) throw new Error('Synthetic ACP requires an isolated home.');
const storePath = path.join(home, 'fake-sessions.json');
const sessions = new Map();
const permissions = new Map();
const active = new Map();
const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const result = (id, value = {}) => write({ jsonrpc: '2.0', id, result: value });
const update = (sessionId, value) => write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
const chunk = (sessionId, text) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
async function persist() { await mkdir(home, { recursive: true }); await writeFile(storePath, JSON.stringify(Object.fromEntries(sessions))); }
try {
  for (const [id, session] of Object.entries(JSON.parse(await readFile(storePath, 'utf8')))) sessions.set(id, session);
} catch (error) { if (error.code !== 'ENOENT') throw error; }

function finish(sessionId, reason) {
  const turn = active.get(sessionId);
  if (!turn) return;
  clearTimeout(turn.timer);
  active.delete(sessionId);
  result(turn.requestId, { stopReason: reason });
}
function permission(sessionId, target, kind, toolId = randomUUID()) {
  const id = randomUUID();
  return new Promise((resolve) => {
    permissions.set(id, { sessionId, resolve });
    write({
      jsonrpc: '2.0', id, method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId: toolId, title: kind === 'edit' ? 'Update synthetic file' : 'Synthetic external operation', kind, locations: [{ path: target }], rawInput: { path: target, command: kind === 'execute' ? 'synthetic-only' : undefined } },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
  });
}
async function prompt(message) {
  const { sessionId } = message.params;
  const session = sessions.get(sessionId);
  if (!session) throw new Error('Unknown synthetic session');
  const text = message.params.prompt.filter((part) => part.type === 'text').map((part) => part.text).join('\n').split('\n\n').at(-1);
  const turn = { requestId: message.id, timer: undefined };
  active.set(sessionId, turn);
  if (text.includes('[FAIL]')) { process.stderr.write('Synthetic CLI failed\n'); process.exit(17); }
  let response = `FAKE ${session.cwd} ${text}`;
  if (text.includes('[EXTERNAL]')) {
    const decision = await permission(sessionId, path.join(home, 'external.txt'), 'execute');
    if (!active.has(sessionId)) return;
    response = `Permission ${decision.outcome}: ${decision.optionId ?? 'cancelled'}`;
  }
  if (text.includes('[EDIT]')) {
    const files = [path.join(session.cwd, 'main.md'), path.join(session.cwd, 'second.md')];
    const toolId = randomUUID();
    update(sessionId, { sessionUpdate: 'tool_call', toolCallId: toolId, title: 'Edit synthetic files', kind: 'edit', status: 'pending', locations: files.map((file) => ({ path: file })) });
    for (const file of files) {
      const decision = await permission(sessionId, file, 'edit', toolId);
      if (decision.outcome !== 'selected' || decision.optionId !== 'allow_once') throw new Error('Synthetic edit denied');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const file of files) await writeFile(file, '# Agent changed file\n');
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: toolId, status: 'completed' });
    response = 'EDITED';
  }
  session.history.push({ role: 'user', text }, { role: 'agent', text: response });
  session.updatedAt = new Date().toISOString();
  await persist();
  chunk(sessionId, response.slice(0, 5));
  chunk(sessionId, response.slice(5));
  if (text.includes('[DELAY]')) turn.timer = setTimeout(() => finish(sessionId, 'end_turn'), 5000);
  else finish(sessionId, 'end_turn');
}
async function handle(message) {
  if (!message.method && permissions.has(message.id)) {
    const pending = permissions.get(message.id);
    permissions.delete(message.id);
    pending.resolve(message.result.outcome);
    return;
  }
  if (message.method === 'session/cancel') {
    for (const [id, pending] of permissions) if (pending.sessionId === message.params.sessionId) {
      permissions.delete(id);
      pending.resolve({ outcome: 'cancelled' });
    }
    finish(message.params.sessionId, 'cancelled');
    return;
  }
  switch (message.method) {
    case 'initialize':
      result(message.id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: process.env.FAKE_CLI_NO_LOAD !== '1' },
        sessionCapabilities: process.env.FAKE_CLI_NO_LIST === '1' ? {} : { list: {} },
        authMethods: [],
      });
      break;
    case 'session/new': {
      const sessionId = randomUUID();
      sessions.set(sessionId, { cwd: message.params.cwd, history: [], title: 'Synthetic session', updatedAt: new Date().toISOString() });
      await persist();
      result(message.id, { sessionId });
      break;
    }
    case 'session/load': {
      const session = sessions.get(message.params.sessionId);
      if (!session) throw new Error('Stale synthetic session');
      for (const entry of session.history) {
        if (entry.role === 'user') update(message.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: entry.text } });
        else chunk(message.params.sessionId, entry.text);
      }
      result(message.id);
      break;
    }
    case 'session/list': {
      if (process.env.FAKE_CLI_LIST_FAIL === '1') throw new Error('Synthetic list failure');
      const sessionsPage = [...sessions.entries()]
        .filter(([, session]) => !message.params.cwd || session.cwd === message.params.cwd)
        .map(([sessionId, session]) => ({ sessionId, cwd: session.cwd, title: session.title, updatedAt: session.updatedAt }));
      result(message.id, { sessions: sessionsPage });
      break;
    }
    case 'session/prompt': await prompt(message); break;
    default: throw new Error(`Unknown method ${message.method}`);
  }
}
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  void handle(message).catch((error) => {
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error.message } });
  });
});
lines.on('close', () => process.exit(0));
