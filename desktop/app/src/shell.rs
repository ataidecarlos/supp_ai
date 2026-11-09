use rune::tok::type_;
use rune::{El, ScrollSpec, Tx, col, el, row, text};
use rune_kit::{FileNode, Kit, Markdown, TextArea, Tree, TreeItem, TreeModel};

use crate::core::files::FileKind;
use crate::state::AppState;

pub fn view(s: &AppState, cx: &mut rune::Cx<AppState>) -> El {
    let k = Kit::neutral(cx.system_dark());
    if s.tickets.is_empty() {
        return empty(s, &k);
    }
    row().w_full().h_full().fill(k.c.bg_base)
        .child(strip(s, &k))
        .child(session(s, &k))
        .child(document(s, &k))
        .child(files(s, &k))
}

fn empty(s: &AppState, k: &Kit) -> El {
    let mut column = col().w_full().h_full().center().gap(10.0).fill(k.c.bg_base)
        .child(text("No tickets").font(type_::TITLE).color(k.c.text_base))
        .child(text("Set SUPPORT_TICKETS_ROOT or choose a folder with ticket subfolders.").font(type_::BODY).color(k.c.text_faint));
    if let Some(error) = &s.error {
        column = column.child(text(error).font(type_::BODY).color(k.c.danger.icon));
    }
    column
}

fn strip(s: &AppState, k: &Kit) -> El {
    let mut list = col().key("strip").w(76.0).min_h(0.0).h_full().padding(8.0).gap(4.0).fill(k.c.surface_weak);
    for (index, ticket) in s.tickets.iter().enumerate() {
        let active = index == s.active;
        let activity = s.ticket_activity(index);
        let dot = match activity {
            crate::core::agent::Activity::Running | crate::core::agent::Activity::Starting => k.c.success.icon,
            crate::core::agent::Activity::Approval => k.c.warning.icon,
            crate::core::agent::Activity::Failed => k.c.danger.icon,
            _ => k.c.text_faint,
        };
        list = list.child(
            row()
                .key(format!("strip/ticket-{index}"))
                .w_full()
                .padding(6.0)
                .gap(6.0)
                .radius(k.radius.sm)
                .fill(if active { k.c.surface_hover } else { k.c.surface_weak })
                .on_press(move |s: &mut AppState| s.select_ticket(index))
                .child(el().size(6.0, 6.0).radius(3.0).fill(dot))
                .child(text(&ticket.name).font(type_::SECTION).color(if active { k.c.text_base } else { k.c.text_faint })),
        );
    }
    list
}

