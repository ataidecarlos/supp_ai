# Support Workspace: Code-Editor Layout and Session Attach

Date: 2026-11-08
Status: awaiting approval

## Intent

The app works, but it reads like a ticket browser with a chat box bolted on. The
goal is the shape in the reference image: a code-editor-style shell where the
Copilot conversation and the ticket document sit side by side, files live in a
switchable rail, and switching tickets feels like switching tabs — while every
AI action still comes from the installed GitHub Copilot CLI and from nothing
else.

The app is a wrapper around one Copilot session per ticket. It is not an AI
product. It must attach to Copilot sessions that already exist for a ticket
rather than pretending they do not.

## What was decided by the user

1. Chat/editor positions are switchable, configured in `~/.suppai/config.json`.
2. The files/attachments rail can be on either side and hidden; also configured
   in that file.
3. `COPILOT_HOME` stays custom per ticket, so changing tickets changes context.
4. The header has a ticket dropdown (Home + ticket list) and open tickets as
   tabs.
5. Opening a ticket never closes it; tabs live until closed or restart. On
   launch, reopen the last active ticket. Home is a full-canvas list of all
   tickets, not a dropdown entry.
6. Existing Copilot sessions for the ticket must be discovered and attached.

## Goals

- Three-pane editor shell: chat column, document surface, files rail.
- One config file the user can edit by hand, plus in-app toggles that write it.
- Home screen and ticket tabs replace the permanent ticket sidebar.
- Discover sessions in the ticket's Copilot home; attach on demand and
  automatically when a ticket has no app history.
- Keep every existing safety behaviour: per-ticket process and home, explicit
  approval for external operations, autosave/conflict/lease handling, flush on
  switch, bounded reads.

## Non-goals

- No global `~/.copilot` import, no shared Copilot home, no session copy
  between tickets. Isolation is the feature.
- No user accounts, avatars, or "profile" footer.
- No persistence of the open tab set; only the last active ticket is restored.
- No file-tree folders in the rail. Files stay a flat list (they already show
  relative paths). Grouping is cosmetic and can come later.
- No config hot-reload while the app is running. Hand edits apply at launch;
  in-app toggles apply immediately and write the file.
- No new AI provider, model API, mock fallback, or generated placeholder
  content. If Copilot is missing, the app says so.

## Anti-goals

- A ticket's conversation leaking into another ticket's context.
- Attaching a session belonging to a different working directory.
- Replaying a loaded session twice, or duplicating app history.
- Silently dropping or overwriting a config file the user hand-edited.
- Losing an unsaved document because a tab or Home was clicked.

## Constraints

- Electron main owns all filesystem and process work; the renderer gets it
  through `WorkspaceApi` in `src/shared/types.ts`.
- ACP `session/list` is an optional capability. Absence must degrade to
  app-owned history, not an error dialog.
- `session/load` replay arrives as `session/update` notifications before the
  request resolves. The current code intentionally ignores them because app
  history already holds the transcript. Capture needs to be opt-in per load.

## Design

### Config

New `src/main/config.ts`, plain functions, no class:

```
interface Config { chatSide: 'left' | 'right'; filesSide: 'left' | 'right'; filesHidden: boolean }
DEFAULTS = { chatSide: 'left', filesSide: 'right', filesHidden: false }
```

- Path: `~/.suppai/config.json` via `os.homedir()`; `SUPPORT_CONFIG_DIR`
  overrides the directory, mirroring the existing `SUPPORT_DATA_DIR` test seam.
- Read: missing file → defaults, no error. Malformed JSON, wrong types, or an
  unknown value → keep defaults, report one `STATE` error to the UI, and never
  rewrite the file.
- Unknown keys are ignored so a newer config remains readable by an older app.
- Write: `atomicJson` (already in `files.ts`), creating the directory.
- `setConfig(patch)` is read-merge-write: it re-reads the file, keeps keys it
  does not own, applies the validated patch, and writes the result. If the
  existing file is malformed it does not write at all and returns an error
  naming the path, so a hand-edit is never clobbered. Patches accept only the
  three keys above.
- API: `snapshot()` gains `config`; `setConfig(patch)` validates, writes and
  returns the effective config.

`WorkspaceSnapshot` gains `config: Config`, `configError: string | null` and
`lastTicketId: string | null`. The error travels in the snapshot because startup
events are emitted before the window exists and would be dropped.
`lastTicketId` stays in the existing app-data `settings.json` beside `root`,
because it is app state, not user settings. New IPC `last-ticket` stores it on
ticket switch (best effort; a write failure must not block the switch).

### Shell and layout

`App.tsx` renders, top to bottom:

1. Header: brand mark, ticket picker (dropdown with Home + every ticket),
   open-ticket tabs, activity dot for the active ticket, hamburger.
2. Body: either Home or the editor shell.
3. Existing status footer (working directory, isolation reminder).

Editor shell, in one flex row ordered by config:

