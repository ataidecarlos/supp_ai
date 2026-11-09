mod support;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use suppai::core::agent::{Activity, AgentHandle, Launch, SharedView, TicketView, spawn_agent};
use suppai::core::files::Store;
use suppai::core::tickets::{Ticket, discover_tickets};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/fake-cli.mjs")
}

fn launch() -> Launch {
    Launch::new("node", &[fixture().to_string_lossy().as_ref()])
}

struct Harness {
    handle: AgentHandle,
    view: SharedView,
    ticket: Ticket,
    data: PathBuf,
}

fn setup() -> Harness {
    let root = support::tempdir();
    let data = support::tempdir();
    let ticket_root = root.join("ticket_1");
    std::fs::create_dir_all(&ticket_root).unwrap();
    std::fs::write(ticket_root.join("ticket_1.md"), "# Main\n").unwrap();
    std::fs::write(ticket_root.join("main.md"), "# Main\n").unwrap();
    std::fs::write(ticket_root.join("second.md"), "# Second\n").unwrap();
    let ticket = discover_tickets(&root, &data).unwrap().remove(0);
    let store = Store::new(data.clone());
    let (handle, view) = spawn_agent(ticket.clone(), data.clone(), store, launch(), Box::new(|| {})).unwrap();
    Harness { handle, view, ticket, data }
}

fn wait_for(view: &SharedView, condition: impl Fn(&TicketView) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if condition(&view.lock().unwrap()) {
            return;
        }
        if Instant::now() > deadline {
            panic!("condition did not hold; view: {:?}", view.lock().unwrap().activity);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn a_prompt_streams_a_message_and_completes() {
    let h = setup();
    h.handle.send("hello synthetic");
    wait_for(&h.view, |view| view.activity == Activity::Completed);
    let text: String = h.view.lock().unwrap().messages().iter().map(|message| message.text.clone()).collect();
    assert!(text.contains("FAKE"), "got {text}");
    assert!(text.contains("hello synthetic"), "got {text}");
}

#[test]
fn local_edits_are_auto_approved_and_produce_tool_activity() {
    let h = setup();
    h.handle.send("[EDIT]");
    wait_for(&h.view, |view| view.activity == Activity::Completed);
    let view = h.view.lock().unwrap();
    assert!(view.tools.iter().any(|tool| tool.kind == "edit"), "tools: {:?}", view.tools);
    assert!(view.approvals.is_empty());
    drop(view);
    let content = std::fs::read_to_string(h.ticket.root.join("main.md")).unwrap();
    let messages: Vec<String> = h.view.lock().unwrap().messages().iter().map(|message| message.text.clone()).collect();
    assert!(content.contains("Agent changed"), "content: {content} messages: {messages:?}");
}

#[test]
fn external_operations_wait_for_an_approval() {
    let h = setup();
    h.handle.send("[EXTERNAL]");
    wait_for(&h.view, |view| !view.approvals.is_empty());
    let approval = h.view.lock().unwrap().approvals[0].clone();
    assert_eq!(approval.options[0].0, "allow_once");
    h.handle.approve(approval.id, Some("allow_once".into()));
    wait_for(&h.view, |view| view.activity == Activity::Completed);
    let text: String = h.view.lock().unwrap().messages().iter().map(|message| message.text.clone()).collect();
    assert!(text.contains("Permission selected: allow_once"), "got {text}");
}

#[test]
fn stop_returns_the_ticket_to_idle() {
    let h = setup();
    h.handle.send("[DELAY] stay");
    wait_for(&h.view, |view| view.activity == Activity::Running);
    h.handle.stop();
    wait_for(&h.view, |view| !matches!(view.activity, Activity::Running | Activity::Starting | Activity::Approval));
}

#[test]
fn discovery_lists_only_this_tickets_sessions() {
    let h = setup();
    h.handle.send("seed a session");
    wait_for(&h.view, |view| view.activity == Activity::Completed);
    h.handle.discover();
    wait_for(&h.view, |view| !view.discovered.is_empty());
    assert_eq!(h.view.lock().unwrap().discovered.len(), 1);
}

#[test]
fn attach_replays_a_foreign_session_once_and_rejects_duplicates() {
    let h = setup();
    let home = h.data.join("tickets").join(&h.ticket.id).join("copilot");
    std::fs::create_dir_all(&home).unwrap();
    let store = serde_json::json!({
        "external-1": {
            "cwd": h.ticket.root.to_string_lossy(),
            "history": [
                { "role": "user", "text": "replayed-marker" },
                { "role": "agent", "text": "old reply" }
            ],
            "title": "External session",
            "updatedAt": "2026-11-01T10:00:00.000Z"
        }
    });
    std::fs::write(home.join("fake-sessions.json"), store.to_string()).unwrap();
    h.handle.discover();
    wait_for(&h.view, |view| !view.discovered.is_empty());
    h.handle.attach("external-1");
    wait_for(&h.view, |view| view.messages().iter().any(|message| message.text.contains("replayed-marker")));
    let conversations = h.view.lock().unwrap().history.conversations.len();
    assert_eq!(conversations, 1);
    h.handle.attach("external-1");
    wait_for(&h.view, |view| view.error.as_deref().is_some_and(|error| error.contains("already attached")));
}

#[test]
fn shutdown_stops_the_worker() {
    let h = setup();
    h.handle.send("hello");
    wait_for(&h.view, |view| view.activity == Activity::Completed);
    let started = Instant::now();
    h.handle.shutdown();
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn a_missing_cli_surfaces_a_failed_ticket() {
    let root = support::tempdir();
    let data = support::tempdir();
    let ticket_root = root.join("ticket_1");
    std::fs::create_dir_all(&ticket_root).unwrap();
    std::fs::write(ticket_root.join("ticket_1.md"), "# Main\n").unwrap();
    let ticket = discover_tickets(&root, &data).unwrap().remove(0);
    let (handle, view) = spawn_agent(
        ticket,
        data,
        Store::new(support::tempdir()),
        Launch::new("definitely-missing-copilot-binary", &[]),
        Box::new(|| {}),
    )
    .unwrap();
    handle.send("hello");
    wait_for(&view, |view| view.activity == Activity::Failed);
    assert!(view.lock().unwrap().error.as_deref().unwrap().contains("Cannot start"));
}
