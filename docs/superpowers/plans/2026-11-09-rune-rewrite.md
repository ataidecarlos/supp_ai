# Rune Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a native Rust desktop app on Rune that replaces the Electron shell for the Support Workspace, keeping Copilot-CLI-only AI, per-ticket isolation, and the same on-disk state.

**Architecture:** One native process. Rune owns the UI thread and frame loop; each ticket gets a worker thread that spawns and speaks ACP to its own `copilot --acp` child, plus a file-watch/persistence worker. Workers send events over `mpsc`; the UI drains them in `AppSpec::poll`.

**Tech Stack:** Rust 1.98, Rune (git, pinned `dev` rev `e970367b`), rune-kit, serde/serde_json, sha2, notify, image.

**Spec:** `docs/superpowers/specs/2026-11-09-rune-rewrite-design.md`

## Global Constraints

- All AI output comes from the installed GitHub Copilot CLI over ACP. No model API, no mock fallback.
- Copilot args and env match `src/main/sessions.ts`: `--acp --stdio --disable-builtin-mcps --disallow-temp-dir --no-custom-instructions --no-auto-update --dynamic-retrieval skills=off`; per-ticket `COPILOT_HOME=<dataDir>/tickets/<id>/copilot`; `COPILOT_ALLOW_ALL=false`; delete `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`; pass provider env through unchanged.
- Ticket id = first 24 hex chars of sha256 of the canonical ticket path, lowercased on Windows.
- Data compatibility: `~/.suppai/config.json`, `<dataDir>/tickets/<id>/history.json`, drafts, recovery and `copilot/` keep their current paths and shapes.
- Path safety: every resolved path stays inside the ticket; no absolute paths, `..`, or symlink escapes; 2 MiB Markdown save cap; 5,000-file listing cap; 10 MiB image cap.
- Rune is pre-release: pin the rev in `desktop/Cargo.toml`, never "latest".
- Windows-first; the crate must also build for macOS/Linux where it costs nothing.
- The Electron app stays untouched and working; all new code lives under `desktop/`.

## Review Focus

- Unsaved edits survive ticket switch, file switch, and quit (flush/blocking rules).
- A background ticket waiting for approval stays visible on the strip without opening it.
- A session from another ticket or working directory can never be attached.
- A malformed `config.json` is reported and never overwritten; unknown keys survive writes.
- A Copilot child never outlives the app or wedges a ticket in "working" after a crash.

---

### Task 0: Rune skeleton and headless proof

**Files:**
- Create: `desktop/Cargo.toml`
- Create: `desktop/app/Cargo.toml`
- Create: `desktop/app/src/main.rs`
- Create: `desktop/app/tests/shell.rs`
- Create: `desktop/.gitignore`

**Interfaces:**
- Produces: a compiling four-pane shell with keys `strip`, `session`, `document`, `tree`; `cargo test` and `cargo run -- --snap` both work.

- [ ] **Step 1: Create the workspace and pin Rune**

`desktop/Cargo.toml`:

```toml
[workspace]
members = ["app"]
resolver = "2"

[workspace.package]
edition = "2024"
license = "MIT"

[workspace.dependencies]
rune = { git = "https://github.com/anomalyco/rune", rev = "e970367bd7d2a51e2e7d58e2978ea32eac7780cb" }
rune-kit = { git = "https://github.com/anomalyco/rune", rev = "e970367bd7d2a51e2e7d58e2978ea32eac7780cb", features = ["markdown"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sha2 = "0.10"
notify = "8"
```

`desktop/app/Cargo.toml`:

```toml
[package]
name = "suppai"
version = "0.1.0"
edition.workspace = true
license.workspace = true

[dependencies]
rune.workspace = true
rune-kit.workspace = true
serde.workspace = true
serde_json.workspace = true
sha2.workspace = true
notify.workspace = true
```

`desktop/.gitignore`: `target/`

- [ ] **Step 2: Write the failing headless test**

`desktop/app/tests/shell.rs` renders the view through Rune's headless `Runtime` and asserts four panes in order:

