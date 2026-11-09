import { WorkspaceError } from './files';

export interface AppSettings {
  root: string | null;
  lastTicketId: string | null;
}

export function parseSettings(value: unknown): AppSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceError('STATE', 'Saved app settings are invalid.');
  }
  const record = value as Record<string, unknown>;
  if (!('root' in record) || (record.root !== null && typeof record.root !== 'string')) {
    throw new WorkspaceError('STATE', 'Saved ticket-root settings are invalid.');
  }
  if (record.lastTicketId !== undefined && record.lastTicketId !== null && typeof record.lastTicketId !== 'string') {
    throw new WorkspaceError('STATE', 'Saved last-ticket setting is invalid.');
  }
  return {
    root: typeof record.root === 'string' ? record.root : null,
    lastTicketId: typeof record.lastTicketId === 'string' ? record.lastTicketId : null,
  };
}
