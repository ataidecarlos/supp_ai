# Workspace Layout and Session Attach Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the ticket sidebar into a code-editor shell — header with ticket picker and tabs, Home screen, configurable chat/document/files layout, and Copilot session discovery with attach.

**Architecture:** Main process owns a new config module (`~/.suppai/config.json`), extends `CopilotSessions` with ACP `session/list` discovery and `session/load` attach, and exposes both plus `lastTicketId` through the existing IPC/preload layer. The renderer is restructured into header + Home or editor shell; the files rail becomes its own component and the old sidebar is deleted.

**Tech Stack:** Electron 45, React 19, TypeScript 7, Tiptap 3, Vitest 4, Playwright Electron smoke test, ACP TypeScript SDK.

**Spec:** `docs/superpowers/specs/2026-11-08-workspace-layout-design.md`

## Global Constraints

- All AI output comes from the installed GitHub Copilot CLI over ACP. No alternate provider, no mock responses, no generated placeholders.
- Each ticket keeps its own process and `COPILOT_HOME` (`<dataDir>/tickets/<id>/copilot`); no shared or global Copilot home.
- External/unclassified operations always require explicit per-ticket approval; in-ticket local edits stay auto-approved through the existing lease logic.
- No new runtime dependencies. Node 24, Electron 45, React 19, Tiptap 3, Vitest 4.
- Windows-first: build paths with `path.*`, compare case-insensitively where the existing code does.
- Existing limits stay: 2 MiB Markdown edit, 10 MiB image, 5,000 files per ticket, 100,000-character prompt.
- Config lives at `~/.suppai/config.json` (`SUPPORT_CONFIG_DIR` overrides the directory for tests). App state stays in `userData`.
- Unknown config keys are preserved on write. A malformed config is reported and never overwritten.

## Review Focus

- Unsaved document content must survive every view change: tab switch, tab close, Home, tickets-root change, and app exit.
- A background ticket that needs approval must stay visible without opening its tab.
- A session belonging to another ticket or working directory must never be attachable.
- A hand-edited config with a typo must not be silently reset, and unknown keys must survive toggles.
- A failed attach or discovery must not leave a phantom conversation, a stuck activity state, or duplicated transcript.

---

### Task 0: Baseline

**Files:** none

- [ ] **Step 1: Install dependencies**

Run: `npm install`
Expected: completes without errors.

- [ ] **Step 2: Record the baseline**

Run: `npm run typecheck`, `npm test`, `copilot --version`
Expected: typecheck clean, all Vitest suites pass, CLI prints a version. If `copilot` is missing, stop and report — attach cannot be verified without it.

---

### Task 1: Config file module

**Files:**
- Create: `src/shared/config.ts`
- Create: `src/main/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: `WorkspaceError`, `optionalJson`, `atomicJson` from `src/main/files.ts`.
- Produces: `Config`, `DEFAULT_CONFIG` (shared); `configPath()`, `parseConfig(value)`, `readConfig()`, `writeConfig(patch)` (main).

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'supp-config-'));
  process.env.SUPPORT_CONFIG_DIR = directory;
});
afterEach(async () => {
  delete process.env.SUPPORT_CONFIG_DIR;
  await rm(directory, { recursive: true, force: true });
});
const { configPath, readConfig, writeConfig } = await import('../src/main/config');
const file = () => path.join(directory, 'config.json');

describe('workspace config', () => {
  it('returns defaults when the file is absent', async () => {
    await expect(readConfig()).resolves.toEqual({
      config: { chatSide: 'left', filesSide: 'right', filesHidden: false }, error: null,
    });
  });

  it('merges partial values with defaults', async () => {
    await writeFile(file(), JSON.stringify({ chatSide: 'right' }));
    const result = await readConfig();
    expect(result.config).toEqual({ chatSide: 'right', filesSide: 'right', filesHidden: false });
    expect(result.error).toBeNull();
  });

  it('reports an unknown value, keeps defaults and leaves the file untouched', async () => {
    const raw = JSON.stringify({ chatSide: 'middle' });
    await writeFile(file(), raw);
    const result = await readConfig();
    expect(result.config).toEqual({ chatSide: 'left', filesSide: 'right', filesHidden: false });
    expect(result.error).toContain(configPath());
    expect(await readFile(file(), 'utf8')).toBe(raw);
  });

  it('reports malformed JSON the same way', async () => {
    await writeFile(file(), '{ nope');
    const result = await readConfig();
    expect(result.error).toContain(configPath());
    expect(await readFile(file(), 'utf8')).toBe('{ nope');
  });

  it('writes all keys and preserves unknown keys', async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(file(), JSON.stringify({ chatSide: 'right', future: { keep: true } }));
    await writeConfig({ filesHidden: true });
    expect(JSON.parse(await readFile(file(), 'utf8'))).toEqual({
      chatSide: 'right', filesSide: 'right', filesHidden: true, future: { keep: true },
    });
    await expect(readConfig()).resolves.toMatchObject({ config: { filesHidden: true }, error: null });
  });

  it('refuses to write over a malformed file', async () => {
    await writeFile(file(), '{ nope');
    await expect(writeConfig({ chatSide: 'right' })).rejects.toMatchObject({ code: 'STATE' });
    expect(await readFile(file(), 'utf8')).toBe('{ nope');
  });

  it('creates the directory on first write', async () => {
    const nested = path.join(directory, 'nested');
    process.env.SUPPORT_CONFIG_DIR = nested;
    await expect(writeConfig({ chatSide: 'right' })).resolves.toMatchObject({ chatSide: 'right' });
    expect(JSON.parse(await readFile(path.join(nested, 'config.json'), 'utf8')).chatSide).toBe('right');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/main/config`.

