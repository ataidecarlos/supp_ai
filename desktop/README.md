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
| UI | `shell.rs`, `state.rs` | Four-pane skeleton only (strip, session, document, tree placeholders). |

Tests run the synthetic CLI at `../tests/fixtures/fake-cli.mjs` through Node, so
`node` must be on `PATH`.

## What remains

Tasks 7–10 of the plan: wire the state to the real panes (ticket strip,
`FileTree`, `Markdown` render, `TextArea` editing with conflicts, session
transcript and approvals, insert into document, links, image preview, quit
flush, single-instance lock, README/parity pass).

## Compatibility

Ticket ids, `history.json`, drafts, recovery files and per-ticket `copilot/`
homes match the Electron app, so conversations started there can be attached
here once the UI is wired. Do not run both apps against the same data directory
at once; the native lock cannot detect Electron.
