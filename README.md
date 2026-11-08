# Support Workspace

A Windows-first desktop workspace for support engineers working alongside **GitHub Copilot CLI**. Each ticket keeps its own files, conversation history, agent process, and permissions.

## Run

Prerequisites: Node.js 24 or later, npm, and a GitHub Copilot subscription with an installed, authenticated CLI that supports ACP session loading. Development was verified with Copilot CLI 1.0.100.

```powershell
copilot --version
copilot login
npm install
npm run build
npm start
```

For renderer hot reload:

```powershell
npm run dev
```

Main/preload changes require restarting the development command.

Create a portable Windows executable with `npm run package`. The output goes into [release](./release), with the target architecture in its filename (ARM64 on this machine). It is an unsigned local build; Windows may display a publisher warning. The packaged app asks for the tickets root on first launch rather than bundling ticket evidence.

## Ticket layout

```text
tickets\
  ticket_123\
    ticket_123.md
    evidence.log
    screenshot.png
  ticket_124\
    124.md
```

Choose the folder **containing** the ticket folders. A unique matching `<folder name>.md` or `<ticket number>.md` opens as the main summary. Missing or ambiguous summaries require explicit selection. Files are never renamed automatically.

The summary can contain customer environment, symptoms, exact errors, affected timestamps and time zones, diagnostics, hypotheses, attempted steps, and relative links to attachments. This version does not enforce a template or invent ticket contents.

## Workflow

- Select a ticket to open its summary and independent Copilot conversation.
- Use **Document** for visual editing, or **Markdown** for source editing. Supported visual content includes headings, lists, links, tables, images, and fenced code. Unsupported or lossy Markdown stays in source mode.
- Edits auto-save after a short debounce. Saving, failures, and conflicts are visible. Opening a file alone does not rewrite it.
- Toggle the normally hidden file pane to browse or import evidence. Imports copy selected files into the ticket; filename collisions require confirmation.
- Markdown is editable. Logs, text, JSON, and JSONL are read-only evidence previews. Common raster images are previewable. Other formats can open in their system viewer with approval.
- Send a chat message or choose a troubleshooting suggestion. Only the installed Copilot CLI handles AI operations; there is no alternate provider or direct model API.
- Switch tickets while Copilot works. Background progress and pending approvals remain attached to the originating ticket.
- Use **New conversation** to start fresh without deleting prior conversations. The conversation selector restores earlier ones. Stop an active turn before changing its conversation.
- In-ticket file edits are automatically approved. Identifiable writes to the open file show a banner and temporarily pause editing.
- External or unclassified operations require a ticket-specific, one-time approval. Always inspect commands and paths, including approval requests from background tickets.

## File safety and limits

Auto-save checks the disk revision before writing. Known agent writes hold file leases so editor saves cannot race them. If another writer changes a dirty file, auto-save pauses and shows **Use disk version** / **Keep my version** with a disk-version comparison. Failed drafts and the latest pre-write version are retained in local app data; recoverable drafts reopen with the editor.

Normal ticket/file switches and app exit flush pending editor saves. A save failure or unresolved conflict blocks the transition rather than discarding changes.

Preview limits are 2 MiB for text/Markdown, 10 MiB for raster images, and 5,000 files per ticket. Large or unsupported files receive an explicit unsupported-preview state. HTML/scripts are not rendered as active content; remote images are not fetched automatically, and executable attachments cannot be launched from the app.

## Context isolation is not sandboxing

Each ticket gets a dedicated Copilot process, working directory, and `COPILOT_HOME`. The app disables inherited custom instructions and built-in MCP integrations, avoids globally latest-session selection, and never automatically imports existing JSONL attachments as conversations.

This is **context and permission isolation**, not an OS filesystem sandbox. The CLI still runs with your machine's privileges. Commands can affect resources outside their working directory; they always require explicit approval. Approving an external operation authorizes its effects, so inspect it carefully. File watchers cannot provide transactional locking against arbitrary external programs or shell commands.

App-owned history and Copilot state stay local. Copilot necessarily sends requested context to its service when you use chat. The app does not store credentials itself; Copilot manages authentication. Sensitive customer evidence should follow your organization's Copilot usage policy.

Closing the app stops its Copilot processes; completed changes remain and conversations resume after restart. Processes do not survive an ordinary app exit.

## Checks

```powershell
npm test
npm run typecheck
npm run build
npm run test:desktop
```

Automated checks use synthetic ticket fixtures, never the existing ticket evidence. The desktop smoke check requires the built app. To include a live, harmless Copilot conversation in the smoke test:

```powershell
$env:RUN_COPILOT_SMOKE = "1"
npm run test:desktop
```

Set `SUPPORT_SMOKE_EXECUTABLE` to an unpacked packaged app executable to test the packaged build instead of the development Electron binary.

## Troubleshooting

- **CLI unavailable/authentication failure:** install GitHub Copilot CLI, run `copilot login`, and retry. The app reports startup/protocol errors rather than substituting mock responses.
- **ACP session restoration unavailable:** update the CLI. ACP is in preview; incompatible CLI changes must be handled explicitly.
- **Stale session:** retain old history and use New conversation if the CLI no longer has its saved session.
- **External change/conflict:** resolve the displayed versions before switching or exiting. If Copilot read an older file revision, its automatic edit is denied and reported; ask it to reread.
- **Missing saved folder:** choose the tickets root again. Corrupt app state is reported and is not silently reset.

Optional environment overrides (use absolute Windows paths):

```powershell
$env:COPILOT_CLI_PATH = "C:\path\to\copilot.exe"
$env:SUPPORT_TICKETS_ROOT = "C:\support\tickets"
$env:SUPPORT_DATA_DIR = "C:\support\workspace-state"
npm start
```

App data contains ticket-specific histories, Copilot homes, failed drafts, and recovery versions. Keep it protected like ticket evidence; do not include it in source control.
