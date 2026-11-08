import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { FileText, ExternalLink, LoaderCircle } from 'lucide-react';
import type { FileDocument, Ticket, TicketSession } from '../shared/types';
import { MarkdownEditor, type EditorHandle } from './Editor';

interface Props {
  ticket: Ticket;
  file: string;
  session?: TicketSession;
  onLink: (target: string) => void;
  onError: (message: string) => void;
}

export const Viewer = forwardRef<EditorHandle, Props>(function Viewer({ ticket, file, session, onLink, onError }, ref) {
  const [document, setDocument] = useState<FileDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<EditorHandle>(null);
  const request = useRef(0);
  useImperativeHandle(ref, () => ({ flush: () => editor.current?.flush() ?? Promise.resolve(true) }));

  useEffect(() => {
    let active = true;
    const load = async () => {
      const generation = ++request.current;
      const result = await window.workspace.read(ticket.id, file);
      if (!active || request.current !== generation) return;
      if (result.ok) { setDocument(result.value); setError(null); }
      else { setError(result.error); onError(result.error); }
    };
    void load();
    const unsubscribe = window.workspace.onEvent((event) => {
      if (event.type === 'files' && event.ticketId === ticket.id && event.path.replaceAll('/', '\\') === file.replaceAll('/', '\\')) void load();
    });
    return () => { active = false; unsubscribe(); };
  }, [ticket.id, file]);

  const absolute = `${ticket.root}\\${file}`.replaceAll('/', '\\').toLowerCase();
  const modifying = session?.tools.some((tool) => tool.kind === 'edit' &&
    ['pending', 'in_progress'].includes(tool.status) &&
    tool.paths.some((target) => target.replaceAll('/', '\\').toLowerCase() === absolute)) ?? false;

  if (error) return <div className="empty-state"><FileText size={34} /><h3>File unavailable</h3><p>{error}</p></div>;
  if (!document) return <div className="empty-state"><LoaderCircle className="spin" /><p>Opening evidence...</p></div>;
  if (document.kind === 'markdown') return <MarkdownEditor ref={editor} ticketId={ticket.id} document={document} modifying={modifying} onLink={onLink} onError={onError} />;
  return <div className="attachment-view">
    <div className="attachment-meta"><span>{document.kind === 'text' ? 'Read-only evidence' : 'Attachment'} · {(document.size / 1024).toFixed(1)} KiB</span>
      <button onClick={() => { void window.workspace.openExternal(ticket.id, file).then((result) => { if (!result.ok) onError(result.error); }); }}><ExternalLink size={14} /> Open externally</button>
    </div>
    {document.kind === 'text' ? <pre className="text-view">{document.content}</pre> :
      document.kind === 'image' ? <div className="image-view"><img src={document.imageUrl} alt={file} /></div> :
      <div className="empty-state"><FileText size={38} /><h3>Open with a dedicated viewer</h3><p>This format is not supported, or exceeds the preview limit (2 MiB text / 10 MiB images).</p></div>}
  </div>;
});
