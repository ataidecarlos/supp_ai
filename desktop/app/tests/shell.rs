use rune::{Env, Runtime};
use suppai::{State, shell};

#[test]
fn four_panes_render_left_to_right() {
    let env = Env { system_dark: true, scale: 2.0 };
    let mut rt = Runtime::new(State::demo(), shell::view, (1280.0, 800.0), env);
    rt.frame(0.0);
    let x = |key: &str| rt.presented(key).unwrap_or_else(|| panic!("missing {key}")).0[0];
    assert!(x("strip") < x("session"), "strip before session");
    assert!(x("session") < x("document"), "session before document");
    assert!(x("document") < x("tree"), "document before tree");
}
