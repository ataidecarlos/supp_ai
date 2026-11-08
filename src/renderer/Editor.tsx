import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Bold, Italic, Heading2, List, ListOrdered, Code, Table2, Link2, AlertTriangle, Check, LoaderCircle } from 'lucide-react';
import type { FileDocument } from '../shared/types';
import { extensions, parseMarkdown, richMarkdownSafe } from './markdown';

export interface EditorHandle { flush(): Promise<boolean>; insert(text: string): boolean }

interface Props {
  ticketId: string;
  document: FileDocument;
  modifying: boolean;
  onLink: (target: string) => void;
  onError: (message: string) => void;
}

export const MarkdownEditor = forwardRef<EditorHandle, Props>(function MarkdownEditor({ ticketId, document, modifying, onLink, onError }, ref) {
  const initialContent = document.recoveredDraft?.content ?? document.content;
  const initialConflict = document.recoveredDraft && document.recoveredDraft.expectedRevision !== document.revision ? document : null;
  const [mode, setMode] = useState<'rich' | 'source'>(() => richMarkdownSafe(initialContent) ? 'rich' : 'source');
  const [draft, setDraft] = useState(initialContent);
  const [status, setStatus] = useState(initialConflict ? 'Conflict' : document.recoveredDraft ? 'Recovered draft' : 'Saved');
  const [conflict, setConflict] = useState<FileDocument | null>(initialConflict);
  const [problem, setProblem] = useState<string | null>(initialConflict ? 'A recovered draft differs from the disk version. Choose which version to keep.' : null);
  const [linkInput, setLinkInput] = useState<string | null>(null);
  const [safe, setSafe] = useState(() => richMarkdownSafe(initialContent));
  const content = useRef(initialContent);
  const baseline = useRef(document.content);
  const version = useRef(document.recoveredDraft?.expectedRevision ?? document.revision);
  const dirty = useRef(initialContent !== document.content);
  const active = useRef(true);
  const saving = useRef<Promise<boolean> | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modifyingRef = useRef(modifying);
  const conflictRef = useRef<FileDocument | null>(initialConflict);
  const saveRef = useRef<() => Promise<boolean>>(async () => true);
  const sourceRef = useRef<HTMLTextAreaElement>(null);

  const changed = (value: string) => {
    content.current = value;
    dirty.current = value !== baseline.current;
    setDraft(value);
    setStatus(dirty.current ? 'Unsaved' : 'Saved');
    if (timeout.current) clearTimeout(timeout.current);
    if (dirty.current) timeout.current = setTimeout(() => { void saveRef.current(); }, 600);
  };

  const editor = useEditor({
    extensions: extensions(ticketId), content: initialContent, contentType: 'markdown',
    editable: !modifying, immediatelyRender: true,
    editorProps: { attributes: { class: 'ticket-prose', role: 'textbox', 'aria-label': 'Ticket Markdown editor' } },
    onUpdate: ({ editor: current }) => changed(current.getMarkdown()),
  }, [ticketId, document.path]);

  function adopt(next: FileDocument) {
    content.current = next.content;
    baseline.current = next.content;
    version.current = next.revision;
    dirty.current = false;
    conflictRef.current = null;
    setConflict(null);
    setProblem(null);
    setDraft(next.content);
    const canUseRich = richMarkdownSafe(next.content);
    setSafe(canUseRich);
    if (!canUseRich) setMode('source');
    editor?.commands.setContent(next.content, { contentType: 'markdown', emitUpdate: false });
    setStatus('Saved');
  }

  function receive(next: FileDocument, force = false) {
    if (saving.current && !force) return;
    if (next.revision === version.current) return;
    if (dirty.current) {
      conflictRef.current = next;
      setConflict(next);
      setStatus('Conflict');
      setProblem('This file changed on disk. Both versions are preserved; auto-save is paused.');
    } else adopt(next);
  }

  saveRef.current = async () => {
    if (timeout.current) { clearTimeout(timeout.current); timeout.current = null; }
    if (saving.current) {
      const saved = await saving.current;
      return saved && (dirty.current ? saveRef.current() : true);
    }
    if (!dirty.current) return true;
    if (conflictRef.current) return false;
    const text = content.current;
    const expected = version.current;
    setStatus('Saving');
    const operation = (async () => {
      let saved = false;
      try {
      const result = await window.workspace.save(ticketId, document.path, text, expected);
      if (!active.current) return result.ok;
      if (!result.ok) {
        setStatus(result.code === 'BUSY' ? 'Paused' : result.code === 'CONFLICT' ? 'Conflict' : 'Save failed');
        setProblem(result.error);
        if (result.code === 'CONFLICT' || result.code === 'BUSY') {
          const disk = await window.workspace.read(ticketId, document.path);
          if (disk.ok && disk.value.revision !== expected) {
            conflictRef.current = disk.value;
            setConflict(disk.value);
          } else if (!disk.ok) onError(disk.error);
        }
        return false;
      }
      version.current = result.value.revision;
      baseline.current = text;
      dirty.current = content.current !== text;
      setStatus(dirty.current ? 'Unsaved' : 'Saved');
      setProblem(null);
      saved = true;
      return true;
      } catch (error) {
        if (active.current) {
          setStatus('Save failed');
          setProblem(error instanceof Error ? error.message : String(error));
          onError(error instanceof Error ? error.message : String(error));
        }
        return false;
      } finally {
        if (active.current) {
          try {
            const disk = await window.workspace.read(ticketId, document.path);
            if (disk.ok) receive(disk.value, true);
            else { setProblem(disk.error); onError(disk.error); }
          } catch (error) { onError(error instanceof Error ? error.message : String(error)); }
        }
        saving.current = null;
        if (saved && active.current && dirty.current && !conflictRef.current && !modifyingRef.current) {
          timeout.current = setTimeout(() => { void saveRef.current(); }, 600);
        }
      }
    })();
    saving.current = operation;
    return operation;
  };

  useImperativeHandle(ref, () => ({
    flush: () => saveRef.current(),
    insert: (text: string) => {
      if (modifyingRef.current || conflictRef.current) return false;
      if (mode === 'source') {
        const area = sourceRef.current;
        if (!area) return false;
        const at = area.selectionStart ?? draft.length;
        const next = `${draft.slice(0, at)}${text}${draft.slice(at)}`;
        changed(next);
        setSafe(richMarkdownSafe(next));
        return true;
      }
      if (!editor) return false;
      editor.chain().focus().insertContent(parseMarkdown(text), { updateSelection: true }).run();
      return true;
    },
  }));
  useEffect(() => { receive(document); }, [document.revision]);
  useEffect(() => {
    modifyingRef.current = modifying;
    editor?.setEditable(!modifying, false);
    if (!modifying && dirty.current && !conflictRef.current) void saveRef.current();
  }, [modifying, editor]);
  useEffect(() => () => { active.current = false; if (timeout.current) clearTimeout(timeout.current); }, []);
  useEffect(() => {
    if (document.recoveredDraft && dirty.current && !conflictRef.current) timeout.current = setTimeout(() => { void saveRef.current(); }, 600);
  }, []);

  const toolbar = [
    { title: 'Bold', icon: Bold, action: () => editor?.chain().focus().toggleBold().run() },
    { title: 'Italic', icon: Italic, action: () => editor?.chain().focus().toggleItalic().run() },
    { title: 'Heading', icon: Heading2, action: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { title: 'Bullet list', icon: List, action: () => editor?.chain().focus().toggleBulletList().run() },
    { title: 'Numbered list', icon: ListOrdered, action: () => editor?.chain().focus().toggleOrderedList().run() },
    { title: 'Code block', icon: Code, action: () => editor?.chain().focus().toggleCodeBlock().run() },
    { title: 'Insert table', icon: Table2, action: () => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { title: 'Add link', icon: Link2, action: () => setLinkInput('') },
  ];

  return <div className="editor-layout">
    <div className="editor-controls">
      <div className="segmented">
        <button className={mode === 'rich' ? 'selected' : ''} disabled={!safe} onClick={() => {
          if (!richMarkdownSafe(content.current)) { setSafe(false); return; }
          editor?.commands.setContent(content.current, { contentType: 'markdown', emitUpdate: false });
          setMode('rich');
        }}>Document</button>
        <button className={mode === 'source' ? 'selected' : ''} onClick={() => setMode('source')}>Markdown</button>
      </div>
      <span className={`save-state ${status === 'Saved' ? 'saved' : 'pending'}`} aria-live="polite">
        {status === 'Saving' ? <LoaderCircle size={13} className="spin" /> : status === 'Saved' ? <Check size={13} /> : <span className="dot" />}
        {status}
      </span>
    </div>
    {!safe && <div className="notice small">Source mode preserves syntax that cannot safely round-trip through the visual editor.</div>}
    {modifying && <div className="notice agent-banner" role="status"><LoaderCircle size={15} className="spin" /> Copilot is modifying this file. Editing is temporarily paused.</div>}
    {problem && <div className="conflict-banner" role="alert">
      <div><AlertTriangle size={16} /><span>{problem}</span></div>
      {conflict ? <>
        <div className="conflict-actions">
          <button onClick={() => {
            void window.workspace.discardDraft(ticketId, document.path).then((result) => {
              if (result.ok) adopt(conflict); else { setProblem(result.error); onError(result.error); }
            }).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
          }}>Use disk version</button>
          <button onClick={() => {
            version.current = conflict.revision;
            conflictRef.current = null;
            setConflict(null);
            setProblem(null);
            void saveRef.current();
          }}>Keep my version</button>
        </div>
        <details><summary>Compare disk version</summary><pre>{conflict.content}</pre></details>
      </> : <button disabled={modifying} onClick={() => { void saveRef.current(); }}>Retry save</button>}
    </div>}
    {mode === 'rich' && <div className="format-toolbar">
      {toolbar.map(({ title, icon: Icon, action }) => <button key={title} title={title} aria-label={title} disabled={modifying} onMouseDown={(event) => event.preventDefault()} onClick={action}><Icon size={16} /></button>)}
      <span>Markdown, made simple</span>
    </div>}
    {linkInput !== null && <form className="link-form" onSubmit={(event) => {
      event.preventDefault();
      if (/^(javascript|data|vbscript):/i.test(linkInput)) { onError('This link protocol is not allowed.'); return; }
      editor?.chain().focus().setLink({ href: linkInput }).run();
      setLinkInput(null);
    }}>
      <input aria-label="Link target" value={linkInput} onChange={(event) => setLinkInput(event.target.value)} placeholder="Relative attachment path or https://..." autoFocus required />
      <button>Add</button><button type="button" onClick={() => setLinkInput(null)}>Cancel</button>
    </form>}
    {mode === 'source' ? <textarea ref={sourceRef} className="source-editor" aria-label="Markdown source" value={draft} readOnly={modifying} spellCheck={false} onChange={(event) => {
      changed(event.target.value);
      setSafe(richMarkdownSafe(event.target.value));
    }} /> : <div className="document-scroll" onClick={(event) => {
      const anchor = (event.target as HTMLElement).closest('a');
      if (anchor) { event.preventDefault(); onLink(anchor.getAttribute('href') ?? ''); }
    }}><EditorContent editor={editor} /></div>}
    <div className="editor-footer"><span>{draft.trim() ? draft.trim().split(/\s+/).length : 0} words</span><span>Local file · Auto-save on</span></div>
  </div>;
});