```rust
use suppai::{shell, State};
use rune::{Env, Runtime};

#[test]
fn four_panes_render_left_to_right() {
    let env = Env { system_dark: true, scale: 2.0 };
    let mut rt = Runtime::new(State::demo(), shell::view, (1280.0, 800.0), env);
    rt.frame(0.0);
    let x = |key: &str| rt.presented(key).expect(key).0[0];
    assert!(x("strip") < x("session"));
    assert!(x("session") < x("document"));
    assert!(x("document") < x("tree"));
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cargo test -p suppai --test shell`
Expected: FAIL — crate has no `shell` or `State`.

- [ ] **Step 4: Build the smallest shell that passes**

`desktop/app/src/lib.rs` exposes `pub mod shell; pub mod state;` and `State::demo()` with one fake ticket. `shell::view` builds a bounded `row()` of four keyed columns with fixed widths for strip/tree and `grow(1.0)` for the middle, using `tok::theme(true)` colours and plain `text()` labels. If `rune_kit::shell::SplitView` cannot produce four panes without nesting, use the custom `row()` — record which in the commit message.

`src/main.rs` calls `rune::run(AppSpec::new("Support Workspace", (1280.0, 800.0), State::demo, shell::view))`.

- [ ] **Step 5: Verify build, test and headless render**

Run: `cargo test -p suppai`, then `cargo run -p suppai -- --snap desktop/target/shell.png`
Expected: 1 test passes; a PNG exists with four visible columns. Open the PNG and confirm.

- [ ] **Step 6: Commit**

```bash
git add desktop
git commit -m "Add the Rune shell skeleton"
```

Record the Rune rev actually resolved (`cargo tree -p rune | head -1`) in the commit body.

---

### Task 1: Config and settings

**Files:**
- Create: `desktop/app/src/core/mod.rs`, `desktop/app/src/core/config.rs`, `desktop/app/src/core/settings.rs`, `desktop/app/src/core/error.rs`
- Test: `desktop/app/tests/config.rs`

**Interfaces:**
- Produces: `Config { chat_side: Side, files_side: Side, files_hidden: bool, pane_widths: Option<PaneWidths> }`, `read_config(dir: &Path) -> Result<Config, Error>`, `write_config(dir: &Path, patch: ConfigPatch) -> Result<Config, Error>`, `read_settings(file: &Path) -> Result<Settings, Error>`, `write_settings(file: &Path, &Settings) -> Result<(), Error>`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn malformed_config_is_reported_and_not_overwritten() {
    let dir = tempdir();
    std::fs::write(dir.join("config.json"), "{ nope").unwrap();
    assert!(read_config(&dir).is_err());
    assert!(write_config(&dir, ConfigPatch { files_hidden: Some(true) }).is_err());
    assert_eq!(std::fs::read_to_string(dir.join("config.json")).unwrap(), "{ nope");
}

#[test]
fn unknown_keys_survive_a_write() {
    let dir = tempdir();
    std::fs::write(dir.join("config.json"), r#"{"future":true,"chatSide":"right"}"#).unwrap();
    let cfg = write_config(&dir, ConfigPatch { files_hidden: Some(true) }).unwrap();
    assert!(cfg.files_hidden);
    let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(dir.join("config.json")).unwrap()).unwrap();
    assert_eq!(raw["future"], true);
    assert_eq!(raw["chatSide"], "right");
}

