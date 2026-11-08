import { describe, expect, it } from 'vitest';
import { MarkdownManager } from '@tiptap/markdown';
import { extensions, imageSource, richMarkdownSafe } from '../src/renderer/markdown';

describe('visual Markdown fidelity', () => {
  it('configures Markdown and preserves common support-ticket constructs', () => {
    expect(extensions().some((extension) => extension.name === 'markdown')).toBe(true);
    const markdown = [
      '# Heading', '', 'A paragraph with **bold**, *emphasis*, and [a log](evidence.log).', '',
      '- first item', '- second item', '', '1. numbered one', '2. numbered two', '',
      '| Name | Value |', '| --- | --- |', '| alpha | 1 |', '',
      '```ts', 'const answer = 42;', '```',
    ].join('\n');
    expect(richMarkdownSafe(markdown)).toBe(true);
    const manager = new MarkdownManager({ extensions: extensions() });
    const serialized = manager.serialize(manager.parse(markdown));
    expect(serialized).toContain('const answer = 42;');
    expect(serialized).toContain('evidence.log');
    expect(manager.parse(serialized)).toEqual(manager.parse(markdown));
  });

  it.each([
    '<div>raw HTML</div>',
    '[guide]: ./guide.md\n\n[Open guide][guide]',
    'A sentence.[^note]\n\n[^note]: Footnote',
    '::: custom-directive\ncontent\n:::',
  ])('uses source mode for unsupported syntax: %s', (markdown) => {
    expect(richMarkdownSafe(markdown)).toBe(false);
  });
});

describe('ticket-local image rendering', () => {
  it('preserves the relative path in a ticket-scoped URL', () => {
    const source = imageSource('ticket-42', 'assets/plot image.png');
    const parsed = new URL(source);
    expect(parsed.protocol).toBe('support-file:');
    expect(parsed.hostname).toBe('ticket-42');
    expect(parsed.searchParams.get('path')).toBe('assets\\plot image.png');
  });
  it.each(['https://example.test/image.png', 'data:image/png;base64,AAAA', 'file:///C:/private/image.png', 'C:\\private\\image.png', '\\\\server\\share\\image.png', '/private/image.png'])('does not fetch external image %s', (source) => {
    expect(imageSource('ticket-42', source)).toBe('');
  });
});
