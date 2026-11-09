import { useEffect, useRef, useState } from 'react';
import {
  LifeBuoy, FolderOpen, FileText, Paperclip, ChevronDown, ChevronRight, ShieldCheck, X, ArrowLeft,
  CircleCheck, LoaderCircle, Menu,
} from 'lucide-react';
import type { Config, SessionSummary, TicketFile, TicketSession, WorkspaceSnapshot } from '../shared/types';
import { DEFAULT_CONFIG } from '../shared/config';
import { Viewer, isAgentEditing } from './Viewer';
import type { EditorHandle } from './Editor';
import { Chat } from './Chat';
import { Home } from './Home';
import { FilesRail } from './FilesRail';
import { activityLabel, busySession } from './labels';

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>({
    root: null, tickets: [], sessions: [], config: { ...DEFAULT_CONFIG }, configError: null, lastTicketId: null,
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openTickets, setOpenTickets] = useState<string[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<Record<string, string>>({});
  const [ticketFiles, setTicketFiles] = useState<TicketFile[]>([]);
  const [menu, setMenu] = useState<'tickets' | 'layout' | null>(null);
  const [discovered, setDiscovered] = useState<Record<string, SessionSummary[]>>({});
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [discoveryError, setDiscoveryError] = useState<Record<string, string | null>>({});
  const attempted = useRef(new Set<string>());
  const sessionsRef = useRef(workspace.sessions);
  sessionsRef.current = workspace.sessions;
  const [error, setError] = useState<string | null>(null);
  const [configDismissed, setConfigDismissed] = useState(false);
  const [initializing, setInitializing] = useState(true);
  const [split, setSplit] = useState(59);
  const viewer = useRef<EditorHandle>(null);
  const activeIdRef = useRef(activeId);
  const fileRequest = useRef(0);
  const changing = useRef(false);
  activeIdRef.current = activeId;

  const ticket = workspace.tickets.find((item) => item.id === activeId);
  const session = workspace.sessions.find((item) => item.ticketId === activeId);
  const file = ticket ? selectedFiles[ticket.id] ?? ticket.mainFile : null;
  const config = workspace.config;

  function applyWorkspace(value: WorkspaceSnapshot) {
    setWorkspace(value);
    const restored = value.lastTicketId && value.tickets.some((item) => item.id === value.lastTicketId) ? value.lastTicketId : null;
    setActiveId(restored);
    setOpenTickets(restored ? [restored] : []);
    setSelectedFiles({});
    attempted.current.clear();
    setDiscovered({});
    setDiscoveryError({});
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
      else if (event.ticketId === activeIdRef.current) void refreshFiles(event.ticketId);
    });
  }, []);

  async function refreshFiles(id: string) {
    const generation = ++fileRequest.current;
    const result = await window.workspace.files(id);
    if (generation !== fileRequest.current || id !== activeIdRef.current) return;
    if (result.ok) setTicketFiles(result.value); else setError(result.error);
  }
  useEffect(() => { if (activeId) { setTicketFiles([]); void refreshFiles(activeId); } }, [activeId]);

  const guard = async (): Promise<boolean> => !viewer.current || await viewer.current.flush();

  async function findSessions(id: string, auto: boolean): Promise<void> {
    setDiscovering(id);
    setDiscoveryError((current) => ({ ...current, [id]: null }));
    const result = await window.workspace.discover(id);
    setDiscovering(null);
    if (!result.ok) {
      setDiscoveryError((current) => ({ ...current, [id]: result.error }));
      return;
    }
    setDiscovered((current) => ({ ...current, [id]: result.value }));
    if (!auto || !result.value.length) return;
    const latest = sessionsRef.current.find((item) => item.ticketId === id);
    if (!latest || latest.conversations.length) return;
    if (latest.conversations.some((item) => item.sessionId === result.value[0].sessionId)) return;
    const attach = await window.workspace.attach(id, result.value[0].sessionId);
    if (!attach.ok) setDiscoveryError((current) => ({ ...current, [id]: attach.error }));
  }

  useEffect(() => {
    if (!ticket || attempted.current.has(ticket.id) || session?.conversations.length) return;
    attempted.current.add(ticket.id);
    void findSessions(ticket.id, true);
  }, [activeId, session?.conversations.length]);

  async function attachSession(id: string, sessionId: string): Promise<void> {
    const result = await window.workspace.attach(id, sessionId);
    if (!result.ok) { setDiscoveryError((current) => ({ ...current, [id]: result.error })); return; }
    setDiscoveryError((current) => ({ ...current, [id]: null }));
    await refreshFiles(id);
  }

  async function setLayout(patch: Partial<Config>) {
    const result = await window.workspace.setConfig(patch);
    if (!result.ok) { setError(result.error); return; }
    setWorkspace((current) => ({ ...current, config: result.value, configError: null }));
  }

  async function openTicket(id: string) {
    if (changing.current || (id === activeId && openTickets.includes(id))) return;
    changing.current = true;
    try {
      if (!await guard()) { setError('Resolve the current file save or conflict before switching tickets.'); return; }
      setOpenTickets((current) => current.includes(id) ? current : [...current, id]);
      setActiveId(id);
      setMenu(null);
      setError(null);
      void window.workspace.setLastTicket(id);
    } finally { changing.current = false; }
  }

  async function closeTicket(id: string) {
    if (changing.current) return;
    changing.current = true;
    try {
      const state = workspace.sessions.find((item) => item.ticketId === id);
      if (state && ['starting', 'running', 'approval'].includes(state.activity)) {
        setError('Stop the active turn before closing this ticket.');
        return;
      }
      if (!await guard()) { setError('Resolve the current file save or conflict before closing this ticket.'); return; }
      const index = openTickets.indexOf(id);
      const next = openTickets.filter((item) => item !== id);
      setOpenTickets(next);
      if (id === activeId) {
        const candidate = next[index] ?? next[index - 1] ?? null;
        setActiveId(candidate);
        void window.workspace.setLastTicket(candidate);
      }
    } finally { changing.current = false; }
  }

  async function goHome() {
    if (changing.current) return;
    changing.current = true;
    try {
      if (!await guard()) { setError('Resolve the current file save or conflict before leaving this ticket.'); return; }
      setActiveId(null);
      setMenu(null);
      void window.workspace.setLastTicket(null);
    } finally { changing.current = false; }
  }

  async function openFile(target: string) {
    if (!ticket || changing.current || target === file) return;
    changing.current = true;
    try {
      if (!await guard()) { setError('Resolve the current file save or conflict before opening another file.'); return; }
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
    if (!await guard()) { setError('Resolve the current file save before changing folders.'); return; }
    const result = await window.workspace.chooseRoot();
    if (!result.ok) setError(result.error);
    else if (result.value) { applyWorkspace(result.value); setError(null); setConfigDismissed(false); }
  }

  async function send(text: string): Promise<boolean> {
    if (!ticket) return false;
    if (!await guard()) { setError('Resolve the current file save before sending a message.'); return false; }
    const result = await window.workspace.send(ticket.id, text);
    if (!result.ok) { setError(result.error); return false; }
    return true;
  }

  const stateFor = (id: string) => workspace.sessions.find((item) => item.ticketId === id);

  const ticketMenu = menu === 'tickets' ? <>
    <div className="menu-scrim" onClick={() => setMenu(null)} />
    <div className="menu" role="menu" aria-label="Tickets">
      <button role="menuitem" className={activeId === null ? 'active' : ''} onClick={() => { setMenu(null); void goHome(); }}>
        <FolderOpen size={14} /><span>Home</span>
      </button>
      {workspace.tickets.map((item) => {
        const state = stateFor(item.id);
        return <button key={item.id} role="menuitem" className={item.id === activeId ? 'active' : ''} onClick={() => { setMenu(null); void openTicket(item.id); }}>
          <i className={`activity-dot ${state?.activity ?? 'idle'}`} /><span>{item.name}</span><small>{activityLabel(state)}</small>
        </button>;
      })}
    </div>
  </> : null;

  const layoutMenu = menu === 'layout' ? <>
    <div className="menu-scrim" onClick={() => setMenu(null)} />
    <div className="menu layout-menu" role="menu" aria-label="Layout">
      <button role="menuitem" onClick={() => { setMenu(null); void setLayout({ filesHidden: !config.filesHidden }); }}>{config.filesHidden ? 'Show files' : 'Hide files'}</button>
      <button role="menuitem" onClick={() => { setMenu(null); void setLayout({ chatSide: config.chatSide === 'left' ? 'right' : 'left' }); }}>Chat on the {config.chatSide === 'left' ? 'right' : 'left'}</button>
      <button role="menuitem" onClick={() => { setMenu(null); void setLayout({ filesSide: config.filesSide === 'left' ? 'right' : 'left' }); }}>Files on the {config.filesSide === 'left' ? 'right' : 'left'}</button>
    </div>
  </> : null;

  const rail = ticket ? <FilesRail key="files" ticket={ticket} files={ticketFiles} file={file} session={session} side={config.filesSide}
    discovered={discovered[ticket.id] ?? []}
    discovering={discovering === ticket.id}
    discoveryError={discoveryError[ticket.id] ?? null}
    onDiscover={() => { void findSessions(ticket.id, false); }}
    onAttach={(id) => { void attachSession(ticket.id, id); }}
    onOpenFile={(path) => { void openFile(path); }}
    onImport={() => { void (async () => {
      if (!await guard()) { setError('Resolve the current save before importing evidence.'); return; }
      const result = await window.workspace.importFiles(ticket.id);
      if (!result.ok) setError(result.error); else await refreshFiles(ticket.id);
    })(); }}
    onHide={() => { void setLayout({ filesHidden: true }); }}
    onSelectConversation={(id) => { void window.workspace.selectConversation(ticket.id, id).then((result) => { if (!result.ok) setError(result.error); }); }} /> : null;

  const chat = ticket ? <div className="chat-panel" key="chat"><Chat key={ticket.id} ticket={ticket} session={session} send={send} onError={setError}
    onInsert={ticket && file && /\.(md|markdown)$/i.test(file) && !isAgentEditing(session, ticket.root, file) ? (text) => {
      if (!viewer.current?.insert(text)) setError('Resolve the current save or conflict before inserting.');
    } : undefined} /></div> : null;

  const documentPanel = ticket ? <section className="workspace-panel" key="document" style={{ flexBasis: `${split}%` }}>
    <div className="panel-header"><div><FileText size={15} /><strong>{file ?? 'Choose a ticket summary'}</strong></div>
      {file && ticket.mainFile && file !== ticket.mainFile && <button title="Back to ticket summary" aria-label="Back to ticket summary" onClick={() => { void openFile(ticket.mainFile!); }}><ArrowLeft size={15} /></button>}
    </div>
    {file ? <Viewer key={`${ticket.id}:${file}`} ref={viewer} ticket={ticket} file={file} session={session} onLink={(target) => { void openLink(target); }} onError={setError} /> :
      <div className="empty-state"><FileText size={32} /><h3>Select the main ticket file</h3><p>{ticket.mainCandidates.length ? 'Multiple Markdown summaries were found. Choose the correct file.' : 'No Markdown summary was found. Open the files rail to inspect this ticket.'}</p>
        {ticket.mainCandidates.map((candidate) => <button key={candidate} onClick={() => { void openFile(candidate); }}>{candidate}</button>)}
        <button onClick={() => { void setLayout({ filesHidden: false }); }}>Show ticket files</button>
      </div>}
  </section> : null;

  const divider = <div className="panel-divider" key="divider" role="separator" aria-label="Resize panels" aria-orientation="vertical" tabIndex={0}
    onKeyDown={(event) => { if (event.key === 'ArrowLeft') setSplit((current) => Math.max(35, current - 3)); if (event.key === 'ArrowRight') setSplit((current) => Math.min(70, current + 3)); }}
    onPointerDown={(event) => {
      const handle = event.currentTarget;
      const parent = handle.parentElement!;
      const original = event.clientX;
      const start = split;
      handle.setPointerCapture(event.pointerId);
      const move = (movement: PointerEvent) => setSplit(Math.max(35, Math.min(70, start + (movement.clientX - original) / parent.clientWidth * 100)));
      const stop = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', stop); };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', stop, { once: true });
    }}><span /></div>;

  const panes = ticket ? [
    ...(!config.filesHidden && config.filesSide === 'left' ? [rail] : []),
    ...(config.chatSide === 'left' ? [chat, divider, documentPanel] : [documentPanel, divider, chat]),
    ...(!config.filesHidden && config.filesSide === 'right' ? [rail] : []),
  ] : [];

  return <div className="app-shell">
    <header className="app-header" onKeyDown={(event) => { if (event.key === 'Escape') setMenu(null); }}>
      <div className="brand"><div className="brand-mark"><LifeBuoy size={18} /></div><strong>Support</strong></div>
      <div className="picker-wrap">
        <button className="ticket-picker" aria-label="Ticket menu" aria-expanded={menu === 'tickets'} onClick={() => setMenu(menu === 'tickets' ? null : 'tickets')}>
          <FileText size={14} /><span>{ticket?.name ?? 'Home'}</span><ChevronDown size={13} />
        </button>
        {ticketMenu}
      </div>
      <div className="ticket-tabs" role="tablist" aria-label="Open tickets">
        {openTickets.map((id) => {
          const item = workspace.tickets.find((candidate) => candidate.id === id);
          const state = stateFor(id);
          return <div key={id} className={`tab ${id === activeId ? 'active' : ''}`}>
            <button role="tab" aria-selected={id === activeId} onClick={() => { void openTicket(id); }}>
              <i className={`activity-dot ${state?.activity ?? 'idle'}`} />{item?.name ?? 'Ticket'}
            </button>
            {state?.activity === 'approval' && <ShieldCheck size={13} className="approval-icon" aria-label="Approval needed" />}
            {state?.activity === 'completed' && <CircleCheck size={13} className="complete-icon" />}
            <button className="tab-close" aria-label={`Close ${item?.name ?? 'ticket'}`} onClick={() => { void closeTicket(id); }}><X size={12} /></button>
          </div>;
        })}
      </div>
      {ticket && <div className="layout-wrap">
        <button aria-label="Layout menu" aria-expanded={menu === 'layout'} onClick={() => setMenu(menu === 'layout' ? null : 'layout')}><Menu size={18} /></button>
        {layoutMenu}
      </div>}
    </header>
    <div className="app-body">
      {error && <div className="global-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={16} /></button></div>}
      {workspace.configError && !configDismissed && <div className="global-error" role="alert"><span>{workspace.configError}</span><button aria-label="Dismiss configuration warning" onClick={() => setConfigDismissed(true)}><X size={16} /></button></div>}
      {initializing ? <div className="empty-state"><LoaderCircle className="spin" /><p>Opening workspace...</p></div> :
        !workspace.root ? <div className="empty-state welcome"><LifeBuoy size={46} /><span className="eyebrow">SUPPORT WORKSPACE</span><h1>One ticket. One context.</h1><p>Your case notes, troubleshooting evidence, and Copilot conversation. Together in a workspace built for support.</p><button className="primary-button" onClick={() => { void chooseRoot(); }}><FolderOpen size={17} /> Choose tickets folder</button></div> :
          activeId === null || !ticket ?
            <Home tickets={workspace.tickets} sessions={workspace.sessions} root={workspace.root} onOpen={(id) => { void openTicket(id); }} onChooseRoot={() => { void chooseRoot(); }} /> :
            <div className="workspace-body">{panes}</div>}
    </div>
    <footer className="workspace-footer">
      <span><ShieldCheck size={12} />Working directory: <span title={ticket?.root ?? workspace.root ?? ''}>{ticket?.root ?? workspace.root ?? 'None'}</span></span>
      <span>{busySession(session) ? 'Copilot is working in the background' : 'Background agents keep their own ticket context'}</span>
    </footer>
  </div>;
}
