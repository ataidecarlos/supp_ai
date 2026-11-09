import { FileText, Paperclip, X, LoaderCircle, RefreshCw } from 'lucide-react';
import type { SessionSummary, Ticket, TicketFile, TicketSession } from '../shared/types';
import { busySession } from './labels';

interface Props {
  ticket: Ticket;
  files: TicketFile[];
  file: string | null;
  session?: TicketSession;
  side: 'left' | 'right';
  discovered: SessionSummary[];
  discovering: boolean;
  discoveryError: string | null;
  onOpenFile: (path: string) => void;
  onImport: () => void;
  onHide: () => void;
  onDiscover: () => void;
  onAttach: (sessionId: string) => void;
  onSelectConversation: (id: string) => void;
}

export function FilesRail({
  ticket, files, file, session, side, discovered, discovering, discoveryError,
  onOpenFile, onImport, onHide, onDiscover, onAttach, onSelectConversation,
}: Props) {
  const busy = busySession(session);
  const attached = new Set(session?.conversations.flatMap((item) => item.sessionId ? [item.sessionId] : []) ?? []);
  const unattached = discovered.filter((item) => !attached.has(item.sessionId));

  return <aside className={`files-rail ${side}`}>
    <div className="files-rail-header"><strong title={ticket.name}>{ticket.name}</strong><button aria-label="Hide files" title="Hide files" onClick={onHide}><X size={14} /></button></div>
    <button className="import-button" onClick={onImport}><Paperclip size={14} /> Import evidence</button>
    <div className="file-list">{files.map((item) => <button key={item.path} className={item.path === file ? 'active' : ''} onClick={() => onOpenFile(item.path)} title={item.path}>
      <FileText size={14} /><span>{item.path}</span>{item.path === ticket.mainFile && <small>MAIN</small>}
    </button>)}</div>
    <div className="rail-sessions">
      <div className="rail-heading">Previous sessions
        <button className="rail-refresh" aria-label="Find sessions" title="Find sessions" disabled={discovering} onClick={onDiscover}>
          {discovering ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />}
        </button>
      </div>
      {!session?.conversations.length && !unattached.length && !discovering && <p className="rail-empty">No saved conversations yet.</p>}
      {session?.conversations.map((item, index) => <button key={item.id} className={item.id === session.currentId ? 'active' : ''} disabled={busy} onClick={() => onSelectConversation(item.id)} title={new Date(item.createdAt).toLocaleString()}>
        {item.title ?? `Conversation ${index + 1}`}
        <small>{new Date(item.createdAt).toLocaleDateString()}</small>
      </button>)}
      {unattached.map((item) => <button key={item.sessionId} className="rail-unattached" disabled={busy} onClick={() => onAttach(item.sessionId)} title={item.updatedAt ? new Date(item.updatedAt).toLocaleString() : 'Previous Copilot session'}>
        <span>{item.title ?? 'Copilot session'}</span><small>Attach</small>
      </button>)}
      {discoveryError && <p className="rail-error" role="status">{discoveryError}</p>}
      {busy && <p className="rail-empty"><LoaderCircle size={12} className="spin" /> Stop the active turn to switch.</p>}
    </div>
    <div className="files-rail-footer">{files.length} files · This ticket only</div>
  </aside>;
}
