import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Square, Plus, Sparkles, ShieldCheck, Terminal, LoaderCircle, MessageSquare } from 'lucide-react';
import type { Ticket, TicketSession } from '../shared/types';

interface Props {
  ticket: Ticket;
  session?: TicketSession;
  send: (text: string) => Promise<boolean>;
  onError: (message: string) => void;
  onInsert?: (text: string) => void;
}

export function Chat({ ticket, session, send, onError, onInsert }: Props) {
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const busy = session && ['starting', 'running', 'approval'].includes(session.activity);
  useEffect(() => {
    const view = transcript.current;
    if (view && view.scrollHeight - view.scrollTop - view.clientHeight < 180) view.scrollTop = view.scrollHeight;
  }, [session?.messages.at(-1)?.text, session?.tools.length]);

  const submit = async () => {
    if (!input.trim() || busy || submitting) return;
    const text = input.trim();
    setSubmitting(true);
    setInput('');
    try { if (!await send(text)) setInput(text); }
    finally { setSubmitting(false); }
  };

  return <section className="chat-layout">
    <div className="panel-header">
      <div><Sparkles size={17} /><strong>Copilot</strong><span className="cli-label">CLI</span></div>
      <button title="New conversation" aria-label="New conversation" disabled={busy} onClick={() => {
        void window.workspace.newConversation(ticket.id).then((result) => { if (!result.ok) onError(result.error); });
      }}><Plus size={17} /></button>
    </div>
    <div className="chat-transcript" ref={transcript}>
      {!session?.messages.length && <div className="chat-welcome">
        <div className="agent-orb"><Sparkles size={23} /></div>
        <h2>Your troubleshooting partner</h2>
        <p>Work through <strong>{ticket.name}</strong> together. Copilot starts here, with this ticket's files as its workspace.</p>
        <div className="suggestions">
          {['Review the ticket and summarize what we know.', 'Identify missing diagnostics and next steps.', 'Build a troubleshooting plan grounded in the evidence.'].map((suggestion) =>
            <button key={suggestion} onClick={() => setInput(suggestion)}><MessageSquare size={14} />{suggestion}</button>)}
        </div>
      </div>}
      {session?.messages.map((message) => <article key={message.id} className={`message ${message.role}`}>
        <div className="message-label">{message.role === 'user' ? 'YOU' : message.role === 'agent' ? <><Sparkles size={12} /> COPILOT</> : 'WORKSPACE'}</div>
        <div className="message-body">{message.text}</div>
        {message.role === 'agent' && onInsert && <button className="insert-button" onClick={() => onInsert(message.text)}>Insert into editor</button>}
      </article>)}
      {!!session?.tools.length && <div className="tool-list">
        {session.tools.map((tool) => <div key={tool.id} className={`tool ${tool.status}`}>
          {['pending', 'in_progress'].includes(tool.status) ? <LoaderCircle size={14} className="spin" /> : <Terminal size={14} />}
          <span title={tool.paths.join('\n')}>{tool.title}</span><small>{tool.status.replaceAll('_', ' ')}</small>
        </div>)}
      </div>}
      {session?.error && <div className="error-inline" role="alert">{session.error}</div>}
      {session?.approvals.map((approval) => <div key={approval.id} className="approval-card">
        <div><ShieldCheck size={17} /><strong>Approval needed · {ticket.name}</strong></div>
        <h4>{approval.title}</h4>
        <pre>{approval.detail}</pre>
        <p>Permission applies only to this operation in this ticket.</p>
        <div className="approval-actions">
          {approval.options.map((option) => <button key={option.id} onClick={() => {
            void window.workspace.approve(ticket.id, approval.id, option.id).then((result) => { if (!result.ok) onError(result.error); });
          }}>{option.name}</button>)}
          <button onClick={() => { void window.workspace.approve(ticket.id, approval.id, null).then((result) => { if (!result.ok) onError(result.error); }); }}>Cancel operation</button>
        </div>
      </div>)}
      {busy && <div className="thinking"><LoaderCircle size={14} className="spin" />{session.activity === 'approval' ? 'Waiting for your approval' : session.activity === 'starting' ? 'Connecting to Copilot CLI' : 'Copilot is working'}<button onClick={() => {
        void window.workspace.stop(ticket.id).then((result) => { if (!result.ok) onError(result.error); });
      }}><Square size={11} /> Stop</button></div>}
    </div>
    <div className="chat-composer">
      <div className="composer-box">
        <textarea aria-label="Message Copilot" placeholder="Ask Copilot about this ticket..." value={input} onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} />
        <div className="composer-bottom"><span><ShieldCheck size={13} />{ticket.name}</span>
          <button className="send-button" aria-label="Send message" disabled={!input.trim() || busy || submitting} onClick={() => { void submit(); }}><ArrowUp size={18} /></button></div>
      </div>
      <p>GitHub Copilot CLI only · External access requires approval</p>
    </div>
  </section>;
}