- chat column (`Chat.tsx`, unchanged internals, `flexBasis` from the existing
  draggable split, default 41%),
- the existing 7px drag divider,
- document panel (`Viewer`/`MarkdownEditor`, remaining width),
- files rail on the configured side, rendered before or after the other two.

`chatSide` moves the whole chat column and divider to the other end. The
document stays in the middle either way. The rail is omitted entirely when
`filesHidden`.

### Header controls

- **Ticket picker**: button showing the active ticket name (or "Home"); menu
  lists Home followed by all tickets with their activity label. Choosing a
  ticket opens its tab and activates it. Choosing Home activates Home without
  closing tabs.
- **Tabs**: one button per open ticket plus a close affordance. Each tab keeps
  the old sidebar's signals: activity dot, approval icon when a background
  ticket needs permission, completed icon. Approvals from background tickets
  stay visible, as the README promises. Clicking the active tab does nothing.
  Closing the active tab activates its neighbour; if none remain, Home. Every
  switch and close flushes the editor first and refuses to proceed on an
  unresolved save or conflict, exactly as `switchTicket` does today.
- **Hamburger**: toggles `filesHidden`. Inside it, a small layout section
  ("Chat left/right", "Files left/right") calls `setConfig`.
- Ticket picker and tabs must be keyboard reachable and expose `aria-current`.

`lastTicketId` records the active *view*, not the tab set: an open ticket
writes its id, Home writes `null`. Relaunch opens that ticket, or Home when it
is `null` or no longer resolves (folder moved, ticket deleted). Choosing a
different tickets root closes every tab, clears `lastTicketId` and lands on
Home, because ticket ids are path hashes and the old ids are gone.

### Home

Full-canvas replacement for the old sidebar: title, tickets-root control
(moved from the sidebar), search field, and rows for all tickets showing name,
activity dot and label, plus file count when cheaply available. Clicking a row
opens a tab. Empty and first-run states keep the current "choose tickets
folder" call to action, reusing existing copy where possible.

The old `.ticket-sidebar`, `.ticket-button`, `.root-button`, `.search-box` and
`.sidebar-*` markup and styles are removed, not hidden.

### Files rail

Keeps the existing file list, import button and MAIN badge, plus two additions:

- header with the ticket name and a "Hide" button (same action as hamburger),
- a **Previous sessions** section: app conversations (selectable, as today's
  conversation selector) and discovered-but-unattached sessions with an
  Attach action and their title/date.

The chat panel's conversation `<select>` is replaced by this rail section; the
chat header keeps New conversation.

### Session discovery and attach

In `CopilotSessions`:

- On `initialize`, record `sessionCapabilities.list` presence on the runtime
  after `initialize` returns. Today the runtime object is per ticket; store the
  boolean next to it or on the manager keyed by ticket.
- `discover(ticketId): Promise<SessionSummary[]>` reuses the ticket's live
  runtime when one exists (the method does not disturb the loaded session).
  Otherwise it spawns a short-lived CLI with the ticket's home and cwd, calls
  `initialize`, then `session/list` with `{ cwd: ticket.root }`, filters results
  to `cwd === ticket.root`, follows `nextCursor` up to three pages, destroys the
  process, and returns `{ sessionId, title, updatedAt }`. It reuses `CLI_ARGS`
  and `cliEnvironment`. Absent capability returns `[]`. CLI failures are
  reported to the caller as an error string, never as a ticket failure state.
- The manager caches the last discovery result per ticket. `attach` rejects any
  `sessionId` that is not in that cache, so the cwd check cannot be bypassed
  through IPC.
- `attach(ticketId, sessionId)`: rejects while the ticket is busy, destroys any
  live runtime first (a different session cannot be loaded onto it), creates a
  `Conversation` with that `sessionId`, the cached title and a createdAt from
  `updatedAt` (or now), makes it current, then connects and loads it so the
  transcript is populated. If the load fails, the conversation is removed, the
  previous conversation is restored, and the error is returned; no phantom
  conversation with a dead id is persisted.
- **Replay capture**: `connect` sets a one-shot `capture` flag when it loads a
  session whose conversation has no messages yet (attach, or an attached
  conversation that failed to load its replay earlier). While capturing,
  `agent_message_chunk` and `user_message_chunk` updates append to the
  conversation instead of being discarded. Capture stops at 1 MiB of text per
  conversation; the load is still accepted, further replay is ignored and one
  notice is added. A conversation that already has messages never captures, and
  app-owned loads keep ignoring replay — that is what prevents duplicate history
  today, and it is the marker across restarts. No new persisted fields are
  needed beyond `Conversation.title`.
- Auto-attach: the renderer asks once per opened ticket with no conversations.
  If discovery returns sessions, it attaches the most recent; otherwise the
  ticket behaves as today. Discovery failures show one inline rail message and
  leave the ticket usable. For tickets that already have conversations, the rail
  offers an explicit **Find sessions** action instead of spawning a CLI on every
  switch.

