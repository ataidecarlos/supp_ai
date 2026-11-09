#[derive(Clone, Copy, PartialEq, Eq)]
pub struct TicketId(pub u64);

pub struct Ticket {
    pub id: TicketId,
    pub name: String,
}

pub struct State {
    pub tickets: Vec<Ticket>,
    pub active: TicketId,
}

impl State {
    pub fn demo() -> Self {
        let tickets = vec![
            Ticket { id: TicketId(1), name: "123001".into() },
            Ticket { id: TicketId(2), name: "123456".into() },
            Ticket { id: TicketId(3), name: "123555".into() },
        ];
        State { active: TicketId(1), tickets }
    }
}
