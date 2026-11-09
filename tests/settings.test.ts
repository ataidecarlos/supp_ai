import { describe, expect, it } from 'vitest';
import { parseSettings } from '../src/main/settings';

describe('app settings', () => {
  it('accepts a null root written before a folder was chosen', () => {
    expect(parseSettings({ root: null, lastTicketId: null })).toEqual({ root: null, lastTicketId: null });
  });

  it('restores a saved root and ticket', () => {
    expect(parseSettings({ root: 'C:\\tickets', lastTicketId: 'abc' })).toEqual({ root: 'C:\\tickets', lastTicketId: 'abc' });
  });

  it('treats a missing last ticket as null', () => {
    expect(parseSettings({ root: 'C:\\tickets' })).toEqual({ root: 'C:\\tickets', lastTicketId: null });
  });

  it('rejects a non-string root or last ticket', () => {
    expect(() => parseSettings({ root: 5 })).toThrowError(/ticket-root/);
    expect(() => parseSettings({ root: null, lastTicketId: 5 })).toThrowError(/last-ticket/);
    expect(() => parseSettings({ lastTicketId: null })).toThrowError(/ticket-root/);
  });

  it('rejects a non-object file', () => {
    expect(() => parseSettings([])).toThrowError(/settings/);
    expect(() => parseSettings(null)).toThrowError(/settings/);
  });
});