`SessionSummary` and an optional `Conversation.title` are added to
`src/shared/types.ts`; `WorkspaceApi` gains `discover` and `attach`. Preload and
IPC support them with the same `text()` validation as other handlers.

### Insert into editor

`EditorHandle` gains `insert(text: string): boolean`. In rich mode it inserts
markdown at the cursor (verify `insertContent(..., { contentType: 'markdown' })`
in the installed Tiptap 3; if unavailable, parse with `MarkdownManager` and
insert the resulting JSON). In source mode it inserts at the textarea cursor.
Insertion marks the document dirty so the existing autosave path persists it.

Agent messages render an "Insert into editor" button, disabled when no Markdown
document is open, when the document is read-only evidence, or while Copilot is
modifying that file. This is placement of Copilot-authored text, not generation.

## Files to touch

- `src/main/config.ts` (new), `src/main/index.ts`, `src/main/sessions.ts`,
  `src/preload/index.ts`, `src/shared/types.ts`
- `src/renderer/App.tsx` (largest change), `Home.tsx` (new), `FilesRail.tsx`
  (new, extracted from `App.tsx`), `Chat.tsx` (drop conversation select, add
  insert button), `Editor.tsx` (`insert`), `styles.css` (shell rewrite plus new
  header/home/rail styles, removal of sidebar styles)
- `tests/config.test.ts` (new), `tests/sessions.test.ts`,
  `tests/fixtures/fake-cli.mjs`, `scripts/smoke.mjs`, `README.md`

## Tests and verification

- `tests/config.test.ts`: defaults when absent; partial merge; invalid value
  reported with defaults kept and file untouched; write/read round trip;
  unknown keys preserved on write; a malformed file is not overwritten and the
  error names the path; `SUPPORT_CONFIG_DIR` honoured.
- `tests/sessions.test.ts`: discovery returns only sessions whose cwd matches
  the ticket, is empty when the capability is absent, and survives an unknown
  method error; attach rejects while busy and rejects ids that were not
  discovered; a failed attach restores the previous conversation and leaves no
  dead conversation behind; attaching an existing session loads it and exposes
  its replay, and a second load does not duplicate it; capture cap produces
  exactly one notice.
- `tests/fixtures/fake-cli.mjs`: advertise `sessionCapabilities.list`, answer
  `session/list` filtered by cwd (with an option to omit the capability and an
  option to fail), keep replaying history on `session/load`.
- `scripts/smoke.mjs`: replace sidebar selectors with Home and tab selectors;
  assert files rail visibility via hamburger and that toggling writes
  `config.json` under `SUPPORT_CONFIG_DIR`; assert chat/editor order changes
  when `chatSide` is flipped in the fixture config before relaunch; reopen the
  last ticket after restart; keep the existing editor, conflict, flush and
  live-Copilot assertions.
- `npm test`, `npm run typecheck`, `npm run build`, `npm run test:desktop`.

## Risks and open operational notes

- Copilot CLI 1.0.100 was the verified version; whether it advertises
  `session/list` is unverified here (no CLI or `node_modules` in this
  environment). Discovery is designed to be inert without it. This needs a real
  CLI check before claiming attach works.
- The replay shape of `session/load` (which update kinds Copilot emits) is
  likewise unverified; capture handles the documented chunk types and ignores
  the rest, so worst case an attached session shows a partial transcript.
- Auto-attach adds one short-lived CLI process when a ticket with no history is
  first opened. If that proves slow, gate it behind the rail's refresh action
  instead — a one-line policy change, not a redesign.
- Tab state is intentionally volatile; a crash loses the tab set but not
  conversations or files.

## Calls made while checking the design

For review, these are my decisions rather than yours:

1. `configError` rides in the snapshot because startup events are dropped
   before the window exists.
2. `setConfig` preserves unknown keys and refuses to write over a malformed
   file; you fix it by hand, nothing is clobbered.
3. Discovery is automatic only for a ticket with no conversations, plus an
   explicit **Find sessions** action in the rail. A CLI process on every tab
   switch would be worse than the feature is worth.
4. `attach` only accepts ids from the last discovery result, and destroys the
   live runtime before loading, so a session from another directory cannot be
   attached through IPC.
5. A failed attach rolls back to the previous conversation.
6. Replay capture is keyed on "conversation has no messages", so no new
   persisted field is needed and history never duplicates.
7. Attached conversations keep the Copilot session title, stored as an optional
   `Conversation.title`; older `history.json` files still validate.
8. Tabs keep the old sidebar's approval and completed indicators. Removing them
   would hide background permission requests, which the README tells users to
   watch for.
9. The active view (ticket or Home) is what `lastTicketId` stores; changing the
   tickets root closes all tabs and lands on Home.
10. The old sidebar's search and root control move to Home rather than staying
    in the header.
