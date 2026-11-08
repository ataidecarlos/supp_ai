export type Activity = 'idle' | 'starting' | 'running' | 'approval' | 'completed' | 'failed';

export interface Ticket {
  id: string;
  name: string;
  root: string;
  mainFile: string | null;
  mainCandidates: string[];
}

export interface TicketFile {
  path: string;
  size: number;
}

export interface FileDocument {
  path: string;
  kind: 'markdown' | 'text' | 'image' | 'unsupported';
  content: string;
  revision: string;
  size: number;
  imageUrl?: string;
  recoveredDraft?: { content: string; expectedRevision: string };
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'notice';
  text: string;
}

export interface ToolActivity {
  id: string;
  title: string;
  kind: string;
  status: string;
  paths: string[];
}

export interface Approval {
  id: string;
  title: string;
  detail: string;
  paths: string[];
  options: { id: string; name: string }[];
}

export interface Conversation {
  id: string;
  createdAt: string;
  sessionId?: string;
  messages: ChatMessage[];
}

export interface TicketSession {
  ticketId: string;
  activity: Activity;
  conversations: Conversation[];
  currentId: string | null;
  messages: ChatMessage[];
  tools: ToolActivity[];
  approvals: Approval[];
  error: string | null;
}

export interface WorkspaceSnapshot {
  root: string | null;
  tickets: Ticket[];
  sessions: TicketSession[];
}

export type WorkspaceEvent =
  | { type: 'session'; state: TicketSession }
  | { type: 'files'; ticketId: string; path: string }
  | { type: 'flush'; requestId: string }
  | { type: 'error'; message: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: string; code: string };

export interface WorkspaceApi {
  snapshot(): Promise<Result<WorkspaceSnapshot>>;
  chooseRoot(): Promise<Result<WorkspaceSnapshot | null>>;
  setMainFile(ticketId: string, path: string): Promise<Result<WorkspaceSnapshot>>;
  files(ticketId: string): Promise<Result<TicketFile[]>>;
  read(ticketId: string, path: string): Promise<Result<FileDocument>>;
  save(ticketId: string, path: string, content: string, revision: string): Promise<Result<FileDocument>>;
  discardDraft(ticketId: string, path: string): Promise<Result<void>>;
  importFiles(ticketId: string): Promise<Result<string[]>>;
  openExternal(ticketId: string, target: string): Promise<Result<void>>;
  send(ticketId: string, text: string): Promise<Result<void>>;
  stop(ticketId: string): Promise<Result<void>>;
  newConversation(ticketId: string): Promise<Result<void>>;
  selectConversation(ticketId: string, conversationId: string): Promise<Result<void>>;
  approve(ticketId: string, approvalId: string, optionId: string | null): Promise<Result<void>>;
  flushed(requestId: string, success: boolean): Promise<Result<void>>;
  onEvent(callback: (event: WorkspaceEvent) => void): () => void;
}

declare global {
  interface Window { workspace: WorkspaceApi }
}
