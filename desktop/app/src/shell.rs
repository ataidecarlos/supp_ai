use rune::tok::{self, type_};
use rune::{El, col, row, text};

use crate::state::State;

pub fn view(s: &State, _: &mut rune::Cx<State>) -> El {
    let t = tok::theme(true);
    row().w_full().h_full().fill(t.bg)
        .child(strip(s, t))
        .child(pane("session", Some(380.0), format!("Session \u{2014} {}", s.active.0), t))
        .child(pane("document", None, format!("Document \u{2014} {}", s.active.0), t).grow(1.0))
        .child(pane("tree", Some(260.0), "Files".to_string(), t))
}

fn strip(s: &State, t: tok::Theme) -> El {
    let mut list = col().key("strip").w(72.0).min_h(0.0).h_full().gap(4.0).padding(6.0).fill(t.card);
    for ticket in &s.tickets {
        let selected = ticket.id == s.active;
        list = list.child(
            text(&ticket.name).font(type_::SECTION).color(if selected { t.text } else { t.text_secondary })
                .key(format!("strip/ticket-{}", ticket.id.0))
                .px(6.0).py(8.0)
                .radius(tok::radius::SM),
        );
    }
    list
}

fn pane(key: &str, width: Option<f32>, label: String, t: tok::Theme) -> El {
    let mut p = col().key(key).min_h(0.0).h_full().padding(16.0).gap(8.0).fill(t.bg);
    if let Some(width) = width {
        p = p.w(width);
    }
    p.child(text(label).font(type_::TITLE).color(t.text))
        .child(text("Placeholder pane for the Rune skeleton.").font(type_::BODY).color(t.text_secondary))
}
