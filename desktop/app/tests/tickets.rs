mod support;

use suppai::core::tickets::{discover_tickets, list_files, resolve, ticket_id};

fn fixture() -> (std::path::PathBuf, std::path::PathBuf) {
    let root = support::tempdir();
    let data = support::tempdir();
    for (name, files) in [
        ("ticket_2", vec!["ticket_2.md", "evidence.log"]),
        ("ticket_10", vec!["ticket_10.md"]),
        ("ticket_B", vec!["notes.md", "other.md"]),
        ("no_main", vec!["a.md", "b.md"]),
    ] {
        let directory = root.join(name);
        std::fs::create_dir_all(&directory).unwrap();
        for file in files {
            std::fs::write(directory.join(file), "# synthetic\n").unwrap();
        }
    }
    (root, data)
}

#[test]
fn ids_are_stable_twenty_four_hex_chars() {
    let (root, data) = fixture();
    let tickets = discover_tickets(&root, &data).unwrap();
    assert_eq!(tickets.len(), 4);
    for ticket in &tickets {
        assert_eq!(ticket.id.len(), 24);
        assert!(ticket.id.chars().all(|character| character.is_ascii_hexdigit()));
        assert_eq!(ticket.id, ticket_id(&ticket.root));
    }
}

#[test]
fn tickets_sort_naturally() {
    let (root, data) = fixture();
    let names: Vec<String> = discover_tickets(&root, &data)
        .unwrap()
        .into_iter()
        .map(|ticket| ticket.name)
        .collect();
    assert_eq!(names, vec!["no_main", "ticket_2", "ticket_10", "ticket_B"]);
}

#[test]
fn main_summary_requires_one_unambiguous_match() {
    let (root, data) = fixture();
    let tickets = discover_tickets(&root, &data).unwrap();
    let named = tickets.iter().find(|ticket| ticket.name == "ticket_2").unwrap();
    assert_eq!(named.main_file.as_deref(), Some("ticket_2.md"));
    assert_eq!(named.main_candidates, vec!["ticket_2.md"]);
    let ambiguous = tickets.iter().find(|ticket| ticket.name == "no_main").unwrap();
    assert!(ambiguous.main_file.is_none());
    assert_eq!(ambiguous.main_candidates.len(), 2);
}

#[test]
fn a_saved_selection_overrides_discovery() {
    let (root, data) = fixture();
    let tickets = discover_tickets(&root, &data).unwrap();
    let ambiguous = tickets.iter().find(|ticket| ticket.name == "no_main").unwrap();
    let saved = data.join("tickets").join(&ambiguous.id);
    std::fs::create_dir_all(&saved).unwrap();
    std::fs::write(saved.join("ticket.json"), r#"{"mainFile":"b.md"}"#).unwrap();
    let refreshed = discover_tickets(&root, &data).unwrap();
    let ambiguous = refreshed.iter().find(|ticket| ticket.name == "no_main").unwrap();
    assert_eq!(ambiguous.main_file.as_deref(), Some("b.md"));
}

#[test]
fn resolve_rejects_escapes_and_absolute_paths() {
    let (root, data) = fixture();
    let ticket = discover_tickets(&root, &data).unwrap().remove(0);
    for bad in ["..\\other.md", "../other.md", "C:\\Windows\\win.ini", "/etc/passwd", ""] {
        assert!(resolve(&ticket, bad, false).is_err(), "accepted {bad}");
    }
    assert!(resolve(&ticket, "a.md", false).is_ok());
    let ok = resolve(&ticket, "2024\\notes.md", true).unwrap();
    assert!(ok.ends_with("notes.md"));
}

#[test]
fn listing_skips_dotfiles_and_sorts_naturally() {
    let root = support::tempdir();
    let data = support::tempdir();
    let directory = root.join("ticket_1");
    std::fs::create_dir_all(directory.join("SQL Logs")).unwrap();
    std::fs::write(directory.join("ticket_1.md"), "# main\n").unwrap();
    std::fs::write(directory.join(".hidden"), "no").unwrap();
    for name in ["log10.txt", "log2.txt"] {
        std::fs::write(directory.join("SQL Logs").join(name), "entry\n").unwrap();
    }
    let ticket = discover_tickets(&root, &data).unwrap().remove(0);
    let files = list_files(&ticket).unwrap();
    let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(paths.len(), 3);
    assert!(paths.iter().all(|path| !path.contains(".hidden")));
    let logs: Vec<&str> = paths.iter().copied().filter(|path| path.contains("SQL Logs")).collect();
    assert_eq!(logs, vec!["SQL Logs\\log2.txt", "SQL Logs\\log10.txt"]);
}
