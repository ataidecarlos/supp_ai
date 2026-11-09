use suppai::{State, shell};

fn main() {
    rune::run(rune::AppSpec::new("Support Workspace", (1280.0, 800.0), State::demo, shell::view));
}