- [ ] **Step 3: Implement the module**

`src/shared/config.ts`:

```ts
export interface Config { chatSide: 'left' | 'right'; filesSide: 'left' | 'right'; filesHidden: boolean }
export const DEFAULT_CONFIG: Config = { chatSide: 'left', filesSide: 'right', filesHidden: false };
```

`src/main/config.ts` exports:

```ts
export function configPath(): string            // path.join(process.env.SUPPORT_CONFIG_DIR ?? path.join(os.homedir(), '.suppai'), 'config.json')
export function parseConfig(value: unknown): Config   // throws WorkspaceError('STATE', `Choose "left" or "right" for ... in ${configPath()}.`) on a known key with a wrong value; ignores unknown keys
export async function readConfig(): Promise<{ config: Config; error: string | null }>  // never throws for file problems
export async function writeConfig(patch: Partial<Config>): Promise<Config>
```

Implementation notes: `readConfig` reads through `optionalJson` and, on any `WorkspaceError`, returns `{ config: { ...DEFAULT_CONFIG }, error: message }`. It must also treat a non-object value as an error. `writeConfig` reads the raw file itself (so it can merge), throws `STATE` when it cannot parse, then writes `{ ...raw, ...patch }` via `atomicJson` after validating the merged result with `parseConfig`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/config.ts src/main/config.ts tests/config.test.ts
git commit -m "Add the workspace config file"
```

---

### Task 2: Session discovery and attach

**Files:**
- Modify: `src/shared/types.ts` (add `SessionSummary`, `Conversation.title?`)
- Modify: `src/main/sessions.ts`
- Modify: `tests/fixtures/fake-cli.mjs`
- Modify: `tests/sessions.test.ts`

**Interfaces:**
- Consumes: existing `Runtime`, `connect`, `destroy`, `persist`, `publish`, `notice`.
- Produces: `CopilotSessions.discover(ticketId): Promise<SessionSummary[]>`, `CopilotSessions.attach(ticketId, sessionId): Promise<void>`, `SessionSummary { sessionId: string; title: string | null; updatedAt: string | null }`.

- [ ] **Step 1: Extend the fake CLI**

In `tests/fixtures/fake-cli.mjs`: store `title` and `updatedAt` on `session/new`; bump `updatedAt` in `prompt`; reply to `session/load` with a `user_message_chunk` for each stored user entry before the agent chunks; advertise `sessionCapabilities: { list: {} }` from `initialize` unless `process.env.FAKE_CLI_NO_LIST === '1'`; answer:

```js
case 'session/list': {
  if (process.env.FAKE_CLI_LIST_FAIL === '1') throw new Error('Synthetic list failure');
  const filtered = [...sessions.entries()]
    .filter(([, session]) => !message.params.cwd || session.cwd === message.params.cwd)
    .map(([sessionId, session]) => ({ sessionId, cwd: session.cwd, title: session.title, updatedAt: session.updatedAt }));
  result(message.id, { sessions: filtered });
  break;
}
```

Also extend the `vi.mock` controls in `tests/sessions.test.ts` with `noList` and `listFail`, passing `FAKE_CLI_NO_LIST` / `FAKE_CLI_LIST_FAIL`, and reset them in `afterEach`.

- [ ] **Step 2: Write the failing tests**

Add to `tests/sessions.test.ts` (same `harness()` helpers):

```ts
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
  await h.sessions.send(h.a.id, 'attach-marker');
  const [summary] = await h.sessions.discover(h.a.id);
  const before = h.sessions.state(h.a.id).conversations.length;
  await h.sessions.attach(h.a.id, summary.sessionId);
  expect(h.sessions.state(h.a.id).conversations).toHaveLength(before + 1);
  expect(h.sessions.state(h.a.id).messages.map((m) => m.text).join(' ')).toContain('attach-marker');
  await h.sessions.send(h.a.id, 'after-attach');
  expect(h.sessions.state(h.a.id).messages.filter((m) => m.text.includes('attach-marker'))).toHaveLength(1);
});

