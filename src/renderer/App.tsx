import { useEffect, useRef, useState } from 'react';
import { LifeBuoy, Search, FolderOpen, FileText, PanelLeft, Paperclip, ChevronRight, ShieldCheck, X, ArrowLeft, CircleCheck, LoaderCircle } from 'lucide-react';
import type { Ticket, TicketFile, TicketSession, WorkspaceSnapshot } from '../shared/types';
import { Viewer } from './Viewer';
import type { EditorHandle } from './Editor';
import { Chat } from './Chat';

const label = (session?: TicketSession) => ({
  idle: 'Ready', starting: 'Connecting', running: 'Working', approval: 'Approval needed', completed: 'Completed', failed: 'Needs attention',
}[session?.activity ?? 'idle']);

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>({ root: null, tickets: [], sessions: [] });
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string>>({});
  const [ticketFiles, setTicketFiles] = useState<TicketFile[]>([]);
  const [paneOpen, setPaneOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [split, setSplit] = useState(59);
  const viewer = useRef<EditorHandle>(null);
  const ticketIdRef = useRef(ticketId);
  const fileRequest = useRef(0);
  const changing = useRef(false);
  ticketIdRef.current = ticketId;
  const ticket = workspace.tickets.find((item) => item.id === ticketId);
  const session = workspace.sessions.find((item) => item.ticketId === ticketId);
  const file = ticket ? selectedFiles[ticket.id] ?? ticket.mainFile : null;

  function applyWorkspace(value: WorkspaceSnapshot) {
    setWorkspace(value);
    setTicketId(value.tickets[0]?.id ?? null);
    setSelectedFiles({});
  }

  useEffect(() => {
    void window.workspace.snapshot().then((result) => {
      if (result.ok) applyWorkspace(result.value); else setError(result.error);
      setInitializing(false);
    });
    return window.workspace.onEvent((event) => {
      if (event.type === 'session') setWorkspace((current) => ({
        ...current, sessions: [...current.sessions.filter((item) => item.ticketId !== event.state.ticketId), event.state],
      }));
      else if (event.type === 'error') setError(event.message);
      else if (event.type === 'flush') {
        void (viewer.current?.flush() ?? Promise.resolve(true)).then((success) => window.workspace.flushed(event.requestId, success));
      }
      else if (event.ticketId === ticketIdRef.current) void refreshFiles(event.ticketId);
    });
  }, []);

  async function refreshFiles(id: string) {
    const generation = ++fileRequest.current;
    const result = await window.workspace.files(id);
    if (generation !== fileRequest.current || id !== ticketIdRef.current) return;
    if (result.ok) setTicketFiles(result.value); else setError(result.error);
  }
  useEffect(() => { if (ticketId) { setTicketFiles([]); void refreshFiles(ticketId); } }, [ticketId]);

  async function switchTicket(next: Ticket) {
    if (changing.current || next.id === ticketId) return;
    changing.current = true;
    try {
      if (viewer.current && !await viewer.current.flush()) { setError('Resolve the current file save or conflict before switching tickets.'); return; }
      setTicketId(next.id);
      setError(null);
      setPaneOpen(false);
    } finally { changing.current = false; }
  }

  async function openFile(target: string) {
    if (!ticket || changing.current || target === file) return;
    changing.current = true;
    try {
      if (viewer.current && !await viewer.current.flush()) { setError('Resolve the current file save or conflict before opening another file.'); return; }
      if (!ticket.mainFile && ticket.mainCandidates.includes(target)) {
        const main = await window.workspace.setMainFile(ticket.id, target);
        if (!main.ok) { setError(main.error); return; }
        setWorkspace(main.value);
      }
      setSelectedFiles((current) => ({ ...current, [ticket.id]: target }));
      setError(null);
    } finally { changing.current = false; }
  }

  async function openLink(target: string) {
    if (!ticket || !target || target.startsWith('#')) return;
    if (/^https?:\/\//i.test(target)) {
      const result = await window.workspace.openExternal(ticket.id, target);
      if (!result.ok) setError(result.error);
      return;
    }
    let clean: string;
    try { clean = decodeURIComponent(target.split('#')[0]).replaceAll('/', '\\'); }
    catch { setError('The attachment link contains invalid URL encoding.'); return; }
    const parent = file?.includes('\\') ? file.slice(0, file.lastIndexOf('\\') + 1) : '';
    await openFile(parent + clean);
  }

  async function chooseRoot() {
    if (viewer.current && !await viewer.current.flush()) { setError('Resolve the current file save before changing folders.'); return; }
    const result = await window.workspace.chooseRoot();
    if (!result.ok) setError(result.error);
    else if (result.value) { applyWorkspace(result.value); setError(null); }
  }

  async function send(text: string): Promise<boolean> {
    if (!ticket) return false;
    if (viewer.current && !await viewer.current.flush()) { setError('Resolve the current file save before sending a message.'); return false; }
    const result = await window.workspace.send(ticket.id, text);
    if (!result.ok) { setError(result.error); return false; }
    return true;
  }

  return <div className="app-shell">
    <aside className="ticket-sidebar">
      <div className="brand"><div className="brand-mark"><LifeBuoy size={22} /></div><div><strong>Support</strong><span>WORKSPACE</span></div></div>
      <button className="root-button" onClick={() => { void chooseRoot(); }} title={workspace.root ?? 'Choose tickets folder'}><FolderOpen size={16} /><span>{workspace.root ? workspace.root.split(/[\\/]/).at(-1) : 'Choose tickets folder'}</span><ChevronRight size={14} /></button>
      <div className="sidebar-heading"><span>TICKETS</span><span>{workspace.tickets.length}</span></div>
      <div className="search-box"><Search size={15} /><input aria-label="Search tickets" placeholder="Find a ticket..." value={search} onChange={(event) => setSearch(event.target.value)} /></div>
      <nav className="ticket-list" aria-label="Tickets">
        {workspace.tickets.filter((item) => item.name.toLowerCase().includes(search.toLowerCase())).map((item) => {
          const state = workspace.sessions.find((candidate) => candidate.ticketId === item.id);
          return <button key={item.id} className={`ticket-button ${item.id === ticketId ? 'active' : ''}`} onClick={() => { void switchTicket(item); }}>
            <div className="ticket-icon"><FileText size={17} /></div><div><strong>{item.name}</strong><span><i className={`activity-dot ${state?.activity ?? 'idle'}`} />{label(state)}</span></div>
            {state?.activity === 'approval' && <ShieldCheck size={16} className="approval-icon" />}
            {state?.activity === 'completed' && <CircleCheck size={15} className="complete-icon" />}
          </button>;
        })}
        {!workspace.tickets.length && <p className="sidebar-empty">Choose a folder containing your support tickets.</p>}
      </nav>
      <div className="sidebar-footer"><ShieldCheck size={17} /><div><strong>Local-first workspace</strong><span>Separate context per ticket</span></div></div>
    </aside>
    <main className="workspace">
      {error && <div className="global-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={16} /></button></div>}
      {initializing ? <div className="empty-state"><LoaderCircle className="spin" /><p>Opening workspace...</p></div> : !ticket ?
        <div className="empty-state welcome"><LifeBuoy size={46} /><span className="eyebrow">SUPPORT WORKSPACE</span><h1>One ticket. One context.</h1><p>Your case notes, troubleshooting evidence, and Copilot conversation. Together in a workspace built for support.</p><button className="primary-button" onClick={() => { void chooseRoot(); }}><FolderOpen size={17} /> Choose tickets folder</button></div> :
        <>
          <header className="workspace-header">
            <div><div className="breadcrumbs">Tickets <ChevronRight size={12} /><span>{ticket.name}</span></div><h1>{ticket.name}</h1></div>
            <div className="context-meta"><span className={`status-pill ${session?.activity ?? 'idle'}`}><i className={`activity-dot ${session?.activity ?? 'idle'}`} />{label(session)}</span><span className="context-pill"><ShieldCheck size={13} />Ticket context</span></div>
          </header>
          <div className="workspace-panels">
            {paneOpen && <aside className="file-pane">
              <div className="file-pane-header"><strong>Ticket files</strong><button aria-label="Hide files" onClick={() => setPaneOpen(false)}><X size={15} /></button></div>
              <button className="import-button" onClick={() => {
                void (async () => {
                  if (viewer.current && !await viewer.current.flush()) { setError('Resolve the current save before importing evidence.'); return; }
                  const result = await window.workspace.importFiles(ticket.id);
                  if (!result.ok) setError(result.error); else await refreshFiles(ticket.id);
                })();
              }}><Paperclip size={14} /> Import evidence</button>
              <div className="file-list">{ticketFiles.map((item) => <button key={item.path} className={item.path === file ? 'active' : ''} onClick={() => { void openFile(item.path); }} title={item.path}>
                <FileText size={15} /><span>{item.path}</span>{item.path === ticket.mainFile && <small>MAIN</small>}
              </button>)}</div>
              <div className="file-pane-footer">{ticketFiles.length} files · This ticket only</div>
            </aside>}
            <section className="file-panel" style={{ flexBasis: `${split}%` }}>
              <div className="panel-header"><div><button title="Toggle ticket files" aria-label="Toggle ticket files" className={paneOpen ? 'highlight' : ''} onClick={() => setPaneOpen(!paneOpen)}><PanelLeft size={17} /></button><FileText size={15} /><strong>{file ?? 'Choose a ticket summary'}</strong></div>
                {file && ticket.mainFile && file !== ticket.mainFile && <button title="Back to ticket summary" onClick={() => { void openFile(ticket.mainFile!); }}><ArrowLeft size={15} /></button>}
              </div>
              {file ? <Viewer key={`${ticket.id}:${file}`} ref={viewer} ticket={ticket} file={file} session={session} onLink={(target) => { void openLink(target); }} onError={setError} /> :
                <div className="empty-state"><FileText size={32} /><h3>Select the main ticket file</h3><p>{ticket.mainCandidates.length ? 'Multiple Markdown summaries were found. Choose the correct file.' : 'No Markdown summary was found. Use the file pane to inspect this ticket.'}</p>
                  {ticket.mainCandidates.map((candidate) => <button key={candidate} onClick={() => { void openFile(candidate); }}>{candidate}</button>)}
                  <button onClick={() => setPaneOpen(true)}>Show ticket files</button>
                </div>}
            </section>
            <div className="panel-divider" role="separator" aria-label="Resize panels" aria-orientation="vertical" tabIndex={0}
              onKeyDown={(event) => { if (event.key === 'ArrowLeft') setSplit((current) => Math.max(35, current - 3)); if (event.key === 'ArrowRight') setSplit((current) => Math.min(70, current + 3)); }}
              onPointerDown={(event) => {
                const divider = event.currentTarget;
                const parent = divider.parentElement!;
                const original = event.clientX;
                const start = split;
                divider.setPointerCapture(event.pointerId);
                const move = (movement: PointerEvent) => setSplit(Math.max(35, Math.min(70, start + (movement.clientX - original) / parent.clientWidth * 100)));
                const stop = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', stop); };
                divider.addEventListener('pointermove', move);
                divider.addEventListener('pointerup', stop, { once: true });
              }}><span /></div>
            <div className="chat-panel"><Chat key={ticket.id} ticket={ticket} session={session} send={send} onError={setError} /></div>
          </div>
          <footer className="workspace-footer"><span><ShieldCheck size={12} />Working directory: <span title={ticket.root}>{ticket.root}</span></span><span>Background agents keep their own ticket context</span></footer>
        </>}
    </main>
  </div>;
}
