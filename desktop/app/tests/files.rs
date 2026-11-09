mod support;

use suppai::core::files::{FileKind, Store};
use suppai::core::tickets::discover_tickets;

fn setup() -> (Store, suppai::core::tickets::Ticket) {
    let root = support::tempdir();
    let data = support::tempdir();
    let ticket_root = root.join("ticket_1");
    std::fs::create_dir_all(&ticket_root).unwrap();
    std::fs::write(ticket_root.join("ticket_1.md"), "# Main\n\nOriginal.\n").unwrap();
    std::fs::write(ticket_root.join("evidence.log"), "line one\n").unwrap();
    let ticket = discover_tickets(&root, &data).unwrap().remove(0);
    (Store::new(data), ticket)
}

#[test]
fn read_reports_kind_and_revision() {
    let (store, ticket) = setup();
    let document = store.read(&ticket, "ticket_1.md").unwrap();
    assert_eq!(document.kind, FileKind::Markdown);
    assert_eq!(document.content, "# Main\n\nOriginal.\n");
    assert!(!document.revision.is_empty());
    let log = store.read(&ticket, "evidence.log").unwrap();
    assert_eq!(log.kind, FileKind::Text);
}

#[test]
fn stale_revision_is_rejected_and_the_file_is_untouched() {
    let (store, ticket) = setup();
    let document = store.read(&ticket, "ticket_1.md").unwrap();
    std::fs::write(ticket.root.join("ticket_1.md"), "# Changed elsewhere\n").unwrap();
    let error = store.save(&ticket, "ticket_1.md", "# Mine\n", &document.revision).unwrap_err();
    assert_eq!(error.code, "CONFLICT");
    assert_eq!(std::fs::read_to_string(ticket.root.join("ticket_1.md")).unwrap(), "# Changed elsewhere\n");
}

#[test]
fn save_updates_the_revision_and_clears_the_draft() {
    let (store, ticket) = setup();
    let document = store.read(&ticket, "ticket_1.md").unwrap();
    let saved = store.save(&ticket, "ticket_1.md", "# Main\n\nEdited.\n", &document.revision).unwrap();
    assert_eq!(saved.content, "# Main\n\nEdited.\n");
    assert_ne!(saved.revision, document.revision);
    assert!(!store.draft_path(&ticket, "ticket_1.md").exists());
    let recovery = store.recovery_path(&ticket, "ticket_1.md");
    assert!(recovery.exists());
}

#[test]
fn oversized_documents_are_rejected() {
    let (store, ticket) = setup();
    let document = store.read(&ticket, "ticket_1.md").unwrap();
    let huge = "x".repeat(2 * 1024 * 1024 + 1);
    let error = store.save(&ticket, "ticket_1.md", &huge, &document.revision).unwrap_err();
    assert_eq!(error.code, "LIMIT");
}

#[test]
fn concurrent_saves_allow_exactly_one_winner() {
    let (store, ticket) = setup();
    let document = store.read(&ticket, "ticket_1.md").unwrap();
    let revision = document.revision.clone();
    let first = std::thread::spawn({
        let store = store.clone();
        let ticket = ticket.clone();
        let revision = revision.clone();
        move || store.save(&ticket, "ticket_1.md", "# One\n", &revision)
    });
    let second = std::thread::spawn({
        let store = store.clone();
        let ticket = ticket.clone();
        let revision = revision.clone();
        move || store.save(&ticket, "ticket_1.md", "# Two\n", &revision)
    });
    let results = [first.join().unwrap(), second.join().unwrap()];
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(results.iter().any(|result| result.as_ref().is_err_and(|error| error.code == "CONFLICT")));
}

#[test]
fn an_agent_lease_pauses_saves_until_released() {
    let (store, ticket) = setup();
    let document = store.read(&ticket, "ticket_1.md").unwrap();
    let target = ticket.root.join("ticket_1.md");
    let lease = store.begin_agent_edit(&ticket, &[target.clone()], &Default::default()).unwrap();
    let error = store.save(&ticket, "ticket_1.md", "# Blocked\n", &document.revision).unwrap_err();
    assert_eq!(error.code, "BUSY");
    drop(lease);
    assert!(store.save(&ticket, "ticket_1.md", "# Allowed\n", &document.revision).is_ok());
}

#[test]
fn a_read_revision_mismatch_denies_the_edit() {
    let (store, ticket) = setup();
    let target = ticket.root.join("ticket_1.md");
    std::fs::write(&target, "# Someone else\n").unwrap();
    let mut expected = std::collections::HashMap::new();
    expected.insert(target.clone(), "not-the-current-revision".to_string());
    let error = store.begin_agent_edit(&ticket, &[target], &expected).unwrap_err();
    assert_eq!(error.code, "CONFLICT");
}