fn session(s: &AppState, k: &Kit) -> El {
    let ticket = s.ticket();
    let title = ticket.map(|ticket| ticket.name.clone()).unwrap_or_default();
    let mut pane = col().key("session").w(s.session_width).min_h(0.0).h_full().padding(12.0).gap(8.0).fill(k.c.bg_base)
        .child(
            row().w_full().gap(8.0)
                .child(text(title).font(type_::TITLE).color(k.c.text_base))
                .child(text(s.activity_label()).font(type_::LABEL).color(k.c.text_faint)),
        );

    let mut transcript = col().key("session/transcript").w_full().grow(1.0).min_h(0.0).gap(10.0)
        .scroll(ScrollSpec { stick_bottom: true });
    for message in s.messages() {
        match message.role.as_str() {
            "user" => {
                transcript = transcript.child(
                    col().w_full().padding(8.0).radius(k.radius.md).fill(k.c.surface_weak)
                        .child(text(message.text).font(type_::BODY).color(k.c.text_base)),
                );
            }
            "notice" => {
                transcript = transcript.child(text(message.text).font(type_::LABEL).color(k.c.warning.icon));
            }
            _ => {
                transcript = transcript.child(Markdown::new(message.text).selectable(true).build(k));
            }
        }
    }
    for tool in s.tools() {
        transcript = transcript.child(
            row().w_full().padding(6.0).gap(6.0).radius(k.radius.sm).fill(k.c.surface_weak)
                .child(text(tool.status.replace('_', " ")).font(type_::MONO_CAPTION).color(k.c.text_faint))
                .child(text(tool.title).font(type_::LABEL).color(k.c.text_faint)),
        );
    }
    pane = pane.child(transcript);

    for approval in s.approvals() {
        let mut card = col().w_full().padding(10.0).gap(6.0).radius(k.radius.md).fill(k.c.surface_base)
            .child(text(approval.title).font(type_::LABEL).color(k.c.warning.icon));
        if !approval.detail.is_empty() {
            card = card.child(text(approval.detail).font(type_::MONO_CAPTION).color(k.c.text_faint));
        }
        let mut actions = row().gap(6.0);
        let ticket_id = ticket.map(|ticket| ticket.id.clone()).unwrap_or_default();
        for (option_id, name) in approval.options.iter() {
            let approval_id = approval.id.clone();
            let ticket_id = ticket_id.clone();
            let option_id = option_id.clone();
            actions = actions.child(
                el().padding(6.0).radius(k.radius.sm).fill(k.c.surface_raised)
                    .on_press(move |s: &mut AppState| {
                        if let Some(agent) = s.agents.get(&ticket_id) {
                            agent.handle.approve(approval_id.clone(), Some(option_id.clone()));
                        }
                    })
                    .child(text(name).font(type_::LABEL).color(k.c.text_base)),
            );
        }
        pane = pane.child(card.child(actions));
    }

    let unattached = s.unattached_sessions();
    if !unattached.is_empty() {
        let mut rows = col().w_full().gap(3.0).child(text("Previous sessions").font(type_::SECTION).color(k.c.text_faint));
        let ticket_id = ticket.map(|ticket| ticket.id.clone()).unwrap_or_default();
        for summary in unattached.into_iter().take(4) {
            let ticket_id = ticket_id.clone();
            let session_id = summary.session_id.clone();
            rows = rows.child(
                row().w_full().padding(6.0).gap(6.0).radius(k.radius.sm).fill(k.c.surface_weak)
                    .on_press(move |s: &mut AppState| {
                        if let Some(agent) = s.agents.get(&ticket_id) {
                            agent.handle.attach(session_id.clone());
                        }
                    })
                    .child(text(summary.title.unwrap_or_else(|| "Copilot session".into())).font(type_::LABEL).color(k.c.text_faint))
                    .child(text("Attach").font(type_::LABEL).color(k.c.text_base)),
            );
        }
        pane = pane.child(rows);
    }

    pane.child(
        col().w_full().gap(6.0)
            .child(
                TextArea::new(&s.composer)
                    .rows(2)
                    .placeholder("Message Copilot\u{2026}")
                    .on_edit(|s: &mut AppState| &mut s.composer)
                    .on_submit(|s: &mut AppState, _tx: &mut Tx| s.submit())
                    .build(k),
            )
            .child(
                row().w_full().gap(6.0).child(
                        el().padding(6.0).radius(k.radius.sm).fill(k.c.surface_raised)
                            .on_press(|s: &mut AppState| s.submit())
                            .child(text("Send").font(type_::LABEL).color(k.c.text_base)),
                    ),
            ),
    )
}

fn document(s: &AppState, k: &Kit) -> El {
    let path = s.document.as_ref().map(|document| document.path.clone()).unwrap_or_default();
    let mut body = col().key("document/body").w_full().grow(1.0).min_h(0.0).padding(20.0)
        .scroll(ScrollSpec { stick_bottom: false });
    match s.document_kind() {
        Some(FileKind::Markdown) => {
            body = body.child(Markdown::new(s.document_text()).selectable(true).build(k));
        }
        Some(FileKind::Text) => {
            body = body.child(text(s.document_text()).font(type_::MONO_CAPTION).color(k.c.text_faint));
        }
        Some(FileKind::Image) => {
            body = body.child(text("Image evidence \u{2014} preview lands with the image task.").font(type_::BODY).color(k.c.text_faint));
        }
        _ => {
            body = body.child(text("Select a file from the tree.").font(type_::BODY).color(k.c.text_faint));
        }
    }
    col().key("document").grow(1.0).min_h(0.0).h_full().fill(k.c.bg_base)
        .child(
            row().w_full().padding(12.0).gap(8.0).child(text(path).font(type_::LABEL).color(k.c.text_faint)),
        )
        .child(body)
}

fn files(s: &AppState, k: &Kit) -> El {
    let tree = Tree::new(tree_model, tree_model_mut, tree_label)
        .name("Ticket files")
        .row(|node, row| TreeItem::file(node, row))
        .on_open(|s: &mut AppState, id: &str, _tx: &mut Tx| s.open_file(id))
        .build(s, k)
        .grow(1.0)
        .min_h(0.0);
    col().key("tree").w(s.tree_width).min_h(0.0).h_full().padding(8.0).gap(6.0).fill(k.c.surface_weak)
        .child(text("Files").font(type_::SECTION).color(k.c.text_faint))
        .child(tree)
}

fn tree_model(s: &AppState) -> &TreeModel<FileNode<()>> {
    &s.tree
}

fn tree_model_mut(s: &mut AppState) -> &mut TreeModel<FileNode<()>> {
    &mut s.tree
}

fn tree_label(node: &FileNode<()>) -> &str {
    &node.name
}


