import { createTextDocument } from './prosemirror/document';

export function isSemanticallyEmptyText(html: string): boolean {
  const doc = createTextDocument(html);
  return doc.textContent.replace(/\u00a0/g, ' ').trim().length === 0;
}