it('rejects ids that were not discovered and is busy-safe', async () => {
  const h = await harness();
  await expect(h.sessions.attach(h.a.id, 'made-up')).rejects.toMatchObject({ code: 'SESSION' });
  const turn = h.sessions.send(h.a.id, '[DELAY] busy');
  await vi.waitFor(() => expect(h.sessions.state(h.a.id).activity).toBe('running'));
  await expect(h.sessions.attach(h.a.id, 'anything')).rejects.toMatchObject({ code: 'BUSY' });
  await h.sessions.stop(h.a.id);
  await turn;
});

it('rolls back a failed attach', async () => {
  const h = await harness();
  await h.sessions.send(h.a.id, 'keeper');
  const [summary] = await h.sessions.discover(h.a.id);
  const previous = h.sessions.state(h.a.id).currentId;
  const conversations = h.sessions.state(h.a.id).conversations.length;
  await h.sessions.destroy(h.a.id);
  // Remove the CLI-side store so the fresh process cannot load the session.
  await rm(path.join(h.root, 'data', 'tickets', h.a.id, 'copilot', 'fake-sessions.json'), { force: true });
  await expect(h.sessions.attach(h.a.id, summary.sessionId)).rejects.toBeTruthy();
  expect(h.sessions.state(h.a.id).conversations).toHaveLength(conversations);
  expect(h.sessions.state(h.a.id).currentId).toBe(previous);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/sessions.test.ts`
Expected: FAIL — `discover`/`attach` are not functions.

- [ ] **Step 4: Implement discovery, attach and replay capture**

In `src/main/sessions.ts`:

- Add `canList?: boolean` and `capturing?: { bytes: number }` to `Runtime`; add `private discovered = new Map<string, SessionSummary[]>()`.
- In `connect`, after `initialize`, set `runtime.canList = Boolean((initialized as { sessionCapabilities?: { list?: unknown } }).sessionCapabilities?.list)` — the ACP field is `sessionCapabilities.list`; if the SDK's typed response exposes it differently, use the typed field, not a cast. Keep the existing `loadSession` check.
- `connect` sets `runtime.capturing = current.sessionId && current.messages.length === 0 ? { bytes: 0 } : undefined` before `session/load`.
- `discover(id)`: read the ticket, call `session/list` on the live runtime when it exists, otherwise spawn a temporary CLI with the same `CLI_ARGS`/`cliEnvironment(copilotHome(id))`, initialize, call, then kill the temporary process in `finally`. Request `{ cwd: ticket.root }`, follow `nextCursor` at most three pages, keep only `cwd` equal to `ticket.root`, map to `SessionSummary`, sort newest first, cache in `this.discovered`, and return. Absent `canList` returns `[]`. Any connection or RPC failure becomes `new WorkspaceError('CLI', message)` and must not touch ticket state. The temporary process needs both `error` and `exit` handlers that reject the pending discovery — a missing `copilot` emits ENOENT on `error`, and an unhandled `error` event would crash the main process.
- `attach(id, sessionId)`: `BUSY` when the activity is starting/running/approval; `SESSION` when the id is not in `this.discovered.get(id)`; `destroy` any live runtime; remember `previousId`/`previousMessages`; push and select a conversation `{ id: randomUUID(), createdAt: summary.updatedAt ?? new Date().toISOString(), title: summary.title ?? undefined, sessionId, messages: [] }`; then `await this.connect(id, conversation)`; persist and publish. On error, remove that conversation, restore `currentId` and `messages`, persist, and rethrow.
- In `update`, when `runtime.capturing` is set, accept `agent_message_chunk` and `user_message_chunk` with text content while `runtime.loading` is true: append to the last matching-role message or push a new one, add to `capturing.bytes`. At 1 MiB, clear `capturing`, stop capturing and call `notice(id, 'The attached session transcript was truncated at 1 MiB.')` once. Capture applies only while `loading`; a live turn is unaffected.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/sessions.test.ts`
Expected: PASS, all previous plus 6 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/sessions.ts tests/fixtures/fake-cli.mjs tests/sessions.test.ts
git commit -m "Discover and attach existing Copilot sessions"
```

---

### Task 3: Config, last-ticket and session IPC

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: Task 1 `readConfig`/`writeConfig`/`configPath`, Task 2 `discover`/`attach`.
- Produces: `WorkspaceSnapshot.config`, `.configError`, `.lastTicketId`; `WorkspaceApi.setConfig(patch)`, `.setLastTicket(id | null)`, `.discover(id)`, `.attach(id, sessionId)`.

- [ ] **Step 1: Extend the shared API**

In `src/shared/types.ts`: re-export `Config` from `../shared/config`; add `config: Config; configError: string | null; lastTicketId: string | null` to `WorkspaceSnapshot`; add `SessionSummary`; add `title?: string` to `Conversation`; add the four methods above to `WorkspaceApi`.

- [ ] **Step 2: Verify the renderer still typechecks against the wider API**

Run: `npm run typecheck`
Expected: PASS (additions are backward compatible).

- [ ] **Step 3: Wire main and preload**

In `src/main/index.ts`: module-level `let config = DEFAULT_CONFIG; let configError: string | null = null; let lastTicketId: string | null = null;`. At startup `const loaded = await readConfig()` and assign both. Extend the `settings.json` read/write to carry `lastTicketId` (validate it is a string or null). Extend `snapshot()` with the three fields. In `choose-root`, set `lastTicketId = null` before writing settings. Add handlers:

```ts
handle('config', (patch) => writeConfig(patch as Partial<Config>).then((value) => { config = value; configError = null; return value; }));
handle('last-ticket', async (id) => { lastTicketId = id === null ? null : text(id, 100); await atomicJson(settingsPath, { root: files.root, lastTicketId }); });
handle('discover', (id) => sessions.discover(text(id, 100)));
handle('attach', (id, sessionId) => sessions.attach(text(id, 100), text(sessionId, 200)));
```

Reject a `patch` that is not a plain object with an `INPUT` error. Mirror all four in `src/preload/index.ts`.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `npm test` and `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/main/index.ts src/preload/index.ts
git commit -m "Expose config, last ticket and session attach over IPC"
```

---

### Task 4: Editor shell, Home and ticket tabs

**Files:**
- Rewrite: `src/renderer/App.tsx`
- Create: `src/renderer/Home.tsx`
- Create: `src/renderer/FilesRail.tsx`
- Modify: `src/renderer/styles.css`
- Modify: `src/renderer/Chat.tsx` (remove the conversation `<select>`)
- Modify: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: snapshot `config`, `configError`, `lastTicketId`; `setConfig`, `setLastTicket`.
- Produces: `Home({ tickets, sessions, root, onOpen, onChooseRoot })`; `FilesRail({ ticket, files, file, session, discovered, onOpenFile, onImport, onHide, onSelectConversation, onAttach, onDiscover })`.

- [ ] **Step 1: Extend the smoke test first**

In `scripts/smoke.mjs`: add `const configDir = path.join(fixtureRoot, 'config')` and `SUPPORT_CONFIG_DIR: configDir` to `env`; replace the sidebar selectors with:

```js
const home = () => page.locator('.home-screen');
const ticketRow = (name) => page.locator('.home-ticket').filter({ hasText: name });
const tab = (name) => page.locator('.ticket-tabs button').filter({ hasText: name });
const rail = () => page.locator('.files-rail');
```

After launch: `await expect(home()).toBeVisible();` then `await ticketRow('ticket_901').click();`. Replace `ticketButton(...)` with `tab(...)`, and the file-pane toggle assertion with: rail visible by default, `page.getByRole('button', { name: 'Hide files' }).click()`, `await expect(rail()).toHaveCount(0)`, assert `JSON.parse(await fs.readFile(path.join(configDir, 'config.json'), 'utf8')).filesHidden === true`, then show it again with `page.getByRole('button', { name: 'Layout menu' }).click()` followed by `page.getByRole('button', { name: 'Show files' }).click()`. Add: `page.getByRole('button', { name: 'Ticket menu' }).click()`, `page.getByRole('menuitem', { name: 'Home' }).click()`, open `ticket_902` from its row, assert two tabs, close 902 with `.ticket-tabs button[aria-label="Close ticket_902"]`, assert its tab is gone and 901 is active. Keep the existing editor/conflict/flush assertions unchanged.

In the live block, also assert the background-approval signal: with 901 open, switch to 902, ask Copilot there to run one harmless external command, wait for `.approval-card`, assert the tab strip for 901 contains `.approval-icon` while 902 is active, deny, then return to 901. Guard with a count check when the CLI declines to request permission.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run test:desktop`
Expected: FAIL — `.home-screen` not found.

- [ ] **Step 3: Rebuild the renderer shell**

`App.tsx` state: `workspace`, `activeId: string | null` (null is Home), `openTickets: string[]`, `selectedFiles`, `ticketFiles`, `search` moves to `Home`, `error`, `initializing`, `split`, `config`, `configError`, `discovered`, `discovering`, `discoveryError`.

Rules to implement:

- After `snapshot`, `config` = snapshot.config, and if `snapshot.lastTicketId` resolves to a ticket: `openTickets = [id]`, `activeId = id`; otherwise Home.
- `openTicket(id)`: flush, add to `openTickets` if missing, `activeId = id`, `void setLastTicket(id)`.
- `closeTicket(id)`: flush, remove, and if it was active pick the next tab, else the previous, else Home; `void setLastTicket(newActive)`.
- `goHome()`: flush, `activeId = null`, `void setLastTicket(null)`. No tab changes.
- Header markup: `.app-header` with `.brand`, a `.ticket-picker` button (`aria-label="Ticket menu"`, shows the active ticket name or "Home") opening a menu of Home plus every ticket with its activity label, `.ticket-tabs` (one `.tab` per open ticket with activity dot, approval/completed icon and a close button labelled `Close <name>`), and a `.layout-menu` hamburger (`aria-label="Layout menu"`) containing: Show/Hide files, Chat left/right, Files left/right, each calling `setConfig` and updating local `config`. Hide the hamburger on Home.
- Body: `.workspace-body` renders `Home` when `activeId` is null, otherwise the panes in this order: files rail when `config.filesSide === 'left'` and not hidden → chat and divider and document (chat first when `chatSide === 'left'`, document first otherwise) → rail when it is on the right.
- `configError` renders as one dismissible `.global-error` line.
- `FilesRail` receives the existing file list, MAIN badge, import action and session props; its conversation list replaces the `<select>` removed from `Chat.tsx` and each entry calls `onSelectConversation`.
- Delete `.ticket-sidebar`, `.ticket-button`, `.root-button`, `.search-box`, `.sidebar-*` CSS. `Home.tsx` owns search and the tickets-root button, reusing the existing welcome copy for the empty state.

Keep unchanged: approval cards, thinking/stop row, tool list, `flush` guard on every switch and close, autosave and conflict banners, error handling.

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npm run build && npm run test:desktop`
Expected: PASS, screenshot written to `test-results/workspace.png`. Check the screenshot shows header, Home or editor shell, and the rail.

- [ ] **Step 5: Commit**

```bash
git add src/renderer scripts/smoke.mjs
git commit -m "Rebuild the workspace shell with Home and ticket tabs"
```

---

### Task 5: Config-driven layout and last-view restore

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: Task 3 `setConfig`.
- Produces: layout order driven by `config.chatSide`, `config.filesSide`, `config.filesHidden`; last view restored across relaunch.

- [ ] **Step 1: Extend the smoke test**

In the non-live path, after the existing quit-flush close and its file assertion:

1. Write `config.json` into `configDir` with `{ chatSide: 'right', filesSide: 'left', filesHidden: false }` (simulating a hand edit).
2. Relaunch and assert the last view came back as `ticket_901` (it was active at quit) and the layout follows the file:

```js
await expect(page.locator('.workspace-body > *').first()).toHaveClass(/files-rail/);
await expect(page.locator('.workspace-body > *').last()).toHaveClass(/chat-panel/);
```

3. Open the layout menu, choose **Home**, assert `.home-screen` is visible, then assert `JSON.parse(await fs.readFile(path.join(dataRoot, 'settings.json'), 'utf8')).lastTicketId` is `null`; assert `config.json` still contains `chatSide: 'right'` after using the menu.
4. Close the app.

The live block's own relaunch covers conversation restore and must keep passing.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run test:desktop`
Expected: FAIL — chat and rail order do not follow the config.

- [ ] **Step 3: Implement ordering and last-view restore**

Render the body from an explicit array so order is visible in one place:

```ts
const panes = [
  ...(config.filesSide === 'left' ? [rail] : []),
  ...(config.chatSide === 'left' ? [chat, divider, document] : [document, divider, chat]),
  ...(config.filesSide === 'right' ? [rail] : []),
];
```

Each element keeps a stable `key`. The divider still resizes the in-memory `split`; do not persist it. `goHome` already writes `null`; verify the initial state uses `lastTicketId` and falls back to Home for unknown ids (Task 4 logic) and that the restored config is applied before first paint (state initialised from the snapshot, no flash of default order).

- [ ] **Step 4: Run the smoke test to verify it passes**

Run: `npm run build && npm run test:desktop`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.tsx scripts/smoke.mjs
git commit -m "Drive the layout from the config file"
```

---

### Task 6: Session discovery in the rail

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/FilesRail.tsx`
- Modify: `src/renderer/Chat.tsx` (no change if the select was already removed in Task 4)
- Modify: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: Task 2/3 `discover` and `attach`.
- Produces: auto-attach on first view of a ticket with no conversations; a **Find sessions** action and an Attach action per discovered session.

- [ ] **Step 1: Extend the smoke test**

The non-live smoke must not depend on a Copilot install. After opening `ticket_901`, assert the rail exposes the action and that a failed auto-discovery never becomes a global error:

```js
await expect(rail().getByRole('button', { name: 'Find sessions' })).toBeVisible();
await expect(page.locator('.global-error')).toHaveCount(0);
```

In the live block, after the first Copilot turn: assert the rail lists the previous conversation entry and, when discovery returned CLI sessions, an `Attach` button — guard it with `if (await rail().getByRole('button', { name: 'Attach' }).count())`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npm run test:desktop`
Expected: FAIL — no Find sessions button.

- [ ] **Step 3: Implement the rail section and auto-attach**

In `App.tsx`:

- On ticket activation, if that ticket's session has no conversations and `discovered[ticketId]` is undefined and no discovery is in flight, call `discover(ticketId)` once. On success with results, `attach(ticketId, results[0].sessionId)`. Guard with a `Set` of attempted ticket ids so a re-render cannot loop.
- Discovery failure sets `discoveryError[ticketId]` and is rendered inline in the rail; it must not set the global error or change activity.
- `Find sessions` re-runs discovery for the active ticket. Attach calls the IPC, then refreshes `ticketFiles` and clears any inline error.
- `FilesRail` renders: file list with MAIN badge, import button, `Previous sessions` = the ticket's conversations (`session.conversations`, current one marked, title when present) followed by discovered summaries whose `sessionId` is not already in the conversation list, each with `Attach`. Show a short empty state while a discovery is in flight.
- `Chat.tsx` no longer renders the conversation selector (already removed in Task 4). Keep **New conversation** in the chat header.

- [ ] **Step 4: Run the tests and the smoke test**

Run: `npm test`, `npm run build`, `npm run test:desktop`
Expected: PASS. Optionally `RUN_COPILOT_SMOKE=1 npm run test:desktop` when a logged-in CLI is present.

- [ ] **Step 5: Commit**

```bash
git add src/renderer scripts/smoke.mjs
git commit -m "Show and attach previous Copilot sessions in the rail"
```

---

### Task 7: Insert into editor

**Files:**
- Modify: `src/renderer/Editor.tsx`
- Modify: `src/renderer/Chat.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: existing `EditorHandle`, `Chat` props.
- Produces: `EditorHandle.insert(text: string): boolean`; `Chat` prop `onInsert?: (text: string) => boolean`.

- [ ] **Step 1: Extend the smoke test**

In the live block, after Copilot replies `READY` and the editor is in rich mode: click the last agent message's `Insert into editor`, then `await expect(rich()).toContainText('READY');` and, after the autosave debounce, `await expect.poll(() => fs.readFile(markdownA, 'utf8')).toContain('READY');`. Also assert the button is absent while the editor shows read-only evidence (`evidence.log` open).

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && RUN_COPILOT_SMOKE=1 npm run test:desktop`
Expected: FAIL — no Insert into editor button.

- [ ] **Step 3: Implement insertion**

`Editor.tsx`: add a `sourceRef` for the textarea. Extend the imperative handle to `{ flush, insert }`; `insert` returns `false` when `modifyingRef.current` or `conflictRef.current` is set. Rich mode runs `editor.chain().focus().insertContent(text, { contentType: 'markdown' }).run()`; verify that Tiptap 3 accepts `contentType: 'markdown'` for `insertContent` — if it does not, parse with the existing `MarkdownManager` from `markdown.ts` and insert the JSON. Source mode splices the text at `selectionStart`, calls `changed(next)` and updates `setSafe`. Insertion must mark the document dirty so the normal autosave persists it.

`Chat.tsx`: on each `message.role === 'agent'` article render a `Insert into editor` button calling `onInsert(message.text)` when the prop is provided.

`App.tsx`: reuse the document's `modifying` computation by extracting it from `Viewer.tsx` into `export function isAgentEditing(session: TicketSession | undefined, ticketRoot: string, file: string): boolean` and calling it from both `Viewer` and `App`. Pass `onInsert` to `Chat` only when the open file is Markdown and `isAgentEditing` is false, forwarding to `viewer.current.insert`. Insertion never sends a prompt and never writes outside the open document.

- [ ] **Step 4: Run the tests and the smoke test**

Run: `npm test`, `npm run typecheck`, `npm run build`, `npm run test:desktop` (plus `RUN_COPILOT_SMOKE=1` when the CLI is available)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer scripts/smoke.mjs
git commit -m "Insert Copilot messages into the open document"
```

---

### Task 8: Documentation and full verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the README**

Document: `~/.suppai/config.json` keys and defaults (`chatSide`, `filesSide`, `filesHidden`), Home + tabs + last-view restore, the files rail and hamburger, **Find sessions** / **Attach** and that discovery is limited to the ticket's own Copilot home, and **Insert into editor**. Replace the stale "Toggle the normally hidden file pane" and "Select a ticket" wording. Keep the isolation and approval sections intact; add one sentence that sessions from a global Copilot home are never imported.

- [ ] **Step 2: Run every check**

Run: `npm test`, `npm run typecheck`, `npm run build`, `npm run test:desktop`
Expected: all PASS. Record whether `RUN_COPILOT_SMOKE=1` was run.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the workspace layout and session attach"
```

---

## Self-review notes

- Spec coverage: config (Task 1, 3, 4, 5), Home/tabs (Task 4), rail side/hide (Task 4, 5), discovery/attach/auto-attach/rollback (Task 2, 3, 6), insert (Task 7), docs and limits (Task 8). No spec section is unimplemented.
- Review Focus coverage: unsaved content → Task 4/5 smoke tab, Home and root-change assertions; background approval → Task 4 live smoke tab badge; foreign session → Task 2 attach-cache test; config typo and unknown keys → Task 1 tests; failed attach/discovery → Task 2 rollback and error tests plus Task 6's rail-error/global-error assertion.
- Deliberate omissions carried from the spec: no folder tree in the rail, no profile footer, no tab-set persistence, no config hot-reload. The spec listed a test for the 1 MiB replay cap; generating a megabyte of synthetic replay would cost more than the branch it covers, so the cap is implemented and reviewed by inspection instead.
- Unverified at planning time: whether Copilot CLI 1.0.100 advertises `sessionCapabilities.list` and what `session/load` replays. Task 2's tests use the synthetic CLI; Task 6's live smoke is the only place the real CLI is exercised.
