mod support;

use rune::{Env, Runtime};
use suppai::{AppState, shell};

fn fixture() -> (std::path::PathBuf, std::path::PathBuf) {
    let root = support::tempdir();
    let data = support::tempdir();
    for (name, file, body) in [
        ("ticket_1", "ticket_1.md", "# First ticket\n\nAlpha body.\n"),
        ("ticket_2", "ticket_2.md", "# Second ticket\n\nBeta body.\n"),
    ] {
        let directory = root.join(name);
        std::fs::create_dir_all(directory.join("SQL Logs")).unwrap();
        std::fs::write(directory.join(file), body).unwrap();
        std::fs::write(directory.join("SQL Logs").join("log1.txt"), "entry\n").unwrap();
    }
    (data, root)
}

fn runtime() -> Runtime<AppState> {
    let (data, root) = fixture();
    let state = AppState::from_dirs(data, root);
    Runtime::new(state, shell::view, (1280.0, 800.0), Env { system_dark: true, scale: 2.0 })
}

#[test]
fn the_four_panes_render_left_to_right() {
    let mut rt = runtime();
    rt.frame(0.0);
    let x = |key: &str| rt.presented(key).unwrap_or_else(|| panic!("missing {key}")).0[0];
    assert!(x("strip") < x("session"));
    assert!(x("session") < x("document"));
    assert!(x("document") < x("tree"));
}

#[test]
fn clicking_the_strip_switches_ticket_and_loads_its_summary() {
    let mut rt = runtime();
    rt.frame(0.0);
    assert_eq!(rt.state.tickets[rt.state.active].name, "ticket_1");
    let (x, y) = rt.find("strip/ticket-1").expect("second ticket row");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..4 {
        rt.frame(1.0 / 60.0);
    }
    assert_eq!(rt.state.active, 1);
    let document = rt.state.document.as_ref().expect("document loaded");
    assert!(document.path.ends_with("ticket_2.md"));
    assert!(document.content.contains("Beta body"));
}

#[test]
fn opening_a_tree_file_loads_it() {
    let mut rt = runtime();
    rt.frame(0.0);
    rt.state.open_file("SQL Logs\\log1.txt");
    rt.frame(1.0 / 60.0);
    let document = rt.state.document.as_ref().unwrap();
    assert_eq!(document.path, "SQL Logs\\log1.txt");
    assert_eq!(document.kind, suppai::core::files::FileKind::Text);
    assert!(document.content.contains("entry"));
}
