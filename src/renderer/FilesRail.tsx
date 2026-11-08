import { FileText, Paperclip, X, LoaderCircle } from 'lucide-react';
import type { Ticket, TicketFile, TicketSession } from '../shared/types';
import { busySession } from './labels';

interface Props {
  ticket: Ticket;
  files: TicketFile[];
  file: string | null;
  session?: TicketSession;
  side: 'left' | 'right';
  onOpenFile: (path: string) => void;
  onImport: () => void;
  onHide: () => void;
  onSelectConversation: (id: string) => void;
}

export function FilesRail({ ticket, files, file, session, side, onOpenFile, onImport, onHide, onSelectConversation }: Props) {
  const busy = busySession(session);

  return <aside className={`files-rail ${side}`}>
    <div className="files-rail-header"><strong>FILES</strong><button aria-label="Hide files" title="Hide files" onClick={onHide}><X size={14} /></button></div>
    <button className="import-button" onClick={onImport}><Paperclip size={14} /> Import evidence</button>
    <div className="file-list">{files.map((item) => <button key={item.path} className={item.path === file ? 'active' : ''} onClick={() => onOpenFile(item.path)} title={item.path}>
      <FileText size={14} /><span>{item.path}</span>{item.path === ticket.mainFile && <small>MAIN</small>}
    </button>)}</div>
    <div className="rail-sessions">
      <div className="rail-heading">Previous sessions</div>
      {!session?.conversations.length && <p className="rail-empty">No saved conversations yet.</p>}
      {session?.conversations.map((item, index) => <button key={item.id} className={item.id === session.currentId ? 'active' : ''} disabled={busy} onClick={() => onSelectConversation(item.id)} title={new Date(item.createdAt).toLocaleString()}>
        {item.title ?? `Conversation ${index + 1}`}
        <small>{new Date(item.createdAt).toLocaleDateString()}</small>
      </button>)}
      {busy && <p className="rail-empty"><LoaderCircle size={12} className="spin" /> Stop the active turn to switch.</p>}
    </div>
    <div className="files-rail-footer">{files.length} files · This ticket only</div>
  </aside>;
}