#[test]
fn settings_accept_a_null_root() {
    let path = tempdir().join("settings.json");
    std::fs::write(&path, r#"{"root":null,"lastTicketId":null}"#).unwrap();
    let s = read_settings(&path).unwrap();
    assert!(s.root.is_none() && s.last_ticket_id.is_none());
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p suppai --test config`, expect missing module errors.

- [ ] **Step 3: Implement with serde + atomic write**

`Error { code: &'static str, message: String }` with `Display`. Atomic write = temp file in the same directory + `rename`. `write_config` reads the raw `serde_json::Map`, merges known keys, preserves everything else, writes pretty JSON. Malformed JSON is an error; never overwrite. `read_config` returns defaults when the file is absent.

- [ ] **Step 4: Run the test** — `cargo test -p suppai --test config` → 3 pass.

- [ ] **Step 5: Commit** — `git add desktop && git commit -m "Port config and settings to Rust"`

---

### Task 2: Tickets, ids and path safety

**Files:**
- Create: `desktop/app/src/core/tickets.rs`
- Test: `desktop/app/tests/tickets.rs`

**Interfaces:**
- Produces: `Ticket { id, name, root: PathBuf, main_file: Option<String>, main_candidates: Vec<String> }`, `discover_tickets(root: &Path) -> Result<Vec<Ticket>, Error>`, `resolve(ticket: &Ticket, relative: &str, allow_new: bool) -> Result<PathBuf, Error>`, `list_files(ticket: &Ticket) -> Result<Vec<FileEntry>, Error>`, `inside(root, target) -> bool`.

- [ ] **Step 1: Write the failing tests** — a ticket id is 24 hex chars and matches the JS scheme (`sha256` of canonical path, lowercased on Windows); `resolve` rejects `..`, absolute paths and drive paths; a symlink out of the ticket is rejected; `list_files` skips dotfiles and enforces the 5,000 cap.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** with `sha2`, `std::fs::canonicalize`, and a `inside()` relative-path check mirroring `src/main/files.ts`.
- [ ] **Step 4: Run** — 5+ tests pass.
- [ ] **Step 5: Commit** — `git commit -m "Port ticket discovery and path safety"`

---

### Task 3: File read, save, drafts and recovery

**Files:**
- Create: `desktop/app/src/core/files.rs`
- Test: `desktop/app/tests/files.rs`

**Interfaces:**
- Produces: `FileDocument { path, kind: FileKind, content, revision, size, recovered_draft: Option<Draft> }`, `read_document(ticket, relative, data_dir) -> Result<FileDocument, Error>`, `save_document(ticket, relative, content, expected_revision, data_dir) -> Result<FileDocument, Error>`, `discard_draft(...)`, `Lease` guards for agent edits, `watch_ticket(ticket, tx) -> Watcher`.

- [ ] **Step 1: Write failing tests** — save rejects a stale revision with `code == "CONFLICT"`; a draft file is written before save and removed after; a 2 MiB+ document is rejected; concurrent saves using the same revision produce exactly one success; a read of `.log` returns `FileKind::Text`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** atomic temp+rename, sha256 revisions, draft journal under `tickets/<id>/drafts/`, recovery snapshot under `tickets/<id>/recovery/`, and an in-process per-path mutex.
- [ ] **Step 4: Run** — all pass.
- [ ] **Step 5: Commit** — `git commit -m "Port file safety to Rust"`

---

### Task 4: Conversation history

**Files:**
- Create: `desktop/app/src/core/history.rs`
- Test: `desktop/app/tests/history.rs`

**Interfaces:**
- Produces: `Conversation { id, created_at, title: Option<String>, session_id: Option<String>, messages: Vec<Message> }`, `History { conversations, current_id }`, `load_history(path) -> Result<History, Error>` (missing file = empty, invalid = `STATE` error), `save_history(path, &History)`.

- [ ] **Step 1: Write failing tests** — a file written by the Electron app loads unchanged, including `title` and `sessionId`; a non-string `title` is a `STATE` error; saving preserves unknown top-level keys.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** serde structs with `#[serde(other)]`-friendly defaults and the same validation as `conversation()` in `src/main/sessions.ts`.
- [ ] **Step 4: Run.**
- [ ] **Step 5: Commit** — `git commit -m "Port conversation history to Rust"`

---

### Task 5: ACP transport

**Files:**
- Create: `desktop/app/src/core/acp.rs`
- Test: `desktop/app/tests/acp.rs`

**Interfaces:**
- Produces: `AcpClient::spawn(command, args, cwd, env) -> Result<AcpClient>`, `request(method, params) -> Result<Value>`, `notify(method, params)`, `set_notification_handler(Box<dyn Fn(Value) + Send>)`, `set_permission_handler(Box<dyn Fn(Value) -> Value + Send>)`, `close()`. Internally one writer lock and one reader thread.

- [ ] **Step 1: Write the failing test against the existing synthetic CLI**

```rust
#[test]
fn initialize_and_list_against_the_synthetic_cli() {
    let home = tempdir();
    let cwd = tempdir();
    let mut client = AcpClient::spawn("node", &["tests/fixtures/fake-cli.mjs"], &cwd, home, extra_env()).unwrap();
    let init = client.request("initialize", json!({ "protocolVersion": 1, "clientCapabilities": {}, "clientInfo": { "name": "suppai", "version": "0.1.0" } })).unwrap();
    assert!(init["agentCapabilities"]["loadSession"].as_bool().unwrap());
    let new = client.request("session/new", json!({ "cwd": cwd, "mcpServers": [] })).unwrap();
    client.request("session/prompt", json!({ "sessionId": new["sessionId"], "prompt": [{ "type": "text", "text": "hello" }] })).unwrap();
    let list = client.request("session/list", json!({ "cwd": cwd })).unwrap();
    assert_eq!(list["sessions"].as_array().unwrap().len(), 1);
}
```

Use the repo's `tests/fixtures/fake-cli.mjs` with `COPILOT_HOME` set to the temp home and `FAKE_CLI_*` flags forwarded.

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** NDJSON framing (`serde_json::from_str` per line), a pending-request map keyed by id, a reader thread dispatching responses and server→client requests (`session/request_permission`) or notifications (`session/update`), a 60s initialize timeout, and a `close()` that kills the child and joins the reader.

The `agent-client-protocol` crate is the fallback if hand-rolling stalls; record the switch as a ruling.

- [ ] **Step 4: Run** — the test passes; add a second test that a crashed child (`[FAIL]`) makes pending requests error within the timeout.
- [ ] **Step 5: Commit** — `git commit -m "Add the ACP client transport"`

---

### Task 6: Per-ticket agent worker

**Files:**
- Create: `desktop/app/src/core/agent.rs`
- Test: `desktop/app/tests/agent.rs`

**Interfaces:**
- Produces: `AgentCommand::{ Send(String), Stop, NewConversation, Attach(String), Discover, Shutdown }`, `AgentEvent::{ Activity(Activity), Message { .. }, Tool { .. }, Approval { .. }, Conversations(..), Error(String) }`, `spawn_agent(ticket_id, ticket_root, data_dir, events: Sender<AgentEvent>) -> AgentHandle`.

- [ ] **Step 1: Write the failing tests (synthetic CLI)** — a prompt streams an agent message into history and returns to idle; `[EDIT]` produces tool activity and auto-advances; `[EXTERNAL]` emits an approval whose id can be answered; `Stop` cancels; `Discover` returns only sessions whose `cwd` equals the ticket root; `Attach` loads and captures replay exactly once; `Attach` of an unknown or already-attached session is an error; `Shutdown` kills the child (assert the process is gone).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the worker thread: connect on demand, initialize, `session/new` or `session/load`, prompt with the ticket preamble, map `session/update` into events, auto-approve local edit/read permissions (with read-revision tracking and leases), surface others, cancel with a 10s forced kill, replay capture capped at 1 MiB, discovery cache, and attach rollback on failure.
- [ ] **Step 4: Run.**
- [ ] **Step 5: Commit** — `git commit -m "Add per-ticket Copilot agent workers"`

---

### Task 7: Shell, strip, tree and document

**Files:**
- Modify: `desktop/app/src/ui/shell.rs`, `desktop/app/src/state.rs`
- Create: `desktop/app/src/ui/strip.rs`, `desktop/app/src/ui/tree.rs`, `desktop/app/src/ui/document.rs`
- Test: `desktop/app/tests/ui_shell.rs`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces: `State { tickets, active: Option<TicketId>, documents: HashMap<..>, tree: TreeModel, panes: PaneState }`; UI keys `strip/ticket-<id>`, `tree/file-<path>`, `document/content`, `document/edit`.

- [ ] **Step 1: Write failing headless tests** — clicking `strip/ticket-<id>` changes `active`; opening a folder in the tree expands it; selecting a file shows Markdown-rendered content; switching a file with a dirty editor is blocked with a `BUSY` error (call the core flush first).
- [ ] **Step 2: Run to verify failure (import errors).**
- [ ] **Step 3: Implement** the strip (activity dot + shield), `FileTree` model from `list_files`, `Markdown` render, and an Edit/Document toggle backed by `TextArea`; wire `tx.open_folder` for the ticket root and `notify` for external changes.
- [ ] **Step 4: Run** — headless tests pass; `cargo run -- --snap` shows the layout with fixture data.
- [ ] **Step 5: Commit** — `git commit -m "Build the ticket strip, tree and document panes"`

---

### Task 8: Session column and approvals

**Files:**
- Create: `desktop/app/src/ui/session.rs`
- Modify: `desktop/app/src/ui/shell.rs`, `desktop/app/src/state.rs`
- Test: `desktop/app/tests/ui_session.rs`

**Interfaces:**
- Consumes: Task 6 events.
- Produces: keys `session/title`, `session/message-<id>`, `session/approve-<id>-<option>`, `session/stop`, `session/new`, `session/find`; a conversation menu listing saved conversations.

- [ ] **Step 1: Write failing headless tests** — a `Message` event appends one row and keeps the scroll pinned to the bottom; an `Approval` event renders the card and clicking an option sends the mapped option id; a background ticket in `Approval` shows the shield on the strip while another ticket is active; the title menu lists conversations and selecting one switches the transcript.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the transcript (Markdown per agent message, plain user rows, notices, tool rows), composer (`Enter` sends, `Shift+Enter` newline, disabled while busy), and approval cards.
- [ ] **Step 4: Run.**
- [ ] **Step 5: Commit** — `git commit -m "Add the session transcript and approvals"`

---

### Task 9: Editing, conflicts and insert

**Files:**
- Modify: `desktop/app/src/ui/document.rs`, `desktop/app/src/ui/shell.rs`, `desktop/app/src/state.rs`
- Test: `desktop/app/tests/ui_edit.rs`

**Interfaces:**
- Produces: autosave on a 600 ms timer, conflict state with "Use disk version"/"Keep my version", `insert_into_document(text)` from a session message, and link handling in rendered Markdown.

- [ ] **Step 1: Write failing headless tests** — typing then advancing the virtual clock saves once; an external write while dirty raises the conflict UI and blocks switches; "Keep my version" saves and clears it; insert places the text at the caret and marks dirty; a relative link opens the file, an `https` link asks before opening.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** using Task 3 primitives and Rune's `TextArea`/`on_edit`; agent-edit state disables editing with a banner.
- [ ] **Step 4: Run.**
- [ ] **Step 5: Commit** — `git commit -m "Add document editing, conflicts and insert"`

---

### Task 10: Parity pass, lock, and docs

**Files:**
- Modify: `desktop/app/src/main.rs`, `desktop/app/src/state.rs`
- Create: `desktop/app/src/core/lock.rs`
- Test: `desktop/app/tests/parity.rs`
- Modify: `README.md`

- [ ] **Step 1: Write failing tests** — quit flushes a dirty document or refuses to exit; a stale lock file from a dead pid is reclaimed; a live lock refuses the second instance with a clear message; an image file renders in the document pane; a text evidence file renders read-only.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the lock, quit interception (`tx.close_window` → flush → exit), image decode with size caps, and README updates describing the native app, its commands, and the one-app-at-a-time rule.
- [ ] **Step 4: Run everything**

`cargo test -p suppai`, `cargo build --release`, `cargo run -p suppai -- --snap desktop/target/final.png`, plus a live check against the installed Copilot CLI and OpenCode Go provider (open a real ticket, send one prompt, approve one operation, edit a file).

- [ ] **Step 5: Commit** — `git commit -m "Finish the native workspace parity pass"`

---

## Self-review notes

- Spec coverage: goals 1–7 map to Tasks 2, 6, 7–9, 4/10. Config compatibility → 1. History compatibility → 4. Auto-attach/insert/links → 6, 9. Conversation switcher → 8. Lock limitation → 10. WYSIWYG is an explicit non-goal.
- TDD: every task's first step is a failing test with the exact assertion; ACP and UI tests run headless, so no display is needed.
- Deliberately unverified until Task 0: the exact `rune_kit` APIs for a four-pane split, image nodes, and the file-dialog callback names. Task 0 resolves them or records a fallback (custom `row()` of four columns).
- Deliberately deferred: packaging, web target, rich editor, and removing the Electron app.
- The synthetic CLI is Node-based; `node` must be on PATH to run `cargo test`.
