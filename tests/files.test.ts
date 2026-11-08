import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TicketFiles, revision } from '../src/main/files';

const managers: TicketFiles[] = [];
const sandboxes: string[] = [];

async function fixture(name = 'ticket_318', content: Record<string, string | Buffer> = { 'ticket_318.md': '# Original' }) {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'supp-ai-files-'));
  sandboxes.push(sandbox);
  const ticketsRoot = path.join(sandbox, 'tickets');
  const dataDir = path.join(sandbox, 'data');
  const root = path.join(ticketsRoot, name);
  await mkdir(root, { recursive: true });
  for (const [relative, value] of Object.entries(content)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, value);
  }
  const files = new TicketFiles(dataDir, vi.fn());
  managers.push(files);
  await files.setRoot(ticketsRoot);
  return { sandbox, ticketsRoot, dataDir, root, files, ticket: files.tickets[0] };
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((files) => files.close()));
  await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ticket discovery and canonical file access', () => {
  it('recognizes folder-named and numeric summaries without guessing an unrelated Markdown file', async () => {
    const a = await fixture();
    expect(a.ticket.mainFile).toBe('ticket_318.md');
    const b = await fixture('request-427', { '427.md': '# Main', 'notes.md': '# Notes' });
    expect(b.ticket.mainFile).toBe('427.md');
    const c = await fixture('unknown', { 'README.md': '# Readme' });
    expect(c.ticket.mainFile).toBeNull();
    const d = await fixture('ticket_44', { 'ticket_44.md': '# A', '44.md': '# B' });
    expect(d.ticket.mainFile).toBeNull();
    expect(d.ticket.mainCandidates).toHaveLength(2);
  });

  it('persists an explicit summary choice', async () => {
    const f = await fixture('unknown', { 'README.md': '# Main', 'notes.md': '# Notes' });
    await f.files.setMainFile(f.ticket.id, 'README.md');
    const restored = new TicketFiles(f.dataDir, vi.fn());
    managers.push(restored);
    await restored.setRoot(f.ticketsRoot);
    expect(restored.tickets[0].mainFile).toBe('README.md');
  });

  it('allows new nested paths but rejects traversal, absolute paths, and alternate streams', async () => {
    const f = await fixture();
    expect(await f.files.resolve(f.ticket.id, 'nested\\new.md', true)).toBe(path.join(f.root, 'nested', 'new.md'));
    for (const unsafe of ['..\\outside.txt', '../outside.txt', path.join(f.root, 'ticket_318.md'), 'folder:stream.txt']) {
      await expect(f.files.resolve(f.ticket.id, unsafe, true)).rejects.toMatchObject({ code: 'PATH' });
    }
    await expect(f.files.localAgentPath(f.ticket.id, path.join(f.sandbox, 'external.md'))).rejects.toMatchObject({ code: 'PATH' });
  });

  it('rejects an escaping junction for existing and new files', async () => {
    const f = await fixture();
    const outside = path.join(f.sandbox, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    await symlink(outside, path.join(f.root, 'junction'), 'junction');
    await expect(f.files.resolve(f.ticket.id, 'junction\\secret.txt')).rejects.toMatchObject({ code: 'PATH' });
    await expect(f.files.resolve(f.ticket.id, 'junction\\new\\file.md', true)).rejects.toMatchObject({ code: 'PATH' });
    expect((await f.files.list(f.ticket.id)).map((file) => file.path)).not.toContain('junction\\secret.txt');
  });
});

describe('previews and evidence import', () => {
  it('keeps JSONL as ordinary read-only text and returns explicit oversized/unsupported states', async () => {
    const f = await fixture('previews', {
      'main.md': '# Main', 'notes.jsonl': '{"ok":true}\n',
      'mystery.bin': Buffer.from([1, 2, 3]), 'image.png': Buffer.from([137, 80, 78, 71]),
      'large.txt': Buffer.alloc(2 * 1024 * 1024 + 1, 97),
      'large.png': Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    expect((await f.files.read(f.ticket.id, 'notes.jsonl')).kind).toBe('text');
    expect((await f.files.read(f.ticket.id, 'mystery.bin')).kind).toBe('unsupported');
    expect((await f.files.read(f.ticket.id, 'image.png')).kind).toBe('image');
    expect((await f.files.read(f.ticket.id, 'large.txt')).kind).toBe('unsupported');
    expect((await f.files.read(f.ticket.id, 'large.png')).kind).toBe('unsupported');
  });

  it('does not clobber import collisions without explicit overwrite', async () => {
    const f = await fixture('imports', { 'duplicate.txt': 'original' });
    const source = path.join(f.sandbox, 'duplicate.txt');
    await writeFile(source, 'imported');
    await expect(f.files.importFile(f.ticket.id, source, false)).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await f.files.read(f.ticket.id, 'duplicate.txt')).content).toBe('original');
    expect(await f.files.importFile(f.ticket.id, source, true)).toBe('duplicate.txt');
    expect((await f.files.read(f.ticket.id, 'duplicate.txt')).content).toBe('imported');
  });
});

describe('revision-aware editing', () => {
  it('saves exact content and preserves failed stale drafts without overwriting the disk', async () => {
    const f = await fixture();
    const original = await f.files.read(f.ticket.id, 'ticket_318.md');
    expect(original.revision).toBe(revision(Buffer.from('# Original')));
    const saved = await f.files.save(f.ticket.id, 'ticket_318.md', '# Saved', original.revision);
    expect(saved.content).toBe('# Saved');
    await expect(f.files.save(f.ticket.id, 'ticket_318.md', '# Stale draft', original.revision)).rejects.toMatchObject({ code: 'CONFLICT' });
    const recovered = await f.files.read(f.ticket.id, 'ticket_318.md');
    expect(recovered.content).toBe('# Saved');
    expect(recovered.recoveredDraft?.content).toBe('# Stale draft');
    await f.files.discardDraft(f.ticket.id, 'ticket_318.md');
    expect((await f.files.read(f.ticket.id, 'ticket_318.md')).recoveredDraft).toBeUndefined();
  });

  it('pauses editor saves under agent leases and rejects stale agent reads', async () => {
    const f = await fixture();
    const file = path.join(f.root, 'ticket_318.md');
    const original = await f.files.read(f.ticket.id, 'ticket_318.md');
    const release = await f.files.beginAgentEdit(f.ticket.id, [file], new Map([[file, original.revision]]));
    try {
      await expect(f.files.beginAgentEdit(f.ticket.id, [file], new Map())).rejects.toMatchObject({ code: 'BUSY' });
      await expect(f.files.save(f.ticket.id, 'ticket_318.md', '# Concurrent draft', original.revision)).rejects.toMatchObject({ code: 'BUSY' });
    } finally { release(); }
    expect((await f.files.read(f.ticket.id, 'ticket_318.md')).content).toBe('# Original');
    await f.files.save(f.ticket.id, 'ticket_318.md', '# Updated', original.revision);
    await expect(f.files.beginAgentEdit(f.ticket.id, [file], new Map([[file, original.revision]]))).rejects.toMatchObject({ code: 'CONFLICT' });
    const current = await f.files.read(f.ticket.id, 'ticket_318.md');
    await expect(f.files.save(f.ticket.id, 'ticket_318.md', '# Still writable', current.revision)).resolves.toMatchObject({ content: '# Still writable' });
  });
});
