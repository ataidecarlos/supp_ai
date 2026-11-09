mod support;

use suppai::{AppState, SaveStatus};

fn state() -> (AppState, std::path::PathBuf, std::path::PathBuf) {
    let root = support::tempdir();
    let data = support::tempdir();
    let first = root.join("ticket_1");
    let second = root.join("ticket_2");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    std::fs::write(first.join("ticket_1.md"), "# Main\n\nOriginal.\n").unwrap();
    std::fs::write(first.join("evidence.log"), "line one\n").unwrap();
    std::fs::write(second.join("ticket_2.md"), "# Second\n").unwrap();
    (AppState::from_dirs(data, root), first, second)
}

fn edit(state: &mut AppState, body: &str) {
    state.open_file("ticket_1.md");
    state.toggle_editing();
    state.editor.replace_text(body);
    state.editor_changed();
}

#[test]
fn autosave_writes_after_the_debounce() {
    let (mut state, first, _) = state();
    edit(&mut state, "# Edited\n");
    assert_eq!(state.status, SaveStatus::Unsaved);
    state.poll_saves(0.7);
    assert_eq!(state.status, SaveStatus::Saved);
    assert_eq!(std::fs::read_to_string(first.join("ticket_1.md")).unwrap(), "# Edited\n");
}

#[test]
fn flush_writes_a_pending_edit_immediately() {
    let (mut state, first, _) = state();
    edit(&mut state, "# Flushed\n");
    assert!(state.flush());
    assert_eq!(std::fs::read_to_string(first.join("ticket_1.md")).unwrap(), "# Flushed\n");
}

#[test]
fn an_external_write_raises_a_conflict_and_keep_mine_wins() {
    let (mut state, first, _) = state();
    edit(&mut state, "# Mine\n");
    std::fs::write(first.join("ticket_1.md"), "# Theirs\n").unwrap();
    state.poll_saves(1.0);
    assert_eq!(state.status, SaveStatus::Conflict);
    assert!(state.conflict.is_some());
    state.keep_mine();
    assert_eq!(state.status, SaveStatus::Saved);
    assert_eq!(std::fs::read_to_string(first.join("ticket_1.md")).unwrap(), "# Mine\n");
}

#[test]
fn use_disk_discards_the_local_edit() {
    let (mut state, first, _) = state();
    edit(&mut state, "# Mine\n");
    std::fs::write(first.join("ticket_1.md"), "# Theirs\n").unwrap();
    state.poll_saves(1.0);
    state.use_disk();
    assert_eq!(state.status, SaveStatus::Saved);
    assert_eq!(state.editor.text, "# Theirs\n");
    assert_eq!(std::fs::read_to_string(first.join("ticket_1.md")).unwrap(), "# Theirs\n");
}

#[test]
fn a_conflict_blocks_switching_tickets() {
    let (mut state, first, _) = state();
    edit(&mut state, "# Mine\n");
    std::fs::write(first.join("ticket_1.md"), "# Theirs\n").unwrap();
    state.poll_saves(1.0);
    state.select_ticket(1);
    assert_eq!(state.active, 0);
    assert!(state.error.as_deref().unwrap_or_default().contains("Resolve"));
}

#[test]
fn insert_appends_a_copilot_message_and_autosaves() {
    let (mut state, first, _) = state();
    state.open_file("ticket_1.md");
    state.insert_message("Copilot suggested outline");
    assert!(state.editing);
    assert!(state.editor.text.contains("Copilot suggested outline"));
    state.poll_saves(1.0);
    assert!(std::fs::read_to_string(first.join("ticket_1.md")).unwrap().contains("Copilot suggested outline"));
}

#[test]
fn a_relative_link_opens_the_attachment() {
    let (mut state, _, _) = state();
    state.open_file("ticket_1.md");
    state.open_link("evidence.log");
    assert_eq!(state.document.as_ref().unwrap().path, "evidence.log");
}

#[test]
fn oversized_documents_surface_a_save_failure() {
    let (mut state, _, _) = state();
    edit(&mut state, &"x".repeat(2 * 1024 * 1024 + 1));
    state.poll_saves(1.0);
    assert!(matches!(state.status, SaveStatus::Failed(_)));
}
