# Support Workspace on Rune: Native Rewrite Design

Date: 2026-11-09
Status: awaiting approval

## Intent

Replace the Electron + React shell with a native Rust desktop app built on
[Rune](https://github.com/anomalyco/rune), keeping the product behaviour that
matters: one Copilot session per ticket, evidence files beside the conversation,
and every AI action driven by the installed GitHub Copilot CLI.

The reference wireframe is a four-column editor: a narrow numbered ticket strip,
a session column (title, transcript, composer), a rendered Markdown document,
and a hierarchical file tree. That shape is why a native UI framework is worth
it: Rune's own kits already provide the shell, virtualised tree, Markdown view
and text editing that the sketch implies.

## Why Rune

- `rune-kit::shell::SplitView` gives resizable/collapsible panes, titlebar drag
  band and pane springs; `Sidebar`/`SidebarRow` gives the numbered strip.
- `rune-kit::Tree` + `FileTree` gives the folder-first virtualised file tree.
- `rune-kit::Markdown` renders CommonMark + GFM tables with syntax-highlighted
  code fences, selectable text and streaming updates.
- `TextArea`/`TextEdit` gives real text editing (caret, selection, undo, IME,
  paste) with optional attributed styling.
- Native file dialogs (`open`, `save`, `open_folder`) and clipboard are built in.
- Headless operation is a first-class feature: render to PNG, dump the element
  tree, drive scripted input, assert on state. Our UI tests become Rust tests
  instead of Playwright against Electron.
- Single native binary; no Chromium, no Node runtime in the product.

Costs, stated plainly: a full port of the main process to Rust, no WYSIWYG
Markdown editor in the framework (render + source editing instead), and a
pre-release dependency pinned to a `dev` rev with no upstream PR path.

## What was decided by the user

- The rewrite is approved: build the new UI in Rune rather than restyling the
  Electron app.
- The wireframe is the target layout, not a pixel contract.

## Goals

1. Native app that opens a tickets root, lists tickets in the left strip, and
   keeps one Copilot context per ticket.
2. Copilot chat in the session column with streaming text, tool activity,
   approvals, stop, new conversation, attachment to existing sessions, and a
   switcher for the ticket's saved conversations (the session title is its menu).
3. Rendered Markdown document with source editing, autosave, revision checks,
   draft recovery and conflict resolution.
4. File tree with folders, evidence previews (text and images), import, and
   "open externally" for anything that cannot be rendered.
5. Behaviour and on-disk state compatible with the existing app: same
   `~/.suppai/config.json`, same ticket layout, same per-ticket `COPILOT_HOME`,
   same `history.json` so existing conversations continue.
6. Full parity for the small interactions already shipped: auto-attach the
   newest discovered session when a ticket has no conversations, insert a
   Copilot reply into the open Markdown document at the caret (disabled while
   the agent edits it, while a conflict is open, or for non-Markdown files), and
   link handling inside rendered Markdown (relative links open in the document
   pane, HTTP(S) opens the browser only after confirmation).
7. Windows-first (the user's machine), with macOS/Linux kept compiling.

## Non-goals for the first release

- WYSIWYG Markdown editing (Tiptap's Document mode). The document pane renders
  Markdown and edits source. A rich editor can be built later on Rune spans.
- Tabs, Home and the ticket dropdown from the Electron app. The strip replaces
  them. (Reversible: the strip is a list in app state.)
- A user profile footer, avatar, or accounts.
- PDF/Office previews. Text, Markdown, and raster images only, as today.
- Web (wasm) target. Native only.
- Packaged installer and signing. A `cargo build --release` binary is the
  deliverable; packaging comes after parity.
- Any AI provider or model API called by the app itself. Copilot CLI only.

## Anti-goals

- Two apps sharing one ticket's Copilot home at once.
- Losing an unsaved document on ticket switch, pane change, or quit.
- Silent config rewrite, or losing unknown keys in `config.json`.
- A session from another ticket or working directory being attachable.
- Re-rendering the world on every keystroke: chat streams must not cause
  document text edits to lose the caret.

## Constraints

- Rune is pre-release: pin `dev` at `e970367b` (`rev` in Cargo), and expect to
  move the pin deliberately, never automatically.
- Rust 1.98+, MSVC toolchain on Windows (verified installed).
- ACP: `agent-client-protocol` crate 5.1.x (Rust SDK) for the client side.
  If it cannot express streaming updates or permission requests, fall back to
  the same NDJSON JSON-RPC framing our TypeScript client uses.
- Reuse the Copilot CLI arguments and isolation rules from `src/main/sessions.ts`
  (no built-in MCPs, no custom instructions, no auto-update, per-ticket home,
  `COPILOT_ALLOW_ALL=false`).
- The Electron app stays in the repo and keeps working until the native app
  reaches parity; removal is a separate change.

## Architecture

One native process. Rune owns the UI thread and frame loop.

```
UI thread (Rune view + handlers)
  └─ AppState: tickets, per-ticket sessions, documents, panes, config
       ▲                     │ commands
       │ events              ▼
  worker threads:  ticket agents (one Copilot child each)
                   file watcher + save worker
                   history/config persistence
```

- Handlers mutate `AppState` directly; no async in handlers.
- Long work is a command sent over `std::sync::mpsc` to a worker. Workers send
  events back; the UI drains them in `AppSpec::poll` and mutates state. This is
  the pattern Rune documents for background work.
- Each ticket gets its own Copilot child process and home, started on first
  send or discovery and stopped on quit, as today.
- File watching uses the `notify` crate, debounced, feeding the same event
  queue.

## Data compatibility

- `~/.suppai/config.json`: same three keys, plus new `paneWidths` (optional).
  Unknown keys preserved, malformed reported and never overwritten.
- Data dir: `%APPDATA%/support-workspace` equivalent (Rune `dirs`), overridable
  with `SUPPORT_DATA_DIR`; tickets root from `SUPPORT_TICKETS_ROOT` or
  `settings.json`.
- `history.json` per ticket: same schema (`conversations[]` with `id`,
  `createdAt`, optional `title`, optional `sessionId`, `messages[]`; `currentId`).
  Unknown fields preserved on rewrite where practical.
- Copilot home: `<dataDir>/tickets/<ticketId>/copilot`, so an existing app's
  sessions are attachable and resumable. Ticket ids stay the same hash scheme
  (sha256 of canonical path, 24 hex chars, lowercased on Windows) so ids match.
- Drafts and recovery files keep their current paths and shapes so an interrupted
  Electron session can be recovered by the native app and vice versa.

## UI design

Four columns, as sketched:

1. **Ticket strip** (fixed ~72 pt, scrollable): one row per ticket showing its
   number (the ticket folder name, shortened) with an activity dot; approval
   state uses a shield glyph. Selecting a row switches the ticket. A footer
   holds the tickets-root button and the layout menu.
   The session starts on the ticket that was last active.
2. **Session column** (default 380 pt, resizable): session title, transcript
   (Markdown-rendered agent messages, plain user messages, notices, tool rows,
   approvals), and a composer pinned to the bottom. The title is a menu listing
   the ticket's saved conversations, with the current one marked; choosing one
   loads it. "New conversation" and "Find sessions" sit beside it.
3. **Document column** (flex): rendered Markdown for the selected file, with an
   Edit/Document toggle. Edit mode is a `TextArea` with a save indicator,
   conflict banner, and draft recovery. Images and text evidence render
   read-only in the same column. There is one selection: the file tree chooses
   what this column shows.
4. **File tree** (default 260 pt, collapsible): folder-first tree of the ticket
   with the main summary marked, plus the import button.

Approvals appear inline in the session column, with the command/path detail,
one-time choices, and a cancel. Background ticket activity stays visible on the
strip (dot and shield).

Pane widths persist in config. Which side the session and tree sit on is not
configurable in this release; the sketch fixes the order. (Cheap to add later.)

## Component mapping

| Need | Rune |
|---|---|
| App shell, resizable panes | `rune_kit::shell::SplitView`, `PaneState` |
| Ticket strip | `rune_kit::Sidebar`/custom column of rows; `focus_group` for arrows |
| File tree | `rune_kit::Tree` + `FileTree` |
| Document render | `rune_kit::Markdown` (`markdown` feature), `selectable(true)` |
| Document edit | `rune::edit::TextEdit` + `TextArea`, `on_edit`, `on_submit` |
| Chat transcript | `scroll` + `stick_bottom`, `Markdown` per message, `text` for user rows |
| Composer | `TextArea` with `on_submit` + Shift+Enter newline |
| Buttons, menus, dialogs | `rune_kit` components; `tx.open_folder` for the root picker |
| Images | `rune::image` decode + `El` image node (verify formats) |
| File dialogs | `tx.open` / `tx.save` / `tx.open_folder` callbacks |
| Clipboard | `tx.copy` |

Exact API names are verified against the pinned rev during the first task, not
assumed from this table.

## Core behaviour to port

- Ticket discovery, main-summary selection, file listing (5,000-file cap).
- Path safety: every resolved path inside the ticket; no symlink escapes;
  reject drive-absolute and `..` input from the agent.
- Save: 2 MiB Markdown cap, atomic write, compare-and-swap on revision, draft
  journal before write, recovery snapshot before overwrite, conflict states.
- Agent edit leases: local edits auto-approved while the ticket's agent holds a
  lease; external or unclassified operations require a one-time approval;
  reads recorded for stale-revision denial.
- Copilot session lifecycle: connect → initialize → session/new or load,
  prompt streaming, tool call updates, permissions, cancel with timeout,
  process exit handling, per-ticket isolation, session discovery, attach,
  replay capture (1 MiB cap), last-view restore.
- Config and settings read/write with the same validation rules.

## File layout

```
desktop/
  Cargo.toml                 # workspace, pinned rune rev
  app/
    Cargo.toml
    src/
      main.rs                # AppSpec, window, poll loop
      state.rs               # AppState, per-ticket state, pane state
      ui/
        shell.rs             # SplitView, strip, layout
        strip.rs
        session.rs           # transcript, composer, approvals
        document.rs          # render + edit + conflict UI
        tree.rs
      core/
        config.rs
        settings.rs
        tickets.rs           # discovery, path safety, main file
        files.rs             # read/save/drafts/recovery/watch
        history.rs
        agent.rs             # worker thread, command/event channel
        acp.rs               # ACP client over the SDK (or NDJSON fallback)
    tests/
      config.rs
      tickets.rs
      files.rs
      agent.rs               # drives tests/fixtures/fake-cli.mjs via node
      ui.rs                  # headless Runtime: views, keys, snapshots
```

The existing `tests/fixtures/fake-cli.mjs` is reused as the synthetic Copilot
for Rust integration tests: ACP framing is language-neutral and the fixture
already exercises prompts, tools, approvals, edits, list and load.

## Verification

- `cargo test` in `desktop/`: pure core tests, ACP against the synthetic CLI,
  headless Rune view tests (pointer/key input, element tree assertions).
- `cargo run -p suppai -- --snap` style headless render of the main screen for
  a visual check without a display.
- Manual live check against the installed Copilot CLI and the OpenCode Go
  provider, same as the Electron live smoke.
- Parity checklist: open root, switch ticket, send prompt, stop, approve/deny,
  new conversation, find/attach session, edit + autosave + conflict, import,
  image preview, quit flush.

## Calls made while checking the design

These are my decisions, not requirements, and are the cheap things to veto:

1. The Goals list is the scope contract; anything not listed is out. The four
   Electron behaviours the builder flagged (insert, link handling, open
   externally, auto-attach) are in, as Goal 6.
2. The session column's title is a conversation menu, so older conversations
   stay reachable and `history.json` remains meaningful.
3. There is one file selection. The tree drives the document column; there is no
   second inline preview inside the rail.
4. The data-dir lock only guards native instances. Coexistence with Electron is
   a dogfooding rule, not code.

## Risks

1. **Rune API drift**: pre-release and no PRs. Mitigation: pin the rev, keep UI
   code thin over `rune`/`rune-kit`, and record the rev in the design.
2. **No WYSIWYG editor**: real product regression versus the Tiptap mode.
   Accepted for the first release; sourced editing is the sketch's document
   with an edit affordance.
3. **ACP in Rust**: the SDK's client ergonomics are unverified here. Fallback is
   the same JSON-RPC shape our TypeScript client already implements and tests.
4. **Image decoding**: Rune's `image` module may support fewer formats than the
   browser. Accept PNG/JPEG/GIF/WebP/BMP where possible; otherwise "open
   externally", which already exists.
5. **Headless GPU in CI**: Rune needs a GPU adapter for windows; headless
   `Runtime` tests may need software rendering. First task verifies this on
   this machine.
6. **Rich session transcripts**: rendering Markdown per message with streaming
   can cost frames; use the documented streaming path (`Markdown` re-render,
   growth stacks) and cap re-renders.
7. **Two apps, one data dir**: running Electron and the native app at once could
   touch the same Copilot home. The native app takes a lock file in the data
   dir, which guards native-vs-native only; Electron writes no such lock and
   will not be changed for this. During dogfooding, quit one before opening a
   ticket in the other. This is a documented limitation, not a build item.
