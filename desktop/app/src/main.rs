use std::sync::atomic::Ordering;

use rune::Tx;
use suppai::{AppState, shell};

fn poll(state: &mut AppState, _clock: f64, _tx: &mut Tx) -> bool {
    state.dirty.swap(false, Ordering::SeqCst)
}

fn main() {
    rune::run(rune::AppSpec {
        poll: Some(poll),
        ..rune::AppSpec::new("Support Workspace", (1280.0, 800.0), AppState::init, shell::view)
    });
}
