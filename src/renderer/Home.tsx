import { useState } from 'react';
import { FolderOpen, Search, FileText } from 'lucide-react';
import type { Ticket, TicketSession } from '../shared/types';
import { activityLabel } from './labels';

interface Props {
  tickets: Ticket[];
  sessions: TicketSession[];
  root: string | null;
  onOpen: (id: string) => void;
  onChooseRoot: () => void;
}

export function Home({ tickets, sessions, root, onOpen, onChooseRoot }: Props) {
  const [search, setSearch] = useState('');
  const visible = tickets.filter((item) => item.name.toLowerCase().includes(search.toLowerCase()));

  return <section className="home-screen">
    <div className="home-inner">
      <h1>Home</h1>
      <p className="home-sub">{root ?? 'No tickets folder selected'} · {tickets.length} tickets</p>
      <div className="home-actions">
        <button className="root-button" onClick={onChooseRoot}><FolderOpen size={15} /><span>{root ? 'Change tickets folder' : 'Choose tickets folder'}</span></button>
      </div>
      {tickets.length > 0 && <div className="search-box"><Search size={15} /><input aria-label="Search tickets" placeholder="Find a ticket..." value={search} onChange={(event) => setSearch(event.target.value)} /></div>}
      <div className="home-list">
        {visible.map((ticket) => {
          const session = sessions.find((item) => item.ticketId === ticket.id);
          return <button key={ticket.id} className="home-ticket" onClick={() => onOpen(ticket.id)}>
            <div className="ticket-icon"><FileText size={16} /></div>
            <div className="home-ticket-name"><strong>{ticket.name}</strong><span>{ticket.mainFile ?? 'No summary selected'}</span></div>
            <small><i className={`activity-dot ${session?.activity ?? 'idle'}`} />{activityLabel(session)}</small>
          </button>;
        })}
        {!tickets.length && <p className="home-empty">Choose a folder containing your support tickets.</p>}
        {!!tickets.length && !visible.length && <p className="home-empty">No ticket matches that search.</p>}
      </div>
    </div>
  </section>;
}
