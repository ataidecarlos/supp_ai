import { mergeAttributes, type AnyExtension, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { Markdown, MarkdownManager } from '@tiptap/markdown';

export function imageSource(ticketId: string, src: string): string {
  if (!src || /^(?:[a-z][a-z0-9+.-]*:|\/\/|[\\/])/i.test(src)) return '';
  return `support-file://${ticketId}/?path=${encodeURIComponent(src.replaceAll('/', '\\'))}`;
}

export function extensions(ticketId = ''): AnyExtension[] {
  const LocalImage = Image.extend({
    renderHTML({ HTMLAttributes }) {
      return ['img', mergeAttributes(HTMLAttributes, { src: imageSource(ticketId, String(HTMLAttributes.src ?? '')) })];
    },
  });
  return [
    StarterKit.configure({ link: false }),
    Link.configure({ openOnClick: false, autolink: false }),
    LocalImage.configure({ allowBase64: false }),
    Table.configure({ resizable: false }), TableRow, TableHeader, TableCell, Markdown,
  ];
}

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }

function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => !isObject(item) || item.type !== 'space').map(semantic);
  if (!isObject(value)) return value;
  const retained: Record<string, unknown> = {};
  for (const key of ['type', 'depth', 'lang', 'ordered', 'start', 'href', 'title', 'checked', 'align', 'tokens', 'items', 'header', 'rows']) {
    if (value[key] !== undefined) retained[key] = semantic(value[key]);
  }
  if (!value.tokens && typeof value.text === 'string') retained.text = value.type === 'code' ? value.text : value.text.trim();
  return retained;
}

export function parseMarkdown(source: string): JSONContent {
  return new MarkdownManager({ extensions: extensions() }).parse(source) as JSONContent;
}

export function richMarkdownSafe(source: string): boolean {
  if (/<\/?[a-z][^>]*>/i.test(source) || /^\s*\[[^\]]+\]:/m.test(source) || /\[\^[^\]]+\]/.test(source) || /^\s*:::/m.test(source)) return false;
  const manager = new MarkdownManager({ extensions: extensions() });
  const serialized = manager.serialize(manager.parse(source));
  return JSON.stringify(semantic(manager.instance.lexer(source))) === JSON.stringify(semantic(manager.instance.lexer(serialized)));
}
