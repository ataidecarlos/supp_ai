# Support Workspace — native app (Rust + Rune)

This crate replaces the Electron shell with a native Rust app. It is in progress:
the core is ported and tested, the UI is still the four-pane skeleton.

Design: `../docs/superpowers/specs/2026-11-09-rune-rewrite-design.md`
Plan: `../docs/superpowers/plans/2026-11-09-rune-rewrite.md`

## Commands

```powershell
cd desktop
cargo test -p suppai                 # 39 tests, no display needed
cargo run -p suppai                  # opens the window
cargo run -p suppai -- --snap target/shell.png   # headless render
```

Rune is pinned to `dev` rev `e970367b` in `desktop/Cargo.toml`. Do not float it.

## What exists

| Area | Module | Notes |
|---|---|---|
| Config | `core/config.rs` | Same `~/.suppai/config.json` keys, unknown keys preserved, malformed never overwritten. |
| Settings | `core/settings.rs` | `root` accepts `null`; last ticket stored beside it. |
| Tickets | `core/tickets.rs` | Same 24-hex id scheme, natural sort, main-summary rules, path safety, 5,000-file cap. |
| Files | `core/files.rs` | Atomic saves, sha256 revisions, drafts, recovery snapshots, per-path locks, agent edit leases, imports. |
| History | `core/history.rs` | Reads and writes existing Electron `history.json`, including `title`/`sessionId`. |
| ACP | `core/acp.rs` | NDJSON JSON-RPC client, numeric and string ids, notifications, permission requests, crash handling. |
| Agent | `core/agent.rs` | Per-ticket worker: prompt streaming, tool updates, auto-approved local edits with leases, approvals, stop, new/select conversation, discovery, attach with replay capture, shutdown. |
| UI | `shell.rs`, `state.rs` | Four panes wired to real data: ticket strip with activity, session transcript + composer + approvals + attach list, rendered Markdown document, file tree. Document editing is not wired yet. |

Tests run the synthetic CLI at `../tests/fixtures/fake-cli.mjs` through Node, so
`node` must be on `PATH`.

## What remains

- Document editing: Edit/Document toggle, `TextArea`, autosave debounce, draft
  recovery and conflict resolution, insert-into-document, link handling.
- Image preview, "open externally", import button.
- Pane resizing/persistence (`SplitView` or drag handles) and the single-instance lock.
- Live check against the real Copilot CLI with a ticket on disk.
- Quit flush and parity checklist from the plan (Task 9–10).

## Compatibility

Ticket ids, `history.json`, drafts, recovery files and per-ticket `copilot/`
homes match the Electron app, so conversations started there can be attached
here once the UI is wired. Do not run both apps against the same data directory
at once; the native lock cannot detect Electron.
