import { describe, expect, it } from 'vitest';

import { showViewerCopyHint } from '@/lib/export/copy-hint';

const slide = { content: { type: 'slide' } };
const pbl = { content: { type: 'pbl' } };

describe('the export menu’s note on getting an editable copy', () => {
  it('is for someone viewing a course they do not own', () => {
    expect(showViewerCopyHint({ isOwner: false, workbench: true, scenes: [slide] })).toBe(true);
  });

  it('is never shown to the owner (every viewer, in single-user mode)', () => {
    expect(showViewerCopyHint({ isOwner: true, workbench: true, scenes: [slide] })).toBe(false);
  });

  it('is not offered where the classroom package is not the viewer’s to make', () => {
    // Project-based scenes package their projects through an owner-scoped call.
    expect(showViewerCopyHint({ isOwner: false, workbench: true, scenes: [slide, pbl] })).toBe(
      false,
    );
  });

  it('is not shown where the workbench is not part of the build: there is no My courses', () => {
    expect(showViewerCopyHint({ isOwner: false, workbench: false, scenes: [slide] })).toBe(false);
  });
});
