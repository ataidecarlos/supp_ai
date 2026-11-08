import type { TicketSession } from '../shared/types';

export const activityLabel = (session?: TicketSession): string => ({
  idle: 'Ready', starting: 'Connecting', running: 'Working', approval: 'Approval needed', completed: 'Completed', failed: 'Needs attention',
}[session?.activity ?? 'idle']);

export const busySession = (session?: Pick<TicketSession, 'activity'>): boolean =>
  Boolean(session && ['starting', 'running', 'approval'].includes(session.activity));
